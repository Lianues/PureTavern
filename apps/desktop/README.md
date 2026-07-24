# PureTavern Desktop

PureTavern 的最小 Tauri 2 桌面外壳，一套工程用于 Windows、macOS 和 Linux。

## 边界

- 只消费通用静态产物 `apps/web/dist`；
- 不包含 PureTavern Feature Module 逻辑；
- 不向 Feature Modules 暴露桌面 API；
- 每次构建都会先生成最新 Web 产物，不需要同步业务代码。

## 命令

在仓库根目录执行：

```bash
# 构建 Web 后启动桌面开发窗口
pnpm desktop:dev

# 构建当前操作系统的桌面程序和安装包
pnpm desktop:build
```

Tauri 产物位于：

```text
apps/desktop/src-tauri/target/release
apps/desktop/src-tauri/target/release/bundle
```

## 环境

通用要求：

- Node.js 22 或更高版本；
- Rust stable toolchain。

平台依赖：

- Windows：MSVC Build Tools、Windows SDK、WebView2；
- macOS：Xcode Command Line Tools；
- Linux：WebKitGTK 4.1、AppIndicator、librsvg 和 patchelf。

## 手动 CI

GitHub Actions 中的 **Build Desktop Bundles** workflow 仅支持手动运行，不会在提交或推送代码时自动打包。一次运行会分别构建：

- Windows NSIS installer；
- macOS DMG；
- Linux AppImage 和 DEB。

这些测试包默认没有发布者代码签名。正式分发时需要分别配置 Windows 代码签名证书、Apple Developer 签名与公证。
