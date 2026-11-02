# QQ 合并转发聊天记录

OneBot 的 `forward` 消息此前被忽略，只有转发卡片时甚至不会进入聊天。现在入站消息保留一个会话内的 `forward-…` 引用，模型每轮都能选择 `read_forward`；没有根据意图关键词强制选择工具。普通群消息仍仅存档，不下载转发图片或调用模型。

`read_forward` 不传 `id` 时列出当前会话收到的记录；传入引用后读取原发言者、时间、文字、图片和子记录 ID。`offset/count` 翻页，长消息用同一个 offset、count=1、textOffset 续读。每页最多10条、文本最多约6000字符，图片沿用现有静图/动图解析及原图收藏能力。多图页超过本次图片额度时返回逐张状态，可缩小到单条再读。

嵌套转发按返回的 child ID 继续打开，一次只展开所选层；不把整个树灌进每轮上下文。支持原生 forward、内联 content、node 包装及合并转发 JSON/XML 卡片。优先解析外层已返回的内联内容；重启后通过外层根记录重新找到内层，避免将 NapCat 无法独立检索的内层 message_id 当根记录请求。异常或过期记录返回真实错误，不用旧聊天或空间配图替代。

原发言者身份属于转发记录的署名，并不代表已验证身份，也不是当前向肥鱼发指令的人。记录 ID 绑定当前会话，不能跨私聊/群读取。原始 CDN 下载句柄仅在内存保留；可迁移数据库保存记录引用与层级路径，读取后的图片沿用现有媒体库。QQ 日志保留实际工具读取结果。

接口形态按 [NapCat GetForwardMsg 实现](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/go-cqhttp/GetForwardMsg.ts) 和 [消息解析实现](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/api/msg.ts) 核对。客户端返回卡片缩略图不等于已读取聊天全文；按工具结果判断已读范围。
