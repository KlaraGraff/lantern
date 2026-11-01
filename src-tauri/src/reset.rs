//! 重置全部数据 — wipe this device's Lantern data back to a fresh install.
//!
//! The wipe never runs inside a live session: open SQLite handles, the sync
//! watcher, OCR workers and the exit-time checkpoint would all keep writing
//! into a directory that is being emptied. Instead the reset command only
//! drops a marker, the app relaunches, and the very first thing `setup()`
//! does on the next launch — before any database, device id or secrets store
//! is opened — is empty the local data directory.
//!
//! Scope is the local app-data directory and nothing else. When sync is on,
//! books and covers live in the iCloud container, which is outside that
//! directory and is never touched here; the recorded sync folder is also
//! skipped explicitly in case it was ever configured inside the local
//! directory. Symlinks are unlinked, never followed.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const MARKER_FILE: &str = ".reset_pending";

/// On Linux the log directory sits inside the app-data directory; logs are
/// diagnostics about the app, not the reader's data, and are kept.
const KEEP: &[&str] = &[MARKER_FILE, "logs"];

/// The data directory is always named after the bundle identifier
/// (`com.klaragraff.lantern`, `-dev` in debug builds). Refusing anything else
/// means a mis-resolved path can never turn this into a wipe of `$HOME`.
const DIR_NAME_PREFIX: &str = "com.klaragraff.lantern";

fn marker_path(local_dir: &Path) -> PathBuf {
    local_dir.join(MARKER_FILE)
}

fn check_dir_name(local_dir: &Path) -> AppResult<()> {
    let ok = local_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(DIR_NAME_PREFIX));
    if ok {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "reset: refusing unexpected data dir {}",
            local_dir.display()
        )))
    }
}

pub fn is_pending(local_dir: &Path) -> bool {
    marker_path(local_dir).exists()
}

/// Ask for a wipe on the next launch. Nothing is deleted here.
pub fn request(local_dir: &Path) -> AppResult<()> {
    check_dir_name(local_dir)?;
    fs::write(marker_path(local_dir), b"1")?;
    Ok(())
}

/// Run a requested wipe. Returns `Ok(true)` when a wipe ran to completion.
///
/// The databases go first, and nothing else is touched unless every one of
/// them went: a database still held open (by the previous process during a
/// relaunch, or by an MCP client, on Windows) leaves the library whole
/// rather than half-deleted. The marker is removed last, and only if every
/// entry went, so a failure is retried rather than forgotten.
pub fn apply_pending(local_dir: &Path) -> AppResult<bool> {
    apply_pending_with(local_dir, remove_entry)
}

