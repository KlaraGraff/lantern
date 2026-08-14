# 出卷页图片取词（今天的词 · 粘贴/拖入截图 → AI 提词）

样张：`quiz-image-words-mockup.html`（已拍板，五状态 A–E）。本文是代码级实现计划。

## 产品口径（已拍板）

- 入口三个：**粘贴**（Cmd+V）、**拖入**、右下角小按钮**「从图片提取」**选文件。落图即自动开始识别，不要确认步骤。
- 识别用**出题模型**（设置项 `quiz_ai_profile_id`，与词卷全部 AI 调用同一钉定）。模型不支持看图时**明确报错**指去设置换模型，绝不悄悄换别的模型——用户钉模型是有意的。
- 提出来的词**追加进输入框**（与框内已有词去重），用户可删改，之后照常走生成管线。输入框仍是唯一事实源，生成管线一行不改。
- 每张图一个 chip：排队中 / 识别中 / 识别失败（可重试/移除）；成功的 chip 消失，留一行轻提示汇总（提了几个、重复几个没再加）。
- **PDF 不做**（v1）：用户对 PDF 截图即可。真有需求再开 issue。

## 一、后端：AI 请求层加图片输入

### 现状与选型

`ChatMessage { role: String, content: String }`（`commands/ai.rs`）全仓 113 处构造；给它加字段等于全仓改。仓库已有**带内 role** 先例——`system_cache_variable` 就是用假 role 在 `Vec<ChatMessage>` 里夹带通道信息，三个 provider 的 `request_body` 各自识别并转译。图片走同一条路：

- 新 role **`user_image`**，content 是 data URI（`data:image/jpeg;base64,...`）。
- Router（5532 行）不读 content，零改动；失败切换、用量统计、取消通道全部白拿。

### 改动点

1. **`commands/ai/complete_text.rs`** — 校验放行 `user_image`，并抽成纯函数 `validate_messages` 供单测：
   - role 白名单：`user` / `assistant` / `user_image`；
   - `user_image` 的 content 必须是 `data:image/{png,jpeg,webp,gif};base64,` 前缀的 data URI（`AI_COMPLETE_TEXT_IMAGE_INVALID`）；
   - 单图 base64 上限 10MB（`AI_COMPLETE_TEXT_IMAGE_TOO_LARGE`）——前端压完通常 <1MB，这是防御线不是常规路径。
2. **`ai/mod.rs`** — `pub(crate) fn parse_image_data_uri(&str) -> Option<(&str, &str)>`（media_type, 裸 base64），供校验和 Anthropic 通道共用。
3. **三个 provider 的 `request_body`**（各自加单测，纯函数直接断言 JSON 形状）：
   - 转译规则统一：顺序扫描，`user_image` 缓存进 buffer；遇到下一条 `user` 消息时合并成**一条**多模态 user 消息（图在前、文字在后）；扫描结束还有剩图则单独发一条只含图的 user 消息。合并保证 Anthropic 的 user/assistant 交替约束不被破坏。
   - `anthropic.rs`：`{"type":"image","source":{"type":"base64","media_type":…,"data":…}}`（data URI 拆开）；`mark_cache_control` 同步改成对数组 content 容错（往最后一个块上挂标记，而不是按字符串重包——虽然取词调用不带 cache，防御住）。
   - `openai_compat.rs`：`{"type":"image_url","image_url":{"url":"data:…"}}` + `{"type":"text","text":…}`。
   - `openai_responses.rs`：`{"type":"input_image","image_url":"data:…"}` + `{"type":"input_text","text":…}`。

## 二、前端

### 提取调用（`src/quiz/image-words.ts`，新模块）

- `buildExtractionMessages(dataUri)` 纯函数：`[{role:'user_image', content:dataUri}, {role:'user', content:提词提示词}]`，供测试断言形状。
- 提示词要点：只提图里**正在学习的英语单词/词组**，不提释义、例句、界面文字；保持原拼写；词组算一项。
- 走 `completeStructured`（schema `{ words: string[] }`，zod），`maxTokens: 4000`，`cache: false`，`profileId` 用 `parseQuizAiProfileId(settings.quiz_ai_profile_id)` ——与生成管线同一钉定。
- `transport.ts` 的 role 联合类型放宽为 `'user' | 'assistant' | 'user_image'`。
- `mergeExtractedWords(existingRaw, words)` 纯函数：对既有文本跑 `parseWordInput` 建小写集，过滤重复，返回 `{ nextRaw, addedCount, dupCount, appendedText }`——追加用换行 join，供 setSelectionRange 高亮定位。
- `classifyExtractError(message)` 纯函数：错误串含 image/vision/multimodal/「不支持…图」等关键词 → `'vision'`（模型不支持看图横幅），否则 `'generic'`（chip 失败态可重试）。

### 图片压缩（`src/pages/quiz/image-compress.ts`）

`createImageBitmap` + canvas，长边压到 1600px，JPEG 0.85 → data URI。浏览器 API，不做 node 测试，保持薄。

### SetupTab 交互（对照样张 A–E）

- textarea 外包一层 `relative` 容器：右下角「从图片提取」按钮 + 隐藏 `<input type="file" accept="image/*" multiple>`；
- `onPaste`：剪贴板有图片 item 时 `preventDefault` 取图，纯文本照旧默认行为；
- drag enter/leave 计数器控制虚线高亮 + 「松开，把图里的词提出来」蒙层（样张 B）；
- chip 队列：`{id, thumbUrl(objectURL), status: queued|running|failed, errorKind}`，**串行**识别（一次一张，其余排队中——省并发配额也贴合样张 C）；成功移除 chip，失败保留（重试/移除，样张 E 上）；objectURL 在移除时 revoke；
- 成功后：`mergeExtractedWords` 更新 rawText → focus + `setSelectionRange` 选中追加段（textarea 里做不了 span 高亮，原生选区就是「刚加了这些」的高亮）→ 轻提示行「从 N 张图片提取了 n 个词，与已有重复的 x 个没有再加」；
- `errorKind === 'vision'` 时出横幅（样张 E 下），链接进设置词卷 tab；
- placeholder（`quiz.setup.todayWords.placeholder`）加第三行「也可以直接粘贴或拖入截图，AI 会把词提出来」。

### i18n

`quiz.setup.imageWords.*` 全套（按钮、拖入提示、chip 三态、重试/移除、汇总提示含复数、vision 横幅），zh/en 双语；placeholder 既有 key 两边同步加行。复习文案红线照旧：无催促、无责备。

## 三、测试与验收

- Rust：三 provider 的图片转译形状、混排（图+文合并、尾部孤图、交替性）、`mark_cache_control` 数组容错、`validate_messages` 放行/拒绝/超限。
- TS（node 可测的纯函数）：`buildExtractionMessages` 形状、`mergeExtractedWords` 去重/追加定位、`classifyExtractError` 分类。
- 门禁：`cargo test --lib` / clippy `-D warnings` / fmt、`npm run test:unit`、tsc、eslint。
- 提交切法：① 本计划+样张；② 后端 `user_image` 通道；③ 前端提取模块+SetupTab+i18n。
