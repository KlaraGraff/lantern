<div align="center">

<img src="assets/icon.png" width="112" alt="Lantern">

# Lantern

**Put the AI inside the book, instead of hauling the book into a chat window.**

[![Release](https://img.shields.io/github/v/release/KlaraGraff/lantern?style=flat-square&color=1f6feb&label=release)](https://github.com/KlaraGraff/lantern/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows-555?style=flat-square)](#supported-platforms)
[![License](https://img.shields.io/badge/License-MIT-555?style=flat-square)](LICENSE)

[简体中文](README.md) · [English](README.en.md) · [Download](https://github.com/KlaraGraff/lantern/releases)

</div>

<!-- screenshot placeholder: reader overview (text + lookup card + AI sidebar)
![Lantern reading view](assets/screenshots/hero.png)
-->

---

## You already read with AI. It's just awkward.

You hit a paragraph you don't get. Copy, switch windows, paste. The model doesn't know which book you're in, which chapter, what came before or after, or how good your English is — so it answers in the register of a native speaker. Switch back and you're hunting for your place again. And the answer floats free: to check it against the text, you're on your own.

**Lantern is built the other way around.** A local-first desktop reader for macOS and Windows, running on your own AI service. Everything you'd otherwise have to explain every single time, it already knows.

1. **It has the context** — your English level, how far you've read, which book and chapter, what surrounds your selection, and what it has learned about the kind of explanation you want.
2. **Every sentence it writes clicks back to the text** — not a floating answer, an answer that takes you to the line in the book.
3. **What you've read, it tracks on its own** — which words you no longer look up, which ones you tripped over again, how much of a book you can already read.
4. **What it says and how it says it, you write** — if the built-in modules don't fit, write your own prompt.
5. **It doesn't even have to be it** — hand your library to Claude Code or Codex over MCP.

---

## 1 · It knows far more than a chat window does

A chat window gets the few lines you pasted. Every Lantern request also carries these, **without you saying so**:

| It knows | So |
| --- | --- |
| Your English level | Wording and complexity move with it, instead of defaulting to native-speaker register |
| What kind of explanation you want | Summarised from your look-ups and follow-ups; you can also just write it down |
| How far you've read | By default it won't answer using parts you haven't reached |
| Which book and chapter | It recognises names, places and prior events — no "this is from X" preamble |
| What surrounds your selection | It pins down what the word means *here*, instead of listing senses for you to sort out |
| The whole book | Answers are retrieved from the text, not recalled from the model's memory of it |

### It knows your level

Most tools treat "explain in English" as a switch: flip it, get near-native English. For a B1 reader that paragraph is a second obstacle. Lantern treats your level as **a condition on every request** — enter a CEFR level (A1–C2), or an IELTS, TOEFL, TOEIC, Cambridge, DET or CET score and let the app convert it. Explanation language is a separate choice: Chinese / Chinese + English / English only.

But "meeting you where you are" slides easily into being vague for the sake of being simple. So there's a hard rule: **if an explanation genuinely needs a word above your level, it keeps that word and glosses it on the spot** — a few simpler English words, or a short parenthetical. It may not swap in something vaguer, and it may not leave it hanging for you to look up.

A separate **explanation style** switch governs how many points a card gives: **Thorough** adds more, **Essentials** keeps only what you need right now.

<!-- screenshot placeholder: learning preferences, plus the same word explained at two levels
![Explanations tuned to your level](assets/screenshots/level.png)
-->

### It knows what kind of explanation you want

Your level says what you can read; it says nothing about what you want. Two B2 readers: one wants etymology, the other finds it noise.

So there's a **user profile** page the AI reads before it answers. The top half you write; the bottom half is summarised by the system from your look-ups and follow-ups, across seven dimensions (sense, syntax, reference, cultural background, look-up disposition, source of examples, answer pacing).

- **Every card opens onto its evidence** — which records led to that conclusion, laid out for you.
- **On conflict, what you wrote wins.** Disagree and move it into the top half; that dimension is yours from then on.
- **The whole thing can be switched off**, contents preserved.

<!-- screenshot placeholder: profile page — what you wrote, the seven-dimension cards, one opened onto its evidence
![It knows what kind of explanation you want](assets/screenshots/profile.png)
-->

### It knows how far you've read

**By default it won't answer using parts you haven't reached.** Once you know what happens later, whatever you would have worked out yourself never gets the chance.

Reading-thought protection confines answers to what you've read and marks them "answered up to your reading progress (first X%)"; one click re-asks against the whole book. Settable per book, with retrieval scope up to you: automatic / selection / chapter / whole book.

Character and term cards work the same way — **capped at where you are**, and when you need the whole-book view it says up front that this includes unread plot, for that one card only.

<!-- screenshot placeholder: AI sidebar scope picker, protection switch, progress note under the answer
![It knows how far you've read](assets/screenshots/context.png)
-->

---

## 2 · Every sentence it writes clicks back to the text

Before a chapter, ask it to list the words you probably don't know — **every entry carries a superscript that turns the book to the sentence that word is in**. Same for plot questions: the evidence comes with the answer, each piece clickable.

The best product doing this is NotebookLM, but its citations land on a chunk of text in a side panel — **Lantern is the reader, so a citation lands on the actual page and the actual line**, with a flash at the landing point.

- **Citations are inline.** Superscripts in the body, a row at the end; both clickable. Example sentences in the answer are links too.
- **Found in the source text, not guessed from a page number.** EPUB searches the quoted fragment within its chapter, falling back to an alternate fragment and then the chapter opening; PDF jumps to the page; plain text uses character offsets.
- **They cross books.** Quote a sentence from another book and clicking opens that book at that line, with "jumped here from a question about X / back to X" at the top.
- **Answers are retrieved** — a full-text index per book, with a semantic layer on top when embeddings are configured.
- **And they're bound by the previous section.** Citations never come from where you haven't read.

### Ask in Chinese, still find the passage that only ever says "Darcy"

You ask about 达西 and the book says Darcy throughout — literal search returns nothing. So while indexing, the AI also picks out the book's characters and folds translated names, short forms, nicknames and "that clergyman"-style references onto the form the book actually uses, stored as that book's **person alias table** (editable, rebuildable).

When one label points at more than one person it doesn't guess silently: the answer says which reading it used, one click swaps it, and the swap sticks for that book. When it recognises nothing it says so — "couldn't tell who X is, searched literally" — and lets you identify them on the spot.

### Come back days later and everything you saved is still attached to the book

Chat history is an ever-growing stream; a word list is words cut off from their sentences. In Lantern what you save stays attached to the book: **Notes** (a bookmark is a kind of note), **Words** and **Q&A**, each grouped by book and searchable, every entry carrying a jump-back that lands on that line. A word card keeps the passage it came from and what the word meant **in that sentence**. The margin-notes panel puts each note beside the paragraph it refers to; open the book and **the conversation comes back into the sidebar with it**, superscripts still live.

**Trails are left without your help.** Words you looked up and passages the AI cited get a light mark in the text; as a word becomes effortless its mark fades on its own (or can be pinned at one depth forever).

Select a passage, hit **Interpret**, and **the result is cached**: select the same passage again in the same book and it's instant, with no second API call. Press save only if it's worth keeping — caching saves money, the list is curated by you.

<!-- screenshot placeholder: superscripted vocabulary list, and the passage a superscript jumps to
![Clickable citations](assets/screenshots/citations.png)
-->

---

## 3 · What you've read, it tracks on its own

In reading, the time you spend not asking dwarfs the time you spend asking. Most vocabulary apps turn that time into a chore: notifications, red dots, streaks. Lantern fixed three opposite rules — **no push notifications, no popups, no badge on the app icon** — and at most a **grey number** beside the sidebar entry. A grey number is information; a red dot is a demand. **Review is something you walk into.**

### Mastery isn't a box you tick, it's something you read your way into

A word appeared on a screen you read and you didn't look it up — that's evidence you know it. Enough of it promotes the word a rung: **New → Learning → Familiar → Effortless**. A word that had climbed, looked up again, drops a rung. **"Thought I had it, then looked it up again" isn't a failure — it's a truer signal than any quiz.** Repeats within one chapter count on a decreasing scale, but never zero.

Every word opens onto **"how it got here"**: which day, in which book, how many cross-day encounters without a look-up, what each review graded it. Disagree, and there's always **"I don't actually know this one"**. Mastery is stored **per word** and shared across books.

<!-- screenshot placeholder: mastery timeline with "I don't actually know this one"
![Mastery you read your way into](assets/screenshots/mastery.png)
-->

### Review gives you piles with reasons, not a queue

Each pile says why it exists: **words you kept looking up in X**, **thought you had it, then looked it up again**, **you looked these up in the chapter you just finished**, **haven't run into these in a long time**.

The original sentence isn't thrown away: the word is blanked out of it, hinting pronunciation first, then the sense you already saved, and only then the answer. Intervals are scheduled by the official FSRS library.

### How hard this book is *for you*, computed locally

"This book is B2" is something publishers print on the back cover. Lantern splits it into two questions, **both computed on your machine — no network, no AI quota**:

**How heavy the book is** — at import, the whole text is mapped onto a 50,000-word frequency table, producing a band distribution. This has nothing to do with who's reading.

**How much of it you know** — count the text against the words you already know. Not an isolated percentage but a position on a ruler: two reference lines at 95% and 98%, taken from comprehension thresholds commonly used in applied linguistics (Nation, 2006), mapping onto "readable now with the dictionary open a lot / readable with frequent look-ups / you can read this one on your own". Unfold for the token composition and for **"which words would help most"**.

Three boundaries: **thin records get an interval and its basis**, and if the range straddles a reference line it says it can't tell; **it never changes your level setting for you**; **too short, or a format it can't extract text from, and it declines to conclude**.

Before you first open a book this converges into an **open card**: vocabulary composition, which chapters are heaviest, roughly how long it will take at your pace — **shown once**. A scanned file gets "Download and recognise" right here: local OCR, nothing uploaded, and you can start reading immediately.

<!-- screenshot placeholder: coverage ruler + token composition + which words would help most
![This book, measured against you](assets/screenshots/coverage.png)
-->

### Everything that spends money on its own, on one screen

A few things call the AI while you aren't looking, on your own quota — the category that turns into an invisible bill. So they're all collected onto **one page, Automatic Analysis**: each item states what it does, when it fires and what it sends, with its 30-day call count and token usage beside it. **Usage is the exact number the provider returned, never converted to money** (only they can price cache hits and tiered rates). Turning everything off costs you nothing — each feature keeps a manual button — and failures aren't silent; they leave a pending card.

Reading statistics work the same way: **Reading history / Reading calendar / Learning**, with no leaderboards, streaks or penalties. The AI recap only narrates — **the facts are computed locally and deterministically first; it may not recompute, and may not invent data** — and it never sends the text, highlighted passages or unread content.

---

## 4 · The built-in modules are a starting point

11 modules for word cards, 8 for phrases, 9 for passages (contextual meaning, common senses, collocations, roots and affixes, grammatical role, synonyms, memory aid, source sentence, and more), each individually toggleable, reorderable, with its own default expansion and density.

**But a preset shouldn't dictate your method.** Build your own: name it, write **a prompt entirely your own** (up to 2,000 characters) generating from the current selection, its context and the book, then add it to a card alongside the built-ins. Up to 8 custom modules per card type, plus 6 custom selection actions.

So you can build **complex-sentence breakdown** for IELTS, **rhetoric and narrative perspective** for literature, **terminology and prerequisites** for technical books, or a **minimal look-up** that barely interrupts.

<!-- screenshot placeholder: custom module editor + module ordering
![Custom AI modules](assets/screenshots/modules.png)
-->

---

## 5 · Or swap in your own AI

Lantern ships an **MCP server**. Turn it on and Claude Code or Codex can read your reading data directly — **you copy and paste nothing**: books, collections, metadata and index state; your CEFR level and test scores (**the same record the built-in AI uses**); word list, mastery, statistics, look-up history; highlights, bookmarks, notes, in-book conversations, and whole-book and per-chapter summaries.

29 tools: 12 read-only queries, one "open in reader", 16 writes. Read-only by default; **write access is a separate switch that ships off** — handing over your data and handing over control are two different things. Deletions and overwriting imports ask again for that specific operation.

So you can ask, from a terminal: "given my English level, pick three books from my library I could actually finish." It reads your real reading record.

<!-- screenshot placeholder: MCP settings beside a Claude Code terminal
![Hand your library to Claude Code](assets/screenshots/mcp.png)
-->

---

## 6 · Everything is adjustable, and the defaults already thought it through

**Almost nothing in Lantern is hard-coded.** But "everything is adjustable" that means "you must finish adjusting before you can use it" is just handing you the work. Three examples:

**Defaults tell you the cost.** Bold and font-swap are off in mark styling — they change glyph widths, and in paginated mode a single mark reflows the page. Colour and underline move no text.

**Defaults stop you once.** The app draws on the text too: the speech position is a cool blue wash, and New / Learning / Effortless are three grades of underline — a deliberate gradient of attention withdrawing. If your colour sits too close, settings says so on the spot and names which one it collides with. That judgement blends both colours **against the actual paper background** before measuring distance, rather than comparing hex values.

**Defaults operate on words, not character strings.** You looked up `run`; later `ran` / `running` match nothing by string. So "when marking a word" has three settings: this position only / same spelling book-wide / **all forms of the same word**. Forms are AI-generated on demand, or filled in across the library in batch.

Typography follows the same logic and **defaults to the publisher's intent**: Latin and CJK fonts are set separately, neither compromising for the other; first-line indent and paragraph spacing are mutually exclusive — turn on indent and spacing is flattened (block quotes and empty paragraphs excepted). Beyond the global default, any book may keep its own exception.

---

## Up and running in three minutes

1. **Install** — grab the package for your platform from [Releases](https://github.com/KlaraGraff/lantern/releases).
2. **Add an AI service** — Settings → AI Configuration: OpenAI-compatible API, Anthropic, Ollama, or your own gateway. The key stays on this device.
3. **Drop in a book** — drag an EPUB / PDF / TXT into the library, open it, and **double-click any word**.

To make it fit you: Settings → Learning Preferences for level and explanation language, Settings → Personal for a couple of lines the AI should know upfront, Settings → Lookup & Cards for the modules you want to see.

---

## Full feature list

<table>
<tr><td width="130"><b>AI comprehension</b></td><td>Contextual look-up · phrase definitions · passage interpretation · translation · continuous in-book conversation · <b>clickable source citations on every answer; example sentences are links too</b> · citations jump across books and back · full-text index + optional semantic retrieval · answer scope: automatic / selection / chapter / whole book · <b>reading-thought protection</b>, with one-click re-ask against the whole book · <b>person alias table</b>; ambiguous references state which reading was used and can be swapped on the spot · character / term cards · shows exactly which source text went into this request · Q&A archived per book and searchable; interpretations cached</td></tr>
<tr><td><b>It knows you</b></td><td><b>User profile</b>: top half yours, bottom half summarised into seven dimensions — each card opens onto its evidence, can be rewritten and taken over, loses to what you wrote on conflict, and the whole page can be switched off · learner level (CEFR, or converted from IELTS / TOEFL / TOEIC / Cambridge / DET / CET) · explanation language: Chinese / Chinese + English / English only · <b>explanation style: Thorough / Essentials</b></td></tr>
<tr><td><b>Learning loop</b></td><td>Word list · look-up history · <b>four mastery rungs (New / Learning / Familiar / Effortless), promoted by reading past a word, demoted by looking it up again</b> · per-word "how it got here", with "I don't actually know this one" always available · stored per word, shared across books · word cards regenerable whole, with the card as saved · <b>review grouped by reason</b>, not an algorithmic queue · official FSRS · cloze in the original sentence with layered hints · notes centre and margin-notes panel · CSV / JSON import and export · export to Markdown / CSV / Anki CSV</td></tr>
<tr><td><b>This book vs. you</b></td><td>Whole-book frequency computed locally at import, mapped onto a 50,000-word table · <b>coverage placed on a ruler with reference lines at 95% and 98% (Nation, 2006)</b> · unfold for token composition and "which words would help most" · thin records give an interval with its basis · options for counting "familiar" as known and showing coverage on shelf cards · <b>open card</b> shown once, before first open · level comparison excludes the book's topical vocabulary · <b>offline, no AI quota, and it never changes your level setting</b></td></tr>
<tr><td><b>Marks in the text</b></td><td><b>Looked-up words and AI-cited passages are marked automatically</b>, fading as words become effortless (can be disabled) · three match scopes: this position / same spelling / <b>all forms of the same word</b> (AI-generated or batch-filled, hand-editable) · saved words can show a gloss above the word or in the margin · manual highlights · independent styling for manual and automatic marks · warns when a colour collides with a system mark · never modifies the original file</td></tr>
<tr><td><b>Reading experience</b></td><td>Warm paper themes and custom backgrounds · dark mode follows the in-app choice, not the OS · <b>separate Latin and CJK fonts</b> · custom font import · size, line height, letter and word spacing, margins, justification, hyphenation · <b>indent and paragraph spacing are mutually exclusive</b> · global defaults with per-book overrides · scrolled / paginated · table of contents · margin-notes panel · cascading multi-window · collections · title and author read from the EPUB at import</td></tr>
<tr><td><b>Speech</b></td><td>Four sources: dictionary recordings / system voices / Edge neural voices / your own OpenAI-compatible TTS · source chosen automatically by length and language · continuous playback bar · flows across paragraphs, pages and chapters · sentence-level follow highlighting · resumes where it stopped</td></tr>
<tr><td><b>Reading review</b></td><td>Reading history / calendar / learning · filter by range and book · 5-minute idle pause, sub-30-second sessions discarded · locally recomputable · optional AI recap that only narrates structured facts</td></tr>
<tr><td><b>Quota and automation</b></td><td><b>One page listing every task that calls the AI while you aren't looking</b>, each with trigger, data sent, 30-day count and tokens · totals and "turn everything off" · usage taken verbatim from the provider, never converted to money · manual buttons kept when switched off · failures leave a pending card</td></tr>
<tr><td><b>AI services and indexing</b></td><td>OpenAI-compatible APIs · Anthropic · Ollama · optional OpenAI OAuth · multiple services with priority · multiple keys per service, tried before output begins · connection tests and model discovery · <b>batch-index the whole library</b>, pausable and resumable · per-book indexing in five phases (chunking / sentence locations / embeddings / chapter summaries / person names) with per-phase retry</td></tr>
<tr><td><b>Integrations and tools</b></td><td>MCP server, write access behind its own switch and off by default · OCR for scanned PDFs, readable while it runs · editable book source site list · metadata editing · in-app update check and install</td></tr>
</table>

---

## Supported platforms

| Platform | Support |
| --- | --- |
| **macOS** | macOS 12 or later, **Apple Silicon only**. Primary platform, most complete. |
| **Windows** | Windows 11 x64. Full local reading and all AI features, **without iCloud folder sync**. |
| Intel Mac · Linux | No packages currently provided. |
| iOS | In development, unreleased. See the [roadmap](docs/roadmap/mobile-ios.md). |

## Supported formats

| Format | Import | Reading controls | Selection & manual highlights | Automatic word marks |
| --- | --- | --- | --- | --- |
| **EPUB** | Native | Fonts, line height, margins, scroll / paginate | ✅ | ✅ |
| **TXT · Markdown · HTML** | Original kept, converted to an internal EPUB | Same as EPUB | ✅ | ✅ |
| **PDF** | Native | Theme, zoom, single / dual page, scroll / paginate | ✅ with a text layer | ❌ |
| **MOBI · AZW · AZW3 · FB2 · FBZ** | Foliate's native parsers | Where the renderer supports them | ❌ | ❌ |
| **CBZ** | Native | Theme only | ❌ | ❌ |

DRM is not supported, and perfect rendering of every publisher-specific file variant is not guaranteed.

---

## Where your data lives

- **Local-first.** Books, progress, word list, notes, user profile and statistics all live on this device.
- **API keys and OAuth tokens are stored only in the local credential database**, never returned to the UI layer and never synced.
- **For multiple devices**, pick a folder inside your own iCloud Drive in settings and choose the same one on each Mac.
- **AI requests send only the context the current task needs**; the whole book is never uploaded automatically. Everything that calls the AI unprompted is collected under Settings → Automatic Analysis, each item stating its scope, individually or collectively switchable off.
- **Frequency statistics, coverage and OCR all run locally**, offline.

## Download

Installers and release notes are on [Releases](https://github.com/KlaraGraff/lantern/releases). For the macOS package's signing status, follow the latest release notes; progress is tracked in [macOS distribution](docs/guide/macos-distribution.md).

## Development

Requirements: Node.js 22, npm, Rust, and the Tauri prerequisites for your platform. The reader engine (foliate-js) is vendored in the repository.

```bash
git clone https://github.com/KlaraGraff/lantern.git
cd lantern
npm ci
npm run tauri dev
```

```bash
npm exec tsc --noEmit && npm run lint && (cd src-tauri && cargo check)
```

Stack: Tauri 2 + Rust + SQLite, React 19 + TypeScript + Tailwind 4, foliate-js. Repository conventions are in [AGENTS.md](AGENTS.md).

## Credits and licence

Lantern is based on [Quill](https://github.com/yicheng47/quill) by yicheng47 and is an independently maintained personal version, not an official distribution of the original project. Copyright in the original Quill remains with its author; this repository retains the original [MIT License](LICENSE), including its copyright notice.
