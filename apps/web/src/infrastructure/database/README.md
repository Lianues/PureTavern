# IndexedDB infrastructure

当前 schema 只包含：

- `meta`：数据库版本和应用级元数据。
- `moduleStates`：模块版本、迁移状态和诊断信息。

角色、聊天、设置等功能表不会提前加入核心 schema。每个功能模块必须通过自己的 migration 增加数据表，并在模块清单中记录删除和降级策略。

IndexedDB 初始化失败不会阻止 Legacy UI 静态预览启动；失败状态会写入 `document.documentElement.dataset.databaseState` 并输出控制台错误。
