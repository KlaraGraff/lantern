//! Library backup: a one-way copy of every book's files and cover into a
//! folder the user picked (an external disk, a NAS, a Dropbox folder).
//!
//! **Copy only, never delete.** A file already in the backup with the same
//! size is skipped, and nothing in the backup is ever removed — a book deleted
//! from the library keeps its copy there. Highlights, vocabulary and progress
//! are not part of it; those travel through sync.
//!
//! The backup mirrors the library's own relative layout (`books/`, `sources/`,
//! `covers/`) and keeps `lantern-library.json` beside it, mapping each book id
//! to its title and author so the files can be found again by a person.
//!
//! All settings here are device-local (none is on the sync whitelist): the
//! folder is a path on this machine. An absent row reads as the default — no
//! folder, automatic backup off, never backed up.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::validation::resolve_blob_path;

const DIR_KEY: &str = "library_backup_dir";
const AUTO_KEY: &str = "library_backup_auto";
const LAST_AT_KEY: &str = "library_backup_last_at";
const LAST_BOOKS_KEY: &str = "library_backup_last_books";
const LAST_UNAVAILABLE_KEY: &str = "library_backup_last_unavailable";

const MANIFEST_NAME: &str = "lantern-library.json";
const CHANGED_EVENT: &str = "library-backup-changed";

const NOT_CONFIGURED: &str = "LIBRARY_BACKUP_NOT_CONFIGURED";
const FOLDER_OFFLINE: &str = "LIBRARY_BACKUP_FOLDER_OFFLINE";
const INSIDE_LIBRARY: &str = "LIBRARY_BACKUP_INSIDE_LIBRARY";
const WRITE_FAILED: &str = "LIBRARY_BACKUP_WRITE_FAILED";

#[derive(Default)]
struct Inner {
    running: AtomicBool,
    cancel: AtomicBool,
    /// A trigger arrived mid-run; run once more when this one ends so the
    /// book that triggered it is not left out.
    rerun: AtomicBool,
    /// An automatic backup was skipped because the folder was offline; the
    /// watcher fills it in once the folder comes back.
    pending: AtomicBool,
    progress: Mutex<(u64, u64)>,
    last_error: Mutex<Option<String>>,
}

