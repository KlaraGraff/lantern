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
use crate::mcp::tools::library_batch::{
    CollectionBooksArgs, CollectionMembershipOperation, GetCollectionBooksArgs,
    ReorderCollectionsArgs,
};

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

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "query", rename_all = "snake_case")]
pub enum QueryCollectionsKind {
    List,
    ListBooks {
        collection_id: String,
        #[serde(default)]
        filter: Option<String>,
        #[serde(default)]
        search: Option<String>,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct QueryCollectionsArgs {
    #[serde(flatten)]
    pub query: QueryCollectionsKind,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum UpdateCollectionsAction {
    Create {
        name: String,
    },
    Rename {
        id: String,
        name: String,
    },
    Reorder {
        collection_ids: Vec<String>,
    },
    UpdateMembership {
        collection_id: String,
        book_ids: Vec<String>,
        operation: CollectionMembershipOperation,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateCollectionsArgs {
    #[serde(flatten)]
    pub action: UpdateCollectionsAction,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteCollectionsArgs {
    /// Collection IDs to permanently delete. Books in them are not deleted.
    pub ids: Vec<String>,
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

#[tool_router(router = collections_catalog_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "List Lantern collections or list the books in one collection.",
        annotations(
            title = "Query Lantern collections",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn query_collections(
        &self,
        Parameters(QueryCollectionsArgs { query }): Parameters<QueryCollectionsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match query {
            QueryCollectionsKind::List => self.get_collections().await,
            QueryCollectionsKind::ListBooks {
                collection_id,
                filter,
                search,
            } => {
                self.get_collection_books(Parameters(GetCollectionBooksArgs {
                    collection_id,
                    filter,
                    search,
                }))
                .await
            }
        }
    }

    #[tool(
        description = "Create, rename, reorder, or change membership for Lantern collections.",
        annotations(
            title = "Update Lantern collections",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn update_collections(
        &self,
        Parameters(UpdateCollectionsArgs { action }): Parameters<UpdateCollectionsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match action {
            UpdateCollectionsAction::Create { name } => {
                self.create_collection(Parameters(CreateCollectionArgs { name }))
                    .await
            }
            UpdateCollectionsAction::Rename { id, name } => {
                self.rename_collection(Parameters(RenameCollectionArgs { id, name }))
                    .await
            }
            UpdateCollectionsAction::Reorder { collection_ids } => {
                self.reorder_collections(Parameters(ReorderCollectionsArgs { collection_ids }))
                    .await
            }
            UpdateCollectionsAction::UpdateMembership {
                collection_id,
                book_ids,
                operation,
            } => {
                self.update_collection_membership(Parameters(CollectionBooksArgs {
                    collection_id,
                    book_ids,
                    operation,
                }))
                .await
            }
        }
    }

    #[tool(
        description = "Permanently delete one or more collection groupings. Books in them are not deleted.",
        annotations(
            title = "Delete Lantern collections",
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn delete_collections(
        &self,
        Parameters(DeleteCollectionsArgs { ids }): Parameters<DeleteCollectionsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ids = crate::mcp::tools::annotations_write::validate_ids(ids, "ids")?;
        let sync = require_sync(self)?;
        let mut results = Vec::with_capacity(ids.len());
        for id in ids {
            match collections::do_delete_collection(&id, &self.state.db, sync) {
                Ok(()) => {
                    self.state.notify("collections", "deleted", &id);
                    results.push(serde_json::json!({ "id": id, "status": "deleted" }));
                }
                Err(error) => results.push(serde_json::json!({
                    "id": id,
                    "status": "failed",
                    "error": error.to_string(),
                })),
            }
        }
        Ok(CallToolResult::success(vec![ContentBlock::json(
            serde_json::json!({ "results": results }),
        )?]))
    }
}
