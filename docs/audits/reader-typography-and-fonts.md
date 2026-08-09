# 阅读排版与字体调研

调研日期：2026-08-09 · 基线 commit `735d705` · **纯调研，未改任何代码**

调研范围：两端对齐、首行缩进、以及默认字体。对照对象是同栈或同类的成熟开源阅读器，
外加排版规范文献与真实用户反馈。

---

## 一、Lantern 现状（代码事实）

排版 CSS 全部由 `src/pages/reader/reader-typography.ts` 的 `getParagraphTypographyCSS()`
生成，注入进 foliate 每个章节 iframe（`src/pages/reader/reader-theme.ts` 的 `getReaderCSS()`）。
纯文本（.txt）走另一条路：`src/components/TextBookReader.tsx:1431-1447` 用内联样式。

| 项 | 默认值 | 位置 |
| --- | --- | --- |
| 两端对齐 `textJustification` | `false` | `useReaderSettingsSync.ts:165` |
| 首行缩进 `firstLineIndent` | `false` | `useReaderSettingsSync.ts:167` |
| 段间距 `paragraphSpacing` | `"original"`（沿用出版方） | `useReaderSettingsSync.ts:166` |
| 行距 | `1.8` | `useReaderSettingsSync.ts:162` |
| 字号 | `26px` | `useReaderSettingsSync.ts:151` |
| 字体 | `palatino` | `useReaderSettingsSync.ts:151` |
| 行宽上限 | `34em`（下限 `22em`） | `reader-settings.ts:14,18` |

排版规则细节：

- 两端对齐 → `text-align: justify !important` 打在 `p` 上，同时开 `hyphens: auto`。
- 断词限制：`-webkit-hyphenate-limit-before: 5` / `-after: 4` / `-lines: 2`，
  以及 `hyphenate-limit-chars: 10 5 4`。
- 首行缩进 → 西文 `1.5em`、CJK `2em`（`:lang(zh|ja|ko)` 分支）。
- 缩进例外：节首段、紧跟标题/`<hr>` 的段、含图段（`markTypographyIndentExceptions`、
  `markTypographyMediaParagraphs`）。
- 出版方首字下沉的 `line-height` 会被读出来保护（`markTypographyDropCapParagraphs`）——
  这块做得比对照组都细。
- `body { text-wrap: pretty }`、标题 `text-wrap: balance` + `hyphens: none`、
  `pre/code` 禁断词——都已经有了。

字体现状：

- 打包 10 个 OFL 字体（Literata、Libre Baskerville、EB Garamond、Source Serif 4、
  Crimson Pro、Newsreader、Spectral、Vollkorn、Atkinson Hyperlegible、Lexend），
  只有 latin + latin-ext 子集。
- 系统字体项 5 个：System / Georgia / Palatino / Times New Roman / Inter。
- CJK 回退硬绑在西文字体上：`CJK_SERIF = '"Songti SC", "SimSun"'`、
  `CJK_SANS = '"PingFang SC", "Microsoft YaHei"'`（`builtin-fonts.ts:56-57`）。
- 另有可下载的「增强中文衬线字体包」（`enhanced_fonts.rs`，家族名
  `Lantern Enhanced Chinese Serif`）。

---

## 二、同类项目怎么做

### Readest（最值得对照：同为 Tauri + foliate-js）

`apps/readest-app/src/services/constants.ts` 的默认值：

```
fullJustification: true          // 桌面
hyphenation:       true
textIndent:        0             // 西文
paragraphMargin:   0.6           // em
lineHeight:        1.4
defaultFontSize:   16
serifFont:         'Bitter'
defaultCJKFont:    'LXGW WenKai GB Screen'
overrideFont/overrideLayout: false   // 默认尊重出版方

DEFAULT_MOBILE_VIEW_SETTINGS:  fullJustification: false   // 窄栏关掉
DEFAULT_CJK_VIEW_SETTINGS:     fullJustification: true, textIndent: 2,
                               paragraphMargin: 1, lineHeight: 1.6
```

