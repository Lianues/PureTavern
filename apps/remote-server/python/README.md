# PureTavern Python 远程后端（代理版）

这是第一版可选远程后端。Provider 适配、请求体构造和响应解析仍在 PureTavern 前端完成；本服务只接收最终 HTTP 请求并转发给上游 LLM Provider，用于绕过浏览器 CORS 限制。它不会持久化后端 URL、访问 Key、Provider Key 或请求内容。

## API

- `GET /v1/health`：验证远程后端访问 Key，并返回代理协议版本。
- `POST /v1/proxy`：接收协议 v1 请求，转发 GET/POST，并原样流式返回普通响应或 SSE。

两个接口都要求：

```http
Authorization: Bearer <PURE_TAVERN_PROXY_KEY>
```

## 本机 / 局域网启动

要求 Python 3.11+。

```powershell
cd apps/remote-server/python
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:PURE_TAVERN_PROXY_KEY = "请替换为足够长的随机字符串"
$env:PURE_TAVERN_ALLOWED_ORIGINS = "http://127.0.0.1:8899,http://localhost:8899"
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

Linux/macOS：

```bash
cd apps/remote-server/python
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export PURE_TAVERN_PROXY_KEY='请替换为足够长的随机字符串'
export PURE_TAVERN_ALLOWED_ORIGINS='http://127.0.0.1:8899,http://localhost:8899'
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

查看后端电脑的局域网 IPv4 地址：

```powershell
ipconfig
```

然后在 PureTavern 的“API 连接配置”面板中：

1. 选择“远程后端调用”；
2. 点击右侧“远程配置”；
3. URL 填 `http://<后端电脑局域网 IPv4>:8000`；
4. Key 填 `PURE_TAVERN_PROXY_KEY` 的值；
5. 点击“连接”。

前端开发服务可用 `pnpm dev` 启动。若从其他设备访问 Vite，需要另行让 Vite 监听局域网地址；不要为了测试而把代理端口直接暴露到公网。

## CORS 配置

`PURE_TAVERN_ALLOWED_ORIGINS` 是逗号分隔的前端 Origin。开发阶段未设置时默认为 `*`，便于局域网联调；正式部署必须改为实际 HTTPS 站点，例如：

```text
PURE_TAVERN_ALLOWED_ORIGINS=https://tavern.example.com
```

服务会响应局域网预检所需的 `Access-Control-Allow-Private-Network`。但浏览器仍可能阻止 **HTTPS 网页 → HTTP 局域网后端** 的 Mixed Content/PNA 请求。正式 Web 部署应给该后端配置 HTTPS；HTTP 仅建议搭配本地 HTTP 开发站点测试。

## 安全边界

这是一个能够访问任意 HTTP/HTTPS 上游地址的受保护代理，因此：

- `PURE_TAVERN_PROXY_KEY` 必须设置，未设置时服务拒绝启动；
- 使用高强度随机 Key，并只分享给可信用户；
- 生产环境限制 `PURE_TAVERN_ALLOWED_ORIGINS`，同时使用防火墙、反向代理、HTTPS 和访问控制；
- 不要把它作为无鉴权开放代理暴露到公网；
- 本版本允许自定义 Provider 和局域网上游，因此没有封锁私有 IP；这也意味着拥有代理 Key 的用户具备服务端网络访问能力；
- 服务不记录请求体或密钥，但外围反向代理/平台日志仍需单独检查与脱敏。

## 测试

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q
```
