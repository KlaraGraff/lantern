import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isFreshlyReady, isSuppressedByRoute } from "../src/pages/quiz/quiz-ready-banner.ts";

// 全应用完成横幅的纯判定（docs/impls/quiz-generation-background.md §B）：
// 触发看「paperId 从无到有」这一转变，不是「此刻有 paperId」；抑制规则只看
// 当前路由是否已经是这张卷的做题页。

describe("isFreshlyReady", () => {
  it("从无到有 → 触发", () => {
    assert.equal(isFreshlyReady(null, 7), true);
  });

  it("本来就有 → 不重放（避免挂载即弹）", () => {
    assert.equal(isFreshlyReady(7, 7), false);
  });

  it("一直没有 → 不触发", () => {
    assert.equal(isFreshlyReady(null, null), false);
  });

  it("重新生成：新会话先把 paperId 归零，再次从无到有 → 又算一次触发", () => {
    assert.equal(isFreshlyReady(7, null), false);
    assert.equal(isFreshlyReady(null, 9), true);
  });
});

describe("isSuppressedByRoute", () => {
  it("当前就在这张卷的做题页 → 抑制", () => {
    assert.equal(isSuppressedByRoute("/quiz/paper/7", 7), true);
  });

  it("在别的页面（包括词卷设置页本身）→ 不抑制", () => {
    assert.equal(isSuppressedByRoute("/quiz", 7), false);
    assert.equal(isSuppressedByRoute("/reader/42", 7), false);
  });

  it("在另一张卷的做题页 → 不抑制（不是同一张卷）", () => {
    assert.equal(isSuppressedByRoute("/quiz/paper/3", 7), false);
  });
});
