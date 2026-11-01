import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { presetDeleteConfirm } from "../src/components/settings/presetDeletion.ts";
import {
  BUILT_IN_BOOK_SOURCES,
  bookSourceDeleteKind,
  resolveBookSources,
  restoreBuiltInBookSources,
  serializeBookSources,
  type BookSource,
} from "../src/components/book-sources.ts";
import {
  compactTokens,
  groupJobsByFamily,
  needsUnit,
  type AutoAnalysisJobView,
} from "../src/components/settings/auto-analysis.ts";
import { abandonedDraftIds, type ProfileConfig } from "../src/components/settings/ai-draft-profiles.ts";

/**
 * Guards for the decisions the settings panes in this shard delegate to pure
 * helpers. Each case spells out the argument expression the component builds,
 * so a wiring mistake there (the kind that once let a user's own book source be
 * deleted without a warning) fails here even though the pane itself needs a DOM.
 */

const userSource: BookSource = {
  id: "user:3f1c",
  name: "My site",
  url: "https://example.com/",
  kind: "library",
};

function userSourceAt(index: number): BookSource {
  return { ...userSource, id: `user:${index}`, name: `Site ${index}` };
}

test("book sources: a user's own site is never deleted without a warning", () => {
  // BookSourcesSettings.requestDelete passes exactly these two arguments.
  const list = [...BUILT_IN_BOOK_SOURCES, userSource];
  const confirmation = presetDeleteConfirm(
    bookSourceDeleteKind(userSource.id),
    list.length <= 1,
    "sources",
    userSource.name,
  );
  assert.ok(confirmation, "deleting a site the user typed must ask first");
  assert.equal(confirmation.nameParam, userSource.name);

  // A built-in among many stays a one-click delete: restore brings it back.
  assert.equal(
    presetDeleteConfirm(
      bookSourceDeleteKind(BUILT_IN_BOOK_SOURCES[0].id),
      list.length <= 1,
      "sources",
    ),
    null,
  );

  // Deleting the last remaining entry warns about the empty state instead.
  const lastOne = [userSource];
  assert.equal(
    presetDeleteConfirm(bookSourceDeleteKind(userSource.id), lastOne.length <= 1, "sources", userSource.name)
      ?.titleKey,
    "settings.presets.deleteLastTitle",
  );
});

test("book sources: a device with no stored list shows the built-ins without owning them", () => {
  assert.deepEqual(resolveBookSources(undefined), [...BUILT_IN_BOOK_SOURCES]);
});

test("book sources: restoring from the empty state brings the whole catalog back", () => {
  // The empty-state button calls restoreBuiltInBookSources(sources) with [].
  assert.deepEqual(restoreBuiltInBookSources([]), [...BUILT_IN_BOOK_SOURCES]);
  // …and an entry the user typed survives a restore from a mixed list.
  const restored = restoreBuiltInBookSources([userSourceAt(1), userSourceAt(2)]);
  assert.deepEqual(
    restored.filter((source) => !source.id.startsWith("builtin:")),
    [userSourceAt(1), userSourceAt(2)],
  );
});

test("card design: an emptied module list is the only built-in delete worth a dialog", () => {
  // CardDesignSettings.requestDelete passes `value.modules.length <= 1`.
  const amongSeveral = 5 <= 1;
  const onlyOne = 1 <= 1;
  assert.equal(
    presetDeleteConfirm("builtin", amongSeveral, "card", "Collocations"),
    null,
    "removing one built-in module among several is reversible, so no dialog",
  );
  assert.equal(
    presetDeleteConfirm("builtin", onlyOne, "card", "Collocations")?.titleKey,
    "settings.presets.deleteLastTitle",
  );
  assert.ok(
    presetDeleteConfirm("custom", amongSeveral, "card", "My module"),
    "a module the user wrote is worth confirming while others remain",
  );
});

function job(id: string, trigger: string): AutoAnalysisJobView {
  return {
    id,
    trigger,
    enabled: true,
    autoCalls: 0,
    autoTokens: 0,
    manualRuns: 0,
    recommendAuto: false,
  };
}

test("auto-analysis console: every job the backend lists reaches a group", () => {
  const jobs = [
    job("grounding_context", "book_imported"),
    job("person_aliases", "book_imported"),
    job("reading_review", "book_finished"),
    job("review_pile_curation", "daily"),
    job("followup_difficulty", "batch"),
    job("user_profile", "batch"),
  ];
  const grouped = groupJobsByFamily(jobs);
  assert.deepEqual(grouped.map(([family]) => family), ["retrieval", "review", "personalization"]);
  assert.equal(
    grouped.flatMap(([, entries]) => entries).length,
    jobs.length,
    "no row may be dropped — a switch the reader cannot see is one they cannot turn off",
  );
});

