# 每日 QQ 空间日常

主人已授权大肥鱼每天香港时间 00:00，在机器人自己的 QQ 空间发一条图文动态，回顾刚结束的一天。沿用当前人格文件，由 DeepSeek 自主写内容和配图方案，不使用固定台词。项目进程、界面时间、记忆及额度显示使用 Asia/Hong_Kong（UTC+8）；Unix 时间戳不变，不修改主机时区、SSH、Tailscale、QQ 登录缓存或防火墙。

23:50 预备一张新图并上传，00:00 再读取当天最后几分钟的记忆、看实际配图、完成文案并提交发布。网络和模型响应仍需要时间，00:00 是发布任务的触发时刻，不保证 QQ 服务端精确到秒出现。00:05、00:15 检查恢复；正常成功时不再调用模型、不再发图。systemd Persistent 支持停机后恢复，过了当天 06:00 不补发陈旧动态。

记忆只来自当前已允许的 QQ 私聊和群聊，按香港自然日过滤，覆盖当天各小时、限定输入大小，并向模型标明总记录数与所选记录数。联系人号码不进入日常草稿上下文；公开文案是大肥鱼自己的经历和感受，不转贴私聊内容或身份。无聊天的一天如实记为空，不虚构经历。日常不加入普通 QQ 的关键词分支，也不改变普通对话工具集。

配图使用现有私人 broker、Codex 内置生图与鲸酱设定图，共享真实的每日图数、token 和账号额度。提前准备的一张计入准备时所在自然日；午夜刷新文案计入新一天。该已授权日常任务沿用每天一张的授权；与其他图片一样只检查当天图片次数，不再按 Codex 百分比或本地任务/时长额度暂停。实际服务端拒绝仍返回失败，不自动重复消耗。普通 Codex 执行权限仍关闭，定时账户看不到 Codex 登录文件。日常配置在 runtime/data/daily-qzone.json，数据库 daily_qzone 记录日期、草稿、图片、上传回执及发布状态，私有诊断在 runtime/logs/daily-qzone/YYYY-MM-DD.json。

发布前先落盘 publishing，成功必须取得真实说说 ID；响应不明记为 unknown，之后只回读本账号同日期、相同正文且有图的动态确认，绝不盲目重发。服务重启复用已有配图和上传回执，broker 请求 ID 保持稳定。明确的发布拒绝保留错误码；未知生图消耗不重跑，额度不重置。QQ cookie 仅在受信任适配器内存中使用，上传参数不会进入模型或诊断日志。

发布/上传的 CGI 参数参考社区项目 [qzone-sdk](https://github.com/Eganchiyu/qzone-sdk/blob/main/src/qzone_sdk/client.py) 与 [onebot-qzone](https://github.com/Gu-Heping/onebot-qzone/blob/main/doc/emotion-api.md)。使用现有 Node fetch，不新增运行库、测试框架或另一套 QQ 登录。

## 部署与操作

构建并将源码和 dist 部署到现有服务目录后，明确启用：

```bash
sudo bash scripts/enable-daily-qzone.sh
```

安装器保留已有主人和开始日期；首次默认从下一个香港午夜开始。安装独立的 deepseekfish-daily-qzone.service 和 timer，不重启 Native QQ。非秘密配置及 daily_qzone 表随 scripts/migrate-state.py 迁移；新机部署后重新运行启用脚本安装 timer。

以服务账户在项目目录运行：

```bash
node dist/src/cli.js daily-qzone status   # 状态，不调用模型
node dist/src/cli.js daily-qzone preview  # 真实模型草稿，扣 token，不发动态/生图
node dist/src/cli.js daily-qzone prepare  # 提前准备下一午夜的图文，不发布
node dist/src/cli.js daily-qzone run      # 依据当前香港时间处理到期阶段
```

暂停 timer 使用 sudo systemctl disable --now deepseekfish-daily-qzone.timer；将私有配置 enabled 设为 false 会阻止正在运行任务后续提交。恢复时重启 timer。status 及现有管理 API 的 dailyQzone 字段可查看最近状态和成功动态链接。
