# DeepSeekFish VPS 实际部署记录

验收时间：2026-10-29 18:13 左右（北京时间；日志使用 UTC）。

## 当前交付状态

正式 WebUI 已部署到 `/srv/deepseekfish/app`，由 systemd `deepseekfish-web.service` 以独立账户 `deepseekfish`（UID 999，无 sudo、无登录 shell）运行，已 enabled，监听 `127.0.0.1:17862`。原 fishops Mock 已优雅停止。用户目录 `/home/fishops/DeepSeekFish` 保留为管理源码检出。

这是实际运行的正式入口，不带 `--mock`；没有配置真实 DeepSeek Key、QQ 或项目 Codex 登录。真实 API 对话尚未验收；无 Key 请求明确返回 `DEEPSEEK_KEY_MISSING`。搜索与 Codex 排队关闭。正式 WebUI 的 Codex payload 不可访问，空 codex-home 归 root 且只读，并禁用 namespace 创建和 shell 启动，防止误开启未授权执行或生图。

## Ubuntu 沙箱故障与局部修复

服务器 Ubuntu 26.04.1 ARM64 / kernel 7.0.0-38 / bwrap 0.11.1；项目 Codex 锁定 0.164.0。

原故障的内核 audit 明确记录：`profile="unpriv_bwrap" operation="capable" capname="sys_admin" DENIED`。系统 bwrap 的外层本身成功；其子进程叠加了 capability deny，导致内层原生 sandbox 的 `clone(CLONE_NEWNS|CLONE_NEWUSER)` 返回 EPERM。单独 Native Sandbox 当时可用，故不是 Node/ARM64/模型凭据问题。

修复只作用于 root 持有的专用外层 launcher：

- `/srv/deepseekfish/app/runtime/tools/bwrap` 是系统 `/usr/bin/bwrap` 的普通副本，root:root 0755；没有 setuid 或文件 capability。
- `/etc/apparmor.d/deepseekfish-sandbox` 来自 `deploy/deepseekfish-sandbox.apparmor`，只附着上述路径，采用 enforce 模式。外层 namespace 设置有自己的规则；进入系统内层 bwrap 时叠加 `deepseekfish-outer` 与发行版 bwrap profile，任务仍叠加 `unpriv_bwrap` 的 capability deny。
- `src/codex/platform.ts` 优先使用该项目 helper，但必须验证文件和所有祖先都是 root 持有、无 group/other 写权限、无 symlink。否则仍使用原系统/helper 路径。两层 mount/PID namespace、`--cap-drop ALL`、原生受限 profile、命令网络禁用和探针均保留。
- 必要执行路径按审计补齐了 Ubuntu 26.04 的 Rust coreutils 真实路径和沙箱内 `/bin` 路径。profile 没有任意 workspace 可执行文件的通配许可，未来其他工具可能需要单独评审路径。
- 原 `/etc/apparmor.d/bwrap-userns-restrict` 内容及 SHA-256 保持不变。AppArmor 未关闭，`kernel.apparmor_restrict_unprivileged_userns=1`、`kernel.unprivileged_userns_clone=1` 未改变，没有全局放宽。

诊断单元 `deepseekfish-sandbox-check.service` 使用独立的空 `runtime/probe-codex-home` 绑定到项目 codex-home，不接触正式登录目录。它不用额外遮盖宿主 /proc 的 systemd 选项：这类遮盖会使内核拒绝非特权创建新的 proc mount。实际任务仍由项目独立 PID namespace 和私有 /proc 隔离；正式 WebUI 的 ProtectProc/ProtectKernelTunables/ProtectKernelLogs 继续保留。

最终原项目入口的结果（以 deepseekfish UID、无模型调用）：

```json
{"ok":true,"platform":"linux","modelTurns":0}
```

检查通过的是 `/srv/deepseekfish/app` 中的生产安装。管理检出位于 fishops 可写的 home 中，不满足专用 helper 的 root 祖先检查，仍使用系统外层规则；不要用管理检出的同名命令替代生产检查 unit，也不要放宽 helper 的所有权检查。