#[derive(Clone, Default)]
pub struct LibraryBackup(Arc<Inner>);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LibraryBackupStatus {
    pub dir: Option<String>,
    pub online: bool,
    pub auto: bool,
    pub running: bool,
    pub copied: u64,
    pub total: u64,
    pub last_at: Option<i64>,
    pub books_backed_up: u64,
    pub books_unavailable: u64,
    pub error: Option<String>,
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct RunOutcome {
    pub copied: u64,
    pub books_backed_up: u64,
    pub books_unavailable: u64,
    pub cancelled: bool,
}

enum Source {
    File(PathBuf),
    CoverBlob { book_id: String, len: u64 },
}

struct Item {
    relative: String,
    source: Source,
    /// The book's own file (not its cover): a missing one makes the book
    /// "unavailable" — typically an iCloud file not downloaded to this device.
    essential: bool,
}

struct BookPlan {
    id: String,
    title: String,
    author: String,
    items: Vec<Item>,
}

#[derive(Serialize, Deserialize, Default)]
struct Manifest {
    books: BTreeMap<String, ManifestEntry>,
}

#[derive(Serialize, Deserialize)]
struct ManifestEntry {
    title: String,
    author: String,
    files: Vec<String>,
    in_library: bool,
}

fn read_setting(db: &Db, key: &str) -> Option<String> {
    crate::commands::settings::get_setting_value(db, key)
        .ok()
        .flatten()
        .filter(|value| !value.is_empty())
}

/// Local-only rows, stamped `(0, "")` like every non-whitelisted setting.
fn write_settings(db: &Db, values: &[(&str, String)]) -> AppResult<()> {
    let mut conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let tx = conn.transaction()?;
    for (key, value) in values {
        tx.execute(
            "INSERT INTO settings (key, value, updated_at, updated_by_device)
             VALUES (?1, ?2, 0, '')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn configured_dir(db: &Db) -> Option<PathBuf> {
    read_setting(db, DIR_KEY).map(PathBuf::from)
}

fn auto_enabled(db: &Db) -> bool {
    read_setting(db, AUTO_KEY).as_deref() == Some("1")
}

fn read_count(db: &Db, key: &str) -> u64 {
    read_setting(db, key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

/// Refuse a folder inside the library or the app's own data: the backup
/// would then live on the very disk (or iCloud folder) it is meant to outlive.
fn check_not_inside_library(db: &Db, dest: &Path) -> AppResult<()> {
    let dest = fs::canonicalize(dest).unwrap_or_else(|_| dest.to_path_buf());
    for root in [db.data_dir()?, db.local_data_dir()?] {
        let root = fs::canonicalize(&root).unwrap_or(root);
        if dest.starts_with(&root) {
            return Err(AppError::Other(INSIDE_LIBRARY.to_string()));
        }
    }
    Ok(())
}

fn plan(db: &Db) -> AppResult<Vec<BookPlan>> {
    type Row = (
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        i64,
    );
    let rows: Vec<Row> = {
        let conn = db.reader();
        let mut statement = conn.prepare(
            "SELECT id, title, author, file_path, source_file_path, cover_path,
                    COALESCE(LENGTH(cover_data), 0)
             FROM books ORDER BY created_at",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        rows
    };

    let mut books = Vec::with_capacity(rows.len());
    for (id, title, author, file_path, source_path, cover_path, cover_len) in rows {
        let mut items = Vec::new();
        let mut add_file = |relative: String, essential: bool| -> AppResult<()> {
            let source = db.resolve_path(&relative)?;
            items.push(Item {
                relative,
                source: Source::File(source),
                essential,
            });
            Ok(())
        };
        // A path that fails validation is skipped rather than failing the
        // whole backup: one odd row must not stop every other book.
        if add_file(file_path.clone(), true).is_err() {
            log::warn!("library_backup: skipping invalid file path for {id}");
        }
        if let Some(source_path) = source_path.filter(|path| path != &file_path) {
            if add_file(source_path, true).is_err() {
                log::warn!("library_backup: skipping invalid source path for {id}");
            }
        }
        if let Some(cover) = cover_path.filter(|path| path != "none") {
            if cover_len > 0 {
                items.push(Item {
                    relative: cover,
                    source: Source::CoverBlob {
                        book_id: id.clone(),
                        len: cover_len as u64,
                    },
                    essential: false,
                });
            } else if add_file(cover, false).is_err() {
                log::warn!("library_backup: skipping invalid cover path for {id}");
            }
        }
        books.push(BookPlan {
            id,
            title,
            author,
            items,
        });
    }
    Ok(books)
}

fn source_len(source: &Source) -> io::Result<u64> {
    match source {
        Source::File(path) => {
            let metadata = fs::metadata(path)?;
            if metadata.is_file() {
                Ok(metadata.len())
            } else {
                Err(io::ErrorKind::NotFound.into())
            }
        }
        Source::CoverBlob { len, .. } => Ok(*len),
    }
}

fn already_backed_up(dest: &Path, len: u64) -> bool {
    fs::metadata(dest).is_ok_and(|metadata| metadata.is_file() && metadata.len() == len)
}

/// Write through a temporary file in the destination folder and rename it into
/// place, so an unplugged disk or a cancelled run never leaves a half-written
/// file that a later run would mistake for a finished one.
fn copy_into(db: &Db, source: &Source, dest: &Path) -> io::Result<()> {
    let parent = dest
        .parent()
        .ok_or_else(|| io::Error::other("destination has no parent"))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    if dest.exists() {
        keep_previous_copy(dest)?;
    }
    match source {
        Source::File(path) => {
            let mut reader = fs::File::open(path)?;
            io::copy(&mut reader, temporary.as_file_mut())?;
        }
        Source::CoverBlob { book_id, .. } => {
            let bytes: Vec<u8> = db
                .reader()
                .query_row(
                    "SELECT cover_data FROM books WHERE id = ?1",
                    params![book_id],
                    |row| row.get(0),
                )
                .map_err(|_| io::Error::from(io::ErrorKind::NotFound))?;
            temporary.write_all(&bytes)?;
        }
    }
    temporary.as_file().sync_all()?;
    temporary.persist(dest).map_err(|error| error.error)?;
    Ok(())
}

/// The library's file differs from the copy already in the backup — maybe a
/// newer version, maybe a truncated or corrupted one. A backup never discards
/// what it holds, so the old copy is renamed aside rather than replaced.
fn keep_previous_copy(dest: &Path) -> io::Result<()> {
    let name = dest
        .file_name()
        .ok_or_else(|| io::Error::other("destination has no file name"))?
        .to_string_lossy();
    let aside = dest.with_file_name(format!("{name}.previous-{}", now_ms()));
    fs::rename(dest, aside)
}

fn write_failed(error: io::Error) -> AppError {
    AppError::Other(format!("{WRITE_FAILED}: {error}"))
}

fn write_manifest(dest_root: &Path, books: &[BookPlan]) -> io::Result<()> {
    let path = dest_root.join(MANIFEST_NAME);
    // A manifest that exists but cannot be read (a flaky share, a newer
    // format) holds the only titles of deleted books: leave it untouched
    // rather than overwrite it with the current library alone.
    let mut manifest: Manifest = match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(manifest) => manifest,
            Err(error) => {
                log::warn!("library_backup: manifest unreadable, not rewriting it: {error}");
                return Ok(());
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Manifest::default(),
        Err(error) => return Err(error),
    };
    for entry in manifest.books.values_mut() {
        entry.in_library = false;
    }
    for book in books {
        let files = book
            .items
            .iter()
            .filter(|item| {
                resolve_blob_path(dest_root, &item.relative).is_ok_and(|path| path.is_file())
            })
            .map(|item| item.relative.clone())
            .collect::<Vec<_>>();
        let entry = manifest
            .books
            .entry(book.id.clone())
            .or_insert_with(|| ManifestEntry {
                title: String::new(),
                author: String::new(),
                files: Vec::new(),
                in_library: true,
            });
        entry.title = book.title.clone();
        entry.author = book.author.clone();
        entry.in_library = true;
        for file in files {
            if !entry.files.contains(&file) {
                entry.files.push(file);
            }
        }
    }
    let mut temporary = tempfile::NamedTempFile::new_in(dest_root)?;
    serde_json::to_writer_pretty(temporary.as_file_mut(), &manifest)?;
    temporary.as_file().sync_all()?;
    temporary.persist(&path).map_err(|error| error.error)?;
    Ok(())
}

/// One pass over the library. `progress(copied, total)` reports copies of
/// files the backup did not have yet; files already there are not counted.
pub(crate) fn run_backup(
    db: &Db,
    dest_root: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> AppResult<RunOutcome> {
    if !dest_root.is_dir() {
        return Err(AppError::Other(FOLDER_OFFLINE.to_string()));
    }
    check_not_inside_library(db, dest_root)?;
    let books = plan(db)?;

    let mut unavailable = vec![false; books.len()];
    let mut todo = Vec::new();
    for (index, book) in books.iter().enumerate() {
        for item in &book.items {
            let Ok(dest) = resolve_blob_path(dest_root, &item.relative) else {
                continue;
            };
            match source_len(&item.source) {
                Ok(len) if already_backed_up(&dest, len) => {}
                Ok(_) => todo.push((index, item, dest)),
                Err(_) => unavailable[index] |= item.essential,
            }
        }
    }

    let total = todo.len() as u64;
    let mut outcome = RunOutcome::default();
    progress(0, total);
    for (index, item, dest) in todo {
        if cancel.load(Ordering::Relaxed) {
            outcome.cancelled = true;
            break;
        }
        // Without this, `create_dir_all` below would quietly recreate a folder
        // the user renamed or unplugged, and fill a stranger with the books.
        if !dest_root.is_dir() {
            return Err(AppError::Other(FOLDER_OFFLINE.to_string()));
        }
        match copy_into(db, &item.source, &dest) {
            Ok(()) => outcome.copied += 1,
            // The book was deleted or evicted between planning and copying.
            Err(error) if error.kind() == io::ErrorKind::NotFound && !dest_root.is_dir() => {
                return Err(AppError::Other(FOLDER_OFFLINE.to_string()));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                unavailable[index] |= item.essential;
            }
            Err(error) => {
                if !dest_root.is_dir() {
                    return Err(AppError::Other(FOLDER_OFFLINE.to_string()));
                }
                return Err(write_failed(error));
            }
        }
        progress(outcome.copied, total);
    }

    write_manifest(dest_root, &books).map_err(write_failed)?;

    for (index, book) in books.iter().enumerate() {
        let complete = book.items.iter().all(|item| {
            let Ok(dest) = resolve_blob_path(dest_root, &item.relative) else {
                return true;
            };
            !item.essential || dest.is_file()
        });
        if unavailable[index] {
            outcome.books_unavailable += 1;
        } else if complete {
            outcome.books_backed_up += 1;
        }
    }
    Ok(outcome)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn status_of(db: &Db, state: &LibraryBackup) -> LibraryBackupStatus {
    let dir = configured_dir(db);
    let (copied, total) = *state.0.progress.lock().expect("progress mutex");
    LibraryBackupStatus {
        online: dir.as_deref().is_some_and(Path::is_dir),
        dir: dir.map(|path| path.to_string_lossy().into_owned()),
        auto: auto_enabled(db),
        running: state.0.running.load(Ordering::SeqCst),
        copied,
        total,
        last_at: read_setting(db, LAST_AT_KEY).and_then(|value| value.parse().ok()),
        books_backed_up: read_count(db, LAST_BOOKS_KEY),
        books_unavailable: read_count(db, LAST_UNAVAILABLE_KEY),
        error: state.0.last_error.lock().expect("error mutex").clone(),
    }
}

fn emit_status<R: Runtime>(app: &AppHandle<R>) {
    let db = app.state::<Db>();
    let state = app.state::<LibraryBackup>();
    let _ = app.emit(CHANGED_EVENT, status_of(&db, &state));
}

fn record_outcome(db: &Db, outcome: &RunOutcome) -> AppResult<()> {
    let mut values = vec![
        (LAST_BOOKS_KEY, outcome.books_backed_up.to_string()),
        (LAST_UNAVAILABLE_KEY, outcome.books_unavailable.to_string()),
    ];
    if !outcome.cancelled {
        values.push((LAST_AT_KEY, now_ms().to_string()));
    }
    write_settings(db, &values)
}

/// Start a backup on a background thread unless one is already running, in
/// which case the running one goes round once more when it finishes.
fn start<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let db = app.state::<Db>().inner().clone();
    let state = app.state::<LibraryBackup>().inner().clone();
    if configured_dir(&db).is_none() {
        return Err(AppError::Other(NOT_CONFIGURED.to_string()));
    }
    if state.0.running.swap(true, Ordering::SeqCst) {
        state.0.rerun.store(true, Ordering::SeqCst);
        return Ok(());
    }
    *state.0.last_error.lock().expect("error mutex") = None;
    *state.0.progress.lock().expect("progress mutex") = (0, 0);
    emit_status(app);

    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            // Re-read every pass: the folder may have been changed mid-run,
            // and a cancel aimed at the previous pass must not leak into this one.
            state.0.cancel.store(false, Ordering::SeqCst);
            let Some(dir) = configured_dir(&db) else {
                break;
            };
            let mut report = |copied, total| {
                *state.0.progress.lock().expect("progress mutex") = (copied, total);
                emit_status(&app);
            };
            let result = run_backup(&db, &dir, &state.0.cancel, &mut report);
            match result {
                Ok(outcome) => {
                    let still_current = configured_dir(&db).as_deref() == Some(dir.as_path());
                    if !still_current {
                        // The user picked another folder meanwhile; this pass's
                        // counts describe the old one. Go again for the new one.
                        state.0.rerun.store(true, Ordering::SeqCst);
                    } else if let Err(error) = record_outcome(&db, &outcome) {
                        log::warn!("library_backup: failed to record outcome: {error}");
                    }
                    log::info!(
                        "library_backup: copied={} backed_up={} unavailable={} cancelled={}",
                        outcome.copied,
                        outcome.books_backed_up,
                        outcome.books_unavailable,
                        outcome.cancelled
                    );
                    if outcome.cancelled && still_current {
                        state.0.rerun.store(false, Ordering::SeqCst);
                        break;
                    }
                }
                Err(error) => {
                    let message = error.to_string();
                    log::warn!("library_backup: {message}");
                    if message == FOLDER_OFFLINE {
                        state.0.pending.store(true, Ordering::SeqCst);
                    }
                    *state.0.last_error.lock().expect("error mutex") = Some(message);
                    state.0.rerun.store(false, Ordering::SeqCst);
                    break;
                }
            }
            if !state.0.rerun.swap(false, Ordering::SeqCst) {
                break;
            }
        }
        *state.0.progress.lock().expect("progress mutex") = (0, 0);
        state.0.running.store(false, Ordering::SeqCst);
        emit_status(&app);
        // A trigger that landed between the last rerun check and the store
        // above found `running` still set and only left `rerun` behind.
        if state.0.rerun.swap(false, Ordering::SeqCst) {
            let _ = start(&app);
        }
    });
    Ok(())
}

/// Called after an import or a delete. Does nothing unless automatic backup is
/// on; an offline folder is remembered and filled in once it is back.
/// The folder check is a `stat` that can stall on a dropped network share, so
/// it never runs on the caller's (possibly the main) thread.
pub(crate) fn schedule_auto<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || schedule_auto_now(&app));
}

fn schedule_auto_now<R: Runtime>(app: &AppHandle<R>) {
    let (Some(db), Some(_)) = (app.try_state::<Db>(), app.try_state::<LibraryBackup>()) else {
        return;
    };
    if !auto_enabled(&db) {
        return;
    }
    let Some(dir) = configured_dir(&db) else {
        return;
    };
    if !dir.is_dir() {
        app.state::<LibraryBackup>()
            .0
            .pending
            .store(true, Ordering::SeqCst);
        emit_status(app);
        return;
    }
    if let Err(error) = start(app) {
        log::warn!("library_backup: auto start failed: {error}");
    }
}

/// Catch up once shortly after launch, then watch for an offline folder coming
/// back. The check is one `stat` a minute, and only while something is owed.
pub(crate) fn spawn_watcher<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        schedule_auto_now(&app);
        loop {
            std::thread::sleep(Duration::from_secs(60));
            let state = app.state::<LibraryBackup>();
            if !state.0.pending.load(Ordering::SeqCst) {
                continue;
            }
            let db = app.state::<Db>();
            if configured_dir(&db).is_some_and(|dir| dir.is_dir()) {
                state.0.pending.store(false, Ordering::SeqCst);
                schedule_auto_now(&app);
            }
        }
    });
}

