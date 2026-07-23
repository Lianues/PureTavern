# SillyTavern 前端迁移模块清单

> 状态：初始盘点 + Legacy 兼容契约基线  
> 参考版本：SillyTavern 1.18.0  
> 参考源码：`SillyTavern-1.18.0/`（只读参考，不作为新应用的运行依赖）  
> 契约基线：`apps/web/legacy/contracts/1.18.0.json`

## 1. 文档目的

本项目不会一次性重写 SillyTavern，也不再把原版 UI 的 Vue 重写作为默认终点。根页面的原版 DOM、CSS、jQuery 交互和上游 ESM 模块是长期兼容层；迁移必须按可独立增加、替换和删除的功能模块进行，确保：

1. 任一尚未迁移模块不会阻塞已经迁移的模块。
2. 任一非核心模块可中途删除，而不破坏应用启动、数据层或其他模块。
3. UI、领域逻辑、浏览器实现和可选后端实现之间只通过稳定契约通信。
4. Legacy Hook 只承担启动兼容、诊断和能力桥接职责，不接收新的业务逻辑。
5. 原版 DOM 子树不得同时由 Vue 和 jQuery/上游 ESM 管理。
6. 纯前端实现是默认实现，可选后端只能提供增强能力或替代 Adapter。

## 2. 迁移状态定义

| 状态               | 含义                                   |
| ------------------ | -------------------------------------- |
| `inventory`        | 已盘点，尚未设计                       |
| `designed`         | Port、数据模型与模块边界已确定         |
| `legacy-hosted`    | 仍由 Legacy UI 展示或驱动              |
| `migrating`        | 新旧实现并存，正在迁移                 |
| `browser-ready`    | 纯前端实现可独立运行                   |
| `backend-optional` | 已提供可选后端 Adapter，但不是运行前提 |
| `completed`        | UI、功能、测试和迁移脚本均已完成       |
| `removed`          | 模块已被产品决策删除                   |
| `deferred`         | 保留设计位置，但当前版本不实现         |

状态以各模块目录内的 `module.json` 为准；本清单用于总体规划。

## 3. 模块化约束

每个新功能模块建议具备以下结构：

```text
features/<module>/
├─ module.ts              # 模块注册入口
├─ module.json            # ID、版本、依赖、状态、可选能力
├─ domain/                # 本模块实体和值对象
├─ application/           # Use cases
├─ ports/                 # 本模块需要的接口
├─ adapters/              # 浏览器或远端实现（也可放公共 adapters）
├─ ui/                    # Vue 组件和 Legacy 挂载点
├─ migrations/            # IndexedDB schema/data migration
└─ tests/
```

模块之间禁止直接读取对方的 IndexedDB 表或 Vue 内部状态。跨模块只能通过：

- 明确声明的 Port；
- 应用事件；
- `packages/contracts` 中的公共 DTO；
- 模块注册表提供的 Capability；
- 已记录在 Legacy 兼容契约中的上游公开事件、导出或 DOM 锚点。

删除一个模块时，应可以同时删除它的 `features/<module>`、路由和数据库升级入口；其他模块只能失去一项可选 Capability，不能导致应用无法启动。

## 4. 迁移优先级

| 优先级 | 目标                                              |
| ------ | ------------------------------------------------- |
| P0     | 应用壳、Legacy UI 兼容契约、IndexedDB、模块运行时 |
| P1     | 设置、角色、聊天、群组、世界书、人格、基础媒体    |
| P2     | 提示词、预设、生成、Tokenizer、导入导出           |
| P3     | 向量、搜索、翻译、语音、绘图、扩展系统            |
| P4     | 多用户、同步、远程备份、管理能力                  |

---

# 5. 模块清单

## M00 — Application Shell / 应用壳

- **优先级**：P0
- **当前状态**：`legacy-hosted`（1.18.0 兼容契约已建立）
- **核心性**：必需，不可删除
- **原始位置**：
  - `public/index.html`
  - `public/style.css`
  - `public/css/**`
  - `public/img/**`
  - `public/webfonts/**`
  - `public/sounds/**`
  - `public/locales/**`
- **当前职责**：页面骨架、抽屉、聊天区、设置面板、弹窗容器和静态主题。
- **迁移策略**：
  1. 原文件完整复制到 `apps/web/legacy/upstream/public`，不直接修改；
  2. 根页面长期运行原版 DOM、CSS 与 JavaScript，只在生成的首页插入一个独立 Hook；
  3. 使用 `apps/web/legacy/contracts/1.18.0.json` 固化 DOM、资源入口、扩展模块、事件和导出基线；
  4. Hook 先提供完成 UI 初始化所需的固定空数据，真实功能再按模块迁移；
  5. 后续按功能岛逐块切换 DOM 所有权，未迁移区域继续使用上游实现，且不得被 Vue 同时管理。
