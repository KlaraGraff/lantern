# Reader P2.4 — Per-book settings scope

Status: approved and implemented.

## Product decisions

- A row in `book_settings` is an explicit per-book override. The reader panel shows a scope summary and, below every overridden control, `Book-specific setting · Follow global`.
- Following global deletes that key's row immediately, updates the open reader, and offers one undo action. It never opens a confirmation dialog.
- The scope summary opens an in-panel management page. Management, promotion confirmation, and conflict-book selection replace the panel contents; they never stack another popover or modal over it.
- Each managed override displays both the localized global/default value and the localized value for this book; internal enum values never appear in the UI.
- `Follow global for all` deletes every reader override for the source book.
- `Use as global defaults` promotes only source overrides that have a global counterpart. It writes those values globally and deletes the same source rows, so the source book keeps following future global changes.
- Other books keep their overrides by default. The confirmation page can open an additional-scope picker containing only books whose rows overlap the promoted keys. Selecting a book removes only those overlapping rows; unrelated overrides remain.
- With six or more candidates, the picker exposes title/author search and a bulk action scoped to the current result. Selection survives search changes. Below six candidates those controls are hidden.
- The picker has three fixed regions: fixed heading/search/bulk controls, an independently scrolling list, and fixed selection count/confirmation controls. List content cannot pass through either fixed region.

## Setting model

The per-book keys allowed by the feature specification are:

| Per-book key | Global counterpart | Sync |
| --- | --- | --- |
| `theme` | `reader_theme` | local |
| `font` | `font_family` | synced |
| `font_size` | `font_size` | local |
| `line_spacing` | `line_spacing` | local |
| `word_spacing` | `word_spacing` | local |
| `char_spacing` | `char_spacing` | local |
| `text_justification` | `text_justification` | local |
| `paragraph_spacing` | `paragraph_spacing` | local |
| `first_line_indent` | `first_line_indent` | local |
| `reading_mode` | `reading_mode` | local |
| `page_columns` | `page_columns` | local |
| `margins` | `margins` | local |
| `show_lookup_markers` | none | local |
| `show_new_vocab_markers` | none | local |
| `show_learning_markers` | none | local |
| `show_mastered_markers` | none | local |

Page-turn animation, progress display, narrow-window font shrink, and previous/next bindings remain global-only. Marker visibility can be restored but cannot be promoted because it has no global counterpart.

## Commands and atomicity

- `delete_book_settings(book_id, keys)` validates the reader-key allowlist, deletes the rows in one transaction, and returns the deleted values for undo.
- `list_reader_setting_conflicts(source_book_id, keys)` validates promotable keys and returns only other books with overlapping rows, including the exact conflicting keys.
- `promote_book_settings_to_global(source_book_id, selected_book_ids)` derives promotable values from the source rows inside the transaction; the client cannot inject arbitrary global keys. The same transaction writes global settings, deletes the source rows, and deletes only overlapping promoted rows from selected books.
- Every command routes through `SyncWriter::with_tx`, so SQL changes and sync outbox events commit together. An error rolls back all global and per-book changes.
- The UI publishes `settings-changed` only after the promotion command succeeds.

## Sync deletion semantics

`setting.set` keeps its existing event kind. Its payload value becomes nullable: a string upserts a whitelisted setting and `null` deletes it. The schema version is bumped so older clients reject the new envelope before trying to parse it.

Deleting a synced per-book `font` row emits `setting.set { book, key: "font", value: null }`. A `book_setting` tombstone keyed as `<book-id>:font` records the deletion timestamp. It blocks stale or equal-time upserts, survives snapshots, and is cleared by a strictly newer font setting. Local-only deletions emit no event and no tombstone.

## UI state and failure handling

- The settings controller retains both raw global values and raw per-book rows, because row existence—not value comparison—defines override state.
- Reader edits add/update the raw override state immediately while the existing debounced writer persists them.
- Destructive scope actions first remove matching pending debounced writes so an old timer cannot recreate a deleted row.
- A successful restore re-resolves the open reader from remaining rows plus global values. A failed command leaves the UI unchanged and shows an inline error.
- Undo immediately restores the deleted key/value pairs and re-resolves the reader. Only the latest restore action is undoable.

## Verification

- TypeScript pure tests cover the allowlist/mapping, row-existence override detection, conflict selection/search/bulk behavior, and “delete only overlapping keys”.
- Rust command tests cover validation, per-key/all restore, conflict queries, atomic promotion, preservation of unrelated rows, source-book follow behavior, rollback, and `font` delete event/tombstone behavior.
- Sync merge/snapshot tests cover delete propagation, stale-event suppression, and a newer per-book font selection clearing the tombstone.
- Component behavior is checked without opening a foreground window; real Tauri visual interaction and two-device iCloud transport remain manual verification boundaries.

## Non-goals

- No migration of retired `reader-settings-*` localStorage blobs.
- No syncing of additional per-book keys.
- No per-book page-turn controls, animation, progress display, or narrow-window shrink.
- No global counterpart for word-marker visibility.
- No new dialog layer and no library-wide blanket overwrite control.
