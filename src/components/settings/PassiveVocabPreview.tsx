import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import { type PassiveVocabStage, type PassiveVocabStyle } from "../passive-vocab";

export interface PassiveVocabPreviewState {
  style: PassiveVocabStyle;
  limit: number;
  onDismiss: () => void;
}

/**
 * The mock page always paints the "paper" reader theme, so its ink cannot come
 * from the app's light/dark tokens — on a dark UI those would put light text on
 * a light page. These two are the paper theme's own ink, fixed on purpose.
 */
const PAPER_INK = "#3f3a33";
const PAPER_INK_MUTED = "#8b7f6b";

/**
 * The sample page carries one line per thing worth showing: two words still
 * being learned (which the limit thins), one the reader nearly knows, and one
 * they have finished with. The last two are the point of the sample — without
 * them, a marker appearing in a real book looks like a rendering bug.
 */
const PREVIEW_LINES: ReadonlyArray<{ index: number; stage: PassiveVocabStage }> = [
  { index: 1, stage: "definition" },
  { index: 2, stage: "definition" },
  { index: 3, stage: "marker" },
  { index: 4, stage: "none" },
];

const GLOSSABLE_PREVIEW_LINES = PREVIEW_LINES.filter((line) => line.stage === "definition").length;

/** One sample line, split around the word that carries a saved definition. */
function splitLine(line: string, word: string) {
  const at = line.indexOf(word);
  if (at < 0) return { before: line, word: "", after: "" };
  return { before: line.slice(0, at), word, after: line.slice(at + word.length) };
}

/**
 * A live sample of the reader page in whichever style is selected, showing all
 * three stages at once: a gloss, a bare marker, and a word that has gone quiet.
 * Only the gloss stage answers to the limit — the marker is what a word steps
 * *down* to on its own, so capping it would contradict the page it previews.
 */
export default function PassiveVocabPreview({ style, limit }: { style: PassiveVocabStyle; limit: number }) {
  const { t } = useTranslation();
  const glossed = Math.min(limit, GLOSSABLE_PREVIEW_LINES);
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
          {PREVIEW_LINES.map(({ index, stage }, position) => {
            const word = t(`settings.passiveVocab.previewWord${index}`);
            const gloss = t(`settings.passiveVocab.previewGloss${index}`);
            const line = splitLine(t(`settings.passiveVocab.previewLine${index}`), word);
            // A gloss line past the limit keeps its word but loses its note —
            // it does not fall back to a marker, exactly as a real page.
            const showGloss = stage === "definition" && position < glossed && line.word !== "";
            const showMarker = stage === "marker" && line.word !== "";
            return (
              <Fragment key={index}>
                <p className={`min-w-0 font-serif text-[14px] leading-[26px] ${margin ? "py-[5px]" : ""}`}>
                  {line.before}
                  {line.word !== "" && (
                    margin || !showGloss ? (
                      <span
                        className={showMarker ? "underline decoration-dotted underline-offset-4 decoration-[1px]" : undefined}
                        title={showMarker ? gloss : undefined}
                      >
                        {line.word}
                      </span>
                    ) : (
                      // Without ruby-align the gloss is spread across the whole
                      // width of a long word, reading as letter-spaced.
                      <ruby className="[ruby-align:center]">
                        {line.word}
                        <rt className="font-sans text-[7px] font-normal leading-none" style={{ color: PAPER_INK_MUTED }}>
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
