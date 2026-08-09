use std::collections::{HashMap, HashSet};

use rusqlite::params;
use tempfile::TempDir;

use super::*;
use crate::commands::book_difficulty::{count_word_tallies, write_word_counts};

fn test_db() -> (TempDir, Db) {
    let directory = TempDir::new().unwrap();
    let db = Db::init(directory.path()).unwrap();
    (directory, db)
}

fn insert_book(db: &Db, id: &str, title: &str, progress: i32) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO books (
                 id, title, author, file_path, source_format, render_format,
                 status, progress, created_at, updated_at
             ) VALUES (?1, ?2, 'Author', 'books/b.epub', 'epub', 'epub', 'reading', ?3, 1, 1)",
            params![id, title, progress],
        )
        .unwrap();
}

/// A vocabulary row, and optionally the half-finished credit behind it.
fn insert_vocab(db: &Db, id: &str, word: &str, mastery: &str, credit: Option<f64>) {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO vocab_words (id, book_id, word, definition, mastery, created_at, updated_at)
         VALUES (?1, 'book', ?2, 'def', ?3, 1, 1)",
        params![id, word, mastery],
    )
    .unwrap();
    if let Some(credit) = credit {
        conn.execute(
            "INSERT INTO mastery_progress (vocab_word_id, credit, updated_at) VALUES (?1, ?2, 1)",
            params![id, credit],
        )
        .unwrap();
    }
}

fn insert_lookup(db: &Db, id: &str, book_id: &str, word: &str, created_at: i64) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO lookup_records (
                 id, book_id, lookup_text, normalized_text, cfi, created_at, last_looked_up_at
             ) VALUES (?1, ?2, ?3, ?3, ?1, ?4, ?4)",
            params![id, book_id, word, created_at],
        )
        .unwrap();
}

fn insert_exposure(db: &Db, id: &str, book_id: &str, word: &str, encounters: i64) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO reading_word_exposures (
                 id, book_id, chapter, normalized_word, encounter_count,
                 first_seen_at, last_seen_at, created_at, updated_at
             ) VALUES (?1, ?2, 'one', ?3, ?4, 1, 1, 1, ?4)",
            params![id, book_id, word, encounters],
        )
        .unwrap();
}

fn profile_of(mastered: &[&str], familiar: &[&str]) -> ReaderProfile {
    ReaderProfile {
        mastered: mastered.iter().map(|word| word.to_string()).collect(),
        familiar: familiar.iter().map(|word| word.to_string()).collect(),
        baseline_books: 0,
        updated_at: None,
    }
}

fn names_of(names: &[&str]) -> HashSet<String> {
    names.iter().map(|name| name.to_string()).collect()
}

fn tally(tokens: i64, capitalized: i64) -> WordTally {
    WordTally {
        tokens,
        capitalized,
    }
}

#[test]
fn a_form_that_is_capitalized_every_time_and_unlisted_is_a_name() {
    let profile = ReaderProfile::default();
    assert_eq!(
        classify("heathcliff", tally(438, 438), false, &profile, &names_of(&[])),
        Bucket::Name
    );
}

#[test]
fn a_word_that_merely_opens_a_sentence_is_not_a_name() {
    // 12 occurrences, 3 of them sentence-initial: an ordinary word.
    let profile = ReaderProfile::default();
    assert_eq!(
        classify("nevertheless", tally(12, 3), false, &profile, &names_of(&[])),
        Bucket::Unknown
    );
}

#[test]
fn a_word_the_frequency_table_knows_is_never_a_name() {
    // Every occurrence capitalized, but the table has heard of it — a chapter
    // title's worth of "Winter" must not become a proper noun.
    let profile = ReaderProfile::default();
    assert_eq!(
        classify("winter", tally(4, 4), true, &profile, &names_of(&[])),
        Bucket::Unknown
    );
}

#[test]
fn the_alias_table_makes_a_name_regardless_of_casing_evidence() {
    let profile = ReaderProfile::default();
    assert_eq!(
        classify(
            "queequeg",
            tally(9, 2),
            false,
            &profile,
            &names_of(&["queequeg"])
        ),
        Bucket::Name
    );
}

#[test]
fn a_word_is_counted_in_exactly_one_row_strongest_first() {
    // Same word qualifying three ways at once. Mastery wins over the name
    // rule, and the name rule wins over credit — otherwise the four rows
    // would add up to more than the book.
    let both = profile_of(&["ahab"], &["ahab"]);
    assert_eq!(
        classify("ahab", tally(5, 5), false, &both, &names_of(&["ahab"])),
        Bucket::Mastered
    );

    let credit_only = profile_of(&[], &["ahab"]);
    assert_eq!(
        classify("ahab", tally(5, 5), false, &credit_only, &names_of(&["ahab"])),
        Bucket::Name
    );
}

