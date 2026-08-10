# Reader P2.1–P2.5 / P3.1–P3.4 独立复核报告

日期：2026-08-04。性质：只读复核（read-only re-verification）。复核阶段未修改任何代码、未 `git add`、未 commit、未 push、未发布；工作区中他人留下的未跟踪文件全部原样保留。

> **后续状态（2026-08-05）**：用户在复核结束后授权按本报告的建议逐条修复。第 2 节列出的 1 项 High、8 项 Medium、10 项 Low 已全部落地，提交范围见 `git log` 中紧随本文件之前的一组 `fix(reader|vocab|fonts)` 提交。本文件保留复核当时的原始判断与行号，不随修复回改——它记录的是修复前的状态。

## 0. 复核基准与仓库状态（必须先读）

**仓库**：`~/vibecoding/Lantern`，分支 `main`。已执行 `git fetch origin && git status` 确认为规范仓库（canonical clone），不是机器上的其他陈旧克隆。

**HEAD 在复核期间发生了漂移，这不是本次复核造成的。** 开始时 HEAD = `6f28481`（`docs(reader): hand off P2-P3 design review`）。复核进行中另一个任务持续向 `main` 提交重构：

| 提交 | 内容 | 是否触及 P2/P3 审查面 |
| --- | --- | --- |
| `a4cf2b6` | 抽出 `useReaderZoom` | 只动 `Reader.tsx` 结构 |
| `44ac4ee` | 新增 `docs/impls/ai-router-cc-switch-review.md` | 否 |
| `98f9eeb` | 拆分 `ai.rs` → `ai/prompt.rs` + `ai/stream.rs` | 间接（`ai/xray.rs` 改 4 行） |
| `f6031a7` | 抽出 `useReaderOcr` | 只动 `Reader.tsx` 结构 |
| `1c97f7f` | `ai.rs` 继续拆分 | 否 |
| `e65edc9` | 抽出阅读辅助设置同步 hook | 间接（`Reader.tsx`） |
| `413df55` | `ai.rs` 学习卡片/自定义动作外移 | 否 |

写报告时 HEAD = `413df55`，且工作区仍有他人未提交的改动 ` M src/pages/Reader.tsx`、` M src-tauri/src/commands/ai.rs`。

**因此对行号的处理规则如下**，请按此阅读第 2 节：

- 非 `Reader.tsx` 的所有行号，已在 `413df55` 上逐条重新核对，**准确**。
- `Reader.tsx` 的行号已在 `413df55` 上重新定位，但该文件此刻仍是 dirty 状态且正在被另一任务改写，**可能在你读到本报告时再次偏移**；请以引用的代码内容和标识符为准，行号只作定位提示。
- 上述重构均为结构性搬移，未观察到它改变本报告任何一条结论的行为语义。但**这七个提交本身不在本次复核范围内**，本报告不为它们背书。

**已读文档**：`AGENTS.md`、`docs/impls/reader-p2-p3-design-review-handoff-2026-08-04.md`、`reader-p2-p3-qa-report.md`、`reader-p2-p3-headless-qa.md`、`reader-p2-p3-integration-ledger.md`，以及九份分项实施文档（`reader-p2-structured-export.md`、`reader-p2-typography.md`、`reader-p2-settings-scope.md`、`reader-p2-continuous-read-aloud.md`、`reader-p3-reading-stats.md`、`reader-p3-notes-rail.md`、`reader-p3-passive-vocab.md`、`reader-p3-xray.md`、`vocab-contextual-review.md`）。

**视觉基准**：`docs/impls/assets/qa-p2-p3/` 下 11 张已确认 PNG。样张 HTML 顶部的状态/方案切换条按要求视为演示脚手架，不计入产品 UI。P3.2 旧侧栏面板、P2.5 旧侧边播放器按要求视为**已废弃对照**；P3.4 右侧索引面板按要求视为**保留的未来回退**，不作为目标。

---

## 1. 结论

**Conditional pass（有条件通过）。**

九个验收项的**产品功能语义全部成立**，没有发现会导致数据丢失、崩溃或隐私泄漏的 Critical 缺陷。P3.1/P3.4 的 AI 白名单是本次复核中质量最高的一块：请求体、日志、缓存键、错误诊断均严格限定在允许字段内，未发现正文、笔记、标注或未读内容外泄的路径（证据见 §4）。

之所以是 conditional 而非 pass，有三条主要原因：

1. **一条 High 级数据一致性缺陷**：P2.4「恢复跟随全局」与 400ms 防抖写入存在竞态，可让一条已被用户删除的每书覆盖**复活**，并连带删除同步 tombstone，从而通过 iCloud 传播到其他设备。UI 显示「跟随全局」，数据库里却仍是覆盖值。同一文件的 promote 路径有防护，restore 路径漏了（问题 #1）。
2. **P3.4 的接线契约在 `.txt` 书上被违反**：`reader-p3-xray.md` 明确写「主线只在阅读器实际完成跳转后返回 `true`……不要吞掉成 `void`」，而文本书路径是 fire-and-forget 后无条件 `return true`，卡片会在跳转未经证实的情况下关闭（问题 #6）。
3. **两项明显视觉偏差**：P2.1 导出弹窗缺失样张里整块「包含字段」勾选区；P3.3 被动生词设置从样张的独立子页（图示单选卡 + 实时预览）落地成了两行普通 `Select`（§3）。这两项不影响功能验收，但确实偏离了已拍板样张。

风格基调本身没有问题：实现整体是中性纸色为主、紫色仅作点缀、发丝线分隔的克制排版，未见营销感、卡片堆叠、大面积紫色或嵌套弹窗。样张里的演示脚手架（顶部状态切换条、左下角说明浮块）**没有泄漏进产品 UI**——已逐一核对。

---

