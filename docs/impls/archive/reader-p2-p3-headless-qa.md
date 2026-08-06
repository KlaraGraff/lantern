# P2–P3.4 后台视觉验收记录

日期：2026-08-04。执行约束：不启动 Tauri GUI、不聚焦或控制用户前台窗口；仅使用无头渲染和已有已确认样张。

## 结论

关键界面状态已保留为可审查的截图证据。P2.1 导出弹窗、P3.1 阅读历程和 AI 首次调用说明由本次 headless Chromium 直接渲染；其余截图是仓库中先前以 headless Chromium 生成、且已与产品对齐的样张副本。它们证明视觉规格与关键状态，**不等同于真实 Tauri / EPUB 引擎集成通过**。

## 截图清单

| 功能 | 状态 / 验收点 | 证据层级 | 截图 |
| --- | --- | --- | --- |
| P2.1 结构化导出 | 高亮与生词选择、Markdown/CSV/Anki 格式、保存位置入口 | 本次 headless 样张渲染 | [p21](assets/qa-p2-p3/p21-structured-export-default-headless.png) |
| P2.2 语境复习 | 读音 → 中文句意 → 答案的提示顺序；不暴露字母数 | 已确认静态样张 | [p22](assets/qa-p2-p3/p22-context-review-hints-approved-mockup.png) |
| P2.3 排版 | 两端对齐、语言适配断词、段距和首行缩进控制 | 已确认静态样张 | [p23](assets/qa-p2-p3/p23-typography-approved-mockup.png) |
| P2.4 每书设置 | 书籍搜索、全选、内部滚动、顶部工具区和底部确认固定 | 已确认静态样张 | [p24](assets/qa-p2-p3/p24-settings-scope-approved-mockup.png) |
| P2.5 连续朗读 | 顶部参与布局的播放器与收起入口 | 已确认静态样张 | [p25](assets/qa-p2-p3/p25-continuous-read-aloud-approved-mockup.png) |
| P3.1 阅读统计 | 默认阅读历程、最右侧历程/日历切换与书籍总览 | 本次 headless 样张渲染 | [p31-history](assets/qa-p2-p3/p31-reading-history-approved-mockup.png) |
| P3.1 AI 回顾 | 首次告知、白名单事实、当前服务商和额度/费用提示 | 本次 headless 样张渲染 | [p31-ai](assets/qa-p2-p3/p31-ai-review-consent-approved-mockup.png) |
| P3.1 增强字体 | 字体显示设置的状态设计 | 已确认静态样张 | [p31-font](assets/qa-p2-p3/p31-enhanced-font-approved-mockup.png) |
| P3.2 页边笔记轨 | 笔记与正文位置对应且参与布局 | 已确认静态样张 | [p32](assets/qa-p2-p3/p32-notes-rail-approved-mockup.png) |
| P3.3 被动生词注释 | 主设置总开关、样式和密度 | 已确认静态样张 | [p33](assets/qa-p2-p3/p33-passive-vocab-settings-approved-mockup.png) |
| P3.4 人物/术语卡 | 右侧轻量入口、截至当前位置的防剧透范围、关系和此前出场 | 已确认静态样张 | [p34](assets/qa-p2-p3/p34-xray-spoiler-safe-approved-mockup.png) |

## 执行记录

本次直接成功的无头渲染命令（未打开前台窗口；P3.1 使用相同参数分别渲染合并页和 `#consent` 状态）：

```sh
/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
  --headless=new --no-first-run --no-default-browser-check --disable-gpu \\
  --hide-scrollbars --user-data-dir=/private/tmp/lantern-headless-profile \\
  --window-size=1440,960 \\
  --screenshot=/private/tmp/lantern-p21.png \\
  file:///Users/lijianwei/vibecoding/Lantern/docs/impls/reader-p2-structured-export-mockup.html
```

输出：P2.1、P3.1 阅读历程和 P3.1 AI 首次调用说明均成功写入 PNG。该 Chrome 安装随后仍尝试唤醒更新/崩溃服务，截图落盘后立即终止对应无头进程；其余条目采用仓库已有的本地、已确认样张截图。

## 外部验证边界

- 未启动真实 Tauri：无法在本轮证明系统保存框、真实 EPUB/PDF、Foliate 脚注、跨章朗读、窗口窄屏重排和键盘焦点。
- 未连接 iCloud 双设备：无法证明 P2.4 tombstone 的跨设备回放，或 P3.1 统计记录的跨设备一致性。
- 未配置可信增强中文字体 manifest：无法实际下载/校验字体包；应继续显示系统字体并在正式设备上覆盖下载中、失败、已保留与移除确认。
- 未调用生产 AI 服务：无法验证供应商配置、额度不足、离线失败和缓存更新的真实网络回路；P3.1/P3.4 的截图仅验证已拍板的告知与呈现形态。

这些边界应由后续真实 Tauri / 双设备验收补齐，不能将本记录标记为真机通过。
