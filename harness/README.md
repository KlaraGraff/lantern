# Browser smoke harness

Runs the Lantern React frontend in plain Chrome against a fake Tauri backend, and
sweeps it for runtime errors — clicks every safe control on every route it can
reach and reports everything that threw.

It exists to close one specific gap: the ~800 frontend unit tests are all
pure-function tests. Nothing in the suite renders a component or clicks
anything, so "click this and it throws" is invisible to CI. This catches that
class, and only that class.

Nothing in `src/` knows the harness exists. No production file was modified for
it; the only change outside `harness/` and `vite.config.harness.ts` is one added
npm script.

## Run it

```
npm run smoke                      # dev server on :1440, app boots with mocked Tauri
open http://localhost:1440/        # drive it by hand
open http://localhost:1440/?smoke=1  # run the automated sweep
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
| `?smoke=1` | run the sweep instead of just booting |
| `?empty=1` | empty library — exercises the empty state |
| `?onboarding=1` | clear `onboarding_state` so onboarding shows |
| `?lang=zh` | boot in Chinese |
| `?platform=ios` | make the platform mock report iOS instead of macOS |

## What is here

```
vite.config.harness.ts     reuses the production Vite config, then aliases the
                           @tauri-apps/* packages to the mocks, injects
                           harness/entry.ts ahead of src/main.tsx, and serves
                           the real EPUB/PDF fixtures at /__harness/book.*
harness/entry.ts           installs collectors, then (on ?smoke=1) the sweep
harness/collectors.ts      window error / unhandledrejection / console wrappers
harness/smoke.ts           the sweep runner + the __SMOKE__ report contract
harness/state.ts           window.__HARNESS__ bookkeeping
harness/fixture-data.ts    the fake library, vocab, settings, chats…
harness/invoke-fixtures.ts per-command invoke responses
harness/shape-defaults.ts  fallback stubs guessed from the Rust return type
harness/tauri/*.ts         one mock per @tauri-apps package
```

`harness/` is outside `tsconfig.json`'s `include` and outside `npm run lint`'s
`src/` scope, so it never affects production typechecking or linting.

## How `invoke` answers

Three steps, in order:

1. **Deliberate rejection** — a short list (AI, speech, dictionary) that would
   need a live network. These reject with `harness: no AI backend`, which
   exercises the app's error paths on purpose. Recorded in
   `report.rejectedByHarness`, never counted as an app bug.
2. **Hand-written fixture** — `invoke-fixtures.ts`, ~45 commands. Only the ones
   that actually gate rendering got one.
3. **Shape-guessed default stub** — for the other ~170. `vite.config.harness.ts`
   scrapes every `#[tauri::command]` signature out of `src-tauri/src` at server
   start (217 found) and maps the Rust return type to a plausible JS empty
   value: `Vec<T>` → `[]`, `Option<T>` → `null`, `HashMap` → `{}`, `String` →
   `""`, integers → `0`, `bool` → `false`, a struct → `{}`. The command name is
   logged once as `[harness] unstubbed command: <name>` and lands in
   `report.unstubbed`.

**An unstubbed command is a harness gap, never an app bug.** The report keeps
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
sweep can't get past. Do not backfill fixtures for all 217 commands — the
default stub is the point.

## The fixtures that exist and why

- **Three books.** An EPUB in progress (37%, with a CFI, so the reader resumes
  mid-book), a finished EPUB (100%, the finished-state branch), and a PDF that
  is `available: false` (the missing-file branch, which otherwise never renders).
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

## The reader, honestly

The whole open path is real and it works: `fetch` → `File` → `view.open(file)`,
and the reader's own diagnostics run clean through `reader.open.ready`. The
reader chrome (title, chapter count, toolbar, progress) renders.

**But the book itself only paints in a visible window.** foliate's paginator
lays out from a `ResizeObserver` plus `requestAnimationFrame`, and browsers run
neither for a hidden document — which is exactly what a background automation
tab is. Run the sweep with the window on screen if you want the reader covered;
otherwise `readerRendered` stays `false` and the report says why, in
`notes`. It is not faked, and a false there is not an app bug.

Detection goes through `view.renderer.getContents()`, not the DOM: the paginator
attaches its shadow root with `mode: "closed"`, so its iframe cannot be reached
by any selector.

## Report shape

```
window.__SMOKE__ = {
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
`resource`, `click-threw`. `fatal: true` means that error emptied the React root.

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

The app has **no React error boundary anywhere in `src/`**. One throwing
component empties `#root`, and every later click lands on a blank page — which
without recovery looks exactly like "the sweep finished with one error".

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
report means "no JS exception in Blink", never "the app doesn't crash".

Also out of scope, by construction:

- **The Rust backend.** Every `invoke` is fake. Command signature changes,
  serde shape drift, SQL, migrations, and real error strings are all unmodelled;
  the harness cannot tell you a fixture has gone stale against the real backend.
- **Anything inside the foliate iframe.** The sweep detects whether the book
  painted, but does not click inside the reader's iframe document — selection,
  highlight gestures, and pagination inside the book are untested here. In a
  hidden window the book does not paint at all (see above).
- **Visual bugs.** No layout, contrast, overflow, or animation checking. A
  screen that renders unreadably still passes.
- **Timing and concurrency.** The mocked `invoke` resolves on the next tick, so
  real latency, races between slow commands, and cancellation are not exercised.
- **Native integration.** File dialogs, drag-and-drop of real files, updater,
  deep links, OS permissions.
- **Anything reachable only through a destructive control**, and anything
  reachable only after a state change a skipped control would have made.
