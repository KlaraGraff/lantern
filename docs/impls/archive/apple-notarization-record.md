# Apple 公证：事实记录

> 这份文件替代了 2026-08-04 那两份交接文档。它们的核心结论**已经被证伪**，留着比删掉更危险，所以把还成立的部分搬到这里，其余删除。

## 一、被证伪的结论

08-04 的交接文档断言：「公证在 Apple 侧被**账号级**阻断，提交从未被处理，`notarytool log` 对两个提交都返回 *Submission log is not yet available*，这是最锐利的信号——Apple 不是慢，是根本没开始。」并据此让用户去开支持工单。

**这个结论是错的。** 08-06 直接查询 `notarytool history` 得到：

| 提交 ID | 文件 | 创建时间 (UTC) | 08-06 的实际状态 |
| --- | --- | --- | --- |
| `9fa351c6-75c0-4120-8903-120198880dde` | `Lantern.zip` | 2026-08-04 14:27:59 | **Accepted** |
| `d2f60c9c-326d-4745-916c-e1d36edb0690` | `Probe.zip`（7,852 字节的空壳探针） | 2026-08-05 07:58:27 | In Progress（约 29 小时） |
| `a725b6bb-32ef-49be-8b92-458a53a0c6ec` | `Lantern.zip`（2.9.0） | 2026-08-06 09:08:39 | In Progress |

第一个提交最终通过了。账号没有被阻断。

## 二、现在成立的结论

**提交会被处理，但延迟没有上界。** Apple 公布的预期是「大多数在 15 分钟内完成」；这个账号上实测的区间是从若干小时到几十小时，而且不可预测——最小的那个探针包（一个空 `main()`）反而卡得最久，所以延迟和包大小、包内容都无关。

**v2.9.0 的发布失败不是 Apple 拒绝，是 runner 掉线。** Run `31087078694` 跑了 1h53m 后死在

```
NSURLErrorDomain Code=-1009 ... No network route
```

——`notarytool` 轮询 `https://appstoreconnect.apple.com/notary/v2/submissions/a725b6bb…` 时 GitHub runner 自己断网。此时提交本身在 Apple 那边状态正常。

**因此，如果要开工单，内容必须改写。** 不要用交接文档里那段草稿（它声称提交「从未被处理」，事实不符，会把工单引向错误方向）。正确的诉求是：提交能被受理也能通过，但处理时长从分钟级漂到几十小时，远超公布的预期，请说明账号是否处于某种降级队列。可引用上表三个提交号，Team ID `J622D6994N`。

## 三、CI 侧已经做的应对

`release.yml` 现在按 tag 形态分流（见 `ci(release): stop promising notarization the build did not do`）：

- **正式 tag**（`v2.9.0`）走 Developer ID 签名 + 公证，会承担上面那个不确定的等待。
- **预发布 tag**（带连字符，`v2.9.0-rc.1`）跳过公证，走 ad-hoc 签名。更新器只读 `releases/latest`，而 GitHub 的这个端点天然排除 pre-release 和 draft，所以预发布包不会被推给任何用户，为它等公证队列没有任何收益。

发布说明里关于签名的那句话现在只有一个作者：`release-notes` job，在两个构建都报告完成之后写，说的是实际发生的事（已签名并公证 / 只有 ad-hoc 签名 / 这个平台的包根本不在这个 release 里）。此前两个 job 各写各的、后完成的覆盖先完成的，v2.9.0 那个 draft 就因此在没有任何 macOS 产物的情况下声称「已通过 Apple 公证」。

## 四、诊断工具

两个 workflow 在 `main` 上，都不构建也不发布任何东西：

```bash
gh workflow run notary-check.yml --repo KlaraGraff/lantern --ref main -f wait=false
```

`wait=false` 约一分钟返回当前状态。省略它会阻塞最多 50 分钟等 Apple，只有在预期马上出结果时才值得。

```bash
gh workflow run notary-probe.yml --repo KlaraGraff/lantern --ref main -f timeout=900
```

探针构建一个空壳 app 用同一张证书签名提交，用来把「包的问题」和「账号的问题」分开。

## 五、配置

Team ID `J622D6994N`。Developer ID Application 证书 **2027-02-01 过期**。

`KlaraGraff/lantern` 上有五个 Actions secret：`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`。**永远不要打印或取回它们的值。** 凭据只存在于 GitHub Actions，本机没有，公证无法从这台机器驱动——`.agents/skills/release/SKILL.md` 里「凭据在 `~/.zshrc`」的说法是错的。

## 六、两件安全事项（2026-08-06 更新）

**1. app-specific password 曾被粘贴进聊天，必须当作已泄露。** 它仍然有效，也不是任何一次失败的原因，但按一般纪律应当吊销并更换（换的话新密码直接填进 GitHub secret `APPLE_PASSWORD`，不再粘进任何对话）。

**2026-08-06 决定：不轮换，此项关闭。** 该口令只出现在与 Claude 的对话中，不会被其他任何人看到；用户知情并接受这一风险。

**2. 私钥没有本地持久备份。** 原始密钥和它的 PKCS#12 口令建在 `/private/tmp` 下，已被系统清理删除。GitHub 上的加密 secret 还能用，但换一台机器重建 CI 就需要从钥匙串重新导出。

**2026-08-06 决定（当晚）：不备份，此项关闭。** 用户权衡后认为多一份需要自己保管的文件反而更容易丢。据实记录现状：私钥现有两份副本——GitHub 加密 secret（CI 在用）和本机钥匙串；密码管理器里存的是 app-specific password，**不含**私钥。若两份副本同时失效，可在 Apple Developer 网站重新签发一张 Developer ID 证书重建管线，已发布版本的签名与公证不受影响。风险已知情接受。

## 七、签名管线本身是好的

以下四个提交是「签名能工作」的原因，不是任何当前问题的嫌疑人：

| 提交 | 改动 |
| --- | --- |
| `bf5d355` | 用带引号的 `printf` 解码证书；把 OpenSSL 3 的 PKCS#12 转成 macOS 钥匙串接受的 legacy 格式再导入 |
| `f1dd9f2` | 从 `tauri-action` 的环境里去掉 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`，让 Tauri 复用已导入的身份，而不是把不兼容的原始文件再导入一次 |
| `b4fa33c` | 给 `notary-check.yml` 加 `wait=false` |
| `004472d` | 加 `notary-probe.yml` |

Run `30918087595` 的日志证明三个目标（`libpdfium.dylib`、`Contents/MacOS/lantern`、`Lantern.app`）都在 `Developer ID Application: JIANWEI LI` 下签名成功。
