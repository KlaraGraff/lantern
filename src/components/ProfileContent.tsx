import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Undo2,
  WandSparkles,
} from "lucide-react";
import Button from "./ui/Button";
import Toast from "./ui/Toast";
import { useProfile, type ProfileCard, type ProfileSlot } from "../hooks/useProfile";
import { PROFILE_SLOT_ICONS, profileSlotOrder } from "./profile/profile-slots";
import OptimizeComparePanel from "./profile/OptimizeComparePanel";
import InjectionPreviewBlock from "./profile/InjectionPreviewBlock";
import CardEvidencePanel from "./profile/CardEvidencePanel";
import HardLimitDialog from "./profile/HardLimitDialog";
import DeleteCardDialog from "./profile/DeleteCardDialog";
import DeleteAllDialog from "./profile/DeleteAllDialog";
import { timeAgo } from "../utils/timeAgo";
import { useCoarsePointer } from "../hooks/useCoarsePointer";
import { TOP_INSET } from "../utils/top-inset";
import { platform } from "../services/platform";

function countClass(length: number, softLimit: number, hardLimit: number) {
  if (length > hardLimit) return "text-danger-text";
  if (length > softLimit) return "text-warning";
  return "text-text-muted";
}

/** A move-edit in progress (state ⑤'s left half) — set by `beginMove`, cleared on save or cancel. */
interface PendingMove {
  slot: ProfileSlot;
  /** The suggested "维度名：结论" line, exactly as first appended. */
  insertedLine: string;
  /** The buffer's content immediately before this move started — restored verbatim on cancel. */
  preText: string;
  /** Whether the editor was already open before the move button was clicked. */
  wasEditingBefore: boolean;
}

/**
 * "个人" — a section of the settings modal (`SettingsSection === "personal"`),
 * not a page of its own any more (docs/impls/home-ia-consolidation.md step 2).
 * Structurally it still follows the full-height pane pattern
 * `ReadingStatsContent.tsx` established, which is why it takes `embedded` to
 * drop the title-bar padding and drag region when it renders inside the modal.
 *
 * Visual/interaction spec: docs/impls/user-profile-mockup.html (v6). States
 * ⓪–⑥ all live in this one component plus its `profile/` subcomponents:
 * ⓪ empty · ① default · ② soft-limit hint (inline) · ③ hard-limit block
 * (`HardLimitDialog`) · ④ optimize compare (`OptimizeComparePanel`) ·
 * ⑤ move/undo (the editor's `PendingMove` branch + ghosted card collapse) ·
 * ⑥ delete-card confirm (`DeleteCardDialog`).
 */
interface ProfileContentProps {
  /**
   * True when this renders inside the settings modal (设置 · 个人) rather than
   * as a page of its own. The modal is not a window: the title-bar inset and
   * the drag region belong to a full-page container, and left in place inside
   * the modal the drag region would let a reader drag the OS window by what
   * looks like ordinary modal content. The heading also steps down to match
   * the other settings panes.
   */
  embedded?: boolean;
}

