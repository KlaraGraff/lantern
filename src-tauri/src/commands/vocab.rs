use chrono::{TimeZone, Utc};
use fsrs::{MemoryState, DEFAULT_PARAMETERS, FSRS};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

use crate::commands::mastery_events::record_mastery_event;
use crate::db::Db;
use crate::error::AppResult;
use crate::sync::events::{EventBody, VocabPayload, VocabReviewLogPayload};
use crate::sync::merge::{entity, insert_tombstone};
use crate::sync::writer::SyncWriter;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct VocabWord {
    pub id: String,
    pub book_id: String,
    pub word: String,
    pub definition: String,
    pub context_sentence: Option<String>,
    pub context_explanation: Option<String>,
    pub cfi: Option<String>,
    pub mastery: String,
    /// 'auto' when the reading-exposure engine decided the tier, 'manual'
    /// when the user set it or a review decided it. Defaults to 'manual'.
    #[serde(default = "default_mastery_source")]
    pub mastery_source: String,
    /// The facts the word-detail page's explanation sentence is rendered
    /// from. JSON text, or None when no automatic decision has been made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mastery_reason: Option<String>,
    /// The observation zone (docs/impls/reading-flow-decisions-2026-08-06.md
    /// §1): 'watchlist' from the first lookup, 'confirmed' once the reader
    /// saves the word or looks it up a 3rd cumulative time in the same book.
    /// Not a new concept shown to the reader — see `default_list_status` and
    /// migration 044 — only a filter value the vocab list defaults to.
    #[serde(default = "default_list_status")]
    pub list_status: String,
    pub review_count: i64,
    pub next_review_at: Option<i64>,
    pub review_interval_days: i64,
    pub last_reviewed_at: Option<i64>,
    pub last_review_rating: Option<String>,
    pub fsrs_stability: Option<f64>,
    pub fsrs_difficulty: Option<f64>,
    pub fsrs_version: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_title: Option<String>,
    /// Derived, not stored: the chapter the word was looked up in, recovered
    /// from lookup history. Absent from the JSON when unknown so a partial
    /// update (e.g. a review result) can't blank a chapter the list already
    /// resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VocabStats {
    pub total: i64,
    pub new_count: i64,
    pub learning_count: i64,
    /// The tier migration 038 added. It has its own bucket rather than being
    /// folded into a neighbour because these four counts are handed to the
    /// MCP client as a breakdown of `total` — silently dropping a tier would
    /// hand an AI numbers that do not add up, with nothing to say so.
    pub familiar_count: i64,
    pub mastered_count: i64,
    pub due_for_review: i64,
}

