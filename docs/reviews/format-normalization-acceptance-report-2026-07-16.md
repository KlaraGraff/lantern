# 格式规整管线验收报告

- **日期：** 2026-07-16
- **被测提交：** `2d26acd5d684efbe6a318c0ca35ae50cdf715cb5`
- **提交说明：** `feat(books): MOBI/AZW3 → EPUB conversion pipeline (Phase 1 + Calibre route A)`
- **验收依据：** [`docs/guide/format-normalization-testing.md`](../guide/format-normalization-testing.md)
- **结论：** **未通过运行时验收。** 后续在未改签名的当前 release `.app`、正常用户目录和正常 iCloud 数据配置下复测，EPUB、PDF，以及 Calibre 成功转换后的 AZW3/MOBI 都稳定出现 `READER_INIT_TIMEOUT`；仅 TXT 读取成功。因此这已不是隔离运行的环境噪音，而是当前构建的真实阅读器故障。Calibre 转换本身通过。

## 1. 版本与构建确认

验收开始及结束时均执行了 `git fetch origin`。本地 `HEAD` 与 `origin/main` 一致，且工作区在写入本报告前干净：

```
HEAD        = 2d26acd5d684efbe6a318c0ca35ae50cdf715cb5
origin/main = 2d26acd5d684efbe6a318c0ca35ae50cdf715cb5
```

测试应用不是历史构建产物：在该提交的工作区中执行了 `npm run package`，随后使用本次生成的 macOS `.app` 进行 GUI 验收。产物时间如下：

```
2026-07-16T16:53:37+0100  dist/assets/index-6RTDiFwd.js
2026-07-16T16:54:40+0100  src-tauri/target/release/bundle/macos/Lantern.app/Contents/MacOS/quill
```

因此，本文观察到的结果**不是由测试旧代码导致**。

## 2. 测试环境与边界

| 项目 | 实际条件 |
|---|---|
| 操作系统 | macOS 真机 |
| 测试应用 | 当前提交构建的 release `.app` |
| 数据目录 | 隔离到 `/tmp/lantern-format-qa-release/`，避免污染既有书库 |
| Calibre | 未安装；`ebook-convert` 不在 `PATH`，`/Applications/calibre.app` 不存在 |
| iCloud 双设备 | 未配置第二台测试设备 |
| 测试文件 | 工作区 `测试文件/` 中的 AZW3、MOBI、EPUB、PDF、TXT 各一份 |

### 2.1 隔离运行的影响

为了让 GUI 自动化能够区分临时测试应用与用户已安装的 Lantern，测试使用了隔离 `HOME`、临时应用路径和 ad-hoc 签名。第一次临时改写 bundle ID 后，Tauri 的资产协议仍按原应用数据根目录授权，导致 iframe 无法读到书籍资源；该阶段的超时结果已作废。

随后恢复原 bundle ID，并以新的临时应用路径、同一隔离数据目录重跑 EPUB/MOBI/AZW3。该阶段仍复现 `READER_INIT_TIMEOUT`，且 TXT 自绘阅读器能正常显示正文。尽管第二阶段不存在已知的 bundle-ID/资产路径错配，它仍不是 `/Applications/Lantern.app` 的常规安装运行方式。因此该现象应记录为：

> **隔离打包环境中的待复测阅读器初始化失败，尚非已确认的生产缺陷。**

### 2.2 正常用户目录复测（本报告最终结论的依据）

在隔离结果之后，已改用下列方式复测：

- 直接启动本提交构建的、**未改签名**的 `src-tauri/target/release/bundle/macos/Lantern.app`；
- 使用实际用户 `HOME`、现有 iCloud 同步配置和活动数据目录；
- 安装 Homebrew cask `calibre` 9.11.0，`ebook-convert` 位于 `/opt/homebrew/bin/ebook-convert`；
- 使用相同的五份真实测试文件。

该环境没有临时 bundle ID、临时应用路径或隔离 `HOME`。因此本节的结果取代“隔离环境待复测”的临时判断：所有 Foliate iframe 路径都复现 `READER_INIT_TIMEOUT`，而不使用 iframe 的 TXT 阅读器正常。

