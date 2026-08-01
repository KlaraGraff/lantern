# Mobile — iOS

Ship Lantern as an iOS app: a **reading-focused subset** of the desktop app, kept in step
through iCloud sync. Desktop stays the place where books get in and get processed.

Out of scope for this milestone: **Android** ([D-002](#d-002--ios-first-android-deferred)) and
**Windows sync** ([D-007](#d-007--windows-sync-is-out-of-scope)). Sync means iOS ↔ macOS.

**Status:** Planning. No code written yet.
**Estimated effort:** 78–84 engineer-days across 7 phases.

---

## 1. Goals and non-goals

The guiding model is *companion, not clone* — the phone consumes what the desktop produces.

| On iOS | Desktop only |
|---|---|
| Read EPUB / PDF / TXT / MD / HTML | Import via drag-and-drop |
| Word lookup + lookup history | OCR (see [D-003](#d-003--ocr-stays-on-desktop)) |
| Vocabulary list + FSRS review | MOBI / AZW3 / FB2 / CBZ conversion (needs Calibre) |
| Reader settings (font size, theme, page-turn) | MCP server + client registration |
| Import a book via the system file picker | Full settings surface |
| Receive everything over iCloud sync | Font import, custom font management |

**Deferred to a second iOS release**, not cut permanently:

- AI chat, note editing, collection management
- PDF cover thumbnails (needs pdfium on iOS — the reader itself works without it)
- "Open in Lantern" from other apps (needs file-association / UTI work)

---

## 2. Decision log

The point of this section is that three months from now nobody — including the author —
remembers *why*. Each entry records the reasoning and what would justify reversing it.

### D-001 — Tauri 2 mobile, not a rewrite

Port the existing Tauri app rather than building a native iOS client or a shared-core +
native-UI split (the Anki `rslib` model).

**Why:** the Rust backend (~58k lines) is almost entirely portable, and the reader engine —
the part that would be most expensive to rebuild — already runs on the exact WebView
generation iOS ships (see [F-004](#f-004--the-reader-engine-is-already-webkit-safe)).
Readest ships the same stack (Tauri v2 + foliate-js) on the iOS App Store, so the path is
proven. A shared-core split would mean maintaining a second UI, which is not viable solo.

**Revisit if:** WKWebView performance on real devices turns out to be unacceptable for
paginated reading, or App Review rejects the architecture.

### D-002 — iOS first, Android deferred

**Why:** every Android-specific blocker is absent on iOS. `HOME` is set on iOS so the path
helpers do not panic; `keyring` has an Apple backend; `reqwest`'s default TLS resolves to
Security.framework instead of OpenSSL; WKWebView implements `speechSynthesis` and Android
System WebView does not; the file picker returns a real path instead of a `content://` URI.
Android needs roughly 25–35 extra days of platform work that iOS does not.

**Cost of this choice:** Android users get nothing from this milestone. Accepted.

**Revisit after:** iOS ships and the capability layer ([D-005](#d-005--capability-flags-not-platform-checks))
has proven itself. Android then reuses phases P1–P3 wholesale.

### D-003 — OCR stays on desktop

The phone never runs OCR. It reads OCR output that the desktop produced and synced.

**Why:** the current pipeline downloads a ~1 GB native runtime from GitHub Releases and
executes it as a child process. That is impossible on iOS (no `fork`/`exec` for third-party
apps) and violates App Store guideline 2.5.2. Re-implementing over Vision.framework would
cost 10–15 days for a feature that belongs on the machine with the scanner anyway.

**Implementation:** `#[cfg(not(target_os = "ios"))]` on the whole `commands::ocr` module,
drop its entries from the mobile `invoke_handler`, hide the OCR settings section behind
`hasOcr: false`.

**Related desktop bug found while auditing:** `ocr_package_download` is registered in the
default build (`src-tauri/src/lib.rs:729`) with no `pipeline_enabled()` guard — only
`commands/ocr/manager.rs:516` has one. The download path is therefore reachable in a stock
release binary, contrary to the stated fail-closed posture. Fix this on desktop
independently of the mobile work.

### D-004 — Desktop multi-window is kept

The one-window-per-book model stays on desktop. iOS uses in-window routing instead.

**Why:** both code paths already exist and both already run — `isStandaloneWindow === false`
is a working path in `src/pages/Reader.tsx` today. Gating on a capability flag costs nothing.
Removing multi-window from desktop is a separate, behaviour-changing refactor that should not
ride along inside an already-large port.

**Revisit after:** iOS ships. If the feature turns out to be unused, removing it also deletes
the cross-window `emitTo` fan-out, window-size persistence, and the `reader-*` capability
entries — roughly 2–3 days of cleanup and a permanent reduction in maintenance surface.

### D-005 — Capability flags, not platform checks

All platform differences resolve through one capability object. Components ask
"does this platform have windows?", never "is this iOS?".

```ts
// src/services/platform.ts
hasWindow          // openReaderWindow() vs navigate()
hasTitleBarInset   // macOS traffic-light padding
hasSafeAreaInset   // notch / home indicator
hasDragDrop        // register onDragDropEvent or not
hasContextMenu     // right-click vs long-press
hasOcr             // D-003
hasMcpIntegration  // MCP settings tab
hasFormatConvert   // Calibre-backed conversion entry points
hasFolderSync      // folder-picker sync settings section
isMobile / isIOS
```

**Why:** platform branching is currently scattered across `cfg(target_os = "macos")` in Rust,
`WebviewWindow` calls in the frontend, title-bar padding, and drag-drop registration, with no
single place that answers what a platform can do. "Mobile is a subset of desktop" becomes,
concretely, a set of `false` values on this object. Adapted from Readest's `AppService`
interface (`apps/readest-app/src/types/system.ts`).

**Build this before the single-window work** — that work consumes `hasWindow`.

### D-006 — Sync ships in v1

**Why:** without sync, "process on the desktop, read on the phone" does not hold, and the
iOS app degrades into a standalone reader that competes with better standalone readers. The
sync engine itself is storage-agnostic and ports unchanged (see [F-005](#f-005--the-sync-engine-is-storage-agnostic)),
so the cost is entitlement configuration and change-notification, not a re-architecture.

**Scope:** iOS ↔ macOS only. See [D-007](#d-007--windows-sync-is-out-of-scope).

### D-007 — Windows sync is out of scope

This milestone syncs iOS with macOS. Windows desktop does not join that link.

**Why:** the iOS app will use its own iCloud ubiquity container, which Windows has no API for.
Making Windows reachable would mean either exposing the container as a public document scope
and hoping iCloud for Windows picks it up (unverified — see [Q-001](#q-001--windows-reachability-deferred)),
or building a different transport. Neither is worth blocking iOS on.

**Consequence, stated plainly:** after this milestone a Windows user and an iPhone user cannot
sync with each other. macOS ↔ iOS works. Windows keeps its existing folder-based sync with
other desktops.

**Revisit after iOS ships.** The likely answer then is a separate transport — a consumer cloud
drive or a relay — behind the same storage-agnostic engine ([F-005](#f-005--the-sync-engine-is-storage-agnostic)),
which is also what unblocks Android later.

### D-008 — No backward-compatibility work while the user base is a handful of people

Lantern is still personal-development stage. New versions may drop old data locations, old
settings shapes, and old on-disk layouts outright. Do not write migration code, do not keep
compatibility shims. If something moves, let it move; if a user has to redo a step, that is
acceptable at this scale.

**Why:** migration code accumulates and never gets deleted. `migrate_legacy_app_data()`
(`src-tauri/src/lib.rs:78`) already carries four historical bundle identifiers —
`com.klaragraff.quill`, `com.klagragraff.quill` (a typo), `com.wycstudios.quill`, plus `-dev`
variants — each added as a small courtesy, together now a block nobody dares remove. Paying
that tax for a handful of users is a bad trade.

**Revisit when:** the app is actually distributed and the user base is large enough that
"just redo it" stops being a reasonable thing to say. At that point compatibility becomes a
real obligation and should be budgeted as one.

**Note:** this decision does not apply to the sync relocation — see
[F-009](#f-009--relocating-the-sync-directory-is-already-a-solved-operation), where no
migration code is needed at all.

---

## 3. Verified facts

Established by direct source inspection so future sessions do not re-audit. Each entry names
what was read.

### F-001 — Mobile scaffolding is already in place

- `src-tauri/Cargo.toml:15` already declares `crate-type = ["staticlib", "cdylib", "rlib"]`
- `src-tauri/src/lib.rs:387` already carries `#[cfg_attr(mobile, tauri::mobile_entry_point)]`
- `src-tauri/icons/ios` (18 files) is already generated and tracked
- `src-tauri/gen/` contains only `schemas/` — `tauri ios init` has never been run
- `src-tauri/build.rs` is cross-compile safe; the Node build scripts are host-agnostic
- All four plugins in use (opener, dialog, fs, log) ship iOS implementations

### F-002 — Four compile-time blockers, all verified against vendored source

1. **`Builder::menu` / `on_menu_event`** at `src-tauri/src/lib.rs:432,467` are unguarded.
   Confirmed `#[cfg(desktop)]` at `tauri-2.10.3/src/app.rs:1827,1850`. Hard compile error.
2. **`keyring`** — `src-tauri/src/secrets.rs:6` imports it unconditionally, but
   `src-tauri/Cargo.toml:80,94,104` declares it only for macos/windows/linux. iOS is
   `target_os = "ios"`, so no target table matches and the crate is absent from the graph
   (`E0432`). Note the near-miss: `linux-native` does not cover Android either.
3. **Tauri pin `=2.10.3` is too old.** `capabilities/default.json:12` grants
   `core:webview:allow-create-webview-window`; in 2.10.3 that command lives inside
   `#[cfg(desktop)] mod desktop_commands` (`tauri-2.10.3/src/webview/plugin.rs:12,31,44`).
   In 2.11.5 both `get_all_webviews` and `create_webview_window` are hoisted to module top
   level, ungated (`tauri-2.11.5/src/webview/plugin.rs:22,35`). The ACL is resolved at compile
   time against the target's command set, so 2.11 is the floor.
4. **`reqwest` default features** (`src-tauri/Cargo.toml:42`) pull `native-tls`. Android-only
   problem — `native-tls` gates OpenSSL on `cfg(not(any(windows, target_vendor = "apple")))`,
   so iOS routes to Security.framework. Switching to `rustls-tls` is still worth doing (it
   removes a duplicate TLS stack; `rustls 0.23` is already in the graph via `msedge-tts`).

### F-003 — Path resolution is wrong on iOS, silently

`resolve_log_dir()` and `resolve_app_data_dir()` (`src-tauri/src/lib.rs:135-197`) derive paths
from `HOME` / `XDG_DATA_HOME` with `.expect()` at lines 142, 157, 179, 194. iOS is `cfg(unix)`
and not `macos`, so it falls into the desktop-Linux arm.

iOS does not panic (`HOME` is set to the sandbox container root) — it **succeeds into the
wrong place**: `<container>/.local/share/com.klaragraff.lantern/`. That is a hidden dot
directory outside `Library/`, so it lands in iCloud/iTunes backup with no
`NSURLIsExcludedFromBackupKey`, and it diverges from `app.path().app_data_dir()`
(`<container>/Library/Application Support/<id>`), leaving two disagreeing data roots. Three
runtime callers use it: speech cache, imported fonts, OCR runtime.

### F-004 — The reader engine is already WebKit-safe

`scripts/build-reader-assets.mjs` transpiles every reader `.js` and `.css` to a `safari15`
target; `scripts/check-reader-compat.mjs` hard-fails the build on `structuredClone`,
`Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`, the RegExp `v` flag, `:has()`,
`@container`, `oklch()`, `dvh/svh/lvh`, and others. That banned list is effectively the
WKWebView capability boundary. Work done for macOS 12 / Safari 15 support covers iOS.

Bundle size is a non-issue: the 98 MB `public/foliate-js` figure is misleading — 81 MB is a
gitignored nested `node_modules/` that `build-reader-assets.mjs` deletes. Shipped `dist/` is
23 MB.

### F-005 — The sync engine is storage-agnostic

`src-tauri/src/sync/log.rs`, `merge.rs`, `replay.rs`, and `snapshot/` (~6,200 lines: event
log, ULID ordering, merge, replay, snapshot/compaction) do not care where the directory
lives. Porting means changing *where data sits* and *how change is detected*, not the engine.

Also relevant: sync currently **fails closed** on iOS rather than misbehaving.
`$HOME/Library/Mobile Documents` does not exist there, so `is_icloud_drive_dir()` returns
false, `ubiquity_dir` stays `None` (`src-tauri/src/lib.rs:565`), the engine never boots
(`lib.rs:696-701` logs a warning), and `data_dir` falls back to the local directory. The app
runs correctly as a single-device reader; only the settings folder button is dead UI.

### F-006 — iOS book import works with zero code changes

`src-tauri/src/commands/books/import.rs:482-488` calls `blocking_pick_file()` then
`.into_path()`. On iOS the dialog plugin uses
`UIDocumentPickerViewController(forOpeningContentTypes:asCopy:)`
(`tauri-plugin-dialog-2.6.0/ios/Sources/DialogPlugin.swift:119-121`) with
`asCopy: args.fileAccessMode == .scoped ? false : true`. Lantern never sets
`fileAccessMode`, and the Rust default is `None` (`src/lib.rs:419`), so `asCopy: true` —
iOS copies the picked file into the app sandbox and returns a plain `file://` URL.
`into_path()` succeeds and the downstream `fs::copy` works.

**Caveat:** `parseFiltersOption` (`DialogPlugin.swift:183-197`) maps extensions through
`UTType(filenameExtension:)`. The system resolves epub/pdf/txt/md/html; mobi/azw3/fb2/cbz
have no system UTType and are silently dropped from the filter, so those files appear greyed
out in the picker. Declaring them in `Info.plist` (`UTImportedTypeDeclarations`) fixes the
picker — but those formats need Calibre conversion
(`src-tauri/src/commands/books/convert_prepare.rs:132`) and cannot be read on iOS regardless.
Formats that need no conversion are listed at `src-tauri/src/commands/books/format.rs:40`:
EPUB, PDF, TXT, Markdown, HTML.

### F-009 — Relocating the sync directory is already a solved operation

Data is split. `quill.db` — notes, vocabulary, reading progress, highlights — always lives in
the local app-data dir and never enters the sync folder (`src-tauri/src/db.rs:239-247`
`init_split`, and the test at `db.rs:630` asserts exactly this). The sync folder holds only
`books/`, `covers/`, `sources/` and the event log.

Both directions of moving those blobs are already implemented, including iCloud placeholder
handling that avoids copying a `.name.icloud` stub as if it were the real file
(`src-tauri/src/commands/sync.rs:847` `reconcile_local_blobs_to_ubiquity`, and the reverse in
`sync_disable`).

So relocating macOS from a picked folder to the app container is *disable, then enable* —
covered end to end by existing code. No user data is at risk, because the metadata never moved
in the first place.

### F-007 — The frontend has essentially no responsive design

- 6 of 75 components in `src/components` + `src/pages` use any Tailwind breakpoint, and the
  smallest is `sm:` (640px) — every phone width falls into unprefixed desktop base classes
- `src/index.css` has exactly one media query (`prefers-reduced-motion`, line 256)
- Zero `env(safe-area-inset-*)`, zero `touch-action`; `index.html:6` lacks `viewport-fit=cover`
- 90 hardcoded pixel widths across 40 files, 25 of them ≥300px (wider than a 390pt viewport)
- Home is a fixed 224px sidebar + main (`src/pages/Home.tsx:279`, `src/components/Sidebar.tsx:29-31`)
- Reader is TOC aside (320px) + viewer + resizable panel (min 320px)
  (`src/pages/reader/useSidePanelResize.ts:10-12`, `src/components/TableOfContents.tsx:110`)
- `src/pages/reader/usePageTurnInput.ts:140-148` handles keydown/mousedown/wheel only; there
  is no `touchstart`, `maxTouchPoints`, or `pointer: coarse` anywhere in `src/`

i18n is clean: 1,235 keys at exact parity between `src/i18n/en.json` and `zh.json`, no
hardcoded user-facing English found.

### F-008 — Single-window routing already exists

`/reader/:bookId` is a live route (`src/App.tsx:80`) and the in-window path is exercised —
`isStandaloneWindow === false` renders the TOC toggle (`src/pages/Reader.tsx:1555`) and
navigates home (`:1346`). `src/utils/openReaderWindow.ts:81` is the multi-window entry point;
`src/App.tsx:18` routes on `getCurrentWebviewWindow().label === "main"`.

Two consequences of switching to routing, both silent failures:

1. Cross-window `emitTo` fan-out delivers to nobody once `getAll()` returns one window —
   vocabulary and lookup marks stop refreshing, with no error.
2. `SettingsModal` is mounted only inside `Home` (`src/pages/Home.tsx:435`). Under routing,
   Home is unmounted while reading, so the reader's five "open settings" affordances become
   dead buttons.

---

## 4. Open questions

### Q-001 — Windows reachability (deferred)

Whether declaring `NSUbiquitousContainers` with `NSUbiquitousContainerIsDocumentScopePublic`
surfaces the app's container in iCloud Drive such that iCloud for Windows syncs it. Confidence
was medium and it was never verified against first-party documentation.

**No longer blocks anything** — [D-007](#d-007--windows-sync-is-out-of-scope) scopes Windows
out. The container can stay private, so the question does not need answering for this
milestone. Kept here because it is the first thing to check if Windows sync comes back.

### Q-004 — macOS relocation to the app container (largely answered)

Desktop sync today points at a *user-picked* folder. For iOS to meet macOS, macOS has to use
the app's own ubiquity container instead. This looked like a migration problem; it mostly is
not — see [F-009](#f-009--relocating-the-sync-directory-is-already-a-solved-operation).

Remaining work: detect a recorded `.sync_setting` pointing outside the container and chain the
existing disable → enable path once. **~0.5 day, folded into P5.**

### Q-002 — Does the reader hold acceptable memory on a real device?

Whole books load as a single in-memory Blob, and PDF pages render at
`zoom × devicePixelRatio`. On a 3× DPR phone both are plausible ways to hit the WebView
memory ceiling. Readest addresses the same problem by parsing EPUB/MOBI in Rust to avoid
ferrying large blobs across IPC.

**Verify during P0** on the largest book available, before committing to the P4 budget.

### Q-003 — Does iOS text selection fight the lookup popover?

The system selection loupe and callout bar may collide with the reader's custom word-lookup
popup. Estimated at 6 days inside P3, but the real cost depends on whether the callout can be
suppressed cleanly in WKWebView.

---

## 5. Phases

Each phase ends in something checkable. Do not start the next until the exit criterion holds.

### P0 — Compile and boot (6 days)

Smallest possible reality check: does the Rust core survive the port at all.

1. Bump `tauri` to `=2.11.x` and `tauri-build` to `=2.6.x`; bump `@tauri-apps/api` and
   `@tauri-apps/cli` to `^2.11`; run `cargo check` to resync `Cargo.lock`
2. `#[cfg(desktop)]` the menu wiring at `src-tauri/src/lib.rs:432,467`
3. cfg out the legacy keychain path in `secrets.rs`; set `use_keychain: false` on mobile
4. Add explicit iOS arms to `resolve_log_dir()` / `resolve_app_data_dir()`; replace every
   `.expect()` with a fallback; drop the `-dev` suffix on mobile
5. Switch `reqwest` to `rustls-tls`; re-run the desktop CI matrix
6. cfg out `commands::ocr` on iOS and drop its `invoke_handler` entries
7. `tauri ios init`, then `tauri ios dev`

**Exit criterion:** the app launches in the iOS Simulator, the library screen renders, and a
book opens — however badly it is laid out. Answer [Q-002](#q-002--does-the-reader-hold-acceptable-memory-on-a-real-device) here.

**If this fails**, stop and reassess. Nothing after this point is worth doing.

### P1 — Capability layer and single-window navigation (11 days)

1. Build `src/services/platform.ts` per [D-005](#d-005--capability-flags-not-platform-checks);
   migrate existing scattered platform checks into it
2. Route `openReaderWindow()` through `hasWindow` — `navigate()` on iOS. Nine call sites need
   router access
3. Replace the three cross-window `emitTo` fan-outs with a single-window-aware helper
4. Hoist `<SettingsModal>` from `Home` into `App.tsx`
5. Hide desktop-only surfaces behind capability flags: MCP tab, OCR section, format
   conversion, reveal-logs, drag-drop CTA, sync folder picker, font import
6. No-op `useWindowSizePersistence` on mobile

**Exit criterion:** on iOS, tapping a book navigates in-window and back works; no dead
buttons anywhere; desktop behaviour is unchanged (verify the desktop build explicitly).

### P2 — Mobile UI (18.5 days)

Scope is the reduced surface from [§1](#1-goals-and-non-goals).

1. Global: `viewport-fit=cover`, safe-area insets, `touch-action` defaults, breakpoint system
2. Home: 224px sidebar → drawer or bottom nav
3. Reader: three-column → phone layout (TOC as drawer, side panel as bottom sheet)
4. Reduced settings: font size, theme, page-turn mode only
5. Lookup / translation popovers → bottom sheets
6. The subset of the 25 wide hardcoded widths that the reduced surface touches
7. `Info.plist` UTI declarations for the picker filter ([F-006](#f-006--ios-book-import-works-with-zero-code-changes))

**Exit criterion:** every screen in scope is usable one-handed on an iPhone SE viewport with
no horizontal scroll.

### P3 — Reader touch interaction (10 days)

1. Page-turn: tap zones, swipe, chrome toggle
2. Word lookup via long-press; disambiguate from selection
3. Resolve the iOS selection callout conflict ([Q-003](#q-003--does-ios-text-selection-fight-the-lookup-popover))

**Exit criterion:** a full chapter can be read and three words looked up without a keyboard.

### P4 — iOS platform adaptation (11 days)

1. Memory: address whatever [Q-002](#q-002--does-the-reader-hold-acceptable-memory-on-a-real-device) surfaced
2. Stop background SQLite writes on app suspension (`0xdead10cc` termination risk)
3. `NSURLIsExcludedFromBackupKey` on caches and logs
4. Keychain via `keyring` `apple-native`; move the Apple-only Cargo target tables from
   `cfg(target_os = "macos")` to `cfg(target_vendor = "apple")`

**Exit criterion:** no crash across a 30-minute reading session with backgrounding, and
Instruments shows no runaway memory.

### P5 — iCloud sync (12–18 days)

iOS ↔ macOS only ([D-007](#d-007--windows-sync-is-out-of-scope)). Size
[Q-004](#q-004--how-do-existing-macos-users-migrate-to-the-app-container) before starting —
it is not in the estimate below.

1. Widen `cfg(target_os = "macos")` → `cfg(target_vendor = "apple")` in `src/icloud.rs`
   (lines 10, 67, 82, 96) and `src/sync/log.rs` (355, 388); delete the `not(macos)` stubs.
   No new dependencies — `objc2-foundation` and `block2` are already in the iOS tree via tao/wry
2. Target the app's own ubiquity container instead of a picked path; replace the hardcoded
   path check in `src/sync/migration.rs:59-64`
3. Replace the `notify` watcher with `NSMetadataQuery` — kqueue does not observe
   iCloud-initiated downloads
4. Replace the macOS `.name.icloud` placeholder probe in `icloud.rs` with
   `NSURLUbiquitousItemDownloadingStatusKey`. Without this, a book evicted by iCloud is never
   re-downloaded and simply never opens
5. iCloud Documents entitlement, container ID in the provisioning profile,
   `NSUbiquitousContainers` in `Info.plist`

**Exit criterion:** a book imported on the Mac appears on the iPhone; a highlight made on the
iPhone appears on the Mac; a book evicted on the Mac downloads on demand from the iPhone;
concurrent appends from both devices do not corrupt the JSONL log.

### P6 — Ship (10 days)

Apple Developer enrollment, signing and provisioning, privacy manifest, App Store assets,
TestFlight, review round-trips. Add an iOS job to `release.yml`.

**Exit criterion:** installable from TestFlight on a device that has never had a dev build.

---

## 6. Progress

| Phase | Status | Notes |
|---|---|---|
| P0 — Compile and boot | Not started | |
| P1 — Capability layer + routing | Not started | |
| P2 — Mobile UI | Not started | |
| P3 — Touch interaction | Not started | |
| P4 — iOS adaptation | Not started | |
| P5 — iCloud sync | Not started | iOS ↔ macOS only; size [Q-004](#q-004--how-do-existing-macos-users-migrate-to-the-app-container) first |
| P6 — Ship | Not started | |

---

## 7. Provenance

Facts in [§3](#3-verified-facts) were established by reading the named files directly,
including vendored crate sources under `~/.cargo/registry` for `tauri-2.10.3`, `tauri-2.11.5`,
and `tauri-plugin-dialog-2.6.0`.

The wider survey behind [§1](#1-goals-and-non-goals) and the effort estimates came from a
seven-dimension parallel audit (104 findings). That audit's **adversarial verification pass
did not complete** — the estimates in [§5](#5-phases) have not been independently
challenged and should be treated as first-pass figures. Every compile-time and boot-time
blocker in [§3](#3-verified-facts), by contrast, was re-checked by hand against source.

### Verification strategy from here

**Do not re-run the audit.** The ~50 unverified mid-severity findings do not sit on the
critical path — P0 through P3 depend only on the hand-checked blockers above. Re-running would
buy a more precise guess about work not yet started, at real cost.

Instead: **verify per phase, and prefer measurement over analysis.** Before each phase, check
only the findings that phase touches — and by then a running app exists, so most questions can
be answered directly. [Q-002](#q-002--does-the-reader-hold-acceptable-memory-on-a-real-device)
becomes an Instruments trace on the largest available book once P0 boots.
[Q-003](#q-003--does-ios-text-selection-fight-the-lookup-popover) becomes a long-press in the
Simulator. Both beat any amount of document research.

P0's actual duration against its 6-day estimate is the first real calibration point for every
other number in [§5](#5-phases). If P0 runs long, scale the rest rather than trusting them.
