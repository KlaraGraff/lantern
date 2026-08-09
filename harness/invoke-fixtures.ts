/**
 * Hand-written `invoke` fixtures — only for commands that gate rendering.
 *
 * The rule for what belongs here: if the default stub (see `shape-defaults.ts`)
 * leaves a screen blank, stuck on a spinner, or throwing, write a fixture.
 * Otherwise let it fall through and be logged as unstubbed. There are ~216
 * commands and roughly forty of them decide whether anything appears at all.
 *
 * A fixture is either a value or a function of the invoke args. Mutating
 * commands mostly return `null` from the default stub, which is fine — the
 * sweep is not asserting persistence, it is asserting "clicking this does not
 * throw".
 */
import {
  AUTO_HIGHLIGHTS,
  BOOKMARKS,
  BOOKS,
  CHATS,
  CHAT_MESSAGES,
  COLLECTIONS,
  HIGHLIGHTS,
  NOTES,
  PERSON_ALIAS_GROUPS,
  VOCAB,
  emptyLibrary,
  profileVariant,
  resolveSettings,
  type HarnessBook,
} from "./fixture-data";
import { isShooting } from "./promo";
import { PROMO_BOOKS, PROMO_COLLECTIONS } from "./promo/library";

type Args = Record<string, unknown>;
type Fixture = unknown | ((args: Args) => unknown);

/** Resolves against whichever shelf is live, so `/book/:id` works in a shot too. */
const bookById = (id: unknown): HarnessBook =>
  LIBRARY.find((b) => b.id === id) ?? LIBRARY[0] ?? BOOKS[0];

const nowSec = () => Math.floor(Date.now() / 1000);

/** Anchors hidden during this session. Derived highlights are computed on the
 *  backend, so the harness only has to remember the decisions taken about them. */
const harnessDismissedAnchors = new Set<string>();

/** Highlights promoted out of the derived list this session. Same shape as the
 *  static fixtures, except `text_content` is nullable the way the real row is. */
type HarnessHighlight = Omit<(typeof HIGHLIGHTS)[number], "text_content"> & {
  text_content: string | null;
};
const harnessPromoted: HarnessHighlight[] = [];

/** Notes written during the session, plus the seeded ones minus any deleted. */
interface HarnessNote {
  id: string;
  book_id: string;
  anchor_kind: string;
  normalized_word: string | null;
  scope: string;
  location: string | null;
  selected_text: string | null;
  content: string;
  content_format: string;
  created_at: number;
  updated_at: number;
}
const harnessSavedNotes: HarnessNote[] = [];
const harnessDeletedNotes = new Set<string>();
const harnessNotes = (): HarnessNote[] => [
  ...NOTES.filter((n) => !harnessDeletedNotes.has(n.id) && !harnessSavedNotes.some((s) => s.id === n.id)),
  ...harnessSavedNotes,
];

/** Counter behind `add_person_alias`'s returned id — distinct per write so two
 *  confirmations in one sweep don't hand the receipt the same row to undo. */
let harnessAliasWrites = 0;

/** Mutable so `set_setting` during a sweep is visible to the next read. */
const settings: Record<string, string> = resolveSettings();

/**
 * Which shelf the app sees.
 *
 *  - `?empty=1`      — nothing, for the empty state
 *  - `?shot=<name>`  — the curated public-domain shelf the README images use
 *  - otherwise       — the branch-covering smoke fixture
 *
 * The promo shelf is deliberately a *different* list, not an edit of `BOOKS`:
 * the smoke fixture earns its keep by being awkward (a missing file, a PDF, a
 * coverless book) and prettying it up would quietly delete that coverage.
 */
const LIBRARY: HarnessBook[] = emptyLibrary()
  ? []
  : isShooting()
    ? PROMO_BOOKS
    : BOOKS;

const LIBRARY_COLLECTIONS = isShooting() ? PROMO_COLLECTIONS : COLLECTIONS;

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

