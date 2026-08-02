# 预设项目：可删除、可恢复默认

> 状态：待实施。本文只描述改造方案，不含任何已落地的代码。
>
> 文件名沿用需求里的 `deletable-preset-items.md`。改造的两半（可删 + 可恢复）是同一件事的两面：没有「恢复默认」的删除不敢做，没有删除的「恢复默认」没有意义，所以不拆成两份文档。

## 一句话结论

出厂预设项**必须可删且删得掉**（重启后不复活），**且必须能原样找回**。当前只有「书籍来源」两条都满足；「操作菜单」和「卡片模块」两条都不满足 —— 内置项根本没有删除入口，而且即使删掉，`parseCardDesignConfig` 会在下次解析时把它补回来。核心改造在数据层：给 `learning_card_config` 引入**删除墓碑（tombstone）**，让「从没配置过」和「主动删光了」在存储上可区分。

---

## 1. 现状表

扫描范围：`src/components/settings/**`、`src/components/*.ts`、`src/hooks/**`、`src-tauri/src/commands/**`、`src-tauri/migrations/**`。

### 1.1 真正的「预设项目」列表（本需求的改造对象）

| # | 位置 | 条目 | 可删 | 可恢复默认 | 存储 | 删除能否持久化 |
|---|---|---|---|---|---|---|
| P1 | 设置 → 阅读辅助 → 操作菜单<br>`settings/SelectionMenuSettings.tsx` | 查词/解读、朗读、问 AI、收藏、标记、复制、翻译 + 自定义动作 | **内置：否**（只有开关）<br>自定义：是 | **否** | `learning_card_config` → `selectionMenus[kind]: SelectionMenuItemConfig[]` | **否** —— `parseMenu` 补回缺失内置项 |
| P2 | 设置 → 阅读辅助 → 卡片设计 → 模块<br>`settings/CardDesignSettings.tsx` + `CardModuleRow.tsx` | 当前语境含义、单词信息、目标语言译文、常见释义、常用搭配、词形与构词、语法角色、近义词辨析…… + 自定义模块 | **内置：否**（只有开关）<br>自定义：是 | **否** | 同上 → `cards[kind].modules: CardModuleConfig[]` | **否** —— `parseModules` 补回缺失内置项 |
| P3 | 设置 → 书籍来源<br>`settings/BookSourcesSettings.tsx` | 7 个内置站点 + 用户添加 | **是**（全部，含内置） | **是**（底部「恢复默认」） | `book_sources`（JSON 数组）+ 哨兵键 `book_sources_seeded` | **是** —— `parseBookSources` 不补默认 |
| P4 | 设置 → 阅读辅助 → 交互 → 按键绑定<br>`settings/ReaderBindingsSettings.tsx` | 动作↔触发键的绑定 | **是** | 不适用（**出厂即空**，没有预设项可恢复） | `reader_bindings`（`{version:1,bindings:[]}`） | **是** —— `parseReaderBindings` 不补默认 |

**要害在最后一列。** P1/P2 的补默认代码是同一段，各出现一次：

```ts
// src/components/learning-card/config.ts:213（parseModules）与 :305（parseMenu）
for (const fallback of defaults) {
  if (!seen.has(fallback.id)) parsed.push({ ...fallback });
}
```

这段不是 bug，它承担着一个真实职责：**让后续版本新增的内置项对老用户也可见**。仓库里已有测试锁定这个行为（`tests/selection-menu-config.test.ts` 的「read-aloud appears in a menu config saved before it existed」）。所以**不能简单删掉它** —— 见第 4 节。

### 1.2 扫到但不属于本需求的地方（逐条给出理由，避免下一个人重扫一遍）

| 位置 | 形态 | 为什么不改 |
|---|---|---|
| `settings/aiPresets.ts` → `AI_PRESETS` | 添加服务时的**目录/选择器**，不是用户的列表 | 用户的列表是 `ai_profiles` 表，**出厂为空**，用户自建、可删可排序。目录本身没有「用户的一份副本」可删 |
| AI 服务的凭据列表（`AiServiceCard.tsx`） | 出厂为空的用户列表 | 无预设项 |
| 阅读字体（`reader-settings.ts` `fonts` + `builtin-fonts.ts`） | 下拉选项 + 用户导入的自定义字体 | 内置项是下拉选项而非可增删条目；`setCustomReaderFonts` 结构上保证内置永远在 |
| 阅读主题（`READER_THEME_OPTIONS` / `themes`） | 固定选项 | 同上 |
| TTS 音色（`OPENAI_VOICES` + `speech_voice_hints`） | ComboBox 候选 | 同上；内置候选恒被再次提供，无条目 CRUD |
| 考试类型（`EXAM_OPTIONS`）与能力评估记录 | 下拉 + 用户记录 | 记录是用户数据，无出厂项。**其删除确认用的是行内两步确认，不是 `ConfirmDialog`** —— 见 3.4 的一致性说明 |
| 标记样式（`MarkerStyleSettings` / `MARKER_COLOR_PRESETS`） | 编辑两个固定样式对象 + 取色快捷色板 | 不是条目列表 |
| `CUSTOM_THEME_PRESETS` / `SPEECH_RATE_PRESETS` / `SYSTEM_MARKS` / `LANGUAGE_OPTIONS` / `CEFR_LEVELS` / `TRIPLE_CLICK_SCOPES` | 固定取值数组 | 输入辅助，非列表 |
| 同步设备、OCR 资产、词形表（`word_forms`） | 出厂为空的用户数据 | 无预设项 |
| `src-tauri/migrations/**` | —— | 全库只有两条 INSERT（一次笔记回填、一个标量默认 `ai_spoiler_guard`），**没有任何 SQL 播种的预设行**。所有内置列表都是 TS 常量在解析时合并 |

