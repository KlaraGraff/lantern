//! Quiz-scroll (词卷) papers and the wrong-word repetition pool — the Rust
//! half of merging 词卷 into the vocab review section. See
//! `docs/impls/cijuan-merge.md` §二.2 (schema), §二.3 (why the scheduler
//! moved to Rust instead of staying the TS asset it otherwise would be),
//! §二.5 (FSRS writeback rules), §四.3 (the unanswered-question rule).
//!
//! Quiz *content* (passages, questions, prompts) stays opaque JSON here —
//! the shape belongs to the TS side (`labs/cijuan/src/types.ts`, migrating
//! to `src/quiz/` in a parallel step). This module only parses the two
//! slices of that JSON it must actually reason about to drive the
//! wrong-word state machine and the FSRS writeback: `config.demo` and the
//! submitted `QuizResult`/`QuizWord[]` shapes.

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

use crate::commands::vocab::{
    find_confirmed_vocab_id_by_word, record_vocab_review_in_tx, VocabReviewRating,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::writer::SyncWriter;

// ===== Wire shapes (frontend/backend contract) =====

/// A saved paper, as stored — every JSON column is returned verbatim for the
/// frontend to parse with its own (zod-validated) types. The Rust side never
/// round-trips these blobs through its own structs; it only ever reads the
/// couple of fields below need for the submit transaction.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizPaperRow {
    pub id: i64,
    pub created_at: String,
    pub status: String,
    pub config_json: String,
    pub words_json: String,
    pub content_json: String,
    pub result_json: Option<String>,
    pub ask_threads_json: Option<String>,
    /// Progressive-delivery generation plan (docs/impls/quiz-progressive-delivery.md):
    /// per-group words + state while `status = 'generating'`; NULL otherwise.
    /// Opaque JSON owned by the frontend, like every other JSON column here.
    pub generation_json: Option<String>,
    /// In-progress answer sheet (答案自动保存): written by the take page while
    /// the paper is unsubmitted, cleared by submit. Opaque JSON, frontend-owned.
    pub draft_json: Option<String>,
}

/// A `quiz_wrong_words` row, returned to the frontend for the pool table and
/// for quiz-regeneration ("重现错词") word selection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrongWordEntry {
    pub id: i64,
    pub word: String,
    pub wrong_count: i64,
    pub first_wrong_at: String,
    pub last_wrong_at: String,
    pub stage: i64,
    pub next_due_at: Option<String>,
    pub cleared: bool,
}

/// Only the field this module inspects from `QuizConfig` — see
/// `labs/cijuan/src/types.ts`'s `QuizConfig` for the full (TS-owned) shape.
#[derive(Debug, Default, Deserialize)]
struct QuizConfigDemoFlag {
    #[serde(default)]
    demo: bool,
}

/// Only the field this module inspects from `QuizWord` (`words_json`).
#[derive(Debug, Clone, Deserialize)]
struct QuizWordRow {
    word: String,
}

/// Only the fields this module inspects from `QuestionVerdict`.
///
/// `user_answer` is the one signal the wire format carries for "unanswered"
/// — `labs/cijuan/src/store/grading.ts`'s `gradeQuiz()` computes
/// `userAnswer = answers[q.id] ?? ''` for every question, so an unanswered
/// question is graded exactly like a wrong one (`correct: false`) and is
/// distinguishable only by this field being empty. See §四.3: unanswered
/// questions still enter the wrong-word pool (the paper wasn't finished, the
/// word is still due for reappearance) but must not produce an FSRS `again`
/// write (skipping a question is not a failed recall attempt).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionVerdict {
    target_word: String,
    correct: bool,
    #[serde(default)]
    user_answer: String,
}

/// Only the fields this module inspects from `QuizResult` (the submitted
/// `result_json` body).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuizResultInput {
    #[serde(default)]
    verdicts: Vec<QuestionVerdict>,
    #[serde(default)]
    wrong_words: Vec<String>,
}

// ===== Row mapping =====

const PAPER_COLS: &str =
    "id, created_at, status, config_json, words_json, content_json, result_json, ask_threads_json, generation_json, draft_json";

fn row_to_paper(row: &rusqlite::Row<'_>) -> rusqlite::Result<QuizPaperRow> {
    Ok(QuizPaperRow {
        id: row.get(0)?,
        created_at: row.get(1)?,
        status: row.get(2)?,
        config_json: row.get(3)?,
        words_json: row.get(4)?,
        content_json: row.get(5)?,
        result_json: row.get(6)?,
        ask_threads_json: row.get(7)?,
        generation_json: row.get(8)?,
        draft_json: row.get(9)?,
    })
}

/// The writable connection (`db.conn`) — `db.reader()` is a genuinely
/// read-only SQLite handle (`SQLITE_OPEN_READ_ONLY`, see `db.rs`'s
/// `init_split`), so every INSERT/UPDATE/DELETE in this module must go
/// through this instead. Reads still prefer `db.reader()`, same as the rest
/// of the app, so frontend queries never contend with sync writes.
fn writer(db: &Db) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    db.conn
        .lock()
        .map_err(|err| AppError::Other(format!("db conn mutex: {err}")))
}

fn fetch_paper(conn: &rusqlite::Connection, id: i64) -> AppResult<Option<QuizPaperRow>> {
    conn.query_row(
        &format!("SELECT {PAPER_COLS} FROM quiz_papers WHERE id = ?1"),
        params![id],
        row_to_paper,
    )
    .optional()
    .map_err(Into::into)
}

const WRONG_WORD_COLS: &str =
    "id, word, wrong_count, first_wrong_at, last_wrong_at, stage, next_due_at, cleared";

fn row_to_wrong_word(row: &rusqlite::Row<'_>) -> rusqlite::Result<WrongWordEntry> {
    Ok(WrongWordEntry {
        id: row.get(0)?,
        word: row.get(1)?,
        wrong_count: row.get(2)?,
        first_wrong_at: row.get(3)?,
        last_wrong_at: row.get(4)?,
        stage: row.get(5)?,
        next_due_at: row.get(6)?,
        cleared: row.get::<_, i64>(7)? != 0,
    })
}

// ===== Time helpers =====
//
// The two new tables store ISO-8601 TEXT timestamps rather than Lantern's
// usual epoch-millisecond INTEGER columns — deliberately, so the ported
// scheduler can compare `next_due_at <= now` with plain string comparison
// exactly as `scheduler.ts` did (ISO-8601 UTC strings sort lexicographically
// in chronological order). `to_rfc3339_opts(Millis, true)` matches JS's
// `Date.prototype.toISOString()` byte-for-byte (millisecond precision, `Z`
// suffix), which the ported test values below depend on.

