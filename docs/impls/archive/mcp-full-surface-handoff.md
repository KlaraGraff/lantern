# MCP Full-Surface Redesign Handoff

> **Archived — superseded, and wrong in one place.** This is the handoff from
> the paused 67-tool "full parity" round. That premise was rejected: it
> contradicted README section four, which promises context sharing, not an
> external control surface. What shipped is the 29-tool catalog in
> [`mcp-full-product-parity.md`](../../features/mcp-full-product-parity.md),
> designed in [`mcp-scope-goal.md`](mcp-scope-goal.md).
>
> The claim below that "no work from this redesign has been committed" is
> false. The branch was four commits and roughly 6,700 lines ahead of `main`
> when this was written. Kept for the reasoning trail only.

**Handoff date:** 2026-08-03  
**Status:** Paused by the user. The next owner should continue from this document; the current owner must not continue implementation.  
**Canonical clone:** `/Users/lijianwei/vibecoding/Lantern`  
**Isolated worktree:** `/Users/lijianwei/vibecoding/Lantern-mcp-full-surface`  
**Branch:** `codex/mcp-full-surface-audit`  
**Base HEAD:** `2bb61200242e4c00728ed2cf587a9d6566f723ad`

## User-aligned product decisions

These decisions are settled unless the user explicitly reopens them.

1. MCP should expose every shipped, user-visible Lantern capability by default. Do not add `enable_toolset`, hidden domains, a generic executor, or any other server-side unlock ritual.
2. Full availability does not mean one tool per UI control, Tauri command, or backend endpoint. Tools represent recognizable user goals. Tool count is an output of product design and selection evaluation, never a target.
3. Do not teach users workflows through tool descriptions. Descriptions should state the object, effect, scope, result, and constraints without telling the user how to work.
4. Ask for confirmation only when the resolved action:
   - may incur API charges or has unknown cost; or
   - is dangerous and irreversible, such as permanently deleting or destructively overwriting user data.
5. Reads, ordinary writes, known local/free processing, reproducible-cache removal, and reversible configuration changes should execute without confirmation.
6. Different risk classes must remain distinguishable. A free local lookup must not inherit a paid confirmation because it shares a tool with an AI lookup; ordinary updates must not inherit permanent-delete confirmation.
7. All capabilities remain discoverable. A capable client may progressively present only the relevant tool definitions for the current task, but this must not require a user to enable a domain or make any capability unavailable.
8. The user requested delegated execution: split remaining work by difficulty and use only GPT-5.6-series Sub-agents.

## Catalog conclusion

The current product document describes a **67-tool candidate**, not a final catalog: [mcp-full-product-parity.md](../../features/mcp-full-product-parity.md).

- The existing implemented server exposes 38 tools.
- It shares 34 names with the 67-tool candidate.
- Four existing public entries are stale product shapes and should be reconsidered after the catalog is frozen:
  - `get_book_summaries`
  - `request_book_index`
  - `preview_vocabulary_import`
  - `save_language_assessment`
- Do not accept or reject 67 based on the number alone. The final total must follow blind real-task selection evidence.
- Do not cap the total catalog at 20. OpenAI's current guidance treats roughly 20 as a soft limit for tools initially presented to the model, not a limit on all discoverable product capabilities.

The main unresolved granularity hotspots are:

| Candidate area | Product question to resolve through evaluation |
| --- | --- |
| `generate_ai_material` | Vocabulary glosses, prompt optimization, and chat-title generation have different user outcomes even though all use AI. |
| `control_reader` vs `control_app` | Opening/focusing a reader and navigating the app overlap; each natural request needs one obvious first choice. |
| Dictionary vs AI reading vs book chat | Similar phrases such as "explain this" must still distinguish local/free lookup, paid contextual AI, and grounded conversation. |
| Local vs generated book intelligence | Rebuilding local data, manually editing summaries, and paid regeneration need clear intent and confirmation boundaries. |
| Broad state/settings tools | Reader state, speech state, AI-task state, general settings, fonts, and book sources should not compete for the same request. |
| `control_sync` | Sync now, cancel, relocate, and compact may be one domain but do not necessarily produce the same outcome. |