两条设计取向值得注意：**默认值按脚本和屏宽分叉**（CJK 一套、西文一套、手机一套），
以及**默认不覆盖出版方**（`overrideLayout: false` 时不加 `!important`）。

CSS 生成（`src/utils/style.ts:545-670`）里 Lantern 没有的东西：

- `html { orphans: 2; widows: 2; hanging-punctuation: allow-end last }`，
  CJK 段落再降到 `widows: 1; orphans: 1`。
- 段落选择器覆盖 `p, blockquote, dd, div:not(:has(*:not(<行内标签>)))`——**div 段落也算段落**。
- 缩进例外更全：`li p, ol p, ul p, td p`、`.noindent/.nonindent`、纯图片段、居中段。
- 断词限制是 `before: 3 / after: 2 / lines: 2`。
- 对齐判定不靠猜：章节加载时对每个 `div/p/blockquote/dd` 读一遍
  `getComputedStyle().textAlign`，打上 `aligned-center/left/right/justify` 类，
  再由 CSS 决定要不要覆盖（`style.ts:1270-1305`；他们踩过性能坑，最终是读写分离两遍循环，
  否则每次 `classList.add` 都会让下一次 `getComputedStyle` 触发全文档重算样式）。

### Readium CSS（EPUB 阅读器的参考实现，Thorium 用它）

`docs/CSS14-user_settings_recs.md` 两句关键结论：

> "Typography-wise, it is OK to hyphenate body copy with `text-align: left`,
> it is **critical** to hyphenate body copy with `text-align: justify`."

> "Declaring `text-align: justify` for those elements would indeed degrade legibility"
> ——指标题、表格、`pre` 等结构性元素。

并且明确：作者意图明显时不该覆盖，判断要靠 JS 读实际样式。

### KOReader / crengine

默认字体 Noto Serif；默认开两端对齐，并且自带各语言 hyphenation pattern 词典
（来自 hyphenation.org / LibreOffice）。它被反复夸的正是"有像样的断词规则，
所以不会出现两端对齐常见的白色河流"。代价是它自己实现了排版引擎，我们做不到也不需要。

### foliate（GTK，foliate-js 的上游）

功能列表里 auto-hyphenation 是招牌特性之一，和两端对齐配套提供。

### 商业阅读器

- Kindle：默认 Bookerly（Dalton Maag 为亚马逊定制，2015 年替掉 Caecilia），
  为屏幕重新调过字重与间距，官方称眼动测试下阅读速度 +2%、疲劳下降。
- Apple Books：New York（Apple 自家屏幕书体，本机 `/System/Library/Fonts/NewYork.ttf`）。
- 两家都是「默认给一个专为屏幕设计的书体」，而不是复用系统里的印刷体。

---

## 三、用户吐槽的四类

从 Readest issue 区（同栈，最贴近）、MobileRead、KDP/Goodreads 作者社区、
知乎/CSDN 中文排版讨论里归纳：

1. **两端对齐 + 不断词 = 词距忽大忽小、白色河流。** 中英文社区口径一致：
   "为了避免词间距忽大忽小，应当确保开启 hyphenation"。反向的吐槽是断词太凶——
   KOReader 有一堆"怎么关掉断词"的求助帖，以及 issue #12913「断词跨页」的抱怨
   （上一页结尾 `enthusi-`、下一页开头 `astic`，在慢刷新的墨水屏上很难受）。
   结论不是"要不要断词"，而是**断词的激进程度要落在一个窄区间里**。
2. **强制对齐/缩进踩坏出版方的有意排版。** Readest #1105（居中段落被加了缩进）、
   #1106（首字下沉段缩进出现两次）、#1609（列表项里的段落被缩进）、
   #1153（开了缩进后图片被挤到下一页）。
3. **缩进出现在不该出现的位置。** Readest #3088：分页模式下，上一页的续行落到新页开头时
   也带了缩进——"它不是新段落，是上一段的延续"。
