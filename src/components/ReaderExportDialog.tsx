import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Download, FileWarning, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Highlight } from "../hooks/useBookmarks";
import type { DictionaryWord } from "../hooks/useDictionary";
import { exportCounts, exportFilename, filterExportRecords, previewExport, serializeExport, type ExportFormat, type ExportRecord, type ExportSelection } from "../pages/reader/reader-export";

interface ReaderExportDialogProps {
  open: boolean;
  bookId: string;
  bookTitle: string;
  onClose: () => void;
  resolveChapter: (cfi: string) => Promise<string | undefined>;
}

type Status = "ready" | "preparing" | "saving" | "success" | "error";

async function resolveChapters(records: ExportRecord[], resolveChapter: ReaderExportDialogProps["resolveChapter"]) {
  const output = [...records];
  let index = 0;
  const worker = async () => {
    while (index < output.length) {
      const current = index++;
      const record = output[current];
      if (!record.cfi) continue;
      try { output[current] = { ...record, chapter: await resolveChapter(record.cfi) }; } catch { /* chapter is optional */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, output.length) }, worker));
  return output;
}

function toExportRecords(highlights: Highlight[], words: DictionaryWord[], bookTitle: string): ExportRecord[] {
  return [
    ...highlights.map((item) => ({ kind: "highlight" as const, bookTitle, sourceText: item.text_content || undefined, note: item.note || undefined, color: item.color, cfi: item.cfi_range, createdAt: new Date(item.created_at).toISOString() })),
    ...words.map((item) => ({ kind: "vocabulary" as const, bookTitle: bookTitle || item.book_title || "", word: item.word, definition: item.definition, context: item.context_sentence || undefined, contextExplanation: item.context_explanation || undefined, mastery: item.mastery, cfi: item.cfi || undefined, createdAt: new Date(item.created_at).toISOString() })),
  ];
}

