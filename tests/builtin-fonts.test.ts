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

const { builtinFontFaceCss, builtinFonts, cjkFontFaceCss, CJK_SERIF, CJK_SANS } =
  await import("../src/components/builtin-fonts.ts");
const { fonts, cjkFonts, getFontFamily } = await import("../src/components/reader-settings.ts");
type ReaderFont = Parameters<typeof getFontFamily>[0];

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

test("every chain names an isolated CJK face instead of leaving Chinese to the generic keyword", () => {
  // No face the picker offers has a CJK glyph — not the bundled ones, and not
  // Georgia, Palatino or Times either — so Chinese always falls through.
  // Unnamed, that lands on SimSun under Windows, which goes soft at reading
  // sizes. Serif families get a serif CJK face, sans families a gothic one.
  const offered = fonts.filter((font) => font.group !== "custom");
  assert.ok(offered.length > builtinFonts.length, "expected system faces alongside the bundled ones");
  for (const font of offered) {
    const stack = getFontFamily(font.id);
    const expected = stack.includes("serif") && !stack.includes("sans-serif") ? CJK_SERIF : CJK_SANS;
    assert.ok(stack.includes(expected), `${font.label} chain is missing ${expected}: ${stack}`);
    // The named face has to precede the generic keyword, or it never gets there.
    const generic = stack.includes("sans-serif") ? "sans-serif" : "serif";
    assert.ok(
      stack.indexOf(expected) < stack.lastIndexOf(generic),
      `${font.label} names a CJK face after the generic keyword: ${stack}`,
    );
  }
});

test("no Latin chain names a bare system CJK face ahead of the generic keyword", () => {
  // This is the bug the unicode-range isolation fixes: `Georgia, "Songti SC",
  // serif` matches per character, so on a machine missing Georgia the Latin
  // letters fall to Songti's own (thin, badly-spaced) Latin glyphs instead of
  // the `serif` keyword. Only the fenced wrapper family (`CJK_SERIF` /
  // `CJK_SANS`, already asserted present above) may appear — never the raw
  // system face names the wrapper's `@font-face` resolves to internally.
  const rawSystemFaces = ["Songti SC", "SimSun", "PingFang SC", "Microsoft YaHei"];
  for (const font of fonts.filter((entry) => entry.group !== "custom")) {
    const stack = getFontFamily(font.id);
    for (const raw of rawSystemFaces) {
      assert.ok(!stack.includes(raw), `${font.label} chain names the bare system face "${raw}": ${stack}`);
    }
  }
});

test("getFontFamily's two-argument form orders Latin, then CJK, then the generic keyword", () => {
  const georgiaSystemSans = getFontFamily("georgia", "system-sans");
  assert.equal(georgiaSystemSans, `Georgia, ${CJK_SANS}, serif`);
  assert.ok(georgiaSystemSans.indexOf("Georgia") < georgiaSystemSans.indexOf(CJK_SANS));
  assert.ok(georgiaSystemSans.indexOf(CJK_SANS) < georgiaSystemSans.lastIndexOf("serif"));

  // Omitting cjkId keeps the baked-in chain, so the single-argument call sites
  // in marker-style.ts and useFoliateAnnotations.ts render exactly as before.
  assert.equal(getFontFamily("inter"), `"Inter", system-ui, ${CJK_SANS}, sans-serif`);
});

test("the Chinese setting wins over the Latin font's own CJK pairing", () => {
  // The baked-in CJK segment tracks the Latin font — sans for Inter, serif for
  // Georgia. Once the two are set separately, that pairing must not leak: the
  // label says 系统宋体, so picking it has to produce the serif face even on a
  // sans Latin font, and the Chinese font must not shift when the Latin one does.
  assert.equal(getFontFamily("inter", "system"), `"Inter", system-ui, ${CJK_SERIF}, sans-serif`);
  assert.equal(getFontFamily("georgia", "system"), `Georgia, ${CJK_SERIF}, serif`);

  const cjkOf = (stack: string) => (stack.includes(CJK_SERIF) ? "serif" : "sans");
  for (const latin of ["inter", "georgia", "literata", "system"] as const) {
    assert.equal(cjkOf(getFontFamily(latin, "system")), "serif", `${latin} + system should be serif`);
    assert.equal(cjkOf(getFontFamily(latin, "system-sans")), "sans", `${latin} + system-sans should be sans`);
  }
});

test("an imported Latin font still leaves a CJK slot for the Chinese setting to fill", () => {
  // A custom chain used to be `<custom>, serif` with no CJK segment at all, so
  // the splice had nothing to replace and the Chinese picker silently did
  // nothing for anyone reading in an imported font.
  const stack = getFontFamily("custom-1234" as ReaderFont, "system-sans");
  assert.ok(stack.includes(CJK_SANS), `custom chain dropped the Chinese selection: ${stack}`);
  assert.ok(stack.indexOf(CJK_SANS) < stack.lastIndexOf("serif"), `CJK must precede the generic keyword: ${stack}`);
});

test("the enhanced CJK option leads its chain, with the system face behind it as fallback", () => {
  const chain = cjkFonts.find((font) => font.id === "enhanced")?.family;
  assert.ok(chain, "expected an \"enhanced\" entry in cjkFonts");
  assert.ok(chain!.includes(CJK_SERIF), `enhanced chain is missing the system serif fallback: ${chain}`);
  assert.ok(chain!.includes("Lantern Enhanced Chinese Serif"), `enhanced chain is missing the pack: ${chain}`);
  // Both faces are fenced to the same CJK codepoints, so whichever is listed
  // first wins every character they share. Behind the system face the pack
  // would only surface for glyphs the OS lacks — an option that visibly did
  // nothing for the reader who deliberately downloaded it.
  assert.ok(
    chain!.indexOf("Lantern Enhanced Chinese Serif") < chain!.indexOf(CJK_SERIF),
    `the enhanced pack must precede the system CJK family: ${chain}`,
  );

  // Spliced into an actual Latin chain, the same order has to survive: Latin
  // family, the pack, the system CJK fallback, then the generic keyword.
  const stack = getFontFamily("georgia", "enhanced");
  assert.equal(stack, `Georgia, "Lantern Enhanced Chinese Serif", ${CJK_SERIF}, serif`);
});

test("cjkFontFaceCss declares both isolated wrapper faces with a CJK-only unicode-range", () => {
  const css = cjkFontFaceCss();
  assert.equal(css.split("@font-face").length - 1, 2, "expected exactly the serif and sans wrapper faces");
  for (const family of [CJK_SERIF, CJK_SANS]) {
    assert.ok(css.includes(`font-family: ${family}`), `cjkFontFaceCss is missing ${family}`);
  }
  // Every rule fences itself to CJK-ish codepoints, never the full Unicode
  // range a plain `local()` face would otherwise be free to claim.
  const ranges = [...css.matchAll(/unicode-range: ([^;]+);/g)].map((match) => match[1]);
  assert.equal(ranges.length, 2);
  for (const range of ranges) {
    assert.ok(range.includes("U+2E80-9FFF"), `unicode-range missing the CJK block: ${range}`);
    assert.ok(!range.includes("U+0000"), `unicode-range should not claim the Latin block: ${range}`);
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
