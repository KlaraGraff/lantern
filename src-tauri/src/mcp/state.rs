use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::db::Db;
use crate::sync::writer::SyncWriter;

use super::approval::ApprovalStore;
use super::control::ControlStore;
use super::notify;

/// Shared state handed to every MCP request handler.
///
/// `Db` is already cheaply `Clone` (its inner `Connection` and
/// `data_dir` live behind `Arc<Mutex<…>>`), so we do NOT wrap it in
/// another `Arc`. See `db.rs:31-43`.
///
/// `sync` is `Some` when write tools are enabled (`mcp_write_enabled`
/// setting). Write tool handlers check this and return a clear error
/// when `None`. `SyncWriter` is behind `Arc` so `McpState` stays
/// `Clone` (the writer is shared across all tool invocations).
#[derive(Clone)]
pub struct McpState {
    pub db: Db,
    pub sync: Option<Arc<SyncWriter>>,
    pub approvals: Option<ApprovalStore>,
    pub control: Option<ControlStore>,
    notify_path: Option<PathBuf>,
}

impl McpState {
    /// `notify_dir` is the **local** app-data directory — NOT the iCloud
    /// blob dir. The Tauri app watches `notify_dir/.mcp-notify`; if the
    /// sentinel were placed under the iCloud dir (which `db.data_dir`
    /// points to after migration), the watcher would never fire.
    pub fn new(db: Db, sync: Option<SyncWriter>, notify_dir: Option<&Path>) -> Self {
        let notify_path = notify_dir.map(|d| d.join(".mcp-notify"));
        Self {
            db,
            sync: sync.map(Arc::new),
            approvals: notify_dir.map(ApprovalStore::new),
            control: notify_dir.map(ControlStore::new),
            notify_path,
        }
    }

    /// Write a sentinel file so the running Tauri app can detect MCP
    /// writes and refresh its UI. Overwrites (never appends) — the file
    /// stays ~80 bytes regardless of how many writes occur.
    pub fn notify(&self, domain: &str, action: &str, id: &str) {
        let Some(path) = &self.notify_path else {
            return;
        };
        notify::write_sentinel(path, domain, action, id);
    }
}