## 2. 问题清单

排序：Critical → High → Medium → Low。本轮**未发现 Critical**。

### High

#### #1 P2.4：防抖写入与「恢复跟随全局」竞态，可让已删除的每书覆盖复活并跨设备传播

- **文件与行号**：`src/pages/reader/useReaderSettingsSync.ts:312`、`:316`、`:414-432`；对照有防护的 `:444-446`。
- **触发条件**：在阅读设置里改一项排版（例如两端对齐）→ 400ms 防抖计时器落地、`set_book_settings_bulk` 的 IPC 正在飞行中 → 在这个窗口内点击「恢复跟随全局」。窗口宽度 = 一次 Tauri IPC 往返 + SQLite 事务时间，在冷启动、iCloud 正在同步或磁盘繁忙时可达数百毫秒，人手可复现。
- **用户影响**：UI 立刻显示「跟随全局」，但数据库里该 key 的 `book_settings` 行被重新写回。用户下次打开这本书，排版仍是旧的每书覆盖，且没有任何入口提示它存在。更糟的是同步侧：`delete_book_settings` 写下的 tombstone 会被随后的 bulk 写入清掉，于是**这条「幽灵覆盖」会被同步到其他设备**，而其他设备上的用户从未设过它。
- **根因链路**：
  1. `flushBookSettings` 在 `:312` 把 `pendingBookSettingsRef.current` 置空，**然后**才在 `:316` `await invoke("set_book_settings_bulk", ...)`。清空发生在 await 之前，所以「有写入在飞行中」这个事实在 ref 里不留任何痕迹。
  2. `restoreBookOverrides` 在 `:416` 读 `pendingBookSettingsRef.current[bookId]` 判断有没有待写数据 —— 此刻它是 `undefined`，于是认为无事发生。
  3. `:427` 直接 `invoke("delete_book_settings", { bookId, keys })`。两条 IPC 没有排序保证，`set_book_settings_bulk` 可以后落地。
  4. Rust 侧 `do_set_book_settings_bulk` 在写入前会清掉该 key 的陈旧 tombstone（这是正确的「本地新写入优先于旧墓碑」逻辑），于是删除记录被抹平。
  5. 兄弟函数 `promoteBookOverrides` 在 `:446` 有 `await flushBookSettings(true)` 这道闸；`restoreBookOverrides` 没有。
- **证据**：三处代码在同一文件内并列，语义不对称；`promoteBookOverrides` 的 `await flushBookSettings(true)` 本身就是这道竞态存在的自证——作者已在一条路径上意识到它。
- **修复建议**：在 `restoreBookOverrides` 开头加同一道闸 `await flushBookSettings(true)`，与 promote 对齐。更彻底的做法是把「有写入在飞行中」显式建模：把 `pendingBookSettingsRef` 的清空移到 `await` 之后，或增设 `inFlightBookSettingsRef`，让 flush 与 restore/promote 共用一把顺序锁。
- **附带小问题（同函数）**：`:432` `const remaining = { ...bookOverrides }` 用的是 React state 快照而非 `bookOverridesRef.current`。在 await 之后读闭包捕获的 state，同样可能落后于真实值。`:451` 有相同写法。
- **缺失测试**：没有任何测试覆盖「flush 在飞行中时调用 restore」。建议加一条前端单测，mock `invoke` 让 `set_book_settings_bulk` 延迟 resolve，断言 restore 之后 `delete_book_settings` 一定在 bulk 之后执行、且最终 `list_book_settings` 不含该 key；Rust 侧补一条断言「bulk 写入不得清除同一轮内更晚的 tombstone」。

### Medium

#### #2 P2.5：朗读结束/失败后点击标题栏朗读图标，整条播放器被塞进标题栏图标行，布局破相

- **文件与行号**：`src/components/ContinuousReadAloudToolbar.tsx:41`、`:43`；`src/pages/Reader.tsx`（`413df55` 约 `:1801-1811`，dirty，见 §0）。
- **触发条件**：启动连续朗读 → 读完整章（`finished`）或朗读失败（`error`）→ 点击标题栏的朗读图标按钮。
- **用户影响**：`ContinuousReadAloudToolbar` 在 `finished`/`error` 状态下不认「胶囊」分支，直接渲染那条 `flex min-h-12 ... border-b w-full` 的 `<section>`。它被渲染在 `<header>` 内部的图标按钮行里，把整排工具按钮挤开或撑开标题栏高度。属于视觉破相，不丢数据。
- **根因链路**：控制器 `src/components/continuous-read-aloud.ts` 的设计不变量是「每次进入终态都同时发布 `collapsed: false`」（终态发布点均带该字段），组件因此在 `:41` 定义 `active = status !== "idle" && !== "finished" && !== "error"`，并在 `:43` 用 `collapsed && active` 作为胶囊分支的条件。但 `setCollapsed(collapsed)` 是无守卫的 `{...this.state, collapsed}`，而 `Reader.tsx` 的标题栏按钮在「非 idle」时一律 `setCollapsed(true)`——`finished` 和 `error` 都满足「非 idle」。于是产生了控制器认为不存在的组合 `collapsed=true && (finished|error)`，组件对它没有分支。
  > 说明：我最初读完控制器后判定该组合不可达，是读了 `Reader.tsx` 的按钮才确认可达。这条依赖「组件条件」与「调用方条件」两处不一致，单看任一侧都看不出来。
- **证据**：`tests/continuous-read-aloud.test.ts` 覆盖了控制器侧的终态不变量，但**没有**覆盖组件在 `collapsed && !active` 时的渲染分支。
- **修复建议**：二选一，优先前者。(a) `Reader.tsx` 的按钮改为只在 `active` 时 `setCollapsed(true)`，终态下点击应重新开始或先 `reset()`；(b) 组件把胶囊条件从 `collapsed && active` 放宽为 `collapsed`，让终态收起时渲染成胶囊而不是整条 bar。
- **缺失测试**：组件级渲染测试——`{collapsed: true, status: "finished"}` 与 `{collapsed: true, status: "error"}` 必须渲染胶囊而非 `<section>`。

