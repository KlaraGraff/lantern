export interface PanelTab<T extends string> {
  id: T;
  label: string;
}

interface PanelTabsProps<T extends string> {
  tabs: readonly PanelTab<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Names the group for screen readers — the panel's own name, not a tab's. */
  label: string;
}

/**
 * The docked side panel's tab switcher: one inset pill track, the active tab a
 * raised chip.
 *
 * It replaces a row of `flex-1` buttons carrying a 2px accent underline. Those
 * read as page-level navigation, which is wrong twice over here — the panel is
 * a control surface, not a page, and the bookmarks tab used to stack a second,
 * visually identical row underneath it, so the reader saw "书签" nested inside
 * "书签". The nesting is gone (all four are siblings now) and this component is
 * the one switcher both the traces panel and the AI panel share, so the same
 * dock slot never shows two different tab designs.
 *
 * Sized to fit four tabs at the panel's 320px minimum: a two-character CJK
 * label or "Highlights" both clear it.
 */
export default function PanelTabs<T extends string>({ tabs, active, onChange, label }: PanelTabsProps<T>) {
  return (
    <div className="shrink-0 px-3 py-2">
      <div
        role="tablist"
        aria-label={label}
        className="grid h-[30px] gap-0.5 rounded-full bg-bg-input p-[3px]"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(tab.id)}
              className={`cursor-pointer truncate rounded-full px-1 text-[13px] font-medium tracking-[-0.1px] transition-colors ${
                selected
                  ? "bg-bg-surface text-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-black/5"
                  : "text-text-muted hover:text-text-body"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
