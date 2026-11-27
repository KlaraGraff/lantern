//! Library backup: a one-way copy of every book's files and cover, imported
//! fonts, and a snapshot of the reading data (highlights, notes, vocabulary,
//! progress, chats, settings) into a folder the user picked (an external disk,
//! a NAS, a Dropbox folder). Readers without iCloud — every Windows reader —
//! have no other copy of their reading data.
//!
//! **Copy only, never delete.** A file already in the backup with the same
//! size is skipped, and nothing in the backup is ever removed — a book deleted
//! from the library keeps its copy there. The one exception is the data
//! snapshots: one per day in `data/`, the newest [`SNAPSHOTS_KEPT`] kept.
//! API keys are never in a snapshot: they live in `secrets.db`, which is not
//! part of `lantern.db`.
//!
//! The backup mirrors the library's own relative layout (`books/`, `sources/`,
//! `covers/`, `imported-fonts/`) and keeps `lantern-library.json` beside it,
//! mapping each book id to its title and author so the files can be found
//! again by a person.
//!
//! 从备份恢复 reads a snapshot back: it copies the snapshot's missing book
//! files into the library and stages the snapshot for `crate::restore`, which
//! swaps it in on the next launch.
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

use rusqlite::{params, Connection, OpenFlags};
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
const DATA_DIR: &str = "data";
const SNAPSHOT_PREFIX: &str = "lantern-data-";
const SNAPSHOT_SUFFIX: &str = ".db";
/// A week of daily snapshots: enough to step back past a bad day without the
/// folder growing by a database copy every launch.
const SNAPSHOTS_KEPT: usize = 7;
/// Automatic backup also runs once a day while the app stays open, so the
/// reading data in the backup is never more than a day old.
const DAILY_MS: i64 = 24 * 60 * 60 * 1000;
const CHANGED_EVENT: &str = "library-backup-changed";

const NOT_CONFIGURED: &str = "LIBRARY_BACKUP_NOT_CONFIGURED";
const FOLDER_OFFLINE: &str = "LIBRARY_BACKUP_FOLDER_OFFLINE";
const INSIDE_LIBRARY: &str = "LIBRARY_BACKUP_INSIDE_LIBRARY";
const WRITE_FAILED: &str = "LIBRARY_BACKUP_WRITE_FAILED";
const RESTORE_SYNC_ON: &str = "LIBRARY_RESTORE_SYNC_ON";
const RESTORE_NO_DATA: &str = "LIBRARY_RESTORE_NO_DATA";
const RESTORE_TOO_NEW: &str = "LIBRARY_RESTORE_TOO_NEW";
const RESTORE_DAMAGED: &str = "LIBRARY_RESTORE_DAMAGED";

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
    /// The folder the reader picked for 从备份恢复. Kept here so the restore
    /// itself never takes a path from the webview.
    restore_dir: Mutex<Option<PathBuf>>,
    /// When the daily automatic backup last tried, so a failing folder is
    /// retried hourly rather than every minute.
    last_daily_attempt: Mutex<Option<std::time::Instant>>,
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

