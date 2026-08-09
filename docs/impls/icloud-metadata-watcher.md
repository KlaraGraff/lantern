# Replacing the `notify` watcher with `NSMetadataQuery`

Implementation design for **P5 item 3** of `docs/roadmap/mobile-ios.md` — "Replace the
`notify` watcher with `NSMetadataQuery`; kqueue does not observe iCloud-initiated downloads".

Nothing here is built yet. This document is the plan, and it is written against the code as it
stands on `main` today, not against what the roadmap says the code will look like.

---

## 1. What is actually broken

`src-tauri/src/sync/watcher.rs` registers a `notify::recommended_watcher` on four directories
under the sync root. On Apple platforms `notify` resolves to FSEvents (macOS) / kqueue, and
both observe the *local* filesystem.

That is the wrong vantage point for a directory whose contents are written by another device.
When a peer appends to `logs/peer-A.jsonl`, the local machine does not receive a write. What it
receives — eventually, and only if the ubiquity daemon decides to materialise anything at all —
is one of:

- nothing, until something else makes the OS care about that directory;
- a `.peer-A.jsonl.icloud` placeholder appearing, which is a real local write and *does* fire
  FSEvents, but only tells us a name exists;
- the real file appearing later, after a download that nothing in Lantern asked for.

The current `is_relevant_event` already has an `.icloud` arm and a comment explaining that a
placeholder appearing should provoke a tick so the engine can trigger the download. That arm is
the whole of Lantern's iCloud-awareness today, and it is a workaround for watching at the wrong
layer: it depends on iCloud choosing to drop a placeholder, at a moment nobody controls.

Apple's answer is `NSMetadataQuery` over `NSMetadataQueryUbiquitousDocumentsScope`. It is served
by the ubiquity daemon rather than by the filesystem, so it reports items the local disk does
not have yet, and it carries per-item download state
(`NSMetadataUbiquitousItemDownloadingStatusKey`, `NSMetadataUbiquitousItemIsDownloadingKey`,
`NSMetadataUbiquitousItemPercentDownloadedKey`). It is also the only mechanism of the two that
exists meaningfully on iOS, which is why this is a P5 item and not desktop polish.

---

## 2. The watcher as it stands

### 2.1 Public API surface

One function and one type. That is the entire contract:

```rust
pub fn spawn(shared_dir: PathBuf, db: Db, engine: Arc<ReplayEngine>) -> AppResult<WatcherHandle>

pub struct WatcherHandle { /* private */ }
impl WatcherHandle {
    pub fn request_stop(&self);
    #[cfg(test)] pub(crate) fn drain_for_test(&self, timeout: Duration);
}
impl Drop for WatcherHandle { /* sets stop, joins the thread */ }
```

`WatcherHandle`'s three private fields are `stop: Arc<AtomicBool>`, `join: Option<JoinHandle<()>>`
and `_watcher: Box<dyn Watcher + Send>` — the last held purely so its `Drop` detaches the
FSEvents stream.

Two properties of the type are load-bearing and easy to break:

- It is `Send + Sync`, because `commands::sync::SyncState` stores it as
  `Mutex<Option<WatcherHandle>>` in Tauri managed state.
- Its `Drop` is the only shutdown path. `sync_disable` and the "sync was turned off during boot"
  branch in `lib.rs::boot_sync_engine` both just drop it.

### 2.2 Callers

Exactly two, and both hold an `AppHandle` already:

| Site | Line | Shape |
|---|---|---|
| `src-tauri/src/lib.rs::boot_sync_engine` | 307 | `sync::watcher::spawn(shared_dir, db.clone(), Arc::clone(&engine))?` |
| `src-tauri/src/commands/sync.rs::sync_enable` | 319–320 | `watcher::spawn(icloud_dir.clone(), db.inner().clone(), Arc::clone(&engine))?` |

`src-tauri/src/sync/mod.rs` only declares `pub mod watcher;` and carries a module-wide
`#![allow(dead_code)]`. Nothing else in the tree names the watcher except log lines.

In `sync_enable` the spawn sits deliberately inside "Phase 1: fallible preparation with no
durable state writes", described in its own comment as "the most likely failure point". Whatever
replaces it must keep failing *there*, before any durable write, rather than failing later or
failing silently.

### 2.3 Debounce

