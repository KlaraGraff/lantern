import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  AlertTriangle,
  ArrowLeft,
  CircleHelp,
  Loader2,
  RefreshCw,
  Route,
  Settings,
  UserRound,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CitedSource } from "../hooks/useAiChat";
import { aiErrorMessageKey, isAiRetryableError } from "../utils/aiError";
import { createUuid } from "../utils/randomUuid";
import { isAiConfigured, type AiCredentialLike, type AiProfileLike } from "./onboarding/onboarding-state";
import type { ReaderInteraction } from "./reader-interaction";
import {
  canApplyXrayLoad,
  canReuseXrayCache,
  classifyXrayLoadError,
  didXrayNavigationSucceed,
  isEmptyXrayResult,
  setBoundedCacheEntry,
  shouldContinueXrayIndexBuildingPoll,
  shouldOfferXrayUpdate,
  XRAY_INDEX_BUILDING_POLL_INTERVAL_MS,
  xrayCacheKey,
  type XrayCardResult,
} from "./xray-card";

/** Sentinel fed through the same `classifyXrayLoadError` path a real backend
 * failure takes, so the proactive "no AI provider configured" gate below
 * renders through the exact same `kind === "ai"` branch (copy, settings
 * jump, everything) as an actual `AI_NOT_CONFIGURED` error would. */
const AI_NOT_CONFIGURED_SENTINEL = "AI_NOT_CONFIGURED";

const SAFE_CACHE_LIMIT = 50;

const safeCache = new Map<string, { location: string; result: XrayCardResult }>();

interface ReaderXrayPanelProps {
  bookId: string;
  interaction: ReaderInteraction | null;
  getCurrentLocation(): string | null;
  currentChapter?: string;
  progress: number;
  /** Drop the current subject and fall back to the entry screen. The tab itself stays open. */
  onClear(): void;
  /** Resolve true only after the reader has completed the jump. */
  onNavigate(source: CitedSource): boolean | Promise<boolean>;
  /** Resolve true only after the reader has completed the jump. */
  onNavigateCurrent(location: string): boolean | Promise<boolean>;
}

type CardView = "summary" | "relations" | "confirm";

/**
 * 语境 (context): the fifth traces tab. This used to be a floating card docked
 * over the page, because as the AI panel's second tab it had no container of
 * its own and had to draw one — hence the rounded border, the shadow, the fixed
 * 386px width and the close X. As a traces tab the tab bar *is* the container,
 * so all of that chrome came off: it is a flush panel body at the panel's own
 * width, like every sibling tab.
 *
 * What the close X used to do, `onClear` does — drop the subject and fall back
 * to the entry screen. There is nothing left for it to close.
 */
