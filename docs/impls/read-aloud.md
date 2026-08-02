# Read Aloud — Adaptive Playback for Any Selection

## Problem

Playing a passage is possible today but bad: the dictionary source has no audio
for anything longer than an entry, so a selected sentence falls through to system
voices — mechanical, and on many Windows installs missing an `en-GB` voice
entirely. The Edge source added in v2.4.1 can read passages well, but only if the
user goes into settings and switches to it, which means the people who would
benefit most never find it.

Three further gaps surfaced while scoping this:

- **A sentence that spans a page cannot be selected.** Dragging stops at the page
  edge, so the second half of the sentence is unreachable.
- **A long selection degrades silently.** The backend caps a synthesis request at
  2000 characters and rejects anything longer; the frontend catches the rejection
  and falls back to system voices, so the user hears a sudden drop in quality with
  no explanation.
- **Playback cannot be stopped once the selection menu closes.** The stop control
  lives in the menu, and a two-minute passage outlives it.
- **The whole selection stays lit while it plays.** Selecting several paragraphs
  and pressing play leaves that entire block highlighted for minutes, which is
  tiring to read against and says nothing about where the audio has got to.

## Findings that shaped the design

### Pagination is CSS multi-column, so the DOM is continuous

`paginator.js` `columnize()` sets `column-width` / `column-gap` / `column-fill:
auto` on the section document and hides the overflow. Pages are columns of one
continuous document, not separate documents.

Consequences:

- A `Range` — and therefore a CFI — spans pages with no special handling. Storage
  and rendering of a cross-page selection already work.
- The limitation is purely interactive: the next column is outside the visible
  area and there is nothing to drag onto.

This is why the fix is a selection mechanism, not a data-model change.

### `speak()` resolves when playback ends

`components/speech/player.ts` `speak(ownerId, resolve)` returns a promise that
settles on `onended`. Sequencing chunks is therefore a loop, not a rewrite — the
player is already shaped like a queue consumer.

### A dictionary miss is a fast answer, and it is cached

Youdao replies HTTP 500 `returned null audio` for a non-entry — a normal response
in the 100–300 ms range, not a timeout. `speech.rs` writes a `.miss` marker so the
same text never pays that cost twice.

This makes "ask the dictionary first" cheap enough to use as the routing rule, and
it means the boundary between dictionary and synthesizer can be *the corpus's
actual coverage* rather than a guessed word count. `look up`, `give in` and
`a piece of cake` are dictionary entries with human recordings; any word-count
threshold would route them to a synthesizer and make them worse.

The 10-second dictionary timeout is the exception that needs handling: when the
network hangs rather than answers, an optional first hop must not hold playback
for ten seconds.

### Edge returns word timings we currently discard

`build_config_message` in the client crate requests `wordBoundaryEnabled: "true"`,
and every synthesis comes back with a `WordBoundary` entry per word carrying an
audio offset and duration. Probed against the live service on 2026-08-01 with
`The lantern threw its light. The boat came about.`: 27504 audio bytes plus 9
metadata entries — `"The"` at 0.100 s for 0.175 s, `"lantern"` at 0.288 s for
0.475 s, and so on. `speech_edge_audio` throws all of it away and returns bytes.

This decides the chunking granularity. Without timings, following the audio
sentence by sentence would require one request per sentence — for a chapter,
hundreds of WebSocket connections to an unofficial free service, which is the
most reliable way to get rate-limited or blocked. That risk was the headline
concern when the source was accepted, so a design that maximizes request count is
the wrong one.

With timings, one request per paragraph-sized chunk supports the same
sentence-level following, at roughly a tenth of the requests, and the audio is
more natural because a paragraph synthesized whole keeps its intonation across
sentence boundaries.

Following at sentence rather than word granularity also means the `timeupdate`
event (~4 Hz) is enough to drive the highlight; word-level would need an
animation-frame loop.

### `Intl.Segmenter` is available but must stay guarded

