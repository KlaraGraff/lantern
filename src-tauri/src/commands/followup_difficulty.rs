//! Offline, batched difficulty classification for the reader's follow-up
//! questions.
//!
//! See docs/impls/reading-flow-decisions-2026-08-06.md §4.4 and the upstream
//! design docs/impls/reading-driven-mastery-and-review.md §5.5. A "follow-up"
//! is narrow on purpose: a `chat_messages` row the reader typed (`role =
//! "user"`) that carries a non-empty `context` — the passage they tapped
//! "ask a follow-up" on. A plain dictionary lookup never touches
//! `chat_messages` (that path writes `lookup_records` instead), so nothing
//! here can mistake "looked up a word" for "asked about a sentence".
//!
//! Two calls, two very different costs:
//!
//! - [`capture`] runs inline, in the same command that already saves the
//!   chat message. It is one local SQLite insert — negligible next to the
//!   network round trip the chat reply itself makes — so it never delays
//!   the reader's conversation.
//! - [`maybe_spawn_batch`] / [`run_batch`] are the only place an AI call
//!   happens, and they never run inline. A batch fires only once accumulated
//!   unclassified rows cross [`BATCH_MIN`], is capped at [`BATCH_MAX`] rows
//!   per call, and is detached with `tauri::async_runtime::spawn` — the
//!   command that triggered it returns immediately, before the batch (if
//!   one even started) has done any work.
//!
//! Like every automatic job, a batch that fails — no provider configured,
//! quota exhausted, a malformed response — fails silently. There is no UI
//! this round to report to (`docs/impls/...#4.4` is explicit: "先把数据攒起来",
//! accumulate the data first), so a failed batch simply leaves its rows
//! unclassified for the next attempt to pick up.

use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Runtime};

use crate::commands::ai::ChatMessage;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

/// This job's id — and, by the auto-analysis registry's rule, the exact
/// string every classification call is tagged with in
/// `ai_usage_records.feature`. Drift between the two would make the
/// console's spend total for this job silently report zero forever.
pub const JOB_ID: &str = "followup_difficulty";

/// Floor: a batch never runs below this many accumulated unclassified rows.
/// The spec's own number ("攒够 20～30 条追问才跑一次") — low enough that a
/// moderately active reading session fills it within a few sittings, high
/// enough that a single classification call is clearly amortising its cost
/// over many questions rather than chasing one.
pub const BATCH_MIN: i64 = 20;

/// Ceiling: a batch call reads at most this many oldest-unclassified rows.
/// The other half of the spec's "20～30" range — a hard cap so the prompt
/// (and therefore the call's cost) stays bounded no matter how large the
/// backlog grows, and so a reader who accumulates hundreds of follow-ups
/// before a batch first runs still only pays for one call at a time.
pub const BATCH_MAX: i64 = 30;

/// Each stored `passage`/`question` is truncated to this many characters at
/// capture time. Bounds the batch prompt's size independently of how long a
/// single quoted passage or typed question happened to be — the classifier
/// only needs enough text to tell "which of four buckets", not the whole
/// thing verbatim.
const MAX_FIELD_CHARS: usize = 600;

/// The four difficulty categories, matching migration 045's CHECK
/// constraint exactly. Order here has no meaning; it is only the allow-list
/// a batch response's `category` field is checked against.
const CATEGORIES: [&str; 4] = ["vocabulary", "syntax", "reference", "cultural"];

/// Only one batch call in flight at a time, process-wide. `save_chat_message`
/// can be called from several reader actions in quick succession; without
/// this guard, two calls crossing the threshold back-to-back could each spawn
/// their own batch over the same rows. A DB-level row claim would also work,
/// but this is the same one-flag idiom the router already uses for request
/// cancellation, and a duplicate run here costs an extra AI call rather than
/// corrupting anything.
static BATCH_RUNNING: AtomicBool = AtomicBool::new(false);

fn truncate(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_FIELD_CHARS {
        trimmed.to_string()
    } else {
        trimmed.chars().take(MAX_FIELD_CHARS).collect()
    }
}

