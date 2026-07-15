# Quill Personal

[简体中文](README.md) · [English](README.en.md)

Quill Personal 是一款 macOS 阅读应用，帮助你通过原版书进行英语学习。它将温暖、适合长时间阅读的阅读界面，与上下文 AI 查词、持续的阅读对话、词汇学习和文内学习标记结合在一起。

这是一个基于开源项目 [Quill](https://github.com/yicheng47/quill) 独立维护的个人版本，并非原项目的官方发行版。

## 功能支持

- 支持导入 EPUB、PDF、TXT、Markdown、HTML、MOBI/AZW/AZW3、FB2/FBZ 和 CBZ。
- 每本书均提供上下文查词、段落解释、翻译和可展开的 AI 对话面板。
- 保存词汇、查词历史、学习状态，并可在可重排 EPUB 文本中显示可选的学习标记。
- 每个服务商配置可保存多个 API 密钥；开始生成前，会按配置优先级依次尝试可用密钥。
- 支持 OpenAI 兼容 API、Anthropic、Ollama，以及可选的 OpenAI OAuth。
- 本地优先保存书库数据。API 密钥和 OAuth 令牌仅保存在本地凭据数据库中，绝不返回给 Webview，也不会参与同步。
- 可通过用户在 iCloud Drive 中选择的文件夹，在多台设备间同步。

### 文件格式能力

| 源格式 | 导入方式 | 阅读控制 | 选择与手动高亮 | 自动词汇标记 |
| --- | --- | --- | --- | --- |
| EPUB | 原生阅读 | 字体、行距、页边距、滚动/分页流式阅读 | 支持 | 支持 |
| TXT、Markdown、HTML | 保留原始文件，并转换为稳定的内部 EPUB | 与 EPUB 相同 | 支持 | 支持 |
| PDF | 原生阅读 | 主题、缩放、单页/双页布局、滚动/分页阅读 | PDF 具备可用文本层时支持 | 首个版本未提供 |
| MOBI、AZW、AZW3、FB2、FBZ | 通过 Foliate 原生解析器阅读 | 渲染器支持时可使用流式阅读控制 | 暂未开放 | 不支持 |
| CBZ | 原生阅读 | 仅主题 | 不支持 | 不支持 |

文件格式支持描述的是当前本地导入和阅读器集成能力，并不代表支持 DRM，也不保证能完美渲染每一种出版商特定的文件变体。

## 同步

Quill Personal 不使用原版 Quill 的 iCloud 容器。请在“设置”中选择你自己 iCloud Drive 内的一个文件夹进行同步，然后在每台 Mac 上选择同一个文件夹。应用会将事件日志、书籍和封面存储在该文件夹中。

当前版本面向 macOS 桌面端，不宣称与原版 Quill 的 iOS 应用或其私有 iCloud 数据兼容。

## 下载

当前构建和发行说明发布在 [KlaraGraff/quill Releases](https://github.com/KlaraGraff/quill/releases)。macOS 构建目前使用有效的临时签名，因此 Gatekeeper 仍会在首次运行时要求确认。签名和公证计划请参见 [macOS 分发](docs/guide/macos-distribution.md)。在此分支拥有自己的签名发行渠道前，自动更新保持禁用。

## 开发

要求：Node.js 22、npm、Rust，以及目标平台所需的 Tauri 前置依赖。克隆仓库时请一并获取阅读器引擎子模块：

```bash
git clone --recurse-submodules https://github.com/KlaraGraff/quill.git
cd quill
npm ci
npm run tauri dev
```

如果已经克隆仓库，请执行一次 `git submodule update --init --recursive` 初始化子模块。

常用静态检查：

```bash
npm exec tsc --noEmit
npm run lint
cd src-tauri && cargo check
```

仓库协作约定见 [AGENTS.md](AGENTS.md)。

## 致谢与许可证

Quill Personal 基于 yicheng47 开发的 Quill。原版 Quill 的版权仍归其作者所有；本仓库保留原始 [MIT License](LICENSE)，包括其中的版权声明。
