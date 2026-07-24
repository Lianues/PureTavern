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
- **当前状态**：`browser-ready-foundation`（Legacy Hook、通用模块注册器、诊断与类型安全 Capability Registry 已运行；依赖图和错误隔离继续演进）
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
- **当前状态**：`completed`（纯前端范围：角色卡 CRUD、头像、导入导出与原版 UI 闭环）
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
- **已实现 Port/模块**：`apps/web/src/features/characters/**`，中央仅在 `features/registry.ts` 注册 `charactersFeature`。
- **浏览器实现**：
  - 元数据使用通用 `records`：`characters / cards / <stable-id>`；头像与原始导入文件使用通用 `blobs`：`characters / avatars / <avatar-file>`、`characters / raw-cards / <id>`；
  - `CharacterCardCodec` 支持 Legacy JSON、Character Card V2/V3，PNG `chara`/`ccv3` tEXt chunk 使用 `Uint8Array` 边界检查解析，导出 PNG 时写回 `chara` 与可生成的 `ccv3`；
  - Legacy routes 覆盖 `all/get/create/edit/rename/edit-avatar/edit-attribute/merge-attributes/delete/import/duplicate/export`，同时支持原版 multipart FormData 与 JSON create；
  - 角色文件名与显示名解耦：重命名生成新的唯一 avatar key 并迁移 Blob，不依赖显示名找头像；
  - 头像 Blob 由 M13 共享根 scope Service Worker 提供 `/thumbnail?type=avatar&file=...` 与 `/characters/<file>`；Characters 通过 `AssetServiceWorkerCapability` 等待 Worker，不再安装第二个 Worker；
  - `/api/characters/chats` 已由 M05 覆盖；Characters 的独立 fallback 仅在 Chats 模块未安装时保留空列表兼容。
- **验收**：Vitest 覆盖 Repository、Blob、V2/V3、PNG chunk、CRUD、重复、导入导出和错误响应；真实 Chrome 门禁通过原版 UI/接口流创建、列表 DOM、头像加载、编辑后刷新保留、复制、重命名、JSON/PNG 导入导出和删除，并保持零 404、零异常、零意外兼容网络请求。
- **Service Worker 生命周期/清站点数据**：首次安装后由 `navigator.serviceWorker.ready` 等待可用；清站点数据会同时清除 IndexedDB 与 Service Worker，下一次启动重新安装并从空角色库开始。
- **可选后端**：未来可通过相同 Port 添加角色同步、大文件存储或共享角色库；本阶段不启动 Node 服务端。
- **依赖**：M02、M13。
- **删除影响**：核心单人聊天依赖角色；匿名聊天模式可作为降级方案。

## M05 — Chats / 聊天与消息

- **优先级**：P1
- **当前状态**：`completed`（纯前端范围：单角色聊天 CRUD、检索、recent、导入导出与原版 UI 闭环）
- **原始前端**：
  - `public/script.js`
  - `public/scripts/chats.js`
  - `public/scripts/bookmarks.js`
  - `public/scripts/swipe-picker.js`
  - `public/scripts/streaming-display.js`
- **原始服务端**：`src/endpoints/chats.js`
- **原始接口**：`save`、`get`、`rename`、`delete`、`export`、`import`、`search`、`recent` 及 group chat 子路径。
- **已实现 Port/模块**：`apps/web/src/features/chats/**` 中的 `ChatRepository`、`MessageRepository`、`ChatImportExportPort` 与 owner alias Port；中央只在 Feature Registry 注册 `chatsFeature`。
- **浏览器实现**：
  - 固定通用 `records` 使用 `chats / sessions / <stable-chat-id>`、`chats / messages / <stable-chat-id>` 与 `chats / owner-aliases / <avatar-url>` 逻辑 collection；不新增 Object Store 或数据库版本；
  - Header、完整 `chat_metadata` 与 opaque messages 分离存储，完整保留 `extra/swipes/swipe_id/swipe_info`、书签/分支和未来扩展字段；
  - `save/get/rename/delete/export/import/search/recent` 与 `/api/characters/chats` 覆盖原版单聊 DTO；同 owner 写入串行化，支持完整文档 last-writer-wins 和 `integrity/force`；
  - JSONL 逐行校验并兼容 Chub swipe；JSON codecs 支持 Ooba、Agnai、CAI Tools、Kobold Lite、RisuAI；TXT 导出过滤系统隐藏消息；
  - Characters 通过类型安全 `CharacterIdentityCapability` 暴露 M04 stable ID；Chats 不直接 import Characters 内部实现。角色 avatar 重命名不改变 owner，recent 可反查当前 avatar；无 Characters 时 alias collection 自行生成稳定 owner；
  - Chats 注册 owner lifecycle capability，Characters 仅在 `delete_chats:true` 时调用；`false` 保留聊天；IndexedDB 失败时各 Repository 降级为页面会话内存。
