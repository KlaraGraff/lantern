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
| `design/quill-desktop.pen` | Pencil design source — keep UI aligned with it when a node is referenced |
| `docs/features/` · `impls/` · `guide/` · `roadmap/` · `arch/` | Specs, implementation plans, guides, milestones, architecture; shipped items move to each dir's `archive/` |

## Working Copy

- Canonical clone: `~/vibecoding/Lantern`. Other clones on this machine are stale — if running elsewhere, say so and stop.
- Start every session with `git fetch origin && git status`; another agent may have moved `main`.
- Working-tree changes you did not make are another agent's in-flight work: inspect and preserve them; never revert, stash, or commit them as your own.

## Commands

| Task | Command |
| --- | --- |
| Install · frontend dev · app dev | `npm ci` · `npm run dev` · `npm run tauri dev` |
| Frontend checks | `npx tsc --noEmit` · `npm run lint` · `npm run test:unit` |
| Rust checks | `cd src-tauri && cargo check` / `cargo test` / `cargo clippy -- -D warnings` |
| Build · package | `npm run build` · `npm run package` |

Run the smallest check that covers the change: typecheck + lint for frontend, the relevant `cargo test` target for Rust, sync-focused tests first for sync changes.

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
- Verify the released artifact, not just CI: download the asset, check size and About commit against the tag, and on macOS run `spctl -a -vv`. Ad-hoc-signed builds (current default) trip Gatekeeper on quarantined downloads — see `docs/impls/macos-distribution-gatekeeper-fix.md`; release notes must document the `xattr` workaround.
