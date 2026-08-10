//! The SQLite half of the mastery engine: turn recorded exposures into tiers.
//!
//! [`super`] holds the arithmetic and knows nothing about storage; this holds
//! the storage and makes no judgements. The split is deliberate — see the
//! parent module's "why this module holds no database handle".
//!
//! ## The one hard problem here
//!
//! `reading_word_exposures` is a running total, not a log. Scoring it twice
//! would count every exposure the reader has ever had, twice, and walk their
//! whole vocabulary to `mastered`. Migration 039's `scored_encounter_count`
//! is the watermark that makes a pass idempotent: a pass consumes exactly
//! `encounter_count - scored_encounter_count` occurrences, numbered from
//! `scored_encounter_count + 1` so §2.2's diminishing weights keep counting
//! across passes instead of restarting at 1 on every flush.
//!
//! The watermark advances for **every** row the pass reads, including rows
//! for words that are not in the reader's vocabulary list. Those have nowhere
//! to put a tier, so their credit is discarded rather than banked. Banking it
//! would mean that the moment a reader finally looks a word up — which is how
//! words enter the list, and is itself evidence they did *not* know it — a
//! backlog of exposures would land at once and promote it.

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension, Transaction};

use crate::calibration;
use crate::commands::lookup_history::normalize;
use crate::commands::vocab::{create_watchlist_word_from_glance, set_auto_mastery};
use crate::error::AppResult;
use crate::sync::events::EventBody;

use super::{
    apply_exposures, apply_lookup, ChapterExposures, Exposure, ExposureBatch, Lookup, LookupKind,
    Tier, WordState, GLANCE_DEDUPE_WINDOW_MS, GLANCE_ENTRY_THRESHOLD, REASON_EXPOSURE_PROMOTION,
    REASON_GLANCE_ENTRY, REASON_LOOKUP_DEMOTION, REASON_REPEAT_LOOKUP_DEMOTION,
};

/// One `reading_word_exposures` row with unscored occurrences on it.
struct PendingRow {
    id: String,
    normalized_word: String,
    encounter_count: i64,
    scored_encounter_count: i64,
    lookup_active_count: i64,
    scored_lookup_active_count: i64,
}

impl PendingRow {
    fn new_occurrences(&self) -> i64 {
        (self.encounter_count - self.scored_encounter_count).max(0)
    }

    /// How many of this row's new occurrences were on a screen where the
    /// reader was looking some *other* word up.
    ///
    /// Both columns are totals, so which of the new occurrences those were is
    /// not recoverable. They are credited to the earliest ones — the ones
    /// carrying §2.2's highest weights. §2.4 says every boundary breaks
    /// toward the reader, and `CHAPTER_CREDIT_CAP` bounds how far one
    /// chapter's generosity can carry a word regardless.
    fn new_lookup_active(&self) -> i64 {
        (self.lookup_active_count - self.scored_lookup_active_count)
            .max(0)
            .min(self.new_occurrences())
    }

    fn to_chapter_exposures(&self) -> ChapterExposures {
        let boosted = self.new_lookup_active();
        let exposures = (0..self.new_occurrences())
            .map(|index| Exposure {
                // +1 for 1-based occurrence numbering: the watermark counts
                // occurrences already consumed, so the next one is the one
                // after it.
                chapter_occurrence: (self.scored_encounter_count + index + 1)
                    .clamp(1, u32::MAX as i64) as u32,
                on_lookup_active_screen: index < boosted,
                // Both §2.4 exclusions ran at write time, where a screen was
                // still a screen — see the parent module's "Exclusions".
                screen_words_per_minute: f64::NAN,
            })
            .collect();
        ChapterExposures::new(exposures)
    }
}

/// A vocabulary row this book's exposures can be scored against.
struct VocabTarget {
    id: String,
    tier: Tier,
    mastery: String,
}

