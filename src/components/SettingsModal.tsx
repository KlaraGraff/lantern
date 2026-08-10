import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X, ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import GeneralSettings from "./settings/GeneralSettings";
import ProfileContent from "./ProfileContent";
import ReadingSettings from "./settings/ReadingSettings";
import LearningSettings from "./settings/LearningSettings";
import ServicesSettings from "./settings/ServicesSettings";
import AutoAnalysisSettings from "./settings/AutoAnalysisSettings";
import ToolsSettings, { type ToolsPreviewState } from "./settings/ToolsSettings";
import CardPreview from "./settings/CardPreview";
import PassiveVocabPreview, { type PassiveVocabPreviewState } from "./settings/PassiveVocabPreview";
import LibrarySettings from "./settings/LibrarySettings";
import McpSettings from "./settings/McpSettings";
import AboutSettings from "./settings/AboutSettings";
import Toast from "./ui/Toast";
import ErrorBoundary from "./ErrorBoundary";
import { LANGUAGE_OPTIONS } from "./settings/languageOptions";
import {
  groupSettingsRootRows,
  SETTINGS_ROOT_GROUPS,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTIONS,
  type SettingsRootGroup,
  type SettingsRootRow,
} from "./settings/settings-sections";
import { useSettings } from "../hooks/useSettings";
import { isNarrowNow, useIsNarrow } from "../hooks/useIsNarrow";
import { platform } from "../services/platform";
import { focusFirstElement, trapTabKey } from "./focus-trap";
import type { SettingsSection, SettingsView } from "./settings-destination";

export type { SettingsSection } from "./settings-destination";

const XL_PREVIEW_QUERY = "(min-width: 1280px)";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Undefined is `"root"` — no section was asked for. See `SettingsRoot`. */
  initialSection?: SettingsSection;
  initialView?: SettingsView;
}

/**
 * Whether this platform has the thing a section configures. Consulted in three
 * places — the nav list, the initial section, and the reopen effect — so that a
 * section the platform lacks cannot be reached by a deep link either.
 */
function isSectionAvailable(id: SettingsSection): boolean {
  if (id === "mcp") return platform.hasMcpIntegration;
  return true;
}

function availableSection(id: SettingsSection): SettingsSection {
  return isSectionAvailable(id) ? id : "general";
}

/**
 * Which level the modal opens on. `null` is the root list, which only the
 * narrow layout has: asked for no section in particular, a desktop window opens
 * 通用 exactly as it always has, and a phone opens the list of sections.
 *
 * Read once, off `isNarrowNow()` rather than the subscribed hook, so that
 * dragging a window across 768px does not throw away the level the reader is on.
 */
function initialLevel(section: SettingsSection | undefined): SettingsSection | null {
  if (section) return availableSection(section);
  return isNarrowNow() ? null : "general";
}

/**
 * The root row, and the button it is. Height follows the input device and not
 * the width — 56px under a finger, 40px under a mouse — because the row *is*
 * the hot zone. That is deliberately the opposite of the leaf rows below it,
 * whose 73px is a density choice and stays put.
 */
const ROOT_ROW_CLASS =
  "flex w-full items-center gap-2.5 border-b border-border-light px-3 text-left text-[14px] font-medium tracking-[-0.15px] text-text-primary last:border-b-0 h-10 touch:h-14 touch:gap-3 touch:px-3.5 touch:text-[15.5px]";

const ROOT_CARD_CLASS =
  "mb-4 overflow-hidden rounded-[10px] border border-border bg-bg-surface touch:mb-[22px] touch:rounded-[14px]";

const ROOT_HEADING_CLASS =
  "px-1.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.5px] text-text-muted touch:text-[11.5px]";

/** 44px under a finger, and the 28px the same button is on a narrow window. */
const NAV_BUTTON_CLASS =
  "size-7 shrink-0 items-center justify-center rounded-[7px] text-text-secondary hover:bg-bg-input cursor-pointer touch:size-11 touch:rounded-[11px]";

