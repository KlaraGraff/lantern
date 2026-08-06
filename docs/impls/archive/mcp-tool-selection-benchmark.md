# MCP Tool Selection Benchmark

> **Archived — measures a catalog that was never built.** This benchmark was
> written for the discarded 67-tool candidate. Against the shipped 29-tool
> catalog, 49 of its 87 cases name tools that do not exist, and its `paid_only`
> confirmation class was removed with the rest of the paid-action surface —
> MCP never asks Lantern to call an AI provider. The 38 surviving cases are
> reusable as a starting point if tool-selection evaluation is picked up again;
> the counts below are not.

`mcp-tool-selection-corpus.json` is a product-level, framework-neutral selection benchmark for the 67-tool candidate in [MCP Full Product Parity](../../features/archive/mcp-full-product-parity.md). It evaluates whether an agent can select Lantern actions from ordinary user language. It is not a registry test and does not prescribe a user workflow.

## Coverage

| Measure | Count | Meaning |
| --- | ---: | --- |
| Candidate tools covered by an expected path | 67 / 67 | Every candidate tool appears in at least one path. |
| Total cases | 87 | Includes direct, indirect, boundary, and negative prompts. |
| Chinese / English | 44 / 43 | Natural prompts in both shipped UI languages. |
| Direct / indirect | 52 / 19 | Direct requests are balanced with goal-first language that avoids product vocabulary. |
| Multi-step | 8 | Tests ordered paths across library, reader, vocabulary, OCR, service, and sync domains. |
| Unsupported-platform | 3 | Tests that discoverability remains intact and returns `unsupported_on_platform`. |
| No-tool | 5 | Tests that general advice, explanation, creative work, and underspecified requests do not cause a Lantern call. |
| No confirmation / paid-only / permanent / conditional permanent | 63 / 9 / 13 / 2 | Separates ordinary work from resolved API cost and irreversible effects. |
| Product domains | 15 | Matches every domain in the catalog candidate. |

Risk and selection boundaries are intentionally repeated rather than counted only once: local dictionary versus contextual AI explanation, local form saving versus AI form generation, free speech versus custom-provider speech, normal updates versus permanent deletion, new-file export versus overwrite, and import preview versus destructive conflict overwrite.

## Blind Evaluation

1. Give the evaluator the current `tools/list` result, normal server instructions, a prepared fixture, and only the case's `id`, `language`, and `prompt`. Do not reveal `expected_first_tool`, `expected_tool_path`, `allowed_alternatives`, rationale, tags, or confirmation expectation.
2. The fixture must contain every referenced book, collection, annotation, chat, vocabulary entry, reader window, route, file path, and peer in an unambiguous state. Create one focused-reader fixture and one multi-reader fixture. Preserve the prompt wording and run direct and indirect cases independently.
3. Record the first attempted tool, all attempted calls in order, normalized arguments, schema rejections, outcome, confirmation actually requested, resolved route/cost class, completion state, input/output tokens, and elapsed time. For a no-tool case, record the assistant response and whether it asked the minimal missing question where appropriate.
4. After execution, compare the trace to `expected_first_tool` and `expected_tool_path`. An entry in `allowed_alternatives` is an accepted full path; it is empty in the initial corpus to make current candidate boundaries deliberately discriminative.
5. Score approval independently from tool selection. For `paid_only`, run paid and unknown-cost route variants and require confirmation before the network request. Where the product exposes a known free/local route, also run that variant and require no confirmation. For `conditional_permanent`, run both the safe path and the named destructive overwrite. For `permanent`, mutate an ID, count, scope, policy, or replay token after approval and require rejection.

The evaluator should use a fresh fixture or reset state for every mutation. Do not let a confirmation created by one case authorize another case.

## Result Record

Store results outside this corpus so its expected answers stay stable. A row or JSON record should include:

```json
{
  "case_id": "EDGE-004",
  "fixture_variant": "paid_route",
  "actual_first_tool": "run_ai_reading_action",
  "actual_tool_path": ["run_ai_reading_action"],
  "normalized_arguments_valid": true,
  "completed_user_outcome": true,
  "actual_confirmation": "paid_only",
  "confirmation_before_side_effect": true,
  "unnecessary_calls": 0,
  "schema_errors": 0,
  "input_tokens": 0,
  "output_tokens": 0,
  "elapsed_ms": 0,
  "notes": ""
}
```

Report these metrics by domain, language, request style, and risk class:

| Metric | Pass rule |
| --- | --- |
| First-tool accuracy | Actual first tool equals expected first tool, or an accepted alternative. |
| Path completion | The expected ordered path is completed and the requested product outcome is correct. |
| Unnecessary-call rate | Extra calls not needed for the fixture or expected path, divided by cases. |
| Schema-error rate | Rejected or malformed tool calls, divided by attempted calls. |
| Confirmation correctness | Correct class, shown before the paid/irreversible side effect, with no confirmation for ordinary paths. |
| No-tool precision | No Lantern tool called for every `no_tool` case. |
| Platform-result accuracy | Unsupported cases call the listed capability and return the expected structured result. |
| Efficiency | Median and p95 input/output tokens and elapsed time, with per-domain outliers retained. |

Treat a repeated confusion cluster as design evidence: split a tool when distinct user goals repeatedly select the wrong schema, or merge tools only when users consistently express one goal and the result and confirmation boundary are the same. Update the parity catalog and this corpus together when that conclusion changes the candidate surface.

## Validation

The corpus is valid JSON. A repository-local validation command should verify all of the following against the canonical-name code block in the parity document:

```sh
jq empty docs/testing/mcp-tool-selection-corpus.json
node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync("docs/testing/mcp-tool-selection-corpus.json","utf8")); const d=fs.readFileSync("docs/features/mcp-full-product-parity.md","utf8"); const s=d.split("## Canonical name list")[1].split("## Shipped product inventory")[0]; const names=[...s.matchAll(/^([a-z][a-z0-9_]+)$/gm)].map(m=>m[1]); const seen=new Set(c.cases.flatMap(x=>x.expected_tool_path)); const missing=names.filter(x=>!seen.has(x)); const extra=[...seen].filter(x=>!names.includes(x)); if(names.length!==67||c.cases.length!==87||missing.length||extra.length) throw new Error(JSON.stringify({names:names.length,cases:c.cases.length,missing,extra}));'
```
