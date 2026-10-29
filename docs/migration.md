# 完整部署与迁移

仓库包含手机界面、私网网关、Codex 诊断、Ubuntu AppArmor 修复、独立服务账户及全部 systemd 配置。`deploy/` 是部署配置的来源；不要仅复制服务器上的 unit。发布代码、依赖和运行状态分开迁移，避免把账号凭据推到公开仓库。

## 新服务器

准备 Ubuntu、Git、Python 3、bubblewrap、AppArmor，并让 Tailscale 按你自己的方式保持在线；本项目不改 SSH、Exit Node 或防火墙。标准生产目录固定为 `/srv/deepseekfish/app`，不依赖原管理用户名称。

```bash
git clone https://github.com/Humoiww/DeepSeekFish.git
cd DeepSeekFish
bash scripts/install.sh
bash scripts/package-vps.sh
sudo bash scripts/install-vps-service.sh
sudo systemctl enable --now deepseekfish-web.service
sudo python3 scripts/install-tailnet.py
```

最后一条命令从本机 tailscaled 读取新的私网 IPv4 和账户 ID，生成本机专用 gateway/socket unit，打印永久链接；不修改 tailscaled。手机保持相同账户的 Tailscale 在线即可访问。源模板不包含旧服务器 IP 或账户 ID。

需要 Codex 生图时，再显式启用，并为服务账户重新登录：

```bash
sudo bash scripts/enable-codex-images.sh
sudo -u deepseekfish bash /srv/deepseekfish/app/scripts/manage.sh codex-login --device-auth
```

DeepSeek Key 在网页手动重新填写；不要复制管理账户的 `.codex`、`.ssh` 或环境变量。`config/local.json` 保存非秘密部署选项，`config/example.json` 和 `deploy/server-config.json` 提供默认模板。QQ 接入说明见后续 QQ 文档。

## 哪些内容不进 Git

API Key、QQ 登录状态、OneBot Token、Codex 登录、管理会话令牌、SSH 密钥只留私有运行目录。`node_modules`、`dist` 和便携 Node 由锁文件及现有安装脚本恢复，无须向 Git 上传数百 MB 的可再生成文件。聊天、数据库和生成图片属于运行状态，迁移时使用私有状态归档，不发布到公开仓库；角色原始设定集已在 `assets/character/` 跟踪。

本机部署过程与真实验收证据见 [VPS 部署](vps-deployment.md)。旧文档中的初始未登录状态由该文档后续更新取代。
