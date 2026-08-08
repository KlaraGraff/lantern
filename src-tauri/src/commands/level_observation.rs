//! The level observation row: the reader's declared CEFR level held up
//! against what their own lookup record shows, once, at the bottom of the
//! reading-stats page.
//!
//! Design: `docs/impls/reading-driven-mastery-and-review.md` §6 and §7, plus
//! the frontend contract in `src/pages/reading-stats/level-observation.ts`.
//!
//! Three properties this module owes the rest of the app, in the order they
//! matter:
//!
//! - **It never writes `cefr_level`.** §7's whole point: the declared level
//!   decides how deeply the AI explains things, which the reader feels
//!   immediately, so it moves only when they press something. The frontend
//!   does that write itself, through `set_setting`. There is no code path
//!   here that touches the setting — only a read of it.
//! - **Silence is the normal answer.** `get_level_observation` returning
//!   `None` is the common case, not an error. Nobody asked for this row; it
//!   has to earn its place on the page every time it appears.
//! - **Category B evidence, therefore strong evidence.** §6 grades the seven
//!   dimensions by what it costs to be wrong. This row produces a claim
//!   about *the person*, whose failure mode is every AI explanation
//!   afterwards being pitched wrong — so the thresholds below are set where
//!   a thin or ambiguous record produces `unclear` or nothing, never a
//!   guess.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::commands::level_word_class::{self, Candidate, WordClass};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;
use crate::word_frequency::{band_rank_window, lookup_with, FormIndex};

const DAY_MS: i64 = 86_400_000;

/// How far back the record is read. Three months is the same span §7 gives
/// the suppression window, and that pairing is deliberate: a remark the
/// reader dismissed should not come back until the evidence behind it has
/// had time to be replaced rather than merely extended.
const WINDOW_DAYS: i64 = 90;

/// How long a "keep" or "apply" silences *that same remark*. §7: 拒绝一次就
/// 长期闭嘴（三个月）.
const SUPPRESSION_DAYS: i64 = 90;

// ---------------------------------------------------------------------------
// Thresholds.
//
// The floor first: below it there is no row at all, of any kind. `unclear`
// is a conclusion about a record that exists and cannot be read; it is not
// the answer to "there is barely a record". Saying "your record cannot tell
// us anything" to someone who has looked up four words is not an
// observation about them, it is an observation about the app being new, and
// they can see that themselves.
//
// The two floor conditions are one condition seen from two sides — enough
// lookups, over enough time — because either one alone is trivially cleared
// by an unrepresentative afternoon.
//
// There is deliberately no floor on *chapters*. One used to sit here, and it
// was a silent exclusion: a reader whose books carry no chapter labels (many
// PDFs, plain text) never saw the row and had no way to find out why. A bar
// nobody can see they failed is worse than no bar.
// ---------------------------------------------------------------------------

/// Lookups the frequency table could actually score. Unscorable lookups
/// (character names, invented words) are excluded from the count as well as
/// from the bands, so a reader who mostly taps proper nouns does not clear
/// the floor on evidence that carries no band information at all.
const MIN_SCORABLE_LOOKUPS: i64 = 12;

/// Days between the oldest lookup in the window and now. A single weekend
/// binge is not three months of evidence, however many lookups it holds.
const MIN_SPAN_DAYS: i64 = 14;

// The strong-evidence bars, all of which sit well above the floor.

/// Neither `declaredHigh` nor `declaredLow` may be claimed on fewer than
/// this many scorable lookups. `declaredLow` needs it as much as
/// `declaredHigh` does, and for a less obvious reason: its evidence is words
/// the reader did *not* look up, which only means anything about them if
/// they demonstrably do look words up. Against an empty lookup record,
/// "read past 200 hard words" is indistinguishable from "never stops for
/// anything".
const STRONG_MIN_LOOKUPS: i64 = 40;

/// `declaredHigh`: how many lookups must sit in the one easy band, and what
/// share of all scorable lookups they must be. 55% is chosen so the band is
/// unambiguously *the* band — a plurality could be 30% of a flat spread,
/// which is not concentration.
///
/// The share is measured against the reader's own record, which is the only
/// fair denominator available: the alternative, a rate per chapter, implies
/// a norm they are being compared to, and no such norm exists to publish.
const HIGH_MIN_BAND_LOOKUPS: i64 = 25;
const HIGH_MIN_BAND_SHARE: f64 = 0.55;

