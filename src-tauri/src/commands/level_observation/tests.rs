use super::*;

use rusqlite::params;
use tempfile::TempDir;

const DAY: i64 = DAY_MS;
/// A fixed "now" so nothing in these tests depends on the wall clock.
const NOW: i64 = 1_760_000_000_000;

// Real entries from `src/word_frequency/english-fiction.tsv`, chosen by rank
// so the band each one lands in is a fact about the shipped table rather than
// an assumption. Band 1 is ranks 1–1000, band 4 is 5001–20000, band 5 is
// 20001 and up.
const BAND_1_WORDS: [&str; 6] = ["read", "fine", "lady", "top", "real", "different"];
const BAND_4_WORDS: [&str; 3] = ["slumber", "craved", "uniformed"];
const BAND_5_WORDS: [&str; 5] = ["naga", "dike", "exes", "foals", "worshipful"];

fn test_db() -> (TempDir, Db) {
    let dir = TempDir::new().unwrap();
    let db = Db::init(dir.path()).unwrap();
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book', 'Book', 'Author', 'books/book.epub', 'reading', 0, 1, 1)",
            [],
        )
        .unwrap();
    (dir, db)
}

fn set_level(db: &Db, level: &str) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO settings (key, value) VALUES ('cefr_level', ?1)
             ON CONFLICT(key) DO UPDATE SET value = ?1",
            params![level],
        )
        .unwrap();
}

/// `count` lookup rows spread over `words`, all at `at`.
fn insert_lookups(db: &Db, words: &[&str], count: usize, at: i64, tag: &str) {
    let conn = db.conn.lock().unwrap();
    for index in 0..count {
        let word = words[index % words.len()];
        conn.execute(
            "INSERT INTO lookup_records
                (id, book_id, lookup_text, normalized_text, chapter, cfi, definition,
                 created_at, last_looked_up_at, lookup_count)
             VALUES (?1, 'book', ?2, ?2, 'Chapter 1', ?3, '', ?4, ?4, 1)",
            params![
                format!("{tag}-{index}"),
                word,
                format!("epubcfi(/6/{tag}/{index})"),
                at
            ],
        )
        .unwrap();
    }
}

fn insert_book(db: &Db, id: &str) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES (?1, 'Book', 'Author', ?2, 'reading', 0, 1, 1)",
            params![id, format!("books/{id}.epub")],
        )
        .unwrap();
}

fn insert_exposure_in(db: &Db, book: &str, word: &str, encounters: i64, on_lookup_active: i64, at: i64) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO reading_word_exposures
                (id, book_id, chapter, normalized_word, encounter_count,
                 encounters_on_lookup_active_screen, first_seen_at, last_seen_at,
                 created_at, updated_at)
             VALUES (?1, ?6, 'Chapter 1', ?2, ?3, ?4, ?5, ?5, ?5, ?5)",
            params![
                format!("exposure-{book}-{word}"),
                word,
                encounters,
                on_lookup_active,
                at,
                book
            ],
        )
        .unwrap();
}

fn insert_exposure(db: &Db, word: &str, encounters: i64, on_lookup_active: i64, at: i64) {
    insert_exposure_in(db, "book", word, encounters, on_lookup_active, at);
}

fn summary(lookups: [i64; 6], passed: [i64; 6], looked_up_words: [i64; 6]) -> RecordSummary {
    RecordSummary {
        lookups_by_band: lookups,
        looked_up_words_by_band: looked_up_words,
        passed_by_band: passed,
        topical_lookups: 0,
        span_days: 60,
    }
}

/// The observation as the local mode computes it — the shape almost every
/// test below asserts on. AI-mode tests call
/// [`get_level_observation_inner`] themselves with `ai_available: true`.
fn observe(db: &Db, now: i64) -> Option<LevelObservation> {
    get_level_observation_inner(db, now, false).unwrap().0
}

/// A cached AI verdict, as a finished classification pass would have left it.
fn insert_verdict(db: &Db, word: &str, book: &str, verdict: &str) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO level_word_classifications
                (normalized_word, book_id, verdict, classified_at, batch_id)
             VALUES (?1, ?2, ?3, 1, 'test-batch')",
            params![word, book, verdict],
        )
        .unwrap();
}

// ---------------------------------------------------------------------------
// The wire contract.
// ---------------------------------------------------------------------------