- **模块边界**：`/api/chats/group/*` 和 `/api/groups/*` 仍归 M06；模型请求和世界书业务不属于 M05。聊天附件文件由 M13 提供，M05 只把 opaque attachment metadata 随 chat document 保存。
- **验收**：Vitest 覆盖 Repository、opaque 往返、并发、integrity、search/recent、JSONL/JSON、错误和 memory fallback；真实 Chrome 门禁覆盖原版角色进入聊天、问候自动保存、本地用户消息、刷新恢复、附件读取/恢复/删除、第二聊天、Manage Chat Files、搜索/重命名/recent/导入导出/删除及角色 rename/delete_chats 生命周期。
- **可选后端**：未来通过同一 Port 增加多设备同步、远程全文检索和备份；不成为本地运行前提。
- **依赖**：M02；可选消费 M04 identity capability，但缺少 Characters 时仍可独立存储。
- **删除影响**：核心模块不可整体删除；搜索、recent、书签/分支增强可独立演进。

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
- **当前状态**：`completed`（纯前端范围：文档 CRUD、导入、角色嵌入 lore 与原版匹配闭环）
- **原始前端**：`public/scripts/world-info.js`
- **原始服务端**：`src/endpoints/worldinfo.js`
- **原始接口**：`list`、`get`、`delete`、`import`、`edit`。
- **已实现 Port/模块**：`apps/web/src/features/world-books/**` 中的 `WorldBookRepository`、`WorldInfoMatcher` 边界、Import Codec 与 Legacy adapter。
- **浏览器实现**：
  - 通用 `records` 使用 `world-books / books / <stable-book-id>` 与 `world-books / aliases / <legacy-file-id>`；文件名 alias 与 stable ID 解耦；
  - `/api/worldinfo/list|get|edit|delete|import` 已桥接；原生 `{ entries }` JSON 和前端已转换的 Novel/Agnai/Risu 数据可导入；
  - 顶层、entry、extensions 未来字段按 opaque JSON 完整往返；写入串行化，IndexedDB 失败后降级为页面内存；
  - `WorldNamesCapability` 由 M07 提供，Settings 在请求时动态组合 `world_names`，两个模块不互相读取 Repository；
  - 匹配算法继续使用未修改的原版 `/scripts/world-info.js`，本阶段不复制到新实现或 Worker。
- **验收**：真实 Chrome 覆盖原版 World Editor、CRUD/JSON import、关键词/constant/disabled 匹配、opaque 字段、Settings world names，以及 Character Card embedded lore 导入。
- **可选后端**：未来通过同一 Port 增加共享世界书和同步，不成为本地启动前提。
- **依赖**：M02；提示词装配模块可选依赖本模块 Capability。
- **删除影响**：聊天仍可运行，只失去世界书注入。

## M08 — Personas / 用户人格

