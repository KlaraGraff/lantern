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
  CARD_SNAPSHOT,
  CHATS,
  CHAT_MESSAGES,
  COLLECTIONS,
  EXPLANATIONS,
  HIGHLIGHTS,
  NOTES,
  PERSON_ALIAS_GROUPS,
  VOCAB,
  emptyLibrary,
  profileVariant,
  resolveSettings,
  type HarnessBook,
} from "./fixture-data";
import {
  DICTIONARY_ENTRIES,
  DICTIONARY_MISS,
  GENERIC_DICTIONARY_ENTRY,
} from "./dictionary-data";
import { isShooting } from "./promo";
import { PROMO_BOOKS, PROMO_COLLECTIONS } from "./promo/library";
import { PROMO_CHATS, PROMO_CHAT_MESSAGES, promoLearningCard } from "./promo/content";

type Args = Record<string, unknown>;
type Fixture = unknown | ((args: Args) => unknown);

/** Resolves against whichever shelf is live, so `/book/:id` works in a shot too. */
const bookById = (id: unknown): HarnessBook =>
  LIBRARY.find((b) => b.id === id) ?? LIBRARY[0] ?? BOOKS[0];

/**
 * Named for what it used to return. Every synced timestamp in this app is unix
 * milliseconds (migration 009), and `next_review_at` comparisons here run against
 * `VOCAB`, whose timestamps are now millis too — so a seconds clock would make
 * every word look due.
 */
const nowMs = () => Date.now();

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

/** Same split for chats: the shot shelf gets conversations about its own books. */
const SHELF_CHATS = isShooting() ? PROMO_CHATS : CHATS;

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
    hasEvidence: true,
  },
  {
    // `hasEvidence: false` on purpose — a card written before migration 068
    // has no snapshot, and the "查看原始记录" affordance must simply not
    // appear rather than open onto nothing.
    slot: "vocab_explain",
    conclusion: "生词给一个例句比给同义词更有用。",
    evidence: "反复要求换个例子",
    status: "active",
    updatedAt: Date.now() - 7_200_000,
    hasEvidence: false,
  },
  {
    slot: "reply_pacing",
    conclusion: "回答偏长时读者会中途打断。",
    evidence: "两次在解释途中改问别的",
    status: "moved",
    updatedAt: Date.now() - 86_400_000,
    hasEvidence: true,
  },
];

/**
 * `profile_card_evidence` payloads, keyed by slot. The backend forwards the
 * stored aggregation JSON as **text** and never parses it (migration 068), so
 * these are stringified here too — `useProfile` is what parses them, and a
 * fixture that skipped the stringify would not exercise that path.
 */
const PROFILE_EVIDENCE: Record<string, { kind: string; payload: unknown }> = {
  syntax_explain: {
    kind: "followup",
    payload: {
      count: 23,
      weighted_count: 14.2,
      sampled_examples: [
        { passage: "It was the best of times, it was the worst of times…", question: "这句的主语到底是哪个？" },
        { passage: "…having been told that the matter was settled, he left.", question: "前面那串分词短语挂在谁身上？" },
        { passage: "Not until the letter arrived did she understand.", question: "为什么这里要倒装？" },
      ],
    },
  },
  reply_pacing: {
    kind: "reply_pacing",
    payload: { count: 41, average_question_length: 17.4, single_turn_share: 0.63 },
  },
};

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

/**
 * Cards rewritten by the vocabulary panel's "regenerate" this session, keyed
 * by word id, so the snapshot section rereads the new one rather than the
 * seeded card. Real `update_vocab_card` writes definition, explanation and
 * snapshot in one transaction and refuses a blank definition; the sweep only
 * asserts that the round trip does not throw, so neither rule is modelled.
 */