#### #3 P2.2：语境挖空会在同句其他位置泄漏答案

- **文件与行号**：`src/components/vocab/contextual-review.ts:40-43`；渲染处 `src/components/DictionaryContent.tsx:1133`。
- **触发条件**：目标词在同一原句中出现两次以上。例：`The light was the only light left.`，目标词 `light`。
- **用户影响**：第一处被替换成定长下划线，**第二处原样显示**，答案直接暴露。这违反「不得暴露拼写」的验收精神——虽然它没暴露字母数（下划线是固定 `w-28`，这点是对的），但直接暴露了整个词。
- **根因链路**：`buildCloze` 用词边界逻辑（`:29-35`，Unicode 边界处理本身是正确的）找到**第一个**匹配，切成 `{before, answer, after}` 三段返回；`before`/`after` 是原文切片，未做二次遮蔽。`DictionaryContent.tsx:1133` 把 `before` 和 `after` 原样渲染。
- **证据**：`{reviewCloze.before}<span ... w-28 border-b-2 ... />{reviewCloze.after}` —— 只有中间一段被遮。
- **修复建议**：把同一套词边界正则改成全局匹配，对句中**每一处**出现都替换为下划线；或返回 `segments: Array<{text, hidden}>` 让渲染层统一处理。注意保持「所有下划线等宽」，不要按词长渲染。
- **缺失测试**：`tests/vocab-contextual-review.test.ts` 补一条重复词用例，断言返回结果中不再包含目标词（大小写不敏感）。

#### #4 P2.1：Anki 挖空缺少词边界，会把无关单词切坏

- **文件与行号**：`src/pages/reader/reader-export.ts:96-99`。
- **触发条件**：导出 Anki CSV，且例句里存在包含目标词作为子串的其他单词。例：`ankiFront("art", "He started early")`。
- **用户影响**：正面变成 `He st______ed early` —— 卡片正面语义被破坏，且目标词 `art` 本身没被挖空，等于卡片作废。用户要在 Anki 里逐张修。
- **根因链路**：`context.replace(new RegExp(\`(${escaped})\`, "i"), "______")` 只转义了正则元字符，**没有加词边界**，也没有大小写/形态归一。正确的边界逻辑在同仓库 `src/components/vocab/contextual-review.ts:29-35` 已经存在（并且处理了 Unicode，比 `\b` 更稳），但没有被复用。
- **证据**：两处实现并存，一处有边界一处没有。
- **修复建议**：把 `contextual-review.ts` 的边界匹配抽成共用函数，`ankiFront` 直接调用。不要新增依赖，也不要为此做大重构——这是一个函数级替换。
- **缺失测试**：`tests/reader-export.test.ts` 补 `ankiFront("art", "He started early")` 必须返回原句（无匹配则退回单词），以及 `ankiFront("art", "The art is here")` 正常挖空。

#### #5 P2.1：Markdown 导出的章节分组依赖输入顺序，实际输入不是按章节排序的

- **文件与行号**：`src/pages/reader/reader-export.ts:67-68`；数据来源 `src-tauri/src/commands/vocab.rs:499`。
- **触发条件**：一本书里同一章有多条记录，且这些记录的创建时间不连续（正常阅读必然如此——回头补标注、跨天重读同章）。
- **用户影响**：导出的 Markdown 里同一个 `### 章节名` 会重复出现多次，章节顺序也不是书的顺序而是时间倒序。文件仍可读，但作为「结构化导出」的结构失真。
- **根因链路**：`:68` 的逻辑是 `if (currentChapter !== previousChapter) output.push("", "### " + ...)` —— 这是一个**流式分组**，只有输入已按章节排序时才正确。后端查询是 `ORDER BY created_at DESC`，不是按章节。
- **证据**：`serializeMarkdown` 内无排序步骤，调用链上也没有。
- **修复建议**：在 `serializeMarkdown` 入口先按（章节顺序, CFI）稳定排序，或改为先 `groupBy(chapter)` 再输出。前端排序即可，不需要改后端查询（后端时间倒序对其他消费者是对的）。
- **缺失测试**：给 `serializeMarkdown` 喂乱序章节的记录，断言每个章节标题只出现一次。

#### #6 P3.4：文本书（`.txt`）的出场跳转未经证实即返回成功，卡片被错误关闭

- **文件与行号**：`src/pages/Reader.tsx:1053-1061`（`413df55`，dirty）；`src/pages/reader/useFoliateAnnotations.ts:433-435`。
- **触发条件**：在 `.txt` 书里打开人物/术语卡，点击「此前出场」的任一条目，且目标位置不可达（文本尚未加载完、位置越界、定位函数内部失败）。
- **用户影响**：卡片直接关闭，用户既没跳到目标，也丢了刚查出来的人物摘要和关系路径，只能重查一次。这正是接线契约要防的场景。
- **根因链路**：
  1. `navigateToCurrentXrayOccurrence` 对文本书只检查 `textReaderNavigateRef.current` 是否存在（`:1055`），存在就往下走。
  2. `await flashNavigationTarget(location)` → `useFoliateAnnotations.ts:434` 对文本书是 `textReaderNavigateRef.current?.(cfi, true); return;` —— **fire-and-forget**，既不 await、也不看返回值。
  3. 回到 `:1060` 无条件 `return true`。
  4. `ReaderXrayCard` 收到 `true` 就调 `onClose()`。
  - EPUB 路径是对的：`await view.goTo(cfi)` 抛错会向上传播，卡片保留。**只有文本书这一条分支破了契约。**
