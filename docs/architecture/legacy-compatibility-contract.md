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

当前状态必须明确为：扩展 UI 基础与 14 个随 upstream snapshot 分发的 trusted built-ins 已恢复，`discover` 只暴露该构建清单。用户第三方包不进入原页面 loader，必须使用显式权限的 iframe/Worker sandbox；远程 Git 和 Node plugins 仍未迁移。

### 数据能力

记录 Hook 当前处理的 Legacy 请求，并明确区分已实现与待迁移能力：

- Settings 文档与快照标记为浏览器就绪，并保持原版完整文档/快照 DTO；
- Characters、单角色 Chats、World Books、Presets、Assets 与 trusted Extensions 的路径由各模块 manifest 覆盖 core placeholder，标记对应 browser-ready 状态；
- Personas 没有专属 API，通过 Settings provider/composer 和 Assets capability 接入，因此模块 contract 记录 bridge 而非伪造请求；
- Prompt Pipeline candidate 没有 Legacy API，当前保持 `ownership=legacy` 与 `replacementEnabled=false`；
- Tokenizers 的 35 条 Legacy 路径由 M15 feature manifest 覆盖，使用统一 `tokenx` 近似计数并明确报告 `approximate`，不等价于模型专用 tokenizer；
- `/csrf-token`、`/version`、`/api/users/me` 等仍是 UI 启动固定兼容响应；
- 群组、Horde、Secrets、远程 Git 扩展操作和丢弃式 stats 等仍是空数据、安全默认或明确降级响应。

契约 schema v2 使用 `dataCapabilities` 分类。标记为 `bootstrap-compatibility-only`、`bootstrap-empty-response-not-migrated`、`extension-loading-disabled` 或其他明确降级状态的路径都不是已完成业务能力；是否迁移以 feature manifest 的 `migrationStatus` 为准。

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

- Hook、IndexedDB、各已迁移 Feature Storage、共享 Assets Worker 和上游版本元数据就绪；
- 原版 CSS、`lib.js`、`script.js` 加载；
- jQuery 与关键上游全局对象存在；
- `script.js`、`scripts/events.js`、`scripts/extensions.js` 等模块可动态导入且关键导出存在；
- `eventSource` 可注册、触发和移除监听器；
- 扩展上下文入口、扩展设置对象和 14 个 trusted built-ins 由原版 loader 加载；用户第三方扩展不进入 same-context；
- 关键 DOM 锚点存在；
- 左右抽屉、世界书抽屉可打开并关闭；
- 原版 `#fast_ui_mode` 触发原版防抖保存，IndexedDB 记录与刷新后的控件状态一致；
- 原版账户/快照弹窗完成创建、内容预览、再次修改、确认恢复和自动刷新闭环；
- 原版 Characters 完成头像、CRUD、重命名/复制、JSON/PNG 导入导出与 embedded lore；
- 原版单角色 Chats 完成消息、附件、刷新恢复、搜索/recent、重命名和 JSONL 导入导出；
- 原版 World Books 编辑器与 matcher 完成 CRUD、导入、关键词/constant/disabled 和 opaque 字段验证；
- Presets 完成 11 类默认种子、原版 selector、PresetManager CRUD/恢复以及 theme/Quick Reply/Moving UI；
- Assets 完成背景、文件夹、附件、用户图片/persona、sprites、library、extension package 与共享 Worker 直接 URL；
- Personas 完成原版头像上传、创建、选择、默认、角色绑定、刷新恢复、删除和本地身份降级；
- Extensions 完成 trusted discover/manifest/script/style、version 与原版 disable/enable 的 Settings/registry 同步；
- Prompt Pipeline candidate 就绪，但真实 Chrome 明确验证原版 prepare 函数仍为权威且替换关闭；
- Tokenizers 通过原版同步/异步调用验证全部 alias 的统一计数、OpenAI/remote count、Worker backend、pseudo decode 往返以及 M10 approximate estimator；
- 本地资源无 404、运行时无异常、控制台无错误、启动兼容请求不进入网络。

测试使用临时浏览器 Profile 创建并清理模块验收数据；结束后删除整个 Profile，不污染开发者的浏览器数据。

## 5. 升级风险处理

静态契约只能证明“上游兼容面相比基线如何变化”，不能证明所有第三方扩展都可运行。升级时：

1. 先审阅 `legacy:sync:check` 的文件 diff；
2. 再审阅 `contracts` 报告中的 critical/warning；
3. 只有确认契约变化可接受后才正式同步快照；
4. 正式接受新上游后运行 `pnpm legacy:contracts:generate`，提交对应版本的新基线；
5. 若浏览器测试发现新的启动请求，只补充页面启动所需的最小空响应；
6. 真实业务能力必须按模块定义 Port、领域模型、IndexedDB Adapter 和测试后再迁移。
