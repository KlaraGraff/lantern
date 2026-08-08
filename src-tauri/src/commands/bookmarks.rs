use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::events::{BookmarkPayload, EventBody, HighlightPayload};
use crate::sync::merge::{entity, insert_tombstone};
use crate::sync::writer::SyncWriter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Bookmark {
    pub id: String,
    pub book_id: String,
    pub cfi: String,
    pub label: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Highlight {
    pub id: String,
    pub book_id: String,
    pub cfi_range: String,
    pub color: String,
    pub text_content: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightReplacement {
    pub cfi_range: String,
    pub color: String,
    pub text_content: Option<String>,
}

#[tauri::command]
pub fn add_bookmark(
    book_id: String,
    cfi: String,
    label: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Bookmark> {
    add_bookmark_inner(&book_id, &cfi, label, &db, &sync)
}

pub(crate) fn add_bookmark_inner(
    book_id: &str,
    cfi: &str,
    label: Option<String>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Bookmark> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();

    let bookmark = Bookmark {
        id: id.clone(),
        book_id: book_id.to_string(),
        cfi: cfi.to_string(),
        label: label.clone(),
        created_at: now,
        updated_at: now,
    };

    sync.with_tx(db, now, |tx, events| {
        tx.execute(
            "INSERT INTO bookmarks (id, book_id, cfi, label, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, book_id, cfi, label, now],
        )?;
        events.push(EventBody::BookmarkAdd(BookmarkPayload {
            id: id.clone(),
            book_id: book_id.to_string(),
            cfi: cfi.to_string(),
            label: label.clone(),
        }));
        Ok(())
    })?;

    Ok(bookmark)
}

#[tauri::command]
pub fn remove_bookmark(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    delete_bookmarks_inner(&[id], &db, &sync).map(|_| ())
}

pub(crate) fn delete_bookmarks_inner(
    ids: &[String],
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<usize> {
    let timestamp = sync.next_logical_timestamp();
    sync.with_tx(db, timestamp, |tx, events| {
        let mut deleted = 0;
        for id in ids {
            crate::sync::validation::validate_entity_id(id)?;
            if tx.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])? > 0 {
                insert_tombstone(tx, entity::BOOKMARK, id, timestamp)?;
                events.push(EventBody::BookmarkDelete { id: id.clone() });
                deleted += 1;
            }
        }
        Ok(deleted)
    })
}

/// Shared query helper. Same shape as `list_bookmarks` — both the Tauri
/// command and the MCP `get_bookmarks` tool call this so the column
/// list lives in exactly one place.
pub(crate) fn query_bookmarks(db: &Db, book_id: &str) -> AppResult<Vec<Bookmark>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi, label, created_at, updated_at FROM bookmarks WHERE book_id = ?1 ORDER BY created_at DESC",
    )?;
    let bookmarks = stmt
        .query_map(params![book_id], |row| {
            Ok(Bookmark {
                id: row.get("id")?,
                book_id: row.get("book_id")?,
                cfi: row.get("cfi")?,
                label: row.get("label")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(bookmarks)
}

#[tauri::command]
pub fn list_bookmarks(book_id: String, db: State<'_, Db>) -> AppResult<Vec<Bookmark>> {
    query_bookmarks(&db, &book_id)
}

#[tauri::command]
pub fn add_highlight(
    book_id: String,
    cfi_range: String,
    color: Option<String>,
    text_content: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Highlight> {
    add_highlight_inner(&book_id, &cfi_range, color, text_content, &db, &sync)
}

pub(crate) fn add_highlight_inner(
    book_id: &str,
    cfi_range: &str,
    color: Option<String>,
    text_content: Option<String>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Highlight> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let color = color.unwrap_or_else(|| "yellow".to_string());

    log::debug!("highlights: add_highlight book_id={book_id} color={color}");

    let highlight = Highlight {
        id: id.clone(),
        book_id: book_id.to_string(),
        cfi_range: cfi_range.to_string(),
        color: color.clone(),
        text_content: text_content.clone(),
        created_at: now,
        updated_at: now,
    };

    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        tx.execute(
            "INSERT INTO highlights (id, book_id, cfi_range, color, text_content, created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
            params![id, book_id, cfi_range, color, text_content, now, device],
        )?;
        events.push(EventBody::HighlightAdd(HighlightPayload {
            id: id.clone(),
            book_id: book_id.to_string(),
            cfi_range: cfi_range.to_string(),
            color: color.clone(),
            text_content: text_content.clone(),
        }));
        Ok(())
    })?;

    Ok(highlight)
}

#[tauri::command]
pub fn remove_highlight(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    delete_highlights_inner(&[id], &db, &sync).map(|_| ())
}

pub(crate) fn delete_highlights_inner(
    ids: &[String],
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<usize> {
    let timestamp = sync.next_logical_timestamp();
    sync.with_tx(db, timestamp, |tx, events| {
        let mut deleted = 0;
        for id in ids {
            crate::sync::validation::validate_entity_id(id)?;
            if tx.execute("DELETE FROM highlights WHERE id = ?1", params![id])? > 0 {
                insert_tombstone(tx, entity::HIGHLIGHT, id, timestamp)?;
                events.push(EventBody::HighlightDelete { id: id.clone() });
                deleted += 1;
            }
        }
        Ok(deleted)
    })
}

/// Atomically replaces a set of manual highlight ranges. Range merging and
/// subtraction are planned in the reader, while this command guarantees that
/// every delete/add and its sync event commit as one operation.
#[tauri::command]
pub fn replace_highlights(
    book_id: String,
    remove_ids: Vec<String>,
    additions: Vec<HighlightReplacement>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Vec<Highlight>> {
    if remove_ids.len() > 256 || additions.len() > 256 {
        return Err(AppError::Other(
            "HIGHLIGHT_REPLACEMENT_TOO_LARGE".to_string(),
        ));
    }
    let unique_remove_ids: std::collections::HashSet<&str> =
        remove_ids.iter().map(String::as_str).collect();
    if unique_remove_ids.len() != remove_ids.len() {
        return Err(AppError::Other(
            "HIGHLIGHT_REPLACEMENT_DUPLICATE_ID".to_string(),
        ));
    }
    if additions.iter().any(|addition| {
        addition.cfi_range.trim().is_empty()
            || addition.cfi_range.len() > 16_384
            || addition.color.trim().is_empty()
            || addition.color.len() > 64
            || addition
                .text_content
                .as_deref()
                .is_some_and(|value| value.len() > 1_000_000)
    }) {
        return Err(AppError::Other("HIGHLIGHT_REPLACEMENT_INVALID".to_string()));
    }

    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(&db, now, |tx, events| {
        for id in &remove_ids {
            let owner: Option<String> = tx
                .query_row(
                    "SELECT book_id FROM highlights WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;
            match owner.as_deref() {
                Some(owner) if owner != book_id => {
                    return Err(AppError::Other(
                        "HIGHLIGHT_REPLACEMENT_BOOK_MISMATCH".to_string(),
                    ));
                }
                Some(_) => {
                    tx.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
                    insert_tombstone(tx, entity::HIGHLIGHT, id, now)?;
                    events.push(EventBody::HighlightDelete { id: id.clone() });
                }
                None => {}
            }
        }

        let mut created = Vec::with_capacity(additions.len());
        for addition in &additions {
            let id = uuid::Uuid::new_v4().to_string();
            // A split or merged range is a new synced entity. Its add event
            // carries the command timestamp, so using that same timestamp for
            // both local fields keeps local SQL, peer replay, and snapshots
            // equivalent even when part of an older range is retained.
            let created_at = now;
            tx.execute(
                "INSERT INTO highlights (id, book_id, cfi_range, color, text_content, created_at, updated_at, updated_by_device)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
                params![
                    id,
                    book_id,
                    addition.cfi_range,
                    addition.color,
                    addition.text_content,
                    created_at,
                    device,
                ],
            )?;
            events.push(EventBody::HighlightAdd(HighlightPayload {
                id: id.clone(),
                book_id: book_id.clone(),
                cfi_range: addition.cfi_range.clone(),
                color: addition.color.clone(),
                text_content: addition.text_content.clone(),
            }));
            created.push(Highlight {
                id,
                book_id: book_id.clone(),
                cfi_range: addition.cfi_range.clone(),
                color: addition.color.clone(),
                text_content: addition.text_content.clone(),
                created_at,
                updated_at: now,
            });
        }
        Ok(created)
    })
}

/// Shared query helper. Mirror of `list_highlights` for the MCP
/// `get_highlights` tool — keeps the column list canonical.
pub(crate) fn query_highlights(db: &Db, book_id: &str) -> AppResult<Vec<Highlight>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi_range, color, text_content, created_at, updated_at FROM highlights WHERE book_id = ?1 ORDER BY created_at DESC",
    )?;
    let highlights = stmt
        .query_map(params![book_id], |row| {
            Ok(Highlight {
                id: row.get("id")?,
                book_id: row.get("book_id")?,
                cfi_range: row.get("cfi_range")?,
                color: row.get("color")?,
                text_content: row.get("text_content")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(highlights)
}

#[tauri::command]
pub fn list_highlights(book_id: String, db: State<'_, Db>) -> AppResult<Vec<Highlight>> {
    query_highlights(&db, &book_id)
}

#[tauri::command]
pub fn update_highlight_color(
    id: String,
    color: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    update_highlight_inner(&id, &color, &db, &sync).map(|_| ())
}

/// Colour is all a highlight carries now. Text written about a passage is a
/// `notes` row anchored at the same range — see `commands::annotations`.
pub(crate) fn update_highlight_inner(
    id: &str,
    color: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Highlight> {
    crate::sync::validation::validate_entity_id(id)?;
    let timestamp = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();
    sync.with_tx(db, timestamp, |tx, events| {
        let mut highlight = tx
            .query_row(
                "SELECT id, book_id, cfi_range, color, text_content, created_at, updated_at
                 FROM highlights WHERE id = ?1",
                params![id],
                |row| {
                    Ok(Highlight {
                        id: row.get("id")?,
                        book_id: row.get("book_id")?,
                        cfi_range: row.get("cfi_range")?,
                        color: row.get("color")?,
                        text_content: row.get("text_content")?,
                        created_at: row.get("created_at")?,
                        updated_at: row.get("updated_at")?,
                    })
                },
            )
            .map_err(|_| AppError::Other("HIGHLIGHT_NOT_FOUND".to_string()))?;
        highlight.color = color.to_string();
        events.push(EventBody::HighlightColorSet {
            id: id.to_string(),
            color: color.to_string(),
        });
        tx.execute(
            "UPDATE highlights SET color = ?1, updated_at = ?2,
                                   updated_by_device = ?3 WHERE id = ?4",
            params![&highlight.color, timestamp, device, id],
        )?;
        highlight.updated_at = timestamp;
        Ok(highlight)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use tauri::Manager;
    use tempfile::TempDir;

    #[test]
    fn replacement_highlights_use_one_current_command_timestamp() {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress,
                  created_at, updated_at)
                 VALUES ('b1', 'Book', 'Author', 'books/b1.epub', 'epub',
                         'reading', 0, 1, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO highlights
                 (id, book_id, cfi_range, color, created_at, updated_at,
                  updated_by_device)
                 VALUES ('old', 'b1', 'old-range', 'yellow', 1, 1, 'dev-A')",
                [],
            )
            .unwrap();
        }

        let app = tauri::test::mock_app();
        assert!(app.manage(db));
        assert!(app.manage(SyncWriter::new("dev-A".into())));
        let before = chrono::Utc::now().timestamp_millis();
        let created = replace_highlights(
            "b1".into(),
            vec!["old".into()],
            vec![HighlightReplacement {
                cfi_range: "new-range".into(),
                color: "blue".into(),
                text_content: Some("text".into()),
            }],
            app.state::<Db>(),
            app.state::<SyncWriter>(),
        )
        .unwrap();
        let after = chrono::Utc::now().timestamp_millis();

        assert_eq!(created.len(), 1);
        assert_eq!(created[0].created_at, created[0].updated_at);
        assert!((before..=after).contains(&created[0].created_at));

        let conn = app.state::<Db>();
        let conn = conn.conn.lock().unwrap();
        let stored: (i64, i64, String) = conn
            .query_row(
                "SELECT created_at, updated_at, updated_by_device
                 FROM highlights WHERE id = ?1",
                params![created[0].id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            stored,
            (created[0].created_at, created[0].updated_at, "dev-A".into())
        );
        let tombstone_ts: i64 = conn
            .query_row(
                "SELECT ts FROM _tombstones WHERE entity = 'highlight' AND id = 'old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            tombstone_ts, created[0].created_at,
            "replacement deletes and additions must share the command timestamp"
        );
    }

    #[test]
    fn a_colour_change_moves_the_lww_clock_and_nothing_else() {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress,
                  created_at, updated_at)
                 VALUES ('b1', 'Book', 'Author', 'books/b1.epub', 'epub',
                         'reading', 0, 1, 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO highlights
                 (id, book_id, cfi_range, color, text_content, created_at,
                  updated_at, updated_by_device)
                 VALUES ('h1', 'b1', 'range', 'yellow', 'quoted', 1, 1, 'dev-A')",
                [],
            )
            .unwrap();
        }

        let app = tauri::test::mock_app();
        assert!(app.manage(db));
        assert!(app.manage(SyncWriter::new("dev-B".into())));

        let updated =
            update_highlight_inner("h1", "blue", &app.state::<Db>(), &app.state::<SyncWriter>())
                .unwrap();
        assert_eq!(updated.color, "blue");
        assert_eq!(updated.text_content.as_deref(), Some("quoted"));
        assert!(updated.updated_at > updated.created_at);

        let db = app.state::<Db>();
        let conn = db.conn.lock().unwrap();
        let stored: (String, String, i64) = conn
            .query_row(
                "SELECT color, updated_by_device, created_at FROM highlights WHERE id = 'h1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored, ("blue".into(), "dev-B".into(), 1));
    }

    /// The column is gone as of migration 035 — a highlight is a range and a
    /// colour, and everything written about it lives in `notes`.
    #[test]
    fn highlights_no_longer_carry_a_note_column() {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let conn = db.conn.lock().unwrap();
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('highlights')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(!columns.iter().any(|name| name == "note"), "{columns:?}");
    }
}
