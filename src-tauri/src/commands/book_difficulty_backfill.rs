//! One-time backfill of `book_difficulty_sections` (migration 057) for books
//! whose difficulty was computed before that table existed.
//!
//! `book_difficulty`'s own compute path (`commands::book_difficulty`) now
//! writes both the aggregate row and its per-section breakdown in the same
//! pass, for every book it touches from here on. This module exists only for
//! the backlog that path will never revisit on its own: a book analyzed
//! before migration 057 shipped has an aggregate row and no sections, and
//! nothing about opening or rereading that book calls `compute_and_store`
//! again.
//!
//! Three properties, all borrowed from `commands::vocab_gloss_backfill`'s
//! shape even though the reason differs — that job paces itself against an
//! AI provider's rate limit and a reader's quota; this one paces itself
//! against the reader's CPU and disk, since a section backfill re-parses the
//! book's file:
//!
//! - **Paced and capped per launch.** [`RUN_MAX`] books, [`BOOK_DELAY_MS`]
//!   apart, so a library with hundreds of already-analyzed books is caught up
//!   over several launches rather than in one burst that makes the app feel
//!   busy right after opening.
//! - **Resumable, with no bookkeeping.** The pending set is *derived* —
//!   `book_difficulty` rows with a successful status and no matching rows in
//!   `book_difficulty_sections` — so there is no cursor to lose and a crash
//!   mid-run costs at most the book in flight. A book is out of the pending
//!   set the moment its sections exist, whether this job wrote them or a
//!   fresh `compute_and_store` did.
//! - **Never touches the aggregate row.** A book whose file has changed since
//!   its aggregate was computed (`source_sha256` mismatch) is left alone: its
//!   sections would not sum to a stale aggregate, and rewriting the aggregate
//!   here would silently redo work `compute_book_difficulty` owns. That book
//!   is caught the next time anything actually recomputes it — which now
//!   always writes sections too — not by this job guessing on its behalf.
//!
//! No AI, no network, no `auto_analysis` registry entry: there is no spend
//! to gate and nothing for a reader to switch off. It runs unconditionally,
//! the same way `resume_interrupted_text_book_preparations` does.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rusqlite::{params, Connection};

use crate::ai::grounding::source::{extract_source_text, resolve_readable_source, BookSource};
use crate::commands::book_difficulty::write_sections;
use crate::db::Db;
use crate::error::AppResult;

/// Books backfilled per app launch. A book's cost here is a full text
/// extraction — the same work `compute_and_store` does for one book — so
/// this stays small even though it is pure local computation with no
/// per-call price tag.
pub const RUN_MAX: usize = 5;

/// Pause between two books in one run. Long enough that a large backlog
/// reads as steady background work rather than a burst that pins a core.
const BOOK_DELAY_MS: u64 = 500;

/// How long the job waits after launch before its first book. Startup is
/// already contended (migrations, library scan, sync, the vocab-gloss
/// repair); nothing here is urgent enough to compete with it.
const STARTUP_DELAY_MS: u64 = 25_000;

/// One run at a time, process-wide — mirrors `vocab_gloss_backfill::RUNNING`
/// for the same reason: two windows opening in quick succession must not
/// each start a run over the same books.
static RUNNING: AtomicBool = AtomicBool::new(false);

struct PendingBook {
    book_id: String,
    source_sha256: Option<String>,
}

