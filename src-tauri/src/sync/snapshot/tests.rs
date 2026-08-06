use super::apply::upsert_book;
use super::*;
use crate::db::Db;
use crate::error::AppResult;
use crate::sync::events::*;
use crate::sync::log::EventLog;
use crate::sync::merge;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use tempfile::TempDir;

fn open_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    Db::run_migrations_on(&conn).unwrap();
    conn
}

fn ev(ts: i64, device: &str, body: EventBody) -> Event {
    Event {
        id: format!("01HYZX0000000000000000{:04X}", ts as u16),
        ts,
        device: device.to_string(),
        v: EVENT_SCHEMA_VERSION,
        body,
        extra: serde_json::Map::new(),
    }
}

fn import(id: &str) -> EventBody {
    EventBody::BookImport(BookImportPayload {
        id: id.into(),
        title: format!("Book {id}"),
        author: "Author".into(),
        description: None,
        cover_path: None,
        file_path: format!("books/{id}.epub"),
        format: "epub".into(),
        source_format: None,
        render_format: None,
        source_file_path: None,
        source_sha256: None,
        conversion_version: 0,
        genre: None,
        pages: Some(100),
    })
}

fn book_asset(id: &str, book_id: &str) -> BookAssetPayload {
    BookAssetPayload {
        id: id.into(),
        book_id: book_id.into(),
        role: "ocr_pdf".into(),
        format: "pdf".into(),
        relative_path: format!("books/{book_id}.ocr.{id}.pdf"),
        content_sha256: "aa".repeat(32),
        byte_size: 4,
        source_sha256: "bb".repeat(32),
        pipeline: "ocrmypdf".into(),
        pipeline_version: Some("17.8.1".into()),
        language_profile: "chi_sim+eng".into(),
        quality_profile: "fast".into(),
        page_count: 1,
        supersedes_asset_id: None,
        created_at: 1_714_770_000_000,
        updated_at: 1_714_770_000_000,
        updated_by_device: "dev-A".into(),
    }
}

fn apply_to(conn: &mut Connection, events: &[Event]) {
    let tx = conn.transaction().unwrap();
    for e in events {
        merge::apply_event(&tx, e).unwrap();
    }
    tx.commit().unwrap();
}

fn text_book_row(updated_at: i64, source_sha256: &str) -> BookRow {
    BookRow {
        title: "Text book".into(),
        author: "Author".into(),
        description: None,
        cover_path: None,
        file_path: "sources/text-book.txt".into(),
        genre: None,
        pages: Some(1),
        format: "txt".into(),
        source_format: Some("txt".into()),
        render_format: Some("text".into()),
        source_file_path: Some("sources/text-book.txt".into()),
        source_sha256: Some(source_sha256.into()),
        conversion_version: 2,
        status: "reading".into(),
        progress: 0,
        current_cfi: None,
        created_at: 1,
        updated_at,
        updated_by_device: "dev-A".into(),
        cover_data: None,
    }
}

#[test]
fn text_book_snapshot_upsert_preserves_active_preparation_for_same_source() {
    let mut conn = open_db();
    {
        let tx = conn.transaction().unwrap();
        upsert_book(&tx, "text-book", &text_book_row(10, "same-hash")).unwrap();
        tx.commit().unwrap();
    }
    conn.execute(
        "UPDATE books
             SET preparation_state = 'preparing', preparation_error = 'in flight'
             WHERE id = 'text-book'",
        [],
    )
    .unwrap();

    let mut same_source = text_book_row(20, "same-hash");
    same_source.progress = 40;
    {
        let tx = conn.transaction().unwrap();
        upsert_book(&tx, "text-book", &same_source).unwrap();
        tx.commit().unwrap();
    }
    let same_state: (String, Option<String>, i32) = conn
        .query_row(
            "SELECT preparation_state, preparation_error, progress
                 FROM books WHERE id = 'text-book'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        same_state,
        ("preparing".to_string(), Some("in flight".to_string()), 40)
    );

    {
        let tx = conn.transaction().unwrap();
        upsert_book(&tx, "text-book", &text_book_row(30, "new-hash")).unwrap();
        tx.commit().unwrap();
    }
    let changed_state: (String, Option<String>) = conn
        .query_row(
            "SELECT preparation_state, preparation_error
                 FROM books WHERE id = 'text-book'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(changed_state, ("pending".to_string(), None));
}

#[test]
fn write_then_read_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let mut state = SnapshotState::default();
    state.notes.insert(
        "note-1".into(),
        NoteRow {
            book_id: Some("b1".into()),
            anchor_kind: "word".into(),
            normalized_word: Some("term".into()),
            scope: "global".into(),
            location: Some("epubcfi(/6/4!)".into()),
            selected_text: Some("term".into()),
            content: "remember this".into(),
            content_format: "plain_text".into(),
            created_at: 1_714_770_000_000,
            updated_at: 1_714_770_000_000,
            updated_by_device: "dev-A".into(),
        },
    );
    state.book_summaries.insert(
        "summary-1".into(),
        BookSummaryRow {
            book_id: "b1".into(),
            scope: "book".into(),
            section_index: None,
            section_title: None,
            content: "Overview".into(),
            language: "en".into(),
            model: Some("model".into()),
            source_sha256: "hash".into(),
            created_at: 1_714_770_000_000,
            updated_at: 1_714_770_000_000,
            user_edited: true,
        },
    );
    let marker_id = word_mark_rule_id("b1", "term", "exact");
    state.word_mark_rules.insert(
        marker_id.clone(),
        WordMarkRow {
            book_id: "b1".into(),
            normalized_word: "term".into(),
            display_word: "Term".into(),
            match_mode: "exact".into(),
            color: "lookup".into(),
            enabled: false,
            created_at: 1_714_770_000_000,
            updated_at: 1_714_770_000_100,
            updated_by_device: "dev-A".into(),
        },
    );
    state.word_mark_exceptions.insert(
        word_mark_exception_id(&marker_id, "epubcfi(/6/4!)"),
        WordMarkExceptionRow {
            rule_id: marker_id,
            book_id: "b1".into(),
            normalized_word: "term".into(),
            location: "epubcfi(/6/4!)".into(),
            excluded: true,
            created_at: 1_714_770_000_000,
            updated_at: 1_714_770_000_050,
            updated_by_device: "dev-A".into(),
        },
    );
    let snap = Snapshot {
        v: SNAPSHOT_SCHEMA_VERSION,
        device: "dev-A".into(),
        id: "01HYZX0000000000000000FFFF".into(),
        generated_at: 1_714_770_000_000,
        truncated_before: Some("01HYZX0000000000000000FFFF".into()),
        state,
    };
    let path = tmp.path().join("logs/dev-A.snapshot.json");
    snap.write_atomic(&path).unwrap();

    let read = Snapshot::read_from(&path).unwrap();
    assert_eq!(read, snap);
}

#[test]
fn v1_snapshot_without_learning_fields_remains_readable_and_applicable() {
    let raw = serde_json::json!({
        "v": 1,
        "device": "dev-A",
        "id": "01HYZX0000000000000000FFFF",
        "generated_at": 1_714_770_000_000_i64,
        "truncated_before": null,
        "state": {}
    });
    let snapshot: Snapshot = serde_json::from_value(raw).unwrap();
    assert!(snapshot.state.notes.is_empty());
    assert!(snapshot.state.word_mark_rules.is_empty());

    let mut db = open_db();
    let tx = db.transaction().unwrap();
    let outcome = snapshot.apply_peer(&tx, "dev-A").unwrap();
    assert_eq!(outcome, ApplyOutcome::Applied);
    tx.commit().unwrap();
}

