import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import DictionaryPanel from "./DictionaryPanel";
import ReaderChapterPanel from "./ReaderChapterPanel";
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
  /** Wide only: 「本章」 and the way back to it from a whole-book list. */
  chapterProps?: ComponentProps<typeof ReaderChapterPanel>;
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
 * On a wide screen the panel opens on 「本章」 instead (`ReaderChapterPanel`,
 * design §12): this chapter's traces as one list, with these three tabs one
 * link away as the whole book's.
 *
 * Unmounting 语境 on a tab change is fine and deliberate: its safe-scope
 * results are memoized in a module-level cache inside the panel, so reopening
 * the tab on the same subject restores it without another AI call.
 */
export default function ReaderTracesPanel({ tab, onTabChange, notesProps, vocabProps, xrayProps, chapterProps }: ReaderTracesPanelProps) {
  const { t } = useTranslation();

  if (tab === "chapter" && chapterProps) {
    return (
      <div className="flex h-full flex-col bg-bg-muted">
        <ReaderChapterPanel {...chapterProps} />
      </div>
    );
  }

  const tabs: readonly PanelTab<TracesTab>[] = [
    { id: "notes", label: t("reader.traces.tab.notes") },
    { id: "vocab", label: t("reader.traces.tab.vocab") },
    { id: "xray", label: t("reader.traces.tab.xray") },
  ];

  return (
    <div className="flex h-full flex-col bg-bg-muted">
      {chapterProps && (
        <button
          type="button"
          onClick={() => onTabChange("chapter")}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 px-4 pt-2.5 text-[12px] text-text-muted hover:text-text-primary"
        >
          <ArrowLeft size={13} />
          {t("reader.side.chapter")}
        </button>
      )}
      <PanelTabs tabs={tabs} active={tab === "chapter" ? "notes" : tab} onChange={onTabChange} label={t("reader.traces.tabsLabel")} />
      <div className="min-h-0 flex-1">
        {(tab === "notes" || tab === "chapter") && <ReaderNotesPanel {...notesProps} />}
        {tab === "vocab" && <DictionaryPanel {...vocabProps} />}
        {tab === "xray" && <ReaderXrayPanel {...xrayProps} />}
      </div>
    </div>
  );
}