/// Score every unconsumed exposure recorded for one book.
///
/// Returns how many words changed tier — nothing acts on the number today
/// beyond the tests, but a caller that wanted to refresh a view cheaply needs
/// to be able to ask "did anything move?" without re-reading the table.
///
/// Runs inside the caller's transaction on purpose: folding a batch of
/// screens into exposures and scoring those exposures is one fact about the
/// reader's session, and a crash between the two would leave a watermark
/// disagreeing with the counts it watermarks.
pub fn score_book_exposures(
    tx: &Transaction<'_>,
    events: &mut Vec<EventBody>,
    book_id: &str,
    now: i64,
    device: &str,
) -> AppResult<usize> {
    let pending = load_pending(tx, book_id)?;
    if pending.is_empty() {
        return Ok(0);
    }

    let vocab = load_vocab_targets(tx, book_id)?;
    let mut changed = 0usize;

    if !vocab.is_empty() {
        let book_title = book_title(tx, book_id)?;
        // Read once per pass, not once per word: this is this reader's own
        // calibration, not a per-word fact, and re-reading it inside the
        // loop below would turn one cheap indexed lookup into one per word
        // scored. See crate::calibration for the derivation and the two
        // guardrails (insufficient sample -> neutral 1.0; recompute never
        // touches history already scored by an earlier pass's value).
        let calibration = calibration::load_from_conn(tx)?;
        let lookup_rate_scale = calibration::lookup_rate_scale(calibration.lookup_rate_per_1000);
        // Group a word's rows across chapters: CHAPTER_CREDIT_CAP is what
        // separates "read twenty times in one chapter" from "read once in
        // twenty chapters", and it can only be applied per chapter.
        let mut by_word: HashMap<&str, Vec<&PendingRow>> = HashMap::new();
        for row in &pending {
            by_word
                .entry(row.normalized_word.as_str())
                .or_default()
                .push(row);
        }
        // Deterministic order: the same reading session must produce the same
        // sequence of timeline rows on every run.
        let mut words: Vec<&&str> = by_word.keys().collect();
        words.sort_unstable();

        for word in words {
            let Some(target) = vocab.get(*word) else {
                continue;
            };
            let rows = &by_word[*word];
            let state = load_progress(tx, &target.id)?.with_tier(target.tier);
            let batch = ExposureBatch {
                reader_median_wpm: None,
                lookup_rate_scale,
                chapters: rows.iter().map(|row| row.to_chapter_exposures()).collect(),
            };
            let decision = apply_exposures(&state, &batch);
            if decision.changed {
                let detail = exposure_detail(tx, &book_title, book_id, word)?;
                set_auto_mastery(
                    tx,
                    events,
                    &target.id,
                    &target.mastery,
                    decision.tier.as_str(),
                    REASON_EXPOSURE_PROMOTION,
                    &detail,
                    now,
                    device,
                )?;
                changed += 1;
            }
            save_progress(tx, &target.id, decision.credit, &state, now)?;
        }
    }

    advance_watermarks(tx, &pending, now)?;
    Ok(changed)
}

/// Record that the reader stopped and asked what a word means.
///
/// Returns whether a tier moved. A lookup on a word that is not in the
/// reader's vocabulary list moves nothing and is not an error: there is no
/// tier to lower, and inventing a list entry here would put words in the list
/// that the reader never chose to keep.
///
/// Runs inside the caller's transaction, alongside the `lookup_records` write
/// it describes, so the two facts cannot come apart.
///
/// ## Why every sibling row's credit is discounted, not just one
///
/// The same word saved from three books is three rows and one entry to the
/// reader — that is why every mastery write here propagates to siblings.
/// Credit has to follow the same rule. Credit is evidence the reader knew the
/// word and a lookup is the reader saying otherwise, so a lookup in book B
/// cannot leave book A's half-finished promotion standing.
///
/// Each row is discounted from *its own* credit rather than from one shared
/// number. A card multiplies by zero, so the distinction never arose before;
/// a glance multiplies by a half, and halving book A's credit has to mean half
/// of what book A had.
pub fn apply_lookup_to_word(
    tx: &Transaction<'_>,
    events: &mut Vec<EventBody>,
    book_id: &str,
    lookup_text: &str,
    kind: LookupKind,
    now: i64,
    device: &str,
) -> AppResult<bool> {
    let normalized = normalize(lookup_text);
    if normalized.is_empty() {
        return Ok(false);
    }
    let rows = load_lookup_targets(tx, book_id, lookup_text, &normalized)?;
    let Some(primary) = rows.first() else {
        return Ok(false);
    };

    let progress = rows
        .iter()
        .map(|row| load_progress(tx, &row.id))
        .collect::<AppResult<Vec<_>>>()?;
    // The chain lives on whichever sibling was written last. Reading the most
    // recent one keeps a reader who looks the word up in a different book
    // inside the same repeat window, which is the point of the window.
    let state = newest_chain(&progress).with_tier(primary.tier);
    let decision = apply_lookup(&state, Lookup { at_ms: now, kind });

    if decision.changed {
        let reason = decision.reason.unwrap_or(REASON_LOOKUP_DEMOTION);
        let detail = lookup_detail(
            tx,
            book_id,
            reason,
            decision.lookups_in_window,
            decision.glances_in_window,
        );
        set_auto_mastery(
            tx,
            events,
            &primary.id,
            &primary.mastery,
            decision.tier.as_str(),
            reason,
            &detail,
            now,
            device,
        )?;
    }
    let multiplier = kind.credit_multiplier();
    for (row, before) in rows.iter().zip(&progress) {
        let credit = before.credit.max(0.0) * multiplier;
        save_progress(
            tx,
            &row.id,
            credit,
            &WordState {
                tier: decision.tier,
                credit,
                last_lookup_at_ms: Some(now),
                lookups_in_window: decision.lookups_in_window,
                glances_in_window: decision.glances_in_window,
            },
            now,
        )?;
    }
    Ok(decision.changed)
}