/// The frontend reads this object field by field
/// (`src/pages/reading-stats/level-observation.ts`), and a row whose keys do
/// not match simply never renders — no error, no log, just a missing row. So
/// the key names are pinned here, exactly and exhaustively: a rename on
/// either side has to break this test before it can break the page.
#[test]
fn serialized_keys_match_the_frontend_contract() {
    let observation = LevelObservation {
        kind: LevelObservationKind::DeclaredHigh,
        declared_level: "B2".to_string(),
        suggested_level: Some("A2".to_string()),
        band: Some(2),
        band_from: Some(1_001),
        band_to: Some(3_000),
        passed_words: None,
        total_lookups: Some(40),
        concentrated_lookups: Some(30),
        topical_lookups: Some(7),
        window_days: 90,
        word_class_source: WordClassSource::Ai,
    };
    let value = serde_json::to_value(&observation).unwrap();
    let object = value.as_object().unwrap();

    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "band",
            "bandFrom",
            "bandTo",
            "concentratedLookups",
            "declaredLevel",
            "kind",
            "passedWords",
            "suggestedLevel",
            "topicalLookups",
            "totalLookups",
            "windowDays",
            "wordClassSource",
        ]
    );

    // Nullable fields must serialize as JSON null, not vanish: the frontend
    // reads `observation.passedWords ?? 0`, which needs the key to be there.
    assert!(object["passedWords"].is_null());
    // And the fields this variant does fill carry their numbers through.
    assert_eq!(object["totalLookups"], 40);
    assert_eq!(object["concentratedLookups"], 30);
    assert_eq!(object["topicalLookups"], 7);
    // The classifier's name crosses the wire as the frontend's two strings.
    assert_eq!(object["wordClassSource"], "ai");
}

#[test]
fn the_three_kinds_serialize_as_the_frontends_three_strings() {
    let of = |kind| serde_json::to_value(kind).unwrap();
    assert_eq!(of(LevelObservationKind::Unclear), "unclear");
    assert_eq!(of(LevelObservationKind::DeclaredHigh), "declaredHigh");
    assert_eq!(of(LevelObservationKind::DeclaredLow), "declaredLow");
}

#[test]
fn band_windows_are_the_ones_the_copy_names() {
    assert_eq!(band_rank_window(1), Some((1, 1_000)));
    assert_eq!(band_rank_window(2), Some((1_001, 3_000)));
    assert_eq!(band_rank_window(3), Some((3_001, 5_000)));
    assert_eq!(band_rank_window(4), Some((5_001, 20_000)));
    // Band 5's top is the table's own last rank, not infinity.
    assert_eq!(band_rank_window(5), Some((20_001, 50_000)));
    assert_eq!(band_rank_window(6), None);
}

// ---------------------------------------------------------------------------
// The floor.
// ---------------------------------------------------------------------------

#[test]
fn an_empty_record_produces_no_row_at_all() {
    let (_dir, db) = test_db();
    assert_eq!(observe(&db, NOW), None);
}

#[test]
fn too_few_lookups_is_silence_not_unclear() {
    let record = summary([0, 0, 0, 0, 8, 0], [0; 6], [0; 6]);
    assert_eq!(judge(&record, "B1"), None);
}

#[test]
fn one_weekend_of_lookups_is_silence_however_many_there_are() {
    let mut record = summary([0, 0, 0, 0, 200, 0], [0; 6], [0; 6]);
    record.span_days = MIN_SPAN_DAYS - 1;
    assert_eq!(judge(&record, "B1"), None);
}

// ---------------------------------------------------------------------------
// The three verdicts.
// ---------------------------------------------------------------------------

#[test]
fn lookups_piled_into_an_easy_band_read_as_declared_high() {
    // 30 of 40 lookups in band 2, declared B2 (band 4).
    let record = summary([0, 0, 30, 0, 10, 0], [0; 6], [0; 6]);
    let observation = judge(&record, "B2").expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredHigh);
    assert_eq!(observation.suggested_level.as_deref(), Some("A2"));
    assert_eq!(observation.band, Some(2));
    assert_eq!(observation.band_from, Some(1_001));
    assert_eq!(observation.band_to, Some(3_000));
    // The receipt: both counts, measured against the reader's own record.
    assert_eq!(observation.total_lookups, Some(40));
    assert_eq!(observation.concentrated_lookups, Some(30));
    // Only the fields this variant's sentence uses are filled.
    assert_eq!(observation.passed_words, None);
}

