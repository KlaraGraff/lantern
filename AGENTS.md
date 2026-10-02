# Lantern Agent Guide

Repo-wide guide for every coding assistant (Claude Code, Codex, others). Shared conventions live here; tool-specific files (`CLAUDE.md` etc.) are compatibility entrypoints that point back to this file. Portable workflow skills live under `.agents/skills`.

## Product

Lantern is an AI-powered desktop ebook reader: EPUB/PDF reading, a local library, and AI lookup, translation, vocabulary, highlights, bookmarks, collections, and cross-device sync.

| Term | Meaning |
| --- | --- |
| Book | Library item backed by an EPUB or PDF file |
| Reader | Reading surface: progress, layout, highlights, bookmarks, AI panels |
| Library | Local SQLite materialized view + book/cover blobs under the active data directory |
| Sync | iCloud event-log sync: append-only logs, snapshots, watcher-driven replay |
| MCP | Local MCP server/client surface letting AI tools inspect or modify the library |

## Stack & Layout

Frontend: React 19, TypeScript, Tailwind CSS 4, Vite, React Router. Backend: Tauri 2, Rust, SQLite (`rusqlite`). Reader engine: `foliate-js` (`public/foliate-js/`). AI: OpenAI-compatible providers plus OAuth-backed OpenAI.

| Path | Contents |
| --- | --- |
| `src/pages/` · `components/` · `hooks/` · `i18n/` | Screens; shared UI incl. `settings/` sections and `ui/` primitives; data hooks; translation JSON |
| `src-tauri/src/commands/` · `sync/` · `mcp/` · `ai/` | Tauri commands; iCloud sync engine; MCP server; AI providers |
| `design/lantern-desktop.pen` | Pencil design source — keep UI aligned with it when a node is referenced |
| `docs/features/` · `impls/` · `guide/` · `roadmap/` · `arch/` | Specs, implementation plans, guides, milestones, architecture; shipped items move to each dir's `archive/`, then `npm run check:docs -- --fix` repoints the links the move broke |

## Working Copy

- Canonical clone: `~/vibecoding/Lantern`. Other clones on this machine are stale — if running elsewhere, say so and stop.
- Start every session with `git fetch origin && git status`; another agent may have moved `main`.
- Working-tree changes you did not make are another agent's in-flight work: inspect and preserve them; never revert, stash, or commit them as your own.
- **Unrelated-change triage:** do not stop at a dirty worktree. First list each changed or untracked path, summarize its diff and overlap with the task, then recommend the safer path: continue with only owned files, use an isolated worktree for a release, or pause only when the changes make correctness impossible to establish. State that recommendation before asking for input. For release work, never include unowned changes; when a clean build is required, prefer an isolated worktree over asking the user to clean or classify another agent's work.
- **Shared-worktree commit discipline** (multiple sessions run concurrently in this one clone; user directive 2026-08-07):
  1. Never `git add .`, `git add -A`, `git add -u`, or `git commit -a`. Stage only explicit file paths you actually changed this round.
  2. Run `git status --short` before every commit. Files you didn't touch are another session's in-flight work — leave them alone: no stash, no checkout, no restore. They are uncommitted on purpose, pending human review.
  3. `src/i18n/zh.json` and `src/i18n/en.json` are the highest-risk files — several sessions add keys to them at once. Edit them only with targeted in-place replacements (never rewrite the whole file), and before committing run `git diff --cached src/i18n/` to confirm every staged key is yours; `git restore --staged` anything that isn't. (Staging these files whole has twice swept a concurrent session's keys into an unrelated commit.)

## Subagent Dispatch

- Explicitly set both model and reasoning effort for every subagent; do not inherit the parent session's settings by default.
- Use the following task-based defaults and minimums. Do not use `gpt-6-luna` for delegated work.

| Task | Model | Reasoning effort |
| --- | --- | --- |
| Read-only code search, call-chain summaries, information gathering, existing test execution | `gpt-6.1-sol` minimum | `low` minimum |
| Implementation, bug fixes, refactoring, optimization, test changes | `gpt-6.1-sol` minimum | `medium` minimum |
| Review, design, tradeoff analysis, complex diagnosis or high-risk implementation | `gpt-6-astra` | `high` minimum |

- Escalate an individual task when needed instead of assigning every subagent the most expensive configuration. Keep cross-source synthesis and final judgment in the main conversation.
- Subagents must not stage, commit, push, or publish. The main agent reviews their changes and validation results, requests follow-up work as needed, and handles focused commits under this guide.

## Commands

| Task | Command |
| --- | --- |
| Install · frontend dev · app dev | `npm ci` · `npm run dev` · `npm run tauri dev` |
| Frontend checks | `npx tsc --noEmit` · `npm run lint` · `npm run test:unit` |
| Rust checks | `cd src-tauri && cargo check` / `cargo test` / `cargo clippy -- -D warnings` |
| Build · package | `npm run build` · `npm run package` |

Run the smallest check that covers the change: typecheck + lint for frontend, the relevant `cargo test` target for Rust, sync-focused tests first for sync changes.

**iOS runtime checks.** `tauri ios dev` embeds the frontend into the Rust binary at compile time, so a cached `lantern` crate ships the *old* bundle no matter how many times the app reinstalls — the app runs, opens books, and logs normally, just from stale code. After changing frontend code, run `cd src-tauri && cargo clean -p lantern` before rebuilding, and confirm what actually shipped with `strings -a <installed>/Lantern.app/Lantern | grep -o 'index-[A-Za-z0-9_-]*\.js'` — it must match the hash in `dist/assets/`. Logs live in the simulator's `Library/Logs/com.klaragraff.lantern-dev/lantern.log`, which is **shared across reinstalls**: always read only past the last `lantern start` marker.

