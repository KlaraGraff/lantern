//! Stage ② of contextual retrieval: give every chunk a one-sentence
//! "identity" — where it sits in the book, who or what it's about — so a
//! chunk of pure narrative with no proper nouns can still be found by an
//! embedding search that only has the raw sentence to go on. The sentence
//! never touches `book_chunks.text` — that column stays byte-identical to
//! the book, which is what makes a citation a citation. It is stored beside
//! the text and read by the two searches that benefit: it prefixes what
//! stage ③ sends to the embedding model, and it fills `seg_context` in the
//! full-text index so keyword search can find a passage by who it is about.
//! See docs/impls/contextual-retrieval.md.

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Runtime};

use super::segment::{segment_for_fts, SegmentMode};
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

/// Written as a *locator*, not a summary, and deliberately not as a sentence
/// about the passage. A first draft asked for "one sentence saying where this
/// passage falls", and the model dutifully opened all but one of twelve
/// answers with "This passage falls…" / "The passage occurs…" — thirty
/// characters of text identical across every chunk in the book, which is
/// noise in an embedding and eats the length cap. Naming the pronouns is the
/// whole point of the feature: a chunk that only ever says "she was silent"
/// is unfindable until something attached to it says Elizabeth.
///
/// The language rule is anchored to the book rather than to the passage for
/// the same reason it is spelled out at all: a title page or a one-line
/// passage carries too little text to identify a language from, and the next
/// trial run answered exactly such a passage — in an English book — in
/// Spanish.
const CONTEXT_LINE_SYSTEM_PROMPT: &str = "You are given one chapter of a book and a single passage from within it. Write a short locator for that passage: where it sits in the book, and which people, places, and events it concerns. Name them explicitly — especially anyone the passage itself refers to only as \"he\", \"she\", or \"it\".

Rules:
- Write a bare phrase, not a sentence about the passage. Never begin with \"This passage\", \"The passage\", \"This section\", or the equivalent in another language.
- Write in the language of the book, which the book title in the heading above is written in.
- Keep it under 30 words.
- Do not quote or restate the passage's wording, and do not add a label or quotation marks — output the locator and nothing else.";

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

/// This job's id in the automatic-analysis registry, and — by the registry's
/// own requirement — the string its calls are tagged with in
/// `ai_usage_records.feature`. One constant rather than two literals, because
/// the failure mode when they drift is silent: the console keeps rendering the
/// row and reports it as having spent nothing, forever.
pub const JOB_ID: &str = "grounding_context";

/// Whether the reader has this feature switched on.
///
/// The answer lives in the automatic-analysis registry, which is the single
/// owner of "may this spend quota on its own". The embedding settings page
/// offers the same switch — that is where someone setting up retrieval looks
/// for it — but it writes the registry's key, so the two doors cannot
/// disagree. See migration 053.
///
/// Missing key defaults to on (`JOBS`' `default_enabled`): per the design's
/// first principle, a wrong identity sentence can only make ranking worse,
/// never fabricate what a citation shows, so there is no downside-on-launch
/// risk that would call for defaulting off.
fn context_lines_enabled(db: &Db) -> bool {
    crate::commands::auto_analysis::is_enabled(&db.reader(), JOB_ID)
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
    // The prompt forbids these openings; this is the net under it, because a
    // model that obeys eleven times out of twelve still leaves the twelfth
    // chunk carrying a frame that says nothing about the chunk.
    const LEAD_INS: &[&str] = &[
        "this passage is about ",
        "this passage describes ",
        "this passage falls ",
        "this passage occurs ",
        "this passage comes ",
        "this section is about ",
        "this section describes ",
        "the passage falls ",
        "the passage occurs ",
        "the passage is ",
        "in this passage, ",
        "in this passage ",
        "这段讲的是",
        "这段描述的是",
        "这段说的是",
        "这段出现在",
        "这一段讲的是",
        "这一段出现在",
    ];
    let lower = value.to_ascii_lowercase();
    for lead_in in LEAD_INS {
        if lower.starts_with(lead_in) {
            value = value[lead_in.len()..].trim_start();
            break;
        }
    }
    let value = value.trim_start_matches([':', '：', ',', '，']).trim();
    truncate_to_cap(value)
}

