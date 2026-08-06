use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::writer::SyncWriter;

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
    pub result_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_title: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LookupRecordPage {
    pub records: Vec<LookupRecord>,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub books: Vec<LookupBookFacet>,
}

#[derive(Debug, Serialize)]
pub struct LookupBookFacet {
    pub book_id: String,
    pub book_title: Option<String>,
    pub count: usize,
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
        result_json: row.get(12)?,
        provider_profile_id: row.get(13)?,
        model: row.get(14)?,
        updated_at: row.get(15)?,
        book_title: None,
    })
}

const SELECT_COLS: &str = "id, book_id, lookup_text, normalized_text, context_sentence, chapter, cfi, definition, context_explanation, created_at, last_looked_up_at, lookup_count, result_json, provider_profile_id, model, COALESCE(updated_at, last_looked_up_at)";

fn configured_retention_days(conn: &rusqlite::Connection) -> Option<i64> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'lookup_history_retention_days'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|value| value.parse::<i64>().ok())
    .filter(|days| *days > 0)
}

fn prune_lookup_records_conn(
    conn: &rusqlite::Connection,
    retention_days: Option<i64>,
) -> rusqlite::Result<usize> {
    let Some(days) = retention_days else {
        return Ok(0);
    };
    let cutoff = chrono::Utc::now().timestamp_millis() - days.saturating_mul(24 * 60 * 60 * 1000);
    conn.execute(
        "DELETE FROM lookup_records WHERE last_looked_up_at < ?1",
        params![cutoff],
    )
}

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
        result_json: row.get(12)?,
        provider_profile_id: row.get(13)?,
        model: row.get(14)?,
        updated_at: row.get(15)?,
        book_title: row.get(16)?,
    })
}

/// Shared with `mastery::store`, which has to match aggregated exposure rows
/// (already normalized this way on the frontend) against `vocab_words.word`,
/// which is stored raw. SQL's `LOWER(TRIM(...))` is not the same function —
/// it would leave the comma on `"quiet,"` and never match.
pub(crate) fn normalize(text: &str) -> String {
    text.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
        .to_lowercase()
}

