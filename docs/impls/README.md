# Implementation Plans

Detailed implementation plans for features and bug fixes. Numbers match the corresponding [feature spec](../features/) where one exists; standalone fixes use the next available number. A `q` prefix marks a number inherited from Quill, the upstream project this was renamed from — see [the note in `features/README.md`](../features/README.md).

**Shipped plans move to [`archive/`](archive/).** A plan stays in the active list below only while it still owes work — code, acceptance, or a decision. Every file in this directory belongs to exactly one of the two lists; a plan that is in neither is how this index drifted before.

## Active — still owes work

- [Responsive and touch foundation](responsive-foundation.md) —
  the `md:` / `touch:` vocabulary and the safe-area insets are in place and invisible on
  desktop. The 16px floor that stops iOS zooming on focus landed here too, as one rule
  rather than 25 identical component edits. It owes its first consumers: nothing reads the
  insets yet, and `100vh` is still the shell on every route, which belongs to the pages.
- [On-demand book download](on-demand-book-download.md) —
  the backend ships (`faf43ee`); the shelf badge and in-reader progress are P2 item 8 and
  owed. The metered-connection gate (D-016) is marked at its call site and not built.
- [The iCloud metadata watcher](icloud-metadata-watcher.md) —
  design only. P5 item 3, unimplemented: it needs two `objc2-foundation` Cargo features
  this repo does not enable yet, and its one real risk is unverifiable off hardware.
- [Built-in AI model catalog and automatic routing](built-in-ai-model-catalog-and-routing.md) —
  Phases 1–3 shipped, and the DeepSeek connect path passed a manual run on 2026-08-03.
  Seven acceptance items are still open because that run could not reach them (clean
  install, exhausted quota, revoked key, English UI, logs and exports) — see §11.
  Phase 4 (an online catalog) is deliberately deferred, not owed.
- [q243 — Update Experience: Pill, App-Menu Check, Formal About](q243-update-experience.md) —
  **deferred, and needs rebasing before anyone starts.** It was written against Quill, whose
  update UI Lantern never inherited: there is no updater plugin, no `UpdateToast`, no
  `useUpdateChecker` here. The plan reads as "extend what exists"; the real job is "build it
  from nothing."
- [Auto-update signing setup](auto-update-setup.md) —
  keys and GitHub Secrets are in place; every line of code is still owed. The plan half
  lives in q243 above.
- [Mockup gap audit, 2026-08-06](mockup-gap-audit-2026-08-06.md) —
  open decision list G-00–G-I: credential sync on iOS, network gating, OPDS for book
  sources, the auto-analysis console mismatch, and two authoring-page gaps. Its two
  unapproved mockups stay beside it:
  [mobile-authoring-pages-mockup.html](mobile-authoring-pages-mockup.html) and
  [auto-analysis-console-mockup.html](auto-analysis-console-mockup.html).

Reference, not a plan: [lantern-feature-flow-map.html](lantern-feature-flow-map.html) —
six diagrams of how the shipped features hand off to each other, the companion picture to
[`roadmap/feature-linkage-analysis-2026-08.md`](../roadmap/feature-linkage-analysis-2026-08.md).

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
- Reader P2/P3 line, shipped and accepted (archived 2026-08-06, mockups and QA records
  alongside):
  [P2.1 structured export](archive/reader-p2-structured-export.md) ·
  [P2.2 contextual review](archive/vocab-contextual-review.md) ·
  [P2.3 typography](archive/reader-p2-typography.md) ·
  [P2.4 settings scope](archive/reader-p2-settings-scope.md) ·
  [P2.5 continuous read-aloud](archive/reader-p2-continuous-read-aloud.md) ·
  [P3.1 reading stats](archive/reader-p3-reading-stats.md) ·
  [P3.2 notes rail](archive/reader-p3-notes-rail.md) ·
  [P3.3 passive vocab](archive/reader-p3-passive-vocab.md) ·
  [P3.4 X-Ray](archive/reader-p3-xray.md) ·
  [P1 acceptance](archive/reader-p1-acceptance-report.md) ·
  [QA report](archive/reader-p2-p3-qa-report.md) ·
  [headless QA](archive/reader-p2-p3-headless-qa.md) ·
  [independent review](archive/reader-p2-p3-independent-review-2026-08-04.md) ·
  [integration ledger](archive/reader-p2-p3-integration-ledger.md)
- The mastery/reading-flow line, shipped 2026-08-06:
  [reading-driven mastery and review](archive/reading-driven-mastery-and-review.md) (design) ·
  [wiring mastery into reading](archive/wiring-mastery-into-reading.md) ·
  [reading-flow decisions](archive/reading-flow-decisions-2026-08-06.md) ·
  [book difficulty](archive/book-difficulty.md) ·
  [word-frequency data sources](archive/word-frequency-data-sources.md) (decision recorded in-file)
- Mobile P2, shipped: [the Home sidebar becomes a drawer](archive/mobile-home-drawer.md) ·
  [settings take the phone's shape](archive/mobile-settings.md)
- [AI router cc-switch review](archive/ai-router-cc-switch-review.md) — review implemented
  in full, §6 is the record
- [Apple notarization record](archive/apple-notarization-record.md) — archived 2026-08-06
  with both §6 chores closed by decision: no password rotation, no manual key backup
  (GitHub secret + local Keychain are the two copies; both risks accepted by the user).
- [macOS distribution: the Gatekeeper "damaged" problem](archive/macos-distribution-gatekeeper-fix.md) —
  resolved and archived 2026-08-06: Developer ID signing works, 2.9.0 was notarized and
  Accepted, users no longer hit Gatekeeper. The current pipeline is documented in
  [`guide/macos-distribution.md`](../guide/macos-distribution.md).