#[test]
fn the_same_pile_inside_the_declared_level_is_not_a_remark() {
    // Identical record, but the reader declared B1 — band 2 is not below
    // B1's own band by enough to be "should not need looking up", and the
    // easy bands are not empty either, so nothing is concluded.
    let record = summary([0, 0, 30, 0, 10, 0], [0; 6], [0; 6]);
    assert_eq!(judge(&record, "A2"), None);
}

#[test]
fn a_thin_pile_in_an_easy_band_is_not_enough_to_claim_declared_high() {
    // 24 lookups in band 2 out of 40: under HIGH_MIN_BAND_LOOKUPS, and only
    // 60% — the share passes, the count does not.
    let record = summary([0, 0, 24, 0, 16, 0], [0; 6], [0; 6]);
    assert_eq!(judge(&record, "B2"), None);
}

#[test]
fn walking_past_hard_words_reads_as_declared_low() {
    // Declared B1 (band 3). 80 band-5 words read past twice or more against
    // 10 band-5 words actually looked up.
    let record = summary([0, 0, 0, 10, 30, 80], [0, 0, 0, 0, 0, 80], [0, 0, 0, 5, 20, 10]);
    let observation = judge(&record, "B1").expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredLow);
    assert_eq!(observation.suggested_level.as_deref(), Some("C1"));
    assert_eq!(observation.band, Some(5));
    assert_eq!(observation.passed_words, Some(80));
    // This variant's sentence counts words read past, not lookups.
    assert_eq!(observation.total_lookups, None);
    assert_eq!(observation.concentrated_lookups, None);
}

#[test]
fn the_hardest_qualifying_band_wins_not_the_first() {
    // Both band 4 and band 5 clear the bar; §5.3 says the hardest words the
    // reader gets through are the indicator, so band 5 is the answer.
    let record = summary(
        [0, 0, 0, 5, 30, 5],
        [0, 0, 0, 0, 90, 70],
        [0, 0, 0, 5, 5, 5],
    );
    let observation = judge(&record, "A2").expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredLow);
    assert_eq!(observation.band, Some(5));
}

#[test]
fn passing_hard_words_while_also_stopping_at_them_proves_nothing() {
    // 80 passed against 40 stopped is 67% — under LOW_MIN_PASSED_SHARE.
    let record = summary([0, 0, 0, 10, 30, 40], [0, 0, 0, 0, 0, 80], [0, 0, 0, 5, 20, 40]);
    assert_eq!(judge(&record, "B1"), None);
}

#[test]
fn a_lopsided_hard_band_record_reads_as_unclear() {
    // 44 of 48 lookups in band 5, bands 1–3 empty. Declared C1, so band 5 is
    // neither easy nor hard relative to the declaration — and there is no
    // exposure evidence to say whether the silence in bands 1–3 is knowledge
    // or absence.
    let record = summary([0, 0, 0, 0, 4, 44], [0; 6], [0; 6]);
    let observation = judge(&record, "C1").expect("row");
    assert_eq!(observation.kind, LevelObservationKind::Unclear);
    // "This is a conclusion, not a failure" — but there is nothing to press.
    assert_eq!(observation.suggested_level, None);
    assert_eq!(observation.band, Some(5));
    assert_eq!(observation.total_lookups, Some(48));
    assert_eq!(observation.concentrated_lookups, Some(44));
    assert_eq!(observation.window_days, 60);
}

#[test]
fn a_record_with_real_easy_band_lookups_is_not_unclear() {
    // The unclear sentence claims bands 1–3 have almost no record. Here they
    // hold a fifth of the lookups, so that sentence would be false and no
    // row is produced rather than a wrong one.
    let record = summary([0, 4, 4, 4, 8, 30], [0; 6], [0; 6]);
    assert_eq!(judge(&record, "C1"), None);
}

#[test]
fn c2_is_never_suggested() {
    // Band 5 is the table's last band, so nothing here can tell a C1 from a
    // C2 — the row declines to guess rather than suggesting the top level.
    let record = summary([0, 0, 0, 5, 5, 30], [0, 0, 0, 0, 0, 90], [0, 0, 0, 0, 0, 5]);
    let observation = judge(&record, "B2").expect("row");
    assert_eq!(observation.suggested_level.as_deref(), Some("C1"));
}