export default function ReaderExportDialog({ open, bookId, bookTitle, onClose, resolveChapter }: ReaderExportDialogProps) {
  const { t, i18n } = useTranslation();
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const statusActionRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const requestGenerationRef = useRef(0);
  const [records, setRecords] = useState<ExportRecord[]>([]);
  const [selection, setSelection] = useState<ExportSelection>({ highlights: true, vocabulary: true });
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [status, setStatus] = useState<Status>("ready");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();
    return () => openerRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open) return;
    requestGenerationRef.current += 1;
    setRecords([]); setStatus("ready"); setError(""); setFormat("markdown"); setSelection({ highlights: true, vocabulary: true });
  }, [open]);

  const loadRecords = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    setStatus("preparing"); setError(""); setRecords([]);
    try {
      const [highlights, words] = await Promise.all([
        invoke<Highlight[]>("list_highlights", { bookId }),
        invoke<DictionaryWord[]>("list_vocab_words", { bookId }),
      ]);
      const resolved = await resolveChapters(toExportRecords(highlights, words, bookTitle), resolveChapter);
      if (generation !== requestGenerationRef.current) return;
      setRecords(resolved); setStatus("ready");
    } catch (reason) {
      if (generation !== requestGenerationRef.current) return;
      console.error("Reader export data load failed", { bookId });
      setError(reason instanceof Error ? reason.message : t("readerExport.failed"));
      setStatus("error");
    }
  }, [bookId, bookTitle, resolveChapter, t]);

  useEffect(() => {
    if (!open) return;
    void loadRecords();
    return () => { requestGenerationRef.current += 1; };
  }, [loadRecords, open]);

  useEffect(() => {
    if (!open || (status !== "success" && status !== "error")) return;
    const frame = window.requestAnimationFrame(() => statusActionRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, status]);

  const activeSelection = format === "anki" ? { highlights: false, vocabulary: true } : selection;
  const selected = filterExportRecords(records, activeSelection, format);
  const counts = exportCounts(selected);
  const chinese = i18n.language.startsWith("zh");
  const preview = previewExport(selected, bookTitle, format, chinese);
  const empty = selected.length === 0;

  useEffect(() => {
    if (!open || status !== "ready" || !empty) return;
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [empty, open, status]);

  const chooseFormat = (next: ExportFormat) => {
    setFormat(next);
    if (next === "anki") setSelection({ highlights: false, vocabulary: true });
  };
  const toggle = (kind: keyof ExportSelection) => setSelection((current) => ({ ...current, [kind]: !current[kind] }));
  const exportFile = async () => {
    if (empty || status !== "ready") return;
    setError("");
    const generation = requestGenerationRef.current;
    try {
      const content = serializeExport(selected, bookTitle, format, chinese);
      setStatus("saving");
      const path = await save({ defaultPath: exportFilename(bookTitle, format, chinese), filters: [{ name: format === "markdown" ? "Markdown" : "CSV", extensions: [format === "markdown" ? "md" : "csv"] }] });
      if (generation !== requestGenerationRef.current) return;
      if (!path) { setStatus("ready"); return; }
      await writeTextFile(path, content);
      if (generation !== requestGenerationRef.current) return;
      setStatus("success");
    } catch (reason) {
      if (generation !== requestGenerationRef.current) return;
      console.error("Reader export failed", { format, count: selected.length });
      setError(reason instanceof Error ? reason.message : t("readerExport.failed"));
      setStatus("error");
    }
  };
  const onDialogKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && status !== "saving") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = [titleRef.current, ...Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter((item): item is HTMLElement => item !== null);
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (!dialogRef.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  if (!open) return null;

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" onKeyDown={onDialogKeyDown} onMouseDown={(event) => { if (event.currentTarget === event.target && status !== "saving") onClose(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="reader-export-title" className="w-full max-w-3xl overflow-hidden rounded-xl border border-border bg-bg-surface shadow-2xl">
      <header className="flex items-start gap-4 border-b border-border px-6 py-5">
        <div><h2 id="reader-export-title" ref={titleRef} tabIndex={-1} className="text-lg font-semibold outline-none">{format === "anki" ? t("readerExport.ankiTitle") : t("readerExport.title")}</h2><p className="mt-1 text-sm text-text-muted">{t("readerExport.subtitle")}</p></div>
        <button disabled={status === "saving"} onClick={onClose} aria-label={t("common.close")} className="ml-auto rounded-md p-1 text-text-muted hover:bg-bg-input hover:text-text-primary disabled:cursor-wait disabled:opacity-40"><X size={18} /></button>
      </header>
      {status === "preparing" ? <div className="grid min-h-80 place-items-center p-8 text-center" role="status" aria-live="polite"><div><Loader2 size={28} className="mx-auto animate-spin text-accent motion-reduce:animate-none" /><p className="mt-4 text-sm text-text-muted">{t("readerExport.preparing")}</p></div></div> : status === "success" || status === "error" ? <div className="grid min-h-80 place-items-center p-8 text-center" role={status === "success" ? "status" : undefined} aria-live={status === "success" ? "polite" : undefined}>
        {status === "success" ? <Download size={32} className="text-green-600" /> : <FileWarning size={32} className="text-red-600" />}
        <div className="-mt-20"><h3 className="text-base font-semibold">{status === "success" ? t("readerExport.success") : t("readerExport.failed")}</h3><p role={status === "error" ? "alert" : undefined} className="mt-2 max-w-md text-sm text-text-muted">{status === "success" ? t(format === "anki" ? "readerExport.ankiSuccessDetail" : "readerExport.successDetail") : t("readerExport.failureDetail", { error })}</p><button ref={statusActionRef} onClick={status === "success" ? onClose : records.length ? () => setStatus("ready") : loadRecords} className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white">{status === "success" ? t("common.close") : t("readerExport.tryAgain")}</button></div>
      </div> : empty ? <div className="grid min-h-80 place-items-center p-8 text-center" role="status" aria-live="polite"><FileWarning size={30} className="text-text-muted" /><div className="-mt-20"><h3 className="font-semibold">{t("readerExport.emptyTitle")}</h3><p className="mt-2 max-w-sm text-sm text-text-muted">{t("readerExport.emptyDetail")}</p></div></div> : <>
        <div className="grid max-h-[62vh] grid-cols-1 overflow-auto md:grid-cols-[1fr_1fr]">
          <div className="space-y-5 border-border p-6 md:border-r">
            <fieldset><legend className="mb-2 text-sm font-medium">{t("readerExport.contents")}</legend><div className="grid grid-cols-2 gap-2">
              {(["highlights", "vocabulary"] as const).map((kind) => <label key={kind} className={`rounded-lg border p-3 ${activeSelection[kind] ? "border-accent bg-accent/5" : "border-border"}`}><input type="checkbox" checked={activeSelection[kind]} disabled={format === "anki"} onChange={() => toggle(kind)} className="mr-2 accent-accent" />{t(`readerExport.${kind}`)}<span className="mt-1 block text-xs text-text-muted">{exportCounts(records)[kind]}</span></label>)}
            </div></fieldset>
            <fieldset><legend className="mb-2 text-sm font-medium">{t("readerExport.format")}</legend><div className="grid grid-cols-3 rounded-lg bg-bg-input p-1">{(["markdown", "csv", "anki"] as const).map((item) => <button key={item} onClick={() => chooseFormat(item)} className={`rounded-md py-2 text-xs ${format === item ? "bg-bg-surface font-semibold shadow-sm" : "text-text-muted"}`}>{t(`readerExport.format.${item}`)}</button>)}</div></fieldset>
            <p className="rounded-lg bg-bg-input p-3 text-xs leading-5 text-text-muted">{t("readerExport.privacy")}</p>
          </div>
          <div className="bg-bg-muted p-6"><div className="mb-2 flex justify-between text-sm font-medium"><span>{t("readerExport.preview")}</span><span className="font-normal text-text-muted">{t("readerExport.firstTwo")}</span></div><pre className="min-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg-surface p-4 text-xs leading-5 text-text-body">{preview}</pre><div className="mt-2 rounded-md border border-border bg-bg-surface px-3 py-2 text-xs text-text-muted">{exportFilename(bookTitle, format, chinese)}</div></div>
        </div>
        <footer className="flex items-center gap-3 border-t border-border px-6 py-4"><span className="text-xs text-text-muted">{t("readerExport.summary", counts)}</span><span className="flex-1" /><button disabled={status === "saving"} onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm disabled:cursor-wait disabled:opacity-40">{t("common.cancel")}</button><button disabled={status !== "ready"} onClick={exportFile} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{status === "saving" ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : null}{status === "saving" ? t("readerExport.saving") : t("readerExport.chooseLocation")}</button><span className="sr-only" role="status" aria-live="polite">{status === "saving" ? t("readerExport.saving") : ""}</span></footer>
      </>}
    </section>
  </div>;
}
