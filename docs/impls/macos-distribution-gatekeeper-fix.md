# macOS 分发修复:GitHub 产物"已损坏"问题(签名与公证)

> **这是一份"活文档"。** 记录计划与进度,接手者先读本文件再动手。每完成一项更新勾选框与变更日志。

- **发起:** Claude Code 会话(2026-07-17)
- **状态:** 🟡 方案已定,待用户决策(方案 A 需 Apple Developer 账号)
- **关联:** [`format-normalization-pipeline.md`](format-normalization-pipeline.md)(昨日 CSP 阅读器修复,与本问题**无关但曾被混淆**,见 §2)

## 1. 症状

- 从 GitHub Release 下载 `Lantern_2.0.0_aarch64.dmg`(浏览器下载)→ 打开/首次启动时 macOS 提示 **"Lantern.app 已损坏,无法打开"**,只给"移到废纸篓"选项。
- 同一台机器上 `npm run package` 本地构建的 `.app` 一切正常。

## 2. 根因(已实证,非猜测)

**因果链:**

1. **CI 没有配置 Apple 签名证书。** `release.yml` 的 "Determine macOS signing mode" 步骤检测 `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD` secrets——从未设置过,所以走 **ad-hoc 签名分支**(`Signature=adhoc`,`TeamIdentifier=not set`,hardened runtime 开启)。历史上所有 release 产物都是 ad-hoc 的。
2. **浏览器下载给 dmg/app 打上 `com.apple.quarantine` 隔离属性**(本次实测:Edge 下载,xattr 可见)。
3. **macOS 26 的 Gatekeeper 对"ad-hoc 签名 + quarantine"的组合直接报"已损坏"**(不是文件真损坏;这是新版系统对无有效开发者签名应用的标准话术,且新系统已移除右键打开的旁路)。实测 `spctl -a` 裁决为 `rejected`。
4. **本地构建从不触发**:本机构建产物没有 quarantine 属性,LaunchServices 不做 Gatekeeper 评估 → 直接运行。

**证据(2026-07-17 实测):**
- 下载 dmg 完整性核验通过,内含二进制与 CI 产物哈希一致(`c35ed1af…` = run 29562517912 产物)→ 排除"真损坏/下载截断"。
- 该二进制嵌入的 CSP 已无 `frame-ancestors`(阳性对照 `asset.localhost` 命中)→ **昨日的 CSP 阅读器修复在 CI 产物里是完好的**,"GitHub 包不行"与阅读器 bug 无关。
- SDK(26.5)、entitlements(`disable-library-validation`)与本地构建一致 → 产物内容层面无差异。
- 移除 quarantine 后同一 app 正常启动 → 唯一变量就是隔离属性。

**推论:** 当前 release 上的产物(以及未来任何 ad-hoc 产物)对**所有下载用户**都会被 Gatekeeper 拦截。这不是某次构建的事故,是分发链路的结构性问题。

**⚠️ 重要更正(2026-07-17,实证后修订):** 起初本文断言"签名类型是变量、旧版能'仍要打开'是因为别的原因"。经与历史产物逐一比对,该断言**错误**,已订正:
- 旧版 `Quill.Personal_1.3.1`(2026-07-13 下载)与当前 `Lantern_2.0.0` 的签名状态**完全相同**:都是 ad-hoc、hardened runtime、无 Developer ID,`codesign --verify --deep --strict` 都通过(签名封印完好,**并非真损坏**)。
- `gktool scan`(macOS 实际 Gatekeeper 评估器)对两者给出**逐字相同**的裁决:`not signed by a distributor that meets the system Gatekeeper requirements`。`spctl` 都是 `rejected`。
- 两次下载都发生在 macOS 26.5.2(07/06 安装)之后,XProtect 版本同为 5347(05/29)——**系统层无差异**。
- 去掉 quarantine 后,2.0.0 `codesign --verify` 通过、可正常运行——**它从来不是真的"损坏"**,只是被 quarantine 门禁挡住。

