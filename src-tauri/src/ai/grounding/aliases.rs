//! Person aliases: a per-book table mapping every other way a person might be
//! named — a translation, a shortening, a title — back to the spelling the
//! book itself uses, so a keyword query in the reader's own words can still
//! reach a passage that never uses that spelling. See
//! docs/impls/person-aliases.md.
//!
//! Deliberately the cheap half of a two-layer design. The other half —
//! rewriting an ambiguous question with a model before it hits retrieval —
//! would tax every query, including the large majority that already retrieve
//! well; this half taxes a book exactly once, at import, and then resolves a
//! query for free by string matching against what that one call found. See
//! the doc's "分两层，只做第一层" section for why the second layer is out of
//! scope entirely, not just deferred within this file.
//!
//! Two independent phases live here:
//! - The build pass (`ensure_person_aliases` / `build_person_aliases`): up to
//!   three model calls per book (see `run_build_pass`'s doc comment for the
//!   measured failure that retry budget exists for), producing rows in
//!   `book_person_aliases`.
//! - Query-time resolution (`resolve`): zero model calls, string matching
//!   against whatever the build pass already wrote, with a pronunciation
//!   fallback (see `find_unconsumed_pinyin_match`) for the one failure the
//!   build pass cannot help with — a reader whose IME handed them the wrong
//!   characters for the right sound.
//!
//! They share a table but nothing else — resolve() never touches the network
//! and the build pass never runs the matching logic — which is what makes
//! resolve() safe to call on every chat turn regardless of whether the build
//! pass ever ran, is still running, or failed outright: an empty alias table
//! just means resolve() always reports zero hits.

use std::collections::{HashMap, HashSet};

use pinyin::ToPinyin;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use super::segment::is_cjk;
use crate::ai::router::{self, AiRequestPurpose, AiRetryMode};
use crate::commands::ai::ChatMessage;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;
use crate::word_frequency;

