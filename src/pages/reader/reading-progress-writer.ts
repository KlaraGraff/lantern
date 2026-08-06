import { updateReadingProgress } from "../../hooks/useBooks";

export class ReadingProgressWriter {
  private pending: { bookId: string; progress: number; cfi: string } | null = null;
  private timer: number | null = null;
  private inFlight = false;

  /**
   * Fired when a flush cleared the §2.2 auto-finish gate on the backend, so
   * the caller can reflect the book's new "finished" status locally without
   * waiting for a full refetch — mainly so the book-finished hint (which
   * reads local book status) disappears the moment it should rather than
   * lingering until the reader next revisits the book.
   */
  constructor(private readonly onAutoFinished?: (bookId: string) => void) {}

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
    this.pending = { bookId, progress, cfi };
    if (this.timer !== null || this.inFlight) return;
    this.schedule(750);
  }

  private schedule(delay: number): void {
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) return;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.inFlight = true;
    try {
      const autoFinished = await updateReadingProgress(pending.bookId, pending.progress, pending.cfi);
      if (autoFinished) this.onAutoFinished?.(pending.bookId);
    } catch {
      // A newer position is more useful than retrying an older failed write.
    } finally {
      this.inFlight = false;
      if (this.pending) this.schedule(250);
    }
  }
}
