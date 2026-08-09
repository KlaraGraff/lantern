# 自造 vs 成熟方案审查

审查日期：2026-08-08 · 版本：v2.13.1 · 只读审查，未改动任何代码

**审查范围：** `src/`、`src-tauri/src/`、`scripts/`、`harness/`
**排除：** `public/foliate-js/`（vendored 第三方）、`node_modules/`、`src-tauri/target/`、`dist/`、`src-tauri/migrations/`

**方法：** 六个子代理按领域分头取证（Rust AI 层 / Rust 基础设施与 sync / Rust commands SQL 与日期 / Rust commands+mcp 基础设施 / 前端 hooks+pages / 前端 components / scripts+harness），全部结论在主会话逐条复核。报告中每条结论都带 `file:line` 或 commit 哈希。

---

## 总体判断

这个代码库在通用能力上**比预期克制得多**。进去之前假设会找到一堆手写的 HTTP 重试引擎、手搓的日期库、自制的状态管理——都没有。reqwest、chrono、whatlang、pinyin、sqlite-vec、fsrs、csv、fs2、ulid、esbuild、postcss、TypeScript 编译器 API、Node 内置 test runner、`Intl.*`、`approx-string-match`、`@dnd-kit`、react-markdown 都在被正确使用。

更值得注意的是：**大多数手写点旁边都有注释写明了为什么不引库**，而且理由经得起推敲（`i18n/emphasis.ts:11-13` 拒绝 `<Trans>`、`icloud/cellular.rs` 拒绝 `system-configuration`、`lifecycle.rs` 拒绝 `tokio-util::CancellationToken`、`grounding/chunk.rs` 拒绝真 tokenizer、两个 CDP 脚本都写了「不引入 puppeteer」）。这不是失控，是有意识的取舍。

所以这份报告里「建议替换」的条目不多，共 5 条，而且其中**收益最大的两条都不需要引入任何新依赖**。

---

## 一页总览

| 能力 | 现状 | 结论 | 迁移成本 |
|---|---|---|---|
| **数据层** | | | |
| SQL 行→结构体位置索引映射（703 处 `row.get(N)`） | ② 自造，有成熟方案 | **换**（rusqlite 自带具名列，无新依赖） | S |
| 动态 WHERE/参数并行数组（3 处） | ② 自造，有成熟方案 | 不换（先补测试） | — |
| SQL 注入面 | ① 已用成熟方案（全部绑定参数） | 不换 | — |
| 迁移执行器 `db.rs:444` | ② 自造，有成熟方案 | 不换（测试厚，2 次旧 bug 已修） | M |
| 事务纪律 / `busy_timeout` | ① 已用成熟方案（rusqlite 默认 5s） | 不换 | — |
| 本地日/时区/连续天数 `reading_stats.rs:437` | ① 已用成熟方案（chrono，有边界测试） | 不换 | — |
| `DAY_MS` 常量重复 7 次 | ④ 自造更合适 | 不换（就地合并，不引库） | S |
| 间隔重复调度 | ① 已用成熟方案（fsrs crate） | 不换 | — |
| **文件与进程** | | | |
| 临时文件+改名的原子写（5+ 处） | ② 自造，有成熟方案 | **换**（tempfile 已在 dev-deps） | S |
| 压缩包路径穿越防护 `ocr/package.rs:1088` | ③ 自造，无合适方案 | 不换（测试充分） | — |
| 子进程等待轮询（2 处） | ② 自造，有成熟方案 | 观察（tokio process feature） | S |
| 手写 CancellationToken `ocr/backend.rs:97` | ② 自造，有成熟方案 | 观察（tokio-util 已在 Cargo.lock） | S |
| OCR 单工位任务队列 | ④ 自造更合适 | 不换 | — |
| **AI 与网络** | | | |
| OAuth 回环 HTTP 服务器 `oauth.rs:122` | ② 自造，有成熟方案 | **观察**（有测试，已知 bug 已修） | M |
| SSE 增量解码器 `sse.rs:7` | ④ 自造更合适 | 不换（0 bug，3 个好测试） | — |
| provider 错误分类 `router.rs:130` | ③ 自造，无合适方案 | 不换 | — |
| 取消登记表 `router.rs:312` | ④ 自造更合适 | 不换 | — |
| token 估算 `chunk.rs:22` | ④ 自造更合适 | 不换（多 provider，真 tokenizer 是假精度） | — |
| 句子切分 `chunk.rs:63` | ② 自造，有成熟方案 | **观察**（先补测试再评估 CJK） | S |
| LLM 回复里捞 JSON（3 份独立实现） | ③ 自造，无合适方案 | 不换（但应合并成一份） | S |
| 并发限流 / 语言检测 / 向量检索 / PKCE | ① 已用成熟方案 | 不换 | — |
| **前端** | | | |
| 焦点陷阱 + Esc + 焦点归还（9 份实现） | ② 自造，有成熟方案 | **换** | S→M |
| 弹层视口夹取定位（6 份实现） | ② 自造，有成熟方案 | **换**（floating-ui） | M |
| 颜色 hex/对比度数学（4-5 处重复） | ② 自造，有成熟方案 | 不换（就地合并） | S |
| 手写 debounce（5 处） | ④ 自造更合适 | 不换 | — |
| 设置批量写入+合并+重试 `useReaderSettingsSync.ts:412` | ④ 自造更合适 | 不换（bug 已被测试覆盖） | — |
| 抽屉手势状态机 `useDrawerGesture.ts` | ④ 自造更合适 | 不换（测试完整） | — |
| 流式 markdown 尾部修补 / CFI 区间代数 / 可改键位 | ③ 自造，无合适方案 | 不换 | — |
| 日期数字格式化 / 拖拽排序 / markdown 渲染 | ① 已用成熟方案 | 不换 | — |
| **同步层** | | | |
| LWW 合并 + 墓碑级联（~2000 行） | ④ 自造更合适 | 不换（CRDT 库换不掉） | L |
| iCloud 超时/停滞退避 | ③ 自造，无合适方案 | 不换 | — |
| JSONL 事件日志分帧 | ③ 自造，无合适方案 | 不换 | — |
| 快照压实原子写 | ③ 自造，无合适方案 | 不换 | — |
| 文件监视去抖 `sync/watcher.rs:150` | ② 自造，有成熟方案 | 观察（notify-debouncer-mini，同一维护方） | S |
| 跨进程文件锁 / SHA-256 / ULID | ① 已用成熟方案 | 不换 | — |
| **脚本与构建** | | | |
| 手写 CDP 客户端 + 浏览器进程管理（2 处） | ② 自造，有成熟方案 | **观察**（Playwright，但仅 CI 用） | M |
| markdown 链接提取正则 `check-doc-links.mjs:16` | ② 自造，有成熟方案 | 不换（0 bug，构建期失败很响） | — |
| CLI 参数解析（5 个脚本） | ④ 自造更合适 | 不换 | — |
| esbuild / postcss / TS API / argparse / node:test | ① 已用成熟方案 | 不换 | — |
| 嵌入 CPython 的原生启动器 | ③ 自造，无合适方案 | 不换 | — |

