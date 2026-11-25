# 接入 Codex 和 Antigravity

[文档索引](README.md) · [接口参考](api.md) · [VPS 部署](vps-deployment.md)

普通 QQ 与 Web 聊天只需要已配置的模型连接。需要把开发委托交给肥鱼时，在 Linux/systemd 部署上另启开发服务和 Neon 桥接。

| 组件 | 职责 |
| --- | --- |
| 肥鱼 | 接收授权主人的需求和追问，转述实际交付结果 |
| Antigravity CLI（Neon 小猫） | 读取源码并分诊，直接答复、澄清，或交给 Codex。实现后审阅 diff 和验证输出 |
| Codex App Server | 在管理检出中执行改动，通过原生线程提供进度、追问和中断 |
| 开发服务与部署器 | 核对主人授权、生产基线和候选变更。审核通过后完成切换、健康检查和回执 |

WebUI 普通 Codex 提案使用本地审核；图片使用独立的 Codex 登录与张数额度。仅需要这两项时，按 [快速开始](quickstart.md#可选-codex-与图片)配置即可。

## 准备两个已登录的 CLI

在运行桥接的普通 Linux 用户下完成。仓库里的 systemd 模板使用 `fishops` 和 `/home/fishops/DeepSeekFish`，按你自己的用户、目录与 Node 路径调整本机副本。

1. 安装能够提供 Unix Socket 的 Codex CLI。在同一个用户下执行 `codex login`（无桌面可用 `codex login --device-auth`），再用 `codex login status` 确认。已有 app-server 时复用它；支持 daemon 子命令的 CLI 可用 `codex app-server daemon start`。用 `test -S <实际 socket 路径>` 确认端点。托管 daemon 常用 `~/.codex/app-server-control/app-server-control.sock`，显式启动的独立实例也可用 `codex app-server --listen unix:///绝对路径/文件.sock`。
2. 安装 Google Antigravity CLI，运行 `agy` 并在官方流程内登录。检查 `agy --help` 是否包含 `--json-schema`、`--settings` 和 `--conversation`。[Antigravity CLI 快速开始](https://antigravity.google/docs/getting-started?tab=cli) · [Headless 模式](https://antigravity.google/docs/cli/headless/)
3. 将 `CODEX_NATIVE_SOCKET` 指向刚确认的 socket，`AGY_BIN` 指向同一运行用户可执行的 `agy`。真实凭据由各 CLI 自己读取。Codex 的初始化和消息协议见 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。

桥接的 Unix Socket 具有开发委托权限，只授予可信的本机用户／服务。当前 Antigravity 集成在普通宿主用户下使用 plan 会话和非交互式命令权限，权限边界是该用户的操作系统访问范围。生产 Key、QQ 登录和贴吧 Profile 应留在各自服务的私有目录。WebUI 使用开发服务同步过来的脱敏记录。

## 启用开发桥接

前提是 [VPS 服务](vps-deployment.md)和 [OneBot](qq-onebot.md)已运行，并设置了可唯一确认的主人账号。完整 QQ 链路还需要安装固定开发服务及其部署单元。该安装器从现有 OneBot 私聊授权和主人配置核对身份。

<details>
<summary>首次安装开发服务</summary>

`scripts/development/install.py` 接受构建好的本机暂存目录。准备当前发布版本、生产基线和 Node 原生模块，再运行安装器。下面的命令在管理检出执行，要求 Linux、Python 3、C 编译器和安装所用 Node 的头文件。

```bash
export PATH="/srv/deepseekfish/app/runtime/tools/node/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=384
npm run build
node --test --test-isolation=none --test-concurrency=1 dist/tests/*.test.js

umask 077
export FISH_DEV_STAGE="$(mktemp -d /tmp/deepseekfish-dev.XXXXXX)"
python3 - <<'PY'
import hashlib
import json
import os
import runpy
import shutil
from pathlib import Path

app = Path("/srv/deepseekfish/app")
stage = Path(os.environ["FISH_DEV_STAGE"])
installer = runpy.run_path("scripts/development/install.py")
shutil.copytree("dist/src", stage / "dist/src")
for name in installer["names"]:
    if not name.startswith("dist/"):
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(name, target)
for name in ("install.py", "deploy.py", "trial.mjs"):
    shutil.copy2(Path("scripts/development") / name, stage / name)
shutil.copy2("package.json", stage / "package.json")
(stage / "deploy").mkdir()
for unit in installer["units"]:
    shutil.copy2(Path("deploy") / unit, stage / "deploy" / unit)
baseline = {
    name: hashlib.sha256((app / name).read_bytes()).hexdigest() if (app / name).is_file() else None
    for name in installer["names"]
}
(stage / "baseline.json").write_text(json.dumps(baseline))
PY
cc -shared -fPIC -I/srv/deepseekfish/app/runtime/tools/node/include/node \
  scripts/development/private-process.c -o "$FISH_DEV_STAGE/private-process.node"
sudo python3 "$FISH_DEV_STAGE/install.py"
```

安装器只接受首次安装，在启动前备份将被替换的文件。已有开发服务的部署进下面的启用步骤，升级时使用现有发布流程。

</details>

1. 构建并验证管理检出，将同版本代码和产物按自己的 [VPS 更新流程](vps-deployment.md)发布到应用目录。桥接单元运行该安装的 `dist/src/development/agy-bridge-server.js`。把 [`deepseekfish-agy-bridge.service`](../deploy/deepseekfish-agy-bridge.service) 和 [`deepseekfish-agy-bridge.socket`](../deploy/deepseekfish-agy-bridge.socket) 安装到本机的 systemd 单元目录。桥接工作目录应为管理检出，可写给运行桥接的普通用户。
2. 核对 socket 属主为桥接用户，属组为 `deepseekfish-development`，权限为 `0660`。然后启动监听并只读确认传输。

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now deepseekfish-agy-bridge.socket
   curl --fail-with-body --unix-socket /run/deepseekfish-agy-bridge.sock http://localhost/v1/status
   ```

3. 执行 `sudo systemctl edit deepseekfish-development.service`，在 drop-in 配置后端与 socket。

   ```ini
   [Service]
   Environment=FISH_DEV_BACKEND=agy
   Environment=FISH_AGY_BRIDGE_SOCKET=/run/deepseekfish-agy-bridge.sock
   ```

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart deepseekfish-development.service
   systemctl is-active deepseekfish-agy-bridge.socket deepseekfish-development.service
   ```

4. 在主人授权的 QQ 私聊里问一条源码问题，然后在 WebUI「Neon / Codex」核对分诊。纯问答应为 `reply_only`，没有 Codex 改码或上线。验证改码流程时，用一次明确授权的小改动，从同一面板核对独立构建、测试、Neon 审阅与最终安装版本。

## 常用配置与排错

| 配置 | 作用 |
| --- | --- |
| `AGY_APP_ROOT`、`AGY_STATE_DIR` | 已安装应用目录与私有桥接状态。管理检出由桥接的工作目录确定 |
| `AGY_MODEL`、`AGY_EFFORT` | 可选的 Antigravity 模型和推理级别 |
| `CODEX_NATIVE_MODEL`、`CODEX_NATIVE_EFFORT` | 可选的 Codex 模型和推理级别。留空使用 daemon 默认 |
| `AGY_STAGE_TIMEOUT_MS` | 分诊／审阅的阶段超时，默认 600000 毫秒 |
| `CODEX_TURN_TIMEOUT_MS`、`AGY_MAX_CODEX_RETRIES` | 默认均为 `0`，表示不设本地 Codex 时长或返工次数上限 |
| `AGY_SITE_DIR` | 可选的独立网站检出。网站任务仅交付受允许的 `public/` 文件，GitHub 推送与 Cloudflare 发布各有回执 |

- **连接失败**：检查 socket 是否存在、运行用户与属组是否匹配，再核对两个 CLI 的登录状态。服务端错误和超时见 WebUI 的桥接活动。
- **追问与急停**：普通委托复用一个 Neon 会话和一个 Codex 线程。Codex 进行中收到的追问可加入当前 turn，其余追问由开发服务保留。WebUI 可打断当前任务，或重置后续使用的主会话。
- **回执**：桥接的 `approved` 代表候选通过审阅，主仓库上线以开发服务的部署、服务健康与版本回执为准。候选只包含本轮白名单变更。
- **切回 Codex 直连**：对新任务使用 `FISH_DEV_BACKEND=codex`。需要直连已有 daemon 时，按 [直连模式](development.md)配置 `FISH_CODEX_NATIVE_SOCKET` 和 `FISH_CODEX_NATIVE_CWD`。

管理 API、请求样例和错误语义见 [接口参考](api.md)。
