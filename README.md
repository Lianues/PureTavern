# Pure Frontend Tavern

一个以浏览器本地能力为默认实现、可选连接后端增强能力的酒馆项目。

当前阶段采用 **Legacy-first**：根页面运行原版 SillyTavern UI、CSS 和交互脚本，我方 Hook 只提供浏览器启动所需的固定空数据兼容响应。角色、聊天、模型等真实业务接口尚未迁移。

## 开发

```bash
pnpm install
pnpm dev
```

默认地址由 Vite 输出。Web 页面不需要运行 `SillyTavern-1.18.0/server.js`。

- `/`：原版 UI + 原版交互 + Pure Tavern Hook。
- `/modern.html`：Vue 3 现代模块/诊断入口。

## 常用命令

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm legacy:verify

# 先在另一个终端运行 pnpm dev，再执行真实浏览器启动与交互检查
pnpm test:browser
```

## 更新上游 UI

先进行不写文件的差异检查：

```powershell
pnpm legacy:sync:check --source "F:\path\SillyTavern-新版本" --version 新版本号
```

确认报告后正式同步：

```powershell
pnpm legacy:sync --source "F:\path\SillyTavern-新版本" --version 新版本号
```

同步会完整替换 `apps/web/legacy/upstream/**`，不会修改 `apps/web/src/legacy-hook/**`。详细流程和验收项见 [`docs/architecture/legacy-ui-strategy.md`](docs/architecture/legacy-ui-strategy.md)。

## 目录

- `apps/web`：浏览器应用、Legacy Hook、上游快照和升级工具。
- `apps/web/legacy/upstream/public`：只读 SillyTavern 前端快照，禁止直接编辑。
- `apps/web/src/legacy-hook`：我方独立兼容脚本。
- `apps/server`：可选后端占位；不是 Web 应用的运行依赖。
- `packages/contracts`：浏览器与可选后端共享的纯类型契约。
- `packages/shared`：与运行环境无关的通用代码。
- `docs/migration`：迁移模块清单和批次。
- `docs/architecture`：架构决策、Legacy-first 和升级策略。
- `SillyTavern-1.18.0`：本机只读参考源码，不参与新项目构建。

## Legacy 许可

`apps/web/legacy/upstream/public` 来源于 SillyTavern，受其 AGPL-3.0 许可证及相关资源许可证约束。请参阅该目录内的 `UPSTREAM_LICENSE` 和 `UPSTREAM_SOURCE.md`。
