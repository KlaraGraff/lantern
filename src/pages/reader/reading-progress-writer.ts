import { updateReadingProgress } from "../../hooks/useBooks";

interface Position { bookId: string; progress: number; cfi: string; sequence: number }
// A → B → A can leave an older session saving while its replacement starts.
// Serialize each book and never retry an obsolete position over a newer one.
let nextSequence = 0;
const newestPosition = new Map<string, number>();
const bookWrites = new Map<string, Promise<boolean>>();

export class ReadingProgressWriter {
  private pending: Position | null = null;
  private timer: number | null = null;
  private inFlight: Promise<boolean> | null = null;
  private autoSave: boolean;

  /**
   * Fired when a flush cleared the §2.2 auto-finish gate on the backend, so
   * the caller can reflect the book's new "finished" status locally without
   * waiting for a full refetch — mainly so the book-finished hint (which
   * reads local book status) disappears the moment it should rather than
   * lingering until the reader next revisits the book.
   */
  constructor(private readonly onAutoFinished?: (bookId: string) => void, autoSave = true) {
    this.autoSave = autoSave;
  }

  hasPending(): boolean {
    return this.pending !== null || this.inFlight !== null;
  }

  setAutoSave(enabled: boolean): void {
    this.autoSave = enabled;
    if (!enabled && this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (enabled && this.pending && this.timer === null && !this.inFlight) this.schedule(750);
  }

  /**
   * The §2.2 auto-finish coverage check's denominator (how many screens the
   * whole book takes) is computed entirely on the backend now — see
   * `reading_behavior::estimate_total_book_screens` in
   * `commands/reading_behavior.rs` — from this book's own recorded reading
   * history, not from anything the reader UI passes in here. It used to be
   * threaded through from `view.renderer?.pages`, foliate's current-*chapter*
   * page count, which silently measured the wrong thing (see the removed
   * `totalScreens` plumbing this replaces, in `useFoliateView.ts`).
   */
  queue(bookId: string, progress: number, cfi: string): void {
    const sequence = ++nextSequence;
    newestPosition.set(bookId, sequence);
    this.pending = { bookId, progress, cfi, sequence };
    if (!this.autoSave || this.timer !== null || this.inFlight) return;
    this.schedule(750);
  }

  private schedule(delay: number): void {
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush(false);
    }, delay);
  }

  async flush(drain = true): Promise<boolean> {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      if (!await this.inFlight) return false;
      return drain ? this.flush() : true;
    }
    const pending = this.pending;
    if (!pending) return true;
    this.pending = null;
    this.inFlight = this.write(pending, bookWrites.get(pending.bookId));
    const writing = this.inFlight;
    bookWrites.set(pending.bookId, writing);
    const saved = await writing;
    this.inFlight = null;
    if (bookWrites.get(pending.bookId) === writing) bookWrites.delete(pending.bookId);
    return saved && drain && this.pending ? this.flush() : saved;
  }

  private async write(pending: Position, previous?: Promise<boolean>): Promise<boolean> {
    let saved = false;
    try {
      if (previous) await previous;
      if (newestPosition.get(pending.bookId) !== pending.sequence) {
        saved = true;
        return true;
      }
      const autoFinished = await updateReadingProgress(pending.bookId, pending.progress, pending.cfi);
      saved = true;
      if (autoFinished) this.onAutoFinished?.(pending.bookId);
      return true;
    } catch {
      // Keep the exit position available for an explicit retry.
      this.pending ??= pending;
      return false;
    } finally {
      if (saved && this.autoSave && this.pending) this.schedule(250);
    }
  }
}