`components/TextBookReader.tsx:435` already feature-detects it, because
`vite.config.ts` targets `safari15` for the macOS 12 WKWebView. Sentence
segmentation follows the same pattern rather than hand-rolling a regex, which
would break on `Mr.`, `e.g.` and abbreviations generally.

### The reader already intercepts click counts and rewrites selections

`pages/reader/useReaderInteractions.ts:399` handles `dblclick` and calls
`replaceDocumentSelection(doc, range)` (`components/reader-interaction.ts:426`)
after computing `wordRangeAtPoint`. Triple-click has the same shape and the same
helpers — a sentence version of `wordRangeAtPoint` is the only new primitive.

## Direction

**One action, adapting to what was selected.** No separate "read aloud" mode, no
extra toolbar button, no second icon. The existing speak control plays whatever is
selected, and the source is chosen for the user.

### Routing

A new `speech_source = "auto"`, which becomes the default:

| Selection | Route |
| --- | --- |
| Word or short phrase | dictionary → (miss or >2 s) → Edge → system voices |
| Sentence or longer | Edge → system voices |

Rules that hold regardless:

- **The paid custom source is never entered automatically.** It plays only when
  explicitly selected, as today. Spending the user's money as a silent fallback
  stays out of bounds.
- The four existing source options remain, as deliberate overrides — offline and
  privacy-conscious users keep the ability to pin system voices.

The 2-second cap is a frontend race, not a backend change: the dictionary request
keeps running after the race is lost and still populates the cache, so a hit that
merely arrived late is a hit next time.

### Selection

- **Triple-click selects the sentence** under the cursor, replacing the browser's
  select-the-paragraph default. Because the block element is one DOM node, the
  resulting range crosses pages for free — which is the common case that motivated
  this.
- **Dragging to the page edge turns the page** and continues the selection, for
  ranges a sentence boundary does not cover.

### Long selections

Split on sentence boundaries into chunks under the backend cap, synthesize and
play them in sequence, prefetching chunk *N+1* while *N* plays. The user hears one
continuous passage. Without the prefetch there is a several-hundred-millisecond
silence at every chunk boundary, which reads as a fault — so it is required, not
an optimization.

### What gets cached

Cached by **length**, not by source. A word clip is 15–30 KB; a 2000-character
chunk is roughly 800 KB — one passage costs what twenty-five vocabulary words do,
and a book read end to end would run into hundreds of megabytes.

| Text | Cached |
| --- | --- |
| Vocabulary-sized (≤ 64 characters), any source | yes |
| Sentence or longer, dictionary or Edge | no |
| Sentence or longer, custom (paid) | yes by default, switchable |

Length rather than source is what keeps saved vocabulary whole: a phrase Youdao
has no entry for is synthesized by Edge, and if Edge output were excluded
wholesale that word alone would be unplayable offline while every word beside it
in the list still worked — a difference the user cannot see or explain.

The paid source defaults to caching everything because the two failure modes are
not symmetric. Disk is recoverable: there is a 2 GiB ceiling, LRU eviction, and a
clear button. Money spent re-synthesizing text the user already paid for is not.
The switch exists for someone who would rather spend the money than the disk.

Reads are unconditional — anything already on disk is served whatever the current
policy says. Only writes are governed, so flipping the switch never orphans
audio that is already there.

This yields an invariant worth stating, because the rest of the design leans on
it: **anything long enough to need highlight following is never served from
cache**, so a followed playback always has fresh timings and the timings never
have to be stored. Short cached clips are one or two sentences and finish in a
couple of seconds; they highlight the selection as a whole and do not follow.

### Following the audio

On play, the bulk selection is cleared and replaced by a highlight on the sentence
currently being spoken, advancing with the audio.

This is the point of keeping the word timings. Playback position comes from the
audio element; the timings say which word that is; the word's position in the
chunk text says which sentence it belongs to; the sentence's `Range` becomes a CFI
and then an annotation — the same `addAnnotation` / `deleteAnnotation` cycle
`flashNavigationTarget` already performs, including restoring a user highlight
that sat underneath.

