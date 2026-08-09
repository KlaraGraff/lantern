//! Reader-relative coverage: how much of a book's running text is made of
//! words *this reader* already knows.
//!
//! Design: `docs/impls/handoff-coverage-and-aliases.md` §2. The distinction
//! from [`crate::commands::book_difficulty`] is the subject of the sentence.
//! Difficulty bands every word of a book against a frequency table, so its
//! "cumulative coverage" measures how much of the book our dictionary
//! contains — the reader is not in it. Nation's 95% / 98% reading thresholds
//! say *the reader* knows 95% of the running words, and that is what this
//! module computes: the book's own word list, intersected with the set of
//! words this device has evidence the reader knows.
//!
//! Three properties, same as difficulty's:
//!
//! - **No network.** Two local tables and a set intersection.
//! - **It never writes to the vocabulary profile.** Everything here reads
//!   `vocab_words`, `mastery_progress`, `reading_word_exposures` and
//!   `lookup_records`; nothing here changes a tier or records an exposure.
//!   The one exception is deliberate, explicit, and asked for by name:
//!   [`clear_vocab_profile`].
//! - **No sweeps.** A computation happens when the reader opens a book's
//!   details page or presses the button. Nothing scans the library.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::book_difficulty::{self, DifficultyStatus, WordTally};
use crate::commands::lookup_history::normalize;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mastery::FAMILIAR_CREDIT;
use crate::sync::writer::SyncWriter;
use crate::word_frequency::{lookup_with, FormIndex};

/// The credit at which a word counts as "眼熟" — read a few times, not looked
/// up, not yet a tier (D2).
///
/// Half of [`FAMILIAR_CREDIT`], i.e. halfway to the engine's own first tier
/// promotion. Deliberately derived rather than declared: `mastery_progress`
/// already scores exactly the thing this band describes, and a fresh constant
/// here would be a second unsourced number of the kind §2.4(e) warns about.
/// The choice of "half" is also the cheapest possible one to be wrong about —
/// it moves only the upper bound of the interval, never the lower.
pub const FAMILIAR_ENOUGH_CREDIT: f64 = FAMILIAR_CREDIT / 2.0;

/// How often the scan reports progress, as a fraction of the book. The scan
/// does one frequency lookup per distinct form, so it is fast enough that
/// emitting an event per word would cost more than the lookups do.
const PROGRESS_STEPS: i64 = 50;

/// Exposure rows deleted per batch when clearing the profile. Small enough
/// that the counter in the confirmation dialog moves, large enough that a
/// 200 000-row table is not 200 000 statements.
const CLEAR_BATCH: i64 = 2_000;

/// Which of the four rows of "这本书的词次构成" a word falls in.
///
/// Ordered by strength of evidence, and the order is load-bearing: a word that
/// qualifies for two rows is counted in the strongest one exactly once, or the
/// four rows would not sum to the book.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bucket {
    /// `vocab_words.mastery` is 'familiar' or 'mastered' — the authoritative,
    /// syncable tier.
    Mastered,
    /// A proper noun: not in the frequency table and never lowercase in this
    /// book, or a name this book's alias table already knows.
    Name,
    /// Enough credit to be halfway to a tier, never looked up.
    Familiar,
    /// Everything else.
    Unknown,
}

/// The reader's side of the intersection: which forms count as known, and how
/// much evidence that judgment rests on.
///
/// Forms are normalized with [`normalize`] — the same function
/// `reading_word_exposures` and `lookup_records` are keyed by — so they can be
/// compared to `book_word_counts.word`, which the tokenizer lowercased.
#[derive(Debug, Clone, Default)]
pub struct ReaderProfile {
    pub mastered: HashSet<String>,
    pub familiar: HashSet<String>,
    /// Distinct books this device has recorded reading in. The first of the
    /// two gates in §2.4(e).
    pub baseline_books: i64,
    /// When the profile last changed, in epoch milliseconds. Stored on the
    /// coverage row so a stale result can be captioned with the profile it was
    /// actually computed from, rather than with today's.
    pub updated_at: Option<i64>,
}

/// What the four "依据" rows of the empty and sample-thin states show.
///
/// Separate from [`ReaderProfile`] because it is display data: nothing in the
/// computation reads it, and the empty state (03) has to render before any
/// coverage row exists at all.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabProfileSummary {
    /// Books with any exposure recorded. "不用读完，读过就算".
    pub books_read: i64,
    /// Title and progress of the single book everything was read in, when
    /// there is exactly one. The sample-thin state names it out loud
    /// ("来自《夏洛的网》读过的 12%"); with two or more books it says nothing.
    pub single_book_title: Option<String>,
    /// Percent, 0–100, the same scale `books.progress` is stored on.
    pub single_book_progress: Option<i32>,
    /// Running words seen on a settled screen, and the distinct forms behind
    /// them.
    pub exposure_tokens: i64,
    pub exposure_words: i64,
    pub lookup_records: i64,
    /// Separate calendar days those lookups are spread over, UTC.
    pub lookup_days: i64,
    /// Words in the vocabulary list the reader can actually see — watchlist
    /// rows (044) are excluded, since the reader never chose them.
    pub vocab_words: i64,
    pub reviewed_words: i64,
    pub mastered_forms: i64,
    pub familiar_forms: i64,
    pub updated_at: Option<i64>,
}

