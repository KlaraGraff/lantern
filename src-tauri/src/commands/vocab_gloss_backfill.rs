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
//! Each repair publishes as `vocab.definition.set`, so the reader's other
//! devices inherit this one's work instead of buying it again. That is not a
//! nicety: the pending set is derived from row content, so a repair that
//! arrives before another device reaches the row takes it out of that device's
//! pending set for good, and [`still_needs_repair`] re-checks each row
//! immediately before spending on it so a repair landing *during* a run counts
//! too. What is left is a race — a device that starts a run before any of the
//! peer's repairs have replayed pays for the overlap once — and it costs at
//! most one launch's [`RUN_MAX`], not the whole backlog per device.
//!
//! # Why this is in the auto-analysis registry, and why it ships on
//!
//! It spends the reader's quota while they are not looking, so
//! `commands::auto_analysis`'s first rule applies with no exception:
//! [`run_backfill`] passes through `is_enabled` before it reads a single row,
//! and a reader who switches [`JOB_ID`] off gets silence.
//!
//! `default_enabled` is `true`, against the `review_pile_curation` precedent
//! that established a job *can* ship off. That precedent does not reach this
//! job, and reading it as "new jobs ship off now" inverts it. What made
//! `review_pile_curation` default to off is that its *value* was unproven —
//! it rearranges review groups nobody asked to have rearranged, so the reader
//! has to be the one who decides it is worth paying for. Nothing here is
//! unproven. These rows are wrong; they were written wrong by a defect of
//! ours; the reader never chose the breakage and would never choose to keep
//! it. Asking them to opt into the repair asks them to first understand a bug
//! they were never told about, and the price of not finding the switch is
//! that `definition` keeps printing four hundred characters above a word
//! forever. Default-off is the conservative answer when the question is "do
//! you want this feature"; here the question is "may we undo our own damage",
//! and default-off is simply the damage.
//!
//! Two properties keep that defensible: the spend is finite and shrinking —
//! the backlog only empties — and the row disappears from the console the
//! moment the last damaged row is repaired (`AutoAnalysisJob::applies`, wired
//! to [`has_pending`]), so the switch never outlives the thing it gates.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::ai::vocabulary::{gloss_display_width, generate_vocab_gloss, MAX_GLOSS_WIDTH};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

/// This job's id in `commands::auto_analysis`, and — by that registry's
/// requirement — the exact `ai_usage_records.feature` its calls are tagged
/// with. It is deliberately *not* `vocab_gloss`, which is what the
/// interactive save path bills under: sharing that tag would have made the
/// console report zero for this job while hiding the repair's cost inside
/// what looks like ordinary word saving.
pub const JOB_ID: &str = "vocab_gloss_backfill";

/// The event that tells the frontend a repair pass has actually begun, so it
/// can say so. Emitted once per pass, only when the job is switched on and
/// has found work — never on a launch where there is nothing to repair.
const STARTED_EVENT: &str = "vocab-gloss-backfill-started";

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

/// What, if anything, the text being replaced should be parked under.
///
/// One rule, three callers — this job, `vocab_regloss`, and
/// `sync::merge::apply_vocab_definition` — because a definition change now
/// travels between devices and the receiving device must end up with the same
/// two columns the sending one has.
///
/// Two conditions, and the second is narrower than it used to be:
///
/// - **The explanation column is empty.** A reader's own kept analysis is
///   never collateral.
/// - **The displaced text is a card blob.** It was written that way for this
///   job, where the text being replaced is several hundred characters that
///   exist nowhere else and belong under "In context". On an ordinary
///   regenerate the displaced text is a previous one-line gloss, and parking
///   *that* under "In context" invents an explanation the reader never asked
///   for out of a sentence they just rejected. `looks_like_card_blob` is
///   exactly the line between the two cases, and it is already this job's
///   pending predicate, so the repair path is unaffected: every row it
///   touches matches by construction.
pub fn displaced_explanation(
    old_definition: &str,
    existing_explanation: Option<&str>,
) -> Option<String> {
    if existing_explanation.is_some_and(|value| !value.trim().is_empty()) {
        return None;
    }
    let trimmed = old_definition.trim();
    if !looks_like_card_blob(trimmed) {
        return None;
    }
    Some(trimmed.to_string())
}

struct PendingRow {
    id: String,
    word: String,
    definition: String,
    context_sentence: Option<String>,
}