---

## 建议替换（5 条）

### 1. SQL 行映射改用具名列 —— 不引入任何依赖

**位置：** `src-tauri/src/commands/books/query.rs:238`（以及 `:289`、`:386` 两处重复），最严重的一处；全范围内 `row.get(` 共 **703 处**，`row_to_*` 函数 15 个，散布在 `notes.rs`、`lookup_history.rs`、`explanations.rs`、`vocab.rs`、`fonts.rs`、`annotations.rs`、`language_assessments.rs`、`chats.rs`、`word_marks.rs`、`ocr/assets.rs`、`ocr/jobs.rs`。

**代码量：** 单个最宽的映射 24 列（`ocr/jobs.rs:112`）；`books/query.rs` 22 列 × 3 份重复。

**问题已经发生了，不是假设。** `books/query.rs:238` 的结构体字段读取顺序是：

```rust
conversion_version: row.get::<_, Option<i32>>(11)?...,
preparation_state: row.get(20)?,
preparation_error: row.get(21)?,
genre: row.get(12)?,
```

索引从 11 跳到 20、21，再跳回 12。这是 `preparation_state` / `preparation_error` 两列后加到表尾、`SELECT` 列表追加在末尾、而结构体字段插在中间留下的痕迹。**它今天是对的，靠的是三处重复代码被手工改一致——编译器一点保护都没有。**

**现有测试：** 没有任何测试校验列索引与列名的对应关系。`books/tests.rs:1305-1411` 测的是分页行为。真正危险的是两个同为 `TEXT` 存储类的列互换——类型系统和现有测试都不会报错。

**咬人历史：** 没有找到确凿的「列错位」修复提交。前身 `books.rs` 有 32 次提交，其中 `2158dea fix(vocab): persist in-context analysis as its own column (#214) (#219)` 是列形状相关，但不能确认是位置读取 bug。**所以这条的依据是结构性风险，不是既往事故** —— 但结构性前提已经具备（顺序已漂移）。

**推荐方案：** 不引入任何新 crate。rusqlite 的 `Row::get` 签名是 `get<T: FromSql>(idx: impl RowIndex)`，而 `&str` 已实现 `RowIndex`——直接把 `row.get(0)` 改成 `row.get("id")` 即可，按列名匹配，位置脆弱性整类消失。

**备选：** `serde_rusqlite`（0.35）可以 `#[derive(Deserialize)]` 全自动映射，但该 crate 下载量低、最近发布约在 2024 年，维护信号弱。**不确定——需要验证它对 rusqlite 0.31 的版本兼容性和当前维护状态。** 鉴于具名列已经能解决全部问题且零依赖，不建议为此引库。

**迁移要点：** 纯机械替换，逐文件进行。`books/query.rs` 的三份重复闭包是最高价值起点——那里顺序已经乱了。改完后三份重复本身也应该合并成一个函数。

**风险：** 极低。编译期就能发现列名拼写错误（运行期返回 `Error::InvalidColumnName`，比静默读错列好得多）。不改 schema，不动 ORM，不违反任何硬约束。

