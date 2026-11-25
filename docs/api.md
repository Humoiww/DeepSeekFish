# 接口参考

[文档索引](README.md) · [Codex 与 Antigravity 接入](neon-codex-development-bridge.md)

## WebUI HTTP

默认监听 `http://127.0.0.1:17862`。直接调用 `/api/` 时使用 `Authorization: Bearer <本机 WebUI 管理令牌>`。POST 使用 JSON。启用 Tailnet 主人网关时，网关认证设备并代加上游令牌，只代理允许的路由。响应中的 `error` 是程序错误码，平台发布是否成功要看对应的送达回执。[鉴权与边界](security.md)

| 路由 | 用途与参数 |
| --- | --- |
| `GET /api/status` | 当前连接、预算、模型提供方、官方 Go／Codex／AGY 额度与功能状态 |
| `POST /api/settings` | 保存连接或全局设置。可单独更新 `provider`、`model`、`maxOutputTokens`、`keySlot`、`disableThinking` 或 `activePresetId` |
| `GET /api/opencode/models?keySlot=…` | 已验证兼容 Chat Completions 的模型目录。各条包含 `disableThinkingSupport`，按需附 `disableThinkingParam` 或 `disableThinkingReason` |
| `POST /api/connection-presets` | 保存并切换连接预设。传 `name`、`provider`、`model`、`maxOutputTokens`、`keySlot`，可选 `id`、`disableThinking`、`apiKey` |
| `POST /api/connection-presets/delete` | 用 `{ "id": "…" }` 删除预设 |
| `GET /api/persona` · `POST /api/persona` | 读写 `blocks`、`appearance`、`voiceExamples`。保存带当前 `revision`，版本冲突需重新读取。口吻示例最多 4000 字符，空字符串清空 |
| `GET /api/prompts` | `systems` 给出已保存的静态开头与末尾人格预览，`latest` 给出最近保存的脱敏实际请求 |
| `POST /api/sessions` · `POST /api/chat` | 创建会话后，传 `sessionId`、`text` 与 `mode`（`chat`、`agent` 或 `image`）。对话响应为 NDJSON 事件流，单张生图按 WebUI 流程确认 |
| `GET /api/activity` · `GET /api/activity/detail?id=…` | 查询活动及其实际模型、工具与费用记录 |
| `GET /api/neon` · `GET /api/neon/record?kind=…&id=…` | 读取开发后台状态与已同步的 `agy`、`codex`、`patch` 记录 |
| `POST /api/neon/interrupt` · `POST /api/neon/reset-conversation` | 发出开发中断或重置主会话的请求，完成状态从面板确认 |
| `GET /api/activity/active` · `POST /api/activity/interrupt` | 查询或停止活跃任务；可用 `taskId`、`runId` 或 `chainId` 指定目标 |
| `GET /api/tieba/queue?publications=1` | 读取自动发言队列、验证暂停状态和下次放行时间 |
| `POST /api/tieba/queue-cancel` · `POST /api/tieba/queue-interval` | 用 `operationId` 取消未执行的排队项，或用 `intervalMs` 与 `maxIntervalMs` 调整间隔 |

完整路由见 [WebUI 服务](../src/web/server.ts)与 [Tailnet 白名单](../src/web/tailnet.ts)。贴吧发布目标、验证码与回执见 [贴吧模块](tieba/README.md)。

## 肥鱼的开发工具

| 工具 | 输入与结果 |
| --- | --- |
| `request_development` | `messageNumber` 对应本轮可信主人消息，`reply` 为交接回复。可选 `brief`，`action` 默认为 `send`，也支持 `cancel`。后续追问仍用这个入口 |
| `development_status` | 不传参数列最近任务，传 `taskId` 读阶段与交付回执 |
| `ask_development` | 活动链当前步骤的只读讨论。传 `brief`，确需追问可用 `followUpTo` 引用上次答复 |

工具进入开发 worker 后校验主人、授权及任务来源。模型工具定义见 [开发入口](../src/development/intake.ts)。

## Neon 桥接 Unix Socket

