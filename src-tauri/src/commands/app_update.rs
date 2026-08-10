//! Download an update once; install it whenever the reader is ready.
//!
//! The updater plugin can download and install in a single call, but the bytes
//! it downloads live in memory for exactly as long as the process does. A
//! reader told "v2.16.0 is ready" mid-chapter, who chooses to finish the
//! chapter first, would pay the whole download again on the next launch. This
//! module writes the verified package to disk instead, so choosing "later"
//! costs nothing.
//!
//! All of it runs Rust-side deliberately. The package is tens of megabytes;
//! routing it through the webview only to hand it straight back would mean
//! base64 across the IPC bridge twice. The frontend sees a small JSON status
//! and a progress event, never the payload.
//!
//! **What may sit in the staging directory is decided by the server, not by
//! us.** Every successful check prunes it down to the single version being
//! offered, and a check that answers "up to date" empties it. That one rule
//! covers every stale case — a package the reader installed by other means, a
//! release that got pulled, a version superseded before it was installed —
//! with no version arithmetic to get wrong.
//!
//! **Installing still needs the network**, even though the bytes are already
//! local. The plugin's installer is a method on the `Update` object, and that
//! object can only come from a live check: the fields it installs through
//! (extract path, install mode, main-thread handle) are private to the crate,
//! so there is no way to reconstruct one offline. Offline, the package simply
//! waits — nothing is lost, and the next check turns it back into a one-click
//! install.
//!
//! The signature is deliberately *not* stored next to the package. Every path
//! that reads the staged bytes already holds a freshly fetched `Update`, so
//! the signature it verifies against always comes from the server on this run
//! rather than from disk.

use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, AppResult};

/// Only one update is ever in flight, so a single global event carries
/// progress — no per-request channel like the AI streams need.
const PROGRESS_EVENT: &str = "update:download-progress";

/// Emit at most one progress event per this many bytes. A 40 MB package
/// arrives in ~32 KB chunks; forwarding every one would put a thousand-plus
/// events through the bridge to move a progress bar a fraction of a pixel.
const PROGRESS_STRIDE: u64 = 256 * 1024;

/// What the frontend knows about updates. Plain data on purpose: the bug this
/// replaced came from a surface holding a live `Update` object that could not
/// be handed to a second surface, so each one had a different idea of what was
/// going on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// The version the server is offering, when it is newer than what runs.
    pub available: Option<String>,
    /// Release notes for `available`, straight out of `latest.json`.
    pub notes: Option<String>,
    /// Whether the package for `available` is already downloaded, verified,
    /// and installable without touching the network again for the payload.
    pub staged: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    /// Absent when the server omits `Content-Length`; the UI then shows an
    /// indeterminate download rather than inventing a percentage.
    total: Option<u64>,
}

fn stage_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("cannot resolve the app data dir: {e}")))?
        .join("updates");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Named after the version so a directory listing is self-describing and
/// pruning needs no index to consult.
fn package_name(version: &str) -> String {
    format!("v{version}.pkg")
}

/// The updater's public key, read from the same `tauri.conf.json` the plugin
/// reads. Duplicating it as a constant here would be one more place to forget
/// during a key rotation.
fn updater_pubkey(app: &AppHandle) -> AppResult<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .map(str::to_string)
        .ok_or_else(|| AppError::Other("no updater pubkey in tauri.conf.json".into()))
}

