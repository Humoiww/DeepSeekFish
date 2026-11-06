# Codex 原生 GIF：调用入口与实测状态

DeepSeekFish 只使用现有 Codex 登录和生图额度。原生 GIF 入口已接到同一个 `generate_image`：模型可自行提供可选的 `gif` 对象；不增加独立意图路由、人格台词或第二种生图 API。收件、图库、参考、QQ 发送和 WebUI 按原始文件格式识别 GIF，不改名冒充，也不拼帧替代。

## 官方入口

官方源码明确提供 `image_generation_animation`，状态为 UnderDevelopment，默认关闭。开启后 `image_gen.imagegen` 才向模型公开 `gif`：

```toml
[features]
image_generation = true
image_generation_animation = true
```

```json
{
  "prompt": "鲸酱眨眼挥手，尾巴轻摆，自然循环",
  "gif": { "frame_count": 6, "frame_duration_ms": 200 },
  "referenced_image_paths": ["本次已经选择并附上的参考图"]
}
```

`gif:{}` 采用提供方默认值（9 帧、200ms）。帧数 2–16、时长 20–2000ms；输入经工具 schema 与 broker 校验。图片内容、参考图和是否请求动画均由模型决定。

截至本次核对，正式版 0.167.0 没有该开关；官方 0.168.0-alpha.7 包已包含。因此项目依赖固定到这一个预览版本，图像回合启用动画能力，普通 Codex 工程回合关闭图像及动画工具；现有隔离和审批保持原机制。

官方 Codex 当前实现仍使用模型名 `gpt-image-2`，不是一个可由客户端设置为 `gpt-image-2.6` 的选项。不能把文字中要求 Image 2.6 当成实际已切换模型。工具把 `gif` 转为原生请求的 `output_format=gif` 和帧参数，返回完成的 GIF 字节。

依据：[官方 GIF 使用说明](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/imagegen_gif_description.md)、[功能开关](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs)、[实际调用实现](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs)、[官方原生 GIF 测试](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/imagegen_extension.rs)。[公开生图页面](https://learn.chatgpt.com/docs/image-generation)仍标注内置使用 gpt-image-2，未说明预览 GIF 的账号开放范围。

## 2026-11-06 实测

历史请求实际设计成 3×2 六帧 PNG，已经生成并发到 QQ；没有原生 GIF。本次使用同一 Codex 登录、本人 PNG 参考图和隔离环境验证：

1. 正式版 0.167.0：确实调用一次生图，返回单帧 PNG，2110436 字节，`animated=false`。这不算 GIF 成功。
2. 官方预览版 0.168.0-alpha.7：沙箱探针通过，记录的线程开关 `image_generation_animation=true`；工具真实使用 `gif:{frame_count:6,frame_duration_ms:200}`。请求已到上游，原始错误是 **HTTP 400，`GIF output is not enabled for this request.`**，没有 GIF 文件。

第二条已越过客户端“GIF output is unavailable in this session”检查，是上游拒绝本次 GIF 请求。官方客户端未提供另一个已确认可用的设置来让服务端开放 GIF；不能据此推断全部账号都不可用，也不能保证更换提示词就能解决。

**目前未成功产出原生 GIF，不宣称整个生成交付任务完成。** 没有用转换/拼帧补图，没有启用正式 Image API，没有新增 API key；用户明确选择继续只使用 Codex 登录。后续仅在上游支持本次请求后才可能完成真实 GIF 生成和 QQ 交付。

## 文件与结果

原生附件只接受已完成 `imageGeneration` 的原文件，或隔离工作目录/harness generated_images 中经验证的文件。保留字节、帧延时和来源；动态图不会走静态 JPEG 压缩。GIF 编码长度、画布、帧数与累计像素均有界，拒绝坏块、截断、链接和越界路径。

`generate_image` 提供实际 `format/animated/frames`。明确请求 GIF 但返回静图时为 `CODEX_NATIVE_GIF_NOT_RETURNED`，保留原件供检查，不自动重画。原生上游未开放错误识别为 `CODEX_NATIVE_GIF_NOT_ENABLED`，原始 HTTP 错误仍保留在私有 Codex 活动记录。送达未知仍核对历史回执，不重复上传。

离线测试验证原生附件、inline base64、参数从 QQ broker 到 runner 的传递、额度/同消息去重、格式不符不能冒充成功、图库和原字节发送。完整回归通过不能推导上游 GIF 已开放；真实失败与离线成功分别记录。
