# Lantern 项目检查与整改记录 — 2026-10-02

基线：`6fe4aa80`（2.18.13）。主审负责检查、合并判断和验收；实现由子代理完成。未发布版本。

## 范围与证据边界

- 检查阅读器、书库、同步、AI、MCP、设置及其调用链；核对中英文标题、说明与实际行为。
- 检索和测试至少使用 `gpt-6.1-sol` low；实现至少 medium；判断型审查使用 `gpt-6-astra` high。
- 不修改真实书库、凭据、iCloud 文件或项目配置，不调用真实收费 AI 服务。
- 保留三个其他会话的未跟踪文件：`docs/impls/ai-cache-audit.md`、`docs/impls/ai-cache-live-test-2026-10-01.md`、`docs/roadmap/mobile-ios-replan-2026-08-11.md`。
- 浏览器巡检使用模拟后端，不能替代原生应用、真机、双设备同步和真实供应商验证。检查过的路径没有发现问题，不代表整个项目没有其他缺陷。

## 基线验证

| 检查 | 结果 | 限制 |
| --- | --- | --- |
| TypeScript | 通过 | 静态类型检查 |
| ESLint | 0 错误、2 条已有 Fast Refresh 警告 | 不因此认定用户功能有问题 |
| 前端单元测试 | 1,689 通过、2 跳过 | 不能代替组件交互验证 |
| Rust 库测试 | 1,748 通过、18 忽略 | 未运行被忽略的环境依赖测试 |
| 浏览器巡检 | 桌面、窄屏均打印 PASSED，但报告均为 `ok: false` | 分别记录 26、36 条 `console.error`，包含区域组件崩溃；不能算有效通过 |
| 文档链接检查 | 7 项报错，均指向未跟踪缓存实测文档 | 至少一项文件实际存在，是绝对路径解析错误，不能按报告认定证据丢失 |

原始测试输出保存在本机 `/tmp/lantern-audit-20261002-{unit,rust,smoke}.log`；临时文件不是长期证据仓库。巡检详细报告在 `dist/smoke-report-desktop.json` 与 `dist/smoke-report-narrow.json`，后续复跑会覆盖。

## 已确认问题与整改队列

| 编号 | 级别 | 问题、触发与后果 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| T01 | P1 验证缺口 | 被区域 ErrorBoundary 接住的组件崩溃仅记录为 `console.error`，巡检仍通过，掩盖不可用的页面 | `scripts/smoke-ci.mjs` 的 `FAILING_KINDS`/`gate`；两份实跑报告 | 已修复并复核，区域崩溃进入失败门禁 |
| T02 | P2 测试样例 | 模拟 AI 配置使用 `name` 而非 `label`，不符合当前数据结构，进入设置时 `.trim()` 报错，阻断该区覆盖 | `harness/invoke-fixtures.ts` 的 `harnessProfile`；`ai-draft-profiles.ts:isProfileConfigComplete` | 已修复测试样例；尚无正式后端同类缺字段证据 |
| T03 | P2 检查工具 | 文档检查用 `join(docDir, absolutePath)`，将有效绝对路径拼到文档目录下，误报断链 | `scripts/check-doc-links.mjs:checkDocLinks`；本机 `wire.jsonl` 实际存在 | 已由子代理修复并通过定向回归 |
| A01 | P1 可用性 | Embedding 已返回响应头后停顿，JSON 正文读取没有时限，可能长期占住请求槽位并挂住索引/连接测试 | `ai/grounding/vector.rs:embeddings_internal`；`ai/mod.rs:http_client`；聊天查询及设置探测直接等待 | 已修复；定向与完整回归通过 |
| S01 | P2 可用性 | 语音已经下载成功后，缓存目录创建失败会直接返回错误，使可播放音频丢失 | `commands/speech.rs:cached_audio` 中 `fs::create_dir_all(dir)?` | 已由子代理修复并通过定向回归 |
| R01 | P1 数据归属 | 同一 Reader 实例从 A 书跳 B 书，旧学习卡 interaction 配上新 bookId；自动查词完成、收藏或笔记可写错书 | `useLearningCards.ts`、`Reader.tsx`、`LearningCardController.tsx` 的持久化调用链 | 已修复并通过回归 |
| R02 | P2 设置无效 | 关闭自动保存后仍每次排队写进度；`auto_save` 只有设置页读取 | `Reader.tsx:queueReadingProgress`、`useFoliateView.ts`、`reading-progress-writer.ts` | 按用户确认实现；失败保留进度，正常退出等待保存，已通过回归 |
| R03 | P2 状态过期 | 高亮修改广播后共享 hook 不刷新，常驻搜索的“只搜高亮”和已开笔记面板仍用旧列表 | `useBookmarks.ts:useHighlights`、`BookSearchPanel.tsx` | 已修复并通过回归 |
| R04 | P2 数据可见性 | 笔记面板及正文选区笔记锚点只读首 500 条，忽略 cursor；较早数据仍在库但无法完整显示/搜索 | `ReaderNotesPanel.tsx`、`useFoliateAnnotations.ts`、`commands/notes.rs` | 已修复并通过回归，不新增分页界面 |
| S02 | P1 数据可用性 | 关闭同步直接复制到目标，失败留下半文件后重试凭存在跳过，最终可能切到损坏本地副本 | `commands/sync.rs:copy_one_disable_file` 及关闭流程 | 原子复制、逐字节验证、故障重试已实现；定向与完整回归通过 |
| S03 | P1 同步一致性 | title/status/progress 共用整行版本却仅更新局部字段；并发改名与阅读后两端同版本、不同标题，快照无法纠正 | `sync/merge.rs`、`sync/snapshot/apply.rs`；内存 SQLite 复现 A=new/50、B=old/50，同为版本11/B | 字段时钟与快照合并已实现；用户批准现有书籍初始化，保留书库 |
| S04 | P2 同步缺失 | 换封面沿用同一文件路径，远端有旧 BLOB 时永远不重新读文件，继续显示旧封面 | `commands/books/mutate.rs`、`sync/replay.rs:ingest_peer_covers`、BookGrid/List | 内容哈希路径与事件/文件乱序回归已完成；保留现有封面读取 |
| A02 | P2 重复开销 | 向量未完成时多次聊天各启动回填，共享入口无按书协调，重复读取同一缺失快照并发送请求 | `commands/ai/chat.rs:1080`、`ai/grounding/vector.rs:ensure_embeddings` | 已修复；定向与完整回归通过 |
| A03 | P2 请求泄漏 | 标题收到部分内容后15秒超时，将 finished 置真并因title非空不取消；界面放弃后服务仍生成 | `useAiChat.ts:generateAiTitle` | 已修复；定向与完整回归通过 |

