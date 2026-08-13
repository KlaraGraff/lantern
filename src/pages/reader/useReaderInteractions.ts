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
import { createLongPressTracker, LONG_PRESS } from "../../utils/long-press";
import { createSwipeTracker } from "./swipe-page-turn";
import { classifyReaderTapInBox, frameClientXToHost, type TapZone } from "./tap-zones";
import { isNarrowNow } from "../../hooks/useIsNarrow";

/**
 * How close to the edge a drag has to get before the page turns. Wide enough to
 * be reachable without precision, narrow enough that selecting the last word on
 * a line does not trigger it.
 */
const EDGE_TURN_MARGIN_PX = 24;
/** Minimum spacing between page turns while the pointer is held at the edge. */
const EDGE_TURN_INTERVAL_MS = 600;

const TOUCH_CALLOUT_STYLE_ID = "lantern-touch-callout";

interface InteractionView {
  getCFI(index: number, range: Range): string;
  next(): Promise<void>;
  prev(): Promise<void>;
  /**
   * The view's box in host-viewport coordinates. `foliate-view` is a host
   * element, so this is the DOM's own — declared here because the tap zones
   * and the edge-turn drag measure against the box the reader sees, not the
   * chapter document (which, paginated, is every page of the section side by
   * side).
   */
  getBoundingClientRect(): { left: number; right: number; width: number };
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
  /**
   * Whether the phone's chrome is currently raised. A ref rather than a value
   * because the listeners below are installed once per chapter document and
   * outlive every re-render — a captured boolean would be whatever it was when
   * the chapter loaded.
   */
  chromeOpenRef: MutableRefObject<boolean>;
  /** One-handed mode ("both margins advance") — a ref for the same reason as `chromeOpenRef`. */
  oneHandModeRef: MutableRefObject<boolean>;
  /**
   * What a tap on the page means below the breakpoint: the outer thirds page,
   * the middle one toggles the chrome. Called with `"menu"` for any tap while
   * the chrome is up, since the whole page is a dismiss target then.
   */
  onTapZone(zone: TapZone): void;
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
  handleSwipePageTurn(direction: "previous" | "next"): void;
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
  chromeOpenRef,
  oneHandModeRef,
  onTapZone,
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
  handleSwipePageTurn,
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
    // WebKit answers a long press on text with its own callout (拷贝 / 查询),
    // which would open on top of the menu this file now opens for the same
    // gesture. Only the callout is suppressed — selection itself is
    // `-webkit-user-select`, deliberately untouched, so dragging the handles
    // still works and the reader can still hand a passage to the OS. Scoped by
    // the same media query the `touch:` class variant uses, so a mouse-driven
    // document keeps exactly the behaviour it had.
    if (!doc.getElementById(TOUCH_CALLOUT_STYLE_ID)) {
      const calloutStyle = doc.createElement("style");
      calloutStyle.id = TOUCH_CALLOUT_STYLE_ID;
      calloutStyle.textContent = "@media (pointer: coarse){html{-webkit-touch-callout:none}}";
      (doc.head ?? doc.documentElement).appendChild(calloutStyle);
    }

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

