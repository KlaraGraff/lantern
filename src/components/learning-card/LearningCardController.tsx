import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { createUuid } from "../../utils/randomUuid";
import type { AiErrorCode } from "../../utils/aiError";
import type { ReaderInteraction, SerializableRect } from "../reader-interaction";
import { saveVocabWord } from "../vocab/collect";
import { serializeCardSnapshot } from "../vocab/cardSnapshot";
import {
  cachedLearningCardResult,
  learningCardCacheEnvelope,
  learningCardCacheSignature,
} from "./cache";
import { getResponsiveLearningCardWidth, learningCardFailure } from "./config";
import { cardVocabFields, moduleText, projection } from "./projection.ts";
import type {
  CardDesignConfigV1,
  LearningCardActionId,
  LearningCardNote,
  LearningCardResult,
  WordMemoryHint,
} from "./types";
import LearningCardView from "./LearningCardView";
import { LearningCardStreamParser } from "./streaming";
import { getFocusableElements, trapTabKey } from "../focus-trap";

interface LearningCardResponse extends LearningCardResult {
  provenance?: {
    profileId?: string;
    provider?: string;
    model?: string;
  };
}

interface BackendNote {
  id: string;
  content: string;
  updated_at: number;
  scope: "book" | "global";
}

interface LearningCardControllerProps {
  interaction: ReaderInteraction;
  bookId: string;
  bookTitle?: string;
  bookAuthor?: string;
  chapter?: string;
  config: CardDesignConfigV1;
  readerRect?: SerializableRect | DOMRect | null;
  stackIndex?: number;
  elevated?: boolean;
  onClose: () => void;
  onFocus?: () => void;
  onLookupWord?: (event: ReactMouseEvent<HTMLElement>) => void;
  onSelectText?: (event: ReactMouseEvent<HTMLElement>) => void;
  onAskAi: (quote: string, location?: string, analysis?: string) => void;
  onViewAllNotes?: () => void;
  onLookupSuccess?: (interaction: ReaderInteraction) => void;
}

interface LearningCardStreamChunk {
  delta: string;
  reasoning_delta?: string;
  done: boolean;
  error?: string;
}

interface CardPoint {
  left: number;
  top: number;
}

// Cards already open keep their place, so each new one is nudged down-right to
// leave the earlier headers reachable when two words sit on the same line.
const STACK_STEP = 22;
const STACK_STEP_LIMIT = 3;

