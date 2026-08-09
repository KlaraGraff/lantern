import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { AliasDecision, AliasMatch, AliasResolutionMetadata, ChatMessage } from "../hooks/useAiChat";
import { serializeMessageMetadata } from "../hooks/useAiChat";
import IndexManagerModal from "./IndexManagerModal";

// Mirrors the camelCase fields of AliasGroupView (person_aliases.rs) — only
// `canonical` is needed here, the picker just lists names.
interface PersonAliasGroup {
  canonical: string;
}

const CONFIRM_BUTTON = "px-3 py-1.5 rounded-full text-[12px] font-medium text-accent-text bg-accent-bg border border-accent/30 hover:opacity-80 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default";
const REJECT_BUTTON = "px-3 py-1.5 rounded-full text-[12px] font-medium text-text-secondary bg-bg-input border border-border hover:bg-bg-surface cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default";
const PICKER_CHIP = "px-2.5 py-1 rounded-full text-[11.5px] font-medium text-text-secondary border border-border hover:bg-bg-input cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default";

/** The matches that earn a line above the answer.
 *
 *  Two shapes qualify, for two different reasons. A >1-canonical match is
 *  ambiguous — that's what raised the confidence to medium in the first place
 *  (see the confidence table in docs/impls/person-aliases.md). A description
 *  match qualifies whatever its canonical count: it was found by comparing the
 *  *meaning* of the question against a phrase the reader taught by hand, so
 *  even a single unambiguous canonical is a guess about what they meant, and
 *  the doc's rule is that a guess is always shown. Its `canonicals.length` is
 *  usually 1, which is exactly why the backend flags it explicitly instead of
 *  letting this function infer it. */
function disclosedMatches(matched: AliasMatch[]): AliasMatch[] {
  return matched.filter((match) => match.canonicals.length > 1 || match.description === true);
}

/** Low confidence never carries `matched`/`defaultCanonical` — resolve() only
 *  fills those in for medium (see AliasResolution's doc comment in
 *  aliases.rs). So the "X" for the low-confidence confirm button has to come
 *  from the answer itself: whichever of the book's canonical names the model
 *  actually used in its prose.
 *
 *  Earliest mention wins, not longest name. An answer about the sycophantic
 *  clergyman opens on Mr. Collins and may mention Elizabeth Bennet three
 *  sentences later; ranking by name length would offer the reader
 *  "Elizabeth Bennet" to confirm, which is both wrong and the kind of wrong
 *  that gets written into the alias table. Length only breaks ties at the
 *  same position, so "Mr. Collins" still wins over the "Collins" nested
 *  inside it. Returns null rather than guessing when no name from this book
 *  appears at all — the confirm button is then simply omitted.
 */
function findMentionedCanonical(content: string, canonicals: string[]): string | null {
  const lowerContent = content.toLowerCase();
  let best: { canonical: string; at: number } | null = null;
  for (const canonical of new Set(canonicals.filter(Boolean))) {
    const at = lowerContent.indexOf(canonical.toLowerCase());
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && canonical.length > best.canonical.length)) {
      best = { canonical, at };
    }
  }
  return best?.canonical ?? null;
}

interface AliasDisclosureLineProps {
  resolution: AliasResolutionMetadata;
  /** What the reader actually typed — quoted back in the low-confidence
   *  line ("couldn't tell who X refers to"). */
  precedingUserContent: string;
  /** Which book's alias table the "manage" link opens. Omitted for a message
   *  that was not asked against a book — the link is then simply absent. */
  bookId?: string;
  /** Re-asks the question naming `canonical` instead. Left undefined until
   *  the panel hosting this chat threads its `send()` through — see this
   *  component's call site in MessageBubble.tsx for the current gap. */
  onSwapAlias?: (canonical: string) => void;
}

/** The line above the answer — states 6 and 7 in
 *  docs/impls/alias-routing-mockup.html. Quiet and informational, not an
 *  alert: a reader who asked a perfectly fine question shouldn't see a
 *  warning color for it. */
