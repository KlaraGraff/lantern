# Pronunciation — Play Button, UK/US Toggle, Pluggable Speech Sources

## Problem

The learning card shows IPA (inside `word_info.meta`, AI-generated), but IPA alone does not
teach a learner how a word actually sounds. There is no way to hear anything, anywhere in the
app.

Requirements:

1. A play button next to the looked-up word, plus a **UK/US** badge beside it that switches
   accent in one click.
2. The same control on selected text (not only on dictionary lookup).
3. Two user-selectable sources: the OS speech engine, and a user-configured third-party TTS API.

## Findings that shaped the design

Measured 2026-07-31 against the live endpoints.

### Youdao `dict.youdao.com/dictvoice?audio=<text>&type=1|2` is a *dictionary lookup*, not a TTS

| input | result |
|---|---|
| `pronunciation` type=1 (UK) | 200, 171 KB **WAV** 48 kHz — human recording |
| `pronunciation` type=2 (US) | 200, 14 KB MP3 — human recording |
| `antidisestablishmentarianism` | 200, 60 KB MP3 24 kHz — synthesized fallback |
| `look up`, `a piece of cake`, `kick the bucket`, `How are you`, `hello world` | 200 |
| `the quick brown fox` (19 chars) | **500** `{"msg":"returned null audio"}` |
| `zxqwvbnm` | **500** |

Success does **not** correlate with length — it correlates with *being an entry in Youdao's
corpus*. A 19-character non-entry fails while a 17-character idiom succeeds. Consequences:

- We cannot predict a hit. The only workable strategy is **try → fall back on failure**.
- **Negative results must be cached**, or every replay of a non-entry pays a full round trip
  before falling back.
- A length cap is only a coarse pre-filter against sending whole paragraphs, not a hit predictor.

### `Content-Type` lies

UK responses arrive as **WAV** bytes under `Content-Type: audio/mpeg`. The MIME must be sniffed
from magic bytes, not taken from the header, or playback silently fails.

### dictionaryapi.dev (Wiktionary audio) was evaluated and rejected

| word | audio available |
|---|---|
| `schedule` | **none** |
| `tomato` | **none** |
| `hello` | au, uk (no us) |
| `advertisement` | us only |
| `water` | uk, us |

The two most canonical UK/US-divergent words have no audio at all. Coverage fails exactly where
the feature matters.

### Eudic (欧路) cannot be integrated

Its open platform (`api.frdic.com`) is a **wordbook-sync** API under OAuth. There is no public
pronunciation endpoint; in-app audio is internal. Not an option.

## Direction

**No single source covers every case**, so a fallback chain is a requirement, not polish:

| | word / phrase | full sentence | UK vs US | offline | cost |
|---|---|---|---|---|---|
| Dictionary (Youdao) | ✅ human recordings | ❌ 500 | ✅ genuinely distinct | ✅ once cached | free |
| System voices | ✅ adequate | ✅ | ⚠️ Windows often ships US only | ✅ | free |
| Custom TTS (OpenAI-compatible) | ✅ | ✅ most natural | ⚠️ depends on voice | ❌ | metered |

```
User picks one preferred source; the app resolves per request:

word/phrase → dictionary ──(500 / network error)──→ system voices
passage     → dictionary can't ────────────────────→ system voices
preferred = custom TTS → always custom ──(failure)──→ system voices
```

**Every source falls back to system voices, and only to system voices.** An earlier sketch had
the dictionary escalate to custom TTS for passages it cannot serve. That was dropped: the custom
source is metered, and silently spending the user's money as a fallback is a nasty surprise. The
selected source is the only paid path.

Default source is **dictionary**. That also sidesteps the Windows missing-UK-voice problem on
the default path — it only surfaces if the user explicitly picks system voices.

### Accepted risk

`dictvoice` is an undocumented endpoint with no third-party grant. It may change or rate-limit,
and each playback sends the word to Youdao. The owner accepted this on 2026-07-31 in exchange
for free, zero-config, genuinely UK/US-distinct audio. The fallback chain keeps the feature
alive if it disappears; the adapter is isolated so it can be swapped.

## Implementation

### Backend — `src-tauri/src/commands/speech.rs`

```rust
speech_dictionary_audio(text, accent) -> tauri::ipc::Response  // raw bytes, no base64
speech_cache_stats() -> { bytes, entries }
speech_cache_clear()
```