Clearing the selection first is what makes this readable rather than additive: a
selected block and a reading highlight stacked on each other would be worse than
either alone. The captured `Range` is snapshotted before the selection is dropped,
so what gets read is unaffected.

### Stopping

A floating control appears **only while audio is playing**, carrying stop and
progress. Nothing is added to the toolbar, so the idle reader is unchanged.

## Implementation

### `components/speech/types.ts`

- `SpeechSourceId` gains `"auto"`; `SPEECH_SOURCE_IDS` and `parseSource` follow.
- `DEFAULT_SPEECH_SETTINGS.source` becomes `"auto"`.

### `src-tauri/src/commands/speech.rs`

**Cache writes become conditional.** `cached_audio` gains a flag governing the
write only; the read stays unconditional so existing entries keep serving. Callers
decide:

- dictionary — always (its input is capped at 64 characters anyway)
- Edge — only when the text is within the vocabulary-sized cap
- custom — always, unless the user turns the switch off, then the same cap

A distinct constant rather than reusing `MAX_DICTIONARY_TEXT_CHARS`, which today
means "what the dictionary will accept". Same value of 64; separate name, because
"this is vocabulary-sized" and "this is what Youdao takes" are different questions
that may want different answers later.

**Timings ride the response, never the disk.** `speech_edge_audio` returns the
`WordBoundary` entries alongside the audio, but nothing stores them — by the
invariant above, any text long enough to be followed is never cached, so a
followed playback is always a live synthesis. The payload is framed as a 4-byte
big-endian length, that many bytes of JSON, then the audio, which keeps the
existing raw-`Response` path and its reason (a `Vec<u8>` crosses IPC as a JSON
number array at roughly 4x cost).

### `components/speech/routing.ts` (new)

Pure module, unit-testable without a Tauri host:

- `planSources(kind, settings)` → ordered list of sources to attempt.
- `chunkForSynthesis(text, limit)` → sentence-aligned chunks under `limit`, using
  a guarded `Intl.Segmenter` with a paragraph/whitespace fallback.
- `sentenceAtTime(chunk, timings, elapsedMs)` → which sentence is being spoken.
  Words arrive in order, so their positions in the chunk text are found by
  advancing a cursor rather than searching, and sentence start times fall out of
  the first word in each sentence.

Keeping this apart from `useSpeech` is what makes the routing table, the chunker
and the time-to-sentence mapping testable; all three are pure functions over
strings and numbers.

### `components/speech/sentence-ranges.ts` (new)

One text-node walker serving both new features: it accumulates character offsets
across the text nodes of an element or range, so a character span can be turned
into a `Range`.

- `sentenceRangeAtPoint(doc, x, y, locale)` — for triple-click.
- `sentenceRangesInRange(range, locale)` — for highlight following.

### `hooks/useSpeech.ts`

`resolvePlayback` consults `planSources` instead of the current nested ternary,
and gains the 2-second race for the optional dictionary hop. For a chunked
selection it returns a queue rather than a single playback, and drives it with the
existing `speak()` promise.

### `components/speech/player.ts`

`playBlob` currently starts an `Audio` and resolves on `onended`. It gains a
`timeupdate` subscription so a listener can follow playback position. Sentence
granularity is what makes this cheap — `timeupdate` fires roughly four times a
second, enough to move a sentence highlight without an animation loop.

### `pages/reader/useReaderInteractions.ts`

- Triple-click (`event.detail === 3`) → `sentenceRangeAtPoint` →
  `replaceDocumentSelection`, `preventDefault` to suppress the paragraph select.
  Because the block element is one DOM node, the range crosses pages unaided.
- Drag-to-edge: on `mousemove` with a button held, if the pointer is within the
  edge threshold, turn the page and extend the selection to the new column.

### Reading highlight

Driven from the reader, alongside the existing annotation plumbing in
`pages/reader/useFoliateAnnotations.ts`:

