import { useTranslation } from "react-i18next";
import BookSourcesSettings from "./BookSourcesSettings";
import LibrarySyncSettings from "./LibrarySyncSettings";
import { platform } from "../../services/platform";
import type { SettingsProps } from "./types";

/**
 * 书库与同步 — two blocks that used to be two sibling sections: where books
 * come from, and how the library moves between this device and the others
 * signed into the same iCloud account. `LibrarySyncSettings` still gates
 * itself off entirely on a platform with no shared-folder sync (Windows) —
 * that gate used to live in `SettingsModal`'s `isSectionAvailable`, keyed
 * off a whole section; now it hides only its own block, and 书籍来源, which
 * has no such dependency, stays visible either way.
 */
export default function LibrarySettings(props: SettingsProps) {
  const { t } = useTranslation();

  return (
    <div>
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.5px] text-text-muted">
        {t("settings.library.sourcesGroupHeader")}
      </div>
      <div className="h-px bg-border-light" />
      <BookSourcesSettings {...props} />

      {platform.hasFolderSync && (
        <>
          <div className="mt-8 mb-2 text-[11px] font-medium uppercase tracking-[0.5px] text-text-muted">
            {t("settings.library.syncGroupHeader")}
          </div>
          <div className="h-px bg-border-light" />
          <LibrarySyncSettings {...props} />
        </>
      )}
    </div>
  );
}
