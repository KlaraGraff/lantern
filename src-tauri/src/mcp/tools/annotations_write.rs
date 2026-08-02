use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::Deserialize;
use std::collections::HashSet;

use crate::commands::{bookmarks, notes};
use crate::mcp::server::LanternMcpHandler;
use crate::mcp::tools::library::require_sync;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateBookmarkArgs {
    /// Book ID returned by `list_books`.
    pub book_id: String,
    /// EPUB CFI or PDF location for the bookmark.
    pub cfi: String,
    /// Optional visible bookmark label.
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateHighlightArgs {
    /// Book ID returned by `list_books`.
    pub book_id: String,
    /// EPUB CFI range or PDF range for the selected passage.
    pub cfi_range: String,
    /// Highlight color. Defaults to `yellow`.
    #[serde(default)]
    pub color: Option<String>,
    /// Optional attached legacy highlight note.
    #[serde(default)]
    pub note: Option<String>,
    /// Optional selected passage text retained with the highlight.
    #[serde(default)]
    pub text_content: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateHighlightArgs {
    /// Highlight ID returned by `get_highlights`.
    pub id: String,
    /// Replacement note text. Omit to leave unchanged.
    #[serde(default)]
    pub note: Option<String>,
    /// Replacement color name or token. Omit to leave unchanged.
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveNoteArgs {
    /// Existing note ID to update. Omit to create a note.
    #[serde(default)]
    pub id: Option<String>,
    /// Book ID for book-scoped notes. Omit for a library-scoped note.
    #[serde(default)]
    pub book_id: Option<String>,
    /// Note anchor kind, such as `selection` or `word`.
    pub anchor_kind: String,
    /// Optional word anchor.
    #[serde(default)]
    pub word: Option<String>,
    /// Note scope accepted by Lantern, such as `book` or `library`.
    pub scope: String,
    /// Optional reader location.
    #[serde(default)]
    pub location: Option<String>,
    /// Optional selected source text.
    #[serde(default)]
    pub selected_text: Option<String>,
    /// Plain-text note content.
    pub content: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteIdsArgs {
    /// IDs to permanently delete. Accepts one or many IDs.
    pub ids: Vec<String>,
}

pub(crate) fn validate_ids(ids: Vec<String>, field: &str) -> Result<Vec<String>, ErrorData> {
    if ids.is_empty() {
        return Err(ErrorData::invalid_params(
            format!("`{field}` must contain at least one item"),
            None,
        ));
    }
    if ids.len() > 500 {
        return Err(ErrorData::invalid_params(
            format!("`{field}` cannot contain more than 500 items"),
            None,
        ));
    }
    if ids.iter().any(|id| id.trim().is_empty()) {
        return Err(ErrorData::invalid_params(
            format!("`{field}` must contain only non-empty strings"),
            None,
        ));
    }
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(ErrorData::invalid_params(
            format!("`{field}` must not contain duplicates"),
            None,
        ));
    }
    Ok(ids)
}

#[tool_router(router = annotations_write_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Create a bookmark at a book location. This does not delete or replace existing bookmarks."
    )]
    pub async fn create_bookmark(
        &self,
        Parameters(CreateBookmarkArgs {
            book_id,
            cfi,
            label,
        }): Parameters<CreateBookmarkArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let bookmark = bookmarks::add_bookmark_inner(&book_id, &cfi, label, &self.state.db, sync)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("bookmarks", "created", &bookmark.id);
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &bookmark,
        )?]))
    }

    #[tool(
        description = "Create a highlight for a selected book range. This does not delete or replace existing highlights."
    )]
    pub async fn create_highlight(
        &self,
        Parameters(CreateHighlightArgs {
            book_id,
            cfi_range,
            color,
            note,
            text_content,
        }): Parameters<CreateHighlightArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let highlight = bookmarks::add_highlight_inner(
            &book_id,
            &cfi_range,
            color,
            note,
            text_content,
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("highlights", "created", &highlight.id);
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &highlight,
        )?]))
    }

    #[tool(
        description = "Update one highlight's note, color, or both. Omitted fields remain unchanged."
    )]
    pub async fn update_highlight(
        &self,
        Parameters(UpdateHighlightArgs { id, note, color }): Parameters<UpdateHighlightArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let highlight = bookmarks::update_highlight_inner(
            &id,
            note.as_deref(),
            color.as_deref(),
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("highlights", "updated", &id);
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &highlight,
        )?]))
    }

    #[tool(
        description = "Create a first-class note, or replace an existing note when `id` is supplied."
    )]
    pub async fn save_note(
        &self,
        Parameters(SaveNoteArgs {
            id,
            book_id,
            anchor_kind,
            word,
            scope,
            location,
            selected_text,
            content,
        }): Parameters<SaveNoteArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let note = notes::save_note_inner(
            id,
            book_id,
            &anchor_kind,
            word,
            &scope,
            location,
            selected_text,
            &content,
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("notes", "updated", &note.id);
        Ok(CallToolResult::success(vec![ContentBlock::json(&note)?]))
    }

    #[tool(description = "Permanently delete one or more bookmarks. This action cannot be undone.")]
    pub async fn delete_bookmarks(
        &self,
        Parameters(DeleteIdsArgs { ids }): Parameters<DeleteIdsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ids = validate_ids(ids, "ids")?;
        let sync = require_sync(self)?;
        let deleted = bookmarks::delete_bookmarks_inner(&ids, &self.state.db, sync)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state
            .notify("bookmarks", "deleted", &deleted.to_string());
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &serde_json::json!({ "requested": ids.len(), "deleted": deleted }),
        )?]))
    }

    #[tool(
        description = "Permanently delete one or more highlights and their attached legacy note text. This action cannot be undone."
    )]
    pub async fn delete_highlights(
        &self,
        Parameters(DeleteIdsArgs { ids }): Parameters<DeleteIdsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ids = validate_ids(ids, "ids")?;
        let sync = require_sync(self)?;
        let deleted = bookmarks::delete_highlights_inner(&ids, &self.state.db, sync)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state
            .notify("highlights", "deleted", &deleted.to_string());
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &serde_json::json!({ "requested": ids.len(), "deleted": deleted }),
        )?]))
    }

    #[tool(
        description = "Permanently delete one or more first-class notes. This action cannot be undone."
    )]
    pub async fn delete_notes(
        &self,
        Parameters(DeleteIdsArgs { ids }): Parameters<DeleteIdsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ids = validate_ids(ids, "ids")?;
        let sync = require_sync(self)?;
        let deleted = notes::delete_notes_inner(&ids, &self.state.db, sync)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("notes", "deleted", &deleted.to_string());
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &serde_json::json!({ "requested": ids.len(), "deleted": deleted }),
        )?]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destructive_id_batches_reject_empty_and_duplicate_inputs() {
        assert!(validate_ids(Vec::new(), "ids").is_err());
        assert!(validate_ids(vec!["one".into(), "one".into()], "ids").is_err());
        assert_eq!(
            validate_ids(vec!["one".into(), "two".into()], "ids").unwrap(),
            vec!["one".to_string(), "two".to_string()]
        );
    }
}
