//! Highlights nobody drew: the passages a reader already marked by *using*
//! them.
//!
//! Looking a word up records the sentence it sat in and where. Quoting a
//! passage into a chat records the passage and where. Both are the same two
//! facts a highlight is made of — a location and the text at it — so the
//! highlights panel can show them without anyone having to drag a finger
//! across the page first.
//!
//! They are derived on read, never stored. A `highlights` row per lookup would
//! be a second copy of data that already exists, and the copy would then have
//! to be kept in step with the original for as long as the book lives: edit the
//! lookup, delete the chat, and the copy is a lie. Deriving costs one query per
//! source and cannot drift.
//!
//! What derivation *cannot* recover is a decision. "Do not show me this one"
//! exists nowhere in a lookup record, so it gets the only stored row in this
//! module — see migration 054 — and it is the only thing sync carries.

use rusqlite::params;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::events::{
    auto_highlight_dismissal_id, AutoHighlightDismissalPayload, EventBody, HighlightPayload,
};
use crate::sync::writer::SyncWriter;

use super::bookmarks::Highlight;

/// Sources are named, not numbered, because the panel says where each row came
/// from ("自动 · 查词 steadfastness") and a number would make that a lookup
/// table on the frontend.
pub const SOURCE_LOOKUP: &str = "lookup";
pub const SOURCE_CHAT: &str = "chat";

/// A highlight the reader never drew. `anchor` is its identity across devices
/// and the only thing a dismissal names; nothing else here is persisted.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AutoHighlight {
    pub anchor: String,
    pub book_id: String,
    pub cfi: String,
    pub text: String,
    pub source: String,
    /// The looked-up word, for the row's badge. Chat quotes have no one word.
    pub label: Option<String>,
    pub created_at: i64,
}

/// Anchors are opaque to sync and to the dismissal table, but they are not
/// opaque here: this module mints them and must keep them stable, because a
/// changed anchor is a resurrected dismissal.
fn lookup_anchor(record_id: &str) -> String {
    format!("lookup:{record_id}")
}

