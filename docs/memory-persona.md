# 每日记忆、人格与 QQ 人物资料

## 记忆

已授权的 QQ 私聊与群聊按收到的日期（北京时间）归档到 `runtime/memory/days/YYYY-MM-DD/会话摘要.jsonl`，包括机器人实际发出的回复。SQLite 保存索引；原有最近 20 条窗口和 TTL 清理不删除每日归档。Key/Token 文本继续脱敏，OneBot 单条原文最多 16000 字符。

WebUI 的用户消息和实际回答也归档，使用 web:会话ID 的独立范围；自动上下文同样只使用今天/昨天，旧会话内容可明确检索。WebUI 与 QQ 不交叉读取聊天记忆。

默认只读取**今天和昨天看到的**记录，且只读当前联系人/群。更早的内容必须明确指向，例如「2026-10-27 我们聊了什么」「上周提到的事」「还记得“海边露营”吗」。模糊的回忆不会自动读取全部旧记录。检索受输入预算约束，返回有界片段，不一次装入整天所有文本。

部署时导入仍存在的旧聊天窗口；此前已经被旧版 TTL/窗口删除的内容无法恢复或补造。长期归档从启用这一版开始记录。

## 人格

`personas/active.json` 当前选择 mesugaki。原始人格段落完整保存在 `personas/mesugaki/upstream.md`，原文提取自 [ififi2017/hybrid-catgirl-skill](https://github.com/ififi2017/hybrid-catgirl-skill/blob/d7d0f7036d13e8fcc01dfc81df8b82da4336d93e/SKILL.md) 的「雌小鬼模式」完整原文段落。固定版本、提取位置和 MIT 许可证在同目录。后续按用户明确授权，将 active prompt.md 精简为鲸酱人格，移除猫娘触发词与台词范例；它不再标为未改写的导入。

鲸酱既有外观原文单独放在 appearance.txt，改变性格不更换用户设定图。旧 whalechan-rp.txt 不再作为当前人格加载。人格不授予工具、凭据或执行权限。

## 人物记忆与最新动态

QQ 中说「评判一下我最新动态」会读取当前说话者的 QQ 资料、头像、当前机器人账号可见的空间最近说说和配图，保存人物观察，并将实际文本/图片交给已有 DeepSeek 模型。普通对话按天在后台更新资料，自动调用当前会话近两天的观察；联系人与群之间的检索隔离。旧观察保留在归档中，仅在明确检索时调用。

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

`migrate-state.py` 包含 runtime/memory 和 SQLite 索引；人格随 Git/发布包迁移。临时浏览器 profile 与 QQ/Codex/DeepSeek 验证凭据不进普通迁移包，新机器按既有流程登录。
