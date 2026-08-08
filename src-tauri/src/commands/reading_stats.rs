//! Device-local reading history primitives for P3.1.
//!
//! The command registration belongs in `commands/mod.rs` and `lib.rs`; this
//! feature-local module deliberately leaves that shared integration to the
//! reader integration pass.  Facts are deterministic and the AI request body
//! accepts only those facts, never book text, highlights, notes, or timestamps.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{FixedOffset, TimeZone, Timelike, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

pub const MIN_SESSION_SECONDS: i64 = 30;
#[allow(dead_code)]
pub const IDLE_PAUSE_SECONDS: i64 = 5 * 60;
const MAX_TIMEZONE_OFFSET_MINUTES: i32 = 24 * 60 - 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingSessionInput {
    pub book_id: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub active_seconds: i64,
    /// Optional stable key for a periodic checkpoint. Repeating a checkpoint
    /// with the same key updates the row instead of double-counting it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingSessionRecordResult {
    pub recorded: bool,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFacts {
    pub period_start: i64,
    pub period_end: i64,
    pub total_active_seconds: i64,
    pub session_count: u32,
    pub books_touched: u32,
    pub completed_books: u32,
    pub most_read_book_title: Option<String>,
    pub most_read_book_seconds: i64,
    pub reading_days: u32,
    pub most_common_hour: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStatsQuery {
    pub period_start: i64,
    pub period_end: i64,
    #[serde(default)]
    pub scope_book_id: Option<String>,
    /// JavaScript's `Date#getTimezoneOffset()` convention (UTC minus local).
    /// The value is used only for local day/hour bucketing; rows remain UTC.
    #[serde(default)]
    pub timezone_offset_minutes: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStatsOverview {
    pub total_active_seconds: i64,
    pub session_count: u32,
    pub books_touched: u32,
    pub completed_books: u32,
    pub reading_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStatsBook {
    pub book_id: String,
    pub title: String,
    pub author: String,
    pub total_active_seconds: i64,
    pub session_count: u32,
    pub reading_days: u32,
    pub last_read_at: i64,
    pub completed: bool,
    pub progress: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStatsCalendarSession {
    pub session_id: String,
    pub book_id: String,
    pub title: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub active_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStatsCalendarDay {
    pub date: String,
    pub active_seconds: i64,
    pub session_count: u32,
    pub books_touched: u32,
    pub sessions: Vec<ReadingStatsCalendarSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStatsDashboard {
    pub query: ReadingStatsQuery,
    pub overview: ReadingStatsOverview,
    pub books: Vec<ReadingStatsBook>,
    pub calendar: Vec<ReadingStatsCalendarDay>,
    pub facts: ReviewFacts,
    pub cached_review: Option<CachedReadingReview>,
    /// Set only when this dashboard is scoped to one book (`scope_book_id`)
    /// and that book's most recent automatic review attempt failed. One of
    /// `"notConfigured"`, `"quotaExceeded"`, `"offline"`, `"failed"` — the
    /// same vocabulary the manual retry path already uses, so the page can
    /// render its placeholder card with the exact same strings rather than a
    /// parallel set invented for this one case. `None` once a generation for
    /// this book succeeds, whether triggered automatically or by hand.
    pub review_pending_reason: Option<String>,
}

/// The exact, allow-listed body that may leave the device for an AI review.
/// Deliberately absent: book ids, body text, notes, highlights, raw times and
/// location/progress identifiers. Titles are a user-visible library metadata
/// field and only the single most-read title is included for natural prose.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingReviewAiPayload {
    pub schema_version: u8,
    pub facts: ReviewFacts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CachedReadingReview {
    pub id: String,
    pub facts: ReviewFacts,
    pub narrative: String,
    pub provider_profile_id: String,
    pub provider: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Stores prose only after the shared AI router has completed successfully.
/// Keeping this separate ensures a failed provider response cannot overwrite a
/// previously useful cached review.
pub fn save_cached_review_inner(
    db: &Db,
    facts: &ReviewFacts,
    scope_book_id: Option<&str>,
    narrative: &str,
    provider_profile_id: &str,
    provider: &str,
    model: &str,
) -> AppResult<CachedReadingReview> {
    let narrative = narrative.trim();
    if narrative.is_empty()
        || narrative.len() > 32_000
        || provider_profile_id.trim().is_empty()
        || provider.trim().is_empty()
        || model.trim().is_empty()
    {
        return Err(AppError::Other("READING_REVIEW_INVALID".to_string()));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let id = uuid::Uuid::new_v4().to_string();
    let facts_json = serde_json::to_string(facts)
        .map_err(|error| AppError::Other(format!("READING_REVIEW_FACTS_INVALID: {error}")))?;
    let conn = db.conn.lock().expect("db mutex");
    // A book has exactly one review, so a book-scoped save is matched (and
    // overwritten) by `scope_book_id` alone — never by period. The automatic
    // trigger's window is always "first session on this book .. now", so a
    // regeneration's `period_end` is different from the last save's on
    // principle; matching on period here would silently start a version
    // history instead of overwriting it. A whole-library review has no such
    // single identity, so it keeps the old period-keyed match: "this year"
    // and "all time" are legitimately two different rows.
    let updated = match scope_book_id {
        Some(book_id) => conn.execute(
            "UPDATE ai_reading_reviews SET facts_json = ?1, narrative = ?2,
                    provider_profile_id = ?3, provider = ?4, model = ?5, updated_at = ?6,
                    period_start = ?7, period_end = ?8
              WHERE scope_book_id = ?9",
            params![
                facts_json,
                narrative,
                provider_profile_id.trim(),
                provider.trim(),
                model.trim(),
                now,
                facts.period_start,
                facts.period_end,
                book_id
            ],
        )?,
        None => conn.execute(
            "UPDATE ai_reading_reviews SET facts_json = ?1, narrative = ?2,
                    provider_profile_id = ?3, provider = ?4, model = ?5, updated_at = ?6
              WHERE period_start = ?7 AND period_end = ?8 AND scope_book_id IS NULL",
            params![
                facts_json,
                narrative,
                provider_profile_id.trim(),
                provider.trim(),
                model.trim(),
                now,
                facts.period_start,
                facts.period_end,
            ],
        )?,
    };
    if updated == 0 {
        conn.execute(
            "INSERT INTO ai_reading_reviews (
             id, period_start, period_end, scope_book_id, facts_json, narrative,
             provider_profile_id, provider, model, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ",
            params![
                id,
                facts.period_start,
                facts.period_end,
                scope_book_id,
                facts_json,
                narrative,
                provider_profile_id.trim(),
                provider.trim(),
                model.trim(),
                now
            ],
        )?;
    }
    // A saved review — automatic or by hand — is the thing the pending
    // marker exists to promise. Whichever one arrives first retires it.
    if let Some(book_id) = scope_book_id {
        conn.execute(
            "DELETE FROM pending_book_reviews WHERE book_id = ?1",
            params![book_id],
        )?;
    }
    drop(conn);
    cached_review(db, facts.period_start, facts.period_end, scope_book_id)?
        .ok_or_else(|| AppError::Other("READING_REVIEW_CACHE_UNAVAILABLE".to_string()))
}

#[tauri::command]
pub fn save_reading_review(
    facts: ReviewFacts,
    scope_book_id: Option<String>,
    narrative: String,
    provider_profile_id: String,
    provider: String,
    model: String,
    db: State<'_, Db>,
) -> AppResult<CachedReadingReview> {
    save_cached_review_inner(
        &db,
        &facts,
        scope_book_id.as_deref(),
        &narrative,
        &provider_profile_id,
        &provider,
        &model,
    )
}

fn validate_session(input: &ReadingSessionInput) -> AppResult<()> {
    if input.book_id.trim().is_empty()
        || input.book_id.len() > 256
        || input.started_at <= 0
        || input.ended_at < input.started_at
        || input.active_seconds < 0
        || input.active_seconds.saturating_mul(1_000)
            > input.ended_at.saturating_sub(input.started_at)
        || input
            .checkpoint_key
            .as_deref()
            .is_some_and(|key| key.trim().is_empty() || key.len() > 256)
    {
        return Err(AppError::Other("READING_SESSION_INVALID".to_string()));
    }
    Ok(())
}

/// Persists only qualifying active time. The UI owns idle detection; it must
/// close/pause a session after five minutes idle, while this backend provides a
/// final defensive duration check and never invents historical sessions.
pub fn record_reading_session_inner(
    input: &ReadingSessionInput,
    db: &Db,
) -> AppResult<ReadingSessionRecordResult> {
    validate_session(input)?;
    if input.active_seconds < MIN_SESSION_SECONDS {
        return Ok(ReadingSessionRecordResult {
            recorded: false,
            id: None,
        });
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let conn = db.conn.lock().expect("db mutex");
    if let Some(key) = input.checkpoint_key.as_deref().map(str::trim) {
        let existing = conn
            .query_row(
                "SELECT id, book_id, started_at FROM reading_sessions WHERE checkpoint_key = ?1",
                params![key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((_, existing_book_id, existing_started_at)) = existing {
            if existing_book_id != input.book_id || existing_started_at != input.started_at {
                return Err(AppError::Other(
                    "READING_SESSION_CHECKPOINT_CONFLICT".to_string(),
                ));
            }
            // A late retry of an older heartbeat must never truncate a newer
            // checkpoint that already reached SQLite.
            conn.execute(
                "UPDATE reading_sessions
                    SET ended_at = MAX(ended_at, ?1),
                        active_seconds = MAX(active_seconds, ?2)
                  WHERE checkpoint_key = ?3",
                params![input.ended_at, input.active_seconds, key],
            )?;
        } else {
            conn.execute(
                "INSERT INTO reading_sessions
                    (id, book_id, started_at, ended_at, active_seconds, checkpoint_key, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    input.book_id,
                    input.started_at,
                    input.ended_at,
                    input.active_seconds,
                    key,
                    now
                ],
            )?;
        }
    } else {
        conn.execute(
            "INSERT INTO reading_sessions
                (id, book_id, started_at, ended_at, active_seconds, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                input.book_id,
                input.started_at,
                input.ended_at,
                input.active_seconds,
                now
            ],
        )?;
    }
    let stored_id = if let Some(key) = input.checkpoint_key.as_deref().map(str::trim) {
        conn.query_row(
            "SELECT id FROM reading_sessions WHERE checkpoint_key = ?1",
            params![key],
            |row| row.get(0),
        )?
    } else {
        id
    };
    Ok(ReadingSessionRecordResult {
        recorded: true,
        id: Some(stored_id),
    })
}

/// Same write contract as [`record_reading_session_inner`], named explicitly
/// for reader heartbeat callers. The stable key makes retries safe after a
/// timeout or process restart.
pub fn checkpoint_reading_session_inner(
    mut input: ReadingSessionInput,
    checkpoint_key: String,
    db: &Db,
) -> AppResult<ReadingSessionRecordResult> {
    input.checkpoint_key = Some(checkpoint_key);
    record_reading_session_inner(&input, db)
}

#[tauri::command]
pub fn checkpoint_reading_session(
    input: ReadingSessionInput,
    checkpoint_key: String,
    db: State<'_, Db>,
) -> AppResult<ReadingSessionRecordResult> {
    checkpoint_reading_session_inner(input, checkpoint_key, &db)
}

fn validate_query(query: &ReadingStatsQuery) -> AppResult<()> {
    if query.period_start <= 0 || query.period_end <= query.period_start {
        return Err(AppError::Other("READING_STATS_PERIOD_INVALID".to_string()));
    }
    if !(-MAX_TIMEZONE_OFFSET_MINUTES..=MAX_TIMEZONE_OFFSET_MINUTES)
        .contains(&query.timezone_offset_minutes)
    {
        return Err(AppError::Other(
            "READING_STATS_TIMEZONE_INVALID".to_string(),
        ));
    }
    if query
        .scope_book_id
        .as_deref()
        .is_some_and(|id| id.trim().is_empty())
    {
        return Err(AppError::Other("READING_STATS_BOOK_INVALID".to_string()));
    }
    Ok(())
}

/// Also used by `commands::vocab_learning` to bucket lookup/vocab activity by
/// local calendar day — the same "which wall-clock day did this happen on"
/// question the reading-stats calendar already answers.
pub(crate) fn local_date(timestamp_ms: i64, timezone_offset_minutes: i32) -> String {
    // `getTimezoneOffset` is UTC minus local, hence subtract it to obtain the
    // local wall-clock instant. Clamping avoids FixedOffset construction errors
    // for malformed values received from a client.
    let offset = timezone_offset_minutes
        .clamp(-MAX_TIMEZONE_OFFSET_MINUTES, MAX_TIMEZONE_OFFSET_MINUTES)
        * 60;
    let shifted = timestamp_ms.saturating_sub(i64::from(offset) * 1_000);
    Utc.timestamp_millis_opt(shifted)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "1970-01-01".to_string())
}

fn local_hour(timestamp_ms: i64, timezone_offset_minutes: i32) -> u8 {
    let offset = timezone_offset_minutes
        .clamp(-MAX_TIMEZONE_OFFSET_MINUTES, MAX_TIMEZONE_OFFSET_MINUTES)
        * 60;
    let shifted = timestamp_ms.saturating_sub(i64::from(offset) * 1_000);
    Utc.timestamp_millis_opt(shifted)
        .single()
        .map(|dt| dt.hour() as u8)
        .unwrap_or(0)
}

/// Return the UTC epoch-millisecond bounds for a local calendar date.
pub fn local_day_bounds(date: &str, timezone_offset_minutes: i32) -> AppResult<(i64, i64)> {
    let parsed = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| AppError::Other("READING_STATS_DATE_INVALID".to_string()))?;
    let offset = FixedOffset::east_opt(
        -timezone_offset_minutes.clamp(-MAX_TIMEZONE_OFFSET_MINUTES, MAX_TIMEZONE_OFFSET_MINUTES)
            * 60,
    )
    .ok_or_else(|| AppError::Other("READING_STATS_TIMEZONE_INVALID".to_string()))?;
    let start = offset
        .from_local_datetime(&parsed.and_hms_opt(0, 0, 0).expect("midnight"))
        .single()
        .ok_or_else(|| AppError::Other("READING_STATS_DATE_INVALID".to_string()))?;
    let end = start + chrono::Duration::days(1);
    Ok((start.timestamp_millis(), end.timestamp_millis()))
}

fn clipped_seconds(
    started_at: i64,
    ended_at: i64,
    active_seconds: i64,
    window_start: i64,
    window_end: i64,
) -> i64 {
    let overlap_start = started_at.max(window_start);
    let overlap_end = ended_at.min(window_end);
    if overlap_end <= overlap_start || ended_at <= started_at || active_seconds <= 0 {
        return 0;
    }
    let span = ended_at - started_at;
    // Session input stores active time as seconds, while dashboard windows are
    // milliseconds. Proportional clipping is deterministic for heartbeat rows
    // that cross midnight and never counts time outside the selected range.
    let active_at = |timestamp: i64| {
        ((timestamp - started_at) as i128 * i128::from(active_seconds) / i128::from(span))
            .clamp(0, i128::from(active_seconds))
    };
    (active_at(overlap_end) - active_at(overlap_start)) as i64
}

struct ReadingSessionRow {
    id: String,
    book_id: String,
    title: String,
    author: String,
    progress: i32,
    started_at: i64,
    ended_at: i64,
    active_seconds: i64,
    completed: bool,
}

fn query_sessions(db: &Db, query: &ReadingStatsQuery) -> AppResult<Vec<ReadingSessionRow>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT s.id, s.book_id, b.title, b.author, b.progress,
                s.started_at, s.ended_at, s.active_seconds,
                (b.status = 'finished' OR b.progress >= 100) AS completed
           FROM reading_sessions s JOIN books b ON b.id = s.book_id
          WHERE s.ended_at > ?1 AND s.started_at < ?2
            AND (?3 IS NULL OR s.book_id = ?3)
          ORDER BY s.started_at ASC, s.id ASC",
    )?;
    let rows = stmt.query_map(
        params![
            query.period_start,
            query.period_end,
            query.scope_book_id.as_deref()
        ],
        |row| {
            Ok(ReadingSessionRow {
                id: row.get("id")?,
                book_id: row.get("book_id")?,
                title: row.get("title")?,
                author: row.get("author")?,
                progress: row.get("progress")?,
                started_at: row.get("started_at")?,
                ended_at: row.get("ended_at")?,
                active_seconds: row.get("active_seconds")?,
                completed: row.get::<_, i64>("completed")? != 0,
            })
        },
    )?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn get_reading_stats_dashboard_inner(
    db: &Db,
    query: &ReadingStatsQuery,
) -> AppResult<ReadingStatsDashboard> {
    validate_query(query)?;
    let rows = query_sessions(db, query)?;
    let mut overview = ReadingStatsOverview::default();
    let mut books: BTreeMap<String, ReadingStatsBook> = BTreeMap::new();
    let mut days: BTreeMap<String, (i64, u32, BTreeSet<String>, Vec<ReadingStatsCalendarSession>)> =
        BTreeMap::new();
    let mut day_book_seconds: BTreeMap<(String, String), i64> = BTreeMap::new();
    let mut hours: BTreeMap<u8, u32> = BTreeMap::new();
    for row in rows {
        let effective = clipped_seconds(
            row.started_at,
            row.ended_at,
            row.active_seconds,
            query.period_start,
            query.period_end,
        );
        // The 30-second threshold applies to the original persisted segment,
        // not to the slice remaining after a range/day boundary clips it.
        if effective <= 0 {
            continue;
        }
        overview.total_active_seconds += effective;
        overview.session_count += 1;
        *hours
            .entry(local_hour(row.started_at, query.timezone_offset_minutes))
            .or_default() += 1;
        let entry = books
            .entry(row.book_id.clone())
            .or_insert_with(|| ReadingStatsBook {
                book_id: row.book_id.clone(),
                title: row.title.clone(),
                author: row.author.clone(),
                total_active_seconds: 0,
                session_count: 0,
                reading_days: 0,
                last_read_at: row.ended_at,
                completed: row.completed,
                progress: row.progress,
            });
        entry.total_active_seconds += effective;
        entry.session_count += 1;
        entry.last_read_at = entry.last_read_at.max(row.ended_at);
        entry.completed |= row.completed;
        entry.progress = entry.progress.max(row.progress);

        // Split a session at each local midnight. This also handles a query
        // that starts/ends halfway through a day without leaking seconds.
        let mut cursor = row.started_at.max(query.period_start);
        let stop = row.ended_at.min(query.period_end);
        while cursor < stop {
            let date = local_date(cursor, query.timezone_offset_minutes);
            let (_, next_day) = local_day_bounds(&date, query.timezone_offset_minutes)?;
            let boundary = next_day.min(stop);
            let part = clipped_seconds(
                row.started_at,
                row.ended_at,
                row.active_seconds,
                cursor,
                boundary,
            );
            if part > 0 {
                let item = days
                    .entry(date.clone())
                    .or_insert_with(|| (0, 0, BTreeSet::new(), Vec::new()));
                item.0 += part;
                item.1 += 1;
                item.2.insert(row.book_id.clone());
                item.3.push(ReadingStatsCalendarSession {
                    session_id: row.id.clone(),
                    book_id: row.book_id.clone(),
                    title: row.title.clone(),
                    started_at: cursor,
                    ended_at: boundary,
                    active_seconds: part,
                });
                *day_book_seconds
                    .entry((date.clone(), row.book_id.clone()))
                    .or_default() += part;
            }
            cursor = boundary;
        }
    }
    overview.books_touched = books.len() as u32;
    overview.completed_books = books.values().filter(|book| book.completed).count() as u32;
    overview.reading_days = days.len() as u32;
    for book in books.values_mut() {
        book.reading_days = day_book_seconds
            .keys()
            .filter(|(_, id)| id == &book.book_id)
            .count() as u32;
    }
    let mut books = books.into_values().collect::<Vec<_>>();
    books.sort_by(|left, right| {
        right
            .total_active_seconds
            .cmp(&left.total_active_seconds)
            .then_with(|| left.title.cmp(&right.title))
    });
    let calendar = days
        .into_iter()
        .map(
            |(date, (active_seconds, session_count, book_ids, sessions))| ReadingStatsCalendarDay {
                date,
                active_seconds,
                session_count,
                books_touched: book_ids.len() as u32,
                sessions,
            },
        )
        .collect();
    let facts = ReviewFacts {
        period_start: query.period_start,
        period_end: query.period_end,
        total_active_seconds: overview.total_active_seconds,
        session_count: overview.session_count,
        books_touched: overview.books_touched,
        completed_books: overview.completed_books,
        most_read_book_title: books.first().map(|book| book.title.clone()),
        most_read_book_seconds: books.first().map_or(0, |book| book.total_active_seconds),
        reading_days: overview.reading_days,
        most_common_hour: hours
            .into_iter()
            .max_by_key(|(hour, count)| (*count, std::cmp::Reverse(*hour)))
            .map(|(hour, _)| hour),
    };
    let cached_review = cached_review(
        db,
        query.period_start,
        query.period_end,
        query.scope_book_id.as_deref(),
    )?;
    // Only meaningful once a review is scoped to one book — a "was it ever
    // due" question the whole-library view has no answer to.
    let review_pending_reason = match query.scope_book_id.as_deref() {
        Some(book_id) => review_pending_reason(db, book_id)?,
        None => None,
    };
    Ok(ReadingStatsDashboard {
        query: query.clone(),
        overview,
        books,
        calendar,
        facts,
        cached_review,
        review_pending_reason,
    })
}

#[tauri::command]
pub fn get_reading_stats_dashboard(
    query: ReadingStatsQuery,
    db: State<'_, Db>,
) -> AppResult<ReadingStatsDashboard> {
    get_reading_stats_dashboard_inner(&db, &query)
}

#[tauri::command]
pub fn record_reading_session(
    input: ReadingSessionInput,
    db: State<'_, Db>,
) -> AppResult<ReadingSessionRecordResult> {
    record_reading_session_inner(&input, &db)
}

pub fn aggregate_review_facts_with_timezone(
    db: &Db,
    period_start: i64,
    period_end: i64,
    scope_book_id: Option<&str>,
    timezone_offset_minutes: i32,
) -> AppResult<ReviewFacts> {
    let query = ReadingStatsQuery {
        period_start,
        period_end,
        scope_book_id: scope_book_id.map(str::to_string),
        timezone_offset_minutes,
    };
    Ok(get_reading_stats_dashboard_inner(db, &query)?.facts)
}

pub fn review_ai_payload(facts: ReviewFacts) -> ReadingReviewAiPayload {
    ReadingReviewAiPayload {
        schema_version: 1,
        facts,
    }
}

/// Fixed, inspectable prompt envelope for the optional AI review. The only
/// interpolated value is the allow-listed facts JSON; no reader text or raw
/// session rows can reach this function.
pub fn reading_review_prompt(
    payload: &ReadingReviewAiPayload,
    language: &str,
) -> AppResult<Vec<crate::commands::ai::ChatMessage>> {
    let language = match language.trim().to_ascii_lowercase().as_str() {
        "zh" | "zh-cn" | "zh-hans" => "Chinese",
        "fr" => "French",
        _ => "English",
    };
    let facts = serde_json::to_string(&payload.facts)
        .map_err(|error| AppError::Other(format!("READING_REVIEW_FACTS_INVALID: {error}")))?;
    Ok(vec![
        crate::commands::ai::ChatMessage {
            role: "system".to_string(),
            content: format!(
                "You write a short private reading review in {language}. Use only the supplied structured facts. Do not infer or invent books, dates, habits, progress, quotes, highlights, notes, or locations. If a fact is absent, omit that claim. Return plain text only."
            ),
        },
        crate::commands::ai::ChatMessage {
            role: "user".to_string(),
            content: format!("Structured reading facts (schema v{}): {facts}", payload.schema_version),
        },
    ])
}

pub fn validate_reading_review_narrative(narrative: &str) -> AppResult<String> {
    let normalized = narrative.trim();
    if normalized.is_empty() || normalized.len() > 32_000 {
        return Err(AppError::Ai("READING_REVIEW_AI_INVALID".to_string()));
    }
    Ok(normalized.to_string())
}

pub fn reading_review_error_code(error: &AppError) -> &'static str {
    let text = error.to_string().to_ascii_lowercase();
    if text.contains("not_configured")
        || text.contains("no_usable_keys")
        || text.contains("keys_disabled")
    {
        "READING_REVIEW_AI_NOT_CONFIGURED"
    } else if text.contains("quota") || text.contains("insufficient") || text.contains("status=402")
    {
        "READING_REVIEW_AI_QUOTA"
    } else if text.contains("cancel") {
        "READING_REVIEW_AI_CANCELLED"
    } else if text.contains("network")
        || text.contains("offline")
        || text.contains("timeout")
        || text.contains("connect")
    {
        "READING_REVIEW_AI_OFFLINE"
    } else {
        "READING_REVIEW_AI_FAILED"
    }
}

/// Shared-router completion hook. The caller must surface provider/model and
/// the explicit send-scope/fee confirmation in its UI before invoking this.
///
/// `origin` tags the spend in `ai_usage_records`: `"user"` when a button was
/// pressed, `"auto"` when `commands::auto_analysis` decided to run it. The
/// console's whole headline is that split, so it is a parameter rather than
/// a constant — a job that forgot to say it was automatic would report its
/// cost as something the reader chose to pay.
// Every argument here is one the shared router needs verbatim; bundling them
// into a struct would only move the same list one layer out.
#[allow(clippy::too_many_arguments)]
pub async fn generate_reading_review_inner(
    app: &tauri::AppHandle,
    db: &Db,
    secrets: &crate::secrets::Secrets,
    query: ReadingStatsQuery,
    language: String,
    retry: Option<bool>,
    request_id: Option<String>,
    origin: &str,
) -> AppResult<ReadingReviewAiResult> {
    let facts = aggregate_review_facts_with_timezone(
        db,
        query.period_start,
        query.period_end,
        query.scope_book_id.as_deref(),
        query.timezone_offset_minutes,
    )?;
    let payload = review_ai_payload(facts.clone());
    let messages = reading_review_prompt(&payload, &language)?;
    let completion = crate::ai::router::complete_with_failover(
        app,
        db,
        secrets,
        &messages,
        Some(1_200),
        crate::ai::router::AiRequestPurpose::Utility,
        crate::ai::router::retry_mode(retry),
        request_id.as_deref(),
        None,
        origin,
        // Must stay exactly the `reading_review` job id in
        // `commands::auto_analysis::JOBS` — the console totals this job's
        // spend by this column and silently reports zero if the two drift.
        "reading_review",
    )
    .await
    .map_err(|error| AppError::Ai(reading_review_error_code(&error).to_string()))?;
    let narrative = validate_reading_review_narrative(&completion.text)?;
    let cached = save_cached_review_inner(
        db,
        &facts,
        query.scope_book_id.as_deref(),
        &narrative,
        &completion.profile_id,
        &completion.provider,
        &completion.model,
    )?;
    Ok(ReadingReviewAiResult {
        narrative,
        facts,
        provider_profile_id: completion.profile_id,
        provider: completion.provider,
        model: completion.model,
        updated_at: cached.updated_at,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingReviewAiResult {
    pub narrative: String,
    pub facts: ReviewFacts,
    pub provider_profile_id: String,
    pub provider: String,
    pub model: String,
    pub updated_at: i64,
}

#[tauri::command]
pub async fn generate_reading_review(
    query: ReadingStatsQuery,
    language: String,
    retry: Option<bool>,
    request_id: Option<String>,
    app: tauri::AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, crate::secrets::Secrets>,
) -> AppResult<ReadingReviewAiResult> {
    generate_reading_review_inner(
        &app, &db, &secrets, query, language, retry, request_id, "user",
    )
    .await
}

/// The window a whole-book review covers: the reader's first recorded
/// session on that book through now.
///
/// `None` means there is nothing to review — a book with no sessions was
/// marked finished without ever being opened here (imported as read, or
/// finished elsewhere), and inventing a period for it would spend the
/// reader's quota to describe an empty set.
fn book_review_period(db: &Db, book_id: &str) -> Option<(i64, i64)> {
    let conn = db.reader();
    let first: Option<i64> = conn
        .query_row(
            "SELECT MIN(started_at) FROM reading_sessions WHERE book_id = ?1",
            params![book_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    let start = first.filter(|value| *value > 0)?;
    let end = chrono::Utc::now().timestamp_millis();
    (end > start).then_some((start, end))
}

/// Whether this book already has a review stored, under any period.
///
/// The automatic run is once-per-book, not once-per-finish: a reader who
/// marks a book unread and finished again is correcting their shelf, not
/// asking to be billed a second time for the same summary.
fn book_already_reviewed(db: &Db, book_id: &str) -> bool {
    let conn = db.reader();
    conn.query_row(
        "SELECT 1 FROM ai_reading_reviews WHERE scope_book_id = ?1 LIMIT 1",
        params![book_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// The `reading_review` job's automatic trigger: a book was just marked
/// finished.
///
/// The reader pressed "mark as finished", not "summarise this" — being
/// handed an error dialog for a request they never made would be worse than
/// simply not getting the summary, so this never surfaces anything directly.
/// But a distinction still matters underneath: a closed gate or an existing
/// review are the reader's own choices and stay silent for good, while an
/// unconfigured provider, an exhausted quota, a dead network and a model
/// error are *this run's* failure, not a decision anyone made — those leave
/// a pending marker (`mark_review_pending`) so the reading-stats page can
/// still offer the summary, on request, the next time the reader is there.
#[tauri::command]
pub async fn run_book_finished_analysis(
    book_id: String,
    language: String,
    timezone_offset_minutes: i32,
    app: tauri::AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, crate::secrets::Secrets>,
) -> AppResult<bool> {
    if !crate::commands::auto_analysis::is_enabled(&db.reader(), "reading_review") {
        return Ok(false);
    }
    if book_already_reviewed(&db, &book_id) {
        return Ok(false);
    }
    let Some((period_start, period_end)) = book_review_period(&db, &book_id) else {
        return Ok(false);
    };
    let query = ReadingStatsQuery {
        period_start,
        period_end,
        scope_book_id: Some(book_id.clone()),
        timezone_offset_minutes,
    };
    match generate_reading_review_inner(&app, &db, &secrets, query, language, None, None, "auto")
        .await
    {
        Ok(_) => Ok(true),
        Err(error) => {
            log::debug!("auto reading review skipped: {error}");
            let _ = mark_review_pending(&db, &book_id, pending_reason_bucket(&error));
            Ok(false)
        }
    }
}

/// The `ai_reading_reviews` columns `row_to_cached_review` reads, named in
/// exactly one place so the two feeding SELECTs in `cached_review` can't
/// drift out of order.
const CACHED_REVIEW_COLUMNS: &str = "id, facts_json, narrative, provider_profile_id, provider, model, created_at, updated_at";

fn row_to_cached_review(row: &rusqlite::Row) -> rusqlite::Result<CachedReadingReview> {
    Ok(CachedReadingReview {
        id: row.get("id")?,
        facts: serde_json::from_str::<ReviewFacts>(&row.get::<_, String>("facts_json")?).map_err(
            |e| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            },
        )?,
        narrative: row.get("narrative")?,
        provider_profile_id: row.get("provider_profile_id")?,
        provider: row.get("provider")?,
        model: row.get("model")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// A book-scoped lookup ignores `period_start`/`period_end` entirely and
/// finds the one row that exists for `scope_book_id` — mirroring the
/// overwrite-by-book-id rule in [`save_cached_review_inner`]. This is what
/// lets the reading-stats page find a book's summary regardless of which
/// date range tab happens to be selected: the summary was generated for
/// "first session on this book .. now", not for "this year" or "all time".
/// A whole-library lookup (`scope_book_id: None`) still matches the exact
/// period, since a library review has no identity apart from its window.
pub fn cached_review(
    db: &Db,
    period_start: i64,
    period_end: i64,
    scope_book_id: Option<&str>,
) -> AppResult<Option<CachedReadingReview>> {
    let conn = db.reader();
    match scope_book_id {
        Some(book_id) => conn
            .query_row(
                &format!(
                    "SELECT {CACHED_REVIEW_COLUMNS}
                   FROM ai_reading_reviews WHERE scope_book_id = ?1"
                ),
                params![book_id],
                row_to_cached_review,
            )
            .optional()
            .map_err(Into::into),
        None => conn
            .query_row(
                &format!(
                    "SELECT {CACHED_REVIEW_COLUMNS}
                   FROM ai_reading_reviews WHERE period_start = ?1 AND period_end = ?2 AND scope_book_id IS NULL"
                ),
                params![period_start, period_end],
                row_to_cached_review,
            )
            .optional()
            .map_err(Into::into),
    }
}

/// Whether this book's most recent automatic review attempt is still owed a
/// successful generation. `None` once either an automatic or a manual run
/// has produced a review (see the delete in [`save_cached_review_inner`]).
pub fn review_pending_reason(db: &Db, book_id: &str) -> AppResult<Option<String>> {
    let conn = db.reader();
    conn.query_row(
        "SELECT reason FROM pending_book_reviews WHERE book_id = ?1",
        params![book_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

/// Records that this book's automatic review attempt failed, so the
/// reading-stats page can show a placeholder in that book's spot instead of
/// nothing. Overwrites any earlier reason for the same book — only the most
/// recent attempt's outcome matters, there is no history of failures to
/// keep.
fn mark_review_pending(db: &Db, book_id: &str, reason: &str) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let conn = db.conn.lock().expect("db mutex");
    conn.execute(
        "INSERT INTO pending_book_reviews (book_id, reason, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(book_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at",
        params![book_id, reason, now],
    )?;
    Ok(())
}

/// Maps an automatic-attempt failure onto the same four buckets the manual
/// retry path already shows on screen (`ReadingReviewErrorCode` on the
/// frontend) — the placeholder card reuses that exact vocabulary instead of
/// inventing a fifth state for the case where nobody was watching.
fn pending_reason_bucket(error: &AppError) -> &'static str {
    match reading_review_error_code(error) {
        "READING_REVIEW_AI_NOT_CONFIGURED" => "notConfigured",
        "READING_REVIEW_AI_QUOTA" => "quotaExceeded",
        "READING_REVIEW_AI_OFFLINE" => "offline",
        _ => "failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books
                    (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES ('book-1', 'Book one', 'Author', 'book.epub', 'finished', 100, ?1, ?1)",
                params![1_704_067_200_000_i64],
            )
            .unwrap();
        (dir, db)
    }

    fn insert_session(db: &Db, id: &str, book_id: &str, started_at: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO reading_sessions
                    (id, book_id, started_at, ended_at, active_seconds, created_at)
                 VALUES (?1, ?2, ?3, ?4, 600, ?3)",
                params![id, book_id, started_at, started_at + 600_000],
            )
            .unwrap();
    }

    #[test]
    fn a_book_never_opened_here_has_nothing_to_review() {
        let (_dir, db) = test_db();
        // Marked finished on import, or finished on another device. Spending
        // the reader's quota to summarise zero sessions is the failure mode
        // this guards.
        assert_eq!(book_review_period(&db, "book-1"), None);
    }

    #[test]
    fn the_review_window_opens_at_the_first_session_on_that_book() {
        let (_dir, db) = test_db();
        insert_session(&db, "s2", "book-1", 2_000_000_000_000);
        insert_session(&db, "s1", "book-1", 1_700_000_000_000);
        let (start, end) = book_review_period(&db, "book-1").unwrap();
        assert_eq!(start, 1_700_000_000_000);
        assert!(end > start);
    }

    #[test]
    fn another_books_sessions_do_not_open_a_window() {
        let (_dir, db) = test_db();
        insert_session(&db, "s1", "book-2", 1_700_000_000_000);
        assert_eq!(book_review_period(&db, "book-1"), None);
    }

    #[test]
    fn a_book_that_already_has_a_review_is_not_billed_for_a_second_one() {
        let (_dir, db) = test_db();
        assert!(!book_already_reviewed(&db, "book-1"));
        save_cached_review_inner(
            &db,
            &ReviewFacts {
                period_start: 1_700_000_000_000,
                period_end: 1_700_000_100_000,
                ..Default::default()
            },
            Some("book-1"),
            "A summary.",
            "profile",
            "anthropic",
            "model",
        )
        .unwrap();
        // Any period counts: re-finishing a book is the reader tidying a
        // shelf, not asking to pay again.
        assert!(book_already_reviewed(&db, "book-1"));
        assert!(!book_already_reviewed(&db, "book-2"));
    }

    /// Reproduces the pre-043 shape a real library could carry: two
    /// book-scoped reviews for the same book, coexisting because the old
    /// unique index keyed on `(period_start, period_end, scope_book_id)`
    /// rather than `scope_book_id` alone (`033_reading_stats.sql:41`). The
    /// reading-stats page's book picker + date-range tabs are what produced
    /// this in practice: regenerating the same book's review under "all
    /// time" and then later under "last 30 days" writes two rows, since
    /// each has a different period.
    ///
    /// Migration 043 must dedupe those rows to one-per-book before it lays
    /// down `idx_ai_reading_reviews_book_scope`, or applying it against a
    /// library with this shape fails outright (`UNIQUE constraint failed:
    /// ai_reading_reviews.scope_book_id`) and the app never starts.
    #[test]
    fn migration_043_dedupes_duplicate_book_scoped_reviews_keeping_the_latest() {
        use rusqlite::Connection;
        use std::sync::{Arc, Mutex};

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("lantern.db");
        let conn = Connection::open(&db_path).unwrap();

        // Stop one migration short of the fix under test: the table exists
        // with its *original* per-period unique index, matching exactly
        // what a real user's database looks like right before upgrading.
        Db::run_migrations_up_to(&conn, 42).unwrap();

        conn.execute(
            "INSERT INTO books
                (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book-1', 'Book one', 'Author', 'book.epub', 'finished', 100, 1000, 1000)",
            [],
        )
        .unwrap();

        let facts_json = serde_json::to_string(&ReviewFacts::default()).unwrap();

        // Row A: generated first, under "all time" — never regenerated
        // again, so its updated_at never moves past its created_at.
        conn.execute(
            "INSERT INTO ai_reading_reviews
                (id, period_start, period_end, scope_book_id, facts_json, narrative,
                 provider_profile_id, provider, model, created_at, updated_at)
             VALUES ('review-all-time', 1000, 5000, 'book-1', ?1, 'first summary',
                     'profile', 'anthropic', 'model', 1000, 1000)",
            params![facts_json],
        )
        .unwrap();
        // Row B: generated later, under "last 30 days" — a different
        // (period_start, period_end) than row A, so the old unique index
        // (which included the period) let both rows coexist for the same
        // book. Its updated_at is the highest of the two.
        conn.execute(
            "INSERT INTO ai_reading_reviews
                (id, period_start, period_end, scope_book_id, facts_json, narrative,
                 provider_profile_id, provider, model, created_at, updated_at)
             VALUES ('review-30-days', 2000, 6000, 'book-1', ?1, 'latest summary',
                     'profile', 'anthropic', 'model', 2000, 9000)",
            params![facts_json],
        )
        .unwrap();

        // Run migration 043 and everything after it. This line used to
        // raise `UNIQUE constraint failed: ai_reading_reviews.scope_book_id`.
        Db::run_migrations_on(&conn).unwrap();

        let remaining: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, narrative FROM ai_reading_reviews WHERE scope_book_id = 'book-1'",
                )
                .unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        // Exactly one row survives, and it's the one with the highest
        // updated_at — the generation the reader actually saw last.
        assert_eq!(
            remaining,
            vec![("review-30-days".to_string(), "latest summary".to_string())]
        );

        // Confirm the book-scoped read path (`cached_review`, which queries
        // by `scope_book_id` alone and expects at most one row) is healthy
        // post-dedup. Before the fix, this call would have panicked with
        // `QueryReturnedMoreThanOneRow` on any library carrying this shape.
        let db = Db {
            conn: Arc::new(Mutex::new(conn)),
            read_conn: Arc::new(Mutex::new(Connection::open(&db_path).unwrap())),
            data_dir: Arc::new(Mutex::new(dir.path().to_path_buf())),
            local_dir: Arc::new(Mutex::new(dir.path().to_path_buf())),
        };
        let review = cached_review(&db, 0, 0, Some("book-1"))
            .unwrap()
            .unwrap();
        assert_eq!(review.narrative, "latest summary");
    }

    #[test]
    fn a_whole_library_review_does_not_look_like_a_books_own() {
        let (_dir, db) = test_db();
        save_cached_review_inner(
            &db,
            &ReviewFacts {
                period_start: 1_700_000_000_000,
                period_end: 1_700_000_100_000,
                ..Default::default()
            },
            None,
            "A summary.",
            "profile",
            "anthropic",
            "model",
        )
        .unwrap();
        assert!(!book_already_reviewed(&db, "book-1"));
    }

    #[test]
    fn short_sessions_are_never_eligible() {
        assert!(
            ReadingSessionInput {
                book_id: "b".into(),
                started_at: 1,
                ended_at: 30,
                active_seconds: 29,
                checkpoint_key: None,
            }
            .active_seconds
                < MIN_SESSION_SECONDS
        );
    }

    #[test]
    fn payload_serializes_facts_only() {
        let payload = review_ai_payload(ReviewFacts {
            total_active_seconds: 42,
            most_read_book_title: Some("A book".into()),
            ..Default::default()
        });
        let json = serde_json::to_value(payload).unwrap();
        assert!(json.get("facts").is_some());
        assert!(json.get("note").is_none());
        assert!(json.get("highlights").is_none());
        assert!(json.get("timestamps").is_none());
    }

    #[test]
    fn local_day_boundary_uses_js_timezone_offset() {
        // 2024-01-01 00:30 in UTC+1 is still 2024-01-01 locally.
        let timestamp = 1_704_069_000_000_i64;
        assert_eq!(local_date(timestamp, -60), "2024-01-01");
        let (start, end) = local_day_bounds("2024-01-01", -60).unwrap();
        assert!(timestamp >= start && timestamp < end);
    }

    #[test]
    fn clipping_never_counts_outside_window() {
        assert_eq!(clipped_seconds(0, 120_000, 120, 60_000, 180_000), 60);
        assert_eq!(clipped_seconds(0, 120_000, 120, 180_000, 240_000), 0);
        assert_eq!(
            clipped_seconds(0, 120_000, 61, 0, 60_000)
                + clipped_seconds(0, 120_000, 61, 60_000, 120_000),
            61
        );
    }

    #[test]
    fn checkpoint_retries_update_one_row() {
        let (_dir, db) = test_db();
        let input = ReadingSessionInput {
            book_id: "book-1".into(),
            started_at: 1_704_067_200_000,
            ended_at: 1_704_067_260_000,
            active_seconds: 60,
            checkpoint_key: None,
        };
        let first = checkpoint_reading_session_inner(input.clone(), "stable".into(), &db).unwrap();
        let mut extended = input.clone();
        extended.ended_at += 30_000;
        extended.active_seconds += 30;
        let second = checkpoint_reading_session_inner(extended, "stable".into(), &db).unwrap();
        assert_eq!(first.id, second.id);
        checkpoint_reading_session_inner(input, "stable".into(), &db).unwrap();
        let (count, seconds): (i64, i64) = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*), MAX(active_seconds) FROM reading_sessions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((count, seconds), (1, 90));
    }

    #[test]
    fn dashboard_clips_a_valid_session_across_local_midnight() {
        let (_dir, db) = test_db();
        let (_, midnight) = local_day_bounds("2024-01-01", -60).unwrap();
        record_reading_session_inner(
            &ReadingSessionInput {
                book_id: "book-1".into(),
                started_at: midnight - 30_000,
                ended_at: midnight + 30_000,
                active_seconds: 60,
                checkpoint_key: None,
            },
            &db,
        )
        .unwrap();
        let dashboard = get_reading_stats_dashboard_inner(
            &db,
            &ReadingStatsQuery {
                period_start: midnight - 60_000,
                period_end: midnight + 60_000,
                scope_book_id: None,
                timezone_offset_minutes: -60,
            },
        )
        .unwrap();
        assert_eq!(dashboard.overview.total_active_seconds, 60);
        assert_eq!(dashboard.overview.completed_books, 1);
        assert_eq!(dashboard.calendar.len(), 2);
        assert_eq!(dashboard.calendar[0].active_seconds, 30);
        assert_eq!(dashboard.calendar[1].active_seconds, 30);
        assert_eq!(dashboard.calendar[0].sessions.len(), 1);
    }

    #[test]
    fn ai_prompt_contains_facts_but_no_reader_sources() {
        let payload = review_ai_payload(ReviewFacts {
            total_active_seconds: 61,
            most_read_book_title: Some("A title".into()),
            ..Default::default()
        });
        let prompt = reading_review_prompt(&payload, "en").unwrap();
        assert!(prompt[1].content.contains("A title"));
        assert!(!prompt[1].content.contains("highlights"));
        assert!(!prompt[1].content.contains("notes"));
    }

    /// docs/impls/reading-flow-decisions-2026-08-06.md §3.4 — "the old one is
    /// replaced, no version history". `run_book_finished_analysis` always
    /// requests (first session .. now), so a regeneration's `period_end`
    /// differs from the first save's on principle; this is the case the old
    /// period-keyed uniqueness would have gotten wrong.
    #[test]
    fn regenerating_a_books_review_overwrites_it_rather_than_versioning() {
        let (_dir, db) = test_db();
        let first_facts = ReviewFacts {
            period_start: 1_700_000_000_000,
            period_end: 1_700_000_100_000,
            total_active_seconds: 60,
            ..Default::default()
        };
        save_cached_review_inner(
            &db, &first_facts, Some("book-1"), "First read.", "profile", "anthropic", "model",
        )
        .unwrap();
        // A reader who rereads the book generates again much later — the
        // window's end (and therefore the whole period tuple) has moved on.
        let second_facts = ReviewFacts {
            period_start: 1_700_000_000_000,
            period_end: 1_800_000_000_000,
            total_active_seconds: 900,
            ..Default::default()
        };
        save_cached_review_inner(
            &db, &second_facts, Some("book-1"), "Second read.", "profile", "anthropic", "model",
        )
        .unwrap();
        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM ai_reading_reviews WHERE scope_book_id = 'book-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let review = cached_review(&db, 0, 0, Some("book-1")).unwrap().unwrap();
        assert_eq!(review.narrative, "Second read.");
    }

    /// The reading-stats page may be scoped to "this year" or "30 days" while
    /// a book's own summary was generated for an entirely different window
    /// ("first session on this book .. whenever it finished"). The lookup
    /// must find the book's one review regardless.
    #[test]
    fn a_books_review_is_found_no_matter_which_period_the_page_is_showing() {
        let (_dir, db) = test_db();
        let facts = ReviewFacts {
            period_start: 1_700_000_000_000,
            period_end: 1_700_000_100_000,
            ..Default::default()
        };
        save_cached_review_inner(
            &db, &facts, Some("book-1"), "A summary.", "profile", "anthropic", "model",
        )
        .unwrap();
        let found = cached_review(&db, 0, 9_999_999_999_999, Some("book-1")).unwrap();
        assert_eq!(found.map(|r| r.narrative), Some("A summary.".to_string()));
    }

    /// A whole-library review keeps its old identity: two different windows
    /// ("this year" vs "all time") are two different rows, and a lookup for
    /// one must not return the other's prose.
    #[test]
    fn a_library_reviews_period_still_has_to_match() {
        let (_dir, db) = test_db();
        save_cached_review_inner(
            &db,
            &ReviewFacts {
                period_start: 1_700_000_000_000,
                period_end: 1_700_000_100_000,
                ..Default::default()
            },
            None,
            "This year.",
            "profile",
            "anthropic",
            "model",
        )
        .unwrap();
        assert!(cached_review(&db, 1_700_000_000_000, 1_700_000_100_000, None)
            .unwrap()
            .is_some());
        assert!(cached_review(&db, 0, 9_999_999_999_999, None).unwrap().is_none());
    }

    #[test]
    fn a_failed_automatic_attempt_leaves_a_pending_marker() {
        let (_dir, db) = test_db();
        assert_eq!(review_pending_reason(&db, "book-1").unwrap(), None);
        mark_review_pending(&db, "book-1", "offline").unwrap();
        assert_eq!(
            review_pending_reason(&db, "book-1").unwrap(),
            Some("offline".to_string())
        );
    }

    /// Only the latest attempt's outcome is kept — there is no history of
    /// failures, matching the "no version history" rule for the reviews
    /// themselves.
    #[test]
    fn marking_pending_twice_overwrites_the_reason_in_place() {
        let (_dir, db) = test_db();
        mark_review_pending(&db, "book-1", "offline").unwrap();
        mark_review_pending(&db, "book-1", "quotaExceeded").unwrap();
        assert_eq!(
            review_pending_reason(&db, "book-1").unwrap(),
            Some("quotaExceeded".to_string())
        );
        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM pending_book_reviews", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    /// Whichever generation succeeds first — automatic or by hand — retires
    /// the marker. This is the only thing that clears it; a manual retry
    /// that fails again must leave it exactly as it was (nothing re-asserts
    /// it, so there is nothing to test there beyond this not firing).
    #[test]
    fn a_successful_save_clears_the_pending_marker_for_that_book() {
        let (_dir, db) = test_db();
        mark_review_pending(&db, "book-1", "offline").unwrap();
        save_cached_review_inner(
            &db,
            &ReviewFacts {
                period_start: 1_700_000_000_000,
                period_end: 1_700_000_100_000,
                ..Default::default()
            },
            Some("book-1"),
            "Finally generated.",
            "profile",
            "anthropic",
            "model",
        )
        .unwrap();
        assert_eq!(review_pending_reason(&db, "book-1").unwrap(), None);
    }

    #[test]
    fn pending_reason_bucket_matches_the_four_retry_error_codes() {
        assert_eq!(
            pending_reason_bucket(&AppError::Other("no_usable_keys".into())),
            "notConfigured"
        );
        assert_eq!(
            pending_reason_bucket(&AppError::Other("insufficient quota".into())),
            "quotaExceeded"
        );
        assert_eq!(
            pending_reason_bucket(&AppError::Other("network timeout".into())),
            "offline"
        );
        assert_eq!(
            pending_reason_bucket(&AppError::Other("the model refused".into())),
            "failed"
        );
    }

    /// `get_reading_stats_dashboard_inner` only ever answers "is a review
    /// owed" when the page is scoped to one book — the whole-library view has
    /// no book to be pending on.
    #[test]
    fn dashboard_only_reports_pending_when_scoped_to_a_book() {
        let (_dir, db) = test_db();
        insert_session(&db, "s1", "book-1", 1_700_000_000_000);
        mark_review_pending(&db, "book-1", "offline").unwrap();
        let scoped = get_reading_stats_dashboard_inner(
            &db,
            &ReadingStatsQuery {
                period_start: 1,
                period_end: 9_999_999_999_999,
                scope_book_id: Some("book-1".to_string()),
                timezone_offset_minutes: 0,
            },
        )
        .unwrap();
        assert_eq!(scoped.review_pending_reason, Some("offline".to_string()));
        let library = get_reading_stats_dashboard_inner(
            &db,
            &ReadingStatsQuery {
                period_start: 1,
                period_end: 9_999_999_999_999,
                scope_book_id: None,
                timezone_offset_minutes: 0,
            },
        )
        .unwrap();
        assert_eq!(library.review_pending_reason, None);
    }
}