pub(crate) fn row_to_vocab(row: &rusqlite::Row) -> rusqlite::Result<VocabWord> {
    Ok(VocabWord {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        word: row.get("word")?,
        definition: row.get("definition")?,
        context_sentence: row.get("context_sentence")?,
        cfi: row.get("cfi")?,
        mastery: row.get("mastery")?,
        review_count: row.get("review_count")?,
        next_review_at: row.get("next_review_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        context_explanation: row.get("context_explanation")?,
        review_interval_days: row.get("review_interval_days")?,
        last_reviewed_at: row.get("last_reviewed_at")?,
        last_review_rating: row.get("last_review_rating")?,
        fsrs_stability: row.get("fsrs_stability")?,
        fsrs_difficulty: row.get("fsrs_difficulty")?,
        fsrs_version: row.get("fsrs_version")?,
        mastery_source: row.get("mastery_source")?,
        mastery_reason: row.get("mastery_reason")?,
        list_status: row.get("list_status")?,
        book_title: None,
        chapter: None,
    })
}

fn row_to_vocab_with_book(row: &rusqlite::Row) -> rusqlite::Result<VocabWord> {
    Ok(VocabWord {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        word: row.get("word")?,
        definition: row.get("definition")?,
        context_sentence: row.get("context_sentence")?,
        cfi: row.get("cfi")?,
        mastery: row.get("mastery")?,
        review_count: row.get("review_count")?,
        next_review_at: row.get("next_review_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        context_explanation: row.get("context_explanation")?,
        review_interval_days: row.get("review_interval_days")?,
        last_reviewed_at: row.get("last_reviewed_at")?,
        last_review_rating: row.get("last_review_rating")?,
        fsrs_stability: row.get("fsrs_stability")?,
        fsrs_difficulty: row.get("fsrs_difficulty")?,
        fsrs_version: row.get("fsrs_version")?,
        mastery_source: row.get("mastery_source")?,
        mastery_reason: row.get("mastery_reason")?,
        list_status: row.get("list_status")?,
        book_title: row.get("book_title")?,
        chapter: row.get("chapter")?,
    })
}

pub(crate) const SELECT_COLS: &str = "id, book_id, word, definition, context_sentence, cfi, mastery, review_count, next_review_at, created_at, updated_at, context_explanation, review_interval_days, last_reviewed_at, last_review_rating, fsrs_stability, fsrs_difficulty, fsrs_version, mastery_source, mastery_reason, list_status";

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Probability the scheduler aims for that a word is still recalled when it
/// next comes up. 0.9 is the FSRS default and what `rs-fsrs` used implicitly
/// before the swap, so the swap does not silently reschedule anyone's deck.
const DESIRED_RETENTION: f32 = 0.9;
/// How far ahead a card goes when FSRS asks for less than a day. Ten minutes
/// is short enough that a lapsed word comes back in the same sitting and long
/// enough that it is not the very next card.
const RELEARN_STEP_MS: i64 = 10 * 60 * 1000;
const VOCAB_BACKUP_SCHEMA: &str = "lantern-vocabulary";
const VOCAB_BACKUP_VERSION: u32 = 1;
const MAX_VOCAB_IMPORT_BYTES: usize = 10 * 1024 * 1024;
const MAX_VOCAB_IMPORT_WORDS: usize = 50_000;

fn is_known_vocab_backup_schema(schema: &str) -> bool {
    schema == VOCAB_BACKUP_SCHEMA
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VocabBackup {
    pub schema: String,
    pub version: u32,
    pub exported_at: i64,
    pub words: Vec<VocabBackupWord>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VocabBackupWord {
    pub id: String,
    pub book_id: String,
    pub word: String,
    pub definition: String,
    #[serde(default)]
    pub context_sentence: Option<String>,
    #[serde(default)]
    pub context_explanation: Option<String>,
    #[serde(default)]
    pub cfi: Option<String>,
    #[serde(default = "default_mastery")]
    pub mastery: String,
    #[serde(default = "default_mastery_source")]
    pub mastery_source: String,
    #[serde(default)]
    pub mastery_reason: Option<String>,
    #[serde(default)]
    pub review_count: i64,
    #[serde(default)]
    pub next_review_at: Option<i64>,
    #[serde(default)]
    pub review_interval_days: i64,
    #[serde(default)]
    pub last_reviewed_at: Option<i64>,
    #[serde(default)]
    pub last_review_rating: Option<String>,
    #[serde(default)]
    pub fsrs_stability: Option<f64>,
    #[serde(default)]
    pub fsrs_difficulty: Option<f64>,
    #[serde(default = "default_fsrs_version")]
    pub fsrs_version: i64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    // A backup never contains a watchlist word (export leaves them out — see
    // `export_vocab_backup_inner`), but old backups predate this field
    // outright, so both cases decode the same way: a word the reader
    // consciously saved.
    #[serde(default = "default_list_status")]
    pub list_status: String,
}

fn default_mastery() -> String {
    "new".to_string()
}

fn default_mastery_source() -> String {
    "manual".to_string()
}

fn default_fsrs_version() -> i64 {
    1
}

fn default_list_status() -> String {
    "confirmed".to_string()
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VocabImportFormat {
    Json,
    Csv,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VocabImportConflictPolicy {
    Skip,
    Merge,
    Overwrite,
}

#[derive(Debug, Serialize)]
pub struct VocabImportPreview {
    pub valid: usize,
    pub new_words: usize,
    pub conflicts: usize,
    pub missing_books: usize,
    pub duplicate_rows: usize,
    pub invalid_rows: usize,
}

#[derive(Debug, Serialize)]
pub struct VocabImportResult {
    pub preview: VocabImportPreview,
    pub imported: usize,
    pub replaced: usize,
    pub skipped: usize,
    pub dry_run: bool,
}

#[derive(Debug, Clone)]
struct VocabReviewState {
    review_count: i64,
    review_interval_days: i64,
    last_reviewed_at: Option<i64>,
    last_review_rating: Option<String>,
    fsrs_stability: Option<f64>,
    fsrs_difficulty: Option<f64>,
    fsrs_version: i64,
}

/// Reads the review columns by name, so a query may select the word
/// alongside them without a second round trip.
fn row_to_review_state(row: &rusqlite::Row) -> rusqlite::Result<VocabReviewState> {
    Ok(VocabReviewState {
        review_count: row.get("review_count")?,
        review_interval_days: row.get("review_interval_days")?,
        last_reviewed_at: row.get("last_reviewed_at")?,
        last_review_rating: row.get("last_review_rating")?,
        fsrs_stability: row.get("fsrs_stability")?,
        fsrs_difficulty: row.get("fsrs_difficulty")?,
        fsrs_version: row.get("fsrs_version")?,
    })
}

#[derive(Debug, Deserialize)]
struct VocabCsvRow {
    backup_schema: String,
    backup_version: u32,
    id: String,
    book_id: String,
    word: String,
    definition: String,
    #[serde(default)]
    context_sentence: Option<String>,
    #[serde(default)]
    context_explanation: Option<String>,
    #[serde(default)]
    cfi: Option<String>,
    #[serde(default = "default_mastery")]
    mastery: String,
    #[serde(default = "default_mastery_source")]
    mastery_source: String,
    #[serde(default)]
    mastery_reason: Option<String>,
    #[serde(default)]
    review_count: i64,
    #[serde(default)]
    next_review_at: Option<i64>,
    #[serde(default)]
    review_interval_days: i64,
    #[serde(default)]
    last_reviewed_at: Option<i64>,
    #[serde(default)]
    last_review_rating: Option<String>,
    #[serde(default)]
    fsrs_stability: Option<f64>,
    #[serde(default)]
    fsrs_difficulty: Option<f64>,
    #[serde(default = "default_fsrs_version")]
    fsrs_version: i64,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

impl From<VocabCsvRow> for VocabBackupWord {
    fn from(row: VocabCsvRow) -> Self {
        Self {
            id: row.id,
            book_id: row.book_id,
            word: row.word,
            definition: row.definition,
            context_sentence: row.context_sentence.filter(|value| !value.is_empty()),
            context_explanation: row.context_explanation.filter(|value| !value.is_empty()),
            cfi: row.cfi.filter(|value| !value.is_empty()),
            mastery: row.mastery,
            mastery_source: row.mastery_source,
            mastery_reason: row.mastery_reason.filter(|value| !value.is_empty()),
            review_count: row.review_count,
            next_review_at: row.next_review_at,
            review_interval_days: row.review_interval_days,
            last_reviewed_at: row.last_reviewed_at,
            last_review_rating: row.last_review_rating.filter(|value| !value.is_empty()),
            fsrs_stability: row.fsrs_stability,
            fsrs_difficulty: row.fsrs_difficulty,
            fsrs_version: row.fsrs_version,
            created_at: row.created_at,
            updated_at: row.updated_at,
            // CSV never carries this column (see `VOCAB_BACKUP_CSV_HEADERS`
            // on the frontend) — every CSV-imported word is treated as one
            // the reader consciously saved.
            list_status: default_list_status(),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VocabReviewRating {
    Again,
    Hard,
    Good,
    Easy,
}

impl VocabReviewRating {
    fn as_str(self) -> &'static str {
        match self {
            Self::Again => "again",
            Self::Hard => "hard",
            Self::Good => "good",
            Self::Easy => "easy",
        }
    }
}

/// The outcome of one FSRS scheduling call.
///
/// A struct rather than the tuple this used to return, because
/// `vocab_review_log` needs two values the caller cannot recover on its own:
/// the elapsed interval the scheduler actually measured, and the state the
/// card was in on the way in. Both are decided by the card-construction rules
/// below, so recomputing them at the call site would mean keeping a second
/// copy of those rules in step with this one.
/// What a single review answer is allowed to do to a word's mastery tier.
///
/// A review is evidence, not a fresh judgement: it can only push the tier in
/// the direction the answer supports. A pass is evidence of knowing the
/// word — but only a long-enough interval is *strong* evidence, strong
/// enough to promote. A fail is always evidence of not knowing it. Anything
/// weaker than that (a pass with a short interval) is not evidence either
/// way, so it must leave the tier untouched rather than default to a guess.
/// `Keep` exists so that "leave it alone" can never be confused with a
/// concrete tier value the way an `Option<&str>` that also carries "new
/// value" would.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MasteryOutcome {
    /// The card's interval reached the mastery threshold: raise the tier to
    /// `"mastered"`.
    Promote,
    /// The reader failed to recall the word (`Again`): drop the tier to
    /// `"learning"`.
    Demote,
    /// Neither of the above: do not touch `mastery`, `mastery_source`, or
    /// `mastery_reason` — whatever set them stands.
    Keep,
}

#[derive(Debug, Clone)]
struct ScheduledReview {
    mastery_outcome: MasteryOutcome,
    review_interval_days: i64,
    next_review_at: i64,
    stability: f64,
    difficulty: f64,
    /// Whole days between the previous review and this one — zero on a first
    /// review, which has no earlier review to measure from.
    elapsed_days: i64,
    /// The FSRS state the card held before this call, or `None` for a card
    /// that had never been scheduled. `None` is the honest answer there: a
    /// never-scheduled card has no prior state, and writing `"new"` would let
    /// an optimizer mistake "no history" for "observed as new".
    state_before: Option<&'static str>,
}

fn schedule_review(
    rating: VocabReviewRating,
    stability: Option<f64>,
    difficulty: Option<f64>,
    last_reviewed_at: Option<i64>,
    now: i64,
) -> AppResult<ScheduledReview> {
    let now_dt = Utc
        .timestamp_millis_opt(now)
        .single()
        .ok_or_else(|| crate::error::AppError::Other("FSRS_TIME_INVALID".to_string()))?;
    let last_review = last_reviewed_at
        .and_then(|value| Utc.timestamp_millis_opt(value).single())
        .unwrap_or(now_dt);
    let elapsed_days = now_dt.signed_duration_since(last_review).num_days().max(0);
    // A card is "seen before" only when both numbers are present. Passing
    // `None` is not the same as passing zeros: `next_states` treats `None` as
    // the very first review and takes a different branch for it.
    let memory_before = match (stability, difficulty) {
        (Some(stability), Some(difficulty)) => Some(MemoryState {
            stability: stability as f32,
            difficulty: difficulty as f32,
        }),
        _ => None,
    };
    let scheduler = FSRS::new(&DEFAULT_PARAMETERS)
        .map_err(|err| crate::error::AppError::Other(format!("FSRS_INIT_FAILED: {err}")))?;
    let next = scheduler
        .next_states(
            memory_before,
            DESIRED_RETENTION,
            elapsed_days.clamp(0, u32::MAX as i64) as u32,
        )
        .map_err(|err| crate::error::AppError::Other(format!("FSRS_SCHEDULE_FAILED: {err}")))?;
    let chosen = match rating {
        VocabReviewRating::Again => next.again,
        VocabReviewRating::Hard => next.hard,
        VocabReviewRating::Good => next.good,
        VocabReviewRating::Easy => next.easy,
    };
    // The upstream scheduler returns a fractional interval in days and no due
    // date, so both the rounding and the clock arithmetic are ours.
    let interval = (chosen.interval.round() as i64).clamp(0, 36_500);
    // A sub-day interval rounds to zero, and `now + 0` would make the card due
    // in the past the instant it is written — the queue would hand it straight
    // back. `rs-fsrs` hid this behind its learning steps; the official crate
    // models long-term scheduling only, so the same-day step is ours to supply.
    let next_review_at = if interval == 0 {
        now.saturating_add(RELEARN_STEP_MS)
    } else {
        now.saturating_add(interval.saturating_mul(DAY_MS))
    };
    // A review is only allowed to move the tier in the direction the answer
    // is evidence for: failing a card (`Again`) is real evidence of not
    // knowing the word and demotes it; a long enough interval on any other
    // rating is evidence of knowing it and promotes it. Everything in
    // between is not evidence either way, so the tier — and whatever
    // `mastery_source`/`mastery_reason` currently say about how it got
    // there, e.g. the reading-exposure engine's explanation — must be left
    // exactly as it was. See `MasteryOutcome`.
    let mastery_outcome = if matches!(rating, VocabReviewRating::Again) {
        MasteryOutcome::Demote
    } else if interval >= 21 {
        MasteryOutcome::Promote
    } else {
        MasteryOutcome::Keep
    };
    Ok(ScheduledReview {
        mastery_outcome,
        review_interval_days: interval,
        next_review_at,
        stability: f64::from(chosen.memory.stability),
        difficulty: f64::from(chosen.memory.difficulty),
        elapsed_days,
        state_before: memory_before.map(|_| "review"),
    })
}

/// The state a review or a status change leaves behind, ready to be copied
/// onto the sibling rows of the same word.
#[derive(Debug, Clone)]
struct VocabProgress {
    mastery: String,
    next_review_at: Option<i64>,
    review_count: i64,
    review_interval_days: i64,
    last_reviewed_at: Option<i64>,
    last_review_rating: Option<String>,
    fsrs_stability: Option<f64>,
    fsrs_difficulty: Option<f64>,
    fsrs_version: i64,
    /// Who decided the tier: `auto` for the reading-exposure engine, `manual`
    /// for the reader, `review` for an SRS answer. Carried alongside
    /// `mastery` rather than left behind, because a sibling row or a second
    /// device showing the right tier under a stale "decided automatically"
    /// mark is worse than showing nothing — it keeps asserting a reason the
    /// reader has already overruled.
    mastery_source: String,
    /// The automatic explanation's raw JSON, or `None` once something other
    /// than the exposure engine decided the tier.
    mastery_reason: Option<String>,
}

/// Mastery and review progress belong to the word, not to the row: the same
/// word saved from three books is one entry to the reader, with one schedule.
/// Rather than change the schema, the row that was just updated writes its
/// resulting state through to every other row spelling the same word. Only
/// user-initiated paths call this — sync replay lands in `sync::merge`, which
/// applies events directly, so a propagated event cannot bounce back here.
fn propagate_progress_to_siblings(
    tx: &rusqlite::Transaction,
    events: &mut Vec<EventBody>,
    id: &str,
    word: &str,
    progress: &VocabProgress,
    now: i64,
    device: &str,
) -> AppResult<()> {
    let siblings: Vec<String> = {
        let mut stmt =
            tx.prepare("SELECT id FROM vocab_words WHERE word = ?1 COLLATE NOCASE AND id <> ?2")?;
        let ids = stmt
            .query_map(params![word, id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };
    for sibling in siblings {
        tx.execute(
            "UPDATE vocab_words
             SET mastery = ?1, next_review_at = ?2, review_count = ?3,
                 review_interval_days = ?4, last_reviewed_at = ?5, last_review_rating = ?6,
                 fsrs_stability = ?7, fsrs_difficulty = ?8, fsrs_version = ?9,
                 mastery_source = ?10, mastery_reason = ?11,
                 updated_at = ?12, updated_by_device = ?13
             WHERE id = ?14",
            params![
                progress.mastery,
                progress.next_review_at,
                progress.review_count,
                progress.review_interval_days,
                progress.last_reviewed_at,
                progress.last_review_rating,
                progress.fsrs_stability,
                progress.fsrs_difficulty,
                progress.fsrs_version,
                progress.mastery_source,
                progress.mastery_reason,
                now,
                device,
                sibling,
            ],
        )?;
        events.push(EventBody::VocabMasterySet {
            id: sibling,
            mastery: progress.mastery.clone(),
            next_review_at: progress.next_review_at,
            review_count: progress.review_count,
            review_interval_days: progress.review_interval_days,
            last_reviewed_at: progress.last_reviewed_at,
            last_review_rating: progress.last_review_rating.clone(),
            fsrs_stability: progress.fsrs_stability,
            fsrs_difficulty: progress.fsrs_difficulty,
            fsrs_version: progress.fsrs_version,
            mastery_source: progress.mastery_source.clone(),
            mastery_reason: progress.mastery_reason.clone(),
        });
    }
    Ok(())
}

/// Write a tier the reading-exposure engine decided, with its explanation.
///
/// The engine lives in `crate::mastery::store` and decides *what* the tier
/// should be; this decides how a tier gets written down, which is the same
/// three things every other path here does — update the row, append a
/// timeline event, and carry the result to every sibling row spelling the
/// same word — plus the two columns that make an automatic decision
/// answerable: `mastery_source = 'auto'` and the `detail` JSON the
/// word-detail page builds its one sentence from.
///
/// `next_review_at` and the whole FSRS block are read and written back
/// untouched. Reading a word in a book is not an answer to a review card, so
/// it must not move the review schedule; but `propagate_progress_to_siblings`
/// copies the whole progress struct, so the current values have to travel
/// with it or the siblings would be reset to nothing.
#[allow(clippy::too_many_arguments)]
pub(crate) fn set_auto_mastery(
    tx: &rusqlite::Transaction,
    events: &mut Vec<EventBody>,
    id: &str,
    previous_mastery: &str,
    mastery: &str,
    reason: &str,
    detail: &str,
    now: i64,
    device: &str,
) -> AppResult<()> {
    validate_mastery(mastery)?;
    let (word, review, next_review_at) = tx.query_row(
        "SELECT word, review_count, review_interval_days, last_reviewed_at,
                last_review_rating, fsrs_stability, fsrs_difficulty, fsrs_version,
                next_review_at
           FROM vocab_words WHERE id = ?1",
        params![id],
        |row| {
            Ok((
                row.get::<_, String>("word")?,
                row_to_review_state(row)?,
                row.get::<_, Option<i64>>("next_review_at")?,
            ))
        },
    )?;

    tx.execute(
        "UPDATE vocab_words
         SET mastery = ?1, mastery_source = 'auto', mastery_reason = ?2,
             updated_at = ?3, updated_by_device = ?4
         WHERE id = ?5",
        params![mastery, detail, now, device, id],
    )?;
    record_mastery_event(
        tx,
        id,
        previous_mastery,
        mastery,
        "auto",
        reason,
        detail,
        now,
    )?;

    let progress = VocabProgress {
        mastery: mastery.to_string(),
        next_review_at,
        review_count: review.review_count,
        review_interval_days: review.review_interval_days,
        last_reviewed_at: review.last_reviewed_at,
        last_review_rating: review.last_review_rating,
        fsrs_stability: review.fsrs_stability,
        fsrs_difficulty: review.fsrs_difficulty,
        fsrs_version: review.fsrs_version,
        mastery_source: "auto".to_string(),
        mastery_reason: Some(detail.to_string()),
    };
    events.push(EventBody::VocabMasterySet {
        id: id.to_string(),
        mastery: progress.mastery.clone(),
        next_review_at: progress.next_review_at,
        review_count: progress.review_count,
        review_interval_days: progress.review_interval_days,
        last_reviewed_at: progress.last_reviewed_at,
        last_review_rating: progress.last_review_rating.clone(),
        fsrs_stability: progress.fsrs_stability,
        fsrs_difficulty: progress.fsrs_difficulty,
        fsrs_version: progress.fsrs_version,
        mastery_source: progress.mastery_source.clone(),
        mastery_reason: progress.mastery_reason.clone(),
    });
    propagate_progress_to_siblings(tx, events, id, &word, &progress, now, device)
}

fn validate_mastery(mastery: &str) -> AppResult<()> {
    if matches!(mastery, "new" | "learning" | "familiar" | "mastered") {
        Ok(())
    } else {
        Err(crate::error::AppError::Other(
            "VOCAB_MASTERY_INVALID".to_string(),
        ))
    }
}

/// Rewrite one saved word's `definition` and publish the change.
///
/// The single write both definition rewriters go through —
/// `vocab_regloss::regenerate_vocab_definition` (the reader's button) and
/// `vocab_gloss_backfill` (the automatic repair) — so the two cannot drift,
/// and so the rule a receiving device replays in
/// `sync::merge::apply_vocab_definition` is literally the same code.
///
/// Returns `false` when the row is gone, which is the only way this writes
/// nothing.
///
/// **The LWW clock moves.** Both writers used to leave `updated_at` and
/// `updated_by_device` alone, on the stated grounds that the clock governs
/// the columns that sync and `definition` was not one of them. That premise
/// is what changed: `definition` now travels on `vocab.definition.set` and is
/// carried by snapshots, so a device that publishes a new one and did not
/// stamp the row would be advertising a change its own clock says never
/// happened — a peer's older snapshot would beat it and hand the stale text
/// straight back. The cost is the ordinary cost of one clock per row: a
/// definition change made here and a mastery change made elsewhere inside the
/// same sync window are ordered against each other, and the older one loses.
/// That is the same trade `vocab.list_status.set` already makes against the
/// same clock, and the alternative — a second clock for one column — is a
/// migration plus a parallel convention in every merge and snapshot path.
pub(crate) fn set_definition(
    db: &Db,
    sync: &SyncWriter,
    id: &str,
    definition: &str,
    now: i64,
) -> AppResult<bool> {
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        let Some((current, explanation)) = tx
            .query_row(
                "SELECT definition, context_explanation FROM vocab_words WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
        else {
            return Ok(false);
        };
        // Read inside the transaction that writes, so "is the explanation
        // column empty" is decided by the row the write lands on rather than
        // by a value read before the AI call.
        let displaced = crate::commands::vocab_gloss_backfill::displaced_explanation(
            &current,
            explanation.as_deref(),
        );
        tx.execute(
            "UPDATE vocab_words
             SET definition = ?1,
                 context_explanation = COALESCE(?2, context_explanation),
                 updated_at = ?3,
                 updated_by_device = ?4
             WHERE id = ?5",
            params![definition, displaced, now, device, id],
        )?;
        events.push(EventBody::VocabDefinitionSet {
            id: id.to_string(),
            definition: definition.to_string(),
        });
        Ok(true)
    })
}

/// Cap on the serialised `card_snapshot` JSON. Kept in bytes (not chars) so a
/// multi-byte-heavy card can't sneak past a character-count guard. Anything
/// larger is stored as `NULL` rather than truncated — a partial JSON blob
/// would not deserialise back into a `LearningCardResult` at read time, so
/// there is no useful "shorter but still valid" form to keep.
const MAX_CARD_SNAPSHOT_BYTES: usize = 64 * 1024;

fn clamp_card_snapshot(card_snapshot: Option<String>) -> Option<String> {
    card_snapshot.filter(|value| value.len() <= MAX_CARD_SNAPSHOT_BYTES)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_vocab_word(
    book_id: String,
    word: String,
    definition: String,
    context_sentence: Option<String>,
    context_explanation: Option<String>,
    cfi: Option<String>,
    card_snapshot: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<VocabWord> {
    add_vocab_word_inner(
        &book_id,
        &word,
        &definition,
        context_sentence,
        context_explanation,
        cfi,
        card_snapshot,
        &db,
        &sync,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn add_vocab_word_inner(
    book_id: &str,
    word: &str,
    definition: &str,
    context_sentence: Option<String>,
    context_explanation: Option<String>,
    cfi: Option<String>,
    card_snapshot: Option<String>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<VocabWord> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    let card_snapshot = clamp_card_snapshot(card_snapshot);

    log::debug!("vocab: add_vocab_word book_id={book_id} word={word:?}");

    // Dedup happens inside the sync transaction so two concurrent adds
    // can't both observe "missing" and insert duplicates. There's no
    // unique index on (book_id, word) — the conn mutex serializes the
    // whole tx, so the second writer's check sees the first writer's
    // committed row.
    let vocab = sync.with_tx(db, now, |tx, events| {
        let existing: Option<VocabWord> = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {} FROM vocab_words WHERE book_id = ?1 AND word = ?2 COLLATE NOCASE LIMIT 1",
                SELECT_COLS
            ))?;
            let row = stmt
                .query_map(params![book_id, word], row_to_vocab)?
                .next()
                .transpose()?;
            row
        };
        if let Some(existing) = existing {
            if existing.list_status == "watchlist" {
                // The reader hit "收藏" (save) on a word that was already
                // sitting in the observation zone from an earlier lookup —
                // that's an explicit save, so it promotes immediately
                // regardless of lookup count. Source stays whatever it was
                // (this path never touches mastery_source/reason). A
                // non-null incoming snapshot replaces the stored one; a null
                // incoming snapshot leaves whatever was already saved alone
                // (COALESCE), same rule `set_definition` uses for
                // `context_explanation`.
                tx.execute(
                    "UPDATE vocab_words SET list_status = 'confirmed', card_snapshot = COALESCE(?1, card_snapshot), updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                    params![card_snapshot, now, device, existing.id],
                )?;
                events.push(EventBody::VocabListStatusSet {
                    id: existing.id.clone(),
                    list_status: "confirmed".to_string(),
                    card_snapshot: card_snapshot.clone(),
                });
                return Ok(VocabWord {
                    list_status: "confirmed".to_string(),
                    updated_at: now,
                    ..existing
                });
            }
            // Existing match → no SQL write, no event published. The
            // closure still returns the row so the frontend gets the
            // canonical record.
            return Ok(existing);
        }

        tx.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, context_sentence, context_explanation, cfi, card_snapshot, mastery, review_count, next_review_at, list_status, created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'new', 0, NULL, 'confirmed', ?9, ?9, ?10)",
            params![id, book_id, word, definition, context_sentence, context_explanation, cfi, card_snapshot, now, device],
        )?;
        events.push(EventBody::VocabAdd(VocabPayload {
            id: id.clone(),
            book_id: book_id.to_string(),
            word: word.to_string(),
            definition: definition.to_string(),
            context_sentence: context_sentence.clone(),
            context_explanation: context_explanation.clone(),
            cfi: cfi.clone(),
            mastery: "new".to_string(),
            mastery_source: "manual".to_string(),
            mastery_reason: None,
            list_status: "confirmed".to_string(),
            card_snapshot: card_snapshot.clone(),
            review_count: 0,
            next_review_at: None,
            review_interval_days: 0,
            last_reviewed_at: None,
            last_review_rating: None,
            fsrs_stability: None,
            fsrs_difficulty: None,
            fsrs_version: 1,
            created_at: Some(now),
        }));
        Ok(VocabWord {
            id: id.clone(),
            book_id: book_id.to_string(),
            word: word.to_string(),
            definition: definition.to_string(),
            context_sentence: context_sentence.clone(),
            context_explanation: context_explanation.clone(),
            cfi: cfi.clone(),
            mastery: "new".to_string(),
            mastery_source: "manual".to_string(),
            mastery_reason: None,
            list_status: "confirmed".to_string(),
            review_count: 0,
            next_review_at: None,
            review_interval_days: 0,
            last_reviewed_at: None,
            last_review_rating: None,
            fsrs_stability: None,
            fsrs_difficulty: None,
            fsrs_version: 1,
            created_at: now,
            updated_at: now,
            book_title: None,
            chapter: None,
        })
    })?;

    Ok(vocab)
}

/// The single reader of `card_snapshot`. Deliberately its own command rather
/// than a field on `VocabWord`: that struct is what list queries hand back
/// (`SELECT_COLS`, on purpose, never includes this column — see migration
/// 067), so folding the snapshot into it would either bloat every list fetch
/// or leave the field silently `None` on rows that do have one. Nothing
/// calls this yet; it exists for a future vocabulary detail surface.
#[tauri::command]
pub fn get_vocab_card_snapshot(word_id: String, db: State<'_, Db>) -> AppResult<Option<String>> {
    get_vocab_card_snapshot_inner(&word_id, &db)
}

pub(crate) fn get_vocab_card_snapshot_inner(word_id: &str, db: &Db) -> AppResult<Option<String>> {
    let snapshot = db
        .reader()
        .query_row(
            "SELECT card_snapshot FROM vocab_words WHERE id = ?1",
            params![word_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(snapshot)
}

/// Runs on every lookup, inside `save_lookup_record_inner`'s transaction,
/// before `mastery::store::apply_lookup_to_word` — that function only scores
/// a word that already has a `vocab_words` row, so the first lookup has to
/// create one here first. See docs/impls/reading-flow-decisions-2026-08-06.md
/// §1 and §5.
///
/// A brand-new word is inserted straight into the observation zone
/// (`list_status = 'watchlist'`) rather than the formal list: the reader
/// asked what it means, not to save it. From there this same function
/// promotes it to `'confirmed'` the moment the cumulative lookup count for
/// this exact word in this exact book — summed across every position it's
/// been looked up at, the identical aggregation
/// `review_piles::repeat_lookups_piles` uses, never a single row's count —
/// reaches 3. A word already `'confirmed'` (saved manually, or promoted on
/// an earlier lookup) is left alone; this function has nothing further to do
/// for it.
#[allow(clippy::too_many_arguments)]
pub(crate) fn observe_lookup_for_vocab(
    tx: &rusqlite::Transaction,
    events: &mut Vec<EventBody>,
    book_id: &str,
    word: &str,
    normalized_text: &str,
    definition: &str,
    context_sentence: Option<&str>,
    context_explanation: Option<&str>,
    cfi: Option<&str>,
    now: i64,
    device: &str,
) -> AppResult<()> {
    let existing: Option<(String, String, String)> = tx
        .query_row(
            "SELECT id, list_status, mastery FROM vocab_words WHERE book_id = ?1 AND word = ?2 COLLATE NOCASE LIMIT 1",
            params![book_id, word],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;

    let (vocab_id, mastery) = match existing {
        Some((_, list_status, _)) if list_status == "confirmed" => return Ok(()),
        Some((id, _watchlist, mastery)) => (id, mastery),
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO vocab_words (id, book_id, word, definition, context_sentence, context_explanation, cfi, mastery, review_count, next_review_at, list_status, created_at, updated_at, updated_by_device)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'new', 0, NULL, 'watchlist', ?8, ?8, ?9)",
                params![id, book_id, word, definition, context_sentence, context_explanation, cfi, now, device],
            )?;
            events.push(EventBody::VocabAdd(VocabPayload {
                id: id.clone(),
                book_id: book_id.to_string(),
                word: word.to_string(),
                definition: definition.to_string(),
                context_sentence: context_sentence.map(str::to_string),
                context_explanation: context_explanation.map(str::to_string),
                cfi: cfi.map(str::to_string),
                mastery: "new".to_string(),
                mastery_source: "manual".to_string(),
                mastery_reason: None,
                list_status: "watchlist".to_string(),
                card_snapshot: None,
                review_count: 0,
                next_review_at: None,
                review_interval_days: 0,
                last_reviewed_at: None,
                last_review_rating: None,
                fsrs_stability: None,
                fsrs_difficulty: None,
                fsrs_version: 1,
                created_at: Some(now),
            }));
            (id, "new".to_string())
        }
    };

    // Same aggregation `review_piles::repeat_lookups_piles` uses: cumulative
    // lookups of this word in this book, summed across every position —
    // never a single row's `lookup_count`.
    let total_lookups: i64 = tx.query_row(
        "SELECT COALESCE(SUM(lookup_count), 0) FROM lookup_records WHERE book_id = ?1 AND normalized_text = ?2",
        params![book_id, normalized_text],
        |row| row.get(0),
    )?;
    if total_lookups < 3 {
        return Ok(());
    }

    tx.execute(
        "UPDATE vocab_words SET list_status = 'confirmed', updated_at = ?1, updated_by_device = ?2 WHERE id = ?3",
        params![now, device, vocab_id],
    )?;
    events.push(EventBody::VocabListStatusSet {
        id: vocab_id.clone(),
        list_status: "confirmed".to_string(),
        card_snapshot: None,
    });

    let book_title = tx
        .query_row(
            "SELECT title FROM books WHERE id = ?1",
            params![book_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .filter(|title| !title.trim().is_empty());
    let mut detail = serde_json::Map::new();
    detail.insert(
        "reason".to_string(),
        "watchlist_promoted".to_string().into(),
    );
    if let Some(title) = book_title {
        detail.insert("book_title".to_string(), title.into());
    }
    detail.insert("lookup_count".to_string(), total_lookups.into());
    record_mastery_event(
        tx,
        &vocab_id,
        &mastery,
        &mastery,
        "auto",
        "watchlist_promoted",
        &serde_json::Value::Object(detail).to_string(),
        now,
    )?;
    Ok(())
}

#[tauri::command]
pub fn remove_vocab_word(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    sync.with_tx(&db, now, |tx, events| {
        tx.execute("DELETE FROM vocab_words WHERE id = ?1", params![id])?;
        events.push(EventBody::VocabDelete { id: id.clone() });
        Ok(())
    })
}

// `query_vocab_words_including_watchlist` returns every row regardless of
// `list_status`. It exists for exactly one reason: the in-text three-stage
// annotation path (`useFoliateAnnotations.ts`, via the `list_vocab_words`
// command) needs a watchlist word to still get its in-text mark. Every other
// caller should reach for `query_vocab_words` below instead — it already
// excludes the observation zone, so a caller that has never heard of
// `list_status` gets the safe, reader-facing behavior by default rather
// than having to remember to filter.
pub(crate) fn query_vocab_words_including_watchlist(
    db: &Db,
    book_id: &str,
) -> AppResult<Vec<VocabWord>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM vocab_words WHERE book_id = ?1 ORDER BY created_at DESC",
        SELECT_COLS
    ))?;
    let words = stmt
        .query_map(params![book_id], row_to_vocab)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

/// The default, reader-facing entry point: excludes the observation zone
/// (`list_status = 'watchlist'`, migration 044) the same way every other
/// reader-facing surface does. Call
/// `query_vocab_words_including_watchlist` instead only when the caller
/// genuinely needs every row — currently just the in-text annotation path.
pub(crate) fn query_vocab_words(db: &Db, book_id: &str) -> AppResult<Vec<VocabWord>> {
    Ok(query_vocab_words_including_watchlist(db, book_id)?
        .into_iter()
        .filter(|word| word.list_status == "confirmed")
        .collect())
}

#[tauri::command]
pub fn list_vocab_words(book_id: String, db: State<'_, Db>) -> AppResult<Vec<VocabWord>> {
    // Unfiltered on purpose: this command also backs in-text annotation,
    // which must see watchlist words. See
    // `query_vocab_words_including_watchlist`. Reader-facing frontend
    // callers (`useDictionary.ts`, `ReaderExportDialog.tsx`) filter
    // `list_status === "confirmed"` client-side after this same call.
    query_vocab_words_including_watchlist(&db, &book_id)
}

#[tauri::command]
pub fn check_vocab_exists(
    book_id: String,
    word: String,
    db: State<'_, Db>,
) -> AppResult<Option<String>> {
    check_vocab_exists_inner(&db, &book_id, &word)
}

pub(crate) fn check_vocab_exists_inner(
    db: &Db,
    book_id: &str,
    word: &str,
) -> AppResult<Option<String>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        // 'watchlist' rows are invisible to the reader, so a word sitting
        // there must still show up as "not yet collected" — otherwise the
        // collect button would silently no-op on a word the reader has
        // never consciously saved.
        "SELECT id FROM vocab_words WHERE book_id = ?1 AND word = ?2 COLLATE NOCASE AND list_status = 'confirmed' LIMIT 1",
    )?;
    let id: Option<String> = stmt
        .query_map(params![book_id, word], |row| row.get(0))?
        .next()
        .transpose()?;
    Ok(id)
}

/// Library-wide vocabulary, with the observation zone
/// (`list_status = 'watchlist'`, migration 044) excluded in SQL. There is no
/// unfiltered library-wide twin on purpose: every caller here — the library
/// dictionary, review piles, backup export, the MCP tools — is reader-facing,
/// and only the per-book path has a real need for the raw rows. That one asks
/// for them by name (`query_vocab_words_including_watchlist`).
pub(crate) fn query_all_vocab_words(db: &Db) -> AppResult<Vec<VocabWord>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        // The chapter is not stored on the word: vocabulary rows predate the
        // lookup history table. Recovering it from the lookup that produced
        // the word gives contextual review the "which chapter was this" line
        // without a migration, and simply yields NULL when nothing matches.
        // Same-position lookups win over merely same-word ones.
        "SELECT v.id, v.book_id, v.word, v.definition, v.context_sentence, v.cfi, v.mastery, v.review_count, v.next_review_at, v.created_at, v.updated_at, v.context_explanation, v.review_interval_days, v.last_reviewed_at, v.last_review_rating, v.fsrs_stability, v.fsrs_difficulty, v.fsrs_version, v.mastery_source, v.mastery_reason, v.list_status, b.title AS book_title, \
         COALESCE( \
           (SELECT l.chapter FROM lookup_records l \
             WHERE l.book_id = v.book_id AND l.cfi = v.cfi AND l.normalized_text = lower(trim(v.word)) \
               AND trim(COALESCE(l.chapter, '')) <> '' LIMIT 1), \
           (SELECT l.chapter FROM lookup_records l \
             WHERE l.book_id = v.book_id AND l.normalized_text = lower(trim(v.word)) \
               AND trim(COALESCE(l.chapter, '')) <> '' \
             ORDER BY l.last_looked_up_at DESC LIMIT 1)) AS chapter \
         FROM vocab_words v LEFT JOIN books b ON v.book_id = b.id \
         WHERE v.list_status = 'confirmed' ORDER BY v.created_at DESC"
    )?;
    let words = stmt
        .query_map([], row_to_vocab_with_book)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

#[tauri::command]
pub fn list_all_vocab_words(db: State<'_, Db>) -> AppResult<Vec<VocabWord>> {
    query_all_vocab_words(&db)
}

#[tauri::command]
pub fn record_vocab_review(
    id: String,
    rating: VocabReviewRating,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<VocabWord> {
    record_vocab_review_inner(&id, rating, &db, &sync)
}

pub(crate) fn record_vocab_review_inner(
    id: &str,
    rating: VocabReviewRating,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<VocabWord> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        let current = tx
            .query_row(
                &format!("SELECT {SELECT_COLS} FROM vocab_words WHERE id = ?1"),
                params![id],
                row_to_vocab,
            )
            .map_err(|_| crate::error::AppError::Other("VOCAB_WORD_NOT_FOUND".to_string()))?;
        // Read off the "before" side of the transition while it is still
        // true. The UPDATE below overwrites `fsrs_stability` /
        // `fsrs_difficulty` in place, so after it runs the numbers this
        // review was scheduled *from* no longer exist anywhere.
        let stability_before = current.fsrs_stability;
        let difficulty_before = current.fsrs_difficulty;
        let scheduled = schedule_review(
            rating,
            stability_before,
            difficulty_before,
            current.last_reviewed_at,
            now,
        )?;
        let ScheduledReview {
            mastery_outcome,
            review_interval_days,
            next_review_at,
            stability,
            difficulty,
            elapsed_days,
            state_before,
        } = scheduled;
        let review_count = current.review_count.saturating_add(1);
        // A review may only promote or demote the tier (see `MasteryOutcome`);
        // `Keep` must leave `mastery`, `mastery_source`, and `mastery_reason`
        // exactly as they were, including a reading-exposure explanation
        // this review is not strong enough evidence to overrule. That is two
        // UPDATE shapes, not one UPDATE that writes the old value back — the
        // FSRS columns below still change on every review, and writing back
        // a value that was merely read a moment earlier would clobber a
        // concurrent writer's change to those three columns with a stale
        // read of them.
        let new_mastery: Option<&'static str> = match mastery_outcome {
            MasteryOutcome::Promote => Some("mastered"),
            MasteryOutcome::Demote => Some("learning"),
            MasteryOutcome::Keep => None,
        };
        if let Some(mastery) = new_mastery {
            // An actual promotion or demotion outranks whatever the exposure
            // scorer had guessed, so the automatic sentence is cleared rather
            // than left to contradict the tier the reader just earned.
            tx.execute(
                "UPDATE vocab_words
                 SET mastery = ?1, review_count = ?2, next_review_at = ?3,
                     review_interval_days = ?4, last_reviewed_at = ?5, last_review_rating = ?6,
                     fsrs_stability = ?7, fsrs_difficulty = ?8, fsrs_version = 1,
                     mastery_source = 'manual', mastery_reason = NULL,
                     updated_at = ?5, updated_by_device = ?9
                 WHERE id = ?10",
                params![
                    mastery,
                    review_count,
                    next_review_at,
                    review_interval_days,
                    now,
                    rating.as_str(),
                    stability,
                    difficulty,
                    device,
                    id,
                ],
            )?;
        } else {
            // Keep: the tier columns are simply absent from this statement,
            // not re-written with the value `current` held before the FSRS
            // columns changed.
            tx.execute(
                "UPDATE vocab_words
                 SET review_count = ?1, next_review_at = ?2,
                     review_interval_days = ?3, last_reviewed_at = ?4, last_review_rating = ?5,
                     fsrs_stability = ?6, fsrs_difficulty = ?7, fsrs_version = 1,
                     updated_at = ?4, updated_by_device = ?8
                 WHERE id = ?9",
                params![
                    review_count,
                    next_review_at,
                    review_interval_days,
                    now,
                    rating.as_str(),
                    stability,
                    difficulty,
                    device,
                    id,
                ],
            )?;
        }
        let mastery = new_mastery
            .map(str::to_string)
            .unwrap_or_else(|| current.mastery.clone());
        let mastery_source = if new_mastery.is_some() {
            "manual".to_string()
        } else {
            current.mastery_source.clone()
        };
        let mastery_reason = if new_mastery.is_some() {
            None
        } else {
            current.mastery_reason.clone()
        };
        // The timeline (and the statistics page's counts drawn from it) must
        // only see a row when the tier actually moved — a Promote/Demote
        // outcome whose resulting value happens to match what was already
        // stored (e.g. an already-`mastered` word promoted again) is not a
        // transition.
        if new_mastery.is_some() && mastery != current.mastery {
            let reason = if mastery_outcome == MasteryOutcome::Promote {
                "review_promotion"
            } else {
                "review_demotion"
            };
            record_mastery_event(tx, id, &current.mastery, &mastery, "review", reason, "{}", now)?;
        }
        let progress = VocabProgress {
            mastery,
            next_review_at: Some(next_review_at),
            review_count,
            review_interval_days,
            last_reviewed_at: Some(now),
            last_review_rating: Some(rating.as_str().to_string()),
            fsrs_stability: Some(stability),
            fsrs_difficulty: Some(difficulty),
            fsrs_version: 1,
            mastery_source,
            mastery_reason,
        };
        events.push(EventBody::VocabMasterySet {
            id: id.to_string(),
            mastery: progress.mastery.clone(),
            next_review_at: progress.next_review_at,
            review_count: progress.review_count,
            review_interval_days: progress.review_interval_days,
            last_reviewed_at: progress.last_reviewed_at,
            last_review_rating: progress.last_review_rating.clone(),
            fsrs_stability: progress.fsrs_stability,
            fsrs_difficulty: progress.fsrs_difficulty,
            fsrs_version: progress.fsrs_version,
            mastery_source: progress.mastery_source.clone(),
            mastery_reason: progress.mastery_reason.clone(),
        });
        // The review itself, appended rather than overwritten. Deliberately
        // outside `propagate_progress_to_siblings`: the *schedule* belongs to
        // the word and is copied to every row spelling it, but the review
        // happened once, to one card. Logging it per sibling row would make a
        // word saved from three books look like three reviews and skew any
        // optimizer trained on this log.
        let log_id = uuid::Uuid::new_v4().to_string();
        let review_log = VocabReviewLogPayload {
            id: log_id,
            vocab_word_id: id.to_string(),
            reviewed_at: now,
            rating: rating.as_str().to_string(),
            state_before: state_before.map(str::to_string),
            stability_before,
            difficulty_before,
            elapsed_days: Some(elapsed_days),
            scheduled_days: Some(review_interval_days),
            fsrs_version: Some(progress.fsrs_version),
        };
        tx.execute(
            "INSERT INTO vocab_review_log
             (id, vocab_word_id, reviewed_at, rating, state_before, stability_before,
              difficulty_before, elapsed_days, scheduled_days, fsrs_version,
              created_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                review_log.id,
                review_log.vocab_word_id,
                review_log.reviewed_at,
                review_log.rating,
                review_log.state_before,
                review_log.stability_before,
                review_log.difficulty_before,
                review_log.elapsed_days,
                review_log.scheduled_days,
                review_log.fsrs_version,
                now,
                device,
            ],
        )?;
        events.push(EventBody::VocabReviewAppend(review_log));
        propagate_progress_to_siblings(tx, events, id, &current.word, &progress, now, &device)?;
        tx.query_row(
            &format!("SELECT {SELECT_COLS} FROM vocab_words WHERE id = ?1"),
            params![id],
            row_to_vocab,
        )
        .map_err(Into::into)
    })
}

#[tauri::command]
pub fn update_vocab_mastery(
    id: String,
    mastery: String,
    next_review_at: Option<i64>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    update_vocab_mastery_inner(&id, &mastery, next_review_at, &db, &sync)
}

pub(crate) fn update_vocab_mastery_inner(
    id: &str,
    mastery: &str,
    next_review_at: Option<i64>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    validate_mastery(mastery)?;
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        // Read the tier first: once the UPDATE lands, the value this
        // transition came *from* is gone, and the timeline needs both ends.
        let previous_mastery = tx
            .query_row(
                "SELECT mastery FROM vocab_words WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| crate::error::AppError::Other("VOCAB_WORD_NOT_FOUND".to_string()))?;
        // This is the manual path — the "我其实不认识" button ends up here.
        // Stamping `mastery_source = 'manual'` and clearing `mastery_reason`
        // is what makes the override stick: leaving the automatic mark and
        // its one-sentence explanation behind would have the app go on
        // asserting a judgement the reader has just overruled, and because
        // both columns sync, it would assert it on every other device too.
        tx.execute(
            "UPDATE vocab_words
             SET mastery = ?1, next_review_at = ?2,
                 mastery_source = 'manual', mastery_reason = NULL,
                 updated_at = ?3, updated_by_device = ?4
             WHERE id = ?5",
            params![mastery, next_review_at, now, device, id],
        )?;
        if previous_mastery != mastery {
            record_mastery_event(
                tx,
                id,
                &previous_mastery,
                mastery,
                "manual",
                "user_override",
                "{}",
                now,
            )?;
        }
        // A status change (for example, "start learning") is not a review.
        // Keep the absolute count in the sync event so a future explicit SRS
        // review command can remain idempotent across replay.
        let (word, review) = tx
            .query_row(
                "SELECT word, review_count, review_interval_days, last_reviewed_at, last_review_rating, fsrs_stability, fsrs_difficulty, fsrs_version FROM vocab_words WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>("word")?, row_to_review_state(row)?)),
            )
            .map_err(crate::error::AppError::from)?;
        let progress = VocabProgress {
            mastery: mastery.to_string(),
            next_review_at,
            review_count: review.review_count,
            review_interval_days: review.review_interval_days,
            last_reviewed_at: review.last_reviewed_at,
            last_review_rating: review.last_review_rating,
            fsrs_stability: review.fsrs_stability,
            fsrs_difficulty: review.fsrs_difficulty,
            fsrs_version: review.fsrs_version,
            mastery_source: "manual".to_string(),
            mastery_reason: None,
        };
        events.push(EventBody::VocabMasterySet {
            id: id.to_string(),
            mastery: progress.mastery.clone(),
            next_review_at: progress.next_review_at,
            review_count: progress.review_count,
            review_interval_days: progress.review_interval_days,
            last_reviewed_at: progress.last_reviewed_at,
            last_review_rating: progress.last_review_rating.clone(),
            fsrs_stability: progress.fsrs_stability,
            fsrs_difficulty: progress.fsrs_difficulty,
            fsrs_version: progress.fsrs_version,
            mastery_source: progress.mastery_source.clone(),
            mastery_reason: progress.mastery_reason.clone(),
        });
        propagate_progress_to_siblings(tx, events, id, &word, &progress, now, &device)?;
        Ok(())
    })
}

// Unlike `query_vocab_words`, this one is a "due for review" list, not a
// backing store for the in-text annotation path — nothing needs the
// watchlist rows here. `propagate_progress_to_siblings` copies
// `next_review_at` onto every row sharing a spelling regardless of
// `list_status` (mastery/review progress belongs to the word, not the row),
// so a watchlist sibling of a confirmed word can carry a `next_review_at`
// of its own. Filtering on `list_status = 'confirmed'` here keeps that
// invisible-by-design data from resurfacing in a "words due for review"
// list. See the equivalent guard in `commands/review_piles.rs`.
pub(crate) fn query_vocab_due(db: &Db) -> AppResult<Vec<VocabWord>> {
    let conn = db.reader();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM vocab_words WHERE next_review_at IS NOT NULL AND next_review_at <= ?1 AND list_status = 'confirmed' ORDER BY next_review_at ASC",
        SELECT_COLS
    ))?;
    let words = stmt
        .query_map(params![now_ms], row_to_vocab)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

#[tauri::command]
pub fn list_vocab_due_for_review(db: State<'_, Db>) -> AppResult<Vec<VocabWord>> {
    query_vocab_due(&db)
}

// Reader-facing aggregate counts (currently only consumed by the MCP
// `get_vocab_stats` tool). The observation zone must not inflate any of
// these — every predicate below carries `list_status = 'confirmed'` so a
// word the reader only looked up once, and never consciously saved, never
// counts toward "how many words have I saved".
pub(crate) fn query_vocab_stats(db: &Db) -> AppResult<VocabStats> {
    let conn = db.reader();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE list_status = 'confirmed'",
        [],
        |r| r.get(0),
    )?;
    let new_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE mastery = 'new' AND list_status = 'confirmed'",
        [],
        |r| r.get(0),
    )?;
    let learning_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE mastery = 'learning' AND list_status = 'confirmed'",
        [],
        |r| r.get(0),
    )?;
    let familiar_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE mastery = 'familiar' AND list_status = 'confirmed'",
        [],
        |r| r.get(0),
    )?;
    let mastered_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE mastery = 'mastered' AND list_status = 'confirmed'",
        [],
        |r| r.get(0),
    )?;
    let due_for_review: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE next_review_at IS NOT NULL AND next_review_at <= ?1 AND list_status = 'confirmed'",
        params![now_ms],
        |r| r.get(0),
    )?;
    Ok(VocabStats {
        total,
        new_count,
        learning_count,
        familiar_count,
        mastered_count,
        due_for_review,
    })
}