// ---------------------------------------------------------------------------
// The topical screen.
// ---------------------------------------------------------------------------

fn spread(total: i64, top: i64) -> BookSpread {
    BookSpread {
        total,
        top,
        top_book: Some("book".to_string()),
    }
}

#[test]
fn a_recurring_single_book_rare_word_is_topical() {
    assert!(is_topical(4, Some(&spread(9, 9)), 1));
    assert!(is_topical(5, Some(&spread(6, 5)), 1));
    // Band 3 is the boundary band, and it is inside the screen.
    assert!(is_topical(3, Some(&spread(9, 9)), 0));
}

#[test]
fn common_band_words_are_never_topical() {
    // Recurrence carries no signal in bands 1–2 — common words recur in
    // every book — so no amount of it convicts.
    assert!(!is_topical(1, Some(&spread(90, 90)), 1));
    assert!(!is_topical(2, Some(&spread(90, 90)), 1));
}

#[test]
fn a_word_looked_up_in_two_books_is_the_readers_own_gap() {
    assert!(!is_topical(5, Some(&spread(12, 12)), 2));
}

#[test]
fn a_word_met_across_the_shelf_is_not_topical() {
    // 10 sightings, largest book holds 5 — no single book owns this word.
    assert!(!is_topical(4, Some(&spread(10, 5)), 1));
}

#[test]
fn a_hard_word_seen_only_a_few_times_stays_general() {
    assert!(!is_topical(5, Some(&spread(5, 5)), 1));
    // And no sighting evidence at all defaults the same way.
    assert!(!is_topical(5, None, 1));
}

#[test]
fn the_screened_out_count_travels_with_the_lookup_variants() {
    // declaredHigh carries it…
    let mut record = summary([0, 0, 30, 0, 10, 0], [0; 6], [0; 6]);
    record.topical_lookups = 7;
    let observation = judge(&record, "B2").expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredHigh);
    assert_eq!(observation.topical_lookups, Some(7));

    // …unclear carries it…
    let mut record = summary([0, 0, 0, 0, 4, 44], [0; 6], [0; 6]);
    record.topical_lookups = 7;
    let observation = judge(&record, "C1").expect("row");
    assert_eq!(observation.kind, LevelObservationKind::Unclear);
    assert_eq!(observation.topical_lookups, Some(7));

    // …and declaredLow, whose receipt counts passed words rather than
    // lookups, does not.
    let mut record = summary([0, 0, 0, 10, 30, 80], [0, 0, 0, 0, 0, 80], [0, 0, 0, 5, 20, 10]);
    record.topical_lookups = 7;
    let observation = judge(&record, "B1").expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredLow);
    assert_eq!(observation.topical_lookups, None);
}

/// A C1 reader working through one specialized book: 30 lookups over three
/// band-4 words, plus 10 band-5 lookups for the floor to almost clear.
fn specialized_book_record(db: &Db) {
    set_level(db, "C1");
    insert_lookups(db, &BAND_4_WORDS, 30, NOW - 30 * DAY, "jargon");
    insert_lookups(db, &BAND_5_WORDS, 10, NOW - 2 * DAY, "rare");
}

#[test]
fn one_books_own_vocabulary_is_screened_out_of_the_judgment() {
    let (_dir, db) = test_db();
    specialized_book_record(&db);
    // Without sighting evidence the screen stays out of the way: the band-4
    // pile reads as declaredHigh against the declared C1.
    let observation = observe(&db, NOW).expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredHigh);
    assert_eq!(observation.band, Some(4));

    // The same record, but the book demonstrably keeps using those three
    // words. They are its terminology, not evidence — and the ten general
    // lookups left are under the floor, so the answer is silence.
    for word in BAND_4_WORDS {
        insert_exposure(&db, word, 9, 0, NOW - 10 * DAY);
    }
    assert_eq!(observe(&db, NOW), None);
}

