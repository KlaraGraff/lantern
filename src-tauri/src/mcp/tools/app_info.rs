use std::fs::File;
use std::io::{BufRead, BufReader};
use std::time::UNIX_EPOCH;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::mcp::server::LanternMcpHandler;

const DEFAULT_LOG_LINES: usize = 200;
const MAX_LOG_LINES: usize = 1_000;
const MAX_LOG_BYTES: usize = 1_048_576;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetDiagnosticsArgs {
    /// Number of trailing lines to return from the newest log. Defaults to 200; maximum 1000.
    #[serde(default)]
    pub lines: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "query", rename_all = "snake_case")]
pub enum GetAppInfoQuery {
    Build,
    Diagnostics {
        #[serde(default)]
        lines: Option<usize>,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetAppInfoArgs {
    #[serde(flatten)]
    pub query: GetAppInfoQuery,
}

#[derive(Debug, Serialize)]
struct DiagnosticLogFile {
    name: String,
    bytes: u64,
    modified_at: Option<u64>,
}

fn diagnostic_logs(lines: usize) -> Result<serde_json::Value, ErrorData> {
    let log_dir = crate::resolve_log_dir();
    if !log_dir.exists() {
        return Ok(serde_json::json!({
            "log_directory": log_dir,
            "files": [],
            "newest_log_tail": null,
        }));
    }
    let mut files = std::fs::read_dir(&log_dir)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then_some((entry.path(), metadata))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(_, metadata)| metadata.modified().ok());
    files.reverse();

    let listing = files
        .iter()
        .map(|(path, metadata)| DiagnosticLogFile {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            bytes: metadata.len(),
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs()),
        })
        .collect::<Vec<_>>();

    let tail = if lines == 0 {
        None
    } else if let Some((path, _)) = files.first() {
        let reader = BufReader::new(
            File::open(path).map_err(|error| ErrorData::internal_error(error.to_string(), None))?,
        );
        let mut buffered = std::collections::VecDeque::with_capacity(lines);
        let mut bytes = 0usize;
        for line in reader.lines() {
            let line = line.map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            bytes = bytes.saturating_add(line.len() + 1);
            buffered.push_back(line);
            while buffered.len() > lines || bytes > MAX_LOG_BYTES {
                if let Some(removed) = buffered.pop_front() {
                    bytes = bytes.saturating_sub(removed.len() + 1);
                }
            }
        }
        Some(buffered.into_iter().collect::<Vec<_>>().join("\n"))
    } else {
        None
    };

    Ok(serde_json::json!({
        "log_directory": log_dir,
        "files": listing,
        "newest_log_tail": tail,
    }))
}

#[tool_router(router = app_info_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Return the installed Lantern version, build commit, channel, build time, and repository metadata.",
        annotations(
            title = "Get Lantern build information",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn get_app_info(&self) -> Result<CallToolResult, ErrorData> {
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &crate::commands::app::app_build_info(),
        )?]))
    }

    #[tool(
        description = "Return Lantern's log directory, log-file metadata, and a bounded tail of the newest log file.",
        annotations(
            title = "Get Lantern diagnostics",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn get_diagnostics(
        &self,
        Parameters(GetDiagnosticsArgs { lines }): Parameters<GetDiagnosticsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let lines = lines.unwrap_or(DEFAULT_LOG_LINES);
        if lines > MAX_LOG_LINES {
            return Err(ErrorData::invalid_params(
                format!("`lines` cannot exceed {MAX_LOG_LINES}"),
                None,
            ));
        }
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &diagnostic_logs(lines)?,
        )?]))
    }
}

#[tool_router(router = app_info_catalog_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        name = "get_app_info",
        description = "Return Lantern build information or the same bounded diagnostics and log information visible in the app.",
        annotations(
            title = "Get Lantern app information",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn get_app_info_catalog(
        &self,
        Parameters(GetAppInfoArgs { query }): Parameters<GetAppInfoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        match query {
            GetAppInfoQuery::Build => self.get_app_info().await,
            GetAppInfoQuery::Diagnostics { lines } => {
                self.get_diagnostics(Parameters(GetDiagnosticsArgs { lines }))
                    .await
            }
        }
    }
}
