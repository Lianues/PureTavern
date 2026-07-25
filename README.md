# PureTavern

PureTavern 是一个以 SillyTavern 为上游的第三方客户端，采用“纯前端 + 可选后端”的设计。

当前版本不依赖后端服务，可以直接部署到 Cloudflare Pages、GitHub Pages 或其他静态托管平台。可选后端接口已经在架构中预留，但尚未实现。

> PureTavern 是独立第三方项目，不是 SillyTavern 官方发行版。

## 在线演示

[https://pure-tavern.netlify.app/](https://pure-tavern.netlify.app/)

[https://pure-tavern.pages.dev/](https://pure-tavern.pages.dev/)

## 密钥与隐私（重点）

PureTavern 当前为纯前端应用，API Key 等密钥只保存在用户当前浏览器的 IndexedDB 中，不会上传到 PureTavern 服务器；项目不会收集或窃取用户密钥。发起模型请求时，密钥只会发送给用户主动配置的模型服务商。

密钥的本地保存不等于安全加密：同源脚本、用户安装的第三方扩展、浏览器插件、开发者工具或被篡改的部署站点仍可能读取密钥。请使用可信部署并谨慎安装第三方扩展。

## 特点

- 不需要运行 SillyTavern Node.js 服务端；
- 保留原版 SillyTavern 界面、提示词系统和前端扩展兼容层；
- 角色、聊天、设置、世界书、预设、密钥和资源保存在浏览器 IndexedDB；
- 支持本地 ZIP 数据导入、导出和恢复点；
- 支持浏览器直连允许 CORS 的 聊天补全服务平台；
- 使用 Service Worker 和 Build ID 缓存静态资源，同版本重复访问无需逐文件校验；
- 为未来的代理、远程备份、私有模型桥接等可选后端能力预留接口。

## 架构

```text
SillyTavern Legacy UI
        │
PureTavern Compatibility Hook
        │
Feature Modules / Capability Ports
        │
IndexedDB + Service Worker + Browser Fetch
        │
Optional Backend Adapters（暂未实现）
```

- **Legacy UI**：继续使用上游 SillyTavern 的界面和纯前端业务逻辑；
- **Compatibility Hook**：在浏览器中接管原版 `/api/**` 请求；
- **Feature Modules**：按角色、聊天、设置、资源、扩展等能力拆分；
- **Browser Storage**：业务数据写入 IndexedDB，静态代码使用 CacheStorage；
- **Optional Backend**：未来可接入 CORS 代理、远程备份、Vault 和私网模型桥接。

## 开发与构建

```bash
pnpm install
pnpm dev
```

生产构建：

```bash
pnpm build
```

静态产物位于：

```text
apps/web/dist
```

这是不绑定托管服务商的通用静态产物，可以部署到 Cloudflare Pages、GitHub Pages、普通静态服务器，也会直接作为 Android 外壳的 Web 内容。

### Android APK

Android 外壳位于 `apps/mobile`，只消费 `apps/web/dist`，不包含业务逻辑或平台专用功能实现。更新 Web 代码后无需手工修改 Android 工程。

```bash
# 构建 Web 并同步到 Android
pnpm android:sync

# 构建可安装的 Debug APK
pnpm android:debug

# 同步后用 Android Studio 打开
pnpm android:open
```

本地 Android 构建需要 JDK 21、Android SDK Platform 36 和 Build Tools 36。APK 输出位置：

```text
apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

GitHub Actions 不会在提交代码时自动打包。需要 APK 时，在仓库的 **Actions → Build Android APK → Run workflow** 中手动触发，完成后下载 Debug APK artifact。Debug APK 适合测试；正式发布仍需配置私有签名密钥并构建 Release APK/AAB。

### iOS IPA

同一个 `apps/mobile` Capacitor 外壳也包含 iOS Xcode 工程，继续消费 `apps/web/dist`：

```bash
pnpm ios:sync
pnpm ios:open # 仅 macOS
```

GitHub Actions 的 **Build iOS IPA** workflow 仅手动触发，在 macOS runner 生成 unsigned IPA。未签名 IPA 需要用户自行签名；App Store/TestFlight 发布必须配置 Apple Developer 证书和 Provisioning Profile。

### HarmonyOS NEXT HAP

HarmonyOS NEXT 6.0.2(22) ArkTS Stage 外壳位于 `apps/harmony`，只消费 `apps/web/dist`。ArkWeb 通过 `https://puretavern.local/` 本地同源和 rawfile 请求拦截加载完整 Web 产物，业务 Feature Modules 不感知鸿蒙平台。

```bash
# 构建 Web 并同步到 Harmony rawfile
pnpm harmony:sync

# 已安装 DevEco/Harmony CLI 时构建 HAP
pnpm harmony:build
```

GitHub Actions 的 **Build HarmonyOS NEXT HAP** workflow 仅手动触发，在 `ubuntu-22.04` 安装固定版本 HarmonyOS Linux command-line-tools 并生成：

```text
PureTavern-<version>-harmonyos-next-arm64-unsigned.hap
```

该 HAP 默认未签名。安装到真机或发布到应用市场前，必须配置 HarmonyOS 调试或发布签名；证书、Profile、密钥库和密码不得提交到仓库。

### 桌面端

Tauri 2 桌面外壳位于 `apps/desktop`，同样只消费 `apps/web/dist`。一套外壳支持 Windows、macOS 和 Linux，Feature Modules 不感知桌面平台。

```bash
# 构建 Web 并打开桌面开发窗口
pnpm desktop:dev

# 构建当前系统的桌面程序和安装包
pnpm desktop:build
```

桌面产物位于 `apps/desktop/src-tauri/target/release`。GitHub Actions 的 **Build Desktop Bundles** workflow 仅手动触发，可生成 Windows x64 NSIS 安装版与便携 EXE、macOS x64/ARM64 DMG，以及 Linux x64 AppImage、DEB 和 RPM 测试包。

### VS Code 扩展

`apps/vscode-extension` 将同一份 `apps/web/dist` 内置到 VSIX。点击 Activity Bar 的 `PT` 图标会打开或激活唯一的 `PureTavern` 编辑器标签页。

```bash
pnpm vscode:build
pnpm vscode:package
```

扩展 ID 为 `lianues.pure-tavern`，作者为 `Limerence`。可以从以下扩展市场安装和体验：

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Lianues.pure-tavern)
- [Open VSX Registry](https://open-vsx.org/extension/Lianues/pure-tavern)

GitHub Actions 的 **Build VS Code Extension** workflow 仅手动触发。

## 测试版发布

GitHub Actions 的 **Build Test Release** workflow 用于手动创建一次完整测试版发布。运行时填写不带 `v` 的稳定版本号，例如 `0.2.0`。

CI 会先构建并验证以下产物：

- `PureTavern-<version>-web.zip`；
- `PureTavern-<version>-android-universal.apk`（测试签名）；
- `PureTavern-<version>-windows-x64-setup.exe`；
- `PureTavern-<version>-windows-x64-portable.exe`；
- `PureTavern-<version>-macos-x64.dmg`；
- `PureTavern-<version>-macos-arm64.dmg`；
- `PureTavern-<version>-linux-x64.AppImage`；
- `PureTavern-<version>-linux-x64.deb`；
- `PureTavern-<version>-linux-x64.rpm`；
- `PureTavern-<version>-ios-unsigned.ipa`；
- `PureTavern-VSCode-<version>.vsix`。

只有全部平台成功后，CI 才会：

1. 创建 `chore(test-release): 0.2.0` 版本提交；
2. 创建 `test-v0.2.0` annotated tag；
3. 创建标题为 `0.2.0 Test`、正文为空的 GitHub Prerelease；
4. 上传上述全部标准化平台包。

构建期间如果 `main` 已前移，发布阶段会拒绝提交和打 Tag，避免用过期源码创建 Release。当前测试版移动端和桌面端没有正式发布者签名：Android 为 Debug APK，iOS 为 unsigned IPA，桌面包会触发对应系统的未签名应用警告。

## 浏览器限制

纯前端无法绕过目标服务的 CORS、TLS 和 Private Network Access 策略。当前密钥保存在浏览器本地，不应视为安全 Vault。

## 许可证

PureTavern 使用 [AGPL-3.0](./LICENSE) 许可证。

项目包含或衍生自 SillyTavern 的上游资源时，同时遵循对应的上游许可证和署名要求。
