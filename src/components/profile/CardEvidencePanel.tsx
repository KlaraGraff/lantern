import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type {
  EvidencePayload,
  ExampleSourceEvidence,
  FollowupEvidence,
  LookupPatternEvidence,
  ProfileCardEvidence,
  ProfileSlot,
  ReplyPacingEvidence,
} from "../../hooks/useProfile";
import { timeAgo } from "../../utils/timeAgo";

/**
 * The destination for a card's 「查看原始记录」 — the records the conclusion
 * above it was actually written from.
 *
 * `profile_cards.evidence` (the one-line 依据 the card already shows) is a
 * phrase the summarizer model wrote about itself in the same call that
 * produced the conclusion: it reads like a citation and points at nothing.
 * This panel shows the other thing — the aggregation block that was handed to
 * the model, snapshotted at the moment it wrote that sentence (migration 068).
 *
 * It is deliberately a snapshot, not a fresh query: re-running the aggregation
 * on open would show today's reading, which is not what the conclusion was
 * drawn from, and the pair would silently stop matching.
 */
interface CardEvidencePanelProps {
  slot: ProfileSlot;
  load: (slot: ProfileSlot) => Promise<ProfileCardEvidence | null>;
}

export default function CardEvidencePanel({ slot, load }: CardEvidencePanelProps) {
  const { t } = useTranslation();
  const [evidence, setEvidence] = useState<ProfileCardEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setFailed(false);
    load(slot)
      .then((result) => {
        if (disposed) return;
        setEvidence(result);
        setFailed(result === null);
      })
      .catch((err) => {
        console.error("Failed to load profile card evidence:", err);
        if (!disposed) setFailed(true);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [slot, load]);

  if (loading) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-bg-muted px-2.5 py-2 text-[11.5px] text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        {t("profile.evidence.loading")}
      </div>
    );
  }

  if (failed || !evidence) {
    return (
      <div className="mt-1.5 rounded-lg bg-bg-muted px-2.5 py-2 text-[11.5px] leading-[1.65] text-text-muted">
        {t("profile.evidence.unavailable")}
      </div>
    );
  }

  return (
    <div className="mt-1.5 rounded-lg border border-border-light bg-bg-muted px-2.5 py-2.5">
      {/* Where this sits in the chain — records to conclusion to prompt. The
          reader is one click deep into "凭什么这么说我"; the answer is only
          honest if the destination of the sentence is on screen too. */}
      <p className="mb-2 text-[11px] leading-[1.6] text-text-muted">{t("profile.evidence.chain")}</p>
      <EvidenceBody kind={evidence.kind} payload={evidence.payload} />
      {evidence.capturedAt !== null && (
        <p className="mt-2 border-t border-border-light pt-1.5 text-[10.8px] leading-[1.6] text-text-placeholder">
          {t("profile.evidence.capturedAt", { when: timeAgo(evidence.capturedAt) })}
        </p>
      )}
    </div>
  );
}

function EvidenceBody({ kind, payload }: { kind: string; payload: EvidencePayload }) {
  switch (kind) {
    case "followup":
      return <FollowupBody payload={payload as FollowupEvidence} />;
    case "lookup_pattern":
      return <LookupPatternBody payload={payload as LookupPatternEvidence} />;
    case "example_source":
      return <ExampleSourceBody payload={payload as ExampleSourceEvidence} />;
    case "reply_pacing":
      return <ReplyPacingBody payload={payload as ReplyPacingEvidence} />;
    default:
      return <UnknownBody />;
  }
}

function UnknownBody() {
  const { t } = useTranslation();
  return <p className="text-[11.5px] leading-[1.65] text-text-muted">{t("profile.evidence.unavailable")}</p>;
}

/** Section label above a list of records. */
function Summary({ children }: { children: React.ReactNode }) {
  return <p className="text-[11.8px] font-medium leading-[1.65] text-text-secondary">{children}</p>;
}

function FollowupBody({ payload }: { payload: FollowupEvidence }) {
  const { t } = useTranslation();
  const examples = payload.sampled_examples ?? [];
  return (
    <>
      <Summary>{t("profile.evidence.followup.summary", { count: payload.count })}</Summary>
      {examples.length > 0 && (
        <>
          <p className="mt-1.5 text-[11px] leading-[1.6] text-text-muted">
            {t("profile.evidence.followup.sampleNote", { count: examples.length })}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {examples.map((example, index) => (
              <li key={index} className="rounded-md bg-bg-surface px-2 py-1.5">
                <p className="text-[11.3px] leading-[1.6] text-text-muted">“{example.passage}”</p>
                <p className="mt-0.5 text-[11.8px] leading-[1.6] text-text-primary">{example.question}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function LookupPatternBody({ payload }: { payload: LookupPatternEvidence }) {
  const { t } = useTranslation();
  const distribution = payload.band_distribution ?? {};
  const bands = [1, 2, 3, 4, 5].map((band) => ({ band, count: distribution[String(band)] ?? 0 }));
  const classified = bands.reduce((sum, entry) => sum + entry.count, 0);
  const words = payload.sample_words ?? [];
  return (
    <>
      <Summary>
        {t("profile.evidence.lookup.summary", {
          count: payload.count,
          repeat: Math.round((payload.repeat_lookup_rate ?? 0) * 100),
        })}
      </Summary>
      {classified > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {bands.map(({ band, count }) => (
            <li key={band} className="flex items-center gap-2">
              <span className="w-[4.5rem] shrink-0 text-[11.2px] text-text-muted">
                {t("bookDifficulty.bandName", { band })}
              </span>
              <span className="h-1.5 min-w-[2px] rounded-full bg-lavender" style={{ width: `${(count / classified) * 60}%` }} />
              <span className="text-[11px] tabular-nums text-text-placeholder">
                {t("profile.evidence.lookup.bandCount", { count })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {words.length > 0 && (
        <>
          <p className="mt-2 text-[11px] leading-[1.6] text-text-muted">
            {t("profile.evidence.lookup.sampleNote", { count: words.length })}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {words.map((word) => (
              <span key={word} className="rounded-md bg-bg-surface px-1.5 py-0.5 text-[11.3px] text-text-primary">
                {word}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function ExampleSourceBody({ payload }: { payload: ExampleSourceEvidence }) {
  const { t } = useTranslation();
  const books = payload.top_books ?? [];
  return (
    <>
      <Summary>{t("profile.evidence.exampleSource.summary", { count: books.length })}</Summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {books.map((book, index) => (
          <li key={index} className="flex items-baseline gap-2 rounded-md bg-bg-surface px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[11.8px] text-text-primary">{book.title}</span>
            <span className="shrink-0 text-[11.2px] text-text-muted">{book.author}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-text-placeholder">
              {t("profile.evidence.exampleSource.share", { share: Math.round((book.share ?? 0) * 100) })}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function ReplyPacingBody({ payload }: { payload: ReplyPacingEvidence }) {
  const { t } = useTranslation();
  return (
    <>
      <Summary>{t("profile.evidence.replyPacing.summary", { count: payload.count })}</Summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        <li className="rounded-md bg-bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text-primary">
          {t("profile.evidence.replyPacing.averageLength", {
            chars: Math.round(payload.average_question_length ?? 0),
          })}
        </li>
        <li className="rounded-md bg-bg-surface px-2 py-1.5 text-[11.5px] leading-[1.6] text-text-primary">
          {t("profile.evidence.replyPacing.singleTurn", {
            share: Math.round((payload.single_turn_share ?? 0) * 100),
          })}
        </li>
      </ul>
    </>
  );
}