- **优先级**：P1
- **当前状态**：`completed`（纯前端范围：原版 Persona UI、元数据、头像、默认/当前选择、角色绑定与删除降级）
- **原始前端**：`public/scripts/personas.js`
- **原始服务端**：没有 Persona 专属 API；元数据随完整 Settings 保存，头像使用 M13 `/api/avatars/*`。
- **已实现 Port/模块**：`apps/web/src/features/personas/**` 中的 `PersonaRepository`、`PersonaAssetRepository` 与 `LegacyPersonaStateProvider/Composer`。
- **浏览器实现**：
  - stable Persona UUID 与 avatar alias/显示名解耦，descriptor 与未来 `persona_*` 字段按 opaque JSON 保留；
  - 通用 records 使用 `personas / state / current`，不增加 Object Store/数据库版本；IndexedDB 失败后降级到页面内存；
  - Settings 首次 get hydrate Persona aggregate，后续 get/save/snapshot 在同一串行流程 compose；避免 Settings 与 Personas 各自覆盖；
  - 头像完全由 M13 `PersonaAvatarAssetsCapability` 管理，M08 不复制 Blob/index 代码；
  - 支持默认/当前 Persona、角色 bind/unbind、multi-connection 语义和删除后的默认本地用户身份降级；
  - 原版 `chat_metadata.persona` 仍由 M05 作为 opaque metadata 保存，不改变原版 alias DTO。
- **验收**：真实 Chrome 通过原版 `personas.js` 完成头像上传、创建、选择、设为默认、绑定角色、原版卡片 DOM/缩略图、刷新恢复、删除头像与 metadata、清除默认并回退本地身份。
- **可选后端**：未来通过同一 Port 增加 Persona 同步。
- **依赖**：M02、M03、M13；与 M05 仅通过原版 chat metadata 协作。
- **删除影响**：使用默认本地用户身份；聊天功能不应崩溃。

## M09 — Presets / 提示词预设、主题与快捷回复

- **优先级**：P1/P2
- **当前状态**：`completed`（纯前端范围：11 类默认种子、CRUD、恢复、导入导出与 Legacy bootstrap）
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
- **已实现 Port/模块**：`apps/web/src/features/presets/**` 中按类型命名空间化的 `PresetRepository<T>`、seed/import-export service 与 Legacy routes；Settings 不拥有 preset records。
- **浏览器实现**：
  - 支持 kobold、novel、openai、textgenerationwebui、instruct、context、sysprompt、reasoning、theme、moving-ui、quick-reply；
  - 通用 records 使用 documents/aliases/seed-state/tombstones collection；stable ID 与 Legacy 名称解耦；
  - 构建从当前只读 upstream 生成 134 条 SHA-256 默认清单；新增默认被补入，未修改默认可升级，用户修改和删除 tombstone 不被覆盖；
  - `/api/presets/*`、themes、quick-replies、moving-ui routes 已接入；单文档和分类 bundle JSON 导入导出要求显式冲突策略；
  - `LegacyPresetBootstrapCapability` 向 Settings 提供原版 DTO，Settings 只在请求时组合，不直接读取 M09 存储；
  - IndexedDB 失败后固定降级到页面内存并暴露诊断。
- **验收**：真实 Chrome 覆盖 11 类默认数据与原版 select、原版 `PresetManager` 保存/删除/默认恢复，以及 theme/Quick Reply/Moving UI 保存和 opaque 字段往返。
- **可选后端**：未来通过同一 Port 增加预设同步和共享。
- **依赖**：M02、M03。
- **删除影响**：各预设类型可独立删除；保留默认提示词即可继续生成。

## M10 — Prompt Pipeline / 提示词装配

- **优先级**：P2
- **当前状态**：`completed-legacy-owned`（原版浏览器 Pipeline 是唯一权威实现；不再维护 TypeScript 副本）
- **原始且正式保留的前端实现**：
  - `public/scripts/openai.js`
  - `public/scripts/PromptManager.js`
  - `public/scripts/instruct-mode.js`
  - `public/scripts/authors-note.js`
  - `public/scripts/macros/**`
  - `public/scripts/variables.js`
  - `public/scripts/world-info.js`
