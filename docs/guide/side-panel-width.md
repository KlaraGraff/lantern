# 右侧面板宽度是怎么定出来的

> 适用于 `src/pages/reader/useSidePanelResize.ts` 里的三个常量。改这些数字前先读这一页。

## 一、用什么标准衡量（"科学的方法"）

**不要按像素定，按每行字数定。**

面板宽度本身没有对错——它只有相对于"里面装的是什么字"才有意义。排版学里衡量这件事的量叫 **measure（行长）**，单位是每行字符数（CPL, characters per line）。行太长，眼睛从行尾扫回下一行的行首时容易串行；行太短，读几个词就要换行，节奏被切碎。两头都会拖慢阅读。

所以判断标准是：**面板里那一列正文，一行落在几个字符？** 而不是"面板占了多少像素"。

## 二、band 落在哪（"科学的比例"）

两个独立来源，结论一致：

| 来源 | 结论 |
| --- | --- |
| Bringhurst《The Elements of Typographic Style》，被 [Baymard](https://baymard.com/blog/line-length-readability) 与 [UXPin](https://www.uxpin.com/studio/blog/optimal-line-length-for-readability/) 复述 | 单栏正文舒适区 **45–75 CPL**，最常被引用的最优值 **66 CPL** |
| [WCAG 1.4.8 Visual Presentation](https://www.w3.org/TR/WCAG21/#visual-presentation) | 上限：非 CJK **80 CPL**，CJK **40 CPL** |

CJK 减半的原因是[全角字宽](https://www.typotheque.com/articles/typesetting-cjk-text)——一个汉字约等于两个拉丁字符的宽度，同样的像素宽度装不下同样多的字。Lantern 的 AI 回答是中英混排，**汉字是紧的那一边**，所以按汉字算。

于是本项目取的目标区间：

- 拉丁：**50–60 CPL**（band 中段偏下）
- 汉字：**25–30 CPL**（40 的 WCAG 上限之下留足余量）

为什么不取 66 这个"最优值"？因为 66 是**主阅读面**的最优值。侧栏不是主阅读面——书才是。侧栏每多要 1px，书栏就少 1px。同一块屏幕上两列正文竞争宽度时，让主列吃饱、辅列取 band 下沿，总阅读体验更好。

## 三、竞品怎么做

| 应用 | 侧栏默认宽度 | 备注 |
| --- | --- | --- |
| [VS Code](https://github.com/microsoft/vscode/issues/118511) | ≈ **251px**（面板最小宽 [300px](https://github.com/microsoft/vscode/issues/100836)） | Copilot Chat / Cursor 的对话面板就住在这个宽度里 |
| [Notion](https://medium.com/@quickmasum/ui-breakdown-of-notions-sidebar-2121364ec78d) | 固定 **224px** | 不可拖宽，靠固定宽度维持纵向节奏 |
| [Obsidian](https://help.obsidian.md/User+interface/Sidebar) | 窗口 < 1200px 时右栏收到 **300px**，左栏最小 **200px** | 有宽度自适应策略 |

共同点：**成熟产品的侧栏普遍在 220–350px**，并且都明显小于主内容区。1440px 窗口下大约是 15%–25%。

Lantern 的 AI 面板装的是完整的问答正文（不是文件树、不是大纲），需要比这些导航型侧栏宽一些，但没有理由宽到 36%。

## 四、算出来的数

AI 面板从外到内的开销：

```
面板宽 W
 − 消息列表 px-3                24px
 − 气泡边框 1px × 2              2px
 − 气泡内边距 px-[13px]         26px
 ─────────────────────────────────
 = 正文可用宽 T = W − 52px
```

正文字号 14px。该字体 `1ch`（数字 0 的宽度）≈ 0.52em ≈ **7.3px**；一个汉字 = **14px**。

| | 旧值 525 | 新值 440 |
| --- | --- | --- |
| 正文宽 T | 473px | 388px |
| 拉丁 CPL | 65 | **53** ✅ |
| 汉字 CPL | 34 | **28** ✅ |
| 占 1440 窗口 | 36.5% | **30.6%** |
| 书栏剩余（1440 窗口） | ≈ 914px | ≈ 999px（**+9.3%**） |

痕迹面板（生词 / 笔记 / 高亮 / X-Ray）装的是**列表**不是正文，没有 measure 约束，只需要放得下"词 + 释义 + 元信息"一行。按同一比例收：**460 → 400**（占窗口 27.8%）。

`PANEL_MIN_WIDTH = 320` 和 `PANEL_MAX_WIDTH = 700` 不动——用户抱怨的是默认值太宽，不是拖不动。

## 五、顺带说明 `ANSWER_WIDTH`

`MessageBubble.tsx` 里的 `max-w-[68ch]` 是回答气泡的行长上限（68ch ≈ 496px 正文，对应面板 548px）。旧的 525 默认值几乎正好顶到这个上限，等于这个 cap 从来没生效过。收到 440 之后 cap 才真正开始工作：它保证把面板拖到 700px 的用户读到的仍是 68 CPL，而不是 89 CPL。cap 保留，不动。