/// One book's word list folded onto the four rows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageTally {
    pub total_tokens: i64,
    pub distinct_words: i64,
    pub mastered_tokens: i64,
    pub familiar_tokens: i64,
    pub name_tokens: i64,
    pub unknown_tokens: i64,
    pub name_words: i64,
    pub unknown_words: i64,
}

/// Which row one form belongs in.
///
/// `listed` is "the frequency table has heard of this form" — the same test
/// that puts a word outside `band_unlisted` in the difficulty pass. A form the
/// table does not know, which this book never once wrote in lowercase, is a
/// name: a novel's characters and places behave exactly that way, and an
/// ordinary word that happens to open a sentence also appears mid-sentence
/// somewhere in a whole book.
///
/// §2.4(d) accepts the misjudgment this can make — a genuinely rare word that
/// only ever appears at the start of a sentence — on the grounds that it moves
/// coverage by a hair, while listing a character's name as unlearned
/// vocabulary is a visible insult to the reader.
pub fn classify(
    word: &str,
    tally: WordTally,
    listed: bool,
    profile: &ReaderProfile,
    names: &HashSet<String>,
) -> Bucket {
    if profile.mastered.contains(word) {
        return Bucket::Mastered;
    }
    if names.contains(word) || (!listed && tally.tokens > 0 && tally.capitalized == tally.tokens) {
        return Bucket::Name;
    }
    if profile.familiar.contains(word) {
        return Bucket::Familiar;
    }
    Bucket::Unknown
}

/// Fold a book's whole word list onto the four rows.
///
/// Pure on purpose: this is the one function whose arithmetic the interface
/// quotes back to the reader ("每 100 个词里有 3.6 个你还没掌握"), and it is
/// worth being able to test it with three words and no database.
pub fn tally_coverage(
    counts: &HashMap<String, WordTally>,
    listed: &HashSet<String>,
    profile: &ReaderProfile,
    names: &HashSet<String>,
) -> CoverageTally {
    let mut tally = CoverageTally::default();
    for (word, word_tally) in counts {
        tally.total_tokens += word_tally.tokens;
        tally.distinct_words += 1;
        match classify(word, *word_tally, listed.contains(word), profile, names) {
            Bucket::Mastered => tally.mastered_tokens += word_tally.tokens,
            Bucket::Familiar => tally.familiar_tokens += word_tally.tokens,
            Bucket::Name => {
                tally.name_tokens += word_tally.tokens;
                tally.name_words += 1;
            }
            Bucket::Unknown => {
                tally.unknown_tokens += word_tally.tokens;
                tally.unknown_words += 1;
            }
        }
    }
    tally
}

/// The forms the frequency table knows, out of a book's word list.
///
/// One [`FormIndex`] for the whole book, for the reason
/// `book_difficulty::accumulate` builds one: the index's `word_forms` scan is
/// lazy but per-instance, and rebuilding it per word would turn one book into
/// tens of thousands of full table scans.
/// `on_progress` receives how many running words have been accounted for so
/// far. This scan is the whole of the "正在把全书的词和你的词汇画像对一遍"
/// state, so its progress is measured in the unit that state displays — tokens
/// of the book — rather than in distinct forms, which would run ahead of the
/// number on screen.
pub fn listed_forms(
    db: &Db,
    counts: &HashMap<String, WordTally>,
    mut on_progress: impl FnMut(i64),
) -> AppResult<HashSet<String>> {
    let total: i64 = counts.values().map(|tally| tally.tokens).sum();
    let step = (total / PROGRESS_STEPS).max(1);
    let forms = FormIndex::new(db);
    let mut listed = HashSet::new();
    let mut scanned = 0i64;
    let mut reported = 0i64;
    for (word, tally) in counts {
        if lookup_with(&forms, word)?.is_some() {
            listed.insert(word.clone());
        }
        scanned += tally.tokens;
        if scanned - reported >= step {
            reported = scanned;
            on_progress(scanned);
        }
    }
    Ok(listed)
}

/// Every name this book's alias table (059) knows, as normalized forms.
///
/// Only the capitalized words of each entry are taken. An alias row can be a
/// description rather than a name — "the doctor", "船长的朋友" — and folding
/// those in whole would quietly declare `the` a proper noun, which on a reader
/// with no profile yet would hand them several percent of the book for free.
/// Capitalization is the same evidence the rule above rests on, applied to the
/// alias text instead of the book text.
pub fn load_alias_names(db: &Db, book_id: &str) -> AppResult<HashSet<String>> {
    let conn = db.reader();
    let mut statement =
        conn.prepare("SELECT canonical, alias FROM book_person_aliases WHERE book_id = ?1")?;
    let mut rows = statement.query([book_id])?;
    let mut names = HashSet::new();
    while let Some(row) = rows.next()? {
        for column in [0usize, 1] {
            let text: String = row.get(column)?;
            for (token, capitalized) in crate::commands::book_difficulty::tokenize_cased(&text) {
                if capitalized {
                    names.insert(token);
                }
            }
        }
    }
    Ok(names)
}