/// Imported fonts: not tied to a book, but a restored library whose reader
/// settings name a font should find the file too.
fn font_items(db: &Db) -> AppResult<Vec<Item>> {
    let names: Vec<String> = {
        let conn = db.reader();
        let mut statement =
            conn.prepare("SELECT file_name FROM custom_fonts ORDER BY created_at")?;
        let names = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        names
    };
    let mut items = Vec::new();
    for name in names {
        let relative = format!("imported-fonts/{name}");
        match db.resolve_path(&relative) {
            Ok(source) => items.push(Item {
                relative,
                source: Source::File(source),
                essential: false,
            }),
            Err(_) => log::warn!("library_backup: skipping invalid font name {name}"),
        }
    }
    Ok(items)
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
    let fonts = font_items(db)?;

    let mut unavailable = vec![false; books.len()];
    let mut todo = Vec::new();
    let all_items = books
        .iter()
        .enumerate()
        .flat_map(|(index, book)| book.items.iter().map(move |item| (Some(index), item)))
        .chain(fonts.iter().map(|item| (None, item)));
    for (index, item) in all_items {
        let Ok(dest) = resolve_blob_path(dest_root, &item.relative) else {
            continue;
        };
        match source_len(&item.source) {
            Ok(len) if already_backed_up(&dest, len) => {}
            Ok(_) => todo.push((index, item, dest)),
            Err(_) => {
                if let Some(index) = index {
                    unavailable[index] |= item.essential;
                }
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
                if let Some(index) = index {
                    unavailable[index] |= item.essential;
                }
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
    if !outcome.cancelled {
        write_data_snapshot(db, dest_root)?;
    }

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

fn snapshot_date(name: &str) -> Option<chrono::NaiveDate> {
    let date = name
        .strip_prefix(SNAPSHOT_PREFIX)?
        .strip_suffix(SNAPSHOT_SUFFIX)?;
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

fn sqlite_failed(error: rusqlite::Error) -> AppError {
    AppError::Other(format!("{WRITE_FAILED}: {error}"))
}

/// Today's snapshot of `lantern.db`, replacing an earlier one from the same
/// day. `VACUUM INTO` reads one consistent transaction through its own
/// read-only connection, so neither the app's writer nor its reader waits.
fn write_data_snapshot(db: &Db, dest_root: &Path) -> AppResult<()> {
    let dir = dest_root.join(DATA_DIR);
    fs::create_dir_all(&dir).map_err(write_failed)?;
    let name = format!(
        "{SNAPSHOT_PREFIX}{}{SNAPSHOT_SUFFIX}",
        chrono::Local::now().format("%Y-%m-%d")
    );
    let temporary = dir.join(format!(".{name}.{}.tmp", now_ms()));
    let result = (|| -> AppResult<()> {
        let source = db.local_data_dir()?.join(crate::db::DB_FILE_NAME);
        let conn = Connection::open_with_flags(
            &source,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(sqlite_failed)?;
        crate::db::register_unicode_lower(&conn)?;
        conn.execute("VACUUM INTO ?1", params![temporary.to_string_lossy()])
            .map_err(sqlite_failed)?;
        drop(conn);
        // A rollback-journal file opens read-only without leaving `-wal` or
        // `-shm` files in the reader's backup folder.
        let copy = Connection::open(&temporary).map_err(sqlite_failed)?;
        copy.query_row("PRAGMA journal_mode = DELETE", [], |_| Ok(()))
            .map_err(sqlite_failed)?;
        drop(copy);
        fs::File::open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(write_failed)?;
        fs::rename(&temporary, dir.join(&name)).map_err(write_failed)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    prune_snapshots(&dir);
    Ok(())
}

fn snapshot_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| snapshot_date(name).is_some())
        .collect();
    // ISO dates sort by name; newest first.
    names.sort_unstable_by(|a, b| b.cmp(a));
    names
}

fn prune_snapshots(dir: &Path) {
    for name in snapshot_names(dir).into_iter().skip(SNAPSHOTS_KEPT) {
        if let Err(error) = fs::remove_file(dir.join(&name)) {
            log::warn!("library_backup: could not prune {name}: {error}");
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RestoreVersion {
    pub name: String,
    pub date: String,
    pub saved_at: Option<i64>,
    pub books: u64,
    pub highlights: u64,
    pub notes: u64,
    pub vocab: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RestorePreview {
    pub dir: String,
    pub versions: Vec<RestoreVersion>,
}

fn open_snapshot(path: &Path) -> AppResult<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

fn count(conn: &Connection, table: &str) -> u64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get::<_, i64>(0)
    })
    .map_or(0, |n| n.max(0) as u64)
}

enum Inspected {
    Ok(RestoreVersion),
    TooNew,
}

fn inspect_snapshot(dir: &Path, name: &str) -> AppResult<Inspected> {
    let path = dir.join(name);
    let conn = open_snapshot(&path)?;
    let schema: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |row| row.get(0),
    )?;
    if schema > crate::db::latest_schema_version() {
        return Ok(Inspected::TooNew);
    }
    // `books` is the one table every library has; its absence means this is
    // not a Lantern database at all.
    conn.query_row("SELECT 1 FROM books LIMIT 1", [], |_| Ok(()))
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(()),
            other => Err(other),
        })?;
    let saved_at = fs::metadata(&path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64);
    Ok(Inspected::Ok(RestoreVersion {
        name: name.to_string(),
        date: snapshot_date(name)
            .map(|d| d.to_string())
            .unwrap_or_default(),
        saved_at,
        books: count(&conn, "books"),
        highlights: count(&conn, "highlights"),
        notes: count(&conn, "notes"),
        vocab: count(&conn, "vocab_words"),
    }))
}

pub(crate) fn preview_restore(dest_root: &Path) -> AppResult<RestorePreview> {
    if !dest_root.is_dir() {
        return Err(AppError::Other(FOLDER_OFFLINE.to_string()));
    }
    let dir = dest_root.join(DATA_DIR);
    let mut versions = Vec::new();
    let mut too_new = false;
    for name in snapshot_names(&dir) {
        match inspect_snapshot(&dir, &name) {
            Ok(Inspected::Ok(version)) => versions.push(version),
            Ok(Inspected::TooNew) => too_new = true,
            Err(error) => log::warn!("library_restore: skipping unreadable {name}: {error}"),
        }
    }
    if versions.is_empty() {
        let code = if too_new {
            RESTORE_TOO_NEW
        } else {
            RESTORE_NO_DATA
        };
        return Err(AppError::Other(code.to_string()));
    }
    Ok(RestorePreview {
        dir: dest_root.to_string_lossy().into_owned(),
        versions,
    })
}

/// Copy the book files, covers and fonts the snapshot names into the library,
/// leaving any file the library already has as it is.
fn restore_files(db: &Db, dest_root: &Path, snapshot: &Path) -> AppResult<u64> {
    let conn = open_snapshot(snapshot)?;
    let mut relatives: Vec<String> = Vec::new();
    {
        let mut statement =
            conn.prepare("SELECT file_path, source_file_path, cover_path FROM books")?;
        let rows = statement.query_map([], |row| {
            Ok([
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ])
        })?;
        for row in rows {
            relatives.extend(row?.into_iter().flatten());
        }
    }
    if let Ok(mut statement) = conn.prepare("SELECT file_name FROM custom_fonts") {
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        for name in rows {
            relatives.push(format!("imported-fonts/{}", name?));
        }
    }
    drop(conn);

    let mut copied = 0;
    for relative in relatives {
        let (Ok(from), Ok(to)) = (
            resolve_blob_path(dest_root, &relative),
            db.resolve_path(&relative),
        ) else {
            continue;
        };
        if to.exists() || !from.is_file() {
            continue;
        }
        copy_into(db, &Source::File(from), &to).map_err(write_failed)?;
        copied += 1;
    }
    Ok(copied)
}

/// Copy the snapshot beside the live database, check it end to end, and leave
/// it for `crate::restore` to swap in on the next launch.
fn stage_snapshot(local_dir: &Path, snapshot: &Path) -> AppResult<()> {
    let staged = crate::restore::staged_path(local_dir);
    let temporary = local_dir.join(format!("{}.tmp", crate::restore::STAGED_FILE));
    let result = (|| -> AppResult<()> {
        fs::copy(snapshot, &temporary)?;
        let conn = Connection::open(&temporary)?;
        let check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        drop(conn);
        if check != "ok" {
            return Err(AppError::Other(RESTORE_DAMAGED.to_string()));
        }
        fs::File::open(&temporary)?.sync_all()?;
        fs::rename(&temporary, &staged)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn check_sync_off(db: &Db) -> AppResult<()> {
    if crate::sync::migration::is_sync_enabled(&db.local_data_dir()?) {
        return Err(AppError::Other(RESTORE_SYNC_ON.to_string()));
    }
    Ok(())
}

/// The whole restore short of the relaunch: files into the library, the
/// snapshot staged. `name` must be one of the folder's own snapshot names.
pub(crate) fn prepare_restore(db: &Db, dest_root: &Path, name: &str) -> AppResult<()> {
    check_sync_off(db)?;
    if snapshot_date(name).is_none() {
        return Err(AppError::Other(RESTORE_NO_DATA.to_string()));
    }
    let snapshot = dest_root.join(DATA_DIR).join(name);
    if !snapshot.is_file() {
        return Err(AppError::Other(RESTORE_NO_DATA.to_string()));
    }
    match inspect_snapshot(&dest_root.join(DATA_DIR), name) {
        Ok(Inspected::Ok(_)) => {}
        Ok(Inspected::TooNew) => return Err(AppError::Other(RESTORE_TOO_NEW.to_string())),
        Err(_) => return Err(AppError::Other(RESTORE_DAMAGED.to_string())),
    }
    let copied = restore_files(db, dest_root, &snapshot)?;
    log::info!("library_restore: copied {copied} files back from {name}");
    stage_snapshot(&db.local_data_dir()?, &snapshot)
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

/// Automatic backup is on, the last one is over a day old, and no attempt was
/// made in the last hour (a full disk would otherwise be retried every minute).
fn daily_due(db: &Db, state: &LibraryBackup) -> bool {
    if !auto_enabled(db) || state.0.running.load(Ordering::SeqCst) {
        return false;
    }
    let last_at = read_setting(db, LAST_AT_KEY).and_then(|value| value.parse::<i64>().ok());
    if last_at.is_some_and(|at| now_ms() - at < DAILY_MS) {
        return false;
    }
    let mut attempt = state.0.last_daily_attempt.lock().expect("daily mutex");
    if attempt.is_some_and(|at| at.elapsed() < Duration::from_secs(60 * 60)) {
        return false;
    }
    *attempt = Some(std::time::Instant::now());
    true
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
            let db = app.state::<Db>();
            if daily_due(&db, &state) {
                schedule_auto_now(&app);
                continue;
            }
            if !state.0.pending.load(Ordering::SeqCst) {
                continue;
            }
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

/// Pick the folder to restore from (starting at the backup folder, if any)
/// and list its snapshots. `None` when the picker was cancelled.
#[tauri::command]
pub async fn library_restore_choose(app: AppHandle) -> AppResult<Option<RestorePreview>> {
    let db = app.state::<Db>();
    check_sync_off(&db)?;
    let mut dialog = app.dialog().file();
    if let Some(dir) = configured_dir(&db).filter(|dir| dir.is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    let Some(picked) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let dir = picked
        .into_path()
        .map_err(|_| AppError::Other(RESTORE_NO_DATA.to_string()))?;
    let preview = preview_restore(&dir)?;
    *app.state::<LibraryBackup>()
        .0
        .restore_dir
        .lock()
        .expect("restore mutex") = Some(dir);
    Ok(Some(preview))
}

/// Restore the snapshot `name` from the folder `library_restore_choose`
/// picked. The frontend relaunches as soon as this returns; the swap itself
/// happens at the start of that launch (see `crate::restore`).
#[tauri::command]
pub async fn library_restore_apply(
    name: String,
    db: State<'_, Db>,
    state: State<'_, LibraryBackup>,
) -> AppResult<()> {
    let dir = state
        .0
        .restore_dir
        .lock()
        .expect("restore mutex")
        .clone()
        .ok_or_else(|| AppError::Other(RESTORE_NO_DATA.to_string()))?;
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || prepare_restore(&db, &dir, &name))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
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

    fn snapshots_in(backup: &Path) -> Vec<String> {
        snapshot_names(&backup.join(DATA_DIR))
    }

    fn set_setting(db: &Db, key: &str, value: &str) {
        write_settings(db, &[(key, value.to_string())]).unwrap();
    }

    #[test]
    fn backup_includes_a_data_snapshot_of_the_reading_data() {
        let (_library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        set_setting(&db, "probe", "before");
        run(&db, backup.path()).unwrap();

        let names = snapshots_in(backup.path());
        assert_eq!(names.len(), 1);
        let snapshot = open_snapshot(&backup.path().join(DATA_DIR).join(&names[0])).unwrap();
        let title: String = snapshot
            .query_row("SELECT title FROM books WHERE id = 'a'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "Alpha");
        let mode: String = snapshot
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "delete");
        drop(snapshot);
        // Opening it read-only leaves nothing beside it.
        let leftovers: Vec<_> = fs::read_dir(backup.path().join(DATA_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, names);

        // A second run the same day replaces that day's snapshot.
        set_setting(&db, "probe", "after");
        run(&db, backup.path()).unwrap();
        let names = snapshots_in(backup.path());
        assert_eq!(names.len(), 1);
        let snapshot = open_snapshot(&backup.path().join(DATA_DIR).join(&names[0])).unwrap();
        let probe: String = snapshot
            .query_row(
                "SELECT value FROM settings WHERE key = 'probe'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(probe, "after");
    }

    #[test]
    fn old_snapshots_are_pruned_to_a_week() {
        let (_library, backup, db) = setup();
        let dir = backup.path().join(DATA_DIR);
        fs::create_dir_all(&dir).unwrap();
        for day in 1..=9 {
            fs::write(
                dir.join(format!("{SNAPSHOT_PREFIX}2020-01-0{day}{SNAPSHOT_SUFFIX}")),
                b"x",
            )
            .unwrap();
        }
        fs::write(dir.join("notes.txt"), b"mine").unwrap();
        run(&db, backup.path()).unwrap();
        let names = snapshots_in(backup.path());
        assert_eq!(names.len(), SNAPSHOTS_KEPT);
        assert!(!names.contains(&format!("{SNAPSHOT_PREFIX}2020-01-03{SNAPSHOT_SUFFIX}")));
        assert!(names.contains(&format!("{SNAPSHOT_PREFIX}2020-01-04{SNAPSHOT_SUFFIX}")));
        // Files that are not snapshots are never touched.
        assert!(dir.join("notes.txt").is_file());
    }

    #[test]
    fn cancelled_backup_writes_no_snapshot() {
        let (_library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        run_backup(&db, backup.path(), &AtomicBool::new(true), &mut |_, _| {}).unwrap();
        assert!(snapshots_in(backup.path()).is_empty());
    }

    #[test]
    fn imported_fonts_are_backed_up_and_restored() {
        let (library, backup, db) = setup();
        let font = format!("{}.ttf", "ab".repeat(32));
        fs::write(library.path().join("imported-fonts").join(&font), b"font").unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO custom_fonts (id, family_name, file_name, format, file_size, created_at)
                 VALUES ('f', 'Mine', ?1, 'truetype', 4, 1)",
                params![font],
            )
            .unwrap();
        run(&db, backup.path()).unwrap();
        assert_eq!(
            fs::read(backup.path().join("imported-fonts").join(&font)).unwrap(),
            b"font"
        );

        let fresh = tempfile::tempdir().unwrap();
        let fresh_db = Db::init(fresh.path()).unwrap();
        let name = snapshots_in(backup.path()).remove(0);
        prepare_restore(&fresh_db, backup.path(), &name).unwrap();
        assert_eq!(
            fs::read(fresh.path().join("imported-fonts").join(&font)).unwrap(),
            b"font"
        );
    }

    #[test]
    fn preview_lists_versions_with_counts() {
        let (_library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        insert_book(&db, "b", "Beta", None);
        run(&db, backup.path()).unwrap();
        let preview = preview_restore(backup.path()).unwrap();
        assert_eq!(preview.versions.len(), 1);
        let version = &preview.versions[0];
        assert_eq!(version.books, 2);
        assert_eq!(version.highlights, 0);
        assert!(version.saved_at.is_some());
        assert_eq!(
            snapshot_date(&version.name).unwrap().to_string(),
            version.date
        );
    }

    #[test]
    fn preview_without_snapshots_says_so() {
        let (_library, backup, db) = setup();
        // A backup made before snapshots existed: books only.
        insert_book(&db, "a", "Alpha", None);
        run(&db, backup.path()).unwrap();
        fs::remove_dir_all(backup.path().join(DATA_DIR)).unwrap();
        assert_eq!(
            preview_restore(backup.path()).unwrap_err().to_string(),
            RESTORE_NO_DATA
        );
    }

    #[test]
    fn snapshot_from_a_newer_lantern_is_refused() {
        let (_library, backup, db) = setup();
        run(&db, backup.path()).unwrap();
        let name = snapshots_in(backup.path()).remove(0);
        let conn = Connection::open(backup.path().join(DATA_DIR).join(&name)).unwrap();
        conn.execute(
            "UPDATE schema_version SET version = ?1",
            params![crate::db::latest_schema_version() + 1],
        )
        .unwrap();
        drop(conn);
        assert_eq!(
            preview_restore(backup.path()).unwrap_err().to_string(),
            RESTORE_TOO_NEW
        );
        let fresh = tempfile::tempdir().unwrap();
        let fresh_db = Db::init(fresh.path()).unwrap();
        assert_eq!(
            prepare_restore(&fresh_db, backup.path(), &name)
                .unwrap_err()
                .to_string(),
            RESTORE_TOO_NEW
        );
    }

    #[test]
    fn restore_brings_books_and_data_back_after_a_reset() {
        let (library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", Some(b"cover-a"));
        set_setting(&db, "probe", "kept");
        run(&db, backup.path()).unwrap();
        drop(db);
        drop(library);

        // A fresh install (or a reset) on another disk.
        let fresh = tempfile::tempdir().unwrap();
        let fresh_db = Db::init(fresh.path()).unwrap();
        let name = snapshots_in(backup.path()).remove(0);
        prepare_restore(&fresh_db, backup.path(), &name).unwrap();
        assert_eq!(
            fs::read(fresh.path().join("books/a.epub")).unwrap(),
            b"book a"
        );
        assert!(crate::restore::staged_path(fresh.path()).is_file());
        drop(fresh_db);

        // The next launch swaps the snapshot in and opens it normally.
        assert!(crate::restore::apply_pending(fresh.path()).unwrap());
        let restored = Db::init(fresh.path()).unwrap();
        let title: String = restored
            .reader()
            .query_row("SELECT title FROM books WHERE id = 'a'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "Alpha");
        assert_eq!(read_setting(&restored, "probe").as_deref(), Some("kept"));
    }

    #[test]
    fn restore_keeps_a_book_file_the_library_already_has() {
        let (library, backup, db) = setup();
        insert_book(&db, "a", "Alpha", None);
        run(&db, backup.path()).unwrap();
        fs::write(library.path().join("books/a.epub"), b"local copy").unwrap();
        let name = snapshots_in(backup.path()).remove(0);
        prepare_restore(&db, backup.path(), &name).unwrap();
        assert_eq!(
            fs::read(library.path().join("books/a.epub")).unwrap(),
            b"local copy"
        );
    }

    #[test]
    fn restore_refuses_while_sync_is_on() {
        let (library, backup, db) = setup();
        run(&db, backup.path()).unwrap();
        crate::sync::migration::write_sync_settings(
            library.path(),
            Some(&library.path().join("shared")),
        )
        .unwrap();
        let name = snapshots_in(backup.path()).remove(0);
        assert_eq!(
            prepare_restore(&db, backup.path(), &name)
                .unwrap_err()
                .to_string(),
            RESTORE_SYNC_ON
        );
        assert!(!crate::restore::staged_path(library.path()).exists());
    }

    #[test]
    fn restore_only_takes_snapshot_names() {
        let (_library, backup, db) = setup();
        run(&db, backup.path()).unwrap();
        for name in ["../lantern.db", "lantern-data-../../x.db", "other.db"] {
            assert_eq!(
                prepare_restore(&db, backup.path(), name)
                    .unwrap_err()
                    .to_string(),
                RESTORE_NO_DATA,
                "{name}"
            );
        }
    }

    #[test]
    fn a_damaged_snapshot_is_never_staged() {
        let (library, backup, db) = setup();
        run(&db, backup.path()).unwrap();
        let name = snapshots_in(backup.path()).remove(0);
        fs::write(backup.path().join(DATA_DIR).join(&name), b"not a database").unwrap();
        assert!(prepare_restore(&db, backup.path(), &name).is_err());
        assert!(!crate::restore::staged_path(library.path()).exists());
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

    /// Real-app round trip, driven by `scripts/e2e-backup-restore.sh` (and the
    /// manual `e2e-backup-restore` workflow on a macOS runner). Each phase runs
    /// between launches of the built app against the same data dir, so the
    /// reset and the restore are applied by the app's own startup, not here.
    #[test]
    #[ignore = "run by scripts/e2e-backup-restore.sh"]
    fn e2e_backup_reset_restore_phase() {
        let phase = std::env::var("LANTERN_E2E_PHASE").expect("LANTERN_E2E_PHASE");
        let dir = PathBuf::from(std::env::var("LANTERN_E2E_DIR").expect("LANTERN_E2E_DIR"));
        let backup =
            PathBuf::from(std::env::var("LANTERN_E2E_BACKUP").expect("LANTERN_E2E_BACKUP"));
        let db = Db::init(&dir).unwrap();
        let count = |table: &str| -> i64 {
            db.reader()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        match phase.as_str() {
            "seed" => {
                assert_eq!(count("books"), 0, "app should start on an empty library");
                let epub = std::env::var("LANTERN_E2E_EPUB").expect("LANTERN_E2E_EPUB");
                let sync = crate::sync::writer::SyncWriter::new("e2e".into());
                let book = crate::commands::books::do_import_epub(&epub, &db, &sync).unwrap();
                let conn = db.conn.lock().unwrap();
                conn.execute(
                    "UPDATE books SET progress = 0.42, current_cfi = 'epubcfi(/6/8!/4/2/1:0)' WHERE id = ?1",
                    params![book.id],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO highlights (id, book_id, cfi_range, color, text_content, created_at, updated_at)
                     VALUES ('e2e-h', ?1, 'epubcfi(/6/8!/4/2,/1:0,/1:20)', 'yellow', 'It is a truth universally acknowledged', 1, 1)",
                    params![book.id],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO notes (id, book_id, anchor_kind, location, selected_text, content, created_at, updated_at)
                     VALUES ('e2e-n', ?1, 'selection', 'epubcfi(/6/8!/4/2,/1:0,/1:20)', 'It is a truth universally acknowledged', 'e2e note', 1, 1)",
                    params![book.id],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO vocab_words (id, book_id, word, definition, created_at, updated_at)
                     VALUES ('e2e-v', ?1, 'acknowledged', 'accepted as true', 1, 1)",
                    params![book.id],
                )
                .unwrap();
                drop(conn);
                write_settings(&db, &[(DIR_KEY, backup.to_string_lossy().into_owned())]).unwrap();
                let outcome =
                    run_backup(&db, &backup, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
                println!("e2e: backed up {outcome:?}");
                assert_eq!(snapshot_names(&backup.join(DATA_DIR)).len(), 1);
                crate::reset::request(&dir).unwrap();
            }
            "after_reset" => {
                assert_eq!(count("books"), 0, "reset should have emptied the library");
                assert_eq!(count("highlights"), 0);
                let preview = preview_restore(&backup).unwrap();
                println!("e2e: restore preview {preview:?}");
                let name = snapshot_names(&backup.join(DATA_DIR)).remove(0);
                prepare_restore(&db, &backup, &name).unwrap();
                assert!(crate::restore::staged_path(&dir).is_file());
            }
            "after_restore" => {
                assert_eq!(count("books"), 1);
                let (title, file_path, progress, cfi): (String, String, f64, String) = db
                    .reader()
                    .query_row(
                        "SELECT title, file_path, progress, current_cfi FROM books",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .unwrap();
                println!("e2e: restored {title} at {file_path}, progress {progress}");
                assert!(title.contains("Pride"), "{title}");
                assert!(
                    db.resolve_path(&file_path).unwrap().is_file(),
                    "book file missing"
                );
                assert!((progress - 0.42).abs() < 1e-9);
                assert_eq!(cfi, "epubcfi(/6/8!/4/2/1:0)");
                let text: String = db
                    .reader()
                    .query_row(
                        "SELECT text_content FROM highlights WHERE id = 'e2e-h'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert!(text.starts_with("It is a truth"));
                let note: String = db
                    .reader()
                    .query_row("SELECT content FROM notes WHERE id = 'e2e-n'", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(note, "e2e note");
                let word: String = db
                    .reader()
                    .query_row(
                        "SELECT word FROM vocab_words WHERE id = 'e2e-v'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(word, "acknowledged");
            }
            other => panic!("unknown phase {other}"),
        }
    }
}
