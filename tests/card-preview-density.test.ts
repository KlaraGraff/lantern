import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { getLearningCardFixture } from "../src/components/learning-card/fixtures.ts";
import { MODULE_DEFINITIONS } from "../src/components/learning-card/config.ts";
import type { LearningCardKind } from "../src/components/learning-card/types.ts";

function initializerOf(file: string, name: string): ts.Expression {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(declaration?.initializer, `no initializer for ${name} in ${file}`);
  return declaration.initializer;
}

function evaluate<T>(code: string, sandbox: Record<string, unknown>): T {
  return runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), sandbox) as T;
}

const PREVIEWS = {
  word: { beginnerEnglish: "BEGINNER-SUPPLEMENT", intermediateChinese: "B2-SUPPLEMENT" },
  phrase: { beginnerEnglish: "BEGINNER-SUPPLEMENT", intermediateChinese: "B2-SUPPLEMENT" },
  passage: { beginnerEnglish: "BEGINNER-SUPPLEMENT", intermediateChinese: "B2-SUPPLEMENT" },
};

function previewDetails(kind: LearningCardKind, explanationMode: string, learnerLevel: string) {
  const initializer = initializerOf("src/components/settings/CardPreview.tsx", "localResult");
  assert.ok(ts.isCallExpression(initializer), "localResult should be a useMemo call");
  const callback = initializer.arguments[0].getText(initializer.getSourceFile());
  const result = evaluate<{ modules: { context_meaning?: { details?: string[] } } }>(
    `const localResult = (${callback})();\nlocalResult;`,
    {
      useMemo: (fn: () => unknown) => fn(),
      getLearningCardFixture,
      t: (key: string) => key,
      ADAPTIVE_EXPLANATION_PREVIEWS: PREVIEWS,
      TARGET_TRANSLATION_PREVIEWS: {
        word: { en: "en", zh: "zh" },
        phrase: { en: "en", zh: "zh" },
        passage: { en: "en", zh: "zh" },
      },
      config: { cards: { [kind]: { modules: [], customModules: {} } } },
      kind,
      explanationLanguage: "en",
      explanationMode,
      learnerLevel,
      targetLanguage: "zh",
    },
  );
  return result.modules.context_meaning?.details ?? [];
}

test("B2 adaptive bilingual preview carries the Chinese supplement", () => {
  // prompt.rs::explanation_strategy: B2 adaptive is English-primary *with* a
  // brief Chinese gloss, so the settings preview has to show one.
  const details = previewDetails("word", "adaptive_bilingual", "B2");
  assert.ok(details.includes("B2-SUPPLEMENT"), `B2 preview details were ${JSON.stringify(details)}`);
  assert.equal(details.at(-1), "B2-SUPPLEMENT");
});

test("B1 keeps the beginner English restatement, C1 adds neither", () => {
  const beginner = previewDetails("word", "adaptive_bilingual", "B1");
  assert.ok(beginner.includes("BEGINNER-SUPPLEMENT"));
  assert.ok(!beginner.includes("B2-SUPPLEMENT"));

  const advanced = previewDetails("word", "adaptive_bilingual", "C1");
  assert.ok(!advanced.includes("B2-SUPPLEMENT"));
  assert.ok(!advanced.includes("BEGINNER-SUPPLEMENT"));
});

test("the density guide only lists modules the card kind actually has", () => {
  const initializer = initializerOf("src/components/settings/DensityHelpDialog.tsx", "rows");
  const rows = evaluate<Record<LearningCardKind, string[]>>(
    `const rows = ${initializer.getText(initializer.getSourceFile())};\nrows;`,
    {},
  );
  for (const kind of ["word", "phrase", "passage"] as LearningCardKind[]) {
    const available = new Set(MODULE_DEFINITIONS[kind].map((module) => module.id as string));
    for (const id of rows[kind]) {
      assert.ok(available.has(id), `${kind} cards have no ${id} module, but the density guide lists it`);
    }
  }
});