/// A book's stored word list (migration 066), with the hash of the file it was
/// counted from.
pub fn load_word_counts(
    db: &Db,
    book_id: &str,
) -> AppResult<(HashMap<String, WordTally>, Option<String>)> {
    let conn = db.reader();
    let mut statement = conn.prepare(
        "SELECT word, tokens, capitalized, source_sha256 FROM book_word_counts WHERE book_id = ?1",
    )?;
    let mut rows = statement.query([book_id])?;
    let mut counts = HashMap::new();
    let mut sha256 = None;
    while let Some(row) = rows.next()? {
        let word: String = row.get(0)?;
        counts.insert(
            word,
            WordTally {
                tokens: row.get(1)?,
                capitalized: row.get(2)?,
            },
        );
        if sha256.is_none() {
            sha256 = row.get::<_, Option<String>>(3)?;
        }
    }
    Ok((counts, sha256))
}

/// The reader's known-word sets, both of them.
///
/// Both bounds of §2.4(e)'s interval are always computed, so both sets are
/// always loaded: the setting that decides whether "眼熟" counts as known is a
/// display choice over two numbers that already exist, not a branch in the
/// computation.
pub fn load_reader_profile(db: &Db) -> AppResult<ReaderProfile> {
    let conn = db.reader();

    let mut mastered = HashSet::new();
    {
        let mut statement = conn
            .prepare("SELECT word FROM vocab_words WHERE mastery IN ('familiar', 'mastered')")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let word: String = row.get(0)?;
            let normalized = normalize(&word);
            if !normalized.is_empty() {
                mastered.insert(normalized);
            }
        }
    }

    // "查过就是不认识的直接证据" (D2). Two records of a lookup, and a word is
    // disqualified by either: `lookup_records` is the durable history the
    // interface itself lists as a data source, and `mastery_progress`
    // remembers a lookup the engine scored even if its record was since
    // deleted from the history.
    let mut looked_up = HashSet::new();
    {
        let mut statement = conn.prepare("SELECT DISTINCT normalized_text FROM lookup_records")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let word: String = row.get(0)?;
            let normalized = normalize(&word);
            if !normalized.is_empty() {
                looked_up.insert(normalized);
            }
        }
    }

    let mut familiar = HashSet::new();
    {
        let mut statement = conn.prepare(
            "SELECT v.word FROM mastery_progress p
               JOIN vocab_words v ON v.id = p.vocab_word_id
              WHERE p.credit >= ?1
                AND p.last_lookup_at IS NULL
                AND v.mastery NOT IN ('familiar', 'mastered')",
        )?;
        let mut rows = statement.query([FAMILIAR_ENOUGH_CREDIT])?;
        while let Some(row) = rows.next()? {
            let word: String = row.get(0)?;
            let normalized = normalize(&word);
            if normalized.is_empty() || mastered.contains(&normalized) {
                continue;
            }
            if looked_up.contains(&normalized) {
                continue;
            }
            familiar.insert(normalized);
        }
    }

    let baseline_books: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT book_id) FROM reading_word_exposures",
        [],
        |row| row.get(0),
    )?;

    // The newest fact behind any of the above. Exposures and credit move on
    // every reading session; `mastery_events` catches the manual and review
    // tier changes that move `vocab_words.mastery` without touching either.
    let updated_at: Option<i64> = conn.query_row(
        "SELECT MAX(value) FROM (
             SELECT MAX(updated_at) AS value FROM reading_word_exposures
             UNION ALL SELECT MAX(updated_at) FROM mastery_progress
             UNION ALL SELECT MAX(created_at) FROM mastery_events
         )",
        [],
        |row| row.get(0),
    )?;

    Ok(ReaderProfile {
        mastered,
        familiar,
        baseline_books,
        updated_at,
    })
}

/// The four "依据" rows, plus the two set sizes the sample-thin state quotes.
pub fn load_vocab_profile_summary(db: &Db) -> AppResult<VocabProfileSummary> {
    let profile = load_reader_profile(db)?;
    let conn = db.reader();

    let (exposure_tokens, exposure_words): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(encounter_count), 0), COUNT(DISTINCT normalized_word)
           FROM reading_word_exposures",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let (lookup_records, lookup_days): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COUNT(DISTINCT date(created_at / 1000, 'unixepoch'))
           FROM lookup_records",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let (vocab_words, reviewed_words): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN review_count > 0 THEN 1 ELSE 0 END), 0)
           FROM vocab_words WHERE list_status = 'confirmed'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let mut single_book_title = None;
    let mut single_book_progress = None;
    if profile.baseline_books == 1 {
        let found = conn
            .query_row(
                "SELECT b.title, b.progress FROM books b
                  WHERE b.id = (SELECT book_id FROM reading_word_exposures LIMIT 1)",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?)),
            )
            .ok();
        if let Some((title, progress)) = found {
            single_book_title = Some(title);
            single_book_progress = Some(progress);
        }
    }

    Ok(VocabProfileSummary {
        books_read: profile.baseline_books,
        single_book_title,
        single_book_progress,
        exposure_tokens,
        exposure_words,
        lookup_records,
        lookup_days,
        vocab_words,
        reviewed_words,
        mastered_forms: profile.mastered.len() as i64,
        familiar_forms: profile.familiar.len() as i64,
        updated_at: profile.updated_at,
    })
}

