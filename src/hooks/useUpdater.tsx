import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { platform } from "../services/platform";
import {
  DISMISSED_UPDATE_VERSION_KEY,
  shouldSuppressAutoPrompt,
} from "../services/updateCheck";

/** Progress event emitted by `commands/app_update.rs` during a download. */
const PROGRESS_EVENT = "update:download-progress";

/** How long the manual "you're up to date" confirmation stays up. */
const UP_TO_DATE_MS = 4000;

/** Shape of `update_check` on the Rust side. */
interface UpdateStatus {
  available: string | null;
  notes: string | null;
  staged: boolean;
}

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  /** Offered, not yet downloaded. */
  | { kind: "available"; version: string; notes: string | null }
  /** `progress` is null when the server sent no Content-Length. */
  | { kind: "downloading"; version: string; progress: number | null }
  /** Downloaded and verified; one click from being installed. */
  | { kind: "ready"; version: string; notes: string | null }
  | { kind: "installing"; version: string }
  | { kind: "upToDate" }
  | { kind: "error" };

export interface Updater {
  state: UpdateState;
  /** `manual` shows the checking/up-to-date/error beats a click needs. */
  check: (manual: boolean) => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

const UpdaterContext = createContext<Updater | null>(null);

/**
 * One update lifecycle, shared by every surface that shows it.
 *
 * There are two entry points — the toast raised at launch or from the app menu,
 * and the row in Settings → About — and they must never disagree about what is
 * going on. They used to: the settings row kept only the version *string* out
 * of a check and threw away the `Update` object needed to act on it, so it
 * could announce a new version while offering no way to install it. Holding
 * plain serializable state in one place above both is what makes that class of
 * bug impossible rather than merely fixed.
 *
 * It also means a download started in Settings keeps running, with progress
 * intact, after the modal is closed — the state does not live in either view.
 *
 * The heavy lifting is Rust-side (`commands/app_update.rs`), which downloads
 * once, keeps the verified package on disk between runs, and installs it later
 * without re-downloading. What that buys the reader is the `ready` state: an
 * update they postponed costs one click, not another download.
 */
export function UpdaterProvider({
  active = true,
  children,
}: {
  /**
   * One window checks, one window announces. A reader window still gets a
   * provider — so nothing that calls `useUpdater` has to know which window it
   * is in — but an inactive one never checks, never listens, and stays idle.
   */
  active?: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  // Guards the check, not the download: a menu click while a download runs
  // must not start a second check behind it.
  const busy = useRef(false);
  // Mirrors `state` so the action callbacks can read the current phase without
  // taking `state` as a dependency — they must keep a stable identity, or
  // every progress tick would rebuild the context value and re-render both
  // surfaces.
  const stateRef = useRef(state);
  const activeRef = useRef(active);
  // Synced in an effect rather than during render. Nothing reads these while
  // rendering — only the action callbacks do, and those run from a click or a
  // menu event, long after the effects for that render have flushed.
  useEffect(() => {
    stateRef.current = state;
    activeRef.current = active;
  }, [state, active]);

  const check = useCallback(async (manual: boolean) => {
    if (!platform.hasUpdater || !activeRef.current || busy.current) return;
    busy.current = true;
    if (manual) setState({ kind: "checking" });
    try {
      const status = await invoke<UpdateStatus>("update_check");
      if (!status.available) {
        setState(manual ? { kind: "upToDate" } : { kind: "idle" });
        return;
      }
      // Only the silent launch check honours a dismissal. Someone who
      // explicitly asked "is there an update" gets a real answer, including
      // "yes, the one you waved away earlier".
      if (!manual) {
        const dismissed = await invoke<string | null>("get_setting", {
          key: DISMISSED_UPDATE_VERSION_KEY,
        }).catch(() => null);
        if (shouldSuppressAutoPrompt(manual, status.available, dismissed)) {
          setState({ kind: "idle" });
          return;
        }
      }
      setState({
        kind: status.staged ? "ready" : "available",
        version: status.available,
        notes: status.notes,
      });
    } catch (error) {
      console.error("Update check failed:", error);
      if (manual) setState({ kind: "error" });
    } finally {
      busy.current = false;
    }
  }, []);

  const download = useCallback(async () => {
    const current = stateRef.current;
    if (current.kind !== "available") return;
    setState({ kind: "downloading", version: current.version, progress: 0 });
    try {
      const staged = await invoke<string>("update_download");
      // Re-checking rather than trusting the version we started with: a release
      // published mid-download would otherwise leave the UI naming the old one.
      const status = await invoke<UpdateStatus>("update_check").catch(() => null);
      setState({
        kind: "ready",
        version: staged,
        notes: status?.available === staged ? status.notes : null,
      });
    } catch (error) {
      console.error("Update download failed:", error);
      setState({ kind: "error" });
    }
  }, []);

  const install = useCallback(async () => {
    const current = stateRef.current;
    if (current.kind !== "ready") return;
    setState({ kind: "installing", version: current.version });
    try {
      await invoke("update_install");
      // The new version is on disk and there is nothing worth carrying across
      // the restart, so the reader never has to press anything else.
      await relaunch();
    } catch (error) {
      console.error("Update install failed:", error);
      setState({ kind: "error" });
    }
  }, []);

  const dismiss = useCallback(() => {
    const current = stateRef.current;
    // Remember *this version*, not "a prompt happened". A staged package is
    // deliberately kept: postponing an update the reader already waited for
    // must not throw the download away. Both manual entry points bring it
    // back, and it installs without downloading again.
    if (current.kind === "available" || current.kind === "ready") {
      void invoke("set_setting", {
        key: DISMISSED_UPDATE_VERSION_KEY,
        value: current.version,
      }).catch(() => {});
    }
    setState({ kind: "idle" });
  }, []);

  useEffect(() => {
    if (!platform.hasUpdater || !active) return;
    const unlisten = listen<{ downloaded: number; total: number | null }>(
      PROGRESS_EVENT,
      ({ payload }) => {
        setState((current) => {
          if (current.kind !== "downloading") return current;
          const progress = payload.total
            ? Math.min(100, Math.round((payload.downloaded / payload.total) * 100))
            : null;
          return { ...current, progress };
        });
      },
    );
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [active]);

  useEffect(() => {
    if (!platform.hasUpdater || !active) return;
    const unlisten = listen("menu:check-for-updates", () => void check(true));
    // Absent means on: a reader who never opened the toggle still gets told
    // about a new version.
    invoke<string | null>("get_setting", { key: "auto_check_updates" })
      .then((value) => {
        if (value !== "false") void check(false);
      })
      .catch(() => {});
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [active, check]);

  useEffect(() => {
    if (state.kind !== "upToDate") return;
    const timer = window.setTimeout(() => setState({ kind: "idle" }), UP_TO_DATE_MS);
    return () => window.clearTimeout(timer);
  }, [state.kind]);

  const value = useMemo<Updater>(
    () => ({ state, check, download, install, dismiss }),
    [state, check, download, install, dismiss],
  );

  return <UpdaterContext.Provider value={value}>{children}</UpdaterContext.Provider>;
}

export function useUpdater(): Updater {
  const value = useContext(UpdaterContext);
  if (!value) throw new Error("useUpdater must be used inside UpdaterProvider");
  return value;
}