/// This job's id in the automatic-analysis registry, and — by the registry's
/// own requirement — the exact string its call is tagged with in
/// `ai_usage_records.feature`. See `context::JOB_ID` for why this is one
/// constant instead of two literals that could drift.
pub const JOB_ID: &str = "person_aliases";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasEntryView {
    pub id: String,
    pub alias: String,
    pub source: String,
    pub mentions: i64,
    /// `"name"` | `"description"` — see the migration's doc comment. The
    /// index manager needs this to badge the two differently: a
    /// `description` row is the only kind resolve() does not currently act
    /// on (see `alias_groups`).
    pub kind: String,
    pub source_query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasGroupView {
    pub canonical: String,
    pub entries: Vec<AliasEntryView>,
}

/// Grouped by canonical for the index manager's table. Ordered by `mentions`
/// descending so the people the book actually spends its time on lead the
/// list — `mentions` is identical across every row that shares a canonical
/// (it counts occurrences of the canonical, not the alias), which is what
/// keeps those rows contiguous under this ordering and makes the group-by
/// below a single linear pass rather than a hash grouping.
pub fn list_person_aliases(conn: &Connection, book_id: &str) -> AppResult<Vec<AliasGroupView>> {
    let mut statement = conn.prepare(
        "SELECT id, canonical, alias, source, mentions, kind, source_query FROM book_person_aliases
         WHERE book_id = ?1 ORDER BY mentions DESC, canonical ASC, alias ASC",
    )?;
    let rows = statement
        .query_map(params![book_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut groups: Vec<AliasGroupView> = Vec::new();
    for (id, canonical, alias, source, mentions, kind, source_query) in rows {
        let entry = AliasEntryView { id, alias, source, mentions, kind, source_query };
        match groups.last_mut() {
            Some(group) if group.canonical == canonical => group.entries.push(entry),
            _ => groups.push(AliasGroupView { canonical, entries: vec![entry] }),
        }
    }
    Ok(groups)
}

/// How many `book_chunks` a string appears in verbatim. Doubles as the
/// build pass's verification step (see `run_build_pass`) and the number
/// shown on every row: a canonical that appears zero times either isn't in
/// this book at all, or was normalized by the model against the doc's
/// explicit instruction not to, and both cases get the same answer, "don't
/// keep it".
fn count_mentions(conn: &Connection, book_id: &str, text: &str) -> AppResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM book_chunks WHERE book_id = ?1 AND text LIKE '%' || ?2 || '%'",
        params![book_id, text],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

/// A reader teaching Lantern a name — or a description — it missed. `source =
/// 'user'` from here on out, even if a same-keyed row already exists from a
/// prior `'auto'` build — the whole point of `ON CONFLICT ... DO UPDATE` here
/// is that a manual correction always outranks whatever the model guessed,
/// and a rebuild (`run_build_pass`) is written to never touch a `'user'` row
/// once it holds that status (see its own doc comment).
///
/// `kind` is `"name"` or `"description"` (see the migration's doc comment).
/// `source_query` is meaningful only for `"description"` — the question the
/// reader was actually asking when they taught this row, kept because the
/// alias text alone ("那个总在拍马屁的牧师") is not self-explanatory outside
/// the context it was written in. It is dropped (stored as `NULL`) for
/// `"name"` rows, which carry their own meaning without it.
pub fn add_person_alias(
    db: &Db,
    book_id: &str,
    canonical: &str,
    alias: &str,
    kind: &str,
    source_query: Option<&str>,
) -> AppResult<String> {
    let canonical = canonical.trim();
    let alias = alias.trim();
    if canonical.is_empty() || alias.is_empty() {
        return Err(AppError::Other("PERSON_ALIAS_EMPTY".to_string()));
    }
    if kind != "name" && kind != "description" {
        return Err(AppError::Other("PERSON_ALIAS_INVALID_KIND".to_string()));
    }
    let source_query = if kind == "description" {
        source_query.map(str::trim).filter(|query| !query.is_empty())
    } else {
        None
    };
    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    let mentions = count_mentions(&conn, book_id, canonical)?;
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO book_person_aliases (id, book_id, canonical, alias, source, mentions, created_at, kind, source_query)
         VALUES (?1, ?2, ?3, ?4, 'user', ?5, ?6, ?7, ?8)
         ON CONFLICT(book_id, alias, canonical) DO UPDATE
         SET source = 'user', mentions = excluded.mentions, kind = excluded.kind, source_query = excluded.source_query",
        params![
            id,
            book_id,
            canonical,
            alias,
            mentions,
            chrono::Utc::now().timestamp_millis(),
            kind,
            source_query
        ],
    )?;
    // The insert above may have hit the ON CONFLICT branch, in which case an
    // existing row's id — not `id` — is the one that now carries this alias.
    conn.query_row(
        "SELECT id FROM book_person_aliases WHERE book_id = ?1 AND alias = ?2 AND canonical = ?3",
        params![book_id, alias, canonical],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub fn delete_person_alias(db: &Db, id: &str) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute("DELETE FROM book_person_aliases WHERE id = ?1", params![id])?;
    // A description row's vector lives in two more tables and SQLite will not
    // clean them up for us: this database opens with `PRAGMA foreign_keys=OFF`
    // (see db.rs), so migration 060's `REFERENCES` clause documents the
    // relationship without enforcing it. A vector left behind would go on
    // matching queries for an alias the reader has already deleted — the exact
    // "an alias learned wrong is worse than no alias" failure the doc's 界面
    // section says must always be reversible.
    super::vector::delete_alias_vectors(&conn, &[id])?;
    Ok(())
}

/// Teach one `'description'` alias and give it a vector in the same call.
///
/// A separate entry point rather than a `kind`-aware branch inside
/// `add_person_alias`, for two reasons. `add_person_alias` is synchronous and
/// several callers depend on that; embedding is not. And a `'name'` row has no
/// use for a vector — it is found by the substring scan in `resolve` — so
/// making every add pay for an embedding call would slow the common path to
/// serve the rare one.
///
/// The vector failing is not the save failing. If no embedding model is
/// configured, or the endpoint is down, or the call times out, the text row
/// stays and this returns `Ok`: the alias the reader just typed is the part
/// worth keeping, and `ensure_alias_embeddings` will fill in the vector the
/// next time the book's index runs. The alternative — refusing the save — would
/// throw away hand-typed text over a transient network error and ask the reader
/// to remember what they wrote.
///
/// Note that this is *not* a stage of the indexing pipeline. It runs inline
/// while the reader is still in the conversation, takes about one short
/// embedding round trip, and the alias is live on their very next question.
/// Nothing here shows a progress bar or asks for a reindex.
pub async fn teach_description_alias(
    db: &Db,
    secrets: &Secrets,
    book_id: &str,
    canonical: &str,
    alias: &str,
    source_query: Option<&str>,
) -> AppResult<String> {
    let id = add_person_alias(db, book_id, canonical, alias, "description", source_query)?;
    let source = match super::vector::source(db, secrets) {
        Ok(Some(source)) => source,
        Ok(None) => return Ok(id),
        Err(error) => {
            log::warn!("teach_description_alias: no embedding source: {error}");
            return Ok(id);
        }
    };
    // The alias text is embedded on its own, without the canonical name and
    // without `source_query`. It has to land in the same space as the reader's
    // *next* question, and that question will be a description too — folding in
    // the canonical name would pull the vector toward a spelling the reader by
    // definition did not use, which is the whole reason this row exists.
    let text = alias.trim().to_string();
    if let Err(error) = super::vector::embed_alias(db, &source, &id, book_id, &text).await {
        log::warn!("teach_description_alias: embedding failed, alias saved without a vector: {error}");
    }
    Ok(id)
}

/// Wipes everything for this book, `'user'` rows included. The one command
/// here that can destroy data a rebuild can't get back — the index manager's
/// confirmation copy is expected to say so plainly (see the doc's 界面
/// section), because this function itself has no way to warn twice.
pub fn clear_person_aliases(db: &Db, book_id: &str) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute("DELETE FROM book_person_aliases WHERE book_id = ?1", params![book_id])?;
    super::vector::delete_book_alias_vectors(&conn, book_id)?;
    Ok(())
}

/// Only the rows a prior build pass wrote, never a reader's own. Called
/// immediately before writing a fresh batch so a rebuild reflects the book as
/// it is now rather than accumulating every guess a model has ever made about
/// it, while leaving `'user'` rows — which no rebuild could reconstruct —
/// completely alone.
fn clear_auto_aliases(conn: &Connection, book_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM book_person_aliases WHERE book_id = ?1 AND source = 'auto'",
        params![book_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Build pass — one model call per book
// ---------------------------------------------------------------------------

const PERSON_ALIASES_SYSTEM_PROMPT: &str = "You are given a book's title, author, language, and its chapter summaries. List every named person in the book together with every other way they might be referred to.

Respond with a JSON array and nothing else — no prose before or after it:
[{\"canonical\": \"...\", \"aliases\": [\"...\", \"...\"]}, ...]

Rules:
- `canonical` must be copied verbatim from how the book itself writes that person's name. Do not normalize, translate, or standardize it — any canonical that cannot be found in the book word-for-word will be discarded before it is ever used.
- `aliases` should cover three kinds of alternate reference: common translations of the name into the language a reader of this edition would use, shortenings or alternate spellings the book itself uses (e.g. \"Lizzy\" for \"Elizabeth\"), and title or honorific variants (e.g. \"Mr. Darcy\" alongside \"Darcy\").
- List only people. Do not include places, organizations, or other named things, even where the book gives them proper names — place-name ambiguity is wide and the payoff is small, so this pass skips them entirely.
- Never invent a person who is not actually in the book.";

#[derive(Debug, Deserialize)]
struct RawAliasGroup {
    canonical: String,
    #[serde(default)]
    aliases: Vec<String>,
}

/// The widest `[...]`-delimited slice, on the same reasoning as
/// `review_pile_ai::extract_json_object`: models asked for "JSON only" still
/// sometimes wrap it in a code fence or a sentence, and the delimiters
/// themselves are the cheapest signal for where the real payload starts and
/// ends.
fn extract_json_array(text: &str) -> Option<&str> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    (end > start).then(|| &text[start..=end])
}

fn book_meta(conn: &Connection, book_id: &str) -> AppResult<(String, String, Option<String>)> {
    conn.query_row(
        "SELECT title, author, language FROM books WHERE id = ?1",
        params![book_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .map_err(Into::into)
}

/// The book's chapter-level summaries, already written by
/// `grounding::summarize` and joined in reading order. Reused rather than
/// rereading the book, per the doc's explicit instruction — this pass runs
/// once per book and a whole novel is a lot of tokens to spend finding names
/// that a few paragraphs of summary already names.
fn section_summaries(conn: &Connection, book_id: &str) -> AppResult<String> {
    let mut statement = conn.prepare(
        "SELECT content FROM book_summaries WHERE book_id = ?1 AND scope = 'section' ORDER BY section_index",
    )?;
    let parts = statement
        .query_map(params![book_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(parts.join("\n\n"))
}

fn build_messages(title: &str, author: &str, language: Option<&str>, summaries: &str) -> Vec<ChatMessage> {
    let mut header = format!("Title: {title}\nAuthor: {author}");
    if let Some(language) = language {
        header.push_str(&format!("\nLanguage: {language}"));
    }
    let body = if summaries.trim().is_empty() {
        // No summaries yet — still worth one call. Title and author alone can
        // surface a protagonist's well-known translated name; it just won't
        // find anyone the summaries would have.
        header
    } else {
        format!("{header}\n\nChapter summaries:\n{summaries}")
    };
    vec![
        ChatMessage { role: "system".to_string(), content: PERSON_ALIASES_SYSTEM_PROMPT.to_string() },
        ChatMessage { role: "user".to_string(), content: body },
    ]
}

/// Picks whichever string in `group` is actually verbatim in the book,
/// checking `canonical` first and falling back to `aliases` in the order the
/// model gave them, stopping at the first one with any mentions. Returns
/// `(winner, mentions, losers)`: `winner` becomes the inserted rows'
/// canonical, `mentions` is `count_mentions(winner)` — queried exactly once,
/// since the scan below stops at the first candidate that has any — and
/// `losers` is every other candidate the group offered (in that same
/// fallback order, deduped by exact text, with the winner and any empties
/// already removed), destined to become that canonical's aliases. `None`
/// means nothing in the group — not the canonical, not one alias — appears
/// in this book's text, and the whole group is discarded, same as before
/// this function existed.
///
/// Measured need: in every one of 6 correctly-oriented calls out of a
/// 12-call sample, the model wrote canonical `"Mr. Philips"`/`"Mrs. Philips"`
/// while the book itself spells it `"Phillips"` — with the correct spelling
/// sitting in that same group's `aliases`. In 2 of those 6 it also invented
/// canonicals the book never writes (`"Mary Bennet"`, `"Catherine Bennet"`)
/// while the forms the book actually uses (`"Mary"`, `"Kitty"`) sat in
/// `aliases`. Checking only `group.canonical`, as this pass used to, silently
/// drops a real character from the table both times.
fn resolve_group_canonical(
    conn: &Connection,
    book_id: &str,
    group: &RawAliasGroup,
) -> AppResult<Option<(String, i64, Vec<String>)>> {
    // Deduped by exact text, in "who gets asked first" order — the model's
    // own canonical, then its aliases in the order it listed them. Deduping
    // here, not just at the end, is what keeps the mentions scan below from
    // ever querying the same string twice.
    let mut seen: HashSet<&str> = HashSet::new();
    let mut candidates: Vec<&str> = Vec::new();
    let canonical = group.canonical.trim();
    if !canonical.is_empty() && seen.insert(canonical) {
        candidates.push(canonical);
    }
    for alias in &group.aliases {
        let alias = alias.trim();
        if !alias.is_empty() && seen.insert(alias) {
            candidates.push(alias);
        }
    }
    for candidate in &candidates {
        let mentions = count_mentions(conn, book_id, candidate)?;
        if mentions > 0 {
            let winner = candidate.to_string();
            let losers = candidates
                .iter()
                .filter(|text| **text != winner)
                .map(|text| text.to_string())
                .collect();
            return Ok(Some((winner, mentions, losers)));
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Three corrections layered on top of `resolve_group_canonical`'s winner,
// measured against a real book (*Embracing Hope*): 25 aliases, 5 wrong.
//
//   A. Row-level fabrication. `resolve_group_canonical` only proves *one*
//      candidate in a group has mentions — the group-level defense against a
//      model that invents a person outright. It says nothing about the other
//      candidates: "Mr. Darcy" being real does not make "Joel Young", sharing
//      its group, real too. 9 of 25 measured aliases were exactly this —
//      never in the book's text at all.
//   B. A bare surname that collides with a common English word. "Young" is
//      both a surname and a very common adjective; used as a canonical or
//      alias by itself, every ordinary sentence using the adjective becomes a
//      false match. Multi-word keys are exempt — "Joel Young" is unambiguous
//      even though "Young" alone is not.
//   C. A missed person, not a wrong judgment. "Vesely" and "Vesely-Frankl"
//      both pointed at "Alexander Vesely-Frankl" in the measured run, but the
//      book also has a different "Franz Vesely-Frankl" the model never
//      extracted as a canonical at all — so every question about Franz
//      silently resolved to Alexander. The fix is not a stricter filter (a
//      naive "drop on any ambiguity" rule would also throw away "Frankl",
//      142 mentions, overwhelmingly the book's most useful alias) — it is a
//      deterministic scan of the book's own text for a second full name this
//      alias also sits inside, registered as a second canonical. This reuses
//      the ambiguity representation `resolve()` already has —
//      `AliasRow`/`MatchedAlias.canonicals` already carry more than one
//      canonical per alias text, and `resolve()` already goes `Medium` and
//      picks the highest-`mentions` canonical as the default whenever that
//      happens — so "Vesely-Frankl" simply becomes two rows and the existing
//      query-time logic handles the rest unchanged.
//
// Order: A, then B, then C, applied in `evaluate_attempt` as (1) B on the
// winner, (2) A per surviving alias, (3) B per alias that survived A, (4) C
// over only the aliases left after 1–3, with B re-applied to whatever C
// discovers. See `evaluate_attempt`'s own doc comment for the full
// rationale — in particular why A before B is a cost ordering, not a
// correctness one, and why C must run last: a fabricated or common-word
// alias must never reach the text scan that discovers a new canonical, both
// because there is nothing real to expand from and because scanning a common
// word's neighborhood is exactly the kind of input that would manufacture a
// false "new person" out of an ordinary capitalized sentence.
// ---------------------------------------------------------------------------

/// The text of every `book_chunks` row that might contain `text` — the same
/// coarse `LIKE '%x%'` pre-filter `count_mentions` runs, but returning the
/// rows instead of counting them. Both `alias_occurs_in_book` (change A) and
/// `name_runs_for_alias` (change C) need the actual characters to run their
/// own boundary/token logic against; `count_mentions` staying a chunk count
/// is fine for its existing callers (see its own doc comment) but cannot
/// answer either of those questions.
fn chunks_containing(conn: &Connection, book_id: &str, text: &str) -> AppResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT text FROM book_chunks WHERE book_id = ?1 AND text LIKE '%' || ?2 || '%'",
    )?;
    let rows = statement
        .query_map(params![book_id, text], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Change A: whether `alias` occurs anywhere in this book's text under the
/// *same* word-boundary rule `resolve()`'s own scan uses
/// (`find_unconsumed_match`'s `is_word_char` boundary, via a fresh empty
/// `consumed` array since this only asks "does it occur at all", never "at
/// which position"). This is deliberately not `count_mentions(...) > 0`:
/// `count_mentions` is a raw `LIKE '%x%'` substring test with no word
/// boundary, so a short Latin alias like "Young" would count as occurring
/// inside "younger" — exactly the false positive that would let a
/// fabricated-looking alias slip past this check. The `LIKE` scan inside
/// `chunks_containing` is only the pre-filter here, narrowing to the handful
/// of chunks that could possibly contain `alias`; the real verdict is the
/// boundary check run against each one's actual text.
fn alias_occurs_in_book(conn: &Connection, book_id: &str, alias: &str) -> AppResult<bool> {
    let needle: Vec<char> = alias.to_lowercase().chars().collect();
    if needle.is_empty() {
        return Ok(false);
    }
    for chunk_text in chunks_containing(conn, book_id, alias)? {
        let haystack: Vec<char> = chunk_text.to_lowercase().chars().collect();
        let consumed = vec![false; haystack.len()];
        if find_unconsumed_match(&haystack, &needle, &consumed).is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Change B: true when `text` is a *single* word — no internal whitespace —
/// common enough that it cannot safely be used as a person key: rank within
/// the top 3 000 of `crate::word_frequency`'s fiction frequency table, i.e.
/// bands 1–2 (`FrequencyEntry::band <= 2`). A bare surname that is also a
/// common noun or adjective ("Young") turns every ordinary sentence using
/// that word into a false match.
///
/// Multi-word keys ("Joel Young", "Mr. Darcy") are never rejected, even
/// though they may contain a common word — "Young" alone reads as the
/// adjective, but the two words together do not, and the frequency table has
/// nothing to say about a phrase, only a single word.
///
/// `forms` is threaded in rather than built fresh here — see
/// `word_frequency::FormIndex`'s own doc comment on why a shared index
/// matters once more than one lookup happens per book, which is exactly
/// `evaluate_attempt`'s situation (every candidate in every group).
fn is_common_single_word(forms: &word_frequency::FormIndex<'_>, text: &str) -> AppResult<bool> {
    if text.split_whitespace().count() != 1 {
        return Ok(false);
    }
    let Some(entry) = word_frequency::lookup_with(forms, text)? else {
        return Ok(false);
    };
    Ok(entry.band <= 2)
}

/// A maximal run of name-shaped characters in some text's `char` sequence —
/// letters, digits, and the marks a name can legitimately contain in the
/// middle without splitting into two tokens (hyphen, period, apostrophe) —
/// together with its `char`-index span. "Vesely-Frankl" and "Mr." are each
/// one token; the comma after either would not be, since a comma has no
/// business inside a name. This is change C's unit of work, deliberately
/// coarser than `is_word_char` (which has no hyphen/period/apostrophe at
/// all): the boundary scan needs to tell a name apart from the word next to
/// it, but this needs to tell a whole name apart from the punctuation around
/// it.
struct NameToken {
    text: String,
    start: usize,
    end: usize,
}

fn is_name_token_char(character: char) -> bool {
    character.is_alphanumeric() || character == '-' || character == '.' || character == '\''
}

fn name_tokens(chars: &[char]) -> Vec<NameToken> {
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if is_name_token_char(chars[index]) {
            let start = index;
            while index < chars.len() && is_name_token_char(chars[index]) {
                index += 1;
            }
            tokens.push(NameToken { text: chars[start..index].iter().collect(), start, end: index });
        } else {
            index += 1;
        }
    }
    tokens
}

/// Lowercase name-particle connectors that can sit *between* two capitalized
/// tokens without breaking a name run ("Ludwig van Beethoven"). Deliberately
/// small and Western-European rather than exhaustive — this only needs to
/// cover the kind of names this build pass already targets: translated,
/// shortened, or honorific variants of a Latin-script name.
const NAME_CONNECTORS: &[&str] =
    &["van", "de", "von", "der", "den", "la", "le", "di", "da", "del", "dos", "das"];

fn is_connector(token: &str) -> bool {
    NAME_CONNECTORS.contains(&token.to_lowercase().as_str())
}

fn starts_uppercase(token: &str) -> bool {
    token.chars().next().is_some_and(char::is_uppercase)
}

/// Whether `chars[from..to]` is nothing but plain ASCII spaces — the gap
/// between two tokens has to be exactly this for a name run to cross it. A
/// comma, a quote mark, a newline (paragraph break), or the double space
/// around an em dash all mean the tokens on either side belong to different
/// clauses, not one name, and expansion must stop there rather than splice
/// them together.
fn gap_is_plain_space(chars: &[char], from: usize, to: usize) -> bool {
    from <= to && chars[from..to].iter().all(|&character| character == ' ')
}

/// Grows the token span `[left, right)` outward across `tokens` for as long
/// as the next token is capitalized, or is a `NAME_CONNECTORS` word
/// immediately followed (on that same side) by a capitalized token — "van"
/// alone at the edge of a run is never included on its own, only "van
/// Beethoven" together, so a stray lowercase preposition can never dangle
/// off the end of an extracted name. Only ever grows outward from the
/// caller's own `[left, right)`; never shrinks it.
fn expand_name_run(tokens: &[NameToken], chars: &[char], mut left: usize, mut right: usize) -> (usize, usize) {
    while right < tokens.len() && gap_is_plain_space(chars, tokens[right - 1].end, tokens[right].start) {
        let token = &tokens[right];
        if starts_uppercase(&token.text) {
            right += 1;
        } else if is_connector(&token.text)
            && right + 1 < tokens.len()
            && gap_is_plain_space(chars, token.end, tokens[right + 1].start)
            && starts_uppercase(&tokens[right + 1].text)
        {
            right += 2;
        } else {
            break;
        }
    }
    while left > 0 && gap_is_plain_space(chars, tokens[left - 1].end, tokens[left].start) {
        let token = &tokens[left - 1];
        if starts_uppercase(&token.text) {
            left -= 1;
        } else if left >= 2
            && is_connector(&token.text)
            && gap_is_plain_space(chars, tokens[left - 2].end, token.start)
            && starts_uppercase(&tokens[left - 2].text)
        {
            left -= 2;
        } else {
            break;
        }
    }
    (left, right)
}

/// The index of the next run of consecutive whole tokens, at or after
/// `from`, whose lowercased text equals `alias_words` word for word — or
/// `None`. Whole tokens only: `name_tokens` never splits "younger" at a
/// boundary the way `find_unconsumed_match`'s `is_word_char` rule does, so
/// this compares complete token text rather than a substring, and "Young"
/// can no more match inside a "younger" token than change A's boundary check
/// can.
fn find_token_span(tokens: &[NameToken], alias_words: &[String], from: usize) -> Option<usize> {
    let width = alias_words.len();
    if width == 0 || tokens.len() < width {
        return None;
    }
    (from..=tokens.len() - width).find(|&start| {
        (0..width).all(|offset| tokens[start + offset].text.to_lowercase() == alias_words[offset])
    })
}

/// Change C's raw material: every distinct capitalized name run `alias`
/// turns up inside, across every chunk it appears in, deduplicated by text.
/// "Alexander Vesely-Frankl" mentioned three times is one entry, because
/// what the caller wants to know is *which* full forms this alias keeps
/// showing up inside, not how often each one does.
///
/// Every run returned strictly contains the alias's own tokens —
/// `expand_name_run` only ever grows a span outward from wherever
/// `find_token_span` anchored it — so a run identical to the alias itself
/// (no expansion happened) is still reported; it is the caller's job (see
/// `evaluate_attempt`) to filter those already-known forms out, not this
/// function's, because "known" is relative to one group's own vocabulary,
/// which this function has no view of.
fn name_runs_for_alias(conn: &Connection, book_id: &str, alias: &str) -> AppResult<Vec<String>> {
    let alias_words: Vec<String> = alias.split_whitespace().map(str::to_lowercase).collect();
    if alias_words.is_empty() {
        return Ok(Vec::new());
    }
    let mut runs: Vec<String> = Vec::new();
    for chunk_text in chunks_containing(conn, book_id, alias)? {
        let chars: Vec<char> = chunk_text.chars().collect();
        let tokens = name_tokens(&chars);
        let mut from = 0;
        while let Some(start) = find_token_span(&tokens, &alias_words, from) {
            let (left, right) = expand_name_run(&tokens, &chars, start, start + alias_words.len());
            let run = tokens[left..right].iter().map(|token| token.text.as_str()).collect::<Vec<_>>().join(" ");
            // A run that lands at the end of a sentence carries that
            // sentence's own full stop as part of its last token (a period
            // is a name-token character, for "Mr." and "St."'s sake) —
            // trimmed once at the very end, on the assembled string, so it
            // strips a genuinely trailing sentence period without touching
            // an internal one like "Mr."'s.
            let run = run.trim_end_matches('.').to_string();
            if !run.is_empty() && !runs.contains(&run) {
                runs.push(run);
            }
            from = start + 1;
        }
    }
    Ok(runs)
}

/// What one model call, having already been parsed into `raw`, resolves to
/// once every group has been run through `resolve_group_canonical`.
#[derive(Debug, PartialEq, Eq)]
enum AttemptOutcome {
    /// Clear the old `'auto'` rows and write these — `(canonical, alias,
    /// mentions)` triples, one per surviving alias. Empty is a valid payload
    /// here, not a failure: it is what a `raw` that was itself empty produces
    /// (a book the model believes has no named people), and that is a real
    /// answer, not the measured failure this type also has to represent.
    Commit(Vec<(String, String, i64)>),
    /// `raw` was non-empty but not one group in it survived
    /// `resolve_group_canonical` — the measured 0%-yield signature: a
    /// parseable, well-formed response with the book's actual names nowhere
    /// in it. Distinct from `Commit(vec![])` on purpose, because the caller's
    /// response to the two is opposite — accept the former, retry the
    /// latter.
    Unusable,
}

/// How one model call ended. `AttemptOutcome` only describes what a *parsed*
/// response resolves to, so the response that never parsed lives out here.
///
/// It exists because the two failures were not equally served by the retry
/// budget. A response with no JSON array in it used to be raised as
/// `PERSON_ALIASES_AI_INVALID` with `?` from inside the attempt, which
/// propagated straight out of `run_build_pass`'s loop and ended the build on
/// the first try — while `Unusable`, right next to it, got all three attempts.
/// Measured on a real library, that was backwards: over 18 passes the
/// unreadable case cost 3 builds and `Unusable` cost none, and a rebuild that
/// simply asked again nearly always worked. Both are one sample of a
/// non-deterministic response, so both retry.
#[derive(Debug, PartialEq, Eq)]
enum AttemptResult {
    Parsed(AttemptOutcome),
    /// No JSON array in the reply, or one that would not deserialize.
    Unreadable,
}

/// Pure past the reads `resolve_group_canonical` and changes A/B/C need
/// (`count_mentions`, `alias_occurs_in_book`, `word_frequency::lookup_with`,
/// `name_runs_for_alias`) — no writes, no network — so a test can reach the
/// commit/retry decision directly, the same way `merge_description_candidates`
/// lets a test reach pass two's decisions without a database or a network.
/// `db` is only needed for change B's frequency lookup (`FormIndex::new`
/// wants the whole `Db`, not just a connection, to build its lemma fallback
/// lazily); every other check here still goes through `conn` alone.
///
/// **Why this order.** See the doc comment on the block above this function
/// for what each change fixes; this is the order they run in and why it has
/// to be this order, not some other one:
///
/// 1. **B on the winner.** If the winner itself is one common word
///    ("Young"), the whole group is worthless — every ordinary use of that
///    word would become a false match — so this is checked before any
///    per-alias work at all, and a hit skips straight to the next group.
/// 2. **A per surviving alias.** Drop it if it never actually occurs in the
///    book, word-boundary checked. `resolve_group_canonical`'s own mentions
///    check only proves *something* in the group is real; it says nothing
///    about any one alias.
/// 3. **B per alias that survived A.** Drop it if it is itself one common
///    word. A before B here is a cost ordering, not a correctness one — the
///    two are independent predicates on the same row, so either order keeps
///    the same survivors — but A's chunk-text scan is already needed for
///    change C below, while B's frequency lookup is a database round trip on
///    a miss (`FormIndex`'s lemma fallback); running the free check first
///    means a fabricated alias never reaches the paid one.
/// 4. **C, over only the aliases that survived 2 and 3.** A fabricated alias
///    has no real occurrences to expand from, and a common-word alias is
///    exactly the kind of string whose neighborhood in an ordinary sentence
///    would manufacture a false "new person" — so C only ever expands from
///    names this pass already trusts. Each name run C discovers is run back
///    through `is_common_single_word` (not a new rule — the same call)
///    before being kept as a new canonical: extraction can land on a
///    sentence-initial common word exactly as easily as the model can
///    hallucinate one, and a new canonical deserves no less scrutiny than
///    the ones the model proposed directly. In practice this second B check
///    can never actually reject anything here, because `expand_name_run`
///    only ever *grows* a span outward from the alias's own token span — a
///    run reaching this check has already failed the "equals a known form"
///    test the caller runs first, which means it strictly contains more
///    tokens than the (already non-empty) alias, and is therefore always
///    multi-word. It stays in, at essentially no cost, as documentation of
///    intent and a guard against a future change to the expansion algorithm
///    quietly reopening that door.
fn evaluate_attempt(
    conn: &Connection,
    db: &Db,
    book_id: &str,
    raw: &[RawAliasGroup],
) -> AppResult<AttemptOutcome> {
    // `conn` and `db` are both needed and must not be the same lock: on a
    // frequency-table miss `forms` takes `db.reader()` itself, so a caller
    // holding that same guard as `conn` would deadlock the thread against
    // itself. `Db::new` gives `read_conn` its own connection, so the app's
    // path (`attempt_build`, holding `db.conn`) is safe — but
    // `Db::open_readonly`/`open_readwrite` alias the two, and the build pass
    // must never be reached from there. It currently cannot: the `lantern
    // mcp` subprocess is the only user of those constructors and exposes no
    // index-building tool.
    let forms = word_frequency::FormIndex::new(db);
    let mut rows: Vec<(String, String, i64)> = Vec::new();
    for group in raw {
        // The hallucination defense the doc requires, now judged on the whole
        // group rather than a single field: whichever string ends up as the
        // canonical, one that isn't actually in this book's text is worse
        // than no entry at all, because it becomes a query-expansion term
        // with nothing in the book for it to correctly match.
        let Some((winner, winner_mentions, losers)) = resolve_group_canonical(conn, book_id, group)?
        else {
            continue;
        };
        if is_common_single_word(&forms, &winner)? {
            continue;
        }

        let mut survivors: Vec<String> = Vec::new();
        for loser in losers {
            if !alias_occurs_in_book(conn, book_id, &loser)? {
                continue;
            }
            if is_common_single_word(&forms, &loser)? {
                continue;
            }
            survivors.push(loser);
        }

        // Change C. `known_forms` starts as the winner plus every surviving
        // alias — this group's full known vocabulary for this one person —
        // and grows as new canonicals are discovered, so the same missed
        // person found via two different aliases (e.g. both "Vesely" and
        // "Vesely-Frankl" leading to "Franz Vesely-Frankl") is registered
        // once, not twice.
        let mut known_forms: HashSet<String> = std::iter::once(winner.to_lowercase())
            .chain(survivors.iter().map(|alias| alias.to_lowercase()))
            .collect();
        let mut new_canonicals: Vec<(String, Vec<String>)> = Vec::new();
        for alias in &survivors {
            for run in name_runs_for_alias(conn, book_id, alias)? {
                let key = run.to_lowercase();
                if known_forms.contains(&key) || is_common_single_word(&forms, &run)? {
                    continue;
                }
                known_forms.insert(key.clone());
                match new_canonicals.iter_mut().find(|(name, _)| name.to_lowercase() == key) {
                    Some((_, aliases)) => aliases.push(alias.clone()),
                    None => new_canonicals.push((run, vec![alias.clone()])),
                }
            }
        }

        // Each survivor keeps `winner_mentions` — the existing convention
        // (see `list_person_aliases`'s row shape): `mentions` is a fact
        // about the canonical, the same across every alias row that shares
        // it, not a count of that one alias's own occurrences.
        for alias in survivors {
            rows.push((winner.clone(), alias, winner_mentions));
        }
        for (new_canonical, aliases) in new_canonicals {
            let mentions = count_mentions(conn, book_id, &new_canonical)?;
            if mentions == 0 {
                // Should not happen — `new_canonical` was just read out of a
                // chunk's own text — but a row whose canonical this pass has
                // never actually confirmed is worse than no row, so this
                // stays defensive rather than trusting the extraction
                // blindly.
                continue;
            }
            for alias in aliases {
                rows.push((new_canonical.clone(), alias, mentions));
            }
        }
    }
    if !raw.is_empty() && rows.is_empty() {
        return Ok(AttemptOutcome::Unusable);
    }
    Ok(AttemptOutcome::Commit(rows))
}

/// At most this many model calls per build pass, for one measured reason:
/// roughly half of a 12-call sample of real model output came back completely
/// unusable (see `run_build_pass`'s doc comment). At that rate a single retry
/// would still land on two unusable calls in a row close to a quarter of the
/// time; three attempts pushes three-in-a-row under 15%, which is as far as
/// it is worth stretching a background job before surfacing an error instead
/// of silently retrying forever.
const MAX_BUILD_ATTEMPTS: u32 = 3;

/// Shared by both callers below: the automatic trigger passes `origin =
/// "auto"`, the reader's own rebuild button passes `origin = "user"`.
///
/// This pass retries, and on a failure mode `router` cannot see. It used to
/// reason that it didn't need to: `router::complete_with_failover` already
/// retries and fails over across providers for transport-level trouble — a
/// timeout, a 5xx, a dropped connection — and a single call here has no "five
/// in a row" of *those* to count. That reasoning covered only the failure
/// mode router can see. A 12-call sample of real model output came back
/// well-formed, parseable, HTTP-200 in 11 of 12 cases — but with `canonical`
/// and `aliases` effectively swapped in 5 of those 11: Chinese text in
/// `canonical`, the correct spelling sitting in `aliases`. Before this fix,
/// the `mentions == 0` hallucination check rejected every group in an
/// inverted response, `book_person_aliases` ended up completely empty, and
/// the call still returned `Ok(())` — nothing router's retry logic can catch,
/// because the response isn't malformed, just unusable.
/// `resolve_group_canonical` recovers the inversions where the right
/// spelling was still present somewhere in the group (2 of those 5, measured);
/// the loop below, driven by `evaluate_attempt` returning
/// `AttemptOutcome::Unusable`, is what handles the rest — a call that comes
/// back with the book's actual spelling nowhere in it at all.
/// One model call and the decision it resolves to, with the model's own words
/// handed back alongside.
///
/// Split out of the loop below for two reasons. The retry rate *is* the thing
/// this pass exists for, and a test that could only observe the loop's final
/// verdict could not report it — it would see "the build worked" and never
/// learn that it took three calls. And a failed call's raw text is the only
/// evidence of *how* it failed; discarding it inside the loop meant every
/// measurement so far had to be run by hand to keep it.
///
/// No writes here. Everything destructive stays in the loop, where the reader
/// of `run_build_pass` can see it against the retry logic that guards it.
async fn attempt_build<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    book_id: &str,
    origin: &str,
    messages: &[ChatMessage],
) -> AppResult<(String, AttemptResult)> {
    let completion = router::complete_with_failover(
        app,
        db,
        secrets,
        messages,
        Some(2_000),
        AiRequestPurpose::Analysis,
        AiRetryMode::Automatic,
        None,
        None,
        origin,
        JOB_ID,
    )
    .await?;
    let result = {
        let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
        classify_reply(&conn, db, book_id, &completion.text)?
    };
    Ok((completion.text, result))
}

/// One reply, all the way to the retry decision, with no network and no
/// writes — so a test can hand it a string and assert which of the three
/// endings it is. Everything `attempt_build` does besides making the call.
fn classify_reply(conn: &Connection, db: &Db, book_id: &str, text: &str) -> AppResult<AttemptResult> {
    let Some(json_slice) = extract_json_array(text) else {
        return Ok(AttemptResult::Unreadable);
    };
    let Ok(raw) = serde_json::from_str::<Vec<RawAliasGroup>>(json_slice) else {
        return Ok(AttemptResult::Unreadable);
    };
    Ok(AttemptResult::Parsed(evaluate_attempt(conn, db, book_id, &raw)?))
}

/// Returns how many model calls it took. Neither caller needs the number —
/// both discard it — but a measurement of this pass does: "the build worked"
/// and "the build worked on the third try" describe very different odds, and
/// the retry budget can only be judged against the second.
async fn run_build_pass<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    book_id: &str,
    origin: &str,
) -> AppResult<u32> {
    let (title, author, language) = book_meta(&db.reader(), book_id)?;
    let summaries = section_summaries(&db.reader(), book_id)?;
    let messages = build_messages(&title, &author, language.as_deref(), &summaries);

    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let (_, result) = attempt_build(app, db, secrets, book_id, origin, &messages).await?;
        match result {
            // Deliberately no write at all on either failing branch — not even
            // `clear_auto_aliases`. That call only ever runs in the `Commit`
            // branch below, so a run that never produces a usable response
            // leaves `book_person_aliases` exactly as it was before this call
            // started: a prior successful build's rows, or nothing. The reader
            // sees an error, never a table that used to have names in it and
            // now doesn't because a retry cleared it out from under a failed
            // attempt.
            //
            // Which error the reader sees is decided by the *last* attempt, not
            // by whichever failure came first: it is the one whose response
            // they could ask us about.
            AttemptResult::Unreadable => {
                if attempt >= MAX_BUILD_ATTEMPTS {
                    return Err(AppError::Ai("PERSON_ALIASES_AI_INVALID".to_string()));
                }
            }
            AttemptResult::Parsed(AttemptOutcome::Unusable) => {
                if attempt >= MAX_BUILD_ATTEMPTS {
                    return Err(AppError::Ai("PERSON_ALIASES_AI_UNUSABLE".to_string()));
                }
            }
            AttemptResult::Parsed(AttemptOutcome::Commit(rows)) => {
                let conn = db.conn.lock().map_err(|error| AppError::Other(error.to_string()))?;
                clear_auto_aliases(&conn, book_id)?;
                let now = chrono::Utc::now().timestamp_millis();
                for (canonical, alias, mentions) in &rows {
                    let id = uuid::Uuid::new_v4().to_string();
                    // DO NOTHING, not DO UPDATE: the only way this can
                    // conflict, right after `clear_auto_aliases` wiped every
                    // prior `'auto'` row, is a `'user'` row already sitting
                    // on this exact (alias, canonical) pair — and a reader's
                    // own correction must never be overwritten by a fresh
                    // guess that happens to land on the same words.
                    //
                    // `kind` is always 'name' here: the model is asked for
                    // people's names, not descriptions of them, and
                    // 'description' rows only ever come from a reader
                    // teaching one by hand (`add_person_alias`) — this pass
                    // has no path that could produce one.
                    conn.execute(
                        "INSERT INTO book_person_aliases (id, book_id, canonical, alias, source, mentions, created_at, kind, source_query)
                         VALUES (?1, ?2, ?3, ?4, 'auto', ?5, ?6, 'name', NULL)
                         ON CONFLICT(book_id, alias, canonical) DO NOTHING",
                        params![id, book_id, canonical, alias, mentions, now],
                    )?;
                }
                return Ok(attempt);
            }
        }
    }
}

/// The book a build pass is currently running for. Unlike `context.rs`'s
/// single global slot — appropriate there because its run is a sequential
/// loop of many calls that must never overlap itself — this pass is one call
/// per book, so guarding per-book rather than globally lets two different
/// books build at once without either one waiting on the other for no reason.
static RUNNING_BOOKS: std::sync::Mutex<Option<HashSet<String>>> = std::sync::Mutex::new(None);

struct RunGuard {
    book_id: String,
}

impl RunGuard {
    /// `None` when this book already has a build pass in flight.
    fn claim(book_id: &str) -> Option<Self> {
        let mut running = RUNNING_BOOKS.lock().ok()?;
        let set = running.get_or_insert_with(HashSet::new);
        if !set.insert(book_id.to_string()) {
            return None;
        }
        Some(Self { book_id: book_id.to_string() })
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = RUNNING_BOOKS.lock() {
            if let Some(set) = running.as_mut() {
                set.remove(&self.book_id);
            }
        }
    }
}

fn person_aliases_enabled(db: &Db) -> bool {
    crate::commands::auto_analysis::is_enabled(&db.reader(), JOB_ID)
}

/// The automatic trigger, fired once when a book is imported (see the
/// `BookImported` entry this job registers in `commands::auto_analysis`). A
/// second call for a book already building, or a book whose switch is off,
/// is a silent no-op — this runs in the background, so there is no reader
/// waiting on an error the way there is for the manual button below.
pub async fn ensure_person_aliases<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    book_id: &str,
) -> AppResult<()> {
    if !person_aliases_enabled(db) {
        return Ok(());
    }
    let Some(_guard) = RunGuard::claim(book_id) else {
        return Ok(());
    };
    run_build_pass(app, db, secrets, book_id, "auto").await.map(|_| ())
}

/// The reader's own rebuild button. Runs regardless of the automatic-analysis
/// switch — see the registry module doc's second rule, that turning a job off
/// only removes its automatic trigger, never the feature itself. Reports a
/// clash rather than silently doing nothing, unlike the automatic path: a
/// reader who pressed a button expects either a result or an explanation, not
/// quiet success that isn't one.
pub async fn build_person_aliases<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    book_id: &str,
) -> AppResult<()> {
    let Some(_guard) = RunGuard::claim(book_id) else {
        return Err(AppError::Other("PERSON_ALIASES_ALREADY_RUNNING".to_string()));
    };
    run_build_pass(app, db, secrets, book_id, "user").await.map(|_| ())
}

// ---------------------------------------------------------------------------
// Query-time resolution — zero model calls
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AliasConfidence {
    /// At least one alias matched *on its exact characters*, and every alias
    /// that matched resolves to exactly one canonical. Nothing is shown — the
    /// expansion is silently folded into the query.
    High,
    /// At least one matched alias resolves to more than one canonical, so the
    /// expansion is a guess among them — or the match came from the
    /// pronunciation fallback, which is a guess about which characters the
    /// reader meant no matter how unambiguous the alias it landed on. Surfaced
    /// above the answer as "found by X" with a way to swap in someone else.
    Medium,
    /// Nothing matched, and the query's script differs from the book's own
    /// language — the one shape this whole feature exists for: a reader
    /// asking in a language the book was never written to be searched in.
    /// Surfaced above the answer as "couldn't tell who", with a confirm/pick
    /// pair below it.
    Low,
    /// Nothing matched, and nothing about the query suggests a name this
    /// table is missing — same script as the book, or the book's language
    /// isn't known well enough to compare against. Deliberately distinct from
    /// `Low`: the doc's acceptance rule is explicit that a same-script zero
    /// hit (e.g. "what is this book about") must not be flagged as an
    /// unrecognised person, since it usually isn't asking about one at all.
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedAlias {
    pub alias: String,
    pub canonicals: Vec<String>,
    /// This entry came from the pronunciation fallback, not from the reader's
    /// own characters — they wrote 达希 and this alias is 达西. Nothing reads
    /// it yet; it exists so the disclosure line can eventually say which kind
    /// of guess it is (a wrong-character correction reads very differently
    /// from a pick among namesakes) without a second schema change, and so
    /// the `Medium` cap below is inspectable rather than merely asserted.
    pub pinyin: bool,
    /// This entry came from pass two — a `kind = 'description'` row matched by
    /// cosine similarity against the query embedding, not by any character the
    /// reader typed. The disclosure line reads differently for it: an
    /// ambiguity between two people needs a name to swap to, a description
    /// match needs to say that the match was made on meaning. It is also the
    /// only kind of match that renders a line while having exactly one
    /// canonical, so the UI cannot infer it from `canonicals.len()`.
    #[serde(default)]
    pub description: bool,
}

impl MatchedAlias {
    /// The only constructor for a pass-two hit. Private on purpose: rule 5 of
    /// this feature is that a description match is `Medium` and never `High`,
    /// however high the cosine came out, and the way to keep that from leaking
    /// is to have exactly one place that can build one — the same reasoning
    /// `chat.rs::alias_disclosure_payload` documents for refusing to construct
    /// a payload it expects the UI to ignore.
    fn description(alias: String, canonicals: Vec<String>) -> Self {
        Self { alias, canonicals, pinyin: false, description: true }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasResolution {
    pub confidence: AliasConfidence,
    pub matched: Vec<MatchedAlias>,
    /// The tie-break for a `Medium` match — the highest-`mentions` canonical
    /// among whichever matched alias was ambiguous, or, on the pronunciation
    /// fallback, among every alias that matched by sound. `None` unless
    /// confidence is `Medium`. A pinyin hit gets one even when its alias has a
    /// single canonical, because the name is the entire content of that
    /// disclosure: "I read this as X" has nothing to say without an X.
    pub default_canonical: Option<String>,
    /// The original query with every matched canonical appended. Additive
    /// only, per the doc: the original text is never rewritten or
    /// shortened, only extended, so a query resolve() gets wrong can only
    /// ever retrieve the same or more, never less.
    pub expanded_query: String,
}

struct AliasRow {
    canonical: String,
    mentions: i64,
}

/// One row per distinct alias *text* in this book, carrying every canonical
/// it could mean. `resolve` scans against alias text once, not once per
/// (alias, canonical) row — a row count of 2 for "达西小姐" is what makes it
/// ambiguous, not two separate substring searches for it.
fn alias_groups(conn: &Connection, book_id: &str) -> AppResult<Vec<(String, Vec<AliasRow>)>> {
    let mut statement = conn.prepare(
        // `kind = 'name'` only. 'description' rows ("那个总在拍马屁的牧师" →
        // Mr. Collins) exist in the same table but do not belong in this
        // scan: exact substring matching is close to useless for them — one
        // reworded phrase and it misses — so a partial hit here would be a
        // false positive, which is worse than reporting no match. They are
        // matched by embedding similarity instead, in `resolve_descriptions`
        // further down this file. Do not
        // "fix" this filter to fall back to substring-matching them; that is
        // the bug this filter exists to prevent, not an oversight.
        "SELECT alias, canonical, mentions FROM book_person_aliases WHERE book_id = ?1 AND kind = 'name'",
    )?;
    let rows = statement
        .query_map(params![book_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut by_alias: HashMap<String, Vec<AliasRow>> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (alias, canonical, mentions) in rows {
        if !by_alias.contains_key(&alias) {
            order.push(alias.clone());
        }
        by_alias.entry(alias).or_default().push(AliasRow { canonical, mentions });
    }
    // Longest alias first (by character count, not bytes — a CJK alias of
    // four characters is 12 UTF-8 bytes and must still outrank a two-character
    // one). Ties broken by the alias text itself purely so the scan order is
    // deterministic and tests aren't at the mercy of hash-map iteration order.
    order.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()).then_with(|| a.cmp(b)));
    Ok(order
        .into_iter()
        .map(|alias| {
            let rows = by_alias.remove(&alias).unwrap_or_default();
            (alias, rows)
        })
        .collect())
}

fn is_word_char(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// Finds the first still-unconsumed occurrence of `needle` in `haystack`
/// (both already lowercased char slices), or `None`. CJK aliases match on
/// bare substring — Chinese has no spaces, so there is no boundary to check.
/// Everything else requires a non-word character (or the string edge) on
/// both sides, the same rule that keeps "Eliza" from matching inside
/// "Elizabeth".
fn find_unconsumed_match(haystack: &[char], needle: &[char], consumed: &[bool]) -> Option<(usize, usize)> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let needs_boundary = !needle.iter().copied().any(is_cjk);
    'positions: for start in 0..=haystack.len() - needle.len() {
        let end = start + needle.len();
        for offset in 0..needle.len() {
            if consumed[start + offset] || haystack[start + offset] != needle[offset] {
                continue 'positions;
            }
        }
        if needs_boundary {
            let left_ok = start == 0 || !is_word_char(haystack[start - 1]);
            let right_ok = end == haystack.len() || !is_word_char(haystack[end]);
            if !(left_ok && right_ok) {
                continue 'positions;
            }
        }
        return Some((start, end));
    }
    None
}

/// One entry per `char` of `text` — `Some` toneless syllable for a Han
/// character, `None` for everything else. Positions are kept rather than
/// compacted so a syllable index is also a character index: every Han
/// character is exactly one syllable, which is what lets a pinyin hit reuse
/// `resolve`'s existing `consumed` bookkeeping unchanged.
fn query_syllables(text: &str) -> Vec<Option<&'static str>> {
    text.to_pinyin().map(|syllable| syllable.map(|syllable| syllable.plain())).collect()
}

/// `None` for any alias that is not Han end to end. A Latin alias has no
/// pronunciation key at all, and a mixed one ("达西Mr") would match on its Han
/// run alone — a weaker claim than the exact scan already makes on the same
/// text, so it must not reach this path either.
fn alias_syllables(alias: &str) -> Option<Vec<&'static str>> {
    let mut syllables = Vec::new();
    for syllable in alias.to_pinyin() {
        syllables.push(syllable?.plain());
    }
    (!syllables.is_empty()).then_some(syllables)
}

/// The first still-unconsumed run where `needle`'s syllables appear
/// consecutively in `haystack`'s, or `None`.
///
/// Sequences, never a concatenated string. 西安 is `xi` + `an` and 先 is the
/// single syllable `xian`; concatenated they are both "xian", and a substring
/// search would call two unrelated words the same. Comparing syllable by
/// syllable is the only thing keeping them apart, so do not "simplify" this
/// into a `join("")` plus `contains`.
///
/// `Some(needle[offset])` on the right of the comparison is also what rejects
/// non-Han positions for free: a `None` in the haystack can never equal a
/// syllable, so an alias can't straddle punctuation or Latin text.
fn find_unconsumed_pinyin_match(
    haystack: &[Option<&'static str>],
    needle: &[&'static str],
    consumed: &[bool],
) -> Option<(usize, usize)> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    'positions: for start in 0..=haystack.len() - needle.len() {
        for offset in 0..needle.len() {
            if consumed[start + offset] || haystack[start + offset] != Some(needle[offset]) {
                continue 'positions;
            }
        }
        return Some((start, start + needle.len()));
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Script {
    Cjk,
    Cyrillic,
    Latin,
}

/// The book's language code (the same BCP-47-ish primary subtag
/// `grounding::language::detect` writes to `books.language`) mapped to a
/// coarse script family. `None` for anything this build can't place — Arabic,
/// Hebrew, Devanagari, Thai, and simply "language unknown" all fall out here,
/// and all of them make the cross-script check refuse to fire rather than
/// guess. Reusing `grounding::language`'s own vocabulary of codes rather than
/// re-detecting anything from the query: the doc's "判断用现成的
/// grounding::language" means read what indexing already decided about the
/// book, not run a second, weaker detector against a two-word question.
fn book_script(language: Option<&str>) -> Option<Script> {
    match language? {
        "zh" | "ja" | "ko" => Some(Script::Cjk),
        "ru" | "uk" => Some(Script::Cyrillic),
        "en" | "es" | "fr" | "de" | "pt" | "it" | "nl" | "pl" | "tr" | "sv" | "da" | "fi"
        | "nb" | "cs" | "hu" | "ro" | "id" | "vi" => Some(Script::Latin),
        _ => None,
    }
}

/// The query's own script family, or `None` when it doesn't lean on any one
/// script clearly enough to compare — an all-punctuation or all-digit query,
/// for instance. CJK is checked first because it's the one script this
/// feature is actually built to catch cross-language questions for; the
/// others are there so an obviously-Cyrillic or obviously-Latin query against
/// a CJK book still counts as "different", not just CJK-vs-everything-else.
fn query_script(query: &str) -> Option<Script> {
    let mut has_cyrillic = false;
    let mut has_latin = false;
    for character in query.chars() {
        if is_cjk(character) {
            return Some(Script::Cjk);
        }
        if ('\u{0400}'..='\u{04FF}').contains(&character) {
            has_cyrillic = true;
        } else if character.is_alphabetic() && character.is_ascii() || ('\u{00C0}'..='\u{024F}').contains(&character) {
            has_latin = true;
        }
    }
    if has_cyrillic {
        Some(Script::Cyrillic)
    } else if has_latin {
        Some(Script::Latin)
    } else {
        None
    }
}

/// Resolve a chat query against this book's alias table. Zero model calls —
/// see the module doc for why that's the point of this half of the feature.
pub fn resolve(conn: &Connection, book_id: &str, query: &str) -> AppResult<AliasResolution> {
    let groups = alias_groups(conn, book_id)?;
    // Kept as a String, not just its chars: the pinyin fallback below has to
    // read syllables off the *same* lowercased text the char indices were
    // taken from, or the two would disagree on any character whose lowercase
    // form is a different number of chars.
    let lowered_query = query.to_lowercase();
    let query_chars: Vec<char> = lowered_query.chars().collect();
    let mut consumed = vec![false; query_chars.len()];
    let mut matched: Vec<MatchedAlias> = Vec::new();
    // Parallel to `matched`, pushed in lockstep with it — the rows (with
    // their `mentions`) behind whichever alias just matched. Kept alongside
    // rather than looked back up from `groups` afterwards, because `matched`
    // is a strict subset of `groups` and re-pairing them positionally would
    // silently misalign the moment any alias in `groups` failed to match.
    let mut matched_rows: Vec<&Vec<AliasRow>> = Vec::new();

    for (alias, rows) in &groups {
        let needle: Vec<char> = alias.to_lowercase().chars().collect();
        if let Some((start, end)) = find_unconsumed_match(&query_chars, &needle, &consumed) {
            for slot in &mut consumed[start..end] {
                *slot = true;
            }
            let mut canonicals: Vec<String> = rows.iter().map(|row| row.canonical.clone()).collect();
            canonicals.sort();
            canonicals.dedup();
            matched.push(MatchedAlias {
                alias: alias.clone(),
                canonicals,
                pinyin: false,
                description: false,
            });
            matched_rows.push(rows);
        }
    }

    // The pronunciation fallback, and only once the exact scan came up empty.
    // A Chinese IME will happily hand a reader 达希 or 大西 for 达西 — same
    // sound, different characters, and no embedding can bridge that because
    // there is no meaning shared between those pairs, only a pronunciation.
    // But an exact hit is a fact about the characters the reader actually
    // typed, and this is a guess about the ones they meant, so it may never
    // displace an exact hit or run alongside one: `matched.is_empty()` is the
    // whole gate, deliberately not a second arm of the loop above.
    let by_pinyin = matched.is_empty() && {
        let query_sounds = query_syllables(&lowered_query);
        for (alias, rows) in &groups {
            let Some(alias_sounds) = alias_syllables(alias) else {
                continue;
            };
            // Two syllables minimum. Chinese has a few hundred distinct
            // syllables against tens of thousands of characters, so a
            // one-character alias like 简 (Jane) shares its sound with 建, 见,
            // 剑 and dozens more: it would fire on 我建议… and hand the reader
            // a confident-looking "read as Jane" for a sentence about nothing
            // of the sort. The exact scan still catches a literal 简 — this
            // only declines to *guess* from a single syllable, where the
            // guess is wrong far more often than right.
            if alias_sounds.len() < 2 {
                continue;
            }
            if let Some((start, end)) =
                find_unconsumed_pinyin_match(&query_sounds, &alias_sounds, &consumed)
            {
                // Same `consumed` array as the exact scan, so a sound hit
                // blocks later overlapping ones exactly as a character hit
                // does — 达西小姐 having claimed a span must still keep 达西
                // from claiming part of it back.
                for slot in &mut consumed[start..end] {
                    *slot = true;
                }
                let mut canonicals: Vec<String> = rows.iter().map(|row| row.canonical.clone()).collect();
                canonicals.sort();
                canonicals.dedup();
                matched.push(MatchedAlias {
                    alias: alias.clone(),
                    canonicals,
                    pinyin: true,
                    description: false,
                });
                matched_rows.push(rows);
            }
        }
        !matched.is_empty()
    };

    let default_canonical = if by_pinyin {
        matched_rows
            .iter()
            .flat_map(|rows| rows.iter())
            .max_by_key(|row| row.mentions)
            .map(|row| row.canonical.clone())
    } else {
        matched
            .iter()
            .zip(matched_rows.iter())
            .find(|(entry, _)| entry.canonicals.len() > 1)
            .and_then(|(_, rows)| rows.iter().max_by_key(|row| row.mentions))
            .map(|row| row.canonical.clone())
    };

    let confidence = if matched.is_empty() {
        let language: Option<String> = conn
            .query_row("SELECT language FROM books WHERE id = ?1", params![book_id], |row| row.get(0))
            .ok()
            .flatten();
        let cross_script = match (query_script(query), book_script(language.as_deref())) {
            (Some(query_script), Some(book_script)) => query_script != book_script,
            // Either side is unclassifiable — refuse to guess "different".
            _ => false,
        };
        if cross_script { AliasConfidence::Low } else { AliasConfidence::None }
    } else if by_pinyin || matched.iter().any(|entry| entry.canonicals.len() > 1) {
        // `by_pinyin` first, and unconditionally: a sound match that lands on
        // a single canonical is still only a guess at what the reader typed,
        // so it is capped here rather than being allowed to reach `High`
        // through the unambiguous branch below.
        AliasConfidence::Medium
    } else {
        AliasConfidence::High
    };

    let mut expansion_terms: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in &matched {
        for canonical in &entry.canonicals {
            if seen.insert(canonical.clone()) {
                expansion_terms.push(canonical.clone());
            }
        }
    }
    let expanded_query = if expansion_terms.is_empty() {
        query.to_string()
    } else {
        format!("{query} {}", expansion_terms.join(" "))
    };

    Ok(AliasResolution { confidence, matched, default_canonical, expanded_query })
}

// ---------------------------------------------------------------------------
// Pass two — description aliases, matched by embedding similarity
// ---------------------------------------------------------------------------
//
// `resolve` above is pass one: synchronous, free, and safe to call on every
// turn. It only ever sees `kind = 'name'` rows, because a description
// ("那个总在拍马屁的牧师") paired with exact substring matching is a
// false-positive machine — one reworded phrase and it either misses or, worse,
// half-matches. This is the other half migration 059's comment promised: the
// same rows, matched by cosine similarity against the query embedding.
//
// It is a second entry point rather than an argument to `resolve` because the
// query vector does not exist yet when `resolve` runs — `chat.rs` computes it
// only after deciding this turn even wants vector retrieval. Splitting the two
// keeps `resolve` exactly as cheap and as unconditional as it was.
//
// The consequence, and it is intended: description matching rides the
// vector-retrieval switch. Vector retrieval off, full-text injection chosen for
// a short book, or this book's chunks not embedded yet → no query vector → no
// description matching this turn. There is deliberately no fallback that embeds
// the query a second time just for alias resolution; a network round trip that
// retrieval did not already need is not worth a handful of hand-taught rows.

/// Minimum cosine similarity for a description row to count as a match.
///
/// Low on purpose. Description aliases are scarce and hand-taught — a reader
/// typed this phrase and told us who it meant — so the cost of the two errors
/// is lopsided: a miss silently returns the reader to the dead-row behaviour
/// this whole change exists to fix, while a loose hit is disclosed above the
/// answer as a guess and expands the query additively, so at worst it retrieves
/// a little more than it should. Erring toward matching and letting the
/// disclosure line carry the uncertainty is the better trade.
pub const DESCRIPTION_SIMILARITY_FLOOR: f32 = 0.55;

/// How many description rows are shown for one query. See
/// `merge_description_candidates` for why two.
pub const MAX_DESCRIPTION_MATCHES: usize = 2;

/// How many neighbours the vec0 KNN is asked for before the floor is applied.
/// Comfortably above `MAX_DESCRIPTION_MATCHES` so the floor, not the `k`, is
/// what decides — and still tiny, because a book's whole description-alias
/// table is a handful of rows.
const DESCRIPTION_CANDIDATE_K: usize = 8;

/// One `kind = 'description'` row the query embedding landed near, before any
/// threshold or ordering has been applied.
#[derive(Debug, Clone, PartialEq)]
struct DescriptionCandidate {
    alias: String,
    canonical: String,
    mentions: i64,
    /// Cosine similarity in `[-1, 1]`, derived from the cosine *distance*
    /// sqlite-vec reports for `book_alias_vectors` (see
    /// `vector::ensure_alias_vector_table` for why that table declares the
    /// metric instead of taking vec0's default).
    similarity: f32,
}

/// The vec0 nearest-neighbour lookup, resolved back to the rows behind the
/// hits. No network: `query_vector` is the embedding `hybrid_retrieve` was
/// going to use anyway.
fn description_candidates(
    conn: &Connection,
    book_id: &str,
    query_vector: &[f32],
) -> AppResult<Vec<DescriptionCandidate>> {
    let encoded = super::vector::embedding_json(query_vector)?;
    let hits: Vec<(String, f64)> = conn
        .prepare(
            "SELECT alias_id, distance FROM book_alias_vectors
             WHERE embedding MATCH ?1 AND k = ?2 AND book_id = ?3
             ORDER BY distance",
        )?
        .query_map(
            params![encoded, DESCRIPTION_CANDIDATE_K as i64, book_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    // The `kind = 'description'` filter is repeated here rather than trusted
    // from the vector table. Nothing writes a 'name' row's vector today, but
    // the day something does, a name must still be matched on the characters
    // the reader typed and not on what its embedding happens to resemble.
    let mut statement = conn.prepare(
        "SELECT alias, canonical, mentions FROM book_person_aliases
         WHERE id = ?1 AND kind = 'description'",
    )?;
    let mut candidates = Vec::with_capacity(hits.len());
    for (alias_id, distance) in hits {
        let row = statement
            .query_row(params![alias_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .optional()?;
        if let Some((alias, canonical, mentions)) = row {
            candidates.push(DescriptionCandidate {
                alias,
                canonical,
                mentions,
                similarity: 1.0 - distance as f32,
            });
        }
    }
    Ok(candidates)
}

/// Every candidate sharing one alias text, collapsed. The `mentions` alongside
/// each canonical is kept as well as the group's own maximum: the group-level
/// one orders groups against each other, the per-canonical one orders names
/// inside a group, and they answer different questions.
struct DescriptionGroup {
    alias: String,
    similarity: f32,
    mentions: i64,
    canonicals: Vec<(String, i64)>,
}

/// Fold pass-two hits into the resolution pass one produced. Pure — every
/// decision this feature makes about thresholds, ordering, and confidence is
/// here, where a test can reach it without a database or a network.
///
/// Returns whether anything was added, which is also `chat.rs`'s signal to emit
/// a second disclosure event for this request.
///
/// **Ordering and cap.** Candidates above the floor are grouped by alias text —
/// the same alias may legitimately point at two people (migration 059's unique
/// index is on `(book_id, alias, canonical)`), and that is one ambiguous match
/// to disclose, not two matches. Groups then sort by best similarity
/// descending, ties by `mentions` descending, then by alias text so the order
/// is deterministic rather than at the mercy of the KNN's own tie-breaking.
/// At most `MAX_DESCRIPTION_MATCHES` (two) survive.
///
/// Two, not five: each surviving match renders its own line *above* the answer,
/// and every line pushes the answer further down the panel. A single question
/// almost never contains two descriptive phrases — when two rows both clear the
/// floor they are usually rival readings of the same phrase, and showing the
/// best two of those is honest where showing five is just noise the reader has
/// to scroll past.
fn merge_description_candidates(
    resolution: &mut AliasResolution,
    candidates: Vec<DescriptionCandidate>,
) -> bool {
    let mut groups: Vec<DescriptionGroup> = Vec::new();
    for candidate in candidates
        .into_iter()
        .filter(|candidate| candidate.similarity >= DESCRIPTION_SIMILARITY_FLOOR)
    {
        match groups.iter_mut().find(|group| group.alias == candidate.alias) {
            Some(group) => {
                group.similarity = group.similarity.max(candidate.similarity);
                group.mentions = group.mentions.max(candidate.mentions);
                group.canonicals.push((candidate.canonical, candidate.mentions));
            }
            None => groups.push(DescriptionGroup {
                alias: candidate.alias,
                similarity: candidate.similarity,
                mentions: candidate.mentions,
                canonicals: vec![(candidate.canonical, candidate.mentions)],
            }),
        }
    }
    if groups.is_empty() {
        return false;
    }
    groups.sort_by(|left, right| {
        right
            .similarity
            .total_cmp(&left.similarity)
            .then_with(|| right.mentions.cmp(&left.mentions))
            .then_with(|| left.alias.cmp(&right.alias))
    });
    groups.truncate(MAX_DESCRIPTION_MATCHES);

    // Everything `resolve` already appended, by construction: `expanded_query`
    // is the original text plus exactly the canonicals in `matched`. Seeded
    // from that rather than by searching the string, because a canonical is
    // usually more than one word ("Mr. Darcy") — splitting on whitespace would
    // never find it, and `contains` would match the "Darcy" inside "Miss
    // Darcy" and drop a name that genuinely needed appending.
    let mut appended: HashSet<String> = resolution
        .matched
        .iter()
        .flat_map(|entry| entry.canonicals.iter().cloned())
        .collect();

    for DescriptionGroup { alias, mut canonicals, .. } in groups {
        // Most-mentioned first, unlike pass one's alphabetical sort. Pass one
        // can afford alphabetical because `default_canonical` carries its pick
        // separately; a description group may not be the one that owns
        // `default_canonical`, and then the disclosure line falls back to
        // `canonicals[0]` — so the leading entry has to be the better guess,
        // not the alphabetically luckier one.
        canonicals.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        canonicals.dedup_by(|left, right| left.0 == right.0);
        let names: Vec<String> = canonicals.into_iter().map(|(name, _)| name).collect();
        if resolution.default_canonical.is_none() {
            resolution.default_canonical = names.first().cloned();
        }
        for name in &names {
            // Additive only, exactly as pass one's expansion is: the reader's
            // own words are never rewritten or dropped, so a description alias
            // resolved wrongly can only ever retrieve more, never less.
            if appended.insert(name.clone()) {
                resolution.expanded_query.push(' ');
                resolution.expanded_query.push_str(name);
            }
        }
        resolution.matched.push(MatchedAlias::description(alias, names));
    }
    // Rule 5, and the only statement that decides it: a description hit is
    // `Medium`, always, however high the cosine came out. It is a guess about
    // what a phrase *means* — the reader typed nothing this row's text shares a
    // character with — and `High` is reserved for a match on characters that
    // are actually in the query. Written as an unconditional assignment rather
    // than a branch so there is no arm anyone can later add a `High` to; the
    // matching downgrade from pass one's `High` is the point, not a side
    // effect.
    resolution.confidence = AliasConfidence::Medium;
    true
}

/// Pass two, wired up: look up the description rows nearest this turn's query
/// embedding and merge whatever clears the floor into `resolution`.
///
/// `query_vector` must be the embedding retrieval already computed. This
/// function makes no network call of its own and never will — see the section
/// comment above.
pub fn resolve_descriptions(
    conn: &Connection,
    book_id: &str,
    query_vector: &[f32],
    resolution: &mut AliasResolution,
) -> AppResult<bool> {
    let candidates = description_candidates(conn, book_id, query_vector)?;
    Ok(merge_description_candidates(resolution, candidates))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn setup() -> (tempfile::TempDir, Db) {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at, language)
                 VALUES ('b1', 'Pride and Prejudice', 'Jane Austen', 'b1.epub', 'unread', 0, '1970-01-01', '1970-01-01', 'en')",
                [],
            )
            .unwrap();
        (directory, db)
    }

    /// Inserts a `kind = 'name'` row (the column's own default) — every
    /// existing test in this file is about name matching, so this stays the
    /// convenient default rather than every call site spelling it out.
    fn insert_alias(db: &Db, book_id: &str, canonical: &str, alias: &str, source: &str, mentions: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO book_person_aliases (id, book_id, canonical, alias, source, mentions, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
                params![uuid::Uuid::new_v4().to_string(), book_id, canonical, alias, source, mentions],
            )
            .unwrap();
    }

    fn insert_description_alias(
        db: &Db,
        book_id: &str,
        canonical: &str,
        alias: &str,
        source_query: &str,
        mentions: i64,
    ) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO book_person_aliases (id, book_id, canonical, alias, source, mentions, created_at, kind, source_query)
                 VALUES (?1, ?2, ?3, ?4, 'user', ?5, 0, 'description', ?6)",
                params![uuid::Uuid::new_v4().to_string(), book_id, canonical, alias, mentions, source_query],
            )
            .unwrap();
    }

    // --- storage -----------------------------------------------------------

    #[test]
    fn list_person_aliases_groups_rows_by_canonical() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        insert_alias(&db, "b1", "Mr. Darcy", "达西先生", "auto", 40);
        insert_alias(&db, "b1", "Mr. Collins", "柯林斯", "auto", 10);
        let groups = list_person_aliases(&db.reader(), "b1").unwrap();
        assert_eq!(groups.len(), 2);
        let darcy = groups.iter().find(|group| group.canonical == "Mr. Darcy").unwrap();
        assert_eq!(darcy.entries.len(), 2);
    }

    #[test]
    fn add_person_alias_promotes_an_existing_auto_row_to_user_on_conflict() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        add_person_alias(&db, "b1", "Mr. Darcy", "达西", "name", None).unwrap();
        let groups = list_person_aliases(&db.reader(), "b1").unwrap();
        assert_eq!(groups[0].entries.len(), 1, "conflict must update in place, not duplicate");
        assert_eq!(groups[0].entries[0].source, "user");
    }

    #[test]
    fn build_pass_clears_auto_rows_but_never_user_rows() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        insert_alias(&db, "b1", "Mr. Collins", "柯林斯", "user", 10);
        {
            let conn = db.conn.lock().unwrap();
            clear_auto_aliases(&conn, "b1").unwrap();
        }
        let groups = list_person_aliases(&db.reader(), "b1").unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].canonical, "Mr. Collins");
    }

    #[test]
    fn clear_person_aliases_removes_user_rows_too() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        insert_alias(&db, "b1", "Mr. Collins", "柯林斯", "user", 10);
        clear_person_aliases(&db, "b1").unwrap();
        assert!(list_person_aliases(&db.reader(), "b1").unwrap().is_empty());
    }

    #[test]
    fn delete_person_alias_removes_only_that_row() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        insert_alias(&db, "b1", "Mr. Darcy", "达西先生", "auto", 40);
        let id = db
            .reader()
            .query_row(
                "SELECT id FROM book_person_aliases WHERE alias = '达西'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        delete_person_alias(&db, &id).unwrap();
        let groups = list_person_aliases(&db.reader(), "b1").unwrap();
        assert_eq!(groups[0].entries.len(), 1);
        assert_eq!(groups[0].entries[0].alias, "达西先生");
    }

    // --- extract_json_array --------------------------------------------------

    #[test]
    fn extract_json_array_finds_the_array_inside_surrounding_prose() {
        let text = "Sure, here it is:\n```json\n[{\"canonical\":\"A\"}]\n```\nHope that helps.";
        assert_eq!(extract_json_array(text), Some("[{\"canonical\":\"A\"}]"));
    }

    // --- resolve_group_canonical / evaluate_attempt: build pass Fix 1 + 2 --

    fn insert_chunk(db: &Db, book_id: &str, index: i64, text: &str) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO book_chunks (id, book_id, chunk_index, section_index, text, snippet, token_estimate, created_at)
                 VALUES (?1, ?2, ?3, 0, ?4, ?4, 1, 0)",
                params![uuid::Uuid::new_v4().to_string(), book_id, index, text],
            )
            .unwrap();
    }

    #[test]
    fn canonical_in_book_wins_over_its_aliases() {
        let (_dir, db) = setup();
        insert_chunk(&db, "b1", 0, "Mr. Darcy walked into the room.");
        let group = RawAliasGroup {
            canonical: "Mr. Darcy".to_string(),
            aliases: vec!["达西".to_string(), "Darcy".to_string()],
        };
        let (winner, mentions, losers) =
            resolve_group_canonical(&db.reader(), "b1", &group).unwrap().unwrap();
        assert_eq!(winner, "Mr. Darcy");
        assert_eq!(mentions, 1);
        assert_eq!(losers, vec!["达西".to_string(), "Darcy".to_string()]);
    }

    /// The measured Phillips/Mary case: the model's `canonical` is a spelling
    /// the book never uses, but the book's own spelling is sitting right
    /// there in `aliases`. That alias must win, and the model's original
    /// (wrong) canonical must survive as one of the resulting aliases rather
    /// than being silently dropped.
    #[test]
    fn canonical_absent_but_an_alias_present_promotes_the_alias() {
        let (_dir, db) = setup();
        insert_chunk(&db, "b1", 0, "\"Oh, Phillips!\" cried Mrs. Phillips.");
        let group = RawAliasGroup {
            // Note the single "l" — the spelling the model wrote, which the
            // book above never uses ("Phillips", with two).
            canonical: "Mrs. Philips".to_string(),
            aliases: vec!["Phillips".to_string(), "太太".to_string()],
        };
        let (winner, mentions, losers) =
            resolve_group_canonical(&db.reader(), "b1", &group).unwrap().unwrap();
        assert_eq!(winner, "Phillips");
        assert_eq!(mentions, 1);
        assert_eq!(
            losers,
            vec!["Mrs. Philips".to_string(), "太太".to_string()],
            "the model's original (wrong) canonical becomes an alias, not a dropped string"
        );
    }

    #[test]
    fn no_string_in_the_group_present_skips_the_group() {
        let (_dir, db) = setup();
        insert_chunk(&db, "b1", 0, "Mr. Darcy walked into the room.");
        let group = RawAliasGroup {
            canonical: "Ghost Character".to_string(),
            aliases: vec!["Nobody".to_string()],
        };
        assert_eq!(resolve_group_canonical(&db.reader(), "b1", &group).unwrap(), None);
    }

    #[test]
    fn evaluate_attempt_commits_survivors_and_silently_drops_the_rest() {
        let (_dir, db) = setup();
        // "达西" has to actually occur, word-boundary checked, or change A
        // drops it before this test ever gets to see the drop it is really
        // about (the fabricated "Ghost"/"Nobody" group). See `db.conn.lock()`
        // below, not `db.reader()`: `evaluate_attempt` now looks up "达西" in
        // the frequency table, whose lemma fallback locks `db.read_conn`
        // itself, and `Mutex` is not reentrant.
        insert_chunk(&db, "b1", 0, "Mr. Darcy spoke with Mr. Collins nearby. 达西 said nothing.");
        let raw = vec![
            RawAliasGroup { canonical: "Mr. Darcy".to_string(), aliases: vec!["达西".to_string()] },
            RawAliasGroup { canonical: "Ghost".to_string(), aliases: vec!["Nobody".to_string()] },
        ];
        let conn = db.conn.lock().unwrap();
        let outcome = evaluate_attempt(&conn, &db, "b1", &raw).unwrap();
        match outcome {
            AttemptOutcome::Commit(rows) => {
                assert_eq!(rows, vec![("Mr. Darcy".to_string(), "达西".to_string(), 1)]);
            }
            other => panic!("expected Commit with the surviving group only, got {other:?}"),
        }
    }

    /// The regression this pair guards is not "the reply was bad" — it is
    /// *which* bad the caller is told about, because that decides whether the
    /// remaining attempts get spent. Prose with no array in it and an array of
    /// the wrong shape both have to land on `Unreadable`, which the retry loop
    /// treats exactly like `Unusable`; before this, they were raised as an
    /// error from inside the attempt and ended the build on the first try.
    #[test]
    fn a_reply_with_no_json_array_is_unreadable_and_therefore_retryable() {
        let (_dir, db) = setup();
        assert_eq!(
            classify_reply(&db.reader(), &db, "b1", "I'm sorry, I can't help with that.").unwrap(),
            AttemptResult::Unreadable
        );
    }

    #[test]
    fn a_json_array_of_the_wrong_shape_is_unreadable_not_a_commit() {
        let (_dir, db) = setup();
        assert_eq!(
            classify_reply(&db.reader(), &db, "b1", "[1, 2, 3]").unwrap(),
            AttemptResult::Unreadable
        );
    }

    #[test]
    fn a_well_formed_reply_naming_nobody_in_the_book_is_unusable_not_unreadable() {
        let (_dir, db) = setup();
        insert_chunk(&db, "b1", 0, "Mr. Darcy spoke with Mr. Collins nearby.");
        let reply = r#"[{"canonical": "Ghost", "aliases": ["Nobody"]}]"#;
        assert_eq!(
            classify_reply(&db.reader(), &db, "b1", reply).unwrap(),
            AttemptResult::Parsed(AttemptOutcome::Unusable)
        );
    }

    #[test]
    fn a_well_formed_reply_naming_someone_in_the_book_commits() {
        let (_dir, db) = setup();
        // See the sibling `evaluate_attempt_commits_survivors_...` test for
        // why "达西" has to actually occur in the fixture text now, and why
        // this uses `db.conn.lock()` rather than `db.reader()`.
        insert_chunk(&db, "b1", 0, "Mr. Darcy spoke with Mr. Collins nearby. 达西 said nothing.");
        let reply = r#"prose first [{"canonical": "Mr. Darcy", "aliases": ["达西"]}] and after"#;
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            classify_reply(&conn, &db, "b1", reply).unwrap(),
            AttemptResult::Parsed(AttemptOutcome::Commit(vec![(
                "Mr. Darcy".to_string(),
                "达西".to_string(),
                1
            )]))
        );
    }

    #[test]
    fn evaluate_attempt_on_an_empty_response_is_a_legitimate_commit_not_unusable() {
        // The model looked at the book and reported no named people. That is
        // a real (if rare) answer, not the failure `Unusable` exists to flag
        // — see the type's own doc comment for why the two must not collapse
        // into one case.
        let (_dir, db) = setup();
        let raw: Vec<RawAliasGroup> = Vec::new();
        // `db.conn.lock()` rather than `db.reader()`: change B's frequency
        // lookup takes `db.reader()` itself on a table miss, and holding that
        // same guard across the call would deadlock the thread against
        // itself. This case never reaches the lookup, but the rule is
        // "never hand `evaluate_attempt` a `read_conn` guard", not "only
        // where it would currently bite".
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            evaluate_attempt(&conn, &db, "b1", &raw).unwrap(),
            AttemptOutcome::Commit(Vec::new())
        );
    }

    /// The measured 0%-yield signature: a non-empty response where nothing
    /// survived `resolve_group_canonical`. `run_build_pass` reads this as the
    /// signal to retry the whole model call rather than writing an empty
    /// table and reporting success.
    #[test]
    fn a_whole_response_where_nothing_survives_is_judged_unusable() {
        let (_dir, db) = setup();
        insert_chunk(&db, "b1", 0, "Mr. Darcy spoke with Mr. Collins nearby.");
        // Every string the model wrote is Chinese and the book is English —
        // the measured inversion, with the book's own spelling nowhere in
        // the group for `resolve_group_canonical` to fall back to.
        let raw =
            vec![RawAliasGroup { canonical: "达西先生".to_string(), aliases: vec!["达西".to_string()] }];
        let conn = db.conn.lock().unwrap();
        assert_eq!(evaluate_attempt(&conn, &db, "b1", &raw).unwrap(), AttemptOutcome::Unusable);
    }

    // --- build pass: change A (row-level zero-mention drop) ----------------

    #[test]
    fn a_zero_mention_alias_is_dropped_but_its_group_survives() {
        let (_dir, db) = setup();
        insert_chunk(&db, "b1", 0, "Mr. Darcy spoke quietly to Mr. Collins.");
        let raw = vec![RawAliasGroup {
            canonical: "Mr. Darcy".to_string(),
            // "达西" never appears anywhere in the book — a fabricated alias
            // the group-level check in `resolve_group_canonical` cannot see,
            // because "Mr. Darcy" itself already has mentions and lets the
            // whole group past that check.
            aliases: vec!["Darcy".to_string(), "达西".to_string()],
        }];
        let conn = db.conn.lock().unwrap();
        let outcome = evaluate_attempt(&conn, &db, "b1", &raw).unwrap();
        match outcome {
            AttemptOutcome::Commit(rows) => {
                assert_eq!(
                    rows,
                    vec![("Mr. Darcy".to_string(), "Darcy".to_string(), 1)],
                    "the fabricated alias must be dropped, the real one kept: {rows:?}"
                );
            }
            other => panic!("expected Commit, got {other:?}"),
        }
    }

    #[test]
    fn a_group_whose_only_alias_is_fabricated_is_unusable() {
        let (_dir, db) = setup();
        insert_chunk(&db, "b1", 0, "Mr. Darcy spoke quietly to Mr. Collins.");
        let raw = vec![RawAliasGroup { canonical: "Mr. Darcy".to_string(), aliases: vec!["达西".to_string()] }];
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            evaluate_attempt(&conn, &db, "b1", &raw).unwrap(),
            AttemptOutcome::Unusable,
            "the winner survives resolve_group_canonical but contributes zero rows once its \
             only alias is dropped, which must retry rather than silently commit an empty table"
        );
    }

    #[test]
    fn a_substring_only_hit_does_not_count_as_an_occurrence() {
        let (_dir, db) = setup();
        // "Young" only ever appears as part of "younger" here — never as the
        // word on its own — so the word-boundary check must say no, even
        // though `count_mentions`'s raw `LIKE '%Young%'` scan says yes.
        insert_chunk(&db, "b1", 0, "Elizabeth felt younger than her sister.");
        let conn = db.conn.lock().unwrap();
        assert!(!alias_occurs_in_book(&conn, "b1", "Young").unwrap());
        assert!(
            count_mentions(&conn, "b1", "Young").unwrap() > 0,
            "sanity check: the raw LIKE scan this test exists to distinguish from does match"
        );
    }

    // --- build pass: change B (common-word rejection) -----------------------

    #[test]
    fn a_single_word_common_word_key_is_rejected() {
        let (_dir, db) = setup();
        let forms = word_frequency::FormIndex::new(&db);
        // "young" is rank 249 in the fiction frequency table — solidly inside
        // band 1, the surname/adjective collision the measured run hit.
        assert!(is_common_single_word(&forms, "Young").unwrap());
    }

    #[test]
    fn a_multi_word_key_containing_a_common_word_is_not_rejected() {
        let (_dir, db) = setup();
        let forms = word_frequency::FormIndex::new(&db);
        assert!(!is_common_single_word(&forms, "Joel Young").unwrap());
    }

    #[test]
    fn a_rare_surname_is_not_rejected_as_a_common_word() {
        let (_dir, db) = setup();
        let forms = word_frequency::FormIndex::new(&db);
        assert!(!is_common_single_word(&forms, "Frankl").unwrap());
    }

    #[test]
    fn a_common_word_canonical_kills_its_whole_group() {
        // The measured cascading result: a raw group whose *canonical* is a
        // bare common word ("Young", with alias "Joel") must be rejected
        // outright, not just have the canonical itself dropped and the alias
        // promoted — "Joel" alone is not a name any of this book's text
        // confirms, and this pass never promotes an alias to canonical on its
        // own initiative.
        let (_dir, db) = setup();
        insert_chunk(&db, "b1", 0, "Joel Young walked into the young prince's court.");
        let raw = vec![RawAliasGroup { canonical: "Young".to_string(), aliases: vec!["Joel".to_string()] }];
        let conn = db.conn.lock().unwrap();
        assert_eq!(evaluate_attempt(&conn, &db, "b1", &raw).unwrap(), AttemptOutcome::Unusable);
    }

    // --- build pass: change C (recovering a person the model missed) -------

    #[test]
    fn an_alias_shared_by_two_full_names_gains_a_second_canonical() {
        let (_dir, db) = setup();
        insert_chunk(
            &db,
            "b1",
            0,
            "Alexander Vesely-Frankl arrived first. Franz Vesely-Frankl came later. \
             Vesely-Frankl often visited the old house.",
        );
        // The model only ever extracted Alexander — Franz is a real person in
        // the book's own text that this raw group never names.
        let raw = vec![RawAliasGroup {
            canonical: "Alexander Vesely-Frankl".to_string(),
            aliases: vec!["Vesely-Frankl".to_string()],
        }];
        let conn = db.conn.lock().unwrap();
        let AttemptOutcome::Commit(rows) = evaluate_attempt(&conn, &db, "b1", &raw).unwrap() else {
            panic!("expected Commit")
        };
        let mut canonicals: Vec<&str> = rows
            .iter()
            .filter(|(_, alias, _)| alias == "Vesely-Frankl")
            .map(|(canonical, _, _)| canonical.as_str())
            .collect();
        canonicals.sort_unstable();
        assert_eq!(
            canonicals,
            vec!["Alexander Vesely-Frankl", "Franz Vesely-Frankl"],
            "the alias must end up pointing at both full names: {rows:?}"
        );
        // `insert_alias` locks `db.conn` itself — the same mutex `conn`
        // above is still holding — so it has to be dropped first, or this
        // deadlocks against itself on the next line.
        drop(conn);

        // Feeding these rows into the real table and asking `resolve()`
        // about "Vesely-Frankl" must now come back ambiguous — the whole
        // point of registering the second canonical rather than dropping it.
        for (canonical, alias, mentions) in &rows {
            insert_alias(&db, "b1", canonical, alias, "auto", *mentions);
        }
        let resolution = resolve(&db.reader(), "b1", "What did Vesely-Frankl say?").unwrap();
        assert_eq!(resolution.confidence, AliasConfidence::Medium);
        let mut resolved: Vec<&str> =
            resolution.matched[0].canonicals.iter().map(String::as_str).collect();
        resolved.sort_unstable();
        assert_eq!(resolved, vec!["Alexander Vesely-Frankl", "Franz Vesely-Frankl"]);
    }

    #[test]
    fn a_high_frequency_owner_beats_a_low_frequency_namesake_as_the_default() {
        // The Frankl scenario itself: "Frankl" mostly means Viktor E. Frankl
        // (142 mentions in the book this fix was measured against), but the
        // book also has a second, much less frequently mentioned Frankl.
        // Both must resolve as an ambiguous match, and the default has to be
        // the one the book actually spends its time on — the existing
        // mentions-descending tie-break in `resolve()`, exercised here on
        // realistic numbers rather than a synthetic tie.
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Viktor E. Frankl", "Frankl", "auto", 142);
        insert_alias(&db, "b1", "Franz Frankl", "Frankl", "auto", 3);
        let resolution = resolve(&db.reader(), "b1", "What did Frankl believe?").unwrap();
        assert_eq!(resolution.confidence, AliasConfidence::Medium);
        let mut canonicals = resolution.matched[0].canonicals.clone();
        canonicals.sort();
        assert_eq!(canonicals, vec!["Franz Frankl".to_string(), "Viktor E. Frankl".to_string()]);
        assert_eq!(resolution.default_canonical.as_deref(), Some("Viktor E. Frankl"));
    }

    // --- build pass: A, B, and C stacked together ---------------------------

    #[test]
    fn the_three_checks_apply_in_the_documented_order() {
        let (_dir, db) = setup();
        insert_chunk(
            &db,
            "b1",
            0,
            "Mr. Vesely spoke first. Franz Vesely arrived later. \
             The young prince said nothing.",
        );
        let raw = vec![RawAliasGroup {
            canonical: "Mr. Vesely".to_string(),
            aliases: vec![
                "Ghost Name".to_string(), // A: never occurs at all
                "Young".to_string(),      // A survives (matches "young"); B rejects it
                "Vesely".to_string(),     // A + B survive; C finds a second person
            ],
        }];
        let conn = db.conn.lock().unwrap();
        let AttemptOutcome::Commit(rows) = evaluate_attempt(&conn, &db, "b1", &raw).unwrap() else {
            panic!("expected Commit")
        };
        let mut simplified: Vec<(String, String)> =
            rows.iter().map(|(canonical, alias, _)| (canonical.clone(), alias.clone())).collect();
        simplified.sort();
        assert_eq!(
            simplified,
            vec![
                ("Franz Vesely".to_string(), "Vesely".to_string()),
                ("Mr. Vesely".to_string(), "Vesely".to_string()),
            ],
            "Ghost Name must be gone (A), Young must be gone (B), and Vesely must now point \
             at both people (C): {rows:?}"
        );
    }

    // --- resolve: the doc's 验收 rules, one test per rule ------------------

    #[test]
    fn longest_alias_wins_over_a_shorter_one_it_contains() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Georgiana Darcy", "达西小姐", "auto", 5);
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        let resolution = resolve(&db.reader(), "b1", "达西小姐是谁").unwrap();
        assert_eq!(resolution.matched.len(), 1, "the short alias must not also match inside the long one");
        assert_eq!(resolution.matched[0].alias, "达西小姐");
        assert_eq!(resolution.matched[0].canonicals, vec!["Georgiana Darcy".to_string()]);
    }

    #[test]
    fn latin_aliases_require_a_word_boundary() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Eliza Doolittle", "Eliza", "auto", 5);
        let resolution = resolve(&db.reader(), "b1", "What does Elizabeth think?").unwrap();
        assert!(
            resolution.matched.is_empty(),
            "\"Eliza\" must not match inside \"Elizabeth\": {:?}",
            resolution.matched
        );
    }

    #[test]
    fn latin_aliases_do_match_at_a_real_word_boundary() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Eliza Doolittle", "Eliza", "auto", 5);
        let resolution = resolve(&db.reader(), "b1", "What does Eliza think?").unwrap();
        assert_eq!(resolution.matched.len(), 1);
    }

    #[test]
    fn one_alias_with_multiple_canonicals_is_judged_medium() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Georgiana Darcy", "达西小姐", "auto", 5);
        insert_alias(&db, "b1", "Miss Darcy", "达西小姐", "auto", 30);
        let resolution = resolve(&db.reader(), "b1", "达西小姐弹钢琴弹得怎么样").unwrap();
        assert_eq!(resolution.confidence, AliasConfidence::Medium);
        // Default picks the higher-mentions canonical.
        assert_eq!(resolution.default_canonical.as_deref(), Some("Miss Darcy"));
    }

    #[test]
    fn a_single_unambiguous_hit_is_judged_high() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        let resolution = resolve(&db.reader(), "b1", "达西对伊丽莎白说了什么").unwrap();
        assert_eq!(resolution.confidence, AliasConfidence::High);
        assert_eq!(resolution.default_canonical, None);
    }

    #[test]
    fn zero_hits_with_a_cross_script_query_is_judged_low() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        // Book is English (see setup()); query is Chinese and names nobody
        // this table knows — the exact shape Low exists to catch.
        let resolution = resolve(&db.reader(), "b1", "薇克姆是坏人吗").unwrap();
        assert_eq!(resolution.confidence, AliasConfidence::Low);
    }

    #[test]
    fn zero_hits_in_the_books_own_script_is_not_judged_low() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        // Same script as the English book, and not a person question at all —
        // must not be flagged as "couldn't tell who".
        let resolution = resolve(&db.reader(), "b1", "What is this book about?").unwrap();
        assert_eq!(resolution.confidence, AliasConfidence::None);
    }

    #[test]
    fn zero_hits_with_an_unknown_book_language_is_not_judged_low() {
        let (_dir, db) = setup();
        db.conn
            .lock()
            .unwrap()
            .execute("UPDATE books SET language = NULL WHERE id = 'b1'", [])
            .unwrap();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        let resolution = resolve(&db.reader(), "b1", "薇克姆是坏人吗").unwrap();
        assert_eq!(
            resolution.confidence,
            AliasConfidence::None,
            "an unclassifiable book language must never be treated as 'different'"
        );
    }

    #[test]
    fn original_query_tokens_are_never_dropped_from_the_expansion() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        let resolution = resolve(&db.reader(), "b1", "达西第一次向伊丽莎白求婚").unwrap();
        assert!(resolution.expanded_query.starts_with("达西第一次向伊丽莎白求婚"));
        assert!(resolution.expanded_query.contains("Mr. Darcy"));
    }

    #[test]
    fn expansion_is_purely_additive_when_nothing_matches() {
        let (_dir, db) = setup();
        let resolution = resolve(&db.reader(), "b1", "What is this book about?").unwrap();
        assert_eq!(resolution.expanded_query, "What is this book about?");
    }

    /// `kind = 'description'` rows only ever come from a reader teaching one
    /// (see the migration's doc comment) and are matched by embedding
    /// similarity in `resolve_descriptions`, not here. `resolve()`'s substring
    /// scan must skip them outright — even when, as here, the query contains
    /// the description text verbatim — because a fuzzy phrase paired with
    /// exact matching is a false-positive machine, not a shortcut: one
    /// changed character anywhere in a real query and it silently misses,
    /// which is worse than never matching at all.
    #[test]
    fn description_rows_never_match_by_substring() {
        let (_dir, db) = setup();
        insert_description_alias(
            &db,
            "b1",
            "Mr. Collins",
            "那个总在拍马屁的牧师",
            "那个总在拍马屁的牧师是谁",
            0,
        );
        let resolution = resolve(&db.reader(), "b1", "那个总在拍马屁的牧师是谁").unwrap();
        assert!(
            resolution.matched.is_empty(),
            "a description row must never be substring-matched: {:?}",
            resolution.matched
        );
        assert!(!resolution.expanded_query.contains("Mr. Collins"));
    }

    // --- resolve: the pinyin fallback ---------------------------------------

    #[test]
    fn a_homophone_typed_by_an_ime_still_finds_the_person() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        // 达希 is what an IME hands a reader who meant 达西 — same sound,
        // characters the book never uses, and nothing the exact scan can see.
        let resolution = resolve(&db.reader(), "b1", "达希对伊丽莎白说了什么").unwrap();
        assert_eq!(resolution.matched.len(), 1);
        assert_eq!(resolution.matched[0].alias, "达西");
        assert!(resolution.matched[0].pinyin);
        assert_eq!(resolution.confidence, AliasConfidence::Medium);
        assert_eq!(resolution.default_canonical.as_deref(), Some("Mr. Darcy"));
        assert!(resolution.expanded_query.starts_with("达希对伊丽莎白说了什么"));
        assert!(resolution.expanded_query.contains("Mr. Darcy"));
    }

    #[test]
    fn an_exact_hit_never_reaches_the_pinyin_fallback() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        // 大西 sounds identical to 达西 too, but the exact scan already found
        // 达西 in this query — the fallback must not run at all, or the same
        // person would be matched twice and a confident hit demoted.
        let resolution = resolve(&db.reader(), "b1", "达西和大西是同一个人吗").unwrap();
        assert_eq!(resolution.matched.len(), 1);
        assert!(!resolution.matched[0].pinyin);
        assert_eq!(resolution.confidence, AliasConfidence::High);
        assert_eq!(resolution.default_canonical, None);
    }

    #[test]
    fn a_one_character_alias_never_guesses_by_sound() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Jane Bennet", "简", "auto", 30);
        // 建 in 我建议 sounds exactly like 简. A single syllable is shared by
        // dozens of common characters, so matching on it would announce
        // "read as Jane Bennet" over a sentence that is not about her.
        let resolution = resolve(&db.reader(), "b1", "我建议先读第三章").unwrap();
        assert!(resolution.matched.is_empty());
        assert_eq!(resolution.expanded_query, "我建议先读第三章");
    }

    #[test]
    fn a_one_character_alias_is_still_found_when_actually_typed() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Jane Bennet", "简", "auto", 30);
        // The sound guess is what the length floor declines to make. Reading
        // the character the reader actually typed is the exact scan's job and
        // is untouched by it.
        let resolution = resolve(&db.reader(), "b1", "简后来怎么样了").unwrap();
        assert_eq!(resolution.matched.len(), 1);
        assert!(!resolution.matched[0].pinyin);
        assert_eq!(resolution.confidence, AliasConfidence::High);
    }

    #[test]
    fn a_pinyin_hit_on_a_single_canonical_is_still_only_medium() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        let resolution = resolve(&db.reader(), "b1", "大西是谁").unwrap();
        assert_eq!(
            resolution.matched[0].canonicals,
            vec!["Mr. Darcy".to_string()],
            "the alias this landed on is unambiguous — the guess is which characters were meant"
        );
        assert_ne!(
            resolution.confidence,
            AliasConfidence::High,
            "a sound match must never be presented as certain, however unambiguous the alias"
        );
        assert_eq!(resolution.confidence, AliasConfidence::Medium);
    }

    /// The test that separates syllable-sequence matching from string
    /// matching. 西安 is `xi` + `an`, 先 is the single syllable `xian`;
    /// concatenated, both are "xian" and a substring search matches them to
    /// each other. They are not the same word, and a query about 先生 must not
    /// drag in an unrelated alias.
    #[test]
    fn a_syllable_that_spells_like_two_others_is_not_a_match() {
        let (_dir, db) = setup();
        // Chosen for its syllable structure rather than its realism — no
        // build pass would write a place name here (see `alias_groups`).
        insert_alias(&db, "b1", "Xi An", "西安", "auto", 5);
        let resolution = resolve(&db.reader(), "b1", "先生是谁").unwrap();
        assert!(
            resolution.matched.is_empty(),
            "xian must not match xi+an: {:?}",
            resolution.matched
        );
        assert!(!resolution.expanded_query.contains("Xi An"));
    }

    #[test]
    fn a_latin_alias_is_never_reached_by_the_pinyin_fallback() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Fitzwilliam Darcy", "Darcy", "auto", 40);
        // A Latin alias has no pronunciation key, so a Han query can only ever
        // fail against it — never fall through to a sound comparison.
        let resolution = resolve(&db.reader(), "b1", "达西是谁").unwrap();
        assert!(
            resolution.matched.is_empty(),
            "a Latin alias has no syllables to compare: {:?}",
            resolution.matched
        );
    }

    #[test]
    fn a_query_with_no_han_characters_behaves_exactly_as_before() {
        let (_dir, db) = setup();
        insert_alias(&db, "b1", "Mr. Darcy", "达西", "auto", 40);
        insert_alias(&db, "b1", "Eliza Doolittle", "Eliza", "auto", 5);
        let unmatched = resolve(&db.reader(), "b1", "What is this book about?").unwrap();
        assert_eq!(unmatched.confidence, AliasConfidence::None);
        assert_eq!(unmatched.expanded_query, "What is this book about?");
        let matched = resolve(&db.reader(), "b1", "What does Eliza think?").unwrap();
        assert_eq!(matched.confidence, AliasConfidence::High);
        assert!(!matched.matched[0].pinyin);
    }

    // --- pass two: description aliases matched by embedding ------------------

    /// A pass-one result to merge into. Defaults to the shape `resolve`
    /// produces when nothing matched, which is what a description-only query
    /// ("那个总在拍马屁的牧师说了什么") actually looks like coming out of pass
    /// one — no characters of the alias appear in the question by definition.
    fn empty_resolution(query: &str) -> AliasResolution {
        AliasResolution {
            confidence: AliasConfidence::None,
            matched: Vec::new(),
            default_canonical: None,
            expanded_query: query.to_string(),
        }
    }

    fn candidate(alias: &str, canonical: &str, mentions: i64, similarity: f32) -> DescriptionCandidate {
        DescriptionCandidate {
            alias: alias.to_string(),
            canonical: canonical.to_string(),
            mentions,
            similarity,
        }
    }

    #[test]
    fn a_candidate_below_the_floor_is_not_a_match() {
        let mut resolution = empty_resolution("谁最讨人厌");
        let added = merge_description_candidates(
            &mut resolution,
            vec![candidate("那个总在拍马屁的牧师", "Mr. Collins", 30, 0.54)],
        );
        assert!(!added, "0.54 is under the 0.55 floor");
        assert_eq!(resolution, empty_resolution("谁最讨人厌"));
    }

    #[test]
    fn a_candidate_exactly_at_the_floor_matches() {
        // The floor is inclusive. Asserted rather than left to chance because
        // a `>` here and a `>=` in the doc comment is precisely the kind of
        // drift nobody notices until a match silently stops happening.
        let mut resolution = empty_resolution("谁最讨人厌");
        let added = merge_description_candidates(
            &mut resolution,
            vec![candidate(
                "那个总在拍马屁的牧师",
                "Mr. Collins",
                30,
                DESCRIPTION_SIMILARITY_FLOOR,
            )],
        );
        assert!(added);
        assert_eq!(resolution.matched.len(), 1);
    }

    #[test]
    fn a_description_hit_is_medium_even_at_a_perfect_score() {
        // Rule 5. A cosine of 1.0 with exactly one canonical is the shape that
        // would be `High` if it had come from the exact scan; it must not be.
        let mut resolution = empty_resolution("那个牧师说了什么");
        merge_description_candidates(
            &mut resolution,
            vec![candidate("那个总在拍马屁的牧师", "Mr. Collins", 30, 1.0)],
        );
        assert_eq!(resolution.confidence, AliasConfidence::Medium);
        assert!(resolution.matched[0].description);
        assert!(!resolution.matched[0].pinyin);
    }

    #[test]
    fn a_description_hit_downgrades_a_confident_pass_one_result() {
        // Pass one found "达西" on its exact characters and was sure of it;
        // pass two then guessed at a phrase in the same sentence. The turn as a
        // whole now contains a guess, so the disclosure has to appear — a
        // `High` here would render nothing at all and hide the guess entirely.
        let mut resolution = AliasResolution {
            confidence: AliasConfidence::High,
            matched: vec![MatchedAlias {
                alias: "达西".to_string(),
                canonicals: vec!["Mr. Darcy".to_string()],
                pinyin: false,
                description: false,
            }],
            default_canonical: None,
            expanded_query: "达西和那个牧师 Mr. Darcy".to_string(),
        };
        let added = merge_description_candidates(
            &mut resolution,
            vec![candidate("那个总在拍马屁的牧师", "Mr. Collins", 30, 0.81)],
        );
        assert!(added);
        assert_eq!(resolution.confidence, AliasConfidence::Medium);
        assert_eq!(resolution.matched.len(), 2, "pass one's match is kept, not replaced");
        assert!(!resolution.matched[0].description);
        assert!(resolution.matched[1].description);
    }

    #[test]
    fn merging_extends_the_expanded_query_without_rewriting_it() {
        // Pass one matched "达西" and appended "Mr. Darcy"; the expanded query
        // and `matched` agree, which is the only shape `resolve` can produce.
        let mut resolution = AliasResolution {
            confidence: AliasConfidence::High,
            matched: vec![MatchedAlias {
                alias: "达西".to_string(),
                canonicals: vec!["Mr. Darcy".to_string()],
                pinyin: false,
                description: false,
            }],
            default_canonical: None,
            expanded_query: "达西和那个牧师 Mr. Darcy".to_string(),
        };
        merge_description_candidates(
            &mut resolution,
            vec![
                candidate("那个总在拍马屁的牧师", "Mr. Collins", 30, 0.81),
                // Already appended by pass one — a multi-word name, so this
                // also pins down that the dedup is on whole canonicals and not
                // on whitespace tokens or a substring search.
                candidate("那位先生", "Mr. Darcy", 90, 0.72),
            ],
        );
        assert_eq!(
            resolution.expanded_query, "达西和那个牧师 Mr. Darcy Mr. Collins",
            "additive only, and never the same canonical twice"
        );
    }

    #[test]
    fn one_alias_pointing_at_two_people_is_one_match_carrying_both() {
        // migration 059's unique index is on (book_id, alias, canonical), so a
        // reader can genuinely teach the same phrase against two people. That
        // is one ambiguous disclosure line, not two matches.
        let mut resolution = empty_resolution("那位年长的女士怎么说");
        merge_description_candidates(
            &mut resolution,
            vec![
                candidate("那位年长的女士", "Lady Catherine", 12, 0.78),
                candidate("那位年长的女士", "Mrs. Bennet", 44, 0.78),
            ],
        );
        assert_eq!(resolution.matched.len(), 1);
        assert_eq!(
            resolution.matched[0].canonicals,
            vec!["Mrs. Bennet".to_string(), "Lady Catherine".to_string()],
            "most-mentioned first, because the line falls back to canonicals[0]"
        );
        assert_eq!(resolution.default_canonical.as_deref(), Some("Mrs. Bennet"));
    }

    #[test]
    fn matches_are_ordered_by_similarity_and_capped_at_two() {
        let mut resolution = empty_resolution("问题");
        merge_description_candidates(
            &mut resolution,
            vec![
                candidate("第三近的说法", "Third", 1, 0.60),
                candidate("最近的说法", "First", 1, 0.90),
                candidate("第二近的说法", "Second", 1, 0.75),
                candidate("够不着的说法", "Dropped", 999, 0.40),
            ],
        );
        assert_eq!(
            resolution
                .matched
                .iter()
                .map(|entry| entry.alias.as_str())
                .collect::<Vec<_>>(),
            vec!["最近的说法", "第二近的说法"],
            "best two above the floor, in similarity order"
        );
    }

    #[test]
    fn a_similarity_tie_falls_back_to_mentions_then_to_the_alias_text() {
        let mut resolution = empty_resolution("问题");
        merge_description_candidates(
            &mut resolution,
            vec![
                candidate("B说法", "Rare", 3, 0.80),
                candidate("A说法", "Common", 3, 0.80),
                candidate("C说法", "Everywhere", 90, 0.80),
            ],
        );
        // Same cosine for all three: mentions decides first, and the two rows
        // tied on both fall back to alias text so the order cannot depend on
        // whatever sequence the KNN happened to return.
        assert_eq!(
            resolution
                .matched
                .iter()
                .map(|entry| entry.alias.as_str())
                .collect::<Vec<_>>(),
            vec!["C说法", "A说法"]
        );
    }

    #[test]
    fn a_pass_one_default_canonical_is_never_overwritten() {
        // Pass one's pick came from characters the reader actually typed; a
        // description guess must not shove it aside.
        let mut resolution = AliasResolution {
            confidence: AliasConfidence::Medium,
            matched: Vec::new(),
            default_canonical: Some("Miss Darcy".to_string()),
            expanded_query: "达西小姐和那个牧师 Miss Darcy".to_string(),
        };
        merge_description_candidates(
            &mut resolution,
            vec![candidate("那个总在拍马屁的牧师", "Mr. Collins", 30, 0.95)],
        );
        assert_eq!(resolution.default_canonical.as_deref(), Some("Miss Darcy"));
    }

    #[test]
    fn nothing_above_the_floor_leaves_the_resolution_byte_for_byte_alone() {
        // The `false` return is what stops `chat.rs` emitting a second
        // disclosure event, so "added nothing" and "changed nothing" have to be
        // the same thing.
        let before = AliasResolution {
            confidence: AliasConfidence::High,
            matched: vec![MatchedAlias {
                alias: "达西".to_string(),
                canonicals: vec!["Mr. Darcy".to_string()],
                pinyin: false,
                description: false,
            }],
            default_canonical: None,
            expanded_query: "达西是谁 Mr. Darcy".to_string(),
        };
        let mut resolution = before.clone();
        let added = merge_description_candidates(
            &mut resolution,
            vec![candidate("完全不相干的说法", "Someone", 5, 0.20)],
        );
        assert!(!added);
        assert_eq!(resolution, before);
    }

    /// End to end through sqlite-vec, which is the only way to find out whether
    /// `distance_metric=cosine` on `book_alias_vectors` behaves the way the
    /// similarity conversion in `description_candidates` assumes — the crate
    /// accepts the declaration either way, and a silent fall back to L2 would
    /// turn every `1.0 - distance` into nonsense without failing anything.
    #[test]
    fn a_description_row_is_reachable_through_the_vec0_table() {
        let (_dir, db) = setup();
        insert_description_alias(&db, "b1", "Mr. Collins", "那个总在拍马屁的牧师", "谁最讨人厌", 30);
        insert_description_alias(&db, "b1", "Mr. Wickham", "那个骗钱的军官", "谁最讨人厌", 20);
        let id: String = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT id FROM book_person_aliases WHERE canonical = 'Mr. Collins'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let conn = db.conn.lock().unwrap();
        super::super::vector::ensure_alias_vector_table(&conn, 4).unwrap();
        conn.execute(
            "INSERT INTO book_alias_vectors (alias_id, book_id, embedding) VALUES (?1, 'b1', ?2)",
            params![id, super::super::vector::embedding_json(&[1.0, 0.0, 0.0, 0.0]).unwrap()],
        )
        .unwrap();

        // Same direction as the stored vector, different magnitude: under
        // cosine this is a perfect match, under L2 it is nowhere near one.
        let mut near = empty_resolution("谁最讨人厌");
        assert!(resolve_descriptions(&conn, "b1", &[3.0, 0.0, 0.0, 0.0], &mut near).unwrap());
        assert_eq!(near.confidence, AliasConfidence::Medium);
        assert_eq!(near.matched[0].alias, "那个总在拍马屁的牧师");
        assert_eq!(near.matched[0].canonicals, vec!["Mr. Collins".to_string()]);
        assert_eq!(near.expanded_query, "谁最讨人厌 Mr. Collins");

        // Orthogonal: cosine 0, well under the floor.
        let mut far = empty_resolution("谁最讨人厌");
        assert!(!resolve_descriptions(&conn, "b1", &[0.0, 1.0, 0.0, 0.0], &mut far).unwrap());
        assert!(far.matched.is_empty());
    }

    #[test]
    fn a_description_row_with_no_vector_is_simply_not_found() {
        // The save-without-a-vector row from `teach_description_alias`: it
        // exists in `book_person_aliases` and is invisible to pass two until
        // `ensure_alias_embeddings` gets to it. Invisible, not an error.
        let (_dir, db) = setup();
        insert_description_alias(&db, "b1", "Mr. Collins", "那个总在拍马屁的牧师", "谁最讨人厌", 30);
        let conn = db.conn.lock().unwrap();
        super::super::vector::ensure_alias_vector_table(&conn, 4).unwrap();
        let mut resolution = empty_resolution("谁最讨人厌");
        assert!(!resolve_descriptions(&conn, "b1", &[1.0, 0.0, 0.0, 0.0], &mut resolution).unwrap());
        assert_eq!(resolution.confidence, AliasConfidence::None);
    }

    #[test]
    fn another_books_description_row_is_never_returned() {
        let (_dir, db) = setup();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at, language)
                 VALUES ('b2', 'Emma', 'Jane Austen', 'b2.epub', 'unread', 0, '1970-01-01', '1970-01-01', 'en')",
                [],
            )
            .unwrap();
        insert_description_alias(&db, "b2", "Mr. Elton", "那个总在拍马屁的牧师", "谁最讨人厌", 30);
        let id: String = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT id FROM book_person_aliases", [], |row| row.get(0))
            .unwrap();
        let conn = db.conn.lock().unwrap();
        super::super::vector::ensure_alias_vector_table(&conn, 4).unwrap();
        conn.execute(
            "INSERT INTO book_alias_vectors (alias_id, book_id, embedding) VALUES (?1, 'b2', ?2)",
            params![id, super::super::vector::embedding_json(&[1.0, 0.0, 0.0, 0.0]).unwrap()],
        )
        .unwrap();
        let mut resolution = empty_resolution("谁最讨人厌");
        assert!(!resolve_descriptions(&conn, "b1", &[1.0, 0.0, 0.0, 0.0], &mut resolution).unwrap());
    }

    #[tokio::test]
    async fn teaching_a_description_alias_with_no_embedding_model_still_saves_it() {
        // Design rule 4: the text row is what the reader typed and the vector
        // is derived data. Losing the former because the latter could not be
        // computed would ask them to remember what they wrote.
        let (_dir, db) = setup();
        let secrets = crate::secrets::Secrets::init_in_memory().unwrap();
        let id = teach_description_alias(
            &db,
            &secrets,
            "b1",
            "Mr. Collins",
            "那个总在拍马屁的牧师",
            Some("谁最讨人厌"),
        )
        .await
        .unwrap();
        let conn = db.conn.lock().unwrap();
        let (kind, source_query): (String, Option<String>) = conn
            .query_row(
                "SELECT kind, source_query FROM book_person_aliases WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(kind, "description");
        assert_eq!(source_query.as_deref(), Some("谁最讨人厌"));
        let vectors: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM book_person_alias_embeddings WHERE alias_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(vectors, 0, "no model configured, so no vector — and no error");
    }

    #[test]
    fn deleting_a_taught_alias_takes_its_vector_with_it() {
        // `PRAGMA foreign_keys=OFF` means migration 060's REFERENCES clause
        // will not do this for us, and a surviving vector would go on matching
        // for an alias the reader deleted.
        let (_dir, db) = setup();
        insert_description_alias(&db, "b1", "Mr. Collins", "那个总在拍马屁的牧师", "谁最讨人厌", 30);
        let id: String = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT id FROM book_person_aliases", [], |row| row.get(0))
            .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            super::super::vector::ensure_alias_vector_table(&conn, 4).unwrap();
            conn.execute(
                "INSERT INTO book_person_alias_embeddings
                   (alias_id, book_id, embedding, dimensions, model, created_at)
                 VALUES (?1, 'b1', x'00', 4, 'test-model', 0)",
                params![id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO book_alias_vectors (alias_id, book_id, embedding) VALUES (?1, 'b1', ?2)",
                params![id, super::super::vector::embedding_json(&[1.0, 0.0, 0.0, 0.0]).unwrap()],
            )
            .unwrap();
        }
        delete_person_alias(&db, &id).unwrap();
        let conn = db.conn.lock().unwrap();
        for table in ["book_person_alias_embeddings", "book_alias_vectors"] {
            let remaining: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(remaining, 0, "{table} still holds a vector for a deleted alias");
        }
    }

    #[test]
    fn clearing_a_books_aliases_clears_its_vectors_too() {
        let (_dir, db) = setup();
        insert_description_alias(&db, "b1", "Mr. Collins", "那个总在拍马屁的牧师", "谁最讨人厌", 30);
        let id: String = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT id FROM book_person_aliases", [], |row| row.get(0))
            .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            super::super::vector::ensure_alias_vector_table(&conn, 4).unwrap();
            conn.execute(
                "INSERT INTO book_person_alias_embeddings
                   (alias_id, book_id, embedding, dimensions, model, created_at)
                 VALUES (?1, 'b1', x'00', 4, 'test-model', 0)",
                params![id],
            )
            .unwrap();
        }
        clear_person_aliases(&db, "b1").unwrap();
        let conn = db.conn.lock().unwrap();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_person_alias_embeddings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining, 0);
    }
}

