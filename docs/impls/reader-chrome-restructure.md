# 手机端阅读器 chrome 重构（样张 E 落地）

设计来源：样张 E（2026-08-12 用户拍板通过，含四条修订）。桌面端（≥48rem）一律不动。
本计划吸收 M4（⋯ 菜单）与 M8（底部进度条不再常驻）两项待办。

## 已拍板的决定（不再讨论）

- 顶带 40pt 永久保留：左＝返回、中＝章节名小字、右＝AI。返回按钮不随 M10 撤除。
- 静默态底部一条 24pt 读数条：默认「本章 x/y 页」，点击循环 本章页 → 本章余时 → 全书 → 空
  （即现有 page / chapterTime / bookTime / hidden 四档，只改标签不加计算）。
- 手机端取消「单击普通词开卡」；长按查词、双击 AI 查词、点标注词开卡均保留；桌面端不动。
- 点击分区左/中/右三等分：上一页 / 唤起菜单 / 下一页；分区纵向范围＝顶带下沿到读数条上沿
  （避开上下安全区，系统手势不受影响）。
- 阅读器内不做边缘滑动返回（M10 只做书架侧页面）；返回走顶带按钮。
- 唤起态两条浮条：顶条＝返回+书名/章节+AI；底条＝scrubber + 读数行 + 功能行
  （目录/搜索/划线笔记/朗读/排版），手机端不再有 ⋯ 菜单。
- 首次进入分区模式出一次性引导蒙层，之后不再出现。
- 「单手模式」开关：待用户点头，本批不做（基础设施要留好：分区分类为纯函数，加开关只改一处）。

## 侦察结论中约束实现的硬事实

1. **header/footer 是 flex 流内兄弟**（Reader.tsx:2115 外层 `flex flex-col h-screen`），
   高度变化会改 `<main>` 的盒高 → `viewerRef` 的 ResizeObserver（useFoliateView.ts:~1220）
   触发整章重新分栏。因此：**常驻件（顶带、读数条）留在流内**（只在挂载时定一次高度）；
   **唤起态浮条必须是绝对定位浮层**（照抄朗读条的先例，Reader.tsx:2670-2706 注释写明了原因），
   开合零回流。
2. **点击事件挂在章节 iframe 的 `doc` 上，坐标是 iframe 视口系**（useReaderInteractions.ts）。
   分区三等分用 `doc.documentElement.clientWidth` 分母（同 :829 边缘翻页的现成写法），
   不加 iframe 偏移。
3. **翻页必须走 `pageTurnDispatcher.dispatch`**（经 usePageTurnInput，同 handleSwipePageTurn
   的接线，:164-168），不许直接 `view.next()/prev()` —— 继承 overlay 开着不翻页、
   readingMode 门控、动画与去重。
4. **click 处理顺序不能破**：`annotationClickDocumentRef`（标注词点击已被 overlayer 认领）→
   `longPress.consumeClick()`（吞长按后的合成 click，700ms 窗口）→ 三击 → 抑制窗口 →
   `isInteractiveReaderTarget` → 选区未折叠则只清不翻。分区分类插在这串守卫**之后**。
5. **双击与单击的消歧**：分区动作复用 `pendingWordClickRef` 定时槽，延迟
   `clickCountGraceMs(1, …)`（240ms）执行；dblclick 处理器第一行本来就无条件
   `cancelPendingWordClick()`，于是双击天然取消了将要发生的翻页/唤菜单。零新机制。
6. **窄屏判定**：`useIsNarrow`（=Tailwind `md:` 断点 48rem，matchMedia 镜像），JSX 分支与
   `md:` 类永远一致。
7. **嵌套在覆盖面板里的 fixed 元素会被 transform 祖先劫持包含块**（M6 教训）——新蒙层/弹层
   若可能从面板内打开，portal 到 `document.body`（IndexManagerModal 先例）。
8. **z 阶梯**：浮条用 z-30（与朗读条同层）；引导蒙层 z-50；已有 z-[60]/[70]/[80] 各有主，不抢。
9. **读数持久化**：`progress_readout_mode` 每书一份，`set_book_settings_bulk` 即写；
   循环读数只在 `supportsScrubber`（分页 EPUB）生效，PDF/TXT 维持现状静态文案（见「明确不做」）。
10. **一次性标志先例**：`auto_analysis_intro_shown` = "true" / `!== "true"` 判定
    （onboarding-state.ts），引导蒙层照抄，键名 `reader_zone_guide_shown`（全局设置）。

## 分步（每步一个提交，机器验收后我审查再提交）

