import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { X, Copy, Check, FolderOpen, RefreshCw } from "lucide-react";
import { getReaderDiagnosticReport } from "../utils/readerDiagnostics";

interface ReaderDiagnosticsPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Always-reachable dump of the reader diagnostic trail + runtime capability
 * snapshot. Its point is the case that has no error screen: a book stuck on
 * "Preparing book…". The user can open this (spinner hint or Cmd/Ctrl+Shift+D),
 * copy the report, and send it — or reveal the on-disk logs.
 */
export default function ReaderDiagnosticsPanel({ open, onClose }: ReaderDiagnosticsPanelProps) {
  const { t } = useTranslation();
  const [report, setReport] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) setReport(getReaderDiagnosticReport());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const copy = () => {
    void navigator.clipboard
      .writeText(report)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("reader.diagnostics.title")}
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-[560px] flex-col rounded-xl bg-bg-surface shadow-popover"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4">
          <div>
            <p className="text-[15px] font-medium text-text-primary">{t("reader.diagnostics.title")}</p>
            <p className="mt-1 text-[12px] leading-5 text-text-muted">{t("reader.diagnostics.description")}</p>
          </div>
          <button
            type="button"
            aria-label={t("reader.diagnostics.close")}
            className="shrink-0 cursor-pointer rounded-md p-1 text-text-muted hover:bg-bg-input"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <pre className="mx-5 mt-3 flex-1 overflow-auto rounded-md bg-bg-input px-3 py-2 font-mono text-[11px] leading-5 text-text-muted whitespace-pre-wrap break-words">
          {report}
        </pre>

        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-[10px] border border-border px-3 text-[13px] font-medium text-text-secondary hover:border-accent"
            onClick={() => setReport(getReaderDiagnosticReport())}
          >
            <RefreshCw size={14} />
            {t("reader.diagnostics.refresh")}
          </button>
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-[10px] border border-border px-3 text-[13px] font-medium text-text-secondary hover:border-accent"
            onClick={() => {
              invoke("reveal_logs").catch(() => {});
            }}
          >
            <FolderOpen size={14} />
            {t("reader.diagnostics.reveal")}
          </button>
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-[10px] bg-accent-bg px-3 text-[13px] font-medium text-accent-text hover:opacity-80"
            onClick={copy}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t("reader.diagnosticsCopied") : t("reader.copyDiagnostics")}
          </button>
        </div>
      </div>
    </div>
  );
}