A single dedicated `std::thread` named `sync-watcher` owns the `mpsc::Receiver`:

- outer loop blocks on `recv_timeout(250 ms)` so the `stop` flag stays responsive on a quiet
  directory;
- the first event is filtered by `is_relevant_event`; irrelevant events `continue` without
  starting a batch;
- a `DEBOUNCE` of 250 ms is measured from the **first** event of the batch, and further events
  are drained and discarded until that deadline;
- then one `engine.tick(&db)` runs, wrapped in `crate::lifecycle::gate().permit()` so an iOS
  suspension parks the worker rather than freezing it mid-SQL.

The header comment states the intent: bursty peer writes produce roughly four ticks a second,
not one tick per write.

### 2.4 Event filtering

```rust
fn is_relevant_event(ev: &notify::Event) -> bool
```

`true` if any path in the event has extension `jsonl`, `json`, `img`, `pdf`, `ttf`, `otf`,
`woff`, `woff2` or `icloud` (ASCII-case-insensitive), or if its file name ends with
`.snapshot.json`. There is **no directory check** — the filter trusts that the only paths it can
ever see came from the four registered watches.

### 2.5 Existing tests

Six, in `mod tests` at the bottom of the file:

| Test | What it pins |
|---|---|
| `watcher_picks_up_peer_log_writes` | end-to-end through real `notify`; a `logs/*.jsonl` write reaches the DB |
| `watcher_handles_burst_and_converges` | ten rapid writes converge to ten rows |
| `dropping_handle_stops_thread_cleanly` | `Drop` joins without hanging |
| `is_relevant_event_filters_irrelevant_paths` | the extension table, including `.icloud` placeholders |
| `watcher_picks_up_cover_writes` | a cover landing with no `logs/` event still ingests |
| `spawn_creates_logs_dir_if_missing` | `spawn` creates its own directories |

Every one of them runs against a `tempfile::TempDir`. **None of those directories is ubiquitous**,
which is the single most important fact for the design below: a metadata query would return
nothing for any of them, so a straight swap deletes the only automated coverage the watcher has.

---

## 3. What `objc2-foundation` actually gives us

`src-tauri/Cargo.toml` line 110, under `[target.'cfg(target_vendor = "apple")'.dependencies]`:

```toml
objc2-foundation = { version = "0.3", features = ["NSFileManager", "NSFileCoordinator",
  "NSString", "NSURL", "NSError", "NSNotification", "NSOperation", "NSValue", "block2"] }
```

`Cargo.lock` resolves that to **0.3.2**, vendored at
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/objc2-foundation-0.3.2/`.

### 3.1 It is all there

`NSMetadataQuery` is present, generated, and complete. From
`objc2-foundation-0.3.2/src/generated/NSMetadata.rs`:

```rust
extern_class!(
    #[unsafe(super(NSObject))]
    #[derive(Debug, PartialEq, Eq, Hash)]
    pub struct NSMetadataQuery;
);

impl NSMetadataQuery {
    extern_methods!(
        #[cfg(feature = "NSPredicate")]
        pub fn setPredicate(&self, predicate: Option<&NSPredicate>);
        #[cfg(feature = "NSDate")]
        pub fn setNotificationBatchingInterval(&self, notification_batching_interval: NSTimeInterval);
        #[cfg(feature = "NSArray")]
        pub unsafe fn setSearchScopes(&self, search_scopes: &NSArray);
        #[cfg(feature = "NSOperation")]
        pub unsafe fn setOperationQueue(&self, operation_queue: Option<&NSOperationQueue>);
        pub fn startQuery(&self) -> bool;
        pub fn stopQuery(&self);
        pub fn isGathering(&self) -> bool;
        pub fn disableUpdates(&self);
        pub fn enableUpdates(&self);
        // ...
    );
}
```

and `NSMetadataItem`:

```rust
impl NSMetadataItem {
    extern_methods!(
        #[cfg(feature = "NSString")]
        pub fn valueForAttribute(&self, key: &NSString) -> Option<Retained<AnyObject>>;
    );
}
```

The notification names and every scope and attribute key this design needs are declared as
`extern "C"` statics:

```rust
#[cfg(all(feature = "NSNotification", feature = "NSString"))]
pub static NSMetadataQueryDidFinishGatheringNotification: &'static NSNotificationName;
#[cfg(all(feature = "NSNotification", feature = "NSString"))]
pub static NSMetadataQueryDidUpdateNotification: &'static NSNotificationName;
#[cfg(feature = "NSString")]
pub static NSMetadataQueryUpdateAddedItemsKey: &'static NSString;
#[cfg(feature = "NSString")]
pub static NSMetadataQueryUpdateChangedItemsKey: &'static NSString;
#[cfg(feature = "NSString")]
pub static NSMetadataQueryUpdateRemovedItemsKey: &'static NSString;
#[cfg(feature = "NSString")]
pub static NSMetadataQueryUbiquitousDocumentsScope: &'static NSString;
```

and from `objc2-foundation-0.3.2/src/generated/NSMetadataAttributes.rs`, all `#[cfg(feature = "NSString")]`:

```rust
pub static NSMetadataItemURLKey: &'static NSString;
pub static NSMetadataItemFSNameKey: &'static NSString;
pub static NSMetadataUbiquitousItemDownloadingStatusKey: &'static NSString;
pub static NSMetadataUbiquitousItemDownloadingStatusNotDownloaded: &'static NSString;
pub static NSMetadataUbiquitousItemDownloadingStatusDownloaded: &'static NSString;
pub static NSMetadataUbiquitousItemDownloadingStatusCurrent: &'static NSString;
pub static NSMetadataUbiquitousItemIsDownloadingKey: &'static NSString;
pub static NSMetadataUbiquitousItemPercentDownloadedKey: &'static NSString;
```

So: **no `msg_send!`, no Objective-C shim, no vendored header.** The whole surface is safe(ish)
generated Rust.

### 3.2 The gate is Cargo features, not the version

`objc2-foundation`'s `Cargo.toml` declares `NSMetadata = []` and `NSMetadataAttributes = []` as
plain opt-in features (lines 140–141), and neither is on by default. Every method above is
additionally gated on the feature for its *argument* type. The features Lantern is missing:

| Feature | Needed for |
|---|---|
| `NSMetadata` | `NSMetadataQuery`, `NSMetadataItem`, the notification names, the scope constants |
| `NSMetadataAttributes` | `NSMetadataItemURLKey` and the `NSMetadataUbiquitousItem*` keys |
| `NSArray` | `setSearchScopes`, and reading the added/changed item arrays out of `userInfo` |
| `NSDictionary` | `NSNotification::userInfo` |
| `NSPredicate` | `setPredicate` — a query with a nil predicate refuses to start |
| `NSDate` | `setNotificationBatchingInterval` (it takes `NSTimeInterval`), and `NSDate` for the run-loop deadline |
| `NSRunLoop` | `NSRunLoop::currentRunLoop`, `runMode_beforeDate`, `NSDefaultRunLoopMode` |

`NSNumber` (for percent-downloaded) lives in `objc2-foundation-0.3.2/src/generated/NSValue.rs`, so the already-enabled
`NSValue` covers it. `NSOperation`, `NSNotification`, `NSString`, `NSURL` and `block2` are all
already on.

### 3.3 Verified, not assumed

A throwaway crate depending on `objc2-foundation 0.3.2` with exactly the feature list above was
compiled against the real API: query construction, `setSearchScopes` with an `NSArray` of the
scope constant, `NSPredicate::predicateWithFormat_argumentArray`, `setNotificationBatchingInterval`,
`setOperationQueue`, `addObserverForName_object_queue_usingBlock` with an `RcBlock`, downcasting
`userInfo` values to `NSArray`/`NSMetadataItem`, reading `NSMetadataItemURLKey` back to a
`PathBuf`, comparing the downloading-status string, reading percent-downloaded as `NSNumber`,
`startQuery`/`stopQuery`, and `NSRunLoop::runMode_beforeDate`.

It compiles clean for both the host (`aarch64-apple-darwin`) and `aarch64-apple-ios-sim`. The
only two errors the first pass produced were mine, not the crate's: `removeObserver` takes
`&AnyObject` and the observer token is a `Retained<ProtocolObject<dyn NSObjectProtocol>>`, so it
needs `ProtocolObject::as_ref(&*token)`.

Two signatures worth writing down because they shape the code:

