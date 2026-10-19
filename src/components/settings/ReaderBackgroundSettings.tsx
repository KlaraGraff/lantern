import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, Trash2 } from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import Slider from "../ui/Slider";
import {
  DEFAULT_READER_BACKGROUND_OPACITY,
  READER_BACKGROUND_OPACITY_MAX,
  READER_BACKGROUND_OPACITY_MIN,
  type ReaderBackground,
} from "../reader-settings";

interface ReaderBackgroundSettingsProps {
  background: ReaderBackground | null;
  /** The theme's paper color — what the picture is laid over in the reader. */
  pageColor: string;
  onChange: (next: ReaderBackground | null) => void;
}

/**
 * 背景图片: one picture behind the page, faded into the theme's paper color.
 * Picking copies the file into the app's own data (`import_reader_background`),
 * so the setting keeps working after the original is moved.
 */
export default function ReaderBackgroundSettings({ background, pageColor, onChange }: ReaderBackgroundSettingsProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The slider moves this; the setting is written once the drag ends.
  const [draftOpacity, setDraftOpacity] = useState(background?.opacity ?? DEFAULT_READER_BACKGROUND_OPACITY);
  useEffect(() => {
    setDraftOpacity(background?.opacity ?? DEFAULT_READER_BACKGROUND_OPACITY);
  }, [background?.opacity]);

  const pick = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await invoke<string | null>("import_reader_background");
      if (path) onChange({ path, opacity: background?.opacity ?? DEFAULT_READER_BACKGROUND_OPACITY });
    } catch (cause) {
      console.error("Failed to import reader background:", cause);
      setError(t("settings.layout.backgroundImportFailed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    onChange(null);
    try {
      await invoke("clear_reader_background");
    } catch (cause) {
      // The setting is already off; a file left behind is replaced on the next pick.
      console.error("Failed to delete reader background:", cause);
    } finally {
      setBusy(false);
    }
  };

  const buttonClass = "flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] font-medium text-text-secondary hover:bg-bg-input disabled:opacity-50 touch:h-11";

  return (
    <div className="border-b border-border-light py-3">
      <div className="flex items-center justify-between gap-4 min-h-[49px]">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.background")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.backgroundHint")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {background && (
            <span
              aria-hidden
              data-testid="reader-background-thumb"
              className="relative h-8 w-12 overflow-hidden rounded-md border border-border"
              style={{ backgroundColor: pageColor }}
            >
              <span
                className="absolute inset-0 bg-cover bg-center"
                style={{ backgroundImage: `url("${convertFileSrc(background.path)}")`, opacity: draftOpacity / 100 }}
              />
            </span>
          )}
          <button type="button" disabled={busy} onClick={() => void pick()} className={buttonClass}>
            <ImagePlus size={13} />
            {background ? t("settings.layout.backgroundReplace") : t("settings.layout.backgroundChoose")}
          </button>
          {background && (
            <button
              type="button"
              disabled={busy}
              title={t("settings.layout.backgroundRemove")}
              aria-label={t("settings.layout.backgroundRemove")}
              onClick={() => void remove()}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-text-primary disabled:opacity-50 touch:size-11"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      {background && (
        <div className="mt-3">
          {/* Shown as transparency, the word everyone knows; stored as opacity. */}
          <Slider
            min={100 - READER_BACKGROUND_OPACITY_MAX}
            max={100 - READER_BACKGROUND_OPACITY_MIN}
            step={5}
            value={100 - draftOpacity}
            label={t("settings.layout.backgroundOpacity")}
            displayValue={`${100 - draftOpacity}%`}
            hint={t("settings.layout.backgroundOpacityHint")}
            onChange={(transparency) => setDraftOpacity(100 - transparency)}
            onChangeEnd={(transparency) => {
              const opacity = 100 - transparency;
              if (opacity !== background.opacity) onChange({ ...background, opacity });
            }}
          />
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[11px] leading-4 text-danger-text">{error}</p>}
    </div>
  );
}
