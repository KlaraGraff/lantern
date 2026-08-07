import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Mirrors `ContextLineProgress` on the Rust side once `context_line_progress`
 * exists (see docs/impls/contextual-retrieval.md, phase ②). The command is
 * not registered yet as of this writing — this hook is the seam that lets
 * the settings row degrade cleanly until it lands, and keeps working
 * unchanged once it does.
 */
export interface ContextLineProgress {
  book_id: string;
  book_title: string;
  /** Chunks that already have a context line. */
  done: number;
  /** Chunks in the book. */
  total: number;
  /** Chunks that ended without one (soft failure — the book stays searchable). */
  failed: number;
  running: boolean;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** `null` — nothing to show. `"unavailable"` — the command is not registered. */
export type ProgressProbe = ContextLineProgress | null | "unavailable";

/**
 * The distinction the poller needs and the row does not: "no book is being
 * processed" and "this build has no such command" both render as the plain
 * row, but only the second one means polling can never succeed.
 */
export async function probeContextLineProgress(invokeFn: InvokeFn = invoke): Promise<ProgressProbe> {
  try {
    return (await invokeFn<ContextLineProgress | null>("context_line_progress")) ?? null;
  } catch {
    return "unavailable";
  }
}

/**
 * Fetches the current progress, tolerating a backend that does not know the
 * command yet. Exported standalone (rather than only through the hook) so the
 * "must not throw" contract can be unit tested without React.
 */
export async function fetchContextLineProgress(
  invokeFn: InvokeFn = invoke,
): Promise<ContextLineProgress | null> {
  const probe = await probeContextLineProgress(invokeFn);
  // Command not registered, or the call failed for any other reason — the
  // row simply falls back to its non-progress states. Never noisy: a console
  // full of the same rejection would drown out everything else while the
  // backend catches up.
  return probe === "unavailable" ? null : probe;
}

/**
 * Resumes a book's context-line generation from where it stopped. Same
 * graceful no-op as `fetchContextLineProgress` when the command is absent —
 * the caller decides what to do next (typically: refresh).
 */
export async function resumeContextLines(bookId: string, invokeFn: InvokeFn = invoke): Promise<void> {
  try {
    await invokeFn("resume_context_lines", { bookId });
  } catch {
    // No-op: see fetchContextLineProgress.
  }
}

const POLL_MS = 2000;

/**
 * Polls context-line progress for the settings row. Returns `null` whenever
 * there is nothing to show (no book running, or the command isn't there
 * yet) — callers should treat `null` as "render the normal row", not as an
 * error state.
 */
export function useContextLineProgress(pollMs = POLL_MS) {
  const [progress, setProgress] = useState<ContextLineProgress | null>(null);
  // Tauri registers its commands once at startup, so a single rejection is
  // proof the command is absent from this build — not a transient failure.
  // Without this the settings panel would fire a doomed IPC call every two
  // seconds for as long as it stays open.
  const [available, setAvailable] = useState(true);

  const refresh = useCallback(async () => {
    const probe = await probeContextLineProgress();
    if (probe === "unavailable") {
      setAvailable(false);
      setProgress(null);
      return;
    }
    setProgress(probe);
  }, []);

  useEffect(() => {
    if (!available) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [available, refresh, pollMs]);

  return { progress, refresh };
}