fn chat_anchor(message_id: &str, quote_index: usize) -> String {
    format!("chat:{message_id}:{quote_index}")
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// One quote pulled off a chat message: the text, where it came from in the
/// book, and whether it is book text at all.
struct ChatQuote {
    text: String,
    cfi: Option<String>,
    is_reply: bool,
}

/// A turn carries either one quote (the `context` column, with its CFI in
/// `metadata.cfi`) or several (`metadata.contexts`), and the single-quote form
/// is the first of the many — so the index is the same in both readings and an
/// anchor minted before the reader stacked a second quote still points at the
/// same passage.
fn quotes_from_message(context: Option<String>, metadata: Option<&str>) -> Vec<ChatQuote> {
    let parsed: Option<Value> = metadata.and_then(|raw| serde_json::from_str(raw).ok());
    let meta = parsed.as_ref().and_then(Value::as_object);

    if let Some(list) = meta
        .and_then(|m| m.get("contexts"))
        .and_then(Value::as_array)
    {
        return list
            .iter()
            .map(|entry| ChatQuote {
                text: entry
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                cfi: non_empty(entry.get("cfi").and_then(Value::as_str).map(str::to_string)),
                is_reply: entry.get("kind").and_then(Value::as_str) == Some("reply"),
            })
            .collect();
    }

    let Some(text) = non_empty(context) else {
        return Vec::new();
    };
    vec![ChatQuote {
        text,
        cfi: non_empty(
            meta.and_then(|m| m.get("cfi"))
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        is_reply: meta
            .and_then(|m| m.get("contextKind"))
            .and_then(Value::as_str)
            == Some("reply"),
    }]
}

/// Everything derivable for this book, before dismissals and before the
/// already-highlighted check. Kept separate so `promote` can resolve an anchor
/// the list is deliberately hiding.
fn derive_all(db: &Db, book_id: &str) -> AppResult<Vec<AutoHighlight>> {
    let conn = db.reader();
    let mut derived: Vec<AutoHighlight> = Vec::new();

    // A lookup without a CFI cannot be pointed at, so it cannot be a highlight.
    let mut lookups = conn.prepare(
        "SELECT id, lookup_text, context_sentence, cfi, created_at
           FROM lookup_records
          WHERE book_id = ?1 AND cfi IS NOT NULL AND TRIM(cfi) <> ''",
    )?;
    let rows = lookups.query_map(params![book_id], |row| {
        let id: String = row.get("id")?;
        let word: String = row.get("lookup_text")?;
        let sentence: Option<String> = row.get("context_sentence")?;
        let cfi: String = row.get("cfi")?;
        let created_at: i64 = row.get("created_at")?;
        Ok((id, word, sentence, cfi, created_at))
    })?;
    for row in rows {
        let (id, word, sentence, cfi, created_at) = row?;
        // The sentence is what a highlight would cover; the bare word is the
        // fallback for lookups recorded before sentences were captured.
        let text = non_empty(sentence).unwrap_or_else(|| word.trim().to_string());
        if text.is_empty() {
            continue;
        }
        derived.push(AutoHighlight {
            anchor: lookup_anchor(&id),
            book_id: book_id.to_string(),
            cfi,
            text,
            source: SOURCE_LOOKUP.to_string(),
            label: non_empty(Some(word)),
            created_at,
        });
    }

    let mut quotes = conn.prepare(
        "SELECT m.id, m.context, m.metadata, m.created_at
           FROM chat_messages m
           JOIN chats c ON c.id = m.chat_id
          WHERE c.book_id = ?1 AND m.role = 'user'",
    )?;
    let rows = quotes.query_map(params![book_id], |row| {
        let id: String = row.get("id")?;
        let context: Option<String> = row.get("context")?;
        let metadata: Option<String> = row.get("metadata")?;
        let created_at: i64 = row.get("created_at")?;
        Ok((id, context, metadata, created_at))
    })?;
    for row in rows {
        let (id, context, metadata, created_at) = row?;
        for (index, quote) in quotes_from_message(context, metadata.as_deref())
            .into_iter()
            .enumerate()
        {
            // A quoted reply is the assistant's words. It has no place in the
            // book and must never be offered as a highlight of one.
            if quote.is_reply || quote.text.is_empty() {
                continue;
            }
            let Some(cfi) = quote.cfi else { continue };
            derived.push(AutoHighlight {
                anchor: chat_anchor(&id, index),
                book_id: book_id.to_string(),
                cfi,
                text: quote.text,
                source: SOURCE_CHAT.to_string(),
                label: None,
                created_at,
            });
        }
    }

    Ok(derived)
}

/// Newest first, the same order `list_highlights` returns, so the panel can
/// merge the two lists on `created_at` without either one having to be
/// re-sorted or promoted above the other.
#[tauri::command]
pub fn list_auto_highlights(book_id: String, db: State<'_, Db>) -> AppResult<Vec<AutoHighlight>> {
    query_auto_highlights(&db, &book_id)
}

pub(crate) fn query_auto_highlights(db: &Db, book_id: &str) -> AppResult<Vec<AutoHighlight>> {
    let mut derived = derive_all(db, book_id)?;

    let conn = db.reader();
    let mut dismissed = conn.prepare(
        "SELECT anchor FROM auto_highlight_dismissals WHERE book_id = ?1 AND dismissed = 1",
    )?;
    let dismissed: std::collections::HashSet<String> = dismissed
        .query_map(params![book_id], |row| row.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;

    // A passage the reader highlighted by hand is already in the list once.
    // Showing the lookup that happens to sit at the same anchor would make the
    // panel argue with itself about who marked it.
    let mut manual = conn.prepare("SELECT cfi_range FROM highlights WHERE book_id = ?1")?;
    let manual: std::collections::HashSet<String> = manual
        .query_map(params![book_id], |row| row.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;

    derived.retain(|item| !dismissed.contains(&item.anchor) && !manual.contains(&item.cfi));
    // Anchor breaks ties so two lookups recorded in the same millisecond keep a
    // stable order between renders.
    derived.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.anchor.cmp(&b.anchor))
    });
    Ok(derived)
}

/// 「不再显示」 and its undo are the same call with opposite flags — undo has to
/// write a *newer* row rather than delete one, or a peer's stale dismissal
/// would win the merge and hide the passage again.
#[tauri::command]
pub fn set_auto_highlight_dismissed(
    book_id: String,
    anchor: String,
    dismissed: bool,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    set_auto_highlight_dismissed_inner(&book_id, &anchor, dismissed, &db, &sync)
}

pub(crate) fn set_auto_highlight_dismissed_inner(
    book_id: &str,
    anchor: &str,
    dismissed: bool,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(book_id)?;
    if anchor.trim().is_empty() {
        return Err(AppError::Other("AUTO_HIGHLIGHT_ANCHOR_INVALID".to_string()));
    }
    let id = auto_highlight_dismissal_id(book_id, anchor);
    let timestamp = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();

    sync.with_tx(db, timestamp, |tx, events| {
        write_dismissal(tx, &id, book_id, anchor, dismissed, timestamp, &device)?;
        events.push(EventBody::AutoHighlightDismissalSet(
            AutoHighlightDismissalPayload {
                id: id.clone(),
                book_id: book_id.to_string(),
                anchor: anchor.to_string(),
                dismissed,
                created_at: timestamp,
            },
        ));
        Ok(())
    })
}

fn write_dismissal(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    book_id: &str,
    anchor: &str,
    dismissed: bool,
    timestamp: i64,
    device: &str,
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO auto_highlight_dismissals
         (id, book_id, anchor, dismissed, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
         ON CONFLICT(book_id, anchor) DO UPDATE SET
           dismissed = excluded.dismissed,
           updated_at = excluded.updated_at,
           updated_by_device = excluded.updated_by_device",
        params![id, book_id, anchor, dismissed as i64, timestamp, device],
    )?;
    Ok(())
}

/// 「留下」: turn a derived row into a real highlight the reader owns.
///
/// The CFI and text are re-derived here rather than taken from the caller, so
/// what gets kept is what the source actually says — not what a stale panel was
/// still showing.
///
/// Two consequences worth knowing. The new highlight is dated now, not when the
/// lookup happened, because that is when the reader decided to keep it; it
/// therefore appears at the top of the list. And the anchor is dismissed in the
/// same transaction, so deleting the promoted highlight later does not make the
/// automatic row come back — the reader has now said twice what they think of
/// this passage.
#[tauri::command]
pub fn promote_auto_highlight(
    book_id: String,
    anchor: String,
    color: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Highlight> {
    promote_auto_highlight_inner(&book_id, &anchor, color, &db, &sync)
}

pub(crate) fn promote_auto_highlight_inner(
    book_id: &str,
    anchor: &str,
    color: Option<String>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Highlight> {
    crate::sync::validation::validate_entity_id(book_id)?;
    let source = derive_all(db, book_id)?
        .into_iter()
        .find(|item| item.anchor == anchor)
        .ok_or_else(|| AppError::Other("AUTO_HIGHLIGHT_NOT_FOUND".to_string()))?;

    let id = uuid::Uuid::new_v4().to_string();
    let color = color.unwrap_or_else(|| "yellow".to_string());
    let dismissal_id = auto_highlight_dismissal_id(book_id, anchor);
    let timestamp = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();

    let highlight = Highlight {
        id: id.clone(),
        book_id: book_id.to_string(),
        cfi_range: source.cfi.clone(),
        color: color.clone(),
        text_content: Some(source.text.clone()),
        created_at: timestamp,
        updated_at: timestamp,
    };

    sync.with_tx(db, timestamp, |tx, events| {
        tx.execute(
            "INSERT INTO highlights
             (id, book_id, cfi_range, color, text_content, created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
            params![
                id,
                book_id,
                source.cfi,
                color,
                source.text,
                timestamp,
                device
            ],
        )?;
        events.push(EventBody::HighlightAdd(HighlightPayload {
            id: id.clone(),
            book_id: book_id.to_string(),
            cfi_range: source.cfi.clone(),
            color: color.clone(),
            text_content: Some(source.text.clone()),
        }));

        write_dismissal(tx, &dismissal_id, book_id, anchor, true, timestamp, &device)?;
        events.push(EventBody::AutoHighlightDismissalSet(
            AutoHighlightDismissalPayload {
                id: dismissal_id.clone(),
                book_id: book_id.to_string(),
                anchor: anchor.to_string(),
                dismissed: true,
                created_at: timestamp,
            },
        ));
        Ok(())
    })?;

    Ok(highlight)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db, SyncWriter) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let sync = SyncWriter::new("dev-A".into());
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress,
                  created_at, updated_at, updated_by_device)
                 VALUES ('book', 'Book', 'Author', 'books/book.epub', 'epub',
                         'reading', 0.4, 1, 1, 'dev-A')",
                [],
            )
            .unwrap();
        }
        (dir, db, sync)
    }

    fn insert_lookup(
        db: &Db,
        id: &str,
        word: &str,
        sentence: Option<&str>,
        cfi: Option<&str>,
        at: i64,
    ) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO lookup_records
             (id, book_id, lookup_text, normalized_text, context_sentence, cfi,
              definition, created_at, last_looked_up_at, lookup_count)
             VALUES (?1, 'book', ?2, ?3, ?4, ?5, '', ?6, ?6, 1)",
            params![id, word, word.to_lowercase(), sentence, cfi, at],
        )
        .unwrap();
    }

    fn insert_chat_message(
        db: &Db,
        id: &str,
        context: Option<&str>,
        metadata: Option<&str>,
        at: i64,
    ) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO chats (id, book_id, title, created_at, updated_at)
             VALUES ('chat', 'book', 'Chat', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages (id, chat_id, role, content, context, metadata, created_at, updated_at)
             VALUES (?1, 'chat', 'user', 'why this', ?2, ?3, ?4, ?4)",
            params![id, context, metadata, at],
        )
        .unwrap();
    }

    #[test]
    fn a_lookup_with_a_location_becomes_a_highlight_of_its_sentence() {
        let (_dir, db, _sync) = setup();
        insert_lookup(
            &db,
            "r1",
            "steadfastness",
            Some("He admired her steadfastness."),
            Some("epubcfi(/6/4!/2)"),
            1_000,
        );

        let derived = query_auto_highlights(&db, "book").unwrap();
        assert_eq!(derived.len(), 1);
        assert_eq!(derived[0].anchor, "lookup:r1");
        assert_eq!(derived[0].text, "He admired her steadfastness.");
        assert_eq!(derived[0].label.as_deref(), Some("steadfastness"));
        assert_eq!(derived[0].source, SOURCE_LOOKUP);
    }

    #[test]
    fn a_lookup_without_a_location_is_not_derivable() {
        let (_dir, db, _sync) = setup();
        insert_lookup(&db, "r1", "steadfastness", Some("A sentence."), None, 1_000);
        assert!(query_auto_highlights(&db, "book").unwrap().is_empty());
    }

    #[test]
    fn a_lookup_recorded_without_its_sentence_falls_back_to_the_word() {
        let (_dir, db, _sync) = setup();
        insert_lookup(
            &db,
            "r1",
            "steadfastness",
            None,
            Some("epubcfi(/6/4!/2)"),
            1_000,
        );
        assert_eq!(
            query_auto_highlights(&db, "book").unwrap()[0].text,
            "steadfastness"
        );
    }

    #[test]
    fn a_quoted_passage_becomes_a_highlight_and_a_quoted_reply_does_not() {
        let (_dir, db, _sync) = setup();
        insert_chat_message(
            &db,
            "m1",
            Some("The passage."),
            Some(r#"{"cfi":"epubcfi(/6/8!/4)"}"#),
            2_000,
        );
        insert_chat_message(
            &db,
            "m2",
            Some("What the assistant said."),
            Some(r#"{"cfi":"epubcfi(/6/8!/6)","contextKind":"reply"}"#),
            3_000,
        );

        let derived = query_auto_highlights(&db, "book").unwrap();
        assert_eq!(derived.len(), 1);
        assert_eq!(derived[0].anchor, "chat:m1:0");
        assert_eq!(derived[0].source, SOURCE_CHAT);
        assert_eq!(derived[0].label, None);
    }

    #[test]
    fn stacked_quotes_each_get_their_own_anchor_and_reply_quotes_drop_out() {
        let (_dir, db, _sync) = setup();
        let metadata = r#"{"cfi":"epubcfi(/6/8!/4)","contexts":[
            {"text":"First passage.","cfi":"epubcfi(/6/8!/4)"},
            {"text":"A reply.","kind":"reply","cfi":"epubcfi(/6/8!/5)"},
            {"text":"Third passage.","cfi":"epubcfi(/6/8!/6)"}]}"#;
        insert_chat_message(&db, "m1", Some("First passage."), Some(metadata), 2_000);

        let derived = query_auto_highlights(&db, "book").unwrap();
        let anchors: Vec<&str> = derived.iter().map(|d| d.anchor.as_str()).collect();
        assert_eq!(anchors, vec!["chat:m1:0", "chat:m1:2"]);
    }

    #[test]
    fn a_quote_with_no_location_is_skipped_but_its_siblings_keep_their_index() {
        let (_dir, db, _sync) = setup();
        let metadata = r#"{"contexts":[
            {"text":"No location."},
            {"text":"Located.","cfi":"epubcfi(/6/8!/6)"}]}"#;
        insert_chat_message(&db, "m1", Some("No location."), Some(metadata), 2_000);

        let derived = query_auto_highlights(&db, "book").unwrap();
        assert_eq!(derived.len(), 1);
        assert_eq!(derived[0].anchor, "chat:m1:1");
    }

    #[test]
    fn everything_is_ordered_newest_first_regardless_of_source() {
        let (_dir, db, _sync) = setup();
        insert_lookup(
            &db,
            "r1",
            "one",
            Some("Oldest."),
            Some("epubcfi(/6/4!/2)"),
            1_000,
        );
        insert_chat_message(
            &db,
            "m1",
            Some("Middle."),
            Some(r#"{"cfi":"epubcfi(/6/8!/4)"}"#),
            2_000,
        );
        insert_lookup(
            &db,
            "r2",
            "two",
            Some("Newest."),
            Some("epubcfi(/6/4!/9)"),
            3_000,
        );

        let texts: Vec<String> = query_auto_highlights(&db, "book")
            .unwrap()
            .into_iter()
            .map(|d| d.text)
            .collect();
        assert_eq!(texts, vec!["Newest.", "Middle.", "Oldest."]);
    }

    #[test]
    fn a_passage_the_reader_highlighted_by_hand_is_not_also_offered_automatically() {
        let (_dir, db, sync) = setup();
        insert_lookup(
            &db,
            "r1",
            "one",
            Some("A sentence."),
            Some("epubcfi(/6/4!/2)"),
            1_000,
        );
        super::super::bookmarks::add_highlight_inner(
            "book",
            "epubcfi(/6/4!/2)",
            None,
            Some("A sentence.".into()),
            &db,
            &sync,
        )
        .unwrap();

        assert!(query_auto_highlights(&db, "book").unwrap().is_empty());
    }

    #[test]
    fn dismissing_hides_one_anchor_and_undo_brings_it_back() {
        let (_dir, db, sync) = setup();
        insert_lookup(
            &db,
            "r1",
            "one",
            Some("First."),
            Some("epubcfi(/6/4!/2)"),
            1_000,
        );
        insert_lookup(
            &db,
            "r2",
            "two",
            Some("Second."),
            Some("epubcfi(/6/4!/9)"),
            2_000,
        );

        set_auto_highlight_dismissed_inner("book", "lookup:r1", true, &db, &sync).unwrap();
        let left = query_auto_highlights(&db, "book").unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].anchor, "lookup:r2");

        // Undo is an update to a newer row, not a delete, so it can beat a
        // peer's copy of the dismissal.
        set_auto_highlight_dismissed_inner("book", "lookup:r1", false, &db, &sync).unwrap();
        assert_eq!(query_auto_highlights(&db, "book").unwrap().len(), 2);
    }

    #[test]
    fn promotion_writes_a_real_highlight_and_retires_the_derived_one() {
        let (_dir, db, sync) = setup();
        insert_lookup(
            &db,
            "r1",
            "one",
            Some("A sentence."),
            Some("epubcfi(/6/4!/2)"),
            1_000,
        );

        let kept = promote_auto_highlight_inner("book", "lookup:r1", None, &db, &sync).unwrap();
        assert_eq!(kept.cfi_range, "epubcfi(/6/4!/2)");
        assert_eq!(kept.text_content.as_deref(), Some("A sentence."));
        assert_eq!(kept.color, "yellow");

        assert!(query_auto_highlights(&db, "book").unwrap().is_empty());
        let stored = super::super::bookmarks::query_highlights(&db, "book").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, kept.id);
    }

    #[test]
    fn promoting_a_row_that_no_longer_derives_fails_instead_of_writing_a_guess() {
        let (_dir, db, sync) = setup();
        let err = promote_auto_highlight_inner("book", "lookup:gone", None, &db, &sync);
        assert!(err.is_err());
        assert!(super::super::bookmarks::query_highlights(&db, "book")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn undoing_a_promotion_does_not_bring_the_automatic_row_back() {
        let (_dir, db, sync) = setup();
        insert_lookup(
            &db,
            "r1",
            "one",
            Some("A sentence."),
            Some("epubcfi(/6/4!/2)"),
            1_000,
        );
        let kept = promote_auto_highlight_inner("book", "lookup:r1", None, &db, &sync).unwrap();

        super::super::bookmarks::delete_highlights_inner(&[kept.id], &db, &sync).unwrap();
        assert!(query_auto_highlights(&db, "book").unwrap().is_empty());
    }
}