#[test]
fn older_snapshot_versions_cannot_carry_newer_learning_state() {
    let marker_id = word_mark_rule_id("b1", "term", "exact");
    let exception_id = word_mark_exception_id(&marker_id, "epubcfi(/6/4!)");

    let mut v1_state = SnapshotState::default();
    v1_state.word_mark_rules.insert(
        marker_id.clone(),
        WordMarkRow {
            book_id: "b1".into(),
            normalized_word: "term".into(),
            display_word: "Term".into(),
            match_mode: "exact".into(),
            color: "lookup".into(),
            enabled: true,
            created_at: 1_714_770_000_000,
            updated_at: 1_714_770_000_000,
            updated_by_device: "dev-A".into(),
        },
    );
    let v1 = Snapshot {
        v: 1,
        device: "dev-A".into(),
        id: "01HYZX0000000000000000FFF1".into(),
        generated_at: 1_714_770_000_000,
        truncated_before: None,
        state: v1_state,
    };
    let mut db = open_db();
    let tx = db.transaction().unwrap();
    assert!(v1.apply_peer(&tx, "dev-A").is_err());
    tx.rollback().unwrap();

    let mut v2_state = SnapshotState::default();
    v2_state.word_mark_exceptions.insert(
        exception_id,
        WordMarkExceptionRow {
            rule_id: marker_id,
            book_id: "b1".into(),
            normalized_word: "term".into(),
            location: "epubcfi(/6/4!)".into(),
            excluded: true,
            created_at: 1_714_770_000_000,
            updated_at: 1_714_770_000_000,
            updated_by_device: "dev-A".into(),
        },
    );
    let v2 = Snapshot {
        v: 2,
        device: "dev-A".into(),
        id: "01HYZX0000000000000000FFF2".into(),
        generated_at: 1_714_770_000_000,
        truncated_before: None,
        state: v2_state,
    };
    let tx = db.transaction().unwrap();
    assert!(v2.apply_peer(&tx, "dev-A").is_err());
    tx.rollback().unwrap();
}

#[test]
fn snapshot_exception_respects_a_newer_local_parent_rule() {
    let mut db = open_db();
    apply_to(
        &mut db,
        &[
            ev(1000, "dev-A", import("b1")),
            ev(
                4000,
                "dev-A",
                EventBody::WordMarkUpsert(WordMarkPayload {
                    id: word_mark_rule_id("b1", "term", "exact"),
                    book_id: "b1".into(),
                    normalized_word: "term".into(),
                    display_word: "Term".into(),
                    match_mode: "exact".into(),
                    color: "lookup".into(),
                    enabled: true,
                    created_at: 2000,
                }),
            ),
        ],
    );

    let rule_id = word_mark_rule_id("b1", "term", "exact");
    let mut state = SnapshotState::default();
    state.word_mark_exceptions.insert(
        word_mark_exception_id(&rule_id, "epubcfi(/6/4!)"),
        WordMarkExceptionRow {
            rule_id,
            book_id: "b1".into(),
            normalized_word: "term".into(),
            location: "epubcfi(/6/4!)".into(),
            excluded: true,
            created_at: 3000,
            updated_at: 3000,
            updated_by_device: "dev-B".into(),
        },
    );
    let snapshot = Snapshot {
        v: SNAPSHOT_SCHEMA_VERSION,
        device: "dev-B".into(),
        id: "01HYZX0000000000000000FFF3".into(),
        generated_at: 1_714_770_000_000,
        truncated_before: None,
        state,
    };
    let tx = db.transaction().unwrap();
    snapshot.apply_peer(&tx, "dev-B").unwrap();
    tx.commit().unwrap();

    let row: (i64, i64, String) = db
        .query_row(
            "SELECT excluded, updated_at, updated_by_device
                 FROM word_mark_exceptions",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, (0, 4000, "dev-A".into()));
}

#[test]
fn snapshot_rejects_word_mark_with_noncanonical_id() {
    let mut state = SnapshotState::default();
    state.word_mark_rules.insert(
        "random-id".into(),
        WordMarkRow {
            book_id: "b1".into(),
            normalized_word: "term".into(),
            display_word: "Term".into(),
            match_mode: "exact".into(),
            color: "lookup".into(),
            enabled: true,
            created_at: 1_714_770_000_000,
            updated_at: 1_714_770_000_000,
            updated_by_device: "dev-A".into(),
        },
    );
    let snapshot = Snapshot {
        v: SNAPSHOT_SCHEMA_VERSION,
        device: "dev-A".into(),
        id: "01HYZX0000000000000000FFFF".into(),
        generated_at: 1_714_770_000_000,
        truncated_before: None,
        state,
    };
    let mut db = open_db();
    let tx = db.transaction().unwrap();
    assert!(snapshot.apply_peer(&tx, "dev-A").is_err());
}

/// `from_legacy_db` reads a fully-migrated lantern.db (v11 schema) and
/// produces a snapshot byte-equivalent to one built from the events
/// that would have produced the same DB state. This is the
/// migration-snapshot bootstrap path: the legacy DB is the source of
/// truth, dump_state pulls every row out, peers see the snapshot as
/// if it were any other compaction.
#[test]
fn from_legacy_db_dumps_existing_rows() {
    let tmp = TempDir::new().unwrap();
    let db = crate::db::Db::init(tmp.path()).unwrap();
    // Seed a few rows directly via SQL — same shape the legacy file
    // sync would have left behind after migration 011 backfilled
    // updated_by_device='migration'.
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress, created_at, updated_at, updated_by_device)
                 VALUES ('b1', 'War and Peace', 'Tolstoy', 'books/wp.epub', 'epub', 'reading', 42, 1000, 1500, 'migration')",
                [],
            ).unwrap();
        conn.execute(
            "INSERT INTO highlights
                 (id, book_id, cfi_range, color, created_at, updated_at, updated_by_device)
                 VALUES ('h1', 'b1', 'epubcfi(/6/4!/2)', 'yellow', 1100, 1100, 'migration')",
            [],
        )
        .unwrap();
    }

    let snap = {
        let conn = db.conn.lock().unwrap();
        Snapshot::from_legacy_db(&conn, "dev-MIGRATING").unwrap()
    };

    assert_eq!(snap.device, "dev-MIGRATING");
    assert_eq!(
        snap.truncated_before, None,
        "legacy snapshots have no log to truncate"
    );
    assert!(!snap.id.is_empty(), "id should be a freshly-minted ULID");
    assert_eq!(snap.state.books.len(), 1);
    assert_eq!(snap.state.highlights.len(), 1);
    let book = snap.state.books.get("b1").unwrap();
    assert_eq!(book.title, "War and Peace");
    assert_eq!(book.progress, 42);
    assert_eq!(book.updated_by_device, "migration");
}

/// End-to-end migration round trip: a legacy DB → snapshot →
/// apply_peer onto a fresh local DB yields the same row state.
/// This is the read-back path Step 7 relies on for conflict-copy
/// merging (the migrating device replays its own snapshot to absorb
/// rows that only existed in conflict copies).
#[test]
fn from_legacy_db_then_apply_peer_round_trips() {
    let src = TempDir::new().unwrap();
    let src_db = crate::db::Db::init(src.path()).unwrap();
    {
        let conn = src_db.conn.lock().unwrap();
        conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress, created_at, updated_at, updated_by_device)
                 VALUES ('b1', 'T', 'A', 'books/x.epub', 'epub', 'unread', 0, 1000, 1000, 'migration')",
                [],
            ).unwrap();
    }
    let snap = {
        let conn = src_db.conn.lock().unwrap();
        Snapshot::from_legacy_db(&conn, "dev-A").unwrap()
    };

    // Fresh local DB on a different device.
    let dst = TempDir::new().unwrap();
    let dst_db = crate::db::Db::init(dst.path()).unwrap();
    {
        let mut conn = dst_db.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        snap.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }

    let count: i64 = {
        let conn = dst_db.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(count, 1);
}

#[test]
fn book_assets_round_trip_without_syncing_local_availability() {
    let mut source = open_db();
    apply_to(
        &mut source,
        &[
            ev(1_714_770_000_000, "dev-A", import("b1")),
            ev(
                1_714_770_000_001,
                "dev-A",
                EventBody::BookAssetPublish(book_asset("asset-1", "b1")),
            ),
        ],
    );
    source
        .execute(
            "UPDATE book_asset_local_state
             SET availability = 'available_verified', verified_at = 1714770000002
             WHERE asset_id = 'asset-1'",
            [],
        )
        .unwrap();

    let snapshot = Snapshot::from_legacy_db(&source, "dev-A").unwrap();
    assert!(snapshot.state.book_assets.contains_key("asset-1"));
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("available_verified"));

    let mut destination = open_db();
    let tx = destination.transaction().unwrap();
    snapshot.apply_peer(&tx, "dev-A").unwrap();
    tx.commit().unwrap();
    let availability: String = destination
        .query_row(
            "SELECT availability FROM book_asset_local_state WHERE asset_id = 'asset-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(availability, "remote_only");
}