    /**
     * The menu for a range the pointer landed on, shaped exactly the way the
     * single-click path shapes it.
     *
     * `viaSelection` is the one thing that varies: a range taken from a
     * selection the reader already had is a selection menu of whatever kind
     * the text classifies as, while a range resolved from the point under the
     * pointer is always the word menu. That distinction is not cosmetic — the
     * reader only counts a dictionary glance towards mastery for the
     * `word-menu` trigger, so it decides whether a lookup on this platform
     * feeds the mastery engine at all.
     */
    const interactionForRange = (
      range: Range,
      viaSelection: boolean,
    ): ReaderInteraction | null => {
      const text = range.toString().trim();
      const normalizedText = normalizeInteractionText(text);
      const location = view.getCFI(index, range);
      if (!text || !normalizedText || !location) return null;
      const locale = doc.documentElement.lang || undefined;
      return {
        trigger: viaSelection ? "selection-menu" : "word-menu",
        kind: viaSelection ? classifySelection(text, locale) : "word",
        text,
        normalizedText,
        context: contextForRange(range, text),
        location,
        anchorRect: viewportRectForRange(range),
        source: "foliate",
        format: bookFormat === "pdf" ? "pdf" : "epub",
        locale,
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
    /**
     * Long press — the touch spelling of right-click.
     *
     * A finger has no second button, so every path into this menu was a
     * `contextmenu` event and a phone could not open it at all. Held here
     * rather than in the tracker: the tracker decides, these three carry the
     * decision through the rest of the gesture.
     */
    const longPress = createLongPressTracker();
    /**
     * The other gesture the same finger might mean. It is fed from the same
     * three listeners as the long press, and the two are wired to rule each
     * other out: a hold that fires cancels the swipe, and a swipe that turns a
     * page has already travelled far past the hold's tolerance.
     */
    const swipe = createSwipeTracker();
    let longPressTimer: number | null = null;
    /**
     * The selection this press started with, taken at pointerdown rather than
     * when the timer fires. WebKit makes its own word selection partway
     * through a long press, so a snapshot read at 500 ms would sometimes find
     * a selection the reader never made — and the menu would open as a
     * "selection menu" on a word, which is the shape that does *not* count a
     * dictionary glance. Read before the finger has been down long enough for
     * WebKit to have done anything, the answer is the reader's alone.
     */
    let longPressSnapshot: ReaderSelectionSnapshot | null = null;
    /** Same job as `tripleClickSelectionHandled`, for the press that held. */
    let longPressSelectionHandled = false;
    const cancelLongPress = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      longPress.cancel();
    };
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
      if (tripleClickSelectionHandled || longPressSelectionHandled) {
        tripleClickSelectionHandled = false;
        longPressSelectionHandled = false;
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

    /**
     * The held press resolved. Deliberately the same two steps the single-click
     * path takes — snapshot first, word under the pointer second — so the menu
     * a phone opens carries the identical interaction a mouse would have
     * produced, down to the trigger the mastery engine reads.
     */
    const openLongPressMenu = (x: number, y: number, target: EventTarget | null) => {
      if (!supportsSelection || isInteractiveReaderTarget(target)) return;
      cancelPendingWordClick();
      cancelPendingSelectionMenu();
      const selectionRange = rangeFromSelectionSnapshotAtPoint(longPressSnapshot, x, y);
      const range = selectionRange ?? wordRangeAtPoint(
        doc,
        x,
        y,
        doc.documentElement.lang || undefined,
      );
      if (!range) {
        // A held press on a scanned page is the same "there is no text here"
        // question a right-click asks, and gets the same answer.
        if (showMissingPdfTextIntent()) longPress.suppressClick(Date.now());
        return;
      }
      const interaction = interactionForRange(range, Boolean(selectionRange));
      if (!interaction) return;
      // This gesture decided what is selected; the pointerup closing it must
      // not re-derive a selection and reschedule a menu over this one.
      longPressSelectionHandled = true;
      // Same 80 ms window `finalizePointerSelection` uses — replacing the
      // selection fires `selectionchange`, and letting that reschedule would
      // drop back to the word-suppressing default menu.
      selectionNormalizationUntil = Date.now() + 80;
      replaceDocumentSelection(doc, range);
      selectionSnapshot = snapshotSelectionRange(range);
      longPress.suppressClick(Date.now());
      openLearningInteraction(interaction);
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
      cancelLongPress();
      // Not while text is selected: the finger is most likely on a selection
      // handle, and dragging one across the page is how a reader extends a
      // selection — the one horizontal touch gesture that must never page.
      swipe.cancel();
      if (!selectedRange(doc)) {
        swipe.begin({
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
          button: event.button,
          x: event.clientX,
          y: event.clientY,
          // One clock for every event this tracker sees, never
          // `event.timeStamp`: that is relative to the time origin of the
          // document the event came from, and foliate's iframe gets a fresh
          // origin on every section load. `wheel-page-turn.ts` carries the
          // same note for the same reason.
        }, performance.now());
      }
      longPressSelectionHandled = false;
      longPressSnapshot = null;
      if (longPress.begin({
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        button: event.button,
        isPrimary: event.isPrimary,
        x: event.clientX,
        y: event.clientY,
      })) {
        longPressSnapshot = snapshotSelectionRange(selectedRange(doc));
        const { pointerId, clientX, clientY, target } = event;
        longPressTimer = window.setTimeout(() => {
          longPressTimer = null;
          if (readerInteractionGenerationRef.current !== interactionGeneration) return;
          if (!longPress.hold(pointerId)) return;
          // The menu is opening under this finger. Whatever it does next is
          // not a page turn — without this, a reader who holds, sees the menu,
          // then drags would page out from under it.
          swipe.cancel(pointerId);
          openLongPressMenu(clientX, clientY, target);
        }, LONG_PRESS.holdMs);
      }
    });
    doc.addEventListener("pointermove", (event: PointerEvent) => {
      // Ahead of the `activePointerId` guard below: a scroll in continuous mode
      // moves a pointer the selection bookkeeping may never have claimed, and
      // that still has to call the hold off.
      if (longPress.move(event.pointerId, event.clientX, event.clientY)) cancelLongPress();
      const turn = swipe.move(event.pointerId, event.clientX, event.clientY, performance.now());
      if (turn) handleSwipePageTurn(turn);
      if (event.pointerId !== activePointerId || !pointerStart) return;
      if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) >= 5) {
        pointerMoved = true;
      }
    });
    doc.addEventListener("pointerup", (event: PointerEvent) => {
      cancelLongPress();
      swipe.cancel(event.pointerId);
      finalizePointerSelection(event.pointerId);
    });
    doc.addEventListener("pointercancel", (event: PointerEvent) => {
      cancelLongPress();
      swipe.cancel(event.pointerId);
      finalizePointerSelection(event.pointerId, false);
    });
    doc.addEventListener("lostpointercapture", (event: PointerEvent) => {
      finalizePointerSelection(event.pointerId);
    });
    const contentWindow = doc.defaultView;
    const handleContentPointerUp = (event: PointerEvent) => {
      cancelLongPress();
      swipe.cancel(event.pointerId);
      finalizePointerSelection(event.pointerId);
    };
    const handleContentPointerCancel = (event: PointerEvent) => {
      cancelLongPress();
      swipe.cancel(event.pointerId);
      finalizePointerSelection(event.pointerId, false);
    };
    const handleContentBlur = () => {
      if (window.document.hasFocus()) return;
      cancelLongPress();
      finalizePointerSelection(undefined, false);
    };
    const handleHostPointerUp = () => {
      cancelLongPress();
      swipe.cancel();
      finalizePointerSelection();
    };
    const handleHostPointerCancel = () => {
      cancelLongPress();
      swipe.cancel();
      finalizePointerSelection(undefined, false);
    };
    const handleHostBlur = () => {
      cancelLongPress();
      finalizePointerSelection(undefined, false);
    };
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
      // The synthetic click that trails a long press. Answered before anything
      // else, because the first thing this handler does is clear the menu the
      // press just opened — and because letting it through would also queue a
      // word lookup, i.e. the reader would finish a long press and get a page
      // of card they never asked for.
      if (longPress.consumeClick(Date.now())) return;
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
        event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.shiftKey
      ) return;
      if (isInteractiveReaderTarget(event.target)) return;
      const selection = doc.getSelection?.();
      if (selection && !selection.isCollapsed) return;
      // Below the breakpoint a tap that lands on a word opens it, and only a
      // tap that misses every word falls back to the three tap zones. Both
      // answers fire immediately — no double-click grace: the lookup is the
      // primary reading gesture on a phone, and any wait between finger and
      // response reads as lag. The cost, accepted as a product call, is that a
      // page-turn tap aimed at the text looks a word up instead; paging keeps
      // the blank space, the margins, and the swipe.
      //
      // Placed after everything that already claimed the click — an
      // annotation, the synthetic click trailing a long press, a link, a live
      // selection. A book with no selectable text (fb2/cbz, or mobi on a
      // platform without conversion, or a scanned PDF) skips the word test:
      // there is no word to open, and the tap zones are its only way to
      // summon the chrome at all on a phone.
      //
      // `clientX` is in the iframe's coordinate system, and in paginated flow
      // that iframe is the whole chapter laid out side by side — not the page
      // on screen. Map the tap back to host coordinates through the frame's
      // own box (its rect already carries the page scroll) and cut the thirds
      // from the view element, the box the reader actually sees — the same box
      // the zone guide draws its columns over.
      if (isNarrowNow()) {
        if (chromeOpenRef.current) {
          // With the chrome up, every tap means "put it away", and it goes
          // away now: no second tap could change the answer, and a visible lag
          // on a dismiss reads as a control that did not register the press.
          onTapZone("menu");
          return;
        }
        if (supportsSelection) {
          const wordRange = wordRangeAtPoint(
            doc,
            event.clientX,
            event.clientY,
            doc.documentElement.lang || undefined,
          );
          const wordInteraction = wordRange ? interactionForRange(wordRange, false) : null;
          if (wordRange && wordInteraction) {
            replaceDocumentSelection(doc, wordRange);
            selectionSnapshot = snapshotSelectionRange(wordRange);
            openLearningInteraction(wordInteraction);
            return;
          }
        }
        const frameRect = doc.defaultView?.frameElement?.getBoundingClientRect();
        const zone = frameRect
          ? classifyReaderTapInBox(
            frameClientXToHost(event.clientX, frameRect, doc.documentElement.clientWidth),
            view.getBoundingClientRect(),
            oneHandModeRef.current,
          )
          : "menu";
        onTapZone(zone);
        return;
      }
      if (!supportsSelection) return;
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
      const interaction = interactionForRange(range, Boolean(selectionRange));
      if (!interaction) return;
      // Immediate, not deferred behind the double-click grace — the tap is
      // the lookup gesture and the card must answer it. A double- or
      // triple-click that follows repaints the card mid-flight; that flicker
      // is the accepted cost of a first click that never waits.
      openLearningInteraction(interaction);
    });
    doc.addEventListener("dblclick", (event: MouseEvent) => {
      cancelPendingWordClick();
      cancelPendingSelectionMenu();
      // Below the breakpoint each of the two taps already got its own
      // immediate answer from the click handler — a third answer here would
      // only reopen the same card over itself.
      if (isNarrowNow()) return;
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

      // Same mapping as the tap zones above: in paginated flow the chapter
      // document's edge is pages away from the finger, so the edges that turn
      // the page are the visible box's.
      const frameRect = doc.defaultView?.frameElement?.getBoundingClientRect();
      if (!frameRect) return;
      const box = view.getBoundingClientRect();
      if (!(box.width > 0)) return;
      const hostX = frameClientXToHost(event.clientX, frameRect, doc.documentElement.clientWidth);
      const direction = hostX >= box.right - EDGE_TURN_MARGIN_PX
        ? "next"
        : hostX <= box.left + EDGE_TURN_MARGIN_PX
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
    chromeOpenRef,
    oneHandModeRef,
    onTapZone,
    doubleClickQuickLookupRef,
    tripleClickQuickSelectRef,
    tripleClickScopeRef,
    forceClickSuppressedUntilRef,
    handlePageTurnContextMenu,
    handleReaderBinding,
    handlePageTurnKeyDown,
    handlePageTurnMouseDown,
    handlePageTurnWheel,
    handleSwipePageTurn,
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
