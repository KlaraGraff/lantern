# Lantern Reader P2–P3.4 delivery and QA report

Date: 2026-08-04.

## Conclusion

P2.1–P2.5 and P3.1–P3.4 are implemented and pass the repository's frontend, Rust, documentation, build, and Safari compatibility gates. Cross-feature review found and closed two P3.4 integration defects before delivery: X-Ray is now mutually exclusive with Reader side workspaces, and an occurrence jump closes the card only after an explicit successful navigation.

This is a code and background-visual acceptance pass, not a claim of real-device completion. The external validation boundaries at the end remain explicit.

## Completion matrix

| Item | Delivered result | Evidence |
| --- | --- | --- |
| P2.1 | Current-book Markdown, CSV, and Anki CSV export from highlights/vocabulary; local generation and system save flow | `e626a37`; export tests; screenshot `p21` |
| P2.2 | Context sentence cloze; hint order pronunciation → saved Chinese meaning → answer; safe word-first fallback | `a41a3d6`; contextual-review tests; screenshot `p22` |
| P2.3 | Reflowable typography controls, language-aware hyphenation/indentation, four spacing levels, publisher-style default | `7e348df`; typography/capability tests; screenshot `p23` |
| P2.4 | Per-book/global scope, restore/promote/selected-book application, fixed picker regions, transactional cleanup and sync tombstones | `7e348df`; Rust settings/sync tests; screenshot `p24` |
| P2.5 | Layout-participating top continuous-read-aloud player with collapse, sentence controls, rate, auto page/section progression | `dd9b380`; continuous-read-aloud tests; screenshot `p25` |
| P3.1 | History/calendar shared view, deterministic sessions and facts, user-triggered AI narration/cache, local enhanced-font state machine | `1957a65`; frontend and Rust stats/font tests; screenshots `p31-history`, `p31-ai`, `p31-font` |
| P3.2 | Margin notes rail with anchored layout, narrow-window fallback, draft/error/delete/navigation states | `ac5f8d3`; notes-rail tests; screenshot `p32` |
| P3.3 | One global passive-vocabulary state with selectable ruby/margin style and density; EPUB capability gating | `5354009`; passive-vocab tests; screenshot `p33` |
| P3.4 | Spoiler-safe person/term/relationship card, explicit whole-book confirmation, FTS context, cache/update and return-history navigation | `103240c`, `87eb006`, `f992962`; X-Ray tests; screenshot `p34` |

Screenshot identifiers link from the [background visual QA record](reader-p2-p3-headless-qa.md).

## Cross-feature findings verified

- P2.3 typography keys participate in P2.4 per-book/global merge; promotion and matching override cleanup are one Rust transaction, and synchronized deletions use tombstones.
- P3.3 uses only global `passive_vocab_*` settings and is absent from the per-book setting whitelist.
- Notes, AI, bookmarks, vocabulary, and X-Ray cannot occupy conflicting Reader workspaces together; narrow notes/X-Ray layouts remain in the document flow defined by their final designs.
- P2.5 is limited to reflowable EPUB, streams adjacent sections, and automatic reveals do not add entries to return history.
- P3.1 closes or checkpoints sessions across inactivity, blur, book switches, sleep-like clock jumps, and Reader exit; backend discards sessions under 30 seconds.
- P3.1 sends AI only its allow-listed, reproducible facts. Failures and quota/offline states do not overwrite a prior successful cache.
- P3.4 defaults to the current safe reading boundary, uses full-text retrieval rather than a new vector store, and keeps results visible when a target cannot be reached.
- PDF and fixed-layout capability guards keep reflow-only P2.3, P2.5, and P3.3 controls unavailable.

## Verification record

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed |
| `npm run lint` | Passed |
| `npm run test:unit` | Passed: 463/463 |
| `npm run build` | Passed; production Vite build completed |
| `npm run check:reader-compat` | Passed; Safari 15 reader assets and PDF.js compatibility report generated |
| `npm run check:docs` | Passed |
| `cargo fmt --check` | Passed |
| `cargo check` | Passed |
| `cargo test` | Passed: 733 library tests + 2 MCP integration tests; 11 explicitly ignored |
| `cargo clippy -- -D warnings` | Passed |
| Background visual QA | 11 key screenshots recorded; no foreground window used |

## Commits

| Commit | Scope |
| --- | --- |
| `e626a37` | P2.1 structured export |
| `a41a3d6` | P2.2 contextual review |
| `7e348df` | P2.3 typography + P2.4 settings scope |
| `ac5f8d3` | P3.2 margin notes rail |
| `5354009` | P3.3 passive vocabulary annotations |
| `dd9b380` | P2.5 continuous read aloud |
| `103240c` | P3.4 spoiler-safe context cards |
| `1957a65` | P3.1 reading history, AI review, enhanced fonts |
| `87eb006` | P3.4 bilingual whole-book action |
| `f992962` | P3.4 navigation acknowledgement and workspace exclusion |

## External validation boundaries

- Real Tauri + EPUB/PDF: the background policy prevented a foreground app run, so the system save dialog, Foliate footnotes, real cross-chapter speech, keyboard focus, and narrow live-reader layout require a later device pass.
- iCloud two-device sync: settings tombstone replay is covered by Rust tests, but no two physical devices were connected in this run.
- Production AI: no billable provider request was made; unconfigured, offline, quota, prompt allow-list, and cache behavior are code/test evidence rather than a live-provider claim.
- Enhanced Chinese font pack: no trusted production URL/size/SHA-256 manifest exists in this repository. The feature therefore reports the pack as unavailable and keeps system fonts. A production build can inject `LANTERN_ENHANCED_FONT_VERSION`, `LANTERN_ENHANCED_FONT_SIZE`, `LANTERN_ENHANCED_FONT_SHA256`, and `LANTERN_ENHANCED_FONT_URL` after a trusted asset is selected.

P3.5, the postponed unification of existing sentence/paragraph speech markers, release tags, and version changes are intentionally outside this delivery.
