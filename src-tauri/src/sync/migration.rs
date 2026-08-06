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

/// The app's iCloud container as the filesystem spells it: under
/// `Library/Mobile Documents` the dots of `iCloud.com.klaragraff.lantern`
/// become tildes.
#[cfg(not(target_os = "ios"))]
const UBIQUITY_CONTAINER_DIR: &str = "iCloud~com~klaragraff~lantern";

/// Only this subtree of the container is eligible to surface in iCloud Drive
/// under `NSUbiquitousContainers`, so it is the sync root on both platforms.
const UBIQUITY_DOCUMENTS_DIR: &str = "Documents";

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

/// The app's own ubiquity container on this Mac — the same container the phone
/// syncs through, which is the only way the two ever meet
/// ([D-015](../../../docs/roadmap/mobile-ios.md)). Built from `HOME` rather
/// than probed, so it answers for a path that does not exist yet.
///
/// Spelled out by hand instead of resolved through
/// `URLForUbiquityContainerIdentifier`, because that API needs the iCloud
/// entitlement, and entitling a Developer ID build means an embedded
/// provisioning profile and a changed signing pipeline. Plain file I/O into the
/// container needs neither: the CloudDocs daemon syncs the directory because
/// `Info.plist` declares `NSUbiquitousContainers`, not because the binary is
/// entitled.
///
/// Desktop only. A sandboxed iOS app cannot reach a path spelled from `HOME`,
/// so on iOS this would name a path every later check then fails on; iOS
/// resolves its container through [`ubiquity_sync_root`] instead.
#[cfg(not(target_os = "ios"))]
fn ubiquity_container_root() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library/Mobile Documents")
            .join(UBIQUITY_CONTAINER_DIR)
    })
}

/// The mobile sync root: `Documents` inside the app's own ubiquity container.
///
/// `Documents` rather than the container root because only that subtree is
/// eligible to appear in iCloud Drive under `NSUbiquitousContainers`, which
/// `lantern_iOS/Info.plist` declares — that is what makes these files visible
/// in Files and Finder as "Lantern" rather than an invisible container.
///
/// Neither platform puts a folder of its own inside `Documents`: the container
/// belongs to this app already, so a `lantern` subfolder inside it would only
/// be nesting.
#[cfg(target_os = "ios")]
fn ubiquity_sync_root() -> Option<PathBuf> {
    crate::icloud::ubiquity_container_dir().map(|dir| dir.join(UBIQUITY_DOCUMENTS_DIR))
}

/// Creates the one folder Lantern syncs to, or returns it if it already exists.
/// Idempotent, and the only way a sync folder ever comes into being — there is
/// nothing for the user to pick.
///
/// The returned path is not checked for being inside the container: it is built
/// from the container root, so the check would only be able to fail on a bug,
/// and it would make this function untestable.
#[cfg(not(target_os = "ios"))]
pub fn create_default_icloud_dir() -> AppResult<PathBuf> {
    let root = ubiquity_container_root()
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
    let dir = ubiquity_sync_root()
        .ok_or_else(|| AppError::Other("ICLOUD_DRIVE_UNAVAILABLE".to_string()))?;
    fs::create_dir_all(&dir)?;
    if !is_writable_dir(&dir) {
        return Err(AppError::Other("SYNC_FOLDER_NOT_WRITABLE".to_string()));
    }
    Ok(dir)
}

/// `root` is the container directory; the folder created inside it is
/// `Documents`.
///
/// The container itself is never created here, and that is the whole reason
/// this is not a single `create_dir_all`. Directories under
/// `Library/Mobile Documents` are provisioned by the CloudDocs daemon when it
/// learns the container; one made by hand is byte-identical on disk, is not
/// registered, and never syncs. So a missing container means iCloud Drive is
/// off or the container has not been provisioned yet — the same dead end as no
/// iCloud Drive at all, and a different problem from "the folder you chose is
/// missing", which must not borrow that error's advice to go pick the folder
/// again.
fn create_default_dir_in(root: &Path) -> AppResult<PathBuf> {
    if !root.is_dir() {
        return Err(AppError::Other("ICLOUD_DRIVE_UNAVAILABLE".to_string()));
    }
    let dir = root.join(UBIQUITY_DOCUMENTS_DIR);

    fs::create_dir_all(&dir)?;
    if !is_writable_dir(&dir) {
        return Err(AppError::Other("SYNC_FOLDER_NOT_WRITABLE".to_string()));
    }
    Ok(dir)
}

/// Guards against a recorded path that no longer belongs to the container — the
/// marker is user-editable local state, so its raw path is never authority.
///
/// Checked against this app's container rather than `Library/Mobile Documents`
/// at large, which is what it used to accept. Since
/// [D-015](../../../docs/roadmap/mobile-ios.md) there is exactly one legal sync
/// folder, and the wider test would pass a path in some other app's container —
/// as unreachable from the phone as a path outside iCloud entirely.
#[cfg(not(target_os = "ios"))]
pub fn is_icloud_drive_dir(path: &Path) -> bool {
    let Some(container) = ubiquity_container_root() else {
        return false;
    };
    let Ok(root) = container.canonicalize() else {
        return false;
    };
    is_dir_under(&root, path)
}

/// The same guard, resolving the container through the entitled API rather than
/// from `HOME`. A path recorded by some earlier build fails this and sync stays
/// off rather than writing somewhere the phone cannot reach.
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
    fn the_sync_folder_is_documents_inside_the_container() {
        let root = TempDir::new().unwrap();
        let dir = create_default_dir_in(root.path()).unwrap();
        assert_eq!(dir, root.path().join("Documents"));
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

    /// A directory made by hand under `Library/Mobile Documents` looks right
    /// and never syncs, because only the CloudDocs daemon registers one. So a
    /// container that is not there has to stay not there — and the error it
    /// reports is the iCloud-is-off one, not the chosen-folder-is-missing one,
    /// whose advice is to go pick the folder again.
    #[test]
    fn a_missing_container_is_reported_rather_than_created() {
        let parent = TempDir::new().unwrap();
        let container = parent.path().join("iCloud~com~klaragraff~lantern");

        let error = create_default_dir_in(&container).unwrap_err().to_string();
        assert!(
            error.contains("ICLOUD_DRIVE_UNAVAILABLE"),
            "unexpected error: {error}"
        );
        assert!(
            !container.exists(),
            "the container must not be created here"
        );
    }

    #[cfg(not(target_os = "ios"))]
    #[test]
    fn the_desktop_root_is_the_apps_own_container() {
        let root = ubiquity_container_root().expect("HOME is set");
        assert!(
            root.ends_with("Library/Mobile Documents/iCloud~com~klaragraff~lantern"),
            "unexpected container root: {}",
            root.display()
        );
    }

    /// Needs a Mac signed into iCloud that has already been given the
    /// container — the daemon provisions it and this code must not, so there is
    /// nothing a test can set up. Ignored rather than deleted: it is the only
    /// check that the constructed path is the one the daemon actually made.
    #[cfg(not(target_os = "ios"))]
    #[test]
    #[ignore]
    fn the_real_container_yields_a_writable_documents_dir() {
        let dir = create_default_icloud_dir().unwrap();
        assert!(dir.ends_with("Documents"));
        assert!(is_icloud_drive_dir(&dir));
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
