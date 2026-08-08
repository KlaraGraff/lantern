// The [Q1]-style example-sentence marker, rendered as a clickable chip.
// Shared between the answer body (via AiMarkdown's link mapping) and the
// examples row under a chat bubble. createElement rather than JSX so the node
// test runner can load the real component straight from source.
import { createElement as h } from "react";
import type { QuotedSource } from "../../hooks/useAiChat.ts";

/**
 * Wider than a `CitationChip` and carrying a book title rather than a number,
 * because it promises something different. A citation points into the book on
 * screen, where a bare number is enough — the reader knows which book they are
 * in. An example sentence comes from a different book and clicking it leaves
 * the one they are reading, so the chip has to say which book before they
 * decide to go.
 */
export default function QuoteChip({
  quote,
  label,
  onClick,
}: {
  quote: QuotedSource;
  /** Accessible name, already localized — e.g. 「例句：Another Book」. */
  label: string;
  onClick?: () => void;
}) {
  return h(
    "button",
    {
      type: "button",
      title: quote.text,
      "aria-label": label,
      onClick,
      className:
        "mx-0.5 inline-flex h-5 max-w-[12rem] translate-y-[-1px] items-center justify-center gap-1"
        + " truncate rounded border border-accent/35 bg-accent-bg px-[7px] align-super"
        + " text-[10px] font-medium leading-none tracking-[0.01em] text-accent-text hover:opacity-75",
    },
    quote.bookTitle,
  );
}
