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
/// How many chunks in a row may fail before the run gives up on the book.
/// Five, because the router has already retried each of those five itself:
/// reaching this count means five independently-retried calls failed back to
/// back, which is a provider that is down, not a network that stuttered.
/// A chunk that blanks on every attempt (see `CONTEXT_LINE_BLANK_RETRIES`)
/// feeds this same counter — it never raised a router error, but after
/// paying for retries that changed nothing it is a failed call in every
/// sense that matters.
const CONTEXT_LINE_FAILURE_BUDGET: usize = 5;
/// Extra attempts offered to a chunk whose cleaned line comes back empty
/// before it is accepted as a persistent blank. A full-corpus run against
/// *Pride and Prejudice* (598 chunks) produced 23 blanks; re-probing all 23
/// with one identical retry recovered 20 of them (`finish_reason: "stop"`,
/// well-formed sentences) — a blank is mostly a stochastic near-miss, not a
/// hard limit. The 3 that stayed blank were all `finish_reason: "length"`
/// chapter-opening chunks with no single scene to anchor a locator on, and
/// no number of retries fixed those, so this stays small rather than
/// growing to chase them.
const CONTEXT_LINE_BLANK_RETRIES: usize = 2;

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

/// The whole request for one chunk, assembled in one place.
///
/// Extracted from the run loop so that a measurement can drive these calls
/// itself — the shipped loop is strictly sequential, which is right for a
/// background job on a metered provider but turns a thousand-chunk book into a
/// multi-hour A/B — without rebuilding the prompt beside it. Two copies of this
/// assembly would mean the A/B measured a feature slightly different from the
/// shipped one, and the difference would be invisible in the report.
///
/// `prefix` is passed in rather than computed here because the loop caches it
/// per section: it depends only on the section, and rebuilding it per chunk
/// would re-join the same chapter text once for every chunk in it — and, worse,
/// risk sending bytes that differ run to run, which is what the provider's
/// prompt cache keys on.
fn context_line_messages(
    header: &str,
    prefix: &str,
    section_rows: &[&ChunkRow],
    row: &ChunkRow,
) -> Vec<ChatMessage> {
    let window = local_window(section_rows, row.chunk_index);
    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: CONTEXT_LINE_SYSTEM_PROMPT.to_string(),
    }];
    messages.extend(user_messages(header, prefix, &window, &row.text));
    messages
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

/// What asking the model for one chunk's line came back with, after any
/// blank-retry attempts inside `resolve_context_line`.
enum ContextLineOutcome {
    /// A line to store — `cleaned` is `""` when every attempt, including the
    /// retries, cleaned down to nothing. That's still written, as the `''`
    /// sentinel `pending_rows` already knows not to retry on a future run.
    Written { cleaned: String, model: String },
    /// The call itself failed (a router error) and the failure budget isn't
    /// spent yet. The chunk is left untouched and picked up by the next run,
    /// exactly as before this function existed.
    Skipped,
}

/// Ask the model for one chunk's line, retrying up to
/// `CONTEXT_LINE_BLANK_RETRIES` times when the cleaned result is blank.
/// `consecutive_failures` is the same counter `ensure_context_lines` uses to
/// decide when to give up on the book: a router error feeds it exactly as it
/// did before this function existed, and a blank that survives every retry
/// now feeds it too (see `CONTEXT_LINE_FAILURE_BUDGET`). A call that comes
/// back with real content — first try or on retry — resets it to zero,
/// same as before.
#[allow(clippy::too_many_arguments)]
async fn resolve_context_line<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    messages: &[ChatMessage],
    chunk_id: &str,
    consecutive_failures: &mut usize,
) -> AppResult<ContextLineOutcome> {
    let mut blank_attempts = 0usize;
    loop {
        let completion = router::complete_with_failover(
            app,
            db,
            secrets,
            messages,
            Some(120),
            AiRequestPurpose::Utility,
            AiRetryMode::Automatic,
            None,
            None,
            "auto",
            JOB_ID,
        )
        .await;
        let completion = match completion {
            Ok(completion) => completion,
            Err(error) => {
                *consecutive_failures += 1;
                if *consecutive_failures >= CONTEXT_LINE_FAILURE_BUDGET {
                    return Err(error);
                }
                log::warn!(
                    "context line for chunk {chunk_id} failed ({}/{CONTEXT_LINE_FAILURE_BUDGET}): {error}",
                    *consecutive_failures
                );
                return Ok(ContextLineOutcome::Skipped);
            }
        };
        let cleaned = clean_context_line(&completion.text);
        if !cleaned.is_empty() {
            *consecutive_failures = 0;
            return Ok(ContextLineOutcome::Written {
                cleaned,
                model: completion.model,
            });
        }
        if blank_attempts >= CONTEXT_LINE_BLANK_RETRIES {
            *consecutive_failures += 1;
            log::warn!(
                "context line for chunk {chunk_id} still blank after {} attempts ({}/{CONTEXT_LINE_FAILURE_BUDGET})",
                blank_attempts + 1,
                *consecutive_failures
            );
            if *consecutive_failures >= CONTEXT_LINE_FAILURE_BUDGET {
                return Err(AppError::Other(format!(
                    "context line for chunk {chunk_id} returned blank after {} attempts",
                    blank_attempts + 1
                )));
            }
            return Ok(ContextLineOutcome::Written {
                cleaned,
                model: completion.model,
            });
        }
        blank_attempts += 1;
        log::warn!(
            "context line for chunk {chunk_id} came back blank, retrying ({blank_attempts}/{CONTEXT_LINE_BLANK_RETRIES})"
        );
    }
}