P1 表示重要功能可能长期不可用或验证门禁漏报；P2 表示条件触发的功能错误。本轮没有仅凭可疑代码宣告数据已丢失。

## 标题、文案与内容不一致：待产品确认

本节只提出具体修订，不直接改界面文字。

| 编号 | 当前描述与偏差 | 建议 | 核对依据 |
| --- | --- | --- | --- |
| C01 | “显示名称”说明称用于高亮和笔记，实际只被书库侧栏读取 | 中文：`显示在书库侧栏，仅保存在此设备。`；英文：`Shown in the library sidebar and kept on this device.` | `GeneralSettings.tsx`、`Home.tsx`、`Sidebar.tsx`；全仓 `user_name` 调用检索 |
| C02 | “通用”副标题为“个人资料与语言”，学习资料已经迁到独立页面，当前内容还有主题、更新和诊断 | 中文：`界面、名称与应用选项`；英文：`Appearance, name and app options` | `settings-sections.ts`、`GeneralSettings.tsx` |
| C03 | 掌握度说明承诺关闭“眼熟”计入后降低 2–4 个百分点，实际差值来自每本书熟悉词占比，也可能显示区间而非单值 | 中文：`关闭后仅将「读顺了」的词计入掌握度，结果取决于本书的词汇分布。`；英文：`When off, only effortless words count as mastered. The result depends on the book’s vocabulary.` | `coverage-view.ts:coverageReading` 与 `coverageBounds` |
| C04 | 自定义语音缓存说明承诺同一段不重复计费，但缓存可被清空、淘汰，音色/模型/语速变化也改变缓存键，磁盘写入可能失败 | 中文：`缓存成功后，相同语音配置下重复播放可直接使用本地音频。关闭后不再缓存长段落；单词、短语和已有缓存不受影响。`；英文：`Once cached, the same text can replay locally with the same voice settings. Turning this off stops caching passages; words, phrases and existing audio are kept.` | `commands/speech.rs` 的缓存键、清理、淘汰及写入逻辑 |
| C05 | Windows 无同步功能，但页面标题与副标题仍为“书库与同步”及设备间同步说明 | 无同步能力的平台显示“书库 / Library”，副标题“书籍来源 / Book sources”；有同步能力的平台保留现状 | `LibrarySettings.tsx`、`settings-sections.ts`、`services/platform.ts` |

## 文档与协作规则冲突：待确认

- `AGENTS.md` 将 ad-hoc 称为当前默认发布方式并禁止下载验证；`docs/guide/macos-distribution.md` 说明正式发布使用 Developer ID，并要求每次下载验证。当前工作流按证书可用性和预发布标签分流，不能用一个固定签名状态描述所有版本。
- `docs/guide/security.md` 也残留“current ad-hoc distribution”。建议以现有工作流为依据统一文字，并单独向用户确认发布验证规则；本次不修改规则、不读取任何签名密钥。

## 优化建议与未验证范围

