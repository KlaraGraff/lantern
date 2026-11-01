use rusqlite::{params, OptionalExtension};
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
    let key = format!("{collection_id}:{book_id}");
    // The click is this device's newest intent, so its stamp must outrank any
    // membership stamp already visible here — including a tombstone written by
    // a peer whose clock runs ahead. `next_logical_timestamp` only tracks this
    // writer's own clock, so the peer's stamp is read first and handed to the
    // transaction: `with_tx` derives both the published event's timestamp and
    // the row's `updated_at` from that one value.
    let seen = max_membership_stamp(db, collection_id, book_id)?;
    let now = next_stamp_above(sync, seen);
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        // Clears the tombstone this add supersedes — the same clearable-
        // tombstone rule `apply_collection_book_add` applies, so the row and
        // its tombstone never disagree. Only strictly older ones are cleared;
        // `now` is already past every stamp this device could see.
        tx.execute(
            "DELETE FROM _tombstones WHERE entity = ?1 AND id = ?2 AND ts < ?3",
            params![entity::COLLECTION_BOOK, key, now],
        )?;
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
    let key = format!("{collection_id}:{book_id}");
    // Same rule as the add: a peer that stamped this membership ahead of the
    // local clock must not outrank the remove — peers would keep the row and
    // the next snapshot would bring it back. `now` is read past the row's
    // stamp and `with_tx` writes that one value into both the tombstone and
    // the published event.
    let seen = max_membership_stamp(db, collection_id, book_id)?;
    let now = next_stamp_above(sync, seen);
    sync.with_tx(db, now, |tx, events| {
        let changed = tx.execute(
            "DELETE FROM collection_books WHERE collection_id = ?1 AND book_id = ?2",
            params![collection_id, book_id],
        )?;
        if changed > 0 {
            // Written only together with the published remove. A tombstone
            // with no event would stay on this device alone and suppress a
            // peer's delayed add that every other device applies.
            insert_tombstone(tx, entity::COLLECTION_BOOK, &key, now)?;
            events.push(EventBody::CollectionBookRemove {
                collection: collection_id.to_string(),
                book: book_id.to_string(),
            });
        }
        Ok(changed > 0)
    })
}

/// The newest stamp this device already holds for one membership: the row's
/// `updated_at` and the tombstone's `ts`, whichever is later. `None` when the
/// membership has never been seen here.
fn max_membership_stamp(db: &Db, collection_id: &str, book_id: &str) -> AppResult<Option<i64>> {
    let conn = db.reader();
    Ok(conn
        .query_row(
            "SELECT MAX(m.ts) FROM (
                 SELECT updated_at AS ts FROM collection_books
                  WHERE collection_id = ?1 AND book_id = ?2
                 UNION ALL
                 SELECT ts FROM _tombstones WHERE entity = ?3 AND id = ?4
             ) m",
            params![
                collection_id,
                book_id,
                entity::COLLECTION_BOOK,
                format!("{collection_id}:{book_id}")
            ],
            |row| row.get(0),
        )
        .optional()?
        .flatten())
}

