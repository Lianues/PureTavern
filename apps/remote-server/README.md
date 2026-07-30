# PureTavern Remote Server

此目录存放 PureTavern 的可选远程后端实现。`apps/web` 默认保持纯前端运行，不依赖这里的服务才能启动、构建或保存本地数据。

当前实现：

- [`python`](./python)：带访问 Key 鉴权、CORS/PNA 支持及 SSE 流式透传的聊天补全 HTTP 代理。

未来其他语言或部署方式可以继续作为独立子目录加入，不与 Web 应用耦合。

## Python 快速验证

```bash
pnpm --filter @pure-tavern/remote-server check:python
pnpm --filter @pure-tavern/remote-server test:python
```

安装、局域网启动、HTTPS 与安全配置见 [`python/README.md`](./python/README.md)。
