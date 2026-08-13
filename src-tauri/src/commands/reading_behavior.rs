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

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mastery::{is_screen_too_fast, median_words_per_minute, ScreenPace};
use crate::sync::writer::SyncWriter;

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

/// How many of the reader's most recent screens the pace baseline for §2.4's
/// other exclusion — "read far faster than this reader normally reads" — is
/// drawn from.
///
/// Bounded rather than "all of them" for two reasons: the median only has to
/// be a stable picture of how this person reads, which a few hundred screens
/// already is; and the cost of every single batch write should not grow with
/// how long someone has owned the app.
const MEDIAN_PACE_SAMPLE: i64 = 500;

/// How few plausibly-read screens make the median too thin to police anyone
/// with.
///
/// Needed because the pace filter in [`reader_median_wpm`] can leave very
/// little behind: on the database this was measured against, only 3 of 212
/// screens were at a human reading pace. A median of three screens that
/// happened to be slow would put the 3x gate below a normal reading speed and
/// start excluding real reading — the exact harm §2.4 is written to avoid. So
/// below this count the relative gate turns itself off and
/// [`crate::mastery::ABSOLUTE_MAX_WPM`] carries the filtering alone.
///
/// **Unlike the other thresholds in this area, 20 has no source behind it.**
/// It is a judgement call: large enough that one unusual screen cannot move
/// the median far, small enough to start working within a session or two of
/// real reading. It should be revisited once there is a corpus of genuine
/// reading to calibrate against — which, as of this constant being written,
/// does not exist.
const MIN_MEDIAN_PACE_SAMPLE: usize = 20;

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

