import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import {
  passiveVocabCount,
  type PassiveVocabDensity,
  type PassiveVocabStyle,
} from "../passive-vocab";

export interface PassiveVocabPreviewState {
  style: PassiveVocabStyle;
  density: PassiveVocabDensity;
  onDismiss: () => void;
}

/**
 * The mock page always paints the "paper" reader theme, so its ink cannot come
 * from the app's light/dark tokens — on a dark UI those would put light text on
 * a light page. These two are the paper theme's own ink, fixed on purpose.
 */
const PAPER_INK = "#3f3a33";
const PAPER_INK_MUTED = "#8b7f6b";

const PREVIEW_LINES = [1, 2, 3] as const;

/** One sample line, split around the word that carries a saved definition. */
function splitLine(line: string, word: string) {
  const at = line.indexOf(word);
  if (at < 0) return { before: line, word: "", after: "" };
  return { before: line.slice(0, at), word, after: line.slice(at + word.length) };
}

/**
 * A live sample of the reader page, rendered in whichever style and density is
 * currently selected. Density reuses the reader's own `passiveVocabCount`, so
 * the sample thins out exactly the way a real page does instead of following a
 * second, invented rule.
 */
export default function PassiveVocabPreview({ style, density }: { style: PassiveVocabStyle; density: PassiveVocabDensity }) {
  const { t } = useTranslation();
  const annotated = passiveVocabCount(PREVIEW_LINES.length, density);
  const margin = style === "margin";

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-text-primary">{t("settings.passiveVocab.preview")}</p>
        <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success-text">
          {t("settings.passiveVocab.previewSynced")}
        </span>
      </div>
      <div
        className="rounded-[10px] border border-black/10 px-5 py-6"
        style={{ backgroundColor: "var(--color-reader-paper-bg)", color: PAPER_INK }}
      >
        <p className="mb-4 text-center font-serif text-[17px] font-semibold leading-[26px]">
          {t("settings.passiveVocab.previewHeading")}
        </p>
        {/* The margin style is a grid so the rail reads as one continuous
            rule: the rows carry their spacing as padding, not as a gap that
            would break the border between them. */}
        <div className={margin ? "grid grid-cols-[1fr_88px] gap-x-3" : "flex flex-col gap-2.5"}>
          {PREVIEW_LINES.map((index) => {
            const word = t(`settings.passiveVocab.previewWord${index}`);
            const gloss = t(`settings.passiveVocab.previewGloss${index}`);
            const line = splitLine(t(`settings.passiveVocab.previewLine${index}`), word);
            const showGloss = index <= annotated && line.word !== "";
            return (
              <Fragment key={index}>
                <p className={`min-w-0 font-serif text-[14px] leading-[26px] ${margin ? "py-[5px]" : ""}`}>
                  {line.before}
                  {line.word !== "" && (
                    margin || !showGloss ? (
                      <span className={showGloss ? "underline decoration-dotted underline-offset-4" : undefined}>{line.word}</span>
                    ) : (
                      // Without ruby-align the gloss is spread across the whole
                      // width of a long word, reading as letter-spaced.
                      <ruby className="underline decoration-dotted underline-offset-4 [ruby-align:center]">
                        {line.word}
                        <rt className="font-sans text-[8px] font-medium leading-none" style={{ color: PAPER_INK_MUTED }}>
                          {gloss}
                        </rt>
                      </ruby>
                    )
                  )}
                  {line.after}
                </p>
                {margin && (
                  <span
                    className="border-l py-[5px] pl-2 text-[10px] leading-[18px]"
                    style={{ borderColor: "rgba(0,0,0,0.12)", color: PAPER_INK_MUTED }}
                  >
                    {showGloss ? gloss : ""}
                  </span>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
      <p className="text-[11px] leading-[17px] text-text-muted">{t("settings.passiveVocab.previewHint")}</p>
    </div>
  );
}