- **架构决策**：
  - Prompt Pipeline 本身已经是纯前端能力，不需要替换服务端 API 或本地持久化；
  - 原版 PromptManager、宏、变量、作者注、世界书、Persona、examples、history、tools/media 和 generation mode 逻辑随 upstream 一起保留和升级；
  - 不复制原版文件到我方 feature，也不使用 TypeScript 重写第二套 `PromptAssembler`/`MacroEngine`/预算引擎；已删除未参与生产的重复实现及其 Capability；
  - 原版 `prepareOpenAIMessages` 继续生成统一 `generate_data`，M12 只维护该 DTO 到浏览器 Provider 的 transport/adapter 边界；
  - 原版 Pipeline 通过 M15 Legacy tokenizer routes 获得统一近似计数，不宣称模型精确预算。
- **验收**：生产 Chrome 验证原版 `prepareOpenAIMessages` 仍可导入、自维护重复 Feature 不存在，并完成 M12 模型目录、非流式、SSE 与 native adapters 闭环。
- **升级策略**：上游升级时同步原版 Pipeline；若 `generate_data` DTO 变化，只调整 M12 Legacy adapter 和契约测试，不自行追踪宏/PromptManager 内部实现。
- **可选后端**：无必要。
- **依赖**：原版 Pipeline 读取 M03/M04/M05/M07/M09/M11 浏览器状态，使用 M15 近似 tokenizer，并将结果交给 M12。
- **删除影响**：不能删除 upstream Prompt Pipeline，否则核心 Chat Completion 失去提示词装配；项目内不存在可删除的重复候选模块。

## M11 — Extensions / 扩展系统

- **优先级**：P3
- **当前状态**：`completed-browser-legacy-extensions`（原版前端扩展生态与支持浏览器 CORS 的远程生命周期已闭环）
- **原始且继续保留的前端**：`public/scripts/extensions.js`、`public/scripts/extensions/**`、原版第三方风险警告和扩展管理 UI。
- **原始服务端**：`src/endpoints/extensions.js`、`plugins/**`。
- **已实现 Port/模块**：`apps/web/src/features/extensions/**` 中的 `ExtensionRegistry`、`ExtensionSourceGateway`、原版 manifest/package validator、M13 package bridge 与完整 Legacy routes。
- **架构与信任模型**：
  - 构建从只读 upstream 生成 14 项 trusted built-in 清单；内置扩展继续从静态快照加载且禁止删除；
  - 第三方 SillyTavern 扩展保持原版 same-context 模型，不维护不兼容的 iframe/Worker 私有插件生态；
  - 原版 `installExtension()` 在请求 M11 前展示 `thirdPartyExtensionWarning` 并要求用户确认；确认后的代码可访问 DOM、全局状态、IndexedDB、网络和 M14 明文密钥，不能描述为沙箱或安全插件；
  - GitHub 使用 CORS API 与 jsDelivr CORS 文件目录/CDN，GitLab 使用 CORS REST/archive，其他主机仅支持直接 CORS `.zip`；不代理、不绕过 CORS；
  - 包文件通过 M13 映射到 `/scripts/extensions/third-party/<folder>/...`，共享 Service Worker 返回正确 MIME；不增加 Object Store、数据库版本或第二个 Worker。
- **浏览器接口**：
  - discover/install/version/update/branches/switch/move/delete 全部使用真实 registry、远程 snapshot 与 M13 Blob；
  - install/update/switch 做路径、文件数、压缩与展开大小、单文件、压缩比、zip-slip、Unicode/大小写冲突和原版 manifest 引用验证；同一扩展操作串行；
  - stable ID 来自 canonical repository URL；显示名、folder、branch、scope 与 ID 解耦；更新保留安装时间和启停状态；
  - `local/global` 在单浏览器 Profile 中是兼容 scope 标签，move 不复制 Blob 或伪造多用户 ACL；
  - Settings `disabledExtensions` 与 registry enable 状态双向串行同步；Comfy workflow 空响应仍不代表图片生成 Provider 已迁移。