/// Every row whose definition still looks like a card, oldest first.
///
/// The width test cannot be pushed into SQL — SQLite's `length()` counts UTF-8
/// characters, not display columns — so the query narrows on what SQL *can*
/// decide (non-trivial length, or an embedded newline) and the exact test runs
/// in Rust. `length(definition) > 8` is only a cheap prefilter; the authority
/// is [`looks_like_card_blob`].
fn pending(db: &Db, limit: usize) -> AppResult<Vec<PendingRow>> {
    pending_on(&db.reader(), limit)
}

fn pending_on(conn: &Connection, limit: usize) -> AppResult<Vec<PendingRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, word, definition, context_sentence
         FROM vocab_words
         WHERE definition IS NOT NULL
           AND (instr(definition, char(10)) > 0 OR length(definition) > 8)
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PendingRow {
            id: row.get("id")?,
            word: row.get("word")?,
            definition: row.get("definition")?,
            context_sentence: row.get("context_sentence")?,
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

/// Is there any damaged row left at all?
///
/// This is what `AutoAnalysisJob::applies` calls to decide whether the
/// console still owes the reader a switch. It runs the job's own [`pending_on`]
/// with a limit of one rather than a count of its own, so "the console thinks
/// there is work" and "the job finds work" cannot drift apart — a separate
/// `COUNT(*)` with the same `WHERE` clause would still miss the Rust-side
/// width test that is the actual authority, and the row would survive as a
/// switch that gates nothing.
///
/// Stopping at the first match makes it cheap enough for a screen that reads
/// it on every open: the common case after the repair finishes is a scan that
/// ends when the prefilter runs out, and the common case before it finishes
/// ends on the first blob.
///
/// A failed query answers "no". The console losing a row it cannot justify is
/// the safe direction; the gate this feeds is not the one protecting quota —
/// that is `is_enabled`, which is checked separately.
pub fn has_pending(conn: &Connection) -> bool {
    pending_on(conn, 1).is_ok_and(|rows| !rows.is_empty())
}

/// Is this row still worth a call?
///
/// The pending list is read once, at the top of a run, and a run of
/// [`RUN_MAX`] rows paced at [`CALL_DELAY_MS`] lasts a minute — long enough
/// for a peer's `vocab.definition.set` to land on a row this device has not
/// reached yet, and long enough for the reader to press regenerate on one
/// themselves. Re-reading the row immediately before spending on it is what
/// turns "definitions sync" into "the second device does not pay again":
/// without it, a repair that arrives mid-run is overwritten by a call this
/// device had already committed to making.
///
/// A row that has since been deleted answers "no". A read failure also
/// answers "no" — skipping a repairable row costs one launch, and the
/// alternative direction spends money on a guess.
fn still_needs_repair(db: &Db, id: &str) -> bool {
    db.reader()
        .query_row(
            "SELECT definition FROM vocab_words WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .is_some_and(|definition| looks_like_card_blob(&definition))
}

/// Writes one repaired row and publishes it.
///
/// `updated_at` and `updated_by_device` now move with the write, reversing
/// what this job originally did. The old note said the clock belongs to the
/// columns that sync and this repair is not an edit the reader made; the
/// second half is still true and the first half now points the other way,
/// because `definition` is a column that syncs. A device that repaired a row
/// without stamping it would publish a change its own row says never
/// happened, and the next snapshot from a peer would hand the blob straight
/// back. See `commands::vocab::set_definition`.
fn store<R: Runtime>(app: &AppHandle<R>, db: &Db, row: &PendingRow, gloss: &str) -> AppResult<bool> {
    let sync = app
        .try_state::<crate::sync::writer::SyncWriter>()
        .ok_or_else(|| AppError::Other("SYNC_WRITER_UNAVAILABLE".to_string()))?;
    let now = chrono::Utc::now().timestamp_millis();
    crate::commands::vocab::set_definition(db, &sync, &row.id, gloss, now)
}

/// Repair up to `limit` rows, serially. Returns how many were rewritten.
///
/// Never fails the whole run for one row: a call that errors, or comes back
/// empty, is skipped and the row is left for a later launch. The run only
/// stops early on repeated failure, which is what "no provider configured" and
/// "offline" both look like from here — continuing would be `limit` pointless
/// round trips.
///
/// The `is_enabled` gate lives here rather than in [`spawn_on_start`] because
/// every caller of this function is by definition an automatic one — there is
/// no manual entry point — and a gate on the outside is a gate the next caller
/// can forget. It is checked before the pending query, so a switched-off job
/// touches neither the AI provider nor the database.
pub async fn run_backfill<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    limit: usize,
) -> AppResult<usize> {
    let enabled = crate::commands::auto_analysis::is_enabled(&db.reader(), JOB_ID);
    if !enabled {
        return Ok(0);
    }

    let rows = pending(db, limit)?;
    if rows.is_empty() {
        return Ok(0);
    }
    // Announced only now: the job is on and has actually found work. A notice
    // on every launch, or on a launch where nothing happens, is the kind of
    // background chatter that teaches readers to ignore the notices that
    // matter.
    let _ = app.emit(STARTED_EVENT, ());

    let mut repaired = 0usize;
    let mut consecutive_failures = 0u32;
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(Duration::from_millis(CALL_DELAY_MS)).await;
        }
        if !still_needs_repair(db, &row.id) {
            // Repaired by another device (or by the reader's own regenerate
            // button) while this run was working through the rows before it.
            continue;
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
            // and under this job's own id rather than the save path's tag —
            // the console totals spend by that column, so sharing a tag would
            // report zero here and overstate ordinary word saving by exactly
            // what the repair cost.
            "auto",
            JOB_ID,
        )
        .await;
        match result {
            Ok(gloss) if !gloss.trim().is_empty() => {
                consecutive_failures = 0;
                if store(app, db, row, gloss.trim())? {
                    repaired += 1;
                }
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
/// Called from `lib.rs`'s `setup`. Nothing else starts *this job* — the
/// switch in Settings → Automatic Analysis is the whole of the reader's say
/// over it, and [`run_backfill`] is where that is enforced.
///
/// The manual recourse `commands::auto_analysis`'s second rule asks for is not
/// a second trigger for this job but a per-word one:
/// `commands::vocab_regloss::regenerate_vocab_definition`, which re-glosses a
/// single saved word on the reader's command with the same write this job
/// makes. A reader who switches this job off can still repair any row they can
/// see, one at a time, and that action outlives the backlog.
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

    fn clock_of(db: &Db, id: &str) -> (i64, String) {
        let conn = db.reader();
        conn.query_row(
            "SELECT updated_at, updated_by_device FROM vocab_words WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    /// A repair now publishes, so the mock app has to carry the `SyncWriter`
    /// [`store`] reads out of app state — with queueing on, so a test can read
    /// back what the run put on the wire.
    fn test_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        let sync = crate::sync::writer::SyncWriter::new("dev-A".into());
        sync.set_should_queue(true);
        app.manage(sync);
        app
    }

    fn published(db: &Db) -> Vec<String> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT body_json FROM _pending_publish ORDER BY rowid")
            .unwrap();
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        drop(stmt);
        rows
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

        let app = test_app();
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

        let app = test_app();
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
        let app = test_app();
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

        let app = test_app();
        let repaired = run_backfill(app.handle(), &db, &secrets, 10).await.unwrap();
        assert_eq!(repaired, 0);
        assert_eq!(definition_of(&db, "w1"), blob);
    }

    // --- what the repair tells the reader's other devices ---

    /// The whole reason a repair is worth publishing: 500 damaged rows on
    /// three devices used to be three bills and three different glosses.
    #[tokio::test]
    async fn a_repair_is_published_so_the_other_devices_inherit_it() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "thither", "Meaning in this context\nto that place", None);

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let app = test_app();
        let before = chrono::Utc::now().timestamp_millis();
        run_backfill(app.handle(), &db, &secrets, 10).await.unwrap();

        let events = published(&db);
        let definitions: Vec<&String> = events
            .iter()
            .filter(|body| body.contains("vocab.definition.set"))
            .collect();
        assert_eq!(definitions.len(), 1);
        assert!(definitions[0].contains("到那里"));
        // Only the new definition travels. The blob this device parked under
        // `context_explanation` stays this device's business — the receiver
        // does the same displacement with its own old text.
        assert!(!definitions[0].contains("context_explanation"));
        assert!(!definitions[0].contains("Meaning in this context"));

        // And the row is stamped, or the peer's next snapshot would hand the
        // blob straight back.
        let (updated_at, device) = clock_of(&db, "w1");
        assert!(updated_at >= before);
        assert_eq!(device, "dev-A");
    }

    /// The guard that makes the saving real for a run already in flight: a row
    /// repaired by a peer (or by the reader's regenerate button) between the
    /// pending query and this device reaching it is skipped, not bought again.
    #[test]
    fn a_row_another_device_already_repaired_is_not_worth_a_call() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "thither", "Meaning in this context\nto that place", None);
        assert!(still_needs_repair(&db, "w1"));

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE vocab_words SET definition = '到那里' WHERE id = 'w1'",
                [],
            )
            .unwrap();
        }
        assert!(!still_needs_repair(&db, "w1"));
        // A row deleted out from under the run is not worth a call either.
        assert!(!still_needs_repair(&db, "gone"));
    }

    /// The displacement rule both sides share. It is narrower than it was:
    /// parking text under "In context" is right for the blob this job exists
    /// for and wrong for an ordinary one-line gloss, which is just noise.
    #[test]
    fn only_a_blob_is_parked_under_the_explanation() {
        let blob = "Meaning in this context\nto that place, in older English.";
        assert_eq!(displaced_explanation(blob, None).as_deref(), Some(blob));
        // An explanation already there is never overwritten.
        assert_eq!(displaced_explanation(blob, Some("kept")), None);
        assert_eq!(displaced_explanation(blob, Some("  ")).as_deref(), Some(blob));
        // An ordinary gloss is discarded rather than filed.
        assert_eq!(displaced_explanation("到那里", None), None);
    }

    // --- the registry gate ---

    /// The rule the auto-analysis registry exists for: no automatic AI call
    /// without a switch. With the switch off the job must not even look.
    #[tokio::test]
    async fn a_switched_off_job_repairs_nothing() {
        let (_dir, db) = setup();
        let blob = "Meaning in this context\nto that place, in older English.";
        insert_word(&db, "w1", "thither", blob, None);

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);
        crate::commands::auto_analysis::set_enabled_for_test(&db, JOB_ID, false);

        let app = test_app();
        let repaired = run_backfill(app.handle(), &db, &secrets, 10).await.unwrap();
        assert_eq!(repaired, 0);
        // A working provider was standing right there — the row is untouched
        // because the gate closed, not because the call failed.
        assert_eq!(definition_of(&db, "w1"), blob);
    }

    /// `default_enabled: true` — a reader who never opened the switch still
    /// gets the repair. See the module doc for why this one differs from
    /// `review_pile_curation`.
    #[test]
    fn a_reader_who_never_found_the_switch_still_gets_the_repair() {
        let (_dir, db) = setup();
        assert!(crate::commands::auto_analysis::is_enabled(
            &db.reader(),
            JOB_ID
        ));
    }

    /// The registry requires a job's id to be the exact `feature` its calls
    /// are billed under; sharing `vocab_gloss` with the interactive save path
    /// would report zero for this job forever.
    #[tokio::test]
    async fn the_repair_is_billed_under_this_jobs_own_id() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "thither", "Meaning in this context\nto that place", None);

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let app = test_app();
        run_backfill(app.handle(), &db, &secrets, 10).await.unwrap();

        let conn = db.reader();
        let (origin, feature): (String, String) = conn
            .query_row(
                "SELECT origin, feature FROM ai_usage_records",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(origin, "auto");
        assert_eq!(feature, JOB_ID);
    }

    // --- the row disappears when the work does ---

    #[test]
    fn a_library_with_a_blob_in_it_still_owes_the_reader_a_switch() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "recount", "讲述、叙述", None);
        assert!(!has_pending(&db.reader()));
        insert_word(&db, "w2", "thither", "Meaning in this context\nto that place", None);
        assert!(has_pending(&db.reader()));
    }

    /// `has_pending` must agree with `pending` by construction. A row the
    /// SQL prefilter admits but the width test rejects is exactly where a
    /// hand-written `COUNT(*)` would have disagreed.
    #[test]
    fn the_switch_and_the_job_can_never_disagree_about_what_is_left() {
        let (_dir, db) = setup();
        // Long enough to pass `length(definition) > 8`, narrow enough that
        // `looks_like_card_blob` says no.
        insert_word(&db, "w1", "recount", "to tell a story", None);
        assert!(pending(&db, 10).unwrap().is_empty());
        assert!(!has_pending(&db.reader()));
    }

    #[tokio::test]
    async fn repairing_the_last_row_retires_the_switch() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "thither", "Meaning in this context\nto that place", None);
        assert!(has_pending(&db.reader()));

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let app = test_app();
        run_backfill(app.handle(), &db, &secrets, 10).await.unwrap();
        // Nothing left to gate, so the console must stop offering a switch
        // for it — a switch that gates nothing is worse than a missing row.
        assert!(!has_pending(&db.reader()));
    }

    #[tokio::test]
    async fn nothing_pending_makes_no_call() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "recount", "讲述、叙述", None);
        let secrets = Secrets::init_in_memory().unwrap();
        let app = test_app();
        // No provider configured: a call would have errored rather than
        // returning Ok(0).
        assert_eq!(run_backfill(app.handle(), &db, &secrets, 10).await.unwrap(), 0);
    }
}