**迁移成本：S**

---

### 2. 原子写改用 `tempfile` —— 依赖已经在仓库里

**位置：**
- `src-tauri/src/commands/enhanced_fonts.rs:173`、`:195`、`:321`、`:472`（四处独立的 `.partial` / `.backup` 临时名构造）
- `src-tauri/src/commands/fonts.rs:190`、`:344`、`:376`
- `src-tauri/src/commands/speech.rs:710`
- `src-tauri/src/commands/ocr/package.rs:808` 附近（`install_verified_archive` / `activate_runtime`）

全代码库 `fs::rename` 共 **30 处**。

**代码量：** 三份主要实现合计约 200 行，每份都手工拼 `.{name}.{uuid}.partial` 临时名、写入、`fs::rename`、失败时手动回滚。

**现有测试：** `enhanced_fonts.rs` 有 `#[cfg(test)]` 模块；`ocr/package.rs` 有 12 个测试函数；`speech.rs:1084` 有一条断言「不能留下 `.partial` 残骸」。覆盖不错。

**咬人历史：** `0c34177 fix(fonts): always report a failed download, and leave no half-written file` —— 91 行新增、16 行删除，全在 `enhanced_fonts.rs`。**这正是手写临时文件管理会产生的那类 bug。** 另有 `2a57e04 fix(ocr): harden runtime staging and archives`。

**推荐方案：** `tempfile = "3"` **已经在 `Cargo.toml:136` 的 `[dev-dependencies]` 里**，但生产代码一行没用（20 处 `tempfile::` 全在 `#[cfg(test)]` 中）。把它提升为常规依赖，用 `NamedTempFile::persist()` 替换手工临时名+改名。零新增供应链风险。

**一个必须说清的边界：** 库只解决临时文件命名和清理这一半，**不解决 fsync 纪律**。现状是不一致的——`enhanced_fonts.rs:386`、`ocr/package.rs:775`、`books/text_prepare.rs:179`、`sync/log.rs:370` 会 `sync_all()`，而 `fonts.rs:190`、`speech.rs:711` 不会。`NamedTempFile::persist()` 默认同样不 fsync。所以这条的完整做法是：换成 tempfile 的同时，明确每个写入点要不要 fsync（`sync/snapshot/compact.rs:20` 已经把「temp → fsync → rename → 父目录 fsync」这套写对了，可以作为样板）。字体包和 OCR 运行时是可重新下载的，speech 缓存也是——所以真正需要完整 fsync 的可能只有少数几处，但这需要逐点决定，而不是继续保持现在这种「有的写有的不写」的随机状态。

**迁移要点：** 需要改 `Cargo.toml`（把 `tempfile` 移出或复制到 `[dependencies]`）。本次审查是只读的，未执行。

**风险：** 低。`NamedTempFile::persist` 跨平台成熟，Windows 可用，无原生依赖。

**迁移成本：S**

---

### 3. 焦点陷阱合并 —— 9 份实现，0 个测试，已经漂移出 5 种选择器

**位置：**

| 文件 | 行 | 陷阱逻辑行数 |
|---|---|---|
| `src/components/SettingsModal.tsx` | `:35`, `:223-276` | ~70（外加 `:278-288` 第二层嵌套陷阱） |
| `src/components/ui/BottomSheet.tsx` | `:15-76` | ~62 |
| `src/components/McpApprovalDialog.tsx` | `:32`, `:126` 附近 | ~114 |
| `src/components/settings/ConfirmDialog.tsx` | `:18-69` | ~49 |
| `src/components/onboarding/OnboardingCard.tsx` | `:24`, `:153-180` | ~157 |
| `src/components/DictionaryContent.tsx` | `:596-604` | ~18 |
| `src/components/learning-card/LearningCardController.tsx` | `:383`, `:393` | ~25 |
| `src/components/settings/DensityHelpDialog.tsx` | `:27-53` | ~30 |
| `src/components/ReaderExportDialog.tsx` | `:191-197` | ~17 |

合计 **9 份实现、约 540 行**。

**漂移已经发生（主会话逐行复核过）：**
- 前五个文件的 `FOCUSABLE_SELECTOR` 常量逐字符相同——纯复制粘贴
- `DensityHelpDialog.tsx:27` 初始聚焦只查 `button`，而两行之后 `:39` 的 Tab 循环用的是含 `[href]`/`input`/`select`/`textarea` 的完整选择器——**同一个文件内部就不自洽**
- `LearningCardController.tsx:383` 用 `button,[href],textarea,input,select,...`（不带 `:not(:disabled)`），`:393` 又用带 `:not(:disabled)` 的版本
- `ReaderExportDialog.tsx:191` 和 `DictionaryContent.tsx:596` 各自内联了缺 `select` / `[href]` 的第三种变体

**现有测试：** **零。** `tests/` 全库搜 `dialog|modal|focus|bottomsheet|mcp-approval|onboarding-card|confirm-dialog` 无命中。

