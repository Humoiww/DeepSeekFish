# 社交平台公开阅读

QQ、随机探索、每日新闻和 WebUI 受限助手复用 `browse_page`。WebUI「连接与设置 → 允许自主联网」继续控制这一能力；无额外站点开关、话题名单或意图分类。模型决定访问什么、是否翻页、看回复或下载图片。这里只适配不同 URL 的公开表示，不创建另一套 Agent 或账本，也不添加人格台词。

| 平台 | 直接交给 browse_page 的地址 | 可读内容与备用入口 |
| --- | --- | --- |
| X / Twitter | `https://x.com/账号/status/ID`、`https://x.com/账号`；twitter.com 地址同样支持 | FxEmbed v2 的原帖、引用、账号列表和转发；回执 `commentsUrl` 读取公开回复。单帖失败尝试 X 官方 oEmbed |
| Reddit | `https://www.reddit.com/r/社区/new/`、`/r/社区/comments/ID/标题/`、`/user/账号/`；旧站、短链接兼容 | RSS/Atom，匿名 JSON；原帖必要时尝试官方嵌入。原生入口失败时可读明确标注的 Arctic Shift 公开归档；`commentsUrl` 提供归档评论树 |
| Bluesky | `https://bsky.app/profile/账号`、`/profile/账号/post/ID` | 官方公开 AppView，自动解析 handle 为 DID；保留转发/引用的实际作者，线程返回两层回复，可打开具体回复继续读 |
| Mastodon | 任意公开实例的 `/@账号`、`/@账号/ID` | 同实例公开 API；`commentsUrl` 读取祖先/回复，账号列表支持继续翻页。非 Mastodon 的同形地址失败后继续普通网页读取 |
| RSS / Atom | 公开订阅 URL | 正文、作者、时间、链接、配图和订阅分页；普通网页也发现 RSS/Atom 订阅链接 |

原有贴吧、B站、普通网页/JSON、原图下载与收藏保持共用入口。平台适配列表不是网络域名白名单，其他公开 HTTP(S) 地址仍走普通读取器。

## 正文、来源与消耗

- 每次正文最多 5000 字符，`textOffset` 续读。社交列表 `offset/nextOffset` 翻本次已经取回的条目，`nextPage` 才访问平台下一页。不会自动追完所有页面。
- 每条保留实际作者、原生 ID、发布时间、父评论/引用关系和转发者。头像不归入帖子配图，视频只返回标注的封面。公开图片 URL 继续可用 `download_image → collect_meme` 或作为生成参考，由模型选择。
- QQ 上下文压缩保留来源、覆盖范围、下一页和回复入口。完整身份/图片/链接元数据仍可 `read_tool_result` 取回，不重复塞入每轮输入。
- 公共响应有 60 秒、最多 32 条/8 MiB 的进程内缓存，续读同一页不重复敲站点，保留原始获取时间。没有磁盘缓存、后台爬虫或重复重试循环。
- 这些直接公开读取不调用付费 Search/Fetch；原有 Search/Fetch 与模型 token 继续计入共享 CNY 额度，测试脚本不会调用模型或向 QQ 发消息。

## 真实限制与错误

X 默认来源为第三方 **FxEmbed**，备用单帖为官方嵌入，不冒称 X 官方 API。Reddit 匿名 JSON 在当前 VPS 返回 403，RSS 连续访问可能返回 429；备用嵌入只有原帖，归档可能滞后，不代表当前最新/完整内容。Reddit RSS 不提供完整评论父节点，不能据此杜撰嵌套关系；归档评论树有真实 parent_id。

所有入口都保留 `provider/sourceUrl/coverage/fetchedAt/unavailable`，并令 `latestVerified:false`。`publishedAt`、`updatedAt`、`archivedAt` 不互相冒充。错误包含尝试过的公开 URL 与错误码；登录页、错帖、空客户端壳不会伪装成读到了指定帖子。用户可让模型继续搜索其他公开来源。

站点可以要求登录、限流、删除内容或停止提供接口，不能承诺任何社交平台永远可访问。适配器不携带账号凭据，不执行网页指令，保留逐跳公网 DNS 校验、取消信号和有界下载。私有账号、Cookie 登录浏览器与平台发帖不在本次改动内。

## 2026-11-06 实测

在运行 QQ 的同一 VPS 上使用真实 `browsePage/readPublic`：

- X：`jack/status/20` 取得真实正文与 2006 年时间；DeepSeek_AI 主页及下一页取得实际作者、转发与媒体；公开回复接口返回 34 个条目。原图 `pbs.twimg.com` 下载得到 110761 字节 JPEG。
- Reddit：redditdev 社区取得 20 条，帖子 `1ts4j3r` 取得原帖和评论共 11 条；连续下一页确实遇到 429。模拟原生入口限流后，**真实**官方嵌入成功返回原帖，**真实** Arctic Shift 返回 10 条社区归档、15 条带 parent_id 的评论树。归档与实时 RSS 不混标。
- Bluesky：账号列表及列表中真实作者的帖子成功，回复可分页读取；故意用转发者账号拼接原作者帖子 ID 则失败，未错误归属内容。
- Mastodon：mastodon.social/@Gargron 账号列表、列表中的原帖成功。
- FxEmbed 文档中的 `/2/search` 实测 HTTP 404，因此不宣称原生 X 搜索已打通。帖子与账号读取不受这个端点影响；已有 `search_web` 仍由模型自主选择。

复查任意目标（先 build，免费公开读取）：

```bash
runtime/tools/node/bin/node scripts/check-social-public.mjs \
  'https://x.com/jack/status/20' \
  'https://www.reddit.com/r/redditdev/comments/1ts4j3r/'
```

`tests/social-web.test.ts` 覆盖实际 URL 请求顺序、作者/评论关系、错帖校验、限流回退、归档时间、分页、缓存淘汰、取消、XML 实体不执行、模型自选调用、WebUI 联网开关和 QQ 上下文压缩。完整离线回归最终 **232/232** 通过。网络实测不混称真实 DeepSeek 对话测试；模型选择与原生工具配对由离线集成测试验证。本次没有付费模型调用、QQ 发布或改写人格/记忆。

参考实现依据：[FxEmbed API](https://docs.fxembed.com/api/introduction/)、[Reddit API](https://www.reddit.com/dev/api/)、[Arctic Shift API](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md)、[Bluesky getPostThread](https://docs.bsky.app/docs/api/app-bsky-feed-get-post-thread)、[Mastodon statuses](https://docs.joinmastodon.org/methods/statuses/)。
