# Item 3 — LWW `(updated_at, updated_by_device)` tiebreak: raw evidence

Raw facts only. No verdicts, no recommendations.

File under test: `src-tauri/src/sync/merge.rs` (5049 lines at time of this run).

## Commands run

```
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/lijianwei/vibecoding/Lantern/src-tauri

# static census
wc -l src/sync/merge.rs
grep -n "ON CONFLICT\|updated_at\|updated_by_device" src/sync/merge.rs

# dynamic probe (after writing src/sync/tmp_lww_probe.rs and registering it
# as `#[cfg(test)] mod tmp_lww_probe;` in src/sync/mod.rs)
cargo test --lib sync::tmp_lww_probe -- --nocapture
```

---

## PART A — static census

Every `ON CONFLICT` / `WHERE ... updated_at` site in `merge.rs`, in line order. "Predicate text" is verbatim from the file. Table names are the SQLite tables the statement writes to; "entity/event kind" is the sync entity tag or the `EventBody` variant that reaches the statement.

| # | Line(s) | Table | Entity / event kind | Predicate text (verbatim) | Class |
|---|---|---|---|---|---|
| 1 | 223-224 | `_tombstones` | tombstone ts merge (`insert_tombstone`, called by every delete arm) | `ON CONFLICT(entity, id) DO UPDATE SET ts = MAX(_tombstones.ts, excluded.ts)` | other — commutative `MAX`, no predicate to lose, no device column |
| 2 | 286-288 | `word_mark_rules` | `cascade_delete` entity `word_mark` (snapshot-tombstone path only, see note below table) | `UPDATE word_mark_rules SET enabled = 0, updated_at = MAX(updated_at, ?2) WHERE id = ?1` | other — unconditional `MAX`, no device, no losing branch |
| 3 | 294-296 | `word_mark_exceptions` | `cascade_delete` entity `word_mark_exception` (snapshot-tombstone path only) | `UPDATE word_mark_exceptions SET excluded = 0, updated_at = MAX(updated_at, ?2) WHERE id = ?1` | other — same as #2 |
| 4 | 302-304 | `lookup_occurrence_marks` | `cascade_delete` entity `lookup_occurrence_mark` (snapshot-tombstone path only) | `UPDATE lookup_occurrence_marks SET enabled = 0, updated_at = MAX(updated_at, ?2) WHERE id = ?1` | other — same as #2 |
| 5 | 314-316 | `book_settings` | `cascade_delete` entity `book_setting` (snapshot-tombstone path only) | `DELETE FROM book_settings WHERE book_id = ?1 AND key = ?2 AND updated_at <= ?3` | **bare** |
| 6 | 328-330 | `settings` | `cascade_delete` entity `setting` (snapshot-tombstone path only) | `DELETE FROM settings WHERE key = ?1 AND updated_at <= ?2` | **bare** |
| 7 | 624-628 | `books` | `book.progress.set` | `WHERE id = ?5 AND (updated_at < ?3 OR (updated_at = ?3 AND updated_by_device < ?4))` | longhand |
| 8 | 634-639 | `books` | `book.status.set` | `WHERE id = ?4 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))` | longhand |
| 9 | 671-676 | `books` | `book.metadata.set` | `WHERE id = ?4 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device <= ?3))` | longhand* — device compare uses `<=`, not `<` (intentional, documented at lines 664-670: lets same-`(ts,device)` multi-field edits all land) |
| 10 | 738-743 | `highlights` | `highlight.color.set` | `WHERE id = ?4 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))` | longhand |
| 11 | 831-835 | `vocab_words` | `vocab.list_status.set` | `WHERE id = ?4 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))` | longhand |
| 12 | 875-882 | `vocab_words` | `vocab.definition.set` | `WHERE id = ?5 AND (updated_at < ?3 OR (updated_at = ?3 AND updated_by_device < ?4))` | longhand |
| 13 | 908-924 | `vocab_words` | `vocab.mastery.set` | `WHERE id = ?14 AND (updated_at < ?12 OR (updated_at = ?12 AND updated_by_device < ?13))` | longhand |
| 14 | 1022-1031 | `notes` | `note.upsert` | `ON CONFLICT(id) DO UPDATE ... WHERE notes.updated_at < excluded.updated_at OR (notes.updated_at = excluded.updated_at AND notes.updated_by_device < excluded.updated_by_device)` | longhand |
| 15 | 1212-1220 | `word_mark_rules` | `word_mark.upsert` | `ON CONFLICT(book_id, normalized_word, match_mode) DO UPDATE ... WHERE word_mark_rules.updated_at < excluded.updated_at OR (word_mark_rules.updated_at = excluded.updated_at AND word_mark_rules.updated_by_device < excluded.updated_by_device)` | longhand |
| 16 | 1271-1275 | `word_mark_exceptions` | reset barrier inside `word_mark.upsert` (rule tuple wins branch) | `WHERE rule_id = ?1 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))` | longhand |
| 17 | 1300-1301 | `word_mark_rules` | `word_mark.delete` (legacy compat) | `WHERE id = ?1 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))` | longhand |
| 18 | 1305-1309 | `word_mark_exceptions` | cascade reset inside `word_mark.delete` | `WHERE rule_id = ?1 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))` | longhand |
| 19 | 1348-1360 | `word_mark_exceptions` | `word_mark_exception.set` | `ON CONFLICT(rule_id, location) DO UPDATE ... WHERE word_mark_exceptions.updated_at < excluded.updated_at OR (word_mark_exceptions.updated_at = excluded.updated_at AND word_mark_exceptions.updated_by_device < excluded.updated_by_device)` | longhand |
| 20 | 1384-1394 | `lookup_occurrence_marks` | `lookup_occurrence_mark.set` | `ON CONFLICT(book_id, location) DO UPDATE ... WHERE (lookup_occurrence_marks.updated_at, lookup_occurrence_marks.updated_by_device) < (excluded.updated_at, excluded.updated_by_device)` | tuple |
| 21 | 1422-1430 | `auto_highlight_dismissals` | `auto_highlight_dismissal.set` | `ON CONFLICT(book_id, anchor) DO UPDATE ... WHERE (auto_highlight_dismissals.updated_at, auto_highlight_dismissals.updated_by_device) < (excluded.updated_at, excluded.updated_by_device)` | tuple |
| 22 | 1452-1461 | `book_summaries` | `book_summary.upsert` | `ON CONFLICT(book_id, scope, COALESCE(section_index, -1)) DO UPDATE ... WHERE book_summaries.updated_at < excluded.updated_at` | **bare** — the table has no `updated_by_device` column at all (schema check below); this is not a predicate that dropped the tiebreak, the column doesn't exist to drop |
| 23 | 1503-1508 | `collections` | `collection.rename` | `WHERE id = ?4 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))` | longhand |
| 24 | 1514-1524 | `collections` | `collection.reorder` | `WHERE id = ?4 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))` | longhand |
| 25 | 1620-1625 | `chats` | `chat.rename` | `WHERE id = ?4 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))` | longhand |
| 26 | 1666-1670 | `chats` | parent-chat recency bump inside `chat_message.add` | `WHERE id = ?3 AND (updated_at < ?1 OR (updated_at = ?1 AND updated_by_device < ?2))` | longhand |
| 27 | 1686-1690 | `chat_messages` | `chat_message.replace` | `WHERE id = ?5 AND chat_id = ?6 AND role = 'assistant' AND (updated_at, updated_by_device) < (?3, ?4)` | tuple |
| 28 | 1703-1707 | `chats` | parent-chat recency bump inside `chat_message.replace` | `WHERE id = ?3 AND (updated_at < ?1 OR (updated_at = ?1 AND updated_by_device < ?2))` | longhand |
| 29 | 1741-1750 | `custom_fonts` | `custom_font.upsert` | `ON CONFLICT(id) DO UPDATE ... WHERE (custom_fonts.updated_at, custom_fonts.updated_by_device) < (excluded.updated_at, excluded.updated_by_device)` | tuple |
| 30 | 1794-1798 | `settings` | side effect of `cascade_delete_custom_font` (unselect deleted font) | `UPDATE settings SET value = 'system', updated_at = MAX(updated_at, ?2) WHERE key = 'font_family' AND value = ?1` | other — unconditional `MAX`, no device |
| 31 | 1799-1803 | `book_settings` | side effect of `cascade_delete_custom_font` (unselect deleted font) | `UPDATE book_settings SET value = 'system', updated_at = MAX(updated_at, ?2) WHERE key = 'font' AND value = ?1` | other — same as #30 |
| 32 | 1827-1828 | `settings` (gate, not a row compare) | `setting.set`, global upsert arm, tombstone gate | `tombstone_timestamp(tx, entity::SETTING, &payload.key)?.is_some_and(\|timestamp\| timestamp >= event.ts)` (Rust, gates the INSERT below; not SQL) | other — ts-only, but this is a tombstone-vs-incoming-event gate, not a race between two writer events |
| 33 | 1836-1842 | `settings` | `setting.set`, global upsert arm (`(None, Some)`) | `INSERT ... ON CONFLICT(key) DO UPDATE ... WHERE (settings.updated_at, settings.updated_by_device) < (excluded.updated_at, excluded.updated_by_device)` | tuple |
| 34 | 1853-1854 | `book_settings` (gate, not a row compare) | `setting.set`, per-book upsert arm, tombstone gate | `tombstone_timestamp(tx, entity::BOOK_SETTING, &tombstone_id)?.is_some_and(\|timestamp\| timestamp >= event.ts)` (Rust, gates the INSERT below; not SQL) | other — same shape as #32 |
| 35 | 1862-1868 | `book_settings` | `setting.set`, per-book upsert arm (`(Some, Some)`) | `INSERT ... ON CONFLICT(book_id, key) DO UPDATE ... WHERE (book_settings.updated_at, book_settings.updated_by_device) < (excluded.updated_at, excluded.updated_by_device)` | tuple |
| 36 | 1878-1883 | `book_settings` | `setting.set`, per-book delete arm (`(Some, None)`) | `DELETE FROM book_settings WHERE book_id = ?1 AND key = ?2 AND updated_at <= ?3` | **bare** |
| 37 | 1892-1895 | `settings` | `setting.set`, global delete arm (`(None, None)`) | `DELETE FROM settings WHERE key = ?1 AND updated_at <= ?2` | **bare** |

**Class counts (37 SQL-reachable predicate sites):**

| Class | Count | Line #s |
|---|---|---|
| `tuple` | 6 | 20, 21, 27, 29, 33, 35 |
| `longhand` | 18 | 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 23, 24, 25, 26, 28 |
| `bare` | 5 | 5, 6, 22, 36, 37 |
| `other` | 8 | 1, 2, 3, 4, 30, 31, 32, 34 |

**Non-SQL, in-memory Rust tuple comparisons found while reading the file** (not `WHERE`/`ON CONFLICT` SQL text, so not counted in the table above, but they are conflict-resolution predicates over the same `(updated_at, updated_by_device)` shape and are noted for completeness per the task's opening sentence):

- Line 1121-1122, `reconcile_legacy_word_mark_exceptions`: `(current.updated_at, current.updated_by_device.as_str()) < (row.updated_at, row.updated_by_device.as_str())` — dedup between a legacy and canonical `word_mark_exceptions` row during id migration.
- Line 1139-1146 / 1170, same function: `row_tuple < barrier` / `row_tuple == barrier` — barrier compare against the caller-supplied `(barrier_ts, barrier_device)`.
- Line 1293-1297, `apply_word_mark_delete`: `(*ts, device.as_str()) > (event.ts, event.device.as_str())` — guards the legacy-delete compat arm.
- Line 1342-1346, `apply_word_mark_exception_set`: `(ts, device.as_str()) > (event.ts, event.device.as_str())` — decides whether to reproduce the parent-barrier row.
- Line 1776-1781, `apply_custom_font_delete`: `(*ts, device.as_str()) > (event.ts, event.device.as_str())` — guards whether a delete is allowed to proceed.

All five of these use the full `(updated_at, updated_by_device)` tuple — none are bare.

**Note on lines 5, 6 (`book_settings`/`settings` `bare` deletes inside `cascade_delete`):** grepped their callers — `cascade_delete(tx, entity::BOOK_SETTING, ...)` and `cascade_delete(tx, entity::SETTING, ...)` are invoked only from `src/sync/snapshot/apply.rs:362` (the snapshot-tombstone ingest pass), never from `merge::apply_event`. The event-log delete path for the same two tables goes through `apply_setting_set`'s own inline `DELETE` statements (lines 36, 37 in this table, at merge.rs:1881/1893), which **are** reachable through `apply_event`.

**Schema check backing row 22's note** (`book_summaries` has no device column):
```sql
-- migrations/023_ai_grounding.sql
CREATE TABLE IF NOT EXISTS book_summaries (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL,
  scope         TEXT NOT NULL,
  section_index INTEGER,
  section_title TEXT,
  content       TEXT NOT NULL,
  language      TEXT NOT NULL,
  model         TEXT,
  source_sha256 TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
-- migrations/025_index_management.sql adds `user_edited`, still no device column
```
`BookSummaryPayload` (src/sync/events.rs:654-668) likewise has no `updated_by_device` field.

---

## PART B — dynamic convergence test

### Tables tested

- `book_summaries` — `bare` (row 22), real content-bearing upsert, reachable via `apply_event`.
- `book_settings` — `bare` (row 36), the delete arm of `apply_setting_set`, reachable via `apply_event`.
- `settings` — `bare` (row 37), the delete arm of `apply_setting_set`, reachable via `apply_event`.
- `custom_fonts` — **control**, `tuple` (row 29), reachable via `apply_event`.

### Tables classified `bare` but NOT dynamically tested, and why

- `book_settings` / `settings` rows 5 and 6 (the `cascade_delete` branches at merge.rs:315/329): as noted above, these are reached only from `snapshot/apply.rs`'s tombstone-replay pass, not from `merge::apply_event`. The task's dynamic-test shape (`apply_event` in order A→B vs B→A on two competing sync events) does not apply to a snapshot-tombstone sweep. Not run.

### Schema/helper reuse

The temporary test reused the exact `open_db()` / `ev()` / `apply_all()` / `import_book()` pattern already used by `merge.rs`'s own `#[cfg(test)] mod tests` (visible at merge.rs:1901-2099): open an in-memory `rusqlite::Connection`, run `crate::db::Db::run_migrations_on`, toggle `PRAGMA foreign_keys` the same way, and drive everything through the real `crate::sync::merge::apply_event` — no hand-written SQL predicate was reimplemented.

One compile-time constraint surfaced during setup: `sync::validation::validate_peer_device` requires the device string to either parse as a UUID or (under `#[cfg(test)]`) start with `"dev-"` / `"peer-"` / equal `"self"`. The task's suggested device names `"device-aaa"` / `"device-zzz"` do not start with `"dev-"` (they start with `"device-"`, which does happen to also start with `"dev-"` as a substring check would show — but see below) and in fact `"device-aaa".starts_with("dev-")` is true. On reflection this was not the blocker; the actual failure hit first was `SYNC_EVENT_ENVELOPE_INVALID` from a malformed synthetic ULID in the event `id` field (25 characters instead of the required 26 for `ulid::Ulid::parse`). Fixed by matching the exact 26-character zero-padded pattern already used in `merge.rs`'s own test helper. Device strings used were `"dev-aaa"` and `"dev-zzz"` (lexicographically `dev-aaa < dev-zzz`), which do satisfy the `#[cfg(test)]` allowance.

### Full source of the temporary test file (`src-tauri/src/sync/tmp_lww_probe.rs`)

```rust
//! TEMPORARY convergence probe — item 3 of the automation review
//! (docs/impls/automation-review). NOT part of the permanent test suite.
//! Delete this file and its `mod tmp_lww_probe;` registration in
//! `sync/mod.rs` once the evidence has been captured.
#![cfg(test)]

use rusqlite::Connection;

use crate::db::Db;
use crate::sync::events::*;
use crate::sync::merge::apply_event;

fn open_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    Db::run_migrations_on(&conn).unwrap();
    conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
    conn
}

fn ev(seq: u32, ts: i64, device: &str, body: EventBody) -> Event {
    Event {
        id: format!("01HYZX00000000000000{seq:06X}"),
        ts,
        device: device.to_string(),
        v: EVENT_SCHEMA_VERSION,
        body,
        extra: serde_json::Map::new(),
    }
}

fn apply_all(conn: &mut Connection, events: &[Event]) {
    let tx = conn.transaction().unwrap();
    for e in events {
        apply_event(&tx, e).expect("apply_event failed");
    }
    tx.commit().unwrap();
}

fn import_book(id: &str) -> EventBody {
    EventBody::BookImport(BookImportPayload {
        id: id.into(),
        title: "T".into(),
        author: "A".into(),
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

/// Apply `event_a` then `event_b` into one fresh db, and `event_b` then
/// `event_a` into another fresh db, using the real `apply_event` entry
/// point. `setup` seeds any parent rows (e.g. a book) each fresh db needs
/// before the race. `read` extracts a printable snapshot of the row(s)
/// under test.
fn probe(
    setup: impl Fn(&mut Connection),
    event_a: Event,
    event_b: Event,
    read: impl Fn(&Connection) -> String,
) -> (String, String) {
    let mut conn_ab = open_db();
    setup(&mut conn_ab);
    apply_all(&mut conn_ab, &[event_a.clone(), event_b.clone()]);
    let row_ab = read(&conn_ab);

    let mut conn_ba = open_db();
    setup(&mut conn_ba);
    apply_all(&mut conn_ba, &[event_b, event_a]);
    let row_ba = read(&conn_ba);

    (row_ab, row_ba)
}

fn report(table: &str, case: &str, event_a: &Event, event_b: &Event, row_ab: &str, row_ba: &str) {
    let converged = row_ab == row_ba;
    println!("\n=== table={table} case={case} ===");
    println!(
        "  event A: ts={} device={:?} body={:?}",
        event_a.ts, event_a.device, event_a.body
    );
    println!(
        "  event B: ts={} device={:?} body={:?}",
        event_b.ts, event_b.device, event_b.body
    );
    println!("  A->B final row: {row_ab}");
    println!("  B->A final row: {row_ba}");
    println!(
        "  RESULT: {}",
        if converged { "CONVERGED" } else { "DIVERGED" }
    );
}

// ---------------------------------------------------------------------------
// book_summaries — classified `bare`: `WHERE book_summaries.updated_at <
// excluded.updated_at`, no device column at all in the table.
// ---------------------------------------------------------------------------

fn book_summary_event(seq: u32, ts: i64, device: &str, content: &str) -> Event {
    ev(
        seq,
        ts,
        device,
        EventBody::BookSummaryUpsert(BookSummaryPayload {
            id: format!("summary-{device}-{ts}"),
            book_id: "b1".into(),
            scope: "book".into(),
            section_index: None,
            section_title: None,
            content: content.into(),
            language: "en".into(),
            model: None,
            source_sha256: "hash".into(),
            created_at: ts,
            updated_at: ts,
            user_edited: false,
        }),
    )
}

fn read_book_summary(conn: &Connection) -> String {
    conn.query_row(
        "SELECT content, updated_at FROM book_summaries WHERE book_id='b1' AND scope='book'",
        [],
        |r| {
            Ok(format!(
                "content={:?} updated_at={:?}",
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?
            ))
        },
    )
    .unwrap_or_else(|e| format!("<no row: {e}>"))
}

fn seed_book(conn: &mut Connection) {
    apply_all(conn, &[ev(0, 1, "dev-aaa", import_book("b1"))]);
}

#[test]
fn probe_book_summaries() {
    let cases: &[(u32, i64, &str, &str)] = &[
        (1, 5000, "Summary content AAA", "Summary content ZZZ"),
        (2, 6000, "Version-one text", "Version-two text"),
        (3, 7000, "Alpha summary", "Zulu summary"),
    ];
    for (seq, ts, content_a, content_b) in cases {
        let a = book_summary_event(seq * 10 + 1, *ts, "dev-aaa", content_a);
        let b = book_summary_event(seq * 10 + 2, *ts, "dev-zzz", content_b);
        let (row_ab, row_ba) = probe(seed_book, a.clone(), b.clone(), read_book_summary);
        report(
            "book_summaries",
            &format!("same-ms pair ts={ts}"),
            &a,
            &b,
            &row_ab,
            &row_ba,
        );
    }

    // 1ms-apart sanity check: normal LWW (by timestamp alone) should still
    // hold regardless of arrival order.
    let a = book_summary_event(901, 8000, "dev-aaa", "Old summary (ts=8000)");
    let b = book_summary_event(902, 8001, "dev-zzz", "New summary (ts=8001)");
    let (row_ab, row_ba) = probe(seed_book, a.clone(), b.clone(), read_book_summary);
    report(
        "book_summaries",
        "sanity: 1ms apart (8000 vs 8001)",
        &a,
        &b,
        &row_ab,
        &row_ba,
    );
}

// ---------------------------------------------------------------------------
// book_settings — classified `bare` on the delete arm of `apply_setting_set`:
// `DELETE FROM book_settings WHERE book_id=?1 AND key=?2 AND updated_at<=?3`
// compares only `updated_at`, no device. Race a SET against a DELETE for the
// same (book_id, key) at the same millisecond.
// ---------------------------------------------------------------------------

fn book_setting_set_event(seq: u32, ts: i64, device: &str, value: &str) -> Event {
    ev(
        seq,
        ts,
        device,
        EventBody::SettingSet(SettingPayload {
            book: Some("b1".into()),
            key: "font".into(),
            value: Some(value.into()),
        }),
    )
}

fn book_setting_delete_event(seq: u32, ts: i64, device: &str) -> Event {
    ev(
        seq,
        ts,
        device,
        EventBody::SettingSet(SettingPayload {
            book: Some("b1".into()),
            key: "font".into(),
            value: None,
        }),
    )
}

fn read_book_setting(conn: &Connection) -> String {
    let row: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT value, updated_at, updated_by_device FROM book_settings WHERE book_id='b1' AND key='font'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let tombstoned: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM _tombstones WHERE entity='book_setting' AND id='b1:font')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    match row {
        Some((v, ts, dev)) => format!("value={v:?} updated_at={ts} device={dev:?} tombstoned={tombstoned}"),
        None => format!("<no row> tombstoned={tombstoned}"),
    }
}

