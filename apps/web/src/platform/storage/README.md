# Module storage platform

浏览器 IndexedDB 使用固定的通用容器，而不是按功能增加 Object Store：

```text
pure-frontend-tavern-modular-dev
├─ records   # JSON-safe 模块记录
└─ blobs     # 模块二进制数据与 JSON metadata
```

IndexedDB API 要求首次建库存在一个物理格式编号，因此 `app-database.ts` 内有一次固定的 `version(1)` 声明；它不是业务或模块版本，后续新增功能不修改它。

模块通过安装上下文获得已经限定命名空间的 Store：

```ts
install({ records, blobs }) {
  await records.put('documents', 'current', value);
  await blobs.put('avatars', id, avatarBlob);
}
```

最终 key 由平台组合为 `module / collection / id`。模块不能通过自己的 Store 访问其他模块记录。

## 开发期重置

本次从旧 prototype 专用表切换为新数据库名，按项目决策不迁移旧测试数据。以后增加模块、collection 或记录类型不需要数据库 schema migration。
