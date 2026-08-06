# Mobile settings — implementation plan

**Scope:** P2 item 4 of [`docs/roadmap/mobile-ios.md`](../roadmap/mobile-ios.md#5-phases).
**Design:** [`mobile-settings-mockup.html`](mobile-settings-mockup.html) — 25 screens, approved
2026-08-06. Screen 6 is superseded by
[D-018](../roadmap/mobile-ios.md#d-018--a-missing-credential-names-the-channel-that-failed-instead-of-shrugging)
and was deliberately not redrawn; this plan carries the revision instead.

---

## 0. What this is, in one paragraph

Desktop settings is a 780px modal with a 220px nav rail on the left and 73px form rows on the
right — ten top-level sections, sixteen panels once the sub-tabs are counted. Below `768px` there
is nowhere to put the rail, so the modal stops being a modal: it becomes a full-window grouped
list, one tap pushes a page, the top-left chevron goes back. **The 73px row does not change** — it
still reads at 370px wide. Its only edit is `h-[73px]` → `min-h-[73px] py-3`, so a subtitle that
wraps to three lines makes the row grow instead of clipping.

The reduced surface is eight entries, not sixteen. Nine panels are cut; the reasons split into two
kinds and this plan keeps them apart, because they age differently.

---

## 1. The two kinds of cut

**Kind A — iOS genuinely cannot.** These already have capability flags in
[`src/services/platform.ts`](../../src/services/platform.ts) and disappear with no new code:

| Panel | Flag |
|---|---|
| MCP | `hasMcpIntegration` |
| 服务配置 › 扫描件 OCR | `hasOcr` |
| 阅读偏好 › 自定义字体导入 | `hasFontImport` |
| 通用 › 自动检查更新 | `hasUpdater` |
| 书库同步 › 打开位置 | `hasFileReveal` |

**Kind B — the phone consumes this, it does not produce it.** These are product decisions taken in
the mock-up, not platform limits. Per
[D-005](../roadmap/mobile-ios.md#d-005--capability-flags-not-platform-checks) they still get named
capability flags rather than an `isMobile` check at the call site, because the flag name is where
the reason lives:

| Panel | New flag | Why it is false on mobile |
|---|---|---|
| 服务配置 › 搜索模型 (embedding) | `hasEmbeddingIndex` | The vector index serves AI chat's retrieval, and chat is not on the phone ([D-012](../roadmap/mobile-ios.md#d-012--the-phone-gets-ai-contextual-glosses-not-ai-chat)). Contextual gloss reads the selected sentence, not an index |
| 服务配置 › 语音 | `hasSpeech` | Read-aloud is not in the iOS column of §1. A second-version feature decision, not a settings decision |
| 阅读辅助 › 卡片设计 / 操作菜单 / 正文标记 | `hasComposerSurfaces` | Three authoring surfaces: drag-to-reorder plus a live preview pane that opens a third column at `xl`. The phone renders their output |
| 通用 › 考试成绩估算 CEFR | `hasScoreEstimator` | A four-field form plus a history list, filled once a year. 语言水平 itself stays — it drives gloss difficulty; only deriving it from an exam score goes |

Four new flags. Each defaults to `false` in `ABSENT`, is `true` in `DESKTOP`, and stays absent in
`MOBILE` — so the compiler catches a missing default, exactly as the file's own comment promises.

**Not cut, and this reverses the previous draft:** 书籍来源 and 自动分析 both stay. The premise
changed — core features must stand alone on the phone, because far more readers own an iPhone than
own a MacBook, and for them "go back to the Mac" is not slower, it is impossible. Without 书籍来源
a phone-only reader cannot get a first book in at all.

---

## 2. Stages

Ordered so that each stage is acceptable on its own and nothing later is blocked on a device.
Stages 1–3 are verifiable in a desktop browser by dragging the window narrow; only safe-area
insets and 44px hot zones need the Simulator, and only iCloud Keychain needs hardware.

### Stage 1 — The shell

The structural piece, and the one everything else lands inside.

- `SettingsModal.tsx` gains a `< 768px` branch. Not a second component: the same `sections` array,
  the same `renderContent()`, a different chrome around them.
- **Root page** — grouped cards on a `bg-bg-muted` page. Groups: (通用, 主题, 阅读偏好) / AI (AI
  模型, 自动分析) / 书库 (书库同步, 书籍来源) / (关于). Group separation is whitespace and a small
  caps header, not fifteen divider rules.
- Each row carries a **right-hand value summary** (`中文`, `跟随系统`, `2 分钟前`, `3 个站点`,
  `DeepSeek · 可用`, `2 项开启`). These are the rows' reason for being scannable; they are async, so
  the loading state omits them.
- **主题 opens a bottom sheet in place, it does not push.** The rule: a section holding exactly one
  control is inlined into the root list. 外观 has only 主题. A right chevron means push; a down
  chevron means sheet.
- **Loading** is a skeleton that preserves row height and grouping, so nothing jumps when
  `useSettings` returns. No spinner — the list's structure is already known.
- **Push navigation** with a back chevron in a 44px hot zone, `safe-top` above it and `safe-bottom`
  below the scroll region. Back must also be reachable by the existing Escape chain in
  `SettingsModal` (`subPageBackRef`), which already models one level of sub-page.
- **Row height follows input, not width:** `touch:` not `md:`. The root row *is* the button, so it
  is governed by hot-zone size — 56px under touch, 40px on a narrow mouse-driven window. This is
  deliberately the opposite of the drawer's sidebar, where the height is a density choice.
- `h-[73px]` → `min-h-[73px] py-3` across the settings rows. This is a repo-wide sweep of the row
  pattern, and it is the single most mechanical part of the whole item.

**Accepted cost, stated plainly:** a macOS window dragged below 768px also becomes full-window
settings. That is a visible change to a shipping desktop target, and screen 25 of the mock-up is
what it looks like. The alternative — keeping the modal and folding the rail into a two-column grid
on top, which is what `< 640px` does today — spends 148px of height on navigation, leaving a 370px
screen unable to show even two 73px rows.

**Acceptance:** `npm run lint`, `npx tsc --noEmit`, `npm run test:unit`, `npm run build`. Visual:
drag a desktop window from 1400px to 370px and back; every section reachable, nothing clipped.

### Stage 2 — Kind B capability flags

Add the four flags, gate the four surfaces, extend the platform-capability unit test. Small,
mechanical, and independently landable. Splitting it out of stage 1 keeps the shell diff readable.

**Acceptance:** the existing platform test plus four new cases; `ABSENT` completeness is enforced
by the type, so a missing default fails to compile.

### Stage 3 — `Select` opens from the bottom under touch

`Select`'s `OptionMenu` rises from the bottom edge when `pointer: coarse`, instead of anchoring to
the trigger. The component's API does not change.

Rejected alternative: a native `<select>`. It buys the system wheel for free but cannot carry a
description line per option — and the 添加模型 screen gives every option one — and it looks like
nothing else in the app.

**Acceptance:** unit test asserting the `touch:` branch renders the sheet; every existing `Select`
call site keeps working unchanged.

### Stage 4 — AI 模型

The largest stage, and the only one with a genuinely new information architecture. Desktop's
`AiSettings.tsx` (36 KB) and `AiServiceCard.tsx` (43 KB) are a wide two-column authoring surface;
a card expands to roughly 600px. On an 800px screen, expanding one card pushes every other card out
of view — which *is* a page change, just without a back button. So on mobile the provider config
**pushes a page**.

Screens: model list → 添加模型 catalogue → provider detail → key entry → connection test → the
missing-key page.

- **The key field gets an eye toggle**, which desktop does not have. Pasting a key on a phone goes
  wrong often — a character short, a trailing space, the clipboard holding the previous thing — and
  an invisible field cannot be checked. Reveal lasts only for that editing session; leaving the page
  re-masks. Whether desktop should get one too is a separate question.
- **No Ollama in the mobile catalogue.** There is no `localhost:11434` on an iPhone. Reaching a
  study-room Mac's Ollama goes through 自定义兼容 API with a LAN address — screen 13, third card.
- **服务配置 as a layer disappears.** Of its four sub-pages only 对话模型 survives, so the
  intermediate tab level has nothing left to do. The root list says AI 模型 directly.
- **The missing-key page follows D-018, not screen 6.** When a model's configuration is present but
  its Keychain item is not, the page compares the two sync channels and names the one that is not
  delivering. It says "probably", it shows the observation it inferred from
  (`sync::peers::list_peers` for a named peer, `settings.updated_by_device` / `updated_at` for the
  configuration's origin and age), it waits a minute before escalating past "just entered it on
  another device? give it a moment", and it falls back to a plainer wording on a single-device
  install. No spinner. `[在这台 iPhone 上输入密钥]` stays first and most prominent.

**Depends on:** the credential Keychain sync, which is decided but unbuilt. The pane can be built
against the observable half (peers, settings metadata) before the Keychain half exists; it will
simply always be in its "key not here" state until then.

### Stage 5 — 自动分析

Full page, not one master switch. Three sub-items toggle independently, because 读完出总结 and
每章要点 differ by an order of magnitude in spend, and a lone master switch forces a choice between
all and nothing. Disabled sub-items stay on the page, greyed, rather than hiding — a hidden row
leaves the reader unable to see what they turned off. The page also promises that **nothing queues
while off**: a month disabled then re-enabled must not suddenly spend thirty books' worth.

**The trigger changes to "next time the app opens".** This is not a preference, it is an iOS fact:
the app is suspended shortly after it backgrounds, so a desktop-style run-at-finish would, on a
phone, never run at all. Two places must carry it or the app becomes something that moves on its own
without saying why — the settings row states the real timing, and a **new shelf banner** (no desktop
counterpart) explains why work is happening that the reader did not start.

**Defaults — my recommendation, drawn in the mock-up:** 总结 and 生词本 on, 每章要点 off. The two
on-by-default items are the ones a reader expects to just exist; per-chapter notes are the expensive
one and should be opted into. Say the word if you want it otherwise.

### Stage 6 — Cellular gate, extended to AI

D-016 covered book downloads. Silently firing a round of analysis requests over cellular and
silently pulling a 68 MB book are the same unannounced spend, one in bytes and one in quota. The two
dialogs are deliberately identical — same sentence shape, same two buttons, same "this will be
remembered" line — differing only in where to change it later. They must read as one policy, not two
independent pop-ups.

**No "remember my choice" checkbox.** D-016 already decided that it remembers. Offering a box the
reader can leave unticked puts "ask me every time" back on the table, which is the option that
satisfies nobody. The two buttons *are* the answer; the line beneath says it will be remembered and
where to change it.

**Default — my recommendation:** 每次询问 rather than 仅 Wi-Fi. Defaulting to Wi-Fi-only means the
first cellular session never asks, and the reader concludes the feature is broken.

**Depends on:** connection-type detection, which does not exist yet on either side. On iOS that is
`NWPathMonitor`; nothing in `src-tauri` reads network state today. This stage is therefore the one
with real backend work in front of it.

### Stage 7 — 书库同步 and 书籍来源

- **书库同步** keeps the status view and drops 打开位置 (`hasFileReveal`) — there is no Finder.
  D-015 already replaced "pick a folder" with "reveal in Finder", so the phone simply has neither.
- **书籍来源** is the phone-only reader's entire path to a first book. Beyond the source list, the
  empty state offers 从「文件」导入一本 as a floor: add no sources at all and books can still get in.
  The LAN card (书房 Calibre) covers the commonest case — the books are on the Mac at home.
- The source card and the model card are one skeleton — name, sub-line, status badge, toggle,
  chevron. Both pages are "a list of orderable, disableable, tappable things".

---

## 3. Things worth knowing that need no decision

- The 73px row is not redesigned by a single pixel. 页边距's subtitle wraps to three lines at 370px
  and the row grows to 96px; hard-coded at 73px today, that sentence would be clipped.
- The API-key field is an ordinary text input, and `src/index.css` already floors font size at 16px
  under `pointer: coarse`. That was the one iOS behaviour that would have wrecked the whole entry
  flow — focus zooming the page in and never back out — and it is already handled.
- Screen 25 and the phone render the same component. Most of this item's acceptance can be done by
  dragging a desktop browser window; only safe-area insets and 44px hot zones need the Simulator.
- The shelf banner in screens 17–18 is a genuinely new component with no desktop counterpart.
  Desktop's auto-analysis runs at the moment of finishing and has no need to explain itself.

---

## 4. Sequencing note

Stages 1–3 touch `SettingsModal.tsx`, `platform.ts`, `Select`, and the row pattern across the
settings components. None of them touch `Reader.tsx` or `ExplainPopover.tsx`, so
[D-011](../roadmap/mobile-ios.md#d-011--p2-waits-for-the-desktop-mastery-line-to-finish) does not
block them — the same reasoning that let P2 items 1 and 2 land.

Stages 4–7 are each large enough to be their own turn, and stages 6 and 7 have backend work in
front of them. They are listed here so the shape is agreed once, not re-litigated four times.
