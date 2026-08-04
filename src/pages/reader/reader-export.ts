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

function escapeMarkdown(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/([`*_{}[\]()<>#+.!|-])/g, "\\$1").replace(/\r?\n/g, "\n");
}
function markdownHeading(value: string) { return escapeMarkdown(value).replace(/\n+/g, " "); }
function markdownQuote(value: string) { return escapeMarkdown(value).split("\n").map((line) => `> ${line}`).join("\n"); }
function markdownField(label: string, value: string) { return `**${label}**: ${escapeMarkdown(value).replace(/\n/g, "  \n")}`; }
function chapter(record: ExportRecord, chinese: boolean) { return record.chapter || (chinese ? "未知章节" : "Unknown chapter"); }
function date(value: string) { return value; }

export function serializeMarkdown(records: readonly ExportRecord[], title: string, chinese: boolean) {
  const labels = chinese
    ? { study: "学习资料", highlights: "高亮", vocabulary: "生词", note: "备注", definition: "释义", context: "语境", explanation: "语境解释" }
    : { study: "Study export", highlights: "Highlights", vocabulary: "Vocabulary", note: "Note", definition: "Definition", context: "Context", explanation: "Context explanation" };
  const output = [`# ${markdownHeading(title)} · ${labels.study}`];
  for (const kind of ["highlight", "vocabulary"] as const) {
    const grouped = records.filter((record) => record.kind === kind);
    if (!grouped.length) continue;
    output.push("", `## ${kind === "highlight" ? labels.highlights : labels.vocabulary}`);
    let previousChapter: string | undefined;
    for (const record of grouped) {
      const currentChapter = chapter(record, chinese);
      if (currentChapter !== previousChapter) output.push("", `### ${markdownHeading(currentChapter)}`);
      previousChapter = currentChapter;
      if (record.kind === "highlight") {
        if (record.sourceText) output.push(markdownQuote(record.sourceText));
        if (record.note) output.push(markdownField(labels.note, record.note));
        output.push(`\`${record.cfi}\` · ${date(record.createdAt)}`);
      } else {
        output.push(`#### ${markdownHeading(record.word)}`);
        if (record.context) output.push(markdownField(labels.context, record.context));
        if (record.definition) output.push(markdownField(labels.definition, record.definition));
        if (record.contextExplanation) output.push(markdownField(labels.explanation, record.contextExplanation));
        if (record.cfi) output.push(`\`${record.cfi}\` · ${date(record.createdAt)}`);
        else output.push(date(record.createdAt));
      }
    }
  }
  return output.join("\n") + "\n";
}

const csvHeaders = ["kind", "book", "chapter", "source_text", "word", "note", "definition", "context", "context_explanation", "color", "mastery", "cfi", "created_at"];
function csvCell(value: string | undefined) { return `"${(value ?? "").replace(/"/g, '""')}"`; }
export function serializeCsv(records: readonly ExportRecord[]) {
  const rows = records.map((record) => record.kind === "highlight"
    ? [record.kind, record.bookTitle, record.chapter, record.sourceText, "", record.note, "", "", "", record.color, "", record.cfi, record.createdAt]
    : [record.kind, record.bookTitle, record.chapter, "", record.word, "", record.definition, record.context, record.contextExplanation, "", record.mastery, record.cfi, record.createdAt]);
  return `\uFEFF${[csvHeaders, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function ankiFront(word: string, context?: string) {
  if (!context?.trim()) return word;
  return context.replace(new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i"), "______");
}
function tagToken(value: string) { return sanitizeExportFilename(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-+|-+$/g, "") || "book"; }
export function serializeAnkiCsv(records: readonly ExportRecord[]) {
  const rows = records.filter((record): record is ExportVocabulary => record.kind === "vocabulary").map((record) => {
    const back = [record.word, record.definition, record.contextExplanation, record.context].filter(Boolean).join("\n\n");
    const source = [record.bookTitle, record.chapter].filter(Boolean).join(" · ");
    return [ankiFront(record.word, record.context), back, source, `lantern ${tagToken(record.bookTitle)} ${record.mastery}`];
  });
  return `\uFEFF${[["Front", "Back", "Source", "Tags"], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function serializeExport(records: readonly ExportRecord[], title: string, format: ExportFormat, chinese: boolean) {
  if (format === "markdown") return serializeMarkdown(records, title, chinese);
  return format === "csv" ? serializeCsv(records) : serializeAnkiCsv(records);
}

export function exportCounts(records: readonly ExportRecord[]) {
  return { highlights: records.filter((record) => record.kind === "highlight").length, vocabulary: records.filter((record) => record.kind === "vocabulary").length };
}

export function previewExport(records: readonly ExportRecord[], title: string, format: ExportFormat, chinese: boolean) {
  return serializeExport(records.slice(0, 2), title, format, chinese);
}
