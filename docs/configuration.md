# 配置与运维

`config/local.json` 保存部署白名单和启动配置；复制 `config/example.json` 后修改，它被 Git 忽略。`.env` 放 DeepSeek/可选 QQ 密钥。QQ 扫码密钥、管理令牌、新 Codex 登录也均被忽略。

管理 CLI 必须在常驻进程启动后使用。设置保存在当前模式 SQLite 的 meta.settings 中，覆盖 JSON 同名字段；修改部署白名单需要改 JSON 并重启。数值、开关与列表经过类型和范围校验，不接受未知键。不能通过管理 API 改 admins/groups、文件系统路径或沙箱参数。

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| autonomous / autoReply | false / false | 自主插话 / 每窗口自动回复 |
| probability / activity | 0.02 / 0.5 | 自主命中概率基数 / 人格活跃倍率，不改变权限 |
| cooldownMs / dailyInterjections | 480000 / 12 | 每群自主插话冷却与每日尝试上限 |
| quietHours | [0,7] | 北京时间；开始包含、结束不包含，相同表示关闭夜间限制 |
| windowSize / historyHours | 20 / 24 | 每群消息上限与 TTL，二者取更早删除 |
| bufferMs / maxChars | 1200 / 600 | 归并窗口 / 回复字符上限 |
| dailyCny / groupDailyCny | 5 / 0 | 全局 / 每群人民币日费用上限；群值 0 表示共用全局额度，不另设群限额。WebUI 修改后 QQ 和后台即时读取，支持小数。旧 dailyTokens / groupDailyTokens 不再执行 |
| maxOutputTokens | 256 | 每回合最大输出 |
| provider / usdToCny | deepseek / 7.2 | 默认对话服务与 OpenCode Go 的美元到人民币折算汇率 |
| search | false | 自主联网开关；搜索费用直接计入共享人民币额度，无独立次数上限 |
| searchCount / searchTimeoutMs | 3 / 10000 | 结果数（最多 5）/ 超时 |
| codex | false | 接受管理员提交的普通 Codex 任务 |
| codexTimeoutMs | 300000 | Codex 生图超时 |
| maxFiles / maxArtifactBytes | 20 / 10485760 | 产物数量与总大小 |
| images / imageDaily | false / 20 | 群聊生图实验入口 / 每日本地尝试数 |
| port | 17861 | 管理 loopback 端口，修改后重启 |

Codex 调用前预留 timeout+5 秒收尾时间，按实际耗时结算；剩余额度不足最坏时长则拒绝，所以两个接近超时的任务不保证都能获准。图片/任务的失败尝试保留次数。Search/Fetch 明确未计费的失败或空结果退还预留 token，结果未知仍保留预留。未知模型 usage 保留上界费用。`requests` 仅统计模型回合，因此一次任务的规划与摘要计两次。加载旧配置时会忽略 `userDailyRequests`。

所有自然日按 Asia/Hong_Kong（UTC+8）结算。调低预算到已用额度以下不会退款，后续调用被拒绝。不要在运行时手工编辑 SQLite；`BUDGET_USAGE_FAULT` 表示提供商 usage 与预留上界不符，应先排查服务协议再调整实现。

`status` 展示最后一次模型调用结果，不自动做计费健康探测。QQ 断线状态来自 SDK ready/resumed/disconnected；仅 SDK 接收的原生普通事件可标记普通消息 observed。管理页不展示秘密环境变量。

终态任务 result/manifest 和输出文件暂时长期保留，用户可在停机后按本地需要归档；原始任务请求/brief/source 超过一天清除。数据库计数不会随着清空群历史而被重置。`clear` 清理消息内容，保留短期去重身份，防止重连回放。

人民币计费、5000-token 知识库和旧配置兼容见 [自主联网和知识库](web-knowledge.md)。旧 searchDaily 配置加载时忽略，管理 API 不再提供这个设置。

「连接与设置」可保存和切换 DeepSeek 或 OpenCode Go 预设。预设记录模型、输出上限和密钥槽。对应密钥单独保存在权限为 `0600` 的 `runtime/data/webui-secrets.json`。默认槽可从 `DEEPSEEK_API_KEY` 或 `OPENCODE_API_KEY` 读取。搜索和抓取始终使用默认 DeepSeek 槽；Go 选定模型缺乏视觉能力时，含图片的回合使用默认 DeepSeek 视觉模型并按实际路由入账。

Go 目录仅展示 Chat Completions 模型。费用按目录参考费率折算。缺价时用估算费率；有浮动费率时按目录公布的最高倍数估算。右栏使用当前 Go 密钥读取官方 5 小时、1 周和 1 月已用百分比，重置时间显示为香港时间。重置本地人民币额度保留历史请求和用量，订阅额度继续由 OpenCode 管理。 [OpenCode Go 用量说明](https://opencode.ai/docs/console/go/#usage)

OpenCode Go 的连接和预设可保存 `disableThinking`（默认 `true`）。WebUI 按实际网关验证结果标注模型，支持的模型使用各自的关闭参数，其余模型沿用网关默认思考设置。
