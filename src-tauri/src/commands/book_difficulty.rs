//! Local book-difficulty preview: how much of this book's running text is
//! vocabulary the reader is unlikely to know.
//!
//! Design: `docs/impls/book-difficulty.md`. The answer is a distribution, not
//! a grade — every word of the book's text is mapped onto the five frequency
//! bands in [`crate::word_frequency`] plus a sixth "not in the table" bucket,
//! and that distribution is the conclusion. A CEFR-style label would be a
//! lossy summary of it.
//!
//! Three properties this module owes the rest of the app:
//!
//! - **No network, ever.** This is a table lookup over a local file. It reads
//!   the book through `ai::grounding::source`, which is pure parsing, and
//!   deliberately *not* through `book_chunks` — that table only exists for
//!   books whose owner turned on AI features, and difficulty has nothing to
//!   do with AI.
//! - **It never changes the reader's level setting.** Nothing here writes to
//!   `language_assessments` or to any setting. The UI states this out loud in
//!   every variant; the backend simply has no code that could.
//! - **No retries, no background sweeps.** A computation happens when a book
//!   finishes importing, or when the reader presses the button. A failure is
//!   recorded as a failure and left alone.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::grounding::extract::SectionText;
use crate::ai::grounding::source::{extract_source_text, resolve_readable_source, BookSource};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mastery::{median_words_per_minute, ScreenPace};
use crate::word_frequency::{lookup_with, FormIndex};

/// Below this many running words the band distribution is noise: a preface,
/// a sample chapter, or a stub is not enough text for percentages to mean
/// anything. The floor is on **tokens**, not distinct words.
///
/// A book under the floor stays under it — the trigger is import, and
/// recomputing reads the same file — so the UI says the file will not grow
/// rather than inviting the reader to check back later.
pub const MIN_TOKENS: i64 = 5_000;

/// The four judgments the reader can record over the automatic one. They
/// never replace the computed distribution — the UI shows both — and
/// `Hidden` only suppresses the conclusion line for this book.
const OVERRIDE_VALUES: [&str; 4] = ["easier", "matched", "harder", "hidden"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DifficultyStatus {
    /// Never computed, or queued. The UI's "not analyzed" state.
    Pending,
    Running,
    Done,
    Failed,
    /// Fewer than [`MIN_TOKENS`] running words.
    TooShort,
    /// No extractor can read this book's source format.
    Unsupported,
}

impl DifficultyStatus {
    fn as_db(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::TooShort => "too_short",
            Self::Unsupported => "unsupported",
        }
    }

    fn from_db(value: &str) -> Self {
        match value {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "too_short" => Self::TooShort,
            "unsupported" => Self::Unsupported,
            _ => Self::Pending,
        }
    }
}

/// One book's stored difficulty row, as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDifficulty {
    pub book_id: String,
    pub status: DifficultyStatus,
    /// Running words counted, i.e. the sum of the six buckets below.
    pub total_tokens: i64,
    /// Distinct word forms behind those tokens.
    pub distinct_words: i64,
    pub band1: i64,
    pub band2: i64,
    pub band3: i64,
    pub band4: i64,
    pub band5: i64,
    /// Tokens the frequency table has never heard of — names, invented
    /// words, foreign phrases. Kept out of band 5 on purpose: a novel's
    /// recurring character names are not rare vocabulary.
    pub band_unlisted: i64,
    pub source_sha256: Option<String>,
    /// RFC-3339 UTC. The column is TEXT (migration 041), unlike the
    /// millisecond integers most of this schema uses.
    pub computed_at: Option<String>,
    pub error: Option<String>,
    #[serde(rename = "override")]
    pub override_choice: Option<String>,
    /// The stored numbers were computed from a file that has since changed
    /// (re-import, OCR rerun). Never true for a row that carries no hash.
    pub stale: bool,
}

impl BookDifficulty {
    fn empty(book_id: &str, status: DifficultyStatus) -> Self {
        Self {
            book_id: book_id.to_string(),
            status,
            total_tokens: 0,
            distinct_words: 0,
            band1: 0,
            band2: 0,
            band3: 0,
            band4: 0,
            band5: 0,
            band_unlisted: 0,
            source_sha256: None,
            computed_at: None,
            error: None,
            override_choice: None,
            stale: false,
        }
    }
}

/// Running-word counts per band, before they become a stored row.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct BandTally {
    pub total_tokens: i64,
    pub distinct_words: i64,
    /// Index 0 is band 1.
    pub bands: [i64; 5],
    pub unlisted: i64,
}

impl BandTally {
    fn status(&self) -> DifficultyStatus {
        if self.total_tokens < MIN_TOKENS {
            DifficultyStatus::TooShort
        } else {
            DifficultyStatus::Done
        }
    }
}

/// Split text into countable words.
///
/// Unicode letter/digit runs, lowercased, with word-internal apostrophes
/// kept so `don't` stays one word instead of becoming `don` + `t` (which is
/// exactly what a `\w+` regex would do, and why there isn't one here). The
/// typographic apostrophe `’` is folded onto `'` so both spellings count as
/// the same word. Single characters and pure numbers are dropped: neither
/// says anything about vocabulary difficulty.
pub(crate) fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        if character.is_alphanumeric() {
            current.extend(character.to_lowercase());
        } else if character == '\'' || character == '\u{2019}' {
            current.push('\'');
        } else {
            flush_token(&mut tokens, &mut current);
        }
    }
    flush_token(&mut tokens, &mut current);
    tokens
}

fn flush_token(tokens: &mut Vec<String>, current: &mut String) {
    let token = current.trim_matches('\'');
    if token.chars().count() > 1 && !token.chars().all(char::is_numeric) {
        tokens.push(token.to_string());
    }
    current.clear();
}

/// Count every token once, keyed by form. Counting first and looking up
/// second means the frequency table is consulted per *distinct* word rather
/// than per occurrence — for a novel that is tens of thousands of lookups
/// instead of hundreds of thousands.
pub(crate) fn count_words<'a>(texts: impl IntoIterator<Item = &'a str>) -> HashMap<String, i64> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for text in texts {
        for token in tokenize(text) {
            *counts.entry(token).or_insert(0) += 1;
        }
    }
    counts
}

/// Fold per-word counts onto the six buckets.
///
/// One [`FormIndex`] is built for the whole book: it is what lets `running`
/// find `run`, and rebuilding it per word would mean a full scan of
/// `word_forms` per word.
pub(crate) fn accumulate(db: &Db, counts: &HashMap<String, i64>) -> AppResult<BandTally> {
    accumulate_with(&FormIndex::new(db), counts)
}

