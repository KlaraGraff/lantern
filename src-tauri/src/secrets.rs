use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppResult};

const SENSITIVE_KEYS: &[&str] = &[
    "ai_api_key",
    "tts_api_key",
    "oauth_access_token",
    "oauth_refresh_token",
    "oauth_expires_at",
    "oauth_account_id",
];

#[derive(Clone)]
pub struct SecretStateSnapshot {
    key: String,
    local_value: Option<String>,
    local_created_at: Option<i64>,
}

#[cfg(test)]
#[derive(Default)]
struct TestFaults {
    fail_next_delete: bool,
    fail_next_restore: bool,
}

/// Local credential storage for API keys and OAuth tokens.
///
/// One table, one file, no operating-system credential store. Lantern used to
/// carry two inherited import paths — a v1.4 AES-GCM vault unlocked by a
/// Keychain master key, and a still older layout with one Keychain item per
/// credential. Both were removed once every install had drained them; a
/// credential that only ever lived in the Keychain is still in the Keychain,
/// and is re-entered through AI settings like any other.
#[derive(Clone)]
pub struct Secrets {
    pub conn: Arc<Mutex<Connection>>,
    operation_lock: Arc<Mutex<()>>,
    #[cfg(test)]
    faults: Arc<Mutex<TestFaults>>,
}

