use std::fs;

use rusqlite::params;
use uuid::Uuid;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::events::{BookAssetPayload, EventBody};
use crate::sync::writer::SyncWriter;

use super::assets::{expected_relative_path, BookAsset, NewBookAsset};
use super::validate::VerifiedOutput;

#[derive(Debug, Clone)]
pub(crate) struct NewAssetRow {
    pub book_id: String,
    pub source_sha256: String,
    pub pipeline_version: Option<String>,
    pub supersedes_asset_id: Option<String>,
    pub verified: VerifiedOutput,
    pub created_at: i64,
    pub updated_by_device: String,
}

fn publish_error(code: &str) -> AppError {
    AppError::Other(code.to_string())
}

pub(crate) fn publish_verified_output(
    db: &Db,
    sync: &SyncWriter,
    row: NewAssetRow,
) -> AppResult<String> {
    crate::sync::validation::validate_entity_id(&row.book_id)?;
    if row.updated_by_device != sync.self_device() {
        return Err(publish_error("OCR_PUBLISH_DEVICE_MISMATCH"));
    }
    let _mutation = sync.mutation_guard()?;
    let asset_id = Uuid::new_v4().to_string();
    let relative_path = expected_relative_path(&row.book_id, &asset_id);
    let final_path = db.resolve_path(&relative_path)?;
    let parent = final_path
        .parent()
        .ok_or_else(|| publish_error("OCR_PUBLISH_PATH_INVALID"))?;
    fs::create_dir_all(parent)?;
    let sidecar = parent.join(format!(".{asset_id}.publishing.pdf"));
    if sidecar.exists() || final_path.exists() {
        return Err(publish_error("OCR_PUBLISH_DESTINATION_EXISTS"));
    }
    fs::copy(&row.verified.path, &sidecar)?;
    if fs::metadata(&sidecar)?.len() != row.verified.byte_size as u64 {
        let _ = fs::remove_file(&sidecar);
        return Err(publish_error("OCR_PUBLISH_COPY_INVALID"));
    }
    fs::rename(&sidecar, &final_path)?;

    let result = sync.with_tx(db, row.created_at, |tx, events| {
        let asset = NewBookAsset {
            id: &asset_id,
            book_id: &row.book_id,
            relative_path: &relative_path,
            content_sha256: &row.verified.content_sha256,
            byte_size: row.verified.byte_size,
            source_sha256: &row.source_sha256,
            pipeline_version: row.pipeline_version.as_deref(),
            language_profile: "chi_sim+eng",
            quality_profile: "fast",
            page_count: row.verified.page_count,
            supersedes_asset_id: row.supersedes_asset_id.as_deref(),
            created_at: row.created_at,
            updated_at: row.created_at,
            updated_by_device: &row.updated_by_device,
        };
        insert_asset_in_transaction(tx, asset)?;
        tx.execute(
            "INSERT INTO book_asset_local_state (
                 asset_id, availability, verified_at, error_code, updated_at
             ) VALUES (?1, 'available_verified', ?2, NULL, ?2)",
            params![asset_id, row.created_at],
        )?;
        events.push(EventBody::BookAssetPublish(BookAssetPayload {
            id: asset_id.clone(),
            book_id: row.book_id.clone(),
            role: "ocr_pdf".to_string(),
            format: "pdf".to_string(),
            relative_path: relative_path.clone(),
            content_sha256: row.verified.content_sha256.clone(),
            byte_size: row.verified.byte_size,
            source_sha256: row.source_sha256.clone(),
            pipeline: "ocrmypdf".to_string(),
            pipeline_version: row.pipeline_version.clone(),
            language_profile: "chi_sim+eng".to_string(),
            quality_profile: "fast".to_string(),
            page_count: row.verified.page_count,
            supersedes_asset_id: row.supersedes_asset_id.clone(),
            created_at: row.created_at,
            updated_at: row.created_at,
            updated_by_device: row.updated_by_device.clone(),
        }));
        Ok(())
    });
    if let Err(error) = result {
        let _ = fs::remove_file(&final_path);
        return Err(error);
    }
    Ok(asset_id)
}

fn insert_asset_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    asset: NewBookAsset<'_>,
) -> AppResult<BookAsset> {
    super::assets::insert_asset(tx, asset)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn publish_failure_leaves_no_final_asset() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let staging = dir.path().join("result.pdf");
        fs::write(&staging, b"pdf").unwrap();
        let sync = SyncWriter::new("dev-a".to_string());
        let error = publish_verified_output(
            &db,
            &sync,
            NewAssetRow {
                book_id: "missing-book".to_string(),
                source_sha256: "source".to_string(),
                pipeline_version: Some("test".to_string()),
                supersedes_asset_id: None,
                verified: VerifiedOutput {
                    path: staging,
                    content_sha256: "hash".to_string(),
                    byte_size: 3,
                    page_count: 1,
                    recognized_pages: 1,
                    skipped_pages: 0,
                    timed_out_pages: 0,
                    failed_pages: 0,
                },
                created_at: 1,
                updated_by_device: "dev-a".to_string(),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("OCR_ASSET_SOURCE_STALE"));
        let books = dir.path().join("books");
        let files = fs::read_dir(books)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<PathBuf>>();
        assert!(files.is_empty());
    }

    #[test]
    fn publish_commits_asset_and_outbox_event_together() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let source_sha256 = "bb".repeat(32);
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (
                     id, title, author, file_path, format, source_format,
                     source_file_path, source_sha256, status, progress,
                     created_at, updated_at
                 ) VALUES (
                     'book-1', 'Scanned', 'Author', 'books/source.pdf', 'pdf',
                     'pdf', 'books/source.pdf', ?1, 'unread', 0, ?2, ?2
                 )",
                params![source_sha256, 1_714_770_000_000_i64],
            )
            .unwrap();
        let staging = dir.path().join("result.pdf");
        let bytes = b"pdf";
        fs::write(&staging, bytes).unwrap();
        let sync = SyncWriter::new("dev-a".to_string());
        sync.set_should_queue(true);

        let asset_id = publish_verified_output(
            &db,
            &sync,
            NewAssetRow {
                book_id: "book-1".to_string(),
                source_sha256,
                pipeline_version: Some("17.8.1".to_string()),
                supersedes_asset_id: None,
                verified: VerifiedOutput {
                    path: staging,
                    content_sha256: format!("{:x}", Sha256::digest(bytes)),
                    byte_size: bytes.len() as i64,
                    page_count: 1,
                    recognized_pages: 1,
                    skipped_pages: 0,
                    timed_out_pages: 0,
                    failed_pages: 0,
                },
                created_at: 1_714_770_000_001,
                updated_by_device: "dev-a".to_string(),
            },
        )
        .unwrap();

        let conn = db.reader();
        let body_json: String = conn
            .query_row("SELECT body_json FROM _pending_publish", [], |row| {
                row.get(0)
            })
            .unwrap();
        let event: EventBody = serde_json::from_str(&body_json).unwrap();
        let EventBody::BookAssetPublish(payload) = event else {
            panic!("expected book.asset.publish");
        };
        assert_eq!(payload.id, asset_id);
        assert_eq!(payload.updated_by_device, "dev-a");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM book_assets", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(conn);
        assert!(db.resolve_path(&payload.relative_path).unwrap().is_file());
    }
}
