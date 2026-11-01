use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::AppResult;
use crate::sync::events::EventBody;
use crate::sync::merge::{entity, insert_tombstone};
use crate::sync::writer::SyncWriter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub book_count: i32,
    pub sort_order: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

pub(crate) fn query_collections(db: &Db) -> AppResult<Vec<Collection>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.created_at, c.updated_at, c.sort_order, COUNT(cb.book_id) as book_count
         FROM collections c
         LEFT JOIN collection_books cb ON c.id = cb.collection_id
         GROUP BY c.id
         ORDER BY c.sort_order, c.created_at",
    )?;
    let collections = stmt
        .query_map([], |row| {
            Ok(Collection {
                id: row.get("id")?,
                name: row.get("name")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
                sort_order: row.get("sort_order")?,
                book_count: row.get("book_count")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(collections)
}

pub(crate) fn query_collection_exists(db: &Db, id: &str) -> AppResult<bool> {
    let conn = db.reader();
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?1)",
        params![id],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

#[tauri::command]
pub fn list_collections(db: State<'_, Db>) -> AppResult<Vec<Collection>> {
    query_collections(&db)
}

pub(crate) fn do_create_collection(
    name: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Collection> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();

    sync.with_tx(db, now, |tx, events| {
        let max_order: i32 = tx
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM collections",
                [],
                |r| r.get(0),
            )
            .unwrap_or(-1);
        let sort_order = max_order + 1;
        tx.execute(
            "INSERT INTO collections (id, name, sort_order, created_at, updated_at, updated_by_device) VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            params![id, name, sort_order, now, device],
        )?;
        events.push(EventBody::CollectionCreate {
            id: id.clone(),
            name: name.to_string(),
            sort_order,
        });
        Ok(Collection {
            id: id.clone(),
            name: name.to_string(),
            book_count: 0,
            sort_order,
            created_at: now,
            updated_at: now,
        })
    })
}

#[tauri::command]
pub fn create_collection(
    name: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Collection> {
    do_create_collection(&name, &db, &sync)
}

pub(crate) fn do_rename_collection(
    id: &str,
    name: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        tx.execute(
            "UPDATE collections SET name = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
            params![name, now, device, id],
        )?;
        events.push(EventBody::CollectionRename {
            id: id.to_string(),
            name: name.to_string(),
        });
        Ok(())
    })
}

#[tauri::command]
pub fn rename_collection(
    id: String,
    name: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_rename_collection(&id, &name, &db, &sync)
}

pub(crate) fn do_delete_collection(id: &str, db: &Db, sync: &SyncWriter) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    sync.with_tx(db, now, |tx, events| {
        // Mirror `sync::merge::apply_collection_delete`: tombstone each join
        // row so a delayed `collection.book.add` for the same pair stays
        // suppressed, then the collection itself so a delayed
        // `collection.create` cannot resurrect it on this device.
        let book_ids: Vec<String> = {
            let mut statement =
                tx.prepare("SELECT book_id FROM collection_books WHERE collection_id = ?1")?;
            let collected = statement
                .query_map(params![id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<String>, _>>()?;
            collected
        };
        for book_id in book_ids {
            insert_tombstone(tx, entity::COLLECTION_BOOK, &format!("{id}:{book_id}"), now)?;
        }
        tx.execute(
            "DELETE FROM collection_books WHERE collection_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
        insert_tombstone(tx, entity::COLLECTION, id, now)?;
        events.push(EventBody::CollectionDelete { id: id.to_string() });
        Ok(())
    })
}

#[tauri::command]
pub fn delete_collection(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_delete_collection(&id, &db, &sync)
}

#[tauri::command]
pub fn reorder_collections(
    ids: Vec<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    // Monotonic, like every other field-clock write: two reorders in one
    // millisecond must not tie on peers.
    let now = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();
    sync.with_tx(&db, now, |tx, events| {
        for (i, id) in ids.iter().enumerate() {
            let sort_order = i as i32;
            tx.execute(
                "UPDATE collections SET sort_order = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                params![sort_order, now, device, id],
            )?;
            events.push(EventBody::CollectionReorder {
                id: id.clone(),
                sort_order,
            });
        }
        Ok(())
    })
}

pub(crate) fn do_add_book_to_collection(
    collection_id: &str,
    book_id: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<bool> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        let changed = tx.execute(
            "INSERT OR IGNORE INTO collection_books (collection_id, book_id, created_at, updated_at, updated_by_device) VALUES (?1, ?2, ?3, ?3, ?4)",
            params![collection_id, book_id, now, device],
        )?;
        if changed > 0 {
            events.push(EventBody::CollectionBookAdd {
                collection: collection_id.to_string(),
                book: book_id.to_string(),
            });
        }
        Ok(changed > 0)
    })
}

#[tauri::command]
pub fn add_book_to_collection(
    collection_id: String,
    book_id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_add_book_to_collection(&collection_id, &book_id, &db, &sync)?;
    Ok(())
}

pub(crate) fn do_remove_book_from_collection(
    collection_id: &str,
    book_id: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<bool> {
    let now = chrono::Utc::now().timestamp_millis();
    sync.with_tx(db, now, |tx, events| {
        let changed = tx.execute(
            "DELETE FROM collection_books WHERE collection_id = ?1 AND book_id = ?2",
            params![collection_id, book_id],
        )?;
        if changed > 0 {
            events.push(EventBody::CollectionBookRemove {
                collection: collection_id.to_string(),
                book: book_id.to_string(),
            });
        }
        Ok(changed > 0)
    })
}

#[tauri::command]
pub fn remove_book_from_collection(
    collection_id: String,
    book_id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_remove_book_from_collection(&collection_id, &book_id, &db, &sync)?;
    Ok(())
}

#[tauri::command]
pub fn list_books_in_collection(
    collection_id: String,
    db: State<'_, Db>,
) -> AppResult<Vec<String>> {
    let conn = db.reader();
    let mut stmt = conn.prepare("SELECT book_id FROM collection_books WHERE collection_id = ?1")?;
    let book_ids = stmt
        .query_map(params![collection_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(book_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::events::Event;
    use crate::sync::merge::apply_event;
    use rusqlite::params;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db, SyncWriter) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let sync = SyncWriter::new("dev-A".to_string());
        (dir, db, sync)
    }

    fn insert_book(db: &Db, id: &str, title: &str) {
        let conn = db.conn.lock().unwrap();
        let now: i64 = 1_704_067_200_000;
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES (?1, ?2, 'Author', 'books/test.epub', 'reading', 0, ?3, ?3)",
            params![id, title, now],
        )
        .unwrap();
    }

    fn insert_collection(db: &Db, id: &str, name: &str) {
        let conn = db.conn.lock().unwrap();
        let now: i64 = 1_704_067_200_000;
        conn.execute(
            "INSERT INTO collections (id, name, sort_order, created_at, updated_at)
             VALUES (?1, ?2, 0, ?3, ?3)",
            params![id, name, now],
        )
        .unwrap();
    }

    fn event(ts: i64, body: EventBody) -> Event {
        Event {
            id: format!("01HYZX0000000000000000{ts:04X}"),
            ts,
            device: "dev-B".to_string(),
            v: crate::sync::events::EVENT_SCHEMA_VERSION,
            body,
            extra: serde_json::Map::new(),
        }
    }

    fn apply(db: &Db, body: EventBody, ts: i64) {
        let mut conn = db.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        apply_event(&tx, &event(ts, body)).unwrap();
        tx.commit().unwrap();
    }

    fn collection_count(db: &Db, id: &str) -> i64 {
        db.reader()
            .query_row(
                "SELECT COUNT(*) FROM collections WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn membership_count(db: &Db, collection_id: &str, book_id: &str) -> i64 {
        db.reader()
            .query_row(
                "SELECT COUNT(*) FROM collection_books WHERE collection_id = ?1 AND book_id = ?2",
                params![collection_id, book_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn delete_collection_tombstones_collection_and_memberships() {
        let (_dir, db, sync) = setup();
        insert_book(&db, "b1", "Book");
        insert_collection(&db, "c1", "Favorites");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO collection_books (collection_id, book_id, created_at, updated_at)
                 VALUES ('c1', 'b1', 1704067200000, 1704067200000)",
                [],
            )
            .unwrap();
        }

        do_delete_collection("c1", &db, &sync).unwrap();
        assert_eq!(collection_count(&db, "c1"), 0);
        assert_eq!(membership_count(&db, "c1", "b1"), 0);

        // A peer publishes the create/add before the delete; they arrive late.
        apply(
            &db,
            EventBody::CollectionCreate {
                id: "c1".to_string(),
                name: "Favorites".to_string(),
                sort_order: 0,
            },
            1_000,
        );
        apply(
            &db,
            EventBody::CollectionBookAdd {
                collection: "c1".to_string(),
                book: "b1".to_string(),
            },
            1_100,
        );

        assert_eq!(
            collection_count(&db, "c1"),
            0,
            "deleted collection must stay deleted after a late peer create"
        );
        assert_eq!(
            membership_count(&db, "c1", "b1"),
            0,
            "deleted collection's membership must stay deleted"
        );
    }
}
