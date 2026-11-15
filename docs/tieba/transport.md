# 贴吧发布传输层

[贴吧目录](README.md) · [工具与回执](publishing.md) · [研究依据](research.md)

模型使用统一的 `publish_tieba`，不选择或拼接底层协议。账号会话、发言意图、传输与可见性核对分开处理。

## 当前通道

| 动作／配置 | 传输 |
| --- | --- |
| `reply`、`comment`，已有网页授权的账号 | 独立 Chromium 中官网原生控件和网站 JavaScript |
| `reply`、`comment`，未启用网页路径 | 已移植的 App Protobuf |
| `thread` 新主题 | 保留现有 `legacy_thread_form`，不能称作已切换原生网页 |
| 小吧主申请 | 独立的官网申请表，见 [申请说明](moderator.md) |

已有网页路径不表示百度向项目授予通用自动化 API 权限。某次失败不触发另一个写通道补发。

## 官方网页回复

网页使用 `/c/c/post/add_pc`。浏览器按真实父楼 `pid` 定位页面，用父楼／子回复组件的实际 ID 找普通回复按钮，编辑框与发布按钮限定在选中的组件内。

当前核对过的官网脚本 `pb.160c8c07.js`：

- 普通新楼层不带父楼引用。
- 楼中楼的 `quote_id/repostid` 指向父楼。
- 回复某条子评论时另带 `sub_post_id`，官网添加 `回复 #(reply, portrait, name_show) :正文`。
- 编辑框只输入正文，出站内容核对包含官网产生的真实接收者前缀。
- 现有 `add_pc` 的 PID 和验证 `info` 可以位于响应根层，不能只读取 `data.pid`。

只观察正常界面绑定并操作控件，不直接设置 Vue 状态、不调用页面内部发布函数、不复制验证凭据。发送前保存意图，页面请求核对实际目标及内容。尚未点击提交的编辑器／目标准备错误记为 `notSubmitted`，不当作未知送达。

## App Protobuf 依据

协议来自 [dsh-tieba-dive 固定提交](https://github.com/Nekomeow114/dsh-tieba-dive/tree/06e1657eb5262d3d2337466debf0a7ca1c165fbf)的 `lib/tieba.js` 与 `CHANGELOG.md`。移植了 `encodeAddFloor`、`encodeAddPost`、`replyFloor/replySub` 对应结构和 `parseAddPostResponse`；许可见 [MIT 归属](../../third_party/dsh-tieba-dive.LICENSE)。没有引入上游的人格、心跳、账号管理或失败切换策略。

| 项目 | 实现 |
| --- | --- |
| 端点 | `/c/c/post/add?cmd=309731&format=protobuf` |
| 外层 | multipart `data` 文件部分；`x_bd_data_type: protobuf` |
| 消息 | 顶层字段1为 data，data 字段1为 common |
| common | 字段1=Android类型，2=`22.12.1.0`，10=BDUSS，11=TBS；data 字段4另带TBS |
| 正文与目标 | data 字段19/26/30/45 对应 content/fid/kw/tid，ID 保持字符串 |
| 普通回复 | `encodeAddFloor`，含上游固定字段及55=`13` |
| 楼中楼 | `encodeAddPost`，46=quote_id、49=repostid、50=sub_post_id、20=reply_uid |
| 显示名 | 58，从实际账号身份可取得时传入 |
| 回执 | 顶层1为错误，顶层2为 data，data 字段3为 PID 字符串 |

multipart 在内存构造，不把含凭据消息写成临时文件。响应支持 gzip/deflate/br，压缩体和解压输出分别有大小边界。私有凭据由隔离传输添加，不进入模型或普通日志。

以前的缺陷是把普通 URL-encoded 字段发往旧 `/c/c/post/add`，只尝试 JSON 响应；更换 URL 或 User-Agent 不能把它变成完整 Protobuf。当前编码与固定上游离线样本的核对是既有格式证据，不能代替平台接受或公开可见性。

## 回执和可靠性

网页与 App 最终都使用相同的发布记录和只读核对。接受、有效 ID、本人可见、公开可见、后来系统删除分别记录，详见 [发布说明](publishing.md)。解析异常、验证码及未知结果不自动重发。

App Protobuf 有单次成功证据，也遇过平台安全验证；网页原生回复有真实接受／公开可见样本。楼中楼的父楼定位、组件范围和前缀核对已修复，但本次文档整理没有新增真实发言，不能宣称所有子回复场景已通过端到端验收。平台验证与审核仍可能变化。

源码：[App 编码](../../src/tieba/app-post.ts) · [Protobuf](../../src/tieba/protobuf.ts) · [网页回执](../../src/tieba/web-post.ts) · [浏览器](../../src/capture/tieba-browser.ts)。