/// Everything one lookup records about itself. A struct rather than ten
/// parameters because the command and its testable inner would otherwise have
/// to keep two identical argument lists in the same order.
pub struct LookupInput {
    pub book_id: String,
    pub lookup_text: String,
    pub context_sentence: Option<String>,
    pub chapter: Option<String>,
    pub cfi: Option<String>,
    pub definition: String,
    pub context_explanation: Option<String>,
    pub result_json: Option<String>,
    pub provider_profile_id: Option<String>,
    pub model: Option<String>,
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
    result_json: Option<String>,
    provider_profile_id: Option<String>,
    model: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<LookupRecord> {
    save_lookup_record_inner(
        LookupInput {
            book_id,
            lookup_text,
            context_sentence,
            chapter,
            cfi,
            definition,
            context_explanation,
            result_json,
            provider_profile_id,
            model,
        },
        &db,
        &sync,
    )
}

/// Persist one lookup, and let the mastery engine hear about it.
///
/// The two happen in one transaction because they are one fact: the reader
/// stopped and asked what a word means. A crash between them would leave the
/// history saying the reader needed help and the word's tier saying they
/// didn't.
pub fn save_lookup_record_inner(
    input: LookupInput,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<LookupRecord> {
    let LookupInput {
        book_id,
        lookup_text,
        context_sentence,
        chapter,
        cfi,
        definition,
        context_explanation,
        result_json,
        provider_profile_id,
        model,
    } = input;
    let normalized_text = normalize(&lookup_text);
    if normalized_text.is_empty() {
        return Err(AppError::Other("Lookup text cannot be empty".to_string()));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();

    sync.with_tx(db, now, |tx, events| {
        let id = uuid::Uuid::new_v4().to_string();
        // CFI is required for exact reader marking. Queries without a stable
        // CFI remain in history but are inserted independently rather than
        // deduped.
        let existing: Option<String> = match cfi.as_ref() {
            Some(cfi_value) => tx
                .query_row(
                    "SELECT id FROM lookup_records WHERE book_id = ?1 AND cfi = ?2 AND normalized_text = ?3 LIMIT 1",
                    params![book_id, cfi_value, normalized_text],
                    |row| row.get(0),
                )
                .optional()?,
            None => None,
        };

        let record_id = match existing {
            Some(existing_id) => {
                tx.execute(
                    "UPDATE lookup_records SET lookup_text = ?1, context_sentence = ?2, chapter = ?3, definition = ?4, context_explanation = ?5, result_json = ?6, provider_profile_id = ?7, model = ?8, last_looked_up_at = ?9, updated_at = ?9, lookup_count = lookup_count + 1 WHERE id = ?10",
                    params![lookup_text, context_sentence, chapter, definition, context_explanation, result_json, provider_profile_id, model, now, existing_id],
                )?;
                existing_id
            }
            None => {
                tx.execute(
                    "INSERT INTO lookup_records (id, book_id, lookup_text, normalized_text, context_sentence, chapter, cfi, definition, context_explanation, result_json, provider_profile_id, model, created_at, last_looked_up_at, updated_at, lookup_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?13, 1)",
                    params![id, book_id, lookup_text, normalized_text, context_sentence, chapter, cfi, definition, context_explanation, result_json, provider_profile_id, model, now],
                )?;
                id
            }
        };

        // Must run before `apply_lookup_to_word`: that function only scores a
        // word that already has a `vocab_words` row, and a first-time lookup
        // doesn't have one until this call creates it (in the observation
        // zone — see `observe_lookup_for_vocab`).
        crate::commands::vocab::observe_lookup_for_vocab(
            tx,
            events,
            &book_id,
            &lookup_text,
            &normalized_text,
            &definition,
            context_sentence.as_deref(),
            context_explanation.as_deref(),
            cfi.as_deref(),
            now,
            &device,
        )?;

        crate::mastery::store::apply_lookup_to_word(
            tx,
            events,
            &book_id,
            &lookup_text,
            now,
            &device,
        )?;

        prune_lookup_records_conn(tx, configured_retention_days(tx))?;
        tx.query_row(
            &format!("SELECT {SELECT_COLS} FROM lookup_records WHERE id = ?1"),
            params![record_id],
            row_to_lookup,
        )
        .map_err(Into::into)
    })
}

/// Cached answers are scoped to one occurrence: the same word in the same
/// position, or failing that the same word in the same sentence. A card
/// explains the word *here*, so a different context has to be asked again.
fn find_cached_lookup(
    conn: &rusqlite::Connection,
    book_id: &str,
    normalized_text: &str,
    cfi: Option<&str>,
    context_sentence: Option<&str>,
) -> rusqlite::Result<Option<LookupRecord>> {
    if let Some(cfi) = cfi.filter(|value| !value.is_empty()) {
        let record = conn
            .query_row(
                &format!("SELECT {SELECT_COLS} FROM lookup_records WHERE book_id = ?1 AND cfi = ?2 AND normalized_text = ?3 AND result_json IS NOT NULL LIMIT 1"),
                params![book_id, cfi, normalized_text],
                row_to_lookup,
            )
            .optional()?;
        if record.is_some() {
            return Ok(record);
        }
    }
    let Some(context) = context_sentence.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM lookup_records WHERE book_id = ?1 AND normalized_text = ?2 AND context_sentence = ?3 AND result_json IS NOT NULL ORDER BY last_looked_up_at DESC LIMIT 1"),
        params![book_id, normalized_text, context],
        row_to_lookup,
    )
    .optional()
}

#[tauri::command]
pub fn get_cached_lookup(
    book_id: String,
    lookup_text: String,
    cfi: Option<String>,
    context_sentence: Option<String>,
    db: State<'_, Db>,
) -> AppResult<Option<LookupRecord>> {
    let normalized_text = normalize(&lookup_text);
    if normalized_text.is_empty() {
        return Ok(None);
    }
    let conn = db.reader();
    Ok(find_cached_lookup(
        &conn,
        &book_id,
        &normalized_text,
        cfi.as_deref(),
        context_sentence.as_deref(),
    )?)
}

#[tauri::command]
pub fn list_lookup_records(book_id: String, db: State<'_, Db>) -> AppResult<Vec<LookupRecord>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM lookup_records WHERE book_id = ?1 ORDER BY last_looked_up_at DESC"
    ))?;
    let records = stmt
        .query_map(params![book_id], row_to_lookup)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(records)
}