#[test]
fn book_asset_delete_tombstone_survives_snapshot_compaction() {
    let snapshot = Snapshot::from_events(
        "dev-A",
        &[
            ev(1_714_770_000_000, "dev-A", import("b1")),
            ev(
                1_714_770_000_001,
                "dev-A",
                EventBody::BookAssetPublish(book_asset("asset-1", "b1")),
            ),
            ev(
                1_714_770_000_002,
                "dev-A",
                EventBody::BookAssetDelete {
                    id: "asset-1".into(),
                },
            ),
        ],
    )
    .unwrap();
    assert!(snapshot.state.book_assets.is_empty());
    assert!(snapshot
        .state
        .tombstones
        .get("book_asset")
        .is_some_and(|rows| rows.iter().any(|row| row.id == "asset-1")));
}

#[test]
fn book_setting_delete_tombstone_survives_snapshot_and_blocks_stale_row() {
    let snapshot = Snapshot::from_events(
        "dev-A",
        &[
            ev(1_000, "dev-A", import("b1")),
            ev(
                1_100,
                "dev-A",
                EventBody::SettingSet(SettingPayload {
                    book: Some("b1".into()),
                    key: "font".into(),
                    value: Some("literata".into()),
                }),
            ),
            ev(
                1_200,
                "dev-A",
                EventBody::SettingSet(SettingPayload {
                    book: Some("b1".into()),
                    key: "font".into(),
                    value: None,
                }),
            ),
        ],
    )
    .unwrap();

    assert!(snapshot.state.book_settings.is_empty());
    assert!(snapshot
        .state
        .tombstones
        .get(merge::entity::BOOK_SETTING)
        .is_some_and(|rows| rows
            .iter()
            .any(|row| row.id == "b1:font" && row.ts == 1_200)));

    let mut local = open_db();
    apply_to(&mut local, &[ev(1_000, "dev-local", import("b1"))]);
    local
        .execute(
            "INSERT INTO book_settings
             (book_id, key, value, updated_at, updated_by_device)
             VALUES ('b1', 'font', 'stale', 1150, 'dev-local')",
            [],
        )
        .unwrap();
    {
        let tx = local.transaction().unwrap();
        snapshot.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }
    let remaining: i64 = local
        .query_row(
            "SELECT COUNT(*) FROM book_settings WHERE book_id = 'b1' AND key = 'font'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
}

/// End-to-end for the whole point of the change: both marker layers are dumped
/// into a snapshot and land in a peer's tables. `dump_state` used to name the
/// syncable keys in its SQL, so a key could be whitelisted everywhere else and
/// still be missing here — which is why this asserts on the peer's rows rather
/// than on the whitelist.
#[test]
fn marker_visibility_travels_through_a_snapshot_to_a_peer() {
    let snapshot = Snapshot::from_events(
        "dev-A",
        &[
            ev(1_000, "dev-A", import("b1")),
            ev(
                1_100,
                "dev-A",
                EventBody::SettingSet(SettingPayload {
                    book: None,
                    key: "show_mastered_markers".into(),
                    value: Some("false".into()),
                }),
            ),
            ev(
                1_200,
                "dev-A",
                EventBody::SettingSet(SettingPayload {
                    book: Some("b1".into()),
                    key: "show_lookup_markers".into(),
                    value: Some("false".into()),
                }),
            ),
            // A local-only reader preference in the same tables, to prove the
            // widened dump did not start shipping the whole `settings` table.
            ev(
                1_300,
                "dev-A",
                EventBody::SettingSet(SettingPayload {
                    book: Some("b1".into()),
                    key: "font_size".into(),
                    value: Some("22".into()),
                }),
            ),
        ],
    )
    .unwrap();

    assert_eq!(
        snapshot
            .state
            .settings
            .get("show_mastered_markers")
            .map(|row| row.value.as_str()),
        Some("false")
    );
    assert_eq!(
        snapshot
            .state
            .book_settings
            .get("b1:show_lookup_markers")
            .map(|row| row.value.as_str()),
        Some("false")
    );
    assert!(
        !snapshot.state.book_settings.contains_key("b1:font_size"),
        "font_size is a per-screen preference and must stay on this device"
    );

    let mut local = open_db();
    apply_to(&mut local, &[ev(1_000, "dev-local", import("b1"))]);
    {
        let tx = local.transaction().unwrap();
        snapshot.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }

    let global: Option<String> = local
        .query_row(
            "SELECT value FROM settings WHERE key = 'show_mastered_markers'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(global.as_deref(), Some("false"));

    let per_book: Option<String> = local
        .query_row(
            "SELECT value FROM book_settings
             WHERE book_id = 'b1' AND key = 'show_lookup_markers'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(per_book.as_deref(), Some("false"));
}

fn global_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

fn global_setting_tombstone_ts(conn: &Connection, key: &str) -> Option<i64> {
    conn.query_row(
        "SELECT ts FROM _tombstones WHERE entity = 'setting' AND id = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

fn global_setting_event(key: &str, value: Option<&str>) -> EventBody {
    EventBody::SettingSet(SettingPayload {
        book: None,
        key: key.into(),
        value: value.map(str::to_string),
    })
}

/// The snapshot half of the global delete. A snapshot lists the rows that
/// exist, so without the tombstone riding along, the peer's own copy of the
/// deleted row would simply survive the ingest — which is precisely how the
/// promotion undo used to un-undo itself.
#[test]
fn global_setting_delete_tombstone_survives_snapshot_and_blocks_stale_row() {
    let snapshot = Snapshot::from_events(
        "dev-A",
        &[
            ev(
                1_100,
                "dev-A",
                global_setting_event("font_family", Some("literata")),
            ),
            ev(1_200, "dev-A", global_setting_event("font_family", None)),
        ],
    )
    .unwrap();

    assert!(
        !snapshot.state.settings.contains_key("font_family"),
        "the deleted row must not still be listed as existing"
    );
    assert!(
        snapshot
            .state
            .tombstones
            .get(merge::entity::SETTING)
            .is_some_and(|rows| rows
                .iter()
                .any(|row| row.id == "font_family" && row.ts == 1_200)),
        "the delete has to travel as a tombstone: {:?}",
        snapshot.state.tombstones
    );

    let mut local = open_db();
    local
        .execute(
            "INSERT INTO settings (key, value, updated_at, updated_by_device)
             VALUES ('font_family', 'stale', 1150, 'dev-local')",
            [],
        )
        .unwrap();
    {
        let tx = local.transaction().unwrap();
        snapshot.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(global_setting(&local, "font_family"), None);
}

/// The tombstone must not be a one-way door either. A local row written after
/// the peer's delete outranks it, and the peer's later snapshot must leave
/// both that row and the choice it represents alone.
#[test]
fn a_newer_local_global_setting_outranks_an_older_snapshot_tombstone() {
    let snapshot = Snapshot::from_events(
        "dev-A",
        &[
            ev(
                1_100,
                "dev-A",
                global_setting_event("show_mastered_markers", Some("false")),
            ),
            ev(
                1_200,
                "dev-A",
                global_setting_event("show_mastered_markers", None),
            ),
        ],
    )
    .unwrap();

    let mut local = open_db();
    local
        .execute(
            "INSERT INTO settings (key, value, updated_at, updated_by_device)
             VALUES ('show_mastered_markers', 'true', 5000, 'dev-local')",
            [],
        )
        .unwrap();
    {
        let tx = local.transaction().unwrap();
        snapshot.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(
        global_setting(&local, "show_mastered_markers").as_deref(),
        Some("true"),
        "a newer local choice must survive an older peer delete"
    );
    // And the delete must not be filed either. Recording a tombstone this
    // device already knows to be stale would put it in this device's own next
    // snapshot, arguing against the value sitting right next to it.
    assert_eq!(
        global_setting_tombstone_ts(&local, "show_mastered_markers"),
        None,
        "an outranked peer delete must not be recorded"
    );
}

/// The mirror image, and the one that actually bit: a peer that never heard
/// about the delete keeps listing the row as existing. Its snapshot is not
/// wrong — it simply predates the deletion — so the local tombstone is the only
/// thing standing between "restore the default" and the value coming straight
/// back on the next sync.
#[test]
fn a_stale_snapshot_row_cannot_outlive_a_newer_local_delete() {
    let snapshot = Snapshot::from_events(
        "dev-A",
        &[ev(
            1_100,
            "dev-A",
            global_setting_event("font_family", Some("literata")),
        )],
    )
    .unwrap();
    assert!(
        snapshot.state.settings.contains_key("font_family"),
        "the peer must still be claiming the row exists, or this proves nothing"
    );

    let mut local = open_db();
    local
        .execute(
            "INSERT INTO _tombstones (entity, id, ts) VALUES ('setting', 'font_family', 1200)",
            [],
        )
        .unwrap();
    {
        let tx = local.transaction().unwrap();
        snapshot.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(
        global_setting(&local, "font_family"),
        None,
        "a snapshot row older than the local delete must not resurrect it"
    );
    assert_eq!(
        global_setting_tombstone_ts(&local, "font_family"),
        Some(1_200),
        "and the tombstone has to still be there for the next peer"
    );
}

/// Rebuilding the same key after a delete has to win and stay won — including
/// across a second snapshot from the same peer, which is where a tombstone
/// that was written but never cleared would show up.
#[test]
fn a_rewritten_global_setting_clears_its_tombstone_through_the_snapshot_path() {
    let deletion = Snapshot::from_events(
        "dev-A",
        &[
            ev(
                1_100,
                "dev-A",
                global_setting_event("font_family", Some("literata")),
            ),
            ev(1_200, "dev-A", global_setting_event("font_family", None)),
        ],
    )
    .unwrap();
    let mut local = open_db();
    {
        let tx = local.transaction().unwrap();
        deletion.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(global_setting(&local, "font_family"), None);

    // The peer picks a font again. Its next snapshot still carries the old
    // tombstone alongside the new row; the row is newer, so it wins.
    let rewrite = Snapshot::from_events(
        "dev-A",
        &[
            ev(
                1_100,
                "dev-A",
                global_setting_event("font_family", Some("literata")),
            ),
            ev(1_200, "dev-A", global_setting_event("font_family", None)),
            ev(
                2_000,
                "dev-A",
                global_setting_event("font_family", Some("newer")),
            ),
        ],
    )
    .unwrap();
    {
        let tx = local.transaction().unwrap();
        rewrite.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(
        global_setting(&local, "font_family").as_deref(),
        Some("newer")
    );
    // The outranked tombstone has to go, not just lose. Left behind it would
    // ride out in this device's own snapshot and, worse, block any peer whose
    // write happens to land on the same millisecond as the old delete.
    assert_eq!(
        global_setting_tombstone_ts(&local, "font_family"),
        None,
        "a superseded tombstone must be cleared, not merely outvoted"
    );

    // ...and re-applying the deletion snapshot afterwards must not undo it.
    {
        let tx = local.transaction().unwrap();
        deletion.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(
        global_setting(&local, "font_family").as_deref(),
        Some("newer"),
        "a re-delivered older delete must not remove the newer choice"
    );
}

/// `settings` holds the AI credential pointers and every per-screen
/// preference. A peer must not be able to name one in its tombstone list.
#[test]
fn a_snapshot_naming_a_non_syncable_setting_tombstone_is_rejected() {
    let mut snapshot = Snapshot::from_events(
        "dev-A",
        &[ev(
            1_100,
            "dev-A",
            global_setting_event("font_family", None),
        )],
    )
    .unwrap();
    snapshot.state.tombstones.insert(
        merge::entity::SETTING.to_string(),
        vec![TombstoneRow {
            id: "reader_theme".into(),
            ts: 9_000,
        }],
    );

    let mut local = open_db();
    let tx = local.transaction().unwrap();
    let error = snapshot.apply_peer(&tx, "dev-A").unwrap_err();
    assert_eq!(error.to_string(), "SYNC_SNAPSHOT_TOMBSTONE_INVALID");
}

/// The reason marker visibility was held back: a `book_setting` tombstone whose
/// key is not syncable fails validation, and that rejects the *entire* snapshot
/// rather than the one row. Whitelisting the keys is what makes the tombstone
/// legal, so this pins the rejection to keys that really are local-only.
#[test]
fn marker_tombstones_pass_snapshot_validation_and_local_only_keys_still_fail() {
    crate::sync::validation::validate_tombstone_id("book_setting", "b1:show_learning_markers")
        .unwrap();
    assert!(
        crate::sync::validation::validate_tombstone_id("book_setting", "b1:font_size").is_err(),
        "a tombstone for a local-only key is still malformed"
    );
}

#[test]
fn from_events_captures_db_state() {
    let events = vec![
        ev(1000, "dev-A", import("b1")),
        ev(
            1100,
            "dev-A",
            EventBody::HighlightAdd(HighlightPayload {
                id: "h1".into(),
                book_id: "b1".into(),
                cfi_range: "epubcfi(/6/4!/2)".into(),
                color: "yellow".into(),
                text_content: None,
            }),
        ),
        ev(
            1200,
            "dev-A",
            EventBody::HighlightColorSet {
                id: "h1".into(),
                color: "pink".into(),
            },
        ),
    ];
    let snap = Snapshot::from_events("dev-A", &events).unwrap();
    assert_eq!(snap.state.books.len(), 1);
    assert_eq!(snap.state.highlights.len(), 1);
    let h = snap.state.highlights.get("h1").unwrap();
    assert_eq!(h.color, "pink");
    assert_eq!(h.updated_at, 1200);
}

#[test]
fn apply_peer_bootstraps_empty_local_db() {
    // Build a snapshot from peer-A's events; apply to a fresh peer-B DB;
    // assert peer-B's SQL state matches.
    let events = vec![
        ev(1000, "dev-A", import("b1")),
        ev(
            1100,
            "dev-A",
            EventBody::HighlightAdd(HighlightPayload {
                id: "h1".into(),
                book_id: "b1".into(),
                cfi_range: "cfi".into(),
                color: "yellow".into(),
                text_content: None,
            }),
        ),
    ];
    let snap = Snapshot::from_events("dev-A", &events).unwrap();

    let mut local = open_db();
    let outcome = {
        let tx = local.transaction().unwrap();
        let outcome = snap.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
        outcome
    };
    assert_eq!(outcome, ApplyOutcome::Applied);

    let n_books: i64 = local
        .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
        .unwrap();
    let n_hl: i64 = local
        .query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n_books, 1);
    assert_eq!(n_hl, 1);

    let (snap_id, ev_id): (Option<String>, Option<String>) = local
        .query_row(
            "SELECT last_snapshot_id, last_event_id FROM _replay_state WHERE peer_device = 'dev-A'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(snap_id, Some(snap.id.clone()));
    assert_eq!(ev_id, Some(snap.id.clone()));
}

#[test]
fn apply_peer_already_applied_is_short_circuit() {
    let events = vec![ev(1000, "dev-A", import("b1"))];
    let snap = Snapshot::from_events("dev-A", &events).unwrap();
    let mut local = open_db();
    {
        let tx = local.transaction().unwrap();
        snap.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }
    let outcome = {
        let tx = local.transaction().unwrap();
        let o = snap.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
        o
    };
    assert_eq!(outcome, ApplyOutcome::AlreadyApplied);
}

#[test]
fn apply_peer_header_only_when_log_tail_already_ahead() {
    // Peer event tail watermark is already past the snapshot's id —
    // every event the snapshot summarises has been individually applied.
    let events = vec![ev(1000, "dev-A", import("b1"))];
    let snap = Snapshot::from_events("dev-A", &events).unwrap();
    let later_event_id = "01HYZX9999999999999999FFFF"; // sorts after snap.id

    let mut local = open_db();
    // Pre-seed _replay_state as if A's log tail had already been read.
    local
        .execute(
            "INSERT INTO _replay_state (peer_device, last_snapshot_id, last_event_id, updated_at)
                 VALUES ('dev-A', NULL, ?1, ?2)",
            params![later_event_id, chrono::Utc::now().timestamp_millis()],
        )
        .unwrap();

    let outcome = {
        let tx = local.transaction().unwrap();
        let o = snap.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
        o
    };
    assert_eq!(outcome, ApplyOutcome::HeaderOnly);

    // No rows applied; tail watermark preserved (monotonic non-decrease).
    let n_books: i64 = local
        .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n_books, 0);
    let (snap_id, ev_id): (Option<String>, Option<String>) = local
        .query_row(
            "SELECT last_snapshot_id, last_event_id FROM _replay_state WHERE peer_device = 'dev-A'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(snap_id, Some(snap.id.clone()));
    assert_eq!(ev_id.as_deref(), Some(later_event_id));
}

#[test]
fn apply_peer_respects_local_tombstone() {
    let events = vec![
        ev(1000, "dev-A", import("b1")),
        ev(
            1100,
            "dev-A",
            EventBody::HighlightAdd(HighlightPayload {
                id: "h1".into(),
                book_id: "b1".into(),
                cfi_range: "cfi".into(),
                color: "yellow".into(),
                text_content: None,
            }),
        ),
    ];
    let snap = Snapshot::from_events("dev-A", &events).unwrap();

    // Local user (peer-B) deleted the highlight before the snapshot arrived.
    let mut local = open_db();
    merge::insert_tombstone(
        &local.transaction().unwrap(),
        merge::entity::HIGHLIGHT,
        "h1",
        500,
    )
    .unwrap();
    // Need to commit the tombstone before applying snapshot.
    local
        .execute(
            "INSERT OR IGNORE INTO _tombstones (entity, id, ts) VALUES ('highlight', 'h1', 500)",
            [],
        )
        .unwrap();

    {
        let tx = local.transaction().unwrap();
        snap.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }
    let n: i64 = local
        .query_row("SELECT COUNT(*) FROM highlights WHERE id = 'h1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0, "local tombstone should suppress snapshot insertion");
}

#[test]
fn apply_peer_parent_tombstones_suppress_snapshot_children() {
    let events = vec![
        ev(1000, "dev-A", import("b1")),
        ev(
            1100,
            "dev-A",
            EventBody::HighlightAdd(HighlightPayload {
                id: "h1".into(),
                book_id: "b1".into(),
                cfi_range: "cfi".into(),
                color: "yellow".into(),
                text_content: None,
            }),
        ),
        ev(
            1200,
            "dev-A",
            EventBody::BookmarkAdd(BookmarkPayload {
                id: "bm1".into(),
                book_id: "b1".into(),
                cfi: "cfi".into(),
                label: None,
            }),
        ),
        ev(
            1300,
            "dev-A",
            EventBody::VocabAdd(VocabPayload {
                id: "v1".into(),
                book_id: "b1".into(),
                word: "term".into(),
                definition: "definition".into(),
                context_sentence: None,
                cfi: None,
                mastery: "new".into(),
                review_count: 0,
                next_review_at: None,
                review_interval_days: 0,
                last_reviewed_at: None,
                last_review_rating: None,
                fsrs_stability: None,
                fsrs_difficulty: None,
                fsrs_version: 1,
                created_at: None,
                context_explanation: None,
                mastery_source: "manual".into(),
                mastery_reason: None,
                list_status: "confirmed".into(),
            }),
        ),
        ev(
            1350,
            "dev-A",
            EventBody::ChatCreate {
                id: "ch1".into(),
                book: "b1".into(),
                title: "Deleted book chat".into(),
                model: None,
            },
        ),
        ev(
            1375,
            "dev-A",
            EventBody::ChatMessageAdd(ChatMessagePayload {
                id: "m1".into(),
                chat_id: "ch1".into(),
                role: "user".into(),
                content: "stale message".into(),
                context: None,
                metadata: None,
            }),
        ),
        ev(1400, "dev-A", import("b2")),
        ev(
            1500,
            "dev-A",
            EventBody::CollectionCreate {
                id: "c1".into(),
                name: "Collection".into(),
                sort_order: 0,
            },
        ),
        ev(
            1600,
            "dev-A",
            EventBody::CollectionBookAdd {
                collection: "c1".into(),
                book: "b2".into(),
            },
        ),
        ev(1700, "dev-A", import("b3")),
        ev(
            1800,
            "dev-A",
            EventBody::ChatCreate {
                id: "ch3".into(),
                book: "b3".into(),
                title: "Chat".into(),
                model: None,
            },
        ),
        ev(
            1900,
            "dev-A",
            EventBody::ChatMessageAdd(ChatMessagePayload {
                id: "m3".into(),
                chat_id: "ch3".into(),
                role: "user".into(),
                content: "hello".into(),
                context: None,
                metadata: None,
            }),
        ),
    ];
    let snap = Snapshot::from_events("dev-A", &events).unwrap();
    let mut local = open_db();
    local
        .execute(
            "INSERT INTO _tombstones (entity, id, ts) VALUES ('book', 'b1', 2000)",
            [],
        )
        .unwrap();
    local
        .execute(
            "INSERT INTO _tombstones (entity, id, ts) VALUES ('collection', 'c1', 2000)",
            [],
        )
        .unwrap();
    local
        .execute(
            "INSERT INTO _tombstones (entity, id, ts) VALUES ('chat', 'ch3', 2000)",
            [],
        )
        .unwrap();

    let tx = local.transaction().unwrap();
    snap.apply_peer(&tx, "dev-A").unwrap();
    tx.commit().unwrap();

    for table in [
        "highlights",
        "bookmarks",
        "vocab_words",
        "collection_books",
        "chats",
        "chat_messages",
    ] {
        let count: i64 = local
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            count, 0,
            "a stale snapshot must not recreate {table} below a tombstoned parent"
        );
    }
    assert_eq!(
        local
            .query_row(
                "SELECT ts FROM _tombstones WHERE entity = 'chat' AND id = 'ch1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1350,
        "book suppression must leave the same chat tombstone as event replay"
    );
}

#[test]
fn apply_peer_accepts_native_and_text_import_book_paths() {
    // Native imports keep source_file_path under books/, text imports keep
    // file_path itself under sources/. Snapshot validation used to allow
    // neither, so one such book made a peer's whole snapshot unappliable.
    let EventBody::BookImport(mut native) = import("b1") else {
        unreachable!()
    };
    native.source_file_path = Some(native.file_path.clone());
    let EventBody::BookImport(mut text) = import("b2") else {
        unreachable!()
    };
    text.file_path = "sources/b2.txt".into();
    text.source_file_path = Some("sources/b2.txt".into());
    let events = vec![
        ev(1000, "dev-A", EventBody::BookImport(native)),
        ev(1100, "dev-A", EventBody::BookImport(text)),
    ];
    let snap = Snapshot::from_events("dev-A", &events).unwrap();

    let mut local = open_db();
    let tx = local.transaction().unwrap();
    assert_eq!(
        snap.apply_peer(&tx, "dev-A").unwrap(),
        ApplyOutcome::Applied
    );
    tx.commit().unwrap();

    let n_books: i64 = local
        .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n_books, 2);
}

#[test]
fn apply_peer_rejects_escaping_source_file_path() {
    let mut state = SnapshotState::default();
    let mut row = text_book_row(10, "hash");
    row.source_file_path = Some("sources/../secrets.txt".into());
    state.books.insert("b1".into(), row);
    let snapshot = Snapshot {
        v: SNAPSHOT_SCHEMA_VERSION,
        device: "dev-A".into(),
        id: "01HYZX0000000000000000B001".into(),
        generated_at: 1_714_770_000_000,
        truncated_before: None,
        state,
    };
    let mut local = open_db();
    let tx = local.transaction().unwrap();
    assert!(snapshot.apply_peer(&tx, "dev-A").is_err());
    tx.rollback().unwrap();
}

#[test]
fn apply_peer_rejects_invalid_tombstone_metadata() {
    let invalid_cases = [
        ("unknown", "b1", 1000),
        ("book", "../b1", 1000),
        ("collection_book", "c1", 1000),
        ("book", "b1", -1),
        (
            "book",
            "b1",
            chrono::Utc::now().timestamp_millis() + 48 * 60 * 60 * 1_000,
        ),
    ];

    for (index, (entity, id, ts)) in invalid_cases.into_iter().enumerate() {
        assert!(
            (|| -> AppResult<()> {
                crate::sync::validation::validate_tombstone_entity(entity)?;
                crate::sync::validation::validate_tombstone_id(entity, id)?;
                crate::sync::validation::ensure_valid_sync_timestamp(
                    ts,
                    "SYNC_SNAPSHOT_TOMBSTONE_INVALID",
                )
            })()
            .is_err(),
            "case {index} should be rejected: {entity}:{id}@{ts}"
        );
        let mut state = SnapshotState::default();
        state
            .tombstones
            .insert(entity.into(), vec![TombstoneRow { id: id.into(), ts }]);
        let snapshot = Snapshot {
            v: SNAPSHOT_SCHEMA_VERSION,
            device: "dev-A".into(),
            id: format!("01HYZX0000000000000000{:04X}", 0xA000 + index),
            generated_at: 1_714_770_000_000,
            truncated_before: None,
            state,
        };
        let mut local = open_db();
        let tx = local.transaction().unwrap();
        assert!(snapshot.apply_peer(&tx, "dev-A").is_err());
        tx.rollback().unwrap();
    }
}

#[test]
fn apply_peer_lww_preserves_newer_local_value() {
    // Local DB has progress=80 (newer), peer snapshot has progress=10
    // (older). Apply must NOT overwrite the newer local value.
    let mut local = open_db();
    apply_to(
        &mut local,
        &[
            ev(1000, "dev-B", import("b1")),
            ev(
                5000,
                "dev-B",
                EventBody::BookProgressSet {
                    book: "b1".into(),
                    progress: 80,
                    cfi: Some("c80".into()),
                },
            ),
        ],
    );

    let peer_events = vec![
        ev(1000, "dev-A", import("b1")),
        ev(
            2000,
            "dev-A",
            EventBody::BookProgressSet {
                book: "b1".into(),
                progress: 10,
                cfi: Some("c10".into()),
            },
        ),
    ];
    let snap = Snapshot::from_events("dev-A", &peer_events).unwrap();
    {
        let tx = local.transaction().unwrap();
        snap.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }
    let progress: i32 = local
        .query_row("SELECT progress FROM books WHERE id = 'b1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(progress, 80, "newer local value survives older snapshot");
}

// -----------------------------------------------------------------------
// Regression for PR #189 finding #1: snapshot tombstones must scrub the
// same child rows the event-path delete would have. Two scenarios:
//
//   a. `book.delete` from a peer leaves no orphan highlights/bookmarks/
//      vocab/etc. when ingested via snapshot.
//   b. `collection.book.remove` from a peer drops the join row, even
//      though the composite-key tombstone has no single-column id.
// -----------------------------------------------------------------------

#[test]
fn snapshot_tombstone_for_book_removes_local_children() {
    // Local-A imported b1 and added a highlight + bookmark + vocab.
    // Peer-B's snapshot says b1 was deleted. Apply must scrub the
    // children, not just leave them dangling.
    let mut local = open_db();
    apply_to(
        &mut local,
        &[
            ev(1000, "dev-A", import("b1")),
            ev(
                1100,
                "dev-A",
                EventBody::HighlightAdd(HighlightPayload {
                    id: "h1".into(),
                    book_id: "b1".into(),
                    cfi_range: "cfi".into(),
                    color: "yellow".into(),
                    text_content: None,
                }),
            ),
            ev(
                1200,
                "dev-A",
                EventBody::BookmarkAdd(BookmarkPayload {
                    id: "bm1".into(),
                    book_id: "b1".into(),
                    cfi: "cfi".into(),
                    label: None,
                }),
            ),
        ],
    );

    // Peer-B's snapshot reflects: imported b1, then deleted it.
    let peer_events = vec![
        ev(900, "dev-B", import("b1")),
        ev(2000, "dev-B", EventBody::BookDelete { id: "b1".into() }),
    ];
    let snap = Snapshot::from_events("dev-B", &peer_events).unwrap();

    {
        let tx = local.transaction().unwrap();
        snap.apply_peer(&tx, "dev-B").unwrap();
        tx.commit().unwrap();
    }

    for table in ["books", "highlights", "bookmarks"] {
        let n: i64 = local
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "snapshot tombstone for book must cascade to {table}");
    }
    let tomb: i64 = local
        .query_row(
            "SELECT COUNT(*) FROM _tombstones WHERE entity = 'book' AND id = 'b1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tomb, 1);
}

#[test]
fn snapshot_tombstone_for_collection_book_removes_join_row() {
    // Local-A has the join row (c1, b1). Peer-B's snapshot includes a
    // composite-key tombstone for the same pair. The join row must be
    // gone after apply.
    let mut local = open_db();
    apply_to(
        &mut local,
        &[
            ev(1000, "dev-A", import("b1")),
            ev(
                1100,
                "dev-A",
                EventBody::CollectionCreate {
                    id: "c1".into(),
                    name: "Top".into(),
                    sort_order: 0,
                },
            ),
            ev(
                1200,
                "dev-A",
                EventBody::CollectionBookAdd {
                    collection: "c1".into(),
                    book: "b1".into(),
                },
            ),
        ],
    );

    let peer_events = vec![
        ev(900, "dev-B", import("b1")),
        ev(
            950,
            "dev-B",
            EventBody::CollectionCreate {
                id: "c1".into(),
                name: "Top".into(),
                sort_order: 0,
            },
        ),
        ev(
            1000,
            "dev-B",
            EventBody::CollectionBookAdd {
                collection: "c1".into(),
                book: "b1".into(),
            },
        ),
        ev(
            2000,
            "dev-B",
            EventBody::CollectionBookRemove {
                collection: "c1".into(),
                book: "b1".into(),
            },
        ),
    ];
    let snap = Snapshot::from_events("dev-B", &peer_events).unwrap();
    {
        let tx = local.transaction().unwrap();
        snap.apply_peer(&tx, "dev-B").unwrap();
        tx.commit().unwrap();
    }
    let n: i64 = local
        .query_row(
            "SELECT COUNT(*) FROM collection_books WHERE collection_id = 'c1' AND book_id = 'b1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        n, 0,
        "composite-key snapshot tombstone must drop the join row"
    );
}

#[test]
fn snapshot_equivalence_events_vs_snapshot_yields_same_state() {
    // Apply event set X directly to DB1; build snapshot from X and apply
    // to DB2; compare every row.
    let events = vec![
        ev(1000, "dev-A", import("b1")),
        ev(1100, "dev-B", import("b2")),
        ev(
            1200,
            "dev-A",
            EventBody::HighlightAdd(HighlightPayload {
                id: "h1".into(),
                book_id: "b1".into(),
                cfi_range: "cfi".into(),
                color: "yellow".into(),
                text_content: None,
            }),
        ),
        ev(
            1300,
            "dev-A",
            EventBody::CollectionCreate {
                id: "c1".into(),
                name: "Top".into(),
                sort_order: 0,
            },
        ),
        ev(
            1400,
            "dev-A",
            EventBody::CollectionBookAdd {
                collection: "c1".into(),
                book: "b1".into(),
            },
        ),
        // `list_status` exercise (regression for the watchlist snapshot leak):
        // one word that's always been on the formal list, one that's stayed
        // in the observation zone, and one that started in the observation
        // zone and was promoted — the promotion goes through the dedicated
        // `VocabListStatusSet` LWW path, not a plain `VocabAdd`.
        ev(
            1405,
            "dev-A",
            EventBody::VocabAdd(VocabPayload {
                id: "voc-confirmed".into(),
                book_id: "b1".into(),
                word: "steadfast".into(),
                definition: "resolutely firm".into(),
                context_sentence: None,
                cfi: None,
                mastery: "new".into(),
                review_count: 0,
                next_review_at: None,
                review_interval_days: 0,
                last_reviewed_at: None,
                last_review_rating: None,
                fsrs_stability: None,
                fsrs_difficulty: None,
                fsrs_version: 1,
                created_at: None,
                context_explanation: None,
                mastery_source: "manual".into(),
                mastery_reason: None,
                list_status: "confirmed".into(),
            }),
        ),
        ev(
            1410,
            "dev-A",
            EventBody::VocabAdd(VocabPayload {
                id: "voc-watchlist".into(),
                book_id: "b1".into(),
                word: "ephemeral".into(),
                definition: "lasting a short time".into(),
                context_sentence: None,
                cfi: None,
                mastery: "new".into(),
                review_count: 0,
                next_review_at: None,
                review_interval_days: 0,
                last_reviewed_at: None,
                last_review_rating: None,
                fsrs_stability: None,
                fsrs_difficulty: None,
                fsrs_version: 1,
                created_at: None,
                context_explanation: None,
                mastery_source: "manual".into(),
                mastery_reason: None,
                list_status: "watchlist".into(),
            }),
        ),
        ev(
            1415,
            "dev-A",
            EventBody::VocabAdd(VocabPayload {
                id: "voc-promoted".into(),
                book_id: "b1".into(),
                word: "lucid".into(),
                definition: "clear, easy to understand".into(),
                context_sentence: None,
                cfi: None,
                mastery: "new".into(),
                review_count: 0,
                next_review_at: None,
                review_interval_days: 0,
                last_reviewed_at: None,
                last_review_rating: None,
                fsrs_stability: None,
                fsrs_difficulty: None,
                fsrs_version: 1,
                created_at: None,
                context_explanation: None,
                mastery_source: "manual".into(),
                mastery_reason: None,
                list_status: "watchlist".into(),
            }),
        ),
        ev(
            1420,
            "dev-A",
            EventBody::VocabListStatusSet {
                id: "voc-promoted".into(),
                list_status: "confirmed".into(),
            },
        ),
        ev(
            1450,
            "dev-A",
            EventBody::WordMarkUpsert(WordMarkPayload {
                id: word_mark_rule_id("b1", "term", "exact"),
                book_id: "b1".into(),
                normalized_word: "term".into(),
                display_word: "Term".into(),
                match_mode: "exact".into(),
                color: "lookup".into(),
                enabled: true,
                created_at: 1450,
            }),
        ),
        ev(
            1460,
            "dev-A",
            EventBody::WordMarkExceptionSet(WordMarkExceptionPayload {
                id: word_mark_exception_id(
                    &word_mark_rule_id("b1", "term", "exact"),
                    "epubcfi(/6/4!)",
                ),
                rule_id: word_mark_rule_id("b1", "term", "exact"),
                book_id: "b1".into(),
                normalized_word: "term".into(),
                location: "epubcfi(/6/4!)".into(),
                excluded: true,
                created_at: 1460,
            }),
        ),
        ev(
            1470,
            "dev-A",
            EventBody::ChatCreate {
                id: "chat-1".into(),
                book: "b1".into(),
                title: "Chat".into(),
                model: None,
            },
        ),
        ev(
            1480,
            "dev-A",
            EventBody::ChatMessageAdd(ChatMessagePayload {
                id: "message-1".into(),
                chat_id: "chat-1".into(),
                role: "assistant".into(),
                content: "old".into(),
                context: None,
                metadata: None,
            }),
        ),
        ev(
            1490,
            "dev-B",
            EventBody::ChatMessageReplace(ChatMessagePayload {
                id: "message-1".into(),
                chat_id: "chat-1".into(),
                role: "assistant".into(),
                content: "new".into(),
                context: None,
                metadata: Some("{}".into()),
            }),
        ),
        ev(
            1500,
            "dev-B",
            EventBody::HighlightDelete { id: "h1".into() },
        ),
    ];

    let mut db1 = open_db();
    apply_to(&mut db1, &events);

    let snap = Snapshot::from_events("dev-A", &events).unwrap();
    let mut db2 = open_db();
    {
        let tx = db2.transaction().unwrap();
        snap.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }

    let dump = |db: &Connection, table: &str| -> Vec<String> {
        let mut stmt = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
            .unwrap();
        let cols = stmt.column_count();
        stmt.query_map([], |r| {
            let mut s = String::new();
            for i in 0..cols {
                let v: rusqlite::types::Value = r.get(i)?;
                s.push_str(&format!("{v:?}|"));
            }
            Ok(s)
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    };

    for table in [
        "books",
        "highlights",
        "bookmarks",
        "vocab_words",
        "word_mark_rules",
        "word_mark_exceptions",
        "collections",
        "collection_books",
        "chats",
        "chat_messages",
        "_tombstones",
    ] {
        assert_eq!(
            dump(&db1, table),
            dump(&db2, table),
            "{table} differs between event-direct and snapshot-applied"
        );
    }

    // Explicit watchlist assertions on the snapshot-bootstrapped DB: the
    // table-dump equality above already proves this (both DBs would show
    // 'confirmed' if `upsert_vocab` dropped `list_status`, since db1 is
    // independently correct via `merge::apply_event`), but the bug this
    // guards — a new device bootstrapping from a compacted snapshot and
    // finding every watchlist word promoted to the formal vocab list — is
    // severe enough to spell out directly rather than leave it implicit in
    // a generic diff.
    let list_status = |db: &Connection, id: &str| -> String {
        db.query_row(
            "SELECT list_status FROM vocab_words WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(list_status(&db2, "voc-confirmed"), "confirmed");
    assert_eq!(
        list_status(&db2, "voc-watchlist"),
        "watchlist",
        "watchlist row must not be promoted to 'confirmed' by snapshot bootstrap"
    );
    assert_eq!(
        list_status(&db2, "voc-promoted"),
        "confirmed",
        "VocabListStatusSet promotion must survive snapshot round-trip"
    );
}

// -----------------------------------------------------------------------
// Compaction
// -----------------------------------------------------------------------

/// Helper: write events to a real on-disk EventLog so compact_own_log
/// can be exercised end-to-end.
fn seed_log(shared: &Path, device: &str, bodies: Vec<EventBody>) -> EventLog {
    let log_path = shared.join("logs").join(format!("{device}.jsonl"));
    let log = EventLog::open(&log_path, device, false).unwrap();
    for (i, body) in bodies.into_iter().enumerate() {
        log.append(body, 1_000 + i as i64).unwrap();
    }
    log
}

#[test]
fn should_compact_returns_false_for_missing_log() {
    let tmp = TempDir::new().unwrap();
    assert!(!should_compact(tmp.path(), "nope"));
}

#[test]
fn should_compact_returns_false_for_empty_log() {
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path();
    std::fs::create_dir_all(shared.join("logs")).unwrap();
    let _log = EventLog::open(&shared.join("logs/dev-A.jsonl"), "dev-A", false).unwrap();
    assert!(!should_compact(shared, "dev-A"));
}

#[test]
fn should_compact_false_for_small_log_without_snapshot() {
    // The first-snapshot case is owned by sync_enable /
    // migration::run_migration. should_compact deliberately stays
    // out of the way until the size/count/age triggers fire on a
    // log that's actually become unwieldy.
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path();
    std::fs::create_dir_all(shared.join("logs")).unwrap();
    let _log = seed_log(shared, "dev-A", vec![import("b1")]);
    assert!(!should_compact(shared, "dev-A"));
}

#[test]
fn should_compact_true_when_event_count_exceeds_threshold() {
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path();
    std::fs::create_dir_all(shared.join("logs")).unwrap();

    // Drop a 5001-line file directly; cheaper than appending 5001
    // events through EventLog. The byte-scan inside should_compact
    // doesn't care about content as long as the lines parse-skip
    // cleanly later (they don't here, but should_compact uses the
    // raw newline count, not a parse).
    let log_path = shared.join("logs/dev-A.jsonl");
    let mut buf = Vec::with_capacity(5001 * 8);
    for i in 0..5001 {
        buf.extend_from_slice(format!("{{\"x\":{i}}}\n").as_bytes());
    }
    std::fs::write(&log_path, &buf).unwrap();

    // Write a fresh-enough snapshot so the age threshold doesn't
    // trip first.
    let snap_path = shared.join("logs/dev-A.snapshot.json");
    let snap = Snapshot {
        v: SNAPSHOT_SCHEMA_VERSION,
        device: "dev-A".into(),
        id: "01HZA0000000000000000000F0".into(),
        generated_at: chrono::Utc::now().timestamp_millis(),
        truncated_before: None,
        state: SnapshotState::default(),
    };
    snap.write_atomic(&snap_path).unwrap();

    assert!(should_compact(shared, "dev-A"));
}

#[test]
fn compact_own_log_truncates_log_and_writes_snapshot() {
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path();
    std::fs::create_dir_all(shared.join("logs")).unwrap();
    let log = seed_log(
        shared,
        "dev-A",
        vec![import("b1"), import("b2"), import("b3")],
    );

    let report = compact_own_log(shared, &log).unwrap();
    assert_eq!(report.events_folded, 3);
    assert!(report.snapshot_written);

    // Log is now empty.
    let bytes = std::fs::read(log.path()).unwrap();
    assert_eq!(bytes.len(), 0, "log should be truncated to zero");

    // Snapshot exists with all three books.
    let snap_path = shared.join("logs/dev-A.snapshot.json");
    let snap = Snapshot::read_from(&snap_path).unwrap();
    assert_eq!(snap.state.books.len(), 3);
    assert!(snap.truncated_before.is_some());
}

#[test]
fn compact_own_log_is_noop_on_empty_log() {
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path();
    std::fs::create_dir_all(shared.join("logs")).unwrap();
    let log_path = shared.join("logs/dev-A.jsonl");
    let log = EventLog::open(&log_path, "dev-A", false).unwrap();

    let report = compact_own_log(shared, &log).unwrap();
    assert_eq!(report.events_folded, 0);
    assert!(!report.snapshot_written);
    assert!(!shared.join("logs/dev-A.snapshot.json").exists());
}

#[test]
fn compact_own_log_idempotent_when_run_twice() {
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path();
    std::fs::create_dir_all(shared.join("logs")).unwrap();
    let log = seed_log(shared, "dev-A", vec![import("b1"), import("b2")]);

    let r1 = compact_own_log(shared, &log).unwrap();
    assert_eq!(r1.events_folded, 2);

    // Second run sees an empty log → no snapshot rewrite.
    let r2 = compact_own_log(shared, &log).unwrap();
    assert_eq!(r2.events_folded, 0);
    assert!(!r2.snapshot_written);
}

#[test]
fn compact_then_apply_yields_same_state_as_replay() {
    // Round-trip equivalence: apply N events directly to DB1; on
    // a separate device, compact (events → snapshot + truncated
    // log), then `apply_peer` the resulting snapshot to DB2.
    // Both DBs must end up with byte-identical row state.
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path();
    std::fs::create_dir_all(shared.join("logs")).unwrap();

    let bodies = vec![
        import("b1"),
        import("b2"),
        EventBody::HighlightAdd(HighlightPayload {
            id: "h1".into(),
            book_id: "b1".into(),
            cfi_range: "cfi".into(),
            color: "yellow".into(),
            text_content: None,
        }),
        EventBody::CollectionCreate {
            id: "c1".into(),
            name: "Top".into(),
            sort_order: 0,
        },
        EventBody::CollectionBookAdd {
            collection: "c1".into(),
            book: "b1".into(),
        },
        EventBody::WordMarkUpsert(WordMarkPayload {
            id: word_mark_rule_id("b1", "term", "exact"),
            book_id: "b1".into(),
            normalized_word: "term".into(),
            display_word: "Term".into(),
            match_mode: "exact".into(),
            color: "lookup".into(),
            enabled: true,
            created_at: 1005,
        }),
        EventBody::WordMarkExceptionSet(WordMarkExceptionPayload {
            id: word_mark_exception_id(&word_mark_rule_id("b1", "term", "exact"), "epubcfi(/6/4!)"),
            rule_id: word_mark_rule_id("b1", "term", "exact"),
            book_id: "b1".into(),
            normalized_word: "term".into(),
            location: "epubcfi(/6/4!)".into(),
            excluded: true,
            created_at: 1006,
        }),
    ];

    // Direct-replay path: write events to a log, then read them
    // out and apply via merge::apply_event.
    let log = seed_log(shared, "dev-A", bodies);
    let events = log.read_all().unwrap();
    let mut db_direct = open_db();
    apply_to(&mut db_direct, &events);

    // Compaction path: compact the log → snapshot, then apply the
    // snapshot to a fresh DB.
    compact_own_log(shared, &log).unwrap();
    let snap = Snapshot::read_from(&shared.join("logs/dev-A.snapshot.json")).unwrap();
    let mut db_via_snap = open_db();
    {
        let tx = db_via_snap.transaction().unwrap();
        snap.apply_peer(&tx, "dev-A").unwrap();
        tx.commit().unwrap();
    }

    let dump = |db: &Connection, table: &str| -> Vec<String> {
        let mut stmt = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
            .unwrap();
        let cols = stmt.column_count();
        stmt.query_map([], |r| {
            let mut s = String::new();
            for i in 0..cols {
                let v: rusqlite::types::Value = r.get(i)?;
                s.push_str(&format!("{v:?}|"));
            }
            Ok(s)
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    };

    for table in [
        "books",
        "highlights",
        "word_mark_rules",
        "word_mark_exceptions",
        "collections",
        "collection_books",
    ] {
        assert_eq!(
            dump(&db_direct, table),
            dump(&db_via_snap, table),
            "{table} state differs after compaction roundtrip",
        );
    }
}

/// Regression for PR #194's review finding: compaction must NOT
/// truncate the source log if the snapshot write fails. The
/// fold-and-truncate sequence has to commit the new snapshot
/// durably before the log loses its events — otherwise a crash
/// window between snapshot rename and log truncate can lose
/// already-published events.
///
/// Direct simulation of a power loss is hard from a unit test,
/// but the proxy-bug we can reliably exercise is "snapshot
/// write fails." If the code truncates the log anyway, that's
/// the same data-loss path; fixing it (committing snapshot
/// durably first, propagating any error) closes the crash
/// window too.
#[test]
fn compact_keeps_log_when_snapshot_write_fails() {
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path();
    std::fs::create_dir_all(shared.join("logs")).unwrap();
    let log = seed_log(
        shared,
        "dev-A",
        vec![import("b1"), import("b2"), import("b3")],
    );
    let original_log_bytes = std::fs::read(log.path()).unwrap();
    assert!(!original_log_bytes.is_empty());

    // Make the snapshot write fail by occupying the destination
    // path with a directory: the temp write succeeds, but the
    // final `fs::rename(tmp, dst)` returns EISDIR. This short-
    // circuits `write_atomic` with an error before the log
    // truncate runs — exactly the failure mode we need to prove
    // doesn't take the log down with it.
    let snap_dst = shared.join("logs/dev-A.snapshot.json");
    std::fs::create_dir_all(&snap_dst).unwrap();

    let result = compact_own_log(shared, &log);
    assert!(
        result.is_err(),
        "compaction must propagate snapshot write failure"
    );

    // Source log must still have every event we seeded — losing
    // them here would mean peers never see them.
    let preserved = std::fs::read(log.path()).unwrap();
    assert_eq!(
        preserved, original_log_bytes,
        "log must be untouched when snapshot write fails"
    );
}

#[test]
fn second_compaction_picks_up_new_events_via_prior_snapshot() {
    // After compaction the snapshot holds the old state and the log
    // is empty. New events arrive → second compaction must fold the
    // prior snapshot AND the new events into a fresh snapshot.
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path();
    std::fs::create_dir_all(shared.join("logs")).unwrap();
    let log = seed_log(shared, "dev-A", vec![import("b1")]);

    compact_own_log(shared, &log).unwrap();
    // New event lands after the first compaction.
    log.append(import("b2"), 9_999).unwrap();
    compact_own_log(shared, &log).unwrap();

    let snap = Snapshot::read_from(&shared.join("logs/dev-A.snapshot.json")).unwrap();
    assert_eq!(
        snap.state.books.len(),
        2,
        "fresh snapshot must include both books"
    );
}
