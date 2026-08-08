//! Verbatim quote retrieval — "真句检索", step 3 of the user-profile feature
//! (design: `docs/impls/user-profile-mockup.html`, Appendix A, row "真句检索
//! （第三步）"). Given a query word plus the reader's current book and
//! position, this hands back a handful of real sentences — from books the
//! reader has actually reached — that contain the word or one of its known
//! forms, for a caller to cite or jump to.
//!
//! Its caller is `commands::ai::chat`, on the follow-up chain only: when a
//! turn names a specific word (the reader tapped 追问 on a lookup, a
//! translation, or an explanation), the sentences come back as a data block
//! in that turn's prompt, each attributed to the book it came from. The model
//! is free to use none of them — a word can be in three books in a sense that
//! has nothing to do with the one being asked about.
//!
//! ## Reused, not reinvented
//!
//! - **Word forms**: [`crate::commands::word_marks::query_word_forms_for`] —
//!   the same lookup the reader's "highlight every form of this word"
//!   feature already uses, so this module and that feature agree on what
//!   counts as a form of a word.
//! - **CJK-aware segmentation**: [`super::segment::segment_for_fts`] and
//!   [`super::segment::is_cjk`] — the same functions the index itself is
//!   built with, so a form's tokens and its sentence-level substring check
//!   both classify CJK the same way the index does.
//! - **"Already read" boundary**: [`super::spoiler::cutoff_for_position`]
//!   (plus its `parse_text_offset`/`parse_spine_section` helpers, reused to
//!   detect a live position this module cannot trust) — the exact function
//!   `ai_spoiler_guard` uses to turn a render format and a saved position
//!   into a [`super::retrieve::SpoilerCutoff`]. See `find_quotes` below for
//!   why this module calls the pure boundary function directly rather than
//!   `spoiler::resolve_cutoff`.
//! - **Sentence splitting**: [`super::chunk::sentence_split`] — the same
//!   CJK-aware sentence boundaries used when chunks are first built.
//!
//! ## Why one FTS scan, not one per book
//!
//! An earlier version of this module ran `book_chunks_fts MATCH` once per
//! eligible book (mirroring `retrieve::lexical_ranks_with_limit`, which is
//! built for exactly one book at a time — book chat always knows which book
//! it's grounding). This module doesn't have that luxury: it searches the
//! whole library. N books meant N full index scans for one query. Instead,
//! `matching_chunks_all_books` runs the `MATCH` once, with no `book_id` and
//! no cutoff in the `WHERE` clause, and the per-book cutoff is applied in
//! Rust after grouping the hits by `book_id`. The database connection is
//! acquired once for that one query (plus fetching book scopes) and
//! released before any of the grouping, filtering, or sentence-extraction
//! work below — none of that needs the lock.
//!
//! That single query still has to guard against one book's flood of matches
//! starving every other book: a plain `ORDER BY bm25(...) LIMIT N` ranks
//! every matching chunk in the whole library against every other one before
//! any per-book cutoff has even been applied, so a handful of books with
//! many short, highly-ranked chunks can fill the entire window before a
//! book the reader has actually been reading gets a single row in — cutoff
//! filtering downstream then has nothing left of that book to filter.
//! `matching_chunks_all_books` guards against this by capping fairly in
//! Rust while streaming the query's bm25-ordered rows — at most
//! `MAX_CANDIDATE_CHUNKS_PER_BOOK` rows accepted for any one book, until
//! `MAX_TOTAL_CANDIDATE_CHUNKS` rows have been accepted in total — rather
//! than in SQL: SQLite's FTS5 `bm25()` auxiliary function cannot be
//! evaluated inside a window function, so the more obvious
//! `ROW_NUMBER() OVER (PARTITION BY book_id ORDER BY bm25(...))` cannot
//! express this. Either way, every book that matches at all is guaranteed
//! up to `MAX_CANDIDATE_CHUNKS_PER_BOOK` rows of its own before any other
//! book's volume can crowd it out of the global cap.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::segment::{is_cjk, segment_for_fts, SegmentMode};
use super::spoiler::{cutoff_for_position, parse_spine_section, parse_text_offset};
use super::retrieve::SpoilerCutoff;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// A sentence over this length is skipped outright rather than truncated —
/// Appendix A is explicit that a candidate is either a complete sentence or
/// not a candidate at all.
const MAX_SENTENCE_CHARS: usize = 300;
/// Final cap applied *after* the per-book partition below, across every
/// book together. Generous: a personal library's `book_chunks_fts` is a few
/// thousand rows at most, and since every matching book already secured up
/// to `MAX_CANDIDATE_CHUNKS_PER_BOOK` rows of its own before this cap is
/// applied, this bounds the worst case rather than being a tuning knob a
/// reader would ever feel.
const MAX_TOTAL_CANDIDATE_CHUNKS: usize = 500;
/// How many of a book's own hit chunks are kept, ranked by bm25 within that
/// book — enforced in Rust by `matching_chunks_all_books` while it streams
/// the query's bm25-ordered rows, before the global cap above and before
/// cutoff filtering. This is what keeps one book's volume of matches from
/// crowding another book out of the results entirely (see the module-level
/// "Why one FTS scan, not one per book" note). Generous relative to the
/// final per-book quota (2) because not every hit chunk necessarily yields
/// a sentence short enough, or one where the word survives cutoff
/// filtering and into the sentence itself.
const MAX_CANDIDATE_CHUNKS_PER_BOOK: usize = 20;
/// First round: one sentence per book, for source diversity.
const FIRST_ROUND_PER_BOOK: usize = 1;
/// Second round, only if the first left the total quota unfilled.
const SECOND_ROUND_PER_BOOK: usize = 2;
/// Hard cap on the number of candidates handed back, matching Appendix A's
/// "≤ 3–5 条候选句".
const MAX_TOTAL_QUOTES: usize = 5;
/// How much text on either side of a quoted sentence travels with it as
/// anchoring context. Short enough that it stays inside the same paragraph in
/// the rendered page — context that crosses a block boundary describes a
/// stretch of text the DOM never has contiguously — and long enough to tell
/// two similar passages apart.
const CONTEXT_CHARS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteCandidate {
    pub book_id: String,
    /// `books.title`, carried along because every caller needs it and the
    /// scope read above already had the row in hand — making the caller
    /// re-query `books` for a string this function just held would be the
    /// only reason it ever needed `book_id`.
    pub book_title: String,
    /// Spine position of the section this sentence sits in. The frontend needs
    /// it to open that one section's document and anchor inside it;
    /// `section_href` alone identifies the file but not its place in the spine.
    pub section_index: i64,
    pub section_href: Option<String>,
    /// The *chunk's* starting offset (UTF-16 code units, matching
    /// `book_chunks.char_start` — see `commands::books::text_headings::
    /// utf16_len`), not the sentence's own offset within that chunk. A
    /// precise per-sentence offset cannot be recovered here: by the time a
    /// chunk reaches `book_chunks.text`, `extract::normalize_whitespace`
    /// has already collapsed each block's internal whitespace and
    /// `chunk::draft` has joined separate blocks with an inserted `"\n"` —
    /// neither of which exists at that exact length in the original source
    /// string — so a character position inside `book_chunks.text` no longer
    /// lines up linearly with a position in the source. (Sentence
    /// splitting, which runs after that, is not the cause — it never had a
    /// linear mapping to preserve in the first place.)
    ///
    /// Only ever `Some` for `render_format == "text"` — EPUB and PDF chunks
    /// carry no character offset at all in `book_chunks` (their location is
    /// the section itself), so this stays `None` for them, matching what
    /// `book_chunks` already has rather than fabricating a number. A caller
    /// that wants to jump to the exact sentence should locate `text` within
    /// the rendered section content, using `section_href` to find the
    /// section — not treat this field as sentence-precise.
    pub chunk_char_start: Option<i64>,
    pub text: String,
    /// The text immediately before and after `text` inside the same chunk, up
    /// to `CONTEXT_CHARS` each way. These are anchoring context, not content:
    /// they never enter a prompt. The frontend locates `text` in the rendered
    /// section by approximate match, and two passages in one chapter can look
    /// alike enough that the quote alone picks the wrong one — the surrounding
    /// text is what tells them apart. Empty when the sentence sits at a chunk
    /// boundary, which is a weaker anchor but still a valid one.
    pub prefix: String,
    pub suffix: String,
}

