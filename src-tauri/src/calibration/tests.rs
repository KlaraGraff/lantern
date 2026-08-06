use rusqlite::params;

use super::*;

const BOOK: &str = "book-1";

fn fixture() -> (tempfile::TempDir, Db) {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::init(dir.path()).unwrap();
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO books
                (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES (?1, 'Quiet Book', 'Author', 'book.epub', 'reading', 10, ?2, ?2)",
            params![BOOK, 1_700_000_000_000_i64],
        )
        .unwrap();
    (dir, db)
}

/// One finished screen: `words` words read, one minute of dwell.
fn insert_screen(db: &Db, id: &str, words: i64, started_at: i64) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO reading_screen_dwells
                (id, book_id, chapter, started_at, ended_at, dwell_ms,
                 operation_count, lookup_count, word_count, created_at)
             VALUES (?1, ?2, 'Chapter 1', ?3, ?3 + 60000, 60000, 1, 0, ?4, ?3)",
            params![id, BOOK, started_at, words],
        )
        .unwrap();
}

/// One lookup record with `count` accumulated lookups.
fn insert_lookup(db: &Db, id: &str, normalized_text: &str, count: i64) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO lookup_records
                (id, book_id, lookup_text, normalized_text, definition,
                 created_at, last_looked_up_at, lookup_count)
             VALUES (?1, ?2, ?2, ?3, 'a definition', 1700000000000, 1700000000000, ?4)",
            params![id, BOOK, normalized_text, count],
        )
        .unwrap();
}

// -- guardrail 1: insufficient sample -> default -------------------------

/// Below MIN_WORDS_FOR_LOOKUP_RATE, the rate must stay unset — never a rate
/// built from a handful of words.
#[test]
fn too_few_words_leaves_the_lookup_rate_unset() {
    let (_dir, db) = fixture();
    insert_screen(&db, "s1", MIN_WORDS_FOR_LOOKUP_RATE - 1, 1_700_000_000_000);
    insert_lookup(&db, "l1", "quiet", 3);

    let conn = db.reader();
    let calibration = compute(&conn, 1_700_000_100_000).unwrap();
    assert_eq!(calibration.lookup_rate_per_1000, None);
    assert_eq!(
        calibration.lookup_rate_sample_words,
        MIN_WORDS_FOR_LOOKUP_RATE - 1
    );
}

/// Clearing the floor by one word is enough to compute a rate.
#[test]
fn clearing_the_word_floor_computes_a_rate() {
    let (_dir, db) = fixture();
    insert_screen(&db, "s1", MIN_WORDS_FOR_LOOKUP_RATE, 1_700_000_000_000);
    insert_lookup(&db, "l1", "quiet", 15);

    let conn = db.reader();
    let calibration = compute(&conn, 1_700_000_100_000).unwrap();
    assert_eq!(
        calibration.lookup_rate_per_1000,
        Some(15.0 * 1000.0 / MIN_WORDS_FOR_LOOKUP_RATE as f64)
    );
}

/// Below MIN_SCREENS_FOR_SPEED, the median stays unset.
#[test]
fn too_few_screens_leaves_the_reading_speed_unset() {
    let (_dir, db) = fixture();
    for index in 0..(MIN_SCREENS_FOR_SPEED - 1) {
        insert_screen(
            &db,
            &format!("s{index}"),
            200,
            1_700_000_000_000 + index * 60_000,
        );
    }

    let conn = db.reader();
    let calibration = compute(&conn, 1_700_000_100_000).unwrap();
    assert_eq!(calibration.reading_speed_wpm, None);
    assert_eq!(
        calibration.reading_speed_sample_screens,
        MIN_SCREENS_FOR_SPEED - 1
    );
}

/// A calibration with no rate yet (or an out-of-range one) must scale
/// exposures as if nothing had changed — 1.0, never a guess.
#[test]
fn lookup_rate_scale_is_neutral_with_no_calibration_data() {
    assert_eq!(lookup_rate_scale(None), 1.0);
}

/// [`load`] on a database that has never been recomputed (migration 046's
/// seeded row) must read as "no calibration yet", not error and not
/// fabricate a rate.
#[test]
fn loading_a_never_recomputed_database_reads_as_unset() {
    let (_dir, db) = fixture();
    let calibration = load(&db).unwrap();
    assert_eq!(calibration.lookup_rate_per_1000, None);
    assert_eq!(calibration.reading_speed_wpm, None);
    assert_eq!(calibration.updated_at, 0);
}

// -- guardrail 2: recompute never rewrites history ------------------------

