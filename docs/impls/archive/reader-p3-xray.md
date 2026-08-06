# Reader P3.4 · 人物 / 术语卡

Status: approved and implemented.

## 产品裁决

- `chosen`: 方案二——正文就地实体卡。
- `fallback`: 方案一——右侧人物 / 术语索引面板；保留现有 HTML / PNG 样张，不实现、不删除，若实际使用证明就地卡不合适再回退。
- 视觉与关键状态基准：`reader-p3-xray-context-mockup.html` 与 `assets/reader-p3-xray-context-mockup.png`。

## v1 边界

- 从正文选择菜单或阅读器工具栏轻量进入，呈现人物摘要、术语解释、关系路径和此前出场位置。
- 默认硬限制到当前位置。EPUB 的 CFI 不能提供同一 spine 文件内的精确字符边界，因此检索只读取当前 spine 之前的内容，当前可见上下文由阅读器单独提供；宁可漏掉同文件内此前出现，也不发送后文。
- 整书范围必须在当前卡片内明确确认；关闭卡片即恢复安全范围，整书结果不写入安全缓存。
- 出场跳转复用阅读器既有跳转历史；窄窗卡片位于正文之后的顺序流，不覆盖正文。
- 复用现有 AI provider 与全文索引；不新增向量库或第三方依赖。

## 主线接线契约

- `ReaderXrayCard` 的 `onNavigate(source)` 与 `onNavigateCurrent(location)` 必须返回
  `boolean | Promise<boolean>`。
- 主线只在阅读器实际完成跳转（例如 `goTo` / 文本定位并完成闪烁反馈）后返回
  `true`；目标不存在、阅读器尚未 ready、跳转抛错或被取消都返回 `false`，不要吞掉成
  `void`。
- 卡片收到明确的 `true` 才调用 `onClose()`。收到 `false` 或抛错时保留卡片、保留当前
  结果并展示失败状态；跳转进行中会禁用其他出场按钮，避免重复请求。
- 回到历史的位置由主线既有 jump history 负责；卡片只提供目标 location/source，不新增
  一套历史。
