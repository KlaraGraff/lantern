use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::mcp;
use crate::mcp::server::LanternMcpHandler;
use crate::mcp::tools::library::require_sync;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateMcpSettingsArgs {
    /// Register or unregister Lantern in Claude Code. Omit to leave unchanged.
    #[serde(default)]
    pub claude_code: Option<bool>,
    /// Register or unregister Lantern in Codex. Omit to leave unchanged.
    #[serde(default)]
    pub codex: Option<bool>,
    /// Enable or disable MCP write access for future Lantern MCP processes. Omit to leave unchanged.
    #[serde(default)]
    pub write_enabled: Option<bool>,
}

#[tool_router(router = integration_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Return Lantern's Claude Code and Codex registration state, MCP write-access state, active binary path, and configuration snippet.",
        annotations(
            title = "Get Lantern MCP integration status",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn get_mcp_status(&self) -> Result<CallToolResult, ErrorData> {
        let status = mcp::mcp_integration_status_inner(&self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let snippet = mcp::mcp_config_snippet()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &serde_json::json!({ "status": status, "config_snippet": snippet }),
        )?]))
    }

    #[tool(
        description = "Set Lantern registration in Claude Code and/or Codex, and set MCP write access for future MCP processes. Omitted fields remain unchanged.",
        annotations(
            title = "Update Lantern MCP integration settings",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    pub async fn update_mcp_settings(
        &self,
        Parameters(UpdateMcpSettingsArgs {
            claude_code,
            codex,
            write_enabled,
        }): Parameters<UpdateMcpSettingsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if claude_code.is_none() && codex.is_none() && write_enabled.is_none() {
            return Err(ErrorData::invalid_params(
                "at least one MCP setting must be supplied",
                None,
            ));
        }
        require_sync(self)?;
        if let Some(enabled) = claude_code {
            mcp::mcp_set_integration_inner("claude_code", enabled)
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        }
        if let Some(enabled) = codex {
            mcp::mcp_set_integration_inner("codex", enabled)
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        }
        if let Some(enabled) = write_enabled {
            mcp::mcp_set_write_access_inner(enabled, &self.state.db)
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        }
        let status = mcp::mcp_integration_status_inner(&self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state.notify("mcp", "updated", "integration");
        Ok(CallToolResult::success(vec![ContentBlock::json(&status)?]))
    }
}

#[tool_router(router = integration_catalog_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        name = "get_mcp_integration",
        description = "Return Lantern MCP client registration, write-access, active binary, and configuration-snippet status.",
        annotations(
            title = "Get Lantern MCP integration",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn get_mcp_integration_catalog(&self) -> Result<CallToolResult, ErrorData> {
        self.get_mcp_status().await
    }

    #[tool(
        name = "update_mcp_integration",
        description = "Update Lantern MCP client registrations or write access. Omitted fields remain unchanged.",
        annotations(
            title = "Update Lantern MCP integration",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    pub async fn update_mcp_integration_catalog(
        &self,
        args: Parameters<UpdateMcpSettingsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.update_mcp_settings(args).await
    }
}
