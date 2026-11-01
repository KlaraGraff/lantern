use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::commands::sync::{stop_for_reset, SyncState};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::writer::SyncWriter;
use crate::{reset, resolve_log_dir, sync, LocalDir};

const MAX_WEBVIEW_LOG_SCOPE_CHARS: usize = 96;
// Wide enough for a reader diagnostic line to carry a JS stack or the runtime
// capability snapshot without being clipped.
const MAX_WEBVIEW_LOG_MESSAGE_CHARS: usize = 4_096;

#[derive(Debug, serde::Serialize)]
pub struct BuildInfo {
    pub version: String,
    pub upstream_baseline: String,
    pub commit: String,
    pub built_at: String,
    pub channel: String,
    pub bundle_identifier: String,
    pub repository: String,
    pub upstream_repository: String,
}

#[tauri::command]
pub fn app_build_info() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        upstream_baseline: env!("LANTERN_UPSTREAM_BASELINE").to_string(),
        commit: env!("LANTERN_BUILD_COMMIT").to_string(),
        built_at: env!("LANTERN_BUILD_DATE").to_string(),
        channel: env!("LANTERN_BUILD_CHANNEL").to_string(),
        bundle_identifier: "com.klaragraff.lantern".to_string(),
        repository: "https://github.com/KlaraGraff/lantern".to_string(),
        upstream_repository: "https://github.com/yicheng47/quill".to_string(),
    }
}

/// Called by the frontend after React has mounted and painted its first frame.
/// Shows the main window — the window starts hidden so the user sees the dock
/// bounce → fully-rendered window instead of a beach ball over a blank webview.
#[tauri::command]
pub fn app_ready(app: AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::Other("main window not found".into()))?;
    window.show().map_err(|e| AppError::Other(e.to_string()))?;
    window
        .set_focus()
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

/// Reveal the per-user app log directory in the OS file manager.
#[tauri::command]
pub fn reveal_logs(app: AppHandle) -> AppResult<()> {
    let log_dir = resolve_log_dir();
    app.opener()
        .open_path(log_dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Other(format!("open log dir: {e}")))?;
    Ok(())
}

/// Records intentional frontend fallbacks without exposing arbitrary-sized
/// webview input to the application log.
#[tauri::command]
pub fn log_webview_warning(scope: String, message: String) {
    let scope: String = scope.chars().take(MAX_WEBVIEW_LOG_SCOPE_CHARS).collect();
    let message: String = message
        .chars()
        .take(MAX_WEBVIEW_LOG_MESSAGE_CHARS)
        .collect();
    log::warn!("webview fallback [{scope}]: {message}");
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetDataSummary {
    pub book_count: i64,
    pub sync_enabled: bool,
}

/// What the first 重置全部数据 step lists: how many books go, and whether
/// to explain that sync is switched off first.
#[tauri::command]
pub fn reset_data_summary(
    db: State<'_, Db>,
    local: State<'_, LocalDir>,
) -> AppResult<ResetDataSummary> {
    let book_count = db
        .reader()
        .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))?;
    Ok(ResetDataSummary {
        book_count,
        sync_enabled: sync::migration::is_sync_enabled(&local.0),
    })
}

/// Turn sync off for this session and mark the data for wiping. The wipe
/// itself runs at the start of the next launch (see `reset`); the frontend
/// relaunches the app as soon as this returns.
#[tauri::command(async)]
pub fn reset_all_data(
    confirmation: String,
    local: State<'_, LocalDir>,
    sync_writer: State<'_, SyncWriter>,
    sync_state: State<'_, SyncState>,
) -> AppResult<()> {
    // The typed word travels with the request, so nothing that merely can
    // call commands sets the marker without the second confirmation.
    if confirmation.trim() != "RESET" {
        return Err(AppError::Other("RESET_NOT_CONFIRMED".into()));
    }
    log::warn!("reset: 重置全部数据 requested");
    let _transition = sync_writer.begin_transition()?;
    stop_for_reset(&local.0, &sync_writer, &sync_state)?;
    reset::request(&local.0)
}