/// [`accumulate`], reusing one [`FormIndex`] across a batch of tallies.
///
/// [`write_sections`] calls this once per section with the *same* index —
/// building a fresh `FormIndex` per section would repeat its lazy
/// `word_forms` scan on the first miss of every section instead of once for
/// the whole book.
fn accumulate_with(forms: &FormIndex, counts: &HashMap<String, i64>) -> AppResult<BandTally> {
    let mut tally = BandTally::default();
    for (word, count) in counts {
        tally.total_tokens += count;
        tally.distinct_words += 1;
        match lookup_with(forms, word)? {
            Some(entry) => {
                let slot = usize::from(entry.band.clamp(1, 5)) - 1;
                tally.bands[slot] += count;
            }
            None => tally.unlisted += count,
        }
    }
    Ok(tally)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn store(
    db: &Db,
    book_id: &str,
    status: DifficultyStatus,
    tally: &BandTally,
    source_sha256: Option<&str>,
    error: Option<&str>,
) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    // `override` is deliberately absent from the update list: it is the
    // reader's own judgment and survives every recomputation.
    conn.execute(
        "INSERT INTO book_difficulty (
             book_id, status, total_tokens, distinct_words,
             band1, band2, band3, band4, band5, band_unlisted,
             source_sha256, computed_at, error
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(book_id) DO UPDATE SET
             status = excluded.status, total_tokens = excluded.total_tokens,
             distinct_words = excluded.distinct_words, band1 = excluded.band1,
             band2 = excluded.band2, band3 = excluded.band3, band4 = excluded.band4,
             band5 = excluded.band5, band_unlisted = excluded.band_unlisted,
             source_sha256 = excluded.source_sha256, computed_at = excluded.computed_at,
             error = excluded.error",
        params![
            book_id,
            status.as_db(),
            tally.total_tokens,
            tally.distinct_words,
            tally.bands[0],
            tally.bands[1],
            tally.bands[2],
            tally.bands[3],
            tally.bands[4],
            tally.unlisted,
            source_sha256,
            now_rfc3339(),
            error,
        ],
    )?;
    Ok(())
}

/// Replace a book's per-section rows (migration 057) with the sections just
/// walked to build the aggregate above. Always a full delete-then-insert: a
/// recompute can find a different section count than last time (re-import, a
/// different chapter split), and a partial upsert keyed on `section_order`
/// would leave stale rows past the true end of a book that got shorter.
///
/// PDF is skipped outright, after the delete runs: `extract_pdf` yields one
/// "section" per *page*, not per chapter, titled with a machine label ("Page
/// 12") that `chapter_title` exists to refuse — see the migration's own
/// comment. The whole-book row `store` already wrote is PDF's only
/// difficulty data.
///
/// Best-effort from every caller's point of view: this never runs before the
/// aggregate row is already committed, and a caller that fails here logs and
/// moves on rather than propagating — an interrupted section write must not
/// turn an otherwise-successful `compute_and_store` into a recorded failure.
pub(crate) fn write_sections(
    db: &Db,
    book_id: &str,
    format: &str,
    sections: &[SectionText],
    source_sha256: Option<&str>,
) -> AppResult<()> {
    let mut conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM book_difficulty_sections WHERE book_id = ?1",
        params![book_id],
    )?;
    if format != "pdf" {
        // One FormIndex for every section in this book: its lazy
        // `word_forms` scan then runs at most once per call, not once per
        // section.
        let forms = FormIndex::new(db);
        let now = now_rfc3339();
        for (order, section) in sections.iter().enumerate() {
            let counts = count_words(section.blocks.iter().map(|block| block.text.as_str()));
            let tally = accumulate_with(&forms, &counts)?;
            tx.execute(
                "INSERT INTO book_difficulty_sections (
                     book_id, section_order, chapter_title, total_tokens,
                     band1, band2, band3, band4, band5, band_unlisted,
                     source_sha256, computed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    book_id,
                    order as i64,
                    section.section_title,
                    tally.total_tokens,
                    tally.bands[0],
                    tally.bands[1],
                    tally.bands[2],
                    tally.bands[3],
                    tally.bands[4],
                    tally.unlisted,
                    source_sha256,
                    now,
                ],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Drop a book's per-section rows without touching `book_difficulty` itself.
/// Called wherever the aggregate row is about to say "unsupported" or
/// "failed" — a section breakdown that no longer sums to the (now zeroed)
/// aggregate would be a stale contradiction sitting in the new table.
fn clear_sections(db: &Db, book_id: &str) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "DELETE FROM book_difficulty_sections WHERE book_id = ?1",
        params![book_id],
    )?;
    Ok(())
}

fn mark_running(db: &Db, book_id: &str) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "INSERT INTO book_difficulty (book_id, status) VALUES (?1, 'running')
         ON CONFLICT(book_id) DO UPDATE SET status = 'running', error = NULL",
        params![book_id],
    )?;
    Ok(())
}

