# Legacy Hook Runtime

此目录是新项目与原版 SillyTavern UI 之间唯一允许的运行时接缝。

- 上游 HTML/CSS/JS 保持只读。
- `bootstrap.ts` 在原版主模块之前注入。
- 原版事件监听器、抽屉、弹窗和菜单继续由原版 JavaScript 驱动。
- 当前 `api-compat` 只提供让 UI 完成启动所需的空数据响应，不代表对应业务模块已经迁移。
- 未覆盖端点返回 501，并记录到 `globalThis.__PURE_TAVERN__.diagnostics`。
- 新模块必须通过 Port/Adapter 接入，禁止直接修改上游文件。
