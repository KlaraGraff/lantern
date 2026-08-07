import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

interface DetailedHintProps {
  /** The one-line version. Always visible, and written to stand on its own. */
  hint: string;
  /** The precise version: what the short line had to leave out. */
  detail: string;
  className?: string;
}

/**
 * A settings hint that stays short, with the full version behind a disclosure.
 *
 * The rows this sits in explain features whose hard part is a concept, not a
 * word — an embeddings endpoint, matching by meaning. Simplifying the wording
 * does not make those land, and spelling them out in the row buries the one
 * sentence most people need. So the row keeps the short line and the concept
 * waits until someone asks for it.
 *
 * Native `<details>` rather than component state: it comes with the keyboard
 * and screen-reader behaviour already, and the reader's PDF error screen
 * already discloses this way.
 */
export default function DetailedHint({ hint, detail, className = "" }: DetailedHintProps) {
  const { t } = useTranslation();

  return (
    <div className={className}>
      <p className="text-[11px] leading-[1.55] text-text-muted">{hint}</p>
      <details className="group mt-1">
        <summary className="inline-flex cursor-pointer list-none items-center gap-0.5 text-[11px] text-text-secondary [&::-webkit-details-marker]:hidden">
          <ChevronRight
            size={11}
            aria-hidden="true"
            className="shrink-0 transition-transform group-open:rotate-90"
          />
          {t("common.moreDetail")}
        </summary>
        <p className="mt-1 whitespace-pre-line text-[11px] leading-[1.55] text-text-muted">{detail}</p>
      </details>
    </div>
  );
}
