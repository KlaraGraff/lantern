// Builds the AI-output typography mockup (docs/impls/ai-output-typography.mockup.html)
// through the REAL rendering pipeline: the actual AiMarkdown / LearningCardModules /
// CitationChip components rendered with react-dom/server, and the CSS compiled by the
// actual Tailwind 4 engine from src/index.css against the produced markup. Nothing in
// the output is hand-drawn — every pixel is something the app can render.
//
// The chat fixtures are verbatim output from deepseek-v4-flash (the production model)
// answering real Lantern-style questions with the proposed marker instructions.
//
// LearningCardModules is JSX, which node's type stripping can't parse, so run
// the script through esbuild (already present as a vite dependency), from the
// repo root:
//
//   node_modules/.bin/esbuild scripts/build-ai-typography-mockup.ts --bundle \
//     --packages=external --format=esm --platform=node --jsx=automatic \
//     --outfile=node_modules/.cache/build-mockup.mjs \
//   && node node_modules/.cache/build-mockup.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import AiMarkdown from "../src/components/ai-markdown/AiMarkdown.ts";
import CitationChip from "../src/components/ai-markdown/CitationChip.ts";
import LearningCardModules from "../src/components/learning-card/LearningCardModules.tsx";
import { DEFAULT_CARD_DESIGN_CONFIG } from "../src/components/learning-card/config.ts";
import type { LearningModuleContent, LearningModuleId } from "../src/components/learning-card/types.ts";
import type { CitedSource } from "../src/hooks/useAiChat.ts";

const root = process.cwd(); // run from the repo root

