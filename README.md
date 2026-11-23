# DeepSeekFish

住在服务器里的大肥鱼：通过 DeepSeek 原生工具调用聊天、浏览网页、维护记忆、收藏图片和参与贴吧，也能偶尔自己醒来探索互联网。

项目包含 QQ 私聊／群聊、WebUI、人格分块编辑、长期知识库、图片与文件发送、随机探索、每日新闻和空间动态。工具由模型选择；账号权限、资源预算和真实回执由程序处理。

## 快速开始

需要 Node.js **24.9+**。Linux 启动脚本可准备项目内运行时；Windows 使用已有 Node.js。

```bash
git clone https://github.com/Humoiww/DeepSeekFish.git
cd DeepSeekFish
./start.sh
```

WebUI：<http://127.0.0.1:17862>。在「连接与设置」配置自己的 DeepSeek API Key。Windows 使用 `start.bat`；无 Key 演示使用 `./start.sh --mock`。

本地启动、QQ 两种接入方式及可选 Codex 登录见 [快速开始](docs/quickstart.md)。VPS 部署与换机见 [部署与迁移](docs/migration.md)。

## 文档入口

| 想做什么 | 文档 |
| --- | --- |
| 初次运行、选择接入方式 | [快速开始](docs/quickstart.md) |
| 使用网页、设置人格、查看活动记录 | [WebUI](docs/webui.md) · [记忆与人格](docs/memory-persona.md) · [调用诊断](docs/activity-diagnostics.md) |
| 接入个人 QQ、设置群聊唤醒、发送媒体 | [QQ 接入](docs/qq-onebot.md) · [人格与工具](docs/qq-personality-tools.md) · [图片与表情包](docs/qq-media.md) · [文件发送](docs/qq-files.md) |
| 搜索、读网页、浏览社交平台 | [联网与知识库](docs/web-knowledge.md) · [社交平台读取](docs/social-browsing.md) |
| 登录贴吧、看帖、回帖及申请小吧主 | [贴吧模块索引](docs/tieba/README.md) |
| 随机探索、兴趣日志、定时分享 | [自主探索](docs/autonomous-exploration.md) · [每日新闻](docs/daily-news.md) · [每日空间](docs/daily-qzone.md) |
| 设置每日费用、理解缓存与未知费用 | [人民币预算](docs/cny-budget.md) |
| 部署、迁移、配置与维护 | [部署与迁移](docs/migration.md) · [配置](docs/configuration.md) · [权限边界](docs/security.md) |
| 向肥鱼委托项目开发 | [开发任务与手工验收](docs/development.md) |

[全部文档](docs/README.md)包含模块说明、源码位置、技术研究与历史验证记录。

## 使用说明

账号登录、对外发布和后台功能按各模块的授权配置启用。普通 Codex 提案仍需本机审核。部署了独立开发服务的实例支持主人通过 QQ 私聊逐项授权项目开发。图片生成使用独立通道和每日张数限额。贴吧私信收发尚未接入，平台验证码及审核结果以实际返回为准。

私人聊天、账号资料、密钥和运行状态保存在被 Git 忽略的 `runtime/` 中。公开仓库只保存实现与说明；人格来源和许可见 [人设说明](prompts/README.md)。
