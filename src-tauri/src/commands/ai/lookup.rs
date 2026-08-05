//! The reader's own lookup history — `word_memory_hint`, and the memory block
//! appended to the learning-card prompt.

use tauri::State;

use super::prompt::truncate_utf8;
use crate::db::Db;
use crate::error::AppResult;

/// A previous definition is a whole card's worth of text; only its opening
/// needs to travel into the next request for the model to tell "same sense"
/// from "different sense".
const LOOKUP_MEMORY_DEFINITION_BYTES: usize = 200;

/// What the user's own record says about this word.
///
/// One fetch behind two consumers — the learning card prompt and the card's
/// provenance marker — so the line the reader is shown can never claim
/// something the model was not told.
pub(crate) struct LookupMemory {
    looked_up_times: Option<i64>,
    days_since_last_lookup: Option<i64>,
    previous_definition: Option<String>,
    mastery: Option<String>,
    reviews: Option<i64>,
    /// The book whose saved row won the mastery ordering below. For the UI
    /// only: the prompt tells the model to state neither counts nor dates, and
    /// handing it a book title invites both.
    mastery_book_title: Option<String>,
}

impl LookupMemory {
    /// The prompt-facing projection: the subset of the record the model is
    /// told about, kept separate from the fields the UI alone may read.
    fn record_json(&self) -> String {
        let mut record = serde_json::Map::new();
        if let Some(times) = self.looked_up_times {
            record.insert("looked_up_times".to_string(), times.into());
        }
        if let Some(days) = self.days_since_last_lookup {
            record.insert("days_since_last_lookup".to_string(), days.into());
        }
        if let Some(definition) = self.previous_definition.as_deref() {
            record.insert("previous_definition".to_string(), definition.into());
        }
        if let Some(mastery) = self.mastery.as_deref() {
            record.insert("mastery".to_string(), mastery.into());
        }
        if let Some(reviews) = self.reviews {
            record.insert("reviews".to_string(), reviews.into());
        }
        serde_json::to_string(&serde_json::Value::Object(record))
            .expect("serializable lookup record")
    }
}

