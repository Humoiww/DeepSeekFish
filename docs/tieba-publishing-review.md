# 贴吧发布通路调查与技术选择

本说明公开接口研究和工程结论，不包含项目账号身份、生产发言内容、部署地址或私有运行记录。

## 通路比较

| 路线 | 已核实范围 | 结论 |
| --- | --- | --- |
| 官方 Claw API | TB_TOKEN 认证；文档列出抓虾和虾评社区，未承诺任意普通贴吧写入 | 不将 Agent 社区支持视为普通贴吧授权，不接入目标范围未经确认的 Provider |
| App Protobuf | 开源项目提供普通回复和楼中楼编码，但相关维护者报告风险 | 保留已移植协议和归属，不宣称长期稳定，不作为网页失败后的自动备用 |
| 手工网页表单 | 有实现，但部分项目明确未验证真实登录发表 | 不把代码存在或未登录响应正确当作已可用 |
| 官方网页原生交互 | 可以复用独立 Profile、正常编辑控件和网站自己的请求及验证流程 | 已有网页授权账号的回复沿用现有私有 CDP；维护目标绑定与回执，不新建 Agent 框架 |
| 历史开放平台／合作 SDK | 未找到覆盖当前普通社区的通用、可申请写授权证据 | 不将历史接口或第三方 SDK 名称当作当前发布许可 |

“官方网页”表示由官网 JavaScript 发起操作，不表示百度向本项目授予通用自动化 API 权限，也不能保证免验证码或审核。

## 官方文档

- [Tieba Claw Skill](https://tieba.baidu.com/skill.md)
- [API 参考](https://tieba.baidu.com/skill/api-reference.md)

认证使用 Authorization 中的 TB_TOKEN；addThread 参数没有任意 forumId；帖子列表文档列明抓虾及虾评。addPost 接受帖子或回复 ID，但没有普通社区跨吧写入承诺。官方文档的社区行为、人设或心跳建议不导入本项目的人格或探索逻辑。

## 核实过的开源实现

- [dsh-tieba-dive](https://github.com/Nekomeow114/dsh-tieba-dive)，固定提交 `06e1657eb5262d3d2337466debf0a7ca1c165fbf`：实际阅读 lib/tieba.js 和 CHANGELOG，核对 encodeAddFloor、replyFloor、encodeAddPost、replySub、parseAddPostResponse。主楼为 multipart Protobuf；楼中楼另外编码父子关系。上游的失败自动切网页行为不直接复制。
- [aiotieba](https://github.com/lumina37/aiotieba)：核对代码、releases、[Issue 338](https://github.com/lumina37/aiotieba/issues/338) 和 [351](https://github.com/lumina37/aiotieba/issues/351)。v4.7.0 弃用 add_post，v4.8.0 因风险过高移除；不能据早期成功样本承诺长期不封。
- [dsh-ai-debate](https://github.com/alicia1030su/dsh-ai-debate)，固定提交 `47319fddfd8626bb78b23886c2e2f2e284b85446`：实际阅读 adapter、provider 和 publisher。其表单发布路径明确注明真实登录发表未经验证，不能把它当作已证明更可靠的替代方案。
- [TiebaMecha](https://github.com/hwdemtv/TiebaMecha)，固定树 `b9b08af645a98e435e4be92536d742dce0a661c0`：实际阅读 web_poster 和 post。WebPoster 拼接表单，不等于运行完整官方浏览器；未采用其代理、设备或行为伪装建议。
- [libsgh/tieba-api](https://github.com/libsgh/tieba-api)：项目自身警告登录实现陈旧及回帖风险，不能视为长期普通社区写入的保证。

这些项目提供了可核实的协议与维护反馈，但没有找到具备明确通用授权、可证明长期普通贴吧自动写稳定的替代 SDK。社区封禁报告属于报告者的观察，不足以归因本项目的具体请求。

## 工程改造

复用账号、公开读取、预算、原生工具和探索队列。模型只看到统一的 publish_tieba，不需要选择底层协议。网页回复依赖实际控件的父楼／子回复 ID，不能凭关键词决定路线或猜请求参数。

当前修复包括根层 pid/info 解析、具体参数反馈、原生工具配对、最近发言诊断，以及 WebUI 自动展示对应验证画面。删除了跨请求验证锁和旧拒绝拦截；真实错误只属于当次调用。人格与探索说明在每轮最新位置加载，知识库保持原位置，没有添加新的兴趣或内容模板。

## 可靠性判断

协议格式正确、平台接受、有有效 ID、公开可见和长期稳定是不同层次。遇到真正验证码时展示官方流程；不会将本地错误包装成平台拒绝。项目运行中的完整证据和账号数据只在私有活动记录中保留，不随版本推送。
