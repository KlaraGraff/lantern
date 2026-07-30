import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

// builtin-fonts resolves font URLs against the window origin. Node has no DOM,
// and the origin is all the URL builder touches. Deliberately pretend we are
// sitting on a reader route: the app routes by path, and font URLs must not
// come out relative to it.
(globalThis as { window?: unknown }).window = {
  location: { origin: "http://localhost:1420", href: "http://localhost:1420/reader/42" },
};

const { builtinFontFaceCss, builtinFonts } = await import("../src/components/builtin-fonts.ts");
const { fonts, getFontFamily } = await import("../src/components/reader-settings.ts");

const fontsDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "../public/fonts");
const onDisk = readdirSync(fontsDir).filter((name) => name.endsWith(".woff2"));

function referencedFiles(): string[] {
  return [...builtinFontFaceCss().matchAll(/url\("([^"]+)"\)/g)]
    .map((match) => path.basename(new URL(match[1]).pathname));
}

test("font URLs are absolute from the root, not relative to whatever route we are on", () => {
  // Foliate chapters live in blob: iframes and install their faces while the
  // app sits on /reader/<id>. A route-relative URL would 404 there — silently,
  // since the fallback font just takes over.
  const urls = [...builtinFontFaceCss().matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.ok(url.startsWith("http://localhost:1420/fonts/"), `not rooted at /fonts: ${url}`);
  }
});

test("font URLs survive the tauri:// scheme macOS packages are served from", () => {
  // location.origin is the opaque string "null" for non-special schemes, so
  // building URLs from the origin would work in dev and break once packaged.
  const stub = globalThis as { window?: { location: { href: string } } };
  const dev = stub.window!.location.href;
  try {
    stub.window!.location.href = "tauri://localhost/reader/42";
    const [, first] = builtinFontFaceCss().match(/url\("([^"]+)"\)/)!;
    assert.equal(first, "tauri://localhost/fonts/literata-normal-400-700-latin.woff2");
  } finally {
    stub.window!.location.href = dev;
  }
});

test("every declared font face points at a file we actually ship", () => {
  const missing = referencedFiles().filter((file) => !onDisk.includes(file));
  assert.deepEqual(missing, [], `declared but absent from public/fonts: ${missing.join(", ")}`);
});

test("every shipped font file is declared, so none is dead weight in the bundle", () => {
  const referenced = new Set(referencedFiles());
  const orphans = onDisk.filter((file) => !referenced.has(file));
  assert.deepEqual(orphans, [], `shipped but never declared: ${orphans.join(", ")}`);
});

test("each family ships the OFL text its licence requires us to distribute", () => {
  const licences = readdirSync(path.join(fontsDir, "licenses"));
  for (const font of builtinFonts) {
    assert.ok(licences.includes(`${font.slug}-OFL.txt`), `missing licence for ${font.label}`);
  }
});

test("faces cover both subsets, and real italics where the family has them", () => {
  for (const font of builtinFonts) {
    const css = builtinFontFaceCss([font]);
    const styles = font.italic ? 2 : 1;
    const weights = font.variable ? 1 : 2;
    assert.equal(
      css.split("@font-face").length - 1,
      styles * weights * 2, // latin + latin-ext
      `unexpected face count for ${font.label}`,
    );
    assert.equal(css.includes("font-style: italic"), font.italic, `italic mismatch for ${font.label}`);
  }
});

test("built-in fonts reach the reader picker with a quoted family and a fallback", () => {
  for (const font of builtinFonts) {
    const option = fonts.find((entry) => entry.id === font.id);
    assert.ok(option, `${font.label} missing from the reader font list`);
    assert.equal(option.group, "built-in");
    assert.equal(getFontFamily(font.id), `"${font.label}", ${font.fallback}`);
  }
});

test("every chain names a CJK face instead of leaving Chinese to the generic keyword", () => {
  // No face the picker offers has a CJK glyph — not the bundled ones, and not
  // Georgia, Palatino or Times either — so Chinese always falls through.
  // Unnamed, that lands on SimSun under Windows, which goes soft at reading
  // sizes. Serif families get a serif CJK face, sans families a gothic one.
  const offered = fonts.filter((font) => font.group !== "custom");
  assert.ok(offered.length > builtinFonts.length, "expected system faces alongside the bundled ones");
  for (const font of offered) {
    const stack = getFontFamily(font.id);
    const expected = stack.includes("serif") && !stack.includes("sans-serif")
      ? ["Songti SC", "SimSun"]
      : ["PingFang SC", "Microsoft YaHei"];
    for (const face of expected) {
      assert.ok(stack.includes(face), `${font.label} chain is missing ${face}: ${stack}`);
    }
    // The named faces have to precede the generic keyword, or it never gets there.
    const generic = stack.includes("sans-serif") ? "sans-serif" : "serif";
    assert.ok(
      stack.indexOf(expected[0]) < stack.lastIndexOf(generic),
      `${font.label} names a CJK face after the generic keyword: ${stack}`,
    );
  }
});

test("nothing claims to be built-in without shipping a file", () => {
  // "Inter" sat in the built-in group for a long time while no Inter file was
  // ever bundled, so it silently rendered as the system sans. Anything labelled
  // built-in has to be backed by files the tests above verify are on disk.
  const shipped = new Set(builtinFonts.map((font) => font.id));
  const unbacked = fonts.filter((font) => font.group === "built-in" && !shipped.has(font.id));
  assert.deepEqual(
    unbacked.map((font) => font.label),
    [],
    "listed as built-in but nothing ships for it",
  );
});

test("unknown font ids still fall back instead of yielding an empty family", () => {
  assert.equal(getFontFamily("no-such-font"), "Inter, system-ui, sans-serif");
});
