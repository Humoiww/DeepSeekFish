# 权限与信任边界

## 本次能承诺的范围

所有应用创建的代码、数据库、缓存、日志、依赖、研究资料和产物位于 DeepSeekFish。当前运行环境为 Linux，**不能宣称已经具备经 Windows 实测的私人文件隔离**。普通真实 Codex 默认关闭，每个普通任务需要本机人审。用户明确授权的例外是：已鉴权的本机 WebUI 中，明确画图请求可设计并自动派发一张 Codex 内置图片，不再要求第二次 CLI 审批；历史、工具结果或模型输出不能授予此权限。Linux 现已提供独立挂载/PID 命名空间加原生权限 profile 的实现，无凭据探针通过后普通任务仍需每任务本机审批；已额外验证一次真实 ChatGPT 项目账号的命令行内置生图，其他真实链路尚未验证。

在 Windows 上，本机授权只是启动受限实验的必要条件，不意味着允许访问私人文件或解除沙箱。runner 强制 MXC，无危险降级路径；若权限配置/进程边界不能建立，返回失败。系统若要求管理员开通 MXC，必须由用户自行处理，本程序不会修改系统策略、用户 ACL、防火墙或沙箱配置。

## 固定执行边界

- cwd 只能是程序生成的 `runtime/workspace/UUID`，任何群消息和模型输出都不能指定 cwd。
- Linux 为整个 app-server 额外建立空挂载视图与 PID namespace，不挂载主目录、整个仓库或其他项目；只挂系统运行文件、官方依赖、项目 Codex 状态及任务专用目录。详见 [Linux 部署](linux.md)。
- 权限 profile 显式 root deny、minimal read、绝对任务目录 write、命令网络关闭；Linux 为原生 sandbox 启动器另加 vendor / arg0-linux 的只读权限，不授权 auth.json；不混用旧 sandbox_mode。OS 最小路径是为了程序运行，不包含额外授权的私人项目。
- app-server 与执行命令的信任边界不同：app-server 自身需要账号通信和项目 CODEX_HOME，不能把 shell 网络限制当成宿主进程网络隔离的证明。
- 项目 CODEX_HOME 使用独立本机登录；现有用户 Codex auth/config 没有被复制、修改或重置。仅允许 ChatGPT 账号类型，不让环境 API Key 变成独立付费模式。
- 子进程环境按白名单重建，不继承 DeepSeek、QQ、SSH agent、OpenAI API Key 等凭据。显式关闭外部 MCP、hooks、apps、plugins、multi_agent、搜索与依赖自动安装。普通任务关闭内置生图；只有本机显式授权的 `codex-image --reviewed` 或已鉴权 WebUI 的明确单张画图请求为当前回合启用内置生图，同时关闭 shell，不启用群聊生图。管理工具不作为模型工具暴露。
- 每次启动先做真实 OS 外部读写 canary，还要通过任务目录正向读写控制，并检查宿主越界写入没有落盘，随后校验线程返回的 activePermissionProfile。探针只用项目内、任务目录外的无秘密哨兵，不读取用户私人文件。canary 通过是局部证据，不是对所有系统/工具路径的安全证明。
- Windows launcher 使用 CreateProcess suspended → AssignProcessToJobObject → ResumeThread，job 启用 kill-on-close 且不允许 breakaway。它监控 bot owner 进程，owner 退出时关闭 job；取消、超时、正常结束均收尾进程树。不能确认进程终止时保留并发 reservation。Windows 原生效果仍需现场测试。

## 路径和产物

`safePath` 同时检查规范路径、realpath、逐级 lstat，拒绝绝对路径、驱动器/UNC、反斜杠、../、ADS、Windows 设备名、尾随点/空格，以及任一祖先 symlink/junction。任务产物拒绝硬链接、特殊文件、秘密配置文件、不允许的扩展名；限制深度、目录项数量、文件数、总字节。

独立校验程序在子进程完全结束后扫描整个产物集合，通过后复制到独立 outputs；记录 SHA-256、大小、相对路径。发送前重新检查路径、类型、大小、链接数与哈希。网页、SVG、脚本不会在管理页面执行。路径校验不等于进程沙箱；不承诺防御拥有同等本机用户权限、能同时替换文件的恶意本机进程。

## 输入与管理

群消息、工具结果、网页摘要、模型输出、生成文件都是不可信数据。只有固定命令 parser 和事件 openid 白名单能提出任务。普通模型只返回文字，没有 shell/授权工具；Codex 只收到管理员本条请求整理的独立 brief，不接收整段群聊。

管理 API 只监听 127.0.0.1，要求本机随机令牌并检查 Host、Origin、跨站请求。审批要求 reviewed 标记与对应任务 ID。拥有本机用户文件权限的人可取得此令牌，因此它不用于防御恶意本机用户。不要把管理令牌发到群里，也不要对外映射端口。

独立 WebUI 位于 17862，另用本机令牌、单次 bootstrap 和独立会话数据库。纯对话无工具；受限助手只能调用由服务器实现的会话文本读写/列表、可开关搜索与 Codex 待审队列。模型没有 shell、设置或审批工具。路径/类型/链接/文件额度检查在 Node 处理器执行，不把 prompt 或浏览器提供的 cwd 当安全边界。API Key 只存项目私密文件，不回传页面；动态消息以文本渲染，下载强制附件和 sandbox CSP。完整限制见 [WebUI](webui.md)。

SQLite 用量/身份计数为成本管理所需持久数据；原始聊天按窗口和 TTL 清理，最近日志只保留固定错误码/触发原因。秘密环境变量不进入日志。提示词能减少误用，但不用于授予权限。

## 外部目录审计

没有进行全局依赖安装或现有凭据修改。初始开发阶段没有远程发布；后续按用户明确授权发布到了 Humoiww/DeepSeekFish，凭据和运行数据没有上传。最初开发 Node 来自 Codex 的只读运行时；修复终端启动后，Linux 默认可自动准备项目专用 Node/npm，下载包、临时解压和安装目录均在 runtime/tools。发行包只从 nodejs.org 的固定版本地址下载，按源码固定 SHA-256 校验，解压前检查路径和链接，不覆盖已有无效安装目录。

首次诊断 `codex --version` 时未重定向 CODEX_HOME，官方 CLI 尝试创建默认 PATH aliases，执行沙箱以只读文件系统拒绝；未成功写入外部目录。随后所有 Codex 协议检查/运行都通过项目 CODEX_HOME、TEMP/TMP/XDG_CACHE_HOME 重定向。首次 snap curl 也因无法创建外部运行目录失败，后续下载改用 Python，下载和 npm 缓存均写在仓库内。这里记录失败尝试，避免隐瞒依赖副作用。

本报告只覆盖本项目主动发起的程序；不声称能审计桌面宿主自身的内部遥测或运行数据。

WebUI 先校验 DeepSeek 设计方案，再通过相同 AppServerRunner 派发单次生图。生图次数与 Codex 任务/时长同时原子预留，失败不重试，不清零或扩大额度。图片预览由服务端绑定会话和产物 ID，返回前重查 PNG 与 SHA-256；前端只从受鉴权接口读取 Blob，不接收模型提供的任意 URL。

Codex 额度监视连接只调用握手、权限 profile 列表和 account/rateLimits/read，不启动模型回合，不复制登录 Token。WebUI 的本地图片 reset 由已鉴权的人机按钮触发，不能清除活跃/未知预留，不改变官方账号额度、限流退避或普通任务用量。低额度逐张确认由当前 HTTP 请求携带，模型工具参数不能授予确认权限。
