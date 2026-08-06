# 自动更新（Tauri Updater）接入方案

> **给谁看：** 负责发 v2.9 的那条线。
> **状态（2026-08-06）：** 密钥和 GitHub Secrets 已就位，代码改动**一行未动**，全部待做。
> **为什么代码没动：** 要改的 `tauri.conf.json` / `Cargo.toml` / `package.json` 正是发版必改的三个文件，两条线同时改必撞。所以这边只做了不碰文件的部分，剩下的随 v2.9 一起落地。

---

## 一、已经做完的（不用重做）

**Apple 公证已通过。** 提交 `9fa351c6-75c0-4120-8903-120198880dde`（`Lantern.zip`）状态为 `Accepted`，证书 `Developer ID Application: JIANWEI LI`（Team `J622D6994N`）可用。此前卡住的账号级问题已解除。

> 另一条 `d2f60c9c…`（`Probe.zip`）仍是 `In Progress`。那是排查期造的 7KB 空壳 app，与真实构建无关，忽略即可。`notary-probe.yml` 已完成使命，可以删。

**更新签名密钥已生成并写入 GitHub Secrets。** 这套密钥是 Tauri 自己的 minisign 密钥，**与 Apple 证书无关**，两者各管一件事：Apple 证书让 macOS 信任这个 app，minisign 密钥让 app 信任推给它的更新包。

| Secret | 状态 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | ✅ 已写入 2026-08-06 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | ✅ 已写入 2026-08-06 |

`release.yml` 的两个 job 早就把这两个环境变量传给了 `tauri-action`，之前只是没值。现在有了，**CI 侧不需要为签名再改任何东西**。

**公钥**（不敏感，就是要写进配置里的那串）：

```
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUzNzJEQjg4NkRFOEJCRDcKUldUWHUraHRpTnR5NC9weUJnMEdzUmplamhKYkJFK0U5YUNkUUdvZTk5UnpoaFpURENXOURxZG4K
```

> ⚠️ **私钥丢了不可恢复。** GitHub Secrets 写进去就读不回来。一旦私钥丢失，只能换新密钥对；而旧版本的客户端只认旧公钥，**所有已安装用户的更新链会永久断掉，必须手动重装**。私钥原件已交给账号持有人存进密码管理器，不在仓库、不在任何文档里。

---

## 二、要改的代码

### 1. `src-tauri/Cargo.toml`

updater 插件**不支持 iOS/Android**，无条件加依赖会直接打断 iOS 构建。仓库里已有现成的段落，加进去即可（第 93 行附近）：

```toml
[target.'cfg(not(any(target_os = "ios", target_os = "android")))'.dependencies]
# ...已有内容...
tauri-plugin-updater = "=2.10.1"
tauri-plugin-process = "=2.3.1"
```

版本精确 pin，跟仓库里其它 Tauri 依赖的写法一致（`tauri = "=2.11.5"`）。`process` 插件是 `relaunch()` 需要的。

改完跑 `cargo check` 同步 `Cargo.lock`。

### 2. `src-tauri/src/lib.rs`

现在的结构是 `let builder = tauri::Builder::default().plugin(...)....plugin(tauri_plugin_os::init());`（约 447–466 行），后面接 `install_menu(builder)`。在这两者之间插入桌面专属注册：

```rust
        .plugin(tauri_plugin_os::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    let app = install_menu(builder)
```

`#[cfg(desktop)]` 是必须的，理由同上。

### 3. `src-tauri/capabilities/` — **新建** `desktop.json`

