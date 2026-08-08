import assert from "node:assert/strict";
import test from "node:test";

import {
  abandonedDraftIds,
  isProfileConfigComplete,
  type ProfileConfig,
} from "../src/components/settings/ai-draft-profiles.ts";

function profile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    id: "p1",
    label: "DeepSeek",
    provider: "deepseek",
    auth_mode: "api_key",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    temperature: 0.3,
    ...overrides,
  };
}

test("a model with nothing in the model box is not a configuration yet", () => {
  assert.ok(isProfileConfigComplete(profile()));
  // The two ways the catalog hands over a half-built row.
  assert.ok(!isProfileConfigComplete(profile({ provider: "lmstudio", base_url: "http://localhost:1234", model: "" })));
  assert.ok(!isProfileConfigComplete(profile({ provider: "custom", base_url: "", model: "some-model" })));
  // Whitespace is not a model name.
  assert.ok(!isProfileConfigComplete(profile({ model: "   " })));
});

test("an unfinished model added in this sitting is taken back", () => {
  const blank = profile({ id: "blank", provider: "custom", base_url: "", model: "" });
  const ready = profile({ id: "ready" });

  assert.deepEqual(
    abandonedDraftIds({
      profiles: [blank, ready],
      drafts: new Set(["blank"]),
      keepId: null,
      credentialCount: () => 0,
    }),
    ["blank"],
  );
});

test("the card still open is left alone, however blank it is", () => {
  // The reader is looking at it and has not finished typing.
  const blank = profile({ id: "blank", provider: "custom", base_url: "", model: "" });

  assert.deepEqual(
    abandonedDraftIds({
      profiles: [blank],
      drafts: new Set(["blank"]),
      keepId: "blank",
      credentialCount: () => 0,
    }),
    [],
  );
});

test("a blank row holding a key survives, and so does one from an earlier session", () => {
  const withKey = profile({ id: "with-key", provider: "custom", base_url: "", model: "" });
  const older = profile({ id: "older", provider: "custom", base_url: "", model: "" });

  // A pasted key is the one thing here that clicking the catalog again cannot
  // reproduce, so an incomplete row that holds one is never removed.
  assert.deepEqual(
    abandonedDraftIds({
      profiles: [withKey],
      drafts: new Set(["with-key"]),
      keepId: null,
      credentialCount: (id) => (id === "with-key" ? 1 : 0),
    }),
    [],
  );

  // Nothing this pane did not add is ever removed behind the reader's back.
  assert.deepEqual(
    abandonedDraftIds({
      profiles: [older],
      drafts: new Set(),
      keepId: null,
      credentialCount: () => 0,
    }),
    [],
  );
});

test("a model that got finished is no longer a draft to take back", () => {
  // The pane drops an id from `drafts` the moment its configuration completes,
  // so emptying the model box again later cannot make the row disappear.
  const finished = profile({ id: "finished", provider: "lmstudio", base_url: "http://localhost:1234", model: "qwen3.5" });
  assert.ok(isProfileConfigComplete(finished));

  const emptiedAgain = { ...finished, model: "" };
  assert.deepEqual(
    abandonedDraftIds({
      profiles: [emptiedAgain],
      drafts: new Set(),
      keepId: null,
      credentialCount: () => 0,
    }),
    [],
  );
});
