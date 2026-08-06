import { useTranslation } from "react-i18next";
import type { PassiveVocabSettings } from "../passive-vocab";
import { resolveInBookPreviewPlan, type InBookPreviewSentence } from "./in-book-preview";

export interface InBookPreviewProps {
  word: string;
  definition: string;
  mastery: string | null | undefined;
  contextSentence: string | null | undefined;
  passiveVocab: PassiveVocabSettings;
  /** Same field `selectPassiveVocab` checks before annotating anything in the text. */
  cfi: string | null | undefined;
}

/**
 * The hairline dotted rule stage two actually ships on the page — copied
 * verbatim from `markerStyleSheet` in `passive-vocab.ts` rather than
 * re-derived, so this preview and the real annotation can never drift apart.
 */
const markerStyle: React.CSSProperties = {
  borderBottom: "1px dotted currentColor",
  borderBottomColor: "color-mix(in srgb, currentColor 45%, transparent)",
};

function Sentence({ sentence, children }: { sentence: InBookPreviewSentence; children?: React.ReactNode }) {
  return (
    <span className="min-w-0 font-serif text-[14px] leading-[1.9] text-text-body">
      {sentence.before}
      {children ?? sentence.answer}
      {sentence.after}
    </span>
  );
}

/**
 * A read-only card showing what this word looks like in the reader right now
 * — no legend, no caption explaining the rule. The mastery chip above it and
 * this preview are meant to be read as the same fact stated twice, once as a
 * label and once as a picture; see docs/impls/vocab-in-book-preview-mockup.html.
 */
export default function InBookPreview({ word, definition, mastery, contextSentence, passiveVocab, cfi }: InBookPreviewProps) {
  const { t } = useTranslation();
  const plan = resolveInBookPreviewPlan(passiveVocab, mastery, definition, contextSentence, word, cfi);

  if (plan.kind === "off") {
    return (
      <div className="mt-2.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-center text-[12px] text-text-muted">
        {t("vocab.inBookPreview.annotationsOff")}
      </div>
    );
  }

  return (
    <div className="mt-2.5 flex items-baseline gap-2.5 rounded-lg border border-border bg-bg-muted px-3 py-2.5">
      <span className="shrink-0 pt-0.5 text-[10px] tracking-[0.4px] text-text-muted">
        {t("vocab.inBookPreview.label")}
      </span>
      {plan.kind === "definition" && plan.style === "margin" ? (
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="w-[74px] shrink-0 border-r border-border pr-2 text-right font-sans text-[9.5px] leading-[1.9] text-accent-text">
            {plan.label}
          </span>
          <Sentence sentence={plan.sentence} />
        </div>
      ) : plan.kind === "definition" ? (
        <Sentence sentence={plan.sentence}>
          <ruby>
            {plan.sentence.answer}
            <rt className="font-sans text-[9.5px] font-medium text-accent-text">{plan.label}</rt>
          </ruby>
        </Sentence>
      ) : plan.kind === "marker" ? (
        <Sentence sentence={plan.sentence}>
          <span style={markerStyle}>{plan.sentence.answer}</span>
        </Sentence>
      ) : (
        <Sentence sentence={plan.sentence} />
      )}
    </div>
  );
}
