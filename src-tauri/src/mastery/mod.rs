//! Reading-driven mastery scoring — the arithmetic only.
//!
//! Design: `docs/impls/reading-driven-mastery-and-review.md` §2.1–§2.4.
//!
//! The SQLite side lives in [`crate::mastery::store`] (migration 039), which
//! is what `commands::reading_behavior` calls once a batch of screens has
//! been folded into `reading_word_exposures`. `#![allow(dead_code)]` still
//! covers the parts no pipeline reaches yet rather than deleting them: the
//! set of accessors a scoring pass needs is not final while the demotion
//! path is still being wired.
//!
//! ## Why this module holds no database handle
//!
//! Every rule here is a judgment call about *people*, not about storage:
//! how much a fifth re-read in one sitting is worth, how hard a lookup
//! should sting. Those are the numbers most likely to be re-tuned once real
//! reading data exists (§2.4 is explicit that the exclusion rules are a
//! starting point). Keeping them in plain functions over plain structs means
//! re-tuning is a test change, not a migration, and means the worked example
//! the product doc promises the user — "you read it 4 times across 3 days
//! and never looked it up" — is checkable in a unit test rather than by
//! staring at a database.
//!
//! ## The two directions
//!
//! **Up** ([`apply_exposures`]): a word on a screen the reader read and did
//! not look up is evidence they know it. Repeats inside the same chapter are
//! worth progressively less — massed repetition in one sitting does little
//! for long-term memory — but they are *never* worth zero. §2.2 is blunt
//! about why: a reader who worked through the word five times and sees the
//! number stand still has been told their effort did not count. The science
//! belongs in the slope, not in a gate on whether credit is granted at all.
//!
//! **Down** ([`apply_lookup`]): looking a word up says the promotion was
//! optimistic. It does not say the reader knows nothing — they may just have
//! been unsure. §2.3 refuses to distinguish those two cases up front,
//! because time distinguishes them for free: someone who genuinely does not
//! know the word will look it up again. So the first lookup costs exactly
//! one tier, and only a *repeat* inside the window drops the word all the
//! way back.
//!
//! ## Thresholds
//!
//! Credit accumulates against the word's current tier and resets to zero on
//! every tier change, so the numbers below are always "credit since the last
//! move", never a lifetime total:
//!
//! - New or Learning -> Familiar at [`FAMILIAR_CREDIT`] (4.0)
//! - Familiar -> Mastered at [`MASTERED_CREDIT`] (8.0)
//! - Mastered is the ceiling; further credit changes nothing.
//!
//! 4.0 is calibrated against the sentence the word-detail page will show
//! (`docs/impls/review-entry-mockup.html`): four first-in-chapter exposures
//! across three days are 4 x 1.0 and must land *exactly* on Familiar. Any
//! other value would make the app's own explanation of itself a lie.
//!
//! ## Exclusions
//!
//! §2.4 allows exactly two, both deliberately loose — missing one exposure
//! costs almost nothing, wrongly excluding a real reader costs a lot:
//!
//! 1. Screens read more than [`FAST_SCREEN_WPM_MULTIPLE`]x the reader's own
//!    median words-per-minute. The baseline is that reader's own median
//!    ([`median_words_per_minute`]), so a genuinely fast reader is never
//!    penalised for being fast.
//! 2. Long dwell with zero interaction (the reader walked away).
//!
//! **Both are applied upstream at write time**, in
//! `commands::reading_behavior` — see [`is_screen_too_fast`] and
//! `IDLE_SCREEN_MS`. That is not an accident of where the code went: the
//! aggregate rows this engine scores are per (book, chapter, word) totals, so
//! by the time an exposure reaches here there is no screen left to ask how
//! fast it was. The per-exposure knobs below ([`Exposure::screen_words_per_minute`],
//! [`ExposureBatch::reader_median_wpm`]) stay as the specification of the
//! rule; the pipeline passes `None` because the filter has already run where
//! the data still existed.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Weight of the 1st, 2nd, 3rd, 4th occurrence of a word within one
/// (book, chapter); every later occurrence is worth
/// [`TAIL_OCCURRENCE_WEIGHT`]. §2.2's table verbatim.
const OCCURRENCE_WEIGHTS: [f64; 4] = [1.0, 0.4, 0.2, 0.1];

