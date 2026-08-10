//! Tests for the SQL half of the mastery engine.
//!
//! These drive `record_reading_behavior_batch_inner` rather than calling
//! `score_book_exposures` directly, because the thing most likely to break is
//! not the arithmetic — the parent module's tests cover that — but the seam:
//! whether the watermark holds, whether occurrence numbering survives being
//! split across flushes, and whether §2.4's exclusions still bite now that
//! something downstream consumes what they let through.

use rusqlite::{params, OptionalExtension};

use crate::commands::dictionary_glance::{record_dictionary_glance_inner, GlanceInput};
use crate::commands::lookup_history::{save_lookup_record_inner, LookupInput};
use crate::commands::reading_behavior::{record_reading_behavior_batch_inner, ScreenExposureInput};
use crate::db::Db;
use crate::sync::writer::SyncWriter;

use super::GlanceOutcome;

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

/// The reader stops and asks what a word means. `now` is the wall clock, so
/// tests that care about the repeat window move `last_lookup_at` instead of
/// pretending to control it — see [`backdate_lookup`].
fn look_up(db: &Db, sync: &SyncWriter, word: &str) {
    save_lookup_record_inner(
        LookupInput {
            book_id: BOOK.to_string(),
            lookup_text: word.to_string(),
            context_sentence: None,
            chapter: Some("Chapter 1".to_string()),
            cfi: None,
            definition: "a definition".to_string(),
            context_explanation: None,
            result_json: None,
            provider_profile_id: None,
            model: None,
        },
        db,
        sync,
    )
    .unwrap();
}

/// Pushes the stored lookup back in time, which is the only way to be on
/// either side of a seven-day window inside a test.
fn backdate_lookup(db: &Db, days: i64) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE mastery_progress SET last_lookup_at = last_lookup_at - ?1",
            params![days * DAY_MS],
        )
        .unwrap();
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
    flush(
        &db,
        &sync,
        &[screen("Chapter 4", &["dusk"], START + 4 * DAY_MS)],
    );

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
    flush(
        &db,
        &sync,
        &[screen("Chapter 11", &["quiet"], START + 11 * DAY_MS)],
    );

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
fn with_no_pace_history_only_the_relative_gate_stands_down() {
    // The reader's first screen has no baseline to be fast *against*, and
    // §2.4 breaks toward counting a reader it knows nothing about — so a
    // brisk-but-human 400 words in a minute still becomes evidence.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    flush(
        &db,
        &sync,
        &[ScreenExposureInput {
            word_count: 400,
            ended_at: START + 60_000,
            ..screen("Chapter 1", &["quiet"], START)
        }],
    );

    let (seen, _, _) = exposure_row(&db, "quiet");
    assert_eq!(seen, 1);
}

#[test]
fn a_page_turn_is_excluded_even_on_the_very_first_screen() {
    // This used to be the same case as the test above: 400 words gone in one
    // second is 24_000 wpm, and with no baseline the relative gate had
    // nothing to measure it against, so it was credited as evidence the
    // reader knows the word. `ABSOLUTE_MAX_WPM` does not need a baseline, so
    // the first screen is no longer a hole.
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

    let seen: i64 = db
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM reading_word_exposures WHERE normalized_word = 'quiet'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(seen, 0, "a page-turn must not become vocabulary evidence");
    assert_eq!(mastery_of(&db).0, "new");
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
    flush(
        &db,
        &sync,
        &[screen("Chapter 1", &["quiet"], START + DAY_MS)],
    );

    let (seen, _, days) = exposure_row(&db, "quiet");
    assert_eq!(seen, 3);
    assert_eq!(days, 2);
}