/// What one dictionary glance did.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct GlanceOutcome {
    /// False when the 60-second same-position dedupe swallowed it. Nothing
    /// below it ran.
    pub counted: bool,
    /// The word's lifetime glance total in this book, after this one.
    pub glance_count: i64,
    /// This glance was the [`GLANCE_ENTRY_THRESHOLD`]th, and filed the word
    /// into the watchlist.
    pub entered_watchlist: bool,
    /// A tier moved — either the entry above, or the weighted chain.
    pub tier_changed: bool,
}

/// Record that the reader single-clicked a word and read the free dictionary
/// definition without doing anything else.
///
/// The frontend owns the hard part of this decision and this function trusts
/// it: the menu stayed open past the definition rendering, and no other menu
/// action was taken. See `docs/impls/dictionary-glance-mastery.md` §1 for why
/// the gate lives there — only the menu knows whether it was still open, and
/// only it knows what else was clicked.
///
/// Two things happen here, in order, and the order matters:
///
/// 1. the lifetime ledger advances, and on its [`GLANCE_ENTRY_THRESHOLD`]th
///    entry the word joins the watchlist at `learning`;
/// 2. the weighted chain runs, worth half a card lookup.
///
/// Entry first, because a word with no vocabulary row has no tier for step 2
/// to move — running the chain first would silently drop the very glance that
/// earned the word its place. It does not double-punish: the chain lives on
/// `mastery_progress`, which only exists for rows in the list, so a word
/// entering now starts its chain at this glance and no earlier one.
#[allow(clippy::too_many_arguments)]
pub fn record_glance(
    tx: &Transaction<'_>,
    events: &mut Vec<EventBody>,
    book_id: &str,
    word: &str,
    definition: &str,
    context_sentence: Option<&str>,
    cfi: Option<&str>,
    now: i64,
    device: &str,
) -> AppResult<GlanceOutcome> {
    let normalized = normalize(word);
    if normalized.is_empty() {
        return Ok(GlanceOutcome::default());
    }

    let previous: Option<(i64, i64, Option<String>)> = tx
        .query_row(
            "SELECT glance_count, last_glanced_at, last_cfi
               FROM dictionary_glances WHERE book_id = ?1 AND normalized_word = ?2",
            params![book_id, normalized],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;

    if let Some((count, last_at, last_cfi)) = &previous {
        let same_place = cfi.is_some() && last_cfi.as_deref() == cfi;
        if same_place && now.saturating_sub(*last_at) < GLANCE_DEDUPE_WINDOW_MS {
            return Ok(GlanceOutcome {
                counted: false,
                glance_count: *count,
                ..GlanceOutcome::default()
            });
        }
    }

    let glance_count = previous.as_ref().map_or(0, |(count, _, _)| *count) + 1;
    tx.execute(
        "INSERT INTO dictionary_glances
            (book_id, normalized_word, glance_count, first_glanced_at, last_glanced_at,
             last_cfi, updated_at)
         VALUES (?1, ?2, 1, ?3, ?3, ?4, ?3)
         ON CONFLICT(book_id, normalized_word) DO UPDATE SET
             glance_count = glance_count + 1,
             last_glanced_at = ?3,
             last_cfi = ?4,
             updated_at = ?3",
        params![book_id, normalized, now, cfi],
    )?;

    let mut entered_watchlist = false;
    if glance_count >= GLANCE_ENTRY_THRESHOLD {
        if let Some(id) = create_watchlist_word_from_glance(
            tx,
            events,
            book_id,
            word.trim(),
            definition,
            context_sentence,
            cfi,
            now,
            device,
        )? {
            let detail = glance_entry_detail(tx, book_id, glance_count);
            set_auto_mastery(
                tx,
                events,
                &id,
                Tier::New.as_str(),
                Tier::Learning.as_str(),
                REASON_GLANCE_ENTRY,
                &detail,
                now,
                device,
            )?;
            entered_watchlist = true;
        }
    }

    let tier_changed =
        apply_lookup_to_word(tx, events, book_id, word, LookupKind::Glance, now, device)?;
    Ok(GlanceOutcome {
        counted: true,
        glance_count,
        entered_watchlist,
        tier_changed: tier_changed || entered_watchlist,
    })
}

/// The numbers `vocab.mastery.because.glance_entry.detail` interpolates: "You
/// checked the dictionary for it {glanceCount} times in {bookTitle}, so it has
/// been added to your list."
fn glance_entry_detail(tx: &Transaction<'_>, book_id: &str, glance_count: i64) -> String {
    let mut detail = serde_json::Map::new();
    detail.insert(
        "reason".to_string(),
        REASON_GLANCE_ENTRY.to_string().into(),
    );
    if let Ok(Some(title)) = book_title(tx, book_id) {
        detail.insert("book_title".to_string(), title.into());
    }
    detail.insert("glance_count".to_string(), glance_count.into());
    serde_json::Value::Object(detail).to_string()
}

/// The vocabulary rows a lookup applies to: every row spelling this word, the
/// one in the book being read first.
///
/// "Spelling this word" is `COLLATE NOCASE` equality against either what the
/// reader selected or its normalized form — the same rule
/// `propagate_progress_to_siblings` uses to decide two rows are one entry, so
/// the set that gets demoted is exactly the set that gets propagated to.
fn load_lookup_targets(
    tx: &Transaction<'_>,
    book_id: &str,
    lookup_text: &str,
    normalized: &str,
) -> AppResult<Vec<VocabTarget>> {
    let mut stmt = tx.prepare(
        "SELECT id, word, mastery FROM vocab_words
          WHERE word = ?1 COLLATE NOCASE OR word = ?2 COLLATE NOCASE
          ORDER BY (book_id = ?3) DESC, created_at ASC, id ASC",
    )?;
    let rows = stmt
        .query_map(params![lookup_text.trim(), normalized, book_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, _, mastery)| {
            Tier::from_db_str(&mastery).map(|tier| VocabTarget { id, tier, mastery })
        })
        .collect())
}

