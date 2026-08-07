use std::collections::{BTreeMap, HashMap};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::chunk::estimate_tokens;
use super::segment::{segment_for_fts, SegmentMode};
use super::{CHUNK_TARGET_TOKENS, RETRIEVAL_TOP_K};
use crate::error::AppResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpoilerCutoff {
    Character(i64),
    Section(i64),
    /// Sections before `section` are fully visible; within `section`, only
    /// chunks with `chunk_index <= chunk_index` are visible. Used by ai_xray
    /// to admit the read-so-far prefix of the current EPUB section instead
    /// of excluding it wholesale — see `commands/ai/xray.rs`. Chat never
    /// constructs this variant.
    SectionPrefix { section: i64, chunk_index: i64 },
}

impl SpoilerCutoff {
    /// Section/character-granularity check. A `SectionPrefix` cutoff is
    /// treated conservatively here (as if it excluded the whole boundary
    /// section) because callers of this method — vector ranking and
    /// section-overview filtering — only have section-level data, not a
    /// chunk_index. Only `retrieve_ranked`'s own candidate building has a
    /// chunk_index to resolve a `SectionPrefix` boundary precisely; it uses
    /// `allows_complete_chunk_at` instead. This keeps `SectionPrefix`
    /// harmless everywhere it isn't specifically handled, since chat, the
    /// vector path, and section summaries never construct it.
    pub fn allows_complete_chunk(self, section_index: i64, char_end: Option<i64>) -> bool {
        self.allows_complete_chunk_at(section_index, i64::MAX, char_end)
    }

    /// Chunk-precise variant of `allows_complete_chunk`, used where a real
    /// `chunk_index` is available.
    fn allows_complete_chunk_at(self, section_index: i64, chunk_index: i64, char_end: Option<i64>) -> bool {
        match self {
            Self::Character(offset) => char_end.is_some_and(|end| end <= offset),
            Self::Section(section) => section_index <= section,
            Self::SectionPrefix {
                section,
                chunk_index: boundary,
            } => section_index < section || (section_index == section && chunk_index <= boundary),
        }
    }

    fn sql_parts(self) -> (i64, i64, i64) {
        match self {
            Self::Character(offset) => (1, offset, 0),
            Self::Section(section) => (2, section, 0),
            Self::SectionPrefix { section, chunk_index } => (3, section, chunk_index),
        }
    }
}

fn cutoff_sql_parts(cutoff: Option<SpoilerCutoff>) -> (i64, i64, i64) {
    cutoff.map(SpoilerCutoff::sql_parts).unwrap_or((0, 0, 0))
}

