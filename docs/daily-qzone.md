# 每日 QQ 空间日常

主人已授权大肥鱼每天香港时间 00:00，在机器人自己的 QQ 空间发一条图文动态，回顾刚结束的一天。沿用当前人格文件，由 DeepSeek 自主写内容和配图方案，不使用固定台词。项目进程、界面时间、记忆及额度显示使用 Asia/Hong_Kong（UTC+8）；Unix 时间戳不变，不修改主机时区、SSH、Tailscale、QQ 登录缓存或防火墙。

23:50 唤醒 DeepSeek 准备图文，00:00 再读取当天最后几分钟的记忆，由 DeepSeek 自己调用 `publish_qzone` 发布。准备阶段只存草稿及选定的图库 ID，不提前公开。网络和模型响应仍需要时间，00:00 是发布任务的触发时刻，不保证 QQ 服务端精确到秒出现。00:05、00:15 检查恢复；正常成功时不再调用模型、不再发图。systemd Persistent 支持停机后恢复，过了当天 06:00 不补发陈旧动态。

记忆只来自当前已允许的 QQ 私聊和群聊，按香港自然日过滤，覆盖当天各小时、限定输入大小，并向模型标明总记录数与所选记录数。联系人号码不进入日常草稿上下文；公开文案是大肥鱼自己的经历和感受，不转贴私聊内容或身份。无聊天的一天如实记为空，不虚构经历。日常不加入普通 QQ 的关键词分支，也不改变普通对话工具集。

配图来源由 DeepSeek 通过通用工具自行选择：可以看图库、使用已有原图、联网找图下载，或让 Codex 内置工具生成。工具使用原生 auto 选择，不靠关键词路由，也不强制先生成新图。`generate_image` 只通过现有私人 broker 将结果保存到 `runtime/outputs/<ID>/image.png|gif` 并返回 catalogId；模型再选择该 ID 调用发布工具。参考图也由模型选择，不由代码固定附上本人设定图。模型可以看过后改变主意。

生图失败作为工具结果交给 DeepSeek，它仍可以自行选择其他图片。关闭生图只关闭生成工具，不关闭已有图片的日常发布。共享现有人民币、图片额度和联网账本；不新增付费接口、凭据转交或普通 Codex 执行权限。该日常沿用每天一张生成图的授权，稳定请求 ID 不会因丢回复而重复生图。PNG/JPEG/GIF/WebP 原文件按真实格式交给 QQ 空间上传，实际服务端拒绝保留真实错误。

日常配置在 `runtime/data/daily-qzone.json`。`daily_qzone` 表保留原字段，增量增加 `catalog_id`；旧草稿、已有成图和回执可以继续使用。私有日期状态在 `runtime/logs/daily-qzone/YYYY-MM-DD.json`，`decision-<日期>-<ID>.json` 记录每次模型请求、实际工具选择、消耗和错误诊断，可从现有 WebUI 活动记录查看。图库文件 ID 只在当前已授权对话内解析，不接受任意宿主路径。空间发布回执与 QQ 私聊文件发送回执分开，避免把“发过空间”当成“已经发给用户”。

发布前先落盘 publishing，成功必须取得真实说说 ID；响应不明记为 unknown，之后只回读本账号同日期、相同正文且有图的动态确认，绝不盲目重发。服务重启复用已有配图和上传回执，broker 请求 ID 保持稳定。明确的发布拒绝保留错误码；未知生图消耗不重跑，额度不重置。QQ cookie 仅在受信任适配器内存中使用，上传参数不会进入模型或诊断日志。

2026-11-08、11-09 的旧流程均停在 Codex 配图前：上游原始错误为刷新令牌已被使用；旧流程随后将该日记为不再恢复的失败。新流程不把生成图片作为发布的必经步骤，也不因旧错误码或累计失败次数永久屏蔽当天的后续模型选择。未确认的真实发布仍只核对、不重发。

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
