import {
  useCallback,
  type MutableRefObject,
} from "react";
import {
  classifySelection,
  contextForRange,
  expandRangeToWordBoundaries,
  forwardReaderContextMenuKey,
  isInteractiveReaderTarget,
  normalizeInteractionText,
  rangeFromSelectionSnapshotAtPoint,
  replaceDocumentSelection,
  selectedRange,
  snapshotSelectionRange,
  tripleClickRangeAtPoint,
  viewportRectForRange,
  wordRangeAtPoint,
  type ReaderInteraction,
  type ReaderSelectionSnapshot,
  type TripleClickScope,
} from "../../components/reader-interaction";
import { bindingFromKeyboardEvent } from "../../components/reader-bindings";
import { appZoomCommandFor, nextAppZoom } from "../../services/app-zoom";
import { persistAppZoom, readAppZoom } from "../../services/app-zoom-window";
import { clickCountGraceMs } from "./click-grace";

/**
 * How close to the edge a drag has to get before the page turns. Wide enough to
 * be reachable without precision, narrow enough that selecting the last word on
 * a line does not trigger it.
 */
const EDGE_TURN_MARGIN_PX = 24;
/** Minimum spacing between page turns while the pointer is held at the edge. */
const EDGE_TURN_INTERVAL_MS = 600;

interface InteractionView {
  getCFI(index: number, range: Range): string;
  next(): Promise<void>;
  prev(): Promise<void>;
  renderer?: {
    getContents?(): Array<{ doc?: Document }>;
  };
}

interface InstallDocumentInteractionsOptions {
  doc: Document;
  index: number;
  view: InteractionView;
  bookFormat: string;
  interactionGeneration: number;
}

interface ReaderInteractionsOptions {
  supportsSelection: boolean;
  pendingSelectionMenuRef: MutableRefObject<number | null>;
  pendingWordClickRef: MutableRefObject<number | null>;
  readerInteractionGenerationRef: MutableRefObject<number>;
  forceClickSuppressedUntilRef: MutableRefObject<number>;
  annotationClickDocumentRef: MutableRefObject<Document | null>;
  doubleClickQuickLookupRef: MutableRefObject<boolean>;
  tripleClickQuickSelectRef: MutableRefObject<boolean>;
  tripleClickScopeRef: MutableRefObject<TripleClickScope>;
  cancelPendingSelectionMenu(): void;
  cancelPendingWordClick(): void;
  openLearningInteraction(interaction: ReaderInteraction): void;
  setContextMenu(value: ReaderInteraction | null): void;
  onMissingPdfTextIntent(pageIndex: number): void;
  handleZoom(delta: number): void;
  handleZoomFit(): void;
  handlePageTurnKeyDown(event: KeyboardEvent): void;
  handlePageTurnMouseDown(event: MouseEvent): void;
  handlePageTurnContextMenu(event: MouseEvent): void;
  handlePageTurnWheel(event: WheelEvent): void;
  handleReaderBinding(trigger: string, interaction: ReaderInteraction | null): boolean;
  /**
   * The unified jump-history return action (P1.3), bound to ⌘[ and Alt+←
   * inside each chapter document (a separate document context from the main
   * window, so a window-level listener alone cannot catch it here). Returns
   * whether it actually navigated, so the keystroke is only swallowed when
   * there was something to return to.
   */
  onReturnJump(): boolean;
  /**
   * ⌘F / Ctrl+F — opens the P1.2 book search panel, bound inside each chapter
   * document for the same reason `onReturnJump` is: a window-level listener
   * alone cannot catch it inside a foliate chapter's iframe.
   */
  onOpenSearch(): void;
}

function canvasHasVisibleContent(canvas: HTMLCanvasElement): boolean {
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return true;
    const stepX = Math.max(1, Math.floor(canvas.width / 32));
    const stepY = Math.max(1, Math.floor(canvas.height / 32));
    let visibleSamples = 0;
    for (let y = Math.floor(stepY / 2); y < canvas.height; y += stepY) {
      for (let x = Math.floor(stepX / 2); x < canvas.width; x += stepX) {
        const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
        if (alpha > 16 && (red < 246 || green < 246 || blue < 246)) {
          visibleSamples += 1;
          if (visibleSamples >= 3) return true;
        }
      }
    }
    return false;
  } catch {
    // A rendered page whose pixels cannot be sampled is still a valid text-intent target.
    return true;
  }
}

