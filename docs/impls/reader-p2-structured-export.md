# Reader P2.1 — Structured highlights and vocabulary export

Status: approved mockup, implementation pending.

Source: [`docs/roadmap/reader-page-optimization.md`](../roadmap/reader-page-optimization.md) §P2.1.
Approved visual reference: [`reader-p2-structured-export-mockup.html`](reader-p2-structured-export-mockup.html).

## 1. Outcome

Readers can export the current book's highlights, notes, and saved vocabulary without leaving the reader. The export is structured enough for notes applications and study tools rather than being a visual dump.

Supported formats:

- Markdown: readable archive for Obsidian, Notion, plain-text notes, and source control.
- CSV: complete rectangular data for spreadsheets and custom tooling.
- Anki CSV: vocabulary-only cards, with the book sentence on the front and the answer on the back.

The feature is current-book scoped. Existing Home notes CSV and vocabulary backup/export remain unchanged: those serve cross-book management and backup, while this reader entry serves study handoff from the book being read.

## 2. Approved product rules

1. Add a borderless `Download` icon to the existing highlights and vocabulary side-panel tool rows. It is a secondary action: transparent at rest, a muted background on hover, and a localized tooltip/accessibility label.
2. Both entry points open the same modal. Do not add a permanent top-level reader navigation item.
3. Default selection is both highlights and vocabulary in Markdown.
4. Markdown and generic CSV can include both record kinds. Anki CSV selects vocabulary only and disables highlights.
5. Preview the first two generated records before the save dialog.
6. Only export data already stored locally. Do not call an AI provider during export.
7. Unavailable fields are omitted in Markdown and left empty in CSV. Never invent context, chapter names, or explanations.
8. The operating-system save dialog owns same-name replacement confirmation. The app does not add a second overwrite dialog.
9. Empty data disables export and explains how to create highlights or save vocabulary.
10. Save failures preserve all app data and offer choosing another location.

## 3. Export schema

The serializers consume one normalized union rather than formatting database rows directly.

### Highlight record

| Field | Source | Rule |
| --- | --- | --- |
| `kind` | constant | `highlight` |
| `bookTitle` | active `Book` | always present |
| `chapter` | `view.getTOCItemOf(cfi_range)` | omit/empty when resolution fails |
| `sourceText` | `Highlight.text_content` | selected text; omit when legacy row has none |
| `note` | `Highlight.note` | omit when blank |
| `color` | `Highlight.color` | stable stored color name |
| `cfi` | `Highlight.cfi_range` | always present for reader highlights |
| `createdAt` | `Highlight.created_at` | ISO-8601 in output |

### Vocabulary record

| Field | Source | Rule |
| --- | --- | --- |
| `kind` | constant | `vocabulary` |
| `bookTitle` | active `Book` / word fallback | active title wins |
| `chapter` | `view.getTOCItemOf(cfi)` | omit/empty when CFI is absent or resolution fails |
| `word` | `DictionaryWord.word` | always present |
| `definition` | `DictionaryWord.definition` | stored dictionary/AI result |
| `context` | `DictionaryWord.context_sentence` | the saved book sentence, not freshly extracted text |
| `contextExplanation` | `DictionaryWord.context_explanation` | omit when absent |
| `mastery` | `DictionaryWord.mastery` | `new`, `learning`, or `mastered` |
| `cfi` | `DictionaryWord.cfi` | omit when absent |
| `createdAt` | `DictionaryWord.created_at` | ISO-8601 in output |

“Context” is intentionally the context already captured when the vocabulary item was saved. Highlights do not currently store surrounding paragraphs, so v1 exports their selected text and note rather than silently re-reading mutable book content and presenting it as stored context.

## 4. Format contracts

### Markdown

- UTF-8, no BOM required.
- One H1 containing book title and “学习资料” / “Study export”.
- Separate `高亮 / Highlights` and `生词 / Vocabulary` H2 sections when selected and non-empty.
- Group records by chapter; unresolved records fall under localized “Unknown chapter”.
- Use blockquotes for highlight source text, bold labels for note/definition/context explanation, and inline code for CFI.
- Output order is source row order (currently newest first); no hidden resort.

### Generic CSV

- UTF-8 with BOM for Excel compatibility.
- RFC-4180-style double-quote escaping for every field.
- Stable headers: `kind,book,chapter,source_text,word,note,definition,context,context_explanation,color,mastery,cfi,created_at`.
- One row per selected record; non-applicable cells stay empty.

### Anki CSV

