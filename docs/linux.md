# Linux 部署与排错

## 安装与数据目录

使用普通用户、Bash 和可写的独立项目目录。不需要 root、Docker 或系统服务安装。缺少 Node >=24.9 时，脚本通过 Python 3 + tar 自动下载官方 Node v24.22.1 的 Linux x64 / arm64 便携包，按源码固定的 SHA-256 校验后安装到 runtime/tools/node；下载缓存和临时解压也在 runtime/tools 内。已有兼容 Node/npm 时不重复下载。其他架构需自行准备 Node，Codex launcher 会报告 `CODEX_LINUX_ARCH_UNSUPPORTED`。便携发行包本身的 libc 要求仍以官方发行说明为准。

执行 `bash scripts/install.sh` 安装项目依赖并构建。脚本优先使用 `runtime/tools/node/bin/node`，否则使用 PATH 中的 Node；也可用绝对路径 `FISH_NODE=/路径/node bash scripts/install.sh`。特殊的本地 npm 布局可通过 `FISH_NPM_CLI=/路径/npm-cli.js` 指定。所有环境变更只影响该进程及子进程，不修改 ~/.bashrc、系统 PATH 或全局包。

依赖、npm 下载缓存、SQLite、QQ 绑定信息和项目专用 Codex 登录均保存在 runtime 内。Linux 进程使用 umask 077；`.env` 和 `config/local.json` 建议权限 600。不要把仓库放在不受信任用户可写的共享目录，既有目录权限仍由部署者管理。

正式部署复制示例配置、填写 API Key 和 openid 后运行 `bash scripts/manage.sh bind`；这会使用官方 QQ 扫码服务。接着运行 `bash scripts/start.sh`。普通聊天、预算、Search API 和管理 CLI 不依赖 Linux Codex 沙箱。没有凭据时用 `bash scripts/start.sh --mock` 或 `bash scripts/manage.sh demo`。

## 无头与远程机器

- QQ 扫码在终端显示，不要求 Linux 图形桌面。
- Codex 新登录使用 `bash scripts/manage.sh codex-login --device-auth`，在你自己的浏览器访问官方给出的地址并输入一次性设备码。账号可能需要开启设备码登录；不支持时停止，不复制其他电脑的现有凭据。
- 管理 UI 只监听 loopback。通过 SSH 端口转发访问，不修改监听地址或防火墙。
- 本版提供前台运行和项目内 nohup 日志示例；不自动安装 systemd unit，不设置开机启动。nohup 控制台日志由部署者轮换，SQLite audit 仍保留最近 200 条。
- 优雅停止用管理 CLI 的 stop 或 SIGTERM / Ctrl+C。不要在进程运行时直接删除 SQLite 文件。

## Linux Codex 实际边界

外层 bubblewrap 建立新 mount/PID/IPC/UTS/user namespace，使用 `--die-with-parent` 和新 session；取消时停止 launcher，PID namespace 会清理另起 session 的后代。挂载视图默认不包含主目录、其他仓库、宿主 /run 或宿主 /proc，也不包含项目 `.env`、QQ 凭据或机器人 SQLite。

仅把必要系统文件、当前 Node 可执行文件（映射到固定的 /opt/deepseekfish-runtime/node）和项目 node_modules 设为只读，把项目 Codex 状态、专用缓存/临时目录和本次任务目录挂入。app-server 为账号通信保留网络；这是可信 harness 的网络，不等于授权其命令联网。内层官方 Codex profile 负责命令文件权限和禁止命令网络：root deny、minimal read、任务目录 write。为启动内层 sandbox，另加官方 native vendor 和项目 `codex-home/tmp/arg0-linux` 的只读权限；不授权读取 auth.json。Linux 明确不使用 legacy Landlock fallback。

独立执行 `sandbox-check` 不创建 thread、不运行模型。它验证命令能在任务目录读写、不能读取任务目录外和 Codex 状态目录的哨兵，并检查越界写入没有出现在宿主文件系统。bubblewrap 的私有 tmpfs 可能允许创建同名的合成文件，这种文件不在宿主落盘，随 namespace 销毁，不能当作任务产物；探针区分这种情况与实际宿主写越界。

每个真实任务仍要重新运行探针，并要求本机 `approve UUID --reviewed`。通过探针不等于证明所有工具和内核路径安全；没有无人值守执行开关。QQ 生图 provider 仍返回 unsupported；本机可单独使用 `bash scripts/manage.sh codex-image --reviewed '图片描述'` 测试一次 Codex 内置生图。此命令已在当前 Linux 主机完成一张真实 PNG 的生成、校验和发布；会占用正式 Codex/图片额度，详见 [验收](status.md)。

## 常见失败

| 现象/错误 | 处理 |
| --- | --- |
| Node 过旧 / node not found | 重试启动脚本自动准备项目运行时；若缺 Python 3/tar 或网络不可用，可手动放官方便携包到 runtime/tools/node |
| QQ_CREDENTIALS_MISSING_RUN_BIND | 先执行本机 bind，或填写本项目 .env 的 QQ 凭据 |
| DEEPSEEK_KEY_MISSING | 在 .env 填入真实 API Key，再重启 |
| CODEX_BWRAP_MISSING | 缺少系统和项目 bundled bwrap；先恢复正确的官方依赖安装，再由管理员决定是否安装系统包 |
| CODEX_NATIVE_PAYLOAD_MISSING | 依赖可能省略 optional packages；按锁文件正常 npm ci，不使用 --omit=optional |
| CODEX_PROCESS_EXIT / CODEX_RPC_REJECTED | bubblewrap 或原生 sandbox 未能启动；检查发行版的 user namespace/AppArmor 策略、容器限制和安装完整性 |
| CODEX_SANDBOX_POSITIVE_CONTROL_FAILED | 连允许的任务目录都无法正常读写；不要把失败命令当作隔离成功 |
| CODEX_READ_ISOLATION_FAILED / CODEX_WRITE_ISOLATION_FAILED | 当前机器未满足所需边界；禁止真实执行，保留聊天/Mock |
| CODEX_PROJECT_LOGIN_REQUIRED | 完成本项目的官方 ChatGPT 登录，不读取或复制原有 ~/.codex/auth.json |
| LOCAL_AUTH_REQUIRED | 管理 CLI 和常驻进程需使用相同项目目录；不要把本机令牌发到群里 |
| 端口被占用 | 停止已有实例，或在 config/local.json 改 port 并重启 |

本程序不替你执行 apt/dnf、sysctl、AppArmor 配置或全局依赖安装。[官方 Linux 沙箱说明](https://learn.chatgpt.com/docs/sandboxing)描述了发行版依赖；只采用符合本项目边界的部署方案，不采用关闭沙箱/全盘权限的替代方案。[设备码登录文档](https://learn.chatgpt.com/docs/auth)用于无头登录。