/// `declaredLow`: distinct words in the hard band read past twice or more
/// without ever being looked up, and what share of the reader's encounters
/// with that band those are. 75% rather than something near-total because a
/// reader genuinely comfortable in a band still stops at a few words in it.
const LOW_MIN_PASSED_WORDS: i64 = 60;
const LOW_MIN_PASSED_SHARE: f64 = 0.75;

/// `unclear`: the record is lopsided — one hard band holds the lookups and
/// bands 1–3 hold almost nothing. That is the exact shape the UI's sentence
/// describes ("Bands 1 through 3 have almost no record — either you know
/// those words, or the books you happened to read had few hard ones"), and
/// it is also the shape that genuinely cannot be read: the two explanations
/// leave identical traces.
const UNCLEAR_MIN_BAND_SHARE: f64 = 0.55;
const UNCLEAR_MAX_EASY_SHARE: f64 = 0.10;

// ---------------------------------------------------------------------------
// Topical-word screening.
//
// A specialized book drags a trail of its own terminology through the lookup
// record — a sailing novel's rigging, a cookbook's techniques — and those
// lookups leave the same trace as a genuine vocabulary gap. The screen below
// separates the two with evidence the app already has: a word that one book
// keeps using and no other book touches is that book's vocabulary, not a
// sample of general English, and it is excluded from every count the
// judgment reads. Excluded, and reported: the sentences on screen quote
// totals as a receipt the reader can check, so the count of screened-out
// lookups travels with the observation instead of silently shrinking it.
//
// The default runs the other way — a word the screen cannot positively
// convict stays general. A reader whose books never produce exposure rows
// (or whose lookups sit in bands 1–2) gets exactly today's behavior.
// ---------------------------------------------------------------------------

/// No word in bands 1–2 is ever called topical. Common words recur in every
/// book, so recurrence carries no signal there — and the one case that
/// would need it, a common word in a specialized sense ("deck", "bow"),
/// needs sense information this module does not have. Past rank 3 000 the
/// arithmetic turns over: Zipf puts a rank-3 000 word at roughly two
/// occurrences per hundred thousand words of running text, so a single book
/// using one six times is multiples past expectation.
const TOPICAL_MIN_BAND: u8 = 3;

/// In-window sightings (viewport exposures, summed across a word's books)
/// before recurrence means anything. Below this a hard word seen a couple
/// of times is just a hard word the book happened to contain.
const TOPICAL_MIN_SIGHTINGS: i64 = 6;

/// How much of that sighting total one book must hold. A word a reader
/// meets across their shelf is their vocabulary problem, not any single
/// book's subject matter.
const TOPICAL_TOP_BOOK_SHARE: f64 = 0.8;

// ---------------------------------------------------------------------------
// Word-class mode.
//
// The heuristic above sees recurrence; it cannot see meaning. In AI mode
// (the `level_observation_word_class` setting, default on) each hard word
// is also put to the reader's configured AI — word plus book title, nothing
// else — and a cached AI verdict *replaces* the heuristic for that word, in
// either direction: "general" keeps a word the heuristic would have
// screened, "topical" screens a word the heuristic would have kept.
// Classification runs detached after the page is served
// (`level_word_class.rs`); words not yet judged fall back to the heuristic,
// so the row never waits on the network and never changes because of a
// *failed* call — only because of an answered one.
//
// Local mode — chosen in settings, or forced when no AI is configured — is
// exactly the pre-AI behavior: heuristic only, nothing sent anywhere. The
// observation reports which mode actually produced it (`wordClassSource`)
// so the fine print on screen can tell the truth either way.
// ---------------------------------------------------------------------------

/// Which classifier the observation actually used. Serialized onto the wire
/// (`"ai"` / `"local"`) for the fine print's benefit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WordClassSource {
    Ai,
    Local,
}

fn word_class_mode(conn: &Connection, ai_available: bool) -> AppResult<WordClassSource> {
    if !ai_available {
        return Ok(WordClassSource::Local);
    }
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'level_observation_word_class'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(if raw.as_deref() == Some("local") {
        WordClassSource::Local
    } else {
        WordClassSource::Ai
    })
}

/// The six levels the settings UI offers, ascending. Mirrors
/// `src/components/settings/cefr.ts`.
const LEVELS: [&str; 6] = ["A1", "A2", "B1", "B2", "C1", "C2"];

/// `cefr_level` is never seeded; B1 is the frontend's default too.
const DEFAULT_LEVEL: &str = "B1";

