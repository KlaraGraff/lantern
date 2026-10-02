import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { message } from "@tauri-apps/plugin-dialog";
import i18n from "../../i18n";
import { platform } from "../../services/platform";
import type { ReadingProgressWriter } from "./reading-progress-writer";

type FailureHandler = () => void;
const writers = new Map<ReadingProgressWriter, Set<FailureHandler>>();
const writerBooks = new Map<ReadingProgressWriter, string>();
let ready: Promise<void> | undefined;
let closing = false;
let activeExitRequest: number | undefined;

function reportFailure() {
  console.error("Reading progress save failed; close/exit cancelled");
  const callbacks = [...writers.values()].flatMap((items) => [...items]);
  if (callbacks.length) callbacks.forEach((callback) => callback());
  else void message(i18n.t("notes.saveFailed"), { kind: "error" }).catch(console.error);
}

async function flushAll(): Promise<boolean> {
  // Keep failed, unmounted sessions reachable for the next explicit retry.
  // A newly mounted session during the await also belongs to this exit.
  const saved = new Set<ReadingProgressWriter>();
  for (;;) {
    const pending = [...writers.keys()].filter((writer) => !saved.has(writer) || writer.hasPending());
    if (!pending.length) return true;
    for (const writer of pending) {
      if (!await writer.flush()) return false;
      saved.add(writer);
      if (writers.get(writer)?.size === 0) { writers.delete(writer); writerBooks.delete(writer); }
    }
  }
}

async function saveBeforeClose(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      flushAll(),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 15_000); }),
    ]);
  } catch (error) {
    console.error("Reading progress flush failed:", error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function initialize(): Promise<void> {
  const unlisten: (() => void)[] = [];
  try {
    const appWindow = getCurrentWebviewWindow();
    unlisten.push(await listen<number>("reader-exit-requested", async ({ payload: request }) => {
      activeExitRequest = request;
      const saved = await saveBeforeClose();
      if (activeExitRequest !== request) return;
      activeExitRequest = undefined;
      if (!saved) reportFailure();
      await invoke("reader_exit_ack", { request, saved }).catch((error) => {
        console.error("Could not acknowledge reader save:", error);
        reportFailure();
      });
    }));
    unlisten.push(await listen<number>("reader-exit-cancelled", ({ payload: request }) => {
      if (activeExitRequest !== request) return;
      activeExitRequest = undefined;
      reportFailure();
    }));
    unlisten.push(await appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closing) return;
      closing = true;
      try {
        if (!await saveBeforeClose()) { reportFailure(); return; }
        await invoke("reader_close_saved");
      } catch (error) {
        console.error("Could not close saved reader:", error);
        reportFailure();
      } finally {
        closing = false;
      }
    }));
    await invoke("reader_exit_register");
  } catch (error) {
    unlisten.forEach((stop) => stop());
    ready = undefined;
    throw error;
  }
}

/** Read the stored opening position only after an older session has saved it. */
export async function flushBookProgress(bookId: string): Promise<boolean> {
  for (const writer of writers.keys()) {
    if (writerBooks.get(writer) === bookId && !await writer.flush()) return false;
  }
  return true;
}

/** One coordinator per webview survives book switches and failed unmount saves. */
export function retainReadingProgress(writer: ReadingProgressWriter, onFailure: FailureHandler, bookId?: string): () => void {
  let callbacks = writers.get(writer);
  if (!callbacks) { callbacks = new Set(); writers.set(writer, callbacks); }
  callbacks.add(onFailure);
  if (bookId) writerBooks.set(writer, bookId);
  if (platform.hasWindow) {
    const registration = ready
      ? ready.then(() => invoke("reader_exit_register"))
      : (ready = initialize());
    void registration.catch((error) => {
      console.error("Could not register reader exit saving:", error);
      reportFailure();
    });
  }
  const flush = () => { void writer.flush(); };
  window.addEventListener("pagehide", flush);
  return () => {
    callbacks.delete(onFailure);
    window.removeEventListener("pagehide", flush);
    void writer.flush().then((saved) => {
      if (saved && callbacks.size === 0) { writers.delete(writer); writerBooks.delete(writer); }
    });
  };
}
