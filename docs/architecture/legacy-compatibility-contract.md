# SillyTavern 兼容契约基线

> 状态：1.18.0 基线已固化  
> 基线文件：`apps/web/legacy/contracts/1.18.0.json`  
> 适用范围：根页面 `/` 的原版 SillyTavern UI、DOM、CSS、jQuery/ESM 交互和扩展生态入口。

## 1. 架构决策

Pure Tavern 将 SillyTavern 原版 UI/交互作为长期保留的上游兼容层，而不是把 Vue 重写设为默认终点：

- `/` 继续运行生成后的原版 `index.html`、原版 DOM、原版 CSS、jQuery 插件、`lib.js`、`script.js` 和 `scripts/**` 模块。
- Pure Tavern 只通过唯一 Hook 注入点提供启动兼容、诊断和未来可迁移的数据能力桥接。
- Vue 只用于 `/modern.html`、隔离的新页面或经过所有权切换的独立功能岛。
- 同一个 DOM 子树不得同时由 Vue 和原版 jQuery/ESM 事件处理器管理。

允许改动的优先级为：

1. 使用上游已有公开函数、模块导出、事件和 DOM 锚点；
2. 通过 `src/legacy-hook/**` 拦截启动请求或桥接能力；
3. 增加独立 CSS、独立模块或版本化 patch；
4. 如确需改上游文件，必须先形成可复核的版本化 patch；禁止直接编辑 `apps/web/legacy/upstream/**`。

## 2. 契约分类

`1.18.0.json` 将兼容面分为三类，避免把“能启动”误判为业务已迁移。核心声明来自契约工具，已迁移模块的路径由 `src/features/*/legacy/contract.json` 自动聚合。

### UI 必需

记录原版页面启动和代表性交互依赖的内容：

- 全量 DOM `id` 清单；
- 关键 DOM 锚点，如 `#send_textarea`、`#left-nav-panel`、`#right-nav-panel`、`#WorldInfo`；
- 首页脚本入口和样式入口；
- 关键脚本/样式是否存在，如 `lib/polyfill.js`、`lib.js`、`script.js`、`style.css`。

这些契约用于保证原版布局、抽屉、输入区、弹窗和设置面板仍由上游代码驱动。

### 扩展生态必需

记录扩展生态需要长期保留的静态入口：

- 扩展设置面板和内置扩展容器 DOM；
- `scripts/extensions.js` 与 `scripts/extensions/**` 模块路径；
- `scripts/events.js` 的事件名和值；
- `script.js`、`scripts/extensions.js`、`scripts/st-context.js` 等关键模块导出；
- 上游运行时全局对象，如 `SillyTavern`、`DOMPurify`、`Handlebars`、`Fuse` 和 jQuery 相关对象等。

当前状态必须明确为：扩展 UI 基础仍在，扩展发现接口返回空列表，第三方扩展加载未启用。契约保留入口，不等于恢复了完整第三方扩展运行能力。

### 数据能力

记录 Hook 当前处理的 Legacy 请求，并明确区分已实现与待迁移能力：

- `/api/settings/get`、`/api/settings/save` 标记为 `browser-ready-core-settings`，通过 Settings Port 在 IndexedDB 中持久化完整 settings 文档；
- 四条 `/api/settings/*-snapshot*` 路径标记为 `browser-ready-settings-snapshots`，支持原版快照列表、创建、文本预览与恢复；
- `/csrf-token`、`/version`、`/api/users/me` 等仍是 UI 启动固定兼容响应；
- `/api/characters/all`、`/api/chats/recent`、`/api/worldinfo/list` 等仍是空数据响应；
- 扩展相关的 `/api/extensions/discover`、`/api/secrets/*` 仍为空或安全默认响应。

契约 schema v2 使用 `dataCapabilities` 分类。除 Settings 核心文档与快照外，标记为 `bootstrap-compatibility-only`、`bootstrap-empty-response-not-migrated` 或 `extension-loading-disabled` 的路径都不是已完成业务能力。

## 3. 工具命令

生成当前快照的版本化契约：

```powershell
pnpm legacy:contracts:generate
```

针对新上游源码做只读契约比较：

```powershell
pnpm legacy:contracts:check --source "F:\path\SillyTavern-1.19.0" --version 1.19.0
```

`check` 会生成候选契约并与已提交基线比较，报告 `added`、`removed`、`changed` 和风险等级。关键 DOM、关键脚本/样式、关键模块导出、事件名/值或扩展核心模块被破坏时返回非零状态。

`legacy:sync:check` 已在文件差异报告之后嵌入同一份契约报告，因此升级时固定顺序是先看文件差异，再看契约差异。新增模块不需要编辑中央请求数组，只维护本模块 manifest。

## 4. 浏览器契约验证

`pnpm test:browser` 在真实 Chrome/Edge 中验证：

- Hook、IndexedDB、Settings/Snapshot Storage 和上游版本元数据就绪；
- 原版 CSS、`lib.js`、`script.js` 加载；
- jQuery 与关键上游全局对象存在；
- `script.js`、`scripts/events.js`、`scripts/extensions.js` 等模块可动态导入且关键导出存在；
- `eventSource` 可注册、触发和移除监听器；
- 扩展上下文入口和扩展设置对象存在，但不启用第三方扩展；
- 关键 DOM 锚点存在；
- 左右抽屉、世界书抽屉可打开并关闭；
- 原版 `#fast_ui_mode` 触发原版防抖保存，IndexedDB 记录与刷新后的控件状态一致；
- 原版账户/快照弹窗完成创建、内容预览、再次修改、确认恢复和自动刷新闭环；
- 本地资源无 404、运行时无异常、控制台无错误、启动兼容请求不进入网络。

测试会在临时浏览器 Profile 中保存一个设置布尔值和一份设置快照；不会保存真实角色、聊天或世界书数据，测试结束后整个 Profile 会删除。

## 5. 升级风险处理

静态契约只能证明“上游兼容面相比基线如何变化”，不能证明所有第三方扩展都可运行。升级时：

1. 先审阅 `legacy:sync:check` 的文件 diff；
2. 再审阅 `contracts` 报告中的 critical/warning；
3. 只有确认契约变化可接受后才正式同步快照；
4. 正式接受新上游后运行 `pnpm legacy:contracts:generate`，提交对应版本的新基线；
5. 若浏览器测试发现新的启动请求，只补充页面启动所需的最小空响应；
6. 真实业务能力必须按模块定义 Port、领域模型、IndexedDB Adapter 和测试后再迁移。
