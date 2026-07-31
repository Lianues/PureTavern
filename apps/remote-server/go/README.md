# PureTavern Go 远程后端

这是 PureTavern 推荐的低资源、单文件二进制远程后端。它只使用 Go 标准库，不包含任何 Provider 业务逻辑，也不需要 Python、Node.js 或额外动态库。

Provider 请求由 Web 前端完整构造；Go 服务只验证协议、转发最终 HTTP 请求，并将普通 JSON 或 SSE 按读取块立即写回浏览器。

## 下载二进制

GitHub Actions 和正式 Release 会提供以下产物：

- Windows x64 / arm64：ZIP；
- Linux x64 / arm64：`tar.gz`；
- macOS x64 / arm64：`tar.gz`。

解压后的文件名统一为：

```text
pure-tavern-remote-server
pure-tavern-remote-server.exe   # Windows
```

可先查看内嵌版本：

```powershell
.\pure-tavern-remote-server.exe --version
```

正式 Release 同时提供 `SHA256SUMS.txt`。当前后端二进制未做代码签名，请先核对哈希。

## Windows PowerShell 启动

```powershell
$env:PURE_TAVERN_PROXY_KEY = "请替换为足够长的随机字符串"
$env:PURE_TAVERN_ALLOWED_ORIGINS = "http://127.0.0.1:8899,http://localhost:8899"
$env:PURE_TAVERN_PROXY_HOST = "0.0.0.0"
$env:PURE_TAVERN_PROXY_PORT = "8000"
.\pure-tavern-remote-server.exe
```

## Linux / macOS 启动

```bash
chmod +x ./pure-tavern-remote-server
export PURE_TAVERN_PROXY_KEY='请替换为足够长的随机字符串'
export PURE_TAVERN_ALLOWED_ORIGINS='http://127.0.0.1:8899,http://localhost:8899'
export PURE_TAVERN_PROXY_HOST='0.0.0.0'
export PURE_TAVERN_PROXY_PORT='8000'
./pure-tavern-remote-server
```

前端“远程后端调用”的 URL 填 `http://<后端电脑局域网 IPv4>:8000`，Key 填 `PURE_TAVERN_PROXY_KEY`。

## 从源码运行和构建

要求 Go 1.23 或更高版本。

```powershell
cd apps/remote-server
pnpm start:go
pnpm check:go
pnpm test:go
pnpm build:go
```

`pnpm build:go` 会把带当前项目版本和 Git commit 的文件输出到 `apps/remote-server/go/bin/`。

直接构建当前平台的单文件：

```powershell
cd apps/remote-server/go
go build -trimpath -ldflags "-s -w" -o pure-tavern-remote-server.exe .
```

CI 使用 `CGO_ENABLED=0` 并通过 `-ldflags` 注入版本与 commit，因此发布产物可以直接复制运行。

## 配置

| 环境变量                      | 默认值    | 说明                                      |
| ----------------------------- | --------- | ----------------------------------------- |
| `PURE_TAVERN_PROXY_KEY`       | 无        | 必填；未设置时拒绝启动                    |
| `PURE_TAVERN_ALLOWED_ORIGINS` | `*`       | 逗号分隔的 Web Origin；生产环境应显式限制 |
| `PURE_TAVERN_PROXY_HOST`      | `0.0.0.0` | 监听地址                                  |
| `PURE_TAVERN_PROXY_PORT`      | `8000`    | 监听端口                                  |

## 实现特性

- Bearer Key 使用固定时间摘要比较；
- CORS 与 Private Network Access 预检；
- GET/POST envelope 严格校验和脱敏错误；
- SSE 每个读取块主动 Flush；
- 浏览器断开后通过 request context 取消上游；
- 跨 Origin 重定向移除 Authorization、Cookie 和 Proxy-Authorization；
- 过滤 Host、Content-Length、hop-by-hop、Set-Cookie 和上游 CORS 标头；
- 不保存、不记录 Provider Key 和请求体。

该服务允许访问任意 HTTP/HTTPS 与私有网络地址。不要将它作为无鉴权开放代理暴露到公网；生产部署应同时使用 HTTPS、防火墙和受限 Origin。HTTP 不加密代理访问 Key、Provider Key、提示词或响应，仅应用于可信测试局域网。