// Every command that stats the folder is async so it runs off the main thread.
#[tauri::command]
pub async fn library_backup_status(
    db: State<'_, Db>,
    state: State<'_, LibraryBackup>,
) -> AppResult<LibraryBackupStatus> {
    Ok(status_of(&db, &state))
}

/// Pick the backup folder with the native chooser (the webview never supplies
/// a path), then back up straight away. `None` when the picker was cancelled.
#[tauri::command]
pub async fn library_backup_choose_dir(app: AppHandle) -> AppResult<Option<LibraryBackupStatus>> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let dir = picked
        .into_path()
        .map_err(|_| AppError::Other(NOT_CONFIGURED.to_string()))?;
    let db = app.state::<Db>();
    let state = app.state::<LibraryBackup>();
    check_not_inside_library(&db, &dir)?;
    if state.0.running.load(Ordering::SeqCst) {
        state.0.cancel.store(true, Ordering::SeqCst);
    }
    write_settings(
        &db,
        &[
            (DIR_KEY, dir.to_string_lossy().into_owned()),
            (LAST_AT_KEY, String::new()),
            (LAST_BOOKS_KEY, String::new()),
            (LAST_UNAVAILABLE_KEY, String::new()),
        ],
    )?;
    state.0.pending.store(false, Ordering::SeqCst);
    *state.0.last_error.lock().expect("error mutex") = None;
    start(&app)?;
    Ok(Some(status_of(&db, &state)))
}