pub(crate) fn query_all_lookup_records(
    search: Option<String>,
    book_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    db: &Db,
) -> AppResult<LookupRecordPage> {
    let conn = db.reader();
    let page_size = limit.unwrap_or(50).clamp(1, 200);
    let search = search.unwrap_or_default().trim().to_string();
    let mut conditions = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(book_id) = book_id.filter(|id| !id.is_empty()) {
        conditions.push("l.book_id = ?".to_string());
        values.push(Box::new(book_id));
    }
    if !search.is_empty() {
        conditions.push(r"(LOWER(l.lookup_text) LIKE ? ESCAPE '\' OR LOWER(l.definition) LIKE ? ESCAPE '\' OR LOWER(COALESCE(l.context_sentence, '')) LIKE ? ESCAPE '\' OR LOWER(COALESCE(b.title, '')) LIKE ? ESCAPE '\')".to_string());
        let pattern = crate::db::sqlite_contains_pattern(&search);
        for _ in 0..4 {
            values.push(Box::new(pattern.clone()));
        }
    }
    let base_where = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let total_sql = format!(
        "SELECT COUNT(*) FROM lookup_records l LEFT JOIN books b ON l.book_id = b.id{base_where}"
    );
    let total_refs: Vec<&dyn rusqlite::types::ToSql> =
        values.iter().map(|value| value.as_ref()).collect();
    let total: usize = conn.query_row(&total_sql, total_refs.as_slice(), |row| row.get(0))?;

    let mut facet_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let facet_where = if search.is_empty() {
        String::new()
    } else {
        let pattern = crate::db::sqlite_contains_pattern(&search);
        for _ in 0..4 {
            facet_values.push(Box::new(pattern.clone()));
        }
        r" WHERE (LOWER(l.lookup_text) LIKE ? ESCAPE '\' OR LOWER(l.definition) LIKE ? ESCAPE '\' OR LOWER(COALESCE(l.context_sentence, '')) LIKE ? ESCAPE '\' OR LOWER(COALESCE(b.title, '')) LIKE ? ESCAPE '\')".to_string()
    };
    let facet_sql = format!(
        "SELECT l.book_id, b.title, COUNT(*) FROM lookup_records l LEFT JOIN books b ON l.book_id = b.id{facet_where} GROUP BY l.book_id, b.title ORDER BY LOWER(COALESCE(b.title, '')), l.book_id"
    );
    let facet_refs: Vec<&dyn rusqlite::types::ToSql> =
        facet_values.iter().map(|value| value.as_ref()).collect();
    let mut facet_statement = conn.prepare(&facet_sql)?;
    let books = facet_statement
        .query_map(facet_refs.as_slice(), |row| {
            Ok(LookupBookFacet {
                book_id: row.get(0)?,
                book_title: row.get(1)?,
                count: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if let Some((timestamp, id)) = cursor.as_deref().and_then(|value| value.split_once(':')) {
        if let Ok(timestamp) = timestamp.parse::<i64>() {
            conditions.push(
                "(l.last_looked_up_at < ? OR (l.last_looked_up_at = ? AND l.id > ?))".to_string(),
            );
            values.push(Box::new(timestamp));
            values.push(Box::new(timestamp));
            values.push(Box::new(id.to_string()));
        }
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT l.id, l.book_id, l.lookup_text, l.normalized_text, l.context_sentence, l.chapter, l.cfi, l.definition, l.context_explanation, l.created_at, l.last_looked_up_at, l.lookup_count, l.result_json, l.provider_profile_id, l.model, COALESCE(l.updated_at, l.last_looked_up_at), b.title FROM lookup_records l LEFT JOIN books b ON l.book_id = b.id{where_clause} ORDER BY l.last_looked_up_at DESC, l.id ASC LIMIT ?"
    );
    values.push(Box::new((page_size + 1) as i64));
    let refs: Vec<&dyn rusqlite::types::ToSql> =
        values.iter().map(|value| value.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let records = stmt
        .query_map(refs.as_slice(), row_to_lookup_with_book)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    let mut records = records;
    let next_cursor = if records.len() > page_size {
        records.truncate(page_size);
        records
            .last()
            .map(|record| format!("{}:{}", record.last_looked_up_at, record.id))
    } else {
        None
    };
    Ok(LookupRecordPage {
        records,
        next_cursor,
        total,
        books,
    })
}

#[tauri::command]
pub fn list_all_lookup_records(
    search: Option<String>,
    book_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    db: State<'_, Db>,
) -> AppResult<LookupRecordPage> {
    query_all_lookup_records(search, book_id, cursor, limit, &db)
}

#[tauri::command]
pub fn delete_lookup_record(id: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute("DELETE FROM lookup_records WHERE id = ?1", params![id])?;
    Ok(())
}

#[tauri::command]
pub fn clear_lookup_records(book_id: Option<String>, db: State<'_, Db>) -> AppResult<usize> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let affected = match book_id.filter(|id| !id.is_empty()) {
        Some(book_id) => conn.execute(
            "DELETE FROM lookup_records WHERE book_id = ?1",
            params![book_id],
        )?,
        None => conn.execute("DELETE FROM lookup_records", [])?,
    };
    Ok(affected)
}

#[tauri::command]
pub fn prune_lookup_records(retention_days: Option<i64>, db: State<'_, Db>) -> AppResult<usize> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    Ok(prune_lookup_records_conn(
        &conn,
        retention_days.filter(|days| *days > 0),
    )?)
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
        let (count, definition): (i64, String) = conn
            .query_row(
                "SELECT lookup_count, definition FROM lookup_records WHERE id = 'one'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 2);
        assert_eq!(definition, "second");
    }

    fn insert_record(
        conn: &rusqlite::Connection,
        id: &str,
        cfi: Option<&str>,
        context: Option<&str>,
        result_json: Option<&str>,
        looked_up_at: i64,
    ) {
        conn.execute(
            "INSERT INTO lookup_records (id, book_id, lookup_text, normalized_text, context_sentence, cfi, definition, result_json, created_at, last_looked_up_at, lookup_count) VALUES (?1, 'book', 'Wonder', 'wonder', ?2, ?3, 'first', ?4, 1, ?5, 1)",
            params![id, context, cfi, result_json, looked_up_at],
        )
        .unwrap();
    }

    #[test]
    fn cached_lookup_prefers_the_same_position_then_the_same_sentence() {
        let db = setup();
        let conn = db.conn.lock().unwrap();
        insert_record(
            &conn,
            "here",
            Some("epubcfi(/6/2)"),
            Some("A sentence."),
            Some("{\"here\":true}"),
            1,
        );
        insert_record(
            &conn,
            "elsewhere",
            Some("epubcfi(/6/8)"),
            Some("A sentence."),
            Some("{\"elsewhere\":true}"),
            2,
        );

        let at_position =
            find_cached_lookup(&conn, "book", "wonder", Some("epubcfi(/6/2)"), None).unwrap();
        assert_eq!(at_position.unwrap().id, "here");

        let same_sentence = find_cached_lookup(
            &conn,
            "book",
            "wonder",
            Some("epubcfi(/6/4)"),
            Some("A sentence."),
        )
        .unwrap();
        assert_eq!(same_sentence.unwrap().id, "elsewhere");

        let other_sentence = find_cached_lookup(
            &conn,
            "book",
            "wonder",
            Some("epubcfi(/6/4)"),
            Some("Another sentence."),
        )
        .unwrap();
        assert!(other_sentence.is_none());
    }

    #[test]
    fn cached_lookup_ignores_records_without_a_stored_card() {
        let db = setup();
        let conn = db.conn.lock().unwrap();
        insert_record(
            &conn,
            "bare",
            Some("epubcfi(/6/2)"),
            Some("A sentence."),
            None,
            1,
        );
        assert!(find_cached_lookup(
            &conn,
            "book",
            "wonder",
            Some("epubcfi(/6/2)"),
            Some("A sentence."),
        )
        .unwrap()
        .is_none());
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
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM lookup_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }
}
