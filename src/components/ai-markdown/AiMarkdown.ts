// The one renderer every AI-output surface goes through: chat answers, the
// lookup popover, saved explanations, vocab details, and learning-card text
// fields. The model marks semantics (this is the book's words, this is a
// warning, this is the key form); what each of those looks like is decided
// here, once.
//
// Model output is untrusted data. Everything renders through react-markdown's
// sanitising pipeline — raw HTML is never parsed, URL schemes go through the
// same transform the chat pipeline already used — and the remark plugins only
// rearrange mdast nodes, so no marker can smuggle markup in.
import { createElement as h, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info } from "lucide-react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CitedSource } from "../../hooks/useAiChat.ts";
import {
  citationMarkerFromHref,
  citationUrlTransform,
  markdownWithCitationLinks,
} from "../citation-markers.ts";
import CitationChip from "./CitationChip.ts";
import {
  remarkLanternAlerts,
  remarkLanternMarks,
  type AlertTag,
  type LanternMarksOptions,
} from "./plugins.ts";
import { AI_PROSE_CHAT, AI_PROSE_COMPACT, ANSWER_LEAD_CLASS } from "./prose.ts";
import { settleStreamingTail } from "./streaming-tail.ts";

export type AiProseSize = "chat" | "compact";

/**
 * The easy-to-miss / uncertain callout. Exported for surfaces that carry the
 * tag inline (a learning-card `details` entry) rather than on a blockquote.
 */
export function AlertStrip({ tag, children }: { tag: AlertTag; children?: ReactNode }) {
  const { t } = useTranslation();
  const warning = tag === "warning" || tag === "caution";
  const accent = warning ? "text-warning" : "text-accent-text";
  return h(
    "div",
    {
      role: "note",
      className: `my-2 flex gap-2 rounded-md border px-2.5 py-2 ${
        warning ? "border-warning/35 bg-warning/10" : "border-accent/30 bg-accent-bg/60"
      }`,
    },
    h(warning ? AlertTriangle : Info, { size: 13, className: `mt-[3px] shrink-0 ${accent}` }),
    h(
      "div",
      { className: "ai-alert-body flex min-w-0 flex-1 flex-col gap-0.5" },
      h(
        "p",
        { className: `text-[10px] font-semibold uppercase tracking-[0.5px] ${accent}` },
        t(`ai.markdown.alert.${tag}`),
      ),
      children,
    ),
  );
}

/** True for `**Heading**` on a line of its own — one bold child, nothing else. */
function isLeadParagraph(node: ExtraProps["node"]): boolean {
  const children = node?.children;
  return children?.length === 1
    && children[0]?.type === "element"
    && children[0]?.tagName === "strong";
}

// The subset of elements a single card field may produce. Everything else is
// unwrapped to its text: a model that answers a one-line field with a list or
// a table degrades to plain prose instead of exploding the card, and links
// lose their anchor (a card is not a navigation surface).
const INLINE_ELEMENTS = ["p", "strong", "em", "code", "mark", "del", "br"];

export interface AiMarkdownProps {
  children: string;
  size: AiProseSize;
  /** Restrict to inline semantics — for short structured fields. */
  inline?: boolean;
  /** Settle half-arrived markers while the answer is still streaming. */
  streaming?: boolean;
  /** Deterministically highlight this term (the card's looked-up word). */
  highlightTerm?: string;
  /** When present, [S1] markers render as citation chips. */
  sources?: CitedSource[];
  onNavigateToSource?: (source: CitedSource) => void;
  /** Extra wrapper classes — the call site's text size and colour. */
  className?: string;
}

export default function AiMarkdown({
  children,
  size,
  inline = false,
  streaming = false,
  highlightTerm,
  sources,
  onNavigateToSource,
  className,
}: AiMarkdownProps) {
  let text = children;
  if (streaming) text = settleStreamingTail(text);
  if (sources?.length) text = markdownWithCitationLinks(text, sources);

  const marksOptions: LanternMarksOptions = { highlightTerm };
  const components: Components = {
    blockquote: ({ node, children: kids }) => {
      const tag = node?.properties?.dataAlert as AlertTag | undefined;
      return tag ? h(AlertStrip, { tag }, kids) : h("blockquote", null, kids);
    },
    // The answer column is width-capped and table cells will not shrink below
    // their content, so a wide table has to scroll on its own rather than
    // widen the whole surface.
    table: ({ children: kids }) => h(
      "div",
      { className: size === "chat" ? "my-3 overflow-x-auto" : "my-2 overflow-x-auto" },
      h("table", null, kids),
    ),
    a: ({ href, children: kids }) => {
      const marker = citationMarkerFromHref(href);
      const source = marker
        ? sources?.find((candidate) => candidate.marker === marker)
        : undefined;
      return source
        ? h(CitationChip, {
            source,
            onClick: onNavigateToSource ? () => onNavigateToSource(source) : undefined,
          })
        : h("a", { href }, kids);
    },
  };
  if (size === "chat") {
    // Models write section headings as a lone bold line; space it like one.
    components.p = ({ node, children: kids }) =>
      h("p", { className: isLeadParagraph(node) ? ANSWER_LEAD_CLASS : undefined }, kids);
  }

  return h(
    "div",
    {
      className: `${size === "chat" ? AI_PROSE_CHAT : AI_PROSE_COMPACT}${
        className ? ` ${className}` : ""
      }`,
    },
    h(Markdown, {
      remarkPlugins: [remarkGfm, remarkLanternAlerts, [remarkLanternMarks, marksOptions]],
      urlTransform: citationUrlTransform,
      components,
      ...(inline ? { allowedElements: INLINE_ELEMENTS, unwrapDisallowed: true } : {}),
      children: text,
    }),
  );
}
