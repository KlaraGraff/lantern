//! Tests for the SQL half of the mastery engine.
//!
//! These drive `record_reading_behavior_batch_inner` rather than calling
//! `score_book_exposures` directly, because the thing most likely to break is
//! not the arithmetic — the parent module's tests cover that — but the seam:
//! whether the watermark holds, whether occurrence numbering survives being
//! split across flushes, and whether §2.4's exclusions still bite now that
//! something downstream consumes what they let through.

use rusqlite::params;

use crate::commands::reading_behavior::{record_reading_behavior_batch_inner, ScreenExposureInput};
use crate::db::Db;
use crate::sync::writer::SyncWriter;

const BOOK: &str = "book-1";
const WORD_ID: &str = "vocab-1";
const DAY_MS: i64 = 86_400_000;
const START: i64 = 1_700_000_000_000;

fn fixture() -> (tempfile::TempDir, Db, SyncWriter) {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::init(dir.path()).unwrap();
    let sync = SyncWriter::new("dev-test".to_string());
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO books
                (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES (?1, 'Quiet Book', 'Author', 'book.epub', 'reading', 10, ?2, ?2)",
            params![BOOK, 1_704_067_200_000_i64],
        )
        .unwrap();
    (dir, db, sync)
}

/// Saves one vocabulary word. `word` is stored exactly as passed, because
/// matching a raw saved word against a normalized exposure row is itself
/// under test.
fn save_word(db: &Db, word: &str, mastery: &str) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO vocab_words
                (id, book_id, word, definition, mastery, review_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'a definition', ?4, 0, ?5, ?5)",
            params![WORD_ID, BOOK, word, mastery, 1_704_067_200_000_i64],
        )
        .unwrap();
}

/// One settled screen: a minute of dwell, one page turn, no lookups.
fn screen(chapter: &str, words: &[&str], started_at: i64) -> ScreenExposureInput {
    ScreenExposureInput {
        book_id: BOOK.to_string(),
        chapter: Some(chapter.to_string()),
        cfi: None,
        started_at,
        ended_at: started_at + 60_000,
        operation_count: 1,
        lookup_count: 0,
        word_count: words.len() as i64,
        words: words.iter().map(|w| w.to_string()).collect(),
        looked_up_words: Vec::new(),
    }
}

fn flush(db: &Db, sync: &SyncWriter, screens: &[ScreenExposureInput]) {
    record_reading_behavior_batch_inner(screens, db, sync).unwrap();
}

/// Meets the word once in each of `chapters` chapters, one chapter per day,
/// each its own flush — the ordinary shape of reading a book, and the only
/// shape that can reach the familiar threshold: one chapter's diminishing
/// weights cannot get there alone.
fn read_across_chapters(db: &Db, sync: &SyncWriter, chapters: usize, word: &str) {
    for index in 0..chapters {
        let chapter = format!("Chapter {}", index + 1);
        flush(
            db,
            sync,
            &[screen(&chapter, &[word], START + index as i64 * DAY_MS)],
        );
    }
}

