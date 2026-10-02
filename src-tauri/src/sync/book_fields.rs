use std::collections::BTreeMap;

use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};

use super::events::EventBody;
use crate::error::{AppError, AppResult};

pub const FIELDS: &[&str] = &[
    "title",
    "author",
    "description",
    "cover_path",
    "genre",
    "pages",
    "source",
    "progress",
    "status",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct FieldClock {
    pub updated_at: i64,
    pub updated_by_device: String,
}

pub fn group(field: &str) -> &str {
    if field == "file_path" {
        "source"
    } else {
        field
    }
}

pub fn load(conn: &Connection, book: &str) -> AppResult<BTreeMap<String, FieldClock>> {
    let mut stmt = conn.prepare(
        "SELECT field, updated_at, updated_by_device FROM book_field_clocks WHERE book_id = ?1",
    )?;
    let rows = stmt
        .query_map([book], |row| {
            Ok((
                row.get(0)?,
                FieldClock {
                    updated_at: row.get(1)?,
                    updated_by_device: row.get(2)?,
                },
            ))
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn wins(tx: &Transaction, book: &str, field: &str, ts: i64, device: &str) -> AppResult<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM book_field_clocks WHERE book_id = ?1 AND field = ?2
         AND (updated_at, updated_by_device) < (?3, ?4))",
        params![book, group(field), ts, device],
        |row| row.get(0),
    )?)
}

pub fn stamp(tx: &Transaction, book: &str, field: &str, ts: i64, device: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE book_field_clocks SET updated_at = ?3, updated_by_device = ?4
         WHERE book_id = ?1 AND field = ?2",
        params![book, group(field), ts, device],
    )?;
    // This row clock remains useful for sorting, but arbitrates no book field.
    tx.execute(
        "UPDATE books SET updated_at = ?2, updated_by_device = ?3 WHERE id = ?1
         AND (updated_at, updated_by_device) < (?2, ?3)",
        params![book, ts, device],
    )?;
    Ok(())
}

pub fn stamp_local_event(
    tx: &Transaction,
    body: &EventBody,
    ts: i64,
    device: &str,
) -> AppResult<()> {
    match body {
        EventBody::BookProgressSet { book, .. } => stamp(tx, book, "progress", ts, device),
        EventBody::BookStatusSet { book, .. } => stamp(tx, book, "status", ts, device),
        EventBody::BookMetadataSet { book, field, .. } => stamp(tx, book, field, ts, device),
        _ => Ok(()),
    }
}

pub fn validate(clocks: &BTreeMap<String, FieldClock>) -> AppResult<()> {
    if clocks.len() != FIELDS.len() || FIELDS.iter().any(|field| !clocks.contains_key(*field)) {
        return Err(AppError::Other("SYNC_SNAPSHOT_BOOK_CLOCKS_INVALID".into()));
    }
    for clock in clocks.values() {
        super::validation::ensure_valid_sync_timestamp(
            clock.updated_at,
            "SYNC_SNAPSHOT_BOOK_CLOCKS_INVALID",
        )?;
    }
    Ok(())
}