/// One row of the expanded "那 8.2% 到底是哪些词" list (06).
///
/// Carries evidence, not a verdict: how many times the book uses the word, how
/// many times the reader has seen it, how many times they looked it up. Which
/// chip that becomes ("读到过 6 次没查", "查过 3 次", "从没遇到过") is a
/// sentence, and sentences live in the i18n files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownWord {
    pub word: String,
    /// Occurrences in this book.
    pub tokens: i64,
    /// The reader's own definition, when this word is already in their list.
    /// `None` otherwise — a gloss is not invented here, and nothing in this
    /// module goes to the network for one.
    pub gloss: Option<String>,
    /// Times seen on a settled screen, across every book.
    pub encounters: i64,
    pub lookups: i64,
    /// True only when the reader has turned "眼熟 counts as known" off: with it
    /// on, these words are known and are not in this list at all.
    pub familiar: bool,
}

/// The words of a book the reader has not learned, commonest first.
///
/// Proper nouns are absent by construction — they are classified as names, and
/// the footnote under the list says so. `count_familiar` mirrors the setting:
/// with it off, the "眼熟" band joins the list rather than the known set, which
/// is where the mockup's 眼熟 chip comes from.
///
/// The whole list is returned, not a page of it. It is a few thousand rows at
/// most (Moby-Dick, the worst case in the library, has about 4 900), the
/// grouping in the interface needs the totals anyway, and the CSV export (D5)
/// needs every row.
pub fn load_unknown_words(
    db: &Db,
    book_id: &str,
    count_familiar: bool,
) -> AppResult<Vec<UnknownWord>> {
    let (counts, _) = load_word_counts(db, book_id)?;
    if counts.is_empty() {
        return Ok(Vec::new());
    }
    let profile = load_reader_profile(db)?;
    let names = load_alias_names(db, book_id)?;
    let listed = listed_forms(db, &counts, |_| {})?;

    let mut wanted: Vec<(String, i64, bool)> = Vec::new();
    for (word, tally) in &counts {
        match classify(word, *tally, listed.contains(word), &profile, &names) {
            Bucket::Unknown => wanted.push((word.clone(), tally.tokens, false)),
            Bucket::Familiar if !count_familiar => wanted.push((word.clone(), tally.tokens, true)),
            _ => {}
        }
    }

    // Three whole-table reads rather than three statements per word: the list
    // is thousands of rows long, and every one of these tables is keyed by the
    // same normalized form.
    let conn = db.reader();
    let mut glosses: HashMap<String, String> = HashMap::new();
    {
        let mut statement =
            conn.prepare("SELECT word, definition FROM vocab_words WHERE definition <> ''")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let word: String = row.get(0)?;
            glosses.entry(normalize(&word)).or_insert(row.get(1)?);
        }
    }
    let mut encounters: HashMap<String, i64> = HashMap::new();
    {
        let mut statement = conn.prepare(
            "SELECT normalized_word, SUM(encounter_count) FROM reading_word_exposures
              GROUP BY normalized_word",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            encounters.insert(row.get(0)?, row.get(1)?);
        }
    }
    let mut lookups: HashMap<String, i64> = HashMap::new();
    {
        let mut statement = conn.prepare(
            "SELECT normalized_text, COUNT(*) FROM lookup_records GROUP BY normalized_text",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            lookups.insert(row.get(0)?, row.get(1)?);
        }
    }
    drop(conn);

    let mut words: Vec<UnknownWord> = wanted
        .into_iter()
        .map(|(word, tokens, familiar)| UnknownWord {
            gloss: glosses.get(&word).cloned(),
            encounters: encounters.get(&word).copied().unwrap_or(0),
            lookups: lookups.get(&word).copied().unwrap_or(0),
            word,
            tokens,
            familiar,
        })
        .collect();
    // Commonest first, and alphabetical within a tie so the list is stable
    // across two calls with the same data — a list that reshuffles itself on
    // every expand reads as a list that is guessing.
    words.sort_by(|left, right| {
        right
            .tokens
            .cmp(&left.tokens)
            .then_with(|| left.word.cmp(&right.word))
    });
    Ok(words)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageStatus {
    /// Never computed, or queued.
    Pending,
    Running,
    Done,
    Failed,
    /// Too few running words for a percentage to mean anything, or a source
    /// format no extractor can read. Both are taken from
    /// [`book_difficulty`]'s verdict rather than decided again here — the two
    /// passes count the same word list, so they must agree about whether there
    /// is one.
    TooShort,
    Unsupported,
}

