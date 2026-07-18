use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct BookAsset {
    pub id: String,
    pub book_id: String,
    pub role: String,
    pub format: String,
    pub relative_path: String,
    pub content_sha256: String,
    pub byte_size: i64,
    pub source_sha256: String,
    pub pipeline: String,
    pub pipeline_version: Option<String>,
    pub language_profile: String,
    pub quality_profile: String,
    pub page_count: i32,
    pub supersedes_asset_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by_device: String,
}

#[derive(Debug, Clone)]
pub(crate) struct NewBookAsset<'a> {
    pub id: &'a str,
    pub book_id: &'a str,
    pub relative_path: &'a str,
    pub content_sha256: &'a str,
    pub byte_size: i64,
    pub source_sha256: &'a str,
    pub pipeline_version: Option<&'a str>,
    pub language_profile: &'a str,
    pub quality_profile: &'a str,
    pub page_count: i32,
    pub supersedes_asset_id: Option<&'a str>,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by_device: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct AssetLocalState {
    pub asset_id: String,
    pub availability: String,
    pub verified_at: Option<i64>,
    pub error_code: Option<String>,
    pub updated_at: i64,
}

fn asset_error(code: &str) -> AppError {
    AppError::Other(code.to_string())
}

fn row_to_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookAsset> {
    Ok(BookAsset {
        id: row.get(0)?,
        book_id: row.get(1)?,
        role: row.get(2)?,
        format: row.get(3)?,
        relative_path: row.get(4)?,
        content_sha256: row.get(5)?,
        byte_size: row.get(6)?,
        source_sha256: row.get(7)?,
        pipeline: row.get(8)?,
        pipeline_version: row.get(9)?,
        language_profile: row.get(10)?,
        quality_profile: row.get(11)?,
        page_count: row.get(12)?,
        supersedes_asset_id: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        updated_by_device: row.get(16)?,
    })
}

const ASSET_COLUMNS: &str = "id, book_id, role, format, relative_path,
    content_sha256, byte_size, source_sha256, pipeline, pipeline_version,
    language_profile, quality_profile, page_count, supersedes_asset_id,
    created_at, updated_at, updated_by_device";

pub(crate) fn expected_relative_path(book_id: &str, asset_id: &str) -> String {
    format!("books/{book_id}.ocr.{asset_id}.pdf")
}

