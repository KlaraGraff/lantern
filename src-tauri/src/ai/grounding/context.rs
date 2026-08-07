//! Stage ② of contextual retrieval: give every chunk a one-sentence
//! "identity" — where it sits in the book, who or what it's about — so a
//! chunk of pure narrative with no proper nouns can still be found by an
//! embedding search that only has the raw sentence to go on. The sentence
//! never touches `book_chunks.text`; it only ever prefixes what stage ③
//! sends to the embedding model. See docs/impls/contextual-retrieval.md.

use rusqlite::params;
use tauri::{AppHandle, Runtime};

use crate::ai::router::{self, AiRequestPurpose, AiRetryMode};
use crate::commands::ai::ChatMessage;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

/// Chapters at or under this size go into the prompt whole. Above it, only a
/// fixed opening slice is cached — see `chapter_prefix`.
const CONTEXT_WINDOW_TOKENS: usize = 8_000;
/// The fixed opening slice of an oversized chapter that forms the cached
/// prefix (see `chapter_prefix`).
const CONTEXT_PREFIX_TOKENS: usize = 4_000;
/// Extra chapter text either side of the target chunk, offered only when the
/// chapter didn't fit whole in the prefix (see `local_window`).
const CONTEXT_LOCAL_WINDOW_TOKENS: usize = 2_000;
/// `context_line` is capped to this many characters after cleanup — a
/// locator sentence, not a summary.
const CONTEXT_LINE_MAX_CHARS: usize = 200;

const CONTEXT_LINE_SYSTEM_PROMPT: &str = "You are given the full text of one chapter from a book, and a single passage taken from within it. In one sentence, written in the same language as the passage, say where in the book this passage falls and who or what it concerns. Do not quote or restate the passage's wording, and do not add a label or quotation marks around your answer — output only that one sentence.";

/// One `book_chunks` row, carrying just what stage ② needs: enough to decide
/// whether it's pending, and enough (together with its section-mates) to
/// rebuild the chapter text around it.
struct ChunkRow {
    id: String,
    section_index: i64,
    section_title: Option<String>,
    chunk_index: i64,
    text: String,
    token_estimate: usize,
    context_line: Option<String>,
}

/// Whether the reader has this feature switched on. Missing key defaults to
/// on: per the design's first principle, a wrong identity sentence can only
/// make ranking worse, never fabricate what a citation shows, so there is no
/// downside-on-launch risk that would call for defaulting off.
fn context_lines_enabled(db: &Db) -> bool {
    let conn = db.reader();
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'ai_context_lines_enabled'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .map(|value| value != "false")
    .unwrap_or(true)
}