**哨兵键全库只有一个**：`book_sources_seeded`。

---

## 2. 产品语义（用户已拍板，实现时最容易理解错的一节）

### 2.1 删到最后一项

1. 列表只剩 1 项时再点删除 → 弹确认框。
2. 文案大意：**删除后这个板块将不再出现在阅读中的弹窗卡片里，随时可以在设置中恢复默认。**
3. 用户确认后**允许删光**，不强制保留任何一项。

### 2.2 「删光」= 板块被关闭，不是设置项被移除

> **⚠️ 这一条最容易做错。** 「板块不再出现」指的是**阅读中的弹窗**，不是**设置界面**。设置里那一节必须原样留着，否则用户就失去了点「恢复默认」的入口，删光变成不可逆。

| 层面 | 删光之后应该是什么样 |
|---|---|
| 设置 → 卡片设计 → 单词 | 「单词/短语/段落」tab **还在**；密度、卡片宽度、例句数量等行 **还在**；「模块」这一节 **还在**，列表区显示空态文案 + 常驻的「恢复默认」按钮 |
| 阅读中划词弹出的单词卡 | **不再弹出**。不是弹一张空卡 —— 见 9.1 |
| 设置 → 操作菜单 → 单词 | tab 与列表区 **还在**，显示空态文案 + 常驻的「恢复默认」按钮 |
| 阅读中的划词菜单 | **不再弹出**。不是弹一个空的 220px 边框 —— 见 9.2。双击查词等直接绑定不经过菜单，**不受影响** |
| 设置 → 书籍来源 | 分组标题与空态提示 **还在**（现已如此），「恢复默认」按钮 **还在** |

### 2.3 「恢复默认」的语义

把内置项**按出厂状态**找回来：缺的补回、顺序回到出厂顺序、`enabled` / `defaultExpanded` / `density` 回到出厂值、墓碑清空。**用户自己添加的条目原样保留**，追加在内置项之后。

这与 `restoreBuiltInBookSources` 已有的语义完全一致，实现时以它为参照。

---

## 3. 统一交互规范

### 3.1 删除入口长什么样

统一为 `BookSourcesSettings` 已有的样式：行尾一枚 `Trash2` 图标按钮，常态 `opacity-0`，行 hover 时显形，hover 自身变 danger 色，`aria-label={t("common.delete")}`。

- **位置：放在行尾**，即 `Toggle` 的**右侧**。理由：开关是高频操作，位置不能变（肌肉记忆）；破坏性操作放最外侧且需要 hover 才出现，误触成本最低。
- **键盘可达性（必须补）**：`opacity-0` 的按钮仍在 Tab 序列里，只靠 `group-hover:opacity-100` 会让键盘用户聚焦到一个看不见的按钮上。所有删除按钮都要加 `focus-visible:opacity-100`。`BookSourcesSettings.tsx:187-194` 现在缺这一条，属既有缺陷，一并修。
- **拖拽把手不变**：`SortableList` 的 `GripVertical` 保持原位。

### 3.2 确认弹窗在什么条件下触发

**推荐：只在两种情况下确认，其余直接删。**

| 被删的是 | 删完后列表 | 是否确认 | 说明 |
|---|---|---|---|
| 内置预设项 | 还有内容 | **否** | 可逆 —— 「恢复默认」随时找回 |
| 内置预设项 | 变空 | **是** | 唯一有面貌变化后果的一步 |
| 自定义项 | 还有内容 | **是** | **不可逆** —— prompt 是用户写的，「恢复默认」找不回来 |
| 自定义项 | 变空 | **是** | 文案合并两条后果 |

理由：

- **每次都确认 = 把常规编辑变成点两次。** 用户调整卡片模块往往一次删好几个，逐个确认是纯摩擦，而且确认框看多了就会被无脑点掉，反而削弱了真正该拦的那一次。
- **内置项的删除本来就是可逆的**，用一个不可逆操作的仪式去包一个可逆操作，是在骗用户。
- **自定义项是真的会丢数据**，无论是不是最后一项都得拦。这一条是对需求的补充：现在 `CustomActionEditor.tsx:333-337` 的删除**完全没有确认**，直接丢掉用户写的 prompt，属于 `AGENTS.md`「永远不砍数据丢失防护」的红线，顺手补上。

