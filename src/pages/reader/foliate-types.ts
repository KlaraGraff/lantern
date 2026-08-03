/* eslint-disable @typescript-eslint/no-explicit-any -- foliate-js has no TS definitions */
export type AnnotationStyleKind = "manual" | "automatic" | "vocab";

export interface FoliateView extends HTMLElement {
  open(file: string | File | Blob): Promise<void>;
  init(opts: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
  goTo(target: string | number): Promise<any>;
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
  search(opts: {
    query: string;
    index?: number;
    matchCase?: boolean;
    matchDiacritics?: boolean;
    matchWholeWords?: boolean;
  }): AsyncGenerator<{ cfi?: string; excerpt?: any; progress?: number } | "done">;
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
