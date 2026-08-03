# 把 Quill 的残留改名成 Lantern

> 这份文档是给**新会话**的交接说明。直接把它读完就能开工，不需要追问上下文。
> 工作目录固定为 `~/vibecoding/Lantern`（这台机器上还有别的旧克隆，都是过期的，不要动）。

## 背景

Lantern 早期是 fork 自 [yicheng47/quill](https://github.com/yicheng47/quill)，之后已经全面改名。
但改名**只做到了用户看得见的那一层**：

- `src-tauri/tauri.conf.json` — `productName: "Lantern"`、`identifier: "com.klaragraff.lantern"`、窗口 `title: "Lantern"`
- 打包产物是 `Lantern_x.y.z_aarch64.dmg`

**机器内部怎么称呼它，一处没动。** 截至 2026-08-02，全仓库仍有约 **658 处** `quill`
（不区分大小写，已排除 `node_modules` / `dist` / `target` / lock 文件）。分布：

| 位置 | 处数 |
|---|---|
| `docs/`（84 个文件，其中 54 个在 `archive/`） | 368 |
| `src-tauri/src/` | 150 |
| 其余（`src/`、CI、iOS 工程、构建脚本等） | ~140 |

最直接的症状：`src-tauri/Cargo.toml` 第 2 行仍是 `name = "quill"`，
所以 cargo 产出的二进制叫 `target/debug/quill`，`pgrep` 看到的进程名也是 `quill`。

## 任务

**范围已经定了，不需要再问：第 1、2、3 档全部改掉，第 4 档原样保留。**

分档保留在这里，是因为它们的**做法**不同（有的能直接 sed，有的必须带迁移），
不是因为要不要做还没定。定这个范围时用户给的两条前提：

- 第 2 档的一次性迁移成本可以接受 —— 这是私人自用的应用，不必为兼容性设计长期回退路径。
- 第 3 档的 MCP 目前没有任何人在用，所以对外身份可以放心改。

第 4 档是硬约束，见那一节。

---

### 第 1 档 — 纯改名，零风险，可以直接做

这些标识符不落盘、不对外，改了没有任何迁移成本。

**前端内部标识（`src/`）**

| 现值 | 位置 |
|---|---|
| `data-quill-chapter-start` | [chapter-pagination.ts:1](../../../src/pages/reader/chapter-pagination.ts)、[reader-theme.ts:148](../../../src/pages/reader/reader-theme.ts) |
| `"quill-word-marks"` | [useFoliateAnnotations.ts:313](../../../src/pages/reader/useFoliateAnnotations.ts) |
| `"quill-custom-font-faces"` | [custom-fonts.ts:23,36](../../../src/components/custom-fonts.ts) |
| `"quill-builtin-font-faces"` | [builtin-fonts.ts:114](../../../src/components/builtin-fonts.ts) |
| `QuillCustom-` 字体族前缀 | [reader-settings.ts:161](../../../src/components/reader-settings.ts) |

⚠️ **`QuillCustom-` 要确认一次**：如果自定义字体的 family 名被写进了设置或数据库，
改前缀会让老用户已选的字体失效。先确认它是每次渲染时生成的再改。

**CI 环境变量名（`.github/workflows/release.yml`）**

`QUILL_BUILD_COMMIT` / `QUILL_BUILD_DATE` / `QUILL_BUILD_CHANNEL` / `QUILL_UPSTREAM_BASELINE`
→ `LANTERN_*`。注意这些名字在 Rust 侧用 `env!()` / `option_env!()` 读取，
`src-tauri/build.rs` 和 `src-tauri/src/commands/app.rs` 要同步改，**必须一起改，否则版本信息会变空**。

**文档与注释**

`docs/` 下**非 archive** 的部分（约 30 个文件）+ 所有 Rust/TS 注释里的 `Quill`/`quill`，
在指的是"本应用"时改成 Lantern。指上游项目时保留（见第 4 档）。

---

### 第 2 档 — 要带一次数据迁移

这一档改的都是**已经落在磁盘上**的名字，所以不能直接改字符串了事。
但因为是私人自用，迁移写成**一次性的**就够了：认一次旧名字、搬过去、以后不再看它。
不需要长期双读，也不需要考虑跨版本回退。

**a) `localStorage` 键名**

| 现值 | 位置 |
|---|---|
| `quill-theme` | [App.tsx:45](../../../src/App.tsx)、[main.tsx:32](../../../src/main.tsx) |
| `quill-language` | [i18n/index.ts:8](../../../src/i18n/index.ts) |

直接改会让老用户的主题和语言设置丢失（回落到 system / 默认语言）。
**做法**：读取时先查新键，查不到再查旧键并写回新键，旧键删掉。写一次就够，不需要长期保留。

**b) 导出文件名 `quill-notes.csv`** — [NotesContent.tsx:135](../../../src/components/NotesContent.tsx)

这个其实**用户看得见**，属于改名漏网，直接改成 `lantern-notes.csv`，无迁移成本。