fn vocab_backup_word(word: VocabWord) -> VocabBackupWord {
    VocabBackupWord {
        id: word.id,
        book_id: word.book_id,
        word: word.word,
        definition: word.definition,
        context_sentence: word.context_sentence,
        context_explanation: word.context_explanation,
        cfi: word.cfi,
        mastery: word.mastery,
        mastery_source: word.mastery_source,
        mastery_reason: word.mastery_reason,
        review_count: word.review_count,
        next_review_at: word.next_review_at,
        review_interval_days: word.review_interval_days,
        last_reviewed_at: word.last_reviewed_at,
        last_review_rating: word.last_review_rating,
        fsrs_stability: word.fsrs_stability,
        fsrs_difficulty: word.fsrs_difficulty,
        fsrs_version: word.fsrs_version,
        created_at: word.created_at,
        updated_at: word.updated_at,
        list_status: word.list_status,
    }
}

pub(crate) fn export_vocab_backup_inner(db: &Db) -> AppResult<VocabBackup> {
    // Watchlist words stay out: a backup is something the reader explicitly
    // asked for and may hand to someone else, and a word they only looked up
    // once has no business in it — see the observation zone's invisibility
    // rule in docs/impls/reading-flow-decisions-2026-08-06.md §1.
    // `query_all_vocab_words` already excludes them.
    let words = query_all_vocab_words(db)?
        .into_iter()
        .map(vocab_backup_word)
        .collect();
    Ok(VocabBackup {
        schema: VOCAB_BACKUP_SCHEMA.to_string(),
        version: VOCAB_BACKUP_VERSION,
        exported_at: Utc::now().timestamp_millis(),
        words,
    })
}