#[test]
fn looking_a_word_up_moves_it_back_one_tier() {
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "mastered");
    look_up(&db, &sync, "quiet");

    let (mastery, source, reason) = mastery_of(&db);
    assert_eq!(mastery, "familiar");
    assert_eq!(source, "auto");
    let detail: serde_json::Value = serde_json::from_str(&reason.unwrap()).unwrap();
    assert_eq!(detail["reason"], "lookup_demotion");
    assert_eq!(detail["book_title"], "Quiet Book");
}

#[test]
fn a_second_lookup_inside_the_window_goes_all_the_way_back_to_learning() {
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "mastered");
    look_up(&db, &sync, "quiet");
    look_up(&db, &sync, "quiet");

    let (mastery, _, reason) = mastery_of(&db);
    assert_eq!(mastery, "learning");
    let detail: serde_json::Value = serde_json::from_str(&reason.unwrap()).unwrap();
    assert_eq!(detail["reason"], "repeat_lookup_demotion");
    assert_eq!(detail["lookup_count"], 2);
}

#[test]
fn a_lookup_after_the_window_starts_a_fresh_chain() {
    // Eight days later is a reader who forgot the word once, not a reader
    // stuck on it — one tier, not straight back to learning.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "mastered");
    look_up(&db, &sync, "quiet");
    backdate_lookup(&db, 8);
    look_up(&db, &sync, "quiet");

    let (mastery, _, reason) = mastery_of(&db);
    assert_eq!(mastery, "learning", "familiar steps down to learning");
    let detail: serde_json::Value = serde_json::from_str(&reason.unwrap()).unwrap();
    assert_eq!(detail["reason"], "lookup_demotion");
    assert!(detail.get("lookup_count").is_none());
}

#[test]
fn a_lookup_discards_the_credit_reading_had_banked() {
    // Credit is evidence the reader knew the word; a lookup is them saying
    // otherwise, even when there is no tier left to take away.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "learning");
    read_across_chapters(&db, &sync, 3, "quiet");
    assert!((credit_of(&db) - 3.0).abs() < 1e-9);

    look_up(&db, &sync, "quiet");
    assert_eq!(credit_of(&db), 0.0);
    assert_eq!(mastery_of(&db).0, "learning", "learning is the floor");
}

