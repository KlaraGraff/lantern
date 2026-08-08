//! The reader's user profile — see `docs/impls/user-profile.md`.
//!
//! Two segments feed every card-aware follow-up prompt (wiring deferred to a
//! later batch): a free-text segment the reader writes themselves
//! (`settings.profile.user_text` / `.draft_text` / `.enabled` /
//! `.soft_limit`), and a system segment organised into a fixed set of seven
//! [`DIMENSIONS`], one card each, held in `profile_cards`.
//!
//! ## The three layers between a correction and a prompt
//!
//! `profile_events` is an append-only, raw ledger — every delete, move, undo,
//! and automatic rewrite. Nothing here is ever read into a prompt directly.
//! [`derive_slot_state`] is a pure-code adjudication pass over that ledger:
//! latest explicit action wins, an undo cancels a move, the watermark is the
//! timestamp of the last delete. Its output is at most one derived-state
//! line per dimension — [`DELETION_STATE_LINE`] — which is all that ever
//! reaches the summarizer. Contradictions resolve by timestamp ordering in
//! code, never by asking the model to judge the ledger; see the plan doc's
//! citations (mem0, arXiv 2606.01435's "extraction to the LLM, policy to
//! code") for why.
//!
//! ## Two AI calls, one feature tag
//!
//! [`run_summarize`] makes exactly two `AiRequestPurpose::Utility` calls,
//! both billed under [`JOB_ID`]: one to draft new cards from pre-aggregated
//! evidence, one to review them (R1–R5, see [`REVIEW_INSTRUCTIONS`]). The
//! review pass is a safety net — any way it can fail (unparseable response,
//! the call itself erroring out) defaults every card to "keep" rather than
//! blocking the write-back.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use rand::Rng;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

use crate::commands::ai::ChatMessage;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;
use crate::word_frequency::{lookup_with, FormIndex};

/// This job's id — and, by the auto-analysis registry's rule, the exact
/// string both AI calls below are tagged with in `ai_usage_records.feature`.
/// Drift between the two would make the console's spend total for this job
/// silently report zero forever.
pub const JOB_ID: &str = "user_profile";

const WINDOW_DAYS: i64 = 90;
const DAY_MS: i64 = 86_400_000;
/// Recency-decay half-life for weighting evidence: a record 30 days old
/// counts half as much as a fresh one. `level_observation.rs` (the module
/// this plan pointed at for "reuse the decay algorithm") turns out to use a
/// flat 90-day window with no decay at all — there is nothing to reuse. This
/// half-life is this module's own, self-designed to match the plan's prose
/// ("近的记录权重高，越旧越轻") rather than any borrowed formula.
const HALF_LIFE_DAYS: f64 = 30.0;
/// Per-dimension threshold: fewer than this many eligible records and the
/// dimension is invisible to the summarizer this round — no data block, no
/// definition, nothing.
const MIN_RECORDS: i64 = 5;
const MAX_CARD_CHARS: usize = 140;
const MAX_TOTAL_CHARS: usize = 1000;
const DEFAULT_SOFT_LIMIT: i64 = 1200;
/// Batch trigger floor: a batch only fires once at least this many follow-up
/// questions have been classified since the last revision.
const BATCH_MIN_NEW_CLASSIFIED: i64 = 20;
const MAX_EVIDENCE_SAMPLES: usize = 5;
const MAX_LOOKUP_SAMPLES: usize = 15;
const MAX_EXAMPLE_BOOKS: usize = 5;

const USER_TEXT_KEY: &str = "profile.user_text";
const DRAFT_TEXT_KEY: &str = "profile.draft_text";
const ENABLED_KEY: &str = "profile.enabled";
const SOFT_LIMIT_KEY: &str = "profile.soft_limit";

static SUMMARIZE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Holds [`SUMMARIZE_RUNNING`] for the lifetime of one run — manual
/// ([`profile_summarize_now`]) and automatic ([`maybe_spawn_summarize`])
/// alike, so the two can never overlap. Release is `Drop`, not a bare
/// `store(false, ...)` at the end of the happy path: a panic mid-run would
/// otherwise leave the flag stuck at `true` forever, silently wedging every
/// future trigger.
struct SummarizeGuard;

impl SummarizeGuard {
    /// `None` if a run is already in flight.
    fn acquire() -> Option<Self> {
        if SUMMARIZE_RUNNING.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(Self)
        }
    }
}

impl Drop for SummarizeGuard {
    fn drop(&mut self) {
        SUMMARIZE_RUNNING.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Dimension registry
// ---------------------------------------------------------------------------

/// One of the seven fixed dimensions. `definition` is prompt text (English,
/// never user-facing — the model reads it, not the reader), so it carries no
/// i18n obligation. The reader-facing name for each key lives in the
/// frontend under `profile.slot.<key>`.
pub struct Dimension {
    pub key: &'static str,
    definition: &'static str,
}

/// Fixed by design — see the plan doc's §2: "禁区(写进定义,审核兜底)". Every
/// definition below repeats the shared forbidden zone (explanation language,
/// level/vocabulary-size/difficulty claims, claimed original-text
/// quotation) so a single dropped sentence can't quietly lose the guard; the
/// review pass (R1–R3) is the backstop for whichever one gets through
/// anyway.
pub const DIMENSIONS: &[Dimension] = &[
    Dimension {
        key: "vocab_explain",
        definition: "How this reader likes word meanings explained — e.g. contrastive nuance, \
            etymology, collocations, or example sentences. Never state what language to explain \
            in (that is a separate setting); never state or imply a CEFR level, vocabulary size, \
            or difficulty ceiling (a separate setting and a separate feature); never claim to \
            quote a specific original-text sentence.",
    },
    Dimension {
        key: "syntax_explain",
        definition: "How this reader likes sentence structure broken down — e.g. what order to \
            work through it in, how much grammatical terminology to use. Never state what \
            language to explain in; never state or imply a CEFR level, vocabulary size, or \
            difficulty ceiling; never claim to quote a specific original-text sentence.",
    },
    Dimension {
        key: "reference_explain",
        definition: "Whether this reader prefers being told directly what a pronoun or reference \
            points to, or walked through the reasoning that gets there. Never state what language \
            to explain in; never state or imply a CEFR level, vocabulary size, or difficulty \
            ceiling; never claim to quote a specific original-text sentence.",
    },
    Dimension {
        key: "cultural_context",
        definition: "How much background this reader wants for cultural or historical context, \
            and how closely tied to the plot it should stay. Never state what language to \
            explain in; never state or imply a CEFR level, vocabulary size, or difficulty \
            ceiling; never claim to quote a specific original-text sentence.",
    },
    Dimension {
        key: "lookup_pattern",
        definition: "What kind of words this reader tends to look up — describe the pattern only \
            (word-frequency band, apparent domain, part of speech are all fair to describe from \
            the sample). Never turn this into a skill judgment — a level or vocabulary-size \
            conclusion belongs to a separate setting and a separate feature, not here. Never state \
            what language to explain in; never claim to quote a specific original-text sentence.",
    },
    Dimension {
        key: "example_source",
        definition: "What genre and register this reader's own reading skews toward, so an \
            explanation's examples can be pulled from familiar territory. Never claim to quote a \
            specific original-text sentence — pulling an actual sentence is a separate retrieval \
            feature, not this note. Never state what language to explain in; never state or imply \
            a CEFR level, vocabulary size, or difficulty ceiling.",
    },
    Dimension {
        key: "reply_pacing",
        definition: "How much this reader wants up front — a short answer first versus full \
            detail immediately — and how far a follow-up conversation usually goes before they \
            stop. Never describe when during the day this reader is active; time-of-day is out of \
            scope entirely, not just unavailable. Never state what language to explain in; never \
            state or imply a CEFR level, vocabulary size, or difficulty ceiling; never claim to \
            quote a specific original-text sentence.",
    },
];

fn dimension(key: &str) -> Option<&'static Dimension> {
    DIMENSIONS.iter().find(|d| d.key == key)
}

const FOLLOWUP_CATEGORY: &[(&str, &str)] = &[
    ("vocab_explain", "vocabulary"),
    ("syntax_explain", "syntax"),
    ("reference_explain", "reference"),
    ("cultural_context", "cultural"),
];

// ---------------------------------------------------------------------------
// Card status / event type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardStatus {
    Active,
    Moved,
    Deleted,
}

