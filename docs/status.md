# 验收与已知限制

验收日期：2026-10-27。主机为 Ubuntu Linux，Node 24.19.0，依赖固定在 package-lock.json。`npm ci --ignore-scripts` 不需要编译第三方 native addon；SQLite 由 Node 内置提供。

## 已验证

离线测试 28 项，覆盖：

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
- 命令行 Codex 生图的本机审核/登录前置、原生完成事件约束、实际 PNG/路径/CRC/大小校验、拒绝私密路径与软链接、空原生保护目录兼容，以及额外文件整批拒绝。

Mock CLI demo 已实际运行，得到 Mock 聊天、独立任务目录、result.txt 清单、Mock 搜索来源与 Mock PNG。实际文件可在 runtime/outputs 下查看。常驻 Mock 的启动、消息、状态、停止和再次启动也已通过 scripts/smoke-mock.mjs 实测，结果保存在 runtime/cli-smoke.json。测试和 demo 不访问真实 QQ 或模型服务。

Linux 增补已实测：`sandbox-check` 的正向读写、工作区外与 Codex 状态目录哨兵不可读、宿主越界写入不落盘；PID namespace 中使用 setsid 脱离原进程组的子进程也会随取消停止。没有登录、没有模型回合，不能据此宣称真实账号端到端任务已验证。

初始验收中，官方 Codex 0.164.0 完成了无登录 `generate-json-schema --experimental`、initialize/initialized、account/read、permissionProfile/list，当时项目账号为空、模型回合为 0。随后用户手动完成项目专用 ChatGPT 设备码登录；真实命令行生图验收见下节。默认 shell 执行沙箱会干扰 Node 测试子进程管道，因此涉及进程/loopback 的验收使用经工具批准的开发执行环境；这是测试夹具运行环境，不是以关闭 Codex sandbox 执行群任务。

## Linux 命令行真实生图验收

用户明确授权后，已执行 `bash scripts/manage.sh codex-image --reviewed '蓝色小鱼吉祥物描述'`。代码通过项目内官方 Codex app-server 发起一个真实回合，收到一个原生 `imageGeneration` 完成事件；使用 ChatGPT 项目账号，不调用当前助手的 imagegen 或独立 Image API。真实调用沿用 Linux 外层隔离、命名权限、正向/越界探针与进程终止。

首次调用耗时约 37.3 秒，原图保存在项目 CODEX_HOME/generated_images，已捕获并通过 PNG 校验。第一次发布曾因 Codex 自动创建的空 `.git/.codex/.agents/.aws` 保护目录而拒绝；修正收集逻辑后，只对同一张现有图片重新做本地校验和发布，没有再次请求模型或生图。新增离线回归覆盖这个情况，并继续拒绝任何额外文件。

- 任务 ID：`9f1b8d49-1ac2-4edc-bd68-b648054f645d`。
- 产物：`runtime/outputs/9f1b8d49-1ac2-4edc-bd68-b648054f645d/image.png`，1254 × 1254，1,290,380 bytes。
- SHA-256：`cc167acd36c8744a7332b888222a0d5ac32cbb641021b6b11b09b4acd4cb18d1`。
- 最终报告：`runtime/logs/codex-image-last.json`；原始发布失败报告保留为 `runtime/logs/codex-image-first-attempt.json`。
- 正式 SQLite 已计入一次 Codex 任务、一次生图；没有自动重试或复原次数。账号、图片、日志和数据库均被 Git 忽略。

这证明当前 Linux 主机上的单次命令行 Codex 内置生图路径可用。尚未证明 QQ 图片 provider、本机 Windows、图片编辑、批量生成或只有远程 fileId 的结果获取。

## 尚未证明 / 未完成

| 功能 | 当前状态 |
| --- | --- |
| 真实 QQ 消息接收和发送 | 已实现官方 SDK 适配；没有真实账号烟测，需用户扫码和授权 |
| 全量普通群消息权限 | 账号未验证；仅根据实际收到的原生事件报告 observed，不保证完整性 |
| DeepSeek Chat/Search | 请求代码和离线测试完成；无真实密钥调用，不保证当前账号模型/服务授权 |
| DSH 完整运行时及两个插件直接集成 | 没有安装或接通；采用小型独立调度层，理由见 research.md |
| 真实 Codex 执行 | Linux 的项目专用 ChatGPT 登录及一次真实内置生图回合已通过；普通代码任务、QQ 任务端到端和 Windows MXC/Job Object 仍待验证 |
| 私人文件严格隔离 | Linux 有空挂载视图 + native profile 的局部实测证据，不能视作通用安全证明；无人值守禁用 |
| 真正 Codex 生图 | 新增本机 codex-image 命令，Linux 上一次真实生图及产物发布已验证；QQ 的 experimental provider 仍返回 unsupported，不调用独立 Image API |
| 网页 Fetch | 未暴露；只提供官方 Search API，避免任意 URL 访问 |
| 产物/终态结果自动长期归档 | 暂未实现；数量/单次大小有限制，终态结果和产物可由本机用户停机清理 |
| 语义话题识别 | 当前是本地关键词和时间启发式，不是额外模型分类器 |
| Windows 原生测试 | 需要在目标机验证 PowerShell/.NET launcher、MXC 支持、junction 行为和真实取消 |

其他真实链路仍需用户手动完成相应账号配置和最小验证。不要为了“打通”关闭沙箱、改用全盘权限、开启 DSH 自动审批、复制原有 Codex 凭据或使用付费 Image API。
