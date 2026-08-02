use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::commands::{books, collections};
use crate::mcp::server::LanternMcpHandler;
use crate::mcp::tools::library::{require_sync, McpBook};
use crate::sync::events::EventBody;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ImportBooksArgs {
    /// Absolute paths to supported local ebook files.
    pub file_paths: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteBooksArgs {
    /// Book IDs returned by `list_books`.
    pub book_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CollectionBooksArgs {
    /// Collection ID returned by `get_collections`.
    pub collection_id: String,
    /// Book IDs returned by `list_books`.
    pub book_ids: Vec<String>,
    /// Whether the supplied books are added to or removed from the collection.
    pub operation: CollectionMembershipOperation,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CollectionMembershipOperation {
    Add,
    Remove,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetCollectionBooksArgs {
    /// Collection ID returned by `get_collections`.
    pub collection_id: String,
    /// Optional status or genre filter.
    #[serde(default)]
    pub filter: Option<String>,
    /// Optional case-insensitive title/author search.
    #[serde(default)]
    pub search: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReorderCollectionsArgs {
    /// Every collection ID, exactly once, in the desired order.
    pub collection_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct BatchItemResult {
    pub(crate) input: String,
    pub(crate) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) book_id: Option<String>,
}

impl BatchItemResult {
    fn new(input: String, status: &str, message: Option<String>, book_id: Option<String>) -> Self {
        Self {
            input,
            status: status.to_string(),
            message,
            book_id,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ImportBooksResponse {
    pub(crate) imported: Vec<McpBook>,
    pub(crate) results: Vec<BatchItemResult>,
}

#[derive(Debug, Serialize)]
pub(crate) struct DeleteBooksResponse {
    pub(crate) deleted: Vec<String>,
    pub(crate) results: Vec<BatchItemResult>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CollectionBooksResponse {
    pub(crate) collection_id: String,
    pub(crate) changed: Vec<String>,
    pub(crate) results: Vec<BatchItemResult>,
}

fn require_non_empty(values: &[String], field: &str) -> Result<(), ErrorData> {
    if values.is_empty() {
        return Err(ErrorData::invalid_params(
            format!("`{field}` must contain at least one item"),
            None,
        ));
    }
    Ok(())
}

fn failed_item(input: String, error: impl ToString) -> BatchItemResult {
    let message = error.to_string();
    let status = if message.contains("UNSUPPORTED_FORMAT") || message.contains("INVALID_CONTAINER")
    {
        "unsupported"
    } else {
        "error"
    };
    BatchItemResult::new(input, status, Some(message), None)
}

impl LanternMcpHandler {
    pub(crate) fn run_import_books(
        &self,
        file_paths: Vec<String>,
    ) -> Result<ImportBooksResponse, ErrorData> {
        require_non_empty(&file_paths, "file_paths")?;
        let sync = require_sync(self)?;
        let mut imported = Vec::new();
        let mut results = Vec::with_capacity(file_paths.len());

        for file_path in file_paths {
            match books::do_import_from_path(&file_path, &self.state.db, sync) {
                Ok(book) => {
                    let book_id = book.id.clone();
                    let projected = McpBook::project(book, &self.state.db)
                        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
                    imported.push(projected);
                    results.push(BatchItemResult::new(file_path, "ok", None, Some(book_id)));
                }
                Err(error) => results.push(failed_item(file_path, error)),
            }
        }
        if !imported.is_empty() {
            self.state
                .notify("books", "batch", &imported.len().to_string());
        }
        Ok(ImportBooksResponse { imported, results })
    }

    pub(crate) fn run_delete_books(
        &self,
        book_ids: Vec<String>,
    ) -> Result<DeleteBooksResponse, ErrorData> {
        require_non_empty(&book_ids, "book_ids")?;
        let sync = require_sync(self)?;
        let mut deleted = Vec::new();
        let mut results = Vec::with_capacity(book_ids.len());

        for book_id in book_ids {
            match books::query_book_exists(&self.state.db, &book_id) {
                Ok(false) => results.push(BatchItemResult::new(book_id, "not_found", None, None)),
                Ok(true) => match books::do_delete_book(&book_id, &self.state.db, sync) {
                    Ok(()) => {
                        deleted.push(book_id.clone());
                        results.push(BatchItemResult::new(
                            book_id.clone(),
                            "ok",
                            None,
                            Some(book_id),
                        ));
                    }
                    Err(error) => results.push(failed_item(book_id, error)),
                },
                Err(error) => results.push(failed_item(book_id, error)),
            }
        }
        if !deleted.is_empty() {
            self.state
                .notify("books", "batch", &deleted.len().to_string());
        }
        Ok(DeleteBooksResponse { deleted, results })
    }

    pub(crate) fn run_collection_membership(
        &self,
        collection_id: String,
        book_ids: Vec<String>,
        add: bool,
    ) -> Result<CollectionBooksResponse, ErrorData> {
        require_non_empty(&book_ids, "book_ids")?;
        let sync = require_sync(self)?;
        let collection_exists =
            collections::query_collection_exists(&self.state.db, &collection_id)
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        if !collection_exists {
            return Err(ErrorData::invalid_params(
                format!("Collection {collection_id} was not found"),
                None,
            ));
        }

        let mut changed = Vec::new();
        let mut results = Vec::with_capacity(book_ids.len());
        for book_id in book_ids {
            let exists = match books::query_book_exists(&self.state.db, &book_id) {
                Ok(exists) => exists,
                Err(error) => {
                    results.push(failed_item(book_id, error));
                    continue;
                }
            };
            if !exists {
                results.push(BatchItemResult::new(book_id, "not_found", None, None));
                continue;
            }
            let result = if add {
                collections::do_add_book_to_collection(
                    &collection_id,
                    &book_id,
                    &self.state.db,
                    sync,
                )
            } else {
                collections::do_remove_book_from_collection(
                    &collection_id,
                    &book_id,
                    &self.state.db,
                    sync,
                )
            };
            match result {
                Ok(true) => {
                    changed.push(book_id.clone());
                    results.push(BatchItemResult::new(
                        book_id.clone(),
                        "ok",
                        None,
                        Some(book_id),
                    ));
                }
                Ok(false) => results.push(BatchItemResult::new(
                    book_id.clone(),
                    "noop",
                    None,
                    Some(book_id),
                )),
                Err(error) => results.push(failed_item(book_id, error)),
            }
        }
        if !changed.is_empty() {
            self.state
                .notify("collections", "batch", &changed.len().to_string());
        }
        Ok(CollectionBooksResponse {
            collection_id,
            changed,
            results,
        })
    }
}

#[tool_router(router = library_batch_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Import one or more local ebook files. Continues after per-file failures and reports ok, unsupported, or error for each input.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = true
        )
    )]
    pub async fn import_books(
        &self,
        Parameters(ImportBooksArgs { file_paths }): Parameters<ImportBooksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let response = self.run_import_books(file_paths)?;
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &response,
        )?]))
    }

    #[tool(
        description = "Permanently delete one or more books and their associated data and files. Missing IDs are reported per item.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn delete_books(
        &self,
        Parameters(DeleteBooksArgs { book_ids }): Parameters<DeleteBooksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let response = self.run_delete_books(book_ids)?;
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &response,
        )?]))
    }

    #[tool(
        description = "Add or remove one or more books from a collection without deleting any books. Existing target state is reported as no-op and missing books per item.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn update_collection_membership(
        &self,
        Parameters(CollectionBooksArgs {
            collection_id,
            book_ids,
            operation,
        }): Parameters<CollectionBooksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let add = matches!(operation, CollectionMembershipOperation::Add);
        let response = self.run_collection_membership(collection_id, book_ids, add)?;
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &response,
        )?]))
    }

    #[tool(
        description = "List full MCP book records for one collection, optionally filtering by status/genre and searching title/author.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn get_collection_books(
        &self,
        Parameters(GetCollectionBooksArgs {
            collection_id,
            filter,
            search,
        }): Parameters<GetCollectionBooksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let exists = collections::query_collection_exists(&self.state.db, &collection_id)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        if !exists {
            return Err(ErrorData::invalid_params(
                format!("Collection {collection_id} was not found"),
                None,
            ));
        }
        let raw = books::query_books_lite(
            &self.state.db,
            filter.as_deref(),
            search.as_deref(),
            Some(&collection_id),
            1000,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let books: Vec<McpBook> = raw
            .into_iter()
            .map(|book| McpBook::project(book, &self.state.db))
            .collect::<crate::error::AppResult<_>>()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(&books)?]))
    }

    #[tool(
        description = "Set collection order. `collection_ids` must contain every current collection exactly once. Returns the reordered collections.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn reorder_collections(
        &self,
        Parameters(ReorderCollectionsArgs { collection_ids }): Parameters<ReorderCollectionsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let current = collections::query_collections(&self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let current_ids = current
            .iter()
            .map(|collection| collection.id.as_str())
            .collect::<HashSet<_>>();
        let requested_ids = collection_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        if collection_ids.len() != current.len()
            || requested_ids.len() != collection_ids.len()
            || requested_ids != current_ids
        {
            return Err(ErrorData::invalid_params(
                "`collection_ids` must contain every current collection exactly once",
                None,
            ));
        }
        let now = chrono::Utc::now().timestamp_millis();
        let device = sync.self_device().to_string();
        sync.with_tx(&self.state.db, now, |tx, events| {
            for (sort_order, id) in collection_ids.iter().enumerate() {
                tx.execute(
                    "UPDATE collections SET sort_order = ?1, updated_at = ?2,
                                            updated_by_device = ?3 WHERE id = ?4",
                    rusqlite::params![sort_order as i32, now, device, id],
                )?;
                events.push(EventBody::CollectionReorder {
                    id: id.clone(),
                    sort_order: sort_order as i32,
                });
            }
            Ok(())
        })
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("collections", "reordered", "all");
        let reordered = collections::query_collections(&self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &reordered,
        )?]))
    }
}
