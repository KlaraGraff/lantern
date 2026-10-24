// The rehype half of the streaming "ink" reveal (`.ai-ink` in index.css).
//
// While an answer streams, every text run is cut into the units a reader
// sees arrive — one Han character, or one Latin word with its trailing space —
// and each unit is wrapped in a span that blurs into focus on mount. React
// keeps the spans it already rendered, so a unit animates once, when it first
// appears; the units of one chunk are staggered so the chunk lands as a wave.
//
// Delays are remembered by position in `delays`, which the caller keeps across
// renders: a unit gets its delay the first time it is seen and keeps it, so a
// re-render while it is still animating never moves its start. Like the other
// plugins this only adds `span` elements around existing text, so it cannot
// introduce markup. Written against a minimal structural node type for the
// same reason as `plugins.ts`.

interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

/** Gap between neighbouring units of one chunk. */
export const INK_STAGGER_MS = 18;
/** A long chunk does not get a long tail: everything past this starts together. */
export const INK_STAGGER_MAX_MS = 180;

// Code is shown whole — a monospace token sharpening letter by letter reads
// as a glitch, not ink. Links are rendered as chips by AiMarkdown.
const SKIP = new Set(["code", "pre", "a"]);

// One CJK character or full-width mark; or a run of anything else up to and
// including the whitespace after it; or leading whitespace on its own.
const CJK = "\\u2E80-\\u9FFF\\uF900-\\uFAFF\\u3000-\\u303F\\uFF00-\\uFFEF";
const UNIT = new RegExp(`[${CJK}]|[^\\s${CJK}]+\\s*|\\s+`, "g");

export function inkUnits(text: string): string[] {
  return text.match(UNIT) ?? [];
}

export function rehypeInkReveal(options: { delays: number[] }) {
  const { delays } = options;
  return (tree: HNode) => {
    const seenBefore = delays.length;
    let index = 0;

    const delayFor = (at: number): number => {
      if (at >= delays.length) {
        delays.push(Math.min((at - seenBefore) * INK_STAGGER_MS, INK_STAGGER_MAX_MS));
      }
      return delays[at];
    };

    const walk = (node: HNode) => {
      if (!node.children) return;
      const next: HNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && child.value) {
          for (const unit of inkUnits(child.value)) {
            // Whitespace alone has nothing to ink; it stays a plain text node
            // so the spans around it keep their positions.
            if (!unit.trim()) {
              next.push({ type: "text", value: unit });
              continue;
            }
            const delay = delayFor(index++);
            next.push({
              type: "element",
              tagName: "span",
              properties: delay
                ? { className: ["ai-ink"], style: `animation-delay:${delay}ms` }
                : { className: ["ai-ink"] },
              children: [{ type: "text", value: unit }],
            });
          }
          continue;
        }
        if (child.type === "element" && child.tagName && SKIP.has(child.tagName)) {
          next.push(child);
          continue;
        }
        walk(child);
        next.push(child);
      }
      node.children = next;
    };

    walk(tree);
  };
}
