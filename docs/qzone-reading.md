# QQ空间说说与头像

QQ 头像是个人资料的图片；QQ空间本人说说来自 emotion_cgi_msglist_v6 的 msglist，具有独立的 tid、发布时间、正文、图片/视频字段。这两种来源现在使用不同工具，不能互为失败兜底。

实现参考社区原始代码：[qzone-sdk](https://github.com/Eganchiyu/qzone-sdk)、[TeamSUEP emotion_list_raw](https://github.com/TeamSUEP/Index-SUEP-Channel/blob/main/qzone.py)。列表按新到旧，pos 为从 0 起的偏移，num 为数量。本机已用真实账号核对返回列表与指定序号：最新是第 1 条，上一条第 2 条，上上条第 3 条；第 N 条直接请求 pos=N-1。明确序号由可信代码解析，模型不能把“上上条”改成最新。

get_qzone 返回每条说说的实际 ID、位置、时间、正文和对应媒体。每张送入视觉模型的图前面都有所属 postId、位置和媒体类型，头像完全不进入该链路。单条读取包含其配图，列表预览每条先取一个附件；可继续指定某条查看全部配图。图片下载失败时保留该说说身份和失败状态，不拿头像或其他说说的图片顶替。

视频目前下载封面，标记 video_cover / cover_only；没有读取完整视频，不能据此声称看过完整视频动作。GIF 按实际文件类型标记 animated_image。

正常情况下默认单条；“最近四条”“每条/逐条”可以读取一页，单页最多 10 条。total、nextIndex 明确显示尚有多少及下一页位置；单页仅代表已取回的这一页，不代表已经读取全部列表。已采集的每条资料和原始附件、选定说说截图保存在 runtime/memory/people/，SQLite 的 qzone_observations 保存索引；正常回忆仍遵守当前会话和近两天范围。

本机真实验证：前 4 条逐条核对真实 ID、正文与附件；上上条实际请求 pos=2，返回第 3 条真实 ID，视觉模型接收该条两张 JPEG，没有头像。第 4 条的视频附件明确标记为封面。完整记录在私有 runtime/logs/qzone-third-live-check.json 与 qzone-page-live-check.json，私人原文和图片不放进 Git。测试使用记录型发送器，没有向 QQ 发测试消息。
