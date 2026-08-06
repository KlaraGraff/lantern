import { forwardRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ApiKeyFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * The one field in settings that is typed by pasting, and the one whose
 * contents cannot be checked by reading them back.
 *
 * **Why it is not `Input` with `type="password"`.** Pasting a key on a phone
 * goes wrong often — a character short, a trailing space, the clipboard holding
 * the thing before the key — and every one of those failures surfaces minutes
 * later as `401 invalid api key`, with nothing on screen to compare against.
 * The eye is what turns that into something the reader can see. It appears
 * under `touch:` only: a mouse-driven window keeps the plain masked field it
 * has today, because whether desktop should reveal keys in a room with other
 * people in it is a separate question from whether a thumb can paste.
 *
 * Revealing lasts for this editing session and no longer. The state lives in
 * the component, so leaving the page — or collapsing the card — re-masks by
 * unmounting, with nothing to remember to reset.
 *
 * 48px tall and 16px under touch: anything under 16px makes iOS zoom the page
 * in on focus and never zoom back out. `src/index.css` already floors every
 * field at 16px for that reason; this one says it locally too, because a field
 * that silently depends on a global rule is one refactor from breaking.
 */
const ApiKeyField = forwardRef<HTMLInputElement, ApiKeyFieldProps>(
  ({ value, onChange, placeholder, disabled, className = "" }, ref) => {
    const { t } = useTranslation();
    const [revealed, setRevealed] = useState(false);

    return (
      <div className={`relative ${className}`}>
        <input
          ref={ref}
          type={revealed ? "text" : "password"}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="new-password"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="h-9 w-full rounded-lg border border-border bg-bg-surface px-3 font-mono text-[14px] tracking-[-0.15px] text-text-primary outline-none placeholder:font-sans placeholder:text-text-placeholder focus:border-accent touch:h-12 touch:pr-12 touch:text-[16px]"
        />
        <button
          type="button"
          onClick={() => setRevealed((shown) => !shown)}
          aria-pressed={revealed}
          title={revealed ? t("settings.ai.hideKey") : t("settings.ai.showKey")}
          aria-label={revealed ? t("settings.ai.hideKey") : t("settings.ai.showKey")}
          className={`absolute right-0 top-0 hidden h-full w-11 items-center justify-center rounded-r-lg touch:flex ${
            revealed ? "text-accent-text" : "text-text-muted"
          }`}
        >
          {revealed ? <Eye size={17} /> : <EyeOff size={17} />}
        </button>
      </div>
    );
  },
);

ApiKeyField.displayName = "ApiKeyField";

export default ApiKeyField;
