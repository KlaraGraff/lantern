//! Review entry piles — see docs/impls/reading-driven-mastery-and-review.md
//! §4.1-4.2. FSRS keeps deciding *when* a word is due underneath, but this
//! module turns that into a handful of piles the reader can recognise from
//! their own behaviour, instead of a single algorithmic queue.
//!
//! The single design rule (quoted from the doc): 判断一个堆该不该存在的唯一
//! 标准：能不能一句话说清它怎么来的. Every variant of `ReviewPileKind` below
//! must stay explainable that way — see the doc comment on each.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;

use crate::commands::vocab::{query_all_vocab_words, VocabWord};
use crate::db::Db;
use crate::error::AppResult;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ReviewPileKind {
    /// One pile per book. Words looked up more than once inside that one book.
    RepeatLookupsInBook { book_id: String, book_title: String },
    /// Words the exposure engine promoted, that the reader then looked up.
    PromotedThenLookedUp,
    /// Words looked up in the chapter the reader was most recently in.
    RecentChapterLookups {
        book_id: String,
        book_title: String,
        chapter: String,
    },
    /// The FSRS fallback. Saved, due, and with no behavioural story to tell.
    LongUnseen,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ReviewPile {
    pub kind: ReviewPileKind,
    /// vocab_words.id, ordered most-recent behaviour first.
    pub word_ids: Vec<String>,
    /// The words themselves, same order, so the caller needs no second query.
    pub words: Vec<VocabWord>,
    /// Milliseconds. The newest underlying event this pile was built from.
    /// Drives ordering; see `list_review_piles_at`.
    pub newest_activity_at: i64,
}

/// Declaration order from the doc — used both for the tie-break in sorting
/// and to pin `LongUnseen` last regardless of its own timestamp.
fn kind_rank(kind: &ReviewPileKind) -> u8 {
    match kind {
        ReviewPileKind::RepeatLookupsInBook { .. } => 0,
        ReviewPileKind::PromotedThenLookedUp => 1,
        ReviewPileKind::RecentChapterLookups { .. } => 2,
        ReviewPileKind::LongUnseen => 3,
    }
}

/// Second tie-break key. Only the two per-book kinds have one; the rest sort
/// equal on this key (there is at most one instance of each anyway).
fn kind_book_id(kind: &ReviewPileKind) -> &str {
    match kind {
        ReviewPileKind::RepeatLookupsInBook { book_id, .. } => book_id,
        ReviewPileKind::RecentChapterLookups { book_id, .. } => book_id,
        ReviewPileKind::PromotedThenLookedUp | ReviewPileKind::LongUnseen => "",
    }
}

#[tauri::command]
pub fn list_review_piles(db: State<'_, Db>) -> AppResult<Vec<ReviewPile>> {
    list_review_piles_at(&db, chrono::Utc::now().timestamp_millis())
}

pub(crate) fn list_review_piles_at(db: &Db, now_ms: i64) -> AppResult<Vec<ReviewPile>> {
    // All the pile-shaping queries run against one connection, scoped so the
    // guard drops before `query_all_vocab_words` below takes its own lock —
    // `db.reader()`'s mutex isn't reentrant.
    let (mut behaviour_piles, long_unseen) = {
        let conn = db.reader();

        let mut behaviour_piles = repeat_lookups_piles(&conn)?;
        if let Some(pile) = promoted_then_looked_up_pile(&conn)? {
            behaviour_piles.push(pile);
        }
        if let Some(pile) = recent_chapter_lookups_pile(&conn, now_ms)? {
            behaviour_piles.push(pile);
        }

        // Only piles 1-3 are exclusion territory for pile 4; see the doc's
        // "Deduplication" section — a word may sit in several behaviour
        // piles at once, that's intended, but LongUnseen is the one
        // partition-like pile.
        let behaviour_word_ids: HashSet<String> = behaviour_piles
            .iter()
            .flat_map(|pile| pile.word_ids.iter().cloned())
            .collect();

        let long_unseen = long_unseen_pile(&conn, now_ms, &behaviour_word_ids)?;
        (behaviour_piles, long_unseen)
    };

    behaviour_piles.sort_by(|a, b| {
        b.newest_activity_at
            .cmp(&a.newest_activity_at)
            .then_with(|| kind_rank(&a.kind).cmp(&kind_rank(&b.kind)))
            .then_with(|| kind_book_id(&a.kind).cmp(kind_book_id(&b.kind)))
    });

    let mut piles = behaviour_piles;
    if let Some(pile) = long_unseen {
        piles.push(pile);
    }

    if piles.is_empty() {
        return Ok(piles);
    }

    let by_id: HashMap<String, VocabWord> = query_all_vocab_words(db)?
        .into_iter()
        .map(|word| (word.id.clone(), word))
        .collect();

    for pile in piles.iter_mut() {
        // Rebuild both `word_ids` and `words` together so they stay the same
        // length and order even if a ref turned out stale between the two
        // reads above (e.g. a word deleted mid-call).
        let mut ids = Vec::with_capacity(pile.word_ids.len());
        let mut words = Vec::with_capacity(pile.word_ids.len());
        for id in &pile.word_ids {
            if let Some(word) = by_id.get(id) {
                ids.push(id.clone());
                words.push(word.clone());
            }
        }
        pile.word_ids = ids;
        pile.words = words;
    }
    piles.retain(|pile| !pile.word_ids.is_empty());

    Ok(piles)
}

/// Pile 1: one pile per book, for words looked up more than once in that
/// book. `lookup_records` has a UNIQUE index on (book_id, cfi,
/// normalized_text), so a naive `lookup_count > 1` only catches "same
/// position twice" and misses "two different positions in the same book" —
/// the same phenomenon, arguably the stronger signal. Summing lookup_count
/// grouped by (book_id, normalized_text) catches both.
fn repeat_lookups_piles(conn: &Connection) -> AppResult<Vec<ReviewPile>> {
    let mut stmt = conn.prepare(
        "SELECT v.book_id, b.title, v.id, agg.newest
         FROM vocab_words v
         JOIN books b ON b.id = v.book_id
         JOIN (
             SELECT book_id, normalized_text,
                    SUM(lookup_count) AS total_lookups,
                    MAX(last_looked_up_at) AS newest
             FROM lookup_records
             GROUP BY book_id, normalized_text
             HAVING SUM(lookup_count) > 1
         ) agg ON agg.book_id = v.book_id AND agg.normalized_text = lower(trim(v.word))",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut by_book: HashMap<String, (String, Vec<(String, i64)>)> = HashMap::new();
    for (book_id, book_title, word_id, newest) in rows {
        by_book
            .entry(book_id)
            .or_insert_with(|| (book_title, Vec::new()))
            .1
            .push((word_id, newest));
    }

    let mut piles: Vec<ReviewPile> = by_book
        .into_iter()
        .map(|(book_id, (book_title, mut words))| {
            // Most-recent behaviour first; word id breaks ties deterministically.
            words.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            let newest_activity_at = words.iter().map(|(_, newest)| *newest).max().unwrap_or(0);
            let word_ids = words.into_iter().map(|(id, _)| id).collect();
            ReviewPile {
                kind: ReviewPileKind::RepeatLookupsInBook { book_id, book_title },
                word_ids,
                words: Vec::new(),
                newest_activity_at,
            }
        })
        .collect();
    // Deterministic before the caller's final sort — HashMap iteration order isn't.
    piles.sort_by(|a, b| kind_book_id(&a.kind).cmp(kind_book_id(&b.kind)));
    Ok(piles)
}

/// Pile 2: words whose newest `mastery_events` row is a lookup-driven
/// demotion, with an earlier row that was an exposure promotion. Both are
/// required — this means "the engine said you knew it, you proved
/// otherwise", not merely "you looked something up".
fn promoted_then_looked_up_pile(conn: &Connection) -> AppResult<Option<ReviewPile>> {
    let mut stmt = conn.prepare(
        "WITH newest AS (
             SELECT vocab_word_id, reason, created_at, rowid AS rid,
                    ROW_NUMBER() OVER (
                        PARTITION BY vocab_word_id
                        ORDER BY created_at DESC, rowid DESC
                    ) AS rn
             FROM mastery_events
         )
         SELECT n.vocab_word_id, n.created_at
         FROM newest n
         WHERE n.rn = 1
           AND n.reason IN ('lookup_demotion', 'repeat_lookup_demotion')
           AND EXISTS (
               SELECT 1 FROM mastery_events p
               WHERE p.vocab_word_id = n.vocab_word_id
                 AND p.reason = 'exposure_promotion'
                 AND (p.created_at < n.created_at
                      OR (p.created_at = n.created_at AND p.rowid < n.rid))
           )",
    )?;
    let mut rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    if rows.is_empty() {
        return Ok(None);
    }

    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let newest_activity_at = rows.iter().map(|(_, created_at)| *created_at).max().unwrap_or(0);
    let word_ids = rows.into_iter().map(|(id, _)| id).collect();

    Ok(Some(ReviewPile {
        kind: ReviewPileKind::PromotedThenLookedUp,
        word_ids,
        words: Vec::new(),
        newest_activity_at,
    }))
}

/// Pile 3: the newest chaptered lookup, and every vocab word looked up in
/// that same (book, chapter) — as long as that lookup happened within the
/// last 24 hours. Older than that, the pile does not exist.
fn recent_chapter_lookups_pile(conn: &Connection, now_ms: i64) -> AppResult<Option<ReviewPile>> {
    let anchor: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT book_id, chapter, last_looked_up_at
             FROM lookup_records
             WHERE chapter IS NOT NULL AND trim(chapter) <> ''
             ORDER BY last_looked_up_at DESC
             LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;

    let Some((book_id, chapter, newest_activity_at)) = anchor else {
        return Ok(None);
    };
    if now_ms.saturating_sub(newest_activity_at) > DAY_MS {
        return Ok(None);
    }

    let mut stmt = conn.prepare(
        "SELECT v.id, MAX(l.last_looked_up_at) AS newest
         FROM vocab_words v
         JOIN lookup_records l
           ON l.book_id = v.book_id AND l.chapter = ?1 AND l.normalized_text = lower(trim(v.word))
         WHERE v.book_id = ?2
         GROUP BY v.id",
    )?;
    let mut rows = stmt
        .query_map(params![chapter, book_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if rows.is_empty() {
        return Ok(None);
    }
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let word_ids = rows.into_iter().map(|(id, _)| id).collect();

    let book_title: String = conn.query_row(
        "SELECT title FROM books WHERE id = ?1",
        params![book_id],
        |row| row.get(0),
    )?;

    Ok(Some(ReviewPile {
        kind: ReviewPileKind::RecentChapterLookups {
            book_id,
            book_title,
            chapter,
        },
        word_ids,
        words: Vec::new(),
        newest_activity_at,
    }))
}

/// Pile 4: the FSRS fallback — due words that no behaviour pile already
/// tells a story about. Always sorted last by the caller regardless of its
/// own timestamp.
fn long_unseen_pile(
    conn: &Connection,
    now_ms: i64,
    excluded: &HashSet<String>,
) -> AppResult<Option<ReviewPile>> {
    let mut stmt = conn.prepare(
        "SELECT id, next_review_at FROM vocab_words
         WHERE next_review_at IS NOT NULL AND next_review_at <= ?1",
    )?;
    let mut rows = stmt
        .query_map(params![now_ms], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|(id, _)| !excluded.contains(id))
        .collect::<Vec<_>>();

    if rows.is_empty() {
        return Ok(None);
    }
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let newest_activity_at = rows.iter().map(|(_, next)| *next).max().unwrap_or(0);
    let word_ids = rows.into_iter().map(|(id, _)| id).collect();

    Ok(Some(ReviewPile {
        kind: ReviewPileKind::LongUnseen,
        word_ids,
        words: Vec::new(),
        newest_activity_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection as RusqliteConnection;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    fn insert_book(conn: &RusqliteConnection, id: &str, title: &str) {
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES (?1, ?2, 'Author', 'books/x.epub', 'unread', 0, 1700000000000, 1700000000000)",
            params![id, title],
        )
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_vocab_word(
        conn: &RusqliteConnection,
        id: &str,
        book_id: &str,
        word: &str,
        next_review_at: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, mastery, next_review_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'definition', 'new', ?4, 1700000000000, 1700000000000)",
            params![id, book_id, word, next_review_at],
        )
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_lookup_record(
        conn: &RusqliteConnection,
        id: &str,
        book_id: &str,
        normalized_text: &str,
        chapter: Option<&str>,
        cfi: Option<&str>,
        last_looked_up_at: i64,
        lookup_count: i64,
    ) {
        conn.execute(
            "INSERT INTO lookup_records (id, book_id, lookup_text, normalized_text, chapter, cfi, definition, created_at, last_looked_up_at, lookup_count)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, 'def', ?6, ?6, ?7)",
            params![id, book_id, normalized_text, chapter, cfi, last_looked_up_at, lookup_count],
        )
        .unwrap();
    }

    fn insert_mastery_event(
        conn: &RusqliteConnection,
        vocab_word_id: &str,
        reason: &str,
        created_at: i64,
    ) {
        crate::commands::mastery_events::record_mastery_event(
            conn,
            vocab_word_id,
            "learning",
            "learning",
            "auto",
            reason,
            "{}",
            created_at,
        )
        .unwrap();
    }

    #[test]
    fn repeat_lookups_at_two_different_positions_in_one_book_lands_in_the_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        // Same word, two different cfi positions — the case the naive
        // `lookup_count > 1` query gets wrong.
        insert_lookup_record(&conn, "l1", "book-a", "solitude", None, Some("cfi-1"), 1_000, 1);
        insert_lookup_record(&conn, "l2", "book-a", "solitude", None, Some("cfi-2"), 2_000, 1);
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        let pile = piles
            .iter()
            .find(|p| matches!(p.kind, ReviewPileKind::RepeatLookupsInBook { .. }))
            .expect("expected a RepeatLookupsInBook pile");
        assert_eq!(pile.word_ids, vec!["w1".to_string()]);
        assert_eq!(pile.newest_activity_at, 2_000);
    }

    #[test]
    fn repeat_lookups_at_the_same_position_also_lands_in_the_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        insert_lookup_record(&conn, "l1", "book-a", "solitude", None, Some("cfi-1"), 1_500, 2);
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        let pile = piles
            .iter()
            .find(|p| matches!(p.kind, ReviewPileKind::RepeatLookupsInBook { .. }))
            .expect("expected a RepeatLookupsInBook pile");
        assert_eq!(pile.word_ids, vec!["w1".to_string()]);
    }

    #[test]
    fn one_lookup_in_each_of_two_books_lands_in_neither_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_book(&conn, "book-b", "Book B");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        insert_vocab_word(&conn, "w2", "book-b", "solitude", None);
        insert_lookup_record(&conn, "l1", "book-a", "solitude", None, Some("cfi-1"), 1_000, 1);
        insert_lookup_record(&conn, "l2", "book-b", "solitude", None, Some("cfi-1"), 2_000, 1);
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert!(!piles
            .iter()
            .any(|p| matches!(p.kind, ReviewPileKind::RepeatLookupsInBook { .. })));
    }

    #[test]
    fn promoted_then_looked_up_requires_both_events() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "only-demoted", "book-a", "alpha", None);
        insert_vocab_word(&conn, "only-promoted", "book-a", "beta", None);
        insert_vocab_word(&conn, "both", "book-a", "gamma", None);
        insert_mastery_event(&conn, "only-demoted", "lookup_demotion", 1_000);
        insert_mastery_event(&conn, "only-promoted", "exposure_promotion", 1_000);
        insert_mastery_event(&conn, "both", "exposure_promotion", 1_000);
        insert_mastery_event(&conn, "both", "lookup_demotion", 2_000);
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        let pile = piles
            .iter()
            .find(|p| matches!(p.kind, ReviewPileKind::PromotedThenLookedUp))
            .expect("expected a PromotedThenLookedUp pile");
        assert_eq!(pile.word_ids, vec!["both".to_string()]);
    }

    #[test]
    fn recent_chapter_lookups_vanishes_after_24_hours_and_appears_before() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        let last_looked_up_at = 100_000_000_i64;
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            Some("Chapter One"),
            Some("cfi-1"),
            last_looked_up_at,
            1,
        );
        drop(conn);

        let just_under_25h = last_looked_up_at + 25 * 60 * 60 * 1000;
        let piles_old = list_review_piles_at(&db, just_under_25h).unwrap();
        assert!(!piles_old
            .iter()
            .any(|p| matches!(p.kind, ReviewPileKind::RecentChapterLookups { .. })));

        let just_under_23h = last_looked_up_at + 23 * 60 * 60 * 1000;
        let piles_fresh = list_review_piles_at(&db, just_under_23h).unwrap();
        let pile = piles_fresh
            .iter()
            .find(|p| matches!(p.kind, ReviewPileKind::RecentChapterLookups { .. }))
            .expect("expected a RecentChapterLookups pile within 24h");
        assert_eq!(pile.word_ids, vec!["w1".to_string()]);
    }

    #[test]
    fn long_unseen_excludes_words_already_in_a_behaviour_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        // Due, and carried by a behaviour pile (repeat lookups) — must be excluded.
        insert_vocab_word(&conn, "carried", "book-a", "solitude", Some(500));
        insert_lookup_record(&conn, "l1", "book-a", "solitude", None, Some("cfi-1"), 100, 1);
        insert_lookup_record(&conn, "l2", "book-a", "solitude", None, Some("cfi-2"), 200, 1);
        // Due, carried by nothing — must appear.
        insert_vocab_word(&conn, "uncarried", "book-a", "reverie", Some(600));
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        let pile = piles
            .iter()
            .find(|p| matches!(p.kind, ReviewPileKind::LongUnseen))
            .expect("expected a LongUnseen pile");
        assert_eq!(pile.word_ids, vec!["uncarried".to_string()]);
    }

    #[test]
    fn empty_database_returns_an_empty_vec() {
        let (_dir, db) = setup();
        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert!(piles.is_empty());
    }

    #[test]
    fn a_pile_with_exactly_one_word_is_returned() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        insert_lookup_record(&conn, "l1", "book-a", "solitude", None, Some("cfi-1"), 1_000, 2);
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert_eq!(piles.len(), 1);
        assert_eq!(piles[0].word_ids.len(), 1);
    }

    #[test]
    fn interleaved_ordering_puts_long_unseen_last() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_book(&conn, "book-b", "Book B");

        // Book A's repeat-lookup pile: newest activity at 5_000.
        insert_vocab_word(&conn, "a1", "book-a", "solitude", None);
        insert_lookup_record(&conn, "la1", "book-a", "solitude", None, Some("cfi-1"), 1_000, 1);
        insert_lookup_record(&conn, "la2", "book-a", "solitude", None, Some("cfi-2"), 5_000, 1);

        // Book B's repeat-lookup pile: newest activity at 9_000 — should sort first.
        insert_vocab_word(&conn, "b1", "book-b", "reverie", None);
        insert_lookup_record(&conn, "lb1", "book-b", "reverie", None, Some("cfi-1"), 3_000, 1);
        insert_lookup_record(&conn, "lb2", "book-b", "reverie", None, Some("cfi-2"), 9_000, 1);

        // Recent-chapter pile: newest activity at 7_000 — should sort between them.
        insert_vocab_word(&conn, "c1", "book-a", "candour", None);
        insert_lookup_record(
            &conn,
            "lc1",
            "book-a",
            "candour",
            Some("Chapter One"),
            Some("cfi-3"),
            7_000,
            1,
        );

        // LongUnseen: due, uncarried, timestamp higher than everything above —
        // must still land last.
        insert_vocab_word(&conn, "d1", "book-a", "umbrage", Some(999_999));
        drop(conn);

        let piles = list_review_piles_at(&db, 1_000_000).unwrap();
        let kinds: Vec<&ReviewPileKind> = piles.iter().map(|p| &p.kind).collect();
        assert_eq!(
            kinds,
            vec![
                &ReviewPileKind::RepeatLookupsInBook {
                    book_id: "book-b".to_string(),
                    book_title: "Book B".to_string(),
                },
                &ReviewPileKind::RecentChapterLookups {
                    book_id: "book-a".to_string(),
                    book_title: "Book A".to_string(),
                    chapter: "Chapter One".to_string(),
                },
                &ReviewPileKind::RepeatLookupsInBook {
                    book_id: "book-a".to_string(),
                    book_title: "Book A".to_string(),
                },
                &ReviewPileKind::LongUnseen,
            ]
        );
    }

    #[test]
    fn a_word_can_appear_in_two_behaviour_piles_at_once() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        // Looked up twice in the same recent chapter — qualifies for both
        // RepeatLookupsInBook and RecentChapterLookups.
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            Some("Chapter One"),
            Some("cfi-1"),
            1_000,
            1,
        );
        insert_lookup_record(
            &conn,
            "l2",
            "book-a",
            "solitude",
            Some("Chapter One"),
            Some("cfi-2"),
            2_000,
            1,
        );
        drop(conn);

        let piles = list_review_piles_at(&db, 2_000 + 60_000).unwrap();
        let repeat_pile = piles
            .iter()
            .find(|p| matches!(p.kind, ReviewPileKind::RepeatLookupsInBook { .. }))
            .expect("expected a RepeatLookupsInBook pile");
        let chapter_pile = piles
            .iter()
            .find(|p| matches!(p.kind, ReviewPileKind::RecentChapterLookups { .. }))
            .expect("expected a RecentChapterLookups pile");
        assert_eq!(repeat_pile.word_ids, vec!["w1".to_string()]);
        assert_eq!(chapter_pile.word_ids, vec!["w1".to_string()]);
    }
}
