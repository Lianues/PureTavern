# M05 Chats / 聊天与消息

M05 在不修改 SillyTavern 1.18.0 上游 UI/JS 的前提下，为原版单角色聊天流程提供纯浏览器持久化。

## 边界

已覆盖：

- `POST /api/chats/save|get|rename|delete|export|import|search|recent`
- `POST /api/characters/chats`
- 原版 Header 与 opaque messages 的完整 JSON 往返
- JSONL/JSON 导入、JSONL/TXT 导出、全文片段搜索、recent pinned/max

明确不覆盖：

- `/api/chats/group/*`
- `/api/groups/*`
- 模型请求、世界书匹配、群聊、可选后端和聊天附件文件服务

这些能力分别属于 M06、M07、M12/M13，M05 不会用空成功响应冒充已迁移。

## 架构

- `domain/chat.ts`：稳定 Chat 模型、Legacy 文件名、Header/messages 组合和 DTO 工具。
- `ports/`：`ChatRepository`、`MessageRepository`、`ChatImportExportPort` 与 owner alias Port。
- `application/chat-service.ts`：CRUD、同 owner 串行化、integrity/force、搜索、recent 与导入导出编排。
- `application/owner-identity-resolver.ts`：消费可选角色身份 capability；没有 Characters 时使用 Chats 自己的 alias collection。
- `infrastructure/`：固定通用 records 上的 IndexedDB Adapter、内存降级和隔离的 import/export codec。
- `legacy/register-routes.ts`：仅做上游 HTTP DTO 适配，也支持上游 `compressRequest` 产生的 gzip JSON body。

## 存储模型

数据库仍只有平台固定的 `records`、`blobs` 两个物理 Object Store，版本仍为 1。M05 使用 records 中的逻辑命名空间：

```text
chats / sessions / <stable-chat-id>
chats / messages / <stable-chat-id>
chats / owner-aliases / <legacy-avatar-url>
```

`StoredChatSession.id` 和 `ownerId` 都是稳定 ID。`avatar_url`、`.jsonl` 文件名只是 Legacy alias，不是主键；聊天重命名只更新 `legacyFileName`。

Header 会保留未知字段，并单独索引完整 `chat_metadata`。消息数组不做 DTO 清洗，`extra`、`swipes`、`swipe_id`、`swipe_info`、书签/分支和未来字段会原样保存。

## 模块协作

平台 `CapabilityRegistry` 提供类型安全、可选的结构化能力：

- Characters 注册 `CharacterIdentityCapability`，将 avatar alias 解析到 M04 stable character ID，并支持 owner ID 反查当前头像。
- Chats 注册 `ChatOwnerLifecycleCapability`。
- Characters 仅在 `delete_chats: true` 时动态调用聊天生命周期能力；`false` 时保留聊天。
- Chats 不 import Characters 内部 Repository 或 Service；缺少 Characters 时仍可通过本地 alias 生成稳定 owner。

## 并发与完整性

同一 owner 的操作进入 keyed serial queue，因此同一聊天不会因并行保存导致旧写覆盖新写。保存语义是完整文档 last-writer-wins；当新旧 Header 都有 `chat_metadata.integrity` 且值不一致时返回 `{ error: "integrity" }`，`force: true` 可显式覆盖。

## 导入导出

- JSONL：逐行 JSON object 校验、Header 校验、消息数/文件/单行大小限制、Chub `mes.message` 和 swipe object 展平。
- JSON：支持 Ooba、Agnai、CAI Tools、Kobold Lite、RisuAI。
- JSONL 导出保留完整 Header/messages；TXT 导出过滤 `is_system`，优先使用 `extra.display_text`。
- import 生成 owner 内唯一 `.jsonl` Legacy 文件名并返回 `{ res: true, fileNames }`。

## 降级与诊断

sessions、messages、owner aliases 各自使用 resilient repository。IndexedDB 不可用时降级为当前页面会话内存，并通过 `globalThis.__PURE_TAVERN__.features.chats` 暴露 diagnostics；降级不新增数据库 schema 或 Object Store。