**因此正确结论是:签名不是变量。** ad-hoc 应用一直可以通过"手动放行"打开,1.3.1 当年如此,2.0.0 **同样如此**——用完全一样的方式即可(见 §3)。之所以同一台机器上两者的**弹窗文案**可能不同("无法验证开发者/仍要打开" vs "已损坏/移到废纸篓"),取决于**下载与打开方式的细节**(直接在只读 dmg 里运行 vs 先拷进 Applications 再打开、是否发生 app translocation、quarantine 标志的具体字段),而**不是**包本身或有没有签名证书。这一层无法从产物侧根治,只能靠 §3 的手动放行或 §4 的正式签名消除。

## 3. 立即缓解(已做/可复用)

- [x] 本机已安装的 app 解锁:`xattr -dr com.apple.quarantine /Applications/Lantern.app`(2026-07-17 已执行,app 可正常运行)。
- [ ] **临时安装说明**:在 Release Notes 顶部加一段"macOS 安装说明":
  ```
  下载后若提示"已损坏":打开终端执行
  xattr -d com.apple.quarantine ~/Downloads/Lantern_2.0.0_aarch64.dmg
  再打开 dmg 拖入 Applications;或对已拖入的 app 执行
  xattr -dr com.apple.quarantine /Applications/Lantern.app
  ```
  (手动编辑当前 release 即可;方案 B 会把它自动化。)

## 4. 方案 A(正式修复,推荐):启用 CI 签名 + 公证

`release.yml` **已经内建完整的签名/公证/校验流水线**(签名身份导入 keychain、tauri-action 签名与 notarize、pdfium 重签同 Team ID、`Verify macOS app signature` 步骤断言 Team ID 一致且 Developer ID 构建不含 `disable-library-validation`、`pdfium-smoke` 冒烟)。**不需要改任何工作流代码,只需要配 secrets。**

### 前置条件(用户侧,无法代劳)
- [ ] Apple Developer Program 账号(个人 $99/年)。
- [ ] 在 developer.apple.com 创建 **Developer ID Application** 证书,导入本机钥匙串后连私钥导出为 `.p12`(设导出密码)。
- [ ] 为 Apple ID 创建 **App 专用密码**(appleid.apple.com → 登录与安全 → App 专用密码),供公证用。

### 实施步骤
- [ ] 证书转 base64:`base64 -i DeveloperID.p12 | pbcopy`
- [ ] 配置仓库 secrets(在 `KlaraGraff/lantern`):
  ```
  gh secret set APPLE_CERTIFICATE          # p12 的 base64
  gh secret set APPLE_CERTIFICATE_PASSWORD # p12 导出密码
  gh secret set APPLE_ID                   # Apple ID 邮箱
  gh secret set APPLE_PASSWORD             # App 专用密码
  gh secret set APPLE_TEAM_ID              # 开发者 Team ID(10 位)
  ```
- [ ] 触发一次构建验证:`gh workflow run release.yml`(workflow_dispatch,不动 tag),确认走 signed 分支且 `Verify macOS app signature` 通过。
- [ ] 重新发布:删除并重打当前 tag(或发新版本号,见 §6),让签名产物替换 release 上的 ad-hoc 产物。

### 验收标准
1. `codesign -dv` 显示 Developer ID 签名 + 有效 Team ID;`stapler validate` 通过(公证票据已钉入)。
2. 从 GitHub 下载 dmg,**不做任何 xattr 操作**,双击安装、双击启动,无"已损坏"提示。
3. 打开 EPUB 正常(带出昨日 CSP 修复的回归确认);PDF 元数据/封面正常(pdfium 重签路径)。
4. Dock/Finder 显示新图标(图标已在 `6dd1a26` 换为 XL_Translator 品牌图,当前产物已含)。

## 5. 方案 B(无开发者账号时的过渡):自动附带安装说明

- [ ] `release.yml` 的 ad-hoc 分支(`build-adhoc` 步骤)把 `releaseBody` 改为包含 §3 的 xattr 安装说明,让每个 ad-hoc release 自带提示。
- [ ] 可选:ad-hoc 构建产物文件名加 `-unsigned` 后缀,消除歧义。
- 局限:用户体验差(需要终端操作),仅作为拿到证书前的过渡。**方案 B 不能替代方案 A。**

## 5.5 已评估的替代方案(2026-07-17,含一处实证更正)

