import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Library, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Input from "../ui/Input";
import Select from "../ui/Select";
import {
  BOOK_SOURCES_KEY,
  bookSourceDeleteKind,
  isOpenableUrl,
  resolveBookSources,
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

export default function BookSourcesSettings({ settings, saveBulk, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<BookSource[]>(() => resolveBookSources(settings[BOOK_SOURCES_KEY]));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BookSource | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<
    { id: string; confirmation: PresetDeleteConfirmation } | null
  >(null);

  // The defaults are resolved, not seeded: a device that has never been told
  // otherwise shows the built-in catalog and writes nothing. `resolveBookSources`
  // explains at length why that matters now that the key syncs — the short of it
  // is that a write here would be stamped with this device's clock and would
  // beat a list another device curated earlier. A list arriving from a peer
  // lands in `settings` and flows through this effect like any other change.
  useEffect(() => {
    setSources(resolveBookSources(settings[BOOK_SOURCES_KEY]));
  }, [settings]);

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
    const confirmation = presetDeleteConfirm(
      bookSourceDeleteKind(source.id),
      sources.length <= 1,
      "sources",
      source.name,
    );
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

  // Reachable only by deleting every entry, but on a phone this pane is the
  // whole path to a first book, so the state that says "there is no path" has
  // to explain itself rather than show two headings over two blank groups.
  // 恢复默认 sits beside 添加来源 because it is the one-tap way back.
  const isEmpty = sources.length === 0 && !adding;

  // `touch:[&_input]:h-11` rather than a change to `Input`: the 36px field is
  // right under a mouse and the floor only applies to fingers, so the rule
  // belongs to this form, not to every input in the app.
  const editor = (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-input/40 p-3">
      <Input
        autoFocus
        className="touch:[&_input]:h-11"
        value={draft?.name ?? ""}
        placeholder={t("settings.bookSources.namePlaceholder")}
        onChange={(event) => setDraft((current) => (current ? { ...current, name: event.target.value } : current))}
      />
      <Input
        className="touch:[&_input]:h-11"
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
        {/* 「公版 & 图书馆」 is a wide option label, and beside 保存 and a
            cancel square there is nothing left of a 390px row for it. The
            picker takes the full width below `md:` and the two buttons sit
            under it. */}
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <Select
            className="min-w-0 flex-1"
            value={draft?.kind ?? "library"}
            onChange={(kind) =>
              setDraft((current) => (current ? { ...current, kind: kind as BookSourceKind } : current))}
            options={KINDS.map((kind) => ({ value: kind, label: t(`settings.bookSources.kindLabel.${kind}`) }))}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="md"
              className="flex-1 justify-center touch:h-11 md:flex-none"
              disabled={!draftValid}
              onClick={commitDraft}
            >
              {t("common.save")}
            </Button>
            <Button
              variant="secondary"
              size="md"
              className="justify-center touch:size-11 touch:px-0"
              aria-label={t("common.cancel")}
              title={t("common.cancel")}
              onClick={cancelEdit}
            >
              <X size={14} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  if (isEmpty) {
    return (
      <div className="mx-auto w-full max-w-[620px]">
        <div className="flex flex-col items-center px-4 py-10 text-center">
          <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-bg-input text-text-muted">
            <Library size={26} />
          </div>
          <p className="text-[15px] font-medium text-text-primary">
            {t("settings.bookSources.emptyTitle")}
          </p>
          <p className="mt-2 max-w-[320px] text-[13px] leading-[1.65] text-text-muted">
            {t("settings.bookSources.emptyBody")}
          </p>
          <div className="mt-5 flex w-full max-w-[260px] flex-col gap-2.5">
            <Button variant="primary" size="md" className="justify-center touch:h-11" onClick={startAdd}>
              <Plus size={14} />
              {t("settings.bookSources.add")}
            </Button>
            <Button
              variant="secondary"
              size="md"
              className="justify-center touch:h-11"
              onClick={() => persist(restoreBuiltInBookSources(sources))}
            >
              <RotateCcw size={14} />
              {t("settings.bookSources.restore")}
            </Button>
          </div>
          <p className="mt-5 max-w-[320px] text-[12px] leading-[1.65] text-text-muted">
            {t("settings.bookSources.emptySyncNote")}
          </p>
        </div>
      </div>
    );
  }

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
                    className="flex min-w-0 flex-1 items-center gap-2 text-left touch:min-h-11"
                  >
                    {/* Name and URL share one line on a desktop. At 390px the
                        two of them plus the icon and the two trailing controls
                        leave the URL about sixty pixels, which truncates every
                        address to `standarde…` — a stack of two lines says
                        both. */}
                    <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-center md:gap-2">
                      <span className="truncate text-[13px] text-text-primary">{source.name}</span>
                      <span className="truncate text-[11px] text-text-muted">{source.url}</span>
                    </span>
                    <ExternalLink size={12} className="shrink-0 text-text-muted" />
                  </button>
                  {/* `touch:opacity-100` is not a nicety. Tailwind 4 compiles
                      `group-hover:` behind `(hover: hover)`, so on a finger
                      these two never leave `opacity-0` — edit and delete would
                      be invisible and unreachable on the phone. */}
                  <button
                    type="button"
                    aria-label={t("common.edit")}
                    onClick={() => startEdit(source)}
                    className="flex shrink-0 items-center justify-center rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-accent-text focus-visible:opacity-100 group-hover:opacity-100 touch:size-11 touch:p-0 touch:opacity-100"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label={t("common.delete")}
                    onClick={() => requestDelete(source)}
                    className="flex shrink-0 items-center justify-center rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-danger-text focus-visible:opacity-100 group-hover:opacity-100 touch:size-11 touch:p-0 touch:opacity-100"
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

      <div className="flex flex-wrap items-center gap-2 border-t border-border-light pt-3">
        <Button variant="secondary" size="sm" className="touch:h-11 touch:px-3" onClick={startAdd} disabled={adding}>
          <Plus size={13} />
          {t("settings.bookSources.add")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="touch:h-11 touch:px-3"
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
