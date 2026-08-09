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

You hit a sentence you don't get. Copy. Switch windows. Paste. Ask. The model doesn't know which book you're in, which chapter, what came before or after, or how good your English actually is — so it answers in the register of a native speaker. Then you switch back and hunt for your place again. And the answer floats free: if you want to check it against the text, you're on your own.

**Lantern is built the other way around.** It's a local-first desktop reader for macOS and Windows that runs on your own AI service. Instead of moving the book into a chat window one paragraph at a time, it **puts the AI inside the book** — so everything you'd otherwise have to explain every single time, it already knows.

Five things, concretely:

1. **It has the context.** Your English level, how far you've read, which book and chapter you're in, what surrounds your selection, and what it has learned about the kind of explanation you want — all of it rides along with every request.
2. **Every sentence it writes can be clicked back to the text.** Not a floating answer; an answer that takes you to the line in the book.
3. **What you've read, it tracks on its own.** Which words you no longer look up, which ones you tripped over again, how much of a given book you can already read — all of it grows out of the reading itself. No streaks to keep.
4. **What it says and how it says it, you write.** If the built-in modules don't fit, write your own prompt and build one.
5. **It doesn't even have to be it.** Through MCP, hand your library and word list to Claude Code or Codex and read with the AI you already use.

---

## 1 · It knows far more than a chat window does

A general chat window gets the few lines you pasted. Every Lantern request also carries the following — **without you saying so, and without you saying so again**:

| It knows | So |
| --- | --- |
| Your English level | Wording and sentence complexity move with it, instead of defaulting to native-speaker register |
| The kind of explanation you want | Summarised from your own look-ups and follow-ups; you can also just write it down |
| How far you've read | By default it won't answer using parts you haven't reached |
| Which book and chapter you're in | It recognises the names, places and prior events — no "this is from X" preamble |
| What surrounds your selection | It pins down what the word means *here* first, then expands — instead of listing dictionary senses for you to sort out |
| The whole book | Answers are retrieved from the text, not recalled from the model's memory of it |

### It knows your level

Most reading tools treat "explain in English" as a switch: flip it, get a paragraph of near-native English. For a B1 reader that paragraph is a second obstacle.

Lantern treats your English level as **a condition on every request**, not a preference sitting in a settings panel. Enter a CEFR level (A1–C2) directly, or an IELTS, TOEFL, TOEIC, Cambridge English, DET or CET-4/6 score and let the app convert it. Explanation language is a separate choice — Chinese, Chinese + English, or English only — with a recommendation that follows your level and a same-word, same-sentence preview for each option.

But "meeting you where you are" slides easily into being vague for the sake of being simple. So there's a hard rule: **if an explanation genuinely needs a word above your level, it keeps that word and glosses it on the spot** — a few simpler English words, or a short Chinese parenthetical. **It may not swap in something vaguer, and it may not leave it hanging for you to go look up.**

Beyond language difficulty there's a separate **explanation style** switch, governing how many points a card gives you: **Thorough** adds more — what it means here, how to recognise it, what it usually travels with, how it differs from near-synonyms; **Essentials** keeps only what you need right now. Settings can unfold a side-by-side comparison on the same word in the same sentence, so you can see the difference before choosing.

<!-- screenshot placeholder: learning preferences, plus the same word explained at two levels
![Explanations tuned to your level](assets/screenshots/level.png)
-->

### It knows what kind of explanation you want

Your level says what you can read. It says nothing about what you want. Two B2 readers: one wants etymology, the other finds it noise; one wants every example sentence drawn from the book in hand, the other doesn't care.

So there's a **user profile** page the AI reads before it answers. The top half **you write** — preferences, pet peeves, background, whatever you want to say. The bottom half is **summarised by the system** from your recent look-ups and follow-ups, across seven dimensions: sense explanation, syntax, reference resolution, cultural background, look-up disposition, source of examples, and answer pacing.

The boundaries are the point:

- **Every card opens onto its evidence** — which records led to that conclusion, laid out for you. Not an unverifiable verdict.
- **On conflict, what you wrote wins.** Disagree with a card and you can move it into the top half as your own wording; from then on that dimension is yours and the summariser leaves it alone.
- **The whole thing can be switched off.** The AI stops reading the page; what you wrote and the existing cards stay put and take effect again when you switch it back on.

