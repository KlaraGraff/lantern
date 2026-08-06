//! Aggregates for the reading-stats page's "learning" view
//! (docs/impls/reading-stats-learning-mockup.html): how much dictionary
//! lookup and vocabulary-mastery activity happened in a period, plus the
//! reader's current mastery-tier snapshot. Every count is local-only,
//! computed straight from `lookup_records`, `vocab_words` and
//! `mastery_events` — nothing here calls out to AI.
//!
//! Shares its period/book-scope/timezone query shape with
//! `commands::reading_stats::ReadingStatsQuery` so the same "range" picker on
//! the page drives both views identically, but keeps its own struct: this
//! module has no business depending on the reading-session dashboard's type,
//! and the two are free to evolve independently.

use std::collections::{BTreeMap, BTreeSet};

use chrono::Datelike;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::reading_stats::local_date;
use crate::db::Db;
use crate::error::{AppError, AppResult};

const MAX_TIMEZONE_OFFSET_MINUTES: i32 = 24 * 60 - 1;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Hard stop on the day-by-day bucket walk below. At one iteration per local
/// day this is centuries of range — only here so a malformed query can never
/// spin the loop forever.
const MAX_BUCKET_DAYS: i64 = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabLearningQuery {
    pub period_start: i64,
    pub period_end: i64,
    #[serde(default)]
    pub scope_book_id: Option<String>,
    /// JavaScript's `Date#getTimezoneOffset()` convention (UTC minus local),
    /// same as `ReadingStatsQuery` — used only for local-day bucketing.
    #[serde(default)]
    pub timezone_offset_minutes: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VocabTrendGranularity {
    Day,
    Week,
    Month,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabTrendBucket {
    /// The local calendar date the bucket starts on (`YYYY-MM-DD`) — the
    /// bucket itself for `Day` granularity, the Monday of that ISO week for
    /// `Week`, or the first of the month for `Month`.
    pub date: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VocabMasteryDistribution {
    pub total: i64,
    pub new_count: i64,
    pub learning_count: i64,
    pub familiar_count: i64,
    pub mastered_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabLearningDashboard {
    pub query: VocabLearningQuery,
    /// Dictionary lookups started in the period (`lookup_records.created_at`
    /// within range). A repeat lookup at a position that is already cached
    /// updates its existing row rather than inserting a new one (see
    /// `save_lookup_record_inner`), so this counts distinct lookup targets
    /// first queried in the period, not every cache hit against them — the
    /// same tradeoff the trend chart below makes, for the same reason: the
    /// schema keeps one row per position, not a per-event log.
    pub lookup_count: i64,
    /// Vocabulary words the reader saved in the period. Watchlist rows
    /// (`list_status != 'confirmed'`) are excluded — see the observation
    /// zone note on `query_vocab_stats` in `commands::vocab`.
    pub new_words_count: i64,
    /// `mastery_events` rows with `to_mastery = 'mastered'` in the period,
    /// for words the reader has confirmed. Matches the page's footnote:
    /// covers both automatic (reading-exposure) and manual promotions;
    /// reviews that later demote a word back out are not subtracted here —
    /// this counts promotions, not a running balance.
    pub mastered_count: i64,
    /// As of now, not scoped to the period — "today" means today regardless
    /// of which date range tab is selected, same as the sidebar's own
    /// review entry point. Still respects the book filter.
    pub due_for_review_count: i64,
    pub trend_granularity: VocabTrendGranularity,
    /// One entry per bucket covering the whole query period, oldest first,
    /// including zero-count buckets — the chart draws a short flat bar for a
    /// quiet day rather than a gap.
    pub trend: Vec<VocabTrendBucket>,
    /// Current mastery-tier snapshot (not period-scoped): "how the reader's
    /// vocabulary looks right now", narrowed to the book filter only.
    pub mastery_distribution: VocabMasteryDistribution,
}

fn validate_query(query: &VocabLearningQuery) -> AppResult<()> {
    if query.period_start <= 0 || query.period_end <= query.period_start {
        return Err(AppError::Other("VOCAB_LEARNING_PERIOD_INVALID".to_string()));
    }
    if !(-MAX_TIMEZONE_OFFSET_MINUTES..=MAX_TIMEZONE_OFFSET_MINUTES)
        .contains(&query.timezone_offset_minutes)
    {
        return Err(AppError::Other(
            "VOCAB_LEARNING_TIMEZONE_INVALID".to_string(),
        ));
    }
    if query
        .scope_book_id
        .as_deref()
        .is_some_and(|id| id.trim().is_empty())
    {
        return Err(AppError::Other("VOCAB_LEARNING_BOOK_INVALID".to_string()));
    }
    Ok(())
}

fn bucket_key(local_date_str: &str, granularity: VocabTrendGranularity) -> String {
    let Ok(date) = chrono::NaiveDate::parse_from_str(local_date_str, "%Y-%m-%d") else {
        return local_date_str.to_string();
    };
    match granularity {
        VocabTrendGranularity::Day => local_date_str.to_string(),
        VocabTrendGranularity::Week => {
            let iso = date.iso_week();
            chrono::NaiveDate::from_isoywd_opt(iso.year(), iso.week(), chrono::Weekday::Mon)
                .unwrap_or(date)
                .format("%Y-%m-%d")
                .to_string()
        }
        VocabTrendGranularity::Month => format!("{}-01", &local_date_str[0..7]),
    }
}

/// Picks the bucket size that keeps the bar count in a readable range: daily
/// for anything up to ~2 months, weekly up to ~14 months, monthly beyond
/// that. `effective_start` should already be clamped to the reader's actual
/// earliest activity (see `evidence_start` in
/// `get_vocab_learning_dashboard_inner`) — bucketing the nominal "all time"
/// anchor (year 2000) would otherwise walk decades of empty history.
fn choose_granularity(effective_start: i64, period_end: i64) -> VocabTrendGranularity {
    let span_days = (period_end - effective_start).max(0) / DAY_MS;
    if span_days <= 62 {
        VocabTrendGranularity::Day
    } else if span_days <= 420 {
        VocabTrendGranularity::Week
    } else {
        VocabTrendGranularity::Month
    }
}

/// Every bucket key touched while walking `[effective_start, period_end)` one
/// local day at a time, in chronological order — including days that will
/// end up with a zero count, so the chart never has to invent a gap.
fn enumerate_bucket_keys(
    effective_start: i64,
    period_end: i64,
    timezone_offset_minutes: i32,
    granularity: VocabTrendGranularity,
) -> AppResult<Vec<String>> {
    let mut keys = BTreeSet::new();
    let mut cursor = effective_start;
    let mut guard = 0;
    while cursor < period_end && guard < MAX_BUCKET_DAYS {
        let date = local_date(cursor, timezone_offset_minutes);
        keys.insert(bucket_key(&date, granularity));
        let (_, next_day) = super::reading_stats::local_day_bounds(&date, timezone_offset_minutes)?;
        // `local_day_bounds` always advances by one calendar day; guard
        // against it ever returning something non-increasing so this cannot
        // spin.
        if next_day <= cursor {
            break;
        }
        cursor = next_day;
        guard += 1;
    }
    Ok(keys.into_iter().collect())
}

fn earliest_activity(
    conn: &rusqlite::Connection,
    scope_book_id: Option<&str>,
) -> AppResult<Option<i64>> {
    let earliest_lookup: Option<i64> = conn
        .query_row(
            "SELECT MIN(created_at) FROM lookup_records WHERE (?1 IS NULL OR book_id = ?1)",
            params![scope_book_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let earliest_word: Option<i64> = conn
        .query_row(
            "SELECT MIN(created_at) FROM vocab_words
              WHERE list_status = 'confirmed' AND (?1 IS NULL OR book_id = ?1)",
            params![scope_book_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok([earliest_lookup, earliest_word].into_iter().flatten().min())
}

pub(crate) fn get_vocab_learning_dashboard_inner(
    db: &Db,
    query: &VocabLearningQuery,
) -> AppResult<VocabLearningDashboard> {
    validate_query(query)?;
    let conn = db.reader();
    let book = query.scope_book_id.as_deref();

    let lookup_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM lookup_records
          WHERE created_at >= ?1 AND created_at < ?2 AND (?3 IS NULL OR book_id = ?3)",
        params![query.period_start, query.period_end, book],
        |row| row.get(0),
    )?;
    let new_words_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words
          WHERE list_status = 'confirmed' AND created_at >= ?1 AND created_at < ?2
            AND (?3 IS NULL OR book_id = ?3)",
        params![query.period_start, query.period_end, book],
        |row| row.get(0),
    )?;
    let mastered_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM mastery_events me
           JOIN vocab_words vw ON vw.id = me.vocab_word_id
          WHERE me.to_mastery = 'mastered' AND me.created_at >= ?1 AND me.created_at < ?2
            AND vw.list_status = 'confirmed' AND (?3 IS NULL OR vw.book_id = ?3)",
        params![query.period_start, query.period_end, book],
        |row| row.get(0),
    )?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let due_for_review_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words
          WHERE next_review_at IS NOT NULL AND next_review_at <= ?1
            AND list_status = 'confirmed' AND (?2 IS NULL OR book_id = ?2)",
        params![now_ms, book],
        |row| row.get(0),
    )?;

    let evidence_start = earliest_activity(&conn, book)?;
    let effective_start = match evidence_start {
        Some(evidence) => query.period_start.max(evidence),
        // Nothing in scope has ever happened: collapse the walk to zero
        // buckets rather than spending the loop on empty history.
        None => query.period_end,
    };
    let trend_granularity = choose_granularity(effective_start, query.period_end);
    let bucket_keys = enumerate_bucket_keys(
        effective_start,
        query.period_end,
        query.timezone_offset_minutes,
        trend_granularity,
    )?;
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT created_at FROM lookup_records
              WHERE created_at >= ?1 AND created_at < ?2 AND (?3 IS NULL OR book_id = ?3)",
        )?;
        let mut rows = stmt.query(params![query.period_start, query.period_end, book])?;
        while let Some(row) = rows.next()? {
            let created_at: i64 = row.get(0)?;
            let date = local_date(created_at, query.timezone_offset_minutes);
            let key = bucket_key(&date, trend_granularity);
            *counts.entry(key).or_insert(0) += 1;
        }
    }
    let trend = bucket_keys
        .into_iter()
        .map(|date| {
            let count = counts.get(&date).copied().unwrap_or(0);
            VocabTrendBucket { date, count }
        })
        .collect();

    let (total, new_count, learning_count, familiar_count, mastered_snapshot) = conn.query_row(
        "SELECT
            COUNT(*),
            COALESCE(SUM(CASE WHEN mastery = 'new' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN mastery = 'learning' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN mastery = 'familiar' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN mastery = 'mastered' THEN 1 ELSE 0 END), 0)
         FROM vocab_words
         WHERE list_status = 'confirmed' AND (?1 IS NULL OR book_id = ?1)",
        params![book],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        },
    )?;

    Ok(VocabLearningDashboard {
        query: query.clone(),
        lookup_count,
        new_words_count,
        mastered_count,
        due_for_review_count,
        trend_granularity,
        trend,
        mastery_distribution: VocabMasteryDistribution {
            total,
            new_count,
            learning_count,
            familiar_count,
            mastered_count: mastered_snapshot,
        },
    })
}

#[tauri::command]
pub fn get_vocab_learning_dashboard(
    query: VocabLearningQuery,
    db: State<'_, Db>,
) -> AppResult<VocabLearningDashboard> {
    get_vocab_learning_dashboard_inner(&db, &query)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    fn insert_book(db: &Db, id: &str) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES (?1, 'Book', 'Author', 'book.epub', 'reading', 0, 1, 1)",
                params![id],
            )
            .unwrap();
    }

    fn insert_lookup(db: &Db, id: &str, book_id: &str, created_at: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO lookup_records
                    (id, book_id, lookup_text, normalized_text, cfi, definition, created_at, last_looked_up_at, lookup_count)
                 VALUES (?1, ?2, 'word', 'word', ?1, '', ?3, ?3, 1)",
                params![id, book_id, created_at],
            )
            .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_vocab_word(
        db: &Db,
        id: &str,
        book_id: &str,
        mastery: &str,
        list_status: &str,
        created_at: i64,
        next_review_at: Option<i64>,
    ) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO vocab_words
                    (id, book_id, word, definition, mastery, list_status, created_at, updated_at, next_review_at)
                 VALUES (?1, ?2, ?3, 'definition', ?4, ?5, ?6, ?6, ?7)",
                params![id, book_id, id, mastery, list_status, created_at, next_review_at],
            )
            .unwrap();
    }

    fn insert_mastery_event(db: &Db, vocab_word_id: &str, to_mastery: &str, created_at: i64) {
        crate::commands::mastery_events::record_mastery_event(
            &db.conn.lock().unwrap(),
            vocab_word_id,
            "learning",
            to_mastery,
            "auto",
            "exposure_promotion",
            "{}",
            created_at,
        )
        .unwrap();
    }

    fn base_query(period_start: i64, period_end: i64) -> VocabLearningQuery {
        VocabLearningQuery {
            period_start,
            period_end,
            scope_book_id: None,
            timezone_offset_minutes: 0,
        }
    }

    #[test]
    fn counts_lookups_new_words_and_mastered_transitions_within_the_period() {
        let (_dir, db) = test_db();
        insert_book(&db, "b1");
        insert_lookup(&db, "l1", "b1", 1_700_000_000_000);
        insert_lookup(&db, "l2", "b1", 1_700_000_050_000);
        // Outside the period — must not be counted.
        insert_lookup(&db, "l3", "b1", 1_600_000_000_000);

        insert_vocab_word(&db, "v1", "b1", "new", "confirmed", 1_700_000_010_000, None);
        // A watchlist row (never saved) must not inflate new_words_count.
        insert_vocab_word(&db, "v2", "b1", "new", "watchlist", 1_700_000_010_000, None);

        insert_mastery_event(&db, "v1", "mastered", 1_700_000_020_000);
        // Outside the period.
        insert_mastery_event(&db, "v1", "mastered", 1_600_000_000_000);

        let dashboard = get_vocab_learning_dashboard_inner(
            &db,
            &base_query(1_690_000_000_000, 1_710_000_000_000),
        )
        .unwrap();
        assert_eq!(dashboard.lookup_count, 2);
        assert_eq!(dashboard.new_words_count, 1);
        assert_eq!(dashboard.mastered_count, 1);
    }

    #[test]
    fn due_for_review_ignores_the_period_but_respects_the_book_filter() {
        let (_dir, db) = test_db();
        insert_book(&db, "b1");
        insert_book(&db, "b2");
        let now = chrono::Utc::now().timestamp_millis();
        insert_vocab_word(&db, "v1", "b1", "learning", "confirmed", now, Some(now - 1_000));
        insert_vocab_word(&db, "v2", "b2", "learning", "confirmed", now, Some(now - 1_000));
        // Not due yet.
        insert_vocab_word(&db, "v3", "b1", "learning", "confirmed", now, Some(now + 999_999_999));

        // A period that does not cover "now" at all — due count is unaffected.
        let far_past = base_query(1, 2);
        let whole_library = get_vocab_learning_dashboard_inner(&db, &far_past).unwrap();
        assert_eq!(whole_library.due_for_review_count, 2);

        let mut scoped = far_past;
        scoped.scope_book_id = Some("b1".to_string());
        let scoped_dashboard = get_vocab_learning_dashboard_inner(&db, &scoped).unwrap();
        assert_eq!(scoped_dashboard.due_for_review_count, 1);
    }

    #[test]
    fn the_book_filter_narrows_every_count_and_the_distribution() {
        let (_dir, db) = test_db();
        insert_book(&db, "b1");
        insert_book(&db, "b2");
        insert_lookup(&db, "l1", "b1", 1_700_000_000_000);
        insert_lookup(&db, "l2", "b2", 1_700_000_000_000);
        insert_vocab_word(&db, "v1", "b1", "mastered", "confirmed", 1_700_000_000_000, None);
        insert_vocab_word(&db, "v2", "b2", "familiar", "confirmed", 1_700_000_000_000, None);

        let mut query = base_query(1_690_000_000_000, 1_710_000_000_000);
        query.scope_book_id = Some("b1".to_string());
        let dashboard = get_vocab_learning_dashboard_inner(&db, &query).unwrap();
        assert_eq!(dashboard.lookup_count, 1);
        assert_eq!(dashboard.mastery_distribution.total, 1);
        assert_eq!(dashboard.mastery_distribution.mastered_count, 1);
        assert_eq!(dashboard.mastery_distribution.familiar_count, 0);
    }

    /// Zero-activity days inside the period still get a bucket — the chart
    /// draws a short flat bar for a quiet day instead of a gap.
    #[test]
    fn the_trend_includes_zero_count_days() {
        let (_dir, db) = test_db();
        insert_book(&db, "b1");
        // 2024-01-01 and 2024-01-03, UTC.
        insert_lookup(&db, "l1", "b1", 1_704_067_200_000);
        insert_lookup(&db, "l2", "b1", 1_704_240_000_000);

        let query = base_query(1_704_067_200_000, 1_704_326_400_000); // 2024-01-01 .. 2024-01-04
        let dashboard = get_vocab_learning_dashboard_inner(&db, &query).unwrap();
        assert_eq!(dashboard.trend_granularity, VocabTrendGranularity::Day);
        let counts: Vec<(String, i64)> = dashboard
            .trend
            .iter()
            .map(|bucket| (bucket.date.clone(), bucket.count))
            .collect();
        assert_eq!(
            counts,
            vec![
                ("2024-01-01".to_string(), 1),
                ("2024-01-02".to_string(), 0),
                ("2024-01-03".to_string(), 1),
            ]
        );
    }

    /// "All time" nominally starts at the frontend's fixed 2000-01-01 anchor
    /// (see `rangeBounds` in `tauri-adapter.ts`), but the trend must not walk
    /// a quarter-century of empty history to get there — it clamps to the
    /// reader's actual earliest activity instead.
    #[test]
    fn granularity_is_chosen_from_actual_activity_not_the_nominal_period_start() {
        let (_dir, db) = test_db();
        insert_book(&db, "b1");
        let recent = chrono::Utc::now().timestamp_millis() - 5 * DAY_MS;
        insert_lookup(&db, "l1", "b1", recent);

        let query = base_query(946_684_800_000, chrono::Utc::now().timestamp_millis()); // 2000-01-01 .. now
        let dashboard = get_vocab_learning_dashboard_inner(&db, &query).unwrap();
        assert_eq!(dashboard.trend_granularity, VocabTrendGranularity::Day);
        assert!(dashboard.trend.len() < 10, "trend should span only the last few days of real activity, got {} buckets", dashboard.trend.len());
    }

    #[test]
    fn no_activity_at_all_yields_an_empty_trend_rather_than_an_error() {
        let (_dir, db) = test_db();
        insert_book(&db, "b1");
        let query = base_query(946_684_800_000, chrono::Utc::now().timestamp_millis());
        let dashboard = get_vocab_learning_dashboard_inner(&db, &query).unwrap();
        assert!(dashboard.trend.is_empty());
        assert_eq!(dashboard.lookup_count, 0);
    }

    #[test]
    fn a_year_long_period_buckets_by_week() {
        let (_dir, db) = test_db();
        insert_book(&db, "b1");
        // Two lookups roughly six months apart so real activity spans the
        // full nominal year and week bucketing kicks in.
        insert_lookup(&db, "l1", "b1", 1_704_067_200_000); // 2024-01-01
        insert_lookup(&db, "l2", "b1", 1_719_792_000_000); // 2024-07-01
        let query = base_query(1_704_067_200_000, 1_735_689_600_000); // 2024-01-01 .. 2025-01-01
        let dashboard = get_vocab_learning_dashboard_inner(&db, &query).unwrap();
        assert_eq!(dashboard.trend_granularity, VocabTrendGranularity::Week);
        assert_eq!(dashboard.trend.iter().map(|b| b.count).sum::<i64>(), 2);
    }

    #[test]
    fn rejects_an_invalid_period() {
        let (_dir, db) = test_db();
        let mut query = base_query(100, 100);
        assert!(get_vocab_learning_dashboard_inner(&db, &query).is_err());
        query.period_end = 200;
        query.timezone_offset_minutes = 10_000;
        assert!(get_vocab_learning_dashboard_inner(&db, &query).is_err());
    }
}