- **"像原来一样显示不安全、让用户手动授权"** — ✅ **可行,就是方案 B。**(此处原判"不可行"已按 §2 的实证更正。)ad-hoc 应用一直支持"手动放行",1.3.1 当年如此,2.0.0 同样如此,与有没有签名证书无关。用户侧放行方式(任选其一):
  - **终端(最稳,一定成功):** `xattr -dr com.apple.quarantine /Applications/Lantern.app`(拖进 Applications 后执行)。
  - **GUI:** 首次打开被拦后,到"系统设置 → 隐私与安全性"底部点"仍要打开";或右键 app → 打开。**注意:** GUI 路径是否出现、文案是"无法验证开发者"还是"已损坏",在新版 macOS 上受打开方式影响不稳定(见 §2),所以发布说明应以终端 `xattr` 为首选指引、GUI 作为备选。
  - 结论:这条路对个人自用/小范围分发**完全够用**——它不是我们 bug 造成的降级,而是无证书分发的固有形态。方案 A(签名)的唯一增益是**免去用户这一步手动操作**。
- **"本地打包后上传产物、不用 GitHub 打包"** — 无效(此条不受更正影响)。Gatekeeper 拦截的触发条件是 **ad-hoc 签名 + 下载时的 quarantine 属性**,与在哪台机器构建无关:本地包同样是 ad-hoc(`signingIdentity: "-"`),任何人(包括自己换台设备)从网络下载后一样带 quarantine → 一样被拦。本地构建只对"构建机本机直接安装、不经下载"这一种场景免拦。结论:**换构建机解决不了分发,能让"下载即用"的只有签名(方案 A)。**

## 6. 伴随事项与教训(本次排查顺带确认)

- [ ] **版本号复用的代价(记录在案):** 今天同名 `Lantern_2.0.0_aarch64.dmg` 先后存在**三个不同内容**的版本(7/15 原始坏包 18.71MB → run1 修复包 18.75MB → run2 修复+新图标 22.5MB),叠加浏览器缓存/重复下载极易测错对象,本次排查即为此多花了整轮比对。**建议惯例:已发布过的版本号不再复用**;真要覆盖,至少让产物可区分(见下条)。
- [x] **构建指纹可见化:已存在(此前误报缺失)。** 设置 → 关于 已展示 commit/构建时间/渠道(`app_build_info` 命令 + `AboutSettings.tsx`,含诊断信息一键复制)。已将"排查/验收先记录关于页 commit"写入 `AGENTS.md` → Release Conventions 成为惯例。
- [x] **vendored foliate-js 完整性:** `624a759` 把 submodule 改为 vendor 后,`paginator.js` 仍含 Layer B(`IFRAME_LOAD_TIMEOUT`)与防搁浅加固(`IFRAME_DOCUMENT_INACCESSIBLE`),与 fork `112eb27` 一致,下个 tag 不会回归。
- [x] **CSP 修复在 CI 产物中确认存在**(见 §2 证据)——阅读器问题与分发问题解耦,各自闭环。

## 7. 变更日志

- **2026-07-17** — 创建文档。实证根因(ad-hoc + quarantine → Gatekeeper "已损坏"),本机已用 xattr 解锁并验证 app 可运行。方案 A(签名+公证)依赖用户提供 Developer ID 证书;方案 B(自动附安装说明)可先行。
- **2026-07-17(续)** — 评估两个替代方案(旧式手动授权、本地打包上传),分析记入 §5.5。惯例固化:`AGENTS.md` 新增 **Release Conventions**(禁止复用已发布版本号 / 以关于页 commit 识别构建 / 发布后验收实物产物);release skill 增加版本号防复用守卫与发布后产物验收步骤(第 10 步)。更正 §6:构建指纹展示早已存在于 设置→关于。
- **2026-07-17(续2,重要更正)** — 用户质疑"旧版无证书也能'仍要打开'"。经历史产物实证(1.3.1 vs 2.0.0 签名状态相同、`gktool`/`spctl` 裁决逐字相同、下载均在同一 OS/XProtect 之后、去 quarantine 后 2.0.0 正常运行),**推翻先前"签名是变量/手动授权路径已失效"的错误断言**:签名不是变量,手动放行(§3 xattr)对 2.0.0 与 1.3.1 同样有效,方案 B 是可行方案而非降级 fallback。§2 加"重要更正"块、§5.5 相应订正。
