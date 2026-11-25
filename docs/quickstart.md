# 快速开始

[文档目录](README.md) · [部署与迁移](migration.md)

## 先选择入口

- 只想在网页聊天：启动 WebUI，无需 QQ 账号。
- 想让个人 QQ 私聊或加入普通群：使用 [NapCat / OneBot](qq-onebot.md)。群号和用户身份使用实际 QQ 号。
- 已有 QQ 开放平台机器人：沿用项目官方 connector。配置使用开放平台 `group_openid/member_openid`，它们不是 QQ 号。
- 希望长期运行在 VPS：完成本地配置后按 [部署与迁移](migration.md)安装服务。

## 本地 WebUI

需要 Git、Node.js 24.9+ 和 npm。Linux 的根目录启动脚本可通过 Python 3 + tar 准备固定版本的项目内 Node；不会更改系统 Node 或 shell 配置。Windows 使用已有 Node/npm，或自行准备项目内运行时。

```bash
git clone https://github.com/Humoiww/DeepSeekFish.git
cd DeepSeekFish
./start.sh
```

无桌面启动使用 `./start.sh --no-open`；无 API Key 演示使用 `./start.sh --mock`。Windows 双击 `start.bat`，演示模式使用 `start.bat --mock`。

网页地址为 <http://127.0.0.1:17862>。自动打开使用一次性本机连接；手动打开时，用 `runtime/data/webui-admin-token` 登录。在「连接与设置」保存自己的 DeepSeek 或 OpenCode Go API Key，再开始聊天。不要将令牌发到群里或提交 Git。

启动脚本完成依赖准备与构建。需要手动操作时：

```bash
bash scripts/install.sh
# 或在已配置 Node/npm 的环境中：
npm ci --ignore-scripts
npm run build
npm run webui
```

WebUI 的模式、文件工作区、人格分块、图片通道和费用设置见 [WebUI](webui.md)。停止前台服务使用 Ctrl+C，或 `npm run cli -- web-stop`。

## QQ 接入

### 个人 QQ / 普通群

按 [NapCat / OneBot](qq-onebot.md)准备独立 QQ 登录及传输服务，在 WebUI 配置允许的私聊账号、群号和关键词。普通群消息先归档；直接 @ 肥鱼或命中已配置关键词后才调用模型。私聊使用现有授权范围。

QQ 窗口和 WebUI 独立会话共用人格、长期知识与人民币预算；各自的对话上下文仍分开保存。账号与群内称呼按真实 QQ 身份记录。

### 开放平台机器人

保留已有配置；新安装可从示例创建：

```bash
cp -n .env.example .env
cp -n config/example.json config/local.json
chmod 600 .env config/local.json
# 用自己的编辑器填写 Key 与开放平台身份，再绑定账号。
bash scripts/manage.sh bind
bash scripts/start.sh
```

Windows 对应 `npm run bind` 与 `npm start`。开放平台提供的事件权限决定能收到哪些消息，不能用普通 QQ 号代替 openid。

管理接口监听本机 <http://127.0.0.1:17861>。开关和预算的使用见 [配置](configuration.md)及 [人民币预算](cny-budget.md)。

## 可选 Codex 与图片

通用 Codex 工程任务先进入待审队列，由本机操作者审核后执行。图片生成使用独立通道；具体授权、参考图、张数限额和原生 GIF 支持分别见 [QQ 人格与工具](qq-personality-tools.md)、[WebUI](webui.md)和 [原生 GIF](native-gif.md)。

无桌面环境可使用项目专用的官方设备码登录：

```bash
bash scripts/manage.sh codex-login --device-auth
```

不要复制其他项目或用户目录的认证文件。Linux 的隔离环境与排错见 [Linux](linux.md)；Windows 原生 Codex 隔离仍以对应环境的实际验证为准。普通聊天不要求先启用通用 Codex。需要由 Antigravity 分诊并交给 Codex 开发时，见[接入指南](neon-codex-development-bridge.md)。

## 接下来

- [贴吧](tieba/README.md)：登录后看帖、回帖、处理验证或申请小吧主。
- [自主探索](autonomous-exploration.md)：在 WebUI 配置随机唤醒及主人。
- [记忆与人格](memory-persona.md)：修改人格、查历史与维护长期知识。
- [部署与迁移](migration.md)：运行目录、服务、备份和换机恢复。
