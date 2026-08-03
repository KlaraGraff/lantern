# Syncable custom fonts

Make imported fonts follow the user across their devices: the `custom_fonts` catalog rows sync
through the event log, the font binaries replicate as plain files in the shared directory
(exactly as book files and covers already do), and the font *selection* (`font_family`) syncs so
that the file arriving on the second device actually gets used.

---

## 1. The policy reversal

`src-tauri/migrations/022_marker_styles_and_fonts.sql` currently carries this note above
`CREATE TABLE custom_fonts`:

> Imported font files are deliberately local-only. Font binaries may have licenses that prohibit
> redistribution, so neither this catalog nor the files under `imported-fonts/` enter the iCloud
> event log or snapshots.

That reasoning is withdrawn. Lantern does not ship, host, or distribute font files. The user
obtains the file themselves and places it in their own private cloud storage, which replicates it
between machines that are all theirs. That is the same act as copying a file from one of their
laptops to another — no third party receives anything, so no redistribution occurs. The licence
relationship is between the user and the foundry; Lantern does not mediate it and gains nothing by
pretending to.

The replacement comment must **state the old policy and why it was reversed**, not merely assert
the new one. A bare "fonts sync" comment invites the next reader to re-derive the redistribution
worry from first principles and flip the decision back. See §9 for the exact text.

---

## 2. Where the pieces live today

| Piece | Today | After |
| --- | --- | --- |
| `custom_fonts` rows | local-only table, no LWW columns | synced entity, LWW on `(updated_at, updated_by_device)` |
| font binaries | `<local app data>/imported-fonts/` via `resolve_app_data_dir()` | `<active data dir>/imported-fonts/`, i.e. the iCloud folder when sync is on |
| `font_family` (global) | `settings` table, local-only | synced, key-whitelisted |
| per-book `font` | **`localStorage`**, not `book_settings` | **unchanged — see §8** |

Three facts drive the whole design:

1. **The event log cannot carry font bytes.** `MAX_LOG_LINE_BYTES` is 256 KiB and
   `MAX_LOG_FILE_BYTES` is 16 MiB; `MAX_FONT_BYTES` is 64 MiB. A CJK font routinely exceeds the
   line cap and can approach the file cap on its own.
2. **A blob mechanism already exists and needs no extension.** `books/`, `covers/`, and
   `sources/` are not pushed through the log either. They live under `Db.data_dir`, which *is* the
   iCloud container when sync is enabled, and iCloud replicates them. The engine only triggers
   downloads of `.icloud` placeholders and verifies what landed. `imported-fonts/` becomes the
   fourth such directory. No second mechanism is invented.
3. **Moving the directory also discharges the `resolve_app_data_dir()` constraint.** Once the font
   dir hangs off `Db.data_dir`, `fonts.rs` resolves paths with `db.resolve_path("imported-fonts/…")`
   and the `local_font_dir()` helper — the only `resolve_app_data_dir()` caller for fonts —
   disappears. `lib.rs` already computes its side from `app.path().app_data_dir()`.

---

## 3. Migration 031

`031_syncable_custom_fonts.sql`. Three tables gain LWW columns:

```sql
ALTER TABLE custom_fonts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_fonts ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT '';
ALTER TABLE settings     ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings     ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT '';
ALTER TABLE book_settings ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE book_settings ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT '';
```

Backfill `custom_fonts.updated_at` from the existing `created_at` so pre-existing rows carry a
plausible timestamp rather than 0. `settings` / `book_settings` stay at 0: a local value that has
never been written under sync should lose to any real remote write, which is the correct outcome
for a device joining an established library.

**Existing local-only fonts.** Nothing special is required at migration time — the rows are
already in `custom_fonts` and the files are already on disk. Two things pick them up:

- `sync_enable` moves `imported-fonts/` into the iCloud container alongside `books/`/`covers/`/
  `sources/`, so the bytes start replicating.
- The catalog rows enter the peer's world through the **snapshot**, which is captured from the live
  table (`capture_state`), not from replayed history. A device that has never emitted a
  `custom_font.upsert` still publishes its fonts the first time it writes a snapshot. For
  promptness, `sync_enable` also enqueues one `custom_font.upsert` per existing row so peers see
  them on the next log tick instead of waiting for a snapshot.