Raw `ipc::Response` avoids the ~4x cost of serializing `Vec<u8>` as a JSON number array; the
frontend sniffs `RIFF` → `audio/wav`, else `audio/mpeg`.

Error codes distinguish the two failure modes so the UI can be honest:

- `SPEECH_NOT_IN_DICTIONARY` — HTTP 500 / empty body. **Cached** as a `.miss` marker (30-day TTL,
  so a later corpus addition is eventually picked up).
- `SPEECH_SOURCE_UNAVAILABLE` — network/timeout/unexpected status. **Never cached.**

Both fall back to system voices; only the second is worth surfacing as a transient error.

### Cache — `$APPDATA/speech-cache/<sha256(source|accent|text)>.{bin,miss}`

Measured payloads are 14–60 KB (MP3) and up to 171 KB (WAV), so ~40 KB average.

- **Limit 2 GiB** ≈ 50,000 clips. Eviction is effectively unreachable in normal use — chosen
  deliberately, because a cleared cache means a word that used to play no longer does.
- **Vocabulary words are pinned** and never evicted, so the saved-words list stays playable
  offline forever.
- LRU via `File::set_modified` on cache hit (stable since Rust 1.75; no new dependency).
- Settings shows current size with a manual clear action.

### Frontend

```
src/components/speech/
  types.ts             SpeechAccent | SpeechKind | SpeechSourceId, settings parsing
  system-voices.ts     voice inventory, voiceschanged handling, accent availability
  dictionary-source.ts invoke + magic-byte sniff + Blob
  player.ts            module-level singleton: one clip at a time, cancels the previous
  PronounceButton.tsx  speaker icon + UK/US badge
src/hooks/useSpeech.ts hook over player + settings + fallback chain
```

`player.ts` is a module singleton rather than React state because both `speechSynthesis` and
`HTMLAudioElement` are global — two cards must not talk over each other.

### Settings (KV only, no migration)

| key | values | default |
|---|---|---|
| `speech_source` | `dictionary` \| `system` \| `custom` | `dictionary` |
| `speech_accent` | `uk` \| `us` | `us` |
| `speech_rate` | `0.5`–`1.5` | `1` |
| `tts_base_url` / `tts_model` / `tts_voice_uk` / `tts_voice_us` | provider settings | empty |

The API key is `tts_api_key` in the **secrets store**, added to `SENSITIVE_KEYS` so
`get_all_settings` can never return it. `speech_custom_key_configured` is metadata-only, like
`ai_api_key_configured` — opening settings never decrypts it. A new **发音 / Speech** tab in
`ToolsSettings` (alongside interaction/cards/menu/markers/ocr).

The controls read from a shared module store rather than `useSettings`, because every looked-up
word renders a pronounce button and each `useSettings` mount is another `get_all_settings` round
trip. The store loads once per window and rides the existing settings broadcast.

### The custom source

`POST {base_url}/audio/speech` with `{model, input, voice, response_format: "mp3"}` and a bearer
key — the shape every OpenAI-compatible provider accepts.

- The **cache identity folds in base URL, model and voice**, so changing any of them serves fresh
  audio instead of the clip recorded under the old settings, and the two sources cannot collide
  in the shared directory.
- **Base URL is normalized**: trailing slash optional, and pasting the full `/audio/speech`
  endpoint does not produce `/audio/speech/audio/speech`.
- **British falls back to the American voice** when left blank, since single-voice providers are
  normal.
- **401/403 reports `SPEECH_CUSTOM_NOT_CONFIGURED`**, not a transport error, so the UI points at
  settings instead of blaming the network.
- Text limit is 2000 chars (vs 64 for the dictionary) — a real synthesizer reads passages, and
  the cap bounds per-play cost. Timeout is 60s rather than 10s for the same reason.

### Voice selection

macOS lists novelty voices (Zarvox, Bubbles, Bad News) in the same `getVoices()` array as real
ones, in an OS-determined order — on the development machine `en-US` returns Samantha first but
Albert and Bad News immediately after. Taking the first match is therefore a coin flip, so the
voice flagged `default` wins when it matches the requested accent. Novelty voices are not
name-blacklisted; that would be brittle and locale-dependent.

### Windows missing-voice handling

Scan `speechSynthesis.getVoices()` for `en-GB` / `en-US`. An unavailable accent is rendered
**dimmed but present** (hiding it would leave the user unaware the option exists); clicking it
raises a toast:

> 当前系统内置仅支持美式发音，如需其他发音请另行安装
> Your system only has US English voices installed. Install a UK English voice for British pronunciation.

Only reachable when the source is `system`.

### Integration points

| # | where | kind |
|---|---|---|
| 1 | `LearningCardView` header, beside the title | `word` / `phrase` / `passage` |
| 2 | `ReaderContextMenu` `speak` row | selection |
| 3 | `VocabDetailModal` header, and the review card in `DictionaryContent` | word |
| 4 | `speak` reader binding (any key or mouse trigger) | selection |

The dense vocabulary **list rows** were deliberately left out: each row is already one big
`<button>` that opens the detail view, so a nested control would be invalid HTML and would need
the row restructured, for a play button in a 160px column. The detail view and the review card —
where you actually stop and study a word — carry it instead.

The card header's drag handler already skips `button` elements, so the control can sit inside it
without hijacking drags.

The selection-menu row exists so that hearing a word does not require running an AI lookup
first. It owns its playback through `usePronunciation` and needs no wiring from the reader, and
it deliberately does not dismiss the menu — replaying and switching accent are exactly what is
wanted right after a play. Because HTML forbids nested buttons, the row is a flex container
holding two sibling `role="menuitem"` buttons, which also keeps both reachable by keyboard.

`speak` is a configurable menu action like any other. `parseMenu` appends built-ins that a
stored config predates, so it turns up enabled — but at the *end* of the menu for anyone who had
already customized it, rather than in the second slot new installs get. Reordering is a drag in
Settings → Learning Tools → Action Menu; no migration is written for this.

## Verification

- `commands::speech` unit tests cover accent mapping, text normalization and cache-key
  stability. Three further tests hit the live endpoint and are `#[ignore]`d out of CI; run them
  with `cargo test --lib commands::speech -- --ignored` when changing the cache or request shape.
  They assert that audio is fetched then served from disk, that a non-entry is remembered as a
  miss, and — the point of the feature — that UK and US audio for `schedule` genuinely differ.
- The custom source is pinned against a one-shot local HTTP server (no network, runs in CI): the
  request line, bearer header and JSON body are asserted verbatim, plus 401 mapping to
  misconfiguration. Getting that wire format wrong is invisible locally and near-impossible for
  a user to diagnose against their own provider.
- `tests/speech.test.ts` covers settings parsing/clamping, the magic-byte MIME sniff, and the
  voice inventory across installs: both accents present, US-only (the common Windows case),
  underscore language tags, no English voices, and no `speechSynthesis` at all.
- `tests/selection-menu-config.test.ts` pins that `speak` reaches menus configured before it
  existed, enabled and without disturbing the user's ordering.

## Steps

- **Step 1 (this doc's scope)** — dictionary + system sources, fallback chain, disk cache,
  `PronounceButton`, learning-card integration, accent toggle, Speech settings tab.
- **Step 2** *(shipped)* — OpenAI-compatible custom TTS, key in the secrets store, provider
  settings UI.
- **Step 3** *(shipped)* — selection-menu `speak` row, vocabulary detail and review integration,
  bindable `speak` reader action.

## Figma design prompt

> Design a compact inline pronunciation control for a desktop reading app's dictionary card,
> in both light and dark themes.
>
> **Structure.** A speaker icon button, then a small accent badge reading "英"/"美" (or "UK"/"US"),
> sitting on one baseline immediately after a bold word heading in a card header. The whole
> control should read as one unit, secondary to the word itself — it must not compete with the
> heading for attention.
>
> **States for the speaker button.** Idle; hover; loading (audio is being fetched); playing
> (should feel alive without animating so strongly it distracts from reading); error (audio
> unavailable — muted, non-alarming, explains itself on hover).
>
> **States for the accent badge.** Selected accent; the alternative accent on hover; and an
> unavailable accent that is visibly dimmed but still legible and clickable, since clicking it
> explains why it is unavailable.
>
> **Behavior to convey.** Clicking the badge both switches the accent and immediately replays —
> it is one action, not a two-step setting. Make the badge look tappable rather than like a
> static label.
>
> Deliver the control at the sizes it appears in: beside a 13px card title, and beside a 20px
> word heading. Show it in place inside a card header, not floating in isolation.