**咬人历史：** 没有找到主题明确指向焦点/Tab/Esc 的修复提交（`SettingsModal.tsx` 29 次提交，`OnboardingCard.tsx` 3 次，其余各 1 次，基本都是功能提交）。**这条不是靠事故史立案的，是靠「9 份 × 0 测试 × 已漂移」这个组合。** 出错代价是键盘可达性和无障碍，不涉及数据完整性——但它是 9 处同时退化，且没有任何测试会发现。

**推荐方案：分两步，第一步不引依赖。**

第一步（S）：把 9 份合并成一个 `useFocusTrap` hook 或 `<FocusTrap>` 包装。这一步就消灭了 5 路选择器漂移，不新增任何依赖，并且给了一个可以写测试的单点。

第二步（可选，S）：在这一个点上换成 `tabbable`（6.5.0，约 7 周前发布）。它按规范处理 `contenteditable`、`summary`/`details`、shadow DOM、祖先 `display:none` 等手写选择器覆盖不到的情况。不改 JSX、不改 DOM 结构、不碰 Tailwind class。
**不确定——需要验证 `tabbable` 的实际 gzip 体积**（npm 上 427KB 的 unpacked 数字含 source map 和类型声明，运行时远小于此）。

**不推荐** `@radix-ui/react-dialog`（1.1.23）作为第一步：它会连带接管 portal、scroll lock、`aria-modal` 装配，收益更大但改动面也大得多，而且要引入 `@radix-ui/react-focus-scope`、`-dismissable-layer`、`-portal` 三个 peer。等第一步做完、单点收敛之后再评估更合适。

**风险：** 三个候选都不联网、不自带 CSS、不自带英文文案（标题正文仍在应用自己的 JSX 里，i18n 不受影响）。Tailwind 4 兼容。

**迁移成本：S（合并）→ M（含引库与补测试）**

---

### 4. 弹层定位换 floating-ui

**位置：**

| 文件 | 行 | 行数 | 行为 |
|---|---|---|---|
| `src/components/ExplainPopover.tsx` | `:314-336` | ~23 | `ResizeObserver` 驱动、随流式内容增长重新夹取 |
| `src/components/FootnotePopover.tsx` | `:62-79` 附近 | ~18 | 注释写明「照抄 ExplainPopover」 |
| `src/components/TranslationPopover.tsx` | `:206-225` 附近 | ~20 | 同一套 `ResizeObserver` 夹取 |
| `src/components/ui/OptionMenu.tsx` | `:121-138` | ~18 | 上下翻转 + `maxHeight` 夹取，portal 到 body |
| `src/components/ReaderContextMenu.tsx` | `:142-161` 附近 | ~20 | 左右 + 上下双向翻转 |
| `src/components/BookContextMenu.tsx` | `:93-105`, `:142-156` | ~64 | **同一文件内两份独立夹取数学**（主菜单 + 子菜单） |

合计 6 个文件、约 163 行，全代码库 `window.innerWidth` / `innerHeight` 引用 28 处。

**现有测试：** **零。** `tests/` 搜 `popover|context-menu|option-menu|explain|translation|footnote` 无命中。

**咬人历史：** `TranslationPopover.tsx` 共 25 次提交，其中：
- `2a0b907 fix: re-clamp lookup popover position as content streams in (#75) (#85)` —— 流式内容变高后没重新夹取，弹层跑出视口
- `9c5523b fix: render markdown in lookup popover (#156) (#157)`

第一条正是 floating-ui 的 `autoUpdate` 从结构上消除的那类 bug：不需要每个组件自己记得挂 `ResizeObserver`。

**推荐方案：** `@floating-ui/dom` 1.8.0（约一个月前发布），`flip()` + `shift()` + `autoUpdate()` 直接覆盖上述全部 6 处夹取/翻转逻辑，含三个弹层的 `ResizeObserver` 重夹取和 `BookContextMenu` 的子菜单套子菜单。若偏好 React 绑定则用 `@floating-ui/react-dom`。纯 DOM 矩形数学，不依赖任何平台 API，无 CDN、无自带 CSS、无自带文案。
**不确定——需要验证确切 gzip 体积**（unpacked 174KB 含类型和多种打包格式；它明确设计为可 tree-shake，Radix、Headless UI、Material 底层都用它）。

**迁移要点：** **先改 `OptionMenu.tsx`** —— 它是 `Select` 和 `ComboField` 共用的底层原语，一处迁移就修好全应用所有设置下拉框的定位。之后再逐个迁移三个弹层和两个上下文菜单。

**出错代价说明：** 这一条只影响显示，不影响数据。之所以仍列为「换」，是因为它有 2 次真实事故史、0 测试覆盖、6 份重复，而候选库恰好是这个问题的行业标准答案且能结构性消除该 bug 类。

**迁移成本：M**

---

### 5. 句子切分 —— 先补测试，再决定换不换

**位置：** `src-tauri/src/ai/grounding/chunk.rs:63-89`（`sentence_split`），27 行。

**做什么：** 扫描字符，在 `。．.!?！？` 之后接空白或字符串结尾处切分。**不处理缩写**（`Mr.`、`e.g.`、`Dr.`）、小数点、省略号、引号内的句末标点。

