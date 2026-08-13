//! AI curation layer on top of the rule-computed review piles in
//! `commands::review_piles` — see docs/impls/reading-flow-decisions-2026-08-06.md
//! §6 and docs/impls/reading-driven-mastery-and-review.md §10 (registered as
//! "复习堆的整理" there, run at most once a day, sending only words and their
//! provenance, never book text).
//!
//! Three rules, non-negotiable:
//!
//! 1. **Additive only, and read-only toward the rule engine.** This module
//!    calls `review_piles::list_review_piles_at` — the exact function the
//!    review page calls — and never edits, filters, reorders, or replaces
//!    what it returns. It produces a second, optional structure the caller
//!    may lay on top. `review_piles.rs` itself is not modified by this
//!    feature at all: see `tests::switching_the_job_off_leaves_review_piles_untouched`.
//! 2. **Off by default, off means invisible.** `JOB_ID` ships
//!    `default_enabled: false` in `commands::auto_analysis::JOBS`. While the
//!    switch is off, [`load_and_validate_curation`] returns `None`
//!    unconditionally — even if a curation was generated and cached during
//!    an earlier on period. Off does not just stop new spend, it stops the
//!    output from being read back too.
//! 3. **Never trust a reference back.** The model is handed pile keys and
//!    word ids and asked to group/reorder/split using only those. Every
//!    reference it returns is checked against the *freshly recomputed* rule
//!    piles before anything is accepted in [`parse_curation_response`] — a
//!    key or id that does not exist right now is silently dropped, never
//!    surfaced. A single hallucinated claim would undermine the one property
//!    review piles have always had: every card traces to something the
//!    reader actually did (see decisions doc §6, reason 1).
//!
//! ## What curation produces
//!
//! A short ordered list of *groups*. Each group is a label (why these piles
//! now sit together, or why this position) plus references back into the
//! rule piles that were live when it was generated: whole piles for a merge,
//! or a `word_ids` subset of one pile for a split. Nothing here duplicates a
//! pile's words or facts — every group is a pointer, not a copy — which is
//! also what makes stale-reference dropping safe: the source of truth never
//! moves out of `review_piles.rs`.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::ai::ChatMessage;
use crate::commands::auto_analysis;
use crate::commands::review_piles::{self, ReviewPile, ReviewPileKind};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

/// The auto-analysis job id — and, by the registry's own rule, the exact
/// `ai_usage_records.feature` tag every call in this module must carry.
/// Referenced from `commands::auto_analysis::JOBS` rather than duplicated
/// there as a string literal, so the two can never drift apart.
pub const JOB_ID: &str = "review_pile_curation";

/// How long a cached curation stays fresh before the next enabled read
/// triggers a regeneration. There is no background scheduler anywhere in
/// the app (see the module doc on `AutoAnalysisTrigger::Daily`), so this is
/// the entire realization of "once a day": a lazy check made whenever a
/// reader who has the switch on actually opens review.
const CURATION_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// Piles are small in practice (at most one per book, plus three singletons)
/// but a reader with many books could have dozens. Capping what the prompt
/// sends per pile keeps the request bounded without changing what the pile
/// itself contains — see `review_piles.rs`, entirely untouched here.
const MAX_WORDS_PER_PILE_IN_PROMPT: usize = 60;
/// A curation with more groups than this is not "more organised", it is the
/// original list with extra steps. Also bounds how much of a hallucinated or
/// runaway response gets accepted.
const MAX_GROUPS: usize = 24;
/// A group label is a one-line reason, not a paragraph.
const MAX_LABEL_CHARS: usize = 160;

/// One pile or a subset of one pile's words, inside a [`CuratedGroup`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CuratedPileRef {
    /// Correlates back to a live `ReviewPile` — see [`pile_key`]. Never
    /// trusted at face value: every read revalidates this against piles
    /// recomputed at that moment.
    pub pile_key: String,
    /// `None` means "the whole pile". `Some` means this group only claims
    /// these words out of the pile — the mechanism a split uses to put part
    /// of an oversized pile in one group and the rest in another.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_ids: Option<Vec<String>>,
}

/// One row of the curated, additive overlay.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CuratedGroup {
    /// Why these piles now sit together, or why this position — a sentence
    /// fragment, not a paragraph. Constrained to facts the model was given
    /// (pile provenance and word text); see `curation_prompt`.
    pub label: String,
    pub piles: Vec<CuratedPileRef>,
}