/// The launch-time entry point. A relaunch starts the new process before the
/// old one has exited, so the old one can still hold the databases for a
/// moment (on Windows that blocks the delete); retry for a while. If they
/// stay held — an MCP client keeping `lantern.db` open, say — quit rather than
/// boot on data the reader asked to have deleted. Nothing beyond the
/// databases has been touched at that point, and the next launch retries.
pub fn apply_pending_at_launch(local_dir: &Path) {
    const ATTEMPTS: u32 = 20;
    for attempt in 1..=ATTEMPTS {
        match apply_pending(local_dir) {
            Ok(true) => {
                log::info!("reset: local data wiped, starting fresh");
                return;
            }
            Ok(false) => return,
            Err(error) if attempt < ATTEMPTS => {
                log::warn!("reset: attempt {attempt} failed: {error}");
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            Err(error) => {
                log::error!(
                    "reset: giving up this launch: {error}. Another process (an MCP \
                     client?) still holds Lantern's data; close it and reopen Lantern."
                );
                std::process::exit(1);
            }
        }
    }
}

fn is_database(name: &str) -> bool {
    name.starts_with(crate::db::DB_FILE_NAME) || name.starts_with("secrets.db")
}

fn apply_pending_with(
    local_dir: &Path,
    remove: impl Fn(&Path) -> io::Result<()>,
) -> AppResult<bool> {
    if !is_pending(local_dir) {
        return Ok(false);
    }
    check_dir_name(local_dir)?;

    // Read before `.sync_setting` itself is deleted.
    let protected = crate::sync::migration::recorded_data_dir(local_dir);

    let mut databases = Vec::new();
    let mut rest = Vec::new();
    for entry in fs::read_dir(local_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if KEEP.iter().any(|keep| name == *keep) {
            continue;
        }
        let path = entry.path();
        if protected
            .as_deref()
            .is_some_and(|shared| shared.starts_with(&path))
        {
            log::warn!(
                "reset: skipping {} — it holds the sync folder",
                path.display()
            );
            continue;
        }
        if name.to_str().is_some_and(is_database) {
            databases.push(path);
        } else {
            rest.push(path);
        }
    }

    for group in [databases, rest] {
        let mut failures = 0;
        for path in group {
            if let Err(error) = remove(&path) {
                log::error!("reset: failed to remove {}: {error}", path.display());
                failures += 1;
            }
        }
        if failures > 0 {
            return Err(AppError::Other(format!(
                "reset: {failures} entries could not be removed"
            )));
        }
    }
    fs::remove_file(marker_path(local_dir))?;
    Ok(true)
}

fn remove_entry(path: &Path) -> io::Result<()> {
    // `symlink_metadata` so a link is removed as a link, never followed.
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_dir(root: &Path) -> PathBuf {
        let dir = root.join("com.klaragraff.lantern-test");
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn populate(dir: &Path) {
        for file in [
            "lantern.db",
            "lantern.db-wal",
            "lantern.db-shm",
            "secrets.db",
            ".device_id",
            ".mcp-notify",
            ".sync-transition.lock",
        ] {
            fs::write(dir.join(file), b"x").unwrap();
        }
        for sub in ["books", "covers", "sources", "prepared", "imported-fonts"] {
            fs::create_dir_all(dir.join(sub).join("nested")).unwrap();
            fs::write(dir.join(sub).join("nested").join("f"), b"x").unwrap();
        }
        fs::create_dir_all(dir.join("logs")).unwrap();
        fs::write(dir.join("logs").join("lantern.log"), b"log").unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn nothing_happens_without_a_request() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = data_dir(tmp.path());
        populate(&dir);
        let before = names(&dir);
        assert!(!apply_pending(&dir).unwrap());
        assert_eq!(names(&dir), before);
    }

    #[test]
    fn request_alone_deletes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = data_dir(tmp.path());
        populate(&dir);
        let mut before = names(&dir);
        request(&dir).unwrap();
        before.push(MARKER_FILE.to_string());
        before.sort();
        assert_eq!(names(&dir), before);
        assert!(is_pending(&dir));
    }

    #[test]
    fn wipe_removes_everything_but_logs_and_clears_the_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = data_dir(tmp.path());
        populate(&dir);
        fs::write(
            dir.join(".sync_setting"),
            br#"{"enabled":true,"data_dir":"/nowhere/icloud"}"#,
        )
        .unwrap();
        request(&dir).unwrap();

        assert!(apply_pending(&dir).unwrap());
        assert_eq!(names(&dir), vec!["logs".to_string()]);
        assert_eq!(fs::read(dir.join("logs/lantern.log")).unwrap(), b"log");
        assert!(!is_pending(&dir));
        // A second launch is a normal launch.
        assert!(!apply_pending(&dir).unwrap());
    }

    #[test]
    fn sibling_directories_are_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = data_dir(tmp.path());
        populate(&dir);
        let sibling = tmp.path().join("iCloud~com~klaragraff~lantern/Documents");
        fs::create_dir_all(sibling.join("books")).unwrap();
        fs::write(sibling.join("books/a.epub"), b"book").unwrap();
        fs::write(
            dir.join(".sync_setting"),
            format!(
                r#"{{"enabled":true,"data_dir":{}}}"#,
                serde_json::to_string(&sibling).unwrap()
            ),
        )
        .unwrap();
        request(&dir).unwrap();
        assert!(apply_pending(&dir).unwrap());
        assert_eq!(fs::read(sibling.join("books/a.epub")).unwrap(), b"book");
    }

    #[test]
    fn a_sync_folder_recorded_inside_the_data_dir_is_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = data_dir(tmp.path());
        populate(&dir);
        let shared = dir.join("shared/Documents");
        fs::create_dir_all(&shared).unwrap();
        fs::write(shared.join("events.jsonl"), b"e").unwrap();
        fs::write(
            dir.join(".sync_setting"),
            format!(
                r#"{{"enabled":true,"data_dir":{}}}"#,
                serde_json::to_string(&shared).unwrap()
            ),
        )
        .unwrap();
        request(&dir).unwrap();
        assert!(apply_pending(&dir).unwrap());
        assert_eq!(fs::read(shared.join("events.jsonl")).unwrap(), b"e");
        assert_eq!(names(&dir), vec!["logs".to_string(), "shared".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_unlinked_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = data_dir(tmp.path());
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("link-dir")).unwrap();
        std::os::unix::fs::symlink(outside.join("keep.txt"), dir.join("link-file")).unwrap();
        request(&dir).unwrap();
        assert!(apply_pending(&dir).unwrap());
        assert!(fs::symlink_metadata(dir.join("link-dir")).is_err());
        assert!(fs::symlink_metadata(dir.join("link-file")).is_err());
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
    }

    #[test]
    fn refuses_a_directory_not_named_for_lantern() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("precious.txt"), b"x").unwrap();
        assert!(request(&home).is_err());
        // Even a marker planted by hand does not trigger a wipe.
        fs::write(home.join(MARKER_FILE), b"1").unwrap();
        assert!(apply_pending(&home).is_err());
        assert!(home.join("precious.txt").exists());
    }

    #[test]
    fn a_failed_entry_keeps_the_marker_for_a_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = data_dir(tmp.path());
        populate(&dir);
        request(&dir).unwrap();
        let held_open = dir.join("lantern.db");
        let result = apply_pending_with(&dir, |path| {
            if path == held_open {
                Err(io::Error::other("in use"))
            } else {
                remove_entry(path)
            }
        });
        assert!(result.is_err());
        assert!(is_pending(&dir));
        // Nothing else went either: the library is whole, not half-deleted.
        assert!(dir.join("books/nested/f").exists());
        assert!(dir.join("covers/nested/f").exists());
        assert!(dir.join(".device_id").exists());
        // The retry on the next launch finishes the job.
        assert!(apply_pending(&dir).unwrap());
        assert_eq!(names(&dir), vec!["logs".to_string()]);
    }
}
