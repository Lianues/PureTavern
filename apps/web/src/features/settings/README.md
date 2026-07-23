# Settings module

本目录完整拥有 M03 Settings 的浏览器实现。

```text
settings/
├─ module.ts                 # 唯一装配入口
├─ domain/                   # Settings 文档和 Snapshot 模型
├─ application/              # Use Case / Service
├─ infrastructure/           # 通用 records Store 的 Repository Adapter
├─ legacy/
│  ├─ register-routes.ts     # 原版 `/api/settings/**` 兼容路径
│  └─ contract.json          # 升级契约声明
├─ ports/                    # Repository Port
└─ tests/                    # 模块单元/集成测试
```

## 存储命名空间

模块注册 ID 为 `settings`，仅能访问自己的通用记录命名空间：

- `documents/current`：当前完整 Legacy settings 文档；
- `snapshots/<name>`：设置快照。

新增 Settings 逻辑不应修改中央数据库 Object Store。二进制能力如未来需要，可使用模块上下文提供的 Blob Store。

## 边界

- 原版 UI、事件和完整文档保存语义保持不变；
- 主题、上下文、指令、系统提示词、快捷回复等预设属于 M09；
- 多标签页仍遵循原版 last-writer-wins；
- IndexedDB 不可用时，Settings 与 Snapshot Repository 各自降级为页面会话内存存储。
