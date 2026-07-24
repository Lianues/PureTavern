# PureTavern

PureTavern 是一个以 SillyTavern 为上游的第三方客户端，采用“纯前端 + 可选后端”的设计。

当前版本不依赖后端服务，可以直接部署到 Cloudflare Pages、GitHub Pages 或其他静态托管平台。可选后端接口已经在架构中预留，但尚未实现。

> PureTavern 是独立第三方项目，不是 SillyTavern 官方发行版。

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

## 浏览器限制

纯前端无法绕过目标服务的 CORS、TLS 和 Private Network Access 策略。当前密钥保存在浏览器本地，不应视为安全 Vault。

## 许可证

PureTavern 使用 [AGPL-3.0](./LICENSE) 许可证。

项目包含或衍生自 SillyTavern 的上游资源时，同时遵循对应的上游许可证和署名要求。