/// The floor, and the point of the whole scheme: small, but never zero.
const TAIL_OCCURRENCE_WEIGHT: f64 = 0.05;

/// Total credit one (book, chapter) can ever contribute. Half of
/// [`FAMILIAR_CREDIT`] on purpose: no single chapter, however many times it
/// repeats a word, can carry it up a tier on its own. Promotion has to
/// survive the reader closing the book and coming back.
const CHAPTER_CREDIT_CAP: f64 = 2.0;

/// §2.4's one *upward* adjustment. A screen where the reader was actively
/// looking words up is a screen they demonstrably processed word by word,
/// so a word they skipped there is stronger evidence of knowing it than a
/// skip on a screen they may have merely glanced at.
const LOOKUP_ACTIVE_MULTIPLIER: f64 = 1.5;

/// New or Learning -> Familiar. See the module doc for why it is exactly 4.
const FAMILIAR_CREDIT: f64 = 4.0;

/// Familiar -> Mastered. Twice the first hop: claiming a reader has mastered
/// a word is the strongest claim this system makes without ever asking them.
const MASTERED_CREDIT: f64 = 8.0;

/// A screen faster than this multiple of the reader's own median words per
/// minute was skimmed, not read. Comparison is strictly greater, so a screen
/// sitting exactly on 3x still counts — every boundary in §2.4 breaks toward
/// including the reader.
const FAST_SCREEN_WPM_MULTIPLE: f64 = 3.0;

/// §2.3's "short term". Two lookups a fortnight apart are two separate
/// moments of not-quite-knowing; two in the same week are one unresolved
/// problem, and only the latter earns the hard drop.
const REPEAT_LOOKUP_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// The four mastery tiers, ordered weakest to strongest.
///
/// `Ord` follows the declaration order, which is what lets the promotion and
/// demotion paths compare tiers instead of matching on every pair. The
/// serialized form is the string stored in `vocab_words.mastery` (see
/// migration 038), so `Tier` and the database never drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    New,
    Learning,
    Familiar,
    Mastered,
}

impl Tier {
    /// The `vocab_words.mastery` string for this tier.
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::New => "new",
            Tier::Learning => "learning",
            Tier::Familiar => "familiar",
            Tier::Mastered => "mastered",
        }
    }

    /// Parse a `vocab_words.mastery` string.
    ///
    /// Returns `None` for anything else rather than defaulting to `New`: the
    /// column has no CHECK constraint (migrations 002/009), so an unexpected
    /// value means something upstream is wrong, and silently scoring such a
    /// word as brand new would quietly overwrite whatever it really was.
    pub fn from_db_str(value: &str) -> Option<Tier> {
        match value {
            "new" => Some(Tier::New),
            "learning" => Some(Tier::Learning),
            "familiar" => Some(Tier::Familiar),
            "mastered" => Some(Tier::Mastered),
            _ => None,
        }
    }

    /// Credit needed to leave this tier upward, or `None` at the ceiling.
    fn promotion_threshold(self) -> Option<f64> {
        match self {
            Tier::New | Tier::Learning => Some(FAMILIAR_CREDIT),
            Tier::Familiar => Some(MASTERED_CREDIT),
            Tier::Mastered => None,
        }
    }

    /// The tier reached by clearing [`Tier::promotion_threshold`].
    ///
    /// New promotes straight to Familiar rather than stepping through
    /// Learning: "learning" describes a word the reader is working on, and a
    /// word that earned 4.0 of reading credit without a single lookup was
    /// never being worked on.
    fn next_up(self) -> Tier {
        match self {
            Tier::New | Tier::Learning => Tier::Familiar,
            Tier::Familiar | Tier::Mastered => Tier::Mastered,
        }
    }

    /// One tier down, floored at Learning.
    ///
    /// Learning is the floor in both directions because New means "never
    /// assessed", and a word the reader just stopped to look up has
    /// demonstrably been assessed. That also makes New -> Learning the right
    /// answer for a lookup on an untracked word, which is what the rest of
    /// the app already does when a lookup files a word into the vocab list.
    fn next_down(self) -> Tier {
        match self {
            Tier::Mastered => Tier::Familiar,
            Tier::Familiar | Tier::Learning | Tier::New => Tier::Learning,
        }
    }
}

