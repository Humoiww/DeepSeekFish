# 账号、登录与会话

[贴吧目录](README.md) · [看帖](reading.md) · [发布](publishing.md)

## 登录入口

WebUI 左侧「贴吧账号」提供开始登录、官方页面、检查并确认账号、读取入口及退出登录。浏览器在 VPS 运行，通过现有认证 WebUI 显示画面；用户在百度官网正常扫码、输入或完成验证，不在 QQ 或模型对话中提交密码、验证码、Cookie。

三个状态分别表示不同证据：

| 状态 | 含义 |
| --- | --- |
| 浏览器运行 | Chromium 已启动，不代表已登录 |
| 资料已保存 | 独立 Profile 存在，不代表会话仍有效 |
| 身份已验证 | 服务端实际确认了当前账号及检查时间 |

网络失败记录为检查失败，不能直接当作登录失效。会话确已失效时报告重新登录。退出登录会清理本模块的账号 Profile，应由用户主动操作。

## 持久化和隔离

Profile 位于私有 `runtime/tieba-account/profile/`，与 QQ、Qzone、Codex 和其他网站分开。服务重启保留账号资料，后续操作实际核验身份；不会每条操作重新登录。

账号由既有隔离浏览器账户管理。QQ/WebUI 只能通过本机私有 socket 调用固定能力，拿不到 Cookie、任意 CDP、通用带认证 HTTP 或宿主命令接口。没有新增公网调试端口。

同一 Profile 的操作互斥，浏览器在普通读取结束后释放。实际发布验证窗口按 [验证说明](verification.md)保留。异常退出只回收已退出进程的管理租约，不删 Chromium 锁强占正在使用的 Profile。

## 安装与升级

先按 [VPS 部署](../migration.md)准备项目、运行账户和既有截图浏览器。构建后执行：

```bash
runtime/tools/node/bin/node node_modules/typescript/bin/tsc -p tsconfig.json
sudo python3 scripts/install-tieba-session.py
```

安装器复用现有固定版本 Chromium；缺少时按它的提示准备已有浏览器依赖。脚本保留账号资料、数据库和已有配置，备份替换文件并恢复项目服务，不修改 SSH、Tailscale 或系统网络。

实际部署清单在私有 runtime，记录基础版本、工作区修改标记和安装文件摘要。安装成功、登录成功与发布成功分别核对，不互相替代。

## 配置与数据

- `publishing.json`：当前账号的普通发言模式与账号绑定，见 [发帖](publishing.md)。
- `publishing-web.json`：已有官方网页发布授权的账号配置。
- `moderator-permission.json`：小吧主申请的账号及目标吧授权，见 [申请](moderator.md)。
- `actions.sqlite`：普通发言及小吧主申请的本地意图与真实回执。
- 当前工作记录、状态和 Profile：只在私有运行目录保存。

公开仓库不携带上述账号配置、数据库或登录态。迁移时区分非秘密状态与认证资料，参见 [部署与迁移](../migration.md)。

源码：[会话管理](../../src/tieba/session.ts) · [私有客户端](../../src/tieba/client.ts) · [浏览器](../../src/capture/tieba-browser.ts) · [安装器](../../scripts/install-tieba-session.py)。
