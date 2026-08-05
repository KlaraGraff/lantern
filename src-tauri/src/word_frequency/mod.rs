//! English word-frequency lookup.
//!
//! No caller wires this in yet — mastery scoring, book-difficulty preview,
//! and the level-mismatch nudge are later work this module unblocks but
//! does not itself implement. `#![allow(dead_code)]` reflects that
//! honestly instead of adding a throwaway command just to silence
//! `-D warnings`; the tests below are what exercises it for now.
//!
//! Three things depend on knowing whether a word is common or rare (design:
//! `docs/impls/reading-driven-mastery-and-review.md` §5.3, §5.6, §7): scoring
//! whether a lookup is a meaningful signal, judging whether a book's
//! vocabulary matches the reader's level, and flagging when the reader's
//! declared English level looks wrong. This module is the shared lookup
//! those three build on — nothing else yet.
//!
//! ## Why bands, not raw ranks
//!
//! A raw frequency rank ("the" is rank 1, "obfuscate" is rank 14 302) is
//! meaningless to read and, worse, brittle: swap in a different corpus and
//! every number changes even though nothing about the word did. A coarse
//! band survives a data-source swap and is what every caller above actually
//! wants ("is this word roughly as common as the ones this reader already
//! knows"), so the API returns a 1–5 band and treats the raw rank as
//! optional detail for callers that want it (e.g. sorting words within a
//! band).
//!
//! Band boundaries (documented here because they are a judgment call, not a
//! fact from the data):
//!
//! - **1** — rank 1–1 000. The near-closed set of function words plus the
//!   highest-frequency content words. In most general-English corpora this
//!   band alone covers roughly 70–80% of running text.
//! - **2** — rank 1 001–3 000. Common everyday vocabulary; still mostly
//!   words a B1/B2 reader recognizes on sight.
//! - **3** — rank 3 001–5 000. Words that start requiring genuine
//!   vocabulary study rather than everyday exposure — roughly where
//!   "advanced learner" word lists (e.g. the Oxford 5000, NGSL) top out.
//! - **4** — rank 5 001–20 000. Specialized or literary vocabulary: known
//!   to a strong reader, but not words most learners meet outside reading.
//! - **5** — rank 20 001+. Rare enough that a hit here is a strong signal
//!   regardless of the reader's level.
//!
//! These thresholds are a starting point, not a tuned constant — revisit
//! them once real usage data (lookup rates per band, see §5.3) is in.
//!
//! ## Data source
//!
//! Backed by [`FIXTURE_TSV`], a small hand-picked word list (see
//! `fixture.tsv`) — enough to exercise every band and the lemmatization
//! fallback below, **not** a real frequency table. Swapping in a real
//! corpus-derived table (candidates evaluated in
//! `docs/impls/word-frequency-data-sources.md`) only touches
//! [`table`]; the rest of this module is agnostic to where the data comes
//! from.
//!
//! ## Why the backend
//!
//! The data file never needs to reach the frontend as JS — every consumer
//! (mastery scoring, book-difficulty preview, level-mismatch nudges) is a
//! backend computation, so keeping the table here keeps it out of the
//! bundle entirely. It also means one load serves every future caller
//! instead of re-fetching per component.
//!
//! ## Lemmatization fallback
//!
//! The table is keyed on exact spelling. "running" and "run" are different
//! keys unless both happen to be in the table. Rather than duplicate every
//! inflected form, a miss falls back to `word_forms` (migration 027) — the
//! same table the reader's word-marking already uses to treat "acknowledged"
//! and "acknowledges" as one word (see
//! `crate::commands::word_marks::find_covering_rule`, which does the
//! identical two-direction scan for the same reason). A row's `forms`
//! column lists the *other* known spellings of one lexeme, populated
//! opportunistically whenever the AI is asked for a word's forms — it is
//! not a full lemmatizer, just whatever the reader has already triggered a
//! lookup for. That means the fallback can widen over time as more words
//! get looked up, but a miss here does not prove no relationship exists —
//! only that neither this word nor a word it's linked to has been recorded.
//!
//! Lazy + loaded once: [`table`] parses `fixture.tsv` on first call via
//! [`OnceLock`] and reuses the parsed map for the process lifetime, so a
//! lookup never re-reads or re-parses the file.

#![allow(dead_code)]

use std::cell::OnceCell;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::db::Db;
use crate::error::AppResult;
use crate::sync::events::normalize_learning_term;

/// `<word> <rank>` per line, `#`-prefixed lines are comments. See the module
/// doc for what this fixture is (and is not) standing in for.
const FIXTURE_TSV: &str = include_str!("fixture.tsv");

const BAND_1_MAX_RANK: u32 = 1_000;
const BAND_2_MAX_RANK: u32 = 3_000;
const BAND_3_MAX_RANK: u32 = 5_000;
const BAND_4_MAX_RANK: u32 = 20_000;

fn band_for_rank(rank: u32) -> u8 {
    if rank <= BAND_1_MAX_RANK {
        1
    } else if rank <= BAND_2_MAX_RANK {
        2
    } else if rank <= BAND_3_MAX_RANK {
        3
    } else if rank <= BAND_4_MAX_RANK {
        4
    } else {
        5
    }
}

/// A word's frequency, as a 1 (most common) – 5 (rare) band plus the raw
/// rank the band was computed from. `rank` is exposed for callers that want
/// finer ordering *within* a band (e.g. sorting a book's hardest words); the
/// band is the number every caller should actually branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct FrequencyEntry {
    pub band: u8,
    pub rank: u32,
}