**c) `quill.db` —— 这是要害**

数据库文件名硬编码在 [db.rs:247](../../../src-tauri/src/db.rs)（另有 `db.rs:227`、`250` 的注释，
以及 `636`、`637`、`751`、`1085`、`1217` 的测试断言）。

**直接改文件名 = 每个老用户的书库、笔记、词汇、标记凭空消失。**
必须在打开数据库前加一次迁移：目标路径不存在、且同目录下存在 `quill.db` 时，
把 `quill.db`、`quill.db-wal`、`quill.db-shm` 三个文件一起改名，再打开。
WAL 模式下漏掉 `-wal`/`-shm` 会丢掉最后一批未 checkpoint 的写入。

迁移要有测试：造一个只含旧文件的目录，跑一次 init，断言数据还在。
`db.rs` 里已有 `repair_legacy_word_mark_ids` 这类迁移的写法可以参照。

> `secrets.db` 不含 `quill` 字样，不用动。

---

### 第 3 档 — 会波及 app 之外（已确认要改）

**a) Cargo 包名 / 二进制名**

`src-tauri/Cargo.toml`：`name = "quill"` → `lantern`，`[lib] name = "quill_lib"` → `lantern_lib`。
连带 `src-tauri/src/lib.rs`（25 处）、`main.rs`、`build.rs`、`src-tauri/tests/mcp_binary.rs`（19 处）
里的 `quill_lib::` 引用，以及 `Cargo.lock`（改完跑 `cargo check` 同步）。

**b) MCP 服务器身份 —— 风险在这里**

Lantern 的 MCP server 以 `quill mcp` 的形式跑在 stdio 上，对外身份也叫 `quill`
（[server.rs:64](../../../src-tauri/src/mcp/server.rs) 的 `Implementation::new("quill", …)`）。

关键是：这个名字被**写进用户自己机器上的配置文件**——
`~/.claude.json` 的 `mcpServers.quill`，和 `~/.codex/config.toml` 的 `[mcp_servers.quill]`
（见 [commands/mcp.rs](../../../src-tauri/src/commands/mcp.rs)）。

一般来说这是要慎重的地方 —— 改名会让已有的 MCP 配置失效，而那些文件不在 app 的管辖范围内。
**但用户已经确认：这个 MCP 目前没有任何人在用。** 所以直接改干净，不要为兼容性留双读逻辑：

- `Implementation::new("quill", …)` → `"lantern"`（[server.rs:64](../../../src-tauri/src/mcp/server.rs)，
  连带 `server.rs:354` 的断言）
- `mcpServers.quill` / `[mcp_servers.quill]` 的键名 → `lantern`
  （[commands/mcp.rs](../../../src-tauri/src/commands/mcp.rs) 的 96、135、139、168 行及注释）

改完之后，用户如果自己在 `~/.claude.json` 或 `~/.codex/config.toml` 里连过旧的 `quill`，
需要去设置里重新连一次 —— 旧条目不会被自动清理，记得在收尾时提醒一句。

**c) iOS 工程** — `src-tauri/gen/apple/quill.xcodeproj`、`quill_iOS.xcscheme`、`project.yml`、`Podfile`

这些是 `tauri ios init` 生成的。别手改，改完 Cargo 包名后重新生成一次即可。

---

### 第 4 档 — 不要动（用户明确强调过两次）

**a) 上游署名（MIT 协议要求）**

- `settings.about.originalRepository` — "原始 Quill 仓库" / "Original Quill repository"
- `settings.about.basedOn` — "基于 yicheng47 的 Quill · MIT 许可证"
- `UPSTREAM_REPOSITORY_URL = "https://github.com/yicheng47/quill"` — [AboutSettings.tsx:12](../../../src/components/settings/AboutSettings.tsx)

删掉或改名是**违反 MIT 许可证**的。原样保留。

**b) 归档文档**

`docs/*/archive/**`（54 个文件）和 `docs/reviews/quill-v2.0.0-audit-2026-07-15.md`
记录的是当时的事实，改了反而失真。原样保留。

---

## 验收

```bash
npx tsc --noEmit && npm run lint && npm run test:unit && npm run build
```

```bash
cd src-tauri && cargo check && cargo test
```

改完之后，确认残留只剩第 4 档该留的部分：

```bash
rg -i quill --hidden -g '!node_modules' -g '!dist' -g '!target' -g '!.git' -g '!*.lock' -g '!package-lock.json' .
```

另外必须**手动**验一次：拿一个改名前的 `quill.db` 放进 app 数据目录，启动 app，
确认书库、笔记、词汇、标记全都还在。这一条自动化测试替代不了。

## 提交约定

见 `AGENTS.md`：**直接提交到 `main`**，不开 PR（除非需要 CI 把关或用户要求）。
按档位分开提交，不要一个大提交 —— 尤其 `quill.db` 的迁移应该单独一个，方便出问题时回滚。
提交信息末尾带 `Co-Authored-By:` 行。
