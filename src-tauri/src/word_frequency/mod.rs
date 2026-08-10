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
//! Band 1's boundary is the one the data can check, and it holds: in the
//! table below, rank 1 000 sits at a cumulative share of 0.787 — the top
//! thousand words are 79% of running text in fiction, inside the 70–80%
//! this band was described as covering before any real corpus was loaded.
//! The other two checkable boundaries land at 0.877 (rank 3 000) and 0.912
//! (rank 5 000).
//!
//! All five bands are populated: the table runs to rank 50 000, so band 5
//! holds the 30 000 words past [`BAND_4_MAX_RANK`]. The thresholds were
//! written before any corpus was loaded and have not been touched since —
//! when the table went from 10 000 words to 50 000, only 131 of the words
//! present in both changed band, all of them by a rank or two across a
//! boundary. Revisit all of them once real usage data (lookup rates per
//! band, see §5.3) is in, not before.
//!
//! ## Data source
//!
//! Backed by [`FREQUENCY_TSV`] — Google Books Ngram Corpus v3, **English
//! Fiction** subcorpus, 1-grams, books published 2010–2019, under CC BY
//! 3.0. The fiction subcorpus is the point: this band answers "how hard is
//! this word in a novel", and a general-English or subtitle-derived corpus
//! answers a different question (the alternatives, and why they lost, are
//! in `docs/impls/word-frequency-data-sources.md`).
//!
//! Google ships that subcorpus as one 940 MB gzip of per-word-per-year
//! counts, which has to be filtered to a year window, summed, denoised of
//! POS tags and proper nouns, and ranked. `orgtre/google-books-ngram-
//! frequency` publishes both a pipeline that does this and a finished
//! 10 000-word list; we run the pipeline ourselves with its caps raised and
//! nothing else changed, because 10 000 words is too shallow — a novel's
//! genuinely hard vocabulary sits past it, and the module could not tell
//! "rare" from "not a word we have data for". A control run at upstream's
//! own caps reproduces their published list exactly, which is what licenses
//! trusting ours; the recipe and that check are in the doc above.
//! `scripts/build-word-frequency-table.mjs` turns the pipeline's CSV into
//! the two-column file next door and is the only thing that should ever
//! write it.
//!
//! The table holds the 50 000 commonest fiction words. Its 173 surviving
//! capitalized entries ("I", "English", "Christmas") are the residue of
//! upstream's proper-noun filter and are harmless: lookups are lowercased
//! before they get here.
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
//! ## Possessive fallback
//!
//! Before the `word_forms` scan above, [`lookup_with`] also strips a trailing
//! `'s` or `s'` and looks the bare stem up. A possessive is not a new word —
//! "sister's" is exactly as hard as "sister" — so a book full of "mother's",
//! "brother's", "ladyship's" should not read as full of unknown words just
//! because the frequency table, like most such tables, is built on the bare
//! noun. It runs before the `word_forms` scan because it is cheap (no
//! database access) and total (it never needs a prior lookup to have
//! populated anything).
//!
//! The stem wins over the word's *own* row when both are present and the
//! stem's rank is better, which looks backwards until you look at what the
//! rows are. Only 15 entries in the whole 50 000-word table contain `'s`,
//! and every one of them sits past rank 17 000 — "it's" 17 467, "that's"
//! 26 973, "father's" 48 204, "let's" 39 735. Those are not measurements of
//! how rare those strings are; they are the same tokenizer artifact
//! [`CORRECTIONS`] exists for, the residue left after upstream's tokenizer
//! split most occurrences into two tokens. Trusting the exact row over the
//! stem would leave "father's" scored rarer than "parsonage" and hand the
//! reader "it's" as a word to study. Taking the better of the two applies
//! one rule to both halves of the problem: a clitic is never harder than
//! what it hangs off.
//!
//! Lazy + loaded once: [`table`] parses the word list on first call via
//! [`OnceLock`] and reuses the parsed map for the process lifetime, so a
//! lookup never re-reads or re-parses the file.

#![allow(dead_code)]

use std::cell::OnceCell;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::db::Db;
use crate::error::AppResult;
use crate::sync::events::normalize_learning_term;

/// `<word> <rank>` per line, `#`-prefixed lines are comments. Generated —
/// see the module doc's "Data source" section and the header of the file
/// itself, which carries the attribution CC BY 3.0 requires.
const FREQUENCY_TSV: &str = include_str!("english-fiction.tsv");

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

/// The inclusive rank window a band covers, or `None` for a band number
/// outside 1–5.
///
/// Band 5's upper bound is the table's own last rank rather than infinity,
/// and that is the honest bound: a word ranked past the end of the table is
/// not band 5, it is absent, and [`lookup`] returns `None` for it (see that
/// function's doc for why absence is never coerced into band 5). So the
/// widest rank a caller can ever have *observed* in band 5 is the last rank
/// in the file.
pub fn band_rank_window(band: u8) -> Option<(u32, u32)> {
    match band {
        1 => Some((1, BAND_1_MAX_RANK)),
        2 => Some((BAND_1_MAX_RANK + 1, BAND_2_MAX_RANK)),
        3 => Some((BAND_2_MAX_RANK + 1, BAND_3_MAX_RANK)),
        4 => Some((BAND_3_MAX_RANK + 1, BAND_4_MAX_RANK)),
        5 => Some((BAND_4_MAX_RANK + 1, max_rank())),
        _ => None,
    }
}