/// Cut to the character cap without leaving half a word behind.
///
/// A plain `take(CAP)` ended two of twelve trial lines in "…Elizabeth's
/// faile" and "…destined for her daughte" — fragments that are not words in
/// any language, and so embed as nothing in particular. Latin script backs
/// off to the last space; CJK has none, so it falls back to punctuation, and
/// failing that to the hard cut, which there costs one whole character rather
/// than the tail of a word.
fn truncate_to_cap(value: &str) -> String {
    if value.chars().count() <= CONTEXT_LINE_MAX_CHARS {
        return value.to_string();
    }
    let cut: String = value.chars().take(CONTEXT_LINE_MAX_CHARS).collect();
    let boundary = cut
        .rfind(char::is_whitespace)
        .or_else(|| cut.rfind(['，', '。', '、', '；', '：', ',', ';']));
    let kept = match boundary {
        // Honour a boundary only if it keeps most of the budget: one
        // enormous final token should shorten the line, not erase it.
        Some(index) if index >= cut.len() / 2 => &cut[..index],
        _ => cut.as_str(),
    };
    kept.trim_end()
        .trim_end_matches([',', ';', '，', '、', '：', ':'])
        .to_string()
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
    write_fts_context(&conn, chunk_id, context_line)?;
    Ok(())
}

/// Mirror one chunk's context line into the search index.
///
/// Addressed by `fts_rowid` rather than by `chunk_id`, because `chunk_id` is
/// UNINDEXED in FTS5 — matching on it would scan the whole index, once per
/// chunk of the book. A chunk with no rowid yet predates migration 051 and
/// is skipped; `ensure_fts_current` picks it up on the next retrieval.
fn write_fts_context(conn: &Connection, chunk_id: &str, context_line: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE book_chunks_fts SET seg_context = ?1
         WHERE rowid = (SELECT fts_rowid FROM book_chunks WHERE id = ?2 AND fts_rowid IS NOT NULL)",
        params![
            segment_for_fts(context_line, SegmentMode::Index),
            chunk_id
        ],
    )?;
    Ok(())
}

/// The book a run is currently working through, if any.
///
/// Progress lives in `book_chunks` itself — `context_line IS NULL` is "not
/// yet", `''` is "tried and got nothing" — so the only thing not derivable
/// from the database is whether anyone is still working. That is what this
/// holds, and nothing else: one book at a time, because the run is a
/// sequential loop and a second one on the same book would duplicate every
/// call.
static RUNNING_BOOK: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Claims `RUNNING_BOOK` for the lifetime of a run and releases it on drop,
/// so an early return, an error, or a panic can't leave the settings row
/// showing a run that has already stopped.
struct RunGuard;

impl RunGuard {
    /// `None` when another run already holds the slot — the caller should
    /// simply do nothing rather than queue behind it.
    fn claim(book_id: &str) -> Option<Self> {
        let mut running = RUNNING_BOOK.lock().ok()?;
        if running.is_some() {
            return None;
        }
        *running = Some(book_id.to_string());
        Some(Self)
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = RUNNING_BOOK.lock() {
            *running = None;
        }
    }
}

fn running_book() -> Option<String> {
    RUNNING_BOOK.lock().ok().and_then(|book| book.clone())
}

/// What the settings row renders. `failed` counts the `''` sentinel: chunks
/// the model was asked about and returned nothing usable for. They stay
/// searchable, so this is a degraded state, never an error.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextLineProgress {
    pub book_id: String,
    pub book_title: String,
    pub done: i64,
    pub total: i64,
    pub failed: i64,
    pub running: bool,
}

