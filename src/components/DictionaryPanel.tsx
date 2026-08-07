import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Search, Download } from "lucide-react";
import { useDictionary } from "../hooks/useDictionary";
import VocabEntry from "./vocab/VocabEntry";

interface DictionaryPanelProps {
  bookId: string;
  bookTitle?: string;
  onNavigate?: (cfi: string) => void;
  initialWordCfi?: string | null;
  onWordDetailClosed?: () => void;
  onExport?: () => void;
}

export default function DictionaryPanel({ bookId, bookTitle, onNavigate, initialWordCfi, onWordDetailClosed, onExport }: DictionaryPanelProps) {
  const { t } = useTranslation();
  const [dictSearch, setDictSearch] = useState("");
  const [debouncedDictSearch, setDebouncedDictSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { words, remove: removeWord } = useDictionary(bookId);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedDictSearch(dictSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [dictSearch]);

  // Arriving from a marker in the text opens that word straight away.
  useEffect(() => {
    if (!initialWordCfi) return;
    const word = words.find((item) => item.cfi === initialWordCfi);
    if (word) {
      setExpandedId(word.id);
      onWordDetailClosed?.();
    }
  }, [initialWordCfi, words, onWordDetailClosed]);

  const filteredWords = useMemo(() => {
    if (!debouncedDictSearch) return words;
    const query = debouncedDictSearch.toLowerCase();
    return words.filter((w) =>
      [w.word, w.definition, w.context_sentence, bookTitle]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query))
    );
  }, [words, debouncedDictSearch, bookTitle]);

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      {/* One 45px toolbar row, matching the other traces tabs. The panel used to
          repeat its own "生词" title under the tab that already says it. */}
      <div className="flex h-[45px] shrink-0 items-center gap-2 px-3">
        <div className="flex h-[28px] flex-1 items-center gap-1.5 rounded-md bg-bg-input px-2">
          <Search size={12} className="text-text-muted shrink-0" />
          <input
            type="search"
            placeholder={t("vocab.searchPanel")}
            defaultValue=""
            onInput={(e) => setDictSearch((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.stopPropagation()}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="flex-1 text-[12px] text-text-primary bg-transparent outline-none placeholder:text-text-placeholder [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <button onClick={onExport} title={t("readerExport.open")} aria-label={t("readerExport.open")} className="grid size-8 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-bg-input hover:text-text-primary">
          <Download size={16} />
        </button>
      </div>

      {/* Word list */}
      <div className="flex-1 overflow-auto">
        {filteredWords.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4">
            <div className="size-12 rounded-full bg-bg-input flex items-center justify-center mb-3">
              <BookOpen size={20} className="text-text-muted" />
            </div>
            <p className="text-[14px] text-text-muted text-center">
              {words.length === 0 ? t("vocab.panelEmpty") : t("vocab.noMatches")}
            </p>
            {words.length === 0 && (
              <p className="text-[12px] text-text-muted text-center mt-1">
                {t("vocab.panelEmptySub")}
              </p>
            )}
          </div>
        ) : (
          filteredWords.map((word) => (
            <VocabEntry
              key={word.id}
              word={word}
              bookTitle={bookTitle}
              className="mx-3 mb-2 w-[calc(100%-1.5rem)]"
              expanded={expandedId === word.id}
              onToggle={() => setExpandedId((current) => (current === word.id ? null : word.id))}
              onDelete={() => removeWord(word.id)}
              onOpenInReader={word.cfi ? () => onNavigate?.(word.cfi!) : undefined}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-4 pt-[11px] pb-3 shrink-0">
        <p className="text-[11px] text-text-muted tracking-[0.06px] text-center">
          {t("vocab.wordCount", { count: filteredWords.length })}
        </p>
      </div>
    </div>
  );
}