**两个调用点，代价不同：**
- `chunk.rs:91` `split_oversized_block` —— 超长块进索引前按句子边界切开。切错只影响检索质量。
- `quotes.rs:520` `sentences_containing` —— **给读者引用一个包含目标生词的完整句子。这是产品可见的。** 在 "Mr. Darcy" 处误切，读者看到的就是一句被截断的、莫名其妙的例句。

**现有测试：** 只有间接覆盖。`chunk.rs:210` `splits_oversized_blocks_at_sentence_boundaries` 是通过 `chunk_sections` 间接走到的；**`sentence_split` 本身没有单元测试，全代码库没有任何测试喂给它一个缩写样本**（`"Mr. Darcy arrived."`）验证它不会过度切分。

**咬人历史：** 0。`chunk.rs` 共 2 次提交（`806abb4`、`cf202c0`），都不是修 bug。

**为什么结论是「观察」而不是「换」：** 候选是 `unicode-segmentation` 的 `unicode_sentences()`（UAX #29 句边界规则，与 ICU 同源）。但 **UAX #29 的句边界规则历史上以拉丁文标点为主要设计目标**，而这个函数是为一个中英双语阅读应用写的，把 `。！？` 当作一等终止符。
**不确定——需要验证 `unicode_sentences()` 对中文标点的实际切分行为是否优于现状。** 不能假设「更成熟 = 更适合」。

**正确的下一步不是换库，是先写缺失的测试：** 用缩写、小数、省略号、中英混排各造几条样本喂给 `sentence_split`。这批测试无论最后换不换都需要——换库时它们就是回归基准，不换时它们暴露现有缺口。写完测试再拿 `unicode_sentences()` 跑同一批样本对比，用数据决定。

**迁移成本：S（补测试）；换库与否待测试结果**

---

## 建议观察（各一句话）

- **OAuth 回环 HTTP 服务器** `ai/oauth.rs:122-241`，约 120 行手写 HTTP/1.1（读到 `\r\n\r\n`、手拆请求行、手拼响应字符串）。有 2 个测试直接驱动 raw socket 路径（`:579`、`:601`），且唯一一次真实事故 `9e018c2 fix(security): address audit findings`（4KB 定长缓冲无读循环导致静默截断 + 单次 accept 被野连接吃掉就死锁）已经修完。`tiny_http` 是更好的形态，但既然有测试兜着、已知 bug 已闭合，等下次要动这块时再换。
- **文件监视去抖** `sync/watcher.rs:150-224`，约 75 行。`notify-debouncer-mini` 与 `notify` 6 同一维护方（notify-rs），去抖算法本身 0 次 bug（两次 `fix:` 都在外围接线：`e5d69a9` 锁纪律、`38b65c0` 启停时序）。零沉没成本，可换可不换。
- **手写 CancellationToken** `commands/ocr/backend.rs:97-112`，15 行。`tokio-util` 0.7 已在 `Cargo.lock`（传递依赖），`CancellationToken` 是免费替换且多送分层子 token。当前代码正确且在调用点被覆盖，不急。
- **子进程等待轮询** `books/convert_prepare.rs:70-116`（200ms 轮询 + 两个排空线程）。tokio 已在依赖里但没开 `process` feature，加一行 feature 即可用 `tokio::process` + `tokio::time::timeout` 消掉轮询。`ocr/backend.rs:256-330` 那份不要动——它交织了 JSONL 事件流解析和进程树终止，换不干净。
- **CDP 浏览器驱动** `scripts/smoke-ci.mjs:161-260`（手写 JSON-RPC over WebSocket）和 `scripts/shoot-readme.mjs:98-200`，合计约 450 行进程与协议管道。有 2 次真实事故，其中 `37242a6 fix(smoke): don't let profile cleanup mask the sweep result` 尤其糟——`SIGKILL` 非同步，`finally` 里的 `rmSync` 撞上还在刷盘的 profile 目录抛 `ENOTEMPTY`，**把一次通过的结果替换成了假的崩溃报告**，正好击穿了 CI 门禁存在的意义。Playwright 1.62.1 能一次解决进程生命周期、有界超时、就绪等待，还能删掉 Chrome 路径探测。**但**：这是仅 CI 用的代码，不进产物，失败很响；两个文件都写明了「不引入 puppeteer」是刻意选择；且这个仓库的 devDependencies 一直刻意保持在 10 个。这条留给产品判断，不由技术侧单方面决定。

## 建议保留（各一句话）