复用现成的 `settings/ConfirmDialog.tsx`（已支持 portal、focus trap、Esc、三按钮），不新建弹窗组件。

### 3.3 「恢复默认」放在哪里

列表底部单独一行，与「添加」按钮同一行：**左「+ 添加」，右「恢复默认」**，`variant="secondary" size="sm"`，图标 `RotateCcw`，`title` 挂说明文案。与 `BookSourcesSettings.tsx:204-218` 完全同构。

列表为空时，「恢复默认」按钮**必须常驻可见且视觉上是这一节的主要出路**（此时它是唯一的返回路径）。

### 3.4 恢复时全量覆盖还是只补缺失

**推荐：内置项全量覆盖，用户自定义项保留。**

理由：

- 「恢复默认」这四个字的自然含义就是「回到出厂」。只补缺失的话，用户点完按钮会发现自己关掉的、改过密度的、拖乱顺序的内置项**还是老样子** —— 按钮没起作用，用户第二次就不信它了。
- 用户自定义项不属于「默认」，删掉它们等于借「恢复」之名做数据破坏。必须保留，追加到内置项之后。
- 这正是 `restoreBuiltInBookSources` 已经在做的事，保持一致比发明第二套语义好。
- 按钮的 `title` / hint 文案必须把这两半都说清（「内置项回到出厂并撤销修改；你添加的条目不受影响」），否则「全量覆盖」会变成惊吓。

**一致性备注**：仓库里现有两种删除确认写法 —— `ConfirmDialog`（OCR、未保存草稿）和 `GeneralSettings` 的行内两步确认（能力评估记录）。本次改造统一用 `ConfirmDialog`；不去动 `GeneralSettings`，那是用户数据，不在本需求范围内。

---

## 4. 数据层设计（重点）

### 4.1 要区分的三种状态

| 状态 | 存储上长什么样 | 期望行为 |
|---|---|---|
| S1 从没配置过 | `settings["learning_card_config"] === undefined` | 用完整出厂默认 |
| S2 配置过，某内置项只是被关掉 | 该 id 在 `modules` 数组里，`enabled: false` | 保持关闭 |
| S3 配置过，某内置项被**主动删除** | 该 id **不在** `modules` 数组里 | **保持消失，重启后不复活** |
| S4 未来版本新增的内置项 | 该 id 也**不在** `modules` 数组里 | **应该出现** |

**S3 和 S4 在「id 不在数组里」这一点上完全相同。** 这就是为什么不能靠「数组里有没有」来判断，也是为什么不能简单删掉 `parseModules` 尾部那段补默认循环 —— 删了它 S3 对了，S4 就永远坏了（老用户再也收不到新增的内置模块，且会直接打挂现有测试）。

### 4.2 方案：删除墓碑（tombstone）

给配置加一份「用户明确删掉过哪些内置 id」的清单。解析时：**补回缺失的内置项，但跳过墓碑里的**。

```ts
// src/components/learning-card/types.ts
export interface CardKindConfig {
  defaultDensity: ContentDensity;
  widthMode: CardWidthMode;
  exampleCount: number;
  keyTermCount: number;
  modules: CardModuleConfig[];
  customModules: Partial<Record<CustomLearningId, CustomLearningDefinition>>;
  /** 用户主动删除的内置模块 id。解析时不再补回，"恢复默认"时清空。 */
  removedModules?: BuiltInLearningModuleId[];
}

export interface CardDesignConfigV1 {
  version: 2;
  cards: Record<LearningCardKind, CardKindConfig>;
  selectionMenus: Record<SelectionMenuKind, SelectionMenuItemConfig[]>;
  /** 同上，按 menu kind 分。selectionMenus 的值是数组，塞不进去，所以做成兄弟字段。 */
  removedMenuActions?: Record<SelectionMenuKind, BuiltInSelectionMenuActionId[]>;
}
```

解析改动只有两处，各改一行：

```ts
// parseModules 尾部
for (const fallback of defaults) {
  if (!seen.has(fallback.id) && !removed.has(fallback.id)) parsed.push({ ...fallback });
}
// parseMenu 尾部同理
```

自定义项（`custom_*`）**不进墓碑** —— 它们不在 defaults 里，本来就不会被补回。墓碑解析时要按内置 id 白名单过滤，防止配置里塞进垃圾把墓碑撑大。

### 4.3 三条硬性约束

