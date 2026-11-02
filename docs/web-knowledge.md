# 自主联网、图片与知识库

QQ 每轮提供同一组工具，由模型根据对话自主选择，没有图像需求关键词分类，也不替模型写固定过渡语。人格区块保持原样。

## 共用 token 额度

Search / Fetch 上游价格为 $0.75 / 1000 次成功请求。本项目以该模型公布的**标准未缓存输入价**为统一换算基准：Flash $0.30 / 百万 tokens，每次联网为 2500 tokens；Pro $1.32 / 百万 tokens，每次向上取整为 569 tokens。公式为 `ceil(请求价格 / 每百万输入价格 × 1000000)`。这是本地额度换算基准，不声称等于每次模型调用的实际账单（缓存、输出和错峰价不同）。价格来源：[DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/)，2026-11-01 核对；价格变化时更新 `src/budget/pricing.ts`。

联网与普通模型请求原子扣同一个全局/会话 token 预算，每天香港时间 00:00 切日。模型原始 input/output 计数不被改写；webTokens 仅是总用量中的诊断分项，不是第二个余额。已用联网次数也仅用于诊断。旧 searchDaily 被忽略，不再限制调用。此更新不追扣历史调用，不重置当天用量。

同一搜索或 Fetch URL 缓存十分钟，续读不重复扣除。明确失败的 HTTP 响应、空结果退还预留；连接中断等结果未知的调用保留预留，防止重复结算。网页 HTML 抓取与原图下载不经过收费 Search/Fetch API，不虚构搜索费用；图像和正文进入模型后照常计模型 token。

`search_web` / `fetch_page` 支持 `fresh:true` 跳过本地缓存，仍按真实请求结算；这不保证搜索引擎索引即时更新。搜索结果保留发布日期与检索时间，并明确标记为搜索索引、尚未核实最新内容。搜索排序不能当作动态时间顺序。Fetch / browse 返回正文、验证码、登录页或客户端空壳等状态，获取时间不冒充发布时间。

模型预留使用已有官方 tokenizer，加 25% 文本余量、消息/工具框架余量和每图最多 1024 tokens；数据缺失时退回保守字节预留。最终仍以提供商 usage 结算；未知用量仍保留预留，超出预估仍触发账本异常保护。此调整不改变每日上限。额度拒绝会显示实际剩余和本轮所需预留，不再只给 QQ 一个笼统错误码。

## 图片工具

- `search_web` 找公开网页，`fetch_page` 读正文。
- `browse_page(url, offset?, query?, textOffset?)` 优先返回正文中的图片与链接；可读公开 JSON 图库目录，query 筛图名、offset 翻目录、textOffset 续读正文。也发现静态脚本中的公开数据入口，不执行网页代码。预览图和视频封面明确标出类型。
- `download_image(url)` 下载一张，`download_image({urls:[...]})` 一批下载最多 12 张，每张独立返回成败并给模型看图/动图样本；GitHub blob/raw 候选统一为原文件 URL 去重。返回当前会话图库 ID。
- 模型可用 `collect_meme` 保存表情描述、标签；其 images 数组支持批量收藏，再由 `find_memes` / `send_meme` 检索发送；也可把下载图 ID 放进 `generate_image.referenceIds`。普通图片下载无需先归类为表情包。
- `list_images(source="web")` 浏览已下载的网页图。显式下载的原图跨天保留，原始 GIF/WebP 不被静图覆盖。图库、收藏和 GPT 参考沿用同一会话边界。

HTML 解析不执行网站脚本，也不代替登录浏览器。需要登录、验证码、仅客户端渲染或禁止下载的网站仍可能无法读取，工具返回实际失败；模型可继续尝试别的公开来源。下载使用现有图片解码和存储范围，不开放 shell、任意宿主文件或内网访问。

### B 站公开空间与 JSON

`browse_page` 打开 `https://space.bilibili.com/UID/dynamic` 时优先读取公开 desktop 动态接口，兼容其模块数组结构；然后尝试普通 web 动态接口与公开图文列表。最后一种会标明 `coverage:image_text_posts_only`；图文列表不涵盖全部视频和转发，不能据此断言账号整体最新动态。无需账号或 Cookie，不处理验证码。

