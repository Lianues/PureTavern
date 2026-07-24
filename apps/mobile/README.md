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

GitHub Actions 会在手动运行 **Build Android APK** workflow 时准备这些工具并上传 APK artifact；提交或推送代码不会自动打包。

Debug APK 仅用于测试。正式分发需要由发布者使用私有 keystore 签署 Release APK 或 AAB。

## 文件导出

Android 外壳提供通用的系统文件保存器。Web 下载层通过 `ACTION_CREATE_DOCUMENT` 打开系统文件选择器，并分块写入用户选择的位置。此流程使用用户对目标文件的一次性授权，不申请 `READ_EXTERNAL_STORAGE`、`WRITE_EXTERNAL_STORAGE` 或 `MANAGE_EXTERNAL_STORAGE`。

## 品牌资源

Android launcher 和 splash 由以下脚本从 Web 的统一 PureTavern 图标生成：

```bash
python apps/mobile/scripts/generate_android_branding.py
```

生成后的 Android 资源已提交，正常 Web 更新和 APK 构建不需要运行该脚本。