/// The AI layer's whole output: an ordered overlay plus who generated it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPileCuration {
    pub generated_at: i64,
    pub groups: Vec<CuratedGroup>,
    pub provider: String,
    pub model: String,
}

/// A stable string identity for a rule pile, derived entirely from its
/// `ReviewPileKind` — piles themselves have no persistent id, only a
/// discriminant plus embedded fields (see `review_piles::ReviewPileKind`).
/// Stable across regenerations for the cases the AI layer needs to
/// correlate: per-book piles by `book_id`, the per-chapter pile by
/// `(book_id, chapter)`, and the two singleton piles by a fixed string.
fn pile_key(kind: &ReviewPileKind) -> String {
    match kind {
        ReviewPileKind::RepeatLookupsInBook { book_id, .. } => {
            format!("repeat_lookups_in_book:{book_id}")
        }
        ReviewPileKind::PromotedThenLookedUp => "promoted_then_looked_up".to_string(),
        ReviewPileKind::RecentChapterLookups {
            book_id, chapter, ..
        } => format!("recent_chapter_lookups:{book_id}:{chapter}"),
        ReviewPileKind::LongUnseen => "long_unseen".to_string(),
    }
}

/// A short, deterministic (never AI-authored) description of why a pile
/// exists, sent as context alongside its words — the model gets the same
/// "one sentence that explains it" the doc requires of every pile, so it can
/// reason about merges without being asked to invent a reason itself.
fn kind_reason(kind: &ReviewPileKind) -> &'static str {
    match kind {
        ReviewPileKind::RepeatLookupsInBook { .. } => "looked up more than once in the same book",
        ReviewPileKind::PromotedThenLookedUp => {
            "the app thought these were known, then the reader looked them up"
        }
        ReviewPileKind::RecentChapterLookups { .. } => {
            "looked up in the chapter most recently read"
        }
        ReviewPileKind::LongUnseen => "due for review, with no specific recent story",
    }
}

#[derive(Debug, Serialize)]
struct PileWordForPrompt<'a> {
    id: &'a str,
    text: &'a str,
}

#[derive(Debug, Serialize)]
struct PileForPrompt<'a> {
    pile_key: String,
    reason: &'static str,
    word_count: usize,
    words: Vec<PileWordForPrompt<'a>>,
}

fn build_prompt_payload(piles: &[ReviewPile]) -> Vec<PileForPrompt<'_>> {
    piles
        .iter()
        .map(|pile| PileForPrompt {
            pile_key: pile_key(&pile.kind),
            reason: kind_reason(&pile.kind),
            word_count: pile.words.len(),
            words: pile
                .words
                .iter()
                .take(MAX_WORDS_PER_PILE_IN_PROMPT)
                .map(|word| PileWordForPrompt {
                    id: &word.id,
                    text: &word.word,
                })
                .collect(),
        })
        .collect()
}

fn curation_prompt(piles: &[ReviewPile]) -> AppResult<Vec<ChatMessage>> {
    let payload = build_prompt_payload(piles);
    let json =
        serde_json::to_string(&payload).map_err(|error| AppError::Other(error.to_string()))?;
    Ok(vec![
        ChatMessage {
            role: "system".to_string(),
            content: "You reorganise a language learner's review piles. You are given a JSON \
                array of piles, each with a pileKey, a reason it exists, and its words (id + \
                text only — never the reader's book text). Merge piles that are semantically \
                similar, put them in a more sensible order, and split any pile whose word list \
                looks too large for one screen into smaller groups. You may only reference a \
                pileKey and word ids exactly as given — never invent one. Return strict JSON \
                only, no prose, no markdown fences, matching this shape: {\"groups\":[{\"label\":\
                \"short reason\",\"piles\":[{\"pileKey\":\"...\"},{\"pileKey\":\"...\",\"wordIds\
                \":[\"...\"]}]}]}. Omit wordIds to keep a whole pile in a group; include it only \
                to move a subset of one pile's words into that group. Every word must end up in \
                at least one group. Keep each label under 20 words."
                .to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!("Review piles: {json}"),
        },
    ])
}

#[derive(Debug, Deserialize)]
struct RawCuration {
    groups: Vec<RawCuratedGroup>,
}

#[derive(Debug, Deserialize)]
struct RawCuratedGroup {
    label: String,
    #[serde(default)]
    piles: Vec<RawCuratedPileRef>,
}

