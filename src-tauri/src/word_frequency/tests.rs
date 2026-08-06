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
    let entry = lookup(&db, "the").unwrap().expect("\"the\" is in the table");
    assert_eq!(entry.band, 1);
    assert!(entry.rank <= BAND_1_MAX_RANK);
}

#[test]
fn rare_word_hits_a_high_band() {
    let (_dir, db) = test_db();
    let entry = lookup(&db, "gallop").unwrap().expect("\"gallop\" is in the table");
    assert_eq!(entry.band, 4);
    assert!(entry.rank > BAND_3_MAX_RANK);
}

/// Band 5 starts at rank 20 001 and the shipped table stops at 10 000, so
/// nothing in it can reach that band today. Asserted rather than left
/// implicit: if a later, wider table changes this, the failure should say
/// so out loud instead of quietly altering what every caller sees.
#[test]
fn todays_table_cannot_reach_band_five() {
    let rarest = table().values().map(|entry| entry.rank).max().unwrap();
    assert!(rarest <= BAND_4_MAX_RANK, "rarest rank is {rarest}");
    assert!(table().values().all(|entry| entry.band <= 4));
}

/// "OK" and "ok" are separate rows upstream, ranked 1 984 and 4 370, and the
/// same word once normalized. The commonest spelling has to win — resolving
/// it by file order would make "ok" look three thousand places rarer.
#[test]
fn a_word_spelled_two_ways_upstream_keeps_its_better_rank() {
    let (_dir, db) = test_db();
    let entry = lookup(&db, "ok").unwrap().expect("\"ok\" is in the table");
    assert_eq!(entry.rank, 1983);
    assert_eq!(lookup(&db, "OK").unwrap().unwrap(), entry);
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
    // Not in the table, and no word_forms row links it to anything that is.
    let result = lookup(&db, "zzznonexistentword").unwrap();
    assert!(
        result.is_none(),
        "a word absent from the table must be Unknown, never coerced into band 5"
    );
}

#[test]
fn inflected_form_falls_back_via_word_forms_direct_row() {
    let (_dir, db) = test_db();
    // "galloping" is not itself in the table, but a word_forms row keyed on
    // the exact queried spelling lists "gallop" (which is) among its forms —
    // the shape the AI produces when the reader looks up "galloping" first.
    insert_word_forms(&db, "galloping", &["gallop", "galloped", "gallops"]);

    let base = lookup(&db, "gallop").unwrap().expect("\"gallop\" is in the table");
    let inflected = lookup(&db, "galloping")
        .unwrap()
        .expect("\"galloping\" should resolve via word_forms to \"gallop\"");
    assert_eq!(base, inflected);
}

#[test]
fn inflected_form_falls_back_via_word_forms_reverse_row() {
    let (_dir, db) = test_db();
    // This time the row is keyed on the base form "gallop" (looked up
    // first), and "galloping" only appears inside its forms list — the
    // reverse direction of the same relationship.
    insert_word_forms(&db, "gallop", &["galloping", "galloped", "gallops"]);

    let base = lookup(&db, "gallop").unwrap().expect("\"gallop\" is in the table");
    let inflected = lookup(&db, "galloping")
        .unwrap()
        .expect("\"galloping\" should resolve via the reverse word_forms scan to \"gallop\"");
    assert_eq!(base, inflected);
}

#[test]
fn word_forms_pointing_nowhere_still_yields_unknown() {
    let (_dir, db) = test_db();
    // "galloping" is linked only to another word that is *also* absent from
    // the table, so the fallback has nothing to resolve to.
    insert_word_forms(&db, "galloping", &["cantering"]);

    let result = lookup(&db, "galloping").unwrap();
    assert!(result.is_none());
}

#[test]
fn one_form_index_serves_a_whole_batch_of_words() {
    let (_dir, db) = test_db();
    // Two unrelated lexemes, one recorded in each direction, so a single
    // index has to answer both.
    insert_word_forms(&db, "gallop", &["galloping", "galloped"]);
    insert_word_forms(&db, "hedging", &["hedge", "hedged"]);

    let forms = FormIndex::new(&db);
    let gallop = lookup(&db, "gallop").unwrap().unwrap();
    let hedge = lookup(&db, "hedge").unwrap().unwrap();
    assert_eq!(lookup_with(&forms, "galloping").unwrap(), Some(gallop));
    assert_eq!(lookup_with(&forms, "hedging").unwrap(), Some(hedge));
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
fn the_table_parses_into_ten_thousand_words_across_bands_one_to_four() {
    let parsed = table();
    assert_eq!(
        parsed.len(),
        9999,
        "the published list is 10 000 rows, less the one that collapses into another"
    );
    let mut seen_bands: Vec<u8> = parsed.values().map(|entry| entry.band).collect();
    seen_bands.sort_unstable();
    seen_bands.dedup();
    assert_eq!(
        seen_bands,
        vec![1, 2, 3, 4],
        "every band the table can reach should have at least one word"
    );
    // Ranks are positions in a published ordering: no gaps below the top of
    // the range, and no two words claiming the same place.
    let mut ranks: Vec<u32> = parsed.values().map(|entry| entry.rank).collect();
    ranks.sort_unstable();
    ranks.dedup();
    assert_eq!(ranks.len(), parsed.len(), "ranks must be distinct");
    assert_eq!(ranks[0], 1);
}
