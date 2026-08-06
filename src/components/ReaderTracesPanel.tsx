import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import BookmarksPanel from "./BookmarksPanel";
import DictionaryPanel from "./DictionaryPanel";
import ReaderNotesRail from "./ReaderNotesRail";
import type { TracesTab } from "../pages/reader/side-panel";

interface ReaderTracesPanelProps {
  tab: TracesTab;
  onTabChange: (tab: TracesTab) => void;
  bookmarksProps: ComponentProps<typeof BookmarksPanel>;
  vocabProps: ComponentProps<typeof DictionaryPanel>;
  notesProps: ComponentProps<typeof ReaderNotesRail>;
}

/**
 * 痕迹 (traces): the merger of what used to be three separately-toggled
 * panels — bookmarks, vocab, notes — into one docked panel with tabs. Each
 * tab still mounts only its own component (unmounting the others), the same
 * "one active at a time" behavior the three had before the merge; this panel
 * only adds the tab bar that switches between them.
 */
export default function ReaderTracesPanel({ tab, onTabChange, bookmarksProps, vocabProps, notesProps }: ReaderTracesPanelProps) {
  const { t } = useTranslation();

  const tabButtonClass = (active: boolean) => `flex-1 h-[45px] text-[14px] font-medium tracking-[-0.15px] cursor-pointer transition-colors ${
    active ? "text-text-primary border-b-2 border-accent" : "text-text-muted hover:text-text-body"
  }`;

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      <div className="flex border-b border-border shrink-0">
        <button type="button" onClick={() => onTabChange("bookmarks")} className={tabButtonClass(tab === "bookmarks")}>
          {t("bookmarks.tab.bookmarks")}
        </button>
        <button type="button" onClick={() => onTabChange("vocab")} className={tabButtonClass(tab === "vocab")}>
          {t("reader.search.scope.vocab")}
        </button>
        <button type="button" onClick={() => onTabChange("notes")} className={tabButtonClass(tab === "notes")}>
          {t("readerNotes.title")}
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {tab === "bookmarks" && <BookmarksPanel {...bookmarksProps} />}
        {tab === "vocab" && <DictionaryPanel {...vocabProps} />}
        {tab === "notes" && <ReaderNotesRail {...notesProps} />}
      </div>
    </div>
  );
}