#[test]
fn probe_book_settings() {
    struct Case {
        label: &'static str,
        ts: i64,
        set_device: &'static str,
        set_value: &'static str,
        delete_device: &'static str,
    }
    let cases = [
        Case {
            label: "smaller device sets, larger device deletes",
            ts: 5000,
            set_device: "dev-aaa",
            set_value: "courier",
            delete_device: "dev-zzz",
        },
        Case {
            label: "larger device sets, smaller device deletes",
            ts: 5100,
            set_device: "dev-zzz",
            set_value: "georgia",
            delete_device: "dev-aaa",
        },
        Case {
            label: "smaller device sets a different value, larger device deletes",
            ts: 5200,
            set_device: "dev-aaa",
            set_value: "helvetica",
            delete_device: "dev-zzz",
        },
    ];
    for (i, c) in cases.iter().enumerate() {
        let set_ev = book_setting_set_event((i as u32) * 10 + 1, c.ts, c.set_device, c.set_value);
        let del_ev = book_setting_delete_event((i as u32) * 10 + 2, c.ts, c.delete_device);
        let (row_ab, row_ba) = probe(seed_book, set_ev.clone(), del_ev.clone(), read_book_setting);
        report("book_settings", c.label, &set_ev, &del_ev, &row_ab, &row_ba);
    }

    // 1ms-apart sanity: delete strictly newer than the set should always win.
    let set_ev = book_setting_set_event(901, 6000, "dev-aaa", "courier");
    let del_ev = book_setting_delete_event(902, 6001, "dev-zzz");
    let (row_ab, row_ba) = probe(seed_book, set_ev.clone(), del_ev.clone(), read_book_setting);
    report(
        "book_settings",
        "sanity: set@6000 vs delete@6001 (1ms apart)",
        &set_ev,
        &del_ev,
        &row_ab,
        &row_ba,
    );
}

