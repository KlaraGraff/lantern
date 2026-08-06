import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilitiesFor,
  detectPlatform,
  type PlatformCapabilities,
  type PlatformId,
} from "../src/services/platform.ts";

/**
 * Fields that describe what the device *is* rather than what it can *do*. The
 * subset check below excludes them: a notch is not a feature iOS has and macOS
 * lacks, and `isMobile` is true on mobile by definition.
 */
const NOT_A_FEATURE = new Set(["isMobile", "isIOS", "hasSafeAreaInset", "hasTitleBarInset"]);

function featureFlags(caps: PlatformCapabilities): [string, boolean][] {
  return Object.entries(caps).filter(
    ([key, value]) => typeof value === "boolean" && !NOT_A_FEATURE.has(key),
  ) as [string, boolean][];
}

test("an unrecognised platform gets nothing", () => {
  for (const [key, value] of Object.entries(capabilitiesFor("unknown"))) {
    if (typeof value === "boolean") {
      assert.equal(value, false, `${key} should be absent on an unknown platform`);
    }
  }
});

test("mobile is a strict subset of desktop", () => {
  // Model C, stated as a test: every feature a phone has, a Mac has too. A new
  // capability that mobile opts into but desktop does not is the failure this
  // is here to catch.
  const macos = capabilitiesFor("macos");
  for (const id of ["ios", "android"] as PlatformId[]) {
    for (const [key, enabled] of featureFlags(capabilitiesFor(id))) {
      if (!enabled) continue;
      assert.equal(
        macos[key as keyof PlatformCapabilities],
        true,
        `${key} is enabled on ${id} but not on macos`,
      );
    }
  }
});

test("iOS has no window management and none of the subprocess-backed features", () => {
  const ios = capabilitiesFor("ios");
  assert.equal(ios.isMobile, true);
  assert.equal(ios.isIOS, true);
  assert.equal(ios.hasWindow, false);
  assert.equal(ios.hasOcr, false);
  assert.equal(ios.hasFormatConvert, false);
  assert.equal(ios.hasMcpIntegration, false);
  assert.equal(ios.hasDragDrop, false);
  assert.equal(ios.hasFileReveal, false);
  assert.equal(ios.hasFontImport, false);
});

test("Android is mobile but is not iOS", () => {
  const android = capabilitiesFor("android");
  assert.equal(android.isMobile, true);
  assert.equal(android.isIOS, false);
  assert.equal(android.id, "android");
});

test("folder sync is the macOS ↔ iOS pair, and nothing else", () => {
  // D-006 ships sync for macOS ↔ iOS; D-007 puts Windows out of scope. The
  // desktop capability set must not hand it to Windows just for being a desktop,
  // and the mobile set must not withhold it from iOS just for being mobile.
  assert.equal(capabilitiesFor("macos").hasFolderSync, true);
  assert.equal(capabilitiesFor("ios").hasFolderSync, true);
  assert.equal(capabilitiesFor("windows").hasFolderSync, false);
  assert.equal(capabilitiesFor("android").hasFolderSync, false);
});

test("the title-bar inset is macOS only", () => {
  assert.equal(capabilitiesFor("macos").hasTitleBarInset, true);
  assert.equal(capabilitiesFor("windows").hasTitleBarInset, false);
});

test("detection outside a Tauri webview falls back instead of throwing", () => {
  // The module is imported by components that unit tests reach; a `window` the
  // OS plugin can read does not exist here.
  assert.equal(typeof detectPlatform(), "string");
});

test("capability sets are frozen", () => {
  const caps = capabilitiesFor("macos") as { hasOcr: boolean };
  assert.throws(() => {
    "use strict";
    caps.hasOcr = false;
  });
});
