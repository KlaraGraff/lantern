use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

use super::notify;

const DB_FILE_NAME: &str = "mcp-control.db";
const MAX_ACTION_LEN: usize = 128;
const MAX_TEXT_LEN: usize = 2_000;
const MAX_ARGUMENTS_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
}

/// Where the confirmation is presented.  A native MCP confirmation must never
/// also surface in the Lantern window, or users would be asked twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApprovalChannel {
    Application,
    Mrtr,
}

impl ApprovalChannel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Application => "application",
            Self::Mrtr => "mrtr",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "application" => Ok(Self::Application),
            "mrtr" => Ok(Self::Mrtr),
            other => Err(AppError::Other(format!(
                "MCP_APPROVAL_INVALID_CHANNEL: {other}"
            ))),
        }
    }
}

impl ApprovalStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            other => Err(AppError::Other(format!(
                "MCP_APPROVAL_INVALID_STATUS: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "risk", rename_all = "snake_case")]
pub enum ApprovalConfirmation {
    IrreversibleData { effect: String, scope: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApprovalRequestInput {
    pub action: String,
    pub confirmation: ApprovalConfirmation,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApprovalRequest {
    pub id: String,
    pub action: String,
    pub confirmation: ApprovalConfirmation,
    #[serde(skip_serializing)]
    pub arguments: Value,
    pub status: ApprovalStatus,
    pub requested_at: i64,
    pub resolved_at: Option<i64>,
    pub consumed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalGateOutcome {
    Pending(ApprovalRequest),
    Execute(ApprovalRequest),
    Rejected(ApprovalRequest),
}

#[derive(Debug)]
struct StoredRequest {
    id: String,
    action: String,
    confirmation_json: String,
    arguments_json: String,
    status: String,
    requested_at: i64,
    resolved_at: Option<i64>,
    consumed_at: Option<i64>,
    channel: String,
}

impl StoredRequest {
    fn deserialize(self) -> AppResult<ApprovalRequest> {
        // Validate the persisted value even though callers never need to see
        // the transport-specific channel.
        ApprovalChannel::parse(&self.channel)?;
        let confirmation = serde_json::from_str(&self.confirmation_json).map_err(|error| {
            AppError::Other(format!(
                "MCP_APPROVAL_CORRUPT_CONFIRMATION {}: {error}",
                self.id
            ))
        })?;
        let arguments = serde_json::from_str(&self.arguments_json).map_err(|error| {
            AppError::Other(format!(
                "MCP_APPROVAL_CORRUPT_ARGUMENTS {}: {error}",
                self.id
            ))
        })?;
        Ok(ApprovalRequest {
            id: self.id,
            action: self.action,
            confirmation,
            arguments,
            status: ApprovalStatus::parse(&self.status)?,
            requested_at: self.requested_at,
            resolved_at: self.resolved_at,
            consumed_at: self.consumed_at,
        })
    }
}

#[derive(Debug, Clone)]
pub struct ApprovalStore {
    db_path: PathBuf,
    notify_path: PathBuf,
}

impl ApprovalStore {
    pub fn new(local_dir: &Path) -> Self {
        Self {
            db_path: local_dir.join(DB_FILE_NAME),
            notify_path: local_dir.join(".mcp-notify"),
        }
    }

    #[cfg(test)]
    fn request(&self, input: ApprovalRequestInput) -> AppResult<ApprovalRequest> {
        self.request_with_channel(input, ApprovalChannel::Application)
    }

    #[cfg(test)]
    fn request_interactive(&self, input: ApprovalRequestInput) -> AppResult<ApprovalRequest> {
        self.request_with_channel(input, ApprovalChannel::Mrtr)
    }

    #[cfg(test)]
    fn request_with_channel(
        &self,
        input: ApprovalRequestInput,
        channel: ApprovalChannel,
    ) -> AppResult<ApprovalRequest> {
        validate_input(&input)?;

        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(request) = find_active_bound(&tx, &input, channel)? {
            tx.commit()?;
            return Ok(request);
        }
        let request = insert_request(&tx, input, channel)?;
        tx.commit()?;
        if channel == ApprovalChannel::Application {
            notify::write_sentinel(&self.notify_path, "approvals", "requested", &request.id);
        }
        Ok(request)
    }

    /// Prepare an app-mediated confirmation. An approved request is atomically
    /// consumed, so the same app decision can never authorize a replay.
    pub fn claim_application(&self, input: ApprovalRequestInput) -> AppResult<ApprovalGateOutcome> {
        self.claim(input, ApprovalChannel::Application)
    }

    /// Prepare a native MCP confirmation without making it visible to the
    /// Lantern application.
    pub fn claim_mrtr(&self, input: ApprovalRequestInput) -> AppResult<ApprovalGateOutcome> {
        self.claim(input, ApprovalChannel::Mrtr)
    }

    fn claim(
        &self,
        input: ApprovalRequestInput,
        channel: ApprovalChannel,
    ) -> AppResult<ApprovalGateOutcome> {
        validate_input(&input)?;
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (request, created) = match find_active_bound(&tx, &input, channel)? {
            Some(request) => (request, false),
            None => (insert_request(&tx, input, channel)?, true),
        };
        let outcome = match request.status {
            ApprovalStatus::Pending => ApprovalGateOutcome::Pending(request),
            ApprovalStatus::Approved => {
                let request = consume_with_connection(&tx, request)?;
                ApprovalGateOutcome::Execute(request)
            }
            ApprovalStatus::Rejected => {
                let request = consume_with_connection(&tx, request)?;
                ApprovalGateOutcome::Rejected(request)
            }
        };
        tx.commit()?;
        if created && channel == ApprovalChannel::Application {
            if let ApprovalGateOutcome::Pending(request) = &outcome {
                notify::write_sentinel(&self.notify_path, "approvals", "requested", &request.id);
            }
        }
        Ok(outcome)
    }

    /// Resolve an MRTR response and consume the decision in the same SQLite
    /// transaction. The echoed handle is useful only for the exact original
    /// tool name and complete argument object.
    pub fn complete_interactive(
        &self,
        id: &str,
        action: &str,
        arguments: &Value,
        accepted: bool,
    ) -> AppResult<ApprovalGateOutcome> {
        validate_id(id)?;
        validate_text("action", action, MAX_ACTION_LEN)?;
        if !arguments.is_object() {
            return Err(AppError::Other(
                "MCP_APPROVAL_INVALID_ARGUMENTS: expected an object".to_string(),
            ));
        }

        let now = chrono::Utc::now().timestamp_millis();
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let request = get_with_connection(&tx, id)?;
        ensure_bound(&request, action, arguments)?;
        ensure_channel(&tx, id, ApprovalChannel::Mrtr)?;
        if request.consumed_at.is_some() {
            return Err(AppError::Other(format!(
                "MCP_APPROVAL_ALREADY_CONSUMED: {id}"
            )));
        }

        let accepted = accepted && request.status != ApprovalStatus::Rejected;
        let status = if accepted {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Rejected
        };
        let changed = tx.execute(
            "UPDATE approval_requests
             SET status = ?1, resolved_at = COALESCE(resolved_at, ?2), consumed_at = ?2
             WHERE id = ?3 AND consumed_at IS NULL",
            params![status.as_str(), now, id],
        )?;
        if changed != 1 {
            return Err(AppError::Other(format!(
                "MCP_APPROVAL_ALREADY_CONSUMED: {id}"
            )));
        }
        let request = get_with_connection(&tx, id)?;
        tx.commit()?;
        Ok(if accepted {
            ApprovalGateOutcome::Execute(request)
        } else {
            ApprovalGateOutcome::Rejected(request)
        })
    }

    pub fn get(&self, id: &str) -> AppResult<ApprovalRequest> {
        validate_id(id)?;
        let conn = self.connection()?;
        let stored = conn
            .query_row(
                &format!("SELECT {REQUEST_COLUMNS} FROM approval_requests WHERE id = ?1"),
                params![id],
                row_to_stored,
            )
            .optional()?
            .ok_or_else(|| AppError::Other(format!("MCP_APPROVAL_NOT_FOUND: {id}")))?;
        stored.deserialize()
    }

    pub fn list_pending(&self) -> AppResult<Vec<ApprovalRequest>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare(&format!(
            "SELECT {REQUEST_COLUMNS}
             FROM approval_requests
             WHERE status = 'pending' AND consumed_at IS NULL AND channel = 'application'
             ORDER BY requested_at ASC, id ASC",
        ))?;
        let rows = statement
            .query_map([], row_to_stored)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(StoredRequest::deserialize).collect()
    }

    pub fn approve(&self, id: &str) -> AppResult<ApprovalRequest> {
        self.resolve(id, ApprovalStatus::Approved)
    }

    pub fn reject(&self, id: &str) -> AppResult<ApprovalRequest> {
        self.resolve(id, ApprovalStatus::Rejected)
    }

    fn resolve(&self, id: &str, target: ApprovalStatus) -> AppResult<ApprovalRequest> {
        validate_id(id)?;
        debug_assert!(target != ApprovalStatus::Pending);
        let resolved_at = chrono::Utc::now().timestamp_millis();
        let conn = self.connection()?;
        ensure_channel(&conn, id, ApprovalChannel::Application)?;
        let changed = conn.execute(
            "UPDATE approval_requests
             SET status = ?1, resolved_at = ?2
             WHERE id = ?3 AND status = 'pending' AND consumed_at IS NULL",
            params![target.as_str(), resolved_at, id],
        )?;

        let request = self.get_with_connection(&conn, id)?;
        if request.consumed_at.is_some() {
            return Err(AppError::Other(format!(
                "MCP_APPROVAL_ALREADY_CONSUMED: {id}"
            )));
        }
        if changed == 0 && request.status != target {
            return Err(AppError::Other(format!(
                "MCP_APPROVAL_ALREADY_RESOLVED: {id} is {}",
                request.status.as_str()
            )));
        }
        notify::write_sentinel(&self.notify_path, "approvals", target.as_str(), &request.id);
        Ok(request)
    }

    fn get_with_connection(&self, conn: &Connection, id: &str) -> AppResult<ApprovalRequest> {
        conn.query_row(
            &format!("SELECT {REQUEST_COLUMNS} FROM approval_requests WHERE id = ?1"),
            params![id],
            row_to_stored,
        )
        .optional()?
        .ok_or_else(|| AppError::Other(format!("MCP_APPROVAL_NOT_FOUND: {id}")))?
        .deserialize()
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
             CREATE TABLE IF NOT EXISTS approval_requests (
                 id TEXT PRIMARY KEY NOT NULL,
                 action TEXT NOT NULL,
                 confirmation_json TEXT NOT NULL,
                 arguments_json TEXT NOT NULL,
                 channel TEXT NOT NULL CHECK (channel IN ('application', 'mrtr')),
                 status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
                 requested_at INTEGER NOT NULL,
                 resolved_at INTEGER,
                 consumed_at INTEGER
             );
             CREATE INDEX IF NOT EXISTS idx_approval_requests_status_time
             ON approval_requests(status, requested_at);",
        )?;
        Ok(conn)
    }
}

/// The `approval_requests` columns `row_to_stored` reads, named once so the
/// five queries that feed it cannot drift apart.
const REQUEST_COLUMNS: &str = "id, action, confirmation_json, arguments_json, status, requested_at, resolved_at, consumed_at, channel";

fn row_to_stored(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRequest> {
    Ok(StoredRequest {
        id: row.get("id")?,
        action: row.get("action")?,
        confirmation_json: row.get("confirmation_json")?,
        arguments_json: row.get("arguments_json")?,
        status: row.get("status")?,
        requested_at: row.get("requested_at")?,
        resolved_at: row.get("resolved_at")?,
        consumed_at: row.get("consumed_at")?,
        channel: row.get("channel")?,
    })
}

fn insert_request(
    conn: &Connection,
    input: ApprovalRequestInput,
    channel: ApprovalChannel,
) -> AppResult<ApprovalRequest> {
    let id = uuid::Uuid::new_v4().to_string();
    let requested_at = chrono::Utc::now().timestamp_millis();
    let confirmation_json = serde_json::to_string(&input.confirmation)
        .map_err(|error| AppError::Other(format!("serialize MCP approval: {error}")))?;
    let arguments_json = serde_json::to_string(&input.arguments)
        .map_err(|error| AppError::Other(format!("serialize MCP action arguments: {error}")))?;
    conn.execute(
        "INSERT INTO approval_requests
         (id, action, confirmation_json, arguments_json, channel, status, requested_at, resolved_at,
          consumed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, NULL, NULL)",
        params![
            id,
            input.action,
            confirmation_json,
            arguments_json,
            channel.as_str(),
            requested_at
        ],
    )?;
    Ok(ApprovalRequest {
        id,
        action: input.action,
        confirmation: input.confirmation,
        arguments: input.arguments,
        status: ApprovalStatus::Pending,
        requested_at,
        resolved_at: None,
        consumed_at: None,
    })
}

fn find_active_bound(
    conn: &Connection,
    input: &ApprovalRequestInput,
    channel: ApprovalChannel,
) -> AppResult<Option<ApprovalRequest>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {REQUEST_COLUMNS}
         FROM approval_requests
         WHERE action = ?1 AND channel = ?2 AND consumed_at IS NULL
         ORDER BY requested_at DESC, id DESC",
    ))?;
    let requests = statement
        .query_map(params![input.action, channel.as_str()], row_to_stored)?
        .collect::<Result<Vec<_>, _>>()?;
    for stored in requests {
        let request = stored.deserialize()?;
        if request.arguments == input.arguments && request.confirmation == input.confirmation {
            return Ok(Some(request));
        }
    }
    Ok(None)
}

fn get_with_connection(conn: &Connection, id: &str) -> AppResult<ApprovalRequest> {
    conn.query_row(
        &format!("SELECT {REQUEST_COLUMNS} FROM approval_requests WHERE id = ?1"),
        params![id],
        row_to_stored,
    )
    .optional()?
    .ok_or_else(|| AppError::Other(format!("MCP_APPROVAL_NOT_FOUND: {id}")))?
    .deserialize()
}

fn ensure_bound(request: &ApprovalRequest, action: &str, arguments: &Value) -> AppResult<()> {
    if request.action != action || request.arguments != *arguments {
        return Err(AppError::Other(
            "MCP_APPROVAL_BINDING_MISMATCH: tool name or arguments changed".to_string(),
        ));
    }
    Ok(())
}

fn ensure_channel(conn: &Connection, id: &str, expected: ApprovalChannel) -> AppResult<()> {
    let actual = conn
        .query_row(
            "SELECT channel FROM approval_requests WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| AppError::Other(format!("MCP_APPROVAL_NOT_FOUND: {id}")))?;
    if ApprovalChannel::parse(&actual)? != expected {
        return Err(AppError::Other(
            "MCP_APPROVAL_CHANNEL_MISMATCH: confirmation belongs to another client".to_string(),
        ));
    }
    Ok(())
}

fn consume_with_connection(
    conn: &Connection,
    mut request: ApprovalRequest,
) -> AppResult<ApprovalRequest> {
    let consumed_at = chrono::Utc::now().timestamp_millis();
    let changed = conn.execute(
        "UPDATE approval_requests SET consumed_at = ?1
         WHERE id = ?2 AND consumed_at IS NULL",
        params![consumed_at, request.id],
    )?;
    if changed != 1 {
        return Err(AppError::Other(format!(
            "MCP_APPROVAL_ALREADY_CONSUMED: {}",
            request.id
        )));
    }
    request.consumed_at = Some(consumed_at);
    Ok(request)
}

fn validate_input(input: &ApprovalRequestInput) -> AppResult<()> {
    validate_text("action", &input.action, MAX_ACTION_LEN)?;
    if !input.arguments.is_object() {
        return Err(AppError::Other(
            "MCP_APPROVAL_INVALID_ARGUMENTS: expected an object".to_string(),
        ));
    }
    let arguments_len = serde_json::to_vec(&input.arguments)
        .map_err(|error| AppError::Other(format!("serialize MCP action arguments: {error}")))?
        .len();
    if arguments_len > MAX_ARGUMENTS_BYTES {
        return Err(AppError::Other(format!(
            "MCP_APPROVAL_ARGUMENTS_TOO_LARGE: {arguments_len} bytes"
        )));
    }

    let ApprovalConfirmation::IrreversibleData { effect, scope } = &input.confirmation;
    validate_text("effect", effect, MAX_TEXT_LEN)?;
    validate_text("scope", scope, MAX_TEXT_LEN)?;
    Ok(())
}

fn validate_text(name: &str, value: &str, maximum_len: usize) -> AppResult<()> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::Other(format!(
            "MCP_APPROVAL_INVALID_{name}: value is empty"
        )));
    }
    if value.chars().count() > maximum_len {
        return Err(AppError::Other(format!(
            "MCP_APPROVAL_INVALID_{name}: exceeds {maximum_len} characters"
        )));
    }
    Ok(())
}

fn validate_id(id: &str) -> AppResult<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| AppError::Other(format!("MCP_APPROVAL_INVALID_ID: {id}")))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    fn irreversible_input() -> ApprovalRequestInput {
        ApprovalRequestInput {
            action: "library.delete_book".to_string(),
            confirmation: ApprovalConfirmation::IrreversibleData {
                effect: "Permanently delete the book file and its reading data.".to_string(),
                scope: "One book: Test Book".to_string(),
            },
            arguments: json!({ "book_id": "book-1" }),
        }
    }

    #[test]
    fn request_persists_and_is_visible_from_another_store() {
        let dir = TempDir::new().unwrap();
        let subprocess_store = ApprovalStore::new(dir.path());
        let request = subprocess_store.request(irreversible_input()).unwrap();

        let app_store = ApprovalStore::new(dir.path());
        assert_eq!(app_store.get(&request.id).unwrap(), request);
        assert_eq!(app_store.list_pending().unwrap(), vec![request.clone()]);

        let sentinel: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp-notify")).unwrap())
                .unwrap();
        assert_eq!(sentinel["domain"], "approvals");
        assert_eq!(sentinel["action"], "requested");
        assert_eq!(sentinel["id"], request.id);
    }

    #[test]
    fn approving_is_idempotent_but_cannot_reverse_a_decision() {
        let dir = TempDir::new().unwrap();
        let store = ApprovalStore::new(dir.path());
        let request = store.request(irreversible_input()).unwrap();

        let approved = store.approve(&request.id).unwrap();
        assert_eq!(approved.status, ApprovalStatus::Approved);
        assert!(approved.resolved_at.is_some());
        assert_eq!(store.approve(&request.id).unwrap(), approved);

        let error = store.reject(&request.id).unwrap_err();
        assert!(error.to_string().contains("MCP_APPROVAL_ALREADY_RESOLVED"));
        assert!(store.list_pending().unwrap().is_empty());
    }

    #[test]
    fn concurrent_opposite_decisions_allow_exactly_one_transition() {
        let dir = TempDir::new().unwrap();
        let store = ApprovalStore::new(dir.path());
        let request = store.request(irreversible_input()).unwrap();
        let barrier = Arc::new(Barrier::new(3));

        let approve_store = store.clone();
        let approve_id = request.id.clone();
        let approve_barrier = Arc::clone(&barrier);
        let approve = std::thread::spawn(move || {
            approve_barrier.wait();
            approve_store.approve(&approve_id)
        });

        let reject_store = store.clone();
        let reject_id = request.id.clone();
        let reject_barrier = Arc::clone(&barrier);
        let reject = std::thread::spawn(move || {
            reject_barrier.wait();
            reject_store.reject(&reject_id)
        });

        barrier.wait();
        let results = [approve.join().unwrap(), reject.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);

        let final_status = store.get(&request.id).unwrap().status;
        assert!(matches!(
            final_status,
            ApprovalStatus::Approved | ApprovalStatus::Rejected
        ));
    }

    #[test]
    fn rejects_unstructured_action_arguments() {
        let dir = TempDir::new().unwrap();
        let store = ApprovalStore::new(dir.path());
        let mut input = irreversible_input();
        input.arguments = json!(["book-1"]);

        let error = store.request(input).unwrap_err();
        assert!(error.to_string().contains("MCP_APPROVAL_INVALID_ARGUMENTS"));
    }

    #[test]
    fn legacy_approval_is_bound_and_consumed_once() {
        let dir = TempDir::new().unwrap();
        let store = ApprovalStore::new(dir.path());
        let input = irreversible_input();
        let request = store.request(input.clone()).unwrap();
        store.approve(&request.id).unwrap();

        let claimed = store.claim_application(input.clone()).unwrap();
        let ApprovalGateOutcome::Execute(claimed) = claimed else {
            panic!("approved request should execute");
        };
        assert_eq!(claimed.id, request.id);
        assert!(claimed.consumed_at.is_some());

        let next = store.claim_application(input).unwrap();
        let ApprovalGateOutcome::Pending(next) = next else {
            panic!("consumed approval must not authorize a replay");
        };
        assert_ne!(next.id, request.id);
    }

    #[test]
    fn interactive_approval_rejects_tampering_and_replay() {
        let dir = TempDir::new().unwrap();
        let store = ApprovalStore::new(dir.path());
        let input = irreversible_input();
        let request = store.request_interactive(input.clone()).unwrap();

        let error = store
            .complete_interactive(
                &request.id,
                &input.action,
                &json!({ "book_id": "different-book" }),
                true,
            )
            .unwrap_err();
        assert!(error.to_string().contains("MCP_APPROVAL_BINDING_MISMATCH"));
        assert_eq!(
            store.get(&request.id).unwrap().status,
            ApprovalStatus::Pending
        );

        let outcome = store
            .complete_interactive(&request.id, &input.action, &input.arguments, true)
            .unwrap();
        assert!(matches!(outcome, ApprovalGateOutcome::Execute(_)));
        let replay = store
            .complete_interactive(&request.id, &input.action, &input.arguments, true)
            .unwrap_err();
        assert!(replay.to_string().contains("MCP_APPROVAL_ALREADY_CONSUMED"));
    }

    #[test]
    fn application_resolution_cannot_resolve_native_mcp_confirmation() {
        let dir = TempDir::new().unwrap();
        let store = ApprovalStore::new(dir.path());
        let input = irreversible_input();
        let request = store.request_interactive(input).unwrap();
        let error = store.approve(&request.id).unwrap_err();
        assert!(error.to_string().contains("MCP_APPROVAL_CHANNEL_MISMATCH"));
        assert!(store.list_pending().unwrap().is_empty());
    }
}
