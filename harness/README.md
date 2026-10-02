# Browser smoke harness

Runs the Lantern React frontend in plain Chrome against a fake Tauri backend, and
sweeps it for runtime errors — clicks every safe control on every route it can
reach and reports everything that threw.

It complements unit tests with rendered React routes, control clicks, and a
separate foreground EPUB layout check. Backend operations remain mocked; a
passing browser check does not validate the corresponding native workflow.

CI runs it on every push and PR — the `Browser smoke` job, via
`npm run smoke:ci` (`scripts/smoke-ci.mjs`). See [In CI](#in-ci) below for what
that gate does and does not fail on.

Nothing in `src/` knows the harness exists. No production file was modified for
it; the harness, its Vite configuration, driver, and tests are separate from
production code.

## Run it

```
npm run smoke                      # dev server on :1440, app boots with mocked Tauri
open http://localhost:1440/        # drive it by hand
open http://localhost:1440/?smoke=1  # run the automated sweep

npm run smoke:ci                   # what CI runs: boots the harness, sweeps, gates
npm run smoke:ci -- --reader-only  # foreground EPUB proof only
npm run smoke:ci -- --keep         # same, but leave the dev server up afterwards
```

The sweep writes its report to `window.__SMOKE__` and flips
`window.__SMOKE_DONE__` to `true` when it finishes. A driver should **poll the
boolean**, not await a promise: a fatal render makes the sweep reload the page
and resume in a fresh JS realm, where the old promise no longer exists.

```js
// in devtools, or from an automation driver
window.__SMOKE__
```

URL knobs, all optional and additive:

| Param | Effect |
| --- | --- |
| `?smoke=1` | run the route sweep instead of just booting |
| `?smoke=reader` | verify foreground EPUB body layout without sweeping controls |
| `?empty=1` | empty library — exercises the empty state |
| `?onboarding=1` | clear `onboarding_state` so onboarding shows |
| `?lang=zh` | boot in Chinese |
| `?platform=ios` | make the platform mock report iOS instead of macOS |

## In CI

`scripts/smoke-ci.mjs` is the driver: it boots `npm run smoke` (or reuses one
already on :1440), drives headless Chrome over the DevTools protocol with no
dependencies, polls `window.__SMOKE_DONE__`, and writes each report to
`dist/smoke-report-<layout>.json` — uploaded as the `smoke-report` artifact when
the job fails. `google-chrome` is preinstalled on the runner image; locally it
finds the macOS install, and `CHROME_BIN` overrides both.

**Each layout gets two independent passes:** a background route sweep and a
foreground EPUB layout check, at 1280×800 and 500×900. The narrow side of
`useIsNarrow`'s breakpoint (Tailwind `md:`, 768px) exposes different settings
routes and sheets. Foreground reports use `smoke-report-<layout>-reader.json`.

The window size is pinned, and the driver then asks the page which layout it
actually got and aborts on a mismatch. That check exists because the unpinned
default is platform-dependent and straddles the breakpoint — headless Chrome
gives 756px on macOS and 800px on the Linux runner, so the same commit swept
mobile locally and desktop in CI, both reporting `PASSED`, with nothing in the
output saying which.

**Only the route sweep is deliberately backgrounded.** The driver opens a
throwaway foreground tab for that pass. The separate reader pass keeps its
page visible and never relies on the hidden-tab ResizeObserver filter.

**What fails the build:** `error`, `unhandledrejection`, `click-threw`,
`resource`, `render-boundary`, and anything flagged `fatal`. Also a sweep that
visited no routes, or a foreground reader pass without verified body layout.

**What does not:** `console.warn`. It is printed and worth fixing, but a build
that goes red on a legitimate warning teaches people to route around this check.
`console.error` is likewise reported without failing — the app logs handled
errors through it on paths the mocked backend deliberately rejects.
Caught component crashes are collected separately as `render-boundary` through
the existing `log_webview_warning` diagnostic (`reader.diag`, `ui.boundary.*`).
This fails CI even when only a settings region or a silent boundary disappears
and the React root remains populated. Console text and component stacks are
not used to decide whether a boundary crashed.

The background pass reports `readerRendered` for diagnosis but does not gate
on it. The independent foreground pass **must** prove loaded EPUB content,
visible iframe and text rectangles intersecting the reader and viewport, and
two consecutive animation-frame samples with that evidence and the known
fixture paragraph text. Empty reader
chrome and offscreen cached content cannot satisfy this gate.

## What is here

```
vite.config.harness.ts     reuses the production Vite config, then aliases the
                           @tauri-apps/* packages to the mocks, injects
                           harness/entry.ts ahead of src/main.tsx, and serves
                           the real EPUB/PDF fixtures at /__harness/book.*
harness/entry.ts           installs collectors and the requested smoke pass
harness/reader-proof.ts    collects foreground EPUB text/layout evidence
harness/collectors.ts      window error / unhandledrejection / console wrappers
harness/smoke.ts           the sweep runner + the __SMOKE__ report contract
harness/state.ts           window.__HARNESS__ bookkeeping
harness/fixture-data.ts    the fake library, vocab, settings, chats…
harness/invoke-fixtures.ts per-command invoke responses
harness/shape-defaults.ts  fallback stubs guessed from the Rust return type
harness/tauri/*.ts         one mock per @tauri-apps package
harness/promo/*.ts         the README screenshot scenes (see below)
harness/books/             the twelve public-domain EPUBs the promo shots use
```

`harness/` is outside production `tsconfig.json`'s `include`; `npm run lint`
checks both `src/` and `harness/`. Focused tests cover the report gate and
reader-evidence predicates.

## How `invoke` answers

Three steps, in order:

1. **Deliberate rejection** — a short list (AI, speech, dictionary) that would
   need a live network. These reject with `harness: no AI backend`, which
   exercises the app's error paths on purpose. Recorded in
   `report.rejectedByHarness`, never counted as an app bug.
2. **Hand-written fixture** — `invoke-fixtures.ts`, for explicitly modeled
   rendering and interaction paths.
3. **Shape-guessed default stub** — for remaining commands. `vite.config.harness.ts`
   scrapes every `#[tauri::command]` signature out of `src-tauri/src` at server
   start and maps the Rust return type to a plausible JS empty
   value: `Vec<T>` → `[]`, `Option<T>` → `null`, `HashMap` → `{}`, `String` →
   `""`, integers → `0`, `bool` → `false`, a struct → `{}`. The command name is
   logged once as `[harness] unstubbed command: <name>` and lands in
   `report.unstubbed`. Each call also records its route and action in
   `report.coverageGaps` with `status: "not-covered"`. The driver prints these
   as **NOT COVERED**, even if no browser exception occurred.

**An unstubbed command is a coverage gap, not evidence of backend success.** The report keeps
the two apart, and every recorded error carries a `stubsInFlight` list: if it is
non-empty, suspect the harness first — most likely a component dereferenced a
field of a `{}` that the real backend would have filled in.

## Adding a fixture

Add an entry to `FIXTURES` in `harness/invoke-fixtures.ts`. A value can be a
constant or a function of the invoke args:

```ts
get_book: (args) => bookById(args.id),
list_highlights: () => HIGHLIGHTS.slice(),
sync_status: { enabled: false, lastSyncedAt: null },
```

Field names must match what the frontend reads, which is the **serde**
spelling, not the Rust one — most of these structs carry
`#[serde(rename_all = "camelCase")]`. Check the Rust struct before guessing.

Shared data (books, vocab, settings) lives in `harness/fixture-data.ts`; put
anything more than one command needs there.

Add a fixture when a command's `{}` crashes a component or leaves a screen the
sweep can't get past, after checking the real command protocol. Do not add
guessed fixtures just to remove entries from the coverage-gap list.

## The fixtures that exist and why

- **Four books.** An EPUB in progress with a resume CFI, a finished EPUB, a
  PDF that is `available: false` (the missing-file branch), and a plain-text
  book exercising the separate text reader.
- **Vocab across all mastery states** (0–4, two of them due) so the review and
  dashboard code paths have something to sort and bucket.
- **Settings deliberately mixed on and off**, because a settings screen where
  every toggle reads the same value only exercises one branch. Includes
  `onboarding_state: "done"` — without it the onboarding modal covers the
  library and the sweep never sees anything else.
- **Real EPUB and PDF bytes**, reused from `tests/fixtures/reader-compat/` and
  served by dev middleware at `/__harness/book.epub` and `/__harness/book.pdf`.
  The `convertFileSrc` mock maps any book path onto them, so the reader opens a
  genuine file through foliate-js rather than a stub.

## Promo shots (`?shot=<scene>`)

The README screenshots are taken from this harness, not from a real build and
not from an image model, so that **an effect the app cannot render cannot show
up in a promo image**. `scripts/shoot-readme.mjs` starts the harness, opens
`?shot=<scene>` per shot, waits for the page to declare itself ready, and
screenshots over CDP. The shot list, what each one has to prove, and the
delivery checklist live in [`docs/guide/screenshots.md`](../docs/guide/screenshots.md).

```
harness/promo/index.ts      one entry per scene: which settings to override,
                            which route to land on
harness/promo/scenes.ts     post-mount DOM work — click the sidebar, double-click
                            a word, expand a panel — then stamp data-shot-ready
harness/promo/library.ts    the twelve-book shelf (all US public domain)
harness/promo/content.ts    the AI text the fixtures hand back in shot mode
harness/promo/coverage*.ts  book-coverage numbers, computed not written
```

Four rules hold this together:

- **Everything is off unless `?shot=` is present.** `activeShotName()` is
  resolved once at module evaluation — not read live — because the app navigates
  after boot and React Router drops the query string; a live read would make the
  scene and fixture layers forget themselves mid-shot. `npm run smoke` is
  unaffected by any of this.
- **Scenes click, they do not inject.** Elements are found by the visible string
  in `src/i18n/zh.json` or by `aria-label`. **Nothing in `src/` knows the harness
  exists** — no `data-testid` goes in there. If a scene cannot reach a state by
  clicking, the app cannot either, and the shot is wrong, not the harness.
- **AI text is a fixture, but a structurally real one.** No API key exists here,
  so `invoke-fixtures.ts` supplies the card and chat payloads — in the shapes the
  app really renders (`LearningCardResult`, chat messages, citations), with
  sentences that genuinely occur in those twelve books.
- **Numbers are computed, never typed.** `scripts/promo-coverage.mjs` reads the
  same EPUBs, tokenizes and classifies the way the Rust side does, and writes
  `harness/promo/coverage.generated.ts`. Re-run it whenever the word-frequency
  table or the classification rules change on the Rust side.

## The reader, honestly

The EPUB open path uses real fixture bytes through `fetch` → `File` →
`view.open(file)`. Detection goes through `view.renderer.getContents()` because
the paginator uses a closed shadow root. A loaded `view.book` or reader toolbar
alone is insufficient: the foreground pass records `readerEvidence`, including
viewport size, document visibility, content-document count, visible text
rectangles, a body-text sample, and consecutive animation-frame samples.

A background pass can finish with `readerRendered: false`; its report does not
establish the cause or excuse a visible-reader failure. The foreground pass
must pass independently. This proves initial EPUB body layout in Blink, not
native WKWebView rendering or successful reading-position persistence.

## Report shape

```
window.__SMOKE__ = {
  mode: "route-sweep" | "reader-visible"
  coverageGaps: [{ command, route, action, status: "not-covered" }]
  readerEvidence?: { foreground, focused, bookLoaded, viewWidth, viewHeight,
                     contentDocuments, visibleTextRects, textSample, animationFrames }
  ok:        boolean            // no errors collected
  done:      boolean            // sweep finished
  visited:   string[]           // routes actually rendered, in order
  actions:   number             // clicks/toggles actually performed
  skipped:   [{ route, element, reason }]
  unstubbed: string[]           // default-stubbed commands — harness gap
  errors:    [{ route, element, kind, message, stack, stubsInFlight, fatal }]
  rejectedByHarness: string[]
  durationMs: number
  errorBoundary: string | null
  readerRendered: boolean
  notes: string[]
  restarts:  number
  unstubbedAll: string[]
}
```

`kind` is one of `error`, `unhandledrejection`, `console.error`, `console.warn`,
`resource`, `render-boundary`, `click-threw`. `fatal: true` means that error
emptied the React root.
`errorBoundary` holds the latest boundary diagnostic when one was collected.

## What it skips, and why

Controls whose accessible name matches
`delete|remove|clear|reset|uninstall|erase|wipe|revoke|forget|discard|log out|sign out|restore defaults`
or the Chinese equivalents are never clicked — a sweep that empties the library
halfway through produces a report about an empty library. Every skip is recorded
in `report.skipped` with the reason, so nothing goes missing silently.

External links (`http:`, `mailto:`, `tel:`, `target=_blank`) are not followed.
Native surfaces — file dialogs, `openUrl`, `relaunch`, `new WebviewWindow` — are
recorded on `window.__HARNESS__` instead of performed.

## Crash recovery

The app has boundaries around app, page, region and silent surfaces. Their
caught crashes fail CI without reloading the page. If an error escapes them
and empties `#root`, every later click lands on a blank page — which without
recovery looks exactly like "the sweep finished with one error".

So when the root empties, the sweep saves its progress to `sessionStorage`,
marks that control poisoned, reloads, and resumes where it left off. Up to 12
restarts. Each one is a `restart N: …` line in `report.notes`, and the error
that caused it is flagged `fatal: true`.

The restart reloads `/?smoke=1` (plus whatever knobs were set at boot) rather
than calling `location.reload()` — the sweep navigates with `pushState`, so by
then the query string is long gone and a plain reload would come back with the
sweep switched off.

## Hidden tabs

An automation driver usually leaves the page hidden, and Chrome then clamps
`setTimeout` to about 1Hz and stops `requestAnimationFrame` entirely. Both the
invoke mock and the sweep's waits therefore schedule through `MessageChannel`
(`harness/task.ts`), which is not throttled. Before that change the same sweep
took 10 seconds per click and looked wedged; after it, ~0.3s.

`window.__SMOKE_STEP__` (`{at, what}`) is the liveness probe: if it stops
advancing, the sweep is stuck rather than slow.

## What this harness structurally cannot catch

**It runs in Blink, not WebKit.** The shipped app renders in WKWebView on macOS
and iOS. Rendering, layout, scrolling, and the entire graphics stack are
different code. A crash that only happens in WebKit is invisible here — last
week's real `WebCore::ScrollingTree` SIGSEGV would have swept green. A clean
route-sweep report means "no gated browser exception in these Blink paths";
the separate reader report adds evidence of initial EPUB body layout. Neither
means "the native app does not crash".

Also out of scope, by construction:

- **The Rust backend.** Every `invoke` is fake. Command signature changes,
  serde shape drift, SQL, migrations, and real error strings are all unmodelled;
  the harness cannot tell you a fixture has gone stale against the real backend.
- **Reader gestures.** Initial EPUB body layout is checked in the foreground,
  but selection, highlights, pagination, and saved progress are not exercised
  by that proof.
- **Visual quality.** The reader gate checks initial text geometry, not
  readability, contrast, overflow, typography, or correctness of every page.
- **Timing and concurrency.** The mocked `invoke` resolves on the next tick, so
  real latency, races between slow commands, and cancellation are not exercised.
- **Native integration.** File dialogs, drag-and-drop of real files, updater,
  deep links, OS permissions, real iCloud propagation, or two-device sync.
  This browser harness does not launch a native app or isolate its data directory.
- **Anything reachable only through a destructive control**, and anything
  reachable only after a state change a skipped control would have made.
