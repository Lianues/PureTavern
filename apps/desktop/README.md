# PureTavern Desktop

PureTavern 的最小 Tauri 2 桌面外壳，一套工程用于 Windows、macOS 和 Linux。

## 边界

- 只消费通用静态产物 `apps/web/dist`；
- 不包含或复制 PureTavern Provider / Feature Module 业务逻辑；
- 通过 Tauri init script 注入统一本地桥接，并仅开放两个经过 capability 限制的传输命令；
- 每次构建都会先生成最新 Web 产物，不需要同步业务代码。

## 本地后端传输

Windows、macOS 和 Linux 共用 `src-tauri/src/local_server.rs`。桌面专属适配器位于 `src/local-backend-bridge.ts`，被单独打包并由 Rust plugin 在 HTML 解析前注入；它不会进入 `apps/web/dist`。通用 Web 只看到版本化的 `__PURE_TAVERN_LOCAL_BACKEND__` 端口。前端完成 Claude、Gemini、OpenRouter、Vertex 等请求构造后，Rust 只使用 `reqwest` 发送最终 HTTP(S) 包，并通过 Tauri 事件返回标头、32 KiB base64 分块、完成或错误。普通 JSON 与 SSE 都在前端重建为标准 `Response` / `ReadableStream`。

Rust 客户端禁用自动重定向，最多手动跟随 10 次；跨源跳转移除 Authorization、Cookie 和 Proxy-Authorization。Host、Content-Length、hop-by-hop、Set-Cookie 及上游 CORS 标头不会跨越桥接层。最多同时运行 4 个请求，AbortSignal 会中止底层异步任务，窗口销毁时会清理全部请求。

桌面端使用同一份 Rust 源码，但安装包仍需由 Windows、macOS、Linux 各自的 CI runner 编译。Tauri 窗口显式保留 HTTP custom scheme，远程后端的 health/proxy 请求也复用 Rust bridge，因此本地和远程模式都可访问 HTTP/HTTPS 地址，不依赖 WebView 的 Mixed Content 或 CORS 放行。

HTTP 只用于用户明确配置的兼容场景。明文连接会暴露远程代理访问 Key、Provider Key、提示词和响应，并允许网络中间人修改内容；可信测试局域网之外应始终使用 HTTPS。

## 命令

在仓库根目录执行：

```bash
# 构建 Web 后启动桌面开发窗口
pnpm desktop:dev

# 校验并构建桌面专属 init bridge
pnpm --filter @pure-tavern/desktop bridge:check
pnpm --filter @pure-tavern/desktop bridge:build

# 运行桌面 Rust 本地传输测试
pnpm --filter @pure-tavern/desktop test:rust

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

GitHub Actions 中的 **Build Desktop Bundles** workflow 仅支持手动运行，不会在提交或推送代码时自动打包。一次运行会先在每个平台执行 Rust 测试，然后分别构建：

- Windows NSIS installer；
- macOS DMG；
- Linux AppImage 和 DEB。

这些测试包默认没有发布者代码签名。正式分发时需要分别配置 Windows 代码签名证书、Apple Developer 签名与公证。
