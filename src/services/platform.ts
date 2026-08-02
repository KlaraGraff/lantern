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
  /** Non-EPUB books can be converted — shells out to Calibre's `ebook-convert`. */
  readonly hasFormatConvert: boolean;
  /** A sync folder can be picked and watched. See D-006, D-007. */
  readonly hasFolderSync: boolean;
  /**
   * The app may update itself. False on Apple's mobile platforms, which forbid
   * it. No consumer yet — Lantern ships no updater at all.
   */
  readonly hasUpdater: boolean;
  /** A file can be revealed in a file manager (Finder, Explorer). */
  readonly hasFileReveal: boolean;
  /** Font files can be imported through a native picker. */
  readonly hasFontImport: boolean;
  /**
   * A physical keyboard is assumed present, so keyboard-only affordances (the
   * reader shortcut recorder) are worth showing.
   */
  readonly hasKeyboard: boolean;
}

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
  hasKeyboard: false,
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
  hasKeyboard: true,
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
  ios: MOBILE,
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