- **浏览器 Adapter**：当前只有启动兼容 Hook，不属于正式业务 Adapter。
- **可选后端**：无。
- **删除影响**：应用无法运行。
- **验收**：无 Node 服务端时完成原版启动；静态资源完整；关键契约检查通过；原版模块导入、事件系统和扩展上下文入口可用；代表性原版抽屉交互正常；启动请求不进入网络。

## M01 — Runtime / 模块运行时

- **优先级**：P0
- **当前状态**：`designed`（Legacy Hook/诊断已运行；通用模块注册器尚未实现）
- **核心性**：必需，不可删除
- **新位置**：`apps/web/src/app/runtime/**`
- **职责**：模块注册、依赖检查、Capability 注册、启动状态、错误隔离。
- **Legacy 依赖**：无直接对应模块。
- **浏览器 Adapter**：模块清单与启动状态保存在 IndexedDB。
- **可选后端**：可以同步模块偏好，但不能控制本地应用是否启动。
- **删除影响**：应用无法按模块加载。

## M02 — Local Database / 本地数据库

- **优先级**：P0
- **当前状态**：`browser-ready`（固定通用 records/blobs 存储平台）
- **核心性**：必需，不可删除
- **原始位置**：原项目主要依赖服务端文件系统；前端零散使用 LocalStorage/LocalForage。
- **相关前端**：
  - `public/scripts/util/AccountStorage.js`
  - `public/scripts/tokenizers.js`
  - `public/scripts/itemized-prompts.js`
  - `public/scripts/samplerSelect.js`
- **新职责**：Dexie 生命周期、事务、数据库健康状态和模块命名空间隔离。
- **固定 Object Store**：
  - `records`：JSON-safe 模块记录，平台组合 `module / collection / id` key；
  - `blobs`：头像、附件等二进制数据及 JSON metadata。
- **模块接入**：新增模块或 collection 不增加 Object Store，不维护递增 schema；模块只使用安装上下文分配的命名空间 Store。
- **开发期重置**：已按决策切换到新数据库名，旧 prototype schema v3 测试数据不迁移。
- **可选后端**：同步 Adapter；本地库始终保留为离线源或缓存。
- **删除影响**：纯前端持久化失效，因此不可删除。

## M03 — Settings / 设置

- **优先级**：P1
- **当前状态**：`completed`（纯前端范围：核心 settings 文档与快照）
- **原始前端**：
  - `public/script.js`（`getSettings`、`saveSettings`）
  - `public/scripts/power-user.js`
  - `public/scripts/util/AccountStorage.js`
- **原始服务端**：`src/endpoints/settings.js`
- **原始接口**：
  - `POST /api/settings/get`
  - `POST /api/settings/save`
  - `POST /api/settings/get-snapshots`
  - `POST /api/settings/load-snapshot`
  - `POST /api/settings/make-snapshot`
  - `POST /api/settings/restore-snapshot`
- **问题**：原 `get` 接口同时聚合设置、预设、主题、世界书名称等多类数据，边界过宽。
- **已实现 Port**：`SettingsRepository`、`SettingsSnapshotRepository`；以 JSON-safe opaque document 保留上游动态字段。
- **浏览器实现**：
  - `/api/settings/get` 首次从上游默认设置初始化，之后读取 IndexedDB；
  - `/api/settings/save` 按原版全量覆盖语义串行写入 IndexedDB；
  - 每次读取/写入都克隆文档，避免 Legacy 代码持有数据库内部对象；
  - 原版快照列表、创建、内容预览与恢复使用 `settings / snapshots / <name>` records collection；
  - IndexedDB 不可用时 settings 与 snapshots 分别降级为页面会话内存存储并报告诊断。
- **模块边界**：主题、上下文、指令、系统提示词和快捷回复等预设 CRUD 属于 M09，不再由 M03 承担。
- **已知限制**：遵循原版完整文档 last-writer-wins；多个标签页同时保存可能相互覆盖，未来由同步/协作能力处理。
- **可选后端**：未来通过同一 Port 提供设置和快照同步，不能成为本地启动前提，也不影响 M03 纯前端完成状态。
- **依赖**：M02。
- **删除影响**：只能删除高级设置 UI，基础运行设置不可删除。
- **验收**：原版 `#fast_ui_mode` 完成“修改 → 创建快照 → 再修改 → 原版确认弹窗恢复 → 自动刷新”，控件回到快照值。