---

## 4. Catalog rows: the event path

### Events (`src-tauri/src/sync/events.rs`)

Two new `EventBody` variants plus one for settings; `EVENT_SCHEMA_VERSION` 7 → 8.

- `custom_font.upsert` — `{ id, family_name, file_name, format, file_size, created_at }`
- `custom_font.delete` — `{ id }`
- `setting.set` — `{ book: Option<String>, key, value }`

### Merge (`src-tauri/src/sync/merge.rs`)

`apply_custom_font_upsert` follows the canonical LWW shape used by
`apply_lookup_occurrence_mark_set`:

```sql
INSERT INTO custom_fonts (…) VALUES (…)
ON CONFLICT(id) DO UPDATE SET …
WHERE (custom_fonts.updated_at, custom_fonts.updated_by_device)
    < (excluded.updated_at, excluded.updated_by_device)
```

### Conflict resolution — verified, not assumed

The brief said "last-writer-wins on `(ts, device)`". Checked against the code: correct, with two
details worth stating precisely.

- The comparison is on the **tuple** `(updated_at, updated_by_device)` versus `(event.ts,
  event.device)`, with the device id as a deterministic tie-break when two devices stamp the same
  logical timestamp. It is not a bare timestamp comparison.
- It is **strictly less than**, evaluated inside the SQL `WHERE` clause of the `ON CONFLICT` arm,
  so an event that ties an existing row is a no-op. Replay is therefore idempotent by
  construction: re-applying the same event a second time changes nothing.
- Timestamps come from `sync.next_logical_timestamp()`, which is monotonic per device, not from
  wall-clock time.

For fonts this is close to a non-issue: the row id is `custom-<sha256 of the bytes>`, so two
devices importing "the same font" produce byte-identical rows. The only field that can genuinely
diverge is `family_name`, and last-writer-wins on it is fine.

---

## 5. Binaries: the blob path

`imported-fonts/` joins `books/`, `covers/`, `sources/` everywhere those three are named:

- `Db::init_split` — create the directory under `data_dir`.
- `sync/validation.rs::resolve_blob_path` — a fourth prefix arm plus `validate_font_path`, which
  enforces the `<64-hex>.<ext>` shape and an extension in `ttf|otf|woff|woff2`. Same defence as the
  book/cover validators: no separators, no `..`, no absolute paths.
- `commands/sync.rs` — the `move_dir_contents` calls in `sync_enable`, the copy-back `jobs` vec in
  `sync_disable`, and the local-blob reconcile all gain an `imported-fonts` pair.
- `sync/watcher.rs` — watch `imported-fonts/`; add `ttf|otf|woff|woff2` to `is_relevant_event`.
- `lib.rs` — the asset-protocol scope already covers the shared dir via
  `allow_directory(shared_dir, true)`; the existing local `imported-fonts` grant stays for the
  sync-off case.
- `commands/fonts.rs` — `local_font_dir()` deleted; every path goes through
  `db.resolve_path("imported-fonts/<file>")`.

### Replay-side reconcile

`reconcile_custom_fonts(shared_dir, db)` runs in `tick_with_progress` next to
`reconcile_book_assets`, and reuses the same primitives: `crate::icloud::file_availability` to
classify each catalogued font, `crate::icloud::trigger_download_file` to pull `.icloud`
placeholders, and a size check against `custom_fonts.file_size` to reject a truncated download.

Availability is **derived, non-durable state** — it is a fact about this device's disk right now,
recomputable in a millisecond. It gets an in-memory set on `ReplayEngine`, not a table. When the
set of available font ids changes across a tick, the engine emits `custom-fonts-changed` with the
fresh list, which is the event the frontend already listens to in `App.tsx`. (`book_asset_local_state`
is the heavier precedent — a real table — but that exists because book assets carry error codes and
verification results worth persisting. Fonts have "the file is there or it isn't".)

---

## 6. Fonts in flight

With sync, "the catalog knows about a font whose bytes have not arrived" stops being an error and
becomes a normal transient state. Two changes make the UI treat it that way.

