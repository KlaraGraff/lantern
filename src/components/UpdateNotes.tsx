import { useLayoutEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The changelog inside the update prompt.
 *
 * Collapsed to about six lines by default. Lantern's release notes routinely
 * run past two thousand characters, and a prompt that opens as a wall of text
 * over the page the reader was reading is a prompt they dismiss without
 * reading — so the toast shows the opening of the section and gets out of the
 * way. Expanded, it scrolls inside the card rather than growing the card,
 * which keeps the Update button in one place instead of moving it down the
 * screen as the notes get longer.
 *
 * The collapse control only appears when something is actually hidden;
 * `measure` compares rendered height against the clamp rather than guessing
 * from character count, because a short release genuinely fits.
 */

/** Roughly six lines at the 12.5px body size — the collapsed clamp. */
const COLLAPSED_MAX_PX = 164;
/** Expanded, the notes scroll inside this instead of growing the card. */
const EXPANDED_MAX_PX = 320;

/**
 * Release bodies link to commits and issues. A link is worth keeping, but the
 * webview must not navigate away from the app to follow one, so anchors become
 * buttons that hand the URL to the OS browser. Anything that is not plain
 * http(s) renders as text — the same rule the AI surfaces use.
 */
function NotesLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const external = href && /^https?:\/\//i.test(href);
  if (!external) return <span>{children}</span>;
  return (
    <button
      type="button"
      onClick={() => { openUrl(href).catch(() => {}); }}
      className="cursor-pointer text-accent-text underline decoration-accent-text/30 underline-offset-2 hover:decoration-accent-text"
    >
      {children}
    </button>
  );
}

// Release notes are written by us, not by a model, but they still render
// through react-markdown's sanitising pipeline: raw HTML is never parsed, so
// the `<a id="chinese">` anchors that survive into an unstripped body show up
// as nothing rather than as markup.
const COMPONENTS: Components = {
  h1: ({ children }) => <NotesHeading>{children}</NotesHeading>,
  h2: ({ children }) => <NotesHeading>{children}</NotesHeading>,
  h3: ({ children }) => <NotesHeading>{children}</NotesHeading>,
  h4: ({ children }) => <NotesHeading>{children}</NotesHeading>,
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-[17px] last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-[17px] last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-[5px] marker:text-text-muted last:mb-0">{children}</li>,
  code: ({ children }) => (
    <code className="rounded bg-bg-input px-1 py-px font-mono text-[11.5px]">{children}</code>
  ),
  a: NotesLink,
  hr: () => <hr className="my-3 border-border-light" />,
  img: () => null,
};

function NotesHeading({ children }: { children?: React.ReactNode }) {
  return (
    <h3 className="mt-3.5 mb-1.5 text-[12px] font-semibold tracking-[0.2px] text-text-muted first:mt-0">
      {children}
    </h3>
  );
}

interface UpdateNotesProps {
  notes: string;
  expanded: boolean;
  /** Called once the rendered height is known, so the caller can show or hide
   *  its expand control. Fired on every notes change, not only the first. */
  onOverflowChange: (overflowing: boolean) => void;
  label: string;
}

export default function UpdateNotes({
  notes,
  expanded,
  onOverflowChange,
  label,
}: UpdateNotesProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const reported = useRef<boolean | null>(null);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Measure against the collapsed clamp specifically: once expanded, the
    // element scrolls, so its own overflow no longer answers "was anything
    // hidden when collapsed".
    const next = element.scrollHeight > COLLAPSED_MAX_PX + 1;
    setOverflowing(next);
    // Report only on change. The effect re-runs whenever the parent passes a
    // fresh callback, and the parent sets state in response — reporting
    // unconditionally would be an endless render loop.
    if (reported.current !== next) {
      reported.current = next;
      onOverflowChange(next);
    }
  }, [notes, expanded, onOverflowChange]);

  return (
    <div className="relative border-t border-border-light">
      <div
        ref={scroller}
        aria-label={label}
        // Only the expanded panel is focusable: a scroll region the keyboard
        // can reach but cannot scroll (because it is clamped) is a trap.
        tabIndex={expanded ? 0 : undefined}
        className={`px-4 pt-3 pb-3.5 text-[12.5px] leading-[1.62] text-text-secondary ${
          expanded ? "overflow-y-auto" : "overflow-hidden"
        }`}
        style={{ maxHeight: expanded ? EXPANDED_MAX_PX : COLLAPSED_MAX_PX }}
      >
        <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
          {notes}
        </Markdown>
      </div>
      {!expanded && overflowing && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-11 bg-gradient-to-b from-transparent to-white dark:to-bg-surface"
        />
      )}
    </div>
  );
}
