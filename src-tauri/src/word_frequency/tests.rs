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

/// Band 5 starts at rank 20 001, and it was unreachable while the table
/// stopped at 10 000 — the reason the table was widened to 50 000. Asserted
/// so that a future narrowing cannot silently take a whole band away from
/// every caller.
#[test]
fn the_table_reaches_band_five() {
    let rarest = table().values().map(|entry| entry.rank).max().unwrap();
    assert!(rarest > BAND_4_MAX_RANK, "rarest rank is {rarest}");
    assert!(table().values().any(|entry| entry.band == 5));
}

/// "OK" and "ok" are separate rows in the source, ranked 2 002 and 4 479,
/// and the same word once normalized. The commonest spelling has to win —
/// resolving it the other way would make "ok" look 2 500 places rarer.
#[test]
fn a_word_spelled_two_ways_upstream_keeps_its_better_rank() {
    let (_dir, db) = test_db();
    let entry = lookup(&db, "ok").unwrap().expect("\"ok\" is in the table");
    assert_eq!(entry.rank, 2002);
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

// The pairs below need a base the table knows and an inflection it does
// not, which the wider table made scarcer: "galloping", "hedging" and
// "cantering" are all inside 50 000 rows now. "quarrying" and "tarring" are
// still absent, and their bases sit comfortably mid-table.

#[test]
fn inflected_form_falls_back_via_word_forms_direct_row() {
    let (_dir, db) = test_db();
    // "quarrying" is not itself in the table, but a word_forms row keyed on
    // the exact queried spelling lists "quarry" (which is) among its forms —
    // the shape the AI produces when the reader looks up "quarrying" first.
    insert_word_forms(&db, "quarrying", &["quarry", "quarried", "quarries"]);

    let base = lookup(&db, "quarry").unwrap().expect("\"quarry\" is in the table");
    let inflected = lookup(&db, "quarrying")
        .unwrap()
        .expect("\"quarrying\" should resolve via word_forms to \"quarry\"");
    assert_eq!(base, inflected);
}

#[test]
fn inflected_form_falls_back_via_word_forms_reverse_row() {
    let (_dir, db) = test_db();
    // This time the row is keyed on the base form "quarry" (looked up
    // first), and "quarrying" only appears inside its forms list — the
    // reverse direction of the same relationship.
    insert_word_forms(&db, "quarry", &["quarrying", "quarried", "quarries"]);

    let base = lookup(&db, "quarry").unwrap().expect("\"quarry\" is in the table");
    let inflected = lookup(&db, "quarrying")
        .unwrap()
        .expect("\"quarrying\" should resolve via the reverse word_forms scan to \"quarry\"");
    assert_eq!(base, inflected);
}

#[test]
fn word_forms_pointing_nowhere_still_yields_unknown() {
    let (_dir, db) = test_db();
    // "quarrying" is linked only to another word that is *also* absent from
    // the table, so the fallback has nothing to resolve to.
    insert_word_forms(&db, "quarrying", &["tarring"]);

    let result = lookup(&db, "quarrying").unwrap();
    assert!(result.is_none());
}

#[test]
fn one_form_index_serves_a_whole_batch_of_words() {
    let (_dir, db) = test_db();
    // Two unrelated lexemes, one recorded in each direction, so a single
    // index has to answer both.
    insert_word_forms(&db, "quarry", &["quarrying", "quarried"]);
    insert_word_forms(&db, "tarring", &["tar", "tarred"]);

    let forms = FormIndex::new(&db);
    let quarry = lookup(&db, "quarry").unwrap().unwrap();
    let tar = lookup(&db, "tar").unwrap().unwrap();
    assert_eq!(lookup_with(&forms, "quarrying").unwrap(), Some(quarry));
    assert_eq!(lookup_with(&forms, "tarring").unwrap(), Some(tar));
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
fn the_table_parses_into_fifty_thousand_words_across_every_band() {
    let parsed = table();
    assert_eq!(
        parsed.len(),
        49_999,
        "the aggregated list is 50 000 rows, less the one that collapses into another"
    );
    let mut seen_bands: Vec<u8> = parsed.values().map(|entry| entry.band).collect();
    seen_bands.sort_unstable();
    seen_bands.dedup();
    assert_eq!(
        seen_bands,
        vec![1, 2, 3, 4, 5],
        "every band should have at least one word"
    );
    // Ranks are positions in a frequency ordering: no gaps below the top of
    // the range, and no two words claiming the same place.
    let mut ranks: Vec<u32> = parsed.values().map(|entry| entry.rank).collect();
    ranks.sort_unstable();
    ranks.dedup();
    assert_eq!(ranks.len(), parsed.len(), "ranks must be distinct");
    assert_eq!(ranks[0], 1);
}
