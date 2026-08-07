# AI 输出排版层（ai-output-typography）

> 状态：原型已完成并通过测试，等待主会话审查、提交。
> 样张：[`ai-output-typography.mockup.html`](ai-output-typography.mockup.html)（真实组件 + 真实 Tailwind 构建产出，可直接双击打开；右上角切换深色模式）。样张构建脚本：[`scripts/build-ai-typography-mockup.ts`](../../scripts/build-ai-typography-mockup.ts)。

Lantern 有四个界面在渲染 AI 输出：聊天答案、选中学习卡、划词解释弹窗、生词本词条详情。此前是三套互不相干的做法（MessageBubble 内嵌 40 行 prose 类 + 自己的 CitationChip；`lookup-prose.ts`；学习卡纯文本渲染）。本方案把它们合并成一个渲染层 `src/components/ai-markdown/`，让摘录引用、术语条、高亮、警示注记各有一个确定的视觉形态，改一处即全局生效。

---

## 一、四个方案点的裁定（原计划 vs. 实际结论）

主会话原计划的四个点，逐条攻击后的结论：

| # | 原计划 | 裁定 | 理由 |
|---|--------|------|------|
| 1 | 复用模型已会写的语法：backtick→术语条、`> 引用`→摘录卡、`> [!warning]`→警示条，只新增 `==高亮==` | **成立，照做** | deepseek-v4-flash（生产主力模型）实测：带规则提示词下四种标记全部稳定产出，`==…==` 也能克制在每答 1–2 处（见第三节实测记录） |
| 2 | 用 remark 插件改写 mdast，不写新解析器 | **成立，照做** | 两个插件共 ~230 行（`plugins.ts`），跑在 react-markdown 现有管线里；自写解析器要重造转义、嵌套、GFM 交互，无收益 |
| 3 | 学习卡 JSON schema 不动，字段内允许行内标记 | **成立，照做** | 实测模型在 JSON 字段里写行内标记不破坏 JSON 合法性；`LEARNING_CARD_SCHEMA_VERSION` 不必 bump（纯呈现变化，旧内容照常渲染） |
| 4 | 三套 prose 类合并为一套 | **修正为「一套语义 + 两个尺寸」** | 聊天宽栏（15px/68ch）与弹窗窄栏（13px/340px）字号行距必须不同，但语义样式（引用/术语/高亮/警示的形态）完全共享。产物：`prose.ts` 里 `BASE` + `AI_PROSE_CHAT` / `AI_PROSE_COMPACT`。顺带发现旧代码里 `prose prose-sm` 是死类（项目根本没装 typography 插件），直接删除 |

## 二、四个问题的回答（各一条建议）

**Q1：`==高亮==` 值得引入吗？**
**值得，已引入，并配确定性兜底。** 实测 deepseek-v4-flash 对「至多一两处高亮」的指令服从良好，不会满屏泼洒。但对不配合的模型（或自定义提示词模块）不能指望它，所以渲染层同时提供 `highlightTerm` 属性：由前端把词头确定性高亮（拉丁词按词边界、CJK 按子串），零模型配合成本。生词本的语境解释用的就是这个兜底——模型一个标记都不写也有高亮。

**Q2：remark-gfm@4 支持 GFM alerts 吗？自实现代价多大？**
**不支持——alerts 是 GitHub 渲染端的私有扩展，不在 GFM 规范里。** 自实现代价极小：`remarkLanternAlerts` 是一个 ~25 行的 blockquote walker，识别首行 `[!note|tip|important|warning|caution]`，在节点上打 `dataAlert` 标记，渲染层据此把 blockquote 换成 `AlertStrip`。没打标记的、标签未知的 blockquote 原样降级为普通摘录卡，永不报错。

**Q3：backtick 做术语条载体安全吗？编程书里有真代码。**
**安全，前提是样式保持中性。** 术语条刻意做成「中性 chip」（等宽字、淡底、细边框）而不是彩色标签——真代码渲染出来也完全正常，不会出现「`for` 循环被当成生词」的荒谬感。最刁钻的对抗样例来自真实模型输出：讲解 JS 相等运算符时，模型写出 `==\`===\` 要求类型和值都相等，而 \`==\` 只要求值相等==`——高亮内部嵌着字面就是 `==`/`===` 的代码 span。micromark 的解析顺序保证 code span 优先于我们的标记切分（插件只处理 text 节点，不碰 inlineCode），这个样例已固化为回归测试。

