use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

use super::notify;

const DB_FILE_NAME: &str = "mcp-control.db";
const SESSION_STALE_AFTER_MS: i64 = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS: i64 = 15_000;
const MAX_ARGUMENTS_BYTES: usize = 1_048_576;

const MAIN_ACTIONS: &[&str] = &[
    "chat_with_book",
    "configure_speech",
    "control_ai_tasks",
    "control_app",
    "control_book_ocr",
    "control_openai_oauth",
    "control_sync",
    "delete_ai_credentials",
    "delete_ai_services",
    "generate_ai_material",
    "generate_book_intelligence",
    "get_ai_services",
    "get_ocr_state",
    "get_speech_state",
    "get_sync_status",
    "prepare_book_files",
    "remove_sync_peers",
    "request_custom_speech_audio",
    "run_ai_reading_action",
    "test_ai_service",
    "update_ai_credentials",
    "update_ai_services",
    "update_book_intelligence",
    "update_book_sources",
    "update_custom_fonts",
    "update_language_profile",
    "update_ocr_runtime",
];

const READER_ACTIONS: &[&str] = &["control_reader", "control_speech", "get_reader_context"];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOwner {
    Main,
    Reader,
}

impl RuntimeOwner {
    fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Reader => "reader",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "main" => Ok(Self::Main),
            "reader" => Ok(Self::Reader),
            other => Err(AppError::Other(format!(
                "MCP_CONTROL_INVALID_OWNER: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeRegistration {
    pub owner: RuntimeOwner,
    pub window_id: String,
    pub book_id: Option<String>,
    pub focused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeSessionHandle {
    pub id: String,
    pub token: String,
    pub owner: RuntimeOwner,
    pub window_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeSessionView {
    pub id: String,
    pub owner: RuntimeOwner,
    pub window_id: String,
    pub book_id: Option<String>,
    pub focused: bool,
    pub last_heartbeat_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlStatus {
    Pending,
    Claimed,
    Completed,
    Failed,
    Cancelled,
    Expired,
}

impl ControlStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "claimed" => Ok(Self::Claimed),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "expired" => Ok(Self::Expired),
            other => Err(AppError::Other(format!(
                "MCP_CONTROL_INVALID_STATUS: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ControlRequest {
    pub id: String,
    pub action: String,
    pub arguments: Value,
    pub target_window_id: Option<String>,
    pub status: ControlStatus,
    pub session_id: String,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub claimed_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ControlOutcome {
    Completed(Value),
    Failed(String),
    Cancelled,
    Expired,
}

#[derive(Debug, Clone)]
pub struct ControlStore {
    db_path: PathBuf,
    notify_path: PathBuf,
}

impl ControlStore {
    pub fn new(local_dir: &Path) -> Self {
        Self {
            db_path: local_dir.join(DB_FILE_NAME),
            notify_path: local_dir.join(".mcp-notify"),
        }
    }

    pub fn register(&self, registration: RuntimeRegistration) -> AppResult<RuntimeSessionHandle> {
        validate_registration(&registration)?;
        let id = uuid::Uuid::new_v4().to_string();
        let token = uuid::Uuid::new_v4().to_string();
        let token_hash = hash_token(&token);
        let now = now_ms();
        let conn = self.connection()?;
        conn.execute(
            "INSERT INTO runtime_sessions
             (id, token_hash, owner, window_id, book_id, focused, registered_at, last_heartbeat_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                id,
                token_hash,
                registration.owner.as_str(),
                registration.window_id,
                registration.book_id,
                registration.focused,
                now,
            ],
        )?;
        Ok(RuntimeSessionHandle {
            id,
            token,
            owner: registration.owner,
            window_id: registration.window_id,
        })
    }

    pub fn heartbeat(
        &self,
        id: &str,
        token: &str,
        book_id: Option<&str>,
        focused: bool,
    ) -> AppResult<()> {
        validate_identifier("session id", id)?;
        validate_identifier("session token", token)?;
        let conn = self.connection()?;
        authenticate_session(&conn, id, token)?;
        let changed = conn.execute(
            "UPDATE runtime_sessions
             SET book_id = ?1, focused = ?2, last_heartbeat_at = ?3
             WHERE id = ?4",
            params![book_id, focused, now_ms(), id],
        )?;
        if changed != 1 {
            return Err(AppError::Other(format!(
                "MCP_CONTROL_SESSION_NOT_FOUND: {id}"
            )));
        }
        Ok(())
    }

    pub fn unregister(&self, id: &str, token: &str) -> AppResult<()> {
        validate_identifier("session id", id)?;
        validate_identifier("session token", token)?;
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        authenticate_session(&tx, id, token)?;
        tx.execute(
            "UPDATE control_requests
             SET status = 'cancelled', error = 'runtime_session_closed', finished_at = ?1
             WHERE session_id = ?2 AND status IN ('pending', 'claimed')",
            params![now_ms(), id],
        )?;
        tx.execute("DELETE FROM runtime_sessions WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn list_live_sessions(&self, owner: RuntimeOwner) -> AppResult<Vec<RuntimeSessionView>> {
        self.list_live_sessions_at(owner, now_ms())
    }

    fn list_live_sessions_at(
        &self,
        owner: RuntimeOwner,
        now: i64,
    ) -> AppResult<Vec<RuntimeSessionView>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT id, owner, window_id, book_id, focused, last_heartbeat_at
             FROM runtime_sessions
             WHERE owner = ?1 AND last_heartbeat_at >= ?2
             ORDER BY focused DESC, last_heartbeat_at DESC, window_id ASC",
        )?;
        let rows = statement
            .query_map(
                params![owner.as_str(), now - SESSION_STALE_AFTER_MS],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, bool>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(
                |(id, owner, window_id, book_id, focused, last_heartbeat_at)| {
                    Ok(RuntimeSessionView {
                        id,
                        owner: RuntimeOwner::parse(&owner)?,
                        window_id,
                        book_id,
                        focused,
                        last_heartbeat_at,
                    })
                },
            )
            .collect()
    }

    pub fn enqueue(
        &self,
        owner: RuntimeOwner,
        action: &str,
        arguments: Value,
        target_window_id: Option<&str>,
        timeout: Option<Duration>,
    ) -> AppResult<ControlRequest> {
        validate_action(owner, action)?;
        validate_arguments(&arguments)?;
        if let Some(window_id) = target_window_id {
            validate_identifier("target window id", window_id)?;
        }
        let now = now_ms();
        let session = self.select_session(owner, target_window_id, now)?;
        let timeout_ms = timeout
            .map(|value| i64::try_from(value.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS)
            .clamp(1, 120_000);
        let request = ControlRequest {
            id: uuid::Uuid::new_v4().to_string(),
            action: action.to_string(),
            arguments,
            target_window_id: target_window_id.map(str::to_string),
            status: ControlStatus::Pending,
            session_id: session.id,
            result: None,
            error: None,
            created_at: now,
            expires_at: now.saturating_add(timeout_ms),
            claimed_at: None,
            finished_at: None,
        };
        let conn = self.connection()?;
        conn.execute(
            "INSERT INTO control_requests
             (id, action, arguments_json, target_window_id, status, session_id, result_json,
              error, created_at, expires_at, claimed_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5, NULL, NULL, ?6, ?7, NULL, NULL)",
            params![
                request.id,
                request.action,
                serde_json::to_string(&request.arguments).map_err(|error| {
                    AppError::Other(format!("serialize MCP control arguments: {error}"))
                })?,
                request.target_window_id,
                request.session_id,
                request.created_at,
                request.expires_at,
            ],
        )?;
        notify::write_sentinel(&self.notify_path, "control", "requested", &request.id);
        Ok(request)
    }

    pub async fn request(
        &self,
        owner: RuntimeOwner,
        action: &str,
        arguments: Value,
        target_window_id: Option<&str>,
        timeout: Option<Duration>,
    ) -> AppResult<ControlOutcome> {
        let request = self.enqueue(owner, action, arguments, target_window_id, timeout)?;
        loop {
            let current = self.get(&request.id)?;
            match current.status {
                ControlStatus::Pending | ControlStatus::Claimed => {
                    if now_ms() >= current.expires_at {
                        self.expire(&current.id)?;
                        return Ok(ControlOutcome::Expired);
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                }
                ControlStatus::Completed => {
                    return Ok(ControlOutcome::Completed(
                        current.result.unwrap_or(Value::Null),
                    ));
                }
                ControlStatus::Failed => {
                    return Ok(ControlOutcome::Failed(
                        current
                            .error
                            .unwrap_or_else(|| "runtime_failed".to_string()),
                    ));
                }
                ControlStatus::Cancelled => return Ok(ControlOutcome::Cancelled),
                ControlStatus::Expired => return Ok(ControlOutcome::Expired),
            }
        }
    }

    pub fn list_pending(&self, session_id: &str, token: &str) -> AppResult<Vec<ControlRequest>> {
        validate_identifier("session id", session_id)?;
        validate_identifier("session token", token)?;
        let conn = self.connection()?;
        authenticate_session(&conn, session_id, token)?;
        expire_due(&conn, now_ms())?;
        let mut statement = conn.prepare(
            "SELECT id, action, arguments_json, target_window_id, status, session_id,
                    result_json, error, created_at, expires_at, claimed_at, finished_at
             FROM control_requests
             WHERE session_id = ?1 AND status = 'pending'
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement
            .query_map(params![session_id], row_to_stored_request)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(StoredControlRequest::deserialize)
            .collect()
    }

    pub fn claim(
        &self,
        session_id: &str,
        token: &str,
        request_id: &str,
    ) -> AppResult<ControlRequest> {
        validate_identifier("request id", request_id)?;
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        authenticate_session(&tx, session_id, token)?;
        expire_due(&tx, now_ms())?;
        let claimed_at = now_ms();
        let changed = tx.execute(
            "UPDATE control_requests SET status = 'claimed', claimed_at = ?1
             WHERE id = ?2 AND session_id = ?3 AND status = 'pending'",
            params![claimed_at, request_id, session_id],
        )?;
        if changed != 1 {
            return Err(AppError::Other(format!(
                "MCP_CONTROL_CLAIM_REJECTED: {request_id}"
            )));
        }
        let request = get_with_connection(&tx, request_id)?;
        tx.commit()?;
        Ok(request)
    }

    pub fn complete(
        &self,
        session_id: &str,
        token: &str,
        request_id: &str,
        result: Value,
    ) -> AppResult<ControlRequest> {
        self.finish(
            session_id,
            token,
            request_id,
            ControlStatus::Completed,
            Some(result),
            None,
        )
    }

    pub fn fail(
        &self,
        session_id: &str,
        token: &str,
        request_id: &str,
        error: &str,
    ) -> AppResult<ControlRequest> {
        if error.trim().is_empty() || error.len() > 4_000 {
            return Err(AppError::Other(
                "MCP_CONTROL_INVALID_ERROR: expected 1..=4000 bytes".to_string(),
            ));
        }
        self.finish(
            session_id,
            token,
            request_id,
            ControlStatus::Failed,
            None,
            Some(error.to_string()),
        )
    }

    fn finish(
        &self,
        session_id: &str,
        token: &str,
        request_id: &str,
        status: ControlStatus,
        result: Option<Value>,
        error: Option<String>,
    ) -> AppResult<ControlRequest> {
        debug_assert!(matches!(
            status,
            ControlStatus::Completed | ControlStatus::Failed
        ));
        validate_identifier("request id", request_id)?;
        if let Some(result) = &result {
            validate_result(result)?;
        }
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        authenticate_session(&tx, session_id, token)?;
        let changed = tx.execute(
            "UPDATE control_requests
             SET status = ?1, result_json = ?2, error = ?3, finished_at = ?4
             WHERE id = ?5 AND session_id = ?6 AND status = 'claimed'",
            params![
                status.as_str(),
                result
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|serialize_error| AppError::Other(format!(
                        "serialize MCP control result: {serialize_error}"
                    )))?,
                error,
                now_ms(),
                request_id,
                session_id,
            ],
        )?;
        if changed != 1 {
            return Err(AppError::Other(format!(
                "MCP_CONTROL_COMPLETION_REJECTED: {request_id}"
            )));
        }
        let request = get_with_connection(&tx, request_id)?;
        tx.commit()?;
        Ok(request)
    }

    pub fn get(&self, request_id: &str) -> AppResult<ControlRequest> {
        validate_identifier("request id", request_id)?;
        let conn = self.connection()?;
        expire_due(&conn, now_ms())?;
        get_with_connection(&conn, request_id)
    }

    fn expire(&self, request_id: &str) -> AppResult<()> {
        let conn = self.connection()?;
        conn.execute(
            "UPDATE control_requests
             SET status = 'expired', error = 'runtime_timeout', finished_at = ?1
             WHERE id = ?2 AND status IN ('pending', 'claimed')",
            params![now_ms(), request_id],
        )?;
        Ok(())
    }

    fn select_session(
        &self,
        owner: RuntimeOwner,
        target_window_id: Option<&str>,
        now: i64,
    ) -> AppResult<RuntimeSessionView> {
        let sessions = self.list_live_sessions_at(owner, now)?;
        if let Some(window_id) = target_window_id {
            return sessions
                .into_iter()
                .find(|session| session.window_id == window_id)
                .ok_or_else(|| {
                    AppError::Other(format!("MCP_CONTROL_TARGET_NOT_RUNNING: {window_id}"))
                });
        }
        if sessions.is_empty() {
            return Err(AppError::Other(match owner {
                RuntimeOwner::Main => "MCP_CONTROL_APP_NOT_RUNNING".to_string(),
                RuntimeOwner::Reader => "MCP_CONTROL_READER_NOT_RUNNING".to_string(),
            }));
        }
        let focused = sessions
            .iter()
            .filter(|session| session.focused)
            .collect::<Vec<_>>();
        if focused.len() == 1 {
            return Ok(focused[0].clone());
        }
        if sessions.len() == 1 {
            return Ok(sessions[0].clone());
        }
        Err(AppError::Other(format!(
            "MCP_CONTROL_AMBIGUOUS_TARGET: {} live {} windows",
            sessions.len(),
            owner.as_str()
        )))
    }

    fn connection(&self) -> AppResult<Connection> {
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&self.db_path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS runtime_sessions (
                 id TEXT PRIMARY KEY NOT NULL,
                 token_hash TEXT NOT NULL,
                 owner TEXT NOT NULL CHECK (owner IN ('main', 'reader')),
                 window_id TEXT NOT NULL,
                 book_id TEXT,
                 focused INTEGER NOT NULL,
                 registered_at INTEGER NOT NULL,
                 last_heartbeat_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_runtime_sessions_owner_heartbeat
             ON runtime_sessions(owner, last_heartbeat_at);
             CREATE TABLE IF NOT EXISTS control_requests (
                 id TEXT PRIMARY KEY NOT NULL,
                 action TEXT NOT NULL,
                 arguments_json TEXT NOT NULL,
                 target_window_id TEXT,
                 status TEXT NOT NULL CHECK (
                     status IN ('pending', 'claimed', 'completed', 'failed', 'cancelled', 'expired')
                 ),
                 session_id TEXT NOT NULL,
                 result_json TEXT,
                 error TEXT,
                 created_at INTEGER NOT NULL,
                 expires_at INTEGER NOT NULL,
                 claimed_at INTEGER,
                 finished_at INTEGER
             );
             CREATE INDEX IF NOT EXISTS idx_control_requests_session_status_time
             ON control_requests(session_id, status, created_at);",
        )?;
        Ok(conn)
    }
}

#[derive(Debug)]
struct StoredControlRequest {
    id: String,
    action: String,
    arguments_json: String,
    target_window_id: Option<String>,
    status: String,
    session_id: String,
    result_json: Option<String>,
    error: Option<String>,
    created_at: i64,
    expires_at: i64,
    claimed_at: Option<i64>,
    finished_at: Option<i64>,
}

impl StoredControlRequest {
    fn deserialize(self) -> AppResult<ControlRequest> {
        Ok(ControlRequest {
            id: self.id,
            action: self.action,
            arguments: serde_json::from_str(&self.arguments_json).map_err(|error| {
                AppError::Other(format!("MCP_CONTROL_CORRUPT_ARGUMENTS: {error}"))
            })?,
            target_window_id: self.target_window_id,
            status: ControlStatus::parse(&self.status)?,
            session_id: self.session_id,
            result: self
                .result_json
                .map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(|error| AppError::Other(format!("MCP_CONTROL_CORRUPT_RESULT: {error}")))?,
            error: self.error,
            created_at: self.created_at,
            expires_at: self.expires_at,
            claimed_at: self.claimed_at,
            finished_at: self.finished_at,
        })
    }
}

fn row_to_stored_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredControlRequest> {
    Ok(StoredControlRequest {
        id: row.get(0)?,
        action: row.get(1)?,
        arguments_json: row.get(2)?,
        target_window_id: row.get(3)?,
        status: row.get(4)?,
        session_id: row.get(5)?,
        result_json: row.get(6)?,
        error: row.get(7)?,
        created_at: row.get(8)?,
        expires_at: row.get(9)?,
        claimed_at: row.get(10)?,
        finished_at: row.get(11)?,
    })
}

fn get_with_connection(conn: &Connection, request_id: &str) -> AppResult<ControlRequest> {
    conn.query_row(
        "SELECT id, action, arguments_json, target_window_id, status, session_id,
                result_json, error, created_at, expires_at, claimed_at, finished_at
         FROM control_requests WHERE id = ?1",
        params![request_id],
        row_to_stored_request,
    )
    .optional()?
    .ok_or_else(|| AppError::Other(format!("MCP_CONTROL_REQUEST_NOT_FOUND: {request_id}")))?
    .deserialize()
}

fn expire_due(conn: &Connection, now: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE control_requests
         SET status = 'expired', error = 'runtime_timeout', finished_at = ?1
         WHERE expires_at <= ?1 AND status IN ('pending', 'claimed')",
        params![now],
    )?;
    Ok(())
}

fn authenticate_session(conn: &Connection, id: &str, token: &str) -> AppResult<()> {
    let expected = conn
        .query_row(
            "SELECT token_hash FROM runtime_sessions WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| AppError::Other(format!("MCP_CONTROL_SESSION_NOT_FOUND: {id}")))?;
    if expected != hash_token(token) {
        return Err(AppError::Other(
            "MCP_CONTROL_AUTHENTICATION_FAILED".to_string(),
        ));
    }
    Ok(())
}

fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    format!("{digest:x}")
}

fn validate_registration(registration: &RuntimeRegistration) -> AppResult<()> {
    validate_identifier("window id", &registration.window_id)?;
    if let Some(book_id) = &registration.book_id {
        validate_identifier("book id", book_id)?;
    }
    match registration.owner {
        RuntimeOwner::Main if registration.book_id.is_some() => Err(AppError::Other(
            "MCP_CONTROL_INVALID_REGISTRATION: main session cannot own a book".to_string(),
        )),
        RuntimeOwner::Reader if registration.book_id.is_none() => Err(AppError::Other(
            "MCP_CONTROL_INVALID_REGISTRATION: reader session requires a book".to_string(),
        )),
        _ => Ok(()),
    }
}

fn validate_action(owner: RuntimeOwner, action: &str) -> AppResult<()> {
    let allowed = match owner {
        RuntimeOwner::Main => MAIN_ACTIONS,
        RuntimeOwner::Reader => READER_ACTIONS,
    };
    if !allowed.contains(&action) {
        return Err(AppError::Other(format!(
            "MCP_CONTROL_ACTION_NOT_ALLOWED: {action} for {}",
            owner.as_str()
        )));
    }
    Ok(())
}

fn validate_arguments(arguments: &Value) -> AppResult<()> {
    if !arguments.is_object() {
        return Err(AppError::Other(
            "MCP_CONTROL_INVALID_ARGUMENTS: expected an object".to_string(),
        ));
    }
    let len = serde_json::to_vec(arguments)
        .map_err(|error| AppError::Other(format!("serialize MCP control arguments: {error}")))?
        .len();
    if len > MAX_ARGUMENTS_BYTES {
        return Err(AppError::Other(format!(
            "MCP_CONTROL_ARGUMENTS_TOO_LARGE: {len} bytes"
        )));
    }
    Ok(())
}

fn validate_result(result: &Value) -> AppResult<()> {
    let len = serde_json::to_vec(result)
        .map_err(|error| AppError::Other(format!("serialize MCP control result: {error}")))?
        .len();
    if len > MAX_ARGUMENTS_BYTES {
        return Err(AppError::Other(format!(
            "MCP_CONTROL_RESULT_TOO_LARGE: {len} bytes"
        )));
    }
    Ok(())
}

fn validate_identifier(name: &str, value: &str) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(AppError::Other(format!(
            "MCP_CONTROL_INVALID_IDENTIFIER: {name}"
        )));
    }
    Ok(())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;

    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    fn store() -> (TempDir, ControlStore) {
        let dir = TempDir::new().unwrap();
        let store = ControlStore::new(dir.path());
        (dir, store)
    }

    fn register_main(store: &ControlStore) -> RuntimeSessionHandle {
        store
            .register(RuntimeRegistration {
                owner: RuntimeOwner::Main,
                window_id: "main".to_string(),
                book_id: None,
                focused: true,
            })
            .unwrap()
    }

    fn register_reader(
        store: &ControlStore,
        window_id: &str,
        book_id: &str,
        focused: bool,
    ) -> RuntimeSessionHandle {
        store
            .register(RuntimeRegistration {
                owner: RuntimeOwner::Reader,
                window_id: window_id.to_string(),
                book_id: Some(book_id.to_string()),
                focused,
            })
            .unwrap()
    }

    #[test]
    fn app_absent_returns_structured_error() {
        let (_dir, store) = store();
        let error = store
            .enqueue(
                RuntimeOwner::Main,
                "control_app",
                json!({ "action": "focus" }),
                None,
                None,
            )
            .unwrap_err();
        assert!(error.to_string().contains("MCP_CONTROL_APP_NOT_RUNNING"));
    }

    #[test]
    fn stale_session_is_not_selected() {
        let (_dir, store) = store();
        let session = register_main(&store);
        let conn = store.connection().unwrap();
        conn.execute(
            "UPDATE runtime_sessions SET last_heartbeat_at = ?1 WHERE id = ?2",
            params![now_ms() - SESSION_STALE_AFTER_MS - 1, session.id],
        )
        .unwrap();
        let error = store
            .enqueue(
                RuntimeOwner::Main,
                "control_app",
                json!({ "action": "focus" }),
                None,
                None,
            )
            .unwrap_err();
        assert!(error.to_string().contains("MCP_CONTROL_APP_NOT_RUNNING"));
    }

    #[test]
    fn one_reader_is_selected_without_focus() {
        let (_dir, store) = store();
        let reader = register_reader(&store, "reader-book-a", "book-a", false);
        let request = store
            .enqueue(
                RuntimeOwner::Reader,
                "get_reader_context",
                json!({}),
                None,
                None,
            )
            .unwrap();
        assert_eq!(request.session_id, reader.id);
    }

    #[test]
    fn focused_reader_wins_and_explicit_window_overrides() {
        let (_dir, store) = store();
        let first = register_reader(&store, "reader-book-a", "book-a", false);
        let focused = register_reader(&store, "reader-book-b", "book-b", true);
        let default_request = store
            .enqueue(
                RuntimeOwner::Reader,
                "get_reader_context",
                json!({}),
                None,
                None,
            )
            .unwrap();
        assert_eq!(default_request.session_id, focused.id);

        let explicit = store
            .enqueue(
                RuntimeOwner::Reader,
                "get_reader_context",
                json!({}),
                Some("reader-book-a"),
                None,
            )
            .unwrap();
        assert_eq!(explicit.session_id, first.id);
    }

    #[test]
    fn multiple_unfocused_readers_are_ambiguous() {
        let (_dir, store) = store();
        register_reader(&store, "reader-book-a", "book-a", false);
        register_reader(&store, "reader-book-b", "book-b", false);
        let error = store
            .enqueue(
                RuntimeOwner::Reader,
                "control_reader",
                json!({ "action": "next_page" }),
                None,
                None,
            )
            .unwrap_err();
        assert!(error.to_string().contains("MCP_CONTROL_AMBIGUOUS_TARGET"));
    }

    #[test]
    fn wrong_owner_and_unlisted_actions_are_rejected() {
        let (_dir, store) = store();
        register_main(&store);
        let error = store
            .enqueue(
                RuntimeOwner::Main,
                "get_reader_context",
                json!({}),
                None,
                None,
            )
            .unwrap_err();
        assert!(error.to_string().contains("MCP_CONTROL_ACTION_NOT_ALLOWED"));
    }

    #[test]
    fn claim_is_atomic_across_competing_consumers() {
        let (_dir, store) = store();
        let session = register_main(&store);
        let request = store
            .enqueue(
                RuntimeOwner::Main,
                "control_app",
                json!({ "action": "focus" }),
                None,
                None,
            )
            .unwrap();
        let store = Arc::new(store);
        let barrier = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            let session_id = session.id.clone();
            let token = session.token.clone();
            let request_id = request.id.clone();
            handles.push(thread::spawn(move || {
                barrier.wait();
                store.claim(&session_id, &token, &request_id).is_ok()
            }));
        }
        barrier.wait();
        let successes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|success| *success)
            .count();
        assert_eq!(successes, 1);
    }

    #[test]
    fn completion_is_bound_to_claiming_session() {
        let (_dir, store) = store();
        let owner = register_main(&store);
        let other = store
            .register(RuntimeRegistration {
                owner: RuntimeOwner::Main,
                window_id: "other-main".to_string(),
                book_id: None,
                focused: false,
            })
            .unwrap();
        let request = store
            .enqueue(
                RuntimeOwner::Main,
                "control_app",
                json!({ "action": "focus" }),
                Some("main"),
                None,
            )
            .unwrap();
        store.claim(&owner.id, &owner.token, &request.id).unwrap();
        let error = store
            .complete(&other.id, &other.token, &request.id, json!({ "ok": true }))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("MCP_CONTROL_COMPLETION_REJECTED"));
        let completed = store
            .complete(&owner.id, &owner.token, &request.id, json!({ "ok": true }))
            .unwrap();
        assert_eq!(completed.status, ControlStatus::Completed);
    }

    #[tokio::test]
    async fn request_expires_when_runtime_does_not_claim_it() {
        let (_dir, store) = store();
        register_main(&store);
        let outcome = store
            .request(
                RuntimeOwner::Main,
                "control_app",
                json!({ "action": "focus" }),
                None,
                Some(Duration::from_millis(20)),
            )
            .await
            .unwrap();
        assert_eq!(outcome, ControlOutcome::Expired);
    }

    #[test]
    fn invalid_token_cannot_list_or_claim() {
        let (_dir, store) = store();
        let session = register_main(&store);
        let request = store
            .enqueue(
                RuntimeOwner::Main,
                "control_app",
                json!({ "action": "focus" }),
                None,
                None,
            )
            .unwrap();
        assert!(store.list_pending(&session.id, "wrong").is_err());
        assert!(store.claim(&session.id, "wrong", &request.id).is_err());
    }
}