#[test]
fn a_word_recurring_across_books_stays_evidence() {
    let (_dir, db) = test_db();
    specialized_book_record(&db);
    insert_book(&db, "other");
    // The same sighting totals, but split evenly across two books — no
    // single book owns these words, so they stay in the record and the
    // remark stands.
    for word in BAND_4_WORDS {
        insert_exposure_in(&db, "book", word, 5, 0, NOW - 10 * DAY);
        insert_exposure_in(&db, "other", word, 5, 0, NOW - 10 * DAY);
    }
    let observation = observe(&db, NOW).expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredHigh);
    assert_eq!(observation.band, Some(4));
}

#[test]
fn the_receipt_names_what_was_screened_out() {
    let (_dir, db) = test_db();
    // 45 band-1 lookups — enough to carry declaredHigh on their own — plus
    // 10 band-4 lookups established as one book's terminology.
    set_level(&db, "B2");
    insert_lookups(&db, &BAND_1_WORDS, 45, NOW - 30 * DAY, "easy");
    insert_lookups(&db, &BAND_4_WORDS, 10, NOW - 2 * DAY, "jargon");
    for word in BAND_4_WORDS {
        insert_exposure(&db, word, 9, 0, NOW - 10 * DAY);
    }
    let observation = observe(&db, NOW).expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredHigh);
    // The totals shrink to the kept record, and the difference is stated.
    assert_eq!(observation.total_lookups, Some(45));
    assert_eq!(observation.concentrated_lookups, Some(45));
    assert_eq!(observation.topical_lookups, Some(10));
}

#[test]
fn a_passed_word_the_book_itself_drilled_is_not_low_evidence() {
    let (_dir, db) = test_db();
    // Nine sightings in one book, four of them lookup-active, never looked
    // up: a passed candidate — but the recurrence that qualified it also
    // convicts it as the book's own vocabulary.
    insert_exposure(&db, BAND_5_WORDS[0], 9, 4, NOW - 5 * DAY);
    // Three sightings stay under the recurrence bar: an ordinary hard word,
    // still counted.
    insert_exposure(&db, BAND_5_WORDS[1], 3, 1, NOW - 5 * DAY);

    let raw = {
        let conn = db.reader();
        collect(&conn, NOW, WordClassSource::Local).unwrap()
    };
    let (record, _) = score(&raw, &db, NOW, WordClassSource::Local).unwrap();
    assert_eq!(record.passed_by_band[5], 1);
}

// ---------------------------------------------------------------------------
// AI word-class mode.
// ---------------------------------------------------------------------------

/// AI mode as `get_level_observation` invokes it: the setting untouched
/// (AI is the default) and a configured provider claimed.
fn observe_with_ai(db: &Db, now: i64) -> (Option<LevelObservation>, Vec<Candidate>) {
    get_level_observation_inner(db, now, true).unwrap()
}

#[test]
fn an_ai_general_verdict_keeps_a_word_the_heuristic_would_screen() {
    let (_dir, db) = test_db();
    specialized_book_record(&db);
    for word in BAND_4_WORDS {
        insert_exposure(&db, word, 9, 0, NOW - 10 * DAY);
    }
    // The heuristic alone screens the band-4 pile and falls silent — the
    // shipped local behavior, retested here as the baseline.
    assert_eq!(observe(&db, NOW), None);

    // The AI read the same words against the book's title and judged them
    // ordinary vocabulary. The verdict overrides the recurrence evidence and
    // the remark comes back.
    for word in BAND_4_WORDS {
        insert_verdict(&db, word, "book", "general");
    }
    let (observation, _) = observe_with_ai(&db, NOW);
    let observation = observation.expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredHigh);
    assert_eq!(observation.band, Some(4));
    assert_eq!(observation.topical_lookups, Some(0));
    assert_eq!(observation.word_class_source, WordClassSource::Ai);
}

#[test]
fn an_ai_topical_verdict_screens_a_word_the_heuristic_would_keep() {
    let (_dir, db) = test_db();
    // 45 band-1 lookups plus 10 band-4 lookups with *no* exposure evidence —
    // the heuristic has nothing on them, so locally they stay in the record.
    set_level(&db, "B2");
    insert_lookups(&db, &BAND_1_WORDS, 45, NOW - 30 * DAY, "easy");
    insert_lookups(&db, &BAND_4_WORDS, 10, NOW - 2 * DAY, "jargon");
    let local = observe(&db, NOW).expect("row");
    assert_eq!(local.total_lookups, Some(55));
    assert_eq!(local.word_class_source, WordClassSource::Local);

    // The AI knows the book and calls those three words its terminology —
    // screened without any recurrence having been needed.
    for word in BAND_4_WORDS {
        insert_verdict(&db, word, "book", "topical");
    }
    let (observation, _) = observe_with_ai(&db, NOW);
    let observation = observation.expect("row");
    assert_eq!(observation.total_lookups, Some(45));
    assert_eq!(observation.concentrated_lookups, Some(45));
    assert_eq!(observation.topical_lookups, Some(10));
}

