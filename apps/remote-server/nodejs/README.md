# PureTavern Node.js 远程后端

这是不依赖第三方生产包的 Node.js 实现。Provider URL、Headers、Body、Claude/Gemini/OpenRouter 转换和响应解析仍由 PureTavern Web 前端完成；本服务只负责鉴权并流式转发最终 HTTP 请求。

普通 JSON 与 SSE 使用同一条增量转发管道，服务不会保存后端访问 Key、Provider Key 或请求内容。

## 要求

- Node.js 20 或更高版本；
- PureTavern 前端开发地址默认为 `http://127.0.0.1:8899`；
- 后端默认监听 `0.0.0.0:8000`。

## PowerShell 启动

```powershell
cd apps/remote-server
$env:PURE_TAVERN_PROXY_KEY = "请替换为足够长的随机字符串"
$env:PURE_TAVERN_ALLOWED_ORIGINS = "http://127.0.0.1:8899,http://localhost:8899"
$env:PURE_TAVERN_PROXY_HOST = "0.0.0.0"
$env:PURE_TAVERN_PROXY_PORT = "8000"
pnpm start:nodejs
```

也可以复制 `.env.example` 为 `.env`，然后直接使用 Node 的 env-file 支持：

```powershell
node --env-file=nodejs/.env nodejs/server.mjs
```

## Linux / macOS 启动

```bash
cd apps/remote-server
export PURE_TAVERN_PROXY_KEY='请替换为足够长的随机字符串'
export PURE_TAVERN_ALLOWED_ORIGINS='http://127.0.0.1:8899,http://localhost:8899'
export PURE_TAVERN_PROXY_HOST='0.0.0.0'
export PURE_TAVERN_PROXY_PORT='8000'
pnpm start:nodejs
```

前端“远程后端调用”的 URL 填：

```text
http://<后端电脑的局域网 IPv4>:8000
```

Key 填 `PURE_TAVERN_PROXY_KEY` 的值。

## API 与协议

- `GET /v1/health`：验证 Bearer Key，返回 `pure-tavern-generation-proxy` 协议版本；
- `POST /v1/proxy`：转发协议 v1 中的最终 GET/POST 请求；
- 两个接口都要求 `Authorization: Bearer <PURE_TAVERN_PROXY_KEY>`；
- SSE 和普通响应都保留上游状态码与安全响应标头；
- 跨 Origin 重定向会移除 Provider Authorization、Cookie 和 Proxy-Authorization。

## 配置

| 环境变量                      | 默认值    | 说明                                      |
| ----------------------------- | --------- | ----------------------------------------- |
| `PURE_TAVERN_PROXY_KEY`       | 无        | 必填；未设置时拒绝启动                    |
| `PURE_TAVERN_ALLOWED_ORIGINS` | `*`       | 逗号分隔的 Web Origin；生产环境应显式限制 |
| `PURE_TAVERN_PROXY_HOST`      | `0.0.0.0` | 监听地址                                  |
| `PURE_TAVERN_PROXY_PORT`      | `8000`    | 监听端口                                  |

## 安全边界

这是一个能够访问任意 HTTP/HTTPS 地址的受保护代理。请使用高强度访问 Key、HTTPS、防火墙和受限 Origin，不要把它作为无鉴权开放代理暴露到公网。拥有访问 Key 的用户等同于拥有该服务所在网络的代理访问能力。

服务会过滤 Host、Content-Length、hop-by-hop、Set-Cookie 和上游 CORS 标头，错误响应不会回显请求体或 Provider Key。外围反向代理和托管平台的日志仍需自行脱敏。

## 检查与测试

```powershell
pnpm check:nodejs
pnpm test:nodejs
```