/// All of a book's chunks, ordered the same way the pending query in the
/// design doc is: by `chunk_index`. Chunks never cross a section boundary
/// (see `grounding/chunk.rs`), and `chunk_index` is assigned in book order,
/// so this ordering also happens to group every section's chunks together —
/// the property stage ② relies on to keep the cached prefix stable across a
/// run of consecutive calls.
fn load_chunk_rows(db: &Db, book_id: &str) -> AppResult<(String, Vec<ChunkRow>)> {
    let conn = db.reader();
    let book_title: String = conn
        .query_row(
            "SELECT title FROM books WHERE id = ?1",
            params![book_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "Untitled".to_string());
    let mut statement = conn.prepare(
        "SELECT id, section_index, section_title, chunk_index, text, token_estimate, context_line
         FROM book_chunks WHERE book_id = ?1 ORDER BY chunk_index",
    )?;
    let rows = statement
        .query_map(params![book_id], |row| {
            Ok(ChunkRow {
                id: row.get(0)?,
                section_index: row.get(1)?,
                section_title: row.get(2)?,
                chunk_index: row.get(3)?,
                text: row.get(4)?,
                token_estimate: row.get::<_, i64>(5)? as usize,
                context_line: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok((book_title, rows))
}

/// Pending chunks, in the order they should be processed. `context_line IS
/// NULL` (not `= ''`) is deliberate: an empty string is the "tried, got
/// nothing" sentinel stage ② itself writes, and re-picking it up on every
/// run would retry a chunk the model has already failed on forever.
fn pending_rows(rows: &[ChunkRow]) -> Vec<&ChunkRow> {
    rows.iter().filter(|row| row.context_line.is_none()).collect()
}

fn chapter_header(book_title: &str, section_index: i64, section_title: Option<&str>) -> String {
    let title = section_title.map(str::trim).filter(|title| !title.is_empty());
    match title {
        // Chapters are numbered for the model's benefit only (never shown to
        // the reader), so an off-by-one against however the book itself
        // labels chapters is harmless — it only has to be a locator, not a
        // citation.
        Some(title) => format!("{book_title} · Chapter {} — {title}", section_index + 1),
        None => format!("{book_title} · Chapter {}", section_index + 1),
    }
}

/// The chapter text that goes in the cached prefix. A chapter within budget
/// goes in whole; a longer one is cut to its first `CONTEXT_PREFIX_TOKENS` —
/// a slice that depends only on the chapter, never on which chunk is being
/// described. That's what keeps the prefix byte-identical across every call
/// for the chapter, which is the property the provider's prompt cache keys
/// on. (Anything the target chunk needs beyond this fixed opening comes from
/// `local_window` instead, in the per-call part of the prompt.)
fn chapter_prefix(section_rows: &[&ChunkRow]) -> String {
    let total_tokens: usize = section_rows.iter().map(|row| row.token_estimate).sum();
    if total_tokens <= CONTEXT_WINDOW_TOKENS {
        return section_rows
            .iter()
            .map(|row| row.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    let mut used = 0usize;
    let mut parts = Vec::new();
    for row in section_rows {
        if used > 0 && used + row.token_estimate > CONTEXT_PREFIX_TOKENS {
            break;
        }
        used += row.token_estimate;
        parts.push(row.text.as_str());
    }
    parts.join("\n\n")
}

/// Chapter text around the target chunk, used only when the chapter was too
/// long to send whole (see `chapter_prefix`) and so the fixed opening slice
/// may sit far from the passage being described. Lives in the per-chunk part
/// of the prompt, not the prefix — it moves with the target chunk, so
/// folding it into the prefix would defeat the caching `chapter_prefix` is
/// built to preserve.
fn local_window(section_rows: &[&ChunkRow], target_chunk_index: i64) -> String {
    let Some(target_pos) = section_rows
        .iter()
        .position(|row| row.chunk_index == target_chunk_index)
    else {
        return String::new();
    };
    let mut before = Vec::new();
    let mut used = 0usize;
    for row in section_rows[..target_pos].iter().rev() {
        if used + row.token_estimate > CONTEXT_LOCAL_WINDOW_TOKENS {
            break;
        }
        used += row.token_estimate;
        before.push(row.text.as_str());
    }
    before.reverse();
    let mut after = Vec::new();
    used = 0;
    for row in &section_rows[target_pos + 1..] {
        if used + row.token_estimate > CONTEXT_LOCAL_WINDOW_TOKENS {
            break;
        }
        used += row.token_estimate;
        after.push(row.text.as_str());
    }
    before.into_iter().chain(after).collect::<Vec<_>>().join("\n\n")
}

fn user_messages(header: &str, prefix: &str, window: &str, passage: &str) -> Vec<ChatMessage> {
    let part1 = format!("{header}\n\n{prefix}");
    let part2 = if window.is_empty() {
        format!("Passage to describe:\n{passage}")
    } else {
        format!("Nearby chapter text:\n{window}\n\nPassage to describe:\n{passage}")
    };
    vec![
        ChatMessage {
            role: "user".to_string(),
            content: part1,
        },
        ChatMessage {
            role: "user".to_string(),
            content: part2,
        },
    ]
}

/// Turn a raw completion into a stored `context_line`: strip the quoting and
/// restating lead-ins a model adds despite being asked not to, then cap the
/// length. An empty result collapses to `""`, never back to a value that
/// looks unset — see `pending_rows` for why that distinction matters.
fn clean_context_line(raw: &str) -> String {
    let mut value = raw.trim();
    const QUOTE_PAIRS: &[(&str, &str)] = &[
        ("\"", "\""),
        ("'", "'"),
        ("\u{201c}", "\u{201d}"),
        ("\u{300c}", "\u{300d}"),
        ("\u{300e}", "\u{300f}"),
    ];
    for (open, close) in QUOTE_PAIRS {
        // `>=`, not `>`: an empty quoted string ("\"\"") is a legitimate
        // empty result and should strip down to "". The one case to guard
        // is a single lone delimiter matching itself as both start and end
        // (open == close and nothing else in the string) — that's one
        // stray character, not a pair, and stripping it would eat content
        // that was never quoted.
        let is_lone_delimiter = open == close && value.len() == open.len();
        if value.starts_with(open)
            && value.ends_with(close)
            && value.len() >= open.len() + close.len()
            && !is_lone_delimiter
        {
            value = value[open.len()..value.len() - close.len()].trim();
        }
    }
    // English comparison is done on an ASCII-only lowercase copy so the byte
    // offset used to slice `value` afterwards stays valid — ASCII-only
    // lowercasing never changes a string's length or its char boundaries,
    // unlike a full Unicode lowercase.
    const LEAD_INS: &[&str] = &[
        "this passage is about ",
        "this passage describes ",
        "this section is about ",
        "this section describes ",
        "in this passage, ",
        "in this passage ",
        "这段讲的是",
        "这段描述的是",
        "这段说的是",
        "这一段讲的是",
    ];
    let lower = value.to_ascii_lowercase();
    for lead_in in LEAD_INS {
        if lower.starts_with(lead_in) {
            value = value[lead_in.len()..].trim_start();
            break;
        }
    }
    let value = value.trim_start_matches([':', '：', ',', '，']).trim();
    value.chars().take(CONTEXT_LINE_MAX_CHARS).collect()
}

fn write_context_line(db: &Db, chunk_id: &str, context_line: &str, model: &str) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "UPDATE book_chunks SET context_line = ?1, context_model = ?2, context_at = ?3 WHERE id = ?4",
        params![
            context_line,
            model,
            chrono::Utc::now().timestamp_millis(),
            chunk_id
        ],
    )?;
    Ok(())
}

/// Write an identity sentence for every chunk in `book_id` that doesn't have
/// one yet. Resumable: each chunk is written as soon as its own call
/// succeeds, and a call that fails stops the whole run and returns the error,
/// leaving already-written rows in place — the next run picks up wherever
/// `context_line IS NULL` still holds. No per-chunk retry here; `ai::router`
/// already carries failover and cooldowns for the underlying calls.
pub async fn ensure_context_lines<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    book_id: &str,
) -> AppResult<()> {
    if !context_lines_enabled(db) {
        return Ok(());
    }
    let (book_title, rows) = load_chunk_rows(db, book_id)?;
    let mut sections: std::collections::BTreeMap<i64, Vec<&ChunkRow>> =
        std::collections::BTreeMap::new();
    for row in &rows {
        sections.entry(row.section_index).or_default().push(row);
    }
    // The prefix depends only on the section, and `pending_rows` comes back
    // in `chunk_index` order — which groups each section's chunks together —
    // so rebuilding it per chunk would re-join the same chapter text once for
    // every chunk in it. Held across iterations and recomputed on section
    // change instead.
    let mut cached_prefix: Option<(i64, String)> = None;
    for row in pending_rows(&rows) {
        // Re-read the switch every iteration, not just on entry. This runs in
        // the background while the reader reads, so the switch is their only
        // brake — a book of a few hundred chunks is a few hundred sequential
        // calls, and on a metered provider "off" has to mean "stop now", not
        // "stop before the next book".
        if !context_lines_enabled(db) {
            return Ok(());
        }
        let section_rows = sections
            .get(&row.section_index)
            .expect("row's own section is present in the map built from the same rows");
        let header = chapter_header(&book_title, row.section_index, row.section_title.as_deref());
        let prefix = match &cached_prefix {
            Some((section_index, prefix)) if *section_index == row.section_index => prefix.clone(),
            _ => {
                let prefix = chapter_prefix(section_rows);
                cached_prefix = Some((row.section_index, prefix.clone()));
                prefix
            }
        };
        let window = local_window(section_rows, row.chunk_index);
        let mut messages = vec![ChatMessage {
            role: "system".to_string(),
            content: CONTEXT_LINE_SYSTEM_PROMPT.to_string(),
        }];
        messages.extend(user_messages(&header, &prefix, &window, &row.text));
        let completion = router::complete_with_failover(
            app,
            db,
            secrets,
            &messages,
            Some(120),
            AiRequestPurpose::Utility,
            AiRetryMode::Automatic,
            None,
            None,
            "auto",
            "grounding_context",
        )
        .await?;
        let cleaned = clean_context_line(&completion.text);
        write_context_line(db, &row.id, &cleaned, &completion.model)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(section: i64, chunk: i64, tokens: usize, text: &str) -> ChunkRow {
        ChunkRow {
            id: format!("{section}-{chunk}"),
            section_index: section,
            section_title: Some("Chapter".to_string()),
            chunk_index: chunk,
            text: text.to_string(),
            token_estimate: tokens,
            context_line: None,
        }
    }

    #[test]
    fn pending_rows_skips_null_and_empty_context_lines_differently() {
        let mut untried = row(0, 0, 10, "a");
        let mut given_up_on = row(0, 1, 10, "b");
        given_up_on.context_line = Some(String::new());
        let mut done = row(0, 2, 10, "c");
        done.context_line = Some("has one".to_string());
        untried.context_line = None;
        let rows = vec![untried, given_up_on, done];
        // Only the untried (NULL) row is pending — the '' sentinel row must
        // not be retried forever, and the filled-in row is simply finished.
        let pending = pending_rows(&rows);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].chunk_index, 0);
    }

    #[test]
    fn chapter_prefix_uses_full_text_within_budget() {
        let a = row(0, 0, 100, "one");
        let b = row(0, 1, 100, "two");
        let rows = [&a, &b];
        assert_eq!(chapter_prefix(&rows), "one\n\ntwo");
    }

    #[test]
    fn chapter_prefix_truncates_oversized_chapters_to_the_fixed_opening() {
        let a = row(0, 0, 5_000, "opening");
        let b = row(0, 1, 5_000, "later");
        let rows = [&a, &b];
        // Total exceeds CONTEXT_WINDOW_TOKENS, so only the opening chunk (at
        // or under CONTEXT_PREFIX_TOKENS on its own) survives into the
        // prefix.
        assert_eq!(chapter_prefix(&rows), "opening");
    }

    #[test]
    fn chapter_prefix_is_independent_of_which_chunk_is_the_target() {
        // The whole point of the prefix: it's a pure function of the
        // section's chunks, never of a target chunk index, so consecutive
        // calls in the same chapter send byte-identical bytes and the
        // provider's prompt cache actually fires.
        let a = row(0, 0, 5_000, "opening");
        let b = row(0, 1, 5_000, "middle");
        let c = row(0, 2, 5_000, "end");
        let rows = [&a, &b, &c];
        let first_call = chapter_prefix(&rows);
        let second_call = chapter_prefix(&rows);
        assert_eq!(first_call, second_call);
    }

    #[test]
    fn local_window_only_pulls_from_the_same_section_and_stays_within_budget() {
        let a = row(0, 0, 500, "before");
        let b = row(0, 1, 100, "target");
        let c = row(0, 2, 500, "after");
        let rows = [&a, &b, &c];
        assert_eq!(local_window(&rows, 1), "before\n\nafter");
    }

    #[test]
    fn local_window_stops_when_the_target_chunk_is_missing() {
        let a = row(0, 0, 10, "a");
        assert_eq!(local_window(&[&a], 99), "");
    }

    #[test]
    fn chapter_header_includes_the_section_title_when_present() {
        assert_eq!(
            chapter_header("Emma", 0, Some("The Ball")),
            "Emma · Chapter 1 — The Ball"
        );
        assert_eq!(chapter_header("Emma", 0, None), "Emma · Chapter 1");
        assert_eq!(chapter_header("Emma", 0, Some("   ")), "Emma · Chapter 1");
    }

    #[test]
    fn clean_context_line_strips_quotes_and_lead_ins() {
        assert_eq!(
            clean_context_line("\"This passage describes Darcy's proposal.\""),
            "Darcy's proposal."
        );
        assert_eq!(
            clean_context_line("这段讲的是：达西向伊丽莎白求婚。"),
            "达西向伊丽莎白求婚。"
        );
    }

    #[test]
    fn clean_context_line_truncates_to_the_character_cap() {
        let long = "x".repeat(CONTEXT_LINE_MAX_CHARS + 50);
        assert_eq!(clean_context_line(&long).chars().count(), CONTEXT_LINE_MAX_CHARS);
    }

    #[test]
    fn clean_context_line_collapses_empty_output_to_empty_string() {
        assert_eq!(clean_context_line("   "), "");
        assert_eq!(clean_context_line("\"\""), "");
    }

    #[test]
    fn context_lines_enabled_defaults_to_on_and_respects_explicit_false() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        assert!(context_lines_enabled(&db));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('ai_context_lines_enabled', 'false')",
                [],
            )
            .unwrap();
        }
        assert!(!context_lines_enabled(&db));
    }

    #[tokio::test]
    async fn ensure_context_lines_short_circuits_when_disabled_without_touching_a_missing_book() {
        // If this reached the network-calling loop it would fail on the
        // missing book's title lookup or the pending query; returning Ok(())
        // here is only possible if the settings check runs first.
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('ai_context_lines_enabled', 'false')",
                [],
            )
            .unwrap();
        }
        let secrets = Secrets::init_in_memory().unwrap();
        let app = tauri::test::mock_app();
        let result = ensure_context_lines(app.handle(), &db, &secrets, "does-not-exist").await;
        assert!(result.is_ok());
    }
}
