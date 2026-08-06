# Mobile — iOS

Ship Lantern as an iOS app that **stands on its own**: every core capability of the desktop app
is available on the phone, without a Mac anywhere in the picture. iCloud sync keeps the two in
step for people who have both; it is not what makes the phone useful.

Out of scope for this milestone: **Android** ([D-002](#d-002--ios-first-android-deferred) for
the cost, [D-010](#d-010--android-is-deferred-not-abandoned) for whether it ever comes back)
and **Windows sync** ([D-007](#d-007--windows-sync-is-out-of-scope)). Sync means iOS ↔ macOS.

**Status:** **P0 done, 2026-08-02.** Lantern runs on the iOS Simulator: the shelf renders, a
15 MB EPUB imports through the system file picker, and it opens with CJK text paginating
correctly in WKWebView. The host build and all 618 backend tests are still green. What is
wrong is layout and touch, not the port — see
[F-011](#f-011--first-run-what-the-app-actually-does-on-a-phone).

**P1 done too, 2026-08-02.** Next in file order is P2, but P2 is **blocked on desktop work**
([D-011](#d-011--p2-waits-for-the-desktop-mastery-line-to-finish)) — the Rust-side phases P4
and P5 are what can move meanwhile. Four product decisions were settled 2026-08-06 and each
changed scope: [D-011](#d-011--p2-waits-for-the-desktop-mastery-line-to-finish),
[D-012](#d-012--the-phone-gets-ai-contextual-glosses-not-ai-chat),
[D-013](#d-013--books-download-on-demand-not-eagerly),
[D-014](#d-014--first-ios-release-is-testflight-not-the-app-store).

**The founding premise was overturned later the same day.** The phone is no longer a companion
that consumes desktop output — see [§1](#1-goals-and-non-goals). That reversal promoted note
editing, collection management, 书籍来源 and OCR into this release, moved 自动分析 to now,
committed AI chat and format conversion to release 2, and produced
[D-017](#d-017--ocr-moves-to-vision-on-ios-and-macos-ocrmypdf-stays-on-windows). It also amended
[D-003](#d-003--ocr-stays-on-desktop--superseded-by-d-017),
[D-012](#d-012--the-phone-gets-ai-contextual-glosses-not-ai-chat) and
[D-016](#d-016--on-cellular-a-book-download-asks-once-and-remembers).

**Estimated effort:** 78–84 engineer-days across 7 phases, as originally scored — **and that
figure no longer covers the work.** It was scored against the companion premise. The three
Tier-1 promotions, the Vision OCR backend and 自动分析 are all unscored; do not quote 78–84 as
if it included them. The earlier 2026-08-06 decisions moved work around rather than adding much
net — P6 loses roughly 5 days (no App Review), P2 gains roughly the same (mobile AI settings,
downloading state) — but the premise change is additive and has not been re-scored.

---

## 1. Goals and non-goals

The guiding model is *every core feature is independently available on the phone*.

**Why, and it is a fact about people rather than about software.** iPhone ownership vastly
exceeds MacBook ownership, and a large share of readers own only a phone. For those readers, a
feature that exists only on the desktop is a feature that does not exist. There is no "sync it
from your Mac" for someone with no Mac.

So the desktop is an **enhancer**, not a **producer**. It does things faster, in bulk, and with
more screen — drag a folder of books in, work two windows at once, run a long job while doing
something else. What it must never be is the only place a core capability lives.

The test for the split below is therefore not "is this comfortable on a phone" but "can a
phone-only reader do the job at all". Everything that fails that test is on the left.

| On iOS | Desktop-only |
|---|---|
| Read EPUB / PDF / TXT / MD / HTML, plus FB2 / FBZ / CBZ natively ([F-006](#f-006--ios-book-import-works-with-zero-code-changes)) | **Drag-and-drop import.** The phone imports the same formats through the system file picker; drag-and-drop is a faster route to the same capability, not a capability of its own |
| Import a book via the system file picker | **MCP server + client registration.** This exposes Lantern to AI clients running on the same machine — a desktop integration surface, not a reading capability |
| Word lookup + lookup history | **Custom font import.** *Unverified* whether the iOS document picker can take a font file at all. Under this premise that needs an answer rather than an assumption; it is on the right only because nobody has checked |
| AI contextual gloss, and the AI settings to configure it ([D-012](#d-012--the-phone-gets-ai-contextual-glosses-not-ai-chat)) | |
| Vocabulary list + FSRS review | |
| **Note editing** — Tier 1, promoted into [P2](#p2--mobile-ui-185-days) | |
| **Collection management** — Tier 1, promoted into [P2](#p2--mobile-ui-185-days) | |
| **书籍来源 (book sources)** — Tier 1, promoted into [P2](#p2--mobile-ui-185-days) | |
| **OCR**, over Vision.framework ([D-017](#d-017--ocr-moves-to-vision-on-ios-and-macos-ocrmypdf-stays-on-windows)) | |
| **自动分析 (auto-analysis)** — ships now, see below | |
| Reader settings (font size, theme, page-turn) | |
| Sync, with books downloading on demand ([D-013](#d-013--books-download-on-demand-not-eagerly)) | |

**"Full settings surface" left the desktop column, and that was not an oversight.** The phone
carries a setting for every feature the phone has. The only settings it lacks are the settings
for the three rows on the right.

**Why those three promotions are Tier 1.** Their absence is what is most damaging to a
phone-only reader: without them the phone can *read* a library but cannot *maintain* one. Notes
that can be seen and not corrected, collections that cannot be reorganised, and no route to the
next book. Reading is half of what someone does with a library; the other half was missing.

**Committed release-2 scope** — still deferred, but no longer "maybe". These are scheduled work
with a stated reason for waiting, not open questions:

- **AI chat on the phone.** Deferred for sequencing, not because the phone consumes desktop
  output — the rationale in [D-012](#d-012--the-phone-gets-ai-contextual-glosses-not-ai-chat)
  was rewritten for exactly this reason.
- **Mobile format conversion — MOBI → EPUB without Calibre.** Note what this does and does not
  buy. The native-import path already hands MOBI, FB2 and CBZ straight to foliate-js, which
  renders all three in-process (`mobi.js`, `fb2.js`, `comic-book.js`; see
  [F-006](#f-006--ios-book-import-works-with-zero-code-changes)), so rendering is not what is
  missing. What conversion buys back is **in-book search, the chapter scrubber, and AI
  grounding** — the three things that sit on the EPUB normalisation. None of them tolerates a
  partial result: a search over a half-converted book returns confidently wrong answers rather
  than fewer answers. That is why a *streaming* conversion design — open the reader on the
  converted prefix and keep converting behind it — was rejected. There is no useful partial
  state to expose.

**Still deferred, and these genuinely are affordances rather than capabilities** — a phone-only
reader loses convenience, not a job:

- A "keep this book on the phone" pin ([D-013](#d-013--books-download-on-demand-not-eagerly))
- PDF cover thumbnails (needs pdfium on iOS — the reader itself works without it)
- "Open in Lantern" from other apps (needs file-association / UTI work)

**Shipping now rather than in release 2: 自动分析 (auto-analysis).** It rides along with the
settings work currently in flight. Two design consequences follow, and both are new scope:

1. **The metered-connection gate has to cover AI calls, not just book downloads.**
   [D-016](#d-016--on-cellular-a-book-download-asks-once-and-remembers) guards downloads only
   today. An analysis run started on cellular is an unannounced network spend of the same kind —
   the user did not ask for it at that moment and finds out from the bill. Amended there.
2. **The trigger moves from book completion to next app open.** iOS kills background work, so a
   run triggered by finishing a book will simply not happen on a phone: finishing a book is
   very often the moment the app is being closed. The run has to be queued and performed the
   next time the app comes to the foreground. This changes *when the user sees results*, so
   every place that describes the trigger has to be restated in both locales — the trigger
   label is `settings.autoAnalysis.trigger.book_finished`, and it stops being true.

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
helpers do not panic; `reqwest`'s default TLS resolves to
Security.framework instead of OpenSSL; WKWebView implements `speechSynthesis` and Android
System WebView does not; the file picker returns a real path instead of a `content://` URI.

**Cost of this choice:** Android users get nothing from this milestone. Accepted.

**Re-scored 2026-08-02** against Readest, which ships all three from one codebase — see
[`readest-comparison.md`](readest-comparison.md) §2. The original "25–35 extra days" was too
pessimistic and one of its premises is retired:

- Android builds on a **Linux** runner (Readest's `release.yml`), not a Mac. CI cost is a
  non-issue in either direction: this repo is public, so GitHub-hosted runners are free on
  every OS and the 1×/10× multiplier table does not apply. What is *not* free is wall-clock —
  a real 4-ABI Android release build in Readest's CI takes **54m32s**, the longest leg in
  their matrix (macOS universal 29m38s, Windows ~37m).
- `pdfium` is a *runtime* dylib load with a documented no-cover fallback, so it never blocks
  the Android compile — it degrades.
- The TLS problem is one line (`default-features = false` + `rustls-tls-native-roots`).
  **An earlier version of this bullet said to fix it now regardless of Android. That was
  wrong** — it contradicted P0's own log (item 5), which had already dropped the change
  because `rustls-tls` ignores the OS trust store and breaks corporate-proxy users. Lantern
  ships no Linux build, so `openssl-sys` never reaches a user; it only ever touched the CI
  runner, which already handles it. This is Android work and it waits for Android.

**Re-scored again 2026-08-02**, and this time upward. The figure is **18–30 days on top of a
shipped iOS app**, split by milestone because the two halves behave very differently:

- **It compiles: about a day.** One thing stops the Android compiler — the `reqwest` TLS line.
  The `keyring` call sites this entry used to budget for no longer exist: deleting the v1.4
  vault in v2.6.0 took `keyring` and `security-framework` out of `Cargo.toml` entirely, so
  `secrets.rs` is now plain SQLite on every platform. `HOME` and `content://` are runtime
  failures, not compile failures.
- **It is usable: 18–30 days**, dominated by `content://` import (3–5), a real Android secrets
  store (2–4), the read-aloud system-voice tier (3–5), store review (4–6) — **plus an Android
  sync transport, which has no line item because none has been chosen.**

Two rows were missing from the earlier 16–24. The **read-aloud** one is now measured rather
than guessed: system voices are the mandatory last tier of every routing plan
(`src/components/speech/routing.ts:76-77`, `:83-91`), and that tier is `window.speechSynthesis`,
which Android System WebView does not implement — so it needs Readest's Kotlin plugin or an
equivalent. The **sync** one follows from [D-007](#d-007--windows-sync-is-out-of-scope):
with Windows sync out of scope, sync is Apple-ecosystem-only, so Android needs a second
transport chosen from scratch. The engine underneath is genuinely transport-agnostic — the six
largest sync files contain zero `target_os`/`icloud` references — so the interface to replace
is ~195 lines, but everything behind it is new.

The ordering decision is unchanged: iOS first, one vendor and one WebView.

**Revisit after:** iOS ships and the capability layer ([D-005](#d-005--capability-flags-not-platform-checks))
has proven itself. Android then reuses phases P1–P3 wholesale.

**Where Android lives** — in this repo, always: [D-009](#d-009--android-stays-in-this-repo-only-the-guarantee-is-lowered).
**Whether it is coming back at all:** [D-010](#d-010--android-is-deferred-not-abandoned).

### D-003 — OCR stays on desktop — superseded by D-017

> **Superseded 2026-08-06 by [D-017](#d-017--ocr-moves-to-vision-on-ios-and-macos-ocrmypdf-stays-on-windows).**
> The conclusion below — that the phone never runs OCR — is now wrong, and it is worth being
> precise about *how* it was wrong, because none of its facts were. It reasoned correctly from
> the companion premise, where a phone reading desktop output was the design rather than a
> shortfall, and its closing clause said the quiet part: OCR "belongs on the machine with the
> scanner anyway." Under [§1](#1-goals-and-non-goals)'s independence premise that clause is the
> error. A phone-only reader has no machine with a scanner, so a scanned book that only the
> desktop can make searchable is a book they cannot use.
>
> Three parts of what follows are still load-bearing and are why the entry is kept rather than
> deleted: the **read/write split table**, which D-017 builds directly on; the reason the
> external runtime is **impossible on iOS**, which is *why* D-017 goes to Vision rather than
> staying put; and the **Windows situation**, where ocrmypdf remains the backend. The one figure
> not to carry forward is the 10–15 day estimate — it assumed a rewrite where the code turns out
> to have a seam. The desktop bug at the end of this entry is also still open and still real.

The phone never runs OCR. It reads OCR output that the desktop produced and synced.

**Why:** the current pipeline downloads a ~1 GB native runtime from GitHub Releases and
executes it as a child process. That is impossible on iOS (no `fork`/`exec` for third-party
apps) and violates App Store guideline 2.5.2. Re-implementing over Vision.framework would
cost 10–15 days for a feature that belongs on the machine with the scanner anyway.

**Implementation:** gate the *pipeline*, not the module. `commands::ocr` splits in two:

| Half | Modules | Lines | Ships on iOS |
|---|---|---|---|
| Read — which file is this book's active asset? | `assets`, `resolver` | 526 | Yes |
| Write — fetch runtime, exec it, manage jobs | `backend`, `jobs`, `manager`, `package`, `publish`, `validate` | ~5000 | No |

Then drop the ten pipeline commands from the mobile `invoke_handler` and hide the OCR
settings section behind `hasOcr: false`.

Gating the whole module is wrong and the compiler does not catch it on desktop.
`resolver::resolve_active_asset` is called from three places outside `commands::ocr`
(`ai/grounding/index.rs:140`, `:263`, `commands/books/query.rs:78`); it answers "open the
verified OCR output, or fall back to the original scan?" Without it on iOS, a book OCR'd on
the desktop and synced to the phone opens as the **original un-OCR'd scan** — no selectable
text, no lookup, nothing for the AI to ground on — and it fails silently, since falling back
to the source path is a legitimate outcome. That is the exact benefit D-003 promises, lost.
The two read modules are plain SQLite reads over the assets table with no platform-specific
code, so the split costs nothing. See [F-010](#f-010--only-a-real-ios-compile-finds-the-cfg-holes).

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
hasOcr             // D-003, re-derived by D-017 — see the note there
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

**Additions from the Readest read** ([`readest-comparison.md`](readest-comparison.md) §4):
declare defaults as `false` on a base class so a new capability is absent everywhere until a
platform opts in; add `hasUpdater` (Apple forbids self-update) and `distChannel`, since an App
Store build and a sideload of the same OS differ on what they may touch on disk.

### D-006 — Sync ships in v1

**Why:** a reader who owns two devices expects to stop mid-chapter on the phone and resume on
the Mac, with the same notes and the same vocabulary. That expectation is independent of how
capable either device is on its own — it is about one person's reading state living in one
place, not two. The sync engine itself is storage-agnostic and ports unchanged
(see [F-005](#f-005--the-sync-engine-is-storage-agnostic)), so the cost is entitlement
configuration and change-notification, not a re-architecture.

> **This rationale was replaced on 2026-08-06, and the decision was not.** It used to read:
> *"without sync, 'process on the desktop, read on the phone' does not hold, and the iOS app
> degrades into a standalone reader that competes with better standalone readers."* Under the
> premise this roadmap now runs on ([§1](#1-goals-and-non-goals)), the iOS app **is** a
> standalone reader on purpose, so that sentence no longer argues for anything — it describes
> the goal as if it were the failure. Worth noticing that the old argument made sync
> load-bearing for *every* iOS user; the new one only makes it load-bearing for users who own
> two devices. That is a smaller claim, and it is the true one. Sync still ships in v1 because
> the two-device case is common and the engine is already written, not because the phone would
> be crippled without it.

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

### D-009 — Android stays in this repo; only the *guarantee* is lowered

Android is never forked into a separate repo, branch, or release train. What gets decoupled
is the promise: Android may break, and its breakage never blocks a desktop or iOS release.

**The question this answers:** if Android compatibility is expensive, split it out and
maintain it at a lower cadence — guaranteeing only that one usable APK exists?

**Why not fork.** Five things can be decoupled independently, and they have wildly different
prices. Forking buys the expensive one to get the cheap ones:

| Axis | Price | Verdict |
|---|---|---|
| Store submission cadence | ~0 — a manual local script, off CI | **Take it.** Readest already runs exactly this |
| Release blocking | **already free here** — see the correction below | **Take it** |
| PR blocking | one line — Android CI job is nightly + label-triggered, not required | **Take it** |
| Support promise | ~0 — a written tier policy with an exit clause | **Take it** |
| Codebase location | re-absorbing ~33 shared commits/week, forever | **Reject** |

**Correction (2026-08-02):** an earlier version of this row said release-blocking costs "one
line, `fail-fast: false` on the build matrix". That is how Readest does it, but it does not
apply to this repo — `release.yml` has **no matrix at all**. It is two independent jobs,
`build-macos` (`:13`) and `build-windows` (`:205`), and `grep -n 'strategy:'` returns nothing.
`fail-fast` is a matrix-only setting. Independent jobs already fail independently, so a third
`build-android` job would be non-blocking by default, at a price of zero lines.

The first four are what "至少有一个可用的安卓包" actually means, and none of them requires a
fork. The fork only buys the fifth, and the fifth is where all the cost is:

- **The Android-owned surface is ~0.2% of the code.** ~8 files / ~250 lines against 335
  shared files / 106,577 shared lines. You do not fork a repo to own 250 lines.
- **94.8% of code-bearing commits in the last 90 days touch the shared layer** (239 of 252;
  96.8% by churn), arriving at ~35/week over the last 30 days and accelerating. A fork
  re-absorbs essentially every commit the main line produces.
- **Cadence saves none of the 18–30 days** in [D-002](#d-002--ios-first-android-deferred).
  That figure is one-time port cost — OpenSSL, `HOME`, `content://`, read-aloud,
  sync transport — paid in full before the first APK exists, weekly or yearly.
- **Low cadence is what makes the APK hard to produce, not what makes it cheap.** Three months
  of main at the measured rate is ~230 backend commits and ~120 new crates landing in one
  merge, with no green-to-red transition anywhere to bisect. Fowler's point about big merges
  applies with force at this size: the cost is dominated by variance, and the realistic
  failure is a *semantic* conflict — the rebase is green and the APK is subtly wrong.
- **Environment drift does not care whether you edit Android code.** NDK, Gradle, AGP, the
  Play target-API floor and the runner images all move on their own. This repo has already run
  the experiment on its release path: `release.yml` sat untouched for 3.5 months and then
  needed **six corrective commits in 72 minutes** (2026-07-13, `e105256`…`e3798ad`) before it
  produced an artifact — and the trigger was environment drift, not code rot.
- **Release cadence makes "every few months" unprecedented here.** 96 version tags between
  2026-03-08 and 2026-08-01 — one release every 1.5 days, longest gap ever 14 days. A
  quarterly Android build is ~6× the longest gap this project has tolerated on any path.

**Prior art is uniform.** Every project that formalised a best-effort platform kept it
in-tree and lowered the guarantee: CPython PEP 11 Tier 3 ("failures do not block a release" —
and `aarch64-linux-android` is literally a CPython Tier 3 target), Rust's target tier policy,
and Readest itself, which weaves 83 `isAndroid` branches through a frontend 9× the size of
Lantern's and still runs one branch, one package, one release train. The counter-examples run
the other way: react-native-macos — a funded Microsoft team — is ~5 minor versions and ~11
months behind upstream and skips most releases; Syncthing-Android shipped at low cadence,
bit-rotted, and was discontinued with the maintainer naming lack of development first and the
store problem second.

**What to buy instead — a compile gate.** Rust's own postmortem on why in-tree low-tier
targets rot names the cause as absence of CI, not absence of a fork; PEP 11 requires a
buildbot for the same reason. This is not theoretical here:

- CI compiles exactly **one** Rust target (Linux host). **39 of 85** platform cfg arms are
  never compiled on any push or PR.
- Linux CI is a booby trap for Android specifically: it compiles **15 of the 16** cfg arms an
  Android build selects, so coverage *looks* complete — while Linux has system OpenSSL, a
  working keyring backend, and `HOME` set, which is exactly where Android diverges.
- Rot reproduced live on 2026-08-02: `cargo clippy --target aarch64-apple-ios-sim -- -D warnings`
  fails with two `never used` errors on `src/icloud.rs:92` and `:106` while the identical host
  command passes. Cause: `dcc90e9`, the [F-010](#f-010--only-a-real-ios-compile-finds-the-cfg-holes) fix itself, committed **less than 24
  hours earlier**. One gating decision, one new breakage, next day.

So split [D-002](#d-002--ios-first-android-deferred)'s estimate in two. *Compiles* is now
the very small half — just the `reqwest` TLS line. The `keyring` gating this paragraph used to
budget for went away with the v1.4 vault in v2.6.0; `secrets.rs` no longer imports `keyring` on
any platform. *Usable* is the rest. Buy "compiles" early and put a nightly
`cargo check --target aarch64-linux-android` behind it, and Android cannot rot while iOS is
being built. Note the 18 existing `target_os = "android"` cfgs are all
`cfg(not(any(ios, android)))` exclusions the iOS port created for free — a fork would not
delete a single one of them, because they are iOS's code.

**Also adopt, verbatim, from the tier policies:** the containment rule — *Android breakage
must never break desktop or iOS, and Android work must never impose cost on them* — and a
written removal clause. PEP 11 removes a platform by making the build fail loudly, so someone
has a chance to step forward. That is what makes a low guarantee honest instead of a slow lie.

**Revisit if:** a second person owns Android (a fork is a coordination boundary, and that is
the one thing it is actually for); or Android needs a genuinely different UI shell rather than
responsive breakpoints — though even then the answer is a platform-specific component tree
in-tree, not a fork; or the shared-code drift rate falls toward zero, at which point a fork
costs nothing because there is nothing to re-absorb.

**Honest limits of this evidence:** no Tauri or Electron project has publicly forked a
platform for cost reasons — Tauri 2 mobile is too young for postmortems — and nobody publishes
a fork-vs-flag figure in engineer-days. The one quantitative source (Krüger & Berger,
ESEC/FSE 2020: clone-and-own is "initially cheap" but "does not scale with the frequency of
reuse") measures product variants at n>2 and overstates the case at n=2 platforms.

### D-010 — Android is deferred, not abandoned

Android is not being built, and the topic is closed until the revival condition below fires.
It is **not** written off: the option is kept, on the strict condition that keeping it never
costs anything.

**The question this answers:** given the cost, is this "not now" or "never"?

**Why not "never".** The two options are indistinguishable today and nearly indistinguishable
later, so "never" buys almost nothing while discarding something with real value:

- **Both cost zero lines today.** An exhaustive sweep found nothing in this repo that exists
  solely for Android — not in Rust (the 18 `target_os = "android"` sites are all the
  `not(any(ios, android))` desktop-exclusion arm the iOS port created), not in `Cargo.toml`
  (the only "android" string is a comment at `:32`), not in `src/` (zero matches, i18n
  included), not in `package.json`, the four `tauri.*.conf.json`, `.gitignore` or any
  workflow, and there is no `gen/android`. There is nothing to delete, so "never" is not a
  cleanup — it is only a permission slip.
- **Keeping the door open has no ongoing price.** P1–P6 were read in full looking for one-way
  doors and none was found. The plan is already Android-safe *for reasons that have nothing to
  do with Android*: [D-005](#d-005--capability-flags-not-platform-checks) asks
  `hasWindow`, not `isIOS`, because that is what survives a desktop-vs-iOS split too; the sync
  engine is transport-agnostic in code, not just in prose; P3's gesture arena is generic DOM
  touch; P2 is standard responsive CSS; P4 widens `cfg` arms rather than narrowing them. So
  there is no discipline to maintain and therefore no "someday" tax to pay.
- **"Never" buys back essentially nothing.** Of D-005's 13 planned capability flags, **zero**
  exist only to distinguish Android. `check:reader-compat` is unaffected — it targets Safari
  15 and never mentions Chromium, because WKWebView was always the stricter WebView, not a
  shared minimum. The one genuine saving is the read-aloud Kotlin plugin (see
  [D-002](#d-002--ios-first-android-deferred)) — and that is money not spent until Android is
  actually built, so declaring "never" today saves nothing today.

**Why not "yes, soon" either.** The price went *up* on re-scoring: 18–30 days plus an
unestimated sync transport. There is no demand signal — `gh issue list --search android
--state all` returns `[]` against a two-issue tracker. And the strongest argument for keeping
Android compiling turns out not to hold here: since all 18 Android `cfg` sites are the same
arm iOS already exercises, an Android compile gate would catch **no** rot that an iOS gate
does not. (The iOS gate is the one actually worth adding — see [D-009](#d-009--android-stays-in-this-repo-only-the-guarantee-is-lowered).)

**The two rules that keep this from rotting into an open-ended obligation:**

1. **Free-only.** Preserve Android's viability only where preserving it costs nothing. The
   moment a choice requires a detour to stay Android-compatible, take the iOS-optimal path and
   let that door close, without compensating for it. Android takes what falls out of good
   design; it never gets a budget.
2. **A written revival condition.** Android is reconsidered when **iOS has shipped**, **a real
   demand signal exists** (an issue, a user asking), **and** the release cadence has settled
   from its current ~1.5 days per tag. Until all three hold, this is decided and does not get
   re-litigated. "When there's time" is not a condition — it never fires.

**What is deliberately not done:** no Android CI job, no `gen/android`, no toolchain, no
speculative sync-transport abstraction (building one before a second transport exists to
validate its shape against would be guessing, and [D-007](#d-007--windows-sync-is-out-of-scope)
already names this as future work). No Android-motivated change gets made early — including
the `reqwest` TLS switch, which is Android work and was wrongly recommended as standalone
hygiene in `readest-comparison.md` §6 until corrected on 2026-08-02.

**Revisit if:** the three-part condition above is met; or someone else takes ownership of
Android, which changes the calculus entirely (see [D-009](#d-009--android-stays-in-this-repo-only-the-guarantee-is-lowered)
on why a fork is a coordination tool, not a cost tool).

### D-011 — P2 waits for the desktop mastery line to finish

The mobile UI phase does not start until `docs/impls/reading-driven-mastery-and-review.md`
is fully landed. P4/P5/P6 may run before then; P2 and P3 may not.

**Why:** P2's own checklist — the Home sidebar becoming a drawer, the reduced settings pane,
the lookup popovers becoming bottom sheets — names the exact files that line is rewriting
(`Home.tsx`, the settings panes, `ExplainPopover.tsx`, and eventually `Reader.tsx`). Two
tracks editing them at once spends on merge conflicts everything parallelism would have
bought. The Rust-side phases have no such overlap: P5 lives in `icloud.rs` and `sync/`, and
the six largest sync files contain no frontend coupling at all.

**Cost of this choice:** iOS stays at "boots and reads, badly laid out" for longer. Accepted
by the user on 2026-08-06, on the grounds that rework is the more expensive currency.

**Revisit if:** the mastery line stalls or is descoped, or P2 turns out to need only files
that line has already finished with.

### D-012 — The phone gets AI contextual glosses, not AI chat

Word lookup on iOS returns the same two layers as desktop: the AI gloss that reads the
sentence the word came from, plus the Youdao standard gloss beside it.

**Why:** the standard gloss cannot see context (`commands/dictionary.rs` says so in its own
header — `bank` comes back as every sense at once), and the words a learner saves are
precisely the polysemous ones. Shipping the phone with only the fallback layer would make
the phone measurably worse at the one thing it exists to do.

**What this costs, and it is not nothing:** the reduced mobile settings surface in
[P2](#p2--mobile-ui-185-days) was scoped as font size, theme and page-turn. It now has to
carry AI provider configuration too — key entry, model choice, connection test. Budget
accordingly; this is new scope, not a clarification.

**Amended 2026-08-06 — the deferral stands, the reason for it does not.** This entry used to
justify the split by observing that a gloss is a bounded request and chat is a surface, and
concluded "the first ships, the second waits." That reasoning rested on the companion premise
in [§1](#1-goals-and-non-goals), under which a conversation surface was desktop-shaped work the
phone would consume the results of. The premise is gone. AI chat is a core feature, so the
phone has to have it, and it is now **committed release-2 scope** rather than a maybe.

**What it is deferred for is sequencing.** Chat depends on three things that do not exist yet
and are already scheduled ahead of it: the phone's AI provider configuration (item 4 of
[P2](#p2--mobile-ui-185-days), which this very entry added), the bottom-sheet and panel
patterns the mobile layout establishes ([P2](#p2--mobile-ui-185-days) items 3 and 5), and the
touch interaction those panels sit on ([P3](#p3--reader-touch-interaction-10-days)). A
streaming conversation panel built before any of that exists gets built twice. A gloss carries
none of those dependencies — it renders in the popover the lookup path already owns — which is
why it goes first. That is a schedule, not a claim about what a phone is for.

**Privacy consequence:** selected book text leaves the device for a third-party model. That
has to be declared, in the privacy manifest and to the user, whenever this build reaches
anyone but the author.

### D-013 — Books download on demand, not eagerly

iCloud may evict a book from the phone. Tapping an evicted book downloads it then, with
visible progress; the shelf always lists every book regardless of what is resident.

**Why:** eager download makes first sync long and lets a real library fill a phone, to buy
back only a few seconds on first open of each book. The shelf staying complete is what makes
the tradeoff invisible most of the time.

**What this obliges:** P5 item 4 is no longer optional polish. Without
`NSURLUbiquitousItemDownloadingStatusKey`, an evicted book is never re-downloaded and simply
never opens — under this decision that is the *common* path, not an edge case. The reader
also needs a real downloading state, which is UI and therefore [P2](#p2--mobile-ui-185-days).

**What it costs on cellular** is settled separately in
[D-016](#d-016--on-cellular-a-book-download-asks-once-and-remembers).

**Revisit if:** on-demand download proves slow enough on cellular that opening a book feels
broken. A "keep on this phone" pin was considered and deferred as a second-release affordance.

### D-014 — First iOS release is TestFlight, not the App Store

P6 ends at "installable from TestFlight", and stops there for now.

**Why:** App Review, store screenshots, description and the rejection round-trips are most of
P6's 10 days, and they buy nothing until the app is actually good on a phone — which is P2
and P3's job, not P6's. TestFlight puts it on real hardware, which is the only way to answer the
half of [Q-002](#q-002--does-the-reader-hold-acceptable-memory-on-a-real-device) about
whether iOS kills the app.

**What is still required, and is easy to under-budget:** an Apple Developer Program
membership, signing and provisioning, and a privacy manifest — App Store Connect requires
one to accept the upload at all, TestFlight or not. Internal testing (up to 100 members of
the team) skips Beta App Review; external testing does not.

**~~Blocked on something outside this repo:~~ cleared 2026-08-06.** The account's notarization
had been stuck since 2026-08-04 and needed a ticket only the account holder could file; Apple's
review has now passed. Signing and provisioning are back on the normal path, and nothing
account-level stands between P6 and a TestFlight upload.

**Revisit when:** P2 and P3 are done and the app is worth strangers' attention.

### D-015 — The sync directory is the app's ubiquity container, and picking one goes away

Desktop sync points at a folder the user picked inside iCloud Drive. It stops being a choice:
the sync root is the app's own ubiquity container, on every platform, and the folder picker is
removed rather than repointed.

**Why:** iOS cannot reach an arbitrary iCloud Drive path — an app only gets a container it
owns. Without this there is no iOS ↔ macOS sync at all, which is most of why the iOS version
exists ([D-006](#d-006--sync-ships-in-v1)).

**No migration, and this is the part that was nearly built wrong.** The first draft of this
decision specified a one-time automatic relocation with a notice explaining where the files
went. There is nobody to relocate: Lantern has never been distributed, so no installed copy
has a picked folder recorded. Writing a migration path here would be exactly the legacy-shim
work the project has already decided against, for users who do not exist. Point at the
container and move on. Decided 2026-08-06 by the account holder, who caught this.

**What replaces "Change folder": "Open location".** Once the directory is fixed it cannot be
changed, so a control that changes it is dead weight — but "where did my books go" is still a
real question. The row becomes a button that reveals the sync folder in Finder, in the shape
`reveal_logs` already uses. That answers the question without a notice, a dialog, or a
migration.

**When a prompt *would* be owed:** after the app is distributed. Any data move that happens on
a machine belonging to someone other than the author needs to be announced. That is a
post-release rule, not a pre-release one.

**Consequence for the estimate:** [Q-004](#q-004--macos-relocation-to-the-app-container-answered--there-is-nothing-to-relocate)
is closed and its ~0.5 day of migration work is deleted, not folded in. P5 item 2 shrinks to
"resolve the root from the container" plus the settings-panel change.

### D-016 — On cellular, a book download asks once and remembers

[D-013](#d-013--books-download-on-demand-not-eagerly) makes "tap a book, it downloads" the
phone's normal path. On Wi-Fi that happens silently. On cellular the first such tap asks, and
the answer is remembered for later taps.

**Why:** books are not small — a PDF can be tens or hundreds of megabytes — and spending
someone's metered data without asking is the kind of thing they only notice from the bill.
Asking every time would be worse than either extreme, hence remembering.

**Where the setting lives:** with the answer remembered, it needs somewhere to be changed back,
which lands in mobile settings ([P2](#p2--mobile-ui-185-days)).

**Amended 2026-08-06 — this gate covers AI calls too, not only book downloads.** 自动分析
(auto-analysis) ships now rather than in release 2 ([§1](#1-goals-and-non-goals)), and an
analysis run started on a metered connection is an unannounced network spend of exactly the
same kind as a book download: the user did not ask for it at that moment, and they find out
from the bill. The gate was written around downloads because downloads were the only automatic
network spend the phone had. They are not any more.

The two spends differ in shape, not in whether they need asking about: a download is large and
infrequent, an analysis run is small and repeats. That difference is an argument for
*remembering* the answer, which this decision already does — not for skipping the ask. Whether
one remembered answer covers both or they are two separate answers is a settings-design
question for [P2](#p2--mobile-ui-185-days); that there must be a gate on both is not.

Decided 2026-08-06.

### D-017 — OCR moves to Vision on iOS and macOS; ocrmypdf stays on Windows

Amends and supersedes [D-003](#d-003--ocr-stays-on-desktop--superseded-by-d-017). OCR is a core
capability, so it ships on the phone ([§1](#1-goals-and-non-goals)). The recognition backend
becomes Apple's Vision framework on **iOS and macOS both**. The external ocrmypdf runtime is
retained **only on Windows**.

**This is a retrofit, not a greenfield choice.** OCR is fully implemented already — 5,689 lines
across 9 files in `src-tauri/src/commands/ocr/`, behind the `ocr-pipeline` feature
(`src-tauri/Cargo.toml:22`). Nothing here is about whether to build OCR. It is about which
backend produces the searchable PDF, and on which platforms.

**A real seam already exists, which is why this costs far less than D-003's 10–15 days
implies.** `src-tauri/src/commands/ocr/backend.rs:120` defines `trait OcrBackend: Send + Sync`
with exactly two methods:

- `probe() -> AppResult<BackendCapabilities>`
- `recognize_pdf_in_staging(&self, request, progress, cancel) -> AppResult<OcrOutput>`

Its doc comment states that backends "only transform bytes in staging", and that database
changes, sync events, final publication and active-asset selection are *deliberately* outside
the interface. Three types implement it today: `OcrmypdfBackend` (`:192`) plus two test fakes
(`:907`, `:954`). So a Vision backend is an **addition to that list**, not a rewrite of the
orchestration around it — and the fact that two fakes already satisfy the trait is the evidence
that a third implementation is an ordinary thing to do here rather than a structural change.

**One module stops being needed on two of the three platforms, and it is the big one.**
`package.rs` (1,975 lines) exists purely to fetch, unpack, install and uninstall the ~1 GB
downloaded runtime — its whole public surface is `installed_runtime`, `acquire_installed_runtime`,
`ocr_package_status`, `ocr_package_download`, `ocr_package_cancel`, `ocr_package_uninstall`.
Under Vision none of that runs on macOS or iOS. It stays necessary for Windows, so this is a
`cfg` narrowing and not a deletion.

> **Correction, recorded because the wrong number was in circulation.** The briefing for this
> entry said `package.rs` (1,975), `publish.rs` (303) and `validate.rs` (151) all exist to
> fetch, unpack and verify the runtime, for a saving of ~2,400 lines. Reading them says
> otherwise, and it matters in the direction that costs money rather than saves it.
> `validate.rs` validates the **output PDF**, not the runtime: `validate_output(source, output:
> OcrOutput) -> VerifiedOutput` (`:39`) plus `reject_signed_pdf` (`:28`), page sampling and
> SHA-256, over `pdfium_render`. `publish.rs` then takes that `VerifiedOutput` and writes the
> asset row and the sync event (`publish_verified_output`, `:29`). Both are the output half of
> the pipeline and both are **reused unchanged** under Vision — in fact `validate.rs` matters
> *more* under Vision, since the PDF being verified is one Lantern composited itself rather
> than one a mature external tool produced. The saving is ~1,975 lines, not ~2,400.

`jobs.rs` (583) and `manager.rs` (908) are orchestration and are reused unchanged, as are
`assets.rs` and `resolver.rs` — the read half D-003 already established ships on iOS.

**The real new cost is producing the output PDF, and it should be named rather than buried.**
`OcrOutput` carries an `output_path` (`backend.rs:88`): the backend's contract is to emit a
searchable PDF, and ocrmypdf does that for us today. Vision does not. It returns recognized
text with bounding boxes — observations, not a document. So the Vision backend has to composite
the searchable PDF itself: draw each original page image, then draw the recognized text in an
invisible render mode at the observation rectangles, via PDFKit and Core Graphics. That is the
bulk of the new code and it is the main risk in this decision. The failure mode to watch is
text-layer alignment — if the invisible text does not sit on the glyphs the page still *looks*
perfect, and only selection and copy come out displaced, which is the kind of defect that
survives a visual check.

**Why now, when this was evaluated and rejected before.** macOS's built-in OCR was tried
earlier, and its output quality turned out to be actually *better* than the external runtime's.
It was rejected anyway, purely on code volume — a second backend to write and maintain, for a
quality gain that was liveable without. iOS removes the choice: the external runtime cannot run
there at all (no `fork`/`exec` for third-party apps, App Store guideline 2.5.2), and
[§1](#1-goals-and-non-goals) puts OCR on the phone. Once the Vision backend has to be written
for iOS anyway, the marginal cost of also selecting it on macOS is small — same framework, same
code, one `cfg` arm — and the quality is the better of the two. That is the entire
justification, it is a judgement rather than a measurement, and it is not recoverable from the
code, which is why it is recorded here.

**Consequence for [D-005](#d-005--capability-flags-not-platform-checks):** `hasOcr` stops
meaning "this is a desktop". Every platform has OCR after this; what differs is the backend
behind it. So the flag either goes true everywhere, in which case it is dead weight, or it is
re-derived to describe something a UI genuinely branches on — most likely whether there is a
runtime download to manage, which is a Windows-only settings surface. Left to whoever does the
work; flagged here so it is not carried over unexamined.

**Revisit if:** Vision's PDF compositing turns out to cost materially more than the recognition
backend itself. The fallback is macOS staying on ocrmypdf while iOS alone takes Vision — at the
price of two backends on Apple platforms, which is exactly what this decision buys out of.

Decided 2026-08-06.

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

> **Item 2 no longer exists (2026-08-02, v2.6.0).** Deleting the v1.4 vault removed the only
> `keyring` call sites, and `keyring` / `security-framework` are out of `Cargo.toml`. Kept
> below as the audit record of what P0 actually had to deal with.

1. **`Builder::menu` / `on_menu_event`** at `src-tauri/src/lib.rs:432,467` are unguarded.
   Confirmed `#[cfg(desktop)]` at `tauri-2.10.3/src/app.rs:1827,1850`. Hard compile error.
2. **`keyring`** *(since removed — see the note above)* — `src-tauri/src/secrets.rs:6`
   imported it unconditionally, but
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
   so iOS routes to Security.framework. This entry used to add that switching to `rustls-tls`
   is "still worth doing" for the duplicate TLS stack (`rustls 0.23` is already in the graph
   via `msedge-tts`). **Retracted 2026-08-02:** deduplicating the stack is not worth swapping
   every platform's root-certificate store for a bundled one. Android-only work, and it waits
   for Android — see P0 item 5 and [D-002](#d-002--ios-first-android-deferred).

### F-003 — Path resolution is wrong on iOS, silently

`resolve_log_dir()` and `resolve_app_data_dir()` (`src-tauri/src/lib.rs:135-197`) derive paths
from `HOME` / `XDG_DATA_HOME` with `.expect()` at lines 142, 157, 179, 194. iOS is `cfg(unix)`
and not `macos`, so it falls into the desktop-Linux arm.

iOS does not panic (`HOME` is set to the sandbox container root) — it **succeeds into the
wrong place**: `<container>/.local/share/com.klaragraff.lantern/`. That is a hidden dot
directory outside `Library/`, so it lands in iCloud/iTunes backup with no
`NSURLIsExcludedFromBackupKey`, and it diverges from `app.path().app_data_dir()`
(`<container>/Library/Application Support/<id>`), leaving two disagreeing data roots. Two
runtime callers use it: speech cache and OCR runtime.

**Shrunk 2026-08-02:** imported fonts used to be the third. Making them syncable moved
`imported-fonts/` under `Db.data_dir` — the shared iCloud folder when sync is on, otherwise the
local app data dir, both derived from Tauri's `app.path().app_data_dir()`. `commands/fonts.rs`
no longer calls `resolve_app_data_dir()` at all. This does not fix F-003; it removes one caller
from it. See `docs/impls/syncable-custom-fonts.md`.

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

**Confirmed by running it, 2026-08-02.** A 15.1 MB Chinese EPUB seeded into the Simulator's
"On My iPhone" imported end to end on the first try: picker filtered to `.epub`, sandbox copy,
EPUB parse, cover extraction, CJK metadata, SQLite write, shelf count 0 → 1. No code changed.
The reasoning below is what predicted it; the run is what settles it.

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
out in the picker.

**This paragraph used to end with a wrong sentence, and the error mis-scoped
[P2 item 7](#p2--mobile-ui-185-days) in both directions.** It said those formats "need Calibre
conversion and cannot be read on iOS regardless." That is true of the MOBI family only. FB2,
FBZ and CBZ are read natively by foliate-js (`fb2.js`, `comic-book.js`) — `do_import_native`
(`import.rs:229`) copies the source in and hands it straight to the reader, and
`convert_to_epub` is set only for `ImportFormat::Mobi` and only when a backend exists
(`import.rs:246`). So three formats the phone can genuinely read were unpickable on it, which
is the real gap item 7 closes; and declaring UTIs for the MOBI family — the thing the sentence
implied was the whole job — would have been the one change worth *not* making, except that it
was already moot: `IMPORTABLE_BOOK_EXTENSIONS` drops MOBI on mobile at
`src-tauri/src/commands/books/mod.rs:119`, so it never reaches the filter.

**Open, and a product call rather than a fix:** that mobile exclusion may itself be too strict.
Its comment says offering MOBI "would import a book that never finishes preparing," and the
code two files over says otherwise — with no backend, `preparation_state` is
`default_preparation_state()`, which is `"ready"` (`mod.rs:223`), and `render_format` stays
`mobi`, so foliate's `mobi.js` renders it read-only. A MOBI on iPhone would import and open;
what it would lack is selection and the AI tools that sit on top of the EPUB normalisation.
Whether the phone should offer a degraded-but-readable MOBI is a decision about what Lantern
promises, not a bug, so it is written down here rather than changed.

### F-009 — Relocating the sync directory is already a solved operation

Data is split. `lantern.db` — notes, vocabulary, reading progress, highlights — always lives in
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

### F-010 — Only a real iOS compile finds the cfg holes

Verified 2026-08-02 with `cargo check --target aarch64-apple-ios-sim` (Xcode 26.6,
iPhoneSimulator26.5.sdk). Both targets now pass: `ios=0 mac=0`.

The first run failed with three `E0433`s, all from gating `commands::ocr` wholesale
(see [D-003](#d-003--ocr-stays-on-desktop--superseded-by-d-017)). Nothing about that mistake was visible on
macOS — the module was present there, so every call site resolved.

The general lesson for the phases below: **`cargo check` on the host does not validate
`#[cfg]` work.** Excluding a module compiles fine on the platform that still has it, and
the callers you forgot only surface when the module is actually absent. Every phase that
touches a `cfg` must run the iOS check before it is called done. This costs nothing now
that the toolchain is set up — an incremental iOS check is ~5s.

Corollary worth stating: the iOS *SDK* ships inside `Xcode.app`, so cross-compilation
never needed the 8.5 GB Simulator *runtime* download. Only actually booting the app does.

### F-011 — First run: what the app actually does on a phone

Observed 2026-08-02 on iPhone 17 Pro Simulator (iOS 26.5), debug build via `tauri ios dev`.
It launches, the shelf renders, a book imports, and the book opens. Nothing crashed and the
runtime log has no panics. Everything below is a *layout and interaction* defect, which is
what P1–P3 exist to fix — none of it invalidates the port.

| Observed | Owned by |
|---|---|
| Sidebar is a fixed desktop width and eats ~55% of a 402 pt screen | P2 |
| Shelf and reader body overflow the right edge; the page scrolls horizontally | P2 |
| Reader toolbar collides — "Chapter 3 of 20" overlaps the font-size control | P2 |
| No safe-area insets anywhere; content runs under the status bar region | P2 |
| "Drop files or click to import more books" is shown — drag-drop does not exist here | P1, `hasDragDrop: false` — **fixed**, `e67b019` |
| A horizontal swipe scrolls the text vertically instead of turning the page | P3 |

One more, seen during P1's verification pass on the same device rather than on first run:
**settings panes do not scroll**, so anything below the fold — the reveal-logs button, the
custom-font importer — cannot be reached at all. P2, and it is the reason those two gates were
confirmed by reading rather than by tapping.

The last one is the most substantive: the reader responds to touch, but the page-turn gesture
is not wired to a swipe, so the current touch handling reaches the webview as a plain scroll.
Sizing P3 should start from that rather than from the assumption that pagination works.

**Memory:** 377 MB RSS with the 15 MB book open. Superseded — that reading was RSS on a
debug build served over HTTP from the Vite dev server, and RSS is the wrong meter for a
WebKit process anyway. See the measured table under
[Q-002](#q-002--does-the-reader-hold-acceptable-memory-on-a-real-device) for figures taken
against bundled assets with `phys_footprint`.

### F-012 — The reader opens every book twice

Every book open runs the whole open sequence twice, concurrently. The `reader.diag` trail
shows matched, interleaved pairs — two `reader.open.start`, two `reader.open.fetch-start`,
two `reader.open.fetch-done`, two `view-open-start` — for EPUB and PDF alike. This is a
`vite build` frontend, so it is not React's development-only double-effect.

It costs a duplicated download and parse of the whole book (30 MB of transfer for the 15 MB
test file), and it races: two concurrent `import('./pdf.js')` calls are what exposed the
temporal-dead-zone bug that stopped PDFs opening on iOS at all. That particular window is
closed, but the duplicate open is still there and can lose other races.

The cause is in `src/pages/Reader.tsx`, which the desktop mastery line owns right now, so it
is filed rather than fixed. Whoever takes it: make a second open for the same book id no-op
or cancel the first, and verify by opening a book and seeing one pair of trail entries.

---

## 4. Open questions

### Q-001 — Windows reachability (deferred)

Whether declaring `NSUbiquitousContainers` with `NSUbiquitousContainerIsDocumentScopePublic`
surfaces the app's container in iCloud Drive such that iCloud for Windows syncs it. Confidence
was medium and it was never verified against first-party documentation.

**No longer blocks anything** — [D-007](#d-007--windows-sync-is-out-of-scope) scopes Windows
out. The container can stay private, so the question does not need answering for this
milestone. Kept here because it is the first thing to check if Windows sync comes back.

### Q-004 — macOS relocation to the app container (answered — there is nothing to relocate)

Desktop sync today points at a *user-picked* folder. For iOS to meet macOS, macOS has to use
the app's own ubiquity container instead. This was written up as a migration problem, then as a
mostly-solved migration problem — see
[F-009](#f-009--relocating-the-sync-directory-is-already-a-solved-operation) — and it is
neither.

**Answered 2026-08-06 — [D-015](#d-015--the-sync-directory-is-the-apps-ubiquity-container-and-picking-one-goes-away).**
There is no installed copy of Lantern anywhere with a picked folder recorded, because the app
has never been distributed. Nothing needs detecting, chaining, or announcing. The ~0.5 day is
deleted rather than folded in; what remains in P5 item 2 is resolving the root from the
container and removing the picker from settings.

The picker half landed the same day. The container half turned out to have a question of its
own — [Q-005](#q-005--can-the-macos-build-reach-the-apps-ubiquity-container-answered--yes-for-free).

### Q-005 — Can the macOS build reach the app's ubiquity container? (answered — yes, for free)

iOS syncs to `iCloud.com.klaragraff.lantern`. For the two to meet, the Mac has to write to
`~/Library/Mobile Documents/iCloud~com~klaragraff~lantern/Documents`. The worry was that both
routes cost something: the API (`URLForUbiquityContainerIdentifier`) needs the iCloud
entitlement, and so an embedded provisioning profile on a Developer ID build; the constructed
path avoids that but might produce an inert folder that looks right and never syncs.

**Answered 2026-08-06 — the constructed path works, and the signing pipeline is untouched.**
The entitlement is needed for that API and for sandboxed builds, not for file I/O into the
container. What binds an app to its container is `NSUbiquitousContainers` in `Info.plist`,
which is not signed material and needs no portal authorization. Obsidian is the existence
proof on this machine: Developer ID signed, no iCloud entitlement, no embedded profile, not
sandboxed — and its desktop build created a vault inside `iCloud~md~obsidian/Documents` that
`brctl` reports as `caught-up` with server-side etags. `release.yml`, `signingIdentity` and
`entitlements: null` all stay exactly as they are.

**One caveat that shapes the code:** never `mkdir` the container root. bird's registry and the
on-disk tree match exactly (46 = 46), so those directories are the daemon's; a hand-made one
never syncs. A missing container is the existing `ICLOUD_DRIVE_UNAVAILABLE` state.

**P5 item 2's macOS half is unblocked**, and with it the exit criterion for the phase.

**The price, and it is real:** nothing on the Mac provisions the container. `com~apple~CloudDocs`
existed whenever iCloud Drive was on, so desktop sync used to stand alone; the app's own
container appears only once the iCloud account learns it, which in practice means the iOS build
running on hardware at least once. Until then macOS sync reports `ICLOUD_DRIVE_UNAVAILABLE`.
Two Macs and no iPhone can no longer sync with each other.

Accepted rather than fixed. [D-007](#d-007--windows-sync-is-out-of-scope) already scopes sync as
the macOS ↔ iOS pair, so a Mac with no phone has no peer to sync with either way, and the fix —
entitling the Developer ID build so `URLForUbiquityContainerIdentifier` can provision it — costs
an embedded provisioning profile and a changed signing pipeline, which is the whole expense
Q-005 just established we do not have to pay. What the error message says is the part worth
getting right: on desktop it has to name the real precondition, not send the user to check an
iCloud Drive switch that is already on.

### Q-002 — Does the reader hold acceptable memory on a real device?

Whole books load as a single in-memory Blob, and PDF pages render at
`zoom × devicePixelRatio`. On a 3× DPR phone both are plausible ways to hit the WebView
memory ceiling. Readest addresses the same problem by parsing EPUB/MOBI in Rust to avoid
ferrying large blobs across IPC.

**This is two questions, and the Simulator answers one of them.** The earlier note here —
that nothing could be learned before hardware — was wrong and cost time.

- **How much does the reader actually use?** The Simulator answers this. An arm64 simulator
  on Apple Silicon runs the same compiled code against the same WebKit, and it emulates 3×
  DPR faithfully, so the blob and the canvas backing store are the same size they will be on
  a phone. Measure with `xcrun simctl spawn … footprint` or Instruments' Allocations against
  the largest book on hand. Answerable now, and answered below.
- **Does that number get the app killed?** The Simulator cannot answer this. It allocates
  from the Mac's RAM and does not enforce jetsam limits, so the app will happily grow past
  any figure a real device would kill it at. Only a release build on hardware settles it.

Splitting them matters because the first half is what drives design work. If the reader
already sits far under an iPhone's jetsam budget, the Rust-side EPUB parsing that Readest
does is not work Lantern needs, and P4 can drop it. If it sits near the line, that work
starts now rather than after a device test. The kill question only ever gates shipping.

#### Measured, 2026-08-06 — EPUB is fine, PDF is not

iPhone 17 Pro Simulator (iOS 26.5, 402×874 pt at DPR 3), bundled assets, no dev server.
Figures are `phys_footprint` from `footprint(1)` — the number jetsam meters — not RSS, which
counts evictable file-backed pages and flatters a WebKit process badly. iOS runs the web
content in its own process with its own limit, so both are reported.

| State | app | WebContent |
| --- | --- | --- |
| Launched, library | 24 MB | 44 MB |
| 15 MB EPUB open | 32 MB | 57 MB |
| …after reading on | 32 MB | 55 MB |
| 15 MB PDF, page 1 | 33 MB | 158 MB |
| …after 4 pages | 34 MB | 208 MB |
| …after 8 pages | 35 MB | 260 MB |
| …after 12 pages | 36 MB | 303 MB |

**EPUB answers the original worry, and answers it well.** A 15 MB book costs ~21 MB across
both processes, and the figure *falls* as you keep reading — foliate-js drops sections behind
you. The whole-book Blob does not stay resident. So the Rust-side EPUB parsing Readest does
is not work Lantern needs; it comes off P4.

**PDF is a real defect.** ~12 MB per page, linear, no plateau across 12 pages, and nothing
returns after 20 s idle. Reading this 253-page book end to end would ask for ~3 GB. It will
be killed long before that.

#### Corrected cause, same day — it was not the blob cache

The first reading of this blamed `cache` in `public/foliate-js/pdf.js`, on the arithmetic
that 12 MB is exactly one full-page canvas at DPR 3 (1206 × 2622 × 4 B = 12.6 MB). A probe
inside `pdf-scroll.js` disproved it. Mounted slots stayed bounded at 7–8 in a settled layout
and peaked near 25 only during a re-layout before falling back; total canvas area across all
mounted slots stayed between 1 and 51 MB; and `#unmountSlot` did fire, at `distance ≈ 3.24`
viewport heights. The canvas layer is well-behaved and the virtualization works. The
per-page arithmetic was a coincidence.

What actually grew is **pdf.js's own per-page retention**: a `PDFPageProxy` holds its
operator list, decoded images and fonts on the main thread, and the Worker keeps a parallel
cache, and both live until something explicitly asks them to let go. Nothing ever did.
Memory tracked the number of *distinct pages ever rendered*, not the number currently
mounted — which is why it never came back on idle and never came back when slots unmounted.

The fix implements the lifecycle hook foliate already defines and PDF was the one format
missing. `epub.js` and `comic-book.js` implement `section.unload()`; `paginator.js` calls it.
`pdf.js` now does too: it drops the blob from `cache`, revokes the URL, and schedules
`pdf.cleanup()` — the only call that reaches the Worker's cache as well. Cleanup is
debounced (unloads arrive in bursts) and retried with backoff, because it rejects outright
if any page is mid-render. Paginated PDF reading gets the same benefit for free.

The mechanism is platform-independent — desktop had the same growth and only hid it behind
DPR 2 and plentiful RAM.

#### Re-measured after the fix, 2026-08-06 — growth stops

Same device and book. Page-turning could not be driven: neither `swipe` nor `touch_path`
scrolls the PDF view under synthetic touch, so the 12-page walk above has no after-figure.
The TOC open/close re-layout was used instead — a harsher stressor, since it mounts ~25 rows
at once — and it is the sequence the before-numbers below come from.

| State | before | after |
| --- | --- | --- |
| Launched, library | 53 MB | 49 MB |
| PDF, page 1 | 157 MB | 173 MB |
| TOC open #1 | 341 MB | 377 MB |
| TOC closed | 336 MB | 335 MB |
| TOC open #2 | 392–400 MB | 303 MB |
| TOC closed #2 | — | 283 MB |
| TOC open #3 | — | 303 MB |
| Idle 25 s | 346 MB, no reclaim | 300 MB |

Before, every cycle ended higher than the last and idle returned nothing. After, it rises
once and then oscillates in a 283–335 MB band, trending down. 42 `unload()` calls fired and
every `pdf.cleanup()` resolved on the first attempt — no mid-render retries — and the page
still rendered correctly afterwards.

The floor is still ~300 MB, which is not the growth defect but is worth its own look:
`book.getPageSize` calls `pdf.getPage()` for all 253 pages during layout, so a
`PDFPageProxy` exists for every page in the book from the moment it opens. `cleanup()`
empties those objects but does not remove them.

**This is not the jetsam question.** The Simulator allocates from the Mac's RAM, so it never
killed the app; it only showed the growth. Whether a given figure survives on a device stays
with P6.

Found on the way in: PDFs would not open on iOS at all (`Cannot access 'makePDF' before
initialization`) — two top-level `await`s in `pdf.js` left its exports in the temporal dead
zone while the reader's duplicated open raced into the window. Fixed by loading those
stylesheets lazily. The duplicated open itself is [F-012](#f-012--the-reader-opens-every-book-twice).

### Q-003 — Does iOS text selection fight the lookup popover?

The system selection loupe and callout bar may collide with the reader's custom word-lookup
popup. Estimated at 6 days inside P3, but the real cost depends on whether the callout can be
suppressed cleanly in WKWebView.

---

## 5. Phases

Each phase ends in something checkable. Do not start the next until the exit criterion holds.

### P0 — Compile and boot (6 days)

Smallest possible reality check: does the Rust core survive the port at all.

1. ~~Bump `tauri` to `=2.11.5` and `tauri-build` to `=2.6.3`, `@tauri-apps/api` to `2.11.1`~~ —
   done, `ff0d5d0`. 2.11 also emits a second hidden macro per command
   (`__tauri_command_name_<name>`); `commands::books` re-exported only the `__cmd__` half, so
   sixteen commands failed to resolve until both were exported together.
2. ~~Gate the menu wiring behind `#[cfg(desktop)]`~~ — done, `84ebd26`, via `install_menu()`.
3. ~~Keychain~~ — done, `84ebd26`. Resolved better than planned: keyring 3.6.3 has a real iOS
   backend (`Cargo.toml:159` declares security-framework under `cfg(target_os = "ios")`;
   `aarch64-apple-ios` is in its CI matrix), so rather than disabling the path, the Apple
   dependency tables moved to `cfg(target_vendor = "apple")` and the Keychain works on iOS.
4. ~~Path resolution~~ — done, `84ebd26`. Both helpers now key on `target_vendor`; `.expect()`
   calls became fallbacks.
5. ~~Switch `reqwest` to `rustls-tls`~~ — **dropped from P0.** This was planned while Android was
   in scope. It buys iOS nothing: `native-tls` gates OpenSSL on
   `cfg(not(any(windows, target_vendor = "apple")))`, so iOS routes to Security.framework and
   `openssl-sys` never enters the iOS tree. Meanwhile `rustls-tls` resolves to
   `rustls-tls-webpki-roots` — a bundled root store that ignores the OS trust store — so the
   swap would break any user behind a corporate proxy with a custom CA. Revisit alongside
   Android, and use `rustls-tls-native-roots` when it happens.
6. ~~cfg out `commands::ocr`~~ — done, but **the first attempt was wrong and shipped for a
   day.** `84ebd26` gated the whole module; the iOS compile then failed with three `E0433`s
   from call sites outside it. Re-cut along the read/write seam described in
   [D-003](#d-003--ocr-stays-on-desktop--superseded-by-d-017) — the resolver ships on iOS, the
   pipeline does not. **That gating is what [D-017](#d-017--ocr-moves-to-vision-on-ios-and-macos-ocrmypdf-stays-on-windows)
   now partially undoes:** the resolver still ships, but so does a recognition backend.
7. ~~Verify the port actually compiles for iOS~~ — done. `cargo check --target
   aarch64-apple-ios-sim` and the host check both pass (`ios=0 mac=0`), 618 backend tests
   green. See [F-010](#f-010--only-a-real-ios-compile-finds-the-cfg-holes) — the host check
   proves nothing about `cfg` work, so this step is not optional in later phases either.
8. ~~`tauri ios init`, then `tauri ios dev`~~ — done. `gen/apple/` is committed; the generated
   project builds `Lantern.app` for `com.klaragraff.lantern` at deployment target iOS 14.0.

**Exit criterion: met, 2026-08-02.** The app launches on the iPhone 17 Pro Simulator (iOS
26.5), the library renders, a 15 MB EPUB imports through the system picker, and it opens with
foliate-js paginating CJK text correctly in WKWebView. Badly laid out, exactly as allowed for.
See [F-011](#f-011--first-run-what-the-app-actually-does-on-a-phone) for what was observed and
which later phase owns each defect.

[Q-002](#q-002--does-the-reader-hold-acceptable-memory-on-a-real-device) is not answered here.
Only its second half needs hardware, though — the first half, how much memory the reader
actually uses, is measurable on the Simulator and is being measured. See the question itself
for why the two split.

#### Toolchain prerequisites (resolved 2026-08-02)

**Rust: done.** Homebrew's rust (1.96.1, `aarch64-apple-darwin` only, no `rustup`) was replaced
with a rustup toolchain — stable 1.97.1 with `aarch64-apple-ios` and `aarch64-apple-ios-sim`
installed. `~/.cargo/bin` was already on `PATH`, so removing the Homebrew formula was enough to
make `rustc`/`cargo` resolve unambiguously to rustup. Verified after the swap: `cargo check
--all-targets` clean, backend tests pass, frontend build passes, and a forced rebuild of a
C-dependency (`sqlite-vec`) succeeds — the C toolchain is Apple clang from Command Line Tools,
so `brew uninstall rust` autoremoving llvm did not affect it.

**Xcode: done.** Xcode 26.6 (build 17F113) is installed and `xcode-select -p` points at
`/Applications/Xcode.app/Contents/Developer`. Steps 1–3 below needed a human: the App Store
install needs the GUI and an Apple ID, and `sudo` cannot be driven from a tool call.

1. ~~Install Xcode from the App Store (~15 GB)~~
2. ~~`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`~~
3. ~~`sudo xcodebuild -license accept`~~
4. ~~`xcrun simctl list runtimes`~~ — iOS 26.5 (23F77) installed. The 8.5 GB runtime is needed
   only to *run* the app; `iPhoneSimulator26.5.sdk` inside `Xcode.app` already covers compiling.

**`tauri ios init` needs three more things, and it installs only two of them.** It shells out
to Homebrew for `xcodegen` and `libimobiledevice` on its own, but for CocoaPods it tries
`gem install`, which needs `sudo` and therefore fails unattended:

```
Info Installing `cocoapods` with gem...
`sudo` is required to install cocoapods using gem
Error failed to run command pod install
```

Use `brew install cocoapods` instead — same result, no password, and it brings its own Ruby
(1.17.0 here) rather than touching the system one. The init rolls back cleanly on this
failure: `gen/apple/` is not left half-written, so re-running after the fix is safe.

CocoaPods also warns unless the shell is UTF-8; export `LANG`/`LC_ALL=en_US.UTF-8` around
`tauri ios` commands.

**Keep the CLI and the runtime on the same minor.** `@tauri-apps/cli` is ranged `^2` and had
resolved to 2.10.1 while the Rust crate is pinned `=2.11.5`. The CLI is what generates the
Xcode project, so a stale one templates against the wrong runtime; bumped to 2.11.4.

### P1 — Capability layer and single-window navigation (11 days)

1. ~~Build `src/services/platform.ts` per [D-005](#d-005--capability-flags-not-platform-checks);
   migrate existing scattered platform checks into it~~ — done, `2291403`. Only three real
   platform checks existed to migrate: a `navigator.userAgent.includes("Macintosh")` sniff
   hiding the Library Sync tab, a UA-derived OS label in About, and a `navigator.platform`
   test choosing ⌘ vs Ctrl glyphs. The capability set is read through `@tauri-apps/plugin-os`
   rather than the UA — not a preference: **iPadOS reports `Macintosh` in its webview UA**, so
   the sniff being replaced would have handed an iPad the full desktop capability set.

   **`hasKeyboard` was drafted and withdrawn.** It looks like a capability — the shortcut
   recorder and the menu-shortcut hints are useless without keys — but an iPad with a Magic
   Keyboard is an ordinary setup, so gating them on the platform would take the feature away
   from the people who can use it. Keyboard-dependence is not platform-dependence.

   Four flags have **no consumer yet** and each says so in its own doc comment:
   `hasTitleBarInset` and `hasSafeAreaInset` (P2 reads them), `hasUpdater` (Lantern ships no
   updater at all), and `distChannel` (every current build is direct; an App Store build would
   have to bake the value in, as it cannot be recovered at runtime).
2. ~~Route `openReaderWindow()` through `hasWindow` — `navigate()` on iOS~~ — done, `7a447d8`.
   **Eight call sites, not nine.** The address is now built once by `readerUrl()` and used both
   ways — a new window loads it, a single-window platform navigates to it — so the two paths
   cannot drift on what a target means. `useOpenBook` picks between them and has to be a hook:
   the app uses `<BrowserRouter>`, not a data router, so `navigate` is only reachable from
   inside a component.
3. ~~Replace the three cross-window `emitTo` fan-outs with a single-window-aware helper~~ —
   done, `6ba5d4f`. **They were not one shape, so this is two functions.** `notifyReaders`
   addresses the windows showing one book; `notifyAllReaders` addresses every reader, for the
   lookup-retention setting, which is library-wide and carries an empty detail. Collapsing them
   would have made "no book id" silently mean "everyone", which is not what the old code did.
4. ~~Hoist `<SettingsModal>` from `Home` into `App.tsx`~~ — done, `62d0b4f`. `Home` lost its
   settings state entirely, including the refetch it did when the modal closed. The reader's
   display name now refreshes off the `settings-changed` stream `useSettings.save()` already
   emits — narrower and faster than a refetch, and correct wherever the edit came from. A
   desktop reader window still forwards by label rather than mounting a second modal.
5. ~~Hide desktop-only surfaces behind capability flags~~ — done, `e67b019`. **Format
   conversion had no frontend surface at all.** The real surface is
   `IMPORTABLE_BOOK_EXTENSIONS` in Rust — it feeds both the import dialog's filter and the
   drag-drop validator — so the gate is a `cfg` split, not a React condition. Mobile drops
   exactly the MOBI family (`mobi`/`azw`/`azw3`), which is what needs Calibre's
   `ebook-convert`; FB2 and CBZ stay, because foliate-js parses them in-process. Offering the
   MOBI family would import a book that never finishes preparing.
6. ~~No-op `useWindowSizePersistence` on mobile~~ — done, `7a447d8`. **No functional change was
   needed.** The window label on iOS is `main`, so `isStandaloneWindow` is already false and
   the caller's `enabled` argument already no-ops the hook. The `hasWindow` guard was added
   anyway, to say why the `onResized` listener has nothing to do here.

**Exit criterion: met, 2026-08-02.** Verified on the iPhone 17 Pro Simulator (iOS 26.5),
debug build: tapping a book navigates in-window to the reader, the back arrow returns to the
library, the settings modal opens from its new home above the router, the Library Sync and MCP
tabs are absent, and Services shows three sub-tabs with OCR gone. About reports `iOS · aarch64`
from the OS plugin. Desktop: everything CI runs passes locally, plus `cargo build` links the
binary and `cargo check --target aarch64-apple-ios-sim` covers both sides of the new `cfg`.

The live pass turned up two things the gates alone did not. Fixed in `e4bde4d`: the Services
tab still advertised "Models, speech and OCR" under a tab with no OCR view — the gate on the
view was right, the sentence naming it was not.

Noted, not fixed: the settings panes do not scroll on iOS, so anything below the fold is
unreachable. That is a layout defect and belongs to P2; it is why *reveal-logs* and *font
import* were confirmed by reading the gate rather than by tapping.

#### What P1 deliberately did not fix

- **`isStandaloneWindow` still drives twenty branches in `Reader.tsx`.** On iOS it is false,
  which happens to select the right in-window header, back arrow and progress bar — the
  desktop main-window branch is already the single-window branch. It reads as a window check
  where P2 will want a size check, but rewriting it before the mobile layout exists would be
  guessing.
- **A pre-existing desktop bug, found while gating OCR.** `open_settings_on_main`
  (`commands/settings.rs`) accepts a `view` only when `section == "tools"`, but `Reader.tsx`
  invokes it with `{ section: "services", view: "ocr" }`. That always fails validation, the
  frontend catch falls back to `{ section: "tools" }`, and the OCR HUD's settings button lands
  on Reading Assistance instead of Services → OCR. Left alone because P1 must not change
  desktop behaviour.
- **Backend commands with no `cfg` gate.** `reveal_logs`, the four `commands::mcp::*`,
  `sync_reveal_folder` and `import_custom_fonts` are registered unconditionally, unlike the
  OCR pipeline. Nothing panics — they return typed `AppResult` errors — so this is a
  dead-button risk that the frontend flags now cover, not a crash risk. Worth closing when
  something else takes that file apart.

### P2 — Mobile UI (18.5 days)

Scope is the surface from [§1](#1-goals-and-non-goals) — which is now *every core feature*,
not a reduced subset. Items 4 and 8 grew on 2026-08-06; items 9–11 were added later the same
day when the independence premise landed. **The 18.5 days predate all of them** and this phase
has not been re-scored.

**Do not start this phase until the desktop mastery line has landed — [D-011](#d-011--p2-waits-for-the-desktop-mastery-line-to-finish).**
It rewrites the same files items 2, 4 and 5 below are about.

1. Global: `viewport-fit=cover`, safe-area insets, `touch-action` defaults, breakpoint system
2. Home: 224px sidebar → drawer or bottom nav
3. Reader: three-column → phone layout (TOC as drawer, side panel as bottom sheet)
4. Mobile settings: font size, theme, page-turn mode — **plus AI provider configuration**
   (key entry, model choice, connection test), which [D-012](#d-012--the-phone-gets-ai-contextual-glosses-not-ai-chat)
   added, **plus the metered-connection answer**, which now has to cover AI calls as well as
   book downloads ([D-016](#d-016--on-cellular-a-book-download-asks-once-and-remembers)). The
   original 18.5 days covered none of it. This is no longer a "reduced" settings pane: the
   phone carries a setting for every feature the phone has
5. Lookup / translation popovers → bottom sheets
6. The subset of the 25 wide hardcoded widths that the reduced surface touches
7. ~~`Info.plist` UTI declarations for the picker filter~~ — **done, at a third of its scope.**
   [F-006](#f-006--ios-book-import-works-with-zero-code-changes) had this covering
   mobi/azw3/fb2/cbz; MOBI was already excluded from the mobile filter list and must stay
   excluded, so only fb2/fbz/cbz needed declaring. `UTImportedTypeDeclarations` in
   `gen/apple/lantern_iOS/Info.plist`, pinned by `tests/ios-picker-types.test.ts`. Runtime
   behaviour is still owed a look on a device — see the note in that file.
8. **A downloading state for a book that is not resident on the phone** — shelf badge plus
   in-reader progress. Required by [D-013](#d-013--books-download-on-demand-not-eagerly), and
   on the common path rather than an edge case. Also new scope.

Items 9–11 are the Tier-1 promotions from [§1](#1-goals-and-non-goals). Together they are the
difference between a phone that can read a library and a phone that can maintain one, which is
why they are in this release and not the next:

9. **Note editing.** Whether the mobile layout already reaches the note editor, or the editor
   is desktop-shaped and needs rebuilding as a sheet, is **unverified** — scope this by
   looking, not from this line. What the phone owes is the write path, not only the read path
10. **Collection management** — create, rename, delete, and move books in and out of
    collections, from the phone alone
11. **书籍来源 (book sources)** — the editable list of sites to get books from. Strings already
    exist and are at parity in both locales (`settings.bookSources.*`), and the feature is a
    settings list plus an open-in-browser action, which makes it the cheapest of the three.
    It is also the one whose absence is most conspicuous: a phone-only reader with no source
    list has no route to a first book except files already on the device

**Exit criterion:** every screen in scope is usable one-handed on an iPhone SE viewport with
no horizontal scroll — **and** a reader who owns no Mac can import a book, file it into a
collection, edit a note on it, and find the next book from the source list, without a desktop
being involved at any point.

### P3 — Reader touch interaction (10 days)

1. Page-turn: tap zones, swipe, chrome toggle
2. Word lookup via long-press; disambiguate from selection
3. Resolve the iOS selection callout conflict ([Q-003](#q-003--does-ios-text-selection-fight-the-lookup-popover))

Read [`readest-comparison.md`](readest-comparison.md) §5 first. This is a gesture *arena* —
a priority registry plus a claim/lock decision — not a swipe handler, which is what the
10-day estimate is actually for. Their tuned constants (edge zone 0.18, fast-claim 6px,
vertical lock 8px, horizontal dominance 1.5×) are the expensive part and are free to copy.

**Exit criterion:** a full chapter can be read and three words looked up without a keyboard.

### P4 — iOS platform adaptation (11 days)

1. ~~Memory: address whatever [Q-002](#q-002--does-the-reader-hold-acceptable-memory-on-a-real-device)
   surfaced~~ — **done 2026-08-06.** EPUB needed nothing. PDF leaked every page it had ever
   parsed because `pdf.js` never implemented the `unload()` hook foliate already calls; adding
   it turned unbounded growth into a bounded, downward-trending band. Numbers in
   [Q-002](#q-002--does-the-reader-hold-acceptable-memory-on-a-real-device)
2. ~~Stop background SQLite writes on app suspension (`0xdead10cc` termination risk)~~ —
   **done 2026-08-06.** `src/lifecycle.rs`. Tauri turned out to offer no hook at all: `RunEvent`
   has `Resumed` and no suspension counterpart on any platform, so the UIKit notifications are
   observed directly through `NSNotificationCenter`. The three background workers
   (`sync-flush`, `cover-writer`, the watcher tick) take a permit around each unit of work;
   backgrounding closes the gate and waits up to 2 s for in-flight work, then runs
   `PRAGMA wal_checkpoint(TRUNCATE)` so a frozen process has no unflushed frames.
   **Verified on the simulator, not on a device** — the simulator does not actually suspend
   processes or issue `0xdead10cc`, so what was confirmed is that the wiring fires and does
   the right thing, not that a real kill was prevented. Two background/foreground cycles:
   both logged the quiesce and the release, and `lantern.db-wal` went 16512 → 0 bytes on
   backgrounding. The kill itself can only be falsified on hardware, in P6.
3. ~~`NSURLIsExcludedFromBackupKey` on caches and logs~~ — **done 2026-08-06.**
   `src/backup.rs`. Three directories are excluded at every launch: `speech-cache`,
   `prepared`, and the log directory. The motivating number is the speech cache's own
   ceiling — it is allowed to reach 2 GiB before it evicts anything, against a 5 GB free
   iCloud Backup allowance for the entire device. `books/`, `covers/`, `sources/`,
   `imported-fonts/`, `lantern.db` and `secrets.db` are deliberately left in the backup;
   losing any of those to a restore would lose the reader something no amount of waiting
   brings back. Runs on every launch rather than once, because the flag is an extended
   attribute on the directory and dies whenever the directory is deleted and recreated —
   which is exactly what a cache does. **This one is fully verified without hardware:** the
   flag is a filesystem attribute, so the simulator's is the same attribute a device would
   carry. `xattr -p com.apple.metadata:com_apple_backup_excludeItem` is present on all three
   targets and absent on `books/` and `lantern.db`. Four unit tests run the real Foundation
   call on the host, including the two properties the approach rests on: files written after
   the flag is set stay covered, and recreating the directory drops it
4. ~~Keychain via `keyring` `apple-native`~~ — **not work, and not this milestone's.** Deleting
   the v1.4 vault in v2.6.0 took `keyring` out of `Cargo.toml`; `secrets.rs` is plain SQLite on
   every platform. This line survived the sweep that produced `427be38` and is now retired.
5. ~~Move the Apple-only Cargo target tables from `cfg(target_os = "macos")` to
   `cfg(target_vendor = "apple")`~~ — done, ahead of this phase, because P5 item 1 could not
   compile without it. `objc2`, `objc2-foundation` and `block2` now resolve for iOS.

**Exit criterion:** no crash across a 30-minute reading session with backgrounding, and
Instruments shows no runaway memory. **Not met, and not meetable here.** All five items are
done, but this criterion names Instruments and a 30-minute session on a device; the simulator
neither suspends processes nor reproduces a phone's memory ceiling. It carries over to P6 as
the first thing to run once hardware is in the loop — which is the right place for it, since
that is also the only place the `0xdead10cc` claim in item 2 can be falsified.

### P5 — iCloud sync (12–18 days)

iOS ↔ macOS only ([D-007](#d-007--windows-sync-is-out-of-scope)).
[Q-004](#q-004--macos-relocation-to-the-app-container-answered--there-is-nothing-to-relocate)
is closed and added nothing to the estimate below.

1. ~~Widen `cfg(target_os = "macos")` → `cfg(target_vendor = "apple")` in `src/icloud.rs` and
   `src/sync/log.rs`~~ — **done 2026-08-06.** Nine gates in `icloud.rs` and four in
   `sync/log.rs`, not the six this line predicted; the line numbers it named were stale.
   **The `not(macos)` stubs were kept, not deleted** — Windows and Linux still need them, and
   the OCR manager (which calls the eviction pair) does compile on Windows. What changed on
   iOS is that the pair now has no caller at all, so both carry an `#[allow(dead_code)]` with
   the reason; without it an iOS clippy job would fail on `-D warnings` the day P6 adds one.
   The claim that no dependency change was needed was **wrong**: `objc2`/`objc2-foundation`/
   `block2` being in the iOS tree via tao/wry does not make them nameable here, so the Cargo
   target table had to be widened too (formerly P4 item 4). Verified: `cargo check` and
   `cargo clippy` clean on both the host and `aarch64-apple-ios-sim`, 25 `icloud`/`sync::log`
   tests green.
2. Target the app's own ubiquity container instead of a picked path. Per
   [D-015](#d-015--the-sync-directory-is-the-apps-ubiquity-container-and-picking-one-goes-away)
   this carries **no migration**.

   **The picker is gone, 2026-08-06.** `sync_set_shared_dir` was replaced by
   `sync_reveal_folder`, which opens the recorded folder in the shape `reveal_logs` already
   uses; the Library Sync row now reports the path and offers "Open location" instead of
   "Change folder", gated on `hasFileReveal` so the phone gets the path without a dead button.
   `hasFolderSync` became true for iOS. Removing the picker made `sync_enable` simpler rather
   than more complex: the branch that protected a hand-picked folder from being silently
   recreated had nothing left to protect, so `is_lantern_default_dir` and the
   `SYNC_FOLDER_NOT_IN_ICLOUD_DRIVE` error went with it — a recorded folder that no longer
   holds up is now just recreated. Fifteen strings in that panel described choosing a folder,
   or said "this Mac" where the phone will read the same sentence; all fifteen were rewritten
   in both locales.

   **The macOS half landed the same day**, and it turned out not to be the risky half:
   [Q-005](#q-005--can-the-macos-build-reach-the-apps-ubiquity-container-answered--yes-for-free)
   answered that a constructed path into the container syncs without an entitlement, so the
   desktop root moved from `~/Library/Mobile Documents/com~apple~CloudDocs/lantern` to
   `~/Library/Mobile Documents/iCloud~com~klaragraff~lantern/Documents` — the same place the
   phone writes — and `src-tauri/Info.plist` now declares `NSUbiquitousContainers` for the Mac
   too. The `lantern` subfolder is gone with it: the container is already this app's. Signing
   is untouched
3. Replace the `notify` watcher with `NSMetadataQuery` — kqueue does not observe
   iCloud-initiated downloads
4. **Partly already done, and this line used to overstate the work.**
   `is_awaiting_icloud_download` in `icloud.rs` already reads
   `NSURLUbiquitousItemDownloadingStatusKey`, and `file_readability` already consults it before
   attempting a read — precisely so a not-yet-downloaded item does not block. What is missing
   is the *acting* half: on a placeholder, call `trigger_download_file` and report progress to
   the frontend rather than surfacing "cannot open". [D-013](#d-013--books-download-on-demand-not-eagerly)
   makes that the phone's normal path, not an edge case, so it is no longer optional. On a
   cellular connection the first such download asks first and the answer sticks
   ([D-016](#d-016--on-cellular-a-book-download-asks-once-and-remembers)), which adds a
   remembered setting and therefore a row in mobile settings
5. iCloud Documents entitlement, container ID in the provisioning profile,
   `NSUbiquitousContainers` in `Info.plist` — **in-repo half done 2026-08-06, and it moved to
   the front of this phase** because nothing else here works until the container exists.
   `lantern_iOS.entitlements` declares `iCloud.com.klaragraff.lantern` under
   `icloud-container-identifiers`, `ubiquity-container-identifiers` and `icloud-services`
   (`CloudDocuments` — Lantern syncs a directory of files, not a record database);
   `Info.plist` declares `NSUbiquitousContainers` with `IsDocumentScopePublic`, which is what
   stops the container from being real but invisible in Files and Finder. The container is
   `iCloud.com.klaragraff.lantern` with no `-dev` suffix, unlike the app-data and log paths:
   one container, shared by debug and release, because the phone's bundle identifier carries
   no suffix either.

   **Two things are still owed, and neither is in the repo.** First, the container identifier
   has to be registered to the team and appear in the provisioning profile — a developer-portal
   action on the account holder's Apple account, not something this repo can do. Second, none
   of it is verifiable on the Simulator: `ENTITLEMENTS_ALLOWED=NO` for simulator builds, so
   Xcode strips every entitlement and `codesign -d --entitlements` on the built app prints an
   empty dictionary. What is verified is that the plist key reaches the bundle and the app
   still boots. That `URLForUbiquityContainerIdentifier` returns a real path can only be seen
   on hardware, after the portal step

**Exit criterion:** a book imported on the Mac appears on the iPhone; a highlight made on the
iPhone appears on the Mac; a book evicted on the Mac downloads on demand from the iPhone;
concurrent appends from both devices do not corrupt the JSONL log.

### P6 — Ship (10 days)

Scoped down to roughly 4–5 by [D-014](#d-014--first-ios-release-is-testflight-not-the-app-store);
the 10 days predate it.

Apple Developer enrollment, signing and provisioning, privacy manifest, TestFlight. Add an
iOS job to `release.yml`.

**Store assets, listing copy and App Review are out of this phase** — the first release is
TestFlight only. Most of the original 10 days was the review round-trip; what remains is the
upload path, which App Store Connect gates on a privacy manifest whether or not a build ever
reaches the store.

The privacy manifest must declare that selected book text is sent to a third-party model
([D-012](#d-012--the-phone-gets-ai-contextual-glosses-not-ai-chat)).

**No longer blocked outside this repo.** The Developer account's notarization was stuck from
2026-08-04; Apple's review passed on 2026-08-06 and the account is healthy. What remains is
all in-repo work — see [D-014](#d-014--first-ios-release-is-testflight-not-the-app-store).

**Exit criterion:** installable from TestFlight on a device that has never had a dev build.

---

## 6. Progress

| Phase | Status | Notes |
|---|---|---|
| P0 — Compile and boot | **Done** | Runs on the Simulator; shelf renders, import works, book opens. [F-011](#f-011--first-run-what-the-app-actually-does-on-a-phone) |
| P1 — Capability layer + routing | **Done** | Tapping a book opens it in-window; desktop-only surfaces are gated by [D-005](#d-005--capability-flags-not-platform-checks) flags |
| P2 — Mobile UI | **Items 1–2 done; 3 and 5 still blocked** | [D-011](#d-011--p2-waits-for-the-desktop-mastery-line-to-finish) blocked the phase on the desktop mastery line. That line is still at "design aligned, not implemented", so the file collision it predicted is not happening yet, and on 2026-08-06 the phase was split rather than held: item 1 (responsive foundation) and item 2 (the Home drawer) landed, because neither touches `Reader.tsx` or `ExplainPopover.tsx`. **Items 3 and 5 stay blocked** — those two files are the mastery line's core surface and D-011 still holds for them. Items 4, 6, 7, 8 are unblocked and unstarted. Five items now postdate the 18.5-day estimate: mobile AI settings ([D-012](#d-012--the-phone-gets-ai-contextual-glosses-not-ai-chat)), a book-downloading state ([D-013](#d-013--books-download-on-demand-not-eagerly)), and the three Tier-1 promotions from [§1](#1-goals-and-non-goals) — note editing, collection management and 书籍来源 (items 9–11). The phase is unscored against its new scope |
| P3 — Touch interaction | Not started | Same file collision as P2; follows it |
| P4 — iOS adaptation | **Done** | Rust-side, no frontend overlap — ran before P2. Item 1 was the PDF retention leak [Q-002](#q-002--does-the-reader-hold-acceptable-memory-on-a-real-device) surfaced, fixed and re-measured; item 2 the suspension gate in `src/lifecycle.rs`; item 3 backup exclusion in `src/backup.rs`. Item 4 shrank to nothing (the `keyring` it budgeted for was deleted in v2.6.0); the Cargo-table half moved out and is done. The one claim still owed to hardware is that the suspension gate prevents a real `0xdead10cc` kill — P6 |
| P5 — iCloud sync | **Item 1 done** | iOS ↔ macOS only. The `cfg` gates in `icloud.rs` and `sync/log.rs` are widened to `target_vendor = "apple"` and both targets compile clean. [Q-004](#q-004--macos-relocation-to-the-app-container-answered--there-is-nothing-to-relocate) closed at zero cost — no migration, because there are no users to migrate. Rust-side; runs before P2 |
| P6 — Ship | Not started | TestFlight only ([D-014](#d-014--first-ios-release-is-testflight-not-the-app-store)). The account-level notarization blocker cleared 2026-08-06; everything left is in-repo |

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