export default function SettingsModal({ open, onClose, initialSection, initialView }: SettingsModalProps) {
  const { t, i18n } = useTranslation();
  const isNarrow = useIsNarrow();
  const [activeSection, setActiveSection] = useState<SettingsSection | null>(() => initialLevel(initialSection));
  const [activeView, setActiveView] = useState<SettingsView | undefined>(initialView);
  const [toolsPreview, setToolsPreview] = useState<ToolsPreviewState | null>(null);
  const [passiveVocabPreview, setPassiveVocabPreview] = useState<PassiveVocabPreviewState | null>(null);
  const { settings, loading, refresh, save, saveBulk } = useSettings();
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const previewPreviousFocusRef = useRef<HTMLElement | null>(null);
  const previewDismissRef = useRef<(() => void) | null>(null);
  const overlayPreviewRef = useRef(false);
  const subPageBackRef = useRef<(() => void) | null>(null);
  const levelBackRef = useRef<(() => void) | null>(null);
  const toolsNavigationGuardRef = useRef<((action: () => void) => void) | null>(null);
  const onCloseRef = useRef(onClose);
  const [isXlViewport, setIsXlViewport] = useState(() => window.matchMedia(XL_PREVIEW_QUERY).matches);
  // One docked pane, whichever section raised it: a third column at xl, an
  // overlay below that.
  const previewOpen = toolsPreview !== null || passiveVocabPreview !== null;
  const dismissPreview = toolsPreview?.onDismiss ?? passiveVocabPreview?.onDismiss ?? null;
  const overlayPreviewOpen = previewOpen && !isXlViewport;
  // Which preview, if any, Escape belongs to. Below xl the pane covers the page
  // and is a genuine overlay, so it always goes first. Docked at xl it is page
  // content: the card designer's preview is opt-in and still claims Escape, but
  // a preview a sub-page opened by itself must not swallow the way out.
  const escapePreviewDismiss = overlayPreviewOpen ? dismissPreview : toolsPreview?.onDismiss ?? null;
  const setSubPageBack = useCallback((back: (() => void) | null) => {
    subPageBackRef.current = back;
  }, []);
  const setToolsNavigationGuard = useCallback((guard: ((action: () => void) => void) | null) => {
    toolsNavigationGuardRef.current = guard;
  }, []);
  const requestClose = useCallback(() => {
    const close = () => onCloseRef.current();
    if (toolsNavigationGuardRef.current) {
      toolsNavigationGuardRef.current(close);
    } else {
      close();
    }
  }, []);
  const requestSection = (section: SettingsSection) => {
    if (section === activeSection) return;
    const changeSection = () => setActiveSection(section);
    if (toolsNavigationGuardRef.current) {
      toolsNavigationGuardRef.current(changeSection);
    } else {
      changeSection();
    }
  };
  /** Push a root row onto its own level. Guarded like any other navigation. */
  const requestRow = (row: SettingsRootRow) => {
    const push = () => {
      setActiveSection(row.section);
      setActiveView(row.view);
    };
    if (toolsNavigationGuardRef.current) {
      toolsNavigationGuardRef.current(push);
    } else {
      push();
    }
  };
  /** Pop back to the root list — the same guard the close button goes through. */
  const requestRoot = useCallback(() => {
    const pop = () => {
      setActiveSection(null);
      setActiveView(undefined);
    };
    if (toolsNavigationGuardRef.current) {
      toolsNavigationGuardRef.current(pop);
    } else {
      pop();
    }
  }, []);

  // Toast state
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const toastTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showSavedToast = (msg = t("settings.saved")) => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToastMessage(msg);
    setShowToast(true);
    toastTimeout.current = setTimeout(() => setShowToast(false), 1500);
  };

  useEffect(() => {
    if (open) setActiveSection(initialLevel(initialSection));
  }, [open, initialSection]);

  useEffect(() => {
    if (open) setActiveView(initialView);
  }, [open, initialView]);

  useEffect(() => {
    if (!open || activeSection !== "tools") setToolsPreview(null);
  }, [activeSection, open]);

  useEffect(() => {
    if (!open || activeSection !== "reading") setPassiveVocabPreview(null);
  }, [activeSection, open]);

  useEffect(() => {
    const query = window.matchMedia(XL_PREVIEW_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setIsXlViewport(event.matches);
    setIsXlViewport(query.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    previewDismissRef.current = escapePreviewDismiss;
    overlayPreviewRef.current = overlayPreviewOpen;
  }, [escapePreviewDismiss, overlayPreviewOpen]);

  useEffect(() => {
    levelBackRef.current = isNarrow && activeSection !== null ? requestRoot : null;
  }, [isNarrow, activeSection, requestRoot]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    window.requestAnimationFrame(() => {
      focusFirstElement(modal);
    });
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Layered, outermost first: an overlay preview, then a settings
        // sub-page, then a pushed section on the narrow layout, then the
        // modal itself. Every step past the first goes through the
        // unsaved-changes guard, which is why none of them call setState here.
        const dismiss = previewDismissRef.current;
        const back = subPageBackRef.current;
        const popLevel = levelBackRef.current;
        if (dismiss) {
          dismiss();
        } else if (back) {
          back();
        } else if (popLevel) {
          popLevel();
        } else {
          requestClose();
        }
        return;
      }
      if (e.key !== "Tab" || !modal) return;
      // An overlay preview is a layer on top of the modal, so the ring narrows
      // to it while it is up.
      trapTabKey(e, overlayPreviewRef.current ? previewRef.current : modal, { parkWhenEmpty: true });
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open, requestClose]);

  useEffect(() => {
    if (!overlayPreviewOpen) return;
    previewPreviousFocusRef.current = document.activeElement as HTMLElement | null;
    const animationFrame = window.requestAnimationFrame(() => previewCloseRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(animationFrame);
      const previousFocus = previewPreviousFocusRef.current;
      previewPreviousFocusRef.current = null;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [overlayPreviewOpen]);

  // AI save state (must be before early return)
  const [aiDirty, setAiDirty] = useState(false);
  const aiSaveRef = useRef<(() => void) | null>(null);

  if (!open) return null;

  // The desktop sidebar: one row per section, read off the same table the
  // narrow root list reads (`settings-sections`), so a section cannot exist on
  // one surface and be missing from the other. Order, icon, group and copy all
  // come from there; what stays here is the translation, which needs `t`, and
  // the platform question, which needs `platform`.
  //
  // Same three-way grouping as the narrow root list (`SETTINGS_ROOT_GROUPS`):
  // "core"/"misc" carry no heading, "ai" and "library" do.
  const allSections: { id: SettingsSection; label: string; subtitle: string; paneSubtitle?: string; icon: LucideIcon; group: SettingsRootGroup }[] =
    SETTINGS_SECTION_ORDER.map((id) => {
      const meta = SETTINGS_SECTIONS[id];
      return {
        id,
        label: t(meta.labelKey),
        subtitle: t(
          typeof meta.subtitleKey === "function"
            ? meta.subtitleKey({ hasOcr: platform.hasOcr })
            : meta.subtitleKey,
        ),
        paneSubtitle: meta.paneSubtitleKey ? t(meta.paneSubtitleKey) : undefined,
        icon: meta.icon,
        group: meta.group,
      };
    });

  const sections = allSections.filter((s) => isSectionAvailable(s.id));
  const sectionLabel = (id: SettingsSection) => allSections.find((s) => s.id === id)?.label ?? "";

  // Above `md:` this is always a section; the root list is the narrow layout's
  // alone, so the desktop dialog keeps opening on 通用 with nothing asked for.
  const desktopSection: SettingsSection = activeSection ?? "general";

  const settingsProps = { settings, loading, refresh, save, saveBulk, showSavedToast };

  /**
   * Wrapped per section rather than once around the modal: the sidebar, the
   * close button and the whole app behind them stay usable when one panel
   * dies, and the section id as the reset key means picking another section
   * clears the failure without the user pressing anything.
   */
  const renderContent = (section: SettingsSection): ReactNode => (
    <ErrorBoundary
      scope="region"
      resetKey={section}
      onDismiss={requestClose}
      dismissLabel={t("errorBoundary.closeSettings")}
    >
      {renderSection(section)}
    </ErrorBoundary>
  );

  const renderSection = (section: SettingsSection): ReactNode => {
    switch (section) {
      case "general": return <GeneralSettings {...settingsProps} />;
      // Renders the same full-page component the old 用户画像 sidebar row used
      // to (docs/impls/home-ia-consolidation.md step 2) — a container swap
      // only, its internals are untouched. It carries its own header, which is
      // why the desktop pane header is suppressed for this section below.
      case "personal": return <ProfileContent embedded />;
      case "reading": return (
        <ReadingSettings
          {...settingsProps}
          initialView={activeView}
          onPassiveVocabPreviewChange={setPassiveVocabPreview}
          onSubPageChange={setSubPageBack}
        />
      );
      case "learning": return <LearningSettings {...settingsProps} />;
      case "services": return (
        <ServicesSettings
          {...settingsProps}
          onDirtyChange={setAiDirty}
          onSaveRef={(fn) => { aiSaveRef.current = fn; }}
          initialView={activeView}
        />
      );
      case "autoAnalysis": return <AutoAnalysisSettings />;
      case "tools": return (
        <ToolsSettings
          {...settingsProps}
          onPreviewChange={setToolsPreview}
          onNavigationGuardChange={setToolsNavigationGuard}
        />
      );
      case "library": return <LibrarySettings {...settingsProps} />;
      case "mcp": return <McpSettings {...settingsProps} />;
      case "about": return <AboutSettings />;
    }
  };

  const saveAction = (
    <button
      onClick={() => aiSaveRef.current?.()}
      disabled={!aiDirty}
      className={`text-[13px] font-medium px-3 py-1 rounded-lg cursor-pointer transition-colors ${
        aiDirty
          ? "text-accent-text hover:bg-accent-bg"
          : "text-text-muted/40 cursor-default"
      }`}
    >
      {t("common.save")}
    </button>
  );

  if (isNarrow) {
    const rootGroups = groupSettingsRootRows((row) => isSectionAvailable(row.section));
    const rootRows = rootGroups.flatMap((group) => group.rows);
    const rowLabel = (row: SettingsRootRow) => (row.labelKey ? t(row.labelKey) : sectionLabel(row.section));
    // Only the summaries already sitting in `settings` — the asynchronous ones
    // (last sync, source count, provider status) arrive with their own stages.
    const rowValue = (row: SettingsRootRow): string | undefined => {
      if (row.id === "general") {
        const language = settings.language || i18n.language;
        return LANGUAGE_OPTIONS.find((option) => option.value === language)?.label;
      }
      return undefined;
    };

    const atRoot = activeSection === null;
    // The row that was tapped, so the nav bar can be titled with the row's own
    // name rather than its section's — 对话模型 and 语音 share a section. A deep
    // link that named no row (Cmd+`,`, the reader's 生词辅助 link) falls through
    // to the row that owns the section, and then to the section's own name.
    const openRow = activeSection === null
      ? undefined
      : rootRows.find((row) => row.section === activeSection && row.view === activeView)
        ?? rootRows.find((row) => row.section === activeSection && row.view === undefined)
        ?? rootRows.find((row) => row.section === activeSection);
    const title = activeSection === null
      ? t("settings.title")
      : openRow
        ? rowLabel(openRow)
        : sectionLabel(activeSection);

    return (
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        tabIndex={-1}
        className={`motion-scrim fixed inset-0 z-50 flex flex-col pl-safe-left pr-safe-right ${
          atRoot ? "bg-bg-page" : "bg-bg-surface"
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Nav bar. The root list carries its own grey page colour up to the
              top edge under a finger; a narrow window keeps the ruled bar it
              shares with every other level. */}
          <div
            className={`shrink-0 pt-safe-top ${
              atRoot
                ? "border-b border-border bg-bg-surface touch:border-b-0 touch:bg-transparent"
                : "border-b border-border bg-bg-surface"
            }`}
          >
            <div className="flex items-center gap-1 px-3 pb-2.5">
              <button
                type="button"
                onClick={atRoot ? requestClose : requestRoot}
                aria-label={atRoot ? t("common.close") : t("common.back")}
                title={atRoot ? t("common.close") : t("common.back")}
                className={`${NAV_BUTTON_CLASS} ${atRoot ? "hidden touch:flex" : "flex"}`}
              >
                <ChevronLeft className="size-4 touch:size-[22px]" />
              </button>
              <h2 className="min-w-0 flex-1 truncate pl-1 text-[18px] font-semibold tracking-[-0.3px] text-text-primary touch:text-[21px]">
                {title}
              </h2>
              {activeSection === "services" && saveAction}
              <button
                type="button"
                onClick={requestClose}
                aria-label={t("common.close")}
                title={t("common.close")}
                className={`${NAV_BUTTON_CLASS} flex touch:hidden`}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pb-safe-bottom">
            {activeSection === null ? (
              <div className="px-4 pt-3.5">
                {rootGroups.map((group) => (
                  <div key={group.id}>
                    {group.headingKey && <p className={ROOT_HEADING_CLASS}>{t(group.headingKey)}</p>}
                    <div className={ROOT_CARD_CLASS}>
                      {group.rows.map((row) => {
                        // The skeleton is the finished layout with the words
                        // taken out, so nothing moves when SQLite answers.
                        if (loading) {
                          return (
                            <div key={row.id} className={ROOT_ROW_CLASS} aria-hidden="true">
                              <span
                                className="h-3 rounded-md bg-bg-input"
                                style={{ width: row.skeletonWidth }}
                              />
                            </div>
                          );
                        }
                        // The row's own icon where it has one (服务配置's two
                        // rows), its section's otherwise — resolved in
                        // `settings-sections`, not here.
                        const Icon = row.icon;
                        const value = rowValue(row);
                        return (
                          <button
                            key={row.id}
                            type="button"
                            onClick={() => requestRow(row)}
                            className={`${ROOT_ROW_CLASS} cursor-pointer hover:bg-bg-input`}
                          >
                            <Icon className="size-4 shrink-0 text-text-muted touch:size-[19px]" />
                            <span className="truncate">{rowLabel(row)}</span>
                            <span className="ml-auto max-w-[150px] truncate pl-2 text-[13px] font-normal text-text-muted touch:text-[14px]">
                              {value}
                            </span>
                            <ChevronRight className="size-3.5 shrink-0 text-text-muted/55 touch:size-4" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-4">{renderContent(activeSection)}</div>
            )}
          </div>
        </div>

        {showToast && <Toast>{toastMessage}</Toast>}
      </div>
    );
  }

  const active = sections.find((s) => s.id === desktopSection);

  return (
    <div
      className="motion-scrim fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        tabIndex={-1}
        className={`motion-dialog relative flex max-h-[760px] overflow-hidden rounded-lg border border-border bg-white shadow-[0px_25px_50px_-12px_rgba(0,0,0,0.25)] dark:bg-bg-surface ${
          previewOpen
            ? "w-[min(780px,calc(100vw_-_32px))] xl:w-[min(1400px,calc(100vw_-_32px))]"
            : "w-[min(780px,calc(100vw_-_32px))]"
        }`}
        style={{
          height: "min(80dvh, 760px)",
          minHeight: "min(480px, calc(100dvh - 32px))",
        }}
      >
        <div
          inert={overlayPreviewOpen ? true : undefined}
          aria-hidden={overlayPreviewOpen ? true : undefined}
          className="flex shrink-0 flex-col overflow-hidden sm:flex-row"
          style={{ width: "min(780px, calc(100vw - 32px))" }}
        >
          {/* Sidebar */}
          <div className="max-h-[148px] shrink-0 overflow-y-auto border-b border-border bg-bg-muted sm:max-h-none sm:w-[220px] sm:border-b-0 sm:border-r">
            <p className="text-[13px] font-semibold text-text-primary px-4 pt-4 pb-2">
              {t("settings.title")}
            </p>
            <nav className="grid grid-cols-2 gap-0.5 px-2 pb-2 sm:flex sm:flex-col sm:pb-0">
              {sections.map((section, index) => {
                const Icon = section.icon;
                const isActive = desktopSection === section.id;
                // Same three-way grouping as the narrow root list: "core"
                // (first) and "misc" (last) carry no heading of their own.
                const headingKey = section.group !== sections[index - 1]?.group
                  ? SETTINGS_ROOT_GROUPS.find((g) => g.id === section.group)?.headingKey
                  : undefined;
                return (
                  <div key={section.id} className="contents">
                    {headingKey && (
                      <p className="col-span-2 px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.5px] text-text-muted sm:px-3">
                        {t(headingKey)}
                      </p>
                    )}
                    <button
                      onClick={() => requestSection(section.id)}
                      className={`flex h-[44px] w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left transition-colors sm:h-[56px] sm:gap-3 sm:rounded-[8px] sm:px-3 ${
                        isActive ? "bg-accent-bg" : "hover:bg-bg-input"
                      }`}
                    >
                      <Icon
                        size={16}
                        className={`shrink-0 ${isActive ? "text-accent-text" : "text-text-muted"}`}
                      />
                      <div className="flex-1 min-w-0">
                        <p className={`text-[14px] font-medium leading-[20px] tracking-[-0.15px] ${
                          isActive ? "text-accent-text" : "text-text-secondary"
                        }`}>
                          {section.label}
                        </p>
                        <p className={`hidden text-[11px] font-medium leading-[16px] tracking-[0.06px] truncate sm:block ${
                          isActive ? "text-accent-text/60" : "text-text-muted"
                        }`}>
                          {section.subtitle}
                        </p>
                      </div>
                      <ChevronRight
                        size={14}
                        className={`shrink-0 ${isActive ? "text-accent-text" : "text-text-muted/40"}`}
                      />
                    </button>
                  </div>
                );
              })}
            </nav>
          </div>

          {/* Content */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Header actions */}
            <div className="flex items-center justify-end gap-2 pr-3 pt-3">
              {desktopSection === "services" && saveAction}
              <button
                onClick={requestClose}
                aria-label={t("common.close")}
                title={t("common.close")}
                className="size-7 flex items-center justify-center rounded-[10px] hover:bg-bg-input cursor-pointer"
              >
                <X size={16} className="text-text-muted" />
              </button>
            </div>

            {/* Scrollable content */}
            <div
              className="flex-1 overflow-y-scroll px-6"
              style={{ scrollbarGutter: "stable" }}
            >
              {/* Pane header — title + subtitle, then a rule with room
                  below it. Suppressed for About, which leads with its
                  centered identity card, and for Personal, which renders
                  `ProfileContent` verbatim — that component carries its own
                  full header (title, subtitle, actions). */}
              {desktopSection !== "about" && desktopSection !== "personal" && (
                <div className="flex flex-col gap-1">
                  <h3 className="text-[18px] font-semibold text-text-primary">
                    {active?.label}
                  </h3>
                  <p className="text-[13px] text-text-muted">
                    {active?.paneSubtitle ?? active?.subtitle}
                  </p>
                  <div className="mt-3 h-px bg-border-light mb-2" />
                </div>
              )}

              {renderContent(desktopSection)}
            </div>
          </div>
        </div>

        {previewOpen && (
          <aside
            ref={previewRef}
            role={overlayPreviewOpen ? "dialog" : undefined}
            aria-modal={overlayPreviewOpen ? true : undefined}
            aria-label={toolsPreview ? t("settings.tools.preview") : t("settings.passiveVocab.preview")}
            tabIndex={overlayPreviewOpen ? -1 : undefined}
            className="absolute inset-y-0 left-0 right-0 z-20 flex min-h-0 flex-col overflow-hidden border-l border-border bg-bg-surface p-4 shadow-[-12px_0_30px_rgba(0,0,0,0.12)] md:left-auto md:w-[min(680px,calc(100vw_-_260px))] xl:static xl:z-auto xl:min-w-[420px] xl:flex-1 xl:shadow-none"
            style={{ scrollbarGutter: "stable" }}
          >
            <div className="mb-2 flex shrink-0 justify-end">
              <button
                ref={previewCloseRef}
                type="button"
                onClick={() => dismissPreview?.()}
                aria-label={t("common.close")}
                title={t("common.close")}
                className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-input"
              >
                <X size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {toolsPreview ? (
                <CardPreview
                  kind={toolsPreview.kind}
                  config={toolsPreview.config}
                  explanationLanguage={toolsPreview.explanationLanguage}
                  targetLanguage={toolsPreview.targetLanguage}
                  learnerLevel={toolsPreview.learnerLevel}
                  explanationMode={toolsPreview.explanationMode}
                  showMenu={toolsPreview.showMenu}
                  lastTouched={toolsPreview.lastTouched}
                  testText={toolsPreview.testText}
                  testNonce={toolsPreview.testNonce}
                  customActionTest={toolsPreview.customActionTest}
                />
              ) : passiveVocabPreview ? (
                <PassiveVocabPreview style={passiveVocabPreview.style} limit={passiveVocabPreview.limit} />
              ) : null}
            </div>
          </aside>
        )}
      </div>

      {/* Toast */}
      {showToast && (
        <Toast>{toastMessage}</Toast>
      )}
    </div>
  );
}
