# Quill (Lantern) v2.0.0 代码审计报告

**日期**:2026-07-15(修复状态更新:2026-07-15)
**范围**:`main` 分支 @ `4dfe61a`(Rust 后端 ~43k 行 / TypeScript 前端 ~28k 行)
**方法**:自动检查(cargo clippy、tsc、eslint、单元测试)+ 人工精读核心模块(db、AI 路由/流式/取消、同步引擎 writer/merge、secrets、MCP server、useAiChat、useFoliateView、Reader 设置链路)+ 全库模式扫描(SQL 拼接、unwrap、事件监听清理、JSON.parse、定时器等)。

---

## 〇、执行状态总览

**第一批(已修复)** — 分支 `fix/audit-2026-07-15`,提交 `bfaf346`,[PR #8](https://github.com/KlaraGraff/lantern/pull/8)。后端 455 测试通过、clippy 零警告;前端 tsc/eslint 干净、21 单测通过。

| 编号 | 项 | 状态 |
|---|---|---|
| B-1 | Reader 设置 `JSON.parse` 防护 | ✅ 已修复 |
| B-2 | OAuth 刷新并发互斥 | ✅ 已修复 |
| R-1 | 段间取消丢失(pending-cancel 集) | ✅ 已修复 |
| R-2 | `bounded_chat_history` continue→break | ✅ 已修复 |
| R-3 | 流式 error 事件识别(3 适配器) | ✅ 已修复 |
| R-4 | 空 delta 阻断 failover | ✅ 已修复 |
| P-4 | `read_json_limited` 读取超时 | ✅ 已修复 |
| S-3 | FK 级联守卫测试 | ✅ 已修复 |
| C-1 | clippy `items_after_test_module` | ✅ 已修复 |
| C-2 | `deleteChat` 未处理 Promise | ✅ 已修复 |
| C-3 | 启动期旧数据迁移致白屏 | ✅ 已修复(仅 `migrate_legacy_app_data` 降级为 log) |

**第二批(待执行)** — 详细方案见 **第九节**,供后续 agent 直接实施。

| 编号 | 项 | 类型 | 建议优先级 |
|---|---|---|---|
| P-1 | `useSettings` 单例化(消除 N 次 IPC) | 前端重构 | 中 |
| C-4 | `useSettings.save` 乐观更新 + 回滚 | 前端(与 P-1 同文件) | 中(随 P-1) |
| S-1 | API key 明文存储 → 文档化取舍 | 文档 | 中 |
| S-2 | `set_setting` 键/值边界校验 | 后端加固 | 低 |
| P-3 | 封面导入时缩放压缩(降 DB 膨胀) | 后端 | 低 |
| C-5 | 前端纯函数/状态机测试补齐 | 测试 | 低 |
| P-2 | 流式内部完成直连 + 可选微批 | 后端重构 | 低(择机) |

> 说明:第二批多为架构/产品取舍或大范围重构,单独成批以隔离回归风险。下方"原始发现"章节保留完整分析,并为每条打上状态标签。

---

## 一、总体评价

**这是一个质量显著高于平均水平的代码库。** 自动检查全绿:

| 检查项 | 结果 |
|---|---|
| `cargo clippy --all-targets` | ✅ 仅 3 条风格警告(见 C-1) |
| `tsc --noEmit` | ✅ 0 错误 |
| `eslint src/` | ✅ 0 警告 |
| 后端测试 | ✅ 453 个 `#[test]`/`#[tokio::test]` |
| 前端单测 | ✅ 21/21 通过 |
| TODO/FIXME 残留 | ✅ 0 处 |

亮点(详见第五节):同步引擎的事务 + outbox 设计和文档质量极佳;SQL 全参数化且 LIKE 转义正确;MCP 面有写权限门控与敏感字段脱敏测试;前端大量使用 generation 计数器防 stale closure;prompt-injection 防护意识贯穿系统提示词。

下面的发现按严重度排列。**没有发现任何"高危/数据丢失级"缺陷**;最值得修的是 2 个中等级 Bug 和 2 个竞态。

---

## 二、确认的 Bug(建议修复)

### B-1 【中】✅ 已修复 · 损坏的 localStorage 会永久静默破坏单本书的阅读设置

**位置**:[src/pages/Reader.tsx:724](quill/src/pages/Reader.tsx#L724)

```ts
const saved = localStorage.getItem(`reader-settings-${bookId}`);
const bookSettings = saved ? JSON.parse(saved) as Partial<ReaderSettingsState> : {};  // 无 try/catch
```

**问题链**:
1. 若 `reader-settings-${bookId}` 值损坏(写入中断、手工改动、历史版本格式问题),`JSON.parse` 抛异常;
2. 异常被外层 `.catch(() => {})`(第 743 行)整体吞掉;
3. 后续的 `setReaderSettings(...)` 和 `dbSettingsLoadedRef.current = bookId`(第 742 行)**全部不会执行**;
4. 而设置持久化被 `settingsLoadedBookRef.current !== bookId` 门控([useReaderSettingsSync.ts:281](quill/src/pages/reader/useReaderSettingsSync.ts#L281)),损坏的键**永远不会被覆盖重写**;
5. 结果:该书的阅读设置(字体、边距、翻页模式等)永久回退为默认值,且用户的任何调整都不再保存——直到手动清 localStorage。同文件第 733-741 行的 zoom 读取也一并失效。

**修复建议**:把 `JSON.parse` 包进 try/catch,解析失败时 `localStorage.removeItem(key)` 并按空对象继续,保证 `dbSettingsLoadedRef` 总能置位。同样的防护 [openReaderWindow.ts](quill/src/utils/openReaderWindow.ts#L18) 和 [marker-style.ts](quill/src/components/marker-style.ts#L84) 都已正确做了,唯独这里漏了。

### B-2 【中】✅ 已修复 · OAuth token 刷新无并发互斥,可能导致偶发认证失败 + 5 分钟冷却

**位置**:[src-tauri/src/ai/oauth.rs:332-359](quill/src-tauri/src/ai/oauth.rs#L332)(`get_valid_token`)

**问题**:两个并发 AI 请求(完全常见:聊天流 + 标题生成并行,或多段摘要 + 查词)同时发现 token 过期时,会各自用**同一个 refresh_token** 调 `refresh_access_token`,之间没有任何互斥:

- OpenAI 对 refresh token 做轮换(rotation)时,第二个请求用已消费的旧 token 刷新 → `Token refresh error 401` → 被 `classify_error` 归为 `Auth` → **该 profile 进入 5 分钟冷却**([router.rs:561](quill/src-tauri/src/ai/router.rs#L561)),期间所有 OAuth 请求失败;
- 即使 provider 容忍重用,两次 `save_tokens` 的写入顺序不确定,后写的旧 refresh_token 可能覆盖新的,给**下一次**刷新埋雷,最坏需要用户重新登录。

**修复建议**:给刷新路径加一个 `tokio::sync::Mutex`(模块级 `OnceLock<Mutex<()>>` 即可);拿到锁后先**重读** tokens 再判断是否仍需刷新(double-check),避免排队的请求重复刷新。

---

## 三、竞态与边界问题(低概率,建议评估)

### R-1 【低】✅ 已修复 · 多段摘要生成的"段间取消丢失"窗口

**位置**:[summarize.rs:145-184](quill/src-tauri/src/ai/grounding/summarize.rs#L145)(`complete_summary`)+ [router.rs:914-916](quill/src-tauri/src/ai/router.rs#L914)

代码已经意识到 `complete_with_failover` 结束时会 `finish_request` 注销取消通道,并在每段前重新 `register_request`。但存在窗口:**上一段的 `finish_request` 执行后、下一段的 `register_request` 之前**,用户点 Stop → `cancel_request` 在注册表里找不到 id,返回 `false` 且取消信号被完全丢弃 → 剩余所有段落照常生成(长书可能是数分钟的多余 API 消耗)。

**修复建议**:方案 A——为多段生成引入一个不被 `complete_with_failover` 注销的"会话级"取消注册(外层 id + 每段派生 id);方案 B——`cancel_request` 未命中时把 id 记入一个短 TTL 的 pending-cancel 集合,`register_request` 时检查。同类(更小的)窗口也存在于 `ai_learning_card`/`ai_word_forms` 等命令入口:参数校验和设置读取发生在惰性注册之前,期间的取消同样会丢。

### R-2 【低】✅ 已修复 · `bounded_chat_history` 超预算时跳过而非截断,历史可能"挖洞"

**位置**:[src-tauri/src/commands/ai.rs:1220-1240](quill/src-tauri/src/commands/ai.rs#L1220)

从最新往旧遍历时,遇到会超出 `CHAT_MAX_TOTAL_BYTES` 的消息用的是 `continue` 而不是 `break`——该条被丢弃,但**更早**的消息若够小仍会被收录。结果发给模型的历史可能中间缺一条,破坏 user/assistant 交替(个别严格校验角色交替的 OpenAI-compat 端点会直接 4xx)。**建议**:超预算即 `break`,保持"最近的连续窗口"语义。

### R-3 【低】✅ 已修复 · 流式协议中的 error 事件被静默吞掉

**位置**:[openai_compat.rs:154-205](quill/src-tauri/src/ai/openai_compat.rs#L154)、[anthropic.rs:178-231](quill/src-tauri/src/ai/anthropic.rs#L178)(`process_data`)

- OpenAI-compat 端点可能发 `data: {"error": {...}}`;Anthropic 可能发 `{"type":"error", ...}`(如 overloaded)。两者都会落进"无匹配分支",流最终以 `AI_STREAM_INCOMPLETE` 收场。
- 兜底行为(归类为 `Protocol` → 可重试/切换凭据)方向正确,但**真实错误码丢失**——排障时日志里只有 INCOMPLETE,且 429/quota 类中途错误无法触发正确的冷却策略。

**建议**:在 `process_data` 里识别 error 事件并返回带原始 code/type 的 `AppError::Ai`(经 `http_status_error` 同款脱敏)。

### R-4 【极低】✅ 已修复 · 空 delta 也会置 `emitted=true`,阻断凭据切换

**位置**:[openai_compat.rs:192-193](quill/src-tauri/src/ai/openai_compat.rs#L192)

`choice_delta["content"].as_str()` 对 `content: ""` 返回 `Some("")`,仍会 `emitted.store(true)`。failover 逻辑用 `emitted` 判断"已向前端吐字、不可再换凭据重试"([router.rs:1349](quill/src-tauri/src/ai/router.rs#L1349))——某些网关先发一个空 content chunk 再报错的场景下,本可以无损切换凭据的请求会直接失败。**建议**:`filter(|s| !s.is_empty())` 后再置位(reasoning 分支已经这么做了)。

---

## 四、优化建议

### P-1 【中】⏳ 待办(方案见 §九) · `useSettings` 每实例全量拉取,无共享缓存

**位置**:[src/hooks/useSettings.ts](quill/src/hooks/useSettings.ts)

4 处组件各自实例化 `useSettings()`,每个实例挂载时都 `invoke("get_all_settings")` 一次(Reader 页还有独立的 `getAllSettings()` 调用)。设置变更靠 `settings-events` 广播保持一致,机制是对的,但初始加载是 N 次 IPC + N 份 state 拷贝,且各实例加载完成前后短暂不一致(如 `spoilerGuardEnabled` 在设置未加载时按默认值计算)。**建议**:提升为 Context/Provider 单例(或模块级缓存 + 订阅),一次拉取全局共享。

### P-2 【低】⏳ 待办(方案见 §九) · AI 流式每 token 一次全局事件广播

**位置**:`process_data` 各实现 + [router.rs:941](quill/src-tauri/src/ai/router.rs#L941)(`complete_with_failover`)

每个 SSE delta 都触发一次 `app.emit`(广播到所有 window,含 JSON 序列化)。前端已用 rAF 批处理渲染(useAiChat 做得很好),但 IPC 频次本身没有削减;`complete_with_failover` 甚至对**内部**完成也走一遍"emit → listen → 反序列化"总线(代码注释已承认是过渡方案)。**建议**:后端 ~16ms 微批合并 delta;内部完成路径改为直接回调/channel 收集,绕开事件总线。

### P-3 【低】⏳ 待办(方案见 §九) · 封面双份存储,大库下 quill.db 膨胀

封面同时存 `books.cover_data` BLOB 和 `covers/*.img` 文件(iCloud 同步需要)。几百本书 × 数百 KB 封面会让 DB 明显变大、备份变慢。**建议**:评估 BLOB 入库时压缩/限尺寸(如统一缩到 ~500px JPEG),或非同步用户仅存文件。

### P-4 【低】✅ 已修复 · `read_json_limited` 无整体读取超时

**位置**:[router.rs:734-752](quill/src-tauri/src/ai/router.rs#L734)

首字节有 `FIRST_BYTE_TIMEOUT`,但 body 流式读取无 idle/总超时,恶意或故障端点可让"列出模型"请求长期挂起(UI 侧表现为设置页转圈)。**建议**:比照 `STREAM_IDLE_TIMEOUT` 给 `stream.next()` 包 `tokio::time::timeout`。

---

## 五、安全观察(取舍类,非漏洞)

### S-1 ⏳ 待办(方案见 §九) · API key 明文存储于 `secrets.db`

v1.4 的 AES-GCM + Keychain 加密 vault 已被有意迁移为**明文 SQLite**(避免每次读密钥弹 Keychain 授权框),缓解手段齐全:文件权限 0600、`journal_mode=DELETE` + `secure_delete=ON`、WAL/SHM 文件加固、local-only 不入同步([secrets.rs:113-158](quill/src-tauri/src/secrets.rs#L113))。这是合理的桌面应用取舍,但意味着**同一 macOS 用户下的任意进程可直接读走 API key**。建议:在 README/隐私文档中明示该取舍;如未来上架分发,可考虑重新引入"启动时解锁一次、内存驻留"的加密层。

### S-2 ⏳ 待办(方案见 §九) · `set_setting` 无键白名单

[settings.rs:136](quill/src-tauri/src/commands/settings.rs#L136) 允许前端写任意 key/value(敏感键已正确拦截)。本地单用户应用风险低,仅在 WebView 被 XSS 的假想场景下会扩大攻击面(如翻转 `mcp_write_enabled`)。可选加固:键名前缀白名单 + 长度上限。

### S-3 ✅ 已修复(守卫测试) · 外键全局 `OFF`,完全依赖手动级联

[db.rs:248](quill/src-tauri/src/db.rs#L248) 写连接 `PRAGMA foreign_keys=OFF`(同步重放需要乱序写入,合理)。已核实 [merge.rs](quill/src-tauri/src/sync/merge.rs#L290) 的书籍删除级联覆盖全部 15 张子表且含 chat 墓碑,质量很高。风险在**未来**:新增子表时漏加一行 DELETE 不会有任何报错。**建议**:加一个守卫测试——删除种子书后跑 `PRAGMA foreign_key_check`(临时开 FK)断言零违规,把"漏级联"变成 CI 失败。

---

## 六、代码质量小项

| # | 状态 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| C-1 | ✅ 已修复 | [anthropic.rs](quill/src-tauri/src/ai/anthropic.rs)、[openai_compat.rs](quill/src-tauri/src/ai/openai_compat.rs)、[openai_responses.rs](quill/src-tauri/src/ai/openai_responses.rs) | clippy `items_after_test_module` ×3:`process_data` 定义在 `mod tests` 之后 | 移到 tests 之前(`cargo clippy --fix` 可自动) |
| C-2 | ✅ 已修复 | [AiPanel.tsx:247](quill/src/components/AiPanel.tsx#L247)、[ChatDetailView.tsx:69](quill/src/components/ChatDetailView.tsx#L69) | `deleteChat(chat.id)` 返回的 Promise 未处理;`useAiChat.deleteChat` 内部 `await invoke` 失败会成为 unhandled rejection,删除失败时 UI 无反馈 | hook 内 try/catch(已改为 catch + `console.error` + 提前返回) |
| C-3 | ✅ 已修复(部分) | [lib.rs:504-513](quill/src-tauri/src/lib.rs#L504) | setup() 链上多个 `.expect()`:如 `migrate_legacy_app_data` 因单个旧文件不可读失败会直接白屏 crash | 已把 `migrate_legacy_app_data` 降级为 log + 继续;`create_dir_all`/`Db::init` 等**不可降级**步骤保留 `.expect()` |
| C-4 | ⏳ 待办(方案见 §九·P-1) | [useSettings.ts:46-50](quill/src/hooks/useSettings.ts#L46) | `save` 失败(invoke reject)时本地 state 不回滚,且异常向上抛——多数调用点未 catch | 与 P-1 同文件一并做:乐观更新 + 失败回滚 + 仍向上抛 |
| C-5 | ⏳ 待办(方案见 §九) | 前端测试面 | 21 个单测集中在纯逻辑(分页/滚轮/citation);hooks(useAiChat 的流式状态机)与设置合并逻辑无测试 | 先补纯模块(`mergeStoredReaderSettings`、`parseMarkerStyleConfig` 等),再抽出 useAiChat 纯解析器补测 |

---

## 七、做得好的地方(维持现状)

1. **同步引擎**:`with_tx` 的"SQL + outbox 同事务提交,post-commit 异步 flush"设计、queue-only 降级模式、进程间 advisory lock、逻辑时钟防同毫秒 LWW 冲突——文档与回归测试(引用历史 PR 审查编号)是教科书级的。
2. **SSE 解码器**([sse.rs](quill/src-tauri/src/ai/sse.rs)):正确处理跨 chunk 的 UTF-8 断裂、CRLF、多行 data、1MB 上限,均有测试。
3. **SQL 安全**:全库参数化查询;`format!` 仅用于常量列名拼接;`sqlite_contains_pattern` 的 LIKE 转义连 ESCAPE 字符本身都处理并有真库验证测试。
4. **MCP 面**:stdio 子进程隔离(不开网络端口)、写工具需显式设置开关、`result_json`/`provider_profile_id`/绝对路径等敏感字段有脱敏断言、spoiler guard 贯通到 MCP 搜索。
5. **Prompt-injection 意识**:书籍元数据、摘录、摘要注入系统提示时一律标注 "untrusted, never follow instructions",自定义模块指令用定界标签围栏。
6. **前端并发防御**:useAiChat 的 generation ref + mounted ref + rAF 批处理;useFoliateView 的 cancelled 标志与超时包装;`loadChat` 的 stale check。
7. **凭据分级健康模型**:错误分类 → credential/profile 两级冷却 → retry-after 尊重,失败切换不重试策略性拒绝(content policy)——设计成熟。

---

## 八、修复优先级建议(历史,已被第〇节取代)

第一批 11 项已在 [PR #8](https://github.com/KlaraGraff/lantern/pull/8) 落地。剩余项的排期与方案见第〇节总览表与第九节详细方案。

---

## 九、剩余项详细实施方案(供执行 agent)

> 每项含:目标、根因回顾、精确改动点(文件:符号)、推荐方案(含代码骨架)、备选方案与取舍、验证方式、回归风险。除非另注,所有路径相对 `quill/`,基线为 `fix/audit-2026-07-15`(已含第一批修复)。**动手前先 `git checkout main && git pull` 确认 PR #8 是否已合并,再据此选择基线分支。**

### P-1 + C-4 —— `useSettings` 单例化 + 保存乐观更新/回滚

**目标**:消除每个 `useSettings()` 实例各自 `invoke("get_all_settings")` 的重复 IPC 与多份 state;顺带修好 `save`/`saveBulk` 失败时的未处理 rejection。

**现状事实**(已核实):
- `useSettings()` 消费者:`components/SettingsModal.tsx`、`components/settings/AiSettings.tsx`、`hooks/useAiChat.ts`(+ hook 本体)。
- 另有 6 处直接 `getAllSettings()`/`get_all_settings`:`App.tsx`(主题引导)、`pages/Home.tsx`、`pages/Reader.tsx`(与 localStorage 合并)、`components/DictionaryContent.tsx`、`components/TranslationPopover.tsx`、hook 本体。
- 跨窗口一致性已由 `components/settings-events.ts` 的 `settings-changed` Tauri 事件保证(`emit` 为 app 级广播);主窗口与独立 Reader 窗口是**各自独立的 webview/JS 上下文**,各持一份 provider 实例 —— 这没问题,别试图跨窗口共享内存。

**推荐方案:模块级共享 store + `useSyncExternalStore`(优于 Context,改动更小、无需包裹 Provider、两个窗口根都自动适用)**

1. 新建 `src/hooks/settingsStore.ts`:
   ```ts
   import { invoke } from "@tauri-apps/api/core";
   import { listenForSettingsChanged, notifySettingsChanged } from "../components/settings-events";

   type Settings = Record<string, string>;
   let cache: Settings = {};
   let loading = true;
   let started = false;
   const listeners = new Set<() => void>();
   const emit = () => listeners.forEach((l) => l());

   // 单次拉取 + 单次订阅;首个 subscribe 时惰性启动。
   function ensureStarted() {
     if (started) return;
     started = true;
     invoke<Settings>("get_all_settings")
       .then((s) => { cache = s; })
       .catch((e) => console.error("Failed to load settings:", e))
       .finally(() => { loading = false; emit(); });
     listenForSettingsChanged((values) => { cache = { ...cache, ...values }; emit(); })
       .catch(() => {});
   }

   export function subscribe(cb: () => void) {
     ensureStarted();
     listeners.add(cb);
     return () => listeners.delete(cb);
   }
   export const getSnapshot = () => cache;
   export const getLoading = () => loading;

   export async function refresh() {
     try { cache = await invoke<Settings>("get_all_settings"); }
     catch (e) { console.error("Failed to load settings:", e); }
     finally { loading = false; emit(); }
   }

   // C-4:乐观更新 + 失败回滚 + 仍向上抛(让关心的调用点能提示)。
   export async function save(key: string, value: string) {
     const previous = cache;
     cache = { ...cache, [key]: value }; emit();
     try {
       await invoke("set_setting", { key, value });
       await notifySettingsChanged({ [key]: value }).catch(() => {});
     } catch (e) {
       cache = previous; emit();
       console.error("Failed to save setting:", e);
       throw e;
     }
   }
   export async function saveBulk(next: Settings) { /* 同上,整体快照回滚 */ }
   ```
2. 改写 `src/hooks/useSettings.ts` 为薄封装(**保持返回形状不变**,4 个消费者零改动):
   ```ts
   import { useSyncExternalStore } from "react";
   import * as store from "./settingsStore";
   export function useSettings() {
     const settings = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
     const loading = useSyncExternalStore(store.subscribe, store.getLoading, store.getLoading);
     return { settings, loading, refresh: store.refresh, save: store.save, saveBulk: store.saveBulk };
   }
   export const getAllSettings = () => import("@tauri-apps/api/core").then(m => m.invoke<Record<string,string>>("get_all_settings"));
   ```
   注意:`getSnapshot` 必须返回**稳定引用**(缓存对象),否则 `useSyncExternalStore` 会因每次新对象而无限重渲染 —— 上面 `cache` 只在变更时替换引用,满足要求。
3. 可选迁移(降 IPC 收益最大):把 `DictionaryContent.tsx`、`TranslationPopover.tsx` 的独立 `getAllSettings()` 改为 `useSettings()`。`App.tsx` 的主题引导发生在极早期、且只读一次,**保留**(避免 FOUC 逻辑纠缠);`Reader.tsx` 的读取与 localStorage 深度合并,**保留**或改为读 store 快照(择一,勿两者混用)。

**备选**:React Context + `<SettingsProvider>` 包在 `App.tsx` 内。等价但需要包裹且对独立 Reader 窗口同样要覆盖;`useSyncExternalStore` 方案更省事,故为首选。

**验证**:`npm run test:unit` 新增 `tests/settings-store.test.ts` —— mock `@tauri-apps/api/core` 的 invoke,断言多次 `subscribe` 只触发一次 `get_all_settings`;`save` 失败时快照回滚。手动:打开设置面板 + AI 面板,DevTools Network/console 确认只有一次拉取。

**回归风险**:`useSyncExternalStore` 的 `getSnapshot` 引用稳定性(见上);StrictMode 双挂载下 `started` 守卫确保单次拉取。改动集中在 `useSettings.ts` + 新 store,消费者 API 不变,风险可控。

---

### S-1 —— API key 明文存储:文档化取舍(非代码)

**目标**:把"密钥明文存本地 `secrets.db`"这一有意取舍显式写入面向用户/贡献者的文档,消除"看起来像漏洞"的隐性风险。

**事实**:`secrets.rs` 已有缓解 —— 文件权限 `0600`、`journal_mode=DELETE`、`secure_delete=ON`、WAL/SHM 加固、local-only 不入同步。取舍原因:避免每次读密钥弹 Keychain 授权框。残留风险:同一 macOS 用户下任意进程可直接读走密钥。

**方案**:
1. `README.md` 与 `README.en.md` 各加"安全与数据存储 / Security & data storage"小节,写明:凭据(API key、OAuth token)以明文存于本地 `secrets.db`(0600、不同步),该设计规避 Keychain 反复授权;同机同用户的其他进程可读取;建议开启全盘加密(FileVault)。
2. 可选:`docs/security.md` 落更详细的威胁模型;`components/settings/AiSettings.tsx` 密钥输入区加一行 i18n 提示(`en.json`/`zh.json` 同步加 key)。

**验证**:文档渲染检查;若加 UI 提示,`tsc`/`eslint` + i18n key 两语言齐全。**回归风险**:极低(纯文档);UI 提示需遵守"所有用户可见文案走 i18n"约定。

---

### S-2 —— `set_setting` 键/值边界校验(替代脆弱白名单)

**目标**:降低 WebView 万一被 XSS 时通过通用 `set_setting` 写入超大/畸形键值的面。

**事实与判断**:
- 安全敏感开关 `mcp_write_enabled` **已有专用命令** `commands::mcp::mcp_set_write_access`(见 `lib.rs` handler 列表),不应经通用 `set_setting`。**先核实前端确实走专用命令**(grep `mcp_set_write_access` vs `set_setting` 相关调用);若前端仍用 `set_setting` 写该键,应改走专用命令,并在 `set_setting` 内**显式拒绝**该键。
- 动态键存在(如 `book_spoiler_guard_<bookId>`),所以**不建议**硬白名单 —— 易漏、每加一个设置都要改。

**推荐方案**(`commands/settings.rs` 的 `set_setting` 与 `set_settings_bulk_inner`):
1. 复用已有的 `Secrets::is_sensitive_key` 拦截之外,新增轻量校验:
   - 键:非空、长度 ≤ 128、仅 `[A-Za-z0-9_.:-]`(拒绝控制字符/空白)。
   - 值:长度 ≤ 上限(如 1 MiB;设置值不应有更大的)。
   - 显式拒绝安全开关键集合(如 `["mcp_write_enabled"]`)—— 它们只能走专用命令。
   ```rust
   const MAX_SETTING_KEY_LEN: usize = 128;
   const MAX_SETTING_VALUE_BYTES: usize = 1024 * 1024;
   const DEDICATED_ONLY_KEYS: &[&str] = &["mcp_write_enabled"];
   fn validate_setting_kv(key: &str, value: &str) -> AppResult<()> {
       if key.is_empty() || key.len() > MAX_SETTING_KEY_LEN
          || !key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_'|'.'|':'|'-')) {
           return Err(AppError::Other("SETTING_KEY_INVALID".into()));
       }
       if value.len() > MAX_SETTING_VALUE_BYTES {
           return Err(AppError::Other("SETTING_VALUE_TOO_LARGE".into()));
       }
       if DEDICATED_ONLY_KEYS.contains(&key) {
           return Err(AppError::Other("SETTING_REQUIRES_DEDICATED_COMMAND".into()));
       }
       Ok(())
   }
   ```
   在两个写入命令的敏感键检查之后调用。
2. **先跑一遍现网键盘点**:`grep -rhoE 'set_setting[^)]*|save\(["\x60][a-z_]+' src/` + 检查所有 `book_*` 动态键,确保校验规则不误伤(尤其 `book_spoiler_guard_<uuid>` 的 uuid 含 `-`,规则已放行 `-`)。

**验证**:`settings.rs` 加测试 —— 合法键值通过;超长键/值、含空格键、`mcp_write_enabled` 被拒;`book_spoiler_guard_<uuid>` 通过。**回归风险**:中(校验过严会拒真实键)—— 务必先盘点现网键并用测试锁定。

---

### P-3 —— 封面导入时缩放压缩(降 `quill.db` 膨胀)

**目标**:封面既存 `books.cover_data` BLOB(本地显示 + MCP `has_cover` 需要),又存 `covers/<id>.img`(iCloud 同步需要)。二者都不宜去掉,但可把**单份体积**从数百 KB 降到 ~30–80 KB。

**事实**:`image` crate 已是依赖(`commands/books/mutate.rs`、`books/mod.rs` 已在用);封面来源两处 —— EPUB 抽取(`epub.rs::extract_cover` → `import.rs::do_insert_book` 的 `cover_bytes`)与用户自定义(`mutate.rs` 校验后原样返回 `bytes`)。当前**不做任何缩放/重编码**。

**推荐方案**:
1. 新建 `commands/books/cover.rs`(或加进 `books/mod.rs`)一个纯函数:
   ```rust
   /// 解码 → 长边缩放到 <=600px(保持比例,不放大) → 重编码 JPEG q80。
   /// 解码失败时返回原字节(不因个别坏图阻断导入)。
   pub(crate) fn normalize_cover(bytes: &[u8]) -> Vec<u8> {
       let Ok(img) = image::load_from_memory(bytes) else { return bytes.to_vec(); };
       const MAX_EDGE: u32 = 600;
       let img = if img.width().max(img.height()) > MAX_EDGE {
           img.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3)
       } else { img };
       let mut out = std::io::Cursor::new(Vec::new());
       match img.write_to(&mut out, image::ImageFormat::Jpeg) {
           Ok(()) => out.into_inner(),
           Err(_) => bytes.to_vec(),
       }
       // 注:默认 JPEG 编码器质量固定;若要 q80 用 `image::codecs::jpeg::JpegEncoder::new_with_quality`。
   }
   ```
2. 在**新导入**路径统一过一遍:`do_insert_book` 之前对 `metadata.cover_data`(EPUB)与自定义封面 `mutate.rs` 返回值调用 `normalize_cover`。BLOB 与 `queue_cover_write` 都用归一化后的字节。
3. **不动存量**:已有封面照常工作;不做自动重编码迁移(避免大规模写放大与 iCloud 抖动)。如确需,单独出一个可选的一次性 backfill 命令,默认不跑。

**验证**:`books/tests.rs` 已有"输出可解码为图片"(`:1315`),补一条 —— 喂一张 >600px 大图,断言 `normalize_cover` 输出解码后长边 ≤600 且字节数显著小于输入。**回归风险**:低 —— 纯函数、解码失败回退原图;仅影响新导入,画质轻微下降。注意 PDF/自定义封面的 mime 白名单不变。

---

### C-5 —— 前端测试补齐(纯函数优先,状态机次之)

**目标**:让 B-1 类(JSON 解析)、设置合并、AI 历史裁剪这类逻辑有回归网。测试运行器已就绪:`node --experimental-strip-types --test tests/*.test.ts`(见 `package.json` 的 `test:unit`)。

**注意**:`tests/*.test.ts` 直接从 `src/` import;若目标模块在加载时会拉入 `@tauri-apps/*`(如 `useAiChat.ts`),node 测试会失败。**只测"加载即纯"的模块**,或把纯逻辑抽出到独立模块再测。

**推荐分两步**:
1. **即时可做(零重构)** —— 为已存在的纯模块补测:
   - `components/reader-settings.ts` 的 `mergeStoredReaderSettings`/`getEffectivePageColumns`:构造损坏/部分/越界的 stored 值,断言合并结果落在允许域(直接覆盖 B-1 同源的"坏数据不崩")。
   - `components/marker-style.ts` 的 `parseMarkerStyleConfig`:非法 JSON/缺字段 → 回默认。
   - `utils/openReaderWindow.ts` 的 `loadSavedSize`:坏 JSON/越界 → clamp。
   新增 `tests/reader-settings.test.ts`、`tests/marker-style.test.ts` 等,风格照 `tests/` 现有文件。
2. **小重构后可做** —— 把 `useAiChat.ts` 里的纯解析器(`parseSpoilerGuard`、`parseCitedSources`、`parseMessageMetadata`、`serializeMessageMetadata`、`deriveTitle`)抽到 `hooks/ai-chat-helpers.ts`(不 import Tauri),`useAiChat.ts` 再从中 re-import;新增 `tests/ai-chat-helpers.test.ts` 覆盖畸形 metadata、非数组 sources、超长 title 截断。
   - 后端 `bounded_chat_history` 的 continue→break 已有 Rust 侧覆盖(R-2 语义在后端),前端无需重复。
3. **暂缓**:`useAiChat` 完整流式状态机(generation/rAF/取消)需要 fake 掉 `listen`/`invoke`/`requestAnimationFrame`,投入大、收益递减 —— 除非该 hook 后续再改,否则先靠上面两步兜住。

**验证**:`npm run test:unit` 全绿且新增用例可见于计数。**回归风险**:抽取纯函数时保持导出签名不变,`tsc` 把关。

---

### P-2 —— 流式内部完成直连 + 可选微批(择机,最大改动)

**目标**:两个独立子项,建议**只做 (a)**,(b) 视 profiling 而定。

**(a) 内部完成绕开事件总线(推荐)**
`ai/router.rs::complete_with_failover` / `complete_with_profile` 当前用一个随机事件名 `app.emit` → 自己 `app.listen` → 反序列化 `AiStreamChunk` 收集文本(代码注释已承认是过渡方案)。适配器(`anthropic.rs`/`openai_compat.rs`/`openai_responses.rs`)只认 `(app: &AppHandle, event_name: &str)`。

方案:引入一个"流出口"抽象,替换适配器的 `app + event_name` 两参:
```rust
// ai/mod.rs
pub(crate) enum StreamSink<'a> {
    /// 直接吐给前端事件通道(现有面向用户的流)。
    Emit { app: &'a AppHandle, event_name: &'a str },
    /// 进程内收集(complete_* 内部完成用),可选同时转发给前端。
    Collect {
        text: &'a std::sync::Mutex<String>,
        first_token_ms: &'a std::sync::Mutex<Option<u64>>,
        started: std::time::Instant,
        forward: Option<(&'a AppHandle, &'a str)>,
    },
}
impl StreamSink<'_> {
    pub(crate) fn push_delta(&self, delta: &str) { /* Emit→app.emit;Collect→push + 可选 forward */ }
    pub(crate) fn push_reasoning(&self, delta: &str) { /* ... */ }
    pub(crate) fn done(&self) { /* Emit 发 done;Collect 可选 forward done */ }
}
```
适配器 `stream_chat(... sink: &StreamSink ...)`,内部把三处 `app.emit(...)` 换成 `sink.push_*`。`stream_once`/`stream_with_*_inner` 透传 `sink`。`complete_with_failover` 用 `Collect` 变体,删除 `listen`/`unlisten`/`serde_json::from_str::<AiStreamChunk>` 那段。

收益:内部摘要/查词/学习卡的每个 token 少一次 emit→listen→反序列化往返;`emitted` 的语义(是否已产出可见字节)保持不变。

**(b) 面向用户流的后端微批(可选)**
每个 SSE delta 一次 `app.emit`(广播 + JSON 序列化)。前端已 rAF 批渲染,故仅在极快流下 IPC 频次有意义。若要做:在 `StreamSink::Emit` 内攒 ~16ms 或 ~256B 再 flush(需一个小缓冲 + `tokio::time`)。**建议先测**:高频 token 场景下 IPC 是否真是瓶颈;不是就别引入这层复杂度与"末尾残留 flush"的边界。

**验证**:适配器现有 `process_data`/request_body 测试不受影响;新增一个 `StreamSink::Collect` 单测断言收集文本正确、`first_token_ms` 记录。`complete_with_failover` 走一条 mock 适配器路径断言等价输出。**回归风险**:中偏高 —— 触及三个适配器签名 + 路由核心;务必保证 `emitted` 语义、cancel select、done 时序与现状逐字节等价,分小步提交并每步全测。

---

*报告基于静态审读与既有测试运行,未执行动态渗透或压力测试。第一批修复已合入 [PR #8](https://github.com/KlaraGraff/lantern/pull/8);行号对应 `main@4dfe61a` + 该 PR。第二批方案面向后续执行 agent,动手前请以最新 `main` 为准复核符号是否仍存在。*