/// The last rank present in the frequency table, computed once.
fn max_rank() -> u32 {
    static MAX: OnceLock<u32> = OnceLock::new();
    *MAX.get_or_init(|| table().values().map(|entry| entry.rank).max().unwrap_or(0))
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

/// Upstream corpus artifacts, fixed one at a time. Not a place to tune ranks
/// — every entry must document why upstream is wrong and how the correction
/// is derived.
///
/// `("cannot", &["can", "not"])` — Google Books Ngram tokenizes "cannot" as
/// two words, "can" + "not", so the word's own row (rank 31 132) never
/// accumulated its real count and is far too rare to trust. The rule:
/// a compound the corpus split apart is no harder than the harder of its
/// parts, so the correction looks up "can" and "not" after parsing and takes
/// the larger (harder) of the two ranks — currently "can" at 62 — rather
/// than hardcoding a number that would silently go stale if the table is
/// regenerated and "can"'s rank shifts.
const CORRECTIONS: &[(&str, &[&str])] = &[("cannot", &["can", "not"])];

fn parse_table(source: &str) -> HashMap<String, FrequencyEntry> {
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
        // Two upstream rows can normalize to one word — "OK" and "ok" are
        // ranked separately in the source list. A lexeme is as common as its
        // commonest spelling, so the better rank wins rather than whichever
        // line happened to come last. The generator already collapses these,
        // so this only guards a hand-edited or re-sourced file.
        map.entry(normalized)
            .and_modify(|existing: &mut FrequencyEntry| {
                if rank < existing.rank {
                    *existing = FrequencyEntry {
                        band: band_for_rank(rank),
                        rank,
                    };
                }
            })
            .or_insert(FrequencyEntry {
                band: band_for_rank(rank),
                rank,
            });
    }
    for (word, parts) in CORRECTIONS {
        let Some(rank) = parts
            .iter()
            .map(|part| map.get(*part).map(|entry| entry.rank))
            .collect::<Option<Vec<_>>>()
            .and_then(|ranks| ranks.into_iter().max())
        else {
            // A part isn't in the table (e.g. the corpus was swapped for one
            // that doesn't have it) — skip rather than panic, since this
            // runs at first lookup, not at build time.
            continue;
        };
        map.insert(
            word.to_string(),
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
    TABLE.get_or_init(|| parse_table(FREQUENCY_TSV))
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
/// band 5.
///
/// The temptation grows with every word added to the table: at 50 000,
/// absence really does imply "rarer than rank 50 000". Resist it, because
/// absence has a much more common cause in a novel — character and place
/// names, invented words, foreign phrases, and
/// whatever the reader's finger caught mid-selection are all absent too.
/// Calling those the rarest words in English would mislabel exactly the
/// text a fiction reader touches most.
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
    let exact = table().get(&normalized).copied();
    let stem = possessive_stem(&normalized)
        .and_then(|stem| table().get(stem))
        .copied();
    // The better (lower) rank wins rather than the exact spelling, because
    // for a word ending in `'s` the exact row is the untrustworthy one — see
    // the module doc's "Possessive fallback" section.
    let best = match (exact, stem) {
        (Some(exact), Some(stem)) if stem.rank < exact.rank => Some(stem),
        (Some(exact), _) => Some(exact),
        (None, stem) => stem,
    };
    if let Some(entry) = best {
        return Ok(Some(entry));
    }
    for candidate in forms.related(&normalized)? {
        if let Some(entry) = table().get(candidate) {
            return Ok(Some(*entry));
        }
    }
    Ok(None)
}

/// Strips a trailing possessive marker (`'s` or `s'`) from an already
/// [`normalize_learning_term`]-normalized word, returning the bare stem —
/// or `None` when `normalized` does not end in one.
///
/// Accepts both apostrophe glyphs. `normalize_learning_term` keeps whatever
/// glyph the source text used — unlike `tokenize_cased` in
/// `book_difficulty`, it does not normalize U+2019 (’) to U+0027 ('), so a
/// word reaching this fallback from a different call site than book-scoring
/// may still carry the curly form.
fn possessive_stem(normalized: &str) -> Option<&str> {
    fn is_apostrophe(character: char) -> bool {
        character == '\'' || character == '’'
    }

    // "sisters'" — the apostrophe alone. The plural "s" belongs to the stem
    // and stays: "sisters'" is the plural's rank, not the singular's.
    if let Some(stem) = normalized.strip_suffix(is_apostrophe) {
        return (stem.ends_with('s') && stem.len() > 1).then_some(stem);
    }
    // "sister's" — apostrophe plus "s".
    let stem = normalized.strip_suffix('s')?.strip_suffix(is_apostrophe)?;
    (!stem.is_empty()).then_some(stem)
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
        let key: String = row.get("normalized_word")?;
        let forms_json: String = row.get("forms")?;
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
