use rusqlite::params;
use tempfile::TempDir;

use super::*;
use crate::db::Db;

fn test_db() -> (TempDir, Db) {
    let dir = TempDir::new().unwrap();
    let db = Db::init(dir.path()).unwrap();
    (dir, db)
}

fn insert_word_forms(db: &Db, normalized_word: &str, forms: &[&str]) {
    let forms_json = serde_json::to_string(&forms).unwrap();
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO word_forms(normalized_word, forms, source, updated_at)
             VALUES (?1, ?2, 'model', ?3)",
            params![normalized_word, forms_json, 1_704_067_200_000_i64],
        )
        .unwrap();
}

#[test]
fn common_word_hits_a_low_band() {
    let (_dir, db) = test_db();
    let entry = lookup(&db, "the").unwrap().expect("\"the\" is in the fixture");
    assert_eq!(entry.band, 1);
    assert!(entry.rank <= BAND_1_MAX_RANK);
}

#[test]
fn rare_word_hits_a_high_band() {
    let (_dir, db) = test_db();
    let entry = lookup(&db, "sesquipedalian")
        .unwrap()
        .expect("\"sesquipedalian\" is in the fixture");
    assert_eq!(entry.band, 5);
    assert!(entry.rank > BAND_4_MAX_RANK);
}

#[test]
fn lookup_is_case_insensitive_and_trims_punctuation() {
    let (_dir, db) = test_db();
    let lower = lookup(&db, "the").unwrap().unwrap();
    let upper = lookup(&db, "THE").unwrap().unwrap();
    let punctuated = lookup(&db, "\"The,\"").unwrap().unwrap();
    assert_eq!(lower, upper);
    assert_eq!(lower, punctuated);
}

#[test]
fn unknown_word_is_none_not_rare() {
    let (_dir, db) = test_db();
    // Not in the fixture, and no word_forms row links it to anything that is.
    let result = lookup(&db, "zzznonexistentword").unwrap();
    assert!(
        result.is_none(),
        "a word absent from the table must be Unknown, never coerced into band 5"
    );
}

#[test]
fn inflected_form_falls_back_via_word_forms_direct_row() {
    let (_dir, db) = test_db();
    // "running" is not itself in the fixture, but a word_forms row keyed on
    // the exact queried spelling lists "run" (which is) among its forms —
    // the shape the AI produces when the reader looks up "running" first.
    insert_word_forms(&db, "running", &["run", "ran", "runs"]);

    let base = lookup(&db, "run").unwrap().expect("\"run\" is in the fixture");
    let inflected = lookup(&db, "running")
        .unwrap()
        .expect("\"running\" should resolve via word_forms to \"run\"");
    assert_eq!(base, inflected);
}

#[test]
fn inflected_form_falls_back_via_word_forms_reverse_row() {
    let (_dir, db) = test_db();
    // This time the row is keyed on the base form "run" (looked up first),
    // and "running" only appears inside its forms list — the reverse
    // direction of the same relationship.
    insert_word_forms(&db, "run", &["running", "ran", "runs"]);

    let base = lookup(&db, "run").unwrap().expect("\"run\" is in the fixture");
    let inflected = lookup(&db, "running")
        .unwrap()
        .expect("\"running\" should resolve via the reverse word_forms scan to \"run\"");
    assert_eq!(base, inflected);
}

#[test]
fn word_forms_pointing_nowhere_still_yields_unknown() {
    let (_dir, db) = test_db();
    // "running" is linked only to another word that is *also* absent from
    // the fixture, so the fallback has nothing to resolve to.
    insert_word_forms(&db, "running", &["jogging"]);

    let result = lookup(&db, "running").unwrap();
    assert!(result.is_none());
}

#[test]
fn one_form_index_serves_a_whole_batch_of_words() {
    let (_dir, db) = test_db();
    // Two unrelated lexemes, one recorded in each direction, so a single
    // index has to answer both.
    insert_word_forms(&db, "run", &["running", "ran"]);
    insert_word_forms(&db, "walking", &["walk", "walked"]);

    let forms = FormIndex::new(&db);
    let run = lookup(&db, "run").unwrap().unwrap();
    let walk = lookup(&db, "walk").unwrap().unwrap();
    assert_eq!(lookup_with(&forms, "running").unwrap(), Some(run));
    assert_eq!(lookup_with(&forms, "walking").unwrap(), Some(walk));
    assert_eq!(lookup_with(&forms, "the").unwrap().unwrap().band, 1);
    assert!(lookup_with(&forms, "zzznonexistentword").unwrap().is_none());
}

/// The scan is deferred until a word actually misses the frequency table.
/// Nothing observable distinguishes "did not scan" from "scanned" — except
/// making the scan impossible and watching the hit succeed anyway.
#[test]
fn a_word_the_table_already_knows_never_reads_word_forms() {
    let (_dir, db) = test_db();
    let forms = FormIndex::new(&db);
    db.conn
        .lock()
        .unwrap()
        .execute("DROP TABLE word_forms", [])
        .unwrap();

    assert_eq!(lookup_with(&forms, "the").unwrap().unwrap().band, 1);
    // And the deferred scan is genuinely what was skipped: a miss still
    // reaches for the table that is now gone.
    assert!(lookup_with(&forms, "zzznonexistentword").is_err());
}

#[test]
fn band_boundaries_match_documented_thresholds() {
    assert_eq!(band_for_rank(1), 1);
    assert_eq!(band_for_rank(BAND_1_MAX_RANK), 1);
    assert_eq!(band_for_rank(BAND_1_MAX_RANK + 1), 2);
    assert_eq!(band_for_rank(BAND_2_MAX_RANK), 2);
    assert_eq!(band_for_rank(BAND_2_MAX_RANK + 1), 3);
    assert_eq!(band_for_rank(BAND_3_MAX_RANK), 3);
    assert_eq!(band_for_rank(BAND_3_MAX_RANK + 1), 4);
    assert_eq!(band_for_rank(BAND_4_MAX_RANK), 4);
    assert_eq!(band_for_rank(BAND_4_MAX_RANK + 1), 5);
}

#[test]
fn fixture_parses_into_a_few_hundred_distinct_words_across_every_band() {
    let parsed = table();
    assert!(
        parsed.len() >= 300,
        "expected a few hundred fixture entries, got {}",
        parsed.len()
    );
    let mut seen_bands: Vec<u8> = parsed.values().map(|entry| entry.band).collect();
    seen_bands.sort_unstable();
    seen_bands.dedup();
    assert_eq!(seen_bands, vec![1, 2, 3, 4, 5], "every band should have at least one fixture word");
}
