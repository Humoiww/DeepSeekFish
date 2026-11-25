# 目录与架构

[文档索引](README.md) · [接口参考](api.md) · [项目约定](project-conventions.md)

## 目录

| 目录 | 内容 |
| --- | --- |
| [`src/agent/`](../src/agent/) · [`src/provider/`](../src/provider/) | 对话和工具循环、模型请求、OpenCode Go 目录与连接预设 |
| [`src/budget/`](../src/budget/) · [`src/storage/`](../src/storage/) | 共享人民币账本、用量以及 SQLite 存储 |
| [`src/qq/`](../src/qq/) · [`src/tieba/`](../src/tieba/) | QQ 传输、媒体、每日活动、贴吧账号、阅读和发布 |
| [`src/exploration/`](../src/exploration/) · [`src/memory/`](../src/memory/) | 随机唤醒、好奇心日志、对话归档、知识库 |
| [`src/search/`](../src/search/) · [`src/capture/`](../src/capture/) | 公开网络读取、平台适配和隔离浏览器进程 |
| [`src/web/`](../src/web/) | 本机 WebUI、HTTP 路由、Tailnet 网关，静态前端位于 `public/` |
| [`src/codex/`](../src/codex/) · [`src/image/`](../src/image/) · [`src/development/`](../src/development/) | Codex 协议、生图、开发任务、Neon 桥接和交付回执 |
| [`personas/`](../personas/) · [`assets/`](../assets/) · [`third_party/`](../third_party/) | 默认人格、资源与第三方材料 |
| [`tests/`](../tests/) · [`deploy/`](../deploy/) · [`scripts/`](../scripts/) | 离线测试、systemd 单元、安装与运维脚本 |

`dist/` 是编译产物，`node_modules/` 是本地依赖。私有 `runtime/` 保存账号状态、聊天记录、预算、任务与日志。示例配置可提交，实际 `.env`、`config/local.json` 和账号资料各自在部署环境维护。另行检出的项目应加入本机的 `.git/info/exclude`，与主仓库分别提交。

## 请求从哪里经过

1. WebUI、QQ 或定时任务组装上下文。首条系统消息带静态人格和可选口吻示例，末条带完整人格与当轮抽样颜文字。QQ 近聊、探索旧笔记和网页工具结果各自按会话范围读取。
2. 模型路由选择当前已配置的 DeepSeek 或 Go 连接。含图片的请求可按能力回落到默认 DeepSeek 视觉连接。预算先原子预留，再按实际缓存、未缓存输入和输出结算。调用不确定时保留预留与诊断。
3. 模型从当前允许的工具选择动作。程序负责对话和账号范围、工具参数、平台回执和幂等去重。贴吧自动发布、人工验证和只读回查各有独立状态。
4. 通用开发和生图分别运行。通用提案可在本机审批，独立开发服务接收受授权的主人委托。Neon 分诊和审阅、Codex 实现、生产切换分别留下记录。[接入指南](neon-codex-development-bridge.md)

## 本地维护

```bash
npm ci --ignore-scripts
npm run build
node --test --test-isolation=none --test-concurrency=1 dist/tests/*.test.js
```

低内存 VPS 可在构建和测试前设置 `NODE_OPTIONS=--max-old-space-size=384`，按顺序运行。改动对外接口时同时更新 [接口参考](api.md)或对应模块文档。提交前用 `git diff --cached --check` 检查格式，确认暂存区只包含可公开的源码、资源和说明。
