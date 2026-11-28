//! 启动失败提示页 — what launch does when the library database or the API-key
//! store will not open. Setup used to `expect()` both, so a damaged
//! `lantern.db` panicked before any window existed and the app simply never
//! appeared. Now setup records the failure here, registers nothing else, and
//! the main window renders a page that names the cause and, for the library,
//! offers 从备份恢复 — the same staged swap `crate::restore` already performs
//! at the next launch, which also moves the damaged file aside.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailedStore {
    /// `lantern.db`: books, highlights, notes, vocabulary, progress.
    Library,
    /// `secrets.db`: API keys. Never part of a backup.
    Secrets,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    Damaged,
    DiskFull,
    NoAccess,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StartupFailureInfo {
    pub store: FailedStore,
    pub reason: FailureReason,
    /// The underlying error, for the collapsed details and a bug report.
    pub detail: String,
    /// 从备份恢复 only replaces `lantern.db`, and refuses while sync is on.
    pub can_restore: bool,
}

pub struct StartupFailure {
    pub info: StartupFailureInfo,
    pub local_dir: PathBuf,
    pub data_dir: PathBuf,
    /// The folder `startup_restore_choose` picked.
    pub restore_dir: Mutex<Option<PathBuf>>,
}

impl StartupFailure {
    pub fn new(store: FailedStore, error: &AppError, local_dir: &Path, data_dir: &Path) -> Self {
        let can_restore = store == FailedStore::Library
            && cfg!(desktop)
            && !crate::sync::migration::is_sync_enabled(local_dir);
        Self {
            info: StartupFailureInfo {
                store,
                reason: reason_of(error),
                detail: error.to_string(),
                can_restore,
            },
            local_dir: local_dir.to_path_buf(),
            data_dir: data_dir.to_path_buf(),
            restore_dir: Mutex::new(None),
        }
    }
}

pub fn reason_of(error: &AppError) -> FailureReason {
    use rusqlite::ErrorCode;
    use std::io::ErrorKind;
    match error {
        AppError::Db(rusqlite::Error::SqliteFailure(failure, _)) => match failure.code {
            ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => FailureReason::Damaged,
            ErrorCode::DiskFull => FailureReason::DiskFull,
            ErrorCode::CannotOpen | ErrorCode::PermissionDenied | ErrorCode::ReadOnly => {
                FailureReason::NoAccess
            }
            _ => FailureReason::Unknown,
        },
        AppError::Io(io) => match io.kind() {
            ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => FailureReason::NoAccess,
            ErrorKind::StorageFull => FailureReason::DiskFull,
            _ => FailureReason::Unknown,
        },
        _ => FailureReason::Unknown,
    }
}

/// `None` on every normal launch. The frontend asks before it mounts the app.
#[tauri::command]
pub fn startup_failure(app: AppHandle) -> Option<StartupFailureInfo> {
    app.try_state::<StartupFailure>()
        .map(|state| state.info.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn a_file_that_is_not_a_database_reads_as_damaged() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(crate::db::DB_FILE_NAME),
            b"this is not sqlite, it is a few bytes of garbage long enough to be a header",
        )
        .unwrap();
        let error = match Db::init(dir.path()) {
            Ok(_) => panic!("a garbage file must not open as a library"),
            Err(error) => error,
        };
        assert_eq!(reason_of(&error), FailureReason::Damaged);

        let failure = StartupFailure::new(FailedStore::Library, &error, dir.path(), dir.path());
        assert!(failure.info.can_restore);
        assert!(!failure.info.detail.is_empty());
    }

    #[test]
    fn the_key_store_never_offers_a_restore() {
        let dir = tempfile::tempdir().unwrap();
        let error = AppError::Other("CREDENTIAL_DB_JOURNAL_MODE_UNSAFE:wal".into());
        let failure = StartupFailure::new(FailedStore::Secrets, &error, dir.path(), dir.path());
        assert!(!failure.info.can_restore);
        assert_eq!(failure.info.reason, FailureReason::Unknown);
    }

    #[test]
    fn restore_is_not_offered_while_sync_is_on() {
        let dir = tempfile::tempdir().unwrap();
        crate::sync::migration::write_sync_settings(dir.path(), Some(dir.path())).unwrap();
        assert!(crate::sync::migration::is_sync_enabled(dir.path()));
        let error = AppError::Other("x".into());
        let failure = StartupFailure::new(FailedStore::Library, &error, dir.path(), dir.path());
        assert!(!failure.info.can_restore);
    }

    #[test]
    fn io_errors_map_to_access_and_space() {
        let denied = AppError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(reason_of(&denied), FailureReason::NoAccess);
        let full = AppError::Io(std::io::Error::from(std::io::ErrorKind::StorageFull));
        assert_eq!(reason_of(&full), FailureReason::DiskFull);
    }
}