默认 `/run/deepseekfish-agy-bridge.sock`，请求通过 Unix Socket 发 HTTP。systemd 使用 `0660` 和配置的属组限制客户端访问。WebUI 从开发服务的私有中转目录读脱敏快照。

```bash
curl --fail-with-body --unix-socket /run/deepseekfish-agy-bridge.sock http://localhost/v1/status
```

| 路由 | 请求与响应 |
| --- | --- |
| `GET /v1/status` | `ok`、`busy`、当前任务与阶段、最近事件、Neon 主会话 |
| `POST /v1/turn` | 接受任务并等待完整结果。忙时 HTTP 409，连接提前断开会取消正在执行的任务 |
| `POST /v1/steer` | 对已有 Codex turn 追加追问。传 `taskId`、64 位十六进制 `source`、`brief`、`ownerMessage`、`at`（毫秒）。`accepted:false` 时由调用方保留追问 |
| `POST /v1/cancel` | 可选 `taskId`。返回 `cancelled`；Codex 轮次会收到中断请求 |
| `POST /v1/reset-conversation` | 传 `{}`。重置桥接保存的主会话指针 |
| `GET /v1/records` · `GET /v1/record?kind=…&id=…` | 会话和补丁记录索引／详情。支持 `agy`、`codex`、`patch`，ID 按 UUID 校验 |
| `GET /v1/quota` · `POST /v1/quota/refresh` | 读取或刷新 Antigravity 通用额度。刷新请求传 `{}` |

`/v1/turn` 必填 `taskId`（UUID）、`mode`（`development` 或只读的 `chain_discussion`）、`brief`、`ownerMessage`、`installedRevision`。可选 `repairReason`、`lastDelivery` 和 `supplements`。版本字段是安装目录的源码快照版本，由 [`revision(files(installation))`](../src/development/worker.ts) 计算。

以下示例从已构建的管理检出运行，使用真实 Antigravity CLI 做只读问答。正常运行中的任务优先从 QQ 或 WebUI 发起与查看。

```bash
export FISH_INSTALLED_ROOT=/srv/deepseekfish/app
revision="$(node --input-type=module -e '
  import { files, revision } from "./dist/src/development/workspace.js";
  console.log(revision(files(process.env.FISH_INSTALLED_ROOT)));
')"
node --input-type=module -e '
  import { randomUUID } from "node:crypto";
  console.log(JSON.stringify({
    taskId: randomUUID(),
    mode: "chain_discussion",
    brief: "请说明公开仓库的 WebUI 入口位于哪里。",
    ownerMessage: "只读源码并答复。",
    installedRevision: process.argv[1]
  }));
' "$revision" | curl --fail-with-body --unix-socket /run/deepseekfish-agy-bridge.sock \
  -H 'Content-Type: application/json' --data-binary @- http://localhost/v1/turn
```

`outcome` 有 `reply_only`、`need_clarification`、`approved`、`escalated`。回执包含 `replyToFeiyu`、`codexRetries`，按需返回会话 ID、验证结果、`summary.patchArchive` 与 `changes[]`。桥接审核、主项目安装成功和独立网站发布是三个不同阶段，WebUI 显示各自回执。错误用 `{ "ok": false, "error": "…" }` 返回。字段和限制以 [协议类型](../src/development/agy-bridge-types.ts)及 [桥接 HTTP 实现](../src/development/agy-bridge-server.ts)为准。

## 桥接如何调用两个 CLI

- Codex 使用 Unix Socket 上的 WebSocket RPC，依次发送 `initialize`、`initialized`。桥接以 `thread/start` 或 `thread/resume` 取得持久线程，执行 `turn/start`，在原 turn 支持 `turn/steer`、`turn/interrupt`，用 `turn/completed` 判断结束。权限采用 `workspace-write`、`on-request` 与 `auto_review`。[桥接客户端](../src/development/agy-codex.ts) · [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- Antigravity 使用 `agy -p`、JSON 输出、`--json-schema` 和会话级 `--settings`。分诊和审阅使用主会话 ID 续聊，活动链只读讨论独立。分诊与审阅分别校验 `triageSchema`、`reviewSchema`。[协议类型](../src/development/agy-bridge-types.ts) · [Antigravity CLI](https://antigravity.google/docs/cli/headless/)
