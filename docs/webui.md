# 本地 WebUI

根目录 `./start.sh`（Linux）或 `start.bat`（Windows）会检查 Node >=24.9，依赖缺失时在项目内执行 `npm ci --ignore-scripts`，构建后启动 WebUI 并请求系统默认浏览器打开本地地址。没有桌面环境时打印手动访问提示；`--no-open` 不调用浏览器，`--mock` 使用明确标记的离线演示。自动安装需要能访问 npm。也可先 `npm ci --ignore-scripts && npm run build`，随后 `npm run webui`。

## 连接与对话

服务只绑定 IPv4 `127.0.0.1:17862`。浏览器自动连接使用随机、5 分钟有效、单次消费的 URL fragment，前端立即从地址栏删除；页面 API 需要本机令牌，令牌只保存在当前浏览器会话。手动打开页面时，从 `runtime/data/webui-admin-token` 复制令牌。固定 Host、同源检查、CSP、无外部脚本资源限制 DNS rebinding、跨站请求和脚本注入。

连接失效时，重新运行根目录启动脚本即可。若服务已运行，新脚本使用项目令牌向该服务申请新的一次性连接，再打开默认浏览器；不重置凭据、不恢复失效链接、不重放消息。此时沿用已运行服务的正式/Mock 模式，需要切换模式时先 `npm run cli -- web-stop` 再启动。

设置窗口允许填写 Key、模型、输出上限和每日全局 token 上限，并单独开启搜索/Codex 排队。Key 只写到 `runtime/data/webui-secrets.json`，在 POSIX 上新文件为 0600；也可从项目 `.env` 读取。配置接口只返回 credentialPresent，不返回 Key。不要在聊天中粘贴密钥。保存配置不验证余额或发起请求；HTTP 401/402/429 等错误在实际发送消息时显示。正式/Mock 共享本机连接令牌和密钥文件，但使用不同会话数据库与 Mock 预算，Mock 不发真实 HTTP。

模型默认 `deepseek-flash`。采用[官方非思考模式 Function Calling](https://api-docs.deepseek.com/guides/tool_calls/)的 assistant.tool_calls → tool.tool_call_id → assistant 循环；请求固定发往 `https://api.deepseek.com/chat/completions`，禁止重定向和自定义内网 endpoint。不依赖 OpenAI SDK，不额外引入前端构建链。主模型每轮非流式返回；浏览器通过 NDJSON 实时显示请求阶段、工具结果和最终文字，**不是 token 级输出流**。

每个会话有独立服务器端上下文，只发送最近 3 个完整成功回合、合计约 24 KiB 的历史；不接受浏览器提交伪造 system/tool 历史。失败或取消的未完成工具链不加入后续上下文。最多 50 个会话、每会话 100 条用户消息；达到上限时需要本机维护数据库。当前未提供永久删除/重命名会话界面，历史与文件不会自动长期归档。

## 工具与权限

| 工具 | 服务器侧约束 |
| --- | --- |
| list_files | 只扫描当前会话固定工作区；条目数、深度、路径、链接检查 |
| read_file | 工作区内白名单文本类型；64 KiB；不读取 dotfile、凭据命名或链接 |
| write_file | 同上；最多 20 文件 / 合计 1 MiB；不写项目源码；临时文件后原子替换 |
| search_web | 设置默认关闭；复用 SearchService 的 query、公开 URL、缓存、次数预算检查 |
| queue_codex | 设置默认关闭；只创建 waiting 任务，返回明确待审状态；没有授权工具 |

纯对话模式完全不向 API 提供工具，收到意外工具调用也拒绝。受限模式只暴露上表当前允许的工具；服务器验证名字、参数字段、类型和实际权限，模型输出无法开启设置。文件工作区由服务器按 UUID 生成在 `runtime/workspace/web-UUID/`；拒绝绝对路径、../、Windows ADS/设备名、symlink/junction、硬链接、隐藏路径和任意执行文件。模型不会获得操作系统 shell 或项目目录访问能力，文件限制由 Node 工具处理器执行，不依赖 prompt 充当文件隔离。

下载只通过受认证的文件接口，强制 `Content-Disposition: attachment`、`text/plain` 和 sandbox CSP；HTML/SVG/脚本不会在工作台页面执行。所有动态消息和工具结果用 textContent 渲染，代码块不执行、不解析任意 HTML。

Codex 待审任务在右侧显示请求、状态和终端审核命令：

```bash
npm run cli -- web-status
npm run cli -- web-approve 任务UUID --reviewed
```

审核前核对任务 request/brief。真实执行仍使用既有项目 ChatGPT 登录、生成的独立 Codex UUID 工作区、隔离探针与 Linux/Windows 边界。没有将会话文件隐式复制给 Codex；需要上下文时，应在待审任务说明中明确提供可公开内容。任务结果与清单进入既有 runtime/outputs；当前 WebUI 只展示状态/摘要，没有嵌入执行终端或 Codex 图片入口。

## 预算、取消与持久化

正式模式复用 `runtime/data/fish.sqlite` 的全局额度，QQ 与 WebUI 的调用合并统计。会话/任务记录在 `webui.sqlite`；Mock 使用 `webui-mock.sqlite` 和 `webui-mock-budget.sqlite`，不污染正式账本。每轮 API 请求在发送前按序列化消息、工具 schema、输出上限原子预留，按真实 usage 结算；无有效 usage 的失败保留预留，异常超额锁住后续请求。默认全局 120000 tokens、每用户每日 50 次模型请求；工具循环中的每轮也算请求。输出默认 1024，上限可设 128–4096。

每条用户消息最多 4 次模型请求、6 次工具调用、120 秒，总并发最多 2 个会话，同一会话只允许 1 条处理中消息。第 4 轮请求禁止再调用工具；若 provider 不遵守，服务器拒绝执行。停止按钮断开流并中止上游 fetch；已经完成的文件写入和已经发生的 API 用量不会回滚。进程重启不自动重放消息/任务，运行状态变为失败；QQ 的恢复不会释放 WebUI 活跃 Codex 预留。

Ctrl+C 或 `npm run cli -- web-stop` 停止服务。项目运行数据、缓存、配置与截图均在 runtime；系统浏览器自身的配置/缓存仍由浏览器正常管理，这是用户要求打开默认浏览器的正常行为。

## 验证范围

2026-10-27：36 项自动化测试通过，新增 WebUI 测试覆盖官方请求格式/工具回传、每轮 usage、会话隔离、文件限额/链接/路径、未开启工具拒绝、循环上限、取消、全局预算、本机鉴权与 bootstrap 重放拒绝、下载安全头及 Codex 待审。

Linux 根目录启动脚本已从项目外目录启动成功；默认浏览器调用使用项目内替身捕获并核对实际参数，一次性连接在真实浏览器验证成功。浏览器已验证新会话、Mock 文件创建及结果显示、工作区隔离、设置窗口、正式模式无 Key 也能启动。Windows BAT 提供源码与 Node 启动路径，尚未在 Windows 机器实跑；真实 DeepSeek 调用仍需用户填写 Key 后验收。
