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
| dailyTokens / groupDailyTokens | 120000 / 60000 | 全局 / 每群 DeepSeek token 上限；QQ 私聊使用全局上限，不再额外套用群上限 |
| userDailyRequests / maxOutputTokens | 50 / 256 | 每用户模型调用次数 / 每回合最大输出 |
| search / searchDaily | false / 20 | Search 开关 / 每日出站搜索请求数 |
| searchCount / searchTimeoutMs | 3 / 10000 | 结果数（最多 5）/ 超时 |
| codex / codexDaily | false / 22 | 接受管理员任务 / 共享每日执行尝试数（为 20 次生图和其他任务保留空间） |
| codexTimeoutMs / codexDailyMs | 300000 / 6600000 | 每任务执行超时 / 每日总执行时长上限 |
| maxFiles / maxArtifactBytes | 20 / 10485760 | 产物数量与总大小 |
| images / imageDaily | false / 20 | 群聊生图实验入口 / 每日本地尝试数 |
| port | 17861 | 管理 loopback 端口，修改后重启 |

Codex 调用前预留 timeout+5 秒收尾时间，按实际耗时结算；剩余额度不足最坏时长则拒绝，所以两个接近超时的任务不保证都能获准。搜索/图片/任务的失败尝试保留次数，避免重试绕过预算。未知模型 usage 保留上界费用。`requests` 统计模型回合，因此一次任务的规划与摘要计两次。

所有自然日按 Asia/Shanghai（UTC+8）结算。调低预算到已用额度以下不会退款，后续调用被拒绝。不要在运行时手工编辑 SQLite；`BUDGET_USAGE_FAULT` 表示提供商 usage 与预留上界不符，应先排查服务协议再调整实现。

`status` 展示最后一次模型调用结果，不自动做计费健康探测。QQ 断线状态来自 SDK ready/resumed/disconnected；仅 SDK 接收的原生普通事件可标记普通消息 observed。管理页不展示秘密环境变量。

终态任务 result/manifest 和输出文件暂时长期保留，用户可在停机后按本地需要归档；原始任务请求/brief/source 超过一天清除。数据库计数不会随着清空群历史而被重置。`clear` 清理消息内容，保留短期去重身份，防止重连回放。