## 3. 静态与构建基线

| 检查 | 结果 | 备注 |
|---|---|---|
| `cd src-tauri && cargo test --lib` | 通过 | 466 passed、0 failed、1 ignored |
| `cd src-tauri && cargo clippy --all-targets` | 通过 | 无 warning/error |
| `npx tsc --noEmit` | 通过 | 无输出、退出码 0 |
| `npm run lint` | 通过 | 无 lint error |
| `npm run package` | 通过 | 已生成 `.app` 与 `.dmg`；仅出现既有 Vite chunk-size 警告 |

## 4. 运行时验收结果

### 4.1 T1、T2：有 Calibre 的 AZW3/MOBI 转 EPUB

**状态：转换通过；阅读失败。** 已安装 Calibre 9.11 并用两个真实样本完成实际转换：

| 样本 | 书籍 ID | `source_format` | `render_format` | `preparation_state` | 本地产物 |
|---|---|---|---|---|---|
| `西学三书…azw3`（KF8/HUFF-CDIC） | `b7745729-2b26-4130-80ca-34cd6e2d72f9` | `azw3` | `epub` | `ready` | `7.1 MB` `.converted.v1.epub` |
| `重读20世纪中国小说…mobi`（MOBI6） | `ec9ae603-b577-4140-ad31-a2760ee00b01` | `mobi` | `epub` | `ready` | `2.7 MB` `.converted.v1.epub` |

两份 EPUB 都可被 Calibre 的 `ebook-meta` 重新解析，并读出正确书名和作者，证明转换器、临时发布和本地重定向产物正常。

但打开两书都会先显示“正在准备书籍...”，约 45 秒后进入错误页：

```
无法打开这本书
READER_INIT_TIMEOUT
```

MOBI6 点击“重试”后完整等待一个超时窗口，仍得到相同错误。因此转换后的选中、AI、标注、进度和 CFI 不能验收通过：失败发生在这些能力之前的首屏阅读器初始化。

### 4.2 T3：无 Calibre 优雅降级

**状态：部分通过。** 当前机器天然满足“无 Calibre”前提；导入两个真实样本后，数据库与 `prepared/` 均符合降级设计。

| 样本 | `source_format` | `render_format` | `preparation_state` | 转换产物 |
|---|---:|---:|---:|---|
| `西学三书…azw3`（KF8/HUFF-CDIC） | `azw3` | `azw3` | `ready` | 无 |
| `重读20世纪中国小说…mobi`（MOBI6） | `mobi` | `mobi` | `ready` | 无 |

两书均立即出现在库页，未出现转换管线的 pending 覆盖层；这证明“探测不到 Calibre 时不入转换队列”的导入分支按预期工作。

但两书从库页打开后均先显示 `Preparing book...`，最终进入错误页：

```
This book could not be opened
READER_INIT_TIMEOUT
```

AZW3 点击一次“Retry”后仍在约 48 秒内失败；MOBI6 也复现同一错误。因此 T3 的“维持原生 Foliate 只读阅读”部分未通过隔离环境验收。

### 4.3 T4、T5、T6：转换失败、崩溃恢复与 Reader 重试分派

**状态：未执行。** Calibre 已安装，但由于所有 Foliate 阅读器均已在基本打开用例失败，未继续人为构造转换失败、强杀进程或 Reader 重试分派场景。

### 4.4 T7：双设备 iCloud 同步

**状态：未执行。** 缺少第二台设备和 Calibre 的两种安装状态，无法验证本地推导的 pending、每设备独立产物以及 iCloud 不同步 `*.converted*.epub` 的不变量。

### 4.5 T8：ready 产物丢失后的自愈

**状态：未执行。** 已具备转换产物，但尚未删除活动书库中的产物来验证自愈；应在修复基础阅读器故障后进行，避免把多个失败原因混在一起。

### 4.6 T9：格式回归

#### 导入与预处理

下列三种回归样本均成功导入：