```rust
// NSNotificationCenter
#[cfg(all(feature = "NSOperation", feature = "NSString", feature = "block2"))]
pub unsafe fn addObserverForName_object_queue_usingBlock(
    &self,
    name: Option<&NSNotificationName>,
    obj: Option<&AnyObject>,
    queue: Option<&NSOperationQueue>,
    block: &block2::DynBlock<dyn Fn(NonNull<NSNotification>)>,
) -> Retained<ProtocolObject<dyn NSObjectProtocol>>;

// NSPredicate — the variadic predicateWithFormat: is not exposed; this is the usable form
#[cfg(all(feature = "NSArray", feature = "NSString"))]
pub unsafe fn predicateWithFormat_argumentArray(
    predicate_format: &NSString,
    arguments: Option<&NSArray>,
) -> Retained<NSPredicate>;
```

`predicateWithValue(true)` also exists and is tempting, but the documented idiom for a
match-everything metadata query is `%K LIKE %@` against `NSMetadataItemFSNameKey` with `"*"`, and
that is what the probe used. Keep the documented one — a query that silently gathers nothing is
indistinguishable from a query that works and has nothing to report.

### 3.4 The house style this has to match

`src-tauri/src/lifecycle.rs:173-245` already does exactly this dance for UIKit's suspension notifications:
`NSNotificationCenter::defaultCenter()`, a `block2::RcBlock` taking
`NonNull<objc2_foundation::NSNotification>`, `addObserverForName_object_queue_usingBlock` inside
one `unsafe` block, and `std::mem::forget` on the tokens with a comment saying it is a deliberate
per-process leak. Its comment also records *why* the queue argument is `None` — the block must run
synchronously on the posting thread. The new module follows that shape, including keeping the
`unsafe` blocks narrow and giving each one a reason.

`src-tauri/src/icloud.rs` is the second reference: `#[cfg(target_vendor = "apple")]` on the real body,
`#[cfg(not(target_vendor = "apple"))]` on a stub with the same signature, immediately below it.

---

## 4. Design

### 4.1 Replacement, with a narrow and justified fallback

On Apple platforms, when the sync root is the app's own ubiquity `Documents` directory, the
metadata query **replaces** `notify` outright. There is no second FSEvents watcher running
alongside it, because there is nothing for one to add: the query reports items in that scope
regardless of who wrote them — this device or a peer — so local writes are covered too.

`notify` survives for exactly one case, and it is not a hedge:

> `NSMetadataQueryUbiquitousDocumentsScope` covers one directory and one only — `Documents`
> inside this app's ubiquity container. A sync root anywhere else is invisible to it, and a
> query over such a root does not fail, it just never reports anything.

Three real roots are "anywhere else" today:

1. **Every existing test.** All six watcher tests use a `TempDir`. Dropping `notify` deletes
   them.
2. **macOS, right now.** `sync/migration.rs` still resolves the desktop root through
   `icloud_drive_root()` → `~/Library/Mobile Documents/com~apple~CloudDocs/…`, a *user-picked*
   folder that is not this app's container. Only `ubiquity_sync_root()` — `#[cfg(target_os = "ios")]`
   — points at the container. P5 item 2 and [D-015](../roadmap/mobile-ios.md) move macOS over;
   until that lands, macOS must keep working.
3. **iOS with no container.** `ubiquity_container_dir()` returns `None` on a device with iCloud
   Drive off or no account — the doc comment on it already calls that "an ordinary answer, not an
   error". Sync then falls back to a local directory, and a metadata query over it is pointless.

So the selection is by *root*, decided once inside `spawn`, and it is not user-visible:

```rust
enum Source {
    /// FSEvents / kqueue. Correct for any root the ubiquity daemon does not
    /// own — the test temp dirs, and macOS until P5 item 2 relocates the
    /// desktop root into the container (D-015).
    Notify(Box<dyn Watcher + Send>),
    /// The ubiquity daemon's own view. `Retained<NSMetadataQuery>` is not
    /// `Send`, so the query itself cannot be stored here; the thread that owns
    /// it is, and stopping it is a flag flip that thread observes.
    #[cfg(target_vendor = "apple")]
    Metadata(Option<JoinHandle<()>>),
}
```

### 4.2 Same outward API — no call site changes

