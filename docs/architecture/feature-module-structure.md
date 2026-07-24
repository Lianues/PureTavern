# 功能模块聚合结构

## 目标

新增或优化一个能力时，开发者应从目录层级直接知道要修改哪里，不再同时搜索中央 Hook、数据库类型、API 路由和契约脚本。

标准结构：

```text
apps/web/src/features/<module>/
├─ module.ts                 # 唯一装配入口，注册 routes 与 diagnostics
├─ README.md                 # 能力边界、存储 collection、已知限制
├─ domain/                   # 实体、值对象、序列化约束
├─ application/              # Use Case / Service
├─ ports/                    # Repository / Gateway 接口
├─ infrastructure/          # records/blobs 或可选后端 Adapter
├─ legacy/
│  ├─ register-routes.ts     # 原版 `/api/**` 兼容入口
│  └─ contract.json          # 升级契约声明
└─ tests/                    # 模块单元与集成测试
```

## 新增模块步骤

1. 复制上述目录模板并实现 `FeatureModule`。
2. 在 `apps/web/src/features/registry.ts` 增加一行注册。
3. 模块通过 `install({ router, nativeFetch, records, blobs })` 获得通用能力。
4. 所有 Legacy 路径放进本模块 `legacy/register-routes.ts`。
5. 同一批路径在 `legacy/contract.json` 声明；契约工具会自动扫描聚合。
6. Repository 只使用当前模块已经限定命名空间的 `records` / `blobs`，不修改中央数据库。
7. 跨模块协作只注册/消费 `platform/features/standard-capabilities.ts` 中的类型化 Capability；禁止直接 import 另一模块的 Repository。
8. 必需的 Worker/静态文件由本模块 `runtime-assets.json` 声明；需要 npm 依赖的 Worker 可标记 `bundle: true`，由构建脚本统一打包，避免为每个模块修改中央复制逻辑。

除此之外，正常情况下不需要修改 `legacy-hook/bootstrap.ts`、`platform/storage/app-database.ts` 或中央契约请求数组。

## 模块安装示例

```ts
export const exampleFeature: FeatureModule = {
  id: 'example',
  install({ router, records, blobs }) {
    const repository = new ExampleRepository(records, blobs);
    const service = new ExampleService(repository);
    registerExampleLegacyRoutes(router, service);

    return {
      diagnostics: {
        storage: repository.diagnostics,
      },
    };
  },
};
```

模块诊断统一出现在：

```js
globalThis.__PURE_TAVERN__.features.example;
```

## 通用存储

平台仅定义两个固定 Object Store：

- `records`：JSON-safe 数据；
- `blobs`：Blob 和 JSON metadata。

Feature Runtime 会按模块 ID 创建作用域 Store。模块调用：

```ts
records.put('documents', 'current', value);
blobs.put('avatars', characterId, imageBlob);
```

平台内部组合 key：

```text
example / documents / current
example / avatars / characterId
```

增加 module、collection 或 record 类型不会改变 IndexedDB Object Store，因此没有按模块递增数据库 schema 的工作。

IndexedDB 标准仍要求首次创建时有一个物理格式编号；平台内部固定声明一次，不作为业务版本维护。

## 核心与模块边界

`platform/legacy/register-core-routes.ts` 提供尚未迁移能力的启动默认响应。Feature 在 core 之后安装，因此注册同一个 method/path 时会自动覆盖默认 handler；契约聚合也由 feature manifest 覆盖同 key 的 core 声明，不产生重复项。

当前跨模块示例：Settings 动态读取 World Names、Preset Bootstrap、Persona state 与 Extension enable-state capability；Characters 与 Chats 通过 stable identity / owner lifecycle capability 协作；Characters 复用 Assets 的共享 Service Worker；Personas 和本地 extension packages 分别复用 Assets 的 avatar/package capability。Prompt Pipeline candidate 只接受注入 provider，不 import World Books/Presets/Extensions 内部实现，并通过 Tokenizer Capability 使用 M15 的 `tokenx` 近似 estimator；未来 M12 只通过 CredentialResolver Capability 获取 M14 凭据，不直接读取 SecretStore。Capability 必须可选查询，并在 provider 缺失时提供明确降级。

某项能力开始迁移时只需：

1. 在对应 feature 中实现并注册同一路径；
2. 在 feature manifest 声明真实迁移状态；
3. 在 `features/registry.ts` 注册一行；
4. 增加模块测试和真实浏览器验收。

不要求同时编辑 core routes；后续可以集中清理已无用途的默认声明。上游 UI、DOM、CSS 和交互代码也不因此修改。