/// Reason codes written to `mastery_events.reason` (migration 038). Machine
/// readable and stable; never display text — user-facing strings are i18n
/// keys.
pub const REASON_EXPOSURE_PROMOTION: &str = "exposure_promotion";
pub const REASON_LOOKUP_DEMOTION: &str = "lookup_demotion";
pub const REASON_REPEAT_LOOKUP_DEMOTION: &str = "repeat_lookup_demotion";

/// One screen on which the word was visible and *not* looked up.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exposure {
    /// 1-based: the nth time this word has been seen in this (book, chapter).
    /// Drives the decay in [`OCCURRENCE_WEIGHTS`]. The caller derives it from
    /// `reading_word_exposures.encounter_count`; 0 is treated as 1 rather
    /// than as a free 0.05, since an off-by-one in the caller should not cost
    /// the reader their strongest exposure.
    pub chapter_occurrence: u32,
    /// The reader was looking words up on this screen (but not this word).
    /// Worth [`LOOKUP_ACTIVE_MULTIPLIER`]x — see the module doc.
    pub on_lookup_active_screen: bool,
    /// Reading pace for this screen, used only by the too-fast exclusion.
    pub screen_words_per_minute: f64,
}

/// Every exposure a word accrued in **one** (book, chapter).
///
/// The grouping is in the type because [`CHAPTER_CREDIT_CAP`] is per
/// chapter: handed a flat list, this module could not tell a word read
/// twenty times in one chapter from a word read once in twenty chapters —
/// which is the entire distinction §2.2 exists to draw.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterExposures {
    /// Applied in the order given. Order only decides which exposures the
    /// cap clips, since the weight comes from `chapter_occurrence`, not from
    /// the position in this vector.
    pub exposures: Vec<Exposure>,
}

impl ChapterExposures {
    pub fn new(exposures: Vec<Exposure>) -> Self {
        Self { exposures }
    }
}

/// Everything [`apply_exposures`] needs about one scoring run.
///
/// The reader's median pace lives here rather than on [`Exposure`] because
/// it is a property of the reader, not of a screen — bundling it with the
/// chapters makes it impossible to score a batch while forgetting the
/// baseline the too-fast filter is measured against.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposureBatch {
    /// From [`median_words_per_minute`]. `None` means this reader has no
    /// usable pace history yet, in which case the too-fast filter is skipped
    /// entirely: with no baseline there is no such thing as "too fast", and
    /// §2.4 would rather over-count than exclude a reader.
    pub reader_median_wpm: Option<f64>,
    pub chapters: Vec<ChapterExposures>,
}

/// A lookup the reader performed on the word.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    pub at_ms: i64,
}

/// The word's stored mastery state, as the caller reads it out of
/// `vocab_words` before scoring.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordState {
    pub tier: Tier,
    /// Credit accrued *since the last tier change*, never a lifetime total.
    pub credit: f64,
    /// When the previous lookup happened. The repeat window is measured from
    /// this, not from the first lookup in the chain, so a reader who keeps
    /// checking a word every few days stays inside one chain.
    pub last_lookup_at_ms: Option<i64>,
    /// How many lookups the current chain has already accumulated. Reset by
    /// any lookup that falls outside the window.
    pub lookups_in_window: u32,
}

impl Default for WordState {
    fn default() -> Self {
        Self {
            tier: Tier::New,
            credit: 0.0,
            last_lookup_at_ms: None,
            lookups_in_window: 0,
        }
    }
}

impl WordState {
    pub fn new(tier: Tier, credit: f64) -> Self {
        Self {
            tier,
            credit,
            ..Self::default()
        }
    }
}