4. **两端对齐的开关和断词开关语义不清。** Readest #1877：关掉两端对齐后断词还在，
   而且断在了本来不需要断的地方。以及 #266/#338：手机窄栏该默认关掉两端对齐，
   但 CJK 即使在手机上也该默认开——**同一个开关在不同脚本下的正确默认值是相反的**。

---

## 四、排版：发现的问题

### A. 断词阈值太保守，等于「两端对齐但几乎不断词」

`hyphenate-limit-chars: 10 5 4` 只有 Chromium 认（Chrome 128+ / Firefox 137+，
**Safari 至今不支持**）；`-webkit-hyphenate-limit-before/after` 只有 WebKit 认，
Chromium 不认。所以实际生效的阈值是：

- macOS（WKWebView）：前 5 + 后 4 = 最短 9 字母的词才会断。
- Windows（WebView2）/ Linux：`10 5 4` = 最短 10 字母。

英文正文里 ≥10 字母的词大约占 3–5%。也就是说**打开两端对齐后，断词基本不发生**，
拉伸全部摊到词距上——正是 Readium CSS 点名的最差组合。

代码注释里写的判据是对的：「只有当把这个词推到下一行会留下显眼的空隙时，才值得断开」。
但按这个判据算，阈值应该更低而不是更高：34em 的行大约有 10 个词间空隙，
一个 6 字母词约 3em 宽，摊下来每个空隙 +0.3em，而正常词距只有约 0.25em——
空隙直接翻倍，肉眼非常明显。所以 6 字母就已经越过"显眼"这条线了。

对照：Readest `before 3 / after 2`；TeX 英文默认 `\lefthyphenmin=2 \righthyphenmin=3`
（最短词长 5）；InDesign 默认「至少 5 个字母、前留 2、后留 2」。

建议：两套属性都保留（各平台各取所需），值统一到
`before: 3 / after: 3` + `hyphenate-limit-chars: 6 3 3`，`hyphenate-limit-lines: 2` 保持不变
（这条已经能挡住"连续几行都以连字符结尾"的梯子）。

### B. `hyphens: auto` 依赖 `lang`，书没声明语言时静默失效

浏览器只在元素有 `lang` 且系统有对应断词词典时才断词。foliate 会补
`doc.documentElement.lang ||= this.language.canonical`（`public/foliate-js/view.js:354`），
但书的 `dc:language` 缺失时 baseLang 是 `'und'`（`epub.js:207-208`）——
`lang="und"` 没有词典，断词全程不发生，两端对齐退化成纯拉伸。
需要实测确认三平台的行为，尤其 Windows 的 WebView2 是否随包带英文词典。

### C. 只管 `p`，`div` / `li` / `dd` / `blockquote` 段落完全不受控

`getParagraphTypographyCSS()` 的选择器只有 `p`。相当多 EPUB（尤其中文转档、
早年扫校版）用 `<div class="p">` 当段落。这些书上，两端对齐和首行缩进开了没有任何反应，
用户只会认为功能坏了。Readest 的做法是把「所有子孙都是行内元素的 div」也当段落。

### D. 靠 class / style 字符串猜「居中段落」，不如读计算样式

现在的排除白名单是 `.center`、`.title`、`.heading`、`[style*="text-align: center"]` 这一类。
出版方用 `.poem` / `.verse` / `.epigraph`，或者把居中写在外部 CSS 文件里，
就会被 `text-align: justify !important` 强行拉直。

两条路，建议选后者或两者都做：

1. 抄 Readest：加载时读一遍计算样式，打对齐标记类，按真实意图决定要不要覆盖。
   （连他们的性能教训一起抄：必须读写分离两遍循环。）
2. **更简单也更根本**：去掉 `!important`，改成在 `html, body` 上设 `text-align`，
   靠继承生效。出版方显式声明的对齐天然赢过继承值。Lantern 目前并没有
   「强制覆盖出版方排版」这个产品开关，所以 `!important` 本来就没有存在的理由。

