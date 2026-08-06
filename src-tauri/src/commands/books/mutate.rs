use super::text_prepare::{
    legacy_prepared_document_path, prepared_document_backup_path, prepared_document_path,
    prepared_document_temporary_path,
};
use super::*;

const MAX_CUSTOM_COVER_BYTES: u64 = 10 * 1024 * 1024;

fn validated_cover_bytes(path: &Path) -> AppResult<Vec<u8>> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CUSTOM_COVER_BYTES {
        return Err(AppError::Other("BOOK_COVER_SIZE_INVALID".to_string()));
    }
    let bytes = fs::read(path)?;
    let supported = bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xFF\xD8\xFF")
        || (bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP");
    if !supported {
        return Err(AppError::Other("BOOK_COVER_FORMAT_INVALID".to_string()));
    }
    image::load_from_memory(&bytes)
        .map_err(|_| AppError::Other("BOOK_COVER_FORMAT_INVALID".to_string()))?;
    Ok(bytes)
}

pub(crate) fn do_delete_book_with_note_policy(
    id: &str,
    preserve_book_notes: bool,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(id)?;
    let (file_path, source_file_path): (String, Option<String>) = {
        let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        conn.query_row(
            "SELECT file_path, source_file_path FROM books WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
    };

    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        if preserve_book_notes {
            let detached_notes = {
                let mut statement = tx.prepare(
                    "SELECT id, anchor_kind, normalized_word, selected_text, content,
                            content_format, created_at
                     FROM notes WHERE book_id = ?1 AND scope = 'book'",
                )?;
                let notes = statement
                    .query_map(params![id], |row| {
                        Ok(NotePayload {
                            id: row.get(0)?,
                            book_id: None,
                            anchor_kind: row.get(1)?,
                            normalized_word: row.get(2)?,
                            scope: "detached".to_string(),
                            location: None,
                            selected_text: row.get(3)?,
                            content: row.get(4)?,
                            content_format: row.get(5)?,
                            created_at: row.get(6)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                notes
            };
            for note in detached_notes {
                tx.execute(
                    "UPDATE notes
                     SET book_id = NULL, scope = 'detached', location = NULL,
                         updated_at = ?2, updated_by_device = ?3
                     WHERE id = ?1",
                    params![note.id, now, device],
                )?;
                events.push(EventBody::NoteUpsert(note));
            }
        }
        // Keep the local command path byte-equivalent to replaying the
        // published BookDelete event. In particular, cascade_delete records
        // chat tombstones before removing chats so delayed messages cannot
        // materialize as orphans on this device or in its next snapshot.
        merge::cascade_delete(tx, entity::BOOK, id, now)?;
        merge::insert_tombstone(tx, entity::BOOK, id, now)?;
        events.push(EventBody::BookDelete { id: id.to_string() });
        Ok(())
    })?;

    // A book is the largest thing that can be deleted here — its chunks and
    // FTS index alone run to about a megabyte — so this is the one path where
    // leaving the freed pages in the file is visible to the user. Post-commit
    // because `incremental_vacuum` cannot run inside a transaction. 1000 pages
    // caps one call at 4 MB; deleting a bigger book leaves the rest to the
    // next delete. Best-effort: the book is already gone, and failing to
    // shrink the file is not a reason to report the delete as failed.
    if let Err(error) = db.reclaim_free_pages(1000) {
        log::warn!("db: reclaiming pages after deleting book {id} failed: {error}");
    }

    let abs_file = db.resolve_path(&file_path)?;
    let _ = fs::remove_file(&abs_file);
    if let Some(source_path) = source_file_path.filter(|path| path != &file_path) {
        let abs_source = db.resolve_path(&source_path)?;
        let _ = fs::remove_file(abs_source);
    }
    let cover_file = db.resolve_path(&format!("covers/{id}.img"))?;
    let _ = fs::remove_file(&cover_file);

    Ok(())
}

#[tauri::command]
pub fn delete_book(
    id: String,
    preserve_notes: Option<bool>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
    local_dir: State<'_, LocalDir>,
) -> AppResult<()> {
    do_delete_book_with_note_policy(&id, preserve_notes.unwrap_or(false), &db, &sync)?;
    let prepared_path = prepared_document_path(&local_dir.0, &id);
    let _ = fs::remove_file(&prepared_path);
    if let Ok(backup_path) = prepared_document_backup_path(&prepared_path) {
        let _ = fs::remove_file(backup_path);
    }
    if let Ok(temporary_path) = prepared_document_temporary_path(&prepared_path) {
        let _ = fs::remove_file(temporary_path);
    }
    let _ = fs::remove_file(legacy_prepared_document_path(&local_dir.0, &id));
    Ok(())
}

#[tauri::command]
pub fn update_reading_progress(
    id: String,
    progress: i32,
    cfi: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<bool> {
    do_update_reading_progress(&id, progress, cfi.as_deref(), &db, &sync)
}

/// Updates progress and, when the evidence clears both bars, auto-finishes
/// the book through the exact same event shape a manual finish would produce
/// (see `do_mark_finished`). Returns whether that happened, so the frontend
/// knows to run the same finished-book analysis it would run after a manual
/// mark.
///
/// The §2.2 coverage denominator is computed entirely on the backend now —
/// see `reading_behavior::estimate_total_book_screens` — rather than taken
/// from a frontend-supplied page count. The frontend used to pass
/// `view.renderer?.pages`, foliate's *current-chapter* page count (it is
/// rebuilt on every chapter load), as if it were the whole book's screen
/// total; a book read faithfully through chapter 1 and then dragged to a
/// three-screen "about the author" back-chapter would clear that
/// (chapter-scoped) denominator on the very first drag. Per
/// docs/impls/reading-flow-decisions-2026-08-06.md §2.2, missing or
/// untrustworthy evidence must break toward NOT auto-finishing, never toward
/// marking — see `estimate_total_book_screens`'s own doc comment for exactly
/// which conditions make it return `None`.
pub(crate) fn do_update_reading_progress(
    id: &str,
    progress: i32,
    cfi: Option<&str>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<bool> {
    // Page-turn rate is dominated by this command; gate the event push on
    // the per-book throttle so a reading session doesn't balloon the log.
    // The SQL write always lands so the local UI stays current — only the
    // event publication is coalesced. Semantic transitions like
    // `do_mark_finished` deliberately do NOT consult the throttle.
    let emit = sync.should_emit_progress(id);
    let ts = sync.next_logical_timestamp();
    let device = sync.self_device().to_string();
    let should_finish = sync.with_tx(db, ts, |tx, events| {
        // Reading a book is what puts it on the "reading" shelf — the user
        // shouldn't have to say so by hand. Read the status BEFORE the UPDATE
        // so we know whether the promotion actually happened and an event is
        // owed. Only `unread` is promoted: a finished book that gets reopened
        // keeps the conclusion its owner drew about it. Also captured here
        // (not just re-derived after the UPDATE) so the auto-finish check
        // below can tell "already finished" from "just became finished by
        // this same call" — an already-finished book must never re-trigger.
        let status_before: Option<String> = tx
            .query_row("SELECT status FROM books WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .ok();
        let was_unread = status_before.as_deref() == Some("unread");
        let was_finished = status_before.as_deref() == Some("finished");
        tx.execute(
            "UPDATE books SET progress = ?1, current_cfi = ?2,
                    status = CASE WHEN status = 'unread' THEN 'reading' ELSE status END,
                    updated_at = ?3, updated_by_device = ?4
             WHERE id = ?5",
            params![progress, cfi, ts, device, id],
        )?;
        if was_unread {
            // Published unconditionally — the throttle below coalesces noisy
            // page turns, but this transition happens once in a book's life
            // and dropping it would strand peers on `unread` forever.
            events.push(EventBody::BookStatusSet {
                book: id.to_string(),
                status: "reading".into(),
            });
        }

        // Bug 3b: a book the reader just marked "unread" by hand resets
        // `was_unread` here on its very next progress report, but its
        // lifetime `reading_screen_dwells` history (never cleared by the
        // manual reset) can still clear the coverage floor on that same
        // report — silently undoing the reader's own "unread" verdict the
        // moment they reopen the book, and spending an AI summary on it in
        // the process. So a book that was unread a moment ago never
        // auto-finishes on the call that promotes it; the check simply runs
        // again on the next progress report, once the promotion has landed.
        //
        // Decided BEFORE the throttled progress event below is pushed, so a
        // call that both updates progress and clears the auto-finish gate
        // publishes only the promotion (or nothing) here — the finished pair
        // is published separately, after this transaction commits, so it can
        // carry its own later logical timestamps (see below).
        let should_finish = if was_finished || was_unread {
            false
        } else if let Some(total_screens) =
            crate::commands::reading_behavior::estimate_total_book_screens(tx, id)?
        {
            let normal_pace_screens =
                crate::commands::reading_behavior::count_normal_pace_screens(tx, id)?;
            crate::mastery::should_auto_finish(progress, normal_pace_screens, total_screens)
        } else {
            false
        };

        if !should_finish && emit {
            events.push(EventBody::BookProgressSet {
                book: id.to_string(),
                progress,
                cfi: cfi.map(str::to_string),
            });
        }
        Ok(should_finish)
    })?;

    if should_finish {
        do_mark_finished(db, sync, id)?;
    }
    Ok(should_finish)
}

#[tauri::command]
pub fn update_book_pages(id: String, pages: i32, db: State<'_, Db>) -> AppResult<()> {
    // Local-only — `pages` is derived from the book file on this device and
    // not part of the sync contract. Plain DB write, no SyncWriter.
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "UPDATE books SET pages = ?1 WHERE id = ?2",
        params![pages, id],
    )?;
    Ok(())
}

/// The one path to "finished": mutates the row and publishes the same pair
/// of LWW events a manual finish always produced, so a caller can't drift
/// from it by hand-rolling a second version. Used both by the manual
/// `mark_finished` command and by `do_update_reading_progress`'s §2.2
/// auto-finish check.
///
/// Two *sequential* transactions, each with its own strictly-increasing
/// `SyncWriter::next_logical_timestamp()` — deliberately not one `with_tx`
/// call sharing one timestamp for both events (bug 3 in
/// docs/impls/reading-flow-decisions-2026-08-06.md §2's writeup, present on
/// HEAD before this change too). `books` keeps a single `updated_at` /
/// `updated_by_device` pair for the whole row, not one per column, and the
/// merge engine's LWW check
/// (`updated_at < event.ts OR (updated_at = event.ts AND updated_by_device <
/// event.device)`, in `sync::merge`) is strict: when two events from the
/// same device carry the *identical* `(ts, device)`, only whichever one a
/// peer happens to replay first can ever satisfy that condition — the
/// second finds `updated_at` already equal to its own `ts` and its own
/// device already credited, so `device < device` is false and it becomes a
/// silent no-op, forever. Which one "happens to replay first" is an
/// unordered tiebreak (`replay.rs` sorts same-`(ts,device)` events by a
/// random UUID), so which half of "finished" survives on a peer is not
/// determined by this function at all — it was observed to drop the
/// progress write and leave a peer at `status=reading, progress=0` even
/// though every field committed correctly here, on this device.
///
/// Giving the two events distinct, increasing timestamps removes the tie
/// entirely: the second event's `updated_at < event.ts` legitimately holds
/// (the first event's `ts` — now sitting in `updated_at` — is strictly less
/// than the second event's own, later `ts`), so it applies in the same
/// order on every peer, deterministically, regardless of replay order.
fn do_mark_finished(db: &Db, sync: &SyncWriter, id: &str) -> AppResult<()> {
    let device = sync.self_device().to_string();

    let status_ts = sync.next_logical_timestamp();
    sync.with_tx(db, status_ts, |tx, events| {
        tx.execute(
            "UPDATE books SET status = 'finished', updated_at = ?1, updated_by_device = ?2 WHERE id = ?3",
            params![status_ts, device, id],
        )?;
        events.push(EventBody::BookStatusSet {
            book: id.to_string(),
            status: "finished".into(),
        });
        Ok(())
    })?;

    let progress_ts = sync.next_logical_timestamp();
    sync.with_tx(db, progress_ts, |tx, events| {
        // Read the current cfi BEFORE the UPDATE so the synthesized
        // `book.progress.set` carries the resume position the local row
        // keeps. Local SQL doesn't touch `current_cfi` here, so emitting
        // `cfi: None` would silently null the column on every peer while
        // this device still has it — a snapshot-equivalence violation.
        let current_cfi: Option<String> = tx
            .query_row(
                "SELECT current_cfi FROM books WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        tx.execute(
            "UPDATE books SET progress = 100, updated_at = ?1, updated_by_device = ?2 WHERE id = ?3",
            params![progress_ts, device, id],
        )?;
        // Published unconditionally — the throttle is for noisy page-turn
        // updates only, never for semantic transitions.
        events.push(EventBody::BookProgressSet {
            book: id.to_string(),
            progress: 100,
            cfi: current_cfi,
        });
        Ok(())
    })
}

#[tauri::command]
pub fn mark_finished(id: String, db: State<'_, Db>, sync: State<'_, SyncWriter>) -> AppResult<()> {
    do_mark_finished(&db, &sync, &id)
}

pub(crate) fn do_update_book(
    id: &str,
    title: Option<&str>,
    author: Option<&str>,
    genre: Option<&str>,
    status: Option<&str>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Book> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        if let Some(t) = title {
            tx.execute(
                "UPDATE books SET title = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                params![t, now, device, id],
            )?;
            events.push(EventBody::BookMetadataSet {
                book: id.to_string(),
                field: "title".into(),
                value: serde_json::Value::String(t.to_string()),
            });
        }
        if let Some(a) = author {
            tx.execute(
                "UPDATE books SET author = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                params![a, now, device, id],
            )?;
            events.push(EventBody::BookMetadataSet {
                book: id.to_string(),
                field: "author".into(),
                value: serde_json::Value::String(a.to_string()),
            });
        }
        if let Some(g) = genre {
            tx.execute(
                "UPDATE books SET genre = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                params![g, now, device, id],
            )?;
            events.push(EventBody::BookMetadataSet {
                book: id.to_string(),
                field: "genre".into(),
                value: serde_json::Value::String(g.to_string()),
            });
        }
        if let Some(s) = status {
            tx.execute(
                "UPDATE books SET status = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                params![s, now, device, id],
            )?;
            events.push(EventBody::BookStatusSet {
                book: id.to_string(),
                status: s.to_string(),
            });
        }
        Ok(())
    })?;
    query_book(db, id)
}

#[tauri::command]
pub fn update_book_status(
    id: String,
    status: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_update_book(&id, None, None, None, Some(&status), &db, &sync)?;
    Ok(())
}

#[tauri::command]
pub fn update_book_metadata(
    id: String,
    title: String,
    author: String,
    app: AppHandle,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_update_book(&id, Some(&title), Some(&author), None, None, &db, &sync)?;
    if let Err(error) = app.emit(
        "book-metadata-changed",
        serde_json::json!({ "id": id, "title": title, "author": author }),
    ) {
        log::warn!("failed to notify readers about metadata update: {error}");
    }
    Ok(())
}

#[tauri::command]
pub fn update_book_cover(
    id: String,
    image_path: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(&id)?;
    let bytes = validated_cover_bytes(Path::new(&image_path))?;
    let relative_path = format!("covers/{id}.img");
    let destination = db.resolve_path(&relative_path)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = destination.with_extension("img.tmp");
    let previous = fs::read(&destination).ok();
    fs::write(&temporary, &bytes)?;
    fs::rename(&temporary, &destination)?;

    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    let result = sync.with_tx(&db, now, |tx, events| {
        let changed = tx.execute(
            "UPDATE books
             SET cover_path = ?1, cover_data = ?2, updated_at = ?3, updated_by_device = ?4
             WHERE id = ?5",
            params![relative_path, bytes, now, device, id],
        )?;
        if changed == 0 {
            return Err(AppError::Other("BOOK_NOT_FOUND".to_string()));
        }
        events.push(EventBody::BookMetadataSet {
            book: id.clone(),
            field: "cover_path".to_string(),
            value: serde_json::Value::String(relative_path.clone()),
        });
        Ok(())
    });
    if let Err(error) = result {
        if let Some(previous) = previous {
            let _ = fs::write(&destination, previous);
        } else {
            let _ = fs::remove_file(&destination);
        }
        return Err(error);
    }
    sync.queue_cover_write(&db, &id, &bytes);
    Ok(())
}

#[cfg(test)]
mod cover_tests {
    use super::*;

    #[test]
    fn custom_cover_rejects_non_image_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cover.png");
        fs::write(&path, b"not an image").unwrap();
        assert!(validated_cover_bytes(&path).is_err());
    }
}