#[test]
fn the_four_rows_add_up_to_the_whole_book() {
    let counts: HashMap<String, WordTally> = [
        ("the".to_string(), tally(6_000, 40)),
        ("whale".to_string(), tally(300, 12)),
        ("ahab".to_string(), tally(500, 500)),
        ("cetology".to_string(), tally(12, 1)),
        ("gunwale".to_string(), tally(41, 2)),
    ]
    .into_iter()
    .collect();
    let listed: HashSet<String> = ["the", "whale", "cetology", "gunwale"]
        .iter()
        .map(|word| word.to_string())
        .collect();
    let profile = profile_of(&["the", "whale"], &["cetology"]);

    let result = tally_coverage(&counts, &listed, &profile, &names_of(&[]));

    assert_eq!(result.total_tokens, 6_853);
    assert_eq!(result.distinct_words, 5);
    assert_eq!(result.mastered_tokens, 6_300);
    assert_eq!(result.familiar_tokens, 12);
    assert_eq!(result.name_tokens, 500);
    assert_eq!(result.unknown_tokens, 41);
    assert_eq!(result.name_words, 1);
    assert_eq!(result.unknown_words, 1);
    assert_eq!(
        result.mastered_tokens + result.familiar_tokens + result.name_tokens + result.unknown_tokens,
        result.total_tokens
    );
}

#[test]
fn only_the_capitalized_words_of_an_alias_become_names() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Wuthering Heights", 30);
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO book_person_aliases (id, book_id, canonical, alias, source, created_at, kind)
             VALUES ('a1', 'book', 'Thrushcross Grange', 'the Grange', 'auto', 1, 'name'),
                    ('a2', 'book', 'Heathcliff', 'the master of the house', 'user', 1, 'description')",
            [],
        )
        .unwrap();

    let names = load_alias_names(&db, "book").unwrap();

    assert!(names.contains("thrushcross"));
    assert!(names.contains("grange"));
    assert!(names.contains("heathcliff"));
    // A description row is not a name, and folding it in whole would declare
    // "the" a proper noun — several percent of a novel, handed over for free.
    assert!(!names.contains("the"));
    assert!(!names.contains("master"));
    assert!(!names.contains("house"));
}

#[test]
fn an_alias_from_another_book_is_not_this_books_name() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Moby-Dick", 10);
    insert_book(&db, "other", "Wuthering Heights", 10);
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO book_person_aliases (id, book_id, canonical, alias, source, created_at, kind)
             VALUES ('a1', 'other', 'Heathcliff', 'Heathcliff', 'auto', 1, 'name')",
            [],
        )
        .unwrap();

    assert!(load_alias_names(&db, "book").unwrap().is_empty());
}

#[test]
fn the_word_list_survives_the_round_trip_with_its_casing() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);
    let counts = count_word_tallies(["Ahab spoke. Ahab left. The whale left."]);
    write_word_counts(&db, "book", &counts, Some("sha")).unwrap();

    let (stored, sha) = load_word_counts(&db, "book").unwrap();

    assert_eq!(sha.as_deref(), Some("sha"));
    assert_eq!(stored.get("ahab"), Some(&tally(2, 2)));
    assert_eq!(stored.get("left"), Some(&tally(2, 0)));
    assert_eq!(stored.get("the"), Some(&tally(1, 1)));
}

#[test]
fn the_frequency_table_answers_which_forms_it_knows() {
    let (_directory, db) = test_db();
    let counts: HashMap<String, WordTally> = [
        ("house".to_string(), tally(10, 0)),
        ("qquzzlebrick".to_string(), tally(3, 3)),
    ]
    .into_iter()
    .collect();

    let listed = listed_forms(&db, &counts, |_| {}).unwrap();

    assert!(listed.contains("house"));
    assert!(!listed.contains("qquzzlebrick"));
}

#[test]
fn mastery_tiers_are_the_mastered_set_and_lower_tiers_are_not() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);
    insert_vocab(&db, "v1", "Whale", "mastered", None);
    insert_vocab(&db, "v2", "gunwale", "familiar", None);
    insert_vocab(&db, "v3", "binnacle", "learning", None);
    insert_vocab(&db, "v4", "ambergris", "new", None);

    let profile = load_reader_profile(&db).unwrap();

    assert!(profile.mastered.contains("whale"));
    assert!(profile.mastered.contains("gunwale"));
    assert!(!profile.mastered.contains("binnacle"));
    assert!(!profile.mastered.contains("ambergris"));
}

