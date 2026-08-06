import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  capPileChips,
  pileKey,
  pileReasonKey,
  pileTitleKey,
  splitReviewPiles,
  type ReviewPile,
  type ReviewPileKind,
} from "../src/components/review/review-piles.ts";
import type { DictionaryWord } from "../src/hooks/useDictionary.ts";

const rootDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

function word(id: string, text = id): DictionaryWord {
  return {
    id,
    book_id: "book-1",
    word: text,
    definition: "def",
    context_sentence: null,
    context_explanation: null,
    cfi: null,
    mastery: "new",
    mastery_source: "manual",
    mastery_reason: null,
    review_count: 0,
    next_review_at: null,
    review_interval_days: 0,
    last_reviewed_at: null,
    last_review_rating: null,
    created_at: 0,
    updated_at: 0,
    book_title: "Some Book",
  };
}

function pile(kind: ReviewPileKind, wordIds: string[], newestActivityAt = 0): ReviewPile {
  return {
    kind,
    word_ids: wordIds,
    words: wordIds.map((id) => word(id)),
    newest_activity_at: newestActivityAt,
  };
}

describe("capPileChips", () => {
  test("a pile at or under the cap shows every chip and no overflow", () => {
    const words = [word("a"), word("b"), word("c")];
    const result = capPileChips(words, 4);
    assert.equal(result.visible.length, 3);
    assert.equal(result.overflow, 0);
  });

  test("exactly at the cap still has no overflow", () => {
    const words = [word("a"), word("b"), word("c"), word("d")];
    const result = capPileChips(words, 4);
    assert.equal(result.visible.length, 4);
    assert.equal(result.overflow, 0);
  });

  test("a pile over the cap folds the rest into one overflow count", () => {
    const words = ["a", "b", "c", "d", "e", "f"].map((id) => word(id));
    const result = capPileChips(words, 4);
    assert.equal(result.visible.length, 4);
    assert.deepEqual(result.visible.map((w) => w.id), ["a", "b", "c", "d"]);
    assert.equal(result.overflow, 2);
  });
});

describe("pileReasonKey", () => {
  test("a one-word repeat_lookups_in_book pile uses the solo 来由 with its lookup count interpolated", () => {
    const p = pile(
      { kind: "repeat_lookups_in_book", book_id: "b1", book_title: "Emma", solo_word_lookups: 4 },
      ["w1"],
    );
    const reason = pileReasonKey(p);
    assert.equal(reason.key, "reviewBoard.pile.repeatLookupsInBook.reasonSolo");
    assert.deepEqual(reason.params, { count: "4" });
  });

  test("a multi-word repeat_lookups_in_book pile uses the plural 来由, not the solo one", () => {
    const p = pile(
      { kind: "repeat_lookups_in_book", book_id: "b1", book_title: "Emma", solo_word_lookups: null },
      ["w1", "w2", "w3"],
    );
    const reason = pileReasonKey(p);
    assert.equal(reason.key, "reviewBoard.pile.repeatLookupsInBook.reason");
    assert.equal(reason.params, undefined);
  });

  test("recent_chapter_lookups carries the pre-resolved relative-time string, not a timestamp", () => {
    const p = pile({ kind: "recent_chapter_lookups", book_id: "b1", book_title: "Emma", chapter: "Ch. 6" }, ["w1"]);
    const reason = pileReasonKey(p, "30m ago");
    assert.equal(reason.key, "reviewBoard.pile.recentChapterLookups.reason");
    assert.deepEqual(reason.params, { ago: "30m ago" });
  });

  test("promoted_then_looked_up and long_unseen have fixed, non-interpolated 来由", () => {
    assert.equal(
      pileReasonKey(pile({ kind: "promoted_then_looked_up" }, ["w1"])).key,
      "reviewBoard.pile.promotedThenLookedUp.reason",
    );
    assert.equal(pileReasonKey(pile({ kind: "long_unseen" }, ["w1"])).key, "reviewBoard.pile.longUnseen.reason");
  });
});

describe("pileTitleKey", () => {
  test("interpolates the book title and the chapter for the kinds that carry them", () => {
    assert.deepEqual(
      pileTitleKey({ kind: "repeat_lookups_in_book", book_id: "b1", book_title: "Emma", solo_word_lookups: null }),
      { key: "reviewBoard.pile.repeatLookupsInBook.title", params: { book: "Emma" } },
    );
    assert.deepEqual(
      pileTitleKey({ kind: "recent_chapter_lookups", book_id: "b1", book_title: "Emma", chapter: "Ch. 6" }),
      { key: "reviewBoard.pile.recentChapterLookups.title", params: { chapter: "Ch. 6" } },
    );
  });
});

describe("splitReviewPiles", () => {
  test("long_unseen is excluded from the main cards and returned separately", () => {
    const repeat = pile({ kind: "repeat_lookups_in_book", book_id: "b1", book_title: "Emma", solo_word_lookups: null }, ["w1", "w2"]);
    const promoted = pile({ kind: "promoted_then_looked_up" }, ["w3"]);
    const unseen = pile({ kind: "long_unseen" }, ["w4"]);
    const { cards, longUnseen } = splitReviewPiles([repeat, promoted, unseen]);

    assert.deepEqual(cards, [repeat, promoted]);
    assert.ok(!cards.some((p) => p.kind.kind === "long_unseen"), "long_unseen must never appear among the main cards");
    assert.equal(longUnseen, unseen);
  });

  test("the 'Also' section is absent (null) when the backend did not return a long_unseen pile", () => {
    const repeat = pile({ kind: "repeat_lookups_in_book", book_id: "b1", book_title: "Emma", solo_word_lookups: null }, ["w1"]);
    const { cards, longUnseen } = splitReviewPiles([repeat]);
    assert.deepEqual(cards, [repeat]);
    assert.equal(longUnseen, null);
  });

  test("an all-long_unseen result has no main cards at all", () => {
    const unseen = pile({ kind: "long_unseen" }, ["w1"]);
    const { cards, longUnseen } = splitReviewPiles([unseen]);
    assert.deepEqual(cards, []);
    assert.equal(longUnseen, unseen);
  });
});

