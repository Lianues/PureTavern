# Legacy-first UI 与长期兼容层策略

## 1. 当前决策

新工程使用 Vue 3、Vite、TypeScript 和 IndexedDB，但产品根入口由 **SillyTavern 原版页面长期负责 DOM 与交互**。这不是临时静态预览，也不再把“整体 Vue 重写原版 UI”作为默认终点。

```text
浏览器访问 /
└─ 生成的原版 index.html
   ├─ 原版 HTML / CSS / 静态资源
   ├─ Pure Tavern Hook（唯一注入点）
   ├─ 原版 jQuery / lib.js / script.js / scripts/**
   └─ Hook 提供的最小启动兼容响应

浏览器访问 /modern.html
└─ Vue 3 现代模块与诊断入口
```

这取代了早期“禁用脚本的 iframe 静态预览”方案。静态预览能显示页面，但无法保留按钮、抽屉、弹窗和设置控件的原版行为，不符合“尽量保留旧版 UI 和交互”的迁移目标。Vue 只用于隔离的新页面、新能力或完成所有权切换后的功能岛；原版 DOM 不允许被 Vue 和 jQuery/上游 ESM 同时管理。

当前浏览器测试已经确认：

- 原版 CSS、jQuery、`lib.js`、`script.js` 和模块脚本正常加载；
- 关键 DOM 锚点、运行时全局对象、原版模块导入、事件系统和扩展上下文入口可用；
- 原版初始化流程能移除 `#preloader`；
- 左侧配置抽屉、右侧角色抽屉和世界书抽屉由原版事件处理器完成打开与关闭；
- 旧启动请求由 Hook 在浏览器内处理，不要求启动 SillyTavern Node 服务端；
- 当前没有角色、聊天、世界书等真实接口迁移。

## 2. 目录和文件所有权

```text
apps/web/
├─ legacy/
│  ├─ upstream/
│  │  ├─ public/**             # 完整、只读的上游 public 快照
│  │  └─ default/content/**    # 启动需要的上游默认内容
│  ├─ contracts/               # 版本化 Legacy 兼容契约基线
│  ├─ legacy-files.sha256      # public 文件哈希清单
│  ├─ upstream.json            # 上游版本与来源元数据
│  └─ reports/                 # 每次正式同步的差异报告
├─ .generated/public/**        # 每次 dev/build 前生成，不提交
├─ index.html                  # 注入 Hook 后的原版首页，不提交
├─ modern.html                 # Vue 入口
├─ scripts/
│  ├─ sync-legacy.mjs
│  ├─ prepare-legacy-runtime.mjs
│  ├─ legacy-contracts.mjs
│  ├─ verify-legacy.mjs
│  └─ verify-browser-startup.mjs
└─ src/
   ├─ legacy-hook/**           # 我方兼容代码
   ├─ infrastructure/**        # IndexedDB 等新基础设施
   └─ features/**              # 后续按模块增加的新功能
```

所有权规则：

1. `legacy/upstream/**` 是上游只读快照，禁止直接编辑、格式化或重构。
2. 我方代码只进入 `src/legacy-hook/**`、新模块目录或构建脚本。
3. `index.html` 和 `.generated/**` 都是派生物，任何手工修改都会在下次启动时丢失。
4. 上游快照不参加 ESLint/Prettier；哈希清单负责检查误改。
5. 不在原版文件里散落 patch，避免升级时人工合并数百个文件。
6. 允许改动的优先级是：上游公开函数/导出/事件 → Pure Tavern Hook → 独立 CSS 或版本化 patch；禁止直接修改 `legacy/upstream/**`。
7. Vue 只能挂载到隔离页面或明确移交所有权的功能岛，不能接管仍由原版 jQuery/ESM 控制的 DOM 子树。

## 3. 运行时生成过程

`pnpm dev` 和 `pnpm build` 会先运行 `prepare-legacy-runtime.mjs`：