#[tauri::command]
pub fn export_vocab_backup(db: State<'_, Db>) -> AppResult<VocabBackup> {
    export_vocab_backup_inner(&db)
}

fn import_error(code: &str) -> crate::error::AppError {
    crate::error::AppError::Other(code.to_string())
}

fn parse_vocab_import(
    data: &str,
    format: VocabImportFormat,
) -> AppResult<(Vec<VocabBackupWord>, usize)> {
    if data.len() > MAX_VOCAB_IMPORT_BYTES {
        return Err(import_error("VOCAB_IMPORT_TOO_LARGE"));
    }
    match format {
        VocabImportFormat::Json => {
            let backup: VocabBackup = serde_json::from_str(data)
                .map_err(|_| import_error("VOCAB_IMPORT_JSON_INVALID"))?;
            if !is_known_vocab_backup_schema(&backup.schema)
                || backup.version != VOCAB_BACKUP_VERSION
            {
                return Err(import_error("VOCAB_IMPORT_VERSION_UNSUPPORTED"));
            }
            if backup.words.len() > MAX_VOCAB_IMPORT_WORDS {
                return Err(import_error("VOCAB_IMPORT_TOO_MANY_WORDS"));
            }
            Ok((backup.words, 0))
        }
        VocabImportFormat::Csv => {
            let mut reader = csv::ReaderBuilder::new()
                .trim(csv::Trim::All)
                .flexible(false)
                .from_reader(data.as_bytes());
            let mut words = Vec::new();
            let mut invalid_rows = 0;
            for row in reader.deserialize::<VocabCsvRow>() {
                match row {
                    Ok(row)
                        if is_known_vocab_backup_schema(&row.backup_schema)
                            && row.backup_version == VOCAB_BACKUP_VERSION =>
                    {
                        words.push(row.into());
                    }
                    Ok(_) | Err(_) => invalid_rows += 1,
                }
                if words.len().saturating_add(invalid_rows) > MAX_VOCAB_IMPORT_WORDS {
                    return Err(import_error("VOCAB_IMPORT_TOO_MANY_WORDS"));
                }
            }
            Ok((words, invalid_rows))
        }
    }
}

