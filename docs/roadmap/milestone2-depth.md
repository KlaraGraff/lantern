# Milestone 2 — Depth

Deepen the reading experience. Make the assistant feel like a persistent study companion, not a stateless chatbot.

---

## Features

### Chat persistence
Save and restore AI chats per book. Multiple chat threads per book, each message retains the highlighted passage that triggered it.

- **Status:** Complete

### Auto-update & migration
This line bundled two jobs and was marked Complete on the strength of one of them. Split, as of 2026-08-03:

- **DB migration — Complete.** The version-tracked migration system is in `db.rs`, 31 migrations deep, and has carried schema changes across every release.
- **In-app auto-update — Not started, deferred.** There is no `tauri-plugin-updater` in `Cargo.toml` or `package.json`, no `UpdateToast`, no update checker. The `hasUpdater` capability flag in `services/platform.ts` says as much in its own doc comment. Every update is a manual download today. [`impls/q243-update-experience.md`](../impls/q243-update-experience.md) is the plan, but it was written against Quill's existing update UI and has to be rebased onto "build it from nothing" before anyone starts.

- **Issue:** [#45](https://github.com/yicheng47/quill/issues/45)

### Internationalization (i18n)
Externalize all UI strings, add language switcher (English / 简体中文), adapt AI responses to the user's preferred language.

- **Status:** Complete
- **Issue:** [#44](https://github.com/yicheng47/quill/issues/44)

### AI Translation
Passage-level translation and bilingual reading mode for reading foreign-language books. Passage translation via context menu streams ephemerally with copy from the popover. Bilingual mode injects translations inline below each paragraph in the reader; any future cache should be scoped to that mode rather than saved translation history.

- **Status:** Complete
- **Issue:** [#73](https://github.com/yicheng47/quill/issues/73)

### Notes (AI-Assisted)
Rich note-taking tied to books — capture thoughts, annotations, and reflections beyond simple highlights. AI serves as a writing assistant (grammar, flow, expansion) and can respond to notes in a conversational thread, creating a dialogue anchored to the user's reflection rather than a standalone Q&A.

- **Status:** Planned
- **Issue:** [#70](https://github.com/yicheng47/quill/issues/70)
- **Spec:** [q14 — Notes](../features/q14-notes.md)

### Onboarding
Simple first-launch flow guiding new users to set up their AI provider in Settings.

- **Status:** Planned

### Region screenshot for AI
Capture a selected region of the page (screenshot crop) and send it to the AI assistant as an image. Useful for magazines and image-heavy PDFs where text selection is unreliable and photos/diagrams can't be copied. The user draws a rectangle over the reader area, the captured image is attached to the AI chat as context.

- **Status:** Planned

### User profile in sidebar + Settings modal
Move settings access to a bottom-left user avatar section (name + initials). Replaces the current settings gear, prepares the local user identity for Milestone 3 persona engine integration. Settings become a ChatGPT-style modal dialog instead of a full page.

- **Status:** Complete
- **Issue:** [#59](https://github.com/yicheng47/quill/issues/59)
