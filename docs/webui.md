# 本地 WebUI

根目录 `./start.sh`（Linux）或 `start.bat`（Windows）会检查 Node >=24.9，依赖缺失时在项目内执行 `npm ci --ignore-scripts`，构建后启动 WebUI 并请求系统默认浏览器打开本地地址。Linux 若没有兼容 Node，会先通过 Python 3 + tar 自动下载并校验官方便携版 Node/npm，保存在 runtime/tools/node；不需要全局安装。Windows 当前仍需先准备 Node/npm。没有桌面环境时打印手动访问提示；`--no-open` 不调用浏览器，`--mock` 使用明确标记的离线演示。首次准备需要访问 nodejs.org/npm。也可先 `npm ci --ignore-scripts && npm run build`，随后 `npm run webui`。

## 连接与对话

服务只绑定 IPv4 `127.0.0.1:17862`。浏览器自动连接使用随机、5 分钟有效、单次消费的 URL fragment，前端立即从地址栏删除；页面 API 需要本机令牌，令牌只保存在当前浏览器会话。手动打开页面时，从 `runtime/data/webui-admin-token` 复制令牌。固定 Host、同源检查、CSP、无外部脚本资源限制 DNS rebinding、跨站请求和脚本注入。

连接失效时，重新运行根目录启动脚本即可。若服务已运行，新脚本使用项目令牌向该服务申请新的一次性连接，再打开默认浏览器；不重置凭据、不恢复失效链接、不重放消息。此时沿用已运行服务的正式/Mock 模式，需要切换模式时先 `npm run cli -- web-stop` 再启动。

设置窗口允许填写 Key、模型、输出上限和每日全局 token 上限，并单独开启搜索/Codex 排队。Key 只写到 `runtime/data/webui-secrets.json`，在 POSIX 上新文件为 0600；也可从项目 `.env` 读取。配置接口只返回 credentialPresent，不返回 Key。不要在聊天中粘贴密钥。保存配置不验证余额或发起请求；HTTP 401/402/429 等错误在实际发送消息时显示。正式/Mock 共享本机连接令牌和密钥文件，但使用不同会话数据库与 Mock 预算，Mock 不发真实 HTTP。