<!-- screenshot placeholder: profile page — what you wrote, the seven-dimension cards, one opened onto its evidence
![It knows what kind of explanation you want](assets/screenshots/profile.png)
-->

### It knows how far you've read

**By default it won't answer using parts of the book you haven't reached yet.** Once you know what happens later, your thinking quietly bends toward it — and whatever you would have worked out yourself never gets the chance.

So reading-thought protection confines answers to what you've read, and marks the answer "answered up to your reading progress (first X%)". When you do want the full picture, one click re-asks against the whole book. The switch can be set per book, and the retrieval scope is yours: automatic, selection only, this chapter, or the whole book.

The same boundary extends to characters and terms. Hit a name you can't place, or an image that keeps recurring without being spelled out, and you can open a light card straight from the text: identity, aliases, known relationships, earlier appearances, and what the term means *in this book*. **The card also stops at where you are.** When you genuinely need the whole-book view, it says up front that this will include unread plot and asks you to confirm — and the confirmation applies to that one card only. Close it, and the next one starts spoiler-free again.

<!-- screenshot placeholder: AI sidebar context controls — scope picker, reading-thought protection, progress note under the answer
![It knows how far you've read](assets/screenshots/context.png)
-->

---

## 2 · Every sentence it writes clicks back to the text

Before starting a chapter, you can ask it to list the words and phrases you probably don't know. What you get is a long list — and **every entry carries a superscript that turns the book to the sentence that word is in**. Same when you ask about the plot halfway through: it doesn't just hand you an answer, it hands you the evidence, and each piece is clickable too.

This isn't "a reference list under the answer". The best product doing this is NotebookLM, but its citations land on a chunk of text in a side panel — **Lantern is the reader, so a citation lands on the actual page and the actual line**, with a flash at the landing point so you know where to look.

- **Citations are inline.** Superscripts in the body, a row of them at the end; both clickable. A vocabulary list citing thirty-odd places stays readable.
- **Location is found in the source text, not guessed from a page number.** For EPUB, the quoted fragment is searched precisely within its chapter; if that fails, a fallback fragment; if that fails, the chapter opening. PDF jumps to the page; plain text uses character offsets.
- **Citations cross books.** If a follow-up quotes a sentence from another book, clicking opens that book at that line, with a bar at the top — "jumped here from a question about X / back to X" — so you can always retrace.
- **Answers are retrieved from the book**, not recalled. A full-text index is built per book, and with an embedding service configured a semantic layer sits on top — which is why obscure titles, new releases and your own documents work just as well.
- **And all of it is bound by the previous section.** Citations never come from where you haven't read — which is exactly what makes "list the hard words before I read" possible: it scans the chapter you're about to read, not the whole book.

### Ask in Chinese, still find the passage that only ever says "Darcy"

There's an unglamorous but fatal gap in text retrieval: you ask about 达西, and the book says Darcy from beginning to end. Literal search returns nothing.

So while the index is being built, the AI also picks out the book's characters and folds translated names, short forms, nicknames and "that clergyman"-style references onto the form the book actually uses, stored as that book's own **person alias table**. The table can be edited, cleared and rebuilt by hand.

When one label points at more than one person, it doesn't guess silently: the answer says which reading it used, one click swaps it for the other, and the swap sticks for that book. **When it recognises nothing, it says so** — "couldn't tell who X is, searched the text literally" — and lets you identify them on the spot, effective immediately, undoable at any time.

### Come back days later and everything you saved is still attached to the book

Chat history is one ever-growing stream: the sentence you asked about three days ago sits between an expense policy and a recipe, unfindable, and even when found you can't remember where you were. Word lists have the same disease — the word lies alone in a list, cut off from the sentence it came from, and all that's left is rote memorisation.

In Lantern, what you save stays attached to the book. **Notes** (a bookmark is a kind of note — "remember this spot" is one), **Words** and **Q&A** are each grouped by book and searchable, and every entry carries a jump-back that lands not on the book's first page but on that line. A word card also keeps the passage it came from and what it meant **in that sentence** — not the dictionary's first sense; unfold "the full card for this word" to see the whole card as it was when you saved it.

**Trails are left without your help.** Words you looked up and passages the AI cited get a light mark in the text; when you read past one you can keep it or dismiss it. As a word becomes effortless, its mark fades on its own — attention withdraws from where it should withdraw (and if you dislike that, it can be pinned at one depth forever).

Select a passage and hit **Interpret** and the result no longer evaporates either. **Every interpretation is cached automatically**: select the same passage again in the same book and the result is instant, with no second API call. If it's worth keeping, press save and only then does it enter your Q&A record — caching saves money, the list is curated by you, and the two are kept apart. Forget to press it and you've lost nothing: re-select and it's still there.

Notes don't require leaving the text: the margin-notes panel puts each note beside the paragraph it refers to, so clicking a note keeps text and note in the same field of view. Conversations go further — **open the book and the conversation comes back into the sidebar with it**, so you pick up where you left off, superscripts still live.

So it isn't only that every sentence it writes clicks back to the text. **Everything you accumulate in Lantern grows on the book.**

<!-- screenshot placeholder: AI answer with a superscripted vocabulary list, and the passage a superscript jumps to
![Clickable citations](assets/screenshots/citations.png)
-->

---

## 3 · What you've read, it tracks on its own

The first two sections are about asking and answering. But in reading, the time you spend not asking dwarfs the time you spend asking.

Most vocabulary apps turn that time into a chore: notifications, red dots, streaks, N words left today. Lantern fixed three opposite rules — **no push notifications, no popups, no badge on the app icon** — and at most a **grey number** beside the sidebar entry. A grey number is information; a red dot is a demand, and that one step is the whole line. **Review is something you walk into, never something the system pushes at you.**

If it doesn't nag, what moves the words forward? The reading itself.

### Mastery isn't a box you tick, it's something you read your way into

A word appeared on a screen you read, and you didn't look it up — that's evidence you know it. Lantern records it, and enough of it promotes the word a rung: **New → Learning → Familiar → Effortless**.

The reverse holds too: a word that had climbed, looked up again, drops a rung; looked up repeatedly, another. **"Thought I had it, then looked it up again" isn't a failure — it's a truer signal than any quiz**, so it's used as one.

Five encounters in one chapter isn't five instances of remembering — massed repetition contributes little to long-term retention — so repeats within the same chapter **count on a decreasing scale**. But decreasing isn't zero: reading five times for no movement at all is openly discouraging.

Every word opens onto **"how it got here"** — which day, in which book, how many cross-day encounters without a look-up, what each review graded it. Disagree, and there's always **"I don't actually know this one"** on the card, which drops it back immediately. Mastery is stored **per word**, so a word met across several books shares one record.

<!-- screenshot placeholder: mastery timeline in the word detail, with "I don't actually know this one"
![Mastery you read your way into](assets/screenshots/mastery.png)
-->

### Review gives you piles with reasons, not a queue

Walk in when you feel like practising and you don't get an algorithm's queue — you get a few piles, each labelled with why it exists: **words you kept looking up in X** (more than once in the same book, so it's this book's obstacle), **thought you had it, then looked it up again** (promoted too early), **you looked these up in the chapter you just finished** (while it's fresh), and **words you haven't run into in a long time** (saved, but the book never brought them back — there's no story to tell, so they simply sit here).

When you do practise, the original sentence isn't thrown away. Lantern blanks the word out of its own sentence; the first hint is pronunciation, the second the Chinese sense you already saved, and only then the answer — no letter counts, no first-letter giveaways. Intervals are scheduled by the official FSRS library.

Finish a chapter and one **small line** appears at the end of the text: "you looked up N words in this chapter. While it's fresh, run through them →". One line. Permanently dismissible.

### How hard this book is *for you*, computed locally

"This book is B2" is something publishers print on the back cover, and it isn't accurate. Lantern splits it into two answerable questions, both computed on your machine — **no network, no AI quota**.

**How heavy the book is.** At import, every word in the text is mapped onto a 50,000-word frequency table, producing a band distribution — how much falls in the most common thousand, how much past rank five thousand. This has nothing to do with who's reading; it's a property of the book.

**How much of it you know.** This is the "for you" part: count the text against the words you already know — how many out of every hundred are covered. The result isn't an isolated percentage but a position on a ruler, with two reference lines at 95% and 98%, taken from two comprehension thresholds commonly used in applied linguistics (Nation, 2006), mapping onto "readable now with the dictionary open a lot / readable with frequent look-ups / you can read this one on your own". Unfold it for the book's token composition (effortless / familiar / names and places / not yet known) and for **"which words would help most"** — learn the handful appearing forty-plus times and coverage goes from X to Y, in one sentence.

Three self-imposed boundaries:

- **Thin records get an interval, not false precision.** Early on it says plainly that it can only give a range, and lists which books and how many records the range came from. If the range straddles a reference line, it would rather say it can't tell yet.
- **It never changes your level setting for you.** However strong the evidence, it prompts; it doesn't act.
- **Too short, or a format it can't extract text from, and it declines to conclude** rather than inventing a number.

Before you first open a book, this all converges into an **open card**: the book's vocabulary composition, roughly which chapters are heaviest, and about how long it will take at your recent pace. **It appears once, on first open**; afterwards it lives in the book's detail page. A scanned file gets a **"Download and recognise"** entry right here — OCR runs locally, uploads nothing, and you can start reading immediately; when it finishes, look-ups and AI become available on their own.

<!-- screenshot placeholder: "this book, measured against you" — coverage ruler + token composition + which words would help most
![This book, measured against you](assets/screenshots/coverage.png)
-->

### Everything that spends money on its own, on one screen

A few of the things above call the AI while you aren't looking, on your own quota. That's exactly the category that turns into an invisible bill, so Lantern collects all of them onto **one page called Automatic Analysis**, with nothing left out:

- Each item states **what it does, when it fires, and what data it sends** (e.g. "sends: book title, the words you looked up and their sentences").
- Beside each item: **how many times it ran in the last 30 days and roughly how many tokens** it used; at the top, the totals and "what percent of your own hands-on usage this amounts to".
- **Usage is the exact number the provider returned, never converted to money** — cache hits, off-peak rates and tiered pricing mean only the provider can price it correctly. The page links straight to that provider's usage dashboard.
- **Turning everything off costs you nothing:** each feature keeps a manual button on its own page, and there's a single "turn everything off" at the top.
- **Failures aren't silent:** no network, quota exhausted, no AI configured, model error — each leaves a pending card on the relevant page. The only thing that quietly doesn't happen is a switch you turned off yourself.

### Statistics as time returned to you, not supervision

Plenty of reading trackers end up as another attendance sheet: days in a row, minutes left today. Lantern records reading so that when you look back, you can see which books your time actually went to.

Three views behind one entry: **Reading history** answers "what did I read, how far, how long" by book; **Reading calendar** finds which books a given day held; **Learning** answers what happened to your vocabulary over the period. They share range and filters. No leaderboards, no streaks, no penalties. Five idle minutes pauses the clock, and sessions under 30 seconds are discarded — opening a book to check one line isn't a reading session.

When judging your actual level there's one more filter: a book's own topical vocabulary (rigging in a sea story, heat control in a cookbook) is excluded from the comparison, or a single book's preferences could skew the conclusion. That screening goes to the AI by default (sending only a few words and the title), and can be switched to local records only, fully offline.

A more human-sounding recap can be handed to the AI for phrasing, but **the facts are computed locally and deterministically by Lantern first; the AI only narrates. It may not recompute, and it may not invent data that isn't there.** Before the first generation it states the provider, what will be sent, and the rough cost; by default it sends recomputable structured facts and **never the text, highlighted passages, note bodies, or unread content**.

---

## 4 · The built-in modules are a starting point; the tool should be yours to build

What belongs on a word card? Contextual meaning, part of speech, common senses, collocations, roots and affixes, grammatical role, synonyms, usage, a memory aid, the source sentence — Lantern ships all of these: 11 modules for words, 8 for phrases, 9 for passages, each individually toggleable, reorderable, with its own default expansion state and content density.

**But a preset shouldn't dictate your method.** If the existing modules don't cover it, build one: name it, write **a prompt entirely your own** (up to 2,000 characters), have it generate from the current selection, its context and the book, then add it to word, phrase or passage cards, where it shows, hides, reorders and expands alongside the built-ins. Settings previews the card structure instantly; only when you want to see the real thing does it spend one actual AI call. Up to 8 custom modules per card type, plus 6 custom selection actions bound to shortcuts or a double-click.

So you can build **complex-sentence breakdown** for IELTS, **rhetoric and narrative perspective** for literature, **terminology and prerequisites** for technical books, **reusable phrasing** for your own writing, or a **minimal look-up** that keeps interruption to the absolute minimum.

<!-- screenshot placeholder: custom module editor (prompt input) + module ordering in card design settings
![Custom AI modules](assets/screenshots/modules.png)
-->

---

## 5 · Or swap in your own AI

Everything so far describes Lantern handing context to its own built-in AI. But why should that context be available only to it?

Lantern ships an **MCP server**. Turn it on and AI clients like Claude Code and Codex can read your reading data directly — **you copy and paste nothing**: books, collections, metadata and index state; your CEFR level and IELTS/TOEFL-style scores (**the same record the built-in AI uses**); word list, mastery states, statistics, look-up history, word-form marks; highlights, bookmarks, notes, in-book conversation history, and whole-book and per-chapter summaries.

29 tools in total: 12 read-only context queries, one "open in reader" action, and 16 write tools. Read-only by default; **write access (importing, deleting, creating collections) is a separate switch that ships off** — handing over your data and handing over control are two different things and shouldn't be bundled. Deleting data or an overwriting import asks again for that specific operation, and MCP never turns around and calls a model on your AI's behalf.

So you can ask, straight from a terminal: "given my English level, pick three books from my library I could actually finish", or "turn everything I marked Learning this month into a list with example sentences". It reads your real reading record, not the version you described to it from memory.

<!-- screenshot placeholder: MCP settings beside a Claude Code terminal answering from the real library
![Hand your library to Claude Code](assets/screenshots/mcp.png)
-->

---

## 6 · Everything is adjustable, and the defaults already thought it through

Explanation register, retrieval scope, card modules, mark colours and shapes, shortcuts, speech source, what a triple-click selects, what pops up on selection — **almost nothing in Lantern is hard-coded.** But "everything is adjustable" that means "you must finish adjusting before you can use it" is just handing you the work. So every setting has a default, and the defaults were thought about. Three examples:

**Defaults tell you the cost.** Bold and font-swap are off in mark styling — they change glyph widths, and in paginated mode a single mark reflows the page. Colour, background and underline move no text. Turn them on if you want them, but know the cost first.

**Defaults stop you once.** The app draws on the text too: the speech position is a cool blue wash, and New / Learning / Effortless are three grades of underline running from warm orange to teal to a grey dash — a deliberate gradient of attention withdrawing. If the colour you pick sits too close to one of them, settings says so on the spot — "may be indistinguishable in the text" — and names which one it collides with. That judgement blends both colours **against the actual paper background** before measuring distance, rather than comparing hex values: a wash and an underline can look far apart on a swatch and merge on the page.

**Defaults operate on words, not character strings.** You looked up `run`; later `ran` / `running` / `runs` match nothing by string, though to a reader they were always the same word. So "when marking a word" has three settings: this position only / same spelling book-wide / **all forms of the same word**. Forms don't have to be typed in — one click has the AI generate them, or fill in the whole library in batch (concurrent batches, retry on failure, cancellable at any point). Generated forms remain editable, and an edited set is recorded as yours and won't be overwritten by later batch runs.

Typography follows the same logic, and **defaults follow the publisher's intent**: Latin and CJK fonts are set separately, so English uses an English face and Chinese a Chinese one, neither compromising for the other; first-line indent and paragraph spacing are mutually exclusive — turn on indent and paragraph spacing is flattened (block quotes and empty paragraphs excepted), because running two paragraph-separation signals at once is redundant typesetting. There's a global default, and any book may keep its own exception; the settings panel says explicitly when you're looking at a per-book override, and lets you revert to global, promote this book's setting to the new global, or apply it to a few more books — without stacking another modal on top just to manage scope.

---

## Up and running in three minutes

1. **Install** — grab the package for your platform from [Releases](https://github.com/KlaraGraff/lantern/releases).
2. **Add an AI service** — Settings → AI Configuration. OpenAI-compatible API, Anthropic, Ollama, or your own gateway. Test the connection. The key stays on this device.
3. **Drop in a book** — drag an EPUB / PDF / TXT into the library, open it, and **double-click any word**.

To make it fit you: Settings → Learning Preferences for your English level and explanation language, Settings → Personal for a couple of lines you want the AI to know upfront, Settings → Lookup & Cards for the modules you actually want to see.

---

## Full feature list

<table>
<tr><td width="150"><b>AI comprehension</b></td><td>

Contextual look-up · phrase definitions · passage interpretation · full-passage translation · continuous in-book conversation · **every answer carries clickable source citations; example sentences are links too, landing on that line in the book** · citations jump across books and back again · full-text retrieval with an optional semantic layer when embeddings are configured · answer scope: automatic / selection / chapter / whole book · **reading-thought protection**: answers use only what you've read, with one-click re-ask against the whole book · **person alias table**: Chinese names, short forms and nicknames all find passages that only use the English name; ambiguous references state which reading was used and can be swapped on the spot · character / term cards covering identity, relationships, in-book meaning and earlier appearances, likewise capped at your position · shows exactly which source text went into this request, removable at any time · **Q&A archived per book and searchable**, one click back to the text; interpretations are cached, so re-selecting the same passage costs nothing

</td></tr>
<tr><td><b>It knows you</b></td><td>

**User profile**: top half written by you, bottom half summarised by the system from your look-ups and follow-ups into seven dimensions (sense explanation / syntax / reference resolution / cultural background / look-up disposition / source of examples / answer pacing) · every card opens onto the raw records behind it · disagree and move it into the top half, taking that dimension over · on conflict what you wrote wins · switchable off entirely, contents preserved · learner level (CEFR, or converted from IELTS / TOEFL / TOEIC / Cambridge / DET / CET) · explanation language: Chinese / Chinese + English / English only, each with a preview · **explanation style: Thorough / Essentials**, with a side-by-side comparison on the same sentence

</td></tr>
<tr><td><b>Learning loop</b></td><td>

Word list · look-up history · **four mastery rungs (New / Learning / Familiar / Effortless), promoted by reading past a word and demoted by looking it up again** · per-word "how it got here" timeline, with "I don't actually know this one" always available · mastery stored per word and shared across books · word cards can be regenerated whole, or unfold the full card as saved · **review grouped by reason** (kept looking these up in this book / thought you had it / looked these up in the chapter you just finished / haven't seen in a long time), not an algorithmic queue · official FSRS spaced repetition · cloze review in the original sentence, hinting pronunciation → your saved sense → answer · one-line end-of-chapter prompt, expandable and dismissible · notes centre and margin-notes panel (bookmarks folded into notes) · CSV / JSON vocabulary import and export · highlights, words and annotations export to Markdown / CSV / Anki CSV

</td></tr>
<tr><td><b>This book vs. you</b></td><td>

Whole-book frequency computed locally at import and mapped onto the bands of a 50,000-word table · **coverage: count the text against words you already know, placed on a ruler with reference lines at 95% and 98% (Nation, 2006)** · unfold for token composition (effortless / familiar / names and places / not yet known) and "which words would help most" · thin records give an interval and list their basis; straddling a reference line, it says it can't tell · options for whether "familiar" counts as known and whether to show the percentage on shelf cards · **open card**: before you first open a book, its vocabulary composition, its heaviest chapters, and roughly how long it will take at your pace — shown once · level comparison excludes the book's own topical vocabulary · **offline, no AI quota, and it never changes your level setting** · too short or an unextractable format and it declines to conclude

</td></tr>
<tr><td><b>Marks in the text</b></td><td>

**Words you looked up and passages the AI cited are marked automatically**; keep or dismiss as you read past, and marks fade as words become effortless (can be disabled) · three match scopes: this position / same spelling book-wide / **all forms of the same word** (AI-generated on demand or in batch, hand-editable) · saved words can show a gloss above the word or in the margin without another AI call · manual highlights · independent styling for manual and automatic marks, each with colour, opacity, highlight / underline / bold and font · warns on the spot when a colour collides with a system mark · never modifies the original file

</td></tr>
<tr><td><b>Reading experience</b></td><td>

Warm paper themes and custom background colours · dark mode follows the in-app choice, not the OS · **separate Latin and CJK fonts** · custom font import and a device-local enhanced font pack · size, line height, letter and word spacing, margins, justification, language-aware hyphenation · **first-line indent and paragraph spacing are mutually exclusive, defaulting to the publisher's intent** · global defaults with per-book overrides, revertible or promotable · scrolled and paginated modes · table of contents · reading progress · margin-notes panel · multiple windows for multiple books, cascaded rather than stacked · collections for organising the library · book title and author read from the EPUB at import · mark as finished in place

</td></tr>
<tr><td><b>Speech</b></td><td>

Four sources: dictionary human recordings / system voices / Edge neural voices / your own OpenAI-compatible TTS · source chosen automatically by content length and language · continuous playback bar: previous / next / pause / stop / rate · flows across paragraphs, pages and chapters · sentence-level follow highlighting · resumes where it stopped

</td></tr>
<tr><td><b>Reading review</b></td><td>

Reading history / reading calendar / learning, three views · filter by range and book · 5-minute idle pause, sub-30-second sessions discarded · locally recomputable duration, sessions, books and reading days · optional AI recap that only narrates locally computed facts — generated on demand, with visible scope and locally cached results

</td></tr>
<tr><td><b>Quota and automation</b></td><td>

**One page listing every task that calls the AI while you aren't looking**, each with its trigger, the data it sends, and its 30-day call count and token usage · totals and "turn everything off" at the top · usage taken verbatim from the provider, never converted to money, with a link to the provider's usage page · each feature keeps its manual button when switched off · failures leave a pending card rather than being skipped silently

</td></tr>
<tr><td><b>AI services and indexing</b></td><td>

OpenAI-compatible APIs · Anthropic · Ollama · optional OpenAI OAuth · multiple services with priority ordering · multiple keys per service, tried in priority order before output begins · connection tests and model discovery · **batch-index the whole library**, pausable and resumable · per-book indexing runs in five phases (chunking / sentence locations / embeddings / chapter summaries / person names) with per-phase retry, plus re-chunk and rewrite-chapter-summaries

</td></tr>
<tr><td><b>Integrations and tools</b></td><td>

MCP server — opens the library, word list and notes to Claude Code, Codex and other AI clients, with write access behind its own switch, off by default · OCR for scanned PDFs, readable while it runs · editable list of book source sites · book metadata editing · in-app update check and install

</td></tr>
</table>

---

## Supported platforms

| Platform | Support |
| --- | --- |
| **macOS** | macOS 12 Monterey or later, **Apple Silicon only**. Primary platform, most complete. |
| **Windows** | Windows 11 x64 installer. Full local reading and all AI features, **without iCloud folder sync**. |
| Intel Mac · Linux | No packages currently provided. |
| iOS | In development, unreleased. See the [roadmap](docs/roadmap/mobile-ios.md). |

## Supported formats

| Format | Import | Reading controls | Selection & manual highlights | Automatic word marks |
| --- | --- | --- | --- | --- |
| **EPUB** | Native | Fonts, line height, margins, scroll / paginate | ✅ | ✅ |
| **TXT · Markdown · HTML** | Original kept, converted to a stable internal EPUB | Same as EPUB | ✅ | ✅ |
| **PDF** | Native | Theme, zoom, single / dual page, scroll / paginate | ✅ with a usable text layer | ❌ |
| **MOBI · AZW · AZW3 · FB2 · FBZ** | Foliate's native parsers | Flow controls where the renderer supports them | ❌ | ❌ |
| **CBZ** | Native | Theme only | ❌ | ❌ |

DRM is not supported, and perfect rendering of every publisher-specific file variant is not guaranteed.

---

## Where your data lives

- **Library data is local-first.** Books, reading progress, word list, notes, user profile and reading statistics all live on this device.
- **API keys and OAuth tokens are stored only in the local credential database**, never returned to the UI layer and never synced.
- **For multiple devices**, pick a folder inside your own iCloud Drive in settings and choose the same one on each Mac. The app puts its event log, books and covers there.
- **AI requests send only the context the current task needs** by default; the whole book is never uploaded automatically. Everything that calls the AI unprompted is collected under Settings → Automatic Analysis, each item stating its scope, individually or collectively switchable off.
- **Frequency statistics, coverage and OCR all run locally**, offline.

## Download

Installers and release notes are published on [Releases](https://github.com/KlaraGraff/lantern/releases). For the macOS package's signing status and installation steps, follow the latest release notes; progress is tracked in [macOS distribution](docs/guide/macos-distribution.md).

## Development

Requirements: Node.js 22, npm, Rust, and the Tauri prerequisites for your platform. The reader engine (foliate-js) is vendored in the repository.

```bash
git clone https://github.com/KlaraGraff/lantern.git
cd lantern
npm ci
npm run tauri dev
```

Common static checks:

```bash
npm exec tsc --noEmit
npm run lint
cd src-tauri && cargo check
```

Stack: Tauri 2 + Rust + SQLite (backend), React 19 + TypeScript + Tailwind 4 (frontend), foliate-js (EPUB rendering). Repository conventions are in [AGENTS.md](AGENTS.md).

## Credits and licence

Lantern is based on [Quill](https://github.com/yicheng47/quill) by yicheng47 and is an independently maintained personal version, not an official distribution of the original project. Copyright in the original Quill remains with its author; this repository retains the original [MIT License](LICENSE), including its copyright notice.