- **SSE 增量解码器** `ai/sse.rs:7-74` —— 0 次 bug，3 个测试覆盖了最难的一类（UTF-8 码点跨 chunk 边界断裂），换库纯属折腾。
- **provider 错误分类** `ai/router.rs:130-290` —— 「OpenAI 的 `insufficient_quota` 走 429」「Anthropic 的 529 `overloaded_error` 归 5xx 类」这种知识没有任何库能编码。
- **取消登记表** `ai/router.rs:312-414` —— 底层已经是 `tokio::sync::watch`，换 `CancellationToken` 只换掉原语，换不掉按 request_id 索引和「注册间隙到达的取消」这两个真正的复杂度。
- **token 估算** `grounding/chunk.rs:22-31` —— 同一会话里路由到 Anthropic / OpenAI / DeepSeek / Ollama / 任意兼容端点，没有哪个真 tokenizer 对所有这些都对；计费相关的真值已经存了各家自报的 `usage`。
- **CJK 双字 FTS 增强** `grounding/segment.rs` —— 故意比真分词器简单，目的只是喂给 SQLite `unicode61` 它自己组不出的词元，上 `jieba-rs` 要背一整套词典。
- **LWW 合并 + 墓碑级联** `sync/merge.rs`、`sync/snapshot/apply.rs`，约 2000 行 —— 换 automerge/yrs 意味着把 20+ 张 SQLite 表映射进它的文档模型（丢掉 SQL 层的父级/WHERE 门控写入），或者在 SQLite 旁边再挂一个影子存储。有 `snapshot_equivalence_events_vs_snapshot_yields_same_state`（`snapshot/tests.rs:1674`）守着两条 apply 路径的等价性。
- **iCloud 超时/停滞退避** `sync/log.rs:225`、`snapshot/compact.rs:48`、`replay.rs:79` —— 核心难点是底层阻塞 `fs::read` / `NSFileCoordinator` 读**不可取消**，通用退避库解决不了这个。
- **JSONL 事件日志分帧** `sync/log.rs:42-346` —— 行分隔 JSON 是刻意选的：在 iCloud 目录里可 diff，崩溃中途追加只会撕裂尾行。
- **快照压实原子写** `sync/snapshot/compact.rs:28` —— 「temp → fsync → rename → 父目录 fsync」这套已经写对了，是本仓库原子写的正确样板。
- **pdfium 互斥包装** `pdfium.rs:33-101` —— 补的是上游缺陷（`pdfium-render` 0.9 的 `thread_safe` feature `unsafe impl` 了 Send/Sync 却没有真同步），`767c0ed` 是一次真实的双 PDF 会话崩溃。
- **`SuspensionGate`** `lifecycle.rs:50-158` —— 挡 iOS 不可捕获的 `0xdead10cc`，注释里已写明评估并排除了 `tokio-util`：`permit()` 是从 `NSNotificationCenter` block 里同步调的，那里没有 async 执行器。
- **链式 panic hook** `panic_hook.rs:14-24`，11 行 —— `human-panic` 会替换而非链接 hook，破坏 macOS CrashReporter 的 `.ips` 生成；`sentry` 直接违反离线约束。
- **`SCNetworkReachability` FFI** `icloud/cellular.rs:127-188` —— 模块注释已写明评估并排除了 `system-configuration` / `objc2-system-configuration`（仅 macOS，无 iOS 支持）。
- **压缩包路径穿越防护** `ocr/package.rs:1088`、`:1512` —— 手写但测试扎实，`:1590-1712` 有 `../escape` 和 `safe/../../escape` 的显式用例断言 `OCR_PACKAGE_ARCHIVE_ESCAPE`。
- **迁移执行器** `db.rs:444-501` —— 测试厚（`:787`、`:826`、`:856` 加 009/011/020/032 各自的回归测试），2 次历史 bug 都是外围 FK pragma 协调（`a471a52`、`aa4007a`），已修。
- **MCP 工具参数校验** `mcp/tools/*.rs` —— 14 个工具文件全部用 `schemars::JsonSchema` derive，这就是 `rmcp` 的惯用法，没有手写守卫。
- **MCP 审批状态机** `mcp/approval.rs:17-73` —— 以 SQLite 事务为真值来源，11 个测试，无 bug 史；内存态状态机库反而还要自己解决并发 MCP 调用的竞态。
- **词典内存缓存** `commands/dictionary.rs:53-155` —— 「到顶就清空」而非 LRU 是有注释说明的取舍（上限只约束一个会话，重建成本是每个真正被回看的词一次请求），别往这儿推 LRU 库。
- **抽屉手势状态机** `hooks/useDrawerGesture.ts`，297 行 —— `tests/drawer-gesture.test.ts` + `tests/mobile-home-drawer.test.ts` 双覆盖，0 次 bug，常数是对着参照产品调出来的，且刻意用 `useSyncExternalStore` + ref 避免拖拽期间 React 重渲染。
- **设置批量写入** `pages/reader/useReaderSettingsSync.ts:412-522` —— 历史上的两次真实竞态（`e393438`、`f84c116`）都是队列合并与 flush 时序问题，不是去抖时序问题；现已被 `tests/reader-settings-restore-race.test.ts` 和 `tests/reader-settings-merge.test.ts` 覆盖，换去抖库一行都修不到。
- **手写 debounce（6 处）** `Home.tsx:271`/`:366`/`:391`、`useReaderZoom.ts:74`、`useWindowFramePersistence.ts:47`/`:58` —— 每处 5 行同一惯用法，为此引 `use-debounce` 得不偿失；值得做的是就地抽一个内部 helper。
- **i18n 句中强调** `i18n/emphasis.ts`，41 行 —— 注释 `:11-13` 已经点名 `<Trans>` 并给了拒绝理由（全仓库没用过它，为几句话引入「翻译里带 HTML」的约定比一个 split 函数承诺更大）。
- **颜色数学** `reader-settings.ts:310-348`、`mark-palette.ts:270` —— WCAG 对比度公式和 alpha 通道十六进制（后者在 4 个文件里各写一遍：`mark-palette.ts:277`、`marker-style.ts:172`/`:190`、`MarkerStyleSettings.tsx:56`）。0 次 bug，代价只是显示。该做的是合并成一个内部 helper，不是引 `culori`/`color2k`。
- **`DAY_MS` 常量 × 7** `level_observation.rs:38`、`book_difficulty.rs:623`、`vocab.rs:133`、`vocab_learning.rs:26`、`profile.rs:53`、`review_piles.rs:19`、`ai/lookup.rs:190` —— 两种写法（`86_400_000` 与 `24*60*60*1000`）。全都是滚动 N×24h 窗口，不是日历日边界，所以不是正确性 bug；合并成一处常量即可，不需要库。
- **流式 markdown 尾部修补** `ai-markdown/streaming-tail.ts`，69 行 —— 处理的是本仓库自创的 markdown 方言（`[!WARN]` 告警标记、`lantern-citation:` / `lantern-quote:` 链接协议），换通用流式渲染器仍然要把这一遍补丁焊上去。
- **CFI 区间代数** `components/highlight-ranges.ts`，422 行 —— EPUB CFI 区间的合并/重叠/裁剪，与 vendored foliate-js 的 `epubcfi` 模块强耦合，npm 上没有对应模型。
- **可改键位** `components/reader-bindings.ts`，267 行 —— 通用热键库解决的是「把回调绑到组合键」，这里的问题是「让用户在设置界面里改键，同时拒绝他抢走 ⌘C」。
- **本地日/时区** `reading_stats.rs:437-477` —— 用 `chrono::FixedOffset`/`NaiveDate`/`from_local_datetime` 正确实现，且被 `vocab_learning.rs` 复用而非重写，跨本地午夜的边界用例有专门测试（`:1309`、`:1360`）。
- **纯文本章节标题探测** `books/text_headings.rs`，914 行 —— 英文序数词 + 中文数字 + 列表项启发式，没有任何库做「猜任意 txt 文件里的章节标题」。
- **嵌入 CPython 的原生启动器** `scripts/ocr-runtime/launcher/lantern_ocr.c` —— 自解析可执行文件路径以定位可重定位运行时，含匹配 MSVCRT 转义规则的 Windows 参数引用；这是不可约的项目专属系统代码。
- **CLI 参数解析（5 个脚本）** —— 每个脚本 1-2 个 flag、3-6 行，换 `node:util.parseArgs` 是净增代码。
- **markdown 链接提取** `scripts/check-doc-links.mjs:16-30`、`:95` —— 0 次事故，仅构建期检查，失败很响；`remark-parse` 更严谨但 ROI 为负。
- **`node:test` 测试栈** `tests/*.test.ts`（110 个文件）—— 用 Node 内置 runner + `node:assert/strict`，没有自制断言/mock/快照机制，这是对的。

