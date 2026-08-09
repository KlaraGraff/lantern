import { test } from "node:test";
import assert from "node:assert/strict";

const {
  AUTO_LINE_SPACING_CJK,
  AUTO_LINE_SPACING_LATIN,
  paragraphSpacingConflictsWithIndent,
  paragraphStyleMode,
  parseLineSpacing,
  resolveLineSpacing,
  withFirstLineIndent,
  withParagraphSpacing,
} = await import("../src/components/reader-paragraph-settings.ts");

test("turning the indent on clears a paragraph gap that would double up with it", () => {
  for (const spacing of ["compact", "comfortable", "loose"] as const) {
    const next = withFirstLineIndent(true, { firstLineIndent: false, paragraphSpacing: spacing });
    assert.equal(next.firstLineIndent, true);
    assert.equal(next.paragraphSpacing, "none", `${spacing} should have been pushed to none`);
  }
});

test("the indent leaves the two neutral spacing values alone", () => {
  // `original` means "I have not said" and `none` is what the indent tradition
  // wants anyway — neither is a competing answer to "did the paragraph end".
  for (const spacing of ["original", "none"] as const) {
    const next = withFirstLineIndent(true, { firstLineIndent: false, paragraphSpacing: spacing });
    assert.equal(next.paragraphSpacing, spacing);
  }
});

test("turning the indent off never touches the paragraph gap", () => {
  const next = withFirstLineIndent(false, { firstLineIndent: true, paragraphSpacing: "none" });
  assert.deepEqual(next, { firstLineIndent: false, paragraphSpacing: "none" });
});

test("choosing a real paragraph gap turns the indent off", () => {
  for (const spacing of ["compact", "comfortable", "loose"] as const) {
    const next = withParagraphSpacing(spacing, { firstLineIndent: true, paragraphSpacing: "none" });
    assert.equal(next.paragraphSpacing, spacing);
    assert.equal(next.firstLineIndent, false, `${spacing} should have switched the indent off`);
  }
});

test("choosing `original` or `none` keeps whatever the indent was", () => {
  for (const spacing of ["original", "none"] as const) {
    const next = withParagraphSpacing(spacing, { firstLineIndent: true, paragraphSpacing: "loose" });
    assert.equal(next.firstLineIndent, true);
  }
});

test("the two settings can never both be in their conflicting state", () => {
  const spacings = ["original", "none", "compact", "comfortable", "loose"] as const;
  for (const spacing of spacings) {
    for (const indent of [true, false]) {
      for (const next of [
        withFirstLineIndent(!indent, { firstLineIndent: indent, paragraphSpacing: spacing }),
        withParagraphSpacing(spacing, { firstLineIndent: indent, paragraphSpacing: spacing }),
      ]) {
        assert.ok(
          !(next.firstLineIndent && paragraphSpacingConflictsWithIndent(next.paragraphSpacing)),
          `reachable conflicting state: ${JSON.stringify(next)}`,
        );
      }
    }
  }
});

test("the mode drives which explanation the panel shows", () => {
  assert.equal(paragraphStyleMode({ firstLineIndent: true, paragraphSpacing: "none" }), "indent");
  assert.equal(paragraphStyleMode({ firstLineIndent: false, paragraphSpacing: "loose" }), "spacing");
  assert.equal(paragraphStyleMode({ firstLineIndent: false, paragraphSpacing: "original" }), "neutral");
  assert.equal(paragraphStyleMode({ firstLineIndent: false, paragraphSpacing: "none" }), "neutral");
});

test("auto line spacing forks by script, an explicit number does not", () => {
  assert.equal(resolveLineSpacing("auto", true), AUTO_LINE_SPACING_CJK);
  assert.equal(resolveLineSpacing("auto", false), AUTO_LINE_SPACING_LATIN);
  assert.equal(resolveLineSpacing(2.2, true), 2.2);
  assert.equal(resolveLineSpacing(2.2, false), 2.2);
  assert.ok(AUTO_LINE_SPACING_CJK > AUTO_LINE_SPACING_LATIN, "CJK needs the extra air, not less");
});

test("`auto` survives a round trip through the settings table", () => {
  // The whole point of the sentinel is that it is storable. A parser that
  // treated it as unparseable would drop every install back to a number on the
  // first read, and the per-script default would silently never apply again.
  assert.equal(parseLineSpacing("auto"), "auto");
  assert.equal(parseLineSpacing(String("auto")), "auto");
  assert.equal(parseLineSpacing("1.5"), 1.5);
  assert.equal(parseLineSpacing(undefined), "auto");
  assert.equal(parseLineSpacing(null), "auto");
  assert.equal(parseLineSpacing(""), "auto");
  assert.equal(parseLineSpacing("nonsense"), "auto");
});
