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
/**
 * Unix **milliseconds**, like every timestamp the real backend writes: migration
 * 009 converted every synced table to `INTEGER` unix millis, `next_review_at`
 * included, and nothing has written seconds since. This used to divide by 1000,
 * which is why the reader panel rendered notes as `20653d ago` — the app was
 * reading a 1970s date and reporting it faithfully.
 */
const ago = (days: number) => now - days * DAY;

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
    // Without this the saved list filters every fixture word out
    // (`useDictionary` keeps only `confirmed` rows) and the whole vocabulary
    // surface renders as the empty state — nothing below it ever gets swept.
    list_status: "confirmed",
    mastery,
    mastery_level: mastery,
    review_count: mastery * 2,
    created_at: createdAt,
    updated_at: createdAt,
    last_reviewed_at: mastery > 0 ? createdAt : null,
    due_at: now + dueInDays * DAY,
    notes: null,
    tags: [],
    source: "reader",
  };
}

/**
 * A whole learning card as `vocab_words.card_snapshot` stores it — the shape
 * `LearningCardResult` serialises to. `context_meaning` and `source_excerpt`
 * are in here on purpose: the vocabulary panel prints both from their own
 * columns and has to drop them from the snapshot rather than draw them twice.
 */
export const CARD_SNAPSHOT = {
  version: 1,
  kind: "word",
  sourceText: "gregarious",
  modules: {
    context_meaning: { summary: "Sociable — happiest with company around." },
    source_excerpt: { quote: "A gregarious creature by any measure." },
    word_info: {
      heading: "gregarious · adjective",
      meta: ["/ɡrɪˈɡeəriəs/", "formal-ish"],
    },
    common_senses: {
      items: [
        {
          title: "Fond of company",
          meta: ["of people", "most common"],
          text: "Enjoys being around others rather than alone.",
          examples: [{ source: "A gregarious host, never happier than mid-party.", target: "很爱热闹的主人。" }],
        },
        {
          title: "Living in flocks or herds",
          meta: ["of animals", "technical"],
          text: "The biologist's sense, and the older one.",
        },
      ],
    },
    collocations: {
      details: [
        "**a gregarious personality** — the usual pairing",
        "**gregarious by nature** — hedges it as a disposition, not a mood",
      ],
    },
    morphology: {
      summary: "From Latin *grex* (flock) — the same root as **congregate** and **segregate**.",
    },
    synonyms: {
      items: [
        { title: "sociable", text: "Plainer, and says nothing about how much company." },
        { title: "outgoing", text: "About making the first move; gregarious is about wanting the crowd." },
      ],
    },
    usage: { summary: "Warm rather than neutral — it reads as a compliment." },
    memory_aid: { summary: "**Greg** brings the **crew**: *grex* is a flock." },
  },
};

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
  // The two turns below exist so the sweep reaches the alias disclosure at
  // all. It only renders off `metadata.aliasResolution`, which no real
  // harness call can produce — the resolution arrives on a per-request Tauri
  // event, and there is no AI backend here to fire one. Without these the
  // whole medium/low/picker/receipt path is unreachable in the browser and
  // in CI.
  {
    id: "msg-3",
    chat_id: "chat-1",
    role: "user",
    content: "老鼠后来怎么样了？",
    created_at: ago(3),
    updated_at: ago(3),
    reasoning: null,
    citations: [],
    model: null,
    error: null,
  },
  {
    id: "msg-4",
    chat_id: "chat-1",
    role: "assistant",
    content: "The Water Rat stays on the river to the end, still keeping his boat.",
    created_at: ago(3),
    updated_at: ago(3),
    reasoning: null,
    citations: [],
    model: "harness-model",
    error: null,
    metadata: JSON.stringify({
      aliasResolution: {
        confidence: "medium",
        matched: [{ alias: "老鼠", canonicals: ["Water Rat", "Field Mouse"] }],
        defaultCanonical: "Water Rat",
      },
    }),
  },
  {
    id: "msg-5",
    chat_id: "chat-1",
    role: "user",
    content: "那个总爱开快车的家伙后来怎么样了？",
    created_at: ago(2),
    updated_at: ago(2),
    reasoning: null,
    citations: [],
    model: null,
    error: null,
  },
  {
    id: "msg-6",
    chat_id: "chat-1",
    role: "assistant",
    // Names a canonical in its prose on purpose: the low-confidence confirm
    // button has no name in its payload and reads one out of the answer.
    content: "Mr. Toad gives up motor-cars after Toad Hall is won back, or says he does.",
    created_at: ago(2),
    updated_at: ago(2),
    reasoning: null,
    citations: [],
    model: "harness-model",
    error: null,
    metadata: JSON.stringify({
      aliasResolution: { confidence: "low", matched: [], defaultCanonical: null },
    }),
  },
];

