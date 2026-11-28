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
    if is_hevc_heif(&bytes) {
        // Stored as JPEG: no webview but Safari's can draw HEIC, and the cover
        // only ever shows small.
        return heic_cover_jpeg(&bytes)
            .ok_or_else(|| AppError::Other("BOOK_COVER_FORMAT_INVALID".to_string()));
    }
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

/// A HEIF file whose images are HEVC-coded (what an iPhone writes as `.heic`).
/// AVIF shares the container and the `mif1` brand, so only the HEVC brands count.
fn is_hevc_heif(bytes: &[u8]) -> bool {
    const HEVC_BRANDS: [&[u8]; 8] = [
        b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs",
    ];
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let box_len = (u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
        .clamp(16, bytes.len());
    // Major brand at 8..12, minor version at 12..16, compatible brands after.
    std::iter::once(&bytes[8..12])
        .chain(bytes[16..box_len].chunks_exact(4))
        .any(|brand| HEVC_BRANDS.contains(&brand))
}

/// Longest edge a converted HEIC cover keeps. A 48 MP phone photo would
/// otherwise become a multi-megabyte JPEG that sync carries for a thumbnail.
const HEIC_COVER_MAX_EDGE: u32 = 2048;

/// Apple platforms decode HEIC in ImageIO, which the OS ships and licenses.
#[cfg(target_vendor = "apple")]
fn heic_cover_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    use objc2_core_foundation::{
        CFBoolean, CFData, CFDictionary, CFMutableData, CFNumber, CFString, CFType,
    };
    use objc2_image_io::{
        kCGImageDestinationLossyCompressionQuality, kCGImageSourceCreateThumbnailFromImageAlways,
        kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceThumbnailMaxPixelSize,
        CGImageDestination, CGImageSource,
    };

    let data = CFData::from_bytes(bytes);
    // SAFETY: each dictionary maps ImageIO's own CFString keys to the value
    // type its documentation gives for that key.
    unsafe {
        let source = CGImageSource::with_data(&data, None)?;
        let max_edge = CFNumber::new_i32(HEIC_COVER_MAX_EDGE as i32);
        // `WithTransform` applies the photo's orientation, as the other
        // decoder below does.
        let thumbnail_options = CFDictionary::<CFString, CFType>::from_slices(
            &[
                kCGImageSourceCreateThumbnailFromImageAlways,
                kCGImageSourceCreateThumbnailWithTransform,
                kCGImageSourceThumbnailMaxPixelSize,
            ],
            &[
                CFBoolean::new(true).as_ref(),
                CFBoolean::new(true).as_ref(),
                max_edge.as_ref(),
            ],
        );
        let image = source.thumbnail_at_index(0, Some(thumbnail_options.as_opaque()))?;

        let jpeg = CFMutableData::new(None, 0)?;
        let destination = CGImageDestination::with_data(
            &jpeg,
            &CFString::from_static_str("public.jpeg"),
            1,
            None,
        )?;
        let quality = CFNumber::new_f64(0.9);
        let encode_options = CFDictionary::<CFString, CFType>::from_slices(
            &[kCGImageDestinationLossyCompressionQuality],
            &[quality.as_ref()],
        );
        destination.add_image(&image, Some(encode_options.as_opaque()));
        if !destination.finalize() {
            return None;
        }
        Some(CFData::to_vec(&jpeg))
    }
}

/// Elsewhere the decoder ships in the app: Windows can only decode HEIC with
/// a paid Store extension, and Linux has no system decoder at all.
#[cfg(not(target_vendor = "apple"))]
fn heic_cover_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    // The preview decoder never holds the full-size canvas, and it applies
    // the photo's rotation and converts its colour (iPhones tag Display P3)
    // to sRGB.
    let options = heifer::PreviewOptions::new(HEIC_COVER_MAX_EDGE, HEIC_COVER_MAX_EDGE);
    let decoded = heifer::decode_preview_rgba8(bytes, &options).ok()?;
    let rgb = decoded
        .data
        .chunks_exact(4)
        .flat_map(|pixel| {
            let alpha = u16::from(pixel[3]);
            let over_white =
                |channel: u8| ((u16::from(channel) * alpha + 255 * (255 - alpha)) / 255) as u8;
            [
                over_white(pixel[0]),
                over_white(pixel[1]),
                over_white(pixel[2]),
            ]
        })
        .collect();
    let image = image::RgbImage::from_raw(decoded.width, decoded.height, rgb)?;
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&image)
        .ok()?;
    Some(jpeg)
}

