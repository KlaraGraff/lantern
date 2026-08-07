// Regressions for the two ways Lantern died on macOS 12 / Safari 15.
//
// 1. `subscribeToVoices` assumed `speechSynthesis` was a well-formed
//    EventTarget. On old WebKit it is not, and because that call sits in a
//    `useEffect` body the throw unwound into the error boundary and the reader
//    window came up as an error screen instead of a book.
// 2. Three regexes used lookbehind, which WebKit only understands from Safari
//    16.4. esbuild lowers such a literal to `new RegExp(...)` so the bundle
//    still parses — which is exactly why the compatibility audit has to know
//    both spellings, or it passes because the bundle was lowered.
import assert from "node:assert/strict";
import test from "node:test";

import { englishVoices, subscribeToVoices } from "../src/components/speech/system-voices.ts";
import { wordBoundaryMatches } from "../src/components/vocab/word-boundary.ts";
import { contextualReviewCloze } from "../src/components/vocab/contextual-review.ts";
import { scanJavaScriptSource } from "../scripts/check-reader-compat.mjs";

/** Installs a `window.speechSynthesis` shaped like a given WebKit build. */
function withSynthesis<T>(synthesis: unknown, run: () => T): T {
  const previous = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", { speechSynthesis: synthesis });
  try {
    return run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "window");
    else Reflect.set(globalThis, "window", previous);
  }
}

test("a speechSynthesis without addEventListener falls back to onvoiceschanged", () => {
  const synthesis: Record<string, unknown> = {
    getVoices: () => [],
    onvoiceschanged: null,
  };
  let notified = 0;

  const stop = withSynthesis(synthesis, () => subscribeToVoices(() => (notified += 1)));

  assert.equal(typeof synthesis.onvoiceschanged, "function");
  (synthesis.onvoiceschanged as () => void)();
  assert.equal(notified, 1);

  stop();
  assert.equal(synthesis.onvoiceschanged, null, "unsubscribing restores the previous handler");
});

test("a speechSynthesis that throws on every call cannot take the window down", () => {
  const hostile = {
    get onvoiceschanged() {
      throw new TypeError("not implemented");
    },
    set onvoiceschanged(_value: unknown) {
      throw new TypeError("not implemented");
    },
    getVoices() {
      throw new TypeError("not implemented");
    },
    addEventListener() {
      throw new TypeError("not implemented");
    },
  };

  withSynthesis(hostile, () => {
    assert.deepEqual(englishVoices(), [], "a throwing inventory reads as no voices");
    const stop = subscribeToVoices(() => {});
    assert.equal(typeof stop, "function");
    stop();
  });
});

test("a working EventTarget is still preferred and detaches on unsubscribe", () => {
  const listeners = new Set<() => void>();
  const synthesis = {
    getVoices: () => [],
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };

  const stop = withSynthesis(synthesis, () => subscribeToVoices(() => {}));
  assert.equal(listeners.size, 1);
  stop();
  assert.equal(listeners.size, 0);
});

test("word boundaries survive without lookbehind, including overlapping candidates", () => {
  assert.deepEqual(
    wordBoundaryMatches("The cat sat on the cat.", "cat").map((match) => match.index),
    [4, 19],
  );
  // A rejected candidate must resume one character on, not past itself, or a
  // valid match starting inside it is stepped over.
  assert.deepEqual(
    wordBoundaryMatches("aa-a-a", "a-a").map((match) => match.index),
    [3],
  );
  assert.deepEqual(wordBoundaryMatches("concatenate", "cat"), [], "substrings are not matches");
  assert.deepEqual(
    contextualReviewCloze("The cat sat on the cat.", "cat")?.segments.filter((s) => s.hidden).length,
    2,
    "every occurrence is still blanked",
  );
});

test("the compatibility audit rejects lookbehind in both spellings", () => {
  const literal = scanJavaScriptSource("const re = /(?<=[{\\s;])-epub-/gi;");
  assert.equal(literal.length, 1);
  assert.match(literal[0], /lookbehind/);

  const lowered = scanJavaScriptSource('const re = new RegExp("(?<!\\\\w)mail", "gu");');
  assert.equal(lowered.length, 1);
  assert.match(lowered[0], /lookbehind/);

  assert.deepEqual(
    scanJavaScriptSource("const re = /(?<year>\\d{4})-(?<month>\\d{2})/u;"),
    [],
    "named capture groups have worked since Safari 11.1 and must not be flagged",
  );
});
