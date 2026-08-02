//! Library tools: read (`list_books`, `get_book`, `get_collections`)
//! and metadata/reading-state writes. Import and deletion use the batch-capable
//! tools in `library_batch` for both single and multiple books.
//!
//! Read tools are pure projections over shared query helpers. File
//! paths returned stay relative (no `resolve_book_paths`) so the
//! response doesn't leak the user's home directory layout.
//!
//! Write tools are gated behind `McpState.sync` — they return a clear
//! error when write access is disabled.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::tool;
use rmcp::tool_router;
use rmcp::ErrorData;
use rusqlite::{params, OptionalExtension};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ai::grounding;
use crate::commands::books;
use crate::commands::collections;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::server::LanternMcpHandler;
use crate::sync::events::EventBody;
use crate::sync::writer::SyncWriter;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListBooksArgs {
    /// Optional filter: `"reading"`, `"finished"`, `"unread"`, `"all"`,
    /// or any genre string. Omit for the full library.
    #[serde(default)]
    pub filter: Option<String>,
    /// Optional case-insensitive substring search across title and
    /// author. Omit for no search.
    #[serde(default)]
    pub search: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetBookArgs {
    /// Book ID as returned by `list_books` (UUID).
    pub book_id: String,
}

#[derive(Debug, Serialize)]
struct McpFileReadiness {
    source_availability: String,
    reader_availability: String,
    reader_ready: bool,
    reader_source: String,
}

#[derive(Debug, Serialize)]
struct McpOcrStatus {
    pipeline_enabled: bool,
    selected_asset_id: Option<String>,
    selected_asset_availability: Option<String>,
    latest_job_state: Option<String>,
    latest_job_phase: Option<String>,
    pages_done: Option<i32>,
    pages_total: Option<i32>,
    error_code: Option<String>,
}

/// MCP-facing projection of `books::Book`. Absolute paths and cover bytes are
/// deliberately omitted, while every user-visible readiness state is kept.
#[derive(Debug, Serialize)]
pub(crate) struct McpBook {
    id: String,
    title: String,
    author: String,
    description: Option<String>,
    file_path: String,
    format: String,
    source_format: Option<String>,
    render_format: Option<String>,
    source_file_path: Option<String>,
    source_sha256: Option<String>,
    conversion_version: i32,
    genre: Option<String>,
    pages: Option<i32>,
    status: String,
    progress: i32,
    current_cfi: Option<String>,
    preparation_state: String,
    preparation_error: Option<String>,
    readiness: McpFileReadiness,
    index: grounding::index::IndexDetails,
    #[serde(skip_serializing_if = "Option::is_none")]
    ocr: Option<McpOcrStatus>,
    created_at: i64,
    updated_at: i64,
    has_cover: bool,
}

impl McpBook {
    pub(crate) fn project(b: books::Book, db: &Db) -> AppResult<Self> {
        let has_cover = b.cover_data.as_ref().is_some_and(|d| !d.is_empty());
        let readiness = project_file_readiness(&b, db)?;
        let index = grounding::index::index_details(db, &b.id)?;
        let ocr = is_pdf(&b).then(|| project_ocr_status(&b, db)).transpose()?;
        Ok(Self {
            id: b.id,
            title: b.title,
            author: b.author,
            description: b.description,
            file_path: b.file_path,
            format: b.format,
            source_format: b.source_format,
            render_format: b.render_format,
            source_file_path: b.source_file_path,
            source_sha256: b.source_sha256,
            conversion_version: b.conversion_version,
            genre: b.genre,
            pages: b.pages,
            status: b.status,
            progress: b.progress,
            current_cfi: b.current_cfi,
            preparation_state: b.preparation_state,
            preparation_error: b.preparation_error,
            readiness,
            index,
            ocr,
            created_at: b.created_at,
            updated_at: b.updated_at,
            has_cover,
        })
    }
}

fn is_pdf(book: &books::Book) -> bool {
    book.source_format
        .as_deref()
        .unwrap_or(&book.format)
        .eq_ignore_ascii_case("pdf")
}

fn project_file_readiness(book: &books::Book, db: &Db) -> AppResult<McpFileReadiness> {
    let source_path =
        db.resolve_path(book.source_file_path.as_deref().unwrap_or(&book.file_path))?;
    let source_availability = crate::icloud::file_availability(&source_path)
        .as_str()
        .to_string();

    let (reader_path, reader_source) = if is_pdf(book) {
        let data_dir = db
            .data_dir
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?
            .clone();
        let resolved = {
            let conn = db.reader();
            crate::commands::ocr::resolver::resolve_active_asset(&conn, &data_dir, &book.id)?
        };
        (resolved.absolute_path, resolved.selection_reason)
    } else if book.render_format.as_deref() == Some("text") {
        (
            db.local_data_dir()?
                .join("prepared")
                .join(format!("{}.v{}.json", book.id, book.conversion_version)),
            "prepared_text".to_string(),
        )
    } else if books::is_conversion_book(
        book.render_format.as_deref(),
        book.source_format.as_deref(),
    ) {
        (
            db.local_data_dir()?.join("prepared").join(format!(
                "{}.converted.v{}.epub",
                book.id, book.conversion_version
            )),
            "converted_epub".to_string(),
        )
    } else {
        (db.resolve_path(&book.file_path)?, "source".to_string())
    };
    let reader_availability = crate::icloud::file_availability(&reader_path)
        .as_str()
        .to_string();
    let reader_ready = book.preparation_state == "ready" && reader_availability == "available";
    Ok(McpFileReadiness {
        source_availability,
        reader_availability,
        reader_ready,
        reader_source,
    })
}

fn project_ocr_status(book: &books::Book, db: &Db) -> AppResult<McpOcrStatus> {
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .clone();
    let conn = db.reader();
    let resolved =
        crate::commands::ocr::resolver::resolve_active_asset(&conn, &data_dir, &book.id)?;
    let selected_asset_id = resolved.asset.as_ref().map(|asset| asset.id.clone());
    let selected_asset_availability = selected_asset_id
        .as_deref()
        .map(|asset_id| {
            conn.query_row(
                "SELECT availability FROM book_asset_local_state WHERE asset_id = ?1",
                params![asset_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
        .transpose()?
        .flatten();
    let latest_job = conn
        .query_row(
            "SELECT state, phase, pages_done, pages_total, error_code
             FROM ocr_jobs WHERE book_id = ?1
             ORDER BY updated_at DESC, id DESC LIMIT 1",
            params![book.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i32>>(2)?,
                    row.get::<_, Option<i32>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let (latest_job_state, latest_job_phase, pages_done, pages_total, error_code) = latest_job
        .map(|job| (Some(job.0), job.1, job.2, job.3, job.4))
        .unwrap_or_default();
    Ok(McpOcrStatus {
        pipeline_enabled: crate::commands::ocr::pipeline_enabled(),
        selected_asset_id,
        selected_asset_availability,
        latest_job_state,
        latest_job_phase,
        pages_done,
        pages_total,
        error_code,
    })
}

#[tool_router(router = library_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "List books in the local library. Optionally filter by status or genre and search title/author. Returns relative file paths (under the app data directory). Covers are stored as BLOBs in the DB — use `has_cover` to check availability.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn list_books(
        &self,
        Parameters(ListBooksArgs { filter, search }): Parameters<ListBooksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let raw = books::query_books_lite(
            &self.state.db,
            filter.as_deref(),
            search.as_deref(),
            None,
            1000,
        )
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let books: Vec<McpBook> = raw
            .into_iter()
            .map(|book| McpBook::project(book, &self.state.db))
            .collect::<AppResult<_>>()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(&books)?]))
    }

    #[tool(
        description = "Fetch a single book by its ID, including reading progress, current CFI, file readiness, OCR state, and local index details.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn get_book(
        &self,
        Parameters(GetBookArgs { book_id }): Parameters<GetBookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let book = books::query_book(&self.state.db, &book_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let book = McpBook::project(book, &self.state.db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(&book)?]))
    }

    #[tool(
        description = "List all collections in the library with per-collection book counts.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn get_collections(&self) -> Result<CallToolResult, ErrorData> {
        let collections = collections::query_collections(&self.state.db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &collections,
        )?]))
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateBookArgs {
    /// Book ID (UUID).
    pub book_id: String,
    /// New title. Omit to leave unchanged.
    #[serde(default)]
    pub title: Option<String>,
    /// New author. Omit to leave unchanged.
    #[serde(default)]
    pub author: Option<String>,
    /// New genre. Omit to leave unchanged.
    #[serde(default)]
    pub genre: Option<String>,
    /// New status: "unread", "reading", or "finished". Omit to leave unchanged.
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetReadingStateArgs {
    /// Book ID (UUID).
    pub book_id: String,
    /// Reading status: `unread`, `reading`, or `finished`. Omit to preserve it.
    #[serde(default)]
    pub status: Option<String>,
    /// Reading progress from 0 through 100. Omit to preserve it. Setting status to `finished` defaults progress to 100.
    #[serde(default)]
    pub progress: Option<i32>,
    /// New reader locator/CFI. Omit to preserve the current locator.
    #[serde(default)]
    pub current_cfi: Option<String>,
    /// Clear the saved locator. Mutually exclusive with `current_cfi`.
    #[serde(default)]
    pub clear_current_cfi: bool,
}

pub(crate) fn require_sync(
    handler: &LanternMcpHandler,
) -> Result<&crate::sync::writer::SyncWriter, ErrorData> {
    let sync = handler
        .state
        .sync
        .as_ref()
        .map(|arc| arc.as_ref())
        .ok_or_else(|| {
            ErrorData::invalid_request(
                "Write access was not enabled when this MCP session started. \
                 Enable it in Lantern → Settings → MCP → Allow write access, \
                 then restart the MCP client so a new session picks up the change.",
                None,
            )
        })?;

    // Re-check the setting from SQLite so toggling write access off in
    // the Lantern UI takes effect immediately, without restarting the
    // MCP subprocess.
    let still_enabled = handler
        .state
        .db
        .conn
        .lock()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT value FROM settings WHERE key = 'mcp_write_enabled'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .map(|v| v == "true")
        .unwrap_or(false);

    if !still_enabled {
        return Err(ErrorData::invalid_request(
            "Write access was revoked. Re-enable it in Lantern → Settings → MCP → Allow write access.",
            None,
        ));
    }

    Ok(sync)
}

fn validate_reading_state(args: &SetReadingStateArgs) -> Result<(), String> {
    if args.status.is_none()
        && args.progress.is_none()
        && args.current_cfi.is_none()
        && !args.clear_current_cfi
    {
        return Err("At least one reading-state field must be supplied".to_string());
    }
    if args
        .status
        .as_deref()
        .is_some_and(|status| !matches!(status, "unread" | "reading" | "finished"))
    {
        return Err("`status` must be `unread`, `reading`, or `finished`".to_string());
    }
    if args
        .progress
        .is_some_and(|progress| !(0..=100).contains(&progress))
    {
        return Err("`progress` must be between 0 and 100".to_string());
    }
    if args.clear_current_cfi && args.current_cfi.is_some() {
        return Err("`clear_current_cfi` cannot be combined with `current_cfi`".to_string());
    }
    if args
        .current_cfi
        .as_deref()
        .is_some_and(|cfi| cfi.trim().is_empty() || cfi.len() > 16_384)
    {
        return Err("`current_cfi` must be non-empty and no longer than 16384 bytes".to_string());
    }
    Ok(())
}

fn do_set_reading_state(
    args: &SetReadingStateArgs,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<books::Book> {
    crate::sync::validation::validate_entity_id(&args.book_id)?;
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        let current = tx
            .query_row(
                "SELECT status, progress, current_cfi FROM books WHERE id = ?1",
                params![args.book_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i32>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::Other("BOOK_NOT_FOUND".to_string()))?;
        let next_status = args.status.as_deref().unwrap_or(&current.0);
        let next_progress = args.progress.unwrap_or_else(|| {
            if args.status.as_deref() == Some("finished") {
                100
            } else {
                current.1
            }
        });
        let next_cfi = if args.clear_current_cfi {
            None
        } else {
            args.current_cfi.clone().or(current.2.clone())
        };
        let status_changed = next_status != current.0;
        let progress_changed = next_progress != current.1 || next_cfi != current.2;
        if status_changed || progress_changed {
            tx.execute(
                "UPDATE books SET status = ?1, progress = ?2, current_cfi = ?3,
                                  updated_at = ?4, updated_by_device = ?5 WHERE id = ?6",
                params![
                    next_status,
                    next_progress,
                    next_cfi,
                    now,
                    device,
                    args.book_id
                ],
            )?;
        }
        if status_changed {
            events.push(EventBody::BookStatusSet {
                book: args.book_id.clone(),
                status: next_status.to_string(),
            });
        }
        if progress_changed {
            events.push(EventBody::BookProgressSet {
                book: args.book_id.clone(),
                progress: next_progress,
                cfi: next_cfi,
            });
        }
        Ok(())
    })?;
    books::query_book(db, &args.book_id)
}

#[tool_router(router = library_write_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Update a book's metadata. Only specified fields are changed; omitted fields stay as-is.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn update_book(
        &self,
        Parameters(UpdateBookArgs {
            book_id,
            title,
            author,
            genre,
            status,
        }): Parameters<UpdateBookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let book = books::do_update_book(
            &book_id,
            title.as_deref(),
            author.as_deref(),
            genre.as_deref(),
            status.as_deref(),
            &self.state.db,
            sync,
        )
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("books", "updated", &book_id);
        let mcp_book = McpBook::project(book, &self.state.db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &mcp_book,
        )?]))
    }

    #[tool(
        description = "Update saved reading status, progress, and/or the current locator. This is an ordinary reversible metadata edit. Marking a book finished sets progress to 100 unless an explicit progress is supplied.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn set_reading_state(
        &self,
        Parameters(args): Parameters<SetReadingStateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        validate_reading_state(&args)
            .map_err(|message| ErrorData::invalid_params(message, None))?;
        let sync = require_sync(self)?;
        let book = do_set_reading_state(&args, &self.state.db, sync)
            .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        self.state.notify("books", "updated", &args.book_id);
        let book = McpBook::project(book, &self.state.db)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::json(&book)?]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_state_rejects_invalid_and_ambiguous_values() {
        let empty = SetReadingStateArgs {
            book_id: "book".into(),
            status: None,
            progress: None,
            current_cfi: None,
            clear_current_cfi: false,
        };
        assert!(validate_reading_state(&empty).is_err());
        let invalid = SetReadingStateArgs {
            book_id: "book".into(),
            status: Some("done".into()),
            progress: Some(101),
            current_cfi: Some("cfi".into()),
            clear_current_cfi: true,
        };
        assert!(validate_reading_state(&invalid).is_err());
    }

    #[test]
    fn projection_reports_missing_reader_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let book = books::Book {
            id: "book".into(),
            title: "Book".into(),
            author: "Author".into(),
            description: None,
            cover_path: None,
            file_path: "books/book.txt".into(),
            format: "txt".into(),
            source_format: Some("txt".into()),
            render_format: Some("text".into()),
            source_file_path: Some("books/book.txt".into()),
            source_sha256: None,
            conversion_version: 3,
            preparation_state: "ready".into(),
            preparation_error: None,
            genre: None,
            pages: None,
            status: "unread".into(),
            progress: 0,
            current_cfi: None,
            created_at: 1,
            updated_at: 1,
            available: true,
            cover_data: None,
        };
        std::fs::write(dir.path().join("books/book.txt"), "source").unwrap();
        let readiness = project_file_readiness(&book, &db).unwrap();
        assert_eq!(readiness.source_availability, "available");
        assert_eq!(readiness.reader_availability, "missing");
        assert!(!readiness.reader_ready);
    }

    #[test]
    fn marking_finished_sets_full_progress_and_preserves_locator() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress, current_cfi,
                  created_at, updated_at)
                 VALUES ('book', 'Book', 'Author', 'books/book.epub', 'epub',
                         'reading', 45, 'epubcfi(/6/4)', 1, 1)",
                [],
            )
            .unwrap();
        let sync = SyncWriter::new("mcp-test".into());
        let book = do_set_reading_state(
            &SetReadingStateArgs {
                book_id: "book".into(),
                status: Some("finished".into()),
                progress: None,
                current_cfi: None,
                clear_current_cfi: false,
            },
            &db,
            &sync,
        )
        .unwrap();
        assert_eq!(book.status, "finished");
        assert_eq!(book.progress, 100);
        assert_eq!(book.current_cfi.as_deref(), Some("epubcfi(/6/4)"));
    }
}
