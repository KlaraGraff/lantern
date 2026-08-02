use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ai::grounding;
use crate::commands::books;
use crate::mcp::server::LanternMcpHandler;
use crate::mcp::tools::library::require_sync;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SearchBookContentArgs {
    /// Book ID returned by `list_books`.
    pub book_id: String,
    /// Full-text search query.
    pub query: String,
    /// Maximum number of lexical hits before neighboring chunks are merged. Defaults to 12, maximum 20.
    #[serde(default)]
    pub top_k: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BookIdArgs {
    /// Book ID returned by `list_books`.
    pub book_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetBookSummariesArgs {
    /// Book ID returned by `list_books`.
    pub book_id: String,
    /// Optional scope: `book` or `sections`. Omit to return every safe summary.
    #[serde(default)]
    pub scope: Option<String>,
    /// Optional section index when requesting section summaries.
    #[serde(default)]
    pub section_index: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetBookContentArgs {
    /// Book ID returned by `list_books`.
    pub book_id: String,
    /// First indexed section to read (zero-based).
    pub section_start: i64,
    /// Last indexed section to read, inclusive. Omit to read only `section_start`.
    #[serde(default)]
    pub section_end: Option<i64>,
    /// Maximum approximate tokens returned. Defaults to 8000; maximum 50000.
    #[serde(default)]
    pub max_tokens: Option<usize>,
}

#[derive(Debug, Serialize)]
struct McpChunk {
    chunk_id: String,
    chunk_index: i64,
    section_index: i64,
    section_title: Option<String>,
    section_href: Option<String>,
    char_start: Option<i64>,
    char_end: Option<i64>,
    snippet: String,
    text: String,
    token_estimate: usize,
    score: f64,
}

impl From<grounding::RetrievedChunk> for McpChunk {
    fn from(chunk: grounding::RetrievedChunk) -> Self {
        Self {
            chunk_id: chunk.chunk_id,
            chunk_index: chunk.chunk_index,
            section_index: chunk.section_index,
            section_title: chunk.section_title,
            section_href: chunk.section_href,
            char_start: chunk.char_start,
            char_end: chunk.char_end,
            snippet: chunk.snippet,
            text: chunk.text,
            token_estimate: chunk.token_estimate,
            score: chunk.score,
        }
    }
}

#[derive(Debug, Serialize)]
struct McpBookSection {
    section_index: i64,
    section_title: Option<String>,
    section_href: Option<String>,
    char_start: Option<i64>,
    char_end: Option<i64>,
    chunk_count: i64,
    token_estimate: i64,
}

#[derive(Debug, Serialize)]
struct ListBookSectionsResponse {
    book_id: String,
    index_status: grounding::IndexStatus,
    spoiler_guard_active: bool,
    sections: Vec<McpBookSection>,
}

#[derive(Debug, Serialize)]
struct GetBookContentResponse {
    book_id: String,
    index_status: grounding::IndexStatus,
    section_start: i64,
    section_end: i64,
    spoiler_guard_active: bool,
    spoiler_limited: bool,
    truncated: bool,
    total_chunks: usize,
    visible_chunks: usize,
    selected_chunks: usize,
    selected_tokens: usize,
    chunks: Vec<McpChunk>,
}

#[derive(Debug, Serialize)]
struct SearchBookContentResponse {
    book_id: String,
    index_status: grounding::IndexStatus,
    spoiler_guard_active: bool,
    results: Vec<McpChunk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct McpSectionSummary {
    section_index: i64,
    section_title: Option<String>,
    content: String,
}

impl From<grounding::summarize::SectionOverview> for McpSectionSummary {
    fn from(section: grounding::summarize::SectionOverview) -> Self {
        Self {
            section_index: section.section_index,
            section_title: section.section_title,
            content: section.content,
        }
    }
}

#[derive(Debug, Serialize)]
struct GetBookSummariesResponse {
    book_id: String,
    ai_state: grounding::summarize::BookAiState,
    spoiler_guard_active: bool,
    overview: Option<String>,
    sections: Vec<McpSectionSummary>,
}

fn require_book(handler: &LanternMcpHandler, book_id: &str) -> Result<(), ErrorData> {
    let exists = books::query_book_exists(&handler.state.db, book_id)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    if !exists {
        return Err(ErrorData::invalid_params(
            format!("Book {book_id} was not found"),
            None,
        ));
    }
    Ok(())
}

fn list_visible_sections(
    handler: &LanternMcpHandler,
    book_id: &str,
    cutoff: Option<grounding::retrieve::SpoilerCutoff>,
) -> Result<Vec<McpBookSection>, ErrorData> {
    use grounding::retrieve::SpoilerCutoff;

    let conn = handler.state.db.reader();
    let rows = match cutoff {
        None => {
            let mut statement = conn
                .prepare(
                    "SELECT section_index, MAX(section_title), MAX(section_href),
                            MIN(char_start), MAX(char_end), COUNT(*), SUM(token_estimate)
                     FROM book_chunks WHERE book_id = ?1 GROUP BY section_index
                     ORDER BY section_index",
                )
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            statement
                .query_map(rusqlite::params![book_id], section_from_row)
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        }
        Some(SpoilerCutoff::Section(section)) => {
            let mut statement = conn
                .prepare(
                    "SELECT section_index, MAX(section_title), MAX(section_href),
                            MIN(char_start), MAX(char_end), COUNT(*), SUM(token_estimate)
                     FROM book_chunks WHERE book_id = ?1 AND section_index <= ?2
                     GROUP BY section_index ORDER BY section_index",
                )
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            statement
                .query_map(rusqlite::params![book_id, section], section_from_row)
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        }
        Some(SpoilerCutoff::Character(offset)) => {
            let mut statement = conn
                .prepare(
                    "SELECT section_index, MAX(section_title), MAX(section_href),
                            MIN(char_start), MAX(char_end), COUNT(*), SUM(token_estimate)
                     FROM book_chunks WHERE book_id = ?1 AND char_end <= ?2
                     GROUP BY section_index ORDER BY section_index",
                )
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            statement
                .query_map(rusqlite::params![book_id, offset], section_from_row)
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        }
    }
    .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    Ok(rows)
}

fn section_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<McpBookSection> {
    Ok(McpBookSection {
        section_index: row.get(0)?,
        section_title: row.get(1)?,
        section_href: row.get(2)?,
        char_start: row.get(3)?,
        char_end: row.get(4)?,
        chunk_count: row.get(5)?,
        token_estimate: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
    })
}

#[tool_router(router = content_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "List readable indexed sections and their source locations without returning full text. Respects Lantern's spoiler guard and never invokes AI or embedding services.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn list_book_sections(
        &self,
        Parameters(BookIdArgs { book_id }): Parameters<BookIdArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        require_book(self, &book_id)?;
        let details = grounding::index::index_details(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let resolution = grounding::spoiler::resolve_cutoff(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let sections = if details.status == grounding::IndexStatus::Ready {
            list_visible_sections(self, &book_id, resolution.cutoff)?
        } else {
            Vec::new()
        };
        let response = ListBookSectionsResponse {
            book_id,
            index_status: details.status,
            spoiler_guard_active: resolution.active,
            sections,
        };
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &response,
        )?]))
    }

    #[tool(
        description = "Read local indexed text for one section or an inclusive section range, with source hrefs and character offsets. Respects Lantern's spoiler guard, returns truncation metadata, and never invokes AI or embedding services.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn get_book_content(
        &self,
        Parameters(GetBookContentArgs {
            book_id,
            section_start,
            section_end,
            max_tokens,
        }): Parameters<GetBookContentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        require_book(self, &book_id)?;
        let section_end = section_end.unwrap_or(section_start);
        if section_start < 0 || section_end < section_start {
            return Err(ErrorData::invalid_params(
                "Section indexes must be non-negative and `section_end` must not precede `section_start`",
                None,
            ));
        }
        let max_tokens = max_tokens.unwrap_or(8_000);
        if !(1..=50_000).contains(&max_tokens) {
            return Err(ErrorData::invalid_params(
                "`max_tokens` must be between 1 and 50000",
                None,
            ));
        }
        let details = grounding::index::index_details(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        if details.status != grounding::IndexStatus::Ready {
            let response = GetBookContentResponse {
                book_id,
                index_status: details.status,
                section_start,
                section_end,
                spoiler_guard_active: false,
                spoiler_limited: false,
                truncated: false,
                total_chunks: 0,
                visible_chunks: 0,
                selected_chunks: 0,
                selected_tokens: 0,
                chunks: Vec::new(),
            };
            return Ok(CallToolResult::success(vec![ContentBlock::json(
                &response,
            )?]));
        }
        let resolution = grounding::spoiler::resolve_cutoff(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let retrieval = {
            let conn = self.state.db.reader();
            grounding::retrieve::retrieve_section_range_with_budget(
                &conn,
                &book_id,
                section_start,
                Some(section_end),
                max_tokens,
                resolution.cutoff,
            )
        }
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let response = GetBookContentResponse {
            book_id,
            index_status: details.status,
            section_start,
            section_end,
            spoiler_guard_active: resolution.active,
            spoiler_limited: retrieval.spoiler_limited,
            truncated: retrieval.truncated,
            total_chunks: retrieval.total_chunks,
            visible_chunks: retrieval.visible_chunks,
            selected_chunks: retrieval.selected_chunks,
            selected_tokens: retrieval.selected_tokens,
            chunks: retrieval.chunks.into_iter().map(McpChunk::from).collect(),
        };
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &response,
        )?]))
    }

    #[tool(
        description = "Search a book's local full-text FTS index and return citation-ready chunks. Respects Lantern's global and per-book spoiler guard and never uses embeddings or AI calls. If the index is not ready, returns its status and no results.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn search_book_content(
        &self,
        Parameters(SearchBookContentArgs {
            book_id,
            query,
            top_k,
        }): Parameters<SearchBookContentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        require_book(self, &book_id)?;
        if query.trim().is_empty() {
            return Err(ErrorData::invalid_params(
                "`query` must not be empty".to_string(),
                None,
            ));
        }
        let details = grounding::index::index_details(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let resolution = grounding::spoiler::resolve_cutoff(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let mut response = SearchBookContentResponse {
            book_id: book_id.clone(),
            index_status: details.status,
            spoiler_guard_active: resolution.active,
            results: Vec::new(),
            message: None,
        };
        if details.status != grounding::IndexStatus::Ready {
            response.message = Some(format!(
                "Book index is {}; call `request_book_index` to build it when appropriate.",
                details.status.as_db()
            ));
            return Ok(CallToolResult::success(vec![ContentBlock::json(
                &response,
            )?]));
        }

        let top_k = top_k.unwrap_or(grounding::RETRIEVAL_TOP_K).clamp(1, 20);
        let conn = self.state.db.reader();
        response.results = grounding::retrieve::retrieve_with_limit(
            &conn,
            &book_id,
            query.trim(),
            top_k,
            grounding::RETRIEVAL_BUDGET_TOKENS,
            resolution.cutoff,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
        .into_iter()
        .map(McpChunk::from)
        .collect();
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &response,
        )?]))
    }

    #[tool(
        description = "Read existing generated book or section summaries without generating new ones. Respects Lantern's spoiler guard by withholding the whole-book overview and filtering unread sections.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn get_book_summaries(
        &self,
        Parameters(GetBookSummariesArgs {
            book_id,
            scope,
            section_index,
        }): Parameters<GetBookSummariesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        require_book(self, &book_id)?;
        let scope = scope.as_deref().unwrap_or("all");
        if !matches!(scope, "all" | "book" | "sections") {
            return Err(ErrorData::invalid_params(
                "`scope` must be `book` or `sections`".to_string(),
                None,
            ));
        }
        if scope == "book" && section_index.is_some() {
            return Err(ErrorData::invalid_params(
                "`section_index` is only valid for section summaries".to_string(),
                None,
            ));
        }

        let ai_state = grounding::summarize::get_book_ai_state(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let resolution = grounding::spoiler::resolve_cutoff(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let safe_overview = if resolution.active {
            match resolution.cutoff {
                Some(cutoff) => {
                    grounding::summarize::load_section_overview(&self.state.db, &book_id, cutoff)
                }
                None => Ok(None),
            }
        } else {
            grounding::summarize::load_book_overview(&self.state.db, &book_id)
        }
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;

        let overview = safe_overview
            .as_ref()
            .filter(|overview| scope != "sections" && !overview.content.is_empty())
            .map(|overview| overview.content.clone());
        let sections = safe_overview
            .map(|overview| overview.sections)
            .unwrap_or_default()
            .into_iter()
            .filter(|_| scope != "book")
            .filter(|section| section_index.is_none_or(|index| section.section_index == index))
            .map(McpSectionSummary::from)
            .collect();
        let response = GetBookSummariesResponse {
            book_id,
            ai_state,
            spoiler_guard_active: resolution.active,
            overview,
            sections,
        };
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &response,
        )?]))
    }

    #[tool(
        description = "Build a book's local full-text index. Requires MCP write access and may take a while for large books. Uses local CPU extraction only; it never calls AI or embedding services.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn request_book_index(
        &self,
        Parameters(BookIdArgs { book_id }): Parameters<BookIdArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        require_book(self, &book_id)?;
        let _sync = require_sync(self)?;
        grounding::index::ensure_index(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let details = grounding::index::index_details(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(&details)?]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::mcp::McpState;

    #[test]
    fn visible_section_listing_obeys_character_cutoff() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress, created_at, updated_at)
                 VALUES ('book', 'Book', 'Author', 'books/book.txt', 'txt', 'reading', 10, 1, 1)",
                [],
            )
            .unwrap();
            for (id, chunk_index, char_start, char_end) in
                [("c1", 0_i64, 0_i64, 5_i64), ("c2", 1, 5, 10)]
            {
                conn.execute(
                    "INSERT INTO book_chunks
                     (id, book_id, chunk_index, section_index, section_title, section_href,
                      char_start, char_end, text, snippet, token_estimate, created_at)
                     VALUES (?1, 'book', ?2, 0, 'Chapter', 'chapter.html', ?3, ?4,
                             'text', 'text', 1, 1)",
                    rusqlite::params![id, chunk_index, char_start, char_end],
                )
                .unwrap();
            }
        }
        let handler = LanternMcpHandler::new(McpState::new(db, None, None));
        let sections = list_visible_sections(
            &handler,
            "book",
            Some(grounding::retrieve::SpoilerCutoff::Character(5)),
        )
        .unwrap();
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].chunk_count, 1);
        assert_eq!(sections[0].char_end, Some(5));
    }
}