fn validate_import_word(word: &VocabBackupWord) -> bool {
    crate::sync::validation::validate_entity_id(&word.id).is_ok()
        && crate::sync::validation::validate_entity_id(&word.book_id).is_ok()
        && !word.word.trim().is_empty()
        && word.word.len() <= 512
        && word.definition.len() <= 100_000
        && word
            .context_sentence
            .as_ref()
            .is_none_or(|value| value.len() <= 100_000)
        && word
            .context_explanation
            .as_ref()
            .is_none_or(|value| value.len() <= 100_000)
        && word.cfi.as_ref().is_none_or(|value| value.len() <= 16_384)
        && validate_mastery(&word.mastery).is_ok()
        && word.review_count >= 0
        && word.review_interval_days >= 0
        && word.fsrs_version >= 1
        && word
            .fsrs_stability
            .is_none_or(|value| value.is_finite() && value >= 0.0)
        && word
            .fsrs_difficulty
            .is_none_or(|value| value.is_finite() && value >= 0.0)
        && word
            .last_review_rating
            .as_deref()
            .is_none_or(|value| matches!(value, "again" | "hard" | "good" | "easy"))
}

fn preview_vocab_import_words(
    words: &[VocabBackupWord],
    initial_invalid_rows: usize,
    db: &Db,
) -> AppResult<(VocabImportPreview, Vec<VocabBackupWord>)> {
    let conn = db.reader();
    let mut known_books = conn.prepare("SELECT EXISTS(SELECT 1 FROM books WHERE id = ?1)")?;
    let mut known_words = conn.prepare(
        "SELECT id FROM vocab_words WHERE book_id = ?1 AND word = ?2 COLLATE NOCASE LIMIT 1",
    )?;
    let mut seen_ids = HashSet::new();
    let mut seen_words = HashSet::new();
    let mut valid_words = Vec::new();
    let mut preview = VocabImportPreview {
        valid: 0,
        new_words: 0,
        conflicts: 0,
        missing_books: 0,
        duplicate_rows: 0,
        invalid_rows: initial_invalid_rows,
    };

    for word in words {
        if !validate_import_word(word) {
            preview.invalid_rows += 1;
            continue;
        }
        let dedupe_key = format!("{}\u{0}{}", word.book_id, word.word.to_lowercase());
        if !seen_ids.insert(word.id.clone()) || !seen_words.insert(dedupe_key) {
            preview.duplicate_rows += 1;
            continue;
        }
        preview.valid += 1;
        let book_exists: bool = known_books.query_row(params![word.book_id], |row| row.get(0))?;
        if !book_exists {
            preview.missing_books += 1;
            continue;
        }
        let existing: Option<String> = known_words
            .query_row(params![word.book_id, word.word], |row| row.get(0))
            .ok();
        if existing.is_some() {
            preview.conflicts += 1;
        } else {
            preview.new_words += 1;
        }
        valid_words.push(word.clone());
    }
    Ok((preview, valid_words))
}

#[tauri::command]
pub fn preview_vocab_import(
    data: String,
    format: VocabImportFormat,
    db: State<'_, Db>,
) -> AppResult<VocabImportPreview> {
    preview_vocab_import_inner(&data, format, &db)
}

pub(crate) fn preview_vocab_import_inner(
    data: &str,
    format: VocabImportFormat,
    db: &Db,
) -> AppResult<VocabImportPreview> {
    let (words, invalid_rows) = parse_vocab_import(data, format)?;
    preview_vocab_import_words(&words, invalid_rows, db).map(|(preview, _)| preview)
}

pub(crate) fn do_import_vocab_backup(
    data: &str,
    format: VocabImportFormat,
    conflict_policy: VocabImportConflictPolicy,
    dry_run: bool,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<VocabImportResult> {
    let (words, invalid_rows) = parse_vocab_import(data, format)?;
    let (preview, words) = preview_vocab_import_words(&words, invalid_rows, db)?;
    if dry_run {
        return Ok(VocabImportResult {
            preview,
            imported: 0,
            replaced: 0,
            skipped: 0,
            dry_run: true,
        });
    }

    let timestamp = Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    let (imported, replaced, skipped) = sync.with_tx(db, timestamp, |tx, events| {
        let mut imported = 0;
        let mut replaced = 0;
        let mut skipped = preview.invalid_rows + preview.duplicate_rows + preview.missing_books;
        for word in &words {
            let book_exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM books WHERE id = ?1)",
                params![word.book_id],
                |row| row.get(0),
            )?;
            if !book_exists {
                continue;
            }
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM vocab_words WHERE book_id = ?1 AND word = ?2 COLLATE NOCASE LIMIT 1",
                    params![word.book_id, word.word],
                    |row| row.get(0),
                )
                .ok();
            if let Some(existing_id) = existing {
                if matches!(
                    conflict_policy,
                    VocabImportConflictPolicy::Skip | VocabImportConflictPolicy::Merge
                ) {
                    skipped += 1;
                    continue;
                }
                tx.execute("DELETE FROM vocab_words WHERE id = ?1", params![existing_id])?;
                events.push(EventBody::VocabDelete { id: existing_id });
                replaced += 1;
            }

            let id = uuid::Uuid::new_v4().to_string();
            let created_at = if word.created_at > 0 { word.created_at } else { timestamp };
            tx.execute(
                "INSERT INTO vocab_words (id, book_id, word, definition, context_sentence, context_explanation, cfi, mastery, mastery_source, mastery_reason, review_count, next_review_at, review_interval_days, last_reviewed_at, last_review_rating, fsrs_stability, fsrs_difficulty, fsrs_version, list_status, created_at, updated_at, updated_by_device)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
                params![
                    id,
                    word.book_id,
                    word.word,
                    word.definition,
                    word.context_sentence,
                    word.context_explanation,
                    word.cfi,
                    word.mastery,
                    word.mastery_source,
                    word.mastery_reason,
                    word.review_count,
                    word.next_review_at,
                    word.review_interval_days,
                    word.last_reviewed_at,
                    word.last_review_rating,
                    word.fsrs_stability,
                    word.fsrs_difficulty,
                    word.fsrs_version,
                    word.list_status,
                    created_at,
                    timestamp,
                    device,
                ],
            )?;
            events.push(EventBody::VocabAdd(VocabPayload {
                id: id.clone(),
                book_id: word.book_id.clone(),
                word: word.word.clone(),
                definition: word.definition.clone(),
                context_sentence: word.context_sentence.clone(),
                context_explanation: word.context_explanation.clone(),
                cfi: word.cfi.clone(),
                mastery: word.mastery.clone(),
                mastery_source: word.mastery_source.clone(),
                mastery_reason: word.mastery_reason.clone(),
                review_count: word.review_count,
                next_review_at: word.next_review_at,
                review_interval_days: word.review_interval_days,
                last_reviewed_at: word.last_reviewed_at,
                last_review_rating: word.last_review_rating.clone(),
                fsrs_stability: word.fsrs_stability,
                fsrs_difficulty: word.fsrs_difficulty,
                fsrs_version: word.fsrs_version,
                created_at: Some(created_at),
                list_status: word.list_status.clone(),
                card_snapshot: None,
            }));
            imported += 1;
        }
        Ok((imported, replaced, skipped))
    })?;

    Ok(VocabImportResult {
        preview,
        imported,
        replaced,
        skipped,
        dry_run: false,
    })
}

