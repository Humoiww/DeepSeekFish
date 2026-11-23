"""Extract a single primary emotion per expression from emoticon_dict.json."""

import argparse
import json
import re
import unicodedata
from pathlib import Path


# Put more specific emotions first so that, for example, a shy smile can be
# classified as shyness when both labels have the same amount of evidence.
EMOTIONS = {
    "shy": ("害羞", "shy|shyness|bashful|timid"),
    "embarrassed": ("尴尬", "awkward|embarrassed|embarrassment|ashamed|shame"),
    "fear": ("害怕", "afraid|scared|fear|fearful|terrified|frightened|panicking|panic"),
    "worried": ("担心", "worried|worry|anxious|anxiety|uneasy|nervous|troubled"),
    "surprised": ("惊讶", "surprised|surprise|shocked|shock|startled|amazed|astonished"),
    "confused": ("困惑", "confused|confusion|puzzled|perplexed|in doubt|bewildered"),
    "disgusted": ("嫌弃", "disgust|disgusted|grossed out|repulsed|disapproval"),
    "angry": ("生气", "angry|anger|mad|furious|enraged|rage|outraged|i hate you"),
    "annoyed": ("烦躁", "annoyed|annoyance|irked|irritated|frustrated|bad mood|fed up"),
    "sad": (
        "难过／委屈",
        "sad|sadness|sorrow|depressed|upset|disappointed|disappointment|heartbroken|"
        "lonely|despair|feeling down|bummed out|i am not fine",
    ),
    "proud": ("得意", "proud|pride|smug|smugness|triumphant|gloating|satisfied|proud of you"),
    "affection": (
        "喜欢／爱意",
        "love|in love|infatuated|giving love|sending love|spread the love|"
        "i love you|i like you|i really like you|i feel loved|love at first sight",
    ),
    "excited": ("兴奋", "excited|excitement|thrilled|ecstatic|pumped up"),
    "happy": (
        "开心／大笑",
        "happy|happiness|joy|joyful|cheerful|glad|pleased|laugh|laughing|laughter|"
        "full of joy|happy crying|tears of happiness|tears of joy",
    ),
}

# These describe an expression or gesture and only corroborate an emotion
# already present in the source labels. In particular, blush can be romantic,
# sweat can be physical, and crying can be joyful.
VISUAL_TAGS = {
    "shy": {"blush"},
    "embarrassed": {"sweat", "blush"},
    "worried": {"sweat"},
    "surprised": {"surprised"},
    "angry": {"anger"},
    "annoyed": {"annoyed"},
    "sad": {"sad", "crying"},
    "proud": {"smirk"},
    "affection": {"heart", "kiss"},
    "excited": {"excited"},
    "happy": {"smiling"},
}

EXPRESSION_TAGS = {
    "happy": {"smile", "smiling", "big grin"},
    "sad": {"cry", "crying", "weeping", "sobbing"},
}

# Corrections from inspecting the extracted expressions in context.
REVIEWED = {
    "(¬‿¬)": "proud",
    "(*´∀｀）": "happy",
    "（*＾＾*)": "happy",
    "(>w<)": "happy",
    "ಠ_ಠ": "disgusted",
    "ಠ╭╮ಥ": "sad",
    "(✿≧³≦)≧U≦✿)": "affection",
    "ಠ◡ಠ": None,
    "ʕ•ᴥ•ʔ": None,
    "(⊃‿⊂)": None,
    "( ´﹃｀)": None,
    "(• ε •)": None,
    "(-.-)": None,
    "ξ＼(ﾟｰﾟ*)(*ﾟ▽ﾟ)ﾉ⌒ξﾟДﾟ)ﾉﾉ": None,
}

JOYFUL_TEARS = {"happy crying", "tears of happiness", "tears of joy"}
GREETING_TAGS = {"hello_message", "goodbye_message", "morning_night_evening_message"}
MAX_FACE_LENGTH = len("(ﾉ °益°)ﾉ 彡 ┻━┻") + 2
NUMBERED_TAG = re.compile(r"\s*#\d+$")
LATIN_RUN = re.compile(r"[a-z]{2,}")
SHAPED_LATIN_LETTER = re.compile(
    r"(?:LATIN (?:SMALL |CAPITAL )?LETTER (?:TURNED |SMALL CAPITAL )|TURNED CAPITAL )([A-Z])"
)
# These letters are used as lookalikes in strings such as inverted Facebook
# and mixed-script love. Other letter shapes are handled by their Unicode name.
LETTER_LOOKALIKES = str.maketrans({
    "ɔ": "c", "ɟ": "f", "ƃ": "g", "ɾ": "j", "ɦ": "h", "ѵ": "v", "γ": "y",
})
SHORT_WORDS = set(
    "ah am an as at be by do eh ew go ha he hi ho if in is it me my "
    "no of oh ok on or ow so to uh um up us we yo".split()
)
LETTER_FACES = set("lll ooo oto ouo owo sto otl otz orz tnt tot uvu uwu".split())
# In these phrases even the letters are drawn with symbols or lookalikes.
DECORATED_WORDS = ("ℒ♡ⓥℯ", "∟ＯⅤ∈ Υ〇∪", "尺口卂尺", "Ｆцскуоц")
EMOTION_PATTERNS = {
    emotion: re.compile(
        rf"(?:(?:a|an|i am|i'm|feeling|so|very|really|extremely|pretty|super) )*"
        rf"({aliases})"
        r"(?: (?:face|smile|crying|expression|eyes|girl|boy|guy|dude|woman|man|"
        r"kid|bear|cat|dog|puppy|bunny))?"
    )
    for emotion, (_, aliases) in EMOTIONS.items()
}


