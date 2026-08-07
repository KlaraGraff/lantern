/**
 * The fake library the harness renders.
 *
 * Chosen to exercise branches rather than to look pretty. Concretely:
 *
 *  - Three books, not one: an EPUB that is `reading` with progress and a CFI
 *    (the reader's happy path), a `finished` EPUB (the finished-badge and
 *    review branches), and a PDF that is `unread` (the PDF renderer, a
 *    different code path in `useFoliateView`).
 *  - One book is `available: false` so the missing-file banner renders.
 *  - Vocabulary spans every mastery level, including one due for review, so
 *    the sidebar's due-count badge is non-zero and the review piles are not
 *    all empty.
 *  - Settings are a real mix of on and off. A settings map where every toggle
 *    is off exercises exactly one side of every conditional in the modal.
 *
 * The two book files are the *real* EPUB and PDF fixtures already committed
 * under `tests/fixtures/reader-compat/`, served by the harness Vite middleware.
 * Nothing here invents a parallel book format.
 */
import { activeScene } from "./promo";

const DAY = 86_400_000;
const now = Date.now();
const ago = (days: number) => Math.floor((now - days * DAY) / 1000);

/** A tiny inline cover so the grid has something to lay out. */
function cover(label: string, bg: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">` +
    `<rect width="300" height="450" fill="${bg}"/>` +
    `<text x="150" y="230" font-family="Georgia,serif" font-size="34" fill="#fff" ` +
    `text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export interface HarnessBook {
  id: string;
  title: string;
  author: string;
  description: string | null;
  cover_path: string | null;
  file_path: string;
  format: string;
  source_format: string | null;
  source_sha256: string | null;
  render_format: string | null;
  preparation_state: string;
  preparation_error: string | null;
  genre: string | null;
  pages: number | null;
  status: string;
  progress: number;
  current_cfi: string | null;
  created_at: number;
  updated_at: number;
  available: boolean;
  cover_data: string | null;
}

export const BOOKS: HarnessBook[] = [
  {
    id: "book-epub-reading",
    title: "The Wind in the Willows",
    author: "Kenneth Grahame",
    description: "A riverbank, a wild wood, and four friends who keep losing each other.",
    cover_path: "/harness/library/willows.jpg",
    file_path: "/harness/library/willows.epub",
    format: "epub",
    source_format: "epub",
    source_sha256: "a".repeat(64),
    render_format: "epub",
    preparation_state: "ready",
    preparation_error: null,
    genre: "Fiction",
    pages: 284,
    status: "reading",
    progress: 37,
    current_cfi: "epubcfi(/6/4!/4/2/2[chapter]/2)",
    created_at: ago(40),
    updated_at: ago(1),
    available: true,
    cover_data: cover("Willows", "#3f6b4f"),
  },
  {
    id: "book-epub-finished",
    title: "Meditations",
    author: "Marcus Aurelius",
    description: "Notes a Roman emperor wrote to nobody but himself.",
    cover_path: "/harness/library/meditations.jpg",
    file_path: "/harness/library/meditations.epub",
    format: "epub",
    source_format: "epub",
    source_sha256: "b".repeat(64),
    render_format: "epub",
    preparation_state: "ready",
    preparation_error: null,
    genre: "Philosophy",
    pages: 190,
    status: "finished",
    progress: 100,
    current_cfi: "epubcfi(/6/14!/4/2/40)",
    created_at: ago(120),
    updated_at: ago(9),
    available: true,
    cover_data: cover("Meditations", "#5a4a6b"),
  },
  {
    // Unread PDF, and the file is gone: the missing-file banner and the
    // "unavailable" path in `check_book_available` both render.
    id: "book-pdf-unread",
    title: "A Field Guide to Lichens",
    author: "Irene Baum",
    description: null,
    cover_path: null,
    file_path: "/harness/library/lichens.pdf",
    format: "pdf",
    source_format: "pdf",
    source_sha256: "c".repeat(64),
    render_format: "pdf",
    preparation_state: "ready",
    preparation_error: null,
    genre: "Science",
    pages: 56,
    status: "unread",
    progress: 0,
    current_cfi: null,
    created_at: ago(4),
    updated_at: ago(4),
    available: false,
    cover_data: null,
  },
];

export const COLLECTIONS = [
  { id: "col-nightstand", name: "Nightstand", book_count: 2, sort_order: 0, created_at: ago(60), updated_at: ago(2) },
  { id: "col-reference", name: "Reference", book_count: 1, sort_order: 1, created_at: ago(30), updated_at: ago(30) },
];

/** Every mastery band represented, one of them due today. */
export const VOCAB = [
  mkWord("vw-1", "riverbank", 0, "The mole found himself on the riverbank.", ago(3), 0),
  mkWord("vw-2", "gregarious", 1, "A gregarious creature by any measure.", ago(6), -1),
  mkWord("vw-3", "obstinate", 2, "He was obstinate about the boat.", ago(11), 5),
  mkWord("vw-4", "equanimity", 3, "Bear it with equanimity.", ago(20), 14),
  mkWord("vw-5", "providence", 4, "Providence, he called it.", ago(45), 60),
  mkWord("vw-6", "caravan", 1, "The caravan stood in the yard.", ago(2), -2),
];

function mkWord(
  id: string,
  word: string,
  mastery: number,
  context: string,
  createdAt: number,
  dueInDays: number,
) {
  return {
    id,
    word,
    normalized_word: word.toLowerCase(),
    lemma: word.toLowerCase(),
    language: "en",
    definition: `Definition of ${word} for the harness fixture.`,
    translation: `${word} 的释义`,
    phonetic: `/ˈharnəs/`,
    context_sentence: context,
    book_id: "book-epub-reading",
    book_title: "The Wind in the Willows",
    cfi: "epubcfi(/6/4!/4/2/2)",
    mastery,
    mastery_level: mastery,
    review_count: mastery * 2,
    created_at: createdAt,
    updated_at: createdAt,
    last_reviewed_at: mastery > 0 ? createdAt : null,
    due_at: Math.floor((now + dueInDays * DAY) / 1000),
    notes: null,
    tags: [],
    source: "reader",
  };
}

export const HIGHLIGHTS = [
  {
    id: "hl-1",
    book_id: "book-epub-reading",
    cfi_range: "epubcfi(/6/4!/4/2/2,/1:0,/1:42)",
    color: "yellow",
    text_content: "Believe me, my young friend, there is nothing.",
    created_at: ago(5),
    updated_at: ago(5),
  },
  {
    id: "hl-2",
    book_id: "book-epub-reading",
    cfi_range: "epubcfi(/6/4!/4/2/6,/1:0,/1:30)",
    color: "blue",
    text_content: "Simply messing about in boats.",
    created_at: ago(2),
    updated_at: ago(2),
  },
];

/**
 * Highlights nobody drew. The backend derives these per read (see
 * `commands/auto_highlights.rs`); the harness keeps a mutable copy so that
 * 「不再显示」 and 「留下」 visibly remove a row instead of leaving the panel
 * arguing with a frozen fixture.
 */
export const AUTO_HIGHLIGHTS = [
  {
    anchor: "lookup:lr-1",
    book_id: "book-epub-reading",
    cfi: "epubcfi(/6/4!/4/2/4,/1:0,/1:58)",
    text: "The Mole had been working very hard all the morning, spring-cleaning his little home.",
    source: "lookup",
    label: "whitewash",
    created_at: ago(4),
  },
  {
    anchor: "chat:cm-1:0",
    book_id: "book-epub-reading",
    cfi: "epubcfi(/6/4!/4/2/8,/1:0,/1:44)",
    text: "Never in his life had he seen a river before.",
    source: "chat",
    label: null,
    created_at: ago(3),
  },
  {
    anchor: "lookup:lr-2",
    book_id: "book-epub-reading",
    cfi: "epubcfi(/6/4!/4/2/12,/1:0,/1:51)",
    text: "He thought his happiness was complete when suddenly he stood by the edge.",
    source: "lookup",
    label: "sedge",
    created_at: ago(1),
  },
];

export const BOOKMARKS = [
  {
    id: "bm-1",
    book_id: "book-epub-reading",
    cfi: "epubcfi(/6/4!/4/2/10)",
    label: "The picnic",
    created_at: ago(3),
    updated_at: ago(3),
  },
];

export const NOTES = [
  {
    id: "note-1",
    book_id: "book-epub-reading",
    anchor_kind: "selection",
    normalized_word: null,
    scope: "book",
    location: "epubcfi(/6/4!/4/2/2)",
    selected_text: "messing about in boats",
    content: "Come back to this — the whole book is in this line.",
    content_format: "markdown",
    created_at: ago(3),
    updated_at: ago(3),
  },
];

export const CHATS = [
  {
    id: "chat-1",
    book_id: "book-epub-reading",
    title: "Who is Ratty?",
    created_at: ago(4),
    updated_at: ago(4),
    message_count: 2,
    pinned: false,
  },
];

export const CHAT_MESSAGES = [
  {
    id: "msg-1",
    chat_id: "chat-1",
    role: "user",
    content: "Who is Ratty?",
    created_at: ago(4),
    updated_at: ago(4),
    reasoning: null,
    citations: [],
    model: null,
    error: null,
  },
  {
    id: "msg-2",
    chat_id: "chat-1",
    role: "assistant",
    content: "The Water Rat — Mole's companion, and the one who owns the boat.",
    created_at: ago(4),
    updated_at: ago(4),
    reasoning: null,
    citations: [],
    model: "harness-model",
    error: null,
  },
];

/**
 * A real mix: dark theme off, some assistance on, some off. The point is that
 * every conditional in the settings modal has a chance of taking either branch.
 */
export const SETTINGS: Record<string, string> = {
  theme: "system",
  language: "en",
  app_zoom: "100",
  library_view: "grid",
  library_sort: "recent",
  // The first-run card is modal and covers the library, so it is "done" by
  // default. Add `?onboarding=1` to the harness URL to sweep it instead —
  // see `resolveSettings()` below.
  onboarding_state: "done",
  // Set, so the library's "you never picked a level" hint stays down. The
  // other reason that banner fires (AI unconfigured) is covered by the
  // credential fixture in `invoke-fixtures.ts`.
  cefr_level: "B2",
  ai_enabled: "true",
  ai_streaming: "true",
  ai_auto_title: "false",
  ai_vector_retrieval: "false",
  reading_mode: "paginated",
  font_family: "Bookerly",
  font_size: "18",
  line_height: "1.6",
  page_margin: "48",
  text_align: "justify",
  theme_reader: "sepia",
  auto_analysis_enabled: "true",
  speech_provider: "edge",
  speech_voice: "en-US-AriaNeural",
  speech_rate: "1.0",
  vocab_marks_enabled: "true",
  lookup_marks_enabled: "false",
  passive_vocab_enabled: "true",
  auto_update_check: "true",
  sync_enabled: "false",
  mcp_enabled: "false",
  ocr_enabled: "false",
  keyboard_page_turn: "true",
  continuous_read_aloud: "false",
  selection_menu_actions: "lookup,translate,highlight,note",
};

/**
 * URL knobs, so one harness build can sweep more than one starting state
 * without editing a fixture:
 *   `?onboarding=1`  — start with the first-run card showing
 *   `?empty=1`       — start with an empty library (empty-state coverage)
 *   `?lang=zh`       — start in Simplified Chinese
 *   `?shot=<name>`   — a README screenshot scene (see `harness/promo/`)
 *
 * `?shot=` is applied before the others so an explicit `?lang=` still wins
 * over the scene's own choice.
 */
export function resolveSettings(): Record<string, string> {
  const settings = { ...SETTINGS, ...(activeScene()?.settings ?? {}) };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return settings;
  }
  if (params.get("onboarding") === "1") delete settings.onboarding_state;
  if (params.get("lang")) settings.language = String(params.get("lang"));
  return settings;
}

export function emptyLibrary(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("empty") === "1";
  } catch {
    return false;
  }
}
