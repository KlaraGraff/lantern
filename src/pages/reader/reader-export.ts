import { findWordBoundaryMatch } from "../../components/vocab/word-boundary.ts";

export type ExportFormat = "markdown" | "csv" | "anki";

export interface ExportHighlight {
  kind: "highlight";
  bookTitle: string;
  chapter?: string;
  sourceText?: string;
  note?: string;
  color: string;
  cfi: string;
  createdAt: string;
}

export interface ExportVocabulary {
  kind: "vocabulary";
  bookTitle: string;
  chapter?: string;
  word: string;
  definition: string;
  context?: string;
  contextExplanation?: string;
  mastery: string;
  cfi?: string;
  createdAt: string;
}

export type ExportRecord = ExportHighlight | ExportVocabulary;
export type ExportSelection = { highlights: boolean; vocabulary: boolean };

/**
 * The optional columns of an export. `kind` and `book` are deliberately absent:
 * a row that cannot say what it is or which book it came from is not a smaller
 * export, it is an unusable one, so they are always written.
 */
export const exportFieldKeys = ["chapter", "date", "cfi", "source", "note", "color", "word", "definition", "context", "explanation", "mastery"] as const;
export type ExportFieldKey = (typeof exportFieldKeys)[number];
export type ExportFields = Record<ExportFieldKey, boolean>;
export type ExportFieldGroup = "general" | "highlight" | "vocabulary";

/** Presentation order, and the grouping the dialog draws. */
export const exportFieldGroups: readonly { group: ExportFieldGroup; keys: readonly ExportFieldKey[] }[] = [
  { group: "general", keys: ["chapter", "date", "cfi"] },
  { group: "highlight", keys: ["source", "note", "color"] },
  { group: "vocabulary", keys: ["word", "definition", "context", "explanation", "mastery"] },
];

const fieldGroup = new Map<ExportFieldKey, ExportFieldGroup>(
  exportFieldGroups.flatMap(({ group, keys }) => keys.map((key) => [key, group] as const)),
);

export function exportFieldGroupOf(key: ExportFieldKey): ExportFieldGroup { return fieldGroup.get(key)!; }

function fields(off: Partial<ExportFields>): ExportFields {
  return Object.fromEntries(exportFieldKeys.map((key) => [key, off[key] ?? true])) as ExportFields;
}

/**
 * What each format writes when nobody touches the advanced section — which is
 * the overwhelmingly common case, so these are the sets that have to be right.
 * They reproduce what Lantern exported before the section existed: the two
 * genuinely new Markdown outputs (colour, mastery) start off.
 */
export const exportFieldDefaults: Record<ExportFormat, ExportFields> = {
  // Markdown is the format a person reads. An `epubcfi(/6/14!/4/2/22,/1:0,/1:47)`
  // sitting in the middle of a study note is machine noise no reader can use, so
  // it stays out by default — CSV keeps the column for anyone who wants position
  // data, and one click in this very section puts it back.
  markdown: fields({ cfi: false, color: false, mastery: false }),
  csv: fields({}),
  // Anki has four columns and no home for a highlight, so the highlight group
  // is off; date and cfi are off because they would crowd the Source column.
  anki: fields({ date: false, cfi: false, source: false, note: false, color: false }),
};

export function defaultExportFields(format: ExportFormat): ExportFields { return { ...exportFieldDefaults[format] }; }

export function isCustomExportFields(selected: ExportFields, format: ExportFormat) {
  return exportFieldKeys.some((key) => selected[key] !== exportFieldDefaults[format][key]);
}

/**
 * `notApplicable` — the format has nowhere to put it (Anki and highlights).
 * `notExported` — the field's content type is unchecked in "Export content", so
 * the field has nothing to describe. Both render greyed and refuse clicks.
 */
export type ExportFieldBlock = "notApplicable" | "notExported";