fn iso_now(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn iso_plus_days(now: DateTime<Utc>, days: i64) -> String {
    iso_now(now + Duration::days(days))
}

/// Lowercases and deduplicates, preserving first-seen order — the Rust
/// equivalent of `[...new Set(words.map(w => w.toLowerCase()))]`. Word
/// identity across this whole module is case-insensitive-but-stored-lower,
/// per the migration's `word TEXT NOT NULL UNIQUE` comment.
fn dedup_lower<'a>(words: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for word in words {
        let lower = word.to_lowercase();
        if seen.insert(lower.clone()) {
            out.push(lower);
        }
    }
    out
}

// ===== Scheduler: a straight port of labs/cijuan/src/store/scheduler.ts =====
//
// docs/impls/cijuan-merge.md §二.3 explains why this one file moved to Rust
// instead of staying a TS asset like the rest of the quiz engine: submitting
// a paper has to write the result *and* advance this state machine in one
// transaction, atomically and idempotently, and Lantern's own convention
// (FSRS) is that scheduling logic lives in Rust next to the transaction that
// drives it.

/// Advances the wrong-word repetition state machine. `wrong_words` and
/// `correct_words` must already be lowercased, deduplicated, and disjoint —
/// the caller (`submit_paper_in_tx`) computes that split once, up front,
/// exactly as `scheduler.ts`'s `applyResult` does internally.
///
/// Semantics (unchanged from the TS original):
/// - Wrong word, not yet in the pool → insert at stage 0, `wrongCount = 1`,
///   due in `+2d`.
/// - Wrong word, already in the pool (in or out of it) → reset to stage 0,
///   `wrongCount += 1`, due in `+2d`, `cleared = false`. `firstWrongAt` is
///   left untouched — it is the word's whole learning history, not this
///   episode's.
/// - Correct word, in the pool at stage 0 → promote to stage 1, due `+7d`.
/// - Correct word, in the pool at stage 1 → clear (`cleared = true`,
///   `nextDueAt = NULL`).
/// - Correct word, not in the pool (or already cleared) → no-op. A word
///   never enters the pool by answering it correctly.
fn apply_quiz_result_in_tx(
    tx: &rusqlite::Transaction,
    wrong_words: &[String],
    correct_words: &[String],
    now: DateTime<Utc>,
) -> AppResult<()> {
    let now_iso = iso_now(now);
    for word in wrong_words {
        let existing: Option<(i64, i64)> = tx
            .query_row(
                "SELECT id, wrong_count FROM quiz_wrong_words WHERE word = ?1",
                params![word],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match existing {
            Some((row_id, wrong_count)) => {
                tx.execute(
                    "UPDATE quiz_wrong_words
                         SET last_wrong_at = ?1, stage = 0, next_due_at = ?2,
                             wrong_count = ?3, cleared = 0
                         WHERE id = ?4",
                    params![now_iso, iso_plus_days(now, 2), wrong_count + 1, row_id],
                )?;
            }
            None => {
                tx.execute(
                    "INSERT INTO quiz_wrong_words
                         (word, wrong_count, first_wrong_at, last_wrong_at, stage, next_due_at, cleared)
                         VALUES (?1, 1, ?2, ?2, 0, ?3, 0)",
                    params![word, now_iso, iso_plus_days(now, 2)],
                )?;
            }
        }
    }

    for word in correct_words {
        let existing: Option<(i64, i64, bool)> = tx
            .query_row(
                "SELECT id, stage, cleared FROM quiz_wrong_words WHERE word = ?1",
                params![word],
                |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
            )
            .optional()?;
        let Some((row_id, stage, cleared)) = existing else {
            continue;
        };
        if cleared {
            continue;
        }
        if stage == 0 {
            tx.execute(
                "UPDATE quiz_wrong_words SET stage = 1, next_due_at = ?1 WHERE id = ?2",
                params![iso_plus_days(now, 7), row_id],
            )?;
        } else {
            tx.execute(
                "UPDATE quiz_wrong_words SET cleared = 1, next_due_at = NULL WHERE id = ?1",
                params![row_id],
            )?;
        }
    }
    Ok(())
}

/// The words due for reappearance: not cleared, and `next_due_at <= now`.
/// Feeds quiz regeneration's "重现错词" word source.
fn due_wrong_words(conn: &rusqlite::Connection, now_iso: &str) -> AppResult<Vec<WrongWordEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {WRONG_WORD_COLS} FROM quiz_wrong_words
             WHERE cleared = 0 AND next_due_at IS NOT NULL AND next_due_at <= ?1
             ORDER BY next_due_at ASC"
    ))?;
    let rows = stmt.query_map(params![now_iso], row_to_wrong_word)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Every pool entry, including cleared ones (data is kept permanently as
/// learning history — §四 决议 2), sorted by most-recently-wrong first. Feeds
/// the pool table UI, which folds cleared entries by default.
fn all_wrong_words(conn: &rusqlite::Connection) -> AppResult<Vec<WrongWordEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {WRONG_WORD_COLS} FROM quiz_wrong_words ORDER BY last_wrong_at DESC"
    ))?;
    let rows = stmt.query_map([], row_to_wrong_word)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ===== Paper CRUD =====

/// The two statuses the frontend may set through the generation surface
/// ('submitted' is only ever reached through `submit_quiz_paper`).
fn validate_generation_status(status: &str) -> AppResult<()> {
    if status == "generating" || status == "ready" {
        Ok(())
    } else {
        Err(AppError::Other(format!("QUIZ_STATUS_INVALID: {status}")))
    }
}