/// Both the key and the signature are base64 wrappers around minisign's own
/// text format, which is what `PublicKey`/`Signature` parse — the same two-step
/// decode the plugin does internally before it verifies a fresh download.
fn verify(bytes: &[u8], signature_b64: &str, pubkey_b64: &str) -> bool {
    fn unwrap_base64(value: &str) -> Option<String> {
        let decoded = base64::engine::general_purpose::STANDARD.decode(value).ok()?;
        String::from_utf8(decoded).ok()
    }

    let (Some(pubkey), Some(signature)) = (unwrap_base64(pubkey_b64), unwrap_base64(signature_b64))
    else {
        return false;
    };
    let Ok(pubkey) = minisign_verify::PublicKey::decode(&pubkey) else {
        return false;
    };
    let Ok(signature) = minisign_verify::Signature::decode(&signature) else {
        return false;
    };
    // `true` allows minisign's legacy (non-prehashed) signatures, matching what
    // the plugin accepts for a live download. Rejecting them here would make a
    // staged package unusable that a direct download would have installed.
    pubkey.verify(bytes, &signature, true).is_ok()
}

/// Reduce the directory to at most the one version worth keeping. Passing
/// `None` empties it. Staging files orphaned by a crash mid-write are swept by
/// the same pass, since they never match the kept name.
fn prune(dir: &Path, keep: Option<&str>) {
    let keep = keep.map(package_name);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if Some(entry.file_name().to_string_lossy().as_ref()) == keep.as_deref() {
            continue;
        }
        if let Err(e) = std::fs::remove_file(entry.path()) {
            log::warn!("update: cannot remove stale {}: {e}", entry.path().display());
        }
    }
}

/// Stage into a temp file and rename into place, so the `.pkg` name appears
/// only once every byte is on disk. A crash mid-write can leave a partial
/// staging file behind, never a package that looks complete and is not.
///
/// A `NamedTempFile` rather than a hand-named `.part`, matching the other
/// atomic-write sites here: the guard removes the staging file on every exit
/// that is not `persist`, including the `?` returns below.
fn write_atomically(dir: &Path, version: &str, bytes: &[u8]) -> AppResult<()> {
    let mut staging = tempfile::Builder::new()
        .prefix(&format!(".v{version}."))
        .suffix(".tmp")
        .tempfile_in(dir)?;
    staging.write_all(bytes)?;
    // fsync before the rename: the other order would let a power loss leave a
    // correctly-named package holding whatever reached the platter, and the
    // signature check on the next launch would then reject bytes we wrote.
    staging.as_file().sync_all()?;
    staging
        .persist(dir.join(package_name(version)))
        .map_err(|e| AppError::Io(e.error))?;
    Ok(())
}

async fn fetch_update(app: &AppHandle) -> AppResult<Option<Update>> {
    app.updater()
        .map_err(|e| AppError::Other(format!("updater unavailable: {e}")))?
        .check()
        .await
        .map_err(|e| AppError::Other(format!("update check failed: {e}")))
}

/// Ask the server what is on offer, and reconcile the staging directory with
/// the answer.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> AppResult<UpdateStatus> {
    let dir = stage_dir(&app)?;
    let Some(update) = fetch_update(&app).await? else {
        // Up to date: whatever is staged can only be obsolete.
        prune(&dir, None);
        return Ok(UpdateStatus {
            available: None,
            notes: None,
            staged: false,
        });
    };

    prune(&dir, Some(&update.version));

    let package = dir.join(package_name(&update.version));
    let staged = match std::fs::read(&package) {
        Ok(bytes) => {
            let pubkey = updater_pubkey(&app)?;
            if verify(&bytes, &update.signature, &pubkey) {
                true
            } else {
                // The bytes on disk are not what the server signed. Nothing to
                // salvage and nothing to warn the reader about — drop it and
                // let this look like a fresh update.
                log::warn!("update: staged v{} failed verification, discarding", update.version);
                let _ = std::fs::remove_file(&package);
                false
            }
        }
        Err(_) => false,
    };

    Ok(UpdateStatus {
        available: Some(update.version.clone()),
        notes: update.body.clone(),
        staged,
    })
}

