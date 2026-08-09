import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ankiFront, countExportFields, defaultExportFields, effectiveExportFields, exportCounts, exportFieldBlock, exportFieldDefaults, exportFieldKeys, exportFilename, isCustomExportFields, previewExport, sanitizeExportFilename, selectionForFormat, serializeAnkiCsv, serializeCsv, serializeMarkdown, type ExportFields, type ExportRecord } from "../src/pages/reader/reader-export.ts";

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
  it("neutralises CSV formula injection without corrupting plain text", () => {
    const text = serializeCsv([{ ...records[0], note: "=cmd|'/c calc'!A1" }]);
    assert.ok(text.includes(`"'=cmd|'/c calc'!A1"`.replace(/'/g, "'")) || text.includes("'=cmd"));
    assert.ok(text.includes("'=cmd"));
    const plain = serializeCsv([{ ...records[0], note: "regular note" }]);
    assert.ok(plain.includes('"regular note"'));
  });
  it("makes importable Anki cards and safe tags", () => {
    assert.equal(ankiFront("courage", "Show Courage now"), "Show ______ now");
    assert.equal(ankiFront("courage"), "courage");
    assert.ok(serializeAnkiCsv(records).includes("lantern a-book new"));
  });
  it("does not corrupt the Anki front when the target is a substring of another word", () => {
    assert.equal(ankiFront("art", "He started early"), "art");
  });
  it("blanks the exact target word on a boundary-respecting match", () => {
    assert.equal(ankiFront("art", "The art is here"), "The ______ is here");
  });
  it("groups markdown records by chapter once, regardless of input order", () => {
    const shuffled: ExportRecord[] = [
      { ...records[1], chapter: "Two", word: "second" },
      { ...records[1], chapter: "One", word: "first" },
      { ...records[1], chapter: "Two", word: "third" },
      { ...records[1], chapter: "One", word: "fourth" },
    ];
    const text = serializeMarkdown(shuffled, "A Book", false);
    assert.equal((text.match(/### One/g) ?? []).length, 1);
    assert.equal((text.match(/### Two/g) ?? []).length, 1);
  });
  it("sanitizes filenames and previews/counts records", () => {
    assert.equal(sanitizeExportFilename(" /:\u0000 "), "Lantern");
    assert.equal(exportFilename("A/B", "markdown", false), "A B-study-export.md");
    assert.deepEqual(exportCounts(records), { highlights: 1, vocabulary: 1 });
    assert.ok(previewExport(records, "A Book", "csv", false).includes("Courage"));
  });
});

// The advanced "included fields" section only earns its place if the untouched
// case is right, so every test above calls the serializers with no field set at
// all and doubles as the guard on the defaults. CSV and Anki still write exactly
// what they always wrote; Markdown deliberately drops the CFI, which is pinned
// in both directions below. These check what the toggles actually do.
const only = (...on: readonly (keyof ExportFields)[]): ExportFields =>
  Object.fromEntries(exportFieldKeys.map((key) => [key, on.includes(key)])) as ExportFields;

describe("reader export fields", () => {
  it("gives each format the default set it is actually good at", () => {
    // Markdown is human-readable, so it drops the machine-only fields; CSV keeps
    // all 13 columns; Anki has no home for a highlight.
    assert.deepEqual(defaultExportFields("markdown"), { ...exportFieldDefaults.csv, cfi: false, color: false, mastery: false });
    assert.equal(countExportFields(defaultExportFields("markdown")), 8);
    assert.equal(countExportFields(defaultExportFields("csv")), exportFieldKeys.length);
    assert.deepEqual(defaultExportFields("anki"), only("chapter", "word", "definition", "context", "explanation", "mastery"));
    assert.equal(isCustomExportFields(defaultExportFields("markdown"), "markdown"), false);
    // Turning an off-by-default field back on counts as customised too.
    assert.equal(isCustomExportFields({ ...defaultExportFields("markdown"), cfi: true }, "markdown"), true);
    assert.equal(isCustomExportFields({ ...defaultExportFields("csv"), note: false }, "csv"), true);
  });

  it("writes the same file with the default set as with no set at all", () => {
    assert.equal(serializeMarkdown(records, "A Book", false, defaultExportFields("markdown")), serializeMarkdown(records, "A Book", false));
    assert.equal(serializeCsv(records, defaultExportFields("csv")), serializeCsv(records));
    assert.equal(serializeAnkiCsv(records, defaultExportFields("anki")), serializeAnkiCsv(records));
  });

  it("drops markdown sections cleanly, leaving no orphan separator or blank line", () => {
    const text = serializeMarkdown(records, "A Book", false, only("source", "word", "definition"));
    assert.ok(!text.includes("### One"), "chapter heading should be gone");
    assert.ok(!text.includes("`cfi`"), "position should be gone");
    assert.ok(!text.includes("2026-08"), "date should be gone");
    assert.ok(!/\n\n\n/.test(text), `stray blank lines: ${JSON.stringify(text)}`);
    assert.ok(!/·\s*$/m.test(text), "a trailing separator survived an empty footer");
  });

  it("keeps the CFI out of markdown by default and puts it back on request", () => {
    // Markdown is the format a person reads, so the position string is off:
    // deliberately different from what Lantern used to write. The capability is
    // not gone, it moved one click away — and CSV still carries the column.
    const plain = serializeMarkdown(records, "A Book", false);
    assert.ok(!plain.includes("`cfi`"), plain);
    assert.ok(plain.includes("\n2026-08-04T00:00:00.000Z\n"), "the date footer must survive alone");
    assert.ok(plain.trimEnd().endsWith("2026-08-03T00:00:00.000Z"), "no orphan separator where the CFI was");
    const restored = serializeMarkdown(records, "A Book", false, { ...defaultExportFields("markdown"), cfi: true });
    assert.ok(restored.includes("`cfi` · 2026-08-04T00:00:00.000Z"), restored);
    assert.ok(restored.includes("`cfi2` · 2026-08-03T00:00:00.000Z"), restored);
    // CSV is unchanged: position stays a default column there.
    assert.ok(serializeCsv(records).includes(`"cfi2"`));
  });

  it("emits the two new markdown outputs only when asked, with readable values", () => {
    assert.ok(!serializeMarkdown(records, "A Book", false).includes("**Color**"));
    const text = serializeMarkdown(records, "A Book", false, { ...defaultExportFields("markdown"), color: true, mastery: true });
    assert.ok(text.includes("**Color**: Yellow"));
    assert.ok(text.includes("**Mastery**: New"));
    assert.ok(serializeMarkdown(records, "A Book", true, { ...defaultExportFields("markdown"), color: true }).includes("**颜色**: 黄色"));
  });

  it("drops only the unchecked CSV columns and never kind or book", () => {
    const text = serializeCsv(records, only("word", "definition"));
    // Escaped, not pasted: the byte-order mark Excel needs is invisible in the
    // source and a linter cannot tell it from a stray control character.
    assert.equal(text.split("\r\n")[0], `\uFEFF"kind","book","word","definition"`);
    assert.equal(text.split("\r\n")[1], `"highlight","A Book","",""`);
  });

  it("still neutralises a formula in an optional column", () => {
    // `note` is switchable now, so the escaping has to travel with the column
    // rather than with its old fixed position in the row.
    const text = serializeCsv([{ ...records[0], note: "=HYPERLINK(1)" }], only("note"));
    assert.equal(text.split("\r\n")[1], `"highlight","A Book","'=HYPERLINK(1)"`);
  });

  it("folds Anki's chapter, date and position into the single Source column", () => {
    const text = serializeAnkiCsv(records, { ...defaultExportFields("anki"), date: true, cfi: true });
    assert.ok(text.includes(`"A Book · One · 2026-08-03T00:00:00.000Z · cfi2"`), text);
    assert.ok(serializeAnkiCsv(records).includes(`"A Book · One"`));
  });

  it("keeps an Anki front even when the word and its sentence are switched off", () => {
    assert.equal(serializeAnkiCsv(records, only("definition")).split("\r\n")[1], `"Courage","bravery","A Book","lantern a-book"`);
    // With the sentence back on the front is the cloze again, and the word is
    // repeated on the back only because `word` says so.
    assert.ok(serializeAnkiCsv(records, only("word", "context")).includes(`"show ______","Courage`));
  });

  it("lets only Anki move the content selection, and makes it hand the selection back", () => {
    const narrowed = { highlights: true, vocabulary: false };   // what a reader chose
    const forced = { highlights: false, vocabulary: true };      // what Anki imposes
    // Markdown ↔ CSV constrain nothing, so they must not touch the choice.
    assert.deepEqual(selectionForFormat("csv", "markdown", narrowed, null), { selection: narrowed, remember: null });
    assert.deepEqual(selectionForFormat("markdown", "csv", narrowed, null), { selection: narrowed, remember: null });
    // Anki displaces the choice and remembers it…
    const entered = selectionForFormat("anki", "markdown", narrowed, null);
    assert.deepEqual(entered, { selection: forced, remember: narrowed });
    // …re-picking Anki must not overwrite the memory with the forced value…
    assert.deepEqual(selectionForFormat("anki", "anki", entered.selection, entered.remember).remember, narrowed);
    // …and leaving restores what the reader had, rather than blanket "all on".
    assert.deepEqual(selectionForFormat("markdown", "anki", entered.selection, entered.remember), { selection: narrowed, remember: null });
    assert.deepEqual(selectionForFormat("csv", "anki", entered.selection, entered.remember).selection, narrowed);
    // With nothing remembered, leaving Anki falls back to exporting everything.
    assert.deepEqual(selectionForFormat("markdown", "anki", forced, null).selection, { highlights: true, vocabulary: true });
  });

  it("blocks fields the format or the content selection rules out", () => {
    const all = { highlights: true, vocabulary: true };
    assert.equal(exportFieldBlock("note", "anki", { highlights: false, vocabulary: true }), "notApplicable");
    assert.equal(exportFieldBlock("note", "csv", { highlights: false, vocabulary: true }), "notExported");
    assert.equal(exportFieldBlock("word", "csv", { highlights: true, vocabulary: false }), "notExported");
    assert.equal(exportFieldBlock("chapter", "anki", all), undefined);
    assert.equal(exportFieldBlock("date", "anki", all), undefined);
    // A blocked field never reaches the file, however it was left checked.
    const resolved = effectiveExportFields(defaultExportFields("csv"), "csv", { highlights: false, vocabulary: true });
    assert.deepEqual([resolved.source, resolved.note, resolved.color], [false, false, false]);
    assert.equal(resolved.word, true);
    assert.ok(!serializeCsv([records[1]], resolved).includes("source_text"));
    // Anki's count is the six that can actually be written, not eleven.
    assert.equal(countExportFields(effectiveExportFields(defaultExportFields("anki"), "anki", { highlights: false, vocabulary: true })), 6);
  });
});