/// The frequency band a level is expected to be working *in* — the band
/// whose words that reader should still sometimes need. Below it is
/// vocabulary the level implies they already have; above it is vocabulary
/// the level implies should stop them.
///
/// C1 and C2 share band 5 because the table has no sixth band: past rank
/// 20 000 there is nothing rarer to distinguish them with, so this module
/// cannot tell a C1 from a C2 and does not pretend to.
fn band_of_level(level: &str) -> u8 {
    match level {
        "A1" => 1,
        "A2" => 2,
        "B1" => 3,
        "B2" => 4,
        _ => 5,
    }
}

/// The inverse: the level whose own band this is. Band 5 maps to C1, not
/// C2 — C2 is never suggested by this row, because no evidence available
/// here can distinguish it from C1 (see [`band_of_level`]).
fn level_for_band(band: u8) -> &'static str {
    match band {
        1 => "A1",
        2 => "A2",
        3 => "B1",
        4 => "B2",
        _ => "C1",
    }
}

fn normalize_level(raw: Option<String>) -> String {
    raw.map(|value| value.trim().to_uppercase())
        .filter(|value| LEVELS.contains(&value.as_str()))
        .unwrap_or_else(|| DEFAULT_LEVEL.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LevelObservationKind {
    Unclear,
    DeclaredHigh,
    DeclaredLow,
}

impl LevelObservationKind {
    fn as_db(self) -> &'static str {
        match self {
            Self::Unclear => "unclear",
            Self::DeclaredHigh => "declaredHigh",
            Self::DeclaredLow => "declaredLow",
        }
    }
}

/// Field for field, in name and nullability, `interface LevelObservation` in
/// `src/pages/reading-stats/level-observation.ts`. `serialized_keys_match_the_frontend_contract`
/// below pins the wire names so a Rust-side rename cannot silently blank the
/// row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelObservation {
    pub kind: LevelObservationKind,
    pub declared_level: String,
    /// Always `None` for `Unclear`: there is nothing to press when the
    /// conclusion is that the record cannot be read.
    pub suggested_level: Option<String>,
    pub band: Option<u8>,
    pub band_from: Option<u32>,
    pub band_to: Option<u32>,
    /// `declaredLow`: distinct words in that band read past twice or more.
    pub passed_words: Option<i64>,
    /// `declaredHigh` and `unclear`, with the same meaning in both: every
    /// scorable lookup in the window, and how many of them sit in the band
    /// named above. Counts, not rates — the number in the sentence is the
    /// receipt that makes the remark checkable against the reader's own
    /// record, and a rate would instead imply a norm they are being measured
    /// against that this app has no business inventing.
    pub total_lookups: Option<i64>,
    pub concentrated_lookups: Option<i64>,
    /// Lookups screened out as one book's own terminology (see the
    /// topical-word section above) — set alongside `total_lookups`, because
    /// the moment lookups are screened out, `total_lookups` stops matching
    /// the count the reader could make themselves, and the receipt only
    /// stays a receipt if the difference is stated.
    pub topical_lookups: Option<i64>,
    pub window_days: i64,
    /// Which classifier separated topical words from general ones for this
    /// observation — `Ai` when the AI mode was in effect (even if some words
    /// were still waiting on a verdict), `Local` otherwise. The fine print
    /// keys off this: the "nothing leaves this machine" sentence is only
    /// shown when it is true.
    pub word_class_source: WordClassSource,
}

/// What the two commands read out of the database before anything is judged.
/// Separated from the judgment so the thresholds can be tested against
/// hand-built records without a database.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RecordSummary {
    /// Scorable lookups in the window, indexed by band (0 unused).
    lookups_by_band: [i64; 6],
    /// Distinct words looked up in the window, by band — the denominator
    /// `passed_by_band` is weighed against.
    looked_up_words_by_band: [i64; 6],
    /// Distinct words in the window seen twice or more, at least once on a
    /// screen where the reader *did* look something else up, and never
    /// looked up themselves. The lookup-active condition is what makes this
    /// evidence rather than noise: the reader had the dictionary open on
    /// that screen and still walked past this word.
    passed_by_band: [i64; 6],
    /// Scorable lookup rows screened out as topical. Counted in rows, like
    /// `lookups_by_band`, so the two speak the same register on screen.
    topical_lookups: i64,
    /// Days from the oldest *kept* lookup in the window to now, clamped
    /// into 1..=WINDOW_DAYS. Topical lookups don't stretch the span: the
    /// record being judged is the general-word record, and its duration is
    /// measured on its own rows.
    span_days: i64,
}

impl RecordSummary {
    fn total_lookups(&self) -> i64 {
        self.lookups_by_band.iter().sum()
    }