/// Creates a paper. Progressive delivery (docs/impls/quiz-progressive-delivery.md)
/// creates the row as soon as the *first* article lands: `status = 'generating'`
/// plus a `generation_json` plan. A single-article paper (and the pre-progressive
/// path) passes `status = 'ready'` with no plan.
pub(crate) fn create_quiz_paper_inner(
    created_at: String,
    status: String,
    config_json: String,
    words_json: String,
    content_json: String,
    generation_json: Option<String>,
    db: &Db,
) -> AppResult<i64> {
    validate_generation_status(&status)?;
    let conn = writer(db)?;
    conn.execute(
        "INSERT INTO quiz_papers (created_at, status, config_json, words_json, content_json, generation_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![created_at, status, config_json, words_json, content_json, generation_json],
    )?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_quiz_paper(
    created_at: String,
    status: String,
    config_json: String,
    words_json: String,
    content_json: String,
    generation_json: Option<String>,
    db: State<'_, Db>,
) -> AppResult<i64> {
    create_quiz_paper_inner(
        created_at,
        status,
        config_json,
        words_json,
        content_json,
        generation_json,
        &db,
    )
}

/// Progressive delivery's per-article writeback: each finished (or failed)
/// article advances the paper in one UPDATE — appended content, the grown
/// word list (per-article coverage settlement), the generation plan, and the
/// status ('generating' while articles remain, 'ready' once all are done,
/// at which point `generation_json` is passed as NULL and the row becomes
/// shape-identical to a non-progressive paper).
///
/// Refuses to touch a submitted paper: submit settles the wrong-word pool and
/// FSRS from `words_json`/`result_json`, and rewriting the paper body under a
/// settled result would desync the two. Unreachable through the UI (submit is
/// gated until 'ready'); this is defence in depth.
pub(crate) fn update_quiz_paper_generation_inner(
    id: i64,
    content_json: String,
    words_json: String,
    status: String,
    generation_json: Option<String>,
    db: &Db,
) -> AppResult<()> {
    validate_generation_status(&status)?;
    let conn = writer(db)?;
    let changed = conn.execute(
        "UPDATE quiz_papers
             SET content_json = ?1, words_json = ?2, status = ?3, generation_json = ?4
             WHERE id = ?5 AND status != 'submitted'",
        params![content_json, words_json, status, generation_json, id],
    )?;
    if changed == 0 {
        let exists = conn
            .query_row(
                "SELECT 1 FROM quiz_papers WHERE id = ?1",
                params![id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        return Err(AppError::Other(if exists {
            "QUIZ_PAPER_ALREADY_SUBMITTED".to_string()
        } else {
            "QUIZ_PAPER_NOT_FOUND".to_string()
        }));
    }
    Ok(())
}

#[tauri::command]
pub fn update_quiz_paper_generation(
    id: i64,
    content_json: String,
    words_json: String,
    status: String,
    generation_json: Option<String>,
    db: State<'_, Db>,
) -> AppResult<()> {
    update_quiz_paper_generation_inner(id, content_json, words_json, status, generation_json, &db)
}

#[tauri::command]
pub fn get_quiz_paper(id: i64, db: State<'_, Db>) -> AppResult<Option<QuizPaperRow>> {
    fetch_paper(&db.reader(), id)
}

/// Every paper, most recently created first.
#[tauri::command]
pub fn list_quiz_papers(db: State<'_, Db>) -> AppResult<Vec<QuizPaperRow>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(&format!(
        "SELECT {PAPER_COLS} FROM quiz_papers ORDER BY created_at DESC, id DESC"
    ))?;
    let rows = stmt.query_map([], row_to_paper)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Phase-2 writeback (§二.6): the explanations generated in the background
/// after the paper is already handed to the reader replace `content_json`
/// once they finish.
#[tauri::command]
pub fn update_quiz_paper_content(
    id: i64,
    content_json: String,
    db: State<'_, Db>,
) -> AppResult<()> {
    let conn = writer(&db)?;
    let changed = conn.execute(
        "UPDATE quiz_papers SET content_json = ?1 WHERE id = ?2",
        params![content_json, id],
    )?;
    if changed == 0 {
        return Err(AppError::Other("QUIZ_PAPER_NOT_FOUND".to_string()));
    }
    Ok(())
}

/// Deletes an unsubmitted paper. Sole caller today is the generation session's
/// cancel path: when cancel lands while the `create_quiz_paper` IPC is already
/// in flight, the row commits anyway — this removes the orphan so History
/// doesn't accumulate stuck 'generating' papers the user explicitly cancelled.
/// Refuses submitted papers: submit settles the wrong-word pool and FSRS from
/// the paper, so a submitted row is user history, not a transient artifact.
pub(crate) fn delete_quiz_paper_inner(id: i64, db: &Db) -> AppResult<()> {
    let conn = writer(db)?;
    let changed = conn.execute(
        "DELETE FROM quiz_papers WHERE id = ?1 AND status != 'submitted'",
        params![id],
    )?;
    if changed == 0 {
        let exists = conn
            .query_row(
                "SELECT 1 FROM quiz_papers WHERE id = ?1",
                params![id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        return Err(AppError::Other(if exists {
            "QUIZ_PAPER_ALREADY_SUBMITTED".to_string()
        } else {
            "QUIZ_PAPER_NOT_FOUND".to_string()
        }));
    }
    Ok(())
}

#[tauri::command]
pub fn delete_quiz_paper(id: i64, db: State<'_, Db>) -> AppResult<()> {
    delete_quiz_paper_inner(id, &db)
}

/// Ask-thread ("追问") state is small and always overwritten wholesale, same
/// as the TS original (`saveAskThreads`) — no incremental append needed.
#[tauri::command]
pub fn save_quiz_ask_threads(
    id: i64,
    ask_threads_json: String,
    db: State<'_, Db>,
) -> AppResult<()> {
    let conn = writer(&db)?;
    let changed = conn.execute(
        "UPDATE quiz_papers SET ask_threads_json = ?1 WHERE id = ?2",
        params![ask_threads_json, id],
    )?;
    if changed == 0 {
        return Err(AppError::Other("QUIZ_PAPER_NOT_FOUND".to_string()));
    }
    Ok(())
}

/// Take-page draft writeback (答案自动保存): the in-progress answer sheet is
/// small and always overwritten wholesale, same as ask threads. A submitted
/// paper is left untouched *without erroring* — the frontend's debounced save
/// can race the submit IPC, and once the result lands the draft is moot, so
/// dropping the late write is the correct outcome, not a failure.
pub(crate) fn save_quiz_paper_draft_inner(
    id: i64,
    draft_json: Option<String>,
    db: &Db,
) -> AppResult<()> {
    let conn = writer(db)?;
    let changed = conn.execute(
        "UPDATE quiz_papers SET draft_json = ?1 WHERE id = ?2 AND status != 'submitted'",
        params![draft_json, id],
    )?;
    if changed == 0 {
        let exists = conn
            .query_row(
                "SELECT 1 FROM quiz_papers WHERE id = ?1",
                params![id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Err(AppError::Other("QUIZ_PAPER_NOT_FOUND".to_string()));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn save_quiz_paper_draft(
    id: i64,
    draft_json: Option<String>,
    db: State<'_, Db>,
) -> AppResult<()> {
    save_quiz_paper_draft_inner(id, draft_json, &db)
}

// ===== Wrong-word pool queries =====

#[tauri::command]
pub fn list_due_wrong_words(db: State<'_, Db>) -> AppResult<Vec<WrongWordEntry>> {
    let conn = db.reader();
    let now_iso = iso_now(Utc::now());
    due_wrong_words(&conn, &now_iso)
}

#[tauri::command]
pub fn list_wrong_words(db: State<'_, Db>) -> AppResult<Vec<WrongWordEntry>> {
    all_wrong_words(&db.reader())
}

fn clear_all_wrong_words_inner(db: &Db) -> AppResult<()> {
    writer(db)?.execute("DELETE FROM quiz_wrong_words", [])?;
    Ok(())
}

/// Not part of the original deliverable list, but the direct Rust
/// counterpart of `scheduler.ts`'s `clearAllWrongWords` (ported below as
/// part of the full-coverage test port) — exposed so the pool UI's escape
/// hatch has something to call.
#[tauri::command]
pub fn clear_wrong_words(db: State<'_, Db>) -> AppResult<()> {
    clear_all_wrong_words_inner(&db)
}

// ===== Submit transaction =====

/// Submits a paper: writes the judged result, advances the wrong-word pool,
/// and writes FSRS reviews for every target word already in the vocab book —
/// all inside one transaction (`docs/impls/cijuan-merge.md` §二.3).
///
/// - **Idempotent**: a paper whose `status` is already `'submitted'` is
///   returned unchanged, with none of the below re-run — mirrors
///   `labs/cijuan/src/store/quizzes.ts`'s `submitQuiz` (`if (quiz.status ===
///   'submitted') return`). A retried submit after a crash or a flaky
///   network response must not double-count `wrong_count` or fire a second
///   FSRS review.
/// - **Demo papers** (`config_json.demo === true`) skip both the wrong-word
///   pool and the FSRS writeback entirely — sample words must never pollute
///   real learning data (§四 决议 3 in the plan; ported from `submitQuiz`'s
///   `if (!quiz.config.demo) await applyResult(...)`).
/// - **FSRS writeback** (§二.5): only for target words that already exist in
///   the vocab book (`find_confirmed_vocab_id_by_word` — case-insensitive,
///   `list_status = 'confirmed'` only; a word merely auto-detected into the
///   watchlist doesn't count). A word saved across multiple books has every
///   sibling row advanced together, via the same
///   `propagate_progress_to_siblings` call the rest of the FSRS surface
///   uses — `record_vocab_review_in_tx` is the exact function every other
///   review path in the app calls, not a quiz-specific copy of it.
///   - Correct → `good`.
///   - Wrong *and answered* → `again`.
///   - Wrong *and unanswered* (`user_answer` empty/whitespace-only on every
///     verdict for that word — see `QuestionVerdict`'s doc comment) → no
///     FSRS write at all, though the word still enters the wrong-word pool
///     like any other wrong answer. §四.3: "未作答不构成一次记忆检索事件，
///     写 again 会错误压低记忆状态。"
///   - A word wrong anywhere in the paper is never also treated as correct,
///     even if some other question about it was answered correctly — same
///     precedence `scheduler.ts` already applies to the pool
///     (`wrongSet`/`!wrongSet.has(w)`), extended here to the FSRS branch too
///     so a word never gets two contradictory review signals from one
///     submit.
pub(crate) fn submit_quiz_paper_inner(
    id: i64,
    result_json: String,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<QuizPaperRow> {
    let now = Utc::now();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now.timestamp_millis(), |tx, events| {
        let paper = fetch_paper(tx, id)?
            .ok_or_else(|| AppError::Other("QUIZ_PAPER_NOT_FOUND".to_string()))?;

        if paper.status == "submitted" {
            return Ok(paper);
        }
        // Progressive delivery: a paper still generating has an incomplete
        // word list (per-article settlement) — settling the pool/FSRS now
        // would silently drop the pending articles' words. The frontend
        // disables submit until 'ready'; this guard backs it.
        if paper.status == "generating" {
            return Err(AppError::Other("QUIZ_PAPER_NOT_READY".to_string()));
        }

        let demo = serde_json::from_str::<QuizConfigDemoFlag>(&paper.config_json)
            .map(|config| config.demo)
            .unwrap_or(false);
        let quiz_words: Vec<QuizWordRow> =
            serde_json::from_str(&paper.words_json).unwrap_or_default();
        let result: QuizResultInput = serde_json::from_str(&result_json)
            .map_err(|err| AppError::Other(format!("QUIZ_RESULT_INVALID: {err}")))?;

        // draft_json 一并清掉：结果落库后草稿已被取代，留着只会在数据里挂尸。
        tx.execute(
            "UPDATE quiz_papers SET status = 'submitted', result_json = ?1, draft_json = NULL WHERE id = ?2",
            params![result_json, id],
        )?;

        if !demo {
            let wrong_words = dedup_lower(result.wrong_words.iter().map(String::as_str));
            let wrong_set: HashSet<String> = wrong_words.iter().cloned().collect();

            let correct_target_words: HashSet<String> = result
                .verdicts
                .iter()
                .filter(|verdict| verdict.correct)
                .map(|verdict| verdict.target_word.to_lowercase())
                .collect();
            let correct_words =
                dedup_lower(quiz_words.iter().map(|w| w.word.as_str()).filter(|word| {
                    let lower = word.to_lowercase();
                    correct_target_words.contains(&lower) && !wrong_set.contains(&lower)
                }));

            apply_quiz_result_in_tx(tx, &wrong_words, &correct_words, now)?;

            for word in &wrong_words {
                let has_answered_wrong = result.verdicts.iter().any(|verdict| {
                    !verdict.correct
                        && verdict.target_word.to_lowercase() == *word
                        && !verdict.user_answer.trim().is_empty()
                });
                if !has_answered_wrong {
                    // Every wrong verdict for this word was left blank — not
                    // a real recall attempt. The pool already advanced above;
                    // FSRS stays untouched (§四.3).
                    continue;
                }
                if let Some(vocab_id) = find_confirmed_vocab_id_by_word(tx, word)? {
                    record_vocab_review_in_tx(
                        tx,
                        events,
                        &vocab_id,
                        VocabReviewRating::Again,
                        now.timestamp_millis(),
                        &device,
                    )?;
                }
            }
            for word in &correct_words {
                if let Some(vocab_id) = find_confirmed_vocab_id_by_word(tx, word)? {
                    record_vocab_review_in_tx(
                        tx,
                        events,
                        &vocab_id,
                        VocabReviewRating::Good,
                        now.timestamp_millis(),
                        &device,
                    )?;
                }
            }
        }

        fetch_paper(tx, id)?.ok_or_else(|| AppError::Other("QUIZ_PAPER_NOT_FOUND".to_string()))
    })
}

#[tauri::command]
pub fn submit_quiz_paper(
    id: i64,
    result_json: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<QuizPaperRow> {
    submit_quiz_paper_inner(id, result_json, &db, &sync)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::vocab::add_vocab_word_inner;
    use crate::sync::log::EventLog;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn setup_db() -> (TempDir, Db, SyncWriter) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let writer = SyncWriter::new("dev-quiz".into());
        writer.set_should_queue(true);
        writer.set_log(Some(Arc::new(
            EventLog::open(&dir.path().join("logs/dev-quiz.jsonl"), "dev-quiz", false).unwrap(),
        )));
        writer.set_flush_inline_for_tests(true);
        (dir, db, writer)
    }

    fn insert_book(db: &Db, id: &str) {
        let now = 1_700_000_000_000_i64;
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES (?1, 'Quiz Book', 'Author', 'books/quiz.epub', 'unread', 0, ?2, ?2)",
                params![id, now],
            )
            .unwrap();
    }

    fn wrong_words_table(db: &Db) -> Vec<WrongWordEntry> {
        all_wrong_words(&db.reader()).unwrap()
    }

    fn run_apply(db: &Db, wrong_words: &[&str], correct_words: &[&str], now: DateTime<Utc>) {
        let wrong: Vec<String> = wrong_words.iter().map(|w| w.to_string()).collect();
        let correct: Vec<String> = correct_words.iter().map(|w| w.to_string()).collect();
        let mut conn = db.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        apply_quiz_result_in_tx(&tx, &wrong, &correct, now).unwrap();
        tx.commit().unwrap();
    }

    // ===== Scheduler port: labs/cijuan/src/store/scheduler.test.ts =====

    #[test]
    fn new_wrong_word_enters_pool_at_stage_zero_with_two_day_due() {
        let (_dir, db, _sync) = setup_db();
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        run_apply(&db, &["subsidy"], &[], now);

        let entries = wrong_words_table(&db);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].word, "subsidy");
        assert_eq!(entries[0].wrong_count, 1);
        assert_eq!(entries[0].stage, 0);
        assert!(!entries[0].cleared);
        assert_eq!(entries[0].first_wrong_at, iso_now(now));
        assert_eq!(entries[0].last_wrong_at, iso_now(now));
        assert_eq!(
            entries[0].next_due_at.as_deref(),
            Some(iso_plus_days(now, 2).as_str())
        );
    }

    #[test]
    fn stage0_correct_promotes_to_stage1_with_seven_day_due() {
        let (_dir, db, _sync) = setup_db();
        let t0 = DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        run_apply(&db, &["subsidy"], &[], t0);

        let t1 = DateTime::parse_from_rfc3339("2026-01-03T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        run_apply(&db, &[], &["subsidy"], t1);

        let entries = wrong_words_table(&db);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].stage, 1);
        assert!(!entries[0].cleared);
        assert_eq!(
            entries[0].next_due_at.as_deref(),
            Some(iso_plus_days(t1, 7).as_str())
        );
    }

    #[test]
    fn stage1_correct_clears_the_word() {
        let (_dir, db, _sync) = setup_db();
        let t0 = DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO quiz_wrong_words (word, wrong_count, first_wrong_at, last_wrong_at, stage, next_due_at, cleared)
                 VALUES ('subsidy', 1, ?1, ?1, 1, ?2, 0)",
                params![iso_now(t0), iso_plus_days(t0, 7)],
            )
            .unwrap();

        let t1 = DateTime::parse_from_rfc3339("2026-01-08T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        run_apply(&db, &[], &["subsidy"], t1);

        let entries = wrong_words_table(&db);
        assert!(entries[0].cleared);
        assert_eq!(entries[0].next_due_at, None);
    }

    #[test]
    fn cleared_word_wrong_again_reenters_pool_with_accumulated_wrong_count() {
        let (_dir, db, _sync) = setup_db();
        let t0 = DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO quiz_wrong_words (word, wrong_count, first_wrong_at, last_wrong_at, stage, next_due_at, cleared)
                 VALUES ('subsidy', 2, ?1, ?1, 1, NULL, 1)",
                params![iso_now(t0)],
            )
            .unwrap();

        let t1 = DateTime::parse_from_rfc3339("2026-02-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        run_apply(&db, &["subsidy"], &[], t1);

        let entries = wrong_words_table(&db);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].stage, 0);
        assert!(!entries[0].cleared);
        assert_eq!(entries[0].wrong_count, 3);
        // Old word: first_wrong_at is not reset.
        assert_eq!(entries[0].first_wrong_at, iso_now(t0));
        assert_eq!(entries[0].last_wrong_at, iso_now(t1));
        assert_eq!(
            entries[0].next_due_at.as_deref(),
            Some(iso_plus_days(t1, 2).as_str())
        );
    }

    #[test]
    fn same_paper_both_right_and_wrong_resolves_to_wrong_no_stage_advance() {
        let (_dir, db, _sync) = setup_db();
        let t0 = DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        // correct_words already excludes anything in wrong_words, matching
        // how submit_quiz_paper_inner computes the split — this test drives
        // apply_quiz_result_in_tx directly with that same precedence applied.
        run_apply(&db, &["subsidy"], &[], t0);

        let entries = wrong_words_table(&db);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].stage, 0);
        assert!(!entries[0].cleared);
        assert_eq!(entries[0].wrong_count, 1);
    }

    #[test]
    fn correct_but_not_in_pool_is_a_noop() {
        let (_dir, db, _sync) = setup_db();
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        run_apply(&db, &[], &["brandnew"], now);
        assert!(wrong_words_table(&db).is_empty());
    }

    #[test]
    fn get_due_words_filters_uncleared_and_due() {
        let (_dir, db, _sync) = setup_db();
        let now = DateTime::parse_from_rfc3339("2026-01-10T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO quiz_wrong_words (word, wrong_count, first_wrong_at, last_wrong_at, stage, next_due_at, cleared)
             VALUES ('due', 1, ?1, ?1, 0, ?1, 0)",
            params![iso_now(now)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO quiz_wrong_words (word, wrong_count, first_wrong_at, last_wrong_at, stage, next_due_at, cleared)
             VALUES ('not_due_yet', 1, ?1, ?1, 0, ?2, 0)",
            params![iso_now(now), iso_plus_days(now, 1)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO quiz_wrong_words (word, wrong_count, first_wrong_at, last_wrong_at, stage, next_due_at, cleared)
             VALUES ('cleared_but_past_due', 1, ?1, ?1, 1, NULL, 1)",
            params![iso_now(now)],
        )
        .unwrap();
        drop(conn);

        let due = due_wrong_words(&db.reader(), &iso_now(now)).unwrap();
        assert_eq!(
            due.iter().map(|e| e.word.as_str()).collect::<Vec<_>>(),
            vec!["due"]
        );
    }

    #[test]
    fn list_wrong_words_returns_all_sorted_by_last_wrong_at_desc() {
        let (_dir, db, _sync) = setup_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO quiz_wrong_words (word, wrong_count, first_wrong_at, last_wrong_at, stage, next_due_at, cleared)
             VALUES ('earlier', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, '2026-01-03T00:00:00.000Z', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO quiz_wrong_words (word, wrong_count, first_wrong_at, last_wrong_at, stage, next_due_at, cleared)
             VALUES ('later', 1, '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z', 1, NULL, 1)",
            [],
        )
        .unwrap();
        drop(conn);

        let all = all_wrong_words(&db.reader()).unwrap();
        assert_eq!(
            all.iter().map(|e| e.word.as_str()).collect::<Vec<_>>(),
            vec!["later", "earlier"]
        );
    }

    #[test]
    fn clear_all_wrong_words_empties_the_table() {
        let (_dir, db, _sync) = setup_db();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO quiz_wrong_words (word, wrong_count, first_wrong_at, last_wrong_at, stage, next_due_at, cleared)
                 VALUES ('a', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, '2026-01-03T00:00:00.000Z', 0)",
                [],
            )
            .unwrap();
        clear_all_wrong_words_inner(&db).unwrap();
        assert!(wrong_words_table(&db).is_empty());
    }

    // ===== Submit transaction: labs/cijuan/src/store/quizzes.test.ts =====

    fn create_paper(db: &Db, created_at: &str, demo: bool) -> i64 {
        create_paper_with_words(db, created_at, demo, &[("subsidy", "today")])
    }

    fn create_paper_with_words(
        db: &Db,
        created_at: &str,
        demo: bool,
        words: &[(&str, &str)],
    ) -> i64 {
        let config = serde_json::json!({
            "difficulty": "cet6",
            "types": ["reading"],
            "materialSource": "ai-original",
            "model": "demo",
            "maskedCheck": false,
            "demo": demo,
        });
        let words_json: Vec<serde_json::Value> = words
            .iter()
            .map(|(word, origin)| serde_json::json!({ "word": word, "origin": origin }))
            .collect();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO quiz_papers (created_at, status, config_json, words_json, content_json)
                 VALUES (?1, 'ready', ?2, ?3, '{}')",
            params![
                created_at,
                config.to_string(),
                serde_json::Value::Array(words_json).to_string()
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn wrong_result_json(target_word: &str, user_answer: &str) -> String {
        serde_json::json!({
            "submittedAt": "2026-01-01T00:10:00.000Z",
            "verdicts": [
                { "questionId": "rq1", "targetWord": target_word, "correct": false, "userAnswer": user_answer, "correctAnswer": "A" }
            ],
            "score": 0,
            "total": 1,
            "wrongWords": [target_word],
        })
        .to_string()
    }

    #[test]
    fn save_get_list_round_trip_orders_by_created_at_desc() {
        let (_dir, db, _sync) = setup_db();
        let id1 = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        let id2 = create_paper(&db, "2026-01-02T00:00:00.000Z", false);

        let got = fetch_paper(&db.reader(), id1).unwrap().unwrap();
        assert!(got.words_json.contains("subsidy"));

        let conn = db.reader();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PAPER_COLS} FROM quiz_papers ORDER BY created_at DESC, id DESC"
            ))
            .unwrap();
        let all: Vec<QuizPaperRow> = stmt
            .query_map([], row_to_paper)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(all.iter().map(|p| p.id).collect::<Vec<_>>(), vec![id2, id1]);
    }

    #[test]
    fn submit_writes_status_and_result_and_drives_wrong_pool() {
        let (_dir, db, sync) = setup_db();
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);

        let updated =
            submit_quiz_paper_inner(id, wrong_result_json("subsidy", "B"), &db, &sync).unwrap();
        assert_eq!(updated.status, "submitted");
        assert!(updated.result_json.unwrap().contains("\"score\":0"));

        let entries = wrong_words_table(&db);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].word, "subsidy");
    }

    #[test]
    fn submit_on_nonexistent_paper_errors() {
        let (_dir, db, sync) = setup_db();
        let result = submit_quiz_paper_inner(
            999,
            serde_json::json!({ "submittedAt": "", "verdicts": [], "score": 0, "total": 0, "wrongWords": [] }).to_string(),
            &db,
            &sync,
        );
        assert!(result.is_err());
    }

    #[test]
    fn submit_is_idempotent_does_not_double_count_wrong_count() {
        let (_dir, db, sync) = setup_db();
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        let result_json = wrong_result_json("subsidy", "B");

        submit_quiz_paper_inner(id, result_json.clone(), &db, &sync).unwrap();
        submit_quiz_paper_inner(id, result_json, &db, &sync).unwrap();

        let entries = wrong_words_table(&db);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].wrong_count, 1);
    }

    #[test]
    fn demo_paper_submit_leaves_wrong_pool_untouched() {
        let (_dir, db, sync) = setup_db();
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", true);

        let updated =
            submit_quiz_paper_inner(id, wrong_result_json("subsidy", "B"), &db, &sync).unwrap();
        assert_eq!(updated.status, "submitted");
        assert!(wrong_words_table(&db).is_empty());
    }

    #[test]
    fn wrong_word_identity_is_case_insensitive_across_papers() {
        let (_dir, db, sync) = setup_db();
        let id1 =
            create_paper_with_words(&db, "2026-01-01T00:00:00.000Z", false, &[("Curb", "today")]);
        submit_quiz_paper_inner(id1, wrong_result_json("Curb", "B"), &db, &sync).unwrap();

        let id2 =
            create_paper_with_words(&db, "2026-01-02T00:00:00.000Z", false, &[("curb", "recur")]);
        submit_quiz_paper_inner(id2, wrong_result_json("curb", "C"), &db, &sync).unwrap();

        let entries = wrong_words_table(&db);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].word, "curb");
        assert_eq!(entries[0].wrong_count, 2);
    }

    #[test]
    fn same_word_both_right_and_wrong_stays_stage_0_and_writes_only_again() {
        // Full-pipeline version of `same_paper_both_right_and_wrong_resolves_to_wrong_no_stage_advance`
        // (quiz.rs:677): drives `submit_quiz_paper_inner` end to end with a
        // result_json where "subsidy" is both a correct verdict and a
        // wrongWords entry, instead of pre-split inputs. This is the only
        // test that actually exercises the `&& !wrong_set.contains(&lower)`
        // guard at quiz.rs:471 — deleting that guard makes every other test
        // in this file pass, but breaks this one.
        let (_dir, db, sync) = setup_db();
        let vocab_id = confirmed_word(&db, &sync, "book-a", "subsidy");
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        let result_json = serde_json::json!({
            "submittedAt": "2026-01-01T00:10:00.000Z",
            "verdicts": [
                { "questionId": "rq1", "targetWord": "subsidy", "correct": true, "userAnswer": "A", "correctAnswer": "A" },
                { "questionId": "rq2", "targetWord": "subsidy", "correct": false, "userAnswer": "B", "correctAnswer": "A" }
            ],
            "score": 1,
            "total": 2,
            "wrongWords": ["subsidy"],
        })
        .to_string();

        submit_quiz_paper_inner(id, result_json, &db, &sync).unwrap();

        // Wrong-word pool: stays at stage 0, +2 days, not promoted to stage 1.
        let entries = wrong_words_table(&db);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].word, "subsidy");
        assert_eq!(entries[0].stage, 0);
        assert!(!entries[0].cleared);
        let last_wrong_at = DateTime::parse_from_rfc3339(&entries[0].last_wrong_at)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            entries[0].next_due_at.as_deref(),
            Some(iso_plus_days(last_wrong_at, 2).as_str())
        );

        // FSRS writeback: exactly one review row, rated "again", nothing "good".
        let conn = db.reader();
        let ratings: Vec<String> = conn
            .prepare(
                "SELECT rating FROM vocab_review_log WHERE vocab_word_id = ?1 ORDER BY reviewed_at",
            )
            .unwrap()
            .query_map(params![vocab_id], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ratings, vec!["again".to_string()]);

        let last_rating: String = conn
            .query_row(
                "SELECT last_review_rating FROM vocab_words WHERE id = ?1",
                params![vocab_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(last_rating, "again");
    }

    // ===== FSRS writeback (§二.5) =====

    fn confirmed_word(db: &Db, sync: &SyncWriter, book_id: &str, word: &str) -> String {
        insert_book(db, book_id);
        add_vocab_word_inner(
            book_id,
            word,
            "a definition",
            None,
            None,
            None,
            None,
            db,
            sync,
        )
        .unwrap()
        .id
    }

    #[test]
    fn fsrs_writes_again_for_a_wrong_answered_word_already_in_the_vocab_book() {
        let (_dir, db, sync) = setup_db();
        let vocab_id = confirmed_word(&db, &sync, "book-a", "subsidy");
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);

        submit_quiz_paper_inner(id, wrong_result_json("subsidy", "B"), &db, &sync).unwrap();

        let rating: String = db
            .reader()
            .query_row(
                "SELECT last_review_rating FROM vocab_words WHERE id = ?1",
                params![vocab_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rating, "again");
    }

    #[test]
    fn fsrs_writes_good_for_a_correct_word_already_in_the_vocab_book() {
        let (_dir, db, sync) = setup_db();
        let vocab_id = confirmed_word(&db, &sync, "book-a", "subsidy");
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        let result_json = serde_json::json!({
            "submittedAt": "2026-01-01T00:10:00.000Z",
            "verdicts": [
                { "questionId": "rq1", "targetWord": "subsidy", "correct": true, "userAnswer": "A", "correctAnswer": "A" }
            ],
            "score": 1,
            "total": 1,
            "wrongWords": [],
        })
        .to_string();

        submit_quiz_paper_inner(id, result_json, &db, &sync).unwrap();

        let rating: String = db
            .reader()
            .query_row(
                "SELECT last_review_rating FROM vocab_words WHERE id = ?1",
                params![vocab_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rating, "good");
    }

    #[test]
    fn fsrs_skips_words_not_in_the_vocab_book() {
        let (_dir, db, sync) = setup_db();
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        // No vocab word exists at all — submit must succeed without an FSRS write.
        let updated =
            submit_quiz_paper_inner(id, wrong_result_json("subsidy", "B"), &db, &sync).unwrap();
        assert_eq!(updated.status, "submitted");
        let count: i64 = db
            .reader()
            .query_row("SELECT COUNT(*) FROM vocab_words", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn fsrs_skips_unanswered_wrong_word_but_still_enters_the_wrong_pool() {
        let (_dir, db, sync) = setup_db();
        let vocab_id = confirmed_word(&db, &sync, "book-a", "subsidy");
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);

        // Empty user_answer: the question was left blank, not answered wrong.
        submit_quiz_paper_inner(id, wrong_result_json("subsidy", ""), &db, &sync).unwrap();

        // Wrong-word pool still advances — an unfinished paper still means
        // the word is due for reappearance.
        let entries = wrong_words_table(&db);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].word, "subsidy");

        // But FSRS must not have been touched: review_count stays at 0 and
        // last_review_rating stays NULL, exactly as a freshly added word.
        let (review_count, rating): (i64, Option<String>) = db
            .reader()
            .query_row(
                "SELECT review_count, last_review_rating FROM vocab_words WHERE id = ?1",
                params![vocab_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(review_count, 0);
        assert_eq!(rating, None);
    }

    #[test]
    fn fsrs_advances_every_cross_book_sibling_entry() {
        let (_dir, db, sync) = setup_db();
        insert_book(&db, "book-a");
        insert_book(&db, "book-b");
        let a = add_vocab_word_inner(
            "book-a", "Subsidy", "def a", None, None, None, None, &db, &sync,
        )
        .unwrap()
        .id;
        let b = add_vocab_word_inner(
            "book-b", "subsidy", "def b", None, None, None, None, &db, &sync,
        )
        .unwrap()
        .id;
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);

        submit_quiz_paper_inner(id, wrong_result_json("subsidy", "B"), &db, &sync).unwrap();

        let conn = db.reader();
        let rating_a: String = conn
            .query_row(
                "SELECT last_review_rating FROM vocab_words WHERE id = ?1",
                params![a],
                |row| row.get(0),
            )
            .unwrap();
        let rating_b: String = conn
            .query_row(
                "SELECT last_review_rating FROM vocab_words WHERE id = ?1",
                params![b],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rating_a, "again");
        assert_eq!(rating_b, "again");
    }

    // ===== Progressive delivery (docs/impls/quiz-progressive-delivery.md) =====

    #[test]
    fn create_generating_paper_then_advance_to_ready() {
        let (_dir, db, _sync) = setup_db();
        let id = create_quiz_paper_inner(
            "2026-01-01T00:00:00.000Z".into(),
            "generating".into(),
            "{}".into(),
            "[]".into(),
            "{\"passages\":[]}".into(),
            Some("{\"groups\":[]}".into()),
            &db,
        )
        .unwrap();

        let paper = fetch_paper(&db.reader(), id).unwrap().unwrap();
        assert_eq!(paper.status, "generating");
        assert_eq!(paper.generation_json.as_deref(), Some("{\"groups\":[]}"));

        // Last article lands: content/words grow, status flips to ready, plan cleared —
        // the row must end up shape-identical to a non-progressive paper.
        update_quiz_paper_generation_inner(
            id,
            "{\"passages\":[1,2]}".into(),
            "[\"subsidy\"]".into(),
            "ready".into(),
            None,
            &db,
        )
        .unwrap();
        let paper = fetch_paper(&db.reader(), id).unwrap().unwrap();
        assert_eq!(paper.status, "ready");
        assert_eq!(paper.content_json, "{\"passages\":[1,2]}");
        assert_eq!(paper.words_json, "[\"subsidy\"]");
        assert!(paper.generation_json.is_none());
    }

    #[test]
    fn create_rejects_invalid_status() {
        let (_dir, db, _sync) = setup_db();
        let err = create_quiz_paper_inner(
            "2026-01-01T00:00:00.000Z".into(),
            "submitted".into(),
            "{}".into(),
            "[]".into(),
            "{}".into(),
            None,
            &db,
        )
        .unwrap_err();
        assert!(err.to_string().contains("QUIZ_STATUS_INVALID"));
    }

    #[test]
    fn generation_update_rejects_invalid_status() {
        let (_dir, db, _sync) = setup_db();
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        // 'submitted' is only reachable through submit_quiz_paper — the
        // generation writeback must never be able to fabricate it.
        let err = update_quiz_paper_generation_inner(
            id,
            "{}".into(),
            "[]".into(),
            "submitted".into(),
            None,
            &db,
        )
        .unwrap_err();
        assert!(err.to_string().contains("QUIZ_STATUS_INVALID"));
    }

    #[test]
    fn delete_removes_unsubmitted_paper() {
        let (_dir, db, _sync) = setup_db();
        let id = create_quiz_paper_inner(
            "2026-01-01T00:00:00.000Z".into(),
            "generating".into(),
            "{}".into(),
            "[]".into(),
            "{\"passages\":[]}".into(),
            Some("{\"groups\":[]}".into()),
            &db,
        )
        .unwrap();

        delete_quiz_paper_inner(id, &db).unwrap();
        assert!(fetch_paper(&db.reader(), id).unwrap().is_none());
    }

    #[test]
    fn delete_refuses_submitted_and_missing_papers() {
        let (_dir, db, sync) = setup_db();
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        submit_quiz_paper_inner(id, wrong_result_json("subsidy", "B"), &db, &sync).unwrap();

        let err = delete_quiz_paper_inner(id, &db).unwrap_err();
        assert!(err.to_string().contains("QUIZ_PAPER_ALREADY_SUBMITTED"));
        assert!(fetch_paper(&db.reader(), id).unwrap().is_some());

        let err = delete_quiz_paper_inner(999, &db).unwrap_err();
        assert!(err.to_string().contains("QUIZ_PAPER_NOT_FOUND"));
    }

    #[test]
    fn generation_update_refuses_submitted_and_missing_papers() {
        let (_dir, db, sync) = setup_db();
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        submit_quiz_paper_inner(id, wrong_result_json("subsidy", "B"), &db, &sync).unwrap();

        let err = update_quiz_paper_generation_inner(
            id,
            "{}".into(),
            "[]".into(),
            "ready".into(),
            None,
            &db,
        )
        .unwrap_err();
        assert!(err.to_string().contains("QUIZ_PAPER_ALREADY_SUBMITTED"));

        let err = update_quiz_paper_generation_inner(
            999,
            "{}".into(),
            "[]".into(),
            "ready".into(),
            None,
            &db,
        )
        .unwrap_err();
        assert!(err.to_string().contains("QUIZ_PAPER_NOT_FOUND"));
    }

    #[test]
    fn submit_refuses_generating_paper() {
        let (_dir, db, sync) = setup_db();
        let id = create_quiz_paper_inner(
            "2026-01-01T00:00:00.000Z".into(),
            "generating".into(),
            "{}".into(),
            "[]".into(),
            "{}".into(),
            Some("{\"groups\":[]}".into()),
            &db,
        )
        .unwrap();

        let err =
            submit_quiz_paper_inner(id, wrong_result_json("subsidy", "B"), &db, &sync).unwrap_err();
        assert!(err.to_string().contains("QUIZ_PAPER_NOT_READY"));
        // And nothing settled: the pool must be untouched by the refused submit.
        assert!(wrong_words_table(&db).is_empty());
    }

    // ===== Draft answers (答案自动保存) =====

    #[test]
    fn draft_round_trips_overwrites_and_clears() {
        let (_dir, db, _sync) = setup_db();
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        assert_eq!(
            fetch_paper(&db.reader(), id).unwrap().unwrap().draft_json,
            None
        );

        save_quiz_paper_draft_inner(id, Some("{\"answers\":{\"rq1\":\"A\"}}".into()), &db).unwrap();
        assert_eq!(
            fetch_paper(&db.reader(), id)
                .unwrap()
                .unwrap()
                .draft_json
                .as_deref(),
            Some("{\"answers\":{\"rq1\":\"A\"}}")
        );

        // Wholesale overwrite, then explicit clear via NULL.
        save_quiz_paper_draft_inner(id, Some("{\"answers\":{\"rq1\":\"B\"}}".into()), &db).unwrap();
        assert_eq!(
            fetch_paper(&db.reader(), id)
                .unwrap()
                .unwrap()
                .draft_json
                .as_deref(),
            Some("{\"answers\":{\"rq1\":\"B\"}}")
        );
        save_quiz_paper_draft_inner(id, None, &db).unwrap();
        assert_eq!(
            fetch_paper(&db.reader(), id).unwrap().unwrap().draft_json,
            None
        );
    }

    #[test]
    fn submit_clears_draft() {
        let (_dir, db, sync) = setup_db();
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        save_quiz_paper_draft_inner(id, Some("{\"answers\":{\"rq1\":\"B\"}}".into()), &db).unwrap();

        let row =
            submit_quiz_paper_inner(id, wrong_result_json("subsidy", "B"), &db, &sync).unwrap();
        assert_eq!(row.status, "submitted");
        assert_eq!(row.draft_json, None);
    }

    #[test]
    fn draft_save_after_submit_is_a_silent_noop() {
        let (_dir, db, sync) = setup_db();
        let id = create_paper(&db, "2026-01-01T00:00:00.000Z", false);
        submit_quiz_paper_inner(id, wrong_result_json("subsidy", "B"), &db, &sync).unwrap();

        // The debounced frontend save racing the submit must not error and
        // must not resurrect a draft on the settled paper.
        save_quiz_paper_draft_inner(id, Some("{\"answers\":{\"rq1\":\"C\"}}".into()), &db).unwrap();
        assert_eq!(
            fetch_paper(&db.reader(), id).unwrap().unwrap().draft_json,
            None
        );

        let err = save_quiz_paper_draft_inner(999, None, &db).unwrap_err();
        assert!(err.to_string().contains("QUIZ_PAPER_NOT_FOUND"));
    }
}
