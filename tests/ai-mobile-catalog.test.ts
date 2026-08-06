import assert from "node:assert/strict";
import test from "node:test";

import { AI_PRESETS, availablePresets } from "../src/components/settings/aiPresets.ts";
import {
  KEYCHAIN_GRACE_MS,
  missingKeyState,
  wantsMissingKeyNotice,
} from "../src/components/settings/missing-key.ts";

test("a phone is not offered a model server it cannot run", () => {
  const desktop = availablePresets(true).map((preset) => preset.provider);
  const phone = availablePresets(false).map((preset) => preset.provider);

  assert.ok(desktop.includes("ollama"));
  assert.ok(!phone.includes("ollama"));
  // Nothing else goes missing: the phone loses exactly the local runtime.
  assert.deepEqual(
    desktop.filter((provider) => provider !== "ollama"),
    phone,
  );
  assert.equal(desktop.length, AI_PRESETS.length);
});

test("a profile already using the local runtime keeps its own provider visible", () => {
  // A model configured on a Mac syncs to the phone. Hiding its provider would
  // leave the select showing nothing and rewrite the profile on the next save.
  const phone = availablePresets(false, "ollama").map((preset) => preset.provider);
  assert.ok(phone.includes("ollama"));
  // And `keep` re-admits only that one.
  assert.deepEqual(phone, availablePresets(true).map((preset) => preset.provider));
});

const PEERS = [{ name: "Klara 的 MacBook Air", last_seen: 200 }];

test("a model that is not missing a key says nothing at all", () => {
  const state = missingKeyState({
    missing: false,
    pairedSync: true,
    peers: PEERS,
    observedSince: 0,
    now: 10 * KEYCHAIN_GRACE_MS,
  });
  assert.equal(state.kind, "none");
});

test("a key that just went missing gets a minute before anything is blamed", () => {
  const state = missingKeyState({
    missing: true,
    pairedSync: true,
    peers: PEERS,
    observedSince: 1_000,
    now: 1_000 + KEYCHAIN_GRACE_MS - 1,
  });
  assert.equal(state.kind, "waiting");
});

test("one channel through and the other not, past the grace, names the channel", () => {
  const state = missingKeyState({
    missing: true,
    pairedSync: true,
    peers: [
      { name: "Klara 的 iMac", last_seen: 100 },
      { name: "Klara 的 MacBook Air", last_seen: 900 },
    ],
    observedSince: 1_000,
    now: 1_000 + KEYCHAIN_GRACE_MS,
  });
  assert.equal(state.kind, "inferred");
  // The most recently seen peer is the one worth naming.
  assert.equal(state.kind === "inferred" ? state.peer : null, "Klara 的 MacBook Air");
});

test("with no second device there is nothing to compare and nothing to infer", () => {
  for (const input of [
    { pairedSync: true, peers: [] },
    // Windows keeps credentials local: it never had a second channel to lose.
    { pairedSync: false, peers: PEERS },
    // A peer with no name is evidence, but half-naming it reads as evasion.
    { pairedSync: true, peers: [{ name: "   ", last_seen: 200 }] },
  ]) {
    const state = missingKeyState({
      missing: true,
      observedSince: 0,
      now: 10 * KEYCHAIN_GRACE_MS,
      ...input,
    });
    assert.equal(state.kind, "alone");
  }
});

test("only a model that wants a key can be missing one", () => {
  assert.equal(wantsMissingKeyNotice({ auth_mode: "api_key", provider: "openai" }, 0), true);
  assert.equal(wantsMissingKeyNotice({ auth_mode: "api_key", provider: "openai" }, 1), false);
  // Signed in with an account, not a key.
  assert.equal(wantsMissingKeyNotice({ auth_mode: "oauth", provider: "openai" }, 0), false);
  // Ollama authenticates with nothing, and does not reach a phone anyway.
  assert.equal(wantsMissingKeyNotice({ auth_mode: "api_key", provider: "ollama" }, 0), false);
});