    /// The band holding the most lookups. Ties break towards the harder
    /// band, which is the conservative direction: it makes `declaredHigh`
    /// (the claim that the reader is stuck on easy words) harder to reach.
    fn modal_band(&self) -> Option<u8> {
        (1u8..=5)
            .filter(|band| self.lookups_by_band[*band as usize] > 0)
            .max_by_key(|band| (self.lookups_by_band[*band as usize], *band))
    }

    fn share_of(&self, count: i64) -> f64 {
        let total = self.total_lookups();
        if total <= 0 {
            return 0.0;
        }
        count as f64 / total as f64
    }
}

fn clear_of_floor(record: &RecordSummary) -> bool {
    record.total_lookups() >= MIN_SCORABLE_LOOKUPS && record.span_days >= MIN_SPAN_DAYS
}

/// How widely a word was sighted, summed per book over the window.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct BookSpread {
    /// Viewport sightings across every book.
    total: i64,
    /// The largest single book's share of that total.
    top: i64,
    /// Which book that is — the context book an AI verdict for a read-past
    /// word is looked up (and asked for) under.
    top_book: Option<String>,
}

impl BookSpread {
    fn add(&mut self, book: &str, sightings: i64) {
        self.total += sightings;
        if sightings > self.top {
            self.top = sightings;
            self.top_book = Some(book.to_string());
        }
    }
}

/// Is this word one book's own vocabulary rather than a sample of general
/// English? The three conditions are the three consts above; the default on
/// any missing evidence is `false` — general — which is the direction that
/// leaves today's behavior intact.
fn is_topical(band: u8, sightings: Option<&BookSpread>, looked_up_in_books: usize) -> bool {
    if band < TOPICAL_MIN_BAND || looked_up_in_books >= 2 {
        return false;
    }
    let Some(spread) = sightings else {
        return false;
    };
    spread.total >= TOPICAL_MIN_SIGHTINGS
        && spread.top as f64 / spread.total as f64 >= TOPICAL_TOP_BOOK_SHARE
}

/// One word's class under the mode in effect, plus — in AI mode — the
/// candidate to classify if no verdict exists yet.
///
/// The hard gates come first and hold in both modes: bands 1–2 are never
/// topical (see [`TOPICAL_MIN_BAND`]), and a word looked up in two
/// different books is the reader's own gap whatever any one book is about.
/// The AI is never even asked about those. Inside the gates, a cached AI
/// verdict replaces the heuristic outright — in either direction — and a
/// missing verdict falls back to the heuristic while nominating the word
/// for the next detached classification pass.
fn classify(
    mode: WordClassSource,
    verdicts: &HashMap<(String, String), WordClass>,
    word: &str,
    context_book: Option<&str>,
    band: u8,
    sightings: Option<&BookSpread>,
    looked_up_in_books: usize,
) -> (bool, Option<Candidate>) {
    if band < TOPICAL_MIN_BAND || looked_up_in_books >= 2 {
        return (false, None);
    }
    let heuristic = is_topical(band, sightings, looked_up_in_books);
    if mode == WordClassSource::Local {
        return (heuristic, None);
    }
    let Some(book) = context_book else {
        return (heuristic, None);
    };
    match verdicts.get(&(word.to_string(), book.to_string())) {
        Some(verdict) => (*verdict == WordClass::Topical, None),
        None => (
            heuristic,
            Some(Candidate {
                word: word.to_string(),
                book_id: book.to_string(),
            }),
        ),
    }
}

fn with_band(mut observation: LevelObservation, band: u8) -> LevelObservation {
    let window = band_rank_window(band);
    observation.band = Some(band);
    observation.band_from = window.map(|(from, _)| from);
    observation.band_to = window.map(|(_, to)| to);
    observation
}

