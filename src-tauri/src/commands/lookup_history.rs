use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LookupRecord {
    pub id: String,
    pub book_id: String,
    pub lookup_text: String,
    pub normalized_text: String,
    pub context_sentence: Option<String>,
    pub chapter: Option<String>,
    pub cfi: Option<String>,
    pub definition: String,
    pub context_explanation: Option<String>,
    pub created_at: i64,
    pub last_looked_up_at: i64,
    pub lookup_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_title: Option<String>,
}

fn row_to_lookup(row: &rusqlite::Row) -> rusqlite::Result<LookupRecord> {
    Ok(LookupRecord {
        id: row.get(0)?,
        book_id: row.get(1)?,
        lookup_text: row.get(2)?,
        normalized_text: row.get(3)?,
        context_sentence: row.get(4)?,
        chapter: row.get(5)?,
        cfi: row.get(6)?,
        definition: row.get(7)?,
        context_explanation: row.get(8)?,
        created_at: row.get(9)?,
        last_looked_up_at: row.get(10)?,
        lookup_count: row.get(11)?,
        book_title: None,
    })
}

const SELECT_COLS: &str = "id, book_id, lookup_text, normalized_text, context_sentence, chapter, cfi, definition, context_explanation, created_at, last_looked_up_at, lookup_count";

fn row_to_lookup_with_book(row: &rusqlite::Row) -> rusqlite::Result<LookupRecord> {
    Ok(LookupRecord {
        id: row.get(0)?,
        book_id: row.get(1)?,
        lookup_text: row.get(2)?,
        normalized_text: row.get(3)?,
        context_sentence: row.get(4)?,
        chapter: row.get(5)?,
        cfi: row.get(6)?,
        definition: row.get(7)?,
        context_explanation: row.get(8)?,
        created_at: row.get(9)?,
        last_looked_up_at: row.get(10)?,
        lookup_count: row.get(11)?,
        book_title: row.get(12)?,
    })
}

fn normalize(text: &str) -> String {
    text.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
        .to_lowercase()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_lookup_record(
    book_id: String,
    lookup_text: String,
    context_sentence: Option<String>,
    chapter: Option<String>,
    cfi: Option<String>,
    definition: String,
    context_explanation: Option<String>,
    db: State<'_, Db>,
) -> AppResult<LookupRecord> {
    let normalized_text = normalize(&lookup_text);
    if normalized_text.is_empty() {
        return Err(AppError::Other("Lookup text cannot be empty".to_string()));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;

    // CFI is required for exact reader marking. Queries without a stable CFI
    // remain in history but are inserted independently rather than deduped.
    if let Some(ref cfi_value) = cfi {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM lookup_records WHERE book_id = ?1 AND cfi = ?2 AND normalized_text = ?3 LIMIT 1",
                params![book_id, cfi_value, normalized_text],
                |row| row.get(0),
            )
            .ok();
        if let Some(existing_id) = existing {
            conn.execute(
                "UPDATE lookup_records SET lookup_text = ?1, context_sentence = ?2, chapter = ?3, definition = ?4, context_explanation = ?5, last_looked_up_at = ?6, lookup_count = lookup_count + 1 WHERE id = ?7",
                params![lookup_text, context_sentence, chapter, definition, context_explanation, now, existing_id],
            )?;
            return conn.query_row(
                &format!("SELECT {SELECT_COLS} FROM lookup_records WHERE id = ?1"),
                params![existing_id],
                row_to_lookup,
            ).map_err(Into::into);
        }
    }

    conn.execute(
        "INSERT INTO lookup_records (id, book_id, lookup_text, normalized_text, context_sentence, chapter, cfi, definition, context_explanation, created_at, last_looked_up_at, lookup_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 1)",
        params![id, book_id, lookup_text, normalized_text, context_sentence, chapter, cfi, definition, context_explanation, now],
    )?;
    conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM lookup_records WHERE id = ?1"),
        params![id],
        row_to_lookup,
    ).map_err(Into::into)
}

#[tauri::command]
pub fn list_lookup_records(book_id: String, db: State<'_, Db>) -> AppResult<Vec<LookupRecord>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM lookup_records WHERE book_id = ?1 ORDER BY last_looked_up_at DESC"
    ))?;
    let records = stmt.query_map(params![book_id], row_to_lookup)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(records)
}

#[tauri::command]
pub fn list_all_lookup_records(db: State<'_, Db>) -> AppResult<Vec<LookupRecord>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT l.id, l.book_id, l.lookup_text, l.normalized_text, l.context_sentence, l.chapter, l.cfi, l.definition, l.context_explanation, l.created_at, l.last_looked_up_at, l.lookup_count, b.title FROM lookup_records l LEFT JOIN books b ON l.book_id = b.id ORDER BY l.last_looked_up_at DESC",
    )?;
    let records = stmt.query_map([], row_to_lookup_with_book)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Db {
        let dir = tempfile::TempDir::new().unwrap();
        // Keep the temp directory alive for the test by leaking it. The DB
        // owns files beneath it and each test process exits immediately after.
        let path = dir.keep();
        let db = Db::init(&path).unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at, updated_by_device) VALUES ('book', 'Book', 'Author', 'books/book.epub', 'reading', 0, 1, 1, 'test')",
            [],
        ).unwrap();
        db
    }

    #[test]
    fn same_location_updates_lookup_count() {
        let db = setup();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO lookup_records (id, book_id, lookup_text, normalized_text, cfi, definition, created_at, last_looked_up_at, lookup_count) VALUES ('one', 'book', 'Wonder', 'wonder', 'epubcfi(/6/2)', 'first', 1, 1, 1)",
            [],
        ).unwrap();
        conn.execute(
            "UPDATE lookup_records SET definition = 'second', lookup_count = lookup_count + 1, last_looked_up_at = 2 WHERE book_id = 'book' AND cfi = 'epubcfi(/6/2)' AND normalized_text = 'wonder'",
            [],
        ).unwrap();
        let (count, definition): (i64, String) = conn.query_row(
            "SELECT lookup_count, definition FROM lookup_records WHERE id = 'one'", [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(count, 2);
        assert_eq!(definition, "second");
    }

    #[test]
    fn records_without_cfi_remain_independent() {
        let db = setup();
        let conn = db.conn.lock().unwrap();
        for id in ["one", "two"] {
            conn.execute(
                "INSERT INTO lookup_records (id, book_id, lookup_text, normalized_text, cfi, definition, created_at, last_looked_up_at, lookup_count) VALUES (?1, 'book', 'Wonder', 'wonder', NULL, '', 1, 1, 1)",
                params![id],
            ).unwrap();
        }
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM lookup_records", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);
    }
}