- **证据**：`docs/impls/reader-p3-xray.md` 的「主线接线契约」原文：「主线只在阅读器实际完成跳转（例如 `goTo` / 文本定位并完成闪烁反馈）后返回 `true`；目标不存在、阅读器尚未 ready、跳转抛错或被取消都返回 `false`，不要吞掉成 `void`。」括号里点名了「文本定位」，说明这条分支是被明确要求覆盖的。
- **修复建议**：让 `textReaderNavigateRef` 的回调返回 `boolean | Promise<boolean>`，`flashNavigationTarget` 在文本书分支 await 并透传，`navigateToCurrentXrayOccurrence` 按真实结果返回。
- **缺失测试**：X-Ray 测试里补文本书场景——定位回调返回 `false` 时 `onClose` 不得被调用，卡片保留失败态。

#### #7 P3.2：笔记轨全书索引硬上限 100 条，但表头显示的是真实总数

- **文件与行号**：`src/components/ReaderNotesRail.tsx:125`（`limit: 100`）、`:128`（`setTotal(page.total)`）、`:250`（表头渲染 total）。
- **触发条件**：一本书的笔记超过 100 条，用户使用「全部笔记」搜索。
- **用户影响**：表头显示「128 条」，列表最多只能出现前 100 条中的匹配项，第 101 条之后的笔记**搜不到也无法定位**，而界面上没有任何「结果被截断」的提示。用户会认为笔记丢了。
- **根因链路**：`refresh()` 用固定 `limit: 100` 拉一页，把 `page.total` 存进 `total` 用于显示，但没有分页控件、没有增量加载、也没有「显示前 100 条」的提示。搜索是在这 100 条上做前端过滤。
- **证据**：同一函数内 `limit: 100` 与 `setTotal(page.total)` 并列，两个数字对不上时无 UI 表达。
- **修复建议**：最小改动是把搜索下推到后端查询（带关键词分页），或在 `total > 100` 时于列表底部显示「仅显示最近 100 条，共 N 条」并提供加载更多。不建议为此引入虚拟列表等新依赖。
- **缺失测试**：`total > limit` 时必须渲染截断提示。

#### #8 P3.3：页边释义颜色硬编码，深色主题下对比度失控

- **文件与行号**：`src/components/passive-vocab.ts:211`（`color: "#8a6a45"`）。
- **触发条件**：被动生词样式选「页边释义」+ 深色/夜间阅读主题。
- **用户影响**：释义文字是固定的暖棕色，注入在书籍文档内的内联样式里，不随阅读主题变化。深色底上这个颜色偏暗，可读性差；纸色主题下则是合适的。ruby（词上释义）分支不受影响，它继承主题色。
- **根因链路**：`installMargin` 用一组内联样式定位页边批注，颜色写成字面量而不是主题变量。项目其他阅读器注入样式走的是 `getReaderCSS` / 主题令牌，这一处绕过了。
- **修复建议**：改为从当前阅读主题取色（与 ruby 分支一致），或注入一个 CSS 自定义属性由主题赋值。
- **缺失测试**：无测试覆盖注入样式的主题适配。

#### #9 P3.3：窄窗降级只在设置变化或文档加载时判定，拖窄窗口不会切回 ruby

- **文件与行号**：`src/pages/reader/useFoliateAnnotations.ts:371`（`narrowViewport: window.innerWidth < 760`）；对比 `src/pages/reader/useFoliateView.ts:958-1000`（resize 路径）。
- **触发条件**：宽窗 + 页边释义样式下阅读，然后把窗口拖窄到 760px 以下（不切书、不改设置）。
- **用户影响**：`reader-p3-passive-vocab.md` 要求「Narrow windows automatically render the selected words as ruby annotations, avoiding a rail that would leave too little room for the text」。实际上页边释义轨会一直留着，正文被挤到很窄——正是这条规则要避免的后果。反向也一样：从窄窗拖宽不会自动恢复页边样式。翻页或切换设置后会恢复正确。
- **根因链路**：`narrowViewport` 是在 `applyPassiveVocabAnnotations` **执行的那一刻**读取 `window.innerWidth` 得到的一次性快照。该函数的调用点只有：设置变化的 effect、文档加载、以及 `Reader.tsx` 的注解重载。`useFoliateView.ts` 的 `ResizeObserver` 只调 `applyCurrentLayout()`（重排 + 字号样式表），**不调 `applyPassiveVocabAnnotations`**。所以 resize 不触发重新判定。
- **证据**：`grep applyPassiveVocabAnnotations` 的全部调用点里没有任何一个挂在 resize/ResizeObserver 上；`applyCurrentLayout` 内部只有 `setStyles` 和 `applyReflowLayout`。
- **修复建议**：在既有的 resize 防抖回调里，当 `window.innerWidth < 760` 的布尔值**跨越阈值**时补调一次 `applyPassiveVocabAnnotations()`。务必只在跨阈值时调，否则会在拖拽期间每帧重装注解（该文件已有「拖拽期间跳过昂贵重排」的先例，照此办理）。
- **缺失测试**：无 resize 相关测试；此项在无头环境下也难以证明，属于测试盲区。

### Low

