# Implementation Plans

Detailed implementation plans for features and bug fixes. Numbers match the corresponding [feature spec](../features/) where one exists; standalone fixes use the next available number. A `q` prefix marks a number inherited from Quill, the upstream project this was renamed from — see [the note in `features/README.md`](../features/README.md).

**Shipped plans move to [`archive/`](archive/).** A plan stays in the active list below only while it still owes work — code, acceptance, or a decision. Every file in this directory belongs to exactly one of the two lists; a plan that is in neither is how this index drifted before.

## Active — still owes work

- [Responsive and touch foundation](responsive-foundation.md) —
  the `md:` / `touch:` vocabulary and the safe-area insets are in place and invisible on
  desktop. It owes its first consumers: nothing reads the insets yet, and the two problems
  it uncovered — the 14px input font that makes iOS zoom on focus, and `100vh` as the shell
  on every route — belong to the components, which it was not allowed to touch.
- [The Home sidebar becomes a drawer](mobile-home-drawer.md) —
  P2 item 2. Mockup approved 2026-08-06 and the gesture kernel is in flight; the drawer
  itself, the collections touch actions and the `hasTitleBarInset` wiring are all owed.
- [On-demand book download](on-demand-book-download.md) —
  the backend ships (`faf43ee`); the shelf badge and in-reader progress are P2 item 8 and
  owed. The metered-connection gate (D-016) is marked at its call site and not built.
- [The iCloud metadata watcher](icloud-metadata-watcher.md) —
  design only. P5 item 3, unimplemented: it needs two `objc2-foundation` Cargo features
  this repo does not enable yet, and its one real risk is unverifiable off hardware.
- [P2.2 — contextual vocabulary review](vocab-contextual-review.md) —
  approved progressive audio/meaning hints and context-first review; implementation is pending.
- [Reader P2.1 — structured highlights and vocabulary export](reader-p2-structured-export.md) —
  approved reader-side export UI; implementation and acceptance are pending.
- [Built-in AI model catalog and automatic routing](built-in-ai-model-catalog-and-routing.md) —
  Phases 1–3 shipped, and the DeepSeek connect path passed a manual run on 2026-08-03.
  Seven acceptance items are still open because that run could not reach them (clean
  install, exhausted quota, revoked key, English UI, logs and exports) — see §11.
  Phase 4 (an online catalog) is deliberately deferred, not owed.
- [macOS distribution: the Gatekeeper "damaged" problem](macos-distribution-gatekeeper-fix.md) —
  a living document. Route A is chosen and the Apple Developer application is submitted;
  waiting on Apple's review. Until it lands, every release artifact is ad-hoc signed and
  every downloading user hits Gatekeeper.
- [q243 — Update Experience: Pill, App-Menu Check, Formal About](q243-update-experience.md) —
  **deferred, and needs rebasing before anyone starts.** It was written against Quill, whose
  update UI Lantern never inherited: there is no updater plugin, no `UpdateToast`, no
  `useUpdateChecker` here. The plan reads as "extend what exists"; the real job is "build it
  from nothing."

## Archive

- [1 — Grounded Book Chat: Overview](archive/1-grounded-book-chat-overview.md)
  - [Phase 1 — Indexing + Retrieval](archive/1-grounded-book-chat-phase1-indexing-retrieval.md)
  - [Phase 2 — Summaries + Citations](archive/1-grounded-book-chat-phase2-summaries-citations.md)
  - [Phase 3 — Enhancements](archive/1-grounded-book-chat-phase3-enhancements.md)
- [q30 — MCP Server](archive/q30-mcp-server.md)
- [MCP Surface Refresh](archive/mcp-surface-refresh.md)
- [MCP scope: context equity](archive/mcp-scope-goal.md) — the goal the 29-tool
  rework was built against, with the discarded 67-tool round beside it
- [q123 — Standalone Chat View](archive/q123-standalone-chat-view.md)
- [q263 — Tools Settings + Ephemeral Translate](archive/q263-reading-tools-consolidation.md)
- [q286 — Explicit Lookup Language](archive/q286-explicit-lookup-language.md)
- [Reader layout upgrades, settings UI fixes, and credential P1](archive/reader-layout-upgrades-and-settings-ui-fixes.md)
- [11 — Vocabulary-aware lookup](archive/11-vocab-aware-lookup.md) — the in-app half of
  the context-equity goal the MCP rework was built against
- [macOS 12 Reader WebKit compatibility](archive/macos-12-reader-webkit-compatibility.md)
- [Pronunciation — play button, UK/US toggle, pluggable speech sources](archive/pronunciation.md)
- [Read Aloud — adaptive playback for any selection](archive/read-aloud.md)
- [Reasoning effort, speech rate, TTS model list, free book sources](archive/reasoning-effort-speech-rate-book-sources.md)
- [Syncable custom fonts](archive/syncable-custom-fonts.md)
- [Deletable, restorable preset lists](archive/deletable-preset-items.md) — its status line
  said "not implemented" for a day after the code landed; the appendix records the audit that
  settled it and the 12 checks that still need eyes on a screen