test("auto-analysis console: the unit word appears exactly at one whole unit", () => {
  for (const [step, scale] of [[10_000, "wan"], [1_000, "k"]] as const) {
    assert.equal(needsUnit(step - 1, scale), false, "below the unit the raw count is shown");
    assert.equal(needsUnit(step, scale), true, "at the unit the word is needed");
    assert.equal(compactTokens(step, scale), "1.0");
    assert.equal(compactTokens(step - 1, scale), String(step - 1));
  }
});

function profile(overrides: Partial<ProfileConfig> & { id: string }): ProfileConfig {
  return {
    label: "DeepSeek",
    provider: "deepseek",
    auth_mode: "api_key",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    temperature: 0.3,
    ...overrides,
  };
}

test("ai settings: a blank draft holding a pasted key is never taken back", () => {
  const blank = profile({ id: "blank", provider: "custom", base_url: "", model: "" });
  const keys: Record<string, number> = { blank: 1 };

  assert.deepEqual(
    abandonedDraftIds({
      profiles: [blank],
      drafts: new Set(["blank"]),
      keepId: null,
      credentialCount: (id) => keys[id] ?? 0,
    }),
    [],
    "a key the reader pasted cannot be recovered by clicking the catalog again",
  );

  assert.deepEqual(
    abandonedDraftIds({
      profiles: [blank],
      drafts: new Set(["blank"]),
      keepId: null,
      credentialCount: () => 0,
    }),
    ["blank"],
  );
});

/**
 * `BookSourcesSettings.persist` is the only writer of `book_sources`, and it is
 * an arrow function in a `.tsx` file, so it is lifted out of the source with
 * the same AST trick `settings-save-errors-surfaces.test.ts` uses — no JSX is
 * evaluated, only the function body, with its imports stubbed.
 */
function sourceArrow(file: string, name: string, globals: Record<string, unknown>) {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) {
      expression = node.initializer!.getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(expression, `${name} not found in ${file}`);
  return runInNewContext(ts.transpile(`const fn = ${expression};\nfn;`, { target: ts.ScriptTarget.ES2022 }), globals);
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a rejected book-sources save is reported and the list falls back to what was stored", async () => {
  const stored = serializeBookSources([userSource]);
  const rendered: BookSource[][] = [];
  const toasts: (string | undefined)[] = [];
  const persist = sourceArrow("src/components/settings/BookSourcesSettings.tsx", "persist", {
    BOOK_SOURCES_KEY: "book_sources",
    resolveBookSources,
    serializeBookSources,
    settings: { book_sources: stored },
    t: (key: string) => key,
    showSavedToast: (message?: string) => toasts.push(message),
    console: { error() {} },
    saveBulk: () => Promise.reject(new Error("disk full")),
    setSources: (next: BookSource[]) => rendered.push(next),
  });

  persist([...BUILT_IN_BOOK_SOURCES, userSource]);

  // The new list is shown while the write is in flight…
  assert.deepEqual(rendered[0], [...BUILT_IN_BOOK_SOURCES, userSource]);
  await settle();

  // …and when the write fails the pane must not keep claiming it succeeded.
  assert.deepEqual(
    rendered[rendered.length - 1],
    [userSource],
    "a failed save leaves the pane showing entries the database never received",
  );
  assert.deepEqual(toasts, ["readerSettings.scope.actionFailed"], "the reader is told the save failed");
});

function autoAnalysisHandler(name: string, globals: Record<string, unknown>) {
  return sourceArrow("src/components/settings/AutoAnalysisSettings.tsx", name, globals);
}

test("a job switch that fails to save re-reads the console instead of claiming it moved", async () => {
  const events: string[] = [];
  const setEnabled = autoAnalysisHandler("setEnabled", {
    invoke: async () => { throw new Error("database is locked"); },
    load: async () => { events.push("load"); },
    setBusy: (value: string | null) => events.push(`busy:${value}`),
    console: { error() {} },
  });

  await setEnabled("reading_review", false);

  // The stored value never changed, so the row has to be re-read from it —
  // otherwise the console shows a switch that did nothing.
  assert.deepEqual(events, ["busy:reading_review", "load", "busy:null"]);
});

test("turning everything off keeps going after one job fails, then re-reads", async () => {
  const calls: string[] = [];
  let loadCount = 0;
  const turnEverythingOff = autoAnalysisHandler("turnEverythingOff", {
    data: { jobs: [{ id: "a", enabled: true }, { id: "b", enabled: true }, { id: "c", enabled: false }] },
    invoke: async (_command: string, args: { jobId: string }) => {
      calls.push(args.jobId);
      if (args.jobId === "a") throw new Error("database is locked");
    },
    load: async () => { loadCount += 1; },
    setBusy: () => {},
    console: { error() {} },
  });

  await turnEverythingOff();

  assert.deepEqual(calls, ["a", "b"], "a failing job must not cancel the ones after it");
  assert.equal(loadCount, 1, "the rows shown afterwards must be the stored ones");
});