fn read_row(db: &Db, book_id: &str) -> AppResult<Option<BookDifficulty>> {
    let conn = db.reader();
    let row = conn
        .query_row(
            "SELECT status, total_tokens, distinct_words, band1, band2, band3, band4, band5,
                    band_unlisted, source_sha256, computed_at, error, override
             FROM book_difficulty WHERE book_id = ?1",
            params![book_id],
            |row| {
                Ok(BookDifficulty {
                    book_id: book_id.to_string(),
                    status: DifficultyStatus::from_db(&row.get::<_, String>(0)?),
                    total_tokens: row.get(1)?,
                    distinct_words: row.get(2)?,
                    band1: row.get(3)?,
                    band2: row.get(4)?,
                    band3: row.get(5)?,
                    band4: row.get(6)?,
                    band5: row.get(7)?,
                    band_unlisted: row.get(8)?,
                    source_sha256: row.get(9)?,
                    computed_at: row.get(10)?,
                    error: row.get(11)?,
                    override_choice: row.get(12)?,
                    stale: false,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// Read the stored row and tell the caller whether it still describes the
/// file on disk. A book with no row reads as [`DifficultyStatus::Pending`] —
/// "never analyzed" and "queued" are the same thing to the UI, which offers
/// the same button for both.
pub fn load(db: &Db, book_id: &str) -> AppResult<BookDifficulty> {
    let Some(mut row) = read_row(db, book_id)? else {
        return Ok(BookDifficulty::empty(book_id, DifficultyStatus::Pending));
    };
    if let Some(stored) = row.source_sha256.as_deref() {
        let current = crate::ai::grounding::index::current_source_sha256(db, book_id)?;
        row.stale = current.as_deref() != Some(stored);
    }
    Ok(row)
}

/// Read the book and write the result. Synchronous and self-contained: the
/// callers below run it on a blocking thread.
///
/// `pub(crate)` rather than private so `book_difficulty_backfill`'s tests can
/// call it directly to set up a "computed before migration 057" fixture
/// without going through the async `AppHandle`-based command below.
pub(crate) fn compute_and_store(db: &Db, book_id: &str) -> AppResult<BookDifficulty> {
    let source = match resolve_readable_source(db, book_id)? {
        BookSource::Missing => return Err(AppError::Other("BOOK_NOT_FOUND".to_string())),
        BookSource::Unsupported { .. } => {
            store(
                db,
                book_id,
                DifficultyStatus::Unsupported,
                &BandTally::default(),
                None,
                None,
            )?;
            if let Err(error) = clear_sections(db, book_id) {
                log::warn!(
                    "book difficulty: could not clear stale section data for {book_id}: {error}"
                );
            }
            return load(db, book_id);
        }
        BookSource::Ready(source) => source,
    };

    let sections = extract_source_text(db, book_id, &source)?;
    let counts = count_words(
        sections
            .iter()
            .flat_map(|section| section.blocks.iter())
            .map(|block| block.text.as_str()),
    );
    let tally = accumulate(db, &counts)?;
    store(
        db,
        book_id,
        tally.status(),
        &tally,
        source.sha256.as_deref(),
        None,
    )?;
    if let Err(error) = write_sections(
        db,
        book_id,
        &source.format,
        &sections,
        source.sha256.as_deref(),
    ) {
        log::warn!("book difficulty: could not store per-section data for {book_id}: {error}");
    }
    load(db, book_id)
}

/// Record a failure verbatim. No retry: a second automatic attempt would hit
/// the same missing file or the same unparsable PDF, and the UI has a state
/// for a failure but none for "trying again quietly".
fn record_failure(db: &Db, book_id: &str, message: &str) -> BookDifficulty {
    if let Err(error) = store(
        db,
        book_id,
        DifficultyStatus::Failed,
        &BandTally::default(),
        None,
        Some(message),
    ) {
        log::warn!("book difficulty: could not record failure for {book_id}: {error}");
    }
    if let Err(error) = clear_sections(db, book_id) {
        log::warn!("book difficulty: could not clear stale section data for {book_id}: {error}");
    }
    let mut row = load(db, book_id)
        .unwrap_or_else(|_| BookDifficulty::empty(book_id, DifficultyStatus::Failed));
    row.status = DifficultyStatus::Failed;
    row.error = Some(message.to_string());
    row
}

fn event_name(book_id: &str) -> String {
    format!("book-difficulty-{book_id}")
}

fn spawn_computation(app: AppHandle, db: Db, book_id: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let result = match compute_and_store(&db, &book_id) {
            Ok(row) => row,
            Err(error) => {
                let message = error.to_string();
                log::warn!("book difficulty failed for {book_id}: {message}");
                record_failure(&db, &book_id, &message)
            }
        };
        let _ = app.emit(&event_name(&book_id), result);
    });
}

/// Queue a computation for a book that just finished importing.
///
/// Import is already doing heavy work, and one more full-text pass does not
/// change how long it feels — while paying for it here is what makes the
/// details page open instantly later. This is the *only* automatic trigger:
/// no scan on open, no timer, no startup backfill.
pub fn schedule_book_difficulty(app: AppHandle, book_id: String) {
    let db = app.state::<Db>().inner().clone();
    if let Err(error) = mark_running(&db, &book_id) {
        log::warn!("book difficulty: could not queue {book_id}: {error}");
        return;
    }
    spawn_computation(app, db, book_id);
}

#[tauri::command]
pub fn get_book_difficulty(book_id: String, db: State<'_, Db>) -> AppResult<BookDifficulty> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    load(&db, &book_id)
}

/// Start a computation and return immediately. The result arrives on
/// `book-difficulty-{book_id}` as a full [`BookDifficulty`], which is what
/// turns the UI's "analyzing" state into a finished one.
#[tauri::command]
pub fn compute_book_difficulty(
    book_id: String,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    let db = db.inner().clone();
    mark_running(&db, &book_id)?;
    spawn_computation(app, db, book_id);
    Ok(())
}

/// Record — or clear, with `None` — the reader's own judgment. The computed
/// distribution stays visible underneath it; this is an annotation, not a
/// replacement.
#[tauri::command]
pub fn set_book_difficulty_override(
    book_id: String,
    value: Option<String>,
    db: State<'_, Db>,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    if let Some(value) = value.as_deref() {
        if !OVERRIDE_VALUES.contains(&value) {
            return Err(AppError::Other(
                "BOOK_DIFFICULTY_OVERRIDE_INVALID".to_string(),
            ));
        }
    }
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "INSERT INTO book_difficulty (book_id, status, override) VALUES (?1, 'pending', ?2)
         ON CONFLICT(book_id) DO UPDATE SET override = excluded.override",
        params![book_id, value],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Open-card queries (docs/impls/book-open-card-mockup.html). Read-only
// additions for the card that appears before a book is opened: everything
// below reads existing tables and writes nothing. The card's own combining
// arithmetic (band share × (1 − pass rate), rounding to a whole percent,
// peak-vs-flat on the ridge) lives in the frontend's pure `open-card-view.ts`
// so it stays unit-testable without a database — these commands hand it raw
// per-band and per-section facts, the same split `BookDifficulty` and
// `difficulty-view.ts` already use for the whole-book verdict.
// ---------------------------------------------------------------------------

/// Same floor `level_observation.rs` already uses for "is there enough of
/// this reader's own record to say anything" — duplicated rather than
/// imported, since that module's `RecordSummary`/`collect`/`score` are
/// private and re-exporting them would couple two features that only happen
/// to read the same two tables (`lookup_records`, `reading_word_exposures`).
/// If that floor ever moves, this one should move with it by hand, not by
/// accident.
const PASS_RATE_WINDOW_DAYS: i64 = 90;
/// Mirrors `level_observation::MIN_SCORABLE_LOOKUPS`. The open card's "not
/// enough of your record yet" state (mockup §2a) names this exact number, so
/// it has to be the same 12, not a second opinion next to the reading-stats
/// page's 12.
const PASS_RATE_MIN_SCORABLE_LOOKUPS: i64 = 12;
/// Mirrors `level_observation::MIN_SPAN_DAYS`.
const PASS_RATE_MIN_SPAN_DAYS: i64 = 14;
const PASS_RATE_DAY_MS: i64 = 86_400_000;

/// The reader's empirical pass rate, one value per frequency band: of the
/// words in that band the reader has evidence about — looked up, or read
/// past twice or more on a screen where the dictionary was in use — what
/// share were read past rather than looked up.
///
/// Index 0 is band 1. A band the reader has no evidence for at all is `None`
/// — an undefined rate, not a zero one; the open card's combining formula
/// treats a missing band as "no evidence this was known" (§8: conservative
/// direction), which is a frontend judgment, not this struct's.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabPassRates {
    pub band_pass_rates: [Option<f64>; 5],
    pub scorable_lookups: i64,
    pub span_days: i64,
    /// `scorable_lookups >= 12 && span_days >= 14`, the same two-sided floor
    /// `level_observation.rs` already enforces (a busy afternoon alone should
    /// not count as evidence). `false` is the open card's §2a state: the book
    /// side of the arithmetic is complete but the reader side is not, so the
    /// card drops the "for you" line rather than compute one on too little.
    pub sufficient: bool,
}

pub(crate) fn compute_vocab_pass_rates(db: &Db, now: i64) -> AppResult<VocabPassRates> {
    let since = now - PASS_RATE_WINDOW_DAYS * PASS_RATE_DAY_MS;

    // Read everything needed first, and drop the guard before touching
    // `FormIndex` — it takes `db.reader()` itself on its first miss, and
    // `std::sync::Mutex` is not reentrant. Same split `level_observation.rs`
    // uses for exactly this reason.
    let (ever_looked_up, window_lookups, passed_candidates) = {
        let conn = db.reader();

        let mut ever_looked_up: HashSet<String> = HashSet::new();
        {
            let mut stmt = conn.prepare("SELECT DISTINCT normalized_text FROM lookup_records")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for word in rows {
                ever_looked_up.insert(word?);
            }
        }

        let mut window_lookups: Vec<(String, i64)> = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT normalized_text, last_looked_up_at FROM lookup_records \
                 WHERE last_looked_up_at >= ?1",
            )?;
            let rows = stmt.query_map(params![since], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows {
                window_lookups.push(row?);
            }
        }

        let mut passed_candidates: Vec<String> = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT normalized_word, SUM(encounter_count), SUM(encounters_on_lookup_active_screen) \
                 FROM reading_word_exposures WHERE last_seen_at >= ?1 GROUP BY normalized_word",
            )?;
            let rows = stmt.query_map(params![since], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (word, encounters, on_lookup_active) = row?;
                if encounters < 2 || on_lookup_active < 1 || ever_looked_up.contains(&word) {
                    continue;
                }
                passed_candidates.push(word);
            }
        }

        (ever_looked_up, window_lookups, passed_candidates)
    };
    let _ = &ever_looked_up; // kept alive only for the block above; silences an unused-after-move lint on some toolchains.

    let forms = FormIndex::new(db);
    let mut lookups_by_band = [0i64; 6];
    let mut looked_up_words_by_band = [0i64; 6];
    let mut passed_by_band = [0i64; 6];
    let mut oldest_lookup: Option<i64> = None;
    let mut distinct_looked_up: HashMap<String, u8> = HashMap::new();
    for (word, at) in &window_lookups {
        let Some(entry) = lookup_with(&forms, word)? else {
            continue;
        };
        lookups_by_band[entry.band as usize] += 1;
        distinct_looked_up.insert(word.clone(), entry.band);
        oldest_lookup = Some(oldest_lookup.map_or(*at, |current: i64| current.min(*at)));
    }
    for band in distinct_looked_up.values() {
        looked_up_words_by_band[*band as usize] += 1;
    }
    for word in &passed_candidates {
        if let Some(entry) = lookup_with(&forms, word)? {
            passed_by_band[entry.band as usize] += 1;
        }
    }

    let span_days = match oldest_lookup {
        Some(oldest) => ((now - oldest) / PASS_RATE_DAY_MS + 1).clamp(1, PASS_RATE_WINDOW_DAYS),
        None => 0,
    };
    let scorable_lookups: i64 = lookups_by_band.iter().sum();
    let sufficient = scorable_lookups >= PASS_RATE_MIN_SCORABLE_LOOKUPS
        && span_days >= PASS_RATE_MIN_SPAN_DAYS;

    let mut band_pass_rates: [Option<f64>; 5] = [None; 5];
    for band in 1..=5usize {
        let passed = passed_by_band[band];
        let looked_up = looked_up_words_by_band[band];
        let denominator = passed + looked_up;
        if denominator > 0 {
            band_pass_rates[band - 1] = Some(passed as f64 / denominator as f64);
        }
    }

    Ok(VocabPassRates {
        band_pass_rates,
        scorable_lookups,
        span_days,
        sufficient,
    })
}

