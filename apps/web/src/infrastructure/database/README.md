# IndexedDB infrastructure

当前 schema 版本为 2，包含：

- `meta`：数据库版本和应用级元数据；
- `moduleStates`：模块版本、迁移状态和诊断信息；
- `settings`：由 M03 Settings 模块拥有的完整 Legacy settings 文档。

schema v2 会从已有 v1 原地升级并保留 `meta`、`moduleStates` 数据。角色、聊天等后续功能表不会提前加入；每个功能模块必须通过自己的 migration 增加数据表，并记录删除和降级策略。

IndexedDB 初始化失败不会阻止 Legacy UI 启动。数据库状态写入 `document.documentElement.dataset.databaseState`；Settings Repository 会降级为页面会话内存存储，并通过 `globalThis.__PURE_TAVERN__.settingsStorage` 暴露诊断状态。
