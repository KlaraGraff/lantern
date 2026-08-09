import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listenForSettingsChanged, notifySettingsChanged } from "../components/settings-events";

/**
 * The seven fixed dimensions a profile card can live under. Mirrors the
 * `profile_cards.slot` primary key on the backend (`src-tauri/src/commands/profile.rs`'s
 * `DIMENSIONS` registry) — this list is the single source of truth for
 * rendering order and for the `profile.slot.<key>` i18n lookups (see
 * `src/components/profile/profile-slots.ts`).
 */
export const PROFILE_SLOTS = [
  "vocab_explain",
  "syntax_explain",
  "reference_explain",
  "cultural_context",
  "lookup_pattern",
  "example_source",
  "reply_pacing",
] as const;

export type ProfileSlot = (typeof PROFILE_SLOTS)[number];

export type ProfileCardStatus = "active" | "moved" | "deleted";

/**
 * One dimension's card — mirrors the Rust `ProfileCard` struct field for
 * field (`#[serde(rename_all = "camelCase")]`, so both the struct's own
 * fields *and* every invoke parameter are camelCase on this side). `evidence`
 * is a single short phrase the backend's summarizer writes, not a list — see
 * `RawCard.evidence: String` in `profile.rs`.
 *
 * `profile_get` only ever returns cards with status `"active"` or `"moved"` —
 * the backend's `SELECT ... WHERE status IN ('active','moved')` means a
 * `"deleted"` card is simply absent from `cards`, never present with that
 * status. The type still carries `"deleted"` for completeness (and because
 * `ProfileCardStatus` is also used as a general vocabulary elsewhere), but no
 * card in `ProfileState.cards` will ever actually have it.
 */
export interface ProfileCard {
  slot: ProfileSlot;
  conclusion: string;
  evidence: string;
  status: ProfileCardStatus;
  updatedAt: number;
  /**
   * Whether `profile_card_evidence` has a stored aggregation snapshot for this
   * slot. Cards written before migration 068 don't, so the drill-down is only
   * offered when there is in fact something behind it.
   */
  hasEvidence: boolean;
}

/**
 * Which shape `ProfileCardEvidence.payload` parses to. The four follow-up
 * dimensions share one shape and collapse to `"followup"`; the other three are
 * one-of-a-kind. Mirrors `evidence_kind` in `profile.rs`.
 */
export type EvidenceKind = "followup" | "lookup_pattern" | "example_source" | "reply_pacing" | "unknown";

export interface FollowupEvidence {
  count: number;
  weighted_count: number;
  sampled_examples: { passage: string; question: string }[];
}

export interface LookupPatternEvidence {
  count: number;
  repeat_lookup_rate: number;
  band_distribution: Record<string, number>;
  sample_words: string[];
}

export interface ExampleSourceEvidence {
  top_books: { title: string; author: string; language: string | null; share: number }[];
}

export interface ReplyPacingEvidence {
  count: number;
  average_question_length: number;
  single_turn_share: number;
}

export type EvidencePayload =
  | FollowupEvidence
  | LookupPatternEvidence
  | ExampleSourceEvidence
  | ReplyPacingEvidence;

/**
 * The records a card's conclusion was actually drawn from — a snapshot taken
 * when the summarizer wrote that conclusion, not a query re-run now. `payload`
 * arrives as the raw JSON text the backend stored (it never parses it; the
 * shape belongs to whichever aggregation produced it), so this hook parses it
 * once here and hands the caller a value it can render.
 */
export interface ProfileCardEvidence {
  slot: ProfileSlot;
  kind: EvidenceKind;
  capturedAt: number | null;
  payload: EvidencePayload;
}

/**
 * The assembled block that actually leaves the app — what the AI is told about
 * the reader, verbatim, English scaffolding included. `text` is `null` when
 * nothing is being injected at all (profile switched off, or both halves
 * empty). Mirrors the Rust `InjectionPreview`.
 */
export interface InjectionPreview {
  text: string | null;
  charCount: number;
  locale: string;
}

/**
 * Mirrors the Rust `ProfileView` struct (`profile.rs`) verbatim. `softLimit`/
 * `hardLimit` come from the backend now — it already resolves the setting
 * and doubles it, so this hook no longer reads `profile.soft_limit` itself
 * and cannot drift from the backend's own enforcement.
 */
