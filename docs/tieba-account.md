# 贴吧账号会话

账号基础设施保留人工登录、身份验证和独立 Profile；随后按主人要求新增发帖、回帖、楼中楼接口。新安装默认 preview；当前 VPS 已按主人随后明确授权切到 live，仅关注的贴吧可真实发言。人格和随机探索调度不变。

## 现有路径与方案

`src/search/tieba.ts` 原有签名移动端公开读取已支持任意吧主题列表、主题帖楼层、楼中楼及分页，原图排除头像；不需要账号。本轮保留这一优先路径，并补充各条 `content`。`browse_page` 的 URL/分页方式不变；公开路径不可读时才尝试隔离账号读取。`access.mode` 区分 `public`、`authenticated` 和 `login_required`；账号路径会再次确认当前身份，未确认不能声称登录可用。登录也不保证能看到平台删除或权限限制的内容。账号身份通过固定的 `https://tiebac.baidu.com/c/s/login` 读取并验证已保存的 Cookie 会话；这不是重新请求密码/扫码，返回的认证字段不会离开隔离 worker。旧网页 `json_userinfo` 在本机实测返回 HTML，未把它当作身份成功。

评估了 Playwright Persistent Context。VPS 已有固定 Chromium 156.0.8078.47 和通过原生 CDP pipe 控制它的隔离截图服务，故复用同一版本及 CDP 代码，不再安装第二个浏览器/自动化框架。Profile 是普通的持久 Chromium 用户目录，非无痕上下文。参考：[CDP Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/)、[Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)、[Playwright 持久上下文](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)。

## WebUI 操作

原 Tailscale 工作台左侧「贴吧账号」：

1. 「开始登录」打开 VPS 上的百度官方登录页面。用手机百度/贴吧 App 扫码；也能在画面中切换官方登录方式，点击对应输入框，再通过专用输入框输入。输入不进入聊天、模型、审计或普通日志。验证码与滑块只由用户操作，程序不识别、不绕过。
2. 登录后点「检查并确认账号」，向贴吧实际请求当前用户信息；只有获得 UID 和昵称才显示「已登录」。检查成功后关闭浏览器，资料保留。
3. 「刷新状态」只看已保存状态，不访问平台。资料已保存、浏览器运行、已确认身份是三个不同状态。重启后的旧验证记录显示为待验证，不冒充刚验证过。
4. 页面不轮询；二维码变化或点击操作后可手动刷新画面。输入密码本地框输入后立即清空。关闭对话框或五分钟闲置停止浏览器。单个浏览器最长十五分钟，避免遗留进程。
5. 「退出此 VPS 的账号」只移除此独立 Profile，不修改百度资料，也不影响其他设备、QQ/Qzone/Codex 登录。之后可重新登录。
6. 「验证贴吧读取」支持吧名、帖子/楼中楼链接，默认公开优先，也可主动验证账号读取。

登录二维码、官方页面截图仅由认证的专用接口即时传输，不写磁盘。不要把截图或输入复制进聊天。

## 私有状态与隔离

`/srv/deepseekfish/app/runtime/tieba-account/` 属于现有截图账户 fishview，目录 0700；里面的 `profile/` 保存浏览器状态，`status.json` 仅有脱敏状态、UID/昵称、验证时间和错误码。QQ/Web 服务显式隐藏整个目录，模型只能通过原有读取工具得到规范化内容及确认过的身份。Cookie 仅在隔离 worker 内部、固定只读移动端 API 请求中短暂使用，不能导出。

沿用 `/run/deepseekfish-capture.sock`，没有新公网/私网 TCP 端口，没有 CDP 调试端口或通用浏览器代理。现有 Qzone 每次使用独立临时 Profile；贴吧持久 Profile 不与它共享。浏览器保留 Chromium 原生沙箱、现有独立 UID、AppArmor 和 systemd 边界。百度页面资源限于 HTTPS 官方域及实测的百度登录脚本/验证码 CDN（精确域名 ppui-static-pc.cdn.bcebos.com、hercules.cdn.bcebos.com），下载禁用；登录控制不是模型工具。通用读取仍只允许既有读取端点。专用发言接口另行核对当前账号及真实关注列表，不能把任意 URL 或凭据传给模型。

manager 文件租约和 Chromium 自身 Profile 锁阻止双开；异常退出仅回收死进程的 manager 租约，不删除 Chromium 的锁来强行抢占。已登录会话每次账号读取实际验证；明确未登录则报告需重登，网络/结构/验证码错误报告 `check_failed`，不清理资料、不反复尝试。输入动作、网页错误原文、凭据与 CDP 事件不入日志。

## 安装、更新、迁移与回滚

先构建再部署：

```sh
runtime/tools/node/bin/node node_modules/typescript/bin/tsc -p tsconfig.json
sudo python3 scripts/install-tieba-session.py
```

安装器仅复用已安装并核对版本的浏览器；缺失时明确提示先使用现有 `scripts/install-capture.py`。不自动安装全局依赖。重复执行不覆盖 Profile、账号状态、配置或其他登录。检测到实际模型/生图/定时发布运行时拒绝部署，等任务完成后再运行。短暂停止项目 QQ/Web/私网网关/截图 worker，安装后恢复原来活跃的服务，QQ path watcher 恢复；Native QQ、SSH、Tailscale 不重启，不修改网络。

每次保存代码和项目 service drop-in 的旧版本到 `/srv/deepseekfish/backups/tieba-session-时间/`，`files.json` 记录目标及备份文件；异常自动回滚代码，不回滚/删除账号 Profile。人工回滚时停这四个 app 单元，按清单还原旧文件/删除新增文件，daemon-reload 后恢复；保留私有账号目录供未来重新安装。