1. On play, snapshot the selection `Range`, then clear the document selection.
2. `sentenceRangesInRange` gives the sentences and their ranges;
   `view.getCFI(index, range)` gives each a CFI.
3. As playback advances, `addAnnotation` the current sentence and
   `deleteAnnotation` the previous one, restoring any user highlight underneath —
   `flashNavigationTarget` already does exactly this and is the model to follow.
4. On stop, end of playback, or reader teardown, remove the last one. This must be
   unconditional: a reading highlight left behind looks like a real highlight the
   user cannot find a way to delete.

### Reader playback control (new component)

Rendered by `pages/Reader.tsx`, visible only when the speech player reports
`loading` or `playing`. Subscribes to the existing `subscribeToPlayer`.

### Settings

`components/settings/SpeechSettings.tsx` gains the `auto` option at the top of the
source list, plus `settings.speech.sourceOption.auto` and
`settings.speech.sourceHint.auto` in `en.json` and `zh.json`. The hint states
plainly that the paid custom service is never chosen automatically.

A second row in the custom-TTS section carries the caching switch —
`tts_cache_passages`, default on, added to `SPEECH_SETTING_KEYS`. Its copy should
say what turning it off actually costs (re-synthesizing a passage bills again)
rather than describing it as a disk-space option, since that is the side of the
trade a user cannot undo.

## Verification

Unit (`routing.ts`, no host needed):

- A word plans dictionary before Edge; a passage skips the dictionary entirely.
- No plan containing `"auto"` ever includes the custom source.
- An explicit source yields exactly that source plus the system fallback.
- Chunking never exceeds the cap, never splits mid-sentence, and reassembles to
  the input text.
- Chunking degrades to whitespace splitting when `Intl.Segmenter` is absent.
- `sentenceAtTime` returns the right sentence at a boundary, at time zero, and
  past the end of the last word; it tolerates timings whose word text does not
  match the chunk exactly (punctuation attached, repeated words).

Backend (`cargo test --lib commands::speech`):

- A framed payload round-trips: timings and audio come back exactly as written.
- A vocabulary-sized Edge clip is written to the cache; a passage-length one is
  not, and neither leaves a `.partial` behind.
- With the switch on, a passage-length custom clip is cached; with it off, it is
  not — and in both cases an entry already on disk is still served.
- Live (`--ignored`): a synthesis returns at least one word timing, ordered by
  offset.

Reader (manual, recorded in the PR):

- Triple-click selects a sentence, not a paragraph.
- Triple-click on a sentence that spans a page selects the whole sentence.
- Dragging to the edge turns the page and keeps the selection.
- A >2000-character selection plays continuously with no audible seam.
- The bulk selection clears on play and the highlight follows sentence by
  sentence, including across a chunk boundary.
- Stopping mid-passage leaves no highlight behind; a user highlight the reading
  highlight passed over is still there afterwards.
- Closing the selection menu mid-playback leaves the floating control reachable.

## Steps

1. `routing.ts` with its tests — the routing table, chunker and time-to-sentence
   mapping are the parts worth getting right before any UI exists.
2. `types.ts` + settings option + i18n.
3. `useSpeech` wiring: plan, race, queue.
4. Backend: conditional cache writes, the custom-source switch, and timings
   returned from `speech_edge_audio`.
5. `sentence-ranges.ts` + triple-click.
6. Highlight following (needs 4 and 5).
7. Drag-to-edge page turn.
8. Floating playback control.

Steps 1–3 alone already fix the silent-degradation and routing problems and are
shippable on their own; 4–6 are the reading highlight; 7–8 are the remaining
interaction gaps.

## Follow-up: pause, and what the gesture selects

Three things came out of using the shipped version.

### The highlight had to be captured earlier

The follower captured the selection on the first progress event, which only
arrives after the synthesis round trip. Clicking anywhere during that wait
cleared the selection, so `capture()` found nothing and the passage played with
no highlight at all — while a click *after* audio started was harmless.

