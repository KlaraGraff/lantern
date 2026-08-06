# Reader P2–P3 integration ledger

Status: completed integration record for P2.1–P2.5 and P3.1–P3.4.

`HANDOFF.md` is a user-owned process file and is never part of this delivery.

## Ownership and commit boundaries

| Boundary | Feature-local files | Shared integration files |
| --- | --- | --- |
| P2.1 structured export | `ReaderExportDialog.tsx`, `reader-export.ts`, `reader-export.test.ts` | `Reader.tsx`, `BookmarksPanel.tsx`, `DictionaryPanel.tsx`, locale files |
| P2.2 contextual review | `vocab/contextual-review.ts`, `vocab-contextual-review.test.ts` | `DictionaryContent.tsx`, locale files |
| P2.3 + P2.4 reader settings | `reader-typography.ts`, `reader-settings-scope.ts`, their tests and implementation docs | `Reader.tsx`, `ReaderSettings.tsx`, `ReadingSettings.tsx`, `useReaderSettingsSync.ts`, `useFoliateView.ts`, `TextBookReader.tsx`, settings/sync Rust files, locale files |
| P2.5 continuous read aloud | new continuous-read-aloud controller and toolbar, focused tests, approved toolbar mockup and implementation doc | minimal `Reader.tsx` / Foliate integration and locale files |
| P3.1 reading statistics | new session/statistics/AI-review/font-pack modules, focused tests and final implementation docs | Reader lifecycle, AI command registration, settings/appearance entry, locale files |
| P3.2 notes rail | `ReaderNotesRail.tsx` and focused tests | `Reader.tsx`, Foliate navigation hooks, locale files |
| P3.3 passive vocabulary | `passive-vocab.ts`, `PassiveVocabSettings.tsx`, focused tests | reader settings/event/annotation hooks, `Reader.tsx`, locale files |
| P3.4 contextual X-Ray card | `ReaderXrayCard.tsx`, `xray-card.ts`, Rust `commands/ai/xray.rs`, focused tests and final implementation doc | `Reader.tsx`, `ReaderContextMenu.tsx`, AI/lib command registration, locale files |

P2.3 and P2.4 remain separate product acceptance rows. They share one commit boundary because the typography keys, per-book merge controller, promotion commands, and sync tombstones form one compile- and data-consistency closure; splitting that closure would create an invalid intermediate commit.

## Shared-file discipline

The following files are serial-integration hotspots and have one writer at a time: `Reader.tsx`, `ReaderSettings.tsx`, `ReadingSettings.tsx`, `useReaderSettingsSync.ts`, `useFoliateAnnotations.ts`, `useFoliateView.ts`, `useReaderNavigation.ts`, `foliate-types.ts`, both locale files, and the Rust settings/sync files. Feature-local work may run in parallel, but only the primary integration task stages shared hunks.

## Integration order

1. P2.1 structured export.
2. P2.2 contextual review.
3. P2.3 typography + P2.4 settings scope/sync closure.
4. P3.2 notes rail.
5. P3.3 passive vocabulary.
6. P2.5 continuous read aloud.
7. P3.4 contextual X-Ray card.
8. P3.1 reading statistics, AI review, and enhanced-font delivery.
9. Cross-feature verification and the P3.4 mutual-exclusion/navigation closeout.
10. Clean-HEAD verification, evidence report, and push.

Each boundary requires final product/document comparison, focused tests, paired English/Chinese strings, staged-diff review, and `git diff --check` before commit. Full frontend, Rust, compatibility, documentation, and Headless checks run again after all boundaries are integrated.

## Delivered commits

| Boundary | Commit |
| --- | --- |
| P2.1 | `e626a37` |
| P2.2 | `a41a3d6` |
| P2.3 + P2.4 | `7e348df` |
| P3.2 | `ac5f8d3` |
| P3.3 | `5354009` |
| P2.5 | `dd9b380` |
| P3.4 | `103240c` |
| P3.1 | `1957a65` |
| P3.4 locale closeout | `87eb006` |
| P3.4 navigation and workspace closeout | `f992962` |
