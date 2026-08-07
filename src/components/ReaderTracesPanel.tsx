import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import BookmarksPanel from "./BookmarksPanel";
import HighlightsPanel from "./HighlightsPanel";
import DictionaryPanel from "./DictionaryPanel";
import ReaderNotesRail from "./ReaderNotesRail";
import PanelTabs, { type PanelTab } from "./ui/PanelTabs";
import type { TracesTab } from "../pages/reader/side-panel";

interface ReaderTracesPanelProps {
  tab: TracesTab;
  onTabChange: (tab: TracesTab) => void;
  bookmarksProps: ComponentProps<typeof BookmarksPanel>;
  highlightsProps: ComponentProps<typeof HighlightsPanel>;
  vocabProps: ComponentProps<typeof DictionaryPanel>;
  notesProps: ComponentProps<typeof ReaderNotesRail>;
}

/**
 * 痕迹 (traces): the merger of what used to be separately-toggled panels —
 * bookmarks, highlights, vocab, notes — into one docked panel with tabs. Each
 * tab still mounts only its own component (unmounting the others), the same
 * "one active at a time" behavior they had before the merge.
 *
 * The four are one flat row. Highlights previously sat in a second tab bar
 * nested under bookmarks, so the panel showed "书签" containing "书签", and the
 * two stacked 45px bars cost as much vertical space as a list row. Flattening
 * removed both problems without having to invent a parent name for the pair.
 */
export default function ReaderTracesPanel({ tab, onTabChange, bookmarksProps, highlightsProps, vocabProps, notesProps }: ReaderTracesPanelProps) {
  const { t } = useTranslation();

  const tabs: readonly PanelTab<TracesTab>[] = [
    { id: "bookmarks", label: t("reader.traces.tab.bookmarks") },
    { id: "highlights", label: t("reader.traces.tab.highlights") },
    { id: "vocab", label: t("reader.traces.tab.vocab") },
    { id: "notes", label: t("reader.traces.tab.notes") },
  ];

  return (
    <div className="flex h-full flex-col bg-bg-muted">
      <PanelTabs tabs={tabs} active={tab} onChange={onTabChange} label={t("reader.traces.tabsLabel")} />
      <div className="min-h-0 flex-1">
        {tab === "bookmarks" && <BookmarksPanel {...bookmarksProps} />}
        {tab === "highlights" && <HighlightsPanel {...highlightsProps} />}
        {tab === "vocab" && <DictionaryPanel {...vocabProps} />}
        {tab === "notes" && <ReaderNotesRail {...notesProps} />}
      </div>
    </div>
  );
}
