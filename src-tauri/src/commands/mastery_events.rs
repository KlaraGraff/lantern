//! Local-only timeline of vocabulary mastery-tier transitions. See migration
//! 038 for the schema and the full list of `reason` codes. This module is
//! deliberately just storage — nothing here decides *when* a transition
//! happens, only how it gets recorded once some other code has decided.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::AppResult;

/// One row of the word-detail timeline. `reason` and `detail` cross the
/// boundary raw: `reason` is a stable code the frontend maps to an i18n
/// string, and `detail` is the JSON blob those strings interpolate from.
/// Rust deliberately does not parse `detail` — see migration 038.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct MasteryEvent {
    pub id: String,
    pub vocab_word_id: String,
    pub from_mastery: String,
    pub to_mastery: String,
    pub source: String,
    pub reason: String,
    pub detail: String,
    pub created_at: i64,
}

/// The timeline for one word, newest first.
///
/// Empty is a normal answer, not an error. `mastery_events` is device-local
/// (migration 038), so a word whose whole history happened on another device
/// legitimately has nothing to show here — which is exactly why the
/// one-sentence explanation lives on `vocab_words.mastery_reason` and syncs,
/// while this does not.
#[tauri::command]
pub fn list_mastery_events(
    db: State<'_, Db>,
    vocab_word_id: String,
) -> AppResult<Vec<MasteryEvent>> {
    list_mastery_events_for(&db, &vocab_word_id)
}

pub(crate) fn list_mastery_events_for(
    db: &Db,
    vocab_word_id: &str,
) -> AppResult<Vec<MasteryEvent>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT id, vocab_word_id, from_mastery, to_mastery, source, reason, detail, created_at
         FROM mastery_events
         WHERE vocab_word_id = ?1
         ORDER BY created_at DESC, rowid DESC",
    )?;
    let events = stmt
        .query_map(params![vocab_word_id], |row| {
            Ok(MasteryEvent {
                id: row.get(0)?,
                vocab_word_id: row.get(1)?,
                from_mastery: row.get(2)?,
                to_mastery: row.get(3)?,
                source: row.get(4)?,
                reason: row.get(5)?,
                detail: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(events)
}

/// Appends one row to `mastery_events`. `detail` is caller-provided JSON
/// text (the numbers `reason` was computed from) — this function does not
/// parse or validate it, only stores it.
///
/// Called today from the manual override paths in `commands::vocab`
/// (`user_override`). The exposure-scoring engine that will record
/// `exposure_promotion` / `lookup_demotion` is still future work.
#[allow(clippy::too_many_arguments)]
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

    /// Newest first, because the word-detail timeline reads top-down from
    /// "what just happened" back to "you first looked it up".
    #[test]
    fn the_timeline_comes_back_newest_first() {
        let (_dir, db) = setup();
        {
            let conn = db.conn.lock().unwrap();
            insert_book(&conn, "b1");
            insert_vocab_word(&conn, "v1", "b1");
            for (n, (from, to, reason)) in [
                ("new", "learning", "user_override"),
                ("learning", "familiar", "exposure_promotion"),
                ("familiar", "learning", "lookup_demotion"),
            ]
            .into_iter()
            .enumerate()
            {
                record_mastery_event(
                    &conn,
                    "v1",
                    from,
                    to,
                    "auto",
                    reason,
                    "{}",
                    1_700_000_000_000 + n as i64 * 1_000,
                )
                .unwrap();
            }
        }

        let events = list_mastery_events_for(&db, "v1").unwrap();
        let reasons: Vec<&str> = events.iter().map(|e| e.reason.as_str()).collect();
        assert_eq!(
            reasons,
            vec!["lookup_demotion", "exposure_promotion", "user_override"]
        );
    }

    /// A word whose whole history happened on another device has an empty
    /// timeline — `mastery_events` does not sync. That is a normal answer,
    /// not a failure, and it is why the one-sentence explanation lives on the
    /// synced `vocab_words.mastery_reason` instead of being derived from here.
    #[test]
    fn a_word_with_no_recorded_transitions_has_an_empty_timeline() {
        let (_dir, db) = setup();
        {
            let conn = db.conn.lock().unwrap();
            insert_book(&conn, "b1");
            insert_vocab_word(&conn, "v1", "b1");
        }
        assert!(list_mastery_events_for(&db, "v1").unwrap().is_empty());
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
