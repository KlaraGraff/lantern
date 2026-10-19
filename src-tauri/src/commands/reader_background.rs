//! The reader's background picture: one image the reader picks from disk,
//! copied in so it survives the original being moved or deleted.
//!
//! **Local only, on purpose.** The file goes under Tauri's own app data dir,
//! not `Db::data_dir()` — that one is the iCloud container when sync is on, and
//! a picture there would replicate to devices whose `reader_background` setting
//! (also local, see `is_syncable_setting`) never points at it. One device, one
//! picture, one folder.
//!
//! The folder only ever holds the current picture. Importing replaces whatever
//! was there; clearing empties it. The file name is a hash of the bytes, so a
//! new picture is a new URL and the webview cannot serve a stale cached copy.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};

/// Generous for a photo, small enough that a mistaken pick of a RAW file or a
/// poster-sized scan fails loudly instead of being decoded behind every page.
const MAX_IMAGE_BYTES: u64 = 30 * 1024 * 1024;
const PICKER_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
const DIR_NAME: &str = "reader-backgrounds";

fn background_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Other(error.to_string()))?;
    Ok(base.join(DIR_NAME))
}

/// The format by content, not by name: a `.jpg` that is really a HEIC would
/// otherwise be accepted here and silently fail to render in the reader.
fn sniff_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else {
        None
    }
}

/// Remove every file in `dir` except `keep`. Missing dir is fine.
fn prune(dir: &Path, keep: Option<&Path>) -> AppResult<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let path = entry?.path();
        if keep == Some(path.as_path()) || !path.is_file() {
            continue;
        }
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// Copy `source` into `dir` as the one background picture and return where it
/// landed. Pure filesystem work, so the tests can drive it without an app.
pub(crate) fn import_into(dir: &Path, source: &Path) -> AppResult<PathBuf> {
    let size = fs::metadata(source)?.len();
    if size == 0 || size > MAX_IMAGE_BYTES {
        return Err(AppError::Other(
            "READER_BACKGROUND_SIZE_INVALID".to_string(),
        ));
    }
    let bytes = fs::read(source)?;
    let format = sniff_format(&bytes)
        .ok_or_else(|| AppError::Other("READER_BACKGROUND_FORMAT_INVALID".to_string()))?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    fs::create_dir_all(dir)?;
    let destination = dir.join(format!("{hash}.{format}"));
    if !destination.exists() {
        let mut staging = tempfile::Builder::new()
            .prefix(".background.")
            .suffix(".tmp")
            .tempfile_in(dir)?;
        staging.write_all(&bytes)?;
        staging.as_file().sync_all()?;
        staging
            .persist(&destination)
            .map_err(|error| AppError::Io(error.error))?;
    }
    prune(dir, Some(&destination))?;
    Ok(destination)
}

/// Ask for a picture and copy it in. `None` when the picker was cancelled.
#[tauri::command]
pub async fn import_reader_background(app: AppHandle) -> AppResult<Option<String>> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Images", PICKER_EXTENSIONS)
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let source = picked
        .into_path()
        .map_err(|_| AppError::Other("READER_BACKGROUND_PATH_INVALID".to_string()))?;
    let destination = import_into(&background_dir(&app)?, &source)?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

/// Delete the stored picture. The setting that points at it is the caller's.
#[tauri::command]
pub fn clear_reader_background(app: AppHandle) -> AppResult<()> {
    prune(&background_dir(&app)?, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F'];

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn sniffs_formats_by_content() {
        assert_eq!(sniff_format(PNG), Some("png"));
        assert_eq!(sniff_format(JPEG), Some("jpg"));
        assert_eq!(sniff_format(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_format(b"GIF89a..."), Some("gif"));
        assert_eq!(sniff_format(b"\0\0\0\x18ftypheic"), None);
        assert_eq!(sniff_format(b""), None);
    }

    #[test]
    fn import_copies_under_a_content_hash_and_replaces_the_previous_picture() {
        let source_dir = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let dir = store.path().join(DIR_NAME);

        let first = import_into(&dir, &write(source_dir.path(), "a.png", PNG)).unwrap();
        assert_eq!(first.extension().unwrap(), "png");
        assert_eq!(fs::read(&first).unwrap(), PNG);

        // Named .png but holding a JPEG: the content decides the extension.
        let second = import_into(&dir, &write(source_dir.path(), "b.png", JPEG)).unwrap();
        assert_eq!(second.extension().unwrap(), "jpg");
        assert!(!first.exists(), "the old picture is pruned");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        // Re-importing the same bytes lands on the same file.
        let again = import_into(&dir, &write(source_dir.path(), "c.jpeg", JPEG)).unwrap();
        assert_eq!(again, second);
        assert!(again.exists());
    }

    #[test]
    fn import_rejects_non_images_and_empty_files() {
        let source_dir = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let dir = store.path().join(DIR_NAME);
        let text = write(source_dir.path(), "notes.png", b"not a picture");
        let empty = write(source_dir.path(), "empty.png", b"");
        assert!(import_into(&dir, &text).is_err());
        assert!(import_into(&dir, &empty).is_err());
    }

    #[test]
    fn prune_without_keep_empties_the_folder_and_tolerates_a_missing_one() {
        let store = tempfile::tempdir().unwrap();
        let dir = store.path().join(DIR_NAME);
        prune(&dir, None).unwrap();
        fs::create_dir_all(&dir).unwrap();
        write(&dir, "x.png", PNG);
        prune(&dir, None).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }
}
