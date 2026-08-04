# P2.2 — Contextual vocabulary review

Status: approved and implemented.

Source: [`docs/roadmap/reader-page-optimization.md`](../roadmap/reader-page-optimization.md) §P2.2.
Approved visual reference: [`vocab-contextual-review-mockup.html`](vocab-contextual-review-mockup.html).

## 1. Outcome

Vocabulary review tests recall from the sentence in which the word was learned rather than showing the word and definition at the same time. A due word with usable saved context becomes a two-sided contextual card:

1. front: book/source, saved sentence with the target word blanked, optional progressive hints;
2. answer: restored word and sentence, definition/context explanation, then the existing four review ratings.

Old rows without usable context retain a word-first fallback card. The feature does not migrate or rewrite vocabulary data.

## 2. Approved product rules

1. Do not show word length, letter count, first letter, or spelling-shaped placeholders. Those cues turn contextual recall into a spelling puzzle.
2. Keep session progress (`3 / 12`); it describes review progress, not the answer.
3. The first hint plays the target word pronunciation without showing its spelling.
4. The second, stronger hint reveals the stored Chinese contextual explanation/sentence meaning without showing English spelling.
5. Hints are optional. The default front shows neither automatically.
6. `Space` reveals the answer. Ratings become available only after reveal.
7. The answer restores the target word in the sentence, then shows its definition and contextual explanation.
8. Rows without a context sentence, or whose saved sentence cannot locate the saved word/phrase safely, use the existing word-first review instead of presenting a broken cloze.
9. Rows without a saved contextual explanation omit the “显示句意” hint; review never calls AI to manufacture one.
10. Review scheduling, FSRS state, rating meanings, and sync behavior remain unchanged.

## 3. Data contract

Everything required already exists on `DictionaryWord`:

| UI content | Field |
| --- | --- |
| target word/phrase | `word` |
| answer definition | `definition` |
| source sentence | `context_sentence` |
| Chinese sentence/context meaning | `context_explanation` |
| source book | `book_title` |
| review progress/scheduling | existing due-word list and FSRS fields |

No schema, migration, Rust command, or sync event is needed.

## 4. Cloze rules

Add a DOM-free helper in `src/components/vocab/contextual-review.ts`.

- Trim word and sentence before matching.
- Match the first case-insensitive occurrence of the complete saved word or phrase.
- For single words, require Unicode-aware token boundaries so `art` does not blank the middle of `partial`.
- Preserve the sentence's original casing and punctuation in the answer.
- Represent the front as `{ before, after }`; render an empty fixed visual underline between them. The underline carries no text or length-derived width.
- If matching fails, return `null` and use word-first fallback.
- Never modify the stored sentence.

The visual blank has a fixed comfortable width independent of the word length. Accessibility text says only “被挖空的单词 / hidden word”.

## 5. Review state machine

The modal keeps a small per-card state:

```text
question
  ├─ play pronunciation ──> question (audio feedback only)
  ├─ reveal sentence meaning ──> question + meaning
  └─ Space / Show answer ──> answer

answer
  └─ rate 1–4 ──> record review, advance to next due word, reset hints
```

- Changing `reviewing.id` resets `answerVisible` and `meaningVisible`.
- Replaying audio does not change card state or rating.
- Number shortcuts do nothing on the question side.
- `Escape` closes and leaves the word due; it does not record a rating.
- If the due list becomes empty after a rating, show the completion state instead of closing abruptly.

## 6. Audio hint

Reuse the existing pronunciation path and `PronounceButton` behavior rather than creating another speech implementation. The question-side control must:

- speak `reviewing.word`;
- expose a localized accessible name (“播放单词读音”);
- remain replayable;
- show only playback feedback/wave state, never the word text;
- degrade to a disabled/unavailable state according to the existing pronunciation capability behavior.

Do not autoplay: audio is a user-requested hint and can be disruptive.

## 7. Sentence-meaning hint

- Source is `context_explanation?.trim()` only.
- Reveal it below the source sentence in a visually secondary box.
- Toggle text is “显示句意 / Show sentence meaning” and “收起句意 / Hide sentence meaning”.
- Do not substitute `definition`: a word definition directly leaks the answer and is not the sentence meaning.
- Do not fetch, translate, or ask AI during review.

## 8. UI integration

Refactor only the `reviewing` modal in `src/components/DictionaryContent.tsx` plus the pure helper. Keep the vocabulary list, due filter, import/export, bulk actions, and history untouched.

Question side:

- source book line;
- instruction;
- cloze sentence;
- two small hint controls (audio, sentence meaning when available);
- primary “显示答案” button;
- session progress and Escape affordance.

Answer side:

- word and pronunciation;
- original sentence with the target occurrence emphasized;
- definition and optional contextual explanation;
- the existing four ratings and 1–4 shortcuts.

Fallback side:

- word and pronunciation on the front;
- concise explanation that the older row lacks usable context;
- definition remains hidden until answer reveal;
- same ratings after reveal.

## 9. Internationalization and accessibility

- Add every string to both `src/i18n/en.json` and `zh.json`.
- Use the existing modal semantics and focus trap; initial focus goes to “显示答案”, not a rating.
- `Space` must not trigger while focus is inside another interactive control.
- Hint controls are normal buttons with visible focus rings.
- The blank must not be announced as underscores, a letter count, or punctuation.
- Audio playback feedback uses `role="status"`; it must not repeatedly interrupt screen readers on every animation frame.
- Respect reduced motion for waveform feedback.

## 10. Tests

Add `tests/vocab-contextual-review.test.ts` covering:

- case-insensitive word matching while preserving original sentence text;
- phrase matching;
- Unicode word boundaries;
- rejecting substring-only matches;
- missing/blank context and missing target fallback;
- fixed blank model containing no word length;
- answer reconstruction;
- sentence meaning availability only from nonblank `context_explanation`.

Run:

```bash
npx tsc --noEmit
npx eslint src/components/DictionaryContent.tsx src/components/vocab/contextual-review.ts tests/vocab-contextual-review.test.ts
npm run build
npm run test:unit
```

Visual acceptance checks the approved front, audio hint, sentence-meaning hint, answer, no-context fallback, completion, and loading states in light and dark themes.

## 11. Non-goals

- Changing FSRS scheduling or review intervals.
- Generating new context, translations, or explanations during review.
- Showing spelling hints, first letters, or letter counts.
- Editing vocabulary content inside the review modal.
- Migrating old vocabulary rows.
- Adding a new audio provider.
