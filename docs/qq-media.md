# QQ 图片理解与表情收藏

直接发送图片即可。PNG、JPEG、WebP 静图会以真实图片输入 DeepSeek；GIF 和动态 WebP 会按顺序抽取最多四帧，附上帧号和时间。模型知道这是抽帧观察，不会把第一帧当成完整动画。图片扩展名和 QQ 的“动画表情”标记都不是实际格式的依据。

模型可自主调用 remember_images 记录图片内容、图中文字、可见动作以及适合的情绪/场景。分类过程不强制播报给对方。判定为反应图、梗图或表情包时，自动把原文件纳入收藏；普通照片和截图仍可理解，但不会仅凭 QQ 标记自动成为表情。收藏原图和理解用的预览分开存放，动图发送使用原动画字节，不会变成静态截图。

收藏摘要出现在当前聊天的 memes 上下文中。find_memes 可以按情绪、含义查找；send_meme 由模型按聊天语境自行选择，也允许只发表情，不强制跟一段说明。每轮至多发送一张收藏图，发送失败不会盲目重复。没有后台定时乱发；普通群消息仍遵循现有回应触发和账本。发送收藏表情不会扣生图次数。

可以直接聊天，也可以说“来个惊讶的表情”“刚才那张动图是什么意思”。当前聊天收到的图片描述进入每日档案，自动回忆沿用今天和昨天；收藏表情作为用户授权的可复用素材持续保留。同一聊天中的重复图片按内容去重，跨聊天不会混用私人素材。

## 作为生图参考

recentImages、find_memes 和 list_images(source=received) 的 media- ID 可以直接用于 generate_image.referenceIds；肥鱼可以同时选中表情原图和 character，把表情构图与自己的角色设定一起交给 GPT。由模型决定是否看原图、选哪些图以及何时生成，不要求用户说固定关键词。

## 保存与迁移

- 原图和抽帧预览：runtime/memory/media/，权限沿用私有 memory 目录。
- 分类、标签、消息关联和发送时间：fish.sqlite 的 qq_media / qq_media_messages。
- 图片下载 URL、临时鉴权参数只在传输过程中使用，不写入模型上下文、聊天档案或调用日志。
- 原有 migrate-state.py 已覆盖 memory 和数据库，不需要另外导出；Git 只保存代码、锁文件和文档，不保存私人图片。

收图只接受 QQ 图片 CDN 的 HTTP/HTTPS 地址，统一通过 HTTPS 读取，禁止跳转及任意文件路径；缺失/过期地址通过同一 Native QQ 的 get_image 查询刷新。单文件最多 10 MiB、16M 像素、500 动画帧；每个合并回合处理最多四张图、模型最多看八张抽帧预览，超过部分明确记录未读取。原图库达到 512 MiB 会返回空间不足，不自动删除既有收藏。

解码使用项目依赖 sharp 0.35.5，单工作线程、有限缓存和解码超时；拒绝 SVG 等非位图输入。服务仅新增 root 所有的 node_modules/@img 原生库加载路径，继续禁止执行 runtime 中的文件，保持 Codex、SSH 与登录目录隔离。新安装沿用 scripts/install.sh；依赖及 ARM64 原生库随现有部署包一起迁移，没有安装测试框架。

实现依据：[NapCat 图片消息段](https://napneko.github.io/onebot/segment#_1-图片消息-image)、[sharp 分页/动画输入](https://sharp.pixelplumbing.com/api-constructor/)、[动画元数据](https://sharp.pixelplumbing.com/api-input/)。
