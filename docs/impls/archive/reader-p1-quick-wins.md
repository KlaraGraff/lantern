# Reader P1 quick wins — implementation plan

> **Shipped 2026-08-03.** All seven items landed on `main`: P1.1 `9e492ae`, P1.7 `e7c9aa4`, P1.4 `75ff07a`, P1.3 `91b62f0`, P1.5 + P1.6 `005ba19` (with follow-up `277090f` restoring the progress-display toggles' authority over the new readout), P1.2 `c0630ad`.

Source: [`docs/roadmap/reader-page-optimization.md`](../../roadmap/archive/reader-page-optimization.md) §P1.
Design direction: paper-palette mockups reviewed and approved 2026-08-03 (footnote popover bubble; search panel; return pill; highlight popover with color dots + note field + split delete; click-cycle progress readout; chapter-tick scrubber; per-book TOC memory). All UI must use theme CSS variables from `reader-theme.ts` — never hardcoded palette hexes — and i18n keys in both `en.json` and `zh.json`.

Execution is split into four waves so concurrent work never touches the same files. Each wave lands as its own commit(s) on `main` after review; acceptance for every item is `npx tsc --noEmit && npm run build && npm run test:unit` plus manual visual review.

## Wave 1 — disjoint pair

### P1.1 Footnote popover

- **现状**: `public/foliate-js/footnotes.js` 的 `FootnoteHandler`（`handle(book, e)`，`detectFootnotes`，事件 `before-render`/`render`）全仓零引用；点脚注链接整页跳走。
- **做法**: 在 foliate view 的链接点击路径接入 `FootnoteHandler`：脚注类内链拦截为弹层，普通内链维持原跳转（交给现有 history）。新建 `FootnotePopover` 组件：靠近锚点的小气泡，surface 背景、hairline 边框、圆角 10px，顶部 11px muted "脚注 N" 标签，正文继承阅读字体设置，底部分隔线 + "跳转到脚注原文" 链接（accent 色）作为长注释兜底。点击气泡外或 Esc 关闭。定位逻辑可参考 `LookupPopover` 的锚定方式。
- **触点**: `src/pages/reader/useFoliateView.ts`（或 Reader.tsx 的 view 初始化处）、新组件 `src/components/FootnotePopover.tsx`、i18n。

### P1.7 TOC state per book + `getTOCItemOf()`

- **现状**: `TableOfContents.tsx` 每次开书都是初始折叠态；当前章节判断靠自制 href 匹配，多级嵌套目录下会失准。
- **做法**: 展开的节点集合与面板滚动位置按书持久化（复用 per-book settings 通道，键如 `toc_expanded` / `toc_scroll`；防抖写入）。当前章节改用引擎 `view` 暴露的 `getTOCItemOf()`。重开书时恢复展开集合，当前章节仍自动展开并高亮（恢复态与自动展开取并集）。
- **触点**: `src/components/TableOfContents.tsx`、per-book settings 读写、`useFoliateView.ts` 暴露 `getTOCItemOf` 的桥接。

## Wave 2 — navigation history + highlight editing

### P1.3 Unified jump history + return

- **现状**: foliate 内链有 `canGoBack` 但 10 秒自动消失（`useFoliateView.ts:470-483`）；TOC/书签/高亮/AI 引用跳转全部单向。
- **做法**: 所有 `goTo` 入口（TOC、书签、高亮列表、AI 引用、搜索、scrubber）统一先压入历史栈再跳。返回入口：左下角胶囊按钮，「返回 · 目标描述」+ `⌘[` 快捷键（macOS）/`Alt+←`，有历史即显示，翻页数次后淡出（不再固定 10 秒计时）。返回后从栈弹出；栈空隐藏。
- **触点**: `useFoliateView.ts`、`Reader.tsx`、`TableOfContents.tsx:163-174` 的跳转入口。

### P1.4 Highlight note/color UI + split delete + popover parity

- **现状**: `useBookmarks.ts:112-126` 的 `updateNote`/`updateColor` 与后端命令零调用；高亮只能删了重建。`ExplainPopover`/`TranslationPopover` 缺少 `LookupPopover` 已有的收藏/追问入口。
- **做法**: `HighlightToolbar` 补五个颜色圆点（当前色打圈）、备注按钮展开输入区（保存调 `updateNote`）；删除对有备注的高亮弹二选一菜单：「仅删除备注」/「删除高亮与备注」（红色危险色），无备注时保持直接删。给 `ExplainPopover`/`TranslationPopover` 对齐收藏/追问按钮。
- **触点**: `src/components/HighlightToolbar.tsx`、`useBookmarks.ts` 调用侧、`ExplainPopover.tsx`、`TranslationPopover.tsx`。

## Wave 3 — bottom bar (single agent, same region)

### P1.5 Progress readout click-cycle

- **做法**: 右下角进度文字变为可点击，循环：页码（默认）→ 本章剩余约 N 分钟 → 全书百分比 + 剩余时间 → 隐藏。剩余时间纯本地估算：最近 N 次翻页速度滑动窗口 × 剩余量；样本不足显示「计算中…」。口径选择按书持久化。剩余时间不常驻——只作为点击口径之一。
- **触点**: `Reader.tsx` 底栏（~1880-1945 区域）、翻页事件采样、per-book setting。

### P1.6 Scrubber + chapter ticks

- **做法**: 1px 进度线升级为悬停加粗可拖动的 scrubber：TOC 节点位置打章节刻度；悬停 tooltip 显示章节名 + 百分比；拖动本地即时更新、100ms 防抖后真正 `goTo`、松手前不翻页（Anx 方案）。跳转压入 P1.3 历史栈。
- **触点**: `Reader.tsx` 底栏进度线（`Reader.tsx:1890-1897`）、TOC 数据换算刻度位置。

## Wave 4 — in-book search (biggest, depends on P1.3)

### P1.2 Full-text search panel

- **做法**: 左侧滑出搜索面板（与 TOC 面板同构）：输入框、范围三档（全书 / 仅我的标注 / 仅生词）、结果按章节分组、命中词高亮、点击跳转（压历史栈）、当前结果在正文中高亮。引擎侧用 `view.search()`（异步生成器，含进度）；「仅标注/生词」档在结果流上按已有高亮 CFI 与生词表过滤。快捷键 `⌘F`。
- **触点**: 新组件 `src/components/BookSearchPanel.tsx`、`Reader.tsx` 集成、`useFoliateView.ts` 搜索桥接、生词/高亮数据源 hooks。

## Conventions checklist (every wave)

- i18n keys in both locales; no hardcoded strings.
- Theme via CSS variables; works in paper/dark/original.
- Popovers/panels respect reduced-motion setting.
- New settings keys follow existing per-book/global two-layer pattern.
- No commits from agents in the main tree; review + commit happen in the main session.
