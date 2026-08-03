import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Input from "../ui/Input";
import Select from "../ui/Select";
import {
  BOOK_SOURCES_KEY,
  BOOK_SOURCES_SEEDED_KEY,
  BUILT_IN_BOOK_SOURCES,
  isOpenableUrl,
  parseBookSources,
  restoreBuiltInBookSources,
  serializeBookSources,
  type BookSource,
  type BookSourceKind,
} from "../book-sources";
import { createUuid } from "../../utils/randomUuid";
import ConfirmDialog from "./ConfirmDialog";
import { presetDeleteConfirm, type PresetDeleteConfirmation } from "./presetDeletion";
import type { SettingsProps } from "./types";

const KINDS: BookSourceKind[] = ["library", "thirdParty"];

function newSourceId(): string {
  return `user:${createUuid()}`;
}

export default function BookSourcesSettings({ settings, loading, saveBulk, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<BookSource[]>(() => parseBookSources(settings[BOOK_SOURCES_KEY]));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BookSource | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<
    { id: string; confirmation: PresetDeleteConfirmation } | null
  >(null);

  useEffect(() => {
    setSources(parseBookSources(settings[BOOK_SOURCES_KEY]));
  }, [settings]);

  // Seeded once rather than merged on every load, so a site the user deleted
  // does not reappear after the next launch.
  useEffect(() => {
    // Settings arrive empty on the first render. Seeding then would overwrite
    // a list the user had already curated.
    if (loading || settings[BOOK_SOURCES_SEEDED_KEY] === "true") return;
    const seeded = [...BUILT_IN_BOOK_SOURCES];
    setSources(seeded);
    void saveBulk({
      [BOOK_SOURCES_KEY]: serializeBookSources(seeded),
      [BOOK_SOURCES_SEEDED_KEY]: "true",
    });
  }, [loading, settings, saveBulk]);

  const persist = (next: BookSource[]) => {
    setSources(next);
    saveBulk({ [BOOK_SOURCES_KEY]: serializeBookSources(next) })
      .then(() => showSavedToast())
      .catch((error) => console.error("Failed to save book sources:", error));
  };

  const deleteSource = (id: string) => {
    setPendingDelete(null);
    persist(sources.filter((item) => item.id !== id));
  };
  const requestDelete = (source: BookSource) => {
    // "Last one" means the whole list, not the group: emptying 图书馆 while
    // 第三方资源站 still has entries leaves the reader with somewhere to go.
    const confirmation = presetDeleteConfirm("builtin", sources.length <= 1, "sources", source.name);
    if (!confirmation) {
      deleteSource(source.id);
      return;
    }
    setPendingDelete({ id: source.id, confirmation });
  };

  const grouped = useMemo(
    () => KINDS.map((kind) => ({ kind, items: sources.filter((source) => source.kind === kind) })),
    [sources],
  );

  const startEdit = (source: BookSource) => {
    setAdding(false);
    setEditingId(source.id);
    setDraft({ ...source });
  };

  const startAdd = () => {
    setEditingId(null);
    setAdding(true);
    setDraft({ id: newSourceId(), name: "", url: "", kind: "library" });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setAdding(false);
    setDraft(null);
  };

  const commitDraft = () => {
    if (!draft) return;
    const name = draft.name.trim();
    const url = draft.url.trim();
    if (!name || !isOpenableUrl(url)) return;
    const entry: BookSource = { ...draft, name, url };
    persist(
      adding
        ? [...sources, entry]
        : sources.map((source) => (source.id === entry.id ? entry : source)),
    );
    cancelEdit();
  };

  const draftValid = Boolean(draft && draft.name.trim() && isOpenableUrl(draft.url));

  const editor = (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-input/40 p-3">
      <Input
        autoFocus
        value={draft?.name ?? ""}
        placeholder={t("settings.bookSources.namePlaceholder")}
        onChange={(event) => setDraft((current) => (current ? { ...current, name: event.target.value } : current))}
      />
      <Input
        value={draft?.url ?? ""}
        placeholder="https://example.com"
        onChange={(event) => setDraft((current) => (current ? { ...current, url: event.target.value } : current))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && draftValid) commitDraft();
        }}
      />
      <div>
        <span className="mb-1.5 block text-[12px] font-medium text-text-primary">
          {t("settings.bookSources.kind")}
        </span>
        <div className="flex items-center gap-2">
          <Select
            className="min-w-0 flex-1"
            value={draft?.kind ?? "library"}
            onChange={(kind) =>
              setDraft((current) => (current ? { ...current, kind: kind as BookSourceKind } : current))}
            options={KINDS.map((kind) => ({ value: kind, label: t(`settings.bookSources.kindLabel.${kind}`) }))}
          />
          <Button variant="primary" size="md" disabled={!draftValid} onClick={commitDraft}>
            {t("common.save")}
          </Button>
          <Button
            variant="secondary"
            size="md"
            aria-label={t("common.cancel")}
            title={t("common.cancel")}
            onClick={cancelEdit}
          >
            <X size={14} />
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-[620px]">
      <p className="px-1 pb-3 text-[12px] leading-[18px] text-text-secondary">
        {t("settings.bookSources.intro")}
      </p>

      {grouped.map(({ kind, items }) => (
        <div key={kind} className="border-t border-border-light py-3">
          <p className="px-1 text-[12px] font-semibold text-text-primary">
            {t(`settings.bookSources.kindLabel.${kind}`)}
          </p>
          <p className="mt-0.5 px-1 text-[11px] leading-[17px] text-text-placeholder">
            {t(`settings.bookSources.kindHint.${kind}`)}
          </p>
          <div className="mt-2 flex flex-col gap-1">
            {items.length === 0 && (
              <p className="px-1 py-2 text-[12px] text-text-muted">{t("settings.bookSources.empty")}</p>
            )}
            {items.map((source) => (
              editingId === source.id ? (
                <div key={source.id}>{editor}</div>
              ) : (
                <div
                  key={source.id}
                  className="group flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-bg-input/60"
                >
                  <button
                    type="button"
                    onClick={() => { openUrl(source.url).catch(() => {}); }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="truncate text-[13px] text-text-primary">{source.name}</span>
                    <span className="truncate text-[11px] text-text-muted">{source.url}</span>
                    <ExternalLink size={12} className="shrink-0 text-text-muted" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("common.edit")}
                    onClick={() => startEdit(source)}
                    className="shrink-0 rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-accent-text focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label={t("common.delete")}
                    onClick={() => requestDelete(source)}
                    className="shrink-0 rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-danger-text focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )
            ))}
          </div>
        </div>
      ))}

      {adding && <div className="border-t border-border-light py-3">{editor}</div>}

      <div className="flex items-center gap-2 border-t border-border-light pt-3">
        <Button variant="secondary" size="sm" onClick={startAdd} disabled={adding}>
          <Plus size={13} />
          {t("settings.bookSources.add")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => persist(restoreBuiltInBookSources(sources))}
          title={t("settings.bookSources.restoreHint")}
        >
          <RotateCcw size={13} />
          {t("settings.bookSources.restore")}
        </Button>
      </div>

      <p className="px-1 pt-3 text-[11px] leading-[17px] text-text-placeholder">
        {t("settings.bookSources.note")}
      </p>

      {pendingDelete && (
        <ConfirmDialog
          title={t(pendingDelete.confirmation.titleKey, { name: pendingDelete.confirmation.nameParam })}
          description={pendingDelete.confirmation.descriptionKeys.map((key) => t(key)).join(" ")}
          primaryLabel={t("common.delete")}
          onPrimary={() => deleteSource(pendingDelete.id)}
          secondaryLabel={t("common.cancel")}
          onSecondary={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