1. **绝对不要 bump `version`。** `parseCardDesignConfig` 只接受 `version === 1 | 2`，改成 3 会让所有人的现有配置在下次启动时被整体判为非法并重置。新增的是可选字段，不需要版本号。
2. **`serializeCardDesignConfig` 走的是 `JSON.stringify(parseCardDesignConfig(config))`**，即保存前必过一次解析。墓碑字段必须在解析的返回值里被完整带出，否则每次保存都会被抹掉，删除立刻失效。这是最容易漏的一步，务必用往返测试锁住。
3. **`ToolsSettings.persistConfig` 会调 `parseCardDesignConfig(resolveFollowingSources(next))`** —— 同样的往返，同样的要求。

### 4.4 Rust 侧：不需要为「删除」做任何改动

`src-tauri/src/commands/ai.rs` 的 `learning_request_from_config`（L772-875）只读 `cards[kind].modules` 数组、过滤 `enabled === false`，**被删掉的模块天然不在数组里，直接就没了**。它不认识也不需要认识墓碑字段。

两个已有行为要保留并加测试锁住：

- `card.get("modules")` **缺失** → 回退到完整默认（L812-814）。这对应 S1，正确。
- `modules` 为**空数组** → 返回 `LEARNING_CARD_ALL_MODULES_DISABLED` 错误（L864-868）。这对应「删光」，正确 —— 但这条错误目前**前端没有翻译**，见 9.1。

### 4.5 书籍来源（P3）：保持现状，只记一笔已知限制

`book_sources` 用「一次性播种 + 哨兵键」已经同时满足可删和可恢复，**不改数据模型**（`AGENTS.md` 的克制原则：能不动就不动）。

已知限制写在这里备查：**后续版本新增的内置站点，对已播种过的用户永远不会出现** —— 因为播种只发生一次，而 `parseBookSources` 不补默认。这与 P1/P2 改造后的行为不一致。目前内置站点列表稳定，不值得为此改动;真要新增站点时再按 4.2 的墓碑模型统一，届时是一个独立的小改动。

---

## 5. 分块改造

块与块之间的依赖：

```
块 1（数据层）──┬─→ 块 3（操作菜单 UI）
               ├─→ 块 4（卡片模块 UI）
               └─→ 块 5（阅读中空态）
块 2（文案+确认）─┼─→ 块 3
               ├─→ 块 4
               ├─→ 块 6（书籍来源对齐）
               └─→ 块 7（自定义项删除确认）
块 1..7 ────────→ 块 8（收尾校验）
```

块 1 与块 2 无相互依赖，可并行开工。块 3 / 4 / 5 / 6 / 7 在前置块完成后互相独立，可并行。

---

### 块 1 —— 数据层墓碑与恢复函数（无 UI）

**文件**：`src/components/learning-card/types.ts`、`src/components/learning-card/config.ts`、`tests/`

**做什么**

1. 按 4.2 给 `CardKindConfig` 加 `removedModules?`，给 `CardDesignConfigV1` 加 `removedMenuActions?`。
2. `parseCard` / `parseCardDesignConfig` 解析墓碑：只接受字符串、只保留该 kind 的内置 id、去重、数量上限取该 kind 的内置项总数。
3. `parseModules` / `parseMenu` 补默认时跳过墓碑内的 id。
4. 新增两个纯函数（导出，供 UI 与测试调用）：
   - `removeCardModule(card: CardKindConfig, id: LearningModuleId): CardKindConfig` —— 从 `modules` 移除；若是内置 id 则写入 `removedModules`；若是自定义 id 则同时清理 `customModules[id]`。
   - `restoreDefaultCardModules(kind, card): CardKindConfig` —— 内置项按 `MODULE_DEFINITIONS[kind]` 顺序与出厂 `enabled/defaultExpanded/density` 全量重建，清空 `removedModules`，用户自定义模块按原相对顺序追加在后，`customModules` 原样保留。
   - 菜单侧对应的 `removeMenuAction(items, removed, id)` 与 `restoreDefaultMenuActions(kind, items)`，语义同上（自定义动作的 `name`/`prompt` 存在条目自身上，删除即丢，恢复不还原）。
5. 不 bump `version`。

**验收标准**

- [ ] `npm run test:unit` 全绿，**现有的 `tests/selection-menu-config.test.ts` 一个都不许改** —— 尤其「read-aloud appears in a menu config saved before it existed」必须仍然通过（证明 S4 没坏）。
- [ ] 新增测试覆盖：
  - 删除一个内置模块后 `serialize → parse` 往返，该模块**不再出现**（S3 持久化）。
  - 同一份配置里，某内置项在墓碑中、另一个内置项既不在数组也不在墓碑 → 前者不回来、后者回来（S3 与 S4 同时成立）。
  - `settings` 里没有该 key 时得到完整出厂默认（S1）。
  - 删光某 kind 的全部模块后往返，`modules` 仍为 `[]`，不被填回。
  - `restoreDefaultCardModules` 后：内置项数量、顺序、`enabled` 与 `createDefaultCardDesignConfig()` 逐字段相等；用户自定义模块仍在且 `customModules` 未丢。
  - 墓碑里塞入非法 id / 自定义 id / 超长数组时被过滤掉。
