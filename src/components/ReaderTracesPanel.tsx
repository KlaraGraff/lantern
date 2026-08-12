import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import DictionaryPanel from "./DictionaryPanel";
import ReaderNotesPanel from "./ReaderNotesPanel";
import ReaderXrayPanel from "./ReaderXrayPanel";
import PanelTabs, { type PanelTab } from "./ui/PanelTabs";
import type { TracesTab } from "../pages/reader/side-panel";

interface ReaderTracesPanelProps {
  tab: TracesTab;
  onTabChange: (tab: TracesTab) => void;
  notesProps: ComponentProps<typeof ReaderNotesPanel>;
  vocabProps: ComponentProps<typeof DictionaryPanel>;
  xrayProps: ComponentProps<typeof ReaderXrayPanel>;
}

/**
 * 划线笔记 / "Highlights & Notes" (internal id: traces): everything the reader
 * left in this book, docked in one panel
 * with three tabs — 笔记, 生词, 语境. Each tab mounts only its own component,
 * the "one active at a time" behaviour they have always had.
 *
 * There used to be five. 书签 and 划线 were separate tabs beside 笔记, which
 * asked the reader to know which of the three had produced the thing they were
 * looking for before they could go look for it. They are one list now — see
 * `ReaderNotesPanel` — and the three that remain are three genuinely different
 * questions: what I marked, what I looked up, what this book has said so far.
 *
 * Unmounting 语境 on a tab change is fine and deliberate: its safe-scope
 * results are memoized in a module-level cache inside the panel, so reopening
 * the tab on the same subject restores it without another AI call.
 */
export default function ReaderTracesPanel({ tab, onTabChange, notesProps, vocabProps, xrayProps }: ReaderTracesPanelProps) {
  const { t } = useTranslation();

  const tabs: readonly PanelTab<TracesTab>[] = [
    { id: "notes", label: t("reader.traces.tab.notes") },
    { id: "vocab", label: t("reader.traces.tab.vocab") },
    { id: "xray", label: t("reader.traces.tab.xray") },
  ];

  return (
    <div className="flex h-full flex-col bg-bg-muted">
      <PanelTabs tabs={tabs} active={tab} onChange={onTabChange} label={t("reader.traces.tabsLabel")} />
      <div className="min-h-0 flex-1">
        {tab === "notes" && <ReaderNotesPanel {...notesProps} />}
        {tab === "vocab" && <DictionaryPanel {...vocabProps} />}
        {tab === "xray" && <ReaderXrayPanel {...xrayProps} />}
      </div>
    </div>
  );
}
