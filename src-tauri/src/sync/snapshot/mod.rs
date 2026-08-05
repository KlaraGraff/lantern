//! Snapshots — frozen materialized state of one peer's log, used for both
//! compaction (own log → snapshot) and bootstrap (peer snapshot → local DB).
//!
//! A snapshot is a JSON file at `<shared>/logs/<device>.snapshot.json` with
//! the shape:
//!
//! ```jsonc
//! {
//!   "v": 3,
//!   "device": "<uuid>",
//!   "id": "<latest event ULID included>",
//!   "generated_at": <unix millis>,
//!   "truncated_before": "<event id>" | null,   // null for migration snapshots
//!   "state": { "books": {...}, "highlights": {...}, ..., "tombstones": {...} }
//! }
//! ```
//!
//! `apply_peer` is the inverse: ingest a peer's snapshot into local SQLite
//! under the same merge rules as `merge::apply_event`. Per-row LWW (compare
//! `(updated_at, updated_by_device)` tuples), tombstones win over inserts,
//! `_replay_state` watermarks are updated monotonically. See Step 6 of
//! `docs/impls/sync/31-sync.md` for the apply procedure.

mod apply;
mod compact;
mod rows;

pub use compact::{compact_own_log, should_compact};
pub use rows::*;

/// Compaction is triggered when the log crosses any of these
/// thresholds. The numbers are the spec's defaults — small enough
/// that a chatty session doesn't bloat the log, large enough that
/// a casual reader almost never trips compaction inside a single
/// session.
pub const COMPACT_LOG_BYTE_THRESHOLD: u64 = 2 * 1024 * 1024; // 2 MB
pub const COMPACT_LOG_EVENT_THRESHOLD: usize = 5_000;
pub const COMPACT_AGE_THRESHOLD_MS: i64 = 30 * 24 * 60 * 60 * 1_000; // 30 days

/// Version 8 matched the `v < 8` guard in `Snapshot::apply_peer`, which rejects
/// a snapshot carrying `custom_fonts`, `settings`, or `book_settings`. The guard
/// shipped with those tables but this constant stayed at 7, so every snapshot
/// that build wrote containing any of them was rejected by every peer —
/// including a later build of itself. Nothing had noticed because those rows
/// also travel as events, on the separate `EVENT_SCHEMA_VERSION` counter.
///
/// Version 9 adds the `setting` tombstone entity. A build reading at 8 does not
/// know the entity name and rejects the whole snapshot in
/// `validate_tombstone_entity`; moving the constant makes it reject the envelope
/// up front instead, which is the same outcome named honestly.
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 9;
pub const MIN_SUPPORTED_SNAPSHOT_SCHEMA_VERSION: u32 = 1;
pub const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;

#[cfg(test)]
mod tests;