- [ ] `npx tsc --noEmit` 通过。

---

### 块 2 —— 共享确认与文案（无业务逻辑）

**文件**：`src/i18n/en.json`、`src/i18n/zh.json`，以及一处极薄的共享封装

**做什么**

1. 按第 7 节加全部 i18n key（中英同时加，键序与相邻键保持一致）。
2. 提供一个薄封装，让三处列表用同一套判断与文案，而不是各写一遍。建议形态（保持最小，不要造抽象层）：
   ```ts
   // src/components/settings/presetDeletion.ts
   export type PresetDeleteKind = "builtin" | "custom";
   export type PresetSurface = "card" | "menu" | "sources";
   /** 返回 null 表示直接删，不弹确认。 */
   export function presetDeleteConfirm(
     kind: PresetDeleteKind, isLast: boolean, surface: PresetSurface, name?: string,
   ): { titleKey: string; descriptionKeys: string[]; nameParam?: string } | null;
   ```
   调用方拿它的返回值渲染现成的 `ConfirmDialog`；**不新建弹窗组件**。
3. 不改任何列表行为 —— 本块交付后 UI 应当零变化。

**验收标准**

- [ ] `npm run test:unit` 中的 `tests/i18n-keys.test.ts` 通过（无重复键、中英键集合一致）。
- [ ] `presetDeletion.ts` 的分支表与 3.2 的四行一一对应，有单测覆盖四种组合。
- [ ] `npx tsc --noEmit` 与 `npm run lint` 通过。
- [ ] 人工确认：本块单独合入后，设置界面外观与行为**完全不变**。

---

### 块 3 —— 操作菜单：内置项可删 + 恢复默认

**依赖**：块 1、块 2
**文件**：`src/components/settings/SelectionMenuSettings.tsx`（可能连带 `ToolsSettings.tsx` 传参）

**做什么**

1. 每一行（内置与自定义都是）行尾加删除按钮，样式与可达性按 3.1。
2. 删除时按 3.2 决定是否先弹 `ConfirmDialog`；确认后调块 1 的 `removeMenuAction`，并把墓碑一起交给 `onChange` 往上传（`ToolsSettings` 的 `persistConfig` 负责落库）。
3. 列表底部按 3.3 加「恢复默认」，接 `restoreDefaultMenuActions`。
4. 列表为空时渲染空态文案 + 常驻「恢复默认」；**「添加自定义动作」按钮仍然可用**（空列表不该堵死添加）。
5. 空列表时不要让 `SortableList` 塌成 0 高的两条重叠边框，给空态一个正常行高的容器。

**验收标准**

- [ ] 删除一个内置动作 → 该动作从设置列表消失；**完全退出应用再启动，它仍然不在**。
- [ ] 删到只剩 1 项再删 → 弹确认框，文案是 7.1 的菜单版；取消则不删。
- [ ] 删光后：tab、标题、说明文字、「添加自定义动作」、「恢复默认」**都还在**，只有条目列表是空态。
- [ ] 点「恢复默认」→ 全部 7 个内置动作按 `MENU_ACTION_DEFINITIONS` 顺序回来，出厂开关状态正确（`translate` 默认关），此前添加的自定义动作仍在且排在内置项之后。
- [ ] 删除自定义动作时也弹确认（不可恢复版文案）。
- [ ] 键盘：Tab 能聚焦到删除按钮且此时按钮可见。
- [ ] 三个 kind（单词/短语/段落）互不串台：删单词的不影响短语的。

---

### 块 4 —— 卡片模块：内置项可删 + 恢复默认

**依赖**：块 1、块 2
**文件**：`src/components/settings/CardDesignSettings.tsx`、`src/components/settings/CardModuleRow.tsx`

**做什么**：与块 3 同构，只是落在模块行上。

1. `CardModuleRow` 增加可选的 `onDelete`，行尾渲染删除按钮（在 `Toggle` 右侧）。草稿态（`unsaved` 的新模块）不显示删除按钮，它有自己的「放弃」路径。
2. 删除走块 1 的 `removeCardModule`。
3. 「模块」小节标题行右侧现有的「已启用 N 项」计数保持，删光时显示 0。
4. 底部加「恢复默认」，接 `restoreDefaultCardModules`；空列表时空态 + 常驻按钮。
5. **不要碰**同一屏上方的密度 / 卡片宽度 / 例句数量 / 关键术语数量四行 —— 它们不是列表项，删光模块后必须原样留着。

**验收标准**

- [ ] 与块 3 逐条对应（持久化、最后一项确认、空态保留设置项、恢复默认全量覆盖 + 保留自定义）。
- [ ] 删掉 `target_translation` 后：`ToolsSettings` 里的 `wordTranslationEnabled` 派生逻辑不报错，`show_translation` 被写成 `false`（该模块不存在时视为未启用）。
- [ ] 删光单词卡的模块后，「卡片设计 → 单词」页的密度、宽度、例句数三行**仍然可见可改**。
- [ ] 右侧实时预览面板不崩：模块为空时预览显示与阅读中一致的空态处理（见 9.1），不是白屏或报错。