function cardPosition(
  interaction: ReaderInteraction,
  readerRect: SerializableRect | DOMRect | null | undefined,
  width: number,
  stackIndex = 0,
) {
  const reader = readerRect ?? {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const margin = 12;
  const availableHeight = Math.max(0, reader.height - margin * 2);
  const maxHeight = Math.min(window.innerHeight * 0.75, availableHeight);
  const preferredRight = interaction.anchorRect.right + 8;
  const preferredLeft = interaction.anchorRect.left - width - 8;
  const left = preferredRight + width <= reader.right - margin
    ? preferredRight
    : preferredLeft >= reader.left + margin
      ? preferredLeft
      : Math.max(reader.left + margin, Math.min(
          interaction.anchorRect.left,
          reader.right - width - margin,
        ));
  const below = reader.bottom - interaction.anchorRect.bottom - margin;
  const above = interaction.anchorRect.top - reader.top - margin;
  const top = below >= Math.min(360, maxHeight) || below >= above
    ? Math.min(interaction.anchorRect.bottom + 8, reader.bottom - maxHeight - margin)
    : Math.max(reader.top + margin, interaction.anchorRect.top - maxHeight - 8);
  const cascade = Math.min(stackIndex, STACK_STEP_LIMIT) * STACK_STEP;
  return {
    left: left + cascade,
    top: Math.max(reader.top + margin, top) + cascade,
    maxHeight,
  };
}

function clampCardPoint(
  point: CardPoint,
  readerRect: SerializableRect | DOMRect | null | undefined,
  cardWidth: number,
  cardHeight: number,
): CardPoint {
  const reader = readerRect ?? {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  const margin = 12;
  const minLeft = reader.left + margin;
  const minTop = reader.top + margin;
  const maxLeft = Math.max(minLeft, reader.right - cardWidth - margin);
  const maxTop = Math.max(minTop, reader.bottom - cardHeight - margin);
  return {
    left: Math.min(maxLeft, Math.max(minLeft, point.left)),
    top: Math.min(maxTop, Math.max(minTop, point.top)),
  };
}

export default function LearningCardController({
  interaction,
  bookId,
  bookTitle,
  bookAuthor,
  chapter,
  config,
  readerRect,
  stackIndex = 0,
  elevated = false,
  onClose,
  onFocus,
  onLookupWord,
  onSelectText,
  onAskAi,
  onViewAllNotes,
  onLookupSuccess,
}: LearningCardControllerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<LearningCardResponse>({
    version: 1,
    kind: interaction.kind,
    sourceText: interaction.text,
    modules: {},
  });
  const [loading, setLoading] = useState(true);
  const [thinking, setThinking] = useState(false);
  const [reasoning, setReasoning] = useState("");
  const [error, setError] = useState<string | null>(null);
  /**
   * Set when the failure was the AI route itself rather than the card protocol.
   * The view needs the code, not just the message, to decide whether the reader
   * can act on it here (retry) or has to change a setting first.
   */
  const [aiErrorCode, setAiErrorCode] = useState<AiErrorCode | null>(null);
  /**
   * The card failed, but modules had already finished streaming into it. Those
   * modules are complete and correct — the answer only came apart afterwards —
   * so they stay on screen and the failure is reported as a strip beneath them
   * instead of replacing them.
   */
  const [partial, setPartial] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [notes, setNotes] = useState<LearningCardNote[]>([]);
  const [noteEditorOpen, setNoteEditorOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteId, setNoteId] = useState<string | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteScope, setNoteScope] = useState<"book" | "global">("book");
  const [collected, setCollected] = useState(false);
  const [memoryHint, setMemoryHint] = useState<WordMemoryHint | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshNotes = useCallback(async () => {
    const values = await invoke<BackendNote[]>("list_context_notes", {
      bookId,
      word: interaction.kind === "word" ? interaction.text : null,
      location: interaction.kind === "word" ? null : interaction.location,
    });
    setNotes(values.map((note) => ({
      id: note.id,
      content: note.content,
      updatedAt: note.updated_at,
      scope: note.scope,
    })));
  }, [bookId, interaction.kind, interaction.location, interaction.text]);

  useEffect(() => {
    setResult({ version: 1, kind: interaction.kind, sourceText: interaction.text, modules: {} });
    setLoading(true);
    setThinking(false);
    setReasoning("");
    setError(null);
    setAiErrorCode(null);
    setPartial(false);
    setFromCache(false);
    const requestId = createUuid();
    const card = config.cards[interaction.kind];
    const cacheSignature = learningCardCacheSignature(card);
    const allowedModuleIds = new Set(
      card.modules
        .filter((module) => module.enabled)
        .map((module) => module.id),
    );
    const parser = new LearningCardStreamParser(allowedModuleIds);
    let active = true;
    // How many modules finished streaming before anything went wrong. A card
    // that failed after showing eight modules is not a blank card, and clearing
    // the eight to print one error is the reader losing work that arrived.
    let streamed = 0;
    let unlisten: UnlistenFn | undefined;
    // Reasoning arrives token by token. Coalescing a frame's worth of it into
    // one update keeps a model that thinks for a minute from re-rendering the
    // card thousands of times, exactly as the chat stream does.
    let pendingReasoning = "";
    let reasoningFrame: number | null = null;
    const flushReasoning = () => {
      reasoningFrame = null;
      if (!active || !pendingReasoning) return;
      const delta = pendingReasoning;
      pendingReasoning = "";
      setReasoning((current) => current + delta);
    };

    const run = async () => {
      try {
        if (retry === 0) {
          const cached = await invoke<{ result_json?: string | null } | null>("get_cached_lookup", {
            bookId,
            lookupText: interaction.text,
            cfi: interaction.location || null,
            contextSentence: interaction.context || null,
          }).catch(() => null);
          const reusable = cachedLearningCardResult(
            cached?.result_json,
            interaction.kind,
            cacheSignature,
          );
          if (!active) return;
          if (reusable) {
            setResult(reusable);
            setLoading(false);
            setFromCache(true);
            if (interaction.kind === "word") onLookupSuccess?.(interaction);
            return;
          }
        }

        unlisten = await listen<LearningCardStreamChunk>(
          `ai-learning-card-chunk-${requestId}`,
          (event) => {
            if (!active || event.payload.done) return;
            if (!event.payload.delta) {
              // A model that reasons before it answers sends nothing but
              // reasoning for as long as it thinks — up to a minute on some.
              // Showing that beats a spinner indistinguishable from a hang.
              if (event.payload.reasoning_delta) {
                setThinking(true);
                pendingReasoning += event.payload.reasoning_delta;
                if (reasoningFrame === null) {
                  reasoningFrame = requestAnimationFrame(flushReasoning);
                }
              }
              return;
            }
            flushReasoning();
            setThinking(false);
            const streamedModules = parser.push(event.payload.delta);
            if (Object.keys(streamedModules).length === 0) return;
            streamed += Object.keys(streamedModules).length;
            setResult((current) => ({
              ...current,
              modules: { ...current.modules, ...streamedModules },
            }));
          },
        );
        if (!active) {
          unlisten();
          unlisten = undefined;
          return;
        }

        const response = await invoke<LearningCardResponse>("ai_learning_card", {
          text: interaction.text,
          context: interaction.context,
          kind: interaction.kind,
          bookTitle: bookTitle || null,
          bookAuthor: bookAuthor || null,
          chapter: chapter || null,
          cardConfig: JSON.stringify(config),
          requestId,
          // A hand-pressed retry means "try anyway": the route stops treating
          // a resting model as out of play for this one request.
          retry: retry > 0,
        });
        if (!active) return;
        setResult(response);
        setLoading(false);
        setThinking(false);
        if (interaction.kind === "word") onLookupSuccess?.(interaction);
        const projected = projection(response);
        invoke("save_lookup_record", {
          bookId,
          lookupText: interaction.text,
          contextSentence: interaction.context || null,
          chapter: chapter || null,
          cfi: interaction.location || null,
          definition: projected.definition,
          contextExplanation: projected.contextExplanation,
          resultJson: learningCardCacheEnvelope(response, cacheSignature),
          providerProfileId: response.provenance?.profileId || null,
          model: response.provenance?.model || null,
        }).then(() => {
          window.dispatchEvent(new CustomEvent("lookup-record-changed", { detail: { bookId, cfi: interaction.location } }));
        }).catch(() => {});
      } catch (reason) {
        if (!active) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        const { key, aiCode } = learningCardFailure(message);
        setAiErrorCode(aiCode);
        setError(key ? t(key) : message);
        // Nothing is written to the lookup cache on this path — `save_lookup_record`
        // only ever runs on the success branch above — so a salvaged card is
        // shown once and never reused as if it were whole.
        setPartial(streamed > 0);
        setLoading(false);
        setThinking(false);
      } finally {
        unlisten?.();
        unlisten = undefined;
      }
    };

    run();
    return () => {
      active = false;
      if (reasoningFrame !== null) cancelAnimationFrame(reasoningFrame);
      unlisten?.();
      unlisten = undefined;
      invoke("ai_cancel", { requestId }).catch(() => {});
    };
  }, [bookAuthor, bookId, bookTitle, chapter, config, interaction, onLookupSuccess, retry, t]);

  useEffect(() => {
    refreshNotes().catch(() => {});
    if (interaction.kind === "word") {
      invoke<string | null>("check_vocab_exists", { bookId, word: interaction.text })
        .then((id) => setCollected(Boolean(id)))
        .catch(() => {});
      // Read on mount, before this lookup's own record is written, so the
      // counts here are the ones the prompt was built from.
      invoke<WordMemoryHint | null>("word_memory_hint", { word: interaction.text })
        .then(setMemoryHint)
        .catch(() => {});
    }
  }, [bookId, interaction.kind, interaction.text, refreshNotes]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // The card itself takes focus, not its first control.
    //
    // Focusing the first control (the pronounce button, as it happens) drew a
    // focus ring around it the moment any card opened — a highlight on a button
    // the reader never pointed at, on every lookup and every cached card. The
    // card is a `tabIndex={-1}` container, so focus can rest on it: Escape and
    // the Tab trap work from the first keystroke, and the first Tab moves to the
    // first control, which is where a ring belongs.
    wrapper.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // The wrapper is part of the ring so Shift+Tab off the first control
      // lands back on the card rather than escaping to the page behind it.
      trapTabKey(event, wrapper, { elements: [wrapper, ...getFocusableElements(wrapper)] });
    };
    wrapper.addEventListener("keydown", onKeyDown);
    return () => wrapper.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const bounds = readerRect ?? null;
  const availableWidth = bounds?.width ?? window.innerWidth;
  const width = getResponsiveLearningCardWidth(
    interaction.kind,
    config.cards[interaction.kind],
    availableWidth,
  );
  const initialPosition = cardPosition(interaction, bounds, width, stackIndex);
  const [position, setPosition] = useState<CardPoint>(() => ({
    left: initialPosition.left,
    top: initialPosition.top,
  }));
  const positionRef = useRef(position);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: CardPoint;
  } | null>(null);

  const updatePosition = useCallback((next: CardPoint) => {
    const cardRect = wrapperRef.current?.getBoundingClientRect();
    const clamped = clampCardPoint(
      next,
      bounds,
      cardRect?.width ?? width,
      cardRect?.height ?? initialPosition.maxHeight,
    );
    positionRef.current = clamped;
    setPosition((current) => (
      current.left === clamped.left && current.top === clamped.top ? current : clamped
    ));
  }, [bounds, initialPosition.maxHeight, width]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const clampCurrent = () => updatePosition(positionRef.current);
    const observer = new ResizeObserver(clampCurrent);
    observer.observe(wrapper);
    window.addEventListener("resize", clampCurrent);
    clampCurrent();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", clampCurrent);
    };
  }, [updatePosition]);

  const onDragPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: positionRef.current,
    };
  }, []);

  const onDragPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    updatePosition({
      left: drag.origin.left + event.clientX - drag.startX,
      top: drag.origin.top + event.clientY - drag.startY,
    });
  }, [updatePosition]);

  const onDragPointerEnd = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  // A salvaged card has real modules in it, so its actions stay usable: the
  // reader can collect or copy the part that arrived. Only a card with nothing
  // in it disables them.
  const unusable = loading || (Boolean(error) && !partial);
  const actionStates = useMemo(() => ({
    collect: { collected, disabled: unusable },
    ask_ai: { disabled: unusable },
    note: { disabled: false },
    copy: { copied, disabled: unusable },
  }), [collected, copied, unusable]);

  const onAction = useCallback(async (action: LearningCardActionId) => {
    if (action === "ask_ai") {
      onAskAi(interaction.text, interaction.location, JSON.stringify(result));
      return;
    }
    if (action === "note") {
      setNoteId(null);
      setNoteDraft("");
      setNoteScope("book");
      setNoteEditorOpen(true);
      return;
    }
    if (action === "copy") {
      const content = [interaction.text, ...Object.values(result.modules).map(moduleText)].filter(Boolean).join("\n\n");
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
      return;
    }
    if (action === "collect") {
      // `definition` is one short line above the word; the card's own text is
      // the long form and belongs in `context_explanation`. Storing the card
      // in `definition` (as this did) put a module heading over every saved
      // word and corrupted the vocabulary list, review cards and export with
      // it. The card's summary is offered as the gloss and used only if it is
      // already short enough. `cardVocabFields` is shared with the vocabulary
      // panel's regenerate, which has to land on the same two values.
      const fields = cardVocabFields(result);
      await saveVocabWord({
        bookId,
        word: interaction.text,
        gloss: fields.gloss,
        contextSentence: interaction.context || null,
        contextExplanation: fields.contextExplanation,
        cfi: interaction.location || null,
        cardSnapshot: serializeCardSnapshot(result),
      });
      setCollected(true);
      window.dispatchEvent(new CustomEvent("vocab-changed", { detail: { bookId, cfi: interaction.location } }));
    }
  }, [bookId, interaction, onAskAi, result]);

  const saveNote = useCallback(async () => {
    if (!noteDraft.trim()) return;
    setNoteSaving(true);
    try {
      await invoke("save_note", {
        id: noteId,
        bookId,
        anchorKind: interaction.kind === "word" ? "word" : "selection",
        word: interaction.kind === "word" ? interaction.text : null,
        scope: interaction.kind === "word" ? noteScope : "book",
        location: interaction.location || null,
        selectedText: interaction.text,
        content: noteDraft.trim(),
      });
      setNoteEditorOpen(false);
      setNoteDraft("");
      setNoteId(null);
      await refreshNotes();
    } finally {
      setNoteSaving(false);
    }
  }, [bookId, interaction, noteDraft, noteId, noteScope, refreshNotes]);

  return (
    <div
      ref={wrapperRef}
      tabIndex={-1}
      className={elevated ? "fixed z-[61] outline-none" : "fixed z-[60] outline-none"}
      style={{ left: position.left, top: position.top }}
      onPointerDown={onFocus}
    >
      <LearningCardView
        result={result}
        config={config}
        availableWidth={availableWidth}
        maxHeight={initialPosition.maxHeight}
        loading={loading}
        thinking={thinking}
        reasoning={reasoning}
        error={error}
        partial={partial}
        aiErrorCode={aiErrorCode}
        notes={notes}
        noteEditorOpen={noteEditorOpen}
        noteDraft={noteDraft}
        noteSaving={noteSaving}
        noteScope={noteScope}
        onNoteScopeChange={setNoteScope}
        actionStates={actionStates}
        onAction={onAction}
        onClose={onClose}
        onDragPointerDown={onDragPointerDown}
        onDragPointerMove={onDragPointerMove}
        onDragPointerEnd={onDragPointerEnd}
        onRetry={() => setRetry((value) => value + 1)}
        onRefresh={fromCache ? () => setRetry((value) => value + 1) : undefined}
        // A cached card was written before this record was read, so claiming
        // the record shaped it would be a guess. Only a fresh answer earns it.
        memoryHint={fromCache ? null : memoryHint}
        onLookupWord={onLookupWord}
        onSelectText={onSelectText}
        onNoteDraftChange={setNoteDraft}
        onNoteSave={saveNote}
        onNoteCancel={() => { setNoteEditorOpen(false); setNoteDraft(""); setNoteId(null); }}
        onNoteEdit={(note) => { setNoteId(note.id); setNoteDraft(note.content); setNoteScope(note.scope ?? "book"); setNoteEditorOpen(true); }}
        onNoteDelete={(note) => {
          invoke("delete_note", { id: note.id }).then(refreshNotes).catch(() => {});
        }}
        onViewAllNotes={onViewAllNotes}
      />
    </div>
  );
}