不要往 `default.json` 里加。它对所有平台生效，iOS 构建会因为找不到 updater 插件而报错。新建一个带平台限定的 capability：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "desktop-updater",
  "description": "Update check, download and relaunch. Desktop only.",
  "platforms": ["macOS", "windows", "linux"],
  "windows": ["main", "reader-*"],
  "permissions": ["updater:default", "process:allow-restart"]
}
```

### 4. `src-tauri/tauri.conf.json`

两处。`bundle` 里把开关打开：

```json
"createUpdaterArtifacts": true
```

顶层加 `plugins` 段（当前配置里没有这个键）：

```json
"plugins": {
  "updater": {
    "pubkey": "<上面第一节那串公钥>",
    "endpoints": [
      "https://github.com/KlaraGraff/lantern/releases/latest/download/latest.json"
    ]
  }
}
```

`bundle.targets` 现在是 `["dmg", "app", "nsis"]`，已经够了——macOS 的更新包从 `app` 产出（`.app.tar.gz`），Windows 从 `nsis` 产出。不用改。

### 5. `package.json`

```
@tauri-apps/plugin-updater  2.10.1
@tauri-apps/plugin-process  2.3.1
```

版本号不带 `^`，与同目录下 `@tauri-apps/plugin-os` 等的写法一致。

### 6. 前端

界面设计**已经拍过板**，直接照 [`q243-update-experience.md`](q243-update-experience.md) 实现，不用重新出样张。要点：

- 更新提示走**顶部居中 toast**，一个 surface 承载全生命周期：`available` → `downloading`（进度条）→ 下载完**自动重启**，没有手动「重启」步骤。
- **设置里不放任何更新控件**，不新增 Updates 面板，About 保持纯身份卡片。
- 「检查更新」放 **macOS 原生应用菜单**（Lantern 菜单，About 旁边），走 `install_menu`。
- 「自动检查」开关放 General 设置。
- 启动时的自动检查**静默**，只有查到更新才出 toast；手动检查才额外显示 `checking` / `uptodate` / `error` 三个瞬态。

接入点是现成的：`src/services/platform.ts` 里已有 `hasUpdater` 能力标志（桌面 `true`、iOS `false`）。**所有更新 UI 都要先过这个标志**——iOS 上没有更新器，菜单项和 toast 都不该出现。注意该文件顶部注释里「Lantern 根本不带更新器」那句已经过时，一并改掉。

API 就三行：

```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const update = await check();
if (update) { await update.downloadAndInstall(onProgress); await relaunch(); }
```

### 7. `.github/workflows/release.yml` — 只改文案

签名和密钥的传递都已就位，唯一要改的是 release notes：**三处** `releaseBody` 里都写着

> macOS 安装包当前使用临时签名，首次打开时 Gatekeeper 可能要求确认。
> The macOS installer currently uses an ad-hoc signature…

公证通过后这话不成立了，删掉或改成「已签名并通过 Apple 公证」。三个 job 的文案是各自独立的副本，别漏。

---

## 三、发布与验证

**发布顺序有个硬约束：** `releaseDraft: true`，CI 建出来的是草稿。而更新源 `releases/latest/download/latest.json` **只认已发布、非 prerelease 的 release**。草稿状态下这个 URL 是 404。所以 v2.9 必须真正 publish 出去，自动更新才开始工作。

发布后逐条验证：

1. **`latest.json` 存在且含两个平台。** macOS 和 Windows 是两个独立 job，各自上传。已确认 `tauri-action` 会先拉取已有的 `latest.json` 合并 `platforms` 再上传，不会互相覆盖——但两个 job 同时完成时理论上存在竞态，所以必须亲眼确认：

   ```bash
   curl -sL https://github.com/KlaraGraff/lantern/releases/latest/download/latest.json | python3 -m json.tool
   ```

   `platforms` 里应同时有 `darwin-aarch64` 和 `windows-x86_64`，每个都带 `signature` 和 `url`。只有一个就是被覆盖了，重跑缺的那个 job。

2. **更新包本身通过公证。** 更新是直接替换 `.app`，没签好会导致替换后打不开：

   ```bash
   curl -sL -o /tmp/u.tar.gz "<latest.json 里 darwin-aarch64 的 url>"
   tar xzf /tmp/u.tar.gz -C /tmp && spctl -a -vvv -t exec /tmp/Lantern.app
   ```

   要看到 `source=Notarized Developer ID`。

3. **端到端走一遍。** 装上 v2.9 之后，把本地 `tauri.conf.json` 的 version 临时改小（比如 `2.8.0`）跑一次 dev，确认能查到更新、下载、自动重启。

---

## 四、必须知道的两件事

**v2.9 这一版仍然要手动下载安装。** 现在装在机器上的 Lantern 里没有更新器，它永远不会去检查更新。必须手动装上第一个带更新器的版本，**从 v2.9 之后的版本才开始自动更新**。这个没有绕过的办法。

**GitHub 上最新的 release 还停在 v2.8.1。** tag `v2.8.2` / `v2.8.3` / `v2.8.4` 都因为当时公证卡死而没能发出去。v2.9 发布前先决定这三个 tag 怎么处理（删掉或留着当历史），别让 `releases/latest` 指向意料之外的版本。

---

## 五、顺手可以清掉的

- `.github/workflows/notary-probe.yml` — 排查公证用的探针，已完成使命
- `.github/workflows/notary-check.yml` — 同上，留着也无害
- `docs/impls/apple-signing-release-handoff-2026-08-04.md` 和 `apple-signing-release-continuation-prompt-2026-08-04.md` — 过程文件，问题已解决，可删
- `HANDOFF.md` — 过程文件，按其自身说明「读完即删」
- `.codex-release-v2.8.2/` — **一个嵌套在项目目录里的完整 git clone**。它未被 `.gitignore` 覆盖，`git status` 里一直显示为未跟踪目录，有被误提交的风险。确认没用了就删，或者至少加进 `.gitignore`。
