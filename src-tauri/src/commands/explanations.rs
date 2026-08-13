//! Persisted AI passage explanations.
//!
//! Every `ai_explain` result is written here the moment it finishes
//! streaming — `saved = 0`, a cache row the reader never sees directly.
//! Re-selecting the same passage replays it for zero API cost. The footer
//! "save" action flips `saved` to 1; only those rows appear in
//! `list_explanations`. See `docs/impls/q257-persist-explanations.md`.
//!
//! Sibling table to `lookup_history.rs` — same shape, same non-sync
//! decision (not in `sync::events::EventBody`, see that plan's O-4).

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Explanation {
    pub id: String,
    pub book_id: String,
    pub passage: String,
    pub normalized_passage: String,
    pub explanation: String,
    pub context_sentence: Option<String>,
    pub chapter: Option<String>,
    pub cfi: String,
    pub variant: String,
    pub provider_profile_id: Option<String>,
    pub model: Option<String>,
    pub saved: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_title: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ExplanationPage {
    pub items: Vec<Explanation>,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub books: Vec<ExplanationBookFacet>,
}

#[derive(Debug, Serialize)]
pub struct ExplanationBookFacet {
    pub book_id: String,
    pub book_title: Option<String>,
    pub count: usize,
}

const SELECT_COLS: &str = "id, book_id, passage, normalized_passage, explanation, context_sentence, chapter, cfi, variant, provider_profile_id, model, saved, created_at, updated_at";

fn row_to_explanation(row: &rusqlite::Row) -> rusqlite::Result<Explanation> {
    Ok(Explanation {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        passage: row.get("passage")?,
        normalized_passage: row.get("normalized_passage")?,
        explanation: row.get("explanation")?,
        context_sentence: row.get("context_sentence")?,
        chapter: row.get("chapter")?,
        cfi: row.get("cfi")?,
        variant: row.get("variant")?,
        provider_profile_id: row.get("provider_profile_id")?,
        model: row.get("model")?,
        saved: row.get("saved")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        book_title: None,
    })
}

/// Reads an `explanations e LEFT JOIN books b` row. `b.title` has no
/// same-named column on the `explanations` side, but the query still aliases
/// it `AS book_title` so the mapper's lookup key matches the struct field
/// name rather than relying on `b`'s bare column name.
fn row_to_explanation_with_book(row: &rusqlite::Row) -> rusqlite::Result<Explanation> {
    Ok(Explanation {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        passage: row.get("passage")?,
        normalized_passage: row.get("normalized_passage")?,
        explanation: row.get("explanation")?,
        context_sentence: row.get("context_sentence")?,
        chapter: row.get("chapter")?,
        cfi: row.get("cfi")?,
        variant: row.get("variant")?,
        provider_profile_id: row.get("provider_profile_id")?,
        model: row.get("model")?,
        saved: row.get("saved")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        book_title: row.get("book_title")?,
    })
}

/// Passage-level normalization for the cache key. Deliberately **not**
/// `lookup_history::normalize` — that function is for single words (it only
/// trims non-alphanumeric edges) and neither collapses internal whitespace
/// nor strips soft hyphens, both of which EPUB text routinely carries.
///
/// Order matters: strip the zero-width/control characters first, *then*
/// collapse whitespace, so a soft hyphen sitting between two words doesn't
/// leave a phantom run of whitespace behind.
///
/// Deliberately does not NFC-normalize (no new dependency, and a selection
/// born from one DOM won't vary in composition between two selections of the
/// same text) and does not hash (the normalized string goes straight into
/// the index — passages are short enough that a B-tree doesn't care).
pub(crate) fn normalize_passage(text: &str) -> String {
    let stripped: String = text
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '\u{00AD}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}'
            )
        })
        .collect();
    // `char::is_whitespace` (which `split_whitespace` uses) already covers
    // '\n', '\t', NBSP (U+00A0), and the full-width space (U+3000) — all are
    // Unicode `White_Space`. `split_whitespace` also trims the ends, so this
    // one call does steps 2 and 3 from the plan together.
    stripped
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The prompt fingerprint: `explanation_mode` and `cefr_level`, read fresh
/// from settings on every call. Mirrors the defaulting in
/// `commands::ai::explain::ai_explain` (adaptive_bilingual / B1) so the
/// cache key lines up with what that command would actually send — but is
/// intentionally its own small copy rather than reaching into `commands::ai`
/// (whose normalizer is `pub(super)`), since a cache-key fingerprint and a
/// prompt builder are allowed to drift independently without either one
/// having to ask the other's permission.
fn current_variant(conn: &rusqlite::Connection) -> String {
    let get = |key: &str| -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
    };
    let mode = match get("explanation_mode").as_deref().map(str::trim) {
        Some("english_by_level") => "english_by_level",
        Some("chinese") => "chinese",
        _ => "adaptive_bilingual",
    };
    let cefr = get("cefr_level").unwrap_or_else(|| "B1".to_string());
    format!("{mode}|{cefr}")
}

