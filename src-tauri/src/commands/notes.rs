use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::events::{normalize_learning_term, EventBody, NotePayload};
use crate::sync::merge::{self, entity};
use crate::sync::validation::{validate_entity_id, validate_note_fields};
use crate::sync::writer::SyncWriter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub book_id: Option<String>,
    pub book_title: Option<String>,
    pub anchor_kind: String,
    pub normalized_word: Option<String>,
    pub scope: String,
    pub location: Option<String>,
    pub selected_text: Option<String>,
    pub content: String,
    pub content_format: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct NotePage {
    pub notes: Vec<Note>,
    pub next_cursor: Option<String>,
    pub total: usize,
}

fn row_to_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        book_title: row.get("book_title")?,
        anchor_kind: row.get("anchor_kind")?,
        normalized_word: row.get("normalized_word")?,
        scope: row.get("scope")?,
        location: row.get("location")?,
        selected_text: row.get("selected_text")?,
        content: row.get("content")?,
        content_format: row.get("content_format")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const NOTE_COLUMNS: &str = "n.id, n.book_id, b.title AS book_title, n.anchor_kind, n.normalized_word, n.scope, n.location, n.selected_text, n.content, n.content_format, n.created_at, n.updated_at";

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_note(
    id: Option<String>,
    book_id: Option<String>,
    anchor_kind: String,
    word: Option<String>,
    scope: String,
    location: Option<String>,
    selected_text: Option<String>,
    content: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Note> {
    save_note_inner(
        id,
        book_id,
        &anchor_kind,
        word,
        &scope,
        location,
        selected_text,
        &content,
        &db,
        &sync,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn save_note_inner(
    id: Option<String>,
    book_id: Option<String>,
    anchor_kind: &str,
    word: Option<String>,
    scope: &str,
    location: Option<String>,
    selected_text: Option<String>,
    content: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Note> {
    let normalized_word = word
        .as_deref()
        .map(normalize_learning_term)
        .filter(|value| !value.is_empty());

    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let content_format = "plain_text".to_string();
    validate_note_fields(
        &id,
        book_id.as_deref(),
        anchor_kind,
        normalized_word.as_deref(),
        scope,
        location.as_deref(),
        selected_text.as_deref(),
        content,
        &content_format,
    )?;
    let timestamp = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();
    sync.with_tx(db, timestamp, |tx, events| {
        if merge::is_tombstoned(tx, entity::NOTE, &id)? {
            return Err(AppError::Other("NOTE_ALREADY_DELETED".to_string()));
        }
        let effective_book_id = match book_id.as_deref() {
            Some(candidate) => {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM books WHERE id = ?1)",
                    params![candidate],
                    |row| row.get(0),
                )?;
                if !exists && scope == "book" {
                    return Err(AppError::Other("NOTE_BOOK_NOT_FOUND".to_string()));
                }
                exists.then_some(candidate)
            }
            None => None,
        };
        let created_at = tx
            .query_row(
                "SELECT created_at FROM notes WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(timestamp);
        tx.execute(
            "INSERT INTO notes (id, book_id, anchor_kind, normalized_word, scope, location, selected_text, content, content_format, created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET book_id = excluded.book_id, anchor_kind = excluded.anchor_kind,
               normalized_word = excluded.normalized_word, scope = excluded.scope, location = excluded.location,
               selected_text = excluded.selected_text, content = excluded.content,
               content_format = excluded.content_format, updated_at = excluded.updated_at,
               updated_by_device = excluded.updated_by_device",
            params![id, effective_book_id, anchor_kind, normalized_word, scope, location, selected_text, content, content_format, created_at, timestamp, device],
        )?;
        events.push(EventBody::NoteUpsert(NotePayload {
            id: id.clone(),
            book_id: effective_book_id.map(str::to_string),
            anchor_kind: anchor_kind.to_string(),
            normalized_word: normalized_word.clone(),
            scope: scope.to_string(),
            location: location.clone(),
            selected_text: selected_text.clone(),
            content: content.to_string(),
            content_format: content_format.clone(),
            created_at,
        }));
        Ok(())
    })?;

    let conn = db.reader();
    conn.query_row(
        &format!("SELECT {NOTE_COLUMNS} FROM notes n LEFT JOIN books b ON b.id = n.book_id WHERE n.id = ?1"),
        params![id],
        row_to_note,
    )
    .map_err(Into::into)
}

pub(crate) fn delete_notes_inner(ids: &[String], db: &Db, sync: &SyncWriter) -> AppResult<usize> {
    let timestamp = sync.next_logical_timestamp();
    sync.with_tx(db, timestamp, |tx, events| {
        let mut deleted = 0;
        for id in ids {
            validate_entity_id(id)?;
            if tx.execute("DELETE FROM notes WHERE id = ?1", params![id])? > 0 {
                merge::insert_tombstone(tx, entity::NOTE, id, timestamp)?;
                events.push(EventBody::NoteDelete { id: id.clone() });
                deleted += 1;
            }
        }
        Ok(deleted)
    })
}

fn delete_note_inner(id: &str, db: &Db, sync: &SyncWriter) -> AppResult<()> {
    delete_notes_inner(&[id.to_string()], db, sync).map(|_| ())
}

#[tauri::command]
pub fn delete_note(id: String, db: State<'_, Db>, sync: State<'_, SyncWriter>) -> AppResult<()> {
    delete_note_inner(&id, &db, &sync)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn query_notes(
    db: &Db,
    book_id: Option<&str>,
    anchor_kind: Option<&str>,
    word: Option<&str>,
    search: Option<&str>,
    updated_after: Option<i64>,
    updated_before: Option<i64>,
    cursor: Option<&str>,
    limit: usize,
) -> AppResult<NotePage> {
    let normalized_word = word
        .map(normalize_learning_term)
        .filter(|value| !value.is_empty());
    let search = search.filter(|value| !value.trim().is_empty());
    let pattern = search
        .as_ref()
        .map(|value| crate::db::sqlite_contains_pattern(value.trim()));
    let conn = db.reader();
    let total: usize = conn.query_row(
        "SELECT COUNT(*) FROM notes n LEFT JOIN books b ON b.id = n.book_id
         WHERE (?1 IS NULL OR n.book_id = ?1)
           AND (?2 IS NULL OR n.anchor_kind = ?2)
           AND (?3 IS NULL OR LOWER(n.content) LIKE ?3 ESCAPE '\\' OR LOWER(COALESCE(n.selected_text, '')) LIKE ?3 ESCAPE '\\' OR LOWER(COALESCE(n.normalized_word, '')) LIKE ?3 ESCAPE '\\' OR LOWER(COALESCE(b.title, '')) LIKE ?3 ESCAPE '\\')
           AND (?4 IS NULL OR n.normalized_word = ?4)
           AND (?5 IS NULL OR n.updated_at >= ?5)
           AND (?6 IS NULL OR n.updated_at <= ?6)",
        params![
            book_id,
            anchor_kind,
            pattern,
            normalized_word,
            updated_after,
            updated_before
        ],
        |row| row.get(0),
    )?;
    let page_limit = limit.clamp(1, 500);
    let fetch_limit = page_limit + 1;
    let mut statement = conn.prepare(&format!(
        "SELECT {NOTE_COLUMNS} FROM notes n LEFT JOIN books b ON b.id = n.book_id
         WHERE (?1 IS NULL OR n.book_id = ?1)
           AND (?2 IS NULL OR n.anchor_kind = ?2)
           AND (?3 IS NULL OR LOWER(n.content) LIKE ?3 ESCAPE '\\' OR LOWER(COALESCE(n.selected_text, '')) LIKE ?3 ESCAPE '\\' OR LOWER(COALESCE(n.normalized_word, '')) LIKE ?3 ESCAPE '\\' OR LOWER(COALESCE(b.title, '')) LIKE ?3 ESCAPE '\\')
           AND (?4 IS NULL OR n.normalized_word = ?4)
           AND (?5 IS NULL OR n.updated_at >= ?5)
           AND (?6 IS NULL OR n.updated_at <= ?6)
           AND (?7 IS NULL OR printf('%020lld:%s', n.updated_at, n.id) < ?7)
         ORDER BY n.updated_at DESC, n.id DESC LIMIT ?8"
    ))?;
    let mut notes = statement
        .query_map(
            params![
                book_id,
                anchor_kind,
                pattern,
                normalized_word,
                updated_after,
                updated_before,
                cursor,
                fetch_limit
            ],
            row_to_note,
        )?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    let has_more = notes.len() > page_limit;
    notes.truncate(page_limit);
    let next_cursor = has_more.then(|| {
        let last = notes.last().expect("non-empty page with continuation");
        format!("{:020}:{}", last.updated_at, last.id)
    });
    Ok(NotePage {
        notes,
        next_cursor,
        total,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn list_notes(
    book_id: Option<String>,
    anchor_kind: Option<String>,
    // Cross-book on purpose. The vocabulary entry asks with this to show what
    // the reader wrote about a word, and a note written in one book is still
    // theirs when the word turns up in another.
    word: Option<String>,
    search: Option<String>,
    updated_after: Option<i64>,
    updated_before: Option<i64>,
    cursor: Option<String>,
    limit: Option<usize>,
    db: State<'_, Db>,
) -> AppResult<NotePage> {
    query_notes(
        &db,
        book_id.as_deref(),
        anchor_kind.as_deref(),
        word.as_deref(),
        search.as_deref(),
        updated_after,
        updated_before,
        cursor.as_deref(),
        limit.unwrap_or(100),
    )
}

/// Everything the reader has written about one thing they are looking at: a
/// word (theirs across the library, or just in this book) or an anchor in this
/// book.
///
/// An anchor answers with both kinds of note that can sit on one, because
/// after the merge there are two: a note on a passage they selected, and a
/// note on a place they kept. Asking only for selections would hide the second
/// from the card that is standing on top of it.
pub(crate) fn query_context_notes(
    db: &Db,
    book_id: &str,
    word: Option<&str>,
    location: Option<&str>,
) -> AppResult<Vec<Note>> {
    let normalized_word = word
        .map(normalize_learning_term)
        .filter(|value| !value.is_empty());
    let conn = db.reader();
    let mut statement = conn.prepare(&format!(
        "SELECT {NOTE_COLUMNS} FROM notes n LEFT JOIN books b ON b.id = n.book_id
         WHERE ((?2 IS NOT NULL AND n.anchor_kind = 'word' AND n.normalized_word = ?2 AND (n.scope = 'global' OR n.book_id = ?1))
            OR (?3 IS NOT NULL AND n.anchor_kind IN ('selection', 'position') AND n.book_id = ?1 AND n.location = ?3))
         ORDER BY n.updated_at DESC, n.id ASC"
    ))?;
    let notes = statement
        .query_map(params![book_id, normalized_word, location], row_to_note)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(notes)
}

#[tauri::command]
pub fn list_context_notes(
    book_id: String,
    word: Option<String>,
    location: Option<String>,
    db: State<'_, Db>,
) -> AppResult<Vec<Note>> {
    query_context_notes(&db, &book_id, word.as_deref(), location.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::TempDir;

    #[test]
    fn normalizes_lookup_words_without_substring_matching() {
        assert_eq!(normalize_learning_term("  Interfaces, "), "interfaces");
        assert_eq!(normalize_learning_term("don't"), "don't");
    }

    #[test]
    fn migration_preserves_legacy_highlight_note_in_both_tables() {
        let conn = Connection::open_in_memory().unwrap();
        Db::run_migrations_up_to(&conn, 20).unwrap();
        conn.execute(
            "INSERT INTO books
             (id, title, author, file_path, format, status, progress, created_at, updated_at)
             VALUES ('b1', 'Book', 'Author', 'books/b1.epub', 'epub', 'reading', 0, 1000, 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO highlights
             (id, book_id, cfi_range, color, note, text_content, created_at, updated_at)
             VALUES ('h1', 'b1', 'epubcfi(/6/4!)', 'yellow', 'legacy note',
                     'quoted text', 1100, 1200)",
            [],
        )
        .unwrap();

        Db::run_migrations_up_to(&conn, 21).unwrap();

        let migrated: (String, String, String, String, i64, i64) = conn
            .query_row(
                "SELECT book_id, anchor_kind, location, content, created_at, updated_at
                 FROM notes WHERE id = 'legacy-highlight-note-h1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            migrated,
            (
                "b1".into(),
                "selection".into(),
                "epubcfi(/6/4!)".into(),
                "legacy note".into(),
                1100,
                1200
            )
        );
        let original: String = conn
            .query_row("SELECT note FROM highlights WHERE id = 'h1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(original, "legacy note");
    }

    /// Migration 065's own text, so the re-run test drives exactly what ships
    /// rather than a copy that can drift away from it.
    const MIGRATION_065: &str =
        include_str!("../../migrations/065_bookmarks_become_position_notes.sql");

    /// Schema 64 plus a book — the state migration 065 is written against.
    fn seed_at_64() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        Db::run_migrations_up_to(&conn, 64).unwrap();
        conn.execute(
            "INSERT INTO books
             (id, title, author, file_path, format, status, progress, created_at, updated_at)
             VALUES ('b1', 'Book', 'Author', 'books/b1.epub', 'epub', 'reading', 0, 1000, 1000)",
            [],
        )
        .unwrap();
        conn
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            params![name],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn migration_065_runs_on_a_library_that_never_held_a_bookmark() {
        let conn = seed_at_64();
        assert!(table_exists(&conn, "bookmarks"));

        Db::run_migrations_up_to(&conn, 65).unwrap();

        assert!(!table_exists(&conn, "bookmarks"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM notes"), 0);
    }

    /// The one that matters: nothing may be lost, and nothing already in
    /// `notes` may be disturbed. Both flavours of bookmark are here — one the
    /// reader labelled, one they only marked — because the label-less kind is
    /// the whole reason `content` has to tolerate an empty string.
    #[test]
    fn migration_065_moves_every_bookmark_into_notes_without_touching_the_notes_already_there() {
        let conn = seed_at_64();
        conn.execute_batch(
            "INSERT INTO bookmarks (id, book_id, cfi, label, created_at, updated_at)
               VALUES ('bm-labelled', 'b1', 'epubcfi(/6/4!)', 'come back here', 1100, 1150);
             INSERT INTO bookmarks (id, book_id, cfi, label, created_at, updated_at)
               VALUES ('bm-bare', 'b1', 'epubcfi(/6/8!)', NULL, 1200, 1200);
             INSERT INTO notes
               (id, book_id, anchor_kind, normalized_word, scope, location, selected_text,
                content, content_format, created_at, updated_at, updated_by_device)
               VALUES ('n-selection', 'b1', 'selection', NULL, 'book', 'epubcfi(/6/2!)',
                       'quoted', 'a thought', 'plain_text', 1300, 1300, 'dev-A');
             INSERT INTO notes
               (id, book_id, anchor_kind, normalized_word, scope, location, selected_text,
                content, content_format, created_at, updated_at, updated_by_device)
               VALUES ('n-word', 'b1', 'word', 'ostensibly', 'book', NULL, NULL,
                       'looked it up', 'plain_text', 1400, 1400, 'dev-B');",
        )
        .unwrap();

        Db::run_migrations_up_to(&conn, 65).unwrap();

        assert!(!table_exists(&conn, "bookmarks"));
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM notes"),
            4,
            "two bookmarks in, two notes already there, four rows out — none merged, none dropped"
        );

        type Row = (
            Option<String>,
            String,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            String,
            String,
            i64,
            i64,
            String,
        );
        let read = |id: &str| -> Row {
            conn.query_row(
                "SELECT book_id, anchor_kind, normalized_word, scope, location, selected_text,
                        content, content_format, created_at, updated_at, updated_by_device
                 FROM notes WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                    ))
                },
            )
            .unwrap()
        };

        assert_eq!(
            read("bm-labelled"),
            (
                Some("b1".into()),
                "position".into(),
                None,
                "book".into(),
                Some("epubcfi(/6/4!)".into()),
                None,
                "come back here".into(),
                "plain_text".into(),
                1100,
                1150,
                "migration".into(),
            ),
            "the label becomes the note's text; both timestamps carry across untouched"
        );
        assert_eq!(
            read("bm-bare"),
            (
                Some("b1".into()),
                "position".into(),
                None,
                "book".into(),
                Some("epubcfi(/6/8!)".into()),
                None,
                String::new(),
                "plain_text".into(),
                1200,
                1200,
                "migration".into(),
            ),
            "a bookmark nobody wrote on is a position note with empty text, not a dropped row"
        );

        // The notes that were already there must come out byte-identical.
        assert_eq!(
            read("n-selection"),
            (
                Some("b1".into()),
                "selection".into(),
                None,
                "book".into(),
                Some("epubcfi(/6/2!)".into()),
                Some("quoted".into()),
                "a thought".into(),
                "plain_text".into(),
                1300,
                1300,
                "dev-A".into(),
            )
        );
        assert_eq!(
            read("n-word"),
            (
                Some("b1".into()),
                "word".into(),
                Some("ostensibly".into()),
                "book".into(),
                None,
                None,
                "looked it up".into(),
                "plain_text".into(),
                1400,
                1400,
                "dev-B".into(),
            )
        );
    }

    /// A bookmark the reader deleted must not walk back in as a note, and the
    /// marker that says so has to end up under the name the new code asks
    /// about (`note`) rather than the retired one (`bookmark`).
    #[test]
    fn migration_065_folds_bookmark_tombstones_into_note_tombstones() {
        let conn = seed_at_64();
        conn.execute_batch(
            "INSERT INTO bookmarks (id, book_id, cfi, label, created_at, updated_at)
               VALUES ('bm-live', 'b1', 'epubcfi(/6/4!)', NULL, 1100, 1100);
             INSERT INTO bookmarks (id, book_id, cfi, label, created_at, updated_at)
               VALUES ('bm-deleted-elsewhere', 'b1', 'epubcfi(/6/6!)', NULL, 1200, 1200);
             INSERT INTO _tombstones (entity, id, ts)
               VALUES ('bookmark', 'bm-deleted-elsewhere', 1250);
             INSERT INTO _tombstones (entity, id, ts) VALUES ('bookmark', 'bm-long-gone', 900);",
        )
        .unwrap();

        Db::run_migrations_up_to(&conn, 65).unwrap();

        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM _tombstones WHERE entity = 'bookmark'"),
            0,
            "no delete marker may be left under the retired name"
        );
        for id in ["bm-deleted-elsewhere", "bm-long-gone"] {
            let ts: i64 = conn
                .query_row(
                    "SELECT ts FROM _tombstones WHERE entity = 'note' AND id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(ts > 0, "{id} lost its tombstone timestamp");
        }
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM notes"),
            1,
            "only the live bookmark becomes a note"
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM notes WHERE id = 'bm-live'"),
            1
        );
    }

    /// The migration is written to survive a second pass — see its header. A
    /// re-run must be a no-op, not a duplicated row and not an error.
    #[test]
    fn migration_065_is_safe_to_run_twice() {
        let conn = seed_at_64();
        conn.execute(
            "INSERT INTO bookmarks (id, book_id, cfi, label, created_at, updated_at)
             VALUES ('bm1', 'b1', 'epubcfi(/6/4!)', 'note to self', 1100, 1150)",
            [],
        )
        .unwrap();
        Db::run_migrations_up_to(&conn, 65).unwrap();
        let after_first: Vec<(String, String, i64, i64)> = {
            let mut statement = conn
                .prepare("SELECT id, content, created_at, updated_at FROM notes ORDER BY id")
                .unwrap();
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows
        };

        conn.execute_batch(MIGRATION_065).unwrap();

        let after_second: Vec<(String, String, i64, i64)> = {
            let mut statement = conn
                .prepare("SELECT id, content, created_at, updated_at FROM notes ORDER BY id")
                .unwrap();
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows
        };
        assert_eq!(after_first, after_second);
        assert!(!table_exists(&conn, "bookmarks"));
    }

    /// The capability the merge exists to keep, not to spend: text anchored to
    /// a place rather than to a sentence. `selected_text` is `None` and stays
    /// `None`, and empty text is a legal thing to save — that is a bookmark.
    #[test]
    fn a_position_note_saves_with_and_without_anything_written_on_it() {
        let directory = TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let sync = SyncWriter::new("dev-A".into());
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress, created_at, updated_at)
                 VALUES ('b1', 'Book', 'Author', 'books/b1.epub', 'epub', 'reading', 0, 1, 1)",
                [],
            )
            .unwrap();
        }

        let bare = save_note_inner(
            None,
            Some("b1".into()),
            "position",
            None,
            "book",
            Some("epubcfi(/6/4!)".into()),
            None,
            "",
            &db,
            &sync,
        )
        .unwrap();
        assert_eq!(bare.anchor_kind, "position");
        assert_eq!(bare.content, "");
        assert_eq!(bare.selected_text, None);

        let written = save_note_inner(
            Some(bare.id.clone()),
            Some("b1".into()),
            "position",
            None,
            "book",
            Some("epubcfi(/6/4!)".into()),
            None,
            "and now a sentence about it",
            &db,
            &sync,
        )
        .unwrap();
        assert_eq!(written.id, bare.id, "writing on it is an edit, not a new row");
        assert_eq!(written.created_at, bare.created_at);
        assert_eq!(written.content, "and now a sentence about it");

        // A position note points at a spot, not at a passage — quoting text
        // into one would make it a selection note wearing the wrong label.
        assert!(save_note_inner(
            None,
            Some("b1".into()),
            "position",
            None,
            "book",
            Some("epubcfi(/6/4!)".into()),
            Some("quoted".into()),
            "",
            &db,
            &sync,
        )
        .is_err());
    }

    #[test]
    fn an_anchor_answers_with_both_the_passage_note_and_the_kept_place_on_it() {
        let directory = TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let sync = SyncWriter::new("dev-A".into());
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress, created_at, updated_at)
                 VALUES ('b1', 'Book', 'Author', 'books/b1.epub', 'epub', 'reading', 0, 1, 1)",
                [],
            )
            .unwrap();
        }
        let here = "epubcfi(/6/4!/2)";

        let passage = save_note_inner(
            None,
            Some("b1".into()),
            "selection",
            None,
            "book",
            Some(here.into()),
            Some("quoted".into()),
            "about the passage",
            &db,
            &sync,
        )
        .unwrap();
        let place = save_note_inner(
            None,
            Some("b1".into()),
            "position",
            None,
            "book",
            Some(here.into()),
            None,
            "about the place",
            &db,
            &sync,
        )
        .unwrap();
        save_note_inner(
            None,
            Some("b1".into()),
            "position",
            None,
            "book",
            Some("epubcfi(/6/4!/9)".into()),
            None,
            "somewhere else",
            &db,
            &sync,
        )
        .unwrap();

        let found = query_context_notes(&db, "b1", None, Some(here)).unwrap();
        let ids: Vec<&str> = found.iter().map(|note| note.id.as_str()).collect();
        assert_eq!(ids.len(), 2, "an anchor can carry both kinds of note");
        assert!(ids.contains(&passage.id.as_str()));
        assert!(ids.contains(&place.id.as_str()));

        // A word question is still a word question — anchors do not leak into it.
        assert!(query_context_notes(&db, "b1", Some("courage"), None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn deleting_a_note_persists_a_local_tombstone_for_snapshots() {
        let directory = TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let sync = SyncWriter::new("dev-A".into());
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO notes
                 (id, anchor_kind, scope, content, content_format,
                  created_at, updated_at, updated_by_device)
                 VALUES ('note-1', 'selection', 'detached', 'remember',
                         'plain_text', 1000, 1000, 'dev-A')",
                [],
            )
            .unwrap();
        }

        delete_note_inner("note-1", &db, &sync).unwrap();

        let conn = db.reader();
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE id = 'note-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let tombstone: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'note' AND id = 'note-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
        assert_eq!(tombstone, 1);
    }
}