/// The next stamp for a local membership write, raised to `seen + 1` so it
/// outranks a peer stamp already applied here. Only stepping one past what the
/// local database shows — `next_logical_timestamp` keeps it strictly
/// increasing for this writer, and it stays well inside the accepted skew.
fn next_stamp_above(sync: &SyncWriter, seen: Option<i64>) -> i64 {
    match seen {
        Some(ts) => {
            let floor = ts.saturating_add(1);
            floor.max(sync.next_logical_timestamp())
        }
        None => sync.next_logical_timestamp(),
    }
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

    fn membership_tombstone_ts(db: &Db, collection_id: &str, book_id: &str) -> Option<i64> {
        use rusqlite::OptionalExtension;
        db.reader()
            .query_row(
                "SELECT ts FROM _tombstones WHERE entity = ?1 AND id = ?2",
                params![
                    entity::COLLECTION_BOOK,
                    format!("{collection_id}:{book_id}")
                ],
                |row| row.get(0),
            )
            .optional()
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

    #[test]
    fn remove_then_add_locally_leaves_row_and_no_tombstone() {
        let (_dir, db, sync) = setup();
        insert_book(&db, "b1", "Book");
        insert_collection(&db, "c1", "Favorites");

        assert!(do_add_book_to_collection("c1", "b1", &db, &sync).unwrap());
        assert_eq!(membership_count(&db, "c1", "b1"), 1);

        assert!(do_remove_book_from_collection("c1", "b1", &db, &sync).unwrap());
        assert_eq!(membership_count(&db, "c1", "b1"), 0);
        assert!(
            membership_tombstone_ts(&db, "c1", "b1").is_some(),
            "a local remove must leave a tombstone so a late peer add cannot resurrect it"
        );

        assert!(do_add_book_to_collection("c1", "b1", &db, &sync).unwrap());
        assert_eq!(
            membership_count(&db, "c1", "b1"),
            1,
            "re-adding the book locally must put the membership back"
        );
        assert_eq!(
            membership_tombstone_ts(&db, "c1", "b1"),
            None,
            "the local re-add must clear its own tombstone"
        );
    }

    /// The events this writer parked in `_pending_publish`, in log order,
    /// paired with the timestamp peers will order them by. Requires the test
    /// to call `set_should_queue(true)` first.
    fn published_events(db: &Db) -> Vec<(i64, EventBody)> {
        let conn = db.reader();
        let mut stmt = conn
            .prepare("SELECT ts, body_json FROM _pending_publish ORDER BY rowid")
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows.into_iter()
            .map(|(ts, body)| (ts, serde_json::from_str::<EventBody>(&body).unwrap()))
            .collect()
    }

    #[test]
    fn same_millisecond_remove_then_add_converges() {
        let (_dir, db, sync) = setup();
        sync.set_should_queue(true);
        insert_book(&db, "b1", "Book");
        insert_collection(&db, "c1", "Favorites");
        {
            // Seed the membership directly so the only published events are
            // the remove and the re-add of this test.
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO collection_books (collection_id, book_id, created_at, updated_at)
                 VALUES ('c1', 'b1', 1704067200000, 1704067200000)",
                [],
            )
            .unwrap();
        }

        // Two user actions back to back: peers must see distinct, increasing
        // stamps or the older remove outlives the newer add on every peer.
        assert!(do_remove_book_from_collection("c1", "b1", &db, &sync).unwrap());
        assert!(
            do_add_book_to_collection("c1", "b1", &db, &sync).unwrap(),
            "the local re-add is newer than the remove it must beat"
        );

        let events = published_events(&db);
        assert_eq!(
            events.len(),
            2,
            "remove and re-add must each publish, got {events:?}"
        );
        let stamps: Vec<i64> = events.iter().map(|(ts, _)| *ts).collect();
        assert!(
            stamps.windows(2).all(|pair| pair[0] < pair[1]),
            "remove then add must publish strictly increasing timestamps, got {stamps:?}"
        );
        assert!(matches!(
            events[0].1,
            EventBody::CollectionBookRemove { .. }
        ));
        assert!(matches!(events[1].1, EventBody::CollectionBookAdd { .. }));

        assert_eq!(membership_count(&db, "c1", "b1"), 1, "the row must exist");
        assert_eq!(
            membership_tombstone_ts(&db, "c1", "b1"),
            None,
            "the newer add must clear the remove's tombstone"
        );
    }

    #[test]
    fn local_add_after_tombstone_stamped_ahead_inserts_row() {
        let (_dir, db, sync) = setup();
        sync.set_should_queue(true);
        insert_book(&db, "b1", "Book");
        insert_collection(&db, "c1", "Favorites");

        // A peer whose clock runs 60 s ahead removed the book; this device
        // applied that remove, so its tombstone is the newest stamp in sight.
        let peer_remove_ts = sync.next_logical_timestamp() + 60_000;
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO _tombstones (entity, id, ts) VALUES (?1, ?2, ?3)",
                params![entity::COLLECTION_BOOK, "c1:b1", peer_remove_ts],
            )
            .unwrap();
        }

        // The user's click must win over that tombstone, not vanish silently.
        assert!(
            do_add_book_to_collection("c1", "b1", &db, &sync).unwrap(),
            "a local add must win over a tombstone it can see"
        );
        assert_eq!(
            membership_count(&db, "c1", "b1"),
            1,
            "the add must insert the row"
        );
        assert_eq!(
            membership_tombstone_ts(&db, "c1", "b1"),
            None,
            "the add must clear the tombstone it superseded"
        );

        let (add_ts, add_body) = published_events(&db).pop().unwrap();
        assert!(
            add_ts > peer_remove_ts,
            "the published add ({add_ts}) must outrank the peer tombstone ({peer_remove_ts})"
        );

        // Peers holding both the ahead remove and this add keep the row.
        let (_peer_dir, peer, _peer_sync) = setup();
        insert_book(&peer, "b1", "Book");
        insert_collection(&peer, "c1", "Favorites");
        {
            let mut conn = peer.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            for (ts, dev, body) in [
                (
                    peer_remove_ts,
                    "dev-Z",
                    EventBody::CollectionBookRemove {
                        collection: "c1".into(),
                        book: "b1".into(),
                    },
                ),
                (add_ts, "dev-A", add_body),
            ] {
                let event = crate::sync::events::Event {
                    id: "01HYZX00000000000000000003".into(),
                    ts,
                    device: dev.into(),
                    v: crate::sync::events::EVENT_SCHEMA_VERSION,
                    body,
                    extra: serde_json::Map::new(),
                };
                apply_event(&tx, &event).unwrap();
            }
            tx.commit().unwrap();
        }
        assert_eq!(
            membership_count(&peer, "c1", "b1"),
            1,
            "peers must end up with the row this device just added"
        );
    }

    #[test]
    fn local_remove_of_row_stamped_ahead_by_peer_converges() {
        let (_dir, db, sync) = setup();
        sync.set_should_queue(true);
        insert_book(&db, "b1", "Book");
        insert_collection(&db, "c1", "Favorites");
        // Peer dev-Z (clock 60s ahead) added the book; this device applied it.
        let peer_ts = chrono::Utc::now().timestamp_millis() + 60_000;
        {
            let mut conn = db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            let e = crate::sync::events::Event {
                id: "01HYZX00000000000000000001".into(),
                ts: peer_ts,
                device: "dev-Z".into(),
                v: crate::sync::events::EVENT_SCHEMA_VERSION,
                body: EventBody::CollectionBookAdd {
                    collection: "c1".into(),
                    book: "b1".into(),
                },
                extra: serde_json::Map::new(),
            };
            apply_event(&tx, &e).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(membership_count(&db, "c1", "b1"), 1);
        // User removes it here.
        assert!(do_remove_book_from_collection("c1", "b1", &db, &sync).unwrap());
        let local_present = membership_count(&db, "c1", "b1") == 1;
        // What dev-Z does with the published remove:
        let (rts, body) = published_events(&db).pop().unwrap();
        let (_d2, peer, _s2) = setup();
        insert_book(&peer, "b1", "Book");
        insert_collection(&peer, "c1", "Favorites");
        {
            let mut conn = peer.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            for (ts, dev, b) in [
                (
                    peer_ts,
                    "dev-Z",
                    EventBody::CollectionBookAdd {
                        collection: "c1".into(),
                        book: "b1".into(),
                    },
                ),
                (rts, "dev-A", body),
            ] {
                let e = crate::sync::events::Event {
                    id: "01HYZX00000000000000000002".into(),
                    ts,
                    device: dev.into(),
                    v: crate::sync::events::EVENT_SCHEMA_VERSION,
                    body: b,
                    extra: serde_json::Map::new(),
                };
                apply_event(&tx, &e).unwrap();
            }
            tx.commit().unwrap();
        }
        let peer_present = membership_count(&peer, "c1", "b1") == 1;
        assert_eq!(
            local_present, peer_present,
            "local remove (ts {rts}) vs peer row (ts {peer_ts}) diverge"
        );
    }

    #[test]
    fn noop_remove_then_delayed_peer_add_is_applied() {
        let (_dir, db, sync) = setup();
        sync.set_should_queue(true);
        insert_book(&db, "b1", "Book");
        insert_collection(&db, "c1", "Favorites");

        assert!(
            !do_remove_book_from_collection("c1", "b1", &db, &sync).unwrap(),
            "removing a membership this device does not hold must change nothing"
        );
        assert_eq!(
            membership_tombstone_ts(&db, "c1", "b1"),
            None,
            "a remove that deleted no row must not leave a tombstone"
        );
        assert!(
            !published_events(&db)
                .iter()
                .any(|(_, body)| matches!(body, EventBody::CollectionBookRemove { .. })),
            "a remove that deleted no row must not publish a remove"
        );

        // A peer's earlier add of the same membership arrives late. Every
        // other device applies it, so this one must too.
        let peer_ts = chrono::Utc::now().timestamp_millis() - 5_000;
        {
            let mut conn = db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            let e = crate::sync::events::Event {
                id: "01HYZX00000000000000000004".into(),
                ts: peer_ts,
                device: "dev-B".into(),
                v: crate::sync::events::EVENT_SCHEMA_VERSION,
                body: EventBody::CollectionBookAdd {
                    collection: "c1".into(),
                    book: "b1".into(),
                },
                extra: serde_json::Map::new(),
            };
            apply_event(&tx, &e).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            membership_count(&db, "c1", "b1"),
            1,
            "a no-op remove must not suppress a peer's delayed add"
        );
    }

    #[test]
    fn peer_remove_then_readd_respects_event_order() {
        let (_dir, db, _sync) = setup();
        insert_book(&db, "b1", "Book");
        insert_book(&db, "b2", "Book 2");
        insert_collection(&db, "c1", "Favorites");
        insert_collection(&db, "c2", "Later");

        // add@1, remove@2, add@3 — the re-add is the newest event and wins.
        apply(
            &db,
            EventBody::CollectionBookAdd {
                collection: "c1".to_string(),
                book: "b1".to_string(),
            },
            1_000,
        );
        apply(
            &db,
            EventBody::CollectionBookRemove {
                collection: "c1".to_string(),
                book: "b1".to_string(),
            },
            2_000,
        );
        assert_eq!(membership_count(&db, "c1", "b1"), 0);
        apply(
            &db,
            EventBody::CollectionBookAdd {
                collection: "c1".to_string(),
                book: "b1".to_string(),
            },
            3_000,
        );
        assert_eq!(
            membership_count(&db, "c1", "b1"),
            1,
            "a re-add newer than the remove must win"
        );
        assert_eq!(
            membership_tombstone_ts(&db, "c1", "b1"),
            None,
            "the winning re-add must clear the tombstone it superseded"
        );

        // add@1, remove@3, add@2 — the late add is older than the remove.
        apply(
            &db,
            EventBody::CollectionBookAdd {
                collection: "c2".to_string(),
                book: "b2".to_string(),
            },
            1_000,
        );
        apply(
            &db,
            EventBody::CollectionBookRemove {
                collection: "c2".to_string(),
                book: "b2".to_string(),
            },
            3_000,
        );
        apply(
            &db,
            EventBody::CollectionBookAdd {
                collection: "c2".to_string(),
                book: "b2".to_string(),
            },
            2_000,
        );
        assert_eq!(
            membership_count(&db, "c2", "b2"),
            0,
            "an add older than the removal must not resurrect the membership"
        );
        assert_eq!(
            membership_tombstone_ts(&db, "c2", "b2"),
            Some(3_000),
            "the removal's tombstone must survive the outranked add"
        );
    }
}