describe("pileKey", () => {
  test("distinguishes piles of the same kind by their book (or chapter)", () => {
    const a = pileKey({ kind: { kind: "repeat_lookups_in_book", book_id: "b1", book_title: "Emma", solo_word_lookups: null } });
    const b = pileKey({ kind: { kind: "repeat_lookups_in_book", book_id: "b2", book_title: "Persuasion", solo_word_lookups: null } });
    assert.notEqual(a, b);
  });

  test("the singleton kinds always resolve to the same key", () => {
    assert.equal(
      pileKey({ kind: { kind: "promoted_then_looked_up" } }),
      pileKey({ kind: { kind: "promoted_then_looked_up" } }),
    );
    assert.equal(pileKey({ kind: { kind: "long_unseen" } }), "long_unseen");
  });
});

// Regression guard for the RED LINE in docs/impls/review-entry-mockup.html §1:
// the sidebar's 复习/Review row must never show a count, badge, dot, or bubble.
// There is no DOM in this test runner, so this checks the source directly —
// the same technique tests/i18n-keys.test.ts uses to check literal t() calls.
//
// Since the sidebar-IA rework (docs/impls/sidebar-ia-options-mockup.html,
// option C) Review is one of five rows rendered off a single shared template
// in the "随记"/Memos section (`memoFilters.map(...)`), not its own bespoke
// JSX block — so this checks that Review is one of the ids the template maps
// over, and that the shared template itself never renders a count for any of
// its rows (which covers Review along with its neighbors).
describe("sidebar review row", () => {
  const sidebarSource = readFileSync(path.join(rootDir, "src/components/Sidebar.tsx"), "utf8");

  test("review is one of the memo rows", () => {
    assert.match(
      sidebarSource,
      /\{\s*id:\s*"review",\s*label:\s*t\("sidebar\.review"\),\s*icon:\s*RotateCcw\s*\}/,
      "no \"review\" entry found in memoFilters",
    );
  });

  test("the shared memo-row template contains no count", () => {
    const start = sidebarSource.indexOf("memoFilters.map((filter) => {");
    assert.ok(start >= 0, "no memoFilters.map(...) template found in Sidebar.tsx");
    const end = sidebarSource.indexOf("})}", start);
    assert.ok(end >= 0);
    const block = sidebarSource.slice(start, end);

    // No badge/count-fetching call of any kind.
    assert.ok(!/getCount\(/.test(block), "memo row template must not call getCount(...)");
    assert.ok(!/bookCounts/.test(block), "memo row template must not reference bookCounts");
    // Exactly one <span> — the label. A second span is how every counted row
    // in this file renders its badge, so a second one here would be a count.
    const spanCount = (block.match(/<span/g) ?? []).length;
    assert.equal(spanCount, 1, "memo row template must render exactly one <span> (the label), never a count badge");
  });
});

// Regression guard for the RED LINES in docs/impls/review-entry-mockup.html §3:
// the empty board state must state a fact, not apologize or nag, and must
// carry no emoji or exclamation mark.
describe("review board empty-state copy", () => {
  const i18nDir = path.join(rootDir, "src/i18n");
  const en = JSON.parse(readFileSync(path.join(i18nDir, "en.json"), "utf8")) as Record<string, string>;
  const zh = JSON.parse(readFileSync(path.join(i18nDir, "zh.json"), "utf8")) as Record<string, string>;
  const keys = ["reviewBoard.empty.heading", "reviewBoard.empty.body", "reviewBoard.empty.seeAllWords"];

  // A rough but effective net: most emoji live above the BMP (surrogate pairs)
  // or in the pictograph/symbol blocks below.
  const EMOJI_PATTERN = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/u;

  for (const [localeName, table] of [["en", en], ["zh", zh]] as const) {
    for (const key of keys) {
      test(`${localeName}.${key} has no exclamation mark or emoji`, () => {
        const value = table[key];
        assert.ok(value, `${key} missing from ${localeName}`);
        assert.ok(!value.includes("!") && !value.includes("！"), `${localeName}.${key} contains an exclamation mark: ${value}`);
        assert.ok(!EMOJI_PATTERN.test(value), `${localeName}.${key} contains an emoji: ${value}`);
      });
    }

    test(`${localeName} empty state avoids the rejected apologizing/nagging copy`, () => {
      const heading = table["reviewBoard.empty.heading"];
      const body = table["reviewBoard.empty.body"];
      const banned = localeName === "zh"
        ? ["暂无待复习内容", "快去读书", "去阅读"]
        : ["No items to review", "Go read more", "Go read"];
      for (const phrase of banned) {
        assert.ok(!heading.includes(phrase), `heading must not contain "${phrase}"`);
        assert.ok(!body.includes(phrase), `body must not contain "${phrase}"`);
      }
    });
  }
});