impl CoverageStatus {
    fn as_db(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::TooShort => "too_short",
            Self::Unsupported => "unsupported",
        }
    }

    fn from_db(value: &str) -> Self {
        match value {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "too_short" => Self::TooShort,
            "unsupported" => Self::Unsupported,
            _ => Self::Pending,
        }
    }
}

/// One book's coverage row, as the frontend sees it.
///
/// No percentage is stored, on purpose. The same four token counts produce two
/// of them — with "眼熟" counted as known and without — and which one is *the*
/// coverage is a setting the reader can flip at any moment (08). A stored
/// percentage would mean recomputing every book the moment they did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookReaderCoverage {
    pub book_id: String,
    pub status: CoverageStatus,
    pub total_tokens: i64,
    pub distinct_words: i64,
    pub mastered_tokens: i64,
    pub familiar_tokens: i64,
    pub name_tokens: i64,
    pub unknown_tokens: i64,
    pub name_words: i64,
    pub unknown_words: i64,
    pub mastered_forms: i64,
    pub familiar_forms: i64,
    pub baseline_books: i64,
    /// RFC-3339 UTC, and the reason the profile counts above are stored rather
    /// than re-read at display time: while a recomputation runs (05b), the old
    /// row stays on screen captioned with the profile it actually came from.
    pub profile_at: Option<String>,
    pub source_sha256: Option<String>,
    pub computed_at: Option<String>,
    pub error: Option<String>,
    /// The book's file has changed since this row was computed. Whether the
    /// *reader* has changed since is a separate question, which the frontend
    /// answers by comparing `profileAt` against
    /// [`VocabProfileSummary::updated_at`] — cheaply, and without this call
    /// having to build the whole known-word set to find out.
    pub stale: bool,
}

impl BookReaderCoverage {
    fn empty(book_id: &str, status: CoverageStatus) -> Self {
        Self {
            book_id: book_id.to_string(),
            status,
            total_tokens: 0,
            distinct_words: 0,
            mastered_tokens: 0,
            familiar_tokens: 0,
            name_tokens: 0,
            unknown_tokens: 0,
            name_words: 0,
            unknown_words: 0,
            mastered_forms: 0,
            familiar_forms: 0,
            baseline_books: 0,
            profile_at: None,
            source_sha256: None,
            computed_at: None,
            error: None,
            stale: false,
        }
    }
}

/// How far the scan has got, in running words of the book (05).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageProgress {
    pub scanned_tokens: i64,
    pub total_tokens: i64,
}

/// How far clearing the profile has got, in exposure rows (09b).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearProgress {
    pub cleared: i64,
    pub total: i64,
    pub done: bool,
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// The profile's timestamp is milliseconds (039); this table's timestamps are
/// RFC-3339 text (041's convention, inherited by 066). Converted at the
/// boundary rather than storing a third format.
fn rfc3339_from_millis(millis: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(millis).map(|moment| moment.to_rfc3339())
}

fn store(
    db: &Db,
    book_id: &str,
    status: CoverageStatus,
    tally: &CoverageTally,
    profile: Option<&ReaderProfile>,
    source_sha256: Option<&str>,
    error: Option<&str>,
) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "INSERT INTO book_reader_coverage (
             book_id, status, total_tokens, distinct_words,
             mastered_tokens, familiar_tokens, name_tokens, unknown_tokens,
             name_words, unknown_words, mastered_forms, familiar_forms,
             baseline_books, profile_at, source_sha256, computed_at, error
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(book_id) DO UPDATE SET
             status = excluded.status, total_tokens = excluded.total_tokens,
             distinct_words = excluded.distinct_words,
             mastered_tokens = excluded.mastered_tokens,
             familiar_tokens = excluded.familiar_tokens,
             name_tokens = excluded.name_tokens,
             unknown_tokens = excluded.unknown_tokens,
             name_words = excluded.name_words,
             unknown_words = excluded.unknown_words,
             mastered_forms = excluded.mastered_forms,
             familiar_forms = excluded.familiar_forms,
             baseline_books = excluded.baseline_books,
             profile_at = excluded.profile_at,
             source_sha256 = excluded.source_sha256,
             computed_at = excluded.computed_at,
             error = excluded.error",
        params![
            book_id,
            status.as_db(),
            tally.total_tokens,
            tally.distinct_words,
            tally.mastered_tokens,
            tally.familiar_tokens,
            tally.name_tokens,
            tally.unknown_tokens,
            tally.name_words,
            tally.unknown_words,
            profile.map_or(0, |profile| profile.mastered.len() as i64),
            profile.map_or(0, |profile| profile.familiar.len() as i64),
            profile.map_or(0, |profile| profile.baseline_books),
            profile
                .and_then(|profile| profile.updated_at)
                .and_then(rfc3339_from_millis),
            source_sha256,
            now_rfc3339(),
            error,
        ],
    )?;
    Ok(())
}