回执提供动态 ID、作者与认证信息、正文、发布时间、配图/视频封面类型、置顶标记与下一页 URL，转发原文单独置于 original。`latestOnPage` 按当前返回列表的发布时间选择非置顶条目，不把首张置顶旧视频当作最新动态。接口不提供发布时间时保留 null。头像不放入动态配图；视频只确认标题、简介和封面，不冒充看过正片。

`t.bilibili.com/` 是登录账号的关注流首页，不是某个 UP 的空间。打开这个入口会返回 `target_account_required` 与正确 URL 格式，让模型自行搜索目标 UID 后再读。没有写死任何游戏或账号，也没有按聊天关键词强制调用工具。

本 VPS 于 2026-11-01 实测：普通空间页验证码、普通 web 动态接口 HTTP 412；补浏览器请求头、游客标识、WBI 参数仍被拒绝。但 `desktop/v1/feed/space` 使用项目原有无 Cookie 网络层，成功返回两个官方账号的动态、置顶视频、正文与原生时间戳。不是无限制访问所有账号的保证，未来风控仍会返回实际失败。普通 JSON 正文也会保留，修复以前只抽图片而丢掉非图片数据的问题。

可复现检查（只读公开数据，不调用付费模型或发送 QQ）：

```bash
runtime/tools/node/bin/node scripts/check-bilibili-public.mjs 目标数字UID
```