针对性扩展检查也通过：正向工作区读写、项目目录外/项目 codex-home 哨兵读写拒绝；Native Sandbox 拒绝连接假 Broker 的回环端口；内层标签包含 `bwrap//&deepseekfish-outer//&unpriv_bwrap (enforce)`，`CapEff=0`，要求 capability 的组合 namespace 创建被拒。现有 PID namespace 取消测试在专用 helper 下通过，分离 session 的后代不再继续写 heartbeat。

证据：`runtime/deployment/final-sandbox-diagnosis.json`（管理检出），以及安装副本 `runtime/logs/sandbox-diagnosis.json` 和两项 unit 的 journal。没有读取或复制真实私人凭据；探针只用假数据。没有完整重跑测试套件；只运行已有 Linux 四项相关测试和专用 launcher 的一次 PID 取消测试。未安装任何测试框架，也未重复安装 Node/npm/项目依赖，仅为 launcher 修复重新构建。

## 账户与凭据边界

root 持有 app、runtime 顶层、源码、dist、依赖、Node、专用 launcher 与空的正式 codex-home；服务只能写 data/logs/cache/tmp/workspace/outputs。父目录归 root，服务无法替换整个 app。服务账号没有 sudo，不在 fishops 组，不能遍历 `/home/fishops`；systemd 还隐藏了 home。服务每次启动由 `service-check.mjs` 验证这些边界、Codex payload 不可读及 shell 执行被拒，失败即不启动。

环境白名单测试确认不向 Codex 子进程传递 DeepSeek/OpenAI/QQ Key、SSH agent、HOME 或 NODE_OPTIONS。没有读取、复制或修改 fishops 的 Codex 登录和 SSH 私钥。生产配置中也没有真实 Key。

必须保留的限制：项目仍没有跨 UID 的凭据 Broker。未来填写 DeepSeek Key 后，可信 Node 服务自身必须能读取该 Key；这不等于允许任意模型代码与它共享进程或 UID。假数据测试已证明同 UID 可以读取 0600 文件及自己子进程的环境，且持有管理 token 的进程能构造审批头。因此**本次不授权任意代码自主执行**。若未来需要它，应另设无凭据执行 UID、限定 Broker 协议/调用身份/任务授权、隔离网络及 FD，并做攻击面验证。当前探针通过不是对所有工具、内核路径或被攻陷的可信 harness 的完整安全证明。

## 服务管理与验收

主 unit：`/etc/systemd/system/deepseekfish-web.service`，源文件 `deploy/deepseekfish-web.service`。异常退出 5 秒后重启，KillMode=control-group，停止等待 30 秒；CPU 上限一个核心，MemoryHigh 512 MiB/Max 768 MiB，TasksMax 64。实际稳态内存约 34 MiB。stdout/stderr 进 journald 并限流；没有修改全局 journald 或网络设置。

已完成实际验收：正式状态 `mock:false`、无凭据、只监听回环；未认证请求 401，伪造 Host/跨源 Origin 403；无 Key 对话在调用 API 前拒绝；优雅重启后 token 保留；主动 SIGKILL 一次后自动重启、会话/token 保留，NRestarts=1。这是一项受控恢复测试，不是异常故障遗留。开机启用已检查，但没有为测试重启整台 VPS，以免中断 Exit Node。

```bash
sudo systemctl status deepseekfish-web.service --no-pager
sudo journalctl -u deepseekfish-web.service -n 60 --no-pager
sudo systemctl restart deepseekfish-web.service
sudo systemctl stop deepseekfish-web.service
# 复查宿主兼容性，不调用模型；检查 unit 不设置开机启动：
sudo systemctl start deepseekfish-sandbox-check.service
sudo journalctl -u deepseekfish-sandbox-check.service -n 12 --no-pager
```

`verify-vps-service.sh --restart` 用于初次无凭据安装验收；`verify-vps-recovery.py` 会受控杀死一次主进程并验证恢复，只应在没有实际用户请求时运行。本轮已执行，无需再次重复。

## 访问与下一步接入

在自己电脑执行：

```bash
ssh -N -L 17862:127.0.0.1:17862 fishops@服务器地址
```