`spawn`'s signature and `WatcherHandle`'s public surface are unchanged. `WatcherHandle` gains
the `Source` in place of `_watcher: Box<dyn Watcher + Send>` and stays `Send + Sync`, because
the metadata variant holds only a `JoinHandle`. Both call sites — `lib.rs:307` and
`commands/sync.rs:319` — compile untouched.

The failure contract is preserved. `spawn` returns `Err` if the query cannot be constructed or
`startQuery()` returns `false`, so `sync_enable`'s Phase 1 still fails before any durable write.
`startQuery` returning `false` must be an error and not a warning — it is the one signal that
distinguishes "no peers have written yet" from "this query will never fire".

### 4.3 The run loop — where the query actually lives

This is the part that decides whether the whole thing works.

`NSMetadataQuery` drives its gathering from run-loop sources installed on the thread that calls
`startQuery`. A thread with no running run loop starts the query and then never hears from it
again. There are two candidate threads in a Tauri app and one of them is wrong:

**Not the main thread.** Tauri's main thread runs the `NSApplication` / `UIApplication` run loop,
so it satisfies the requirement — but reaching it means `AppHandle::run_on_main_thread`, which
means `spawn` grows an `AppHandle` parameter, which means the two call sites change, which means
the construction becomes asynchronous and `startQuery`'s boolean can no longer be returned from
`spawn` at all. That last consequence is the disqualifying one: it would move the "most likely
failure point" out of `sync_enable`'s Phase 1, which the surrounding comment says must not
happen. It is also gratuitous: nothing about a metadata query needs the UI thread, and putting
Foundation notification blocks on the thread that draws the reader is a latency risk for no gain.

**Its own thread, with its own run loop.** `spawn` starts a second dedicated thread,
`sync-metadata-query`, which owns the query for its whole life:

```
sync-metadata-query thread          mpsc channel          sync-watcher thread
─────────────────────────────       ────────────          ───────────────────
create NSMetadataQuery
set scope / predicate / batching
register 1 observer block  ─┐
startQuery()                │
loop until stop flag:       │
  autoreleasepool {         │
    runMode_beforeDate(     │
      NSDefaultRunLoopMode, │
      now + 250 ms)         │
  }                         │
                            └─ block fires here, on this
                               same thread, from inside
                               runMode_beforeDate
                                      │
                               tx.send(PathBuf) ──────────▶ recv_timeout(250 ms)
                                                            debounce-drain 250 ms
stop flag set by Drop:                                      lifecycle permit
  stopQuery()                                               engine.tick(&db)
  drop observer token
  drop tx  ────────────────────────────────────────────────▶ Disconnected → return
```

Five things this shape buys, each of which was the reason not to pick something else:

1. **`spawn`'s signature does not change.** No `AppHandle`, no async construction, no call-site
   edits.
2. **The debounce and tick loop are untouched.** `run_loop` in `watcher.rs` keeps its
   `mpsc::Receiver`, its 250 ms `DEBOUNCE`, its `lifecycle::gate().permit()` and its
   `Disconnected → return` shutdown. The channel is the seam; only the thing feeding it changes.
   The channel item type widens from `notify::Event` to a small internal `Wake(PathBuf)` so both
   sources can feed it.
3. **The query never crosses a thread boundary.** `Retained<NSMetadataQuery>` and
   `Retained<NSMetadataItem>` are not `Send`, and with a `None` notification queue the block runs
   on the posting thread — which for a query started here *is* this thread. Ownership is single-
   threaded end to end and there is no `unsafe impl Send` anywhere.
4. **`runMode_beforeDate` with a 250 ms deadline, not `NSRunLoop::run()`.** `run()` never
   returns, so a handle drop could not stop it. The bounded pump is the same idiom the existing
   worker already uses for the same reason: `recv_timeout(250 ms)` so the stop flag stays
   responsive on a quiet directory. Shutdown latency is therefore ≤250 ms, matching today's.
5. **One `autoreleasepool` per pump iteration.** A long-lived secondary thread running a run loop
   has no implicit pool draining around it, and Foundation autoreleases plenty per notification.
   Wrapping each `runMode_beforeDate` in `objc2::rc::autoreleasepool` bounds the high-water mark
   to one batch.

