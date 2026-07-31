import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Quote, Settings } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import Markdown, { defaultUrlTransform } from "react-markdown";
import type { AiChatRoute, ChatMessage, CitedSource, SectionContextMetadata } from "../hooks/useAiChat";
import { aiErrorMessageKey, isAiErrorCode, isAiSettingsError } from "../utils/aiError";
import {
  citedSourcesInContent,
  citationMarkerFromHref,
  markdownWithCitationLinks,
} from "./citation-markers";

// Answers fill the column they are given — a percentage cap only strands
// whitespace in the reader's side panel, which is already narrow. The ch cap
// keeps the line measure readable in the full-width chats page instead.
const ANSWER_WIDTH = "w-full max-w-[68ch]";

/** Marks a paragraph the model meant as a section heading. */
const ANSWER_LEAD_CLASS = "answer-lead";

/** True for `**Heading**` on a line of its own — one bold child, nothing else. */
function isLeadParagraph(node: unknown): boolean {
  const children = (node as { children?: { type?: string; tagName?: string }[] } | undefined)?.children;
  return children?.length === 1
    && children[0]?.type === "element"
    && children[0]?.tagName === "strong";
}

// Answer prose. A wall of same-weight, same-colour 14px text is what makes a
// long vocabulary breakdown tiring to read, so the body sits a shade lighter
// than the terms, lines breathe, and lists get their markers back (Tailwind's
// preflight strips them, which is why bullets rendered as flat lines).
const ANSWER_PROSE = [
  "max-w-none text-[14px] text-text-secondary leading-[1.7] tracking-[-0.15px]",
  "[&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[14px]",
  "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold",
  "[&_h1]:text-text-primary [&_h2]:text-text-primary [&_h3]:text-text-primary",
  "[&_h1]:mt-4 [&_h1]:mb-1.5 [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h3]:mt-3 [&_h3]:mb-1",
  "[&_p]:my-2",
  // Models write section headings as a lone bold line; space it like a heading.
  // The marker class is applied by the paragraph renderer rather than matched
  // with `:has()`, which the reader's Safari 15 baseline does not support. Two
  // class selectors beat the plain `[&_p]` rule above, so ordering is not load
  // bearing here.
  //
  // Spelled out rather than interpolated from ANSWER_LEAD_CLASS: Tailwind scans
  // source text literally, so a template hole yields no rule at all and the
  // spacing silently does nothing. Keep the two in step.
  "[&_p.answer-lead]:mt-4 [&_p.answer-lead]:mb-1",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-[1.2em] [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-[1.5em]",
  "[&_li]:my-1 [&_li]:pl-0.5 [&_li::marker]:text-text-muted",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-text-muted",
  "[&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[13px]",
  "[&_pre]:bg-bg-muted [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto",
  "[&_strong]:font-semibold [&_strong]:text-text-primary [&_em]:italic",
  "[&_hr]:border-border [&_hr]:my-3 [&_a]:text-accent [&_a]:underline",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
].join(" ");

interface MessageBubbleProps {
  msg: ChatMessage;
  messages: ChatMessage[];
  streaming: boolean;
  onNavigateToCfi?: (cfi: string) => void;
  onNavigateToSource?: (source: CitedSource) => void;
  onRetryWithWholeBook?: (assistantId: string) => void;
  onQuoteReply?: (text: string) => void;
}

function CitationChip({ source, onClick }: { source: CitedSource; onClick?: () => void }) {
  const number = source.marker.replace(/^S/, "");
  const tooltip = [source.sectionTitle, source.snippet].filter(Boolean).join("\n");
  return (
    <button
      type="button"
      title={tooltip}
      aria-label={`Source ${number}`}
      onClick={onClick}
      className="mx-0.5 inline-flex h-5 min-w-5 translate-y-[-1px] items-center justify-center rounded border border-accent/35 bg-accent-bg px-1 text-[10px] font-semibold leading-none text-accent-text align-super hover:opacity-75"
    >
      {number}
    </button>
  );
}

function isSectionRoute(route?: AiChatRoute): boolean {
  return route === "current_section"
    || route === "current_section_vocabulary"
    || route === "current_section_unavailable";
}

function isUnavailableRoute(route?: AiChatRoute): boolean {
  return route === "current_section_unavailable"
    || route === "whole_book_unavailable"
    || route === "whole_book_vocabulary_unavailable";
}

function isViewportRoute(route?: AiChatRoute): boolean {
  return route === "viewport_context" || route === "viewport_context_vocabulary";
}

function SectionContextNotice({
  route,
  context,
}: {
  route?: AiChatRoute;
  context?: SectionContextMetadata;
}) {
  const { t } = useTranslation();
  if (isViewportRoute(route)) {
    return (
      <span className="mt-2 inline-flex rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
        {t("ai.sectionContext.viewport")}
      </span>
    );
  }
  if (!isSectionRoute(route) && !isUnavailableRoute(route)) return null;
  if (!isUnavailableRoute(route) && !context) return null;
  const unavailableNotice = (
    <div
      role="status"
      className="mt-2 flex items-start gap-1.5 border-t border-border pt-2 text-[11px] text-text-muted"
    >
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span>{t(route === "whole_book_vocabulary_unavailable"
        ? "ai.sectionContext.wholeBookVocabularyUnavailable"
        : route === "whole_book_unavailable"
          ? "ai.sectionContext.wholeBookUnavailable"
          : "ai.sectionContext.unavailable")}</span>
    </div>
  );
  if (isUnavailableRoute(route)) {
    return unavailableNotice;
  }
  if (!context) return null;
  if (context.totalChunks === 0 || context.visibleChunks === 0) {
    return unavailableNotice;
  }

  if (!context.truncated && !context.spoilerLimited) {
    return (
      <span className="mt-2 inline-flex rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
        {t("ai.sectionContext.source")}
      </span>
    );
  }

  const details: string[] = [];
  if (context.spoilerLimited) {
    details.push(t("ai.sectionContext.spoilerLimited", {
      visible: context.visibleChunks,
      total: context.totalChunks,
    }));
  }
  if (context.truncated) {
    details.push(t("ai.sectionContext.truncated", {
      selected: context.selectedChunks,
      visible: context.visibleChunks,
    }));
  }
  return (
    <div
      role="status"
      title={t("ai.sectionContext.details", {
        selectedTokens: context.selectedTokens,
        visibleTokens: context.visibleTokens,
        totalTokens: context.totalTokens,
      })}
      className="mt-2 flex items-start gap-1.5 border-t border-border pt-2 text-[11px] text-text-muted"
    >
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span>{details.join(" ")}</span>
    </div>
  );
}

export default function MessageBubble({ msg, messages, streaming, onNavigateToCfi, onNavigateToSource, onRetryWithWholeBook, onQuoteReply }: MessageBubbleProps) {
  const { t } = useTranslation();
  const isLast = msg === messages[messages.length - 1];
  const [reasoningExpanded, setReasoningExpanded] = useState<boolean | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // One quote lives in the message's own columns; stacked quotes in metadata.
  const quotes = msg.contexts?.length
    ? msg.contexts
    : msg.context
      ? [{ text: msg.context, kind: msg.contextKind, cfi: msg.contextCfi }]
      : [];

  if (msg.role === "assistant") {
    const errorCode = isAiErrorCode(msg.content) ? msg.content : null;
    if (errorCode) {
      const needsSettings = isAiSettingsError(errorCode);
      return (
        <div className={`bg-bg-surface border border-border rounded-lg px-[13px] py-[13px] ${ANSWER_WIDTH}`}>
          <p className={`text-[14px] text-text-muted ${needsSettings ? "mb-2" : ""}`}>
            {t(aiErrorMessageKey(errorCode))}
          </p>
          {needsSettings && (
            <button
              onClick={async () => {
                await invoke("open_settings_on_main", { section: "services" });
                const main = await WebviewWindow.getByLabel("main");
                await main?.setFocus();
              }}
              className="flex items-center gap-1.5 text-[13px] font-medium text-accent-text hover:opacity-70 cursor-pointer"
            >
              <Settings size={14} />
              {t("ai.openSettings")}
            </button>
          )}
        </div>
      );
    }
    const hasReasoning = Boolean(msg.reasoning?.trim());
    const reasoningInProgress = streaming && isLast && !msg.content;
    const reasoningOpen = reasoningExpanded ?? reasoningInProgress;
    const sources = msg.sources ?? [];
    const citedSources = citedSourcesInContent(msg.content, sources);
    const settled = !(streaming && isLast) && Boolean(msg.content);

    // Quote what the reader highlighted inside this answer, or the whole answer
    // when nothing is highlighted. The range has to be tested against this
    // bubble: a selection left over in another message would otherwise be
    // quoted as if it came from this one.
    const handleQuote = () => {
      const selection = window.getSelection();
      const selected = selection?.toString().trim();
      const insideThisBubble = Boolean(
        selected
        && selection?.rangeCount
        && bubbleRef.current?.contains(selection.getRangeAt(0).commonAncestorContainer),
      );
      onQuoteReply?.(insideThisBubble ? (selected as string) : msg.content);
    };

    return (
      <div ref={bubbleRef} className={`group bg-bg-surface border border-border rounded-lg px-[13px] py-[13px] ${ANSWER_WIDTH}`}>
        {hasReasoning && (
          <div className={msg.content ? "mb-2 border-b border-border pb-2" : ""}>
            <button
              type="button"
              aria-expanded={reasoningOpen}
              onClick={() => setReasoningExpanded(!reasoningOpen)}
              className="flex w-full items-center gap-1.5 text-left text-[12px] font-medium text-text-muted hover:text-text-primary cursor-pointer"
            >
              {reasoningOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {reasoningInProgress && <Loader2 size={12} className="animate-spin" />}
              <span>{t(reasoningInProgress ? "ai.reasoningStreaming" : "ai.reasoning")}</span>
            </button>
            {reasoningOpen && (
              <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-[12px] leading-[18px] text-text-muted">
                {msg.reasoning}
              </div>
            )}
          </div>
        )}
        {streaming && !msg.content && isLast && !hasReasoning ? (
          <span className="flex items-center gap-1.5 text-[14px] text-text-muted">
            <Loader2 size={14} className="animate-spin" />
            {t("ai.thinking")}
          </span>
        ) : msg.content ? (
          <div className={ANSWER_PROSE}>
            <Markdown
              urlTransform={(url) => (
                url.startsWith("quill-citation:") ? url : defaultUrlTransform(url)
              )}
              components={{
                p: ({ node, children }) => (
                  <p className={isLeadParagraph(node) ? ANSWER_LEAD_CLASS : undefined}>{children}</p>
                ),
                a: ({ href, children }) => {
                  const marker = citationMarkerFromHref(href);
                  const source = marker ? sources.find((candidate) => candidate.marker === marker) : undefined;
                  return source
                    ? <CitationChip source={source} onClick={() => onNavigateToSource?.(source)} />
                    : <a href={href}>{children}</a>;
                },
              }}
            >
              {markdownWithCitationLinks(msg.content, sources)}
            </Markdown>
            {streaming && msg.content && isLast && (
              <Loader2 size={14} className="inline-block ml-1 animate-spin text-text-muted" />
            )}
          </div>
        ) : null}
        {/* Wraps: a vocabulary answer can cite thirty-odd sources, and one
            unwrapped row of chips overflows the bubble and gives the whole
            message list a horizontal scrollbar. */}
        {citedSources.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border pt-2">
            <span className="mr-1 text-[11px] text-text-muted">{t("ai.sources")}</span>
            {citedSources.map((source) => (
              <CitationChip key={source.marker} source={source} onClick={() => onNavigateToSource?.(source)} />
            ))}
          </div>
        )}
        {!(streaming && isLast) && (
          <SectionContextNotice route={msg.route} context={msg.sectionContext} />
        )}
        {/* A conversation that quietly loses its opening reads as the
            assistant forgetting; if the budget had to drop turns, say so. */}
        {(msg.contextBudget?.historyOmitted ?? 0) > 0 && !(streaming && isLast) && (
          <div className="mt-2 border-t border-border pt-2 text-[11px] text-text-muted">
            {t("ai.contextBudget.historyOmitted", { messages: msg.contextBudget?.historyOmitted })}
          </div>
        )}
        {msg.spoilerGuard?.active && !(streaming && isLast) && (
          msg.spoilerGuard.wholeBookIntent ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-text-muted">
              <span>{t("ai.spoilerGuard.notice", { progress: msg.spoilerGuard.progress })}</span>
              {onRetryWithWholeBook && msg.dbId && isLast && (
                <button
                  type="button"
                  onClick={() => onRetryWithWholeBook(msg.id)}
                  className="font-medium text-accent-text hover:opacity-75"
                >
                  {t("ai.spoilerGuard.retryWholeBook")}
                </button>
              )}
            </div>
          ) : (
            <span
              title={t("ai.spoilerGuard.badgeHint")}
              className="mt-2 inline-flex rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted"
            >
              {t("ai.spoilerGuard.badge")}
            </span>
          )
        )}
        {settled && onQuoteReply && (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={handleQuote}
              title={t("ai.quoteReply.hint")}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-text-muted opacity-0 transition-opacity hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100 cursor-pointer"
            >
              <Quote size={11} />
              {t("ai.quoteReply.action")}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] flex flex-col gap-1.5">
        {quotes.map((quote) => (
          <button
            key={`${quote.kind ?? "passage"}:${quote.text}`}
            onClick={() => quote.cfi && onNavigateToCfi?.(quote.cfi)}
            className={`border-l-2 border-[#c084fc] pl-3 pt-0.5 text-left ${
              quote.cfi && onNavigateToCfi ? "cursor-pointer hover:opacity-70" : "cursor-default"
            }`}
          >
            {/* Without the label a quoted answer reads as book text, which is
                exactly the confusion the separate context kind exists to avoid. */}
            {quote.kind === "reply" && (
              <p className="text-[11px] font-medium text-text-muted">
                {t("aiPanel.quoteChip.replyLabel")}
              </p>
            )}
            <p className="text-[12px] italic text-text-muted line-clamp-2">
              {quote.text}
            </p>
          </button>
        ))}
        <div className="bg-[rgba(192,132,252,0.15)] rounded-lg px-[13px] py-[13px]">
          <p className="text-[14px] text-text-primary leading-5 tracking-[-0.15px]">
            {msg.content}
          </p>
        </div>
      </div>
    </div>
  );
}
