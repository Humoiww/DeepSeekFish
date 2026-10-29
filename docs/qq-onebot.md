# 让大肥鱼作为普通 QQ 群成员收发消息

## 先在 QQ 私聊直接对话

手机打开大肥鱼网页，侧栏选择「QQ 对话」。使用两个账号：给大肥鱼的 QQ 账号登录服务器，你的日常 QQ 账号和它聊天。

1. 点「打开 QQ 扫码登录页」，给大肥鱼的 QQ 扫码并确认。
2. 回到「QQ 对话」，填写**你的日常 QQ 号**，群号先留空。
3. 保存并启用，然后用日常 QQ 加大肥鱼为好友；需要好友验证时在机器人账号侧确认。
4. 直接发“你好”，后续继续聊天，不用 @ 或输入命令。

私聊沿用鲸酱人设、已有 DeepSeek Key 和网页选定模型；双方最近 20 条消息进入上下文，按现有 TTL 清理。私聊、其他联系人及群聊互相隔离。修改账号或暂停/恢复通过网页生效，不用 SSH 或复制 Token；网页写入非秘密 QQ 设置与启动标记，由固定的 systemd path 激活专用 QQ service，网页进程没有 sudo 权限。QQ 进程断线重连、异常重启，已启用的聊天在重启后自动恢复。

这一阶段先提供文本连续对话。图片/语音内容尚未解析，群生图和 Codex 执行未因此开放。之后要进群，再在同一设置页填写群号。

当前建议采用社区的 **NapCat + OneBot v11 + DeepSeekFish**。QQ 账号登录在 NapCat 中，像正常账号一样加入群；NapCat 把普通群消息和 @ 消息交给本项目，本项目使用现有 DeepSeek、人设、上下文和额度逻辑决定是否回复，再通过同一条连接发回 QQ。无需另外部署 AstrBot、Koishi 或第二套模型服务。

