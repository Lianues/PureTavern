# Legacy Hook entry

此目录只保留注入原版页面之前执行的最小启动入口：

- `bootstrap.ts` 安装通用 Compatibility Router；
- 注册真正的核心启动兼容路径；
- 通过 `features/registry.ts` 安装各功能模块；
- 初始化固定 records/blobs 存储平台；
- 暴露 `globalThis.__PURE_TAVERN__` 聚合诊断。

功能代码禁止继续加入本目录。每个模块必须把装配、Repository、Legacy routes、契约声明和测试放在 `src/features/<module>/**`。

模块诊断统一位于：

```js
globalThis.__PURE_TAVERN__.features.settings;
globalThis.__PURE_TAVERN__.features.assets;
globalThis.__PURE_TAVERN__.features.personas;
globalThis.__PURE_TAVERN__.features.characters;
globalThis.__PURE_TAVERN__.features.chats;
globalThis.__PURE_TAVERN__.features['world-books'];
globalThis.__PURE_TAVERN__.features.presets;
globalThis.__PURE_TAVERN__.features.extensions;
globalThis.__PURE_TAVERN__.features.tokenizers;
globalThis.__PURE_TAVERN__.features['prompt-pipeline'];
```

未迁移的核心兼容路径仍由 `platform/legacy/register-core-routes.ts` 返回空数据或安全默认值；迁移后由对应 Feature 注册同 method/path 覆盖 placeholder，并由模块自己的 contract 声明真实状态。