export default function ProfileContent({ embedded = false }: ProfileContentProps = {}) {
  const { t } = useTranslation();
  const coarsePointer = useCoarsePointer();
  const {
    state,
    injection,
    loading,
    loadError,
    refresh,
    softLimit,
    hardLimit,
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
  } = useProfile();

  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [showHardLimit, setShowHardLimit] = useState(false);
  // 步骤 3: "整理" (tidy, reorder-only) and "压缩" (compress, may merge) share
  // this one compare panel — `null` means neither is open, and the two never
  // show at once (see the editor footer / `HardLimitDialog` below).
  const [compareMode, setCompareMode] = useState<"compress" | "tidy" | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [expandedGhosts, setExpandedGhosts] = useState<Set<ProfileSlot>>(new Set());
  // 依据 is collapsed by default per 步骤 3 — it's still there for anyone who
  // wants to check the reasoning behind a card, it just isn't shown
  // unprompted. Ghost cards already gate their evidence behind
  // `expandedGhosts`; this is the same idea for active cards.
  const [expandedEvidence, setExpandedEvidence] = useState<Set<ProfileSlot>>(new Set());
  // One level deeper than `expandedEvidence`: the 依据 phrase is the
  // summarizer's own account of its reasoning, this is the aggregation
  // snapshot it was actually reading (migration 068 / `CardEvidencePanel`).
  const [expandedRecords, setExpandedRecords] = useState<Set<ProfileSlot>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<ProfileSlot | null>(null);
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const [cardBusy, setCardBusy] = useState<ProfileSlot | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [restoredDraftNotice, setRestoredDraftNotice] = useState(false);
  // True only while the editor is open because the effect below opened it, not
  // because the reader asked for it. The distinction exists purely so the
  // textarea knows whether it may take focus — see `autoFocus` on it.
  const [autoOpened, setAutoOpened] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Visible feedback for failures that have no other on-screen home (undo,
  // delete-card, delete-all, summarize-now, toggle) — mirrors the
  // danger-tinted `<Toast>` pattern `UpdateToast.tsx` uses for its own
  // failure state, auto-dismissed rather than requiring a click.
  const flashError = useCallback((message: string) => {
    setErrorMessage(message);
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    errorTimeoutRef.current = setTimeout(() => setErrorMessage(null), 3200);
  }, []);
  // Same toast, neutral icon — for outcomes that aren't failures but still
  // need to be said out loud rather than happen silently (a move quietly
  // downgraded to a plain save, an in-progress move getting discarded by a
  // different action).
  const flashNotice = useCallback((message: string) => {
    setNoticeMessage(message);
    if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    noticeTimeoutRef.current = setTimeout(() => setNoticeMessage(null), 3200);
  }, []);
  useEffect(() => () => {
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
  }, []);

  // Keeps the buffer honest whenever the editor is closed — a move/undo
  // elsewhere on the page changes `userText` server-side, and this is the
  // only path that would otherwise miss it.
  useEffect(() => {
    if (!editing && state) setDraftText(state.userText);
  }, [state, editing]);

  // 空态就是编辑态：没写过东西的时候不再先摆一段说明+「开始写」按钮，进来
  // 光标就落在输入框里。`editing` 仍然要真的置位——自动保存草稿和上面那个
  // 缓冲同步的 effect 都看它，光把编辑器渲染出来是不够的。
  useEffect(() => {
    if (!state || state.userText.length > 0 || editing) return;
    const restorable = state.draftText.length > 0;
    setDraftText(restorable ? state.draftText : "");
    setRestoredDraftNotice(restorable);
    setEditing(true);
    setAutoOpened(true);
  }, [state, editing]);

  // Draft autosave: `profile_save_draft` has no limit and never blocks —
  // it exists so an in-progress edit survives a crash or an accidental
  // close, not so every keystroke round-trips eagerly.
  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      saveDraft(draftText).catch(() => {});
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draftText, editing, saveDraft]);

  // Once a move-edit inserts its line, focus the textarea and *select* the
  // inserted line — no separate read-only strip is rendered above the
  // textarea (the mockup is explicit that the moved text carries no special
  // wrapping in the input box itself; the ghosted card is where the
  // provenance lives), so the native text-selection highlight is what stands
  // in for "该行高亮". Falls back to just parking the cursor at the end if the
  // buffer's prefix no longer matches (shouldn't normally happen this early).
  useEffect(() => {
    if (!pendingMove || !textareaRef.current) return;
    const el = textareaRef.current;
    el.focus();
    const value = el.value;
    const prefixLen = pendingMove.preText.length;
    const hasPrefix = value.startsWith(pendingMove.preText);
    const lineStart = hasPrefix ? prefixLen + (pendingMove.preText.length > 0 ? 1 : 0) : value.length;
    const nextBreak = value.indexOf("\n", lineStart);
    const lineEnd = nextBreak === -1 ? value.length : nextBreak;
    el.setSelectionRange(lineStart, lineEnd);
    el.scrollTop = el.scrollHeight;
    // Only when a move newly starts — not on every keystroke afterward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMove?.slot]);

  if (loading || (loadError && !state)) {
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-bg-surface">
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          {loading ? (
            <p className="text-[13px] text-text-muted">{t("home.loading")}</p>
          ) : (
            <>
              <p className="text-[13px] text-text-muted">{t("profile.loadFailed")}</p>
              <Button variant="secondary" size="sm" onClick={() => void refresh()}>
                {t("common.retry")}
              </Button>
            </>
          )}
        </div>
      </main>
    );
  }
  if (!state) return null;

  // "草稿已保留" needs to actually hold across a relaunch, not just within one
  // open session — `profile_save_draft` already persists on every keystroke
  // (see the autosave effect above); this is the read side of that promise.
  const hasRestorableDraft = state.draftText.length > 0 && state.draftText !== state.userText;
  const bufferBase = editing ? draftText : hasRestorableDraft ? state.draftText : state.userText;

  const startEditing = () => {
    setDraftText(bufferBase);
    setEditing(true);
    setAutoOpened(false);
    setSaveFailed(false);
    setRestoredDraftNotice(hasRestorableDraft);
  };

  const cancelEditing = () => {
    if (pendingMove) {
      // "取消 = 什么都没发生" — restore exactly what was in the buffer before
      // this move started; nothing is sent to the backend either way.
      setDraftText(pendingMove.preText);
      setEditing(pendingMove.wasEditingBefore);
      setPendingMove(null);
      setSaveFailed(false);
      if (!pendingMove.wasEditingBefore) setRestoredDraftNotice(false);
      // The autosave effect will have already pushed the buffer-with-
      // inserted-line to the backend draft while the move was pending —
      // clean that back up. Whether to restore `preText` or clear outright
      // turns on *content*, not on `wasEditingBefore`: a move can start from
      // the closed view with `preText` already equal to an existing
      // restorable draft (`bufferBase` prefers `state.draftText` over
      // `state.userText` when one exists) — unconditionally clearing here
      // would wipe that pre-existing draft, which "取消 = 什么都没发生" forbids.
      saveDraft(pendingMove.preText === state.userText ? "" : pendingMove.preText).catch(() => {});
      return;
    }
    setDraftText(state.userText);
    setEditing(false);
    setSaveFailed(false);
    setRestoredDraftNotice(false);
    saveDraft("").catch(() => {});
  };

  /**
   * The move's "insertedText" as it stands right now. Only the buffer's
   * *first* tail line counts — not the whole tail — so that if the reader
   * hits Enter and keeps writing more of their own text after the inserted
   * line, that new text is never folded into `insertedText` and is never at
   * risk of being stripped out by a later undo. The trade-off: a reader who
   * hits Enter mid-edit *of the inserted line itself* only has the part
   * before the break captured; the rest sits in `fullText` as ordinary text
   * and simply won't be removed on undo. That's the acceptable side to be
   * wrong on — never the side that deletes the reader's own writing.
   *
   * "found" — recovered a non-empty first line from the buffer's tail.
   * "empty" — the reader deleted the inserted line entirely (N2: falls back
   * to a plain save, no move happens).
   * "mismatch" — the buffer's prefix no longer matches `preText` (reader
   * edited earlier text too); falls back to the original suggested line.
   */
  const resolveInsertedText = (
    move: PendingMove,
    buffer: string,
  ): { kind: "found" | "mismatch"; text: string } | { kind: "empty" } => {
    if (buffer.startsWith(move.preText)) {
      let tail = buffer.slice(move.preText.length);
      if (tail.startsWith("\n")) tail = tail.slice(1);
      const firstLine = tail.split("\n")[0].trim();
      if (firstLine.length === 0) return { kind: "empty" };
      return { kind: "found", text: firstLine };
    }
    return { kind: "mismatch", text: move.insertedLine };
  };

  const attemptSave = async () => {
    if (draftText.length > hardLimit) {
      setShowHardLimit(true);
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    try {
      if (pendingMove) {
        const resolved = resolveInsertedText(pendingMove, draftText);
        if (resolved.kind === "empty") {
          // The reader deleted the inserted line before saving — there's
          // nothing left to move, so this becomes an ordinary text save and
          // the card stays exactly as it was (active, untouched).
          await saveText(draftText);
          setPendingMove(null);
          flashNotice(t("profile.move.lineRemoved"));
        } else {
          await moveCard(pendingMove.slot, draftText, resolved.text);
          setExpandedGhosts((prev) => new Set(prev).add(pendingMove.slot));
          setPendingMove(null);
        }
      } else {
        await saveText(draftText);
      }
      setEditing(false);
      setRestoredDraftNotice(false);
      await saveDraft("").catch(() => {});
    } catch (err) {
      console.error("Failed to save profile text:", err);
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const toggleGhostExpanded = (slot: ProfileSlot) => {
    setExpandedGhosts((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  };

  const toggleEvidenceExpanded = (slot: ProfileSlot) => {
    setExpandedEvidence((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  };

  const toggleRecordsExpanded = (slot: ProfileSlot) => {
    setExpandedRecords((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  };

  /**
   * Opens the move-edit flow (state ⑤'s left half) — shared by both entry
   * points (the card's own button and the delete dialog's escape hatch), per
   * the review's "移动入口两处都改走新流程". Purely local state: nothing
   * reaches the backend until the reader presses "保存" in the editor.
   *
   * Only one move can be pending at a time (N3) — every call site guards on
   * `!pendingMove` before calling this, so it's a no-op guard here too
   * rather than silently stacking a second move on top of the first.
   */
  const beginMove = (slot: ProfileSlot) => {
    if (pendingMove) return;
    const card = state.cards.find((c) => c.slot === slot);
    if (!card) return;
    const label = t(`profile.slot.${slot}`);
    const separator = t("profile.move.separator");
    const insertedLine = `${label}${separator}${card.conclusion}`;
    const preText = bufferBase;
    const nextText = preText.trim().length > 0 ? `${preText}\n${insertedLine}` : insertedLine;
    setPendingMove({ slot, insertedLine, preText, wasEditingBefore: editing });
    setDraftText(nextText);
    setEditing(true);
    setSaveFailed(false);
    setRestoredDraftNotice(false);
  };

  const runUndo = async (slot: ProfileSlot) => {
    setCardBusy(slot);
    try {
      await undoMove(slot);
    } catch (err) {
      console.error("Failed to undo profile card move:", err);
      flashError(t("profile.errors.undo"));
    } finally {
      setCardBusy(null);
    }
  };

  const runDeleteCard = async () => {
    if (!deleteTarget) return;
    try {
      await deleteCard(deleteTarget);
      setDeleteTarget(null);
    } catch (err) {
      console.error("Failed to delete profile card:", err);
      flashError(t("profile.errors.deleteCard"));
    }
  };

  const runSummarizeNow = async () => {
    setSummarizing(true);
    try {
      await summarizeNow();
    } catch (err) {
      console.error("Failed to summarize profile now:", err);
      flashError(t("profile.errors.summarize"));
    } finally {
      setSummarizing(false);
    }
  };

  const toggleEnabled = () => {
    setEnabled(!state.enabled).catch((err) => {
      console.error("Failed to toggle profile:", err);
      flashError(t("profile.errors.toggle"));
    });
  };

  const runDeleteAll = async () => {
    try {
      await deleteAll();
      setConfirmingDeleteAll(false);
    } catch (err) {
      console.error("Failed to delete profile:", err);
      flashError(t("profile.errors.deleteAll"));
    }
  };

  const visibleCards = profileSlotOrder()
    .map((slot) => state.cards.find((card) => card.slot === slot))
    .filter((card): card is ProfileCard => Boolean(card));
  const activeCards = visibleCards.filter((card) => card.status === "active");
  const conclusionChars = activeCards.reduce((sum, card) => sum + card.conclusion.length, 0);
  const overSoft = draftText.length > softLimit;
  const overHard = draftText.length > hardLimit;
  const remaining = Math.max(0, state.batchSize - state.newFollowupsSinceLastBatch);
  // "第一批" framing is tied to whether a batch has ever landed at all
  // (`revisionCount === 0`), not to whether any card happens to be visible
  // right now — a profile with every card deleted after a real revision is
  // not "waiting for its first batch" and must not say so.
  const neverSummarized = state.revisionCount === 0;
  // A profile that has never held anything has nothing to delete, and a red
  // destructive action sitting under an empty page invites a click that can
  // only be a no-op. `revisionCount` is part of the test on purpose: once a
  // batch has landed there is history behind the page even if every card was
  // deleted afterwards, and `deleteAll` is the only way to purge that.
  const nothingToDelete =
    state.userText.length === 0
    && state.draftText.length === 0
    && visibleCards.length === 0
    && neverSummarized;
  const moveDelta = pendingMove ? draftText.length - pendingMove.preText.length : 0;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg-surface">
      <header className={`relative shrink-0 border-b border-border px-page pb-4 ${embedded ? "pt-4" : TOP_INSET}`}>
        {!embedded && platform.hasTitleBarInset && <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-titlebar" />}
        {/* Title beside buttons needs about 500px. Inside the settings modal
            on a phone there are roughly 310px, and the two buttons take 200 of
            them — so the row becomes two rows, title first. */}
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-4">
          <div className="min-w-0">
            <h1 className={`${embedded ? "text-[18px]" : "text-[24px]"} font-semibold text-text-primary`}>{t("profile.title")}</h1>
            <p className="mt-1 max-w-[58ch] text-[13px] leading-[1.6] text-text-secondary">
              {state.enabled ? t("profile.subtitle") : t("profile.subtitleOff")}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* Off means the summariser is not running; offering to run it once
                anyway would contradict the line right above. */}
            <Button
              variant="secondary"
              size="sm"
              disabled={summarizing || !state.enabled}
              title={state.enabled ? undefined : t("profile.summarizeNowOffHint")}
              onClick={() => void runSummarizeNow()}
            >
              {summarizing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {t("profile.summarizeNow")}
            </Button>
            <Button variant="ghost" size="sm" onClick={toggleEnabled}>
              {state.enabled ? t("profile.turnOff") : t("profile.turnOn")}
            </Button>
          </div>
        </div>
      </header>

      {/* Turned off, the strip stops reporting batch progress and decay: both
          describe a summariser that is still running, and a green dot next to
          them reads as "live". Nothing here is lost — it resumes on re-enable. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-light bg-bg-muted px-page py-2 text-[11.8px] text-text-muted">
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            !state.enabled ? "bg-text-placeholder" : neverSummarized ? "bg-warning" : "bg-success"
          }`}
        />
        {!state.enabled ? (
          <span>{t("profile.strip.off")}</span>
        ) : neverSummarized ? (
          <span>{t("profile.strip.firstBatch")}</span>
        ) : (
          <span>
            {state.lastSummarizedAt
              ? t("profile.strip.lastSummarized", { when: timeAgo(state.lastSummarizedAt), count: state.revisionCount })
              : t("profile.strip.neverSummarized")}
            {" · "}
            {t("profile.strip.batchProgress")}
          </span>
        )}
        <span className="flex-1" />
        {state.enabled && (
          <span>{neverSummarized ? t("profile.strip.writeNowHint") : t("profile.strip.decayHint")}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-page py-5">
        <div className="mx-auto max-w-[820px]">
          {/* ── AI 现在这样理解你 ── the assembled block, above both halves
              that feed it, because it is the only thing here that actually
              leaves the app. */}
          <InjectionPreviewBlock preview={injection} enabled={state.enabled} />

          {/* ── 你写的 ── */}
          <div className="mb-1.5 flex items-center gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-text-muted">{t("profile.yourText.heading")}</p>
            <span className="flex-1" />
            {/* Past the hard limit the count turns red but must also stop
                *suggesting* — at this length saving is refused outright, and
                "建议压缩" reads as advice the reader may decline. */}
            <span className={`text-[11.2px] tabular-nums ${countClass(draftText.length, softLimit, hardLimit)}`}>
              {overHard
                ? t("profile.yourText.countBlocked", { count: draftText.length, softLimit })
                : overSoft
                  ? t("profile.yourText.countWarn", { count: draftText.length, softLimit })
                  : t("profile.yourText.count", { count: draftText.length, softLimit })}
            </span>
          </div>

          {compareMode ? (
            <OptimizeComparePanel
              mode={compareMode}
              originalText={draftText}
              softLimit={softLimit}
              hardLimit={hardLimit}
              runText={compareMode === "compress" ? compressText : tidyText}
              onCancel={() => setCompareMode(null)}
              onUse={(text) => {
                setDraftText(text);
                setCompareMode(null);
                setEditing(true);
                setAutoOpened(false);
                // A rewritten draft generally no longer contains the
                // inserted line verbatim — treat this as a normal edit from
                // here on rather than risk sending a stale insertedText. The
                // reader explicitly asked for this trade (N3): if a move was
                // pending, say so instead of quietly dropping it.
                if (pendingMove) flashNotice(t("profile.move.abandoned"));
                setPendingMove(null);
              }}
            />
          ) : editing || !state.userText ? (
            /* `|| !state.userText` 只是兜住 auto-open effect 生效前的那一帧，
               免得空态闪一下别的东西——真正的开关还是 `editing`。 */
            <div className="rounded-xl border border-lavender bg-bg-surface p-3.5 ring-2 ring-accent-bg">
              {restoredDraftNotice && (
                <p className="mb-2 text-[11.5px] leading-[1.6] text-text-muted">{t("profile.yourText.draftRestored")}</p>
              )}
              <textarea
                ref={textareaRef}
                /* 「空态就是编辑态」那条只在鼠标下成立：键盘不占地方，光标落进
                   输入框是省一次点击。手指下同一个动作代价完全不同——进「个人」
                   页就弹起键盘、页面自己滚到底部，读者连页面长什么样都没看见。
                   所以只压掉自动打开这一条路径；读者自己点「编辑」照样聚焦。 */
                autoFocus={!pendingMove && !(coarsePointer && autoOpened)}
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                placeholder={t("profile.yourText.placeholder")}
                className={`min-h-[110px] w-full resize-y rounded-lg border bg-bg-surface p-3 text-[13px] leading-[1.7] text-text-primary outline-none focus:border-accent ${
                  overHard ? "border-danger-border" : overSoft ? "border-warning/40" : "border-border"
                }`}
              />
              {pendingMove && (
                <p className="mt-1.5 text-[11.5px] leading-[1.6] text-text-muted">{t("profile.move.hint")}</p>
              )}
              {overSoft && !overHard && !pendingMove && (
                <p className="mt-1.5 text-[11.5px] leading-[1.6] text-warning">{t("profile.yourText.softHint")}</p>
              )}
              {saveFailed && <p className="mt-1.5 text-[11.5px] text-danger-text">{t("profile.yourText.saveFailed")}</p>}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={saving} onClick={() => void attemptSave()}>
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {t("common.save")}
                </Button>
                {/* "整理" only reorders (never merges or drops a requirement) and
                    has nothing to do with length, so unlike "压缩" it's not
                    gated on `overSoft` — it's available any time the editor
                    is open and there isn't a move pending. Once `overHard`,
                    saving is blocked outright and `HardLimitDialog` becomes
                    the only place an AI rewrite button shows (its "压缩"),
                    so this one steps aside instead of showing alongside it. */}
                {!overHard && !pendingMove && (
                  <Button variant="secondary" size="sm" onClick={() => setCompareMode("tidy")}>
                    <WandSparkles size={14} />
                    {t("profile.tidyNow")}
                  </Button>
                )}
                {/* 还没存过正文时，编辑器就是这一栏的常态，「取消」没有可回到
                    的地方——只有正在做移动时它还有意义（取消 = 什么都没发生）。 */}
                {(state.userText || pendingMove) && (
                  <Button variant="ghost" size="sm" disabled={saving} onClick={cancelEditing}>
                    {t("common.cancel")}
                  </Button>
                )}
                {pendingMove && (
                  <>
                    <span className="flex-1" />
                    <span className="text-[11.2px] tabular-nums text-text-muted">
                      {moveDelta < 0
                        ? t("profile.yourText.count", { count: draftText.length, softLimit })
                        : t("profile.move.delta", { added: moveDelta, count: draftText.length, softLimit })}
                    </span>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-soft-lilac bg-bg-surface p-3.5">
              {state.userText.split("\n").filter(Boolean).map((line, index) => (
                <p key={index} className="text-[13px] leading-[1.7] text-text-primary last:mb-0" style={{ marginBottom: 9 }}>
                  {line}
                </p>
              ))}
              <div className="mt-2.5 flex items-center gap-1 border-t border-border-light pt-2.5">
                <Button variant="ghost" size="sm" onClick={startEditing}>
                  <Pencil size={13} />
                  {t("common.edit")}
                </Button>
              </div>
            </div>
          )}

          {/* ── 系统总结的 ── */}
          <div className="mb-1.5 mt-7 flex items-center gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-text-muted">{t("profile.system.heading")}</p>
            {activeCards.length > 0 && (
              <>
                <span className="flex-1" />
                <span className="text-[11.2px] tabular-nums text-text-muted">
                  {t("profile.system.count", { chars: conclusionChars })}
                </span>
              </>
            )}
          </div>

          {visibleCards.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-bg-muted p-3.5">
              <p className="text-[12.4px] leading-[1.7] text-text-muted">
                {t("profile.system.empty", { remaining })}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {visibleCards.map((card) => {
                const Icon = PROFILE_SLOT_ICONS[card.slot];
                const label = t(`profile.slot.${card.slot}`);
                const busy = cardBusy === card.slot;

                if (card.status === "moved") {
                  const expanded = expandedGhosts.has(card.slot);
                  return (
                    <div key={card.slot} className="rounded-xl border border-dashed border-border bg-bg-muted p-3.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Icon size={14} className="shrink-0 text-text-muted" />
                        <h5 className="text-[13px] font-semibold text-text-muted">{label}</h5>
                        <span className="inline-flex items-center rounded-md bg-accent-bg px-1.5 py-0.5 text-[10.5px] font-semibold text-accent-text">
                          {t("profile.movedBadge")}
                        </span>
                        <span className="flex-1" />
                        <Button variant="ghost" size="sm" onClick={() => toggleGhostExpanded(card.slot)}>
                          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                          {expanded ? t("profile.collapse") : t("profile.expand")}
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void runUndo(card.slot)}>
                          {busy ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
                          {t("common.undo")}
                        </Button>
                      </div>
                      {expanded && (
                        <>
                          <p className="mt-2 text-[13px] leading-[1.7] text-text-muted">{card.conclusion}</p>
                          {/* "已接管" is not gated on `evidence` being present —
                              it always applies once a card is moved, evidence
                              or not. */}
                          <div className="mt-2 rounded-lg bg-bg-input px-2.5 py-2 text-[11.5px] leading-[1.65] text-text-muted">
                            {card.evidence && (
                              <>
                                <b className="font-semibold text-text-secondary">{t("profile.evidenceLabel")}</b>
                                {card.evidence}
                                {card.hasEvidence && (
                                  <>
                                    {" · "}
                                    <button
                                      type="button"
                                      onClick={() => toggleRecordsExpanded(card.slot)}
                                      className="font-medium text-accent-text hover:opacity-75"
                                    >
                                      {expandedRecords.has(card.slot)
                                        ? t("profile.evidence.hideRecords")
                                        : t("profile.evidence.viewRecords")}
                                    </button>
                                  </>
                                )}
                                <br />
                              </>
                            )}
                            {t("profile.movedTakeoverNote")}
                          </div>
                          {card.hasEvidence && expandedRecords.has(card.slot) && (
                            <CardEvidencePanel slot={card.slot} load={loadCardEvidence} />
                          )}
                        </>
                      )}
                    </div>
                  );
                }

                return (
                  <div key={card.slot} className="rounded-xl border border-border bg-bg-surface p-3.5">
                    <div className="flex items-center gap-2">
                      <Icon size={14} className="shrink-0 text-text-secondary" />
                      <h5 className="text-[13px] font-semibold tracking-tight text-text-primary">{label}</h5>
                    </div>
                    <p className="mt-1 text-[13px] leading-[1.7] text-text-primary">{card.conclusion}</p>
                    {card.evidence && (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleEvidenceExpanded(card.slot)}
                          className="mt-1.5 flex items-center gap-1 text-[11.5px] font-medium text-text-muted hover:text-text-secondary touch:min-h-11"
                        >
                          {expandedEvidence.has(card.slot) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          {expandedEvidence.has(card.slot) ? t("profile.collapse") : t("profile.expand")}
                        </button>
                        {expandedEvidence.has(card.slot) && (
                          <>
                            <div className="mt-1.5 rounded-lg bg-bg-muted px-2.5 py-2 text-[11.5px] leading-[1.65] text-text-muted">
                              <b className="font-semibold text-text-secondary">{t("profile.evidenceLabel")}</b>
                              {card.evidence}
                              {/* The 依据 line above is a phrase the summarizer
                                  wrote about its own reasoning. This is the
                                  link out to what it was actually reading —
                                  absent on cards written before the snapshot
                                  existed, rather than opening onto nothing. */}
                              {card.hasEvidence && (
                                <>
                                  {" · "}
                                  <button
                                    type="button"
                                    onClick={() => toggleRecordsExpanded(card.slot)}
                                    className="font-medium text-accent-text hover:opacity-75"
                                  >
                                    {expandedRecords.has(card.slot)
                                      ? t("profile.evidence.hideRecords")
                                      : t("profile.evidence.viewRecords")}
                                  </button>
                                </>
                              )}
                            </div>
                            {card.hasEvidence && expandedRecords.has(card.slot) && (
                              <CardEvidencePanel slot={card.slot} load={loadCardEvidence} />
                            )}
                          </>
                        )}
                      </>
                    )}
                    <div className="mt-2.5 flex items-center gap-1 border-t border-border-light pt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={Boolean(pendingMove)}
                        title={pendingMove ? t("profile.move.alreadyPending") : undefined}
                        onClick={() => beginMove(card.slot)}
                      >
                        {t("profile.moveToText")}
                      </Button>
                      <span className="flex-1" />
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(card.slot)}>
                        <Trash2 size={13} />
                        {t("common.delete")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border bg-bg-muted px-page py-3 text-[11.5px] text-text-muted">
        <span>{t("profile.footer.autoAnalysisHint")}</span>
        <span className="flex-1" />
        {!nothingToDelete && (
          <button
            type="button"
            onClick={() => setConfirmingDeleteAll(true)}
            className="text-[12px] font-medium text-danger-text hover:opacity-75 touch:inline-flex touch:min-h-11 touch:items-center"
          >
            {t("profile.deleteAll.trigger")}
          </button>
        )}
      </div>

      {showHardLimit && (
        <HardLimitDialog
          softLimit={softLimit}
          hardLimit={hardLimit}
          onBackToEdit={() => setShowHardLimit(false)}
          onCompress={() => {
            setShowHardLimit(false);
            setCompareMode("compress");
          }}
        />
      )}

      {deleteTarget && (
        <DeleteCardDialog
          slotLabel={t(`profile.slot.${deleteTarget}`)}
          onCancel={() => setDeleteTarget(null)}
          moveDisabled={Boolean(pendingMove)}
          onMoveInstead={() => {
            beginMove(deleteTarget);
            setDeleteTarget(null);
          }}
          onConfirmDelete={runDeleteCard}
        />
      )}

      {confirmingDeleteAll && (
        <DeleteAllDialog
          onCancel={() => setConfirmingDeleteAll(false)}
          onConfirm={runDeleteAll}
        />
      )}

      {errorMessage && (
        <Toast icon={<AlertTriangle size={14} className="shrink-0 text-danger-text" />}>{errorMessage}</Toast>
      )}
      {!errorMessage && noticeMessage && (
        <Toast icon={<Info size={14} className="shrink-0 text-accent-text" />}>{noticeMessage}</Toast>
      )}
    </main>
  );
}
