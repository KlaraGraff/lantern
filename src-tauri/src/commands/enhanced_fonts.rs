//! Device-local enhanced Chinese serif font package management.
//!
//! This is intentionally separate from `custom_fonts`: enhanced fonts are a
//! Lantern supplied, optional display package and must never enter sync.  The
//! command registration and the production manifest endpoint are added by the
//! integrating change; this module keeps the storage and integrity boundary
//! independently testable.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};

const PACKAGE_FILE: &str = "chinese-serif.ttf";
const POINTER_FILE: &str = "current.json";
const MAX_PACKAGE_BYTES: u64 = 128 * 1024 * 1024;

fn build_manifest() -> AppResult<Option<EnhancedFontManifest>> {
    let (Some(version), Some(size), Some(sha256), Some(url)) = (
        option_env!("LANTERN_ENHANCED_FONT_VERSION"),
        option_env!("LANTERN_ENHANCED_FONT_SIZE"),
        option_env!("LANTERN_ENHANCED_FONT_SHA256"),
        option_env!("LANTERN_ENHANCED_FONT_URL"),
    ) else {
        return Ok(None);
    };
    let manifest = EnhancedFontManifest {
        version: version.to_string(),
        download_size: size
            .parse()
            .map_err(|_| font_error("ENHANCED_FONT_MANIFEST_INVALID"))?,
        sha256: sha256.to_string(),
        url: url.to_string(),
    };
    manifest.validate()?;
    Ok(Some(manifest))
}

/// The manifest is supplied by the release service.  There deliberately is no
/// baked-in URL, size, or hash here: inventing one would turn a UI promise into
/// an unverifiable production download contract.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnhancedFontManifest {
    pub version: String,
    pub download_size: u64,
    pub sha256: String,
    pub url: String,
}

