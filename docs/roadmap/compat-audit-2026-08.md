# 兼容层排查 2026-08

Lantern 从未上线，没有任何真实用户数据。所有为「假想的旧数据 / 旧代码路径」写的兼容
代码都是没必要的技术债，趁未发布一次性清掉。本文是执行清单。

排查方法：后端（`src-tauri/src`）与前端（`src/`、`public/foliate-js/`、i18n）各一轮全量
grep + 逐处阅读，死代码结论一律用跨全仓 grep 复核。凡是「旧数据是否还实际存在」的问题，
不靠推测，直接查本机数据库（见下节）。

---

## 一、实测：旧数据到底还在不在

三项待定都属于同一类问题——「防的那种旧数据，今天还有吗」。直接对本机两个数据库做只读
查询，结论如下（2026-08-05）：

| 查的东西 | `com.klaragraff.lantern` | `…lantern-dev` |
|---|---|---|
| 书籍格式 | epub × 3 | epub × 1 |
| V1 文本书锚点（`textloc:` 非 v2） | 0 | 0 |
| 非规范 id 的词标记规则 | 0 / 共 10 条 | 0 / 共 0 条 |
| 非规范 id 的查词位置标记 | 0 | 0 |
| 带内联备注的高亮 | 0 | 0 |

Quill 时期的目录确实还在（`com.klaragraff.quill-dev`、`com.wycstudios.quill-dev`、
`com.klagragraff.quill-dev`，其中一个还有 1 本书），**但认领逻辑永远不会再触发**——它的
前置判断是「目标目录里还没有书库」，而两个 Lantern 目录都已经有书库了。也就是说这套代码
已经把它的使命执行完了，此后是永久空转。

结论：三项全部可删，依据是实测而非推测。

---

## 二、不许删的三类（删了会出事）

1. **`src-tauri/migrations/` 里已跑过的迁移脚本。** 迁移是只进不退的历史。哪怕某条今天
   看已经多余，删掉会让新装机器与老机器算出不同的数据库。
2. **`sync/events.rs` 里的空操作事件分支（墓碑）。** 同步日志只追加不改写，老日志里躺着
   的事件类型若从枚举里消失，会反序列化失败并使同步整体失效。已确认属于此类：
   `HighlightNoteSet`、`TranslationAdd`/`TranslationDelete`，以及 `VocabPayload` /
   `VocabMasterySet` 上那些 `#[serde(default)]` 字段（同一道理的字段级形态）。
3. **`public/foliate-js/` 里的上游兼容代码。** 按该目录 `LANTERN.md`，其中的 Safari 15 /
   PDF.js / zip.js 兼容路径服务于 macOS 12 的 WKWebView——一个当前仍在支持的运行环境，
   不是历史数据。

另外两类**看着像、其实不是**，一并记下以免误伤：

- `Snapshot::from_legacy_db`（`sync/snapshot/apply.rs`）：名字带 legacy，实为「本地库首次
  开启同步」的引导路径，每个未来用户都会走一次。
- `sync/peers.rs` 的 `LEGACY_MAX_EVENT_SCHEMA` 与 `MIN_SUPPORTED_EVENT_SCHEMA_VERSION`：
  是 Mac / iOS 两端事件协议版本协商，不是旧数据容忍。
- `useContinuousReadAloud.ts` 的 `clearLegacyHighlight`：清的是**另一套仍在用的**高亮
  （单段朗读 vs 连续朗读），不是新旧两版。名字误导，代码没问题。
- `ToolsSettings.tsx` 的 `persistLegacy()`：只是一个存单个设置项的普通函数，那几个键没有
  「新版」对应物。同样是名字误导。

---

## 三、确认可删（按牵连范围从小到大）

### A 组：单文件，纯删除

| # | 位置 | 是什么 | 牵连 |
|---|---|---|---|
| A1 | `commands/word_marks.rs:649-659` | `upsert_word_mark`，注释自称「兼容别名」，全仓零调用 | 本文件 + `lib.rs` 一行 |
| A2 | `secrets.rs:22-26,92-94` | `RETIRED_VAULT_TABLES`：每次启动去 DROP 三张早已没人创建的表 | 本文件 + 一个测试 |
| A3 | `commands/vocab.rs:107-118,1604-1622` | 生词备份导入接受旧产品名 `quill-vocabulary` | 本文件 + 两个测试 |
| A4 | `secrets.rs:347-392` | `migrate_from_settings`：每次启动把敏感键从明文设置搬进密钥库。写入侧现已**硬性拒绝**敏感键写进 `settings`（有测试为证），此路不可能再产生数据 | 本文件 + `lib.rs` 调用点 |
| A5 | `ai/router.rs:2245-2299` | `migrate_embedding_source`：每次启动回填向量检索配置。唯一开启入口现在总会写那个标记位 | 本文件 + `lib.rs` 调用点 |
| A6 | `hooks/useAiChat.ts:267-274` | AI 对话结果的「裸数组」解析分支，注释写明是 v1.5 开发版的形状 | 本文件 |
| A7 | `pages/reader/useReaderZoom.ts:5-22` | 模块级自执行的 localStorage 迁移，把旧缩放值改写成 `fit`，`reader-zoom-v2` 标记无人再读 | 本文件 |
| A8 | `App.tsx:62-69` | 字体变更事件的载荷形状回退，注释写明是开发期热重载的过渡产物 | 本文件 |