#[test]
fn words_awaiting_a_verdict_fall_back_to_the_heuristic_and_are_nominated() {
    let (_dir, db) = test_db();
    specialized_book_record(&db);
    for word in BAND_4_WORDS {
        insert_exposure(&db, word, 9, 0, NOW - 10 * DAY);
    }
    // No verdicts cached yet: the judgment is exactly the local one…
    let (observation, candidates) = observe_with_ai(&db, NOW);
    assert_eq!(observation, None);
    // …and every hard word with a nameable book is nominated for the pass,
    // each exactly once however many lookup rows it holds.
    let mut words: Vec<&str> = candidates
        .iter()
        .map(|candidate| candidate.word.as_str())
        .collect();
    words.sort_unstable();
    let mut expected: Vec<&str> = BAND_4_WORDS.iter().chain(BAND_5_WORDS.iter()).copied().collect();
    expected.sort_unstable();
    assert_eq!(words, expected);
    assert!(candidates
        .iter()
        .all(|candidate| candidate.book_id == "book"));
}

#[test]
fn a_word_with_a_verdict_is_not_nominated_again() {
    let (_dir, db) = test_db();
    specialized_book_record(&db);
    insert_verdict(&db, BAND_4_WORDS[0], "book", "topical");
    let (_, candidates) = observe_with_ai(&db, NOW);
    assert!(candidates
        .iter()
        .all(|candidate| candidate.word != BAND_4_WORDS[0]));
}

#[test]
fn local_mode_ignores_verdicts_and_nominates_nothing() {
    let (_dir, db) = test_db();
    specialized_book_record(&db);
    // A cached verdict that would screen the band-4 words if it were read…
    for word in BAND_4_WORDS {
        insert_verdict(&db, word, "book", "topical");
    }
    // …is not read: without AI available the mode is local, the verdicts
    // stay cold, and nothing is nominated to be classified.
    let (observation, candidates) = get_level_observation_inner(&db, NOW, false).unwrap();
    let observation = observation.expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredHigh);
    assert_eq!(observation.topical_lookups, Some(0));
    assert_eq!(observation.word_class_source, WordClassSource::Local);
    assert!(candidates.is_empty());
}

#[test]
fn the_local_setting_turns_ai_mode_off_even_with_a_provider() {
    let (_dir, db) = test_db();
    specialized_book_record(&db);
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO settings (key, value) VALUES ('level_observation_word_class', 'local')",
            [],
        )
        .unwrap();
    let (observation, candidates) = observe_with_ai(&db, NOW);
    assert_eq!(
        observation.expect("row").word_class_source,
        WordClassSource::Local
    );
    assert!(candidates.is_empty());
}

#[test]
fn a_passed_word_with_a_topical_verdict_is_not_low_evidence() {
    let (_dir, db) = test_db();
    // Three sightings only — under the heuristic's recurrence bar, so
    // locally this word counts as read past.
    insert_exposure(&db, BAND_5_WORDS[0], 3, 1, NOW - 5 * DAY);
    insert_verdict(&db, BAND_5_WORDS[0], "book", "topical");

    let raw = {
        let conn = db.reader();
        collect(&conn, NOW, WordClassSource::Ai).unwrap()
    };
    let (record, candidates) = score(&raw, &db, NOW, WordClassSource::Ai).unwrap();
    assert_eq!(record.passed_by_band[5], 0);
    assert!(candidates.is_empty());
}

