import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AlertTriangle, Info, Loader2, Plus, Sparkles, UserPlus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "./ui/Button";
import Input from "./ui/Input";
import { useSettings } from "../hooks/useSettings";
import {
  aliasBuildError,
  aliasTableCounts,
  descriptionMatching,
  personAliasRows,
  rowSource,
  type AliasEntryView,
  type AliasGroupView,
} from "./person-aliases";

/** The shape `ai_vector_retrieval_status` returns; only `available` is used here. */
interface VectorAvailability {
  available: boolean;
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
  const [addingPerson, setAddingPerson] = useState(false);
  const [addPersonCanonical, setAddPersonCanonical] = useState("");
  const [addPersonAlias, setAddPersonAlias] = useState("");
  const [addingAliasFor, setAddingAliasFor] = useState<string | null>(null);
  const [addAliasText, setAddAliasText] = useState("");

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

  const rebuild = () => void run("rebuild", () => invoke("build_person_aliases", { bookId }));

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

  const rows = personAliasRows(groups ?? []);
  const counts = aliasTableCounts(rows);
  // The confirm dialog's count is over every taught row, description rows
  // included: clear_person_aliases wipes them too, and the reader should see
  // the true number about to be lost.
  const userTaughtCount = (groups ?? []).reduce(
    (sum, group) => sum + group.entries.filter((entry) => entry.source === "user").length,
    0,
  );
  const matching = descriptionMatching(settings, settingsLoading, availability);
  const descriptionsDimmed = matching !== "on" && counts.descriptions > 0;

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
   * delete path both kinds need. */
  const deleteEntry = (entry: AliasEntryView) =>
    void run(`delete-${entry.id}`, () => invoke("delete_person_alias", { id: entry.id }));

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
          ) : counts.descriptions === 0 ? (
            t("indexManager.aliases.legendNote")
          ) : (
            <>
              {t("indexManager.aliases.legendNoteDescPrefix")}
              <b className="font-semibold text-text-primary">{t("indexManager.aliases.legendNoteDescApprox")}</b>
              {t("indexManager.aliases.legendNoteDescRest")}
            </>
          )}
        </p>
      )}

      {building ? (
        <div className="rounded-md border border-dashed border-border px-5 py-5">
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
      ) : groups === null ? (
        <Loader2 size={16} className="animate-spin text-text-muted" />
      ) : rows.length === 0 ? (
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
      ) : (
        <>
          <div className="overflow-hidden rounded-md border border-border">
            <div className="grid grid-cols-[1fr_1.6fr_auto] gap-3 border-b border-border-light bg-bg-input px-3 py-1.5 text-[10.5px] tracking-wide text-text-muted">
              <span>{t("indexManager.aliases.colCanonical")}</span>
              <span>{t("indexManager.aliases.colAliases")}</span>
              <span>{t("indexManager.aliases.colSource")}</span>
            </div>
            {rows.map((row) => (
              <div
                key={row.canonical}
                className="grid grid-cols-[1fr_1.6fr_auto] items-center gap-3 border-b border-border-light px-3 py-2 text-[12.5px] last:border-b-0"
              >
                <span className="font-medium text-text-primary">{row.canonical}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {row.names.map((entry) => (
                    <span
                      key={entry.id}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-5 ${
                        entry.source === "user"
                          ? "border-accent bg-accent-bg text-accent-text"
                          : "border-border bg-bg-input text-text-secondary"
                      }`}
                    >
                      {entry.alias}
                      <button
                        type="button"
                        aria-label={t("common.delete")}
                        disabled={busy != null}
                        onClick={() => deleteEntry(entry)}
                        className="opacity-50 hover:opacity-100 disabled:opacity-30"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                  {addingAliasFor === row.canonical ? (
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
                      className="w-24 rounded-full border border-accent bg-bg-surface px-2 py-0.5 text-[11px] text-text-primary outline-none"
                    />
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
                              onClick={() => deleteEntry(entry)}
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
                </div>
                <span className="whitespace-nowrap text-[10.5px] text-text-muted">
                  {t(sourceLabel[rowSource(row)])}
                </span>
              </div>
            ))}
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
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {addingPerson ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-input p-2">
                  <Input
                    autoFocus
                    value={addPersonCanonical}
                    onChange={(event) => setAddPersonCanonical(event.target.value)}
                    placeholder={t("indexManager.aliases.addPersonCanonicalPlaceholder")}
                    className="w-44"
                  />
                  <Input
                    value={addPersonAlias}
                    onChange={(event) => setAddPersonAlias(event.target.value)}
                    placeholder={t("indexManager.aliases.addPersonAliasPlaceholder")}
                    className="w-36"
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
              ) : (
                <Button variant="secondary" size="sm" disabled={busy != null} onClick={() => setAddingPerson(true)}>
                  <UserPlus size={13} />{t("indexManager.aliases.addPerson")}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={busy != null}
                onClick={rebuild}
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
            </div>
          )}
        </>
      )}
    </section>
  );
}
