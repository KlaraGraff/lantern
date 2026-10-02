# macOS 发布与签名

## 签名状态按每次构建确认

签名方式由 [release.yml](../../.github/workflows/release.yml) 的标签分支和证书导入结果决定。`src-tauri/tauri.conf.json` 中 `bundle.macOS.signingIdentity` 默认是 `"-"`（ad-hoc 临时签名），CI 检测到可用 Developer ID 身份后才覆盖它。历史版本成功签名或曾配置证书，均不能证明当前版本已签名、公证或可直接打开。

## 分发管线

- **正式 tag**（不带连字符，如 `v2.18.13`）：证书与密码配置存在时尝试导入，并检查 Developer ID Application 身份。检测到身份后走 Developer ID 构建，将公证凭据交给 Tauri；是否完成公证须核对本次日志。
- **预发布 tag**（带连字符，如 `v2.18.13-rc.1`）：主动跳过 Developer ID 签名和公证，走 ad-hoc 构建。应用内更新器只读取正式发布，不推送预发布。
- **证书未配置、导入失败或未找到身份**：工作流尝试 ad-hoc 分支。分支选择不等于发布成功，后续构建或签名检查仍可能失败；只有成功产物才可发布。

标签触发的发布说明由 `release-notes` job 在两个平台构建结束后统一撰写。人工发布前仍须对照资产列表与构建日志核实说明；说明文字、已配置凭据或签名意图都不能替代签名、公证成功的证据。

## CI 凭据

工作流引用以下 Actions Secrets；这里列出用途，不断言当前是否已配置或有效：

| Secret | 用途 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application `.p12` 文件的 Base64 内容 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| `APPLE_ID` | 用于公证的 Apple Account 邮箱 |
| `APPLE_PASSWORD` | 该账号的 app-specific password |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

**不要打印或取回 Secret 的值。** 从工作流分支结果和脱敏日志核验，无需读取密钥。

## 发布验证

1. 用 `gh release view <tag> --json assets` 核对所需资产是否齐全、名称中的版本是否一致、大小是否合理。**不为验证而下载安装包。** 资产元数据只证明产物齐全，不能证明签名、公证或运行成功。
2. 核对同一 tag/commit 的 Apple Silicon macOS 构建及 `Verify macOS app signature` 结果。该步骤检查应用与 PDFium 签名，并实际执行 `pdfium-smoke`。Developer ID 路径还检查两者 Team ID 一致且未禁用 library validation；ad-hoc 路径检查所需的临时签名权限。任何验证失败均不能当作该 DMG 已通过发布验收。Intel macOS 不是发布目标。
3. 对 Developer ID 产物，确认本次构建日志有 Apple 公证 **Accepted** 与 stapling 成功记录，不能只看 job 选择了签名分支或自动生成的发布说明。证据缺失时明确标为未核实，不能声称已通过公证。
4. 需要运行或 Gatekeeper 证据时，使用**本机已经构建的产物**，核对其版本、提交及实际签名方式后执行必要检查。记录产物来源；本机构建的结果不能冒充 GitHub 下载包的安装体验验证。

对已构建的 Developer ID 应用，可按需执行：

```bash
codesign --verify --deep --strict --verbose=4 /path/to/Lantern.app
spctl --assess --type execute --verbose=4 /path/to/Lantern.app
xcrun stapler validate /path/to/Lantern.app
```

运行后在“设置 → 关于”核对构建提交。ad-hoc 应用未经 Apple 公证，不能套用“Gatekeeper 必须接受”的 Developer ID 验收结论。此类发布说明应明确限制；对用户已确认来源的 ad-hoc 应用，可说明定点移除下载隔离属性的办法：`xattr -dr com.apple.quarantine /Applications/Lantern.app`。不得用移除签名、全局关闭 Gatekeeper 或此命令来掩盖 Developer ID 产物的验证失败。

## 历史记录

早期 ad-hoc 分发的 Gatekeeper 根因分析和缓解过程见 [macOS 分发问题记录](../impls/archive/macos-distribution-gatekeeper-fix.md)；历史公证耗时、分流策略及签名管线证据见 [Apple 公证记录](../impls/archive/apple-notarization-record.md)。这些记录只证明对应历史构建，不代表后续版本的签名状态。