/// One book's reading-range scope: the spoiler cutoff nothing past it may be
/// quoted, plus the recency marker used to order books most-recently-read
/// first.
struct BookScope {
    book_id: String,
    title: String,
    cutoff: SpoilerCutoff,
    /// `books.updated_at` — the row's last-write time, not a dedicated
    /// last-*read* timestamp. Renaming a book or editing its metadata bumps
    /// this the same as turning a page would. It is the closest thing the
    /// current schema has to "most recently read first," and is treated
    /// here as an approximation of that, not a precise reading-recency log.
    updated_at: i64,
}

/// A book counts as "read" for quote-scoping purposes once it has a saved
/// position. An absent or blank `current_cfi` means the reader has never
/// opened past the cover, so nothing in it is fair game to quote — mirrors
/// Appendix A's "没有阅读进度的书整本排除".
fn book_has_progress(current_cfi: Option<&str>) -> bool {
    current_cfi.is_some_and(|value| !value.trim().is_empty())
}

/// Whether `value` parses as a position for `render_format`, using the same
/// parsers `cutoff_for_position` itself uses internally. `cutoff_for_position`
/// never reports a parse failure — an unparseable value silently becomes
/// cutoff zero — so this exists purely to let a caller decide *whether* to
/// trust a value before handing it to that function.
fn position_parses(render_format: &str, value: &str) -> bool {
    if render_format == "text" {
        parse_text_offset(value).is_some()
    } else {
        parse_spine_section(value).is_some()
    }
}

/// Union the normalized word with its known forms, normalized word first.
/// `stored_forms` never repeats the base word itself (see
/// `commands::word_marks::normalized_forms`), so a missing or empty forms
/// row degrades cleanly to exact matching on the original word alone —
/// Appendix A's "词形缺失退化为原词精确匹配".
fn expand_forms(normalized_word: &str, stored_forms: Option<&[String]>) -> Vec<String> {
    let mut forms = vec![normalized_word.to_string()];
    for form in stored_forms.into_iter().flatten() {
        let trimmed = form.trim();
        if !trimmed.is_empty() && !forms.iter().any(|existing| existing == trimmed) {
            forms.push(trimmed.to_string());
        }
    }
    forms
}

/// Look up the query word's stored forms and expand them. A DB miss on
/// `word_forms` is not an error here — it is exactly the "forms missing"
/// case `expand_forms` already degrades gracefully from.
///
/// A single-ASCII-letter word (or form) is not itself rejected here — that
/// filtering happens downstream in `build_match_expression`, inherited from
/// the same noise filter `retrieve::fts_query` applies to chat's own
/// search: a lone Latin letter has no discriminating power for bm25 and
/// would rank as many pages as it excludes, so it silently contributes no
/// FTS candidates rather than matching everything. See that function for
/// the CJK exception.
fn forms_for_word(db: &Db, word: &str) -> AppResult<Vec<String>> {
    let normalized = crate::sync::events::normalize_learning_term(word);
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let entries =
        crate::commands::word_marks::query_word_forms_for(db, vec![normalized.clone()])?;
    let stored_forms = entries.into_iter().next().map(|entry| entry.forms);
    Ok(expand_forms(&normalized, stored_forms.as_deref()))
}

