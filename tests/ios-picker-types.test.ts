import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The iOS file picker fails by omission. `parseFiltersOption` in
// tauri-plugin-dialog's DialogPlugin.swift maps every extension Lantern passes
// through `UTType(filenameExtension:)` and simply skips the ones that return
// nil — no error, no log, no crash. The file is greyed out in the picker and
// the reader is told nothing. That is why adding a format to the mobile
// importable list is a two-part change, and why the second part is so easy to
// forget: everything still builds, and it still works on the desktop.
//
// So the invariant this file guards is not "the plist has some keys in it". It
// is: every extension the phone offers must be a type iOS can actually name.
//
// What is NOT verified here, and is owed a look on a device: that iOS resolves
// these declarations at runtime and the files stop being greyed out. That needs
// a real .fb2/.cbz sitting in Files.app, which cannot be staged from a test.
// See also the known limitation recorded in the plist comment — another comic
// reader that has claimed .cbz under its own identifier can still win the
// typing, and this declaration cannot do anything about that.

const repoFile = (path: string) => new URL(`../${path}`, import.meta.url);
const readRepo = (path: string) => readFile(repoFile(path), "utf8");

const PLIST = "src-tauri/gen/apple/lantern_iOS/Info.plist";
const FORMATS = "src-tauri/src/commands/books/mod.rs";

// Types Apple ships. Anything here needs no declaration from us; anything not
// here does. Kept as a literal because the alternative is asking the host
// machine, and the answer must be the same on CI, which has no such database.
const SYSTEM_TYPES = new Set([
  "epub",
  "pdf",
  "txt",
  "md",
  "markdown",
  "html",
  "htm",
]);

const mobileExtensions = (rust: string): string[] => {
  const block =
    /#\[cfg\(any\(target_os = "ios", target_os = "android"\)\)\]\s*pub\(super\) const IMPORTABLE_BOOK_EXTENSIONS: &\[&str\] = &\[([\s\S]*?)\];/.exec(
      rust,
    );
  assert.ok(block, `${FORMATS} must cfg-gate IMPORTABLE_BOOK_EXTENSIONS for mobile`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
};

const declaredExtensions = (plist: string): string[] => {
  const block = /<key>UTImportedTypeDeclarations<\/key>\s*<array>([\s\S]*?)\n\t<\/array>/.exec(
    plist,
  );
  if (!block) return [];
  return [
    ...block[1].matchAll(
      /<key>public\.filename-extension<\/key>\s*<array>([\s\S]*?)<\/array>/g,
    ),
  ].flatMap((spec) => [...spec[1].matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]));
};

test("every format the phone offers is a type iOS can name", async () => {
  const [plist, rust] = await Promise.all([readRepo(PLIST), readRepo(FORMATS)]);
  const declared = new Set(declaredExtensions(plist));

  for (const ext of mobileExtensions(rust)) {
    assert.ok(
      SYSTEM_TYPES.has(ext) || declared.has(ext),
      `.${ext} is offered to the iOS picker but has no system UTType and no ` +
        `UTImportedTypeDeclarations entry — it will be silently greyed out. ` +
        `Either declare it in ${PLIST} or drop it from the mobile list.`,
    );
  }
});

test("the MOBI family stays out of the mobile picker", async () => {
  const rust = await readRepo(FORMATS);
  const offered = new Set(mobileExtensions(rust));

  // Not a style preference. MOBI imports read-only on iOS — no text selection,
  // so no lookup, no vocabulary, none of the AI tools, because all of those
  // sit on the EPUB that Calibre would have produced and no subprocess runs
  // here. Whether to offer that degraded book at all is a product decision
  // recorded in docs/roadmap/mobile-ios.md; until it is made, the answer is no,
  // and this asserts the answer rather than letting a UTI declaration quietly
  // reverse it.
  for (const ext of ["mobi", "azw", "azw3"]) {
    assert.ok(!offered.has(ext), `.${ext} must not be offered on mobile`);
  }
});

test("the declarations are imported, never exported", async () => {
  const plist = await readRepo(PLIST);

  // Exported means "Lantern is the authority on this format". It is not:
  // FictionBook and the comic-book archive both predate it. Getting this
  // backwards would invite other apps to conform to Lantern's identifiers.
  assert.match(plist, /<key>UTImportedTypeDeclarations<\/key>/);
  assert.doesNotMatch(plist, /<key>UTExportedTypeDeclarations<\/key>/);

  // A declaration with no conformance is inert, and one that claims the wrong
  // parent is worse: .fbz and .cbz are zip containers, .fb2 is bare XML.
  for (const parent of ["public.xml", "public.zip-archive"]) {
    assert.match(plist, new RegExp(`<string>${parent.replace(".", "\\.")}</string>`));
  }
});