/// The whole judgment, and the only place any of it lives.
///
/// Order matters. `declaredHigh` is tested first because its failure mode is
/// the worse of the two: a reader whose level is set above where they read
/// is being handed explanations pitched over their head, every time, and
/// they have no way to know that is why. `declaredLow` costs them only some
/// wordiness. When a record somehow supports both, the more expensive
/// mistake gets named.
fn judge(record: &RecordSummary, declared: &str) -> Option<LevelObservation> {
    if !clear_of_floor(record) {
        return None;
    }

    let declared_band = band_of_level(declared);
    let total = record.total_lookups();
    let base = LevelObservation {
        kind: LevelObservationKind::Unclear,
        declared_level: declared.to_string(),
        suggested_level: None,
        band: None,
        band_from: None,
        band_to: None,
        passed_words: None,
        total_lookups: None,
        concentrated_lookups: None,
        topical_lookups: None,
        window_days: record.span_days,
        // A placeholder: the judgment doesn't know which classifier fed it.
        // `get_level_observation_inner` stamps the real source before the
        // observation leaves this module.
        word_class_source: WordClassSource::Local,
    };

    if total >= STRONG_MIN_LOOKUPS {
        // declaredHigh — looking up words the declared level says should not
        // need looking up. The band has to be strictly easier than the
        // level's own band; lookups *in* the level's band are what reading
        // at your level looks like.
        if let Some(band) = record.modal_band() {
            let in_band = record.lookups_by_band[band as usize];
            if band < declared_band
                && in_band >= HIGH_MIN_BAND_LOOKUPS
                && record.share_of(in_band) >= HIGH_MIN_BAND_SHARE
            {
                return Some(with_band(
                    LevelObservation {
                        kind: LevelObservationKind::DeclaredHigh,
                        suggested_level: Some(level_for_band(band).to_string()),
                        // The same two counts `unclear` reports, meaning the
                        // same two things. All three kinds speak in one
                        // register, and the reader can check any of them
                        // against a record they own.
                        total_lookups: Some(total),
                        concentrated_lookups: Some(in_band),
                        topical_lookups: Some(record.topical_lookups),
                        ..base
                    },
                    band,
                ));
            }
        }

        // declaredLow — reading past words the declared level says should
        // have stopped them. §5.3: the hardest single indicator is the
        // hardest words they get through without stopping, so the hardest
        // qualifying band wins rather than the first one found.
        for band in (declared_band + 1..=5).rev() {
            let passed = record.passed_by_band[band as usize];
            let stopped_at = record.looked_up_words_by_band[band as usize];
            let encountered = passed + stopped_at;
            let share = if encountered > 0 {
                passed as f64 / encountered as f64
            } else {
                0.0
            };
            if passed >= LOW_MIN_PASSED_WORDS && share >= LOW_MIN_PASSED_SHARE {
                return Some(with_band(
                    LevelObservation {
                        kind: LevelObservationKind::DeclaredLow,
                        suggested_level: Some(level_for_band(band).to_string()),
                        passed_words: Some(passed),
                        ..base
                    },
                    band,
                ));
            }
        }
    }

    // unclear — the record exists, and it is lopsided in the one way that
    // cannot be read: everything the reader stopped for sits in a hard band,
    // and the easy bands are all but empty. "They know those words" and
    // "the books they picked had few hard ones" leave the same trace, and no
    // amount of more of this record separates them.
    if let Some(band) = record.modal_band() {
        let in_band = record.lookups_by_band[band as usize];
        let easy: i64 = record.lookups_by_band[1..=3].iter().sum();
        if band >= 4
            && record.share_of(in_band) >= UNCLEAR_MIN_BAND_SHARE
            && record.share_of(easy) <= UNCLEAR_MAX_EASY_SHARE
        {
            return Some(with_band(
                LevelObservation {
                    kind: LevelObservationKind::Unclear,
                    total_lookups: Some(total),
                    concentrated_lookups: Some(in_band),
                    topical_lookups: Some(record.topical_lookups),
                    ..base
                },
                band,
            ));
        }
    }

    // Everything else: a record that reads as ordinary. The declared level
    // and the lookups agree, or they disagree too weakly to say so. Nothing
    // to remark on, so nothing appears.
    None
}

// ---------------------------------------------------------------------------
// Reading the record.
// ---------------------------------------------------------------------------

fn declared_level(conn: &Connection) -> AppResult<String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'cefr_level'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(normalize_level(raw))
}

/// The rows the judgment is built from, before any of them are scored
/// against the frequency table.
///
/// Collected as one step and scored as another because scoring is not
/// allowed to happen under the read lock: [`FormIndex`] takes `db.reader()`
/// itself the first time a word misses the table, and `std::sync::Mutex` is
/// not reentrant — doing both at once deadlocks the app on a word the table
/// has never heard of, which in a novel is a character's name.
#[derive(Debug, Default)]
struct RawRecord {
    /// `(normalized word, book, when)` — one entry per lookup row in the
    /// window. The book is there for the topical screen's second condition:
    /// a word looked up in two different books is nobody's terminology.
    window_lookups: Vec<(String, String, i64)>,
    /// Words already filtered down to "read past": seen twice or more, at
    /// least once on a lookup-active screen, never looked up anywhere.
    passed_candidates: Vec<String>,
    /// Every word's in-window viewport sightings, summed per book and
    /// collapsed to (total, largest book) — the topical screen's evidence.
    sightings: HashMap<String, BookSpread>,
    /// Cached AI verdicts, keyed by (word, context book). Loaded only in AI
    /// mode; empty in local mode, which makes every cache probe miss and
    /// the heuristic decide everything — exactly local behavior.
    verdicts: HashMap<(String, String), WordClass>,
}