The notification block does no work beyond extracting paths, filtering them and calling
`tx.send`. It deliberately does **not** take a `lifecycle::gate()` permit: the permit belongs
around the tick, and the tick worker already takes it. Parking a Foundation notification block
during an iOS suspension would block the run loop of a thread the OS is trying to freeze — the
exact failure `lifecycle.rs` exists to avoid.

**If it turns out the query will not deliver on a secondary run loop** — see §7, risk 1 — the
fallback is `AppHandle::run_on_main_thread` and the cost is spelled out there.

### 4.4 What the query is configured with

- **Scope**: `NSArray::from_slice(&[NSMetadataQueryUbiquitousDocumentsScope as &AnyObject])`.
  One scope, matching `ubiquity_sync_root()` exactly — `<container>/Documents` is both the sync
  root and the whole of what the scope covers. No `NSURL` scopes: they route through Spotlight on
  macOS and do not exist usefully on iOS, and once P5 item 2 lands the container scope is exactly
  right on both platforms.
- **Predicate**: `%K LIKE %@` with `[NSMetadataItemFSNameKey, "*"]`. Filtering by name in the
  predicate is tempting and wrong — the interesting filter is by *directory*, which the predicate
  language cannot express against `kMDItemFSName`, and doing it in Rust keeps the filter unit-
  testable off-device.
- **Batching**: `setNotificationBatchingInterval(0.25)`, matching `DEBOUNCE`. Two coalescing
  stages look redundant and are not: the query's interval coalesces at the source, before the
  block ever runs, and our debounce coalesces across a batch boundary. Worst-case added latency
  is one batching interval.
- **Operation queue**: left `None`, so notifications post on this thread's run loop. Same
  reasoning as `lifecycle.rs`, recorded there in the same terms.
- **Notifications observed**: `NSMetadataQueryDidUpdateNotification` only, reading
  `NSMetadataQueryUpdateAddedItemsKey` and `NSMetadataQueryUpdateChangedItemsKey` out of
  `userInfo`. `NSMetadataQueryUpdateRemovedItemsKey` is ignored: nothing in the sync protocol
  deletes a peer's log, and a removal cannot make the local DB more converged.
- **`DidFinishGathering` is deliberately not a tick.** The initial gather returns the entire
  `Documents` tree, and turning that into a tick would fire one full replay at every boot on top
  of the one the launch flow already runs — `spawn`'s own doc comment records that "the launch
  flow runs an explicit initial tick before spawning the watcher". Observe it to log the result
  count, because that count is the cheapest evidence on a device that the query is alive at all,
  and do nothing else with it.

### 4.5 Filtering, and the two things that change

`is_relevant_event` becomes a thin wrapper over a new path-level predicate:

```rust
/// True if this path is one the replay engine actually consumes. Split out of
/// `is_relevant_event` because the metadata query reports paths, not fs events,
/// and because a directory check is now load-bearing: the query's scope is the
/// whole ubiquity `Documents` tree, not four registered watches.
fn is_relevant_path(shared_dir: &Path, path: &Path) -> bool
```

Two behaviours differ from the `notify` path, and both are consequences of watching a different
layer:

- **Directory membership must now be checked.** `notify` only ever handed us paths from the four
  directories it was told to watch. The query hands us everything under `Documents`, including
  `devices/` and `sources/`, which no tick consumes. `is_relevant_path` keeps only direct
  children of `logs/`, `covers/`, `books/` and `imported-fonts/`.
- **The `.icloud` arm is dead on this path.** `NSMetadataItemURLKey` yields the *logical* item —
  `logs/peer-A.jsonl` — whether or not its bytes are local. There is no `.peer-A.jsonl.icloud`
  to match. The arm stays for the `notify` source, where it is still how a placeholder announces
  itself.

Path comparison must canonicalise both sides. `NSMetadataItemURLKey` returns a resolved path, and
on macOS that means `/private/var/...` where `std::env::temp_dir()` and friends say `/var/...`.
Comparing the two raw is a prefix check that silently never matches — which, again, looks exactly
like "no peer has written yet".

### 4.6 Download status is read, but nothing new is downloaded

`NSMetadataUbiquitousItemDownloadingStatusKey` is read for one purpose: log lines and the
future progress surface. It does **not** gate the tick. An item reported as
`…StatusNotDownloaded` still wakes the engine, because the engine's existing paths already call
`icloud::trigger_download_file` where a download is wanted — `sync/log.rs:239`,
`sync/snapshot/compact.rs:75`, `commands/sync.rs:919,969`.