#[test]
fn half_the_credit_to_a_tier_is_familiar_enough_and_less_is_not() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);
    insert_vocab(&db, "v1", "cetology", "new", Some(FAMILIAR_ENOUGH_CREDIT));
    insert_vocab(&db, "v2", "squall", "learning", Some(FAMILIAR_ENOUGH_CREDIT - 0.1));

    let profile = load_reader_profile(&db).unwrap();

    assert!(profile.familiar.contains("cetology"));
    assert!(!profile.familiar.contains("squall"));
}

#[test]
fn a_word_the_reader_has_looked_up_is_not_familiar_however_much_credit_it_has() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);
    insert_vocab(&db, "v1", "harpooneer", "new", Some(99.0));
    insert_lookup(&db, "l1", "book", "harpooneer", 1_700_000_000_000);

    let profile = load_reader_profile(&db).unwrap();

    assert!(profile.familiar.is_empty());
}

#[test]
fn an_already_mastered_word_is_never_counted_a_second_time_as_familiar() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);
    // Two rows for one word — the same word saved from two books, which is
    // one entry to the reader.
    insert_vocab(&db, "v1", "leviathan", "mastered", None);
    insert_vocab(&db, "v2", "leviathan", "new", Some(99.0));

    let profile = load_reader_profile(&db).unwrap();

    assert!(profile.mastered.contains("leviathan"));
    assert!(profile.familiar.is_empty());
}

#[test]
fn books_read_counts_the_books_the_evidence_came_from() {
    let (_directory, db) = test_db();
    insert_book(&db, "one", "Charlotte's Web", 12);
    insert_book(&db, "two", "Animal Farm", 4);
    insert_exposure(&db, "e1", "one", "barn", 6);
    insert_exposure(&db, "e2", "one", "spider", 3);
    insert_exposure(&db, "e3", "two", "windmill", 5);

    assert_eq!(load_reader_profile(&db).unwrap().baseline_books, 2);
}

#[test]
fn the_summary_names_the_only_book_read_and_stops_naming_it_at_two() {
    let (_directory, db) = test_db();
    insert_book(&db, "one", "Charlotte's Web", 12);
    insert_book(&db, "two", "Animal Farm", 4);
    insert_exposure(&db, "e1", "one", "barn", 6);
    insert_exposure(&db, "e2", "one", "spider", 3);
    insert_lookup(&db, "l1", "one", "sedative", 1_700_000_000_000);
    insert_lookup(&db, "l2", "one", "salutations", 1_700_200_000_000);
    insert_vocab(&db, "v1", "sedative", "new", None);

    let alone = load_vocab_profile_summary(&db).unwrap();
    assert_eq!(alone.books_read, 1);
    assert_eq!(alone.single_book_title.as_deref(), Some("Charlotte's Web"));
    assert_eq!(alone.single_book_progress, Some(12));
    assert_eq!(alone.exposure_tokens, 9);
    assert_eq!(alone.exposure_words, 2);
    assert_eq!(alone.lookup_records, 2);
    assert_eq!(alone.lookup_days, 2);
    assert_eq!(alone.vocab_words, 1);
    assert_eq!(alone.reviewed_words, 0);

    insert_exposure(&db, "e3", "two", "windmill", 5);
    let paired = load_vocab_profile_summary(&db).unwrap();
    assert_eq!(paired.books_read, 2);
    assert_eq!(paired.single_book_title, None);
    assert_eq!(paired.single_book_progress, None);
}

#[test]
fn the_expanded_list_holds_unknown_words_and_neither_names_nor_owned_ones() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);
    insert_vocab(&db, "v1", "Whale", "mastered", None);
    write_word_counts(
        &db,
        "book",
        &count_word_tallies(["Ahab met the harpooneer. Ahab liked the whale."]),
        Some("sha"),
    )
    .unwrap();

    let words = load_unknown_words(&db, "book", true).unwrap();
    let forms: Vec<&str> = words.iter().map(|word| word.word.as_str()).collect();

    assert!(forms.contains(&"harpooneer"), "{forms:?}");
    assert!(!forms.contains(&"ahab"), "a name is not a word to learn");
    assert!(!forms.contains(&"whale"), "already mastered");
}

#[test]
fn the_familiar_band_joins_the_list_only_once_the_reader_stops_counting_it() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);
    insert_vocab(&db, "v1", "cetology", "new", Some(FAMILIAR_ENOUGH_CREDIT));
    write_word_counts(
        &db,
        "book",
        &count_word_tallies(["cetology and cetology"]),
        Some("sha"),
    )
    .unwrap();

    let counted = load_unknown_words(&db, "book", true).unwrap();
    assert!(counted.iter().all(|word| word.word != "cetology"));

    let uncounted = load_unknown_words(&db, "book", false).unwrap();
    let row = uncounted
        .iter()
        .find(|word| word.word == "cetology")
        .unwrap();
    assert!(row.familiar);
    assert_eq!(row.tokens, 2);
}