| # | 位置 | 问题 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| L1 | `useFoliateAnnotations.ts:432` vs `:438-439` | `pushJump` 在可行性判断之前执行；`view` 不存在或不支持 CFI 时直接 `return`，跳转没发生但历史已入栈 | 用户按「返回」跳到一个自己从未离开过的位置 | 把 `pushJump` 移到确认可跳转之后 |
| L2 | `ReaderXrayCard.tsx:28` | 模块级 `const safeCache = new Map()` 永不清理，跨书累积 | 长时间会话内存缓慢增长；换书后旧书条目仍在 | 加 LRU 上限或在换书时清空 |
| L3 | `ReaderXrayCard.tsx`、`ReaderNotesRail.tsx`、`ContinuousReadAloudToolbar.tsx` | 未处理 Escape 关闭（`ReaderExportDialog.tsx:138` 和词汇复习都处理了） | 键盘用户无法用统一手势收起 | 与导出弹窗对齐 |
| L4 | `ContinuousReadAloudToolbar.tsx:59`、`ReadingStats.tsx:381` | 原生 `<select>`，未用仓库 `ui/Select` 原语 | 与全局控件观感不统一；深色主题下由系统渲染 | 换成 `ui/Select` |
| L5 | `src-tauri/src/commands/enhanced_fonts.rs`（早退分支 ~`:324-330`；写入失败 ~`:345-353`） | 早退路径不 emit `failed()`；`write_all`/`sync_all` 失败不清理 `incoming` 临时文件 | UI 可能停在「下载中」；磁盘残留 `.partial` | 早退补 `failed()`；写失败走同一条清理路径 |
| L6 | `passive-vocab.ts:157-162` | `railSide` 的 `spread` 参数两个分支返回完全相同的表达式 | 双页展开时页边批注可能落在错误一侧（或该参数本就是死参数） | 确认意图：要么实现 spread 分支，要么删掉参数 |
| L7 | `passive-vocab.ts:200`、`:217` | `occupiedBottom` 垂直堆叠无视口下界钳制 | 同屏生词多时，末几条页边释义堆出可视区，静默不可见 | 超出时截断并合并为「+N」 |
| L8 | `reader-export.ts:88` | `csvCell` 只处理引号转义，未防公式注入（`=`/`+`/`-`/`@` 开头） | 用 Excel 打开导出的 CSV 时，以这些字符开头的笔记会被当公式执行 | 前置 `'` 或 `\t` |
| L9 | `ReaderExportDialog.tsx:114` | 切到 Anki 格式时静默丢弃已选高亮 | 用户以为高亮会一起导出 | 切换时提示或禁用不适用的选择 |
| L10 | `ReaderNotesRail.tsx:216-218` | 删除失败时把错误写进**加载**错误横幅 | 报错文案与实际动作不符，用户以为笔记列表加载坏了 | 用独立的删除失败态 |

---

## 3. 视觉一致性矩阵

标注口径：**一致** = 结构、层级、控件形态与已确认样张相符；**轻微偏差** = 结构一致，缺少样张中的次要元素或装饰；**明显偏差** = 有整块内容缺失或形态改变；**未验证** = 本环境无法取证。

| 项 | 判定 | 官方样张 | 差异（expected → actual） | 影响 | 复现窗口 | 修复方向 |
| --- | --- | --- | --- | --- | --- | --- |
| P2.1 结构化导出 | **明显偏差** | [p21](assets/qa-p2-p3/p21-structured-export-default-headless.png) | 样张在格式选择下方有整块「包含字段」六项勾选区（书名/章节/原文/笔记/释义/时间）→ 实现 `ReaderExportDialog.tsx` 中完全没有该区块，字段集由 `csvHeaders` 固定 | 用户无法裁剪导出字段；Anki 用户拿到 13 列 CSV 需自行删列 | 1440px | 补该区块并让 `serializeCsv`/`serializeMarkdown` 接受字段白名单；或与用户确认降级为「不做字段裁剪」并更新样张 |
| P2.2 语境复习 | **轻微偏差** | [p22](assets/qa-p2-p3/p22-context-review-hints-approved-mockup.png) | 样张有顶部复习进度条、来源行含章节名、底部快捷键提示脚注 → 实现三者均无 | 提示顺序（读音 → 中文句意 → 答案）与定长遮蔽这两条**硬验收项均满足**，缺的是辅助信息 | 1440px | 按需补进度与来源章节 |
| P2.3 排版 | **轻微偏差** | [p23](assets/qa-p2-p3/p23-typography-approved-mockup.png) | 样张是右侧通栏设置面板 → 实现是 `ReaderSettings.tsx:546` 的 `fixed z-50 w-[320px]` 锚定浮层 | 四档段距、语言断词、智能缩进、出版社样式保留**全部落地**；形态是浮层不是通栏 | 1440px | 若坚持通栏需重做容器；建议保留浮层并更新样张 |
| P2.4 每书设置 | **轻微偏差** | [p24](assets/qa-p2-p3/p24-settings-scope-approved-mockup.png) | 同上，浮层 vs 通栏 | **硬验收项全部满足**：搜索固定顶部（`conflicts.length >= 6` 时出现）、列表 `min-h-0 flex-1 overflow-y-auto` 内部滚动、确认区 `shrink-0 border-t` 固定底部、翻页不离开同一面板 | 1440px | 同 P2.3 |
| P2.5 连续朗读 | **轻微偏差** + 见问题 #2 | [p25](assets/qa-p2-p3/p25-continuous-read-aloud-approved-mockup.png) | 样张有中央大号播放键、「语言自动 EN」标签、句子进度下划线 → 实现是等权重的一排小图标 + 原生语速下拉 | 「参与布局不覆盖正文」这条硬要求**满足**（展开条渲染在 `</header>` 之后、在文档流内）；朗读中胶囊可恢复**满足** | 1440px | 补中央播放键与语言标签；语速换 `ui/Select` |
| P3.1 阅读历程 | **一致** | [p31-history](assets/qa-p2-p3/p31-reading-history-approved-mockup.png) | 逐项核对 `ReadingStats.tsx:375-403`：书籍筛选 → 时间范围分段 → 隐私锁图标 → **历程/日历切换在最右**，与样张顺序完全相同；`:269` 默认 `"history"` | — | 1440px | — |
| P3.1 AI 回顾告知 | **一致** | [p31-ai](assets/qa-p2-p3/p31-ai-review-consent-approved-mockup.png) | `ReadingStats.tsx:442-450` 的 provider / data / excludes / billing 四段 + 确认按钮，与样张四段结构一一对应；`aiNotConfigured`/`aiQuotaExceeded`/`aiOffline`/`aiFailed`/`aiCachedNotice` 状态键齐备 | — | 1440px | — |
| P3.1 增强字体 | **一致** | [p31-font](assets/qa-p2-p3/p31-enhanced-font-approved-mockup.png) | 六个状态（未下载/下载中/已启用/关闭后保留/下载失败/移除确认）的 i18n 键与状态机齐备；「只保存在这台设备」说明存在 | 实际下载路径不可验证，见 §7 | 1440px | — |
| P3.2 页边笔记轨 | **轻微偏差** | [p32](assets/qa-p2-p3/p32-notes-rail-approved-mockup.png) | 样张笔记卡有页码 chip、笔记标题、「已保存」标签，「全部笔记」是表头分段控件 → 实现无 chip/标题/已保存标签，「全部笔记」是底部按钮 | 「与正文引用对齐、参与布局、失败保留草稿」三条硬要求**满足**（`:198` catch 里 `writeDraft`）；窄窗降级为底部工作区（`max-[1100px]`，CSS 驱动，随 resize 生效） | 1440px / <1100px | 补 chip 与保存态标签 |
| P3.3 被动生词设置 | **明显偏差** | [p33](assets/qa-p2-p3/p33-passive-vocab-settings-approved-mockup.png) | 样张是独立子页：两张带插图的样式单选卡 + 分段密度控件 + 实时预览区 → 实现 `PassiveVocabSettings.tsx:59-70` 是两行普通 `Select`（`ROW_CONTROL_WIDTH`），无插图、无预览 | 功能验收**全部满足**（同一全局状态、无每书覆盖、窄窗降级存在），但用户选样式时看不到效果，需退出设置到正文里试 | 1440px | 按样张补单选卡与预览；这是本报告两条明显偏差里更值得补的一条 |
| P3.4 人物/术语卡 | **一致** | [p34](assets/qa-p2-p3/p34-xray-spoiler-safe-approved-mockup.png) | 就地浮层卡形态、防剧透范围提示、关系路径、此前出场列表均与样张相符 | 卡片确实是覆盖正文的右下浮层——这是样张确认的设计，不是缺陷 | 1440px | — |
| 窄窗（<1100px）整体 | **未验证** | — | 仅静态读出 CSS 断点，未渲染 | — | — | 见 §7 |
| 深色主题 | **未验证** | — | 仅静态读出主题令牌用法（据此发现问题 #8） | — | — | 见 §7 |

