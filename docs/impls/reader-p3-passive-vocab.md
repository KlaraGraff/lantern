# Reader P3.3 — 被动生词注释

Status: approved and implemented.

## Product decision

Both accepted presentations remain available: a short definition above the
saved word and a definition in the page margin. The user chooses the style in
**Settings → Reading**, together with one global master switch and low, medium,
or high density. The Reader settings popover exposes a shortcut for the same
global switch and links back to the full controls. The two entries update the
same settings immediately; this feature never creates a per-book override.

Definitions come from words already saved in Lantern. Reading does not call AI.
Density selection is deterministic and prioritises active learning, then new
words, then mastered words. Injected EPUB wrappers are CFI-transparent so
highlights, navigation, and saved locations continue to resolve.

## Capability and responsive rules

- Available only for reflowable EPUB content.
- PDF and fixed-layout EPUB disable the Reader shortcut.
- Margin notes move to the outside edge of each page in a spread.
- Narrow windows automatically render the selected words as ruby annotations,
  avoiding a rail that would leave too little room for the text.
- A failed settings write rolls the control back and reports the failure.

The accepted visual references are the ruby, margin, and settings mockups under
`docs/impls/reader-p3-passive-vocab-*.html`.