/// Recompute only ever writes `local_calibration`. A word already scored to
/// Familiar before a recompute changes the stored rate must stay exactly
/// where it was — recompute has no code path into `mastery_progress` or
/// `vocab_words` at all, which this proves by writing state there first and
/// showing it is byte-for-byte unchanged after recompute runs.
#[test]
fn recompute_never_touches_already_scored_mastery_state() {
    let (_dir, db) = fixture();
    insert_screen(&db, "s1", MIN_WORDS_FOR_LOOKUP_RATE, 1_700_000_000_000);
    insert_lookup(&db, "l1", "quiet", 1); // low rate

    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO vocab_words
                (id, book_id, word, definition, mastery, review_count, created_at, updated_at)
             VALUES ('vocab-1', ?1, 'quiet', 'def', 'familiar', 0, 1700000000000, 1700000000000)",
            params![BOOK],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO mastery_progress
                (vocab_word_id, credit, last_lookup_at, lookups_in_window, updated_at)
             VALUES ('vocab-1', 3.5, NULL, 0, 1700000000000)",
            [],
        )
        .unwrap();
    }

    let before: (String, f64) = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT mastery, credit FROM vocab_words
               JOIN mastery_progress ON mastery_progress.vocab_word_id = vocab_words.id
              WHERE vocab_words.id = 'vocab-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    // A recompute that would very much like to change the reader's lookup
    // rate (and therefore, on the next scoring pass, future credit).
    recompute(&db, 1_700_000_200_000).unwrap();
    let calibration = load(&db).unwrap();
    assert!(calibration.lookup_rate_per_1000.is_some());

    let after: (String, f64) = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT mastery, credit FROM vocab_words
               JOIN mastery_progress ON mastery_progress.vocab_word_id = vocab_words.id
              WHERE vocab_words.id = 'vocab-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(before, after);
}

/// `maybe_recompute_daily` is a no-op inside the interval, and only advances
/// `updated_at` when it actually runs.
#[test]
fn maybe_recompute_daily_only_runs_once_per_interval() {
    let (_dir, db) = fixture();
    insert_screen(&db, "s1", MIN_WORDS_FOR_LOOKUP_RATE, 1_700_000_000_000);

    let ran_first = maybe_recompute_daily(&db, 1_700_000_100_000).unwrap();
    assert!(ran_first);
    let after_first = load(&db).unwrap();
    assert_eq!(after_first.updated_at, 1_700_000_100_000);

    let ran_again_soon = maybe_recompute_daily(&db, 1_700_000_100_000 + 1_000).unwrap();
    assert!(!ran_again_soon);
    let unchanged = load(&db).unwrap();
    assert_eq!(unchanged.updated_at, 1_700_000_100_000);

    let ran_next_day =
        maybe_recompute_daily(&db, 1_700_000_100_000 + RECOMPUTE_INTERVAL_MS + 1).unwrap();
    assert!(ran_next_day);
}

// -- lookup_rate_scale formula --------------------------------------------

#[test]
fn lookup_rate_scale_hits_the_two_design_doc_anchors() {
    assert!((lookup_rate_scale(Some(LOW_RATE_PER_1000)) - MIN_SCALE).abs() < 1e-9);
    assert!((lookup_rate_scale(Some(HIGH_RATE_PER_1000)) - MAX_SCALE).abs() < 1e-9);
}

/// The neutral point is the geometric mean of the two anchors, where the
/// scale is exactly 1.0 — today's unscaled behavior.
#[test]
fn lookup_rate_scale_is_neutral_at_the_geometric_mean() {
    let neutral_rate = (LOW_RATE_PER_1000 * HIGH_RATE_PER_1000).sqrt();
    assert!((lookup_rate_scale(Some(neutral_rate)) - 1.0).abs() < 1e-9);
}

/// Monotonic across the whole domain, including past the anchors where the
/// function is clamped flat.
#[test]
fn lookup_rate_scale_is_monotonic_non_decreasing() {
    let samples = [0.1, 0.5, 1.0, 2.0, 3.87, 5.0, 10.0, 15.0, 20.0, 100.0];
    let mut previous = lookup_rate_scale(Some(samples[0]));
    for &rate in &samples[1..] {
        let scale = lookup_rate_scale(Some(rate));
        assert!(
            scale >= previous - 1e-12,
            "scale dropped between rates: {previous} -> {scale}"
        );
        previous = scale;
    }
}

/// Rates outside [1, 15] clamp to the anchor scale rather than extrapolating
/// past what the two design-doc examples actually support.
#[test]
fn lookup_rate_scale_clamps_outside_the_anchor_range() {
    assert_eq!(
        lookup_rate_scale(Some(0.1)),
        lookup_rate_scale(Some(LOW_RATE_PER_1000))
    );
    assert_eq!(
        lookup_rate_scale(Some(500.0)),
        lookup_rate_scale(Some(HIGH_RATE_PER_1000))
    );
}

/// The structural guarantee the task requires: every rate at or below the
/// neutral (geometric-mean) point scales to at most 1.0 — a low-lookup-rate
/// reader's credit can only ever be discounted, never inflated, by this
/// signal.
#[test]
fn low_lookup_rates_never_exceed_the_neutral_scale() {
    let neutral_rate = (LOW_RATE_PER_1000 * HIGH_RATE_PER_1000).sqrt();
    for &rate in &[0.01, 0.5, 1.0, 2.0, 3.0, neutral_rate] {
        assert!(
            lookup_rate_scale(Some(rate)) <= 1.0 + 1e-9,
            "rate {rate} scaled above neutral"
        );
    }
}

/// Every output stays inside the bounded [MIN_SCALE, MAX_SCALE] range
/// regardless of input, including degenerate ones.
#[test]
fn lookup_rate_scale_output_is_always_bounded() {
    for &rate in &[f64::MIN_POSITIVE, 0.0, -5.0, f64::NAN, f64::INFINITY, 1e12] {
        let scale = lookup_rate_scale(Some(rate));
        assert!(
            (MIN_SCALE..=MAX_SCALE).contains(&scale) || scale == 1.0,
            "scale {scale} out of bounds for rate {rate}"
        );
    }
}
