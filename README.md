# DeepSeekFish

DeepSeekFish（大肥鱼）是一个自托管的 QQ 与 Web 助手。她使用模型的原生工具调用聊天、查资料、管理记忆和图片，也可以在授权范围内探索互联网、参与贴吧、分享新闻和 QQ 空间动态。

- **聊天与模型**：支持 DeepSeek 和 OpenCode Go，连接预设可切换模型、密钥槽和思考模式。WebUI 显示官方 Go 订阅额度。
- **人格与记忆**：可编辑人格和口吻示例。静态人格放在请求开头，带随机颜文字的完整人格保留在末尾。近聊、归档、知识库和好奇心日志各有自己的读取方式。
- **开发协作**：可选接入 Antigravity（Neon 小猫）分诊和审阅，由原生 Codex App Server 改码。任务进度、审阅和上线回执可在 WebUI 查看。

## 快速开始

需要 Node.js **24.9+**。Linux 的启动脚本可准备项目内 Node，Windows 使用 `start.bat`。

```bash
git clone https://github.com/Humoiww/DeepSeekFish.git
cd DeepSeekFish
./start.sh --mock
```

打开 <http://127.0.0.1:17862> 体验离线演示。正式运行用 `./start.sh`，在「连接与设置」保存自己的 API Key。QQ 和开发桥接可分别配置。[快速开始](docs/quickstart.md)

## 文档

| 任务 | 入口 |
| --- | --- |
| 配置模型、费用、人格与活动记录 | [WebUI](docs/webui.md) · [配置](docs/configuration.md) · [活动诊断](docs/activity-diagnostics.md) |
| 接入 QQ 或贴吧 | [NapCat / OneBot](docs/qq-onebot.md) · [贴吧](docs/tieba/README.md) |
| 了解后台探索和主动分享 | [自主探索](docs/autonomous-exploration.md) · [每日新闻](docs/daily-news.md) · [每日空间](docs/daily-qzone.md) |
| 接入 Codex 和 Antigravity | [接入指南](docs/neon-codex-development-bridge.md) · [接口参考](docs/api.md) |
| 开发、部署与迁移 | [目录与架构](docs/architecture.md) · [部署与迁移](docs/migration.md) · [完整文档索引](docs/README.md) |

源码在 `src/`，测试在 `tests/`，示例配置在 `config/`，服务单元与安装脚本在 `deploy/` 和 `scripts/`。聊天、登录资料、API Key 与本机配置留在各自部署环境。[权限边界](docs/security.md) · [人设与第三方来源](personas/README.md)