fn parse_fixture(source: &str) -> HashMap<String, FrequencyEntry> {
    let mut map = HashMap::new();
    for line in source.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(word), Some(rank_str)) = (parts.next(), parts.next()) else {
            continue;
        };
        let Ok(rank) = rank_str.parse::<u32>() else {
            continue;
        };
        let normalized = normalize_learning_term(word);
        if normalized.is_empty() {
            continue;
        }
        map.insert(
            normalized,
            FrequencyEntry {
                band: band_for_rank(rank),
                rank,
            },
        );
    }
    map
}

/// The parsed frequency table, built once and reused for the process
/// lifetime. See the module doc's "Lazy + loaded once" note.
fn table() -> &'static HashMap<String, FrequencyEntry> {
    static TABLE: OnceLock<HashMap<String, FrequencyEntry>> = OnceLock::new();
    TABLE.get_or_init(|| parse_fixture(FIXTURE_TSV))
}

/// Look up `word`'s frequency band and rank.
///
/// Case-insensitive and punctuation-trimmed via the same normalization the
/// rest of the vocabulary system uses ([`normalize_learning_term`]). A miss
/// on the exact spelling falls back to sibling forms recorded in
/// `word_forms` (see the module doc's "Lemmatization fallback" section)
/// before giving up.
///
/// Returns `Ok(None)` when the word — and none of its recorded forms —
/// appear in the table. This is a genuine "unknown", never coerced into
/// band 5: a word absent from a ~400-entry fixture (or even a real 20–50k
/// table) says nothing about its actual frequency, and treating "not found"
/// as "rare" would silently mislabel every gap in the data as the rarest
/// possible word.
pub fn lookup(db: &Db, word: &str) -> AppResult<Option<FrequencyEntry>> {
    lookup_with(&FormIndex::new(db), word)
}

/// [`lookup`], reusing one [`FormIndex`] across a batch of words.
///
/// Prefer this whenever more than one word is scored against the same
/// database state — see [`FormIndex`] for why the difference is not small.
pub fn lookup_with(forms: &FormIndex<'_>, word: &str) -> AppResult<Option<FrequencyEntry>> {
    let normalized = normalize_learning_term(word);
    if normalized.is_empty() {
        return Ok(None);
    }
    if let Some(entry) = table().get(&normalized) {
        return Ok(Some(*entry));
    }
    for candidate in forms.related(&normalized)? {
        if let Some(entry) = table().get(candidate) {
            return Ok(Some(*entry));
        }
    }
    Ok(None)
}

/// Every spelling `word_forms` links to every other, both directions, built
/// from a single scan of the table:
///
/// - a row's key links to each spelling in its `forms` list ("run" ->
///   ["running", "ran", ...]);
/// - and each of those spellings links back ("running" was never looked up
///   directly, but "run" was, and its forms list mentions "running").
///
/// The reverse direction has no index and cannot get one: the forms live in
/// one JSON column per row, so answering it for a single word means reading
/// and parsing every row. That was fine while the only caller was a one-off
/// lookup. Mastery scoring asks per word per screen — up to
/// `MAX_WORDS_PER_SCREEN` of them — which would turn one screen into
/// hundreds of full scans. Building the whole relationship once turns it
/// back into one.
///
/// Scoped by borrow rather than cached process-wide, deliberately: the map
/// is only true of the `word_forms` contents at build time, and
/// `set_word_forms` / `delete_word_forms` can write mid-session. Tying its
/// lifetime to one batch means there is no invalidation to get wrong.
///
/// The scan is deferred until the first word actually misses the frequency
/// table, so a batch whose words are all in the table never touches the
/// database at all.
pub struct FormIndex<'a> {
    db: &'a Db,
    related: OnceCell<HashMap<String, Vec<String>>>,
}

impl<'a> FormIndex<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self {
            db,
            related: OnceCell::new(),
        }
    }

    /// Other spellings of `normalized`'s lexeme, or an empty slice.
    ///
    /// Mirrors `find_covering_rule` in `commands::word_marks` — same table,
    /// same both-directions reasoning.
    fn related(&self, normalized: &str) -> AppResult<&[String]> {
        if self.related.get().is_none() {
            // `OnceCell::get_or_init` cannot carry the error out, so build
            // first and set after. A lost race would only mean one wasted
            // scan, and there is no race here anyway: the cell is not shared.
            let _ = self.related.set(build_form_index(self.db)?);
        }
        let map = self.related.get().expect("just built");
        Ok(map.get(normalized).map_or(&[][..], Vec::as_slice))
    }
}

fn build_form_index(db: &Db) -> AppResult<HashMap<String, Vec<String>>> {
    let conn = db.reader();
    let mut statement = conn.prepare("SELECT normalized_word, forms FROM word_forms")?;
    let mut rows = statement.query([])?;
    let mut index: HashMap<String, Vec<String>> = HashMap::new();
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let forms_json: String = row.get(1)?;
        let forms: Vec<String> = serde_json::from_str(&forms_json).unwrap_or_default();
        for form in forms {
            if form == key {
                continue;
            }
            index.entry(key.clone()).or_default().push(form.clone());
            index.entry(form).or_default().push(key.clone());
        }
    }
    Ok(index)
}

#[cfg(test)]
mod tests;