1. 读取原样保存的 `legacy/upstream/public/index.html`；
2. 在原版 `lib/polyfill.js` 之前插入唯一的 Hook 模块标签；
3. 将结果写为被忽略的开发首页，并复制到生产静态资源根目录；
4. 将原版 public 资源复制到 `.generated/public`；
5. 把原版 `lib.js` 的 npm imports 打包成浏览器可执行 ESM；
6. 把我方 TypeScript Hook 打包成独立的 `/__pure_tavern/legacy-hook.js`；
7. 准备默认设置、默认头像、背景和上游版本元数据；
8. Vite 以 `.generated/public` 为静态资源根目录启动；生产构建只编译 `modern.html`，原版首页保持静态复制，避免 Vite 重写上游 HTML。

Hook 注入使用稳定的 `lib/polyfill.js` 标签作为锚点，并要求它恰好出现一次。若新上游修改了该锚点，同步会在覆盖当前快照前失败，要求人工审阅，而不是生成不确定的页面。

## 4. 兼容契约基线

`apps/web/legacy/contracts/1.18.0.json` 是当前上游版本的长期兼容契约基线，由 `legacy-contracts.mjs` 从只读快照生成。契约分为三类：

- **UI 必需**：关键 DOM ID、首页脚本/样式入口和原版交互锚点；
- **扩展生态必需**：扩展面板 DOM、`scripts/extensions.js`、`scripts/extensions/**`、关键模块导出、事件名和运行时全局对象；
- **数据能力**：Settings get/save 与 snapshots 标记为浏览器就绪；其余启动请求继续标记为 Bootstrap Compatibility，不代表角色、聊天、世界书或扩展业务已经迁移。

`pnpm legacy:contracts:generate` 只生成契约 JSON，不写回上游目录。`pnpm legacy:contracts:check --source <新上游> --version <版本>` 会报告 added/removed/changed；关键契约破坏时返回非零状态。

## 5. Hook 边界

Hook 必须在原版主模块执行前安装。当前职责仅有：

- 初始化 IndexedDB schema v3；
- 包装同源 `fetch`；
- 将原版 settings get/save 与 snapshot 路径桥接到 Settings Use Case 与 IndexedDB；
- 对其余启动阶段必需路径返回固定空数据或安全默认值；
- 记录已处理请求和未处理路径；
- 暴露 `globalThis.__PURE_TAVERN__` 诊断信息；
- 读取同步工具生成的上游版本元数据。

当前 Settings 已是浏览器能力：首次使用上游默认设置初始化，原版 `/api/settings/get` 与 `/api/settings/save` 通过 Port/Adapter 在 IndexedDB 中读取和全量写入；原版快照弹窗通过 `settingsSnapshots` 完成列表、创建、内容预览和恢复。IndexedDB 不可用时两类仓库分别降级为页面会话内存存储。

空角色列表、空群组列表、空世界书列表、默认头像、空背景、空最近聊天和离线 Horde 状态等仍属于 **Bootstrap Compatibility Contract**，只用于让原版 UI 完成初始化。除 Settings 核心文档与快照外，它们不代表对应接口已经迁移：

- 不持久化真实角色或聊天；
- 不实现角色卡导入导出；
- 不实现模型请求；
- 不把旧 `/api` 当成新架构的正式接口；
- 不让新 Vue 代码依赖这些伪 HTTP 路径。

当某个功能正式迁移时，才为该模块定义 Port、领域模型、IndexedDB Adapter 和可选后端 Adapter，然后逐步撤销对应 Legacy 兼容路径。

## 6. 保留原版交互的原则

当前阶段不在 Vue 中重新实现原版按钮。原版 DOM 应继续由原版脚本拥有：

```text
原版按钮 / DOM
  → 原版 jQuery 或 ESM 事件处理器
  → Legacy Hook（仅在需要数据能力时介入）
  → Settings 与 snapshots 已转发到浏览器 Use Case；其他模块暂为空响应
  → 未来可按 Port 切换浏览器或可选后端 Adapter
```

这样可以保证：

- 页面布局和控件行为尽量接近对应上游版本；
- 上游新增按钮、HTML、CSS 和事件代码可以随快照一起升级；
- 我方 Hook 不需要为每个纯 UI 操作复制事件处理器；
- 删除某个尚未迁移模块时，可以通过 Hook/Capability 降级，而不是改乱整份上游脚本。

禁止同时让 Vue 和原版 jQuery 管理同一个 DOM 子树。后续 Vue 功能岛必须有明确挂载点和所有权切换步骤。

