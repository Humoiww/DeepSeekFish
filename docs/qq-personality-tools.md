# QQ 人格、精力与生图

当前人格在 personas/mesugaki/prompt.md，只有一小段鲸酱的身份和性格。上游原始段落保留在 upstream.md，许可证和来源仍在同目录。用户已明确授权本轮精简适配；没有固定开场白、示范回复或逐句扮演脚本。

QQ 把双方聊天作为真实 user/assistant 消息送入模型，记忆、人物资料和用量是单独的上下文。系统提示只说明这些信息的位置以及工具名称，不再要求“区分发布时间与观察时间”或输出审核式报告。人格不包含服务权限规则。

明确要求看新动态、查询精力/额度或画图时，第一轮选择对应函数；画图先读取可用图库，后续看图、选图、画面方案和最终回复由模型决定。过渡语也由模型生成；普通聊天自由选择是否使用工具。接口采用 [DeepSeek 原生 tool_choice](https://api-docs.deepseek.com/api/create-chat-completion/)，不追加固定台词。

## 功能

- get_person：只读取 QQ 头像和个人资料。get_qzone：读取本人 QQ 空间说说，支持最新/上一条/上上条/第 N 条、逐条与分页；每条包含真实 ID、时间、正文及绑定到该 ID 的附件。头像不会进入说说图片输入，完整网页截图另存人物记忆。视频封面标记为 video_cover，只表示看过封面。
- get_quota：读取当前账本和 GPT 账号状态。energy 的 token 代表精力值；图片 collaborator 是 GPT小姐。措辞由模型组织，不拼装固定额度台词。
- list_images：浏览设定图、当前对话近两天看到的 QQ 头像/空间原图、这段 QQ 对话生成过的图片。返回来源、图片 ID 和分页位置，不读取其他会话的私人图片、不触发生图。头像和空间配图保持不同来源。
- view_images：查看选中的真实图片，图片 ID 与来源紧挨每张图片交给视觉模型；不把文字说明当作看过原图。
- generate_image：模型自行设计画面，并用 referenceIds 自选最多三张参考原图交给原有 Codex 内置生图。原图实际复制到本次独立任务目录，通过 app-server localImage 输入传入；原生 imageGeneration.inputImages 必须包含选中图片的路径与摘要才认定成功。成功后把 PNG 发进当前对话，实际参考 ID 回传给模型。普通对话、历史和工具结果不能代替当前请求授权。

## 参考图使用指引

模型的简短指引位于 QQ 系统上下文：图片在 list_images，原图用 view_images 查看，选中的 ID 放入 generate_image.referenceIds 就会传给 GPT小姐。character 提供当前外观和原设定图 ID，不规定该怎么措辞，不要求固定开场白。

鲸酱本人原设定图 ID 恒为 character，优先使用 runtime/character/whalechan-reference.png，缺省用仓库 assets/character/whalechan-reference.png。可将其他 PNG/JPEG/GIF/WebP 放入 assets/character/（随源码迁移）或 runtime/character/（随私有状态迁移），会出现在设定图库。浏览或查看本身不扣生图次数。

可以在 QQ 自然地要求“看看你有哪些参考图”“用你自己的设定图让 GPT小姐画张你趴在服务器上摸鱼的图”，或先看空间再要求结合某张已看到的配图画图。由模型浏览并选择参考，不要求用户填写路径或 ID。图片工具不会把 QQ 收到但尚未解析的聊天附件或互联网任意图片假装成已经可用的参考。

图片列表/预览与生图均经现有私有 broker；模型只见 ID，不能传入任意文件路径。QQ 不获得 Codex 凭据。API 依据当前联系人和会话重新解析 ID，复制的参考文件在验收后清除，发布产物仍只有新生成的一张 PNG。参考 ID、是否附上本人设定图、原生实际输入图片记录保存在原有私有日志，不记录 base64 或凭据。接口依据 [OpenAI Docs 的 app-server Turns](https://learn.chatgpt.com/docs/app-server#turns) 使用 localImage 列表。

真实验收已通过：DeepSeek 自行浏览两类图库并查看两张原图，选择本人设定图和这段 QQ 对话已有作品，再派发一张真实图片；Codex 的原生完成记录包含两张实际 inputImages。检查报告在私有 runtime/logs/reference-selection-live-check.json，生成文件保存在原有 outputs。验收没有向 QQ 发送测试消息。定向检查覆盖会话/时间范围、路径和失效 ID、实际使用证据、参考清理以及原有网页生图功能，无新增测试框架。

图片额度和网页共用：默认每天 20 张，同时受 Codex 次数、时间和真实账号状态约束。get_quota 返回的 remaining 是本地当天剩余允许次数；账号上游只提供百分比，不能换算成精确图片张数。查询精力和额度不触发生图，也不清零账本。

## 服务与迁移

QQ 服务仍不能读 Codex 登录、管理账户 home、网页登录令牌或原生执行 payload。新增 broker 由现有 image-only WebUI 服务持有，仅监听项目 runtime/broker/qq.sock（目录 0700、socket 0600），接收允许联系人/群的单张图片计划；不接收 shell、路径、凭据或审批。独立校验当前请求和共享额度，同一 QQ 消息最多派发一次。

完成现有 Codex 生图登录和 QQ 接入后启用：

```bash
sudo bash scripts/enable-qq-images.sh
```

该脚本只安装本项目 drop-in、创建私有 socket 目录、启用 QQ 图片选项，并将不足 768 的输出预算提升到 768，以容纳结构化画面方案；不增加每日精力/图片限额，不改 SSH、Tailscale 或防火墙。

每轮生成文字、工具名称、结果和实际 token usage 在 runtime/logs/qq/UUID.json，包含当轮真正的 system 提示，不记录图片 base64 或登录 Cookie。Codex 原生生图记录继续在 runtime/logs/codex/。这些私有日志、图片及 SQLite 账本随原有 migrate-state.py 迁移；socket 和登录凭据不迁移。

登录持久化修复见 [QQ 接入](qq-onebot.md)。用户实际采用密码登录，不能按扫码推断。缓存失效时优先使用已保存的密码回退，不清空自动登录账号；设备验证仍由 QQ 原有流程完成。