#[tauri::command]
pub fn import_vocab_backup(
    data: String,
    format: VocabImportFormat,
    conflict_policy: VocabImportConflictPolicy,
    dry_run: bool,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<VocabImportResult> {
    do_import_vocab_backup(&data, format, conflict_policy, dry_run, &db, &sync)
}

#[tauri::command]
pub fn bulk_delete_vocab_words(
    ids: Vec<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<usize> {
    delete_vocab_words_inner(&ids, &db, &sync)
}

pub(crate) fn delete_vocab_words_inner(
    ids: &[String],
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<usize> {
    for id in ids {
        crate::sync::validation::validate_entity_id(id)?;
    }
    if ids.is_empty() {
        return Ok(0);
    }
    let timestamp = sync.next_logical_timestamp();
    sync.with_tx(db, timestamp, |tx, events| {
        let mut deleted = 0;
        for id in ids {
            if tx.execute("DELETE FROM vocab_words WHERE id = ?1", params![id])? > 0 {
                insert_tombstone(tx, entity::VOCAB, id, timestamp)?;
                events.push(EventBody::VocabDelete { id: id.clone() });
                deleted += 1;
            }
        }
        Ok(deleted)
    })
}

#[tauri::command]
pub fn bulk_update_vocab_mastery(
    ids: Vec<String>,
    mastery: String,
    next_review_at: Option<i64>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<usize> {
    bulk_update_vocab_mastery_inner(&ids, &mastery, next_review_at, &db, &sync)
}

pub(crate) fn bulk_update_vocab_mastery_inner(
    ids: &[String],
    mastery: &str,
    next_review_at: Option<i64>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<usize> {
    validate_mastery(mastery)?;
    for id in ids {
        crate::sync::validation::validate_entity_id(id)?;
    }
    if ids.is_empty() {
        return Ok(0);
    }
    let timestamp = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();
    sync.with_tx(db, timestamp, |tx, events| {
        let mut changed = 0;
        for id in ids {
            let found = tx
                .query_row(
                    "SELECT word, review_count, review_interval_days, last_reviewed_at, last_review_rating, fsrs_stability, fsrs_difficulty, fsrs_version, mastery FROM vocab_words WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get::<_, String>("word")?,
                            row_to_review_state(row)?,
                            row.get::<_, String>("mastery")?,
                        ))
                    },
                )
                .ok();
            let Some((word, review, previous_mastery)) = found else {
                continue;
            };
            // Same reasoning as the single-word path: a bulk tier change is
            // still the reader overruling the app, so it stamps `manual` and
            // drops the automatic explanation.
            tx.execute(
                "UPDATE vocab_words
                 SET mastery = ?1, next_review_at = ?2,
                     mastery_source = 'manual', mastery_reason = NULL,
                     updated_at = ?3, updated_by_device = ?4
                 WHERE id = ?5",
                params![mastery, next_review_at, timestamp, device, id],
            )?;
            if previous_mastery != mastery {
                record_mastery_event(
                    tx,
                    id,
                    &previous_mastery,
                    mastery,
                    "manual",
                    "user_override",
                    "{}",
                    timestamp,
                )?;
            }
            let progress = VocabProgress {
                mastery: mastery.to_string(),
                next_review_at,
                review_count: review.review_count,
                review_interval_days: review.review_interval_days,
                last_reviewed_at: review.last_reviewed_at,
                last_review_rating: review.last_review_rating,
                fsrs_stability: review.fsrs_stability,
                fsrs_difficulty: review.fsrs_difficulty,
                fsrs_version: review.fsrs_version,
                mastery_source: "manual".to_string(),
                mastery_reason: None,
            };
            events.push(EventBody::VocabMasterySet {
                id: id.clone(),
                mastery: progress.mastery.clone(),
                next_review_at: progress.next_review_at,
                review_count: progress.review_count,
                review_interval_days: progress.review_interval_days,
                last_reviewed_at: progress.last_reviewed_at,
                last_review_rating: progress.last_review_rating.clone(),
                fsrs_stability: progress.fsrs_stability,
                fsrs_difficulty: progress.fsrs_difficulty,
                fsrs_version: progress.fsrs_version,
                mastery_source: progress.mastery_source.clone(),
                mastery_reason: progress.mastery_reason.clone(),
            });
            propagate_progress_to_siblings(
                tx, events, id, &word, &progress, timestamp, &device,
            )?;
            changed += 1;
        }
        Ok(changed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::log::EventLog;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn setup_import_db() -> (TempDir, Db, SyncWriter) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let writer = SyncWriter::new("dev-import".into());
        writer.set_should_queue(true);
        writer.set_log(Some(Arc::new(
            EventLog::open(
                &dir.path().join("logs/dev-import.jsonl"),
                "dev-import",
                false,
            )
            .unwrap(),
        )));
        writer.set_flush_inline_for_tests(true);
        (dir, db, writer)
    }

    fn insert_import_book(db: &Db, id: &str) {
        let now = 1_700_000_000_000_i64;
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES (?1, 'Import Book', 'Author', 'books/import.epub', 'unread', 0, ?2, ?2)",
                params![id, now],
            )
            .unwrap();
    }

    #[test]
    fn all_vocab_words_recover_the_chapter_from_lookup_history() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-chapter");
        add_vocab_word_inner(
            "book-chapter",
            "Courage",
            "the ability to act",
            Some("True freedom is the courage to be disliked.".to_string()),
            None,
            Some("epubcfi(/6/2!/4/2)".to_string()),
            None,
            &db,
            &sync,
        )
        .unwrap();
        add_vocab_word_inner(
            "book-chapter",
            "Solitude",
            "being alone",
            None,
            None,
            None,
            None,
            &db,
            &sync,
        )
        .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO lookup_records (id, book_id, lookup_text, normalized_text, chapter, cfi, definition, created_at, last_looked_up_at, lookup_count)
                 VALUES ('lr-1', 'book-chapter', 'courage', 'courage', 'Chapter Three', 'epubcfi(/6/2!/4/2)', 'd', 1, 1, 1)",
                [],
            )
            .unwrap();

        let words = query_all_vocab_words(&db).unwrap();
        let courage = words.iter().find(|w| w.word == "Courage").unwrap();
        let solitude = words.iter().find(|w| w.word == "Solitude").unwrap();
        assert_eq!(courage.chapter.as_deref(), Some("Chapter Three"));
        // No lookup row, so the review surface must not draw a chapter at all.
        assert_eq!(solitude.chapter, None);
    }

    fn stored_word(db: &Db, id: &str) -> VocabWord {
        db.reader()
            .query_row(
                &format!("SELECT {SELECT_COLS} FROM vocab_words WHERE id = ?1"),
                params![id],
                row_to_vocab,
            )
            .unwrap()
    }

    /// Two books, the same word in both plus an unrelated word in the second.
    fn setup_sibling_db() -> (TempDir, Db, SyncWriter, String, String, String) {
        let (dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-a");
        insert_import_book(&db, "book-b");
        let a = add_vocab_word_inner("book-a", "Courage", "def a", None, None, None, None, &db, &sync)
            .unwrap();
        let b = add_vocab_word_inner("book-b", "courage", "def b", None, None, None, None, &db, &sync)
            .unwrap();
        let other =
            add_vocab_word_inner("book-b", "solitude", "def c", None, None, None, None, &db, &sync)
                .unwrap();
        (dir, db, sync, a.id, b.id, other.id)
    }

    #[test]
    fn mastery_change_reaches_the_same_word_in_another_book() {
        let (_dir, db, sync, a, b, other) = setup_sibling_db();

        update_vocab_mastery_inner(&a, "learning", Some(1_800_000_000_000), &db, &sync).unwrap();

        // Case differences are the same word, so the sibling follows along.
        let sibling = stored_word(&db, &b);
        assert_eq!(sibling.mastery, "learning");
        assert_eq!(sibling.next_review_at, Some(1_800_000_000_000));
        // A different word must never be dragged along.
        let untouched = stored_word(&db, &other);
        assert_eq!(untouched.mastery, "new");
        assert_eq!(untouched.next_review_at, None);
    }

    #[test]
    fn review_result_reaches_the_same_word_in_another_book() {
        let (_dir, db, sync, a, b, other) = setup_sibling_db();

        let reviewed = record_vocab_review_inner(&a, VocabReviewRating::Good, &db, &sync).unwrap();

        let sibling = stored_word(&db, &b);
        assert_eq!(sibling.mastery, reviewed.mastery);
        assert_eq!(sibling.next_review_at, reviewed.next_review_at);
        assert_eq!(sibling.review_count, reviewed.review_count);
        assert_eq!(sibling.review_interval_days, reviewed.review_interval_days);
        assert_eq!(sibling.last_reviewed_at, reviewed.last_reviewed_at);
        assert_eq!(
            sibling.last_review_rating.as_deref(),
            reviewed.last_review_rating.as_deref()
        );
        assert_eq!(sibling.fsrs_stability, reviewed.fsrs_stability);
        assert_eq!(sibling.fsrs_difficulty, reviewed.fsrs_difficulty);
        assert_eq!(stored_word(&db, &other).review_count, 0);
    }

    /// The schedule propagates to sibling rows; the review does not. One word
    /// saved from two books that gets reviewed once must leave one row in the
    /// log, or an optimizer reads the reader's shelf as their study history.
    #[test]
    fn a_review_logs_one_row_no_matter_how_many_rows_spell_the_word() {
        let (_dir, db, sync, a, b, _other) = setup_sibling_db();

        record_vocab_review_inner(&a, VocabReviewRating::Good, &db, &sync).unwrap();

        let conn = db.reader();
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM vocab_review_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1);
        let logged_for: String = conn
            .query_row("SELECT vocab_word_id FROM vocab_review_log", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(logged_for, a);
        assert_ne!(logged_for, b);
    }

    /// The subset of a `vocab_review_log` row the "before" assertions read.
    struct LoggedReview {
        rating: String,
        state_before: Option<String>,
        stability_before: Option<f64>,
        difficulty_before: Option<f64>,
    }

    /// `stability_before` must hold what the card looked like going *into* the
    /// review, not what the scheduler left behind. The UPDATE overwrites the
    /// column in the same transaction, so reading it a statement too late
    /// silently records the "after" value under an "before" name — a bug that
    /// would produce a plausible-looking log and a badly trained optimizer.
    #[test]
    fn the_log_records_the_state_the_review_started_from() {
        let (_dir, db, sync, a, _b, _other) = setup_sibling_db();

        let first = record_vocab_review_inner(&a, VocabReviewRating::Good, &db, &sync).unwrap();
        let second = record_vocab_review_inner(&a, VocabReviewRating::Hard, &db, &sync).unwrap();

        let conn = db.reader();
        let mut stmt = conn
            .prepare(
                "SELECT rating, state_before, stability_before, difficulty_before
                   FROM vocab_review_log ORDER BY reviewed_at, rowid",
            )
            .unwrap();
        let rows: Vec<LoggedReview> = stmt
            .query_map([], |r| {
                Ok(LoggedReview {
                    rating: r.get(0)?,
                    state_before: r.get(1)?,
                    stability_before: r.get(2)?,
                    difficulty_before: r.get(3)?,
                })
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        assert_eq!(rows.len(), 2);
        // First review: nothing came before it.
        assert_eq!(rows[0].rating, "good");
        assert_eq!(rows[0].state_before, None);
        assert_eq!(rows[0].stability_before, None);
        assert_eq!(rows[0].difficulty_before, None);
        // Second review: the "before" pair is exactly the first review's
        // result.
        assert_eq!(rows[1].rating, "hard");
        assert_eq!(rows[1].state_before.as_deref(), Some("review"));
        assert_eq!(rows[1].stability_before, first.fsrs_stability);
        assert_eq!(rows[1].difficulty_before, first.fsrs_difficulty);
        // ...and is not simply the second review's own result read back a
        // statement too late. Asserted across the pair rather than on one
        // column: both reviews land in the same millisecond, so FSRS leaves
        // stability untouched and only difficulty moves. Requiring *some*
        // movement keeps the guard honest without pinning which field carries
        // it, which is a scheduler detail this test has no business fixing.
        assert!(
            (rows[1].stability_before, rows[1].difficulty_before)
                != (second.fsrs_stability, second.fsrs_difficulty),
            "stability_before/difficulty_before were read after the UPDATE"
        );
    }

    #[test]
    fn bulk_mastery_change_reaches_siblings_without_inflating_the_count() {
        let (_dir, db, sync, a, b, other) = setup_sibling_db();

        // Only one of the two sibling rows is selected.
        let changed =
            bulk_update_vocab_mastery_inner(std::slice::from_ref(&a), "mastered", None, &db, &sync)
                .unwrap();

        assert_eq!(changed, 1);
        assert_eq!(stored_word(&db, &b).mastery, "mastered");
        assert_eq!(stored_word(&db, &other).mastery, "new");
    }

    /// The "我其实不认识" button lands here. Overruling an automatic tier has
    /// to clear the automatic mark *and* the sentence that justified it —
    /// otherwise the word-detail page keeps showing "自动判定" next to a tier
    /// the reader has just contradicted.
    #[test]
    fn overruling_an_automatic_tier_clears_the_automatic_mark_and_its_sentence() {
        let (_dir, db, sync, a, b, _other) = setup_sibling_db();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE vocab_words
                 SET mastery = 'familiar', mastery_source = 'auto',
                     mastery_reason = '{\"reason\":\"exposure_promotion\"}'",
                [],
            )
            .unwrap();

        update_vocab_mastery_inner(&a, "learning", None, &db, &sync).unwrap();

        for id in [&a, &b] {
            let stored = stored_word(&db, id);
            assert_eq!(stored.mastery, "learning");
            assert_eq!(
                stored.mastery_source, "manual",
                "the sibling in the other book is the same word to the reader, \
                 so it must stop claiming the app decided this"
            );
            assert_eq!(stored.mastery_reason, None);
        }
    }

    /// The columns are synced, so a second device has to hear about the
    /// override too — a peer still holding 'auto' would go on rendering the
    /// explanation this reader already overruled.
    #[test]
    fn the_override_travels_to_other_devices_in_the_sync_event() {
        let (dir, db, sync, a, b, _other) = setup_sibling_db();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE vocab_words SET mastery_source = 'auto', mastery_reason = '{}'",
                [],
            )
            .unwrap();

        update_vocab_mastery_inner(&a, "learning", None, &db, &sync).unwrap();

        let log = std::fs::read_to_string(dir.path().join("logs/dev-import.jsonl")).unwrap();
        let mastery_sets: Vec<_> = log
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str::<crate::sync::events::Event>(line).unwrap())
            .filter_map(|event| match event.body {
                EventBody::VocabMasterySet {
                    id,
                    mastery_source,
                    mastery_reason,
                    ..
                } => Some((id, mastery_source, mastery_reason)),
                _ => None,
            })
            .collect();
        for id in [&a, &b] {
            assert!(
                mastery_sets.contains(&(id.clone(), "manual".to_string(), None)),
                "expected a manual override event for {id}, got {mastery_sets:?}"
            );
        }
    }

    /// The timeline the word-detail page reads is written here, not by the
    /// (still unbuilt) exposure engine — a manual override is the one
    /// transition the app can already narrate.
    #[test]
    fn overruling_a_tier_records_one_timeline_entry() {
        let (_dir, db, sync, a, _b, _other) = setup_sibling_db();

        update_vocab_mastery_inner(&a, "learning", None, &db, &sync).unwrap();
        // Setting the same tier again is not a transition and must not
        // clutter the timeline with a row saying nothing changed.
        update_vocab_mastery_inner(&a, "learning", None, &db, &sync).unwrap();

        let events = crate::commands::mastery_events::list_mastery_events_for(&db, &a).unwrap();
        assert_eq!(events.len(), 1, "got {events:?}");
        assert_eq!(events[0].from_mastery, "new");
        assert_eq!(events[0].to_mastery, "learning");
        assert_eq!(events[0].source, "manual");
        assert_eq!(events[0].reason, "user_override");
    }

    #[test]
    fn a_word_saved_from_one_book_only_still_updates_itself() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-a");
        let only = add_vocab_word_inner(
            "book-a",
            "solitude",
            "being alone",
            None,
            None,
            None,
            None,
            &db,
            &sync,
        )
        .unwrap();

        update_vocab_mastery_inner(&only.id, "mastered", None, &db, &sync).unwrap();

        let stored = stored_word(&db, &only.id);
        assert_eq!(stored.mastery, "mastered");
        assert_eq!(stored.next_review_at, None);
        let rows: i64 = db
            .reader()
            .query_row("SELECT COUNT(*) FROM vocab_words", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    /// The stats are handed to an MCP client as a breakdown of `total`, so a
    /// tier without a bucket is not a cosmetic omission — it is a number that
    /// silently stops adding up. Adding a fifth tier should fail here first.
    #[test]
    fn every_mastery_tier_lands_in_exactly_one_stats_bucket() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-a");

        for (word, mastery) in [
            ("alpha", "new"),
            ("beta", "learning"),
            ("gamma", "familiar"),
            ("delta", "mastered"),
        ] {
            let added =
                add_vocab_word_inner("book-a", word, "a definition", None, None, None, None, &db, &sync)
                    .unwrap();
            update_vocab_mastery_inner(&added.id, mastery, None, &db, &sync).unwrap();
        }

        let stats = query_vocab_stats(&db).unwrap();
        assert_eq!(stats.total, 4);
        assert_eq!(
            stats.new_count + stats.learning_count + stats.familiar_count + stats.mastered_count,
            stats.total,
            "every word must be counted by exactly one bucket: {stats:?}"
        );
        assert_eq!(stats.familiar_count, 1);
    }

    /// Regression for the MCP watchlist leak: a word sitting in the
    /// observation zone (`list_status = 'watchlist'`) must not inflate any
    /// bucket the AI client sees through `get_vocab_stats`. Before the fix,
    /// every `COUNT(*)` here was predicate-free.
    #[test]
    fn vocab_stats_excludes_the_observation_zone() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-a");

        add_vocab_word_inner(
            "book-a",
            "steadfast",
            "a definition",
            None,
            None,
            None,
            None,
            &db,
            &sync,
        )
        .unwrap();
        // A plain lookup, never saved: lands in the observation zone.
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO vocab_words
                 (id, book_id, word, definition, mastery, review_count, list_status,
                  created_at, updated_at)
                 VALUES ('watchlist-word', 'book-a', 'ephemeral', 'a definition', 'new', 0,
                         'watchlist', 1, 1)",
                [],
            )
            .unwrap();

        let stats = query_vocab_stats(&db).unwrap();
        assert_eq!(
            stats.total, 1,
            "watchlist row must not count toward total: {stats:?}"
        );
        assert_eq!(stats.new_count, 1);
    }

    /// Regression for the more subtle half of the same leak:
    /// `propagate_progress_to_siblings` copies `next_review_at` onto every
    /// row sharing a spelling regardless of `list_status` (mastery belongs
    /// to the word, not the row), so a watchlist sibling can end up with a
    /// `next_review_at` in the past. `query_vocab_due` must still exclude
    /// it — a word the reader never consciously saved must never show up
    /// in a "due for review" list.
    #[test]
    fn due_for_review_excludes_a_watchlist_sibling() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-a");
        let past = chrono::Utc::now().timestamp_millis() - 1_000;

        let confirmed = add_vocab_word_inner(
            "book-a",
            "lucid",
            "a definition",
            None,
            None,
            None,
            None,
            &db,
            &sync,
        )
        .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE vocab_words SET next_review_at = ?1 WHERE id = ?2",
                params![past, confirmed.id],
            )
            .unwrap();
        // Same spelling, still in the observation zone, but carrying its own
        // (independently set) due timestamp — exactly what
        // `propagate_progress_to_siblings` can produce.
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO vocab_words
                 (id, book_id, word, definition, mastery, review_count, next_review_at,
                  list_status, created_at, updated_at)
                 VALUES ('watchlist-sibling', 'book-a', 'lucid', 'a definition', 'new', 0, ?1,
                         'watchlist', 1, 1)",
                params![past],
            )
            .unwrap();

        let due = query_vocab_due(&db).unwrap();
        assert_eq!(
            due.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(),
            vec![confirmed.id.as_str()],
            "watchlist sibling must not appear in the due-for-review list"
        );
    }

    fn backup_word(id: &str, book_id: &str, word: &str, definition: &str) -> VocabBackupWord {
        VocabBackupWord {
            id: id.to_string(),
            book_id: book_id.to_string(),
            word: word.to_string(),
            definition: definition.to_string(),
            context_sentence: Some("A useful sentence.".to_string()),
            context_explanation: Some("Useful context.".to_string()),
            cfi: Some("epubcfi(/6/2!/4/2)".to_string()),
            mastery: "learning".to_string(),
            mastery_source: "manual".to_string(),
            mastery_reason: None,
            review_count: 4,
            next_review_at: Some(1_800_000_000_000),
            review_interval_days: 9,
            last_reviewed_at: Some(1_700_000_000_000),
            last_review_rating: Some("good".to_string()),
            fsrs_stability: Some(12.5),
            fsrs_difficulty: Some(4.3),
            fsrs_version: 1,
            list_status: default_list_status(),
            created_at: 1_600_000_000_000,
            updated_at: 1_700_000_000_000,
        }
    }

    fn backup_json(words: Vec<VocabBackupWord>) -> String {
        serde_json::to_string(&VocabBackup {
            schema: VOCAB_BACKUP_SCHEMA.to_string(),
            version: VOCAB_BACKUP_VERSION,
            exported_at: 1_700_000_000_000,
            words,
        })
        .unwrap()
    }

    #[test]
    fn vocab_import_json_preserves_full_srs_state_in_database_and_event() {
        let (dir, db, writer) = setup_import_db();
        insert_import_book(&db, "book-1");
        let word = backup_word(
            "backup-1",
            "book-1",
            "serendipity",
            "A fortunate discovery.",
        );

        let result = do_import_vocab_backup(
            &backup_json(vec![word]),
            VocabImportFormat::Json,
            VocabImportConflictPolicy::Skip,
            false,
            &db,
            &writer,
        )
        .unwrap();

        assert_eq!(result.imported, 1);
        let stored = query_vocab_words_including_watchlist(&db, "book-1").unwrap().pop().unwrap();
        assert_eq!(stored.word, "serendipity");
        assert_eq!(stored.mastery, "learning");
        assert_eq!(stored.review_count, 4);
        assert_eq!(stored.next_review_at, Some(1_800_000_000_000));
        assert_eq!(stored.review_interval_days, 9);
        assert_eq!(stored.last_reviewed_at, Some(1_700_000_000_000));
        assert_eq!(stored.last_review_rating.as_deref(), Some("good"));
        assert_eq!(stored.fsrs_stability, Some(12.5));
        assert_eq!(stored.fsrs_difficulty, Some(4.3));
        assert_eq!(stored.fsrs_version, 1);
        assert_eq!(stored.created_at, 1_600_000_000_000);

        let events = EventLog::open(
            &dir.path().join("logs/dev-import.jsonl"),
            "dev-import",
            false,
        )
        .unwrap()
        .read_all()
        .unwrap();
        let EventBody::VocabAdd(payload) = &events[0].body else {
            panic!("expected a VocabAdd event");
        };
        assert_eq!(payload.mastery, stored.mastery);
        assert_eq!(payload.review_count, stored.review_count);
        assert_eq!(payload.next_review_at, stored.next_review_at);
        assert_eq!(payload.review_interval_days, stored.review_interval_days);
        assert_eq!(payload.fsrs_stability, stored.fsrs_stability);
        assert_eq!(payload.fsrs_difficulty, stored.fsrs_difficulty);
        assert_eq!(payload.created_at, Some(stored.created_at));
    }

    fn backup_csv(schema: &str) -> String {
        format!(
            "backup_schema,backup_version,id,book_id,word,definition,context_sentence,context_explanation,cfi,mastery,review_count,next_review_at,review_interval_days,last_reviewed_at,last_review_rating,fsrs_stability,fsrs_difficulty,fsrs_version,created_at,updated_at\n{schema},1,backup-1,book-1,ephemeral,Short-lived,A useful sentence.,Useful context.,epubcfi(/6/2!/4/2),learning,4,1800000000000,9,1700000000000,good,12.5,4.3,1,1600000000000,1700000000000\n"
        )
    }

    fn import_one_csv_row(schema: &str) -> usize {
        let (_dir, db, writer) = setup_import_db();
        insert_import_book(&db, "book-1");

        let result = do_import_vocab_backup(
            &backup_csv(schema),
            VocabImportFormat::Csv,
            VocabImportConflictPolicy::Skip,
            false,
            &db,
            &writer,
        )
        .unwrap();

        assert_eq!(
            query_vocab_words_including_watchlist(&db, "book-1").unwrap()[0].word,
            "ephemeral"
        );
        result.imported
    }

    #[test]
    fn vocab_import_csv_accepts_a_valid_backup_row() {
        assert_eq!(import_one_csv_row(VOCAB_BACKUP_SCHEMA), 1);
    }

    #[test]
    fn vocab_import_rejects_unsupported_json_schema_version() {
        let (_dir, db, writer) = setup_import_db();
        let invalid = r#"{"schema":"lantern-vocabulary","version":99,"exported_at":0,"words":[]}"#;

        let error = do_import_vocab_backup(
            invalid,
            VocabImportFormat::Json,
            VocabImportConflictPolicy::Skip,
            false,
            &db,
            &writer,
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "VOCAB_IMPORT_VERSION_UNSUPPORTED");
    }

    #[test]
    fn vocab_import_reports_missing_books_without_writing_words() {
        let (_dir, db, writer) = setup_import_db();

        let result = do_import_vocab_backup(
            &backup_json(vec![backup_word(
                "backup-1",
                "missing-book",
                "wander",
                "To roam.",
            )]),
            VocabImportFormat::Json,
            VocabImportConflictPolicy::Skip,
            false,
            &db,
            &writer,
        )
        .unwrap();

        assert_eq!(result.preview.missing_books, 1);
        assert_eq!(result.imported, 0);
        assert_eq!(result.skipped, 1);
        let word_count: i64 = db
            .reader()
            .query_row("SELECT COUNT(*) FROM vocab_words", [], |row| row.get(0))
            .unwrap();
        assert_eq!(word_count, 0);
    }

    #[test]
    fn vocab_import_conflict_policy_skips_or_overwrites_existing_word() {
        let (_dir, db, writer) = setup_import_db();
        insert_import_book(&db, "book-1");
        let original = backup_word("backup-1", "book-1", "resolve", "Original definition.");
        do_import_vocab_backup(
            &backup_json(vec![original]),
            VocabImportFormat::Json,
            VocabImportConflictPolicy::Skip,
            false,
            &db,
            &writer,
        )
        .unwrap();

        let replacement = backup_word("backup-2", "book-1", "resolve", "Replacement definition.");
        let skipped = do_import_vocab_backup(
            &backup_json(vec![replacement.clone()]),
            VocabImportFormat::Json,
            VocabImportConflictPolicy::Skip,
            false,
            &db,
            &writer,
        )
        .unwrap();
        assert_eq!(skipped.imported, 0);
        assert_eq!(skipped.skipped, 1);
        assert_eq!(
            query_vocab_words_including_watchlist(&db, "book-1").unwrap()[0].definition,
            "Original definition."
        );

        let overwritten = do_import_vocab_backup(
            &backup_json(vec![replacement]),
            VocabImportFormat::Json,
            VocabImportConflictPolicy::Overwrite,
            false,
            &db,
            &writer,
        )
        .unwrap();
        assert_eq!(overwritten.imported, 1);
        assert_eq!(overwritten.replaced, 1);
        let words = query_vocab_words_including_watchlist(&db, "book-1").unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].definition, "Replacement definition.");
    }

    #[test]
    fn again_returns_word_to_short_learning_interval() {
        let first = schedule_review(VocabReviewRating::Again, None, None, None, 1_000).unwrap();
        assert_eq!(first.mastery_outcome, MasteryOutcome::Demote);
        assert_eq!(first.review_interval_days, 0);
        // A zero-day interval must still land in the future. The upstream
        // scheduler has no learning steps, so this floor is ours; without it
        // the card is due the moment it is written and the queue re-serves it.
        assert_eq!(first.next_review_at, 1_000 + RELEARN_STEP_MS);
        assert!(first.stability > 0.0 && first.difficulty > 0.0);
    }

    /// A card with no stored stability has never been scheduled, so there is
    /// no prior state to log — and once it has one, there is. Guards the two
    /// `*_before` columns against the tempting-but-wrong shortcut of writing
    /// `"new"` for a first review, which would make "never seen" and "seen,
    /// judged new" indistinguishable in the optimizer's training data.
    #[test]
    fn first_review_has_no_prior_state_and_later_ones_do() {
        let first = schedule_review(VocabReviewRating::Good, None, None, None, 1_000).unwrap();
        assert_eq!(first.state_before, None);
        assert_eq!(first.elapsed_days, 0);

        let second = schedule_review(
            VocabReviewRating::Good,
            Some(first.stability),
            Some(first.difficulty),
            Some(1_000),
            1_000 + 3 * DAY_MS,
        )
        .unwrap();
        assert_eq!(second.state_before, Some("review"));
        assert_eq!(second.elapsed_days, 3);
    }

    #[test]
    fn good_grows_interval_and_eventually_marks_mastered() {
        let first = schedule_review(VocabReviewRating::Good, None, None, None, 1_000).unwrap();
        let second = schedule_review(
            VocabReviewRating::Good,
            Some(first.stability),
            Some(first.difficulty),
            Some(1_000),
            1_000 + first.review_interval_days * DAY_MS,
        )
        .unwrap();
        assert!(second.review_interval_days >= first.review_interval_days);
        assert!(second.next_review_at > 1_000);
    }

    /// Sets a word's tier and provenance directly, the way the reading-
    /// exposure engine or a prior review would have left it, so a review
    /// test can start from a known tier instead of `"new"`.
    fn seed_mastery(db: &Db, id: &str, mastery: &str, mastery_source: &str, mastery_reason: Option<&str>) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE vocab_words SET mastery = ?1, mastery_source = ?2, mastery_reason = ?3 WHERE id = ?4",
                params![mastery, mastery_source, mastery_reason, id],
            )
            .unwrap();
    }

    fn mastery_event_count(db: &Db, id: &str) -> usize {
        crate::commands::mastery_events::list_mastery_events_for(db, id)
            .unwrap()
            .len()
    }

    /// A passing rating on a card whose interval lands under the mastery
    /// threshold is not strong evidence either way — a right answer must not
    /// demote a tier the reading-exposure engine already raised, and it does
    /// not promote it either. `mastery_source`/`mastery_reason` — the
    /// exposure engine's own provenance — must be untouched, and no
    /// `mastery_events` row should appear (the statistics page counts those
    /// rows as tier changes).
    #[test]
    fn a_passing_review_under_the_mastery_threshold_keeps_an_auto_tier_and_its_reason() {
        let (_dir, db, sync, a, _b, _other) = setup_sibling_db();
        seed_mastery(
            &db,
            &a,
            "familiar",
            "auto",
            Some("{\"reason\":\"exposure_promotion\"}"),
        );
        let before_events = mastery_event_count(&db, &a);

        // First-ever review, no prior FSRS state: a "good" rating lands a
        // short interval (single-digit days), well under the 21-day
        // threshold.
        let reviewed = record_vocab_review_inner(&a, VocabReviewRating::Good, &db, &sync).unwrap();

        assert!(
            reviewed.review_interval_days < 21,
            "test assumption broken: first-ever 'good' review must land under \
             the mastery threshold, got {}",
            reviewed.review_interval_days
        );
        assert_eq!(reviewed.mastery, "familiar");
        assert_eq!(reviewed.mastery_source, "auto");
        assert_eq!(
            reviewed.mastery_reason.as_deref(),
            Some("{\"reason\":\"exposure_promotion\"}")
        );
        assert_eq!(
            mastery_event_count(&db, &a),
            before_events,
            "a Keep outcome must not write a mastery_events row"
        );
    }

    /// A `mastered` word answered Hard, with an interval still under the
    /// threshold, is not evidence of forgetting the word — only `Again` is.
    /// The tier must hold.
    #[test]
    fn a_hard_review_under_the_mastery_threshold_does_not_demote_a_mastered_word() {
        let (_dir, db, sync, a, _b, _other) = setup_sibling_db();
        seed_mastery(&db, &a, "mastered", "manual", None);

        // First-ever review: "hard" lands an even shorter interval than
        // "good" does.
        let reviewed = record_vocab_review_inner(&a, VocabReviewRating::Hard, &db, &sync).unwrap();

        assert!(
            reviewed.review_interval_days < 21,
            "test assumption broken: first-ever 'hard' review must land under \
             the mastery threshold, got {}",
            reviewed.review_interval_days
        );
        assert_eq!(reviewed.mastery, "mastered");
    }

    /// An interval that reaches the mastery threshold promotes the tier,
    /// and — unlike the Keep path — this is a real transition, so it must
    /// leave exactly one row on the timeline.
    #[test]
    fn a_review_that_reaches_the_mastery_threshold_promotes_to_mastered() {
        let (_dir, db, sync, a, b, _other) = setup_sibling_db();
        seed_mastery(&db, &a, "learning", "manual", None);
        // Seed FSRS state as if the card was last reviewed at the Unix
        // epoch: `now` (real wall-clock time) is decades later, so the
        // elapsed time alone drives the scheduler's interval for this
        // "good" rating well past 21 days.
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE vocab_words SET fsrs_stability = 1.0, fsrs_difficulty = 5.0, last_reviewed_at = 0 WHERE id = ?1",
                params![a],
            )
            .unwrap();
        let before_events = mastery_event_count(&db, &a);

        let reviewed = record_vocab_review_inner(&a, VocabReviewRating::Good, &db, &sync).unwrap();

        assert!(
            reviewed.review_interval_days >= 21,
            "test assumption broken: expected the seeded elapsed time to \
             produce a >=21-day interval, got {}",
            reviewed.review_interval_days
        );
        assert_eq!(reviewed.mastery, "mastered");
        assert_eq!(reviewed.mastery_source, "manual");
        assert_eq!(reviewed.mastery_reason, None);
        assert_eq!(stored_word(&db, &b).mastery, "mastered");
        assert_eq!(
            mastery_event_count(&db, &a),
            before_events + 1,
            "a Promote outcome must write exactly one mastery_events row"
        );
    }

    /// `Again` is the one rating that is real evidence of not knowing a
    /// word, so it demotes regardless of tier or interval — even a word the
    /// reading-exposure engine had raised to `familiar`.
    #[test]
    fn an_again_rating_always_demotes_to_learning() {
        let (_dir, db, sync, a, _b, _other) = setup_sibling_db();
        seed_mastery(
            &db,
            &a,
            "familiar",
            "auto",
            Some("{\"reason\":\"exposure_promotion\"}"),
        );

        let reviewed = record_vocab_review_inner(&a, VocabReviewRating::Again, &db, &sync).unwrap();

        assert_eq!(reviewed.mastery, "learning");
        assert_eq!(reviewed.mastery_source, "manual");
        assert_eq!(reviewed.mastery_reason, None);
    }

    // --- Observation zone (docs/impls/reading-flow-decisions-2026-08-06.md
    // §1 and §5) -------------------------------------------------------

    fn lookup(book_id: &str, word: &str, cfi: &str) -> crate::commands::lookup_history::LookupInput {
        crate::commands::lookup_history::LookupInput {
            book_id: book_id.to_string(),
            lookup_text: word.to_string(),
            context_sentence: None,
            chapter: None,
            cfi: Some(cfi.to_string()),
            definition: "a definition".to_string(),
            context_explanation: None,
            result_json: None,
            provider_profile_id: None,
            model: None,
        }
    }

    #[test]
    fn a_first_lookup_creates_a_watchlist_word_that_still_scores_mastery() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-watch");

        crate::commands::lookup_history::save_lookup_record_inner(
            lookup("book-watch", "Solitude", "epubcfi(/6/2)"),
            &db,
            &sync,
        )
        .unwrap();

        let words = query_vocab_words_including_watchlist(&db, "book-watch").unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].list_status, "watchlist");
        // Not shown as "already collected" — the reader never saved it.
        assert_eq!(
            check_vocab_exists_inner(&db, "book-watch", "Solitude").unwrap(),
            None
        );
    }

    #[test]
    fn a_3rd_cumulative_lookup_across_different_positions_promotes_the_word() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-watch");

        crate::commands::lookup_history::save_lookup_record_inner(
            lookup("book-watch", "Solitude", "epubcfi(/6/2)"),
            &db,
            &sync,
        )
        .unwrap();
        let after_two = {
            crate::commands::lookup_history::save_lookup_record_inner(
                lookup("book-watch", "Solitude", "epubcfi(/6/4)"),
                &db,
                &sync,
            )
            .unwrap();
            query_vocab_words_including_watchlist(&db, "book-watch").unwrap()
        };
        assert_eq!(after_two[0].list_status, "watchlist");

        // 3rd lookup, a 3rd different position — summed, not per-row.
        crate::commands::lookup_history::save_lookup_record_inner(
            lookup("book-watch", "Solitude", "epubcfi(/6/6)"),
            &db,
            &sync,
        )
        .unwrap();

        let words = query_vocab_words_including_watchlist(&db, "book-watch").unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].list_status, "confirmed");
        assert_eq!(
            check_vocab_exists_inner(&db, "book-watch", "Solitude")
                .unwrap()
                .as_deref(),
            Some(words[0].id.as_str())
        );

        let events =
            crate::commands::mastery_events::list_mastery_events_for(&db, &words[0].id).unwrap();
        let promotion = events
            .iter()
            .find(|e| e.reason == "watchlist_promoted")
            .expect("expected a watchlist_promoted mastery event");
        assert_eq!(promotion.source, "auto");
        let detail: serde_json::Value = serde_json::from_str(&promotion.detail).unwrap();
        assert_eq!(detail["lookup_count"], 3);
        assert_eq!(detail["book_title"], "Import Book");
    }

    #[test]
    fn manual_save_promotes_an_existing_watchlist_word_immediately() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-watch");

        crate::commands::lookup_history::save_lookup_record_inner(
            lookup("book-watch", "Solitude", "epubcfi(/6/2)"),
            &db,
            &sync,
        )
        .unwrap();
        let watchlisted = query_vocab_words_including_watchlist(&db, "book-watch").unwrap();
        assert_eq!(watchlisted[0].list_status, "watchlist");

        // The reader hits "收藏" (save) before ever hitting a 3rd lookup.
        let saved = add_vocab_word_inner(
            "book-watch",
            "Solitude",
            "a definition",
            None,
            None,
            None,
            None,
            &db,
            &sync,
        )
        .unwrap();

        assert_eq!(saved.id, watchlisted[0].id);
        assert_eq!(saved.list_status, "confirmed");
        let words = query_vocab_words_including_watchlist(&db, "book-watch").unwrap();
        assert_eq!(words.len(), 1, "must not create a second row for the same word");
        assert_eq!(words[0].list_status, "confirmed");
    }

    #[test]
    fn export_and_check_exists_both_ignore_watchlist_words() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-watch");
        add_vocab_word_inner(
            "book-watch",
            "Courage",
            "the ability to act",
            None,
            None,
            None,
            None,
            &db,
            &sync,
        )
        .unwrap();
        crate::commands::lookup_history::save_lookup_record_inner(
            lookup("book-watch", "Solitude", "epubcfi(/6/2)"),
            &db,
            &sync,
        )
        .unwrap();

        let backup = export_vocab_backup_inner(&db).unwrap();
        assert_eq!(backup.words.len(), 1);
        assert_eq!(backup.words[0].word, "Courage");

        assert!(check_vocab_exists_inner(&db, "book-watch", "Courage")
            .unwrap()
            .is_some());
        assert!(check_vocab_exists_inner(&db, "book-watch", "Solitude")
            .unwrap()
            .is_none());
    }

    // --- card_snapshot (migration 067) ---

    #[test]
    fn a_saved_card_snapshot_round_trips_through_the_dedicated_reader() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-a");
        let snapshot = r#"{"modules":{"word_info":{"summary":"clear"}}}"#.to_string();
        let saved = add_vocab_word_inner(
            "book-a",
            "lucid",
            "a definition",
            None,
            None,
            None,
            Some(snapshot.clone()),
            &db,
            &sync,
        )
        .unwrap();

        let read_back = get_vocab_card_snapshot_inner(&saved.id, &db).unwrap();
        assert_eq!(read_back, Some(snapshot));
    }

    #[test]
    fn a_null_snapshot_never_wipes_an_existing_one_on_the_watchlist_promotion_path() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-watch");

        // First save brings a snapshot while the word is still in the
        // observation zone from an earlier lookup.
        crate::commands::lookup_history::save_lookup_record_inner(
            lookup("book-watch", "Solitude", "epubcfi(/6/2)"),
            &db,
            &sync,
        )
        .unwrap();
        let snapshot = r#"{"modules":{"word_info":{"summary":"being alone"}}}"#.to_string();
        let first = add_vocab_word_inner(
            "book-watch",
            "Solitude",
            "a definition",
            None,
            None,
            None,
            Some(snapshot.clone()),
            &db,
            &sync,
        )
        .unwrap();
        assert_eq!(first.list_status, "confirmed");
        assert_eq!(
            get_vocab_card_snapshot_inner(&first.id, &db).unwrap(),
            Some(snapshot.clone())
        );

        // A second save of the same already-confirmed word with no snapshot
        // must not blank the one already stored. The existing word matches
        // the no-write branch, so nothing changes either way — this pins
        // that "no snapshot offered" is never mistaken for "erase it".
        add_vocab_word_inner(
            "book-watch",
            "Solitude",
            "a definition",
            None,
            None,
            None,
            None,
            &db,
            &sync,
        )
        .unwrap();
        assert_eq!(
            get_vocab_card_snapshot_inner(&first.id, &db).unwrap(),
            Some(snapshot)
        );
    }

    #[test]
    fn an_oversized_snapshot_is_stored_as_null_rather_than_truncated() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-a");
        let oversized = "x".repeat(MAX_CARD_SNAPSHOT_BYTES + 1);
        let saved = add_vocab_word_inner(
            "book-a",
            "lucid",
            "a definition",
            None,
            None,
            None,
            Some(oversized),
            &db,
            &sync,
        )
        .unwrap();

        assert_eq!(get_vocab_card_snapshot_inner(&saved.id, &db).unwrap(), None);
    }

    #[test]
    fn get_vocab_card_snapshot_is_none_when_the_row_never_had_one() {
        let (_dir, db, sync) = setup_import_db();
        insert_import_book(&db, "book-a");
        let saved = add_vocab_word_inner(
            "book-a", "lucid", "a definition", None, None, None, None, &db, &sync,
        )
        .unwrap();

        assert_eq!(get_vocab_card_snapshot_inner(&saved.id, &db).unwrap(), None);
    }
}

#[tauri::command]
pub fn get_vocab_stats(db: State<'_, Db>) -> AppResult<VocabStats> {
    query_vocab_stats(&db)
}