const zh = JSON.parse(readFileSync(path.join(root, "src/i18n/zh.json"), "utf8"));
i18next.use(initReactI18next).init({
  resources: { zh: { translation: zh } },
  lng: "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCES: CitedSource[] = [
  {
    marker: "S1",
    chunkId: "c1",
    sectionIndex: 0,
    sectionTitle: "Chapter 1",
    snippet: "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
  },
  {
    marker: "S2",
    chunkId: "c2",
    sectionIndex: 0,
    sectionTitle: "Chapter 1",
    snippet: "“You want to tell me, and I have no objection to hearing it.”",
  },
];

// Verbatim deepseek-v4-flash output (chat-vocab probe), plus a citation line,
// a comparison table, and a task list appended so every construct is on view.
const CHAT_ANSWER = `这句话的字面意思是：

> “有一条举世公认的真理：凡是有钱的单身汉，总想娶位太太。”

也就是说，它摆出一副“客观事实、人人皆知”的姿态，宣布：**富有的单身男人一定渴望结婚** [S1]。

## 讽刺在哪里？

这是一句教科书级别的**反讽**。关键在三点：

1. **“真理”并不普世，只是某些人的心愿投射。** 说这句话的人其实不是有钱的单身汉，而是像班纳特太太那样、急着把女儿嫁出去的母亲们。奥斯丁用 \`universally acknowledged\`（举世公认）这种宏大、不容置疑的词语，包装的却是一小群人的一厢情愿——这正是讽刺。

2. **逻辑被倒置了。** 真正 \`in want\`（渴望）的不是单身汉，而是太太和小姐们 [S2]。

3. **“真理”刚宣布就被证伪了。** 紧接着第一章，班纳特先生就顶撞了太太的期待。

**词义对比**

| 表达 | 语域 | 含义 |
| --- | --- | --- |
| \`in want of\` | 正式、19世纪书面语 | 缺少而需要 |
| \`in need of\` | 中性、现代通用 | 需要 |
| \`want\`（动词） | 日常口语 | 想要 |

读完这一章可以自查：

- [x] 看出开头句的反讽姿态
- [ ] 找到班纳特先生拆台的那句话

## 一句话总结

==真正的讽刺在于：所谓“公认的真理”，其实只是那些想攀高枝的母亲们强加给有钱男人的想当然。==

> [!WARNING]
> 注意别把这句话理解成“作者认同这个观点”。奥斯丁是在模仿、夸张当时社会的势利心理，而不是在陈述自己的主张。读《傲慢与偏见》时，凡是遇到“人人都说”“大家都认为”这类句式，多半要打个问号。`;

// Prefixes of the answer above, cut mid-marker — the states a streaming reader
// actually passes through.
const STREAM_CUT_MARK = `## 一句话总结

==真正的讽刺在于：所谓“公认的真理”，其`;
const STREAM_CUT_ALERT = `## 一句话总结

==真正的讽刺在于：所谓“公认的真理”，其实只是那些想攀高枝的母亲们强加给有钱男人的想当然。==

> [!WAR`;
const STREAM_CUT_CODE = `而 \`in wan`;

// From the deepseek-v4-flash card-json-fields probe, mapped onto the word
// card's default modules.
const WORD_CONTENT: Partial<Record<LearningModuleId, LearningModuleContent>> = {
  context_meaning: {
    summary: "`in want of` 是较正式/文言的短语，意为「需要、缺少」，相当于 `in need of`。注意这里 `want` 不是「想要」的主观愿望，而是==「缺乏、需要」的客观状态==。",
    details: [
      "结构为 `be in want of + 名词`，语气正式、略带19世纪书面语色彩，现代口语更常说 `need` 或 `could use`。",
      "==关键点==：这里的 `want` 取自旧义「缺乏/匮乏」，等于 `lack`；因此 `in want of` 强调「缺少而需要」，不是强烈渴望。",
      "[!warning] 不要按现代英语把 `want` 直接理解为「想要」：若要表达「想要某物」应说 `want something`，两者语域和含义不同。",
    ],
  },
  common_senses: {
    items: [
      { title: "缺乏、匮乏（旧义，本句所用）", text: "名词用法，保留在 `in want of` / `for want of` 等固定搭配里。", meta: ["n."] },
      { title: "想要", text: "现代最常见的动词义。", meta: ["v."] },
      { title: "通缉", text: "`wanted` 的引申用法。", meta: ["adj."] },
    ],
  },
  collocations: {
    items: [
      {
        title: "`in want of` + 名词",
        text: "需要、缺少",
        examples: [{ source: "The house is in want of repair.", target: "这房子需要修缮。" }],
      },
      {
        title: "`for want of` + 名词",
        text: "因缺乏……",
        examples: [{ source: "For want of a nail the shoe was lost.", target: "少了一枚钉子，掉了一只马掌。" }],
      },
    ],
  },
  synonyms: {
    items: [
      { title: "`in need of`", text: "最直接的现代替换。" },
      { title: "`lacking`", text: "更书面，直接作表语。" },
    ],
  },
};

const PASSAGE_CONTENT: Partial<Record<LearningModuleId, LearningModuleContent>> = {
  context_meaning: {
    summary: "开篇以「举世公认的真理」的庄重口吻说反话：==真正急于结婚的不是有钱单身汉，而是急着嫁女儿的母亲们==。全书的反讽基调由此定下。",
    quote: "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
  },
  target_translation: {
    summary: "有一条举世公认的真理：凡是有钱的单身汉，总想娶位太太。",
  },
  idioms: {
    items: [
      { title: "`a truth universally acknowledged`", text: "仿科学公理的庄重句式，用于反讽。" },
    ],
  },
};

const EXPLAIN_TEXT = "这句话摆出「客观真理」的姿态说反话：真正 ==需要对方== 的不是有钱单身汉，而是急着嫁女儿的母亲们。`universally acknowledged` 的庄重语气正是讽刺所在——刚宣布的「真理」，下一章就被班纳特先生拆穿了。";

const VOCAB_DEFINITION = "「需要、缺少」。`in want of` 中的 `want` 取旧义「缺乏」，相当于 `in need of`，语气正式。";
const VOCAB_CONTEXT = "在这句里，说有钱单身汉 must be in want of a wife，字面是「必定缺一位太太」——want 越是被说成客观「缺乏」，讽刺就越重。";

// ---------------------------------------------------------------------------
// Page assembly (chrome only — the content inside every frame comes from the
// real components above)
// ---------------------------------------------------------------------------

function frame(title: string, note: string, body: ReactNode, width?: string) {
  return h(
    "section",
    { className: "flex flex-col gap-2" },
    h("h2", { className: "text-[13px] font-semibold text-text-primary" }, title),
    note ? h("p", { className: "max-w-[68ch] text-[12px] leading-[1.6] text-text-muted" }, note) : null,
    h("div", { className: width ?? "" }, body),
  );
}

const bubble = (children: ReactNode) =>
  h("div", { className: "w-full max-w-[68ch] rounded-lg border border-border bg-bg-surface px-[13px] py-[13px]" }, children);

const cardShell = (headword: string, children: ReactNode, width: string) =>
  h(
    "div",
    { className: `${width} overflow-hidden rounded-lg border border-border bg-bg-surface shadow-sm` },
    h(
      "div",
      { className: "border-b border-border/60 px-4 py-2.5" },
      h("p", { className: "font-serif text-[15px] font-semibold text-text-primary" }, headword),
    ),
    children,
  );

const popoverShell = (children: ReactNode) =>
  h(
    "div",
    { className: "w-[340px] rounded-lg border border-border bg-bg-surface px-4 pb-3 pt-1 shadow-lg" },
    h(
      "div",
      { className: "flex items-center justify-between border-b border-border/40 pb-1.5 pt-1.5" },
      h("span", { className: "text-[11px] font-semibold text-text-muted" }, zh["explain.title"]),
    ),
    children,
  );

const page = h(
  "main",
  { className: "mx-auto flex max-w-[820px] flex-col gap-10 px-6 py-10" },

  h(
    "header",
    { className: "flex flex-col gap-1" },
    h("h1", { className: "text-[17px] font-semibold text-text-primary" }, "AI 输出排版层 · 真实渲染样张"),
    h(
      "p",
      { className: "max-w-[68ch] text-[12px] leading-[1.6] text-text-muted" },
      "以下每一帧的内容都由真实组件（AiMarkdown / LearningCardModules / CitationChip）渲染、真实 Tailwind 构建产出；聊天答案是 deepseek-v4-flash 按新格式指令生成的原文。右上角可切换深色模式。",
    ),
  ),

  frame(
    "1 · 聊天答案（宽栏 68ch）",
    "覆盖：普通段落、书文摘录卡（衬线+底色）、术语/词形 chip、==高亮==、警示条、表格、列表、任务清单、引用来源 chip（可点击）。",
    bubble([
      h(AiMarkdown, { key: "answer", size: "chat", sources: SOURCES, children: CHAT_ANSWER }),
      h(
        "div",
        { key: "sources", className: "mt-2 flex flex-wrap items-center gap-1 border-t border-border pt-2" },
        h("span", { className: "mr-1 text-[11px] text-text-muted" }, zh["ai.sources"]),
        SOURCES.map((source) => h(CitationChip, { key: source.marker, source })),
      ),
    ]),
  ),

  frame(
    "2 · 流式半截状态（防闪烁守卫生效中）",
    "同一答案的三个真实截断点：高亮写到一半、警示标签写到一半、行内代码写到一半。任何时刻都看不到裸标记，已出现的样式不回跳。",
    h(
      "div",
      { className: "flex flex-col gap-3" },
      bubble(h(AiMarkdown, { size: "chat", streaming: true, children: STREAM_CUT_MARK })),
      bubble(h(AiMarkdown, { size: "chat", streaming: true, children: STREAM_CUT_ALERT })),
      popoverShell(h("div", { className: "pt-2" }, h(AiMarkdown, { size: "compact", streaming: true, className: "text-[13px] text-text-primary", children: STREAM_CUT_CODE }))),
    ),
  ),

  frame(
    "3 · 单词卡（word · 默认配置 480px）",
    "字段内容为 deepseek-v4-flash 生成的原文：summary 与 details 里的行内标记、以 [!warning] 开头的注意条目脱出列表成为警示条。",
    cardShell(
      "in want of",
      h(LearningCardModules, {
        card: DEFAULT_CARD_DESIGN_CONFIG.cards.word,
        kind: "word",
        content: WORD_CONTENT,
      }),
      "w-[480px]",
    ),
  ),

  frame(
    "4 · 段落卡（passage · 560px）＋ 摘录卡",
    "quote 字段使用与聊天摘录一致的书文表面：衬线、淡底、薰衣草左边线，不用斜体（斜体会毁掉中日韩字形）。",
    cardShell(
      "It is a truth universally acknowledged…",
      h(LearningCardModules, {
        card: DEFAULT_CARD_DESIGN_CONFIG.cards.passage,
        kind: "passage",
        content: PASSAGE_CONTENT,
      }),
      "w-[560px]",
    ),
  ),

  frame(
    "5 · 划词解释弹窗（compact）",
    "行内语义与聊天完全同源：同一个 chip、同一个高亮，只是尺寸不同。",
    popoverShell(h("div", { className: "pt-2" }, h(AiMarkdown, { size: "compact", className: "text-[13px] text-text-primary", children: EXPLAIN_TEXT }))),
  ),

  frame(
    "6 · 生词本词条详情",
    "释义走同一渲染层；语境解释里的词头 want 由前端确定性高亮（highlightTerm），不依赖模型配合。",
    h(
      "div",
      { className: "flex w-[380px] flex-col gap-3 rounded-lg border border-border bg-bg-surface p-4" },
      h("h3", { className: "text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted" }, zh["vocab.detail.definition"] ?? "释义"),
      h(AiMarkdown, { size: "compact", className: "text-[13px] text-text-primary", children: VOCAB_DEFINITION }),
      h("h3", { className: "mt-1 text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted" }, zh["vocab.detail.inContext"] ?? "语境中"),
      h(AiMarkdown, { size: "compact", highlightTerm: "want", className: "text-[12px] text-text-secondary", children: VOCAB_CONTEXT }),
    ),
  ),

  frame(
    "7 · 空态与加载骨架",
    "卡片模块流式未到时的骨架；空字符串渲染为空，不产生错误节点。",
    h(
      "div",
      { className: "flex items-start gap-4" },
      cardShell(
        "in want of",
        h(LearningCardModules, {
          card: DEFAULT_CARD_DESIGN_CONFIG.cards.word,
          kind: "word",
          content: {},
          loading: true,
        }),
        "w-[380px]",
      ),
      popoverShell(h("div", { className: "pt-2" }, h(AiMarkdown, { size: "compact", className: "text-[13px] text-text-primary", children: "" }))),
    ),
  ),
);

const bodyHtml = renderToStaticMarkup(page);

// ---------------------------------------------------------------------------
// Real Tailwind build against the produced markup
// ---------------------------------------------------------------------------

const { compile } = await import("@tailwindcss/node");
const { Scanner } = await import("@tailwindcss/oxide");

// renderToStaticMarkup escapes & and > inside class attributes; the scanner
// must see the raw class text or every [&_...] variant silently vanishes.
// "bg-bg-page" is the <body> class from the template below — it never passes
// through React, so it must be handed to the scanner explicitly.
const scanText =
  bodyHtml.replaceAll("&amp;", "&").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&quot;", '"').replaceAll("&#x27;", "'") +
  ' <body class="bg-bg-page">';

const indexCss = readFileSync(path.join(root, "src/index.css"), "utf8");
const compiler = await compile(indexCss, {
  base: path.join(root, "src"),
  onDependency: () => {},
});
const scanner = new Scanner({});
const candidates = scanner.scanFiles([{ content: scanText, extension: "html" }]);
const css = compiler.build(candidates);

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lantern · AI 输出排版层样张</title>
<style>${css}</style>
</head>
<body class="bg-bg-page">
<button onclick="document.documentElement.classList.toggle('dark')"
  style="position:fixed;top:12px;right:12px;z-index:10;font-size:11px;padding:4px 10px;border:1px solid var(--color-border);border-radius:6px;background:var(--color-bg-surface);color:var(--color-text-secondary);cursor:pointer">深色 / 浅色</button>
${bodyHtml}
</body>
</html>
`;

const out = path.join(root, "docs/impls/ai-output-typography.mockup.html");
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB, ${candidates.length} candidates)`);
