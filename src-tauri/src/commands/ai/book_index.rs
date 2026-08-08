//! The book index and its summaries: building it, reporting its state, and the
//! commands that let the reader inspect and edit what was written.

use rusqlite::OptionalExtension;
use tauri::{AppHandle, Emitter, State};

use crate::ai::grounding::{self, IndexStatus};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

#[tauri::command]
pub async fn ai_reindex_book(book_id: String, db: State<'_, Db>) -> AppResult<IndexStatus> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || grounding::index::force_reindex(&db, &book_id))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub fn ai_prepare_book(
    book_id: String,
    request_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    crate::ai::router::register_request(&request_id);
    let db = db.inner().clone();
    let secrets = secrets.inner().clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = grounding::summarize::generate_book_summaries(
            &task_app,
            &db,
            &secrets,
            &book_id,
            &request_id,
            false,
        )
        .await
        {
            if !error.to_string().contains("AI_REQUEST_CANCELLED") {
                let event_name = format!("ai-summary-progress-{book_id}");
                let _ = task_app.emit(
                    &event_name,
                    serde_json::json!({ "done": 0, "total": 0, "phase": "error" }),
                );
                log::warn!("book overview generation failed for {book_id}: {error}");
            }
        }
        crate::ai::router::finish_request(&request_id);
    });
    Ok(())
}