/// The reader's empirical pass rate by frequency band, over their whole
/// lookup record — not scoped to one book, because it is a fact about the
/// reader, the same way `level_observation.rs`'s record is. The open card
/// multiplies this against a book's own band distribution to get that book's
/// weighted "unfamiliar" share.
#[tauri::command]
pub fn get_vocab_pass_rates(db: State<'_, Db>) -> AppResult<VocabPassRates> {
    compute_vocab_pass_rates(&db, chrono::Utc::now().timestamp_millis())
}

/// One book's per-section band tallies, in `section_order`. Empty for a book
/// with no rows yet — either a PDF (which never gets any, see
/// [`write_sections`]) or an older book still waiting on
/// `book_difficulty_backfill`; telling those two apart needs the whole-book
/// row and the book's format, which the frontend already has.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookDifficultySection {
    pub section_order: i64,
    /// `None` when this section doesn't map onto a table-of-contents entry a
    /// reader would recognize — already decided at write time by
    /// [`write_sections`], not re-derived here.
    pub chapter_title: Option<String>,
    pub total_tokens: i64,
    pub band4: i64,
    pub band5: i64,
}

/// A book's per-section difficulty rows, for the "which chapter is hardest"
/// ridge chart. Read-only mirror of [`write_sections`]'s table; computes
/// nothing — peak-vs-flat and the relative bar heights are the frontend's
/// `open-card-view.ts`, over exactly these fields, so that logic can be unit
/// tested without a database.
pub(crate) fn load_difficulty_sections(
    db: &Db,
    book_id: &str,
) -> AppResult<Vec<BookDifficultySection>> {
    let conn = db.reader();
    let mut statement = conn.prepare(
        "SELECT section_order, chapter_title, total_tokens, band4, band5
         FROM book_difficulty_sections WHERE book_id = ?1 ORDER BY section_order",
    )?;
    let rows = statement
        .query_map(params![book_id], |row| {
            Ok(BookDifficultySection {
                section_order: row.get(0)?,
                chapter_title: row.get(1)?,
                total_tokens: row.get(2)?,
                band4: row.get(3)?,
                band5: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn get_book_difficulty_sections(
    book_id: String,
    db: State<'_, Db>,
) -> AppResult<Vec<BookDifficultySection>> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    load_difficulty_sections(&db, &book_id)
}

/// Distinct words looked up in one book, and how many of those have since
/// been promoted to `familiar` or better.
///
/// The one place on the open card a specific count survives (mockup §8):
/// both numbers describe something that already happened — work the reader
/// already did — not a prediction of work ahead, which is the distinction
/// the rest of this feature draws its "no precise numbers" line around.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookLookupStats {
    pub looked_up_words: i64,
    pub mastered_words: i64,
}

pub(crate) fn load_book_lookup_stats(db: &Db, book_id: &str) -> AppResult<BookLookupStats> {
    let conn = db.reader();
    let looked_up_words: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT normalized_text) FROM lookup_records WHERE book_id = ?1",
        params![book_id],
        |row| row.get(0),
    )?;
    let mastered_words: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE book_id = ?1 AND mastery IN ('familiar', 'mastered')",
        params![book_id],
        |row| row.get(0),
    )?;
    Ok(BookLookupStats {
        looked_up_words,
        mastered_words,
    })
}

