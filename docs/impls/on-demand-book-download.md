# On-demand book download — backend

**Roadmap:** [P5 item 4](../roadmap/mobile-ios.md#p5--icloud-sync-1218-days),
[D-013](../roadmap/mobile-ios.md#d-013--books-download-on-demand-not-eagerly),
[D-016](../roadmap/mobile-ios.md#d-016--on-cellular-a-book-download-asks-once-and-remembers).

**Status:** backend built and green on host + `aarch64-apple-ios-sim`. Three things are still
owed and none of them is in this change: one line in `lib.rs` (§6), the frontend (§7), and a
device (§8).

---

## 1. What the problem actually is

`icloud.rs` already recognised an evicted book and already knew how to ask for it back.
`file_readability` returns `FileAvailability::ICloudPlaceholder`, and
`probe_book_availability` called `trigger_download_file` and moved on. That is a fire-and-forget
nudge: the reader saw "cannot open", and nothing ever told them the book was on its way.

Under [D-013](../roadmap/mobile-ios.md#d-013--books-download-on-demand-not-eagerly) that is not
an edge case on the phone — it is how *every* book opens the first time. So the missing piece
is not detection, it is **staying with the download**: watching one file, reporting where it has
got to, and letting the reader walk away from it.

---

## 2. What the resource keys actually give you

Verified against the crate on this machine, not from memory:
`~/.cargo/registry/src/index.crates.io-*/objc2-foundation-0.3.2/`, which is what
`objc2-foundation = "0.3"` in `src-tauri/Cargo.toml` resolves to.

Every ubiquitous key is exported behind **both** `NSString` and `NSURL` features
(`src/generated/mod.rs`), and both are already enabled in this repo's feature list, alongside
`NSValue` (which is what exports `NSNumber`) and `NSError`. No `Cargo.toml` change was needed.

```rust
// src/generated/mod.rs:4328
#[cfg(all(feature = "NSString", feature = "NSURL"))]
pub use self::__NSURL::NSURLUbiquitousItemPercentDownloadedKey;

// src/generated/NSURL.rs:801-803
#[cfg(feature = "NSString")]
#[deprecated = "Use NSMetadataUbiquitousItemPercentDownloadedKey instead"]
pub static NSURLUbiquitousItemPercentDownloadedKey: &'static NSURLResourceKey;

// src/generated/NSURL.rs:783-784 — not deprecated
#[cfg(feature = "NSString")]
pub static NSURLUbiquitousItemIsDownloadingKey: &'static NSURLResourceKey;

// src/generated/NSMetadataAttributes.rs:124-125 — the replacement Apple points at
#[cfg(feature = "NSString")]
pub static NSMetadataUbiquitousItemPercentDownloadedKey: &'static NSString;
```

Three findings drove the design:

1. **`NSURLUbiquitousItemPercentDownloadedKey` exists and is deprecated**, and its
   replacement is a *metadata-query attribute*, not a URL resource key. Reading the replacement
   means running an `NSMetadataQuery` over a directory and keeping it alive on a run loop —
   which is a different mechanism owned by [P5 item 3](icloud-metadata-watcher.md), not
   something a per-file probe can borrow. Lantern reads the deprecated key: it is free, it is
   exact when populated, and the alternative is no number at all.
2. **The percentage is frequently absent.** Apple documents it as maintained only while a
   metadata query is observing the item. So `percent` is `Option<f64>` all the way to the wire,
   and every consumer — including the progress bar — has to survive an entire download that
   never reports a number. This is a design constraint, not a bug to chase.
3. **The downloading *status* does not move during a download.**
   `NSURLUbiquitousItemDownloadingStatusKey` stays `NotDownloaded` until the last byte lands.
   "Is something happening right now" is a separate key, `…IsDownloadingKey`, an `NSNumber`
   boolean. Both matter, and conflating them would produce a watch that thinks nothing is
   happening for the whole transfer.

The accessor used is the per-key one, not the batch one:

```rust
// src/generated/NSURL.rs:1376-1386 (declared unsafe there)
#[cfg(all(feature = "NSError", feature = "NSString"))]
pub unsafe fn getResourceValue_forKey_error(
    &self,
    value: &mut Option<Retained<AnyObject>>,
    key: &NSURLResourceKey,
) -> Result<(), Retained<NSError>>;
```

`resourceValuesForKeys_error` would read all four keys in one call, but it is gated on
`NSArray` **and** `NSDictionary` on top of `NSError`/`NSString`. Neither is in this repo's
explicit feature list; they only arrive by feature unification from `tao`/`wry`, which is a
dependency of a dependency and not a thing to build on. The per-key call needs only features
this crate asks for by name, and it is what `is_awaiting_icloud_download` already uses.

**One more trap, handled:** `NSURL` caches resource values per instance the first time each key
is read. Reusing one `NSURL` across polls would report the first percentage forever, so
`download_snapshot` builds a fresh `NSURL` on every call.

---

## 3. What was built

### `src-tauri/src/icloud.rs`

```rust
pub struct DownloadSnapshot {
    pub downloading: bool,      // NSURLUbiquitousItemIsDownloadingKey
    pub percent: Option<f64>,   // NSURLUbiquitousItemPercentDownloadedKey (0–100)
    pub error: Option<String>,  // NSURLUbiquitousItemDownloadingErrorKey, localizedDescription
}

pub fn download_snapshot(path: &Path) -> DownloadSnapshot;   // stub returns default off Apple
```

The downloading *status* key is deliberately **not** re-read here. `is_awaiting_icloud_download`
already reads it and `file_readability` already acts on it; a second reading in a second struct
could only ever disagree with the first.

### `src-tauri/src/icloud/download.rs` (new)

Split into a decision half and an I/O half, because only the decision half can be tested
without an iCloud account.

- `DownloadWatch::observe(&PollReading, now_ms) -> WatchStep` — pure, no clock, no Foundation.
  Decides what to emit, when to re-ask iCloud, and when to stop.
- `poll_file(&Path) -> PollReading` — `file_readability` + `download_snapshot`.
- `start_watch(app, book_id, path, request_id)` — registers, asks iCloud once, spawns the loop.
- `register` / `cancel` / `finish` — a `tokio::sync::watch` registry keyed by request id.
- `cancel_book_download(request_id) -> bool` — the `#[tauri::command]`.

**Terminal condition is `file_readability(path) == Available`**, i.e. the same probe the
book-open path uses, not a percentage reaching 100. The watch and the reader can therefore never
disagree about when a download finished.

Behaviour worth knowing:

| Rule | Why |
| --- | --- |
| Progress is clamped monotonic | iCloud restarts a stalled transfer at zero; a bar running backwards reads as the book un-downloading itself |
| A percentage that vanishes keeps the last one | iCloud dropping the number mid-download is normal and does not mean progress was lost |
| Events only on ≥1 point of movement, or on the `downloading` flag flipping | a fast link reports fractional changes several times a second |
| The first poll always emits | otherwise a download that never reports a percentage — the common case — shows the reader nothing at all |
| Re-ask iCloud every 15 s while nothing is downloading | `startDownloadingUbiquitousItemAtURL:` is a request, not a command, and iOS drops in-flight requests when the app suspends. Re-asking is idempotent |
| The watch stops after 30 minutes | ends the *watch*, not the transfer; a task polling a file nobody waits on must not outlive the session |

### `src-tauri/src/commands/books/query.rs`

`diagnose_book_file` gained an optional `request_id`, and `probe_book_availability` gained a
sibling that takes it. With a request id an evicted book is watched to completion; without one
the old fire-and-forget nudge is unchanged, which is all a background caller can use.

The old signature is kept as a thin wrapper so the existing caller in
`commands/books/tests.rs` is untouched.

---

## 4. API surface added

**Command — start (already registered, rides the existing book-open path):**

```
diagnose_book_file({ id: string, requestId?: string }) -> BookAvailability
```

`BookAvailability` is unchanged (`{ status, available }`). Passing `requestId` is what turns the
diagnosis into a watched download.

**Command — cancel (registration owed, see §6):**

```
cancel_book_download({ requestId: string }) -> boolean   // false = no live watch
```

**Event channel:** `book-download-<requestId>`, per request, matching the AI streaming idiom
(`ai-translate-chunk-<id>`). Subscribe *before* invoking.

**Event payload:**

```jsonc
{
  "book_id": "…",
  "phase": "downloading" | "ready" | "cancelled" | "failed",
  "percent": 42.0,        // absent when iCloud reports no number — the common case
  "done": false,          // true on the last event, whatever the phase
  "error": "BOOK_DOWNLOAD_FAILED",   // absent unless phase is "failed"
  "detail": "The network connection was lost."  // iCloud's own localised message
}
```

Error codes: `BOOK_FILE_MISSING`, `BOOK_FILE_UNREADABLE`, `BOOK_DOWNLOAD_FAILED`,
`BOOK_DOWNLOAD_TIMED_OUT`. `BOOK_DOWNLOAD_ALREADY_RUNNING` comes back as a command error, not an
event, when a request id is reused while its watch is live.

---

## 5. Cancellation, honestly

**iCloud has no cancel API.** There is no counterpart to
`startDownloadingUbiquitousItemAtURL:`. `evictUbiquitousItemAtURL:` was considered and rejected:
it is for releasing a *complete* local copy, and pointing it at a half-downloaded item to force a
stop is undocumented behaviour on the reader's data.

So cancelling stops the *waiting*, not the *transfer*: the poll loop exits, a final
`{"phase":"cancelled","done":true}` event goes out, and iCloud keeps fetching at its own
discretion. This is the right outcome for the reader — it frees the UI immediately, and a reader
who gives up and comes back ten minutes later often finds the book already open-able. The
frontend copy must not promise the download stopped.

A cancel wakes the loop through `tokio::select!` rather than waiting out the poll interval, so
Stop feels like it did something.

---

## 6. Owed: one line in `lib.rs`

This change was not allowed to touch `lib.rs`. The start path needs nothing — it rides
`diagnose_book_file`, which is already registered — but the cancel command needs a line in
`generate_handler!`, beside `commands::books::diagnose_book_file` at `lib.rs:757`:

```rust
crate::icloud::download::cancel_book_download,
```

Until that lands, `cancel_book_download` carries an `#[allow(dead_code)]` naming this document.
**Remove the allow when adding the line.** Nothing else is owed in `lib.rs`.

---

## 7. Owed: the frontend

The backend emits; nothing renders yet. `src/hooks/useBooks.ts:182` currently invokes
`diagnose_book_file` with `{ id }` only.

1. Mint a `crypto.randomUUID()` per open attempt, `listen()` on `book-download-<id>`, **then**
   invoke `diagnose_book_file` with `{ id, requestId }`.
2. Render `phase: "downloading"` — determinate when `percent` is present, **indeterminate when
   it is absent**, which will be most of the time (§2.2). A design that only works with a
   number will look broken on a real phone.
3. On `phase: "ready"`, retry the open. On `"failed"`, show the code. On `"cancelled"`, return
   to the shelf.
4. A Stop affordance calling `cancel_book_download`, worded as giving up on waiting rather than
   as stopping the download (§5).
5. i18n keys for the four error codes, in both `en.json` and `zh.json`.

The reader-facing "downloading" state is [P2](../roadmap/mobile-ios.md#p2--mobile-ui-185-days)
work, per D-013's own note, and P2 is blocked.

---

## 8. Owed: a device

What the 26 new host tests cover: the whole decision half — first-emit, quiet polls, the 1-point
step, the `downloading` flag flipping, monotonic clamping, vanishing and out-of-band
percentages, all four terminal branches, the re-ask timer and its reset, the deadline, the
registry (claim once, reclaim after finish, cancel live, cancel finished, cancel unknown), the
serialised wire shape, and `poll_file` against a real temp file and a real `.icloud` placeholder.

What **cannot** be checked without an iCloud account on hardware, and must be on P6's list:

- Whether `NSURLUbiquitousItemPercentDownloadedKey` ever returns a number in this app's
  configuration, given no `NSMetadataQuery` is running. **If it never does, the feature still
  works** — the watch is driven by `file_readability`, not by the percentage — but the progress
  bar is indeterminate for every download, and the design should be confirmed against that.
  If [P5 item 3's](icloud-metadata-watcher.md) query ends up observing the books directory
  anyway, the number may start appearing for free.
- Whether `…IsDownloadingKey` is true for the whole transfer, which is what the 15-second
  re-ask timer assumes. If it flickers false mid-download, the re-ask fires harmlessly; if it
  is *always* false, the re-ask fires every 15 s for the whole download — still harmless, still
  worth knowing.
- Whether iOS suspension actually drops the download request (the reason the re-ask exists).
- Whether `…DownloadingErrorKey` is populated on a failure, or whether a failed download simply
  sits at `NotDownloaded` until the deadline.
- Real timing: whether 750 ms polling is visible in battery or CPU on a phone.

The simulator does not help with any of these — entitlements are stripped for simulator builds,
so there is no ubiquity container to put a placeholder in.

---

## 9. The seam for D-016 (cellular)

[D-016](../roadmap/mobile-ios.md#d-016--on-cellular-a-book-download-asks-once-and-remembers)
is **not implemented here**, deliberately: "ask once and remembers" needs a remembered answer,
which needs a mobile settings row, which is P2 and blocked.

**Where the check goes:** exactly one place —
`probe_book_availability_watched` in `query.rs`, in the arm that calls
`icloud::download::start_watch`, *before* that call. There is a comment there marking it. It has
to sit before `start_watch` and not inside it, because `start_watch` asks iCloud immediately;
once asked, the bytes are already moving and a prompt afterwards is theatre.

**What it needs:**

1. **A reachability read.** `SCNetworkReachability`'s
   `kSCNetworkReachabilityFlagsIsWWAN` is the documented way to tell cellular from Wi-Fi, and
   is `cfg(target_os = "ios")`. It is a new Foundation/SystemConfiguration call, so check the
   `objc2` crate list the same way §2 did before assuming a binding exists.
2. **A remembered answer**, in the `settings` table via `commands/settings.rs` — one key, e.g.
   `icloud_download_on_cellular`, tri-state (unset / allow / deny). Unset is what makes the
   first tap ask.
3. **A way to ask.** The prompt is frontend; the backend's part is returning a distinct
   refusal so the frontend knows to ask rather than to show an error. Suggested shape: a new
   `BookAvailability.status` value, or — since `BookAvailability` is shared with the two-second
   poll — a new error code `BOOK_DOWNLOAD_NEEDS_CELLULAR_CONSENT` from `diagnose_book_file`,
   which the frontend turns into the prompt and then re-invokes with the answer stored.
4. **A row to change the answer back**, in mobile settings (P2). D-016 names this explicitly:
   a remembered answer with no way to revisit it is a trap.

Wi-Fi is unaffected — the check short-circuits and the flow is exactly what ships today.

---

## 10. Acceptance run

From `src-tauri/`, all clean on 2026-08-06:

- `cargo clippy --all-targets -- -D warnings`
- `cargo clippy --target aarch64-apple-ios-sim -- -D warnings`
- `cargo test --lib` — whole suite green; 43 tests in the `icloud` tree, 26 of them new
- `rustfmt --edition 2021 --check` on `icloud.rs`, `icloud/download.rs`, `books/query.rs`
