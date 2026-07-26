# Legacy Hook entry

此目录只保留注入原版页面之前执行的最小启动入口：

- `bootstrap.ts` 安装通用 Compatibility Router；
- 注册真正的核心启动兼容路径；
- 通过 `features/registry.ts` 安装各功能模块；
- 初始化固定 records/blobs 存储平台；
- 暴露 `globalThis.__PURE_TAVERN__` 聚合诊断；
- 在移动端放宽原版文件输入的 `accept`（`platform/runtime/legacy-file-accept.ts`），否则 `.jsonl` 等无 MIME 映射的扩展名在系统选择器里选不中；
- 通过构建 ID、`runtime-version.json` 和运行时 watcher 检测新部署，版本变化时自动刷新一次并防止刷新循环。

功能代码禁止继续加入本目录。每个模块必须把装配、Repository、Legacy routes、契约声明和测试放在 `src/features/<module>/**`。

Cloudflare Pages 的首页与 `runtime-version.json` 保持 `no-store`，用于发现新部署。构建在 `<head>` 最前方注入阻塞式 Build marker；现有根 Assets Service Worker 以 `pure-tavern-runtime-<buildId>` 缓存 JS/CSS/字体/静态配置。同一 Build 后续加载直接命中 CacheStorage，不逐文件 ETag 校验；新 marker 先切换命名空间，新 Worker 激活后清理旧缓存。原版 ES Module URL 不添加查询参数，避免同一模块产生重复实例。此机制只更新代码缓存，不清除 IndexedDB 业务数据。

模块诊断统一位于：

```js
globalThis.__PURE_TAVERN__.features['import-export'];
globalThis.__PURE_TAVERN__.features.settings;
globalThis.__PURE_TAVERN__.features.secrets;
globalThis.__PURE_TAVERN__.features.generation;
globalThis.__PURE_TAVERN__.features.assets;
globalThis.__PURE_TAVERN__.features.personas;
globalThis.__PURE_TAVERN__.features.characters;
globalThis.__PURE_TAVERN__.features.chats;
globalThis.__PURE_TAVERN__.features.stats;
globalThis.__PURE_TAVERN__.features['world-books'];
globalThis.__PURE_TAVERN__.features.presets;
globalThis.__PURE_TAVERN__.features.extensions;
globalThis.__PURE_TAVERN__.features.tokenizers;
```

未迁移的核心兼容路径仍由 `platform/legacy/register-core-routes.ts` 返回空数据或安全默认值；迁移后由对应 Feature 注册同 method/path 覆盖 placeholder，并由模块自己的 contract 声明真实状态。