参考的社区 skill/方法：[B 站 API skill](https://github.com/Nek0Neko/claude-skill-bilibili-api)、[browser-harness 的 B 站导航说明](https://github.com/browser-use/browser-harness/blob/main/agent-workspace/domain-skills/bilibili/navigation.md)、[BiliStalkerMCP](https://github.com/222wcnm/BiliStalkerMCP)。Skill 提供调用知识；MCP 的动态能力仍依赖底层 B 站接口和必要登录态，安装名称本身不会消除 412。本次复用现有 TypeScript 工具实现可用公开读取，不额外安装 Python/MCP 框架。

### 贴吧自主浏览

QQ 每轮的 `browse_page` 可直接打开 `https://tieba.baidu.com/f?kw=吧名`；吧名由模型选择，无固定名单或聊天关键词路由。列表返回帖子链接、作者、发帖时间和置顶标记。打开 `/p/帖子ID` 读取正文与楼层，再沿 `commentsUrl` 读取楼中楼，沿 `nextPage` 翻页；正文过长用 `textOffset` 续读。论坛列表为摘要，不代表读完了帖子；置顶不代表最新。帖子原图可接现有 `download_image`、看图和收藏流程。

2026-11-02 在此 VPS 定位：网页 GET 返回 403，DeepSeek Fetch 返回 404，但贴吧客户端的公开只读表单 POST 可返回 JSON。实现参考社区 [aiotieba](https://github.com/lumina37/aiotieba) 的接口与签名方法，并针对实际返回兼容旧版 JSON：`tiebac.baidu.com/c/f/frs/page`、`/c/f/pb/page`、`/c/f/pb/floor`。只有这三个读取地址允许 POST；使用 TLS 1.2（保留证书校验）、公共 DNS 校验和地址绑定，无账号、Cookie 或 BDUSS。没有新增依赖、代理或登录流程，也没有开放发帖/点赞等写操作。

工具保留真实 ID、作者、发布时间、父楼关联、API 报告数量与当前返回数量，不将头像当成帖子配图。只保证公开返回的页面；删除、隐藏、需登录或未来风控拒绝的内容可能缺失，错误如实返回。只读请求无第三方 API 费用，模型读取内容仍计入原有 token 预算。

本次实测：deepseek 吧列表、明日方舟帖子楼层与楼中楼均成功；列表第二页取得不同帖子，帖子第二页从后续楼层继续，原图完成下载/解码。真实 DeepSeek 在只收到“吧名你自己挑，看看正文和回复”的请求、使用同一套 QQ 工具时，自选明日方舟吧，再选帖子读取三层发言，随后自然回复。该隔离验收未发送 QQ 消息，三轮模型共 20,710 tokens，计入现有账本。15 项定向测试通过，未重复全量测试。

可复现检查（构建后运行，不调用付费模型、不发送 QQ 消息）：

```bash
runtime/tools/node/bin/node scripts/check-tieba-public.mjs '你想看的吧名'
runtime/tools/node/bin/node scripts/check-tieba-public.mjs 'https://tieba.baidu.com/p/帖子ID'
```

## 5000-token 知识库

位置：`runtime/data/knowledge.sqlite`，与人格独立。QQ、网页、网页生图规划、每日空间文案的 system prompt 都完整包含当前知识库，不做两天裁剪。聊天归档仍保留原来的两日自动回忆规则。

知识库标题提供当前 token 数、5000 上限和版本。`get_knowledge` 返回全文与条目 ID；`update_knowledge` 使用版本及按条 add/replace/delete。按条更新只是便于管理，不限制话题、条数、单条内容或保存天数。

计数使用官方 **DeepSeek-V4.1-Flash-1017** tokenizer，包括正文的条目 ID 和换行，不包含固定工具说明与知识库标题。最多 5000 tokens 的更新在一个事务中提交；超过时整次回滚，返回原内容、原版本、尝试 token 数及“太长了，删几条或精简后再更新”。模型可以自行删旧条目、缩写或放弃新增。并发版本冲突返回最新快照，避免悄悄覆盖。

更新工具不发送 QQ 进度消息；人格中的说话风格也没有因此新增示范台词。当前内容每轮读取，成功修改后的下一次模型请求立即带入新版本。WebUI「人格与提示词 → 查看完整提示词」可查看正文与计数。私有工具日志保留操作结果，供故障排查。

这属于持续提示词记忆，不修改模型权重，也不是模型训练。发布源码包含可重复准备 tokenizer 的脚本；`npm run build` 首次从官方固定 revision 下载约 6 MB 数据，后续复用，完全不下载模型权重。发行包包含该数据，私有状态归档包含知识库与下载图片。

## 部署验收

2026-11-01（香港时间）：真实 DeepSeek 在未指定工具名称的自然请求下，自选 `browse_page → download_image → update_knowledge`，下载并看到了仓库角色原图，测试知识库写入 259 tokens。验证资料放在私有隔离目录，未发送 QQ 消息，未调用生图。后续回复检查未播报知识库维护。实际 Fetch 成功读取正文后，webTokens 和总 tokens 都增加 2500，没有第二余额。

本次定向检查覆盖静图/动图原文件、图片来源/会话参考、5000 接受与 5001 整次回滚、并发版本冲突、重开持久化、QQ 后台工具回执、完整提示词入口和价格结算。完整提示词经手机永久 Tailscale 网关返回 HTTP 200。Native QQ、SSH、Tailscale 进程保持不变。

## 批量流程修复（2026-11-01）

旧协议适配器把超过 4 个合法工具调用也归入 INVALID_TOOL_CALL，QQ 整轮 8 个调用也无法支持逐张抓取/收藏 10 张。现在协议层按字段与 JSON 完整性验证，不再将批量数量当成格式错误；QQ 仍保留成本与防循环边界（16 次模型请求、64 个工具调用），正常批量优先使用数组参数，逐张调用也兼容。

输出被 max_tokens 截断时，这批不完整动作不执行，后台提示模型拆小批次续做，最多修复两次。已知 usage 按实际结算；finish_reason、具体字段错误、工具数量及提供商返回写入原有私有 QQ trace 和 meta.model:last-invalid，不再丢掉诊断只留笼统错误码。

网页解析将正文图片与目录链接排在站点导航前，支持 Markdown 相对图片、公开 JSON 图库的原图字段和分页/名称筛选。不内置特定图库域名，也不根据聊天关键词决定调用什么工具。

真实公开图验证中，模型读取图库后下载了 10 个不同原文件；首轮自行收藏/发送 9 张，后续补齐 10 张不同图片。图片发送接入隔离接收端，未向 QQ 发送测试消息；不是 QQ 十张真实送达的声明。HTTP/图片解码/DeepSeek 均为真实调用，工具参数与动作由模型选择；生产聊天未重放。下载回执也显示 alreadyInLibrary，便于模型区分新文件与重复下载。
