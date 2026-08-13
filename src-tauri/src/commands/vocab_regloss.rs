//! Regenerating one saved word's definition, because the reader asked for it.
//!
//! Until this existed there was no way to change a saved word's `definition` at
//! all. `add_vocab_word` writes it once; the sync event that carries it is
//! applied with `INSERT OR IGNORE`; the snapshot's `upsert_vocab` leaves
//! `definition` out of its `ON CONFLICT DO UPDATE SET` list. Saving the same
//! word again does not rewrite it, and no replay ever will. A gloss the model
//! got wrong — or one that is merely unhelpful — was permanent.
//!
//! # The card-blob heuristic and the displacement rule
//!
//! This module also carries [`looks_like_card_blob`] and
//! [`displaced_explanation`], the two structural helpers behind the
//! displacement rule below. They originally belonged to a one-time repair job
//! that walked every saved word and re-glossed the ones an early, unreleased
//! version of the app had filled with a whole learning card instead of a
//! short gloss. The app was never distributed while that defect was live, so
//! no user's data ever needed the repair, and the job itself has been
//! removed. The two helpers stayed, because `set_definition` and
//! `sync::merge::apply_vocab_definition` still need to
//! recognise a card-shaped blob wherever one turns up in a `definition`
//! column and park it under `context_explanation` instead of discarding it.
//!
//! # What the write does
//!
//! The write is not merely the same shape, it is the same function:
//! [`vocab::set_definition`](crate::commands::vocab::set_definition). The new
//! gloss goes to `definition`, and the text it displaces moves to
//! `context_explanation` only when that column is empty **and** the displaced
//! text is a card blob — see [`displaced_explanation`] for why the second
//! condition exists. On failure, an empty reply, or no configured provider,
//! the row is left exactly as it was: a bad gloss is bad, a blank one is
//! worse.
//!
//! What differs is the accounting. [`FEATURE`] is not `vocab_gloss` (the save
//! path), and `origin` is `"user"`, not `"auto"`. The auto-analysis console
//! totals a job's spend by `feature` and separates deliberate spend from
//! background spend by `origin`; billing a button the reader pressed as
//! background repair would overstate what the app spends behind their back by
//! exactly what they chose to spend themselves.
//!
//! # Sync
//!
//! The regenerated definition publishes as `vocab.definition.set` and reaches
//! the reader's other devices, which is the channel this module was written
//! without: `VocabAdd` carries a definition but is applied with
//! `INSERT OR IGNORE`, so it can only ever create a row, never correct one.
//! The event carries the new definition only — the receiving device displaces
//! its *own* old text under the same rule this one does.
//!
//! `updated_at` and `updated_by_device` move with the write, reversing what
//! this module originally did. The reasoning is unchanged, only its input:
//! the clock governs the columns that sync, and `definition` is now one of
//! them. See [`vocab::set_definition`](crate::commands::vocab::set_definition)
//! for what that costs when a definition change and a mastery change race.

use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Runtime, State};

use crate::commands::ai::vocabulary::{generate_vocab_gloss, gloss_display_width, MAX_GLOSS_WIDTH};
use crate::commands::vocab::{row_to_vocab, set_definition, VocabWord, SELECT_COLS};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;
use crate::sync::writer::SyncWriter;

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
/// One rule, two callers — this module's own regenerate path and
/// `sync::merge::apply_vocab_definition` — because a definition change now
/// travels between devices and the receiving device must end up with the same
/// two columns the sending one has.
///
/// Two conditions, and the second is narrower than it used to be:
///
/// - **The explanation column is empty.** A reader's own kept analysis is
///   never collateral.
/// - **The displaced text is a card blob.** These blobs come from data an
///   early, unreleased version of the app wrote before the two save paths
///   were unified — the selection menu wrote a short contextual gloss, and
///   the learning card dumped its whole rendered text into `definition`
///   instead. On an ordinary regenerate the displaced text is a previous
///   one-line gloss, and parking *that* under "In context" invents an
///   explanation the reader never asked for out of a sentence they just
///   rejected. `looks_like_card_blob` is exactly the line between the two
///   cases.
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

