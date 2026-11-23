# 情绪颜文字库

[`emotions.json`](emotions.json) 是可直接导入的 UTF-8 JSON。从 62,149 条原始记录中提取了 3,489 个颜文字，共 14 类。顶层键是英文分类 ID，每类有中文 `label` 和字符串数组 `entries`。例如 `data.happy.entries` 是开心类的颜文字数组。

| 分类 ID | 情绪 | 条数 | 示例 |
|---|---|---:|---|
| `happy` | 开心／大笑 | 1,070 | `(≧◡≦)` |
| `excited` | 兴奋 | 104 | `＼(^o^)／` |
| `affection` | 喜欢／爱意 | 327 | `( ˘͈ ᵕ ˘͈♡)` |
| `proud` | 得意 | 38 | `(¬‿¬)` |
| `shy` | 害羞 | 102 | `(/ω＼)` |
| `embarrassed` | 尴尬 | 40 | `(⁄ ⁄•⁄ω⁄•⁄ ⁄)` |
| `surprised` | 惊讶 | 322 | `Σ(゜゜)` |
| `confused` | 困惑 | 143 | `(◎_◎;)` |
| `worried` | 担心 | 85 | `(~_~;)` |
| `fear` | 害怕 | 96 | `(ФДФ)` |
| `sad` | 难过／委屈 | 618 | `(╥﹏╥)` |
| `angry` | 生气 | 330 | `(҂⌣̀_⌣́)` |
| `annoyed` | 烦躁 | 204 | `(乛-乛)` |
| `disgusted` | 嫌弃 | 10 | `ಠ_ಠ` |

提取规则优先匹配原始情绪标签和含义明确的表情描述。用上游的 `new_tags` 辅助判断多义表情，爱心、脸红、出汗和点赞等视觉线索单独出现时不作为情绪依据。过滤问候语和多行字符画，对抽查中发现的少量误分类做了修正。每条只保留一个主情绪，按首尾去空白及 Unicode NFC 去重，保留内部空格和字符形式。自动分类依赖上游标签，未命中规则的颜文字会被跳过。

每条至少要有 3 个可见基础字符。空格、组合附加符和不可见格式符不计入长度，因此 `:)`、`:(`、`XD` 及其带空格的变体会被过滤，`ಠ_ಠ` 和 `╥﹏╥` 等三字符颜文字可以保留。

长度上限是 `(ﾉ °益°)ﾉ 彡 ┻━┻` 的 14 个字符加 2。去掉首尾空白后，按 Unicode 码点计数，内部空格和组合附加符也计入上限。超过 16 个码点的条目整条剔除。

带实际拉丁字母单词、感叹词或文字说明的条目会整条剔除，例如包含 `wow`、`Excited` 和倒写 `ʞooqǝɔɐℲ` 的条目。筛查覆盖常见花体、全角、圈字、上标和倒写字母。`OwO`、`ToT` 这类用字母画五官的颜文字保留。

原始数据来自 [ekohrt/emoticon_kaomoji_dataset](https://github.com/ekohrt/emoticon_kaomoji_dataset)，此次使用的 JSON 的 Git blob 为 `19326dfe51a9079ed5c80e8dc9437dc300a731a4`。原始文件保存在仓库的 `runtime/ekohrt-emoticon_dict.json`，该目录已经由 Git 忽略。上游仓库未标注明确的数据许可。

在仓库根目录运行以下命令可生成分类库。原始文件已存在时直接运行最后一行即可。

```bash
mkdir -p runtime
curl -fL https://raw.githubusercontent.com/ekohrt/emoticon_kaomoji_dataset/main/emoticon_dict.json \
  -o runtime/ekohrt-emoticon_dict.json
python3 assets/kaomoji/extract.py runtime/ekohrt-emoticon_dict.json
```
