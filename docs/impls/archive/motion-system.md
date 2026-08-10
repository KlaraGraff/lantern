# 动效系统调研与升级方案

调研时间：2026-08-10。范围：GitHub 上的高星动画方案，对照 Lantern 现有动效，给出要不要引库的结论和可升级的点。

## 一、现状盘点

Lantern 目前没有任何动画依赖。全部动效由三样东西拼成：

| 手段 | 用在哪 | 评价 |
| --- | --- | --- |
| View Transitions API + `@keyframes` | 翻页（slide / fade / cover 三种，`src/index.css:400-480`、`src/components/page-turn-transition.ts`） | 做得对。有 `supportsDocumentViewTransitions()` 特性检测降级，有 `prefers-reduced-motion` 兜底 |
| `transition-[grid-template-rows,opacity]` | 学习卡片模块展开（`LearningCardModules.tsx:296`，240ms） | 做得对。这是「高度 auto 无法过渡」的标准解法 |
| Tailwind `transition-colors` / `animate-spin` / `animate-pulse` | 全仓 84 处 / 101 处 / 15 处 | 只覆盖了「颜色」和「转圈」。**元素的出现和消失全是硬闪** |

也就是说：会动的只有翻页、一个展开区、以及 loading 转圈。除此之外，右键菜单、查词卡片、各种 popover、设置弹窗、Toast——全部是「上一帧不在，下一帧就在」。

唯一的例外是 `FootnotePopover.tsx`，它自己写了一段带 `prefers-reduced-motion` 判断的出场，说明这个模式仓里已经有先例，只是没有推广。

另外，duration 目前是散的：`150 / 200 / 240 / 300ms` 各用各的，没有统一来源。

## 二、高星方案调研

星数为 2026-08-10 实测（GitHub API）。

### 通用动画引擎

