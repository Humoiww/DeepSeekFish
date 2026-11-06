# 原生 GIF 接收与当前生成验证

生成链路接受原生 `imageGeneration` 完成事件附带的 PNG 或 GIF。GIF 按实际字节保留，输出为 `image.gif`，图库、参考、QQ 发送和 WebUI MIME 同步识别。不会把单帧 PNG 改名为 GIF，也不拼序列图、合帧或调用额外的图像 API。

原先 Codex 请求被系统文字限定为 PNG，捕获、图库与发送也固定寻找 `image.png`。现在移除格式锁定，文件仍须来自原生工具回执、隔离工作目录或 harness generated_images，保留原有文件完整性与会话范围校验。GIF 解析限制编码长度、画布、帧数与累计像素，拒绝坏块、截断文件、链接和越界路径。上传复用原字节；动态图不会经过静态 JPEG 压缩。送达未知仍查询历史确认，不盲目重发。

`generate_image` 回执向模型提供实际 `format/animated/frames`；这是原件状态，不能把“请求了 GIF”当成“返回了 GIF”。没有增加人格台词、关键词路由或新的模型调用流程。

## 2026-11-06 原生调用实测

历史请求实际设计为 3×2 六帧 PNG 序列图，原生成与 QQ 发送均成功；它从未返回原生 GIF。

本次在原服务账号、现有隔离和登录环境下进行了检查：

1. 请求原生 GIF，允许不支持时直接报告。Codex 未调用生图工具便返回不可用，`nativeImageCompletions=0`。这不算真实 GIF 生图调用，也不足以证明提供商不支持 GIF。
2. 随后明确要求真实调用一次内置生图工具，将原生 GIF、6 帧、200ms 和循环要求写入工具 prompt，保留返回原件。`nativeImageCompletions=1`，但实际返回 `image.png`，1431769 字节，`animated=false, frames=1`。没有转换或拼帧，也没有 QQ 发布。

结论：**本项目当前 Codex 通路未成功产出原生 GIF，不能宣称已接通 image-2.6 GIF 生成。** 安装版本 0.164.0 的导出协议未发现可直接指定图像模型、output_format 或 frame_count 的入口；仍需上游 Codex 原生工具暴露格式能力，或者另行授权有对应访问权限的正式 Image API。没有新增 API key、付费 API 路由或自动重试。

官方 Image API 确认 GPT Image 2.6 的 GIF 输出可使用 `output_format=gif`，配合 frame_count、frame_duration_ms，返回已完成的 GIF 字节。这是 API 能力，不足以证明当前 Codex 账号/工具已暴露同一选项：[OpenAI 官方图像生成文档](https://developers.openai.com/api/docs/guides/image-generation#generate-animated-gif-output)。

## 测试

`tests/native-gif.test.ts` 使用明确标注的合成测试样本，验证原生附件文件和 inline base64 两条路径、帧延时、输出发布、会话图库/参考、原字节发送，以及送达不确定时的去重。样本不是实际模型 GIF，不冒充原生生成成功。

完整回归和网络/生成实测须分别记录：离线测试通过只说明 GIF 接收发送链路通过，不能推导 GIF 生图接口已通。