/// Record one follow-up for later classification, if this message is one.
///
/// Silent no-ops (not an error) when: the message isn't from the reader,
/// carries no quoted passage, or is blank after trimming — i.e. whenever it
/// is not the narrow "asked about this passage" shape this feature exists
/// for. The insert is idempotent (migration 045's unique index on
/// `message_id`), so a retried `save_chat_message` never double-counts.
///
/// Returns whether a row was captured, purely so callers/tests can assert on
/// it — the caller never needs to react to `false`.
pub fn capture(
    db: &Db,
    chat_id: &str,
    message_id: &str,
    role: &str,
    content: &str,
    context: Option<&str>,
) -> AppResult<bool> {
    if role != "user" {
        return Ok(false);
    }
    let question = content.trim();
    if question.is_empty() {
        return Ok(false);
    }
    let Some(passage) = context.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(false);
    };

    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let book_id: Option<String> = conn
        .query_row(
            "SELECT book_id FROM chats WHERE id = ?1",
            params![chat_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(book_id) = book_id else {
        // The chat was deleted between the message being saved and this
        // capture running, or `chat_id` was never valid. Either way there is
        // no book to attribute the follow-up to, so there is nothing to
        // capture.
        return Ok(false);
    };

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO followup_questions
            (id, book_id, chat_id, message_id, passage, question, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            book_id,
            chat_id,
            message_id,
            truncate(passage),
            truncate(question),
            now
        ],
    )?;
    Ok(inserted > 0)
}

fn pending_count(db: &Db) -> AppResult<i64> {
    let conn = db.reader();
    conn.query_row(
        "SELECT COUNT(*) FROM followup_questions WHERE classified_at IS NULL",
        [],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

/// Fire a batch classification pass in the background, if the job is
/// enabled and enough has accumulated. Never awaited by the caller —
/// `save_chat_message` returns to the reader before this has done anything.
pub fn maybe_spawn_batch<R: Runtime>(app: AppHandle<R>, db: Db, secrets: Secrets) {
    let enabled = crate::commands::auto_analysis::is_enabled(&db.reader(), JOB_ID);
    if !enabled {
        return;
    }
    let pending = match pending_count(&db) {
        Ok(count) => count,
        Err(error) => {
            log::debug!("followup_difficulty: could not count pending rows: {error}");
            return;
        }
    };
    if pending < BATCH_MIN {
        return;
    }
    if BATCH_RUNNING.swap(true, Ordering::SeqCst) {
        // Another call already crossed the threshold moments ago and is
        // still running its batch. Let it finish; whatever is left over
        // will cross the threshold again on some later message.
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_batch(&app, &db, &secrets, "auto").await {
            log::debug!("followup_difficulty: batch classification skipped: {error}");
        }
        BATCH_RUNNING.store(false, Ordering::SeqCst);
    });
}

struct PendingRow {
    id: String,
    passage: String,
    question: String,
}

fn oldest_pending(db: &Db, limit: i64) -> AppResult<Vec<PendingRow>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT id, passage, question FROM followup_questions
         WHERE classified_at IS NULL
         ORDER BY created_at ASC
         LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(PendingRow {
                id: row.get(0)?,
                passage: row.get(1)?,
                question: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Fixed, inspectable prompt: the only interpolated content is each row's
/// `passage` and `question` — exactly the two fields §5.5 allows the call to
/// send, nothing else about the book, the reader, or the surrounding chat.
fn classification_prompt(rows: &[PendingRow]) -> Vec<ChatMessage> {
    let items: Vec<serde_json::Value> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            serde_json::json!({
                "index": index,
                "passage": row.passage,
                "question": row.question,
            })
        })
        .collect();
    let payload = serde_json::Value::Array(items).to_string();
    vec![
        ChatMessage {
            role: "system".to_string(),
            content: "You classify a reader's follow-up question about a quoted passage into \
                exactly one difficulty category: \"vocabulary\" (a word or phrase's meaning), \
                \"syntax\" (how the sentence is put together), \"reference\" (what a pronoun or \
                other reference points to), or \"cultural\" (background the passage assumes). \
                Respond with only a JSON array, no prose, no markdown fences. Each element is an \
                object {\"index\": <the input item's index>, \"category\": <one of the four \
                strings above>}. Include one element per input item, in any order."
                .to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: payload,
        },
    ]
}

/// Strip a ```json fence a model adds despite being asked not to, without
/// assuming one is present.
fn strip_code_fence(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(after_open) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let after_open = after_open
        .strip_prefix("json")
        .unwrap_or(after_open)
        .trim_start_matches(['\n', '\r']);
    after_open.strip_suffix("```").unwrap_or(after_open).trim()
}

#[derive(serde::Deserialize)]
struct ClassificationEntry {
    index: usize,
    category: String,
}

/// Parse the model's response into `(row index, category)` pairs, keeping
/// only entries whose index is in range and whose category is one of the
/// four allowed values. Anything else — a malformed entry, an out-of-range
/// index, an invented category — is dropped rather than failing the whole
/// batch: a response that got most of the rows right should not throw away
/// the ones it got right.
fn parse_classifications(text: &str, row_count: usize) -> Vec<(usize, &'static str)> {
    let Ok(entries) = serde_json::from_str::<Vec<ClassificationEntry>>(strip_code_fence(text))
    else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|entry| entry.index < row_count)
        .filter_map(|entry| {
            CATEGORIES
                .iter()
                .find(|&&category| category == entry.category)
                .map(|&category| (entry.index, category))
        })
        .collect()
}