#[derive(Debug, Clone, PartialEq)]
pub struct RetrievedChunk {
    pub chunk_id: String,
    pub chunk_index: i64,
    pub section_index: i64,
    pub section_href: Option<String>,
    pub section_title: Option<String>,
    pub char_start: Option<i64>,
    pub char_end: Option<i64>,
    pub snippet: String,
    pub text: String,
    pub token_estimate: usize,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitedSource {
    pub marker: String,
    pub chunk_id: String,
    pub section_index: i64,
    pub section_href: Option<String>,
    pub section_title: Option<String>,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_snippet: Option<String>,
    pub char_start: Option<i64>,
    pub char_end: Option<i64>,
}

impl RetrievedChunk {
    pub fn cited_source(&self, marker: String) -> CitedSource {
        CitedSource {
            marker,
            chunk_id: self.chunk_id.clone(),
            section_index: self.section_index,
            section_href: self.section_href.clone(),
            section_title: self.section_title.clone(),
            snippet: self.snippet.clone(),
            fallback_snippet: None,
            char_start: self.char_start,
            char_end: self.char_end,
        }
    }
}

fn fts_query(query_text: &str) -> String {
    segment_for_fts(query_text, SegmentMode::Query)
        .split_whitespace()
        .filter(|token| token.len() >= 2)
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn row_to_chunk(row: &rusqlite::Row<'_>, score: f64) -> rusqlite::Result<RetrievedChunk> {
    Ok(RetrievedChunk {
        chunk_id: row.get(0)?,
        chunk_index: row.get(1)?,
        section_index: row.get(2)?,
        section_href: row.get(3)?,
        section_title: row.get(4)?,
        char_start: row.get(5)?,
        char_end: row.get(6)?,
        text: row.get(7)?,
        snippet: row.get(8)?,
        token_estimate: row.get::<_, i64>(9)? as usize,
        score,
    })
}

fn truncate_to_budget(value: &str, budget: usize) -> String {
    if estimate_tokens(value) <= budget {
        return value.to_string();
    }
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let next = index + character.len_utf8();
        if estimate_tokens(&value[..next]) > budget {
            break;
        }
        end = next;
    }
    value[..end].trim_end().to_string()
}

/// Query FTS5, add immediate reading-order neighbors, then merge and budget
/// excerpts. Lower SQLite BM25 scores are better.
pub(crate) fn lexical_ranks_with_limit(
    conn: &Connection,
    book_id: &str,
    query_text: &str,
    top_k: usize,
    cutoff: Option<SpoilerCutoff>,
) -> AppResult<Vec<(String, f64)>> {
    let query = fts_query(query_text);
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let (cutoff_kind, cutoff_value, cutoff_chunk_index) = cutoff_sql_parts(cutoff);
    let hits = conn
        .prepare(
            // Weights are positional over every column, UNINDEXED ones
            // included: text, context, chunk_id, book_id. The context line
            // scores at 0.3 because it is a description of the passage, not
            // the passage — it should break a tie between two chunks the
            // book's own words rank equally, and never outrank a chunk that
            // actually says the words. The two UNINDEXED columns take 0.0;
            // they hold identifiers, and a UUID that happens to tokenise
            // like a query term is noise.
            "SELECT book_chunks_fts.chunk_id, bm25(book_chunks_fts, 1.0, 0.3, 0.0, 0.0) AS score
             FROM book_chunks_fts
             JOIN book_chunks ON book_chunks.id = book_chunks_fts.chunk_id
               AND book_chunks.book_id = book_chunks_fts.book_id
             WHERE book_chunks_fts MATCH ?1 AND book_chunks_fts.book_id = ?2
               AND (?3 = 0
                 OR (?3 = 1 AND book_chunks.char_end <= ?4)
                 OR (?3 = 2 AND book_chunks.section_index <= ?4)
                 OR (?3 = 3 AND (book_chunks.section_index < ?4
                     OR (book_chunks.section_index = ?4 AND book_chunks.chunk_index <= ?6))))
             ORDER BY score LIMIT ?5",
        )?
        .query_map(
            params![
                query,
                book_id,
                cutoff_kind,
                cutoff_value,
                top_k as i64,
                cutoff_chunk_index
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    Ok(hits)
}

pub(crate) fn retrieve_ranked(
    conn: &Connection,
    book_id: &str,
    hits: &[(String, f64)],
    budget_tokens: usize,
    cutoff: Option<SpoilerCutoff>,
) -> AppResult<Vec<RetrievedChunk>> {
    if hits.is_empty() {
        return Ok(Vec::new());
    }

    let mut chunks_by_id = HashMap::new();
    {
        let mut statement = conn.prepare(
            "SELECT id, chunk_index, section_index, section_href, section_title, char_start, char_end, text, snippet, token_estimate
             FROM book_chunks WHERE id = ?1 AND book_id = ?2",
        )?;
        for (id, score) in hits {
            let chunk = statement
                .query_row(params![id, book_id], |row| row_to_chunk(row, *score))
                .optional()?;
            let Some(chunk) = chunk else {
                continue;
            };
            if cutoff.is_some_and(|value| {
                !value.allows_complete_chunk_at(chunk.section_index, chunk.chunk_index, chunk.char_end)
            }) {
                continue;
            }
            chunks_by_id.insert(id.clone(), chunk);
        }
    }

    let mut expanded_scores: BTreeMap<i64, f64> = BTreeMap::new();
    for (id, score) in hits {
        if let Some(hit) = chunks_by_id.get(id) {
            for index in (hit.chunk_index - 1)..=(hit.chunk_index + 1) {
                if index >= 0 {
                    expanded_scores
                        .entry(index)
                        .and_modify(|old| *old = old.min(*score))
                        .or_insert(*score);
                }
            }
        }
    }
    // Retain score lookup by id to avoid relying on the uniqueness of BM25 values.
    let hit_scores = hits.iter().cloned().collect::<HashMap<_, _>>();
    let mut candidates: BTreeMap<i64, RetrievedChunk> = BTreeMap::new();
    let mut statement = conn.prepare(
        "SELECT id, chunk_index, section_index, section_href, section_title, char_start, char_end, text, snippet, token_estimate
         FROM book_chunks WHERE book_id = ?1 AND chunk_index = ?2",
    )?;
    for (index, fallback_score) in expanded_scores {
        let maybe_chunk = statement
            .query_row(params![book_id, index], |row| {
                row_to_chunk(row, fallback_score)
            })
            .optional()?;
        let Some(mut chunk) = maybe_chunk else {
            continue;
        };
        if cutoff.is_some_and(|value| {
            !value.allows_complete_chunk_at(chunk.section_index, chunk.chunk_index, chunk.char_end)
        }) {
            continue;
        }
        if let Some(score) = hit_scores.get(&chunk.chunk_id) {
            chunk.score = *score;
        }
        candidates.insert(index, chunk);
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let mut merged = Vec::new();
    let mut current: Option<RetrievedChunk> = None;
    let mut current_last_index: Option<i64> = None;
    for chunk in candidates.into_values() {
        match current.as_mut() {
            Some(existing) if current_last_index == Some(chunk.chunk_index - 1) => {
                existing.text.push('\n');
                existing.text.push_str(&chunk.text);
                existing.token_estimate += chunk.token_estimate;
                existing.score = existing.score.min(chunk.score);
                existing.char_start = match (existing.char_start, chunk.char_start) {
                    (Some(left), Some(right)) => Some(left.min(right)),
                    (left, right) => left.or(right),
                };
                existing.char_end = match (existing.char_end, chunk.char_end) {
                    (Some(left), Some(right)) => Some(left.max(right)),
                    (left, right) => left.or(right),
                };
                current_last_index = Some(chunk.chunk_index);
            }
            Some(_) => {
                merged.push(current.take().expect("current exists"));
                current_last_index = Some(chunk.chunk_index);
                current = Some(chunk);
            }
            None => {
                current_last_index = Some(chunk.chunk_index);
                current = Some(chunk);
            }
        }
    }
    if let Some(chunk) = current {
        merged.push(chunk);
    }

    let best_chunk_id = merged
        .iter()
        .min_by(|left, right| left.score.total_cmp(&right.score))
        .map(|chunk| chunk.chunk_id.clone())
        .unwrap_or_default();
    let mut total = merged
        .iter()
        .map(|chunk| chunk.token_estimate)
        .sum::<usize>();
    while merged.len() > 1 && total > budget_tokens {
        let worst = merged
            .iter()
            .enumerate()
            .filter(|(_, chunk)| chunk.chunk_id != best_chunk_id)
            .max_by(|(_, left), (_, right)| left.score.total_cmp(&right.score))
            .map(|(index, _)| index)
            .unwrap_or_else(|| merged.len() - 1);
        total -= merged[worst].token_estimate;
        merged.remove(worst);
    }
    if merged.len() == 1 && merged[0].token_estimate > budget_tokens {
        merged[0].text = truncate_to_budget(&merged[0].text, budget_tokens);
        merged[0].token_estimate = estimate_tokens(&merged[0].text);
    }
    merged.sort_by_key(|chunk| chunk.chunk_index);
    Ok(merged)
}

/// SQL LIMIT safety net for `top_k_for_budget`. Real books have far fewer
/// FTS-matching chunks than this for any single query; it only guards
/// against a pathological budget value inflating the candidate query.
const MAX_RETRIEVAL_TOP_K: usize = 6_000;

/// Convert a token budget into an FTS candidate-hit limit. `retrieve()` used
/// to always ask SQL for `RETRIEVAL_TOP_K` (12) hits regardless of
/// `budget_tokens`, which made raising a caller's budget a no-op once the
/// caller already had 12 relevant hits available: `retrieve_ranked`'s
/// score-based trimming can only choose among what SQL handed it. Size the
/// candidate limit off the budget instead, with headroom (x3) for neighbor
/// expansion — each hit can pull in up to two adjacent chunks — so enough
/// raw candidates are fetched that the budget, not this limit, ends up being
/// the binding constraint. `RETRIEVAL_TOP_K` remains the floor so today's
/// small budgets keep today's behavior.
pub(crate) fn top_k_for_budget(budget_tokens: usize) -> usize {
    let by_budget = budget_tokens
        .div_ceil(CHUNK_TARGET_TOKENS.max(1))
        .saturating_mul(3);
    by_budget.clamp(RETRIEVAL_TOP_K, MAX_RETRIEVAL_TOP_K)
}

pub fn retrieve(
    conn: &Connection,
    book_id: &str,
    query_text: &str,
    budget_tokens: usize,
    cutoff: Option<SpoilerCutoff>,
) -> AppResult<Vec<RetrievedChunk>> {
    let hits =
        lexical_ranks_with_limit(conn, book_id, query_text, top_k_for_budget(budget_tokens), cutoff)?;
    retrieve_ranked(conn, book_id, &hits, budget_tokens, cutoff)
}

pub fn retrieve_with_limit(
    conn: &Connection,
    book_id: &str,
    query_text: &str,
    top_k: usize,
    budget_tokens: usize,
    cutoff: Option<SpoilerCutoff>,
) -> AppResult<Vec<RetrievedChunk>> {
    let hits = lexical_ranks_with_limit(conn, book_id, query_text, top_k, cutoff)?;
    retrieve_ranked(conn, book_id, &hits, budget_tokens, cutoff)
}

pub fn total_book_tokens(conn: &Connection, book_id: &str) -> AppResult<usize> {
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(token_estimate), 0) FROM book_chunks WHERE book_id = ?1",
        params![book_id],
        |row| row.get(0),
    )?;
    Ok(total.max(0) as usize)
}

pub fn retrieve_all(
    conn: &Connection,
    book_id: &str,
    cutoff: Option<SpoilerCutoff>,
) -> AppResult<Vec<RetrievedChunk>> {
    let mut statement = conn.prepare(
        "SELECT id, chunk_index, section_index, section_href, section_title, char_start, char_end,
                text, snippet, token_estimate
         FROM book_chunks WHERE book_id = ?1 ORDER BY chunk_index",
    )?;
    let chunks = statement
        .query_map(params![book_id], |row| row_to_chunk(row, 0.0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::error::AppError::from)?;
    Ok(chunks
        .into_iter()
        .filter(|chunk| {
            cutoff.is_none_or(|value| {
                value.allows_complete_chunk(chunk.section_index, chunk.char_end)
            })
        })
        .collect())
}

/// The result of loading one reading section under an input-token budget.
///
/// `total_*` counts every indexed chunk in the section, `visible_*` counts
/// chunks remaining after the spoiler cutoff, and `selected_*` describes the
/// chunks returned under the input-token budget. `truncated` is a budget
/// truncation flag; `spoiler_limited` is kept separate so a caller never
/// mistakes a protected prefix for a complete chapter.
#[derive(Debug, Clone, PartialEq)]
pub struct SectionRetrieval {
    pub chunks: Vec<RetrievedChunk>,
    pub total_chunks: usize,
    pub total_tokens: usize,
    pub visible_chunks: usize,
    pub visible_tokens: usize,
    pub selected_chunks: usize,
    pub selected_tokens: usize,
    pub truncated: bool,
    pub spoiler_limited: bool,
}

#[cfg(test)]
pub fn retrieve_section_with_budget(
    conn: &Connection,
    book_id: &str,
    section_index: i64,
    budget_tokens: usize,
    cutoff: Option<SpoilerCutoff>,
) -> AppResult<SectionRetrieval> {
    retrieve_section_range_with_budget(
        conn,
        book_id,
        section_index,
        Some(section_index),
        budget_tokens,
        cutoff,
    )
}

/// Load a logical reading unit spanning one or more raw spine/page sections.
/// The caller supplies the boundary resolved from the reader TOC; a missing
/// end means that the unit continues to the end of the indexed book. Callers
/// that only know one raw section should pass `Some(section_start)`.
pub fn retrieve_section_range_with_budget(
    conn: &Connection,
    book_id: &str,
    section_start: i64,
    section_end: Option<i64>,
    budget_tokens: usize,
    cutoff: Option<SpoilerCutoff>,
) -> AppResult<SectionRetrieval> {
    let section_end = match section_end {
        Some(value) if value >= section_start => Some(value),
        Some(_) => Some(section_start),
        None => None,
    };
    let mut statement = conn.prepare(
        "SELECT id, chunk_index, section_index, section_href, section_title, char_start, char_end,
                text, snippet, token_estimate
         FROM book_chunks
         WHERE book_id = ?1 AND section_index >= ?2
           AND (?3 IS NULL OR section_index <= ?3)
         ORDER BY chunk_index",
    )?;
    let all_chunks = statement
        .query_map(params![book_id, section_start, section_end], |row| {
            row_to_chunk(row, 0.0)
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let total_chunks = all_chunks.len();
    let total_tokens = all_chunks.iter().fold(0usize, |total, chunk| {
        total.saturating_add(chunk.token_estimate)
    });
    let chunks = all_chunks
        .into_iter()
        // Character cutoffs require a complete chunk. Passing a chunk that
        // crosses the cursor would expose unread text from its tail.
        .filter(|chunk| {
            cutoff.is_none_or(|value| {
                value.allows_complete_chunk(chunk.section_index, chunk.char_end)
            })
        })
        .collect::<Vec<_>>();

    let visible_chunks = chunks.len();
    let visible_tokens = chunks.iter().fold(0usize, |total, chunk| {
        total.saturating_add(chunk.token_estimate)
    });
    let mut selected = Vec::new();
    let mut total = 0usize;
    for mut chunk in chunks {
        if total.saturating_add(chunk.token_estimate) <= budget_tokens {
            total = total.saturating_add(chunk.token_estimate);
            selected.push(chunk);
            continue;
        }
        if selected.is_empty() && budget_tokens > 0 {
            chunk.text = truncate_to_budget(&chunk.text, budget_tokens);
            chunk.snippet = truncate_to_budget(&chunk.snippet, budget_tokens);
            chunk.token_estimate = estimate_tokens(&chunk.text);
            selected.push(chunk);
        }
        break;
    }
    let selected_chunks = selected.len();
    let selected_tokens = selected.iter().fold(0usize, |total, chunk| {
        total.saturating_add(chunk.token_estimate)
    });
    Ok(SectionRetrieval {
        chunks: selected,
        total_chunks,
        total_tokens,
        visible_chunks,
        visible_tokens,
        selected_chunks,
        selected_tokens,
        truncated: selected_chunks < visible_chunks || selected_tokens < visible_tokens,
        spoiler_limited: visible_chunks < total_chunks || visible_tokens < total_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::grounding::segment::{segment_for_fts, SegmentMode};

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE book_chunks (id TEXT PRIMARY KEY, book_id TEXT, chunk_index INTEGER, section_index INTEGER, section_href TEXT, section_title TEXT, char_start INTEGER, char_end INTEGER, text TEXT, snippet TEXT, token_estimate INTEGER); CREATE VIRTUAL TABLE book_chunks_fts USING fts5(seg_text, chunk_id UNINDEXED, book_id UNINDEXED);").unwrap();
        for (index, text) in [
            "Alpha setup.",
            "The rare signal appears here.",
            "Neighbor context.",
            "Unrelated material.",
            "宝玉 appears in a Chinese name.",
        ]
        .iter()
        .enumerate()
        {
            let id = format!("c{index}");
            conn.execute("INSERT INTO book_chunks VALUES (?1, 'book', ?2, 0, NULL, 'Chapter', ?2, ?2, ?3, ?3, 20)", params![id, index as i64, text]).unwrap();
            conn.execute(
                "INSERT INTO book_chunks_fts VALUES (?1, ?2, 'book')",
                params![segment_for_fts(text, SegmentMode::Index), id],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn retrieves_hit_with_neighbors_and_merges_by_reading_order() {
        let result = retrieve(&setup(), "book", "rare signal", 500, None).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].text.contains("Alpha setup."));
        assert!(result[0].text.contains("Neighbor context."));
    }

    #[test]
    fn supports_two_character_chinese_queries() {
        let result = retrieve(&setup(), "book", "宝玉", 500, None).unwrap();
        assert!(result.iter().any(|chunk| chunk.text.contains("宝玉")));
    }

    #[test]
    fn empty_and_non_matching_queries_are_empty() {
        let conn = setup();
        assert!(retrieve(&conn, "book", "", 100, None).unwrap().is_empty());
        assert!(retrieve(&conn, "book", "not-present", 100, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn returns_all_chunks_in_reading_order() {
        let result = retrieve_all(&setup(), "book", None).unwrap();
        assert_eq!(result.len(), 5);
        assert_eq!(result[0].chunk_id, "c0");
        assert_eq!(total_book_tokens(&setup(), "book").unwrap(), 100);
    }

    #[test]
    fn lexical_hits_and_neighbors_respect_character_cutoff() {
        let conn = setup();
        let result = retrieve(
            &conn,
            "book",
            "rare signal",
            500,
            Some(SpoilerCutoff::Character(1)),
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].text.contains("rare signal"));
        assert!(!result[0].text.contains("Neighbor context"));

        let blocked = retrieve(
            &conn,
            "book",
            "Neighbor context",
            500,
            Some(SpoilerCutoff::Character(1)),
        )
        .unwrap();
        assert!(blocked.is_empty());
    }

    #[test]
    fn full_text_retrieval_respects_character_cutoff() {
        let result = retrieve_all(&setup(), "book", Some(SpoilerCutoff::Character(2))).unwrap();
        assert_eq!(
            result
                .iter()
                .map(|chunk| chunk.chunk_id.as_str())
                .collect::<Vec<_>>(),
            vec!["c0", "c1", "c2"]
        );
    }

    #[test]
    fn character_cutoff_rejects_chunks_crossing_the_read_cursor() {
        let conn = setup();
        conn.execute(
            "UPDATE book_chunks SET char_start = CASE WHEN chunk_index = 1 THEN 0 ELSE char_start END,
             char_end = CASE WHEN chunk_index = 1 THEN 10 ELSE char_end END",
            [],
        )
        .unwrap();

        let all = retrieve_all(&conn, "book", Some(SpoilerCutoff::Character(5))).unwrap();
        assert!(!all.iter().any(|chunk| chunk.chunk_id == "c1"));
        let searched = retrieve(
            &conn,
            "book",
            "rare signal",
            500,
            Some(SpoilerCutoff::Character(5)),
        )
        .unwrap();
        assert!(searched.is_empty());
    }

    #[test]
    fn section_cutoff_filters_hits_neighbors_and_full_text() {
        let conn = setup();
        conn.execute("UPDATE book_chunks SET section_index = chunk_index", [])
            .unwrap();
        let result = retrieve(
            &conn,
            "book",
            "rare signal",
            500,
            Some(SpoilerCutoff::Section(1)),
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].text.contains("rare signal"));
        assert!(!result[0].text.contains("Neighbor context"));

        let all = retrieve_all(&conn, "book", Some(SpoilerCutoff::Section(1))).unwrap();
        assert_eq!(
            all.iter()
                .map(|chunk| chunk.chunk_id.as_str())
                .collect::<Vec<_>>(),
            vec!["c0", "c1"]
        );
    }

    #[test]
    fn retrieve_section_isolated_and_character_cutoff_safe() {
        let conn = setup();
        conn.execute(
            "UPDATE book_chunks SET section_index = CASE WHEN chunk_index < 2 THEN 0 ELSE 1 END,
             char_start = CASE WHEN chunk_index = 3 THEN 10 ELSE chunk_index END,
             char_end = CASE WHEN chunk_index = 3 THEN 30 ELSE chunk_index + 1 END",
            [],
        )
        .unwrap();

        let section = retrieve_section_with_budget(&conn, "book", 0, 500, None)
            .unwrap()
            .chunks;
        assert_eq!(
            section
                .iter()
                .map(|chunk| chunk.chunk_id.as_str())
                .collect::<Vec<_>>(),
            vec!["c0", "c1"]
        );

        let protected =
            retrieve_section_with_budget(&conn, "book", 1, 500, Some(SpoilerCutoff::Character(5)))
                .unwrap()
                .chunks;
        assert_eq!(
            protected
                .iter()
                .map(|chunk| chunk.chunk_id.as_str())
                .collect::<Vec<_>>(),
            vec!["c2", "c4"]
        );
    }

    #[test]
    fn retrieve_section_range_merges_adjacent_raw_sections_in_reading_order() {
        let conn = setup();
        conn.execute(
            "UPDATE book_chunks SET section_index = CASE WHEN chunk_index < 2 THEN 3 ELSE 4 END",
            [],
        )
        .unwrap();
        let result =
            retrieve_section_range_with_budget(&conn, "book", 3, Some(4), 500, None).unwrap();
        assert_eq!(
            result
                .chunks
                .iter()
                .map(|chunk| chunk.chunk_id.as_str())
                .collect::<Vec<_>>(),
            vec!["c0", "c1", "c2", "c3", "c4"]
        );
        let to_end = retrieve_section_range_with_budget(&conn, "book", 3, None, 500, None).unwrap();
        assert_eq!(to_end.chunks.len(), 5);
    }

    #[test]
    fn retrieve_section_preserves_order_and_truncates_an_oversized_first_chunk() {
        let conn = setup();
        conn.execute(
            "UPDATE book_chunks SET section_index = CASE WHEN chunk_index < 2 THEN 0 ELSE 1 END,
             token_estimate = CASE WHEN chunk_index = 0 THEN 20 ELSE 2 END",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE book_chunks SET text = ?1, snippet = ?1 WHERE chunk_index = 0",
            params!["one two three four five six seven eight nine ten"],
        )
        .unwrap();

        let result = retrieve_section_with_budget(&conn, "book", 0, 5, None)
            .unwrap()
            .chunks;
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].chunk_id, "c0");
        assert!(result[0].token_estimate <= 5);
        assert!(result[0].text.split_whitespace().count() < 10);
    }

    #[test]
    fn section_retrieval_reports_when_the_budget_drops_the_tail() {
        let conn = setup();
        conn.execute(
            "UPDATE book_chunks SET section_index = CASE WHEN chunk_index < 2 THEN 0 ELSE 1 END,
             token_estimate = CASE WHEN chunk_index < 2 THEN 20 ELSE 2 END",
            [],
        )
        .unwrap();

        let result = retrieve_section_with_budget(&conn, "book", 0, 25, None).unwrap();
        assert_eq!(result.total_chunks, 2);
        assert_eq!(result.total_tokens, 40);
        assert_eq!(result.visible_chunks, 2);
        assert_eq!(result.visible_tokens, 40);
        assert_eq!(result.selected_chunks, 1);
        assert_eq!(result.selected_tokens, 20);
        assert!(result.truncated);
        assert!(!result.spoiler_limited);
        assert_eq!(result.chunks[0].chunk_id, "c0");
    }

    #[test]
    fn section_retrieval_reports_cutoff_limited_visible_scope() {
        let conn = setup();
        let result =
            retrieve_section_with_budget(&conn, "book", 0, 100, Some(SpoilerCutoff::Character(0)))
                .unwrap();
        assert_eq!(result.total_chunks, 5);
        assert_eq!(result.total_tokens, 100);
        assert_eq!(result.visible_chunks, 1);
        assert_eq!(result.visible_tokens, 20);
        assert_eq!(result.selected_chunks, 1);
        assert_eq!(result.selected_tokens, 20);
        assert!(!result.truncated);
        assert!(result.spoiler_limited);
        assert_eq!(result.chunks[0].chunk_id, "c0");
    }

    #[test]
    fn section_retrieval_reports_empty_scope_without_false_flags() {
        let conn = setup();
        let result = retrieve_section_with_budget(&conn, "book", 99, 100, None).unwrap();
        assert_eq!(result.total_chunks, 0);
        assert_eq!(result.total_tokens, 0);
        assert_eq!(result.visible_chunks, 0);
        assert_eq!(result.visible_tokens, 0);
        assert_eq!(result.selected_chunks, 0);
        assert_eq!(result.selected_tokens, 0);
        assert!(!result.truncated);
        assert!(!result.spoiler_limited);
        assert!(result.chunks.is_empty());
    }

    #[test]
    fn top_k_for_budget_scales_up_with_a_floor_and_a_ceiling() {
        // Tiny budgets still get today's floor, so small-budget behavior is
        // unchanged.
        assert_eq!(top_k_for_budget(0), RETRIEVAL_TOP_K);
        assert_eq!(top_k_for_budget(350), RETRIEVAL_TOP_K);
        // A large budget asks SQL for proportionally more candidates.
        assert!(top_k_for_budget(96_000) > RETRIEVAL_TOP_K);
        assert_eq!(top_k_for_budget(96_000), 96_000_usize.div_ceil(350) * 3);
        // A pathological budget can't overflow or blow past the safety net.
        assert_eq!(top_k_for_budget(usize::MAX), MAX_RETRIEVAL_TOP_K);
    }

    #[test]
    fn large_budget_returns_far_more_than_the_old_fixed_top_k_when_more_hits_exist() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE book_chunks (id TEXT PRIMARY KEY, book_id TEXT, chunk_index INTEGER, section_index INTEGER, section_href TEXT, section_title TEXT, char_start INTEGER, char_end INTEGER, text TEXT, snippet TEXT, token_estimate INTEGER); CREATE VIRTUAL TABLE book_chunks_fts USING fts5(seg_text, chunk_id UNINDEXED, book_id UNINDEXED);").unwrap();
        // 20 distinct matching chunks, spaced far enough apart (step of 10)
        // that ±1 neighbor expansion never touches another real chunk, so
        // each hit surfaces as its own RetrievedChunk instead of merging.
        for i in 0..20 {
            let chunk_index = i * 10;
            let id = format!("c{i}");
            let text = format!("Gandalf appears in passage number {i}.");
            conn.execute(
                "INSERT INTO book_chunks VALUES (?1, 'book', ?2, 0, NULL, 'Chapter', ?2, ?2, ?3, ?3, 20)",
                params![id, chunk_index, text],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO book_chunks_fts VALUES (?1, ?2, 'book')",
                params![segment_for_fts(&text, SegmentMode::Index), id],
            )
            .unwrap();
        }

        // A small budget still only fits a handful of the 20 matches (5 * 20
        // tokens = 100), same as today.
        let small = retrieve(&conn, "book", "gandalf", 100, None).unwrap();
        assert!(small.len() <= 5);
        assert!(small.len() < 20);

        // A large budget (well over what the old fixed top_k of 12 would
        // have allowed through) must surface every matching chunk, proving
        // the budget — not a hidden fixed hit cap — is now the binding
        // constraint.
        let large = retrieve(&conn, "book", "gandalf", 5_000, None).unwrap();
        assert!(
            large.len() > RETRIEVAL_TOP_K,
            "expected more than the old fixed top_k of {RETRIEVAL_TOP_K}, got {}",
            large.len()
        );
        assert_eq!(large.len(), 20);
    }

    #[test]
    fn section_prefix_cutoff_admits_the_prefix_and_blocks_the_rest_end_to_end() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE book_chunks (id TEXT PRIMARY KEY, book_id TEXT, chunk_index INTEGER, section_index INTEGER, section_href TEXT, section_title TEXT, char_start INTEGER, char_end INTEGER, text TEXT, snippet TEXT, token_estimate INTEGER); CREATE VIRTUAL TABLE book_chunks_fts USING fts5(seg_text, chunk_id UNINDEXED, book_id UNINDEXED);").unwrap();
        let rows: [(i64, i64, &str); 9] = [
            (0, 0, "Alpha appears early."),
            (0, 1, "Beta continues early."),
            (1, 2, "Gamma section one."),
            (1, 3, "Delta section one."),
            (1, 4, "The rare signal here in section one."),
            (1, 5, "Epsilon after the signal."),
            (1, 6, "Zeta later still."),
            (2, 7, "Theta section two."),
            (2, 8, "Iota section two."),
        ];
        for (section_index, chunk_index, text) in rows {
            let id = format!("c{chunk_index}");
            conn.execute(
                "INSERT INTO book_chunks VALUES (?1, 'book', ?2, ?3, NULL, 'Chapter', ?2, ?2, ?4, ?4, 20)",
                params![id, chunk_index, section_index, text],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO book_chunks_fts VALUES (?1, ?2, 'book')",
                params![segment_for_fts(text, SegmentMode::Index), id],
            )
            .unwrap();
        }

        // Boundary: section 1, up through (global) chunk_index 4.
        let cutoff = Some(SpoilerCutoff::SectionPrefix {
            section: 1,
            chunk_index: 4,
        });

        // The hit chunk itself (chunk_index 4, at the boundary) is admitted
        // and merges with its allowed left neighbor (chunk_index 3), but its
        // right neighbor (chunk_index 5, past the boundary in the same
        // section) must not leak into the merged excerpt even though ±1
        // neighbor expansion touches it.
        let boundary = retrieve(&conn, "book", "rare signal", 500, cutoff).unwrap();
        assert_eq!(boundary.len(), 1);
        assert!(boundary[0].text.contains("The rare signal"));
        assert!(boundary[0].text.contains("Delta section one."));
        assert!(!boundary[0].text.contains("Epsilon after the signal"));

        // Sections before the boundary section are fully visible regardless
        // of their own chunk_index values.
        let earlier = retrieve(&conn, "book", "Alpha", 500, cutoff).unwrap();
        assert_eq!(earlier.len(), 1);
        assert!(earlier[0].text.contains("Alpha appears early."));

        // Sections after the boundary section are excluded entirely.
        let later = retrieve(&conn, "book", "Theta", 500, cutoff).unwrap();
        assert!(later.is_empty());
    }
}
