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

## 一条命令导出运行状态

```bash
sudo python3 scripts/migrate-state.py export --root /srv/deepseekfish/app
```

私有归档生成在 `runtime/deployment/state-时间.tar.gz`（0600），包含 SQLite 的在线一致备份、非秘密配置、每日聊天归档、人物记忆和空间截图、网页聊天、任务工作区、生成图片、角色覆盖图与诊断日志。它不进入 Git；把它作为私有文件迁移到新服务器。跨多个数据库需要同一时刻的快照时，先停止本项目 WebUI/QQ，导出后再启动；不会停止 SSH 或 Tailscale。

新机器安装完成，停止本项目服务后导入：

```bash
sudo systemctl stop deepseekfish-web.service deepseekfish-qq.service deepseekfish-qq.path
sudo python3 scripts/migrate-state.py import \
  --root /srv/deepseekfish/app --archive /私有归档路径/state-时间.tar.gz --replace
sudo systemctl start deepseekfish-web.service
```

导入不会覆盖凭据，自动恢复服务账户的文件归属；旧 WAL/SHM 会在停止服务后随数据库恢复清理。随后重新填 Key、登录 Codex/QQ，按需启用 QQ service，并在新机重新运行 `install-tailnet.py`。`node_modules`/Node 用新机器相同架构的现有安装脚本准备，不把 ARM64 二进制复制去 x64。

凭据准备好后运行 `sudo systemctl start deepseekfish-qq.path` 恢复网页启用/重启后的 QQ 自动启动。

## 哪些内容不进 Git

API Key、QQ 登录状态、OneBot Token、Codex 登录、管理会话令牌、SSH 密钥只留私有运行目录。`node_modules`、`dist` 和便携 Node 由锁文件及现有安装脚本恢复，无须向 Git 上传数百 MB 的可再生成文件。聊天、数据库和生成图片属于运行状态，迁移时使用私有状态归档，不发布到公开仓库；角色原始设定集已在 `assets/character/` 跟踪。

本机部署过程与真实验收证据见 [VPS 部署](vps-deployment.md)。旧文档中的初始未登录状态由该文档后续更新取代。

普通 QQ 成员接入见 [NapCat / OneBot v11](qq-onebot.md)。

需要同时迁移 QQ 登录端时，在新机执行 `sudo python3 scripts/install-napcat.py`，再运行 `install-tailnet.py` 生成该机的 QQ 私网入口；NapCat 使用独立账户，登录凭据在新机重新完成密码或扫码登录后建立。二进制版本和社区 launcher 来源固定在 `deploy/napcat-versions.json`，不依赖旧机手工安装。

空间截图能力另执行 `sudo python3 scripts/install-capture.py`，安装独立 fishview 账户和固定版本的 ARM64/x64 浏览器；登录态仍由已登录的 NapCat 瞬时提供，不迁移浏览器 profile。`personas/` 的原文人格及许可证随 Git/发布包迁移，详细规则见 [记忆与人格](memory-persona.md)。

需要恢复 QQ 中的自然语言生图时，在 QQ 服务和 Codex 生图均可用后运行 `sudo bash scripts/enable-qq-images.sh`。broker socket 在新机重建，登录凭据不随归档迁移，额度和去重记录仍在原有 SQLite 中。

NapCat 安装器包含登录持久化适配；私人 login-secrets.json 属于 QQ 登录凭据，不进普通迁移包，新机首次密码登录成功后重新建立。头像和说说索引均在既有 SQLite/人物记忆目录内随状态迁移。

每日空间动态的非秘密 daily-qzone.json、SQLite 任务状态和诊断随私有状态迁移；新机还需运行 scripts/enable-daily-qzone.sh 安装香港时间定时器，见 [每日空间日常](daily-qzone.md)。已发日期不会因重启或迁移自动重发。

知识库 `runtime/data/knowledge.sqlite` 已纳入私有状态归档，网页下载原图与来源随既有 memory/media 和 fish.sqlite 迁移。官方 tokenizer 数据位于 runtime/tools/tokenizer，由 build 脚本按固定官方版本准备（无模型权重）；发行包自带该数据，目标服务不需要联网初始化 tokenizer。