#[tauri::command]
pub fn get_book_ai_state(
    book_id: String,
    db: State<'_, Db>,
) -> AppResult<grounding::summarize::BookAiState> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    grounding::summarize::get_book_ai_state(&db, &book_id)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexChunkView {
    index: i64,
    section_title: Option<String>,
    snippet: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummaryView {
    section_index: Option<i64>,
    section_title: Option<String>,
    content: String,
    user_edited: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookIndexDetails {
    status: grounding::index::IndexStatus,
    error: Option<String>,
    chunk_count: i64,
    embedded_count: i64,
    embedding_model: Option<String>,
    indexed_at: Option<i64>,
    overview: Option<IndexSummaryView>,
    sections: Vec<IndexSummaryView>,
    chunks: Vec<IndexChunkView>,
}

#[tauri::command]
pub fn ai_index_details(book_id: String, db: State<'_, Db>) -> AppResult<BookIndexDetails> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    let status = grounding::index::index_status(&db, &book_id)?;
    let conn = db.reader();
    let state = conn
        .query_row(
            "SELECT error, chunk_count, indexed_at FROM book_index_state WHERE book_id = ?1",
            rusqlite::params![book_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let configured_model = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'ai_embedding_model'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let embedded_count = conn.query_row(
        "SELECT COUNT(*) FROM book_chunk_embeddings WHERE book_id = ?1 AND (?2 IS NULL OR model = ?2)",
        rusqlite::params![book_id, configured_model],
        |row| row.get(0),
    )?;
    let embedding_model = configured_model;
    let mut summary_statement = conn.prepare(
        "SELECT scope, section_index, section_title, content, user_edited
         FROM book_summaries WHERE book_id = ?1 ORDER BY scope, section_index",
    )?;
    let summaries = summary_statement
        .query_map(rusqlite::params![book_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                IndexSummaryView {
                    section_index: row.get(1)?,
                    section_title: row.get(2)?,
                    content: row.get(3)?,
                    user_edited: row.get::<_, i64>(4)? != 0,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut chunk_statement = conn.prepare(
        "SELECT chunk_index, section_title, snippet FROM book_chunks
         WHERE book_id = ?1 ORDER BY chunk_index LIMIT 200",
    )?;
    let chunks = chunk_statement
        .query_map(rusqlite::params![book_id], |row| {
            Ok(IndexChunkView {
                index: row.get(0)?,
                section_title: row.get(1)?,
                snippet: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let (error, chunk_count, indexed_at) = state.unwrap_or((None, 0, 0));
    Ok(BookIndexDetails {
        status,
        error,
        chunk_count,
        embedded_count,
        embedding_model,
        indexed_at: (indexed_at > 0).then_some(indexed_at),
        overview: summaries
            .iter()
            .find(|(scope, _)| scope == "book")
            .map(|(_, summary)| summary)
            .cloned(),
        sections: summaries
            .into_iter()
            .filter_map(|(scope, summary)| (scope == "section").then_some(summary))
            .collect(),
        chunks,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexUpdateResult {
    reindexed: bool,
    embeddings_updated: bool,
    summaries_updated: bool,
}

/// The five stages of an incremental index update, in the order they run.
///
/// Named as a type rather than left as progress-event string literals because
/// the step number the reader sees ("第 3 步，共 5 步") is derived from the
/// order here — see `IndexPhase::step`. Two places that each know the running
/// order would eventually disagree about it, and the disagreement would show
/// up as a counter that skips.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexPhase {
    /// Splitting the book into chunks and refreshing the full-text index.
    Chunk,
    /// Writing each chunk's identity sentence (`grounding::context`).
    Context,
    /// Embedding the chunks that are missing or stale (`grounding::vector`).
    Embed,
    /// Section and book overviews (`grounding::summarize`).
    Summarize,
    /// The person-alias pass that reads those overviews
    /// (`grounding::aliases`).
    ///
    /// Its own step rather than the tail of `Summarize`, which is where it
    /// used to be reported. It is a second model pass and takes about as long
    /// as the summaries do, so folding it in left the display parked on
    /// "5/5 · 章节摘要" for minutes with nothing moving — and a progress
    /// display that stops moving is exactly the hang this staged reporting was
    /// built to rule out. Best-effort, like `Context`: a step the reader can
    /// watch fail without consequence is still better than a step they can
    /// only watch stall.
    Aliases,
}

/// How many steps the reader is told the run has. Deliberately a function of
/// the enum rather than a literal `5`.
pub const INDEX_PHASE_COUNT: u8 = IndexPhase::ALL.len() as u8;

impl IndexPhase {
    /// Every phase, in running order. The single source of the step numbering.
    const ALL: [IndexPhase; 5] = [
        Self::Chunk,
        Self::Context,
        Self::Embed,
        Self::Summarize,
        Self::Aliases,
    ];

    /// This phase's 1-based position, for "第 N 步，共 5 步".
    fn step(self) -> u8 {
        Self::ALL
            .iter()
            .position(|phase| *phase == self)
            .expect("every variant is listed in ALL") as u8
            + 1
    }
}

/// Whether the run is still going, and if not, how it ended. A separate axis
/// from `IndexPhase`: an error event still has to say *which* phase failed, so
/// folding "done" and "error" into the phase enum (as the older
/// `ai-summary-progress` payload does) would cost exactly the information the
/// reader most wants when it goes wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexRunState {
    Running,
    Done,
    /// The phase in `IndexProgress::phase` returned an error the run could not
    /// continue past.
    Failed,
    /// The reader stopped it (or stopped the request it was sharing). Split
    /// out from `Failed` because it is not something to apologise for.
    Cancelled,
}

/// One event on `ai-index-progress-{book_id}`.
///
/// Small on purpose: this goes out once per embedded batch and once per
/// identity sentence — a few hundred times for a full book — so it carries
/// counters, not content. Anything the reader might want to *read* is already
/// in the database and reachable through `ai_index_details`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub state: IndexRunState,
    /// The phase the run is in, or — on a terminal event — the phase it was in
    /// when it ended.
    pub phase: IndexPhase,
    pub step: u8,
    pub total_steps: u8,
    /// Units of `phase` finished so far.
    pub done: i64,
    /// Units `phase` has to get through, or `0` when it cannot know in
    /// advance. Chunking is the standing case: it is one indivisible pass over
    /// the book with nothing to count. `Aliases` is the other — it is a single
    /// model call for the whole book (see `aliases::run_build_pass`), so there
    /// is no denominator to report that would not be invented. The summarize
    /// phase reports `0` here too and keeps publishing its own `done`/`total`
    /// on the pre-existing `ai-summary-progress-{book_id}` channel, which the
    /// summary UI already listens to — a second copy of those numbers would be
    /// a second thing to keep in step for no gain.
    pub total: i64,
    /// Present only on a `Done` event: what the run actually changed, which is
    /// what this command used to return before it started returning
    /// immediately.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<IndexUpdateResult>,
    /// Present only on `Failed`: the error, for a log or a details disclosure.
    /// Not a message to show the reader as-is — it is not translated and it is
    /// often a provider's own wording.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl IndexProgress {
    fn running(phase: IndexPhase, done: i64, total: i64) -> Self {
        Self {
            state: IndexRunState::Running,
            phase,
            step: phase.step(),
            total_steps: INDEX_PHASE_COUNT,
            done,
            total,
            result: None,
            message: None,
        }
    }

    /// The success terminal event. Reported against the last phase with no
    /// counters of its own: `state` is what a listener should switch on, and
    /// a `done`/`total` here would only invite a progress bar to snap to some
    /// arbitrary final ratio.
    fn finished(result: IndexUpdateResult) -> Self {
        Self {
            result: Some(result),
            state: IndexRunState::Done,
            ..Self::running(IndexPhase::Aliases, 0, 0)
        }
    }

    /// The failure terminal event. Cancellation is recognised by the marker
    /// the router puts in the error, the same way `ai_prepare_book` does it.
    fn failed(phase: IndexPhase, error: &AppError) -> Self {
        let cancelled = is_cancellation(error);
        Self {
            state: if cancelled {
                IndexRunState::Cancelled
            } else {
                IndexRunState::Failed
            },
            message: (!cancelled).then(|| error.to_string()),
            ..Self::running(phase, 0, 0)
        }
    }
}

/// The router's "the reader stopped it" marker, which travels inside the error
/// string rather than as a variant of `AppError`. Read in three places here —
/// the terminal event, the two best-effort phases that must not swallow it,
/// and the batch loop — so it is one predicate rather than three copies of a
/// string literal that could drift apart.
fn is_cancellation(error: &AppError) -> bool {
    error.to_string().contains("AI_REQUEST_CANCELLED")
}

fn emit_index_progress(app: &AppHandle, book_id: &str, progress: IndexProgress) {
    let _ = app.emit(&format!("ai-index-progress-{book_id}"), progress);
}

/// Announce a phase before it starts, with no counters yet. Every phase sends
/// one of these even when it goes on to send real numbers, so a listener that
/// joined late learns which step it is on without waiting for the first unit
/// of work to finish — which, in the two phases that call a model per chunk,
/// can be several seconds away.
fn enter_phase(app: &AppHandle, book_id: &str, phase: IndexPhase) {
    emit_index_progress(app, book_id, IndexProgress::running(phase, 0, 0));
}

/// A phase that stopped the run, paired with why. Carried instead of a bare
/// `AppError` so the terminal event can say which of the five steps died.
struct IndexRunFailure {
    phase: IndexPhase,
    error: AppError,
}

impl IndexRunFailure {
    /// For `map_err` at the many fallible points inside one phase, so that
    /// naming the phase stays a single short token at each of them.
    fn at(phase: IndexPhase) -> impl Fn(AppError) -> Self {
        move |error| Self { phase, error }
    }

    /// The reader stopped the run during `phase`. Spelled with the router's
    /// own marker rather than a private variant so it travels through
    /// `IndexProgress::failed` — and so a stop lands on the reader's screen as
    /// the same `cancelled` state whether it interrupted a model call or the
    /// gap between two phases.
    fn cancelled(phase: IndexPhase) -> Self {
        Self {
            phase,
            error: AppError::Other("AI_REQUEST_CANCELLED".to_string()),
        }
    }

    fn is_cancellation(&self) -> bool {
        is_cancellation(&self.error)
    }
}

/// A run's stop switch, handed down to the book it is currently on. `None`
/// only where a caller genuinely has nothing to stop with; both entry points
/// now pass one — see `BOOK_RUNS`.
type StopSignal<'a> = Option<&'a tokio::sync::watch::Receiver<bool>>;

/// Run one phase, but give up on it the moment the reader presses stop.
///
/// Dropping the phase's future *is* the cancellation, and that is safe here
/// for a specific reason rather than by luck: no phase this wraps holds a
/// database transaction open across an await, so a drop can never land
/// mid-write.
///
/// What a drop costs differs by phase, and it is worth knowing which. Identity
/// sentences and embeddings commit as they go — one sentence per chunk, one
/// transaction per embedding batch — so stopping them loses at most the single
/// call in flight. Summaries and person aliases each hold their results in
/// memory and write once at the end, so stopping those loses that phase's
/// calls outright. Neither *deletes* anything on the way in, so the book is
/// never left worse off than before the run; the next run simply pays for
/// those two phases again.
///
/// Without this the stop would only be honoured between books, and the books
/// this batch exists for are the ones that take fifteen minutes each.
async fn race_stop<T>(
    stop: StopSignal<'_>,
    phase: IndexPhase,
    work: impl std::future::Future<Output = Result<T, IndexRunFailure>>,
) -> Result<T, IndexRunFailure> {
    let Some(stop) = stop else {
        return work.await;
    };
    // Checked before the select, not only inside it: `changed()` reports a
    // *new* value, and a stop that arrived during the previous phase is
    // already the current one by the time this phase starts.
    if *stop.borrow() {
        return Err(IndexRunFailure::cancelled(phase));
    }
    let mut stop = stop.clone();
    tokio::select! {
        result = work => result,
        _ = stop.changed() => Err(IndexRunFailure::cancelled(phase)),
    }
}

/// Unregisters a router request id even when the run is dropped part-way
/// through it, which is how a stop lands. Without it every stopped run would
/// leave one entry in the cancellation registry for the life of the process.
struct RequestGuard(String);

impl Drop for RequestGuard {
    fn drop(&mut self) {
        crate::ai::router::finish_request(&self.0);
    }
}

/// Every index run a reader can still stop, keyed by the book it is on.
///
/// One registry for both entry points rather than a second mechanism beside
/// the batch's: the reader's "stop" is aimed at a book, and which of the two
/// buttons started the run on it is not something they can see. A batch enters
/// its own switch here for the length of each book, so a stop pressed in the
/// index manager reaches the run that is actually holding that book — and a
/// library run stopped that way stops as a library run, reporting itself on
/// the settings row exactly as its own stop button would. The alternative,
/// registering only single-book runs, leaves a stop button that is visibly
/// offered and silently does nothing whenever the batch happens to be on the
/// book the reader is looking at.
///
/// A `Vec` because `Vec::new` is const and this holds one entry in almost
/// every real session; a `HashMap` would need a `LazyLock` to buy nothing.
static BOOK_RUNS: std::sync::Mutex<Vec<BookRun>> = std::sync::Mutex::new(Vec::new());

/// Hands out the `run_id` below. Only ever incremented.
static NEXT_BOOK_RUN_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct BookRun {
    book_id: String,
    /// Ties the entry to one run rather than to the book, so a guard that
    /// drops late cannot unregister the run that replaced it.
    run_id: u64,
    /// `Arc` because `tokio::sync::watch::Sender` is not `Clone` and the batch
    /// has to keep its own handle on the very switch it lends out here.
    stop: std::sync::Arc<tokio::sync::watch::Sender<bool>>,
}

/// Removes the run from `BOOK_RUNS` when it ends, including when it ends by
/// being dropped part-way through — which is how a stop lands. Without it a
/// stopped run would leave a switch behind that the next press would flip to
/// no effect.
struct BookRunGuard(u64);

impl Drop for BookRunGuard {
    fn drop(&mut self) {
        if let Ok(mut runs) = BOOK_RUNS.lock() {
            runs.retain(|run| run.run_id != self.0);
        }
    }
}

fn register_book_run(
    book_id: &str,
    stop: std::sync::Arc<tokio::sync::watch::Sender<bool>>,
) -> BookRunGuard {
    let run_id = NEXT_BOOK_RUN_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut runs) = BOOK_RUNS.lock() {
        runs.push(BookRun {
            book_id: book_id.to_string(),
            run_id,
            stop,
        });
    }
    BookRunGuard(run_id)
}

/// Stop whatever index run is holding this book, at the earliest point the
/// phase in flight can be abandoned without losing committed work — see
/// `race_stop`. A no-op when nothing is running on it.
///
/// Deliberately takes a book rather than a request id. The summaries phase
/// mints its own router request internally, and surfacing that id so the UI
/// could pass it to `ai_cancel` would have made the stop button work only
/// while step 4 of 5 was in flight, and only after the id had made it to the
/// front end — a control that is dead for most of the run it belongs to.
#[tauri::command]
pub fn ai_stop_book_index(book_id: String) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    if let Ok(runs) = BOOK_RUNS.lock() {
        // Every match, not the first: nothing stops two windows asking for the
        // same book at once, and a stop that left one of them going would look
        // like a button that did not work.
        for run in runs.iter().filter(|run| run.book_id == book_id) {
            run.stop.send_replace(true);
        }
    }
    Ok(())
}

/// Kick off an incremental index update and return at once.
///
/// Returning the result was the old shape, and it meant the promise stayed
/// unresolved for the fifteen minutes a six-hundred-chunk book takes — with
/// nothing on the wire in between, so the reader had a spinner and no way to
/// tell a slow run from a wedged one. The work now runs in a task that
/// publishes `ai-index-progress-{book_id}` as it goes, and what used to be the
/// return value rides the terminal event instead. Errors go the same way:
/// there is no promise left to reject.
#[tauri::command]
pub fn ai_update_book_index(
    book_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    // Everything that reads the database happens inside the task. This
    // command body itself runs on the main thread — it has no `async` — so
    // all it may do is clone handles and hand them over.
    let db = db.inner().clone();
    let secrets = secrets.inner().clone();
    // Its own switch, minted here and published for the length of the run, so
    // that `ai_stop_book_index` has something to flip. Created before the
    // spawn rather than inside it: a stop pressed in the moment between the
    // command returning and the task being scheduled would otherwise find no
    // entry and be swallowed.
    let (sender, stop) = tokio::sync::watch::channel(false);
    let run = register_book_run(&book_id, std::sync::Arc::new(sender));
    tauri::async_runtime::spawn(async move {
        // Moved in so it unregisters when the run ends, however it ends.
        let _run = run;
        let _ = run_and_report(&app, &db, &secrets, &book_id, Some(&stop)).await;
    });
    Ok(())
}

/// Run one book's update and publish its terminal event on that book's own
/// channel, whatever the outcome.
///
/// Split out from the command because the whole-library batch has to do this
/// too: the index manager may well be open on the very book the batch has
/// reached, and it listens on `ai-index-progress-{book_id}` — a batch that
/// stayed silent there would leave that window on a spinner it could never
/// clear.
async fn run_and_report(
    app: &AppHandle,
    db: &Db,
    secrets: &Secrets,
    book_id: &str,
    stop: StopSignal<'_>,
) -> Result<IndexUpdateResult, IndexRunFailure> {
    let outcome = run_index_update(app, db, secrets, book_id, stop).await;
    match &outcome {
        Ok(result) => emit_index_progress(app, book_id, IndexProgress::finished(result.clone())),
        Err(failure) => {
            let progress = IndexProgress::failed(failure.phase, &failure.error);
            // A run the reader cancelled is not a fault and does not belong in
            // the log; the event still goes out either way, or the UI would
            // sit on a spinner it can never clear.
            if progress.state == IndexRunState::Failed {
                log::warn!(
                    "index update for {book_id} failed in {:?}: {}",
                    failure.phase,
                    failure.error
                );
            }
            emit_index_progress(app, book_id, progress);
        }
    }
    outcome
}

async fn run_index_update(
    app: &AppHandle,
    db: &Db,
    secrets: &Secrets,
    book_id: &str,
    stop: StopSignal<'_>,
) -> Result<IndexUpdateResult, IndexRunFailure> {
    let before =
        index_state_fingerprint(db, book_id).map_err(IndexRunFailure::at(IndexPhase::Chunk))?;
    enter_phase(app, book_id, IndexPhase::Chunk);
    let db_owned = db.clone();
    let book_owned = book_id.to_string();
    // Chunking is CPU and SQLite, not network, and it holds the write
    // connection for the whole pass — `spawn_blocking` keeps it off the async
    // runtime's worker threads, which the three phases after it need.
    let status = tauri::async_runtime::spawn_blocking(move || {
        grounding::index::ensure_index(&db_owned, &book_owned)
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))
    .and_then(|status| status)
    .map_err(IndexRunFailure::at(IndexPhase::Chunk))?;
    let mut embeddings_updated = false;
    if status == grounding::index::IndexStatus::Ready {
        // One reporter per phase, built from the phase it belongs to, so the
        // two long loops below cannot end up publishing under each other's
        // step number.
        let reporter = |phase: IndexPhase| {
            move |done: usize, total: usize| {
                emit_index_progress(
                    app,
                    book_id,
                    IndexProgress::running(phase, done as i64, total as i64),
                )
            }
        };
        // Stage ② is a best-effort enhancement to the searches downstream of
        // it, not a precondition for either: a book with no identity
        // sentences (switch off, no chat provider configured, a mid-book
        // failure) must stay exactly as searchable as it is today, so its
        // error is logged and swallowed rather than propagated. Its progress
        // events still went out, so the reader sees where it stopped.
        //
        // It deliberately runs outside the embedding check below. It used to
        // sit inside it, back when the sentence only ever prefixed what went
        // to the embedding model — no embedding source meant nothing read it.
        // It now also fills `seg_context` in the full-text index, which every
        // reader has whether or not they have configured an embedding
        // provider, so gating it on one would withhold the feature from the
        // readers it can help with no embedding setup at all.
        enter_phase(app, book_id, IndexPhase::Context);
        let report = reporter(IndexPhase::Context);
        let fail = IndexRunFailure::at(IndexPhase::Context);
        let context = async {
            grounding::context::ensure_context_lines(app, db, secrets, book_id, Some(&report))
                .await
                .map_err(fail)
        };
        // A stop is the one error this phase may not swallow: swallowing it
        // would let the run walk straight on into the next phase, which is
        // not what the reader asked for.
        if let Err(failure) = race_stop(stop, IndexPhase::Context, context).await {
            if failure.is_cancellation() {
                return Err(failure);
            }
            log::warn!(
                "grounding context line generation failed for {book_id}: {}",
                failure.error
            );
        }
        enter_phase(app, book_id, IndexPhase::Embed);
        let report = reporter(IndexPhase::Embed);
        let fail = IndexRunFailure::at(IndexPhase::Embed);
        if let Some(source) = grounding::vector::source(db, secrets).map_err(&fail)? {
            let complete =
                grounding::vector::has_complete_embeddings(db, book_id, &source).map_err(&fail)?;
            if !complete {
                let embed = async {
                    grounding::vector::ensure_embeddings(db, book_id, &source, Some(&report))
                        .await
                        .map_err(&fail)
                };
                race_stop(stop, IndexPhase::Embed, embed).await?;
                embeddings_updated = true;
            }
            // Description aliases the reader taught by hand get their vectors
            // here too — but only the ones that are missing or were computed
            // under a different model, which is the one situation the indexing
            // pipeline is allowed to touch them at all. Teaching an alias
            // embeds it inline, in the conversation, in about one round trip
            // (`aliases::teach_description_alias`); this is the sweep for the
            // rows that call could not finish, plus the recompute when the
            // reader changes the embedding model.
            //
            // Outside the `!complete` gate on purpose. An alias taught while
            // the endpoint was down leaves the chunk embeddings perfectly
            // complete, so gating on them would strand exactly the rows this
            // is here to rescue. Not raced against `stop` and not reported as
            // progress either: it is a handful of short strings, usually zero,
            // and giving it a phase would tell the reader something is being
            // rebuilt when nothing is.
            if let Err(error) =
                grounding::vector::ensure_alias_embeddings(db, book_id, &source).await
            {
                log::warn!("alias embeddings for {book_id} could not be filled in: {error}");
            }
        }
    }
    let summaries_updated = if status == grounding::index::IndexStatus::Ready {
        enter_phase(app, book_id, IndexPhase::Summarize);
        let fail = IndexRunFailure::at(IndexPhase::Summarize);
        let state = grounding::summarize::get_book_ai_state(db, book_id).map_err(&fail)?;
        if !state.has_summaries || state.summaries_stale {
            let request_id = format!("index-update-{}", uuid::Uuid::new_v4());
            crate::ai::router::register_request(&request_id);
            // Held across the await so that a stop, which drops that future
            // rather than returning through it, still unregisters the id.
            let _request = RequestGuard(request_id.clone());
            let summaries = async {
                grounding::summarize::generate_book_summaries(
                    app,
                    db,
                    secrets,
                    book_id,
                    &request_id,
                    false,
                )
                .await
                .map_err(&fail)
            };
            race_stop(stop, IndexPhase::Summarize, summaries).await?;
            true
        } else {
            false
        }
    } else {
        false
    };
    if status == grounding::index::IndexStatus::Ready {
        // Runs after the summaries block above, not alongside the context-line
        // call earlier in this function: the build pass reads `book_summaries`
        // (see `aliases::run_build_pass`'s doc comment on why it reuses them
        // instead of rereading the book), so it needs the pass above to have
        // already run at least once. Same best-effort swallow as context
        // lines — a book with no aliases table entry is exactly as searchable
        // as it always was, just without the cross-language shortcut.
        enter_phase(app, book_id, IndexPhase::Aliases);
        let fail = IndexRunFailure::at(IndexPhase::Aliases);
        let aliases = async {
            grounding::aliases::ensure_person_aliases(app, db, secrets, book_id)
                .await
                .map_err(fail)
        };
        if let Err(failure) = race_stop(stop, IndexPhase::Aliases, aliases).await {
            if failure.is_cancellation() {
                return Err(failure);
            }
            log::warn!("person alias build failed for {book_id}: {}", failure.error);
        }
    }
    let after =
        index_state_fingerprint(db, book_id).map_err(IndexRunFailure::at(IndexPhase::Aliases))?;
    Ok(IndexUpdateResult {
        reindexed: before != after,
        embeddings_updated,
        summaries_updated,
    })
}

/// What "did the index itself change?" is decided on — read once before the
/// run and once after. Not the chunk count: a re-chunk that happens to land on
/// the same number of chunks is still a re-chunk.
type IndexStateFingerprint = Option<(Option<String>, i64, i64)>;

fn index_state_fingerprint(db: &Db, book_id: &str) -> AppResult<IndexStateFingerprint> {
    let conn = db.reader();
    Ok(conn
        .query_row(
            "SELECT source_sha256, index_version, indexed_at FROM book_index_state WHERE book_id = ?1",
            rusqlite::params![book_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?)
}

fn update_summary_content(
    db: &Db,
    sync: &crate::sync::writer::SyncWriter,
    book_id: &str,
    section_index: Option<i64>,
    content: String,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(book_id)?;
    let content = content.trim().to_string();
    if content.is_empty() || content.chars().count() > 20_000 {
        return Err(AppError::Other("AI_SUMMARY_CONTENT_INVALID".to_string()));
    }
    let now = chrono::Utc::now().timestamp_millis();
    sync.with_tx(db, now, |tx, events| {
        let row = tx
            .query_row(
                "SELECT id, scope, section_title, language, model, source_sha256, created_at
                 FROM book_summaries WHERE book_id = ?1 AND scope = ?2
                   AND COALESCE(section_index, -1) = COALESCE(?3, -1)",
                rusqlite::params![book_id, if section_index.is_some() { "section" } else { "book" }, section_index],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, String>(5)?, row.get::<_, i64>(6)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::Other("AI_SUMMARY_NOT_FOUND".to_string()))?;
        tx.execute(
            "UPDATE book_summaries SET content = ?1, updated_at = ?2, user_edited = 1 WHERE id = ?3",
            rusqlite::params![content, now, row.0],
        )?;
        events.push(crate::sync::events::EventBody::BookSummaryUpsert(
            crate::sync::events::BookSummaryPayload {
                id: row.0,
                book_id: book_id.to_string(),
                scope: row.1,
                section_index,
                section_title: row.2,
                content: content.clone(),
                language: row.3,
                model: row.4,
                source_sha256: row.5,
                created_at: row.6,
                updated_at: now,
                user_edited: true,
            },
        ));
        Ok(())
    })
}

#[tauri::command]
pub fn update_book_overview(
    book_id: String,
    content: String,
    db: State<'_, Db>,
    sync: State<'_, crate::sync::writer::SyncWriter>,
) -> AppResult<()> {
    update_summary_content(&db, &sync, &book_id, None, content)
}

#[tauri::command]
pub fn update_book_section_summary(
    book_id: String,
    section_index: i64,
    content: String,
    db: State<'_, Db>,
    sync: State<'_, crate::sync::writer::SyncWriter>,
) -> AppResult<()> {
    update_summary_content(&db, &sync, &book_id, Some(section_index), content)
}

#[tauri::command]
pub fn get_book_overview(
    book_id: String,
    db: State<'_, Db>,
) -> AppResult<Option<grounding::summarize::BookOverview>> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    grounding::summarize::load_book_overview(&db, &book_id)
}

#[tauri::command]
pub async fn ai_regenerate_book_summaries(
    book_id: String,
    request_id: String,
    overwrite_edited: Option<bool>,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    crate::ai::router::register_request(&request_id);
    let result = grounding::summarize::generate_book_summaries(
        &app,
        &db,
        &secrets,
        &book_id,
        &request_id,
        overwrite_edited.unwrap_or(false),
    )
    .await;
    crate::ai::router::finish_request(&request_id);
    result
}

/// What the context-lines row in settings should show. `None` means "nothing
/// to report" — no run in flight, no book left with gaps — and the row falls
/// back to its plain state.
///
/// `async`, and not for its own sake: a `#[tauri::command] fn` without it runs
/// its whole body inline on the main thread, and this one is polled every two
/// seconds while an index update is running. Its two queries are aggregates
/// over `book_chunks` — the table holding every book's full text, with no
/// index on `context_line` — and each has to wait for the read connection's
/// mutex, which the same index update keeps taking to load chunks. Every
/// millisecond of that landed on the event loop, which is why the app looked
/// frozen for a quarter of an hour rather than merely busy. Moving it off the
/// main thread costs nothing and is the whole fix.
#[tauri::command]
pub async fn context_line_progress(
    db: State<'_, Db>,
) -> AppResult<Option<grounding::context::ContextLineProgress>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || grounding::context::current_progress(&db))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

/// Picks a book's context-line generation back up from where it stopped.
///
/// The gaps this clears are the `''` sentinel — chunks an earlier run already
/// asked about and got nothing usable for. An automatic run deliberately
/// never retries those; this is the reader saying to try them again, so it is
/// also the only place allowed to clear them.
///
/// Embeddings follow in the same task: a context line that never reaches
/// `book_chunk_embeddings` changes nothing about what the search can find.
#[tauri::command]
pub fn resume_context_lines(
    book_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    grounding::context::clear_failed_context_lines(&db, &book_id)?;
    let db = db.inner().clone();
    let secrets = secrets.inner().clone();
    tauri::async_runtime::spawn(async move {
        // No progress callback: this resume is driven from the settings row,
        // which reads `context_line_progress` on its own poll rather than
        // listening to a book's index channel.
        if let Err(error) =
            grounding::context::ensure_context_lines(&app, &db, &secrets, &book_id, None).await
        {
            log::warn!("resuming context lines for {book_id} failed: {error}");
        }
        // Re-embedding is what makes the new sentences count; `context_sha256`
        // means only the chunks that actually changed are re-sent.
        match grounding::vector::source(&db, &secrets) {
            Ok(Some(source)) => {
                if let Err(error) =
                    grounding::vector::ensure_embeddings(&db, &book_id, &source, None).await
                {
                    log::warn!("re-embedding after context resume failed: {error}");
                }
            }
            Ok(None) => {}
            Err(error) => log::warn!("no embedding source after context resume: {error}"),
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Whole-library batch
// ---------------------------------------------------------------------------

/// Where the outer, book-by-book level of a whole-library run is published.
///
/// One channel for the whole app rather than one per run: only one batch can
/// be in flight at a time (see `BATCH_RUN`), and a listener that had to know a
/// run id before it could subscribe could not attach to a run that started
/// while the settings modal was closed — which is the normal case, since the
/// copy on that row invites the reader to close it.
///
/// The *inner* level — which chunk of the current book — is deliberately not
/// here. It keeps going out on `ai-index-progress-{book_id}`, the same channel
/// the single-book run uses, so the two entry points produce one stream of
/// per-book progress instead of two that could disagree.
pub const BATCH_PROGRESS_EVENT: &str = "ai-index-all-progress";

/// Where one book stands in a whole-library run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchBookState {
    /// Not reached yet — and also where a book goes back to when the reader
    /// stops the run while it is the one in flight. It is neither finished nor
    /// broken; whatever its phases committed before the stop is kept, and the
    /// next run picks it up from there.
    Pending,
    Running,
    Done,
    /// This book alone failed. The run carried on past it — that is the whole
    /// point of tracking state per book rather than for the run as a whole.
    Failed,
}

/// One row of the batch's book list.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchBookStatus {
    pub book_id: String,
    /// Carried in the payload rather than looked up by the UI: the list is the
    /// only place these books appear together, and a second round trip per row
    /// to name them would be a query per book for text the batch already had
    /// in hand when it built the list.
    pub title: String,
    pub state: BatchBookState,
    /// Present only on `Failed`. Same caveat as `IndexProgress::message`: not
    /// translated, often a provider's own wording, meant for a details
    /// disclosure rather than to be shown as-is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// How many chunks the finished book ended up with. Present only on
    /// `Done`, and read here — where the run has just decided the book is
    /// finished — rather than fetched per row by the UI, which would be a
    /// query per book for a number this side already has to look at.
    ///
    /// It is on the wire because `ensure_index` puts no floor on it: any
    /// non-empty extraction is written as `ready`, so a nine-hundred-page book
    /// whose parser choked on the container comes back a success with twelve
    /// chunks in it. Nothing downstream notices — the reader finds out weeks
    /// later, as "the AI cannot answer anything about this book". Next to a
    /// column of books reading in the hundreds and thousands, a twelve is
    /// visibly wrong at a glance, which is the cheapest detector available for
    /// a failure mode that otherwise has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_count: Option<i64>,
}

/// One event on `BATCH_PROGRESS_EVENT`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchIndexProgress {
    /// Reuses the per-book run state so a listener switches on the same four
    /// strings at both levels. `Failed` never appears here: one book failing
    /// is a row on that book, not an end to the run.
    pub state: IndexRunState,
    /// 1-based position of the book in flight, or `0` when none is — before
    /// the first book, and on every terminal event.
    pub current: usize,
    pub total: usize,
    /// Every book this run set out to do, in the order it takes them, each
    /// carrying its own outcome. The terminal event therefore names the failed
    /// books by id, which is what the "retry the failed ones" button submits
    /// back through `ai_index_all_books`.
    pub books: Vec<BatchBookStatus>,
}

impl BatchIndexProgress {
    fn new(books: Vec<BatchBookStatus>) -> Self {
        Self {
            state: IndexRunState::Running,
            current: 0,
            total: books.len(),
            books,
        }
    }

    fn start_book(&mut self, position: usize) {
        self.current = position + 1;
        self.books[position].state = BatchBookState::Running;
        self.books[position].message = None;
        self.books[position].chunk_count = None;
    }

    fn finish_book(&mut self, position: usize, verdict: BookVerdict) {
        self.books[position].state = verdict.state;
        self.books[position].message = verdict.message;
        self.books[position].chunk_count = verdict.chunk_count;
    }

    /// The reader stopped the run while this book was in flight. Back to
    /// `Pending`, not `Failed`: nothing is wrong with it, and the next run has
    /// to be told to visit it again.
    fn interrupt_book(&mut self, position: usize) {
        self.books[position].state = BatchBookState::Pending;
        self.books[position].message = None;
        self.books[position].chunk_count = None;
    }

    /// The terminal event. `current` drops to `0` because no book is in
    /// flight, and the run-level state says only whether the reader stopped
    /// it — the per-book rows carry everything else, including which books
    /// never got their turn.
    fn finish_run(&mut self, cancelled: bool) {
        self.current = 0;
        self.state = if cancelled {
            IndexRunState::Cancelled
        } else {
            IndexRunState::Done
        };
    }
}

/// The run in flight, or the one that finished most recently.
///
/// Kept after it ends on purpose. The row invites the reader to close settings
/// and let the run continue, so the state they come back to has to be
/// reconstructable from something other than an event they were not listening
/// for — that is what `ai_index_all_books_status` reads.
struct BatchRun {
    /// `Arc` so the same switch can also be lent to `BOOK_RUNS` for the length
    /// of each book, which is what lets a stop pressed on one book's index
    /// manager reach the library run that is holding it.
    stop: std::sync::Arc<tokio::sync::watch::Sender<bool>>,
    progress: BatchIndexProgress,
}

static BATCH_RUN: std::sync::Mutex<Option<BatchRun>> = std::sync::Mutex::new(None);

fn batch_is_running() -> AppResult<bool> {
    Ok(BATCH_RUN
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .as_ref()
        .is_some_and(|run| run.progress.state == IndexRunState::Running))
}

/// Record the new snapshot and publish it, in that order and never one without
/// the other — a UI that reopens mid-run must land on exactly the state the
/// events described, not on a stale one.
fn publish_batch(app: &AppHandle, progress: BatchIndexProgress) {
    if let Ok(mut slot) = BATCH_RUN.lock() {
        if let Some(run) = slot.as_mut() {
            run.progress = progress.clone();
        }
    }
    let _ = app.emit(BATCH_PROGRESS_EVENT, progress);
}

/// Whether a whole-library run would visit a book, given what the database
/// already says about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BookIndexStanding {
    /// The run has work to do here.
    Pending,
    /// Nothing to do.
    Ready,
    /// Not a candidate at all, and not counted either way.
    Skipped,
}

/// The needs-work rule, in one place and testable without a provider.
///
/// It is decided on exactly two things: whether the chunk index is `Ready` for
/// the file the book currently points at, and whether every chunk carries an
/// embedding from the model that is configured right now. Those two are what
/// meaning-based search actually requires — and, the reason that matters here,
/// they are the two whose absence a run can be relied on to clear, so the
/// count on the button can reach zero.
///
/// The other three phases a run performs are deliberately *not* part of it.
/// Identity sentences, summaries and person aliases are each best-effort: each
/// has its own switch in automatic analysis, each can legitimately come back
/// empty for a given book, and none of them has a finishing condition this
/// rule could watch go quiet. A book missing only its summaries would
/// otherwise be offered for indexing forever, and a number that never falls to
/// zero is worse than no number — it is the same "did anything actually
/// happen?" question the staged progress exists to answer. Those phases still
/// run for every book the batch visits; they just do not decide which books it
/// visits.
///
/// `Unsupported` books are skipped rather than counted as pending: there is no
/// text in them to chunk, so every run would re-record the same verdict and
/// the number would never move.
///
/// `embeddings_complete` is passed as `true` when no embedding source is
/// configured at all — nothing a run could do would satisfy that half, so
/// counting it would put books on a button that pressing cannot help. The row
/// is disabled in that state anyway; this keeps the count honest behind it.
fn book_index_standing(
    status: grounding::index::IndexStatus,
    embeddings_complete: bool,
) -> BookIndexStanding {
    use grounding::index::IndexStatus;
    match status {
        IndexStatus::Unsupported => BookIndexStanding::Skipped,
        IndexStatus::Ready if embeddings_complete => BookIndexStanding::Ready,
        _ => BookIndexStanding::Pending,
    }
}

/// A book the batch would visit, with the title its row shows.
#[derive(Debug, Clone, PartialEq, Eq)]
struct IndexCandidate {
    book_id: String,
    title: String,
}

/// Walk the library once, splitting it into the books a run would visit and
/// the ones that are already done. Blocking — every caller runs it through
/// `spawn_blocking`, for the reason `context_line_progress` spells out.
fn scan_library(db: &Db, secrets: &Secrets) -> AppResult<(Vec<IndexCandidate>, usize)> {
    let source = grounding::vector::source(db, secrets)?;
    // Collected before anything else touches the database: `db.reader()` hands
    // out a guard on one shared connection, and `has_complete_embeddings`
    // takes it again per book — holding this one across the loop would
    // deadlock on the first iteration.
    let rows: Vec<(String, String, Option<String>)> = {
        let conn = db.reader();
        let mut statement = conn.prepare(
            "SELECT b.id, b.title, s.status FROM books b
             LEFT JOIN book_index_state s ON s.book_id = b.id
             ORDER BY b.created_at, b.id",
        )?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut pending = Vec::new();
    let mut ready = 0usize;
    for (book_id, title, status) in rows {
        // No row at all is "never indexed", which `IndexStatus` spells
        // `Missing` — the same verdict `index_status` reaches for it.
        let status = grounding::index::IndexStatus::from_db(status.as_deref().unwrap_or("missing"));
        let embeddings_complete = match &source {
            Some(source) => grounding::vector::has_complete_embeddings(db, &book_id, source)?,
            None => true,
        };
        match book_index_standing(status, embeddings_complete) {
            BookIndexStanding::Pending => pending.push(IndexCandidate { book_id, title }),
            BookIndexStanding::Ready => ready += 1,
            BookIndexStanding::Skipped => {}
        }
    }
    Ok((pending, ready))
}

/// The books named by a retry, in the order they were named, dropping any that
/// have since left the library. Deliberately not re-run through
/// `book_index_standing`: the reader pressed retry on these specific rows, and
/// second-guessing that would silently do nothing on the one press whose whole
/// purpose is to try again.
fn named_candidates(db: &Db, book_ids: &[String]) -> AppResult<Vec<IndexCandidate>> {
    let conn = db.reader();
    let mut statement = conn.prepare("SELECT title FROM books WHERE id = ?1")?;
    let mut candidates = Vec::new();
    for book_id in book_ids {
        let title = statement
            .query_row(rusqlite::params![book_id], |row| row.get::<_, String>(0))
            .optional()?;
        if let Some(title) = title {
            candidates.push(IndexCandidate {
                book_id: book_id.clone(),
                title,
            });
        }
    }
    Ok(candidates)
}

/// How many books the library-wide button has to offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryIndexNeeds {
    pub pending: usize,
    pub ready: usize,
}

/// The count the settings row shows before anything starts.
#[tauri::command]
pub async fn ai_books_needing_index(
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<LibraryIndexNeeds> {
    let db = db.inner().clone();
    let secrets = secrets.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (pending, ready) = scan_library(&db, &secrets)?;
        Ok(LibraryIndexNeeds {
            pending: pending.len(),
            ready,
        })
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}

/// Index every book that needs it, one at a time, and return at once.
///
/// Serial rather than concurrent, and that is a decision rather than a
/// simplification: parallel books contend for the same model, so the wall
/// clock barely moves, while stopping and resuming — the two things this run
/// has to support — both become bookkeeping problems. One book at a time makes
/// "stop" mean "after this phase" and "resume" mean "run it again", with no
/// state to reconcile.
///
/// `book_ids` names the books to run. `None` means every book the library-wide
/// scan finds work for; `Some` is what the "retry the failed ones" button
/// submits, carrying the ids the last terminal event marked `failed`.
///
/// Nothing is deleted on the way in, which is what makes stopping and starting
/// again safe rather than merely tolerated. `ensure_index` returns early on a
/// book whose file has not changed; `ensure_context_lines` and
/// `ensure_embeddings` both skip what is already current and commit each unit
/// as it lands; `generate_book_summaries` and the alias pass overwrite their
/// own output only once they have a full replacement in hand. So a stopped run
/// leaves every finished book finished and the in-flight book's finished
/// chunks on disk, and starting again simply finds less to do — see
/// `race_stop` for what each phase does and does not lose.
#[tauri::command]
pub async fn ai_index_all_books(
    book_ids: Option<Vec<String>>,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    if let Some(book_ids) = &book_ids {
        for book_id in book_ids {
            crate::sync::validation::validate_entity_id(book_id)?;
        }
    }
    // Checked twice: here so a second press does not pay for a full library
    // scan before being turned away, and again under the lock below, which is
    // the check that actually decides — this one can go stale the moment it
    // returns.
    if batch_is_running()? {
        return Err(AppError::Other("AI_INDEX_BATCH_ALREADY_RUNNING".to_string()));
    }
    let db = db.inner().clone();
    let secrets = secrets.inner().clone();
    let books = {
        let db = db.clone();
        let secrets = secrets.clone();
        tauri::async_runtime::spawn_blocking(move || match book_ids {
            Some(book_ids) => named_candidates(&db, &book_ids),
            None => scan_library(&db, &secrets).map(|(pending, _)| pending),
        })
        .await
        .map_err(|error| AppError::Other(error.to_string()))??
    };

    let progress = BatchIndexProgress::new(
        books
            .into_iter()
            .map(|candidate| BatchBookStatus {
                book_id: candidate.book_id,
                title: candidate.title,
                state: BatchBookState::Pending,
                message: None,
                chunk_count: None,
            })
            .collect(),
    );
    let (stop, stop_sender) = {
        let mut slot = BATCH_RUN
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        if slot
            .as_ref()
            .is_some_and(|run| run.progress.state == IndexRunState::Running)
        {
            return Err(AppError::Other("AI_INDEX_BATCH_ALREADY_RUNNING".to_string()));
        }
        // Whatever the last run left behind is replaced wholesale here, which
        // is what lets the row's "retry the failed ones" press start a fresh
        // list rather than accumulate onto the one it was reading from.
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let sender = std::sync::Arc::new(sender);
        *slot = Some(BatchRun {
            stop: sender.clone(),
            progress: progress.clone(),
        });
        (receiver, sender)
    };
    // Nothing to do. Still publish a terminal event rather than returning
    // quietly: the row's own state comes from these events, and a press that
    // produced no event at all would look like a press that did nothing.
    if progress.books.is_empty() {
        let mut progress = progress;
        progress.finish_run(false);
        publish_batch(&app, progress);
        return Ok(());
    }

    tauri::async_runtime::spawn(async move {
        let mut progress = progress;
        publish_batch(&app, progress.clone());
        for position in 0..progress.total {
            if *stop.borrow() {
                break;
            }
            progress.start_book(position);
            publish_batch(&app, progress.clone());
            let book_id = progress.books[position].book_id.clone();
            // Published under the book it is on for exactly as long as it is
            // on it, so the index manager's stop button reaches this run
            // rather than finding nothing. Dropped at the end of the
            // iteration, including on the `break` below.
            let _run = register_book_run(&book_id, stop_sender.clone());
            match run_and_report(&app, &db, &secrets, &book_id, Some(&stop)).await {
                Ok(_) => progress.finish_book(position, verdict(&db, &book_id)),
                Err(failure) if failure.is_cancellation() => {
                    progress.interrupt_book(position);
                    break;
                }
                Err(failure) => {
                    progress.finish_book(position, BookVerdict::failed(failure.error.to_string()));
                }
            }
            publish_batch(&app, progress.clone());
        }
        progress.finish_run(*stop.borrow());
        publish_batch(&app, progress);
    });
    Ok(())
}

/// How one book's row should end up, once the run on it has returned.
struct BookVerdict {
    state: BatchBookState,
    message: Option<String>,
    chunk_count: Option<i64>,
}

impl BookVerdict {
    /// The run itself returned an error. No chunk count: the row already has
    /// something to say, and a number beside a failure reads as a claim that
    /// the number is the problem.
    fn failed(message: String) -> Self {
        Self {
            state: BatchBookState::Failed,
            message: Some(message),
            chunk_count: None,
        }
    }
}

/// What a run that returned `Ok` actually left behind.
///
/// Not redundant with the absent error: `ensure_index` reports a book whose
/// file has gone missing, or one that turned out to hold no extractable text,
/// as a status rather than as a failure — so the run ends cleanly having done
/// nothing at all. Shown as a tick, that book would sit in the list looking
/// finished while staying exactly as unsearchable as before, and it would come
/// straight back on the next scan with no explanation of why.
fn verdict(db: &Db, book_id: &str) -> BookVerdict {
    match grounding::index::index_status(db, book_id) {
        // Two statements, not one expression: `index_status` and
        // `stored_chunk_count` each take `db.reader()`, which hands out a guard
        // on the one shared connection, so holding the first across the second
        // would deadlock rather than merely be untidy.
        Ok(grounding::index::IndexStatus::Ready) => BookVerdict {
            state: BatchBookState::Done,
            message: None,
            chunk_count: stored_chunk_count(db, book_id),
        },
        Ok(status) => BookVerdict::failed(format!("AI_INDEX_NOT_READY:{}", status.as_db())),
        Err(error) => BookVerdict::failed(error.to_string()),
    }
}

/// The chunk count `ensure_index` recorded, or `None` if it cannot be read.
///
/// Swallows its error on purpose: this is a number decorating a row that has
/// already been decided, and turning a finished book into a failed one because
/// a second read of the same table went wrong would be a worse answer than
/// leaving the count off.
fn stored_chunk_count(db: &Db, book_id: &str) -> Option<i64> {
    db.reader()
        .query_row(
            "SELECT chunk_count FROM book_index_state WHERE book_id = ?1",
            rusqlite::params![book_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
}

/// Stop the run at the earliest point the phase in flight can be abandoned
/// without losing committed work — see `race_stop`. A no-op when nothing is
/// running.
#[tauri::command]
pub fn ai_stop_index_all_books() -> AppResult<()> {
    if let Ok(slot) = BATCH_RUN.lock() {
        if let Some(run) = slot.as_ref() {
            // `send_replace`, not `send`: the stored value has to become
            // `true` even in the window after the run's task has dropped its
            // receiver, because the loop reads it back with `borrow()` to
            // decide whether the terminal event says `cancelled`.
            run.stop.send_replace(true);
        }
    }
    Ok(())
}

/// The run in flight, or the one that finished most recently, or `None` if
/// there has not been one this session. What a settings modal reads when it
/// opens, since the run it needs to draw may have started before it did.
#[tauri::command]
pub fn ai_index_all_books_status() -> AppResult<Option<BatchIndexProgress>> {
    Ok(BATCH_RUN
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .as_ref()
        .map(|run| run.progress.clone()))
}

/// The progress payload is a contract with a UI that cannot be compiled
/// against it, so what these pin down is the wire shape — key names, which
/// fields are absent when, and the step numbering the reader is shown.
#[cfg(test)]
mod tests {
    use super::*;

    /// Sorted, because `serde_json::Map` is a `BTreeMap` here and field order
    /// is not part of the contract anyway — which keys exist is.
    fn keys(progress: &IndexProgress) -> Vec<String> {
        let serde_json::Value::Object(map) = serde_json::to_value(progress).unwrap() else {
            panic!("IndexProgress must serialize as an object");
        };
        map.keys().cloned().collect()
    }

    #[test]
    fn phases_are_numbered_one_through_five_in_running_order() {
        let steps: Vec<u8> = IndexPhase::ALL.iter().map(|phase| phase.step()).collect();
        assert_eq!(steps, vec![1, 2, 3, 4, 5]);
        assert_eq!(INDEX_PHASE_COUNT, 5);
        // The reader is never shown "第 6 步，共 5 步", including on the
        // terminal events, which report against a real phase rather than a
        // synthetic extra one.
        for phase in IndexPhase::ALL {
            assert!(phase.step() <= INDEX_PHASE_COUNT);
        }
    }

    /// The alias pass is the last step and has to be seen as its own, which is
    /// the entire point of splitting it out of `Summarize`: reported under
    /// step 4 it left the display parked on "章节摘要" for as long again as
    /// the summaries themselves took.
    #[test]
    fn the_alias_pass_is_the_fifth_step_and_names_itself() {
        let value = serde_json::to_value(IndexProgress::running(IndexPhase::Aliases, 0, 0)).unwrap();
        assert_eq!(value["phase"], "aliases");
        assert_eq!(value["step"], 5);
        assert_eq!(value["totalSteps"], 5);
        assert_eq!(IndexPhase::ALL.last(), Some(&IndexPhase::Aliases));
    }

    /// One model call for the whole book, so there is no denominator to
    /// report. `0` is the same "cannot know in advance" the chunk phase sends,
    /// and a listener already has to handle it there — inventing a fake total
    /// here would be a bar that jumps rather than one that fills.
    #[test]
    fn the_alias_pass_reports_no_in_phase_total() {
        let progress = IndexProgress::running(IndexPhase::Aliases, 0, 0);
        assert_eq!(progress.total, 0);
        assert_eq!(progress.done, 0);
    }

    #[test]
    fn a_running_event_carries_only_the_counters() {
        let progress = IndexProgress::running(IndexPhase::Embed, 32, 642);
        assert_eq!(
            keys(&progress),
            vec!["done", "phase", "state", "step", "total", "totalSteps"]
        );
        let value = serde_json::to_value(&progress).unwrap();
        assert_eq!(value["state"], "running");
        assert_eq!(value["phase"], "embed");
        assert_eq!(value["step"], 3);
        assert_eq!(value["totalSteps"], 5);
        assert_eq!(value["done"], 32);
        assert_eq!(value["total"], 642);
    }

    #[test]
    fn the_success_event_carries_what_the_command_used_to_return() {
        let result = IndexUpdateResult {
            reindexed: true,
            embeddings_updated: false,
            summaries_updated: true,
        };
        let value = serde_json::to_value(IndexProgress::finished(result.clone())).unwrap();
        assert_eq!(value["state"], "done");
        assert_eq!(value["step"], i64::from(INDEX_PHASE_COUNT));
        assert_eq!(value["result"], serde_json::to_value(&result).unwrap());
        assert_eq!(value["result"]["embeddingsUpdated"], false);
        assert!(value.get("message").is_none());
    }

    #[test]
    fn a_failure_names_the_phase_that_died_rather_than_the_last_one() {
        let progress =
            IndexProgress::failed(IndexPhase::Embed, &AppError::Ai("no such model".into()));
        assert_eq!(progress.state, IndexRunState::Failed);
        assert_eq!(progress.phase, IndexPhase::Embed);
        assert_eq!(progress.step, 3);
        assert!(progress.message.unwrap().contains("no such model"));
    }

    #[test]
    fn a_cancelled_run_is_not_reported_as_a_failure() {
        // The reader pressed stop. Distinguished by the router's marker, and
        // deliberately message-less: there is nothing to explain, and the
        // spawned task uses this same distinction to decide whether the run is
        // worth a log line.
        let progress = IndexProgress::failed(
            IndexPhase::Summarize,
            &AppError::Ai("AI_REQUEST_CANCELLED".into()),
        );
        assert_eq!(progress.state, IndexRunState::Cancelled);
        assert_eq!(progress.message, None);
        assert!(keys(&progress).iter().all(|key| key != "message"));
    }

    /// A stop that only stopped one phase is not a stop, so the two
    /// best-effort phases have to be able to tell a cancellation apart from
    /// the ordinary errors they are supposed to swallow.
    #[test]
    fn a_failure_knows_whether_it_was_a_stop() {
        assert!(IndexRunFailure::cancelled(IndexPhase::Context).is_cancellation());
        assert!(!IndexRunFailure {
            phase: IndexPhase::Context,
            error: AppError::Ai("connection reset".into()),
        }
        .is_cancellation());
    }

    // --- the whole-library batch ------------------------------------------

    use grounding::index::IndexStatus;

    fn book(id: &str) -> BatchBookStatus {
        BatchBookStatus {
            book_id: id.to_string(),
            title: format!("Book {id}"),
            state: BatchBookState::Pending,
            message: None,
            chunk_count: None,
        }
    }

    fn done(chunks: i64) -> BookVerdict {
        BookVerdict {
            state: BatchBookState::Done,
            message: None,
            chunk_count: Some(chunks),
        }
    }

    #[test]
    fn a_book_with_a_ready_index_and_every_embedding_needs_nothing() {
        assert_eq!(
            book_index_standing(IndexStatus::Ready, true),
            BookIndexStanding::Ready
        );
    }

    #[test]
    fn a_ready_index_with_missing_embeddings_still_needs_a_visit() {
        assert_eq!(
            book_index_standing(IndexStatus::Ready, false),
            BookIndexStanding::Pending
        );
    }

    #[test]
    fn every_non_ready_index_needs_a_visit() {
        for status in [IndexStatus::Missing, IndexStatus::Building, IndexStatus::Failed] {
            assert_eq!(
                book_index_standing(status, true),
                BookIndexStanding::Pending,
                "{status:?} has no usable index yet"
            );
        }
    }

    /// Neither pending nor ready. Counted as pending it would sit on the
    /// button forever — there is no text in the book to chunk, so every run
    /// would re-reach the same verdict and the number would never move.
    #[test]
    fn an_unsupported_book_is_left_out_of_the_count_entirely() {
        assert_eq!(
            book_index_standing(IndexStatus::Unsupported, false),
            BookIndexStanding::Skipped
        );
    }

    #[test]
    fn the_batch_payload_carries_both_levels_and_names_each_book() {
        let mut progress = BatchIndexProgress::new(vec![book("a"), book("b")]);
        progress.start_book(1);
        let value = serde_json::to_value(&progress).unwrap();
        assert_eq!(value["state"], "running");
        assert_eq!(value["current"], 2);
        assert_eq!(value["total"], 2);
        assert_eq!(value["books"][0]["bookId"], "a");
        assert_eq!(value["books"][0]["state"], "pending");
        assert_eq!(value["books"][1]["title"], "Book b");
        assert_eq!(value["books"][1]["state"], "running");
        // Absent, not null: only a failed row carries one.
        assert!(value["books"][1].get("message").is_none());
        // Same rule for the count, from the other direction: it is a fact
        // about a finished book, so an unfinished row must not carry a stale
        // or zero one that the UI would then have to second-guess.
        assert!(value["books"][0].get("chunkCount").is_none());
        assert!(value["books"][1].get("chunkCount").is_none());
    }

    /// The count exists to make one specific silent failure loud:
    /// `ensure_index` writes `ready` for any non-empty extraction, so a book
    /// whose parser produced twelve chunks reports success and only shows
    /// itself as "the AI knows nothing about this book" weeks later. Beside a
    /// column of four-figure counts, a twelve is wrong on sight.
    #[test]
    fn a_finished_book_carries_the_chunk_count_it_ended_up_with() {
        let mut progress = BatchIndexProgress::new(vec![book("a"), book("b")]);
        progress.start_book(0);
        progress.finish_book(0, done(1_204));
        progress.start_book(1);
        progress.finish_book(1, done(12));
        let value = serde_json::to_value(&progress).unwrap();
        assert_eq!(value["books"][0]["chunkCount"], 1_204);
        assert_eq!(value["books"][1]["chunkCount"], 12);
        assert_eq!(value["books"][1]["state"], "done");
    }

    /// A number beside a failure reads as a claim that the number is the
    /// problem, and for the two `AI_INDEX_NOT_READY` cases — a missing file, a
    /// book with no extractable text — there is no honest count to give.
    #[test]
    fn a_failed_book_carries_its_reason_and_no_count() {
        let verdict = BookVerdict::failed("AI_INDEX_NOT_READY:unsupported".to_string());
        assert_eq!(verdict.state, BatchBookState::Failed);
        assert_eq!(verdict.chunk_count, None);
        let mut progress = BatchIndexProgress::new(vec![book("a")]);
        progress.start_book(0);
        progress.finish_book(0, verdict);
        let value = serde_json::to_value(&progress).unwrap();
        assert!(value["books"][0].get("chunkCount").is_none());
        assert_eq!(value["books"][0]["message"], "AI_INDEX_NOT_READY:unsupported");
    }

    /// A retry has to clear the last attempt's count for the same reason it
    /// clears the message: a row that is running again must not still be
    /// showing what the run before it worked out.
    #[test]
    fn a_book_starting_again_drops_the_count_its_last_attempt_left() {
        let mut progress = BatchIndexProgress::new(vec![book("a")]);
        progress.start_book(0);
        progress.finish_book(0, done(642));
        progress.start_book(0);
        assert_eq!(progress.books[0].chunk_count, None);
        progress.interrupt_book(0);
        assert_eq!(progress.books[0].chunk_count, None);
    }

    /// One book failing must not end the run, and the terminal event has to
    /// say which book it was — that id is what the retry button submits.
    #[test]
    fn a_failed_book_is_named_and_the_run_still_finishes_done() {
        let mut progress = BatchIndexProgress::new(vec![book("a"), book("b")]);
        progress.start_book(0);
        progress.finish_book(0, BookVerdict::failed("no such model".to_string()));
        progress.start_book(1);
        progress.finish_book(1, done(642));
        progress.finish_run(false);
        let value = serde_json::to_value(&progress).unwrap();
        assert_eq!(value["state"], "done");
        assert_eq!(value["current"], 0);
        assert_eq!(value["books"][0]["state"], "failed");
        assert_eq!(value["books"][0]["message"], "no such model");
        assert_eq!(value["books"][1]["state"], "done");
    }

    /// What "resume from where it stopped" rests on: the books already done
    /// stay done, the interrupted one goes back to pending rather than to
    /// failed, and the ones never reached were pending all along. Pressing the
    /// button again therefore re-offers exactly the second and third groups —
    /// no state to reconcile, because nothing was deleted.
    #[test]
    fn a_stop_leaves_finished_books_finished_and_the_rest_pending() {
        let mut progress = BatchIndexProgress::new(vec![book("a"), book("b"), book("c")]);
        progress.start_book(0);
        progress.finish_book(0, done(642));
        progress.start_book(1);
        progress.interrupt_book(1);
        progress.finish_run(true);
        assert_eq!(progress.state, IndexRunState::Cancelled);
        assert_eq!(progress.current, 0);
        let states: Vec<BatchBookState> = progress.books.iter().map(|entry| entry.state).collect();
        assert_eq!(
            states,
            vec![
                BatchBookState::Done,
                BatchBookState::Pending,
                BatchBookState::Pending
            ]
        );
        assert_eq!(serde_json::to_value(&progress).unwrap()["state"], "cancelled");
    }

    /// Retrying clears the previous message before the book runs again, or a
    /// row that succeeded on the second try would keep displaying the error
    /// from the first.
    #[test]
    fn starting_a_book_clears_the_message_its_last_attempt_left() {
        let mut progress = BatchIndexProgress::new(vec![book("a")]);
        progress.start_book(0);
        progress.finish_book(0, BookVerdict::failed("timed out".to_string()));
        progress.start_book(0);
        assert_eq!(progress.books[0].message, None);
    }

    // --- stopping one book ------------------------------------------------

    /// The switch has to be reachable by book id, because that is all the
    /// index manager knows. Nothing else identifies the run: the summaries
    /// phase mints its router request id deep inside the pipeline and it never
    /// reaches the front end.
    #[test]
    fn a_registered_run_can_be_stopped_by_the_book_it_is_on() {
        let (sender, stop) = tokio::sync::watch::channel(false);
        let _run = register_book_run("stop-me", std::sync::Arc::new(sender));
        assert!(!*stop.borrow());
        ai_stop_book_index("stop-me".to_string()).unwrap();
        assert!(*stop.borrow());
    }

    /// Pressing stop on a book nothing is running on is a no-op rather than an
    /// error: the button can legitimately outlive its run by the length of one
    /// event round trip.
    #[test]
    fn stopping_a_book_with_no_run_on_it_is_not_an_error() {
        assert!(ai_stop_book_index("idle-book".to_string()).is_ok());
    }

    /// Only the named book. A stop is aimed at one row, and a second book
    /// being indexed in another window must not go down with it.
    #[test]
    fn stopping_one_book_leaves_the_other_runs_alone() {
        let (first_sender, first) = tokio::sync::watch::channel(false);
        let (second_sender, second) = tokio::sync::watch::channel(false);
        let _first = register_book_run("book-one", std::sync::Arc::new(first_sender));
        let _second = register_book_run("book-two", std::sync::Arc::new(second_sender));
        ai_stop_book_index("book-one".to_string()).unwrap();
        assert!(*first.borrow());
        assert!(!*second.borrow());
    }

    /// The guard is what keeps a finished run from leaving a switch behind for
    /// the next press to flip to no effect — and it has to unregister *its*
    /// run rather than the book, or a guard dropping late would disarm the run
    /// that replaced it.
    #[test]
    fn a_finished_run_stops_being_stoppable_without_disarming_its_successor() {
        let (old_sender, old) = tokio::sync::watch::channel(false);
        let old_run = register_book_run("same-book", std::sync::Arc::new(old_sender));
        let (new_sender, new) = tokio::sync::watch::channel(false);
        let _new_run = register_book_run("same-book", std::sync::Arc::new(new_sender));
        drop(old_run);
        ai_stop_book_index("same-book".to_string()).unwrap();
        assert!(*new.borrow(), "the run still going must still be stoppable");
        assert!(!*old.borrow(), "the run that ended must be gone from the registry");
    }

    /// A book id that could not name a row never reaches the registry.
    #[test]
    fn a_malformed_book_id_is_rejected_rather_than_searched_for() {
        assert!(ai_stop_book_index("../etc".to_string()).is_err());
    }

    /// What a stop actually costs, in the one place it can be pinned down
    /// without a provider: `race_stop` abandons the phase in flight and
    /// nothing else. The phases that already committed keep what they wrote —
    /// that is the whole basis of "press the button again to carry on" — and
    /// the abandoned phase's body never runs at all, so it cannot half-write
    /// either.
    #[tokio::test]
    async fn a_stop_abandons_the_phase_in_flight_and_keeps_the_ones_behind_it() {
        let (sender, stop) = tokio::sync::watch::channel(false);
        let committed = std::sync::Mutex::new(Vec::<&str>::new());

        // Two phases finish before the reader presses anything.
        for phase in [IndexPhase::Chunk, IndexPhase::Context] {
            let outcome = race_stop(Some(&stop), phase, async {
                committed.lock().unwrap().push("phase");
                Ok::<(), IndexRunFailure>(())
            })
            .await;
            assert!(outcome.is_ok(), "nothing has asked this run to stop yet");
        }

        sender.send_replace(true);

        // The next one is refused before its body is polled, which is what
        // makes the stop near-instant instead of one phase late.
        let failure = race_stop(Some(&stop), IndexPhase::Summarize, async {
            committed.lock().unwrap().push("summaries");
            Ok::<(), IndexRunFailure>(())
        })
        .await
        .expect_err("a stop already pressed must be seen before the phase starts");

        assert!(failure.is_cancellation());
        assert_eq!(failure.phase, IndexPhase::Summarize);
        assert_eq!(committed.lock().unwrap().len(), 2, "earlier phases keep their work");

        // And it reaches the reader as a stop, not as something to apologise
        // for — the single-book run reports through the same terminal event
        // the batch does.
        let progress = IndexProgress::failed(failure.phase, &failure.error);
        assert_eq!(progress.state, IndexRunState::Cancelled);
        assert_eq!(progress.message, None);
        assert_eq!(serde_json::to_value(&progress).unwrap()["state"], "cancelled");
    }

    /// A stop that arrives while the phase is running has to cut it short too,
    /// not just be noticed before the next one starts.
    #[tokio::test]
    async fn a_stop_pressed_mid_phase_does_not_wait_the_phase_out() {
        let (sender, stop) = tokio::sync::watch::channel(false);
        let sender = std::sync::Arc::new(sender);
        let presser = sender.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            presser.send_replace(true);
        });
        let failure = race_stop(Some(&stop), IndexPhase::Embed, async {
            // Stands in for the model call the embed phase is blocked on.
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            Ok::<(), IndexRunFailure>(())
        })
        .await
        .expect_err("the stop must win the race against the phase");
        assert!(failure.is_cancellation());
        assert_eq!(failure.phase, IndexPhase::Embed);
    }
}