访问 `http://127.0.0.1:17862`。在服务器自己的可信终端读取新安装副本的令牌（不要发到聊天或群里）：

```bash
sudo cat /srv/deepseekfish/app/runtime/data/webui-admin-token
```

你决定接入时，在此 SSH 隧道页面手动填 DeepSeek Key，并按账号实际可用模型设置后发起一次真实对话验收；Key 保存于服务私有 data 文件中，不用环境变量传给任务。继续保留 Codex 硬禁用和未登录状态。QQ 仍未绑定，也没有启动 QQ Live unit。搜索、QQ 与真实 Codex 生图/任务需分别明确授权及验收。

备份：停止服务后，将 `runtime/data`、`runtime/workspace`、`runtime/outputs` 与 `config/local.json` 归档到 root-only 的备份目录，再启动服务；未来备份含 Key/token，保持 0700 目录和 0600 归档。升级先在管理检出构建，再停服务由 root 更新代码，保留运行数据与 root 归属，不盲目重跑首次安装器。回滚当前服务可 `sudo systemctl disable --now deepseekfish-web.service`，保留数据；专用 AppArmor 规则只有在停用对应 helper 后才可单独卸载，勿改系统 bwrap profile。

Tailscale 仍 Running/Online 并提供 Exit Node，SSH active，SSH 主配置校验与本轮开始一致。没有执行防火墙或 Tailscale 配置更改，也没有重启它们；防火墙原始输出中的流量计数/时间会变动，不能把整个输出哈希变化当成规则修改。