**Q4：三套 prose 真的合并，还是「一套语义 + 两个尺寸」？**
**后者。** 见第一节第 4 条。合并的是语义，不是字号。

## 三、生产模型实测（deepseek-v4-flash）

> 用户指定：以 `deepseek-v4-flash` 的测试效果为准（它将是软件的主力模型）。探针脚本在会话 scratchpad，API key 走环境变量，未进入仓库。

- **聊天（词汇/语法问题）**：四种标记全部正确产出，高亮克制在 1–2 处；会主动用 `##` 小标题——渲染层已有标题样式，无需禁止。
- **JSON 学习卡**：字段内行内标记不破坏 JSON；曾把整句书文放进 backtick，因此三处提示词都写入了 "never backtick a whole sentence"。
- **无标记规则的自定义提示词模块**：优雅降级为纯文本，渲染层不产生任何错误节点。
- **推理模型的空答案坑（已在产品代码解决，此处仅存档）**：`deepseek-v4-flash` 先吐 `reasoning_content` 再吐 `content`，若请求带了偏低的 `max_tokens`，预算会被推理耗尽——`content` 为空但请求「成功」。App 的 provider 层早已双重免疫：`router.rs::answer_token_limit` 只对 Anthropic（API 强制要求该字段）发送 `max_tokens`，OpenAI 兼容端点一律不发，长度约束全靠提示词；`openai_compat.rs` 单独解析 `reasoning_content` 增量，不会混入正文。本次踩坑是因为探针脚本绕过 app 直连 API 并自设了 `max_tokens: 900`——**教训：任何绕过 provider 层直连该模型的脚本（测试、CI、探针）都不要设 `max_tokens`**。

## 四、标记词汇表（最终版）

模型输出是**不可信数据**。所有标记只经 mdast 改写产生 React 元素，无 HTML 注入面（原始 HTML 一律转义为文本，URL 过 `citationUrlTransform` 白名单）。

| 标记 | 语义 | 视觉形态 |
|------|------|----------|
| `> 引文` | 书文摘录（只许引原文，不许引转述） | 摘录卡：衬线字体、淡底、薰衣草左边线、不用斜体（斜体毁 CJK 字形） |
| `` `短语` `` | 讨论中的语言形式（词/搭配/句型） | 中性 chip：等宽、`bg-bg-muted` 淡底、细边框 |
| `==短语==` | 读者该记住的那一句（每答至多 1–2 处） | `<mark>`：`bg-accent-bg`（雾紫），`box-decoration-clone` 跨行不断裂 |
| `> [!WARNING]` / `[!CAUTION]` | 易错点、需警惕 | 警示条：amber 边线/淡底 + 三角图标 + i18n 标签（易错/注意） |
| `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` | 中性补充 | 同构条：accent 紫系 + Info 图标（注/提示/重点） |
| `[S1]`（仅聊天） | 引用来源 | CitationChip，点击跳转原文；伪造编号不成链 |
| 卡片 details 条目首 `[!warning] ` | 卡内警示 | 脱出列表，渲染为同一个 `AlertStrip` |

标签文案全部走 i18n（`ai.markdown.alert.*`，en/zh 均已补）。

## 五、渲染层结构

```
src/components/ai-markdown/
  AiMarkdown.ts        统一入口。props: size(chat|compact) / inline / streaming
                       / highlightTerm / sources / onNavigateToSource / className
  plugins.ts           remarkLanternAlerts（~25行）+ remarkLanternMarks（==切分、
                       跨兄弟配对、未闭合降级、highlightTerm 注入）
  streaming-tail.ts    settleStreamingTail：流式尾部整定（详见下）
  prose.ts             BASE + AI_PROSE_CHAT / AI_PROSE_COMPACT + ANSWER_LEAD_CLASS
  CitationChip.ts      从 MessageBubble 原样提出
```