Triggering downloads from inside the watcher would be a behaviour change, not a mechanism
change, and it would be the wrong one: [D-013](../roadmap/mobile-ios.md) says books download on
demand, and the query reports every book placeholder in the container. A watcher that downloaded
what it saw would pull the user's entire library onto their phone the first time it started.
Acting on download state is P5 item 4's job and belongs in its own change.

Percent-downloaded and `NSMetadataUbiquitousItemIsDownloadingKey` are read and logged at `debug`
in this change and otherwise unused. They are what item 4 will need, and reading them now is how
we find out on device whether they arrive at all.

### 4.7 Non-Apple platforms

Nothing changes. `Source::Metadata` is `#[cfg(target_vendor = "apple")]`, the backend selector is
a `#[cfg(not(target_vendor = "apple"))]` stub returning `false` next to its real half — the
pattern `icloud.rs` uses nine times — and the whole `sync/metadata.rs` module is gated. Windows
and Linux compile the same `notify` path they compile today, with one extra always-false branch.

Per [D-007](../roadmap/mobile-ios.md) Windows sync is out of scope regardless; this is about
keeping the build green, not about behaviour.

---

## 5. File-by-file plan

Ordered so `cargo check` and `cargo test` pass after every step. `cargo` runs from
`src-tauri/`; check both `--target aarch64-apple-darwin` and `--target aarch64-apple-ios-sim`
at each step, as P5 item 1 did.

**Step 0 — prerequisite, owned by P5 item 2.** `icloud::ubiquity_container_dir` is
`#[cfg(target_os = "ios")]` today. The backend selector needs it on macOS too. Item 2 widens it
to `target_vendor = "apple"` as part of relocating the desktop root into the container
([D-015](../roadmap/mobile-ios.md)). **Item 3 should land after item 2.** If it lands first,
widen the gate in `src-tauri/src/icloud.rs` as step 0 and accept that the selector returns `false` on macOS
until the root actually moves — which is correct, not a workaround.

**Step 1 — `src-tauri/Cargo.toml`.** Add `NSMetadata`, `NSMetadataAttributes`, `NSArray`,
`NSDictionary`, `NSPredicate`, `NSDate`, `NSRunLoop` to the `objc2-foundation` feature list on
line 110, keeping the existing comment above the block accurate by extending it with a sentence
naming P5 item 3. Run `cargo check` to sync `Cargo.lock` — no new crates resolve, only features.
Tree compiles; nothing uses them yet.

**Step 2 — `src-tauri/src/sync/watcher.rs`, refactor only.** Extract
`is_relevant_path(shared_dir, path)` from `is_relevant_event`, leave `is_relevant_event` as a
wrapper over it, add the directory check and canonicalisation. Extend
`is_relevant_event_filters_irrelevant_paths` and add `is_relevant_path_rejects_other_directories`
plus a canonicalisation case. Behaviour under `notify` is unchanged because every path `notify`
delivers is already in one of the four directories. All six existing tests stay green.

**Step 3 — new `src-tauri/src/sync/metadata.rs`, plus `pub mod metadata;` in
`src-tauri/src/sync/mod.rs`.** Entirely `#[cfg(target_vendor = "apple")]`. Contains:

- `pub(super) fn is_ubiquity_documents_root(dir: &Path) -> bool` — the selector, with its
  `not(apple)` stub;
- `pub(super) fn spawn_query(shared_dir, tx, stop) -> AppResult<JoinHandle<()>>` — creates the
  thread, builds and starts the query, runs the pump, tears down on the stop flag;
- the observer block and `item_path` / `downloading_status` helpers.

Not called yet. `sync/mod.rs`'s module-wide `#![allow(dead_code)]` already covers it, so this
step is compile-only and adds no warnings under `-D warnings`.

**Step 4 — `src-tauri/src/sync/watcher.rs`, wire it in.** Widen the channel item to the internal
`Wake` type, replace `_watcher` with `Source`, add the selector branch at the top of `spawn`,
teach `Drop` to join the query thread after setting `stop`. This is the step where behaviour
changes, and only for a root inside the container. Every existing test still selects
`Source::Notify` because a `TempDir` is not ubiquitous, so all six stay green unmodified — which
is the property that makes this step reviewable.

