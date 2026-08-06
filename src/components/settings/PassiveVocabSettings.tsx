import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Minus, PanelRightOpen, Plus } from "lucide-react";
import Toggle from "../ui/Toggle";
import { nextRadioIndex } from "../ui/radio-group";
import {
  PASSIVE_VOCAB_MAX_LIMIT,
  PASSIVE_VOCAB_MIN_LIMIT,
  formatPassiveVocabSummary,
  parsePassiveVocabSettings,
  rollbackPassiveVocabSettings,
  updatePassiveVocabSettings,
  type PassiveVocabSettings as PassiveVocabSettingsValue,
  type PassiveVocabStyle,
} from "../passive-vocab";
import type { PassiveVocabPreviewState } from "./PassiveVocabPreview";
import { type SettingsProps } from "./types";
import { notifyReadingAssistanceSettingsChanged } from "../reading-assistance-events";

interface PassiveVocabSettingsProps extends SettingsProps {
  /** Back to the reading list. This view is a swap inside the section, not a route. */
  onBack: () => void;
  onPreviewChange?: (preview: PassiveVocabPreviewState | null) => void;
}

const STYLES: PassiveVocabStyle[] = ["ruby", "margin"];

/**
 * Arrow keys move and select inside a radio group, and focus follows the
 * selection. Focus is found by asking the group for its radios rather than by
 * index into its children, so wrapping either group in a layout element later
 * cannot quietly break the keyboard.
 */
function handleRadioKeys<T>(
  event: KeyboardEvent<HTMLButtonElement>,
  options: T[],
  current: T,
  select: (value: T) => void,
) {
  const next = nextRadioIndex(event.key, options.indexOf(current), options.length);
  if (next === null) return;
  event.preventDefault();
  select(options[next]);
  const group = event.currentTarget.closest('[role="radiogroup"]');
  group?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}

/** A grey bar standing in for a line of body text in the style illustrations. */
function TextBar({ className }: { className: string }) {
  return <span className={`block h-[3px] rounded-full bg-black/15 dark:bg-white/20 ${className}`} />;
}

function RubyIllustration({ word, gloss }: { word: string; gloss: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-black/5 px-3 py-3" style={{ backgroundColor: "var(--color-reader-paper-bg)" }}>
      <TextBar className="w-full" />
      <span className="flex items-end gap-1.5" style={{ color: "#3f3a33" }}>
        <TextBar className="mb-[5px] w-8" />
        <ruby className="font-serif text-[11px] leading-[13px] underline decoration-dotted underline-offset-2 [ruby-align:center]">
          {word}
          <rt className="text-[7px] font-medium leading-none" style={{ color: "#8b7f6b" }}>{gloss}</rt>
        </ruby>
        <TextBar className="mb-[5px] w-10" />
      </span>
      <TextBar className="w-2/3" />
    </div>
  );
}

function MarginIllustration({ gloss }: { gloss: string }) {
  return (
    <div className="flex items-stretch gap-2 rounded-md border border-black/5 px-3 py-3" style={{ backgroundColor: "var(--color-reader-paper-bg)" }}>
      <span className="flex flex-1 flex-col gap-2 pt-[6px]">
        <TextBar className="w-full" />
        <span className="flex items-center gap-1.5">
          <TextBar className="w-10" />
          <span className="h-[3px] w-8 rounded-full bg-black/30" />
          <TextBar className="w-6" />
        </span>
        <TextBar className="w-2/3" />
      </span>
      <span className="flex w-[46px] shrink-0 items-start border-l border-black/15 pl-1.5 text-[8px] leading-[12px]" style={{ color: "#8b7f6b" }}>
        {gloss}
      </span>
    </div>
  );
}

