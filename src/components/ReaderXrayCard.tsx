import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ArrowLeft,
  CircleHelp,
  Loader2,
  RefreshCw,
  Route,
  UserRound,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CitedSource } from "../hooks/useAiChat";
import { createUuid } from "../utils/randomUuid";
import type { ReaderInteraction } from "./reader-interaction";
import {
  canApplyXrayLoad,
  canReuseXrayCache,
  didXrayNavigationSucceed,
  isEmptyXrayResult,
  shouldOfferXrayUpdate,
  xrayCacheKey,
  type XrayCardResult,
} from "./xray-card";

const safeCache = new Map<string, { location: string; result: XrayCardResult }>();

interface ReaderXrayCardProps {
  bookId: string;
  interaction: ReaderInteraction | null;
  getCurrentLocation(): string | null;
  currentChapter?: string;
  progress: number;
  onClose(): void;
  /** Resolve true only after the reader has completed the jump. */
  onNavigate(source: CitedSource): boolean | Promise<boolean>;
  /** Resolve true only after the reader has completed the jump. */
  onNavigateCurrent(location: string): boolean | Promise<boolean>;
}

type CardView = "summary" | "relations" | "confirm";

export default function ReaderXrayCard({
  bookId,
  interaction,
  getCurrentLocation,
  currentChapter,
  progress,
  onClose,
  onNavigate,
  onNavigateCurrent,
}: ReaderXrayCardProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<XrayCardResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [navigationError, setNavigationError] = useState(false);
  const [navigatingKey, setNavigatingKey] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [view, setView] = useState<CardView>("summary");
  const requestRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const loadedIdentityRef = useRef<string | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const restoreFallbackLabelRef = useRef(t("readerXray.title"));

  const invalidateActiveRequest = useCallback(() => {
    loadGenerationRef.current += 1;
    const requestId = requestRef.current;
    requestRef.current = null;
    if (requestId) {
      void invoke("ai_cancel", { requestId }).catch(() => {});
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
      setResult(cached.result);
      setFromCache(true);
      setError(false);
      setLoading(false);
      setView("summary");
      return;
    }
    const requestId = createUuid();
    requestRef.current = requestId;
    setLoading(true);
    setError(false);
    setFromCache(false);
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
      if (!wholeBook) safeCache.set(key, { location: safeLocation, result: response });
      setView("summary");
    } catch {
      if (canApplyXrayLoad(loadGenerationRef.current, generation)) setError(true);
    } finally {
      if (canApplyXrayLoad(loadGenerationRef.current, generation)) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [bookId, currentChapter, getCurrentLocation, interaction, invalidateActiveRequest, progress]);

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

  useEffect(() => {
    const restoreTarget = restoreFocusRef.current;
    const restoreFallbackLabel = restoreFallbackLabelRef.current;
    cardRef.current?.focus({ preventScroll: true });
    return () => {
      const fallback = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.getAttribute("aria-label") === restoreFallbackLabel);
      const target = restoreTarget?.isConnected ? restoreTarget : fallback;
      target?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const frame = window.requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    return invalidateActiveRequest;
  }, [invalidateActiveRequest]);

  const wholeBook = result?.scope === "wholeBook";
  const empty = result ? isEmptyXrayResult(result) : false;
  const showUpdate = result ? shouldOfferXrayUpdate(result, progress) : false;
  const KindIcon = result?.kind === "person" ? UserRound : CircleHelp;

  const navigate = useCallback(
    async (key: string, action: () => boolean | Promise<boolean>) => {
      if (navigatingKey) return;
      setNavigationError(false);
      setNavigatingKey(key);
      try {
        // Do not infer success from a resolved promise: a reader callback must
        // explicitly acknowledge that the target was reached.
        if (didXrayNavigationSucceed(await action())) {
          onClose();
        } else {
          setNavigationError(true);
        }
      } catch {
        setNavigationError(true);
      } finally {
        setNavigatingKey(null);
      }
    },
    [navigatingKey, onClose],
  );

  return (
    <aside
      ref={cardRef}
      tabIndex={-1}
      aria-label={t("readerXray.title")}
      aria-busy={loading}
      className="absolute bottom-5 right-5 top-5 z-30 flex w-[386px] max-w-[calc(100%-40px)] flex-col overflow-hidden rounded-xl border border-[#DED5E3] bg-bg-surface shadow-popover max-[760px]:relative max-[760px]:inset-auto max-[760px]:mx-3 max-[760px]:mb-14 max-[760px]:mt-3 max-[760px]:min-h-[310px] max-[760px]:w-auto max-[760px]:max-w-none max-[760px]:shrink-0"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className={`shrink-0 border-b border-border px-4 py-3 ${result?.kind === "term" ? "bg-[#FFF7EB]" : "bg-accent-bg"}`}>
        <div className="flex items-start gap-3">
          <KindIcon size={16} className="mt-0.5 shrink-0 text-accent-text" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-text">
              {result?.kind === "person"
                ? t("readerXray.person")
                : result?.kind === "term"
                  ? t("readerXray.term")
                  : t("readerXray.title")}
            </div>
            <h2 className="mt-1 truncate text-[18px] font-semibold text-text-primary">
              {result?.title || interaction?.text || t("readerXray.entryTitle")}
            </h2>
            {result?.subtitle ? <p className="mt-0.5 text-[12px] text-text-muted">{result.subtitle}</p> : null}
            <div className={`mt-2 flex flex-wrap items-center gap-1.5 text-[11px] ${wholeBook ? "text-danger-text" : "text-text-muted"}`}>
              <span className={`size-1.5 rounded-full ${wholeBook ? "bg-danger" : "bg-emerald-600"}`} />
              <span>{wholeBook ? t("readerXray.scopeWholeBook") : t("readerXray.scopeSafe", { progress: result?.progress ?? progress })}</span>
              {!wholeBook && interaction ? (
                <button type="button" className="text-accent-text underline underline-offset-2" onClick={() => setView("confirm")}>
                  {t("readerXray.scopeAction")}
                </button>
              ) : null}
              {fromCache ? <span>· {t("readerXray.cached")}</span> : null}
            </div>
          </div>
          <button type="button" aria-label={t("common.close")} className="rounded-md p-1.5 text-text-muted hover:bg-bg-input" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {navigationError ? (
          <div role="alert" aria-live="assertive" className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger-text">
            <strong className="block">{t("readerXray.failed")}</strong>
            <span>{t("readerXray.failedHint")}</span>
          </div>
        ) : null}
        {!interaction ? (
          <div role="status" aria-live="polite" className="flex min-h-[240px] flex-col items-center justify-center text-center">
            <CircleHelp size={34} className="mb-3 text-accent-text" />
            <h3 className="text-[14px] font-semibold text-text-primary">{t("readerXray.entryTitle")}</h3>
            <p className="mt-1 max-w-[260px] text-[12px] leading-5 text-text-muted">{t("readerXray.entryHint")}</p>
          </div>
        ) : loading ? (
          <div role="status" aria-live="polite" className="flex min-h-[240px] flex-col items-center justify-center text-center">
            <Loader2 size={28} className="mb-3 animate-spin text-accent-text" />
            <h3 className="text-[14px] font-semibold text-text-primary">{t("readerXray.loading")}</h3>
            <p className="mt-1 text-[12px] leading-5 text-text-muted">{t("readerXray.loadingHint")}</p>
          </div>
        ) : error ? (
          <div role="alert" aria-live="assertive" className="flex min-h-[240px] flex-col items-center justify-center text-center">
            <AlertTriangle size={30} className="mb-3 text-danger-text" />
            <h3 className="text-[14px] font-semibold text-text-primary">{t("readerXray.failed")}</h3>
            <p className="mt-1 text-[12px] leading-5 text-text-muted">{t("readerXray.failedHint")}</p>
            <button type="button" className="mt-3 rounded-md border border-border px-3 py-2 text-[12px] text-accent-text" onClick={() => void load(false, true)}>
              {t("common.retry")}
            </button>
          </div>
        ) : view === "confirm" ? (
          <div className="py-2">
            <AlertTriangle size={34} className="text-danger-text" />
            <h3 className="mt-4 text-[15px] font-semibold text-text-primary">{t("readerXray.spoilerTitle")}</h3>
            <p className="mt-2 text-[12px] leading-5 text-text-muted">{t("readerXray.spoilerHint")}</p>
            <div className="mt-4 rounded-lg bg-bg-input p-3 text-[12px] leading-5 text-text-secondary">
              <strong className="block text-text-primary">{t("readerXray.sessionOnly")}</strong>
              {t("readerXray.sessionOnlyHint")}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-md border border-border px-3 py-2 text-[12px] text-text-secondary" onClick={() => setView("summary")}>
                {t("readerXray.keepSafe")}
              </button>
              <button type="button" className="rounded-md bg-danger px-3 py-2 text-[12px] font-medium text-white" onClick={() => void load(true, true)}>
                {t("readerXray.confirmWholeBook")}
              </button>
            </div>
          </div>
        ) : empty || result?.kind === "unknown" ? (
          <div role="status" aria-live="polite" className="flex min-h-[240px] flex-col items-center justify-center text-center">
            <CircleHelp size={32} className="mb-3 text-text-muted" />
            <h3 className="text-[14px] font-semibold text-text-primary">{t("readerXray.empty")}</h3>
            <p className="mt-1 max-w-[280px] text-[12px] leading-5 text-text-muted">{result?.summary || t("readerXray.emptyHint")}</p>
          </div>
        ) : view === "relations" && result ? (
          <div>
            <button type="button" className="mb-3 flex items-center gap-1 text-[12px] text-accent-text" onClick={() => setView("summary")}>
              <ArrowLeft size={13} /> {t("readerXray.backToSummary")}
            </button>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t("readerXray.relationPaths")}</h3>
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
          <div className="divide-y divide-border">
            <section className="pb-3">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{result.kind === "term" ? t("readerXray.definition") : t("readerXray.summary")}</h3>
              <p className="text-[13px] leading-6 text-text-secondary">{result.summary}</p>
              {result.facts.map((fact) => (
                <div key={fact.label} className="mt-2 grid grid-cols-[72px_1fr] gap-2 text-[12px] leading-5">
                  <span className="text-text-muted">{fact.label}</span><span className="text-text-secondary">{fact.value}</span>
                </div>
              ))}
            </section>
            {result.relations.length > 0 ? (
              <section className="py-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t("readerXray.relations")}</h3>
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
            <section className="pt-3">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
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

      {interaction && !loading && !error && view !== "confirm" ? (
        <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-surface px-3 py-2">
          {showUpdate ? (
            <button type="button" className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-accent-text hover:bg-accent-bg" onClick={() => void load(false, true)}>
              <RefreshCw size={13} /> {t("readerXray.update")}
            </button>
          ) : null}
          <button type="button" disabled={wholeBook} className="ml-auto rounded-md bg-accent px-3 py-2 text-[11px] font-medium text-white disabled:opacity-60" onClick={() => setView("confirm")}>
            {wholeBook ? t("readerXray.wholeBookActive") : t("readerXray.viewWholeBook")}
          </button>
        </footer>
      ) : null}
    </aside>
  );
}