四个接线点：`MessageBubble`（chat + streaming + sources）、`ExplainPopover`（compact + streaming）、`VocabEntryDetails`（compact + highlightTerm）、`ExplanationsContent` 与 `LearningCardModules`（compact + inline；卡的 details 条目按 `[!warning]` 前缀脱出为 AlertStrip，quote 字段与聊天摘录同一表面）。`lookup-prose.ts` 已删除。

**流式防闪烁（最高风险项，先解决）。** `settleStreamingTail` 在每帧渲染前整定文本尾部：写了一半的 `==`/`**`/`~~`/`` ` `` 若是裸开标记则暂时隐藏、若已开span则临时补闭（补闭前先修剪尾部空白——micromark 规定闭标记前不能有空白，这是测试逼出来的真 bug）；写了一半的 `> [!WAR` 隐藏整行（否则会先闪一个空摘录卡再变形为警示条）；未闭合的代码围栏整体放行不动。保证任意截断点：不吐裸标记、不产生错误节点、已渲染的词不消失。学习卡的流式解析器只在模块对象完整时才交给渲染，天然无此问题。

**尺寸语义**：`chat` = 15px 宽栏 + 首段加粗引导样式；`compact` = 弹窗/卡片窄栏。`inline` 模式（卡字段用）用 `allowedElements + unwrapDisallowed` 把块级元素解包成行内，防止模型在 JSON 字段里写出列表/标题破坏卡片版式。

## 六、提示词改动（Rust 侧）

- `prompt.rs`：新增 `MARKUP_GUIDE` 常量（四种标记的使用规则，措辞经 deepseek-v4-flash 验证），`chat.rs` 在 `ANSWER_DISCIPLINE` 后拼接。
- `explain.rs`：允许 backtick 与 `==…==`（各至多一两次），维持纯散文禁块级。
- `learning_card.rs`：字段内允许行内标记 + `[!warning] ` 前缀，禁其他 Markdown。schema 版本不 bump。

## 七、测试与验证

- `tests/ai-markdown-render.test.ts`（29 例）：标记结构、跨粗体高亮、`===` 字面、未闭合降级、code span/围栏内不切分、表格/列表内标记、**真实模型对抗样例**（高亮内嵌 `==`/`===` code span）、highlightTerm 词边界/CJK、警示条 + 双语标签、CitationChip 回归 + 伪造编号、注入安全（`<script>`/`onerror`/`javascript:`）、inline 解包、空态。
- `tests/ai-markdown-streaming.test.ts`（13 例）：整定函数直测 + **全前缀扫描**——对一段含全部四种语义的答案，逐字符截断每一个前缀走真实渲染，断言 HTML 中永无裸 `==`、永无半截 `[!` 标签、已出现的词不回退。
- 全量：`npm run test:unit` 947/947 通过；`tsc --noEmit` 干净；`cargo test` 1168/1168 + 2 集成通过。
- 样张经浏览器实测核验：高亮/警示条/摘录卡/术语 chip/引用 chip 的计算样式、流式区无裸标记、骨架态、深浅色切换，全部符合。

## 八、分阶段上线

1. **P1（本次原型已含）**：渲染层 + 四界面接线 + 提示词 + 测试。合入即全量生效——无开关、无兼容层（项目无历史包袱原则）。
2. **P2（可选）**：其余模型（如自定义 OpenAI 兼容端点）的标记服从度抽测；不服从也只是少样式，无破坏。

## 九、风险

- **模型不服从/过度使用标记**：渲染层对一切降级安全（未知标签→普通引用；未闭合→字面显示；无标记→纯文本）。最坏结果是"没有样式"，不是"坏样式"。
- **提示词长度**：`MARKUP_GUIDE` 约 120 词，进 system prompt 稳定段（可被缓存），成本可忽略。
- **Safari 15**：全程未用 `:has()`；`box-decoration-clone`、`oklab` 颜色由 Tailwind 4 输出的兜底值覆盖。
- **绕过 provider 层的直连脚本**：若自设 `max_tokens`，推理模型会表现为"回答为空"，易被误判为标记方案的问题——复现条件与免疫机制见第三节。
