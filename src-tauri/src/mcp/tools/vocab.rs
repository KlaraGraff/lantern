use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::tool;
use rmcp::tool_router;
use rmcp::ErrorData;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::vocab;
use crate::mcp::server::QuillMcpHandler;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetVocabWordsArgs {
    /// Optional book ID. Omit for vocabulary across the full library.
    #[serde(default)]
    pub book_id: Option<String>,
    /// When true, return only words currently due for review.
    #[serde(default)]
    pub due_only: Option<bool>,
}

#[tool_router(router = vocab_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(
        description = "List vocabulary words for one book or the full library, optionally limited to words due for review. Includes FSRS stability, difficulty, interval, and last-review fields."
    )]
    pub async fn get_vocab_words(
        &self,
        Parameters(GetVocabWordsArgs { book_id, due_only }): Parameters<GetVocabWordsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut words = match (book_id.as_deref(), due_only.unwrap_or(false)) {
            (Some(book_id), false) => vocab::query_vocab_words(&self.state.db, book_id),
            (None, false) => vocab::query_all_vocab_words(&self.state.db),
            (_, true) => vocab::query_vocab_due(&self.state.db),
        }
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        if due_only.unwrap_or(false) {
            if let Some(book_id) = book_id.as_deref() {
                words.retain(|word| word.book_id == book_id);
            }
        }
        Ok(CallToolResult::success(vec![Content::json(&words)?]))
    }

    #[tool(
        description = "Return aggregate vocabulary counts: total, new, learning, mastered, and due_for_review across all books."
    )]
    pub async fn get_vocab_stats(&self) -> Result<CallToolResult, ErrorData> {
        let stats = vocab::query_vocab_stats(&self.state.db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&stats)?]))
    }
}
