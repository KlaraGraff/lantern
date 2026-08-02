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

const parsed = new Map(
  locales.map((locale) => [
    locale,
    JSON.parse(readFileSync(path.join(i18nDir, locale), "utf8")) as Record<string, string>,
  ]),
);

test("every locale carries the same keys", () => {
  const [reference, ...rest] = [...parsed.keys()];
  const expected = new Set(Object.keys(parsed.get(reference)!));
  for (const locale of rest) {
    const keys = new Set(Object.keys(parsed.get(locale)!));
    assert.deepEqual(
      [...expected].filter((key) => !keys.has(key)),
      [],
      `present in ${reference} but not ${locale}`,
    );
    assert.deepEqual(
      [...keys].filter((key) => !expected.has(key)),
      [],
      `present in ${locale} but not ${reference}`,
    );
  }
});

// i18next resolves a plural through suffixed siblings, so "vocab.wordCount" is
// declared as "vocab.wordCount_one" and "_other" and never under its own name.
const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];

function resolves(table: Record<string, string>, key: string): boolean {
  return key in table || PLURAL_SUFFIXES.some((suffix) => `${key}${suffix}` in table);
}

// Only literal keys. A key assembled from a template literal cannot be checked
// this way, and guessing at what it might expand to would cost more in false
// alarms than it could ever catch.
const LITERAL_KEY = /\bt\(\s*["']([A-Za-z0-9_.]+)["']/g;

const srcDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "../src");
const usedKeys = new Map<string, string>();
for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
  const file = path.join(entry.parentPath, entry.name);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(LITERAL_KEY)) {
    if (!usedKeys.has(match[1])) usedKeys.set(match[1], path.relative(srcDir, file));
  }
}

test("the scan actually reads the components", () => {
  // Without this, a change to how `t` is called would empty the scan and turn
  // the check below into one that passes on any locale file at all.
  assert.ok(usedKeys.size > 100, `only found ${usedKeys.size} keys in ${srcDir}`);
});

test("every key the UI asks for is translated in every locale", () => {
  // A missing key does not fail loudly: i18next echoes the key back, or renders
  // whatever `defaultValue` says — and a hardcoded Chinese default reads as
  // working right up until someone opens the app in English.
  const missing: string[] = [];
  for (const [key, file] of usedKeys) {
    for (const [locale, table] of parsed) {
      if (!resolves(table, key)) missing.push(`${key} (${file}) — missing from ${locale}`);
    }
  }
  assert.deepEqual(missing, [], `untranslated keys:\n  ${missing.join("\n  ")}`);
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
