# 每日新闻私聊与长期记忆

主人已授权每天香港时间 **08:00**，由肥鱼自主挑选感兴趣或与近期聊天相关的新闻，查阅来源后私聊给唯一配置的主人 QQ。沿用当前人格、DeepSeek 连接与联网计价，不设置另一套额度，不向群里广播。

`deepseekfish-daily-news.timer` 启动独立的短时 worker；常驻 QQ 接收服务继续运行，worker 不处理收到的 QQ 事件。早晨先进行一次小规模后台记忆回顾，再由模型自主选择搜索、读取网页、查聊天档案和结束分享的时机。近期私聊输入上限 2000 tokens，不装入群聊、其他联系人或全部历史；更早内容可通过当前主人范围内的 `recall_chat` 取回。候选来源来自本次实际联网结果，最终消息附来源链接，验证码页面不能当作正文。

新闻与后台回顾的模型消耗、Search/Fetch 费用均记入已有预算。研究和发送各有持久状态；确认发送过则跳过。08:10、08:20 仅检查已知失败并尝试恢复，发送结果不明时不自动重发。重启后的定时补偿限当天 08:00–12:00，不补发过期日期。

首次安装在当天 08:00 之后执行时，从次日开始。运行：

```bash
sudo bash scripts/enable-daily-news.sh
sudo systemctl list-timers deepseekfish-daily-news.timer
sudo -u deepseekfish bash /srv/deepseekfish/app/scripts/manage.sh daily-news status
```

`runtime/data/daily-news.json` 保存启用状态、指定收件人和起始日期；启用脚本只接受一个已配置的私聊收件人，不修改 QQ 群或登录设置。`daily-news run` 遵守日期、时间和防重复检查。`daily-news remember` 仅进行一次后台记忆回顾，不联网查新闻、不发 QQ 消息，但会调用现有 DeepSeek 并计费。完整记录位于 `runtime/logs/daily-news/`，发送状态在 `fish.sqlite` 的 `daily_news` 表。配置、数据库和日志已纳入私有迁移包；登录凭据仍排除。

## 长期记忆

知识库也是肥鱼自己的长期记忆，可以记录知识、偏好、约定和经验。每轮提示词携带全文、当前 tokens、5000 上限和版本；具体内容由肥鱼决定。

- 原来的 `get_knowledge` / `update_knowledge` 工具继续可用。
- QQ 的 `reply` 增加可选 `memory`，可以在一次模型回复里同时保存记忆，不必额外消耗一轮调用。
- 超限或版本冲突时先返回私有工具错误，让模型缩减、重试或放弃本次记忆变更；尚未发出的回复不会重复发送。
- 每天早晨还有一次后台回顾，可以选择不更新。记忆维护不会作为 QQ 状态消息发出。

WebUI → 人格与提示词 → 查看完整提示词，可查看全文和 token 数；新增“每日新闻私聊”“后台记忆回顾”请求记录，避免覆盖最近的 QQ 对话记录。这里是持久记忆提示，不修改模型权重。