fn find_cached_explanation(
    conn: &rusqlite::Connection,
    book_id: &str,
    cfi: &str,
    normalized_passage: &str,
    variant: &str,
) -> rusqlite::Result<Option<Explanation>> {
    conn.query_row(
        &format!(
            "SELECT {SELECT_COLS} FROM explanations WHERE book_id = ?1 AND cfi = ?2 AND normalized_passage = ?3 AND variant = ?4 LIMIT 1"
        ),
        params![book_id, cfi, normalized_passage, variant],
        row_to_explanation,
    )
    .optional()
}

fn get_cached_explanation_inner(
    book_id: &str,
    cfi: Option<&str>,
    passage: &str,
    db: &Db,
) -> AppResult<Option<Explanation>> {
    let normalized_passage = normalize_passage(passage);
    if normalized_passage.is_empty() {
        return Ok(None);
    }
    let conn = db.reader();
    let variant = current_variant(&conn);
    let cfi = cfi.unwrap_or_default();
    Ok(find_cached_explanation(
        &conn,
        book_id,
        cfi,
        &normalized_passage,
        &variant,
    )?)
}

#[tauri::command]
pub fn get_cached_explanation(
    book_id: String,
    cfi: Option<String>,
    passage: String,
    db: State<'_, Db>,
) -> AppResult<Option<Explanation>> {
    get_cached_explanation_inner(&book_id, cfi.as_deref(), &passage, &db)
}

/// Everything one explanation records about itself, short of the variant
/// (computed separately — see `current_variant` — so tests can supply one
/// directly instead of juggling the `settings` table).
pub struct SaveExplanationInput {
    pub book_id: String,
    pub passage: String,
    pub explanation: String,
    pub context_sentence: Option<String>,
    pub chapter: Option<String>,
    pub cfi: Option<String>,
    pub provider_profile_id: Option<String>,
    pub model: Option<String>,
}

fn prune_one_book(
    conn: &rusqlite::Connection,
    book_id: &str,
    keep_per_book: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM explanations
         WHERE book_id = ?1 AND saved = 0 AND id NOT IN (
             SELECT id FROM explanations WHERE book_id = ?1 AND saved = 0
             ORDER BY updated_at DESC LIMIT ?2
         )",
        params![book_id, keep_per_book],
    )
}

/// Delete cache rows (`saved = 0`) beyond the most recent `keep_per_book` per
/// book. `saved = 1` rows are never touched — they're the reader's data, not
/// the cache. Scoped to one book when given, otherwise sweeps every book
/// that currently has unsaved rows.
fn prune_explanation_cache_conn(
    conn: &rusqlite::Connection,
    book_id: Option<&str>,
    keep_per_book: i64,
) -> rusqlite::Result<usize> {
    match book_id {
        Some(book_id) => prune_one_book(conn, book_id, keep_per_book),
        None => {
            let mut stmt =
                conn.prepare("SELECT DISTINCT book_id FROM explanations WHERE saved = 0")?;
            let book_ids: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<_, _>>()?;
            drop(stmt);
            let mut total = 0usize;
            for book_id in book_ids {
                total += prune_one_book(conn, &book_id, keep_per_book)?;
            }
            Ok(total)
        }
    }
}

const DEFAULT_KEEP_PER_BOOK: i64 = 50;