## M04 — Characters / 角色与角色卡

- **优先级**：P1
- **初始状态**：`inventory`
- **原始前端**：
  - `public/script.js`
  - `public/scripts/char-data.js`
  - `public/scripts/personas.js`（部分关联）
- **原始服务端**：
  - `src/endpoints/characters.js`
  - `src/character-card-parser.js`
  - `src/validator/TavernCardValidator.js`
- **原始接口**：`create`、`rename`、`edit`、`edit-avatar`、`edit-attribute`、`merge-attributes`、`delete`、`all`、`get`、`chats`、`import`、`duplicate`、`export`。
- **目标 Port**：`CharacterRepository`、`CharacterCardCodec`、`CharacterAssetRepository`。
- **浏览器实现**：
  - 元数据 IndexedDB；
  - 头像/原始卡片 OPFS 或 Blob；
  - PNG `chara`/`ccv3` chunk 使用 `Uint8Array` 解析；
  - JSON/V2/V3 导入导出。
- **可选后端**：角色同步、大文件存储、共享角色库。
- **依赖**：M02、M13。
- **删除影响**：核心单人聊天依赖角色；匿名聊天模式可作为降级方案。

## M05 — Chats / 聊天与消息

- **优先级**：P1
- **初始状态**：`inventory`
- **原始前端**：
  - `public/script.js`
  - `public/scripts/chats.js`
  - `public/scripts/bookmarks.js`
  - `public/scripts/swipe-picker.js`
  - `public/scripts/streaming-display.js`
- **原始服务端**：`src/endpoints/chats.js`
- **原始接口**：`save`、`get`、`rename`、`delete`、`export`、`import`、`search`、`recent` 及 group chat 子路径。
- **目标 Port**：`ChatRepository`、`MessageRepository`、`ChatImportExportPort`。
- **浏览器实现**：IndexedDB；消息与聊天元数据分表；支持 JSONL 兼容导入导出。
- **可选后端**：多设备同步、全文检索、远程备份。
- **依赖**：M02；通常依赖 M04，但数据模型不得硬依赖角色文件名。
- **删除影响**：核心模块，不可整体删除；书签、搜索、分支可独立删除。

## M06 — Groups / 群组聊天

- **优先级**：P1
- **初始状态**：`inventory`
- **原始前端**：`public/scripts/group-chats.js`
- **原始服务端**：`src/endpoints/groups.js`、`src/endpoints/chats.js` 的 group 路径。
- **原始接口**：`all`、`create`、`edit`、`delete`、`group/get`、`group/save`、`group/import`、`group/info`。
- **目标 Port**：`GroupRepository`、`GroupChatOrchestrator`。
- **浏览器实现**：IndexedDB。
- **可选后端**：群组同步。
- **依赖**：M04、M05。
- **删除影响**：单角色聊天不受影响；可完整删除。

## M07 — World Books / 世界书

- **优先级**：P1
- **初始状态**：`inventory`
- **原始前端**：`public/scripts/world-info.js`
- **原始服务端**：`src/endpoints/worldinfo.js`
- **原始接口**：`list`、`get`、`delete`、`import`、`edit`。
- **目标 Port**：`WorldBookRepository`、`WorldInfoMatcher`。
- **浏览器实现**：IndexedDB；匹配算法放 Worker 的可行性后续评估。
- **可选后端**：共享世界书、同步。
- **依赖**：M02；提示词装配模块可选依赖本模块 Capability。
- **删除影响**：聊天仍可运行，只失去世界书注入。

## M08 — Personas / 用户人格

- **优先级**：P1
- **初始状态**：`inventory`
- **原始前端**：`public/scripts/personas.js`
- **原始服务端**：主要通过设置、头像与文件接口持久化。
- **目标 Port**：`PersonaRepository`、`PersonaAssetRepository`。
- **浏览器实现**：IndexedDB + OPFS/Blob。
- **可选后端**：同步。
- **依赖**：M02、M13。
- **删除影响**：使用默认本地用户身份；聊天功能不应崩溃。

## M09 — Presets / 提示词预设、主题与快捷回复

- **优先级**：P1/P2
- **初始状态**：`inventory`
- **原始前端**：
  - `public/scripts/preset-manager.js`
  - `public/scripts/PromptManager.js`
  - `public/scripts/instruct-mode.js`
  - `public/scripts/sysprompt.js`
  - `public/scripts/reasoning.js`
  - `public/scripts/extensions/quick-reply/**`