`CustomFont` (backend) and `CustomFontRecord` (frontend) gain **`file_available: boolean`**,
computed by `list_custom_fonts` from the filesystem.

- `src/components/custom-fonts.ts` — `customFontFaceCss` emits an `@font-face` rule only for
  records with `file_available`. A rule pointing at a not-yet-downloaded file would fail to load
  and, worse, make the family name look defined.
- The `custom-font-faces-loaded` event keeps carrying the **whole catalog**, unavailable entries
  included.

That second point is what resolves the downgrade problem without touching a forbidden file. The
handler at `src/pages/reader/useFoliateAnnotations.ts:419` builds its `available` set from the
event detail and downgrades a `custom-` font to `"system"` when the set does not contain it.
Because the detail is the whole catalog rather than the loadable subset, "in the set" now means *in
the catalog* rather than *bytes on disk*. A font still in flight stays selected and simply renders
in the fallback face until its bytes land, at which point the next `custom-fonts-changed` installs
the real `@font-face` and the text reflows into it. The downgrade fires only on a genuine deletion,
which is exactly what it was written for.

**No edit to `useFoliateAnnotations.ts` is required.** `git diff` on that file is empty — the other
agent working in it has either not started or already committed. The invariant it depends on is
recorded here so it is not broken later: *the `custom-font-faces-loaded` detail is the catalog, not
the loadable subset.*

---

## 7. Deletion, and re-importing a deleted font

A font id is `custom-<sha256 of the file bytes>` — **stable across devices and across time**. So a
permanent tombstone would mean: delete a font once, and you can never import that exact file again
on any device. That is a bug, not a policy.

The delete arm therefore follows the `word_mark_rules` precedent already in `merge.rs`: a
**timestamped** tombstone that a strictly newer upsert may clear.

- `custom_font.delete` cascades the same downgrades that the local `delete_custom_font` performs —
  `settings.font_family` → `system` where it pointed at this font, and `marker_style_config`'s
  `manual.font` / `automatic.font` → `inherit` — then writes the tombstone. The cascade is gated by
  LWW on the delete event's `(ts, device)`, so a concurrent re-selection on another device is not
  clobbered by a stale delete.
- `custom_font.upsert` checks `tombstone_timestamp(…).is_some_and(|deleted_at| deleted_at >= event.ts)`.
  Older than the tombstone → skip. Newer → `DELETE FROM _tombstones` and proceed. Re-importing the
  file works.
- `validate_tombstone_entity` gains a `custom_font` arm; `merge::entity` gains the stable tag.

The **file** is deliberately not deleted by replay. Peer A deletes, peer B still has the row
mid-flight; removing bytes on a timer invites a race where the row comes back and the file is gone.
The orphaned file is small, bounded, and swept the next time the same id is imported (the write is
content-addressed, so it is a no-op overwrite).

---

## 8. Settings: the narrowest change — and one thing the brief got wrong

### Why these tables are local-only

`docs/impls/archive/sync/31-sync.md` documents the decision (line 180 table row, and lines
380–381): `settings` is "general preferences (barely used; theme/language already live in
`localStorage`)" and `book_settings` holds "UI preferences that differ per screen and belong on the
device, not in the synced library."

That reasoning is sound and stays. Theme should not sync — a desktop in a bright office and a phone
at night want different answers. Font size is screen-dependent. **Font identity is not.** A font is
a thing the user acquired and chose; it is library-shaped, not screen-shaped. So the change is a
key whitelist, not a table.

### The mechanism

One event, `setting.set { book, key, value }`, plus a whitelist consulted on both ends:

- **Global:** `font_family` only.
- **Per book:** `font` only.

Writers: `set_setting`, `set_settings_bulk`, and `set_book_settings_bulk` route a write through
`SyncWriter::with_tx` **only** when the key is whitelisted; everything else keeps its existing plain
upsert and never reaches the log. Non-whitelisted keys are not merely dropped at read time — they
are never emitted, so the log stays clean.

