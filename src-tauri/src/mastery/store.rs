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

use crate::commands::lookup_history::normalize;
use crate::commands::vocab::set_auto_mastery;
use crate::error::AppResult;
use crate::sync::events::EventBody;

use super::{
    apply_exposures, apply_lookup, ChapterExposures, Exposure, ExposureBatch, Lookup, Tier,
    WordState, REASON_EXPOSURE_PROMOTION, REASON_LOOKUP_DEMOTION, REASON_REPEAT_LOOKUP_DEMOTION,
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
        // Group a word's rows across chapters: CHAPTER_CREDIT_CAP is what
        // separates "read twenty times in one chapter" from "read once in
        // twenty chapters", and it can only be applied per chapter.
        let mut by_word: HashMap<&str, Vec<&PendingRow>> = HashMap::new();
        for row in &pending {
            by_word.entry(row.normalized_word.as_str()).or_default().push(row);
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
/// ## Why every sibling row's credit is reset, not just one
///
/// The same word saved from three books is three rows and one entry to the
/// reader — that is why every mastery write here propagates to siblings.
/// Credit has to follow the same rule. Credit is evidence the reader knew the
/// word and a lookup is the reader saying otherwise, so a lookup in book B
/// cannot leave book A's half-finished promotion standing.
pub fn apply_lookup_to_word(
    tx: &Transaction<'_>,
    events: &mut Vec<EventBody>,
    book_id: &str,
    lookup_text: &str,
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

    // The chain lives on whichever sibling was written last. Reading the most
    // recent one keeps a reader who looks the word up in a different book
    // inside the same repeat window, which is the point of the window.
    let state = load_chain(tx, &rows)?.with_tier(primary.tier);
    let decision = apply_lookup(&state, Lookup { at_ms: now });

    if decision.changed {
        let reason = decision.reason.unwrap_or(REASON_LOOKUP_DEMOTION);
        let detail = lookup_detail(tx, book_id, reason, decision.lookups_in_window);
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
    for row in &rows {
        save_progress(
            tx,
            &row.id,
            decision.credit,
            &WordState {
                tier: decision.tier,
                credit: decision.credit,
                last_lookup_at_ms: Some(now),
                lookups_in_window: decision.lookups_in_window,
            },
            now,
        )?;
    }
    Ok(decision.changed)
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
/// most recently. Credit is not read: a lookup discards it either way.
fn load_chain(tx: &Transaction<'_>, rows: &[VocabTarget]) -> AppResult<WordState> {
    let mut chain = WordState::default();
    for row in rows {
        let state = load_progress(tx, &row.id)?;
        if state.last_lookup_at_ms > chain.last_lookup_at_ms {
            chain = state;
        }
    }
    Ok(chain)
}

/// The numbers `vocab.mastery.because.lookup_demotion.detail` and its repeat
/// variant interpolate. A missing book title degrades the sentence to the
/// plain variant rather than rendering a hole.
fn lookup_detail(
    tx: &Transaction<'_>,
    book_id: &str,
    reason: &str,
    lookups_in_window: u32,
) -> String {
    let mut detail = serde_json::Map::new();
    detail.insert("reason".to_string(), reason.to_string().into());
    if let Ok(Some(title)) = book_title(tx, book_id) {
        detail.insert("book_title".to_string(), title.into());
    }
    if reason == REASON_REPEAT_LOOKUP_DEMOTION {
        detail.insert("lookup_count".to_string(), lookups_in_window.into());
    }
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
                encounters: row.get(0)?,
                chapter_days: row.get(1)?,
                first_seen_at: row.get(2)?,
                last_seen_at: row.get(3)?,
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
                id: row.get(0)?,
                normalized_word: row.get(1)?,
                encounter_count: row.get(2)?,
                scored_encounter_count: row.get(3)?,
                lookup_active_count: row.get(4)?,
                scored_lookup_active_count: row.get(5)?,
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
            "SELECT credit, last_lookup_at, lookups_in_window
               FROM mastery_progress WHERE vocab_word_id = ?1",
            params![vocab_word_id],
            |row| {
                Ok(WordState {
                    tier: Tier::New,
                    credit: row.get(0)?,
                    last_lookup_at_ms: row.get(1)?,
                    lookups_in_window: row.get::<_, i64>(2)?.clamp(0, u32::MAX as i64) as u32,
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
            (vocab_word_id, credit, last_lookup_at, lookups_in_window, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(vocab_word_id) DO UPDATE SET
             credit = ?2, last_lookup_at = ?3, lookups_in_window = ?4, updated_at = ?5",
        params![
            vocab_word_id,
            credit,
            state.last_lookup_at_ms,
            i64::from(state.lookups_in_window),
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