/// What the caller should persist, plus whether the change is worth telling
/// the reader about.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub tier: Tier,
    pub credit: f64,
    /// The tier moved. Credit alone changing is not "changed" — §2.6 promises
    /// the reader a timeline of *tier* moves, and a row per exposure would
    /// bury it.
    pub changed: bool,
    /// `Some` exactly when `changed` — a `mastery_events` row is owed only
    /// for a tier move. §2.6 promises the reader a timeline of rises and
    /// falls, and Learning is where most of their words sit: recording every
    /// lookup that found a word already at the floor would bury the handful
    /// of rows that say something under rows that say nothing happened.
    pub reason: Option<&'static str>,
    /// This word has now been looked up three or more times inside the
    /// repeat window: a blocker for its book (§2.3). The review pile reads
    /// this; nothing here acts on it.
    pub is_book_blocker: bool,
    /// Persist alongside the lookup timestamp — the next call needs it to
    /// know where in the chain it lands.
    pub lookups_in_window: u32,
}

impl Decision {
    fn unchanged(state: &WordState) -> Self {
        Self {
            tier: state.tier,
            credit: state.credit,
            changed: false,
            reason: None,
            is_book_blocker: false,
            lookups_in_window: state.lookups_in_window,
        }
    }
}

fn weight_for_occurrence(occurrence: u32) -> f64 {
    let index = occurrence.max(1) as usize - 1;
    OCCURRENCE_WEIGHTS
        .get(index)
        .copied()
        .unwrap_or(TAIL_OCCURRENCE_WEIGHT)
}

/// The too-fast exclusion. Non-finite or non-positive paces are *not*
/// excluded: an unmeasurable screen is a data problem, and §2.4 says data
/// problems break toward the reader.
fn exceeds_pace_limit(words_per_minute: f64, median_wpm: Option<f64>) -> bool {
    let Some(median) = median_wpm.filter(|m| m.is_finite() && *m > 0.0) else {
        return false;
    };
    words_per_minute.is_finite() && words_per_minute > median * FAST_SCREEN_WPM_MULTIPLE
}

fn is_too_fast(exposure: &Exposure, median_wpm: Option<f64>) -> bool {
    exceeds_pace_limit(exposure.screen_words_per_minute, median_wpm)
}

/// Whether one finished screen was read too fast for the words on it to count
/// as evidence — the same §2.4 rule as [`is_too_fast`], asked of a screen
/// rather than of an exposure.
///
/// This is the form the write path uses, because a screen is the last place
/// the pace is still knowable: `reading_word_exposures` aggregates away which
/// screen each encounter came from. A screen with no words or no measurable
/// dwell has no pace and is never excluded.
pub fn is_screen_too_fast(screen: ScreenPace, reader_median_wpm: Option<f64>) -> bool {
    if screen.word_count <= 0 || screen.dwell_ms <= 0 {
        return false;
    }
    let wpm = screen.word_count as f64 * 60_000.0 / screen.dwell_ms as f64;
    exceeds_pace_limit(wpm, reader_median_wpm)
}

/// Score a batch of not-looked-up exposures for one word.
///
/// Exposures are applied one at a time rather than summed, so a batch large
/// enough to cross two thresholds promotes twice — and so the credit reset
/// on promotion discards the leftover, exactly as it would have if the
/// reader had flushed the screens one by one instead of in one batch. The
/// result must not depend on how the frontend happened to group its writes.
pub fn apply_exposures(state: &WordState, batch: &ExposureBatch) -> Decision {
    let mut tier = state.tier;
    let mut credit = state.credit;
    let mut changed = false;

    for chapter in &batch.chapters {
        let mut from_this_chapter = 0.0f64;
        for exposure in &chapter.exposures {
            if tier == Tier::Mastered {
                // The ceiling: no threshold left to cross, so accruing more
                // credit would only be bookkeeping the reader never sees.
                break;
            }
            if is_too_fast(exposure, batch.reader_median_wpm) {
                continue;
            }
            let mut gain = weight_for_occurrence(exposure.chapter_occurrence);
            if exposure.on_lookup_active_screen {
                gain *= LOOKUP_ACTIVE_MULTIPLIER;
            }
            // The cap applies to what the chapter actually contributes, so
            // the 1.5x boost is inside it. A boosted chapter reaches the cap
            // sooner; it does not get a bigger one.
            gain = gain.min(CHAPTER_CREDIT_CAP - from_this_chapter);
            if gain <= 0.0 {
                break;
            }
            from_this_chapter += gain;
            credit += gain;

            if let Some(threshold) = tier.promotion_threshold() {
                if credit >= threshold {
                    tier = tier.next_up();
                    credit = 0.0;
                    changed = true;
                }
            }
        }
    }

    Decision {
        tier,
        credit,
        changed,
        reason: changed.then_some(REASON_EXPOSURE_PROMOTION),
        is_book_blocker: false,
        lookups_in_window: state.lookups_in_window,
    }
}