export function useReaderInteractions({
  supportsSelection,
  pendingSelectionMenuRef,
  pendingWordClickRef,
  readerInteractionGenerationRef,
  forceClickSuppressedUntilRef,
  annotationClickDocumentRef,
  doubleClickQuickLookupRef,
  tripleClickQuickSelectRef,
  tripleClickScopeRef,
  cancelPendingSelectionMenu,
  cancelPendingWordClick,
  openLearningInteraction,
  setContextMenu,
  onMissingPdfTextIntent,
  handleZoom,
  handleZoomFit,
  handlePageTurnKeyDown,
  handlePageTurnMouseDown,
  handlePageTurnContextMenu,
  handlePageTurnWheel,
  handleReaderBinding,
  onReturnJump,
  onOpenSearch,
}: ReaderInteractionsOptions) {
  const installDocumentInteractions = useCallback(({
    doc,
    index,
    view,
    bookFormat,
    interactionGeneration,
  }: InstallDocumentInteractionsOptions) => {
    const missingPdfTextLayer = () => {
      if (bookFormat !== "pdf") return false;
      const canvas = doc.querySelector("#canvas > canvas") as HTMLCanvasElement | null;
      const textLayer = doc.querySelector(".textLayer") as HTMLElement | null;
      return Boolean(
        canvas
        && canvas.width > 0
        && canvas.height > 0
        && textLayer?.querySelector(".endOfContent")
        && !textLayer.textContent?.trim()
        && canvasHasVisibleContent(canvas),
      );
    };
    const showMissingPdfTextIntent = () => {
      if (!missingPdfTextLayer()) return false;
      onMissingPdfTextIntent(index);
      return true;
    };

    const interactionForSelection = (
      trigger: ReaderInteraction["trigger"],
    ): ReaderInteraction | null => {
      if (!supportsSelection) return null;
      const range = selectedRange(doc);
      if (!range) return null;
      const text = range.toString().trim();
      const normalizedText = normalizeInteractionText(text);
      const location = view.getCFI(index, range);
      if (!text || !normalizedText || !location) return null;
      return {
        trigger,
        kind: classifySelection(text, doc.documentElement.lang || undefined),
        text,
        normalizedText,
        context: contextForRange(range, text),
        location,
        anchorRect: viewportRectForRange(range),
        source: "foliate",
        format: bookFormat === "pdf" ? "pdf" : "epub",
        locale: doc.documentElement.lang || undefined,
      };
    };

    let activePointerId: number | null = null;
    let selectionSnapshot: ReaderSelectionSnapshot | null = null;
    let pointerCaptureTarget: Element | null = null;
    let pointerStart: { x: number; y: number } | null = null;
    let pointerMoved = false;
    let selectionNormalizationUntil = 0;
    /**
     * Set once the triple-click handler has put its own range in place at
     * mousedown. The pointerup closing that same click still runs
     * `finalizePointerSelection`, which would re-derive the selection from the
     * document and reschedule the menu on top of the one this gesture just
     * opened — so that one finalize is skipped. Only armed while a pointer is
     * actually down, or the flag would outlive the gesture and swallow the next
     * drag's finalize.
     */
    let tripleClickSelectionHandled = false;
    /**
     * Set when the triple-click handler answered the press, so the `click` that
     * closes it can stand down instead of clearing the menu that handler just
     * opened. Cleared on every pointerdown, so it cannot outlive its gesture.
     */
    let tripleClickOwnsClick = false;
    const scheduleSelectionMenu = (delay = 150, includeWord = false) => {
      cancelPendingSelectionMenu();
      pendingSelectionMenuRef.current = window.setTimeout(() => {
        pendingSelectionMenuRef.current = null;
        if (readerInteractionGenerationRef.current !== interactionGeneration) return;
        const interaction = interactionForSelection("selection-menu");
        if (interaction && (includeWord || interaction.kind !== "word")) {
          openLearningInteraction(interaction);
        }
      }, delay);
    };

    doc.addEventListener("selectionchange", () => {
      if (activePointerId === null && Date.now() >= selectionNormalizationUntil) {
        const range = selectedRange(doc);
        selectionSnapshot = snapshotSelectionRange(range);
        scheduleSelectionMenu();
      }
    });

    const finalizePointerSelection = (pointerId?: number, openMenu = true) => {
      if (
        activePointerId === null
        || (pointerId !== undefined && pointerId !== activePointerId)
      ) return;
      const completedPointerId = activePointerId;
      activePointerId = null;
      const captureTarget = pointerCaptureTarget;
      pointerCaptureTarget = null;
      const completedDrag = pointerMoved;
      pointerStart = null;
      pointerMoved = false;
      try {
        if (captureTarget?.hasPointerCapture(completedPointerId)) {
          captureTarget.releasePointerCapture(completedPointerId);
        }
      } catch {
        // WebKit can release capture before dispatching lostpointercapture.
      }
      if (tripleClickSelectionHandled) {
        tripleClickSelectionHandled = false;
        return;
      }
      if (!openMenu || Date.now() < forceClickSuppressedUntilRef.current) {
        cancelPendingSelectionMenu();
        return;
      }
      const range = selectedRange(doc);
      const expanded = range
        ? expandRangeToWordBoundaries(range, doc.documentElement.lang || undefined)
        : null;
      if (expanded) {
        selectionNormalizationUntil = Date.now() + 80;
        replaceDocumentSelection(doc, expanded);
        selectionSnapshot = snapshotSelectionRange(expanded);
        scheduleSelectionMenu(30, true);
      } else {
        cancelPendingSelectionMenu();
        if (completedDrag) showMissingPdfTextIntent();
      }
    };

    doc.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button !== 0) return;
      activePointerId = event.pointerId;
      pointerCaptureTarget = event.target as Element | null;
      pointerStart = { x: event.clientX, y: event.clientY };
      pointerMoved = false;
      tripleClickOwnsClick = false;
      try {
        pointerCaptureTarget?.setPointerCapture(event.pointerId);
      } catch {
        // Some iframe surfaces reject capture; document/window listeners remain active.
      }
      cancelPendingSelectionMenu();
    });
    doc.addEventListener("pointermove", (event: PointerEvent) => {
      if (event.pointerId !== activePointerId || !pointerStart) return;
      if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) >= 5) {
        pointerMoved = true;
      }
    });
    doc.addEventListener("pointerup", (event: PointerEvent) => {
      finalizePointerSelection(event.pointerId);
    });
    doc.addEventListener("pointercancel", (event: PointerEvent) => {
      finalizePointerSelection(event.pointerId, false);
    });
    doc.addEventListener("lostpointercapture", (event: PointerEvent) => {
      finalizePointerSelection(event.pointerId);
    });
    const contentWindow = doc.defaultView;
    const handleContentPointerUp = (event: PointerEvent) => {
      finalizePointerSelection(event.pointerId);
    };
    const handleContentPointerCancel = (event: PointerEvent) => {
      finalizePointerSelection(event.pointerId, false);
    };
    const handleContentBlur = () => {
      if (window.document.hasFocus()) return;
      finalizePointerSelection(undefined, false);
    };
    const handleHostPointerUp = () => finalizePointerSelection();
    const handleHostPointerCancel = () => finalizePointerSelection(undefined, false);
    const handleHostBlur = () => finalizePointerSelection(undefined, false);
    contentWindow?.addEventListener("pointerup", handleContentPointerUp);
    contentWindow?.addEventListener("pointercancel", handleContentPointerCancel);
    contentWindow?.addEventListener("blur", handleContentBlur);
    if (contentWindow && contentWindow !== window) {
      window.addEventListener("pointerup", handleHostPointerUp);
      window.addEventListener("pointercancel", handleHostPointerCancel);
      window.addEventListener("blur", handleHostBlur);
      contentWindow?.addEventListener("unload", () => {
        window.removeEventListener("pointerup", handleHostPointerUp);
        window.removeEventListener("pointercancel", handleHostPointerCancel);
        window.removeEventListener("blur", handleHostBlur);
      }, { once: true });
    }
    doc.addEventListener("contextmenu", (event: MouseEvent) => {
      cancelPendingWordClick();
      cancelPendingSelectionMenu();
      const interaction = interactionForSelection("selection-menu");
      if (!interaction) {
        if (showMissingPdfTextIntent()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      openLearningInteraction(interaction);
    });
    const preserveSystemForceClick = () => {
      forceClickSuppressedUntilRef.current = Date.now() + 600;
      cancelPendingWordClick();
      cancelPendingSelectionMenu();
    };
    doc.addEventListener("webkitmouseforcedown", preserveSystemForceClick);

    doc.addEventListener("keydown", (event: KeyboardEvent) => {
      if ((event.target as Element | null)?.closest("input,textarea,select,[contenteditable='true']")) return;
      if (forwardReaderContextMenuKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const trigger = bindingFromKeyboardEvent(event);
      if (trigger) {
        const interaction = interactionForSelection("selection-menu");
        if (!interaction && showMissingPdfTextIntent()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (handleReaderBinding(trigger, interaction)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      const zoomCommand = appZoomCommandFor(event);
      // ⌘[ / Ctrl+[ / Alt+← — the jump-history return (P1.3), matching the
      // window-level shortcut below. Always swallowed on match, whether or
      // not there was anything to return to (nothing else claims this combo).
      const isReturnJumpShortcut = (
        ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === "[")
        || (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.key === "ArrowLeft")
      );
      // ⌘F / Ctrl+F — opens the book search panel (P1.2), matching the
      // window-level shortcut in Reader.tsx. Always swallowed on match.
      const isSearchShortcut = (
        (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
        && (event.key === "f" || event.key === "F")
      );
      if (isReturnJumpShortcut) {
        event.preventDefault();
        onReturnJump();
      } else if (isSearchShortcut) {
        event.preventDefault();
        onOpenSearch();
      } else if (zoomCommand) {
        // The book is its own document, and nothing pressed inside it reaches
        // the window listener that answers these keys everywhere else — so the
        // same two rules are applied here rather than forwarded.
        event.preventDefault();
        if (bookFormat === "pdf") {
          if (zoomCommand === "reset") handleZoomFit();
          else handleZoom(zoomCommand === "in" ? 10 : -10);
        } else {
          persistAppZoom(nextAppZoom(readAppZoom(), zoomCommand));
        }
      } else handlePageTurnKeyDown(event);
    });
    doc.addEventListener("mousedown", (event: MouseEvent) => {
      const range = selectedRange(doc);
      if (range) selectionSnapshot = snapshotSelectionRange(range);
      handlePageTurnMouseDown(event);
    }, true);
    doc.addEventListener("contextmenu", handlePageTurnContextMenu, true);
    doc.addEventListener("wheel", handlePageTurnWheel, { passive: false });

    doc.addEventListener("click", (event: MouseEvent) => {
      if (annotationClickDocumentRef.current === doc) return;
      // A third click the triple-click handler already answered at mousedown,
      // menu included. Clearing the context menu here would close the one that
      // gesture just opened, since a press held longer than the menu's own 30ms
      // delay puts this event after it. A third click that handler passed on
      // still comes through, and still clears.
      if (event.detail === 3 && tripleClickOwnsClick) {
        tripleClickOwnsClick = false;
        return;
      }
      setContextMenu(null);
      cancelPendingWordClick();
      if (Date.now() < forceClickSuppressedUntilRef.current) return;
      if (
        !supportsSelection
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.shiftKey
      ) return;
      if (isInteractiveReaderTarget(event.target)) return;
      const selection = doc.getSelection?.();
      if (selection && !selection.isCollapsed) return;
      if (showMissingPdfTextIntent()) return;
      const selectionRange = rangeFromSelectionSnapshotAtPoint(
        selectionSnapshot,
        event.clientX,
        event.clientY,
      );
      const range = selectionRange ?? wordRangeAtPoint(
        doc,
        event.clientX,
        event.clientY,
        doc.documentElement.lang || undefined,
      );
      if (!range) {
        // A click on blank space is a dismissal: drop the selection instead of
        // reaching for whichever word happens to be nearest.
        selectionSnapshot = null;
        doc.getSelection?.()?.removeAllRanges();
        return;
      }
      replaceDocumentSelection(doc, range);
      selectionSnapshot = snapshotSelectionRange(range);
      const text = range.toString().trim();
      const location = view.getCFI(index, range);
      const normalizedText = normalizeInteractionText(text);
      if (!text || !normalizedText || !location) return;
      const interaction: ReaderInteraction = {
        trigger: selectionRange ? "selection-menu" : "word-menu",
        kind: selectionRange
          ? classifySelection(text, doc.documentElement.lang || undefined)
          : "word",
        text,
        normalizedText,
        context: contextForRange(range, text),
        location,
        anchorRect: viewportRectForRange(range),
        source: "foliate",
        format: bookFormat === "pdf" ? "pdf" : "epub",
        locale: doc.documentElement.lang || undefined,
      };
      pendingWordClickRef.current = window.setTimeout(() => {
        pendingWordClickRef.current = null;
        openLearningInteraction(interaction);
      }, clickCountGraceMs(1, tripleClickQuickSelectRef.current));
    });
    doc.addEventListener("dblclick", (event: MouseEvent) => {
      cancelPendingWordClick();
      cancelPendingSelectionMenu();
      if (!supportsSelection || isInteractiveReaderTarget(event.target)) return;
      if (showMissingPdfTextIntent()) {
        event.preventDefault();
        return;
      }
      // Quick lookup always targets the word under the cursor. Looking up a
      // whole sentence/phrase is the selection menu's job, so a double-click
      // never consults the selection snapshot — that kept the result dependent
      // on when the browser's native word pick happened to land.
      const range = wordRangeAtPoint(
        doc,
        event.clientX,
        event.clientY,
        doc.documentElement.lang || undefined,
      );
      if (!range) return;
      const text = range.toString().trim();
      const location = view.getCFI(index, range);
      const normalizedText = normalizeInteractionText(text);
      if (!text || !normalizedText || !location) return;
      const interaction: ReaderInteraction = {
        trigger: "word-quick-lookup",
        kind: classifySelection(text, doc.documentElement.lang || undefined),
        text,
        normalizedText,
        context: contextForRange(range, text),
        location,
        anchorRect: viewportRectForRange(range),
        source: "foliate",
        format: bookFormat === "pdf" ? "pdf" : "epub",
        locale: doc.documentElement.lang || undefined,
      };
      if (!doubleClickQuickLookupRef.current) {
        if (handleReaderBinding("mouse:double", interaction)) event.preventDefault();
        return;
      }
      event.preventDefault();
      replaceDocumentSelection(doc, range);
      selectionSnapshot = snapshotSelectionRange(range);
      // Deferred, not immediate: a triple-click arrives as a double-click
      // followed by a third click, so looking the word up here would fire on the
      // way to selecting a sentence — the card would open over a selection the
      // reader never asked about. The third click cancels this the same way a
      // double-click cancels the single-click lookup, and the wait is long
      // enough for a third click the system still counts to arrive first.
      pendingWordClickRef.current = window.setTimeout(() => {
        pendingWordClickRef.current = null;
        openLearningInteraction(interaction);
      }, clickCountGraceMs(2, tripleClickQuickSelectRef.current));
    });

    // Triple-click. The browser would select the whole paragraph, but while
    // reading the useful unit is usually one sentence — and because the
    // paragraph is a single DOM node spanning however many columns, the sentence
    // this picks can cross a page the pointer could never have been dragged
    // across. Which of the two it takes is a setting; the paragraph scope goes
    // through the same code rather than deferring to the browser, so the
    // selection lands on real characters and the menu sees the same snapshot.
    //
    // On mousedown rather than click, because WebKit makes its multi-click
    // selection the moment the third press lands: by the time `click` runs the
    // paragraph has already been selected and painted, and `preventDefault`
    // there cannot undo a selection that already happened — the reader saw the
    // word, then the whole paragraph, then our sentence. Preventing the
    // mousedown default stops the paragraph from ever being drawn, leaving the
    // word→sentence step the gesture actually means.
    doc.addEventListener("mousedown", (event: MouseEvent) => {
      if (event.detail !== 3) return;
      // Before any other guard: the second click of this gesture queued a word
      // lookup, and it has to be called off even when this click resolves to no
      // sentence. Otherwise the card still opens and the gesture half-works.
      cancelPendingWordClick();
      cancelPendingSelectionMenu();
      // This gesture's own pointerup must not re-derive what was just decided
      // here — see `tripleClickSelectionHandled`.
      tripleClickSelectionHandled = activePointerId !== null;
      if (!supportsSelection || isInteractiveReaderTarget(event.target)) return;
      const locale = doc.documentElement.lang || undefined;
      const range = tripleClickRangeAtPoint(
        doc,
        event.clientX,
        event.clientY,
        tripleClickScopeRef.current,
        locale,
      );
      // Leave the browser's own selection alone rather than clearing it: an
      // unresolvable point should do nothing, not undo what was already there.
      if (!range || !range.toString().trim()) return;

      if (!tripleClickQuickSelectRef.current) {
        // Turned off, the gesture is free to carry a bound action instead. The
        // range still says what that action applies to, even though the reader
        // never sees it selected.
        const text = range.toString().trim();
        const normalizedText = normalizeInteractionText(text);
        const location = view.getCFI(index, range);
        const interaction: ReaderInteraction | null = normalizedText && location ? {
          trigger: "selection-menu",
          kind: classifySelection(text, locale),
          text,
          normalizedText,
          context: contextForRange(range, text),
          location,
          anchorRect: viewportRectForRange(range),
          source: "foliate",
          format: bookFormat === "pdf" ? "pdf" : "epub",
          locale,
        } : null;
        if (handleReaderBinding("mouse:triple", interaction)) event.preventDefault();
        return;
      }

      event.preventDefault();
      tripleClickOwnsClick = true;
      // Same window `finalizePointerSelection` uses: replacing the selection
      // fires a `selectionchange`, and letting that reschedule the menu would
      // drop back to the word-suppressing default. A pointer held down already
      // makes that listener stand down, so this covers the press whose
      // pointerdown never registered — a capture the surface refused, or a
      // synthetic click.
      selectionNormalizationUntil = Date.now() + 80;
      replaceDocumentSelection(doc, range);
      selectionSnapshot = snapshotSelectionRange(range);
      // Nothing else opens it: this handler called off the menu the second click
      // queued, the replacement `selectionchange` is inside the window above,
      // and this gesture's pointerup stands down. includeWord, because a
      // one-word sentence ("Yes.") is still the sentence the reader asked for.
      scheduleSelectionMenu(30, true);
    });

    doc.addEventListener("mousedown", () => {
      const contents = view.renderer?.getContents?.() ?? [];
      for (const { doc: otherDoc } of contents) {
        if (otherDoc && otherDoc !== doc) {
          otherDoc.defaultView?.getSelection()?.removeAllRanges();
        }
      }
    });

    // Dragging a selection to the edge of the page turns it and keeps going.
    //
    // Paginated columns hide everything but the current one, so a sentence
    // running across a page break has a second half the pointer can never reach.
    // The selection itself was never the limitation — the section is one
    // document, and a range across a column boundary is ordinary — so this only
    // has to bring the rest of it into view.
    let turning = false;
    let turnedAt = 0;
    doc.addEventListener("mousemove", (event: MouseEvent) => {
      // Only while dragging with the primary button, which is what separates
      // extending a selection from moving the pointer past the edge.
      if ((event.buttons & 1) === 0 || !supportsSelection) return;
      const selection = doc.defaultView?.getSelection();
      if (!selection || selection.isCollapsed) return;

      const width = doc.documentElement.clientWidth;
      const direction = event.clientX >= width - EDGE_TURN_MARGIN_PX
        ? "next"
        : event.clientX <= EDGE_TURN_MARGIN_PX
          ? "previous"
          : null;
      if (!direction) return;

      // Rate-limited rather than continuous: a page per frame would fly past
      // whatever the reader was trying to reach.
      const now = performance.now();
      if (turning || now - turnedAt < EDGE_TURN_INTERVAL_MS) return;
      turning = true;
      turnedAt = now;
      void (direction === "next" ? view.next() : view.prev())
        .catch(() => {})
        .finally(() => {
          turning = false;
        });
    });
  }, [
    annotationClickDocumentRef,
    cancelPendingSelectionMenu,
    cancelPendingWordClick,
    doubleClickQuickLookupRef,
    tripleClickQuickSelectRef,
    tripleClickScopeRef,
    forceClickSuppressedUntilRef,
    handlePageTurnContextMenu,
    handleReaderBinding,
    handlePageTurnKeyDown,
    handlePageTurnMouseDown,
    handlePageTurnWheel,
    handleZoom,
    handleZoomFit,
    onReturnJump,
    onOpenSearch,
    openLearningInteraction,
    pendingSelectionMenuRef,
    pendingWordClickRef,
    readerInteractionGenerationRef,
    setContextMenu,
    onMissingPdfTextIntent,
    supportsSelection,
  ]);

  return installDocumentInteractions;
}
