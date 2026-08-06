/**
 * The one place that answers "what can this platform do".
 *
 * Per [D-005](../../docs/roadmap/mobile-ios.md#d-005--capability-flags-not-platform-checks),
 * components ask `hasWindow`, never `isIOS`. The point is that "mobile is a
 * strict subset of desktop" becomes a concrete set of `false` values here
 * rather than a platform check scattered across the component that happens to
 * need it. A new capability is absent everywhere until a platform opts in:
 * `ABSENT` below is typed as the full capability set, so adding a field to
 * `PlatformCapabilities` fails to compile until it is given a default, and
 * every platform inherits that default until it overrides it.
 *
 * Why the OS plugin rather than the user agent: iPadOS reports `Macintosh` in
 * its webview UA, so a UA sniff would hand an iPad the full desktop capability
 * set. `platform()` is baked in at Rust compile time and answers `"ios"`.
 *
 * Safe to import outside a Tauri webview — a plain browser (`npm run dev`) or a
 * Node unit test falls back to a UA sniff, and an unrecognised UA gets `ABSENT`,
 * which fails closed.
 */

import { platform as osPlatform } from "@tauri-apps/plugin-os";

export type PlatformId = "macos" | "windows" | "linux" | "ios" | "android" | "unknown";

/**
 * How the build reached the user. An App Store build and a sideload of the same
 * OS differ on what they may touch on disk, so this is deliberately not derived
 * from `PlatformId`.
 *
 * Not yet detected: every build Lantern currently ships is direct (`dmg`/`app`
 * /`nsis`, plus development sideloads on iOS). When an App Store build exists,
 * the release workflow has to bake the channel in — the value cannot be
 * recovered at runtime.
 */
export type DistChannel = "direct" | "appstore";

export interface PlatformCapabilities {
  readonly id: PlatformId;
  readonly isMobile: boolean;
  readonly isIOS: boolean;
  readonly distChannel: DistChannel;

  /**
   * More than one OS window can exist. Drives `openReaderWindow()` vs
   * `navigate()`, the cross-window event fan-outs, and per-window size
   * persistence.
   */
  readonly hasWindow: boolean;
  /**
   * The window chrome overlaps the content and the top strip has to be left
   * clear for it (macOS traffic lights). No consumer yet — the top strip is
   * currently reserved unconditionally; P2 is what reads this.
   */
  readonly hasTitleBarInset: boolean;
  /**
   * Content has to inset itself from a notch or home indicator. No consumer
   * yet; P2 mobile chrome is what reads this.
   */
  readonly hasSafeAreaInset: boolean;
  /** Files can be dragged onto the window from the OS. */
  readonly hasDragDrop: boolean;
  /** Right-click opens a context menu (as opposed to long-press). */
  readonly hasContextMenu: boolean;
  /** OCR can run — it downloads and spawns a subprocess. See D-003. */
  readonly hasOcr: boolean;
  /** The MCP tab: writes local CLI config and serves a localhost endpoint. */
  readonly hasMcpIntegration: boolean;
  /**
   * MOBI-family books can be normalised to EPUB, which shells out to Calibre's
   * `ebook-convert`. True means the platform permits it, not that Calibre is
   * installed — the backend probes for that separately at runtime.
   */
  readonly hasFormatConvert: boolean;
  /**
   * The library can sync through an iCloud folder. Nothing is picked — Lantern
   * owns the folder ([D-015](../../docs/roadmap/mobile-ios.md)); the capability
   * is whether this platform can reach it at all. See D-006, D-007.
   */
  readonly hasFolderSync: boolean;
  /**
   * The app may update itself. False on Apple's mobile platforms, which forbid
   * it — and the updater plugin is not even compiled for them, so every piece
   * of update UI (the toast, the auto-check toggle) has to be gated on this.
   */
  readonly hasUpdater: boolean;
  /** A file can be revealed in a file manager (Finder, Explorer). */
  readonly hasFileReveal: boolean;
  /** Font files can be imported through a native picker. */
  readonly hasFontImport: boolean;
  /**
   * A model server can run on this machine and be reached over the loopback
   * address. Gates the Ollama preset in the AI catalog: Ollama is a process the
   * reader starts alongside Lantern and Lantern talks to at
   * `http://localhost:11434`, and iOS has neither the process nor the port.
   *
   * Named for the runtime rather than for Ollama so it does not have to be
   * renamed when a second local backend appears, and kept apart from `hasOcr`
   * and `hasFormatConvert` — those are Lantern spawning a helper of its own,
   * which is a different fact about the platform and could plausibly diverge.
   *
   * Reaching a Mac's Ollama from a phone still works: it goes through the
   * custom OpenAI-compatible preset with a LAN address, which is an ordinary
   * HTTP endpoint and needs no capability.
   */
  readonly hasLocalModelRuntime: boolean;