这里参考的是社区项目与其源码，而不是腾讯机器人开放平台的权限说明：[NapCat 项目](https://github.com/NapNeko/NapCatQQ)、[AstrBot 的 OneBot 接入实践](https://github.com/AstrBotDevs/AstrBot/wiki/en-platform-aiocqhttp)、[NapCat 群消息事件](https://napneko.github.io/develop/event)。社区协议端需要独立的 QQ 登录，账号风控或 QQ 更新可能影响在线状态；不能把“代码能连 OneBot”说成“账号已经在线”。

## 1. 准备 QQ 登录端

在你准备登录 QQ 的机器上运行 NapCat。它可和本项目同机，也可在另一台连着 Tailscale 的机器上。NapCat 社区提供 [Linux/ARM64 安装方式](https://napneko.github.io/guide/boot/Shell)；本仓库不自动执行网络上的 root 一键脚本，也不为 QQ 接入安装 Docker 或改变防火墙。

使用要作为群成员的 QQ 账号扫码登录，并让这个账号加入目标群。NapCat 中新增「WebSocket 服务器」：

| 配置 | 同机建议值 |
| --- | --- |
| 地址 | `127.0.0.1` |
| 端口 | `3001` |
| 消息格式 | `array` |
| Access Token | 设置一个独立随机值；下一步通过隐藏输入保存 |
| 上报自身消息 | 关闭 |
| 心跳 | `30000` ms |
| 启用 | 开启并保存 |

这是**正向 WebSocket**：DeepSeekFish 主动连 NapCat，不需要增加入站端口。跨机时，仅把 NapCat WS 绑定到它的 Tailscale IP，配置 `ws://100.x.x.x:3001`；不要绑定公网。NapCat WebUI 的密码和 OneBot Access Token 是两个不同值。[社区连接说明](https://napneko.github.io/NapCatQQ-Desktop/docs/connections/)、[WS 鉴权源码](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/network/websocket-server.ts)。

## 2. 配置大肥鱼

在管理检出中运行，替换数字群号和你的数字 QQ 号：

```bash
sudo python3 scripts/configure-onebot.py \
  --root /srv/deepseekfish/app \
  --url ws://127.0.0.1:3001 \
  --groups 你的群号 \
  --admins 你的QQ号
```

交互式隐藏输入 NapCat 的 OneBot Token。脚本仅保存配置，不自动发消息；多个群或管理员用逗号分隔。配置写入 `config/local.json`，Token 单独写入服务私有的 `runtime/data/onebot-credentials.json`（0600）。如果网页已有模型配置，则沿用其中的模型名称；DeepSeek Key 由 QQ 进程直接读取网页原有的私有密钥文件，不复制进普通配置。

普通用户本地安装可去掉 sudo 和 `--root`，在当前项目目录配置；参考 `config/onebot.example.json`。这条路线使用普通 QQ 群号和 QQ 号，和旧官方适配器的 group_openid/member_openid 不混用。原 `bind` 命令仍是旧适配器，不用于登录 NapCat。

## 3. 先检查身份，再启动

```bash
sudo -u deepseekfish bash /srv/deepseekfish/app/scripts/manage.sh qq-check
```

该命令只读取登录账号和群列表，不调用 DeepSeek、不发 QQ 消息。确认返回的账号和群正确后：

```bash
sudo install -o root -g root -m 0644 deploy/deepseekfish-qq.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deepseekfish-qq.service
sudo journalctl -u deepseekfish-qq.service -f
```

新 VPS 安装器会预先安装这个 unit，但不启动、不启用。QQ 服务与 WebUI 独立，故障自动重启；连接中断后每 5 秒重新连接，90 秒无上报/心跳时重连。

## 4. 实际确认“看到了消息”

在授权群里先让另一个账号发两句普通文本，再 `@鲸酱` 问刚才的话题。默认普通文本进入该群最近 20 条上下文，本地记录，不为每条消息调用模型；@ 或包含“小鱼/鲸酱”的消息才触发回复。`autoReply` 可让每个合并窗口回复，`autonomous` 则使用已有话题、概率、冷却与每日次数逻辑进行插话，两者由本机配置或管理 CLI 显式开启，不等同于 Codex 自主执行。

```bash
sudo -u deepseekfish bash /srv/deepseekfish/app/scripts/manage.sh status
sudo -u deepseekfish bash /srv/deepseekfish/app/scripts/manage.sh history 你的群号
# 确认普通收发正常后，按需启用现有的低频自主插话：
sudo -u deepseekfish bash /srv/deepseekfish/app/scripts/manage.sh set autonomous true
```

状态中的 `qq=connected` 证明 OneBot 身份握手成功，`ordinaryMessages=observed` 证明已收到该群普通事件；历史和真实 QQ 回复共同验证上下文链路。不要用 Mock 或只读握手替代真实群消息验收。

当前文本模型不会解析群图片或语音，输入中会明确标记“未解析/未转写”；不要把文本消息可见说成已经具备视觉。适配器支持从本项目 outputs 发送经过验证的 PNG，但 QQ 自动生图仍沿用原限制；本次没有放开群消息执行 Codex、访问密钥或调用任意 OneBot 管理接口。

## 已验证与待操作

本机用真实 loopback WebSocket 对已实现适配器验证身份/Token、普通消息入库、@ 后走现有 Bot/预算链并回传文本；没有安装新的测试框架。真正的 QQ 接入仍需要：NapCat 运行并扫码登录、提供目标群/管理员 QQ 号和 OneBot Token，以及一次群内实测。

## 本项目的 VPS NapCat 安装与手机登录

按用户授权，已提供可复现安装器并在 ARM64 VPS 部署。新机运行：

```bash
sudo python3 scripts/install-napcat.py
sudo python3 scripts/install-tailnet.py
```

安装器使用 `deploy/napcat-versions.json` 固定 NapCat v4.18.41、Linux QQ 3.2.34-53644 和社区非侵入式 launcher 的具体 commit；QQ deb 仅解压到本项目部署根目录，不运行其全局安装脚本。必要的 Xvfb、编译器和运行库由 apt 安装，不装 Docker、不改防火墙。社区 [非侵入式 launcher](https://github.com/NapNeko/napcat-linux-installer) 的 LD_PRELOAD 启动方式保留 QQ 原入口；NapCat Shell 使用其标准 headless `--no-sandbox` 参数，进程由 **napcat 独立 UID + systemd 文件系统边界**约束，不能访问 `/srv/deepseekfish/app`、管理用户目录或 Codex/DeepSeek 凭据。没有关闭 AppArmor，Codex 的外层/内层沙箱保持原样。QQ Electron 自身的 Chromium sandbox 不属于这个 Shell 运行模式的隔离保证。

协议进程运行于 `deepseekfish-napcat.service`，状态在 `/srv/deepseekfish/napcat/state`（0700）；程序在其 sibling vendor 目录，由 root 管理。WebUI 只听 `127.0.0.1:6099`，登录完成后的 OneBot 只听 `127.0.0.1:3001`，心跳和 `array` 事件已预置。OneBot Token 安装时私有生成并同步给大肥鱼，不需要发到聊天。

`install-tailnet.py` 为 QQ 页面另建 **17864** 的私网 socket，只允许同一 Tailscale 账户的设备。固定 `/` 入口自动带入本机 WebUI 登录信息，无须复制 Token；它不代理任意外部地址。手机开 Tailscale 后访问安装器打印的 `http://100.x.x.x:17864/`，用机器人的 QQ 扫码并确认；同一手机可保存二维码，再从 QQ 扫一扫选择相册。二维码可在页面刷新，入口本身长期有效。

完成扫码后，还需数字群号和管理员 QQ 号。可以复用已生成的私有 OneBot Token，仅保存非秘密群配置，然后检查账号并启用 QQ 服务；不要重新生成 Token 或发送到聊天。NapCat 登录数据也属于凭据，不进 Git、不进普通迁移归档；新机器重新扫码。所有安装器、服务和网关源码随仓库迁移。
