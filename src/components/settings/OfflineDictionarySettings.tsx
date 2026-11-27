import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Select from "../ui/Select";
import { useSettings } from "../../hooks/useSettings";
import { pickedFilePath } from "../../utils/picked-file";
import { ROW_CONTROL_WIDTH } from "./types";

type EcdictState = "not_downloaded" | "waiting" | "downloading" | "installing" | "installed" | "failed";

export interface OfflineDictionaryStatus {
  ecdict: {
    state: EcdictState;
    downloadSize: number;
    downloadedBytes: number;
    installedBytes: number | null;
    errorCode: string | null;
  };
  imported: { id: string; title: string; entries: number; bytes: number; importedAt: number }[];
}

/** Device-local (off the sync whitelist): `online` (default) or `local`. */
const SOURCE_KEY = "dictionary_source";

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);

function Row({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[52px] w-full items-center justify-between gap-4 px-1 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-text-primary">{title}</p>
        <p className="break-words text-[11px] leading-[17px] text-text-placeholder">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * The single-click lookup's local half: the ECDICT download and the reader's
 * own MDict files. Both stay on this device; neither is synced.
 */
export default function OfflineDictionarySettings() {
  const { t } = useTranslation();
  const { settings, save } = useSettings();
  const [status, setStatus] = useState<OfflineDictionaryStatus | null>(null);
  const [importing, setImporting] = useState(false);
  const [importFailed, setImportFailed] = useState(false);

  useEffect(() => {
    void invoke<OfflineDictionaryStatus>("offline_dictionary_status").then(setStatus).catch(() => {});
    const unlisten = listen<OfflineDictionaryStatus>("offline-dictionary-status-changed", (event) => {
      setStatus(event.payload);
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  const run = (command: string, args?: Record<string, unknown>) =>
    invoke<OfflineDictionaryStatus>(command, args).then(setStatus).catch(() => {});

  const importMdx = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "MDict", extensions: ["mdx"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setImporting(true);
    setImportFailed(false);
    try {
      setStatus(await invoke<OfflineDictionaryStatus>("offline_dictionary_import_mdx", {
        path: pickedFilePath(selected),
      }));
    } catch {
      setImportFailed(true);
    } finally {
      setImporting(false);
    }
  };

  const ecdict = status?.ecdict;
  const progress = ecdict && ecdict.downloadSize
    ? Math.min(100, Math.round(ecdict.downloadedBytes / ecdict.downloadSize * 100))
    : 0;
  const hasLocal = Boolean(ecdict?.state === "installed" || status?.imported.length);

  const ecdictLine = !ecdict
    ? ""
    : ecdict.state === "installed"
      ? t("settings.offlineDictionary.installed", { size: megabytes(ecdict.installedBytes ?? 0) })
      : ecdict.state === "waiting"
        ? t("settings.offlineDictionary.waiting")
        : ecdict.state === "downloading"
          ? t("settings.offlineDictionary.downloading", { progress })
          : ecdict.state === "installing"
            ? t("settings.offlineDictionary.installing")
            : ecdict.state === "failed"
              ? t("settings.offlineDictionary.failed")
              : t("settings.offlineDictionary.size", { size: megabytes(ecdict.downloadSize) });

  return (
    <div>
      <Row title={t("settings.offlineDictionary.title")} subtitle={t("settings.offlineDictionary.hint")}>
        {ecdict?.state === "installed" ? (
          <Button size="sm" variant="secondary" onClick={() => void run("offline_dictionary_remove_ecdict")}>
            {t("settings.offlineDictionary.remove")}
          </Button>
        ) : ecdict?.state === "waiting" || ecdict?.state === "downloading" ? (
          <Button size="sm" variant="secondary" onClick={() => void run("offline_dictionary_cancel")}>
            {t("common.cancel")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={!ecdict || ecdict.state === "installing"}
            onClick={() => void run("offline_dictionary_download")}
          >
            {ecdict?.state === "failed" ? t("settings.offlineDictionary.retry") : t("settings.offlineDictionary.download")}
          </Button>
        )}
      </Row>
      {ecdict ? (
        <div className="-mt-1 px-1 pb-2" role="status">
          {ecdict.state === "downloading" || ecdict.state === "installing" ? (
            <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-bg-input">
              <div className="h-full bg-accent" style={{ width: `${ecdict.state === "installing" ? 100 : progress}%` }} />
            </div>
          ) : null}
          <p className={`text-[11px] ${ecdict.state === "failed" ? "text-danger-text" : "text-text-muted"}`}>{ecdictLine}</p>
        </div>
      ) : null}

      <Row title={t("settings.offlineDictionary.mdxTitle")} subtitle={t("settings.offlineDictionary.mdxHint")}>
        <Button size="sm" variant="secondary" disabled={importing} onClick={() => void importMdx()}>
          {importing ? t("settings.offlineDictionary.mdxImporting") : t("settings.offlineDictionary.mdxImport")}
        </Button>
      </Row>
      {importFailed ? (
        <p role="alert" className="-mt-1 px-1 pb-2 text-[11px] text-danger-text">{t("settings.offlineDictionary.mdxImportFailed")}</p>
      ) : null}
      {status?.imported.length ? (
        <ul className="mb-2 space-y-1 px-1">
          {status.imported.map((dictionary) => (
            <li key={dictionary.id} className="flex items-center justify-between gap-3 rounded-lg bg-bg-input px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-[12px] font-medium text-text-primary">{dictionary.title}</p>
                <p className="text-[11px] text-text-muted">
                  {t("settings.offlineDictionary.mdxEntries", { count: dictionary.entries })}
                  {" · "}
                  {megabytes(dictionary.bytes)} MB
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void run("offline_dictionary_remove_mdx", { id: dictionary.id })}
              >
                {t("settings.offlineDictionary.remove")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {hasLocal ? (
        <Row title={t("settings.offlineDictionary.order")} subtitle={t("settings.offlineDictionary.orderHint")}>
          <Select
            className={ROW_CONTROL_WIDTH}
            value={settings[SOURCE_KEY] === "local" ? "local" : "online"}
            onChange={(value) => void save(SOURCE_KEY, value).catch(() => {})}
            options={[
              { value: "online", label: t("settings.offlineDictionary.orderOnline") },
              { value: "local", label: t("settings.offlineDictionary.orderLocal") },
            ]}
          />
        </Row>
      ) : null}
    </div>
  );
}