def normalize_tag(tag):
    tag = " ".join(tag.casefold().replace("’", "'").split())
    return NUMBERED_TAG.sub("", tag).strip(" !?.")


def primary_emotion(original_tags, new_tags):
    original = {normalize_tag(tag) for tag in original_tags}
    visual = {normalize_tag(tag) for tag in new_tags}
    if visual & GREETING_TAGS:
        return None
    if original & JOYFUL_TEARS:
        return "happy"

    scores = {}
    for emotion, pattern in EMOTION_PATTERNS.items():
        if emotion == "proud" and "thumbs_up" in visual:
            continue
        direct = sum(bool(pattern.fullmatch(tag)) for tag in original)
        expressions = len(original & EXPRESSION_TAGS.get(emotion, set()))
        if direct or expressions:
            supported = len(visual & VISUAL_TAGS.get(emotion, set()))
            scores[emotion] = (bool(direct), supported, direct, expressions)

    return max(scores, key=scores.get) if scores else None


def usable_text(face):
    if len(face) > MAX_FACE_LENGTH:
        return False
    # Preserve symbols and combining marks verbatim, including internal spaces.
    visible = 0
    combining = 0
    for char in face:
        kind = unicodedata.category(char)
        if kind in {"Cc", "Zl", "Zp"}:
            return False
        combining = combining + 1 if kind.startswith("M") else 0
        if combining > 5:
            return False
        if kind[0] not in "CMZ":
            visible += 1
    return visible >= 3


def contains_word(face):
    # The vertical strokes in this expression depict sweat.
    if face == "ヽ(illﾟдﾟ)ﾉ":
        return False
    if any(word in face for word in DECORATED_WORDS):
        return True

    letters = []
    for char in unicodedata.normalize("NFKD", face).translate(LETTER_LOOKALIKES):
        kind = unicodedata.category(char)
        if kind.startswith("M") or kind == "Cf":
            continue
        shape = SHAPED_LATIN_LETTER.fullmatch(unicodedata.name(char, ""))
        letters.append(shape[1] if shape else char)
    plain = "".join(letters).casefold()

    for match in LATIN_RUN.finditer(plain):
        token = match[0]
        if token in LETTER_FACES:
            continue
        if len(token) >= 3:
            return True
        if token in SHORT_WORDS:
            start, end = match.span()
            left_is_letter = start > 0 and plain[start - 1].isalpha()
            right_is_letter = end < len(plain) and plain[end].isalpha()
            if not left_is_letter and not right_is_letter:
                return True
    return False


def extract(rows):
    categories = {
        emotion: {"label": label, "entries": []}
        for emotion, (label, _) in EMOTIONS.items()
    }
    seen = set()
    for raw_face, tags in rows.items():
        face = raw_face.strip()
        key = unicodedata.normalize("NFC", face)
        if key in seen or not usable_text(face):
            continue
        if face in REVIEWED:
            emotion = REVIEWED[face]
        else:
            emotion = primary_emotion(tags["original_tags"], tags["new_tags"])
        if emotion is not None and not contains_word(face):
            seen.add(key)
            categories[emotion]["entries"].append(face)
    return categories


def main():
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=here / "emotions.json")
    args = parser.parse_args()

    with args.source.open(encoding="utf-8") as source:
        rows = json.load(source)
    categories = extract(rows)
    output = json.dumps(categories, ensure_ascii=False, indent=2)
    args.output.write_text(output + "\n", encoding="utf-8")
    counts = ", ".join(f"{name}={len(group['entries'])}" for name, group in categories.items())
    total = sum(len(group["entries"]) for group in categories.values())
    print(f"{len(rows)} source expressions, {total} retained: {counts}")


if __name__ == "__main__":
    main()