/// Download the offered package and stage it. Returns the version staged, so
/// the caller can tell a download that finished from one that raced a release.
#[tauri::command]
pub async fn update_download(app: AppHandle) -> AppResult<String> {
    let dir = stage_dir(&app)?;
    let update = fetch_update(&app)
        .await?
        .ok_or_else(|| AppError::Other("no update to download".into()))?;

    let emitter = app.clone();
    let mut downloaded: u64 = 0;
    let mut announced: u64 = 0;
    let mut total: Option<u64> = None;

    // The plugin verifies the signature before handing these bytes back, so
    // what lands on disk is already known-good for this run.
    let bytes = update
        .download(
            |chunk, content_length| {
                downloaded += chunk as u64;
                total = content_length;
                if downloaded - announced >= PROGRESS_STRIDE {
                    announced = downloaded;
                    let _ = emitter.emit(PROGRESS_EVENT, DownloadProgress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| AppError::Other(format!("update download failed: {e}")))?;

    let _ = app.emit(
        PROGRESS_EVENT,
        DownloadProgress {
            downloaded: bytes.len() as u64,
            total: Some(bytes.len() as u64),
        },
    );

    write_atomically(&dir, &update.version, &bytes)?;
    // A release published while this download ran would otherwise leave two
    // packages behind.
    prune(&dir, Some(&update.version));
    Ok(update.version.clone())
}

/// Install the staged package. The caller relaunches afterwards.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> AppResult<()> {
    let dir = stage_dir(&app)?;
    let update = fetch_update(&app)
        .await?
        .ok_or_else(|| AppError::Other("no update to install".into()))?;

    let package = dir.join(package_name(&update.version));
    let bytes = std::fs::read(&package)
        .map_err(|_| AppError::Other(format!("v{} is not staged", update.version)))?;

    // Re-verified against a signature fetched this run, not one kept on disk:
    // the package has been sitting in a user-writable directory, possibly for
    // days, and a forged replacement cannot produce a signature that satisfies
    // the public key compiled into this build.
    let pubkey = updater_pubkey(&app)?;
    if !verify(&bytes, &update.signature, &pubkey) {
        let _ = std::fs::remove_file(&package);
        return Err(AppError::Other(
            "the staged package failed verification and was discarded".into(),
        ));
    }

    update
        .install(bytes)
        .map_err(|e| AppError::Other(format!("update install failed: {e}")))?;
    let _ = std::fs::remove_file(&package);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{package_name, prune, verify, write_atomically};
    use base64::Engine;
    use tempfile::TempDir;

    /// The public key this build ships, and a signature over known bytes made
    /// with the matching private key, would both be needed to test the happy
    /// path — the private key is not in the repo by design. What is testable
    /// without it is that garbage never passes.
    #[test]
    fn verify_rejects_malformed_input() {
        assert!(!verify(b"hello", "not base64 at all!!", "also not base64"));
        assert!(!verify(b"hello", "", ""));
        // Well-formed base64 that decodes to text minisign cannot parse.
        let junk = base64::engine::general_purpose::STANDARD
            .encode("untrusted comment: nothing\nnot-a-key\n");
        assert!(!verify(b"hello", &junk, &junk));
    }

    #[test]
    fn prune_keeps_only_the_named_version() {
        let dir = TempDir::new().unwrap();
        for name in ["v1.0.0.pkg", "v2.0.0.pkg", "v2.0.0.part", "stray.tmp"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }

        prune(dir.path(), Some("2.0.0"));

        let mut left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec![package_name("2.0.0")]);
    }

    #[test]
    fn prune_with_no_keep_empties_the_directory() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("v2.0.0.pkg"), b"x").unwrap();

        prune(dir.path(), None);

        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    /// The point of staging through a temp file: when it returns, the package
    /// name holds every byte and nothing else is left in the directory.
    #[test]
    fn atomic_write_leaves_only_the_finished_package() {
        let dir = TempDir::new().unwrap();

        write_atomically(dir.path(), "2.0.0", b"payload").unwrap();

        let left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec![package_name("2.0.0")]);
        assert_eq!(
            std::fs::read(dir.path().join(package_name("2.0.0"))).unwrap(),
            b"payload"
        );
    }
}