fn mastery_of(db: &Db) -> (String, String, Option<String>) {
    db.reader()
        .query_row(
            "SELECT mastery, mastery_source, mastery_reason FROM vocab_words WHERE id = ?1",
            params![WORD_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

fn credit_of(db: &Db) -> f64 {
    db.reader()
        .query_row(
            "SELECT credit FROM mastery_progress WHERE vocab_word_id = ?1",
            params![WORD_ID],
            |row| row.get(0),
        )
        .unwrap()
}

fn exposure_row(db: &Db, word: &str) -> (i64, i64, i64) {
    db.reader()
        .query_row(
            "SELECT SUM(encounter_count), SUM(scored_encounter_count), MAX(distinct_days)
               FROM reading_word_exposures WHERE normalized_word = ?1",
            params![word],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

#[test]
fn four_chapters_without_a_lookup_reach_familiar() {
    // The worked example the word-detail page promises: four first sightings,
    // 1.0 each, landing exactly on FAMILIAR_CREDIT.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    read_across_chapters(&db, &sync, 4, "quiet");

    let (mastery, source, reason) = mastery_of(&db);
    assert_eq!(mastery, "familiar");
    assert_eq!(source, "auto");
    let detail: serde_json::Value = serde_json::from_str(&reason.unwrap()).unwrap();
    assert_eq!(detail["reason"], "exposure_promotion");
    assert_eq!(detail["book_title"], "Quiet Book");
    assert_eq!(detail["exposures"], 4);
    // Four chapters, four calendar days — the per-chapter counters all read 1,
    // so this only comes out right if the sightings are unioned across rows.
    assert_eq!(detail["distinct_days"], 4);
}

#[test]
fn three_chapters_are_not_enough() {
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    read_across_chapters(&db, &sync, 3, "quiet");
    assert_eq!(mastery_of(&db).0, "new");
    assert!((credit_of(&db) - 3.0).abs() < 1e-9);
}

#[test]
fn a_later_flush_finds_nothing_left_to_score_in_an_old_chapter() {
    // The reason migration 039 exists. Reading on in a new chapter runs the
    // scoring pass over the whole book; the chapters already consumed must
    // contribute nothing the second time, or every word walks to mastered.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    read_across_chapters(&db, &sync, 3, "quiet");
    let credit_before = credit_of(&db);

    // A different word, so "quiet" gains nothing new — but the pass still runs.
    flush(&db, &sync, &[screen("Chapter 4", &["dusk"], START + 4 * DAY_MS)]);

    assert_eq!(mastery_of(&db).0, "new");
    assert_eq!(credit_of(&db), credit_before);
}

#[test]
fn the_occurrence_counter_keeps_going_across_flushes() {
    // Three separate flushes of the same chapter. If the weight table restarted
    // at 1.0 each pass this would bank 3.0; §2.2 says 1.0 + 0.4 + 0.2.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    for index in 0..3 {
        flush(
            &db,
            &sync,
            &[screen("Chapter 1", &["quiet"], START + index * DAY_MS)],
        );
    }
    assert!((credit_of(&db) - 1.6).abs() < 1e-9);
}

#[test]
fn one_chapter_in_one_flush_cannot_spend_more_than_its_cap() {
    // Twenty sightings in one chapter are worth 2.5 by weight alone;
    // CHAPTER_CREDIT_CAP holds the chapter to 2.0, half of what promotion asks.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    let screens: Vec<_> = (0..20)
        .map(|index| screen("Chapter 1", &["quiet"], START + index * 60_000))
        .collect();
    flush(&db, &sync, &screens);

    assert_eq!(mastery_of(&db).0, "new");
    assert!((credit_of(&db) - 2.0).abs() < 1e-9);
}

#[test]
fn a_word_the_reader_never_saved_is_consumed_not_banked() {
    // Ten chapters' worth of sightings before the word is ever saved. Nothing
    // may be waiting for it: a word enters the list because the reader looked
    // it up, and a backlog landing right then would promote a word they had
    // just admitted not knowing.
    let (_dir, db, sync) = fixture();
    read_across_chapters(&db, &sync, 10, "quiet");
    save_word(&db, "quiet", "learning");
    flush(&db, &sync, &[screen("Chapter 11", &["quiet"], START + 11 * DAY_MS)]);

    assert_eq!(mastery_of(&db).0, "learning");
    let (seen, scored, _) = exposure_row(&db, "quiet");
    assert_eq!(seen, 11);
    assert_eq!(scored, 11, "every sighting was consumed, saved or not");
    assert!((credit_of(&db) - 1.0).abs() < 1e-9);
}

#[test]
fn a_saved_word_is_matched_through_the_readers_own_punctuation() {
    // Exposure rows arrive normalized; vocab_words keeps whatever the reader
    // selected, capital and trailing comma included.
    let (_dir, db, sync) = fixture();
    save_word(&db, "Quiet,", "new");
    read_across_chapters(&db, &sync, 4, "quiet");
    assert_eq!(mastery_of(&db).0, "familiar");
}

#[test]
fn a_promotion_leaves_a_timeline_row_behind() {
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    read_across_chapters(&db, &sync, 4, "quiet");

    let (from, to, source, reason) = db
        .reader()
        .query_row(
            "SELECT from_mastery, to_mastery, source, reason FROM mastery_events
              WHERE vocab_word_id = ?1",
            params![WORD_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .unwrap();
    assert_eq!((from.as_str(), to.as_str()), ("new", "familiar"));
    assert_eq!(source, "auto");
    assert_eq!(reason, "exposure_promotion");
}

#[test]
fn a_mastered_word_stops_accruing() {
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "mastered");
    read_across_chapters(&db, &sync, 6, "quiet");
    assert_eq!(mastery_of(&db).0, "mastered");
    assert_eq!(credit_of(&db), 0.0);
}

#[test]
fn a_skimmed_screen_never_becomes_evidence() {
    // A slow baseline first, then one screen read hundreds of times faster.
    // §2.4's speed rule runs at write time, so the fast screen's words must
    // never reach the exposures table at all.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    for index in 0..8 {
        flush(
            &db,
            &sync,
            &[screen("Chapter 1", &["slow"], START + index * DAY_MS)],
        );
    }
    flush(
        &db,
        &sync,
        &[ScreenExposureInput {
            word_count: 200,
            ended_at: START + 9 * DAY_MS + 1_000,
            ..screen("Chapter 2", &["quiet"], START + 9 * DAY_MS)
        }],
    );

    let seen: i64 = db
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM reading_word_exposures WHERE normalized_word = 'quiet'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(seen, 0);
    assert_eq!(mastery_of(&db).0, "new");
}

#[test]
fn with_no_pace_history_nothing_is_too_fast() {
    // The reader's first screen has no baseline to be fast against, and §2.4
    // breaks toward counting a reader it knows nothing about.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    flush(
        &db,
        &sync,
        &[ScreenExposureInput {
            word_count: 400,
            ended_at: START + 1_000,
            ..screen("Chapter 1", &["quiet"], START)
        }],
    );

    let (seen, _, _) = exposure_row(&db, "quiet");
    assert_eq!(seen, 1);
}

#[test]
fn an_idle_screen_never_becomes_evidence() {
    // Six minutes on one page with nobody touching anything: the reader left
    // the room, and §2.4's other exclusion says so.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    flush(
        &db,
        &sync,
        &[ScreenExposureInput {
            operation_count: 0,
            ended_at: START + 360_000,
            ..screen("Chapter 1", &["quiet"], START)
        }],
    );

    let seen: i64 = db
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM reading_word_exposures WHERE normalized_word = 'quiet'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(seen, 0);
}

#[test]
fn two_visits_on_one_day_count_as_one_day() {
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    flush(
        &db,
        &sync,
        &[
            screen("Chapter 1", &["quiet"], START),
            screen("Chapter 1", &["quiet"], START + 120_000),
        ],
    );
    flush(&db, &sync, &[screen("Chapter 1", &["quiet"], START + DAY_MS)]);

    let (seen, _, days) = exposure_row(&db, "quiet");
    assert_eq!(seen, 3);
    assert_eq!(days, 2);
}