Reader: unknown keys are **silently skipped in merge**, not rejected in `validation.rs`. This
matters. A validation error in `apply_in_tx` Phase C does not advance that peer's watermark past
the offending event, so a single unrecognised key from a newer Lantern version would wedge that
peer's replay permanently. Skipping is forward-compatible; rejecting is a foot-gun.

Rejected alternative: a separate `synced_settings` table. It duplicates the values, and every
reader of a setting then has to merge two sources and decide which wins. Worse than a whitelist.

### The problem with the per-book half

**The per-book `font` override does not live in `book_settings`.** It lives in browser
`localStorage`, under `reader-settings-<bookId>`, written by
`src/pages/reader/useReaderSettingsSync.ts:350` with a `typographyOverrides` array marking which
keys the book overrides. The `book_settings` table has working backend commands
(`get_book_settings` / `set_book_settings_bulk`, registered in `lib.rs:833-834`, with passing unit
tests) and **not a single frontend caller** — verified by grep across `src/` and `tests/`. It is
dead storage.

So plumbing `book_settings.font` through sync would be sound machinery attached to nothing. Making
the per-book font genuinely sync requires first migrating that override out of `localStorage` and
into `book_settings`, which means editing `useReaderSettingsSync.ts` and `Reader.tsx` — **both on
the do-not-touch list** (`src/pages/reader/**`, `src/pages/Reader.tsx`).

**Decision:** implement `font_family` (global) now, which is the half that makes the feature work —
the file arrives on device two and the reader picks it up. Build the `setting.set` event with the
`book` field and the per-book whitelist entry in place, so the backend is ready, but flag the
frontend migration as a hand-off rather than reaching into another agent's files. This is the
"narrowest change" the brief asked for; the part that is out of reach is out of reach for ownership
reasons, not design ones.

---

## 9. The replacement migration comment

```sql
-- Imported fonts sync. This reverses the original policy, recorded here so it is
-- not re-derived and flipped back: the table was created local-only on the
-- reasoning that font binaries may carry licenses forbidding redistribution.
--
-- That does not describe what happens here. Lantern neither ships nor hosts font
-- files. The user obtains the file themselves and puts it in their own private
-- cloud storage, which replicates it between machines that are all theirs -- the
-- same act as copying a file from one of their own laptops to another. No third
-- party receives anything, so no redistribution occurs, and the license question
-- is between the user and the foundry rather than something Lantern mediates.
--
-- Catalog rows sync through the event log; the binaries under imported-fonts/
-- replicate as plain files in the shared directory, like books/ and covers/.
-- See docs/impls/syncable-custom-fonts.md and migration 031.
```

---

## 10. F-003 shrinks

`docs/roadmap/mobile-ios.md:458-459` ends: "Three runtime callers use it: speech cache, imported
fonts, OCR runtime." Fonts stop being one. The entry becomes two callers — speech cache and OCR
runtime — with a note that fonts moved to `app.path().app_data_dir()` via `Db.data_dir` as part of
this work. F-003 itself is not fixed here; it is made smaller.

---

## 11. i18n

`settings.layout.customFontsHint` claims imported files "stay on this device and are not synced" in
both `en.json` and `zh.json`. Both must change, **via the Edit tool only** — other agents are
editing those files concurrently and a whole-file rewrite would clobber them. The two files must
stay key-for-key identical (`tests/i18n-keys.test.ts`).

---

## 12. Verification

`cargo test`, `cargo clippy --all-targets`, `npx tsc --noEmit`, `npm run test:unit`,
`npx eslint src/`. Two pre-existing failures are expected and unrelated — a stale `node_modules`
missing `remark-gfm` breaks `src/components/MessageBubble.tsx(7,23)` and
`tests/answer-markdown-gfm.test.ts`.

New Rust unit tests, in the style of the existing ones under `src-tauri/src/sync/`:

- custom-font upsert applies, and is idempotent on replay
- older upsert loses to newer row (LWW both directions, including the device tie-break)
- delete cascades `font_family` → `system` and writes a tombstone
- upsert older than the tombstone is skipped; newer clears it (re-import works)
- `setting.set` applies `font_family` and **skips** a non-whitelisted key without erroring
- `validate_font_path` rejects traversal, separators, and wrong extensions
