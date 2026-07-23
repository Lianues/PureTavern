# Pure Frontend Tavern

一个以浏览器本地能力为默认实现、可选连接后端增强能力的酒馆项目。

当前阶段只建立 Vue 3 应用壳、Legacy UI 静态隔离区和 IndexedDB 基础设施，不迁移 SillyTavern 的旧 API。

## 开发

```bash
pnpm install
pnpm dev
```

默认地址由 Vite 输出。启动 Web 应用不需要运行 `SillyTavern-1.18.0/server.js`。

## 常用命令

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm legacy:verify

# 先在另一个终端运行 pnpm dev，再执行真实浏览器启动检查
pnpm test:browser
```

## 目录

- `apps/web`：Vue 3 + Vite 浏览器应用。
- `apps/server`：可选后端占位；不是 Web 应用的运行依赖。
- `packages/contracts`：浏览器与可选后端共享的纯类型契约。
- `packages/shared`：与运行环境无关的通用代码。
- `docs/migration`：迁移模块清单和批次。
- `docs/architecture`：架构决策与 Legacy 隔离策略。
- `SillyTavern-1.18.0`：只读上游参考源码，不参与新项目构建。

## Legacy 许可

`apps/web/public/legacy` 来源于 SillyTavern 1.18.0，受其 AGPL-3.0 许可证及相关资源许可证约束。请参阅该目录内的 `UPSTREAM_LICENSE` 和 `UPSTREAM_SOURCE.md`。
