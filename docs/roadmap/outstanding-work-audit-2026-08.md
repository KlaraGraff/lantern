# 未完成工作审计(2026-08-06)

> ⚠️ **快照声明**:本文是 2026-08-06 的代码快照,结论以彼时代码为准。之后代码持续变动是常态,一旦发现本文结论与当前代码不一致,请以代码为准,并回来更新本文——不要反过来拿本文的旧结论压现状。

> 范围:桌面软件本体。iOS / 移动端规划(`mobile-ios.md`、mockup-gap-audit 中的 iOS 条目)不在本文之内。
> 方法:通读 `docs/features`、`docs/impls`、`docs/roadmap`、`docs/guide` 全部未归档文件 + GitHub 开放 issue,对文档声称「零调用/未实现」的条目回代码抽查核实。
> 本文是快照,不是新计划。条目落地后请更新对应源文档,再回来划掉这里的行。

## A. 立了项、没开工的功能(需要排优先级)

六份未归档 feature spec 全部处于未开工状态,没有一份是「做了一半」:

| Spec | 是什么 | 备注 |
|------|--------|------|
| [q14 — Notes](../features/q14-notes.md) | 笔记实体 + AI 润色/扩写 + 笔记对话线程 | Milestone 2 核心项。阅读页笔记面板(P3.2 notes rail)已 ship,但 q14 的 AI 写作助手和对话线程是另一层,全欠 |
| [q25 — Collection Folders](../features/q25-collection-folders.md) | 合集内一层文件夹,拖拽归类 | 四期全未开工 |
| [q32 — Library Backup](../features/q32-library-backup.md) | 书库文件单向备份到用户指定目录 | 两期全未开工 |
| ~~[q257 — Persist Explanations](../features/archive/q257-persist-explanations.md)~~ | Explain 结果持久化 + 解释列表页 | **已全部上线并归档(2026-08-07)**:Phase 1 后端 + Phase 2 弹层缓存/保存 + Phase 3 解释列表页(7f2bd06) |
| [q276 — Reset All Data](../features/q276-reset-all-data.md) | 设置里的「重置全部数据」危险操作 | 全未开工 |
| ~~q285 — Memos 分组~~ | 侧栏新增 Memos 分组 | **已随三段式改造落地并归档(2026-08-06)**,见 C-9 |

开放 issue 两条:

- ~~[#12 — reader settings 分全局层与每书覆盖](https://github.com/KlaraGraff/lantern/issues/12)~~ — 2026-08-06 回码核实:in-scope 清单全部已随 P2.4 settings-scope 线落地(六个全局行、字距全局键、覆盖可见标记、跟随全局/提升为全局两个动作、可覆盖集合含排版流/页面布局/边距),**已关闭**,关闭评论附证据。
- [#11 — 应用内 AI 拿不到生词本和学习状态](https://github.com/KlaraGraff/lantern/issues/11)。**第一刀(查词卡注入该词自身记录)已随 `1beb07d` 落地**——issue 评论区有记录,正文的「现状核对」一段过时;2026-08-06 回码核实实现完整、测试全绿。issue 按其自身约定保持开启,等的是推迟项(整章注入、设置开关)的后续判断,不是欠实现。

## B. Milestone 层面的欠账

- **Milestone 2 剩余三项**(`milestone2-depth.md`):
  1. 应用内自动更新 — 见 D 节的 q243 + auto-update-setup,密钥和 Secrets 就绪,**每一行代码都欠着**,且 q243 计划写于 Quill 时代,需 rebase 后才能开工。
  2. Notes(= q14)。
  3. 区域截图给 AI(杂志/PDF 图片区域)— 只有一句话,没有 spec。
  - (Onboarding 已 ship,该文件状态过时,见 F 节。)
- **Milestone 3(companion)只有架构骨架**,`## Features` 标题下是空白 — 整个里程碑还没有展开成任何可执行条目。这是规划层面最大的一块空洞,需要产品拍板后才能立项。

## C. 已有功能的联动断点(product-ux-audit + feature-linkage-analysis 遗留)

两份 2026-08 审计里的条目,本次已回代码核实一轮:

**已修复,无需再排**:`AnnotationsContent` 已挂载进 Home 并已入库;`bulk_delete_vocab_words` / `bulk_update_vocab_mastery` 已接进词典页;onboarding 首启引导已 ship;reader-page-optimization 的 P0/P1/P2 及 P3.1–P3.4 已 ship 并归档验收。

**仍欠着**:

1. 侧边栏「生词」条目不显示今日待复习数 — `list_vocab_due_for_review` / `get_vocab_stats` 前端仍是零调用(本次已核实)。注意:三段式改造后 `tests/review-piles.test.ts` 断言整个随记行模板不渲染计数,实现本条时需把该约束收窄回「复习行不显示计数」的原意。
2. reader-page-optimization **P3.5 双语对照整书翻译** — P3 五项里唯一没进已归档 ship 清单的。
3. 查词历史 → 生词本的一键收藏路径(audit 断点 1;`vocab/collect.ts` 已存在,历史页是否接上待确认)。
4. 同词跨书 = 多条生词、多套复习进度,未合并(audit 断点 2)。
5. AI 请求次数统计 + 被动生词「不额外消耗额度」说明。
6. 打开书时的一次性前置判定(扫描件未 OCR / 索引状态 / AI 档案可用性),替代现在的「先动作再失败」。
7. 书签/生词按钮的 title + aria-label(audit P0 无障碍项,是否已随 P2/P3 线修复待确认)。
8. 查词学习卡错误态无 CTA/无重试(`LearningCardView.tsx`),与翻译/解释弹层行为不一致。
9. **结构归并三件套,均需先出样张**:侧边栏、工具栏 9→6、Aa 面板分流。侧边栏已拍板(2026-08-06):采用**三段式结构 × q285 的 Memos 命名**(样张 `impls/sidebar-ia-options-mockup.html` 方案 C),施工中;q285 spec 被该方案吸收,随实现落地归档。工具栏与 Aa 面板仍待出样张。
10. **两个产品决策已定(2026-08-06)**:查词历史/阅读统计跨设备同步——**暂缓**,等 iOS 线启动时随其同步设计一并做;阅读统计接学习数据——**做**,排在侧边栏改造落地之后(同一块代码区域,避免并行冲突)。

## D. impls 活跃清单的欠账(摘自 `impls/README.md`,该索引本身是准的)

- **Responsive foundation** — 基建就位但零消费者:safe-area insets 没人读,`100vh` 仍铺在每个路由上。
- **On-demand book download** — 后端已 ship;书架角标 + 阅读器内进度(P2 item 8)欠着;metered-connection gate(D-016)**已建成并接线(2026-08-07,b9dcd35)**:阅读器打开失败的诊断探针带 request id 走受观察下载路径,蜂窝首次询问、答案记入设置。
- **iCloud metadata watcher** — 纯设计,未实现,需两个未启用的 `objc2-foundation` features,真实风险离开硬件无法验证。
- **Built-in AI model catalog** — Phase 1–3 已 ship;**七条验收项因 2026-08-03 那次手工验收够不到而仍开着**(全新安装、额度耗尽、密钥吊销、英文 UI、日志与导出,见该文档 §11)。
- **q243 更新体验 + auto-update-setup** — 见 B 节 Milestone 2 第 1 条。
- **Mockup gap audit(2026-08-06)** — 决策清单 G-00–G-I 未拍板(剔除 iOS 凭据同步后,桌面相关的有:网络门控、书源 OPDS、auto-analysis console 与实现的不一致),两份 mockup 未批。

## E. 人工验收与操作欠账(多数需要真机,需要排班)

1. ~~**安全杂务**(apple-notarization-record §6)~~:两项均已于 2026-08-06 拍板关闭——app-specific password 不轮换(口令只出现在与 Claude 的对话中,用户知情接受);签名密钥不另做手动备份(GitHub secret + 本机钥匙串已是两份副本,双亡时可在开发者网站重新签发,用户知情接受)。
2. **format-normalization 验收** — 代码已完成,运行时/GUI 验收一次都没做过:T1–T10 十组用例,其中 T7(iCloud 同步)需要两台 Mac。全绿后 testing.md + acceptance-brief 才能归档。
3. **macOS 12 Reader QA** — v2.0.2 在真实 Monterey 上有 Preparing 卡死反馈,v2.0.3 修复候选**待同机复验**:T1–T6 手工矩阵、性能基线 CSV、最终 PASS/FAIL 全部空白。需要一台 Apple Silicon + Monterey 12.x 的机器。
4. **README 截图** — 现有 `assets/home.png` / `reader.png` 还是旧品牌 Quill 的旧图;12 张新截图(6 必需 + 6 备用)待拍,README 里六处新图路径仍被 HTML 注释包着。
5. **reader-ai-learning-tools aligned spec** — 实现与代码审查已完成,**测试方案未执行、tag 未打**(spec 文首明确「待按测试方案验证,暂不创建新 Tag」)。

## F. 文档卫生(不需要拍板,可直接修)

- `milestone2-depth.md`:Onboarding 标 Planned,实际已 ship。已修(2026-08-06)。
- `reader-page-optimization.md`:P0–P3.4 绝大部分已 ship 并归档,文件本身没回填状态;P0.5 要求归档 `q260-toc-side-panel.md` 也没执行。建议回填后整体归档,把 P3.5 单独带出来。已修(2026-08-06):文件顶部加了状态说明,整体移入 `archive/`,`roadmap/README.md` 链接已更新;`q260-toc-side-panel.md` 早已在 `docs/features/archive/` 下,该项无需再动。
- `guide/macos-distribution.md`:仍写着「未加入 Apple Developer Program」,与公证记录(2.9.0 已 Accepted)矛盾,需按现状重写。已修(2026-08-06)。
- `q257` / `q276` / `q285` 三份 spec 缺 `Status:` 字段,与另外三份格式不一致。已修(2026-08-06)。
- `feature-linkage-analysis` 中已修复的断点(AnnotationsContent、bulk_*)未回填状态。已修(2026-08-06)。

## 外部等待项(无法排班,只能等)

- ~~Gatekeeper Route A:Apple Developer 审核 / 公证链路~~ — 2026-08-06 核实已清:Developer ID 证书到手,2.9.0 公证 Accepted,签名管线工作正常。相关文档(gatekeeper-fix、guide/macos-distribution.md、impls/README.md)已同日回填并归档。当前无外部等待项。