fn collect(conn: &Connection, now: i64, mode: WordClassSource) -> AppResult<RawRecord> {
    let since = now - WINDOW_DAYS * DAY_MS;
    let mut raw = RawRecord::default();

    if mode == WordClassSource::Ai {
        raw.verdicts = level_word_class::cached_verdicts(conn)?;
    }

    // Every word ever looked up, in any book. A word the reader once
    // stopped for is not a word they read past, even if the stop predates
    // the window — so this deliberately ignores the window and only ever
    // shrinks the `passed` set.
    let mut ever_looked_up: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare("SELECT DISTINCT normalized_text FROM lookup_records")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for word in rows {
            ever_looked_up.insert(word?);
        }
    }

    // Lookups in the window. One row is one word looked up at one position;
    // `lookup_count` (the same word re-tapped at the same spot) is
    // deliberately not summed — the question here is how widely the reader
    // reaches for the dictionary, not how forgetful they are, which is
    // §5.4's dimension and a different row.
    {
        let mut stmt = conn.prepare(
            "SELECT normalized_text, book_id, last_looked_up_at FROM lookup_records \
             WHERE last_looked_up_at >= ?1",
        )?;
        let rows = stmt.query_map(params![since], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            raw.window_lookups.push(row?);
        }
    }

    // Sightings per (word, book), for the topical screen. Same window
    // filter as the passed-words query below, and the same approximation:
    // an exposure row aggregates a chapter, so `last_seen_at` admits the
    // whole row once its newest sighting is inside the window.
    {
        let mut stmt = conn.prepare(
            "SELECT normalized_word, book_id, SUM(encounter_count) FROM reading_word_exposures \
             WHERE last_seen_at >= ?1 GROUP BY normalized_word, book_id",
        )?;
        let rows = stmt.query_map(params![since], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (word, book, in_book) = row?;
            raw.sightings.entry(word).or_default().add(&book, in_book);
        }
    }

    // Nothing here counts chapters. Every number this module reports is a
    // count of lookups or of words, measured against the reader's own
    // record; there is no per-chapter rate left to need a denominator.
    //
    // Words read past. Aggregated across books and chapters first: the same
    // word met once in three different chapters is a word met three times.
    {
        let mut stmt = conn.prepare(
            "SELECT normalized_word, SUM(encounter_count), SUM(encounters_on_lookup_active_screen) \
             FROM reading_word_exposures WHERE last_seen_at >= ?1 GROUP BY normalized_word",
        )?;
        let rows = stmt.query_map(params![since], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (word, encounters, on_lookup_active) = row?;
            if encounters < 2 || on_lookup_active < 1 || ever_looked_up.contains(&word) {
                continue;
            }
            raw.passed_candidates.push(word);
        }
    }

    Ok(raw)
}

