// The typography layer for AI output. One semantic vocabulary — term/code
// chips, excerpt quotes, highlights, alert strips — in two sizes: `chat` for
// the wide long-form answer column, `compact` for the narrow lookup popover,
// vocab details, and learning-card fields. Surfaces compose one of the two
// exported strings; none of them carries its own copy of these rules anymore.
//
// Class lists are spelled out literally (no interpolation) because Tailwind
// scans source text: a template hole yields no rule at all and the style
// silently does nothing.

/** Marks a paragraph the model meant as a section heading (chat only). */
export const ANSWER_LEAD_CLASS = "answer-lead";

// Semantics shared by both sizes.
const BASE = [
  "max-w-none",
  "[&_strong]:font-semibold [&_strong]:text-text-primary [&_em]:italic",
  // Inline code doubles as the words-as-words chip. The styling stays neutral
  // on purpose — monospace, muted fill — so it reads correctly both as `code`
  // in a programming book and as `take up` in a collocation note; a purple
  // "term pill" would look broken the moment the content is real code.
  "[&_code]:bg-bg-muted [&_code]:border [&_code]:border-border-light [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5",
  "[&_pre]:bg-bg-muted [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:my-2",
  "[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  // ==Highlight== and the deterministic headword highlight land here.
  // box-decoration-clone keeps the tint wrapping cleanly across line breaks.
  "[&_mark]:bg-accent-bg [&_mark]:text-text-primary [&_mark]:rounded-sm [&_mark]:px-[3px] [&_mark]:py-[1px] [&_mark]:box-decoration-clone",
  // The excerpt card: a `>` quote is the book's own words, so it sits on its
  // own surface in the serif reading face. Deliberately not italic — fake
  // italics mangle CJK text, and the face change already sets it apart.
  "[&_blockquote]:my-2 [&_blockquote]:rounded-md [&_blockquote]:border-l-2 [&_blockquote]:border-lavender",
  "[&_blockquote]:bg-bg-muted [&_blockquote]:px-3 [&_blockquote]:py-2 [&_blockquote]:font-serif [&_blockquote]:not-italic",
  "[&_blockquote_p]:my-0 [&_blockquote_p+p]:mt-1.5",
  // Alert strips carry their own container styling in the component; these
  // rules only keep the paragraphs inside them from inheriting block margins.
  "[&_.ai-alert-body_p]:my-0 [&_.ai-alert-body_p+p]:mt-1",
  "[&_a]:text-accent [&_a]:underline",
  "[&_hr]:border-border [&_hr]:my-3",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
].join(" ");

// Answer prose. A wall of same-weight, same-colour 14px text is what makes a
// long vocabulary breakdown tiring to read, so the body sits a shade lighter
// than the terms, lines breathe, and lists get their markers back (Tailwind's
// preflight strips them).
export const AI_PROSE_CHAT = [
  BASE,
  "text-[14px] text-text-secondary leading-[1.7] tracking-[-0.15px]",
  "[&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[14px]",
  "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold",
  "[&_h1]:text-text-primary [&_h2]:text-text-primary [&_h3]:text-text-primary",
  "[&_h1]:mt-4 [&_h1]:mb-1.5 [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h3]:mt-3 [&_h3]:mb-1",
  "[&_p]:my-2",
  // Models write section headings as a lone bold line; space it like a
  // heading. Matched on a class applied by the paragraph renderer rather than
  // with `:has()`, which the Safari 15 baseline does not support. Spelled out
  // rather than interpolated from ANSWER_LEAD_CLASS — keep the two in step.
  "[&_p.answer-lead]:mt-4 [&_p.answer-lead]:mb-1",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-[1.2em] [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-[1.5em]",
  "[&_li]:my-1 [&_li]:pl-0.5 [&_li::marker]:text-text-muted",
  "[&_code]:text-[13px]",
  // GFM tables. Preflight strips every default table border, so without these
  // a comparison table renders as cells jammed together. The header sits on
  // the muted fill rather than a heavier rule so a three-column table does not
  // outweigh the prose above it. Vertical margin lives on the scroll wrapper,
  // not here, so the first/last-child reset can still reach it.
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px]",
  "[&_th]:border [&_th]:border-border [&_th]:bg-bg-muted [&_th]:px-2.5 [&_th]:py-1.5",
  "[&_th]:text-left [&_th]:font-semibold [&_th]:text-text-primary",
  "[&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top",
  // Task lists: the checkbox replaces the marker, so the bullet would double
  // up. Matched on the `task-list-item` class mdast-util-to-hast puts there,
  // not with `:has()`, which the Safari 15 baseline does not support.
  "[&_li.task-list-item]:list-none [&_li.task-list-item]:pl-0",
  "[&_li_input[type=checkbox]]:mr-1.5 [&_li_input[type=checkbox]]:align-[-1px]",
].join(" ");

// Lookup prose. Tight spacing tuned for the 12–13px body so bullets and
// adjacent paragraphs don't blow out a card or popover. Text size and colour
// stay with the call site, as before.
export const AI_PROSE_COMPACT = [
  BASE,
  "leading-[1.55]",
  "[&_p]:my-0 [&_p+p]:mt-1.5",
  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-[1.2em] [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-[1.4em]",
  "[&_li]:my-0.5 [&_li::marker]:text-text-muted",
  "[&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[12px]",
  "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold",
  "[&_h1]:text-text-primary [&_h2]:text-text-primary [&_h3]:text-text-primary",
  "[&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:mt-2 [&_h3]:mb-0.5",
  "[&_code]:text-[12px]",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px]",
  "[&_th]:border [&_th]:border-border [&_th]:bg-bg-muted [&_th]:px-2 [&_th]:py-1",
  "[&_th]:text-left [&_th]:font-semibold [&_th]:text-text-primary",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
].join(" ");