- **验收**：22 项定向测试覆盖原版 manifest、CORS source、ZIP 安全与完整生命周期；真实 `https://github.com/Lianues/cocktail` 下载/校验通过。Production Chrome 验证原版风险警告、第三方 manifest/JS/CSS、install/enable/disable/delete hooks、version/update/branches/switch/move/delete、14 个 built-ins、IndexedDB/M13/Worker 和零未处理端点/异常。
- **纯前端边界**：Node server plugins、npm scripts、任意服务端路由、私有仓库代理、作者代码签名和不支持 CORS 的 Git 主机仍不可用。
- **可选后端**：当前不实现；未来只用于私有仓库凭据代理、非 CORS Git 和 Node plugins。
- **依赖**：M01、M02、M03、M13；扩展运行时可自行调用原版公开前端能力。
- **删除影响**：删除 M11 后核心聊天仍可工作，但第三方安装管理与内置扩展 discover/状态桥接消失。

## M12 — Generation Providers / 模型生成

- **优先级**：P2
- **当前状态**：`browser-ready-chat-completion-direct`（只迁移 Chat Completion；其他主 API 明确不在范围）
- **原始前端**：
  - `public/scripts/openai.js`
  - `public/scripts/textgen-settings.js`（本阶段不迁移）
  - `public/scripts/kai-settings.js`（本阶段不迁移）
  - `public/scripts/nai-settings.js`（本阶段不迁移）
  - `public/scripts/sse-stream.js`
- **原始服务端**：
  - `src/endpoints/openai.js`
  - `src/endpoints/google.js`
  - `src/endpoints/anthropic.js`
  - `src/endpoints/novelai.js`（本阶段不迁移）
  - `src/endpoints/openrouter.js`
  - `src/endpoints/backends/chat-completions.js`
- **已实现 Port/模块**：`apps/web/src/features/generation/**` 中的 `GenerationGateway`、`ModelCatalogGateway`、`StreamingGeneration`、26-source registry 与 `GenerationProviderCapability`。
- **浏览器实现**：
  - 仅接管 `main_api="openai"` 的 `/status`、`/generate`、`/bias` 三条核心路径；原版 `openai.js`、PromptManager 与 Legacy Prompt Pipeline 继续组装请求和解析回复；
  - 26 个 SillyTavern 1.18.0 `chat_completion_sources` 由声明式 descriptor 覆盖，不编写 26 套重复实现；
  - 22 个 OpenAI-compatible source 共用 Adapter；Claude、MakerSuite/Vertex、Cohere 分别使用 Anthropic、Google、Cohere Adapter；
  - 模型目录归一化为原版 `{ data: [{ id }] }`；非流式保留厂商响应，SSE 使用 `ReadableStream` 直接转发，AbortSignal 向上游传播；
  - 通过 M14 `CredentialResolverCapability` 按 source/secret ID 即时取值，内部控制字段和密钥不会进入 Provider body 或 diagnostics；
  - Custom/reverse proxy 只允许 HTTPS 或 localhost 开发地址；CORS/TLS/PNA/网络错误明确报告，不伪装成功；
  - M15 是近似 tokenizer，bias 只接受显式数字 token ID 数组，普通文本 bias 被诚实跳过；
  - Vertex Express API-key 模式可用；Full Service Account、专有高级 multimodal/cache/reasoning signature/beta tool 组合仍可能返回明确 capability error。
- **不迁移范围**：Text Completion、NovelAI、AI Horde、KoboldAI、WebLLM；原版 DOM 选项保留以避免破坏扩展契约，但不宣称可用。
- **验收**：9 项模块测试覆盖 registry、四协议转换、模型目录、SSE、abort、CORS 错误、URL/凭据清洗和 bias；production Chrome 使��本机 CORS Mock Provider 验证 OpenAI-compatible 非流式/SSE、Anthropic、Google、Cohere、M14 与三条 Legacy routes，零异常。
- **可选后端**：当前不实现 CORS 代理、Vault、请求签名或私网桥；用户 reverse proxy 只是直连目标，不是项目后端。
- **依赖**：M03、M10、M14；M15 提供近似预算但不提供真实 bias token ID。
- **删除影响**：删除 M12 后本地数据仍可浏览，但无法生成；非聊天主 API 当前本就未迁移。