export default function PassiveVocabSettings({
  settings,
  saveBulk,
  showSavedToast,
  onBack,
  onPreviewChange,
}: PassiveVocabSettingsProps) {
  const { t } = useTranslation();
  const [passive, setPassive] = useState<PassiveVocabSettingsValue>(() => parsePassiveVocabSettings(settings));
  const [saveFailed, setSaveFailed] = useState(false);
  // The preview is the point of this page, so it starts open rather than
  // waiting to be asked for the way the card designer's does.
  const [previewOpen, setPreviewOpen] = useState(true);
  const revision = useRef(0);

  useEffect(() => {
    setPassive(parsePassiveVocabSettings(settings));
    setSaveFailed(false);
  }, [settings]); // Settings events also make the reader shortcut update this form.

  useEffect(() => {
    if (!onPreviewChange) return;
    if (!passive.enabled || !previewOpen) {
      onPreviewChange(null);
      return;
    }
    onPreviewChange({
      style: passive.style,
      limit: passive.limit,
      onDismiss: () => setPreviewOpen(false),
    });
  }, [onPreviewChange, passive.enabled, passive.limit, passive.style, previewOpen]);

  useEffect(() => () => onPreviewChange?.(null), [onPreviewChange]);

  const update = (patch: Partial<PassiveVocabSettingsValue>) => {
    const mutation = updatePassiveVocabSettings(passive, patch);
    const request = ++revision.current;
    setSaveFailed(false);
    setPassive(mutation.next);
    void saveBulk(mutation.values)
      .then(() => {
        void notifyReadingAssistanceSettingsChanged(Object.keys(mutation.values)).catch((error) => {
          console.error("Failed to notify passive vocabulary settings change:", error);
        });
        showSavedToast();
      })
      .catch((error) => {
        console.error("Failed to save passive vocabulary settings:", error);
        if (request === revision.current) {
          setPassive((current) => rollbackPassiveVocabSettings(current, mutation));
          setSaveFailed(true);
        }
      });
  };

  return (
    <div className="w-full min-w-0 pb-8">
      <nav aria-label={t("settings.passiveVocab.breadcrumb")} className="flex items-center gap-0.5 text-[11px] text-text-muted">
        <span>{t("settings.title")}</span>
        <ChevronRight size={12} className="shrink-0 opacity-60" />
        <button
          type="button"
          onClick={onBack}
          title={t("settings.passiveVocab.back")}
          className="rounded px-1 py-0.5 hover:bg-bg-input hover:text-text-primary"
        >
          {t("settings.reading.title")}
        </button>
        <ChevronRight size={12} className="shrink-0 opacity-60" />
        <span className="text-text-secondary">{t("settings.passiveVocab.title")}</span>
      </nav>

      <h4 className="mt-2 text-[16px] font-semibold text-text-primary tracking-[-0.2px]">{t("settings.passiveVocab.title")}</h4>
      <p className="mt-1 text-[12px] leading-[18px] text-text-muted">{t("settings.passiveVocab.hint")}</p>

      {saveFailed && (
        <p role="alert" className="mt-3 rounded-md bg-danger-bg px-3 py-2 text-[12px] text-danger-text">
          {t("settings.passiveVocab.saveFailed")}
        </p>
      )}

      {/* Master switch */}
      <div className="mt-4 overflow-hidden rounded-[10px] border border-border">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-bg font-serif text-[15px] font-semibold text-accent-text">
            Aa
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.passiveVocab.masterTitle")}</p>
            <p className="mt-0.5 text-[12px] text-text-muted">{formatPassiveVocabSummary(passive, (key, params) => t(key, params))}</p>
          </div>
          <Toggle
            label={t("settings.passiveVocab.masterTitle")}
            checked={passive.enabled}
            onChange={(enabled) => update({ enabled })}
          />
        </div>
        <p className="border-t border-border-light bg-bg-muted px-4 py-2.5 text-[11px] leading-[17px] text-text-muted">
          {t("settings.passiveVocab.syncNote")}
        </p>
      </div>

      {passive.enabled ? (
        <>
          {/* Display style */}
          <div className="mt-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-text-primary">{t("settings.passiveVocab.style")}</p>
                <p className="mt-0.5 text-[11px] leading-[17px] text-text-muted">{t("settings.passiveVocab.styleHint")}</p>
              </div>
              {onPreviewChange && !previewOpen && (
                <button
                  type="button"
                  onClick={() => setPreviewOpen(true)}
                  title={t("settings.passiveVocab.showPreview")}
                  aria-label={t("settings.passiveVocab.showPreview")}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-text-primary"
                >
                  <PanelRightOpen size={15} />
                </button>
              )}
            </div>
            <div role="radiogroup" aria-label={t("settings.passiveVocab.style")} className="mt-3 grid gap-3 sm:grid-cols-2">
              {STYLES.map((style) => {
                const selected = passive.style === style;
                return (
                  <button
                    key={style}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={t(style === "ruby" ? "settings.passiveVocab.styleRuby" : "settings.passiveVocab.styleMargin")}
                    tabIndex={selected ? 0 : -1}
                    onKeyDown={(event) => handleRadioKeys(event, STYLES, passive.style, (value) => update({ style: value }))}
                    onClick={() => update({ style })}
                    className={`flex flex-col gap-3 rounded-[10px] border p-3 text-left transition-colors ${
                      selected ? "border-accent bg-accent-bg/40" : "border-border hover:bg-bg-input"
                    }`}
                  >
                    {style === "ruby" ? (
                      <RubyIllustration word={t("settings.passiveVocab.previewWord1")} gloss={t("settings.passiveVocab.previewGloss1")} />
                    ) : (
                      <MarginIllustration gloss={t("settings.passiveVocab.previewGloss1")} />
                    )}
                    <span className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex size-[14px] shrink-0 items-center justify-center rounded-full border ${
                          selected ? "border-accent" : "border-border"
                        }`}
                      >
                        {selected && <span className="size-[7px] rounded-full bg-accent" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-text-primary">
                          {t(style === "ruby" ? "settings.passiveVocab.styleRuby" : "settings.passiveVocab.styleMargin")}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-[17px] text-text-muted">
                          {t(style === "ruby" ? "settings.passiveVocab.styleRubyHint" : "settings.passiveVocab.styleMarginHint")}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* How many definitions one screen may carry */}
          <div className="mt-6 border-t border-border-light pt-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-text-primary">{t("settings.passiveVocab.limit")}</p>
                <p className="mt-0.5 text-[11px] leading-[17px] text-text-muted">{t("settings.passiveVocab.limitHint")}</p>
              </div>
              {/* A count, not a density: the reader is choosing how many
                  definitions they will actually see, so the control shows the
                  number itself rather than three relative words. */}
              <div className="flex shrink-0 items-center gap-1 rounded-lg bg-bg-input p-1">
                <button
                  type="button"
                  onClick={() => update({ limit: passive.limit - 1 })}
                  disabled={passive.limit <= PASSIVE_VOCAB_MIN_LIMIT}
                  aria-label={t("settings.passiveVocab.limitFewer")}
                  title={t("settings.passiveVocab.limitFewer")}
                  className="flex size-[30px] items-center justify-center rounded-md text-text-secondary hover:bg-bg-surface hover:text-text-primary disabled:opacity-35 disabled:hover:bg-transparent"
                >
                  <Minus size={14} />
                </button>
                <span
                  role="status"
                  aria-label={t("settings.passiveVocab.limit")}
                  className="min-w-[36px] text-center text-[14px] font-semibold text-text-primary tabular-nums"
                >
                  {passive.limit}
                </span>
                <button
                  type="button"
                  onClick={() => update({ limit: passive.limit + 1 })}
                  disabled={passive.limit >= PASSIVE_VOCAB_MAX_LIMIT}
                  aria-label={t("settings.passiveVocab.limitMore")}
                  title={t("settings.passiveVocab.limitMore")}
                  className="flex size-[30px] items-center justify-center rounded-md text-text-secondary hover:bg-bg-surface hover:text-text-primary disabled:opacity-35 disabled:hover:bg-transparent"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
            {/* The three stages, stated once. Without this the marker stage
                looks like a bug the first time a definition turns into a dotted
                line on its own. */}
            <ul className="mt-3 grid gap-1.5 rounded-md bg-bg-input px-3 py-2.5">
              <li className="text-[11px] leading-[17px] text-text-muted">{t("settings.passiveVocab.stageDefinition")}</li>
              <li className="text-[11px] leading-[17px] text-text-muted">{t("settings.passiveVocab.stageMarker")}</li>
              <li className="text-[11px] leading-[17px] text-text-muted">{t("settings.passiveVocab.stageNone")}</li>
            </ul>
          </div>

          {/* Privacy */}
          <div className="mt-5 rounded-md bg-bg-input px-3 py-2.5">
            <p className="text-[11px] font-medium text-text-secondary">{t("settings.passiveVocab.privacyTitle")}</p>
            <p className="mt-0.5 text-[11px] leading-[17px] text-text-muted">{t("settings.passiveVocab.privacyBody")}</p>
          </div>
        </>
      ) : (
        <p className="mt-4 text-[11px] leading-[17px] text-text-muted">{t("settings.passiveVocab.disabledHint")}</p>
      )}
    </div>
  );
}
