//! Sync settings file — read/write/remove `.sync_setting` containing the
//! user-authorized shared folder and whether the event-log engine should boot.
//!
//! Written by `sync_enable`, removed by `sync_disable`. JSON format
//! for future extensibility.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const SYNC_SETTINGS_FILE: &str = ".sync_setting";
const DEFAULT_SYNC_FOLDER_NAME: &str = "lantern";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
}

pub fn sync_settings_path(local_dir: &Path) -> PathBuf {
    local_dir.join(SYNC_SETTINGS_FILE)
}

pub fn is_sync_enabled(local_dir: &Path) -> bool {
    read_sync_settings(local_dir)
        .is_some_and(|s| s.enabled && s.data_dir.as_deref().is_some_and(|path| !path.is_empty()))
}

pub fn read_sync_settings(local_dir: &Path) -> Option<SyncSettings> {
    let bytes = fs::read(sync_settings_path(local_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn recorded_data_dir(local_dir: &Path) -> Option<PathBuf> {
    let settings = read_sync_settings(local_dir)?;
    let dir = settings.data_dir?;
    if dir.is_empty() {
        return None;
    }
    Some(PathBuf::from(dir))
}

/// Return the selected folder only when it is still an accessible iCloud Drive
/// directory. The marker is user-editable local state, so callers that touch
/// blobs must not treat its raw absolute path as authority.
pub fn recorded_usable_icloud_dir(local_dir: &Path) -> Option<PathBuf> {
    recorded_data_dir(local_dir).filter(|dir| is_usable_icloud_dir(dir))
}

pub fn is_usable_icloud_dir(path: &Path) -> bool {
    is_icloud_drive_dir(path) && is_writable_dir(path)
}

/// Where iCloud Drive puts a user's own files. Built from `HOME` rather than
/// probed, so it answers for a path that does not exist yet.
///
/// Desktop only, and deliberately not the whole Apple vendor: a sandboxed iOS
/// app cannot read `com~apple~CloudDocs` at all, so on iOS this would name a
/// path every later check then fails on. iOS resolves its root through
/// [`ubiquity_sync_root`] instead.
#[cfg(not(target_os = "ios"))]
fn icloud_drive_root() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Mobile Documents/com~apple~CloudDocs"))
}

/// The mobile sync root: `Documents` inside the app's own ubiquity container.
///
/// `Documents` rather than the container root because only that subtree is
/// eligible to appear in iCloud Drive under `NSUbiquitousContainers`. Nothing
/// declares that key yet ([Q-001](../../../docs/roadmap/mobile-ios.md)), but
/// putting the files anywhere else would make declaring it later a data move
/// rather than a plist edit.
///
/// There is no `lantern` subfolder the way the desktop default has one. The
/// desktop needs it because it is a guest in the user's own iCloud Drive; the
/// container is already private to this app.
#[cfg(target_os = "ios")]
fn ubiquity_sync_root() -> Option<PathBuf> {
    crate::icloud::ubiquity_container_dir().map(|dir| dir.join("Documents"))
}

/// Creates Lantern's default iCloud Drive folder when the previous selection
/// is absent. Users can still select any existing iCloud Drive folder instead.
///
/// The returned path is not checked for being inside iCloud Drive here —
/// `sync_enable` checks that unconditionally on whatever folder it ends up
/// with, so repeating it would only make this function untestable.
#[cfg(not(target_os = "ios"))]
pub fn create_default_icloud_dir() -> AppResult<PathBuf> {
    let root = icloud_drive_root()
        .ok_or_else(|| AppError::Other("ICLOUD_DRIVE_UNAVAILABLE".to_string()))?;
    create_default_dir_in(&root)
}

/// iOS has nothing to choose and nothing to default *to*: the container is the
/// only iCloud location this app can reach, so "create the default folder" and
/// "resolve the sync folder" are the same operation.
///
/// `ICLOUD_DRIVE_UNAVAILABLE` covers three real states here — no entitlement in
/// this build, iCloud Drive off in Settings, or no iCloud account — and the
/// frontend already tells the user to check iCloud Drive on that code.
#[cfg(target_os = "ios")]
pub fn create_default_icloud_dir() -> AppResult<PathBuf> {
    let dir =
        ubiquity_sync_root().ok_or_else(|| AppError::Other("ICLOUD_DRIVE_UNAVAILABLE".to_string()))?;
    fs::create_dir_all(&dir)?;
    if !is_writable_dir(&dir) {
        return Err(AppError::Other("SYNC_FOLDER_NOT_WRITABLE".to_string()));
    }
    Ok(dir)
}

fn create_default_dir_in(root: &Path) -> AppResult<PathBuf> {
    // No iCloud Drive root means the feature is off on this Mac, which is a
    // different problem from "the folder you chose is missing" and must not
    // borrow that error's advice to go pick the folder again.
    if !root.is_dir() {
        return Err(AppError::Other("ICLOUD_DRIVE_UNAVAILABLE".to_string()));
    }
    let dir = root.join(DEFAULT_SYNC_FOLDER_NAME);

    fs::create_dir_all(&dir)?;
    if !is_writable_dir(&dir) {
        return Err(AppError::Other("SYNC_FOLDER_NOT_WRITABLE".to_string()));
    }
    Ok(dir)
}

/// True when `dir` is a folder Lantern named for itself, rather than one the
/// user picked in Finder.
///
/// Only the former is safe to silently re-create after it goes missing. A
/// hand-picked folder is a decision — replacing it with the default would
/// discard that decision, republish the whole library somewhere else, and
/// leave the other device syncing to a folder this one has forgotten.
#[cfg(not(target_os = "ios"))]
pub fn is_lantern_default_dir(dir: &Path) -> bool {
    icloud_drive_root().is_some_and(|root| is_default_dir_in(&root, dir))
}

/// Always true on iOS, and that is the point: the container is the only folder
/// this app can sync to, so there is no hand-picked decision to protect. The
/// caller's "silently re-create it if it went missing" branch is exactly what
/// should happen here.
#[cfg(target_os = "ios")]
pub fn is_lantern_default_dir(dir: &Path) -> bool {
    ubiquity_sync_root().is_some_and(|root| dir == root)
}

#[cfg(not(target_os = "ios"))]
fn is_default_dir_in(root: &Path, dir: &Path) -> bool {
    dir.parent() == Some(root) && dir.file_name() == Some(DEFAULT_SYNC_FOLDER_NAME.as_ref())
}

/// Guards against a recorded path that no longer belongs to iCloud — the marker
/// is user-editable local state, so its raw path is never authority.
#[cfg(not(target_os = "ios"))]
pub fn is_icloud_drive_dir(path: &Path) -> bool {
    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };
    let Ok(root) = PathBuf::from(home)
        .join("Library/Mobile Documents")
        .canonicalize()
    else {
        return false;
    };
    is_dir_under(&root, path)
}

/// The same guard, against the container rather than the user's iCloud Drive.
/// A path recorded by some earlier build, or by a desktop that syncs to a
/// picked folder, fails this and sync stays off rather than writing somewhere
/// the phone cannot reach.
#[cfg(target_os = "ios")]
pub fn is_icloud_drive_dir(path: &Path) -> bool {
    let Some(container) = crate::icloud::ubiquity_container_dir() else {
        return false;
    };
    let Ok(root) = container.canonicalize() else {
        return false;
    };
    is_dir_under(&root, path)
}

/// Compared after canonicalising both sides, so a symlinked or `/private`-
/// prefixed spelling of the same directory still matches — on Apple platforms
/// the same path routinely has both spellings.
fn is_dir_under(root: &Path, path: &Path) -> bool {
    let Ok(selected) = path.canonicalize() else {
        return false;
    };
    selected.starts_with(root)
}

pub fn is_writable_dir(path: &Path) -> bool {
    let probe = path.join(format!(".lantern-write-probe-{}", uuid::Uuid::new_v4()));
    match fs::write(&probe, []) {
        Ok(()) => {
            let _ = fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

fn write_settings(local_dir: &Path, settings: &SyncSettings) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|e| AppError::Other(format!("serialize sync settings: {e}")))?;
    fs::write(sync_settings_path(local_dir), bytes)?;
    Ok(())
}

pub fn set_shared_dir(local_dir: &Path, data_dir: &Path) -> AppResult<()> {
    let existing = read_sync_settings(local_dir);
    let settings = SyncSettings {
        enabled: existing.is_some_and(|settings| settings.enabled),
        data_dir: Some(data_dir.to_string_lossy().into_owned()),
    };
    write_settings(local_dir, &settings)
}

pub fn set_sync_enabled(local_dir: &Path, enabled: bool) -> AppResult<()> {
    let mut settings = read_sync_settings(local_dir)
        .ok_or_else(|| AppError::Other("SYNC_FOLDER_NOT_CONFIGURED".to_string()))?;
    if settings.data_dir.as_deref().is_none_or(str::is_empty) {
        return Err(AppError::Other("SYNC_FOLDER_NOT_CONFIGURED".to_string()));
    }
    settings.enabled = enabled;
    write_settings(local_dir, &settings)
}

pub fn write_sync_settings(local_dir: &Path, data_dir: Option<&Path>) -> AppResult<()> {
    let data_dir =
        data_dir.ok_or_else(|| AppError::Other("SYNC_FOLDER_NOT_CONFIGURED".to_string()))?;
    set_shared_dir(local_dir, data_dir)?;
    set_sync_enabled(local_dir, true)
}

pub fn remove_sync_settings(local_dir: &Path) -> AppResult<()> {
    let path = sync_settings_path(local_dir);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn not_enabled_by_default() {
        let local = TempDir::new().unwrap();
        assert!(!is_sync_enabled(local.path()));
        assert_eq!(recorded_data_dir(local.path()), None);
    }

    #[test]
    fn write_then_read_round_trips() {
        let local = TempDir::new().unwrap();
        let data_dir = Path::new("/tmp/some/icloud/path");
        write_sync_settings(local.path(), Some(data_dir)).unwrap();
        assert!(is_sync_enabled(local.path()));
        assert_eq!(recorded_data_dir(local.path()).as_deref(), Some(data_dir));
    }

    #[test]
    fn remove_clears_settings() {
        let local = TempDir::new().unwrap();
        write_sync_settings(local.path(), Some(Path::new("/tmp"))).unwrap();
        assert!(is_sync_enabled(local.path()));
        remove_sync_settings(local.path()).unwrap();
        assert!(!is_sync_enabled(local.path()));
    }

    #[test]
    fn the_default_folder_is_created_under_the_icloud_root() {
        let root = TempDir::new().unwrap();
        let dir = create_default_dir_in(root.path()).unwrap();
        assert_eq!(dir, root.path().join("lantern"));
        assert!(dir.is_dir());
    }

    #[test]
    fn creating_the_default_folder_twice_is_not_an_error() {
        let root = TempDir::new().unwrap();
        let first = create_default_dir_in(root.path()).unwrap();
        fs::write(first.join("keep-me"), b"x").unwrap();

        let second = create_default_dir_in(root.path()).unwrap();
        assert_eq!(first, second);
        assert!(
            second.join("keep-me").is_file(),
            "existing contents survive"
        );
    }

    /// iCloud Drive being off is not the same problem as a chosen folder
    /// having gone missing, and must not reuse that error — its advice is to
    /// pick the folder again, which cannot help here.
    #[test]
    fn no_icloud_root_reports_icloud_drive_unavailable() {
        let missing = TempDir::new().unwrap().path().join("gone");
        let error = create_default_dir_in(&missing).unwrap_err().to_string();
        assert!(
            error.contains("ICLOUD_DRIVE_UNAVAILABLE"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn a_folder_inside_the_root_is_under_it_and_a_sibling_is_not() {
        let root = TempDir::new().unwrap();
        let inside = root.path().join("books");
        fs::create_dir_all(&inside).unwrap();
        // canonicalize() resolves /var -> /private/var on macOS, so the root
        // has to be spelled the same way the function will see the child.
        let canonical_root = root.path().canonicalize().unwrap();

        assert!(is_dir_under(&canonical_root, &inside));
        assert!(is_dir_under(&canonical_root, root.path()));

        let outside = TempDir::new().unwrap();
        assert!(!is_dir_under(&canonical_root, outside.path()));
    }

    /// A path that isn't there yet cannot be canonicalised, and an
    /// uncanonicalised comparison is exactly the one that gets spoofed by a
    /// `/private` or symlink spelling. Answering "not under it" keeps sync off
    /// rather than pointing it at an unverified location.
    #[test]
    fn a_path_that_does_not_exist_is_not_under_anything() {
        let root = TempDir::new().unwrap();
        let canonical_root = root.path().canonicalize().unwrap();
        assert!(!is_dir_under(&canonical_root, &root.path().join("gone")));
    }

    #[test]
    #[cfg(not(target_os = "ios"))]
    fn only_folders_lantern_named_itself_count_as_the_default() {
        let root = Path::new("/Users/someone/Library/Mobile Documents/com~apple~CloudDocs");
        assert!(is_default_dir_in(root, &root.join("lantern")));

        // A folder the user picked, even one that merely contains the name.
        assert!(!is_default_dir_in(root, &root.join("my books")));
        assert!(!is_default_dir_in(root, &root.join("lantern-backup")));
        // Same name, but somewhere the user had to navigate to on purpose.
        assert!(!is_default_dir_in(root, &root.join("Documents/lantern")));
        assert!(!is_default_dir_in(root, Path::new("/tmp/lantern")));
    }

    #[test]
    fn selected_dir_stays_disabled_until_explicitly_enabled() {
        let local = TempDir::new().unwrap();
        let data_dir = local.path().join("shared");
        set_shared_dir(local.path(), &data_dir).unwrap();
        assert!(!is_sync_enabled(local.path()));
        assert_eq!(
            recorded_data_dir(local.path()).as_deref(),
            Some(data_dir.as_path())
        );
        set_sync_enabled(local.path(), true).unwrap();
        assert!(is_sync_enabled(local.path()));
    }
}
