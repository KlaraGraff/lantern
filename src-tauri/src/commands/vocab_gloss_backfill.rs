//! One-way repair of `vocab_words.definition` rows that hold a learning card
//! instead of a gloss.
//!
//! Two save paths used to write two different things into the same column. The
//! selection menu wrote a short contextual gloss; the learning card dumped its
//! whole rendered text — heading, summary, details, examples, the quote — into
//! `definition`, several hundred characters of it. `definition` is what the
//! passive-vocab feature prints *above the word* in the book, what the
//! vocabulary list shows in one line, what review cards show, and what export
//! writes. Both paths now go through one helper, but the rows already written
//! are still blobs, and nothing else will ever fix them.
//!
//! This job walks those rows and re-glosses each one from the two fields that
//! were stored alongside it — `word` and `context_sentence` — through the same
//! [`generate_vocab_gloss`](crate::commands::ai::vocabulary::generate_vocab_gloss)
//! the save path calls, so a repaired row is indistinguishable from a fresh one.
//! The blob is not thrown away: it moves to `context_explanation`, the column
//! that has existed for exactly that text since migration 012, whenever that
//! column is empty.
//!
//! Three properties this job must have, because it spends the reader's own AI
//! quota on rows they are not currently looking at:
//!
//! - **Serial and paced.** One call at a time, [`CALL_DELAY_MS`] between them,
//!   [`RUN_MAX`] rows per launch. A large vocabulary is repaired over several
//!   sessions rather than in one burst that competes with the reader's own
//!   lookups for rate limit.
//! - **Resumable, with no bookkeeping.** The pending set is *derived* from the
//!   heuristic on every run, so there is no cursor to lose, nothing to migrate,
//!   and a crash mid-run costs at most the row in flight. It terminates because
//!   `sanitize_gloss` guarantees a single line within the width ceiling, so a
//!   repaired row can never match the heuristic again.
//! - **Never destructive.** A row is only ever written after a non-empty gloss
//!   comes back. A failed call, an empty reply, no provider configured, offline
//!   — every one of those leaves the row exactly as it was, blob and all, for
//!   the next launch. A blob is bad; a blank definition would be worse.
//!
//! The update is local-only and emits no sync event, which is deliberate rather
//! than an omission: `apply_vocab_add` inserts with `INSERT OR IGNORE` and the
//! snapshot's `upsert_vocab` leaves `definition` and `context_explanation` out
//! of its `ON CONFLICT DO UPDATE SET` list, so no replay or merge can undo this,
//! and no new event type is needed. The cost is that another device repairs its
//! own copy on its own next launch instead of inheriting this one's work.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rusqlite::params;
use tauri::{AppHandle, Runtime};

use crate::commands::ai::vocabulary::{gloss_display_width, generate_vocab_gloss, MAX_GLOSS_WIDTH};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

/// Rows repaired per app launch. Bounded so a reader with a thousand-word
/// vocabulary does not discover the repair as a thousand-call bill on the
/// first launch after updating.
pub const RUN_MAX: usize = 40;

/// Pause between two repair calls. Long enough that the job is plainly in the
/// background — a reader's own lookup, made while this is running, queues
/// behind at most one repair rather than a burst of them.
const CALL_DELAY_MS: u64 = 1_500;

/// How long the job waits after launch before its first call. Startup is
/// already contended (migrations, library scan, sync); nothing here is urgent.
const STARTUP_DELAY_MS: u64 = 20_000;