#[test]
fn a_lookup_on_a_word_the_reader_never_saved_creates_a_watchlist_entry_and_scores_it() {
    // The observation zone (docs/impls/reading-flow-decisions-2026-08-06.md
    // §1): a first lookup is no longer a no-op. It creates a `vocab_words`
    // row the reader never consciously sees (`list_status = 'watchlist'`,
    // migration 044), and that row scores mastery exactly like any word the
    // reader saved themselves — it just isn't a reason to put the word on
    // the *list* the reader chose to keep, which is a separate thing
    // (`list_status`, not `mastery_progress`).
    let (_dir, db, sync) = fixture();
    look_up(&db, &sync, "quiet");

    let (word_id, list_status): (String, String) = db
        .reader()
        .query_row(
            "SELECT id, list_status FROM vocab_words WHERE book_id = ?1 AND word = 'quiet'",
            params![BOOK],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(list_status, "watchlist");

    let rows: i64 = db
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM mastery_progress WHERE vocab_word_id = ?1",
            params![word_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1, "a watchlist word scores mastery like any other");
    // `Tier::New` has no floor case of its own in `next_down` — it demotes to
    // Learning exactly like Familiar does — so the very first lookup still
    // logs the ordinary `lookup_demotion` event. The 3rd-lookup promotion
    // check hasn't fired yet (only one lookup so far), so that's the only
    // event on the timeline. This word was never `save_word()`-ed, so it
    // doesn't have the fixture's usual `WORD_ID` — read by the id we just got
    // back from the watchlist row instead of using the `mastery_of` helper.
    let (mastery, source, reason): (String, String, Option<String>) = db
        .reader()
        .query_row(
            "SELECT mastery, mastery_source, mastery_reason FROM vocab_words WHERE id = ?1",
            params![word_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(mastery, "learning");
    assert_eq!(source, "auto");
    let detail: serde_json::Value = serde_json::from_str(&reason.unwrap()).unwrap();
    assert_eq!(detail["reason"], "lookup_demotion");

    let events: i64 = db
        .reader()
        .query_row("SELECT COUNT(*) FROM mastery_events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(events, 1);
}

#[test]
fn a_lookup_in_one_book_clears_the_same_words_credit_in_another() {
    // The same word saved from two books is one entry to the reader. If a
    // lookup only reset the book it happened in, the other book's
    // half-finished promotion would still be standing.
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "learning");
    db.conn
        .lock()
        .unwrap()
        .execute_batch(
            "INSERT INTO books
                (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book-2', 'Other Book', 'Author', 'other.epub', 'reading', 5, 1, 1);
             INSERT INTO vocab_words
                (id, book_id, word, definition, mastery, review_count, created_at, updated_at)
             VALUES ('vocab-2', 'book-2', 'quiet', 'a definition', 'learning', 0, 2, 2);",
        )
        .unwrap();
    // Credit is banked against book-1's row; the lookup below also happens in
    // book-1, so book-2's row is the one that could be left behind.
    read_across_chapters(&db, &sync, 3, "quiet");

    look_up(&db, &sync, "quiet");
    let credits: Vec<f64> = {
        let conn = db.reader();
        let mut stmt = conn
            .prepare("SELECT credit FROM mastery_progress ORDER BY vocab_word_id")
            .unwrap();
        let rows = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<f64>, _>>()
            .unwrap();
        rows
    };
    assert_eq!(credits.len(), 2, "both rows carry progress");
    assert!(credits.iter().all(|credit| *credit == 0.0));
}

/// The reader single-clicks a word and reads the definition. `cfi` is what
/// the 60-second dedupe compares on, so passing `None` means "somewhere else
/// in the book" and every call counts.
fn glance(db: &Db, sync: &SyncWriter, word: &str, cfi: Option<&str>) -> GlanceOutcome {
    record_dictionary_glance_inner(
        GlanceInput {
            book_id: BOOK.to_string(),
            word: word.to_string(),
            definition: "a definition".to_string(),
            context_sentence: None,
            cfi: cfi.map(str::to_string),
        },
        db,
        sync,
    )
    .unwrap()
}

/// The glanced word's row, found by spelling rather than by [`WORD_ID`] —
/// a word the engine filed itself has an id nobody chose.
fn glanced_word(db: &Db, word: &str) -> Option<(String, String, String, Option<String>)> {
    db.reader()
        .query_row(
            "SELECT mastery, mastery_source, list_status, mastery_reason
               FROM vocab_words WHERE word = ?1 COLLATE NOCASE",
            params![word],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .unwrap()
}

#[test]
fn four_glances_file_an_untracked_word_into_the_watchlist_at_learning() {
    let (_dir, db, sync) = fixture();
    for _ in 0..3 {
        glance(&db, &sync, "quiet", None);
        assert!(
            glanced_word(&db, "quiet").is_none(),
            "three glances is not yet a pattern"
        );
    }

    let outcome = glance(&db, &sync, "quiet", None);
    assert!(outcome.entered_watchlist);
    assert_eq!(outcome.glance_count, 4);

    let (mastery, source, list_status, reason) = glanced_word(&db, "quiet").unwrap();
    // Learning, not new: the reader has demonstrably assessed this word four
    // times. And watchlist, not confirmed — they never chose to keep it.
    assert_eq!(mastery, "learning");
    assert_eq!(source, "auto");
    assert_eq!(list_status, "watchlist");
    let detail: serde_json::Value = serde_json::from_str(&reason.unwrap()).unwrap();
    assert_eq!(detail["reason"], "glance_entry");
    assert_eq!(detail["book_title"], "Quiet Book");
    assert_eq!(detail["glance_count"], 4);
}

#[test]
fn a_glance_never_enters_lookup_history() {
    // §4: every row in that table is a card the reader can reopen. A glance
    // has no card behind it, so a row there would be an entry in the history
    // list, and in exports, that opens onto nothing.
    let (_dir, db, sync) = fixture();
    for _ in 0..5 {
        glance(&db, &sync, "quiet", None);
    }
    let records: i64 = db
        .reader()
        .query_row("SELECT COUNT(*) FROM lookup_records", [], |row| row.get(0))
        .unwrap();
    assert_eq!(records, 0);
}

#[test]
fn reopening_the_same_menu_within_a_minute_is_one_glance() {
    let (_dir, db, sync) = fixture();
    let first = glance(&db, &sync, "quiet", Some("epubcfi(/6/4!/4/2/2)"));
    assert!(first.counted);

    let second = glance(&db, &sync, "quiet", Some("epubcfi(/6/4!/4/2/2)"));
    assert!(!second.counted);
    assert_eq!(second.glance_count, 1);

    // The same word further along the book is a different encounter with a
    // different sentence around it, and stopping at both is the evidence.
    let elsewhere = glance(&db, &sync, "quiet", Some("epubcfi(/6/8!/4/2/2)"));
    assert!(elsewhere.counted);
    assert_eq!(elsewhere.glance_count, 2);
}

#[test]
fn a_glance_on_a_tracked_word_halves_its_credit_without_moving_the_tier() {
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "new");
    read_across_chapters(&db, &sync, 3, "quiet");
    assert!((credit_of(&db) - 3.0).abs() < 1e-9);

    let outcome = glance(&db, &sync, "quiet", None);
    assert!(outcome.counted);
    assert!(!outcome.tier_changed);
    assert_eq!(mastery_of(&db).0, "new");
    assert!((credit_of(&db) - 1.5).abs() < 1e-9);
}

#[test]
fn two_glances_inside_the_window_cost_a_tracked_word_one_tier() {
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "mastered");

    assert!(!glance(&db, &sync, "quiet", None).tier_changed);
    assert_eq!(mastery_of(&db).0, "mastered");

    assert!(glance(&db, &sync, "quiet", None).tier_changed);
    let (mastery, source, reason) = mastery_of(&db);
    assert_eq!(mastery, "familiar");
    assert_eq!(source, "auto");
    // Both counts travel with the sentence, so the copy can say what the
    // reader actually did rather than calling two dictionary checks "lookups".
    let detail: serde_json::Value = serde_json::from_str(&reason.unwrap()).unwrap();
    assert_eq!(detail["reason"], "lookup_demotion");
    assert_eq!(detail["card_count"], 0);
    assert_eq!(detail["glance_count"], 2);
}

#[test]
fn a_card_and_a_glance_together_reach_the_repeat_rung() {
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "mastered");

    look_up(&db, &sync, "quiet");
    assert_eq!(mastery_of(&db).0, "familiar");
    glance(&db, &sync, "quiet", None);
    assert_eq!(mastery_of(&db).0, "familiar", "1.5 is short of the rung");

    glance(&db, &sync, "quiet", None);
    let (mastery, _, reason) = mastery_of(&db);
    assert_eq!(mastery, "learning");
    let detail: serde_json::Value = serde_json::from_str(&reason.unwrap()).unwrap();
    assert_eq!(detail["reason"], "repeat_lookup_demotion");
    assert_eq!(detail["card_count"], 1);
    assert_eq!(detail["glance_count"], 2);
}

#[test]
fn a_stale_chain_forgets_its_glances_too() {
    let (_dir, db, sync) = fixture();
    save_word(&db, "quiet", "mastered");

    glance(&db, &sync, "quiet", None);
    backdate_lookup(&db, 8);
    glance(&db, &sync, "quiet", None);
    assert_eq!(
        mastery_of(&db).0,
        "mastered",
        "two glances eight days apart are two separate moments of doubt"
    );
}