#[tauri::command]
pub fn get_book_lookup_stats(book_id: String, db: State<'_, Db>) -> AppResult<BookLookupStats> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    load_book_lookup_stats(&db, &book_id)
}

/// How many of the reader's most recent measurable screens a pace figure is
/// drawn from. Mirrors `reading_behavior::MEDIAN_PACE_SAMPLE` — same
/// reasoning (bounded so the query cost never grows with how long someone
/// has owned the app), kept as its own constant because that one is private
/// and the two features may tune independently.
const PACE_SAMPLE: i64 = 500;

/// The reader's reading speed, in and out of this book. Both are medians
/// over `reading_screen_dwells`, differing only in whether the query is
/// scoped to one `book_id` — see `reading_behavior::reader_median_wpm`,
/// which this mirrors rather than calls (that helper takes a transaction;
/// this only ever needs a read).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPace {
    /// `None` before this book has enough of its own measurable history.
    pub book_words_per_minute: Option<f64>,
    /// The same median across every book — what the open card cites before a
    /// book has ever been opened, when there is no book-specific figure yet.
    pub overall_words_per_minute: Option<f64>,
}

fn median_wpm_query(conn: &rusqlite::Connection, book_id: Option<&str>) -> AppResult<Option<f64>> {
    let screens: Vec<ScreenPace> = match book_id {
        Some(book_id) => {
            let mut stmt = conn.prepare(
                "SELECT word_count, dwell_ms FROM reading_screen_dwells
                  WHERE book_id = ?1 AND word_count > 0 AND dwell_ms > 0
                  ORDER BY started_at DESC LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![book_id, PACE_SAMPLE], |row| {
                    Ok(ScreenPace {
                        word_count: row.get(0)?,
                        dwell_ms: row.get(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT word_count, dwell_ms FROM reading_screen_dwells
                  WHERE word_count > 0 AND dwell_ms > 0
                  ORDER BY started_at DESC LIMIT ?1",
            )?;
            let rows = stmt
                .query_map(params![PACE_SAMPLE], |row| {
                    Ok(ScreenPace {
                        word_count: row.get(0)?,
                        dwell_ms: row.get(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        }
    };
    Ok(median_words_per_minute(&screens))
}

pub(crate) fn load_reading_pace(db: &Db, book_id: &str) -> AppResult<ReadingPace> {
    let conn = db.reader();
    let book_words_per_minute = median_wpm_query(&conn, Some(book_id))?;
    let overall_words_per_minute = median_wpm_query(&conn, None)?;
    Ok(ReadingPace {
        book_words_per_minute,
        overall_words_per_minute,
    })
}

#[tauri::command]
pub fn get_reading_pace(book_id: String, db: State<'_, Db>) -> AppResult<ReadingPace> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    load_reading_pace(&db, &book_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::grounding::extract::BlockText;
    use tempfile::TempDir;

    fn test_db() -> (TempDir, Db) {
        let directory = TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        (directory, db)
    }

    fn insert_book(db: &Db, sha: &str) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (
                     id, title, author, file_path, source_format, render_format,
                     source_file_path, source_sha256, status, progress, created_at, updated_at
                 ) VALUES ('book', 'Book', 'Author', 'books/book.epub', 'epub', 'epub',
                           'books/book.epub', ?1, 'unread', 0, 1, 1)",
                params![sha],
            )
            .unwrap();
    }

    #[test]
    fn an_apostrophe_stays_inside_the_word() {
        assert_eq!(
            tokenize("Don't — it’s the dog's."),
            vec!["don't", "it's", "the", "dog's"]
        );
    }

    #[test]
    fn single_characters_and_bare_numbers_are_dropped() {
        // "a" and "I" are single characters; "1984" is a bare number.
        // "1980s" survives because it is not purely numeric.
        assert_eq!(
            tokenize("I read a book in 1984, the 1980s."),
            vec!["read", "book", "in", "the", "1980s"]
        );
    }

    #[test]
    fn tokens_are_lowercased_and_split_on_non_letters() {
        assert_eq!(
            tokenize("Well-known\tCAFÉ\nnaïve;résumé"),
            vec!["well", "known", "café", "naïve", "résumé"]
        );
    }

    #[test]
    fn leading_and_trailing_apostrophes_are_not_part_of_the_word() {
        assert_eq!(tokenize("''tis 'em dogs' ' '"), vec!["tis", "em", "dogs"]);
    }

    #[test]
    fn counting_is_by_occurrence_and_dedupes_forms() {
        let counts = count_words(["the cat sat on the mat", "THE end"]);
        assert_eq!(counts.get("the"), Some(&3));
        assert_eq!(counts.get("cat"), Some(&1));
    }

    #[test]
    fn bands_accumulate_running_words_not_distinct_ones() {
        let (_dir, db) = test_db();
        let mut counts = HashMap::new();
        // "the" is band 1; "gallop" is band 4 (see word_frequency tests).
        counts.insert("the".to_string(), 900_i64);
        counts.insert("gallop".to_string(), 7_i64);
        let tally = accumulate(&db, &counts).unwrap();
        assert_eq!(tally.bands[0], 900);
        assert_eq!(tally.bands[3], 7);
        assert_eq!(tally.total_tokens, 907);
        assert_eq!(tally.distinct_words, 2);
        assert_eq!(tally.unlisted, 0);
    }

    /// Words the table has never seen get their own bucket. Folding them
    /// into band 5 would make every novel with a named protagonist look
    /// harder than it is.
    #[test]
    fn unknown_words_land_in_their_own_bucket_not_band_five() {
        let (_dir, db) = test_db();
        let mut counts = HashMap::new();
        counts.insert("zzyzxqqq".to_string(), 40_i64);
        let tally = accumulate(&db, &counts).unwrap();
        assert_eq!(tally.unlisted, 40);
        assert_eq!(tally.bands[4], 0);
        assert_eq!(tally.total_tokens, 40);
    }

    /// A miss on the exact spelling still finds the lexeme through
    /// `word_forms`, so an inflected form does not silently become
    /// "unlisted".
    #[test]
    fn an_inflected_form_reaches_its_lemma_through_word_forms() {
        let (_dir, db) = test_db();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO word_forms(normalized_word, forms, source, updated_at)
                 VALUES ('gallop', ?1, 'model', 1)",
                params![serde_json::to_string(&["gallop", "gallopingest"]).unwrap()],
            )
            .unwrap();
        let mut counts = HashMap::new();
        counts.insert("gallopingest".to_string(), 3_i64);
        let tally = accumulate(&db, &counts).unwrap();
        assert_eq!(tally.bands[3], 3);
        assert_eq!(tally.unlisted, 0);
    }

    #[test]
    fn the_sample_floor_is_on_tokens() {
        let mut tally = BandTally {
            total_tokens: MIN_TOKENS - 1,
            distinct_words: 4_000,
            ..BandTally::default()
        };
        assert_eq!(tally.status(), DifficultyStatus::TooShort);
        tally.total_tokens = MIN_TOKENS;
        assert_eq!(tally.status(), DifficultyStatus::Done);
    }

    #[test]
    fn a_stored_row_goes_stale_when_the_source_hash_moves() {
        let (_dir, db) = test_db();
        insert_book(&db, "source-a");
        let tally = BandTally {
            total_tokens: 10_000,
            distinct_words: 2_000,
            bands: [8_000, 1_000, 500, 300, 100],
            unlisted: 100,
        };
        store(
            &db,
            "book",
            DifficultyStatus::Done,
            &tally,
            Some("source-a"),
            None,
        )
        .unwrap();

        let fresh = load(&db, "book").unwrap();
        assert_eq!(fresh.status, DifficultyStatus::Done);
        assert_eq!(fresh.total_tokens, 10_000);
        assert_eq!(fresh.band_unlisted, 100);
        assert!(!fresh.stale);

        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE books SET source_sha256 = 'source-b' WHERE id = 'book'",
                [],
            )
            .unwrap();
        let stale = load(&db, "book").unwrap();
        assert!(stale.stale);
        // The numbers stay readable; only the freshness flag changes.
        assert_eq!(stale.total_tokens, 10_000);
    }

    /// End to end over a real EPUB: resolve the source, parse it, tokenize,
    /// tally, store. The fixture is a one-chapter book, so the floor is what
    /// it lands on — which is the point, since that is the path a sample or
    /// a preface takes.
    #[test]
    fn a_real_epub_runs_through_extraction_and_lands_on_the_floor() {
        let (directory, db) = test_db();
        let books_dir = directory.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/fixtures/reader-compat/minimal-deflated.epub"
            ),
            books_dir.join("book.epub"),
        )
        .unwrap();
        insert_book(&db, "");

        let row = compute_and_store(&db, "book").unwrap();
        assert_eq!(row.status, DifficultyStatus::TooShort);
        assert!(row.total_tokens > 0, "the chapter has words in it");
        assert!(row.total_tokens < MIN_TOKENS);
        assert_eq!(
            row.total_tokens,
            row.band1 + row.band2 + row.band3 + row.band4 + row.band5 + row.band_unlisted,
            "the six buckets must account for every token"
        );
        assert!(row.distinct_words > 0 && row.distinct_words <= row.total_tokens);
        // No stored hash on the row, so one was computed from the file.
        assert!(row.source_sha256.is_some());
        assert!(row.computed_at.is_some());
        assert!(!row.stale);
        assert_eq!(row.error, None);
    }

    #[test]
    fn a_book_with_no_row_reads_as_pending() {
        let (_dir, db) = test_db();
        insert_book(&db, "source-a");
        let row = load(&db, "book").unwrap();
        assert_eq!(row.status, DifficultyStatus::Pending);
        assert_eq!(row.total_tokens, 0);
        assert!(!row.stale);
    }

    #[test]
    fn recomputing_keeps_the_readers_own_judgment() {
        let (_dir, db) = test_db();
        insert_book(&db, "source-a");
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO book_difficulty (book_id, status, override)
                 VALUES ('book', 'pending', 'harder')",
                [],
            )
            .unwrap();
        store(
            &db,
            "book",
            DifficultyStatus::Done,
            &BandTally {
                total_tokens: 9_000,
                ..BandTally::default()
            },
            Some("source-a"),
            None,
        )
        .unwrap();
        let row = load(&db, "book").unwrap();
        assert_eq!(row.override_choice.as_deref(), Some("harder"));
        assert_eq!(row.status, DifficultyStatus::Done);
    }

    #[test]
    fn the_serialized_shape_is_what_the_frontend_reads() {
        let mut row = BookDifficulty::empty("book", DifficultyStatus::TooShort);
        row.band_unlisted = 12;
        row.override_choice = Some("hidden".to_string());
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["status"], "too_short");
        assert_eq!(json["bookId"], "book");
        assert_eq!(json["bandUnlisted"], 12);
        assert_eq!(json["totalTokens"], 0);
        assert_eq!(json["override"], "hidden");
        assert_eq!(json["sourceSha256"], serde_json::Value::Null);
    }

    // --- per-section rows (migration 057) ---

    /// Builds a three-section EPUB exercising every `chapter_title` outcome
    /// `write_sections` can produce: a TOC-matched title, a heading fallback
    /// for a spine item the TOC never mentions, and a section with neither —
    /// which must store NULL rather than inventing a label.
    fn write_three_section_epub(path: &std::path::Path) {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        let files = [
            ("mimetype", "application/epub+zip"),
            (
                "META-INF/container.xml",
                "<?xml version=\"1.0\"?><container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\" version=\"1.0\"><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>",
            ),
            (
                "OEBPS/content.opf",
                "<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" version=\"2.0\" unique-identifier=\"id\"><metadata><dc:identifier id=\"id\">test</dc:identifier><dc:title>Test</dc:title></metadata><manifest><item id=\"c1\" href=\"one.xhtml\" media-type=\"application/xhtml+xml\"/><item id=\"c2\" href=\"two.xhtml\" media-type=\"application/xhtml+xml\"/><item id=\"c3\" href=\"three.xhtml\" media-type=\"application/xhtml+xml\"/><item id=\"toc\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/></manifest><spine toc=\"toc\"><itemref idref=\"c1\"/><itemref idref=\"c2\"/><itemref idref=\"c3\"/></spine></package>",
            ),
            (
                "OEBPS/toc.ncx",
                "<?xml version=\"1.0\"?><ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\"><navMap><navPoint id=\"n1\" playOrder=\"1\"><navLabel><text>Chapter One</text></navLabel><content src=\"one.xhtml\"/></navPoint></navMap></ncx>",
            ),
            (
                "OEBPS/one.xhtml",
                "<html><body><p>The first chapter has a title straight from the table of contents.</p></body></html>",
            ),
            (
                "OEBPS/two.xhtml",
                "<html><body><h2>Twist Ending</h2><p>This section is not in the nav map at all.</p></body></html>",
            ),
            (
                "OEBPS/three.xhtml",
                "<html><body><p>Front matter with neither a nav entry nor a heading of its own.</p></body></html>",
            ),
        ];
        for (name, contents) in files {
            zip.start_file(name, options).unwrap();
            zip.write_all(contents.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    struct SectionRow {
        order: i64,
        title: Option<String>,
        tokens: i64,
        bands: [i64; 5],
        unlisted: i64,
        sha: Option<String>,
    }

    fn section_rows(db: &Db, book_id: &str) -> Vec<SectionRow> {
        let conn = db.reader();
        let mut statement = conn
            .prepare(
                "SELECT section_order, chapter_title, total_tokens,
                        band1, band2, band3, band4, band5, band_unlisted, source_sha256
                 FROM book_difficulty_sections WHERE book_id = ?1 ORDER BY section_order",
            )
            .unwrap();
        statement
            .query_map(params![book_id], |row| {
                Ok(SectionRow {
                    order: row.get(0)?,
                    title: row.get(1)?,
                    tokens: row.get(2)?,
                    bands: [
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ],
                    unlisted: row.get(8)?,
                    sha: row.get(9)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    /// The three `chapter_title` outcomes side by side, and the invariant the
    /// whole feature exists to keep: the per-section numbers sum to exactly
    /// the aggregate row they were folded into, because both are computed
    /// from the same walk over the same sections.
    #[test]
    fn per_section_rows_carry_toc_titles_heading_fallbacks_and_null() {
        let (directory, db) = test_db();
        let books_dir = directory.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        write_three_section_epub(&books_dir.join("book.epub"));
        insert_book(&db, "");

        let aggregate = compute_and_store(&db, "book").unwrap();
        let sections = section_rows(&db, "book");

        assert_eq!(sections.len(), 3);
        assert_eq!(sections[0].order, 0);
        assert_eq!(sections[0].title.as_deref(), Some("Chapter One"));
        assert_eq!(sections[1].order, 1);
        assert_eq!(sections[1].title.as_deref(), Some("Twist Ending"));
        assert_eq!(sections[2].order, 2);
        assert_eq!(sections[2].title, None);

        let summed_tokens: i64 = sections.iter().map(|section| section.tokens).sum();
        assert_eq!(summed_tokens, aggregate.total_tokens);
        for band in 0..5 {
            let summed: i64 = sections.iter().map(|section| section.bands[band]).sum();
            let aggregate_band = [
                aggregate.band1,
                aggregate.band2,
                aggregate.band3,
                aggregate.band4,
                aggregate.band5,
            ][band];
            assert_eq!(summed, aggregate_band, "band {band} must sum to the aggregate");
        }
        let summed_unlisted: i64 = sections.iter().map(|section| section.unlisted).sum();
        assert_eq!(summed_unlisted, aggregate.band_unlisted);

        for section in &sections {
            assert_eq!(section.sha, aggregate.source_sha256);
        }
    }

    /// A recompute must replace, not append — otherwise a book re-analyzed
    /// after every re-import would accumulate duplicate section rows forever.
    #[test]
    fn recomputing_replaces_section_rows_instead_of_appending() {
        let (directory, db) = test_db();
        let books_dir = directory.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        write_three_section_epub(&books_dir.join("book.epub"));
        insert_book(&db, "");

        compute_and_store(&db, "book").unwrap();
        assert_eq!(section_rows(&db, "book").len(), 3);
        compute_and_store(&db, "book").unwrap();
        assert_eq!(section_rows(&db, "book").len(), 3);
    }

    /// An unsupported format never had sections to walk, so it must not
    /// leave any behind — and the format check runs before any file is read.
    #[test]
    fn an_unsupported_book_gets_no_section_rows() {
        let (_dir, db) = test_db();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (
                     id, title, author, file_path, source_format, render_format,
                     source_file_path, status, progress, created_at, updated_at
                 ) VALUES ('book', 'Book', 'Author', 'books/book.mobi', 'mobi', 'epub',
                           'books/book.mobi', 'unread', 0, 1, 1)",
                [],
            )
            .unwrap();

        let row = compute_and_store(&db, "book").unwrap();
        assert_eq!(row.status, DifficultyStatus::Unsupported);
        assert!(section_rows(&db, "book").is_empty());
    }

    /// A recorded failure must not leave a per-section breakdown that no
    /// longer sums to the (now zeroed) aggregate row sitting behind it.
    #[test]
    fn a_recorded_failure_clears_any_previous_section_rows() {
        let (directory, db) = test_db();
        let books_dir = directory.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        write_three_section_epub(&books_dir.join("book.epub"));
        insert_book(&db, "");
        compute_and_store(&db, "book").unwrap();
        assert_eq!(section_rows(&db, "book").len(), 3);

        record_failure(&db, "book", "SOMETHING_WENT_WRONG");
        assert!(section_rows(&db, "book").is_empty());
    }

    /// `write_sections` refuses PDF outright rather than writing per-page
    /// rows under a machine label — see the migration's own comment on
    /// `chapter_title`. Exercised directly against synthetic sections so the
    /// test does not depend on pdfium being available in CI.
    #[test]
    fn write_sections_skips_pdf_even_with_real_content() {
        let (_dir, db) = test_db();
        insert_book(&db, "source-a");
        let sections = vec![SectionText {
            section_index: 0,
            section_href: None,
            section_title: Some("Page 1".to_string()),
            blocks: vec![BlockText {
                text: "Some page text that would otherwise be tokenized.".to_string(),
                char_start: None,
                char_end: None,
            }],
        }];
        write_sections(&db, "book", "pdf", &sections, Some("source-a")).unwrap();
        assert!(section_rows(&db, "book").is_empty());
    }

    // -----------------------------------------------------------------
    // Open-card queries
    // -----------------------------------------------------------------

    fn insert_lookup(db: &Db, id: &str, book_id: &str, word: &str, last_looked_up_at: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO lookup_records (
                     id, book_id, lookup_text, normalized_text, definition,
                     created_at, last_looked_up_at, lookup_count
                 ) VALUES (?1, ?2, ?3, ?3, '', ?4, ?4, 1)",
                params![id, book_id, word, last_looked_up_at],
            )
            .unwrap();
    }

    fn insert_exposure(
        db: &Db,
        id: &str,
        book_id: &str,
        word: &str,
        encounter_count: i64,
        on_lookup_active: i64,
        last_seen_at: i64,
    ) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO reading_word_exposures (
                     id, book_id, chapter, normalized_word, encounter_count,
                     encounters_on_lookup_active_screen, first_seen_at, last_seen_at,
                     created_at, updated_at
                 ) VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, ?6, ?6, ?6)",
                params![id, book_id, word, encounter_count, on_lookup_active, last_seen_at],
            )
            .unwrap();
    }

    fn insert_vocab_word(db: &Db, id: &str, book_id: &str, word: &str, mastery: &str) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO vocab_words (
                     id, book_id, word, definition, mastery, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, '', ?4, '1', '1')",
                params![id, book_id, word, mastery],
            )
            .unwrap();
    }

    fn insert_dwell(db: &Db, id: &str, book_id: &str, word_count: i64, dwell_ms: i64, started_at: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO reading_screen_dwells (
                     id, book_id, started_at, ended_at, dwell_ms, word_count, created_at
                 ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?3)",
                params![id, book_id, started_at, dwell_ms, word_count],
            )
            .unwrap();
    }

    /// A thin read over `book_difficulty_sections`: whatever `write_sections`
    /// put there comes back in order, titles and all.
    #[test]
    fn difficulty_sections_query_returns_rows_in_order_with_titles() {
        let (directory, db) = test_db();
        let books_dir = directory.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        write_three_section_epub(&books_dir.join("book.epub"));
        insert_book(&db, "");

        compute_and_store(&db, "book").unwrap();
        let sections = load_difficulty_sections(&db, "book").unwrap();

        assert_eq!(sections.len(), 3);
        assert_eq!(sections[0].section_order, 0);
        assert_eq!(sections[0].chapter_title.as_deref(), Some("Chapter One"));
        assert_eq!(sections[1].chapter_title.as_deref(), Some("Twist Ending"));
        assert_eq!(sections[2].chapter_title, None);
    }

    /// No rows yet (PDF, or an old book still waiting on the backfill) is
    /// simply an empty vec, not an error — the frontend tells those two
    /// apart using the book's own format and `book_difficulty.status`.
    #[test]
    fn difficulty_sections_query_is_empty_when_no_rows_exist() {
        let (_dir, db) = test_db();
        insert_book(&db, "");
        assert!(load_difficulty_sections(&db, "book").unwrap().is_empty());
    }

    /// The retrospective count (mockup §8) is the one number the card keeps:
    /// distinct words looked up, and how many of those are now familiar or
    /// better. A lookup on a different book must never leak in.
    #[test]
    fn lookup_stats_count_distinct_words_and_mastered_subset() {
        let (_dir, db) = test_db();
        insert_book(&db, "");
        insert_lookup(&db, "l1", "book", "gallop", 10);
        insert_lookup(&db, "l2", "book", "gallop", 20); // same word, second occurrence
        insert_lookup(&db, "l3", "book", "steed", 30);
        insert_lookup(&db, "l4", "other-book", "unrelated", 40);
        insert_vocab_word(&db, "v1", "book", "gallop", "familiar");
        insert_vocab_word(&db, "v2", "book", "steed", "new");

        let stats = load_book_lookup_stats(&db, "book").unwrap();
        assert_eq!(stats.looked_up_words, 2);
        assert_eq!(stats.mastered_words, 1);
    }

    #[test]
    fn lookup_stats_are_zero_for_a_book_with_no_history() {
        let (_dir, db) = test_db();
        insert_book(&db, "");
        let stats = load_book_lookup_stats(&db, "book").unwrap();
        assert_eq!(stats.looked_up_words, 0);
        assert_eq!(stats.mastered_words, 0);
    }

    /// 1000 words in 5 minutes is 200 wpm; the book-scoped and overall
    /// medians must stay independent of each other's data.
    #[test]
    fn reading_pace_is_the_median_words_per_minute_scoped_by_book() {
        let (_dir, db) = test_db();
        insert_book(&db, "");
        insert_dwell(&db, "d1", "book", 1000, 5 * 60_000, 1);
        insert_dwell(&db, "d2", "other-book", 3000, 5 * 60_000, 2); // 600 wpm, must not affect "book"

        let pace = load_reading_pace(&db, "book").unwrap();
        assert_eq!(pace.book_words_per_minute, Some(200.0));
        // The overall figure spans both books, so it differs from the
        // book-scoped one.
        assert_eq!(pace.overall_words_per_minute, median_words_per_minute(&[
            ScreenPace { word_count: 1000, dwell_ms: 5 * 60_000 },
            ScreenPace { word_count: 3000, dwell_ms: 5 * 60_000 },
        ]));
    }

    #[test]
    fn reading_pace_is_none_with_no_measurable_screens() {
        let (_dir, db) = test_db();
        insert_book(&db, "");
        let pace = load_reading_pace(&db, "book").unwrap();
        assert_eq!(pace.book_words_per_minute, None);
        assert_eq!(pace.overall_words_per_minute, None);
    }

    /// Below the floor (fewer than 12 scorable lookups, or under 14 days of
    /// span), the card must say "not enough of your record yet" rather than
    /// compute a rate on too little — `sufficient` is exactly that gate.
    #[test]
    fn vocab_pass_rates_are_insufficient_below_the_floor() {
        let (_dir, db) = test_db();
        insert_book(&db, "");
        insert_lookup(&db, "l1", "book", "gallop", 10);
        let rates = compute_vocab_pass_rates(&db, 1_000_000).unwrap();
        assert!(!rates.sufficient);
        assert_eq!(rates.scorable_lookups, 1);
    }

    /// A word seen twice on a lookup-active screen and never looked up
    /// counts as "passed"; a word that was looked up counts against it — the
    /// band's rate is passed / (passed + looked_up). "gallop" is band 4 (see
    /// word_frequency's own tests).
    #[test]
    fn vocab_pass_rates_combine_passed_and_looked_up_words_per_band() {
        let (_dir, db) = test_db();
        insert_book(&db, "");
        let now = 200 * PASS_RATE_DAY_MS;
        // 12 scorable lookups spread across a 14+ day span, to clear the floor.
        for i in 0..12 {
            insert_lookup(
                &db,
                &format!("l{i}"),
                "book",
                "steed", // also band 4; repeats are fine, only distinct words matter downstream
                now - (14 - i as i64) * PASS_RATE_DAY_MS,
            );
        }
        insert_lookup(&db, "l-gallop", "book", "gallop", now - PASS_RATE_DAY_MS);
        insert_exposure(&db, "e1", "book", "canter", 2, 1, now - PASS_RATE_DAY_MS);

        let rates = compute_vocab_pass_rates(&db, now).unwrap();
        assert!(rates.sufficient);
        // band4 (index 3): "canter" passed, "steed" and "gallop" looked up
        // -> 1 passed / (1 passed + 2 looked up) = 1/3.
        assert_eq!(rates.band_pass_rates[3], Some(1.0 / 3.0));
        assert_eq!(rates.band_pass_rates[0], None); // no band-1 evidence at all
    }

    /// A word already looked up at any point must never also count as
    /// "passed" from a later exposure — otherwise looking a word up twice
    /// could make it look more familiar, not less.
    #[test]
    fn vocab_pass_rates_exclude_ever_looked_up_words_from_the_passed_set() {
        let (_dir, db) = test_db();
        insert_book(&db, "");
        let now = 200 * PASS_RATE_DAY_MS;
        for i in 0..12 {
            insert_lookup(
                &db,
                &format!("l{i}"),
                "book",
                "gallop",
                now - (14 - i as i64) * PASS_RATE_DAY_MS,
            );
        }
        // Looked up once, long before the window, then "passed" twice inside it.
        insert_lookup(&db, "l-old", "book", "canter", now - 5 * PASS_RATE_WINDOW_DAYS * PASS_RATE_DAY_MS);
        insert_exposure(&db, "e1", "book", "canter", 2, 1, now - PASS_RATE_DAY_MS);

        let rates = compute_vocab_pass_rates(&db, now).unwrap();
        // "canter" must not count as passed: it appears only on the
        // looked-up side, contributing 0 passed / (0 + 1) for band4.
        assert_eq!(rates.band_pass_rates[3], Some(0.0));
    }
}
