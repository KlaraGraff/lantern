import assert from "node:assert/strict";
import test from "node:test";
import { LearningCardStreamParser } from "../src/components/learning-card/streaming.ts";

const payload = JSON.stringify({ modules: {
  context_meaning: "这里的意思",
  unknown_module: null,
  grammar_analysis: ["主句", "从句"],
  references: false,
  idioms: { summary: "固定表达", items: [{ text: "a phrase", examples: ["Example", { source: "Another", target: "另一个" }] }] },
} });

test("streaming keeps later modules after strings, arrays, and unsupported values at every split", () => {
  for (let split = 0; split <= payload.length; split++) {
    const parser = new LearningCardStreamParser(new Set(["context_meaning", "grammar_analysis", "references", "idioms"]));
    const result = { ...parser.push(payload.slice(0, split)), ...parser.push(payload.slice(split)) };
    assert.equal(result.context_meaning?.summary, "这里的意思");
    assert.deepEqual(result.grammar_analysis?.details, ["主句", "从句"]);
    assert.equal(result.references, undefined);
    assert.equal(result.idioms?.items?.[0].title, "a phrase");
    assert.equal(result.idioms?.items?.[0].examples?.[1].target, "另一个");
    assert.equal(Object.keys(result).length, 3);
  }
});

test("streaming handles escaped quotes and brackets token by token and honors enabled custom modules", () => {
  const parser = new LearningCardStreamParser(new Set(["custom_example"]));
  const summary = 'a "quote" with } and \\ and [ brackets';
  const raw = JSON.stringify({ modules: { context_meaning: { summary: "disabled" }, custom_example: { summary } } });
  const result = Object.assign({}, ...Array.from(raw, (char) => parser.push(char)));
  assert.equal(result.custom_example.summary, summary);
  assert.equal(result.context_meaning, undefined);
});

test("a completed module is visible before the whole response closes", () => {
  const parser = new LearningCardStreamParser(new Set(["context_meaning", "idioms"]));
  const result = parser.push('{"modules":{"context_meaning":{"summary":"ready"}');
  assert.equal(result.context_meaning?.summary, "ready");
  assert.deepEqual(parser.push(',"idioms":{"summary":"unfinished'), {});
});

test("empty and malformed items do not prevent readable content from streaming", () => {
  const parser = new LearningCardStreamParser(new Set(["context_meaning", "idioms"]));
  const result = parser.push(JSON.stringify({ modules: {
    context_meaning: {},
    idioms: { details: [42, "useful"], items: [{ unknown: "unusable" }, { title: "usable", examples: [{ bad: true }, { source: "example" }] }] },
  } }));
  assert.equal(result.context_meaning, undefined);
  assert.deepEqual(result.idioms?.details, ["useful"]);
  assert.equal(result.idioms?.items?.length, 1);
  assert.equal(result.idioms?.items?.[0].examples?.length, 1);
});