/// One run at a time, process-wide. Two windows opening in quick succession
/// would otherwise each start a run over the same rows and pay twice.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Does this `definition` hold a card instead of a gloss?
///
/// Two signals, both structural rather than language-dependent:
///
/// - **More than one line.** A gloss is one line by construction — every path
///   that writes one runs it through `sanitize_gloss`, which keeps only the
///   first non-empty line. Anything with an interior newline was assembled from
///   sections.
/// - **Wider than the ceiling.** [`MAX_GLOSS_WIDTH`] columns is what fits above
///   a word; the blobs in question run 400–500 characters. Measured in display
///   columns, so a Chinese gloss and an English one get the same budget.
///
/// Deliberately *not* matched on module headings ("Meaning in this context" and
/// friends): those strings are localised, so matching them would repair a
/// Chinese reader's rows and quietly skip an English one's. The two structural
/// signals already cover every blob those headings appear in.
pub fn looks_like_card_blob(definition: &str) -> bool {
    let trimmed = definition.trim();
    if trimmed.is_empty() {
        return false;
    }
    trimmed.contains('\n') || gloss_display_width(trimmed) > MAX_GLOSS_WIDTH
}

struct PendingRow {
    id: String,
    word: String,
    definition: String,
    context_sentence: Option<String>,
    has_explanation: bool,
}

/// Every row whose definition still looks like a card, oldest first.
///
/// The width test cannot be pushed into SQL — SQLite's `length()` counts UTF-8
/// characters, not display columns — so the query narrows on what SQL *can*
/// decide (non-trivial length, or an embedded newline) and the exact test runs
/// in Rust. `length(definition) > 8` is only a cheap prefilter; the authority
/// is [`looks_like_card_blob`].
fn pending(db: &Db, limit: usize) -> AppResult<Vec<PendingRow>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT id, word, definition, context_sentence, context_explanation
         FROM vocab_words
         WHERE definition IS NOT NULL
           AND (instr(definition, char(10)) > 0 OR length(definition) > 8)
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let explanation: Option<String> = row.get(4)?;
        Ok(PendingRow {
            id: row.get(0)?,
            word: row.get(1)?,
            definition: row.get(2)?,
            context_sentence: row.get(3)?,
            has_explanation: explanation
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
        })
    })?;
    let mut pending = Vec::new();
    for row in rows {
        let row = row?;
        if row.word.trim().is_empty() || !looks_like_card_blob(&row.definition) {
            continue;
        }
        pending.push(row);
        if pending.len() >= limit {
            break;
        }
    }
    Ok(pending)
}

/// Writes one repaired row.
///
/// `updated_at` and `updated_by_device` are left alone on purpose. This is not
/// an edit the reader made — it is this device catching its own stored text up
/// to what it should always have been. Bumping the LWW clock would let a
/// repair win a merge against a genuine edit made elsewhere.
fn store(db: &Db, row: &PendingRow, gloss: &str) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    if row.has_explanation {
        conn.execute(
            "UPDATE vocab_words SET definition = ?1 WHERE id = ?2",
            params![gloss, row.id],
        )?;
    } else {
        // The blob was the only copy of that text. It belongs in the column
        // built for it, not in the bin.
        conn.execute(
            "UPDATE vocab_words SET definition = ?1, context_explanation = ?2 WHERE id = ?3",
            params![gloss, row.definition.trim(), row.id],
        )?;
    }
    Ok(())
}

/// Repair up to `limit` rows, serially. Returns how many were rewritten.
///
/// Never fails the whole run for one row: a call that errors, or comes back
/// empty, is skipped and the row is left for a later launch. The run only
/// stops early on repeated failure, which is what "no provider configured" and
/// "offline" both look like from here — continuing would be `limit` pointless
/// round trips.
pub async fn run_backfill<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    limit: usize,
) -> AppResult<usize> {
    let rows = pending(db, limit)?;
    if rows.is_empty() {
        return Ok(0);
    }

    let mut repaired = 0usize;
    let mut consecutive_failures = 0u32;
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(Duration::from_millis(CALL_DELAY_MS)).await;
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let result = generate_vocab_gloss(
            app,
            db,
            secrets,
            &row.word,
            row.context_sentence.as_deref(),
            None,
            &request_id,
            // Billed as this device's own upkeep rather than a reader action,
            // under the same feature the save path uses — it is the same call.
            "auto",
        )
        .await;
        match result {
            Ok(gloss) if !gloss.trim().is_empty() => {
                consecutive_failures = 0;
                store(db, row, gloss.trim())?;
                repaired += 1;
            }
            Ok(_) => {
                // A blank reply is a failed gloss, not a gloss of nothing.
                consecutive_failures += 1;
            }
            Err(error) => {
                log::debug!("vocab_gloss_backfill: leaving {} as it was: {error}", row.id);
                consecutive_failures += 1;
            }
        }
        if consecutive_failures >= 3 {
            log::debug!("vocab_gloss_backfill: stopping this run after repeated failures");
            break;
        }
    }
    Ok(repaired)
}

