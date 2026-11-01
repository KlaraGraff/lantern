import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reviewKeyAction } from "../src/pages/flashcards/review-keyboard.ts";

const key = (
  value: string,
  extra: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {},
) => ({
  key: value,
  code: extra.code ?? "",
  metaKey: extra.metaKey ?? false,
  ctrlKey: extra.ctrlKey ?? false,
  altKey: extra.altKey ?? false,
});

const state = (
  extra: Partial<{
    reviewing: boolean;
    answerVisible: boolean;
    submitting: boolean;
    onControl: boolean;
    onTextEntry: boolean;
  }> = {},
) => ({
  reviewing: true,
  answerVisible: true,
  submitting: false,
  onControl: false,
  onTextEntry: false,
  ...extra,
});

describe("review keyboard shortcuts", () => {
  // Regression: the answer side moves focus onto the first rating button, so a
  // digit branch behind the "focus is on a control" guard could never fire and
  // the 1-4 shortcuts printed in the footer did nothing.
  it("rates from a digit even while a rating button holds focus", () => {
    assert.deepEqual(reviewKeyAction(key("1"), state({ onControl: true })), {
      kind: "rate",
      rating: "again",
    });
    assert.deepEqual(reviewKeyAction(key("4"), state({ onControl: true })), {
      kind: "rate",
      rating: "easy",
    });
  });

  it("maps every digit to its rating", () => {
    const ratings = ["1", "2", "3", "4"].map((digit) => {
      const action = reviewKeyAction(key(digit), state({ onControl: true }));
      return action?.kind === "rate" ? action.rating : null;
    });
    assert.deepEqual(ratings, ["again", "hard", "good", "easy"]);
  });

  it("ignores digits before the answer is shown", () => {
    assert.equal(reviewKeyAction(key("1"), state({ answerVisible: false })), null);
  });

  it("ignores digits while a rating is in flight", () => {
    assert.equal(reviewKeyAction(key("2"), state({ submitting: true, onControl: true })), null);
  });

  it("still hints on H while the reveal button holds focus", () => {
    assert.deepEqual(reviewKeyAction(key("h"), state({ answerVisible: false, onControl: true })), {
      kind: "hint",
    });
  });

  it("leaves the hint key alone inside a text field", () => {
    assert.equal(
      reviewKeyAction(key("h"), state({ answerVisible: false, onControl: true, onTextEntry: true })),
      null,
    );
  });

  it("does not claim Space while a button would activate on it", () => {
    assert.equal(reviewKeyAction(key(" ", { code: "Space" }), state({ answerVisible: false, onControl: true })), null);
    assert.deepEqual(reviewKeyAction(key(" ", { code: "Space" }), state({ answerVisible: false })), {
      kind: "reveal",
    });
  });

  it("keeps Escape as the way out, focused control or not", () => {
    assert.deepEqual(reviewKeyAction(key("Escape"), state({ onControl: true })), { kind: "back" });
  });

  it("ignores unrelated keys", () => {
    assert.equal(reviewKeyAction(key("q"), state()), null);
  });
});