/**
 * The profile page's six states differ only in what `profile_get` returns —
 * nothing on the page can be clicked to reach an empty profile or one past
 * the hard limit. `?profile=<variant>` picks the shape; the default is the
 * one the sweep uses.
 */
const PROFILE_CARDS = [
  {
    slot: "syntax_explain",
    conclusion: "读者需要先看句子骨架，再看修饰成分。",
    evidence: "多次追问从句的主干在哪里",
    status: "active",
    updatedAt: Date.now() - 3_600_000,
  },
  {
    slot: "vocab_explain",
    conclusion: "生词给一个例句比给同义词更有用。",
    evidence: "反复要求换个例子",
    status: "active",
    updatedAt: Date.now() - 7_200_000,
  },
  {
    slot: "reply_pacing",
    conclusion: "回答偏长时读者会中途打断。",
    evidence: "两次在解释途中改问别的",
    status: "moved",
    updatedAt: Date.now() - 86_400_000,
  },
];

const PROFILE_SHORT = "我读英文小说主要是为了准备考试，遇到长句子容易卡住。";
/** ~625 characters — past the 500 soft limit, short of the 1000 hard one. */
const PROFILE_LONG = `${PROFILE_SHORT}${"我更想先看一句话的骨架，再看修饰成分，最后才是生词。".repeat(24)}`;
/** Past the hard limit, so saving is blocked rather than truncated. */
const PROFILE_TOO_LONG = PROFILE_LONG.repeat(2);

const PROFILE_VARIANTS: Record<string, () => Record<string, unknown>> = {
  /** ⓪ Nothing written, nothing summarized — the first-run page. */
  empty: () => ({
    userText: "",
    draftText: "",
    cards: [],
    newFollowupsSinceLastBatch: 3,
    lastSummarizedAt: null,
    revisionCount: 0,
  }),
  /** ② Over the soft limit: the inline warning and the optimize affordance. */
  soft: () => ({ userText: PROFILE_LONG, draftText: PROFILE_LONG }),
  /** ③ Over the hard limit: saving is blocked by `HardLimitDialog`. */
  hard: () => ({ userText: PROFILE_TOO_LONG, draftText: PROFILE_TOO_LONG }),
  /** The profile switched off — cards stay visible, nothing is injected. */
  off: () => ({ enabled: false }),
};

/**
 * Mirrors `ProfileView` in `src-tauri/src/commands/profile.rs` field for
 * field. `userText`/`draftText` are `unwrap_or_default()` there, so they are
 * always strings and never null; `lastSummarizedAt` is **milliseconds** (the
 * table stores `now_ms()`), which is what `timeAgo` expects.
 *
 * By default the draft differs from the saved text, because that is the
 * interesting state: it is what makes the "restore draft" affordance render
 * at all.
 */
function profileView(): Record<string, unknown> {
  const base = {
    userText: PROFILE_SHORT,
    draftText: `${PROFILE_SHORT}希望解释能短一点。`,
    enabled: true,
    softLimit: 500,
    // `profile_get_inner` computes `hard = soft * 2`; keep the fixture on that
    // rule so the over-limit variants land where the real backend puts them.
    hardLimit: 1000,
    cards: PROFILE_CARDS,
    newFollowupsSinceLastBatch: 8,
    lastSummarizedAt: Date.now() - 172_800_000,
    revisionCount: 3,
    batchSize: 20,
  };
  return { ...base, ...(PROFILE_VARIANTS[profileVariant()]?.() ?? {}) };
}