| 样本 | `source_format` | `render_format` | `preparation_state` | 结果 |
|---|---:|---:|---:|---|
| `谈美…epub` | `epub` | `epub` | `ready` | 导入通过 |
| `被讨厌的勇气…pdf` | `pdf` | `pdf` | `ready` | 导入通过 |
| `The Alchemist…txt` | `txt` | `text` | `ready` | 导入与后台预处理通过 |

TXT 在导入后 8 秒内从准备状态收敛为 `ready`，并在本地 `prepared/` 生成：

```
457ce343-4cf7-4351-b374-0af64d4bd915.v3.json
```

目录中没有转换书的 `.converted.v1.epub` 或 `.tmp.epub`。这符合无 Calibre 情形不创建转换产物的预期。

#### 阅读器

- **TXT：通过。** 在正常用户目录运行的当前构建中，打开后立即显示第一章 `PART ONE`，证明 text-preparation 与自绘文本阅读器链路可用。
- **EPUB：失败。** 正常用户目录复测后出现 `READER_INIT_TIMEOUT`。
- **PDF：失败。** 正常用户目录复测后出现 `READER_INIT_TIMEOUT`。
- **FB2 / FBZ / CBZ、已有原生 MOBI/AZW3：未执行。**

### 4.7 T10：失效 saved CFI 的超时自愈

**状态：未执行。** 未准备带失效 saved CFI 的 EPUB；同时，隔离环境中所有已尝试的 Foliate 路径本身存在初始化超时，不能在该环境对 CFI 专项逻辑得出有效结论。

## 5. 最终测试数据库快照

验收结束前，隔离数据库中的格式状态如下：

| `source_format` | `render_format` | `preparation_state` | 书籍数 |
|---|---|---|---:|
| `azw3` | `azw3` | `ready` | 1 |
| `epub` | `epub` | `ready` | 1 |
| `mobi` | `mobi` | `ready` | 1 |
| `pdf` | `pdf` | `ready` | 1 |
| `txt` | `text` | `ready` | 1 |

该快照仅位于隔离目录，不影响用户的生产库。

## 6. 验收结论

本次不能签发格式规整管线的运行时验收。可以确认的部分是：

1. 当前测试的是 `origin/main` 的最新提交和该提交的新鲜打包产物，不存在以旧代码替代修复后代码的情况。
2. 无 Calibre 时，AZW3/MOBI 导入不会误进转换管线；格式列、准备状态和产物目录均符合降级设计。
3. 安装 Calibre 后，KF8 AZW3 与 MOBI6 均成功转换为有效 EPUB；状态机、产物发布和读取层重定向均通过。
4. TXT 导入、预处理和阅读通过。
5. EPUB、PDF 及两本转换后的 EPUB 均在正常用户目录中复现 `READER_INIT_TIMEOUT`，所以这些格式当前**不能正常阅读**。这是真实的当前构建故障，不是临时隔离环境造成的假象。
6. 转换失败、崩溃恢复、双设备 iCloud、产物丢失自愈和失效 CFI 自愈尚未覆盖，不能视为通过。

## 7. 后续验收建议

1. 先修复或定位 Foliate `view.init()` 的 `READER_INIT_TIMEOUT`；在此之前，任何 EPUB/PDF/MOBI/AZW3 的“可阅读”验收都无法通过。
2. 修复后，重新打开两份已转换 EPUB，验证正文显示、选中、AI、手动标注、进度和 CFI。
3. 再依次执行 T4、T5、T6、T8 的失败/恢复闭环，以及两设备条件下的 T7。
4. 准备一个故意失效的 EPUB saved CFI，补做 T10。

## 8. 清理与变更

- 隔离测试应用进程已停止；后续复测使用当前构建的未改签名 release `.app` 和正常用户目录。
- AZW3、MOBI 及其本地转换产物已导入活动 Lantern 库；这是为执行真实 Calibre 验收所做的测试数据写入。
- 本次未修改产品源码、测试实现或配置；本报告记录了测试结论的更新。
