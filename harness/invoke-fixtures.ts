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
  BOOKMARKS,
  BOOKS,
  CHATS,
  CHAT_MESSAGES,
  COLLECTIONS,
  HIGHLIGHTS,
  NOTES,
  VOCAB,
  emptyLibrary,
  resolveSettings,
  type HarnessBook,
} from "./fixture-data";

type Args = Record<string, unknown>;
type Fixture = unknown | ((args: Args) => unknown);

const bookById = (id: unknown): HarnessBook =>
  BOOKS.find((b) => b.id === id) ?? BOOKS[0];

const nowSec = () => Math.floor(Date.now() / 1000);

/** Mutable so `set_setting` during a sweep is visible to the next read. */
const settings: Record<string, string> = resolveSettings();

/** `?empty=1` sweeps the empty-library state instead of the stocked one. */
const LIBRARY: HarnessBook[] = emptyLibrary() ? [] : BOOKS;

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
  list_collections: () => COLLECTIONS.slice(),
  list_books_in_collection: () => BOOKS.slice(0, 2).map((b) => b.id),
  update_reading_progress: false,
  mark_finished: null,
  update_book_status: null,
  update_book_metadata: null,
  update_book_cover: null,

  /* ---------------------------------------------------------------- *
   * Reader side panels
   * ---------------------------------------------------------------- */
  list_highlights: () => HIGHLIGHTS.slice(),
  replace_highlights: () => HIGHLIGHTS.slice(),
  list_bookmarks: () => BOOKMARKS.slice(),
  add_bookmark: () => BOOKMARKS[0],
  add_highlight: () => HIGHLIGHTS[0],
  list_notes: () => ({ notes: NOTES.slice(), total: NOTES.length, next_cursor: null }),
  list_context_notes: () => NOTES.slice(),
  save_note: () => NOTES[0],
  list_annotations: () => ({
    annotations: [
      ...HIGHLIGHTS.map((h) => ({
        kind: "highlight",
        id: h.id,
        book_id: h.book_id,
        book_title: "The Wind in the Willows",
        cfi: h.cfi_range,
        color: h.color,
        text_content: h.text_content,
        note: null,
        created_at: h.created_at,
        updated_at: h.updated_at,
      })),
      ...BOOKMARKS.map((b) => ({
        kind: "bookmark",
        id: b.id,
        book_id: b.book_id,
        book_title: "The Wind in the Willows",
        cfi: b.cfi,
        color: null,
        text_content: b.label,
        note: null,
        created_at: b.created_at,
        updated_at: b.updated_at,
      })),
    ],
    next_cursor: null,
    total: HIGHLIGHTS.length + BOOKMARKS.length,
    bare_highlights: 1,
    counts: { highlights: HIGHLIGHTS.length, bookmarks: BOOKMARKS.length, notes: NOTES.length },
  }),

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
  ai_list_credentials: () => [
    {
      id: "cred-1",
      label: "Harness key",
      provider: "openai",
      enabled: true,
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