#[derive(Debug, Deserialize)]
struct RawCuratedPileRef {
    #[serde(rename = "pileKey")]
    pile_key: String,
    #[serde(rename = "wordIds", default)]
    word_ids: Option<Vec<String>>,
}

/// The model is not trusted to return only JSON — some providers wrap it in
/// prose or a markdown fence regardless of instruction. This takes the
/// widest `{...}` slice of the text rather than assuming the whole response
/// parses.
fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| &text[start..=end])
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

/// Validate a raw model response against the rule piles that were live when
/// this call was made, dropping anything the model could not have actually
/// been given: an unknown `pileKey`, a `wordId` not in that pile, a group
/// left with nothing valid after filtering. See the module doc's rule 3 —
/// this is the entire hallucination defense, and it is unconditional: there
/// is no partial-trust mode.
fn parse_curation_response(text: &str, live_piles: &[ReviewPile]) -> AppResult<Vec<CuratedGroup>> {
    let json_slice = extract_json_object(text)
        .ok_or_else(|| AppError::Ai("REVIEW_PILE_CURATION_AI_INVALID".to_string()))?;
    let raw: RawCuration = serde_json::from_str(json_slice)
        .map_err(|_| AppError::Ai("REVIEW_PILE_CURATION_AI_INVALID".to_string()))?;

    let live: HashMap<String, HashSet<&str>> = live_piles
        .iter()
        .map(|pile| {
            (
                pile_key(&pile.kind),
                pile.word_ids.iter().map(String::as_str).collect(),
            )
        })
        .collect();

    let mut groups = Vec::new();
    for raw_group in raw.groups.into_iter().take(MAX_GROUPS) {
        let label = truncate_chars(raw_group.label.trim(), MAX_LABEL_CHARS);
        if label.is_empty() {
            continue;
        }
        let mut piles = Vec::new();
        for raw_pile in raw_group.piles {
            let Some(valid_word_ids) = live.get(raw_pile.pile_key.as_str()) else {
                continue;
            };
            let word_ids = match raw_pile.word_ids {
                None => None,
                Some(ids) => {
                    let filtered: Vec<String> = ids
                        .into_iter()
                        .filter(|id| valid_word_ids.contains(id.as_str()))
                        .collect();
                    if filtered.is_empty() {
                        continue;
                    }
                    Some(filtered)
                }
            };
            piles.push(CuratedPileRef {
                pile_key: raw_pile.pile_key,
                word_ids,
            });
        }
        if piles.is_empty() {
            continue;
        }
        groups.push(CuratedGroup { label, piles });
    }
    Ok(groups)
}

fn curation_error_code(error: &AppError) -> &'static str {
    let text = error.to_string().to_ascii_lowercase();
    if text.contains("not_configured")
        || text.contains("no_usable_keys")
        || text.contains("keys_disabled")
    {
        "REVIEW_PILE_CURATION_AI_NOT_CONFIGURED"
    } else if text.contains("quota") || text.contains("insufficient") || text.contains("status=402")
    {
        "REVIEW_PILE_CURATION_AI_QUOTA"
    } else if text.contains("cancel") {
        "REVIEW_PILE_CURATION_AI_CANCELLED"
    } else if text.contains("network")
        || text.contains("offline")
        || text.contains("timeout")
        || text.contains("connect")
    {
        "REVIEW_PILE_CURATION_AI_OFFLINE"
    } else {
        "REVIEW_PILE_CURATION_AI_FAILED"
    }
}

fn load_cached_curation(db: &Db) -> AppResult<Option<ReviewPileCuration>> {
    let conn = db.reader();
    let row: Option<(i64, String, String, String)> = conn
        .query_row(
            "SELECT generated_at, groups_json, provider, model FROM review_pile_curation WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((generated_at, groups_json, provider, model)) = row else {
        return Ok(None);
    };
    let groups: Vec<CuratedGroup> = serde_json::from_str(&groups_json)
        .map_err(|error| AppError::Other(format!("corrupt review_pile_curation row: {error}")))?;
    Ok(Some(ReviewPileCuration {
        generated_at,
        groups,
        provider,
        model,
    }))
}

fn save_curation(db: &Db, curation: &ReviewPileCuration) -> AppResult<()> {
    let groups_json = serde_json::to_string(&curation.groups)
        .map_err(|error| AppError::Other(error.to_string()))?;
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "INSERT INTO review_pile_curation (id, generated_at, groups_json, provider, model)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            generated_at = excluded.generated_at,
            groups_json = excluded.groups_json,
            provider = excluded.provider,
            model = excluded.model",
        params![
            curation.generated_at,
            groups_json,
            curation.provider,
            curation.model
        ],
    )?;
    Ok(())
}

