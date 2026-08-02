<div align="center">

<img src="assets/icon.png" width="112" alt="Lantern">

# Lantern

**读英文原著时，让 AI 用你听得懂的话解释。**

[![Release](https://img.shields.io/github/v/release/KlaraGraff/lantern?style=flat-square&color=1f6feb&label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/KlaraGraff/lantern/releases)
[![Platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-macOS%20%C2%B7%20Windows-555?style=flat-square)](#支持的平台)
[![License](https://img.shields.io/badge/License-MIT-555?style=flat-square)](LICENSE)

[简体中文](README.md) · [English](README.en.md) · [下载](https://github.com/KlaraGraff/lantern/releases)

</div>

<!-- 截图占位：阅读器全景（正文 + 查词卡 + AI 侧栏）。拍摄要求见 docs/guide/screenshots.md -->
![Lantern 阅读界面](assets/screenshots/hero.png)

---

## 卡住你的从来不是故事

你打开一本英文小说，读得下去，但每隔几行就要停一次。停下来查词，词典给你一串互不相干的义项，你还得自己猜哪个对；换成 AI 查词，它回你一段用词更难的英文——一个生词换来一整句看不懂的解释。等你查完再回到原文，刚才那段讲什么已经忘了。

**Lantern 想解决的是这个循环。** 它是一款 macOS 和 Windows 上的桌面阅读器，本地优先，用你自己的 AI 服务。它和别的「AI 阅读器」的区别集中在两件事上：

1. **AI 的解释难度会配合你的英语水平**，而不是永远用母语者的英语回答你。
2. **AI 说什么、怎么说、说多少，由你定义**——预设不合用，你可以自己写。

> 这是基于开源项目 [Quill](https://github.com/yicheng47/quill) 独立维护的个人版本，并非原项目的官方发行版。

---

## 一 · 解释的难度，跟着你的水平走

大多数阅读工具的「英语解释」是一个开关：打开，就给你一段接近母语者的英文。对 B1 的读者来说，这段解释本身就是新的障碍。

Lantern 把英语水平当作**每一次请求的条件**，而不是界面上的一个偏好。你可以在个人资料里直接填 CEFR 等级（A1–C2），也可以填雅思、托福、托业、剑桥英语、DET 或四六级成绩，由应用换算成学习等级。

之后每一次查词、短语释义和段落解读，AI 都会同时参考你的等级、解释语言、目标译文语言和内容密度：

| 你的等级 | AI 怎么解释 |
| --- | --- |
| **A1–A2** | 以准确的中文义为基础，配一句符合当前水平的简明英文。不会「用更难的英文解释简单英文」。 |
| **B1** | 以英文解释为主；抽象的、容易误解的部分保留必要的中文辅助。 |
| **B2–C2** | 提供更自然、更深入的英语解释，需要时再展示目标语言翻译。 |

选「英语优先」不等于接受看不懂的母语级解释——AI 会主动压住词汇量和句子复杂度，让解释本身也是**可理解的输入**。你可以从「先看懂」开始，慢慢过渡到「用英语理解英语」，而不必被一段读不懂的英文再打断一次。

<!-- 截图占位：学习等级设置界面，以及同一个词在 A2 与 C1 下的两张查词卡对比 -->
![按英语水平调整的解释](assets/screenshots/level.png)

---

## 二 · 预设模块只是起点，工具应该由你来造

一张查词卡上该出现什么？语境含义、词性、常见义项、搭配、词根词缀、语法角色、近义词、用法、记忆提示、原句出处——Lantern 内置了这些模块，单词卡 11 个、短语卡 8 个、段落卡 9 个，每一个都能单独开关、排序、设默认展开状态和内容密度。

**但预设不该限定你的学习方法。**

如果现有模块不够用，你可以自己造一个 AI 模块：

- 给模块起名字，写**完全属于你自己的提示词**（最长 2000 字）。
- 让它基于当前选区、上下文和书籍信息生成内容。
- 把它加进单词、短语或段落卡片，和内置模块一起显示、隐藏、排序、设展开。
- 在设置里即时预览卡片结构；确认要看真实效果时，再调用一次真正的 AI。
- 每种卡片最多 8 个自定义模块，另外还能建 6 个自定义选区操作，绑快捷键或双击触发。

比如你可以做出这些：

- 面向雅思或考研的**长难句拆解**模块；
- 用于文学作品的**修辞、叙事视角与语气**模块；
- 用于专业书籍的**术语、前置知识与应用场景**模块；
- 用于写作积累的**可复用表达与改写建议**模块；
- 只保留最少信息、不打断沉浸阅读的**极简查词**模块。

<!-- 截图占位：自定义模块编辑器（提示词输入）+ 卡片设计设置的模块排序 -->
![自定义 AI 模块](assets/screenshots/modules.png)

---

## 三分钟上手

1. **下载安装** —— 从 [Releases](https://github.com/KlaraGraff/lantern/releases) 取对应平台的安装包。macOS 首次打开时 Gatekeeper 会要求确认（原因见[下载](#下载)）。
2. **填一个 AI 服务** —— 打开「设置 → AI 服务」，填 OpenAI 兼容 API、Anthropic、Ollama 或自建网关，测试连接。密钥只存在这台设备上。
3. **拖一本书进来** —— 把 EPUB / PDF / TXT 拖进书库，打开它，**双击任意一个单词**。

想让它更贴合自己：去「设置 → 个人资料」填英语等级，去「设置 → 卡片设计」调你想看的模块。

---

## 完整功能

<table>
<tr><td width="180"><b>AI 理解</b></td><td>

语境查词 · 短语释义 · 段落解读 · 整段翻译 · 书内持续对话（把单词、原句、已有释义和阅读位置一并带进对话）· 语义检索（用 embedding 索引补充字面匹配）· 明确展示本次引用了哪段原文，可随时移除

</td></tr>
<tr><td><b>学习闭环</b></td><td>

生词本 · 查询历史 · 「新词 / 学习中 / 已掌握」学习状态 · FSRS 间隔重复复习 · 笔记中心（附在单词和段落上，可搜索）· CSV / JSON 词汇导入导出 · 一键回到原文位置

</td></tr>
<tr><td><b>正文标记</b></td><td>

查词后自动标记 · 可选只标当前位置或全书同词 · 手动高亮 · 自定义颜色、透明度、高亮 / 下划线 / 加粗样式与字体 · 不改动原书内容

</td></tr>
<tr><td><b>阅读体验</b></td><td>

暖色纸感主题与自定义背景色 · 导入自定义字体 · 字号、行距、页边距、阅读布局 · 滚动与分页切换 · 书签 · 目录侧栏 · 阅读进度 · 多窗口同时读多本 · 合集文件夹管理书库

</td></tr>
<tr><td><b>朗读</b></td><td>

四种音源：词典真人录音 / 系统语音 / Edge 神经语音 / 自定义 OpenAI 兼容 TTS · 自动按内容长短选音源 · 逐句跟随高亮 · 暂停后从停下的地方继续

</td></tr>
<tr><td><b>AI 服务</b></td><td>

OpenAI 兼容 API · Anthropic · Ollama · 可选 OpenAI OAuth · 可加多个服务并设优先级 · 每个服务可存多个 Key，输出开始前按优先级自动试可用的 Key 和服务 · 连接测试与模型发现

</td></tr>
<tr><td><b>集成与工具</b></td><td>

MCP 服务器——把书库、生词本和笔记开放给 Claude Code、Codex 等 AI 客户端，读写权限可关 · 扫描版 PDF 的 OCR · 可编辑的书籍来源站点列表 · 书籍元数据编辑

</td></tr>
</table>

---

## 支持的平台

| 平台 | 支持范围 |
| --- | --- |
| **macOS** | macOS 12 Monterey 或更高，**仅 Apple Silicon（M 系列）**。主要平台，功能最全。 |
| **Windows** | 提供 Windows 11 x64 安装包。可本地阅读并使用全部 AI 功能，**不含 iCloud 文件夹同步**。 |
| Intel Mac | 当前不提供安装包。 |
| Linux | 当前不提供发行版本。 |
| iOS | 开发中，尚未发布。进度见 [路线图](docs/roadmap/mobile-ios.md)。 |

---

## 支持的格式

| 格式 | 导入方式 | 阅读控制 | 选择与手动高亮 | 自动词汇标记 |
| --- | --- | --- | --- | --- |
| **EPUB** | 原生阅读 | 字体、行距、页边距、滚动 / 分页 | ✅ | ✅ |
| **TXT · Markdown · HTML** | 保留原文件，转换为稳定的内部 EPUB | 同 EPUB | ✅ | ✅ |
| **PDF** | 原生阅读 | 主题、缩放、单页 / 双页、滚动 / 分页 | 有可用文本层时 ✅ | ❌ |
| **MOBI · AZW · AZW3 · FB2 · FBZ** | 通过 Foliate 原生解析器 | 渲染器支持时可用流式控制 | ❌ | ❌ |
| **CBZ** | 原生阅读 | 仅主题 | ❌ | ❌ |

以上描述的是当前的本地导入与阅读器集成能力。不支持 DRM，也不保证完美渲染每一种出版商特定的文件变体。

---

## 你的数据在哪

- **书库数据本地优先。** 书、阅读进度、生词本、笔记都存在这台设备上。
- **API Key 与 OAuth 令牌只保存在本机的凭据数据库里**，不会返回给界面层，也不参与同步。
- **需要多设备同步时**，在设置里选一个你自己 iCloud Drive 里的文件夹，每台 Mac 选同一个。应用把事件日志、书籍和封面放在那里。当前版本不使用原版 Quill 的 iCloud 容器，也不宣称与原版 Quill 的 iOS 应用或其私有 iCloud 数据兼容。
- **AI 请求默认只发送完成当前任务所需的上下文**，不会自动上传整本书。

---

## 下载

安装包和发行说明发布在 [Releases](https://github.com/KlaraGraff/lantern/releases)。

macOS 构建目前使用临时签名（ad-hoc），因此 Gatekeeper 会在首次运行时要求确认。签名与公证计划见 [macOS 分发](docs/guide/macos-distribution.md)。在这个分支有自己的签名发行渠道之前，自动更新保持关闭。

---

## 开发

要求：Node.js 22、npm、Rust，以及目标平台的 Tauri 前置依赖。阅读器引擎（foliate-js）源码已随仓库提交。

```bash
git clone https://github.com/KlaraGraff/lantern.git
cd lantern
npm ci
npm run tauri dev
```

常用静态检查：

```bash
npm exec tsc --noEmit
npm run lint
cd src-tauri && cargo check
```

技术栈：Tauri 2 + Rust + SQLite（后端），React 19 + TypeScript + Tailwind 4（前端），foliate-js（EPUB 渲染）。仓库协作约定见 [AGENTS.md](AGENTS.md)。

---

## 致谢与许可证

Lantern 基于 yicheng47 开发的 [Quill](https://github.com/yicheng47/quill)。原版 Quill 的版权仍归其作者所有；本仓库保留原始 [MIT License](LICENSE)，包括其中的版权声明。
</content>
