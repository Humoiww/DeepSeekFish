# 验收与已知限制

验收日期：2026-10-27。主机为 Ubuntu Linux，Node 24.19.0，依赖固定在 package-lock.json。`npm ci --ignore-scripts` 不需要编译第三方 native addon；SQLite 由 Node 内置提供。

## 已验证

离线测试 24 项，覆盖：

- 普通消息零模型调用、归并后回复、消息去重、自回声、群白名单和群上下文隔离。
- SocialGate 兴趣/话题变化/活跃窗口、持久冷却、每日插话上限。
- API 调用前 token/每群/每用户限制，真实 usage 结算、未知 usage 不退款、异常 usage 关闭后续请求。
- 四个并发 worker 的独立 SQLite 连接抢占同一额度，累计预留不超过上限；搜索、图片、任务次数与时长/并发限制。
- 非管理员在模型调用前被拒绝；管理员任务先待审，本机授权后才执行；结果摘要与文件清单回传。
- 绝对路径、Windows 路径/ADS/设备名、../、symlink/junction 祖先拒绝；产物类型、硬链接、大小、数量与哈希变更拒绝。
- 任务超时、取消、中断时不发布产物；JSON-RPC fixture 实际创建父/子进程，取消后进程退出且子进程心跳停止，审批请求被拒绝。
- DeepSeek Chat 与 Search 的真实请求格式通过注入假 HTTP 验证；搜索缓存、来源链接、私网 URL 过滤、query 上限和预检查。
- Linux 的挂载白名单、工作目录二次检查、正向探针失败拒绝、越界宿主写入拒绝、PID namespace 中 detached 子进程取消。
- 本机 HTTP 管理接口的令牌、Host、Origin 拒绝，以及开关、任务授权与历史清理。
- Mock PNG 的真实 chunk CRC 校验；损坏图片明确拒绝；CodexImageProvider 明确返回 unsupported。

Mock CLI demo 已实际运行，得到 Mock 聊天、独立任务目录、result.txt 清单、Mock 搜索来源与 Mock PNG。实际文件可在 runtime/outputs 下查看。常驻 Mock 的启动、消息、状态、停止和再次启动也已通过 scripts/smoke-mock.mjs 实测，结果保存在 runtime/cli-smoke.json。测试和 demo 不访问真实 QQ 或模型服务。

Linux 增补已实测：`sandbox-check` 的正向读写、工作区外与 Codex 状态目录哨兵不可读、宿主越界写入不落盘；PID namespace 中使用 setsid 脱离原进程组的子进程也会随取消停止。没有登录、没有模型回合，不能据此宣称真实账号端到端任务已验证。

官方 Codex 0.164.0 已完成无登录 `generate-json-schema --experimental`、initialize/initialized、account/read、permissionProfile/list。项目账号为空，模型回合数为 0。默认 shell 执行沙箱会干扰 Node 测试子进程管道，因此涉及进程/loopback 的验收使用经工具批准的开发执行环境；这是测试夹具运行环境，不是以关闭 Codex sandbox 执行群任务。

## 尚未证明 / 未完成

| 功能 | 当前状态 |
| --- | --- |
| 真实 QQ 消息接收和发送 | 已实现官方 SDK 适配；没有真实账号烟测，需用户扫码和授权 |
| 全量普通群消息权限 | 账号未验证；仅根据实际收到的原生事件报告 observed，不保证完整性 |
| DeepSeek Chat/Search | 请求代码和离线测试完成；无真实密钥调用，不保证当前账号模型/服务授权 |
| DSH 完整运行时及两个插件直接集成 | 没有安装或接通；采用小型独立调度层，理由见 research.md |
| 真实 Codex 执行 | 官方 app-server runner、项目专用登录、本机审批已实现；Linux launcher 与无凭据权限/取消探针已验证；真实账号任务未验证，Windows MXC/Job Object 未现场验证 |
| 私人文件严格隔离 | Linux 有空挂载视图 + native profile 的局部实测证据，不能视作通用安全证明；无人值守禁用 |
| 真正 Codex 生图 | experimental provider 明确 unsupported；没有以固定 PNG 伪装生图；不调用独立 Image API |
| 网页 Fetch | 未暴露；只提供官方 Search API，避免任意 URL 访问 |
| 产物/终态结果自动长期归档 | 暂未实现；数量/单次大小有限制，终态结果和产物可由本机用户停机清理 |
| 语义话题识别 | 当前是本地关键词和时间启发式，不是额外模型分类器 |
| Windows 原生测试 | 需要在目标机验证 PowerShell/.NET launcher、MXC 支持、junction 行为和真实取消 |

真实执行的下一步只能是用户手动完成账号配置和最小验证。不要为了“打通”关闭沙箱、改用全盘权限、开启 DSH 自动审批、复制原有 Codex 凭据或使用付费 Image API。
