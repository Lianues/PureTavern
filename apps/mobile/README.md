# PureTavern Mobile

PureTavern 的最小 Capacitor Android 与 iOS 外壳。

## 边界

- 只消费通用静态产物 `apps/web/dist`；
- 不包含 PureTavern 功能逻辑；
- 不向 Feature Modules 暴露平台 API；
- 每次同步都会用最新 Web 构建完整替换移动端包内的静态资源。

## Android

在仓库根目录执行：

```bash
pnpm android:sync
pnpm android:debug
pnpm android:open
```

Debug APK 输出：

```text
apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

本地构建需要 JDK 21、Android SDK Platform 36 和 Build Tools 36.0.0。GitHub Actions 中的 **Build Android APK** workflow 仅手动触发。

Android 外壳提供通用系统文件保存器。Web 下载层通过 `ACTION_CREATE_DOCUMENT` 打开系统文件选择器，并分块写入用户选择的位置，不申请 `READ_EXTERNAL_STORAGE`、`WRITE_EXTERNAL_STORAGE` 或 `MANAGE_EXTERNAL_STORAGE`。

## iOS

在仓库根目录执行：

```bash
# Windows、macOS 均可更新 Xcode 工程中的 Web 资源
pnpm ios:sync

# 仅 macOS 可打开 Xcode
pnpm ios:open
```

iOS 工程位于：

```text
apps/mobile/ios/App/App.xcodeproj
```

GitHub Actions 中的 **Build iOS IPA** workflow 仅手动触发，并在 macOS runner 生成：

```text
PureTavern-unsigned.ipa
```

该 IPA 没有 Apple 代码签名，不能作为 App Store/TestFlight 正式包直接发布。可以交给 AltStore、SideStore 等工具自行签名；正式发布必须配置 Apple Developer 证书、Provisioning Profile 和 Team ID。

## 品牌资源

Android 与 iOS 图标、启动图由统一 PureTavern 品牌源生成：

```bash
pnpm --filter @pure-tavern/mobile brand:mobile
```

生成资源已提交，正常 Web 更新和移动端构建不需要再次运行品牌脚本。
