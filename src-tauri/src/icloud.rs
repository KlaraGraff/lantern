//! iCloud Drive helpers — file-presence checks for a user-selected folder.
//!
//! - **Eviction handling** (`is_file_downloaded`,
//!   `icloud_placeholder_path`, `has_icloud_placeholder`,
//!   `trigger_download_file`) for book and cover binaries that live in
//!   iCloud Documents and may be evicted.

use std::path::{Path, PathBuf};

#[cfg(target_vendor = "apple")]
use objc2_foundation::{NSFileManager, NSString};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileAvailability {
    Available,
    ICloudPlaceholder,
    Missing,
    /// The path is there and `stat` is happy, but the bytes cannot be read:
    /// a permission problem, a disconnected network volume, a truncated stub.
    /// Only `file_readability` ever returns this — a `stat` cannot see it.
    Unreadable,
}

impl FileAvailability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::ICloudPlaceholder => "icloud_placeholder",
            Self::Missing => "missing",
            Self::Unreadable => "unreadable",
        }
    }
}

/// Classify a book path without treating every missing path as an iCloud
/// download. A missing local file needs a different recovery path from an
/// evicted iCloud item.
pub fn file_availability(path: &Path) -> FileAvailability {
    if path.exists() {
        FileAvailability::Available
    } else if has_icloud_placeholder(path) {
        FileAvailability::ICloudPlaceholder
    } else {
        FileAvailability::Missing
    }
}

/// Check whether a file is locally available (not an iCloud placeholder).
///
/// iCloud evicts files by replacing `foo.epub` with `.foo.epub.icloud`.
/// Returns `true` if the real file exists on disk.
pub fn is_file_downloaded(path: &Path) -> bool {
    file_availability(path) == FileAvailability::Available
}

/// The deeper probe behind `file_availability`, for use **after** something has
/// actually failed to open the file — never on a library refresh.
///
/// `file_availability` only asks the filesystem whether a name resolves, and
/// that answer is not the same question as "can this be read". Two cases slip
/// through it: a ubiquitous item iCloud has materialised without downloading,
/// which `stat` reports at its full logical size and no `.icloud` sidecar marks;
/// and a path on a volume that has gone away, where the entry survives in cache
/// but every read fails.
///
/// The download status is checked before any read is attempted, because reading
/// a byte of a not-yet-downloaded ubiquitous item blocks until iCloud has
/// fetched the whole file — on a large book over a slow link, indefinitely.
/// Once the status says the bytes are here, one byte is read to confirm it.
pub fn file_readability(path: &Path) -> FileAvailability {
    match file_availability(path) {
        FileAvailability::Available => {}
        other => return other,
    }
    if is_awaiting_icloud_download(path) {
        return FileAvailability::ICloudPlaceholder;
    }
    match read_first_byte(path) {
        Ok(()) => FileAvailability::Available,
        Err(_) => FileAvailability::Unreadable,
    }
}

/// An empty file is readable — `read` returning 0 bytes at EOF is not an error.
fn read_first_byte(path: &Path) -> std::io::Result<()> {
    use std::io::Read;
    let mut byte = [0u8; 1];
    // The count is deliberately unused: zero bytes is EOF on an empty file, and
    // the question here is only whether the read itself was refused.
    let _count = std::fs::File::open(path)?.read(&mut byte)?;
    Ok(())
}

/// The app's own iCloud ubiquity container, or `None` when there isn't one.
///
/// `None` is an ordinary answer, not an error: it is what a build without the
/// iCloud Documents entitlement gets, what a device with iCloud Drive switched
/// off gets, and what an account-less device gets. Callers treat it as "sync is
/// unavailable here" rather than as a failure to report.
///
/// This is the iOS answer to the question macOS answers by asking the user to
/// pick a folder. A sandboxed iOS app cannot see `~/Library/Mobile
/// Documents/com~apple~CloudDocs` at all, so there is nothing to pick from and
/// no path to hardcode — only the container Foundation hands back for this
/// bundle identifier.
///
/// **This blocks.** Apple documents the first call as setting the container up
/// on disk, and warns against calling it on the main thread. Callers are
/// command handlers on Tauri's async runtime, which is off the UI thread;
/// anything that moves this call has to preserve that.
///
/// **iOS-only on purpose.** macOS still syncs to a folder the user picked, so
/// it has no caller here and a `target_vendor` gate would only be dead code on
/// the desktop. Q-004 — relocating macOS into this same container so the two
/// platforms actually meet — is what widens it.
#[cfg(target_os = "ios")]
pub fn ubiquity_container_dir() -> Option<PathBuf> {
    use objc2_foundation::NSFileManager;

    let fm = NSFileManager::defaultManager();
    // Passing nil asks for the first container in the entitlement's list, which
    // is the app's own. Naming it explicitly would duplicate the identifier
    // that already lives in the entitlement, and the two would drift.
    let url = fm.URLForUbiquityContainerIdentifier(None)?;
    let path = url.path()?;
    Some(PathBuf::from(path.to_string()))
}