### E. 分页模式没有 orphans / widows

foliate 用 CSS 多栏分页，`orphans` / `widows` 在多栏里是生效的。现在两个都没设，
会出现「一页最后只剩段首孤零零一行」或「一页开头只有上段的最后一行」。
Readest 设 `orphans: 2; widows: 2`，CJK 降到 1。改动成本极低，收益是每一页都受益。
（`text-wrap: pretty` 已经有了，但它只管段内最后一行的孤字，管不了跨栏。）

### F. 首行缩进和段间距是「二选一」的信号，现在可以同时打开

西文传统里，缩进和段间空白是两种互斥的分段信号，同时用是冗余。
中文当代电子阅读则习惯两者都要（2em 缩进 + 段距）。Readest 正是这么分的：
西文 `textIndent: 0 + 段距 0.6em`，CJK `textIndent: 2em + 段距 1em`。
Lantern 现在两个开关互不知情，西文书上同时打开会得到不像书的排版。

### G. 缩进例外还差几类

已覆盖：节首段、标题/`<hr>` 后首段、含图段。缺：`li p / ol p / ul p / td p`
（Readest #1609 就是这个），以及出版界常用的 `.noindent` / `.nonindent` 类。

### H. 纯文本（.txt）阅读器和 EPUB 是两套逻辑，行为不一致

`TextBookReader.tsx:1431-1447`：

- 没有「节首段不缩进」的例外，每段都缩。
- `hyphens: auto` 全开，**完全没有任何 limit 属性**——断词比 EPUB 路径激进得多。
- 用整本书的**第一个**段落判断是不是 CJK（`isCjk`），中英混排的书会整本判错。

这条属于「同一个开关，两种格式下表现不同」，用户遇到时会当成随机 bug。

---

## 五、字体：发现的问题

### I. 默认字体 `palatino` 是整份列表里唯一在 Windows / Linux 上不存在的那个

`Palatino` 这个家族名只有 macOS 有（本机确认 `/System/Library/Fonts/Palatino.ttc`，
属于核心字体，必然存在）。Windows 上对应的家族名是 `Palatino Linotype`（或 Book Antiqua），
CSS 里写 `Palatino` 匹配不上。

更麻烦的是回退链的顺序：`Palatino, "Songti SC", "SimSun", serif`。
CSS 字体匹配是**逐字符**进行的，而 **SimSun 含完整的拉丁字形**。
于是 Windows 用户全新安装、打开一本英文书，正文实际渲染的是宋体的西文——
细、为 96dpi 小字号做的 hinting，到默认的 26px 就发虚。
`builtin-fonts.ts:50-51` 的注释里已经写明「SimSun 是给 90 年代低分辨率屏幕做 hinting 的，
到阅读尺寸就软」——默认路径正好掉进自己点名的那个坑。

Linux 看 fontconfig 有没有装 URW Palladio 别名，多数发行版没有，同样掉到 SimSun 或 serif。

两处要改：

1. 默认换掉（见 J）。
2. 所有「系统字体」条目的 CJK 面要么排到 generic keyword 之后，
   要么用 `unicode-range` 把 CJK 面限定在 CJK 码位——`src/index.css:45-50` 的
   `Lantern Review CJK` 已经是后一种写法，阅读器的链没跟上。

### J. 打包了 10 个专为屏幕设计的开源字体，默认却用系统印刷体

建议默认改成 **Literata**：Google 为 Play Books 定制，专门针对屏幕与电子墨水，
可变字重、有真斜体、OFL、**已经在包里**。它和 Kindle 的 Bookerly、Apple Books 的 New York
是同一类「屏幕优先书体」，这也正是两家商业阅读器的默认策略。

次选 Source Serif 4（x-height 高、可变、Adobe）。
EB Garamond / Crimson Pro 在正文尺寸下细笔画偏轻，做可选项很好，做默认不合适。
Readest 默认 Bitter，也是屏幕书体，但更粗更方，长文偏硬。