#[test]
fn a_word_looked_up_in_two_books_is_never_sent_to_the_ai() {
    let (_dir, db) = test_db();
    insert_book(&db, "other");
    set_level(&db, "B2");
    insert_lookups(&db, &BAND_1_WORDS, 45, NOW - 30 * DAY, "easy");
    // The same band-4 word looked up in both books: the reader's own gap by
    // the hard gate, so no candidate — and a stray cached verdict for one of
    // the books could not screen it either.
    insert_lookups(&db, &[BAND_4_WORDS[0]], 1, NOW - 2 * DAY, "here");
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO lookup_records
                (id, book_id, lookup_text, normalized_text, chapter, cfi, definition,
                 created_at, last_looked_up_at, lookup_count)
             VALUES ('elsewhere-0', 'other', ?1, ?1, 'Chapter 1', 'epubcfi(/6/x/0)', '', ?2, ?2, 1)",
            params![BAND_4_WORDS[0], NOW - 3 * DAY],
        )
        .unwrap();
    insert_verdict(&db, BAND_4_WORDS[0], "book", "topical");

    let (observation, candidates) = observe_with_ai(&db, NOW);
    let observation = observation.expect("row");
    // Both lookup rows stay in the record: 45 easy + 2 of the hard word.
    assert_eq!(observation.total_lookups, Some(47));
    assert_eq!(observation.topical_lookups, Some(0));
    assert!(candidates
        .iter()
        .all(|candidate| candidate.word != BAND_4_WORDS[0]));
}

// ---------------------------------------------------------------------------
// End to end, against real tables and the real frequency table.
// ---------------------------------------------------------------------------

/// A record that clears every bar for `declaredHigh`, dated relative to
/// `at`: 30 band-1 lookups and 10 band-4 ones, spanning a month.
fn record_that_produces_a_row(db: &Db, at: i64, tag: &str) {
    set_level(db, "B2");
    insert_lookups(
        db,
        &BAND_1_WORDS,
        30,
        at - 30 * DAY,
        &format!("{tag}-easy"),
    );
    insert_lookups(db, &BAND_4_WORDS, 10, at - 2 * DAY, &format!("{tag}-hard"));
}

#[test]
fn a_real_record_of_easy_lookups_produces_the_row() {
    let (_dir, db) = test_db();
    record_that_produces_a_row(&db, NOW, "one");

    let observation = observe(&db, NOW).expect("row");
    assert_eq!(observation.kind, LevelObservationKind::DeclaredHigh);
    assert_eq!(observation.declared_level, "B2");
    assert_eq!(observation.suggested_level.as_deref(), Some("A1"));
    assert_eq!(observation.band, Some(1));
    assert_eq!(observation.band_from, Some(1));
    assert_eq!(observation.band_to, Some(1_000));
    // 30 of the 40 lookups on record sit in band 1.
    assert_eq!(observation.total_lookups, Some(40));
    assert_eq!(observation.concentrated_lookups, Some(30));
    // Reported as the span actually on record, not the nominal 90.
    assert_eq!(observation.window_days, 31);
}

#[test]
fn the_declared_level_defaults_to_b1_when_it_was_never_set() {
    let (_dir, db) = test_db();
    insert_lookups(&db, &BAND_1_WORDS, 30, NOW - 30 * DAY, "easy");
    insert_lookups(&db, &BAND_4_WORDS, 10, NOW - 2 * DAY, "hard");
    let observation = observe(&db, NOW).expect("row");
    assert_eq!(observation.declared_level, "B1");
}

#[test]
fn only_exposures_that_are_real_evidence_count_as_read_past() {
    let (_dir, db) = test_db();
    // Counts: met twice, and at least once on a screen where the reader had
    // the dictionary open for some other word.
    insert_exposure(&db, BAND_5_WORDS[0], 3, 1, NOW - 5 * DAY);
    // Met only once — not "read past twice or more".
    insert_exposure(&db, BAND_5_WORDS[1], 1, 1, NOW - 5 * DAY);
    // Never on a lookup-active screen: no evidence the reader was in a mood
    // to stop for anything at all.
    insert_exposure(&db, BAND_5_WORDS[2], 9, 0, NOW - 5 * DAY);
    // Met plenty, but this one was looked up — so it was not read past.
    insert_exposure(&db, BAND_5_WORDS[3], 9, 4, NOW - 5 * DAY);
    insert_lookups(&db, &[BAND_5_WORDS[3]], 1, NOW - 6 * DAY, "stopped");
    // Outside the window entirely.
    insert_exposure(&db, BAND_5_WORDS[4], 9, 4, NOW - 200 * DAY);

    let raw = {
        let conn = db.reader();
        collect(&conn, NOW, WordClassSource::Local).unwrap()
    };
    let (record, _) = score(&raw, &db, NOW, WordClassSource::Local).unwrap();
    assert_eq!(record.passed_by_band[5], 1);
}

