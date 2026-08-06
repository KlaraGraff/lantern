//! Keeping regenerable files out of the phone's backup.
//!
//! Everything an iOS app writes under `Library/Application Support` and
//! `Library/Logs` is copied into iCloud Backup. The free tier is 5 GB
//! for the whole device, and the speech cache alone is allowed to reach
//! 2 GiB before it starts evicting — a reader who uses pronunciation
//! audio could quietly consume half of someone's backup allowance with
//! audio clips that re-download in milliseconds. Apple's storage
//! guidelines treat that as an app defect, and App Review has rejected
//! apps for it.
//!
//! The fix is one resource key, `NSURLIsExcludedFromBackupKey`, set on
//! the directory. It covers files added later, so it is set on the
//! container rather than on each file as it is written.
//!
//! **Excluded is not deleted.** The files stay exactly where they are
//! and keep working; they simply do not survive restoring the device
//! from a backup, which for a cache is the correct outcome and for a log
//! file is no outcome at all.
//!
//! Only iOS calls this. The same key steers Time Machine on macOS, but a
//! Mac backs up to a disk the user bought, so there is no allowance to
//! protect and no reason to make a restored Mac forget its own logs.

use std::path::Path;

/// Mark one directory as regenerable. Returns whether the flag is now
/// set; `false` means the backup will be larger than it needed to be,
/// which is worth a log line and nothing more.
///
/// Compiled on every Apple target although only iOS calls it, so that
/// the tests below can exercise the real Foundation call on a Mac
/// instead of asserting against a stub.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
#[cfg(target_vendor = "apple")]
pub fn exclude_from_backup(path: &Path) -> bool {
    use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};

    let path_str = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path_str);
    let excluded = NSNumber::new_bool(true);

    // SAFETY: `NSURLIsExcludedFromBackupKey` is documented to take a
    // boolean NSNumber, which is what is passed.
    let result =
        unsafe { url.setResourceValue_forKey_error(Some(&excluded), NSURLIsExcludedFromBackupKey) };
    result.is_ok()
}

#[cfg(not(target_vendor = "apple"))]
pub fn exclude_from_backup(_path: &Path) -> bool {
    false
}

/// Everything under the app-data directory that the app can rebuild from
/// what it already has.
///
/// Deliberately short. `books/`, `covers/`, `sources/`,
/// `imported-fonts/`, `lantern.db` and `secrets.db` are all absent
/// because losing any of them in a restore would lose the reader
/// something they cannot get back by waiting.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
const REGENERABLE_SUBDIRS: [&str; 2] = [
    // Pronunciation audio, re-fetched from the network on demand.
    "speech-cache",
    // Per-book prepared text, recomputed from the book file itself.
    "prepared",
];

/// Exclude the caches and the log directory from device backup. No-op
/// off iOS.
#[cfg(not(target_os = "ios"))]
pub fn exclude_regenerable_paths(_local_dir: &Path) {}

/// Exclude the caches and the log directory from device backup.
///
/// Runs on every launch rather than once at install. The flag lives in
/// an extended attribute on the directory, so it dies whenever the
/// directory does — and these directories are exactly the ones that get
/// deleted, by the cache trimmer or by a user clearing storage. Re-doing
/// it costs three Foundation calls.
///
/// Each directory is created first: the key can only be set on something
/// that exists, and the alternative — waiting for first use — would let
/// the window between first write and next launch go into a backup.
#[cfg(target_os = "ios")]
pub fn exclude_regenerable_paths(local_dir: &Path) {
    let mut targets: Vec<std::path::PathBuf> = REGENERABLE_SUBDIRS
        .iter()
        .map(|name| local_dir.join(name))
        .collect();
    targets.push(crate::resolve_log_dir());

    for target in targets {
        if let Err(e) = std::fs::create_dir_all(&target) {
            log::warn!(
                "backup: cannot create {} to exclude it: {e}",
                target.display()
            );
            continue;
        }
        if exclude_from_backup(&target) {
            log::info!("backup: excluded {}", target.display());
        } else {
            log::warn!("backup: failed to exclude {}", target.display());
        }
    }
}

#[cfg(all(test, target_vendor = "apple"))]
mod tests {
    use super::exclude_from_backup;
    use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};
    use std::path::Path;
    use tempfile::TempDir;

    /// Ask Foundation what it thinks, rather than trusting the setter's
    /// return value or guessing the extended attribute's name.
    fn is_excluded(path: &Path) -> Option<bool> {
        let path_str = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path_str);
        let mut value = None;
        // SAFETY: the key is documented to yield a boolean NSNumber, and
        // the value is only read as one.
        unsafe { url.getResourceValue_forKey_error(&mut value, NSURLIsExcludedFromBackupKey) }
            .ok()?;
        Some(value?.downcast::<NSNumber>().ok()?.as_bool())
    }

    #[test]
    fn a_directory_is_excluded_and_foundation_agrees() {
        let dir = TempDir::new().expect("tempdir");
        let cache = dir.path().join("speech-cache");
        std::fs::create_dir_all(&cache).expect("create cache dir");

        assert_eq!(
            is_excluded(&cache),
            Some(false),
            "a fresh directory should not already be excluded"
        );
        assert!(exclude_from_backup(&cache));
        assert_eq!(is_excluded(&cache), Some(true));
    }

    /// The whole approach rests on this: the flag is set once on the
    /// directory and has to cover files written afterwards.
    #[test]
    fn the_flag_survives_files_added_after_it_was_set() {
        let dir = TempDir::new().expect("tempdir");
        let cache = dir.path().join("speech-cache");
        std::fs::create_dir_all(&cache).expect("create cache dir");
        assert!(exclude_from_backup(&cache));

        std::fs::write(cache.join("clip.bin"), b"audio").expect("write clip");
        assert_eq!(
            is_excluded(&cache),
            Some(true),
            "writing into the directory cleared the exclusion"
        );
    }

    /// A directory that was deleted and recreated has lost the attribute,
    /// which is why this runs at every launch instead of once.
    #[test]
    fn recreating_the_directory_drops_the_flag() {
        let dir = TempDir::new().expect("tempdir");
        let cache = dir.path().join("speech-cache");
        std::fs::create_dir_all(&cache).expect("create cache dir");
        assert!(exclude_from_backup(&cache));

        std::fs::remove_dir_all(&cache).expect("remove cache dir");
        std::fs::create_dir_all(&cache).expect("recreate cache dir");
        assert_eq!(is_excluded(&cache), Some(false));
    }

    /// A path that is not there yet cannot carry the flag — the reason
    /// `exclude_regenerable_paths` creates each directory first.
    #[test]
    fn a_missing_path_fails_rather_than_pretending() {
        let dir = TempDir::new().expect("tempdir");
        assert!(!exclude_from_backup(&dir.path().join("never-created")));
    }
}