参考：[AppArmor 上游 bwrap 规则](https://gitlab.com/apparmor/apparmor/-/blob/master/profiles/apparmor/profiles/extras/bwrap-userns-restrict)、[Codex Sandbox](https://learn.chatgpt.com/docs/sandboxing)、[Codex permissions](https://learn.chatgpt.com/docs/permissions)。最终结论以本机证据和当前启用的限制为准。

## 手机访问（2026-10-29 更新）

手机保持 Tailscale 在线后，访问 `http://100.123.219.112:17863/`。新增 `deepseekfish-tailnet.socket` 精确绑定该私网地址和 `tailscale0`，通过独立 DynamicUser 网关转发到原 `127.0.0.1:17862`；没有修改 Tailscale Serve、Exit Node、SSH 或防火墙配置，没有公网监听。连接由 Tailscale 隧道加密，网页使用 HTTP。网关保留后端令牌鉴权，校验固定 Host/Origin，阻断远程 approve/open/stop 并丢弃本机审批头。首次连接可由管理端签发项目原有的 5 分钟单次 bootstrap 链接；令牌只留在浏览器会话中。

前端已调整可关闭抽屉、遮罩、焦点、触控按钮、窄屏设置表单、16px 输入字体和软键盘可视高度；手机回车用于换行，点击发送。核心网关检查和实际 tailscale0 HTTP/鉴权/单次登录/审批阻断检查通过。浏览器自动布局检查因所需 AppArmor 规则被安全审查拒绝而未完成，规则未应用；按用户要求由手机实机验收。

新增 unit 源文件位于 `deploy/deepseekfish-tailnet.{socket,service}`。可用 `sudo systemctl stop deepseekfish-tailnet.socket deepseekfish-tailnet.service` 关闭手机入口，原本机 WebUI 不受影响。修改 Tailscale IP 后需同步 socket 地址及 service 的 FISH_TAILNET_HOST，再重启 socket/service。初始发布归档早于此次增量更新，以当前管理检出和已部署文件为准。

### 手机免令牌入口

已按用户要求取消手机的令牌输入和过期链接流程。固定私网地址不变，网页先读取 `/api/access`，网关经本机 tailscaled WhoIs 核对实际 TCP 对端属于同一 Tailscale 用户（owner ID 7789096802018277）后自动代认证。管理令牌由 systemd LoadCredential 提供给独立网关，仅在服务端使用；无需浏览器存储、复制或续期。忽略伪造的转发身份/审批头；其他用户的共享节点不能自动取得管理权限。本机 CLI 原鉴权和任务隔离不受影响。

此更新取代上文的手机 bootstrap 登录说明。手机页面刷新后直接进入工作台；没有执行自动手机浏览器测试。

## 项目 Codex 生图登录（2026-10-29 更新）

用户已明确授权并完成项目服务账户的设备码登录。`bash scripts/manage.sh codex-login --device-auth` 由 deepseekfish UID 在生产目录执行，返回 Successfully logged in；新 auth.json 在生产 runtime/codex-home，目录 0700、文件 0600，未复用管理账户凭据。用户也已通过网页配置 DeepSeek（这里只检查 credentialPresent，不读取 Key）。

已安装 `deploy/deepseekfish-web-images.conf` 到主服务的 `images.conf` drop-in，启用 `FISH_CODEX_IMAGE_ONLY=1`。只读代码和 home 隔离继续生效；仅开放项目内置生图/额度监视所需的 Codex payload、专用 bwrap、原生沙箱工具及私有网络初始化 AF_NETLINK。每次服务启动强制运行项目完整 sandbox-check；当前实际启动检查已通过。普通 Codex 队列在配置入口和真实 runner 两处禁用，生图仍使用 shell_tool=false、禁用外部 MCP/插件、单张限制及原有预算和逐次探针。

项目账号额度读取已成功，验收时周窗口剩余 84%，策略 allow；没有为验收生成付费测试图片。刷新网页后可重新提交普通生图请求。当前缺少 runtime/character/whalechan-reference.png，自画像/自拍类请求按现有项目逻辑仍需用户提供角色参考 PNG；普通主题图片不依赖它。真实 DeepSeek→Codex→PNG 的当前账号端到端结果应在用户下一次实际请求后确认，不能把登录和额度成功等同于已出图。

之前“Codex 完全禁用、正式 codex-home 归 root”的描述属于初始部署状态，由本节的用户授权生图模式取代。`images.conf` 变更后运行 systemctl daemon-reload；正常重启由主服务 preflight 再验证边界。不要把 auth.json 复制进管理检出、发布包或聊天。

## 同步仓库原始设定集（2026-10-29）

管理检出已快进到官方 `0e8f892`（Bundle original Whale-chan reference sheet for fresh clones），本地部署、手机免令牌与仅生图改动已恢复保留；更新前的本地改动保留在 Git stash。仅有前端提示文案发生合并冲突，已合并仓库新文案并保留本机功能。

原始多视角设定集 `assets/character/whalechan-reference.png` 及说明已部署到生产安装。CLI/WebUI 已共用新版参考图解析：本机 runtime/character 覆盖优先，否则使用仓库默认图。此前“缺少参考图”的状态已解决。构建和两项相关离线测试通过；没有发起付费生图。服务已重启且启动沙箱探针通过。后续发布打包列表已加入 assets 目录；没有重新打包旧发布归档。

## Codex 生图调用记录

按用户要求新增逐次记录：runtime/logs/codex/<任务ID>.json。记录请求与参考图路径、模型/线程/回合 ID、启用的 feature、沙箱检查结果、原生事件和拒绝的服务端工具请求、流式及最终回复文字、图片完成元数据、RPC 错误与最终交付错误。使用私有文件权限和原子写入，过滤凭据，省略图片 base64；记录大小有界。WebUI 同时将该次记录保存到会话 trace，显示「Codex 调用记录」，可展开查看返回文字和下载 JSON。重启后会话中的记录仍保留。

同时修正无图结果的错误分类：先检查原生图片是否存在/成功，再检查参考图使用证据。没有图片时不会再误报 CHARACTER_REFERENCE_NOT_USED；已有真实图片的参考图证据校验仍保留。此前失败的调用没有保存完整模型返回文字，无法补造；新增记录从下一次请求起生效。本轮只做离线及本机检查，没有代用户再次生图。

### 参考图路径核对与 bash 内部启动

新记录显示参考图以本次独立工作区的 character-reference.png 附加（referenceAttached=true）；上游 pull 仅增加 assets 默认图回退，没有改动 PATH 环境或覆盖原本机优先规则。最新回合返回了「内置生图工具因运行权限错误而不可用」的文字，没有原生图片完成事件。

底层日志另确认 Codex 的 bash shell snapshot 初始化被服务执行白名单拒绝。已在专用 AppArmor profile 与 image-only systemd ExecPaths 中补充 bash，其他沙箱和 shell_tool=false 保持。启动检查新增在实际外层 namespace 中执行固定 bash 内建 printf，已连同原有沙箱检查通过。此举解决已确认的内部初始化拒绝，不能据此声称已完成真实生图；留待用户下一次手动请求验证。

调用记录现补充有界、脱敏的原生 stderr 错误/警告。未再次调用生图，没有改动参考图路径或图片文件。

## 真实命令行生图排错（2026-10-29）

用户明确授权命令行真实生图验收。最新 CODEX_RPC_REJECTED 由服务 TasksMax=64 导致：内核记录 `fork rejected by pids controller`，Codex 原生沙箱报 `failed to fork for bubblewrap: Resource temporarily unavailable`。这次失败不是 User Namespace 全局限制，也不是参考图丢失。image-only drop-in 改为 TasksMax=512，移除与原生运行时冲突的第二套 systemd NoExecPaths/ExecPaths 白名单，保留独立服务账户、只读发布、主目录隔离和原生任务沙箱。

后续真实调用确认 AppArmor 拒绝执行官方 `codex-code-mode-host`（内置生图工具的宿主），现对该精确路径开放继承执行。Ubuntu 26.04 的 coreutils 可解析到 `/lib/cargo`，专用外层 profile 允许只读系统运行目录中的程序正常启动，系统 bwrap 仍走原有叠加 profile。没有关闭 AppArmor、修改 sysctl 或增加服务宿主能力；没有变更 SSH、Tailscale 或防火墙。

命令行验收使用独立临时 systemd oneshot，复制正式服务的全部限制及 image-only drop-in，通过同一服务账户、同一生产目录和项目 CLI 执行 `codex-image --reviewed`；输出和逐次诊断保存在 runtime/logs。测试后的实际结果补充如下，不能把工具进程启动当作生图成功。

**验收通过：** 2026-10-29 11:47 UTC，任务 `fb35bc8b-0d18-47e7-9b87-47f879a91009` 返回一项原生 imageGeneration 完成事件。项目 PNG/CRC、产物收集及参考图 inputImages 路径与 SHA-256 校验均通过，报告 `ok=true`、`source=codex-app-server`、`nativeImageCompletions=1`。实际生成「鲸酱在家用服务器旁喝奶茶」1448×1086 PNG，2,357,736 字节，用时 56,676 ms，位于 `runtime/outputs/fb35bc8b-0d18-47e7-9b87-47f879a91009/image.png`。诊断记录为同 ID 的 runtime/logs/codex JSON，CLI 报告为 runtime/logs/codex-image-last.json。临时测试 unit 已删除；正式 WebUI 继续 active，TasksMax=512、NRestarts=0。

这是生产账户与正式服务相同权限条件下的真实 CLI→Codex→参考图→PNG 验收；这次没有另行调用 DeepSeek 设计步骤，也没有代替用户执行手机浏览器操作。AppArmor 保持启用，普通自主 Codex 执行仍关闭，SSH、Tailscale Exit Node 和防火墙未修改。

## QQ 直聊入口与可迁移部署（2026-10-29）

手机工作台新增「QQ 对话」：打开独立 QQ 登录页，填写操作者日常 QQ 号后保存启用，群号可留空。OneBot 接收 QQ 私聊和群聊；私聊不需要 @，保存双方最近消息供连续对话，按联系人/群隔离。使用网页现有 DeepSeek Key 与选定模型；普通 Codex、自主执行和群生图没有因此开放。网页只写非秘密 QQ 设置及启用标记，固定 systemd path 激活 deepseekfish-qq.service；聊天暂停/恢复及账号列表修改即时生效，不授予网页 sudo。

NapCat v4.18.41 与 Linux QQ 3.2.34-53644 已按固定来源部署，服务使用 napcat 独立 UID，不能读取 deepseekfish 的 Key、Codex auth 或管理账户 home。WebUI 后端仅 127.0.0.1:6099，固定私网入口为 http://100.123.219.112:17864/，依旧按实际 Tailscale 对端账户验证并自动带入网页登录。主工作台仍是 17863；没有公网监听或 SSH/Tailscale/防火墙改动。

原生 loopback WebSocket 的群收发、私聊回复、历史隔离，以及网页 QQ 配置/暂停恢复、两个网关的边界检查已通过。NapCat 页面和二维码已实际就绪，但截至部署验收 QQ 仍未登录；真实 QQ→DeepSeek→QQ 回复需要用户扫码、填写自己的日常 QQ 号并完成好友聊天，不能把本地协议测试说成已在 QQ 上回复。

全部安装器、服务/网关模板、ARM64/x64 的 Codex 规则和非秘密默认配置随 Git 提交；Tailscale 地址与 owner 安装时自动生成。私有运行状态可用 migrate-state.py 导出/恢复，数据库使用 SQLite backup，包含生成图片/聊天/日志，排除 Key、Codex/QQ 登录及 Token。新机重新登录，步骤见 migration.md 与 qq-onebot.md。

## 每日记忆、原文人格与空间实测（2026-10-29）

QQ 已由用户完成密码登录并实际收到 DeepSeek 回复（此前误记为扫码，日志 13:07 UTC 已确认密码登录），取代上节尚未登录的验收状态。此次部署新增 QQ/WebUI 每日归档与 SQLite 检索：默认按北京时间仅调用今天、昨天看到的当前会话记录，明确日期/关键词可检索更早记录。现存聊天窗口和网页会话已导入；旧版已删除的聊天无法恢复。

人格独立放在 personas/，雌小鬼段落直接来自 MIT 的 ififi2017/hybrid-catgirl-skill 固定版本，已与上游逐字比较一致，未自写人格 prompt。鲸酱既有外观原样迁入单独文件。

生产服务账户实测读取当前操作者 QQ 资料、头像、3 条可见空间动态、最新动态一张配图与 1200×1500 的真实空间截图，最终采集 errors=[]。截图已人工查看，包含最新说说的正文和照片；不能把仅有页头的加载失败算成功。真实 deepseek-flash 已接收头像和截图并返回基于该动态文字、照片的评价，结果在私有 runtime/logs/people-live-check.json；最终媒体采集检查在 memory-deployment-check.json。测试没有向 QQ 发消息、发表说说或评论。

新增 fishview 独立账户和 Chromium 原生沙箱截图 worker，经私有 Unix socket 调用，没有新 TCP 监听。使用固定版本 Chrome for Testing Linux ARM64，未安装自动化测试框架。截图账户实测不能读 DeepSeek Key、Codex auth、管理用户 SSH 目录和 NapCat 登录目录；QQ 服务挂载中仍看不到 Codex auth、管理 home 和网页会话数据库。AppArmor 保持启用，全局 Namespace 设置未变；WebUI 重启时原有完整 sandbox-check 再次通过。修正只读 QQ 状态接口在凭据目录被隐藏时抛出 EACCES 的问题，未放开目录权限。

代码、服务 unit、浏览器安装器、每日记忆迁移规则均纳入仓库；私有状态归档包含新记忆与截图，排除登录凭据。详细机制和可复用部署命令见 [记忆与人格](memory-persona.md)。SSH 和 tailscaled 仍为原进程，没有修改防火墙或 Tailscale Exit Node。

## QQ 自然接话、精力与生图工具（2026-10-30 北京时间）

用户本轮明确授权精简人格适配。active prompt 只保留鲸酱身份与日常性格，上游原文另存 upstream.md。QQ 不再写死“我先看看……”过渡语，也移除了点评动态时附加的审核式指令；双方对话使用原生 user/assistant 消息，功能提示只交代资料和工具位置。第一轮明确查看/额度/画图请求选择相应函数，动态接话、画面方案和最终表述均由 DeepSeek 生成。

已启用私有 QQ image broker，QQ 仍看不到 Codex auth、payload、管理 home 和网页登录令牌，普通 Codex 依旧关闭。现有 WebUI image-only 服务负责原生生图，QQ 仅通过 0700 目录内的 0600 Unix socket 提交当前消息的单张计划；图片与网页共享原子账本，并按消息 ID 去重。工具中称 token 为精力值，画图协作者为 GPT小姐；没有固定额度答复模板。

真实验证已完成 DeepSeek 自主设计 → broker → Codex 原生 imageGeneration → 参考图证据 → PNG 校验。任务 c30614d1-f198-44aa-846b-76f3adeb8ab1 返回 ok=true、nativeImageCompletions=1，生成机房鲸酱自拍。后续真实额度回答报告剩余 19 张、已用 1 张。检查使用记录型发送器，没有向 QQ 发测试消息；调用记录在私有 runtime/logs/qq-natural-live-check.json，原生记录在 logs/codex/同任务ID.json。

期间 NapCat 原生日志在 16:14 UTC 记录网络服务崩溃，随后 QQ 返回扫码登录；未发现内核 OOM，不能将其等同于本次工具或权限拒绝。已尝试重启与官方客户端已有的缓存快登，腾讯返回“你的用户身份已失效”。当前已回到二维码登录，需用户重新扫码；不能把服务 active 说成 QQ 账号已在线。缓存账号选择可由 scripts/remember-qq-login.py 保存，但它不能绕过身份失效。当前阶段是否在线应以实际 /api/qq 或 QQ transport 状态为准。

详见 [QQ 人格、精力与生图](qq-personality-tools.md)。每日精力和图片限额未增加，输出预算从 256 调整到 768 以容纳结构化画面方案。SSH、Tailscale Exit Node、防火墙、AppArmor 与原生沙箱保持。

## 密码登录持久化与说说序号修复（2026-10-30 北京时间）

已从原生日志确认用户在 13:07 UTC 和 16:38 UTC 使用密码登录，之前按扫码解释属于误判。当前安装版 WebUI 密码登录仅调用 passwordLogin，不保存密码回退凭据；原生自动登录只从已选账号和 NAPCAT_QUICK_PASSWORD / NAPCAT_QUICK_PASSWORD_MD5 获得回退条件。原部署未配置该回退，且排错时曾清空 autoLoginAccount，现已恢复并移除例行脚本的清空选项。

固定版本增加可重现的持久化适配：成功密码/验证码/新设备登录后保存等效密码凭据到 Native QQ 私有目录，启动先尝试缓存，再使用原生密码回退；失败密码不覆盖，验证要求暂停自动重试。已有在线用户可从 QQ 页面「自动登录」补存，不退出会话。此前未保存的密码不能从已登录状态还原。实际保存情况以 FishLoginStatus.saved 为准，不把代码已安装说成密码已经保存。

通过原生工作进程重载接口激活后，日志返回「自动快速登录成功」，QQ transport 仍 connected，未再次要求用户登录。Native systemd 权限未改变，登录目录在实际挂载环境中仍可读写。QQ 密码凭据不会进入 DeepSeek、Codex、Git 或普通状态迁移包。

空间读取拆成独立 get_qzone，与头像 get_person 分开。去掉默认附带头像的模型输入；说说按真实 tid/时间/正文/媒体记录，最新、上一条、上上条、任意序号与分页由实际列表定位。真实上上条返回第 3 条及其两张 JPEG，视觉模型识别对应的实际配图；没有发送头像。前 4 条逐项核对 ID、正文与媒体，视频只读取封面，明确不代表完整视频。

相关离线检查 21 项通过，使用已有 Node test，无新测试框架。真实查询记录在 runtime/logs/qzone-third-live-check.json 与 qzone-page-live-check.json，检查未向 QQ 发消息。详细实现与来源见 [QQ 登录](qq-onebot.md) 和 [空间读取](qzone-reading.md)。

上线后又观察到一次 Native `SelfOffline`；原有恢复状态机等待后恢复到 `ready / coreReady=true`，没有再次要求密码或扫码。此前造成最初掉线的 Native 网络进程崩溃，尚无证据能确定其根因，不能宣称由权限或登录缓存被清理导致。当前选定账户与缓存自动登录已验证；先前密码登录没有留下自定义回退凭据，需在 QQ 登录页“自动登录”中补存一次，或在下次正常密码登录成功时自动保存。未通过主动使线上缓存失效来测试真实密码回退。