### B 组：机械改动，多文件

| # | 位置 | 是什么 | 牵连 |
|---|---|---|---|
| B1 | `components/page-turn-bindings.ts` | 整个文件是「兼容入口」，只做转发 | 删文件 + 4 处 import 改路径 |
| B2 | `commands/ai/lookup.rs` 的 `ai_lookup` + `lookup_system_prompt` + 约 7 个测试；`components/LookupPopover.tsx` | 已死：唯一调用方是 `LookupPopover`，而它自己零引用 | 1 Rust 文件 + `lib.rs` 一行 + 1 前端文件。**注意**：同文件的 `lookup_memory` / `lookup_memory_block` 仍在被学习卡使用，不能删 |

### C 组：前后端成对，必须一起改（只改一半会留下半截逻辑）

| # | 是什么 | 前端 | 后端 |
|---|---|---|---|
| C1 | `explanation_mode` 的旧值 `"target_language"` | `settings/GeneralSettings.tsx:99-102,171-172` | `commands/ai/prompt.rs:21-28,35` + 两个测试 |
| C2 | `lookup_translation_language` 作为 `translation_language` 的回退读取（旧键名，现已无人写入） | `GeneralSettings.tsx:158-159,173`、`ToolsSettings.tsx:214-215`、`TranslationPopover.tsx:93` | `ai/explain.rs:52-53`、`vocabulary.rs:460-461`、`learning_card.rs:464-465`、`custom_action.rs:109-110`、`lookup.rs:272-273` |

C2 前端有一处要小心：`TranslationPopover.tsx:93` 是 `s.translation_language \|\| s.language \|\| "en"`，
只有旧键那一半是债，`\|\| s.language` 是「还没设置过」的正常兜底，必须保留。

### D 组：实测确认已无对应数据，可删（牵连最大，最后做）

| # | 是什么 | 依据 | 牵连 |
|---|---|---|---|
| D1 | Quill → Lantern 目录/库文件认领：`db.rs` 的 `LEGACY_DB_FILE_NAME`、`library_exists_in`、`rename_legacy_db_file`；`lib.rs` 的 `migrate_legacy_app_data` | 两个目标目录都已有书库，认领分支永久不再触发 | `db.rs` + `lib.rs` + 2 个测试 |
| D2 | 非规范标记 id 修复：`db.rs:417-526` 的 `repair_noncanonical_marker_ids` 及两个子函数，以及 `run_migrations` 里的调用 | 实测两库共 10 条规则、0 条非规范 id | `db.rs`。**注意**：`sync/merge.rs` 的 `reconcile_legacy_word_mark_exceptions` 不能删，它同时服务于仍在用的取消/重建流程，只是名字带 legacy |
| D3 | V1 文本书定位：后端 `commands/books/mod.rs:172-175` 的 `legacy_locations` 字段、`text_headings.rs:79-110`、`text_prepare.rs:33-41`；前端 `components/text-book-location.ts` 的 `LegacyTextLocation` / `textloc:v1` 解析 | 实测 0 条 v1 锚点，且两库根本没有纯文本书 | 后端 3 文件 + 约 15 行测试夹具 + 前端 1 文件。这是全表最大的一项，但也是每次打开纯文本书都在白算的一张表 |

### E 组：i18n 孤儿词条

排查时机器核对出 97 个零引用词条（en/zh 各一份），聚成几块可辨认的遗留：旧 AI 设置页
16 个、旧查词/翻译独立设置页 19 个、旧关于页 2 个、被 `summaryDensity*` 取代的被动词汇
3 个、从未接线的更新提示 7 个，以及约 50 个零散项。

**这份名单已经过期，执行时必须重算。** 排查之后落地了三个提交（笔记页改标注页删掉了
`NotesContent.tsx`，会新增一批 `notes.*` 孤儿；另一条会话新增了 `settings.layout.*` 等
词条，会让其中几个不再是孤儿）。执行时重新跑一遍机器核对，不要照抄这里的数字。

核对要点：必须处理动态拼接的 key（`t(\`prefix.${var}\`)`），否则会误删仍在用的词条。

---

## 四、执行顺序

在 `chore/drop-compat-layers` 分支上，按 A → B → C → D → E 的顺序分批做，**每批单独提交、
单独跑验证**，不要攒到最后：

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets
npx tsc --noEmit && npm run lint && npm run test:unit
```

分批的理由不是谨慎，是可回溯：D 组三项每一项都动到启动路径或数据定位，真出问题时，一个
提交一个主题才定位得到是哪一项引起的。

E 组放最后，因为前面每一批都可能改变孤儿词条的集合。
