# Pure Frontend Tavern

一个以浏览器本地能力为默认实现、可选连接后端增强能力的酒馆项目。

当前阶段采用 **Legacy-first**：根页面长期运行原版 SillyTavern UI、CSS 和交互脚本，我方 Hook 将原版能力桥接到浏览器实现。Settings、角色卡、单角色聊天、用户人格、世界书、预设、本地 Assets、明文 Secrets、浏览器直连 Chat Completion 和 trusted 内置扩展已接入浏览器模块；群聊、Text Completion/Novel/Horde/Kobold 与远程扩展安装等能力仍待迁移。Vue 仅用于隔离的新页面或完成所有权切换的新能力。

## 开发

```bash
pnpm install
pnpm dev
```

默认地址由 Vite 输出。Web 页面不需要运行 `SillyTavern-1.18.0/server.js`。

- `/`：原版 UI + 原版交互 + Pure Tavern Hook。
- `/modern.html`：Vue 3 现代模块/诊断入口。

## 当前浏览器能力

- Settings 与快照：原版 `/api/settings/*` 已桥接到 IndexedDB，首次从上游默认设置初始化，之后按完整 Legacy 文档语义保存和恢复。
- Characters：角色 CRUD、头像、重命名、复制以及 JSON/PNG Character Card V2/V3 导入导出已接入原版 UI。
- Chats：单角色聊天、消息、搜索、recent、重命名、删除和 JSONL/多格式导入导出已本地持久化；群聊仍属 M06。
- World Books：原版编辑器、导入、角色卡嵌入 lore 和原版匹配算法继续运行，文档由 M07 IndexedDB 模块提供。
- Presets：11 类提示词预设、主题、Moving UI 与快捷回复由独立 M09 模块管理，默认内容通过构建清单增量初始化，不再由 Settings 存储拥有。
- Assets：附件、用户图片、背景、persona 头像、sprites 与扩展资产使用通用 Blob/索引模块；共享 Service Worker 为原版 URL 提供本地资源响应。
- Personas：原版 Persona UI 继续使用 Settings 与头像接口；M08 负责 stable identity、默认/当前选择、角色绑定、opaque descriptor 和删除降级。
- Extensions：构建从当前 upstream 生成 trusted manifest，原版 loader 可发现和加载 14 个内置扩展；用户包默认使用权限受控的 iframe/Worker sandbox，远程 Git 操作明确需要可选后端。
- Prompt Pipeline：原版 `openai.js`、PromptManager、宏、作者注和世界书注入作为唯一权威实现长期保留；不维护功能重复的 TypeScript 副本，生成后的 `generate_data` 直接交给 M12。
- Tokenizers：原版同步/异步 tokenizer 路径统一桥接到 Web Worker/主线程 `tokenx` 近似计数；所有模型故意采用同一估算器，响应明确标记 `approximate`，pseudo token IDs 只用于 UI 兼容。
- Secrets：原版密钥管理器的多值保存、查看、查找、轮换、重命名和删除已桥接到 IndexedDB，并通过 CredentialResolver 为 M12 预留入口；密钥按产品决策明文保存，不是安全 Vault。
- Generation：仅迁移原版 Chat Completion，26 个 source 由 OpenAI-compatible、Anthropic、Google、Cohere 四类浏览器直连 Adapter 提供模型目录、非流式和 SSE；Provider 是否可达仍取决于其 CORS/TLS 策略。
- 各模块 IndexedDB 不可用时降级为当前页面会话内存存储，并在 `__PURE_TAVERN__.features.<module>` 下报告诊断状态。

## 常用命令

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm legacy:verify
pnpm legacy:contracts:check

# 先在另一个终端运行 pnpm dev，再执行真实浏览器启动与交互检查
pnpm test:browser
```

## 更新上游 UI

固定顺序：先看文件 diff，再看契约 diff，再构建和跑浏览器契约测试。

```powershell
# 1. 文件 diff + 嵌入式契约 diff（只读，不写快照）
pnpm legacy:sync:check --source "F:\path\SillyTavern-新版本" --version 新版本号

# 2. 如需单独查看契约 diff
pnpm legacy:contracts:check --source "F:\path\SillyTavern-新版本" --version 新版本号
```

确认报告后正式同步：

```powershell
pnpm legacy:sync --source "F:\path\SillyTavern-新版本" --version 新版本号
```

同步会完整替换 `apps/web/legacy/upstream/**`，不会修改 `apps/web/src/legacy-hook/**`。同步后执行：

```powershell
pnpm legacy:contracts:generate # 接受新上游后生成新的版本化基线
pnpm legacy:verify
pnpm legacy:contracts:check
pnpm build

# 终端 A：启动生产/开发页面
pnpm dev

# 终端 B：真实浏览器契约测试
pnpm test:browser
```

详细流程和验收项见 [`docs/architecture/legacy-ui-strategy.md`](docs/architecture/legacy-ui-strategy.md)、[`docs/architecture/legacy-compatibility-contract.md`](docs/architecture/legacy-compatibility-contract.md) 与 [`docs/architecture/feature-module-structure.md`](docs/architecture/feature-module-structure.md)。

## 目录

- `apps/web`：浏览器应用、Legacy Hook、上游快照和升级工具。
- `apps/web/legacy/upstream/public`：只读 SillyTavern 前端快照，禁止直接编辑。
- `apps/web/legacy/contracts`：版本化 Legacy 兼容契约基线。
- `apps/web/src/legacy-hook`：只保留注入启动入口。
- `apps/web/src/platform`：通用 Legacy Router、Feature Runtime 与 records/blobs 存储平台。
- `apps/web/src/features`：按模块聚合的装配、领域、存储、Legacy 路由、契约和测试。
- `apps/server`：可选后端占位；不是 Web 应用的运行依赖。
- `packages/contracts`：浏览器与可选后端共享的纯类型契约。
- `packages/shared`：与运行环境无关的通用代码。
- `docs/migration`：迁移模块清单和批次。
- `docs/architecture`：架构决策、Legacy-first 和升级策略。
- `SillyTavern-1.18.0`：本机只读参考源码，不参与新项目构建。

## Legacy 许可

`apps/web/legacy/upstream/public` 来源于 SillyTavern，受其 AGPL-3.0 许可证及相关资源许可证约束。请参阅该目录内的 `UPSTREAM_LICENSE` 和 `UPSTREAM_SOURCE.md`。