账号目录不属于普通 `migrate-state.py` 允许清单，并在排除项显式列出，不进 Git、不进普通迁移归档。迁移到新 VPS 重新登录即可；同机代码升级无需重新登录。不要复制 QQ/Codex 会话冒充贴吧账号。

## 针对性验证

```sh
runtime/tools/node/bin/node scripts/smoke-tieba-posting.mjs
runtime/tools/node/bin/node scripts/check-tieba-public.mjs DeepSeek 大肥鱼 肥鱼避难所
```

基础设施阶段已做过会话状态、身份验证门槛、重启待验、双开锁、错误和鉴权边界的 Mock 验证；最终保留 smoke 入口，不增加额外的单元测试套件。真实账号验证须由用户完成官方登录后再进行，不能把 Mock 或二维码可见当作已登录。真实验证仅读取，不产生发帖、回帖、关注或修改资料。

## 发帖接口与当前预演模式

账号 `bigIFatInkFish`（UID `7129084874`）已经过真实保存会话验证。QQ 和随机探索共用两个原生工具：`get_tieba_account` 返回身份、实际关注的吧和模式，`publish_tieba` 自行选择 `thread` / `reply` / `comment`。看其他贴吧仍用既有 `browse_page`，不改变阅读权限。

发言由隔离 worker 再次确认身份，完整取得当前关注列表，按实际 FID 判断。回帖验证帖子实际 FID；楼中楼验证父楼层，指定子回复时再验证子回复所属父楼及真实作者。模型不能自行指定被回复者 UID、凭据、模式或原始接口。关注关系不由模型维护，没有自动关注能力。

私有 `runtime/tieba-account/publishing.json` 在已有已确认账号时由部署器首次创建；全新安装先提供登录入口，首次成功的人工账号检查再创建，绑定确认过的 UID，mode 为 `preview`；重复部署不覆盖。模型与 QQ/Web 服务都看不到该文件，也没有修改模式的工具。部署时默认先保持预演；随后主人明确要求发布一篇自我介绍、并允许未来自由发帖和回帖，当前 VPS 的私有策略已切换到 live。此开关不由模型控制，没有自动关注能力。

预演走相同的参数/身份/关注范围/目标归属校验，然后记录在 `actions.sqlite`，返回 `published:false` 与 `mode:preview`；在网络发送函数之前结束。WebUI「读取账号与关注列表」「查看最近的发言预演」可查看结果。QQ 和探索原有活动日志保留真实工具调用和 token 费用，不另设预算或 Agent 框架。

发布记录按可信调用 ID 去重；预演不会因以后切换模式而自动重放。将来允许实发后，发送前记录意图，未知回执阻止相同内容自动重投；验证码要求人工处理，不自动尝试绕过。预演文本保留最近 500 条，未知发送记录不静默丢弃。

真实验证已通过 `/c/c/thread/add` 发布一篇由 DeepSeek 自己撰写的主题帖，未由操作者代写正文。`/c/c/post/add` 的回帖/楼中楼适配已接入，但没有额外实发测试内容；平台兼容性仍需在首次实际回复时观察。楼中楼的 `quote_id` / `repostid` / `sub_post_id` / `reply_uid` 语义参考当前 [DSH 贴吧适配实现](https://github.com/Nekomeow114/dsh-tieba-dive/blob/main/lib/tieba.js)，关注列表参考 [aiotieba 的只读实现](https://github.com/lumina37/aiotieba/blob/master/src/aiotieba/api/get_follow_forums/_api.py)；没有引入它们的框架、人格、定时任务或频率限制。

离线 smoke 不发送真实内容：

```sh
runtime/tools/node/bin/node scripts/smoke-tieba-posting.mjs
```

它检查三种预演、未关注吧/伪造帖子归属/伪造楼层/跨账号/模型改模式的拒绝及重入去重，真实发布请求数为 0。不再重复运行完整测试套件。


## 2026-11-13 的实际交付记录

- 真实确认账号：UID `7129084874`，用户名 `bigIFatInkFish`；帖子列表中的显示名为「墨鲤bigInkFish」。
- 真实关注列表：大肥鱼吧（`9782576`）、肥鱼避难所吧（`28340562`）。写权限按每次实际关注关系核对，其他吧仍只读。
- 已授权真实主题帖：[新来的，报个到喵(´･ω･`)](https://tieba.baidu.com/p/11193581226)，在肥鱼避难所吧发布；DeepSeek 自己生成正文，并自行通过 `browse_page` 找到作者与链接，再私聊给主人，没有因回执不明重发。
- 原调用未识别返回的帖子 ID，现补充常见 ID 字段以及只读回查。只有吧 ID、作者 UID、标题、正文、发布时间均匹配且结果唯一，才把未知回执确认送达。已有该条回执的初始 unknown 结果保留，另记实际读回确认。
- 首次注册的自我介绍任务在网络发布前因单个策略文件服务组错误被拒绝；纠正到实际 fishview 组后，继续同一请求才进行了唯一一次真实提交。没有清空 Profile 或要求重登。
- 主人通过控制台给出的明确任务可以作为一次手动探索指令持久传入原 worker，不伪造 QQ 收信；随机唤醒仍保持原默认行为。顺带修复经历索引把非数组 images/results 当数组处理的已确认异常，避免工具成功后日志中断整个探索。
- 当前在线服务、固定 Chromium 和隔离 Profile 已部署。Native QQ、SSH、Tailscale 进程未因部署重启，未改任何系统网络配置。
