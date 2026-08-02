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
`lantern → reqwest → native-tls`, from our own manifest line, not a transitive. On Apple targets
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

**Cost: half a day. Do it *with* Android, not before.** An earlier version of this page said
"cheaper now than later" and told you to make the change immediately. **That was wrong**, and
it contradicted [P0's own log](mobile-ios.md#p0--compile-and-boot-6-days) (item 5), which had
already dropped the change with the correct reasoning: `rustls-tls` resolves to
`rustls-tls-webpki-roots`, a bundled root store that ignores the OS trust store, so the swap
breaks anyone behind a corporate proxy with a custom CA. Two further facts settle it:

- **Lantern ships no Linux build.** `release.yml` produces only `aarch64-apple-darwin`
  (dmg/app) and Windows (nsis); `tauri.conf.json`'s `bundle.targets` is `["dmg","app","nsis"]`.
  So `openssl-sys` never reaches a user — it only ever touched the ubuntu CI runner.
- **The CI runner already satisfies it** without any explicit install step (`ci.yaml`'s
  `backend` job installs only the webkit/gtk/appindicator/rsvg set, yet `cargo check` links
  `reqwest → native-tls → openssl-sys` fine).

Net: outside Android this change has **zero** benefit and one known regression. Make it in the
same commit as the rest of the Android work, and use `rustls-tls-native-roots` so the OS trust
store is preserved.

**`keyring` is gone — this row is now half a row.** This entry used to describe an `E0432` on
Android, because keyring 3.x has no Android backend at all (docs.rs for 3.6.3 lists Linux,
FreeBSD, OpenBSD, Windows, macOS, iOS — Android absent). That compile blocker no longer
exists: deleting the v1.4 vault in v2.5.0 removed the only two `Entry::` call sites, and with
them `keyring`, `security-framework`, `aes-gcm`, and `zeroize` from `Cargo.toml`. `secrets.rs`
is now one SQLite table on every platform, so an Android build has nothing to gate.

What survives is the runtime half, unchanged: local plaintext in `secrets.db` is a deliberate
desktop tradeoff, and an Android port would want Android Keystore through a small plugin or an
encrypted file — a genuine design decision, **2–4 days**, and it belongs in §2.2, not here.

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
plus a media-button receiver).

**Re-checked 2026-08-02, now that the speech work has landed — and the earlier optimism was
misplaced.** It is true that Lantern's *primary* path is `msedge-tts` in Rust, a network TTS
rather than a WebView API. But system voices are the **mandatory last tier of every routing
plan**: `src/components/speech/routing.ts:76-77` describes them as the only source that cannot
fail for a reason worth escalating, and `planSources` (`:83-91`) ends every route array in
`"system"`. That tier is `window.speechSynthesis` (`player.ts:176-357`, feature-detected in
`system-voices.ts:8-13`, reached via `kind: "voice"` in `useSpeech.ts:48`). On Android it
collapses, and with it the guarantee that read-aloud always has something to fall back to —
including offline, where the network TTS cannot help. **Cost: Readest's plugin, or an
equivalent. Not free.** This is the single largest piece of Android work that
[D-010](mobile-ios.md#d-010--android-is-deferred-not-abandoned) permanently retires.

**Android secrets store.** Carried over from §2.1: the compile side is now free, but somewhere
to actually keep API keys and OAuth tokens on Android is not. Android Keystore via a small
plugin, or an encrypted file — note that `aes-gcm` left the tree with the v1.4 vault, so an
encrypted file means adding a crypto dependency back, not reusing one.
**Cost: 2–4 days.**

**Sync has no Android transport at all.** Not a gap in the engine — the engine is genuinely
transport-agnostic, and this was verified rather than assumed: `merge.rs` (3,430 lines),
`replay.rs` (2,042), `events.rs` (792), `writer.rs` (1,200), `peers.rs` (745) and
`validation.rs` (930) contain **zero** occurrences of `target_os`, `target_vendor` or
`icloud`. Apple-specific code is `icloud.rs` (190 lines) plus five lines in `log.rs`
(`:234`, `:239`, and macOS `cfg` arms at `:356`, `:362`, `:388`). `migration.rs` stores the
sync location as a plain `Option<String>` with one Apple predicate (`is_icloud_drive_dir`,
`:55-67`).

So the *interface* to replace is ~195 lines. What is missing is everything behind it: with
[D-007](mobile-ios.md#d-007--windows-sync-is-out-of-scope) putting Windows sync out of scope,
sync is Apple-ecosystem-only, so Android needs a second transport chosen from scratch —
a consumer cloud drive or a relay — with its own auth, quota and conflict story.
**Cost: unestimated, and larger than any single row in §2.3.**

**MCP server.** `rmcp` with `transport-io` is a stdio subprocess model. It compiles, but the
concept does not exist on a phone. Gate it behind `hasMcpIntegration` — which
[D-005](mobile-ios.md#d-005--capability-flags-not-platform-checks) already plans.

### 2.3 The honest total

Split by milestone, because the two halves have very different prices and the earlier version
of this table blurred them.

**Milestone A — it compiles.** Nothing here needs a design decision:

| Bucket | Days |
|---|---|
| `reqwest` → `rustls-tls-native-roots` | 0.5 |

**Half a day** — the `keyring` row that used to sit here was paid off for free when the v1.4
vault was deleted. That is the whole compile-blocker set: `HOME` and `content://` are runtime
failures, not compile failures, and pdfium is a runtime `dlopen` with a no-cover fallback.

**Milestone B — it is a product people can use:**

| Bucket | Days |
|---|---|
| `HOME` unset — find and fix the path assumptions | 1 |
| `content://` import path | 3–5 |
| Android secrets store | 2–4 |
| Read-aloud system-voice tier (Kotlin plugin) | 3–5 |
| pdfium `.so` per ABI (optional) | 2–3 |
| Gradle/manifest/permissions/signing/CI | 3–4 |
| Play Store listing, policy, first review | 4–6 |
| **Android sync transport** | **unestimated** |
| Device-specific debugging (Android's tax) | ? |

**Roughly 18–30 days on top of a shipped iOS app** — up from this page's earlier 16–24,
because two rows were missing: read-aloud (§2.2, re-checked once the speech work landed) and
the secrets store (previously folded into the compile bucket). Both of the unpriced rows are
genuine: sync is unestimated because no second transport has been chosen, and device debugging
is unbounded, which is the real reason to do iOS first — one vendor, one WebView, four screen
sizes.

It is still far below the original 25–35, because P1–P3 (capability layer, mobile UI, touch
interaction) are shared and get paid once for iOS. The estimate assumes the iOS work lands
first and is reused wholesale.

**What this means for D-002:** the decision to defer Android was right, and it stays deferred
rather than abandoned — see [D-010](mobile-ios.md#d-010--android-is-deferred-not-abandoned).
The premise that should be retired is "25–35 extra days"; the premise that should **not** have
been retired is that the TLS change is Android-only work. See §2.1.

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

One item:

1. **Stop tracking generated `gen/apple` files** (§1.1). Move to Readest's ignore-everything +
   force-add-the-edited-files pattern before the next CLI bump.

**Removed from this list 2026-08-02:** `reqwest` → rustls. It was listed here as "cheap and
cheaper now than later", justified by Android. Both halves were wrong — it has no non-Android
benefit (Lantern ships no Linux build), and it carries a real regression for corporate-proxy
users. See §2.1. It belongs in the Android work, not before P1.

Everything else on this page is P2/P3 input or post-iOS Android work.
