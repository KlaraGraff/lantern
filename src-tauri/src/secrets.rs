use keyring::credential::CredentialPersistence;
use keyring::Entry;
use rusqlite::{params, Connection};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Local-only secret metadata and legacy migration store.
///
/// Secret values are stored in the operating system credential store. The
/// local SQLite file only exists to migrate values written by older builds.
#[derive(Clone)]
pub struct Secrets {
    pub conn: Arc<Mutex<Connection>>,
    keychain_service: String,
    use_keychain: bool,
}

const KEYCHAIN_SERVICE: &str = "com.klaragraff.quill";
const LEGACY_KEYCHAIN_SERVICES: &[&str] = &["com.klagragraff.quill", "com.wycstudios.quill"];

const SENSITIVE_KEYS: &[&str] = &[
    "ai_api_key",
    "oauth_access_token",
    "oauth_refresh_token",
    "oauth_expires_at",
    "oauth_account_id",
];

impl Secrets {
    pub fn init(local_dir: &PathBuf) -> AppResult<Self> {
        fs::create_dir_all(local_dir)?;

        let db_path = local_dir.join("secrets.db");
        let conn = Connection::open(&db_path)?;

        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;

        if !matches!(
            keyring::default::default_credential_builder().persistence(),
            CredentialPersistence::UntilDelete
        ) {
            return Err(AppError::Other(
                "SYSTEM_CREDENTIAL_STORE_NOT_PERSISTENT".to_string(),
            ));
        }

        let secrets = Self {
            conn: Arc::new(Mutex::new(conn)),
            keychain_service: KEYCHAIN_SERVICE.to_string(),
            use_keychain: true,
        };
        secrets.migrate_legacy_sqlite()?;
        Ok(secrets)
    }

