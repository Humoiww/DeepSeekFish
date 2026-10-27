# DeepSeekFish

运行在 Linux / Windows 本机的 QQ 群 DeepSeek 机器人 MVP。普通聊天先在本地归并和判断；模型、搜索、任务均经过 SQLite 额度检查。管理员群命令可以提出 Codex 任务，但真实执行必须由本机逐次审核。

**当前状态：Linux 和 Windows 均可部署 QQ / DeepSeek / Mock；Linux 隔离探针、进程取消及一次命令行 Codex 内置生图已实测。真实 QQ / DeepSeek 仍需配置账号后验证，Windows MXC 尚未现场验证。Codex、自动插话、搜索、群聊生图默认关闭，Codex 每任务必须本机审核。**

## 本地 WebUI：独立对话与受限助手

默认角色为鲸酱（Whale-chan，昵称“小鱼”）。简短 RP 在 [prompts/whalechan-rp.txt](prompts/whalechan-rp.txt)，QQ 与 WebUI 共用；外观按用户提供的蓝发鲸鳍耳女仆设定图固定。原图只存本机 `runtime/character/whalechan-reference.png`，不上传 Git。人设来源和文本许可见 [prompts/README.md](prompts/README.md)。

不需要 QQ 账号。在仓库根目录运行即可。Linux 已有 Node.js **24.9+** 时直接使用；缺少或版本过旧时，脚本会用 Python 3 + tar 从 Node.js 官网下载已固定 SHA-256 的便携版 Node/npm，安装到 `runtime/tools/node/`。首次准备需要联网，不需要 sudo，不修改系统 Node、Conda 或 shell 配置。Windows 目前仍需已有 Node.js **24.9+**（含 npm），或手动放置官方便携版。

```bash
# Linux：自动准备项目内 Node/npm（如缺少）、安装依赖、构建并打开浏览器
./start.sh
# 无桌面 / SSH：只启动服务
./start.sh --no-open
# 无 API Key 的离线演示
./start.sh --mock
```

Windows 双击根目录 **`start.bat`**，或在终端执行 `start.bat --mock`。脚本不需要管理员权限，不修改系统策略，不安装全局包。已有的 `scripts/start.sh` / `scripts/start.ps1` 仍用于 QQ 机器人。

WebUI 地址为 **http://127.0.0.1:17862**，与 QQ 管理页的 17861 端口分开。自动打开时使用一次性本机连接；手动打开时，输入 `runtime/data/webui-admin-token` 中的令牌。首次点击「连接与设置」，填入 DeepSeek API Key 并保存即可对话；保存设置本身不会调用模型。Key 仅写入被忽略的 `runtime/data/webui-secrets.json`，服务器也可读取项目 `.env` 的 `DEEPSEEK_API_KEY`，不会将 Key 回传前端。

- **纯对话**：多轮独立会话，无模型工具；支持代码块、停止请求、历史恢复。
- **受限助手**：DeepSeek 使用官方 Function Calling，列出、读取和写入本次会话的文本文件；界面展示真实工具结果，文件可以下载。
- **可选操作**：设置中明确开启后才提供公开搜索、提交 Codex 待审任务。Codex 仍需在本机终端运行 `npm run cli -- web-approve 任务UUID --reviewed`；模型和网页按钮都不能自动批准。
- **固定边界**：无任意 shell、删除、依赖安装、凭据读取、其他项目访问、任意 URL Fetch 或自动生图；每条消息最多 4 次模型请求、6 次工具调用。每会话最多 20 个文本文件，单文件 64 KiB、总计 1 MiB。

会话文件位于 `runtime/workspace/web-UUID/`。正式 WebUI 与 QQ、命令行真实任务共享 `fish.sqlite` 的预算账本；Mock 的会话与预算独立。关闭终端 Ctrl+C，或执行 `npm run cli -- web-stop`。远程 Linux 可通过 `ssh -N -L 17862:127.0.0.1:17862 用户@服务器` 在自己电脑打开页面，不要把服务绑定公网。