/// The reader's own median words-per-minute, over their most recent
/// [`MEDIAN_PACE_SAMPLE`] screens that were plausibly *read*.
///
/// `None` means "no usable history yet", which callers must read as "run no
/// speed filter" — never as a median of zero. §2.4 would rather over-count
/// than exclude a reader it knows nothing about. Note that `None` disables
/// only the *relative* gate; [`crate::mastery::ABSOLUTE_MAX_WPM`] does not
/// depend on this baseline and keeps applying.
///
/// The [`crate::mastery::ABSOLUTE_MAX_WPM`] filter in the query is what makes
/// this a reading pace rather than a page-turning rate. Without it the
/// baseline is drawn from the same screens it exists to police: measured on a
/// real device, 87.7% of screens were faster than any human reads, which
/// dragged the median to 5627 wpm and put the 3x gate at 16882 — high enough
/// that page-turns were being credited as vocabulary exposure. Filtering
/// before `LIMIT` (not after) keeps the window meaning "the most recent 500
/// screens they actually read", not "whatever survives out of the most recent
/// 500 of anything".
fn reader_median_wpm(tx: &rusqlite::Transaction<'_>) -> AppResult<Option<f64>> {
    let mut stmt = tx.prepare(
        "SELECT word_count, dwell_ms FROM reading_screen_dwells
          WHERE word_count > 0 AND dwell_ms > 0
            AND (word_count * 60000.0) / dwell_ms <= ?1
          ORDER BY started_at DESC
          LIMIT ?2",
    )?;
    let screens = stmt
        .query_map(
            params![crate::mastery::ABSOLUTE_MAX_WPM, MEDIAN_PACE_SAMPLE],
            |row| {
                Ok(ScreenPace {
                    word_count: row.get("word_count")?,
                    dwell_ms: row.get("dwell_ms")?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    if screens.len() < MIN_MEDIAN_PACE_SAMPLE {
        return Ok(None);
    }
    Ok(median_words_per_minute(&screens))
}

/// Persists one batch of finalized screens: one `reading_screen_dwells` row
/// per screen (always, for the §5.1 pace signal and for future revisiting
/// of the exclusion rules below), then folds each screen's words into
/// `reading_word_exposures` — unless the screen matches one of §2.4's two
/// exclusions, in which case the dwell row is kept but its words are not
/// counted as exposure evidence:
///
/// 1. dwelt >= 5 minutes with zero operations (the reader walked away), and
/// 2. read faster than [`crate::mastery::is_screen_too_fast`] allows against
///    this reader's own median (skimmed, not read).
///
/// This is the one place either rule is applied. It has to be here rather
/// than in the scoring engine because `reading_word_exposures` aggregates
/// away which screen each encounter came from: once folded, there is no
/// screen left to ask how fast it was or whether anyone touched it.
///
/// Then it scores what it just recorded, in the same transaction — see
/// [`crate::mastery::store::score_book_exposures`].
pub fn record_reading_behavior_batch_inner(
    screens: &[ScreenExposureInput],
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<RecordReadingBehaviorResult> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        let mut recorded = 0usize;
        let mut skipped = 0usize;
        // Measured once per batch, before this batch's own rows land: a
        // handful of new screens cannot meaningfully move a median drawn from
        // hundreds, and re-measuring per screen would let one very fast page
        // in the batch start excluding the pages after it.
        let median_wpm = reader_median_wpm(tx)?;
        let mut books_touched: Vec<String> = Vec::new();

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
            let is_skimmed = is_screen_too_fast(
                ScreenPace {
                    word_count: screen.word_count,
                    dwell_ms,
                },
                median_wpm,
            );
            if !is_idle_screen && !is_skimmed && !screen.words.is_empty() {
                let chapter = screen.chapter.clone().unwrap_or_default();
                let has_lookup_activity = screen.lookup_count > 0;
                for word in &screen.words {
                    let upweight = has_lookup_activity && !screen.looked_up_words.contains(word);
                    upsert_word_exposure(
                        tx,
                        &screen.book_id,
                        &chapter,
                        word,
                        upweight,
                        screen.started_at,
                        screen.ended_at,
                        now,
                    )?;
                }
                if !books_touched.contains(&screen.book_id) {
                    books_touched.push(screen.book_id.clone());
                }
            }
            recorded += 1;
        }

        for book_id in &books_touched {
            crate::mastery::store::score_book_exposures(tx, events, book_id, now, &device)?;
        }

        Ok(RecordReadingBehaviorResult { recorded, skipped })
    })
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
// Eight columns of one row, each a distinct type the caller already has on
// hand; bundling them into a struct would only move the same list one line up.
#[allow(clippy::too_many_arguments)]
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
             distinct_days, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, 1, ?8, ?8)
         ON CONFLICT(book_id, chapter, normalized_word) DO UPDATE SET
             encounter_count = encounter_count + 1,
             encounters_on_lookup_active_screen =
                 encounters_on_lookup_active_screen + ?5,
             distinct_days = distinct_days + (CASE WHEN
                 strftime('%Y-%m-%d', last_seen_at / 1000, 'unixepoch', 'localtime')
                     = strftime('%Y-%m-%d', ?7 / 1000, 'unixepoch', 'localtime')
                 THEN 0 ELSE 1 END),
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
    sync: State<'_, SyncWriter>,
) -> AppResult<RecordReadingBehaviorResult> {
    record_reading_behavior_batch_inner(&screens, &db, &sync)
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
                chapter: row.get("chapter")?,
                normalized_word: row.get("normalized_word")?,
                encounter_count: row.get("encounter_count")?,
                encounters_on_lookup_active_screen: row
                    .get("encounters_on_lookup_active_screen")?,
                first_seen_at: row.get("first_seen_at")?,
                last_seen_at: row.get("last_seen_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn list_word_exposures(book_id: String, db: State<'_, Db>) -> AppResult<Vec<WordExposureRow>> {
    list_word_exposures_inner(&book_id, &db)
}

/// The numerator for `docs/impls/reading-flow-decisions-2026-08-06.md` §2.2's
/// auto-finish coverage check: how many *distinct* screens of this book were
/// dwelt at the reader's own normal pace, across its entire local reading
/// history (not just the current session).
///
/// Distinct, not "how many rows" — `reading_screen_dwells` has no unique
/// constraint on `(book_id, cfi)`, so revisiting the same screen (rereading a
/// chapter, flipping back to check something) writes another row every time.
/// Counting rows would let a reader who reread the first 20% of a book four
/// times outscore the 80% coverage floor without ever having seen the other
/// 80% of the book once — bug 2 in §2's writeup. A screen counts here if
/// *any* dwell on it cleared the pace bar, deduped by `cfi` (the screen's own
/// anchor) so rereads collapse to the one screen they are.
///
/// Rows with no `cfi` are excluded rather than counted individually — with
/// no anchor to dedupe on, crediting them at all would reopen exactly the
/// hole this function exists to close (each such row would count as its own
/// "distinct" screen). Per "宁可漏标，不可错标" that is the safe direction:
/// it can only undercount, never inflate, the numerator.
///
/// Reuses [`is_screen_too_fast`] against the same baseline
/// [`reader_median_wpm`] computes at write time, so "normal pace" means
/// exactly the same thing here as it does when a screen's words are folded
/// into `reading_word_exposures`. A screen with no measurable pace counts as
/// normal — that is `is_screen_too_fast`'s own rule, not a special case added
/// here: an unmeasurable screen is a data problem, and data problems break
/// toward the reader.
pub fn count_normal_pace_screens(tx: &rusqlite::Transaction<'_>, book_id: &str) -> AppResult<i64> {
    let median_wpm = reader_median_wpm(tx)?;
    let mut stmt = tx.prepare(
        "SELECT cfi, word_count, dwell_ms FROM reading_screen_dwells
          WHERE book_id = ?1 AND cfi IS NOT NULL",
    )?;
    let mut distinct_screens: HashSet<String> = HashSet::new();
    let mut rows = stmt.query(params![book_id])?;
    while let Some(row) = rows.next()? {
        let cfi: String = row.get("cfi")?;
        let pace = ScreenPace {
            word_count: row.get("word_count")?,
            dwell_ms: row.get("dwell_ms")?,
        };
        if !is_screen_too_fast(pace, median_wpm) {
            distinct_screens.insert(cfi);
        }
    }
    Ok(distinct_screens.len() as i64)
}

/// A book's estimated denominator needs at least this many of its own
/// measurable screens before its average words-per-screen is trusted. Below
/// this, a single unusually long or short screen (a title page, a screen
/// caught mid-layout-reflow) can swing the whole-book estimate by a large
/// margin; per §2.2, an untrustworthy denominator must skip the check, not
/// approximate it.
const MIN_SCREENS_FOR_BOOK_ESTIMATE: i64 = 5;

/// The denominator for §2.2's auto-finish coverage check: an estimate of how
/// many screens this book takes *in total*, at this reader's own on-screen
/// density — never a per-chapter count (bug 1 in §2's writeup: the frontend
/// used to pass `view.renderer?.pages`, which is foliate's current-section
/// page count and is rebuilt on every chapter load, so it silently measured
/// "pages in whatever chapter is open right now" wherever the reader
/// happened to be when the last progress event fired).
///
/// Derivation: this device already has two whole-book-scale numbers for this
/// book. `book_difficulty.total_tokens` is the entire book's word count,
/// computed once from the source file by `book_difficulty::compute_and_store`
/// regardless of which chapter is open. And this reader's own recorded
/// screens for this book (`reading_screen_dwells.word_count`) give an average
/// words-per-screen at this reader's actual font size, page size, and column
/// count — all of which change how many words fit on one screen, so a fixed
/// "words per page" constant would be wrong for nearly everyone. Dividing the
/// first by the second estimates the whole book's screen count in units this
/// reader's own history already speaks:
///
/// `total_screens ≈ book_difficulty.total_tokens / avg(this book's own dwell word_count)`
///
/// Returns `None` — never a smaller stand-in value — whenever either input
/// isn't trustworthy yet: `book_difficulty` hasn't finished computing for
/// this book (still pending/running, or failed), or this device has fewer
/// than [`MIN_SCREENS_FOR_BOOK_ESTIMATE`] measurable screens for it. Per
/// §2.2's "宁可漏标，不可错标", the caller must read `None` as "skip the
/// auto-finish check entirely for this update" — never fall back to a
/// chapter-scoped count, which is the exact bug this function replaces.
pub fn estimate_total_book_screens(
    tx: &rusqlite::Transaction<'_>,
    book_id: &str,
) -> AppResult<Option<i64>> {
    let total_tokens: Option<i64> = tx
        .query_row(
            "SELECT total_tokens FROM book_difficulty WHERE book_id = ?1 AND status = 'done'",
            params![book_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(total_tokens) = total_tokens.filter(|tokens| *tokens > 0) else {
        return Ok(None);
    };

    let (avg_words, sample): (Option<f64>, i64) = tx.query_row(
        "SELECT AVG(word_count), COUNT(*) FROM reading_screen_dwells
          WHERE book_id = ?1 AND word_count > 0",
        params![book_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    if sample < MIN_SCREENS_FOR_BOOK_ESTIMATE {
        return Ok(None);
    }
    let Some(avg_words) = avg_words.filter(|words| *words > 0.0) else {
        return Ok(None);
    };

    let estimate = (total_tokens as f64 / avg_words).ceil() as i64;
    Ok(Some(estimate.max(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> (tempfile::TempDir, Db, SyncWriter) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let sync = SyncWriter::new("dev-test".to_string());
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
        (dir, db, sync)
    }

    fn screen(
        words: &[&str],
        looked_up: &[&str],
        op_count: i64,
        lookup_count: i64,
    ) -> ScreenExposureInput {
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
        let (_dir, db, sync) = test_db();
        let result = record_reading_behavior_batch_inner(
            &[screen(&["quiet", "lantern", "dusk"], &[], 1, 0)],
            &db,
            &sync,
        )
        .unwrap();
        assert_eq!(
            result,
            RecordReadingBehaviorResult {
                recorded: 1,
                skipped: 0
            }
        );

        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        assert_eq!(rows.len(), 3);
        let lantern = rows
            .iter()
            .find(|r| r.normalized_word == "lantern")
            .unwrap();
        assert_eq!(lantern.encounter_count, 1);
        assert_eq!(lantern.encounters_on_lookup_active_screen, 0);
    }

    #[test]
    fn repeat_encounters_accumulate_and_never_reset_to_zero() {
        let (_dir, db, sync) = test_db();
        for _ in 0..6 {
            record_reading_behavior_batch_inner(&[screen(&["dusk"], &[], 1, 0)], &db, &sync)
                .unwrap();
        }
        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        let dusk = rows.iter().find(|r| r.normalized_word == "dusk").unwrap();
        // §2.2: every occurrence keeps counting, no cap and no reset — the
        // diminishing weight table is applied later, from this raw count.
        assert_eq!(dusk.encounter_count, 6);
    }

    #[test]
    fn idle_screen_is_recorded_but_excluded_from_word_exposure() {
        let (_dir, db, sync) = test_db();
        let mut idle = screen(&["quiet", "lantern"], &[], 0, 0);
        idle.started_at = 1_000;
        idle.ended_at = idle.started_at + IDLE_SCREEN_MS; // exactly 5 minutes, zero operations
        let result = record_reading_behavior_batch_inner(&[idle], &db, &sync).unwrap();
        assert_eq!(result.recorded, 1, "the dwell row is still recorded");

        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        assert!(
            rows.is_empty(),
            "an idle screen must not count as exposure evidence"
        );

        let dwell_count: i64 = db
            .reader()
            .query_row("SELECT COUNT(*) FROM reading_screen_dwells", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(dwell_count, 1);
    }

    #[test]
    fn dwell_under_five_minutes_with_zero_ops_still_counts() {
        // The rule is dwell AND zero ops together, not dwell time alone —
        // a short, quiet screen is ordinary reading, not idle.
        let (_dir, db, sync) = test_db();
        let mut brief = screen(&["quiet"], &[], 0, 0);
        brief.started_at = 1_000;
        brief.ended_at = brief.started_at + 60_000; // one minute
        record_reading_behavior_batch_inner(&[brief], &db, &sync).unwrap();
        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn idle_dwell_with_an_operation_still_counts() {
        // Dwelt >= 5 minutes but had an operation: not idle, per the exact
        // AND rule (dwell alone is never sufficient to exclude a screen).
        let (_dir, db, sync) = test_db();
        let mut long_but_active = screen(&["quiet"], &[], 1, 0);
        long_but_active.started_at = 1_000;
        long_but_active.ended_at = long_but_active.started_at + IDLE_SCREEN_MS + 60_000;
        record_reading_behavior_batch_inner(&[long_but_active], &db, &sync).unwrap();
        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn lookup_active_screen_upweights_only_the_other_words() {
        let (_dir, db, sync) = test_db();
        record_reading_behavior_batch_inner(
            &[screen(&["quiet", "lantern", "dusk"], &["dusk"], 1, 1)],
            &db,
            &sync,
        )
        .unwrap();
        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        let dusk = rows.iter().find(|r| r.normalized_word == "dusk").unwrap();
        let lantern = rows
            .iter()
            .find(|r| r.normalized_word == "lantern")
            .unwrap();
        assert_eq!(
            dusk.encounters_on_lookup_active_screen, 0,
            "the looked-up word itself is excluded"
        );
        assert_eq!(
            lantern.encounters_on_lookup_active_screen, 1,
            "other words on the same screen are upweighted"
        );
    }

    #[test]
    fn invalid_screens_are_skipped_not_fatal_to_the_batch() {
        let (_dir, db, sync) = test_db();
        let mut bad = screen(&["quiet"], &[], 0, 0);
        bad.book_id = String::new();
        let good = screen(&["lantern"], &[], 0, 0);
        let result = record_reading_behavior_batch_inner(&[bad, good], &db, &sync).unwrap();
        assert_eq!(
            result,
            RecordReadingBehaviorResult {
                recorded: 1,
                skipped: 1
            }
        );
    }

    #[test]
    fn word_exposures_are_scoped_per_chapter() {
        let (_dir, db, sync) = test_db();
        let mut ch1 = screen(&["dusk"], &[], 0, 0);
        ch1.chapter = Some("Chapter 1".to_string());
        let mut ch2 = screen(&["dusk"], &[], 0, 0);
        ch2.chapter = Some("Chapter 2".to_string());
        record_reading_behavior_batch_inner(&[ch1, ch2], &db, &sync).unwrap();
        let rows = list_word_exposures_inner("book-1", &db).unwrap();
        assert_eq!(rows.len(), 2, "same word in two chapters stays two rows");
        assert!(rows.iter().all(|r| r.encounter_count == 1));
    }

    // -- §2.2 auto-finish gate: numerator (dedup) and denominator (estimate) --

    fn insert_dwell_at(
        db: &Db,
        book_id: &str,
        cfi: Option<&str>,
        started_at: i64,
        word_count: i64,
        dwell_ms: i64,
    ) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO reading_screen_dwells
                    (id, book_id, chapter, cfi, started_at, ended_at, dwell_ms,
                     operation_count, lookup_count, word_count, created_at)
                 VALUES (?1, ?2, 'Chapter 1', ?3, ?4, ?5, ?6, 0, 0, ?7, ?5)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    book_id,
                    cfi,
                    started_at,
                    started_at + dwell_ms,
                    dwell_ms,
                    word_count,
                ],
            )
            .unwrap();
    }

    fn insert_done_book_difficulty(db: &Db, book_id: &str, total_tokens: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO book_difficulty (book_id, status, total_tokens) VALUES (?1, 'done', ?2)",
                params![book_id, total_tokens],
            )
            .unwrap();
    }

    /// Bug 2: `reading_screen_dwells` has no unique constraint on
    /// `(book_id, cfi)`, so rereading the same screen writes another row
    /// every time. The numerator must count distinct screens, not rows —
    /// rereading one screen five times must count as one screen, not five.
    #[test]
    fn count_normal_pace_screens_dedupes_by_cfi() {
        let (_dir, db, _sync) = test_db();
        for i in 0..5 {
            insert_dwell_at(
                &db,
                "book-1",
                Some("epubcfi(/6/4!/2)"),
                1_000 + i * 60_000,
                200,
                60_000,
            );
        }
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let count = count_normal_pace_screens(&tx, "book-1").unwrap();
        assert_eq!(
            count, 1,
            "five dwells on the same cfi are one screen, not five"
        );
    }

    /// Rows with no `cfi` at all cannot be told apart, so they are dropped
    /// from the numerator rather than each counted as its own screen — the
    /// safe direction per "宁可漏标，不可错标".
    #[test]
    fn count_normal_pace_screens_excludes_rows_without_a_cfi() {
        let (_dir, db, _sync) = test_db();
        insert_dwell_at(&db, "book-1", None, 1_000, 200, 60_000);
        insert_dwell_at(&db, "book-1", None, 61_000, 200, 60_000);
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let count = count_normal_pace_screens(&tx, "book-1").unwrap();
        assert_eq!(count, 0);
    }

    /// Bug 1's fix: the denominator comes from this book's own whole-book
    /// word count (`book_difficulty.total_tokens`) divided by this reader's
    /// own average words-per-screen for the book — never a per-chapter
    /// count.
    #[test]
    fn estimate_total_book_screens_derives_from_book_difficulty_and_own_pace() {
        let (_dir, db, _sync) = test_db();
        insert_done_book_difficulty(&db, "book-1", 30_000);
        // Ten screens averaging 300 words each -> ~100 screens for the book.
        for i in 0..10 {
            insert_dwell_at(&db, "book-1", Some("cfi"), 1_000 + i * 60_000, 300, 60_000);
        }
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let estimate = estimate_total_book_screens(&tx, "book-1").unwrap();
        assert_eq!(estimate, Some(100));
    }

    /// No `book_difficulty` row yet (still pending, or never scheduled) —
    /// there is no whole-book denominator to estimate from, so the check
    /// must be skipped entirely, never fall back to something smaller.
    #[test]
    fn estimate_total_book_screens_is_none_without_book_difficulty() {
        let (_dir, db, _sync) = test_db();
        for i in 0..10 {
            insert_dwell_at(&db, "book-1", Some("cfi"), 1_000 + i * 60_000, 300, 60_000);
        }
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        assert_eq!(estimate_total_book_screens(&tx, "book-1").unwrap(), None);
    }

    /// A `book_difficulty` row that hasn't finished computing (still
    /// `running`) must not be treated as usable — only `status = 'done'`
    /// is a trustworthy whole-book count.
    #[test]
    fn estimate_total_book_screens_is_none_while_difficulty_is_still_running() {
        let (_dir, db, _sync) = test_db();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO book_difficulty (book_id, status, total_tokens) VALUES ('book-1', 'running', 0)",
                [],
            )
            .unwrap();
        for i in 0..10 {
            insert_dwell_at(&db, "book-1", Some("cfi"), 1_000 + i * 60_000, 300, 60_000);
        }
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        assert_eq!(estimate_total_book_screens(&tx, "book-1").unwrap(), None);
    }

    /// Too few of this book's own screens recorded yet to trust an average
    /// — a single screen (or a handful) could be wildly unrepresentative
    /// (a title page, a mid-reflow glitch), so the estimate is withheld
    /// rather than computed from a shaky sample.
    #[test]
    fn estimate_total_book_screens_is_none_below_the_minimum_sample() {
        let (_dir, db, _sync) = test_db();
        insert_done_book_difficulty(&db, "book-1", 30_000);
        for i in 0..(MIN_SCREENS_FOR_BOOK_ESTIMATE - 1) {
            insert_dwell_at(&db, "book-1", Some("cfi"), 1_000 + i * 60_000, 300, 60_000);
        }
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        assert_eq!(estimate_total_book_screens(&tx, "book-1").unwrap(), None);
    }

    /// The baseline must describe reading, not page-turning. Before the pace
    /// filter, a table dominated by flips produced a median that was itself a
    /// flip rate, which then licensed more flips: on a real device 87.7% of
    /// screens were faster than any human reads and the median came out at
    /// 5627 wpm.
    #[test]
    fn the_median_ignores_screens_nobody_could_have_read() {
        let (_dir, db, _sync) = test_db();
        // 25 genuine screens at 200 wpm, plus 60 page-turns at 6_000 wpm.
        for i in 0..25 {
            insert_dwell_at(
                &db,
                "book-1",
                Some("epubcfi(/6/4!/2)"),
                1_000 + i * 60_000,
                200,
                60_000,
            );
        }
        for i in 0..60 {
            insert_dwell_at(
                &db,
                "book-1",
                Some("epubcfi(/6/4!/4)"),
                2_000_000 + i * 2_000,
                200,
                2_000,
            );
        }
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let median = reader_median_wpm(&tx)
            .unwrap()
            .expect("25 read screens is enough");
        assert!(
            (median - 200.0).abs() < 1.0,
            "median should describe the reading, got {median}"
        );
    }

    /// Filtering happens before `LIMIT`, so the window means "the most recent
    /// 500 screens they actually read" — a long run of flips must not push
    /// real reading out of the sample.
    #[test]
    fn recent_page_turns_do_not_crowd_reading_out_of_the_window() {
        let (_dir, db, _sync) = test_db();
        for i in 0..30 {
            insert_dwell_at(
                &db,
                "book-1",
                Some("epubcfi(/6/4!/2)"),
                1_000 + i * 60_000,
                200,
                60_000,
            );
        }
        for i in 0..600 {
            insert_dwell_at(
                &db,
                "book-1",
                Some("epubcfi(/6/4!/4)"),
                9_000_000 + i * 2_000,
                200,
                2_000,
            );
        }
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let median = reader_median_wpm(&tx)
            .unwrap()
            .expect("the 30 read screens survive the window");
        assert!((median - 200.0).abs() < 1.0, "got {median}");
    }

    /// Too few plausibly-read screens is "no usable history", not a median of
    /// whatever three screens happened to survive — a thin, slow sample would
    /// put the 3x gate under a normal reading speed and start excluding real
    /// reading.
    #[test]
    fn a_thin_sample_reports_no_baseline_at_all() {
        let (_dir, db, _sync) = test_db();
        for i in 0..(MIN_MEDIAN_PACE_SAMPLE - 1) {
            insert_dwell_at(
                &db,
                "book-1",
                Some("epubcfi(/6/4!/2)"),
                1_000 + (i as i64) * 60_000,
                200,
                60_000,
            );
        }
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        assert!(reader_median_wpm(&tx).unwrap().is_none());
    }

    /// A table with nothing but page-turns in it yields no baseline, rather
    /// than a baseline made of page-turns. The absolute gate still applies to
    /// every screen, so this is a stand-down of the relative half only.
    #[test]
    fn a_table_of_only_page_turns_yields_no_baseline() {
        let (_dir, db, _sync) = test_db();
        for i in 0..200 {
            insert_dwell_at(
                &db,
                "book-1",
                Some("epubcfi(/6/4!/4)"),
                1_000 + i * 2_000,
                200,
                2_000,
            );
        }
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        assert!(reader_median_wpm(&tx).unwrap().is_none());
    }
}
