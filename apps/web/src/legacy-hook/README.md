# Legacy Hook Runtime

此目录是新项目与原版 SillyTavern UI 之间唯一允许的运行时接缝。

- 上游 HTML/CSS/JS 保持只读。
- `bootstrap.ts` 在原版主模块之前注入。
- 原版事件监听器、抽屉、弹窗和菜单继续由原版 JavaScript 驱动。
- `/api/settings/get` 与 `/api/settings/save` 已通过 Settings Port 接入 IndexedDB；原版 UI 继续发送完整 settings 文档。
- 其他 `api-compat` 路径仍只提供让 UI 完成启动所需的空数据或安全默认响应，不代表对应业务模块已经迁移。
- 未覆盖端点返回 501，并记录到 `globalThis.__PURE_TAVERN__.diagnostics`。
- `globalThis.__PURE_TAVERN__.settingsStorage` 提供 IndexedDB/内存降级诊断。
- 新模块必须通过 Port/Adapter 接入，禁止直接修改上游文件。