#[tauri::command]
pub async fn library_backup_run(
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, LibraryBackup>,
) -> AppResult<LibraryBackupStatus> {
    start(&app)?;
    Ok(status_of(&db, &state))
}

#[tauri::command]
pub fn library_backup_cancel(state: State<'_, LibraryBackup>) {
    if state.0.running.load(Ordering::SeqCst) {
        state.0.cancel.store(true, Ordering::SeqCst);
        state.0.rerun.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn library_backup_set_auto(
    enabled: bool,
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, LibraryBackup>,
) -> AppResult<LibraryBackupStatus> {
    if enabled && configured_dir(&db).is_none() {
        return Err(AppError::Other(NOT_CONFIGURED.to_string()));
    }
    write_settings(
        &db,
        &[(AUTO_KEY, if enabled { "1" } else { "0" }.to_string())],
    )?;
    if enabled {
        schedule_auto(&app);
    } else {
        state.0.pending.store(false, Ordering::SeqCst);
    }
    Ok(status_of(&db, &state))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_book(db: &Db, id: &str, title: &str, cover: Option<&[u8]>) {
        let data_dir = db.data_dir().unwrap();
        fs::write(
            data_dir.join(format!("books/{id}.epub")),
            format!("book {id}"),
        )
        .unwrap();
        let cover_path = cover.map(|bytes| crate::sync::covers::relative_path(id, bytes));
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (id, title, author, file_path, format, status, progress, created_at, updated_at, cover_path, cover_data)
                 VALUES (?1, ?2, 'Author', ?3, 'epub', 'unread', 0, 1, 1, ?4, ?5)",
                params![id, title, format!("books/{id}.epub"), cover_path, cover],
            )
            .unwrap();
    }

    fn run(db: &Db, dest: &Path) -> AppResult<RunOutcome> {
        run_backup(db, dest, &AtomicBool::new(false), &mut |_, _| {})
    }

    fn setup() -> (tempfile::TempDir, tempfile::TempDir, Db) {
        let library = tempfile::tempdir().unwrap();
        let backup = tempfile::tempdir().unwrap();
        let db = Db::init(library.path()).unwrap();
        (library, backup, db)
    }

    #[test]
    fn copies_books_and_covers_and_writes_manifest() {
        let (_library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", Some(b"cover-a"));
        insert_book(&db, "b", "Beta", None);

        let outcome = run(&db, backup.path()).unwrap();
        assert_eq!(outcome.copied, 3);
        assert_eq!(outcome.books_backed_up, 2);
        assert_eq!(outcome.books_unavailable, 0);
        assert_eq!(
            fs::read(backup.path().join("books/a.epub")).unwrap(),
            b"book a"
        );
        let cover = crate::sync::covers::relative_path("a", b"cover-a");
        assert_eq!(fs::read(backup.path().join(&cover)).unwrap(), b"cover-a");

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(backup.path().join(MANIFEST_NAME)).unwrap()).unwrap();
        assert_eq!(manifest["books"]["a"]["title"], "Alpha");
        assert_eq!(manifest["books"]["a"]["in_library"], true);
    }

    #[test]
    fn second_run_copies_only_new_files() {
        let (_library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        assert_eq!(run(&db, backup.path()).unwrap().copied, 1);
        assert_eq!(run(&db, backup.path()).unwrap().copied, 0);
        insert_book(&db, "b", "Beta", None);
        let outcome = run(&db, backup.path()).unwrap();
        assert_eq!(outcome.copied, 1);
        assert_eq!(outcome.books_backed_up, 2);
    }

    #[test]
    fn keeps_a_differing_copy_aside_instead_of_overwriting() {
        let (_library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        fs::create_dir_all(backup.path().join("books")).unwrap();
        fs::write(backup.path().join("books/a.epub"), b"bo").unwrap();
        assert_eq!(run(&db, backup.path()).unwrap().copied, 1);
        assert_eq!(
            fs::read(backup.path().join("books/a.epub")).unwrap(),
            b"book a"
        );
        // The differing copy is kept aside, never discarded.
        let kept: Vec<_> = fs::read_dir(backup.path().join("books"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("a.epub.previous-"))
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(
            fs::read(backup.path().join("books").join(&kept[0])).unwrap(),
            b"bo"
        );
    }

    #[test]
    fn unreadable_manifest_is_left_untouched() {
        let (_library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        fs::write(backup.path().join(MANIFEST_NAME), b"{ not json").unwrap();
        run(&db, backup.path()).unwrap();
        assert_eq!(
            fs::read(backup.path().join(MANIFEST_NAME)).unwrap(),
            b"{ not json"
        );
    }

    #[test]
    fn deleted_book_stays_in_backup() {
        let (library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        run(&db, backup.path()).unwrap();

        db.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM books WHERE id = 'a'", [])
            .unwrap();
        fs::remove_file(library.path().join("books/a.epub")).unwrap();
        let outcome = run(&db, backup.path()).unwrap();

        assert_eq!(outcome.books_backed_up, 0);
        assert!(backup.path().join("books/a.epub").is_file());
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(backup.path().join(MANIFEST_NAME)).unwrap()).unwrap();
        assert_eq!(manifest["books"]["a"]["in_library"], false);
        assert_eq!(manifest["books"]["a"]["files"][0], "books/a.epub");
    }

    #[test]
    fn missing_source_file_counts_as_unavailable_not_failure() {
        let (library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        insert_book(&db, "b", "Beta", None);
        fs::remove_file(library.path().join("books/b.epub")).unwrap();
        let outcome = run(&db, backup.path()).unwrap();
        assert_eq!(outcome.books_backed_up, 1);
        assert_eq!(outcome.books_unavailable, 1);
    }

    #[test]
    fn offline_folder_is_reported_and_nothing_is_written() {
        let (_library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        let gone = backup.path().join("unplugged");
        let error = run(&db, &gone).unwrap_err();
        assert_eq!(error.to_string(), FOLDER_OFFLINE);
        assert!(!gone.exists());
    }

    #[test]
    fn refuses_a_folder_inside_the_library() {
        let (library, _backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        let inside = library.path().join("my-backup");
        fs::create_dir_all(&inside).unwrap();
        assert_eq!(run(&db, &inside).unwrap_err().to_string(), INSIDE_LIBRARY);
    }

    #[test]
    fn cancel_stops_before_copying() {
        let (_library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        let outcome =
            run_backup(&db, backup.path(), &AtomicBool::new(true), &mut |_, _| {}).unwrap();
        assert!(outcome.cancelled);
        assert_eq!(outcome.copied, 0);
        assert!(!backup.path().join("books/a.epub").exists());
    }

    #[test]
    fn absent_settings_read_as_defaults() {
        let (_library, _backup, db) = setup();
        let state = LibraryBackup::default();
        let status = status_of(&db, &state);
        assert_eq!(status.dir, None);
        assert!(!status.online);
        assert!(!status.auto);
        assert_eq!(status.last_at, None);
        assert_eq!(status.books_backed_up, 0);
    }

    #[test]
    fn backup_settings_never_sync() {
        for key in [
            DIR_KEY,
            AUTO_KEY,
            LAST_AT_KEY,
            LAST_BOOKS_KEY,
            LAST_UNAVAILABLE_KEY,
        ] {
            assert!(
                !crate::sync::events::is_syncable_setting(false, key),
                "{key}"
            );
        }
    }
}
