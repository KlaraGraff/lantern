use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::tool;
use rmcp::tool_router;
use rmcp::ErrorData;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::collections;
use crate::mcp::server::LanternMcpHandler;
use crate::mcp::tools::library::require_sync;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateCollectionArgs {
    /// Name for the new collection.
    pub name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RenameCollectionArgs {
    /// Collection ID (UUID).
    pub id: String,
    /// New name.
    pub name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteCollectionArgs {
    /// Collection ID (UUID). Books in the collection are NOT deleted.
    pub id: String,
}

#[tool_router(router = collections_write_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Create a new collection.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn create_collection(
        &self,
        Parameters(CreateCollectionArgs { name }): Parameters<CreateCollectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let collection = collections::do_create_collection(&name, &self.state.db, sync)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("collections", "created", &collection.id);
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &collection,
        )?]))
    }

    #[tool(
        description = "Rename an existing collection.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn rename_collection(
        &self,
        Parameters(RenameCollectionArgs { id, name }): Parameters<RenameCollectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        collections::do_rename_collection(&id, &name, &self.state.db, sync)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("collections", "updated", &id);
        Ok(CallToolResult::success(vec![ContentBlock::text(format!(
            "Collection {id} renamed to \"{name}\"."
        ))]))
    }

    #[tool(
        description = "Delete a collection. Books in the collection are NOT deleted — only the collection grouping is removed.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn delete_collection(
        &self,
        Parameters(DeleteCollectionArgs { id }): Parameters<DeleteCollectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        collections::do_delete_collection(&id, &self.state.db, sync)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("collections", "deleted", &id);
        Ok(CallToolResult::success(vec![ContentBlock::text(format!(
            "Collection {id} deleted."
        ))]))
    }
}
