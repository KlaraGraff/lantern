/* eslint-disable @typescript-eslint/no-explicit-any -- foliate-js has no TS definitions */
export type AnnotationStyleKind = "manual" | "automatic" | "vocab";

export interface FoliateView extends HTMLElement {
  open(file: string | File | Blob): Promise<void>;
  init(opts: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
  goTo(target: string | number): Promise<any>;
  /** Navigates by whole-book fraction (0-1) — used by the P1.6 scrubber, which
   * only knows "how far across the book" rather than a CFI or section index. */
  goToFraction(fraction: number): Promise<any>;
  prev(): Promise<void>;
  next(): Promise<void>;
  close(): void;
  book: any;
  renderer: any;
  lastLocation: any;
  history: {
    back(): void;
    forward(): void;
    canGoBack: boolean;
    canGoForward: boolean;
    addEventListener: EventTarget["addEventListener"];
    removeEventListener: EventTarget["removeEventListener"];
  };
  getCFI(index: number, range: Range): string;
  resolveCFI(cfi: string): { index: number; anchor: (doc: Document) => Range };
  /**
   * Whole-book (P1.2) or single-section search, depending on whether
   * `opts.index` is set — the two modes yield different shapes (see
   * `view.js`'s `#searchBook` vs `#searchSection`).
   *
   * Whole-book (`index` omitted): yields, in order, `{ progress }` once per
   * section scanned (0-1, monotonic), `{ label, subitems }` once per section
   * that has a match (label from the TOC, subitems in document order), and
   * finally a bare `"done"` sentinel. No `{ progress }` reaches 1 exactly
   * until the last matching section's yield.
   *
   * Single-section (`index` set — used for citation lookup): yields one bare
   * `FoliateSearchHit` (`{ cfi, excerpt }`) per match in that section, in
   * document order, then `"done"`. No `{ progress }` is ever yielded in this
   * mode.
   *
   * Every match is also auto-annotated on the view as it's found —
   * `clearSearch()`, which this calls internally before starting, removes
   * them, so a fresh search's own overlays double as cleanup for the last one.
   */
  search(opts: {
    query: string;
    index: number;
    matchCase?: boolean;
    matchDiacritics?: boolean;
    matchWholeWords?: boolean;
  }): AsyncGenerator<FoliateSearchSectionYield>;
  search(opts: {
    query: string;
    index?: undefined;
    matchCase?: boolean;
    matchDiacritics?: boolean;
    matchWholeWords?: boolean;
  }): AsyncGenerator<FoliateSearchYield>;
  clearSearch(): void;
  getSectionFractions(): number[];
  addAnnotation(annotation: {
    value: string;
    color?: string;
    styleKind?: AnnotationStyleKind;
  }): Promise<any>;
  deleteAnnotation(annotation: { value: string }): Promise<void>;
  deselect(): void;
  /**
   * Resolves the raw TOC item covering `target` by re-parsing that section's
   * document — more expensive than the `tocItem` already delivered on every
   * `relocate` event, so prefer that event's payload for hot-path matching
   * and reserve this for on-demand lookups.
   */
  getTOCItemOf(target: string | number): Promise<FoliateTocItem | undefined>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** One text match, as `view.search()` yields it — `cfi` is a point CFI into the match. */
export interface FoliateSearchHit {
  cfi: string;
  excerpt: {
    pre: string;
    match: string;
    post: string;
  };
}

/** Everything a whole-book `view.search()` generator can yield; see `FoliateView.search`. */
export type FoliateSearchYield =
  | { progress: number }
  | { label: string; subitems: FoliateSearchHit[] }
  | "done";

/** Everything a single-section `view.search({ index })` generator can yield — used for citation lookup. */
export type FoliateSearchSectionYield = FoliateSearchHit | "done";

/** A raw `book.toc` entry, after foliate-js's `TOCProgress.assignIDs()` has stamped it with a stable `id`. */
export interface FoliateTocItem {
  id?: number;
  href?: string;
  label?: string;
  subitems?: FoliateTocItem[];
}

export interface TocChapter {
  title: string;
  href?: string;
  targetHref?: string;
  depth: number;
  /** Stable id assigned by foliate-js's `TOCProgress.assignIDs()`; used to match the engine's current-chapter reports. */
  id?: number;
  /** Raw Foliate section where this TOC target begins, when resolvable. */
  sectionIndex?: number;
  /** True when this target shares a raw section with another TOC fragment. */
  sectionFragment?: string;
}

export interface ReaderPageInfo {
  current: number;
  visibleEnd?: number;
  total: number;
}

export interface ReaderNavigation {
  navigationId?: string;
  cfi?: string;
  page?: number;
  openVocab?: boolean;
  openChat?: boolean;
  chatId?: string;
}
