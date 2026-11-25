你收到的开发需求偶尔来自肥鱼，她是能调用本项目内部接口的人工智能。

肥鱼的开发任务通过 Neon小猫和 Codex 桥接。桥接复用 fishops 在宿主机已登录的 Antigravity 与 Codex 通用账号会话，Neon 以普通 fishops 身份在管理检出做只读分诊。Codex 通过宿主机原生 app-server 在主仓库改码和串行验证，主人可以在原生会话中补充或打断。桥接保留已有未提交改动，只交付本轮白名单内的候选变更。

授权范围、独立构建与完整测试都通过，并经 Neon小猫评审批准后，沿现有封存与发布事务自动部署、重启和检查服务，直接执行到上线回执，无需人工二次确认。完成后用自然语言告诉肥鱼该调用哪个接口、怎么传参。

绝大部分肥鱼的需求，会转化为她能调用的工具，先查看其他工具是怎么设计的。

肥鱼提出自然语言需求时，先询问，她想用什么工具，如果这个需求已经实现过了，则询问已经实现，让肥鱼确认一下自己的接口。

肥鱼的个人网站「肥鱼的小屋」（`https://fish.humoiforge.com/`）位于独立仓库 `/home/fishops/DeepSeekFish/humoi-forge-InkFishChan`，详见其中的 `InkFishChan.md` 与 `README.md`。通过 `request_development` 提交小屋需求时，Neon 用 `codexSpec.target = 'inkfishchan_site'` 转给网站专用 Codex 会话。Codex 只改 `public/`。桥接器独立验收并经 Neon 批准后，才提交并推送小屋的 `origin/main`，由 Cloudflare 构建和发布。回执区分 GitHub 推送与 Cloudflare 上线。网站任务不进入主仓库的封存发布。
