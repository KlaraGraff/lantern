// Remark-level extensions for Lantern's AI output, shared by every surface
// that renders model text (chat answers, lookup popover, explanations, vocab
// details, learning-card fields).
//
// Both plugins only rewrite the mdast tree — the HTML is still produced by
// react-markdown's normal (sanitising) pipeline, so neither can introduce raw
// HTML or new URL schemes. Written against a minimal structural node type
// rather than @types/mdast so the node test runner can load this file without
// the full unified type graph.

/** The alert vocabulary GitHub uses, which models already know how to write. */
export const ALERT_TAGS = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertTag = (typeof ALERT_TAGS)[number];

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

const LEADING_ALERT = /^\[!(note|tip|important|warning|caution)\][ \t]*\r?\n?/i;

/**
 * `[!WARNING] rest` → its tag and the rest, for card fields that carry the tag
 * inline (a `details` entry has no blockquote to hang it on).
 */
export function leadingAlertTag(text: string): { tag: AlertTag; rest: string } | null {
  const match = LEADING_ALERT.exec(text);
  if (!match) return null;
  return { tag: match[1].toLowerCase() as AlertTag, rest: text.slice(match[0].length) };
}

function walk(node: MdNode, visit: (node: MdNode) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * GitHub-style blockquote alerts (`> [!WARNING] …`). remark-gfm@4 does not
 * parse them — they are a GitHub renderer feature, not part of the GFM spec —
 * so this marks the blockquote itself: the tag line is stripped and the tag
 * lands in `data-alert`, which the component layer maps to a styled strip. A
 * blockquote that carries no tag, or a tag outside the vocabulary, is left
 * alone and renders as a plain quote — the degradation path is the ordinary
 * one.
 */
export function remarkLanternAlerts() {
  return (tree: unknown) => {
    walk(tree as MdNode, (node) => {
      if (node.type !== "blockquote") return;
      const paragraph = node.children?.[0];
      if (!paragraph || paragraph.type !== "paragraph") return;
      const first = paragraph.children?.[0];
      if (!first || first.type !== "text" || typeof first.value !== "string") return;
      const match = LEADING_ALERT.exec(first.value);
      if (!match) return;
      first.value = first.value.slice(match[0].length);
      if (!first.value) {
        paragraph.children?.shift();
        // GitHub puts the body on the next line; drop the break that led it.
        if (paragraph.children?.[0]?.type === "break") paragraph.children.shift();
      }
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, dataAlert: match[1].toLowerCase() },
      };
    });
  };
}

type Piece = { marker: true } | { marker: false; node: MdNode };

/** Split a text node on `==` markers; `===`-runs stay literal text. */
function splitOnMarkers(value: string): Piece[] {
  const pieces: Piece[] = [];
  let start = 0;
  let index = 0;
  while (index < value.length - 1) {
    if (
      value[index] === "="
      && value[index + 1] === "="
      && value[index - 1] !== "="
      && value[index + 2] !== "="
    ) {
      if (index > start) {
        pieces.push({ marker: false, node: { type: "text", value: value.slice(start, index) } });
      }
      pieces.push({ marker: true });
      index += 2;
      start = index;
    } else {
      index += 1;
    }
  }
  if (start < value.length) {
    pieces.push({ marker: false, node: { type: "text", value: value.slice(start) } });
  }
  return pieces;
}

const literalMarker = (): MdNode => ({ type: "text", value: "==" });

const markNode = (children: MdNode[]): MdNode => ({
  type: "lanternMark",
  data: { hName: "mark" },
  children,
});

/** Non-space adjacency, so ` == ` as an operator in prose never opens a mark. */
function startsWithNonSpace(node: MdNode): boolean {
  return node.type === "text" ? /^\S/.test(node.value ?? "") : true;
}

function endsWithNonSpace(node: MdNode): boolean {
  return node.type === "text" ? /\S$/.test(node.value ?? "") : true;
}

/**
 * Wraps `==highlighted==` spans in `<mark>`. Works across sibling inline nodes
 * (`==**key** point==`), skips inline code (a code span is its own node, never
 * a text child), and reverts to literal text when a pair never closes — the
 * streaming tail guard is what keeps that case off the screen mid-stream.
 */
function applyMarksToChildren(children: MdNode[]): MdNode[] | null {
  if (!children.some((child) => child.type === "text" && child.value?.includes("=="))) return null;
  const pieces = children.flatMap((child): Piece[] =>
    child.type === "text" && typeof child.value === "string"
      ? splitOnMarkers(child.value)
      : [{ marker: false, node: child }],
  );
  const result: MdNode[] = [];
  let open: MdNode[] | null = null;
  let marked = false;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (!piece.marker) {
      (open ?? result).push(piece.node);
      continue;
    }
    if (open === null) {
      const next = pieces[index + 1];
      if (next && !next.marker && startsWithNonSpace(next.node)) open = [];
      else result.push(literalMarker());
    } else if (open.length > 0 && endsWithNonSpace(open[open.length - 1])) {
      result.push(markNode(open));
      marked = true;
      open = null;
    } else {
      open.push(literalMarker());
    }
  }
  if (open !== null) result.push(literalMarker(), ...open);
  return marked ? result : null;
}

function isLatinWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/**
 * Deterministic term highlight: wraps occurrences of `term` in text nodes with
 * `<mark>`, no model cooperation required. Latin terms match on word
 * boundaries so "read" never lights up inside "already"; CJK terms match as
 * substrings, which is the correct boundary rule there.
 */
function highlightTermInChildren(children: MdNode[], term: string): void {
  const needle = term.toLowerCase();
  const boundarySensitive = isLatinWordChar(term[0]) && /[a-z0-9]/i.test(term);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type !== "text" || typeof child.value !== "string") continue;
    const value = child.value;
    const haystack = value.toLowerCase();
    const replacement: MdNode[] = [];
    let cursor = 0;
    let at = haystack.indexOf(needle);
    while (at >= 0) {
      const before = value[at - 1];
      const after = value[at + term.length];
      const bounded = !boundarySensitive
        || (!isLatinWordChar(before) && !isLatinWordChar(after));
      if (bounded) {
        if (at > cursor) replacement.push({ type: "text", value: value.slice(cursor, at) });
        replacement.push(markNode([{ type: "text", value: value.slice(at, at + term.length) }]));
        cursor = at + term.length;
      }
      at = haystack.indexOf(needle, at + Math.max(term.length, 1));
    }
    if (cursor === 0) continue;
    if (cursor < value.length) replacement.push({ type: "text", value: value.slice(cursor) });
    children.splice(index, 1, ...replacement);
    index += replacement.length - 1;
  }
}

/** Parents whose children are inline content and may carry `==` pairs. */
const INLINE_PARENTS = new Set([
  "paragraph",
  "heading",
  "emphasis",
  "strong",
  "delete",
  "link",
  "tableCell",
]);

export interface LanternMarksOptions {
  /** When set, every occurrence of this term is highlighted deterministically. */
  highlightTerm?: string;
}

export function remarkLanternMarks(options: LanternMarksOptions = {}) {
  const term = options.highlightTerm?.trim();
  return (tree: unknown) => {
    walk(tree as MdNode, (node) => {
      if (!node.children || !INLINE_PARENTS.has(node.type)) return;
      const rewritten = applyMarksToChildren(node.children);
      if (rewritten) node.children = rewritten;
      if (term) {
        // Only into plain children — text inside an existing mark stays put.
        highlightTermInChildren(node.children, term);
      }
    });
  };
}
