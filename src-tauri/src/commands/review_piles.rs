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
    /// One pile per book. Words the reader kept stopping on inside that one
    /// book — see [`repeat_lookups_piles`] for what "kept" weighs out to.
    RepeatLookupsInBook {
        book_id: String,
        book_title: String,
        /// How the reader spent those stops, but only when the pile holds
        /// exactly one word. The approved copy for a one-word pile leans
        /// entirely on the number ("only one word — but you looked it up four
        /// times"), and without it the card would have to fall back to
        /// apologising for being small. Split by kind because the sentence
        /// names them separately: an AI card and a dictionary check are not
        /// the same act, and calling four dictionary checks "looked it up four
        /// times" describes something the reader did not do.
        solo_word_lookups: Option<i64>,
        solo_word_glances: Option<i64>,
    },
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

/// Pile 1: one pile per book, for words the reader kept stopping on in that
/// book. `lookup_records` has a UNIQUE index on (book_id, cfi,
/// normalized_text), so a naive `lookup_count > 1` only catches "same
/// position twice" and misses "two different positions in the same book" —
/// the same phenomenon, arguably the stronger signal. Summing grouped by
/// (book_id, normalized word) catches both.
///
/// ## What counts as stopping
///
/// Both kinds of lookup, at the weights the mastery ladder already uses: an
/// AI card is 1.0, a dictionary glance 0.5 (migration 069). The bar is a
/// weight of **2.0**, which is exactly today's "more than once" for a reader
/// who only ever opens cards — two cards, or one card and two dictionary
/// checks, or four dictionary checks. Card-only piles are therefore
/// unchanged, member for member.
///
/// 2.0 is not a fresh invention either: it is the same rung at which the
/// ladder sends a word back to `learning`. A word in this pile is a word that
/// hit that rung, which is the one-sentence story the module doc demands.
///
/// The SQL compares `2 * cards + glances >= 4` rather than the halved form —
/// same inequality, integer arithmetic, no float in a `HAVING`.
///
/// `v.list_status = 'confirmed'` excludes the observation zone (see
/// migration 044): a word still sitting there hasn't been saved, so it has
/// no business turning up in review. Words filed in by glances alone land in
/// the watchlist, so they wait there like every other unsaved word.
fn repeat_lookups_piles(conn: &Connection) -> AppResult<Vec<ReviewPile>> {
    let mut stmt = conn.prepare(
        "SELECT v.book_id, b.title, v.id, agg.newest, agg.cards, agg.glances
         FROM vocab_words v
         JOIN books b ON b.id = v.book_id
         JOIN (
             SELECT book_id, word,
                    SUM(cards) AS cards,
                    SUM(glances) AS glances,
                    MAX(newest) AS newest
             FROM (
                 SELECT book_id, normalized_text AS word,
                        lookup_count AS cards, 0 AS glances,
                        last_looked_up_at AS newest
                 FROM lookup_records
                 UNION ALL
                 SELECT book_id, normalized_word AS word,
                        0 AS cards, glance_count AS glances,
                        last_glanced_at AS newest
                 FROM dictionary_glances
             )
             GROUP BY book_id, word
             HAVING SUM(cards) * 2 + SUM(glances) >= 4
         ) agg ON agg.book_id = v.book_id AND agg.word = lower(trim(v.word))
         WHERE v.list_status = 'confirmed'",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    struct RepeatWord {
        word_id: String,
        newest: i64,
        cards: i64,
        glances: i64,
    }

    let mut by_book: HashMap<String, (String, Vec<RepeatWord>)> = HashMap::new();
    for (book_id, book_title, word_id, newest, cards, glances) in rows {
        by_book
            .entry(book_id)
            .or_insert_with(|| (book_title, Vec::new()))
            .1
            .push(RepeatWord {
                word_id,
                newest,
                cards,
                glances,
            });
    }

    let mut piles: Vec<ReviewPile> = by_book
        .into_iter()
        .map(|(book_id, (book_title, mut words))| {
            // Most-recent behaviour first; word id breaks ties deterministically.
            words.sort_by(|a, b| {
                b.newest
                    .cmp(&a.newest)
                    .then_with(|| a.word_id.cmp(&b.word_id))
            });
            let newest_activity_at = words.iter().map(|word| word.newest).max().unwrap_or(0);
            let (solo_word_lookups, solo_word_glances) = match words.as_slice() {
                [only] => (Some(only.cards), Some(only.glances)),
                _ => (None, None),
            };
            let word_ids = words.into_iter().map(|word| word.word_id).collect();
            ReviewPile {
                kind: ReviewPileKind::RepeatLookupsInBook {
                    book_id,
                    book_title,
                    solo_word_lookups,
                    solo_word_glances,
                },
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
///
/// Mastery scoring runs on watchlist words too (migration 044), so this
/// pile's own query can find one that has both events without having
/// reached its 3rd lookup yet — the `vocab_words` EXISTS check excludes it,
/// same rule as every other pile.
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
           )
           AND EXISTS (
               SELECT 1 FROM vocab_words v
               WHERE v.id = n.vocab_word_id AND v.list_status = 'confirmed'
           )",
    )?;
    let mut rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if rows.is_empty() {
        return Ok(None);
    }

    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let newest_activity_at = rows
        .iter()
        .map(|(_, created_at)| *created_at)
        .max()
        .unwrap_or(0);
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
         WHERE v.book_id = ?2 AND v.list_status = 'confirmed'
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
         WHERE next_review_at IS NOT NULL AND next_review_at <= ?1 AND list_status = 'confirmed'",
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

    /// A word still in the observation zone (migration 044) — every pile
    /// must ignore it regardless of how strong its behavioural signal is.
    fn insert_watchlist_word(conn: &RusqliteConnection, id: &str, book_id: &str, word: &str) {
        conn.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, mastery, list_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'definition', 'new', 'watchlist', 1700000000000, 1700000000000)",
            params![id, book_id, word],
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

    /// The lifetime dictionary tally for one (book, word) — migration 069.
    fn insert_glances(
        conn: &RusqliteConnection,
        book_id: &str,
        normalized_word: &str,
        last_glanced_at: i64,
        glance_count: i64,
    ) {
        conn.execute(
            "INSERT INTO dictionary_glances (book_id, normalized_word, glance_count, first_glanced_at, last_glanced_at, last_cfi, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4, NULL, ?4)",
            params![book_id, normalized_word, glance_count, last_glanced_at],
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
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            None,
            Some("cfi-1"),
            1_000,
            1,
        );
        insert_lookup_record(
            &conn,
            "l2",
            "book-a",
            "solitude",
            None,
            Some("cfi-2"),
            2_000,
            1,
        );
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
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            None,
            Some("cfi-1"),
            1_500,
            2,
        );
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        let pile = piles
            .iter()
            .find(|p| matches!(p.kind, ReviewPileKind::RepeatLookupsInBook { .. }))
            .expect("expected a RepeatLookupsInBook pile");
        assert_eq!(pile.word_ids, vec!["w1".to_string()]);
    }

    /// Four dictionary checks weigh 2.0 — the same bar two AI cards clear.
    #[test]
    fn four_dictionary_checks_land_a_word_in_the_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        insert_glances(&conn, "book-a", "solitude", 3_000, 4);
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert_eq!(
            piles[0].kind,
            ReviewPileKind::RepeatLookupsInBook {
                book_id: "book-a".to_string(),
                book_title: "Book A".to_string(),
                solo_word_lookups: Some(0),
                solo_word_glances: Some(4),
            }
        );
        // The dictionary tally carries the pile's timestamp when it is the
        // only thing in it.
        assert_eq!(piles[0].newest_activity_at, 3_000);
    }

    /// Three weigh 1.5. Under the bar, and deliberately so: the bar is the
    /// same rung the mastery ladder uses to send a word back to `learning`.
    #[test]
    fn three_dictionary_checks_do_not() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        insert_glances(&conn, "book-a", "solitude", 3_000, 3);
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert!(!piles
            .iter()
            .any(|p| matches!(p.kind, ReviewPileKind::RepeatLookupsInBook { .. })));
    }

    /// One card plus two dictionary checks is also 2.0, and the copy has to be
    /// able to say so — hence both counts, not one total.
    #[test]
    fn a_card_and_two_dictionary_checks_reach_the_bar_together() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            None,
            Some("cfi-1"),
            1_000,
            1,
        );
        insert_glances(&conn, "book-a", "solitude", 4_000, 2);
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert_eq!(
            piles[0].kind,
            ReviewPileKind::RepeatLookupsInBook {
                book_id: "book-a".to_string(),
                book_title: "Book A".to_string(),
                solo_word_lookups: Some(1),
                solo_word_glances: Some(2),
            }
        );
        // Newest across both kinds of activity, not just the cards.
        assert_eq!(piles[0].newest_activity_at, 4_000);
    }

    /// A word filed in by glances alone sits in the watchlist, and the
    /// observation zone stays out of review however loud its signal is.
    #[test]
    fn a_glanced_watchlist_word_stays_out_of_the_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_watchlist_word(&conn, "w1", "book-a", "solitude");
        insert_glances(&conn, "book-a", "solitude", 3_000, 6);
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert!(!piles
            .iter()
            .any(|p| matches!(p.kind, ReviewPileKind::RepeatLookupsInBook { .. })));
    }

    #[test]
    fn one_lookup_in_each_of_two_books_lands_in_neither_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_book(&conn, "book-b", "Book B");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        insert_vocab_word(&conn, "w2", "book-b", "solitude", None);
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            None,
            Some("cfi-1"),
            1_000,
            1,
        );
        insert_lookup_record(
            &conn,
            "l2",
            "book-b",
            "solitude",
            None,
            Some("cfi-1"),
            2_000,
            1,
        );
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
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            None,
            Some("cfi-1"),
            100,
            1,
        );
        insert_lookup_record(
            &conn,
            "l2",
            "book-a",
            "solitude",
            None,
            Some("cfi-2"),
            200,
            1,
        );
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

    /// A one-word pile is shown, not suppressed — and it carries the lookup
    /// count its copy is built around ("only one word, but you looked it up
    /// four times"). Both halves matter: without the count the card has
    /// nothing to say for itself.
    #[test]
    fn a_pile_with_exactly_one_word_is_returned_with_its_lookup_count() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            None,
            Some("cfi-1"),
            1_000,
            3,
        );
        insert_lookup_record(
            &conn,
            "l2",
            "book-a",
            "solitude",
            None,
            Some("cfi-2"),
            1_200,
            1,
        );
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert_eq!(piles.len(), 1);
        assert_eq!(piles[0].word_ids.len(), 1);
        assert_eq!(
            piles[0].kind,
            ReviewPileKind::RepeatLookupsInBook {
                book_id: "book-a".to_string(),
                book_title: "Book A".to_string(),
                // Summed across both positions, not just the newest row.
                solo_word_lookups: Some(4),
                solo_word_glances: Some(0),
            }
        );
    }

    /// The count is deliberately absent once the pile has company: the copy
    /// that uses it only exists for the one-word case, and a number nothing
    /// renders is a number that will drift out of sync unnoticed.
    #[test]
    fn a_pile_with_more_than_one_word_carries_no_solo_lookup_count() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude", None);
        insert_vocab_word(&conn, "w2", "book-a", "vexation", None);
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            None,
            Some("cfi-1"),
            1_000,
            2,
        );
        insert_lookup_record(
            &conn,
            "l2",
            "book-a",
            "vexation",
            None,
            Some("cfi-2"),
            1_100,
            2,
        );
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        let ReviewPileKind::RepeatLookupsInBook {
            solo_word_lookups, ..
        } = &piles[0].kind
        else {
            panic!(
                "expected a RepeatLookupsInBook pile, got {:?}",
                piles[0].kind
            );
        };
        assert_eq!(*solo_word_lookups, None);
    }

    #[test]
    fn interleaved_ordering_puts_long_unseen_last() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_book(&conn, "book-b", "Book B");

        // Book A's repeat-lookup pile: newest activity at 5_000.
        insert_vocab_word(&conn, "a1", "book-a", "solitude", None);
        insert_lookup_record(
            &conn,
            "la1",
            "book-a",
            "solitude",
            None,
            Some("cfi-1"),
            1_000,
            1,
        );
        insert_lookup_record(
            &conn,
            "la2",
            "book-a",
            "solitude",
            None,
            Some("cfi-2"),
            5_000,
            1,
        );

        // Book B's repeat-lookup pile: newest activity at 9_000 — should sort first.
        insert_vocab_word(&conn, "b1", "book-b", "reverie", None);
        insert_lookup_record(
            &conn,
            "lb1",
            "book-b",
            "reverie",
            None,
            Some("cfi-1"),
            3_000,
            1,
        );
        insert_lookup_record(
            &conn,
            "lb2",
            "book-b",
            "reverie",
            None,
            Some("cfi-2"),
            9_000,
            1,
        );

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
                    solo_word_lookups: Some(2),
                    solo_word_glances: Some(0),
                },
                &ReviewPileKind::RecentChapterLookups {
                    book_id: "book-a".to_string(),
                    book_title: "Book A".to_string(),
                    chapter: "Chapter One".to_string(),
                },
                &ReviewPileKind::RepeatLookupsInBook {
                    book_id: "book-a".to_string(),
                    book_title: "Book A".to_string(),
                    solo_word_lookups: Some(2),
                    solo_word_glances: Some(0),
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

    /// A watchlist word (docs/impls/reading-flow-decisions-2026-08-06.md §1)
    /// looked up at two different positions has exactly the signal pile 1
    /// looks for — and must still be excluded, because it hasn't been saved.
    #[test]
    fn a_watchlist_word_never_lands_in_the_repeat_lookups_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_watchlist_word(&conn, "w1", "book-a", "solitude");
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            None,
            Some("cfi-1"),
            1_000,
            1,
        );
        insert_lookup_record(
            &conn,
            "l2",
            "book-a",
            "solitude",
            None,
            Some("cfi-2"),
            2_000,
            1,
        );
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert!(!piles
            .iter()
            .any(|p| matches!(p.kind, ReviewPileKind::RepeatLookupsInBook { .. })));
    }

    #[test]
    fn a_watchlist_word_never_lands_in_the_promoted_then_looked_up_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_watchlist_word(&conn, "w1", "book-a", "gamma");
        insert_mastery_event(&conn, "w1", "exposure_promotion", 1_000);
        insert_mastery_event(&conn, "w1", "lookup_demotion", 2_000);
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert!(!piles
            .iter()
            .any(|p| matches!(p.kind, ReviewPileKind::PromotedThenLookedUp)));
    }

    #[test]
    fn a_watchlist_word_never_lands_in_the_recent_chapter_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_watchlist_word(&conn, "w1", "book-a", "solitude");
        insert_lookup_record(
            &conn,
            "l1",
            "book-a",
            "solitude",
            Some("Chapter One"),
            Some("cfi-1"),
            100_000_000,
            1,
        );
        drop(conn);

        let piles = list_review_piles_at(&db, 100_000_000 + 1_000).unwrap();
        assert!(!piles
            .iter()
            .any(|p| matches!(p.kind, ReviewPileKind::RecentChapterLookups { .. })));
    }

    #[test]
    fn a_watchlist_word_never_lands_in_the_long_unseen_pile() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        conn.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, mastery, list_status, next_review_at, created_at, updated_at)
             VALUES ('w1', 'book-a', 'solitude', 'definition', 'new', 'watchlist', 500, 1700000000000, 1700000000000)",
            [],
        )
        .unwrap();
        drop(conn);

        let piles = list_review_piles_at(&db, 10_000).unwrap();
        assert!(!piles
            .iter()
            .any(|p| matches!(p.kind, ReviewPileKind::LongUnseen)));
    }
}
