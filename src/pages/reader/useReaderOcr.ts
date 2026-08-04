import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getBook, type Book } from "../../hooks/useBooks";
import { useOcrPackage } from "../../hooks/useOcrPackage";
import { useOcrJob } from "../../hooks/useOcrJob";
import { platform } from "../../services/platform";
import type { FoliateView, ReaderPageInfo } from "./foliate-types";

interface ReaderOcrOptions {
  book: Book | null;
  bookId: string | undefined;
  bookReady: boolean;
  pageInfo: ReaderPageInfo | null;
  setBook: Dispatch<SetStateAction<Book | null>>;
  currentCfiRef: RefObject<string | null>;
  viewRef: RefObject<FoliateView | null>;
  /** The HUD slot is shared with the binding hint; opening OCR takes it over. */
  dismissBindingHud: () => void;
  onToast: (message: string) => void;
}

/**
 * The scanned-PDF OCR surface: package/job status, the "this page has no text"
 * intent that raises the HUD, and the reload that swaps in the OCR'd file.
 *
 * The reload is the delicate half. A finished job replaces the book's file, so
 * the reader has to re-open it at the page the reader was on — and only report
 * success once the new file's text layer is actually painted, since that is the
 * thing the reader asked for. A page-count change means the pages no longer
 * line up at all, so that case keeps the HUD up instead of jumping.
 */
export function useReaderOcr({
  book,
  bookId,
  bookReady,
  pageInfo,
  setBook,
  currentCfiRef,
  viewRef,
  dismissBindingHud,
  onToast,
}: ReaderOcrOptions) {
  const { t } = useTranslation();
  const [ocrHudOpen, setOcrHudOpen] = useState(false);
  const ocrIntentKeyRef = useRef("");
  const ocrIntentShownAtRef = useRef(0);
  const locallyRequestedOcrRef = useRef(false);
  const pendingOcrReloadRef = useRef<{ page: number; total: number; sourcePath: string } | null>(null);
  // OCR downloads a package and spawns a subprocess, neither of which a
  // sandboxed mobile app may do (D-003). Disabling the hooks stops the status
  // polling; the HUD that would report it is gated by the caller.
  const ocrAvailable = platform.hasOcr && book?.format === "pdf";
  const ocrPackage = useOcrPackage(ocrAvailable);
  const ocrJob = useOcrJob(bookId, ocrAvailable);

  const onMissingPdfTextIntent = useCallback((pageIndex: number) => {
    if (!platform.hasOcr) return;
    if (!book || book.format !== "pdf") return;
    const sourceHash = book.source_sha256 ?? book.file_path;
    const key = `${book.id}:${pageIndex}:${sourceHash}`;
    const now = Date.now();
    if (ocrIntentKeyRef.current === key && now - ocrIntentShownAtRef.current < 1_000) return;
    ocrIntentKeyRef.current = key;
    ocrIntentShownAtRef.current = now;
    dismissBindingHud();
    setOcrHudOpen(true);
  }, [book, dismissBindingHud]);

  const openOcrSettings = useCallback(async () => {
    try {
      await invoke("open_settings_on_main", { section: "services", view: "ocr" });
    } catch {
      // OCR lives under Services. Landing on the section is a near miss; the
      // old fallback aimed at Reading Assistance, which OCR left long ago.
      await invoke("open_settings_on_main", { section: "services" }).catch(() => {});
    }
    const main = await WebviewWindow.getByLabel("main").catch(() => null);
    await main?.show().catch(() => {});
    await main?.setFocus().catch(() => {});
  }, []);

  const startOcr = useCallback(() => {
    locallyRequestedOcrRef.current = true;
    void ocrJob.start().catch(() => {});
  }, [ocrJob]);

  const retryOcr = useCallback(() => {
    locallyRequestedOcrRef.current = true;
    void ocrJob.retry().catch(() => {});
  }, [ocrJob]);

  const refreshOcrJob = ocrJob.refresh;
  useEffect(() => {
    if (!bookId || !ocrAvailable) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("book-assets-changed", async () => {
      await refreshOcrJob();
      if (disposed || !locallyRequestedOcrRef.current || !book || !pageInfo) return;
      const updated = await getBook(bookId).catch(() => null);
      if (disposed || !updated || updated.file_path === book.file_path) return;
      if (updated.pages && pageInfo.total && updated.pages !== pageInfo.total) {
        setOcrHudOpen(true);
        return;
      }
      pendingOcrReloadRef.current = {
        page: Math.max(0, pageInfo.current - 1),
        total: pageInfo.total,
        sourcePath: book.file_path,
      };
      currentCfiRef.current = `epubcfi(/6/${Math.max(2, pageInfo.current * 2)})`;
      setBook(updated);
      setOcrHudOpen(false);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [book, bookId, currentCfiRef, ocrAvailable, pageInfo, refreshOcrJob, setBook]);

  useEffect(() => {
    if (!bookReady || !book) return;
    let timer: number | null = null;
    const deadline = Date.now() + 5_000;
    const showWhenTextLayerReady = () => {
      const pending = pendingOcrReloadRef.current;
      if (!pending || book.file_path === pending.sourcePath) return;
      const contents = viewRef.current?.renderer?.getContents?.() ?? [];
      const target = contents.find((content: { index?: number; doc?: Document }) => content.index === pending.page)
        ?? contents[0];
      const textLayer = target?.doc?.querySelector?.(".textLayer") as HTMLElement | null;
      if (textLayer?.querySelector(".endOfContent") && textLayer.textContent?.trim()) {
        pendingOcrReloadRef.current = null;
        locallyRequestedOcrRef.current = false;
        onToast(t("ocr.reader.completedToast"));
      } else if (Date.now() < deadline) {
        timer = window.setTimeout(showWhenTextLayerReady, 100);
      }
    };
    showWhenTextLayerReady();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [book, bookReady, onToast, pageInfo, t, viewRef]);

  return {
    ocrAvailable,
    ocrHudOpen,
    setOcrHudOpen,
    ocrPackage,
    ocrJob,
    onMissingPdfTextIntent,
    openOcrSettings,
    startOcr,
    retryOcr,
  };
}
