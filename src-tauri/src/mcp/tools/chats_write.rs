use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::chats;
use crate::mcp::server::LanternMcpHandler;
use crate::mcp::tools::annotations_write::{validate_ids, DeleteIdsArgs};
use crate::mcp::tools::chats::GetChatHistoryArgs;
use crate::mcp::tools::library::require_sync;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateChatArgs {
    pub book_id: String,
    #[serde(default)]
    pub title: Option<String>,
    /// Optional saved model label. Creating a chat does not call a model.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RenameChatArgs {
    pub chat_id: String,
    pub title: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveChatMessageArgs {
    pub chat_id: String,
    /// Message role stored by Lantern, normally `user` or `assistant`.
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub metadata: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReplaceChatMessageArgs {
    /// Assistant message ID returned in `get_chat_history`.
    pub message_id: String,
    pub content: String,
    #[serde(default)]
    pub metadata: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct QueryChatsArgs {
    pub book_id: String,
    #[serde(default)]
    pub chat_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum SaveChatsAction {
    Create {
        book_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        model: Option<String>,
    },
    Rename {
        chat_id: String,
        title: String,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveChatsArgs {
    #[serde(flatten)]
    pub action: SaveChatsAction,
}

#[tool_router(router = chats_write_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Create an empty chat for a book. This does not send a message or call an AI service."
    )]
    pub async fn create_chat(
        &self,
        Parameters(CreateChatArgs {
            book_id,
            title,
            model,
        }): Parameters<CreateChatArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let chat = chats::create_chat_inner(&book_id, title, model, &self.state.db, sync)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("chats", "created", &chat.id);
        Ok(CallToolResult::success(vec![ContentBlock::json(&chat)?]))
    }

    #[tool(description = "Rename a chat. This does not send a message or call an AI service.")]
    pub async fn rename_chat(
        &self,
        Parameters(RenameChatArgs { chat_id, title }): Parameters<RenameChatArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        chats::rename_chat_inner(&chat_id, &title, &self.state.db, sync)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("chats", "updated", &chat_id);
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &serde_json::json!({ "id": chat_id, "title": title }),
        )?]))
    }

    #[tool(
        description = "Save a chat message without sending an AI request. This stores exactly the supplied role, content, context, and metadata."
    )]
    pub async fn save_chat_message(
        &self,
        Parameters(SaveChatMessageArgs {
            chat_id,
            role,
            content,
            context,
            metadata,
        }): Parameters<SaveChatMessageArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let message = chats::save_chat_message_inner(
            &chat_id,
            &role,
            &content,
            context,
            metadata,
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("chats", "updated", &message.chat_id);
        Ok(CallToolResult::success(vec![ContentBlock::json(&message)?]))
    }

    #[tool(
        description = "Replace the stored content and metadata of one assistant chat message without sending an AI request."
    )]
    pub async fn replace_chat_message(
        &self,
        Parameters(ReplaceChatMessageArgs {
            message_id,
            content,
            metadata,
        }): Parameters<ReplaceChatMessageArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let message = chats::replace_chat_message_inner(
            &message_id,
            &content,
            metadata,
            &self.state.db,
            sync,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("chats", "updated", &message.chat_id);
        Ok(CallToolResult::success(vec![ContentBlock::json(&message)?]))
    }

    #[tool(
        description = "Permanently delete one or more chats and all messages they contain. This action cannot be undone."
    )]
    pub async fn delete_chats(
        &self,
        Parameters(DeleteIdsArgs { ids }): Parameters<DeleteIdsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ids = validate_ids(ids, "ids")?;
        let sync = require_sync(self)?;
        let deleted = chats::delete_chats_inner(&ids, &self.state.db, sync)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("chats", "deleted", &deleted.to_string());
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &serde_json::json!({ "requested": ids.len(), "deleted": deleted }),
        )?]))
    }
}

#[tool_router(router = chats_catalog_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Return all saved chats for a book with ordered messages, or one chat when `chat_id` is supplied.",
        annotations(
            title = "Query Lantern chats",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn query_chats(
        &self,
        Parameters(QueryChatsArgs { book_id, chat_id }): Parameters<QueryChatsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.get_chat_history(Parameters(GetChatHistoryArgs { book_id, chat_id }))
            .await
    }

    #[tool(
        description = "Create or rename saved chats without sending an AI request.",
        annotations(
            title = "Save Lantern chats",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn save_chats(
        &self,
        Parameters(SaveChatsArgs { action }): Parameters<SaveChatsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match action {
            SaveChatsAction::Create {
                book_id,
                title,
                model,
            } => {
                self.create_chat(Parameters(CreateChatArgs {
                    book_id,
                    title,
                    model,
                }))
                .await
            }
            SaveChatsAction::Rename { chat_id, title } => {
                self.rename_chat(Parameters(RenameChatArgs { chat_id, title }))
                    .await
            }
        }
    }
}
