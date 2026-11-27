import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * With no display name set, the sidebar and the settings field show a default
 * name. It was the English literal "Reader" in both places, so the Chinese UI
 * showed English there. The components cannot be mounted here, so what is
 * pinned is that the fallback goes through the locale files, and that the
 * settings field never saves that fallback as if the reader had typed it.
 */
const read = (file: string) => readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const KEY = "settings.general.displayNameDefault";

test("the default display name is translated", () => {
  const en = JSON.parse(read("src/i18n/en.json")) as Record<string, string>;
  const zh = JSON.parse(read("src/i18n/zh.json")) as Record<string, string>;
  assert.equal(en[KEY], "Reader");
  assert.equal(zh[KEY], "读者");
});

for (const file of ["src/components/Sidebar.tsx", "src/components/settings/GeneralSettings.tsx"]) {
  test(`${file} shows the localized fallback, not an English literal`, () => {
    const source = read(file);
    assert.doesNotMatch(source, /"Reader"/);
    assert.match(source, new RegExp(`t\\("${KEY.replaceAll(".", "\\.")}"\\)`));
  });
}

test("leaving the untouched field does not save the fallback as the name", () => {
  const source = read("src/components/settings/GeneralSettings.tsx");
  const start = source.indexOf("onBlur={() => {\n            const draft = displayNameDraftRef.current.value;");
  assert.ok(start >= 0, "no display-name blur handler found");
  const handler = source.slice(start, source.indexOf('void persist("user_name"', start));
  // The draft stays null until a name is loaded or typed.
  assert.match(handler, /if \(draft === null\) return;/);
  assert.match(source, /useRef<\{ value: string \| null; dirty: boolean \}>\(\{ value: null, dirty: false \}\)/);
});