| 仓库 | 星 | 体积 | 对 Lantern 是否合适 |
| --- | --- | --- | --- |
| [anime.js](https://github.com/juliangarnier/anime) | 72.0k | ~6KB gz | 不合适。命令式时间轴引擎，强项是 SVG / 复杂编排，Lantern 一个都不需要 |
| [motion（原 Framer Motion）](https://github.com/motiondivision/motion) | 33.2k | ~34KB（全量） | **最接近可用，但仍不推荐**，理由见第三节 |
| [GSAP](https://github.com/greensock/GSAP) | 27.6k | ~23KB+ | 不合适。滚动叙事 / 商业站的工具，桌面工具类应用用不上 |
| [react-spring](https://github.com/pmndrs/react-spring) | 29.1k | ~20KB | 不合适。物理弹簧适合手势拖拽，Lantern 的交互都是离散开关 |
| [lottie-web](https://github.com/airbnb/lottie-web) | 32.0k | ~250KB | 不合适。要 After Effects 产出 JSON，我们没有这条设计链路 |
| [auto-animate](https://github.com/formkit/auto-animate) | 13.9k | 3.3KB gz | 唯一「便宜到可以顺手加」的库。但它管的是列表增删/重排，而我们的可排序列表已经由 dnd-kit 动画化了，剩下的场景不够本 |

### 组件/样式集合

| 仓库 | 星 | 说明 |
| --- | --- | --- |
| [animate.css](https://github.com/animate-css/animate.css) | 82.7k | 纯 CSS keyframes 库。星高是历史积累，风格偏夸张（bounce/flip），不适合阅读器 |
| [magicui](https://github.com/magicuidesign/magicui) | 21.9k | 落地页特效集合（渐变光束、粒子）。产品调性不符 |
| [sonner](https://github.com/emilkowalski/sonner) | 12.8k | Toast。**它的堆叠+滑入手法值得抄**，但我们只有一个 UpdateToast，不值得引库 |
| [vaul](https://github.com/emilkowalski/vaul) | 8.5k | 抽屉组件。移动端形态，桌面用不上 |
| [number-flow](https://github.com/barvian/number-flow) | 7.6k | 数字滚动过渡。**手法值得抄**（阅读统计、生词计数），30 行 CSS 能自己实现 |
| [motion-primitives](https://github.com/ibelick/motion-primitives) | 5.9k | motion 之上的示例集，复制粘贴用，不是依赖 |

## 三、结论：不引库，自建一层动效约定

推荐**不引入任何动画库**，改为在仓内建立一层薄的动效约定（CSS 变量 + 几个可复用类）。三条理由：

1. **我们缺的不是能力，是一致性。** 上面所有库解决的是「难做的动画」——编排、物理、手势、SVG 变形。Lantern 需要的全是「120ms 的淡入 + 轻微缩放」，这是 CSS 一行的事。引 34KB 的 motion 来做淡入，等于为了拧螺丝买一台数控机床。

2. **引库会引入第二套范式，和现有的那套打架。** 翻页用的是 View Transitions API（浏览器原生、跨 DOM 树），学习卡片用的是 CSS transition。motion 接管出场后，仓里会同时存在三套动画心智模型，以后每处新动效都要先决定用哪套——这是长期成本，比 34KB 贵得多。

3. **CSS 原生方案天然降级，风险为零。** `@starting-style` + `transition-behavior: allow-discrete` 是现在做「元素出现时的过渡」的标准手段（Safari 17.4+ / Chrome 117+）。Lantern 的 macOS 最低版本是 12.0（`tauri.conf.json:85`），那上面的 WKWebView 是 Safari 15，不支持——**但不支持的结果恰好是今天的行为：直接出现**。换句话说，新系统上变好，旧系统上不变差，不需要写任何检测代码。View Transitions 那套已经是同样的思路（`page-turn-transition.ts:23`），保持一致。

> 例外：如果以后真的要做「元素在两个位置之间飞过去」（比如查词卡片从选中的词飞到生词本图标），CSS 做不了，那时再单独评估 motion 的 `layout` 能力。现在不需要为这个假想需求铺路。

### 要建的那层是什么

在 `src/index.css` 里加一组 token 和三四个工具类：

```css
:root {
  --motion-instant: 90ms;   /* 悬停反馈、按钮态 */
  --motion-fast: 140ms;     /* popover / 菜单出场 */
  --motion-base: 220ms;     /* 展开收起、面板 */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);   /* 出场：快起慢收 */
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1); /* 双向：对称 */
}
```

配 `.motion-pop`（淡入 + `scale(0.96)`，`transform-origin` 由 Floating UI 的落位决定）、`.motion-fade`、`.motion-collapse`（grid-rows 那套，从 `LearningCardModules` 提取）。全部包在一个 `prefers-reduced-motion` 兜底里，一处关掉全部。

## 四、可升级的点（按性价比排序）

| # | 位置 | 现状 | 升级 | 成本 |
| --- | --- | --- | --- | --- |
| 1 | 查词卡片 / 右键菜单出场（`ReaderContextMenu`、`DictionaryCard`） | 硬闪出现 | 140ms 淡入 + 从锚点方向 `scale(0.96)→1`。`transform-origin` 跟随 Floating UI 的实际落位，让卡片看起来是「从被点的词长出来的」 | 小 |
| 2 | 查词卡片骨架屏 → 词条正文（`DictionaryCard.tsx:225-231`） | 骨架条瞬间被文字替换 | 骨架淡出、正文淡入，90ms 交叉。卡片已经预留了高度，所以不会跳动，只差这一层交接 | 小 |
| 3 | 「展开全部 / 收起」（`DictionaryCard.tsx:276`） | 高度瞬间跳变 | 复用 `LearningCardModules` 的 grid-rows 过渡，220ms | 小 |
| 4 | 其余 popover：`ExplainPopover`、`TranslationPopover`、`HighlightToolbar`、`BookContextMenu`、`OptionMenu` | 全部硬闪 | 同 #1，共用一个类 | 小（改的是 className） |
| 5 | 模态框：`SettingsModal`、各 Dialog | 硬闪 | 遮罩淡入 + 内容 `scale(0.98)→1`，220ms | 小 |
| 6 | `UpdateToast` | 硬闪 | 从边缘滑入 + 淡入（sonner 的手法） | 小 |
| 7 | 数字：阅读统计、生词计数、进度百分比 | 直接换数字 | number-flow 的手法，旧数字上滚出、新数字滚入 | 中，且非必需 |
| 8 | 首页书架 `BookGrid` 卡片首次渲染 | 整块同时出现 | 逐个错开 30ms 淡入（stagger） | 小，但容易做过头，需看样张定 |

#1–#3 就是「查词卡片」这一件事的三个层次，建议作为第一批一起做，因为它们互相能看出效果。

## 五、验收

- 机器：`npm run lint`、`npm run build`、`npm run test:unit` 全绿。
- 样张：单文件 HTML，覆盖 #1–#6 的前后对比和 `prefers-reduced-motion` 开启后的样子，由用户拍板取舍。
- 产品行为：所有动效在系统「减弱动态效果」打开时全部消失；旧 macOS（Safari 15 内核）上行为与今天一致，不出现半截动画。
