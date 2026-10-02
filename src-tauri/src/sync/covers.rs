use std::fs;
use std::io::Write;
use std::path::Path;

use rusqlite::params;
use sha2::{Digest, Sha256};

use crate::db::Db;
use crate::error::{AppError, AppResult};

pub fn relative_path(book: &str, bytes: &[u8]) -> String {
    format!("covers/{book}.{:x}.img", Sha256::digest(bytes))
}

pub fn matches(book: &str, path: &str, bytes: &[u8]) -> bool {
    if bytes.is_empty() || path == "none" || super::validation::validate_cover_path(path).is_err() {
        return false;
    }
    let hash = path
        .strip_suffix(".img")
        .and_then(|stem| stem.rsplit_once('.').map(|(_, hash)| hash));
    if hash.is_some_and(|hash| hash.len() == 64) {
        return relative_path(book, bytes) == path;
    }
    true
}

pub fn publish(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Other("SYNC_BLOB_PATH_INVALID".into()))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

/// Files and events may arrive in either order. Only the current DB identity
/// is eligible, and both its bytes and its identity are rechecked at publish.
pub fn ingest(data_dir: &Path, db: &Db) -> usize {
    let candidates: Vec<(String, Option<String>)> = {
        let Ok(conn) = db.read_conn.lock() else {
            return 0;
        };
        let Ok(mut statement) = conn.prepare(
            "SELECT id, cover_path FROM books WHERE cover_data IS NULL OR LENGTH(cover_data) = 0",
        ) else {
            return 0;
        };
        let Ok(rows) = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))) else {
            return 0;
        };
        rows.filter_map(Result::ok).collect()
    };
    let mut ingested = 0;
    for (id, stored_path) in candidates {
        let relative = stored_path
            .clone()
            .unwrap_or_else(|| format!("covers/{id}.img"));
        let Ok(path) = super::validation::resolve_cover_path(data_dir, &relative) else {
            continue;
        };
        if !path.exists() {
            crate::icloud::trigger_download_file(&path);
            continue;
        }
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        if !matches(&id, &relative, &bytes) {
            continue;
        }
        let Ok(conn) = db.conn.lock() else {
            return ingested;
        };
        if conn
            .execute(
                "UPDATE books SET cover_data = ?1 WHERE id = ?2 AND cover_path IS ?3
             AND (cover_data IS NULL OR LENGTH(cover_data) = 0)",
                params![bytes, id, stored_path],
            )
            .is_ok_and(|count| count > 0)
        {
            ingested += 1;
        }
    }
    ingested
}