## Restraint

**Write the minimum code that works. Before coding, ask: would a senior engineer call this overcomplicated?** (Adapted from [ponytail-lite](https://github.com/ilindaniel/ponytail-lite).)

Understand the problem first — read the task and the code it touches, trace the real flow end to end — then climb this ladder and stop at the first rung that holds: not needed at all (YAGNI) → already in the codebase → standard library → native platform feature → an installed dependency → one line → only then the minimum working implementation.

- No unrequested abstractions, no avoidable dependencies, no speculative scaffolding.
- Prefer deletion over addition; boring over clever; fewest files; shortest working diff once the problem is understood.
- Bug fix = root cause, not symptom. Grep all callers before editing shared code; fix once where all callers route through.
- For complex asks, deliver the lean version and say what you skipped in the same reply; if the user insists on the full version, build it without re-arguing.
- **Never cut** validation, error handling, security, accessibility, data-loss protection, or real edge cases — and never ship a diff you don't understand.

## Engineering Conventions

- Follow existing local patterns; keep changes scoped to the request; no unrelated refactors.
- Use structured APIs and parsers over ad hoc string manipulation. Comments: rare, intent-only.
- Keep `src/i18n/en.json` and `zh.json` in sync; never hardcode user-facing strings.
- Use `ROW_CONTROL_WIDTH` / `ROW_CONTROL_WIDTH_COMPACT` for settings row controls, not local width literals.
- Sync and file-copy changes are data-safety sensitive: never repoint storage or disable sync until required local files are actually reachable.
- **Never reach into `public/foliate-js/` with `import()`.** Vite copies `/public` verbatim and never runs it through a plugin, but a dynamic `import()` of a variable specifier gets rewritten to `xxx.js?import`, which bypasses the static-file middleware and 404s in dev. The CSP is `script-src 'self'`, so inline scripts, `eval`, `new Function` and `blob:` URLs are all unavailable as workarounds. The one path that satisfies both is a same-origin `<script type="module" src>`: `public/foliate-js/lantern-modules.js` is the bridge that imports those modules by literal path and hangs them on `globalThis.__lanternFoliateModules`, and `src/pages/reader/foliate-modules.ts` loads it. To use another module from there, add it to the bridge's import list. (This shipped as a book-opening outage once; `epubcfi.js` had been failing silently the whole time because `highlight-ranges.ts` swallowed the error.) Related principle worth keeping: a garnish feature must never be able to stop a book from opening — footnote-module load failure now logs a diagnostic and moves on.
- **Testing-stage compatibility:** no compatibility, migration, or rollback code for old versions, old data, or historical schemas — re-import or reset local test data instead. Exception only on explicit user request. The policy expires once the user declares large-scale distribution; from then on assess compatibility, migration, and rollback by data safety and upgrade experience.
- **Implementation judgment:** optimize for the goal, not the literally proposed path. Present alternatives with their key tradeoffs even when the difference is small — the user wants to learn from the discussion. Prefer the materially better option unless the user pinned the path.

## Response Style

- Conclusion first, minimum sufficient information. Compact Markdown tables for multiple rules or comparisons: short headers, one point per cell.
- Design alignment: conclusion, key rules, exceptions, next step only. Simple questions: direct prose, no forced tables.
- Bold marks conclusions, conditions, and thresholds.
- Default budget: one conclusion paragraph plus one table. Exceed it only for boundary conditions, risks, and open questions — or solution-tradeoff discussions, which are exempt from the budget.
- No repeated background, restated points, or self-evident reasoning.

## Commits & Releases

- **Commit straight to `main`.** Single-maintainer repo, no branch protection: run the covering checks, commit, push. Open a PR only when CI must gate a risky change or the user asks; if opened, carry it to done in the same turn (wait for CI, merge when green, delete the branch). Don't end a turn on "should I push?" — push unless a check failed, the diff outgrew the ask, or the change is irreversible.
- Focused commits, imperative subject, scoped like `fix(sync): keep status reads off the webview thread`. Scopes: `sync`, `commands`, `reader`, `library`, `settings`, `ai`, `mcp`, `ui`, `docs`, `release`. No tool-specific co-author trailers unless asked.
- **Never reuse a published version number.** Once a tag's artifacts were downloadable the number is burned — bump patch even to replace a broken release. (Identically named artifacts with different contents cost a full debugging round on 2026-07-17.)
- Identify builds by commit via Settings → About (`app_build_info` command), not by filename.
- Confirm release completeness from its asset metadata (`gh release view --json assets`): every expected asset present, each name carrying the version, no size implausible for its kind. **Do not download release packages for verification.** Asset metadata proves completeness, not signing or notarization. For the same tag/commit, inspect the actual macOS build branch, signature-verification result, and (for Developer ID builds) Apple notarization acceptance and stapling logs. The workflow chooses Developer ID only when certificate import and identity detection succeed on a non-prerelease tag; prereleases and unavailable identities route to ad-hoc, but neither branch guarantees a successful build. Never infer signing success from configured secrets or a previous version. When runtime or Gatekeeper evidence is needed, verify an already-built local artifact (`codesign`, `spctl`, `stapler`, About commit) and report its provenance and the limit of that evidence; it does not prove the downloaded package's behavior. Ad-hoc release notes must disclose the lack of notarization and the targeted `xattr -dr com.apple.quarantine /Applications/Lantern.app` workaround. Never use that workaround to pass a failed Developer ID verification. See `docs/guide/macos-distribution.md`.
- **Release notes ship in both languages**, Simplified Chinese and English, semantically equivalent. The `release` skill holds the required anchors and per-language sections; follow it there rather than restating the format here.