/// Start one repair pass in the background, some way into the session.
///
/// Called from `lib.rs`'s `setup`. No command, no button, no setting: the rows
/// are wrong, repairing them is not a choice the reader has any way to reason
/// about, and the work is invisible when it succeeds.
pub fn spawn_on_start<R: Runtime>(app: AppHandle<R>, db: Db, secrets: Secrets) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(STARTUP_DELAY_MS)).await;
        match run_backfill(&app, &db, &secrets, RUN_MAX).await {
            Ok(0) => {}
            Ok(count) => log::info!("vocab_gloss_backfill: repaired {count} definition(s)"),
            Err(error) => log::debug!("vocab_gloss_backfill: run skipped: {error}"),
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
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
        drop(conn);
        (dir, db)
    }

    fn insert_word(db: &Db, id: &str, word: &str, definition: &str, explanation: Option<&str>) {
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO vocab_words
                (id, book_id, word, definition, context_sentence, context_explanation,
                 cfi, mastery, review_count, created_at, updated_at, updated_by_device)
             VALUES (?1, 'book1', ?2, ?3, 'She went thither at once.', ?4,
                 'epubcfi(/6/4!/4/2)', 'new', 0, ?5, ?5, 'test')",
            params![id, word, definition, explanation, now],
        )
        .unwrap();
    }

    fn definition_of(db: &Db, id: &str) -> String {
        let conn = db.reader();
        conn.query_row(
            "SELECT definition FROM vocab_words WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn explanation_of(db: &Db, id: &str) -> Option<String> {
        let conn = db.reader();
        conn.query_row(
            "SELECT context_explanation FROM vocab_words WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    // --- the heuristic ---

    #[test]
    fn a_short_single_line_gloss_is_not_a_blob() {
        assert!(!looks_like_card_blob("讲述、叙述"));
        assert!(!looks_like_card_blob("to move gradually toward"));
        assert!(!looks_like_card_blob(""));
        assert!(!looks_like_card_blob("   "));
    }

    #[test]
    fn a_multi_line_definition_is_a_blob_however_short() {
        assert!(looks_like_card_blob("讲述\n\n更多解释"));
    }

    #[test]
    fn the_card_shaped_definition_this_job_exists_for_is_matched() {
        let blob = "Meaning in this context\nThe narrator uses \"recount\" to mean telling a \
                    story in order, not counting again.\n\nExamples\n- He recounted the voyage.";
        assert!(looks_like_card_blob(blob));
    }

    // A repaired row must never be picked up again, or the job would re-gloss
    // the same words on every launch forever.
    #[test]
    fn a_gloss_this_job_would_produce_never_matches_again() {
        let repaired = crate::commands::ai::vocabulary::sanitize_gloss(
            "Meaning in this context\nA long explanation follows.",
        );
        assert!(!looks_like_card_blob(&repaired));
    }

    #[test]
    fn pending_lists_only_blob_rows() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "recount", "讲述、叙述", None);
        insert_word(&db, "w2", "thither", "Meaning in this context\nto that place", None);
        insert_word(&db, "w3", "quaint", &"很长的解释".repeat(20), None);
        let rows = pending(&db, 10).unwrap();
        let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ids, vec!["w2", "w3"]);
    }

    #[test]
    fn pending_respects_its_limit() {
        let (_dir, db) = setup();
        for index in 0..5 {
            insert_word(
                &db,
                &format!("w{index}"),
                "thither",
                "Meaning in this context\nto that place",
                None,
            );
        }
        assert_eq!(pending(&db, 2).unwrap().len(), 2);
    }

    // --- end to end, against a fake provider ---

    /// Serves `body` to every connection, not just the first: a backfill run
    /// makes one call per row.
    async fn fake_sse_server(body: String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let body = body.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
            }
        });
        format!("http://{address}")
    }

    fn sse_answer(text: &str) -> String {
        let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{escaped}\"}}}}]}}\n\ndata: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":5}}}}\n\ndata: [DONE]\n\n"
        )
    }

    fn configure_provider(db: &Db, secrets: &Secrets, base_url: String) {
        let profile = crate::ai::router::create_profile(
            db,
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
            db,
            secrets,
            profile.id.clone(),
            "Key".to_string(),
            "test-key".to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn a_blob_is_replaced_by_a_gloss_and_the_blob_is_kept_as_the_explanation() {
        let (_dir, db) = setup();
        let blob = "Meaning in this context\nto that place, in older English.";
        insert_word(&db, "w1", "thither", blob, None);

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let app = tauri::test::mock_app();
        let repaired = run_backfill(app.handle(), &db, &secrets, 10).await.unwrap();
        assert_eq!(repaired, 1);
        assert_eq!(definition_of(&db, "w1"), "到那里");
        assert_eq!(explanation_of(&db, "w1").as_deref(), Some(blob));
        // And the row is now out of the job's sight for good.
        assert!(pending(&db, 10).unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_existing_explanation_is_never_overwritten() {
        let (_dir, db) = setup();
        insert_word(
            &db,
            "w1",
            "thither",
            "Meaning in this context\nto that place",
            Some("the reader's own kept analysis"),
        );

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let app = tauri::test::mock_app();
        run_backfill(app.handle(), &db, &secrets, 10).await.unwrap();
        assert_eq!(definition_of(&db, "w1"), "到那里");
        assert_eq!(
            explanation_of(&db, "w1").as_deref(),
            Some("the reader's own kept analysis")
        );
    }

    #[tokio::test]
    async fn a_failed_call_leaves_the_row_exactly_as_it_was() {
        let (_dir, db) = setup();
        let blob = "Meaning in this context\nto that place";
        insert_word(&db, "w1", "thither", blob, None);

        // No provider configured at all — the closest stand-in for a reader
        // who has not set AI up, which is the case that must not blank rows.
        let secrets = Secrets::init_in_memory().unwrap();
        let app = tauri::test::mock_app();
        let repaired = run_backfill(app.handle(), &db, &secrets, 10).await.unwrap();
        assert_eq!(repaired, 0);
        assert_eq!(definition_of(&db, "w1"), blob);
        assert_eq!(explanation_of(&db, "w1"), None);
    }

    #[tokio::test]
    async fn an_empty_reply_is_not_written_over_the_blob() {
        let (_dir, db) = setup();
        let blob = "Meaning in this context\nto that place";
        insert_word(&db, "w1", "thither", blob, None);

        let base_url = fake_sse_server(sse_answer("   ")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let app = tauri::test::mock_app();
        let repaired = run_backfill(app.handle(), &db, &secrets, 10).await.unwrap();
        assert_eq!(repaired, 0);
        assert_eq!(definition_of(&db, "w1"), blob);
    }

    #[tokio::test]
    async fn nothing_pending_makes_no_call() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "recount", "讲述、叙述", None);
        let secrets = Secrets::init_in_memory().unwrap();
        let app = tauri::test::mock_app();
        // No provider configured: a call would have errored rather than
        // returning Ok(0).
        assert_eq!(run_backfill(app.handle(), &db, &secrets, 10).await.unwrap(), 0);
    }
}
