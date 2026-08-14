import assert from "node:assert/strict";
import test from "node:test";
import {
  quizLookupTarget,
  type QuizLookupNode,
} from "../src/pages/quiz/lookup-scope.ts";

function node(partial: Partial<QuizLookupNode> = {}): QuizLookupNode {
  return { surface: false, interactive: false, askFrom: null, askCtx: null, ...partial };
}

test("文字落在查词区域里就通过", () => {
  assert.deepEqual(
    quizLookupTarget([node(), node({ surface: true })]),
    { askFrom: null, askCtx: null },
  );
});

test("区域外的文字不开菜单", () => {
  assert.equal(quizLookupTarget([node(), node()]), null);
});

test("落在区域里的按钮上，手势归按钮", () => {
  assert.equal(
    quizLookupTarget([node({ interactive: true }), node({ surface: true })]),
    null,
  );
});

test("区域自身就是控件时也不查词", () => {
  assert.equal(quizLookupTarget([node({ surface: true, interactive: true })]), null);
});

test("追问出处取最近的一层——选项胜过整道题", () => {
  assert.deepEqual(
    quizLookupTarget([
      node(),
      node({ askFrom: "第 1 题 · 选项 B", askCtx: "选项全文" }),
      node({ surface: true, askFrom: "第 1 题", askCtx: "题干与四个选项" }),
    ]),
    { askFrom: "第 1 题 · 选项 B", askCtx: "选项全文" },
  );
});

test("讲解正文没有自己的出处，继承题目块那一层", () => {
  assert.deepEqual(
    quizLookupTarget([
      node(),
      node(),
      node({ surface: true, askFrom: "第 2 题", askCtx: "题干与四个选项" }),
    ]),
    { askFrom: "第 2 题", askCtx: "题干与四个选项" },
  );
});

test("出处标注在区域外侧时不算数——判定到区域边界就停", () => {
  assert.deepEqual(
    quizLookupTarget([
      node(),
      node({ surface: true }),
      node({ askFrom: "整张卷子", askCtx: "全卷" }),
    ]),
    { askFrom: null, askCtx: null },
  );
});

test("只有出处、没有上下文时，上下文留给调用方兜底", () => {
  assert.deepEqual(
    quizLookupTarget([node({ surface: true, askFrom: "第 3 题", askCtx: null })]),
    { askFrom: "第 3 题", askCtx: null },
  );
});
