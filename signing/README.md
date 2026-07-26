# 发布签名材料

`.github/workflows/release.yml` 用到的签名密钥全部通过 **GitHub Actions Secrets** 注入，仓库里不存放任何密钥文件。本目录的 `.gitignore` 会忽略除本文档以外的所有内容，因此可以放心把本地密钥库放在这里。

> **最重要的一条**：Android 密钥库一旦丢失，`com.puretavern.app` 这个包名就永久无法再发布可原地升级的版本（用户只能卸载重装，数据全丢）。Secrets 是给 CI 用的副本，**不是备份**。请把原始 `.keystore` 文件和密码离线备份到密码管理器或加密存储中。

---

## Android（必需）

### 1. 生成密钥库

只需要做一次，此后所有版本都必须复用同一个文件。

```bash
keytool -genkeypair -v \
  -keystore signing/pure-tavern-release.keystore \
  -storetype PKCS12 \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -alias pure-tavern \
  -dname "CN=PureTavern, O=PureTavern, C=CN"
```

- PKCS12 格式要求 store 密码与 key 密码相同，`keytool` 会自动同步，填一个密码即可。
- `-validity 10000` 约 27 年，覆盖 Google Play 对有效期的要求。
- `-alias` 之后要填进 `ANDROID_KEY_ALIAS`，记下来。

### 2. 转成 base64

PowerShell（Windows）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("signing\pure-tavern-release.keystore")) | Set-Clipboard
```

bash（macOS / Linux）：

```bash
base64 -w0 signing/pure-tavern-release.keystore | pbcopy   # Linux 用 xclip
```

### 3. 配置仓库 Secrets

`Settings → Secrets and variables → Actions → New repository secret`：

| Secret                      | 内容                                    | 必需 |
| --------------------------- | --------------------------------------- | ---- |
| `ANDROID_KEYSTORE_BASE64`   | 上一步的 base64 字符串                  | 是   |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码                              | 是   |
| `ANDROID_KEY_ALIAS`         | 生成时使用的 `-alias`                   | 是   |
| `ANDROID_KEY_PASSWORD`      | key 密码；PKCS12 下与库密码相同时可不填 | 否   |

缺少前三项时 `Build Release` 会在 preflight 阶段立刻失败，不会浪费构建时间。

### 4. 本地复现同样的产物

同一份密钥库在本地也能用，产物与 CI 等价：

```bash
export PURE_TAVERN_KEYSTORE_PATH="$PWD/signing/pure-tavern-release.keystore"
export PURE_TAVERN_KEYSTORE_PASSWORD='...'
export PURE_TAVERN_KEY_ALIAS='pure-tavern'
pnpm android:release
```

PowerShell：

```powershell
$env:PURE_TAVERN_KEYSTORE_PATH = "$PWD\signing\pure-tavern-release.keystore"
$env:PURE_TAVERN_KEYSTORE_PASSWORD = '...'
$env:PURE_TAVERN_KEY_ALIAS = 'pure-tavern'
pnpm android:release
```

未设置 `PURE_TAVERN_KEYSTORE_PATH` 时 Gradle 不会声明 release 签名配置，`assembleRelease` 产出的是 `app-release-unsigned.apk`，普通贡献者的构建不受影响。

### 5. 校验签名身份

```bash
apksigner verify --print-certs --verbose PureTavern-<version>-android-universal.apk
```

把输出里的 **SHA-256 证书指纹**记录到安全的地方，之后每次发布都可以比对，确认没有换错密钥。

---

## Windows Authenticode（可选，当前未配置）

拿到代码签名证书（`.pfx`）后：

| Secret / Variable                                        | 内容                                               |
| -------------------------------------------------------- | -------------------------------------------------- |
| `WINDOWS_CERTIFICATE`                                    | `.pfx` 的 base64                                   |
| `WINDOWS_CERTIFICATE_PASSWORD`                           | `.pfx` 密码                                        |
| `WINDOWS_TIMESTAMP_URL`（repository **variable**，可选） | 时间戳服务器，默认 `http://timestamp.digicert.com` |

配置好后 CI 会自动导入证书、把指纹写进 `tauri.conf.json` 并去掉 `--no-sign`，无需改动 workflow。未配置时构建照常进行，只是产物未签名，release notes 会明确标注。

## macOS Developer ID（可选，当前未配置）

需要 Apple Developer 账号（99 美元/年）导出的 `Developer ID Application` 证书：

| Secret                       | 内容                                                |
| ---------------------------- | --------------------------------------------------- |
| `APPLE_CERTIFICATE`          | `.p12` 的 base64                                    |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 密码                                         |
| `APPLE_SIGNING_IDENTITY`     | 形如 `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`                   | 用于公证的 Apple ID                                 |
| `APPLE_PASSWORD`             | App-specific password（**不是**账号密码）           |
| `APPLE_TEAM_ID`              | 10 位 Team ID                                       |

Tauri 会自行导入证书到临时 keychain 并调用 `notarytool` 完成公证与 staple。

## Linux

deb / rpm / AppImage 按惯例不做代码签名，发布产物附带的 `SHA256SUMS.txt` 即校验手段。
