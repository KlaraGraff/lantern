//! 从备份恢复 — swap in a database snapshot from the library backup.
//!
//! Like 重置全部数据, the swap never runs inside a live session: the open
//! SQLite handles, the WAL and every background writer would keep pointing at
//! the old file. The restore command only stages the snapshot beside the live
//! database (`.restore-pending.db`), the app relaunches, and `setup()` swaps it
//! in before anything opens `lantern.db`.
//!
//! The database being replaced is never deleted: it moves, with its `-wal` and
//! `-shm` companions, into `before-restore/<timestamp>/`. The three files
//! move together or not at all — a WAL left behind beside a different database
//! would be replayed into it.

use std::fs;
use std::path::{Path, PathBuf};

use crate::db::DB_FILE_NAME;
use crate::error::AppResult;

pub const STAGED_FILE: &str = ".restore-pending.db";
const ASIDE_DIR: &str = "before-restore";

pub fn staged_path(local_dir: &Path) -> PathBuf {
    local_dir.join(STAGED_FILE)
}

/// Swap a staged snapshot in. `Ok(true)` when it was swapped in.
pub fn apply_pending(local_dir: &Path) -> AppResult<bool> {
    apply_pending_with(local_dir, |from, to| fs::rename(from, to))
}

fn apply_pending_with(
    local_dir: &Path,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> AppResult<bool> {
    let staged = staged_path(local_dir);
    if !staged.is_file() {
        return Ok(false);
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f").to_string();
    let aside = local_dir.join(ASIDE_DIR).join(stamp);
    fs::create_dir_all(&aside)?;

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| -> std::io::Result<()> {
        // Companions first, the database last: if the database itself
        // cannot move, everything goes back and the old library boots intact.
        for suffix in ["-wal", "-shm", ""] {
            let name = format!("{DB_FILE_NAME}{suffix}");
            let from = local_dir.join(&name);
            if !from.exists() {
                continue;
            }
            let to = aside.join(&name);
            rename(&from, &to)?;
            moved.push((from, to));
        }
        rename(&staged, &local_dir.join(DB_FILE_NAME))
    })();

    if let Err(error) = result {
        for (from, to) in moved.iter().rev() {
            if let Err(undo) = rename(to, from) {
                log::error!("restore: could not move {} back: {undo}", from.display());
            }
        }
        let _ = fs::remove_dir(&aside);
        return Err(error.into());
    }
    Ok(true)
}

/// The launch-time entry point. A relaunch can start before the old process
/// has let go of the database (on Windows that blocks the rename), so retry
/// for a while; if it stays held, boot the current library and try again on
/// the next launch.
pub fn apply_pending_at_launch(local_dir: &Path) {
    const ATTEMPTS: u32 = 20;
    for attempt in 1..=ATTEMPTS {
        match apply_pending(local_dir) {
            Ok(true) => {
                log::info!("restore: backup snapshot swapped in");
                return;
            }
            Ok(false) => return,
            Err(error) if attempt < ATTEMPTS => {
                log::warn!("restore: attempt {attempt} failed: {error}");
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            Err(error) => {
                log::error!("restore: giving up this launch, will retry next launch: {error}");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_happens_without_a_staged_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DB_FILE_NAME), b"live").unwrap();
        assert!(!apply_pending(dir.path()).unwrap());
        assert_eq!(fs::read(dir.path().join(DB_FILE_NAME)).unwrap(), b"live");
        assert!(!dir.path().join(ASIDE_DIR).exists());
    }

    #[test]
    fn swaps_in_and_keeps_the_old_database_with_its_wal() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DB_FILE_NAME), b"live").unwrap();
        fs::write(dir.path().join(format!("{DB_FILE_NAME}-wal")), b"wal").unwrap();
        fs::write(staged_path(dir.path()), b"snapshot").unwrap();

        assert!(apply_pending(dir.path()).unwrap());
        assert_eq!(
            fs::read(dir.path().join(DB_FILE_NAME)).unwrap(),
            b"snapshot"
        );
        assert!(!staged_path(dir.path()).exists());
        // The old WAL must not sit beside the new database.
        assert!(!dir.path().join(format!("{DB_FILE_NAME}-wal")).exists());

        let kept: Vec<_> = fs::read_dir(dir.path().join(ASIDE_DIR)).unwrap().collect();
        assert_eq!(kept.len(), 1);
        let kept = kept[0].as_ref().unwrap().path();
        assert_eq!(fs::read(kept.join(DB_FILE_NAME)).unwrap(), b"live");
        assert_eq!(
            fs::read(kept.join(format!("{DB_FILE_NAME}-wal"))).unwrap(),
            b"wal"
        );
    }

    #[test]
    fn works_on_a_fresh_install_with_no_database_yet() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(staged_path(dir.path()), b"snapshot").unwrap();
        assert!(apply_pending(dir.path()).unwrap());
        assert_eq!(
            fs::read(dir.path().join(DB_FILE_NAME)).unwrap(),
            b"snapshot"
        );
    }

    #[test]
    fn a_failed_swap_puts_everything_back() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DB_FILE_NAME), b"live").unwrap();
        fs::write(dir.path().join(format!("{DB_FILE_NAME}-wal")), b"wal").unwrap();
        fs::write(staged_path(dir.path()), b"snapshot").unwrap();

        let staged = staged_path(dir.path());
        let result = apply_pending_with(dir.path(), |from, to| {
            if from == staged {
                Err(std::io::Error::other("held open"))
            } else {
                fs::rename(from, to)
            }
        });
        assert!(result.is_err());
        assert_eq!(fs::read(dir.path().join(DB_FILE_NAME)).unwrap(), b"live");
        assert_eq!(
            fs::read(dir.path().join(format!("{DB_FILE_NAME}-wal"))).unwrap(),
            b"wal"
        );
        assert!(staged.is_file(), "kept for the next launch to retry");
    }
}