/// Score the collected rows against the frequency table. Must be called
/// with no read guard held — see [`RawRecord`]. Returns the summary plus,
/// in AI mode, the words that still need a verdict — the detached pass's
/// work list.
fn score(
    raw: &RawRecord,
    db: &Db,
    now: i64,
    mode: WordClassSource,
) -> AppResult<(RecordSummary, Vec<Candidate>)> {
    let forms = FormIndex::new(db);
    let mut summary = RecordSummary::default();
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut nominated: HashSet<(String, String)> = HashSet::new();
    let mut nominate = |candidate: Option<Candidate>, candidates: &mut Vec<Candidate>| {
        if let Some(candidate) = candidate {
            if nominated.insert((candidate.word.clone(), candidate.book_id.clone())) {
                candidates.push(candidate);
            }
        }
    };

    // The topical screen's second condition needs each word's spread of
    // lookup *books*, which is a fact about the whole window — so it is
    // gathered before any row is scored.
    let mut looked_up_in_books: HashMap<&str, HashSet<&str>> = HashMap::new();
    for (word, book, _) in &raw.window_lookups {
        looked_up_in_books
            .entry(word.as_str())
            .or_default()
            .insert(book.as_str());
    }

    let mut oldest_lookup: Option<i64> = None;
    let mut distinct_looked_up: HashMap<String, u8> = HashMap::new();
    for (word, _, at) in &raw.window_lookups {
        let Some(entry) = lookup_with(&forms, word)? else {
            continue;
        };
        let books = looked_up_in_books.get(word.as_str());
        let book_count = books.map_or(0, HashSet::len);
        // A looked-up word's context book is the one book it was looked up
        // in; with two or more, `classify`'s gate answers before context
        // matters.
        let context_book = books
            .filter(|books| books.len() == 1)
            .and_then(|books| books.iter().next().copied());
        let (topical, candidate) = classify(
            mode,
            &raw.verdicts,
            word,
            context_book,
            entry.band,
            raw.sightings.get(word),
            book_count,
        );
        nominate(candidate, &mut candidates);
        if topical {
            summary.topical_lookups += 1;
            continue;
        }
        summary.lookups_by_band[entry.band as usize] += 1;
        distinct_looked_up.insert(word.clone(), entry.band);
        oldest_lookup = Some(oldest_lookup.map_or(*at, |current: i64| current.min(*at)));
    }
    for band in distinct_looked_up.values() {
        summary.looked_up_words_by_band[*band as usize] += 1;
    }

    for word in &raw.passed_candidates {
        if let Some(entry) = lookup_with(&forms, word)? {
            // The same screen, for the same reason: a book that repeats its
            // own hard vocabulary teaches it in passing, and reading past a
            // word the book itself drilled says nothing about the level.
            // (`passed_candidates` were never looked up, hence 0 books —
            // their context book is the one holding most of the sightings.)
            let spread = raw.sightings.get(word);
            let context_book = spread.and_then(|spread| spread.top_book.as_deref());
            let (topical, candidate) =
                classify(mode, &raw.verdicts, word, context_book, entry.band, spread, 0);
            nominate(candidate, &mut candidates);
            if topical {
                continue;
            }
            summary.passed_by_band[entry.band as usize] += 1;
        }
    }

    summary.span_days = match oldest_lookup {
        Some(oldest) => ((now - oldest) / DAY_MS + 1).clamp(1, WINDOW_DAYS),
        None => 0,
    };

    Ok((summary, candidates))
}

// ---------------------------------------------------------------------------
// Dismissal state.
// ---------------------------------------------------------------------------

/// The identity a dismissal is recorded against when the served remark could
/// not be named — see `dismiss_level_observation`. Matches every candidate.
const ANY_REMARK: &str = "*";

fn stopped_for_good(conn: &Connection) -> AppResult<bool> {
    let stopped: i64 = conn
        .query_row(
            "SELECT stopped FROM level_observation_state WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    Ok(stopped != 0)
}

/// Is this exact remark still inside a "keep"/"apply" suppression window?
///
/// Suppression is keyed to the remark's identity — its kind and its band —
/// not to the row as a feature. That is what the UI promises: the same
/// remark stays away for three months *unless the record changes markedly*,
/// and "markedly" is given a definition here rather than a feeling. A
/// different verdict (`declaredLow` where `declaredHigh` was kept), or the
/// same verdict now resting on a different frequency band, is a different
/// thing to have been told, and is allowed through before the three months
/// are up. Everything else — more of the same evidence, a slightly
/// different average — is the same remark and stays quiet.
fn suppressed(conn: &Connection, observation: &LevelObservation, now: i64) -> AppResult<bool> {
    let since = now - SUPPRESSION_DAYS * DAY_MS;
    let band = observation.band.map(i64::from);
    let hit: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM level_observation_dismissals \
             WHERE created_at >= ?1 \
               AND (kind = ?4 OR (kind = ?2 AND ((band IS NULL AND ?3 IS NULL) OR band = ?3))) \
             LIMIT 1",
            params![since, observation.kind.as_db(), band, ANY_REMARK],
            |row| row.get(0),
        )
        .optional()?;
    Ok(hit.is_some())
}