// ---------------------------------------------------------------------------
// settings (global) — same shape as book_settings but the un-scoped table:
// `DELETE FROM settings WHERE key=?1 AND updated_at<=?2`, bare.
// ---------------------------------------------------------------------------

fn global_setting_set_event(seq: u32, ts: i64, device: &str, value: &str) -> Event {
    ev(
        seq,
        ts,
        device,
        EventBody::SettingSet(SettingPayload {
            book: None,
            key: "font_family".into(),
            value: Some(value.into()),
        }),
    )
}

fn global_setting_delete_event(seq: u32, ts: i64, device: &str) -> Event {
    ev(
        seq,
        ts,
        device,
        EventBody::SettingSet(SettingPayload {
            book: None,
            key: "font_family".into(),
            value: None,
        }),
    )
}

fn read_global_setting(conn: &Connection) -> String {
    let row: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT value, updated_at, updated_by_device FROM settings WHERE key='font_family'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let tombstoned: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM _tombstones WHERE entity='setting' AND id='font_family')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    match row {
        Some((v, ts, dev)) => format!("value={v:?} updated_at={ts} device={dev:?} tombstoned={tombstoned}"),
        None => format!("<no row> tombstoned={tombstoned}"),
    }
}

#[test]
fn probe_settings_global() {
    struct Case {
        label: &'static str,
        ts: i64,
        set_device: &'static str,
        set_value: &'static str,
        delete_device: &'static str,
    }
    let cases = [
        Case {
            label: "smaller device sets, larger device deletes",
            ts: 7000,
            set_device: "dev-aaa",
            set_value: "literata",
            delete_device: "dev-zzz",
        },
        Case {
            label: "larger device sets, smaller device deletes",
            ts: 7100,
            set_device: "dev-zzz",
            set_value: "georgia",
            delete_device: "dev-aaa",
        },
        Case {
            label: "smaller device sets a different value, larger device deletes",
            ts: 7200,
            set_device: "dev-aaa",
            set_value: "system-serif",
            delete_device: "dev-zzz",
        },
    ];
    for (i, c) in cases.iter().enumerate() {
        let set_ev = global_setting_set_event((i as u32) * 10 + 1, c.ts, c.set_device, c.set_value);
        let del_ev = global_setting_delete_event((i as u32) * 10 + 2, c.ts, c.delete_device);
        let (row_ab, row_ba) = probe(|_| {}, set_ev.clone(), del_ev.clone(), read_global_setting);
        report("settings", c.label, &set_ev, &del_ev, &row_ab, &row_ba);
    }

    let set_ev = global_setting_set_event(901, 8000, "dev-aaa", "literata");
    let del_ev = global_setting_delete_event(902, 8001, "dev-zzz");
    let (row_ab, row_ba) = probe(|_| {}, set_ev.clone(), del_ev.clone(), read_global_setting);
    report(
        "settings",
        "sanity: set@8000 vs delete@8001 (1ms apart)",
        &set_ev,
        &del_ev,
        &row_ab,
        &row_ba,
    );
}