/// Move the row to "running" without touching the numbers on it.
///
/// That is the whole of state 05b: a recomputation must not blank the screen,
/// because the old number is still true of the profile it was computed from,
/// and the caption already says which profile that was.
fn mark_running(db: &Db, book_id: &str) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "INSERT INTO book_reader_coverage (book_id, status) VALUES (?1, 'running')
         ON CONFLICT(book_id) DO UPDATE SET status = 'running', error = NULL",
        params![book_id],
    )?;
    Ok(())
}

fn read_row(db: &Db, book_id: &str) -> AppResult<Option<BookReaderCoverage>> {
    let conn = db.reader();
    let row = conn
        .query_row(
            "SELECT status, total_tokens, distinct_words, mastered_tokens, familiar_tokens,
                    name_tokens, unknown_tokens, name_words, unknown_words, mastered_forms,
                    familiar_forms, baseline_books, profile_at, source_sha256, computed_at, error
               FROM book_reader_coverage WHERE book_id = ?1",
            params![book_id],
            |row| {
                Ok(BookReaderCoverage {
                    book_id: book_id.to_string(),
                    status: CoverageStatus::from_db(&row.get::<_, String>("status")?),
                    total_tokens: row.get("total_tokens")?,
                    distinct_words: row.get("distinct_words")?,
                    mastered_tokens: row.get("mastered_tokens")?,
                    familiar_tokens: row.get("familiar_tokens")?,
                    name_tokens: row.get("name_tokens")?,
                    unknown_tokens: row.get("unknown_tokens")?,
                    name_words: row.get("name_words")?,
                    unknown_words: row.get("unknown_words")?,
                    mastered_forms: row.get("mastered_forms")?,
                    familiar_forms: row.get("familiar_forms")?,
                    baseline_books: row.get("baseline_books")?,
                    profile_at: row.get("profile_at")?,
                    source_sha256: row.get("source_sha256")?,
                    computed_at: row.get("computed_at")?,
                    error: row.get("error")?,
                    stale: false,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// Read the stored row, flagging it stale when the file it was counted from
/// has since changed. A book with no row reads as [`CoverageStatus::Pending`].
pub fn load(db: &Db, book_id: &str) -> AppResult<BookReaderCoverage> {
    let Some(mut row) = read_row(db, book_id)? else {
        return Ok(BookReaderCoverage::empty(book_id, CoverageStatus::Pending));
    };
    if let Some(stored) = row.source_sha256.as_deref() {
        let current = crate::ai::grounding::index::current_source_sha256(db, book_id)?;
        row.stale = current.as_deref() != Some(stored);
    }
    Ok(row)
}

/// The book's word list, or the reason there isn't one.
enum WordList {
    Ready(HashMap<String, WordTally>, Option<String>),
    Unavailable(CoverageStatus, Option<String>),
}

/// §2.4(a): never re-tokenize a book just to answer this question. The
/// difficulty pass already writes the word list on import, so the only case
/// that reads the file again is a book whose list is missing or was counted
/// from a different file — and that second case invalidates the band counts at
/// the same moment and by the same hash, so recomputing difficulty is the
/// right repair rather than a detour.
fn ensure_word_counts(db: &Db, book_id: &str) -> AppResult<WordList> {
    let difficulty = book_difficulty::load(db, book_id)?;
    match difficulty.status {
        DifficultyStatus::TooShort => {
            return Ok(WordList::Unavailable(CoverageStatus::TooShort, None))
        }
        DifficultyStatus::Unsupported => {
            return Ok(WordList::Unavailable(CoverageStatus::Unsupported, None))
        }
        _ => {}
    }

    let current = crate::ai::grounding::index::current_source_sha256(db, book_id)?;
    let (counts, stored) = load_word_counts(db, book_id)?;
    if !counts.is_empty() && (current.is_none() || stored == current) {
        return Ok(WordList::Ready(counts, stored));
    }

    let recomputed = book_difficulty::compute_and_store(db, book_id)?;
    match recomputed.status {
        DifficultyStatus::TooShort => {
            return Ok(WordList::Unavailable(CoverageStatus::TooShort, None))
        }
        DifficultyStatus::Unsupported => {
            return Ok(WordList::Unavailable(CoverageStatus::Unsupported, None))
        }
        DifficultyStatus::Failed => {
            return Ok(WordList::Unavailable(
                CoverageStatus::Failed,
                recomputed.error,
            ))
        }
        _ => {}
    }

    let (counts, stored) = load_word_counts(db, book_id)?;
    if counts.is_empty() {
        return Ok(WordList::Unavailable(
            CoverageStatus::Failed,
            Some("COVERAGE_EMPTY_WORD_LIST".to_string()),
        ));
    }
    Ok(WordList::Ready(counts, stored))
}

/// Compute one book's coverage and write it. Synchronous; the callers below
/// run it on a blocking thread.
pub(crate) fn compute_and_store(
    db: &Db,
    book_id: &str,
    mut on_progress: impl FnMut(i64, i64),
) -> AppResult<BookReaderCoverage> {
    let (counts, sha256) = match ensure_word_counts(db, book_id)? {
        WordList::Ready(counts, sha256) => (counts, sha256),
        WordList::Unavailable(status, error) => {
            store(
                db,
                book_id,
                status,
                &CoverageTally::default(),
                None,
                None,
                error.as_deref(),
            )?;
            return load(db, book_id);
        }
    };

    let total_tokens: i64 = counts.values().map(|tally| tally.tokens).sum();
    let profile = load_reader_profile(db)?;
    let names = load_alias_names(db, book_id)?;
    let listed = listed_forms(db, &counts, |scanned| on_progress(scanned, total_tokens))?;
    let tally = tally_coverage(&counts, &listed, &profile, &names);

    store(
        db,
        book_id,
        CoverageStatus::Done,
        &tally,
        Some(&profile),
        sha256.as_deref(),
        None,
    )?;
    load(db, book_id)
}

fn record_failure(db: &Db, book_id: &str, message: &str) -> BookReaderCoverage {
    if let Err(error) = store(
        db,
        book_id,
        CoverageStatus::Failed,
        &CoverageTally::default(),
        None,
        None,
        Some(message),
    ) {
        log::warn!("reader coverage: could not record the failure for {book_id}: {error}");
    }
    let mut row = load(db, book_id)
        .unwrap_or_else(|_| BookReaderCoverage::empty(book_id, CoverageStatus::Failed));
    row.status = CoverageStatus::Failed;
    row.error = Some(message.to_string());
    row
}

fn event_name(book_id: &str) -> String {
    format!("book-coverage-{book_id}")
}

fn progress_event_name(book_id: &str) -> String {
    format!("book-coverage-progress-{book_id}")
}

fn spawn_computation(app: AppHandle, db: Db, book_id: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let progress_event = progress_event_name(&book_id);
        let reporter = {
            let app = app.clone();
            move |scanned_tokens, total_tokens| {
                let _ = app.emit(
                    &progress_event,
                    CoverageProgress {
                        scanned_tokens,
                        total_tokens,
                    },
                );
            }
        };
        let result = match compute_and_store(&db, &book_id, reporter) {
            Ok(row) => row,
            Err(error) => {
                let message = error.to_string();
                log::warn!("reader coverage failed for {book_id}: {message}");
                record_failure(&db, &book_id, &message)
            }
        };
        let _ = app.emit(&event_name(&book_id), result);
    });
}

#[tauri::command]
pub fn get_book_coverage(book_id: String, db: State<'_, Db>) -> AppResult<BookReaderCoverage> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    load(&db, &book_id)
}

/// Start a computation and return immediately. The finished row arrives on
/// `book-coverage-{book_id}`; until it does, progress arrives on
/// `book-coverage-progress-{book_id}`.
#[tauri::command]
pub fn compute_book_coverage(book_id: String, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    let db = db.inner().clone();
    mark_running(&db, &book_id)?;
    spawn_computation(app, db, book_id);
    Ok(())
}

#[tauri::command]
pub fn get_vocab_profile(db: State<'_, Db>) -> AppResult<VocabProfileSummary> {
    load_vocab_profile_summary(&db)
}

/// Synchronous rather than spawned, unlike the coverage pass: this runs only
/// when the reader expands the list, and it does the frequency scan once for a
/// book whose word list is already in the database.
#[tauri::command]
pub fn get_book_unknown_words(
    book_id: String,
    count_familiar: bool,
    db: State<'_, Db>,
) -> AppResult<Vec<UnknownWord>> {
    crate::sync::validation::validate_entity_id(&book_id)?;
    load_unknown_words(&db, &book_id, count_familiar)
}

/// What the clearing dialog puts in its two columns (09).
///
/// Counted rather than described, because "会被清除 / 不受影响" is a promise
/// about this particular database and a reader with 214 682 exposure rows is
/// owed the number before they press the button, not a category name. The
/// spared column is not decoration: the single most common fear here is that
/// the word list goes with it, and the only convincing answer is its size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabProfileClearPreview {
    /// Words carrying an automatically-scored tier — the `mastery_progress`
    /// rows, all of which go.
    pub auto_mastery_words: i64,
    /// Rows in `reading_word_exposures`; the batched part of the delete.
    pub exposure_records: i64,
    /// Books with a coverage result that will have to be computed again.
    pub computed_books: i64,
    /// Tiers the reader set themselves. Untouched, and the reason the dialog
    /// has a second column at all.
    pub manual_words: i64,
    /// Words in the confirmed word list. Untouched.
    pub vocab_words: i64,
}

pub fn load_clear_preview(db: &Db) -> AppResult<VocabProfileClearPreview> {
    let conn = db.reader();
    let one = |sql: &str| -> AppResult<i64> { Ok(conn.query_row(sql, [], |row| row.get(0))?) };
    Ok(VocabProfileClearPreview {
        auto_mastery_words: one("SELECT COUNT(*) FROM mastery_progress")?,
        exposure_records: one("SELECT COUNT(*) FROM reading_word_exposures")?,
        computed_books: one("SELECT COUNT(*) FROM book_reader_coverage WHERE status = 'done'")?,
        manual_words: one(
            "SELECT COUNT(*) FROM vocab_words
              WHERE mastery_source <> 'auto' AND mastery <> 'new'",
        )?,
        vocab_words: one("SELECT COUNT(*) FROM vocab_words WHERE list_status = 'confirmed'")?,
    })
}

#[tauri::command]
pub fn preview_vocab_profile_clear(db: State<'_, Db>) -> AppResult<VocabProfileClearPreview> {
    load_clear_preview(&db)
}

/// Where the clearing dialog's progress and completion arrive (09b).
pub const CLEAR_PROGRESS_EVENT: &str = "vocab-profile-clear-progress";

/// Clear the automatically-derived half of the vocabulary profile.
///
/// The blast radius is §2.4(f), which is migration 064's radius, and the SQL
/// below is 064's SQL. Cleared: every exposure row, every credit row, the
/// automatic tier changes, the tiers those changes wrote, and every computed
/// coverage. Untouched: tiers the reader set themselves, the vocabulary list
/// and every FSRS field on it, lookup history, annotations, notes, each book's
/// own band distribution, and `reading_screen_dwells` — the raw record of what
/// happened on screen, which is honest data that was wrongly interpreted
/// rather than wrongly collected.
///
/// `mastery_source` becomes 'manual' on the rolled-back rows, exactly as 064
/// writes it. It reads oddly for a command the reader can run — they did not
/// personally decide these words are 'new' — but the alternative is worse:
/// leaving them 'auto' claims the scorer still stands behind a tier it has
/// just been told to withdraw. A word promoted again later is re-stamped
/// 'auto' by the scorer, so nothing is permanently exempted from a future
/// clear.
///
/// No sync events. Every table here except `vocab_words` is device-local by
/// design, and the confirmation dialog says in as many words that this clears
/// the local copy and leaves other devices alone.
pub(crate) fn clear_vocab_profile_inner(
    db: &Db,
    device: &str,
    now: i64,
    mut on_progress: impl FnMut(i64, i64),
) -> AppResult<i64> {
    let total: i64 = {
        let conn = db.reader();
        conn.query_row("SELECT COUNT(*) FROM reading_word_exposures", [], |row| {
            row.get(0)
        })?
    };
    on_progress(0, total);

    // Exposures go in batches so the dialog's counter moves on a table with
    // hundreds of thousands of rows, and so the write lock is released between
    // batches instead of being held for the whole delete. Everything after
    // them is small and goes in one transaction.
    let mut cleared = 0i64;
    loop {
        let removed = {
            let conn = db
                .conn
                .lock()
                .map_err(|error| AppError::Other(error.to_string()))?;
            conn.execute(
                "DELETE FROM reading_word_exposures
                  WHERE id IN (SELECT id FROM reading_word_exposures LIMIT ?1)",
                params![CLEAR_BATCH],
            )?
        };
        if removed == 0 {
            break;
        }
        cleared += removed as i64;
        on_progress(cleared, total);
    }

    {
        let mut conn = db
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM mastery_progress", [])?;
        tx.execute("DELETE FROM mastery_events WHERE source = 'auto'", [])?;
        tx.execute(
            "UPDATE vocab_words
                SET mastery = 'new',
                    mastery_source = 'manual',
                    mastery_reason = NULL,
                    updated_at = ?1,
                    updated_by_device = ?2
              WHERE mastery_source = 'auto'",
            params![now, device],
        )?;
        tx.execute("DELETE FROM book_reader_coverage", [])?;
        tx.commit()?;
    }

    on_progress(cleared, total);
    Ok(cleared)
}

#[tauri::command]
pub fn clear_vocab_profile(
    app: AppHandle,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let db = db.inner().clone();
    let device = sync.self_device().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    tauri::async_runtime::spawn_blocking(move || {
        let reporter = {
            let app = app.clone();
            move |cleared, total| {
                let _ = app.emit(
                    CLEAR_PROGRESS_EVENT,
                    ClearProgress {
                        cleared,
                        total,
                        done: false,
                    },
                );
            }
        };
        let cleared = match clear_vocab_profile_inner(&db, &device, now, reporter) {
            Ok(cleared) => cleared,
            Err(error) => {
                log::warn!("clearing the vocabulary profile failed: {error}");
                0
            }
        };
        let _ = app.emit(
            CLEAR_PROGRESS_EVENT,
            ClearProgress {
                cleared,
                total: cleared,
                done: true,
            },
        );
    });
    Ok(())
}

#[cfg(test)]
mod tests;