pub(crate) fn do_delete_book_with_note_policy(
    id: &str,
    preserve_book_notes: bool,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    crate::sync::validation::validate_entity_id(id)?;
    let (file_path, source_file_path, cover_path): (String, Option<String>, Option<String>) = {
        let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        conn.query_row(
            "SELECT file_path, source_file_path, cover_path FROM books WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
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
                        // A kept place is a bookmark: a location plus whatever
                        // the reader wrote on it, possibly nothing. Only the
                        // text is worth carrying past the book — the location
                        // points into a book that is about to stop existing —
                        // so a blank one stays with the book (the cascade
                        // below removes it) instead of becoming an empty
                        // detached row, and a written one loses its `position`
                        // anchor (`validate_note_fields` pins that kind to a
                        // live book scope) to become an ordinary unanchored
                        // note, the same shape every other detached note has.
                        let anchor_kind: String = row.get("anchor_kind")?;
                        let content: String = row.get("content")?;
                        let kept_place = anchor_kind == "position";
                        if kept_place && content.trim().is_empty() {
                            return Ok(None);
                        }
                        Ok(Some(NotePayload {
                            id: row.get("id")?,
                            book_id: None,
                            anchor_kind: if kept_place {
                                "selection".to_string()
                            } else {
                                anchor_kind
                            },
                            normalized_word: row.get("normalized_word")?,
                            scope: "detached".to_string(),
                            location: None,
                            selected_text: row.get("selected_text")?,
                            content,
                            content_format: row.get("content_format")?,
                            created_at: row.get("created_at")?,
                        }))
                    })?
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>();
                notes
            };
            for note in detached_notes {
                // `anchor_kind` is rewritten from the payload rather than left
                // alone so the row a peer rebuilds from `note` and the row this
                // device keeps cannot disagree.
                tx.execute(
                    "UPDATE notes
                     SET book_id = NULL, anchor_kind = ?4, scope = 'detached', location = NULL,
                         updated_at = ?2, updated_by_device = ?3
                     WHERE id = ?1",
                    params![note.id, now, device, note.anchor_kind],
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

    // The row is already gone, so the blobs are best-effort too. A path that
    // can't be resolved names no file of ours to remove, and must not turn a
    // finished delete into a reported failure — that is how a book whose file
    // went missing would get stuck on the shelf.
    let mut blobs = vec![file_path.clone()];
    blobs.extend(source_file_path.filter(|path| path != &file_path));
    let cover_path = cover_path.unwrap_or_else(|| format!("covers/{id}.img"));
    if cover_path != "none" {
        blobs.push(cover_path);
    }
    for path in blobs {
        match db.resolve_path(&path) {
            Ok(abs) => {
                let _ = fs::remove_file(abs);
            }
            Err(error) => log::warn!("delete book {id}: skipping unresolvable path: {error}"),
        }
    }

    Ok(())
}

#[tauri::command]
pub fn delete_book<R: tauri::Runtime>(
    id: String,
    preserve_notes: Option<bool>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
    local_dir: State<'_, LocalDir>,
    app: tauri::AppHandle<R>,
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
    let converted_path = converted_document_path(&local_dir.0, &id);
    let _ = fs::remove_file(&converted_path);
    if let Ok(temporary_path) = convert_prepare::converted_temporary_path(&converted_path) {
        let _ = fs::remove_file(temporary_path);
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    crate::commands::library_backup::schedule_auto(&app);
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let _ = app;
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
        crate::sync::book_fields::stamp(tx, id, "progress", ts, &device)?;
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
        let should_finish = if was_finished
            || was_unread
            || !crate::mastery::auto_finish_progress_reached(progress)
        {
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
/// The existing two transactions retain distinct logical timestamps. Status
/// and progress now arbitrate against independent field clocks, so either
/// replay order preserves both changes.
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
    let now = sync.next_logical_timestamp();
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

/// The picked cover as `update_book_cover` would store it, for the edit
/// dialog's preview: a webview outside Apple's cannot draw a HEIC file itself.
#[tauri::command]
pub fn cover_image_preview(image_path: String) -> AppResult<tauri::ipc::Response> {
    validated_cover_bytes(Path::new(&image_path)).map(tauri::ipc::Response::new)
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
    let _mutation = sync.mutation_guard()?;
    let relative_path = crate::sync::covers::relative_path(&id, &bytes);
    let destination = db.resolve_path(&relative_path)?;
    crate::sync::covers::publish(&destination, &bytes)?;

    let now = sync.next_logical_timestamp();
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
    // An unreferenced immutable file is safe to retain if the transaction
    // fails; deleting it could race another successful use of the same hash.
    result?;
    sync.queue_cover_write(&db, &id, &bytes);
    Ok(())
}

#[cfg(test)]
mod cover_tests {
    use super::*;

    #[test]
    fn throttled_progress_still_advances_its_local_field_clock_when_sync_is_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let sync = SyncWriter::new("dev-A".into());
        db.conn.lock().unwrap().execute(
            "INSERT INTO books(id, title, author, file_path, format, status, created_at, updated_at, updated_by_device)
             VALUES ('b1', 'Book', 'Author', 'books/b1.epub', 'epub', 'reading', 1, 1, 'origin')", [],
        ).unwrap();
        do_update_reading_progress("b1", 10, Some("first"), &db, &sync).unwrap();
        let first = crate::sync::book_fields::load(&db.conn.lock().unwrap(), "b1").unwrap();
        do_update_reading_progress("b1", 20, Some("second"), &db, &sync).unwrap();
        let second = crate::sync::book_fields::load(&db.conn.lock().unwrap(), "b1").unwrap();
        assert!(second["progress"] > first["progress"]);
        assert_eq!(second["title"], first["title"]);
        do_update_book("b1", Some("Renamed"), None, None, None, &db, &sync).unwrap();
        let third = crate::sync::book_fields::load(&db.conn.lock().unwrap(), "b1").unwrap();
        assert!(third["title"] > second["title"]);
        assert_eq!(third["progress"], second["progress"]);
    }

    #[test]
    fn custom_cover_rejects_non_image_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cover.png");
        fs::write(&path, b"not an image").unwrap();
        assert!(validated_cover_bytes(&path).is_err());
    }

    #[test]
    fn custom_cover_accepts_png_and_webp() {
        // 2×2 red pixels, written by Pillow, so the fixtures do not depend on
        // which encoders this crate's `image` build happens to carry.
        const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x02\x00\x00\x00\x02\x08\x02\x00\x00\x00\xfd\xd4\x9as\x00\x00\x00\x16IDATx\x9cc<\xc1\xc5\xc5\xc0\xc0\xc0\xc4\xc0\xc0\xc0\xc0\xc0\x00\x00\x0b8\x00\xe0\x11\xf4\xd5\xd6\x00\x00\x00\x00IEND\xaeB`\x82";
        const WEBP: &[u8] = b"RIFF\x1e\x00\x00\x00WEBPVP8L\x11\x00\x00\x00/\x01@\x00\x00\x07P\x85\"W\xa1\xff\x81\x88\xe8\x7f\x00\x00";
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in [("cover.png", PNG), ("cover.webp", WEBP)] {
            let path = dir.path().join(name);
            fs::write(&path, bytes).unwrap();
            assert_eq!(
                validated_cover_bytes(&path).unwrap(),
                bytes,
                "{name} was rejected"
            );
        }
    }

    /// 48×32 stored, red with a green square top-left and a blue one
    /// bottom-right, tagged to be shown turned 90° clockwise — the way an
    /// iPhone saves a portrait photo. Written by libheif 1.23 with x265.
    const ROTATED_HEIC: &[u8] = include_bytes!("../../../tests/fixtures/cover-rotated.heic");

    #[test]
    fn custom_cover_converts_heic_to_an_upright_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("IMG_0001.HEIC");
        fs::write(&path, ROTATED_HEIC).unwrap();

        let bytes = validated_cover_bytes(&path).unwrap();
        assert!(
            bytes.starts_with(b"\xFF\xD8\xFF"),
            "stored cover is not a JPEG"
        );
        let cover = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert_eq!(cover.dimensions(), (32, 48), "rotation was not applied");
        let near = |x: u32, y: u32, want: [u8; 3]| {
            let got = cover.get_pixel(x, y).0;
            got.iter().zip(want).all(|(g, w)| g.abs_diff(w) < 40)
        };
        assert!(near(28, 3, [30, 200, 40]), "green square is not top-right");
        assert!(near(3, 44, [30, 40, 220]), "blue square is not bottom-left");
        assert!(near(16, 24, [220, 30, 30]), "body is not red");
    }

    #[test]
    fn custom_cover_rejects_a_broken_heic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.heic");
        fs::write(&path, &ROTATED_HEIC[..ROTATED_HEIC.len() / 2]).unwrap();
        assert!(validated_cover_bytes(&path).is_err());
    }

    #[test]
    fn only_hevc_coded_heif_counts_as_heic() {
        let ftyp = |major: &[u8], compatible: &[&[u8]]| {
            let mut bytes = ((16 + 4 * compatible.len()) as u32).to_be_bytes().to_vec();
            bytes.extend_from_slice(b"ftyp");
            bytes.extend_from_slice(major);
            bytes.extend_from_slice(&[0; 4]);
            compatible
                .iter()
                .for_each(|brand| bytes.extend_from_slice(brand));
            bytes.extend_from_slice(b"\0\0\0\x08meta");
            bytes
        };
        assert!(is_hevc_heif(ROTATED_HEIC));
        assert!(is_hevc_heif(&ftyp(b"mif1", &[b"heic"])));
        assert!(is_hevc_heif(&ftyp(b"heix", &[])));
        assert!(!is_hevc_heif(&ftyp(b"avif", &[b"mif1", b"miaf"])));
        assert!(!is_hevc_heif(&ftyp(b"isom", &[b"mp41"])));
        assert!(!is_hevc_heif(b"\xFF\xD8\xFF\xE0"));
    }
}
