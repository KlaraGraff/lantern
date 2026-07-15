use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ai::grounding;
use crate::commands::books;
use crate::mcp::server::QuillMcpHandler;
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

#[derive(Debug, Serialize)]
struct McpChunk {
    chunk_id: String,
    section_index: i64,
    section_title: Option<String>,
    section_href: Option<String>,
    char_start: Option<i64>,
    char_end: Option<i64>,
    snippet: String,
    text: String,
    score: f64,
}

impl From<grounding::RetrievedChunk> for McpChunk {
    fn from(chunk: grounding::RetrievedChunk) -> Self {
        Self {
            chunk_id: chunk.chunk_id,
            section_index: chunk.section_index,
            section_title: chunk.section_title,
            section_href: chunk.section_href,
            char_start: chunk.char_start,
            char_end: chunk.char_end,
            snippet: chunk.snippet,
            text: chunk.text,
            score: chunk.score,
        }
    }
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

fn require_book(handler: &QuillMcpHandler, book_id: &str) -> Result<(), ErrorData> {
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

#[tool_router(router = content_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(
        description = "Search a book's local full-text FTS index and return citation-ready chunks. Respects Lantern's global and per-book spoiler guard and never uses embeddings or AI calls. If the index is not ready, returns its status and no results."
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
            return Ok(CallToolResult::success(vec![Content::json(&response)?]));
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
        Ok(CallToolResult::success(vec![Content::json(&response)?]))
    }

    #[tool(
        description = "Read existing generated book or section summaries without generating new ones. Respects Lantern's spoiler guard by withholding the whole-book overview and filtering unread sections."
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
        Ok(CallToolResult::success(vec![Content::json(&response)?]))
    }

    #[tool(
        description = "Return the local full-text index status and details for one book. This read does not build or modify the index."
    )]
    pub async fn get_book_index_status(
        &self,
        Parameters(BookIdArgs { book_id }): Parameters<BookIdArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        require_book(self, &book_id)?;
        let details = grounding::index::index_details(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&details)?]))
    }

    #[tool(
        description = "Build a book's local full-text index. Requires MCP write access and may take a while for large books. Uses local CPU extraction only; it never calls AI or embedding services."
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
        Ok(CallToolResult::success(vec![Content::json(&details)?]))
    }
}