/// The word's lookup chain, taken from whichever sibling row was looked up
/// most recently — never mind which book the reader is holding now, since one
/// word's doubt is one word's doubt.
///
/// A word never looked up has `None` on every row and falls through to the
/// default, which is the same empty chain.
fn newest_chain(progress: &[WordState]) -> WordState {
    progress
        .iter()
        .max_by_key(|state| state.last_lookup_at_ms)
        .copied()
        .unwrap_or_default()
}

/// The numbers `vocab.mastery.because.lookup_demotion.detail` and its repeat
/// variant interpolate. A missing book title degrades the sentence to the
/// plain variant rather than rendering a hole.
///
/// Both counts always go in, including on the first rung where the old
/// single-lookup sentence carried no number at all. The frontend needs them to
/// pick between "你又查了它一次", "你查了 2 次词典" and the mixed form: which
/// sentence is true is decided by *what the reader did*, not by which rung it
/// happened to land on, so the rung cannot be what gates the numbers.
fn lookup_detail(
    tx: &Transaction<'_>,
    book_id: &str,
    reason: &str,
    lookups_in_window: u32,
    glances_in_window: u32,
) -> String {
    let mut detail = serde_json::Map::new();
    detail.insert("reason".to_string(), reason.to_string().into());
    if let Ok(Some(title)) = book_title(tx, book_id) {
        detail.insert("book_title".to_string(), title.into());
    }
    if reason == REASON_REPEAT_LOOKUP_DEMOTION {
        detail.insert("lookup_count".to_string(), lookups_in_window.into());
    }
    detail.insert("card_count".to_string(), lookups_in_window.into());
    detail.insert("glance_count".to_string(), glances_in_window.into());
    serde_json::Value::Object(detail).to_string()
}