Capture moved to the `loading` publish inside `speak()`, which runs in the same
frame as the click that started it. The selection is necessarily still there. It
is only *cleared* on the first progress event, so the two things the old code did
at once — read the ranges, drop the selection — now happen at the two moments
each actually belongs to.

The follower also became owner-aware: it serves detached playback only, ignores
progress from any other `ownerId`, and keeps its highlight while its passage is
parked. Without that, a word played over a paused passage would drag the
passage's highlight along with it.

### Pause is a parked run, not a flag

`Run` records everything needed to restart a queue where it stopped: the step
index, the offset into that step, and the clips already fetched — so resuming
costs no round trip and no second charge on a metered provider. `park()` is the
per-clip stop, and the two clip kinds park differently:

- **Audio** resolves its promise with `"parked"`; the loop returns and a resume
  re-enters `runQueue` from the seed. The element is discarded, the blob kept.
- **A voice** is *held*: `speechSynthesis.pause()` leaves the utterance inside
  the engine and the loop suspended in its `await`. Resuming restores
  `generation = run.token`, which revives exactly that loop — tokens are unique,
  so nothing else can be woken by mistake.

`speechSynthesis` is one global engine, which forces two rules. Cancelling a
paused engine leaves it paused, so every cancel resumes first. And anything else
that needs the engine must evict the hold, degrading that run from "resume in
place" to "re-speak this step" — which is why a parked run records a step index
and not only an offset.

`paused` is a separate field on the player state rather than a `status` value,
because the two genuinely disagree: a word playing over a parked passage owns the
foreground while the passage still has to be resumable from the bar.

The covering case — click a word mid-passage, hear it, carry on — falls out of
this: a non-detached playback started while a detached one is *making sound*
parks it instead of killing it. While the passage is still fetching there is no
position worth keeping, so the word simply wins.

### Triple-click selects; what it selects is a setting

Triple-click stays a selection gesture rather than becoming a second lookup —
a card that opens itself on a whole sentence is harder to undo than one the
reader asked for. What it grabs is configurable: sentence (default) or paragraph.

Paragraph goes through `paragraphRangeAtPoint` rather than deferring to the
browser's native triple-click, so the boundaries land on real characters instead
of the newline and indentation an EPUB has between tags, and the selection menu
sees the same snapshot either way.

Turning the gesture off frees `mouse:triple` as a bindable trigger, with the same
two-way conflict guard `mouse:double` already has.

## Parked

- **Continuous reading past the selection** — whole chapter, auto page turn,
  advancing the position as the audio outruns the visible page. Reading only what
  was selected removes auto page turn and nearly all of the state-interaction
  surface, which is what keeps this version small.
- **Word-level highlight following.** The timings support it, but a marker moving
  word by word is plausibly more tiring than the block it replaces, and it would
  need an animation-frame loop instead of `timeupdate`. Revisit only if sentence
  following turns out to feel coarse.
- **Reading position memory across sessions.**

## Figma design prompt

Design a floating playback control for the reader, shown only while a selection is
being read aloud.

It should read as a temporary status object rather than a permanent control
surface: the reader's chrome is otherwise unchanged, and this appears and leaves
with the audio. Anchor it low in the reading area, clear of the page-turn regions
and of the selection menu, so it never covers the text being read.

Content is a stop affordance and a sense of progress through the passage — enough
that someone who selected three paragraphs can tell whether they are near the end.
For a short selection, progress is close to meaningless; consider whether it
should be present at all below some duration.

The sentence being spoken is highlighted in the text itself, so the control does
not need to show position — the page already does. Give the reading highlight its
own treatment, distinguishable at a glance from a user's saved highlight, since
both can be on screen at once and only one of them is permanent.

States: appearing (audio requested, nothing playing yet), playing, and leaving.
The appearing state matters more than usual here — synthesis takes a few hundred
milliseconds and the user has just clicked, so the control is the only evidence
anything happened.

Match the existing reader surfaces for elevation, corner radius, and how it sits
against both light and dark reading themes.