/// Apply one lookup: the reader stopped and asked what this word means.
///
/// §2.3's ladder, in order — one tier for the first, all the way back to
/// Learning for a second inside [`REPEAT_LOOKUP_WINDOW_MS`], and a blocker
/// flag from the third on. Credit resets on every lookup regardless of
/// whether the tier moved: credit is evidence the reader knew the word, and
/// a lookup is the reader saying otherwise.
pub fn apply_lookup(state: &WordState, lookup: Lookup) -> Decision {
    let within_window = state
        .last_lookup_at_ms
        .is_some_and(|previous| lookup.at_ms.saturating_sub(previous) <= REPEAT_LOOKUP_WINDOW_MS);
    let chain = if within_window {
        state.lookups_in_window.saturating_add(1)
    } else {
        1
    };

    let (tier, reason, is_book_blocker) = match chain {
        1 => (state.tier.next_down(), REASON_LOOKUP_DEMOTION, false),
        2 => (Tier::Learning, REASON_REPEAT_LOOKUP_DEMOTION, false),
        // Third and beyond: already at the floor, so the only thing left to
        // record is that this word keeps stopping the reader in this book.
        // That is `is_book_blocker`, and it needs no timeline row — the
        // caller is already persisting `lookups_in_window` next to the lookup
        // timestamp, which is the same fact.
        _ => (Tier::Learning, REASON_REPEAT_LOOKUP_DEMOTION, true),
    };
    let changed = tier != state.tier;

    Decision {
        tier,
        credit: 0.0,
        changed,
        reason: changed.then_some(reason),
        is_book_blocker,
        lookups_in_window: chain,
    }
}

/// One finalized screen's raw pace inputs, straight from the
/// `reading_screen_dwells` columns of the same name.
///
/// A named pair rather than a tuple because two `i64`s in either order
/// compile fine and produce a silently wrong baseline.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPace {
    pub word_count: i64,
    pub dwell_ms: i64,
}

/// The reader's own median words-per-minute across their screens.
///
/// Median, not mean: one screen left open over lunch or one page turned by
/// accident would drag a mean far enough to change who gets excluded, and
/// this number's only job is to be a stable picture of *this* reader.
///
/// Screens with no words or no measurable dwell are dropped — they have no
/// pace to contribute. Returns `None` when nothing usable is left, which
/// callers must read as "run no speed filter", not as a median of zero.
pub fn median_words_per_minute(screens: &[ScreenPace]) -> Option<f64> {
    let mut paces: Vec<f64> = screens
        .iter()
        .filter(|screen| screen.word_count > 0 && screen.dwell_ms > 0)
        .map(|screen| screen.word_count as f64 * 60_000.0 / screen.dwell_ms as f64)
        .collect();
    if paces.is_empty() {
        return None;
    }
    paces.sort_by(f64::total_cmp);
    let middle = paces.len() / 2;
    if paces.len().is_multiple_of(2) {
        Some((paces[middle - 1] + paces[middle]) / 2.0)
    } else {
        Some(paces[middle])
    }
}

pub mod store;

#[cfg(test)]
mod tests;