/// Insert or refresh one explanation. `ON CONFLICT` on the `(book_id, cfi,
/// normalized_passage, variant)` key updates `explanation` and `updated_at`
/// only — `saved` is never in that SET list, so re-explaining a passage the
/// reader already saved can't silently un-save it. Runs the same-book prune
/// in the same transaction: the cache's size limit is maintained by the
/// write that grows it, not a background sweep.
fn save_explanation_inner(
    input: SaveExplanationInput,
    variant: &str,
    db: &Db,
) -> AppResult<Explanation> {
    let SaveExplanationInput {
        book_id,
        passage,
        explanation,
        context_sentence,
        chapter,
        cfi,
        provider_profile_id,
        model,
    } = input;
    let normalized_passage = normalize_passage(&passage);
    let cfi = cfi.unwrap_or_default();
    let now = chrono::Utc::now().timestamp_millis();
    let id = uuid::Uuid::new_v4().to_string();

    let mut conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO explanations (id, book_id, passage, normalized_passage, explanation, context_sentence, chapter, cfi, variant, provider_profile_id, model, saved, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?12)
         ON CONFLICT(book_id, cfi, normalized_passage, variant)
         DO UPDATE SET explanation = excluded.explanation, updated_at = excluded.updated_at",
        params![
            id,
            book_id,
            passage,
            normalized_passage,
            explanation,
            context_sentence,
            chapter,
            cfi,
            variant,
            provider_profile_id,
            model,
            now
        ],
    )?;
    let saved_row = tx.query_row(
        &format!(
            "SELECT {SELECT_COLS} FROM explanations WHERE book_id = ?1 AND cfi = ?2 AND normalized_passage = ?3 AND variant = ?4"
        ),
        params![book_id, cfi, normalized_passage, variant],
        row_to_explanation,
    )?;
    prune_explanation_cache_conn(&tx, Some(&book_id), DEFAULT_KEEP_PER_BOOK)?;
    tx.commit()?;
    Ok(saved_row)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn save_explanation(
    book_id: String,
    passage: String,
    explanation: String,
    context_sentence: Option<String>,
    chapter: Option<String>,
    cfi: Option<String>,
    provider_profile_id: Option<String>,
    model: Option<String>,
    db: State<'_, Db>,
) -> AppResult<Explanation> {
    let variant = current_variant(&db.reader());
    save_explanation_inner(
        SaveExplanationInput {
            book_id,
            passage,
            explanation,
            context_sentence,
            chapter,
            cfi,
            provider_profile_id,
            model,
        },
        &variant,
        &db,
    )
}

#[tauri::command]
pub fn set_explanation_saved(id: String, saved: bool, db: State<'_, Db>) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    conn.execute(
        "UPDATE explanations SET saved = ?1, updated_at = ?2 WHERE id = ?3",
        params![saved, now, id],
    )?;
    Ok(())
}

/// v1 "delete" is "move out of the list" (`saved = 0`), not a row delete —
/// see O-6 in the plan. The reader clearing a saved explanation shouldn't
/// also evict the free cache hit; a real delete only happens via
/// `prune_explanation_cache` or a book delete.
#[tauri::command]
pub fn delete_explanation(id: String, db: State<'_, Db>) -> AppResult<()> {
    set_explanation_saved(id, false, db)
}

