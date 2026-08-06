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

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::grounding::source::{extract_source_text, resolve_readable_source, BookSource};
use crate::db::Db;
use crate::error::{AppError, AppResult};
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
    let forms = FormIndex::new(db);
    let mut tally = BandTally::default();
    for (word, count) in counts {
        tally.total_tokens += count;
        tally.distinct_words += 1;
        match lookup_with(&forms, word)? {
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
fn compute_and_store(db: &Db, book_id: &str) -> AppResult<BookDifficulty> {
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