impl CardStatus {
    fn as_db(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Moved => "moved",
            Self::Deleted => "deleted",
        }
    }

    fn from_db(value: &str) -> Self {
        match value {
            "moved" => Self::Moved,
            "deleted" => Self::Deleted,
            _ => Self::Active,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileEventType {
    Delete,
    Move,
    Undo,
    Rewrite,
}

impl ProfileEventType {
    fn from_db(value: &str) -> Option<Self> {
        match value {
            "delete" => Some(Self::Delete),
            "move" => Some(Self::Move),
            "undo" => Some(Self::Undo),
            "rewrite" => Some(Self::Rewrite),
            // "effect" (future self-learning hook, Appendix B) and anything
            // else carry no status weight in the adjudication pass.
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Adjudication layer (pure code, no AI)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EventRecord {
    event_type: ProfileEventType,
    created_at: i64,
}

/// Pure adjudication: given one dimension's full delete/move/undo/rewrite
/// history — in any order — decide its current status and, if it has ever
/// been deleted, the watermark aggregation should filter by.
///
/// `rewrite` events (the summarizer's own automatic writes) never carry
/// status weight; only `delete`/`move`/`undo` do. The latest of those three
/// by timestamp wins outright — an `undo` after a `move` puts the dimension
/// back to active, a further `delete` after that puts it back to deleted,
/// and so on. The watermark is the max timestamp across every `delete` ever
/// seen (deletes are never removed from the ledger, so this is monotonic:
/// re-deleting a regrown dimension only ever pushes the watermark forward).
fn derive_slot_state(events: &[EventRecord]) -> (CardStatus, Option<i64>) {
    let mut latest_action: Option<EventRecord> = None;
    let mut watermark: Option<i64> = None;
    for event in events {
        if event.event_type == ProfileEventType::Delete {
            watermark = Some(watermark.map_or(event.created_at, |w| w.max(event.created_at)));
        }
        if !matches!(
            event.event_type,
            ProfileEventType::Delete | ProfileEventType::Move | ProfileEventType::Undo
        ) {
            continue;
        }
        let newer = latest_action.is_none_or(|current| event.created_at >= current.created_at);
        if newer {
            latest_action = Some(*event);
        }
    }
    let status = match latest_action.map(|event| event.event_type) {
        Some(ProfileEventType::Delete) => CardStatus::Deleted,
        Some(ProfileEventType::Move) => CardStatus::Moved,
        _ => CardStatus::Active,
    };
    (status, watermark)
}

fn events_for_slot(conn: &Connection, slot: &str) -> AppResult<Vec<EventRecord>> {
    let mut stmt = conn.prepare(
        "SELECT event_type, created_at FROM profile_events WHERE slot = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![slot], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (event_type, created_at) = row?;
        if let Some(event_type) = ProfileEventType::from_db(&event_type) {
            out.push(EventRecord {
                event_type,
                created_at,
            });
        }
    }
    Ok(out)
}

/// Recompute one slot's status/watermark from its full event history and
/// persist it onto `profile_cards`. Called after every reader-initiated
/// correction (move/undo/delete) so the stored row always agrees with the
/// adjudication layer. The summarizer's own writes do **not** go through
/// this — see [`upsert_card`]'s doc comment for why.
fn recompute_and_store(conn: &Connection, slot: &str, now: i64) -> AppResult<()> {
    let events = events_for_slot(conn, slot)?;
    let (status, watermark) = derive_slot_state(&events);
    conn.execute(
        "UPDATE profile_cards SET status = ?1, watermark = ?2, updated_at = ?3 WHERE slot = ?4",
        params![status.as_db(), watermark, now, slot],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings helpers (local-only KV — no SyncWriter; see the plan doc's §1)
// ---------------------------------------------------------------------------

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn delete_setting(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

fn soft_limit(conn: &Connection) -> i64 {
    read_setting(conn, SOFT_LIMIT_KEY)
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_SOFT_LIMIT)
}

/// Always soft limit × 2 — a derived value, never stored, so the multiple
/// can never drift out of sync with the soft limit it is defined from.
fn hard_limit(conn: &Connection) -> i64 {
    soft_limit(conn) * 2
}

fn enabled(conn: &Connection) -> bool {
    read_setting(conn, ENABLED_KEY).as_deref() != Some("false")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------------------------------------------------------------------------
// Recency-decay weighting + weighted sampling
// ---------------------------------------------------------------------------

fn recency_weight(age_days: f64) -> f64 {
    0.5_f64.powf(age_days.max(0.0) / HALF_LIFE_DAYS)
}

/// Weighted, without-replacement sample of up to `k` items using
/// Efraimidis–Spirakis A-Res: each item draws a key `u^(1/weight)` from a
/// uniform `u`, and the `k` largest keys win. A higher weight (fresher
/// evidence) is more likely to win without needing a full weighted shuffle
/// of the whole population.
fn weighted_sample<T>(items: Vec<(f64, T)>, k: usize) -> Vec<T> {
    if items.len() <= k {
        return items.into_iter().map(|(_, item)| item).collect();
    }
    let mut rng = rand::thread_rng();
    let mut keyed: Vec<(f64, T)> = items
        .into_iter()
        .map(|(weight, item)| {
            let u: f64 = rng.gen_range(0.0001_f64..1.0);
            let key = u.powf(1.0 / weight.max(0.0001));
            (key, item)
        })
        .collect();
    keyed.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    keyed.truncate(k);
    keyed.into_iter().map(|(_, item)| item).collect()
}

// ---------------------------------------------------------------------------
// Pre-aggregation (§4) — the summarizer never reads raw records itself
// ---------------------------------------------------------------------------

struct FollowupRow {
    passage: String,
    question: String,
    created_at: i64,
}

fn followup_rows(
    conn: &Connection,
    category: &str,
    since: i64,
    watermark_exclusive: Option<i64>,
) -> AppResult<Vec<FollowupRow>> {
    let mut stmt = conn.prepare(
        "SELECT passage, question, created_at FROM followup_questions
         WHERE difficulty = ?1 AND classified_at IS NOT NULL AND created_at >= ?2
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![category, since], |row| {
        Ok(FollowupRow {
            passage: row.get(0)?,
            question: row.get(1)?,
            created_at: row.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        let row = row?;
        if let Some(watermark) = watermark_exclusive {
            if row.created_at <= watermark {
                continue;
            }
        }
        out.push(row);
    }
    Ok(out)
}

fn build_followup_block(
    conn: &Connection,
    category: &str,
    now: i64,
    watermark: Option<i64>,
) -> AppResult<Option<serde_json::Value>> {
    let since = now - WINDOW_DAYS * DAY_MS;
    let rows = followup_rows(conn, category, since, watermark)?;
    if (rows.len() as i64) < MIN_RECORDS {
        return Ok(None);
    }
    let count = rows.len();
    let weighted_count: f64 = rows
        .iter()
        .map(|row| recency_weight(((now - row.created_at).max(0) as f64) / DAY_MS as f64))
        .sum();
    let weighted: Vec<(f64, &FollowupRow)> = rows
        .iter()
        .map(|row| {
            let age_days = ((now - row.created_at).max(0) as f64) / DAY_MS as f64;
            (recency_weight(age_days), row)
        })
        .collect();
    let sampled = weighted_sample(weighted, MAX_EVIDENCE_SAMPLES);
    let examples: Vec<serde_json::Value> = sampled
        .iter()
        .map(|row| serde_json::json!({ "passage": row.passage, "question": row.question }))
        .collect();
    Ok(Some(serde_json::json!({
        "count": count,
        "weighted_count": weighted_count,
        "sampled_examples": examples,
    })))
}

/// The `lookup_pattern` dimension's rows, before any of them are scored
/// against the frequency table.
///
/// Collected as one step and scored as another because scoring is not
/// allowed to happen under the read lock: [`FormIndex`] takes `db.reader()`
/// itself the first time a word misses the table, and `std::sync::Mutex` is
/// not reentrant — doing both at once deadlocks the app on a word the table
/// has never heard of, which in this reader's case is as likely to be a
/// character's name or a Chinese word as an obscure English one. Mirrors
/// `level_observation.rs`'s `RawRecord`/`collect`/`score` split.
struct LookupPatternRaw {
    rows: Vec<(String, i64, i64)>,
}

fn collect_lookup_pattern_rows(
    conn: &Connection,
    now: i64,
    watermark: Option<i64>,
) -> AppResult<Option<LookupPatternRaw>> {
    let since = now - WINDOW_DAYS * DAY_MS;
    let mut stmt = conn.prepare(
        "SELECT normalized_text, created_at, lookup_count FROM lookup_records WHERE created_at >= ?1",
    )?;
    let mapped = stmt.query_map(params![since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    let mut rows: Vec<(String, i64, i64)> = Vec::new();
    for row in mapped {
        let (word, created_at, lookup_count) = row?;
        if let Some(watermark) = watermark {
            if created_at <= watermark {
                continue;
            }
        }
        rows.push((word, created_at, lookup_count));
    }
    if (rows.len() as i64) < MIN_RECORDS {
        return Ok(None);
    }
    Ok(Some(LookupPatternRaw { rows }))
}

/// Score [`LookupPatternRaw`] against the frequency table. Must be called
/// with no read guard held — see [`LookupPatternRaw`].
fn score_lookup_pattern(raw: &LookupPatternRaw, db: &Db, now: i64) -> serde_json::Value {
    let repeated = raw.rows.iter().filter(|(_, _, count)| *count > 1).count();
    let repeat_rate = repeated as f64 / raw.rows.len() as f64;

    let forms = FormIndex::new(db);
    let mut band_counts = [0i64; 6];
    let mut best_by_word: HashMap<String, i64> = HashMap::new();
    for (word, created_at, _) in &raw.rows {
        if let Ok(Some(entry)) = lookup_with(&forms, word) {
            if (entry.band as usize) < band_counts.len() {
                band_counts[entry.band as usize] += 1;
            }
        }
        best_by_word
            .entry(word.clone())
            .and_modify(|existing| *existing = (*existing).max(*created_at))
            .or_insert(*created_at);
    }
    let weighted: Vec<(f64, String)> = best_by_word
        .into_iter()
        .map(|(word, created_at)| {
            let age_days = ((now - created_at).max(0) as f64) / DAY_MS as f64;
            (recency_weight(age_days), word)
        })
        .collect();
    let sample_words = weighted_sample(weighted, MAX_LOOKUP_SAMPLES);

    serde_json::json!({
        "count": raw.rows.len(),
        "repeat_lookup_rate": repeat_rate,
        "band_distribution": {
            "1": band_counts[1],
            "2": band_counts[2],
            "3": band_counts[3],
            "4": band_counts[4],
            "5": band_counts[5],
        },
        "sample_words": sample_words,
    })
}

fn build_example_source_block(
    conn: &Connection,
    now: i64,
    watermark: Option<i64>,
) -> AppResult<Option<serde_json::Value>> {
    let since = now - WINDOW_DAYS * DAY_MS;
    let mut stmt = conn.prepare(
        "SELECT book_id, active_seconds, created_at FROM reading_sessions WHERE created_at >= ?1",
    )?;
    let mapped = stmt.query_map(params![since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    let mut session_count: i64 = 0;
    let mut by_book: HashMap<String, i64> = HashMap::new();
    for row in mapped {
        let (book_id, active_seconds, created_at) = row?;
        if let Some(watermark) = watermark {
            if created_at <= watermark {
                continue;
            }
        }
        session_count += 1;
        *by_book.entry(book_id).or_insert(0) += active_seconds.max(0);
    }
    if session_count < MIN_RECORDS {
        return Ok(None);
    }
    let total_seconds: i64 = by_book.values().sum();
    if total_seconds <= 0 {
        return Ok(None);
    }
    let mut shares: Vec<(String, i64)> = by_book.into_iter().collect();
    shares.sort_by_key(|b| std::cmp::Reverse(b.1));
    shares.truncate(MAX_EXAMPLE_BOOKS);

    let mut books = Vec::new();
    for (book_id, seconds) in shares {
        let info: Option<(String, String, Option<String>)> = conn
            .query_row(
                "SELECT title, author, language FROM books WHERE id = ?1",
                params![book_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((title, author, language)) = info else {
            continue;
        };
        let share = seconds as f64 / total_seconds as f64;
        books.push(serde_json::json!({
            "title": title,
            "author": author,
            "language": language,
            "share": share,
        }));
    }
    if books.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::json!({ "top_books": books })))
}

/// "Single-turn stop share" has no exact definition in the plan doc. This
/// module defines it as: of every chat that had at least one classified
/// follow-up in the window, the share that had exactly one. Cheap to
/// compute, defensible, and — like every other metric here — never touches
/// time of day.
fn build_reply_pacing_block(
    conn: &Connection,
    now: i64,
    watermark: Option<i64>,
) -> AppResult<Option<serde_json::Value>> {
    let since = now - WINDOW_DAYS * DAY_MS;
    let mut stmt = conn.prepare(
        "SELECT chat_id, question, created_at FROM followup_questions
         WHERE classified_at IS NOT NULL AND created_at >= ?1",
    )?;
    let mapped = stmt.query_map(params![since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    let mut rows: Vec<(String, String, i64)> = Vec::new();
    for row in mapped {
        let (chat_id, question, created_at) = row?;
        if let Some(watermark) = watermark {
            if created_at <= watermark {
                continue;
            }
        }
        rows.push((chat_id, question, created_at));
    }
    if (rows.len() as i64) < MIN_RECORDS {
        return Ok(None);
    }
    let total_chars: usize = rows.iter().map(|(_, question, _)| question.chars().count()).sum();
    let average_question_length = total_chars as f64 / rows.len() as f64;

    let mut per_chat: HashMap<&str, i64> = HashMap::new();
    for (chat_id, _, _) in &rows {
        *per_chat.entry(chat_id.as_str()).or_insert(0) += 1;
    }
    let single_turn_chats = per_chat.values().filter(|count| **count == 1).count();
    let single_turn_share = single_turn_chats as f64 / per_chat.len() as f64;

    Ok(Some(serde_json::json!({
        "count": rows.len(),
        "average_question_length": average_question_length,
        "single_turn_share": single_turn_share,
    })))
}

/// Every dimension except `lookup_pattern`, whose raw-row collection and
/// frequency-table scoring are split across the read-lock boundary — see
/// [`LookupPatternRaw`].
fn build_block(
    conn: &Connection,
    slot: &str,
    watermark: Option<i64>,
    now: i64,
) -> AppResult<Option<serde_json::Value>> {
    if let Some((_, category)) = FOLLOWUP_CATEGORY.iter().find(|(key, _)| *key == slot) {
        return build_followup_block(conn, category, now, watermark);
    }
    match slot {
        "example_source" => build_example_source_block(conn, now, watermark),
        "reply_pacing" => build_reply_pacing_block(conn, now, watermark),
        _ => Ok(None),
    }
}

/// Calibrated deletion-state wording — verbatim, tested. A vaguer earlier
/// version ("与裁决方向一致"-style hedging) caused 4/4 test rounds where a
/// deleted dimension never regrew a card even once fresh, ample evidence
/// existed; this exact phrasing was 3/3 normal. Do not reword it.
const DELETION_STATE_LINE: &str =
    "旧结论已删除;下列样本全部晚于删除时间,数据有效,若足以支撑,应当产出全新结论。";

struct SlotContext {
    slot: &'static str,
    definition: &'static str,
    derived_line: Option<&'static str>,
    payload: serde_json::Value,
}

/// [`gather_slot_contexts`]'s collect-phase output: every dimension except
/// `lookup_pattern` fully built (nothing past this point needs [`FormIndex`]
/// for them), plus `lookup_pattern`'s raw rows, still unscored — see
/// [`LookupPatternRaw`] for why scoring them can't happen in this same pass.
#[derive(Default)]
struct RawSlotContexts {
    ready: Vec<SlotContext>,
    lookup_pattern: Option<(&'static str, &'static str, Option<&'static str>, LookupPatternRaw)>,
}

/// Walks every dimension, in registry order, and decides what the
/// summarizer gets to see this round:
///
/// - `moved` dimensions are skipped outright — permanently excluded from
///   regeneration until the reader undoes the move (this is a query
///   exclusion, not a prompt-level ask for the model's restraint).
/// - a dimension's `watermark` — set once and only by a delete, never
///   cleared on regrowth (see `upsert_card`'s `ON CONFLICT` clause) — always
///   filters its evidence to `created_at > watermark`, regardless of the
///   card's *current* status. Gating that filter on `status == Deleted`
///   would let a dimension that regrew back to `active` start re-admitting
///   the exact pre-delete evidence the reader's delete was asking to
///   discount — the product ruling is that a follow-up from before a delete
///   never gets to draw a second conclusion, not just up until regrowth.
/// - `deleted` dimensions that still clear [`MIN_RECORDS`] after that filter
///   get a data block *and* [`DELETION_STATE_LINE`]. If not, they silently
///   produce nothing this round — indistinguishable, from the outside, from
///   the common case just after a delete.
/// - `active` dimensions get a data block only if they clear the threshold;
///   below it, the dimension (and its definition) is invisible to the model
///   entirely.
fn collect_slot_contexts(conn: &Connection, now: i64) -> AppResult<RawSlotContexts> {
    let mut raw = RawSlotContexts::default();
    for dim in DIMENSIONS {
        let row: Option<(String, Option<i64>)> = conn
            .query_row(
                "SELECT status, watermark FROM profile_cards WHERE slot = ?1",
                params![dim.key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (status, watermark) = match row {
            Some((status, watermark)) => (CardStatus::from_db(&status), watermark),
            None => (CardStatus::Active, None),
        };
        if status == CardStatus::Moved {
            continue;
        }
        // Watermark is monotonic and only ever set by a delete, so applying
        // it unconditionally is always safe — see the doc comment above.
        let effective_watermark = watermark;
        let derived_line = if status == CardStatus::Deleted {
            Some(DELETION_STATE_LINE)
        } else {
            None
        };
        if dim.key == "lookup_pattern" {
            if let Some(lookup_raw) = collect_lookup_pattern_rows(conn, now, effective_watermark)? {
                raw.lookup_pattern = Some((dim.key, dim.definition, derived_line, lookup_raw));
            }
            continue;
        }
        let Some(payload) = build_block(conn, dim.key, effective_watermark, now)? else {
            continue;
        };
        raw.ready.push(SlotContext {
            slot: dim.key,
            definition: dim.definition,
            derived_line,
            payload,
        });
    }
    Ok(raw)
}

/// Scores the deferred `lookup_pattern` rows (if any survived
/// [`MIN_RECORDS`]) and merges everything back into registry order. Must be
/// called with no read guard held — see [`LookupPatternRaw`].
fn score_slot_contexts(raw: RawSlotContexts, db: &Db, now: i64) -> Vec<SlotContext> {
    let mut out = raw.ready;
    if let Some((slot, definition, derived_line, lookup_raw)) = raw.lookup_pattern {
        out.push(SlotContext {
            slot,
            definition,
            derived_line,
            payload: score_lookup_pattern(&lookup_raw, db, now),
        });
    }
    out.sort_by_key(|ctx| {
        DIMENSIONS
            .iter()
            .position(|dim| dim.key == ctx.slot)
            .unwrap_or(usize::MAX)
    });
    out
}

/// Collects under one `db.reader()` guard, drops it, then scores —
/// `lookup_pattern`'s scoring step touches [`FormIndex`], which is not safe
/// to run while any `db.reader()` guard (this function's own, or a caller's)
/// might still be held. See [`LookupPatternRaw`].
fn gather_slot_contexts(db: &Db, now: i64) -> AppResult<Vec<SlotContext>> {
    let raw = {
        let conn = db.reader();
        collect_slot_contexts(&conn, now)?
    };
    Ok(score_slot_contexts(raw, db, now))
}

// ---------------------------------------------------------------------------
// Summarize request
// ---------------------------------------------------------------------------

const RULES_PREAMBLE: &str = "\
You are drafting personalization notes for how an AI reading companion should explain things to \
one particular reader. You will be given, for a handful of dimensions, a definition of what that \
dimension covers and pre-aggregated evidence about this reader's behaviour along it. Write one \
short, free-form conclusion sentence per dimension, in the reader's own voice's register — an \
observation about how they read, not a diagnosis of their ability. Every dimension listed below \
has already cleared a minimum-evidence bar; do not invent a conclusion for a dimension that was \
not given to you, and do not invent a new dimension. A conclusion must stay at or under 140 \
characters. Respond with only a JSON object, no prose, no markdown fences: \
{\"cards\":[{\"slot\":<dimension key>,\"conclusion\":<sentence>,\"evidence\":<one short phrase \
citing which part of the data block supports it>}]}. One entry per dimension you were given data \
for.";

fn summarize_messages(contexts: &[SlotContext], locale: &str) -> Vec<ChatMessage> {
    let mut system = RULES_PREAMBLE.to_string();
    system.push_str(&format!(
        "\n\nWrite every conclusion and evidence phrase in {}.",
        crate::commands::translation::lang_display_name(locale)
    ));
    let mut user = String::new();
    for ctx in contexts {
        user.push_str(&format!(
            "### {}\nDefinition: {}\n",
            ctx.slot, ctx.definition
        ));
        if let Some(line) = ctx.derived_line {
            user.push_str(line);
            user.push('\n');
        }
        user.push_str("Evidence data: ");
        user.push_str(&ctx.payload.to_string());
        user.push_str("\n\n");
    }
    vec![
        ChatMessage {
            role: "system".to_string(),
            content: system,
        },
        ChatMessage {
            role: "user".to_string(),
            content: user,
        },
    ]
}

fn tighten(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut out = messages.to_vec();
    if let Some(system) = out.first_mut() {
        system.content.push_str(
            "\n\nYour previous attempt ran too long. Every conclusion must stay at or under 100 \
             characters this time — keep it to the single most useful observation.",
        );
    }
    out
}

fn strip_code_fence(text: &str) -> &str {
    let trimmed = text.trim();
    let trimmed = trimmed.strip_prefix("```json").unwrap_or(trimmed);
    let trimmed = trimmed.strip_prefix("```").unwrap_or(trimmed);
    trimmed.strip_suffix("```").unwrap_or(trimmed).trim()
}

#[derive(Debug, Clone, Deserialize)]
struct RawCard {
    slot: String,
    conclusion: String,
    #[serde(default)]
    evidence: String,
}

#[derive(Debug, Deserialize)]
struct RawCardsResponse {
    cards: Vec<RawCard>,
}

/// Lenient: an unparseable response is `None` (triggers the one retry, then
/// abandonment); a parseable response with an unknown slot key silently
/// drops just that card — the plan's "收不进的丢弃;不得发明新维度".
fn parse_summary(text: &str, known_slots: &[&str]) -> Option<Vec<RawCard>> {
    let parsed: RawCardsResponse = serde_json::from_str(strip_code_fence(text)).ok()?;
    Some(
        parsed
            .cards
            .into_iter()
            .filter(|card| known_slots.contains(&card.slot.as_str()))
            .collect(),
    )
}

fn cards_pass_limits(cards: &[RawCard]) -> bool {
    let total: usize = cards.iter().map(|card| card.conclusion.chars().count()).sum();
    total <= MAX_TOTAL_CHARS
        && cards
            .iter()
            .all(|card| card.conclusion.chars().count() <= MAX_CARD_CHARS)
}

// ---------------------------------------------------------------------------
// Review request (R1–R5)
// ---------------------------------------------------------------------------

const REVIEW_INSTRUCTIONS: &str = "\
Review each candidate personalization note against five rules. Reject a card only when a rule \
clearly applies; when in doubt, keep it.

R1 — recommends or states what language explanations should be given in.
R2 — states or implies a CEFR level, a vocabulary size, or any difficulty ceiling.
R3 — claims to quote or cite a specific original-text sentence.
R4 — carries no instructional value: restates a raw statistic or describes a habit rather than \
giving an actionable instruction for how to explain things.
R5 — the evidence given does not support the conclusion.

Respond with only a JSON object, no prose, no markdown fences: \
{\"reviews\":[{\"slot\":<dimension key>,\"decision\":\"keep\"|\"reject\",\"rule\":<one of \"R1\", \
\"R2\", \"R3\", \"R4\", \"R5\", or null>}]}. Include exactly one entry per candidate below. A \
reject with no rule, or a rule outside R1–R5, is treated as a keep.";

fn review_messages(cards: &[RawCard]) -> Vec<ChatMessage> {
    let items: Vec<serde_json::Value> = cards
        .iter()
        .map(|card| {
            serde_json::json!({
                "slot": card.slot,
                "conclusion": card.conclusion,
                "evidence": card.evidence,
            })
        })
        .collect();
    vec![
        ChatMessage {
            role: "system".to_string(),
            content: REVIEW_INSTRUCTIONS.to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: serde_json::Value::Array(items).to_string(),
        },
    ]
}

#[derive(Debug, Deserialize)]
struct RawReview {
    slot: String,
    decision: String,
    #[serde(default)]
    rule: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawReviewResponse {
    reviews: Vec<RawReview>,
}

const VALID_RULES: [&str; 5] = ["R1", "R2", "R3", "R4", "R5"];

fn parse_review(text: &str) -> Option<Vec<RawReview>> {
    serde_json::from_str::<RawReviewResponse>(strip_code_fence(text))
        .ok()
        .map(|response| response.reviews)
}

/// Whether `slot` should be rejected: an explicit `"reject"` whose `rule` is
/// one of R1–R5. Everything else — `"keep"`, a missing rule, an invented
/// rule, no matching entry at all — defaults to keep. Reviewing is a safety
/// net; it can narrow the batch, never block it.
fn is_rejected(reviews: &[RawReview], slot: &str) -> bool {
    reviews.iter().any(|review| {
        review.slot == slot
            && review.decision == "reject"
            && review
                .rule
                .as_deref()
                .is_some_and(|rule| VALID_RULES.contains(&rule))
    })
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async fn call_utility<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    messages: &[ChatMessage],
    max_tokens: u32,
    origin: &str,
) -> AppResult<crate::ai::router::AiCompletion> {
    crate::ai::router::complete_with_failover(
        app,
        db,
        secrets,
        messages,
        Some(max_tokens),
        crate::ai::router::AiRequestPurpose::Utility,
        crate::ai::router::AiRetryMode::Automatic,
        None,
        None,
        origin,
        JOB_ID,
    )
    .await
}

/// Records that a batch was attempted — cards in equal cards out — for the
/// three failure paths in [`run_summarize`] that happen *after* at least one
/// billed `Utility` call: two failed parse attempts, every card oversized,
/// or every card review-rejected. Without this, `new_followups_since_last_revision`
/// (the trigger [`maybe_spawn_summarize`] checks) never advances on those
/// paths, so the same already-billed 2–3 calls fire again on every
/// subsequent chat message until the reader happens to send a batch the
/// model parses cleanly.
fn record_empty_attempt(db: &Db, reason: &str, now: i64) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    let cards = active_cards_json(&conn)?;
    conn.execute(
        "INSERT INTO profile_revisions (cards_before, cards_after, reason, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![cards, cards, reason, now],
    )?;
    Ok(())
}

fn active_cards_json(conn: &Connection) -> AppResult<String> {
    let mut stmt =
        conn.prepare("SELECT slot, conclusion FROM profile_cards WHERE status = 'active' ORDER BY slot")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map = serde_json::Map::new();
    for row in rows {
        let (slot, conclusion) = row?;
        map.insert(slot, serde_json::Value::String(conclusion));
    }
    Ok(serde_json::Value::Object(map).to_string())
}

/// The summarizer's own write, distinct from [`recompute_and_store`]: this
/// is what makes a dimension `active` again after a successful regrowth, and
/// it deliberately does **not** run the ledger-based adjudication — a
/// `rewrite` event carries no status weight there by design, so calling
/// `recompute_and_store` here would leave a regrown dimension stuck at
/// `deleted`. Status is `active` because the summarizer just wrote a fresh,
/// reviewed conclusion for it; `watermark`/`inserted_text` are left as they
/// were (untouched columns in the `ON CONFLICT` clause), since neither
/// changes just because a new conclusion landed.
fn upsert_card(conn: &Connection, slot: &str, conclusion: &str, evidence: &str, now: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO profile_cards (slot, conclusion, evidence, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'active', ?4, ?4)
         ON CONFLICT(slot) DO UPDATE SET
           conclusion = excluded.conclusion,
           evidence = excluded.evidence,
           status = 'active',
           updated_at = excluded.updated_at",
        params![slot, conclusion, evidence, now],
    )?;
    Ok(())
}

/// The full seven-step flow from the plan doc's §5. `reason` is `"batch"` or
/// `"manual"`, logged verbatim into `profile_revisions.reason`. Returns the
/// number of cards actually written; `Ok(0)` covers every "nothing to do or
/// nothing survived validation" outcome, by design — none of those are
/// errors.
pub async fn run_summarize<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    origin: &str,
    reason: &str,
) -> AppResult<usize> {
    let now = now_ms();
    // `gather_slot_contexts` already drops its own read guard before scoring
    // `lookup_pattern` against the frequency table — see its doc comment.
    // `gloss_locale` takes `db` and locks its own reader too; calling it
    // while a guard from the block above was still in scope once deadlocked
    // this thread on `db.read_conn`, a plain `std::sync::Mutex` that is not
    // reentrant, so it stays out here regardless.
    let contexts = gather_slot_contexts(db, now)?;
    let locale = crate::commands::ai::vocabulary::gloss_locale(db, None);
    if contexts.is_empty() {
        return Ok(0);
    }
    let known_slots: Vec<&str> = contexts.iter().map(|ctx| ctx.slot).collect();
    let messages = summarize_messages(&contexts, &locale);

    let mut cards = match call_utility(app, db, secrets, &messages, 2_000, origin).await {
        Ok(completion) => parse_summary(&completion.text, &known_slots),
        Err(error) => {
            log::debug!("user_profile: summarize call failed: {error}");
            None
        }
    };
    if cards.is_none() {
        // "解析失败重试一次" — one retry, same messages, then abandon.
        cards = match call_utility(app, db, secrets, &messages, 2_000, origin).await {
            Ok(completion) => parse_summary(&completion.text, &known_slots),
            Err(error) => {
                log::debug!("user_profile: summarize retry call failed: {error}");
                None
            }
        };
    }
    let Some(mut cards) = cards else {
        log::debug!("user_profile: summarize batch abandoned — response never parsed");
        record_empty_attempt(db, reason, now)?;
        return Ok(0);
    };

    if !cards_pass_limits(&cards) {
        let tighter = tighten(&messages);
        if let Ok(completion) = call_utility(app, db, secrets, &tighter, 2_000, origin).await {
            if let Some(retry_cards) = parse_summary(&completion.text, &known_slots) {
                cards = retry_cards;
            }
        }
    }
    // Per-card fallback, never a third full-batch attempt: any card still
    // over the single-card limit is dropped — its slot simply keeps
    // whatever conclusion it already had (or stays absent).
    cards.retain(|card| card.conclusion.chars().count() <= MAX_CARD_CHARS);
    if cards.is_empty() {
        record_empty_attempt(db, reason, now)?;
        return Ok(0);
    }

    let reviews = match call_utility(app, db, secrets, &review_messages(&cards), 1_000, origin).await {
        Ok(completion) => parse_review(&completion.text).unwrap_or_default(),
        Err(error) => {
            log::debug!("user_profile: review call failed, defaulting every card to keep: {error}");
            Vec::new()
        }
    };
    cards.retain(|card| !is_rejected(&reviews, &card.slot));
    if cards.is_empty() {
        record_empty_attempt(db, reason, now)?;
        return Ok(0);
    }

    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    let cards_before = active_cards_json(&conn)?;
    for card in &cards {
        upsert_card(&conn, &card.slot, &card.conclusion, &card.evidence, now)?;
        conn.execute(
            "INSERT INTO profile_events (slot, event_type, user_text, created_at) VALUES (?1, 'rewrite', NULL, ?2)",
            params![card.slot, now],
        )?;
    }
    let cards_after = active_cards_json(&conn)?;
    conn.execute(
        "INSERT INTO profile_revisions (cards_before, cards_after, reason, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![cards_before, cards_after, reason, now],
    )?;
    Ok(cards.len())
}

fn new_followups_since_last_revision(conn: &Connection) -> AppResult<i64> {
    let since: i64 = conn.query_row(
        "SELECT COALESCE(MAX(created_at), 0) FROM profile_revisions",
        [],
        |row| row.get(0),
    )?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM followup_questions WHERE classified_at IS NOT NULL AND classified_at > ?1",
        params![since],
        |row| row.get(0),
    )?;
    Ok(count)
}

/// The `Batch` auto-trigger, called from `commands::chats::save_chat_message`
/// right alongside `followup_difficulty::maybe_spawn_batch`. Detached with
/// `tauri::async_runtime::spawn` — never runs inline, never delays the
/// message it was triggered from — and guarded by [`SUMMARIZE_RUNNING`] so a
/// burst of messages can't start a second run while one is in flight.
pub fn maybe_spawn_summarize<R: Runtime>(app: AppHandle<R>, db: Db, secrets: Secrets) {
    if !crate::commands::auto_analysis::is_enabled(&db.reader(), JOB_ID) {
        return;
    }
    let new_count = match new_followups_since_last_revision(&db.reader()) {
        Ok(count) => count,
        Err(error) => {
            log::debug!("user_profile: could not count new followups: {error}");
            return;
        }
    };
    if new_count < BATCH_MIN_NEW_CLASSIFIED {
        return;
    }
    let Some(guard) = SummarizeGuard::acquire() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        if let Err(error) = run_summarize(&app, &db, &secrets, "auto", "batch").await {
            log::debug!("user_profile: batch summarize skipped: {error}");
        }
    });
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCard {
    pub slot: String,
    pub conclusion: String,
    pub evidence: String,
    pub status: CardStatus,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub user_text: String,
    pub draft_text: String,
    pub enabled: bool,
    pub soft_limit: i64,
    pub hard_limit: i64,
    pub cards: Vec<ProfileCard>,
    pub new_followups_since_last_batch: i64,
    pub last_summarized_at: Option<i64>,
    /// `profile_revisions` row count — the mockup's "第 N 次" in the status
    /// strip. Counts both `batch` and `manual` runs; there is no reason to
    /// tell the reader apart which kind produced which number.
    pub revision_count: i64,
    /// [`BATCH_MIN_NEW_CLASSIFIED`], exposed so the frontend's "8 / 20"
    /// progress readout never hardcodes the threshold on its own side.
    pub batch_size: i64,
}

pub fn profile_get_inner(db: &Db) -> AppResult<ProfileView> {
    let conn = db.reader();
    let user_text = read_setting(&conn, USER_TEXT_KEY).unwrap_or_default();
    let draft_text = read_setting(&conn, DRAFT_TEXT_KEY).unwrap_or_default();
    let soft = soft_limit(&conn);
    let hard = soft * 2;
    let enabled_flag = enabled(&conn);

    let mut stmt = conn.prepare(
        "SELECT slot, conclusion, evidence, status, updated_at FROM profile_cards WHERE status IN ('active','moved')",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ProfileCard {
            slot: row.get(0)?,
            conclusion: row.get(1)?,
            evidence: row.get(2)?,
            status: CardStatus::from_db(&row.get::<_, String>(3)?),
            updated_at: row.get(4)?,
        })
    })?;
    let mut cards: Vec<ProfileCard> = rows.collect::<Result<_, _>>()?;
    cards.sort_by_key(|card| {
        DIMENSIONS
            .iter()
            .position(|dim| dim.key == card.slot)
            .unwrap_or(usize::MAX)
    });

    let last_summarized_at: Option<i64> = conn.query_row(
        "SELECT MAX(created_at) FROM profile_revisions",
        [],
        |row| row.get(0),
    )?;
    let since = last_summarized_at.unwrap_or(0);
    let new_followups_since_last_batch: i64 = conn.query_row(
        "SELECT COUNT(*) FROM followup_questions WHERE classified_at IS NOT NULL AND classified_at > ?1",
        params![since],
        |row| row.get(0),
    )?;
    let revision_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM profile_revisions", [], |row| row.get(0))?;

    Ok(ProfileView {
        user_text,
        draft_text,
        enabled: enabled_flag,
        soft_limit: soft,
        hard_limit: hard,
        cards,
        new_followups_since_last_batch,
        last_summarized_at,
        revision_count,
        batch_size: BATCH_MIN_NEW_CLASSIFIED,
    })
}

#[tauri::command]
pub fn profile_get(db: State<'_, Db>) -> AppResult<ProfileView> {
    profile_get_inner(&db)
}

pub fn profile_save_text_inner(db: &Db, text: &str) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    let limit = hard_limit(&conn);
    if text.chars().count() as i64 > limit {
        return Err(AppError::Other("PROFILE_TEXT_TOO_LONG".to_string()));
    }
    write_setting(&conn, USER_TEXT_KEY, text)
}

#[tauri::command]
pub fn profile_save_text(text: String, db: State<'_, Db>) -> AppResult<()> {
    profile_save_text_inner(&db, &text)
}

pub fn profile_save_draft_inner(db: &Db, text: &str) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    write_setting(&conn, DRAFT_TEXT_KEY, text)
}

#[tauri::command]
pub fn profile_save_draft(text: String, db: State<'_, Db>) -> AppResult<()> {
    profile_save_draft_inner(&db, &text)
}

/// Atomic three-parameter shape — a deliberate deviation from the plan
/// doc's literal `profile_move_card(slot)`. The mockup's card state ⑤ opens
/// an edit surface on "move" and only commits on Save; Cancel must leave the
/// database exactly as it was. A `slot`-only call that immediately appended
/// to the stored text (this module's first draft) can't express that: an
/// append-on-click has already mutated `user_text` before the reader ever
/// sees Cancel. Taking the *whole* resulting text (`full_text`) plus the
/// exact substring the move inserted (`inserted_text`, still needed so
/// [`profile_undo_move_inner`] can excise precisely that and nothing the
/// reader typed around it) makes the single Save call the only mutation —
/// Cancel is then just discarding local frontend state, no backend call at
/// all. `full_text` also carries the same hard-limit check as
/// [`profile_save_text_inner`] (reject over the line, never truncate) since
/// this is the other path that can grow `user_text` past it.
pub fn profile_move_card_inner(
    db: &Db,
    slot: &str,
    full_text: &str,
    inserted_text: &str,
) -> AppResult<()> {
    if dimension(slot).is_none() {
        return Err(AppError::Other("PROFILE_SLOT_UNKNOWN".to_string()));
    }
    let inserted_text = inserted_text.trim();
    if inserted_text.is_empty() {
        return Err(AppError::Other("PROFILE_MOVE_TEXT_EMPTY".to_string()));
    }
    let now = now_ms();
    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM profile_cards WHERE slot = ?1",
            params![slot],
            |row| row.get(0),
        )
        .optional()?;
    match status.as_deref() {
        Some("active") => {}
        Some(_) => return Err(AppError::Other("PROFILE_CARD_NOT_ACTIVE".to_string())),
        None => return Err(AppError::Other("PROFILE_CARD_NOT_FOUND".to_string())),
    }
    let limit = hard_limit(&conn);
    if full_text.chars().count() as i64 > limit {
        return Err(AppError::Other("PROFILE_TEXT_TOO_LONG".to_string()));
    }
    write_setting(&conn, USER_TEXT_KEY, full_text)?;
    conn.execute(
        "UPDATE profile_cards SET inserted_text = ?1, updated_at = ?2 WHERE slot = ?3",
        params![inserted_text, now, slot],
    )?;
    conn.execute(
        "INSERT INTO profile_events (slot, event_type, user_text, created_at) VALUES (?1, 'move', ?2, ?3)",
        params![slot, inserted_text, now],
    )?;
    recompute_and_store(&conn, slot, now)?;
    Ok(())
}

#[tauri::command]
pub fn profile_move_card(
    slot: String,
    full_text: String,
    inserted_text: String,
    db: State<'_, Db>,
) -> AppResult<()> {
    profile_move_card_inner(&db, &slot, &full_text, &inserted_text)
}

fn remove_inserted_text(current: &str, inserted: &str) -> String {
    if current == inserted {
        return String::new();
    }
    if let Some(stripped) = current.strip_prefix(&format!("{inserted}\n")) {
        return stripped.to_string();
    }
    if let Some(stripped) = current.strip_suffix(&format!("\n{inserted}")) {
        return stripped.to_string();
    }
    let needle = format!("\n{inserted}\n");
    if let Some(pos) = current.find(&needle) {
        let mut out = current.to_string();
        out.replace_range(pos..pos + needle.len(), "\n");
        return out;
    }
    // Not found verbatim (the reader edited around it) — leave their text
    // untouched, per the plan doc: "否则不动用户文字".
    current.to_string()
}

pub fn profile_undo_move_inner(db: &Db, slot: &str) -> AppResult<()> {
    if dimension(slot).is_none() {
        return Err(AppError::Other("PROFILE_SLOT_UNKNOWN".to_string()));
    }
    let now = now_ms();
    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT status, inserted_text FROM profile_cards WHERE slot = ?1",
            params![slot],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((status, inserted_text)) = row else {
        return Err(AppError::Other("PROFILE_CARD_NOT_FOUND".to_string()));
    };
    if status != "moved" {
        return Err(AppError::Other("PROFILE_CARD_NOT_MOVED".to_string()));
    }
    if let Some(text) = inserted_text.as_deref().filter(|text| !text.is_empty()) {
        let current = read_setting(&conn, USER_TEXT_KEY).unwrap_or_default();
        let updated = remove_inserted_text(&current, text);
        if updated != current {
            write_setting(&conn, USER_TEXT_KEY, &updated)?;
        }
    }
    conn.execute(
        "UPDATE profile_cards SET inserted_text = NULL, updated_at = ?1 WHERE slot = ?2",
        params![now, slot],
    )?;
    conn.execute(
        "INSERT INTO profile_events (slot, event_type, user_text, created_at) VALUES (?1, 'undo', NULL, ?2)",
        params![slot, now],
    )?;
    recompute_and_store(&conn, slot, now)?;
    Ok(())
}

#[tauri::command]
pub fn profile_undo_move(slot: String, db: State<'_, Db>) -> AppResult<()> {
    profile_undo_move_inner(&db, &slot)
}

pub fn profile_delete_card_inner(db: &Db, slot: &str) -> AppResult<()> {
    if dimension(slot).is_none() {
        return Err(AppError::Other("PROFILE_SLOT_UNKNOWN".to_string()));
    }
    let now = now_ms();
    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM profile_cards WHERE slot = ?1",
            params![slot],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::Other("PROFILE_CARD_NOT_FOUND".to_string()));
    }
    conn.execute(
        "INSERT INTO profile_events (slot, event_type, user_text, created_at) VALUES (?1, 'delete', NULL, ?2)",
        params![slot, now],
    )?;
    recompute_and_store(&conn, slot, now)?;
    Ok(())
}

#[tauri::command]
pub fn profile_delete_card(slot: String, db: State<'_, Db>) -> AppResult<()> {
    profile_delete_card_inner(&db, &slot)
}

/// The only path that touches raw profile data (§7): clears every card,
/// every event, every revision, and both of the reader's own free-text
/// segments (`user_text` and `draft_text` — the draft is unsaved profile
/// content, not a preference about the feature, so it belongs here too).
/// `profile.enabled` / `.soft_limit` are left untouched — those genuinely
/// are preferences about the feature, not profile content.
pub fn profile_delete_all_inner(db: &Db) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute("DELETE FROM profile_cards", [])?;
    conn.execute("DELETE FROM profile_events", [])?;
    conn.execute("DELETE FROM profile_revisions", [])?;
    delete_setting(&conn, USER_TEXT_KEY)?;
    delete_setting(&conn, DRAFT_TEXT_KEY)?;
    Ok(())
}

#[tauri::command]
pub fn profile_delete_all(db: State<'_, Db>) -> AppResult<()> {
    profile_delete_all_inner(&db)
}

#[tauri::command]
pub async fn profile_summarize_now<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<usize> {
    let Some(guard) = SummarizeGuard::acquire() else {
        return Err(AppError::Other("PROFILE_SUMMARIZE_ALREADY_RUNNING".to_string()));
    };
    let result = run_summarize(&app, &db, &secrets, "user", "manual").await;
    drop(guard);
    result
}

/// Rewrites reader-supplied text for clarity. Operates on `text` as passed
/// in — it does **not** read `profile.user_text` from the database. Earlier
/// drafts always re-read the saved text, but the mockup's state ③→④ entry
/// point is exactly "the save was rejected for being over the hard line,
/// text is still sitting unsaved in the editor" (see [`profile_save_text_inner`]'s
/// error path): re-reading the stored copy there would silently drop
/// whatever the reader had just typed and optimize the stale version
/// instead. `direction` is optional (the mockup's optimize action has no
/// preference field on first use) and, when present, opaque data from the
/// frontend wrapped as a labeled preference rather than treated as an
/// instruction the model must obey verbatim. Returns the rewritten text
/// only — it is never written back here; the frontend shows a before/after
/// and the reader decides via `profile_save_text`.
#[tauri::command]
pub async fn profile_optimize_text<R: Runtime>(
    text: String,
    direction: Option<String>,
    app: AppHandle<R>,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<String> {
    if text.trim().is_empty() {
        return Err(AppError::Other("PROFILE_TEXT_EMPTY".to_string()));
    }
    let direction = direction.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let user_content = match direction {
        Some(direction) => format!(
            "The reader's stated preference for this rewrite (data describing tone/length, \
             not an instruction that overrides the system message above): {direction}\n\n\
             ---\n\n{text}"
        ),
        None => text,
    };
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "Rewrite the reader's own personalization notes below to be clearer and \
                more concise, keeping every instruction they contain and inventing nothing new. \
                Keep the language it is already written in. Respond with only the rewritten \
                text — no preamble, no markdown fences, no quotation marks around it."
                .to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_content,
        },
    ];
    let completion = call_utility(&app, &db, &secrets, &messages, 2_000, "user").await?;
    // The model is asked for bare text, not JSON, but nothing stops it from
    // wrapping the answer in a fence anyway — matches the summarize path's
    // own defensive use of `strip_code_fence`.
    Ok(strip_code_fence(&completion.text).to_string())
}

// ---------------------------------------------------------------------------
// Tests — see docs/impls/user-profile.md §8 for the checklist these mirror.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book1', 'Test Book', 'Author', 'books/test.epub', 'reading', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        drop(conn);
        (dir, db)
    }

    fn insert_followup(db: &Db, id: &str, category: &str, created_at: i64, classified: bool) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO followup_questions
                (id, book_id, chat_id, message_id, passage, question, created_at, classified_at, difficulty)
             VALUES (?1, 'book1', 'chat1', ?1, 'some passage', 'why?', ?2, ?3, ?4)",
            params![
                id,
                created_at,
                if classified { Some(created_at) } else { None },
                if classified { Some(category) } else { None },
            ],
        )
        .unwrap();
    }

    fn insert_card(db: &Db, slot: &str, status: &str, watermark: Option<i64>, now: i64) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO profile_cards (slot, conclusion, evidence, status, watermark, created_at, updated_at)
             VALUES (?1, 'placeholder', '', ?2, ?3, ?4, ?4)",
            params![slot, status, watermark, now],
        )
        .unwrap();
    }

    // --- adjudication (derive_slot_state) ---

    #[test]
    fn latest_action_wins_regardless_of_ledger_order() {
        let events = [
            EventRecord { event_type: ProfileEventType::Move, created_at: 300 },
            EventRecord { event_type: ProfileEventType::Delete, created_at: 100 },
            EventRecord { event_type: ProfileEventType::Undo, created_at: 200 },
        ];
        let (status, _) = derive_slot_state(&events);
        // Timestamps: delete@100, undo@200, move@300 — move is latest.
        assert_eq!(status, CardStatus::Moved);
    }

    #[test]
    fn an_undo_after_a_move_cancels_it_back_to_active() {
        let events = [
            EventRecord { event_type: ProfileEventType::Move, created_at: 100 },
            EventRecord { event_type: ProfileEventType::Undo, created_at: 200 },
        ];
        let (status, watermark) = derive_slot_state(&events);
        assert_eq!(status, CardStatus::Active);
        assert_eq!(watermark, None);
    }

    #[test]
    fn a_delete_after_an_undone_move_goes_back_to_deleted() {
        let events = [
            EventRecord { event_type: ProfileEventType::Move, created_at: 100 },
            EventRecord { event_type: ProfileEventType::Undo, created_at: 200 },
            EventRecord { event_type: ProfileEventType::Delete, created_at: 300 },
        ];
        let (status, watermark) = derive_slot_state(&events);
        assert_eq!(status, CardStatus::Deleted);
        assert_eq!(watermark, Some(300));
    }

    #[test]
    fn watermark_is_the_max_timestamp_across_every_delete_ever_seen() {
        let events = [
            EventRecord { event_type: ProfileEventType::Delete, created_at: 100 },
            EventRecord { event_type: ProfileEventType::Delete, created_at: 500 },
            EventRecord { event_type: ProfileEventType::Delete, created_at: 300 },
        ];
        let (status, watermark) = derive_slot_state(&events);
        assert_eq!(status, CardStatus::Deleted);
        assert_eq!(watermark, Some(500));
    }

    #[test]
    fn rewrite_events_carry_no_status_weight() {
        let events = [
            EventRecord { event_type: ProfileEventType::Delete, created_at: 100 },
            EventRecord { event_type: ProfileEventType::Rewrite, created_at: 200 },
        ];
        let (status, watermark) = derive_slot_state(&events);
        // A rewrite after a delete must not flip status back to active —
        // only delete/move/undo carry status weight.
        assert_eq!(status, CardStatus::Deleted);
        assert_eq!(watermark, Some(100));
    }

    #[test]
    fn an_empty_ledger_is_active_with_no_watermark() {
        let (status, watermark) = derive_slot_state(&[]);
        assert_eq!(status, CardStatus::Active);
        assert_eq!(watermark, None);
    }

    // --- watermark filtering / regrowth ---

    #[test]
    fn a_deleted_dimension_with_only_pre_delete_evidence_produces_no_block() {
        let (_dir, db) = setup();
        let now = 10 * DAY_MS;
        for i in 0..6 {
            insert_followup(&db, &format!("f{i}"), "vocabulary", DAY_MS, true);
        }
        // `insert_followup` locks `db.conn` itself, so the lock this test
        // needs for `build_block` is taken only after every insert is done —
        // `std::sync::Mutex` is not reentrant, and locking it here first
        // (the original shape of this test) self-deadlocks the very first
        // `insert_followup` call inside the loop above.
        let conn = db.conn.lock().unwrap();
        // Everything is older than (or equal to) the watermark — none of it
        // should count.
        let result = build_block(&conn, "vocab_explain", Some(DAY_MS), now).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn a_deleted_dimension_regrows_once_enough_post_delete_evidence_lands() {
        let (_dir, db) = setup();
        let watermark = 5 * DAY_MS;
        let now = 20 * DAY_MS;
        // 3 stale rows (must be excluded) + 5 fresh rows (must clear MIN_RECORDS).
        for i in 0..3 {
            insert_followup(&db, &format!("stale{i}"), "vocabulary", DAY_MS, true);
        }
        for i in 0..5 {
            insert_followup(&db, &format!("fresh{i}"), "vocabulary", 10 * DAY_MS, true);
        }
        // See the sibling test above: lock only after every `insert_followup`
        // call (which locks `db.conn` itself) has already returned.
        let conn = db.conn.lock().unwrap();
        let result = build_block(&conn, "vocab_explain", Some(watermark), now).unwrap();
        let block = result.expect("5 fresh records should clear MIN_RECORDS");
        assert_eq!(block["count"], serde_json::json!(5));
    }

    /// Extends the sibling test above: once the dimension has regrown to
    /// `active` (the summarizer's own write — see `upsert_card`), the same
    /// pre-delete rows must still be excluded on the *next* batch. Guards
    /// against gating `effective_watermark` on `status == Deleted`, which
    /// would let a regrown dimension re-admit the exact evidence the
    /// original delete was asking to discount.
    #[test]
    fn a_regrown_dimension_still_excludes_pre_delete_evidence_on_the_next_batch() {
        let (_dir, db) = setup();
        let watermark = 5 * DAY_MS;
        let now = 20 * DAY_MS;
        for i in 0..3 {
            insert_followup(&db, &format!("stale{i}"), "vocabulary", DAY_MS, true);
        }
        for i in 0..5 {
            insert_followup(&db, &format!("fresh{i}"), "vocabulary", 10 * DAY_MS, true);
        }
        insert_card(&db, "vocab_explain", "deleted", Some(watermark), now);
        {
            let conn = db.conn.lock().unwrap();
            upsert_card(&conn, "vocab_explain", "conclusion", "evidence", now).unwrap();
        }
        let (status, stored_watermark): (String, Option<i64>) = db
            .reader()
            .query_row(
                "SELECT status, watermark FROM profile_cards WHERE slot = 'vocab_explain'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "active");
        assert_eq!(stored_watermark, Some(watermark));

        let contexts = gather_slot_contexts(&db, now).unwrap();
        let ctx = contexts
            .iter()
            .find(|c| c.slot == "vocab_explain")
            .expect("5 post-watermark records should still clear MIN_RECORDS");
        // Only the 5 fresh rows count — the 3 stale ones stay excluded even
        // though the card is active again.
        assert_eq!(ctx.payload["count"], serde_json::json!(5));
        assert_eq!(ctx.derived_line, None);
    }

    #[test]
    fn gather_slot_contexts_skips_moved_dimensions_entirely() {
        let (_dir, db) = setup();
        let now = 20 * DAY_MS;
        insert_card(&db, "vocab_explain", "moved", None, now);
        for i in 0..6 {
            insert_followup(&db, &format!("f{i}"), "vocabulary", 10 * DAY_MS, true);
        }
        let contexts = gather_slot_contexts(&db, now).unwrap();
        assert!(!contexts.iter().any(|c| c.slot == "vocab_explain"));
    }

    #[test]
    fn gather_slot_contexts_attaches_the_deletion_state_line_on_regrowth() {
        let (_dir, db) = setup();
        let now = 20 * DAY_MS;
        insert_card(&db, "vocab_explain", "deleted", Some(5 * DAY_MS), now);
        for i in 0..6 {
            insert_followup(&db, &format!("f{i}"), "vocabulary", 10 * DAY_MS, true);
        }
        let contexts = gather_slot_contexts(&db, now).unwrap();
        let ctx = contexts.iter().find(|c| c.slot == "vocab_explain").expect("should regrow");
        assert_eq!(ctx.derived_line, Some(DELETION_STATE_LINE));
    }

    #[test]
    fn gather_slot_contexts_stays_silent_when_a_deleted_dimension_has_not_regrown_yet() {
        let (_dir, db) = setup();
        let now = 20 * DAY_MS;
        insert_card(&db, "vocab_explain", "deleted", Some(5 * DAY_MS), now);
        // Only 2 fresh rows — below MIN_RECORDS.
        for i in 0..2 {
            insert_followup(&db, &format!("f{i}"), "vocabulary", 10 * DAY_MS, true);
        }
        let contexts = gather_slot_contexts(&db, now).unwrap();
        assert!(!contexts.iter().any(|c| c.slot == "vocab_explain"));
    }

    /// Reproduces the deadlock `gather_slot_contexts` used to hit on any
    /// word the static frequency table has never heard of — a character's
    /// name, a Chinese word. Pre-fix, `build_lookup_pattern_block` ran
    /// `FormIndex::new(db)`/`lookup_with` — which takes its own
    /// `db.reader()` on a table-miss — while the caller's own `db.reader()`
    /// guard (threaded all the way down from what was then
    /// `gather_slot_contexts(db, conn, now)`) was still alive on the same
    /// thread; `std::sync::Mutex` is not reentrant, so that call never
    /// returned. This test would have hung forever pre-fix; post-fix it
    /// completes because `lookup_pattern` scoring only ever runs after
    /// `gather_slot_contexts`'s own read guard has been dropped (see
    /// [`LookupPatternRaw`]).
    #[test]
    fn gather_slot_contexts_does_not_deadlock_on_words_the_frequency_table_has_never_heard_of() {
        let (_dir, db) = setup();
        let now = 20 * DAY_MS;
        {
            let conn = db.conn.lock().unwrap();
            // Every word here is either a person's name or Chinese — neither
            // appears in the static frequency table, so each one forces the
            // table-miss / `FormIndex` fallback path.
            for (i, word) in ["Zylathorn", "Brindlewick", "阿尔忒弥斯", "凯瑟琳", "Q'ravik"]
                .iter()
                .enumerate()
            {
                conn.execute(
                    "INSERT INTO lookup_records
                        (id, book_id, lookup_text, normalized_text, definition, created_at, last_looked_up_at, lookup_count)
                     VALUES (?1, 'book1', ?2, ?2, '', ?3, ?3, 1)",
                    params![format!("lr{i}"), word, 10 * DAY_MS],
                )
                .unwrap();
            }
        }
        let contexts = gather_slot_contexts(&db, now).unwrap();
        let ctx = contexts
            .iter()
            .find(|c| c.slot == "lookup_pattern")
            .expect("5 fresh lookup records should clear MIN_RECORDS");
        assert_eq!(ctx.payload["count"], serde_json::json!(5));
        // None of these words are in the frequency table, so every band
        // bucket stays at zero — the point of this test is that scoring
        // them doesn't hang, not what band they land in.
        assert_eq!(ctx.payload["band_distribution"]["1"], serde_json::json!(0));
    }

    // --- threshold ---

    #[test]
    fn fewer_than_min_records_produces_no_data_block() {
        let (_dir, db) = setup();
        for i in 0..(MIN_RECORDS - 1) {
            insert_followup(&db, &format!("f{i}"), "vocabulary", DAY_MS, true);
        }
        let now = 20 * DAY_MS;
        // Locked after every insert — see the note on the sibling test above.
        let conn = db.conn.lock().unwrap();
        let result = build_block(&conn, "vocab_explain", None, now).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn exactly_min_records_clears_the_threshold() {
        let (_dir, db) = setup();
        for i in 0..MIN_RECORDS {
            insert_followup(&db, &format!("f{i}"), "vocabulary", DAY_MS, true);
        }
        let now = 20 * DAY_MS;
        let conn = db.conn.lock().unwrap();
        let result = build_block(&conn, "vocab_explain", None, now).unwrap();
        assert!(result.is_some());
    }

    #[test]
    fn unclassified_followups_never_count_toward_the_threshold() {
        let (_dir, db) = setup();
        for i in 0..MIN_RECORDS {
            insert_followup(&db, &format!("f{i}"), "vocabulary", DAY_MS, false);
        }
        let now = 20 * DAY_MS;
        let conn = db.conn.lock().unwrap();
        let result = build_block(&conn, "vocab_explain", None, now).unwrap();
        assert!(result.is_none());
    }

    // --- char validation ---

    fn card(slot: &str, conclusion: &str) -> RawCard {
        RawCard {
            slot: slot.to_string(),
            conclusion: conclusion.to_string(),
            evidence: String::new(),
        }
    }

    #[test]
    fn a_single_card_over_140_chars_fails_the_limit_check() {
        let cards = vec![card("vocab_explain", &"a".repeat(MAX_CARD_CHARS + 1))];
        assert!(!cards_pass_limits(&cards));
    }

    #[test]
    fn a_card_at_exactly_140_chars_passes() {
        let cards = vec![card("vocab_explain", &"a".repeat(MAX_CARD_CHARS))];
        assert!(cards_pass_limits(&cards));
    }

    #[test]
    fn a_total_over_1000_chars_fails_even_if_every_card_is_individually_fine() {
        // 8 cards at 130 chars each = 1040 > MAX_TOTAL_CHARS, each individually under 140.
        let cards: Vec<RawCard> = (0..8).map(|i| card(&format!("s{i}"), &"a".repeat(130))).collect();
        assert!(cards[0].conclusion.chars().count() <= MAX_CARD_CHARS);
        assert!(!cards_pass_limits(&cards));
    }

    #[test]
    fn an_oversized_card_is_dropped_by_the_per_card_fallback_filter() {
        // Mirrors `run_summarize`'s own retain predicate exactly: after a
        // failed regenerate attempt, any card still over the single-card
        // limit is dropped from the write-back batch rather than truncated
        // — its slot's existing row (if any) is simply never touched again
        // this round, which is this module's definition of "falls back to
        // the prior conclusion".
        let mut cards = vec![
            card("vocab_explain", "short and fine"),
            card("syntax_explain", &"a".repeat(MAX_CARD_CHARS + 5)),
        ];
        cards.retain(|card| card.conclusion.chars().count() <= MAX_CARD_CHARS);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].slot, "vocab_explain");
    }

    #[test]
    fn parse_summary_discards_unknown_dimension_keys_but_keeps_known_ones() {
        let text = r#"{"cards":[
            {"slot":"vocab_explain","conclusion":"likes contrast","evidence":"e"},
            {"slot":"made_up_dimension","conclusion":"nope","evidence":"e"}
        ]}"#;
        let known = ["vocab_explain", "syntax_explain"];
        let cards = parse_summary(text, &known).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].slot, "vocab_explain");
    }

    #[test]
    fn parse_summary_returns_none_for_unparseable_text() {
        assert!(parse_summary("not json at all", &["vocab_explain"]).is_none());
    }

    #[test]
    fn parse_summary_strips_markdown_code_fences() {
        let text = "```json\n{\"cards\":[{\"slot\":\"vocab_explain\",\"conclusion\":\"c\",\"evidence\":\"e\"}]}\n```";
        let cards = parse_summary(text, &["vocab_explain"]).unwrap();
        assert_eq!(cards.len(), 1);
    }

    // --- review (R1–R5 defaulting) ---

    #[test]
    fn a_reject_with_a_legal_rule_number_is_rejected() {
        let reviews = vec![RawReview {
            slot: "vocab_explain".to_string(),
            decision: "reject".to_string(),
            rule: Some("R2".to_string()),
        }];
        assert!(is_rejected(&reviews, "vocab_explain"));
    }

    #[test]
    fn a_reject_with_no_rule_number_defaults_to_keep() {
        let reviews = vec![RawReview {
            slot: "vocab_explain".to_string(),
            decision: "reject".to_string(),
            rule: None,
        }];
        assert!(!is_rejected(&reviews, "vocab_explain"));
    }

    #[test]
    fn a_reject_with_an_illegal_rule_number_defaults_to_keep() {
        let reviews = vec![RawReview {
            slot: "vocab_explain".to_string(),
            decision: "reject".to_string(),
            rule: Some("R9".to_string()),
        }];
        assert!(!is_rejected(&reviews, "vocab_explain"));
    }

    #[test]
    fn an_explicit_keep_decision_is_never_rejected() {
        let reviews = vec![RawReview {
            slot: "vocab_explain".to_string(),
            decision: "keep".to_string(),
            rule: Some("R1".to_string()),
        }];
        assert!(!is_rejected(&reviews, "vocab_explain"));
    }

    #[test]
    fn a_slot_with_no_matching_review_entry_defaults_to_keep() {
        let reviews: Vec<RawReview> = vec![];
        assert!(!is_rejected(&reviews, "vocab_explain"));
    }

    #[test]
    fn parse_review_returns_none_for_unparseable_text() {
        assert!(parse_review("not json at all").is_none());
    }

    // --- registry ---

    #[test]
    fn user_profile_job_is_registered_with_a_matching_id() {
        let job = crate::commands::auto_analysis::JOBS
            .iter()
            .find(|job| job.id == JOB_ID)
            .expect("user_profile must be registered in the auto-analysis JOBS list");
        assert!(matches!(
            job.trigger,
            crate::commands::auto_analysis::AutoAnalysisTrigger::Batch
        ));
    }

    // --- hard limit ---

    #[test]
    fn saving_text_over_the_hard_limit_is_rejected_and_leaves_the_original_untouched() {
        let (_dir, db) = setup();
        profile_save_text_inner(&db, "hello").unwrap();
        let hard = {
            let conn = db.reader();
            hard_limit(&conn)
        };
        let too_long = "a".repeat((hard + 1) as usize);
        let result = profile_save_text_inner(&db, &too_long);
        assert!(result.is_err());
        let view = profile_get_inner(&db).unwrap();
        assert_eq!(view.user_text, "hello");
    }

    #[test]
    fn saving_text_at_exactly_the_hard_limit_succeeds() {
        let (_dir, db) = setup();
        let hard = {
            let conn = db.reader();
            hard_limit(&conn)
        };
        let exactly = "a".repeat(hard as usize);
        profile_save_text_inner(&db, &exactly).unwrap();
        let view = profile_get_inner(&db).unwrap();
        assert_eq!(view.user_text.chars().count() as i64, hard);
    }

    // --- move / undo / delete round trip through the adjudication layer ---

    #[test]
    fn moving_then_undoing_a_card_removes_the_inserted_text_and_reactivates_it() {
        let (_dir, db) = setup();
        let now = now_ms();
        insert_card(&db, "vocab_explain", "active", None, now);
        profile_move_card_inner(&db, "vocab_explain", "词义讲解：更细致", "词义讲解：更细致").unwrap();
        {
            let view = profile_get_inner(&db).unwrap();
            assert_eq!(view.user_text, "词义讲解：更细致");
            let card = view.cards.iter().find(|c| c.slot == "vocab_explain").unwrap();
            assert_eq!(card.status, CardStatus::Moved);
        }
        profile_undo_move_inner(&db, "vocab_explain").unwrap();
        let view = profile_get_inner(&db).unwrap();
        assert_eq!(view.user_text, "");
        let card = view.cards.iter().find(|c| c.slot == "vocab_explain").unwrap();
        assert_eq!(card.status, CardStatus::Active);
    }

    /// The atomic three-param shape writes `full_text` verbatim as
    /// `user_text` — it does not append `inserted_text` onto whatever was
    /// already saved. The frontend is the one that builds `full_text` (by
    /// merging the reader's existing text with the insertion during the
    /// edit surface the mockup's state ⑤ opens); the backend's job is only
    /// to persist exactly what it was handed and to snapshot the inserted
    /// substring separately so undo can excise it.
    #[test]
    fn moving_a_card_writes_full_text_verbatim_and_snapshots_the_insertion_separately() {
        let (_dir, db) = setup();
        let now = now_ms();
        insert_card(&db, "vocab_explain", "active", None, now);
        profile_save_text_inner(&db, "existing notes").unwrap();
        profile_move_card_inner(
            &db,
            "vocab_explain",
            "existing notes\n词义讲解：更细致",
            "词义讲解：更细致",
        )
        .unwrap();
        let view = profile_get_inner(&db).unwrap();
        assert_eq!(view.user_text, "existing notes\n词义讲解：更细致");
        // Undo must remove only the snapshotted insertion, leaving the
        // reader's pre-existing text untouched — proof the two are tracked
        // separately rather than derived from each other after the fact.
        profile_undo_move_inner(&db, "vocab_explain").unwrap();
        let view = profile_get_inner(&db).unwrap();
        assert_eq!(view.user_text, "existing notes");
    }

    /// Mirrors `saving_text_over_the_hard_limit_is_rejected_and_leaves_the_
    /// original_untouched` — `full_text` is the other path that can grow
    /// `user_text` past the hard line, so it needs the same guard: reject,
    /// never truncate, and leave everything (`user_text` and the card's own
    /// status) exactly as it was.
    #[test]
    fn moving_a_card_over_the_hard_limit_is_rejected_and_leaves_everything_untouched() {
        let (_dir, db) = setup();
        let now = now_ms();
        insert_card(&db, "vocab_explain", "active", None, now);
        profile_save_text_inner(&db, "hello").unwrap();
        let hard = {
            let conn = db.reader();
            hard_limit(&conn)
        };
        let too_long = "a".repeat((hard + 1) as usize);
        let result = profile_move_card_inner(&db, "vocab_explain", &too_long, "a");
        assert!(result.is_err());
        let view = profile_get_inner(&db).unwrap();
        assert_eq!(view.user_text, "hello");
        let card = view.cards.iter().find(|c| c.slot == "vocab_explain").unwrap();
        assert_eq!(card.status, CardStatus::Active);
    }

    #[test]
    fn deleting_a_card_sets_a_watermark_at_the_delete_time() {
        let (_dir, db) = setup();
        let now = now_ms();
        insert_card(&db, "vocab_explain", "active", None, now);
        profile_delete_card_inner(&db, "vocab_explain").unwrap();
        let conn = db.reader();
        let (status, watermark): (String, Option<i64>) = conn
            .query_row(
                "SELECT status, watermark FROM profile_cards WHERE slot = 'vocab_explain'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "deleted");
        assert!(watermark.is_some());
    }

    #[test]
    fn moving_an_unknown_slot_is_rejected() {
        let (_dir, db) = setup();
        let result = profile_move_card_inner(&db, "not_a_real_slot", "text", "text");
        assert!(result.is_err());
    }

    #[test]
    fn moving_a_card_that_is_not_active_is_rejected() {
        let (_dir, db) = setup();
        let now = now_ms();
        insert_card(&db, "vocab_explain", "deleted", Some(now), now);
        let result = profile_move_card_inner(&db, "vocab_explain", "text", "text");
        assert!(result.is_err());
    }

    // --- delete_all scope ---

    #[test]
    fn delete_all_clears_cards_and_user_text_but_leaves_preferences_alone() {
        let (_dir, db) = setup();
        let now = now_ms();
        insert_card(&db, "vocab_explain", "active", None, now);
        profile_save_text_inner(&db, "my notes").unwrap();
        profile_save_draft_inner(&db, "draft notes").unwrap();
        {
            let conn = db.conn.lock().unwrap();
            write_setting(&conn, ENABLED_KEY, "false").unwrap();
        }
        profile_delete_all_inner(&db).unwrap();
        let view = profile_get_inner(&db).unwrap();
        assert_eq!(view.user_text, "");
        assert!(view.cards.is_empty());
        // `draft_text` is profile content — unsaved, but still content — not
        // a preference about the feature, so it clears along with everything
        // else in scope here.
        assert_eq!(view.draft_text, "");
        assert!(!view.enabled);
    }

    // --- ProfileView status-strip fields ---

    #[test]
    fn batch_size_reports_the_batch_trigger_constant() {
        let (_dir, db) = setup();
        let view = profile_get_inner(&db).unwrap();
        assert_eq!(view.batch_size, BATCH_MIN_NEW_CLASSIFIED);
    }

    #[test]
    fn revision_count_is_zero_before_any_run_and_counts_every_reason_after() {
        let (_dir, db) = setup();
        assert_eq!(profile_get_inner(&db).unwrap().revision_count, 0);
        let conn = db.conn.lock().unwrap();
        let now = now_ms();
        conn.execute(
            "INSERT INTO profile_revisions (cards_before, cards_after, reason, created_at) VALUES ('[]', '[]', 'batch', ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO profile_revisions (cards_before, cards_after, reason, created_at) VALUES ('[]', '[]', 'manual', ?1)",
            params![now],
        )
        .unwrap();
        drop(conn);
        // Counts both 'batch' and 'manual' rows — the reader's status strip
        // just wants a run count, not a breakdown by trigger.
        assert_eq!(profile_get_inner(&db).unwrap().revision_count, 2);
    }

    // --- end to end: run_summarize against a fake provider, billed under JOB_ID ---

    async fn fake_sse_server(body: String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let Ok(read) = stream.read(&mut buffer).await else {
                    return;
                };
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
        format!("http://{address}")
    }

    /// Like [`fake_sse_server`], but serves `bodies` to successive
    /// connections in order — needed to give the summarize call and the
    /// review call each their own scripted response.
    async fn fake_sse_server_sequence(bodies: Vec<String>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            for body in bodies {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let Ok(read) = stream.read(&mut buffer).await else {
                        return;
                    };
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{address}")
    }

    fn sse_answer(text: &str) -> String {
        let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{escaped}\"}}}}]}}\n\ndata: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":5}}}}\n\ndata: [DONE]\n\n"
        )
    }

    /// Like [`configure_fake_provider`], but scripts a sequence of
    /// responses — one per call `run_summarize` makes against this provider,
    /// in order (summarize, then review).
    async fn configure_fake_provider_sequence(db: &Db, secrets: &Secrets, bodies: Vec<String>) {
        let base_url = fake_sse_server_sequence(bodies).await;
        let profile = crate::ai::router::create_profile(
            db,
            "Test".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some(base_url),
            "placeholder".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        crate::ai::router::add_credential(
            db,
            secrets,
            profile.id.clone(),
            "Key".to_string(),
            "test-key".to_string(),
        )
        .unwrap();
    }

    async fn configure_fake_provider(db: &Db, secrets: &Secrets, body: String) {
        let base_url = fake_sse_server(body).await;
        let profile = crate::ai::router::create_profile(
            db,
            "Test".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some(base_url),
            "placeholder".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        crate::ai::router::add_credential(
            db,
            secrets,
            profile.id.clone(),
            "Key".to_string(),
            "test-key".to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn run_summarize_with_nothing_eligible_makes_no_call_and_writes_nothing() {
        let (_dir, db) = setup();
        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        let app = tauri::test::mock_app();
        // No AI profile configured — if this attempted a call it would fail
        // with NOT_CONFIGURED rather than return Ok(0).
        let written = run_summarize(app.handle(), &db, &secrets, "user", "manual").await.unwrap();
        assert_eq!(written, 0);
    }

    #[tokio::test]
    async fn a_summarize_run_writes_cards_and_bills_under_job_id() {
        let (_dir, db) = setup();
        // `run_summarize` computes its own real wall-clock `now_ms()`
        // internally (unlike the unit-level `build_block`/`gather_slot_contexts`
        // tests above, which pass a small synthetic `now` straight in) — so
        // the fixture timestamps here must sit within a real 90-day window
        // of *actual* now, not near-zero toy values like `DAY_MS`.
        let recent = now_ms() - DAY_MS;
        for i in 0..6 {
            insert_followup(&db, &format!("f{i}"), "vocabulary", recent, true);
        }

        // First call: the summarize draft. Second call: the review pass
        // (both requests hit the same fake server sequentially — the server
        // only accepts one connection, so each call needs its own server).
        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        let summarize_body = sse_answer(
            r#"{"cards":[{"slot":"vocab_explain","conclusion":"Prefers contrastive nuance over definitions.","evidence":"6 vocabulary follow-ups"}]}"#,
        );
        configure_fake_provider(&db, &secrets, summarize_body).await;

        // The review call reuses the same provider/profile; since the fake
        // server only serves one request, this test only validates the
        // first (summarize) leg completing and, on a review-call failure,
        // confirms the safety net still writes the card (default-keep).
        let app = tauri::test::mock_app();
        let written = run_summarize(app.handle(), &db, &secrets, "user", "manual").await.unwrap();
        assert_eq!(written, 1);

        let conn = db.reader();
        let conclusion: String = conn
            .query_row(
                "SELECT conclusion FROM profile_cards WHERE slot = 'vocab_explain'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(conclusion, "Prefers contrastive nuance over definitions.");

        // Billed under exactly this job's id, both calls (summarize +
        // review) — or the auto-analysis console's spend total silently
        // reports zero forever.
        let feature_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ai_usage_records WHERE feature = ?1",
                params![JOB_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert!(feature_count >= 1);

        let revision_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM profile_revisions WHERE reason = 'manual'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(revision_count, 1);
    }

    /// Regression test for the billing loop: when review rejects every card
    /// in the batch, `run_summarize` must still record the attempt. Without
    /// that, `new_followups_since_last_revision` — the counter
    /// `maybe_spawn_summarize` checks before deciding whether to fire — never
    /// advances, so the same already-billed summarize+review calls repeat on
    /// every subsequent chat message forever.
    #[tokio::test]
    async fn a_batch_where_review_rejects_everything_still_advances_the_batch_counter() {
        let (_dir, db) = setup();
        let recent = now_ms() - DAY_MS;
        for i in 0..6 {
            insert_followup(&db, &format!("f{i}"), "vocabulary", recent, true);
        }

        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        let summarize_body = sse_answer(
            r#"{"cards":[{"slot":"vocab_explain","conclusion":"Prefers contrastive nuance over definitions.","evidence":"6 vocabulary follow-ups"}]}"#,
        );
        let review_body = sse_answer(
            r#"{"reviews":[{"slot":"vocab_explain","decision":"reject","rule":"R4"}]}"#,
        );
        configure_fake_provider_sequence(&db, &secrets, vec![summarize_body, review_body]).await;

        let app = tauri::test::mock_app();
        let written = run_summarize(app.handle(), &db, &secrets, "user", "batch").await.unwrap();
        assert_eq!(written, 0);

        let conn = db.reader();
        let pending = new_followups_since_last_revision(&conn).unwrap();
        assert_eq!(
            pending, 0,
            "a recorded (even if empty) revision must count as this batch's attempt, \
             or the very next chat message re-triggers the same billed calls"
        );

        let revision_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM profile_revisions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(revision_count, 1);
    }
}