/**
 * Saved passage explanations — field for field the `Explanation` struct in
 * `src-tauri/src/commands/explanations.rs`, which is also the `Explanation`
 * interface in `src/hooks/useExplanations.ts`.
 *
 * These share the "问答" list with `CHATS`, so the timestamps are chosen to
 * straddle the one chat (`ago(4)`): the merged timeline in `useQaTimeline`
 * sorts both kinds into one list, and a seed where every explanation is newer
 * than every chat would render as two blocks and never prove the interleave.
 *
 * Branch coverage, in the order `QaContent` reads them:
 *  - `cfi`: one row carries a real one and one is empty. The "jump back to
 *    source" button only renders for a non-empty `cfi`, so both rows are
 *    needed to walk each side of it.
 *  - `chapter`: nullable, and the meta line drops it with a `.filter(Boolean)`
 *    rather than printing an empty segment — one row leaves it null.
 *  - `explanation`: markdown, not plain text, because the body goes through
 *    `AiMarkdown`; and long enough that the collapsed `line-clamp-3` and the
 *    expanded state actually differ when the sweep clicks the row.
 *  - Two books, so the book filter's facet dropdown has something to switch
 *    between.
 *
 * `variant` matches what `current_variant` would compute against the harness
 * settings below (`cefr_level: "B2"`, no `explanation_mode` key, so the
 * default mode) — nothing reads it, but a fixture that contradicts its own
 * settings map is a trap for whoever reads it next.
 *
 * Timestamps go through the shared `ago()`, which is what keeps these rows in
 * the same unit as `CHATS` — the two kinds are sorted against each other in
 * one list, and a seed where they disagree on units doesn't interleave, it
 * segregates.
 */
export const EXPLANATIONS = [
  {
    id: "exp-1",
    book_id: "book-epub-reading",
    passage: "Believe me, my young friend, there is nothing—absolutely nothing—half so much worth doing as simply messing about in boats.",
    normalized_passage: "believe me, my young friend, there is nothing—absolutely nothing—half so much worth doing as simply messing about in boats.",
    explanation:
      "**messing about** here is not *making a mess*. It is the idle, unhurried pottering you do when the doing is the point and there is no errand at the end of it.\n\n- **mess about** (BrE) — to spend time with no particular aim\n- **worth doing** — the gerund is what carries the value judgement\n\nRat is not recommending boats. He is recommending having nowhere to be.",
    context_sentence: "The Rat said nothing, but stooped and unfastened a rope and hauled on it.",
    chapter: "The River Bank",
    cfi: "epubcfi(/6/4!/4/2/8,/1:0,/1:118)",
    variant: "adaptive_bilingual|B2",
    provider_profile_id: "profile-harness",
    model: "harness-model",
    saved: true,
    created_at: ago(0.5),
    updated_at: ago(0.5),
    book_title: "The Wind in the Willows",
  },
  {
    // No CFI: the explain came off a passage the reader typed or pasted rather
    // than selected, so there is nothing to jump back to and the button hides.
    id: "exp-2",
    book_id: "book-epub-reading",
    passage: "The Mole had been working very hard all the morning, spring-cleaning his little home.",
    normalized_passage: "the mole had been working very hard all the morning, spring-cleaning his little home.",
    explanation:
      "过去完成进行时（*had been working*）在这里做的事很具体：它把「一上午都在干活」压成背景，好让下一句的**突然放弃**有东西可以对照。\n\n换成一般过去时 *worked*，那一上午就成了一件已经结束的事，后面的转折也就没什么可转的了。",
    context_sentence: null,
    chapter: null,
    cfi: "",
    variant: "adaptive_bilingual|B2",
    provider_profile_id: null,
    model: null,
    saved: true,
    created_at: ago(3),
    updated_at: ago(3),
    book_title: "The Wind in the Willows",
  },
  {
    // Older than the chat above it, so the merged timeline has to interleave
    // rather than concatenate. Second book, so the facet dropdown has two.
    id: "exp-3",
    book_id: "book-epub-finished",
    passage: "You have power over your mind — not outside events. Realize this, and you will find strength.",
    normalized_passage: "you have power over your mind — not outside events. realize this, and you will find strength.",
    explanation:
      "The sentence turns on a contrast the English keeps implicit: `over your mind` / `not outside events`.\n\n> 能支配的是判断，不是遭遇。\n\n*Realize* is imperative, not descriptive — Marcus is issuing himself an instruction, which is what most of this book is.",
    context_sentence: "Written to himself on campaign, not for publication.",
    chapter: "Book VIII",
    cfi: "epubcfi(/6/14!/4/2/26,/1:0,/1:92)",
    variant: "adaptive_bilingual|B2",
    provider_profile_id: "profile-harness",
    model: "harness-model",
    saved: true,
    created_at: ago(11),
    updated_at: ago(6),
    book_title: "Meditations",
  },
];

