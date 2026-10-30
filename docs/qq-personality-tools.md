# QQ 人格、精力与生图

当前人格在 personas/mesugaki/prompt.md，只有一小段鲸酱的身份和性格。上游原始段落保留在 upstream.md，许可证和来源仍在同目录。用户已明确授权本轮精简适配；没有固定开场白、示范回复或逐句扮演脚本。

人格采用与熟人聊天的第一人称视角，补充自己的情绪和反应；工具留在幕后，不用操作记录塑造说话风格。仍然只有一小段，不指定句式、口癖、固定回复或消息长度。

QQ 把双方聊天作为真实 user/assistant 消息送入模型，记忆、人物资料和用量是单独的上下文。actions 提供当前消息及最近图片任务的真实账本状态，区分聊天中的口头承诺与已提交任务。系统提示只保留人格、信息位置和画图协作者；工具用法由函数定义提供，不重复堆在系统提示里。人格不包含服务权限规则。

回复也属于工具：reply 发送模型自己写的文字并结束回合。所有普通回合使用 [DeepSeek 原生 tool_choice=required](https://api-docs.deepseek.com/api/create-chat-completion/)，模型自己从回复或其他操作中选择；没有指定某个业务工具。

QQ 每轮使用同一套可用工具，由模型原生 tool_calls 自主选择查资料、查空间、看图、收藏/发表情或请 GPT 生图；没有关键词意图路由、强制首个工具或“先判定为画图才给生图工具”的分支。也可以仅选择 reply 闲聊。用户已授权肥鱼在当前允许的聊天中自主使用这些功能，代码只执行实际返回的原生调用，不把口头承诺当作已执行。

工具备注可省略，聊天措辞由模型决定，不强制播报步骤。一轮最多派发一张新图，共享日额度及同一消息去重继续生效。重复 generate_image 返回第一次的真实结果，不重复生成/发送，也不把已成功的图报成缺少授权。媒体分类与生图一样保留原生调用和完成结果，后台记忆随结果刷新；不清空工具记录再把旧用户消息当作新请求，也不追加播报步骤的提示。

模型调用协议只通过原生 tool_calls 处理，不把 DSML 正文当作可执行命令或 QQ 消息。如果正文串入协议，会针对本轮已有权限的工具进行至多一次原生 JSON 恢复；未知工具、重复失败与发送端都拦截协议文字。历史中曾泄漏协议的助手消息不会再次进入滚动上下文或自动回忆，原始档案和私有调用记录保留。

## 功能

- reply：自己组织聊天内容，发送并结束当前回合。
- get_person：只读取 QQ 头像和个人资料。get_qzone：读取本人 QQ 空间说说，支持最新/上一条/上上条/第 N 条、逐条与分页；每条包含真实 ID、时间、正文及绑定到该 ID 的附件。头像不会进入说说图片输入，完整网页截图另存人物记忆。视频封面标记为 video_cover，只表示看过封面。
- get_quota：读取当前账本和 GPT 账号状态。energy 的 token 代表精力值；图片 collaborator 是 GPT小姐。措辞由模型组织，不拼装固定额度台词。
- list_images：浏览设定图、当前对话近两天看到的 QQ 头像/空间原图、近两天收到的图片、收藏表情及这段 QQ 对话生成过的图片。返回来源、图片 ID 和分页位置，不读取其他会话的私人图片、不触发生图。头像和空间配图保持不同来源。
- view_images：查看选中的真实图片，图片 ID 与来源紧挨每张图片交给视觉模型；不把文字说明当作看过原图。
- generate_image：模型自行设计画面，并用 referenceIds 自选最多三张参考原图交给原有 Codex 内置生图。原图实际复制到本次独立任务目录，通过 app-server localImage 输入传入；原生 imageGeneration.inputImages 必须包含选中图片的路径与摘要才认定成功。成功后把 PNG 发进当前对话，实际参考 ID 回传给模型。模型可在当前 QQ 对话自主决定生图；历史、参考图或工具结果不会在后台单独创建任务。
- remember_images / collect_meme / find_memes / send_meme：读取 QQ 收到的静图与动图抽帧，记录内容并自动收藏模型判定的表情包，也能从已有图库收藏自己的作品，按聊天语境选择发送一张或多张原图。详见 [图片理解与表情收藏](qq-media.md)。

## 参考图使用指引

模型的简短指引位于 QQ 系统上下文：图片在 list_images，原图用 view_images 查看，选中的 ID 放入 generate_image.referenceIds 就会传给 GPT小姐。character 提供当前外观和原设定图 ID，不规定该怎么措辞，不要求固定开场白。

鲸酱本人原设定图 ID 恒为 character，优先使用 runtime/character/whalechan-reference.png，缺省用仓库 assets/character/whalechan-reference.png。可将其他 PNG/JPEG/GIF/WebP 放入 assets/character/（随源码迁移）或 runtime/character/（随私有状态迁移），会出现在设定图库。浏览或查看本身不扣生图次数。

可以在 QQ 自然地要求“看看你有哪些参考图”“用你自己的设定图让 GPT小姐画张你趴在服务器上摸鱼的图”，或先看空间再要求结合某张已看到的配图画图。由模型浏览并选择参考，不要求用户填写路径或 ID。收到的图片和收藏表情以 media- 开头的 ID 进入同一图库，来源为 received；可与 character 一起加入 referenceIds，传入真正的原文件。普通收图限近两天，收藏表情持续可用，均只限同一聊天。

图片列表/预览与生图均经现有私有 broker；模型只见 ID，不能传入任意文件路径。QQ 不获得 Codex 凭据。API 依据当前联系人和会话重新解析 ID，复制的参考文件在验收后清除，发布产物仍只有新生成的一张 PNG。参考 ID、是否附上本人设定图、原生实际输入图片记录保存在原有私有日志，不记录 base64 或凭据。接口依据 [OpenAI Docs 的 app-server Turns](https://learn.chatgpt.com/docs/app-server#turns) 使用 localImage 列表。

真实验收已通过：DeepSeek 自行浏览两类图库并查看两张原图，选择本人设定图和这段 QQ 对话已有作品，再派发一张真实图片；Codex 的原生完成记录包含两张实际 inputImages。检查报告在私有 runtime/logs/reference-selection-live-check.json，生成文件保存在原有 outputs。验收没有向 QQ 发送测试消息。定向检查覆盖会话/时间范围、路径和失效 ID、实际使用证据、参考清理以及原有网页生图功能，无新增测试框架。

图片额度和网页共用：默认每天 20 张，同时受 Codex 次数、时间和真实账号状态约束。get_quota 返回的 remaining 是本地当天剩余允许次数；账号上游只提供百分比，不能换算成精确图片张数。查询精力和额度不触发生图，也不清零账本。

私聊精力使用配置中的全局 dailyTokens（默认 1000000，最多可设 10000000），不额外套用每群 groupDailyTokens（默认 60000）；群聊仍执行群上限。每次模型调用先保守预留上下文、工具和输出预算，成功后按供应商实际 usage 结算；预留不足不会发起该次模型调用。预算拒绝的精确原因、已用量和本次预留记录在 audit 的 budget-denied，区分全局、会话和请求次数。未知用量继续保留计费记录。

QQ 没有生图句式识别。默认 userDailyRequests 提升至 1000（统计模型调用，工具循环也计数），以免旧的 50 次上限提前截断聊天；每日 token 仍为 1M，最高可设 10M。定向检查使用虚构聊天和账本数据；生产回放与真实用量记录只保留在私有日志中，不进入源码仓库。

## 服务与迁移

QQ 服务仍不能读 Codex 登录、管理账户 home、网页登录令牌或原生执行 payload。新增 broker 由现有 image-only WebUI 服务持有，仅监听项目 runtime/broker/qq.sock（目录 0700、socket 0600），接收允许联系人/群的单张图片计划；不接收 shell、路径、凭据或审批。独立校验聊天范围、当前消息和共享额度，同一 QQ 消息最多派发一次。

完成现有 Codex 生图登录和 QQ 接入后启用：

```bash
sudo bash scripts/enable-qq-images.sh
```

该脚本只安装本项目 drop-in、创建私有 socket 目录、启用 QQ 图片选项，并将不足 768 的输出预算提升到 768，以容纳结构化画面方案；不增加每日精力/图片限额，不改 SSH、Tailscale 或防火墙。

每轮生成文字、工具名称、结果和实际 token usage 在 runtime/logs/qq/UUID.json，包含当轮真正的 system 提示、finishReason、协议恢复事件和 contextSize（系统/人格字符数、工具定义及上下文字节数、历史条数），不记录图片 base64 或登录 Cookie。字符/字节统计不是 tokenizer 的精确 Token 数；实际费用以供应商 usage 为准。Codex 原生生图记录继续在 runtime/logs/codex/。这些私有日志、图片及 SQLite 账本随原有 migrate-state.py 迁移；socket 和登录凭据不迁移。

QQ 记录从请求开始持续更新，包含 toolPolicy=model-choice 与 imageRequested；生图分别记录提交、生成的 imageId 和发送成功结果。尚在生成的任务也能直接查看进度，协议修复事件另行记录，不再只在整轮结束后落盘。

QQ 图片上传等待回执最多 60 秒，普通文字/API 调用仍为 10 秒。上传超时不等于图片生成失败：工具结果保留 created、imageId 和未确认的 deliveryStatus，不重跑生图或盲目重发；可以根据原 QQ 消息历史核实迟到的图片。

生图后的原生工具调用及真实返回保留在同一对话链中，避免模型失去完成记录又从头调用。后台 actions.lastImage 提供生成/送达事实、重试状态、参考 ID 与成图 catalogId；不自动把成图加成一条“请看图”的用户消息。完整工具集继续可用，模型想看或收藏时自主调用 view_images / collect_meme。送达回执保存到私有数据库，后续回合也能区分已生成、已确认送达与未确认状态。没有自动重发任务，没有添加固定台词。

登录持久化修复见 [QQ 接入](qq-onebot.md)。用户实际采用密码登录，不能按扫码推断。缓存失效时优先使用已保存的密码回退，不清空自动登录账号；设备验证仍由 QQ 原有流程完成。