## M13 — Assets / 文件、图片、背景与附件

- **优先级**：P1
- **当前状态**：`completed`（纯前端本地范围：背景、附件、用户图片/persona 头像、sprites、扩展资产与共享资源 Worker）
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
- **已实现 Port/模块**：`apps/web/src/features/assets/**` 中的 `BlobRepository`、`AssetIndex`、`ImageProcessor`、默认背景 seeder 与 Legacy adapters。
- **浏览器实现**：
  - 固定通用 `blobs`/`records` 使用 assets 命名空间存放稳定 Blob ID、索引、Legacy path alias、背景文件夹与 seed state，不新增 IndexedDB Object Store 或数据库版本；
  - files、images、backgrounds、image-metadata、avatars、sprites、assets 各 route family 已接入；`/api/content/importURL` 复用原版按钮，直接导入允许 CORS 的外链 PNG 角色卡；背景 rename 只迁移 alias/metadata，不复制 Blob；
  - `BrowserImageProcessor` 验证 PNG/JPEG/GIF/WebP、尺寸和动画标记，并通过 Canvas 能力提供头像 crop/resize；不支持时返回明确错误；
  - 文件名、MIME/signature、单文件大小、ZIP 文件数/压缩与展开总量、zip-slip 均有门禁；远程 asset 遵循浏览器 CORS；
  - 构建生成默认背景 hash 清单，新 upstream 默认可增量补入，用户删除以 seed state 保留；
  - 共享根 scope Service Worker 统一解析 Character 头像、背景、persona、聊天附件、用户图片、sprites 与 extension/library URL；Worker 无版本打开现有数据库，不创建 schema；
  - Characters 通过 `AssetServiceWorkerCapability` 复用该 Worker；聊天只保存附件 metadata，实际 Blob 生命周期归 M13。
- **验收**：真实 Chrome 覆盖默认背景、原版背景列表 DOM、上传/缩略图/文件夹/rename/delete、聊天附件跨刷新、用户图片、persona、sprite、extension asset、直接 Blob URL，以及原版 `importFromExternalUrl` 的 CORS PNG 下载→角色导入闭环；零资源 404、零运行时异常。
- **可选后端**：未来提供远程 Blob/S3/WebDAV Adapter；浏览器 CORS 与站点配额不能被本地实现绕过。
- **依赖**：M02；与 M04/M05 仅通过 capability 或公开 URL DTO 协作。
- **删除影响**：媒体子模块可删；文本聊天仍应工作。

## M14 — Secrets / 密钥

- **优先级**：P2
- **当前状态**：`completed-local-plaintext`（本地持久化与原版管理 UI 已闭环；明确不是加密 Vault）
- **原始前端**：`public/scripts/secrets.js`
- **原始服务端**：`src/endpoints/secrets.js`
- **原始接口**：`write`、`read`、`view`、`find`、`delete`、`rotate`、`rename`、`settings`。
- **已实现 Port/模块**：`apps/web/src/features/secrets/**` 中的 `SecretStore`、`CredentialResolver`、本地 service、8 条 Legacy routes 与 `CredentialResolverCapability`。
- **浏览器实现**：
  - 使用固定通用 records 的 `secrets / store / current` aggregate 保存多值密钥、stable ID、label 与 active 状态，不增加 Object Store 或数据库版本；
  - 原版 `scripts/secrets.js` 的 write/read/view/find/delete/rotate/rename/settings DTO 与事件流程继续运行；read 返回掩码，显式 find/view 和内部 resolver 返回明文；
  - 写操作串行化；删除 active 后自动启用同 key 第一项；IndexedDB 失败后固定降级到页面会话内存并报告数据将在刷新后丢失；
  - 按产品决策不使用 Web Crypto、解锁口令或自动加密；diagnostics 明确 `atRest=plaintext`，且不包含 key/value；
  - M12 后续通过窄 `CredentialResolverCapability` 取值，不直接读取 Repository；M11 untrusted extensions 不自动获得 resolver。
