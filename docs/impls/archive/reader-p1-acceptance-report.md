# 阅读器 P1 后台验收记录

日期：2026-08-04。执行方式：仅 headless Chromium、源代码单测和静态检查；没有启动、聚焦或操作 Tauri/浏览器前台窗口。

## 结论

白屏修复的 TypeScript、ESLint 与新增生命周期测试均通过。P1 的纯逻辑覆盖 59 项自动化用例，均通过。真实 Tauri 的 EPUB 打开、Foliate 脚注渲染、数据库持久化和窗口快捷键无法在“不抢占前台”的约束下证明，以下明确标为未验证，不能等同于真机通过。

## 证据与结果

| 项目 | 操作 / 预期 | 实际 | 结论 | 截图 |
| --- | --- | --- | --- | --- |
| 白屏生命周期修复 | StrictMode 取消初始化时，先 detach，初始化结束再 close；销毁未初始化的 paginator 不抛错 | `foliate-view-lifecycle` 两项回归测试通过；`paginator.destroy()` 已用可选调用 | 通过（代码级） | 无界面状态 |
| EPUB 真正打开 | Tauri 中打开 EPUB 后出现阅读正文 | 不启动前台 Tauri，且 headless Web 无 Rust 文件 IPC | 未验证 | 无 |
| 脚注弹层 | 点击真实 EPUB 脚注，弹层可关闭并可跳源 | React `FootnotePopover` 已纳入 harness；真实 Foliate `FootnoteHandler` 及 EPUB 链接事件需 Tauri/引擎实例 | 未验证 | 无 |
| 搜索空态 | 打开书内搜索、不输入关键词 | 真实 `BookSearchPanel` 渲染空态 | 通过（组件） | [01](assets/reader-p1-acceptance/01-search-empty.png) |
| 搜索中 | 输入关键词后显示进度 | 真实组件接收异步 generator 的 50% 进度 | 通过（组件） | [02](assets/reader-p1-acceptance/02-search-progress.png) |
| 全书搜索结果 | 查询完成后按章节显示命中与关键词标记 | 真实组件渲染章节命中 | 通过（组件） | [03](assets/reader-p1-acceptance/03-search-result.png) |
| 高亮 / 生词范围 | 仅保留 CFI 落在高亮区间或等于生词 CFI 的结果 | 真实 vendored `epubcfi.js` 的边界、区间、空范围测试通过 | 通过（逻辑） | 无 |
| 跳转及返回 | 多次 jump 后按栈逐层返回；普通翻页后浮标淡出 | 入栈、出栈、标签和淡出计数测试通过 | 通过（逻辑） | 无 |
| 高亮改色、备注、删除分流 | 有备注时删除必须提供“仅删备注/高亮与备注”；无备注直接删除 | 组件实现已审查；缺少浏览器交互截图（headless harness 的本地化按钮定位中断） | 未验证 | 无 |
| 四种进度读数 | `page -> chapterTime -> bookTime -> hidden -> page` | 状态轮换、非法值回退、无样本计算中与剩余分钟归零保护测试通过 | 通过（逻辑） | 无 |
| 三开关 8 组合 | 未保存读数时，只有 `000` 默认 hidden，余下 7 组均 page；已保存时读书选择优先 | 8 组合由同一判定函数覆盖：`000 => hidden`，任一为 true => `page`；保存标记的优先分支在 `Reader.tsx` 已审查 | 通过（逻辑 / 代码审查） | 无 |
| 章节刻度与拖动 | 悬停显示章节/百分比；拖动时只预览，松开才提交 | fraction clamp、章节定位、tick 排序和 pointer 数学测试通过 | 通过（逻辑） | 无 |
| TOC 展开及恢复 | 当前章节祖先展开；保存节点和滚动位置，下次恢复 | 保存解析、损坏数据回退、展开合并和稳定序列化测试通过 | 通过（逻辑） | 无 |

## 执行记录

- `npx tsc --noEmit`：通过。
- `npx eslint public/foliate-js/paginator.js src/pages/reader/useFoliateView.ts src/pages/reader/foliate-view-lifecycle.ts tests/foliate-view-lifecycle.test.ts`：通过。
- `npm run build`：通过（含 reader assets 转译与兼容性门禁）。
- `npm run test:unit`：389 通过，0 失败。
- P1 定向单测：59 通过，0 失败。
- `npm run check:docs`：通过。
- 未读取或纳入另一工作线的 `wheel-page-turn` / `keyboard-page-turn` 改动。

## 验收边界

截图来自实际生产 React 组件，不是静态拼图；Tauri IPC 仅为搜索结果、高亮、生词读取提供测试数据。因用户要求不抢占前台，未启动 Tauri GUI，也未控制全局鼠标或键盘。故本记录把真实设备依赖项保留为“未验证”，而非推断通过。