export function AliasDisclosureLine({ resolution, precedingUserContent, bookId, onSwapAlias }: AliasDisclosureLineProps) {
  const { t } = useTranslation();
  /** The alias whose table the reader asked to see, or null for closed (D9). */
  const [managing, setManaging] = useState<string | null>(null);

  if (resolution.confidence === "low") {
    if (!precedingUserContent) return null;
    return (
      <div
        role="status"
        className="mb-2 rounded-md bg-bg-input px-2.5 py-1.5 text-[11.5px] leading-[1.5] text-text-secondary"
      >
        {t("ai.aliasDisclosure.low.body", { phrase: precedingUserContent })}
      </div>
    );
  }

  const disclosed = disclosedMatches(resolution.matched);
  if (disclosed.length === 0) return null;

  return (
    <div role="status" className="mb-2 flex flex-col gap-1.5">
      {disclosed.map((match) => {
        const current = match.canonicals.includes(resolution.defaultCanonical ?? "")
          ? (resolution.defaultCanonical as string)
          : match.canonicals[0];
        const alternates = match.canonicals.filter((canonical) => canonical !== current);
        return (
          <div
            key={match.alias}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-bg-input px-2.5 py-1.5 text-[11.5px] leading-[1.5] text-text-secondary"
          >
            {/* A description match says where the reading came from — the
                reader taught this phrase themselves, and "searched X as Y"
                would read as though Lantern found the name in their question,
                which it did not. The swap links below stay the same either
                way: a taught phrase can still point at two people. */}
            <span>
              {match.description
                ? t("ai.aliasDisclosure.medium.description", { alias: match.alias, canonical: current })
                : t("ai.aliasDisclosure.medium.body", { alias: match.alias, canonical: current })}
            </span>
            {onSwapAlias && alternates.map((canonical) => (
              <button
                key={canonical}
                type="button"
                onClick={() => onSwapAlias(canonical)}
                className="text-accent-text underline decoration-dotted underline-offset-2 hover:opacity-70 cursor-pointer"
              >
                {t("ai.aliasDisclosure.medium.swapTo", { canonical })}
              </button>
            ))}
            {/* Swapping fixes this one answer; the reading itself keeps coming
                back until the table changes. This is the second of those two
                doors, and it opens on the alias the reader is doubting. */}
            {bookId && (
              <button
                type="button"
                onClick={() => setManaging(match.alias)}
                className="text-text-muted underline decoration-dotted underline-offset-2 hover:text-text-secondary cursor-pointer"
              >
                {t("ai.aliasDisclosure.medium.manage")}
              </button>
            )}
          </div>
        );
      })}
      {managing && bookId && (
        <IndexManagerModal bookId={bookId} focusAlias={managing} onClose={() => setManaging(null)} />
      )}
    </div>
  );
}

interface AliasResolutionFooterProps {
  message: ChatMessage;
  precedingUserContent: string;
}

/** The confirm/reject strip below the answer, and the receipt it collapses
 *  into in place — states 7, 7b and 8. Low confidence only: medium's swap
 *  (state 6) is a link on the line above, with no below-the-answer control
 *  (see person-aliases.md's 界面 section — a below-the-answer strip only
 *  exists for the "couldn't tell who this is" case). */