- **安全边界**：DevTools、浏览器 Profile、XSS、浏览器扩展、trusted same-context 脚本和运行时 fetch/XHR 包装都可能获取密钥。本模块只是本地凭据持久化，不能宣称真正保密。
- **验收**：9 项模块测试覆盖多密钥、轮换/重命名/删除、掩码与明文出口、验证、串行写入、IndexedDB 和内存降级；生产 Chrome 使用原版 `secrets.js` 验证跨刷新持久化与完整删除回退，零未处理端点和零异常。
- **可选后端**：当前项目未实现任何可选后端，因此本阶段不实现 Vault、密钥代理或同步；未来可通过同一 resolver/Port 增加。
- **依赖**：M02；M12 使用其 Capability。
- **删除影响**：仍允许用户每次请求临时输入 Key；不影响本地数据浏览，但 M12 无法持久化 Provider 凭据。

## M15 — Tokenizers / Token 计算

- **优先级**：P2
- **当前状态**：`completed-simplified-tokenx`（纯前端统一近似计数；不宣称等价于各模型原生 tokenizer）
- **原始前端**：`public/scripts/tokenizers.js`
- **原始服务端**：`src/endpoints/tokenizers.js`、`src/tokenizers/**`
- **已实现 Port/模块**：`apps/web/src/features/tokenizers/**` 中的 `TokenizerPort`、统一 `tokenx` service、Worker client、同步 Legacy adapter 与 `TokenizerCapability`。
- **浏览器实现**：
  - SillyTavern 1.18.0 的 16 个 tokenizer alias、OpenAI count 和 remote Kobold/Text Generation WebUI count 路径统一使用 `tokenx` 近似计数；所有模型故意采用同一套估算语义；
  - 异步请求优先在模块声明并由构建脚本打包的 Web Worker 中执行；原版同步 jQuery XHR 使用同源主线程 `tokenx` handler，失败时再降级为字符估算；
  - encode 返回有界 pseudo token IDs/chunks，仅用于原版 UI 兼容；当前页面会话内可 decode 往返，未知或跨会话 pseudo IDs 明确返回不支持，禁止用于模型生成请求；
  - 所有响应和 diagnostics 均标记 `approximate`、实际 backend 与 fallback 次数，不冒充模型精确 token；
  - 原版 M10 Pipeline 继续调用未修改的 `tokenizers.js`，其同步/异步 Legacy 路径由 M15 提供统一近似计数。