---

## 已排除的两条（子代理提出，主会话证伪）

审查过程中有两条结论被子代理提出但经复核不成立，记录在此以免后续重复调查：

1. **「全代码库没有设置 `busy_timeout`，WAL 下多进程写冲突无退让」** —— 不成立。`db.rs` 确实没有显式调用（`init_split` / `open_readonly` / `open_readwrite` 均无），但 **rusqlite 0.31 在建立连接时默认就调了 `sqlite3_busy_timeout(db, 5000)`**（`~/.cargo/registry/src/*/rusqlite-0.31.0/src/inner_connection.rs:121`）。所以默认已有 5 秒退让。`mcp/control.rs:585` 和 `mcp/approval.rs:381` 的显式设置是冗余但无害。

2. **「`db.rs::reclaim_free_pages` 有真实 bug 史却零测试覆盖」** —— 不成立。bug 史属实（`eda16c8 fix(db): give deleted books their disk space back`，原实现用 `execute_batch` 只步进一次 pragma，425 个游离页里只回收了 1 个还报告成功），但**修复提交当时就补了测试**——`commands/books/tests.rs:1636` 的 `delete_book_returns_its_pages_to_the_file`，断言 `PRAGMA freelist_count == 0`。子代理只在 `db.rs` 自己的 `#[cfg(test)]` 模块里搜索，所以没找到。

---

## 优先级清单（按 出错代价 × 咬人历史 排序）

