use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::chunk::chunk_sections;
use super::segment::{segment_for_fts, SegmentMode};
use super::source::{extract_source_text, resolve_book_source, BookSource};
use super::INDEX_VERSION;
use crate::commands::books::source_sha256;
use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexStatus {
    Ready,
    Building,
    Failed,
    Unsupported,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexDetails {
    pub status: IndexStatus,
    pub chunk_count: i64,
    pub index_version: Option<i64>,
    pub indexed_at: Option<i64>,
    pub error: Option<String>,
}

impl IndexStatus {
    fn from_db(value: &str) -> Self {
        match value {
            "ready" => Self::Ready,
            "building" => Self::Building,
            "failed" => Self::Failed,
            "unsupported" => Self::Unsupported,
            _ => Self::Missing,
        }
    }

    pub fn as_db(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Building => "building",
            Self::Failed => "failed",
            Self::Unsupported => "unsupported",
            Self::Missing => "missing",
        }
    }
}

pub fn index_status(db: &Db, book_id: &str) -> AppResult<IndexStatus> {
    let conn = db.reader();
    let state = conn
        .query_row(
            "SELECT status FROM book_index_state WHERE book_id = ?1",
            params![book_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(state
        .as_deref()
        .map(IndexStatus::from_db)
        .unwrap_or(IndexStatus::Missing))
}

pub fn index_details(db: &Db, book_id: &str) -> AppResult<IndexDetails> {
    let conn = db.reader();
    let state = conn
        .query_row(
            "SELECT status, chunk_count, index_version, indexed_at, error FROM book_index_state WHERE book_id = ?1",
            params![book_id],
            |row| {
                Ok(IndexDetails {
                    status: IndexStatus::from_db(&row.get::<_, String>(0)?),
                    chunk_count: row.get(1)?,
                    index_version: row.get(2)?,
                    indexed_at: row.get(3)?,
                    error: row.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(state.unwrap_or(IndexDetails {
        status: IndexStatus::Missing,
        chunk_count: 0,
        index_version: None,
        indexed_at: None,
        error: None,
    }))
}

/// Return the source snapshot that the grounding index should represent.
///
/// PDF books may be transparently served from a verified OCR asset. In that
/// case the asset content hash, rather than the original PDF hash, is the
/// snapshot that protects citations and follow-up scope inheritance.
pub fn current_source_sha256(db: &Db, book_id: &str) -> AppResult<Option<String>> {
    let source = {
        let conn = db.reader();
        conn.query_row(
            "SELECT file_path, source_file_path, COALESCE(source_format, format), source_sha256
             FROM books WHERE id = ?1",
            params![book_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?
    };
    let Some((file_path, source_file_path, source_format, stored_sha256)) = source else {
        return Ok(None);
    };

    if source_format.eq_ignore_ascii_case("pdf") {
        let data_dir = db
            .data_dir
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?
            .clone();
        let conn = db.reader();
        let resolved =
            crate::commands::ocr::resolver::resolve_active_asset(&conn, &data_dir, book_id)?;
        if let Some(hash) = resolved
            .content_sha256
            .filter(|hash| !hash.trim().is_empty())
        {
            return Ok(Some(hash));
        }
        if let Ok(hash) = source_sha256(&resolved.absolute_path) {
            if !hash.trim().is_empty() {
                return Ok(Some(hash));
            }
        }
        return Ok(stored_sha256.filter(|hash| !hash.trim().is_empty()));
    }

    if let Some(hash) = stored_sha256.filter(|hash| !hash.trim().is_empty()) {
        return Ok(Some(hash));
    }
    let path = db.resolve_path(source_file_path.as_deref().unwrap_or(&file_path))?;
    Ok(source_sha256(&path)
        .ok()
        .filter(|hash| !hash.trim().is_empty()))
}

/// Return the hash only when the stored index is ready for the current source.
/// A stale ready row is treated as unavailable until the normal index
/// scheduler rebuilds it.
pub fn ready_source_sha256(db: &Db, book_id: &str) -> AppResult<Option<String>> {
    let current = current_source_sha256(db, book_id)?;
    let state = {
        let conn = db.reader();
        conn.query_row(
            "SELECT source_sha256, status FROM book_index_state WHERE book_id = ?1",
            params![book_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    };
    let Some((indexed, status)) = state else {
        return Ok(None);
    };
    if status != IndexStatus::Ready.as_db() {
        return Ok(None);
    }
    let Some(indexed) = indexed.filter(|hash| !hash.trim().is_empty()) else {
        return Ok(None);
    };
    Ok((current.as_deref() == Some(indexed.as_str())).then_some(indexed))
}

fn record_state(
    db: &Db,
    book_id: &str,
    source_sha256: Option<&str>,
    status: IndexStatus,
    chunk_count: i64,
    error: Option<&str>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "INSERT INTO book_index_state (book_id, source_sha256, index_version, chunk_count, status, error, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(book_id) DO UPDATE SET source_sha256 = excluded.source_sha256,
             index_version = excluded.index_version, chunk_count = excluded.chunk_count,
             status = excluded.status, error = excluded.error, indexed_at = excluded.indexed_at",
        params![book_id, source_sha256, INDEX_VERSION, chunk_count, status.as_db(), error, now],
    )?;
    Ok(())
}

/// Shape of the full-text index, as this build writes it. Bump when the
/// column list or the segmentation changes; `ensure_fts_current` then
/// re-segments every chunk on the next retrieval.
///
/// Distinct from `INDEX_VERSION`, and the distinction is the whole point of
/// having two numbers. `INDEX_VERSION` says "the chunks themselves are
/// stale", and acting on it deletes `book_chunks` — which throws away every
/// `context_line`, each of which cost an AI call. This one says only "the
/// search index is stale", and acting on it rebuilds `book_chunks_fts` from
/// the chunks already on disk: no extraction, no network, no spend. Reach
/// for this one whenever the chunk text itself is still good.
const FTS_VERSION: i64 = 1;

/// Re-segment `book_chunks_fts` from `book_chunks` when the index shape has
/// moved on. Reads `book_chunks`; never writes it.
///
/// The steady-state cost is one primary-key lookup — the version matches and
/// the function returns. It runs the rebuild once per schema bump, on the
/// first retrieval after it, for the whole library at once rather than book
/// by book: `book_id` is UNINDEXED in FTS5, so "does this book have rows?"
/// is a full scan of the index, and asking it per book would cost more than
/// the one-time rebuild it is trying to avoid.
pub(crate) fn ensure_fts_current(conn: &mut Connection) -> AppResult<()> {
    let stored: Option<i64> = conn
        .query_row(
            "SELECT fts_version FROM fts_rebuild_state WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if stored == Some(FTS_VERSION) {
        return Ok(());
    }

    log::info!("grounding: rebuilding the full-text index at version {FTS_VERSION}");
    let chunks: Vec<(String, String, String, Option<String>)> = conn
        .prepare("SELECT id, book_id, text, context_line FROM book_chunks")?
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<_, _>>()?;

    let transaction = conn.transaction()?;
    transaction.execute("DELETE FROM book_chunks_fts", [])?;
    for (id, book_id, text, context_line) in &chunks {
        let rowid = insert_fts_row(&transaction, id, book_id, text, context_line.as_deref())?;
        transaction.execute(
            "UPDATE book_chunks SET fts_rowid = ?1 WHERE id = ?2",
            params![rowid, id],
        )?;
    }
    transaction.execute(
        "INSERT INTO fts_rebuild_state (id, fts_version) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET fts_version = excluded.fts_version",
        params![FTS_VERSION],
    )?;
    transaction.commit()?;
    log::info!("grounding: full-text index rebuilt over {} chunks", chunks.len());
    Ok(())
}

/// Write one chunk's row into the full-text index and hand back its rowid,
/// which is how `book_chunks` addresses it later. A chunk with no context
/// line yet indexes an empty second column, which simply never matches.
fn insert_fts_row(
    conn: &Connection,
    chunk_id: &str,
    book_id: &str,
    text: &str,
    context_line: Option<&str>,
) -> AppResult<i64> {
    let context = context_line.unwrap_or("");
    conn.execute(
        "INSERT INTO book_chunks_fts (seg_text, seg_context, chunk_id, book_id) VALUES (?1, ?2, ?3, ?4)",
        params![
            segment_for_fts(text, SegmentMode::Index),
            segment_for_fts(context, SegmentMode::Index),
            chunk_id,
            book_id
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Give a book a language tag when its file never carried one, reading the
/// prose that was just extracted for chunking.
///
/// Only ever fills a blank. A `dc:language` the publisher wrote is a fact
/// about the file and outranks anything inferred from the text — including
/// when the two disagree, which is what a bilingual edition or a translated
/// foreword looks like from here.
///
/// The first chunks are skipped: a book opens with a title page, a copyright
/// notice and a translator's credit, which are the least representative prose
/// in the volume and are often in a different language from the book itself.
fn fill_missing_language(
    conn: &Connection,
    book_id: &str,
    chunks: &[super::chunk::ChunkDraft],
) -> AppResult<()> {
    let already_known: Option<String> = conn
        .query_row(
            "SELECT language FROM books WHERE id = ?1",
            params![book_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    if already_known.is_some_and(|value| !value.trim().is_empty()) {
        return Ok(());
    }

    let skip = if chunks.len() > 6 { 3 } else { 0 };
    let sample: String = chunks
        .iter()
        .skip(skip)
        .take(5)
        .map(|chunk| chunk.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let Some(language) = super::language::detect(&sample) else {
        return Ok(());
    };
    log::info!("grounding: {book_id} reads as {language}; its file did not say");
    conn.execute(
        "UPDATE books SET language = ?2 WHERE id = ?1",
        params![book_id, language],
    )?;
    Ok(())
}

/// Build the local derived index synchronously. Callers doing UI work run it
/// through `spawn_blocking`; the function itself owns no async runtime state.
pub fn ensure_index(db: &Db, book_id: &str) -> AppResult<IndexStatus> {
    {
        let mut conn = db
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        ensure_fts_current(&mut conn)?;
    }
    let source = match resolve_book_source(db, book_id)? {
        BookSource::Missing => return Ok(IndexStatus::Missing),
        BookSource::Unsupported { stored_sha256 } => {
            record_state(
                db,
                book_id,
                stored_sha256.as_deref(),
                IndexStatus::Unsupported,
                0,
                None,
            )?;
            return Ok(IndexStatus::Unsupported);
        }
        BookSource::Ready(source) => source,
    };
    let actual_sha256 = source.sha256_or_empty().to_string();

    {
        let conn = db
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let state: Option<(Option<String>, i64, String)> = conn.query_row(
            "SELECT source_sha256, index_version, status FROM book_index_state WHERE book_id = ?1",
            params![book_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        if let Some((hash, version, status)) = state {
            if status == "building"
                && hash.as_deref() == Some(actual_sha256.as_str())
                && version == INDEX_VERSION
            {
                return Ok(IndexStatus::Building);
            }
            if status == "ready"
                && hash.as_deref() == Some(actual_sha256.as_str())
                && version == INDEX_VERSION
            {
                return Ok(IndexStatus::Ready);
            }
        }
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO book_index_state (book_id, source_sha256, index_version, chunk_count, status, error, indexed_at)
             VALUES (?1, ?2, ?3, 0, 'building', NULL, ?4)
             ON CONFLICT(book_id) DO UPDATE SET source_sha256 = excluded.source_sha256,
                 index_version = excluded.index_version, chunk_count = 0, status = 'building', error = NULL, indexed_at = excluded.indexed_at",
            params![book_id, actual_sha256, INDEX_VERSION, now],
        )?;
    }

    let result = extract_source_text(db, book_id, &source).map(chunk_sections);

    let chunks = match result {
        Ok(chunks) => chunks,
        Err(error) if error.to_string().contains("PDF_TEXT_LAYER_UNAVAILABLE") => {
            record_state(
                db,
                book_id,
                Some(&actual_sha256),
                IndexStatus::Unsupported,
                0,
                None,
            )?;
            return Ok(IndexStatus::Unsupported);
        }
        Err(error) => {
            let message = error.to_string();
            record_state(
                db,
                book_id,
                Some(&actual_sha256),
                IndexStatus::Failed,
                0,
                Some(&message),
            )?;
            return Ok(IndexStatus::Failed);
        }
    };

    let now = chrono::Utc::now().timestamp_millis();
    let mut conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let transaction = conn.transaction()?;
    transaction.execute(
        "DELETE FROM book_chunk_vectors WHERE book_id = ?1",
        params![book_id],
    )?;
    transaction.execute(
        "DELETE FROM book_chunk_embeddings WHERE book_id = ?1",
        params![book_id],
    )?;
    transaction.execute(
        "DELETE FROM book_chunks_fts WHERE book_id = ?1",
        params![book_id],
    )?;
    transaction.execute(
        "DELETE FROM book_chunks WHERE book_id = ?1",
        params![book_id],
    )?;
    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let id = Uuid::new_v4().to_string();
        // A freshly built chunk has no context line yet — the pass that
        // writes them runs later and patches its own FTS row by rowid.
        let fts_rowid = insert_fts_row(&transaction, &id, book_id, &chunk.text, None)?;
        transaction.execute(
            "INSERT INTO book_chunks (id, book_id, chunk_index, section_index, section_href, section_title, char_start, char_end, text, snippet, token_estimate, created_at, fts_rowid)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![id, book_id, chunk_index as i64, chunk.section_index, chunk.section_href, chunk.section_title,
                chunk.char_start, chunk.char_end, chunk.text, chunk.snippet, chunk.token_estimate as i64, now, fts_rowid],
        )?;
    }
    fill_missing_language(&transaction, book_id, &chunks)?;
    transaction.execute(
        "UPDATE book_index_state SET source_sha256 = ?2, index_version = ?3, chunk_count = ?4,
             status = 'ready', error = NULL, indexed_at = ?5 WHERE book_id = ?1",
        params![
            book_id,
            actual_sha256,
            INDEX_VERSION,
            chunks.len() as i64,
            now
        ],
    )?;
    transaction.commit()?;
    Ok(IndexStatus::Ready)
}

pub fn force_reindex(db: &Db, book_id: &str) -> AppResult<IndexStatus> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "DELETE FROM book_index_state WHERE book_id = ?1",
        params![book_id],
    )?;
    drop(conn);
    ensure_index(db, book_id)
}

/// Schedule an opportunistic local rebuild. Import and reader preparation must
/// never wait for extraction, and a failure only affects grounding.
pub fn schedule_index(app: AppHandle, book_id: String) {
    let db = app.state::<Db>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = ensure_index(&db, &book_id) {
            log::warn!("grounding index failed for {book_id}: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::grounding::retrieve::retrieve;
    use crate::db::Db;
    use rusqlite::params;

    #[test]
    fn fts5_is_available_in_the_bundled_sqlite() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE fts_probe USING fts5(value);")
            .unwrap();
        conn.execute("INSERT INTO fts_probe(value) VALUES ('needle')", [])
            .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM fts_probe WHERE fts_probe MATCH 'needle'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn missing_index_has_no_retrieval_result() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE book_chunks_fts USING fts5(seg_text, seg_context, chunk_id UNINDEXED, book_id UNINDEXED); CREATE TABLE book_chunks (id TEXT, book_id TEXT, chunk_index INTEGER, section_index INTEGER, section_href TEXT, section_title TEXT, char_start INTEGER, char_end INTEGER, text TEXT, snippet TEXT, token_estimate INTEGER);").unwrap();
        assert!(retrieve(&conn, "missing", "question", 100, None)
            .unwrap()
            .is_empty());
    }

    /// Seed one chunk directly, the way a build before migration 051 left
    /// things: text and a paid-for context line in `book_chunks`, and no row
    /// in the index at all.
    fn seed_chunk(
        conn: &Connection,
        id: &str,
        chunk_index: i64,
        text: &str,
        context_line: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO book_chunks (id, book_id, chunk_index, section_index, section_href,
                 section_title, char_start, char_end, text, snippet, token_estimate, created_at, context_line)
             VALUES (?1, 'book', ?2, 0, 'a.xhtml', 'One', 0, 100, ?3, ?3, 10, 1, ?4)",
            params![id, chunk_index, text, context_line],
        )
        .unwrap();
    }

    #[test]
    fn rebuilding_the_index_keeps_the_context_lines_the_reader_paid_for() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let mut conn = db.conn.lock().unwrap();
        seed_chunk(&conn, "chunk-a", 0, "He said nothing at all.", Some("Mr. Bennet"));
        seed_chunk(&conn, "chunk-b", 1, "She replied at once.", None);
        conn.execute("DELETE FROM book_chunks_fts", []).unwrap();

        ensure_fts_current(&mut conn).unwrap();

        let surviving: Vec<Option<String>> = conn
            .prepare("SELECT context_line FROM book_chunks ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            surviving,
            vec![Some("Mr. Bennet".to_string()), None],
            "a rebuild of the search index must not touch the chunks it reads"
        );
        let rowids: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM book_chunks WHERE fts_rowid IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rowids, 2, "every chunk should now address its own index row");
    }

    #[test]
    fn a_passage_that_only_says_he_is_findable_by_the_name_in_its_context_line() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let mut conn = db.conn.lock().unwrap();
        seed_chunk(
            &conn,
            "chunk-a",
            0,
            "He had not the smallest intention of yielding.",
            Some("Mr. Bennet refusing to call on the new neighbour"),
        );
        conn.execute("DELETE FROM book_chunks_fts", []).unwrap();
        ensure_fts_current(&mut conn).unwrap();

        let hits = super::super::retrieve::lexical_ranks_with_limit(&conn, "book", "Bennet", 10, None)
            .unwrap();
        assert_eq!(
            hits.len(),
            1,
            "the name appears nowhere in the passage — only the context line can find it"
        );
        assert_eq!(hits[0].0, "chunk-a");
    }

    #[test]
    fn the_book_s_own_words_outrank_a_context_line_that_merely_describes_them() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let mut conn = db.conn.lock().unwrap();
        // One chunk says "entail"; the other only has it in its description.
        seed_chunk(&conn, "says-it", 0, "the entail of Longbourn", None);
        seed_chunk(&conn, "described", 1, "It cannot be helped.", Some("the entail"));
        conn.execute("DELETE FROM book_chunks_fts", []).unwrap();
        ensure_fts_current(&mut conn).unwrap();

        let hits = super::super::retrieve::lexical_ranks_with_limit(&conn, "book", "entail", 10, None)
            .unwrap();
        assert_eq!(hits.len(), 2, "both should be found");
        assert_eq!(
            hits[0].0, "says-it",
            "the passage containing the word must rank above the one merely described by it"
        );
    }

    #[test]
    fn ready_source_hash_rejects_a_stale_index_snapshot() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO books (
                 id, title, author, file_path, source_format, render_format,
                 source_file_path, source_sha256, status, progress, created_at, updated_at
             ) VALUES ('book', 'Book', 'Author', 'books/book.epub', 'epub', 'epub',
                       'books/book.epub', 'source-a', 'unread', 0, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO book_index_state
             (book_id, source_sha256, index_version, chunk_count, status, indexed_at)
             VALUES ('book', 'source-a', ?1, 1, 'ready', 1)",
            params![INDEX_VERSION],
        )
        .unwrap();
        drop(conn);

        assert_eq!(
            ready_source_sha256(&db, "book").unwrap().as_deref(),
            Some("source-a")
        );
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE books SET source_sha256 = 'source-b' WHERE id = 'book'",
                [],
            )
            .unwrap();
        assert_eq!(ready_source_sha256(&db, "book").unwrap(), None);
    }
}