- **验收**：单元/集成测试覆盖 tokenx、Worker 协议、同步 XHR、全部 alias、OpenAI/remote 路径与 fallback；生产 Chrome 使用原版同步/异步 `tokenizers.js` 验证统一计数、pseudo decode、Worker 就绪与零未处理请求。
- **可选后端**：未来可通过同一 Port 增加远端或本地模型专用精确 tokenizer；当前完成状态只表示简化的浏览器近似能力已经闭环。
- **依赖**：M01；原版 M10 通过 Legacy routes 使用，其他现代模块可选使用其 Capability。
- **删除影响**：原版 Pipeline 可退回自身降级逻辑，聊天不应被阻止；token UI 与预算精度进一步下降。

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
- **当前状态**：`completed-browser-archive-backup`
- **原始服务端**：`src/endpoints/backups.js` 的自动 chat JSONL 备份作为可删能力返回安全空列表；完整手动数据安全能力由 M21 版本化归档替代。各角色卡、聊天、世界书和预设原格式导入导出继续保留。
- **已实现 Port**：`ArchiveExporter`、`ArchiveImporter`、`BackupRepository`、`BackupTransport`、`ArchiveParticipantRegistry`。
- **归档格式**：`@pure-tavern/contracts` 定义 `pure-tavern-archive` schema v1；manifest 包含 app/upstream/data version、模块摘要、逻辑 collection/id、大小与每个 payload 的 SHA-256。ZIP 不暴露 IndexedDB 物理 key。
- **模块覆盖**：Settings/Snapshots、Characters、Chats、Personas、World Books、Presets、Assets、Extensions、Stats 和可选 Secrets 均通过模块作用域参与者接入；stable ID、Blob metadata 与 opaque 字段原样保留。
- **导入语义**：dry-run 差异/冲突预览，支持 merge、skip、replace-module、replace-all；正式导入和恢复前自动建立恢复点，并用 journal 记录模块级阶段。
- **浏览器实现**：IndexedDB 本地恢复点默认轮换 5 份；File System Access 可用时直接保存，其他浏览器使用下载和文件选择回退。ZIP 路径、重复、大小、数量、展开体积、压缩比和 hash 均校验。
- **第一方面板**：原版 Extensions loader 加载 `Pure Tavern Data Management`，来源为独立 `pure-tavern-first-party`；提供容量、模块、导出、导入预览、本地恢复/下载/删除可视化，不修改 upstream。
- **Secrets**：默认不导出；显式选择仍是明文 ZIP，必须危险确认。
- **可选后端预留**：浏览器与未来后端共用 `BackupTransport` 的 list/upload/download/delete 和同一 Archive；后端把归档作为 opaque object 保存，未来增量同步可基于 manifest/module/file hash 协商。
- **验收**：模块测试覆盖 codec、安全限制、冲突、恢复点、journal、路由和 transport；production Chrome 完成面板打开、默认/含 Secrets 导出、preview、导入、破坏角色/聊天后恢复、下载和删除闭环。
- **依赖**：M02、M04、M05、M07、M09、M13。
- **删除影响**：自动 chat JSONL 备份可删；M21 手动全量导出/导入属于核心数据安全能力。

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
- **当前状态**：`completed-browser-derived-stats`
- **原始前端**：`public/scripts/stats.js` 保持不变，原版用户/角色统计弹窗、`getStats`、`statMesProcess` 与 `refreshStats` 继续作为 UI 和增量更新入口。
- **原始服务端**：`src/endpoints/stats.js` 的 get/update/recreate 语义已迁移到浏览器模块。
- **已实现 Port/模块**：`apps/web/src/features/stats/**` 中的 `StatsRepository`、派生器、IndexedDB/内存降级和 Legacy routes。
- **浏览器实现**：完整统计文档保存在 module=`stats`、collection=`documents`、id=`current`；首次读取和 `/api/stats/recreate` 从 M05 只读 `ChatStatsSourceCapability` 派生消息、词数、swipe、生成耗时、首末聊天时间与字节数。
- **非阻塞语义**：原版 `statMesProcess` 仍 fire-and-forget 调用 update；Stats 不进入聊天写事务，持久化失败降级到页面内存，崩溃窗口可由 recreate 修复。
- **验收**：模块测试覆盖 Legacy DTO、派生规则、去重、日期、串行更新、故障降级与 M05 集成；production Chrome 覆盖增量更新、跨刷新持久化、重建以及原版两类统计弹窗。
- **可选后端**：未实现；跨设备聚合仍可作为未来增强。
- **依赖**：M05。
- **删除影响**：可完整删除，不影响聊天数据和聊天写入。

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

当前已完成模块以各自章节状态为准；仍不实现的主要真实业务能力包括：

- M06 群组聊天；
- Text Completion、NovelAI、Horde、KoboldAI 和 WebLLM 生成；
- 跨设备设置/数据同步与多用户服务端目录；
- Node server plugins、npm scripts、私有仓库代理和不支持浏览器 CORS 的远程 Git。

Legacy JavaScript 继续在根页面正常执行。已迁移路径桥接到浏览器 Use Case、IndexedDB 和直连 Provider；尚未迁移路径必须返回明确空数据、安全默认或结构化不支持响应。未知 `/api/**` 会返回 `501` 并记录在诊断信息中。
