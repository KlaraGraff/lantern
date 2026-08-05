import assert from "node:assert/strict";
import test from "node:test";

import {
  addPendingWrites,
  appliedSnapshot,
  groupsToRehydrate,
  rehydrationKeys,
  removePendingWrites,
  type RehydrationGroup,
} from "../src/components/settings/settings-rehydration.ts";

const groups: readonly RehydrationGroup[] = [
  { id: "markerVisibility", keys: ["show_lookup_markers", "show_new_vocab_markers"] },
  { id: "markerStyle", keys: ["marker_style"] },
  { id: "cards", keys: ["learning_card_config", "show_translation"] },
];

test("a settings map that says what the pane already applied changes nothing", () => {
  const stored = { show_lookup_markers: "true", marker_style: "{}", learning_card_config: "{}" };
  assert.deepEqual(
    groupsToRehydrate({ groups, stored, applied: { ...stored }, pending: [] }),
    [],
  );
});

test("only the group whose keys actually moved is re-read", () => {
  const applied = { show_lookup_markers: "true", marker_style: "{}", learning_card_config: "{}" };
  assert.deepEqual(
    groupsToRehydrate({
      groups,
      stored: { ...applied, show_lookup_markers: "false" },
      applied,
      pending: [],
    }),
    ["markerVisibility"],
  );
});

test("a key with no row yet counts as changed once one appears", () => {
  assert.deepEqual(
    groupsToRehydrate({ groups, stored: { marker_style: "{}" }, applied: {}, pending: [] }),
    ["markerStyle"],
  );
  // Absent on both sides is not a change — an untouched default must not keep
  // re-triggering on every unrelated write.
  assert.deepEqual(groupsToRehydrate({ groups, stored: {}, applied: {}, pending: [] }), []);
});

test("a group with a write of the pane's own in flight is left alone", () => {
  // The echo of an earlier write can land after the user has already moved the
  // control again. `stored` disagreeing with `applied` is exactly what that
  // looks like, so the pending key — not the disagreement — decides.
  const applied = { show_lookup_markers: "false", show_new_vocab_markers: "true" };
  assert.deepEqual(
    groupsToRehydrate({
      groups,
      stored: { show_lookup_markers: "true", show_new_vocab_markers: "true" },
      applied,
      pending: ["show_lookup_markers"],
    }),
    [],
  );
});

test("one pending key holds its whole group, not just itself", () => {
  const applied = { learning_card_config: "{}", show_translation: "true" };
  assert.deepEqual(
    groupsToRehydrate({
      groups,
      stored: { learning_card_config: "{\"v\":1}", show_translation: "false" },
      applied,
      pending: ["show_translation"],
    }),
    [],
  );
});

test("a blocked group stays blocked, and its neighbours do not", () => {
  const applied = { learning_card_config: "{}", marker_style: "{}" };
  const stored = { learning_card_config: "{\"v\":1}", marker_style: "{\"v\":1}" };
  assert.deepEqual(
    groupsToRehydrate({ groups, stored, applied, pending: [], blocked: ["cards"] }),
    ["markerStyle"],
  );
  assert.deepEqual(
    groupsToRehydrate({ groups, stored, applied, pending: [], blocked: [] }),
    ["markerStyle", "cards"],
  );
});

test("re-read groups report every key they were built from", () => {
  assert.deepEqual(rehydrationKeys(groups, ["cards", "markerStyle"]), [
    "marker_style",
    "learning_card_config",
    "show_translation",
  ]);
  assert.deepEqual(rehydrationKeys(groups, []), []);
});

test("the snapshot records absent keys as absent rather than dropping them", () => {
  const snapshot = appliedSnapshot(["marker_style", "show_translation"], { marker_style: "{}" });
  assert.deepEqual(snapshot, { marker_style: "{}", show_translation: undefined });
  assert.equal("show_translation" in snapshot, true);
});

test("overlapping writes keep a key pending until the last of them settles", () => {
  const pending = new Map<string, number>();
  addPendingWrites(pending, ["marker_style", "show_translation"]);
  addPendingWrites(pending, ["marker_style"]);
  removePendingWrites(pending, ["marker_style", "show_translation"]);
  assert.deepEqual([...pending.keys()], ["marker_style"]);
  removePendingWrites(pending, ["marker_style"]);
  assert.deepEqual([...pending.keys()], []);
  // A release with no matching write must not leave a negative count behind
  // that swallows the next real one.
  removePendingWrites(pending, ["marker_style"]);
  addPendingWrites(pending, ["marker_style"]);
  assert.deepEqual([...pending.keys()], ["marker_style"]);
});
