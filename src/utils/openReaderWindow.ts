import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, currentMonitor, getCurrentWindow, monitorFromPoint, type Monitor } from "@tauri-apps/api/window";
import { emitTo, listen } from "@tauri-apps/api/event";
import { createUuid } from "./randomUuid";
import {
  MIN_VISIBLE,
  cascadeOrigin,
  isOriginOnAnyScreen,
  restoredOrigin,
  type Point,
  type Rect,
} from "./reader-window-placement";

/** Where in a book to land, and which panel to land with open. */
export interface ReaderTarget {
  openVocab?: boolean;
  openChat?: boolean;
  chatId?: string;
  cfi?: string | null;
  page?: number;
}

/**
 * The reader's address. The same string serves both ways of getting there — a
 * new window loads it, and a single-window platform navigates to it — so the
 * two paths cannot drift on what a target means.
 */
export function readerUrl(bookId: string, target?: ReaderTarget): string {
  const params = new URLSearchParams();
  if (target?.openVocab) params.set("openVocab", "true");
  if (target?.openChat) params.set("openChat", "true");
  if (target?.chatId) params.set("chatId", target.chatId);
  if (target?.cfi) params.set("cfi", target.cfi);
  if (Number.isInteger(target?.page) && target!.page! >= 0) params.set("page", String(target!.page));
  const query = params.toString();
  return query ? `/reader/${bookId}?${query}` : `/reader/${bookId}`;
}

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 960;
const MIN_WIDTH = 700;
const MIN_HEIGHT = 500;

/** What `useWindowFramePersistence` wrote for this book, if anything. `x`/`y`
 *  are logical, straight back to the window options; `physicalX`/`physicalY`
 *  are the same corner in the space monitors report in, and exist only to
 *  answer "is that spot still on a screen?" without having to guess how a
 *  mixed-DPI desktop maps physical to logical. */
export interface SavedFrame {
  width: number;
  height: number;
  x?: number;
  y?: number;
  physicalX?: number;
  physicalY?: number;
}

export const READER_FRAME_KEY_PREFIX = "reader-window-";

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function loadSavedFrame(bookId: string): SavedFrame {
  const fallback: SavedFrame = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  try {
    const raw = localStorage.getItem(`${READER_FRAME_KEY_PREFIX}${bookId}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const width = readNumber(parsed.width) ?? DEFAULT_WIDTH;
    const height = readNumber(parsed.height) ?? DEFAULT_HEIGHT;
    const x = readNumber(parsed.x);
    const y = readNumber(parsed.y);
    const physicalX = readNumber(parsed.physicalX);
    const physicalY = readNumber(parsed.physicalY);
    return {
      width: Math.max(MIN_WIDTH, Math.round(width)),
      height: Math.max(MIN_HEIGHT, Math.round(height)),
      // A position only counts if both halves and both spaces survived. A
      // record written before positions were remembered has neither, and falls
      // through to the cascade, which is the right answer for it anyway.
      ...(x !== undefined && y !== undefined && physicalX !== undefined && physicalY !== undefined
        ? { x, y, physicalX, physicalY }
        : {}),
    };
  } catch {
    return fallback;
  }
}

function logicalWorkArea(monitor: Monitor): Rect {
  const position = monitor.workArea.position.toLogical(monitor.scaleFactor);
  const size = monitor.workArea.size.toLogical(monitor.scaleFactor);
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

function physicalWorkArea(monitor: Monitor): { area: Rect; margin: number } {
  const { position, size } = monitor.workArea;
  return {
    area: { x: position.x, y: position.y, width: size.width, height: size.height },
    margin: MIN_VISIBLE * monitor.scaleFactor,
  };
}

/** Top-left corners of the reader windows already on screen, so a new one does
 *  not land on top of one of them. The library window is not in this list on
 *  purpose: it is the anchor the cascade already steps away from. */
async function occupiedOrigins(): Promise<Point[]> {
  const origins: Point[] = [];
  for (const webview of await getAllWebviewWindows()) {
    if (!webview.label.startsWith("reader-")) continue;
    try {
      const scale = await webview.scaleFactor();
      const position = (await webview.outerPosition()).toLogical(scale);
      origins.push({ x: position.x, y: position.y });
    } catch {
      // Closed between being listed and being asked. One fewer thing to dodge.
    }
  }
  return origins;
}

/**
 * The new window's top-left, in logical pixels, or `null` to let the OS decide
 * — the pre-cascade behaviour, kept as the fallback for when the platform will
 * not say where anything is. Every branch here is best-effort: a window in a
 * slightly odd spot beats a book that would not open.
 */
async function resolvePosition(saved: SavedFrame): Promise<Point | null> {
  try {
    const opener = getCurrentWindow();
    const openerScale = await opener.scaleFactor();
    const openerPhysical = await opener.outerPosition();
    const anchor = openerPhysical.toLogical(openerScale);

    const monitors = await availableMonitors();
    const openerMonitor =
      (await monitorFromPoint(openerPhysical.x, openerPhysical.y)) ??
      (await currentMonitor()) ??
      monitors[0] ??
      null;
    if (!openerMonitor) return null;

    const taken = await occupiedOrigins();

    const { x, y, physicalX, physicalY } = saved;
    if (x !== undefined && y !== undefined && physicalX !== undefined && physicalY !== undefined) {
      // Which screen the remembered corner is on, not just whether it is on
      // one: a window left on the external display has to come back to the
      // external display, and clamping it against the opener's screen would
      // drag it home every time.
      const host = monitors.find((monitor) => {
        const { area, margin } = physicalWorkArea(monitor);
        return isOriginOnAnyScreen({ x: physicalX, y: physicalY }, [{ area, margin }]);
      });
      if (host) return restoredOrigin({ x, y }, logicalWorkArea(host), taken);
    }

    return cascadeOrigin({ anchor: { x: anchor.x, y: anchor.y }, workArea: logicalWorkArea(openerMonitor), taken });
  } catch {
    return null;
  }
}

/**
 * Open a book in its own OS window, or focus and re-aim the window already
 * showing it. Only reachable where windows exist — `useOpenBook` picks between
 * this and an in-window navigation.
 */
export async function openReaderWindow(
  bookId: string,
  options?: ReaderTarget
): Promise<void> {
  const label = `reader-${bookId}`;

  // Focus existing window if already open
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    const navigationId = createUuid();
    let acknowledge: () => void = () => {};
    const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
    const unlisten = await listen<{ navigationId: string }>("reader:navigate:ack", (event) => {
      if (event.payload.navigationId === navigationId) acknowledge();
    });
    await emitTo(label, "reader:navigate", {
      navigationId,
      cfi: options?.cfi ?? undefined,
      page: options?.page,
      openVocab: options?.openVocab ?? false,
      openChat: options?.openChat ?? false,
      chatId: options?.chatId ?? undefined,
    });
    await Promise.race([
      acknowledged,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
    unlisten();
    await existing.setFocus();
    return;
  }

  const saved = loadSavedFrame(bookId);
  const position = await resolvePosition(saved);

  new WebviewWindow(label, {
    url: readerUrl(bookId, options),
    title: "Lantern",
    width: saved.width,
    height: saved.height,
    // Omitted rather than guessed when the platform would not say where the
    // screens are: Tauri only honours `x` if `y` is set too, and half a
    // position is worse than none.
    ...(position ? { x: position.x, y: position.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    titleBarStyle: "overlay",
    hiddenTitle: true,
  });
}