fn progress_for(db: &Db, book_id: &str, running: bool) -> AppResult<Option<ContextLineProgress>> {
    let conn = db.reader();
    let (total, done, failed): (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*),
                COUNT(CASE WHEN context_line IS NOT NULL AND context_line != '' THEN 1 END),
                COUNT(CASE WHEN context_line = '' THEN 1 END)
         FROM book_chunks WHERE book_id = ?1",
        params![book_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if total == 0 {
        return Ok(None);
    }
    let book_title: String = conn
        .query_row(
            "SELECT title FROM books WHERE id = ?1",
            params![book_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "Untitled".to_string());
    Ok(Some(ContextLineProgress {
        book_id: book_id.to_string(),
        book_title,
        done,
        total,
        failed,
        running,
    }))
}

/// What the settings row should show right now, or `None` for "show the
/// plain row". A live run wins; otherwise the most recently annotated book
/// that ended with gaps is offered, because that is the only state with an
/// action attached to it (Resume).
pub fn current_progress(db: &Db) -> AppResult<Option<ContextLineProgress>> {
    if let Some(book_id) = running_book() {
        return progress_for(db, &book_id, true);
    }
    let stalled: Option<String> = {
        let conn = db.reader();
        conn.query_row(
            "SELECT book_id FROM book_chunks
             WHERE context_line = ''
             GROUP BY book_id
             ORDER BY MAX(context_at) DESC
             LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?
    };
    match stalled {
        Some(book_id) => progress_for(db, &book_id, false),
        None => Ok(None),
    }
}

/// Clears the `''` sentinel for a book so its gaps become pending again.
/// Only ever called from the reader's own Resume button — the sentinel
/// exists precisely so an automatic run never retries these.
pub fn clear_failed_context_lines(db: &Db, book_id: &str) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "UPDATE book_chunks SET context_line = NULL WHERE book_id = ?1 AND context_line = ''",
        params![book_id],
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
    // Held for the whole run. A second caller for any book while one is in
    // flight backs off entirely rather than interleaving: these are
    // sequential provider calls, and two loops would double the spend.
    let Some(_guard) = RunGuard::claim(book_id) else {
        return Ok(());
    };
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
            JOB_ID,
        )
        .await?;
        let cleaned = clean_context_line(&completion.text);
        write_context_line(db, &row.id, &cleaned, &completion.model)?;
    }
    Ok(())
}

/// A real run against a real book and a real provider, kept out of the normal
/// suite because it needs both.
///
/// Everything else in this file tests a pure function. Nothing tests the one
/// thing that can only be answered by asking a model: whether the sentences
/// that come back are locators ("Elizabeth, at Longbourn, reading Jane's
/// letter about Lydia") or restatements of the passage that add no
/// discriminative power at all ("this passage describes a conversation").
/// The second kind is invisible in the UI — progress still reaches 100% —
/// which is exactly why it needs a test that prints what was written.
///
/// Run it with a book, a configured provider, and:
///
/// ```text
/// cargo test --manifest-path src-tauri/Cargo.toml \
///   live_context_lines_against_a_real_book -- --ignored --nocapture
/// ```
#[cfg(test)]
mod live_tests {
    use super::*;

    /// The reader's own app data, copied — never opened. `-wal` and `-shm`
    /// come along because the running app checkpoints lazily, and a copy of
    /// the main file alone would silently miss its most recent writes.
    fn copy_app_data(destination: &std::path::Path) -> Option<()> {
        let source = dirs_next_home()?.join("Library/Application Support/com.klaragraff.lantern");
        if !source.join("secrets.db").exists() {
            return None;
        }
        for name in [
            "lantern.db",
            "lantern.db-wal",
            "lantern.db-shm",
            "secrets.db",
        ] {
            let from = source.join(name);
            if from.exists() {
                std::fs::copy(&from, destination.join(name)).ok()?;
            }
        }
        Some(())
    }

    fn dirs_next_home() -> Option<std::path::PathBuf> {
        std::env::var_os("HOME").map(std::path::PathBuf::from)
    }

    /// Spread across the whole book rather than taken from the front: the
    /// opening chapters name everybody, so a sample drawn from them would
    /// flatter the feature exactly where it is needed least.
    const SAMPLE_SIZE: usize = 12;

