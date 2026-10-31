# 官方接口调查（2026-10-27）

调查区分 GitHub 当前源码、npm 发布版、实际安装包和账号现场验证。公开仓库不代表账号已经获权。原始研究资料保留在被 Git 忽略的 `runtime/research/`。

## 版本与采用决定

| 组件 | 本次核实 | 本 MVP |
| --- | --- | --- |
| DeepSeek Harness | GitHub master `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，根版本 0.2.1-rc.3；npm `@deepseek-ai/dsh` latest 为 0.2.1-rc.2 | 调查，未安装/启动完整 Harness |
| 官方 dsh-qqbot | main `c8b9158b37817b0dbc1e514e62e16204ad47a6ce`，npm 0.5.2 | 调查插件编排；复用其官方底层 SDK/connector |
| 官方 dsh-subagent-codex | master 0.2.1-rc.3；明确查得 npm 0.2.1-rc.2 存在，但 latest tag 仍指向旧 0.0.1-rc.1；rc.2 依赖 Codex 0.153.4 | 调查，未启用 |
| `@tencent-connect/qqbot-nodejs` | 1.0.5 | 实际安装，消息收发/媒体/网关 |
| `@tencent-connect/qqbot-connector` | 1.2.0 | 实际安装，官方扫码绑定 |
| `@openai/codex` | 0.164.0 | 实际安装，官方 native app-server |
| TypeScript / Node | 6.0.3 / 本环境 24.19.0 | 本地构建和运行，SQLite 为 Node 内置 |

[Harness](https://github.com/deepseek-ai/deepseek-harness) 是 Cordis 插件架构，官方安装入口为 `@deepseek-ai/dsh`。新版本引擎要求 Node >=24.9。QQ 插件按 profile 安装，提供会话、权限交互、消息缓存等；但是公开运行路径直接把通过中间件的消息交给 Agent，难以在所有模型回合前插入本项目的强制预算预留。这里采用用户允许的小型独立适配层，避免把一个通用、有全局工具的 DSH Agent 暴露给群消息。**没有宣称官方两个 DSH 插件已被直接接通。**

[QQ 插件配置与代码](https://github.com/tencent-connect/dsh-qqbot) 的 `requireMention` 只是本地门控，不申请平台权限。本项目直接复用该插件使用的同一腾讯 SDK，而非第三方 QQ 协议实现。

## QQ 消息权限与回复

[官方 SDK](https://github.com/tencent-connect/qqbot-nodejs) 的事件映射同时支持 `GROUP_AT_MESSAGE_CREATE` 与 `GROUP_MESSAGE_CREATE`，群/C2C intent 是 `1 << 25`。这证明 SDK 能处理事件，不证明任意机器人能收到普通群消息。SDK 自身说明，群身份是 openid，主动推送和 Markdown 另有权限/额度。[使用指南](https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md) 是本次核对的 API 契约来源。

本次没有真实 QQ 凭据，因此账号的全量消息权限 **未验证**。默认显示“未验证，按 @ 能力使用”；只有收到某群原生 ordinary 事件才标记该群 observed。该观测也不保证漏消息率或完整性。没有假定扫码登录或 requireMention=false 能提升权限。

被动回复期限/次数依平台能力而异。[官方插件的 limiter](https://github.com/tencent-connect/dsh-qqbot/blob/main/src/transport/reply-limiter.ts) 默认每消息 4 次，TTL 却为 1 小时；SDK 指南在流式场景写明 5 分钟。本 MVP 采用更保守的 **4 分钟、最多 4 次、纯被动回复**，不将该本地限制声称为平台统一保证。平台仍可拒绝发送；过期结果保留，由新命令领取，不偷偷降级主动推送。

## DSH Codex 权限机制

[官方 provider](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-codex) 每任务新建进程/临时线程，返回选中的回答，不返回完整工具活动、token usage 或产物清单。`permissionMode=never` 只设置 approvalPolicy，未显式指定 sandbox；`approve-for-me` 使用自动审批和 workspace-write；另一个危险模式关闭沙箱。本项目不使用后两种，也不允许群友选择这些值。provider 没有逐次人工审批通道，调用者还要自己处理墙钟超时。

所以没有将这个 provider 的“isolated thread”解读成私人文件隔离。项目专用 app-server 客户端补上本机审批、命名文件权限、OS 生命周期、时间预算与产物校验。没有修改全局 DSH，也没有重写 Codex Runtime。

## Codex 实际协议与平台边界

[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server) 的 stdio 为 JSONL，使用 initialize → initialized → thread/start → turn/start，终态以 turn/completed.status 为准。取消会触发进程树终止；不开放任何客户端工具执行服务。

初始调查时，实际安装 0.164.0 已无登录运行 `generate-json-schema --experimental`，并成功 initialize、account/read、permissionProfile/list，没有发起模型回合。生成的 **实际 schema** 中，旧 SandboxPolicy.workspaceWrite 没有 readOnlyAccess 字段；可用的是实验性 thread/turn `permissions` 和 command/exec `permissionProfile`。因此采用命名权限，而非向旧字段发送可能被忽略的值。此差异会影响未来升级，升级必须重新核对 schema。

[官方权限文档](https://learn.chatgpt.com/docs/permissions) 与 [Windows 文档](https://learn.chatgpt.com/docs/windows/windows-sandbox) 描述 MXC、elevated 与 unelevated；后者不支持 denied read paths。单纯 workspace-write 并不表示默认禁止所有外部读取。本项目强制 MXC，选择只含 root deny、minimal read、绝对任务目录 write 的配置，不混用 legacy sandbox_mode。MXC 不可用、权限 profile 不可用、读写探针失败或生效 profile 不符时，在模型回合前拒绝任务。本环境是 Linux，**Windows MXC 和 Job Object 尚未现场验证**。Linux 增补使用额外 bubblewrap mount/PID namespace 和原生命名权限：不挂载用户主目录或整个项目，取消时清理包括 setsid 后代在内的 namespace。无凭据正向、外部读取与宿主写入探针已通过；后来一次真实项目账号的内置生图也已通过，见下节。参考[官方 Linux 权限说明](https://learn.chatgpt.com/docs/permissions)与 [bubblewrap 手册](https://github.com/containers/bubblewrap/blob/main/bwrap.xml)。

## 搜索和生图

[DeepSeek 官方 Search/Fetch](https://api-docs.deepseek.com/guides/search/) 已有独立 `/v1/tools/search` 和 `/v1/tools/fetch`。当前实现 Search 与 Fetch；固定官方 HTTPS endpoint、128 字符 query、最多 5 条结果、need_content=false。Fetch 返回分段正文并缓存，供 QQ 模型自主调用。上游 Search/Fetch 按请求计费，本项目按标准未缓存输入价换算为既有 token 额度，实际模型 usage 单独保留原始计数；文档宣布 2026-11-01 北京时间起开始计费。新安装默认关闭；当前 VPS 按主人请求开启，实际验证结果见 QQ 人格与工具文档。

Codex 0.164.0 schema 有 `imageGeneration` 事件、savedPath 和 provider 能力查询，但不能据此认定当前账号、DSH 文本 provider 或受限任务已具备生图授权。[官方 feature 定义](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs) 和[工具选择条件](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs) 表明 availability 还受 feature、账号和 provider 影响。真实 Codex 代码任务显式关闭 image_generation；QQ 的 CodexImageProvider 返回 unsupported。Mock 只输出固定测试 PNG，不冒充模型生图，也未使用 OpenAI Image API。随后新增的本机命令行实际验证见下节，QQ 自动交付仍待集成。

## 命令行内置生图补充（2026-10-27）

[官方生图文档](https://learn.chatgpt.com/docs/image-generation)说明 CLI 可描述图片或显式使用 imagegen skill，内置生图使用 Codex 通用额度。本地固定版本 0.164.0 的 `features list` 列出 stable `image_generation`；官方生成的 app-server schema 包含 `imageGeneration` 的 `status`、`savedPath`、`result`/`fileId` 字段。因此新增仅本机明确授权的 `codex-image` 验证命令，普通代码任务仍关闭此能力。

真实 Linux 调用已验证原生事件和项目 CODEX_HOME/generated_images 下的 PNG；详见 [验收](status.md)。本集成只支持本地 PNG 或内联 PNG，不根据模型声称的链接下载文件，不使用单独计费的 Image API。只有远程 fileId 而没有可校验本地数据时仍失败关闭。QQ ImageProvider 暂不自动开启该路径。

## 独立 WebUI 与受限工具补充

按 [DeepSeek 官方 Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/) 的非思考模式实现函数调用循环。客户端必须实际执行允许的函数，并将 tool_call_id 匹配的结果回传；模型本身不会执行函数。采用稳定 Chat Completions，不假设 JSON schema 的约束足以授权操作；服务器另行校验名字、参数、路径、开关、次数和预算。

[当前模型说明](https://api-docs.deepseek.com/quick_start/pricing/)列出 `deepseek-flash`，故新 WebUI 默认使用这个名称；旧 `deepseek-v4-flash` 是兼容别名，现有 QQ 配置不被静默覆盖。默认禁用 thinking，避免引入未实现的 reasoning_content 工具回传契约。当前 WebUI 是小型独立调度层，没有声称完整 DSH 或两个 DSH 插件已经接通。
