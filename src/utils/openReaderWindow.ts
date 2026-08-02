import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { createUuid } from "./randomUuid";

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

function loadSavedSize(bookId: string): { width: number; height: number } {
  try {
    const raw = localStorage.getItem(`reader-window-${bookId}`);
    if (!raw) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown };
    const width = typeof parsed.width === "number" && Number.isFinite(parsed.width) ? parsed.width : DEFAULT_WIDTH;
    const height = typeof parsed.height === "number" && Number.isFinite(parsed.height) ? parsed.height : DEFAULT_HEIGHT;
    return {
      width: Math.max(MIN_WIDTH, Math.round(width)),
      height: Math.max(MIN_HEIGHT, Math.round(height)),
    };
  } catch {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
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

  const { width, height } = loadSavedSize(bookId);

  new WebviewWindow(label, {
    url: readerUrl(bookId, options),
    title: "Lantern",
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    titleBarStyle: "overlay",
    hiddenTitle: true,
  });
}