const harnessRegeneratedCards = new Map<string, string>();

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
      created_at: nowMs(),
      updated_at: nowMs(),
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
  list_vocab_due_for_review: () => VOCAB.filter((w) => w.next_review_at <= nowMs()),
  check_vocab_exists: null,
  get_vocab_stats: {
    total: VOCAB.length,
    due_for_review: VOCAB.filter((w) => w.next_review_at <= nowMs()).length,
    learning: 2,
    mastered: 1,
    new: 1,
  },
  get_vocab_learning_dashboard: {
    total: VOCAB.length,
    due_today: VOCAB.filter((w) => w.next_review_at <= nowMs()).length,
    by_mastery: { "0": 1, "1": 2, "2": 1, "3": 1, "4": 1 },
    recent: VOCAB.slice(0, 3),
    streak_days: 4,
    reviewed_today: 2,
    added_this_week: 3,
  },
  list_mastery_events: [],
  // `kind` is a tagged object, not a string — `ReviewPile` in
  // src/components/review/review-piles.ts. The old `kind: "due"` made
  // `PileCard` throw on `pile.kind.kind` the moment a pile had any words in
  // it, which only started happening once the fixture words became visible.
  list_review_piles: () => [
    {
      kind: {
        kind: "repeat_lookups_in_book",
        book_id: "book-epub-reading",
        book_title: "The Wind in the Willows",
        solo_word_lookups: null,
        solo_word_glances: null,
      },
      word_ids: VOCAB.filter((w) => w.next_review_at <= nowMs()).map((w) => w.id),
      words: VOCAB.filter((w) => w.next_review_at <= nowMs()),
      newest_activity_at: nowMs(),
    },
    {
      kind: { kind: "long_unseen" },
      word_ids: VOCAB.slice(3).map((w) => w.id),
      words: VOCAB.slice(3),
      newest_activity_at: VOCAB[4].created_at,
    },
  ],
  list_word_marks: () => VOCAB.map((w) => ({ normalized_word: w.normalized_word, enabled: true })),
  list_word_mark_exceptions: [],
  list_lookup_occurrence_marks: [],
  list_word_forms: [],
  get_word_forms: [],
  find_covering_word_mark_rule: null,
  record_vocab_review: () => VOCAB[0],
  // The four states the vocabulary panel's saved-card section can be in, so
  // the sweep reaches the disclosure, its damaged-blob branch and its
  // "refreshed on" date instead of only the "no card" one an unstubbed
  // `Option<String>` would give it.
  get_vocab_card_snapshot: ({ wordId }: Args) => {
    const regenerated = harnessRegeneratedCards.get(String(wordId));
    if (regenerated !== undefined) return regenerated;
    if (wordId === "vw-2") return "{ this one is corrupt";
    if (wordId === "vw-4" || wordId === "vw-5") return null;
    // A card rebuilt long after the word was collected, which is the whole
    // reason the stamp exists: this row's `created_at` is months older.
    if (wordId === "vw-3") return JSON.stringify({ ...CARD_SNAPSHOT, refreshedAt: nowMs() });
    return JSON.stringify(CARD_SNAPSHOT);
  },
  update_vocab_card: ({ id, definition, contextExplanation, cardSnapshot }: Args) => {
    // `null` means "leave this column alone", never "erase it" — the same rule
    // the real command follows, and the one the panel depends on when the
    // snapshot is refused for being over the size guard.
    if (typeof cardSnapshot === "string") harnessRegeneratedCards.set(String(id), cardSnapshot);
    const word = VOCAB.find((entry) => entry.id === id) ?? VOCAB[0];
    return {
      ...word,
      definition: typeof definition === "string" ? definition : word.definition,
      // Spread only when there is a value: the real command `COALESCE`s and
      // re-selects the row, so it can hand back an unchanged explanation but
      // never a blanked one.
      ...(typeof contextExplanation === "string" ? { context_explanation: contextExplanation } : {}),
      updated_at: nowMs(),
    };
  },

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
      created_at: nowMs(),
      updated_at: nowMs(),
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
    indexedAt: nowMs(),
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
  list_all_chats: () => SHELF_CHATS.slice(),
  list_chats: () => SHELF_CHATS.slice(),
  get_chat: (a: Args) => SHELF_CHATS.find((c) => c.id === a.chatId) ?? SHELF_CHATS[0],
  create_chat: () => SHELF_CHATS[0],
  list_chat_messages: (a: Args) =>
    isShooting()
      ? (PROMO_CHAT_MESSAGES[String(a.chatId)] ?? []).slice()
      : CHAT_MESSAGES.slice(),
  /**
   * The other half of the merged 问答 list. Without this the shape-guessed
   * stub answers `{}`, `useExplanations` stores an empty page, and every
   * explanation row — the passage rule, the markdown body, the jump-back
   * button, the whole `kind === "explanation"` arm of `useQaTimeline` — is
   * unreachable in the sweep while the page still looks like it rendered.
   *
   * Filters mirror `query_all_explanations` rather than being approximated,
   * because the two differ in a way that shows on screen: `total` and `items`
   * narrow to the selected book, but the `books` facets deliberately do not —
   * otherwise picking a book empties the dropdown you picked it from and
   * there is no way back to "all books".
   */
  list_explanations: (a: Args) => {
    const search = String(a.search ?? "").trim().toLowerCase();
    const bookId = a.bookId == null ? "" : String(a.bookId);
    const pageSize = Math.min(200, Math.max(1, Number(a.limit) || 50));

    const matchesSearch = (e: (typeof EXPLANATIONS)[number]) =>
      search === "" ||
      e.passage.toLowerCase().includes(search) ||
      e.explanation.toLowerCase().includes(search);

    // Newest first, id ascending as the tie-break — the same ordering the
    // command's `ORDER BY e.updated_at DESC, e.id ASC` produces, and the one
    // the cursor below assumes.
    const found = EXPLANATIONS.filter(matchesSearch).sort(
      (left, right) => right.updated_at - left.updated_at || left.id.localeCompare(right.id),
    );
    const scoped = found.filter((e) => bookId === "" || e.book_id === bookId);

    const cursor = a.cursor == null ? "" : String(a.cursor);
    const [cursorStamp, cursorId] = cursor.split(":");
    const after = cursor
      ? scoped.filter(
          (e) =>
            e.updated_at < Number(cursorStamp) ||
            (e.updated_at === Number(cursorStamp) && e.id > cursorId),
        )
      : scoped;

    const items = after.slice(0, pageSize);
    const last = items[items.length - 1];
    const facets = new Map<string, { book_id: string; book_title: string | null; count: number }>();
    for (const e of found) {
      const facet = facets.get(e.book_id) ?? { book_id: e.book_id, book_title: e.book_title, count: 0 };
      facet.count += 1;
      facets.set(e.book_id, facet);
    }
    return {
      items,
      next_cursor: after.length > pageSize && last ? `${last.updated_at}:${last.id}` : null,
      total: scoped.length,
      books: Array.from(facets.values()),
    };
  },
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
  profile_card_evidence: (a: Args) => {
    const entry = PROFILE_EVIDENCE[String(a.slot)];
    if (!entry) return null;
    return {
      slot: String(a.slot),
      kind: entry.kind,
      capturedAt: Date.now() - 172_800_000,
      payload: JSON.stringify(entry.payload),
    };
  },
  /**
   * Mirrors `injection_block` closely enough to be worth looking at: English
   * scaffolding, the reader's own text, then one `维度：结论` line per active
   * card. `text: null` when the profile is switched off, which is the state
   * the block's own empty copy exists for.
   */
  profile_injection_preview: () => {
    const view = profileView();
    if (!view.enabled) return { text: null, charCount: 0, locale: "zh" };
    const cards = (view.cards as { status: string; slot: string; conclusion: string }[])
      .filter((card) => card.status === "active");
    const userText = String(view.userText ?? "");
    if (!userText && cards.length === 0) return { text: null, charCount: 0, locale: "zh" };
    const labels: Record<string, string> = {
      vocab_explain: "词义讲解",
      syntax_explain: "句法讲解",
      reference_explain: "指代讲解",
      cultural_context: "文化背景",
      lookup_pattern: "查词取向",
      example_source: "举例来源",
      reply_pacing: "回答节奏",
    };
    const lines = cards.map((card) => `${labels[card.slot] ?? card.slot}：${card.conclusion}`);
    const text = [
      "The reader has described who they are and how they like things explained, and this application has derived a few observations from their own past questions. Both are below. They say how to pitch an answer — never what is true about the book, and never a topic to raise.",
      "",
      "[Reader profile]",
      userText,
      "",
      ...lines,
      "",
      "Where the reader's own words above and these derived observations disagree, the reader's own words win.",
      "[/Reader profile]",
    ].join("\n");
    return { text, charCount: text.length, locale: "zh" };
  },
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
   * 只在拍样张时有值（见 `DELIBERATE_REJECTIONS`）。返回值就是卡片渲染的东西，
   * 流式事件只影响「边生成边显示」，不影响最终那一屏，所以这里不必伪造事件。
   */
  ai_learning_card: (a: Args) => {
    // 等级会换掉卡片显示哪几块，所以内容也得按等级取 —— 取的就是应用自己读的
    // 那个 `cefr_level`，样张里没有第二套开关。
    const card = promoLearningCard(a.text, resolveSettings().cefr_level);
    if (!card) throw new Error(`harness: 样张里没有 "${String(a.text)}" 这张卡`);
    return card;
  },

  /* ---------------------------------------------------------------- *
   * Dictionary
   * ---------------------------------------------------------------- *
   * 查词卡是单击查词那一层的全部内容，而它的难点全在数据的形状上：`deliver`
   * 只有一个词性、十一条释义，`light` 有三四个词性、其中一个二十一条。默认桩
   * 给的空结构只渲染得出「词典里没有这个词」那一种，正好是唯一不用验的那种。
   * 所以这里放真数据 —— 行数裁切、末行有没有留白、「还有 N 条未显示」数得准
   * 不准，只有真文本量得出来。
   */
  dictionary_lookup_word: (a: Args) => {
    const word = String(a.word ?? "");
    const key = word.toLowerCase();
    // 有道查不到时后端是报错，不是返回空条目 —— 前端的 not-found 卡走的是
    // catch 那一支，所以这里也得抛。
    if (key === DICTIONARY_MISS) throw new Error("harness: 词典里没有这个词");
    const entry = DICTIONARY_ENTRIES[key] ?? GENERIC_DICTIONARY_ENTRY;
    return {
      word,
      phonetic: entry.phonetic,
      groups: entry.groups,
      fallbackSummary: null,
    };
  },

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
  speech_voice_options: { options: ["en-US-AriaNeural", "en-GB-SoniaNeural"], updated_at: nowMs() },
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
        createdAt: nowMs(),
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
  // Coverage. The numbers are chosen to land on a *point* rather than a range
  // (enough baseline books, a narrow "眼熟" band), because the interval state
  // is the one that shows nothing and would leave the sweep unable to tell a
  // working card from a broken one.
  get_book_coverage: (a: Args) => ({
    bookId: String(a.bookId ?? a.book_id ?? BOOKS[0].id),
    status: "done",
    totalTokens: 84_000,
    distinctWords: 6_200,
    masteredTokens: 79_400,
    familiarTokens: 620,
    nameTokens: 1_180,
    unknownTokens: 2_800,
    nameWords: 46,
    unknownWords: 540,
    masteredForms: 8_130,
    familiarForms: 1_240,
    baselineBooks: 6,
    profileAt: new Date().toISOString(),
    sourceSha256: "a".repeat(64),
    computedAt: new Date().toISOString(),
    error: null,
    stale: false,
  }),
  get_vocab_profile: {
    booksRead: 6,
    singleBookTitle: null,
    singleBookProgress: null,
    exposureTokens: 214_682,
    exposureWords: 9_370,
    lookupRecords: 1_842,
    lookupDays: 96,
    vocabWords: 612,
    reviewedWords: 380,
    masteredForms: 8_130,
    familiarForms: 1_240,
    updatedAt: Date.now(),
  },
  get_book_unknown_words: [
    { word: "gunwale", tokens: 61, gloss: "舷缘", encounters: 12, lookups: 3, familiar: false },
    { word: "scrimshaw", tokens: 18, gloss: null, encounters: 4, lookups: 0, familiar: true },
    { word: "davit", tokens: 7, gloss: null, encounters: 0, lookups: 0, familiar: false },
  ],
  list_shelf_coverage: BOOKS.map((book, index) => ({
    bookId: book.id,
    totalTokens: 84_000,
    masteredTokens: 79_400 - index * 900,
    familiarTokens: 620,
    nameTokens: 1_180,
    baselineBooks: 6,
  })),
  preview_vocab_profile_clear: {
    autoMasteryWords: 8_130,
    exposureRecords: 214_682,
    computedBooks: 6,
    manualWords: 282,
    vocabWords: 612,
  },
  export_vocab_backup: { version: 1, words: VOCAB.slice(), exported_at: nowMs() },
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
    created_at: nowMs(),
    updated_at: nowMs(),
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
  // 拍样张时这一条让位给 `ai_learning_card` 的固定卡片：查词卡是那批图的
  // 主角，而 `LearningCardController` 拿到返回值就直接渲染，走的和线上是同
  // 一条路径 —— 不需要一个假的流式后端，也就不算走后门。
  ...(isShooting() ? {} : { ai_learning_card: "harness: no AI backend" }),
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
