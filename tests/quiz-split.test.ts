import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { QuizWord } from "../src/quiz/types.ts";
import { isWeakWord, parseWordInput, splitWords } from "../src/quiz/split.ts";

// 迁自 labs/cijuan/src/llm/split.test.ts（vitest → node:test）。

function makeWords(n: number): QuizWord[] {
  return Array.from({ length: n }, (_, i) => ({ word: `w${i}`, origin: "today" as const }));
}

describe("splitWords", () => {
  const cases: [number, number[]][] = [
    [8, [8]],
    [12, [12]],
    [13, [7, 6]],
    [16, [8, 8]],
    [24, [12, 12]],
    [25, [9, 8, 8]],
  ];

  for (const [n, expectedSizes] of cases) {
    it(`把 ${n} 个词分成组大小 ${JSON.stringify(expectedSizes)}`, () => {
      const groups = splitWords(makeWords(n));
      assert.deepEqual(
        groups.map((g) => g.length),
        expectedSizes,
      );
      assert.equal(groups.flat().length, n);
    });
  }

  it("每组不超过上限 12", () => {
    for (const n of [8, 12, 13, 16, 24, 25]) {
      const groups = splitWords(makeWords(n));
      for (const g of groups) assert.ok(g.length <= 12);
    }
  });

  it("空输入返回空数组", () => {
    assert.deepEqual(splitWords([]), []);
  });
});

describe("parseWordInput", () => {
  it("按换行/逗号/顿号/分号（含中英文标点）切分，空格不是分隔符", () => {
    const raw = "apple, banana、cherry；date\nelder，grape;honey";
    assert.deepEqual(parseWordInput(raw), [
      "apple",
      "banana",
      "cherry",
      "date",
      "elder",
      "grape",
      "honey",
    ]);
  });

  it("词组不被空格拆散（in particular / take over）", () => {
    assert.deepEqual(parseWordInput("in particular\ntake over, look forward to"), [
      "in particular",
      "take over",
      "look forward to",
    ]);
  });

  it("词组内多余空格压成一个，去重时也视为同一项", () => {
    assert.deepEqual(parseWordInput("in  particular, in particular"), ["in particular"]);
  });

  it("剥掉行首序号与项目符号（2. / (3) / -），纯数字碎片丢弃", () => {
    assert.deepEqual(
      parseWordInput("1. subsidy\n2. particular\n(3) curb\n- allocate\n4、mitigate"),
      ["subsidy", "particular", "curb", "allocate", "mitigate"],
    );
  });

  it("序号剥离不误伤以数字开头的词（2nd）与序号后的词组", () => {
    assert.deepEqual(parseWordInput("2nd\n3. in particular"), ["2nd", "in particular"]);
  });

  it("大小写不敏感去重，保留首次出现的写法", () => {
    assert.deepEqual(parseWordInput("Apple, apple, APPLE, banana"), ["Apple", "banana"]);
  });

  it("去空白、丢弃空片段", () => {
    assert.deepEqual(parseWordInput("  foo ,, bar   "), ["foo", "bar"]);
  });
});

describe("isWeakWord", () => {
  it("识别单独出现的功能词（the / of / is）", () => {
    assert.equal(isWeakWord("the"), true);
    assert.equal(isWeakWord("OF"), true);
    assert.equal(isWeakWord("is"), true);
  });

  it("实义词与词组不受影响（in particular 里的 in 不算）", () => {
    assert.equal(isWeakWord("subsidy"), false);
    assert.equal(isWeakWord("in particular"), false);
    assert.equal(isWeakWord("take over"), false);
  });
});
