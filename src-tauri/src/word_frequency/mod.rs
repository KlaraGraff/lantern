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

use std::collections::HashMap;
use std::sync::OnceLock;

use rusqlite::{params, OptionalExtension};

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
    let normalized = normalize_learning_term(word);
    if normalized.is_empty() {
        return Ok(None);
    }
    if let Some(entry) = table().get(&normalized) {
        return Ok(Some(*entry));
    }
    for candidate in related_forms(db, &normalized)? {
        if let Some(entry) = table().get(&candidate) {
            return Ok(Some(*entry));
        }
    }
    Ok(None)
}

/// Other spellings of `normalized`'s lexeme recorded in `word_forms`,
/// gathered from both directions of the relationship:
///
/// - `normalized` is itself a row's key ("run" -> ["running", "ran", ...]).
/// - `normalized` appears in some other row's `forms` list ("running" was
///   never looked up directly, but "run" was, and its forms list mentions
///   "running").
///
/// Mirrors `find_covering_rule` in `commands::word_marks` — same table,
/// same both-directions reasoning, same reason a full scan is fine (the
/// table only grows to the size of "words this reader has looked up").
fn related_forms(db: &Db, normalized: &str) -> AppResult<Vec<String>> {
    let conn = db.reader();
    let mut candidates = Vec::new();

    let direct_forms: Option<String> = conn
        .query_row(
            "SELECT forms FROM word_forms WHERE normalized_word = ?1",
            params![normalized],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(forms_json) = direct_forms {
        if let Ok(forms) = serde_json::from_str::<Vec<String>>(&forms_json) {
            candidates.extend(forms);
        }
    }

    let mut statement = conn.prepare("SELECT normalized_word, forms FROM word_forms")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        if key == normalized {
            continue;
        }
        let forms_json: String = row.get(1)?;
        let forms: Vec<String> = serde_json::from_str(&forms_json).unwrap_or_default();
        if forms.iter().any(|form| form == normalized) {
            candidates.push(key);
        }
    }

    Ok(candidates)
}

#[cfg(test)]
mod tests;