fn is_fresh(cached: &ReviewPileCuration, now_ms: i64) -> bool {
    now_ms.saturating_sub(cached.generated_at) < CURATION_TTL_MS
}

/// What a caller who has confirmed the job is enabled should do next. Kept
/// separate from that enabled check (see `maybe_refresh_review_pile_curation_inner`)
/// so the freshness rule can be tested without touching the settings table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefreshDecision {
    /// A fresh-enough cached curation already exists; do not spend anything.
    Skip,
    /// No cached curation, or it is older than `CURATION_TTL_MS`.
    Refresh,
}

fn refresh_decision(db: &Db, now_ms: i64) -> AppResult<RefreshDecision> {
    match load_cached_curation(db)? {
        Some(cached) if is_fresh(&cached, now_ms) => Ok(RefreshDecision::Skip),
        _ => Ok(RefreshDecision::Refresh),
    }
}

/// Re-check a cached curation's references against piles recomputed right
/// now, dropping anything that no longer exists (a word deleted, a pile that
/// no longer qualifies), and returning `None` outright if the job is
/// disabled — see the module doc's rule 2. This is the one function both
/// tauri commands below read through, so "off" and "stale reference" are
/// each handled in exactly one place.
pub fn load_and_validate_curation(db: &Db, now_ms: i64) -> AppResult<Option<ReviewPileCuration>> {
    if !auto_analysis::is_enabled(&db.reader(), JOB_ID) {
        return Ok(None);
    }
    let Some(cached) = load_cached_curation(db)? else {
        return Ok(None);
    };
    let live_piles = review_piles::list_review_piles_at(db, now_ms)?;
    let live: HashMap<String, HashSet<&str>> = live_piles
        .iter()
        .map(|pile| {
            (
                pile_key(&pile.kind),
                pile.word_ids.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    let groups: Vec<CuratedGroup> = cached
        .groups
        .into_iter()
        .filter_map(|group| {
            let piles: Vec<CuratedPileRef> = group
                .piles
                .into_iter()
                .filter_map(|pile_ref| {
                    let valid_word_ids = live.get(pile_ref.pile_key.as_str())?;
                    let word_ids = match pile_ref.word_ids {
                        None => None,
                        Some(ids) => {
                            let filtered: Vec<String> = ids
                                .into_iter()
                                .filter(|id| valid_word_ids.contains(id.as_str()))
                                .collect();
                            if filtered.is_empty() {
                                return None;
                            }
                            Some(filtered)
                        }
                    };
                    Some(CuratedPileRef {
                        pile_key: pile_ref.pile_key,
                        word_ids,
                    })
                })
                .collect();
            (!piles.is_empty()).then_some(CuratedGroup {
                label: group.label,
                piles,
            })
        })
        .collect();
    if groups.is_empty() {
        return Ok(None);
    }
    Ok(Some(ReviewPileCuration {
        generated_at: cached.generated_at,
        groups,
        provider: cached.provider,
        model: cached.model,
    }))
}

/// Run the AI call and persist its (validated) result. Never called directly
/// by a caller that has not already checked `auto_analysis::is_enabled` —
/// see `maybe_refresh_review_pile_curation_inner`, the one place that does.
///
/// `origin` follows the same convention as every other job in this registry
/// (`commands::reading_stats::generate_reading_review_inner`): `"auto"` for
/// the lazy daily trigger, `"user"` reserved for a future manual button this
/// task does not add.
async fn generate_curation_inner(
    app: &tauri::AppHandle,
    db: &Db,
    secrets: &Secrets,
    now_ms: i64,
    origin: &str,
) -> AppResult<ReviewPileCuration> {
    let live_piles = review_piles::list_review_piles_at(db, now_ms)?;
    if live_piles.is_empty() {
        return Err(AppError::Ai(
            "REVIEW_PILE_CURATION_NOTHING_TO_CURATE".to_string(),
        ));
    }
    let messages = curation_prompt(&live_piles)?;
    let completion = crate::ai::router::complete_with_failover(
        app,
        db,
        secrets,
        &messages,
        Some(900),
        // Utility, not Chat: this is a shape Lantern dictates and forces the
        // cheapest no-reasoning tier — see AiRequestPurpose's doc comment.
        // There is no separate "cheap model" concept anywhere in the router;
        // this is the whole mechanism, same as every other automatic job.
        crate::ai::router::AiRequestPurpose::Utility,
        crate::ai::router::AiRetryMode::Automatic,
        None,
        None,
        origin,
        // Must stay exactly JOB_ID — see the doc comment on JOB_ID and on
        // `AutoAnalysisJob::id`.
        JOB_ID,
    )
    .await
    .map_err(|error| AppError::Ai(curation_error_code(&error).to_string()))?;
    let groups = parse_curation_response(&completion.text, &live_piles)?;
    let curation = ReviewPileCuration {
        generated_at: now_ms,
        groups,
        provider: completion.provider,
        model: completion.model,
    };
    save_curation(db, &curation)?;
    Ok(curation)
}

/// The `review_pile_curation` job's whole automatic path: enabled check,
/// then daily-cadence check, then (only if both pass) the AI call.
///
/// Failure is swallowed the same way `run_book_finished_analysis` swallows
/// it — a reader who did not ask for this run should never see an error
/// dialog for it (decisions doc §10's "自动调用失败一律静默跳过"). On
/// failure this falls back to whatever validated cached curation exists,
/// which may be `None` — that is still strictly additive: the rule piles
/// underneath are already returned by a separate, unrelated call the
/// frontend makes to `review_piles::list_review_piles`.
async fn maybe_refresh_review_pile_curation_inner(
    app: &tauri::AppHandle,
    db: &Db,
    secrets: &Secrets,
    now_ms: i64,
    origin: &str,
) -> AppResult<Option<ReviewPileCuration>> {
    if !auto_analysis::is_enabled(&db.reader(), JOB_ID) {
        return Ok(None);
    }
    match refresh_decision(db, now_ms)? {
        RefreshDecision::Skip => load_and_validate_curation(db, now_ms),
        RefreshDecision::Refresh => {
            match generate_curation_inner(app, db, secrets, now_ms, origin).await {
                Ok(curation) => Ok(Some(curation)),
                Err(error) => {
                    log::debug!("review pile curation skipped: {error}");
                    load_and_validate_curation(db, now_ms)
                }
            }
        }
    }
}

/// Refresh the curation if the job is on and due, then return whatever is
/// now valid (freshly generated, previously cached, or `None`). Safe to call
/// from anywhere the review page loads — it is a no-op read when the switch
/// is off or nothing is due.
#[tauri::command]
pub async fn refresh_review_pile_curation(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<Option<ReviewPileCuration>> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    maybe_refresh_review_pile_curation_inner(&app, &db, &secrets, now_ms, "auto").await
}

/// Read-only: today's validated curation, or `None`. Never triggers an AI
/// call — a page that only wants to render, not to spend, calls this instead
/// of `refresh_review_pile_curation`.
#[tauri::command]
pub fn review_pile_curation(db: State<'_, Db>) -> AppResult<Option<ReviewPileCuration>> {
    load_and_validate_curation(&db, chrono::Utc::now().timestamp_millis())
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

    fn insert_vocab_word(conn: &RusqliteConnection, id: &str, book_id: &str, word: &str) {
        conn.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, mastery, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'definition', 'new', 1700000000000, 1700000000000)",
            params![id, book_id, word],
        )
        .unwrap();
    }

    fn insert_lookup_record(
        conn: &RusqliteConnection,
        id: &str,
        book_id: &str,
        normalized_text: &str,
        cfi: &str,
        last_looked_up_at: i64,
    ) {
        conn.execute(
            "INSERT INTO lookup_records (id, book_id, lookup_text, normalized_text, cfi, definition, created_at, last_looked_up_at, lookup_count)
             VALUES (?1, ?2, ?3, ?3, ?4, 'def', ?5, ?5, 1)",
            params![id, book_id, normalized_text, cfi, last_looked_up_at],
        )
        .unwrap();
    }

    /// Builds one RepeatLookupsInBook pile's worth of fixture data, so tests
    /// have something for `list_review_piles_at` to return.
    fn seed_one_repeat_lookup_pile(db: &Db) {
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude");
        insert_lookup_record(&conn, "l1", "book-a", "solitude", "cfi-1", 1_000);
        insert_lookup_record(&conn, "l2", "book-a", "solitude", "cfi-2", 2_000);
    }

    // ---- The mandated test: off means byte-identical to the feature not existing ----

    /// The one test the task explicitly requires: with the switch off (the
    /// shipped default), `review_piles::list_review_piles_at` — the exact
    /// function the review page calls — must serialize to precisely the same
    /// bytes whether or not this module, its table, or a leftover cached
    /// curation from an earlier "on" period exist. Off does not mean
    /// "returns nothing extra", it means "the rule engine cannot tell this
    /// module exists at all".
    #[test]
    fn switching_the_job_off_leaves_review_piles_untouched() {
        let (_dir, db) = setup();
        seed_one_repeat_lookup_pile(db_ref(&db));
        let now_ms = 10_000;

        let before = review_piles::list_review_piles_at(&db, now_ms).unwrap();
        let before_json = serde_json::to_string(&before).unwrap();
        assert!(!before.is_empty(), "fixture must produce at least one pile");

        // Default-off, exactly as shipped: nobody has touched the switch.
        assert!(!auto_analysis::is_enabled(&db.reader(), JOB_ID));
        assert_eq!(load_and_validate_curation(&db, now_ms).unwrap(), None);

        // Simulate the harder case: a curation was cached during an earlier
        // "on" period, then the reader turned it back off. Even leftover
        // cached AI data must not leak into either the rule piles or the
        // read command.
        let leftover = ReviewPileCuration {
            generated_at: now_ms,
            groups: vec![CuratedGroup {
                label: "leftover from when this was on".to_string(),
                piles: vec![CuratedPileRef {
                    pile_key: pile_key(&before[0].kind),
                    word_ids: None,
                }],
            }],
            provider: "anthropic".to_string(),
            model: "claude-test".to_string(),
        };
        save_curation(&db, &leftover).unwrap();
        assert!(load_cached_curation(&db).unwrap().is_some());

        // Still off: the cached row exists but must not surface.
        assert_eq!(load_and_validate_curation(&db, now_ms).unwrap(), None);

        // And the rule piles themselves — what the review page actually
        // renders — are byte-for-byte the same as before any of this ran.
        let after = review_piles::list_review_piles_at(&db, now_ms).unwrap();
        let after_json = serde_json::to_string(&after).unwrap();
        assert_eq!(before_json, after_json);
    }

    fn db_ref(db: &Db) -> &Db {
        db
    }

    #[test]
    fn turning_it_on_surfaces_a_validated_cached_curation() {
        let (_dir, db) = setup();
        seed_one_repeat_lookup_pile(&db);
        let now_ms = 10_000;
        let piles = review_piles::list_review_piles_at(&db, now_ms).unwrap();

        let curation = ReviewPileCuration {
            generated_at: now_ms,
            groups: vec![CuratedGroup {
                label: "grouped".to_string(),
                piles: vec![CuratedPileRef {
                    pile_key: pile_key(&piles[0].kind),
                    word_ids: None,
                }],
            }],
            provider: "anthropic".to_string(),
            model: "claude-test".to_string(),
        };
        save_curation(&db, &curation).unwrap();
        auto_analysis::set_enabled_for_test(&db, JOB_ID, true);

        let loaded = load_and_validate_curation(&db, now_ms).unwrap();
        assert_eq!(loaded, Some(curation));
    }

    #[test]
    fn a_stale_pile_reference_is_dropped_not_surfaced() {
        let (_dir, db) = setup();
        seed_one_repeat_lookup_pile(&db);
        let now_ms = 10_000;

        let curation = ReviewPileCuration {
            generated_at: now_ms,
            groups: vec![CuratedGroup {
                label: "a pile that no longer exists".to_string(),
                piles: vec![CuratedPileRef {
                    pile_key: "recent_chapter_lookups:book-z:Ch1".to_string(),
                    word_ids: None,
                }],
            }],
            provider: "anthropic".to_string(),
            model: "claude-test".to_string(),
        };
        save_curation(&db, &curation).unwrap();
        auto_analysis::set_enabled_for_test(&db, JOB_ID, true);

        assert_eq!(load_and_validate_curation(&db, now_ms).unwrap(), None);
    }

    #[test]
    fn a_stale_word_id_inside_a_split_is_dropped_but_the_pile_ref_survives_if_others_remain() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "book-a", "Book A");
        insert_vocab_word(&conn, "w1", "book-a", "solitude");
        insert_vocab_word(&conn, "w2", "book-a", "reverie");
        insert_lookup_record(&conn, "l1", "book-a", "solitude", "cfi-1", 1_000);
        insert_lookup_record(&conn, "l2", "book-a", "solitude", "cfi-2", 2_000);
        insert_lookup_record(&conn, "l3", "book-a", "reverie", "cfi-3", 3_000);
        insert_lookup_record(&conn, "l4", "book-a", "reverie", "cfi-4", 4_000);
        drop(conn);
        let now_ms = 10_000;
        let piles = review_piles::list_review_piles_at(&db, now_ms).unwrap();

        let curation = ReviewPileCuration {
            generated_at: now_ms,
            groups: vec![CuratedGroup {
                label: "split".to_string(),
                piles: vec![CuratedPileRef {
                    pile_key: pile_key(&piles[0].kind),
                    word_ids: Some(vec!["w1".to_string(), "deleted-word".to_string()]),
                }],
            }],
            provider: "anthropic".to_string(),
            model: "claude-test".to_string(),
        };
        save_curation(&db, &curation).unwrap();
        auto_analysis::set_enabled_for_test(&db, JOB_ID, true);

        let loaded = load_and_validate_curation(&db, now_ms).unwrap().unwrap();
        assert_eq!(loaded.groups.len(), 1);
        assert_eq!(
            loaded.groups[0].piles[0].word_ids,
            Some(vec!["w1".to_string()])
        );
    }

    #[test]
    fn pile_key_is_stable_and_distinguishes_kinds() {
        let a = ReviewPileKind::RepeatLookupsInBook {
            book_id: "b1".to_string(),
            book_title: "Book".to_string(),
            solo_word_lookups: None,
            solo_word_glances: None,
        };
        let b = ReviewPileKind::RecentChapterLookups {
            book_id: "b1".to_string(),
            book_title: "Book".to_string(),
            chapter: "Ch1".to_string(),
        };
        assert_ne!(pile_key(&a), pile_key(&b));
        assert_eq!(pile_key(&a), pile_key(&a.clone()));
        assert_eq!(pile_key(&ReviewPileKind::LongUnseen), "long_unseen");
        assert_eq!(
            pile_key(&ReviewPileKind::PromotedThenLookedUp),
            "promoted_then_looked_up"
        );
    }

    fn sample_live_piles() -> Vec<ReviewPile> {
        vec![ReviewPile {
            kind: ReviewPileKind::RepeatLookupsInBook {
                book_id: "book-a".to_string(),
                book_title: "Book A".to_string(),
                solo_word_lookups: None,
                solo_word_glances: None,
            },
            word_ids: vec!["w1".to_string(), "w2".to_string()],
            words: Vec::new(),
            newest_activity_at: 1_000,
        }]
    }

    #[test]
    fn parse_accepts_a_whole_pile_reference() {
        let piles = sample_live_piles();
        let response = r#"{"groups":[{"label":"solid pile","piles":[{"pileKey":"repeat_lookups_in_book:book-a"}]}]}"#;
        let groups = parse_curation_response(response, &piles).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].piles[0].word_ids, None);
    }

    #[test]
    fn parse_drops_a_hallucinated_pile_key() {
        let piles = sample_live_piles();
        let response =
            r#"{"groups":[{"label":"invented","piles":[{"pileKey":"does_not_exist"}]}]}"#;
        let groups = parse_curation_response(response, &piles).unwrap();
        assert!(groups.is_empty());
    }

    #[test]
    fn parse_drops_hallucinated_word_ids_inside_a_real_pile() {
        let piles = sample_live_piles();
        let response = r#"{"groups":[{"label":"split","piles":[{"pileKey":"repeat_lookups_in_book:book-a","wordIds":["w1","invented"]}]}]}"#;
        let groups = parse_curation_response(response, &piles).unwrap();
        assert_eq!(groups[0].piles[0].word_ids, Some(vec!["w1".to_string()]));
    }

    #[test]
    fn parse_drops_a_group_left_with_no_valid_piles() {
        let piles = sample_live_piles();
        let response = r#"{"groups":[{"label":"all invented","piles":[{"pileKey":"nope"},{"pileKey":"repeat_lookups_in_book:book-a","wordIds":["invented-only"]}]}]}"#;
        let groups = parse_curation_response(response, &piles).unwrap();
        assert!(groups.is_empty());
    }

    #[test]
    fn parse_tolerates_prose_wrapped_around_the_json() {
        let piles = sample_live_piles();
        let response = "Sure, here you go:\n```json\n{\"groups\":[{\"label\":\"ok\",\"piles\":[{\"pileKey\":\"repeat_lookups_in_book:book-a\"}]}]}\n```\nHope that helps!";
        let groups = parse_curation_response(response, &piles).unwrap();
        assert_eq!(groups.len(), 1);
    }

    #[test]
    fn parse_rejects_text_with_no_json_object_at_all() {
        let piles = sample_live_piles();
        assert!(parse_curation_response("no json here", &piles).is_err());
    }

    #[test]
    fn a_label_longer_than_the_cap_is_truncated_not_rejected() {
        let piles = sample_live_piles();
        let long_label = "a".repeat(500);
        let response = format!(
            r#"{{"groups":[{{"label":"{long_label}","piles":[{{"pileKey":"repeat_lookups_in_book:book-a"}}]}}]}}"#
        );
        let groups = parse_curation_response(&response, &piles).unwrap();
        assert_eq!(groups[0].label.chars().count(), MAX_LABEL_CHARS);
    }

    #[test]
    fn more_groups_than_the_cap_are_dropped_not_erroring() {
        let piles = sample_live_piles();
        let group = r#"{"label":"g","piles":[{"pileKey":"repeat_lookups_in_book:book-a"}]}"#;
        let groups_json = std::iter::repeat_n(group, MAX_GROUPS + 10)
            .collect::<Vec<_>>()
            .join(",");
        let response = format!(r#"{{"groups":[{groups_json}]}}"#);
        let groups = parse_curation_response(&response, &piles).unwrap();
        assert_eq!(groups.len(), MAX_GROUPS);
    }

    #[test]
    fn save_and_load_curation_round_trips() {
        let (_dir, db) = setup();
        let curation = ReviewPileCuration {
            generated_at: 5_000,
            groups: vec![CuratedGroup {
                label: "hello".to_string(),
                piles: vec![CuratedPileRef {
                    pile_key: "long_unseen".to_string(),
                    word_ids: Some(vec!["w1".to_string()]),
                }],
            }],
            provider: "anthropic".to_string(),
            model: "claude-test".to_string(),
        };
        save_curation(&db, &curation).unwrap();
        assert_eq!(load_cached_curation(&db).unwrap(), Some(curation.clone()));

        // A second save overwrites the singleton row, it does not append.
        let replaced = ReviewPileCuration {
            generated_at: 6_000,
            ..curation
        };
        save_curation(&db, &replaced).unwrap();
        assert_eq!(load_cached_curation(&db).unwrap(), Some(replaced));
    }

    #[test]
    fn freshness_respects_the_ttl_boundary() {
        let cached = ReviewPileCuration {
            generated_at: 0,
            groups: Vec::new(),
            provider: "anthropic".to_string(),
            model: "m".to_string(),
        };
        assert!(is_fresh(&cached, CURATION_TTL_MS - 1));
        assert!(!is_fresh(&cached, CURATION_TTL_MS));
    }

    #[test]
    fn refresh_decision_skips_when_a_fresh_row_exists_and_refreshes_otherwise() {
        let (_dir, db) = setup();
        assert_eq!(
            refresh_decision(&db, 0).unwrap(),
            RefreshDecision::Refresh,
            "nothing cached yet"
        );

        let curation = ReviewPileCuration {
            generated_at: 0,
            groups: vec![CuratedGroup {
                label: "x".to_string(),
                piles: vec![CuratedPileRef {
                    pile_key: "long_unseen".to_string(),
                    word_ids: None,
                }],
            }],
            provider: "anthropic".to_string(),
            model: "m".to_string(),
        };
        save_curation(&db, &curation).unwrap();
        assert_eq!(
            refresh_decision(&db, CURATION_TTL_MS - 1).unwrap(),
            RefreshDecision::Skip
        );
        assert_eq!(
            refresh_decision(&db, CURATION_TTL_MS).unwrap(),
            RefreshDecision::Refresh,
            "past the TTL, due again"
        );
    }

    #[test]
    fn an_empty_rule_pile_set_curates_nothing_rather_than_hallucinating_groups() {
        let piles: Vec<ReviewPile> = Vec::new();
        // No live piles means no valid pileKey can exist, so any response
        // the model might have produced degrades to nothing — matches
        // `generate_curation_inner`'s own early return, exercised at the
        // parse layer here without needing a network call.
        let response =
            r#"{"groups":[{"label":"invented from nothing","piles":[{"pileKey":"long_unseen"}]}]}"#;
        let groups = parse_curation_response(response, &piles).unwrap();
        assert!(groups.is_empty());
    }
}