export const FIXTURES: Record<string, Fixture> = {
  /* ---------------------------------------------------------------- *
   * Boot / shell
   * ---------------------------------------------------------------- */
  app_ready: null,
  get_all_settings: () => ({ ...settings }),
  get_setting: (a: Args) => settings[String(a.key)] ?? null,
  set_setting: (a: Args) => {
    settings[String(a.key)] = String(a.value ?? "");
    return null;
  },
  set_settings_bulk: (a: Args) => {
    Object.assign(settings, (a.settings ?? {}) as Record<string, string>);
    return null;
  },
  get_book_settings: () => ({}),
  set_book_settings_bulk: null,
  delete_book_settings: () => ({}),
  list_reader_setting_conflicts: [],
  app_build_info: {
    version: "2.10.0-harness",
    upstream_baseline: "v2.10.0",
    commit: "0000000",
    built_at: new Date().toISOString(),
    channel: "harness",
    bundle_identifier: "com.klaragraff.lantern-harness",
    repository: "KlaraGraff/Lantern",
    upstream_repository: "KlaraGraff/Lantern",
  },
  log_webview_warning: null,

  /* ---------------------------------------------------------------- *
   * Library
   * ---------------------------------------------------------------- */
  list_books: (a: Args) => {
    const filter = a.filter == null ? null : String(a.filter);
    const search = a.search == null ? null : String(a.search).toLowerCase();
    let books = LIBRARY.slice();
    if (filter === "reading" || filter === "finished" || filter === "unread") {
      books = books.filter((b) => b.status === filter);
    }
    if (search) {
      books = books.filter(
        (b) =>
          b.title.toLowerCase().includes(search) || b.author.toLowerCase().includes(search),
      );
    }
    return { books, next_cursor: null, total: books.length };
  },
  get_book: (a: Args) => bookById(a.id ?? a.bookId ?? a.book_id),
  get_book_counts: () => ({
    all: LIBRARY.length,
    reading: LIBRARY.filter((b) => b.status === "reading").length,
    finished: LIBRARY.filter((b) => b.status === "finished").length,
    unread: LIBRARY.filter((b) => b.status === "unread").length,
  }),
  check_book_available: (a: Args) => {
    const book = bookById(a.id ?? a.bookId ?? a.book_id);
    return book.available
      ? { status: "available", available: true }
      : { status: "missing", available: false };
  },
  diagnose_book_file: (a: Args) => {
    const book = bookById(a.id ?? a.bookId ?? a.book_id);
    return book.available
      ? { status: "available", available: true }
      : { status: "missing", available: false };
  },
  /**
   * `ImportBatchResult`. The picker is mocked as "user cancelled", so both
   * lists are empty — which is also the shape `Home.tsx` reads `.length` off
   * unconditionally, and the `{}` default stub therefore crashed it.
   */
  import_book_from_dialog: { imported: [], failures: [] },
  import_external_paths: { imported: [], failures: [] },
  list_collections: () => LIBRARY_COLLECTIONS.slice(),
  list_books_in_collection: () => LIBRARY.slice(0, 2).map((b) => b.id),
  update_reading_progress: false,
  mark_finished: null,
  update_book_status: null,
  update_book_metadata: null,
  update_book_cover: null,

  /* ---------------------------------------------------------------- *
   * Reader side panels
   * ---------------------------------------------------------------- */
  list_highlights: () => [...HIGHLIGHTS, ...harnessPromoted],
  // Derived rows are the one fixture with state: hiding or keeping one has to
  // actually take it off the list, or the panel's own undo has nothing to undo.
  list_auto_highlights: () =>
    AUTO_HIGHLIGHTS.filter((item) => !harnessDismissedAnchors.has(item.anchor)),
  set_auto_highlight_dismissed: (args: Args) => {
    const anchor = String(args.anchor ?? "");
    if (args.dismissed === false) harnessDismissedAnchors.delete(anchor);
    else harnessDismissedAnchors.add(anchor);
    return null;
  },
  promote_auto_highlight: (args: Args) => {
    const anchor = String(args.anchor ?? "");
    const source = AUTO_HIGHLIGHTS.find((item) => item.anchor === anchor);
    harnessDismissedAnchors.add(anchor);
    // Dated now, like the real command: a kept passage lands at the top of the
    // list rather than back where it was derived from.
    const promoted = {
      id: `promoted-${anchor}`,
      book_id: source?.book_id ?? "book-epub-reading",
      cfi_range: source?.cfi ?? "",
      color: "yellow",
      text_content: source?.text ?? null,
      created_at: nowSec(),
      updated_at: nowSec(),
    };
    harnessPromoted.push(promoted);
    return promoted;
  },
  replace_highlights: () => HIGHLIGHTS.slice(),
  list_bookmarks: () => BOOKMARKS.slice(),
  add_bookmark: () => BOOKMARKS[0],
  add_highlight: () => HIGHLIGHTS[0],
  list_notes: (args: Args) => {
    const kind = args.anchorKind == null ? null : String(args.anchorKind);
    const notes = harnessNotes().filter((n) => kind === null || n.anchor_kind === kind);
    return { notes, total: notes.length, next_cursor: null };
  },
  list_context_notes: () => harnessNotes(),
  // Writes for real, so 「记住这里」 puts a row in the list the way the command
  // does: a new id when there is none, an in-place update when there is.
  save_note: (args: Args) => {
    const id = args.id == null ? `note-${harnessSavedNotes.length + 2}` : String(args.id);
    const now = Date.now();
    const existing = harnessSavedNotes.find((n) => n.id === id);
    const saved = {
      id,
      book_id: String(args.bookId ?? "book-epub-reading"),
      anchor_kind: String(args.anchorKind ?? "selection"),
      normalized_word: (args.word as string | null) ?? null,
      scope: String(args.scope ?? "book"),
      location: (args.location as string | null) ?? null,
      selected_text: (args.selectedText as string | null) ?? null,
      content: String(args.content ?? ""),
      content_format: "markdown",
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing) harnessSavedNotes[harnessSavedNotes.indexOf(existing)] = saved;
    else harnessSavedNotes.push(saved);
    return saved;
  },
  delete_note: (args: Args) => {
    const id = String(args.id ?? "");
    const at = harnessSavedNotes.findIndex((n) => n.id === id);
    if (at >= 0) harnessSavedNotes.splice(at, 1);
    else harnessDeletedNotes.add(id);
    return null;
  },
  // Shape mirrors `commands::annotations::{Annotation, AnnotationPage}`: one
  // row per anchor, a note folded onto the highlight it sits on, and a kept
  // place (`anchor_kind: "position"`) standing in for what used to be a
  // bookmark — its empty `content` is the bookmark, not an unfinished row.
  list_annotations: () => {
    // Note/highlight timestamps are milliseconds (`sync.next_logical_timestamp()`),
    // while the fixture module keeps seconds. Convert, and spread the rows over
    // the three bands the notes page separates on so all of them get drawn.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const when = [Date.now(), Date.now() - 2 * DAY_MS, Date.now() - 3 * DAY_MS, Date.now() - 40 * DAY_MS];
    // One band per row: created_at and updated_at of the same row share it.
    let row = -1;
    let half = 0;
    const at = () => {
      if (half++ % 2 === 0) row++;
      return when[Math.min(row, when.length - 1)];
    };
    const annotations = [
      ...HIGHLIGHTS.map((h) => ({
        id: `h:${h.id}`,
        highlight_id: h.id,
        note_id: null,
        book_id: h.book_id,
        book_title: "The Wind in the Willows",
        anchor_kind: "selection",
        normalized_word: null,
        scope: "book",
        location: h.cfi_range,
        selected_text: h.text_content,
        color: h.color,
        content: null,
        created_at: at(),
        updated_at: at(),
      })),
      ...harnessNotes().map((n) => ({
        id: `n:${n.id}`,
        highlight_id: null,
        note_id: n.id,
        book_id: n.book_id,
        book_title: "The Wind in the Willows",
        anchor_kind: n.anchor_kind,
        normalized_word: n.normalized_word,
        scope: n.scope,
        location: n.location,
        selected_text: n.selected_text,
        color: null,
        content: n.content,
        // A note written this session already carries a millisecond stamp;
        // a seeded one gets the next band.
        created_at: n.created_at > 1e12 ? n.created_at : at(),
        updated_at: n.updated_at > 1e12 ? n.updated_at : at(),
      })),
      ...BOOKMARKS.filter((b) => !harnessDeletedNotes.has(b.id)).map((b) => ({
        id: `n:${b.id}`,
        highlight_id: null,
        note_id: b.id,
        book_id: b.book_id,
        book_title: "The Wind in the Willows",
        anchor_kind: "position",
        normalized_word: null,
        scope: "book",
        location: b.cfi,
        selected_text: null,
        color: null,
        content: "",
        created_at: at(),
        updated_at: at(),
      })),
    ];
    const positions = annotations.filter((a) => a.anchor_kind === "position").length;
    const words = annotations.filter((a) => a.anchor_kind === "word").length;
    return {
      annotations,
      next_cursor: null,
      total: annotations.length,
      bare_highlights: HIGHLIGHTS.length,
      counts: {
        all: annotations.length,
        highlights: HIGHLIGHTS.length,
        with_notes: annotations.filter((a) => a.content).length,
        words,
        selections: annotations.length - positions - words,
        positions,
        marks: annotations.length - words,
        bare_highlights: HIGHLIGHTS.length,
      },
    };
  },

  /* ---------------------------------------------------------------- *
   * Vocabulary / learning
   * ---------------------------------------------------------------- */
  list_vocab_words: () => VOCAB.slice(),
  list_all_vocab_words: () => VOCAB.slice(),
  list_vocab_due_for_review: () => VOCAB.filter((w) => w.due_at <= nowSec()),
  check_vocab_exists: null,
  get_vocab_stats: {
    total: VOCAB.length,
    due_for_review: VOCAB.filter((w) => w.due_at <= nowSec()).length,
    learning: 2,
    mastered: 1,
    new: 1,
  },
  get_vocab_learning_dashboard: {
    total: VOCAB.length,
    due_today: VOCAB.filter((w) => w.due_at <= nowSec()).length,
    by_mastery: { "0": 1, "1": 2, "2": 1, "3": 1, "4": 1 },
    recent: VOCAB.slice(0, 3),
    streak_days: 4,
    reviewed_today: 2,
    added_this_week: 3,
  },
  list_mastery_events: [],
  list_review_piles: () => [
    {
      kind: "due",
      word_ids: VOCAB.filter((w) => w.due_at <= nowSec()).map((w) => w.id),
      words: VOCAB.filter((w) => w.due_at <= nowSec()),
      newest_activity_at: nowSec(),
    },
  ],
  list_word_marks: () => VOCAB.map((w) => ({ normalized_word: w.normalized_word, enabled: true })),
  list_word_mark_exceptions: [],
  list_lookup_occurrence_marks: [],
  list_word_forms: [],
  get_word_forms: [],
  find_covering_word_mark_rule: null,
  record_vocab_review: () => VOCAB[0],

  /* ---------------------------------------------------------------- *
   * Dictionary / lookup
   * ---------------------------------------------------------------- */
  get_cached_lookup: null,
  list_all_lookup_records: { records: [], next_cursor: null, total: 0, books: [] },
  list_lookup_records: [],
  word_memory_hint: null,

  /* ---------------------------------------------------------------- *
   * Reading stats
   * ---------------------------------------------------------------- */
  get_reading_stats_dashboard: {
    overview: {
      total_minutes: 620,
      total_sessions: 24,
      books_started: 3,
      books_finished: 1,
      current_streak: 4,
      longest_streak: 11,
      words_read: 84_000,
      pages_read: 310,
      average_pace_wpm: 212,
    },
    books: BOOKS.slice(0, 2).map((b) => ({
      book_id: b.id,
      title: b.title,
      author: b.author,
      minutes: 300,
      sessions: 9,
      progress: b.progress,
      last_read_at: b.updated_at,
      cover_data: b.cover_data,
    })),
    calendar: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
      minutes: i % 4 === 0 ? 0 : 15 + (i % 7) * 5,
      sessions: i % 4 === 0 ? 0 : 1,
    })),
    facts: {},
    cachedReview: null,
    learning: { words_added: 6, words_mastered: 1, reviews_done: 12, due_today: 2 },
    reviewPendingReason: null,
  },
  facts: {},
  record_reading_session: { recorded: true },
  checkpoint_reading_session: { recorded: true },
  record_reading_behavior_batch: { recorded: 0 },
  generate_reading_review: null,

  /* ---------------------------------------------------------------- *
   * AI
   * ---------------------------------------------------------------- */
  ai_api_key_configured: true,
  ai_list_profiles: () => [harnessProfile()],
  ai_active_profile: () => harnessProfile(),
  /**
   * `profile_id` and `state` are not decoration: `isAiConfigured()` joins the
   * credential back to its profile through `profile_id` and rejects anything
   * whose last test came back `invalid`. Without both fields the app decides
   * AI is unconfigured and the library grows a warning banner — which is a
   * fixture bug, not a finding.
   */
  ai_list_credentials: () => [
    {
      id: "cred-1",
      profile_id: "profile-1",
      label: "Harness key",
      provider: "openai",
      enabled: true,
      state: "valid",
      sort_order: 0,
      created_at: nowSec(),
      updated_at: nowSec(),
      masked_key: "sk-…harness",
    },
  ],
  ai_list_models: ["harness-model-large", "harness-model-small"],
  ai_reasoning_effort_options: { supported: false, options: [] },
  ai_vector_retrieval_status: { available: false, reason: "harness", dimensions: null, model: null },
  /**
   * `IndexDetails` as `IndexManagerModal.tsx` declares it. `sections` and
   * `chunks` must be arrays: the modal calls `.some()` on `sections` during
   * render with no guard, so a `{}` here empties the whole window.
   */
  ai_index_details: {
    status: "ready",
    error: null,
    chunkCount: 42,
    embeddedCount: 42,
    embeddingModel: "harness-embed-3",
    indexedAt: nowSec(),
    overview: {
      sectionIndex: null,
      sectionTitle: null,
      content: "A mole, a rat, a toad, and a badger, on and beside a river.",
      userEdited: false,
    },
    sections: [
      {
        sectionIndex: 0,
        sectionTitle: "The River Bank",
        content: "Mole abandons spring cleaning and meets Rat.",
        userEdited: false,
      },
      {
        sectionIndex: 1,
        sectionTitle: "The Open Road",
        content: "Toad's caravan, and its first collision with a motor-car.",
        userEdited: true,
      },
    ],
    chunks: [
      { index: 0, sectionTitle: "The River Bank", snippet: "The Mole had been working very hard…" },
      { index: 1, sectionTitle: "The Open Road", snippet: "'Onward!' cried the Toad…" },
    ],
  },
  get_book_ai_state: { indexStatus: "missing", hasSummaries: false, summariesStale: false },
  ai_embedding_probe: { available: false, reason: "harness" },
  openai_oauth_status: { connected: false, account_id: null },
  list_all_chats: () => CHATS.slice(),
  list_chats: () => CHATS.slice(),
  get_chat: () => CHATS[0],
  create_chat: () => CHATS[0],
  list_chat_messages: () => CHAT_MESSAGES.slice(),
  save_chat_message: () => CHAT_MESSAGES[1],
  replace_chat_message: () => CHAT_MESSAGES[1],
  /**
   * The alias disclosure's "别的人" picker calls `list_person_aliases` and
   * renders whatever canonicals come back, so without a fixture the picker
   * opens onto its empty state and the whole confirm path is unreachable.
   * `add_person_alias` has to return a real id string — the receipt only
   * offers 撤销 when it has a row id to delete.
   */
  list_person_aliases: () => PERSON_ALIAS_GROUPS.map((group) => ({ ...group })),
  add_person_alias: () => `pa-harness-${harnessAliasWrites++}`,
  delete_person_alias: null,
  clear_person_aliases: null,
  build_person_aliases: () => PERSON_ALIAS_GROUPS.map((group) => ({ ...group })),
  /**
   * Hand-written because `ProfileContent` reads `state.draftText.length`
   * unguarded, and the shape-guessed stub omits the string — which took the
   * whole profile page down to its error boundary during the sweep. See
   * `profileView` above for the shape and the `?profile=` variants.
   */
  profile_get: () => profileView(),
  /**
   * Returns a bare string, not `{ text }` — `useProfile.optimizeText` types it
   * as `invoke<string>`, and the shape-guessed stub's `{}` would render the
   * compare panel with an empty "after" column that looks like a real result.
   * Shortened rather than echoed so the two columns visibly differ — cut on a
   * sentence boundary, because a screenshot of a half-sentence reads as a
   * rendering bug rather than as a rewrite.
   */
  profile_optimize_text: (a: Args) => {
    const text = String(a.text ?? "");
    const sentences = text.split(/(?<=[。！？.!?])/).filter(Boolean);
    const kept = sentences.slice(0, Math.max(1, Math.ceil(sentences.length * 0.6))).join("");
    const direction = a.direction ? `（按你给的方向：${String(a.direction)}）` : "";
    return `${kept || text}${direction}`;
  },
  ai_cancel: true,
  /**
   * Hand-written because `AiRequestCountsSection` dereferences
   * `summary.current.byFeature` behind only a `if (!summary)` guard: the
   * shape-guessed `{}` the default stub returns for a struct crashed the whole
   * settings modal (and, with no error boundary in the app, the whole window).
   * Non-empty breakdown so the row list renders rather than the empty state.
   */
  ai_request_counts_summary: {
    current: {
      month: new Date().toISOString().slice(0, 7),
      total: 41,
      byFeature: [
        { feature: "explain", count: 18 },
        { feature: "dictionary", count: 12 },
        { feature: "chat", count: 7 },
        { feature: "autoAnalysis", count: 4 },
        // A slug this build has no label for: exercises the raw-name fallback.
        { feature: "word_forms", count: 0 },
      ],
    },
    previousTotal: 96,
  },

  /* ---------------------------------------------------------------- *
   * Settings sections that would otherwise render empty or spin
   * ---------------------------------------------------------------- */
  sync_status: {
    enabled: false,
    available: true,
    sync_enabled: false,
    shared_dir: null,
    device_uuid: "harness-device",
    device_name: "Harness Mac",
    peers: [],
    pending_events: 0,
    last_replay_at: null,
  },
  mcp_integration_status: {
    enabled: false,
    write_access: false,
    port: 4599,
    integrations: [],
    endpoint: "http://127.0.0.1:4599/mcp",
  },
  mcp_list_pending_approvals: [],
  mcp_config_snippet: '{ "mcpServers": {} }',
  enhanced_font_status: { installed: false, enabled: false, downloading: false, bytes: 0 },
  list_custom_fonts: [],
  speech_cache_stats: { bytes: 1_240_000, entries: 18, limitBytes: 200_000_000 },
  speech_voice_options: { options: ["en-US-AriaNeural", "en-GB-SoniaNeural"], updated_at: nowSec() },
  speech_list_models: ["tts-1"],
  speech_custom_key_configured: false,
  /** `OcrPackageStatus` / `OcrAssetsOverview` — see `src/ocr/types.ts`. */
  ocr_package_status: { state: "installed", version: "1.4.2", installedBytes: 96_000_000 },
  ocr_assets_overview: {
    totalBytes: 12_400_000,
    items: [
      {
        assetId: "ocr-asset-1",
        bookId: BOOKS[2].id,
        title: BOOKS[2].title,
        byteSize: 12_400_000,
        createdAt: nowSec(),
        availability: "local",
      },
    ],
  },
  ocr_job_status: null,
  list_language_assessments: [],
  summarize_language_assessments: null,
  get_level_observation: null,
  /**
   * Shape mirrors `AutoAnalysisConsoleData` in
   * `src/components/settings/auto-analysis.ts` (camelCase, per the Rust
   * `#[serde(rename_all = "camelCase")]`). All four real job ids, a mix of on
   * and off, and one `recommendAuto` row so the recommendation banner renders.
   */
  auto_analysis_console: {
    jobs: [
      {
        id: "reading_review",
        trigger: "book_finished",
        enabled: true,
        everEnabled: true,
        autoCalls: 3,
        autoTokens: 18_400,
        manualRuns: 1,
        recommendAuto: false,
      },
      {
        id: "review_pile_curation",
        trigger: "daily",
        enabled: false,
        everEnabled: false,
        autoCalls: 0,
        autoTokens: 0,
        manualRuns: 6,
        recommendAuto: true,
      },
      {
        id: "followup_difficulty",
        trigger: "batch",
        enabled: true,
        everEnabled: true,
        autoCalls: 11,
        autoTokens: 5_900,
        manualRuns: 0,
        recommendAuto: false,
      },
      {
        id: "vocab_gloss_backfill",
        trigger: "repair",
        enabled: false,
        everEnabled: true,
        autoCalls: 0,
        autoTokens: 0,
        manualRuns: 2,
        recommendAuto: false,
      },
    ],
    autoTokens: 24_300,
    userTokens: 81_200,
    ratioPercent: 30,
    providers: ["openai"],
  },
  get_book_difficulty: (a: Args) => ({
    bookId: String(a.bookId ?? a.book_id ?? BOOKS[0].id),
    status: "ready",
    totalTokens: 84_000,
    distinctWords: 6_200,
    band1: 4200,
    band2: 1100,
    band3: 500,
    band4: 240,
    band5: 100,
    bandUnlisted: 60,
    sourceSha256: "a".repeat(64),
    computedAt: new Date().toISOString(),
    error: null,
    override: null,
    stale: false,
  }),
  export_vocab_backup: { version: 1, words: VOCAB.slice(), exported_at: nowSec() },
};

