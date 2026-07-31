# PureTavern Remote Server

此目录存放 PureTavern 的可选远程后端实现。`apps/web` 默认保持纯前端运行；远程后端只在用户选择“远程后端调用”时负责转发最终 HTTP 请求，以绕过浏览器 CORS。

Claude、Gemini、OpenRouter、Vertex 等 Provider 的 URL、Headers、Body、认证和响应转换全部由 Web 前端完成。三种后端都不保存 Provider Key、请求内容或连接配置。

## 实现

| 实现                 | 运行要求                              | 适用场景                                 |
| -------------------- | ------------------------------------- | ---------------------------------------- |
| [`python`](./python) | Python 3.11+、FastAPI/httpx           | 已有 Python 环境、便于二次开发           |
| [`nodejs`](./nodejs) | Node.js 20+，无第三方生产依赖         | 已有 Node 环境、源码直接运行             |
| [`go`](./go)         | 下载版无需运行时；源码构建需 Go 1.23+ | **推荐部署方式**，单文件、启动快、内存低 |

三种实现共享协议：

- `GET /v1/health`：Bearer Key 鉴权和协议握手；
- `POST /v1/proxy`：转发最终 GET/POST；
- 协议：`pure-tavern-generation-proxy`，版本 `1`；
- 普通 JSON 和 SSE 都支持；
- 默认监听 `0.0.0.0:8000`，前端开发端口为 `8899`。

## 快速命令

在仓库根目录执行：

```powershell
# Node.js
pnpm --filter @pure-tavern/remote-server check:nodejs
pnpm --filter @pure-tavern/remote-server test:nodejs
pnpm --filter @pure-tavern/remote-server start:nodejs

# Python（需先安装 requirements-dev.txt）
pnpm --filter @pure-tavern/remote-server check:python
pnpm --filter @pure-tavern/remote-server test:python

# Go
pnpm --filter @pure-tavern/remote-server check:go
pnpm --filter @pure-tavern/remote-server test:go
pnpm --filter @pure-tavern/remote-server start:go
```

详细环境变量、PowerShell 和 Linux/macOS 启动方式见各实现 README。

## GitHub Actions 与二进制

`.github/workflows/remote-server.yml` 会：

1. 分别测试 Node.js、Python 和 Go；
2. 使用 `CGO_ENABLED=0` 交叉编译：
   - Windows x64 / arm64；
   - Linux x64 / arm64；
   - macOS x64 / arm64；
3. 为普通 CI 上传可下载 Actions artifacts；
4. 被正式和测试 Release 复用。

正式 Release 的资产名为：

```text
PureTavern-<version>-remote-server-<platform>-<arch>.zip
PureTavern-<version>-remote-server-<platform>-<arch>.tar.gz
```

正式发布会将这些文件纳入统一的 `SHA256SUMS.txt`。当前后端二进制未签名，下载后应先验证哈希。

## 安全提示

这些服务是能够访问任意 HTTP/HTTPS 和私有网络地址的受保护代理。生产环境必须设置高强度 `PURE_TAVERN_PROXY_KEY`、限制 `PURE_TAVERN_ALLOWED_ORIGINS`，并配合 HTTPS、防火墙及访问控制；不要将其作为无鉴权开放代理暴露到公网。