/// Build the FTS5 `MATCH` expression that ORs every form together.
///
/// Each form is run through `segment_for_fts` so a CJK form gets the same
/// index-compatible tokens the index itself was built with, and the whole
/// segmented result is then wrapped as *one quoted phrase* — not OR'd
/// token-by-token. This is not a mirror of `retrieve::fts_query`: that
/// function ORs individual tokens, which matches if any one of them
/// appears anywhere; a quoted phrase is stricter; it additionally demands
/// the tokens appear adjacent and in that exact order. The two functions
/// happen to agree on one thing — a segmented form under 2 bytes is
/// dropped, which produces the same practical effect as `fts_query`'s
/// noise filter (`token.len() >= 2`): a lone ASCII letter (1 byte) is
/// dropped, a lone CJK character (multiple bytes in UTF-8) survives, which
/// is deliberate — unlike English, a single CJK character is often a
/// complete, meaningful query on its own.
///
/// Known limitation of the phrase-quoting: if a form itself contains an
/// internal space with a CJK character on both sides (a genuine multi-word
/// CJK form, not merely a segmentation artifact), the resulting phrase can
/// never match anything — FTS5 requires a phrase's tokens to be adjacent,
/// and the raw space inside the source form breaks that adjacency.
fn build_match_expression(forms: &[String]) -> String {
    forms
        .iter()
        .filter_map(|form| {
            let segmented = segment_for_fts(form, SegmentMode::Query);
            let trimmed = segmented.trim();
            if trimmed.len() < 2 {
                None
            } else {
                Some(format!("\"{}\"", trimmed.replace('"', "\"\"")))
            }
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// Whether `form` is a "CJK form" for matching purposes — any CJK character
/// anywhere in it. Classification, not tokenization: this only decides
/// which containment rule `sentences_containing` applies below.
fn is_cjk_form(form: &str) -> bool {
    form.chars().any(is_cjk)
}

/// Does `haystack` contain `needle` as a whole word — a match with no
/// alphanumeric character immediately before or after it?
fn word_boundary_contains(haystack: &str, needle: &str) -> bool {
    let haystack_chars: Vec<char> = haystack.chars().collect();
    let needle_chars: Vec<char> = needle.chars().collect();
    let needle_len = needle_chars.len();
    if needle_len == 0 || haystack_chars.len() < needle_len {
        return false;
    }
    for start in 0..=(haystack_chars.len() - needle_len) {
        if haystack_chars[start..start + needle_len] == needle_chars[..] {
            let before_ok = start == 0 || !haystack_chars[start - 1].is_alphanumeric();
            let after_ok = start + needle_len == haystack_chars.len()
                || !haystack_chars[start + needle_len].is_alphanumeric();
            if before_ok && after_ok {
                return true;
            }
        }
    }
    false
}

/// Whether `sentence_lower` (already lowercased) contains `form_lower`
/// (already lowercased) as a genuine occurrence of that form.
///
/// A non-CJK, fully-alphanumeric form requires a word boundary on both
/// sides — otherwise "ran" would light up on "branch" or "Grant", and "run"
/// on "running" would silently duplicate what the "running" form itself
/// already finds. This is not just an ASCII rule: "он" ("he/it") must not
/// light up on "вагоне" ("carriage") any more than "ran" should on
/// "branch", so the boundary check applies to any alphanumeric script —
/// Cyrillic, Greek, accented Latin — not only `is_ascii_alphanumeric`.
/// A form containing any CJK character keeps plain substring matching: CJK
/// text has no whitespace between words, so there is no alphanumeric
/// boundary to check against in the first place. Anything else (a form
/// with internal punctuation, e.g. an apostrophe) also falls back to
/// substring matching rather than guessing at a boundary rule for it.
fn contains_form(sentence_lower: &str, form_lower: &str) -> bool {
    if form_lower.is_empty() {
        return false;
    }
    if !is_cjk_form(form_lower) && form_lower.chars().all(char::is_alphanumeric) {
        word_boundary_contains(sentence_lower, form_lower)
    } else {
        sentence_lower.contains(form_lower)
    }
}

/// Every book with a saved reading position, each carrying the spoiler
/// cutoff computed from that position. Order is not meaningful yet — the
/// caller merges in the current book's scope and sorts once.
fn candidate_books(conn: &rusqlite::Connection) -> AppResult<Vec<BookScope>> {
    let mut statement = conn.prepare(
        "SELECT id, title, COALESCE(render_format, format), current_cfi, updated_at FROM books",
    )?;
    let rows: Vec<(String, String, String, Option<String>, i64)> = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows
        .into_iter()
        .filter(|(_, _, _, current_cfi, _)| book_has_progress(current_cfi.as_deref()))
        .map(
            |(book_id, title, render_format, current_cfi, updated_at)| BookScope {
                cutoff: cutoff_for_position(&render_format, current_cfi.as_deref()),
                book_id,
                title,
                updated_at,
            },
        )
        .collect())
}

/// The `books` columns this module reads, for one book, regardless of whether
/// it has a saved position.
struct BookRow {
    title: String,
    render_format: String,
    current_cfi: Option<String>,
    updated_at: i64,
}

fn book_row(conn: &rusqlite::Connection, book_id: &str) -> AppResult<Option<BookRow>> {
    conn.query_row(
        "SELECT title, COALESCE(render_format, format), current_cfi, updated_at FROM books WHERE id = ?1",
        params![book_id],
        |row| {
            Ok(BookRow {
                title: row.get(0)?,
                render_format: row.get(1)?,
                current_cfi: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(AppError::from)
}

/// The current book's scope — preferring a *valid* live position over
/// whatever `books.current_cfi` last persisted (which may not have flushed
/// to disk yet), and falling back to that persisted position, the same
/// source every other book uses, when the live position is absent, blank,
/// or not parseable for this book's render format.
///
/// The fallback matters: a caller with no live position handy (or one that
/// failed to parse) must not have that treated as "position zero" — that
/// would silently cut a book with real progress down to its first chapter,
/// which is worse than just falling back to the same source used for every
/// other book.
fn current_book_scope(
    conn: &rusqlite::Connection,
    book_id: &str,
    current_position: Option<&str>,
) -> AppResult<Option<BookScope>> {
    let Some(BookRow {
        title,
        render_format,
        current_cfi,
        updated_at,
    }) = book_row(conn, book_id)?
    else {
        return Ok(None);
    };
    let live = current_position
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| position_parses(&render_format, value));
    let position = live.or(current_cfi.as_deref());
    if !book_has_progress(position) {
        return Ok(None);
    }
    Ok(Some(BookScope {
        book_id: book_id.to_string(),
        title,
        cutoff: cutoff_for_position(&render_format, position),
        updated_at,
    }))
}

/// One `book_chunks_fts` hit, still carrying enough of `book_chunks` to
/// apply a per-book cutoff and extract sentences, before it is known which
/// book's scope it will be filtered against.
struct GlobalHit {
    book_id: String,
    section_href: Option<String>,
    chunk_char_start: Option<i64>,
    section_index: i64,
    char_end: Option<i64>,
    text: String,
}

/// bm25-rank the forms against the *entire* index in one `MATCH` — no
/// `book_id` predicate, no cutoff predicate. See the module-level "Why one
/// FTS scan, not one per book" note for why this is a single query rather
/// than one per candidate book. Untruncated `text` matters here: a prompt
/// budget would risk cutting a sentence mid-word, which Appendix A forbids.
///
/// The query itself carries no `LIMIT` — capping fairly happens by
/// streaming its bm25-ordered results in Rust below, not in SQL. The
/// natural SQL expression of "cap each book, then cap the total" is
/// `ROW_NUMBER() OVER (PARTITION BY book_id ORDER BY bm25(...))`, but
/// SQLite's FTS5 auxiliary functions (`bm25()` among them) may only be
/// evaluated in the immediate SELECT that scans the FTS5 table — not from
/// inside a window function — and reject the query at runtime
/// ("unable to use function bm25 in the requested context") if asked to.
/// Streaming the cap in Rust instead is the "等价的 Rust 流式逐书封顶"
/// alternative from the same review that asked for the per-book cap in the
/// first place, and produces the identical result: rows arrive already
/// ranked best-first, so a book that matches at all is guaranteed up to
/// `MAX_CANDIDATE_CHUNKS_PER_BOOK` of its own rows regardless of how many
/// other books also match, before `MAX_TOTAL_CANDIDATE_CHUNKS` caps the
/// combined total.
fn matching_chunks_all_books(
    conn: &rusqlite::Connection,
    forms: &[String],
) -> AppResult<Vec<GlobalHit>> {
    let expression = build_match_expression(forms);
    if expression.is_empty() {
        return Ok(Vec::new());
    }
    let mut statement = conn.prepare(
        // Same weights as `retrieve::lexical_ranks_with_limit`: the book's
        // own words (seg_text) at 1.0, the context line at 0.3, the two
        // UNINDEXED identifier columns at 0.0.
        "SELECT book_chunks.book_id, book_chunks.section_href, book_chunks.char_start,
                book_chunks.section_index, book_chunks.char_end, book_chunks.text
         FROM book_chunks_fts
         JOIN book_chunks ON book_chunks.id = book_chunks_fts.chunk_id
           AND book_chunks.book_id = book_chunks_fts.book_id
         WHERE book_chunks_fts MATCH ?1
         ORDER BY bm25(book_chunks_fts, 1.0, 0.3, 0.0, 0.0)",
    )?;
    let mut rows = statement.query(params![expression])?;

    let mut per_book_counts: HashMap<String, usize> = HashMap::new();
    let mut hits = Vec::new();
    while let Some(row) = rows.next()? {
        if hits.len() >= MAX_TOTAL_CANDIDATE_CHUNKS {
            break;
        }
        let book_id: String = row.get(0)?;
        let count = per_book_counts.entry(book_id.clone()).or_insert(0);
        if *count >= MAX_CANDIDATE_CHUNKS_PER_BOOK {
            continue;
        }
        *count += 1;
        hits.push(GlobalHit {
            book_id,
            section_href: row.get(1)?,
            chunk_char_start: row.get(2)?,
            section_index: row.get(3)?,
            char_end: row.get(4)?,
            text: row.get(5)?,
        });
    }
    Ok(hits)
}

/// One matching sentence together with the text that surrounds it in its
/// chunk. See `QuoteCandidate::prefix` for why the context travels with it.
struct SentenceHit {
    text: String,
    prefix: String,
    suffix: String,
}

/// Complete sentences in `chunk_text` that contain one of `forms`, skipping
/// (never truncating) any sentence over `MAX_SENTENCE_CHARS`, each carrying
/// up to `CONTEXT_CHARS` of the chunk text on either side.
///
/// `sentence_split` is loss-free — its pieces concatenate back to the text it
/// was given, minus whitespace-only tails — so the neighbouring sentences can
/// be re-joined to recover the surrounding text without tracking offsets.
fn sentences_containing(chunk_text: &str, forms: &[String]) -> Vec<SentenceHit> {
    let lowered_forms: Vec<String> = forms.iter().map(|form| form.to_lowercase()).collect();
    let sentences = super::chunk::sentence_split(chunk_text);
    let mut hits = Vec::new();
    for (index, sentence) in sentences.iter().enumerate() {
        let text = sentence.trim();
        if text.is_empty() || text.chars().count() > MAX_SENTENCE_CHARS {
            continue;
        }
        let lowered = text.to_lowercase();
        if !lowered_forms
            .iter()
            .any(|form| contains_form(&lowered, form))
        {
            continue;
        }
        hits.push(SentenceHit {
            text: text.to_string(),
            prefix: context_before(&sentences[..index]),
            suffix: context_after(&sentences[index + 1..]),
        });
    }
    hits
}

/// The tail of everything preceding a sentence, capped at `CONTEXT_CHARS`.
fn context_before(preceding: &[String]) -> String {
    let joined = preceding.concat();
    let chars: Vec<char> = joined.chars().collect();
    let start = chars.len().saturating_sub(CONTEXT_CHARS);
    chars[start..].iter().collect::<String>().trim().to_string()
}

/// The head of everything following a sentence, capped at `CONTEXT_CHARS`.
fn context_after(following: &[String]) -> String {
    let joined = following.concat();
    joined
        .chars()
        .take(CONTEXT_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Pick the final candidate list from each book's already-ordered sentences.
/// Round one takes at most `FIRST_ROUND_PER_BOOK` per book, in book order,
/// for source diversity; if the total is still under `MAX_TOTAL_QUOTES`, a
/// second round relaxes the cap to `SECOND_ROUND_PER_BOOK` per book. Books
/// are assumed already sorted most-recently-read first, and each book's own
/// sentence list is assumed already in the priority order they should be
/// drawn in.
fn allocate_quota(per_book: &[Vec<QuoteCandidate>]) -> Vec<QuoteCandidate> {
    let mut selected = Vec::new();
    let mut taken = vec![0usize; per_book.len()];

    for (index, sentences) in per_book.iter().enumerate() {
        if selected.len() >= MAX_TOTAL_QUOTES {
            break;
        }
        if let Some(candidate) = sentences.first() {
            selected.push(candidate.clone());
            taken[index] = FIRST_ROUND_PER_BOOK;
        }
    }

    if selected.len() < MAX_TOTAL_QUOTES {
        for (index, sentences) in per_book.iter().enumerate() {
            if selected.len() >= MAX_TOTAL_QUOTES {
                break;
            }
            if taken[index] < SECOND_ROUND_PER_BOOK {
                if let Some(candidate) = sentences.get(taken[index]) {
                    selected.push(candidate.clone());
                    taken[index] += 1;
                }
            }
        }
    }

    selected
}

/// Find verbatim sentences containing `word` (or one of its known forms)
/// from portions of the library the reader has already read.
///
/// `current_position` is the reader's live position in `current_book_id`,
/// when the caller has one handy — not necessarily what `books.current_cfi`
/// has persisted yet, so a valid one is used directly for that one book's
/// cutoff rather than read back from the database. When it is absent,
/// blank, or fails to parse for the book's render format, `current_book_id`
/// falls back to its own persisted `current_cfi` — the same source every
/// other book uses. Every other book's boundary always comes from its own
/// last-saved `current_cfi`; a book with no position anywhere is excluded
/// entirely.
///
/// Deliberately calls `spoiler::cutoff_for_position` — the pure boundary
/// computation — rather than `spoiler::resolve_cutoff`, which additionally
/// folds in the `ai_spoiler_guard` on/off setting. That setting governs
/// what chat is willing to *say*; it has no bearing on what this module is
/// willing to *quote*. A reader who has turned spoiler guard off for chat
/// has not asked for search results that can spoil ahead of their own
/// reading position, so this module always enforces the boundary.
pub fn find_quotes(
    db: &Db,
    word: &str,
    current_book_id: &str,
    current_position: Option<&str>,
) -> AppResult<Vec<QuoteCandidate>> {
    {
        let mut conn = db
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        super::index::ensure_fts_current(&mut conn)?;
    }

    let forms = forms_for_word(db, word)?;
    if forms.is_empty() {
        return Ok(Vec::new());
    }

    // One connection acquisition, two reads, then released — nothing below
    // this block touches the database again.
    let (mut books, hits) = {
        let conn = db.reader();
        let mut books: Vec<BookScope> = candidate_books(&conn)?
            .into_iter()
            .filter(|book| book.book_id != current_book_id)
            .collect();
        if let Some(scope) = current_book_scope(&conn, current_book_id, current_position)? {
            books.push(scope);
        }
        let hits = matching_chunks_all_books(&conn, &forms)?;
        (books, hits)
    };

    // Most-recently-*written* first (see `BookScope::updated_at`), book_id
    // as a deterministic tiebreaker so equal timestamps don't reorder
    // between runs.
    books.sort_by_key(|book| (Reverse(book.updated_at), book.book_id.clone()));

    let mut grouped: HashMap<String, Vec<GlobalHit>> = HashMap::new();
    for hit in hits {
        grouped.entry(hit.book_id.clone()).or_default().push(hit);
    }

    let mut per_book_candidates: Vec<Vec<QuoteCandidate>> = Vec::with_capacity(books.len());
    for book in &books {
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        if let Some(book_hits) = grouped.get(&book.book_id) {
            // No `.take(MAX_CANDIDATE_CHUNKS_PER_BOOK)` needed here — the SQL
            // query already capped each book to that many rows via its own
            // `book_rank` partition, before cutoff filtering ever runs.
            for hit in book_hits
                .iter()
                .filter(|hit| book.cutoff.allows_complete_chunk(hit.section_index, hit.char_end))
            {
                for sentence in sentences_containing(&hit.text, &forms) {
                    if seen.insert(sentence.text.clone()) {
                        candidates.push(QuoteCandidate {
                            book_id: book.book_id.clone(),
                            book_title: book.title.clone(),
                            section_index: hit.section_index,
                            section_href: hit.section_href.clone(),
                            chunk_char_start: hit.chunk_char_start,
                            text: sentence.text,
                            prefix: sentence.prefix,
                            suffix: sentence.suffix,
                        });
                    }
                }
            }
        }
        per_book_candidates.push(candidates);
    }

    Ok(allocate_quota(&per_book_candidates))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(hits: &[SentenceHit]) -> Vec<&str> {
        hits.iter().map(|hit| hit.text.as_str()).collect()
    }

    fn quote(book: &str, text: &str) -> QuoteCandidate {
        QuoteCandidate {
            book_id: book.to_string(),
            book_title: book.to_string(),
            section_index: 0,
            section_href: None,
            chunk_char_start: None,
            text: text.to_string(),
            prefix: String::new(),
            suffix: String::new(),
        }
    }

    // -- word-form expansion --------------------------------------------

    #[test]
    fn expands_to_the_normalized_word_plus_its_stored_forms() {
        let forms = expand_forms(
            "run",
            Some(&["running".to_string(), "ran".to_string(), "runs".to_string()]),
        );
        assert_eq!(forms, vec!["run", "running", "ran", "runs"]);
    }

    #[test]
    fn a_missing_word_forms_row_degrades_to_the_exact_word() {
        assert_eq!(expand_forms("quarrying", None), vec!["quarrying"]);
    }

    #[test]
    fn blank_or_duplicate_stored_forms_are_dropped() {
        let forms = expand_forms(
            "run",
            Some(&["run".to_string(), "  ".to_string(), "running".to_string()]),
        );
        assert_eq!(forms, vec!["run", "running"]);
    }

    #[test]
    fn a_single_ascii_letter_is_dropped_from_the_match_expression_but_a_cjk_character_survives() {
        assert_eq!(build_match_expression(&["a".to_string()]), "");
        assert_eq!(build_match_expression(&["梦".to_string()]), "\"梦\"");
    }

    // -- range filtering (reusing the spoiler-guard boundary) ------------

    #[test]
    fn a_book_with_no_saved_position_has_no_reading_progress() {
        assert!(!book_has_progress(None));
        assert!(!book_has_progress(Some("")));
        assert!(!book_has_progress(Some("   ")));
        assert!(book_has_progress(Some("textloc:v2:120:125")));
    }

    #[test]
    fn the_cutoff_admits_chunks_before_the_position_and_excludes_chunks_after() {
        let cutoff = cutoff_for_position("text", Some("textloc:v2:100:105"));
        assert!(cutoff.allows_complete_chunk(0, Some(80)));
        assert!(!cutoff.allows_complete_chunk(0, Some(150)));
    }

    #[test]
    fn epub_and_pdf_cutoffs_use_section_granularity_not_character_offsets() {
        let cutoff = cutoff_for_position("epub", Some("epubcfi(/6/8!/4/2:9)"));
        assert_eq!(cutoff, SpoilerCutoff::Section(3));
        assert!(cutoff.allows_complete_chunk(3, None));
        assert!(!cutoff.allows_complete_chunk(4, None));
    }

    #[test]
    fn a_blank_or_unparseable_live_position_falls_back_to_the_books_saved_progress() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books (
                     id, title, author, file_path, source_format, render_format,
                     status, progress, current_cfi, created_at, updated_at
                 ) VALUES ('book-x', 'X', 'Author', 'books/x.txt', 'text', 'text',
                           'reading', 20, 'textloc:v2:200:205', 1, 1)",
                [],
            )
            .unwrap();
        }
        let conn = db.reader();

        for live in [None, Some(""), Some("   "), Some("not-a-position")] {
            let scope = current_book_scope(&conn, "book-x", live).unwrap().unwrap();
            assert!(
                scope.cutoff.allows_complete_chunk(0, Some(150)),
                "must fall back to the saved current_cfi (offset 200) for {live:?}, not truncate to position 0"
            );
        }

        let scope = current_book_scope(&conn, "book-x", Some("textloc:v2:10:15"))
            .unwrap()
            .unwrap();
        assert!(
            !scope.cutoff.allows_complete_chunk(0, Some(150)),
            "a valid live position must override the saved current_cfi"
        );
    }

    // -- per-book quota (pure allocator) -------------------------------

    #[test]
    fn first_round_takes_one_per_book_before_a_second_round_relaxes_to_two() {
        let per_book = vec![
            vec![quote("a", "a1"), quote("a", "a2")],
            vec![quote("b", "b1"), quote("b", "b2")],
        ];
        let selected = allocate_quota(&per_book);
        assert_eq!(
            selected.iter().map(|q| q.text.as_str()).collect::<Vec<_>>(),
            vec!["a1", "b1", "a2", "b2"]
        );
    }

    #[test]
    fn the_total_never_exceeds_five_even_with_many_books() {
        let per_book: Vec<Vec<QuoteCandidate>> = (0..10)
            .map(|index| vec![quote(&format!("book{index}"), "only")])
            .collect();
        assert_eq!(allocate_quota(&per_book).len(), 5);
    }

    #[test]
    fn a_single_book_never_contributes_more_than_two() {
        let per_book = vec![vec![
            quote("a", "1"),
            quote("a", "2"),
            quote("a", "3"),
            quote("a", "4"),
        ]];
        assert_eq!(allocate_quota(&per_book).len(), 2);
    }

    // -- word-boundary matching -----------------------------------------

    #[test]
    fn a_form_that_is_a_substring_of_an_unrelated_word_is_not_a_false_match() {
        let text = "The branch was heavy with rain. He ran across the field.";
        let forms = vec!["run".to_string(), "ran".to_string(), "running".to_string()];
        let sentences = sentences_containing(text, &forms);
        assert_eq!(
            texts(&sentences),
            vec!["He ran across the field."],
            "\"ran\" must not match inside \"branch\" or \"Grant\"-like words"
        );
        assert!(sentences.iter().all(|sentence| word_boundary_contains(
            &sentence.text.to_lowercase(),
            "ran"
        )));
    }

    #[test]
    fn cjk_forms_keep_substring_matching_since_there_is_no_word_boundary_to_check() {
        assert!(contains_form("他喜欢跑步和游泳", "跑步"));
    }

    #[test]
    fn non_ascii_alphabetic_forms_also_require_word_boundaries() {
        // "он" ("he"/"it") is a bare substring of "вагоне" ("carriage",
        // prepositional case) — the same class of false positive as "ran"
        // inside "branch", just outside ASCII, so `is_ascii_alphanumeric`
        // alone would miss it.
        let without_standalone_word = "пассажир сидел тихо в вагоне.".to_lowercase();
        let with_standalone_word = "он сидел тихо и смотрел в окно.".to_lowercase();
        assert!(!contains_form(&without_standalone_word, "он"));
        assert!(contains_form(&with_standalone_word, "он"));
    }

    // -- long-sentence skip -------------------------------------------------

    #[test]
    fn a_sentence_over_the_length_cap_is_skipped_entirely_not_truncated() {
        let mut long_sentence = String::from("This sentence hides the word run inside a very long stretch of padding words that keeps going ");
        long_sentence.push_str(&"padding ".repeat(40));
        long_sentence.push('.');
        assert!(long_sentence.chars().count() > MAX_SENTENCE_CHARS);

        let text = format!("{long_sentence} Now a short one with run too.");
        let sentences = sentences_containing(&text, &["run".to_string()]);

        assert_eq!(
            texts(&sentences),
            vec!["Now a short one with run too."],
            "the over-length sentence must be absent, not shortened"
        );
    }

    // -- anchoring context ---------------------------------------------------

    #[test]
    fn a_sentence_carries_the_chunk_text_on_either_side_of_it() {
        let text = "The harbour was quiet. He ran across the field. Gulls turned overhead.";
        let hits = sentences_containing(text, &["ran".to_string()]);

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].prefix, "The harbour was quiet.");
        assert_eq!(hits[0].suffix, "Gulls turned overhead.");
    }

    #[test]
    fn context_is_capped_and_taken_from_the_side_nearest_the_sentence() {
        let filler = "padding words that keep going and going and going and going. ";
        let text = format!("{filler}He ran across the field. {filler}");
        let hits = sentences_containing(&text, &["ran".to_string()]);

        assert_eq!(hits.len(), 1);
        assert!(hits[0].prefix.chars().count() <= CONTEXT_CHARS);
        assert!(hits[0].suffix.chars().count() <= CONTEXT_CHARS);
        // The tail of what precedes, and the head of what follows — not the
        // far ends, which would describe text nowhere near the sentence.
        assert!(filler.trim_end().ends_with(&hits[0].prefix));
        assert!(filler.trim_start().starts_with(&hits[0].suffix));
    }

    #[test]
    fn a_sentence_at_a_chunk_boundary_still_anchors_with_one_sided_context() {
        let text = "He ran across the field. Gulls turned overhead.";
        let hits = sentences_containing(text, &["ran".to_string()]);

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].prefix, "", "nothing precedes the first sentence");
        assert_eq!(hits[0].suffix, "Gulls turned overhead.");
    }

    // -- empty candidates -> empty result -----------------------------------

    #[test]
    fn no_candidate_books_returns_an_empty_list() {
        assert!(allocate_quota(&[]).is_empty());
    }

    #[test]
    fn candidate_books_with_no_matching_sentences_return_an_empty_list() {
        let per_book = vec![Vec::new(), Vec::new()];
        assert!(allocate_quota(&per_book).is_empty());
    }

    #[test]
    fn an_unknown_query_word_short_circuits_before_touching_the_database() {
        // A word that normalizes to empty (whitespace/punctuation only) can
        // never match anything; `find_quotes` must not need a live `Db` to
        // know that.
        assert!(expand_forms("", None).iter().all(|form| form.is_empty()));
    }

    // -- end-to-end wiring ----------------------------------------------

    #[test]
    fn finds_quotes_by_form_orders_books_by_recency_and_respects_each_cutoff() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();

            conn.execute(
                "INSERT INTO word_forms (normalized_word, forms, updated_at) VALUES ('run', '[\"running\",\"ran\"]', 1)",
                [],
            )
            .unwrap();

            let insert_book = "INSERT INTO books (
                 id, title, author, file_path, source_format, render_format,
                 status, progress, current_cfi, created_at, updated_at
             ) VALUES (?1, ?1, 'Author', 'books/x.txt', 'text', 'text',
                       'reading', 10, ?2, 1, ?3)";
            // book-current: no persisted position at all (as if the very
            // first save hasn't flushed yet) — must still be included, using
            // the live position passed into `find_quotes`.
            conn.execute(
                "INSERT INTO books (
                     id, title, author, file_path, source_format, render_format,
                     status, progress, created_at, updated_at
                 ) VALUES ('book-current', 'Current', 'Author', 'books/a.txt', 'text', 'text',
                           'reading', 5, 1, 4000)",
                [],
            )
            .unwrap();
            conn.execute(insert_book, params!["book-other", "textloc:v2:1000:1005", 2000_i64])
                .unwrap();
            conn.execute(insert_book, params!["book-unread", None::<String>, 3000_i64])
                .unwrap();

            let insert_chunk = "INSERT INTO book_chunks (
                 id, book_id, chunk_index, section_index, section_href, section_title,
                 char_start, char_end, text, snippet, token_estimate, created_at
             ) VALUES (?1, ?2, ?3, 0, ?4, 'Section', ?5, ?6, ?7, ?7, 10, 1)";
            // Within the current book's live cutoff (position 50).
            conn.execute(
                insert_chunk,
                params![
                    "chunk-current-in",
                    "book-current",
                    0_i64,
                    "a.xhtml",
                    0_i64,
                    30_i64,
                    "She began to run through the quiet garden."
                ],
            )
            .unwrap();
            // Past the current book's live cutoff — must be excluded.
            conn.execute(
                insert_chunk,
                params![
                    "chunk-current-out",
                    "book-current",
                    1_i64,
                    "a.xhtml",
                    60_i64,
                    90_i64,
                    "He kept running long after the storm passed."
                ],
            )
            .unwrap();
            // book-other: only says "running", found through form expansion.
            conn.execute(
                insert_chunk,
                params![
                    "chunk-other",
                    "book-other",
                    0_i64,
                    "b.xhtml",
                    0_i64,
                    40_i64,
                    "In the old days he used to enjoy running every morning."
                ],
            )
            .unwrap();
            // book-unread has progress-free scope and must never be searched,
            // but seed a chunk anyway to prove it is excluded, not just empty.
            conn.execute(
                insert_chunk,
                params![
                    "chunk-unread",
                    "book-unread",
                    0_i64,
                    "c.xhtml",
                    0_i64,
                    10_i64,
                    "A short run before breakfast."
                ],
            )
            .unwrap();
        }

        let results = find_quotes(&db, "run", "book-current", Some("textloc:v2:50:55")).unwrap();

        assert_eq!(results.len(), 2, "one sentence from each eligible book");
        assert_eq!(results[0].book_id, "book-current");
        assert!(results[0].text.contains("quiet garden"));
        assert_eq!(results[0].chunk_char_start, Some(0));
        assert_eq!(results[1].book_id, "book-other");
        assert!(results[1].text.contains("running"));
        assert_eq!(results[1].chunk_char_start, Some(0));
        assert!(
            results.iter().all(|candidate| candidate.book_id != "book-unread"),
            "a book with no saved reading progress must be excluded entirely"
        );
    }

    #[test]
    fn epub_books_use_section_granularity_cutoff_end_to_end_and_carry_no_char_start() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO word_forms (normalized_word, forms, updated_at) VALUES ('run', '[]', 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO books (
                     id, title, author, file_path, source_format, render_format,
                     status, progress, current_cfi, created_at, updated_at
                 ) VALUES ('book-epub', 'Epub', 'Author', 'books/e.epub', 'epub', 'epub',
                           'reading', 30, 'epubcfi(/6/8!/4/2:9)', 1, 1)",
                [],
            )
            .unwrap();
            let insert_chunk = "INSERT INTO book_chunks (
                 id, book_id, chunk_index, section_index, section_href, section_title,
                 char_start, char_end, text, snippet, token_estimate, created_at
             ) VALUES (?1, 'book-epub', ?2, ?3, ?4, 'Section', NULL, NULL, ?5, ?5, 10, 1)";
            // section_index 3 is within the epubcfi cutoff (Section(3)).
            conn.execute(
                insert_chunk,
                params![
                    "chunk-epub-in",
                    0_i64,
                    3_i64,
                    "s3.xhtml",
                    "She began to run swiftly across the yard."
                ],
            )
            .unwrap();
            // section_index 4 is past it — must be excluded.
            conn.execute(
                insert_chunk,
                params![
                    "chunk-epub-out",
                    1_i64,
                    4_i64,
                    "s4.xhtml",
                    "He was still running when they found him."
                ],
            )
            .unwrap();
        }

        let results = find_quotes(&db, "run", "book-epub", None).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].book_id, "book-epub");
        assert!(results[0].text.contains("run swiftly"));
        assert_eq!(
            results[0].chunk_char_start, None,
            "EPUB chunks carry no character offset; this must stay None, never fabricated"
        );
    }

    #[test]
    fn a_book_with_multiple_hits_contributes_a_second_quote_via_round_two() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO word_forms (normalized_word, forms, updated_at) VALUES ('run', '[]', 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO books (
                     id, title, author, file_path, source_format, render_format,
                     status, progress, current_cfi, created_at, updated_at
                 ) VALUES ('book-solo', 'Solo', 'Author', 'books/s.txt', 'text', 'text',
                           'reading', 50, 'textloc:v2:500:505', 1, 1)",
                [],
            )
            .unwrap();
            let insert_chunk = "INSERT INTO book_chunks (
                 id, book_id, chunk_index, section_index, section_href, section_title,
                 char_start, char_end, text, snippet, token_estimate, created_at
             ) VALUES (?1, 'book-solo', ?2, 0, 's.xhtml', 'Section', ?3, ?4, ?5, ?5, 10, 1)";
            conn.execute(
                insert_chunk,
                params!["chunk-solo-a", 0_i64, 0_i64, 30_i64, "She loves to run every single morning."],
            )
            .unwrap();
            conn.execute(
                insert_chunk,
                params!["chunk-solo-b", 1_i64, 40_i64, 80_i64, "He would run for miles without stopping."],
            )
            .unwrap();
        }

        let results = find_quotes(&db, "run", "book-solo", None).unwrap();

        assert_eq!(
            results.len(),
            2,
            "round two must relax the same book's quota to two, using real DB-fetched hits"
        );
        assert!(results.iter().all(|candidate| candidate.book_id == "book-solo"));
    }

    #[test]
    fn one_flooded_unread_book_cannot_crowd_a_read_books_hits_out_of_the_global_window() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        {
            let mut conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO word_forms (normalized_word, forms, updated_at) VALUES ('run', '[]', 1)",
                [],
            )
            .unwrap();
            // book-flood: unread (no current_cfi), so it never contributes to
            // the results — but its sheer volume of short, highly-ranked hits
            // must not be allowed to consume the single global query's window
            // before book-thin's own (few, longer, lower-ranked) hits get a
            // look-in.
            conn.execute(
                "INSERT INTO books (
                     id, title, author, file_path, source_format, render_format,
                     status, progress, current_cfi, created_at, updated_at
                 ) VALUES ('book-flood', 'Flood', 'Author', 'books/f.txt', 'text', 'text',
                           'unread', 0, NULL, 1, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO books (
                     id, title, author, file_path, source_format, render_format,
                     status, progress, current_cfi, created_at, updated_at
                 ) VALUES ('book-thin', 'Thin', 'Author', 'books/t.txt', 'text', 'text',
                           'reading', 90, 'textloc:v2:9999:9999', 1, 1)",
                [],
            )
            .unwrap();

            let tx = conn.transaction().unwrap();
            {
                // More hits than MAX_TOTAL_CANDIDATE_CHUNKS (500), each a
                // terse two-word chunk — short documents bm25-outrank the
                // long, diluted chunks below, so a query without a per-book
                // partition would let this single book fill the entire
                // global window on its own.
                let mut insert_flood_chunk = tx
                    .prepare(
                        "INSERT INTO book_chunks (
                             id, book_id, chunk_index, section_index, section_href, section_title,
                             char_start, char_end, text, snippet, token_estimate, created_at
                         ) VALUES (?1, 'book-flood', ?2, 0, 'f.xhtml', 'Section', ?2, ?2, ?3, ?3, 5, 1)",
                    )
                    .unwrap();
                for index in 0_i64..520_i64 {
                    let text = format!("Run {index}.");
                    insert_flood_chunk
                        .execute(params![format!("chunk-flood-{index}"), index, text])
                        .unwrap();
                }
            }
            let filler = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod \
                 tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis \
                 nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";
            tx.execute(
                "INSERT INTO book_chunks (
                     id, book_id, chunk_index, section_index, section_href, section_title,
                     char_start, char_end, text, snippet, token_estimate, created_at
                 ) VALUES ('chunk-thin-a', 'book-thin', 0, 0, 't.xhtml', 'Section', 0, 500,
                           ?1, ?1, 50, 1)",
                params![format!("{filler} She loves to run every single morning. {filler}")],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO book_chunks (
                     id, book_id, chunk_index, section_index, section_href, section_title,
                     char_start, char_end, text, snippet, token_estimate, created_at
                 ) VALUES ('chunk-thin-b', 'book-thin', 1, 0, 't.xhtml', 'Section', 500, 1000,
                           ?1, ?1, 50, 1)",
                params![format!("{filler} He would run for miles without stopping. {filler}")],
            )
            .unwrap();
            tx.commit().unwrap();
        }

        let results = find_quotes(&db, "run", "book-thin", None).unwrap();

        assert!(
            results.iter().any(|candidate| candidate.book_id == "book-thin"),
            "book-thin has real matching sentences and must not be crowded out of the global \
             candidate window by book-flood's 520 higher-ranked short hits from a single other book"
        );
    }
}