#[test]
fn every_row_carries_the_evidence_its_chip_is_written_from() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);
    insert_vocab(&db, "v1", "binnacle", "new", None);
    insert_exposure(&db, "e1", "book", "binnacle", 6);
    insert_lookup(&db, "l1", "book", "binnacle", 1_700_000_000_000);
    write_word_counts(
        &db,
        "book",
        &count_word_tallies(["binnacle binnacle binnacle"]),
        Some("sha"),
    )
    .unwrap();

    let words = load_unknown_words(&db, "book", true).unwrap();
    let row = words.iter().find(|word| word.word == "binnacle").unwrap();

    assert_eq!(row.tokens, 3);
    assert_eq!(row.gloss.as_deref(), Some("def"));
    assert_eq!(row.encounters, 6);
    assert_eq!(row.lookups, 1);
    assert!(!row.familiar);
}

#[test]
fn the_list_is_commonest_first_and_settles_ties_alphabetically() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);
    write_word_counts(
        &db,
        "book",
        &count_word_tallies(["scrimshaw gam scrimshaw gam scrimshaw gam davit"]),
        Some("sha"),
    )
    .unwrap();

    let words = load_unknown_words(&db, "book", true).unwrap();
    let forms: Vec<&str> = words.iter().map(|word| word.word.as_str()).collect();

    assert_eq!(forms, vec!["gam", "scrimshaw", "davit"]);
}

#[test]
fn a_book_whose_words_were_never_counted_asks_for_nothing() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);

    assert!(load_unknown_words(&db, "book", true).unwrap().is_empty());
}

#[test]
fn an_untouched_device_reports_nothing_rather_than_zeroes_it_invented() {
    let (_directory, db) = test_db();

    let summary = load_vocab_profile_summary(&db).unwrap();

    assert_eq!(summary, VocabProfileSummary::default());
    assert_eq!(summary.updated_at, None);
}

/// The dialog's two columns, checked against what the delete actually does
/// rather than against the intention behind it: a promise that the word list
/// survives is only worth the row count that is still there afterwards.
#[test]
fn the_clearing_dialog_counts_what_the_clear_really_takes_and_leaves() {
    let (_directory, db) = test_db();
    insert_book(&db, "book", "Book", 0);
    // Two tiers the scorer set, one the reader set themselves.
    insert_vocab(&db, "auto-1", "gam", "familiar", Some(2.5));
    insert_vocab(&db, "auto-2", "davit", "mastered", Some(6.0));
    insert_vocab(&db, "mine", "scrimshaw", "mastered", None);
    db.conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE vocab_words SET mastery_source = 'auto' WHERE id LIKE 'auto-%'",
            [],
        )
        .unwrap();
    insert_exposure(&db, "e1", "book", "gam", 4);
    insert_exposure(&db, "e2", "book", "davit", 3);
    store(
        &db,
        "book",
        CoverageStatus::Done,
        &CoverageTally::default(),
        None,
        Some("sha"),
        None,
    )
    .unwrap();

    let preview = load_clear_preview(&db).unwrap();
    assert_eq!(preview.auto_mastery_words, 2);
    assert_eq!(preview.exposure_records, 2);
    assert_eq!(preview.computed_books, 1);
    assert_eq!(preview.manual_words, 1);
    assert_eq!(preview.vocab_words, 3);

    let cleared = clear_vocab_profile_inner(&db, "device", 99, |_, _| {}).unwrap();
    assert_eq!(cleared, preview.exposure_records);

    let after = load_clear_preview(&db).unwrap();
    assert_eq!(after.auto_mastery_words, 0);
    assert_eq!(after.exposure_records, 0);
    assert_eq!(after.computed_books, 0);
    // The reader's own tier survives, and so does every word in the list.
    assert_eq!(after.manual_words, 1);
    assert_eq!(after.vocab_words, 3);
}

/// A device with nothing on it must not offer a dialog full of zeroes as if
/// they were losses.
#[test]
fn there_is_nothing_to_lose_on_a_device_that_has_read_nothing() {
    let (_directory, db) = test_db();

    let preview = load_clear_preview(&db).unwrap();

    assert_eq!(preview.auto_mastery_words, 0);
    assert_eq!(preview.exposure_records, 0);
    assert_eq!(preview.computed_books, 0);
    assert_eq!(preview.manual_words, 0);
    assert_eq!(preview.vocab_words, 0);
}