/// The `ai_usage_records.feature` tag for a reader-pressed regeneration.
///
/// Its own slug on purpose. `vocab_gloss` would hide these calls inside
/// ordinary word saving, and the console would have no separate column to
/// read this regeneration's spend from. `ai::request_counts` folds an
/// unrecognised slug into its honest `other` bucket, so nothing has to be
/// taught about it to keep the reassurance total correct.
pub const FEATURE: &str = "vocab_gloss_regenerate";

/// Regenerate the definition of one saved word, and return the row as it now
/// stands so the caller can render both columns it may have touched.
#[tauri::command]
pub async fn regenerate_vocab_definition(
    id: String,
    locale: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
    sync: State<'_, SyncWriter>,
) -> AppResult<VocabWord> {
    regenerate_vocab_definition_inner(&app, &db, &secrets, &sync, &id, locale.as_deref()).await
}

pub(crate) async fn regenerate_vocab_definition_inner<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    sync: &SyncWriter,
    id: &str,
    locale: Option<&str>,
) -> AppResult<VocabWord> {
    let (word, context_sentence) = read_row(db, id)?;

    // No cancel surface for this call — the button is one round trip and the
    // reader's recourse is to press it again — so the id exists only to satisfy
    // the router's per-request bookkeeping.
    let request_id = uuid::Uuid::new_v4().to_string();
    let gloss = generate_vocab_gloss(
        app,
        db,
        secrets,
        &word,
        context_sentence.as_deref(),
        locale,
        &request_id,
        "user",
        FEATURE,
    )
    .await?;
    let gloss = gloss.trim();
    if gloss.is_empty() {
        // A blank reply is a failed gloss, not a gloss of nothing. Writing it
        // would destroy the definition the reader still has.
        return Err(AppError::Ai("VOCAB_GLOSS_EMPTY".to_string()));
    }

    let now = chrono::Utc::now().timestamp_millis();
    if !set_definition(db, sync, id, gloss, now)? {
        // Deleted while the model was thinking. Nothing written, nothing
        // published, and the row the caller wanted to render is gone.
        return Err(AppError::Other("VOCAB_WORD_NOT_FOUND".to_string()));
    }
    read_word(db, id)
}