impl Secrets {
    pub fn init(local_dir: &PathBuf) -> AppResult<Self> {
        fs::create_dir_all(local_dir)?;
        let db_path = local_dir.join("secrets.db");
        Self::prepare_private_file(&db_path)?;
        let conn = Connection::open(&db_path)?;
        Self::initialize_schema(&conn)?;
        Self::harden_sqlite_files(&db_path)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            operation_lock: Arc::new(Mutex::new(())),
            #[cfg(test)]
            faults: Arc::new(Mutex::new(TestFaults::default())),
        })
    }

    fn initialize_schema(conn: &Connection) -> AppResult<()> {
        conn.execute_batch(
            "PRAGMA journal_mode=DELETE;
             PRAGMA secure_delete=ON;
             CREATE TABLE IF NOT EXISTS secrets (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL,
                 created_at INTEGER NOT NULL DEFAULT 0
             );",
        )?;
        let journal_mode =
            conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))?;
        if !matches!(journal_mode.as_str(), "delete" | "memory") {
            return Err(AppError::Other(format!(
                "CREDENTIAL_DB_JOURNAL_MODE_UNSAFE:{journal_mode}"
            )));
        }
        let has_created_at = conn
            .prepare("PRAGMA table_info(secrets)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "created_at");
        if !has_created_at {
            conn.execute_batch(
                "ALTER TABLE secrets ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        Ok(())
    }

    #[cfg(unix)]
    fn prepare_private_file(path: &Path) -> AppResult<()> {
        use std::fs::OpenOptions;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    }

    #[cfg(not(unix))]
    fn prepare_private_file(path: &Path) -> AppResult<()> {
        use std::fs::OpenOptions;

        OpenOptions::new().create(true).append(true).open(path)?;
        Ok(())
    }

    fn harden_sqlite_files(db_path: &Path) -> AppResult<()> {
        Self::prepare_private_file(db_path)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut path = db_path.as_os_str().to_os_string();
            path.push(suffix);
            let path = PathBuf::from(path);
            if path.exists() {
                Self::harden_existing_file(&path)?;
            }
        }
        Ok(())
    }

    #[cfg(unix)]
    fn harden_existing_file(path: &Path) -> AppResult<()> {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    }

    #[cfg(not(unix))]
    fn harden_existing_file(_path: &Path) -> AppResult<()> {
        Ok(())
    }

    pub fn get(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        Ok(conn
            .query_row(
                "SELECT value FROM secrets WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn set(&self, key: &str, value: &str) -> AppResult<()> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let conn = self
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        Self::store_local_in_transaction(&tx, key, value)?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_many(&self, values: &[(&str, Option<&str>)]) -> AppResult<()> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let conn = self
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        for (key, value) in values {
            match value {
                Some(value) => Self::store_local_in_transaction(&tx, key, value)?,
                None => Self::delete_in_transaction(&tx, key)?,
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn snapshot_state(&self, key: &str) -> AppResult<SecretStateSnapshot> {
        let conn = self
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let local = conn
            .query_row(
                "SELECT value, created_at FROM secrets WHERE key = ?1",
                params![key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        Ok(SecretStateSnapshot {
            key: key.to_string(),
            local_value: local.as_ref().map(|value| value.0.clone()),
            local_created_at: local.map(|value| value.1),
        })
    }

    pub fn restore_state(&self, snapshot: &SecretStateSnapshot) -> AppResult<()> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        #[cfg(test)]
        {
            let mut faults = self
                .faults
                .lock()
                .map_err(|error| AppError::Other(error.to_string()))?;
            if std::mem::take(&mut faults.fail_next_restore) {
                return Err(AppError::Other("TEST_SECRET_RESTORE_FAILED".to_string()));
            }
        }
        let conn = self
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM secrets WHERE key = ?1", params![snapshot.key])?;
        if let Some(value) = snapshot.local_value.as_ref() {
            tx.execute(
                "INSERT INTO secrets (key, value, created_at) VALUES (?1, ?2, ?3)",
                params![snapshot.key, value, snapshot.local_created_at.unwrap_or(0)],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_prefix(&self, prefix: &str) -> AppResult<()> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let conn = self
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let mut keys = conn
            .prepare("SELECT key FROM secrets WHERE key LIKE ?1")?
            .query_map(params![format!("{prefix}%")], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        keys.extend(
            SENSITIVE_KEYS
                .iter()
                .filter(|key| key.starts_with(prefix))
                .map(|key| (*key).to_string()),
        );
        keys.sort();
        keys.dedup();
        let tx = conn.unchecked_transaction()?;
        for key in keys {
            Self::delete_in_transaction(&tx, &key)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> AppResult<()> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        #[cfg(test)]
        {
            let mut faults = self
                .faults
                .lock()
                .map_err(|error| AppError::Other(error.to_string()))?;
            if std::mem::take(&mut faults.fail_next_delete) {
                return Err(AppError::Other("TEST_SECRET_DELETE_FAILED".to_string()));
            }
        }
        let conn = self
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        Self::delete_in_transaction(&tx, key)?;
        tx.commit()?;
        Ok(())
    }

    fn delete_in_transaction(tx: &rusqlite::Transaction<'_>, key: &str) -> AppResult<()> {
        tx.execute("DELETE FROM secrets WHERE key = ?1", params![key])?;
        Ok(())
    }

    fn store_local_in_transaction(
        tx: &rusqlite::Transaction<'_>,
        key: &str,
        value: &str,
    ) -> AppResult<()> {
        tx.execute(
            "INSERT INTO secrets (key, value, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                 created_at = excluded.created_at",
            params![key, value, chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(())
    }

    pub fn has_stored_secret_metadata(&self, key: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM secrets WHERE key = ?1)",
            params![key],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
            != 0
    }

    pub fn is_sensitive_key(key: &str) -> bool {
        SENSITIVE_KEYS.contains(&key) || key.starts_with("ai_api_key/") || key.starts_with("oauth_")
    }
}

#[cfg(test)]
impl Secrets {
    pub fn init_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::initialize_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            operation_lock: Arc::new(Mutex::new(())),
            faults: Arc::new(Mutex::new(TestFaults::default())),
        })
    }

    pub fn fail_next_delete_for_test(&self) {
        self.faults.lock().unwrap().fail_next_delete = true;
    }

    pub fn fail_next_restore_for_test(&self) {
        self.faults.lock().unwrap().fail_next_restore = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_round_trip_uses_only_the_local_table() {
        let secrets = Secrets::init_in_memory().unwrap();
        let secure_delete = secrets
            .conn
            .lock()
            .unwrap()
            .query_row("PRAGMA secure_delete", [], |row| row.get::<_, i64>(0))
            .unwrap();
        assert_eq!(secure_delete, 1);
        secrets.set("ai_api_key/test", "secret-value").unwrap();
        assert_eq!(
            secrets.get("ai_api_key/test").unwrap().as_deref(),
            Some("secret-value")
        );
        assert!(secrets.has_stored_secret_metadata("ai_api_key/test"));
    }

    #[test]
    fn batch_update_removes_optional_values_atomically() {
        let secrets = Secrets::init_in_memory().unwrap();
        secrets
            .set_many(&[
                ("oauth_access_token", Some("access")),
                ("oauth_account_id", Some("account")),
            ])
            .unwrap();
        secrets
            .set_many(&[
                ("oauth_access_token", Some("new-access")),
                ("oauth_account_id", None),
            ])
            .unwrap();
        assert_eq!(
            secrets.get("oauth_access_token").unwrap().as_deref(),
            Some("new-access")
        );
        assert_eq!(secrets.get("oauth_account_id").unwrap(), None);
    }

    #[test]
    fn deleting_a_credential_leaves_no_metadata_behind() {
        let secrets = Secrets::init_in_memory().unwrap();
        secrets.set("ai_api_key/legacy", "value").unwrap();
        secrets.delete("ai_api_key/legacy").unwrap();

        assert!(!secrets.has_stored_secret_metadata("ai_api_key/legacy"));
        assert_eq!(secrets.get("ai_api_key/legacy").unwrap(), None);
    }

    #[test]
    fn restore_puts_a_deleted_value_back_exactly() {
        let secrets = Secrets::init_in_memory().unwrap();
        secrets.set("ai_api_key/rollback", "original").unwrap();
        let snapshot = secrets.snapshot_state("ai_api_key/rollback").unwrap();
        secrets.set("ai_api_key/rollback", "replacement").unwrap();

        secrets.restore_state(&snapshot).unwrap();

        assert_eq!(
            secrets.get("ai_api_key/rollback").unwrap().as_deref(),
            Some("original")
        );
    }

    #[test]
    fn restoring_a_key_that_did_not_exist_removes_it_again() {
        let secrets = Secrets::init_in_memory().unwrap();
        let snapshot = secrets.snapshot_state("ai_api_key/absent").unwrap();
        secrets.set("ai_api_key/absent", "added").unwrap();

        secrets.restore_state(&snapshot).unwrap();

        assert_eq!(secrets.get("ai_api_key/absent").unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn file_store_is_created_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("lantern-secrets-{}", uuid::Uuid::new_v4()));
        let secrets = Secrets::init(&dir).unwrap();
        let journal_mode = secrets
            .conn
            .lock()
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap();
        assert_eq!(journal_mode, "delete");
        drop(secrets);
        let mode = fs::metadata(dir.join("secrets.db"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        assert!(!dir.join("secrets.db-wal").exists());
        assert!(!dir.join("secrets.db-shm").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
