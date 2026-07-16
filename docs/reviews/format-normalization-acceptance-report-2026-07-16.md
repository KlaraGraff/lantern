# 格式规整管线验收报告

- **日期：** 2026-07-16
- **被测提交：** `2d26acd5d684efbe6a318c0ca35ae50cdf715cb5`
- **提交说明：** `feat(books): MOBI/AZW3 → EPUB conversion pipeline (Phase 1 + Calibre route A)`
- **验收依据：** [`docs/guide/format-normalization-testing.md`](../guide/format-normalization-testing.md)
- **结论：** **未完成发布验收。** 静态基线、无 Calibre 的导入降级元数据、以及 TXT 预处理与阅读通过；Calibre 转换及双设备场景因环境前置条件缺失而未执行。隔离打包环境中，AZW3、MOBI 与 EPUB 阅读器都出现 `READER_INIT_TIMEOUT`。该现象尚未在正常安装的生产应用中复测，不能据此确认是生产回归。

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

**状态：未执行。** 缺少 Calibre/`ebook-convert`，不能进入转换分支，也不能验证：

- 导入后 `render_format='epub'`；
- `.tmp.epub` 临时产物与原子发布；
- 转换后的选中、AI、标注、进度和 CFI；
- `prepared/{book_id}.converted.v1.epub` 本地产物。

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

**状态：未执行。** 三项均要求先创建转换书的 pending/failed 状态，而当前环境缺少 Calibre，无法构造或重试转换任务。

### 4.4 T7：双设备 iCloud 同步

**状态：未执行。** 缺少第二台设备和 Calibre 的两种安装状态，无法验证本地推导的 pending、每设备独立产物以及 iCloud 不同步 `*.converted*.epub` 的不变量。

### 4.5 T8：ready 产物丢失后的自愈

**状态：未执行。** 该项需要一册已经由 Calibre 转换成功的书；当前没有 `.converted.v1.epub` 产物可删除。

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

- **TXT：通过。** 打开后立即显示第一章 `PART ONE`，证明 text-preparation 与自绘文本阅读器链路可用。
- **EPUB：失败（隔离环境）。** 打开后复现 `READER_INIT_TIMEOUT`。这是与 AZW3/MOBI 相同的 Foliate 初始化症状。
- **PDF：未单独打开。** 已完成导入和数据库验证；在 EPUB、MOBI、AZW3 都出现 Foliate 初始化超时后，没有把 PDF 的同一路径推断为已失败。PDF 渲染仍需在正常安装环境中实测。
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

本次不能签发格式规整管线的完整运行时验收。可以确认的部分是：

1. 当前测试的是 `origin/main` 的最新提交和该提交的新鲜打包产物，不存在以旧代码替代修复后代码的情况。
2. 无 Calibre 时，AZW3/MOBI 导入不会误进转换管线；格式列、准备状态和产物目录均符合降级设计。
3. EPUB/PDF/TXT 导入正常，TXT 的准备和阅读正常。
4. Calibre 转换、失败重试、崩溃恢复、iCloud 同步、产物丢失自愈以及 CFI 自愈均未覆盖，不能视为通过。
5. 隔离打包环境里的 Foliate 阅读器初始化超时需要在常规安装环境复测，不能直接作为生产回归结论。

## 7. 后续验收建议

1. 在当前提交构建或安装的 `/Applications/Lantern.app` 中，使用正常用户目录重测 EPUB、AZW3 与 MOBI 的打开行为，先确认 `READER_INIT_TIMEOUT` 是否可复现。
2. 安装 Calibre 后，按 T1、T2 验证 KF8 AZW3 和 MOBI6 的真实转换；同时检查数据库列、`prepared/` 的临时文件/成品发布和转换后交互能力。
3. 再依次执行 T4、T5、T6、T8 的失败/恢复闭环，以及两设备条件下的 T7。
4. 准备一个故意失效的 EPUB saved CFI，补做 T10。

## 8. 清理与变更

- 临时测试应用进程已停止。
- 测试数据保留在 `/tmp/lantern-format-qa-release/`，不位于生产应用数据目录。
- 本次未修改产品源码、测试实现或配置；本报告是唯一的仓库内容变更。