/// The user's record for a word, or `None` when they have never looked it up
/// and never saved it.
///
/// Deliberately cross-book. The lookup commands never receive a book id, and
/// asking for one would be wrong anyway: mastery is a property of the reader,
/// not of the book they happened to meet the word in.
pub(crate) fn lookup_memory(
    conn: &rusqlite::Connection,
    word: &str,
    now_ms: i64,
) -> Option<LookupMemory> {
    let normalized = crate::sync::events::normalize_learning_term(word);
    if normalized.is_empty() {
        return None;
    }

    // One word looked up at five places is five rows: the unique key is
    // (book_id, cfi, normalized_text). Summing across them is the only way to
    // see "the fifth time"; a single row's `lookup_count` counts one position.
    let history: Option<(i64, i64, Option<String>)> = conn
        .query_row(
            "SELECT SUM(lookup_count),
                    MAX(last_looked_up_at),
                    (SELECT definition FROM lookup_records
                      WHERE normalized_text = ?1 AND definition <> ''
                      ORDER BY last_looked_up_at DESC LIMIT 1)
             FROM lookup_records
             WHERE normalized_text = ?1",
            rusqlite::params![normalized],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()
        .and_then(
            |(times, last, definition): (Option<i64>, Option<i64>, Option<String>)| {
                Some((times?, last?, definition))
            },
        );

    // A word saved in two books can carry two different states — marked
    // mastered in one, auto-added as `new` by a lookup in the other. The
    // furthest-along row wins: the reader already proved they know it.
    let vocabulary: Option<(String, i64, Option<String>)> = conn
        .query_row(
            "SELECT v.mastery, v.review_count, b.title
             FROM vocab_words v
             LEFT JOIN books b ON b.id = v.book_id
             WHERE v.word = ?1 COLLATE NOCASE
             ORDER BY CASE v.mastery WHEN 'mastered' THEN 0 WHEN 'learning' THEN 1 ELSE 2 END,
                      v.updated_at DESC
             LIMIT 1",
            rusqlite::params![normalized],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();

    if history.is_none() && vocabulary.is_none() {
        return None;
    }

    let mut memory = LookupMemory {
        looked_up_times: None,
        days_since_last_lookup: None,
        previous_definition: None,
        mastery: None,
        reviews: None,
        mastery_book_title: None,
    };
    if let Some((times, last_looked_up_at, definition)) = history {
        memory.looked_up_times = Some(times);
        memory.days_since_last_lookup =
            Some((now_ms.saturating_sub(last_looked_up_at) / 86_400_000).max(0));
        memory.previous_definition = definition
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|definition| {
                truncate_utf8(definition, LOOKUP_MEMORY_DEFINITION_BYTES).to_string()
            });
    }
    if let Some((mastery, reviews, book_title)) = vocabulary {
        memory.mastery = Some(mastery);
        memory.reviews = Some(reviews);
        memory.mastery_book_title = book_title;
    }
    Some(memory)
}

/// The structured learning card's block.
///
/// The card's shape is fixed by the user's module configuration, so a repeat
/// encounter cannot simply produce a shorter answer — it has to fill the
/// requested modules with what is new.
pub(crate) fn learning_card_memory_block(
    conn: &rusqlite::Connection,
    word: &str,
    now_ms: i64,
) -> Option<String> {
    Some(format!(
        "The following is the user's own record for this word in Lantern:\n{}\n\nThis is a repeat encounter, not a first one. Fill the requested modules with what this encounter adds:\n- When `previous_definition` is present, do not re-state what it already covered. If this passage carries that same sense, keep those modules brief and spend the space on what is new here.\n- When it is present and this passage carries a different sense, make the contrast against it explicit in the sense-bearing modules.\n- If `mastery` is \"mastered\", treat the word as known: skip the beginner gloss even when the configured CEFR level would call for simpler language. The recorded state beats the level estimate.\n- Never state counts or dates, never acknowledge the repeat, and never praise the user for reviewing. Never add a module that was not requested.",
        lookup_memory(conn, word, now_ms)?.record_json(),
    ))
}

/// What the reader is shown about their own record for a word, next to the
/// answer that record shaped. Without it the personalisation is invisible: the
/// card simply gets shorter and the reader reads that as the model slacking.
#[derive(Debug, serde::Serialize)]
pub struct WordMemoryHint {
    pub looked_up_times: i64,
    pub mastery: Option<String>,
    pub reviews: i64,
    pub mastery_book_title: Option<String>,
}

#[tauri::command]
pub fn word_memory_hint(word: String, db: State<'_, Db>) -> AppResult<Option<WordMemoryHint>> {
    let conn = db.reader();
    Ok(
        lookup_memory(&conn, &word, chrono::Utc::now().timestamp_millis()).map(|memory| {
            WordMemoryHint {
                looked_up_times: memory.looked_up_times.unwrap_or(0),
                mastery: memory.mastery,
                reviews: memory.reviews.unwrap_or(0),
                mastery_book_title: memory.mastery_book_title,
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: i64 = 86_400_000;
    const NOW_MS: i64 = 1_800_000_000_000;

    fn library_with_books(ids: &[&str]) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        Db::run_migrations_on(&conn).unwrap();
        for id in ids {
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress, created_at, updated_at)
                 VALUES (?1, 'Book', 'Author', 'books/b.epub', 'epub', 'reading', 0, 1000, 1000)",
                rusqlite::params![id],
            )
            .unwrap();
        }
        conn
    }

    /// One lookup row. The id is derived from its position because the table's
    /// own unique key is (book_id, cfi, normalized_text) — a separate id
    /// argument would carry no information these tests care about.
    fn record_lookup(
        conn: &rusqlite::Connection,
        book_id: &str,
        cfi: &str,
        word: &str,
        definition: &str,
        looked_up_at: i64,
        count: i64,
    ) {
        conn.execute(
            "INSERT INTO lookup_records
             (id, book_id, lookup_text, normalized_text, cfi, definition,
              created_at, last_looked_up_at, lookup_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
            rusqlite::params![
                format!("{book_id}:{cfi}"),
                book_id,
                word,
                crate::sync::events::normalize_learning_term(word),
                cfi,
                definition,
                looked_up_at,
                count,
            ],
        )
        .unwrap();
    }

    fn save_word(conn: &rusqlite::Connection, id: &str, book_id: &str, word: &str, mastery: &str) {
        conn.execute(
            "INSERT INTO vocab_words
             (id, book_id, word, definition, mastery, review_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'saved definition', ?4, 3, 1000, 1000)",
            rusqlite::params![id, book_id, word, mastery],
        )
        .unwrap();
    }

    #[test]
    fn lookup_memory_reports_history_alone() {
        let conn = library_with_books(&["b1"]);
        record_lookup(
            &conn,
            "b1",
            "epubcfi(/6/4!/2)",
            "resign",
            "to give up a position",
            NOW_MS - 12 * DAY_MS,
            1,
        );

        let block = learning_card_memory_block(&conn, "resign", NOW_MS).unwrap();
        assert!(block.contains("\"looked_up_times\":1"), "{block}");
        assert!(block.contains("\"days_since_last_lookup\":12"), "{block}");
        assert!(block.contains("to give up a position"), "{block}");
        assert!(!block.contains("\"mastery\""), "{block}");
    }

    #[test]
    fn lookup_memory_reports_a_saved_word_never_looked_up() {
        let conn = library_with_books(&["b1"]);
        save_word(&conn, "v1", "b1", "resign", "learning");

        let block = learning_card_memory_block(&conn, "resign", NOW_MS).unwrap();
        assert!(block.contains("\"mastery\":\"learning\""), "{block}");
        assert!(block.contains("\"reviews\":3"), "{block}");
        assert!(!block.contains("\"looked_up_times\""), "{block}");
    }

    // The unique key is (book_id, cfi, normalized_text), so the fifth lookup of
    // a word lives in five rows. Reading one row's count would report "1".
    #[test]
    fn lookup_memory_sums_the_same_word_across_positions() {
        let conn = library_with_books(&["b1", "b2"]);
        record_lookup(&conn, "b1", "cfi/1", "resign", "", NOW_MS - 9 * DAY_MS, 2);
        record_lookup(&conn, "b1", "cfi/2", "Resign,", "", NOW_MS - 5 * DAY_MS, 1);
        record_lookup(&conn, "b2", "cfi/1", "resign", "", NOW_MS - DAY_MS, 1);

        let block = learning_card_memory_block(&conn, "resign", NOW_MS).unwrap();
        assert!(block.contains("\"looked_up_times\":4"), "{block}");
        assert!(block.contains("\"days_since_last_lookup\":1"), "{block}");
    }

    #[test]
    fn lookup_memory_quotes_the_most_recent_non_empty_definition() {
        let conn = library_with_books(&["b1"]);
        record_lookup(
            &conn,
            "b1",
            "cfi/1",
            "resign",
            "older sense",
            NOW_MS - 9 * DAY_MS,
            1,
        );
        record_lookup(
            &conn,
            "b1",
            "cfi/2",
            "resign",
            "newer sense",
            NOW_MS - 2 * DAY_MS,
            1,
        );
        record_lookup(&conn, "b1", "cfi/3", "resign", "", NOW_MS - DAY_MS, 1);

        let block = learning_card_memory_block(&conn, "resign", NOW_MS).unwrap();
        assert!(block.contains("newer sense"), "{block}");
        assert!(!block.contains("older sense"), "{block}");
    }

    // Marked mastered in one book, auto-added as `new` by a lookup in another.
    // The reader already proved they know the word.
    #[test]
    fn lookup_memory_takes_the_furthest_along_mastery() {
        let conn = library_with_books(&["b1", "b2"]);
        save_word(&conn, "v1", "b1", "resign", "new");
        save_word(&conn, "v2", "b2", "resign", "mastered");

        let block = learning_card_memory_block(&conn, "resign", NOW_MS).unwrap();
        assert!(block.contains("\"mastery\":\"mastered\""), "{block}");
    }

    // The card's marker names a book, so the mastery row and the title shown
    // beside it have to come from the same row — not from whichever book the
    // reader happens to be holding.
    #[test]
    fn lookup_memory_names_the_book_the_mastery_came_from() {
        let conn = library_with_books(&["b1", "b2"]);
        conn.execute("UPDATE books SET title = 'Dubliners' WHERE id = 'b2'", [])
            .unwrap();
        save_word(&conn, "v1", "b1", "resign", "new");
        save_word(&conn, "v2", "b2", "resign", "mastered");

        let memory = lookup_memory(&conn, "resign", NOW_MS).unwrap();
        assert_eq!(memory.mastery.as_deref(), Some("mastered"));
        assert_eq!(memory.mastery_book_title.as_deref(), Some("Dubliners"));
    }

    // The title is the one fact the prompt must not receive: the block forbids
    // stating counts and dates, and a book title is an invitation to do both.
    #[test]
    fn the_prompt_block_does_not_leak_the_book_title() {
        let conn = library_with_books(&["b1"]);
        conn.execute("UPDATE books SET title = 'Dubliners' WHERE id = 'b1'", [])
            .unwrap();
        save_word(&conn, "v1", "b1", "resign", "mastered");

        let card = learning_card_memory_block(&conn, "resign", NOW_MS).unwrap();
        assert!(!card.contains("Dubliners"), "{card}");
    }

    #[test]
    fn the_card_block_carries_the_whole_record() {
        let conn = library_with_books(&["b1"]);
        record_lookup(
            &conn,
            "b1",
            "cfi/1",
            "resign",
            "to give up",
            NOW_MS - DAY_MS,
            2,
        );
        save_word(&conn, "v1", "b1", "resign", "mastered");

        let card = learning_card_memory_block(&conn, "resign", NOW_MS).unwrap();
        assert!(card.contains("\"looked_up_times\":2"), "{card}");
        assert!(
            card.contains("\"previous_definition\":\"to give up\""),
            "{card}"
        );
        assert!(card.contains("\"mastery\":\"mastered\""), "{card}");
        assert!(card.contains("requested modules"), "{card}");
    }

    #[test]
    fn the_card_block_stays_absent_for_a_word_with_no_record() {
        let conn = library_with_books(&["b1"]);
        assert_eq!(learning_card_memory_block(&conn, "resign", NOW_MS), None);
    }

    #[test]
    fn lookup_memory_matches_a_word_carrying_punctuation() {
        let conn = library_with_books(&["b1"]);
        record_lookup(
            &conn,
            "b1",
            "cfi/1",
            "resign",
            "to give up",
            NOW_MS - DAY_MS,
            1,
        );
        save_word(&conn, "v1", "b1", "resign", "learning");

        let block = learning_card_memory_block(&conn, "  Resign, ", NOW_MS).unwrap();
        assert!(block.contains("\"looked_up_times\":1"), "{block}");
        assert!(block.contains("\"mastery\":\"learning\""), "{block}");
    }

    #[test]
    fn lookup_memory_truncates_an_overlong_definition_on_a_char_boundary() {
        let conn = library_with_books(&["b1"]);
        let definition = "辞".repeat(200);
        record_lookup(
            &conn,
            "b1",
            "cfi/1",
            "resign",
            &definition,
            NOW_MS - DAY_MS,
            1,
        );

        let block = learning_card_memory_block(&conn, "resign", NOW_MS).unwrap();
        let kept = "辞".repeat(LOOKUP_MEMORY_DEFINITION_BYTES / "辞".len());
        assert!(block.contains(&kept), "{block}");
        assert!(!block.contains(&format!("{kept}辞")), "{block}");
    }
}