fn read_row(db: &Db, id: &str) -> AppResult<(String, Option<String>)> {
    let conn = db.reader();
    conn.query_row(
        "SELECT word, context_sentence FROM vocab_words WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::Other("VOCAB_WORD_NOT_FOUND".to_string()))
}

fn read_word(db: &Db, id: &str) -> AppResult<VocabWord> {
    let conn = db.reader();
    conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM vocab_words WHERE id = ?1"),
        params![id],
        row_to_vocab,
    )
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
    fn the_card_shaped_definition_this_heuristic_exists_for_is_matched() {
        let blob = "Meaning in this context\nThe narrator uses \"recount\" to mean telling a \
                    story in order, not counting again.\n\nExamples\n- He recounted the voyage.";
        assert!(looks_like_card_blob(blob));
    }

    // A repaired row must never be picked up again, or a regenerate would
    // treat its own output as a blob on the very next pass.
    #[test]
    fn a_gloss_this_module_would_produce_never_matches_again() {
        let repaired = crate::commands::ai::vocabulary::sanitize_gloss(
            "Meaning in this context\nA long explanation follows.",
        );
        assert!(!looks_like_card_blob(&repaired));
    }

    // --- the displacement rule ---

    #[test]
    fn only_a_blob_is_parked_under_the_explanation() {
        let blob = "Meaning in this context\nto that place, in older English.";
        assert_eq!(displaced_explanation(blob, None).as_deref(), Some(blob));
        // An explanation already there is never overwritten.
        assert_eq!(displaced_explanation(blob, Some("kept")), None);
        assert_eq!(
            displaced_explanation(blob, Some("  ")).as_deref(),
            Some(blob)
        );
        // An ordinary gloss is discarded rather than filed.
        assert_eq!(displaced_explanation("到那里", None), None);
    }

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

    /// A mock app plus a writer in queue-only mode, so a test can read what
    /// this command published out of `_pending_publish`.
    fn test_app() -> (tauri::App<tauri::test::MockRuntime>, SyncWriter) {
        let sync = SyncWriter::new("dev-A".into());
        sync.set_should_queue(true);
        (tauri::test::mock_app(), sync)
    }

    /// Every event the writer parked, newest last.
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

    fn insert_word(db: &Db, id: &str, definition: &str, explanation: Option<&str>) -> i64 {
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO vocab_words
                (id, book_id, word, definition, context_sentence, context_explanation,
                 cfi, mastery, review_count, created_at, updated_at, updated_by_device)
             VALUES (?1, 'book1', 'thither', ?2, 'She went thither at once.', ?3,
                 'epubcfi(/6/4!/4/2)', 'new', 0, ?4, ?4, 'test')",
            params![id, definition, explanation, now],
        )
        .unwrap();
        now
    }

    fn row(db: &Db, id: &str) -> (String, Option<String>, i64, String) {
        let conn = db.reader();
        conn.query_row(
            "SELECT definition, context_explanation, updated_at, updated_by_device
             FROM vocab_words WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
    }

    /// Serves `body` to every connection, not just the first.
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
    async fn the_new_gloss_replaces_the_old_one_and_the_old_one_is_kept() {
        let (_dir, db) = setup();
        let blob = "Meaning in this context\nto that place, in older English.";
        insert_word(&db, "w1", blob, None);

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let (app, sync) = test_app();
        let updated =
            regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "w1", None)
                .await
                .unwrap();
        assert_eq!(updated.definition, "到那里");
        assert_eq!(updated.context_explanation.as_deref(), Some(blob));
        let (definition, explanation, _, _) = row(&db, "w1");
        assert_eq!(definition, "到那里");
        assert_eq!(explanation.as_deref(), Some(blob));
    }

    /// The one rule shared with the backfill that has teeth: the reader's own
    /// kept analysis is never collateral.
    #[tokio::test]
    async fn an_existing_explanation_is_never_overwritten() {
        let (_dir, db) = setup();
        insert_word(
            &db,
            "w1",
            "to that place",
            Some("the reader's own kept analysis"),
        );

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let (app, sync) = test_app();
        regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "w1", None)
            .await
            .unwrap();
        let (definition, explanation, _, _) = row(&db, "w1");
        assert_eq!(definition, "到那里");
        assert_eq!(
            explanation.as_deref(),
            Some("the reader's own kept analysis")
        );
    }

    /// Pressing twice must not walk the previous gloss into the explanation
    /// the first press rescued.
    #[tokio::test]
    async fn a_second_press_only_moves_the_definition() {
        let (_dir, db) = setup();
        let blob = "Meaning in this context\nto that place";
        insert_word(&db, "w1", blob, None);

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let (app, sync) = test_app();
        regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "w1", None)
            .await
            .unwrap();
        regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "w1", None)
            .await
            .unwrap();
        let (definition, explanation, _, _) = row(&db, "w1");
        assert_eq!(definition, "到那里");
        assert_eq!(explanation.as_deref(), Some(blob));
    }

    #[tokio::test]
    async fn no_configured_provider_leaves_the_row_alone_and_says_so() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "to that place", None);

        let secrets = Secrets::init_in_memory().unwrap();
        let (app, sync) = test_app();
        let error =
            regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "w1", None)
                .await
                .unwrap_err();
        // Something the UI can show, rather than a silent no-op.
        assert!(!error.to_string().is_empty());
        let (definition, explanation, _, _) = row(&db, "w1");
        assert_eq!(definition, "to that place");
        assert_eq!(explanation, None);
    }

    #[tokio::test]
    async fn an_empty_reply_is_not_written_over_the_definition() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "to that place", None);

        let base_url = fake_sse_server(sse_answer("   ")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let (app, sync) = test_app();
        let error =
            regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "w1", None)
                .await
                .unwrap_err();
        assert!(error.to_string().contains("VOCAB_GLOSS_EMPTY"));
        let (definition, explanation, _, _) = row(&db, "w1");
        assert_eq!(definition, "to that place");
        assert_eq!(explanation, None);
    }

    #[tokio::test]
    async fn a_word_that_is_gone_is_an_error_not_a_call() {
        let (_dir, db) = setup();
        let secrets = Secrets::init_in_memory().unwrap();
        let (app, sync) = test_app();
        // No provider configured: reaching the AI call would have produced a
        // different error than this one.
        let error =
            regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "gone", None)
                .await
                .unwrap_err();
        assert!(error.to_string().contains("VOCAB_WORD_NOT_FOUND"));
    }

    /// Deliberate spend, billed as deliberate. `origin = "auto"` here would
    /// report the reader's own button press as something the app did behind
    /// their back; the backfill job's id in `feature` would charge the job for
    /// it.
    #[tokio::test]
    async fn the_call_is_billed_as_a_reader_action_under_its_own_feature() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "to that place", None);

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let (app, sync) = test_app();
        regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "w1", None)
            .await
            .unwrap();

        let conn = db.reader();
        let (origin, feature): (String, String) = conn
            .query_row("SELECT origin, feature FROM ai_usage_records", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(origin, "user");
        assert_eq!(feature, FEATURE);
        assert_ne!(feature, "vocab_gloss");
    }

    /// Reversal of `the_sync_clock_is_left_where_it_was`, which asserted the
    /// opposite until `vocab.definition.set` existed. That test was right on
    /// its own premise — the clock governs the columns that sync, and
    /// `definition` did not — and wrong the moment the premise changed. A
    /// device that publishes a definition without stamping the row advertises
    /// a change its own clock denies, and the next snapshot from a peer hands
    /// the old text back.
    #[tokio::test]
    async fn the_sync_clock_moves_with_the_definition_now_that_it_travels() {
        let (_dir, db) = setup();
        let created = insert_word(&db, "w1", "to that place", None);

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let (app, sync) = test_app();
        regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "w1", None)
            .await
            .unwrap();
        let (_, _, updated_at, device) = row(&db, "w1");
        assert!(updated_at >= created);
        assert_eq!(device, "dev-A");
    }

    /// The whole point: the reader's other devices hear about it.
    #[tokio::test]
    async fn the_new_definition_is_published() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "to that place", None);

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let (app, sync) = test_app();
        regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "w1", None)
            .await
            .unwrap();

        let published = published(&db);
        assert_eq!(published.len(), 1, "expected one event, got {published:?}");
        assert!(
            published[0].contains(r#""type":"vocab.definition.set""#)
                && published[0].contains(r#""definition":"到那里""#),
            "unexpected event body: {published:?}"
        );
        // The displaced text stays home — the receiving device holds its own
        // copy and displaces that instead.
        assert!(
            !published[0].contains("context_explanation"),
            "the payload must not carry the explanation column: {published:?}"
        );
    }

    /// The narrowed displacement rule. Rewording a gloss that was already a
    /// gloss leaves nothing worth keeping, and parking the rejected sentence
    /// under "In context" would invent an explanation out of it.
    #[tokio::test]
    async fn an_ordinary_gloss_is_not_parked_under_the_explanation() {
        let (_dir, db) = setup();
        insert_word(&db, "w1", "to that place", None);

        let base_url = fake_sse_server(sse_answer("到那里")).await;
        let secrets = Secrets::init_in_memory().unwrap();
        configure_provider(&db, &secrets, base_url);

        let (app, sync) = test_app();
        regenerate_vocab_definition_inner(app.handle(), &db, &secrets, &sync, "w1", None)
            .await
            .unwrap();
        let (definition, explanation, _, _) = row(&db, "w1");
        assert_eq!(definition, "到那里");
        assert_eq!(explanation, None);
    }
}