| # | 项 | 出错代价 | 咬人历史 | 测试 | 成本 | 结论 |
|---|---|---|---|---|---|---|
| 1 | SQL 行映射改具名列 `books/query.rs:238` | **数据正确性**——两个 TEXT 列互换不会被任何测试或类型系统发现 | 无确凿事故，但**顺序已漂移**（11→20→21→12），三份重复靠手工保持一致 | 无索引校验测试 | **S** | 换（零依赖） |
| 2 | 原子写改 `tempfile` `enhanced_fonts.rs:173` 等 5+ 处 | **数据完整性**——半截文件落盘 | **1 次真实事故** `0c34177`（91 行修复） | 有 | **S** | 换（依赖已在 dev-deps） |
| 3 | 焦点陷阱合并 9 份 | 键盘可达性/无障碍，9 处同时退化 | 0 次事故，但**已漂移出 5 种选择器**，`DensityHelpDialog` 文件内部就不自洽 | **0** | **S**→M | 换（先合并，后引库） |
| 4 | OAuth 回环 HTTP 服务器 `oauth.rs:122` | **凭据/登录链路** | **1 次真实事故** `9e018c2`（静默截断 + 单次 accept 死锁），已修 | 有（2 个直驱 socket） | M | 观察 |
| 5 | 弹层定位换 floating-ui，6 份 | 显示瑕疵 | **2 次真实事故** `2a0b907`、`9c5523b` | **0** | M | 换（先 `OptionMenu.tsx`） |
| 6 | `sentence_split` 补测试 `chunk.rs:63` | **产品可见**——引给读者的例句在 "Mr." 处截断 | 0 次 | 仅间接，**无缩写用例** | **S** | 观察（先测试） |
| 7 | `lookup_history` 动态查询补测试 `:347-450` | 返回错行或类型不匹配 panic，且同时供 UI 与 MCP 工具（`mcp/tools/learning.rs:201`） | 0 次 | **0**——同构的 `explanations.rs:379` **有**测试 | **S** | 观察（先测试） |
| 8 | CDP 浏览器驱动 `smoke-ci.mjs:161` | CI 门禁可信度——`37242a6` 曾把通过结果替换成假崩溃 | **2 次真实事故** | 0（不可单测） | M | 观察（产品判断） |

**如果只做三件事：** 1、2、3。三条都是 S，合计不到一天，其中前两条不引入任何新依赖，第三条的第一步也不引入。它们分别覆盖了数据正确性、数据完整性、和一处 9 倍重复的零测试盲区。

---

## 落地结果（审查之后的执行记录）

八条全部处理完，落在 `2e8eca2`（1）、`1c47fa4`（2）、`17771dc`（3）、
`3c7be53`（5）、`cc98909`（6）、`f03509b`（7）六个提交里。第 4、8 条按判定
维持观察，没有改动。

**动手之后发现报告有四处说错了，记在这里，别照着上面的表再做一遍：**

1. **第 3 条不该做成一个 `useFocusTrap` hook。** 报告写的是「合并成一个
   hook」。读完全部调用点之后方向不对：各处的 React 接线本来就该不同——
   Escape 谁处理、监听器挂在哪个节点、捕获还是冒泡、关闭时要不要还原焦
   点。做成一个 hook 需要六七个开关参数，等于把同样的分支挪进 hook 里再
   写一遍。共享的是**判断**（Tab 停在环的两端时落到哪个元素），不是接线。
   最后拆成纯函数 `resolveTabFocus` + 一层薄 DOM 外壳。

2. **第 3 条的调用点是 10 处，不是 9 处。** 漏掉了 `Home.tsx` 的侧栏，它
   是第六种选择器变体。

3. **第 5 条不该从 `OptionMenu.tsx` 开始，而且它根本不该换。** 报告按
   「份数最多」排的序。`OptionMenu` 零事故，而且它按固定行高在
   `useLayoutEffect` 里预先算出菜单高度是有意为之（见其文件内注释），换
   成 floating-ui 的先测量后定位反而是退步。两次真实事故（`2a0b907`、
   `9c5523b`）都在流式弹层上，所以只换了那三个，右键菜单三份没动。

4. **第 6 条不是「补测试」，是补测试之后暴露出一个必须修的缺陷。** 报告
   把出错代价写成「例句在 Mr. 处截断」，这只说中了英文那一半。真正的问题
   是中文：切分规则要求终结符后面跟空白，中文句号后面不跟空格，所以一整
   段中文里它一个边界都找不到。后果有两个——读者拿到的「例句」是整段，以
   及 `split_oversized_block` 拿不到边界就切不开，300 句中文估出 2025
   token，超 `CHUNK_MAX_TOKENS` 四倍，整段进检索窗口。已有的
   `splits_oversized_blocks_at_sentence_boundaries` 是绿的，只因为它的样本
   是英文。

**没换 `unicode-segmentation`（第 6 条的备选），理由留档：** 它已经在
`Cargo.lock` 里，换它不加依赖。按 UAX #29 的 SB6–SB11 推演，中文和小写开
头的缩略语它能修，但 `Mr./Mrs./Dr./St./Prof.` 它一样切错——SB8 的例外只在
后面跟小写字母时触发，规范里没有缩写词典；而且它会把现在正确的
`"Stop!" she said.` 切成两半，因为 SB8 只管 `ATerm` 不管 `STerm`。用它是
拿一个已有的正确行为换几个修复。

**第 5 条的依赖代价，实测：** `@floating-ui/react-dom` 里实际用到的部分
（`useFloating` + `autoUpdate` + `flip` / `shift` / `offset`），esbuild
打包压缩后 gzip **7.2 KB**。无联网校验，离线可用。