**演示脚手架泄漏检查**：样张顶部的状态/方案切换条、左下角深色说明浮块，在 `ReaderExportDialog.tsx`、`ReadingStats.tsx`、`ReaderNotesRail.tsx`、`ReaderXrayCard.tsx`、`PassiveVocabSettings.tsx`、`ContinuousReadAloudToolbar.tsx` 中均**未出现**。未发现泄漏。

---

## 4. 功能与跨功能矩阵

| 项 | 入口 | 状态齐备 | 持久化 | 同步 | 错误恢复 | 响应式 | 能力边界 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P2.1 导出 | 无边框下载图标 ✅ | 准备中/成功/失败/空 ✅ | 系统保存框（未验证，§7） | n/a | 重试 ✅ | 未验证 | 高亮/生词均可 ✅ |
| P2.2 语境复习 | 词典卡内 ✅ | 提示三级 ✅ | 掌握度写回 ✅ | 走生词同步 | — | 未验证 | 无例句时安全退回单词 ✅ |
| P2.3 排版 | 阅读设置浮层 ✅ | 四档 + `original` ✅ | 全局 + 每书 ✅ | tombstone ✅ | 写失败回滚 ✅ | 未验证 | PDF/固定版式隐藏 ✅ |
| P2.4 设置范围 | 同上 ✅ | 冲突列表/搜索/全选/确认 ✅ | 事务 ✅ | tombstone ✅ | **见问题 #1** ⚠️ | 内部滚动 ✅ | 标记类 key 正确排除在可提升集之外 ✅ |
| P2.5 连续朗读 | 标题栏图标 ✅ | idle/播放/暂停/完成/失败 ✅ | 语速设置 ✅ | n/a | **见问题 #2** ⚠️ | 未验证 | 仅重排 EPUB ✅；自动翻页不污染跳转历史 ✅ |
| P3.1 统计 | 侧栏「阅读历程」✅ | 加载/空/失败/重试 ✅ | 会话+检查点 ✅ | 未验证（§7） | 重算 ✅ | 未验证 | 30s 下限、5min 空闲由后端裁决 ✅ |
| P3.1 AI 回顾 | 用户主动触发 ✅ | 未配置/额度/离线/失败/缓存 ✅ | 缓存 ✅ | n/a | 失败不覆盖旧缓存 ✅ | 未验证 | **白名单通过**（见下） |
| P3.2 笔记轨 | 工具栏 + 选区菜单 ✅ | 加载/空/编辑/保存失败/删除确认 ✅ | 草稿本地保留 ✅ | 走笔记同步 | 保存失败保草稿 ✅；**删除失败横幅错位（L10）** | `max-[1100px]` 降为底部工作区 ✅ | — |
| P3.3 被动生词 | 主设置 + Reader 快捷 ✅ | 开关/样式/密度 ✅ | **仅全局，无每书覆盖** ✅ | 全局设置同步 | 写失败回滚 ✅ | **见问题 #9** ⚠️ | 仅重排 EPUB ✅ |
| P3.4 人物/术语卡 | 选区菜单 + 工具栏 ✅ | 加载/结果/失败/跳转失败 ✅ | 安全范围缓存；整书结果**不入缓存** ✅ | n/a | EPUB 跳转失败保留卡片 ✅；**文本书见问题 #6** ⚠️ | 未验证 | 与侧栏工作区互斥 ✅ |