/// Write an identity sentence for every chunk in `book_id` that doesn't have
/// one yet. Resumable: each chunk is written as soon as its own call
/// succeeds.
///
/// Two different things can go wrong with a call, and they're handled
/// differently — see `resolve_context_line`. A router error means the call
/// itself failed; `ai::router` has already tried failover and cooldowns
/// before giving up, so retrying the same chunk here wouldn't help. That
/// chunk is skipped — left as `context_line IS NULL`, so the next run picks
/// it back up — and counts against `CONTEXT_LINE_FAILURE_BUDGET`, a budget
/// shared across the whole run: hitting it aborts everything and returns the
/// error, on the theory that several failures back to back mean a provider
/// that's down, not one bad chunk. A blank cleaned line is not a router
/// error — the call succeeded, the model just returned nothing usable — and
/// is usually a stochastic near-miss, so it gets retried immediately, up to
/// `CONTEXT_LINE_BLANK_RETRIES` times. Only a blank that survives every
/// retry is written as the `''` sentinel (tried, nothing usable, never
/// retried again), and that also counts against the same failure budget:
/// after paying for retries that changed nothing, it is a failed call in
/// every sense that matters.
///
/// `progress` is called with `(done, total)` counted over the *whole book*
/// rather than over this run's pending set, so a resumed run opens at
/// "480 / 642" instead of restarting from zero. `done` here means "chunks
/// that no longer need asking about", which includes the ones the model
/// returned nothing usable for — those are stored as the `''` sentinel and
/// deliberately never retried, so a counter that excluded them would stall
/// short of its total forever and read as a hang. (`current_progress`, which
/// feeds the settings row, splits those out into its own `failed` count
/// instead; that row has the space to explain them and this one number does
/// not.) A chunk skipped by a failed call is not counted: it stays pending
/// and the next run picks it up.
pub async fn ensure_context_lines<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    book_id: &str,
    progress: Option<super::ProgressFn<'_>>,
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
    // A few hundred sequential network calls will hit a hiccup. Losing the
    // whole book to one of them is the wrong trade: each line is written the
    // moment it comes back, and `pending_rows` skips what is already written,
    // so a skipped chunk costs nothing but a retry on the next pass. What must
    // still fail fast is the other shape — a revoked key, a provider that is
    // down — where every call will fail and retrying is just burning the
    // reader's battery. Consecutive failures tell the two apart: a flaky
    // network recovers within a call or two, a broken provider never does.
    let mut consecutive_failures = 0usize;
    let pending = pending_rows(&rows);
    let total = rows.len();
    let mut done = total - pending.len();
    if let Some(progress) = progress.filter(|_| !pending.is_empty()) {
        progress(done, total);
    }
    for row in pending {
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
        let messages = context_line_messages(&header, &prefix, section_rows, row);
        let outcome =
            resolve_context_line(app, db, secrets, &messages, &row.id, &mut consecutive_failures)
                .await?;
        let (cleaned, model) = match outcome {
            ContextLineOutcome::Written { cleaned, model } => (cleaned, model),
            ContextLineOutcome::Skipped => continue,
        };
        write_context_line(db, &row.id, &cleaned, &model)?;
        done += 1;
        if let Some(progress) = progress {
            progress(done, total);
        }
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
///
/// Which book is a `LANTERN_LIVE_BOOK` away — see [`LIVE_BOOKS`]. It defaults
/// to the one the first run used, so the command above still means what it did.
#[cfg(test)]
mod live_tests {
    use super::*;

    use futures::StreamExt;

    use super::super::live_data::copy_app_data;

    /// One measured question. `gold` is a verbatim phrase from the passage
    /// that ought to answer it — the phrase is only a handle for finding the
    /// chunk, never part of the query, so the search is not being told the
    /// answer.
    struct AbQuery {
        /// What a reader would type. Deliberately names people, because
        /// readers do — that is the whole premise: the reader knows the name,
        /// the passage only says "he".
        query: &'static str,
        gold: &'static str,
        /// `pronoun` — the target passage is thin on proper nouns, which is
        /// what the feature is for. `named` — the target passage says the
        /// names itself, so lexical search already had everything it needed.
        /// The second group is the one that can only get worse; a report
        /// showing only the first would not be a measurement.
        kind: &'static str,
    }

    /// A book these runs know how to stage.
    ///
    /// One book was never a measurement. The first A/B ran on Pride and
    /// Prejudice with 11 queries and turned up a single regression that fell
    /// *below its own baseline* — the one observation that could overturn the
    /// whole change, and at n=1 indistinguishable from noise. Hence a list.
    struct LiveBook {
        /// Doubles as the book id in the copied database and the staged
        /// filename, so a run's rows are easy to find afterwards.
        id: &'static str,
        epub: &'static str,
        title: &'static str,
        author: &'static str,
        queries: &'static [AbQuery],
    }

    const LIVE_BOOKS: &[LiveBook] = &[
        LiveBook {
            id: "pnp",
            epub: "pride-and-prejudice.epub",
            title: "Pride and Prejudice",
            author: "Jane Austen",
            queries: PNP_QUERIES,
        },
        LiveBook {
            id: "jane-eyre",
            epub: "jane-eyre.epub",
            title: "Jane Eyre",
            author: "Charlotte Brontë",
            queries: JANE_EYRE_QUERIES,
        },
        LiveBook {
            id: "moby-dick",
            epub: "moby-dick.epub",
            title: "Moby-Dick",
            author: "Herman Melville",
            queries: MOBY_DICK_QUERIES,
        },
    ];

    /// Which book this run measures. Defaults to the book the first run used.
    fn selected_book() -> &'static LiveBook {
        let want = std::env::var("LANTERN_LIVE_BOOK").unwrap_or_else(|_| "pnp".to_string());
        LIVE_BOOKS
            .iter()
            .find(|book| book.id == want)
            .unwrap_or_else(|| {
                let known: Vec<&str> = LIVE_BOOKS.iter().map(|book| book.id).collect();
                panic!("LANTERN_LIVE_BOOK={want} is not one of {known:?}")
            })
    }

    /// Copies the epub in, registers it, and indexes it.
    ///
    /// Chunking is entirely local — staging a book spends nothing, which is
    /// what lets `every_ab_query_anchor_resolves_to_one_chunk` run in the
    /// normal suite.
    /// Where the harness keeps its books. They are gitignored — `harness/books/README.md`
    /// says how to fetch them — so anything in the normal suite has to treat a
    /// missing file as "not here", not as a failure.
    fn harness_epub(book: &LiveBook) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../harness/books")
            .join(book.epub)
    }

    fn stage_book(directory: &std::path::Path, book: &LiveBook) -> Db {
        let epub = harness_epub(book);
        assert!(epub.exists(), "missing {}", epub.display());
        let staged = format!("books/{}.epub", book.id);
        std::fs::create_dir_all(directory.join("books")).unwrap();
        std::fs::copy(&epub, directory.join(&staged)).unwrap();

        // Opens the *copy*, which is also where the migrations run.
        let db = Db::init(directory).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO books (
                     id, title, author, file_path, format, source_format, render_format,
                     source_file_path, source_sha256, status, progress, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'epub', 'epub', 'epub', ?4, ?5,
                           'unread', 0, '1970-01-01', '1970-01-01')",
                params![
                    book.id,
                    book.title,
                    book.author,
                    &staged,
                    format!("{}-source", book.id)
                ],
            )
            .unwrap();
        }
        assert_eq!(
            super::super::index::ensure_index(&db, book.id).unwrap(),
            super::super::index::IndexStatus::Ready,
            "indexing failed for {}",
            book.id
        );
        db
    }

    /// Spread across the whole book rather than taken from the front: the
    /// opening chapters name everybody, so a sample drawn from them would
    /// flatter the feature exactly where it is needed least.
    const SAMPLE_SIZE: usize = 12;

    #[tokio::test]
    #[ignore = "needs a configured AI provider and spends real tokens; run manually"]
    async fn live_context_lines_against_a_real_book() {
        let book = selected_book();
        let directory = tempfile::TempDir::new().unwrap();
        let Some(()) = copy_app_data(directory.path()) else {
            panic!("no Lantern app data on this machine to copy");
        };
        let db = stage_book(directory.path(), book);

        // Every chunk in the copied database starts out pending, including
        // the reader's other books. Park them all, then un-park a spread of
        // this book's chunks — that sample is the whole run.
        let sampled: Vec<String> = {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE book_chunks SET context_line = '·'", []).unwrap();
            let total: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM book_chunks WHERE book_id = ?1",
                    params![book.id],
                    |row| row.get(0),
                )
                .unwrap();
            println!(
                "\n=== {}: {total} chunks, sampling {SAMPLE_SIZE} ===\n",
                book.title
            );
            let step = (total as usize / SAMPLE_SIZE).max(1);
            let mut ids = Vec::new();
            for index in 0..SAMPLE_SIZE {
                let offset = (index * step) as i64;
                let id: Option<String> = conn
                    .query_row(
                        "SELECT id FROM book_chunks WHERE book_id = ?1
                         ORDER BY chunk_index LIMIT 1 OFFSET ?2",
                        params![book.id, offset],
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
        let outcome = ensure_context_lines(app.handle(), &db, &secrets, book.id, None).await;

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

    /// Written in the book's own language, not the reader's. Keyword search
    /// matches tokens: a Chinese question against an English book shares
    /// nothing with it but the proper nouns, so a cross-language arm would
    /// measure the tokenizer rather than the feature. Closing that gap is the
    /// vector path's job, not this one's.
    const PNP_QUERIES: &[AbQuery] = &[
        AbQuery {
            query: "Darcy proposes to Elizabeth for the first time and she turns him down",
            gold: "In vain have I struggled",
            kind: "pronoun",
        },
        AbQuery {
            query: "Elizabeth realises she was wrong about Wickham after reading the letter",
            gold: "never knew myself",
            kind: "pronoun",
        },
        AbQuery {
            query: "Mr Collins asks Elizabeth to marry him",
            gold: "my reasons for marrying are",
            kind: "pronoun",
        },
        AbQuery {
            query: "Lady Catherine confronts Elizabeth about her engagement to Darcy",
            gold: "obstinate, headstrong girl",
            kind: "pronoun",
        },
        AbQuery {
            query: "Elizabeth sees the grounds of Pemberley for the first time",
            gold: "never seen a place for which nature had done more",
            kind: "pronoun",
        },
        AbQuery {
            query: "Darcy proposes a second time and Elizabeth accepts him",
            gold: "affections and wishes are unchanged",
            kind: "pronoun",
        },
        AbQuery {
            query: "Darcy refuses to dance with Elizabeth at the assembly",
            gold: "not handsome enough to tempt me",
            kind: "pronoun",
        },
        AbQuery {
            query: "Lydia has run away with Wickham",
            gold: "certainly not gone to Scotland",
            kind: "pronoun",
        },
        AbQuery {
            query: "Mrs Bennet tells her husband that Netherfield has been taken",
            gold: "Netherfield Park is let at last",
            kind: "named",
        },
        AbQuery {
            query: "Mr Bennet stops Mary singing at the ball",
            gold: "You have delighted us long enough",
            kind: "named",
        },
        AbQuery {
            query: "Mr Collins reads a volume of sermons aloud to the Bennets",
            gold: "Fordyce",
            kind: "named",
        },
    ];

    /// Chosen for the pronoun problem in its purest form: first person
    /// throughout, so the narrator is "I" and everyone else is "he"/"she"
    /// for pages at a stretch, exactly the passage a reader searches for by
    /// name and the passage least likely to contain one.
    ///
    /// A note that cost the authoring pass several silent misses: this epub
    /// writes `Mr.`/`Mrs.`/`St.` with a non-breaking space before the surname,
    /// so an anchor spanning that boundary matches nothing. Every anchor here
    /// starts at the bare name instead.
    const JANE_EYRE_QUERIES: &[AbQuery] = &[
        AbQuery {
            query: "How does Jane describe John Reed's eating habits and appearance as a boy at Gateshead?",
            gold: "He gorged himself habitually at table, which made him bilious",
            kind: "pronoun",
        },
        AbQuery {
            query: "How was Mrs. Reed positioned in the drawing room with her children on the afternoon Jane was excluded from the group?",
            gold: "she lay reclined on a sofa by the fireside",
            kind: "pronoun",
        },
        AbQuery {
            query: "What did Bessie and Miss Abbot do when Jane tried to spring up off the stool in the red room?",
            gold: "their two pair of hands arrested me instantly",
            kind: "pronoun",
        },
        AbQuery {
            query: "Which of the Reed children does Jane say she felt physically inferior to at the start of the novel?",
            gold: "Eliza, John, and Georgiana Reed",
            kind: "named",
        },
        AbQuery {
            query: "How old was John Reed and how is he first described physically in the opening chapter?",
            gold: "John Reed was a schoolboy of fourteen",
            kind: "named",
        },
        AbQuery {
            query: "What did Jane imagine Helen Burns was thinking about while she stood being punished in front of the class?",
            gold: "she is looking at what she can remember",
            kind: "pronoun",
        },
        AbQuery {
            query: "How did Miss Temple first appear to Jane as she walked to the front of the schoolroom at Lowood?",
            gold: "surveyed the two rows of girls silently",
            kind: "pronoun",
        },
        AbQuery {
            query: "How did Jane first recognize Mr Brocklehurst approaching the schoolroom before she could see his face clearly?",
            gold: "I recognised almost instinctively that gaunt outline",
            kind: "pronoun",
        },
        AbQuery {
            query: "What did Helen Burns do when Jane whispered to her in the middle of the night in Miss Temple's room?",
            gold: "She stirred herself, put back the curtain",
            kind: "pronoun",
        },
        AbQuery {
            query: "What did Helen Burns say to Miss Smith right after passing Jane while Jane stood on the stool of shame?",
            gold: "Helen Burns asked some slight question about her work",
            kind: "named",
        },
        AbQuery {
            query: "What is Miss Temple's full first name, and how did Jane learn it?",
            gold: "Maria Temple, as I afterwards saw the name",
            kind: "named",
        },
        AbQuery {
            query: "How does Jane describe the stranger's face when she first meets Rochester after his horse slips on the icy road near Thornfield?",
            gold: "He had a dark face, with stern features and a heavy brow",
            kind: "pronoun",
        },
        AbQuery {
            query: "What did Rochester say to Jane to get her to move out of his way while he tried to remount his horse on the icy lane?",
            gold: "You must just stand on one side",
            kind: "pronoun",
        },
        AbQuery {
            query: "How did Rochester move through the gallery on the night Jane heard the strange laugh outside her bedroom door?",
            gold: "He passed up the gallery very softly",
            kind: "pronoun",
        },
        AbQuery {
            query: "How did Rochester react right after Jane finished telling him about the curtain fire in his room?",
            gold: "he did not immediately speak when I had concluded",
            kind: "pronoun",
        },
        AbQuery {
            query: "How did Jane describe Mr Mason's condition as he sat wounded and bleeding in the hidden room upstairs at Thornfield?",
            gold: "he was still; his head leant back; his eyes were closed",
            kind: "pronoun",
        },
        AbQuery {
            query: "How did Rochester approach Jane in the orchard just before he proposed to her?",
            gold: "He rose, and with a stride reached me",
            kind: "pronoun",
        },
        AbQuery {
            query: "How did Rochester look and act right after Jane accepted his proposal in the orchard?",
            gold: "very much agitated and very much flushed",
            kind: "pronoun",
        },
        AbQuery {
            query: "How did Rochester stand and react in the church when Mr Briggs interrupted the wedding to reveal his existing marriage?",
            gold: "he stood stubborn and rigid",
            kind: "pronoun",
        },
        AbQuery {
            query: "How does Jane describe Bertha Mason's build and strength during the struggle when she attacked her brother?",
            gold: "She was a big woman, in stature almost equalling her husband",
            kind: "pronoun",
        },
        AbQuery {
            query: "What did the gypsy fortune teller do with the fire while reading Jane's palm during the party at Thornfield, before Jane realized it was Rochester in disguise?",
            gold: "She stirred the fire, so that a ripple of light broke from the disturbed coal",
            kind: "pronoun",
        },
        AbQuery {
            query: "According to Adele, how did Rochester bring her ashore from the ship when they landed in a foreign port?",
            gold: "Rochester carried me in his arms over a plank to the land",
            kind: "named",
        },
        AbQuery {
            query: "In what state did Jane find Rochester in his bed just before she woke him during the curtain fire?",
            gold: "Rochester lay stretched motionless, in deep sleep",
            kind: "named",
        },
        AbQuery {
            query: "How did Rochester arrive in the gallery right after Mr Mason was attacked in the night?",
            gold: "Rochester advanced with a candle",
            kind: "named",
        },
        AbQuery {
            query: "What does Rochester tell his wedding guests about Bertha Mason's family and her sanity?",
            gold: "Bertha Mason is mad; and she came of a mad family",
            kind: "named",
        },
        AbQuery {
            query: "How does Jane describe the voice that cried her name across the moors the night before she decided to leave Moor House and search for Rochester?",
            gold: "the voice of a human being",
            kind: "pronoun",
        },
        AbQuery {
            query: "What did St John Rivers say to Jane about death and suffering just after he found her collapsed outside Moor House?",
            gold: "all are not condemned to meet a lingering",
            kind: "pronoun",
        },
        AbQuery {
            query: "How did Jane describe Diana Rivers's countenance when she looked at her right after being taken in at Moor House?",
            gold: "instinct both with power and goodness",
            kind: "pronoun",
        },
        AbQuery {
            query: "How did Jane first describe Rosamond Oliver's appearance when she arrived at the garden gate to meet St John?",
            gold: "a form clad in pure white",
            kind: "pronoun",
        },
        AbQuery {
            query: "What did St John Rivers do with his foot while telling Rosamond Oliver it was too late for her to be out alone?",
            gold: "crushed the snowy heads of the closed flowers",
            kind: "pronoun",
        },
        AbQuery {
            query: "Which of the Rivers sisters spoke up to ask Jane if they had now given her all the aid she required?",
            gold: "Diana took the word",
            kind: "named",
        },
        AbQuery {
            query: "How does Jane first identify Rosamond Oliver to herself after the young woman asks about Alice Wood?",
            gold: "is Miss Oliver, the heiress",
            kind: "named",
        },
        AbQuery {
            query: "What phrase does Diana Rivers use to sum up her brother St John's character after Jane witnesses his encounter with Rosamond Oliver?",
            gold: "Diana Rivers had designated her brother",
            kind: "named",
        },
        AbQuery {
            query: "How did Jane first spot Rochester when she arrived at Ferndean in the rainy twilight, before she recognized him?",
            gold: "a man without a hat",
            kind: "pronoun",
        },
        AbQuery {
            query: "How was Rochester described sitting by the fire in the parlour just before Jane brought him his glass of water at Ferndean?",
            gold: "appeared the blind tenant of the room",
            kind: "pronoun",
        },
        AbQuery {
            query: "How does Jane identify the figure who steps out of the house at Ferndean the moment she first sees him in the twilight?",
            gold: "my master, Edward Fairfax Rochester, and no other",
            kind: "named",
        },
    ];

    /// Chosen for the chapters with nobody in them. Cetology, the whiteness
    /// of the whale, the try-works, the lamp — long expository stretches where
    /// "he" is the whale or a generic whaleman and a proper noun can be pages
    /// away. Six of the `pronoun` rows target those on purpose, and two more
    /// target the opening of a chapter that skips forward in time, which is the
    /// shape that produced every one of the three stubbornly blank lines in the
    /// Pride and Prejudice run.
    ///
    /// Known gap: the Town-Ho's story is unrepresented. The authoring pass read
    /// a list of example names as a closed roster and dropped Radney and
    /// Steelkilt rather than spend rows outside it.
    const MOBY_DICK_QUERIES: &[AbQuery] = &[
        AbQuery {
            query: "The morning after Ishmael first wakes up sharing a bed with Queequeg, what does he notice covering Queequeg's arm?",
            gold: "tattooed all over with an interminable Cretan labyrinth",
            kind: "pronoun",
        },
        AbQuery {
            query: "When Ishmael introduces Starbuck as the chief mate, how does he describe Starbuck's body being suited to hot climates?",
            gold: "seemed well adapted to endure hot latitudes",
            kind: "pronoun",
        },
        AbQuery {
            query: "What does Stubb do with an old tune even while he's in the middle of a dangerous whale fight?",
            gold: "hum over his old rigadig tunes",
            kind: "pronoun",
        },
        AbQuery {
            query: "In the chapter where Ahab first appears after several days hidden in his cabin, how is his burned face and body described?",
            gold: "cut away from the stake",
            kind: "pronoun",
        },
        AbQuery {
            query: "Some days after Ahab's first appearance, how does the old man make his way up from the cabin at night to the deck?",
            gold: "to help his crippled way",
            kind: "pronoun",
        },
        AbQuery {
            query: "In the Cetology chapter, how does Ishmael define what makes a creature a whale rather than an ordinary fish?",
            gold: "a spouting fish with a horizontal tail",
            kind: "pronoun",
        },
        AbQuery {
            query: "In The Whiteness of the Whale, what legendary status does Ishmael give the White Steed of the Prairies among wild horses?",
            gold: "elected Xerxes of vast herds of wild horses",
            kind: "pronoun",
        },
        AbQuery {
            query: "When Fedallah is first introduced to the crew, what does Ishmael say stays unexplained about him for the rest of the voyage?",
            gold: "remained a muffled mystery to the last",
            kind: "pronoun",
        },
        AbQuery {
            query: "In The Fountain chapter, how does Ishmael sum up the sperm whale's overall character or bearing?",
            gold: "He is both ponderous and profound",
            kind: "pronoun",
        },
        AbQuery {
            query: "In The Tail chapter, what gentle motion does Ishmael describe the whale making with its flukes when it feels a sailor's whisker?",
            gold: "moves his immense flukes from side to side",
            kind: "pronoun",
        },
        AbQuery {
            query: "During the whale hunt in Stubb Kills a Whale, what is Stubb's lance secretly seeking as he churns it into the whale?",
            gold: "was the innermost life of the fish",
            kind: "pronoun",
        },
        AbQuery {
            query: "After Pip is rescued half-mad from being left alone in the ocean, what does he claim to have seen upon a loom in the depths?",
            gold: "upon the treadle of the loom",
            kind: "pronoun",
        },
        AbQuery {
            query: "In The Try-Works chapter, what does Ishmael say the whale itself provides to keep the trying-out fire burning?",
            gold: "the whale supplies his own fuel",
            kind: "pronoun",
        },
        AbQuery {
            query: "In The Lamp chapter, how does Ishmael contrast the ordinary sailor's darkness with how the whaleman experiences light?",
            gold: "so he lives in light",
            kind: "pronoun",
        },
        AbQuery {
            query: "In The First Lowering, when Ahab first calls out to Fedallah before the chase, how loud does Ishmael say his voice was?",
            gold: "the thunder of his voice",
            kind: "pronoun",
        },
        AbQuery {
            query: "As Queequeg lies dying of fever in his coffin chapter, what does Ishmael notice happening to his eyes even as the rest of him wastes away?",
            gold: "seemed growing fuller and fuller",
            kind: "pronoun",
        },
        AbQuery {
            query: "During Starbuck's tormented soliloquy over the loaded musket in the typhoon, what does he fear Ahab is willing to do to his own crew?",
            gold: "he would fain kill all his crew",
            kind: "pronoun",
        },
        AbQuery {
            query: "In The Symphony, as Starbuck approaches him at the rail, how is Ahab described leaning over the side of the ship?",
            gold: "how he heavily leaned over the side",
            kind: "pronoun",
        },
        AbQuery {
            query: "During the corpusants scene in The Candles, how is Fedallah positioned kneeling in front of Ahab at the base of the mainmast?",
            gold: "with his head bowed away from him",
            kind: "pronoun",
        },
        AbQuery {
            query: "On the third day of the chase, what does Starbuck murmur about the whale's direction as the ship comes about?",
            gold: "he now steers for the open jaw",
            kind: "pronoun",
        },
        AbQuery {
            query: "During the hiring negotiation in The Ship, what does Peleg insist Ishmael deserves regarding his pay lay?",
            gold: "he must have more than that",
            kind: "pronoun",
        },
        AbQuery {
            query: "In Stubb's comic dream in Queen Mab, what does Stubb say the old man Ahab did to him with his ivory leg?",
            gold: "well I dreamed he kicked me with it",
            kind: "pronoun",
        },
        AbQuery {
            query: "In A Bosom Friend, while Ishmael studies Queequeg counting the pages of a book, how does Queequeg react to being watched?",
            gold: "he never heeded my presence",
            kind: "pronoun",
        },
        AbQuery {
            query: "In Starbuck's Dusk soliloquy, what does Starbuck say about how Ahab dominates everyone beneath him on the ship?",
            gold: "how he lords it over all below",
            kind: "pronoun",
        },
        AbQuery {
            query: "What is the very first line the narrator gives about his own name at the start of Moby Dick?",
            gold: "Call me Ishmael",
            kind: "named",
        },
        AbQuery {
            query: "In the Spouter-Inn, what is Queequeg doing with his pipe when he first grunts at Ishmael from the bed?",
            gold: "puffing away at his pipe",
            kind: "named",
        },
        AbQuery {
            query: "How does Ishmael compare Queequeg's head to a famous American historical figure in A Bosom Friend?",
            gold: "Queequeg was George Washington cannibalistically developed",
            kind: "named",
        },
        AbQuery {
            query: "What does Ishmael say about Stubb's rank and origin when introducing him as the second mate?",
            gold: "Stubb was the second mate",
            kind: "named",
        },
        AbQuery {
            query: "During the chase in Stubb Kills a Whale, where does Stubb keep his position relative to the other boats?",
            gold: "Stubb retaining his place in the van",
            kind: "named",
        },
        AbQuery {
            query: "When Ahab finally appears on deck after days of hiding, how does Ishmael describe him standing there?",
            gold: "Captain Ahab stood upon his quarterdeck",
            kind: "named",
        },
        AbQuery {
            query: "In The Doubloon, what does Ahab say the firm tower carved on the coin represents about himself?",
            gold: "The firm tower, that is Ahab",
            kind: "named",
        },
        AbQuery {
            query: "When Captain Gardiner of the Rachel begs Ahab to help search for his lost son, what is Ahab's blunt reply?",
            gold: "Captain Gardiner, I will not do it",
            kind: "named",
        },
        AbQuery {
            query: "In The Doubloon, how does Ishmael describe Fedallah's tail as he approaches the coin?",
            gold: "tail coiled out of sight as usual",
            kind: "named",
        },
        AbQuery {
            query: "After their tense confrontation in the cabin, what does Ahab quietly say to Starbuck out on deck?",
            gold: "Thou art but too good a fellow, Starbuck",
            kind: "named",
        },
        AbQuery {
            query: "What does Ishmael say about Starbuck's role and hometown when introducing him as chief mate?",
            gold: "The chief mate of the Pequod was Starbuck",
            kind: "named",
        },
        AbQuery {
            query: "During the rowdy midnight dance on the forecastle, what warning is shouted at Pip as the royal yard swings?",
            gold: "Duck lower, Pip, here comes the royal yard",
            kind: "named",
        },
    ];

    /// How deep to look for the gold chunk before calling it unfound. Chat
    /// only ever sees `RETRIEVAL_TOP_K`; the deeper window exists so a
    /// passage that moved from 40th to 3rd reports as exactly that rather
    /// than as "absent → 3rd", which would overstate the gain.
    const AB_DEPTH: usize = 50;

    /// The lexical query the shipped code runs, with one knob: `context_on`
    /// false restricts `MATCH` to the passage column, which is precisely the
    /// world before `seg_context` existed. Same index, same rows, same
    /// tokenizer — the only difference between the two arms is whether the
    /// identity sentence is allowed to be seen.
    fn ab_ranks(
        conn: &Connection,
        book_id: &str,
        query_text: &str,
        context_on: bool,
    ) -> Vec<String> {
        let terms = super::super::segment::segment_for_fts(
            query_text,
            super::super::segment::SegmentMode::Query,
        )
        .split_whitespace()
        .filter(|token| token.chars().count() >= 2)
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
        if terms.is_empty() {
            return Vec::new();
        }
        let query = if context_on {
            terms
        } else {
            format!("seg_text : ({terms})")
        };
        let weights = if context_on { "1.0, 0.3" } else { "1.0, 0.0" };
        conn.prepare(&format!(
            "SELECT book_chunks_fts.chunk_id,
                    bm25(book_chunks_fts, {weights}, 0.0, 0.0) AS score
             FROM book_chunks_fts
             WHERE book_chunks_fts MATCH ?1 AND book_chunks_fts.book_id = ?2
             ORDER BY score LIMIT ?3"
        ))
        .unwrap()
        .query_map(params![query, book_id, AB_DEPTH as i64], |row| {
            row.get::<_, String>(0)
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    /// How many chunks the measurement asks about at once.
    ///
    /// The shipped loop asks about one at a time on purpose — it runs in the
    /// background against a metered provider, and the reader's only brake is a
    /// switch it re-reads every iteration. That is the right trade for a
    /// background job and the wrong one for a measurement: a 928-chunk book at
    /// several seconds a call is most of a working day, and the A/B needs every
    /// chunk done, distractors included. Sampling is not an option — measuring
    /// only the gold chunks is the caliber that overstated this feature's gains
    /// by 2–4× and must not be repeated.
    ///
    /// Whether the shipped loop should also run concurrently is a separate
    /// question, and not this file's to answer: it changes how long a reader
    /// waits for an index and how concentrated the spend is.
    const GENERATE_CONCURRENCY: usize = 8;

    /// The same calls `ensure_context_lines` makes, in flight several at a time.
    ///
    /// Reuses `context_line_messages` and `resolve_context_line`, so the prompt
    /// and the blank-retry behaviour are the shipped ones. Two things are
    /// deliberately not reproduced: the run guard, which exists to stop two
    /// loops doubling a reader's spend, and the failure budget shared across the
    /// whole book — each task here carries its own counter, so a provider that
    /// dies mid-run shows up as many skipped chunks rather than one aborted run.
    /// Both are about protecting a reader who is not present.
    async fn generate_context_lines_concurrently<R: Runtime>(
        app: &AppHandle<R>,
        db: &Db,
        secrets: &Secrets,
        book_id: &str,
    ) -> usize {
        let (book_title, rows) = load_chunk_rows(db, book_id).unwrap();
        let mut sections: std::collections::BTreeMap<i64, Vec<&ChunkRow>> =
            std::collections::BTreeMap::new();
        for row in &rows {
            sections.entry(row.section_index).or_default().push(row);
        }
        // Built once per section, exactly as the shipped loop's cache does, so
        // the bytes that reach the provider are identical run to run and its
        // prompt cache actually fires.
        let prefixes: std::collections::BTreeMap<i64, String> = sections
            .iter()
            .map(|(index, section_rows)| (*index, chapter_prefix(section_rows)))
            .collect();

        let pending = pending_rows(&rows);
        let total = pending.len();
        let done = std::sync::atomic::AtomicUsize::new(0);
        let written = std::sync::atomic::AtomicUsize::new(0);
        futures::stream::iter(pending.into_iter().map(|row| {
            let sections = &sections;
            let prefixes = &prefixes;
            let book_title = &book_title;
            let done = &done;
            let written = &written;
            async move {
                let section_rows = sections.get(&row.section_index).expect("row's own section");
                let header =
                    chapter_header(book_title, row.section_index, row.section_title.as_deref());
                let messages = context_line_messages(
                    &header,
                    prefixes.get(&row.section_index).expect("row's own section"),
                    section_rows,
                    row,
                );
                let mut failures = 0usize;
                match resolve_context_line(app, db, secrets, &messages, &row.id, &mut failures).await
                {
                    Ok(ContextLineOutcome::Written { cleaned, model }) => {
                        write_context_line(db, &row.id, &cleaned, &model).unwrap();
                        written.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    Ok(ContextLineOutcome::Skipped) => {}
                    Err(error) => println!("chunk {} failed: {error}", row.id),
                }
                let at = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                if at.is_multiple_of(50) || at == total {
                    println!("  {at}/{total}");
                }
            }
        }))
        .buffer_unordered(GENERATE_CONCURRENCY)
        .collect::<Vec<()>>()
        .await;
        written.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn rank_of(ranks: &[String], chunk_id: &str) -> Option<usize> {
        ranks.iter().position(|id| id == chunk_id).map(|at| at + 1)
    }

    fn rank_label(rank: Option<usize>) -> String {
        match rank {
            Some(at) => format!("#{at}"),
            None => format!("未进前 {AB_DEPTH}"),
        }
    }

    /// Generates identity sentences for a whole real book, then measures what
    /// they actually did to keyword retrieval.
    ///
    /// Separate from the sampling test above because it costs a whole book of
    /// provider calls. It writes a report next to the repo rather than only
    /// printing, because the thing worth reviewing is the before/after table
    /// and the cards, not a scrollback.
    #[tokio::test]
    #[ignore = "generates context lines for an entire book; spends real tokens"]
    async fn live_retrieval_ab_against_a_real_book() {
        let book = selected_book();
        let directory = tempfile::TempDir::new().unwrap();
        let Some(()) = copy_app_data(directory.path()) else {
            panic!("no Lantern app data on this machine to copy");
        };
        let db = stage_book(directory.path(), book);

        // Park every other book's chunks so the run cannot wander into the
        // reader's own library and bill them for it.
        let total: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE book_chunks SET context_line = '·' WHERE book_id <> ?1",
                params![book.id],
            )
            .unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM book_chunks WHERE book_id = ?1",
                params![book.id],
                |row| row.get(0),
            )
            .unwrap()
        };
        println!(
            "=== {}: generating identity sentences for {total} chunks ===",
            book.title
        );

        // Measured before anything is generated: at this point `seg_context`
        // is empty for every row, so both arms must agree. Any difference
        // here would mean the two arms differ by something other than the
        // feature, and the whole table below would be measuring that instead.
        let baseline_disagreements = {
            let conn = db.conn.lock().unwrap();
            book.queries
                .iter()
                .filter(|case| {
                    ab_ranks(&conn, book.id, case.query, false)
                        != ab_ranks(&conn, book.id, case.query, true)
                })
                .count()
        };
        assert_eq!(
            baseline_disagreements, 0,
            "the two arms already disagree before any context line exists"
        );

        let secrets = Secrets::init(&directory.path().to_path_buf()).unwrap();
        let app = tauri::test::mock_app();
        let started = std::time::Instant::now();
        let generated =
            generate_context_lines_concurrently(app.handle(), &db, &secrets, book.id).await;
        println!(
            "=== wrote {generated} lines in {:?} at concurrency {GENERATE_CONCURRENCY} ===",
            started.elapsed()
        );
        assert!(generated > 0, "not one line was written");

        let conn = db.conn.lock().unwrap();
        let (written, blank, skipped): (i64, i64, i64) = conn
            .query_row(
                "SELECT SUM(context_line IS NOT NULL AND context_line <> ''),
                        SUM(context_line = ''),
                        SUM(context_line IS NULL)
                 FROM book_chunks WHERE book_id = ?1",
                params![book.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        let mut report = String::new();
        report.push_str("# 上下文行对关键词检索的实测\n\n");
        report.push_str(&format!(
            "《{}》（{}），{total} 个 chunk，写出定位句 {written} 条，模型返回不可用 {blank} 条，\
             调用失败跳过 {skipped} 条（留待下一轮补）。查询 {} 条。\n\n\
             对照方式：同一个索引、同一批数据，唯一的差别是 `MATCH` 允不允许看 `seg_context` 这一列。\
             「改前」把匹配限制在正文列上，等价于这一列不存在。查询里从不含 gold 短语。\n\n",
            book.title,
            book.author,
            book.queries.len()
        ));
        report.push_str("| 查询 | 类型 | 改前 | 改后 |\n|---|---|---|---|\n");

        let mut improved = 0;
        let mut regressed = 0;
        // Counted apart, because they answer different questions: `pronoun` is
        // where the feature is supposed to earn its keep, `named` is where it
        // can only add noise. A single blended total hides a trade.
        let mut by_kind: std::collections::BTreeMap<&str, (usize, usize, usize)> =
            std::collections::BTreeMap::new();
        for case in book.queries {
            let gold: Option<String> = conn
                .query_row(
                    "SELECT id FROM book_chunks
                     WHERE book_id = ?1 AND text LIKE '%' || ?2 || '%'
                     ORDER BY chunk_index LIMIT 1",
                    params![book.id, case.gold],
                    |row| row.get(0),
                )
                .optional()
                .unwrap();
            let Some(gold) = gold else {
                report.push_str(&format!(
                    "| {} | {} | 找不到原文锚点 `{}` | — |\n",
                    case.query, case.kind, case.gold
                ));
                continue;
            };
            let before = rank_of(&ab_ranks(&conn, book.id, case.query, false), &gold);
            let after = rank_of(&ab_ranks(&conn, book.id, case.query, true), &gold);
            let tally = by_kind.entry(case.kind).or_default();
            match (before, after) {
                (Some(b), Some(a)) if a < b => {
                    improved += 1;
                    tally.0 += 1;
                }
                (Some(b), Some(a)) if a > b => {
                    regressed += 1;
                    tally.1 += 1;
                }
                (None, Some(_)) => {
                    improved += 1;
                    tally.0 += 1;
                }
                (Some(_), None) => {
                    regressed += 1;
                    tally.1 += 1;
                }
                _ => tally.2 += 1,
            }
            report.push_str(&format!(
                "| {} | {} | {} | {} |\n",
                case.query,
                case.kind,
                rank_label(before),
                rank_label(after)
            ));
        }
        report.push_str(&format!("\n上升 {improved} 条，下降 {regressed} 条。\n\n"));
        report.push_str("| 类型 | 上升 | 下降 | 不变 |\n|---|---|---|---|\n");
        for (kind, (up, down, same)) in &by_kind {
            report.push_str(&format!("| {kind} | {up} | {down} | {same} |\n"));
        }

        // The cards themselves. A rank table says the right passage moved up;
        // it does not say the reader would recognise what came back.
        report.push_str("\n## 实际返回的卡片\n");
        for case in book
            .queries
            .iter()
            .filter(|case| case.kind == "pronoun")
            .take(3)
        {
            report.push_str(&format!("\n### {}\n\n", case.query));
            for (position, chunk_id) in ab_ranks(&conn, book.id, case.query, true)
                .iter()
                .take(3)
                .enumerate()
            {
                let (text, line): (String, Option<String>) = conn
                    .query_row(
                        "SELECT text, context_line FROM book_chunks WHERE id = ?1",
                        params![chunk_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .unwrap();
                let head: String = text.chars().take(180).collect();
                report.push_str(&format!(
                    "**#{}** · 定位句：{}\n\n> {}…\n\n",
                    position + 1,
                    line.as_deref().unwrap_or("—"),
                    head.replace('\n', " ")
                ));
            }
        }

        // One file per book: the earlier run's report is evidence, not a
        // scratch file, and a second book must not overwrite it.
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/impls")
            .join(format!("contextual-retrieval-ab-{}.md", book.id));
        std::fs::write(&out, &report).unwrap();
        println!("{report}");
        println!("=== written to {} ===", out.display());
    }

    /// The one part of the A/B that can be checked without spending anything.
    ///
    /// A `gold` phrase is a handle for finding the passage a query ought to
    /// return. If it matches no chunk the row silently drops out of the report;
    /// if it matches several, the report measures whichever came first —
    /// possibly the wrong passage entirely, and a wrong passage is worse than a
    /// missing one because it still produces a number. Both failures are
    /// invisible in the output, so they are caught here instead: indexing is
    /// local, so this costs a few seconds and no tokens.
    ///
    /// A book whose epub is not on this machine is skipped rather than failed —
    /// the epubs are gitignored, so on CI this test checks nothing and says so.
    /// It earns its keep on the machine that actually runs the A/B.
    #[test]
    fn every_ab_query_anchor_resolves_to_one_chunk() {
        let mut problems: Vec<String> = Vec::new();
        let mut checked = 0;
        for book in LIVE_BOOKS {
            if !harness_epub(book).exists() {
                println!("skipping {} — no epub on this machine", book.id);
                continue;
            }
            checked += book.queries.len();
            let directory = tempfile::TempDir::new().unwrap();
            let db = stage_book(directory.path(), book);
            let conn = db.conn.lock().unwrap();
            // Printed because it is what a live run on this book costs: one
            // model call per chunk.
            let chunks: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM book_chunks WHERE book_id = ?1",
                    params![book.id],
                    |row| row.get(0),
                )
                .unwrap();
            println!("{}: {chunks} chunks, {} queries", book.id, book.queries.len());
            for case in book.queries {
                let hits: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM book_chunks
                         WHERE book_id = ?1 AND text LIKE '%' || ?2 || '%'",
                        params![book.id, case.gold],
                        |row| row.get(0),
                    )
                    .unwrap();
                if hits != 1 {
                    problems.push(format!(
                        "{}: {hits} chunks match gold {:?} (query: {:?})",
                        book.id, case.gold, case.query
                    ));
                }
                // A query containing its own anchor would be handing the
                // search the answer, which measures nothing.
                if case.query.contains(case.gold) {
                    problems.push(format!(
                        "{}: query {:?} contains its own gold anchor",
                        book.id, case.query
                    ));
                }
            }
        }
        println!("{checked} anchors checked");
        assert!(
            problems.is_empty(),
            "{} bad anchors:\n{}",
            problems.len(),
            problems.join("\n")
        );
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
        let result =
            ensure_context_lines(app.handle(), &db, &secrets, "does-not-exist", None).await;
        assert!(result.is_ok());
    }
}