impl EnhancedFontManifest {
    pub(crate) fn validate(&self) -> AppResult<()> {
        if self.version.is_empty()
            || !self
                .version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
            || self.download_size == 0
            || self.download_size > MAX_PACKAGE_BYTES
            || self.sha256.len() != 64
            || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !self.url.starts_with("https://")
        {
            return Err(font_error("ENHANCED_FONT_MANIFEST_INVALID"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnhancedFontState {
    NotDownloaded,
    Downloading,
    Verifying,
    Enabled,
    DisabledRetained,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnhancedFontStatus {
    pub state: EnhancedFontState,
    pub enabled: bool,
    pub download_size: Option<u64>,
    pub downloaded_bytes: Option<u64>,
    pub version: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Pointer {
    version: String,
    sha256: String,
    enabled: bool,
}

/// A small injected boundary for download transport.  The caller may stream
/// from reqwest and invoke `progress`; tests supply deterministic bytes.
pub(crate) trait EnhancedFontDownloader {
    fn download(
        &self,
        manifest: &EnhancedFontManifest,
        destination: &Path,
        progress: &mut dyn FnMut(u64),
    ) -> AppResult<()>;
}

pub(crate) fn enhanced_fonts_root(db: &Db) -> AppResult<PathBuf> {
    Ok(db.local_data_dir()?.join("enhanced-fonts"))
}

/// Integration callers invoke this for every callback from
/// `download_and_install_at`; the frontend therefore receives the same state
/// machine as a synchronous status query without polling.
pub(crate) fn emit_progress(app: &AppHandle, status: EnhancedFontStatus) {
    let _ = app.emit("enhanced-font-status-changed", status);
}

pub(crate) fn status_at(root: &Path) -> AppResult<EnhancedFontStatus> {
    let Some(pointer) = read_pointer(root)? else {
        return Ok(EnhancedFontStatus {
            state: EnhancedFontState::NotDownloaded,
            enabled: false,
            download_size: None,
            downloaded_bytes: None,
            version: None,
            error_code: None,
        });
    };
    let package = root.join(PACKAGE_FILE);
    if !package.is_file() || verify_file(&package, &pointer.sha256).is_err() {
        return Err(font_error("ENHANCED_FONT_PACKAGE_INVALID"));
    }
    Ok(EnhancedFontStatus {
        state: if pointer.enabled {
            EnhancedFontState::Enabled
        } else {
            EnhancedFontState::DisabledRetained
        },
        enabled: pointer.enabled,
        download_size: fs::metadata(package).ok().map(|meta| meta.len()),
        downloaded_bytes: None,
        version: Some(pointer.version),
        error_code: None,
    })
}

/// Downloads to a unique temporary file, verifies it, then atomically replaces
/// the package and pointer.  Existing packages remain usable on every failure.
pub(crate) fn download_and_install_at<D, P>(
    root: &Path,
    manifest: &EnhancedFontManifest,
    downloader: &D,
    mut progress: P,
) -> AppResult<EnhancedFontStatus>
where
    D: EnhancedFontDownloader,
    P: FnMut(EnhancedFontStatus),
{
    manifest.validate()?;
    fs::create_dir_all(root).map_err(|_| font_error("ENHANCED_FONT_STORAGE_FAILED"))?;
    progress(transient(EnhancedFontState::Downloading, manifest, 0));
    let temporary = root.join(format!(".{PACKAGE_FILE}.{}.partial", uuid::Uuid::new_v4()));
    let mut on_bytes = |bytes| progress(transient(EnhancedFontState::Downloading, manifest, bytes));
    let result = downloader.download(manifest, &temporary, &mut on_bytes);
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        progress(failed(&error));
        return Err(error);
    }
    progress(transient(
        EnhancedFontState::Verifying,
        manifest,
        manifest.download_size,
    ));
    if let Err(error) = verify_download(&temporary, manifest) {
        let _ = fs::remove_file(&temporary);
        progress(failed(&error));
        return Err(error);
    }

    // Keep an old package until the new pointer is durable: a failed update
    // must not turn a previously enabled font into a broken installation.
    let package = root.join(PACKAGE_FILE);
    let backup = root.join(format!(".{PACKAGE_FILE}.{}.backup", uuid::Uuid::new_v4()));
    let had_previous = package.exists();
    if had_previous {
        if let Err(_rename_error) = fs::rename(&package, &backup) {
            let _ = fs::remove_file(&temporary);
            let error = font_error("ENHANCED_FONT_STORAGE_FAILED");
            progress(failed(&error));
            return Err(error);
        }
    }
    if fs::rename(&temporary, &package).is_err() {
        if had_previous {
            let _ = fs::rename(&backup, &package);
        }
        let error = font_error("ENHANCED_FONT_STORAGE_FAILED");
        progress(failed(&error));
        return Err(error);
    }
    let pointer = Pointer {
        version: manifest.version.clone(),
        sha256: manifest.sha256.to_ascii_lowercase(),
        enabled: true,
    };
    if let Err(error) = write_pointer_atomic(root, &pointer) {
        let _ = fs::remove_file(&package);
        if had_previous {
            let _ = fs::rename(&backup, &package);
        }
        progress(failed(&error));
        return Err(error);
    }
    let _ = fs::remove_file(backup);
    let status = status_at(root)?;
    progress(status.clone());
    Ok(status)
}

pub(crate) fn set_enabled_at(root: &Path, enabled: bool) -> AppResult<EnhancedFontStatus> {
    let mut pointer =
        read_pointer(root)?.ok_or_else(|| font_error("ENHANCED_FONT_NOT_DOWNLOADED"))?;
    verify_file(&root.join(PACKAGE_FILE), &pointer.sha256)?;
    pointer.enabled = enabled;
    write_pointer_atomic(root, &pointer)?;
    status_at(root)
}

/// Explicit removal only; toggling off retains the package to avoid re-downloads.
pub(crate) fn remove_at(root: &Path) -> AppResult<()> {
    let package = root.join(PACKAGE_FILE);
    match fs::remove_file(package) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(font_error("ENHANCED_FONT_REMOVE_FAILED")),
    }
    match fs::remove_file(root.join(POINTER_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(font_error("ENHANCED_FONT_REMOVE_FAILED")),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhancedFontAvailability {
    pub status: EnhancedFontStatus,
    pub manifest: Option<EnhancedFontManifest>,
    pub local_path: Option<String>,
}

fn availability(db: &Db) -> AppResult<EnhancedFontAvailability> {
    let root = enhanced_fonts_root(db)?;
    let manifest = build_manifest()?;
    let mut status = status_at(&root).unwrap_or_else(|error| failed(&error));
    if status.download_size.is_none() {
        status.download_size = manifest.as_ref().map(|item| item.download_size);
    }
    let local_path = (status.enabled && root.join(PACKAGE_FILE).is_file())
        .then(|| root.join(PACKAGE_FILE).to_string_lossy().into_owned());
    Ok(EnhancedFontAvailability {
        status,
        manifest,
        local_path,
    })
}

#[tauri::command]
pub fn enhanced_font_status(db: State<'_, Db>) -> AppResult<EnhancedFontAvailability> {
    availability(&db)
}

struct ExistingDownload(PathBuf);

impl EnhancedFontDownloader for ExistingDownload {
    fn download(
        &self,
        _: &EnhancedFontManifest,
        destination: &Path,
        progress: &mut dyn FnMut(u64),
    ) -> AppResult<()> {
        fs::copy(&self.0, destination).map_err(|_| font_error("ENHANCED_FONT_STORAGE_FAILED"))?;
        progress(
            fs::metadata(destination)
                .map_err(|_| font_error("ENHANCED_FONT_STORAGE_FAILED"))?
                .len(),
        );
        Ok(())
    }
}

fn download_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[tauri::command]
pub async fn enhanced_font_download(
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<EnhancedFontAvailability> {
    let _guard = download_lock()
        .try_lock()
        .map_err(|_| font_error("ENHANCED_FONT_DOWNLOAD_BUSY"))?;
    let manifest =
        build_manifest()?.ok_or_else(|| font_error("ENHANCED_FONT_MANIFEST_UNAVAILABLE"))?;
    let root = enhanced_fonts_root(&db)?;
    fs::create_dir_all(&root).map_err(|_| font_error("ENHANCED_FONT_STORAGE_FAILED"))?;
    let incoming = root.join(format!(".incoming.{}.partial", uuid::Uuid::new_v4()));
    emit_progress(
        &app,
        transient(EnhancedFontState::Downloading, &manifest, 0),
    );
    let response = match crate::ai::http_client().get(&manifest.url).send().await {
        Ok(response) => response,
        Err(_) => {
            let error = font_error("ENHANCED_FONT_DOWNLOAD_FAILED");
            emit_progress(&app, failed(&error));
            return Err(error);
        }
    };
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length != manifest.download_size)
    {
        let error = font_error("ENHANCED_FONT_DOWNLOAD_FAILED");
        emit_progress(&app, failed(&error));
        return Err(error);
    }
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&incoming)
    {
        Ok(file) => file,
        Err(_) => {
            let error = font_error("ENHANCED_FONT_STORAGE_FAILED");
            emit_progress(&app, failed(&error));
            return Err(error);
        }
    };
    let mut downloaded = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                let _ = fs::remove_file(&incoming);
                let error = font_error("ENHANCED_FONT_DOWNLOAD_FAILED");
                emit_progress(&app, failed(&error));
                return Err(error);
            }
        };
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > manifest.download_size || downloaded > MAX_PACKAGE_BYTES {
            let _ = fs::remove_file(&incoming);
            let error = font_error("ENHANCED_FONT_LENGTH_MISMATCH");
            emit_progress(&app, failed(&error));
            return Err(error);
        }
        if let Err(_write_error) = file.write_all(&chunk) {
            drop(file);
            let _ = fs::remove_file(&incoming);
            let error = font_error("ENHANCED_FONT_STORAGE_FAILED");
            emit_progress(&app, failed(&error));
            return Err(error);
        }
        emit_progress(
            &app,
            transient(EnhancedFontState::Downloading, &manifest, downloaded),
        );
    }
    if let Err(_sync_error) = file.sync_all() {
        drop(file);
        let _ = fs::remove_file(&incoming);
        let error = font_error("ENHANCED_FONT_STORAGE_FAILED");
        emit_progress(&app, failed(&error));
        return Err(error);
    }
    drop(file);
    if let Err(error) = verify_download(&incoming, &manifest) {
        let _ = fs::remove_file(&incoming);
        emit_progress(&app, failed(&error));
        return Err(error);
    }
    let install_result = download_and_install_at(
        &root,
        &manifest,
        &ExistingDownload(incoming.clone()),
        |status| emit_progress(&app, status),
    );
    let _ = fs::remove_file(incoming);
    install_result?;
    availability(&db)
}

#[tauri::command]
pub fn enhanced_font_set_enabled(
    enabled: bool,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<EnhancedFontAvailability> {
    let root = enhanced_fonts_root(&db)?;
    let status = set_enabled_at(&root, enabled)?;
    emit_progress(&app, status);
    availability(&db)
}

#[tauri::command]
pub fn enhanced_font_remove(
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<EnhancedFontAvailability> {
    let root = enhanced_fonts_root(&db)?;
    remove_at(&root)?;
    let next = availability(&db)?;
    emit_progress(&app, next.status.clone());
    Ok(next)
}

fn transient(
    state: EnhancedFontState,
    manifest: &EnhancedFontManifest,
    downloaded: u64,
) -> EnhancedFontStatus {
    EnhancedFontStatus {
        state,
        enabled: false,
        download_size: Some(manifest.download_size),
        downloaded_bytes: Some(downloaded),
        version: Some(manifest.version.clone()),
        error_code: None,
    }
}

fn failed(error: &AppError) -> EnhancedFontStatus {
    EnhancedFontStatus {
        state: EnhancedFontState::Failed,
        enabled: false,
        download_size: None,
        downloaded_bytes: None,
        version: None,
        error_code: Some(error.to_string()),
    }
}

fn read_pointer(root: &Path) -> AppResult<Option<Pointer>> {
    match fs::read(root.join(POINTER_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| font_error("ENHANCED_FONT_POINTER_INVALID")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(font_error("ENHANCED_FONT_POINTER_INVALID")),
    }
}

fn write_pointer_atomic(root: &Path, pointer: &Pointer) -> AppResult<()> {
    fs::create_dir_all(root).map_err(|_| font_error("ENHANCED_FONT_STORAGE_FAILED"))?;
    let temporary = root.join(format!(".{POINTER_FILE}.{}.partial", uuid::Uuid::new_v4()));
    let bytes =
        serde_json::to_vec(pointer).map_err(|_| font_error("ENHANCED_FONT_POINTER_INVALID"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| font_error("ENHANCED_FONT_STORAGE_FAILED"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| font_error("ENHANCED_FONT_STORAGE_FAILED"))?;
    replace_file(&temporary, &root.join(POINTER_FILE))
}

fn replace_file(source: &Path, destination: &Path) -> AppResult<()> {
    if !destination.exists() {
        return fs::rename(source, destination)
            .map_err(|_| font_error("ENHANCED_FONT_STORAGE_FAILED"));
    }
    let backup = destination.with_extension(format!("backup-{}", uuid::Uuid::new_v4()));
    fs::rename(destination, &backup).map_err(|_| font_error("ENHANCED_FONT_STORAGE_FAILED"))?;
    if let Err(error) = fs::rename(source, destination) {
        let _ = fs::rename(&backup, destination);
        return Err(AppError::Io(error));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn verify_download(path: &Path, manifest: &EnhancedFontManifest) -> AppResult<()> {
    let size = fs::metadata(path)
        .map_err(|_| font_error("ENHANCED_FONT_DOWNLOAD_FAILED"))?
        .len();
    if size != manifest.download_size {
        return Err(font_error("ENHANCED_FONT_LENGTH_MISMATCH"));
    }
    verify_file(path, &manifest.sha256)
}

fn verify_file(path: &Path, expected_sha256: &str) -> AppResult<()> {
    let mut file = File::open(path).map_err(|_| font_error("ENHANCED_FONT_PACKAGE_INVALID"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| font_error("ENHANCED_FONT_PACKAGE_INVALID"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(expected_sha256) {
        Ok(())
    } else {
        Err(font_error("ENHANCED_FONT_HASH_MISMATCH"))
    }
}

fn font_error(code: &str) -> AppError {
    AppError::Other(code.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Bytes(Vec<u8>);
    impl EnhancedFontDownloader for Bytes {
        fn download(
            &self,
            _: &EnhancedFontManifest,
            destination: &Path,
            progress: &mut dyn FnMut(u64),
        ) -> AppResult<()> {
            fs::write(destination, &self.0)?;
            progress(self.0.len() as u64);
            Ok(())
        }
    }
    fn manifest(bytes: &[u8]) -> EnhancedFontManifest {
        EnhancedFontManifest {
            version: "1.0.0".into(),
            download_size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            url: "https://release.example/font.ttf".into(),
        }
    }

    struct FailingDownload;
    impl EnhancedFontDownloader for FailingDownload {
        fn download(
            &self,
            _: &EnhancedFontManifest,
            _destination: &Path,
            _progress: &mut dyn FnMut(u64),
        ) -> AppResult<()> {
            Err(font_error("ENHANCED_FONT_DOWNLOAD_FAILED"))
        }
    }

    #[test]
    fn download_failure_emits_failed_progress_and_leaves_no_temp_file() {
        let temp = tempfile::tempdir().unwrap();
        let bytes = b"font bytes";
        let mut statuses = Vec::new();
        let result =
            download_and_install_at(temp.path(), &manifest(bytes), &FailingDownload, |status| {
                statuses.push(status);
            });
        assert!(result.is_err());
        assert_eq!(
            statuses.last().map(|status| status.state),
            Some(EnhancedFontState::Failed)
        );
        let leftovers: Vec<_> = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .collect();
        assert!(
            leftovers.is_empty(),
            "expected no leftover files after a failed download, found {leftovers:?}"
        );
    }

    #[test]
    fn installs_enables_disables_and_explicitly_removes_local_package() {
        let temp = tempfile::tempdir().unwrap();
        let bytes = b"font bytes";
        let result = download_and_install_at(
            temp.path(),
            &manifest(bytes),
            &Bytes(bytes.to_vec()),
            |_| {},
        )
        .unwrap();
        assert_eq!(result.state, EnhancedFontState::Enabled);
        assert_eq!(
            set_enabled_at(temp.path(), false).unwrap().state,
            EnhancedFontState::DisabledRetained
        );
        assert!(temp.path().join(PACKAGE_FILE).exists());
        remove_at(temp.path()).unwrap();
        assert_eq!(
            status_at(temp.path()).unwrap().state,
            EnhancedFontState::NotDownloaded
        );
    }

    #[test]
    fn failed_update_preserves_existing_package() {
        let temp = tempfile::tempdir().unwrap();
        let old = b"old font";
        download_and_install_at(temp.path(), &manifest(old), &Bytes(old.to_vec()), |_| {}).unwrap();
        let new = b"new font";
        let mut bad = manifest(new);
        bad.sha256 = "00".repeat(32);
        assert!(download_and_install_at(temp.path(), &bad, &Bytes(new.to_vec()), |_| {}).is_err());
        assert_eq!(
            status_at(temp.path()).unwrap().version.as_deref(),
            Some("1.0.0")
        );
        assert_eq!(fs::read(temp.path().join(PACKAGE_FILE)).unwrap(), old);
    }
}