// ---------------------------------------------------------------------------
// custom_fonts — CONTROL, classified `tuple`:
// `WHERE (custom_fonts.updated_at, custom_fonts.updated_by_device) <
//  (excluded.updated_at, excluded.updated_by_device)`
// ---------------------------------------------------------------------------

fn custom_font_event(seq: u32, ts: i64, device: &str, family_name: &str) -> Event {
    ev(
        seq,
        ts,
        device,
        EventBody::CustomFontUpsert(CustomFontPayload {
            id: "custom-abc123".into(),
            family_name: family_name.into(),
            file_name: "abc123.ttf".into(),
            format: "ttf".into(),
            file_size: 1024,
            created_at: ts,
        }),
    )
}

fn read_custom_font(conn: &Connection) -> String {
    conn.query_row(
        "SELECT family_name, updated_at, updated_by_device FROM custom_fonts WHERE id='custom-abc123'",
        [],
        |r| {
            Ok(format!(
                "family_name={:?} updated_at={:?} device={:?}",
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?
            ))
        },
    )
    .unwrap_or_else(|e| format!("<no row: {e}>"))
}

#[test]
fn probe_custom_fonts_control() {
    let cases: &[(u32, i64, &str, &str)] = &[
        (1, 9000, "Family AAA", "Family ZZZ"),
        (2, 9100, "Roboto-ish", "Robotoy"),
        (3, 9200, "Serif A", "Serif Z"),
    ];
    for (seq, ts, name_a, name_b) in cases {
        let a = custom_font_event(seq * 10 + 1, *ts, "dev-aaa", name_a);
        let b = custom_font_event(seq * 10 + 2, *ts, "dev-zzz", name_b);
        let (row_ab, row_ba) = probe(|_| {}, a.clone(), b.clone(), read_custom_font);
        report(
            "custom_fonts (control, tuple)",
            &format!("same-ms pair ts={ts}"),
            &a,
            &b,
            &row_ab,
            &row_ba,
        );
    }

    let a = custom_font_event(901, 10_000, "dev-aaa", "Old Family (ts=10000)");
    let b = custom_font_event(902, 10_001, "dev-zzz", "New Family (ts=10001)");
    let (row_ab, row_ba) = probe(|_| {}, a.clone(), b.clone(), read_custom_font);
    report(
        "custom_fonts (control, tuple)",
        "sanity: 1ms apart (10000 vs 10001)",
        &a,
        &b,
        &row_ab,
        &row_ba,
    );
}
```

Registration added to `src-tauri/src/sync/mod.rs` (removed after this run — see "cleanup" below):

```rust
pub mod snapshot;
#[cfg(test)]
mod tmp_lww_probe;
pub mod validation;
```

### Complete raw stdout of `cargo test --lib sync::tmp_lww_probe -- --nocapture`

The four `#[test]` functions ran as separate threads, so their `println!` output is interleaved in the raw capture below — this is the actual, unedited terminal output, not reordered.