function harnessProfile() {
  return {
    id: "profile-1",
    name: "Harness profile",
    provider: "openai",
    model: "harness-model-large",
    base_url: "https://example.invalid/v1",
    enabled: true,
    is_default: true,
    sort_order: 0,
    credential_id: "cred-1",
    temperature: 0.7,
    max_tokens: 2048,
    reasoning_effort: null,
    system_prompt: null,
    created_at: nowSec(),
    updated_at: nowSec(),
  };
}

/**
 * Commands the harness answers with a rejection on purpose, because the real
 * ones need a network or a native dialog. Rejections from this list are tagged
 * so the sweep does not report them as app bugs.
 */
export const DELIBERATE_REJECTIONS: Record<string, string> = {
  ai_chat: "harness: no AI backend",
  ai_explain: "harness: no AI backend",
  ai_translate_passage: "harness: no AI backend",
  ai_learning_card: "harness: no AI backend",
  ai_xray: "harness: no AI backend",
  ai_vocab_gloss: "harness: no AI backend",
  ai_custom_action: "harness: no AI backend",
  ai_generate_title: "harness: no AI backend",
  ai_optimize_prompt: "harness: no AI backend",
  ai_test_profile: "harness: no AI backend",
  dictionary_gloss: "harness: no dictionary backend",
  speech_edge_audio: "harness: no speech backend",
  speech_custom_audio: "harness: no speech backend",
  speech_dictionary_audio: "harness: no speech backend",
};

export function hasFixture(command: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIXTURES, command);
}

export function resolveFixture(command: string, args: Args): unknown {
  const fixture = FIXTURES[command];
  return typeof fixture === "function" ? (fixture as (a: Args) => unknown)(args) : fixture;
}