pub(crate) fn query_all_explanations(
    search: Option<String>,
    book_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    db: &Db,
) -> AppResult<ExplanationPage> {
    let conn = db.reader();
    let page_size = limit.unwrap_or(50).clamp(1, 200);
    let search = search.unwrap_or_default().trim().to_string();
    let mut conditions = vec!["e.saved = 1".to_string()];
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(book_id) = book_id.filter(|id| !id.is_empty()) {
        conditions.push("e.book_id = ?".to_string());
        values.push(Box::new(book_id));
    }
    if !search.is_empty() {
        conditions.push(
            r"(LOWER(e.passage) LIKE ? ESCAPE '\' OR LOWER(e.explanation) LIKE ? ESCAPE '\')"
                .to_string(),
        );
        let pattern = crate::db::sqlite_contains_pattern(&search);
        for _ in 0..2 {
            values.push(Box::new(pattern.clone()));
        }
    }
    let base_where = format!(" WHERE {}", conditions.join(" AND "));
    let total_sql = format!(
        "SELECT COUNT(*) FROM explanations e LEFT JOIN books b ON e.book_id = b.id{base_where}"
    );
    let total_refs: Vec<&dyn rusqlite::types::ToSql> =
        values.iter().map(|value| value.as_ref()).collect();
    let total: usize = conn.query_row(&total_sql, total_refs.as_slice(), |row| row.get(0))?;

    let mut facet_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut facet_conditions = vec!["e.saved = 1".to_string()];
    if !search.is_empty() {
        let pattern = crate::db::sqlite_contains_pattern(&search);
        for _ in 0..2 {
            facet_values.push(Box::new(pattern.clone()));
        }
        facet_conditions.push(
            r"(LOWER(e.passage) LIKE ? ESCAPE '\' OR LOWER(e.explanation) LIKE ? ESCAPE '\')"
                .to_string(),
        );
    }
    let facet_where = format!(" WHERE {}", facet_conditions.join(" AND "));
    let facet_sql = format!(
        "SELECT e.book_id, b.title, COUNT(*) AS count FROM explanations e LEFT JOIN books b ON e.book_id = b.id{facet_where} GROUP BY e.book_id, b.title ORDER BY LOWER(COALESCE(b.title, '')), e.book_id"
    );
    let facet_refs: Vec<&dyn rusqlite::types::ToSql> =
        facet_values.iter().map(|value| value.as_ref()).collect();
    let mut facet_statement = conn.prepare(&facet_sql)?;
    let books = facet_statement
        .query_map(facet_refs.as_slice(), |row| {
            Ok(ExplanationBookFacet {
                book_id: row.get("book_id")?,
                book_title: row.get("title")?,
                count: row.get("count")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if let Some((timestamp, id)) = cursor.as_deref().and_then(|value| value.split_once(':')) {
        if let Ok(timestamp) = timestamp.parse::<i64>() {
            conditions.push("(e.updated_at < ? OR (e.updated_at = ? AND e.id > ?))".to_string());
            values.push(Box::new(timestamp));
            values.push(Box::new(timestamp));
            values.push(Box::new(id.to_string()));
        }
    }
    let where_clause = format!(" WHERE {}", conditions.join(" AND "));
    let sql = format!(
        "SELECT e.id, e.book_id, e.passage, e.normalized_passage, e.explanation, e.context_sentence, e.chapter, e.cfi, e.variant, e.provider_profile_id, e.model, e.saved, e.created_at, e.updated_at, b.title AS book_title FROM explanations e LEFT JOIN books b ON e.book_id = b.id{where_clause} ORDER BY e.updated_at DESC, e.id ASC LIMIT ?"
    );
    values.push(Box::new((page_size + 1) as i64));
    let refs: Vec<&dyn rusqlite::types::ToSql> =
        values.iter().map(|value| value.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let mut items = stmt
        .query_map(refs.as_slice(), row_to_explanation_with_book)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    let next_cursor = if items.len() > page_size {
        items.truncate(page_size);
        items
            .last()
            .map(|item| format!("{}:{}", item.updated_at, item.id))
    } else {
        None
    };
    Ok(ExplanationPage {
        items,
        next_cursor,
        total,
        books,
    })
}

#[tauri::command]
pub fn list_explanations(
    search: Option<String>,
    book_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    db: State<'_, Db>,
) -> AppResult<ExplanationPage> {
    query_all_explanations(search, book_id, cursor, limit, &db)
}

#[tauri::command]
pub fn prune_explanation_cache(
    book_id: Option<String>,
    keep_per_book: Option<i64>,
    db: State<'_, Db>,
) -> AppResult<usize> {
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let keep = keep_per_book.unwrap_or(DEFAULT_KEEP_PER_BOOK).max(0);
    Ok(prune_explanation_cache_conn(
        &conn,
        book_id.as_deref(),
        keep,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::events::{Event, EventBody, EVENT_SCHEMA_VERSION};
    use crate::sync::merge::apply_event;

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

    fn input(passage: &str, explanation: &str, cfi: Option<&str>) -> SaveExplanationInput {
        SaveExplanationInput {
            book_id: "book".to_string(),
            passage: passage.to_string(),
            explanation: explanation.to_string(),
            context_sentence: None,
            chapter: None,
            cfi: cfi.map(str::to_string),
            provider_profile_id: None,
            model: None,
        }
    }

    // 1. normalize_passage folds newline/tab/NBSP/full-width space to a
    //    single half-width space.
    #[test]
    fn normalize_passage_collapses_all_whitespace_variants() {
        let text = "one\ntwo\tthree\u{00A0}four\u{3000}five";
        assert_eq!(normalize_passage(text), "one two three four five");
    }

    // 2. normalize_passage strips soft hyphens and zero-width characters;
    //    "soft\u{00AD}hyphen" normalizes equal to "softhyphen".
    #[test]
    fn normalize_passage_strips_soft_hyphen_and_zero_width_chars() {
        assert_eq!(
            normalize_passage("soft\u{00AD}hyphen"),
            normalize_passage("softhyphen")
        );
        assert_eq!(
            normalize_passage("zero\u{200B}\u{200C}\u{200D}\u{FEFF}width"),
            "zerowidth"
        );
    }

    // 3. Case and leading/trailing whitespace differences normalize equal.
    #[test]
    fn normalize_passage_ignores_case_and_surrounding_whitespace() {
        assert_eq!(
            normalize_passage("  A Sentence.  "),
            normalize_passage("a sentence.")
        );
    }

    // 4. An all-whitespace selection normalizes to an empty string;
    //    get_cached_explanation returns None and writes nothing.
    #[test]
    fn all_whitespace_passage_is_empty_and_never_cached() {
        assert_eq!(normalize_passage("   \n\t\u{00A0}  "), "");

        let db = setup();
        let result = get_cached_explanation_inner("book", None, "   \n\t  ", &db).unwrap();
        assert!(result.is_none());

        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM explanations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "an all-whitespace selection must not write a row");
    }

    // 5. Writing the same (book, cfi, passage) twice leaves one row, with
    //    the explanation overwritten by the later write.
    #[test]
    fn same_key_write_twice_overwrites_in_place() {
        let db = setup();
        let variant = "adaptive_bilingual|B1";
        let first = save_explanation_inner(
            input("A passage.", "first take", Some("cfi1")),
            variant,
            &db,
        )
        .unwrap();
        let second = save_explanation_inner(
            input("A passage.", "second take", Some("cfi1")),
            variant,
            &db,
        )
        .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.explanation, "second take");

        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM explanations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    // 6. A saved (`saved = 1`) row rewritten by save_explanation keeps
    //    `saved = 1` — re-explaining can't un-save.
    #[test]
    fn rewriting_a_saved_row_keeps_it_saved() {
        let db = setup();
        let variant = "adaptive_bilingual|B1";
        let row = save_explanation_inner(
            input("A passage.", "first take", Some("cfi1")),
            variant,
            &db,
        )
        .unwrap();
        set_explanation_saved_conn(&db, &row.id, true);

        let updated = save_explanation_inner(
            input("A passage.", "revised take", Some("cfi1")),
            variant,
            &db,
        )
        .unwrap();
        assert_eq!(updated.id, row.id);
        assert!(updated.saved);
        assert_eq!(updated.explanation, "revised take");
    }

    fn set_explanation_saved_conn(db: &Db, id: &str, saved: bool) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE explanations SET saved = ?1 WHERE id = ?2",
                params![saved, id],
            )
            .unwrap();
    }

    // 7. cfi passed as None and cfi passed as Some("") land on the same row.
    #[test]
    fn missing_cfi_and_empty_cfi_are_the_same_row() {
        let db = setup();
        let variant = "adaptive_bilingual|B1";
        let first =
            save_explanation_inner(input("A passage.", "first take", None), variant, &db).unwrap();
        let second =
            save_explanation_inner(input("A passage.", "second take", Some("")), variant, &db)
                .unwrap();
        assert_eq!(first.id, second.id);

        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM explanations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    // 8. Different variants produce two rows that never hit each other's
    //    cache entry.
    #[test]
    fn different_variants_produce_independent_rows() {
        let db = setup();
        let b1 = save_explanation_inner(
            input("A passage.", "B1 take", Some("cfi1")),
            "adaptive_bilingual|B1",
            &db,
        )
        .unwrap();
        let c1 = save_explanation_inner(
            input("A passage.", "C1 take", Some("cfi1")),
            "adaptive_bilingual|C1",
            &db,
        )
        .unwrap();
        assert_ne!(b1.id, c1.id);

        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM explanations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);

        let conn = db.reader();
        let normalized = normalize_passage("A passage.");
        let hit_b1 =
            find_cached_explanation(&conn, "book", "cfi1", &normalized, "adaptive_bilingual|B1")
                .unwrap();
        assert_eq!(hit_b1.unwrap().id, b1.id);
        let miss =
            find_cached_explanation(&conn, "book", "cfi1", &normalized, "adaptive_bilingual|C2")
                .unwrap();
        assert!(miss.is_none());
    }

    // 9. list_explanations never returns saved = 0 rows.
    #[test]
    fn list_explanations_excludes_unsaved_rows() {
        let db = setup();
        let row = save_explanation_inner(
            input("A passage.", "explanation text", Some("cfi1")),
            "adaptive_bilingual|B1",
            &db,
        )
        .unwrap();
        assert!(!row.saved);

        let page = query_all_explanations(None, None, None, None, &db).unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);

        set_explanation_saved_conn(&db, &row.id, true);
        let page = query_all_explanations(None, None, None, None, &db).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, row.id);
    }

    // 10. list_explanations's search matches the explanation body, not just
    //     the passage.
    #[test]
    fn list_explanations_search_matches_explanation_body() {
        let db = setup();
        let row = save_explanation_inner(
            input(
                "A tricky passage.",
                "unusual metaphor about lighthouses",
                Some("cfi1"),
            ),
            "adaptive_bilingual|B1",
            &db,
        )
        .unwrap();
        set_explanation_saved_conn(&db, &row.id, true);

        let hit =
            query_all_explanations(Some("lighthouses".to_string()), None, None, None, &db).unwrap();
        assert_eq!(hit.items.len(), 1);
        assert_eq!(hit.items[0].id, row.id);

        let miss =
            query_all_explanations(Some("nonexistent-term".to_string()), None, None, None, &db)
                .unwrap();
        assert!(miss.items.is_empty());
    }

    // 11. set_explanation_saved(id, false) leaves the row in the table but
    //     drops it out of the list.
    #[test]
    fn unsaving_keeps_the_row_but_leaves_the_list() {
        let db = setup();
        let row = save_explanation_inner(
            input("A passage.", "explanation text", Some("cfi1")),
            "adaptive_bilingual|B1",
            &db,
        )
        .unwrap();
        set_explanation_saved_conn(&db, &row.id, true);
        assert_eq!(
            query_all_explanations(None, None, None, None, &db)
                .unwrap()
                .items
                .len(),
            1
        );

        set_explanation_saved_conn(&db, &row.id, false);
        assert!(query_all_explanations(None, None, None, None, &db)
            .unwrap()
            .items
            .is_empty());

        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM explanations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "row must still exist after unsaving");
    }

    // 12. prune_explanation_cache deletes unsaved rows beyond the per-book
    //     limit; not one saved = 1 row is deleted.
    #[test]
    fn prune_deletes_only_excess_unsaved_rows() {
        let db = setup();
        for i in 0..5 {
            save_explanation_inner(
                input(&format!("passage {i}"), "text", Some(&format!("cfi{i}"))),
                "adaptive_bilingual|B1",
                &db,
            )
            .unwrap();
        }
        let saved_row = save_explanation_inner(
            input("saved passage", "text", Some("cfi-saved")),
            "adaptive_bilingual|B1",
            &db,
        )
        .unwrap();
        set_explanation_saved_conn(&db, &saved_row.id, true);

        let deleted = {
            let conn = db.conn.lock().unwrap();
            prune_explanation_cache_conn(&conn, Some("book"), 2).unwrap()
        };
        // 5 unsaved rows, keep 2 -> 3 deleted. The saved row is untouched
        // and doesn't count against the unsaved limit.
        assert_eq!(deleted, 3);

        let remaining_unsaved: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM explanations WHERE saved = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_unsaved, 2);

        let saved_still_there: bool = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM explanations WHERE id = ?1 AND saved = 1)",
                params![saved_row.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(saved_still_there);
    }

    // 13. Deleting a book (via the real sync merge path, which runs with
    //     `PRAGMA foreign_keys = OFF` and relies on this crate's explicit
    //     cascades — see sync::merge) removes all of that book's
    //     explanation rows.
    #[test]
    fn deleting_the_book_removes_its_explanations() {
        let db = setup();
        save_explanation_inner(
            input("A passage.", "text", Some("cfi1")),
            "adaptive_bilingual|B1",
            &db,
        )
        .unwrap();

        // `Event::id` must parse as a ULID (see `sync::validation::validate_event`);
        // this mirrors the `ev()` test helper in `sync::merge`'s own tests.
        let event = Event {
            id: format!("01HYZX0000000000000000{:04X}", 2u16),
            ts: 2,
            device: "dev-A".to_string(),
            v: EVENT_SCHEMA_VERSION,
            body: EventBody::BookDelete {
                id: "book".to_string(),
            },
            extra: serde_json::Map::new(),
        };
        {
            let mut conn = db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            apply_event(&tx, &event).unwrap();
            tx.commit().unwrap();
        }

        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM explanations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