If a paid generation also destructively overwrites user-edited data, show one combined confirmation that names both consequences rather than two vague prompts.

## Research already completed

There is no universal MCP product-design style guide and no official maximum tool count. The useful guidance is consistent on two points: do not mirror APIs one-to-one, and do not load a large irrelevant decision set into the model at once.

Primary references:

- [MCP client best practices](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2025-11-25/develop/clients/client-best-practices.mdx): full discovery and progressive presentation are separate concerns.
- [OpenAI function-calling guidance](https://developers.openai.com/api/docs/guides/function-calling#tool-search): evaluate selection quality, keep the initially available set small, and use tool search for larger ecosystems.
- [OpenAI MCP guide](https://developers.openai.com/cookbook/examples/mcp/mcp_tool_guide#best-practices-when-building-with-mcp): large definitions increase context, latency, and decision pressure.
- [AWS MCP design guidelines](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md): clear action-oriented names and explicit schemas.
- [EMBL-EBI MCP guidelines](https://github.com/EMBL-EBI-ABC/ebi-mcp-guidelines/blob/main/GUIDELINES.md): do not mirror REST routes; prefer task-shaped tools, while acknowledging that generic query tools remain an open design debate.
- [MCP grouping experiment](https://github.com/modelcontextprotocol/experimental-ext-grouping): unfinished and not a stable basis for Lantern's product design.

The source checkouts used during research are currently under `/tmp/lantern-mcp-style-Rabr41` and `/tmp/lantern-mcp-guidance.W6G5ga`. They are temporary and should not be treated as durable project artifacts.

Observed mature catalogs vary substantially: the MCP filesystem reference server exposes 14 tools, Notion about 24, Playwright 24 by default and about 69 with all capabilities, and GitHub defines more than 100. These examples reinforce that count alone is not a quality measure.

## Selection corpus

Two untracked files contain the prepared benchmark:

- [mcp-tool-selection-corpus.json](mcp-tool-selection-corpus.json)
- [mcp-tool-selection-benchmark.md](mcp-tool-selection-benchmark.md)

Current corpus state:

- 87 unique Chinese/English cases.
- Covers all 67 candidate tools and all 15 product domains.
- Includes direct, indirect, multi-step, unsupported-platform, no-tool, paid/free, ordinary/permanent, and conditional-overwrite cases.
- The top-level observed `domain` values total 17 because `cross_domain` and `negative` are benchmark categories in addition to the 15 product domains.
- JSON and coverage validation passed when created, but no blind evaluator has run against it yet.

The next owner should give blind evaluators only the catalog/tool definitions plus each case's prompt fields. Do not reveal expected tools, paths, confirmation classes, rationales, or tags. Record first tool, full path, arguments, completion, confirmation behavior, unnecessary calls, schema failures, latency, and confusion clusters.

At least two independent GPT-5.6-series evaluators should run before freezing the catalog. Repeated confusion is evidence for a split or merge; one anecdotal miss is not.

## Backend control bridge in progress

The untracked `src-tauri/src/mcp/control.rs` was a backend foundation for MCP control of live app and reader windows. It was **not feature complete**, and it was discarded: the shipped `open_in_reader` reuses the existing `.mcp-notify` sentinel in 52 lines instead. The 1,059-line original survives on branch `codex/mcp-control-bridge-wip` at commit `3e99e3c`.

Implemented in the current working tree:

- Main-window and reader-window runtime sessions.
- Hashed session tokens and heartbeats.
- Stale-session rejection.
- Compile-time action allowlists.
- Pending, claimed, completed, failed, cancelled, and expired request states.
- Atomic claim and owner-bound completion.
- Focused-reader default, explicit `window_id` targeting, and ambiguity failure.
- App-not-running, reader-not-running, timeout, and expiry handling.
- A `.mcp-notify` `control` event.
- Tauri commands for registration, heartbeat, polling, claim, completion, and failure.

Focused verification already passed:

```text
cargo test --lib mcp::control:: --no-fail-fast
10 passed
```

Known incomplete or questionable areas:

- No frontend main-window runtime registration or heartbeat consumer.
- No frontend reader-window runtime registration or heartbeat consumer.
- No frontend dispatcher executes queued requests.
- No model-facing MCP handler currently enqueues through `McpState.control`.
- The compile-time allowlist must be reconciled with the evaluated final catalog.
- `ControlStore::list_live_sessions` and `McpState.control` currently produce unused-code warnings.
- `control.rs` is 1,059 lines. Review it against the repository restraint rule and simplify it where possible without weakening authentication, ownership, expiry, ambiguity, or data-safety behavior.

## Exact working-tree state

No work from this redesign has been committed. The isolated worktree currently contains:

```text
M  src-tauri/src/commands/mcp.rs
M  src-tauri/src/lib.rs
M  src-tauri/src/mcp/mod.rs
M  src-tauri/src/mcp/notify.rs
M  src-tauri/src/mcp/state.rs
?? src-tauri/src/mcp/control.rs
?? docs/testing/mcp-tool-selection-README.md
?? docs/testing/mcp-tool-selection-corpus.json
?? docs/impls/mcp-full-surface-handoff.md
```

It also contains formatting-only changes accidentally produced when `rustfmt` recursively formatted unrelated modules:

```text
src-tauri/src/ai/router.rs
src-tauri/src/commands/ai/routing.rs
src-tauri/src/commands/books/mod.rs
src-tauri/src/commands/dictionary.rs
src-tauri/src/commands/lookup_history.rs
src-tauri/src/db.rs
src-tauri/src/sync/migration.rs
```

Those seven formatting-only changes should be restored to `HEAD` before further work. Do not restore any MCP bridge, corpus, or handoff files. The canonical `main` worktree has advanced independently and must remain untouched.

## Recommended takeover sequence

1. Work only in `/Users/lijianwei/vibecoding/Lantern-mcp-full-surface`; run `git fetch origin && git status` and inspect concurrent changes before editing.
2. Remove only the seven documented formatting-noise diffs.
3. Re-run the corpus validation command documented in `docs/testing/mcp-tool-selection-README.md`.
4. Delegate at least two independent blind selection evaluations to GPT-5.6-series Sub-agents.
5. Analyze confusion clusters and freeze the task-shaped catalog. Update the parity document and corpus together.
6. Reconcile and simplify the backend control bridge against the frozen catalog.
7. Implement frontend runtime consumers and wire final live-control tools end to end.
8. Implement every frozen catalog tool and remove or replace the four stale public entries.
9. Verify confirmation immediately before only resolved paid calls and irreversible operations. Include replay, changed-target, changed-scope, batch-count, and combined paid-plus-overwrite tests.
10. Prove every shipped user-visible inventory row has an MCP path; keep persistence helpers and backend maintenance internal.
11. Run focused tests first, then full Rust, frontend, and build checks required by `AGENTS.md`.
12. Commit and push only after the catalog, implementation, risk behavior, coverage audit, and checks are complete.

## Completion gates

Do not report this redesign complete until all of the following are proven:

- The final catalog is supported by blind selection evidence.
- Every shipped user-visible Lantern capability is discoverable and callable without an enable step.
- No generic executor or workflow-teaching descriptions exist.
- Paid confirmation occurs before the chargeable request and nowhere on verified free/local paths.
- Permanent confirmation binds the exact operation, target, scope, count, and relevant policy.
- Live app/reader actions work end to end, including multiple-window ambiguity and app-not-running behavior.
- Catalog, capability, bridge, risk, and selection regressions are covered by tests.
- Full required checks pass.
- The focused changes are committed and pushed without unrelated worktree changes.
