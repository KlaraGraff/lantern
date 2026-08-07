// The [S1]-style citation marker, rendered as a clickable superscript chip.
// Shared between the answer body (via AiMarkdown's link mapping) and the
// sources row under a chat bubble. createElement rather than JSX so the node
// test runner can load the real component straight from source.
import { createElement as h } from "react";
import type { CitedSource } from "../../hooks/useAiChat.ts";

export default function CitationChip({
  source,
  onClick,
}: {
  source: CitedSource;
  onClick?: () => void;
}) {
  const number = source.marker.replace(/^S/, "");
  const tooltip = [source.sectionTitle, source.snippet].filter(Boolean).join("\n");
  return h(
    "button",
    {
      type: "button",
      title: tooltip,
      "aria-label": `Source ${number}`,
      onClick,
      className:
        "mx-0.5 inline-flex h-5 min-w-5 translate-y-[-1px] items-center justify-center rounded border border-accent/35 bg-accent-bg px-1 text-[10px] font-semibold leading-none text-accent-text align-super hover:opacity-75",
    },
    number,
  );
}
