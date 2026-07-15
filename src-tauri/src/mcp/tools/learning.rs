use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::{language_assessments, lookup_history, notes, word_marks};
use crate::mcp::server::QuillMcpHandler;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetNotesArgs {
    /// Optional book ID. Omit to query notes across the library.
    #[serde(default)]
    pub book_id: Option<String>,
    /// Optional normalized word anchor.
    #[serde(default)]
    pub word: Option<String>,
    /// Cursor returned by an earlier call.
    #[serde(default)]
    pub cursor: Option<String>,
    /// Page size. Defaults to 50, maximum 200.
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetLookupHistoryArgs {
    /// Optional book ID. Omit to query lookup history across the library.
    #[serde(default)]
    pub book_id: Option<String>,
    /// Cursor returned by an earlier call.
    #[serde(default)]
    pub cursor: Option<String>,
    /// Page size. Defaults to 100, maximum 200.
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetWordMarksArgs {
    /// Book ID returned by `list_books`.
    pub book_id: String,
}

#[derive(Debug, Serialize)]
struct McpLookupRecord {
    id: String,
    book_id: String,
    book_title: Option<String>,
    lookup_text: String,
    normalized_text: String,
    context_sentence: Option<String>,
    chapter: Option<String>,
    cfi: Option<String>,
    definition: String,
    context_explanation: Option<String>,
    lookup_count: i64,
    model: Option<String>,
    created_at: i64,
    last_looked_up_at: i64,
    updated_at: i64,
}

impl From<lookup_history::LookupRecord> for McpLookupRecord {
    fn from(record: lookup_history::LookupRecord) -> Self {
        Self {
            id: record.id,
            book_id: record.book_id,
            book_title: record.book_title,
            lookup_text: record.lookup_text,
            normalized_text: record.normalized_text,
            context_sentence: record.context_sentence,
            chapter: record.chapter,
            cfi: record.cfi,
            definition: record.definition,
            context_explanation: record.context_explanation,
            lookup_count: record.lookup_count,
            model: record.model,
            created_at: record.created_at,
            last_looked_up_at: record.last_looked_up_at,
            updated_at: record.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
struct McpLookupPage {
    records: Vec<McpLookupRecord>,
    next_cursor: Option<String>,
    total: usize,
}

#[derive(Debug, Serialize)]
struct McpWordMarkRule {
    id: String,
    book_id: String,
    normalized_word: String,
    display_word: String,
    match_mode: String,
    color: String,
    enabled: bool,
    created_at: i64,
    updated_at: i64,
}

impl From<word_marks::WordMarkRule> for McpWordMarkRule {
    fn from(rule: word_marks::WordMarkRule) -> Self {
        Self {
            id: rule.id,
            book_id: rule.book_id,
            normalized_word: rule.normalized_word,
            display_word: rule.display_word,
            match_mode: rule.match_mode,
            color: rule.color,
            enabled: rule.enabled,
            created_at: rule.created_at,
            updated_at: rule.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
struct McpWordMarkException {
    id: String,
    rule_id: String,
    book_id: String,
    normalized_word: String,
    location: String,
    excluded: bool,
    created_at: i64,
    updated_at: i64,
}

impl From<word_marks::WordMarkException> for McpWordMarkException {
    fn from(exception: word_marks::WordMarkException) -> Self {
        Self {
            id: exception.id,
            rule_id: exception.rule_id,
            book_id: exception.book_id,
            normalized_word: exception.normalized_word,
            location: exception.location,
            excluded: exception.excluded,
            created_at: exception.created_at,
            updated_at: exception.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
struct McpWordMarksResponse {
    rules: Vec<McpWordMarkRule>,
    exceptions: Vec<McpWordMarkException>,
}

#[derive(Debug, Serialize)]
struct LanguageProfileResponse {
    summary: Option<language_assessments::LanguageAssessmentSummary>,
    assessments: Vec<language_assessments::LanguageAssessment>,
}

#[tool_router(router = learning_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(
        description = "List first-class notes across the library or for a book/word, including word, selection, and book anchors. Legacy highlight notes were migrated as selection notes and may overlap with `get_highlights`."
    )]
    pub async fn get_notes(
        &self,
        Parameters(GetNotesArgs {
            book_id,
            word,
            cursor,
            limit,
        }): Parameters<GetNotesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let page = notes::query_notes(
            &self.state.db,
            book_id.as_deref(),
            None,
            word.as_deref(),
            None,
            None,
            None,
            cursor.as_deref(),
            limit.unwrap_or(50).clamp(1, 200),
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&page)?]))
    }

    #[tool(
        description = "List paginated dictionary lookup history across the library or for one book. Omits raw AI result JSON and provider profile identifiers."
    )]
    pub async fn get_lookup_history(
        &self,
        Parameters(GetLookupHistoryArgs {
            book_id,
            cursor,
            limit,
        }): Parameters<GetLookupHistoryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let page = lookup_history::query_all_lookup_records(
            None,
            book_id,
            cursor,
            Some(limit.unwrap_or(100).clamp(1, 200)),
            &self.state.db,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let response = McpLookupPage {
            records: page
                .records
                .into_iter()
                .map(McpLookupRecord::from)
                .collect(),
            next_cursor: page.next_cursor,
            total: page.total,
        };
        Ok(CallToolResult::success(vec![Content::json(&response)?]))
    }

    #[tool(
        description = "List enabled whole-book word-mark rules and active per-occurrence exclusions for one book."
    )]
    pub async fn get_word_marks(
        &self,
        Parameters(GetWordMarksArgs { book_id }): Parameters<GetWordMarksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let rules = word_marks::query_word_marks(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
            .into_iter()
            .map(McpWordMarkRule::from)
            .collect();
        let exceptions = word_marks::query_word_mark_exceptions(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
            .into_iter()
            .map(McpWordMarkException::from)
            .collect();
        let response = McpWordMarksResponse { rules, exceptions };
        Ok(CallToolResult::success(vec![Content::json(&response)?]))
    }

    #[tool(
        description = "Read the user's personal CEFR language profile for reading assistance. Returns the aggregate estimate and the underlying assessment records; it does not create, edit, delete, or estimate assessments."
    )]
    pub async fn get_language_profile(&self) -> Result<CallToolResult, ErrorData> {
        let assessments = language_assessments::load_language_assessments(&self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let response = LanguageProfileResponse {
            summary: language_assessments::summarize_assessments(&assessments),
            assessments,
        };
        Ok(CallToolResult::success(vec![Content::json(&response)?]))
    }
}
