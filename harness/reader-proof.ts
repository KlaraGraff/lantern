/** Layout evidence from the real foliate iframe, not reader chrome or fixtures. */
export interface ReaderEvidence {
  foreground: boolean;
  focused: boolean;
  bookLoaded: boolean;
  viewWidth: number;
  viewHeight: number;
  contentDocuments: number;
  visibleTextRects: number;
  textSample: string;
  animationFrames: number;
}

interface FoliateView extends Element {
  book?: unknown;
  renderer?: { getContents?: () => Array<{ doc?: Document }> };
}

export function readerHasLayout(evidence: ReaderEvidence): boolean {
  return evidence.foreground && evidence.bookLoaded && evidence.viewWidth > 0
    && evidence.viewHeight > 0 && evidence.contentDocuments > 0
    && evidence.visibleTextRects > 0
    && evidence.textSample.includes("Lantern opens this deflated chapter");
}

export function readerIsReady(evidence: ReaderEvidence): boolean {
  return readerHasLayout(evidence) && evidence.animationFrames >= 2;
}

interface Rect { left: number; top: number; right: number; bottom: number }
export function intersects(...rects: Rect[]): boolean {
  return Math.max(...rects.map((r) => r.left)) < Math.min(...rects.map((r) => r.right))
    && Math.max(...rects.map((r) => r.top)) < Math.min(...rects.map((r) => r.bottom));
}

export function inspectReader(animationFrames: number): ReaderEvidence {
  const view = document.querySelector("foliate-view") as FoliateView | null;
  const bounds = view?.getBoundingClientRect();
  const evidence: ReaderEvidence = {
    foreground: document.visibilityState === "visible", focused: document.hasFocus(),
    bookLoaded: !!view?.book, viewWidth: bounds?.width ?? 0, viewHeight: bounds?.height ?? 0,
    contentDocuments: 0, visibleTextRects: 0, textSample: "", animationFrames,
  };
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  if (!view || !bounds || !intersects(bounds, viewport)
    || !view.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return evidence;
  for (const { doc } of view.renderer?.getContents?.() ?? []) {
    if (!doc?.body) continue;
    evidence.contentDocuments++;
    const frame = doc.defaultView?.frameElement;
    const frameBounds = frame?.getBoundingClientRect();
    if (!frame || !frameBounds || !frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      || !intersects(frameBounds, bounds, viewport)) continue;
    const nodes = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = nodes.nextNode())) {
      const text = node.textContent?.trim() ?? "";
      if (!text || !node.parentElement?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const range = doc.createRange();
      range.selectNodeContents(node);
      const visible = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0
        && intersects({ left: frameBounds.left + rect.left, right: frameBounds.left + rect.right,
          top: frameBounds.top + rect.top, bottom: frameBounds.top + rect.bottom }, frameBounds, bounds, viewport));
      if (!visible.length) continue;
      evidence.visibleTextRects += visible.length;
      evidence.textSample = (evidence.textSample + " " + text).trim().slice(0, 240);
    }
  }
  return evidence;
}