**跨功能互斥**：`SidePanel = "ai" | "bookmarks" | "vocab" | "notes" | null` 与 `xrayOpen` 互斥成立——X-Ray 按钮的 `onClick` 同时 `setSidePanel(null)`，侧栏 `togglePanel` 亦关闭 X-Ray。未发现两者同屏的路径。

**P3.1 / P3.4 AI 白名单（用户点名要求确认的项）——通过。**

- P3.4 请求体（`src-tauri/src/commands/ai/xray.rs:258-266`）仅含：`selection`、`visibleContext`（≤2000 字符，且是**当前可见**上下文，用户已在看）、`bookTitle`、`bookAuthor`、`chapter`、`scope`、`excerpts`。无笔记、无高亮、无书籍 ID、无完整书单。
- 防剧透边界（`:122-141` `safe_cutoff`）对 EPUB **保守地丢弃整个当前 spine item**，宁可漏掉同文件内的此前出现，也绝不把后文送出去——与 `reader-p3-xray.md` 的裁决一致。
- 整书范围的结果**从不写入安全缓存**（`ReaderXrayCard.tsx:122` `if (!wholeBook) safeCache.set(...)`），关卡即恢复安全范围。
- 提示注入防护到位（`:255`）：系统提示明确要求把用户 JSON 与所有摘录视为**被引用的素材而非指令**。
- 引用来源不信任模型输出：`:294` `response.sources = sources` 用本地检索出的引用**覆盖**模型返回的引用，模型无法伪造出处。
- P3.1 侧的 i18n 键 `aiDisclosureDataValue` / `aiDisclosureExcludesValue` 与样张的「聚合统计 / 阅读节奏 / 一本书名与日期范围 / 不发送正文和私人文字」逐条对应。
- 未发现把正文、笔记、标注原文或未读内容写进请求、日志、缓存键或错误诊断的路径。

---

## 5. 代码优化建议

### 5.1 bug 必修（行为错误，与样式无关）

按优先级：

1. **#1** `restoreBookOverrides` 补 `await flushBookSettings(true)`（与 `promoteBookOverrides` 对齐），并把 await 后读 `bookOverrides` state 的两处改为读 ref。**这条最该先修**——它是唯一会造成跨设备数据不一致的问题。
2. **#6** 文本书导航回调返回真实布尔值并逐层透传，兑现 `reader-p3-xray.md` 白纸黑字的接线契约。
3. **#2** 收起按钮加 `active` 守卫（或组件放宽胶囊分支），消除标题栏破相。
4. **#3 / #4** 统一词边界遮蔽：把 `contextual-review.ts:29-35` 的边界匹配抽成共用函数，同时修掉复习答案泄漏和 Anki 挖空切坏。一处抽取修两个 bug，是性价比最高的一条。
5. **#5** `serializeMarkdown` 入口补稳定排序。
6. **#9** resize 跨阈值时补调 `applyPassiveVocabAnnotations`（务必只在跨阈值时调）。
7. **L1** `pushJump` 移到可行性判断之后。
8. **L5** 增强字体早退路径补 `failed()` 与临时文件清理。

### 5.2 可维护性优化（不改行为）

- **#7 / #8 / L2 / L7 / L8 / L9 / L10**：都是单点修补，无需抽象。
- `railSide`（**L6**）的死参数：先确认意图再动，不要直接删——它可能是未完成的双页支持。
- 原生 `<select>`（**L4**）换 `ui/Select`：两处，纯替换。
- **明确不建议**的事：不要为「统一样式注入」「统一状态机」引入新抽象层或新依赖。本次发现的问题全部可以在现有文件内、用现有模式（`ui/Select`、`getReaderCSS` 主题令牌、`flushBookSettings` 闸、`contextual-review` 边界函数）解决。`Reader.tsx` 确实偏长，但另一个任务正在做 hook 抽取重构（§0），本报告不叠加重构建议，以免与其冲突。

---

## 6. 验证结果（逐条命令）

