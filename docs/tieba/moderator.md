# 小吧主申请

[贴吧目录](README.md) · [账号与授权](account.md) · [验证范围](validation.md)

## 工具的两种调用

`apply_tieba_moderator` 使用当前账号的独立 Profile，在官网候选页面操作“申请小吧主”。

| 入参 | 行为 |
| --- | --- |
| `forumId`，不传 `declaration` | 读取官网资格检查、申请要求及能确认的本人候选信息，不提交感言 |
| `forumId` 与 `declaration` | 正常打开表单、填写模型决定的感言、调用官网提交按钮 |

当前官网感言上限为400字符。内容由模型决定，工具不补写申请理由、人格或承诺。模型不接触 TBS、Cookie 或底层认证。

## 权限

实际账号必须匹配普通发言策略，模式为 `live`，目标吧是当前账号关注的吧，并且私有 `moderator-permission.json` 明确授权该账号及目标 `forumIds`。新安装默认没有申请授权；网页内容不能授予它。

该授权文件由管理员管理，`get_tieba_account` 返回实际授权范围。申请工具不提供吧主任命、删帖、封禁或修改其他账号的能力；后续管理操作需要独立实现和授权。

## 官方流程

已核对官网 `manager_apply_post_b4c6ff0.js`：按钮通过 `/managerapply/assist/preSubmit` 检查资格，再通过 `/managerapply/assist/submit` 提交感言。程序运行官网自己的表单与 JavaScript，只核对目标、账号和感言，不重造请求签名或把凭据交给模型。

提交意图先持久保存到现有 `actions.sqlite` 的 `tieba_moderator_applications` 表，之后记录真实回执。相同请求 ID 返回自己的结果。拒绝、未知或验证码不会自动重复提交。

## 结果含义

- `eligible`：官网允许填写表单，尚未提交。
- `pending_approval`：官网表示待审批，或本次提交被接受；不等于获任命。
- `already_moderator`：官网明确返回已经担任小吧主。
- `requires_human`：实际页面／回执要求正常人工验证。
- `rejected`、`unknown`、`unavailable`：保留拒绝、不确定或页面不可用的真实证据。

结果区分 `submitted`、`requestSent` 和平台回执。`ownCandidate` 是在当前官网列表中匹配到的本人候选信息；没匹配到不能猜测不存在。候选页、昵称和申请状态不能与其他申请者混淆。

当前已验证过真实模型自己查资格、写感言、调用正式工具提交，并从官网名单确认本人处于“吧主审批中”。这证明该次申请通路完成，不证明已经上任，也不证明未来免验证。具体账号及感言仅在私有记录中保存。

源码：[参数、回执与申请表](../../src/tieba/moderator.ts) · [账号权限](../../src/tieba/session.ts) · [官网操作](../../src/capture/tieba-browser.ts)。