模型默认 `deepseek-flash`。采用[官方非思考模式 Function Calling](https://api-docs.deepseek.com/guides/tool_calls/)的 assistant.tool_calls → tool.tool_call_id → assistant 循环；请求固定发往 `https://api.deepseek.com/chat/completions`，禁止重定向和自定义内网 endpoint。不依赖 OpenAI SDK，不额外引入前端构建链。主模型每轮非流式返回；浏览器通过 NDJSON 实时显示请求阶段、工具结果和最终文字，**不是 token 级输出流**。

默认人设是鲸酱，昵称“小鱼”，共用 `prompts/whalechan-rp.txt` 的简短 RP。服务器把固定外观文字加入 system prompt；不会把设定图的像素逐轮发给 DeepSeek，也不声称纯文本对话已经看过图片。用户原图保存在本机 runtime/character；Codex CLI 或本机 WebUI 的明确自画像请求才附上真实参考图，缺图或原生事件未记录使用该图时失败。人设本身不增加工具或审批权限。来源与许可见 [人设说明](../prompts/README.md)。

每个会话有独立服务器端上下文，只发送最近 3 个完整成功回合、合计约 24 KiB 的历史；不接受浏览器提交伪造 system/tool 历史。失败或取消的未完成工具链不加入后续上下文。最多 50 个会话、每会话 100 条用户消息；达到上限时需要本机维护数据库。当前未提供永久删除/重命名会话界面，历史与文件不会自动长期归档。

## 工具与权限

| 工具 | 服务器侧约束 |
| --- | --- |
| list_files | 只扫描当前会话固定工作区；条目数、深度、路径、链接检查 |
| read_file | 工作区内白名单文本类型；64 KiB；不读取 dotfile、凭据命名或链接 |
| write_file | 同上；最多 20 文件 / 合计 1 MiB；不写项目源码；临时文件后原子替换 |
| search_web | 设置默认关闭；复用 SearchService 的 query、公开 URL、缓存、次数预算检查 |
| queue_codex | 设置默认关闭；只创建 waiting 任务，返回明确待审状态；没有授权工具 |

普通聊天完全不向 API 提供文件/任务工具，收到意外工具调用也拒绝；当前用户消息明确要求画图时，服务器选择下面的独立单张生图流程。受限模式只暴露上表当前允许的工具；服务器验证名字、参数字段、类型和实际权限，模型输出无法开启设置。文件工作区由服务器按 UUID 生成在 `runtime/workspace/web-UUID/`；拒绝绝对路径、../、Windows ADS/设备名、symlink/junction、硬链接、隐藏路径和任意执行文件。模型不会获得操作系统 shell 或项目目录访问能力，文件限制由 Node 工具处理器执行，不依赖 prompt 充当文件隔离。

下载只通过受认证的文件接口，强制 `Content-Disposition: attachment`、`text/plain` 和 sandbox CSP；HTML/SVG/脚本不会在工作台页面执行。所有动态消息和工具结果用 textContent 渲染，代码块不执行、不解析任意 HTML。

Codex 待审任务在右侧显示请求、状态和终端审核命令：

```bash
npm run cli -- web-status
npm run cli -- web-approve 任务UUID --reviewed
```

审核前核对任务 request/brief。真实执行仍使用既有项目 ChatGPT 登录、生成的独立 Codex UUID 工作区、隔离探针与 Linux/Windows 边界。没有将会话文件隐式复制给 Codex；需要上下文时，应在待审任务说明中明确提供可公开内容。任务结果与清单进入既有 runtime/outputs；当前 WebUI 只展示状态/摘要，没有嵌入执行终端；图片使用下面独立的生图入口。

## 请求图片 → 自主设计 → Codex 生图

直接发送“帮我生成一张猫猫图”“给个自拍”或“画一张你自己的图，场景你来设计”。页面也有「画图」模式，适合只输入“窗边喝茶，水彩风”这样的简短想法。明确请求即授权本次最多一张，不再要求第二次 CLI 审批；普通聊天、文件内容、工具结果和历史都不能自行授权图片任务。问题、教程、代码和否定句不会按关键字直接出图；自动识别较保守，未识别时可手动选「画图」。

1. 代码先检查项目 Codex 登录、设定图（自画像时）与当前剩余额度；不满足时在模型调用前返回原因。
2. DeepSeek 收到单独的画面设计指引，自主补齐主体、场景与动作、画风、构图比例、光线、配色、细节与避免项，不追问未指定的细节。只接受一次 `generate_image` 结构化方案，字段/类型/长度及调用数量均由服务器校验。不会同时提供 shell、文件、搜索或普通 Codex 工具。
3. 页面显示方案卡片，代码把原始请求与方案一起交给项目官方 Codex app-server，单次启用内置生图，禁用 shell、外部 MCP/插件；沿用每次隔离探针和生成的 UUID 工作目录。没有调用本聊天助手的 ImageGen 或单独付费 Image API。
4. 自画像身份由当前用户原始请求确定，DeepSeek 改写后也不会丢失。代码将本机鲸酱设定图以 `localImage` 附给 Codex，必须在原生完成事件看到匹配的参考路径和 SHA-256；不匹配拒绝发布。
5. 进程停止后，只接受一张原生 `imageGeneration` 完成的 PNG，校验路径、大小、CRC 和产物清单，再存到 `runtime/outputs/UUID/image.png`。会话只记录自己的图片 ID、方案和清单；预览/下载通过本机鉴权接口，逐次复核归属与 SHA-256。刷新后图片和方案仍能显示，不接受模型声称的文件或成功状态。

正式生图同时占用共享 `fish.sqlite` 的一个 Codex 任务、一次生图及最长执行时长，两项次数原子预留，默认每日 20 张；共享 Codex 任务上限配套为每日 22 次、总时长 6600000 ms，仍保持单个真实任务并发。失败/取消不自动重试，已经预留的次数保留。单次 Codex 默认 300 秒，连同规划有界等待；可用停止按钮取消。普通 Codex 排队仍需要原有 CLI 审核，不因画图请求获得权限。`--mock` 使用固定 1×1 PNG 测试占位，页面明确标记离线演示，不是 AI 作品，不消费正式预算。

项目未登录时运行 `bash scripts/manage.sh codex-login --device-auth`；Windows 对应 `npm run cli -- codex-login --device-auth`。使用项目自己的 ChatGPT 登录，不复制系统现有 Codex 凭据。设定图仍需本机 `runtime/character/whalechan-reference.png`，不会公开到 GitHub。

## Codex 额度监视与本地 Reset

启动后右侧显示项目 Codex 账号的周剩余额度、接口实际提供的其他窗口、重置时间和 Credits（仅服务端提供时）。按 `100 - usedPercent` 计算剩余，按 `windowDurationMins=10080` 识别周窗口，优先读取 `rateLimitsByLimitId` 多池视图；不会把缺失值显示成 0 或推算剩余图片张数。多池策略取返回窗口中最小剩余比例，任一池明确受限就暂停。

监视器使用项目原有登录，由官方 app-server 处理认证。仅建立握手/权限 profile 检查并调用 `account/rateLimits/read`，不创建 thread/turn，不读取、复制或将 Token 返回浏览器，也不使用桌面助手自身的账号额度。启动读取一次、每 5 分钟刷新、接收 `account/rateLimits/updated` 后重读完整快照，页面每 6 秒取本机状态；也可手动刷新。稀疏通知不直接覆盖完整数据；读取超时为 15 秒，失败或快照过期时限制自动任务。重复后台读取合并，手动刷新至少间隔 5 秒。

- 剩余 **>30%**：允许本次明确图片请求自动执行。
- 剩余 **10%～30%**：模型规划前要求页面人工确认，仅授权同一条请求的一张图片；发送时重新检查，确认不能覆盖 <10% 或限流状态。
- 剩余 **<10%**、服务端明确禁止普通用量、数据缺失：暂停生图。
- 生图前（规划前与实际派发前）重新读取；完成或失败后刷新，并记录同一窗口的用量百分点变化。重置时间变化、用量下降或数据缺失时不强行比较。变化可能包含其他客户端调用，不作为精确单图成本。
- 原生 RPC/turn 的结构化 429 或 rateLimitExceeded/usageLimitExceeded 触发暂停，使用结构化重试时间（如提供），否则至少等待 60 秒。恢复必须得到新的服务端 `ordinaryUsageAllowed=true` 及允许的窗口状态，不凭时间过去推断恢复；退避状态跨重启保留。生图无自动重试。

**Reset 本地计数** 需要在本机页面点击并确认。操作清零当天项目 `image` 计数，释放新版图片关联的 Codex 次数/已结算时长，保留 reservations、audit、累计 imageAttempts、历史图片与普通 Codex/API 用量。旧版本没有关联记录的 Codex 消耗不会回溯抵扣。有任务进行中或 image/Codex 用量状态未知时拒绝 reset；模型没有此工具。Reset 不修改官方额度、Credits、限流状态，不调用服务端的额度重置/兑换接口。

接口与通知依据 [官方 Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)；以项目锁定版本的协议与服务端真实返回为准。Windows 继承原有 MXC 边界，仍待 Windows 实机验证。

## 预算、取消与持久化

正式模式复用 `runtime/data/fish.sqlite` 的全局额度，QQ 与 WebUI 的调用合并统计。会话/任务记录在 `webui.sqlite`；Mock 使用 `webui-mock.sqlite` 和 `webui-mock-budget.sqlite`，不污染正式账本。每轮 API 请求在发送前按序列化消息、工具 schema、输出上限原子预留，按真实 usage 结算；无有效 usage 的失败保留预留，异常超额锁住后续请求。默认全局 120000 tokens、每用户每日 50 次模型请求；工具循环中的每轮也算请求。输出默认 1024，上限可设 128–4096。

普通消息最多 4 次模型请求、6 次工具调用、120 秒；图片流程最多 1 次规划请求、1 次 Codex 生图、配置的 Codex 超时加 90 秒，总并发最多 2 个会话，同一会话只允许 1 条处理中消息。第 4 轮请求禁止再调用工具；若 provider 不遵守，服务器拒绝执行。停止按钮断开流并中止上游 fetch；已经完成的文件写入和已经发生的 API 用量不会回滚。进程重启不自动重放消息/任务，运行状态变为失败；QQ 的恢复不会释放 WebUI 活跃 Codex 预留。

Ctrl+C 或 `npm run cli -- web-stop` 停止服务。项目运行数据、缓存、配置与截图均在 runtime；系统浏览器自身的配置/缓存仍由浏览器正常管理，这是用户要求打开默认浏览器的正常行为。

## 验证范围

2026-10-27：51 项自动化测试通过，新增 WebUI 测试覆盖官方请求格式/工具回传、每轮 usage、会话隔离、文件限额/链接/路径、未开启工具拒绝、循环上限、取消、全局预算、本机鉴权与 bootstrap 重放拒绝、下载安全头及 Codex 待审；新增画图请求识别、结构化设计方案、单次代码 runner 调用、改写后角色参考传递、失败/取消不重试、预算原子预留、图片归属及哈希复核。

Linux 根目录启动脚本已从项目外目录启动成功；默认浏览器调用使用项目内替身捕获并核对实际参数，一次性连接在真实浏览器验证成功。浏览器已验证新会话、Mock 文件创建及结果显示、工作区隔离、设置窗口、正式模式无 Key 也能启动。Windows BAT 提供源码与 Node 启动路径，尚未在 Windows 机器实跑；真实 DeepSeek 调用仍需用户填写 Key 后验收。

新增 WebUI 画图链路通过离线测试与浏览器验收，未在此次功能更新中追加真实生图。Codex 额度已用项目账号调用官方 `account/rateLimits/read` 实测，实际账号只返回一个 10080 分钟周窗口；不假设周额度一定在 secondary 字段。真实 DeepSeek → Codex 生图仍需实际请求验收。