在 HEAD = `413df55` 重跑全部十条门禁（工作区含他人未提交改动，见 §0）：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx tsc --noEmit` | 0 | 通过，无类型错误 |
| `npm run lint` | 0 | 通过 |
| `npm run test:unit` | 0 | 通过 |
| `npm run build` | 0 | 通过，Vite 生产构建 `✓ built in 6.84s` |
| `npm run check:docs` | **1** | **失败 —— 47 条断链，全部不在 P2/P3 范围内**，根因见下 |
| `npm run check:reader-compat` | 0 | 通过，Safari 15 / PDF.js 兼容报告已生成 |
| `cargo fmt --check` | **1** | **失败 —— 全部 diff 位于 `src-tauri/src/commands/ai/prompt.rs`**，根因见下 |
| `cargo check` | 0 | 通过 |
| `cargo test` | 0 | 通过：733 库测试 + 2 MCP 集成测试，0 失败，11 显式 ignored |
| `cargo clippy -- -D warnings` | 0 | 通过 |

**两条失败的根因（均不属于 P2/P3，且本轮为只读复核，未修复）：**

1. `check:docs` 的 47 条断链分布在两个文件：`docs/impls/ai-router-cc-switch-review.md`（由 §0 中 `44ac4ee` 引入，指向 `src-tauri/src/ai/router.rs` 的行号）和未跟踪的 `docs/roadmap/product-ux-audit-2026-08.md`（指向 `Reader.tsx`、`Home.tsx` 等的行号）。前者的行号在 `ai.rs` 系列拆分后失效，后者的 `Reader.tsx` 行号在 hook 抽取重构后失效。**没有一条断链指向 P2/P3 交付物**。修复方式是那位任务的作者跑 `npm run check:docs -- --fix`。
2. `cargo fmt --check` 的全部 diff 位于 `src-tauri/src/commands/ai/prompt.rs`——这个文件是 `98f9eeb` 拆分 `ai.rs` 时新建的，四个函数签名超过行宽未换行。**该文件不属于 P2/P3 交付物**。

也就是说：**P2/P3 交付面自身在当前 HEAD 上十条门禁全绿**；两条红灯完全由并行进行中的重构造成。我没有为了让报告好看而修改、跳过或放宽任何检查。

---

## 7. 真实外部边界（不得视为通过的部分）

以下内容本环境**确实无法验证**，按要求写成边界而非通过：

1. **真实 Tauri 运行时**：按「不抢占用户前台」的约束，本轮未启动 Tauri GUI。因此**未验证**：系统保存对话框（P2.1）、真实 EPUB/PDF 渲染下的 Foliate 脚注与跨章朗读（P2.5）、键盘焦点在真实窗口中的可达性与 Tab 环、以及所有窄窗实时重排。窄窗结论全部来自静态 CSS 断点读取（`max-[1100px]`、`innerWidth < 760`），**不是**实测。
2. **深色主题**：未做主题渲染取证。问题 #8 是**静态代码推断**（硬编码 `#8a6a45` 不随主题变化），推断本身可靠，但深色下的实际观感未取图。其余组件的深色适配**未验证**。
3. **iCloud 双设备同步**：无第二台设备。问题 #1 的「幽灵覆盖会跨设备传播」是基于 tombstone 清除逻辑的**代码推断**，未做双设备回放实证。P3.1 统计记录的跨设备一致性同样未验证。
4. **生产 AI 服务**：未发起任何计费请求。§4 的白名单结论是**请求构造代码与提示词的静态审查**，可信度高（payload 字段是字面枚举的），但供应商配置错误、额度耗尽、离线超时这三条真实网络回路**未验证**。
5. **增强中文字体包**：仓库内不存在可信 manifest（`LANTERN_ENHANCED_FONT_VERSION/SIZE/SHA256/URL` 未注入），功能正确地报告为「不可用」并保留系统字体。因此**下载进度、SHA-256 校验失败、原子替换、回滚、临时文件清理这些路径全部未做端到端验证**——问题 L5 是代码走查所得，非实测。
6. **具体书籍**：未用真实 EPUB / PDF / TXT 跑通。问题 #6（文本书跳转）与 #9（窄窗降级）都需要真实书籍才能实测，本报告给出的是完整根因链路和代码证据，**不是复现记录**。
7. **HEAD 漂移本身**：`Reader.tsx` 与 `src-tauri/src/commands/ai.rs` 在复核期间被并行任务持续改写，且写报告时仍是 dirty 状态。所有涉及 `Reader.tsx` 的结论都建立在我读到的那一版上；那些重构是结构性搬移，未观察到语义变化，但**我没有为并行任务的正确性背书**。建议这些问题修复前先重新确认 `Reader.tsx` 相关行号。

---

## 8. 未发现问题的部分（明确记录，避免误读为「没查」）

以下方向经追查后**未发现可复现问题**，逐条列出证据，以免下次重复排查：

- **阅读会话重复计时**：15s 心跳 / 60s 检查点 / 5min 空闲 / 30s 下限，检查点 upsert 用 `MAX()` 幂等，后端为权威裁决方。未发现重复累计路径。
- **睡眠唤醒凭空造时长**：时钟跳变被当作空闲处理，不会把休眠时间计入。
- **跨书设置串味**：防抖写入按 `bookId` 分桶，未发现 A 书的待写值落到 B 书。
- **整书 X-Ray 污染安全缓存**：`if (!wholeBook)` 守卫存在，未发现绕过路径。
- **`READER_SETTING_NOT_PROMOTABLE` 错误路径**：曾怀疑标记类 key 会让 `list_reader_setting_conflicts` 硬报错；搜索全部调用者后确认 `reader-settings-scope.ts:47-49` 的 `promotableRows()` 已在调用前过滤掉这四个 key。**该疑点排除。**
- **笔记时间戳单位**：曾怀疑 `updated_at` 是秒导致显示 1970 年；`src-tauri/src/sync/writer.rs:258-259` 的 `next_logical_timestamp()` 用 `timestamp_millis()`，**单位正确，疑点排除**。
- **X-Ray 跳转拒绝未捕获**：`ReaderXrayCard.tsx:179-195` 确实有 `catch { setNavigationError(true) }`，EPUB 路径正确。**只有文本书分支有问题（#6）。**
- **i18n 键漂移**：`en.json` 与 `zh.json` 共 1625 键，**零漂移**，无孤儿键、无缺失键。未发现组件内硬编码英文。
- **P3.3 越权创建每书覆盖**：`passive_vocab_enabled` 走 `invoke("set_setting", ...)`（全局表），不在每书白名单内；主设置与 Reader 快捷入口操作同一份全局状态。**验收项成立。**

### 剩余测试盲区

- 组件在「非法状态组合」下的渲染分支（问题 #2 暴露的正是这一类盲区）——控制器有不变量测试，组件没有对应的防御性测试。
- 异步竞态：没有任何测试模拟「IPC 飞行中触发第二个操作」（问题 #1）。
- resize 行为：零测试（问题 #9）。
- 注入到书籍文档内的样式（ruby / 页边释义 / 朗读高亮）在各阅读主题下的对比度：零测试（问题 #8）。
- 导出序列化的边界输入：超大数据集、取消保存、字段含公式字符、章节乱序（问题 #4、#5、L8）。
