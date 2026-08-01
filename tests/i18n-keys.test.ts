import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

// JSON.parse keeps the last occurrence of a repeated key and drops the rest
// without a word, so a duplicate costs nothing at runtime and stays invisible
// in review. The damage is to whoever greps for a string later: they find the
// dead copy, edit it, and watch the UI ignore them. "settings.appearance.title"
// sat duplicated in both locales for a while for exactly that reason.
const i18nDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "../src/i18n");
const locales = readdirSync(i18nDir).filter((name) => name.endsWith(".json"));

// The locale files are flat: one "key": "value" pair per line. Parsing cannot
// reveal duplicates — they are already collapsed by then — so read the keys off
// the raw text instead.
function declaredKeys(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:/))
    .filter((match) => match !== null)
    .map((match) => match[1]);
}

test("locale files exist to be checked at all", () => {
  // Guards against a rename quietly turning every test below into a no-op.
  assert.ok(locales.length > 0, `no locale JSON found in ${i18nDir}`);
});

for (const locale of locales) {
  const source = readFileSync(path.join(i18nDir, locale), "utf8");

  test(`${locale} declares each key exactly once`, () => {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    for (const key of declaredKeys(source)) {
      if (seen.has(key)) duplicated.add(key);
      seen.add(key);
    }
    assert.deepEqual(
      [...duplicated],
      [],
      `declared more than once — every copy but the last is dead: ${[...duplicated].join(", ")}`,
    );
  });

  test(`${locale} stays flat enough for the duplicate scan to see every key`, () => {
    // The scan reads one key per line. If the file ever nests its keys or packs
    // several onto a line, it would stop finding them and the check above would
    // pass no matter what. Parsing agrees on the count only while that holds.
    const scanned = new Set(declaredKeys(source));
    const parsed = Object.keys(JSON.parse(source) as Record<string, unknown>);
    assert.equal(
      scanned.size,
      parsed.length,
      "line scan and JSON.parse disagree on the key count — the file shape changed and the duplicate check above is no longer reliable",
    );
  });
}