顺带：默认换成打包字体，等于三个平台的默认观感第一次一致，也不再依赖系统装了什么。

### K. 可下载的「增强中文衬线字体包」对正文毫无作用

`Lantern Enhanced Chinese Serif` 只出现在 `src/index.css:55` 的 `--font-serif`
（应用 UI / 复习卡），而且排在 `Songti SC` **之后**——macOS 上永远轮不到它。
阅读器自己的 CJK 回退链 `CJK_SERIF = '"Songti SC", "SimSun"'` 根本没提这个家族。

结果是：用户按提示下载了字体包，阅读界面里的中文（AI 讲解、注释、中文书正文）
仍然是宋体 / SimSun。这个功能目前基本没兑现它的承诺。

### L. 没有独立的中文字体选择

CJK 面是硬绑在西文字体上的：serif 系 → Songti/SimSun，sans 系 → PingFang/YaHei。
对「中文用户读英文书、看中文讲解」这个核心场景，屏幕上中文那一半的观感用户完全控制不了。
Readest 有独立的 `defaultCJKFont` 槽位。这是产品决策，不是纯技术问题。

### M. 次要：行距 1.8 对西文正文偏松

Readest 西文 1.4 / CJK 1.6；通行建议是西文 1.4–1.6、CJK 1.7–2.0。
26px + 1.8 + 34em 行宽上限，一屏字数明显少于同类。可以考虑按脚本给不同默认。

### N. 次要：打包字体只有 latin + latin-ext 子集

法语、西语、德语没问题；希腊语、俄语、越南语会掉到 SimSun / serif。
对一个英语学习阅读器，优先级低，但值得知道。

---

## 六、建议的优先级

**P0 — 性质上是修 bug，不改产品形态：**

1. 默认字体 `palatino` → `literata`（`useReaderSettingsSync.ts:151`）；
   同时修所有系统字体项的回退链顺序 / 加 `unicode-range`（问题 I）。
2. 断词阈值 9–10 字符 → `6 3 3`，两套属性都写（问题 A）。
3. 分页模式加 `orphans: 2; widows: 2`，CJK 降到 1（问题 E）。
4. 段落选择器扩到 `div`（全行内子孙）、`li`、`dd`、`blockquote`（问题 C）。
5. 缩进例外补 `li p / td p` 和 `.noindent` / `.nonindent`（问题 G）。
6. 增强中文字体包接进阅读器 CJK 字体链（问题 K）。
7. .txt 路径和 EPUB 路径对齐：节首例外、断词 limit、逐段判 CJK（问题 H）。

**P1 — 要用户拍板：**

8. 去掉 `text-align: justify !important`，改继承 + 计算样式判定（问题 D）——
   这会改变「出版方已经设了居中/左对齐的段落」的表现，是可见的行为变化。
9. 首行缩进 / 段间距按脚本分默认，并处理两者同时打开的情况（问题 F）。
10. 独立的中文字体选择项（问题 L）。
11. 行距默认按脚本分叉（问题 M）。

---

## 参考

- Readest 源码：`apps/readest-app/src/services/constants.ts`、`src/utils/style.ts`
  <https://github.com/readest/readest>
- Readium CSS 用户设置建议
  <https://github.com/readium/css/blob/master/docs/CSS14-user_settings_recs.md>
- KOReader / crengine 断词
  <https://deepwiki.com/koreader/crengine/2.3-text-processing-and-hyphenation>
- `hyphenate-limit-chars` 兼容性（Safari 不支持）
  <https://caniuse.com/mdn-css_properties_hyphenate-limit-chars>
- CSS 断词依赖 `lang` 与词典
  <https://clagnut.com/blog/2395>
- Bookerly 设计背景
  <https://en.wikipedia.org/wiki/Bookerly>
- 中文排版：缩进与段距的取舍
  <https://zhuanlan.zhihu.com/p/19891152>
