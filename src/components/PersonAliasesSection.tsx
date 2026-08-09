import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Split,
  UserPlus,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "./ui/Button";
import Input from "./ui/Input";
import { useSettings } from "../hooks/useSettings";
import {
  aliasAmbiguities,
  aliasBuildError,
  aliasSourceCounts,
  aliasTableCounts,
  aliasTableSections,
  ambiguousAliasSet,
  canonicalCandidates,
  descriptionMatching,
  filterAliasRows,
  isKnownCanonical,
  personAliasRows,
  rowMentions,
  rowSource,
  type AliasAmbiguity,
  type AliasEntryView,
  type AliasFilter,
  type AliasGroupView,
  type PersonAliasRow,
} from "./person-aliases";

/** The shape `ai_vector_retrieval_status` returns; only `available` is used here. */
interface VectorAvailability {
  available: boolean;
}

/**
 * A delete waiting on the reader. Held as a list of entries rather than one,
 * because the bridge card's "改成只指 X" is the same destructive act applied to
 * every other candidate at once (D8).
 */
interface PendingDelete {
  /** Where the confirm renders: one row's alias cell, or a bridge card. */
  place: "row" | "bridge";
  /** Identifies the confirm's slot — a row's entry id, or an alias text. */
  anchor: string;
  alias: string;
  /** The canonical the alias keeps pointing at once this goes through. */
  keptCanonical: string;
  /** The canonicals it stops pointing at. */
  droppedCanonicals: string[];
  entries: AliasEntryView[];
}

/** "人物别名" — a peer section to the overview/section summaries above it in
 * IndexManagerModal. Owns its own fetch/busy/error state rather than sharing
 * the parent's `details`, because the alias table lives behind five
 * independent commands that have nothing to do with `ai_index_details`. */
