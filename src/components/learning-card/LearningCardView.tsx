import { useEffect, useId, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { AlertCircle, ChevronDown, ChevronRight, GripHorizontal, Loader2, RotateCw, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  presentationMode?: boolean;
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
  presentationMode = false,
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

  return (
    <div
      role={presentationMode ? "region" : "dialog"}
      aria-modal={presentationMode ? undefined : true}
      aria-labelledby={titleId}
      className="flex min-h-0 max-w-full flex-col overflow-hidden rounded-md border border-border/80 bg-bg-surface shadow-context"
      style={{ width: `${width}px`, maxHeight }}
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
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-surface/70"
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
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-surface/70"
          >
            <X size={14} />
          </button>
        )}
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-card-scroll
        onDoubleClick={onLookupWord}
        onMouseUp={onSelectText}
      >
        {error ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-5 py-6 text-center" role="alert">
            <AlertCircle size={18} className="text-danger-text" />
            <p className="max-w-full break-words text-[12px] text-text-secondary">{error}</p>
            {onRetry && (
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
