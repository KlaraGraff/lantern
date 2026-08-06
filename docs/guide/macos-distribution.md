# macOS 发布与签名

## 当前状态（截至 2026-08-06）

仓库已配置 Apple Developer ID 证书，正式发布不再是 ad-hoc 签名。签名身份为 `Developer ID Application: JIANWEI LI`，Team ID `J622D6994N`，证书 2027-02-01 过期。`src-tauri/tauri.conf.json` 中 `bundle.macOS.signingIdentity` 的 `"-"`（ad-hoc）默认值，在 CI 里由下方的 Secrets 覆盖为 Developer ID 身份。

2.9.0 的公证提交已被 Apple 判定为 **Accepted**；签名管线本身（证书导入、Tauri 签名、pdfium 重签同一 Team ID）已用真实构建验证过可以工作。

## 分发管线

`release.yml` 按 tag 形态分流：

- **正式 tag**（如 `v2.9.0`）：使用 Developer ID 身份签名，并提交公证。公证队列的等待时间没有上界——实测从几分钟到几十小时不等，且与安装包大小、内容无关，发布时需要预留这段不确定的等待。
- **预发布 tag**（带连字符，如 `v2.9.0-rc.1`）：跳过公证，走 ad-hoc 签名。原因是应用内更新器只读 GitHub 的 `releases/latest`，而该端点天然排除 pre-release 和 draft，预发布包不会被推给任何用户，为它排队等公证没有收益。

发布说明里关于签名状态的那句话，只由 `release-notes` job 在两个平台的构建都报告完成后统一撰写，反映实际发生的情况（已签名并公证 / 仅 ad-hoc 签名 / 该平台产物根本不在这个 release 里），避免两个 job 各写各的、后完成的覆盖先完成的。

## CI Secrets

`KlaraGraff/lantern` 仓库已配置以下五个 Actions Secrets，macOS job 据此用 Developer ID 身份覆盖 ad-hoc 默认值，并在 Tauri 打包后提交公证：

| Secret                       | 用途                                               |
| ----------------------------- | -------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Developer ID Application `.p12` 文件的 Base64 内容 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码                                    |
| `APPLE_ID`                   | 用于公证的 Apple Account 邮箱                      |
| `APPLE_PASSWORD`             | 该账号的 app-specific password                     |
| `APPLE_TEAM_ID`               | Apple Developer Team ID（`J622D6994N`）            |

**永远不要打印或取回这些 Secret 的值。** 凭据只存在于 GitHub Actions，本机没有，公证无法从本机驱动。

## 验证

发布前应确认 Apple Silicon macOS 任务通过 `Verify macOS app signature` 步骤（断言 Team ID 一致，且 Developer ID 构建不含 `disable-library-validation`）。若该步骤失败，不能发布该 DMG。Intel macOS 不是发布目标。

下载 DMG 后可复核：

```bash
codesign --verify --deep --strict --verbose=4 <App>.app
spctl --assess --type execute --verbose=4 <App>.app
```

确认 `spctl` 接受应用，且不需要用户做任何手动放行操作。

不要通过移除签名或建议用户执行 `xattr -cr` 来绕过发布问题；每个 Release 都必须从 GitHub 附件重新下载后验证，而不是复用本机构建的产物做判断。

## 历史：ad-hoc 时代（2026-07 至 2026-08 初）

在拿到 Developer ID 证书之前，仓库一直靠 `signingIdentity: "-"` 做 ad-hoc 签名 + 资源封条，用户首次打开会被 Gatekeeper 判定为"已损坏"，需要手动执行 `xattr -dr com.apple.quarantine` 或在"系统设置 → 隐私与安全性"里选择"仍要打开"。这一阶段的完整根因分析（ad-hoc 签名 + 浏览器下载的 quarantine 属性组合触发新版 Gatekeeper 的"已损坏"话术，而非文件真的损坏）、缓解方案对比、以及申请 Apple Developer Program 的过程，完整记录在 [`impls/macos-distribution-gatekeeper-fix.md`](../impls/archive/macos-distribution-gatekeeper-fix.md)；公证阶段的延迟实测数据、CI 侧的分流策略、以及签名管线可用性的证据记录在 [`impls/archive/apple-notarization-record.md`](../impls/archive/apple-notarization-record.md)。
