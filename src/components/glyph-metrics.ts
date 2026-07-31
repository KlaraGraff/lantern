/**
 * How tall the text itself is, as opposed to how tall its line is.
 *
 * Both ways a marker can be painted over book text — an SVG rect from
 * `Range.getClientRects()`, or a highlight overlay — are sized by the line box,
 * so a generous line height turns a marked word into a tall slab. The font's
 * own ascent and descent are the height a reader means by "the word", and the
 * canvas text metrics report exactly that.
 */

interface DocumentMetrics {
  context: CanvasRenderingContext2D | null;
  heights: Map<string, number>;
}

const perDocument = new WeakMap<Document, DocumentMetrics>();

function documentMetrics(doc: Document): DocumentMetrics {
  const existing = perDocument.get(doc);
  if (existing) return existing;
  // Measured inside the text's own document so that fonts installed there —
  // bundled reading faces, an EPUB's embedded @font-face — actually resolve.
  const created: DocumentMetrics = {
    context: doc.createElement("canvas").getContext("2d"),
    heights: new Map(),
  };
  perDocument.set(doc, created);
  return created;
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

/** Ascent + descent of the font `node` is rendered in, in CSS pixels. */
export function fontBoxHeight(node: Node | null): number | null {
  const element = elementOf(node);
  const view = element?.ownerDocument?.defaultView;
  if (!element || !view) return null;
  const computed = view.getComputedStyle(element);
  const fontSize = Number.parseFloat(computed.fontSize);
  if (!Number.isFinite(fontSize) || fontSize <= 0) return null;
  const font = `${computed.fontStyle} ${computed.fontWeight} ${fontSize}px ${computed.fontFamily}`;

  const metrics = documentMetrics(element.ownerDocument);
  const cached = metrics.heights.get(font);
  if (cached !== undefined) return cached;
  let height = 0;
  if (metrics.context) {
    try {
      metrics.context.font = font;
      const measured = metrics.context.measureText("Hxbdfgjpqy");
      height = (measured.fontBoundingBoxAscent ?? 0) + (measured.fontBoundingBoxDescent ?? 0);
    } catch {
      height = 0;
    }
  }
  // Without usable metrics, a typical ascent + descent is a better guess than
  // the line box, which is what we are trying to get away from.
  const value = height > 0 ? height : fontSize * 1.2;
  metrics.heights.set(font, value);
  return value;
}

/**
 * How far to move a line-box-sized rect's top edge down so it hugs the glyphs.
 * Half-leading sits evenly above and below the inline box, so the font box is
 * centred in the line box.
 */
export function glyphInset(rectHeight: number, boxHeight: number | null): number {
  if (!boxHeight || !Number.isFinite(boxHeight)) return 0;
  return Math.max(0, (rectHeight - boxHeight) / 2);
}