export function exportFieldBlock(key: ExportFieldKey, format: ExportFormat, selection: ExportSelection): ExportFieldBlock | undefined {
  const group = exportFieldGroupOf(key);
  if (group === "highlight") {
    if (format === "anki") return "notApplicable";
    if (!selection.highlights) return "notExported";
  }
  if (group === "vocabulary" && !selection.vocabulary) return "notExported";
  return undefined;
}

/** The selection as the serializers see it: a blocked field is never written. */
export function effectiveExportFields(selected: ExportFields, format: ExportFormat, selection: ExportSelection): ExportFields {
  return Object.fromEntries(exportFieldKeys.map((key) => [key, exportFieldBlock(key, format, selection) ? false : selected[key]])) as ExportFields;
}

export function countExportFields(selected: ExportFields) {
  return exportFieldKeys.reduce((total, key) => total + (selected[key] ? 1 : 0), 0);
}

export function sanitizeExportFilename(title: string) {
  const safe = Array.from(title, (character) => /[\\/:*?"<>|]/.test(character) || character.charCodeAt(0) < 32 ? " " : character)
    .join("").replace(/\s+/g, " ").trim();
  return safe || "Lantern";
}

export function exportFilename(title: string, format: ExportFormat, chinese: boolean) {
  const extension = format === "markdown" ? "md" : "csv";
  return `${sanitizeExportFilename(title)}-${chinese ? "学习资料" : "study-export"}.${extension}`;
}

export function filterExportRecords(records: readonly ExportRecord[], selection: ExportSelection, format: ExportFormat) {
  return records.filter((record) => record.kind === "vocabulary"
    ? selection.vocabulary
    : format !== "anki" && selection.highlights);
}

/**
 * How a format switch resolves "Export content". Anki is the only format that
 * overrides the reader's choice — it has no column for a highlight — so it is
 * the only one that has to hand the choice back on the way out. Markdown and
 * CSV constrain nothing and must leave the selection exactly as it was:
 * restoring a blanket "everything on" there would silently put highlights back
 * into an export the reader had deliberately narrowed.
 *
 * `remembered` is the selection Anki displaced, or null if Anki is not holding
 * one; the returned `remember` is what the caller should hold onto next.
 */
export function selectionForFormat(
  next: ExportFormat,
  current: ExportFormat,
  selection: ExportSelection,
  remembered: ExportSelection | null,
): { selection: ExportSelection; remember: ExportSelection | null } {
  // Re-picking Anki while already on it must not overwrite the memory with the
  // forced value — that would lose the original on the way back out.
  if (next === "anki") return { selection: { highlights: false, vocabulary: true }, remember: current === "anki" ? remembered : selection };
  if (current === "anki") return { selection: remembered ?? { highlights: true, vocabulary: true }, remember: null };
  return { selection, remember: remembered };
}

function escapeMarkdown(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/([`*_{}[\]()<>#+.!|-])/g, "\\$1").replace(/\r?\n/g, "\n");
}
function markdownHeading(value: string) { return escapeMarkdown(value).replace(/\n+/g, " "); }
function markdownQuote(value: string) { return escapeMarkdown(value).split("\n").map((line) => `> ${line}`).join("\n"); }
function markdownField(label: string, value: string) { return `**${label}**: ${escapeMarkdown(value).replace(/\n/g, "  \n")}`; }
function chapter(record: ExportRecord, chinese: boolean) { return record.chapter || (chinese ? "未知章节" : "Unknown chapter"); }
function date(value: string) { return value; }

const colorNames = {
  zh: { yellow: "黄色", green: "绿色", blue: "蓝色", pink: "粉色", purple: "紫色" } as Record<string, string>,
  en: { yellow: "Yellow", green: "Green", blue: "Blue", pink: "Pink", purple: "Purple" } as Record<string, string>,
};
const masteryNames = {
  zh: { new: "新词", learning: "学习中", mastered: "已掌握" } as Record<string, string>,
  en: { new: "New", learning: "Learning", mastered: "Mastered" } as Record<string, string>,
};

export function serializeMarkdown(records: readonly ExportRecord[], title: string, chinese: boolean, selected: ExportFields = exportFieldDefaults.markdown) {
  const labels = chinese
    ? { study: "学习资料", highlights: "高亮", vocabulary: "生词", note: "备注", definition: "释义", context: "语境", explanation: "语境解释", color: "颜色", mastery: "掌握度" }
    : { study: "Study export", highlights: "Highlights", vocabulary: "Vocabulary", note: "Note", definition: "Definition", context: "Context", explanation: "Context explanation", color: "Color", mastery: "Mastery" };
  const names = chinese ? { color: colorNames.zh, mastery: masteryNames.zh } : { color: colorNames.en, mastery: masteryNames.en };
  // The position/date footer of a record. Built by filtering so that turning
  // either half off leaves no orphan separator and no blank line behind.
  const trailing = (record: ExportRecord) => [
    selected.cfi && record.cfi ? `\`${record.cfi}\`` : "",
    selected.date ? date(record.createdAt) : "",
  ].filter(Boolean).join(" · ");
  const output = [`# ${markdownHeading(title)} · ${labels.study}`];
  for (const kind of ["highlight", "vocabulary"] as const) {
    const grouped = records.filter((record) => record.kind === kind);
    if (!grouped.length) continue;
    output.push("", `## ${kind === "highlight" ? labels.highlights : labels.vocabulary}`);
    // Stably group by chapter (preserving each chapter's first-seen order and
    // the original record order within it) so every heading is emitted once,
    // regardless of the input's sort order (the backend query orders by
    // created_at, not chapter).
    const chapterOrder: string[] = [];
    const byChapter = new Map<string, ExportRecord[]>();
    for (const record of grouped) {
      const currentChapter = selected.chapter ? chapter(record, chinese) : "";
      if (!byChapter.has(currentChapter)) { byChapter.set(currentChapter, []); chapterOrder.push(currentChapter); }
      byChapter.get(currentChapter)!.push(record);
    }
    for (const currentChapter of chapterOrder) {
      if (selected.chapter) output.push("", `### ${markdownHeading(currentChapter)}`);
      for (const record of byChapter.get(currentChapter)!) {
        if (record.kind === "highlight") {
          if (selected.source && record.sourceText) output.push(markdownQuote(record.sourceText));
          if (selected.note && record.note) output.push(markdownField(labels.note, record.note));
          if (selected.color && record.color) output.push(markdownField(labels.color, names.color[record.color] ?? record.color));
        } else {
          if (selected.word) output.push(`#### ${markdownHeading(record.word)}`);
          if (selected.context && record.context) output.push(markdownField(labels.context, record.context));
          if (selected.definition && record.definition) output.push(markdownField(labels.definition, record.definition));
          if (selected.explanation && record.contextExplanation) output.push(markdownField(labels.explanation, record.contextExplanation));
          if (selected.mastery && record.mastery) output.push(markdownField(labels.mastery, names.mastery[record.mastery] ?? record.mastery));
        }
        const footer = trailing(record);
        if (footer) output.push(footer);
      }
    }
  }
  return output.join("\n") + "\n";
}

// The 13 columns, in their long-standing order. `kind` and `book` carry no
// field key, so they can never be switched off; the other eleven map one-to-one
// onto the eleven toggles the dialog offers.
interface CsvColumn {
  header: string;
  field?: ExportFieldKey;
  highlight: (record: ExportHighlight) => string | undefined;
  vocabulary: (record: ExportVocabulary) => string | undefined;
}
const csvColumns: readonly CsvColumn[] = [
  { header: "kind", highlight: (record) => record.kind, vocabulary: (record) => record.kind },
  { header: "book", highlight: (record) => record.bookTitle, vocabulary: (record) => record.bookTitle },
  { header: "chapter", field: "chapter", highlight: (record) => record.chapter, vocabulary: (record) => record.chapter },
  { header: "source_text", field: "source", highlight: (record) => record.sourceText, vocabulary: () => "" },
  { header: "word", field: "word", highlight: () => "", vocabulary: (record) => record.word },
  { header: "note", field: "note", highlight: (record) => record.note, vocabulary: () => "" },
  { header: "definition", field: "definition", highlight: () => "", vocabulary: (record) => record.definition },
  { header: "context", field: "context", highlight: () => "", vocabulary: (record) => record.context },
  { header: "context_explanation", field: "explanation", highlight: () => "", vocabulary: (record) => record.contextExplanation },
  { header: "color", field: "color", highlight: (record) => record.color, vocabulary: () => "" },
  { header: "mastery", field: "mastery", highlight: () => "", vocabulary: (record) => record.mastery },
  { header: "cfi", field: "cfi", highlight: (record) => record.cfi, vocabulary: (record) => record.cfi },
  { header: "created_at", field: "date", highlight: (record) => record.createdAt, vocabulary: (record) => record.createdAt },
];
// Neutralise CSV formula injection: a leading =, +, -, or @ is interpreted as
// a formula by Excel/Sheets when the exported CSV is opened. Prefixing with a
// single quote makes it inert while keeping the visible text readable.
function neutralizeFormula(value: string) {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}
function csvCell(value: string | undefined) { return `"${neutralizeFormula(value ?? "").replace(/"/g, '""')}"`; }
export function serializeCsv(records: readonly ExportRecord[], selected: ExportFields = exportFieldDefaults.csv) {
  const columns = csvColumns.filter((column) => !column.field || selected[column.field]);
  const rows = records.map((record) => columns.map((column) => record.kind === "highlight" ? column.highlight(record) : column.vocabulary(record)));
  return `\uFEFF${[columns.map((column) => column.header), ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function ankiFront(word: string, context?: string) {
  if (!context?.trim()) return word;
  const match = findWordBoundaryMatch(context, word);
  if (!match) return word;
  return context.slice(0, match.index) + "______" + context.slice(match.index + match.text.length);
}
function tagToken(value: string) { return sanitizeExportFilename(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-+|-+$/g, "") || "book"; }
export function serializeAnkiCsv(records: readonly ExportRecord[], selected: ExportFields = exportFieldDefaults.anki) {
  const rows = records.filter((record): record is ExportVocabulary => record.kind === "vocabulary").map((record) => {
    // Front is never empty — a card with no question is not a card. `word` only
    // governs whether the word is repeated on the Back.
    const front = selected.context ? ankiFront(record.word, record.context) : record.word;
    const back = [
      selected.word ? record.word : "",
      selected.definition ? record.definition : "",
      selected.explanation ? record.contextExplanation : "",
      selected.context ? record.context : "",
    ].filter(Boolean).join("\n\n");
    // Anki offers four columns, so chapter, date and position have none of their
    // own — they ride along in Source rather than being silently dropped.
    const source = [
      record.bookTitle,
      selected.chapter ? record.chapter : "",
      selected.date ? record.createdAt : "",
      selected.cfi ? record.cfi : "",
    ].filter(Boolean).join(" · ");
    return [front, back, source, `lantern ${tagToken(record.bookTitle)}${selected.mastery ? ` ${record.mastery}` : ""}`];
  });
  return `\uFEFF${[["Front", "Back", "Source", "Tags"], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function serializeExport(records: readonly ExportRecord[], title: string, format: ExportFormat, chinese: boolean, selected: ExportFields = exportFieldDefaults[format]) {
  if (format === "markdown") return serializeMarkdown(records, title, chinese, selected);
  return format === "csv" ? serializeCsv(records, selected) : serializeAnkiCsv(records, selected);
}

export function exportCounts(records: readonly ExportRecord[]) {
  return { highlights: records.filter((record) => record.kind === "highlight").length, vocabulary: records.filter((record) => record.kind === "vocabulary").length };
}

export function previewExport(records: readonly ExportRecord[], title: string, format: ExportFormat, chinese: boolean, selected: ExportFields = exportFieldDefaults[format]) {
  return serializeExport(records.slice(0, 2), title, format, chinese, selected);
}
