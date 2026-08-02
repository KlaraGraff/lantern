use std::collections::HashMap;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::mcp::server::LanternMcpHandler;
use crate::mcp::tools::library::require_sync;
use crate::secrets::Secrets;

const MAX_KEY_CHARS: usize = 256;
const MAX_VALUE_BYTES: usize = 1_048_576;
const MAX_BATCH_BYTES: usize = 4_194_304;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetSettingsArgs {
    /// Book ID for book-specific reader settings. Omit for global settings.
    #[serde(default)]
    pub book_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateSettingsArgs {
    /// Book ID for book-specific reader settings. Omit for global settings.
    #[serde(default)]
    pub book_id: Option<String>,
    /// Complete set of setting key/value updates to apply atomically.
    pub settings: HashMap<String, String>,
}

fn validate_settings(settings: &HashMap<String, String>) -> Result<(), ErrorData> {
    if settings.is_empty() {
        return Err(ErrorData::invalid_params(
            "`settings` must contain at least one value",
            None,
        ));
    }

    let mut total = 0usize;
    for (key, value) in settings {
        if key.trim().is_empty() || key.chars().count() > MAX_KEY_CHARS {
            return Err(ErrorData::invalid_params(
                format!("invalid setting key: {key:?}"),
                None,
            ));
        }
        if value.len() > MAX_VALUE_BYTES {
            return Err(ErrorData::invalid_params(
                format!("setting {key:?} exceeds {MAX_VALUE_BYTES} bytes"),
                None,
            ));
        }
        total = total.saturating_add(key.len()).saturating_add(value.len());
    }
    if total > MAX_BATCH_BYTES {
        return Err(ErrorData::invalid_params(
            format!("settings update exceeds {MAX_BATCH_BYTES} bytes"),
            None,
        ));
    }
    Ok(())
}

fn ensure_book_exists(handler: &LanternMcpHandler, book_id: &str) -> Result<(), ErrorData> {
    let conn = handler.state.db.reader();
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM books WHERE id = ?1)",
            rusqlite::params![book_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    if !exists {
        return Err(ErrorData::invalid_params(
            format!("book not found: {book_id}"),
            None,
        ));
    }
    Ok(())
}

#[tool_router(router = configuration_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Return global settings, or book-specific reader settings when `book_id` is supplied. Stored credential values are never returned.",
        annotations(
            title = "Get Lantern settings",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn get_settings(
        &self,
        Parameters(GetSettingsArgs { book_id }): Parameters<GetSettingsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.state.db.reader();
        let settings = if let Some(book_id) = book_id {
            drop(conn);
            ensure_book_exists(self, &book_id)?;
            let conn = self.state.db.reader();
            let mut statement = conn
                .prepare("SELECT key, value FROM book_settings WHERE book_id = ?1 ORDER BY key")
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            statement
                .query_map(rusqlite::params![book_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .and_then(|rows| rows.collect::<Result<HashMap<_, _>, _>>())
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
        } else {
            let mut statement = conn
                .prepare("SELECT key, value FROM settings ORDER BY key")
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
                .filter_map(|row| match row {
                    Ok((key, value)) if !Secrets::is_sensitive_key(&key) => Some(Ok((key, value))),
                    Ok(_) => None,
                    Err(error) => Some(Err(error)),
                })
                .collect::<Result<HashMap<_, _>, _>>()
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            rows
        };

        Ok(CallToolResult::success(vec![ContentBlock::json(
            &settings,
        )?]))
    }

    #[tool(
        description = "Apply global settings, or book-specific reader settings when `book_id` is supplied. Credential values use the dedicated AI or speech credential tools and are rejected here.",
        annotations(
            title = "Update Lantern settings",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn update_settings(
        &self,
        Parameters(UpdateSettingsArgs { book_id, settings }): Parameters<UpdateSettingsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        require_sync(self)?;
        validate_settings(&settings)?;
        if settings.keys().any(|key| Secrets::is_sensitive_key(key)) {
            return Err(ErrorData::invalid_params(
                "credential settings require a dedicated credential tool",
                None,
            ));
        }
        if let Some(book_id) = book_id.as_deref() {
            ensure_book_exists(self, book_id)?;
        }

        let conn = self
            .state
            .db
            .conn
            .lock()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        for (key, value) in &settings {
            if let Some(book_id) = book_id.as_deref() {
                transaction
                    .execute(
                        "INSERT INTO book_settings (book_id, key, value) VALUES (?1, ?2, ?3)
                         ON CONFLICT(book_id, key) DO UPDATE SET value = excluded.value",
                        rusqlite::params![book_id, key, value],
                    )
                    .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            } else {
                transaction
                    .execute(
                        "INSERT INTO settings (key, value) VALUES (?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        rusqlite::params![key, value],
                    )
                    .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            }
        }
        transaction
            .commit()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;

        let scope = book_id.as_deref().unwrap_or("global");
        self.state.notify("settings", "updated", scope);
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &serde_json::json!({ "scope": scope, "settings": settings }),
        )?]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_rejects_empty_and_oversized_updates() {
        assert!(validate_settings(&HashMap::new()).is_err());
        let oversized = HashMap::from([("key".to_string(), "x".repeat(MAX_VALUE_BYTES + 1))]);
        assert!(validate_settings(&oversized).is_err());
    }
}