/// The numbers `vocab.mastery.because.exposure_promotion.detail` interpolates:
/// "You read it {exposures} times over {days} days in {bookTitle} without
/// looking it up." Anything missing degrades that sentence to the plain
/// variant on the frontend rather than rendering a hole, so this is allowed
/// to be partial — but not allowed to be wrong.
///
/// It re-reads the word's whole history in this book rather than describing
/// the pass that happened to tip it over. A promotion on the fourth chapter
/// has exactly one chapter pending; a sentence built from that would tell the
/// reader they read the word once, on one day, which is the opposite of the
/// evidence the promotion was made of.
fn exposure_detail(
    tx: &Transaction<'_>,
    book_title: &Option<String>,
    book_id: &str,
    word: &str,
) -> AppResult<String> {
    let sightings = load_sightings(tx, book_id, word)?;
    let exposures: i64 = sightings.iter().map(|row| row.encounters).sum();
    let distinct_days = distinct_days(&sightings);
    let mut detail = serde_json::Map::new();
    detail.insert(
        "reason".to_string(),
        REASON_EXPOSURE_PROMOTION.to_string().into(),
    );
    if let Some(title) = book_title {
        detail.insert("book_title".to_string(), title.clone().into());
    }
    detail.insert("exposures".to_string(), exposures.into());
    detail.insert("distinct_days".to_string(), distinct_days.into());
    Ok(serde_json::Value::Object(detail).to_string())
}

/// Everything one word's rows across a book remember about when it was met.
struct Sightings {
    encounters: i64,
    chapter_days: i64,
    first_seen_at: i64,
    last_seen_at: i64,
}