/// True when the path is an iCloud item whose contents are not on this machine
/// yet. Answered from the item's resource values, so it never blocks on a
/// download the way opening the file would.
#[cfg(target_vendor = "apple")]
fn is_awaiting_icloud_download(path: &Path) -> bool {
    use objc2_foundation::{
        NSURLUbiquitousItemDownloadingStatusKey, NSURLUbiquitousItemDownloadingStatusNotDownloaded,
        NSURL,
    };

    let path_str = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path_str);
    let mut value = None;
    // SAFETY: the downloading-status key is documented to yield an NSString,
    // and the value is only compared as one.
    let read = unsafe {
        url.getResourceValue_forKey_error(&mut value, NSURLUbiquitousItemDownloadingStatusKey)
    };
    if read.is_err() {
        return false;
    }
    // A non-ubiquitous file has no value for the key at all, which is not an
    // error and not a reason to call it undownloaded.
    let Some(status) = value.and_then(|value| value.downcast::<NSString>().ok()) else {
        return false;
    };
    // SAFETY: reading a Foundation string constant, immutable for the process.
    let not_downloaded = unsafe { NSURLUbiquitousItemDownloadingStatusNotDownloaded };
    *status == *not_downloaded
}

#[cfg(not(target_vendor = "apple"))]
fn is_awaiting_icloud_download(_path: &Path) -> bool {
    false
}

/// Returns the iCloud placeholder path for a given file.
/// e.g. `/dir/foo.epub` → `/dir/.foo.epub.icloud`
#[allow(dead_code)]
pub fn icloud_placeholder_path(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    let name = path.file_name()?.to_str()?;
    Some(parent.join(format!(".{}.icloud", name)))
}

/// Check if a file has an iCloud placeholder (evicted by iCloud).
#[allow(dead_code)]
pub fn has_icloud_placeholder(path: &Path) -> bool {
    icloud_placeholder_path(path).is_some_and(|p| p.exists())
}

/// Trigger iCloud to download a specific file.
#[cfg(target_vendor = "apple")]
pub fn trigger_download_file(path: &Path) {
    use objc2_foundation::NSURL;
    let fm = NSFileManager::defaultManager();
    let path_str = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path_str);
    let _ = fm.startDownloadingUbiquitousItemAtURL_error(&url);
}

#[cfg(not(target_vendor = "apple"))]
pub fn trigger_download_file(_path: &Path) {}

/// Release the local bytes of an iCloud-backed file without deleting the
/// shared item. Returns `false` when the path is not an evictable ubiquitous
/// item or the platform does not support iCloud Drive.
// Both halves of the eviction pair are called only from the OCR manager, which
// does not compile for mobile (D-003), so on iOS they are live code with no
// caller yet — P5 gives them one. Without this, an iOS clippy job would fail on
// `-D warnings` the day P6 adds it.
#[allow(dead_code)]
#[cfg(target_vendor = "apple")]
pub fn is_ubiquitous_file(path: &Path) -> bool {
    use objc2_foundation::NSURL;
    let fm = NSFileManager::defaultManager();
    let path_str = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path_str);
    fm.isUbiquitousItemAtURL(&url)
}

#[cfg(not(target_vendor = "apple"))]
pub fn is_ubiquitous_file(_path: &Path) -> bool {
    false
}

#[allow(dead_code)] // see is_ubiquitous_file
#[cfg(target_vendor = "apple")]
pub fn evict_downloaded_file(path: &Path) -> bool {
    use objc2_foundation::NSURL;
    let fm = NSFileManager::defaultManager();
    let path_str = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path_str);
    fm.evictUbiquitousItemAtURL_error(&url).is_ok()
}

