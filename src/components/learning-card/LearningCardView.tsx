import { useEffect, useId, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AlertCircle, ChevronDown, ChevronRight, GripHorizontal, History, Loader2, RotateCw, Settings, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { platform } from "../../services/platform";
import { isAiRetryableError, isAiSettingsError, type AiErrorCode } from "../../utils/aiError";
import {
  getLearningCardTargetWidth,
  getResponsiveLearningCardWidth,
} from "./config";
import LearningCardActions from "./LearningCardActions";
import LearningCardModules from "./LearningCardModules";
import LearningCardNotes from "./LearningCardNotes";
import PronounceButton from "../speech/PronounceButton";
import type {
  CardDesignConfigV1,
  LearningCardActionId,
  LearningCardActionState,
  LearningCardNote,
  LearningCardResult,
  WordMemoryHint,
} from "./types";

interface LearningCardViewProps {
  result: LearningCardResult;
  config: CardDesignConfigV1;
  availableWidth?: number;
  maxHeight?: string | number;
  loading?: boolean;
  /** The model is reasoning and has not started its answer yet. */
  thinking?: boolean;
  /** What the model has thought so far, streamed as it arrives. */
  reasoning?: string;
  error?: string | null;
  /**
   * The `error` arrived after modules had already streamed in. Those modules
   * are shown as usual and the failure becomes a strip under them — an answer
   * that broke in its last section is not a reason to blank the eight sections
   * before it.
   */
  partial?: boolean;
  /** Present when `error` came from the AI route, so the card can route out of it. */
  aiErrorCode?: AiErrorCode | null;
  presentationMode?: boolean;
  /**
   * Drawn inside `BottomSheet` on coarse pointer: the sheet already
   * supplies the rounded top corners, the border-less scrim and the shadow,
   * so the card fills it edge to edge instead of floating inside as a second
   * bordered box.
   */
  sheetPresentation?: boolean;
  notes?: LearningCardNote[];
  noteEditorOpen?: boolean;
  noteDraft?: string;
  noteSaving?: boolean;
  actionStates?: Partial<Record<LearningCardActionId, LearningCardActionState>>;
  onAction?: (action: LearningCardActionId) => void;
  onClose?: () => void;
  onDragPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragPointerEnd?: (event: ReactPointerEvent<HTMLElement>) => void;
  onRetry?: () => void;
  onRefresh?: () => void;
  onLookupWord?: (event: ReactMouseEvent<HTMLElement>) => void;
  onSelectText?: (event: ReactMouseEvent<HTMLElement>) => void;
  onNoteDraftChange?: (value: string) => void;
  onNoteSave?: () => void;
  onNoteCancel?: () => void;
  onNoteEdit?: (note: LearningCardNote) => void;
  onNoteDelete?: (note: LearningCardNote) => void;
  onViewAllNotes?: () => void;
  noteScope?: "book" | "global";
  highlightedModuleId?: string | null;
  animateModuleChanges?: boolean;
  onNoteScopeChange?: (scope: "book" | "global") => void;
  /** The reader's own record for this word, when it shaped the answer below. */
  memoryHint?: WordMemoryHint | null;
}

/**
 * One line, or nothing. Only states the card can actually back up: the prompt
 * carries the record's mastery and its earlier definition, so those are what
 * the reader is told about — never a bare visit count with nothing behind it.
 */
function memoryHintKey(hint: WordMemoryHint | null | undefined) {
  if (!hint) return null;
  if (hint.mastery === "mastered") {
    return hint.mastery_book_title
      ? { key: "learningCard.memory.masteredIn", values: { book: hint.mastery_book_title } }
      : { key: "learningCard.memory.mastered", values: {} };
  }
  if (hint.looked_up_times >= 2) {
    return { key: "learningCard.memory.repeat", values: { count: hint.looked_up_times } };
  }
  return null;
}

export default function LearningCardView({
  result,
  config,
  availableWidth,
  maxHeight = "75dvh",
  loading = false,
  thinking = false,
  reasoning = "",
  error = null,
  partial = false,
  aiErrorCode = null,
  presentationMode = false,
  sheetPresentation = false,
  notes,
  noteEditorOpen,
  noteDraft,
  noteSaving,
  actionStates,
  onAction,
  onClose,
  onDragPointerDown,
  onDragPointerMove,
  onDragPointerEnd,
  onRetry,
  onRefresh,
  onLookupWord,
  onSelectText,
  onNoteDraftChange,
  onNoteSave,
  onNoteCancel,
  onNoteEdit,
  onNoteDelete,
  onViewAllNotes,
  noteScope,
  highlightedModuleId,
  animateModuleChanges = false,
  onNoteScopeChange,
  memoryHint = null,
}: LearningCardViewProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const reasoningRef = useRef<HTMLDivElement>(null);
  // Open while the thinking is the only thing happening, closed once the answer
  // takes over — until the reader says otherwise, and then it is their call.
  const [reasoningExpanded, setReasoningExpanded] = useState<boolean | null>(null);
  const reasoningOpen = reasoningExpanded ?? thinking;

  // Thinking is worth watching only at the end where it is still being written.
  useEffect(() => {
    if (!thinking || !reasoningOpen) return;
    const element = reasoningRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [reasoning, reasoningOpen, thinking]);

  const card = config.cards[result.kind];
  const width = availableWidth === undefined
    ? getLearningCardTargetWidth(result.kind, card)
    : getResponsiveLearningCardWidth(result.kind, card, availableWidth);
  const title = result.kind === "word"
    ? result.sourceText
    : t(`learningCard.title.${result.kind}`);
  const memoryLine = memoryHintKey(memoryHint);

  return (
    <div
      role={presentationMode ? "region" : "dialog"}
      aria-modal={presentationMode ? undefined : true}
      aria-labelledby={titleId}
      className={`flex min-h-0 max-w-full flex-col overflow-hidden bg-bg-surface ${
        sheetPresentation ? "w-full" : "rounded-md border border-border/80 shadow-context"
      }`}
      style={sheetPresentation ? { maxHeight } : { width: `${width}px`, maxHeight }}
    >
      <header
        onPointerDown={(event) => {
          if ((event.target as Element).closest("button,input,textarea,select,a")) return;
          onDragPointerDown?.(event);
        }}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerEnd}
        onPointerCancel={onDragPointerEnd}
        className={`flex min-h-11 shrink-0 items-center gap-2 border-b border-border/60 bg-accent-bg px-4 py-2.5 ${
          onDragPointerDown ? "touch-none cursor-grab select-none active:cursor-grabbing" : ""
        }`}
      >
        <Sparkles size={15} className="shrink-0 text-accent-text" aria-hidden="true" />
        <h2 id={titleId} className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-5 text-accent-text">
          {title}
        </h2>
        <PronounceButton text={result.sourceText} kind={result.kind} />
        {loading && <Loader2 size={14} className="shrink-0 animate-spin text-accent-text" aria-hidden="true" />}
        {onRefresh && !loading && !error && (
          <button
            type="button"
            onClick={onRefresh}
            title={t("learningCard.cachedRefresh")}
            aria-label={t("learningCard.cachedRefresh")}
            className="flex size-7 touch:size-11 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-surface/70"
          >
            <RotateCw size={13} />
          </button>
        )}
        {onDragPointerDown && (
          <GripHorizontal size={15} className="shrink-0 text-text-muted" aria-hidden="true" />
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
            className="flex size-7 touch:size-11 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-surface/70"
          >
            <X size={14} />
          </button>
        )}
      </header>

      {memoryLine && !error && (
        <p className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-bg-muted px-4 py-1.5 text-[11px] leading-4 text-text-muted">
          <History size={11} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{t(memoryLine.key, memoryLine.values)}</span>
        </p>
      )}

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-card-scroll
        onDoubleClick={onLookupWord}
        onMouseUp={onSelectText}
      >
        {error && !partial ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-5 py-6 text-center" role="alert">
            <AlertCircle size={18} className="text-danger-text" />
            <p className="max-w-full break-words text-[12px] text-text-secondary">{error}</p>
            {isAiSettingsError(aiErrorCode) && (
              <button
                type="button"
                onClick={async () => {
                  await invoke("open_settings_on_main", { section: "services" });
                  // `open_settings_on_main` already targets the window labelled
                  // "main" and shows/focuses it from the Rust side. Where the OS
                  // hands out one window per book (D-005 `hasWindow`), that is a
                  // separate window from this reader and needs bringing forward
                  // from here too. Where it does not, this card's own window IS
                  // "main" — there is nowhere else for focus to go, the same
                  // reasoning `notifyReaders.ts` uses for its second half.
                  if (!platform.hasWindow) return;
                  const main = await WebviewWindow.getByLabel("main");
                  await main?.setFocus();
                }}
                className="mt-1 flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 text-[12px] font-medium text-accent-text hover:bg-bg-input"
              >
                <Settings size={13} />
                {t("ai.openSettings")}
              </button>
            )}
            {onRetry && (aiErrorCode === null || isAiRetryableError(aiErrorCode)) && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] font-medium text-text-primary hover:bg-bg-input"
              >
                <RotateCw size={13} />
                {t("common.retry")}
              </button>
            )}
          </div>
        ) : (
          <>
            {reasoning && (
              <div className="border-b border-border/60 px-4 py-2">
                <button
                  type="button"
                  aria-expanded={reasoningOpen}
                  onClick={() => setReasoningExpanded(!reasoningOpen)}
                  className="flex w-full cursor-pointer items-center gap-1.5 text-left text-[11px] font-medium text-text-muted hover:text-text-primary"
                >
                  {reasoningOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {thinking && <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden="true" />}
                  <span>{t(thinking ? "ai.reasoningStreaming" : "ai.reasoning")}</span>
                </button>
                {reasoningOpen && (
                  <div
                    ref={reasoningRef}
                    className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap text-[11px] leading-[17px] text-text-muted"
                  >
                    {reasoning}
                  </div>
                )}
              </div>
            )}
            <LearningCardModules
              card={card}
              kind={result.kind}
              content={result.modules}
              loading={loading}
              highlightedModuleId={highlightedModuleId}
              animateChanges={animateModuleChanges}
            />
            {/*
              The answer came apart partway. Everything above finished streaming
              and is as good as any other card, so the failure is reported where
              it happened — at the bottom, under the last module that made it —
              rather than replacing the card with an error page. Nothing on this
              path is written to the lookup cache.

              Keyed on `partial`, not on `error`: the answer can come apart two
              ways. The stream can die, which leaves an error and the modules
              that arrived; or it can finish with brackets the backend has to
              close by hand, which leaves no error at all and a card missing
              whatever came after the cut. Both are the same thing to read.
            */}
            {partial && (
              <div
                role="alert"
                className="flex items-center gap-2 border-t border-border/60 bg-bg-muted px-4 py-2.5"
              >
                <AlertCircle size={13} className="shrink-0 text-danger-text" aria-hidden="true" />
                <p className="min-w-0 flex-1 break-words text-[11px] leading-4 text-text-muted">
                  {t("learningCard.partialAnswer")}
                </p>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 text-[11px] font-medium text-text-primary hover:bg-bg-input"
                  >
                    <RotateCw size={12} />
                    {t("common.retry")}
                  </button>
                )}
              </div>
            )}
            <LearningCardNotes
              notes={notes}
              editorOpen={noteEditorOpen}
              draft={noteDraft}
              saving={noteSaving}
              onDraftChange={onNoteDraftChange}
              onSave={onNoteSave}
              onCancel={onNoteCancel}
              onEdit={onNoteEdit}
              onDelete={onNoteDelete}
              onViewAll={onViewAllNotes}
              showScope={result.kind === "word" && noteEditorOpen}
              scope={noteScope}
              onScopeChange={onNoteScopeChange}
            />
          </>
        )}
      </div>

      <LearningCardActions states={actionStates} onAction={onAction} />
    </div>
  );
}