/**
 * Field for field the shape of `AliasGroupView` in
 * `src-tauri/src/ai/grounding/aliases.rs` — `entries`, not `aliases`, and no
 * group-level `mentions`. The section reads `group.entries` directly, so a
 * fixture that drifts from the struct does not render wrong, it throws.
 *
 * The last group is descriptions-only on purpose: those rows are the one thing
 * in the table a rebuild cannot reconstruct, and they render differently
 * enough (marked ≈, carrying the question that taught them) that the sweep
 * should walk that branch rather than only the name one.
 */
export const PERSON_ALIAS_GROUPS = [
  {
    canonical: "Water Rat",
    entries: [
      { id: "pa-1", alias: "Ratty", source: "auto", mentions: 214, kind: "name", sourceQuery: null },
      { id: "pa-2", alias: "河鼠", source: "auto", mentions: 214, kind: "name", sourceQuery: null },
      { id: "pa-3", alias: "老鼠", source: "auto", mentions: 214, kind: "name", sourceQuery: null },
    ],
  },
  {
    canonical: "Mr. Toad",
    entries: [
      { id: "pa-4", alias: "蟾蜍", source: "auto", mentions: 301, kind: "name", sourceQuery: null },
      { id: "pa-5", alias: "托德先生", source: "user", mentions: 301, kind: "name", sourceQuery: null },
      {
        id: "pa-8",
        alias: "那个开汽车闯祸的",
        source: "user",
        mentions: 301,
        kind: "description",
        sourceQuery: "那个开汽车闯祸的后来怎么样了",
      },
    ],
  },
  {
    canonical: "Field Mouse",
    entries: [
      { id: "pa-6", alias: "老鼠", source: "auto", mentions: 12, kind: "name", sourceQuery: null },
    ],
  },
  {
    canonical: "Mole",
    entries: [
      { id: "pa-7", alias: "鼹鼠", source: "auto", mentions: 188, kind: "name", sourceQuery: null },
    ],
  },
  {
    canonical: "Badger",
    entries: [
      {
        id: "pa-9",
        alias: "住在树林深处的那位长者",
        source: "user",
        mentions: 96,
        kind: "description",
        sourceQuery: "住在树林深处的那位长者是谁",
      },
    ],
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

/**
 * `?profile=<variant>` — which shape of the profile page to serve.
 *
 * The profile page has six states and the difference between them is entirely
 * in the data (`profile_get`'s reply), not in anything clickable: an empty
 * profile, a profile over the soft limit, one over the hard limit. A sweep
 * that only ever sees the default fixture never renders the other three, and
 * neither can anyone looking at the page by hand. `?empty=1` set the
 * precedent for a data-shaped knob living in the URL.
 */
export function profileVariant(): string {
  try {
    return new URLSearchParams(window.location.search).get("profile") ?? "";
  } catch {
    return "";
  }
}
