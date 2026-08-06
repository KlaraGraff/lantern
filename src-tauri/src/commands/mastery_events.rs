//! Local-only timeline of vocabulary mastery-tier transitions. See migration
//! 038 for the schema and the full list of `reason` codes. This module is
//! deliberately just storage — nothing here decides *when* a transition
//! happens, only how it gets recorded once some other code has decided.

use rusqlite::{params, Connection};

use crate::error::AppResult;

/// Appends one row to `mastery_events`. `detail` is caller-provided JSON
/// text (the numbers `reason` was computed from) — this function does not
/// parse or validate it, only stores it.
///
/// Not yet called from production code: this batch only lays down the data
/// model (schema + insert helper). The exposure-scoring engine and the SRS
/// review path that will call this are future work.
#[allow(dead_code, clippy::too_many_arguments)]
pub fn record_mastery_event(
    conn: &Connection,
    vocab_word_id: &str,
    from_mastery: &str,
    to_mastery: &str,
    source: &str,
    reason: &str,
    detail: &str,
    now: i64,
) -> AppResult<()> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO mastery_events
         (id, vocab_word_id, from_mastery, to_mastery, source, reason, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            vocab_word_id,
            from_mastery,
            to_mastery,
            source,
            reason,
            detail,
            now,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    fn insert_book(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES (?1, 'Test', 'Author', 'books/test.epub', 'unread', 0, 1700000000000, 1700000000000)",
            params![id],
        )
        .unwrap();
    }

    fn insert_vocab_word(conn: &Connection, id: &str, book_id: &str) {
        conn.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, mastery, created_at, updated_at)
             VALUES (?1, ?2, 'word', 'definition', 'new', 1700000000000, 1700000000000)",
            params![id, book_id],
        )
        .unwrap();
    }

    #[test]
    fn deleting_the_word_cascades_to_its_mastery_events() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        // Db::init leaves `foreign_keys` OFF (the app performs cascades at
        // the application layer, see sync::merge::cascade_delete) — turn it
        // on here so this test actually exercises the DDL-level CASCADE.
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        insert_book(&conn, "b1");
        insert_vocab_word(&conn, "v1", "b1");
        record_mastery_event(
            &conn,
            "v1",
            "new",
            "learning",
            "auto",
            "exposure_promotion",
            "{}",
            1_700_000_100_000,
        )
        .unwrap();

        let count_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM mastery_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_before, 1);

        conn.execute("DELETE FROM vocab_words WHERE id = 'v1'", [])
            .unwrap();

        let count_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM mastery_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_after, 0);
    }

    #[test]
    fn an_unknown_source_is_rejected_by_the_check_constraint() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        insert_book(&conn, "b1");
        insert_vocab_word(&conn, "v1", "b1");

        let result = record_mastery_event(
            &conn,
            "v1",
            "new",
            "learning",
            "not_a_real_source",
            "exposure_promotion",
            "{}",
            1_700_000_100_000,
        );

        assert!(result.is_err());
    }
}