fn load_sightings(tx: &Transaction<'_>, book_id: &str, word: &str) -> AppResult<Vec<Sightings>> {
    let mut stmt = tx.prepare(
        "SELECT encounter_count, distinct_days, first_seen_at, last_seen_at
           FROM reading_word_exposures
          WHERE book_id = ?1 AND normalized_word = ?2",
    )?;
    let rows = stmt
        .query_map(params![book_id, word], |row| {
            Ok(Sightings {
                encounters: row.get("encounter_count")?,
                chapter_days: row.get("distinct_days")?,
                first_seen_at: row.get("first_seen_at")?,
                last_seen_at: row.get("last_seen_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// How many separate days the reader met this word on, across the chapters
/// they met it in.
///
/// The counter on each row is per (book, chapter, word), so no single row
/// knows the answer and summing them would double-count a day spent moving
/// between two chapters. Two lower bounds are available, and the larger one
/// wins:
///
/// - the busiest single chapter's own count, and
/// - the number of distinct days among the rows' first and last sightings.
///
/// The second is what makes the ordinary promotion honest: a word met once in
/// each of four chapters on four days has four rows reading `distinct_days = 1`
/// but four different first-sighting days. Neither bound sees a day that only
/// happened in the middle of one chapter's run, so this can still understate —
/// which is the direction to be wrong in, since the sentence it feeds is the
/// app telling the reader what it saw.
fn distinct_days(rows: &[Sightings]) -> i64 {
    let busiest_chapter = rows.iter().map(|row| row.chapter_days).max().unwrap_or(0);
    let mut days: Vec<String> = rows
        .iter()
        .flat_map(|row| [row.first_seen_at, row.last_seen_at])
        .map(local_day)
        .collect();
    days.sort_unstable();
    days.dedup();
    busiest_chapter.max(days.len() as i64)
}

/// The calendar day a timestamp fell on in the reader's own timezone — the
/// same `localtime` boundary the exposures upsert counts days by, so the two
/// halves of this calculation cannot disagree about when midnight was.
fn local_day(at_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(at_ms)
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}

fn load_pending(tx: &Transaction<'_>, book_id: &str) -> AppResult<Vec<PendingRow>> {
    let mut stmt = tx.prepare(
        "SELECT id, normalized_word, encounter_count, scored_encounter_count,
                encounters_on_lookup_active_screen, scored_lookup_active_count
           FROM reading_word_exposures
          WHERE book_id = ?1 AND encounter_count > scored_encounter_count
          ORDER BY chapter, normalized_word",
    )?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(PendingRow {
                id: row.get("id")?,
                normalized_word: row.get("normalized_word")?,
                encounter_count: row.get("encounter_count")?,
                scored_encounter_count: row.get("scored_encounter_count")?,
                lookup_active_count: row.get("encounters_on_lookup_active_screen")?,
                scored_lookup_active_count: row.get("scored_lookup_active_count")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The book's vocabulary rows, keyed by the same normalization the exposure
/// rows already went through.
///
/// Two saved rows can normalize to one key (`"Quiet"` and `"quiet,"`). The
/// oldest wins, because that is the row the rest of the app treats as the
/// entry — and because a stable rule matters more here than which rule: every
/// tier written through `set_auto_mastery` is copied to the word's siblings
/// anyway, so the two rows do not end up disagreeing.
fn load_vocab_targets(
    tx: &Transaction<'_>,
    book_id: &str,
) -> AppResult<HashMap<String, VocabTarget>> {
    let mut stmt = tx.prepare(
        "SELECT id, word, mastery FROM vocab_words
          WHERE book_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let mut targets: HashMap<String, VocabTarget> = HashMap::new();
    let rows = stmt.query_map(params![book_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (id, word, mastery) = row?;
        // An unparseable tier means something upstream is wrong; scoring it
        // as brand new would quietly overwrite whatever it really was.
        let Some(tier) = Tier::from_db_str(&mastery) else {
            continue;
        };
        targets
            .entry(normalize(&word))
            .or_insert(VocabTarget { id, tier, mastery });
    }
    Ok(targets)
}

fn book_title(tx: &Transaction<'_>, book_id: &str) -> AppResult<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT title FROM books WHERE id = ?1",
            params![book_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .filter(|title| !title.trim().is_empty()))
}

/// The word's running arithmetic, or a fresh one. A missing row is not an
/// error: `mastery_progress` is written on first credit, so "no row" is the
/// honest state of a word the engine has never touched.
fn load_progress(tx: &Transaction<'_>, vocab_word_id: &str) -> AppResult<WordState> {
    let state = tx
        .query_row(
            "SELECT credit, last_lookup_at, lookups_in_window, glances_in_window
               FROM mastery_progress WHERE vocab_word_id = ?1",
            params![vocab_word_id],
            |row| {
                Ok(WordState {
                    tier: Tier::New,
                    credit: row.get("credit")?,
                    last_lookup_at_ms: row.get("last_lookup_at")?,
                    lookups_in_window: row
                        .get::<_, i64>("lookups_in_window")?
                        .clamp(0, u32::MAX as i64) as u32,
                    glances_in_window: row
                        .get::<_, i64>("glances_in_window")?
                        .clamp(0, u32::MAX as i64) as u32,
                })
            },
        )
        .optional()?
        .unwrap_or_default();
    Ok(state)
}

/// Persist a word's running arithmetic.
///
/// The caller passes the state it started from, so the exposure path writes
/// the lookup chain back unchanged — reading a word says nothing about when
/// it was last looked up — while the lookup path passes the chain it just
/// advanced.
fn save_progress(
    tx: &Transaction<'_>,
    vocab_word_id: &str,
    credit: f64,
    state: &WordState,
    now: i64,
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO mastery_progress
            (vocab_word_id, credit, last_lookup_at, lookups_in_window,
             glances_in_window, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(vocab_word_id) DO UPDATE SET
             credit = ?2, last_lookup_at = ?3, lookups_in_window = ?4,
             glances_in_window = ?5, updated_at = ?6",
        params![
            vocab_word_id,
            credit,
            state.last_lookup_at_ms,
            i64::from(state.lookups_in_window),
            i64::from(state.glances_in_window),
            now,
        ],
    )?;
    Ok(())
}

fn advance_watermarks(tx: &Transaction<'_>, pending: &[PendingRow], now: i64) -> AppResult<()> {
    let mut stmt = tx.prepare(
        "UPDATE reading_word_exposures
            SET scored_encounter_count = ?2,
                scored_lookup_active_count = ?3,
                updated_at = ?4
          WHERE id = ?1",
    )?;
    for row in pending {
        stmt.execute(params![
            row.id,
            row.encounter_count,
            row.scored_lookup_active_count + row.new_lookup_active(),
            now,
        ])?;
    }
    Ok(())
}

impl WordState {
    /// The tier lives on `vocab_words`, the rest on `mastery_progress`; this
    /// is where the two halves meet.
    fn with_tier(mut self, tier: Tier) -> Self {
        self.tier = tier;
        self
    }
}

#[cfg(test)]
mod tests;
