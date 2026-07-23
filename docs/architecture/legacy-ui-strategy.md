# Legacy UI 隔离与渐进迁移策略

## 1. 决策

新应用使用 Vue 3、Vite 和 TypeScript。SillyTavern 1.18.0 的前端文件作为 Legacy 来源完整保留，但不直接成为新功能代码的维护位置。

当前阶段采用以下结构：

```text
Vue Application Shell
└─ LegacyUiView
   ├─ fetch /legacy/index.html
   ├─ 内存中重写 base 并移除 script 标签
   └─ sandbox iframe srcdoc + /legacy 原始静态资源
```

Vue Host 会读取原始 `index.html`，仅在内存副本中把 `<base href="/">` 改成 `/legacy/` 并删除所有 `<script>` 标签，然后交给 iframe 的 `srcdoc`。iframe 仍不授予 `allow-scripts`，作为第二层保护。这样旧页面不会发起脚本、CSRF 或 API 请求，也不会产生大量 sandbox blocked-script 控制台警告。

## 2. 为什么先使用 iframe

原始 `public/index.html` 超过 8,200 行，`public/script.js` 接近 500 KB；页面使用 jQuery、原生模块、全局状态和大量直接 DOM 操作。直接将 Vue 挂到同一棵 DOM 树会造成双重 DOM 所有权，难以判断问题来自旧代码还是 Vue。

初期 iframe 可以提供：

- 原始 HTML/CSS/字体/图片文件保持不变；
- 通过内存中的 `/legacy/` base 修复原项目根路径假设；
- Legacy JavaScript 与 Vue 运行时隔离；
- 不需要临时实现数百个旧 API；
- 后续可以对比旧 UI 与新 Vue 功能岛；
- 删除某个迁移模块时不会破坏 Legacy 原文件。

iframe 只是迁移脚手架，不是最终产品架构。

## 3. Legacy 文件规则

Legacy 运行快照位于：

```text
apps/web/public/legacy/**
```

规则：

1. 从 `SillyTavern-1.18.0/public/**` 完整复制。
2. 不在该目录直接修复、格式化或重构代码。
3. 不对 Legacy 文件运行新项目的 ESLint/Prettier。
4. 使用 SHA-256 清单检查误改。
5. 必要兼容行为必须写在 `apps/web/src/legacy-host/**`。
6. 新业务功能禁止写入 Legacy 目录。
7. 上游许可证和来源说明必须随副本保留。

如果确实需要修改旧逻辑，优先级为：

1. Vue Host 外部补丁；
2. Legacy Bridge；
3. 独立 patch 文件；
4. 最后才是生成一份有明确差异记录的 patched 文件。

禁止静默修改原始副本。

## 4. 当前静态预览行为

不执行旧 JavaScript 时，原页面的 `#preloader` 会覆盖整个页面。Vue Host 会在 srcdoc iframe `load` 后访问同源文档，将 `#preloader` 隐藏。

原页面还包含 `<base href="/">`。若直接加载 `/legacy/index.html`，浏览器会错误地从 `/style.css`、`/lib/*` 和 `/script.js` 请求资源。因此 Host 只在内存文档中把 base 改为 `/legacy/`；原文件和 SHA-256 不发生变化。

这属于外部显示补丁：

- 不修改原始 `index.html`；
- 只修改运行时内存副本的 base，并移除 script 标签；
- 不模拟设置、角色或聊天数据；
- 不注册按钮事件；
- 不执行 `/api` 请求；
- 只让静态 UI 骨架可见。

页面中依赖运行时数据生成的区域为空是当前阶段的预期结果。

## 5. 后续迁移方式

每次迁移一个功能模块，执行以下步骤：

1. 记录模块对应的 Legacy DOM、JS、接口和数据格式。
2. 定义领域模型、Use Case 和 Port。
3. 完成浏览器 Adapter 和 IndexedDB migration。
4. 在 Vue 应用外层实现新的功能岛。
5. 用契约测试确认新实现的行为。
6. 从主页面切换到 Vue 功能岛。
7. 保留 Legacy 对照入口，直到验收完成。
8. 删除该模块的 Legacy Bridge，而不是修改其余模块。

最终目标：

```text
阶段 0：完整 Legacy iframe
阶段 1：Vue Shell + Legacy iframe
阶段 2：Vue 功能岛覆盖部分区域
阶段 3：Vue 主页面，Legacy 仅用于未迁移功能
阶段 4：移除 Legacy 运行入口，只保留格式兼容代码和历史来源
```

## 6. CSS 策略

迁移初期 CSS 只在 iframe 内生效，不污染 Vue Shell。

逐块迁移时：

- 保留必要的 SillyTavern CSS 自定义变量；
- 将模块样式复制到对应 Vue 组件或模块样式入口；
- 禁止新组件依赖不相关的全局选择器；
- 使用视觉回归测试保证桌面和移动布局；
- 最终整理通用 tokens、基础组件和主题系统。

## 7. JavaScript 兼容策略

当前阶段 Legacy JavaScript 完全禁用。

接口迁移开始后，如需短期复用旧模块，将通过显式 Bridge 调用，而不是直接恢复所有旧脚本。允许的临时形式：

```text
Legacy module
  → legacyFetch / Legacy Capability Bridge
  → Application Use Case
  → Port
  → Browser Adapter 或 Optional Backend Adapter
```

新的 Vue 代码禁止调用 `/api/...` 形式的本地伪接口。伪 HTTP 兼容只面向尚未迁移的 Legacy 代码。

## 8. 可删除模块约束

为了允许产品中途删除功能：

- Vue 路由由模块注册表提供；
- 模块菜单项由 Capability 动态出现；
- 跨模块引用使用可选 Capability；
- 模块数据库表由独立 migration 管理；
- 核心启动流程不得 import 非核心功能模块；
- 删除模块后应显示降级状态，而不是抛出启动异常。

例如删除向量模块后，提示词流水线只跳过 Memory Step；删除翻译模块后，消息菜单不显示翻译操作；二者都不能影响基本聊天。

## 9. 许可证和来源

SillyTavern 1.18.0 标记为 AGPL-3.0。当前策略会复制原始 HTML、CSS、JavaScript 和静态资源，因此：

- 保留上游 LICENSE；
- 保留版本和来源说明；
- 不移除原始版权信息；
- 发布前继续审计单独资源的许可证；
- 项目许可证决策必须与实际复用范围一致。

本文只记录工程约束，不构成法律意见。