export default function ReaderXrayPanel({
  bookId,
  interaction,
  getCurrentLocation,
  currentChapter,
  progress,
  onClear,
  onNavigate,
  onNavigateCurrent,
}: ReaderXrayPanelProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<XrayCardResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // Bumped on every error-state write, even one that repeats the same string
  // (`XRAY_INDEX_BUILDING` carries no variable content). The index-building
  // poll effect below depends on this instead of `errorDetail` alone so that
  // an unchanged classification still schedules the next attempt.
  const [errorVersion, setErrorVersion] = useState(0);
  const [navigationError, setNavigationError] = useState(false);
  const [navigatingKey, setNavigatingKey] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [view, setView] = useState<CardView>("summary");
  const requestRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const loadedIdentityRef = useRef<string | null>(null);
  const pollAttemptRef = useRef(0);

  const invalidateActiveRequest = useCallback(() => {
    loadGenerationRef.current += 1;
    const requestId = requestRef.current;
    requestRef.current = null;
    if (requestId) {
      void invoke("ai_cancel", { requestId }).catch(() => {});
    }
  }, []);

  const applyErrorDetail = useCallback((value: string | null) => {
    setErrorDetail(value);
    setErrorVersion((version) => version + 1);
  }, []);

  /**
   * "Configured" reuses the same definition the library hint banner and
   * onboarding use (see `isAiConfigured` in onboarding-state.ts): at least
   * one enabled, non-invalid credential attached to an enabled profile,
   * fetched from the same `ai_list_profiles` / `ai_list_credentials`
   * commands rather than a new backend query. Returns null (not false) when
   * the check itself fails, so callers fail open into the normal request
   * flow instead of blocking on a guess.
   */
  const checkAiConfigured = useCallback(async (): Promise<boolean | null> => {
    try {
      const profiles = await invoke<AiProfileLike[]>("ai_list_profiles");
      const credentialLists = await Promise.all(
        profiles.map((profile) => invoke<AiCredentialLike[]>("ai_list_credentials", { profileId: profile.id })),
      );
      return isAiConfigured(profiles, credentialLists.flat());
    } catch {
      return null;
    }
  }, []);

  const load = useCallback(async (wholeBook: boolean, ignoreCache = false) => {
    const generation = loadGenerationRef.current + 1;
    invalidateActiveRequest();
    loadGenerationRef.current = generation;
    if (!interaction) {
      setLoading(false);
      return;
    }
    const key = xrayCacheKey(bookId, interaction.text);
    const safeLocation = getCurrentLocation() || interaction.location;
    const cached = !wholeBook && !ignoreCache ? safeCache.get(key) : undefined;
    // A result generated farther ahead must never be reused after the reader
    // jumps backward. Exact-location reuse is intentionally conservative.
    if (cached && canReuseXrayCache(cached.location, safeLocation)) {
      setBoundedCacheEntry(safeCache, key, cached, SAFE_CACHE_LIMIT);
      setResult(cached.result);
      setFromCache(true);
      applyErrorDetail(null);
      setLoading(false);
      setView("summary");
      return;
    }
    setLoading(true);
    applyErrorDetail(null);
    setFromCache(false);
    // Confirm an AI provider is actually configured before firing a request
    // that is guaranteed to fail otherwise. Routed through the same
    // `classifyXrayLoadError`/`kind === "ai"` rendering path a real backend
    // `AI_NOT_CONFIGURED` takes, so there is exactly one not-configured UI.
    const configured = await checkAiConfigured();
    if (!canApplyXrayLoad(loadGenerationRef.current, generation)) return;
    if (configured === false) {
      applyErrorDetail(AI_NOT_CONFIGURED_SENTINEL);
      setLoading(false);
      return;
    }
    const requestId = createUuid();
    requestRef.current = requestId;
    try {
      const response = await invoke<XrayCardResult>("ai_xray", {
        bookId,
        entity: interaction.text,
        visibleContext: interaction.context,
        currentLocation: safeLocation || null,
        currentChapter: currentChapter ?? null,
        progress,
        spoilerOverride: wholeBook,
        requestId,
      });
      if (!canApplyXrayLoad(loadGenerationRef.current, generation)) return;
      setResult(response);
      if (!wholeBook) setBoundedCacheEntry(safeCache, key, { location: safeLocation, result: response }, SAFE_CACHE_LIMIT);
      setView("summary");
    } catch (loadError) {
      // The backend distinguishes "no AI provider configured" from "index
      // still building" from a genuine request failure — keep that detail
      // instead of collapsing everything into one "try again later" message,
      // since only some of these are fixed by waiting and retrying.
      if (canApplyXrayLoad(loadGenerationRef.current, generation)) applyErrorDetail(String(loadError));
    } finally {
      if (canApplyXrayLoad(loadGenerationRef.current, generation)) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [applyErrorDetail, bookId, checkAiConfigured, currentChapter, getCurrentLocation, interaction, invalidateActiveRequest, progress]);

  // Stable reference to the latest `load` for effects (the index-building
  // poll and the settings-focus re-check below) that must not restart their
  // timer/listener merely because `load` was recreated — e.g. `progress`
  // ticking during normal reading would otherwise reset an in-flight poll.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const identity = interaction
      ? `${xrayCacheKey(bookId, interaction.text)}\u0000${interaction.location}`
      : `${bookId}\u0000entry`;
    if (loadedIdentityRef.current === identity) return;
    loadedIdentityRef.current = identity;
    setResult(null);
    setView("summary");
    if (interaction) {
      void load(false);
    } else {
      invalidateActiveRequest();
      setLoading(false);
    }
  }, [bookId, interaction, invalidateActiveRequest, load]);

  // Auto-retry while the entity index is still building: poll quietly and
  // replace the "index building" hint the moment results come back, with no
  // action from the user. Stops — by simply not scheduling another
  // attempt — the instant the classification changes to anything else
  // (including "no error", i.e. success), when `interaction` clears, once
  // the attempt cap is reached, or when the card unmounts (effect cleanup).
  // No polling for any other error kind.
  useEffect(() => {
    if (!interaction) {
      pollAttemptRef.current = 0;
      return;
    }
    const kind = errorDetail !== null ? classifyXrayLoadError(errorDetail).kind : null;
    if (kind !== "indexBuilding") {
      pollAttemptRef.current = 0;
      return;
    }
    if (!shouldContinueXrayIndexBuildingPoll(kind, pollAttemptRef.current)) return;
    const timer = window.setTimeout(() => {
      pollAttemptRef.current += 1;
      void loadRef.current(false, true);
    }, XRAY_INDEX_BUILDING_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
    // `errorVersion` (not just `errorDetail`) is a dependency on purpose: the
    // backend's XRAY_INDEX_BUILDING message is a fixed string with no
    // variable content, so a poll attempt that lands on "still building"
    // again would otherwise never re-trigger this effect to schedule the
    // next attempt.
  }, [errorDetail, errorVersion, interaction]);

  // Re-resolve "AI not configured" on window focus and on every retry (the
  // latter falls out of the check living inside `load` itself, run above) so
  // coming back from the settings jump below clears a stale not-configured
  // screen without the user having to do anything else.
  useEffect(() => {
    const presentation = errorDetail !== null ? classifyXrayLoadError(errorDetail) : null;
    if (presentation?.aiErrorCode !== "AI_NOT_CONFIGURED") return;
    const onFocus = () => {
      void (async () => {
        if (await checkAiConfigured()) void loadRef.current(false, true);
      })();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkAiConfigured, errorDetail]);

  // No focus grab, no scroll-into-view, no Escape handler: those belonged to a
  // card that appeared over the page and had to behave like a transient popover.
  // A docked tab is none of those things — stealing focus would fight the tab
  // button that opened it, and Escape has no card left to dismiss.
  useEffect(() => {
    return invalidateActiveRequest;
  }, [invalidateActiveRequest]);

  const wholeBook = result?.scope === "wholeBook";
  const empty = result ? isEmptyXrayResult(result) : false;
  const showUpdate = result ? shouldOfferXrayUpdate(result, progress) : false;
  const KindIcon = result?.kind === "person" ? UserRound : CircleHelp;
  const error = errorDetail !== null;
  const errorPresentation = errorDetail !== null ? classifyXrayLoadError(errorDetail) : null;

  // Shared with ExplainPopover's identical "AI_NOT_CONFIGURED" screen: focus the
  // main window's Settings on the AI services tab. A cross-window Tauri event
  // rather than the same-window `openSettings()` DOM event, because a reader
  // window can be detached from main. The panel stays where it is — the focus
  // listener above re-runs the request once a provider is configured.
  const openAiSettings = useCallback(async () => {
    await invoke("open_settings_on_main", { section: "services" });
    const main = await WebviewWindow.getByLabel("main");
    await main?.setFocus();
  }, []);

  const navigate = useCallback(
    async (key: string, action: () => boolean | Promise<boolean>) => {
      if (navigatingKey) return;
      setNavigationError(false);
      setNavigatingKey(key);
      try {
        // Do not infer success from a resolved promise: a reader callback must
        // explicitly acknowledge that the target was reached. A successful jump
        // used to dismiss the card, because the card sat on top of the passage
        // it had just sent you to. Docked beside the page it obscures nothing,
        // so it stays — the way clicking a bookmark leaves the bookmarks tab up.
        if (!didXrayNavigationSucceed(await action())) setNavigationError(true);
      } catch {
        setNavigationError(true);
      } finally {
        setNavigatingKey(null);
      }
    },
    [navigatingKey],
  );

  // The subject block replaces the old card header, so it only stands in for a
  // real result — the states that render their own centered screen (entry,
  // loading, error, empty, and the whole-book confirmation) do not get one.
  const showSubject = Boolean(result) && !empty && result?.kind !== "unknown" && !loading && !error && view === "summary";
  const mentionCount = result ? result.sources.length + (interaction?.location ? 1 : 0) : 0;

  return (
    <aside
      aria-label={t("readerXray.title")}
      aria-busy={loading}
      className="flex h-full min-h-0 w-full flex-col bg-bg-muted"
    >
      {/* The same 45px row every traces tab opens with. It carries the one piece
          of state this tab has — how far into the book the answer is allowed to
          read — plus the only two actions that outlive any single view. */}
      {interaction && view !== "confirm" ? (
        <div className="flex h-[45px] shrink-0 items-center gap-2 px-3">
          <span
            className={`inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium ${
              wholeBook ? "bg-danger/10 text-danger-text" : "bg-bg-input text-text-secondary"
            }`}
          >
            <span className={`size-1.5 rounded-full ${wholeBook ? "bg-danger" : "bg-emerald-600"}`} />
            {wholeBook ? t("readerXray.scopeWholeBook") : t("readerXray.scopeSafe", { progress: result?.progress ?? progress })}
            {fromCache && !wholeBook ? <span className="text-text-muted">· {t("readerXray.cached")}</span> : null}
          </span>
          {!loading && !error ? (
            <button
              type="button"
              disabled={wholeBook}
              onClick={() => setView("confirm")}
              className="ml-auto flex h-[28px] shrink-0 items-center rounded-lg border border-border px-2.5 text-[12px] font-medium text-accent-text hover:bg-accent-bg disabled:cursor-default disabled:border-transparent disabled:text-text-muted disabled:hover:bg-transparent"
            >
              {wholeBook ? t("readerXray.wholeBookActive") : t("readerXray.viewWholeBook")}
            </button>
          ) : null}
          {showUpdate && !loading && !error ? (
            <button
              type="button"
              title={t("readerXray.update")}
              aria-label={t("readerXray.update")}
              onClick={() => void load(false, true)}
              className="grid size-7 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-bg-input hover:text-text-primary"
            >
              <RefreshCw size={16} />
            </button>
          ) : null}
        </div>
      ) : null}

      {showSubject && result ? (
        <div className={`flex shrink-0 items-start gap-3 border-b border-border px-4 pb-3.5 pt-3 ${result.kind === "term" ? "bg-[#FFF7EB]" : "bg-accent-bg"}`}>
          <KindIcon size={17} className="mt-0.5 shrink-0 text-accent-text" />
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-accent-text">
              {result.kind === "person" ? t("readerXray.person") : result.kind === "term" ? t("readerXray.term") : t("readerXray.title")}
            </div>
            <h2 className="mt-0.5 truncate text-[18px] font-semibold leading-tight text-text-primary">
              {result.title || interaction?.text}
            </h2>
            {result.subtitle ? <p className="mt-0.5 text-[12px] text-text-muted">{result.subtitle}</p> : null}
          </div>
          <button
            type="button"
            aria-label={t("readerXray.clear")}
            title={t("readerXray.clear")}
            className="grid size-7 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-black/5 hover:text-text-primary"
            onClick={onClear}
          >
            <X size={15} />
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {navigationError ? (
          <div role="alert" aria-live="assertive" className="mx-4 mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger-text">
            <strong className="block">{t("readerXray.navigationFailed")}</strong>
            <span>{t("readerXray.navigationFailedHint")}</span>
          </div>
        ) : null}
        {!interaction ? (
          <div role="status" aria-live="polite" className="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-center">
            <div className="grid size-[46px] place-items-center rounded-full bg-accent-bg">
              <CircleHelp size={20} className="text-accent-text" />
            </div>
            <p className="text-[13.5px] font-semibold text-text-secondary">{t("readerXray.entryTitle")}</p>
            <p className="max-w-[270px] text-[12px] leading-relaxed text-text-muted">{t("readerXray.entryHint")}</p>
          </div>
        ) : loading ? (
          <div role="status" aria-live="polite" className="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-center">
            <div className="grid size-[46px] place-items-center rounded-full bg-accent-bg">
              <Loader2 size={20} className="animate-spin text-accent-text" />
            </div>
            <p className="text-[13.5px] font-semibold text-text-secondary">{t("readerXray.loading")}</p>
            <p className="max-w-[270px] text-[12px] leading-relaxed text-text-muted">{t("readerXray.loadingHint")}</p>
          </div>
        ) : error && errorPresentation ? (
          <div role="alert" aria-live="assertive" className="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-center">
            <div className={`grid size-[46px] place-items-center rounded-full ${errorPresentation.kind === "indexBuilding" ? "bg-bg-input text-text-muted" : "bg-danger/10 text-danger-text"}`}>
              {errorPresentation.kind === "indexBuilding"
                ? <Loader2 size={20} className="animate-spin" />
                : <AlertTriangle size={20} />}
            </div>
            {errorPresentation.kind === "ai" && errorPresentation.aiErrorCode ? (
              <>
                <p className="text-[13.5px] font-semibold text-text-secondary">{t("readerXray.failed")}</p>
                <p className="max-w-[270px] text-[12px] leading-relaxed text-text-muted">{t(aiErrorMessageKey(errorPresentation.aiErrorCode))}</p>
                <div className="mt-1 flex items-center gap-3">
                  <button type="button" className="flex items-center gap-1.5 text-[12px] font-medium text-accent-text" onClick={() => void openAiSettings()}>
                    <Settings size={13} /> {t("ai.openSettings")}
                  </button>
                  {isAiRetryableError(errorPresentation.aiErrorCode) ? (
                    <button type="button" className="rounded-lg border border-border px-3 py-[7px] text-[12px] font-medium text-accent-text hover:bg-accent-bg" onClick={() => void load(false, true)}>
                      {t("common.retry")}
                    </button>
                  ) : null}
                </div>
              </>
            ) : errorPresentation.kind === "indexBuilding" ? (
              <>
                <p className="text-[13.5px] font-semibold text-text-secondary">{t("readerXray.indexBuildingTitle")}</p>
                <p className="max-w-[270px] text-[12px] leading-relaxed text-text-muted">{t("readerXray.indexBuildingHint")}</p>
                <button type="button" className="mt-1 rounded-lg border border-border px-3 py-[7px] text-[12px] font-medium text-accent-text hover:bg-accent-bg" onClick={() => void load(false, true)}>
                  {t("common.retry")}
                </button>
              </>
            ) : errorPresentation.kind === "indexFailed" ? (
              <>
                <p className="text-[13.5px] font-semibold text-text-secondary">{t("readerXray.indexFailedTitle")}</p>
                <p className="max-w-[270px] text-[12px] leading-relaxed text-text-muted">{t("readerXray.indexFailedHint")}</p>
              </>
            ) : errorPresentation.kind === "indexUnsupported" ? (
              <>
                <p className="text-[13.5px] font-semibold text-text-secondary">{t("readerXray.indexUnsupportedTitle")}</p>
                <p className="max-w-[270px] text-[12px] leading-relaxed text-text-muted">{t("readerXray.indexUnsupportedHint")}</p>
              </>
            ) : (
              <>
                <p className="text-[13.5px] font-semibold text-text-secondary">{t("readerXray.failed")}</p>
                <p className="max-w-[270px] text-[12px] leading-relaxed text-text-muted">{t("readerXray.failedHint")}</p>
                <button type="button" className="mt-1 rounded-lg border border-border px-3 py-[7px] text-[12px] font-medium text-accent-text hover:bg-accent-bg" onClick={() => void load(false, true)}>
                  {t("common.retry")}
                </button>
              </>
            )}
          </div>
        ) : view === "confirm" ? (
          <div className="px-4 py-5">
            <AlertTriangle size={30} className="text-danger-text" />
            <h3 className="mt-3.5 text-[15px] font-semibold text-text-primary">{t("readerXray.spoilerTitle")}</h3>
            <p className="mt-2 text-[12px] leading-relaxed text-text-muted">{t("readerXray.spoilerHint")}</p>
            <div className="mt-4 rounded-lg bg-bg-input p-3 text-[12px] leading-relaxed text-text-secondary">
              <strong className="block text-text-primary">{t("readerXray.sessionOnly")}</strong>
              {t("readerXray.sessionOnlyHint")}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-border px-3 py-2 text-[12px] font-medium text-text-secondary hover:bg-bg-input" onClick={() => setView("summary")}>
                {t("readerXray.keepSafe")}
              </button>
              <button type="button" className="rounded-lg bg-danger px-3 py-2 text-[12px] font-medium text-white" onClick={() => void load(true, true)}>
                {t("readerXray.confirmWholeBook")}
              </button>
            </div>
          </div>
        ) : empty || result?.kind === "unknown" ? (
          <div role="status" aria-live="polite" className="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-center">
            <div className="grid size-[46px] place-items-center rounded-full bg-bg-input">
              <CircleHelp size={20} className="text-text-muted" />
            </div>
            <p className="text-[13.5px] font-semibold text-text-secondary">{t("readerXray.empty")}</p>
            <p className="max-w-[270px] text-[12px] leading-relaxed text-text-muted">{result?.summary || t("readerXray.emptyHint")}</p>
          </div>
        ) : view === "relations" && result ? (
          <div className="px-4 pb-4 pt-3.5">
            <button type="button" className="mb-3 flex items-center gap-1 text-[12px] text-accent-text" onClick={() => setView("summary")}>
              <ArrowLeft size={13} /> {t("readerXray.backToSummary")}
            </button>
            <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-text-muted">{t("readerXray.relationPaths")}</h3>
            <div className="grid gap-2">
              {result.relationPaths.map((path) => (
                <div key={`${path.target}:${path.label}`} className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-text-primary"><Route size={14} />{result.title} → {path.target}</div>
                  <div className="mt-1 text-[11px] font-medium text-accent-text">{path.label}</div>
                  <p className="mt-1 text-[12px] leading-5 text-text-secondary">{path.explanation}</p>
                </div>
              ))}
            </div>
          </div>
        ) : result ? (
          <div className="divide-y divide-border-light px-4">
            <section className="py-3.5">
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-text-muted">{result.kind === "term" ? t("readerXray.definition") : t("readerXray.summary")}</h3>
              <p className="text-[13px] leading-6 text-text-secondary">{result.summary}</p>
              {result.facts.map((fact) => (
                <div key={fact.label} className="mt-2 grid grid-cols-[72px_1fr] gap-2 text-[12px] leading-5">
                  <span className="text-text-muted">{fact.label}</span><span className="text-text-secondary">{fact.value}</span>
                </div>
              ))}
            </section>
            {result.relations.length > 0 ? (
              <section className="py-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-text-muted">{t("readerXray.relations")}</h3>
                  {result.relationPaths.length > 0 ? <button type="button" className="text-[11px] text-accent-text" onClick={() => setView("relations")}>{t("readerXray.viewPaths")}</button> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {result.relations.map((relation) => (
                    <div key={relation.name} className="max-w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-[11px] leading-4 text-text-secondary">
                      <strong className="block text-[12px] text-text-primary">{relation.name}</strong>{relation.description}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            <section className="py-3.5">
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-text-muted">
                {wholeBook ? t("readerXray.scopeWholeBook") : t("readerXray.occurrences")}
              </h3>
              <div className="grid gap-1.5">
                {interaction.location ? (
                  <button
                    type="button"
                    disabled={navigatingKey !== null}
                    aria-busy={navigatingKey === "current"}
                    className="rounded-md border border-accent/30 bg-accent-bg px-2.5 py-2 text-left text-[11px] text-text-secondary disabled:cursor-wait disabled:opacity-60"
                    onClick={() => void navigate("current", () => onNavigateCurrent(interaction.location))}
                  >
                    <strong className="mr-2 text-accent-text">{t("readerXray.current")}</strong>{interaction.context}
                  </button>
                ) : null}
                {result.sources.map((source) => (
                  <button
                    type="button"
                    key={source.chunkId}
                    disabled={navigatingKey !== null}
                    aria-busy={navigatingKey === source.chunkId}
                    className="rounded-md bg-bg-input px-2.5 py-2 text-left text-[11px] text-text-secondary hover:bg-accent-bg disabled:cursor-wait disabled:opacity-60"
                    onClick={() => void navigate(source.chunkId, () => onNavigate(source))}
                  >
                    <strong className="mr-2 text-text-muted">
                      {source.sectionTitle || (wholeBook ? t("readerXray.scopeWholeBook") : t("readerXray.earlier"))}
                    </strong>{source.snippet}
                  </button>
                ))}
                {result.sources.length === 0 && !interaction.location ? <p className="text-[12px] text-text-muted">{t("readerXray.noOccurrences")}</p> : null}
              </div>
            </section>
          </div>
        ) : null}
      </div>

      {/* The footer used to hold this tab's two actions; they moved up to the
          toolbar row, where the siblings keep theirs. What is left is the count
          strip every traces tab ends with — "N 处提及" beside "N 个书签". */}
      {result && !empty && result.kind !== "unknown" && !loading && !error && view !== "confirm" ? (
        <div className="shrink-0 border-t border-border px-4 pb-3 pt-[11px]">
          <p className="text-center text-[11px] tracking-[0.06px] text-text-muted">
            {t("readerXray.mentionCount", { count: mentionCount })}
          </p>
        </div>
      ) : null}
    </aside>
  );
}