  /**
   * The vector/retrieval index.
   *
   * The one flag here that is a product decision rather than a platform limit,
   * and the distinction is worth keeping visible: everything above says "this
   * platform cannot" (no subprocess, no window manager, no updater plugin),
   * while this one says the feature it serves is not on the phone. The index
   * exists for AI chat's retrieval augmentation, and chat is not on the phone
   * ([D-012](../../docs/roadmap/mobile-ios.md#d-012--the-phone-gets-ai-contextual-glosses-not-ai-chat)).
   * Contextual gloss reads the selected sentence directly — it never queries an
   * index. It is a named flag rather than an `isMobile` check at the call site
   * so that the reason lives here (D-005).
   *
   * A related set of cuts was considered and rejected: read-aloud, the three
   * card/menu/marker authoring surfaces, and the CEFR score estimator were all
   * going to be phone-absent on the same "consumes, does not produce" grounds.
   * They are not, by an explicit product decision on 2026-08-06 — a reader whose
   * only device is a phone must be able to do those things, so they are baseline
   * usage conditions, not desktop luxuries. Do not add flags for them.
   */
  readonly hasEmbeddingIndex: boolean;
  /**
   * The device has a cellular radio the OS can report on, so a book download
   * can ask before spending its data ([D-016](../../docs/roadmap/mobile-ios.md)).
   * Reachability is read through `SCNetworkReachability`, which only exists on
   * iOS — Android is deferred (D-010) and every desktop target Lantern ships
   * on has no cellular radio at all.
   *
   * Grouped with `hasSafeAreaInset` and `hasTitleBarInset`, not with the
   * software-limit flags above: this says what the hardware *is* (does it
   * have a cellular modem), not what the platform lets Lantern *do*. That is
   * also why it is exempt from "mobile is a strict subset of desktop" in
   * `tests/platform-capabilities.test.ts` — a MacBook having no cellular
   * modem is not desktop missing a feature phones have, the same way a Mac
   * having no notch is not desktop missing `hasSafeAreaInset`. Named as a
   * capability rather than checked via `isIOS` at the call site regardless,
   * per D-005 — see `hasEmbeddingIndex` above for the same reasoning applied
   * to an actual feature flag.
   */
  readonly hasCellularReachability: boolean;
}

/*
 * Deliberately not a capability: whether a keyboard is attached. It looks like
 * one — the reader's shortcut recorder and the menu-shortcut hints are useless
 * without keys — but an iPad with a Magic Keyboard is an ordinary setup, so
 * gating those on the platform would take the feature away from the people who
 * can use it. Keyboard-dependence is not platform-dependence here.
 */

type Capability = Omit<PlatformCapabilities, "id" | "distChannel">;

/** Every capability absent. Platforms opt in; nothing opts in by default. */
const ABSENT: Capability = {
  isMobile: false,
  isIOS: false,
  hasWindow: false,
  hasTitleBarInset: false,
  hasSafeAreaInset: false,
  hasDragDrop: false,
  hasContextMenu: false,
  hasOcr: false,
  hasMcpIntegration: false,
  hasFormatConvert: false,
  hasFolderSync: false,
  hasUpdater: false,
  hasFileReveal: false,
  hasFontImport: false,
  hasLocalModelRuntime: false,
  hasEmbeddingIndex: false,
  hasCellularReachability: false,
};

const DESKTOP: Capability = {
  ...ABSENT,
  hasWindow: true,
  hasDragDrop: true,
  hasContextMenu: true,
  hasOcr: true,
  hasMcpIntegration: true,
  hasFormatConvert: true,
  hasUpdater: true,
  hasFileReveal: true,
  hasFontImport: true,
  hasLocalModelRuntime: true,
  hasEmbeddingIndex: true,
};

/**
 * Shared by iOS and Android. Android is deferred rather than abandoned
 * ([D-010](../../docs/roadmap/mobile-ios.md#d-010--android-is-deferred-not-abandoned)),
 * and one shared entry is cheaper than two — which is the only reason it is
 * here. Android gets no budget of its own.
 */
const MOBILE: Capability = {
  ...ABSENT,
  isMobile: true,
  hasSafeAreaInset: true,
};

const BY_PLATFORM: Record<PlatformId, Capability> = {
  // Traffic lights overlap the content; iCloud Drive backs folder sync (D-006).
  macos: { ...DESKTOP, hasTitleBarInset: true, hasFolderSync: true },
  // Folder sync is macOS ↔ iOS only (D-007).
  windows: DESKTOP,
  // Not a shipping target — `bundle.targets` is dmg/app/nsis. Reachable only
  // from a development run, and treated as a desktop for that purpose.
  linux: DESKTOP,
  // The app's own ubiquity container is reachable from the sandbox, and it is
  // the other half of the pair macOS syncs with (D-006, D-007).
  ios: { ...MOBILE, hasFolderSync: true, hasCellularReachability: true },
  android: MOBILE,
  unknown: ABSENT,
};

/**
 * Falls back to the user agent when the OS plugin is unreachable, which means
 * the app is not running inside a Tauri webview: a browser pointed at the dev
 * server, or a Node unit test. Native calls fail in both cases regardless of
 * what this returns, so the useful answer is the one that renders the UI the
 * real app would render.
 */
export function detectPlatform(): PlatformId {
  try {
    const id = osPlatform();
    if (id === "macos" || id === "windows" || id === "linux") return id;
    if (id === "ios") return "ios";
    if (id === "android") return "android";
    return "unknown";
  } catch {
    // Not under Tauri.
  }

  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  // Ordered: iPadOS says "Macintosh" too, so the mobile tests come first.
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (ua.includes("Macintosh")) return "macos";
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Linux")) return "linux";
  return "unknown";
}

/** Exported for tests; prefer the frozen `platform` singleton below. */
export function capabilitiesFor(id: PlatformId): PlatformCapabilities {
  return Object.freeze({
    ...BY_PLATFORM[id],
    id,
    isIOS: id === "ios",
    distChannel: "direct" as DistChannel,
  });
}

/**
 * The capability set for the platform this build is running on. Read once —
 * `platform()` is a compile-time constant, so nothing can change underneath it.
 */
export const platform: PlatformCapabilities = capabilitiesFor(detectPlatform());
