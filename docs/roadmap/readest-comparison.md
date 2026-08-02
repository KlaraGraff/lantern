# Readest — what to copy, and what Android actually costs

Study note. Input to [`mobile-ios.md`](mobile-ios.md) phases P1–P3, and the basis for
re-scoring [D-002](mobile-ios.md#d-002--ios-first-android-deferred) (Android deferred).

**Source:** `github.com/readest/readest` @ `--depth 50`, read 2026-08-02. Readest is the
closest possible comparison — Tauri 2, foliate-js, an e-reader, and it ships desktop + iOS +
Android + web from one codebase. Where a number appears below it was measured in that
checkout, not estimated.

---

## 1. How Readest produces an Android package

The whole thing is one job in `.github/workflows/release.yml`, and the single most important
fact is the runner:

```yaml
- os: ubuntu-latest
  release: android
  rust_target: aarch64-linux-android,armv7-linux-androideabi,i686-linux-android,x86_64-linux-android
```

**Android builds on a Linux runner.** No Mac, no Xcode, no Apple Developer account, no
signing identity that expires. Compare the iOS leg, which needs `macos-latest` plus six
`APPLE_*` secrets. In CI-minute terms Android is the *cheap* platform — GitHub bills Linux at
1× and macOS at 10×.

The toolchain it installs is four steps:

| Step | Value |
|---|---|
| JDK | Zulu 17 (`actions/setup-java`) |
| Android SDK | `android-actions/setup-android@v4` |
| NDK | `sdkmanager "ndk;28.2.13676358"` — pinned exactly |
| Rust targets | the four ABIs above |

Then the build itself:

```bash
cd apps/readest-app/
rm -rf src-tauri/gen/android      # throw away the generated project
pnpm tauri android init           # regenerate it from the CLI template
pnpm tauri icon ../../data/icons/readest-book.png
git checkout .                    # re-apply only the hand-edited files

pnpm tauri android build          # -> app-universal-release.apk
pnpm tauri android build -t aarch64
```

Signing is a `keystore.properties` file written from four repo secrets, with the keystore
itself base64-decoded into `$RUNNER_TEMP`. `app/build.gradle.kts` reads it if present and
silently skips signing if not — so a contributor with no secrets still gets a working debug
build.

Play Store submission is a separate manual script (`scripts/release-google-play.sh` →
`fastlane android upload_production`), not part of the tag pipeline. Sideload APKs go to the
GitHub release; the Play build is a different flavour (`ORG_GRADLE_PROJECT_storeFlavor=googleplay`,
a different `tauri.playstore.conf.json`, and `REQUEST_INSTALL_PACKAGES` stripped from the
manifest because Play rejects it).

### 1.1 The regeneration pattern — the most transferable trick here

`apps/readest-app/.gitignore` ignores `src-tauri/gen` wholesale. Exactly **14 files** of the
Android project are force-added, and **15** of the iOS project:

```
gen/android/app/build.gradle.kts
gen/android/app/src/main/AndroidManifest.xml
gen/android/app/src/main/java/com/bilingify/readest/MainActivity.kt
gen/android/app/src/main/res/…            (themes, splash, monochrome icons)
```

That is why `rm -rf … && tauri android init && git checkout .` works: regenerate everything
from the current CLI template, then let git restore the handful of files that were actually
edited by hand. The Tauri CLI can change its template between minor versions and it costs
nothing — there is no merge to resolve, because nothing generated is tracked.

**Lantern currently does the opposite.** We committed all 33 files of `gen/apple` in P0, and
`src-tauri/.gitignore` only excludes `/gen/schemas`. That works today and there is no urgency,
but it means the next `@tauri-apps/cli` bump will produce a diff across the whole Xcode
project that has to be reviewed by hand. Switching to Readest's pattern is a 30-minute change
and should happen before the second CLI bump, not after.

### 1.2 They also test Android in CI without a device

`android-e2e.yml` boots an x86_64 emulator on `ubuntu-latest` with KVM enabled, installs a
debug APK, and drives it over CDP. Nightly + on-demand + on a PR label — deliberately not
PR-blocking, because it takes up to 90 minutes.

---

## 2. What Android actually costs Lantern

[D-002](mobile-ios.md#d-002--ios-first-android-deferred) estimated "25–35 extra days". That
number was written before P0 ran and it is now re-checkable. Here is the itemised version,
split by whether it stops the compiler or only degrades at runtime.

### 2.1 Compile blockers — must be fixed before an APK exists

**`reqwest` pulls OpenSSL.** Verified: `cargo tree -i native-tls` shows the chain is
`quill → reqwest → native-tls`, from our own manifest line, not a transitive. On Apple targets
`native-tls` binds Security.framework and everything is fine — which is exactly why P0 dropped
this. On Android there is no system OpenSSL, so `openssl-sys` has to cross-compile OpenSSL for
four ABIs against the NDK. This is the classic Tauri-Android wall.

The fix is one line:

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "rustls-tls-native-roots"] }
```

Readest sidesteps it slightly differently — `default-features = false` with no TLS feature at
all, then `sentry`'s `["reqwest", "rustls"]` features unify rustls back in. Ours should be
explicit rather than accidental.

**Cost: half a day, and it is cheaper now than later.** Changing the TLS backend changes which
root-certificate store is used on every platform, so it wants its own commit with its own
verification pass on macOS and Windows. Doing it while simultaneously debugging NDK linker
errors means two unfamiliar failure modes at once.

**`keyring` has no Android backend.** `Cargo.toml` has target tables for `apple`, `windows`
and `linux`. An Android build hits `use keyring::Entry` with no crate to resolve — the same
`E0432` class of failure that P0 found on iOS. keyring 3.x has no Android backend at all, so
this is not a feature flag, it is "pick something else": Android Keystore through a small
plugin, or an encrypted file (`aes-gcm` and `sha2` are already in the tree). **Cost: 2–4
days**, and it cannot be paid early — it needs a real design decision about where Android
secrets live.

**`HOME` is not set on Android.** Path helpers that assume it will panic at startup. This is a
known Tauri-Android property and the fix is mechanical, but it has to be found, and it is
found by running, not by reading. **Cost: 1 day.**

### 2.2 Runtime gaps — compile fine, behave wrong

**PDF covers.** `src/pdfium.rs` uses `Pdfium::bind_to_library` — a *runtime* dylib load with
an explicit "fall back to no cover rather than failing the import" contract. So pdfium is
**not** a compile blocker on either mobile platform; it degrades to no cover. Restoring it on
Android means shipping `libpdfium.so` per ABI into `jniLibs/` (prebuilts exist for all four).
**Cost: 2–3 days, and it is optional** — a phone that shows no cover for scanned PDFs is a
real product, just a worse one.

**`content://` URIs.** This is the big one, and it is the item that has no iOS equivalent at
all. On iOS, `UIDocumentPickerViewController(asCopy: true)` hands back a plain `file://` path
and [F-006](mobile-ios.md#f-006--ios-book-import-works-with-zero-code-changes) confirmed our
importer works with zero changes. Android's picker returns an opaque `content://` URI that
only `ContentResolver` can open. Readest carries a whole custom plugin for this
(`plugins/tauri-plugin-native-bridge`, exposed as `copyURIToPath`) plus a `FileProvider` in
the manifest. **Cost: 3–5 days**, and it touches import, sync, and any place we hand a path to
Rust.

**Read-aloud.** Android System WebView has no `speechSynthesis`, which is why Readest wrote
`tauri-plugin-native-tts` (Kotlin, ~a MediaBrowserService plus a foreground-service permission
plus a media-button receiver). Lantern's read-aloud goes through `msedge-tts` in Rust — a
network TTS, not a WebView API — so **this may cost us nothing where it cost Readest a
plugin.** Flagged rather than asserted: the speech work is still landing in a parallel
session and has not been read.

**MCP server.** `rmcp` with `transport-io` is a stdio subprocess model. It compiles, but the
concept does not exist on a phone. Gate it behind `hasMcpIntegration` — which
[D-005](mobile-ios.md#d-005--capability-flags-not-platform-checks) already plans.

### 2.3 The honest total

| Bucket | Days |
|---|---|
| Compile blockers (TLS, keyring, HOME) | 4–6 |
| `content://` import path | 3–5 |
| pdfium `.so` bundling (optional) | 2–3 |
| Gradle/manifest/permissions/signing/CI | 3–4 |
| Play Store listing, policy, first review | 4–6 |
| Device-specific debugging (Android's tax) | ? |

**Roughly 16–24 days on top of a shipped iOS app**, not 25–35 — because P1–P3 (capability
layer, mobile UI, touch interaction) are shared and get paid once for iOS. The estimate
assumes the iOS work lands first and is reused wholesale. It excludes the last row, which is
genuinely unbounded and is the real reason to do iOS first: one vendor, one WebView, four
screen sizes.

**What this means for D-002:** the decision to defer Android was right, but the *reason*
"Android needs 25–35 extra days" is now too pessimistic and one of its premises should be
retired — TLS is a one-line fix that we should make now regardless.

---

## 3. They do not maintain two UIs

The thing worth internalising, measured in the checkout:

| | Readest | Lantern |
|---|---|---|
| Frontend TS/TSX | 323,005 lines | 35,061 |
| Responsive breakpoint usages | **524** | **38** |
| `isMobile` references | 147 | — |
| `isAndroidApp` / `isIOSApp` | 117 / 62 | — |
| Reader shells | **one** `Reader.tsx` | one `Reader.tsx` |

There is no `MobileReader.tsx`. There is no `mobile/` directory. A codebase nine times ours,
shipping five platforms, has exactly one reader component. The platform difference lives in
two places and only two: **responsive classes** and **capability flags**.

This is the direct answer to "will I have to build a separate mobile version?" — no, and the
largest comparable project in this niche proves it at scale. But note the ratio: they carry
14× more breakpoints for 9× the code. Responsive density is roughly 1.5× ours *per line*, and
ours is concentrated in a few files. P2 must build the breakpoint system first; hand-fitting
screens one at a time is what produces the second UI nobody wanted.

---

## 4. Capability flags — what D-005 is missing

Readest's `AppService` (`src/types/system.ts:82`) declares 30 capability fields. Defaults all
live as `false` in an abstract `BaseAppService`, and `NativeAppService` overrides each one
with a single expression off `osType()`. Worth stealing:

- **`isEink`** — set from a native probe (`android::is_eink_device()`). Not relevant yet, but
  the shape is: capabilities can be *detected*, not just declared.
- **`distChannel: 'readest' | 'playstore' | 'appstore'`** — capability by *store*, not by OS.
  Drives `canCustomizeRootDir` and `canReadExternalDir`, both of which differ between an App
  Store build and a sideload of the same OS. We will need this the moment we ship to a store.
- **`supportsViewTransitionsAPI`** — gated on `OS_TYPE !== 'linux' && detectViewTransitionsAPI()`,
  i.e. a real feature probe with a platform-specific override for a known-broken engine. The
  comment says WebKitGTK crashes when a View Transition snapshots the window.
- **`hasSafeAreaInset`, `hasHaptics`, `hasScreenBrightness`, `hasOrientationLock`** — the
  mobile-affordance set. D-005 has `hasSafeAreaInset` only.
- **`hasUpdater`** — `OS_TYPE !== 'ios'`, because Apple forbids self-update. We will hit this.

Their defaults-false-in-the-base-class pattern is worth copying exactly: a new capability
added to the interface is automatically absent everywhere until a platform opts in, which is
the right failure direction for "mobile is a strict subset".

---

## 5. Input to P3 — how they do touch

Readest does **not** rely on the WebView's own touch events for page turns. `MainActivity.kt`
overrides `dispatchTouchEvent` and forwards every touch into JS as `window.onNativeTouch({type, x, y, pressure, pointerCount, timestamp})`,
throttling `touchmove` to ~10/s because each dispatch is an `evaluateJavascript` round-trip.

On the JS side there is a small architecture rather than a handler:

- `useTouchInterceptor.ts` — a module-level priority registry. Interceptors are sorted
  descending and the first one returning `true` consumes the gesture. Constants worth
  borrowing verbatim: `TOUCH_SWIPE_THRESHOLD_PX = 15`, tap slop = the same 15.
- `turnGestureArena.ts` — decides *whether a horizontal drag is a page turn* before committing.
  `TURN_EDGE_ZONE_RATIO = 0.18`, `TURN_FAST_CLAIM_DISTANCE_PX = 6`,
  `TURN_VERTICAL_LOCK_DISTANCE_PX = 8`, `TURN_DIRECTION_DOMINANCE = 1.5`. A vertical lock at
  8px kills the turn outright, and horizontal has to beat vertical by 1.5× to claim.
- Separate gesture modules for brightness (`brightnessGesture.ts`) and auto-scroll speed, each
  registering into the same arena.

[F-011](mobile-ios.md#f-011--first-run-what-the-app-actually-does-on-a-phone) recorded that a
horizontal swipe in Lantern currently scrolls instead of turning the page. That is the same
problem this arena exists to solve, and P3's 10-day estimate should be read as "build a small
arena", not "add a swipe handler". The vertical-lock and dominance constants are the part that
takes days to tune and are free to copy.

---

## 6. What to change now, before P1

Two items, both cheap, both cheaper now than later:

1. **`reqwest` → rustls** (§2.1). One line, own commit, verify on macOS and Windows. Removes
   the single hardest Android blocker and retires a stale premise in D-002.
2. **Stop tracking generated `gen/apple` files** (§1.1). Move to Readest's ignore-everything +
   force-add-the-edited-files pattern before the next CLI bump.

Everything else on this page is P2/P3 input or post-iOS Android work.