    pub fn get(&self, key: &str) -> Option<String> {
        if self.use_keychain {
            return match self
                .keychain_entry(key)
                .and_then(|entry| entry.get_password())
            {
                Ok(value) => Some(value),
                Err(keyring::Error::NoEntry) => None,
                Err(error) => {
                    log::error!(
                        "secrets: failed to read {key} from system credential store: {error}"
                    );
                    None
                }
            };
        }

        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT value FROM secrets WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn set(&self, key: &str, value: &str) -> AppResult<()> {
        if self.use_keychain {
            let entry = self.keychain_entry(key).map_err(|error| {
                AppError::Other(format!("Failed to access system credential store: {error}"))
            })?;
            let previous = match entry.get_password() {
                Ok(value) => Some(value),
                Err(keyring::Error::NoEntry) => None,
                Err(error) => {
                    return Err(AppError::Other(format!(
                        "Failed to read existing secret from system credential store: {error}"
                    )));
                }
            };
            if let Err(error) = entry.set_password(value) {
                self.restore_keychain_value(key, previous.as_deref());
                return Err(AppError::Other(format!(
                    "Failed to save secret to system credential store: {error}"
                )));
            }
            let stored = match entry.get_password() {
                Ok(stored) => stored,
                Err(error) => {
                    self.restore_keychain_value(key, previous.as_deref());
                    return Err(AppError::Other(format!(
                        "Failed to verify secret in system credential store: {error}"
                    )));
                }
            };
            if stored != value {
                self.restore_keychain_value(key, previous.as_deref());
                return Err(AppError::Other(
                    "SYSTEM_CREDENTIAL_STORE_VERIFICATION_FAILED".to_string(),
                ));
            }
            if let Err(error) = self.delete_legacy_value(key) {
                self.restore_keychain_value(key, previous.as_deref());
                return Err(error);
            }
            return Ok(());
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        conn.execute(
            "INSERT INTO secrets (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_prefix(&self, prefix: &str) -> AppResult<()> {
        let mut deleted = Vec::new();
        if self.use_keychain {
            for key in SENSITIVE_KEYS {
                if key.starts_with(prefix) {
                    let entry = match self.keychain_entry(key) {
                        Ok(entry) => entry,
                        Err(error) => {
                            for (deleted_key, value) in &deleted {
                                self.restore_keychain_value(deleted_key, Some(value));
                            }
                            return Err(AppError::Other(format!(
                                "Failed to access system credential store: {error}"
                            )));
                        }
                    };
                    let previous = match entry.get_password() {
                        Ok(value) => Some(value),
                        Err(keyring::Error::NoEntry) => None,
                        Err(error) => {
                            for (deleted_key, value) in &deleted {
                                self.restore_keychain_value(deleted_key, Some(value));
                            }
                            return Err(AppError::Other(format!(
                                "Failed to read secret from system credential store: {error}"
                            )));
                        }
                    };
                    if let Some(value) = previous {
                        if let Err(error) = entry.delete_credential() {
                            self.restore_keychain_value(key, Some(&value));
                            for (deleted_key, deleted_value) in &deleted {
                                self.restore_keychain_value(deleted_key, Some(deleted_value));
                            }
                            return Err(AppError::Other(format!(
                                "Failed to remove secret from system credential store: {error}"
                            )));
                        }
                        deleted.push(((*key).to_string(), value));
                    }
                }
            }
        }

        let conn = match self.conn.lock() {
            Ok(conn) => conn,
            Err(error) => {
                for (key, value) in &deleted {
                    self.restore_keychain_value(key, Some(value));
                }
                return Err(AppError::Other(error.to_string()));
            }
        };
        if let Err(error) = conn.execute(
            "DELETE FROM secrets WHERE key LIKE ?1",
            params![format!("{}%", prefix)],
        ) {
            drop(conn);
            for (key, value) in &deleted {
                self.restore_keychain_value(key, Some(value));
            }
            return Err(error.into());
        }
        Ok(())
    }

    pub fn delete(&self, key: &str) -> AppResult<()> {
        let mut previous = None;
        if self.use_keychain {
            let entry = self.keychain_entry(key).map_err(|error| {
                AppError::Other(format!("Failed to access system credential store: {error}"))
            })?;
            previous = match entry.get_password() {
                Ok(value) => Some(value),
                Err(keyring::Error::NoEntry) => None,
                Err(error) => {
                    return Err(AppError::Other(format!(
                        "Failed to read secret from system credential store: {error}"
                    )));
                }
            };
            if previous.is_some() {
                if let Err(error) = entry.delete_credential() {
                    self.restore_keychain_value(key, previous.as_deref());
                    return Err(AppError::Other(format!(
                        "Failed to remove secret from system credential store: {error}"
                    )));
                }
            }
        }
        if let Err(error) = self.delete_legacy_value(key) {
            if self.use_keychain {
                self.restore_keychain_value(key, previous.as_deref());
            }
            return Err(error);
        }
        Ok(())
    }

    /// Migrate sensitive keys from the main settings DB into the current
    /// secret store. Values are removed from the settings table only after
    /// the destination write succeeds.
    pub fn migrate_from_settings(&self, db: &Db) -> AppResult<()> {
        let values: Vec<(String, String)> = {
            let db_conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
            SENSITIVE_KEYS
                .iter()
                .filter_map(|key| {
                    db_conn
                        .query_row(
                            "SELECT value FROM settings WHERE key = ?1",
                            params![key],
                            |row| row.get::<_, String>(0),
                        )
                        .ok()
                        .map(|value| ((*key).to_string(), value))
                })
                .collect()
        };

        for (key, value) in values {
            if self.get(&key).is_none() {
                self.set(&key, &value)?;
            }
            let db_conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
            db_conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        }

        Ok(())
    }

    /// Copy legacy service entries into the current bundle namespace. The old
    /// entries stay intact so a failed or rolled-back app update remains
    /// recoverable. `ai_credentials.secret_ref` supplies the dynamic key IDs
    /// used by the multi-key router.
    pub fn migrate_from_legacy_keychain_services(&self, db: &Db) -> AppResult<()> {
        if !self.use_keychain {
            return Ok(());
        }
        let mut keys: Vec<String> = SENSITIVE_KEYS
            .iter()
            .map(|key| (*key).to_string())
            .collect();
        let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let refs = conn
            .prepare("SELECT secret_ref FROM ai_credentials")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(conn);
        keys.extend(refs);
        keys.sort();
        keys.dedup();

        for service in LEGACY_KEYCHAIN_SERVICES {
            if *service == self.keychain_service {
                continue;
            }
            for key in &keys {
                if self.get(key).is_some() {
                    continue;
                }
                let legacy = Entry::new(service, key).and_then(|entry| entry.get_password());
                match legacy {
                    Ok(value) => {
                        self.set(key, &value)?;
                        log::info!("secrets: migrated {key} from legacy credential service");
                    }
                    Err(keyring::Error::NoEntry) => {}
                    Err(error) => {
                        log::warn!("secrets: could not read legacy credential {key}: {error}");
                    }
                }
            }
        }
        Ok(())
    }

    pub fn is_sensitive_key(key: &str) -> bool {
        SENSITIVE_KEYS.contains(&key) || key.starts_with("ai_api_key/") || key.starts_with("oauth_")
    }

    fn keychain_entry(&self, key: &str) -> Result<Entry, keyring::Error> {
        Entry::new(&self.keychain_service, key)
    }

    fn restore_keychain_value(&self, key: &str, previous: Option<&str>) {
        let result = match self.keychain_entry(key) {
            Ok(entry) => match previous {
                Some(value) => entry.set_password(value),
                None => match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(error) => Err(error),
                },
            },
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            log::error!("secrets: failed to restore {key} after a partial operation: {error}");
        }
    }

    fn delete_legacy_value(&self, key: &str) -> AppResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        conn.execute("DELETE FROM secrets WHERE key = ?1", params![key])?;
        Ok(())
    }

    fn migrate_legacy_sqlite(&self) -> AppResult<()> {
        let values: Vec<(String, String)> = {
            let conn = self
                .conn
                .lock()
                .map_err(|e| AppError::Other(e.to_string()))?;
            let mut stmt = conn.prepare("SELECT key, value FROM secrets")?;
            let values = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            values
        };

        for (key, value) in values {
            if !Self::is_sensitive_key(&key) {
                continue;
            }
            let entry = self.keychain_entry(&key).map_err(|error| {
                AppError::Other(format!("Failed to access system credential store: {error}"))
            })?;
            match entry.get_password() {
                Ok(_) => {}
                Err(keyring::Error::NoEntry) => {
                    entry.set_password(&value).map_err(|error| {
                        AppError::Other(format!(
                            "Failed to migrate secret to system credential store: {error}"
                        ))
                    })?;
                    let stored = entry.get_password().map_err(|error| {
                        AppError::Other(format!("Failed to verify migrated secret: {error}"))
                    })?;
                    if stored != value {
                        return Err(AppError::Other(
                            "SYSTEM_CREDENTIAL_STORE_VERIFICATION_FAILED".to_string(),
                        ));
                    }
                }
                Err(error) => {
                    return Err(AppError::Other(format!(
                        "Failed to access system credential store: {error}"
                    )));
                }
            }
            self.delete_legacy_value(&key)?;
        }
        Ok(())
    }
}

#[cfg(test)]
impl Secrets {
    pub fn init_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            keychain_service: "test".to_string(),
            use_keychain: false,
        })
    }
}
