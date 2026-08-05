//! Raw collection for the future mastery/review engine — see
//! docs/impls/reading-driven-mastery-and-review.md. This module only writes
//! and reads facts (per-screen dwell/operation counts, per-word viewport
//! exposure counts); no mastery score or display weight is computed here.
//!
//! The frontend batches finalized screens in memory and flushes them on
//! page turn / chapter switch / reader close / window blur (never on every
//! scroll), so a batch is normally one or a handful of screens. Writes are
//! best-effort from the caller's side: a failure here must never surface to
//! the reader UI, so callers should treat any error as "drop this batch".

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// A word is credible viewport exposure evidence only once it clears these
/// bounds — mirrors the sanity checks already used for reading sessions in
/// `commands::reading_stats`. A screen with more than this many distinct
/// content words is almost certainly a scanning/rendering glitch, not a
/// real page of prose; the row is dropped rather than silently truncated so
/// a batch write never partially records a corrupted screen.
const MAX_WORDS_PER_SCREEN: usize = 800;
const MAX_LOOKED_UP_WORDS_PER_SCREEN: usize = 50;
const MAX_WORD_LEN: usize = 64;
const MAX_CHAPTER_LEN: usize = 512;

/// §2.4's exclusion threshold: a screen counts as "not reading" only when
/// it was dwelt on for at least five minutes AND had zero operations —
/// never dwell time alone. This mirrors the already-present (and currently
/// unused) `IDLE_PAUSE_SECONDS` in `commands::reading_stats`; kept as its
/// own constant here because the two features may tune independently.
const IDLE_SCREEN_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenExposureInput {
    pub book_id: String,
    #[serde(default)]
    pub chapter: Option<String>,
    #[serde(default)]
    pub cfi: Option<String>,
    pub started_at: i64,
    pub ended_at: i64,
    #[serde(default)]
    pub operation_count: i64,
    #[serde(default)]
    pub lookup_count: i64,
    #[serde(default)]
    pub word_count: i64,
    /// Deduped, normalized content words visible on this screen (already
    /// tokenized, stopword-filtered, and normalized on the frontend to
    /// match Rust's `lookup_history::normalize`).
    #[serde(default)]
    pub words: Vec<String>,
    /// Normalized words actually looked up while this screen was dwelt on.
    /// Excluded from their own screen's upweight — see the exposures table
    /// comment in the migration for why.
    #[serde(default)]
    pub looked_up_words: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordReadingBehaviorResult {
    pub recorded: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WordExposureRow {
    pub chapter: String,
    pub normalized_word: String,
    pub encounter_count: i64,
    pub encounters_on_lookup_active_screen: i64,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
}

fn screen_is_valid(input: &ScreenExposureInput) -> bool {
    !input.book_id.trim().is_empty()
        && input.book_id.len() <= 256
        && input.started_at > 0
        && input.ended_at >= input.started_at
        && input.operation_count >= 0
        && input.lookup_count >= 0
        && input.lookup_count <= input.operation_count
        && input.word_count >= 0
        && input.words.len() <= MAX_WORDS_PER_SCREEN
        && input.looked_up_words.len() <= MAX_LOOKED_UP_WORDS_PER_SCREEN
        && input
            .chapter
            .as_deref()
            .is_none_or(|c| c.len() <= MAX_CHAPTER_LEN)
        && input
            .words
            .iter()
            .chain(input.looked_up_words.iter())
            .all(|w| !w.is_empty() && w.len() <= MAX_WORD_LEN)
}

/// Persists one batch of finalized screens: one `reading_screen_dwells` row
/// per screen (always, for the §5.1 pace signal and for future revisiting
/// of the exclusion rule below), then folds each screen's words into
/// `reading_word_exposures` — unless the screen itself matches §2.4's
/// exclusion rule (dwelt >= 5 minutes with zero operations), in which case
/// the dwell row is kept but its words are not counted as exposure
/// evidence. This is the one place that rule is actually applied; nothing
/// downstream needs to re-derive it from raw dwell/operation numbers.
pub fn record_reading_behavior_batch_inner(
    screens: &[ScreenExposureInput],
    db: &Db,
) -> AppResult<RecordReadingBehaviorResult> {
    let mut conn = db.conn.lock().expect("db mutex");
    let now = chrono::Utc::now().timestamp_millis();
    let tx = conn.transaction()?;
    let mut recorded = 0usize;
    let mut skipped = 0usize;

    for screen in screens {
        if !screen_is_valid(screen) {
            skipped += 1;
            continue;
        }
        let dwell_ms = screen.ended_at - screen.started_at;
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO reading_screen_dwells
                (id, book_id, chapter, cfi, started_at, ended_at, dwell_ms,
                 operation_count, lookup_count, word_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                screen.book_id,
                screen.chapter,
                screen.cfi,
                screen.started_at,
                screen.ended_at,
                dwell_ms,
                screen.operation_count,
                screen.lookup_count,
                screen.word_count,
                now,
            ],
        )?;

        let is_idle_screen = dwell_ms >= IDLE_SCREEN_MS && screen.operation_count == 0;
        if !is_idle_screen && !screen.words.is_empty() {
            let chapter = screen.chapter.clone().unwrap_or_default();
            let has_lookup_activity = screen.lookup_count > 0;
            for word in &screen.words {
                let upweight = has_lookup_activity && !screen.looked_up_words.contains(word);
                upsert_word_exposure(
                    &tx,
                    &screen.book_id,
                    &chapter,
                    word,
                    upweight,
                    screen.started_at,
                    screen.ended_at,
                    now,
                )?;
            }
        }
        recorded += 1;
    }

    tx.commit()?;
    Ok(RecordReadingBehaviorResult { recorded, skipped })
}

/// One statement per word, leaning on
/// `idx_reading_word_exposures_book_chapter_word`. A screen can carry up to
/// `MAX_WORDS_PER_SCREEN` words, so the read-then-write shape this replaces
/// meant up to 1600 statements per screen; the conflict target also makes
/// the dedupe the index's job rather than a check that could race.
///
/// The `encounters_on_lookup_active_screen <= encounter_count` CHECK holds
/// across the update because SQLite evaluates every right-hand side against
/// the pre-update row: the count grows by 1 and the subset by 0 or 1.
fn upsert_word_exposure(
    tx: &rusqlite::Transaction<'_>,
    book_id: &str,
    chapter: &str,
    normalized_word: &str,
    upweight: bool,
    started_at: i64,
    ended_at: i64,
    now: i64,
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO reading_word_exposures
            (id, book_id, chapter, normalized_word, encounter_count,
             encounters_on_lookup_active_screen, first_seen_at, last_seen_at,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(book_id, chapter, normalized_word) DO UPDATE SET
             encounter_count = encounter_count + 1,
             encounters_on_lookup_active_screen =
                 encounters_on_lookup_active_screen + ?5,
             first_seen_at = MIN(first_seen_at, ?6),
             last_seen_at = MAX(last_seen_at, ?7),
             updated_at = ?8",
        params![
            uuid::Uuid::new_v4().to_string(),
            book_id,
            chapter,
            normalized_word,
            i64::from(upweight),
            started_at,
            ended_at,
            now,
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub fn record_reading_behavior_batch(
    screens: Vec<ScreenExposureInput>,
    db: State<'_, Db>,
) -> AppResult<RecordReadingBehaviorResult> {
    record_reading_behavior_batch_inner(&screens, &db)
}

/// One basic read for the next batch's mastery/review algorithm to build
/// on: every aggregated word-exposure row for a book, across all chapters.
/// Deliberately unfiltered and unweighted — occurrence-number-to-weight
/// mapping (§2.2) and the lookup-active upweight (§2.1) are both future
/// work that consumes this raw data, not something computed here.
pub fn list_word_exposures_inner(book_id: &str, db: &Db) -> AppResult<Vec<WordExposureRow>> {
    if book_id.trim().is_empty() {
        return Err(AppError::Other("READING_BEHAVIOR_BOOK_INVALID".to_string()));
    }
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT chapter, normalized_word, encounter_count,
                encounters_on_lookup_active_screen, first_seen_at, last_seen_at
           FROM reading_word_exposures
          WHERE book_id = ?1
          ORDER BY chapter, normalized_word",
    )?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(WordExposureRow {
                chapter: row.get(0)?,
                normalized_word: row.get(1)?,
                encounter_count: row.get(2)?,
                encounters_on_lookup_active_screen: row.get(3)?,
                first_seen_at: row.get(4)?,
                last_seen_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn list_word_exposures(book_id: String, db: State<'_, Db>) -> AppResult<Vec<WordExposureRow>> {
    list_word_exposures_inner(&book_id, &db)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books
                    (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES ('book-1', 'Book one', 'Author', 'book.epub', 'finished', 100, ?1, ?1)",
                params![1_704_067_200_000_i64],
            )
            .unwrap();
        (dir, db)
    }

    fn screen(words: &[&str], looked_up: &[&str], op_count: i64, lookup_count: i64) -> ScreenExposureInput {
        ScreenExposureInput {
            book_id: "book-1".to_string(),
            chapter: Some("Chapter 1".to_string()),
            cfi: Some("epubcfi(/6/4!/4/2)".to_string()),
            started_at: 1_000,
            ended_at: 2_000,
            operation_count: op_count,
            lookup_count,
            word_count: words.len() as i64,
            words: words.iter().map(|w| w.to_string()).collect(),
            looked_up_words: looked_up.iter().map(|w| w.to_string()).collect(),
        }
    }

    #[test]
    fn records_a_screen_and_its_word_exposures() {
        let (_dir, db) = test_db();
        let result = record_reading_behavior_batch_inner(
            &[screen(&["quiet", "lantern", "dusk"], &[], 1, 0)],
            &db,
        )
        .unwrap();
        assert_eq!(result, RecordReadingBehaviorResult { recorded: 1, skipped: 0 });

        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        assert_eq!(rows.len(), 3);
        let lantern = rows.iter().find(|r| r.normalized_word == "lantern").unwrap();
        assert_eq!(lantern.encounter_count, 1);
        assert_eq!(lantern.encounters_on_lookup_active_screen, 0);
    }

    #[test]
    fn repeat_encounters_accumulate_and_never_reset_to_zero() {
        let (_dir, db) = test_db();
        for _ in 0..6 {
            record_reading_behavior_batch_inner(&[screen(&["dusk"], &[], 1, 0)], &db).unwrap();
        }
        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        let dusk = rows.iter().find(|r| r.normalized_word == "dusk").unwrap();
        // §2.2: every occurrence keeps counting, no cap and no reset — the
        // diminishing weight table is applied later, from this raw count.
        assert_eq!(dusk.encounter_count, 6);
    }

    #[test]
    fn idle_screen_is_recorded_but_excluded_from_word_exposure() {
        let (_dir, db) = test_db();
        let mut idle = screen(&["quiet", "lantern"], &[], 0, 0);
        idle.started_at = 1_000;
        idle.ended_at = idle.started_at + IDLE_SCREEN_MS; // exactly 5 minutes, zero operations
        let result = record_reading_behavior_batch_inner(&[idle], &db).unwrap();
        assert_eq!(result.recorded, 1, "the dwell row is still recorded");

        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        assert!(
            rows.is_empty(),
            "an idle screen must not count as exposure evidence"
        );

        let dwell_count: i64 = db
            .reader()
            .query_row("SELECT COUNT(*) FROM reading_screen_dwells", [], |row| row.get(0))
            .unwrap();
        assert_eq!(dwell_count, 1);
    }

    #[test]
    fn dwell_under_five_minutes_with_zero_ops_still_counts() {
        // The rule is dwell AND zero ops together, not dwell time alone —
        // a short, quiet screen is ordinary reading, not idle.
        let (_dir, db) = test_db();
        let mut brief = screen(&["quiet"], &[], 0, 0);
        brief.started_at = 1_000;
        brief.ended_at = brief.started_at + 60_000; // one minute
        record_reading_behavior_batch_inner(&[brief], &db).unwrap();
        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn idle_dwell_with_an_operation_still_counts() {
        // Dwelt >= 5 minutes but had an operation: not idle, per the exact
        // AND rule (dwell alone is never sufficient to exclude a screen).
        let (_dir, db) = test_db();
        let mut long_but_active = screen(&["quiet"], &[], 1, 0);
        long_but_active.started_at = 1_000;
        long_but_active.ended_at = long_but_active.started_at + IDLE_SCREEN_MS + 60_000;
        record_reading_behavior_batch_inner(&[long_but_active], &db).unwrap();
        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn lookup_active_screen_upweights_only_the_other_words() {
        let (_dir, db) = test_db();
        record_reading_behavior_batch_inner(
            &[screen(&["quiet", "lantern", "dusk"], &["dusk"], 1, 1)],
            &db,
        )
        .unwrap();
        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        let dusk = rows.iter().find(|r| r.normalized_word == "dusk").unwrap();
        let lantern = rows.iter().find(|r| r.normalized_word == "lantern").unwrap();
        assert_eq!(dusk.encounters_on_lookup_active_screen, 0, "the looked-up word itself is excluded");
        assert_eq!(lantern.encounters_on_lookup_active_screen, 1, "other words on the same screen are upweighted");
    }

    #[test]
    fn invalid_screens_are_skipped_not_fatal_to_the_batch() {
        let (_dir, db) = test_db();
        let mut bad = screen(&["quiet"], &[], 0, 0);
        bad.book_id = String::new();
        let good = screen(&["lantern"], &[], 0, 0);
        let result = record_reading_behavior_batch_inner(&[bad, good], &db).unwrap();
        assert_eq!(result, RecordReadingBehaviorResult { recorded: 1, skipped: 1 });
    }

    #[test]
    fn word_exposures_are_scoped_per_chapter() {
        let (_dir, db) = test_db();
        let mut ch1 = screen(&["dusk"], &[], 0, 0);
        ch1.chapter = Some("Chapter 1".to_string());
        let mut ch2 = screen(&["dusk"], &[], 0, 0);
        ch2.chapter = Some("Chapter 2".to_string());
        record_reading_behavior_batch_inner(&[ch1, ch2], &db).unwrap();
        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        assert_eq!(rows.len(), 2, "same word in two chapters stays two rows");
        assert!(rows.iter().all(|r| r.encounter_count == 1));
    }
}