### 第 1 步 — 读数标签改「本章」（小提交，先行）
- i18n 新键（en/zh 严格同键）：
  - `reader.chapterPageOf` 「本章 {{current}}/{{total}} 页」/ "Page {{current}}/{{total}} in chapter"
  - `reader.chapterPageRangeOf` 「本章 {{current}}–{{end}}/{{total}} 页」/ "Pages {{current}}–{{end}}/{{total}} in chapter"
  - `reader.progressReadout.chapterMinutesLeft` 「本章还剩约 {{minutes}} 分钟」/ "~{{minutes}} min left in chapter"
- `useProgressReadout.ts` 的 page / chapterTime 两档换用上述键（bookTime 档不动）。
  PDF 的 `reader.pageOf`（真全书页码）不动。
- 更新 `tests/progress-readout.test.ts` 相应断言。
- 验收：`npx tsc` + `npm run test:unit` + `npm run lint` 全绿。

### 第 2 步 — chrome 重构本体（大提交）
窄屏（isNarrow）下：
- **顶带**：现 header 内容换成 40pt 带（pt-safe-top + h-10）：返回（navigate("/")）、
  章节名小字居中（`currentChapterTitle`，无章节回落 `chapterCounter` 文案，PDF 回落
  `reader.pageOf`）、AI 按钮。TOC/搜索/⋯ 从带里消失（去功能行）。桌面 header 原样。
- **读数条**：footer 内容换成 24pt 条（pb-safe-bottom）：居中读数按钮（现有
  `cycleProgressReadoutMode`），无 scrubber、无进度线（M8 达成）。朗读进行中读数条隐藏
  （朗读条自带本章余时）。PDF 缩放控件挪进唤起态底条读数行右侧。
- **唤起态**：`chromeOpen` state。两条浮层（绝对定位、z-30、带阴影，不入流）：
  - 顶条：返回 + 书名/章节两行 + AI（盖在顶带上方）。
  - 底条：ProgressScrubber（原 props 直接搬）+ 读数行（同一份循环状态；PDF 加缩放）+
    功能行五键：目录/搜索/划线笔记/朗读/排版（不可用者置灰 aria-disabled，如 TXT 的
    目录/搜索）。点键先收 chrome 再开对应面板；排版走 `setSettingsOpen(true)`。
  - ⋯ BottomSheet 与 `readerToolbarOverflow` 的窄屏路径删除（M4 由此吸收）。
- **分区**：新纯函数模块 `src/pages/reader/tap-zones.ts`：
  `classifyReaderTap(x, width): "previous" | "menu" | "next"`（三等分；单手模式将来只改这里）
  + `tests/tap-zones.test.ts`。
  `useReaderInteractions.ts` click 守卫串之后、窄屏时：chromeOpen → 只收起；否则分类后经
  `pendingWordClickRef` 延迟 240ms 执行（左右 → 新 prop `onTapZoneTurn(direction)` →
  usePageTurnInput 走 dispatcher；中 → 新 prop `onToggleChrome()`）。
  窄屏单击普通词不再开卡（该分支让位给分区）；dblclick / 长按 / 标注词路径原封不动。
- **朗读条**：窄屏浮层从 `top-0` 挪到底部（bottom-0 + 底部安全区 padding），桌面不动。
  M5 的 `clearReaderSelection` 触发链、M7 行为不得回归。
- 验收：`npx tsc` + `npm run test:unit` + `npm run lint`；随后我用 smoke harness 浏览器走查
  （分区翻页、双击查词延迟取消、chrome 开合零回流、读数循环、TXT 置灰）。

### 第 3 步 — 首次引导蒙层（小提交）
- 全局设置键 `reader_zone_guide_shown`；窄屏、分页模式、书就绪、未看过 → 出三栏蒙层
  （照样张 E9），点任意处关闭并写 "true"。portal 到 body，z-50。
- i18n：`reader.zoneGuide.*`（prev/menu/next/lookup/dismiss 等）。
- 验收：机器三件套 + 浏览器走查（只出一次）。

## 明确不做（本批）

- 单手模式开关（待用户点头；tap-zones.ts 纯函数已为它留好唯一改动点）。
- TXT/非 scrubber 书的「全书 % ⇄ 空」两档循环——维持现状静态文案，样张里的这句先欠着，
  用户在意再补（一个小时内的活）。
- M10 边缘返回（书架侧页面）——chrome 落地后单独做。
- 模拟器整体复验——三步全落地后与既欠的 M 批复验合并做一次。