- UTF-8 with BOM.
- Stable headers: `Front,Back,Source,Tags`.
- One card per vocabulary item only.
- Front: context sentence with the first case-insensitive occurrence of the word replaced by `______`. If no usable context exists, use the word itself so the row remains importable.
- Back: word, definition, optional context explanation, and the original sentence.
- Source: book title plus chapter when available.
- Tags: `lantern`, a filename/tag-safe book-title token, and mastery (`new`, `learning`, `mastered`).
- Create a neighboring localized `.txt` import guide only if the chosen save API can write both files without a second permission prompt. Otherwise include the four field names in the completion copy and defer the guide; do not broaden filesystem permissions for it.

## 5. Architecture

### Pure export module

Add `src/pages/reader/reader-export.ts` containing:

- normalized export record types;
- filename sanitization and default filename selection;
- Markdown, generic CSV, and Anki CSV serializers;
- Anki cloze transformation;
- count/preview helpers.

The module has no React, DOM, Tauri, or Foliate dependency, so Node unit tests can exhaust escaping and missing-field behavior.

### Dialog

Add `src/components/ReaderExportDialog.tsx`.

Responsibilities:

- load current-book highlights and vocabulary through existing hooks;
- maintain selected record kinds, format, and included fields;
- request chapter labels through a callback supplied by `Reader`;
- show normal, empty, preparing, saving, success, and failure states;
- call the system save dialog and write only to the user-approved returned path (the current `SaveDialogOptions` API does not expose `fileAccessMode`);
- write the serialized text through `@tauri-apps/plugin-fs`;
- revoke/reset state on close and when the active book changes.

Do not add a Rust export command or database schema. Export is a read-only composition of already-authoritative rows.

### Reader integration

`Reader.tsx` owns `exportOpen` so either side panel can open the same modal. It passes:

- active book id/title;
- the current Foliate view;
- a chapter resolver that calls `view.getTOCItemOf(cfi)` and returns its label;
- close/open state.

Chapter lookup is on-demand and non-fatal. Resolve with small bounded concurrency rather than `Promise.all` across an unbounded vocabulary list; one failed CFI yields no chapter for that row and does not fail the export.

`BookmarksPanel` and `DictionaryPanel` receive a simple `onExport` callback. They render the same borderless `Download` affordance approved in the mockup.

## 6. Internationalization and accessibility

- Add every new user-facing string to both `src/i18n/en.json` and `zh.json`.
- Modal uses `role="dialog"`, `aria-modal="true"`, a labelled title, initial focus, Escape close, and focus restoration to its opener.
- Format and content choices are real buttons/checkboxes with visible selected states, not clickable decorative divs.
- Preparing/saving is announced with `role="status"`; failures use `role="alert"`.
- Disabled export remains visibly disabled and is excluded from submission.
- Respect `prefers-reduced-motion`; the spinner may rotate only when motion is allowed.

## 7. Failure and data-safety rules

- Cancelling the save dialog is a neutral close, not an error.
- Serialization failure shows an error before opening the save dialog.
- Write failure names the consequence (“file was not written; Lantern data is unchanged”) and retains the current selections for retry.
- Never mutate highlights, vocabulary, notes, mastery state, or sync logs.
- Never log exported content; diagnostics may log format and record counts only.
- Keep the existing Home exports and vocabulary backup paths untouched.

## 8. Test plan

### Unit tests

Add `tests/reader-export.test.ts` covering:

- Markdown grouping, omitted empty fields, stable order, and special characters;
- CSV commas, quotes, newlines, BOM, headers, and mixed record kinds;
- Anki front cloze, missing context fallback, back/source composition, and tag sanitization;
- filename replacement for `/`, `:`, control characters, and blank titles;
- preview/count behavior for zero, one, and mixed records;
- failed/missing chapter resolution degrading to an empty chapter.

### Existing gates

Run:

```bash
npx tsc --noEmit
npx eslint src/pages/Reader.tsx src/components/BookmarksPanel.tsx src/components/DictionaryPanel.tsx src/components/ReaderExportDialog.tsx src/pages/reader/reader-export.ts tests/reader-export.test.ts
npm run build
npm run test:unit
```

### Visual acceptance

- Entry icon matches the corrected approved mockup: standard `Download`, no permanent border/background.
- Verify Markdown, Anki, empty, preparing, success, and failure states in paper and dark app themes.
- Save each format, inspect actual contents, and confirm cancelled saves create no file.
- Confirm both normal and standalone reader windows can save to a user-selected location.

## 9. Explicit non-goals

- Cross-book/library-wide structured export.
- Importing Markdown or Anki files.
- Network publishing or direct integrations with Notion, Obsidian, Readwise, or AnkiConnect.
- Fresh AI generation during export.
- Reconstructing surrounding highlight paragraphs that were never stored.
- Changing vocabulary backup schemas or sync payloads.
