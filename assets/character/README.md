# 鲸酱原始设定集

[whalechan-reference.png](whalechan-reference.png) 是维护者在项目开发中提供的鲸酱原始角色设定图，包含正面、侧面、背面及外观细节。按维护者要求随公开仓库分发，未重绘、缩放或重新编码。

默认自画像使用此图。需要本机自定义时，可把替代 PNG 放到 `runtime/character/whalechan-reference.png`；本机文件优先，并继续被 Git 忽略。


人设文本的来源及许可见 [prompts/README.md](../../prompts/README.md)；其文本许可不自动适用于这张用户提供的图片。

## 动态立绘拆件

[whalechan-parts.psd](whalechan-parts.psd) 是从 WebUI 正面立绘拆出的 32 层 RGB 文件。头饰、呆毛、前后发、鲸鳍耳、眼白、虹膜、睫毛、嘴、尾巴、裙摆和四肢可分别编辑。背发、眼白与关节下的补层取样自原图纹理，按当前动作范围延伸。加大动作幅度时需要复查遮挡处。

WebUI 首页通过 `portrait-motion.js` 和 `portrait-parts.webp` 播放分层动画。鼠标移到角色旁的画面时视线随之移动，点角色会挥手。首页的「播放立绘」按钮和 `/?portrait=play` 都能主动播放动画。系统开启「减少动态效果」时，普通首页默认显示静态立绘。PSD 是供继续编辑和绑定的源素材，Cubism 模型需要用 Cubism Editor 单独绑定、导出。
