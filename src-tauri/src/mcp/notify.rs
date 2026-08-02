//! Watches the `.mcp-notify` sentinel file and emits Tauri events so
//! the frontend can refresh when the MCP subprocess mutates the library.

use std::path::{Path, PathBuf};

use notify::{recommended_watcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

/// Spawn a background thread that watches `sentinel_path` for writes.
/// On each write, reads the JSON payload and emits the appropriate
/// Tauri event for the domain named in the payload.
///
/// The watcher thread lives for the entire app lifetime. If the
/// sentinel file doesn't exist yet, the watcher still activates — it
/// watches the parent directory and fires when the file is created.
pub fn spawn_watcher(sentinel_path: PathBuf, app_handle: AppHandle) {
    let watch_dir = sentinel_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    let sentinel_name = sentinel_path.file_name().unwrap_or_default().to_os_string();

    let handle = app_handle.clone();
    let mut watcher = match recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let dominated = event
            .paths
            .iter()
            .any(|p| p.file_name().map(|n| n == sentinel_name).unwrap_or(false));
        if !dominated {
            return;
        }
        if let Ok(payload) = std::fs::read_to_string(&sentinel_path) {
            emit_from_payload(&handle, &payload);
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("mcp notify: failed to create watcher: {e}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&watch_dir, RecursiveMode::NonRecursive) {
        log::warn!("mcp notify: failed to watch {}: {e}", watch_dir.display());
        return;
    }

    // Leak the watcher so it stays alive for the app's lifetime.
    // The OS hooks are cleaned up on process exit.
    std::mem::forget(watcher);
}

fn emit_from_payload(handle: &AppHandle, payload: &str) {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) else {
        return;
    };
    let domain = json["domain"].as_str().unwrap_or("");
    let event_name = match domain {
        "books" => "mcp:books-changed",
        "collections" => "mcp:collections-changed",
        "bookmarks" => "mcp:bookmarks-changed",
        "highlights" => "mcp:highlights-changed",
        "notes" => "mcp:notes-changed",
        "vocabulary" => "mcp:vocabulary-changed",
        "word_forms" => "mcp:word-forms-changed",
        "word_marks" => "mcp:word-marks-changed",
        "chats" => "mcp:chats-changed",
        "language_assessments" => "mcp:language-assessments-changed",
        "approvals" => "mcp:approvals-changed",
        _ => return,
    };
    let _ = handle.emit(event_name, payload);
}

pub fn write_sentinel(path: &Path, domain: &str, action: &str, id: &str) {
    let payload = serde_json::json!({
        "domain": domain,
        "action": action,
        "id": id,
        "ts": chrono::Utc::now().timestamp_millis(),
    });
    match serde_json::to_vec(&payload) {
        Ok(payload) => {
            if let Err(error) = std::fs::write(path, payload) {
                eprintln!("mcp: failed to write notify sentinel: {error}");
            }
        }
        Err(error) => eprintln!("mcp: failed to serialize notify sentinel: {error}"),
    }
}