---

### 块 5 —— 阅读中的空态行为

**依赖**：块 1（只依赖数据形状，可与块 3/4 并行；手测需要块 3/4 之一，或临时用 devtools 直接写 settings 造状态）
**文件**：`src/pages/Reader.tsx`、`src/components/ReaderContextMenu.tsx`、`src/components/settings/CardPreview.tsx`、`src-tauri/src/commands/ai.rs`（仅测试）

**做什么**

1. **卡片全空**：`Reader.tsx:602-619` 的 `openLearningCard` 已有守卫 —— `hasEnabledModule` 为 false 时弹 `t("learningCard.allModulesDisabled")` 并直接返回。空数组同样为 false，**这条路已经通了**。需要做的是把文案改成同时说得通「关掉了」和「删光了」两种情况（见 7.2），并确认预览面板走同一分支。
2. **菜单全空**：`Reader.tsx` 的 `openLearningInteraction`（L680 起）与延迟划词菜单（L645 起）在 `setContextMenu(interaction)` 前加守卫 —— 该 kind 的有效动作数为 0 时**不打开菜单**，静默返回。
   **注意**：不能只数 `selectionMenus[kind].filter(enabled)`。`ReaderContextMenu` 内部还会在 `showTranslate` 为真时插入一行 translate（`ReaderContextMenu.tsx:83`），所以守卫要按**最终会渲染出来的行数**判断，或者把这个注入逻辑一并上提到 `Reader.tsx` 里算清楚。
3. **不给划词菜单加 toast**。划词是高频动作，每次弹提示比空菜单更烦；而卡片是一次明确点击/快捷键触发，必须有反馈。这条不对称是有意的。
4. **兜底错误文案**：`LEARNING_CARD_ALL_MODULES_DISABLED` 目前在前端**没有任何翻译**，一旦从后端漏出来就是一串裸英文常量。给它一个和第 1 条同文案的映射。

**验收标准**

- [ ] 卡片模块删光后，划词点「查词」/ 按绑定的快捷键 → 弹 toast，**不弹卡片**，控制台无报错。
- [ ] 操作菜单删光后，划词 → **什么都不弹**，没有空边框，控制台无报错。
- [ ] 菜单删光但双击查词开关仍开着时，双击**照常打开卡片**（前提是卡片模块还在）。
- [ ] 菜单只剩 `speak` 时，菜单正常打开且只有朗读一行。
- [ ] `cd src-tauri && cargo test` 通过；新增 Rust 测试锁住：`modules` 缺失 → 回退默认；`modules: []` → 返回 `LEARNING_CARD_ALL_MODULES_DISABLED`。
- [ ] 设置页右侧预览面板在同样的空状态下与阅读中表现一致。

---

### 块 6 —— 书籍来源对齐新规范

**依赖**：块 2
**文件**：`src/components/settings/BookSourcesSettings.tsx`

**做什么**（这一处已可删可恢复，只补规范差异）

1. 删除按钮补 `focus-visible:opacity-100`（既有可达性缺陷）。
2. 删最后一项时弹确认（文案用书籍来源版本）。注意判断口径：**整份列表为空**才算最后一项，不是某个分组为空 —— 只剩「第三方资源站」一条时删它，才触发。
3. 空态时「恢复默认」按钮常驻显眼（现在已在底部，确认空列表下仍可见即可）。
4. **不动数据模型**（见 4.5）。

**验收标准**

- [ ] 删到全空再删 → 弹确认；确认后列表全空，重启仍全空（哨兵键保证不重新播种）。
- [ ] 只清空 `library` 分组、`thirdParty` 还有条目时，**不**弹确认。
- [ ] 「恢复默认」行为不变：内置回来、用户添加的保留。`tests/book-sources.test.ts` 不改且全绿。
- [ ] 键盘可聚焦到删除按钮且可见。

---

### 块 7 —— 自定义项删除的不可逆确认（推荐，可独立砍掉）

**依赖**：块 2
**文件**：`src/components/settings/CustomActionEditor.tsx`

**做什么**：`CustomActionEditor.tsx:333-337` 的删除按钮当前**零确认**，直接丢弃用户写的 prompt。接上块 2 的确认（自定义版文案）。草稿态（`onDiscard` 存在时）不确认 —— 那是「放弃新建」，没有已保存内容可丢。

**验收标准**

- [ ] 删除一个已保存的自定义动作/模块 → 弹确认，文案说明无法通过「恢复默认」找回。
- [ ] 新建中尚未保存的草稿点删除 → 直接放弃，不弹确认。
- [ ] 块 3/4 的行尾删除按钮与编辑器内的删除按钮走**同一套**确认逻辑，不出现一处弹一处不弹。

---

### 块 8 —— 收尾校验