/// Every book whose difficulty was computed successfully and has no rows in
/// `book_difficulty_sections` yet, oldest computation first.
///
/// PDF books are excluded at the SQL level, not just skipped once reached:
/// `write_sections` never writes rows for a PDF (see its doc comment), so a
/// PDF book would otherwise match "no rows yet" forever and this query would
/// keep reselecting it — and, unlike an EPUB, resolving *and reading* a PDF
/// far enough to learn that is not free. Checking `books.source_format`
/// here answers the same question without opening the file at all.
fn pending_on(conn: &Connection, limit: usize) -> AppResult<Vec<PendingBook>> {
    let mut statement = conn.prepare(
        "SELECT bd.book_id, bd.source_sha256
         FROM book_difficulty bd
         JOIN books b ON b.id = bd.book_id
         WHERE bd.status IN ('done', 'too_short')
           AND LOWER(COALESCE(b.source_format, b.format)) != 'pdf'
           AND NOT EXISTS (
             SELECT 1 FROM book_difficulty_sections s WHERE s.book_id = bd.book_id
           )
         ORDER BY bd.computed_at ASC
         LIMIT ?1",
    )?;
    let rows = statement.query_map(params![limit as i64], |row| {
        Ok(PendingBook {
            book_id: row.get("book_id")?,
            source_sha256: row.get("source_sha256")?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn pending(db: &Db, limit: usize) -> AppResult<Vec<PendingBook>> {
    pending_on(&db.reader(), limit)
}

/// Has this book already been handled — by this job, by a fresh recompute,
/// or by another device's write replayed since the pending list was read?
fn still_pending(db: &Db, book_id: &str) -> bool {
    !db.reader()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM book_difficulty_sections WHERE book_id = ?1)",
            params![book_id],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(true)
}

/// Fill in one book's per-section rows, provided the file on disk still
/// matches the hash its aggregate row was computed from. Returns whether
/// anything was written.
fn backfill_one(db: &Db, book_id: &str, expected_sha256: Option<&str>) -> AppResult<bool> {
    let source = match resolve_readable_source(db, book_id)? {
        BookSource::Ready(source) => source,
        // The book (or the readable artifact it depended on) is gone since
        // its aggregate was computed. Nothing to backfill from.
        BookSource::Missing | BookSource::Unsupported { .. } => return Ok(false),
    };
    if source.format == "pdf" {
        // Excluded by `pending_on` already; kept here too so a direct call
        // to this function (as the tests make) cannot write PDF rows.
        return Ok(false);
    }
    if source.sha256.as_deref() != expected_sha256 {
        // Stale: the file has moved on since the aggregate was computed.
        // Sections extracted from today's file would not sum to that
        // aggregate, so this book is left for its next real recompute.
        return Ok(false);
    }

    let sections = extract_source_text(db, book_id, &source)?;
    write_sections(
        db,
        book_id,
        &source.format,
        &sections,
        source.sha256.as_deref(),
    )?;
    Ok(true)
}

/// Backfill up to `limit` books, serially and paced. Returns how many
/// actually got sections written.
///
/// Runs entirely on whatever thread calls it — [`spawn_on_start`] is the
/// only caller in the app, and it runs this on a blocking-pool thread, the
/// same way `compute_book_difficulty`'s own worker does, because extraction
/// is CPU- and disk-bound rather than the network wait `vocab_gloss_backfill`
/// paces against.
pub fn run_backfill(db: &Db, limit: usize) -> AppResult<usize> {
    let rows = pending(db, limit)?;
    if rows.is_empty() {
        return Ok(0);
    }

    let mut filled = 0usize;
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            std::thread::sleep(Duration::from_millis(BOOK_DELAY_MS));
        }
        if !still_pending(db, &row.book_id) {
            continue;
        }
        match backfill_one(db, &row.book_id, row.source_sha256.as_deref()) {
            Ok(true) => filled += 1,
            Ok(false) => {}
            Err(error) => {
                log::debug!(
                    "book_difficulty_backfill: leaving {} as it was: {error}",
                    row.book_id
                );
            }
        }
    }
    Ok(filled)
}

/// Start one backfill pass in the background, some way into the session.
///
/// Called from `lib.rs`'s `setup`, unconditionally — there is no switch for
/// the reader to find because there is nothing to spend on their behalf.
pub fn spawn_on_start(db: Db) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(STARTUP_DELAY_MS));
        match run_backfill(&db, RUN_MAX) {
            Ok(0) => {}
            Ok(count) => log::info!("book_difficulty_backfill: filled {count} book(s)"),
            Err(error) => log::debug!("book_difficulty_backfill: run skipped: {error}"),
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_db() -> (TempDir, Db) {
        let directory = TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        (directory, db)
    }

    fn insert_book(db: &Db, id: &str, source_format: &str, file_path: &str) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO books (
                     id, title, author, file_path, source_format, render_format,
                     source_file_path, status, progress, created_at, updated_at
                 ) VALUES (?1, 'Book', 'Author', ?2, ?3, ?3, ?2, 'unread', 0, 1, 1)",
                params![id, file_path, source_format],
            )
            .unwrap();
    }

    fn insert_difficulty(db: &Db, book_id: &str, status: &str, source_sha256: Option<&str>) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO book_difficulty (book_id, status, source_sha256, computed_at)
                 VALUES (?1, ?2, ?3, '2026-01-01T00:00:00Z')",
                params![book_id, status, source_sha256],
            )
            .unwrap();
    }

    fn insert_section_stub(db: &Db, book_id: &str) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO book_difficulty_sections
                     (book_id, section_order, chapter_title, total_tokens, computed_at)
                 VALUES (?1, 0, NULL, 10, '2026-01-01T00:00:00Z')",
                params![book_id],
            )
            .unwrap();
    }

    // --- the pending query ---

    #[test]
    fn pending_lists_only_books_missing_section_rows() {
        let (_dir, db) = test_db();
        insert_book(&db, "has-sections", "epub", "books/a.epub");
        insert_difficulty(&db, "has-sections", "done", Some("hash-a"));
        insert_section_stub(&db, "has-sections");

        insert_book(&db, "needs-backfill", "epub", "books/b.epub");
        insert_difficulty(&db, "needs-backfill", "done", Some("hash-b"));

        let rows = pending(&db, 10).unwrap();
        let ids: Vec<&str> = rows.iter().map(|row| row.book_id.as_str()).collect();
        assert_eq!(ids, vec!["needs-backfill"]);
    }

    #[test]
    fn pending_excludes_pdf_books_so_they_are_never_reselected() {
        let (_dir, db) = test_db();
        insert_book(&db, "a-pdf", "pdf", "books/a.pdf");
        insert_difficulty(&db, "a-pdf", "done", Some("hash-a"));

        assert!(pending(&db, 10).unwrap().is_empty());
    }

    #[test]
    fn pending_excludes_rows_that_never_finished_successfully() {
        let (_dir, db) = test_db();
        insert_book(&db, "still-running", "epub", "books/a.epub");
        insert_difficulty(&db, "still-running", "running", None);
        insert_book(&db, "failed", "epub", "books/b.epub");
        insert_difficulty(&db, "failed", "failed", None);

        assert!(pending(&db, 10).unwrap().is_empty());
    }

    #[test]
    fn pending_respects_its_limit() {
        let (_dir, db) = test_db();
        for index in 0..5 {
            let id = format!("book{index}");
            insert_book(&db, &id, "epub", &format!("books/{id}.epub"));
            insert_difficulty(&db, &id, "done", None);
        }
        assert_eq!(pending(&db, 2).unwrap().len(), 2);
    }

    // --- backfilling a real book ---

    fn epub_fixture_path() -> std::path::PathBuf {
        std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/reader-compat/minimal-deflated.epub"
        ))
    }

    /// End to end: a book difficulty row computed "before migration 057"
    /// (simulated by never having called `compute_and_store`) gets its
    /// sections filled in from the same file, matching the hash already on
    /// the aggregate row.
    #[test]
    fn backfill_one_writes_sections_when_the_hash_still_matches() {
        let (directory, db) = test_db();
        let books_dir = directory.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        std::fs::copy(epub_fixture_path(), books_dir.join("book.epub")).unwrap();
        insert_book(&db, "book", "epub", "books/book.epub");

        // Compute once, through the real path, to learn the authentic hash
        // and aggregate — then delete the sections it wrote to reproduce a
        // book_difficulty row computed before migration 057 existed.
        let computed = crate::commands::book_difficulty::compute_and_store(&db, "book").unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "DELETE FROM book_difficulty_sections WHERE book_id = 'book'",
                [],
            )
            .unwrap();
        assert!(section_count(&db, "book") == 0);

        let filled = backfill_one(&db, "book", computed.source_sha256.as_deref()).unwrap();
        assert!(filled);
        assert!(section_count(&db, "book") > 0);
    }

    /// A book whose file changed since its aggregate was computed is left
    /// alone rather than backfilled from today's (different) file.
    #[test]
    fn backfill_one_skips_a_stale_book_without_writing_anything() {
        let (directory, db) = test_db();
        let books_dir = directory.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        std::fs::copy(epub_fixture_path(), books_dir.join("book.epub")).unwrap();
        insert_book(&db, "book", "epub", "books/book.epub");
        insert_difficulty(&db, "book", "done", Some("a-hash-that-does-not-match-the-file"));

        let filled = backfill_one(&db, "book", Some("a-hash-that-does-not-match-the-file")).unwrap();
        assert!(!filled);
        assert_eq!(section_count(&db, "book"), 0);
    }

    /// A row another device (or a manual recompute) already filled between
    /// the pending query and this device reaching it is not redone.
    #[test]
    fn still_pending_is_false_once_sections_exist() {
        let (_dir, db) = test_db();
        insert_book(&db, "book", "epub", "books/book.epub");
        assert!(still_pending(&db, "book"));
        insert_section_stub(&db, "book");
        assert!(!still_pending(&db, "book"));
    }

    fn section_count(db: &Db, book_id: &str) -> i64 {
        db.reader()
            .query_row(
                "SELECT COUNT(*) FROM book_difficulty_sections WHERE book_id = ?1",
                params![book_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn nothing_pending_backfills_nothing() {
        let (_dir, db) = test_db();
        assert_eq!(run_backfill(&db, 10).unwrap(), 0);
    }
}
