import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ankiFront, exportCounts, exportFilename, previewExport, sanitizeExportFilename, serializeAnkiCsv, serializeCsv, serializeMarkdown, type ExportRecord } from "../src/pages/reader/reader-export.ts";

const records: ExportRecord[] = [
  { kind: "highlight", bookTitle: "A Book", chapter: "One", sourceText: "A, \"quote\"\nnext", note: "note", color: "yellow", cfi: "cfi", createdAt: "2026-08-04T00:00:00.000Z" },
  { kind: "vocabulary", bookTitle: "A Book", chapter: "One", word: "Courage", definition: "bravery", context: "show courage", contextExplanation: "be brave", mastery: "new", cfi: "cfi2", createdAt: "2026-08-03T00:00:00.000Z" },
];

describe("reader export", () => {
  it("serializes grouped markdown without empty fields", () => {
    const text = serializeMarkdown([...records, { ...records[0], chapter: undefined, sourceText: undefined, note: undefined }], "A Book", false);
    assert.ok(text.includes("## Highlights\n\n### One"));
    assert.ok(text.includes("### Unknown chapter"));
    assert.ok(!text.includes("**Note**: undefined"));
  });
  it("escapes markdown metadata and preserves multiline quote structure", () => {
    const text = serializeMarkdown([{
      ...records[0],
      bookTitle: "A # Book",
      chapter: "Part *One*",
      sourceText: "first line\n# second line",
      note: "note *one*\nnext [line]",
    }], "A # Book", false);
    assert.ok(text.startsWith("# A \\# Book · Study export"));
    assert.ok(text.includes("### Part \\*One\\*"));
    assert.ok(text.includes("> first line\n> \\# second line"));
    assert.ok(text.includes("**Note**: note \\*one\\*  \nnext \\[line\\]"));
  });
  it("writes RFC4180 CSV with BOM and stable headers", () => {
    const text = serializeCsv(records);
    assert.equal(text.startsWith("\uFEFF\"kind\",\"book\""), true);
    assert.ok(text.includes('"A, ""quote""\nnext"'));
  });
  it("makes importable Anki cards and safe tags", () => {
    assert.equal(ankiFront("courage", "Show Courage now"), "Show ______ now");
    assert.equal(ankiFront("courage"), "courage");
    assert.ok(serializeAnkiCsv(records).includes("lantern a-book new"));
  });
  it("sanitizes filenames and previews/counts records", () => {
    assert.equal(sanitizeExportFilename(" /:\u0000 "), "Lantern");
    assert.equal(exportFilename("A/B", "markdown", false), "A B-study-export.md");
    assert.deepEqual(exportCounts(records), { highlights: 1, vocabulary: 1 });
    assert.ok(previewExport(records, "A Book", "csv", false).includes("Courage"));
  });
});