/// A real build pass, against the reader's own library and a real provider.
///
/// Two questions the unit tests above structurally cannot answer, both of them
/// about what a model actually does rather than about what this file does with
/// the answer:
///
/// 1. **The rate a reader feels.** A 12-call hand-run measured roughly half of
///    single calls coming back unusable — parseable, well-formed, and with the
///    book's own spellings nowhere in them. `MAX_BUILD_ATTEMPTS` was set to 3
///    off that number. What nobody has measured is the rate *after* those three
///    attempts, which is the only rate a reader ever experiences.
/// 2. **Whether the old table really survives.** `clear_auto_aliases` sits in
///    the `Commit` branch and a unit test pins it there, but pinning a branch
///    is not the same as watching a real three-in-a-row failure leave a real
///    table alone.
///
/// ```text
/// cargo test --manifest-path src-tauri/Cargo.toml \
///   live_alias_build_usable_rate -- --ignored --nocapture
/// ```
///
/// `LANTERN_ALIAS_PASSES` sets how many passes to run (default 6) and
/// `LANTERN_ALIAS_CONCURRENCY` how many of them are in flight at once
/// (default: all of them, capped at 12) — each pass owns its own copy of the
/// library, so the only real ceiling is the account's concurrency limit.
///
/// `LANTERN_ALIAS_MODEL` overrides the model **in the copied database only**,
/// which is how the second arm is run: the shipped failure copy tells a reader
/// that a stronger model is steadier, and that claim is about readers on
/// *smaller* models than the one configured here. Pointing this at a small
/// model on the same key is what turns that sentence from plausible into
/// measured. `LANTERN_ALIAS_BASE_URL` + `LANTERN_ALIAS_KEY` move the arm to a
/// different provider entirely, and `LANTERN_ALIAS_EFFORT` sets reasoning
/// effort — which, because this is a `Utility` request, also has to turn
/// `reasoning_effort_all_features` on or the arm would measure `none` under
/// whatever label it was given.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::ai::grounding::live_data::copy_app_data;

    /// The prompt is built from chapter summaries, not from the book's text, so
    /// a freshly-indexed epub would measure the wrong question: with no
    /// summaries `build_messages` sends title and author alone and the model
    /// has to recall the spellings from memory. Readers hit this pass *after*
    /// summarisation, so the run takes whichever book in the reader's own
    /// library actually has summaries — and the one with the most of them,
    /// since a book summarised halfway is its own confound.
    fn book_with_summaries(conn: &Connection) -> Option<(String, String, i64)> {
        conn.query_row(
            "SELECT b.id, b.title, COUNT(*) AS sections
               FROM book_summaries s JOIN books b ON b.id = s.book_id
              WHERE s.scope = 'section'
              GROUP BY b.id
              ORDER BY sections DESC
              LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .unwrap()
    }

    /// Every `(canonical, alias, source)` in the table, sorted — the thing that
    /// must not move when a pass fails.
    fn snapshot(conn: &Connection, book_id: &str) -> Vec<(String, String, String)> {
        let mut statement = conn
            .prepare(
                "SELECT canonical, alias, source FROM book_person_aliases
                  WHERE book_id = ?1 ORDER BY canonical, alias, source",
            )
            .unwrap();
        statement
            .query_map(params![book_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn env_count(name: &str, default: u32) -> u32 {
        std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(default)
    }

    /// The arm under test. Every field comes from the environment because one
    /// of them is an API key: a second arm has to be describable without a
    /// credential ever entering a tracked file.
    ///
    /// `LANTERN_ALIAS_MODEL` alone switches the model on the reader's own
    /// configured endpoint. Adding `LANTERN_ALIAS_BASE_URL` and
    /// `LANTERN_ALIAS_KEY` replaces the endpoint too, which is what measuring a
    /// different provider's small model needs.
    struct Arm {
        base_url: Option<String>,
        model: Option<String>,
        key: Option<String>,
        effort: Option<String>,
    }

    impl Arm {
        fn from_env() -> Self {
            let read = |name: &str| {
                std::env::var(name)
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            };
            Self {
                base_url: read("LANTERN_ALIAS_BASE_URL"),
                model: read("LANTERN_ALIAS_MODEL"),
                key: read("LANTERN_ALIAS_KEY"),
                effort: read("LANTERN_ALIAS_EFFORT"),
            }
        }

        fn describe(&self) -> String {
            let model = self.model.as_deref().unwrap_or("<as configured>");
            let endpoint = self.base_url.as_deref().unwrap_or("<as configured>");
            let effort = self.effort.as_deref().unwrap_or("<Lantern's default>");
            format!("model {model} at {endpoint}, reasoning effort {effort}")
        }

        /// Rewrites the copied database into a single-profile configuration.
        /// The copy only — nothing here can reach the reader's own settings,
        /// and the key is written to the copied `secrets.db`, which the temp
        /// directory takes with it when the test ends.
        fn apply(&self, db: &Db, secrets: &Secrets) {
            if self.base_url.is_none() && self.model.is_none() {
                return;
            }
            let Some(base_url) = self.base_url.as_deref() else {
                // Model-only: keep the reader's endpoints and credentials.
                let conn = db.conn.lock().unwrap();
                let changed = conn
                    .execute(
                        "UPDATE ai_profiles SET model = ?1, reasoning_effort = ?2,
                                reasoning_effort_all_features = ?3",
                        params![
                            self.model.as_deref().unwrap(),
                            self.effort.as_deref(),
                            i64::from(self.effort.is_some()),
                        ],
                    )
                    .unwrap();
                assert!(changed > 0, "no ai_profiles row to point at the arm");
                return;
            };
            let model = self
                .model
                .as_deref()
                .expect("LANTERN_ALIAS_BASE_URL needs LANTERN_ALIAS_MODEL");
            let key = self
                .key
                .as_deref()
                .expect("LANTERN_ALIAS_BASE_URL needs LANTERN_ALIAS_KEY");
            const SECRET_REF: &str = "ai_api_key/live-arm";
            secrets.set(SECRET_REF, key).unwrap();
            let conn = db.conn.lock().unwrap();
            // Failover is the enemy of a measurement: if this endpoint refuses,
            // the run has to fail loudly rather than quietly answering from the
            // reader's other provider.
            conn.execute("DELETE FROM ai_profiles", []).unwrap();
            conn.execute(
                "INSERT INTO ai_profiles
                   (id, label, provider, auth_mode, base_url, model, temperature,
                    enabled, priority, created_at, updated_at,
                    reasoning_effort, reasoning_effort_all_features)
                 VALUES ('live-arm', 'live arm', 'custom', 'api_key', ?1, ?2, 0.3,
                         1, 0, 0, 0, ?3, ?4)",
                params![
                    base_url,
                    model,
                    self.effort.as_deref(),
                    // The alias pass is a `Utility` request, and utility
                    // requests are pinned to `none` unless the profile opts
                    // every feature in. Asking for max effort and leaving this
                    // off would have measured `none` under a `max` label.
                    i64::from(self.effort.is_some()),
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO ai_credentials
                   (id, profile_id, label, secret_ref, masked_suffix, enabled,
                    priority, state, created_at, updated_at)
                 VALUES ('live-arm-key', 'live-arm', 'live arm', ?1, ?2, 1, 0,
                         'active', 0, 0)",
                params![SECRET_REF, &key[key.len().saturating_sub(4)..]],
            )
            .unwrap();
        }
    }

    /// One pass's own copy of the reader's library.
    ///
    /// Every pass rebuilds the *same* book's alias table, and a successful
    /// build clears the automatic rows before writing the new ones. Sharing
    /// one database across concurrent passes would let one pass's clear land
    /// between another's `before` and `after` snapshots, and the assertion
    /// that a failed build left the old table alone would be reading someone
    /// else's write. So each pass gets its own copy — ~13MB, well under a
    /// second to make, against the tens of minutes an arm cost when the passes
    /// were run one at a time waiting on a model each turn.
    struct Lab {
        /// Held only so the copy outlives the pass that reads it.
        _directory: tempfile::TempDir,
        db: Db,
        secrets: Secrets,
        book_id: String,
    }

    /// A copy, configured for the arm and seeded, plus the book it landed on.
    fn open_lab(arm: &Arm) -> (Lab, String, i64) {
        let directory = tempfile::TempDir::new().unwrap();
        let Some(()) = copy_app_data(directory.path()) else {
            panic!("no Lantern app data on this machine to copy");
        };
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init(&directory.path().to_path_buf()).unwrap();
        arm.apply(&db, &secrets);

        let (book_id, title, sections) = {
            let conn = db.conn.lock().unwrap();
            book_with_summaries(&conn).expect("no book in this library has section summaries")
        };
        {
            let conn = db.conn.lock().unwrap();
            // The copy inherits whatever cooldown the reader's own use — or an
            // earlier arm — left on the credential, and `run_build_pass` asks
            // in `Automatic` mode, which honours it. Left alone, the run
            // answers a question nobody asked: the pass returns
            // `AI_KEYS_COOLING_DOWN` without ever sending a request, and the
            // arm reports n passes while holding none. Clearing it is what the
            // reader does by hand when they press 再试一次, which routes as
            // `Manual` and skips cooldowns too.
            conn.execute(
                "UPDATE ai_credentials SET state = 'active', cooldown_until = NULL",
                [],
            )
            .unwrap();
            conn.execute("UPDATE ai_profiles SET state = 'active', cooldown_until = NULL", [])
                .unwrap();
            // Seed a table so "the old table survived" is a claim about
            // something. The reader's row is the one that matters most: a
            // rebuild that loses a correction they typed by hand is the worst
            // version of this bug.
            for (id, canonical, alias, source) in [
                ("seed-auto-1", "Seeded Canonical", "seeded-auto-alias", "auto"),
                ("seed-user-1", "Seeded Canonical", "seeded-taught-alias", "user"),
            ] {
                conn.execute(
                    "INSERT OR REPLACE INTO book_person_aliases
                       (id, book_id, canonical, alias, source, mentions, created_at, kind, source_query)
                     VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, 'name', NULL)",
                    params![id, &book_id, canonical, alias, source],
                )
                .unwrap();
            }
        }
        (
            Lab { _directory: directory, db, secrets, book_id },
            title,
            sections,
        )
    }

    /// The built table as a person per line, for reading rather than for
    /// asserting on.
    ///
    /// A rate says the reply parsed and named people the book really contains.
    /// It says nothing about whether the table is any good — `evaluate_attempt`
    /// checks that each canonical appears in the book and never looks at the
    /// aliases hung off it, so a run can be 6/6 "usable" and still be listing
    /// every servant twice under a misspelling. `LANTERN_ALIAS_DUMP=1` prints
    /// this, because judging the output is a thing a person has to do by eye
    /// and they can only do it if the run shows them the output.
    fn group_for_reading(rows: &[(String, String, String)]) -> Vec<String> {
        let mut lines: Vec<String> = Vec::new();
        for (canonical, alias, source) in rows {
            let entry = if source == "user" { format!("{alias}*") } else { alias.clone() };
            match lines.last_mut() {
                Some(line) if line.starts_with(&format!("{canonical} · ")) => {
                    line.push_str(", ");
                    line.push_str(&entry);
                }
                _ => lines.push(format!("{canonical} · {entry}")),
            }
        }
        lines
    }

    /// How one pass ended. Carried out of the concurrent fan-out rather than
    /// printed and asserted inside it, so the report reads in pass order
    /// instead of in whatever order the endpoint happened to answer.
    enum Verdict {
        Built { attempts: u32, rows: usize, taught_kept: bool, table: Vec<String> },
        Unusable { rows: usize, unchanged: bool },
        /// Not a verdict on the model's output: the request never came back,
        /// so `run_build_pass` bailed out of the retry loop on the attempt
        /// that failed rather than using up all three. Counting these as
        /// unusable attempts would blame the model for the transport, and
        /// counting them as usable ones — which an earlier version of this
        /// test did — would report a stream that died as three clean answers.
        NoAnswer(String),
    }

    #[tokio::test]
    #[ignore = "needs a configured AI provider and spends real tokens; run manually"]
    async fn live_alias_build_usable_rate() {
        use futures::StreamExt;

        let arm = Arm::from_env();
        let passes = env_count("LANTERN_ALIAS_PASSES", 6);
        // The passes are independent requests to the same endpoint against
        // independent copies of the library, so nothing here needs them
        // staggered — only the account's own concurrency limit does. Default
        // to running the whole arm at once, with a cap that keeps an
        // absent-mindedly large `LANTERN_ALIAS_PASSES` from opening one
        // connection per pass at the same instant.
        let concurrency = env_count("LANTERN_ALIAS_CONCURRENCY", passes.min(12)).max(1) as usize;
        let dump = std::env::var("LANTERN_ALIAS_DUMP").is_ok();

        let mut labs = Vec::new();
        let mut header = None;
        for _ in 0..passes {
            let (lab, title, sections) = open_lab(&arm);
            header.get_or_insert((title, sections));
            labs.push(lab);
        }
        let (title, sections) = header.expect("LANTERN_ALIAS_PASSES must be at least 1");
        println!(
            "=== {title}: {sections} section summaries, {}, {passes} passes at concurrency {concurrency} ===",
            arm.describe()
        );

        let app = tauri::test::mock_app();
        let handle = app.handle();
        let mut verdicts: Vec<(u32, Verdict)> = futures::stream::iter(labs.iter().enumerate())
            .map(|(index, lab)| async move {
                let before = {
                    let conn = lab.db.conn.lock().unwrap();
                    snapshot(&conn, &lab.book_id)
                };
                let verdict =
                    match run_build_pass(handle, &lab.db, &lab.secrets, &lab.book_id, "user").await {
                        Ok(attempts) => {
                            let rows = {
                                let conn = lab.db.conn.lock().unwrap();
                                snapshot(&conn, &lab.book_id)
                            };
                            Verdict::Built {
                                attempts,
                                taught_kept: rows.iter().any(|(_, alias, source)| {
                                    alias == "seeded-taught-alias" && source == "user"
                                }),
                                table: group_for_reading(&rows),
                                rows: rows.len(),
                            }
                        }
                        Err(error) => {
                            let message = error.to_string();
                            if message.contains("PERSON_ALIASES_AI_UNUSABLE") {
                                let after = {
                                    let conn = lab.db.conn.lock().unwrap();
                                    snapshot(&conn, &lab.book_id)
                                };
                                Verdict::Unusable {
                                    rows: after.len(),
                                    unchanged: before == after,
                                }
                            } else {
                                Verdict::NoAnswer(message)
                            }
                        }
                    };
                (index as u32 + 1, verdict)
            })
            .buffer_unordered(concurrency)
            .collect()
            .await;
        verdicts.sort_by_key(|(pass, _)| *pass);

        let mut succeeded = 0u32;
        let mut attempts_total = 0u32;
        let mut unusable_attempts = 0u32;
        let mut other_failures: Vec<String> = Vec::new();
        // Only meaningful for passes that actually failed three in a row; a
        // count of zero at the end is not a pass, it is a run that never
        // reached the case, and the report has to say so rather than imply the
        // invariant was exercised.
        let mut survivals = 0u32;

        for (pass, verdict) in &verdicts {
            match verdict {
                Verdict::Built { attempts, rows, taught_kept, table } => {
                    succeeded += 1;
                    attempts_total += attempts;
                    unusable_attempts += attempts - 1;
                    println!(
                        "pass {pass}: ok on attempt {attempts}, {rows} rows over {} people, \
                         taught row kept: {taught_kept}",
                        table.len()
                    );
                    if dump {
                        for line in table {
                            println!("    {line}");
                        }
                    }
                    assert!(
                        *taught_kept,
                        "a successful build deleted a row the reader taught by hand"
                    );
                }
                Verdict::Unusable { rows, unchanged } => {
                    attempts_total += MAX_BUILD_ATTEMPTS;
                    unusable_attempts += MAX_BUILD_ATTEMPTS;
                    println!(
                        "pass {pass}: unusable after {MAX_BUILD_ATTEMPTS} attempts, \
                         table unchanged at {rows} rows"
                    );
                    assert!(
                        *unchanged,
                        "three failed attempts changed the table (pass {pass})"
                    );
                    survivals += 1;
                }
                Verdict::NoAnswer(message) => {
                    other_failures.push(message.clone());
                    println!("pass {pass}: no verdict, the request failed — {message}");
                }
            }
        }

        println!("\n=== {passes} passes, {} ===", arm.describe());
        // Rates are over the passes that got an answer to judge. A pass whose
        // request died is a real failure the reader would see, but it is not
        // evidence about whether this model can name the book's people, and
        // averaging it in either direction would answer a different question
        // than the one the shipped copy makes a claim about.
        let judged = passes - other_failures.len() as u32;
        if judged == 0 {
            println!("no pass got an answer to judge; every request failed before a verdict");
        } else {
            println!(
                "pass-level usable rate: {succeeded}/{judged} judged passes ({:.0}%)",
                100.0 * f64::from(succeeded) / f64::from(judged)
            );
            println!(
                "attempt-level usable rate: {}/{attempts_total} ({:.0}%)",
                attempts_total - unusable_attempts,
                100.0 * f64::from(attempts_total - unusable_attempts) / f64::from(attempts_total)
            );
        }
        println!("{}/{passes} passes never got an answer at all", other_failures.len());
        if survivals == 0 {
            println!(
                "no pass failed {MAX_BUILD_ATTEMPTS} times in a row, so the \
                 table-survives-failure case was never reached in this run"
            );
        } else {
            println!("{survivals} three-in-a-row failures, table unchanged after every one");
        }
        if !other_failures.is_empty() {
            println!("{} passes failed for other reasons:", other_failures.len());
            for message in &other_failures {
                println!("  {message}");
            }
        }
    }
}