// ---------------------------------------------------------------------------
// Dismissal.
// ---------------------------------------------------------------------------

#[test]
fn stopped_silences_the_row_for_good() {
    let (_dir, db) = test_db();
    record_that_produces_a_row(&db, NOW, "one");
    assert!(observe(&db, NOW).is_some());

    dismiss_level_observation_inner(&db, "stopped", NOW).unwrap();
    assert_eq!(observe(&db, NOW), None);

    // Not a snooze. A year later, with a fresh record that would otherwise
    // produce exactly this remark again, it is still off.
    record_that_produces_a_row(&db, NOW + 365 * DAY, "later");
    assert_eq!(observe(&db, NOW + 365 * DAY), None);
}

#[test]
fn keeping_silences_the_same_remark_for_three_months_then_lets_it_back() {
    let (_dir, db) = test_db();
    record_that_produces_a_row(&db, NOW, "one");
    assert!(observe(&db, NOW).is_some());
    dismiss_level_observation_inner(&db, "kept", NOW).unwrap();
    assert_eq!(observe(&db, NOW + DAY), None);

    // A second batch of the same evidence, so what is being tested at the
    // far end is the suppression and not the 90-day reading window rolling
    // the first batch out from under it.
    record_that_produces_a_row(&db, NOW + 88 * DAY, "later");
    assert_eq!(
        observe(&db, NOW + 89 * DAY),
        None,
        "one day short of three months, still quiet"
    );
    assert!(
        observe(&db, NOW + 91 * DAY).is_some(),
        "past three months the same remark may be made again"
    );
}

#[test]
fn applying_silences_the_same_remark_too() {
    let (_dir, db) = test_db();
    record_that_produces_a_row(&db, NOW, "one");
    assert!(observe(&db, NOW).is_some());

    // The frontend writes the new level itself and then calls in; this
    // command must not be the thing that moved it.
    dismiss_level_observation_inner(&db, "applied", NOW).unwrap();
    assert_eq!(observe(&db, NOW + DAY), None);
}

#[test]
fn dismissing_never_writes_the_level_setting() {
    let (_dir, db) = test_db();
    record_that_produces_a_row(&db, NOW, "one");
    let before: String = db
        .reader()
        .query_row(
            "SELECT value FROM settings WHERE key = 'cefr_level'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    for outcome in ["applied", "kept", "stopped"] {
        dismiss_level_observation_inner(&db, outcome, NOW).unwrap();
    }
    let after: String = db
        .reader()
        .query_row(
            "SELECT value FROM settings WHERE key = 'cefr_level'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(before, after, "the row never moves the reader's level");
    assert_eq!(before, "B2");
}

#[test]
fn a_markedly_different_verdict_gets_through_the_suppression_window() {
    let (_dir, db) = test_db();
    record_that_produces_a_row(&db, NOW, "one");
    let first = observe(&db, NOW).expect("row");
    assert_eq!(first.band, Some(1));
    dismiss_level_observation_inner(&db, "kept", NOW).unwrap();
    assert_eq!(observe(&db, NOW + DAY), None);

    // The record moves: the easy-band lookups are now band 2, not band 1.
    // That is a different thing to be told, so it is allowed through before
    // the three months are up.
    db.conn
        .lock()
        .unwrap()
        .execute("DELETE FROM lookup_records WHERE id LIKE 'one-easy-%'", [])
        .unwrap();
    // "cottage" is rank 2255 — band 2.
    insert_lookups(&db, &["cottage"], 30, NOW - 30 * DAY, "mid");

    let second = observe(&db, NOW + DAY).expect("a different remark is not the dismissed one");
    assert_eq!(second.kind, LevelObservationKind::DeclaredHigh);
    assert_eq!(second.band, Some(2));
}

#[test]
fn an_unknown_outcome_is_rejected_rather_than_guessed_at() {
    let (_dir, db) = test_db();
    assert!(dismiss_level_observation_inner(&db, "maybe", NOW).is_err());
}
