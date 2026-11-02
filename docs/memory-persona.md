# 每日记忆、人格与 QQ 人物资料

## 记忆

已授权的 QQ 私聊与群聊按收到的日期（北京时间）归档到 `runtime/memory/days/YYYY-MM-DD/会话摘要.jsonl`，包括机器人实际发出的回复。SQLite 保存索引；原有最近 20 条窗口和 TTL 清理不删除每日归档。Key/Token 文本继续脱敏，OneBot 单条原文最多 16000 字符。

WebUI 的用户消息和实际回答也归档，使用 web:会话ID 的独立范围；自动上下文同样只使用今天/昨天，旧会话内容可明确检索。WebUI 与 QQ 不交叉读取聊天记忆。

QQ 默认只带**最近 6 条消息（含当前问题）**，此前的对话合计最多 1500 文本 tokens，且限定今天/昨天、当前联系人/群。合并收到的当前问题保留完整，不用两天归档填满上下文。每天的完整聊天仍然保存。

`recall_chat` 每轮均可用，由肥鱼自行决定是否回看：默认查今天/昨天；`query` 关键词、`date`（香港日期 YYYY-MM-DD）可查更早的记录。每页最多 6 条，每条先读 1500 字符，`offset` 翻更早的一页，`messageId/textOffset` 续读单条全文。不会因用户说了「昨天」「最新动态」就自动灌入旧聊天。QQ 不自动注入旧空间正文；空间、人物资料和表情包均通过对应工具读取，背景只保留 3 张最近图片的短索引、表情包数量和 2 次生图状态。

本轮工具链中，过去两轮以前的长读取结果改为标明截断的短预览，`read_tool_result` 可按 resultId/offset 取回完整原文，无需再次付费搜索或下载。图片供后续两次模型调用查看，随后只留 ID/来源，可通过图库重看。原生 tool_call/result 配对、图片生成与发送回执不删除，完整结果保留在私有 trace。trace 的 `contextInput` 记录每轮本地文本 token 数、工具 schema token 数、图片数和收缩数量；结算仍以 provider 的实际 usage 为准。

人格原文和独立知识库不受此压缩影响；知识库仍按既有要求完整注入，上限 5000 tokens。

知识库也用于长期保留偏好、约定和经验。QQ 可通过 `reply.memory` 在同一轮回复中后台保存，不增加一次模型调用；每天 08:00 新闻前还有一次自主记忆回顾。详细行为及定时配置见 [每日新闻与长期记忆](daily-news.md)。

部署时导入仍存在的旧聊天窗口；此前已经被旧版 TTL/窗口删除的内容无法恢复或补造。长期归档从启用这一版开始记录。

## 人格

`personas/active.json` 当前选择 mesugaki。原始人格段落完整保存在 `personas/mesugaki/upstream.md`，原文提取自 [ififi2017/hybrid-catgirl-skill](https://github.com/ififi2017/hybrid-catgirl-skill/blob/d7d0f7036d13e8fcc01dfc81df8b82da4336d93e/SKILL.md) 的「雌小鬼模式」完整原文段落。固定版本、提取位置和 MIT 许可证在同目录。后续按用户明确授权，将 active prompt.md 精简为鲸酱人格，移除猫娘触发词与台词范例；它不再标为未改写的导入。

鲸酱既有外观原文单独放在 appearance.txt，改变性格不更换用户设定图。旧 whalechan-rp.txt 不再作为当前人格加载。人格不授予工具、凭据或执行权限。

## 人物记忆与最新动态

QQ 中说「评判一下我最新动态」，肥鱼可自行调用工具读取当前说话者的 QQ 资料、头像、当前机器人账号可见的空间最近说说和配图，保存人物观察，并将实际文本/图片交给已有 DeepSeek 模型。普通对话不再自动附带旧空间观察；联系人与群之间的检索隔离。

观察 JSON、头像、配图和真实空间页截图在 `runtime/memory/people/QQ号/YYYY-MM-DD/观察UUID/`，SQLite 保存索引，文件中使用可迁移的项目相对路径。昵称、签名、地域、兴趣等取实际返回字段，不从头像推断现实身份或敏感属性。

只读 CGI 用法参考 [qzone-sdk](https://github.com/Eganchiyu/qzone-sdk)。登录态由 NapCat `get_cookies(qzone.qq.com)` 在可信代码获取，仅在进程中暂存，并经本机私有 Unix socket 交给截图 worker；不进入模型、人物 JSON、聊天归档或日志。日常读取工具不点赞、不评论。主人另外启用的每日图文动态由独立定时任务发布到机器人自己的空间，见 [每日空间日常](daily-qzone.md)。

截图 worker 使用独立 fishview UID、固定浏览器和原生 Chromium sandbox，仅监听 `/run/deepseekfish-capture.sock`，不开放 TCP 端口。它不能读取主服务数据、Codex、SSH 或 NapCat 登录目录。地址固定为对应 QQ 空间，资源限 QQ 所需域名；没有关闭 AppArmor/User Namespace 限制，也没有使用 `--no-sandbox`。

当前 `deepseek-flash` [支持图片输入](https://api-docs.deepseek.com/guides/vision/)。图片下载验证后以内联数据发送，不让模型任意抓 URL；按文档每图最多 1024 tokens 加有界文本预留预算，避免将 base64 当作几十万文本 tokens。继续使用原来的原子预算和实际 usage 结算。

## 部署与迁移

构建并部署完整代码及 personas，创建 deepseekfish:deepseekfish 0700 的 runtime/memory，更新 WebUI/QQ unit 的 ReadWritePaths。首次安装器与打包脚本已包含这些路径。

```bash
sudo python3 scripts/install-capture.py
sudo systemctl daemon-reload
sudo systemctl restart deepseekfish-web.service deepseekfish-qq.service
```

安装器固定浏览器版本，支持 ARM64/x64，仅安装缺失的运行库和中文字体，不装 Playwright/Puppeteer 或测试框架；只创建本项目账户、AppArmor profile 和 unit，不改 SSH、Tailscale 或防火墙。

`migrate-state.py` 包含 runtime/memory 和 SQLite 索引；默认人格随 Git/发布包迁移，网页分块编辑的 runtime/data/persona.json 随私有迁移包迁移。临时浏览器 profile 与 QQ/Codex/DeepSeek 验证凭据不进普通迁移包，新机器按既有流程登录。