pub(crate) fn insert_asset(conn: &Connection, asset: NewBookAsset<'_>) -> AppResult<BookAsset> {
    crate::sync::validation::validate_entity_id(asset.id)?;
    crate::sync::validation::validate_entity_id(asset.book_id)?;
    if asset.relative_path != expected_relative_path(asset.book_id, asset.id)
        || asset.content_sha256.is_empty()
        || asset.source_sha256.is_empty()
        || asset.byte_size < 0
        || asset.page_count < 1
        || asset.language_profile.trim().is_empty()
        || asset.quality_profile != "fast"
        || asset.updated_by_device.trim().is_empty()
        || asset.updated_at < asset.created_at
    {
        return Err(asset_error("OCR_ASSET_INVALID"));
    }
    crate::sync::validation::validate_book_file_path(asset.relative_path)?;

    let book_source: Option<String> = conn
        .query_row(
            "SELECT source_sha256 FROM books WHERE id = ?1",
            params![asset.book_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    if book_source.as_deref() != Some(asset.source_sha256) {
        return Err(asset_error("OCR_ASSET_SOURCE_STALE"));
    }

    if let Some(supersedes) = asset.supersedes_asset_id {
        crate::sync::validation::validate_entity_id(supersedes)?;
        let same_book = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM book_assets WHERE id = ?1 AND book_id = ?2)",
            params![supersedes, asset.book_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !same_book {
            return Err(asset_error("OCR_ASSET_SUPERSEDES_INVALID"));
        }
    }

    conn.execute(
        "INSERT INTO book_assets (
             id, book_id, role, format, relative_path, content_sha256,
             byte_size, source_sha256, pipeline, pipeline_version,
             language_profile, quality_profile, page_count,
             supersedes_asset_id, created_at, updated_at, updated_by_device
         ) VALUES (
             ?1, ?2, 'ocr_pdf', 'pdf', ?3, ?4, ?5, ?6, 'ocrmypdf', ?7,
             ?8, ?9, ?10, ?11, ?12, ?13, ?14
         )",
        params![
            asset.id,
            asset.book_id,
            asset.relative_path,
            asset.content_sha256,
            asset.byte_size,
            asset.source_sha256,
            asset.pipeline_version,
            asset.language_profile,
            asset.quality_profile,
            asset.page_count,
            asset.supersedes_asset_id,
            asset.created_at,
            asset.updated_at,
            asset.updated_by_device,
        ],
    )?;
    get_asset(conn, asset.id)?.ok_or_else(|| asset_error("OCR_ASSET_NOT_FOUND"))
}

pub(crate) fn get_asset(conn: &Connection, id: &str) -> AppResult<Option<BookAsset>> {
    let sql = format!("SELECT {ASSET_COLUMNS} FROM book_assets WHERE id = ?1");
    conn.query_row(&sql, params![id], row_to_asset)
        .optional()
        .map_err(Into::into)
}

pub(crate) fn list_book_assets(conn: &Connection, book_id: &str) -> AppResult<Vec<BookAsset>> {
    let sql = format!(
        "SELECT {ASSET_COLUMNS} FROM book_assets
         WHERE book_id = ?1 ORDER BY updated_at DESC, id DESC"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![book_id], row_to_asset)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub(crate) fn get_local_state(
    conn: &Connection,
    asset_id: &str,
) -> AppResult<Option<AssetLocalState>> {
    conn.query_row(
        "SELECT asset_id, availability, verified_at, error_code, updated_at
         FROM book_asset_local_state WHERE asset_id = ?1",
        params![asset_id],
        |row| {
            Ok(AssetLocalState {
                asset_id: row.get(0)?,
                availability: row.get(1)?,
                verified_at: row.get(2)?,
                error_code: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub(crate) fn set_local_state(
    conn: &Connection,
    asset_id: &str,
    availability: &str,
    verified_at: Option<i64>,
    error_code: Option<&str>,
    updated_at: i64,
) -> AppResult<AssetLocalState> {
    if !matches!(
        availability,
        "remote_only" | "downloading" | "available_verified" | "corrupt"
    ) || (availability == "available_verified" && verified_at.is_none())
    {
        return Err(asset_error("OCR_ASSET_LOCAL_STATE_INVALID"));
    }
    conn.execute(
        "INSERT INTO book_asset_local_state (
             asset_id, availability, verified_at, error_code, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(asset_id) DO UPDATE SET
             availability = excluded.availability,
             verified_at = excluded.verified_at,
             error_code = excluded.error_code,
             updated_at = excluded.updated_at
         WHERE excluded.updated_at >= book_asset_local_state.updated_at",
        params![asset_id, availability, verified_at, error_code, updated_at],
    )?;
    get_local_state(conn, asset_id)?.ok_or_else(|| asset_error("OCR_ASSET_LOCAL_STATE_NOT_FOUND"))
}

pub(crate) fn absolute_asset_path(data_dir: &Path, asset: &BookAsset) -> AppResult<PathBuf> {
    crate::sync::validation::validate_book_file_path(&asset.relative_path)?;
    Ok(data_dir.join(&asset.relative_path))
}

pub(crate) fn verified_state_matches_file(
    state: &AssetLocalState,
    asset: &BookAsset,
    path: &Path,
) -> bool {
    state.availability == "available_verified"
        && state.verified_at.is_some()
        && path
            .metadata()
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() == asset.byte_size as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::Db::run_migrations_on(&conn).unwrap();
        conn.execute(
            "INSERT INTO books (
                 id, title, author, file_path, format, source_format,
                 source_file_path, source_sha256, status, progress,
                 created_at, updated_at
             ) VALUES (
                 'book-1', 'Scanned', 'Author', 'books/source.pdf', 'pdf',
                 'pdf', 'books/source.pdf', 'source-hash', 'unread', 0, 1, 1
             )",
            [],
        )
        .unwrap();
        conn
    }

    fn new_asset<'a>(
        id: &'a str,
        relative_path: &'a str,
        supersedes: Option<&'a str>,
    ) -> NewBookAsset<'a> {
        NewBookAsset {
            id,
            book_id: "book-1",
            relative_path,
            content_sha256: "asset-hash",
            byte_size: 4,
            source_sha256: "source-hash",
            pipeline_version: Some("17.8.1"),
            language_profile: "chi_sim+eng",
            quality_profile: "fast",
            page_count: 1,
            supersedes_asset_id: supersedes,
            created_at: 2,
            updated_at: 2,
            updated_by_device: "dev-a",
        }
    }

    #[test]
    fn migration_contains_only_derived_assets_and_no_preferred_pointer() {
        let conn = open_db();
        let preferred_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('books')
                 WHERE name = 'preferred_asset_id')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!preferred_exists);
        assert!(conn
            .execute(
                "INSERT INTO book_assets (
                     id, book_id, role, format, relative_path, content_sha256,
                     byte_size, source_sha256, pipeline, language_profile,
                     quality_profile, page_count, created_at, updated_at,
                     updated_by_device
                 ) VALUES (
                     'source-1', 'book-1', 'source', 'pdf', 'books/source.pdf',
                     'h', 1, 'h', 'ocrmypdf', 'chi_sim+eng', 'fast', 1, 1, 1,
                     'dev-a'
                 )",
                [],
            )
            .is_err());
    }

    #[test]
    fn assets_are_immutable_and_replacement_uses_new_row() {
        let conn = open_db();
        let first_path = expected_relative_path("book-1", "asset-1");
        insert_asset(&conn, new_asset("asset-1", &first_path, None)).unwrap();
        let replacement_path = expected_relative_path("book-1", "asset-2");
        let mut replacement = new_asset("asset-2", &replacement_path, Some("asset-1"));
        replacement.content_sha256 = "replacement-hash";
        insert_asset(&conn, replacement).unwrap();
        assert_eq!(list_book_assets(&conn, "book-1").unwrap().len(), 2);
        assert!(conn
            .execute(
                "UPDATE book_assets SET content_sha256 = 'changed' WHERE id = 'asset-1'",
                [],
            )
            .is_err());
    }

    #[test]
    fn verified_state_requires_timestamp_and_matching_file_size() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("books")).unwrap();
        let conn = open_db();
        let path = expected_relative_path("book-1", "asset-1");
        let asset = insert_asset(&conn, new_asset("asset-1", &path, None)).unwrap();
        assert!(set_local_state(&conn, &asset.id, "available_verified", None, None, 3,).is_err());
        std::fs::write(dir.path().join(&asset.relative_path), b"data").unwrap();
        let state =
            set_local_state(&conn, &asset.id, "available_verified", Some(3), None, 3).unwrap();
        assert!(verified_state_matches_file(
            &state,
            &asset,
            &absolute_asset_path(dir.path(), &asset).unwrap(),
        ));
    }
}
