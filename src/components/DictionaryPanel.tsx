import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Search } from "lucide-react";
import { useDictionary } from "../hooks/useDictionary";
import VocabEntry from "./vocab/VocabEntry";

interface DictionaryPanelProps {
  bookId: string;
  bookTitle?: string;
  onNavigate?: (cfi: string) => void;
  initialWordCfi?: string | null;
  onWordDetailClosed?: () => void;
}

export default function DictionaryPanel({ bookId, bookTitle, onNavigate, initialWordCfi, onWordDetailClosed }: DictionaryPanelProps) {
  const { t } = useTranslation();
  const [dictSearch, setDictSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { words, remove: removeWord } = useDictionary(bookId);

  // Arriving from a marker in the text opens that word straight away.
  useEffect(() => {
    if (!initialWordCfi) return;
    const word = words.find((item) => item.cfi === initialWordCfi);
    if (word) {
      setExpandedId(word.id);
      onWordDetailClosed?.();
    }
  }, [initialWordCfi, words, onWordDetailClosed]);

  const filteredWords = words.filter((w) => {
    if (!dictSearch) return true;
    const query = dictSearch.toLowerCase();
    return [w.word, w.definition, w.context_sentence, bookTitle]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(query));
  });

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      <div className="border-b border-border shrink-0 px-4 h-[45px] flex items-center">
        <h2 className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
          {t("vocab.title")}
        </h2>
      </div>

      {/* Search */}
      <div className="px-4 pt-2 pb-2 shrink-0">
        <div className="flex items-center gap-1.5 h-[28px] px-2 rounded-lg bg-bg-input border border-border">
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