- 先恢复可信的界面巡检，再考虑增加巡检路由和原生阅读器渲染验证。当前巡检仅到 6 条路由，后台标签页 `readerRendered: false` 是已知设计限制，不能据此认定阅读器白屏。
- 部分设置在持久化完成前提示“已保存”；建议系统性核对保存失败反馈和重复操作顺序，避免局部乐观状态让用户误认为数据已落盘。
- 大文件本身不是 Bug；不因为 `Reader.tsx`、AI 路由或同步合并文件较长就派拆分重构。应先围绕确认的缺陷加定向验证，再决定是否有值得独立抽出的责任。
- 真机 iOS、macOS 12、双设备 iCloud、真实 AI 服务、OCR 外部运行环境不在本次已通过项之内。

## 复核记录

- AI 配置标签切换可能丢失有效草稿：发现存在 600ms 自动保存及卸载 flush，撤回“仅因切换标签就丢失”的推断，后续仅在有保存失败证据时重开。
- 主审退回了“保存失败仍关闭窗口”的初版，要求保留待重试进度，并覆盖正常退出应用；强制结束进程不在保证范围内。
- 主审发现字体/单书设置失败可能让关闭的自动保存被意外开启，已改为只依赖全局设置结果，并用字体失败回归验证。
- 同步封面复核发现一次性读取所有封面造成内存峰值，已退回并改为逐张读取、核验和短锁写入。
- 同步协议现为事件 v15、快照 v10，不与旧客户端混用。字段初始化只建立未来更新的基线，不能恢复历史已经分歧的字段。旧封面文件暂不清理，以免影响其他设备引用。
- 修复后的首轮界面巡检：桌面 412 次操作、窄屏 438 次操作，均完成 6 条路由；致命门禁错误为 0。报告仍为 `ok: false`，分别有 6、12 条模拟 CFI/批注诊断，因此不宣称所有日志无错或原生阅读器已验证。
- 首轮专门审查覆盖阅读器与临时状态、笔记高亮、书库异步查询；导入/删除/同步开关、事件回放和快照；AI并发、向量调用、聊天标题、设置草稿。主审补核 MCP 写权限撤销检查及审批入口、词卷生成会话和复习提交守卫；未将未证实疑点列为缺陷。

## 最终验收

- 14 项已确认代码或验证工具问题均已整改。所有业务代码、测试工具修复均由子代理实施，主审负责复核与提交。
- 前端单元测试：1,729 通过、2 跳过；后端库测试：1,768 通过、18 忽略；生产构建和阅读器静态兼容检查通过。ESLint 为 0 错误、2 条原有 Fast Refresh 警告；文档本地链接检查通过。
- 两位高风险实施代理互相只读审查。主审与交叉审查共退回保存失败仍关闭、同书重返恢复旧位置、自动保存受字体失败影响、封面全集读取内存峰值四处实现问题，修正后验收。
- A→B→A 回归使用真实进度 writer 和 Reader 实际恢复链：旧位置 10%、待保存 70%，先等 70% 写入再读取；保存失败时不读取旧位置，重试成功后恢复 70%。
- 自动保存关闭时仍保存离开阅读器/正常退出的位置。强退、崩溃、断电不承诺保存；原生窗口与 Cmd-Q 只完成代码链路和模拟测试，未冒用浏览器巡检作为原生证明。
- C01–C05 文案修改、发布验证规则统一及更广的产品优化尚未批准，本轮不改。下阶段优先建议：扩大原生阅读与双设备同步验证，再系统核对设置保存失败反馈。
- 最终日志位于本机 `/tmp/lantern-audit-final-{unit,rust,build,lint,smoke}.log`；这些临时日志会被系统清理，结论与测试入口以本记录及仓库测试为准。
- 最终桌面与窄屏巡检均通过失败门禁，仍分别有 6、12 条上述模拟诊断，`report.ok` 仍为 false；未把这部分说成无错实机验收。
- 巡检仍列出未建模命令（如索引维护、覆盖率计算、部分学习资料操作），这些走安全占位返回，不代表功能已验收；后续扩大覆盖时应补真实结构与行为模拟，不能仅靠无崩溃判功能正确。

## 提交对应

- `6fe4aa80`：子代理模型与推理强度规则（执行前已推送）。
- `ccce9b85`：界面巡检、测试样例、文档路径检查。
- `4aff9bcd`：字段同步、封面传播、关闭同步文件安全。
- `2b7f0db3`：阅读会话隔离、进度保存与正常退出、笔记完整读取与高亮刷新。
- `eb172bcc`：Embedding 请求边界及并发协调、标题取消。
- `7bb55fd0`：语音缓存失败仍返回已取得音频。

上述改动在 main 统一提交，不创建版本标签、不发布安装包。实际用户数据尚未运行初始化；初始化会在运行升级后的应用时执行。
