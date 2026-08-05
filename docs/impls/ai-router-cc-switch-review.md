# router.rs 对标 cc-switch 调研报告

> 调研日期：2026-08-04；实施日期：2026-08-05
> 范围：调研阶段只读；用户批准后已按第 5 节顺序全部实施，落地情况见文末「实施记录」。
> 被调研文件：`src-tauri/src/ai/router.rs`（4,180 行）、`src-tauri/src/commands/ai.rs`（调用方部分）
> 对标项目：[farion1231/cc-switch](https://github.com/farion1231/cc-switch)

---

## 1. 对标项目确认

用户写的是 "cc-swith"，确认为笔误。目标项目是 **farion1231/cc-switch**。

| 指标 | 数值（2026-08-04 查询） |
|---|---|
| Star | 124,328 |
| Fork | 8,439 |
| Open issues | 2,173 |
| 主语言 | Rust |
| 协议 | MIT |
| 创建 / 最近推送 | 2025-08-04 / 2026-08-04（当天仍在推） |
| 技术栈 | Tauri 2 + Rust + React + TypeScript |

**为什么是它，没有换别的对标对象。** 搜索里出现的其他候选（`Laliet/cc-switch-web`、`SaladDay/cc-switch-cli`）都是这个项目的衍生分支，不是独立方案。以「AI 供应商路由 / 故障转移 + 用户量」两个条件筛，没有比它更合适的开源对标。技术栈还恰好和 Lantern 一样是 Tauri 2 + Rust，可比性比一般的对标高。

**一个需要修正的先入判断。** 提示词里的初步判断是「cc-switch 偏配置切换，router.rs 偏运行时自动故障转移，可借鉴面窄」。这个判断在 2025 年是对的，**现在只对了一半**：cc-switch 已经长出了一整套本地反向代理（`src-tauri/src/proxy/`，约 80 个文件），里面确实有 `circuit_breaker.rs`（三态熔断器）、`provider_router.rs`（候选选择 + 故障转移）、`failover_switch.rs`（切换去重）、`error_mapper.rs`（错误映射）。README 的原话是它提供 "auto-failover, circuit breaker, provider health monitoring"。

所以重叠是真实的，但**只在这一个子系统上**。cc-switch 一千一百多个文件里，跟 router.rs 干同一件事的大概是四个文件、一千三百行。下面的对比就锁在这四个文件上，其余（MCP 管理、Skills、云同步、托盘、会话浏览器）跟 Lantern 无关，不展开。

参考的 cc-switch 源码（本次逐行读过）：

- `src-tauri/src/proxy/circuit_breaker.rs`（495 行）
- `src-tauri/src/proxy/provider_router.rs`（523 行）
- `src-tauri/src/proxy/failover_switch.rs`（135 行）
- `src-tauri/src/proxy/error_mapper.rs`（155 行）

---

## 2. 两者定位对比

| 维度 | cc-switch | Lantern `router.rs` |
|---|---|---|
| **产品形态** | 独立桌面工具，管别人（Claude Code / Codex / Gemini CLI）的配置 | 应用内的一层库，只服务 Lantern 自己，前端不直接调 |
| **主要工作** | 改写 `~/.claude/settings.json` 一类配置文件；可选再起一个本地 HTTP 代理 | 直接发 HTTPS 请求给供应商 |
| **谁选供应商** | 默认用户手动选（托盘菜单、拖拽排序）；自动故障转移是一个**开关**，默认关 | 永远自动，按 `priority` 顺序遍历，用户只排序不点选 |
| **协议层** | 反向代理 + 跨格式转换（Anthropic ↔ OpenAI ↔ Gemini ↔ Codex Responses） | 三个 adapter（anthropic / openai_compat / openai_responses），不做跨协议转换 |
| **失败后的记忆** | 三态熔断器（Closed / Open / HalfOpen），**进程内存**，重启即忘 | 冷却期 `cooldown_until`，**写进 SQLite**，重启仍生效 |
| **熔断触发条件** | 连续失败次数 **或** 错误率超阈值（两者都可配置） | 单次失败即按错误类型定冷却时长（硬编码：5min / 1h / 60s / 30s） |
| **错误分类** | 结构化 `ProxyError` enum，`UpstreamError { status: u16, body }` 把状态码当字段带着走 | 对 `error.to_string()` 做**子串匹配**反解 |
| **凭据存储** | 明文 SQLite（`~/.cc-switch/cc-switch.db`），README 未提加密或 Keychain | Keychain / `secrets.db`；router 只存 `secret_ref` 和后 4 位掩码 |
| **一个供应商多把 key** | 无这个概念 | 有，`ai_credentials` 是独立一层，key 级冷却和 key 级故障转移 |
| **请求取消** | 无显式机制（代理层靠 HTTP 连接断开天然完成） | 显式取消注册表 + 跨步骤的 pending TTL（掐断流式请求） |
| **reasoning effort** | `reasoning_bridge.rs` 做跨格式桥接 | 主动按用途降级 + **从拒绝报文里学习**该端点接受哪些档位并落库 |
| **并发度** | 代理服务，多个 CLI 进程同时打进来 | 单个阅读器应用，并发请求个位数 |

**一句话概括差异**：cc-switch 是「给很多客户端做通用网关」，router.rs 是「给一个客户端做贴身容错」。前者必须假设高并发、必须做协议转换、必须让熔断参数可配置；后者可以假设低并发、只服务自己写的几个 prompt，但反过来要关心 cc-switch 完全不关心的东西——用户点了停止按钮怎么办、一把 key 用完了换下一把、reasoning 档位被拒了怎么降级。

---

## 3. 值得借鉴的点

按「值不值得抄」排，只有第 1 条是推荐做的。

### 3.1 结构化错误分类，不靠字符串反解 —— **推荐做**

**cc-switch 的做法。** 错误是一个 enum，状态码是 enum 的字段：

```rust
ProxyError::UpstreamError { status: u16, body: Option<String> }
```

分类时直接 `match`，`map_proxy_error_to_status` 只是把 enum 变体映射成 HTTP 码，没有任何字符串解析。

**Lantern 现状。** `crate::ai::http_status_error`（`src-tauri/src/ai/mod.rs:79`）把状态码 `format!` 进一条人类可读的消息里（`status=429 type=... code=...`），然后 [`classify_error`](src-tauri/src/ai/router.rs:176) 把这条消息 `to_ascii_lowercase()` 之后用 `contains("status=429")` 反解回来。中间隔了一次字符串编码 + 一次字符串解码。

**为什么这是个真问题。** 不是「不优雅」，是**失败方式很安静**。`classify_error` 的最后一个分支是 `else { AiErrorKind::Network }` —— 兜底。任何一次格式变动、任何一个没匹配上的状态码，都不会报错，只会静默降级成「网络错误，冷却 30 秒后重试」。你不会收到任何信号说分类挂了，只会看到重试策略变得不对。第 4 节列了四个已经存在的具体盲区。

**改动成本。** 中等，但可以做得很窄。不需要重写 `AppError`，也不需要动那 5 个 adapter：让 `http_status_error` 在返回 `AppError` 的同时**额外返回一个已知的 `AiErrorKind`**（或者给 `AppError::Ai` 加一个携带结构化 kind 的变体），`classify_error` 优先读结构化值、读不到再退回现有的字符串匹配作为兜底。现有代码一行不用删，风险接近零。

**推荐：做。** 这是整份报告里唯一一条「cc-switch 做对了而 Lantern 做错了」的。

### 3.2 三态熔断的 HalfOpen 探测名额 —— **不做**

**cc-switch 的做法。** 熔断器打开后超时进入 HalfOpen，此时用一个原子计数器限流，**只放一个请求过去探路**（`allow_half_open_probe`，`max_half_open_requests = 1u32`）。探路成功 N 次才关闭熔断器，探路失败立刻重新打开。

**Lantern 现状。** 冷却期到点就直接放行，没有探测阶段。

**为什么不抄。** 这个机制解决的是「一个刚恢复的供应商被一拥而上的并发请求二次打垮」。cc-switch 是网关，要扛多个 CLI 进程；Lantern 是单个阅读器，同一时刻在飞的 AI 请求是个位数。而且 Lantern 的失败已经写进了 SQLite 的 `cooldown_until`，本身就有持久化的时间窗保护。多加一层三态机 + permit 的获取/释放配对（cc-switch 自己为此写了 `release_permit_neutral` 这样的补丁接口，还专门加了两个测试防止名额泄漏卡死），是在给一个不存在的问题付复杂度。

**推荐：不做。**

### 3.3 错误率阈值熔断（不只看连续失败）—— **不做**

**cc-switch 的做法。** 除了「连续失败 N 次」，还有「错误率超过 60% 且样本数 ≥ 10」这条独立的触发路径。

**Lantern 现状。** 一次失败就按错误类型进冷却，没有统计窗口。

**为什么不抄。** 场景不同。cc-switch 的代理后面挂着长时间跑的 agent，允许零星失败、只在整体劣化时才切换是合理的。Lantern 这边**用户正在等这一次回答**——第一次失败就换下一个 profile 才是对的行为，攒够 10 个样本再决定，用户早就关掉窗口了。Lantern 的「一次即冷却」不是简陋，是场景要求。

**推荐：不做。**

### 3.4 熔断参数可配置 + 热更新 —— **不做**

cc-switch 的失败阈值、超时、错误率阈值全部从 DB 读，改了立即热更新到所有已创建的熔断器实例。Lantern 的冷却时长是四个硬编码常量（[`router.rs:1002`](src-tauri/src/ai/router.rs:1002) 和 [`router.rs:1058`](src-tauri/src/ai/router.rs:1058)）。

不抄的理由是产品判断：这四个数字对用户没有意义，暴露出去只会多四个看不懂的设置项。如果将来真要调，把它们提成一张有名字的常量表（`const AUTH_COOLDOWN_MS` 之类）就够了，不需要进设置界面。这一条属于**产品形态决策**，最终由用户拍板；技术上两条路成本都很低。

### 3.5 故障转移切换去重 —— **可做，低优先级**

**cc-switch 的做法。** `FailoverSwitchManager` 用一个 `HashSet<String>` 记「正在处理中的切换」，同一个 `app_type:provider_id` 的切换如果已在进行中就跳过，避免并发请求重复触发同一次 UI 事件和托盘刷新。

**Lantern 现状。** [`emit_route_fallback`](src-tauri/src/ai/router.rs:805) 的注释解释得很清楚：第二次请求时失败的 profile 已经被冷却过滤掉了，所以不在路由头部，也就没有「切换」可报——**这个推理对串行请求是成立的**。

但对**同时在飞**的请求不成立：假设用户开着侧边栏聊天，后台同时在跑分节摘要，两个请求几乎同时出发、都看到 profile A 还没冷却、都失败、都降级到 profile B，于是 `ai-route-fallback` 事件会发两次，前端会弹两次「已切换到 B」的提示。

**改动成本。** 低。要么在 `emit_route_fallback` 里加一个「(from_id, to_id) 最近 N 秒发过就跳过」的去重表，要么前端做提示去重。

**推荐：可做，但排在第 4 节的问题后面。** 这是个体验毛刺，不是缺陷。

### 3.6 手动重置熔断器 —— **Lantern 已有等价物，且更好**

cc-switch 有 `reset_circuit_breaker` / `reset_provider_breaker`。Lantern 的对应物是 [`AiRetryMode::Manual`](src-tauri/src/ai/router.rs:493)：用户主动重试时，冷却截止时间按 `i64::MAX` 比较，等于所有冷却都已过期。

Lantern 这个设计更好，理由写在注释里：冷却期只是 Lantern 自己的猜测（供应商很少说什么时候恢复），用户明确的重试意图应该压过一个猜测；而**被判定为 invalid 的凭据仍然排除**，因为「这把 key 被拒了」不是猜测、是已知结论。cc-switch 的 reset 是一个粗粒度的全清。这条不用抄。

---

## 4. router.rs 自身的优化机会

按性价比排序（性价比 = 影响 ÷ 改动风险）。前三条建议做，后三条是顺手清理。

### A. `stream_with_profile_inner` 会把内容重复输出 —— **真缺陷，唯一用户可见的**

**位置**：[`router.rs:1636-1665`](src-tauri/src/ai/router.rs:1636)

这条路径专供书籍摘要（`ai/grounding/summarize.rs:170` 调 `complete_with_profile`，后者调 `stream_with_profile_inner`）。它遍历凭据的循环长这样：

```rust
for credential in credentials_for(db, profile_id, now())? {
    match stream_once_with_effort_fallback(..., Arc::new(AtomicBool::new(false)), cancel).await {
        Ok(()) => return Ok(profile.view),
        Err(error) if is_cancelled(&error) => return Err(error),
        Err(error) => last_error = Some(error),   // ← 无条件继续下一把 key
    }
}
```

对比主路径 [`stream_with_failover_inner`](src-tauri/src/ai/router.rs:1961)，那里有一道 `if !may_continue_after(kind, emitted.load(...)) { return Err(error); }`。这条路径**没有**。三个后果：

1. **内容重复。** `emitted` 在这里是 `Arc::new(AtomicBool::new(false))` 内联创建、创建完就没人读了，所以「已经吐字了就不许换 key」这条保护完全失效。如果第一把 key 流到一半断线，它会拿第二把 key **从头重跑**。而 `complete_with_profile` 的 listener 是**整个调用期间共用一个 `String`**（[`router.rs:1678`](src-tauri/src/ai/router.rs:1678)），两次尝试的 delta 会拼在一起 —— 摘要正文里会出现一段重复的内容。
2. **不可重试的错误也照试不误。** 一个 400（比如 model 名字打错）会把该 profile 下**每一把 key 都试一遍**，每次都 400。主路径靠 `kind.retryable()` 短路，这里没有。
3. **健康度完全不记。** 这条路径一次都不调 `update_credential_health` / `update_profile_health`。书籍摘要跑失败多少次，设置界面里的健康状态都不会变。这**可能是有意的**（跟 `list_models` 一样，「探测性操作不该污染推理健康度」），但 `list_models` 把这个决定写进了注释（[`router.rs:1400-1403`](src-tauri/src/ai/router.rs:1400)），这里什么都没写。需要确认是决策还是遗漏。

**改动成本**：小。加一道 `may_continue_after` 检查 + 把 `emitted` 提到循环外正确使用，大约 10 行。第 3 点要先确认意图。

**建议：先改。** 这是全篇唯一一个用户能看见的缺陷，且改动局限。

### B. `classify_error` 的四个具体盲区 —— **建议做，配合 3.1**

**位置**：[`router.rs:176-241`](src-tauri/src/ai/router.rs:176)

3.1 说的是机制层面（字符串反解本身脆弱），这里是四个已经存在的具体后果：

1. **`quota` 分支排在 `rate_limit` 前面，且丢掉 Retry-After。** 判断顺序是 `status=402 || quota || insufficient` → Quota，然后才轮到 `status=429 || rate limit` → RateLimit。一个 **429 而 body 里出现 "quota" 字样**的响应会被判成 Quota。代价是双份的：Quota 固定冷却 **1 小时**，而且 [`update_credential_health`](src-tauri/src/ai/router.rs:1008) 的 Quota 分支**根本不读 `retry_after`** —— 供应商明说了「30 秒后重试」也会被忽略，用户白等一小时。OpenAI 真正的 `insufficient_quota`（余额耗尽）判成 Quota 是对的，但网关把限流报文写成 "quota exceeded, retry after 30s" 的非常常见。

2. **`contains("insufficient")` 太宽。** 上游返回 "insufficient capacity"（本质是容量不足，属于 5xx 类瞬时故障）会被判成 Quota → 1 小时冷却，而不是 Provider5xx → 30 秒。一个本该 30 秒后自愈的抖动，把这个 profile 踢出路由整整一小时。

3. **匹配的是未脱敏的原始字符串。** `classify_error` 读的是 `error.to_string()` 全文，里面可能带 base_url、model 名、供应商回显的部分请求内容。用户的自定义 base_url 里如果出现 `quota`、`forbidden`、`protocol` 这类词，就会污染分类。注意 `sanitized_error_detail`（[`router.rs:247`](src-tauri/src/ai/router.rs:247)）只在**上报给前端时**脱敏，分类路径上没有这层。

4. **漏了 529。** 5xx 的判断硬编码了 `500/502/503/504`。Anthropic 的过载状态码是 **529**，会落到默认的 `Network` 分支。行为上恰好无害（Network 和 Provider5xx 都是 30 秒冷却），但**诊断信息是错的**：`last_error_kind` 会记成 `network`，用户在设置里看到的是「网络问题」而不是「供应商过载」。顺带一提，这段的写法本身也绕了一圈：`[" 500", " 502", ...].iter().any(|code| message.contains(&format!("status={}", code.trim())))` —— 先给字面量加空格再 trim 掉，等价于直接写 `["500","502",...]`。

**改动成本**：如果只修这四条，小（调整顺序 + 收紧 `insufficient` + 补 529）。如果按 3.1 做结构化，中等，但这四条会一起消失且不会再长回来。

### C. 遍历循环的三个分支是复制粘贴，而且已经不一致 —— **建议做，和 F 一起**

**位置**：[`stream_with_failover_inner`](src-tauri/src/ai/router.rs:1758)，约 260 行

主遍历循环里有三段独立分支：OAuth（[1786-1851](src-tauri/src/ai/router.rs:1786)）、Ollama（[1853-1902](src-tauri/src/ai/router.rs:1853)）、api_key（[1904-1989](src-tauri/src/ai/router.rs:1904)）。三段的成败处理几乎逐字重复同一套动作：`update_*_health` → `emit_route_fallback` → `may_continue_after` → `log::warn!` → `last_error = Some(error)`。粗算 200 行里 120 行是重复的。加上 [`stream_with_profile_inner`](src-tauri/src/ai/router.rs:1581)，同一套逻辑一共有**四份拷贝**。

**风险不是「不好看」，是四份拷贝已经互相不一致了**：

- OAuth / Ollama 分支用 `started`（本次尝试起点）记 latency；api_key 分支用 `profile_started`（该 profile 第一把 key 的起点）。同一个字段 `last_latency_ms`，两种语义。
- `stream_with_profile_inner` 干脆什么健康度都不记（见 A）。
- A 里说的 `may_continue_after` 缺失，正是「第四份拷贝没跟上前三份」的直接产物。

以后每改一次容错策略，都要记得改四个地方 —— 这次已经漏了一次。

**改法**：把「拿到凭据」和「跑一次 + 记健康度」拆开。前者收成一个 `enum ProfileAuth { Oauth { token, account_id }, None, Key { credential, secret } }` 的迭代器，后者收成一个函数。三个分支的差别只剩「怎么拿凭据」和「失败要不要记 credential 级健康度」。

**改动成本**：中等。**必须和 F（端到端测试）一起做**，否则这种重构没有安全网。

### D. 取消注册表有一个小竞态窗口 —— **可做，改动三行**

**位置**：[`register_request`](src-tauri/src/ai/router.rs:311) / [`cancel_request`](src-tauri/src/ai/router.rs:329)

`cancellation_registry()` 和 `pending_cancellations()` 是**两把独立的 Mutex**。两个函数各自跨这两把锁做两步操作，中间没有共同的临界区：

```
线程 A（cancel_request）：查 registry → 空（还没注册）
线程 B（register_request）：take_pending → 空 → 插入 registry
线程 A：record_pending_cancellation → 写 pending
```

结果：B 拿到的 `watch::Receiver` 永远收不到 `true`，而 pending 里留着一条孤儿记录（会被 TTL 清掉，不会累积）。

**后果有限但不为零。** `request_is_cancelled` 同时查两张表，所以**轮询式的检查点**（多步任务在每一节之间的检查）还能捕获到。但 [`stream_once`](src-tauri/src/ai/router.rs:1152) 里那个 `tokio::select! { _ = wait_cancelled(cancel) }` 是靠 watch channel 醒的，它**不会醒**。也就是说落在这个窗口里的「停止」点击，对正在流式传输的那一段无效，要等到下一个检查点才生效。窗口很窄（两次锁获取之间），但代码路径是真实存在的。

**改法两种，都便宜**：把两张表合并到同一把 Mutex 下；或者更省事——`register_request` 在插完 registry **之后再 take 一次 pending**，三行代码就补上了。

**改动成本**：极小。

### E. 三份 credential 行映射逐字重复 —— **顺手清理，零风险**

[`credentials_for`](src-tauri/src/ai/router.rs:893)、[`all_credentials_for`](src-tauri/src/ai/router.rs:923)、[`credential_by_id`](src-tauri/src/ai/router.rs:952) 三个函数里，那段 11 个字段的 `AiCredential { secret_ref, view: AiCredentialView { ... } }` 构造**逐字重复了三遍**，每遍约 20 行，列名字符串也重复三遍。

关键是**这个文件里已经有正确的做法**：profile 侧用 `const PROFILE_COLUMNS` + `fn row_to_profile`（[`router.rs:447-472`](src-tauri/src/ai/router.rs:447)）。credential 侧只是没照着套。加一个 `CREDENTIAL_COLUMNS` 常量和一个 `row_to_credential` 函数，能删掉约 50 行，且和既有模式完全一致。

**改动成本**：极小，零风险（纯机械提取）。不值得单独排期，跟着 C 一起做。

### F. 冷却期表重复了两遍 —— **顺手清理**

[`update_credential_health`](src-tauri/src/ai/router.rs:1002) 和 [`profile_health_state`](src-tauri/src/ai/router.rs:1058) 里的 match 表，分支和数值一模一样，只有两处不同：`Request` 在 credential 侧是 `active`、profile 侧也是 `active`；`NotConfigured` 在 credential 侧是 `active`、profile 侧是 `unavailable`。

也就是说 12 个分支里有 11 个完全重复。可以让 credential 侧复用 `profile_health_state` 再覆盖 `NotConfigured` 那一个分支。这样将来调整任何一个冷却时长，只需要改一处 —— 现在要改两处，而且没有任何机制保证你不会漏。

**改动成本**：极小。

### G. 测试覆盖缺口 —— **和 C 绑定做**

先说结论：**现有测试比大多数项目好**。4,180 行里 1,040 行是测试，约 40 个 case，覆盖了错误分类、冷却期语义、effort 学习与降级、model list 的凭据轮换、secrets 删除/替换失败时的补偿回滚。测试名字本身就是文档（`a_spent_free_model_leaves_the_route_until_its_window_ends`、`nothing_switches_models_once_output_has_reached_the_reader`）。而且 [`model_list_server`](src-tauri/src/ai/router.rs:3610) 已经证明了在这个文件里起本地 HTTP server 做端到端测试是可行的。

缺的是三块：

1. **`stream_with_failover_inner` 本身没有任何端到端测试。** 现在测的都是它**调用的谓词**——`may_continue_after`、`profile_health_state`、`routable_profiles`、`classify_error`。这些谓词全对，不代表把它们串起来的那 260 行是对的。「profile A 返回 401 → 换到 profile B → B 成功 → 发出了 ai-route-fallback 事件 → A 的 cooldown_until 被正确写入」这条主线**从没被整体验证过**。C 里发现的四份拷贝不一致，正是这个缺口的产物。`model_list_server` 的套路直接搬过来就能补上。
2. **D 说的竞态没测。** 现有的两个取消测试（`dropped_cancel_sender_does_not_cancel_request`、`live_cancel_sender_wakes_request`）测的是 watch channel 本身的行为，没测 registry 和 pending 两张表的交互。
3. **A 说的 `stream_with_profile_inner` 失败行为没测。** 它是四份拷贝里唯一一份带真缺陷的，也是唯一一份完全没有测试的。

**改动成本**：中等。但如果要做 C（合并四份拷贝），这块**必须先做**——没有端到端测试就重构容错逻辑，是在拿用户的失败路径赌。

---

## 5. 结论

### 整体值不值得动

**不值得大动。**

router.rs 是这个仓库里注释质量最高的文件之一。几乎每个非显然的决定都写清了「为什么」，而且带实测数据支撑 —— 比如为什么要主动发 `reasoning_effort: none` 而不是留空（同一张查词卡，字段留空 43.4 秒 / 16.7k 推理字符，明确写 `none` 是 8.5 秒），比如为什么只有 Anthropic 才发 token 上限（OpenAI 兼容端点上这个上限会把预算全花在推理上，返回 `finish_reason: length` 加一个空答案）。这类知识是踩过坑才有的，重写会全部丢失。

架构上也没有需要推翻的东西。profile / credential 两层、冷却期持久化、取消注册表、effort 协商——每一层都对应一个真实需求，没有为了抽象而抽象的部分。4,180 行里 1,040 行是测试，实现约 3,100 行，对它承担的职责不算臃肿。

**从 cc-switch 能抄的只有一条**：错误分类不该建立在「把状态码 format 成字符串再 contains 回来」上（3.1）。其余的熔断三态、错误率阈值、参数热更新、切换去重，要么是网关场景才需要的，要么 Lantern 已有更贴合自己场景的等价物。这不是给面子的说法 —— 逐行读完那四个文件后，确实没找到第二条。

需要说明的是，第 4 节的六条问题**都是自查发现的，跟 cc-switch 无关**。如果只做对标，这份报告的结论会是「基本没什么好抄的」；有价值的部分反而在对标之外。

### 如果动，第一刀切哪里

按这个顺序：

| 顺序 | 做什么 | 为什么排这里 | 规模 |
|---|---|---|---|
| **第一刀** | **A —— `stream_with_profile_inner` 的重复输出** | 全篇唯一一个**用户能看见**的缺陷（摘要正文出现重复段落），且改动局限在一个函数里 | ~10 行 + 一个测试 |
| 第二刀 | B —— `classify_error` 的四个盲区 | 影响的是「失败之后多久能恢复」，用户感知为「AI 莫名其妙用不了一小时」。可以先只修那四条，不动机制 | 小 |
| 第三刀 | G + C —— 先补端到端测试，再合并四份拷贝 | 必须捆绑：没测试就重构容错逻辑等于裸奔。收益是以后改容错策略只需改一处 | 中 |
| 第四刀 | D —— 取消注册表的竞态 | 后果轻（窄窗口内的停止点击延迟生效），但修法只要三行 | 三行 |
| 顺手 | E、F —— 两处复制粘贴 | 零风险的机械提取，跟着第三刀一起做，不单独排期 | 各 ~20 行 |
| 待定 | 3.1 结构化错误分类 | 是 B 的根治方案。如果 B 之后还继续踩分类的坑，再上这一刀 | 中 |
| 不做 | 3.2 / 3.3 / 3.4 | 场景不匹配，理由见对应小节 | — |

**一个前置动作**：A 的第 3 点（`stream_with_profile_inner` 不记健康度）要先确认是有意还是遗漏。如果是有意的，补一行注释说明理由就行（对齐 `list_models` 那段的写法）；如果是遗漏，那它属于 A 一起修。这个判断需要看当初的意图，代码里没写。

---

## 6. 实施记录（2026-08-05）

用户批准「技术上的问题全部按照你的推荐进行修改」后，A–G 全部落地，顺序与上表一致。四次提交，全部直推 `main`：

| 提交 | 内容 | 结果 |
|---|---|---|
| `a472347` | A + 运行时泛型 | 修复重复输出；补记 credential / profile 健康度 |
| `ea01f14` | B + F | 状态码改为解析数值；配额按 code 判定；冷却表合并 |
| `c5e1f81` | D | 取消与注册的临界区合并 |
| `8ffef55` | C + E + G | 四份遍历合一；credential 行映射合一；补四个端到端测试 |

验证：`cargo test --lib` 745 passed / 0 failed，`cargo clippy --all-targets` 无告警，`cargo fmt --check` 干净。改动只落在 `src/ai/` 的四个文件里，未触碰另一个对话正在重构的 `commands/ai.rs`。

**三个需要说明的判断**（都与调研阶段的表述有出入，据实记录）：

1. **A 的前置动作按「遗漏」处理。** `list_models` 跳过健康度记录有明确理由——供应商可能拒绝 `/models` 却允许推理，且那条路径可能在探测尚未保存的草稿配置。`stream_with_profile_inner` 是对已保存 profile 的真实推理，两条理由都不成立，所以补上记录。

2. **G 的实施成本比预估大。** 原以为照搬 `model_list_server` 就能测流式路径，实际不行：整条流式链路写死了 `AppHandle<Wry>`，而 `tauri::test::mock_app()` 只能给出 `AppHandle<MockRuntime>`。所以先把 `src/ai/` 四个文件的运行时改成泛型 `R: Runtime`（调用方不变，R 推导为 Wry），端到端测试才写得出来。这也解释了为什么 A 这个 bug 能活下来而可测的 `list_models` 路径是对的——测试写不了的地方，错误就积在那里。因此运行时泛型与 A 同提交，而非单列。

3. **D 的测试不能复现旧竞态。** 窗口只有几条指令宽，两线程对旧代码跑几千轮也没丢过一次取消。测试保留下来锁的是不变量，不是复现旧 bug——注释里已据实写明，不要当成回归证据读。

**另外三点小的行为变化**，超出调研时列的四个盲区，一并记在这里：

- 未列出的 4xx（405 / 409 / 415）从 `Network`（可重试，逐把 key 轮一遍）改判为 `Request`（立即停）。所有能指认「某把 key」或「额度」的 4xx 都已被前面的分支认领，剩下的就是请求本身的形状问题。
- 529（Anthropic `overloaded_error`）从 `Network` 改判为 `Provider5xx`。冷却时长相同，纯粹是设置页别再报错误的病因。
- 配额冷却开始认 `Retry-After`，与限流一致。一小时是 Lantern 在猜额度何时重置，供应商说了时间就不该再猜。

---

*调研阶段只读；第 6 节记录的实施改动已提交至 `main`。*
