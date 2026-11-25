# 文档索引

根目录 [README](../README.md)提供项目简介；这里按用途定位详细说明。各功能的默认值和权限以对应模块及当前配置为准，历史验收记录不代表新安装已经启用。

## 开始使用与部署

| 文档 | 内容 |
| --- | --- |
| [快速开始](quickstart.md) | 本地 WebUI、Linux／Windows 启动、QQ 接入选择、可选 Codex |
| [WebUI](webui.md) | 网页聊天、文件工作区、人格编辑、生图、费用与设置 |
| [部署与迁移](migration.md) | VPS 安装、状态导出／恢复、新机重新登录 |
| [Linux 运行环境](linux.md) | 项目内运行时、进程管理、隔离环境排错 |
| [VPS 部署维护](vps-deployment.md) | systemd、运行账户、部署脚本与服务维护 |
| [配置说明](configuration.md) | JSON、WebUI、CLI 与持久设置的关系 |
| [接口参考](api.md) | WebUI HTTP、肥鱼的开发工具、Neon Unix Socket 与原生 Codex RPC |

## QQ、人格与媒体

| 文档 | 内容 |
| --- | --- |
| [NapCat / OneBot 接入](qq-onebot.md) | 个人 QQ 登录、私聊／群聊授权、@ 与关键词唤醒 |
| [QQ 人格与原生工具](qq-personality-tools.md) | 模型选择工具、身份、图片生成与消息回传 |
| [记忆与人格](memory-persona.md) | 人格分块、近期上下文、按日期归档和历史检索 |
| [图片与表情包](qq-media.md) | 静图／动图解析、收藏、图库与发送 |
| [媒体隔离](qq-media-isolation.md) | 媒体解码和私有运行边界 |
| [文件发送](qq-files.md) | 图库文件与普通附件的发送范围及回执 |
| [转发聊天记录](qq-forward.md) | 转发节点、嵌套记录和图片读取 |
| [QQ 空间读取](qzone-reading.md) | 区分自己、对话用户及其他账号的说说 |
| [原生 GIF](native-gif.md) | Codex 通道、原生动图产物与服务端能力限制 |

## 联网、探索与每日活动

| 文档 | 内容 |
| --- | --- |
| [联网与长期知识库](web-knowledge.md) | Search / Fetch / Browse、图片下载、5000-token 知识库 |
| [社交平台读取](social-browsing.md) | Twitter/X、Reddit 等公开内容适配与来源边界 |
| [随机刻自主探索](autonomous-exploration.md) | 唤醒机制、工具选择、兴趣日志、分享与提案 |
| [每日新闻](daily-news.md) | 香港时间早间分享、选题和送达状态 |
| [每日空间](daily-qzone.md) | 香港时间午夜日常、模型配图与发布回执 |
| [探索验证记录](exploration-validation.md) | 探索机制的既有实现及验证范围 |

## 贴吧

从 [贴吧模块索引](tieba/README.md)开始：

- [账号与登录](tieba/account.md)：独立 Profile、手动登录、身份确认、安装维护。
- [看帖与通知](tieba/reading.md)：公开／登录读取、分页、父楼与子回复、私信能力边界。
- [发帖和楼中楼](tieba/publishing.md)：工具参数、关注吧权限、发布回执与公开可见性。
- [验证码与排错](tieba/verification.md)：最新请求、官网实时画面、本地错误和真实平台返回。
- [新回复唤醒](tieba/reply-watch.md)：检测后五分钟入队，由模型决定如何处理。
- [小吧主申请](tieba/moderator.md)：资格检查、模型感言、官网提交及待审批状态。
- [传输层](tieba/transport.md)：官方网页、App Protobuf 与新主题表单的职责。
- [技术研究](tieba/research.md)：核实过的协议源码、维护反馈和路线选择。
- [验证范围](tieba/validation.md)：真实模型流程、证据层次和当前已知限制。

## 预算、诊断与开发

| 文档 | 内容 |
| --- | --- |
| [人民币预算](cny-budget.md) | 缓存／未缓存输入、输出、联网费用与 Reset |
| [活动记录与诊断](activity-diagnostics.md) | 每轮请求、工具动作、真实错误与用量来源 |
| [架构](architecture.md) | 模型、工具、传输、任务及存储的组织 |
| [P0 / P1 评价与改造通路](p0-p1-review-and-flows.md) | 贴吧 Web 界面卡顿与 DeepSeek 活动/工具协议根因分析及重构方案 |
| [接入 Codex 和 Antigravity](neon-codex-development-bridge.md) | CLI 登录、Unix Socket、systemd 配置、开发委托和上线核对 |
| [权限边界](security.md) | 凭据、工作区、账号、审批和宿主隔离 |
| [早期技术研究](research.md) | 历史选型资料 |
| [早期验收记录](status.md) | 按日期保存的历史结果，不能代替当前环境核验 |

账号身份、聊天正文、实际发言、凭据、私网地址和完整生产 trace 不放入这些公开说明。