## 7. 上游升级流程

升级前先保留干净的新上游源码目录，例如 `SillyTavern-1.19.0/`。

### 7.1 只读检查

```powershell
pnpm legacy:sync:check --source "F:\path\SillyTavern-1.19.0" --version 1.19.0
```

该命令不会写入快照，会先输出文件差异，再输出嵌入的 `contracts` 契约差异：

- 新增、删除、变化的文件；
- `index.html` 是否变化；
- 新增或变化的 JavaScript；
- 新增扩展目录；
- Hook 注入锚点是否兼容；
- 默认设置、头像、背景和 `lib.js` 是否齐全；
- DOM ID、资源入口、扩展模块路径、关键模块导出、事件名和值、启动兼容请求的 added/removed/changed。

重点审阅 `index.html`、`script.js`、`scripts/**`、`lib.js`、新增扩展和 `contracts.risks`。HTML 新按钮通常会随完整快照自动进入运行时，但若它要求新的启动请求，浏览器测试会把路径记录到 `unhandledEndpoints`。

### 7.2 正式同步

```powershell
pnpm legacy:sync --source "F:\path\SillyTavern-1.19.0" --version 1.19.0
```

正式同步会整体替换只读快照、默认内容、哈希清单和版本元数据，并生成差异报告；它不会修改 `src/legacy-hook/**`。接受新上游后，运行 `pnpm legacy:contracts:generate` 生成对应版本的新契约基线并随同步结果一起提交。

### 7.3 同步后验证

```powershell
pnpm legacy:contracts:generate
pnpm legacy:verify
pnpm legacy:contracts:check
pnpm typecheck
pnpm test
pnpm build

# 终端 A
pnpm dev

# 终端 B
pnpm test:browser
```

浏览器测试至少验证：

- Hook、IndexedDB 和上游元数据已就绪；
- 原版 CSS 和主脚本成功加载；
- 关键 DOM 锚点、运行时全局对象、原版模块导入、事件系统和扩展上下文入口可用；
- 原版启动结束并移除 preloader；
- 没有本地资源 404、运行时异常或控制台错误；
- 没有兼容请求意外进入网络；
- 没有未处理的启动路径；
- 代表性的左右抽屉和世界书抽屉可打开并再次关闭；
- 原版 `#fast_ui_mode` 通过原版防抖保存写入 IndexedDB，刷新后恢复；
- 原版账户/设置快照弹窗完成创建、预览、恢复并自动刷新到快照值。

若测试发现新的 `unhandledEndpoints`，只补充完成 UI 启动所需的最小空响应；不要借升级之机一次性迁移真实业务接口。

## 8. CSS 与资源策略

当前根页面直接使用上游 CSS，因此原版选择器、变量、字体和媒体查询全部保留。新 Vue 页面不应全局导入这些样式。

迁移单个功能岛时：

- 先记录它依赖的 CSS 变量、全局类和响应式规则；
- 为新组件复制最小必要样式或建立明确 token；
- 不让新组件依赖无关的上游 DOM 层级；
- 使用桌面与移动视觉回归验证所有权切换；
- 未迁移区域仍由上游 CSS 控制。

## 9. 安全与限制

原版 JavaScript 现在会在主页面上下文执行，这是保留原版交互的必要条件，也意味着它能访问页面、浏览器存储和 Hook。当前快照必须视为受信任的固定上游代码；第三方扩展不能在没有权限模型的情况下自动启用。

Hook 对未知同源 `/api/**` 返回 `501` 并记录诊断，不会静默转发到不存在的 Node 服务。外部请求和普通静态资源仍交给浏览器原生 `fetch`。

## 10. 许可证和来源

SillyTavern 1.18.0 标记为 AGPL-3.0。由于当前方案复制并执行原始 HTML、CSS、JavaScript 和静态资源：

- 保留上游 LICENSE 和来源说明；
- 保留版本、同步时间与哈希清单；
- 不移除原始版权信息；
- 发布前继续审计单独资源和 npm 依赖许可证；
- 项目最终许可证必须与实际复用范围一致。

本文只记录工程约束，不构成法律意见。