```
   Compiling lantern v2.13.1 (/Users/lijianwei/vibecoding/Lantern/src-tauri)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.40s
     Running unittests src/lib.rs (target/debug/deps/lantern_lib-4e6aedd3f66cd1d0)

running 4 tests

=== table=custom_fonts (control, tuple) case=same-ms pair ts=9000 ===

=== table=book_settings case=smaller device sets, larger device deletes ===
  event A: ts=9000 device="dev-aaa" body=CustomFontUpsert(CustomFontPayload { id: "custom-abc123", family_name: "Family AAA", file_name: "abc123.ttf", format: "ttf", file_size: 1024, created_at: 9000 })
  event B: ts=9000 device="dev-zzz" body=CustomFontUpsert(CustomFontPayload { id: "custom-abc123", family_name: "Family ZZZ", file_name: "abc123.ttf", format: "ttf", file_size: 1024, created_at: 9000 })
  A->B final row: family_name="Family ZZZ" updated_at=9000 device="dev-zzz"
  B->A final row: family_name="Family ZZZ" updated_at=9000 device="dev-zzz"
  RESULT: CONVERGED
  event A: ts=5000 device="dev-aaa" body=SettingSet(SettingPayload { book: Some("b1"), key: "font", value: Some("courier") })
  event B: ts=5000 device="dev-zzz" body=SettingSet(SettingPayload { book: Some("b1"), key: "font", value: None })
  A->B final row: <no row> tombstoned=true
  B->A final row: <no row> tombstoned=true
  RESULT: CONVERGED

=== table=settings case=smaller device sets, larger device deletes ===
  event A: ts=7000 device="dev-aaa" body=SettingSet(SettingPayload { book: None, key: "font_family", value: Some("literata") })
  event B: ts=7000 device="dev-zzz" body=SettingSet(SettingPayload { book: None, key: "font_family", value: None })
  A->B final row: <no row> tombstoned=true
  B->A final row: <no row> tombstoned=true
  RESULT: CONVERGED

=== table=book_summaries case=same-ms pair ts=5000 ===
  event A: ts=5000 device="dev-aaa" body=BookSummaryUpsert(BookSummaryPayload { id: "summary-dev-aaa-5000", book_id: "b1", scope: "book", section_index: None, section_title: None, content: "Summary content AAA", language: "en", model: None, source_sha256: "hash", created_at: 5000, updated_at: 5000, user_edited: false })
  event B: ts=5000 device="dev-zzz" body=BookSummaryUpsert(BookSummaryPayload { id: "summary-dev-zzz-5000", book_id: "b1", scope: "book", section_index: None, section_title: None, content: "Summary content ZZZ", language: "en", model: None, source_sha256: "hash", created_at: 5000, updated_at: 5000, user_edited: false })
  A->B final row: content="Summary content AAA" updated_at=5000
  B->A final row: content="Summary content ZZZ" updated_at=5000
  RESULT: DIVERGED

=== table=custom_fonts (control, tuple) case=same-ms pair ts=9100 ===
  event A: ts=9100 device="dev-aaa" body=CustomFontUpsert(CustomFontPayload { id: "custom-abc123", family_name: "Roboto-ish", file_name: "abc123.ttf", format: "ttf", file_size: 1024, created_at: 9100 })
  event B: ts=9100 device="dev-zzz" body=CustomFontUpsert(CustomFontPayload { id: "custom-abc123", family_name: "Robotoy", file_name: "abc123.ttf", format: "ttf", file_size: 1024, created_at: 9100 })
  A->B final row: family_name="Robotoy" updated_at=9100 device="dev-zzz"
  B->A final row: family_name="Robotoy" updated_at=9100 device="dev-zzz"
  RESULT: CONVERGED

=== table=book_settings case=larger device sets, smaller device deletes ===
  event A: ts=5100 device="dev-zzz" body=SettingSet(SettingPayload { book: Some("b1"), key: "font", value: Some("georgia") })
  event B: ts=5100 device="dev-aaa" body=SettingSet(SettingPayload { book: Some("b1"), key: "font", value: None })
  A->B final row: <no row> tombstoned=true
  B->A final row: <no row> tombstoned=true
  RESULT: CONVERGED

=== table=settings case=larger device sets, smaller device deletes ===
  event A: ts=7100 device="dev-zzz" body=SettingSet(SettingPayload { book: None, key: "font_family", value: Some("georgia") })
  event B: ts=7100 device="dev-aaa" body=SettingSet(SettingPayload { book: None, key: "font_family", value: None })
  A->B final row: <no row> tombstoned=true
  B->A final row: <no row> tombstoned=true
  RESULT: CONVERGED

=== table=book_summaries case=same-ms pair ts=6000 ===
  event A: ts=6000 device="dev-aaa" body=BookSummaryUpsert(BookSummaryPayload { id: "summary-dev-aaa-6000", book_id: "b1", scope: "book", section_index: None, section_title: None, content: "Version-one text", language: "en", model: None, source_sha256: "hash", created_at: 6000, updated_at: 6000, user_edited: false })
  event B: ts=6000 device="dev-zzz" body=BookSummaryUpsert(BookSummaryPayload { id: "summary-dev-zzz-6000", book_id: "b1", scope: "book", section_index: None, section_title: None, content: "Version-two text", language: "en", model: None, source_sha256: "hash", created_at: 6000, updated_at: 6000, user_edited: false })
  A->B final row: content="Version-one text" updated_at=6000
  B->A final row: content="Version-two text" updated_at=6000
  RESULT: DIVERGED

=== table=custom_fonts (control, tuple) case=same-ms pair ts=9200 ===
  event A: ts=9200 device="dev-aaa" body=CustomFontUpsert(CustomFontPayload { id: "custom-abc123", family_name: "Serif A", file_name: "abc123.ttf", format: "ttf", file_size: 1024, created_at: 9200 })
  event B: ts=9200 device="dev-zzz" body=CustomFontUpsert(CustomFontPayload { id: "custom-abc123", family_name: "Serif Z", file_name: "abc123.ttf", format: "ttf", file_size: 1024, created_at: 9200 })
  A->B final row: family_name="Serif Z" updated_at=9200 device="dev-zzz"
  B->A final row: family_name="Serif Z" updated_at=9200 device="dev-zzz"
  RESULT: CONVERGED

=== table=settings case=smaller device sets a different value, larger device deletes ===
  event A: ts=7200 device="dev-aaa" body=SettingSet(SettingPayload { book: None, key: "font_family", value: Some("system-serif") })
  event B: ts=7200 device="dev-zzz" body=SettingSet(SettingPayload { book: None, key: "font_family", value: None })
  A->B final row: <no row> tombstoned=true
  B->A final row: <no row> tombstoned=true
  RESULT: CONVERGED

=== table=book_settings case=smaller device sets a different value, larger device deletes ===
  event A: ts=5200 device="dev-aaa" body=SettingSet(SettingPayload { book: Some("b1"), key: "font", value: Some("helvetica") })
  event B: ts=5200 device="dev-zzz" body=SettingSet(SettingPayload { book: Some("b1"), key: "font", value: None })
  A->B final row: <no row> tombstoned=true
  B->A final row: <no row> tombstoned=true
  RESULT: CONVERGED

=== table=book_summaries case=same-ms pair ts=7000 ===
  event A: ts=7000 device="dev-aaa" body=BookSummaryUpsert(BookSummaryPayload { id: "summary-dev-aaa-7000", book_id: "b1", scope: "book", section_index: None, section_title: None, content: "Alpha summary", language: "en", model: None, source_sha256: "hash", created_at: 7000, updated_at: 7000, user_edited: false })
  event B: ts=7000 device="dev-zzz" body=BookSummaryUpsert(BookSummaryPayload { id: "summary-dev-zzz-7000", book_id: "b1", scope: "book", section_index: None, section_title: None, content: "Zulu summary", language: "en", model: None, source_sha256: "hash", created_at: 7000, updated_at: 7000, user_edited: false })
  A->B final row: content="Alpha summary" updated_at=7000
  B->A final row: content="Zulu summary" updated_at=7000
  RESULT: DIVERGED

=== table=custom_fonts (control, tuple) case=sanity: 1ms apart (10000 vs 10001) ===
  event A: ts=10000 device="dev-aaa" body=CustomFontUpsert(CustomFontPayload { id: "custom-abc123", family_name: "Old Family (ts=10000)", file_name: "abc123.ttf", format: "ttf", file_size: 1024, created_at: 10000 })
  event B: ts=10001 device="dev-zzz" body=CustomFontUpsert(CustomFontPayload { id: "custom-abc123", family_name: "New Family (ts=10001)", file_name: "abc123.ttf", format: "ttf", file_size: 1024, created_at: 10001 })
  A->B final row: family_name="New Family (ts=10001)" updated_at=10001 device="dev-zzz"
  B->A final row: family_name="New Family (ts=10001)" updated_at=10001 device="dev-zzz"
  RESULT: CONVERGED
test sync::tmp_lww_probe::probe_custom_fonts_control ... ok

=== table=book_settings case=sanity: set@6000 vs delete@6001 (1ms apart) ===
  event A: ts=6000 device="dev-aaa" body=SettingSet(SettingPayload { book: Some("b1"), key: "font", value: Some("courier") })
  event B: ts=6001 device="dev-zzz" body=SettingSet(SettingPayload { book: Some("b1"), key: "font", value: None })
  A->B final row: <no row> tombstoned=true
  B->A final row: <no row> tombstoned=true
  RESULT: CONVERGED
test sync::tmp_lww_probe::probe_book_settings ... ok

=== table=settings case=sanity: set@8000 vs delete@8001 (1ms apart) ===
  event A: ts=8000 device="dev-aaa" body=SettingSet(SettingPayload { book: None, key: "font_family", value: Some("literata") })
  event B: ts=8001 device="dev-zzz" body=SettingSet(SettingPayload { book: None, key: "font_family", value: None })
  A->B final row: <no row> tombstoned=true
  B->A final row: <no row> tombstoned=true
  RESULT: CONVERGED
test sync::tmp_lww_probe::probe_settings_global ... ok

=== table=book_summaries case=sanity: 1ms apart (8000 vs 8001) ===
  event A: ts=8000 device="dev-aaa" body=BookSummaryUpsert(BookSummaryPayload { id: "summary-dev-aaa-8000", book_id: "b1", scope: "book", section_index: None, section_title: None, content: "Old summary (ts=8000)", language: "en", model: None, source_sha256: "hash", created_at: 8000, updated_at: 8000, user_edited: false })
  event B: ts=8001 device="dev-zzz" body=BookSummaryUpsert(BookSummaryPayload { id: "summary-dev-zzz-8001", book_id: "b1", scope: "book", section_index: None, section_title: None, content: "New summary (ts=8001)", language: "en", model: None, source_sha256: "hash", created_at: 8001, updated_at: 8001, user_edited: false })
  A->B final row: content="New summary (ts=8001)" updated_at=8001
  B->A final row: content="New summary (ts=8001)" updated_at=8001
  RESULT: CONVERGED
test sync::tmp_lww_probe::probe_book_summaries ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 1489 filtered out; finished in 1.59s
```

(All 4 `#[test]` functions report `... ok` because the test bodies only print CONVERGED/DIVERGED — they contain no `assert!`. Pass/fail of the Rust test itself is not a claim about convergence; the CONVERGED/DIVERGED lines above are the actual per-case result.)

### Cleanup performed after this run

- Deleted `src-tauri/src/sync/tmp_lww_probe.rs`.
- Removed the `#[cfg(test)] mod tmp_lww_probe;` line from `src-tauri/src/sync/mod.rs`.
- Verified `git status --porcelain` in `/Users/lijianwei/vibecoding/Lantern` shows no diff in `src-tauri/src/sync/mod.rs` and no `tmp_lww_probe.rs` file, and shows this evidence file as the only new path under `docs/`.