- **原始服务端**：
  - `src/endpoints/presets.js`
  - `src/endpoints/themes.js`
  - `src/endpoints/quick-replies.js`
  - `src/endpoints/moving-ui.js`
- **目标 Port**：按类型拆分 `PresetRepository<T>`，禁止继续由 Settings 聚合返回。
- **浏览器实现**：IndexedDB，JSON 导入导出。
- **可选后端**：预设同步和共享。
- **依赖**：M02、M03。
- **删除影响**：各预设类型可独立删除；保留默认提示词即可继续生成。

## M10 — Prompt Pipeline / 提示词装配

- **优先级**：P2
- **初始状态**：`inventory`
- **原始前端**：
  - `public/scripts/openai.js`
  - `public/scripts/PromptManager.js`
  - `public/scripts/instruct-mode.js`
  - `public/scripts/authors-note.js`
  - `public/scripts/macros/**`
  - `public/scripts/variables.js`
- **目标 Port**：`PromptAssembler`、`MacroEngine`、`ContextBudgetService`。
- **浏览器实现**：纯 TypeScript；复杂计算可放 Worker。
- **可选后端**：无必要；只可提供实验性远端模板服务。
- **依赖**：M03、M04、M05；可选依赖 M07、M09、M11。
- **删除影响**：宏、作者注、特定提示词阶段均应作为可选 Pipeline Step 独立删除。

## M11 — Extensions / 扩展系统

- **优先级**：P3
- **初始状态**：`inventory`
- **原始前端**：`public/scripts/extensions.js`、`public/scripts/extensions/**`
- **原始服务端**：`src/endpoints/extensions.js`、`plugins/**`
- **原始接口**：安装、更新、分支、切换、移动、版本、删除、发现。
- **问题**：旧扩展直接运行在页面上下文，可访问 DOM、全局状态和密钥。
- **目标 Port**：`ExtensionRegistry`、`PluginStorage`、`PluginPermissionBroker`。
- **浏览器实现**：
  - 内置扩展可临时兼容；
  - 新第三方扩展使用 iframe/Worker 沙箱；
  - 显式 Capability 权限。
- **可选后端**：Git 下载、包审计、远端扩展仓库。
- **依赖**：M01、M02；其他能力只能声明为可选依赖。
- **删除影响**：可整体删除，不影响核心聊天。

## M12 — Generation Providers / 模型生成

- **优先级**：P2
- **初始状态**：`inventory`
- **原始前端**：
  - `public/scripts/openai.js`
  - `public/scripts/textgen-settings.js`
  - `public/scripts/kai-settings.js`
  - `public/scripts/nai-settings.js`
  - `public/scripts/sse-stream.js`
- **原始服务端**：
  - `src/endpoints/openai.js`
  - `src/endpoints/google.js`
  - `src/endpoints/anthropic.js`
  - `src/endpoints/novelai.js`
  - `src/endpoints/openrouter.js`
  - `src/endpoints/backends/**`
- **目标 Port**：`GenerationGateway`、`ModelCatalogGateway`、`StreamingGeneration`。
- **浏览器实现**：OpenAI-compatible direct、支持 CORS 的厂商 API、本地 WebLLM。
- **可选后端**：CORS 代理、密钥 Vault、请求签名、本地私网模型桥接。
- **依赖**：M03、M10、M14。
- **删除影响**：每个 Provider 可独立删除；至少保留一个 Provider 或离线模拟器。

## M13 — Assets / 文件、图片、背景与附件

- **优先级**：P1
- **初始状态**：`inventory`
- **原始前端**：
  - `public/scripts/backgrounds.js`
  - `public/scripts/chats.js` 的附件逻辑
  - `public/scripts/utils.js` 的上传逻辑
- **原始服务端**：
  - `src/endpoints/files.js`
  - `src/endpoints/images.js`
  - `src/endpoints/backgrounds.js`
  - `src/endpoints/assets.js`
  - `src/endpoints/avatars.js`
  - `src/endpoints/sprites.js`
- **目标 Port**：`BlobRepository`、`AssetIndex`、`ImageProcessor`。
- **浏览器实现**：OPFS 优先、IndexedDB Blob 回退、Object URL 生命周期管理。
- **可选后端**：远程 Blob/S3/WebDAV Adapter。
- **依赖**：M02。
- **删除影响**：媒体子模块可删；文本聊天仍应工作。

