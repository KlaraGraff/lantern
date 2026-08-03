# 12 - Reader Settings: Global Layer and Per-Book Overrides

GitHub issue: https://github.com/KlaraGraff/lantern/issues/12

## Motivation

Reader settings already resolve from two layers. `resolveReaderSettings` reads per-book overrides from `book_settings` rows — where the row existing *is* the override — and everything else from the global `settings` table. That structure landed across `405e22f`, `f84c116` and `d0d80ab`, which retired the `reader-settings-<bookId>` localStorage blob that used to be a third, always-stale source.

The layering is correct. What is missing is that a reader can neither see it nor undo it, and half the global layer was never built.

**The reader panel never says which layer it is editing.** `ReaderSettings.tsx` presents theme, font, size, spacing, margins, markers, page flow and page-turn controls as one flat list. Changing the font affects the open book; changing the page-turn animation affects every book. Nothing on screen tells them apart, so a user cannot predict which of their choices will follow them into the next book.

**An override is a one-way door.** Once a book has a `font` row, nothing makes that book follow the global font again. Setting the value back by hand still leaves a row behind, so the next global change skips that book — silently, and for good. The retired blob had the same gap via its `typographyOverrides` list, so this is long-standing rather than newly introduced; making row-existence the override simply made it structural.

**Six global settings have no Settings-page row at all.** Default page flow, page layout, page-turn animation, progress display, and the previous/next page controls are global values whose only editor is the reader panel. Their strings already sit unused in the `settings.layout.*` namespace — `readingMode`, `pageLayout`, `pageTurnAnimation`, `progressDisplay`, `previousPageBinding`, `nextPageBinding`, plus `title`, `subtitle` and `systemDefault` — written for rows that were never built. `git log -S` finds no commit where any of them appeared in `ReadingSettings.tsx`.

**Character spacing has no global value at all.** `char_spacing` was read in exactly one place and written nowhere in the repo; `f84c116` removed the dead read. It is now per-book only, and the one typography control with no default.

## Scope

In scope:

- **Complete the global layer.** A Settings row for each global reader setting that lacks one: default page flow, page layout, page-turn animation, progress display, previous-page control, next-page control. The i18n strings exist and are reused as-is.
- **A global default for character spacing**, matching the other typography rows, so every typography control has both layers.
- **Override visibility.** A row the open book overrides is marked as such in the reader panel. Unmarked rows are following the global value.
- **Two per-book actions:**
  - *Follow the global setting* — drop this book's override for that setting. Available per overridden row, and once for the whole panel.
  - *Apply to global* — promote this book's value to the global default **and drop the book's own row**, so the book continues to follow. Without the drop, "apply to global" would leave the book pinned to a value it just published, and the next global change would skip it — recreating the bug this feature exists to fix.
- **Three settings join the overridable set:** default page flow, page layout, and margins. Each is a property of how a particular book reads — a comic and a novel want different page flows; a wide art book and a pocket paperback want different layouts.

Out of scope:

- **Per-book page-turn controls.** Which key or gesture turns the page is muscle memory. Varying it per book means the reader mispresses without understanding why, and the value of the setting comes precisely from its being uniform. The same reasoning excludes page-turn animation, progress display, and narrow-window shrink: these describe how the reader should feel, not what a book should look like.
- **Syncing the per-book keys.** `is_syncable_setting` whitelists per-book `font` and global `font_family`, and nothing else. The remaining per-book keys are per-screen preferences and stay local by design (`docs/impls/archive/sync/q31-sync.md`). Whether per-book font size should sync is a separate decision, deferred until there is a second device to test the ping-pong on.
- **Migrating retired localStorage blobs.** `reader-settings-<bookId>` keys are left inert. No migration code, per the phase policy.
- **Reworking the reader panel's layout.** Override marks and actions are added to the existing structure; a redesign is not part of this.

## Implementation Phases

1. **Complete the global layer.**
   - Add the six missing rows to `ReadingSettings.tsx`, following the 73px-row pattern in `GeneralSettings.tsx`. Reuse the existing `settings.layout.*` strings.
   - Add a `char_spacing` global setting with a Settings row, and make `resolveReaderSettings` fall back to it.
   - Verify each new row and its reader-panel counterpart read and write the same global key, and that the `settings-changed` listener already applies it to a live reader (it does for the existing eight).
   - This phase is additive and stands alone: it makes the global layer legible before any override UI is built on top of it.

2. **Make the override layer visible and reversible.**
   - Extend `perBookSettingKeys` with `reading_mode`, `page_columns` and `margins`, including their string encode/decode at the `book_settings` boundary.
   - Mark overridden rows in the reader panel, and add the per-row "follow the global setting" action.
   - Add the panel-level "follow global for everything" and "apply this book's settings to the global default" actions, both dropping the book's rows as described in Scope.
   - Deleting a row needs a backend path: `set_book_settings_bulk` writes values and has no delete. Either extend it to treat an explicit null as a delete, or add a companion command — decide during implementation, and keep whichever choice consistent with how sync's `SettingSet` event replays, since `font` deletions have to cross devices correctly.

Design prompts and the row-level interaction details belong in a `docs/impls/` plan written before phase 2 begins.

## Verification

- Every global reader setting has exactly one Settings row, and changing it there moves an already-open book that has no override for it.
- A book with an override ignores the global change, and its row is visibly marked in the reader panel.
- "Follow the global setting" removes the mark, and the book then tracks subsequent global changes.
- "Apply to global" moves every other non-overriding book, leaves other books' overrides alone, and leaves the source book following rather than pinned.
- Page-turn controls remain identical in every book.
- A per-book font override still reaches a second device; the other per-book keys still do not.
- No `reader-settings-` key is read or written.
