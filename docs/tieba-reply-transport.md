# 贴吧回帖传输重做与验证边界

更新：已删除 publication-needs-human 跨请求拦截；旧失败不阻止新的独立调用。验证状态只描述对应请求的真实返回。WebUI 随最新请求自动展示并打开实际官网验证画面，等待用户操作。

## 已核实的参考版本

阅读并固定到 `Nekomeow114/dsh-tieba-dive` 提交 `06e1657eb5262d3d2337466debf0a7ca1c165fbf`：

- [lib/tieba.js](https://github.com/Nekomeow114/dsh-tieba-dive/blob/06e1657eb5262d3d2337466debf0a7ca1c165fbf/lib/tieba.js)：`encodeAddFloor`、`replyFloor`、`encodeAddPost`、`replySub`、`parseAddPostResponse`，以及 `reply()` 的网页提交路径。
- [CHANGELOG.md](https://github.com/Nekomeow114/dsh-tieba-dive/blob/06e1657eb5262d3d2337466debf0a7ca1c165fbf/CHANGELOG.md)：2026-10-24 的 1.28.0 将主楼回帖改为 App Protobuf 优先；维护者记录当时网页会遇到百度安全验证。这是上游环境的记录，不是本 VPS 的兼容性证明。
- MIT 版权及许可保存在 `third_party/dsh-tieba-dive.LICENSE`。只移植回帖协议结构，没有安装其插件、账号管理、人格、兴趣规则、心跳或发言频率控制。

## 原实现哪里不完整

此前 `postingRequest()` 为所有回复生成普通键值字段，`TiebaBrowser.accountPoster(true)` 附加 BDUSS、TBS 与旧式 MD5 sign 后，用 `application/x-www-form-urlencoded` 请求 `/c/c/post/add`；版本声明为 `12.64.1.1`。返回内容只尝试 JSON，再从若干字段读取新回复 ID。它不是所参考源码中的 Protobuf 回帖协议。

| 层次 | 原实现 | 新回帖实现 |
| --- | --- | --- |
| 端点 | `/c/c/post/add` | `/c/c/post/add?cmd=309731&format=protobuf` |
| HTTP 消息 | URL-encoded 表单 | multipart 的 `data` 文件部分，内容为 Protobuf；`x_bd_data_type: protobuf` |
| 消息结构 | 扁平 key/value | 顶层字段 1 包 data，data 字段 1 包 common |
| 身份与版本 | BDUSS/TBS 位于表单；旧式 sign | common 字段 1=Android 类型，2=`22.12.1.0`，10=BDUSS，11=TBS；data 字段 4 再带 TBS |
| 正文/目标 | `content/fid/kw/tid` 表单字段 | data 字段 19/26/30/45，ID 按上游定义编码为字符串 |
| 主楼回帖 | 与楼中楼共用简化表单 | 使用上游 `encodeAddFloor`，含其固定字段 6/16/18/48，以及主楼路径特有的 55=`13` |
| 楼中楼 | quote/repost 参数不足以说明已实现完整协议 | 使用 `encodeAddPost`：46=quote_id、49=repostid、50=sub_post_id、20=reply_uid |
| 显示名 | 未传 | 上游字段 58，可从当前服务端身份读到时才传 |
| 响应 | JSON 的 post.id 等 | Error 位于顶层字段 1，errno/errmsg 为 1/2；data 位于顶层字段 2，pid 是 data 字段 3 的字符串 |

固定字段的数值和编码类型来自上述源码，没有凭字段号猜测业务含义。请求字节与固定版本上游纯编码器生成的离线样本逐字节比较。multipart 在内存构造，不沿用上游将含凭据消息写入临时 `.bin` 文件再调用 curl 的方式。

上游 `curl --compressed` 的响应解压能力也一并处理：新回帖请求声明 gzip/deflate/br，按响应编码解压后再解析 Protobuf；压缩体与解压输出分别限制为 2 MiB，解码失败仍视为不确定，不重发。

浏览器仍负责原 Profile、账号实际验证和私有凭据边界。BDUSS 仅从该隔离 Profile 读取；TBS 仍取自已验证的现有 `/c/s/login`，不改登录、账号或注册流程。凭据只注入私有请求内存，不进入回执、模型、测试数据或普通日志。

这次替换的是 `reply` / `comment`。新主题帖 `thread` 继续原有传输，本轮没有宣称其已切换为新协议。公开读帖也继续原路径。

## 主楼与楼中楼

- 主楼回帖：不带父楼或子回复引用，走 `encodeAddFloor`。
- 父楼下的评论：实际验证父楼所属帖子和贴吧、父楼作者 UID，quote_id/repostid 均指向父楼，未指定子回复时 sub_post_id 为空字符串。
- 回复某个子评论：还须实际验证该子评论属于指定父楼，从返回内容取得作者 UID、显示名及公开 portrait；按上游 `replySub` 构造 `回复 #(reply, portrait, name) :正文`。缺身份元数据就停止，不猜 UID，不接受模型传入的接收者身份。
- 原读取器合并嵌入 author 与 user_list 中同 UID 的资料，保留公开 portrait；没有把头像添加到帖子配图中。

父楼直接评论的参数字节已与上游编码器对齐，但其空 sub_post_id 的平台实际接受情况仍需受控实发验证；不能拿字节一致冒充已通过平台审核。真实旧失败样本没有回复子评论的案例，该分支目前只有合成样本。

## 接受、可见与后来删除

发送前持久保存意图。一个传输调用只有一次写请求：

| 状态 | 实际证据 |
| --- | --- |
| rejected | 明确拒绝，或明确要求验证码；不转网页再提交 |
| unknown | 超时、损坏/不认识的响应，或接受但没有回复 ID；保留不确定性 |
| accepted | errno=0 且生成了合法 ID，但尚未公开读回匹配正文 |
| confirmed | 非登录视角实际读到对应 ID、作者、范围、时间和内容 |
| deleted | 当前账号官方回收站「系统删贴」中匹配同一 PID/TID 的记录 |

HTTP 200 不是成功依据。一个 Protobuf 成功响应也只证明接受并分配 ID，不证明此后一直可见。仅本人可见与完全未读到分别记录；曾经公开可见而后来读不到、又无明确删除记录时，记为 `no_longer_observed`，不武断叫删除。保留初始回执和最后公开可见时间。

遇验证码、拒绝、未知回执不自动重试，也不自动降级到 `/f/commit/post/add`。上游的失败后网页写入策略没有照搬。相同发布意图按规范化业务字段去重，参数排列变化不能绕过去重；旧不确定回执迁移派生去重键时，原请求与结果不改写。

JSON/HTML 若出现在 Protobuf 响应位置，只用于识别明确拒绝/验证码，其余按不确定处理，不猜测响应 ID。安全回执保留协议版本来源、错误码、是否接受、是否生成 ID及读取证据；不保存原始含凭据请求或任意响应正文。

## 官方网页替代路径评估

本 VPS 用当前账号实际打开了官方网页、回收站，并只打开了空白 Quill 回帖编辑器；没有填入或发布内容。确认可见 `#tb-editor-pb-content .ql-editor` 与 `.publish-btn`，并不等于发布可通过平台验证。当前页面还尝试加载被现有资源边界阻止的 banti-static、tieba-ares CDN；本轮没有更改浏览器资源策略、伪造设备信息或绕过验证码。

因此网页正常交互是可进一步核对的替代方案，而不是本轮已验证的备用发送通道。尤其不能在 Protobuf 请求超时或回执不明后立即走网页重发。

## 当前发布与诊断行为

已有网页授权账号的主楼及楼中楼回复优先使用现有官方网页 Provider。原生控件绑定父楼层、子回复和正文；提交前核对实际目标。当前官网 add_pc 回执的 pid/info 位于根层，解析时区分明确拒绝、接受、未知和公开可见。

已移除跨请求的本地验证锁。旧请求失败不阻止新请求；已拒绝记录不作为新请求的回执复用。等待验证时保留官网画面，WebUI 自动展示最新请求及实际回执。只读账号和内容操作可以复用当前账号浏览器，新发言不会因旧验证窗口被长期拦住。

QQ 和自主探索使用同一套参数验证。未知字段、缺少字段或不匹配的动作参数返回具体字段和原因，且说明请求尚未发出。不会把不支持的 preview 参数删除后悄悄执行真实发布。

官方验证依赖的资源只按已核实的精确域名放行；不关闭浏览器沙箱，不伪造设备参数，不复制验证码凭据或自动换通道重复写入。

## 验证与隐私边界

离线编码样本用于核对协议格式；实际平台接受、非登录视角可见和后续仍然可见必须分别记录。工具传输单独成功不能代替生产模型自主选帖、生成内容及调用工具的完整流程。

项目具有内部 simulated_owner_signal 触发入口，复用生产探索队列、模型、人格、记忆及原生工具，不伪造 QQ 事件。受控验证的真实发言授权单独记录；详细模型请求、平台回执、账号和运行证据留在私有活动记录中，不提交到公开仓库。

用户要求不增加或运行额外测试时，只进行必要构建和已明确授权的实际操作。任何说明都不能将一次成功扩大为长期稳定保证。