**依赖**：块 1-7

- [ ] `npx tsc --noEmit`、`npm run lint`、`npm run test:unit`、`cd src-tauri && cargo test`、`cargo clippy -- -D warnings` 全绿。
- [ ] 端到端手测一遍第 2.2 节的表格，四处列表逐格核对。
- [ ] 把本文加进 `docs/impls/README.md` 的索引；实施完成后按仓库惯例移入 `docs/impls/archive/`。

---

## 6. 未变更清单（防止实施时扩大范围）

- 不改 `learning_card_config` 的 `version`。
- 不改 `book_sources` 的数据模型与哨兵键机制。
- 不给 `reader_bindings` 加「恢复默认」（出厂即空，没有默认可恢复）。
- 不动 `AI_PRESETS` 目录、字体/主题/音色下拉、色板与数值快捷选项。
- 不动 `GeneralSettings` 的能力评估记录删除交互。
- 不写任何旧数据迁移代码（`AGENTS.md` 测试期兼容性政策）。

---

## 7. i18n

flat key，中英同时加。新增键统一放在 `settings.presets.*` 命名空间下，三处列表共用。

### 7.1 删除确认

| key | zh | en |
|---|---|---|
| `settings.presets.deleteTitle` | 删除「{{name}}」？ | Delete “{{name}}”? |
| `settings.presets.deleteLastTitle` | 删除最后一项？ | Delete the last one? |
| `settings.presets.deleteLastCard` | 删除后，阅读时不会再弹出这张卡片。随时可以在这里恢复默认。 | Once it is gone, this card no longer opens while you read. You can restore the defaults here at any time. |
| `settings.presets.deleteLastMenu` | 删除后，划词时不会再弹出这个菜单。随时可以在这里恢复默认。 | Once it is gone, the selection menu no longer opens while you read. You can restore the defaults here at any time. |
| `settings.presets.deleteLastSources` | 删除后，这份清单会变空。随时可以在这里恢复默认。 | Once it is gone, this list is empty. You can restore the defaults here at any time. |
| `settings.presets.deleteCustomWarning` | 这一项是你自己写的，删除后无法通过「恢复默认」找回。 | You wrote this one. “Restore defaults” cannot bring it back. |

确认框按钮复用 `common.delete` / `common.cancel`。自定义项且是最后一项时，`description` 依次拼 `deleteCustomWarning` + 对应的 `deleteLast*`。

### 7.2 空态与恢复

| key | zh | en |
|---|---|---|
| `settings.presets.restore` | 恢复默认 | Restore defaults |
| `settings.presets.restoreHint` | 内置项按出厂状态补回并撤销修改；你自己添加的条目不受影响。 | Brings the built-in entries back as they shipped and undoes edits to them. Entries you added are left alone. |
| `settings.presets.emptyCard` | 这张卡片的板块已全部删除，阅读时不会再弹出。 | Every section of this card has been deleted, so it no longer opens while you read. |
| `settings.presets.emptyMenu` | 这个菜单的动作已全部删除，划词时不会再弹出。 | Every action in this menu has been deleted, so it no longer opens when you select text. |

### 7.3 需要改写的既有键

`learningCard.allModulesDisabled` 现在只说「关闭」，删光后会读起来不对：

| key | 现 zh | 改为 zh | 改为 en |
|---|---|---|---|
| `learningCard.allModulesDisabled` | 当前已关闭所有展示项，如需查询请开启至少 1 项。 | 这张卡片没有可展示的板块。可在设置中开启或恢复默认。 | This card has no sections to show. Turn one on, or restore the defaults, in settings. |

同一句同时用于前端守卫的 toast 和后端 `LEARNING_CARD_ALL_MODULES_DISABLED` 的兜底映射。

---

## 8. Figma 设计提示词

高层次描述，交给设计工具决定具体数值。

**提示词 A —— 预设列表行的删除入口**

> 为桌面端设置面板里的一种可编辑列表行设计删除入口。行本身已经存在：左侧是拖拽把手，中间是名称（可展开），右侧是上移/下移按钮和一个开关。现在要在行尾、开关之外再加一个删除动作。
>
> 设计目标：删除是这一行里唯一的破坏性动作，但列表的日常用法是开关和排序，删除不能抢走它们的视觉权重，也不能让人误触。请给出常态、行悬停、按钮悬停、键盘聚焦四种状态；键盘聚焦时该动作必须自己变得可见，不能依赖鼠标悬停。同时给出「这一行是列表里最后一行」时的样子 —— 它不被禁用，但用户点下去会走一次确认。
>
> 这套状态要同时适用于内置条目和用户自建条目，两者视觉上不作区分。

**提示词 B —— 删除确认对话框**