**Step 5 — `docs/roadmap/mobile-ios.md`.** Mark P5 item 3 done, in the voice items 1 and 5
already use: what was actually built, what the line got wrong, and what is still owed to
hardware. Note explicitly that the Simulator cannot verify this (§6).

---

## 6. Testing, and what cannot be tested

**Unit, every platform, no iCloud:**

- `is_relevant_path` — extension table, the four accepted directories, rejection of `devices/`
  and `sources/`, rejection of a nested grandchild, `/var` vs `/private/var` canonicalisation.
- The `Wake` channel type and the debounce loop are exercised unchanged by the six existing
  watcher tests, which keep running on the `notify` source.
- `is_ubiquity_documents_root` against a `TempDir` returns `false` — pins the property that makes
  the existing tests keep working.

**Integration, Apple host, no iCloud account (i.e. CI):**

- `spawn_query` against a root that is not ubiquitous: assert it starts, that the pump thread
  joins within ~500 ms of the stop flag, and that dropping the handle does not hang. This tests
  the threading and the shutdown path, which is the half most likely to deadlock, without needing
  a single real notification.
- On a machine with no container, `ubiquity_container_dir()` returns `None` and the test logs a
  skip rather than failing. Say so in the test name.

**Only on a real device with a real iCloud account, and there is no way around it:**

- That `startQuery` returns `true` at all under the app's entitlement.
- That `NSMetadataQueryDidUpdateNotification` is delivered to a block on a **secondary** thread's
  run loop. This is the design's central assumption and it is not observable anywhere else.
- End-to-end latency: append on the Mac, measure until the iPhone's DB has the row.
- That a peer write with no local placeholder is reported — the entire point of the change, and
  precisely the case the current `notify` watcher cannot produce on demand.
- Behaviour across airplane-mode toggles and app suspension/resume.

**The Simulator cannot test this.** P5 item 5 records that simulator builds are
`ENTITLEMENTS_ALLOWED=NO`, so Xcode strips the iCloud entitlement,
`URLForUbiquityContainerIdentifier` returns nil, `ubiquity_container_dir()` returns `None`, and
the selector picks `Source::Notify` every time. A simulator run proves the build works and
proves nothing about the query. That is not a gap to close — it is a fact to state in the
roadmap so nobody later reads a green simulator run as verification.

---

## 7. Risks

**1. The secondary run loop — the biggest one.** Apple's documentation is explicit that a
metadata query needs a run loop and silent about which one. Every sample is main-thread. If the
query only delivers on the main run loop, the symptom is the worst kind: `startQuery` returns
`true`, gathering finishes, and no update ever arrives — indistinguishable from a quiet
directory, on the one platform where we cannot attach a debugger casually. Mitigations, in order:
log the `DidFinishGathering` result count so "alive but silent" is separable from "never
started"; test on hardware before marking the item done. The fallback, if it is needed, is
`AppHandle::run_on_main_thread` for construction and `startQuery`, with the notification queue
set to a dedicated serial `NSOperationQueue` so the block still runs off-main. Its cost is
concrete and worth pricing now: `spawn` grows an `AppHandle` parameter, both call sites change,
and `startQuery`'s boolean has to come back through a `mpsc::sync_channel(0)` handshake so
`sync_enable`'s Phase 1 can still fail before any durable write.

**2. macOS is not in the container yet.** Until P5 item 2 lands, macOS keeps the `notify` source
and keeps its current blind spot. Landing item 3 first is not wrong, but it buys nothing on the
desktop, and a reviewer who does not know that will reasonably expect it to.

**3. First-gather storm.** The initial gather covers the whole `Documents` tree, which on a large
library is thousands of items. §4.4 handles it by not ticking on `DidFinishGathering` — but the
block still allocates a `PathBuf` per item if that decision is implemented in the wrong order.
Filter before the channel, not after.

**4. Removals are ignored.** If a future feature ever deletes a peer log, the watcher will not
notice. Recorded here rather than defended: nothing does that today.

**5. Two coalescing stages.** Worst-case peer-write-to-tick latency becomes roughly 0.5 s instead
of 0.25 s. Acceptable for a background convergence tick, and tunable by dropping the query's
batching interval if it ever reads as sluggish on device.