## M14 — Secrets / 密钥

- **优先级**：P2
- **初始状态**：`inventory`
- **原始前端**：`public/scripts/secrets.js`
- **原始服务端**：`src/endpoints/secrets.js`
- **原始接口**：`write`、`read`、`view`、`find`、`delete`、`rotate`、`rename`、`settings`。
- **目标 Port**：`SecretStore`、`CredentialResolver`。
- **浏览器实现**：Web Crypto 加密存储；用户解锁后密钥仍会存在于浏览器内存，不能宣称为真正保密。
- **可选后端**：Vault，仅返回代理执行结果，不把明文密钥交给浏览器。
- **依赖**：M02。
- **删除影响**：仍允许用户每次请求临时输入 Key；不影响本地数据浏览。

## M15 — Tokenizers / Token 计算

- **优先级**：P2
- **初始状态**：`inventory`
- **原始前端**：`public/scripts/tokenizers.js`
- **原始服务端**：`src/endpoints/tokenizers.js`、`src/tokenizers/**`
- **目标 Port**：`TokenizerPort`。
- **浏览器实现**：Web Worker + tiktoken/sentencepiece/web-tokenizers；失败时提供估算器。
- **可选后端**：远端模型特有 tokenizer。
- **依赖**：M01；M10、M12 使用其 Capability。
- **删除影响**：退化为估算，不阻止聊天。

## M16 — Vectors / 向量记忆

- **优先级**：P3
- **初始状态**：`inventory`
- **原始前端**：`public/scripts/extensions/vectors/**`
- **原始服务端**：`src/endpoints/vectors.js`、`src/vectors/**`
- **原始接口**：`query`、`query-multi`、`insert`、`list`、`delete`、`purge`、`purge-all`。
- **目标 Port**：`EmbeddingGateway`、`VectorStore`。
- **浏览器实现**：IndexedDB + Worker 余弦检索；后续可替换 WASM 索引。
- **可选后端**：远程向量数据库与 Embedding 代理。
- **依赖**：M02、M12（可选）。
- **删除影响**：可完整删除，不影响基础聊天。

## M17 — Search / 网页搜索与内容导入

- **优先级**：P3
- **初始状态**：`inventory`
- **原始前端**：`public/scripts/scrapers.js` 及相关扩展。
- **原始服务端**：`src/endpoints/search.js`、`src/endpoints/content-manager.js`。
- **目标 Port**：`SearchGateway`、`ContentImporter`。
- **浏览器实现**：仅支持允许 CORS 的 API 和用户本地文件。
- **可选后端**：网页抓取、私网过滤、Transcript 获取、Office 文档解析。
- **依赖**：M13、M14。
- **删除影响**：可完整删除。

## M18 — Translation / 翻译

- **优先级**：P3
- **初始状态**：`inventory`
- **原始前端**：翻译扩展及设置。
- **原始服务端**：`src/endpoints/translate.js`
- **原始 Provider**：Libre、Google、Yandex、Lingva、DeepL、OneRing、DeepLX、Bing。
- **目标 Port**：`TranslationGateway`。
- **浏览器实现**：支持 CORS 的 Provider。
- **可选后端**：代理不支持 CORS 或需要隐藏密钥的 Provider。
- **依赖**：M14（可选）。
- **删除影响**：可完整删除。

## M19 — Speech / TTS、STT 与音频

- **优先级**：P3
- **初始状态**：`inventory`
- **原始前端**：`public/scripts/extensions/tts/**`、speech recognition 扩展。
- **原始服务端**：`src/endpoints/speech.js`、`src/endpoints/azure.js`、`src/endpoints/volcengine.js` 等。
- **目标 Port**：`TextToSpeechGateway`、`SpeechToTextGateway`、`AudioRepository`。
- **浏览器实现**：Web Speech API、允许浏览器调用的远端服务。
- **可选后端**：需要签名、密钥隐藏、音频转换的服务。
- **依赖**：M13、M14。
- **删除影响**：可完整删除。

## M20 — Image Generation / 绘图

- **优先级**：P3
- **初始状态**：`inventory`
- **原始前端**：`public/scripts/extensions/stable-diffusion/**`
- **原始服务端**：`src/endpoints/stable-diffusion.js`、`src/endpoints/image-metadata.js`、`src/endpoints/caption.js`。
- **目标 Port**：`ImageGenerationGateway`、`ImageMetadataCodec`。
- **浏览器实现**：允许 CORS 的远端服务或浏览器内模型（后续评估）。
- **可选后端**：Stable Diffusion/ComfyUI 等私网服务桥接和元数据处理。
- **依赖**：M13、M14。
- **删除影响**：可完整删除。