/// Remember what was served, so a later dismissal can name it.
///
/// `dismiss_level_observation` is handed an outcome and nothing else, and
/// for `"applied"` the frontend has already written the new `cefr_level`
/// before it calls — recomputing the observation at that point would
/// describe a different remark, or no remark. Serve time is the last moment
/// the answer is knowable.
fn remember_shown(conn: &Connection, observation: &LevelObservation, now: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE level_observation_state \
         SET last_shown_kind = ?1, last_shown_band = ?2, last_shown_at = ?3, updated_at = ?3 \
         WHERE id = 1",
        params![
            observation.kind.as_db(),
            observation.band.map(i64::from),
            now
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

/// Compute the observation, plus — in AI mode — the words still awaiting a
/// class verdict. Candidates come back even when the observation is `None`
/// or suppressed: classifying them is what makes the *next* visit's answer
/// better, and a visit that shows nothing still read the whole record.
pub fn get_level_observation_inner(
    db: &Db,
    now: i64,
    ai_available: bool,
) -> AppResult<(Option<LevelObservation>, Vec<Candidate>)> {
    // Each guard is taken for one step and dropped, never held across the
    // scoring pass — see [`RawRecord`] for the deadlock that would be.
    let (mode, declared, raw) = {
        let conn = db.reader();
        if stopped_for_good(&conn)? {
            // The reader ended the comparison; nothing may be spent on its
            // behalf either, so no candidates.
            return Ok((None, Vec::new()));
        }
        let mode = word_class_mode(&conn, ai_available)?;
        (mode, declared_level(&conn)?, collect(&conn, now, mode)?)
    };

    let (record, candidates) = score(&raw, db, now, mode)?;
    let Some(mut observation) = judge(&record, &declared) else {
        return Ok((None, candidates));
    };
    observation.word_class_source = mode;

    {
        let conn = db.reader();
        if suppressed(&conn, &observation, now)? {
            return Ok((None, candidates));
        }
    }

    // The one write on this path, and it is bookkeeping about the UI, not
    // about the reader: which remark is on screen. Best-effort — a row that
    // was computed should still be shown if the note-taking fails.
    if let Ok(conn) = db.conn.lock() {
        let _ = remember_shown(&conn, &observation, now);
    }
    Ok((Some(observation), candidates))
}

/// The row's whole data source. `None` — no row — is the normal answer.
/// Also the AI classifier's only trigger: whatever the scoring pass left
/// unjudged is handed to a detached batch after the answer is already on
/// its way to the page — the row itself never waits on the network.
#[tauri::command]
pub fn get_level_observation(
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<Option<LevelObservation>> {
    let ai_available = crate::ai::router::has_configured_service(&db);
    let (observation, candidates) =
        get_level_observation_inner(&db, chrono::Utc::now().timestamp_millis(), ai_available)?;
    level_word_class::spawn_classification(
        app,
        db.inner().clone(),
        secrets.inner().clone(),
        candidates,
    );
    Ok(observation)
}

pub fn dismiss_level_observation_inner(db: &Db, outcome: &str, now: i64) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| AppError::Other("DB_LOCK_POISONED".to_string()))?;
    match outcome {
        // Off for good. §7's "拒绝一次就长期闭嘴" read at its strongest: the
        // reader did not decline a suggestion, they declined the comparison,
        // and there is no arithmetic here that can bring it back.
        "stopped" => {
            conn.execute(
                "UPDATE level_observation_state SET stopped = 1, updated_at = ?1 WHERE id = 1",
                params![now],
            )?;
        }
        // Both silence the remark that was on screen for three months.
        // "applied" is included for the same reason as "kept": the reader
        // has just acted on this remark, and repeating it while the change
        // they made has not yet had time to show up in the record is the
        // nagging §7 forbids.
        "applied" | "kept" => {
            let shown: Option<(Option<String>, Option<i64>)> = conn
                .query_row(
                    "SELECT last_shown_kind, last_shown_band FROM level_observation_state \
                     WHERE id = 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            // A dismissal that cannot name its remark silences all of them
            // for the window. That only happens if state was lost between
            // serving and pressing, and quiet is the safe direction.
            let (kind, band) = match shown {
                Some((Some(kind), band)) => (kind, band),
                _ => (ANY_REMARK.to_string(), None),
            };
            conn.execute(
                "INSERT INTO level_observation_dismissals (id, outcome, kind, band, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    outcome,
                    kind,
                    band,
                    now
                ],
            )?;
        }
        other => {
            return Err(AppError::Other(format!(
                "LEVEL_OBSERVATION_OUTCOME_UNKNOWN: {other}"
            )));
        }
    }
    Ok(())
}

/// Record what the reader did about the row. `outcome` is `"applied"`,
/// `"kept"`, or `"stopped"`; see [`dismiss_level_observation_inner`] for
/// what each one means. Nothing here writes `cefr_level` — the frontend
/// does that itself, before calling with `"applied"`.
#[tauri::command]
pub fn dismiss_level_observation(outcome: String, db: State<'_, Db>) -> AppResult<()> {
    dismiss_level_observation_inner(&db, &outcome, chrono::Utc::now().timestamp_millis())
}

#[cfg(test)]
mod tests;