完整说明见 [WebUI](docs/webui.md)。目前浏览器流程及官方 API 请求格式已用 Mock/假 HTTP 验证；真实 DeepSeek 验收需要你在本机页面配置自己的 Key。

## Linux 快速部署

需要 Bash；Linux x64 / arm64 缺少 Node 时，脚本可通过 Python 3 + tar 自动准备官方便携版 Node/npm。支持 npm 官方 Codex payload 提供的 Linux x64 / arm64。普通聊天、搜索和 Mock 不需要 Docker、systemd 或 bubblewrap，也不需要 sudo。也可使用已有 Node.js **24.9+** 和 npm，或把[官方 Node 便携发行包](https://nodejs.org/en/download)手动解压到 `runtime/tools/node/`。

```bash
git clone https://github.com/Humoiww/DeepSeekFish.git
cd DeepSeekFish
bash scripts/install.sh
bash scripts/manage.sh demo
bash scripts/start.sh --mock
```

这些脚本从自身位置定位项目，临时设置本进程 PATH、TEMP 和 npm 缓存，不改 shell 配置或全局包。已有 Node/npm 也可以直接运行 `npm ci --ignore-scripts && npm run build`、`npm run demo`、`npm run mock`。`install.sh` 不覆盖你已有的 `.env` 或配置。

Mock 启动后，在第二个终端：

```bash
bash scripts/manage.sh say '你好小鱼'
bash scripts/manage.sh status
bash scripts/manage.sh stop
```

正式部署先保留本地配置，再绑定 QQ：

```bash
# 文件已存在时不要覆盖；填写 API Key、群与管理员 openid。
cp -n .env.example .env
cp -n config/example.json config/local.json
chmod 600 .env config/local.json
# 用自己的编辑器填写这两个文件，再扫码。
bash scripts/manage.sh bind
bash scripts/manage.sh doctor
bash scripts/start.sh
```

`bind` 的二维码可在 SSH 终端扫描。无浏览器的 Linux 如需 Codex 账号，使用 `bash scripts/manage.sh codex-login --device-auth`；账号可能需要先允许设备码登录。不复制现有 `~/.codex/auth.json`。

前台用 Ctrl+C；在另一个终端执行 `bash scripts/manage.sh stop` 也能关闭。需要退出 SSH 后继续运行时，可在安装完成后手动启动：

```bash
nohup bash scripts/start.sh > runtime/logs/console.log 2>&1 &
# 查看状态 / 关闭 / 再次运行上面一行以重启
bash scripts/manage.sh status
bash scripts/manage.sh stop
```

管理服务始终只绑定 `127.0.0.1:17861`。如果部署在远程 Linux，请在自己电脑执行 `ssh -N -L 17861:127.0.0.1:17861 用户@服务器`，然后访问本机 `http://127.0.0.1:17861`，不需要对外放行管理端口。

### Linux 的真实 Codex（可选）

聊天功能不依赖这一节。真实 Codex 额外要求 bubblewrap 和允许创建 user / mount / PID namespace 的内核/主机策略。程序优先使用已有 `/usr/bin/bwrap`，否则尝试项目内官方 Codex payload 附带的 helper；不会自动安装系统包或修改 AppArmor、sysctl。

```bash
# 不需要任何 API Key，也不启动模型，先验证当前机器的隔离边界。
bash scripts/manage.sh sandbox-check
# 仅当结果 ok:true 后，再由你手动完成项目专用 ChatGPT 登录。
bash scripts/manage.sh codex-login --device-auth
# 先保持正式机器人运行；下面在第二个终端操作。
bash scripts/manage.sh set codex true
bash scripts/manage.sh tasks
# 核对群管理员提出的 request 和 DeepSeek 整理的 brief 后逐次授权。
bash scripts/manage.sh approve 任务UUID --reviewed
```

Linux launcher 为整个 app-server 创建空的挂载视图和独立 PID 命名空间，只挂载系统运行文件、官方依赖、项目 Codex 状态、临时目录和本次任务目录。不会把整个项目、用户主目录或其他项目挂进去；Codex 原生命令沙箱再限制凭据目录和命令网络。每次任务都重跑正向读写及越界探针，取消/超时会销毁命名空间，包含另起 session 的子进程。

`sandbox-check` 失败时，仍可用聊天、搜索和 Mock，真实任务会失败关闭。在限制 user namespace 的容器、某些 AppArmor/主机策略下需要管理员另行提供受支持环境；不要用 sudo 运行机器人、全盘挂载、危险模式或关闭系统安全策略来绕过。探针是当前机器的局部证据，不是所有工具/内核路径的安全证明。

详细排错、目录边界和无头登录说明见 [Linux 部署](docs/linux.md)。

## Windows 快速开始

需要 Node.js **24.9+** 和 npm（建议现有 Node 24 LTS），Git 仅用于仓库管理。可将官方便携 Node 解压到 `runtime/tools/node/` 后在当前 PowerShell 会话加入 PATH；本项目不安装系统软件或全局包。真实 Codex 实验模式还需要支持 MXC 的 Windows 11，参见[权限边界](docs/security.md)。

```powershell
cd 路径\DeepSeekFish
npm ci --ignore-scripts
npm run build
npm test
npm run demo
npm run mock
```

或者在允许本地脚本的 PowerShell 会话中执行 `./scripts/install.ps1`、`./scripts/start.ps1 -Mock`。不需要更改全局 ExecutionPolicy。`.npmrc` 把 npm 缓存写入 `runtime/cache/npm/`。

`demo` 会运行一次聊天→任务规划→模拟本机审批→Mock Codex→产物校验→结果回复，再演示 Mock 搜索和 PNG。它不会使用 QQ、模型或图像服务。`Mock` 使用 `demo-group` / `demo-admin`（配置非空时使用你的白名单）。Demo、Mock、Live 分别使用不同 SQLite 文件；三者预算互不污染。

Mock 保持运行时，在第二个终端操作：

```powershell
npm run cli -- say "你好小鱼"
npm run cli -- status
npm run cli -- set codex true
npm run cli -- say "/fish codex 创建 hello.txt"
npm run cli -- tasks
# 先核对 request 和 brief，再把下面 ID 换成实际任务 UUID
npm run cli -- approve 任务UUID --reviewed
npm run cli -- tasks
npm run cli -- stop
```

本机状态页为 <http://127.0.0.1:17861>。它只监听 IPv4 loopback；页面输入 `runtime/data/admin-token` 中的本机令牌。管理 API 也需要令牌，并检查 Host / Origin；不开放公网。授权任务只能用本地 CLI，没有群聊审批按钮。

## 配置真实机器人

1. 复制 `.env.example` 为 `.env`，填入自己的 `DEEPSEEK_API_KEY`。模型默认 `deepseek-v4-flash`，可在本地配置中改为账号实际可用模型。
2. 执行 `npm run bind`，用 QQ 扫终端二维码，选择一个机器人。腾讯官方 connector 负责扫码，凭据仅保存到被忽略的 `runtime/data/qq-credentials.json`。已有开放平台机器人也可在 `.env` 填入 `QQBOT_APPID` / `QQBOT_SECRET`。
3. 复制 `config/example.json` 为 `config/local.json`，填入群 `group_openid`、管理员 `member_openid`。**它们不是 QQ 号。** 可从 QQ 开放平台调试事件取得；本程序不向未列入白名单的群回复或保存内容。
4. 在开放平台/机器人管理中把机器人加入授权群，核实事件权限。仅收到 `GROUP_AT_MESSAGE_CREATE` 时就按 @ 模式使用；收到该群的 `GROUP_MESSAGE_CREATE` 后，状态才显示普通消息已观察到。这不证明有全部历史或全部消息权限。
5. 执行 `npm run doctor`、`npm start`，用白名单群中的一次 @ 做最小验证。此步骤会使用你配置的 API 额度，由你手动发起。

没有凭据时请用 Mock。程序不会自动创建账号、付费资源或发起模型健康检查。

## 群命令

| 命令 | 权限与行为 |
| --- | --- |
| `@小鱼 你好` / 呼唤“小鱼” | 已授权消息中的常规聊天，归并后回复 |
| `/fish search 查询` | 群白名单内可用；需本机开启搜索；返回来源链接 |
| `/fish codex 具体任务` | 仅管理员；DeepSeek 整理独立任务说明，排入本机待审队列 |
| `/fish cancel UUID` | 仅管理员；只取消本群任务，运行中任务会触发真实进程终止 |
| `/fish result UUID` | 只读取本群任务；超出被动回复窗口后用新命令领取 |
| `/fish image 描述` | 仅管理员且需开启；Mock 返回测试 PNG，真实提供者返回 unsupported |

默认只响应 @ 和直接呼唤；`autoReply` 开启后每个归并窗口自动回复。`autonomous` 开启后，兴趣话题、补充机会和低概率随机插话还要满足活跃度、话题延续、冷却、夜间安静与每日限额。不会每条消息都调用模型。平台没给普通消息时，任何开关都不能补出消息权限。

## 本机管理

```powershell
npm run cli -- set enabled false
npm run cli -- set autonomous true
npm run cli -- set search true
npm run cli -- set codex true
npm run cli -- set dailyTokens 120000
npm run cli -- history 群OPENID
npm run cli -- clear 群OPENID
npm run cli -- cancel 任务UUID
npm run cli -- status
npm run cli -- stop
```

关闭机器人或 Codex 会同时请求停止当前任务。Ctrl+C 也会优雅关闭；再次运行相同启动命令即可重启。正常模式需先启动进程，管理 CLI 通过本机认证 API 操作。群/管理员白名单在 `config/local.json` 中修改后重启。管理开关持久化到各模式 SQLite，优先于 JSON 中同名设置。

## Codex 本机授权实验

项目内安装官方 `@openai/codex@0.164.0`。**不读取、复制或更改你原有的 Codex 登录数据。** 若要尝试真实执行，先在本机运行：

```powershell
npm run cli -- codex-login
npm run doctor
npm start
# 第二个终端，或启动前在 config/local.json 开启 codex
npm run cli -- set codex true
npm run cli -- tasks
npm run cli -- approve 任务UUID --reviewed
```

`codex-login` 使用官方 ChatGPT 登录流程，新登录数据写入 `runtime/codex-home/`，不复用现有用户目录。只接受 ChatGPT 账号类型，不用 OpenAI API Key 代替订阅额度。已有项目登录后不要重复登录。项目 CLI 不会自动安装 Linux 系统依赖、启用 MXC 或修改系统权限。无浏览器时可追加 `--device-auth`；此参数会传给官方登录程序。

真实 runner 支持 Linux 和 Windows。Linux 使用 bubblewrap 挂载/PID 命名空间，Windows 强制 MXC 与 Job Object；两者都采用命名权限配置、禁用提权/外部 MCP，并在模型回合前运行隔离探针。可先执行 `npm run cli -- sandbox-check` 做不计费检查。必要能力缺失时失败关闭，**不提供无人值守开启开关，Windows 原生隔离仍待现场验证**。

任务在 `runtime/workspace/UUID/` 执行，校验后的产物复制到 `runtime/outputs/UUID/`，附文件大小和 SHA-256 清单。QQ 一次最多发送摘要及 3 个文件，更多文件在本地查看。任务/结果失败会明确报告；原触发消息过期时结果保留，需 `/fish result UUID` 重新领取。

### 命令行调用 Codex 生图（实验）

本机可以单独发起一次 Codex 内置生图测试。先构建、完成项目专用 ChatGPT 登录并通过 `sandbox-check`：

```bash
bash scripts/manage.sh codex-login --device-auth
bash scripts/manage.sh sandbox-check
bash scripts/manage.sh codex-image --reviewed '生成一张戴耳机的蓝色小鱼吉祥物，简洁插画，浅色背景，无文字，只生成一张 PNG'
```

Windows 对应命令为 `npm run cli -- codex-image --reviewed "图片描述"`。`--reviewed` 表示本机明确授权这一张图；不需要启动 QQ，也不改变群聊的 Codex/生图开关。代码启动项目内的官方 Codex app-server，仅为本次调用打开内置 `image_generation`，禁用 shell、外部 MCP 和插件，保留原有文件/网络隔离与逐次探针。不会调用当前聊天助手的生图工具，也不使用单独计费的 Image API。

只有收到 Codex 原生 `imageGeneration` 完成事件，并校验实际 PNG 的路径、大小和 CRC 后，才发布到 `runtime/outputs/UUID/image.png`，输出 SHA-256 清单。支持收集项目 `CODEX_HOME/generated_images/` 中的实际图片或协议内联 PNG；只有远程 fileId 而无本地文件/内联数据时明确失败。不接受模型文字声称的成功、任意路径或代码绘制的替代图。诊断结果保存在 `runtime/logs/codex-image-last.json`，不保存原始协议、图片 base64 或登录信息。

这会使用你的 Codex 订阅额度，并在调用前占用正式 SQLite 中的一个 Codex 任务及一次生图次数；失败不会自动重试或退回次数。普通 Codex 任务仍关闭生图，QQ 的实验性 ImageProvider 仍返回 `unsupported`；此命令不代表 QQ 生图链路已验证。内置生图能力及额度参见[官方文档](https://learn.chatgpt.com/docs/image-generation)。

提示词出现“你自己 / 自画像 / 自拍 / 鲸酱”时，CLI 会把本机角色参考图复制到该次独立任务目录，并以 `localImage` 附给 Codex，要求内置生图工具实际使用该图。原生完成事件的 inputImages 路径和 SHA-256 必须匹配，否则拒绝发布；缺图时明确返回 `CHARACTER_REFERENCE_MISSING`。其他机器需自行把有权使用的设定 PNG 放到上述本机路径。普通猫、风景等生图不会附加角色参考。此新增路径已离线验证，没有额外消耗真实生图额度。

## 数据、日志与目录

```text
src/qq, social, agent, budget, storage, codex, search, image, admin
config/             默认配置示例；local.json 被忽略
scripts/            Linux / Windows 安装启动、进程边界、无凭据协议检查
tests/             离线验收、并发预算与实际子进程测试
docs/              架构、官方接口、权限、配置、验收状态
runtime/workspace/  每任务工作区
runtime/outputs/    校验产物
runtime/data/       Live/Mock/Demo SQLite、QQ 密钥、本机令牌
runtime/codex-home/ 项目专用 Codex 状态/新登录
runtime/cache/      npm、搜索缓存的本机目录
runtime/tmp/        临时文件
runtime/research/   本次官方接口调查和生成的协议 schema（不提交）
```

最近错误、触发原因、用量、队列由 `status` 展示，持久日志在 SQLite `audit` 表（最近 200 条），控制台仅输出固定状态。`runtime/logs/` 预留，不额外复制原始聊天到日志文件。消息默认只保留每群 20 条且最多 24 小时，每分钟清理；任务请求/说明在终态超过 24 小时后清空，任务结果与产物需按本地需要清理。原始消息不会作为 Codex 上下文传递。

详细说明：[Linux 部署](docs/linux.md)、[架构](docs/architecture.md)、[官方接口调查](docs/research.md)、[安全边界](docs/security.md)、[配置](docs/configuration.md)、[验收和已知限制](docs/status.md)。