/// Run one batch classification pass: pull the oldest unclassified rows (up
/// to [`BATCH_MAX`]), classify them in a single call, store what came back
/// valid. Returns how many rows were actually classified, mostly so tests
/// can assert on it — `maybe_spawn_batch`'s caller never inspects this.
///
/// Does not itself check [`BATCH_MIN`] or whether the job is enabled — those
/// are `maybe_spawn_batch`'s job. Exposed separately (rather than folded into
/// `maybe_spawn_batch`) so a future manual "run this now" button, and tests,
/// can call it directly without going through the threshold gate.
pub async fn run_batch<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    origin: &str,
) -> AppResult<usize> {
    let rows = oldest_pending(db, BATCH_MAX)?;
    if rows.is_empty() {
        return Ok(0);
    }
    let messages = classification_prompt(&rows);
    let completion = crate::ai::router::complete_with_failover(
        app,
        db,
        secrets,
        &messages,
        Some(2_000),
        crate::ai::router::AiRequestPurpose::Utility,
        crate::ai::router::AiRetryMode::Automatic,
        None,
        None,
        origin,
        // Must stay exactly `JOB_ID` — the auto-analysis console totals this
        // job's spend by matching `ai_usage_records.feature` against it.
        JOB_ID,
    )
    .await?;
    let classifications = parse_classifications(&completion.text, rows.len());
    if classifications.is_empty() {
        return Ok(0);
    }
    let batch_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let mut stored = 0usize;
    for (index, category) in classifications {
        let row = &rows[index];
        let changed = conn.execute(
            "UPDATE followup_questions
             SET difficulty = ?1, classified_at = ?2, batch_id = ?3
             WHERE id = ?4 AND classified_at IS NULL",
            params![category, now, batch_id, row.id],
        )?;
        stored += changed;
    }
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book1', 'Test Book', 'Author', 'books/test.epub', 'reading', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chats (id, book_id, title, pinned, created_at, updated_at)
             VALUES ('chat1', 'book1', 'Chat', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        drop(conn);
        (dir, db)
    }

    fn pending(db: &Db) -> i64 {
        let conn = db.reader();
        conn.query_row(
            "SELECT COUNT(*) FROM followup_questions WHERE classified_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    // --- capture ---

    #[test]
    fn a_question_with_a_quoted_passage_is_captured() {
        let (_dir, db) = setup();
        let captured = capture(
            &db,
            "chat1",
            "m1",
            "user",
            "What does 'thither' mean here?",
            Some("She went thither at once."),
        )
        .unwrap();
        assert!(captured);
        assert_eq!(pending(&db), 1);
    }

    #[test]
    fn a_lookup_style_message_with_no_context_is_not_a_followup() {
        let (_dir, db) = setup();
        let captured = capture(&db, "chat1", "m1", "user", "define: thither", None).unwrap();
        assert!(!captured);
        assert_eq!(pending(&db), 0);
    }

    #[test]
    fn an_assistant_reply_is_never_captured_even_with_context() {
        let (_dir, db) = setup();
        let captured = capture(
            &db,
            "chat1",
            "m1",
            "assistant",
            "It means 'to that place'.",
            Some("She went thither at once."),
        )
        .unwrap();
        assert!(!captured);
    }

    #[test]
    fn a_blank_question_is_not_captured() {
        let (_dir, db) = setup();
        let captured = capture(
            &db,
            "chat1",
            "m1",
            "user",
            "   ",
            Some("She went thither at once."),
        )
        .unwrap();
        assert!(!captured);
    }

    #[test]
    fn capture_is_idempotent_per_message() {
        let (_dir, db) = setup();
        for _ in 0..3 {
            capture(
                &db,
                "chat1",
                "m1",
                "user",
                "What does 'thither' mean?",
                Some("She went thither."),
            )
            .unwrap();
        }
        assert_eq!(pending(&db), 1);
    }

    #[test]
    fn a_message_on_an_unknown_chat_is_not_captured() {
        let (_dir, db) = setup();
        let captured = capture(
            &db,
            "does-not-exist",
            "m1",
            "user",
            "why?",
            Some("some passage"),
        )
        .unwrap();
        assert!(!captured);
    }

    #[test]
    fn very_long_fields_are_truncated_at_capture() {
        let (_dir, db) = setup();
        let long_passage = "a".repeat(MAX_FIELD_CHARS * 2);
        let long_question = "b".repeat(MAX_FIELD_CHARS * 2);
        capture(&db, "chat1", "m1", "user", &long_question, Some(&long_passage)).unwrap();
        let conn = db.reader();
        let (passage, question): (String, String) = conn
            .query_row(
                "SELECT passage, question FROM followup_questions WHERE message_id = 'm1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(passage.chars().count(), MAX_FIELD_CHARS);
        assert_eq!(question.chars().count(), MAX_FIELD_CHARS);
    }

    // --- threshold ---

    #[test]
    fn pending_count_matches_captured_rows() {
        let (_dir, db) = setup();
        for i in 0..5 {
            capture(
                &db,
                "chat1",
                &format!("m{i}"),
                "user",
                "why this word?",
                Some("some passage"),
            )
            .unwrap();
        }
        assert_eq!(pending_count(&db).unwrap(), 5);
    }

    #[test]
    fn maybe_spawn_batch_is_a_noop_below_the_threshold() {
        let (_dir, db) = setup();
        for i in 0..(BATCH_MIN - 1) {
            capture(
                &db,
                "chat1",
                &format!("m{i}"),
                "user",
                "why this word?",
                Some("some passage"),
            )
            .unwrap();
        }
        // No AI profile is configured at all in this test, so if this were
        // to attempt a run it would show up as a stuck `BATCH_RUNNING` flag
        // (never reset because nothing spawned) or a logged error. Neither
        // is directly observable here; the real assertion is functional:
        // pending count is untouched because nothing consumed it.
        let app = tauri::test::mock_app();
        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        maybe_spawn_batch(app.handle().clone(), db.clone(), secrets);
        assert_eq!(pending(&db), BATCH_MIN - 1);
    }

    #[test]
    fn maybe_spawn_batch_never_runs_when_the_job_is_disabled() {
        let (_dir, db) = setup();
        for i in 0..BATCH_MAX {
            capture(
                &db,
                "chat1",
                &format!("m{i}"),
                "user",
                "why this word?",
                Some("some passage"),
            )
            .unwrap();
        }
        crate::commands::auto_analysis::set_enabled_for_test(&db, JOB_ID, false);
        let app = tauri::test::mock_app();
        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        maybe_spawn_batch(app.handle().clone(), db.clone(), secrets);
        // Nothing should have been spawned at all — still all pending, and
        // the running flag was never touched.
        assert_eq!(pending(&db), BATCH_MAX);
        assert!(!BATCH_RUNNING.load(Ordering::SeqCst));
    }

    // --- parsing ---

    #[test]
    fn a_clean_json_array_is_parsed() {
        let text = r#"[{"index":0,"category":"vocabulary"},{"index":1,"category":"syntax"}]"#;
        let result = parse_classifications(text, 2);
        assert_eq!(result, vec![(0, "vocabulary"), (1, "syntax")]);
    }

    #[test]
    fn a_markdown_fenced_response_is_still_parsed() {
        let text = "```json\n[{\"index\":0,\"category\":\"reference\"}]\n```";
        let result = parse_classifications(text, 1);
        assert_eq!(result, vec![(0, "reference")]);
    }

    #[test]
    fn an_out_of_range_index_is_dropped() {
        let text = r#"[{"index":5,"category":"vocabulary"}]"#;
        let result = parse_classifications(text, 2);
        assert!(result.is_empty());
    }

    #[test]
    fn an_invented_category_is_dropped_but_siblings_survive() {
        let text = r#"[{"index":0,"category":"grammar"},{"index":1,"category":"cultural"}]"#;
        let result = parse_classifications(text, 2);
        assert_eq!(result, vec![(1, "cultural")]);
    }

    #[test]
    fn unparseable_text_yields_no_classifications() {
        let result = parse_classifications("not json at all", 3);
        assert!(result.is_empty());
    }

    // --- run_batch end to end, against a fake provider ---

    async fn fake_sse_server(body: String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let Ok(read) = stream.read(&mut buffer).await else {
                    return;
                };
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
        format!("http://{address}")
    }

    fn sse_answer(text: &str) -> String {
        let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
        // The trailing usage-bearing chunk mirrors what a real
        // `stream_options.include_usage` response sends: an empty
        // `choices` array alongside a top-level `usage` object. Without it,
        // `ai::usage::record` sees `None` and — correctly, per its own
        // contract — writes no `ai_usage_records` row at all, which is what
        // the billing assertion below is actually checking for.
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{escaped}\"}}}}]}}\n\ndata: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":5}}}}\n\ndata: [DONE]\n\n"
        )
    }

    #[tokio::test]
    async fn a_batch_run_classifies_against_a_fake_provider_and_bills_the_job_id() {
        let (_dir, db) = setup();
        capture(
            &db,
            "chat1",
            "m0",
            "user",
            "What does 'thither' mean?",
            Some("She went thither at once."),
        )
        .unwrap();
        capture(
            &db,
            "chat1",
            "m1",
            "user",
            "Who does 'she' refer to two sentences back?",
            Some("Maria arrived. The house was quiet. She went thither at once."),
        )
        .unwrap();

        let body = sse_answer(
            r#"[{"index":0,"category":"vocabulary"},{"index":1,"category":"reference"}]"#,
        );
        let base_url = fake_sse_server(body).await;

        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        let profile = crate::ai::router::create_profile(
            &db,
            "Test".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some(base_url),
            "placeholder".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        crate::ai::router::add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "Key".to_string(),
            "test-key".to_string(),
        )
        .unwrap();

        let app = tauri::test::mock_app();
        let classified = run_batch(app.handle(), &db, &secrets, "auto").await.unwrap();
        assert_eq!(classified, 2);
        assert_eq!(pending(&db), 0);

        let conn = db.reader();
        let (difficulty, batch_id): (String, Option<String>) = conn
            .query_row(
                "SELECT difficulty, batch_id FROM followup_questions WHERE message_id = 'm0'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(difficulty, "vocabulary");
        assert!(batch_id.is_some());
        let difficulty_2: String = conn
            .query_row(
                "SELECT difficulty FROM followup_questions WHERE message_id = 'm1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(difficulty_2, "reference");

        // The call must be billed under exactly this job's id, or the
        // auto-analysis console's spend total for it silently reports zero.
        let (origin, feature): (String, String) = conn
            .query_row(
                "SELECT origin, feature FROM ai_usage_records ORDER BY created_at DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(origin, "auto");
        assert_eq!(feature, JOB_ID);
    }

    #[tokio::test]
    async fn a_malformed_response_leaves_every_row_pending_for_the_next_attempt() {
        let (_dir, db) = setup();
        capture(
            &db,
            "chat1",
            "m0",
            "user",
            "What does 'thither' mean?",
            Some("She went thither at once."),
        )
        .unwrap();

        let base_url = fake_sse_server(sse_answer("not json at all")).await;
        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        let profile = crate::ai::router::create_profile(
            &db,
            "Test".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some(base_url),
            "placeholder".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        crate::ai::router::add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "Key".to_string(),
            "test-key".to_string(),
        )
        .unwrap();

        let app = tauri::test::mock_app();
        let classified = run_batch(app.handle(), &db, &secrets, "auto").await.unwrap();
        assert_eq!(classified, 0);
        assert_eq!(pending(&db), 1);
    }

    #[tokio::test]
    async fn run_batch_with_nothing_pending_makes_no_call() {
        let (_dir, db) = setup();
        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        let app = tauri::test::mock_app();
        // No AI profile configured at all — if this attempted a call it
        // would fail with NOT_CONFIGURED rather than return Ok(0).
        let classified = run_batch(app.handle(), &db, &secrets, "auto").await.unwrap();
        assert_eq!(classified, 0);
    }
}
