//! Deterministic per-event merge.
//!
//! `apply_event(tx, event)` folds one peer event into the local SQLite
//! materialized view. Three rules:
//!
//! 1. **Add events** (`*.add`, `*.create`, `*.import`) use `INSERT OR IGNORE`
//!    and are guarded by a tombstone check on the entity's id. Once a row is
//!    deleted, a later add with the same id never resurrects it — the user
//!    must mint a new id.
//! 2. **LWW updates** (`*.set`, `*.rename`, `*.color.set`, …) compare the
//!    tuple `(stored.updated_at, stored.updated_by_device)` against
//!    `(event.ts, event.device)`. Strict-less-than wins; equality means we've
//!    already applied this exact write. The compare lives in the `WHERE`
//!    clause so SQLite skips the row in one statement.
//! 3. **Deletes** drop the row plus all children manually (explicit
//!    cascading — the app does not rely on `ON DELETE CASCADE`),
//!    then `INSERT OR IGNORE` a tombstone keyed `(entity, id)`.
//! 4. **Appends** (`vocab.review.append`) also use `INSERT OR IGNORE` behind a
//!    tombstone check, but for a different reason than rule 1: the row records
//!    something that happened rather than something that is true, so two
//!    devices can never be describing the same fact differently. There is no
//!    tuple to compare and no loser to discard — `INSERT OR IGNORE` buys
//!    idempotence only.
//!
//! Foreign keys are off at the connection level (the app never enables
//! `PRAGMA foreign_keys`). All cascading deletes are explicit. This
//! means cross-device ordering can safely deliver a child event before
//! its parent — the orphan row lands and becomes visible once the
//! parent arrives on a later tick.

use std::collections::BTreeMap;

use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::Value;

use crate::error::{AppError, AppResult};

use super::events::{
    word_mark_exception_id, AutoHighlightDismissalPayload, BookAssetPayload, BookImportPayload,
    BookSummaryPayload, BookmarkPayload, ChatMessagePayload, CustomFontPayload, Event, EventBody,
    HighlightPayload, LookupOccurrenceMarkPayload, NotePayload, SettingPayload, VocabPayload,
    VocabReviewLogPayload, WordMarkExceptionPayload, WordMarkPayload,
};

/// Fold `event` into `tx`. Idempotent — applying the same event twice is a
/// no-op (LWW equality and `INSERT OR IGNORE` both short-circuit).
pub fn apply_event(tx: &Transaction, event: &Event) -> AppResult<()> {
    super::validation::validate_event(event, &event.device)?;
    match &event.body {
        EventBody::BookImport(p) => apply_book_import(tx, event, p),
        EventBody::BookDelete { id } => apply_book_delete(tx, event, id),
        EventBody::BookAssetPublish(p) => apply_book_asset_publish(tx, event, p),
        EventBody::BookAssetDelete { id } => apply_book_asset_delete(tx, event, id),
        EventBody::BookProgressSet {
            book,
            progress,
            cfi,
        } => apply_book_progress(tx, event, book, *progress, cfi.as_deref()),
        EventBody::BookStatusSet { book, status } => apply_book_status(tx, event, book, status),
        EventBody::BookMetadataSet { book, field, value } => {
            apply_book_metadata(tx, event, book, field, value)
        }

        EventBody::HighlightAdd(p) => apply_highlight_add(tx, event, p),
        EventBody::HighlightDelete { id } => apply_highlight_delete(tx, event, id),
        EventBody::HighlightColorSet { id, color } => apply_highlight_color(tx, event, id, color),
        // Legacy no-op — see `EventBody::HighlightNoteSet`.
        EventBody::HighlightNoteSet { .. } => Ok(()),

        EventBody::BookmarkAdd(p) => apply_bookmark_add(tx, event, p),
        EventBody::BookmarkDelete { id } => apply_bookmark_delete(tx, event, id),

        EventBody::VocabAdd(p) => apply_vocab_add(tx, event, p),
        EventBody::VocabMasterySet {
            id,
            mastery,
            next_review_at,
            review_count,
            review_interval_days,
            last_reviewed_at,
            last_review_rating,
            fsrs_stability,
            fsrs_difficulty,
            fsrs_version,
            mastery_source,
            mastery_reason,
        } => apply_vocab_mastery(
            tx,
            event,
            id,
            VocabMasteryUpdate {
                mastery,
                next_review_at: *next_review_at,
                review_count: *review_count,
                review_interval_days: *review_interval_days,
                last_reviewed_at: *last_reviewed_at,
                last_review_rating: last_review_rating.as_deref(),
                fsrs_stability: *fsrs_stability,
                fsrs_difficulty: *fsrs_difficulty,
                fsrs_version: *fsrs_version,
                mastery_source,
                mastery_reason: mastery_reason.as_deref(),
            },
        ),
        EventBody::VocabDelete { id } => apply_vocab_delete(tx, event, id),
        EventBody::VocabListStatusSet {
            id,
            list_status,
            card_snapshot,
        } => apply_vocab_list_status(tx, event, id, list_status, card_snapshot.as_deref()),
        EventBody::VocabDefinitionSet { id, definition } => {
            apply_vocab_definition(tx, event, id, definition)
        }
        EventBody::VocabCardSet {
            id,
            definition,
            context_explanation,
            card_snapshot,
        } => apply_vocab_card(
            tx,
            event,
            id,
            definition,
            context_explanation.as_deref(),
            card_snapshot.as_deref(),
        ),
        EventBody::VocabReviewAppend(payload) => apply_vocab_review_append(tx, event, payload),

        EventBody::NoteUpsert(payload) => apply_note_upsert(tx, event, payload),
        EventBody::NoteDelete { id } => apply_note_delete(tx, event, id),
        EventBody::WordMarkUpsert(payload) => apply_word_mark_upsert(tx, event, payload),
        EventBody::WordMarkDelete { id } => apply_word_mark_delete(tx, event, id),
        EventBody::WordMarkExceptionSet(payload) => {
            apply_word_mark_exception_set(tx, event, payload)
        }
        EventBody::LookupOccurrenceMarkSet(payload) => {
            apply_lookup_occurrence_mark_set(tx, event, payload)
        }
        EventBody::AutoHighlightDismissalSet(payload) => {
            apply_auto_highlight_dismissal_set(tx, event, payload)
        }
        EventBody::BookSummaryUpsert(payload) => apply_book_summary_upsert(tx, event, payload),

        EventBody::TranslationAdd(_) | EventBody::TranslationDelete { .. } => Ok(()),

        EventBody::CollectionCreate {
            id,
            name,
            sort_order,
        } => apply_collection_create(tx, event, id, name, *sort_order),
        EventBody::CollectionRename { id, name } => apply_collection_rename(tx, event, id, name),
        EventBody::CollectionReorder { id, sort_order } => {
            apply_collection_reorder(tx, event, id, *sort_order)
        }
        EventBody::CollectionDelete { id } => apply_collection_delete(tx, event, id),
        EventBody::CollectionBookAdd { collection, book } => {
            apply_collection_book_add(tx, event, collection, book)
        }
        EventBody::CollectionBookRemove { collection, book } => {
            apply_collection_book_remove(tx, event, collection, book)
        }

        EventBody::ChatCreate {
            id,
            book,
            title,
            model,
        } => apply_chat_create(tx, event, id, book, title, model.as_deref()),
        EventBody::ChatRename { id, title } => apply_chat_rename(tx, event, id, title),
        EventBody::ChatDelete { id } => apply_chat_delete(tx, event, id),
        EventBody::ChatMessageAdd(p) => apply_chat_message_add(tx, event, p),
        EventBody::ChatMessageReplace(p) => apply_chat_message_replace(tx, event, p),

        EventBody::CustomFontUpsert(p) => apply_custom_font_upsert(tx, event, p),
        EventBody::CustomFontDelete { id } => apply_custom_font_delete(tx, event, id),
        EventBody::SettingSet(p) => apply_setting_set(tx, event, p),
    }
}

// ---------------------------------------------------------------------------
// Tombstone helpers.
// ---------------------------------------------------------------------------

/// Tombstone entity tags. Stable strings — they appear on disk in
/// `_tombstones.entity` and inside snapshots, so don't rename casually.
pub mod entity {
    pub const BOOK: &str = "book";
    pub const BOOK_ASSET: &str = "book_asset";
    pub const HIGHLIGHT: &str = "highlight";
    /// Legacy tag, kept because it is on disk in old `_tombstones` rows and
    /// inside peer snapshots written before migration 065. Nothing writes it
    /// any more — `insert_tombstone` rewrites it to [`NOTE`], which is what a
    /// bookmark's row became.
    pub const BOOKMARK: &str = "bookmark";
    pub const VOCAB: &str = "vocab";
    pub const NOTE: &str = "note";
    pub const WORD_MARK: &str = "word_mark";
    pub const WORD_MARK_EXCEPTION: &str = "word_mark_exception";
    pub const LOOKUP_OCCURRENCE_MARK: &str = "lookup_occurrence_mark";
    pub const COLLECTION: &str = "collection";
    /// Composite-key entity for `collection_books`. Id format:
    /// `"<collection_id>:<book_id>"`.
    pub const COLLECTION_BOOK: &str = "collection_book";
    pub const CHAT: &str = "chat";
    pub const CHAT_MESSAGE: &str = "chat_message";
    pub const CUSTOM_FONT: &str = "custom_font";
    /// Re-creatable tombstone for one synced per-book setting. Id format:
    /// `"<book_id>:<key>"`.
    pub const BOOK_SETTING: &str = "book_setting";
    /// Re-creatable tombstone for one synced *global* setting. The id is the
    /// bare `settings.key` — global rows have no book to qualify them. Only
    /// whitelisted keys ever get one; `validation::validate_tombstone_id`
    /// enforces that on the way in, because `settings` is also where the
    /// non-synced local preferences live.
    pub const SETTING: &str = "setting";
}

pub fn is_tombstoned(tx: &Transaction, entity: &str, id: &str) -> AppResult<bool> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM _tombstones WHERE entity = ?1 AND id = ?2)",
        params![entity, id],
        |r| r.get(0),
    )?;
    Ok(exists)
}

pub fn tombstone_timestamp(tx: &Transaction, entity: &str, id: &str) -> AppResult<Option<i64>> {
    tx.query_row(
        "SELECT ts FROM _tombstones WHERE entity = ?1 AND id = ?2",
        params![entity, id],
        |row| row.get(0),
    )
    .map(Some)
    .or_else(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.into()),
    })
}

pub fn insert_tombstone(tx: &Transaction, entity: &str, id: &str, ts: i64) -> AppResult<()> {
    // Single choke point for the 065 rename. Old peer logs and old peer
    // snapshots still carry `bookmark` delete markers; migration 065 moved the
    // rows themselves into `notes`, so there is now exactly one question worth
    // asking about that id and it is `('note', id)`. Rewriting here rather than
    // at each caller means the snapshot tombstone pass, the legacy
    // `bookmark.delete` arm, and `cascade_delete` all agree without any of them
    // knowing about the rename.
    let entity = if entity == entity::BOOKMARK {
        entity::NOTE
    } else {
        entity
    };
    tx.execute(
        "INSERT INTO _tombstones (entity, id, ts) VALUES (?1, ?2, ?3)
         ON CONFLICT(entity, id) DO UPDATE SET ts = MAX(_tombstones.ts, excluded.ts)",
        params![entity, id, ts],
    )?;
    Ok(())
}

/// True if any of the given `(entity, id)` pairs has a tombstone. Used by
/// child `*.add` arms to suppress events whose parent has been deleted —
/// otherwise a late event published by an offline peer can re-create
/// orphan rows for a permanently-tombstoned book/collection/chat (the
/// own-tombstone check on the child id alone is not enough because the
/// child may never have existed locally, so it has no tombstone of its
/// own).
fn parent_tombstoned(tx: &Transaction, parents: &[(&str, &str)]) -> AppResult<bool> {
    for (entity, id) in parents {
        if is_tombstoned(tx, entity, id)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Drop the row identified by `(entity, id)` plus every FK-child the event
/// path would cascade to. Does NOT write the tombstone for `(entity, id)`
/// itself — callers must call `insert_tombstone` separately for that.
/// Idempotent: if the row is already gone, every DELETE is a no-op.
///
/// `ts` is the deletion timestamp threaded through to any per-child
/// tombstones we have to write inline (e.g. cascaded chats — see
/// `cascade_delete_book`). Using the event's ts (and snapshot tombstones'
/// stored ts) instead of wall-clock keeps `_tombstones` rows
/// byte-identical across replay runs, which the design doc calls out as
/// a Chunk 4 invariant for snapshot equivalence.
///
/// Used by both the event-path delete arms and `Snapshot::apply_peer`'s
/// tombstone pass so the two paths stay byte-equivalent. For the composite
/// `collection_book` entity, `id` must be `"<col>:<book>"` — the same
/// format the merge engine uses when writing those tombstones.
pub fn cascade_delete(tx: &Transaction, entity: &str, id: &str, ts: i64) -> AppResult<()> {
    match entity {
        entity::BOOK => cascade_delete_book(tx, id, ts),
        entity::BOOK_ASSET => cascade_delete_book_asset(tx, id),
        entity::COLLECTION => cascade_delete_collection(tx, id),
        entity::CHAT => cascade_delete_chat(tx, id),
        entity::COLLECTION_BOOK => cascade_delete_collection_book(tx, id),
        entity::HIGHLIGHT => {
            tx.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
            Ok(())
        }
        // Legacy tag from a pre-065 peer snapshot. The row it names is a
        // position note now.
        entity::BOOKMARK => {
            tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
            Ok(())
        }
        entity::VOCAB => {
            tx.execute("DELETE FROM vocab_words WHERE id = ?1", params![id])?;
            Ok(())
        }
        entity::NOTE => {
            tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
            Ok(())
        }
        entity::WORD_MARK => {
            tx.execute(
                "UPDATE word_mark_rules SET enabled = 0, updated_at = MAX(updated_at, ?2)
                 WHERE id = ?1",
                params![id, ts],
            )?;
            Ok(())
        }
        entity::WORD_MARK_EXCEPTION => {
            tx.execute(
                "UPDATE word_mark_exceptions SET excluded = 0, updated_at = MAX(updated_at, ?2)
                 WHERE id = ?1",
                params![id, ts],
            )?;
            Ok(())
        }
        entity::LOOKUP_OCCURRENCE_MARK => {
            tx.execute(
                "UPDATE lookup_occurrence_marks SET enabled = 0, updated_at = MAX(updated_at, ?2)
                 WHERE id = ?1",
                params![id, ts],
            )?;
            Ok(())
        }
        entity::CUSTOM_FONT => cascade_delete_custom_font(tx, id, ts),
        entity::BOOK_SETTING => {
            let Some((book_id, key)) = id.split_once(':') else {
                return Ok(());
            };
            tx.execute(
                "DELETE FROM book_settings WHERE book_id = ?1 AND key = ?2 AND updated_at <= ?3",
                params![book_id, key, ts],
            )?;
            Ok(())
        }
        entity::SETTING => {
            // `book_setting`'s arm is structurally safe — a malformed id has no
            // `':'` and falls out. A global id is a bare key, so the whitelist
            // is the equivalent guard, and it matters more here: `settings` is
            // the table the local-only preferences live in.
            if !super::events::is_syncable_setting(false, id) {
                return Ok(());
            }
            tx.execute(
                "DELETE FROM settings WHERE key = ?1 AND updated_at <= ?2",
                params![id, ts],
            )?;
            Ok(())
        }
        "translation" => Ok(()),
        entity::CHAT_MESSAGE => {
            tx.execute("DELETE FROM chat_messages WHERE id = ?1", params![id])?;
            Ok(())
        }
        other => {
            log::warn!("sync: cascade_delete called with unknown entity {other:?}");
            Ok(())
        }
    }
}

fn cascade_delete_book(tx: &Transaction, id: &str, ts: i64) -> AppResult<()> {
    // Mirror the `apply_book_delete` cascade exactly. Replay runs with FK
    // off, so we can't rely on ON DELETE CASCADE.
    //
    // For the direct-child tables (highlights, vocab_words,
    // collection_books) we don't write per-row tombstones —
    // late `*.add` events for those tables are caught by their parent-
    // tombstone check on `('book', id)`.
    //
    // For chats we DO tombstone each cascaded chat, because the chat-
    // message merge arm checks `('chat', chat_id)`, not `('book', book_id)`,
    // so without this an orphan chat.message.add could resurrect after the
    // book is gone. The tombstone ts must be the parent-delete event ts
    // (not wall-clock) — `_tombstones` rows ride along in snapshots and
    // need to be byte-identical across replay runs.
    // Grounding chunks and their FTS index are local-only derived data (see
    // docs/impls/1-grounded-book-chat-overview.md D2), so they must never be
    // emitted as sync events or snapshots. They still need local cleanup here
    // because this is shared by direct deletes and replayed book deletes.
    let asset_ids: Vec<String> = {
        let mut statement = tx.prepare("SELECT id FROM book_assets WHERE book_id = ?1")?;
        let ids = statement
            .query_map(params![id], |row| row.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        ids
    };
    for asset_id in &asset_ids {
        insert_tombstone(tx, entity::BOOK_ASSET, asset_id, ts)?;
    }
    tx.execute(
        "DELETE FROM book_asset_local_state
         WHERE asset_id IN (SELECT id FROM book_assets WHERE book_id = ?1)",
        params![id],
    )?;
    tx.execute("DELETE FROM book_assets WHERE book_id = ?1", params![id])?;
    tx.execute("DELETE FROM ocr_jobs WHERE book_id = ?1", params![id])?;
    tx.execute(
        "DELETE FROM book_chunks_fts WHERE book_id = ?1",
        params![id],
    )?;
    let vector_table_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'book_chunk_vectors')",
        [],
        |row| row.get(0),
    )?;
    if vector_table_exists {
        tx.execute(
            "DELETE FROM book_chunk_vectors WHERE book_id = ?1",
            params![id],
        )?;
    }
    tx.execute(
        "DELETE FROM book_chunk_embeddings WHERE book_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM book_chunks WHERE book_id = ?1", params![id])?;
    tx.execute(
        "DELETE FROM book_index_state WHERE book_id = ?1",
        params![id],
    )?;
    // Also local-only derived data (migration 041): recomputable from the
    // file, never synced, and orphaned the moment the book row goes.
    tx.execute(
        "DELETE FROM book_difficulty WHERE book_id = ?1",
        params![id],
    )?;
    // Its per-section breakdown (migration 057): same posture, same reason.
    tx.execute(
        "DELETE FROM book_difficulty_sections WHERE book_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM book_summaries WHERE book_id = ?1", params![id])?;
    tx.execute("DELETE FROM highlights WHERE book_id = ?1", params![id])?;
    tx.execute("DELETE FROM vocab_words WHERE book_id = ?1", params![id])?;
    tx.execute("DELETE FROM lookup_records WHERE book_id = ?1", params![id])?;
    tx.execute("DELETE FROM explanations WHERE book_id = ?1", params![id])?;
    tx.execute(
        "DELETE FROM word_mark_exceptions WHERE book_id = ?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM word_mark_rules WHERE book_id = ?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM lookup_occurrence_marks WHERE book_id = ?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM notes WHERE book_id = ?1 AND scope = 'book'",
        params![id],
    )?;
    tx.execute(
        "UPDATE notes SET book_id = NULL WHERE book_id = ?1 AND scope = 'global'",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM collection_books WHERE book_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM book_settings WHERE book_id = ?1", params![id])?;
    // The one global `settings` row keyed off a book. It needs no `setting`
    // tombstone: the key is not on the sync whitelist, so no peer ever had it,
    // and the book's own tombstone already makes this deletion converge.
    tx.execute(
        "DELETE FROM settings WHERE key = ?1",
        params![format!("book_spoiler_guard_{id}")],
    )?;
    let chat_ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM chats WHERE book_id = ?1")?;
        let collected: Vec<String> = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        collected
    };
    for chat_id in &chat_ids {
        tx.execute(
            "DELETE FROM chat_messages WHERE chat_id = ?1",
            params![chat_id],
        )?;
        insert_tombstone(tx, entity::CHAT, chat_id, ts)?;
    }
    tx.execute("DELETE FROM chats WHERE book_id = ?1", params![id])?;
    tx.execute("DELETE FROM books WHERE id = ?1", params![id])?;
    Ok(())
}

fn cascade_delete_book_asset(tx: &Transaction, id: &str) -> AppResult<()> {
    tx.execute(
        "DELETE FROM book_asset_local_state WHERE asset_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM book_assets WHERE id = ?1", params![id])?;
    Ok(())
}

fn cascade_delete_collection(tx: &Transaction, id: &str) -> AppResult<()> {
    tx.execute(
        "DELETE FROM collection_books WHERE collection_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    Ok(())
}

fn cascade_delete_chat(tx: &Transaction, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM chat_messages WHERE chat_id = ?1", params![id])?;
    tx.execute("DELETE FROM chats WHERE id = ?1", params![id])?;
    Ok(())
}

fn cascade_delete_collection_book(tx: &Transaction, key: &str) -> AppResult<()> {
    let Some((col, book)) = key.split_once(':') else {
        log::warn!(
            "sync: cascade_delete_collection_book got malformed key {key:?}, expected '<col>:<book>'"
        );
        return Ok(());
    };
    tx.execute(
        "DELETE FROM collection_books WHERE collection_id = ?1 AND book_id = ?2",
        params![col, book],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// books
// ---------------------------------------------------------------------------

fn apply_book_import(tx: &Transaction, event: &Event, p: &BookImportPayload) -> AppResult<()> {
    if is_tombstoned(tx, entity::BOOK, &p.id)? {
        return Ok(());
    }
    // preparation_state is derived, not synced: text documents and converted
    // EPUBs (render epub from a non-epub source) are per-device local
    // artifacts, so a book arriving over sync must start 'pending' here and
    // re-derive them on this machine.
    tx.execute(
        "INSERT OR IGNORE INTO books
         (id, title, author, description, cover_path, file_path, genre, pages,
          format, source_format, render_format, source_file_path, source_sha256, conversion_version, preparation_state, preparation_error, status, progress, current_cfi, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 CASE WHEN ?11 = 'text' THEN 'pending'
                      WHEN ?11 = 'epub' AND ?10 <> 'epub' THEN 'pending'
                      ELSE 'ready' END, NULL,
                 'unread', 0, NULL, ?15, ?15, ?16)",
        params![
            p.id,
            p.title,
            p.author,
            p.description,
            p.cover_path,
            p.file_path,
            p.genre,
            p.pages,
            p.format,
            p.source_format.as_deref().unwrap_or(&p.format),
            p.render_format.as_deref().unwrap_or(&p.format),
            p.source_file_path,
            p.source_sha256,
            p.conversion_version,
            event.ts,
            event.device,
        ],
    )?;
    Ok(())
}

fn apply_book_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    cascade_delete(tx, entity::BOOK, id, event.ts)?;
    insert_tombstone(tx, entity::BOOK, id, event.ts)?;
    Ok(())
}

fn apply_book_asset_publish(
    tx: &Transaction,
    event: &Event,
    payload: &BookAssetPayload,
) -> AppResult<()> {
    if is_tombstoned(tx, entity::BOOK_ASSET, &payload.id)?
        || parent_tombstoned(tx, &[(entity::BOOK, &payload.book_id)])?
    {
        return Ok(());
    }
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO book_assets (
             id, book_id, role, format, relative_path, content_sha256,
             byte_size, source_sha256, pipeline, pipeline_version,
             language_profile, quality_profile, page_count,
             supersedes_asset_id, created_at, updated_at, updated_by_device
         ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
             ?11, ?12, ?13, ?14, ?15, ?16, ?17
         )",
        params![
            payload.id,
            payload.book_id,
            payload.role,
            payload.format,
            payload.relative_path,
            payload.content_sha256,
            payload.byte_size,
            payload.source_sha256,
            payload.pipeline,
            payload.pipeline_version,
            payload.language_profile,
            payload.quality_profile,
            payload.page_count,
            payload.supersedes_asset_id,
            payload.created_at,
            payload.updated_at,
            payload.updated_by_device,
        ],
    )?;
    if inserted > 0 {
        tx.execute(
            "INSERT INTO book_asset_local_state (
                 asset_id, availability, verified_at, error_code, updated_at
             ) VALUES (?1, 'remote_only', NULL, NULL, ?2)",
            params![payload.id, event.ts],
        )?;
    }
    Ok(())
}

fn apply_book_asset_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    cascade_delete(tx, entity::BOOK_ASSET, id, event.ts)?;
    insert_tombstone(tx, entity::BOOK_ASSET, id, event.ts)
}

