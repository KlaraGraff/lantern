# 词卷（cijuan）— 入库说明

这是「词卷」的完整源码快照，作为独立应用暂存在 `labs/`，等待并入 Lantern 的单词复习板块。

## 来源

- 源仓库：本机 `~/vibecoding/cijuan`（git 历史留在源仓库，未随快照迁移）
- 快照提交：`dd0a46e`（feat: 原位评卷 + 选取追问抽屉）
- 入库日期：2026-08-12

## 这是什么

纯前端单页应用：粘贴当天背的单词 → AI 生成阅读理解 + 语法填空，每个目标词都是真实考点。含错词池（+2/+7 天重现）、遮词自检、结构化讲解（题干翻译/解题思路/逐项释义）、选中文字追问 AI。多服务商自带 key（Anthropic 官方 SDK + OpenAI 兼容通道）。

## 独立运行

```bash
cd labs/cijuan
npm install
npm run dev        # localhost:5173，含 /llm-proxy 开发代理（解决中转站 CORS）
npm test           # vitest，47 个测试
```

无后端、无环境变量；数据存 IndexedDB（Dexie），API key 存 localStorage。

## 合并到 Lantern 时的要点

可迁移资产是纯 TS 核心，UI 层按计划弃用、换成 Lantern 自己的组件：

| 层 | 位置 | 合并方式 |
| --- | --- | --- |
| LLM 客户端与提示词 | `src/llm/` | 直接迁移（纯 TS，无 React 依赖）；浏览器 CORS 代理可改由 Tauri 后端发请求，彻底绕开 CORS |
| 数据与调度 | `src/store/`（Dexie） | 数据模型（Quiz / WrongWord / AskThread）迁入 Lantern 的 SQLite；错词 +2/+7 调度逻辑在 `scheduler.ts` |
| UI | `src/ui/` | 不迁移。追问抽屉（AskDrawer）换成 Lantern 的 AiPanel；界面样式仅作参考 |

设计决策与取舍记录在 `docs/decisions.md`，评卷界面的设计样张在 `docs/mockups/`。