export default function PersonAliasesSection({
  bookId,
  onLeaveForSettings,
}: {
  bookId: string;
  /**
   * Close the index manager. The settings modal sits at `z-50` and this one at
   * `z-[70]`, so a deep link into 选模型 would otherwise open behind the dialog
   * the reader is looking at, and read as a dead button.
   */
  onLeaveForSettings(): void;
}) {
  const { t } = useTranslation();
  const { settings, loading: settingsLoading } = useSettings();
  const [groups, setGroups] = useState<AliasGroupView[] | null>(null);
  const [availability, setAvailability] = useState<VectorAvailability | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copiedDetail, setCopiedDetail] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [addingPerson, setAddingPerson] = useState(false);
  const [addPersonCanonical, setAddPersonCanonical] = useState("");
  const [addPersonAlias, setAddPersonAlias] = useState("");
  const [canonicalPicked, setCanonicalPicked] = useState(false);
  const [addingAliasFor, setAddingAliasFor] = useState<string | null>(null);
  const [addAliasText, setAddAliasText] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AliasFilter>("all");
  const [expanded, setExpanded] = useState(false);
  /** Bridges the reader answered with 「两个都留着」, by alias text. */
  const [settledAliases, setSettledAliases] = useState<string[]>([]);
  const bridgeRefs = useRef(new Map<string, HTMLDivElement>());

  const load = useCallback(async () => {
    const next = await invoke<AliasGroupView[]>("list_person_aliases", { bookId });
    setGroups(next);
  }, [bookId]);

  useEffect(() => { void load().catch(setError); }, [load]);

  // The same probe the embedding settings page runs, for the same reason: the
  // switch alone does not say whether there is a model behind it.
  useEffect(() => {
    void invoke<VectorAvailability>("ai_vector_retrieval_status")
      .then(setAvailability)
      .catch(() => setAvailability({ available: false }));
  }, []);

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    setCopiedDetail(false);
    try {
      await action();
      await load();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  };

  const building = busy === "build" || busy === "rebuild";
  const buildError = error == null ? null : aliasBuildError(error);

  const rebuild = () => {
    setConfirmRebuild(false);
    void run("rebuild", () => invoke("build_person_aliases", { bookId }));
  };

  /**
   * Cross-window Tauri event rather than the same-window `openSettings()` DOM
   * event, following `ExplainPopover`: `SettingsHost` is only mounted in the
   * main window, and this section is reachable from a detached reader window
   * through `AiPanel`.
   */
  const pickModel = async () => {
    onLeaveForSettings();
    await invoke("open_settings_on_main", { section: "services", view: "models" });
    const main = await WebviewWindow.getByLabel("main");
    await main?.setFocus();
  };

  const copyDetail = (detail: string) => {
    void navigator.clipboard
      .writeText(detail)
      .then(() => setCopiedDetail(true))
      .catch(() => {});
  };

  const rows = useMemo(() => personAliasRows(groups ?? []), [groups]);
  const counts = aliasTableCounts(rows);
  const sourceCounts = aliasSourceCounts(rows);
  const ambiguities = useMemo(() => aliasAmbiguities(rows), [rows]);
  const flaggedAliases = useMemo(() => ambiguousAliasSet(ambiguities), [ambiguities]);
  // The confirm dialog's count is over every taught row, description rows
  // included: clear_person_aliases wipes them too, and the reader should see
  // the true number about to be lost.
  const userTaughtCount = sourceCounts.user;
  const matching = descriptionMatching(settings, settingsLoading, availability);
  const descriptionsDimmed = matching !== "on" && counts.descriptions > 0;

  // Searching or filtering is itself an act of narrowing; folding the result of
  // it a second time would hide the row the reader just went looking for.
  const searching = query.trim().length > 0 || filter !== "all";
  const shown = useMemo(
    () => filterAliasRows(rows, ambiguities, query, filter),
    [rows, ambiguities, query, filter],
  );
  const sections = useMemo(() => aliasTableSections(shown, ambiguities), [shown, ambiguities]);
  const visibleRows = searching || expanded ? shown : sections.visible;
  const openBridges = ambiguities.filter((item) => !settledAliases.includes(item.alias));

  const sourceLabel = {
    auto: "indexManager.aliases.sourceAuto",
    user: "indexManager.aliases.sourceUser",
    both: "indexManager.aliases.sourceBoth",
  } as const;

  const openAddAlias = (canonical: string) => {
    setAddingAliasFor(canonical);
    setAddAliasText("");
  };
  const cancelAddAlias = () => {
    setAddingAliasFor(null);
    setAddAliasText("");
  };
  const submitAddAlias = (canonical: string) => {
    const alias = addAliasText.trim();
    if (!alias) { cancelAddAlias(); return; }
    void run(`add-alias-${canonical}`, () => invoke("add_person_alias", {
      bookId, canonical, alias, kind: "name", sourceQuery: null,
    })).then(cancelAddAlias);
  };

  const cancelAddPerson = () => {
    setAddingPerson(false);
    setAddPersonCanonical("");
    setAddPersonAlias("");
    setCanonicalPicked(false);
  };
  const submitAddPerson = () => {
    const canonical = addPersonCanonical.trim();
    const alias = addPersonAlias.trim();
    if (!canonical || !alias) return;
    void run("add-person", () => invoke("add_person_alias", {
      bookId, canonical, alias, kind: "name", sourceQuery: null,
    })).then(cancelAddPerson);
  };

  /** `delete_person_alias` also drops the row's vectors, so this is the one
   * delete path both kinds need. Deletes run one at a time and the table is
   * refetched once, at the end. */
  const commitDelete = (target: PendingDelete) => {
    setPendingDelete(null);
    void run(`delete-${target.anchor}`, async () => {
      for (const entry of target.entries) {
        await invoke("delete_person_alias", { id: entry.id });
      }
    });
  };

  const askDeleteEntry = (row: PersonAliasRow, entry: AliasEntryView) =>
    setPendingDelete({
      place: "row",
      anchor: entry.id,
      alias: entry.alias,
      keptCanonical: row.canonical,
      droppedCanonicals: [row.canonical],
      entries: [entry],
    });

  const askKeepOnly = (ambiguity: AliasAmbiguity, keep: string) =>
    setPendingDelete({
      place: "bridge",
      anchor: ambiguity.alias,
      alias: ambiguity.alias,
      keptCanonical: keep,
      droppedCanonicals: ambiguity.candidates
        .filter((candidate) => candidate.canonical !== keep)
        .map((candidate) => candidate.canonical),
      entries: ambiguity.candidates
        .filter((candidate) => candidate.canonical !== keep)
        .map((candidate) => ({
          id: candidate.entryId,
          alias: ambiguity.alias,
          source: "auto",
          mentions: candidate.mentions,
          kind: "name",
          sourceQuery: null,
        })),
    });

  /** Jump from a table chip to the card that explains it. */
  const revealBridge = (alias: string) => {
    setSettledAliases((current) => current.filter((settled) => settled !== alias));
    window.requestAnimationFrame(() => {
      bridgeRefs.current.get(alias)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  /**
   * The in-place confirm from state 7, reused verbatim by the bridge card's
   * "改成只指 X" (D8). Two sources, two consequences: an automatic row can come
   * back on the next rebuild, a taught one cannot come back at all.
   */
  const renderDeleteConfirm = (target: PendingDelete) => {
    const single = target.entries.length === 1 ? target.entries[0] : null;
    return (
      <div className="w-full max-w-[470px] rounded-md border border-border bg-bg-input p-3">
        <h5 className="mb-1.5 text-[12.5px] font-semibold text-text-primary">
          {single
            ? t("indexManager.aliases.deleteConfirmTitle", {
                alias: target.alias, canonical: target.droppedCanonicals[0],
              })
            : t("indexManager.aliases.keepOnlyConfirmTitle", { canonical: target.keptCanonical })}
        </h5>
        {single && single.source === "user" ? (
          <p className="text-[11.5px] leading-[1.75] text-text-secondary">
            {t("indexManager.aliases.deleteConfirmUserPrefix")}
            <b className="font-semibold text-text-primary">
              {t("indexManager.aliases.deleteConfirmUserBold")}
            </b>
            {t("indexManager.aliases.deleteConfirmUserSuffix", { alias: target.alias })}
          </p>
        ) : (
          <>
            <p className="text-[11.5px] leading-[1.75] text-text-secondary">
              {single ? (
                <>
                  {t("indexManager.aliases.deleteConfirmAutoPrefix", { alias: target.alias })}
                  <b className="font-semibold text-text-primary">{target.droppedCanonicals[0]}</b>
                  {t("indexManager.aliases.deleteConfirmAutoSuffix")}
                </>
              ) : (
                t("indexManager.aliases.keepOnlyConfirmBody", {
                  alias: target.alias,
                  canonical: target.keptCanonical,
                  others: target.droppedCanonicals.join("、"),
                  count: target.droppedCanonicals.length,
                })
              )}
            </p>
            <p className="mt-1 text-[11.5px] leading-[1.75] text-text-muted">
              {t("indexManager.aliases.deleteConfirmAutoTail")}
            </p>
          </>
        )}
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            disabled={busy != null}
            onClick={() => commitDelete(target)}
            className="h-[26px] rounded-md bg-danger px-2.5 text-[11.5px] text-white disabled:opacity-50"
          >
            {t("indexManager.aliases.deleteConfirmAction")}
          </button>
          <Button size="sm" variant="ghost" disabled={busy != null} onClick={() => setPendingDelete(null)}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  };

  const renderBridge = (ambiguity: AliasAmbiguity) => {
    const top = ambiguity.candidates[0].mentions;
    const pair = ambiguity.candidates.length === 2;
    return (
      <div
        key={ambiguity.alias}
        ref={(node) => {
          if (node) bridgeRefs.current.set(ambiguity.alias, node);
          else bridgeRefs.current.delete(ambiguity.alias);
        }}
        className="mt-2.5 rounded-md border border-border bg-bg-surface px-3.5 py-3"
      >
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/55 bg-bg-surface px-2 py-0.5 text-[11px] leading-5 text-warning">
            {ambiguity.alias}
            <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/15 px-1.5 text-[10px]">
              <Split size={9} />
              {t("indexManager.aliases.bridgeBadge", { count: ambiguity.candidates.length })}
            </span>
          </span>
          <span className="text-[12px] text-text-secondary">
            {pair
              ? t("indexManager.aliases.bridgeLeadTwo")
              : t("indexManager.aliases.bridgeLeadMany", { count: ambiguity.candidates.length })}
          </span>
        </div>

        <div className="flex flex-col gap-[7px]">
          {ambiguity.candidates.map((candidate, index) => (
            <div
              key={candidate.entryId}
              className="grid grid-cols-[1fr_88px_auto] items-center gap-2.5 sm:grid-cols-[1fr_132px_auto]"
            >
              <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-text-primary">
                <span className="truncate">{candidate.canonical}</span>
                {index === 0 && (
                  <span className="whitespace-nowrap rounded border border-accent bg-accent-bg px-1.5 text-[10px] text-accent-text">
                    {t("indexManager.aliases.bridgeDefault")}
                  </span>
                )}
              </div>
              <div className="h-[5px] overflow-hidden rounded-full bg-bg-input">
                <div
                  className={`h-full rounded-full ${index === 0 ? "bg-accent" : "bg-text-muted/50"}`}
                  style={{ width: `${top > 0 ? Math.max(4, (candidate.mentions / top) * 100) : 0}%` }}
                />
              </div>
              <span className="whitespace-nowrap text-right text-[10.5px] text-text-muted">
                {t("indexManager.aliases.mentions", { count: candidate.mentions })}
              </span>
            </div>
          ))}
        </div>

        {/* resolve() appends every candidate to the retrieval query — it does
            not pick one and drop the rest. Saying "the app guesses" would send
            the reader off to delete an alias that was doing its job. */}
        <p className="mt-2.5 border-t border-dashed border-border pt-2.5 text-[11.5px] leading-[1.75] text-text-secondary">
          {t("indexManager.aliases.bridgeExplainPrefix", { alias: ambiguity.alias })}
          <b className="font-semibold text-text-primary">
            {pair
              ? t("indexManager.aliases.bridgeExplainBoldTwo")
              : t("indexManager.aliases.bridgeExplainBoldMany")}
          </b>
          {t("indexManager.aliases.bridgeExplainRest")}
          {t("indexManager.aliases.bridgeExplainFullName")}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-bg-input px-2.5 py-2">
          <span className="whitespace-nowrap text-[10px] text-text-muted">
            {t("indexManager.aliases.bridgePreviewLabel")}
          </span>
          <span className="text-[11.5px] text-text-secondary">
            {t("indexManager.aliases.bridgePreviewLine", {
              alias: ambiguity.alias, canonical: ambiguity.candidates[0].canonical,
            })}
          </span>
          <span
            aria-hidden="true"
            className="rounded-md border border-border bg-bg-surface px-2 py-0.5 text-[11px] text-text-secondary"
          >
            {t("indexManager.aliases.bridgePreviewSwap", {
              canonical: ambiguity.candidates[1].canonical,
            })}
          </span>
        </div>

        {pendingDelete?.place === "bridge" && pendingDelete.anchor === ambiguity.alias ? (
          <div className="mt-2.5">{renderDeleteConfirm(pendingDelete)}</div>
        ) : (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {ambiguity.candidates.map((candidate) => (
              <Button
                key={candidate.entryId}
                size="sm"
                variant="secondary"
                disabled={busy != null}
                onClick={() => askKeepOnly(ambiguity, candidate.canonical)}
              >
                {t("indexManager.aliases.bridgeOnly", { canonical: candidate.canonical })}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy != null}
              onClick={() =>
                setSettledAliases((current) => [...current, ambiguity.alias])
              }
            >
              {pair
                ? t("indexManager.aliases.bridgeKeepBoth")
                : t("indexManager.aliases.bridgeKeepAll")}
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-[13px] font-medium text-text-primary">{t("indexManager.aliases.title")}</h4>
        {!building && rows.length > 0 && (
          <span className="text-[10.5px] text-text-muted">
            {counts.descriptions > 0
              ? t("indexManager.aliases.countWithDescriptions", { ...counts })
              : t("indexManager.aliases.count", { ...counts })}
          </span>
        )}
      </div>

      {/* Above the table, not below it: a build runs for minutes, and when it
          lands the reader is looking at where the progress bar was. */}
      {buildError && (
        <div
          role={buildError.tone === "danger" ? "alert" : "status"}
          className={`mb-3 flex items-start gap-2.5 rounded-md border px-3 py-2.5 ${
            buildError.tone === "danger"
              ? "border-danger-border bg-danger-bg"
              : "border-border bg-bg-input"
          }`}
        >
          {buildError.tone === "danger" ? (
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger-text" />
          ) : (
            <Info size={13} className="mt-0.5 shrink-0 text-text-muted" />
          )}
          <div className="min-w-0">
            <p
              className={`mb-0.5 text-[12.5px] font-semibold ${
                buildError.tone === "danger" ? "text-danger-text" : "text-text-primary"
              }`}
            >
              {t(buildError.titleKey)}
            </p>
            <p className="text-[11.5px] leading-[1.7] text-text-secondary">{t(buildError.bodyKey)}</p>
            {/* The reason the whole retry fix exists is that a failed pass
                writes nothing. The reader can see the table survived; saying so
                is what stops them clearing rows they taught on the suspicion
                that the failure corrupted them. */}
            {rows.length > 0 && (
              <p className="mt-1.5 border-l-2 border-border pl-2 text-[11px] leading-[1.65] text-text-muted">
                {t("indexManager.aliases.buildError.tableKept")}
              </p>
            )}
            {buildError.detail && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-text-muted">
                  {t("indexManager.aliases.buildError.details")}
                </summary>
                <pre className="mt-1.5 whitespace-pre-wrap break-all rounded border border-border bg-bg-input px-2 py-1.5 font-mono text-[10.5px] text-text-secondary">
                  {buildError.detail}
                </pre>
              </details>
            )}
            <div className="mt-2.5 flex flex-wrap gap-2">
              {buildError.canRetry && (
                <Button size="sm" variant="primary" disabled={busy != null} onClick={rebuild}>
                  {t("indexManager.aliases.buildError.retry")}
                </Button>
              )}
              {buildError.canPickModel && (
                <Button size="sm" variant="secondary" disabled={busy != null} onClick={() => void pickModel()}>
                  {t("indexManager.aliases.buildError.pickModel")}
                </Button>
              )}
              {buildError.detail && (
                <Button size="sm" variant="secondary" onClick={() => copyDetail(buildError.detail!)}>
                  {t(`indexManager.aliases.buildError.${copiedDetail ? "copied" : "copyDetails"}`)}
                </Button>
              )}
              {!buildError.canRetry && !buildError.canPickModel && (
                <Button size="sm" variant="secondary" onClick={() => setError(null)}>
                  {t("indexManager.aliases.buildError.dismiss")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {!building && (
        <p className="mb-3 max-w-[520px] text-[11.5px] leading-5 text-text-secondary">
          {rows.length === 0 ? (
            t("indexManager.aliases.introNote")
          ) : (
            <>
              {counts.descriptions === 0 ? (
                t("indexManager.aliases.legendNote")
              ) : (
                <>
                  {t("indexManager.aliases.legendNoteDescPrefix")}
                  <b className="font-semibold text-text-primary">{t("indexManager.aliases.legendNoteDescApprox")}</b>
                  {t("indexManager.aliases.legendNoteDescRest")}
                </>
              )}{" "}
              {/* The mention count is the one piece of evidence that separates
                  a name the model invented (absurdly low) from a common word it
                  mistook for a name (absurdly high). */}
              <b className="font-semibold text-text-primary">{t("indexManager.aliases.legendMentionsLead")}</b>
              {t("indexManager.aliases.legendMentionsBody")}
            </>
          )}
        </p>
      )}

      {/* A rebuild keeps the old table on screen underneath: the reader needs
          to see that nothing was taken away while the model is re-reading. */}
      {building && (
        <div className="mb-3 rounded-md border border-dashed border-border px-5 py-5">
          <p className="text-[11.5px] text-text-secondary">{t("indexManager.aliases.building")}</p>
          {/* The pass now samples up to three times before giving up, so four
              or five minutes is ordinary. Unsaid, that reads as hung — and the
              retry count itself is an implementation detail the reader has no
              use for. */}
          <p className="mt-1 text-[11px] leading-[1.65] text-text-muted">
            {t("indexManager.aliases.buildingHint")}
          </p>
          <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-bg-input">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
          </div>
        </div>
      )}

      {groups === null ? (
        <Loader2 size={16} className="animate-spin text-text-muted" />
      ) : rows.length === 0 ? (
        !building && (
          <>
            <div className="rounded-md border border-dashed border-border px-5 py-6 text-center">
              <p className="mb-1 text-[12.5px] text-text-secondary">{t("indexManager.aliases.emptyTitle")}</p>
              <p className="mb-4 text-[11px] leading-5 text-text-muted">
                {t("indexManager.aliases.emptyWhat")}<br />{t("indexManager.aliases.emptyCost")}
              </p>
              <Button
                variant="primary"
                size="sm"
                disabled={busy != null}
                onClick={() => void run("build", () => invoke("build_person_aliases", { bookId }))}
              >
                <Sparkles size={13} />{t("indexManager.aliases.build")}
              </Button>
            </div>
            <p className="mt-3 max-w-[520px] border-l-2 border-border pl-3 text-[11px] leading-5 text-text-secondary">
              <b className="font-semibold text-text-primary">{t("indexManager.aliases.emptyNotEveryBookLead")}</b>{" "}
              {t("indexManager.aliases.emptyNotEveryBookBody")}
            </p>
          </>
        )
      ) : (
        <>
          {/* Ambiguity is a relation between two rows. Marking each row on its
              own is exactly why today's table hides it, so the card that holds
              both candidates sits above the table and the chips are its doors. */}
          {openBridges.length > 0 && (
            <div className="mb-3 rounded-md border border-warning/40 bg-warning/[0.07] px-3.5 py-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={13} className="mt-[3px] shrink-0 text-warning" />
                <div className="min-w-0">
                  <p className="text-[12.5px] font-semibold text-warning">
                    {t("indexManager.aliases.flagTitle", { count: openBridges.length })}
                  </p>
                  <p className="mt-0.5 text-[11.5px] leading-[1.7] text-text-secondary">
                    {t("indexManager.aliases.flagBody")}
                  </p>
                </div>
              </div>
              {openBridges.map(renderBridge)}
            </div>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] max-w-[260px] flex-1">
              <Search size={12} className="absolute left-2 top-2 text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("indexManager.aliases.searchPlaceholder")}
                className="h-7 w-full rounded-md border border-border bg-bg-surface pl-7 pr-2.5 text-[12px] text-text-primary outline-none"
              />
            </div>
            <div className="inline-flex h-7 overflow-hidden rounded-md border border-border">
              {(["all", "taught", "flagged"] as const).map((option, index) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={filter === option}
                  onClick={() => setFilter(option)}
                  className={`px-2.5 text-[11.5px] ${index > 0 ? "border-l border-border" : ""} ${
                    filter === option
                      ? "bg-bg-input font-medium text-text-primary"
                      : "bg-bg-surface text-text-secondary"
                  }`}
                >
                  {option === "all" && t("indexManager.aliases.filterAll")}
                  {option === "taught" && t("indexManager.aliases.filterTaught")}
                  {option === "flagged" && t("indexManager.aliases.filterFlagged")}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-border">
            <div className="grid grid-cols-[1fr_1.6fr_auto] gap-3 border-b border-border-light bg-bg-input px-3 py-1.5 text-[10.5px] tracking-wide text-text-muted">
              <span>{t("indexManager.aliases.colCanonical")}</span>
              <span>{t("indexManager.aliases.colAliases")}</span>
              <span>{t("indexManager.aliases.colSource")}</span>
            </div>
            {visibleRows.length === 0 && (
              <p className="px-3 py-4 text-center text-[11.5px] text-text-muted">
                {t("indexManager.aliases.noMatch")}
              </p>
            )}
            {visibleRows.map((row) => (
              <div
                key={row.canonical}
                className="grid grid-cols-[1fr_1.6fr_auto] items-center gap-3 border-b border-border-light px-3 py-2 text-[12.5px] last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-px">
                  <span className="truncate font-medium text-text-primary">{row.canonical}</span>
                  <span className="text-[10.5px] text-text-muted">
                    {t("indexManager.aliases.mentions", { count: rowMentions(row) })}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {row.names.map((entry) =>
                    flaggedAliases.has(entry.alias) ? (
                      // No × here: the honest fix for an ambiguity is a choice
                      // between two people, and that lives on the bridge card.
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => revealBridge(entry.alias)}
                        className="inline-flex items-center gap-1 rounded-full border border-warning/55 bg-bg-surface px-2 py-0.5 text-[11px] leading-5 text-warning"
                      >
                        {entry.alias}
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/15 px-1.5 text-[10px]">
                          <Split size={9} />
                          {t("indexManager.aliases.bridgeBadge", {
                            count: ambiguities.find((item) => item.alias === entry.alias)?.candidates.length ?? 2,
                          })}
                        </span>
                      </button>
                    ) : (
                      <span
                        key={entry.id}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-5 ${
                          entry.source === "user"
                            ? "border-accent bg-accent-bg text-accent-text"
                            : "border-border bg-bg-input text-text-secondary"
                        } ${pendingDelete?.anchor === entry.id ? "opacity-40" : ""}`}
                      >
                        {entry.alias}
                        <button
                          type="button"
                          aria-label={t("common.delete")}
                          disabled={busy != null}
                          onClick={() => askDeleteEntry(row, entry)}
                          className="opacity-50 hover:opacity-100 disabled:opacity-30"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ),
                  )}
                  {addingAliasFor === row.canonical ? (
                    <>
                      <input
                        autoFocus
                        value={addAliasText}
                        onChange={(event) => setAddAliasText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") submitAddAlias(row.canonical);
                          if (event.key === "Escape") cancelAddAlias();
                        }}
                        onBlur={cancelAddAlias}
                        placeholder={t("indexManager.aliases.addAliasPlaceholder")}
                        className="w-[130px] rounded-full border border-accent bg-bg-surface px-2.5 py-0.5 text-[11px] text-text-primary outline-none"
                      />
                      <span className="text-[10.5px] text-text-muted">
                        {t("indexManager.aliases.addAliasHint")}
                      </span>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={t("indexManager.aliases.addAliasAria", { canonical: row.canonical })}
                      disabled={busy != null}
                      onClick={() => openAddAlias(row.canonical)}
                      className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-text-muted hover:bg-bg-input disabled:opacity-30"
                    >
                      <Plus size={10} />
                    </button>
                  )}
                  {/* Descriptions live inside their person's row — one list per
                      character — but behind a dashed rule and an ≈, because
                      they are matched by meaning while everything above is
                      matched letter for letter. */}
                  {row.descriptions.length > 0 && (
                    <div className="mt-1.5 w-full border-t border-dashed border-border-light pt-1.5">
                      {row.descriptions.map((entry) => (
                        <div key={entry.id} className={descriptionsDimmed ? "opacity-45" : undefined}>
                          <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-[11px] leading-5 text-warning">
                            <span aria-hidden="true" className="text-[10.5px] opacity-75">≈</span>
                            <span className="sr-only">{t("indexManager.aliases.approxLabel")}</span>
                            <span className="min-w-0 break-words">{entry.alias}</span>
                            <button
                              type="button"
                              aria-label={t("common.delete")}
                              disabled={busy != null}
                              onClick={() => askDeleteEntry(row, entry)}
                              className="shrink-0 opacity-50 hover:opacity-100 disabled:opacity-30"
                            >
                              <X size={10} />
                            </button>
                          </span>
                          {/* Weeks later the phrase alone says nothing about
                              why it was taught; the question it was taught
                              from is the one fact a keep-or-delete call needs. */}
                          {entry.sourceQuery && (
                            <span className="mt-1 block text-[10.5px] leading-[1.55] text-text-muted">
                              {t("indexManager.aliases.descAsked", { query: entry.sourceQuery })}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {pendingDelete?.place === "row" &&
                    [...row.names, ...row.descriptions].some((entry) => entry.id === pendingDelete.anchor) && (
                      <div className="mt-2 w-full">{renderDeleteConfirm(pendingDelete)}</div>
                    )}
                </div>
                <span className="whitespace-nowrap text-[10.5px] text-text-muted">
                  {t(sourceLabel[rowSource(row)])}
                </span>
              </div>
            ))}
            {/* "还有 31 人" alone leaves the reader no way to tell whether the
                folded rows matter, so they open it anyway. The mention ceiling
                is what makes the fold a real answer. */}
            {!searching && sections.folded.length > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className="flex w-full items-center justify-center gap-1.5 border-t border-border-light bg-bg-muted px-3 py-2.5 text-[11.5px] text-text-secondary"
              >
                {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {expanded
                  ? t("indexManager.aliases.foldCollapse")
                  : t("indexManager.aliases.foldExpand", {
                      count: sections.folded.length,
                      mentions: sections.foldedBelowMentions ?? 0,
                    })}
              </button>
            )}
          </div>

          {/* Listed but inert is worse than not listed: the reader believes
              they taught it and blames the answer on the model. Dimmed rather
              than hidden — nothing was lost, and the switch brings them back. */}
          {descriptionsDimmed && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-bg-input px-3 py-2.5 text-[11.5px] leading-[1.6] text-text-secondary">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
              <span>
                <b className="font-semibold text-text-primary">
                  {t("indexManager.aliases.descOffLead", { count: counts.descriptions })}
                </b>{" "}
                {matching === "unavailable"
                  ? t("indexManager.aliases.descOffBodyUnavailable")
                  : t("indexManager.aliases.descOffBodySwitch")}
              </span>
            </div>
          )}

          <p className="mt-3 max-w-[520px] border-l-2 border-border pl-3 text-[11px] leading-5 text-text-secondary">
            <b className="font-semibold text-text-primary">{t("indexManager.aliases.perBookNoteLead")}</b>{" "}
            {t("indexManager.aliases.perBookNoteBody")}
          </p>

          {/* Rebuild is repeatable, so it gets a neutral box; clearing is the
              only act that destroys rows nothing can rebuild, so red stays
              reserved for it. */}
          {confirmRebuild && (
            <div className="mt-3 max-w-[520px] rounded-md border border-border bg-bg-input p-3.5">
              <h5 className="mb-1.5 text-[12.5px] font-semibold text-text-primary">
                {t("indexManager.aliases.rebuildConfirmTitle")}
              </h5>
              <p className="text-[11.5px] leading-[1.75] text-text-secondary">
                {t("indexManager.aliases.rebuildConfirmBody")}
              </p>
              <ul className="mb-2.5 mt-1.5 list-disc pl-[17px] text-[11.5px] leading-[1.75] text-text-secondary">
                <li>
                  <b className="font-semibold text-text-primary">{t("indexManager.aliases.rebuildCostLead")}</b>
                  {t("indexManager.aliases.rebuildCostBody")}
                </li>
                <li>
                  {userTaughtCount > 0 ? (
                    <>
                      <b className="font-semibold text-text-primary">
                        {t("indexManager.aliases.rebuildKeepLead", { count: userTaughtCount })}
                      </b>
                      {t("indexManager.aliases.rebuildKeepBody", { count: sourceCounts.auto })}
                    </>
                  ) : (
                    <>
                      <b className="font-semibold text-text-primary">
                        {t("indexManager.aliases.rebuildKeepNoneLead")}
                      </b>
                      {t("indexManager.aliases.rebuildKeepNoneBody", { count: sourceCounts.auto })}
                    </>
                  )}
                </li>
                {/* The correction the handoff insists on: a rebuild does not
                    overwrite taught rows. What it can undo is a deletion —
                    nothing records that the reader removed an automatic row. */}
                <li>
                  <b className="font-semibold text-text-primary">{t("indexManager.aliases.rebuildBackLead")}</b>
                  {t("indexManager.aliases.rebuildBackBody")}
                </li>
              </ul>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" disabled={busy != null} onClick={rebuild}>
                  {t("indexManager.aliases.rebuildConfirmAction")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy != null} onClick={() => setConfirmRebuild(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          )}

          {confirmClear ? (
            <div className="mt-3 rounded-md border border-danger-border bg-danger-bg p-3">
              <h5 className="mb-1 text-[12.5px] font-semibold text-danger-text">{t("indexManager.aliases.clearConfirmTitle")}</h5>
              <p className="mb-3 text-[11.5px] leading-5 text-text-secondary">
                {t("indexManager.aliases.clearConfirmBody", { count: userTaughtCount })}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy != null}
                  onClick={() => void run("clear", () => invoke("clear_person_aliases", { bookId })).then(() => setConfirmClear(false))}
                  className="h-7 rounded-md bg-danger px-2.5 text-[11px] text-white disabled:opacity-50"
                >
                  {t("indexManager.aliases.clearConfirmAction")}
                </button>
                <Button size="sm" variant="ghost" disabled={busy != null} onClick={() => setConfirmClear(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-start gap-2">
              {addingPerson ? (
                <div className="w-full max-w-[520px] rounded-md border border-border bg-bg-input p-3">
                  {/* An alias whose canonical is not verbatim in the book saves
                      cleanly and then never matches anything. Picking from the
                      names this book already has is what stops that at the
                      keystroke rather than months later. */}
                  <p className="mb-1.5 text-[11px] text-text-muted">
                    {t("indexManager.aliases.addPersonCanonicalLabel")}
                  </p>
                  <Input
                    autoFocus
                    value={addPersonCanonical}
                    onChange={(event) => {
                      setAddPersonCanonical(event.target.value);
                      setCanonicalPicked(false);
                    }}
                    placeholder={t("indexManager.aliases.addPersonCanonicalPlaceholder")}
                    className="w-full max-w-[220px]"
                  />
                  {addPersonCanonical.trim().length > 0 && !canonicalPicked && (
                    <div className="mt-2 overflow-hidden rounded-md border border-border bg-bg-surface">
                      {canonicalCandidates(rows, addPersonCanonical).map((candidate) => (
                        <button
                          key={candidate.canonical}
                          type="button"
                          onClick={() => {
                            setAddPersonCanonical(candidate.canonical);
                            setCanonicalPicked(true);
                          }}
                          className="flex w-full items-center justify-between gap-2.5 border-b border-border-light px-2.5 py-1.5 text-[12px] text-text-primary last:border-b-0 hover:bg-bg-input"
                        >
                          <span className="truncate">{candidate.canonical}</span>
                          <span className="whitespace-nowrap text-[10.5px] text-text-muted">
                            {t("indexManager.aliases.mentions", { count: candidate.mentions })}
                          </span>
                        </button>
                      ))}
                      {!isKnownCanonical(rows, addPersonCanonical) && (
                        <button
                          type="button"
                          onClick={() => setCanonicalPicked(true)}
                          className="flex w-full items-center justify-between gap-2.5 px-2.5 py-1.5 text-left text-[12px] text-text-secondary hover:bg-bg-input"
                        >
                          <span className="min-w-0 break-words">
                            {t("indexManager.aliases.addPersonPickerNew", { text: addPersonCanonical.trim() })}
                          </span>
                          <span className="whitespace-nowrap text-[10.5px] text-text-muted">
                            {t("indexManager.aliases.mentions", { count: 0 })}
                          </span>
                        </button>
                      )}
                    </div>
                  )}
                  <p className="mt-2 text-[10.5px] leading-[1.7] text-text-muted">
                    {t("indexManager.aliases.addPersonHint")}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Input
                      value={addPersonAlias}
                      onChange={(event) => setAddPersonAlias(event.target.value)}
                      placeholder={t("indexManager.aliases.addPersonAliasPlaceholder")}
                      className="w-44"
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy != null || !addPersonCanonical.trim() || !addPersonAlias.trim()}
                      onClick={submitAddPerson}
                    >
                      {t("indexManager.aliases.add")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy != null} onClick={cancelAddPerson}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="secondary" size="sm" disabled={busy != null} onClick={() => setAddingPerson(true)}>
                  <UserPlus size={13} />{t("indexManager.aliases.addPerson")}
                </Button>
              )}
              {!addingPerson && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy != null || confirmRebuild}
                    onClick={() => setConfirmRebuild(true)}
                  >
                    {t("indexManager.aliases.rebuild")}
                  </Button>
                  <button
                    type="button"
                    disabled={busy != null}
                    onClick={() => setConfirmClear(true)}
                    className="flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-danger-text hover:bg-bg-input disabled:opacity-50"
                  >
                    {t("indexManager.aliases.clearAll")}
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