#[cfg(not(target_vendor = "apple"))]
pub fn evict_downloaded_file(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // --- is_file_downloaded ---

    #[test]
    fn test_is_file_downloaded_real_file_exists() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        fs::write(&file, "epub data").unwrap();
        assert!(is_file_downloaded(&file));
    }

    #[test]
    fn test_is_file_downloaded_missing_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        assert!(!is_file_downloaded(&file));
    }

    #[test]
    fn test_is_file_downloaded_placeholder_only() {
        let dir = TempDir::new().unwrap();
        // Real file doesn't exist, but placeholder does
        let placeholder = dir.path().join(".book.epub.icloud");
        fs::write(&placeholder, "placeholder").unwrap();
        let file = dir.path().join("book.epub");
        assert!(!is_file_downloaded(&file));
    }

    #[test]
    fn file_availability_distinguishes_missing_from_placeholder() {
        let dir = TempDir::new().unwrap();
        let available = dir.path().join("available.epub");
        fs::write(&available, "epub data").unwrap();
        assert_eq!(file_availability(&available), FileAvailability::Available);

        let missing = dir.path().join("missing.epub");
        assert_eq!(file_availability(&missing), FileAvailability::Missing);

        fs::write(dir.path().join(".evicted.epub.icloud"), "placeholder").unwrap();
        let evicted = dir.path().join("evicted.epub");
        assert_eq!(
            file_availability(&evicted),
            FileAvailability::ICloudPlaceholder
        );
    }

    // --- file_readability ---

    #[test]
    fn readability_confirms_a_file_whose_bytes_are_there() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        fs::write(&file, "epub data").unwrap();
        assert_eq!(file_readability(&file), FileAvailability::Available);
    }

    #[test]
    fn readability_accepts_an_empty_file() {
        // Reading zero bytes at EOF is not a read error, and an empty book is a
        // problem for the parser to report, not for the availability probe to
        // relabel as an unreadable disk.
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("empty.epub");
        fs::write(&file, b"").unwrap();
        assert_eq!(file_readability(&file), FileAvailability::Available);
    }

    #[test]
    fn readability_reports_a_present_but_unreadable_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        fs::write(&file, "epub data").unwrap();
        // `stat` still resolves the name; opening it does not.
        let mut permissions = fs::metadata(&file).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o000);
        }
        #[cfg(not(unix))]
        permissions.set_readonly(true);
        fs::set_permissions(&file, permissions).unwrap();

        // Root ignores the mode bits, so the case under test cannot be staged.
        if fs::File::open(&file).is_ok() {
            return;
        }
        assert_eq!(file_availability(&file), FileAvailability::Available);
        assert_eq!(file_readability(&file), FileAvailability::Unreadable);
    }

    #[test]
    fn readability_passes_the_cheap_verdicts_through_unchanged() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("missing.epub");
        assert_eq!(file_readability(&missing), FileAvailability::Missing);

        fs::write(dir.path().join(".evicted.epub.icloud"), "placeholder").unwrap();
        let evicted = dir.path().join("evicted.epub");
        assert_eq!(
            file_readability(&evicted),
            FileAvailability::ICloudPlaceholder
        );
    }

    #[test]
    fn unreadable_has_its_own_wire_name() {
        assert_eq!(FileAvailability::Unreadable.as_str(), "unreadable");
    }

    // --- icloud_placeholder_path ---

    #[test]
    fn test_icloud_placeholder_path() {
        let path = Path::new("/data/books/my-book_abc12345.epub");
        let placeholder = icloud_placeholder_path(path).unwrap();
        assert_eq!(
            placeholder,
            PathBuf::from("/data/books/.my-book_abc12345.epub.icloud")
        );
    }

    // --- has_icloud_placeholder ---

    #[test]
    fn test_has_icloud_placeholder_true() {
        let dir = TempDir::new().unwrap();
        let placeholder = dir.path().join(".book.epub.icloud");
        fs::write(&placeholder, "placeholder").unwrap();
        let file = dir.path().join("book.epub");
        assert!(has_icloud_placeholder(&file));
    }

    #[test]
    fn test_has_icloud_placeholder_false() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        assert!(!has_icloud_placeholder(&file));
    }
}