## M21 — Import / Export / Backup

- **优先级**：P2
- **初始状态**：`inventory`
- **原始服务端**：`src/endpoints/backups.js`、各 characters/chats/settings 导入导出接口。
- **目标 Port**：`ArchiveExporter`、`ArchiveImporter`、`BackupRepository`。
- **浏览器实现**：生成 ZIP/JSON/JSONL/PNG；File System Access API 可作为增强，下载回退必须可用。
- **可选后端**：定时远程备份、跨设备恢复。
- **依赖**：M02、M04、M05、M07、M09、M13。
- **删除影响**：自动备份可删；基础手动导出应视为核心数据安全能力。

## M22 — Users / 本地身份、多用户与同步

- **优先级**：P4
- **初始状态**：`deferred`
- **原始前端**：`public/scripts/user.js`、`public/scripts/login.js`
- **原始服务端**：`src/users.js`、`src/endpoints/users-*.js`
- **目标 Port**：`CurrentProfilePort`、`AuthGateway`、`SyncGateway`。
- **浏览器实现**：默认单本地 Profile，不要求登录。
- **可选后端**：账户、管理、多用户、设备同步。
- **依赖**：M02。
- **删除影响**：远端账户模块可删；本地 Profile 保持最小实现。

## M23 — Stats / 使用统计

- **优先级**：P3
- **初始状态**：`deferred`
- **原始前端**：`public/scripts/stats.js`
- **原始服务端**：`src/endpoints/stats.js`
- **目标 Port**：`StatsRepository`。
- **浏览器实现**：IndexedDB 派生统计；不应阻塞聊天写入。
- **可选后端**：跨设备聚合。
- **依赖**：M05。
- **删除影响**：可完整删除。

---

# 6. 建议迁移批次

## 批次 A：当前阶段

- M00 Application Shell
- M01 Runtime 骨架
- M02 固定 records/blobs 模块存储平台
- M03 核心 Settings 文档本地持久化
- Legacy 文件完整复制、哈希校验和版本升级工具
- 无服务端 Legacy-first 启动与原版 UI 交互
- 除 Settings get/save 外，其余业务能力仍只提供启动所需空数据

## 批次 B：最小可用本地酒馆

- M03 已完成；主题与提示词等预设转入 M09，可选同步转入 M22
- M04 Characters
- M05 Chats
- M08 Personas 最小实现
- M13 Assets 最小实现
- M21 手动导入导出

验收：创建角色、发送本地测试消息、刷新后数据存在、可导出恢复。

## 批次 C：可生成聊天

- M09 Presets
- M10 Prompt Pipeline
- M12 Generation Providers
- M14 Secrets
- M15 Tokenizers

验收：至少一个 OpenAI-compatible CORS Provider 可流式生成；无后端仍可运行。

## 批次 D：高级上下文

- M06 Groups
- M07 World Books
- M16 Vectors
- M23 Stats

## 批次 E：可选增强

- M11 Extensions
- M17 Search
- M18 Translation
- M19 Speech
- M20 Image Generation
- M22 Users/Sync

# 7. 每个模块开始前必须补齐的信息

1. 原模块的 UI 挂载点和 DOM ID。
2. 原模块读写的全局变量。
3. 原模块使用的所有 `/api`、XHR、WebSocket 和外部 URL。
4. 输入输出数据样例及兼容版本。
5. Port 接口和错误模型。
6. IndexedDB schema 与升级/回滚策略。
7. 浏览器权限、配额、CORS 和安全限制。
8. 模块禁用或删除后的降级行为。
9. 单元、契约、迁移和 E2E 测试。
10. Legacy 代码何时可以删除。

# 8. 当前阶段不迁移的内容

当前只迁移 UI 外壳、原版交互和工程基础，不实现以下真实业务能力：

- 主题/预设 CRUD（M09）和跨设备设置同步（M22）；
- 角色、聊天、群组和世界书的 CRUD；
- 模型生成与 Tokenizer；
- 扩展安装、用户、远程存储或同步。

Legacy JavaScript 会在根页面正常执行。Settings get/save 已桥接到浏览器 Use Case 和 IndexedDB；其他启动路径仍返回固定空数据或安全默认值，不承诺真实业务语义。未知 `/api/**` 会返回 `501` 并记录在诊断信息中。
