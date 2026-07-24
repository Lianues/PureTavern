# PureTavern Mobile

PureTavern 的最小 Capacitor Android 外壳。

## 边界

- 只消费通用静态产物 `apps/web/dist`；
- 不包含 PureTavern 功能逻辑；
- 不向 Feature Modules 暴露平台 API；
- 每次同步都会用最新 Web 构建完整替换 APK 内的静态资源。

## 命令

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

## 环境

- Node.js 22 或更高版本；
- JDK 21；
- Android SDK Platform 36；
- Android SDK Build Tools 36.0.0。

GitHub Actions 会自动准备这些工具。推送相关改动到 `main` 后，可以从对应 Workflow Run 下载 APK artifact。

Debug APK 仅用于测试。正式分发需要由发布者使用私有 keystore 签署 Release APK 或 AAB。

## 品牌资源

Android launcher 和 splash 由以下脚本从 Web 的统一 PureTavern 图标生成：

```bash
python apps/mobile/scripts/generate_android_branding.py
```

生成后的 Android 资源已提交，正常 Web 更新和 APK 构建不需要运行该脚本。
