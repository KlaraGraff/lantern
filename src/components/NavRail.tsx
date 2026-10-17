import { useTranslation } from "react-i18next";
import { BarChart3, GraduationCap, House, MessageCircleQuestion, Search, StickyNote, type LucideIcon } from "lucide-react";
import LanternLogo from "./LanternLogo";
import { platform } from "../services/platform";
import { memoRowBadgeCount } from "./sidebar-badges";
import { isShelfFilter, openCommandPalette } from "./library-actions";

interface NavRailProps {
  activeFilter: string;
  onFilterChange: (filter: string) => void;
  dueForReviewCount: number;
  userName?: string;
  onOpenSettings: () => void;
}

interface Workspace {
  /** The filter a click selects. */
  filter: string;
  labelKey: string;
  icon: LucideIcon;
  /** Whether a filter belongs to this workspace — the library owns every shelf filter. */
  owns: (filter: string) => boolean;
}

const WORKSPACES: readonly Workspace[] = [
  { filter: "all", labelKey: "nav.library", icon: House, owns: isShelfFilter },
  { filter: "vocab", labelKey: "nav.learn", icon: GraduationCap, owns: (f) => f === "vocab" },
  { filter: "notes", labelKey: "sidebar.notes", icon: StickyNote, owns: (f) => f === "notes" },
  { filter: "qa", labelKey: "sidebar.qa", icon: MessageCircleQuestion, owns: (f) => f === "qa" },
  { filter: "stats", labelKey: "nav.stats", icon: BarChart3, owns: (f) => f === "stats" },
];

/**
 * The library window's navigation on a desktop: 64px of icons that say which
 * workspace you are in (design v2 §5). It replaced the text `Sidebar`, which
 * now lives on only as the phone drawer. The shelf's own filters moved into
 * the shelf as chips (`ShelfChips`); search and commands are ⌘K.
 */
export default function NavRail({ activeFilter, onFilterChange, dueForReviewCount, userName, onOpenSettings }: NavRailProps) {
  const { t } = useTranslation();
  const initials = userName
    ? userName.split(" ").map((part) => part[0]).join("").toUpperCase().slice(0, 2)
    : "R";

  return (
    <nav
      aria-label={t("nav.label")}
      className="relative flex h-full w-16 shrink-0 select-none flex-col items-center gap-1 border-r border-border bg-bg-muted pb-3.5"
    >
      {platform.hasTitleBarInset && <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-titlebar" />}
      {/* Under the traffic lights on macOS, where they take the whole width of
          the rail; at the window's own top edge everywhere else. */}
      <div className={`${platform.hasTitleBarInset ? "pt-titlebar" : "pt-3.5"} mb-3`}>
        <div className="size-7 overflow-hidden rounded-lg border border-border">
          <LanternLogo size={28} className="block object-cover" />
        </div>
      </div>

      {WORKSPACES.map(({ filter, labelKey, icon: Icon, owns }) => {
        const current = owns(activeFilter);
        const badge = filter === "vocab" ? memoRowBadgeCount("vocab", dueForReviewCount) : null;
        const label = t(labelKey);
        return (
          <button
            key={filter}
            type="button"
            aria-current={current ? "page" : undefined}
            aria-label={badge !== null ? `${label} · ${t("sidebar.dueForReviewBadge", { count: badge })}` : undefined}
            title={badge !== null ? t("sidebar.dueForReviewBadge", { count: badge }) : undefined}
            onClick={() => onFilterChange(filter)}
            className={`relative flex h-12 w-[52px] cursor-pointer flex-col items-center justify-center gap-[3px] rounded-[9px] text-[10px] font-semibold transition-colors duration-[var(--motion-instant)] ${
              current
                ? "bg-bg-surface text-accent-text shadow-sm"
                : "text-text-secondary hover:bg-bg-surface/70 hover:text-text-primary"
            }`}
          >
            <Icon size={18} strokeWidth={2} aria-hidden="true" />
            <span className="max-w-full truncate px-0.5">{label}</span>
            {badge !== null && (
              <span aria-hidden="true" className="absolute right-[9px] top-[7px] size-1.5 rounded-full bg-accent" />
            )}
          </button>
        );
      })}

      <div className="flex-1" />

      <button
        type="button"
        onClick={openCommandPalette}
        aria-label={t("nav.search")}
        title={t("nav.search")}
        className="flex h-11 w-[52px] cursor-pointer flex-col items-center justify-center gap-[3px] rounded-[9px] text-[10px] text-text-secondary transition-colors duration-[var(--motion-instant)] hover:bg-bg-surface/70 hover:text-text-primary"
      >
        <Search size={18} aria-hidden="true" />
        <span>{platform.id === "macos" ? "⌘K" : "Ctrl K"}</span>
      </button>
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label={t("settings.title")}
        title={userName ? `${userName} · ${t("settings.title")}` : t("settings.title")}
        className="mt-1.5 flex size-[30px] cursor-pointer items-center justify-center rounded-full bg-text-primary font-serif text-[12px] font-semibold text-bg-page transition-transform duration-[var(--motion-instant)] hover:scale-105"
      >
        {initials}
      </button>
    </nav>
  );
}