export function AliasResolutionFooter({ message, precedingUserContent }: AliasResolutionFooterProps) {
  const { t } = useTranslation();
  const resolution = message.aliasResolution;
  const isLow = resolution?.confidence === "low";
  const [decision, setDecision] = useState(resolution?.decision);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [canonicals, setCanonicals] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    if (!isLow || decision || !message.bookId) return;
    let cancelled = false;
    invoke<PersonAliasGroup[]>("list_person_aliases", { bookId: message.bookId })
      .then((groups) => {
        if (!cancelled) setCanonicals(groups.map((group) => group.canonical).filter(Boolean));
      })
      .catch(() => {
        if (!cancelled) setCanonicals([]);
      });
    return () => { cancelled = true; };
  }, [isLow, decision, message.bookId]);

  const detectedCanonical = useMemo(
    () => findMentionedCanonical(message.content, canonicals ?? []),
    [message.content, canonicals],
  );

  if (!resolution || !isLow) return null;

  /** Writes `next` (or clears it, on undo) to the message's stored metadata.
   *  The row write and the message write are two calls with no transaction
   *  across them, so the order matters: on undo the row is deleted first,
   *  because a receipt still showing after its row is gone is a smaller lie
   *  than a table row the reader has already been told was withdrawn. */
  const writeDecision = async (next: AliasDecision | undefined) => {
    if (!message.dbId || busy) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      const nextResolution: AliasResolutionMetadata = { ...resolution, decision: next };
      const metadata = serializeMessageMetadata({
        reasoning: message.reasoning,
        sources: message.sources,
        spoilerGuard: message.spoilerGuard,
        route: message.route,
        sectionIndex: message.sectionIndex,
        sectionEndIndex: message.sectionEndIndex,
        sectionContext: message.sectionContext,
        sourceHash: message.sourceHash,
        contextBudget: message.contextBudget,
        aliasResolution: nextResolution,
      });
      await invoke("replace_chat_message", {
        messageId: message.dbId,
        content: message.content,
        metadata,
      });
      setDecision(next);
      setPickerOpen(false);
    } catch (err) {
      console.error("Failed to record alias decision:", err);
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const persist = async (canonical: string) => {
    if (!message.bookId || !message.dbId || busy || !precedingUserContent) return;
    setBusy(true);
    setSaveFailed(false);
    let aliasId: string;
    try {
      // `teach_description_alias`, not `add_person_alias`: it also embeds the
      // phrase, which is what makes the row match anything. Description rows
      // are invisible to resolve()'s substring scan and are found by comparing
      // that embedding against the next question's — so the vector is the
      // whole point, and it is computed here and now, in one short call. No
      // reindex, no progress bar, and no backfill UI belongs here: the alias
      // is live on the reader's very next question. If the embedding fails the
      // command still resolves — the row is saved without a vector and the
      // book's next index run fills it in.
      aliasId = await invoke<string>("teach_description_alias", {
        bookId: message.bookId,
        canonical,
        alias: precedingUserContent,
        sourceQuery: precedingUserContent,
      });
    } catch (err) {
      console.error("Failed to record alias decision:", err);
      setSaveFailed(true);
      setBusy(false);
      return;
    }
    setBusy(false);
    await writeDecision({ canonical, aliasId });
  };

  const undo = async () => {
    if (!decision || busy) return;
    if (decision.aliasId) {
      setBusy(true);
      try {
        await invoke("delete_person_alias", { id: decision.aliasId });
      } catch (err) {
        console.error("Failed to withdraw alias decision:", err);
        setSaveFailed(true);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    await writeDecision(undefined);
  };

  // State 8: the strip becomes a one-line receipt in place, never a new turn.
  if (decision) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2 text-[11.5px] text-text-secondary">
        <span>
          {t("ai.aliasDisclosure.low.receipt", { phrase: precedingUserContent, canonical: decision.canonical })}
        </span>
        {decision.aliasId && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void undo()}
            className="text-[11px] text-text-muted underline underline-offset-2 hover:text-text-secondary disabled:opacity-50"
          >
            {t("ai.aliasDisclosure.low.undo")}
          </button>
        )}
        {saveFailed && (
          <span className="text-[11px] text-danger-text">{t("ai.aliasDisclosure.low.saveFailed")}</span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-2">
      <div className="flex flex-wrap items-center gap-2">
        {detectedCanonical && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void persist(detectedCanonical)}
            className={CONFIRM_BUTTON}
          >
            {busy
              ? <Loader2 size={12} className="inline-block animate-spin" />
              : t("ai.aliasDisclosure.low.confirm", { canonical: detectedCanonical })}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => setPickerOpen((open) => !open)}
          className={REJECT_BUTTON}
        >
          {t("ai.aliasDisclosure.low.reject")}
        </button>
      </div>
      {pickerOpen && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] text-text-muted">{t("ai.aliasDisclosure.low.pickerPrompt")}</span>
          {canonicals === null ? (
            <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
              <Loader2 size={11} className="animate-spin" />
              {t("ai.aliasDisclosure.low.pickerLoading")}
            </span>
          ) : canonicals.length === 0 ? (
            <span className="text-[11px] text-text-muted">{t("ai.aliasDisclosure.low.pickerEmpty")}</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {canonicals.map((canonical) => (
                <button
                  key={canonical}
                  type="button"
                  disabled={busy}
                  onClick={() => void persist(canonical)}
                  className={PICKER_CHIP}
                >
                  {canonical}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {saveFailed && (
        <span className="text-[11px] text-danger-text">{t("ai.aliasDisclosure.low.saveFailed")}</span>
      )}
    </div>
  );
}
