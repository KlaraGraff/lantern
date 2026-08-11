import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import Button from "../ui/Button";
import type { InjectionPreview } from "../../hooks/useProfile";

/**
 * 「AI 现在这样理解你」 — the assembled block that actually leaves the app.
 *
 * The page below already shows both halves the reader can edit: their own
 * text, and the seven cards. What it never showed is the one thing that
 * reaches the model — those halves stitched together with the scaffolding
 * around them. Everything here comes from `profile_injection_preview`, which
 * calls the same `injection_block` the follow-up path calls, so this is the
 * text itself rather than a second implementation that would drift.
 *
 * Collapsed by default: on an ordinary visit the reader is here to edit the
 * profile, not to read a prompt. The count and the state line are enough to
 * tell them whether anything is going out at all.
 */
interface InjectionPreviewBlockProps {
  preview: InjectionPreview | null;
  /** The profile switch, so "nothing is going out" can say *why*. */
  enabled: boolean;
}

export default function InjectionPreviewBlock({ preview, enabled }: InjectionPreviewBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // A failed preview fetch leaves the rest of the page working — showing a
  // broken block about what the AI knows would be worse than showing none.
  if (!preview) return null;

  const text = preview.text;

  return (
    <section className="mb-6 rounded-xl border border-soft-lilac bg-bg-muted p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={14} className="shrink-0 text-text-secondary" />
        <h2 className="text-[13px] font-semibold tracking-tight text-text-primary">
          {t("profile.injection.heading")}
        </h2>
        <span className="flex-1" />
        {text !== null && (
          <>
            <span className="text-[11.2px] tabular-nums text-text-muted">
              {t("profile.injection.count", { count: preview.charCount })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {expanded ? t("profile.collapse") : t("profile.injection.reveal")}
            </Button>
          </>
        )}
      </div>

      <p className="mt-1 text-[11.8px] leading-[1.65] text-text-muted">
        {text === null
          ? enabled
            ? t("profile.injection.emptyProfile")
            : t("profile.injection.switchedOff")
          : t("profile.injection.subtitle")}
      </p>

      {expanded && text !== null && (
        <>
          <pre className="mt-2 max-h-[340px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-light bg-bg-surface p-2.5 text-[11.5px] leading-[1.75] text-text-primary">
            {text.trim()}
          </pre>
          {/* The scaffolding around the reader's own words is written in
              English on purpose — the model reads it, the reader normally
              never does. Saying so here keeps the block from looking like a
              language bug. */}
          <p className="mt-1.5 text-[10.8px] leading-[1.6] text-text-placeholder">
            {t("profile.injection.scaffoldingNote")}
          </p>
        </>
      )}
    </section>
  );
}