export interface ProfileState {
  userText: string;
  draftText: string;
  enabled: boolean;
  softLimit: number;
  hardLimit: number;
  cards: ProfileCard[];
  newFollowupsSinceLastBatch: number;
  lastSummarizedAt: number | null;
  /** How many `profile_revisions` rows exist — the "第 N 次" count in the mockup's status strip. */
  revisionCount: number;
  /** The batch trigger floor (20 today) — the "X / 20" denominator in the status strip. */
  batchSize: number;
}

const DEFAULT_SOFT_LIMIT = 1200;
const ENABLED_SETTING_KEY = "profile.enabled";
const SOFT_LIMIT_SETTING_KEY = "profile.soft_limit";

/**
 * Wraps the `profile_*` Tauri commands declared in
 * `src-tauri/src/commands/profile.rs`.
 *
 * Every mutation (`saveText`, `moveCard`, `undoMove`, `deleteCard`,
 * `deleteAll`, `summarizeNow`) re-fetches `profile_get()` afterwards rather
 * than trusting its own return shape or hand-patching local state — the
 * backend is the single source of truth for derived fields like
 * `revisionCount`/`newFollowupsSinceLastBatch` that a client-side patch could
 * easily get wrong.
 */
export function useProfile() {
  const [state, setState] = useState<ProfileState | null>(null);
  const [injection, setInjection] = useState<InjectionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  // Set only by a failed *initial* load (no `state` to fall back on yet) — a
  // failed refresh after that point leaves the last-known `state` on screen
  // instead of replacing it with an error page.
  const [loadError, setLoadError] = useState(false);
  const requestGenerationRef = useRef(0);
  const hasLoadedRef = useRef(false);

  const refresh = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    try {
      // Fetched together so the "AI 现在这样理解你" block can never show a
      // stale assembly of cards the page below it has already re-rendered.
      // The preview is best-effort: a failure there leaves the page working
      // and simply hides that one block, rather than failing the whole load.
      const [result, preview] = await Promise.all([
        invoke<ProfileState>("profile_get"),
        invoke<InjectionPreview>("profile_injection_preview").catch((err) => {
          console.error("Failed to load profile injection preview:", err);
          return null;
        }),
      ]);
      if (generation !== requestGenerationRef.current) return;
      setState(result);
      setInjection(preview);
      setLoadError(false);
      hasLoadedRef.current = true;
    } catch (err) {
      console.error("Failed to load profile:", err);
      if (generation === requestGenerationRef.current) setLoadError(!hasLoadedRef.current);
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // profile.soft_limit lives in the same `settings` table LearningSettings.tsx
  // writes to — a change there should reflow this page's limits without a
  // manual reload, so a re-fetch (the limits are server-derived now) is all
  // this needs to do.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listenForSettingsChanged((values) => {
      if (disposed) return;
      // `language` matters too: the injected block titles its cards in the
      // reader's own language, so switching it changes the previewed text.
      if (SOFT_LIMIT_SETTING_KEY in values || "language" in values) refresh();
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const softLimit = state?.softLimit ?? DEFAULT_SOFT_LIMIT;
  const hardLimit = state?.hardLimit ?? DEFAULT_SOFT_LIMIT * 2;

  const saveText = useCallback(
    async (text: string) => {
      // Client-side backstop so the blocking confirm (state ③) never needs a
      // round trip to find out it's blocked — the backend enforces the same
      // hard × 2 ceiling (`profile_save_text_inner`) and rejects without
      // truncating either way.
      if (text.length > hardLimit) {
        throw new Error("profile_text_over_hard_limit");
      }
      await invoke("profile_save_text", { text });
      await refresh();
    },
    [hardLimit, refresh],
  );

  // Optimistically mirrors `text` onto `state.draftText` locally instead of
  // waiting on a full `refresh()` — a full re-`profile_get()` after every
  // autosave/cancel would itself race the very save it's meant to reflect,
  // and in between, `state.draftText` stays stale. Concretely: autosave
  // writes draft "A", the reader keeps typing to "AB" and saves — without
  // this, `state.draftText` is still "A" until some future refresh, so
  // `hasRestorableDraft` in `ProfileContent.tsx` stays true and the next
  // "编辑" open prefills the stale "A" over the just-saved "AB".
  const saveDraft = useCallback(async (text: string) => {
    await invoke("profile_save_draft", { text });
    setState((prev) => (prev ? { ...prev, draftText: text } : prev));
  }, []);

  /**
   * Atomic per `profile_move_card(slot, fullText, insertedText)`: the
   * backend validates the hard limit, sets `user_text = fullText`, snapshots
   * `insertedText` onto the card row, flips it to `moved`, and logs the
   * event — all in one call. Call this exactly once, at the move flow's
   * explicit "保存" step; a cancel must never reach this function at all.
   */
  const moveCard = useCallback(
    async (slot: ProfileSlot, fullText: string, insertedText: string) => {
      await invoke("profile_move_card", { slot, fullText, insertedText });
      await refresh();
    },
    [refresh],
  );

  const undoMove = useCallback(
    async (slot: ProfileSlot) => {
      await invoke("profile_undo_move", { slot });
      await refresh();
    },
    [refresh],
  );

  const deleteCard = useCallback(
    async (slot: ProfileSlot) => {
      await invoke("profile_delete_card", { slot });
      await refresh();
    },
    [refresh],
  );

  const deleteAll = useCallback(async () => {
    await invoke("profile_delete_all");
    await refresh();
  }, [refresh]);

  const summarizeNow = useCallback(async () => {
    await invoke<number>("profile_summarize_now");
    await refresh();
  }, [refresh]);

  /**
   * Utility-tier rewrite passes — 步骤 3 splits the old one-button
   * `profile_optimize_text` into two commands with different rules:
   * `compressText` (`profile_compress_text`) may merge near-duplicate
   * requirements and cut filler to shrink toward the limit; `tidyText`
   * (`profile_tidy_text`) may only reorder — it must never merge, drop, or
   * invent a requirement, and the result is allowed to come back longer.
   * Both return the rewritten text as a bare string (never `{ text }`) and
   * never write it back — the result only ever lands in the side-by-side
   * compare panel, applied via `saveText` if the reader picks it. `text` is
   * always the *unsaved* editor buffer, not what's on disk; `direction` is
   * `null` when the reader hasn't typed one.
   */
  const compressText = useCallback(async (text: string, direction?: string) => {
    return invoke<string>("profile_compress_text", {
      text,
      direction: direction || null,
    });
  }, []);

  const tidyText = useCallback(async (text: string, direction?: string) => {
    return invoke<string>("profile_tidy_text", {
      text,
      direction: direction || null,
    });
  }, []);

  /**
   * The destination for a card's "查看原始记录" — the aggregation snapshot the
   * conclusion was written from. Returns `null` when the card has no snapshot
   * (written before migration 068), or when the stored JSON can't be parsed;
   * in both cases the caller shows nothing rather than an error, since this is
   * a drill-down onto an explanation that is already fully readable above it.
   */
  const loadCardEvidence = useCallback(async (slot: ProfileSlot): Promise<ProfileCardEvidence | null> => {
    const raw = await invoke<{
      slot: ProfileSlot;
      kind: EvidenceKind;
      capturedAt: number | null;
      payload: string;
    } | null>("profile_card_evidence", { slot });
    if (!raw) return null;
    try {
      return { ...raw, payload: JSON.parse(raw.payload) as EvidencePayload };
    } catch (err) {
      console.error("Failed to parse profile card evidence:", err);
      return null;
    }
  }, []);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const value = String(enabled);
      await invoke("set_setting", { key: ENABLED_SETTING_KEY, value });
      await notifySettingsChanged({ [ENABLED_SETTING_KEY]: value });
      await refresh();
    },
    [refresh],
  );

  return {
    state,
    injection,
    loading,
    loadError,
    softLimit,
    hardLimit,
    refresh,
    saveText,
    saveDraft,
    moveCard,
    undoMove,
    deleteCard,
    deleteAll,
    summarizeNow,
    compressText,
    tidyText,
    loadCardEvidence,
    setEnabled,
  };
}