fn apply_book_progress(
    tx: &Transaction,
    event: &Event,
    book: &str,
    progress: i32,
    cfi: Option<&str>,
) -> AppResult<()> {
    tx.execute(
        "UPDATE books
         SET progress = ?1, current_cfi = ?2, updated_at = ?3, updated_by_device = ?4
         WHERE id = ?5
           AND (updated_at < ?3 OR (updated_at = ?3 AND updated_by_device < ?4))",
        params![progress, cfi, event.ts, event.device, book],
    )?;
    Ok(())
}

fn apply_book_status(tx: &Transaction, event: &Event, book: &str, status: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE books
         SET status = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![status, event.ts, event.device, book],
    )?;
    Ok(())
}

fn apply_book_metadata(
    tx: &Transaction,
    event: &Event,
    book: &str,
    field: &str,
    value: &Value,
) -> AppResult<()> {
    // Allowlist — only fields the metadata-set event is allowed to touch.
    // Unknown fields (e.g. from a future schema) are dropped silently rather
    // than blowing up a whole replay tick.
    let column = match field {
        "title" | "author" | "description" | "cover_path" | "genre" | "file_path" => field,
        "pages" => "pages",
        _ => {
            log::warn!("sync: unknown book.metadata.set field {field:?}, skipping");
            return Ok(());
        }
    };

    // Use `<=` rather than `<`: the live `update_book_metadata` command
    // emits one event per field changed (see Step 3 of the spec), so a
    // multi-field edit like "rename + author" produces two events with
    // identical `(ts, device)`. With strict `<` the second would lose the
    // tuple compare and be silently skipped. `<=` lets every event in the
    // group land while staying idempotent on re-apply (the column already
    // holds `value`, so the UPDATE is a no-op write).
    let sql = format!(
        "UPDATE books
         SET {column} = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device <= ?3))"
    );

    if column == "pages" {
        let int_val: Option<i64> = match value {
            Value::Null => None,
            Value::Number(n) => n.as_i64().or_else(|| n.as_u64().map(|u| u as i64)),
            other => {
                return Err(AppError::Other(format!(
                    "book.metadata.set pages expects number/null, got {other:?}"
                )));
            }
        };
        tx.execute(&sql, params![int_val, event.ts, event.device, book])?;
    } else {
        let str_val: Option<String> = match value {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            other => {
                return Err(AppError::Other(format!(
                    "book.metadata.set {field} expects string/null, got {other:?}"
                )));
            }
        };
        tx.execute(&sql, params![str_val, event.ts, event.device, book])?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// highlights
// ---------------------------------------------------------------------------

fn apply_highlight_add(tx: &Transaction, event: &Event, p: &HighlightPayload) -> AppResult<()> {
    if is_tombstoned(tx, entity::HIGHLIGHT, &p.id)?
        || parent_tombstoned(tx, &[(entity::BOOK, &p.book_id)])?
    {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO highlights
         (id, book_id, cfi_range, color, text_content,
          created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
        params![
            p.id,
            p.book_id,
            p.cfi_range,
            p.color,
            p.text_content,
            event.ts,
            event.device,
        ],
    )?;
    Ok(())
}

// This delete carries no `(updated_at, updated_by_device)` guard of its own —
// it converges by construction rather than by judging a tuple:
//   - Replaying it twice (duplicate delivery, or two devices deleting the
//     same id) is idempotent: the second `DELETE` matches zero rows, and
//     `insert_tombstone`'s `MAX(ts, ...)` merge makes the tombstone itself
//     order-independent too.
//   - Racing `apply_highlight_add`: the add checks `is_tombstoned` up front,
//     so an add that arrives after this delete (in any replay order) is
//     suppressed outright — delete always beats add, never the reverse.
//   - Racing `apply_highlight_color`: that update has no tombstone check and
//     no row to fall back on once it's gone, so it relies on `UPDATE ...
//     WHERE id = ?` silently affecting zero rows post-delete. Whichever
//     event lands second, the outcome is the same: delete wins. There's no
//     tuple to compare because there's no scenario in which "the color edit
//     should win" is representable once the row no longer exists.
fn apply_highlight_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
    insert_tombstone(tx, entity::HIGHLIGHT, id, event.ts)?;
    Ok(())
}

fn apply_highlight_color(tx: &Transaction, event: &Event, id: &str, color: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE highlights
         SET color = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![color, event.ts, event.device, id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// bookmarks — legacy inbound only.
//
// The table is gone (migration 065): a bookmark is a `notes` row with
// `anchor_kind = 'position'`. These two arms exist because peer logs written
// before 065 still hold `bookmark.add` / `bookmark.delete`, and a device that
// bootstraps by replaying such a log would otherwise silently lose every
// bookmark that had not yet been folded into a peer snapshot.
//
// Nothing emits them any more — `commands::bookmarks` publishes `note.upsert`
// and `note.delete` like every other note. The derivation below is the same
// one migration 065 performs in SQL, so replaying an old event lands on the
// row the migration would have produced.
// ---------------------------------------------------------------------------

fn apply_bookmark_add(tx: &Transaction, event: &Event, p: &BookmarkPayload) -> AppResult<()> {
    // The id is the note's id — a bookmark and its note are one entity, not a
    // copy — so its own tombstone is now filed under `note`, whether it got
    // there through migration 065's fold or through a later delete in the UI.
    if is_tombstoned(tx, entity::NOTE, &p.id)?
        || parent_tombstoned(tx, &[(entity::BOOK, &p.book_id)])?
    {
        return Ok(());
    }
    // `OR IGNORE`, not the LWW upsert `apply_note_upsert` uses: this event
    // predates the merge, so anything already sitting under that id is newer
    // by construction and must not be overwritten by it.
    //
    // `updated_by_device` is the constant `'migration'`, not `event.device`,
    // for the same reason migration 065 and `insert_legacy_bookmark_as_note`
    // use it: all three are derivations of one pre-065 row, and a device that
    // reaches this row by replaying an old log must land on the same bytes as
    // one that reached it by running the migration. Stamping the emitting
    // device here would leave the two disagreeing on exactly the column that
    // breaks a same-millisecond LWW tie in `apply_note_upsert`.
    tx.execute(
        "INSERT OR IGNORE INTO notes
         (id, book_id, anchor_kind, normalized_word, scope, location, selected_text,
          content, content_format, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, 'position', NULL, 'book', ?3, NULL, ?4, 'plain_text', ?5, ?5, 'migration')",
        params![
            p.id,
            p.book_id,
            p.cfi,
            p.label.as_deref().unwrap_or(""),
            event.ts,
        ],
    )?;
    Ok(())
}

// Unconditional delete, no `(updated_at, updated_by_device)` guard — same
// shape as `apply_highlight_delete`, and it converges the same way. There's
// no bookmark-update event to race (bookmarks were add/delete only), so the
// only two things this needs to be safe against are: replaying itself
// (idempotent — a second `DELETE` matches zero rows, and `insert_tombstone`'s
// `MAX(ts, ...)` merge is order-independent), and racing `apply_bookmark_add`
// (which checks `is_tombstoned` up front, so an add delivered after this
// delete is suppressed regardless of arrival order — delete always wins).
//
// The tombstone goes under `note`, which is also where a same-id
// `note.upsert` from a peer that already migrated will look — so an old
// delete still outranks a newer-arriving edit of the row it deleted.
fn apply_bookmark_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    insert_tombstone(tx, entity::NOTE, id, event.ts)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// vocab
// ---------------------------------------------------------------------------

fn apply_vocab_add(tx: &Transaction, event: &Event, p: &VocabPayload) -> AppResult<()> {
    if is_tombstoned(tx, entity::VOCAB, &p.id)?
        || parent_tombstoned(tx, &[(entity::BOOK, &p.book_id)])?
    {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO vocab_words
         (id, book_id, word, definition, context_sentence, context_explanation, cfi,
          mastery, mastery_source, mastery_reason, review_count, next_review_at,
          review_interval_days, last_reviewed_at, last_review_rating,
          fsrs_stability, fsrs_difficulty, fsrs_version, list_status,
          created_at, updated_at, updated_by_device, card_snapshot)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
        params![
            p.id,
            p.book_id,
            p.word,
            p.definition,
            p.context_sentence,
            p.context_explanation,
            p.cfi,
            p.mastery,
            p.mastery_source,
            p.mastery_reason,
            p.review_count,
            p.next_review_at,
            p.review_interval_days,
            p.last_reviewed_at,
            p.last_review_rating,
            p.fsrs_stability,
            p.fsrs_difficulty,
            p.fsrs_version,
            p.list_status,
            p.created_at.unwrap_or(event.ts),
            event.ts,
            event.device,
            p.card_snapshot,
        ],
    )?;
    Ok(())
}

/// The observation zone's only transition (see `EventBody::VocabListStatusSet`
/// and migration 044): 'watchlist' → 'confirmed'. LWW-guarded the same way
/// `apply_highlight_color` is — a single field, compared against the row's
/// own `(updated_at, updated_by_device)` rather than gated behind the
/// mastery LWW tuple, because a lookup on one device and a manual save on
/// another can race and either fact may legitimately win.
/// `card_snapshot` rides along on the one transition that can carry one (an
/// explicit save promoting a watchlist row — see migration 067) rather than
/// getting its own event: a `COALESCE` write, same rule `apply_vocab_definition`
/// uses for `context_explanation` — a `None` here never erases a peer's
/// already-stored snapshot.
fn apply_vocab_list_status(
    tx: &Transaction,
    event: &Event,
    id: &str,
    list_status: &str,
    card_snapshot: Option<&str>,
) -> AppResult<()> {
    tx.execute(
        "UPDATE vocab_words
         SET list_status = ?1, card_snapshot = COALESCE(?2, card_snapshot), updated_at = ?3, updated_by_device = ?4
         WHERE id = ?5
           AND (updated_at < ?3 OR (updated_at = ?3 AND updated_by_device < ?4))",
        params![list_status, card_snapshot, event.ts, event.device, id],
    )?;
    Ok(())
}

/// A definition rewritten on another device.
///
/// LWW-guarded on the row's own `(updated_at, updated_by_device)` exactly like
/// `apply_vocab_mastery` — `definition` is now one of the columns that clock
/// governs, so both writers of it stamp the clock and this compare decides
/// ties the same way every other vocab update does.
///
/// The event carries only the new definition. The old text this device is
/// about to lose is *its own*, so the displacement rule runs here against the
/// local row rather than travelling: `displaced_explanation` is the same
/// function `vocab_regloss` and `commands::vocab::set_definition` call, which
/// is what makes the local and remote outcomes identical.
///
/// A row that does not exist locally is a no-op, like `apply_vocab_mastery`'s
/// zero-row UPDATE — the definition arrives with the `vocab.add` that creates
/// it, and the same device's log always orders the add first.
fn apply_vocab_definition(
    tx: &Transaction,
    event: &Event,
    id: &str,
    definition: &str,
) -> AppResult<()> {
    let Some((current, explanation)) = tx
        .query_row(
            "SELECT definition, context_explanation FROM vocab_words WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?
    else {
        return Ok(());
    };
    let displaced =
        crate::commands::vocab_regloss::displaced_explanation(&current, explanation.as_deref());
    tx.execute(
        "UPDATE vocab_words
         SET definition = ?1,
             context_explanation = COALESCE(?2, context_explanation),
             updated_at = ?3,
             updated_by_device = ?4
         WHERE id = ?5
           AND (updated_at < ?3 OR (updated_at = ?3 AND updated_by_device < ?4))",
        params![definition, displaced, event.ts, event.device, id],
    )?;
    Ok(())
}

/// A whole learning card regenerated on another device — see
/// `EventBody::VocabCardSet`.
///
/// Guarded by the same `(updated_at, updated_by_device)` compare as
/// `apply_vocab_definition` and `apply_vocab_mastery`, because it writes the
/// same three columns that clock already governs. That is also what settles
/// the race the task of writing this raised: a regeneration here and a mastery
/// change there inside one sync window are ordered against each other by the
/// single row clock, and the older one loses wholesale. No new rule, and no
/// second clock — see `commands::vocab::set_definition`'s doc comment for why
/// a per-column clock was rejected.
///
/// Unlike `apply_vocab_definition` this reads nothing first and displaces
/// nothing. The event carries every column it intends to change, so there is
/// no local text to work out — running the displacement rule here would
/// overwrite the `context_explanation` the sending card explicitly produced
/// with the receiver's own stale definition.
///
/// A row that does not exist locally is a no-op — the zero-row `UPDATE` is the
/// whole guard, as with every sibling arm, and the tombstone check
/// `apply_vocab_delete` relies on is likewise unnecessary for the same reason
/// spelled out above it.
fn apply_vocab_card(
    tx: &Transaction,
    event: &Event,
    id: &str,
    definition: &str,
    context_explanation: Option<&str>,
    card_snapshot: Option<&str>,
) -> AppResult<()> {
    tx.execute(
        "UPDATE vocab_words
         SET definition = ?1,
             context_explanation = COALESCE(?2, context_explanation),
             card_snapshot = COALESCE(?3, card_snapshot),
             updated_at = ?4,
             updated_by_device = ?5
         WHERE id = ?6
           AND (updated_at < ?4 OR (updated_at = ?4 AND updated_by_device < ?5))",
        params![
            definition,
            context_explanation,
            card_snapshot,
            event.ts,
            event.device,
            id
        ],
    )?;
    Ok(())
}

struct VocabMasteryUpdate<'a> {
    mastery: &'a str,
    next_review_at: Option<i64>,
    review_count: i64,
    review_interval_days: i64,
    last_reviewed_at: Option<i64>,
    last_review_rating: Option<&'a str>,
    fsrs_stability: Option<f64>,
    fsrs_difficulty: Option<f64>,
    fsrs_version: i64,
    mastery_source: &'a str,
    mastery_reason: Option<&'a str>,
}

fn apply_vocab_mastery(
    tx: &Transaction,
    event: &Event,
    id: &str,
    update: VocabMasteryUpdate<'_>,
) -> AppResult<()> {
    tx.execute(
        "UPDATE vocab_words
         SET mastery = ?1,
             next_review_at = ?2,
             review_count = ?3,
             review_interval_days = ?4,
             last_reviewed_at = ?5,
             last_review_rating = ?6,
             fsrs_stability = ?7,
             fsrs_difficulty = ?8,
             fsrs_version = ?9,
             mastery_source = ?10,
             mastery_reason = ?11,
             updated_at = ?12,
             updated_by_device = ?13
         WHERE id = ?14
           AND (updated_at < ?12 OR (updated_at = ?12 AND updated_by_device < ?13))",
        params![
            update.mastery,
            update.next_review_at,
            update.review_count,
            update.review_interval_days,
            update.last_reviewed_at,
            update.last_review_rating,
            update.fsrs_stability,
            update.fsrs_difficulty,
            update.fsrs_version,
            update.mastery_source,
            update.mastery_reason,
            event.ts,
            event.device,
            id
        ],
    )?;
    Ok(())
}

/// Append one review to `vocab_review_log` — see
/// `EventBody::VocabReviewAppend`.
///
/// The only merge rule in this file with nothing to arbitrate. Row ids are
/// minted locally and never reused, so `INSERT OR IGNORE` is not a
/// conflict-resolution strategy here, only idempotence: a snapshot rebuild or
/// a re-delivered event lands on the row already present instead of counting
/// the review twice. Two devices reviewing the same word produce two rows,
/// and that is the truth rather than a conflict.
///
/// Tombstone-guarded like every other add: a review that arrives after the
/// reader deleted the word does not get to start a fresh history for it.
/// Rows already written before the delete are left alone — see migration 061.
fn apply_vocab_review_append(
    tx: &Transaction,
    event: &Event,
    payload: &VocabReviewLogPayload,
) -> AppResult<()> {
    if is_tombstoned(tx, entity::VOCAB, &payload.vocab_word_id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO vocab_review_log
         (id, vocab_word_id, reviewed_at, rating, state_before, stability_before,
          difficulty_before, elapsed_days, scheduled_days, fsrs_version,
          created_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            payload.id,
            payload.vocab_word_id,
            payload.reviewed_at,
            payload.rating,
            payload.state_before,
            payload.stability_before,
            payload.difficulty_before,
            payload.elapsed_days,
            payload.scheduled_days,
            payload.fsrs_version,
            event.ts,
            event.device,
        ],
    )?;
    Ok(())
}

// Unconditional delete, no tuple guard — same idempotency argument as
// `apply_highlight_delete` covers replays of this event and races against
// `apply_vocab_add` (tombstone-checked, so a late add stays suppressed).
// It also has four update arms to race that carry no tombstone check of
// their own — `apply_vocab_list_status`, `apply_vocab_definition`,
// `apply_vocab_card`, and `apply_vocab_mastery` — each a plain
// `UPDATE ... WHERE id = ?`. None of
// them need one: once this delete has run, the row is gone and their
// `WHERE id = ?` matches zero rows regardless of replay order, so delete
// always wins over any of them rather than the two being compared by tuple.
fn apply_vocab_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM vocab_words WHERE id = ?1", params![id])?;
    insert_tombstone(tx, entity::VOCAB, id, event.ts)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// notes and whole-book word markers
// ---------------------------------------------------------------------------

fn apply_note_upsert(tx: &Transaction, event: &Event, payload: &NotePayload) -> AppResult<()> {
    if is_tombstoned(tx, entity::NOTE, &payload.id)? {
        return Ok(());
    }
    let effective_book_id = match payload.book_id.as_deref() {
        Some(book_id) if parent_tombstoned(tx, &[(entity::BOOK, book_id)])? => {
            if payload.scope == "book" {
                return Ok(());
            }
            None
        }
        value => value,
    };
    if effective_book_id.is_none() && payload.book_id.is_some() {
        // Parent deletion is an invariant, not a competing note edit. Repair
        // rows reattached by an older client even if their note LWW tuple is
        // newer than this incoming edit.
        tx.execute(
            "UPDATE notes SET book_id = NULL WHERE id = ?1",
            params![payload.id],
        )?;
    }
    tx.execute(
        "INSERT INTO notes (id, book_id, anchor_kind, normalized_word, scope, location, selected_text, content, content_format, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET book_id = excluded.book_id, anchor_kind = excluded.anchor_kind,
           normalized_word = excluded.normalized_word, scope = excluded.scope, location = excluded.location,
           selected_text = excluded.selected_text, content = excluded.content,
           content_format = excluded.content_format, updated_at = excluded.updated_at,
           updated_by_device = excluded.updated_by_device
         WHERE notes.updated_at < excluded.updated_at
            OR (notes.updated_at = excluded.updated_at AND notes.updated_by_device < excluded.updated_by_device)",
        params![
            payload.id,
            effective_book_id,
            payload.anchor_kind,
            payload.normalized_word,
            payload.scope,
            payload.location,
            payload.selected_text,
            payload.content,
            payload.content_format,
            payload.created_at,
            event.ts,
            event.device,
        ],
    )?;
    Ok(())
}

fn apply_note_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    insert_tombstone(tx, entity::NOTE, id, event.ts)
}

#[derive(Debug)]
struct LegacyWordMarkException {
    location: String,
    excluded: bool,
    created_at: i64,
    updated_at: i64,
    updated_by_device: String,
}

/// Move exception rows that still point at a pre-stable rule id onto the
/// canonical rule entity. The stable id is identity metadata, so changing it
/// must not strand an otherwise newer exception behind an orphaned rule id.
///
/// `preserve_values` is used by the local one-time canonicalization command:
/// it carries the user's exclusions across the identity repair. Replay and
/// snapshot rule updates pass `false`, making the effective rule tuple the
/// usual reset barrier while still retaining any genuinely newer exception.
#[allow(clippy::too_many_arguments)]
pub(crate) fn reconcile_legacy_word_mark_exceptions(
    tx: &Transaction,
    legacy_rule_id: &str,
    canonical_rule_id: &str,
    book_id: &str,
    normalized_word: &str,
    barrier_ts: i64,
    barrier_device: &str,
    preserve_values: bool,
) -> AppResult<Vec<WordMarkExceptionPayload>> {
    if legacy_rule_id == canonical_rule_id {
        return Ok(Vec::new());
    }

    let rows = {
        let mut statement = tx.prepare(
            "SELECT location, excluded, created_at, updated_at, updated_by_device
             FROM word_mark_exceptions
             WHERE rule_id = ?1 OR rule_id = ?2",
        )?;
        let rows = statement
            .query_map(params![legacy_rule_id, canonical_rule_id], |row| {
                Ok(LegacyWordMarkException {
                    location: row.get("location")?,
                    excluded: row.get::<_, i64>("excluded")? != 0,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    updated_by_device: row.get("updated_by_device")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    // Both ids may have received the same location while sync was catching
    // up. Collapse that pair with the same LWW tuple used everywhere else.
    let mut by_location: BTreeMap<String, LegacyWordMarkException> = BTreeMap::new();
    for row in rows {
        match by_location.entry(row.location.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(row);
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                let current = entry.get_mut();
                let earliest_created_at = current.created_at.min(row.created_at);
                if (current.updated_at, current.updated_by_device.as_str())
                    < (row.updated_at, row.updated_by_device.as_str())
                {
                    *current = row;
                }
                current.created_at = earliest_created_at;
            }
        }
    }

    tx.execute(
        "DELETE FROM word_mark_exceptions WHERE rule_id = ?1 OR rule_id = ?2",
        params![legacy_rule_id, canonical_rule_id],
    )?;

    let barrier = (barrier_ts, barrier_device);
    let mut publishable = Vec::with_capacity(by_location.len());
    for (_, mut row) in by_location {
        let row_tuple = (row.updated_at, row.updated_by_device.as_str());
        if row_tuple < barrier {
            if !preserve_values {
                row.excluded = false;
            }
            row.updated_at = barrier_ts;
            row.updated_by_device = barrier_device.to_string();
        }
        let id = word_mark_exception_id(canonical_rule_id, &row.location);
        tx.execute(
            "INSERT INTO word_mark_exceptions
             (id, rule_id, book_id, normalized_word, location, excluded,
              created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                canonical_rule_id,
                book_id,
                normalized_word,
                row.location,
                row.excluded as i64,
                row.created_at,
                row.updated_at,
                row.updated_by_device,
            ],
        )?;

        // An event body inherits the command's envelope timestamp. Only rows
        // lifted to that tuple can be faithfully represented in this batch;
        // a newer row is retained locally and will already be present in its
        // originating event stream or the next snapshot.
        if (row.updated_at, row.updated_by_device.as_str()) == barrier {
            publishable.push(WordMarkExceptionPayload {
                id,
                rule_id: canonical_rule_id.to_string(),
                book_id: book_id.to_string(),
                normalized_word: normalized_word.to_string(),
                location: row.location,
                excluded: row.excluded,
                created_at: row.created_at,
            });
        }
    }
    Ok(publishable)
}

fn apply_word_mark_upsert(
    tx: &Transaction,
    event: &Event,
    payload: &WordMarkPayload,
) -> AppResult<()> {
    if parent_tombstoned(tx, &[(entity::BOOK, &payload.book_id)])? {
        return Ok(());
    }
    // Early development builds represented cancellation as a permanent
    // tombstone. A later full upsert supersedes it; an older upsert does not.
    if tombstone_timestamp(tx, entity::WORD_MARK, &payload.id)?
        .is_some_and(|deleted_at| deleted_at >= event.ts)
    {
        return Ok(());
    }
    tx.execute(
        "DELETE FROM _tombstones WHERE entity = ?1 AND id = ?2",
        params![entity::WORD_MARK, payload.id],
    )?;
    let prior_rule_id: Option<String> = tx
        .query_row(
            "SELECT id FROM word_mark_rules
             WHERE book_id = ?1 AND normalized_word = ?2 AND match_mode = ?3",
            params![payload.book_id, payload.normalized_word, payload.match_mode],
            |row| row.get(0),
        )
        .optional()?;
    let changed = tx.execute(
        "INSERT INTO word_mark_rules (id, book_id, normalized_word, display_word, match_mode, color, enabled, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(book_id, normalized_word, match_mode) DO UPDATE SET id = excluded.id,
           display_word = excluded.display_word, color = excluded.color,
           enabled = excluded.enabled, updated_at = excluded.updated_at,
           updated_by_device = excluded.updated_by_device
         WHERE word_mark_rules.updated_at < excluded.updated_at
            OR (word_mark_rules.updated_at = excluded.updated_at AND word_mark_rules.updated_by_device < excluded.updated_by_device)",
        params![
            payload.id,
            payload.book_id,
            payload.normalized_word,
            payload.display_word,
            payload.match_mode,
            payload.color,
            payload.enabled as i64,
            payload.created_at,
            event.ts,
            event.device,
        ],
    )?;
    let repaired_legacy_id = prior_rule_id
        .as_deref()
        .is_some_and(|prior_id| prior_id != payload.id);
    if repaired_legacy_id {
        // Identity repair is independent of LWW content. Even when the
        // incoming payload loses to a newer local tuple, the natural-key row
        // must use the canonical id or its exceptions and snapshots remain
        // invalid forever.
        tx.execute(
            "UPDATE word_mark_rules SET id = ?1
             WHERE book_id = ?2 AND normalized_word = ?3 AND match_mode = ?4",
            params![
                payload.id,
                payload.book_id,
                payload.normalized_word,
                payload.match_mode
            ],
        )?;
        let (effective_ts, effective_device): (i64, String) = tx.query_row(
            "SELECT updated_at, updated_by_device FROM word_mark_rules WHERE id = ?1",
            params![payload.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        reconcile_legacy_word_mark_exceptions(
            tx,
            prior_rule_id.as_deref().expect("legacy id checked above"),
            &payload.id,
            &payload.book_id,
            &payload.normalized_word,
            effective_ts,
            &effective_device,
            false,
        )?;
    } else if changed > 0 {
        // The rule tuple is a reset barrier for its occurrence exceptions.
        // Store disabled rows rather than deleting them so delayed older
        // events cannot resurrect exclusions after an explicit re-mark.
        tx.execute(
            "UPDATE word_mark_exceptions
             SET excluded = 0, updated_at = ?2, updated_by_device = ?3
             WHERE rule_id = ?1
               AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
            params![payload.id, event.ts, event.device],
        )?;
    }
    Ok(())
}

fn apply_word_mark_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    // Compatibility for logs produced by the first development build. New
    // commands publish WordMarkUpsert(enabled=false), but replaying the legacy
    // delete should converge to the same disabled state when the row exists.
    let current_tuple: Option<(i64, String)> = tx
        .query_row(
            "SELECT updated_at, updated_by_device FROM word_mark_rules WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if current_tuple
        .as_ref()
        .is_some_and(|(ts, device)| (*ts, device.as_str()) > (event.ts, event.device.as_str()))
    {
        return Ok(());
    }
    let changed = tx.execute(
        "UPDATE word_mark_rules SET enabled = 0, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?1 AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![id, event.ts, event.device],
    )?;
    if changed > 0 {
        tx.execute(
            "UPDATE word_mark_exceptions
             SET excluded = 0, updated_at = ?2, updated_by_device = ?3
             WHERE rule_id = ?1
               AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
            params![id, event.ts, event.device],
        )?;
    }
    // A compatibility delete may arrive before its older upsert. Retaining a
    // timestamped tombstone is what makes that delivery order converge; a
    // genuinely newer full upsert is still allowed to supersede it above.
    insert_tombstone(tx, entity::WORD_MARK, id, event.ts)
}

fn apply_word_mark_exception_set(
    tx: &Transaction,
    event: &Event,
    payload: &WordMarkExceptionPayload,
) -> AppResult<()> {
    if parent_tombstoned(tx, &[(entity::BOOK, &payload.book_id)])? {
        return Ok(());
    }
    // Keep a validated exception even if its parent rule has not replayed yet.
    // Cross-device clock skew can order a dependent event ahead of its parent;
    // query paths join against an enabled rule, so the temporary orphan stays
    // invisible and becomes effective once the parent arrives.
    let parent_tuple = tx
        .query_row(
            "SELECT updated_at, updated_by_device FROM word_mark_rules WHERE id = ?1",
            params![payload.rule_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    // If a newer parent is already materialized, persist the same disabled
    // barrier row that applying the exception first and the parent second
    // would have produced. Dropping the stale event outright is visually
    // equivalent but breaks byte-for-byte convergence and later snapshots.
    let (excluded, updated_at, updated_by_device) = match parent_tuple {
        Some((ts, device)) if (ts, device.as_str()) > (event.ts, event.device.as_str()) => {
            (false, ts, device)
        }
        _ => (payload.excluded, event.ts, event.device.clone()),
    };
    tx.execute(
        "INSERT INTO word_mark_exceptions
         (id, rule_id, book_id, normalized_word, location, excluded,
          created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(rule_id, location) DO UPDATE SET
           id = excluded.id, book_id = excluded.book_id,
           normalized_word = excluded.normalized_word,
           excluded = excluded.excluded, updated_at = excluded.updated_at,
           updated_by_device = excluded.updated_by_device
         WHERE word_mark_exceptions.updated_at < excluded.updated_at
            OR (word_mark_exceptions.updated_at = excluded.updated_at
                AND word_mark_exceptions.updated_by_device < excluded.updated_by_device)",
        params![
            payload.id,
            payload.rule_id,
            payload.book_id,
            payload.normalized_word,
            payload.location,
            excluded as i64,
            payload.created_at,
            updated_at,
            updated_by_device,
        ],
    )?;
    Ok(())
}

fn apply_lookup_occurrence_mark_set(
    tx: &Transaction,
    event: &Event,
    payload: &LookupOccurrenceMarkPayload,
) -> AppResult<()> {
    if parent_tombstoned(tx, &[(entity::BOOK, &payload.book_id)])? {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO lookup_occurrence_marks
         (id, book_id, normalized_word, display_word, location, enabled,
          created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(book_id, location) DO UPDATE SET
           id=excluded.id, normalized_word=excluded.normalized_word,
           display_word=excluded.display_word, enabled=excluded.enabled,
           updated_at=excluded.updated_at, updated_by_device=excluded.updated_by_device
         WHERE (lookup_occurrence_marks.updated_at, lookup_occurrence_marks.updated_by_device)
             < (excluded.updated_at, excluded.updated_by_device)",
        params![
            payload.id,
            payload.book_id,
            payload.normalized_word,
            payload.display_word,
            payload.location,
            payload.enabled as i64,
            payload.created_at,
            event.ts,
            event.device,
        ],
    )?;
    Ok(())
}

/// The row may name an anchor this device has never derived — `lookup_records`
/// does not sync, so a peer's dismissal of a lookup arrives without the lookup.
/// It is stored anyway and simply matches nothing until the same word is looked
/// up here.
fn apply_auto_highlight_dismissal_set(
    tx: &Transaction,
    event: &Event,
    payload: &AutoHighlightDismissalPayload,
) -> AppResult<()> {
    if parent_tombstoned(tx, &[(entity::BOOK, &payload.book_id)])? {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO auto_highlight_dismissals
         (id, book_id, anchor, dismissed, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(book_id, anchor) DO UPDATE SET
           id=excluded.id, dismissed=excluded.dismissed,
           updated_at=excluded.updated_at, updated_by_device=excluded.updated_by_device
         WHERE (auto_highlight_dismissals.updated_at, auto_highlight_dismissals.updated_by_device)
             < (excluded.updated_at, excluded.updated_by_device)",
        params![
            payload.id,
            payload.book_id,
            payload.anchor,
            payload.dismissed as i64,
            payload.created_at,
            event.ts,
            event.device,
        ],
    )?;
    Ok(())
}

fn apply_book_summary_upsert(
    tx: &Transaction,
    _event: &Event,
    payload: &BookSummaryPayload,
) -> AppResult<()> {
    if is_tombstoned(tx, entity::BOOK, &payload.book_id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO book_summaries
         (id, book_id, scope, section_index, section_title, content, language, model,
          source_sha256, created_at, updated_at, user_edited, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(book_id, scope, COALESCE(section_index, -1)) DO UPDATE SET
           id=excluded.id, section_title=excluded.section_title, content=excluded.content,
           language=excluded.language, model=excluded.model, source_sha256=excluded.source_sha256,
           updated_at=excluded.updated_at, user_edited=excluded.user_edited,
           updated_by_device=excluded.updated_by_device
         WHERE book_summaries.updated_at < excluded.updated_at
            OR (book_summaries.updated_at = excluded.updated_at AND book_summaries.updated_by_device < excluded.updated_by_device)",
        params![
            payload.id,
            payload.book_id,
            payload.scope,
            payload.section_index,
            payload.section_title,
            payload.content,
            payload.language,
            payload.model,
            payload.source_sha256,
            payload.created_at,
            payload.updated_at,
            payload.user_edited as i64,
            payload.updated_by_device,
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// collections + collection_books
// ---------------------------------------------------------------------------

fn apply_collection_create(
    tx: &Transaction,
    event: &Event,
    id: &str,
    name: &str,
    sort_order: i32,
) -> AppResult<()> {
    if is_tombstoned(tx, entity::COLLECTION, id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO collections
         (id, name, sort_order, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![id, name, sort_order, event.ts, event.device],
    )?;
    Ok(())
}

fn apply_collection_rename(tx: &Transaction, event: &Event, id: &str, name: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE collections
         SET name = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![name, event.ts, event.device, id],
    )?;
    Ok(())
}

fn apply_collection_reorder(
    tx: &Transaction,
    event: &Event,
    id: &str,
    sort_order: i32,
) -> AppResult<()> {
    tx.execute(
        "UPDATE collections
         SET sort_order = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![sort_order, event.ts, event.device, id],
    )?;
    Ok(())
}

fn apply_collection_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    // Tombstone each join row first so a delayed `collection.book.add` for
    // the same pair stays suppressed. cascade_delete then drops the rows.
    let pairs: Vec<String> = {
        let mut stmt =
            tx.prepare("SELECT book_id FROM collection_books WHERE collection_id = ?1")?;
        let collected: Vec<String> = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        collected
    };
    for book_id in pairs {
        let key = format!("{id}:{book_id}");
        insert_tombstone(tx, entity::COLLECTION_BOOK, &key, event.ts)?;
    }
    cascade_delete(tx, entity::COLLECTION, id, event.ts)?;
    insert_tombstone(tx, entity::COLLECTION, id, event.ts)?;
    Ok(())
}

fn apply_collection_book_add(
    tx: &Transaction,
    event: &Event,
    collection: &str,
    book: &str,
) -> AppResult<()> {
    let key = format!("{collection}:{book}");
    if is_tombstoned(tx, entity::COLLECTION_BOOK, &key)?
        || parent_tombstoned(
            tx,
            &[(entity::COLLECTION, collection), (entity::BOOK, book)],
        )?
    {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO collection_books
         (collection_id, book_id, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?3, ?4)",
        params![collection, book, event.ts, event.device],
    )?;
    Ok(())
}

fn apply_collection_book_remove(
    tx: &Transaction,
    event: &Event,
    collection: &str,
    book: &str,
) -> AppResult<()> {
    let key = format!("{collection}:{book}");
    cascade_delete(tx, entity::COLLECTION_BOOK, &key, event.ts)?;
    insert_tombstone(tx, entity::COLLECTION_BOOK, &key, event.ts)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// chats + chat_messages
// ---------------------------------------------------------------------------

fn apply_chat_create(
    tx: &Transaction,
    event: &Event,
    id: &str,
    book: &str,
    title: &str,
    model: Option<&str>,
) -> AppResult<()> {
    if is_tombstoned(tx, entity::CHAT, id)? {
        return Ok(());
    }
    if parent_tombstoned(tx, &[(entity::BOOK, book)])? {
        // Parent book is tombstoned — suppress the chat AND leave a chat
        // tombstone so any delayed `chat.message.add` for this id is also
        // dropped. The message arm only consults `('chat', chat_id)`
        // tombstones; without this, a stale (chat.create + chat.message.add)
        // pair from an offline peer would slip the message in as an
        // orphan after the create was silently discarded.
        insert_tombstone(tx, entity::CHAT, id, event.ts)?;
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO chats
         (id, book_id, title, model, pinned, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5, ?6)",
        params![id, book, title, model, event.ts, event.device],
    )?;
    Ok(())
}

fn apply_chat_rename(tx: &Transaction, event: &Event, id: &str, title: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE chats
         SET title = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![title, event.ts, event.device, id],
    )?;
    Ok(())
}

// Unconditional cascade delete, no tuple guard — same idempotency argument
// as `apply_highlight_delete` covers replays of this event and the race
// against `apply_chat_create` (tombstone-checked, so a late create stays
// suppressed) and `apply_chat_message_add` (checks the chat's own tombstone
// via `parent_tombstoned`, so late messages stay suppressed too).
// `apply_chat_rename`, though, carries no tombstone check — a plain
// `UPDATE ... WHERE id = ?`. It doesn't need one: once this delete has run,
// the chat row (and its messages, via `cascade_delete`) are gone, so the
// rename's `WHERE id = ?` matches zero rows regardless of replay order.
// Delete always wins over a concurrent rename rather than the two being
// compared by tuple.
fn apply_chat_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    cascade_delete(tx, entity::CHAT, id, event.ts)?;
    insert_tombstone(tx, entity::CHAT, id, event.ts)?;
    Ok(())
}

fn apply_chat_message_add(
    tx: &Transaction,
    event: &Event,
    p: &ChatMessagePayload,
) -> AppResult<()> {
    if is_tombstoned(tx, entity::CHAT_MESSAGE, &p.id)?
        || parent_tombstoned(tx, &[(entity::CHAT, &p.chat_id)])?
    {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO chat_messages
         (id, chat_id, role, content, context, metadata, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
        params![
            p.id,
            p.chat_id,
            p.role,
            p.content,
            p.context,
            p.metadata,
            event.ts,
            event.device
        ],
    )?;
    // Mirror the live `add_chat_message` command's side effect — the parent
    // chat's recency drives chat-list ordering, so peers must see the bump
    // too. LWW guard prevents an older message event from dragging
    // `updated_at` backwards if the chat has been renamed since.
    tx.execute(
        "UPDATE chats
         SET updated_at = ?1, updated_by_device = ?2
         WHERE id = ?3
           AND (updated_at < ?1 OR (updated_at = ?1 AND updated_by_device < ?2))",
        params![event.ts, event.device, p.chat_id],
    )?;
    Ok(())
}

fn apply_chat_message_replace(
    tx: &Transaction,
    event: &Event,
    p: &ChatMessagePayload,
) -> AppResult<()> {
    if is_tombstoned(tx, entity::CHAT_MESSAGE, &p.id)?
        || parent_tombstoned(tx, &[(entity::CHAT, &p.chat_id)])?
    {
        return Ok(());
    }
    let changed = tx.execute(
        "UPDATE chat_messages
         SET content = ?1, metadata = ?2, updated_at = ?3, updated_by_device = ?4
         WHERE id = ?5 AND chat_id = ?6 AND role = 'assistant'
           AND (updated_at, updated_by_device) < (?3, ?4)",
        params![
            p.content,
            p.metadata,
            event.ts,
            event.device,
            p.id,
            p.chat_id
        ],
    )?;
    if changed == 0 {
        return Ok(());
    }
    tx.execute(
        "UPDATE chats
         SET updated_at = ?1, updated_by_device = ?2
         WHERE id = ?3
           AND (updated_at < ?1 OR (updated_at = ?1 AND updated_by_device < ?2))",
        params![event.ts, event.device, p.chat_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Imported fonts.
//
// Only the catalog row travels through the log. The bytes arrive separately
// under `imported-fonts/` in the shared directory, so a row may legitimately
// exist here for a while before its file does — see `reconcile_custom_fonts`
// in replay.rs and the `file_available` flag it feeds to the UI.
// ---------------------------------------------------------------------------

fn apply_custom_font_upsert(
    tx: &Transaction,
    event: &Event,
    payload: &CustomFontPayload,
) -> AppResult<()> {
    // A font id is `custom-<sha256 of the bytes>`, so it is stable forever and
    // identical on every device. A permanent tombstone would therefore mean
    // "delete this font once and no device may ever import that file again",
    // which is a bug rather than a policy. Follow the word-mark precedent: the
    // tombstone is timestamped, and a strictly newer upsert clears it.
    if tombstone_timestamp(tx, entity::CUSTOM_FONT, &payload.id)?
        .is_some_and(|deleted_at| deleted_at >= event.ts)
    {
        return Ok(());
    }
    tx.execute(
        "DELETE FROM _tombstones WHERE entity = ?1 AND id = ?2",
        params![entity::CUSTOM_FONT, payload.id],
    )?;
    tx.execute(
        "INSERT INTO custom_fonts
           (id, family_name, file_name, format, file_size, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET family_name = excluded.family_name,
           file_name = excluded.file_name, format = excluded.format,
           file_size = excluded.file_size, created_at = MIN(custom_fonts.created_at, excluded.created_at),
           updated_at = excluded.updated_at, updated_by_device = excluded.updated_by_device
         WHERE (custom_fonts.updated_at, custom_fonts.updated_by_device)
             < (excluded.updated_at, excluded.updated_by_device)",
        params![
            payload.id,
            payload.family_name,
            payload.file_name,
            payload.format,
            payload.file_size,
            payload.created_at,
            event.ts,
            event.device,
        ],
    )?;
    Ok(())
}

fn apply_custom_font_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    let current: Option<(i64, String)> = tx
        .query_row(
            "SELECT updated_at, updated_by_device FROM custom_fonts WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    // A delete that is older than the row's current state loses: the user
    // re-selected or re-imported this font on another device after the delete
    // was issued, and that later intent wins.
    if current
        .as_ref()
        .is_some_and(|(ts, device)| (*ts, device.as_str()) > (event.ts, event.device.as_str()))
    {
        return Ok(());
    }
    cascade_delete(tx, entity::CUSTOM_FONT, id, event.ts)?;
    insert_tombstone(tx, entity::CUSTOM_FONT, id, event.ts)?;
    Ok(())
}

/// Drop the catalog row and un-select the font everywhere it is referenced,
/// mirroring what the local `delete_custom_font` command does. The file itself
/// is deliberately left alone: a peer may still be mid-flight with an upsert
/// that re-creates the row, and an orphaned content-addressed file is both
/// small and harmlessly overwritten by a later import of the same bytes.
fn cascade_delete_custom_font(tx: &Transaction, id: &str, ts: i64) -> AppResult<()> {
    tx.execute("DELETE FROM custom_fonts WHERE id = ?1", params![id])?;
    tx.execute(
        "UPDATE settings SET value = 'system', updated_at = MAX(updated_at, ?2)
         WHERE key = 'font_family' AND value = ?1",
        params![id, ts],
    )?;
    tx.execute(
        "UPDATE book_settings SET value = 'system', updated_at = MAX(updated_at, ?2)
         WHERE key = 'font' AND value = ?1",
        params![id, ts],
    )?;
    crate::commands::fonts::clear_marker_style_font(tx, id)?;
    Ok(())
}

/// Apply one whitelisted setting. Unknown keys are **skipped, not rejected**:
/// a validation error in `apply_in_tx` does not advance the peer's watermark
/// past the offending event, so refusing a key added by a newer Lantern would
/// wedge that peer's replay permanently.
fn apply_setting_set(tx: &Transaction, event: &Event, payload: &SettingPayload) -> AppResult<()> {
    if !super::events::is_syncable_setting(payload.book.is_some(), &payload.key) {
        log::debug!(
            "sync: skipping non-syncable setting key {:?}",
            payload.key.as_str()
        );
        return Ok(());
    }
    match (payload.book.as_deref(), payload.value.as_deref()) {
        (None, Some(value)) => {
            // Same shape as the per-book write below: a deletion tombstone
            // suppresses any write at or before its own timestamp, and a
            // strictly newer write clears it. Without the clear, re-choosing a
            // font after "restore the default" would be undone by its own
            // tombstone the next time a snapshot came round.
            if tombstone_timestamp(tx, entity::SETTING, &payload.key)?
                .is_some_and(|timestamp| timestamp >= event.ts)
            {
                return Ok(());
            }
            tx.execute(
                "DELETE FROM _tombstones WHERE entity = ?1 AND id = ?2",
                params![entity::SETTING, payload.key],
            )?;
            tx.execute(
                "INSERT INTO settings (key, value, updated_at, updated_by_device)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                   updated_at = excluded.updated_at, updated_by_device = excluded.updated_by_device
                 WHERE (settings.updated_at, settings.updated_by_device)
                     < (excluded.updated_at, excluded.updated_by_device)",
                params![payload.key, value, event.ts, event.device],
            )?;
        }
        (Some(book_id), Some(value)) => {
            // A per-book override for a deleted book is meaningless; the row
            // would also outlive its FK target.
            if parent_tombstoned(tx, &[(entity::BOOK, book_id)])? {
                return Ok(());
            }
            let tombstone_id = format!("{book_id}:{}", payload.key);
            if tombstone_timestamp(tx, entity::BOOK_SETTING, &tombstone_id)?
                .is_some_and(|timestamp| timestamp >= event.ts)
            {
                return Ok(());
            }
            tx.execute(
                "DELETE FROM _tombstones WHERE entity = ?1 AND id = ?2",
                params![entity::BOOK_SETTING, tombstone_id],
            )?;
            tx.execute(
                "INSERT INTO book_settings (book_id, key, value, updated_at, updated_by_device)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(book_id, key) DO UPDATE SET value = excluded.value,
                   updated_at = excluded.updated_at, updated_by_device = excluded.updated_by_device
                 WHERE (book_settings.updated_at, book_settings.updated_by_device)
                     < (excluded.updated_at, excluded.updated_by_device)",
                params![book_id, payload.key, value, event.ts, event.device],
            )?;
        }
        (Some(book_id), None) => {
            if parent_tombstoned(tx, &[(entity::BOOK, book_id)])? {
                return Ok(());
            }
            let tombstone_id = format!("{book_id}:{}", payload.key);
            insert_tombstone(tx, entity::BOOK_SETTING, &tombstone_id, event.ts)?;
            tx.execute(
                "DELETE FROM book_settings
                 WHERE book_id = ?1 AND key = ?2
                   AND updated_at <= ?3",
                params![book_id, payload.key, event.ts],
            )?;
        }
        // Deleting a global setting is how "this key follows the resolved
        // default again" crosses — see `undo_promote_book_settings`. It needs a
        // tombstone for the same reason the per-book arm above does: a snapshot
        // states which rows exist, never which ones stopped existing, so
        // without one the peer's next snapshot would simply put the row back.
        (None, None) => {
            insert_tombstone(tx, entity::SETTING, &payload.key, event.ts)?;
            tx.execute(
                "DELETE FROM settings WHERE key = ?1 AND updated_at <= ?2",
                params![payload.key, event.ts],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Each test follows the same shape: open an in-memory DB, run migrations
    //! up to 11, build events, apply, assert SQL state. We toggle FK off for
    //! the apply tx because the replay engine does the same — see the module
    //! docstring for the rationale.

    use super::*;
    use crate::db::Db;
    use crate::sync::events::*;
    use rusqlite::Connection;
    use serde_json::json;

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        Db::run_migrations_on(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
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

    fn apply_all(conn: &mut Connection, events: &[Event]) {
        let tx = conn.transaction().unwrap();
        for e in events {
            apply_event(&tx, e).expect("apply_event failed");
        }
        tx.commit().unwrap();
    }

    /// Guard against a forgotten cascade when a new `book_id`-bearing table is
    /// added. Seeds a book plus a row in every current child table, deletes the
    /// book through `cascade_delete`, then enumerates *every* table with a
    /// `book_id` column and asserts none still references the deleted book.
    ///
    /// Foreign keys are OFF app-wide (the replay engine writes rows out of
    /// order), so SQLite never enforces this at runtime — a table wired into a
    /// feature but not into `cascade_delete_book` would silently orphan its
    /// rows. This turns that mistake into a failing test.
    #[test]
    fn cascade_delete_book_leaves_no_orphans_in_any_book_id_table() {
        let mut conn = open_db();
        conn.execute_batch(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES ('b1','T','A','books/test.epub','reading',42,1700000000000,1700000000000);
             INSERT INTO book_assets (
                 id, book_id, role, format, relative_path, content_sha256,
                 byte_size, source_sha256, pipeline, language_profile,
                 quality_profile, page_count, created_at, updated_at,
                 updated_by_device
             ) VALUES (
                 'asset-1','b1','ocr_pdf','pdf','books/b1.ocr.asset-1.pdf',
                 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',4,
                 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                 'ocrmypdf','chi_sim+eng','fast',1,1700000000000,1700000000000,'dev-A'
             );
             INSERT INTO book_asset_local_state
                 (asset_id, availability, verified_at, error_code, updated_at)
                 VALUES ('asset-1','available_verified',1700000000000,NULL,1700000000000);
             INSERT INTO ocr_jobs (
                 id, book_id, source_sha256, state, conversion_version,
                 result_asset_id, created_at, updated_at
             ) VALUES (
                 'job-1','b1',
                 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                 'ready',1,'asset-1',1700000000000,1700000000000
             );
             INSERT INTO collections (id, name, sort_order, created_at, updated_at)
                 VALUES ('c1','Fav',0,1700000000000,1700000000000);
             INSERT INTO collection_books (collection_id, book_id, created_at, updated_at)
                 VALUES ('c1','b1',1700000000000,1700000000000);
             INSERT INTO notes (id, book_id, anchor_kind, scope, location, content,
                                content_format, created_at, updated_at, updated_by_device)
                 VALUES ('bm1','b1','position','book','epubcfi(/6/2!/4)','Ch1',
                         'plain_text',1700000000000,1700000000000,'dev-A');
             INSERT INTO highlights (id, book_id, cfi_range, color, text_content, created_at, updated_at)
                 VALUES ('h1','b1','epubcfi(/6/4!/2,/4)','yellow','q',1700000000000,1700000000000);
             INSERT INTO vocab_words (id, book_id, word, definition, context_sentence, cfi, mastery, review_count, next_review_at, created_at, updated_at)
                 VALUES ('v1','b1','w','d','s','epubcfi(/6/4!/8)','learning',0,NULL,1700000000000,1700000000000);
             INSERT INTO chats (id, book_id, title, model, pinned, metadata, created_at, updated_at)
                 VALUES ('ch1','b1','First','m',0,NULL,1700000000000,1700000000000);
             INSERT INTO chat_messages (id, chat_id, role, content, context, metadata, created_at, updated_at)
                 VALUES ('m1','ch1','user','hello',NULL,NULL,1700000000000,1700000000000);
             INSERT INTO notes (id, book_id, anchor_kind, normalized_word, scope, location, selected_text, content, content_format, created_at, updated_at)
                 VALUES ('n1','b1','word','w','book',NULL,NULL,'note','plain_text',1700000000000,1700000000000);
             INSERT INTO lookup_records (id, book_id, lookup_text, normalized_text, context_sentence, chapter, cfi, definition, context_explanation, result_json, provider_profile_id, model, created_at, last_looked_up_at, updated_at, lookup_count)
                 VALUES ('l1','b1','L','l','s','One','epubcfi(/6/2)','d','e','{}','p','m',1700000000000,1700000000000,1700000000000,2);
             INSERT INTO word_mark_rules (id, book_id, normalized_word, display_word, match_mode, color, enabled, created_at, updated_at)
                 VALUES ('wm1','b1','w','W','exact','lookup',1,1700000000000,1700000000000);
             INSERT INTO word_mark_exceptions (id, rule_id, book_id, normalized_word, location, excluded, created_at, updated_at)
                 VALUES ('wme1','wm1','b1','w','epubcfi(/6/2)',1,1700000000000,1700000000000);
             INSERT INTO lookup_occurrence_marks (id, book_id, normalized_word, display_word, location, enabled, created_at, updated_at)
                 VALUES ('lom1','b1','w','W','epubcfi(/6/2)',1,1700000000000,1700000000000);
             INSERT INTO book_index_state (book_id, source_sha256, index_version, chunk_count, status, error, indexed_at)
                 VALUES ('b1','hash-1',1,1,'ready',NULL,1700000000000);
             INSERT INTO book_chunks (id, book_id, chunk_index, section_index, section_href, section_title, char_start, char_end, text, snippet, token_estimate, created_at)
                 VALUES ('bc1','b1',0,0,'s0.xhtml','S0',0,99,'text','snip',8,1700000000000);
             INSERT INTO book_chunks_fts (seg_text, chunk_id, book_id) VALUES ('text','bc1','b1');
             INSERT INTO book_chunk_embeddings (chunk_id, book_id, embedding, dimensions, model, source_sha256, created_at)
                 VALUES ('bc1','b1',X'00','3','m','hash-1',1700000000000);
             INSERT INTO book_summaries (id, book_id, scope, section_index, section_title, content, language, model, source_sha256, created_at, updated_at)
                 VALUES ('bs1','b1','book',NULL,NULL,'sum','en','m','hash-1',1700000000000,1700000000000);
             INSERT INTO book_settings (book_id, key, value)
                 VALUES ('b1','font','serif');",
        )
        .unwrap();

        {
            let tx = conn.transaction().unwrap();
            cascade_delete(&tx, entity::BOOK, "b1", 1700000001000).unwrap();
            tx.commit().unwrap();
        }

        let books: i64 = conn
            .query_row("SELECT COUNT(*) FROM books WHERE id = 'b1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(books, 0, "the book row itself must be deleted");
        let asset_tombstone: bool = conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM _tombstones
                     WHERE entity = 'book_asset' AND id = 'asset-1'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(asset_tombstone, "book delete must tombstone derived assets");

        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let mut checked = 0;
        for table in tables {
            if table == "books" {
                continue;
            }
            let has_book_id: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = 'book_id'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if has_book_id == 0 {
                continue;
            }
            let orphans: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM \"{table}\" WHERE book_id = 'b1'"),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                orphans, 0,
                "table `{table}` still has rows for the deleted book — cascade_delete_book is missing a DELETE for it"
            );
            checked += 1;
        }
        assert!(
            checked >= 12,
            "expected to verify many child tables, only checked {checked} — did the seed drift from the schema?"
        );
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

    #[test]
    fn book_asset_publish_delete_and_tombstone_are_idempotent() {
        let mut conn = open_db();
        let publish = ev(
            1_714_770_000_001,
            "dev-A",
            EventBody::BookAssetPublish(book_asset("asset-1", "b1")),
        );
        apply_all(
            &mut conn,
            &[
                ev(1_714_770_000_000, "dev-A", import_book("b1")),
                publish.clone(),
                publish.clone(),
            ],
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        let availability: String = conn
            .query_row(
                "SELECT availability FROM book_asset_local_state WHERE asset_id = 'asset-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(availability, "remote_only");

        apply_all(
            &mut conn,
            &[
                ev(
                    1_714_770_000_002,
                    "dev-A",
                    EventBody::BookAssetDelete {
                        id: "asset-1".into(),
                    },
                ),
                publish,
            ],
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0, "a delayed publish must not revive a deleted asset");
        let tombstoned: bool = conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM _tombstones
                     WHERE entity = 'book_asset' AND id = 'asset-1'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(tombstoned);
    }

    #[test]
    fn book_delete_blocks_delayed_asset_publish() {
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[
                ev(1_714_770_000_000, "dev-A", import_book("b1")),
                ev(
                    1_714_770_000_001,
                    "dev-A",
                    EventBody::BookDelete { id: "b1".into() },
                ),
                ev(
                    1_714_770_000_002,
                    "dev-A",
                    EventBody::BookAssetPublish(book_asset("asset-late", "b1")),
                ),
            ],
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn two_devices_can_publish_distinct_assets_for_the_same_book() {
        let mut conn = open_db();
        let mut peer_asset = book_asset("asset-b", "b1");
        peer_asset.updated_by_device = "dev-B".into();
        apply_all(
            &mut conn,
            &[
                ev(1_714_770_000_000, "dev-A", import_book("b1")),
                ev(
                    1_714_770_000_001,
                    "dev-A",
                    EventBody::BookAssetPublish(book_asset("asset-a", "b1")),
                ),
                ev(
                    1_714_770_000_002,
                    "dev-B",
                    EventBody::BookAssetPublish(peer_asset),
                ),
            ],
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 2);
    }

    fn book_summary(content: &str, updated_at: i64) -> EventBody {
        book_summary_from(content, updated_at, "dev-a")
    }

    fn book_summary_from(content: &str, updated_at: i64, device: &str) -> EventBody {
        EventBody::BookSummaryUpsert(BookSummaryPayload {
            id: format!("summary-{updated_at}"),
            book_id: "b1".into(),
            scope: "book".into(),
            section_index: None,
            section_title: None,
            content: content.into(),
            language: "en".into(),
            model: None,
            source_sha256: "hash".into(),
            created_at: updated_at,
            updated_at,
            user_edited: false,
            updated_by_device: device.into(),
        })
    }

    #[test]
    fn book_summary_upsert_is_idempotent_and_latest_timestamp_wins() {
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[
                ev(1, "dev-a", import_book("b1")),
                ev(20, "dev-a", book_summary("new", 20)),
                ev(10, "dev-b", book_summary("old", 10)),
                ev(20, "dev-a", book_summary("new", 20)),
            ],
        );
        let summary: String = conn
            .query_row(
                "SELECT content FROM book_summaries WHERE book_id = 'b1' AND scope = 'book'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(summary, "new");
    }

    /// A later `updated_at` always wins regardless of which device wrote it —
    /// the millisecond compare alone must decide when the two differ, exactly
    /// like `notes` and `word_mark_rules`.
    #[test]
    fn book_summary_later_timestamp_wins_regardless_of_device() {
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[
                ev(1, "dev-a", import_book("b1")),
                ev(
                    10,
                    "dev-z",
                    book_summary_from("early, high device id", 10, "dev-z"),
                ),
                ev(
                    20,
                    "dev-a",
                    book_summary_from("late, low device id", 20, "dev-a"),
                ),
            ],
        );
        let summary: String = conn
            .query_row(
                "SELECT content FROM book_summaries WHERE book_id = 'b1' AND scope = 'book'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(summary, "late, low device id");
    }

    /// Two devices write the same summary in the same millisecond. Neither
    /// device's local clock can order this pair, so the outcome has to be
    /// decided by the device-id tiebreaker alone -- and it has to be the same
    /// tiebreaker on both devices, so whichever order the events replay in,
    /// both peers converge on the row from the higher device id. This is the
    /// defect migration 063 fixes: before it, `book_summaries` had no
    /// `updated_by_device` column to break the tie on, so the two replay
    /// orders below diverged.
    #[test]
    fn book_summary_same_millisecond_converges_regardless_of_replay_order() {
        let a = ev(100, "dev-a", book_summary_from("from dev-a", 100, "dev-a"));
        let b = ev(100, "dev-b", book_summary_from("from dev-b", 100, "dev-b"));

        let mut forward = open_db();
        apply_all(
            &mut forward,
            &[ev(1, "dev-a", import_book("b1")), a.clone(), b.clone()],
        );
        let mut backward = open_db();
        apply_all(&mut backward, &[ev(1, "dev-a", import_book("b1")), b, a]);

        let read = |conn: &Connection| -> (String, String) {
            conn.query_row(
                "SELECT content, updated_by_device FROM book_summaries WHERE book_id = 'b1' AND scope = 'book'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        let forward_result = read(&forward);
        let backward_result = read(&backward);
        assert_eq!(
            forward_result, backward_result,
            "replay order must not change the winner"
        );
        assert_eq!(
            forward_result,
            ("from dev-b".to_string(), "dev-b".to_string())
        );
    }

    /// A row written before migration 063 carries `updated_by_device = ""`
    /// (the migration's backfill default is `'migration'`, but a row created
    /// through the old event-replay path before this column existed --
    /// exercised here directly via `apply_all` -- has no way to have set it,
    /// so the payload's own zero value is what a peer log entry from that era
    /// would actually carry). It must still resolve deterministically against
    /// a same-millisecond write from a real device, in both replay orders,
    /// rather than erroring or resolving arbitrarily.
    #[test]
    fn book_summary_empty_device_string_still_converges_deterministically() {
        let old = ev(100, "dev-a", book_summary_from("from old data", 100, ""));
        let new = ev(
            100,
            "dev-b",
            book_summary_from("from real device", 100, "dev-b"),
        );

        let mut forward = open_db();
        apply_all(
            &mut forward,
            &[ev(1, "dev-a", import_book("b1")), old.clone(), new.clone()],
        );
        let mut backward = open_db();
        apply_all(
            &mut backward,
            &[ev(1, "dev-a", import_book("b1")), new, old],
        );

        let read = |conn: &Connection| -> String {
            conn.query_row(
                "SELECT content FROM book_summaries WHERE book_id = 'b1' AND scope = 'book'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        let forward_result = read(&forward);
        let backward_result = read(&backward);
        assert_eq!(
            forward_result, backward_result,
            "replay order must not change the winner"
        );
        // "" < "dev-b" lexicographically, so the real device id wins the tie.
        assert_eq!(forward_result, "from real device");
    }

    /// Same millisecond, same device -- e.g. a retried write after a crash
    /// before the outbox ack. The tuple compare's `<` is strict, so a second
    /// delivery of the identical tuple is a no-op rather than reapplying: the
    /// row that landed first stands.
    #[test]
    fn book_summary_same_millisecond_same_device_keeps_first_write() {
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[
                ev(1, "dev-a", import_book("b1")),
                ev(100, "dev-a", book_summary_from("first", 100, "dev-a")),
                ev(100, "dev-a", book_summary_from("retried", 100, "dev-a")),
            ],
        );
        let summary: String = conn
            .query_row(
                "SELECT content FROM book_summaries WHERE book_id = 'b1' AND scope = 'book'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(summary, "first");
    }

    fn add_highlight(id: &str, book: &str, color: &str) -> EventBody {
        EventBody::HighlightAdd(HighlightPayload {
            id: id.into(),
            book_id: book.into(),
            cfi_range: "epubcfi(/6/4!/2,/1:0,/1:5)".into(),
            color: color.into(),
            text_content: None,
        })
    }

    /// A peer on an older build still has `highlight.note.set` in its log, and
    /// its `highlight.add` payloads still carry a `note` field. Migration 035
    /// moved that text into `notes`, so both must replay without erroring and
    /// without resurrecting a column that no longer exists.
    #[test]
    fn legacy_highlight_note_events_replay_harmlessly() {
        let add: Event = serde_json::from_value(serde_json::json!({
            "id": "01HYZX00000000000000000002",
            "ts": 2,
            "device": "dev-a",
            "v": EVENT_SCHEMA_VERSION,
            "type": "highlight.add",
            "payload": {
                "id": "h1",
                "book_id": "b1",
                "cfi_range": "epubcfi(/6/4!/2,/1:0,/1:5)",
                "color": "yellow",
                "note": "written on an older build",
                "text_content": "quoted",
            },
        }))
        .expect("an old peer's highlight.add must still deserialize");

        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[
                ev(1, "dev-a", import_book("b1")),
                add,
                ev(
                    3,
                    "dev-a",
                    EventBody::HighlightNoteSet {
                        id: "h1".into(),
                        note: Some("still here".into()),
                    },
                ),
            ],
        );

        let color: String = conn
            .query_row("SELECT color FROM highlights WHERE id = 'h1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(color, "yellow", "the highlight itself still lands");
    }

    fn note(id: &str, book: &str, scope: &str, content: &str, created_at: i64) -> EventBody {
        EventBody::NoteUpsert(NotePayload {
            id: id.into(),
            book_id: Some(book.into()),
            anchor_kind: "word".into(),
            normalized_word: Some("term".into()),
            scope: scope.into(),
            location: Some("epubcfi(/6/4!)".into()),
            selected_text: Some("term".into()),
            content: content.into(),
            content_format: "plain_text".into(),
            created_at,
        })
    }

    fn word_mark(book: &str, enabled: bool, color: &str, created_at: i64) -> EventBody {
        let normalized_word = "term".to_string();
        EventBody::WordMarkUpsert(WordMarkPayload {
            id: word_mark_rule_id(book, &normalized_word, "exact"),
            book_id: book.into(),
            normalized_word,
            display_word: "Term".into(),
            match_mode: "exact".into(),
            color: color.into(),
            enabled,
            created_at,
        })
    }

    fn word_mark_exception(
        book: &str,
        location: &str,
        excluded: bool,
        created_at: i64,
    ) -> EventBody {
        let normalized_word = "term".to_string();
        let rule_id = word_mark_rule_id(book, &normalized_word, "exact");
        EventBody::WordMarkExceptionSet(WordMarkExceptionPayload {
            id: word_mark_exception_id(&rule_id, location),
            rule_id,
            book_id: book.into(),
            normalized_word,
            location: location.into(),
            excluded,
            created_at,
        })
    }

    // -----------------------------------------------------------------------
    // book.import / book.delete + tombstone semantics
    // -----------------------------------------------------------------------

    #[test]
    fn book_import_inserts_with_event_metadata() {
        let mut db = open_db();
        apply_all(&mut db, &[ev(1000, "dev-A", import_book("b1"))]);

        let (title, ts, dev): (String, i64, String) = db
            .query_row(
                "SELECT title, updated_at, updated_by_device FROM books WHERE id = 'b1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(title, "T");
        assert_eq!(ts, 1000);
        assert_eq!(dev, "dev-A");
    }

    #[test]
    fn book_delete_removes_row_and_writes_tombstone() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-A", EventBody::BookDelete { id: "b1".into() }),
            ],
        );

        let n: i64 = db
            .query_row("SELECT COUNT(*) FROM books WHERE id = 'b1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 0);
        let tomb: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'book' AND id = 'b1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tomb, 1);
    }

    #[test]
    fn book_delete_cascades_learning_tools_and_late_global_note_stays_detached() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    note("note-book", "b1", "book", "book note", 1100),
                ),
                ev(
                    1200,
                    "dev-A",
                    note("note-global", "b1", "global", "global note", 1200),
                ),
                ev(1300, "dev-A", word_mark("b1", true, "lookup", 1300)),
                ev(2000, "dev-B", EventBody::BookDelete { id: "b1".into() }),
                // An offline peer may publish a newer edit that still carries
                // the deleted source book. Content should merge, but the
                // parent link must remain detached.
                ev(
                    2100,
                    "dev-A",
                    note("note-global", "b1", "global", "edited later", 1200),
                ),
                ev(
                    2200,
                    "dev-A",
                    note("note-book-late", "b1", "book", "must not return", 2200),
                ),
                ev(2300, "dev-A", word_mark("b1", true, "lookup", 2300)),
            ],
        );

        let notes: Vec<(String, Option<String>, String)> = {
            let mut statement = db
                .prepare("SELECT id, book_id, content FROM notes ORDER BY id")
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(
            notes,
            vec![("note-global".to_string(), None, "edited later".to_string())]
        );
        let marker_count: i64 = db
            .query_row("SELECT COUNT(*) FROM word_mark_rules", [], |row| row.get(0))
            .unwrap();
        assert_eq!(marker_count, 0);
    }

    #[test]
    fn concurrent_same_word_rules_converge_to_one_stable_lww_row() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-A", word_mark("b1", true, "lookup", 2000)),
                ev(2000, "dev-B", word_mark("b1", false, "muted", 2000)),
            ],
        );

        let expected_id = word_mark_rule_id("b1", "term", "exact");
        let row: (String, i64, String, String) = db
            .query_row(
                "SELECT id, enabled, color, updated_by_device FROM word_mark_rules",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(row, (expected_id, 0, "muted".into(), "dev-B".into()));
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM word_mark_rules", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn word_mark_exception_can_arrive_before_its_older_parent_rule() {
        let mut db = open_db();
        apply_all(&mut db, &[ev(1000, "dev-A", import_book("b1"))]);
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();

        // Simulate separate sync ticks: the exception's peer is available
        // first, while the causally-earlier rule from another peer arrives
        // later. Keep FK checks on to prove migration 022 does not make the
        // protocol depend on the production connection's FK pragma. The
        // temporary orphan must survive and become effective.
        apply_all(
            &mut db,
            &[ev(
                3000,
                "dev-B",
                word_mark_exception("b1", "epubcfi(/6/4!)", true, 3000),
            )],
        );
        let orphan: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM word_mark_exceptions WHERE excluded = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphan, 1);
        db.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();

        apply_all(
            &mut db,
            &[ev(2000, "dev-A", word_mark("b1", true, "lookup", 2000))],
        );
        let effective: i64 = db
            .query_row(
                "SELECT COUNT(*)
                 FROM word_mark_exceptions e
                 JOIN word_mark_rules r ON r.id = e.rule_id
                 WHERE e.excluded = 1 AND r.enabled = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(effective, 1);
    }

    #[test]
    fn word_mark_rule_update_is_a_lww_reset_barrier_for_older_exceptions() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-A", word_mark("b1", true, "lookup", 2000)),
                ev(
                    3000,
                    "dev-A",
                    word_mark_exception("b1", "epubcfi(/6/4!)", true, 3000),
                ),
                ev(4000, "dev-B", word_mark("b1", false, "lookup", 2000)),
            ],
        );
        let row: (i64, i64, String) = db
            .query_row(
                "SELECT excluded, updated_at, updated_by_device
                 FROM word_mark_exceptions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (0, 4000, "dev-B".into()));

        // A delayed older exception cannot resurrect the occurrence.
        apply_all(
            &mut db,
            &[ev(
                3500,
                "dev-C",
                word_mark_exception("b1", "epubcfi(/6/4!)", true, 3000),
            )],
        );
        let excluded: i64 = db
            .query_row("SELECT excluded FROM word_mark_exceptions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(excluded, 0);
    }

    #[test]
    fn same_timestamp_rule_and_exception_converge_by_device_tiebreaker() {
        let mut rule_then_exception = open_db();
        apply_all(
            &mut rule_then_exception,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-A", word_mark("b1", true, "lookup", 2000)),
                ev(
                    3000,
                    "dev-A",
                    word_mark_exception("b1", "epubcfi(/6/4!)", true, 3000),
                ),
                ev(3000, "dev-B", word_mark("b1", true, "lookup", 2000)),
            ],
        );

        let mut exception_then_rule = open_db();
        apply_all(
            &mut exception_then_rule,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-A", word_mark("b1", true, "lookup", 2000)),
                ev(3000, "dev-B", word_mark("b1", true, "lookup", 2000)),
                ev(
                    3000,
                    "dev-A",
                    word_mark_exception("b1", "epubcfi(/6/4!)", true, 3000),
                ),
            ],
        );

        let read = |db: &Connection| -> (i64, i64, String) {
            db.query_row(
                "SELECT excluded, updated_at, updated_by_device
                 FROM word_mark_exceptions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
        };
        assert_eq!(read(&rule_then_exception), (0, 3000, "dev-B".into()));
        assert_eq!(read(&exception_then_rule), read(&rule_then_exception));
    }

    #[test]
    fn legacy_word_mark_delete_blocks_an_older_late_upsert_but_not_a_newer_one() {
        let mut db = open_db();
        let rule_id = word_mark_rule_id("b1", "term", "exact");
        apply_all(
            &mut db,
            &[
                ev(
                    3000,
                    "dev-B",
                    EventBody::WordMarkDelete {
                        id: rule_id.clone(),
                    },
                ),
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-A", word_mark("b1", true, "lookup", 2000)),
            ],
        );
        let suppressed: i64 = db
            .query_row("SELECT COUNT(*) FROM word_mark_rules", [], |row| row.get(0))
            .unwrap();
        assert_eq!(suppressed, 0);

        apply_all(
            &mut db,
            &[ev(4000, "dev-C", word_mark("b1", true, "lookup", 4000))],
        );
        let restored: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM word_mark_rules WHERE enabled = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(restored, 1);
    }

    #[test]
    fn repeated_tombstones_keep_the_newest_timestamp_independent_of_order() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(3000, "dev-B", EventBody::NoteDelete { id: "n1".into() }),
                ev(1000, "dev-A", EventBody::NoteDelete { id: "n1".into() }),
            ],
        );
        let timestamp: i64 = db
            .query_row(
                "SELECT ts FROM _tombstones WHERE entity = 'note' AND id = 'n1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(timestamp, 3000);
    }

    #[test]
    fn tombstone_blocks_resurrection() {
        // delete then add (later ts, same id) → row stays gone.
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-A", EventBody::BookDelete { id: "b1".into() }),
                ev(3000, "dev-A", import_book("b1")),
            ],
        );
        let n: i64 = db
            .query_row("SELECT COUNT(*) FROM books WHERE id = 'b1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 0, "tombstone should block re-import even at higher ts");
    }

    #[test]
    fn book_delete_cascades_to_children() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1001, "dev-A", add_highlight("h1", "b1", "yellow")),
                ev(
                    1002,
                    "dev-A",
                    EventBody::BookmarkAdd(BookmarkPayload {
                        id: "bm1".into(),
                        book_id: "b1".into(),
                        cfi: "epubcfi(/6/4!)".into(),
                        label: None,
                    }),
                ),
                ev(2000, "dev-A", EventBody::BookDelete { id: "b1".into() }),
            ],
        );
        for table in ["books", "highlights", "notes"] {
            let n: i64 = db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} should be empty after book delete");
        }
    }

    // -----------------------------------------------------------------------
    // legacy bookmark events (pre-065 peer logs)
    // -----------------------------------------------------------------------

    /// A device bootstrapping off an old peer's log must end up with the same
    /// rows migration 065 would have produced locally — otherwise every
    /// bookmark that predates the merge quietly disappears on that device.
    #[test]
    fn legacy_bookmark_add_lands_as_a_position_note() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::BookmarkAdd(BookmarkPayload {
                        id: "bm-labelled".into(),
                        book_id: "b1".into(),
                        cfi: "epubcfi(/6/4!)".into(),
                        label: Some("come back here".into()),
                    }),
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::BookmarkAdd(BookmarkPayload {
                        id: "bm-bare".into(),
                        book_id: "b1".into(),
                        cfi: "epubcfi(/6/8!)".into(),
                        label: None,
                    }),
                ),
            ],
        );

        let row = |id: &str| -> (String, String, Option<String>, Option<String>, String, i64) {
            db.query_row(
                "SELECT anchor_kind, scope, location, selected_text, content, created_at
                 FROM notes WHERE id = ?1",
                params![id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap()
        };
        assert_eq!(
            row("bm-labelled"),
            (
                "position".into(),
                "book".into(),
                Some("epubcfi(/6/4!)".into()),
                None,
                "come back here".into(),
                1100,
            )
        );
        assert_eq!(
            row("bm-bare"),
            (
                "position".into(),
                "book".into(),
                Some("epubcfi(/6/8!)".into()),
                None,
                String::new(),
                1200,
            )
        );
    }

    /// The delete side has to file its tombstone under `note`, because that is
    /// the only entity the live code consults. Filed under the retired
    /// `bookmark` name it would be invisible, and a later replay of the
    /// matching `bookmark.add` would resurrect the row.
    #[test]
    fn legacy_bookmark_delete_tombstones_the_note_and_blocks_resurrection() {
        let mut db = open_db();
        let add = |ts: i64| {
            ev(
                ts,
                "dev-A",
                EventBody::BookmarkAdd(BookmarkPayload {
                    id: "bm1".into(),
                    book_id: "b1".into(),
                    cfi: "epubcfi(/6/4!)".into(),
                    label: None,
                }),
            )
        };
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                add(1100),
                ev(
                    1200,
                    "dev-A",
                    EventBody::BookmarkDelete { id: "bm1".into() },
                ),
                add(1300),
            ],
        );

        let live: i64 = db
            .query_row("SELECT COUNT(*) FROM notes WHERE id = 'bm1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(live, 0, "a re-applied add must not outlive the delete");
        let filed: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'note' AND id = 'bm1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(filed, 1, "tombstone must be filed under 'note'");
        let stale: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'bookmark'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale, 0, "nothing may be written under the retired entity");
    }

    // -----------------------------------------------------------------------
    // LWW correctness
    // -----------------------------------------------------------------------

    #[test]
    fn book_progress_lww_higher_ts_wins_regardless_of_order() {
        // Apply lower-ts last; LWW guard rejects it, so progress stays at the
        // higher-ts value.
        let mut db1 = open_db();
        apply_all(
            &mut db1,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1500,
                    "dev-A",
                    EventBody::BookProgressSet {
                        book: "b1".into(),
                        progress: 50,
                        cfi: Some("c50".into()),
                    },
                ),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookProgressSet {
                        book: "b1".into(),
                        progress: 80,
                        cfi: Some("c80".into()),
                    },
                ),
            ],
        );
        let mut db2 = open_db();
        apply_all(
            &mut db2,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookProgressSet {
                        book: "b1".into(),
                        progress: 80,
                        cfi: Some("c80".into()),
                    },
                ),
                ev(
                    1500,
                    "dev-A",
                    EventBody::BookProgressSet {
                        book: "b1".into(),
                        progress: 50,
                        cfi: Some("c50".into()),
                    },
                ),
            ],
        );

        for db in [&db1, &db2] {
            let (p, cfi): (i32, String) = db
                .query_row(
                    "SELECT progress, current_cfi FROM books WHERE id = 'b1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(p, 80);
            assert_eq!(cfi, "c80");
        }
    }

    #[test]
    fn same_ms_lww_breaks_tie_by_device_uuid() {
        // Two devices write the same field at the same ms. The lexicographically
        // larger device id wins the tuple compare.
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookStatusSet {
                        book: "b1".into(),
                        status: "reading".into(),
                    },
                ),
                ev(
                    2000,
                    "dev-B",
                    EventBody::BookStatusSet {
                        book: "b1".into(),
                        status: "finished".into(),
                    },
                ),
            ],
        );
        let (status, dev): (String, String) = db
            .query_row(
                "SELECT status, updated_by_device FROM books WHERE id = 'b1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "finished", "dev-B > dev-A in tuple compare");
        assert_eq!(dev, "dev-B");

        // Reverse order — same outcome.
        let mut db2 = open_db();
        apply_all(
            &mut db2,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-B",
                    EventBody::BookStatusSet {
                        book: "b1".into(),
                        status: "finished".into(),
                    },
                ),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookStatusSet {
                        book: "b1".into(),
                        status: "reading".into(),
                    },
                ),
            ],
        );
        let status2: String = db2
            .query_row("SELECT status FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status2, "finished");
    }

    #[test]
    fn highlight_color_lww_skips_older_event() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_highlight("h1", "b1", "yellow")),
                ev(
                    1300,
                    "dev-A",
                    EventBody::HighlightColorSet {
                        id: "h1".into(),
                        color: "pink".into(),
                    },
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::HighlightColorSet {
                        id: "h1".into(),
                        color: "green".into(),
                    },
                ),
            ],
        );
        let color: String = db
            .query_row("SELECT color FROM highlights WHERE id = 'h1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(color, "pink", "older color event must lose");
    }

    #[test]
    fn vocab_mastery_carries_review_count_idempotently() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::VocabAdd(VocabPayload {
                        id: "v1".into(),
                        book_id: "b1".into(),
                        word: "serendipity".into(),
                        definition: "fortunate".into(),
                        context_sentence: None,
                        context_explanation: None,
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
                        mastery_source: "manual".into(),
                        mastery_reason: None,
                        list_status: "confirmed".into(),
                        card_snapshot: None,
                    }),
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::VocabMasterySet {
                        id: "v1".into(),
                        mastery: "learning".into(),
                        next_review_at: Some(2_000_000),
                        review_count: 1,
                        review_interval_days: 1,
                        last_reviewed_at: Some(1200),
                        last_review_rating: Some("hard".into()),
                        fsrs_stability: None,
                        fsrs_difficulty: None,
                        fsrs_version: 1,
                        mastery_source: "manual".into(),
                        mastery_reason: None,
                    },
                ),
                ev(
                    1300,
                    "dev-A",
                    EventBody::VocabMasterySet {
                        id: "v1".into(),
                        mastery: "learning".into(),
                        next_review_at: Some(3_000_000),
                        review_count: 2,
                        review_interval_days: 2,
                        last_reviewed_at: Some(1300),
                        last_review_rating: Some("good".into()),
                        fsrs_stability: None,
                        fsrs_difficulty: None,
                        fsrs_version: 1,
                        mastery_source: "manual".into(),
                        mastery_reason: None,
                    },
                ),
            ],
        );
        let (m, n): (String, i64) = db
            .query_row(
                "SELECT mastery, review_count FROM vocab_words WHERE id = 'v1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(m, "learning");
        assert_eq!(n, 2, "absolute review_count from later event wins");
    }

    /// A tier the reader overruled on one Mac has to arrive on the other as
    /// an override, not just as a new tier. If `mastery_source` stayed 'auto'
    /// and `mastery_reason` survived, the second device would keep showing
    /// "decided automatically" plus the sentence justifying a judgement its
    /// owner has already rejected.
    #[test]
    fn a_manual_override_clears_the_automatic_mark_on_the_receiving_device() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::VocabAdd(VocabPayload {
                        id: "v1".into(),
                        book_id: "b1".into(),
                        word: "serendipity".into(),
                        definition: "fortunate".into(),
                        context_sentence: None,
                        context_explanation: None,
                        cfi: None,
                        mastery: "familiar".into(),
                        review_count: 0,
                        next_review_at: None,
                        review_interval_days: 0,
                        last_reviewed_at: None,
                        last_review_rating: None,
                        fsrs_stability: None,
                        fsrs_difficulty: None,
                        fsrs_version: 1,
                        created_at: None,
                        mastery_source: "auto".into(),
                        mastery_reason: Some("{\"reason\":\"exposure_promotion\"}".into()),
                        list_status: "confirmed".into(),
                        card_snapshot: None,
                    }),
                ),
                ev(
                    1200,
                    "dev-B",
                    EventBody::VocabMasterySet {
                        id: "v1".into(),
                        mastery: "learning".into(),
                        next_review_at: None,
                        review_count: 0,
                        review_interval_days: 0,
                        last_reviewed_at: None,
                        last_review_rating: None,
                        fsrs_stability: None,
                        fsrs_difficulty: None,
                        fsrs_version: 1,
                        mastery_source: "manual".into(),
                        mastery_reason: None,
                    },
                ),
            ],
        );
        let (mastery, source, reason): (String, String, Option<String>) = db
            .query_row(
                "SELECT mastery, mastery_source, mastery_reason FROM vocab_words WHERE id = 'v1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(mastery, "learning");
        assert_eq!(source, "manual");
        assert_eq!(reason, None);
    }

    // --- card_snapshot (migration 067) ---

    /// A word saved with a card snapshot on the adding device must still
    /// carry it after a fresh device replays the same `vocab.add` event.
    #[test]
    fn a_card_snapshot_survives_a_vocab_add_sync_round_trip() {
        let mut db = open_db();
        let snapshot = r#"{"modules":{"word_info":{"summary":"clear"}}}"#.to_string();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::VocabAdd(VocabPayload {
                        id: "v1".into(),
                        book_id: "b1".into(),
                        word: "lucid".into(),
                        definition: "clear".into(),
                        context_sentence: None,
                        context_explanation: None,
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
                        mastery_source: "manual".into(),
                        mastery_reason: None,
                        list_status: "confirmed".into(),
                        card_snapshot: Some(snapshot.clone()),
                    }),
                ),
            ],
        );
        let stored: Option<String> = db
            .query_row(
                "SELECT card_snapshot FROM vocab_words WHERE id = 'v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, Some(snapshot));
    }

    /// The watchlist→confirmed promotion is the one `vocab.list_status.set`
    /// transition that can carry a snapshot (an explicit save on a word
    /// still in the observation zone). A receiving device must apply it, and
    /// a later promotion with no snapshot must not erase one already there.
    #[test]
    fn a_snapshot_carried_on_list_status_promotion_survives_and_is_never_erased() {
        let mut db = open_db();
        let snapshot = r#"{"modules":{"word_info":{"summary":"being alone"}}}"#.to_string();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::VocabAdd(VocabPayload {
                        id: "v1".into(),
                        book_id: "b1".into(),
                        word: "solitude".into(),
                        definition: "being alone".into(),
                        context_sentence: None,
                        context_explanation: None,
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
                        mastery_source: "manual".into(),
                        mastery_reason: None,
                        list_status: "watchlist".into(),
                        card_snapshot: None,
                    }),
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::VocabListStatusSet {
                        id: "v1".into(),
                        list_status: "confirmed".into(),
                        card_snapshot: Some(snapshot.clone()),
                    },
                ),
                // A later promotion-shaped event with no snapshot (replaying
                // the same save, or a different device's plain promotion)
                // must not wipe the one already stored.
                ev(
                    1300,
                    "dev-A",
                    EventBody::VocabListStatusSet {
                        id: "v1".into(),
                        list_status: "confirmed".into(),
                        card_snapshot: None,
                    },
                ),
            ],
        );
        let (list_status, stored): (String, Option<String>) = db
            .query_row(
                "SELECT list_status, card_snapshot FROM vocab_words WHERE id = 'v1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(list_status, "confirmed");
        assert_eq!(stored, Some(snapshot));
    }

    // --- vocab.definition.set ---

    /// A saved word as the adding device published it. `definition` is the
    /// only field these tests vary.
    fn add_vocab(id: &str, definition: &str, explanation: Option<&str>) -> EventBody {
        EventBody::VocabAdd(VocabPayload {
            id: id.into(),
            book_id: "b1".into(),
            word: "thither".into(),
            definition: definition.into(),
            context_sentence: Some("She went thither at once.".into()),
            context_explanation: explanation.map(str::to_string),
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
            mastery_source: "manual".into(),
            mastery_reason: None,
            list_status: "confirmed".into(),
            card_snapshot: None,
        })
    }

    fn definition_set(id: &str, definition: &str) -> EventBody {
        EventBody::VocabDefinitionSet {
            id: id.into(),
            definition: definition.into(),
        }
    }

    fn vocab_gloss(db: &Connection, id: &str) -> (String, Option<String>) {
        db.query_row(
            "SELECT definition, context_explanation FROM vocab_words WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    /// The point of the whole event: one device repairs or regenerates a
    /// gloss, the other stops showing the old one. The blob the *receiver*
    /// held is displaced into `context_explanation` by the receiver, using the
    /// same rule the writing device used on its own copy — which is why the
    /// wire payload carries only the new definition.
    #[test]
    fn a_rewritten_definition_reaches_the_second_device() {
        let mut db = open_db();
        let blob = "Meaning in this context\nto that place, in older English.";
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", blob, None)),
                ev(1200, "dev-B", definition_set("v1", "到那里")),
            ],
        );
        let (definition, explanation) = vocab_gloss(&db, "v1");
        assert_eq!(definition, "到那里");
        assert_eq!(explanation.as_deref(), Some(blob));
        let (at, by): (i64, String) = db
            .query_row(
                "SELECT updated_at, updated_by_device FROM vocab_words WHERE id = 'v1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((at, by.as_str()), (1200, "dev-B"));
    }

    /// Replay is at-least-once. The second delivery finds an equal clock and
    /// must not run the displacement again, which would file the gloss it just
    /// wrote under "In context".
    #[test]
    fn a_redelivered_definition_changes_nothing() {
        let mut db = open_db();
        let blob = "Meaning in this context\nto that place.";
        let again = ev(1200, "dev-B", definition_set("v1", "到那里"));
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", blob, None)),
                again.clone(),
                again,
            ],
        );
        assert_eq!(
            vocab_gloss(&db, "v1"),
            ("到那里".to_string(), Some(blob.to_string()))
        );
    }

    /// The receiver's own kept analysis outranks anything being displaced —
    /// same as locally.
    #[test]
    fn an_arriving_definition_never_overwrites_a_kept_explanation() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    add_vocab("v1", "Meaning\nin this context", Some("the reader's own")),
                ),
                ev(1200, "dev-B", definition_set("v1", "到那里")),
            ],
        );
        assert_eq!(
            vocab_gloss(&db, "v1"),
            ("到那里".to_string(), Some("the reader's own".to_string()))
        );
    }

    /// Displacement is for the card blob this feature exists to clear. An
    /// ordinary one-line gloss being replaced is discarded, not filed — the
    /// same narrowing the writing device applies, so the two devices agree.
    #[test]
    fn an_ordinary_gloss_is_discarded_rather_than_filed() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", "到那处", None)),
                ev(1200, "dev-B", definition_set("v1", "到那里")),
            ],
        );
        assert_eq!(vocab_gloss(&db, "v1"), ("到那里".to_string(), None));
    }

    // --- vocab.card.set ---

    fn card_set(
        id: &str,
        definition: &str,
        context_explanation: Option<&str>,
        card_snapshot: Option<&str>,
    ) -> EventBody {
        EventBody::VocabCardSet {
            id: id.into(),
            definition: definition.into(),
            context_explanation: context_explanation.map(str::to_string),
            card_snapshot: card_snapshot.map(str::to_string),
        }
    }

    fn vocab_card(db: &Connection, id: &str) -> (String, Option<String>, Option<String>) {
        db.query_row(
            "SELECT definition, context_explanation, card_snapshot
               FROM vocab_words WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    /// The point of the event: one device regenerates the whole card, the
    /// other shows the new one. All three columns arrive together, so unlike
    /// `vocab.definition.set` nothing is worked out locally.
    #[test]
    fn a_regenerated_card_reaches_the_second_device_whole() {
        let mut db = open_db();
        let snapshot = r#"{"modules":{"word_info":{"summary":"到那里"}}}"#;
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", "到那处", None)),
                ev(
                    1200,
                    "dev-B",
                    card_set(
                        "v1",
                        "到那里",
                        Some("Here it means the manor."),
                        Some(snapshot),
                    ),
                ),
            ],
        );
        assert_eq!(
            vocab_card(&db, "v1"),
            (
                "到那里".to_string(),
                Some("Here it means the manor.".to_string()),
                Some(snapshot.to_string())
            )
        );
        let (at, by): (i64, String) = db
            .query_row(
                "SELECT updated_at, updated_by_device FROM vocab_words WHERE id = 'v1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((at, by.as_str()), (1200, "dev-B"));
    }

    /// The rule that separates this event from `vocab.definition.set`: it does
    /// not displace. The receiver's old definition is not filed under "In
    /// context", because the sending card said what belongs there.
    #[test]
    fn an_arriving_card_writes_the_explanation_it_carries_rather_than_displacing() {
        let mut db = open_db();
        let blob = "Meaning in this context\nto that place, in older English.";
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", blob, None)),
                ev(
                    1200,
                    "dev-B",
                    card_set("v1", "到那里", Some("The new card's paragraph."), None),
                ),
            ],
        );
        let (definition, explanation, _) = vocab_card(&db, "v1");
        assert_eq!(definition, "到那里");
        assert_eq!(explanation.as_deref(), Some("The new card's paragraph."));
        assert_ne!(explanation.as_deref(), Some(blob));
    }

    /// `None` is "this regeneration produced nothing for that column", never
    /// "blank it". Both optional columns, both directions.
    #[test]
    fn an_arriving_card_with_no_snapshot_or_explanation_erases_neither() {
        let mut db = open_db();
        let snapshot = r#"{"modules":{"word_info":{"summary":"到那里"}}}"#;
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    add_vocab("v1", "到那处", Some("the reader's own kept analysis")),
                ),
                ev(
                    1200,
                    "dev-B",
                    card_set("v1", "第一版", None, Some(snapshot)),
                ),
                ev(1300, "dev-B", card_set("v1", "第二版", None, None)),
            ],
        );
        assert_eq!(
            vocab_card(&db, "v1"),
            (
                "第二版".to_string(),
                Some("the reader's own kept analysis".to_string()),
                Some(snapshot.to_string())
            )
        );
    }

    /// Replay is at-least-once, and this arm writes three columns rather than
    /// one — an equal clock has to short-circuit all three the same way.
    #[test]
    fn a_redelivered_card_changes_nothing() {
        let mut db = open_db();
        let snapshot = r#"{"modules":{"word_info":{"summary":"到那里"}}}"#;
        let again = ev(
            1200,
            "dev-B",
            card_set("v1", "到那里", Some("paragraph"), Some(snapshot)),
        );
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", "到那处", None)),
                again.clone(),
                again,
            ],
        );
        assert_eq!(
            vocab_card(&db, "v1"),
            (
                "到那里".to_string(),
                Some("paragraph".to_string()),
                Some(snapshot.to_string())
            )
        );
    }

    /// The existing clock rule, unchanged and now applying to one more column
    /// set: a regeneration older than what the row already carries loses
    /// wholesale, including its snapshot.
    #[test]
    fn a_card_older_than_the_row_loses_every_column() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", "到那处", None)),
                // A newer write of any kind moves the row's clock past 1200.
                ev(1500, "dev-C", definition_set("v1", "最新")),
                ev(
                    1200,
                    "dev-B",
                    card_set("v1", "过时", Some("stale"), Some(r#"{"stale":true}"#)),
                ),
            ],
        );
        let (definition, _, snapshot) = vocab_card(&db, "v1");
        assert_eq!(definition, "最新");
        assert_eq!(snapshot, None);
    }

    /// Delete outranks a card that was still in flight, by the same zero-row
    /// `UPDATE` that covers every other vocab update arm.
    #[test]
    fn a_card_for_a_deleted_word_lands_nowhere() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", "到那处", None)),
                ev(1200, "dev-A", EventBody::VocabDelete { id: "v1".into() }),
                ev(
                    1300,
                    "dev-B",
                    card_set("v1", "到那里", None, Some(r#"{"a":1}"#)),
                ),
            ],
        );
        let rows: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM vocab_words WHERE id = 'v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }

    fn review_append(id: &str, reviewed_at: i64, rating: &str) -> EventBody {
        EventBody::VocabReviewAppend(VocabReviewLogPayload {
            id: id.into(),
            vocab_word_id: "v1".into(),
            reviewed_at,
            rating: rating.into(),
            state_before: None,
            stability_before: None,
            difficulty_before: None,
            elapsed_days: Some(0),
            scheduled_days: Some(1),
            fsrs_version: Some(1),
        })
    }

    fn review_log_ratings(db: &Connection) -> Vec<String> {
        let mut stmt = db
            .prepare("SELECT rating FROM vocab_review_log ORDER BY reviewed_at, id")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap();
        rows.collect::<Result<_, _>>().unwrap()
    }

    /// Re-delivery is normal: a peer that never saw our ack resends, and a
    /// snapshot rebuild replays. For every other event that is harmless
    /// because LWW equality short-circuits. An append has no equality test to
    /// fall back on, so idempotence rests entirely on `INSERT OR IGNORE`
    /// and the id being minted once — which is what this pins.
    #[test]
    fn re_delivering_a_review_does_not_count_it_twice() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", "到那里", None)),
                ev(1200, "dev-A", review_append("rev-1", 1200, "good")),
                ev(1200, "dev-A", review_append("rev-1", 1200, "good")),
            ],
        );
        assert_eq!(review_log_ratings(&db), vec!["good"]);
    }

    /// Two devices reviewing the same word are not in conflict — both reviews
    /// happened. This is the one place in this file where the second write
    /// must *not* displace the first.
    #[test]
    fn two_devices_reviewing_one_word_keep_both_reviews() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", "到那里", None)),
                ev(1200, "dev-A", review_append("rev-a", 1200, "good")),
                ev(1300, "dev-B", review_append("rev-b", 1300, "again")),
            ],
        );
        assert_eq!(review_log_ratings(&db), vec!["good", "again"]);
    }

    /// A review that arrives after the reader deleted the word must not open
    /// a fresh history under a dead id. Same tombstone posture as every add.
    #[test]
    fn a_review_arriving_after_the_word_was_deleted_is_dropped() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_vocab("v1", "到那里", None)),
                ev(1200, "dev-A", EventBody::VocabDelete { id: "v1".into() }),
                ev(1300, "dev-B", review_append("rev-late", 1300, "good")),
            ],
        );
        assert!(review_log_ratings(&db).is_empty());
    }

    /// `definition` shares the row's single clock with `mastery`, so a
    /// definition change and a review made at the same moment on two devices
    /// are ordered against each other rather than merged per column. This
    /// pins the accepted cost: the later one wins the clock, and the earlier
    /// one's column is left as the loser's device had it.
    #[test]
    fn a_definition_losing_the_clock_leaves_the_review_alone() {
        let mastery = EventBody::VocabMasterySet {
            id: "v1".into(),
            mastery: "learning".into(),
            next_review_at: Some(2_000_000),
            review_count: 3,
            review_interval_days: 1,
            last_reviewed_at: Some(1300),
            last_review_rating: Some("good".into()),
            fsrs_stability: None,
            fsrs_difficulty: None,
            fsrs_version: 1,
            mastery_source: "manual".into(),
            mastery_reason: None,
        };
        // Definition first, review second: the review wins the clock and the
        // definition it arrived with is still there — different columns.
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    add_vocab("v1", "Meaning\nin this context", None),
                ),
                ev(1200, "dev-B", definition_set("v1", "到那里")),
                ev(1300, "dev-A", mastery.clone()),
            ],
        );
        let (definition, _) = vocab_gloss(&db, "v1");
        assert_eq!(definition, "到那里");
        let (m, n): (String, i64) = db
            .query_row(
                "SELECT mastery, review_count FROM vocab_words WHERE id = 'v1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((m.as_str(), n), ("learning", 3));

        // Reverse: the definition arrives stamped *older* than the review that
        // already landed. It loses the whole write — the row keeps the blob.
        // That is the shared-clock trade, and it is the same one
        // `vocab.list_status.set` already makes.
        let mut db2 = open_db();
        apply_all(
            &mut db2,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    add_vocab("v1", "Meaning\nin this context", None),
                ),
                ev(1300, "dev-A", mastery),
                ev(1200, "dev-B", definition_set("v1", "到那里")),
            ],
        );
        assert_eq!(
            vocab_gloss(&db2, "v1"),
            ("Meaning\nin this context".to_string(), None)
        );
        let (m2, n2): (String, i64) = db2
            .query_row(
                "SELECT mastery, review_count FROM vocab_words WHERE id = 'v1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (m2.as_str(), n2),
            ("learning", 3),
            "a losing definition must not roll the review back"
        );
    }

    /// The word was deleted here, or its `vocab.add` has not replayed yet.
    /// Neither is an error, and neither may conjure a row: a definition with
    /// no `book_id`, `word` or `context_sentence` is not a saved word, and a
    /// tombstoned one must stay deleted.
    #[test]
    fn a_definition_for_a_word_this_device_does_not_have_is_ignored() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1200, "dev-B", definition_set("ghost", "到那里")),
            ],
        );
        let rows: i64 = db
            .query_row("SELECT COUNT(*) FROM vocab_words", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    // -----------------------------------------------------------------------
    // Determinism (shuffle property)
    // -----------------------------------------------------------------------

    #[test]
    fn shuffled_apply_yields_identical_state() {
        // Build a fixed event set, apply in two different orders, compare
        // every column on every row. Apply order must not matter once events
        // are sorted by (ts, device).
        let events: Vec<Event> = vec![
            ev(1000, "dev-A", import_book("b1")),
            ev(1000, "dev-B", import_book("b2")),
            ev(1100, "dev-A", add_highlight("h1", "b1", "yellow")),
            ev(1200, "dev-B", add_highlight("h2", "b2", "blue")),
            ev(
                1300,
                "dev-A",
                EventBody::HighlightColorSet {
                    id: "h1".into(),
                    color: "pink".into(),
                },
            ),
            ev(
                1400,
                "dev-A",
                EventBody::BookProgressSet {
                    book: "b1".into(),
                    progress: 25,
                    cfi: Some("c25".into()),
                },
            ),
            ev(
                1500,
                "dev-B",
                EventBody::BookProgressSet {
                    book: "b1".into(),
                    progress: 50,
                    cfi: Some("c50".into()),
                },
            ),
            ev(
                1600,
                "dev-A",
                EventBody::CollectionCreate {
                    id: "c1".into(),
                    name: "Top".into(),
                    sort_order: 0,
                },
            ),
            ev(
                1700,
                "dev-A",
                EventBody::CollectionBookAdd {
                    collection: "c1".into(),
                    book: "b1".into(),
                },
            ),
            ev(
                1800,
                "dev-A",
                EventBody::CollectionRename {
                    id: "c1".into(),
                    name: "Favorites".into(),
                },
            ),
            ev(
                1900,
                "dev-B",
                EventBody::HighlightDelete { id: "h2".into() },
            ),
        ];

        let mut sorted = events.clone();
        sorted.sort_by(|a, b| (a.ts, &a.device).cmp(&(b.ts, &b.device)));

        let mut reverse = sorted.clone();
        reverse.reverse();
        // After reversing we still need (ts, device) order before apply (the
        // determinism rule); the property under test is "any pre-sort
        // permutation produces the same state."
        reverse.sort_by(|a, b| (a.ts, &a.device).cmp(&(b.ts, &b.device)));

        let mut db1 = open_db();
        apply_all(&mut db1, &sorted);
        let mut db2 = open_db();
        apply_all(&mut db2, &reverse);

        let dump = |db: &Connection| -> Vec<(String, String)> {
            let tables = [
                "books",
                "highlights",
                "notes",
                "vocab_words",
                "collections",
                "collection_books",
                "chats",
                "chat_messages",
                "_tombstones",
            ];
            let mut out = Vec::new();
            for t in tables {
                let mut stmt = db
                    .prepare(&format!("SELECT * FROM {t} ORDER BY 1, 2"))
                    .unwrap();
                let cols = stmt.column_count();
                let rows = stmt
                    .query_map([], |r| {
                        let mut s = String::new();
                        for i in 0..cols {
                            let v: rusqlite::types::Value = r.get(i)?;
                            s.push_str(&format!("{v:?}|"));
                        }
                        Ok(s)
                    })
                    .unwrap();
                for row in rows {
                    out.push((t.to_string(), row.unwrap()));
                }
            }
            out
        };
        assert_eq!(dump(&db1), dump(&db2), "shuffle changed final state");
    }

    // -----------------------------------------------------------------------
    // book.metadata.set
    // -----------------------------------------------------------------------

    #[test]
    fn book_metadata_set_updates_string_field_under_lww() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookMetadataSet {
                        book: "b1".into(),
                        field: "author".into(),
                        value: json!("Leo Tolstoy"),
                    },
                ),
            ],
        );
        let author: String = db
            .query_row("SELECT author FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(author, "Leo Tolstoy");
    }

    #[test]
    fn book_metadata_set_pages_accepts_number_and_null() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookMetadataSet {
                        book: "b1".into(),
                        field: "pages".into(),
                        value: json!(1225),
                    },
                ),
            ],
        );
        let pages: Option<i64> = db
            .query_row("SELECT pages FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pages, Some(1225));

        apply_all(
            &mut db,
            &[ev(
                3000,
                "dev-A",
                EventBody::BookMetadataSet {
                    book: "b1".into(),
                    field: "pages".into(),
                    value: Value::Null,
                },
            )],
        );
        let pages: Option<i64> = db
            .query_row("SELECT pages FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pages, None);
    }

    #[test]
    fn book_metadata_unknown_field_is_skipped() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookMetadataSet {
                        book: "b1".into(),
                        field: "future_field".into(),
                        value: json!("anything"),
                    },
                ),
            ],
        );
        // No panic, no crash; row's updated_at is unchanged from the import.
        let ts: i64 = db
            .query_row("SELECT updated_at FROM books WHERE id = 'b1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(ts, 1000);
    }

    // -----------------------------------------------------------------------
    // collection_books composite-key tombstone
    // -----------------------------------------------------------------------

    #[test]
    fn collection_book_remove_then_add_blocked_by_composite_tombstone() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
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
                ev(
                    1300,
                    "dev-A",
                    EventBody::CollectionBookRemove {
                        collection: "c1".into(),
                        book: "b1".into(),
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
            ],
        );
        let n: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM collection_books WHERE collection_id = 'c1' AND book_id = 'b1'",
                [], |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "composite tombstone should suppress re-add");
    }

    // -----------------------------------------------------------------------
    // Idempotency under repeated apply
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Regression tests for PR #189 review findings.
    // -----------------------------------------------------------------------

    #[test]
    fn chat_message_add_bumps_parent_chat_updated_at() {
        // Mirrors the live `add_chat_message` command's two-table write —
        // the chat's recency drives chat-list ordering on every device, so
        // peers must see the bump.
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::ChatCreate {
                        id: "ch1".into(),
                        book: "b1".into(),
                        title: "New chat".into(),
                        model: None,
                    },
                ),
                ev(
                    5000,
                    "dev-A",
                    EventBody::ChatMessageAdd(ChatMessagePayload {
                        id: "m1".into(),
                        chat_id: "ch1".into(),
                        role: "user".into(),
                        content: "hi".into(),
                        context: None,
                        metadata: None,
                    }),
                ),
            ],
        );
        let (chat_ts, by): (i64, String) = db
            .query_row(
                "SELECT updated_at, updated_by_device FROM chats WHERE id = 'ch1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(chat_ts, 5000, "message ts should bump parent chat");
        assert_eq!(by, "dev-A");
    }

    #[test]
    fn chat_message_add_does_not_drag_chat_updated_at_backward() {
        // Rename happens at T=10_000 on dev-A; older message arrives at
        // T=5_000 from dev-B. Chat updated_at must stay at the rename ts.
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::ChatCreate {
                        id: "ch1".into(),
                        book: "b1".into(),
                        title: "Old".into(),
                        model: None,
                    },
                ),
                ev(
                    10_000,
                    "dev-A",
                    EventBody::ChatRename {
                        id: "ch1".into(),
                        title: "New".into(),
                    },
                ),
                ev(
                    5_000,
                    "dev-B",
                    EventBody::ChatMessageAdd(ChatMessagePayload {
                        id: "m1".into(),
                        chat_id: "ch1".into(),
                        role: "user".into(),
                        content: "hi".into(),
                        context: None,
                        metadata: None,
                    }),
                ),
            ],
        );
        let chat_ts: i64 = db
            .query_row("SELECT updated_at FROM chats WHERE id = 'ch1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(chat_ts, 10_000, "older message must not drag chat backward");
    }

    #[test]
    fn chat_message_replace_is_lww_and_cannot_create_or_replace_user_messages() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::ChatCreate {
                        id: "ch1".into(),
                        book: "b1".into(),
                        title: "Chat".into(),
                        model: None,
                    },
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::ChatMessageAdd(ChatMessagePayload {
                        id: "assistant".into(),
                        chat_id: "ch1".into(),
                        role: "assistant".into(),
                        content: "old".into(),
                        context: None,
                        metadata: None,
                    }),
                ),
                ev(
                    1300,
                    "dev-A",
                    EventBody::ChatMessageAdd(ChatMessagePayload {
                        id: "user".into(),
                        chat_id: "ch1".into(),
                        role: "user".into(),
                        content: "question".into(),
                        context: None,
                        metadata: None,
                    }),
                ),
                ev(
                    1500,
                    "dev-B",
                    EventBody::ChatMessageReplace(ChatMessagePayload {
                        id: "assistant".into(),
                        chat_id: "ch1".into(),
                        role: "assistant".into(),
                        content: "new".into(),
                        context: None,
                        metadata: Some("{}".into()),
                    }),
                ),
                ev(
                    1400,
                    "dev-C",
                    EventBody::ChatMessageReplace(ChatMessagePayload {
                        id: "assistant".into(),
                        chat_id: "ch1".into(),
                        role: "assistant".into(),
                        content: "stale".into(),
                        context: None,
                        metadata: None,
                    }),
                ),
                ev(
                    1600,
                    "dev-B",
                    EventBody::ChatMessageReplace(ChatMessagePayload {
                        id: "missing".into(),
                        chat_id: "ch1".into(),
                        role: "assistant".into(),
                        content: "must not insert".into(),
                        context: None,
                        metadata: None,
                    }),
                ),
                ev(
                    1700,
                    "dev-B",
                    EventBody::ChatMessageReplace(ChatMessagePayload {
                        id: "user".into(),
                        chat_id: "ch1".into(),
                        role: "assistant".into(),
                        content: "must not replace".into(),
                        context: None,
                        metadata: None,
                    }),
                ),
            ],
        );
        let assistant: (String, Option<String>, i64, String) = db
            .query_row(
                "SELECT content, metadata, updated_at, updated_by_device
                 FROM chat_messages WHERE id = 'assistant'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            assistant,
            ("new".into(), Some("{}".into()), 1500, "dev-B".into())
        );
        let user: String = db
            .query_row(
                "SELECT content FROM chat_messages WHERE id = 'user'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(user, "question");
        let missing: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE id = 'missing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(missing, 0);
    }

    #[test]
    fn book_metadata_multi_field_same_tx_both_apply() {
        // The live `update_book_metadata` command can rewrite title and
        // author in one transaction, producing two `book.metadata.set`
        // events with identical (ts, device). With strict `<` LWW the
        // second event's field would silently fail to land. This test
        // pins the `<=` relaxation.
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookMetadataSet {
                        book: "b1".into(),
                        field: "title".into(),
                        value: json!("New Title"),
                    },
                ),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookMetadataSet {
                        book: "b1".into(),
                        field: "author".into(),
                        value: json!("New Author"),
                    },
                ),
            ],
        );
        let (title, author): (String, String) = db
            .query_row("SELECT title, author FROM books WHERE id = 'b1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(title, "New Title", "first metadata.set must land");
        assert_eq!(author, "New Author", "second metadata.set must also land");
    }

    // -----------------------------------------------------------------------
    // Late-child-add suppression after a parent delete.
    //
    // Scenario from PR #189 review: device-A creates the join row before
    // going offline, device-B deletes the parent and publishes, devices
    // converge, then device-A comes back and publishes its older event.
    // Without parent-tombstone checks the older event resurrects the join
    // and inflates `list_collections` counts. The same shape applies to
    // every child entity (highlights, bookmarks, vocab, chats, chat
    // messages).
    // -----------------------------------------------------------------------

    #[test]
    fn late_collection_book_add_after_book_delete_is_suppressed() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::CollectionCreate {
                        id: "c1".into(),
                        name: "Top".into(),
                        sort_order: 0,
                    },
                ),
                // dev-B deletes the book at T=2000.
                ev(2000, "dev-B", EventBody::BookDelete { id: "b1".into() }),
                // dev-A's older `collection.book.add(c1, b1)` arrives late
                // (T=1500 < 2000). Sorted-apply order is delete-then-add,
                // but cross-tick this ordering breaks down — assert the add
                // is suppressed regardless.
                ev(
                    1500,
                    "dev-A",
                    EventBody::CollectionBookAdd {
                        collection: "c1".into(),
                        book: "b1".into(),
                    },
                ),
            ],
        );
        let n: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM collection_books WHERE collection_id = 'c1' AND book_id = 'b1'",
                [], |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            n, 0,
            "collection.book.add must not resurrect a tombstoned book's join row"
        );
    }

    #[test]
    fn late_collection_book_add_suppressed_across_ticks() {
        // The same scenario but across two apply batches — mirrors the
        // multi-tick replay path described in the review (dev-B's delete
        // event applied in tick 1; dev-A's stale add arrives in tick 2).
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::CollectionCreate {
                        id: "c1".into(),
                        name: "Top".into(),
                        sort_order: 0,
                    },
                ),
                ev(2000, "dev-B", EventBody::BookDelete { id: "b1".into() }),
            ],
        );
        // Now a second tick brings the late add.
        apply_all(
            &mut db,
            &[ev(
                1500,
                "dev-A",
                EventBody::CollectionBookAdd {
                    collection: "c1".into(),
                    book: "b1".into(),
                },
            )],
        );
        let n: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM collection_books WHERE collection_id = 'c1' AND book_id = 'b1'",
                [], |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "late tick must still see the parent tombstone");
    }

    #[test]
    fn late_highlight_add_after_book_delete_is_suppressed() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-B", EventBody::BookDelete { id: "b1".into() }),
            ],
        );
        apply_all(
            &mut db,
            &[ev(1500, "dev-A", add_highlight("h-late", "b1", "yellow"))],
        );
        let n: i64 = db
            .query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "highlight on a tombstoned book must be suppressed");
    }

    #[test]
    fn late_chat_message_after_book_delete_is_suppressed() {
        // Cascade-deleting a book also tombstones each cascaded chat, so a
        // delayed `chat.message.add` for one of those chats stays out.
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::ChatCreate {
                        id: "ch1".into(),
                        book: "b1".into(),
                        title: "T".into(),
                        model: None,
                    },
                ),
                ev(2000, "dev-B", EventBody::BookDelete { id: "b1".into() }),
            ],
        );
        apply_all(
            &mut db,
            &[ev(
                1500,
                "dev-A",
                EventBody::ChatMessageAdd(ChatMessagePayload {
                    id: "m1".into(),
                    chat_id: "ch1".into(),
                    role: "user".into(),
                    content: "hi".into(),
                    context: None,
                    metadata: None,
                }),
            )],
        );
        let n: i64 = db
            .query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "message for cascade-deleted chat must be suppressed");
    }

    #[test]
    fn suppressed_chat_create_writes_tombstone_blocking_late_message() {
        // Exact scenario from the second review pass:
        //   tick 1: book.delete(b1) applied — book is tombstoned, no
        //     chat existed locally so cascade_delete_book wrote nothing.
        //   tick 2: stale chat.create(ch1, b1) arrives. Parent book is
        //     tombstoned → suppressed. Without this fix, no chat tombstone
        //     gets written.
        //   tick 3: stale chat.message.add(m1, chat_id=ch1) arrives. The
        //     message arm checks (chat, ch1) tombstone, sees nothing, and
        //     would insert an orphan.
        let mut db = open_db();
        // Tick 1: book imported, then deleted.
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-B", EventBody::BookDelete { id: "b1".into() }),
            ],
        );
        // Tick 2: late chat.create arrives.
        apply_all(
            &mut db,
            &[ev(
                1500,
                "dev-A",
                EventBody::ChatCreate {
                    id: "ch1".into(),
                    book: "b1".into(),
                    title: "T".into(),
                    model: None,
                },
            )],
        );
        let n_chats: i64 = db
            .query_row("SELECT COUNT(*) FROM chats WHERE id = 'ch1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            n_chats, 0,
            "chat.create must be suppressed by book tombstone"
        );

        let chat_tomb: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'chat' AND id = 'ch1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            chat_tomb, 1,
            "suppressed chat.create must leave a chat tombstone"
        );

        // Tick 3: late chat.message.add arrives. The chat tombstone from
        // tick 2 must block the orphan insert.
        apply_all(
            &mut db,
            &[ev(
                1600,
                "dev-A",
                EventBody::ChatMessageAdd(ChatMessagePayload {
                    id: "m1".into(),
                    chat_id: "ch1".into(),
                    role: "user".into(),
                    content: "hi".into(),
                    context: None,
                    metadata: None,
                }),
            )],
        );
        let n_msgs: i64 = db
            .query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            n_msgs, 0,
            "message for suppressed chat must not slip in as an orphan"
        );
    }

    #[test]
    fn cascaded_chat_tombstones_carry_event_ts_not_wall_clock() {
        // Regression for the determinism finding. cascade_delete_book
        // previously stamped per-chat tombstones with `Utc::now()`, which
        // diverges across replay runs and corrupts snapshot equivalence.
        // Pin: the cascaded chat's `_tombstones.ts` must equal the
        // book.delete event's ts.
        let mut db = open_db();
        const DELETE_TS: i64 = 5_000;
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::ChatCreate {
                        id: "ch1".into(),
                        book: "b1".into(),
                        title: "T".into(),
                        model: None,
                    },
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::ChatCreate {
                        id: "ch2".into(),
                        book: "b1".into(),
                        title: "T2".into(),
                        model: None,
                    },
                ),
                ev(
                    DELETE_TS,
                    "dev-B",
                    EventBody::BookDelete { id: "b1".into() },
                ),
            ],
        );

        let rows: Vec<(String, i64)> = {
            let mut stmt = db
                .prepare("SELECT id, ts FROM _tombstones WHERE entity = 'chat' ORDER BY id")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert_eq!(
            rows,
            vec![
                ("ch1".to_string(), DELETE_TS),
                ("ch2".to_string(), DELETE_TS)
            ],
            "cascaded chat tombstones must use the book.delete event ts"
        );
    }

    #[test]
    fn double_apply_is_a_noop() {
        let events = vec![
            ev(1000, "dev-A", import_book("b1")),
            ev(1100, "dev-A", add_highlight("h1", "b1", "yellow")),
            ev(
                1200,
                "dev-A",
                EventBody::HighlightColorSet {
                    id: "h1".into(),
                    color: "pink".into(),
                },
            ),
        ];
        let mut db = open_db();
        apply_all(&mut db, &events);
        // Snapshot the row state, then re-apply.
        let before: (String, i64, String) = db
            .query_row(
                "SELECT color, updated_at, updated_by_device FROM highlights WHERE id = 'h1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        apply_all(&mut db, &events);
        let after: (String, i64, String) = db
            .query_row(
                "SELECT color, updated_at, updated_by_device FROM highlights WHERE id = 'h1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(before, after);
    }

    // -----------------------------------------------------------------------
    // Imported fonts.
    // -----------------------------------------------------------------------

    /// Fonts are content-addressed, so this is the id every device derives for
    /// the same file.
    const FONT_ID: &str = "custom-aa00000000000000000000000000000000000000000000000000000000ff00";
    const FONT_FILE: &str = "aa00000000000000000000000000000000000000000000000000000000ff00.ttf";

    fn font_event(family: &str) -> EventBody {
        EventBody::CustomFontUpsert(CustomFontPayload {
            id: FONT_ID.to_string(),
            family_name: family.to_string(),
            file_name: FONT_FILE.to_string(),
            format: "ttf".to_string(),
            file_size: 4096,
            created_at: 1_700_000_000_000,
        })
    }

    fn font_family(conn: &Connection) -> Option<String> {
        conn.query_row(
            "SELECT family_name FROM custom_fonts WHERE id = ?1",
            params![FONT_ID],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn custom_font_upsert_applies_and_is_idempotent() {
        let mut conn = open_db();
        let event = ev(1_000, "dev-a", font_event("Iosevka"));
        apply_all(&mut conn, std::slice::from_ref(&event));
        assert_eq!(font_family(&conn).as_deref(), Some("Iosevka"));

        // Replaying the same event must not change anything: the LWW compare is
        // strictly-less-than, so an equal tuple short-circuits.
        apply_all(&mut conn, &[event]);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM custom_fonts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn custom_font_lww_prefers_newer_and_ignores_older() {
        let mut conn = open_db();
        apply_all(&mut conn, &[ev(2_000, "dev-a", font_event("Newer"))]);
        apply_all(&mut conn, &[ev(1_000, "dev-b", font_event("Older"))]);
        assert_eq!(font_family(&conn).as_deref(), Some("Newer"));

        apply_all(&mut conn, &[ev(3_000, "dev-b", font_event("Newest"))]);
        assert_eq!(font_family(&conn).as_deref(), Some("Newest"));
    }

    #[test]
    fn custom_font_lww_breaks_timestamp_ties_by_device() {
        let mut conn = open_db();
        apply_all(&mut conn, &[ev(2_000, "dev-a", font_event("From A"))]);
        // Same logical timestamp: the higher device id wins, deterministically
        // and identically on every peer.
        apply_all(&mut conn, &[ev(2_000, "dev-b", font_event("From B"))]);
        assert_eq!(font_family(&conn).as_deref(), Some("From B"));

        apply_all(&mut conn, &[ev(2_000, "dev-a", font_event("From A again"))]);
        assert_eq!(font_family(&conn).as_deref(), Some("From B"));
    }

    #[test]
    fn custom_font_delete_downgrades_selections_and_tombstones() {
        let mut conn = open_db();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('b1','T','A','books/test.epub','reading',0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('font_family', ?1)",
            params![FONT_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO book_settings (book_id, key, value) VALUES ('b1', 'font', ?1)",
            params![FONT_ID],
        )
        .unwrap();
        apply_all(&mut conn, &[ev(1_000, "dev-a", font_event("Doomed"))]);
        apply_all(
            &mut conn,
            &[ev(
                2_000,
                "dev-a",
                EventBody::CustomFontDelete {
                    id: FONT_ID.to_string(),
                },
            )],
        );

        assert!(font_family(&conn).is_none());
        let global: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'font_family'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(global, "system");
        let per_book: String = conn
            .query_row(
                "SELECT value FROM book_settings WHERE book_id = 'b1' AND key = 'font'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(per_book, "system");
        let tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'custom_font' AND id = ?1",
                params![FONT_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned, 1);
    }

    /// A font id is a hash of the file's bytes, so it is the only id that file
    /// can ever have. A permanent tombstone would mean "delete once, never
    /// import again" — the tombstone must therefore be clearable by a strictly
    /// newer upsert, while still suppressing an older one.
    #[test]
    fn deleted_custom_font_can_be_reimported_but_not_resurrected_by_stale_event() {
        let mut conn = open_db();
        apply_all(&mut conn, &[ev(1_000, "dev-a", font_event("First"))]);
        apply_all(
            &mut conn,
            &[ev(
                2_000,
                "dev-a",
                EventBody::CustomFontDelete {
                    id: FONT_ID.to_string(),
                },
            )],
        );

        // A peer's upsert issued before the delete must stay dead.
        apply_all(&mut conn, &[ev(1_500, "dev-b", font_event("Stale"))]);
        assert!(font_family(&conn).is_none());

        // Re-importing the same file afterwards brings it back.
        apply_all(&mut conn, &[ev(3_000, "dev-b", font_event("Reimported"))]);
        assert_eq!(font_family(&conn).as_deref(), Some("Reimported"));
        let tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'custom_font' AND id = ?1",
                params![FONT_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned, 0);
    }

    /// A delete that lost the race against a newer local change is discarded,
    /// so a re-selection on another device is not clobbered by a stale delete.
    #[test]
    fn stale_custom_font_delete_loses_to_newer_row() {
        let mut conn = open_db();
        apply_all(&mut conn, &[ev(5_000, "dev-a", font_event("Current"))]);
        apply_all(
            &mut conn,
            &[ev(
                1_000,
                "dev-b",
                EventBody::CustomFontDelete {
                    id: FONT_ID.to_string(),
                },
            )],
        );
        assert_eq!(font_family(&conn).as_deref(), Some("Current"));
    }

    // -----------------------------------------------------------------------
    // Whitelisted settings.
    // -----------------------------------------------------------------------

    fn setting_event(book: Option<&str>, key: &str, value: &str) -> EventBody {
        EventBody::SettingSet(SettingPayload {
            book: book.map(str::to_string),
            key: key.to_string(),
            value: Some(value.to_string()),
        })
    }

    fn setting_delete_event(book: &str, key: &str) -> EventBody {
        EventBody::SettingSet(SettingPayload {
            book: Some(book.to_string()),
            key: key.to_string(),
            value: None,
        })
    }

    fn global_setting_delete_event(key: &str) -> EventBody {
        EventBody::SettingSet(SettingPayload {
            book: None,
            key: key.to_string(),
            value: None,
        })
    }

    fn setting_tombstone_ts(conn: &Connection, key: &str) -> Option<i64> {
        conn.query_row(
            "SELECT ts FROM _tombstones WHERE entity = 'setting' AND id = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    fn setting_value(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn setting_set_applies_font_family_with_lww() {
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[ev(
                2_000,
                "dev-a",
                setting_event(None, "font_family", FONT_ID),
            )],
        );
        assert_eq!(
            setting_value(&conn, "font_family").as_deref(),
            Some(FONT_ID)
        );

        apply_all(
            &mut conn,
            &[ev(
                1_000,
                "dev-b",
                setting_event(None, "font_family", "system"),
            )],
        );
        assert_eq!(
            setting_value(&conn, "font_family").as_deref(),
            Some(FONT_ID)
        );

        apply_all(
            &mut conn,
            &[ev(
                3_000,
                "dev-b",
                setting_event(None, "font_family", "system"),
            )],
        );
        assert_eq!(
            setting_value(&conn, "font_family").as_deref(),
            Some("system")
        );
    }

    /// Marker visibility follows the user, so a peer's choice has to land in
    /// this device's `settings` table — and lose to a later local one, since
    /// the four toggles are ordinary LWW rows with no special ordering.
    #[test]
    fn marker_visibility_crosses_globally_and_obeys_lww() {
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[ev(
                2_000,
                "dev-a",
                setting_event(None, "show_mastered_markers", "false"),
            )],
        );
        assert_eq!(
            setting_value(&conn, "show_mastered_markers").as_deref(),
            Some("false"),
            "a peer's global marker choice must be applied, not skipped"
        );

        apply_all(
            &mut conn,
            &[ev(
                1_000,
                "dev-b",
                setting_event(None, "show_mastered_markers", "true"),
            )],
        );
        assert_eq!(
            setting_value(&conn, "show_mastered_markers").as_deref(),
            Some("false"),
            "an older write must not win"
        );

        apply_all(
            &mut conn,
            &[ev(
                3_000,
                "dev-b",
                setting_event(None, "show_mastered_markers", "true"),
            )],
        );
        assert_eq!(
            setting_value(&conn, "show_mastered_markers").as_deref(),
            Some("true")
        );
    }

    /// The per-book layer has to travel with the global one. Both halves are
    /// checked here: the override arriving, and its removal arriving — the
    /// latter is the only way "this book follows the global again" can reach
    /// another device, and unlike the global layer it *is* expressible.
    #[test]
    fn per_book_marker_override_and_its_removal_both_cross() {
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[ev(
                1_000,
                "dev-a",
                setting_event(Some("b1"), "show_learning_markers", "false"),
            )],
        );
        let override_value = |conn: &Connection| {
            conn.query_row(
                "SELECT value FROM book_settings
                 WHERE book_id = 'b1' AND key = 'show_learning_markers'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .unwrap()
        };
        assert_eq!(override_value(&conn).as_deref(), Some("false"));

        apply_all(
            &mut conn,
            &[ev(
                2_000,
                "dev-b",
                setting_delete_event("b1", "show_learning_markers"),
            )],
        );
        assert_eq!(override_value(&conn), None);

        // The tombstone has to hold, or a peer snapshot still carrying the
        // old row would silently re-hide the markers.
        apply_all(
            &mut conn,
            &[ev(
                1_500,
                "dev-a",
                setting_event(Some("b1"), "show_learning_markers", "false"),
            )],
        );
        assert_eq!(override_value(&conn), None);
    }

    #[test]
    fn per_book_setting_delete_blocks_stale_recreation_but_allows_newer_choice() {
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[ev(
                1_000,
                "dev-a",
                setting_event(Some("b1"), "font", "literata"),
            )],
        );
        apply_all(
            &mut conn,
            &[ev(2_000, "dev-b", setting_delete_event("b1", "font"))],
        );

        let count = |conn: &Connection| {
            conn.query_row(
                "SELECT COUNT(*) FROM book_settings WHERE book_id = 'b1' AND key = 'font'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
        };
        assert_eq!(count(&conn), 0);

        apply_all(
            &mut conn,
            &[ev(
                1_500,
                "dev-c",
                setting_event(Some("b1"), "font", "stale"),
            )],
        );
        assert_eq!(count(&conn), 0);

        apply_all(
            &mut conn,
            &[ev(
                3_000,
                "dev-c",
                setting_event(Some("b1"), "font", "newer"),
            )],
        );
        assert_eq!(count(&conn), 1);
        let tombstones: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _tombstones
                 WHERE entity = 'book_setting' AND id = 'b1:font'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tombstones, 0);
    }

    /// The book-source list travels as one JSON blob, so "last write wins"
    /// means the winner's *entire list* replaces the loser's. This test states
    /// that plainly, because it is the one property of the key a reader is
    /// likely to be surprised by: the site only device A knew about is gone
    /// after device B's later edit, not merged into it.
    #[test]
    fn book_sources_cross_as_one_blob_and_replace_the_whole_list() {
        const CURATED: &str =
            r#"[{"id":"user:1","name":"My site","url":"https://example.com/","kind":"library"}]"#;
        const OTHER: &str = r#"[{"id":"builtin:gutenberg","name":"Project Gutenberg","url":"https://www.gutenberg.org/","kind":"library"}]"#;

        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[ev(
                2_000,
                "dev-a",
                setting_event(None, "book_sources", CURATED),
            )],
        );
        assert_eq!(
            setting_value(&conn, "book_sources").as_deref(),
            Some(CURATED),
            "a peer's book-source list must be applied, not skipped"
        );

        apply_all(
            &mut conn,
            &[ev(
                1_000,
                "dev-b",
                setting_event(None, "book_sources", OTHER),
            )],
        );
        assert_eq!(
            setting_value(&conn, "book_sources").as_deref(),
            Some(CURATED),
            "an older list must not win"
        );

        apply_all(
            &mut conn,
            &[ev(
                3_000,
                "dev-b",
                setting_event(None, "book_sources", OTHER),
            )],
        );
        assert_eq!(
            setting_value(&conn, "book_sources").as_deref(),
            Some(OTHER),
            "the newer list replaces the old one whole — `user:1` is gone, \
             not merged, and that is the accepted cost of one-blob storage"
        );
    }

    /// Why a fresh device renders the built-in book sources instead of seeding
    /// them (`resolveBookSources` in `src/components/book-sources.ts`). Both
    /// halves are here: what happens now, and what the seed would have done.
    #[test]
    fn a_fresh_device_takes_a_peers_book_sources_because_it_seeded_nothing() {
        const CURATED: &str =
            r#"[{"id":"user:1","name":"My site","url":"https://example.com/","kind":"library"}]"#;
        const DEFAULTS: &str = r#"[{"id":"builtin:gutenberg","name":"Project Gutenberg","url":"https://www.gutenberg.org/","kind":"library"}]"#;

        // Device B has just launched and has no `book_sources` row at all,
        // because showing the defaults no longer writes them. The list device A
        // curated yesterday arrives afterwards and lands.
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[ev(
                1_000,
                "dev-a",
                setting_event(None, "book_sources", CURATED),
            )],
        );
        assert_eq!(
            setting_value(&conn, "book_sources").as_deref(),
            Some(CURATED),
            "nothing local should have stood between the user and their own list"
        );

        // The counterfactual, with the seed left in: device B stamps the
        // defaults with its own clock, which necessarily runs later than A's
        // edit, so A's list loses the LWW compare here — and because the
        // writer publishes whitelisted keys, the seed would have gone on to
        // overwrite A's list on A as well.
        let mut seeded = open_db();
        seeded
            .execute(
                "INSERT INTO settings (key, value, updated_at, updated_by_device)
                 VALUES ('book_sources', ?1, ?2, 'dev-b')",
                params![DEFAULTS, 9_000_i64],
            )
            .unwrap();
        apply_all(
            &mut seeded,
            &[ev(
                1_000,
                "dev-a",
                setting_event(None, "book_sources", CURATED),
            )],
        );
        assert_eq!(
            setting_value(&seeded, "book_sources").as_deref(),
            Some(DEFAULTS),
            "this is the data loss the seed caused; the fix is to not write"
        );
    }

    /// A key outside the whitelist is skipped, **not** rejected. A validation
    /// error would leave the peer's watermark parked on the offending event
    /// forever, so a newer Lantern that syncs one more key must not be able to
    /// wedge an older peer's replay.
    #[test]
    fn setting_set_skips_non_whitelisted_keys_without_erroring() {
        let mut conn = open_db();
        let tx = conn.transaction().unwrap();
        apply_event(
            &tx,
            &ev(1_000, "dev-a", setting_event(None, "theme", "dark")),
        )
        .expect("non-whitelisted key must not error");
        apply_event(
            &tx,
            &ev(1_000, "dev-a", setting_event(Some("b1"), "fontSize", "22")),
        )
        .expect("non-whitelisted per-book key must not error");
        // Adjacent to a whitelisted key by name and nothing else: whether a
        // device has finished setting itself up is that device's business.
        apply_event(
            &tx,
            &ev(
                1_000,
                "dev-a",
                setting_event(None, "book_sources_seeded", "true"),
            ),
        )
        .expect("a per-device flag must not error either");
        tx.commit().unwrap();

        assert!(setting_value(&conn, "theme").is_none());
        assert!(setting_value(&conn, "book_sources_seeded").is_none());
        let per_book: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(per_book, 0);
    }

    /// The global layer's half of the same story the per-book test above
    /// tells. "Go back to the default" is a deletion, and until it had a
    /// tombstone the peer's next snapshot handed the old value straight back.
    #[test]
    fn global_setting_delete_crosses_and_blocks_a_stale_write() {
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[ev(
                1_000,
                "dev-a",
                setting_event(None, "font_family", "literata"),
            )],
        );
        assert_eq!(
            setting_value(&conn, "font_family").as_deref(),
            Some("literata")
        );

        apply_all(
            &mut conn,
            &[ev(
                2_000,
                "dev-b",
                global_setting_delete_event("font_family"),
            )],
        );
        assert_eq!(setting_value(&conn, "font_family"), None);
        assert_eq!(setting_tombstone_ts(&conn, "font_family"), Some(2_000));

        // A write from before the delete is exactly what a lagging peer's
        // snapshot replays. It must not resurrect the row.
        apply_all(
            &mut conn,
            &[ev(
                1_500,
                "dev-c",
                setting_event(None, "font_family", "stale"),
            )],
        );
        assert_eq!(setting_value(&conn, "font_family"), None);

        // ...but the tombstone is clearable, or "restore the default" would
        // mean "never choose this key again".
        apply_all(
            &mut conn,
            &[ev(
                3_000,
                "dev-c",
                setting_event(None, "font_family", "newer"),
            )],
        );
        assert_eq!(
            setting_value(&conn, "font_family").as_deref(),
            Some("newer")
        );
        assert_eq!(setting_tombstone_ts(&conn, "font_family"), None);
    }

    /// The other direction: a delete that arrives *after* a newer write has
    /// already landed loses, exactly as an older write would.
    #[test]
    fn global_setting_delete_loses_to_an_already_newer_write() {
        let mut conn = open_db();
        apply_all(
            &mut conn,
            &[ev(
                3_000,
                "dev-a",
                setting_event(None, "show_mastered_markers", "false"),
            )],
        );
        apply_all(
            &mut conn,
            &[ev(
                2_000,
                "dev-b",
                global_setting_delete_event("show_mastered_markers"),
            )],
        );
        assert_eq!(
            setting_value(&conn, "show_mastered_markers").as_deref(),
            Some("false"),
            "a delete older than the stored row must not remove it"
        );
    }

    /// Delivery order is not something either device controls, so the pair
    /// {write, delete} has to land on the same answer whichever way round it
    /// arrives — for both orderings of the two timestamps.
    #[test]
    fn global_setting_write_and_delete_converge_in_either_delivery_order() {
        let write = ev(
            2_000,
            "dev-a",
            setting_event(None, "font_family", "literata"),
        );
        let delete_after = ev(3_000, "dev-b", global_setting_delete_event("font_family"));
        let delete_before = ev(1_000, "dev-b", global_setting_delete_event("font_family"));

        for (label, delete, expected) in [
            ("delete wins", &delete_after, None),
            ("write wins", &delete_before, Some("literata")),
        ] {
            let mut forward = open_db();
            apply_all(&mut forward, &[write.clone(), delete.clone()]);
            let mut backward = open_db();
            apply_all(&mut backward, &[delete.clone(), write.clone()]);
            assert_eq!(
                setting_value(&forward, "font_family").as_deref(),
                expected,
                "{label}: forward order disagreed"
            );
            assert_eq!(
                setting_value(&backward, "font_family").as_deref(),
                expected,
                "{label}: reverse order disagreed"
            );
        }
    }

    /// `settings` is also where the AI credential pointers and every
    /// per-screen preference live. A delete for a key outside the whitelist is
    /// skipped on the same terms as a write for one — silently, so it cannot
    /// wedge a peer's watermark, but without touching the row.
    #[test]
    fn global_setting_delete_ignores_non_whitelisted_keys() {
        let mut conn = open_db();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('reader_theme', 'night')",
            [],
        )
        .unwrap();
        apply_all(
            &mut conn,
            &[ev(
                9_000,
                "dev-a",
                global_setting_delete_event("reader_theme"),
            )],
        );
        assert_eq!(
            setting_value(&conn, "reader_theme").as_deref(),
            Some("night")
        );
        assert_eq!(setting_tombstone_ts(&conn, "reader_theme"), None);
    }

    /// `cascade_delete` is the snapshot path's way in, and it is handed an id
    /// straight off a peer's tombstone list. `validate_tombstone_id` already
    /// refuses anything outside the whitelist, so this is the second lock on
    /// the same door — `settings` is where the local-only preferences and the
    /// AI credential pointers live, and one guard away from a peer being able
    /// to name them is not enough.
    #[test]
    fn cascade_delete_of_a_setting_refuses_a_key_outside_the_whitelist() {
        let mut conn = open_db();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('reader_theme', 'night', 100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('font_family', 'literata', 100)",
            [],
        )
        .unwrap();
        {
            let tx = conn.transaction().unwrap();
            cascade_delete(&tx, entity::SETTING, "reader_theme", 9_000).unwrap();
            cascade_delete(&tx, entity::SETTING, "font_family", 9_000).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            setting_value(&conn, "reader_theme").as_deref(),
            Some("night"),
            "a non-syncable key must survive a cascade it should never have reached"
        );
        assert_eq!(
            setting_value(&conn, "font_family"),
            None,
            "the whitelisted key must still be deleted, or the guard is just off"
        );
    }

    #[test]
    fn per_book_setting_is_skipped_for_a_tombstoned_book() {
        let mut conn = open_db();
        {
            let tx = conn.transaction().unwrap();
            insert_tombstone(&tx, entity::BOOK, "gone", 1_000).unwrap();
            tx.commit().unwrap();
        }
        apply_all(
            &mut conn,
            &[ev(
                2_000,
                "dev-a",
                setting_event(Some("gone"), "font", FONT_ID),
            )],
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