    #[tokio::test]
    #[ignore = "needs a configured AI provider and spends real tokens; run manually"]
    async fn live_context_lines_against_a_real_book() {
        let directory = tempfile::TempDir::new().unwrap();
        let Some(()) = copy_app_data(directory.path()) else {
            panic!("no Lantern app data on this machine to copy");
        };

        let epub = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../harness/books/pride-and-prejudice.epub");
        assert!(epub.exists(), "missing {}", epub.display());
        std::fs::create_dir_all(directory.path().join("books")).unwrap();
        std::fs::copy(&epub, directory.path().join("books/pnp.epub")).unwrap();

        // Opens the *copy*, which is also where migration 050 runs.
        let db = Db::init(directory.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO books (
                     id, title, author, file_path, format, source_format, render_format,
                     source_file_path, source_sha256, status, progress, created_at, updated_at
                 ) VALUES ('pnp', 'Pride and Prejudice', 'Jane Austen', 'books/pnp.epub',
                           'epub', 'epub', 'epub', 'books/pnp.epub', 'pnp-source',
                           'unread', 0, '1970-01-01', '1970-01-01')",
                [],
            )
            .unwrap();
        }

        let status = super::super::index::ensure_index(&db, "pnp").unwrap();
        assert_eq!(status, super::super::index::IndexStatus::Ready, "index failed");

        // Every chunk in the copied database starts out pending, including
        // the reader's other books. Park them all, then un-park a spread of
        // this book's chunks — that sample is the whole run.
        let sampled: Vec<String> = {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE book_chunks SET context_line = '·'", []).unwrap();
            let total: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM book_chunks WHERE book_id = 'pnp'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            println!("\n=== Pride and Prejudice: {total} chunks, sampling {SAMPLE_SIZE} ===\n");
            let step = (total as usize / SAMPLE_SIZE).max(1);
            let mut ids = Vec::new();
            for index in 0..SAMPLE_SIZE {
                let offset = (index * step) as i64;
                let id: Option<String> = conn
                    .query_row(
                        "SELECT id FROM book_chunks WHERE book_id = 'pnp'
                         ORDER BY chunk_index LIMIT 1 OFFSET ?1",
                        params![offset],
                        |row| row.get(0),
                    )
                    .optional()
                    .unwrap();
                if let Some(id) = id {
                    conn.execute(
                        "UPDATE book_chunks SET context_line = NULL WHERE id = ?1",
                        params![&id],
                    )
                    .unwrap();
                    ids.push(id);
                }
            }
            ids
        };

        let secrets = Secrets::init(&directory.path().to_path_buf()).unwrap();
        let app = tauri::test::mock_app();
        let outcome = ensure_context_lines(app.handle(), &db, &secrets, "pnp").await;

        let conn = db.conn.lock().unwrap();
        for id in &sampled {
            let (text, line, model): (String, Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT text, context_line, context_model FROM book_chunks WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            let head: String = text.chars().take(110).collect();
            println!("PASSAGE  {}…", head.replace('\n', " "));
            match line.as_deref() {
                None => println!("CONTEXT  <never reached>"),
                Some("") => println!("CONTEXT  <empty — model returned nothing usable>"),
                Some(line) => println!("CONTEXT  {line}"),
            }
            println!("MODEL    {}\n", model.as_deref().unwrap_or("-"));
        }
        outcome.expect("the run itself failed");
    }
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
    fn clean_context_line_cuts_at_a_word_boundary_not_mid_word() {
        let long = format!("{} destined for her daughter", "word ".repeat(40));
        let cleaned = clean_context_line(&long);
        assert!(cleaned.chars().count() <= CONTEXT_LINE_MAX_CHARS);
        assert!(cleaned.ends_with("word"), "cut mid-word: {cleaned:?}");
    }

    #[test]
    fn clean_context_line_hard_cuts_when_no_boundary_is_near_the_cap() {
        // A single unbroken token longer than the cap: shortening it is
        // right, dropping the line entirely is not.
        let long = format!("start {}", "x".repeat(CONTEXT_LINE_MAX_CHARS + 50));
        assert_eq!(
            clean_context_line(&long).chars().count(),
            CONTEXT_LINE_MAX_CHARS
        );
    }

    #[test]
    fn clean_context_line_strips_the_locator_frames_the_prompt_forbids() {
        assert_eq!(
            clean_context_line("This passage falls near the end of Chapter 25."),
            "near the end of Chapter 25."
        );
        assert_eq!(
            clean_context_line("The passage is the title page of the book."),
            "the title page of the book."
        );
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
                "INSERT INTO settings (key, value)
                 VALUES ('auto_analysis_enabled_grounding_context', 'false')",
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
                "INSERT INTO settings (key, value)
                 VALUES ('auto_analysis_enabled_grounding_context', 'false')",
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
