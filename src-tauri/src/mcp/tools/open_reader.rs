use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::books;
use crate::mcp::server::LanternMcpHandler;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenInReaderArgs {
    /// Book ID returned by `query_books`.
    pub book_id: String,
    /// Optional EPUB CFI or stored reader location.
    #[serde(default)]
    pub cfi: Option<String>,
}

#[tool_router(router = open_reader_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Request that Lantern open a book, optionally at a saved source location. The request is not delivery-confirmed.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn open_in_reader(
        &self,
        Parameters(OpenInReaderArgs { book_id, cfi }): Parameters<OpenInReaderArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let exists = books::query_book_exists(&self.state.db, &book_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        if !exists {
            return Err(ErrorData::invalid_params(
                format!("Book {book_id} was not found"),
                None,
            ));
        }
        let queued = self.state.request_reader_open(&book_id, cfi.as_deref());
        Ok(CallToolResult::success(vec![ContentBlock::json(
            serde_json::json!({
                "book_id": book_id,
                "cfi": cfi,
                "status": if queued { "requested" } else { "unavailable" },
                "delivery_confirmed": false,
            }),
        )?]))
    }
}