> 为设置面板设计一个删除确认对话框，用于两类不同的后果，请给出两个文案变体和它们合并时的样子：
>
> 1. 删掉的是最后一项：后果是这个板块在阅读界面里不再出现，但设置里仍然找得到它、随时可以恢复默认。语气是说明，不是警告 —— 这个操作是可逆的。
> 2. 删掉的是用户自己写的条目：后果是内容真的丢了，恢复默认也找不回来。语气要比第 1 种更审慎。
>
> 三个按钮层级：取消（默认焦点）、删除（破坏性）。对话框宽度、圆角、阴影沿用面板里已有的确认弹窗，不要发明新的容器样式。

**提示词 C —— 列表空态与恢复默认**

> 设计一个可编辑预设列表的空态。用户是主动把条目全删光的，所以空态不是错误，也不是「还没开始」，而是「你关掉了这个板块」。
>
> 空态需要说清两件事：一是这个板块在阅读界面里已经不再出现；二是随时可以一键恢复出厂条目。恢复的入口在这个状态下是用户唯一的出路，必须一眼可见 —— 但在列表非空时，它只是底部工具行里一个次要按钮，不能喧宾夺主。请给出「列表非空」和「列表为空」两种情况下这行工具栏的对比。
>
> 同时注意：这一节所在的设置页上还有别的、与列表无关的设置行（下拉、分段控件），它们在列表空掉时**必须原样保留**。请在稿件里体现这一点，不要把整节收起来。

---

## 9. 风险与边界情况

### 9.1 结论：卡片模块全空时**不弹卡片**

不是弹空卡，不是弹带占位符的卡。理由：一张卡片的全部价值就是那些模块，弹一个空壳只会让用户以为是加载失败或坏了。改为一条 toast 指向设置。

实现上这条**已经成立**：`Reader.tsx` 的 `openLearningCard` 有 `hasEnabledModule` 守卫，空数组同样为 false。块 5 只需要改文案 + 覆盖预览面板 + 补后端错误映射。

配套结论：**不要额外把划词菜单里的「查词/解读」行隐藏掉**。理由是那会让菜单在两种独立配置（菜单配置、卡片配置）之间产生耦合，用户看着菜单少了一项却不知道是哪边的设置导致的；点下去弹一句解释反而更清楚。

### 9.2 结论：划词菜单全空时**不弹菜单**

当前 `ReaderContextMenu` 对空 `order` 没有守卫，会渲染一个 220px 宽的空边框浮层。必须在打开前拦住。

隐藏陷阱：`showTranslate` 会往 `order` 里插一行 translate（`ReaderContextMenu.tsx:83`），所以「order 为空」不等于「菜单为空」。守卫要按最终行数判断。

### 9.3 保存往返把墓碑抹掉

`serializeCardDesignConfig` = `JSON.stringify(parseCardDesignConfig(config))`。只要解析函数漏带墓碑字段，删除在**下一次任何保存**时就静默失效，而且现象是「刚才删的过一会儿自己回来了」，极难归因。块 1 的往返测试是防这个的唯一手段，不能省。

### 9.4 多窗口/多处并发写同一份配置

`ToolsSettings` 用 `saveQueue` 串行化自己的写，但阅读器窗口通过 `notifyReadingAssistanceSettingsChanged` 也在监听同一份配置。整份 JSON 是**全量覆盖写**，所以在设置窗口删条目的同时另一处写同一个 key 会互相覆盖 —— 这是既有行为，本次不引入也不修复，但删除比开关更容易让用户察觉到丢失。若测试中复现，记为独立问题。

### 9.5 删掉 `target_translation` 与 `show_translation` 的耦合

`ToolsSettings.wordTranslationEnabled` 用 `.find(...)?.enabled ?? true` —— 模块被删后 `find` 返回 undefined，**会落到 `?? true`，把 `show_translation` 写成 `true`**，与「用户删掉了译文模块」正好相反。块 4 必须把这个默认值改成「找不到即视为未启用」。这是本次改造里唯一一处「删除」与「关闭」语义不一致会真正咬人的地方。

### 9.6 墓碑与自定义项 id 混入

自定义 id 形如 `custom_<uuid>`，理论上不该进墓碑。若因 bug 混入，墓碑会无限增长且没有清理时机。解析时按内置 id 白名单过滤即可，块 1 的测试要覆盖。

### 9.7 「恢复默认」是否该二次确认

**结论：不需要。** 它只覆盖内置项、保留用户自建项，没有不可逆的数据损失；按钮的 hint 文案已说明范围。加确认会让唯一的出路变得更远。

### 9.8 三个 kind 之间的串台

单词/短语/段落各有独立的模块列表和菜单列表，墓碑也必须按 kind 分开存。共用一份墓碑会导致「删了单词卡的常见释义，短语卡的也没了」。块 3/4 的验收里各有一条专门测这个。

### 9.9 老版本读到带墓碑的配置

按 `AGENTS.md` 测试期政策不写兼容代码。行为记录在此备查：旧版本解析时忽略未知字段，会把被删的内置项补回来 —— 即降级后删除失效，但不会崩溃、不会丢用户自定义项。可接受。
