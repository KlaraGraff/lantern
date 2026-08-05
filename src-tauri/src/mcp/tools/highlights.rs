use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::tool;
use rmcp::tool_router;
use rmcp::ErrorData;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::bookmarks;
use crate::mcp::server::LanternMcpHandler;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetHighlightsArgs {
    /// Book ID to fetch highlights for.
    pub book_id: String,
}

#[tool_router(router = highlights_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "List all highlights for a book, including the quoted text and color. A highlight carries no text of its own — notes written about a passage come from `get_notes`, anchored at the same range."
    )]
    pub async fn get_highlights(
        &self,
        Parameters(GetHighlightsArgs { book_id }): Parameters<GetHighlightsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let highlights = bookmarks::query_highlights(&self.state.db, &book_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &highlights,
        )?]))
    }
}
