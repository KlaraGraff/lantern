import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The reader's profile is titled twice, by two languages of code.
//
// The profile page names each dimension from `profile.slot.<key>` in the i18n
// files. The prompt injection names it again in Rust — `injection_block` in
// `src-tauri/src/commands/profile.rs` writes one "name：conclusion" line per
// active card — and a *moved* card is titled a third time, by the frontend,
// which appends "name：conclusion" into the reader's own `user_text`. All
// three must agree, because they land in the same prompt: if Rust called a
// dimension "Lookup patterns" while the moved half of the same profile called
// it "查词取向", the model would be reading two vocabularies for one set of
// dimensions and would have no way to tell they were the same thing.
//
// Rust cannot read the JSON, and the JSON cannot read Rust, so the labels are
// written out on both sides. This test is the tripwire on that duplication:
// it fails on drift in either direction, and on a dimension added to one side
// and forgotten on the other.

const repoFile = (path: string) => new URL(`../${path}`, import.meta.url);
const readRepo = (path: string) => readFile(repoFile(path), "utf8");

interface RustDimension {
  key: string;
  labelZh: string;
  labelEn: string;
}

/**
 * Pull the dimension registry out of `profile.rs`.
 *
 * A regex over source rather than a generated file: the registry is seven
 * entries that change about never, and a build step that keeps two constants
 * in sync is a heavier thing to maintain than the test that catches them
 * drifting apart.
 */
function parseRustDimensions(source: string): RustDimension[] {
  const registry = source.match(/pub const DIMENSIONS: &\[Dimension\] = &\[([\s\S]*?)\n\];/);
  assert.ok(registry, "DIMENSIONS registry not found in profile.rs — has it been renamed?");
  const entries = registry[1].matchAll(
    /key: "([^"]+)",\s*\n\s*label_zh: "([^"]+)",\s*\n\s*label_en: "([^"]+)",/g,
  );
  return [...entries].map(([, key, labelZh, labelEn]) => ({ key, labelZh, labelEn }));
}

const [profileRs, zh, en] = await Promise.all([
  readRepo("src-tauri/src/commands/profile.rs"),
  readRepo("src/i18n/zh.json").then((raw) => JSON.parse(raw) as Record<string, string>),
  readRepo("src/i18n/en.json").then((raw) => JSON.parse(raw) as Record<string, string>),
]);
const dimensions = parseRustDimensions(profileRs);

test("the registry still holds the seven dimensions the feature is specified around", () => {
  // Seven is a product decision, not an implementation detail — see the plan
  // doc's Appendix A. An eighth card changes the page's layout and its
  // soft-limit arithmetic, so it should not arrive by accident.
  assert.equal(dimensions.length, 7);
  assert.deepEqual(dimensions.map((dim) => dim.key), [
    "vocab_explain",
    "syntax_explain",
    "reference_explain",
    "cultural_context",
    "lookup_pattern",
    "example_source",
    "reply_pacing",
  ]);
});

test("every dimension the prompt can title is one the reader has a name for", () => {
  for (const dim of dimensions) {
    const key = `profile.slot.${dim.key}`;
    assert.ok(key in zh, `${key} missing from zh.json`);
    assert.ok(key in en, `${key} missing from en.json`);
  }
});

test("Rust titles a card exactly the way the profile page does", () => {
  for (const dim of dimensions) {
    const key = `profile.slot.${dim.key}`;
    assert.equal(dim.labelZh, zh[key], `${key}: Rust label_zh has drifted from zh.json`);
    assert.equal(dim.labelEn, en[key], `${key}: Rust label_en has drifted from en.json`);
  }
});

test("both halves of a profile punctuate a title the same way", () => {
  // `label_separator` in Rust against `profile.move.separator` in the JSON.
  // Same reason as the labels: the injected card lines and the moved lines
  // sit in one block, and a full-width colon next to an ASCII one reads as
  // two different notations rather than one list.
  const separator = profileRs.match(
    /fn label_separator\(locale: &str\) -> &'static str \{\s*\n\s*if locale\.starts_with\("zh"\) \{\s*\n\s*"([^"]+)"\s*\n\s*\} else \{\s*\n\s*"([^"]+)"/,
  );
  assert.ok(separator, "label_separator not found in profile.rs — has it been renamed?");
  assert.equal(separator[1], zh["profile.move.separator"]);
  assert.equal(separator[2], en["profile.move.separator"]);
});

test("no profile.slot key survives a dimension that Rust no longer has", () => {
  // The other direction: a dimension removed from the registry leaves a card
  // name in the UI that nothing can ever populate.
  const keys = new Set(dimensions.map((dim) => `profile.slot.${dim.key}`));
  for (const locale of [zh, en]) {
    for (const key of Object.keys(locale)) {
      if (!key.startsWith("profile.slot.")) continue;
      assert.ok(keys.has(key), `${key} has no dimension in the Rust registry`);
    }
  }
});
