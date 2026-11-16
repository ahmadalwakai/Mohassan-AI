"""Pinned human conversation trees plus local authored dialogue supervision.

Only official OASST TRAIN files are downloaded. Public validation/test data and
the project's final holdout are never opened. Grouping is by entire conversation
tree and normalized root wording. No answer or history is truncated to fit.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import re
import sys
import unicodedata
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/execution-pipeline"))
from execution_pipeline.pretrain import TextEncoder
from execution_pipeline.chat import conversation_prompt

SOURCES = [
    {"repository": "OpenAssistant/oasst1", "commit": "fdf72ae0827c1cda404aff25b6603abec9e3399b",
     "train_path": "data/train-00000-of-00001-b42a775f407cee45.parquet", "bytes": 39516251,
     "sha256": "bbfadf5ed1278ba2208c837fdcad865adf65f5df55d80abadab2745db13fcb5e"},
    {"repository": "OpenAssistant/oasst2", "commit": "179dd21fc55192153d94adb0e0ce8f69e222bf75",
     "train_path": "data/train-00000-of-00001-88ba0162028a73fc.parquet", "bytes": 63494018,
     "sha256": "9638227b41b0a4fb69afa5d5c4b52e3fb6abfd56c9870d81bae32c9981e769b1"},
]


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def key(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold().translate(str.maketrans("أإآى", "اااي"))
    return " ".join("".join(c for c in text if not unicodedata.combining(c) and c != "ـ").split())


def family(text: str) -> str:
    words = re.findall(r"[^\W\d_]+|\d+", key(text))
    return " ".join("#" if word.isdecimal() else word for word in words)


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def fetch(directory: Path) -> list[dict]:
    result = []
    for spec in SOURCES:
        dest = directory / spec["commit"]
        dest.mkdir(parents=True, exist_ok=True)
        files = []
        for remote, name, expected_size, expected_sha in (
                (spec["train_path"], "train.parquet", spec["bytes"], spec["sha256"]),
                ("README.md", "README.md", None, None)):
            target = dest / name
            url = f"https://huggingface.co/datasets/{spec['repository']}/resolve/{spec['commit']}/{remote}"
            if not target.exists():
                partial = target.with_suffix(target.suffix + ".part")
                with urllib.request.urlopen(url, timeout=90) as source, partial.open("xb") as out:
                    written = 0
                    while block := source.read(1024 * 1024):
                        written += len(block)
                        if written > 200_000_000:
                            raise RuntimeError("Unexpected source size exceeded the bounded download.")
                        out.write(block)
                partial.replace(target)
            if expected_size is not None and target.stat().st_size != expected_size:
                raise RuntimeError("Pinned source size mismatch.")
            actual = digest(target)
            if expected_sha is not None and actual != expected_sha:
                raise RuntimeError("Pinned source checksum mismatch.")
            files.append({"url": url, "path": str(target.relative_to(ROOT)), "bytes": target.stat().st_size, "sha256": actual})
        if not re.search(r"^license:\s*apache-2\.0\s*$", (dest / "README.md").read_text(encoding="utf-8"), re.MULTILINE):
            raise RuntimeError("Pinned card does not declare the expected license.")
        license_path = dest / "LICENSE.APACHE-2.0.txt"
        if not license_path.exists():
            with urllib.request.urlopen("https://www.apache.org/licenses/LICENSE-2.0.txt", timeout=30) as response:
                license_path.write_bytes(response.read())
        metadata = {**spec, "license": "Apache-2.0", "source_split": "train", "files": files,
                    "license_sha256": digest(license_path), "public_validation_or_test_downloaded": False,
                    "pretrained_weights_downloaded": False}
        (dest / "source-record-v3.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        result.append(metadata)
    return result


def read_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def labels(row: dict) -> dict[str, float]:
    value = row.get("labels")
    if isinstance(value, dict):
        return dict(zip(value.get("name", []), value.get("value", [])))
    if isinstance(value, list):
        return {item["name"]: item["value"] for item in value}
    return {}


def message_reason(row: dict, *, target: bool) -> str | None:
    if row.get("deleted") or row.get("review_result") is not True:
        return "deleted_or_not_review_approved"
    if row.get("synthetic") or row.get("model_name"):
        return "synthetic_or_model_authored_source"
    if row.get("lang") not in {"ar", "en"}:
        return "other_language"
    content = row.get("text")
    if not isinstance(content, str) or not content.strip() or len(content) > 8000 or "\ufffd" in content:
        return "empty_long_or_malformed_text"
    if any(ord(c) < 32 and c not in "\n\r\t" for c in content):
        return "control_character"
    scores = labels(row)
    for name in ("spam", "fails_task", "lang_mismatch", "pii", "not_appropriate", "hate_speech", "sexual_content"):
        if scores.get(name, 0.0) >= 0.25:
            return "moderation_label_" + name
    if scores.get("toxicity", 0.0) > 0.4:
        return "toxicity_label"
    if scores.get("quality", -1) < (0.6 if target else 0.4):
        return "low_or_missing_quality_review"
    if row.get("role") == "assistant" and re.search(
            r"\b(?:as an ai|as a language model|(?:i am|i'm|my name is)\s+(?:an?\s+)?(?:open\s*assistant|chatgpt))\b|بصفتي نموذج|أنا شات جي بي تي",
            content, re.I):
        return "foreign_model_identity"
    if row.get("role") == "assistant" and re.search(
            r"\bi (?:have |just )?(?:sent (?:you |the |an? )?(?:email|message)|opened (?:your |the )?(?:browser|file)|searched the web)\b|أرسلت (?:الرسالة|البريد)|فتحت المتصفح",
            content, re.I):
        return "unsupported_action_claim"
    if target:
        if row.get("rank") != 0:
            return "not_ranked_best_answer"
        if scores.get("helpfulness", 1.0) < 0.5:
            return "low_helpfulness"
        if content.strip().endswith(("...", "…", ":")) or content.count("```") % 2:
            return "apparently_incomplete_answer"
    return None


def build_oa(directory: Path, encoder: TextEncoder, reserved_families: set[str], reserved_answers: set[str]) -> tuple[list[dict], dict]:
    import pyarrow.parquet as pq
    messages = {}
    source_counts = {}
    duplicate_ids = 0
    for spec in SOURCES:  # Prefer the later OASST2 review for shared message IDs.
        data = pq.read_table(directory / spec["commit"] / "train.parquet").to_pylist()
        source_counts[spec["repository"]] = {"messages": len(data), "languages": dict(Counter(row["lang"] for row in data)),
                                                    "best_assistant_by_language": dict(Counter(row["lang"] for row in data if row["role"] == "assistant" and row["rank"] == 0))}
        for row in data:
            duplicate_ids += row["message_id"] in messages
            messages[row["message_id"]] = row
    drops, candidates = Counter(), []
    for row in messages.values():
        if row["role"] != "assistant" or row["lang"] not in {"ar", "en"}:
            continue
        reason = message_reason(row, target=True)
        if reason:
            drops[reason] += 1
            continue
        path, seen = [], {row["message_id"]}
        current = row
        bad = None
        while current.get("parent_id"):
            parent = messages.get(current["parent_id"])
            if parent is None or parent["message_id"] in seen:
                bad = "missing_parent_or_cycle"
                break
            seen.add(parent["message_id"])
            if parent["message_tree_id"] != row["message_tree_id"] or parent["lang"] != row["lang"]:
                bad = "mixed_tree_or_language"
                break
            bad = message_reason(parent, target=False)
            if bad:
                bad = "ancestor_" + bad
                break
            path.append(parent)
            current = parent
        if bad:
            drops[bad] += 1
            continue
        path.reverse()
        if not path or len(path) > 16 or path[0]["role"] != "prompter" or path[-1]["role"] != "prompter":
            drops["invalid_or_long_tree_path"] += 1
            continue
        if any(node["role"] != ("prompter" if i % 2 == 0 else "assistant") for i, node in enumerate(path)):
            drops["nonalternating_source_roles"] += 1
            continue
        if any(family(node["text"]) in reserved_families for node in path if node["role"] == "prompter") or key(row["text"]) in reserved_answers:
            drops["overlaps_previous_validation"] += 1
            continue
        history = [{"role": "user" if node["role"] == "prompter" else "assistant", "content": node["text"].strip()} for node in path]
        try:
            prompt = conversation_prompt(history)
        except ValueError:
            drops["runtime_message_contract"] += 1
            continue
        target = row["text"].strip()
        input_tokens, answer_tokens = len(encoder.encode(prompt)), len(encoder.encode(target)) + 1
        if answer_tokens > 192:
            drops["answer_over_192_tokens"] += 1
            continue
        if input_tokens + 192 > 1024:
            drops["history_over_runtime_context_reserve"] += 1
            continue
        root_family = family(path[0]["text"])
        candidates.append({"id": "oasst-" + row["message_id"], "language": row["lang"], "capability": "chat.reply.v1",
                           "source": "openassistant_human_train", "source_message_id": row["message_id"],
                           "source_tree_id": row["message_tree_id"], "group": "oasst-root-" + text_hash(root_family),
                           "messages": history, "prompt": prompt, "target": target,
                           "input_tokens": input_tokens, "answer_tokens": answer_tokens})
    # Group by both actual tree and normalized root family. A root text can have
    # several IDs; those branches receive one split without comparing targets.
    tree_group = {}
    for row in candidates:
        prior = tree_group.setdefault(row["source_tree_id"], row["group"])
        if prior != row["group"]:
            raise RuntimeError("One source tree unexpectedly has multiple root families.")
    unique = {}
    for row in sorted(candidates, key=lambda item: item["id"]):
        signature = key(row["prompt"])
        if signature in unique:
            drops["duplicate_conversation"] += 1
            continue
        unique[signature] = row
    rows = list(unique.values())
    return rows, {"source_counts": source_counts, "duplicate_message_ids_across_releases": duplicate_ids,
                  "union_messages": len(messages), "drops": dict(drops), "usable": dict(Counter(row["language"] for row in rows)),
                  "usable_multiturn": dict(Counter(row["language"] for row in rows if len(row["messages"]) > 1)),
                  "maximum_history_messages": max((len(row["messages"]) for row in rows), default=0)}


# Authored dialogues are inserted below. Each tuple is a complete original
# scenario in two languages, not combinatorial placeholder expansions.
AUTHORED = [
    (["Plan a morning with ten minutes of reading, five of tidying and five of rest.", "Read for ten minutes, tidy for five, then rest for five: twenty minutes in total.", "Move the rest to the beginning.", "Rest for five minutes, read for ten, then tidy for five.", "Give only the activity names in order.", "Rest, reading, tidying."],
     ["رتب صباحي: عشر دقائق للقراءة وخمس للترتيب وخمس للراحة.", "اقرأ عشر دقائق، ثم رتّب خمس دقائق، واسترح خمس دقائق. المجموع عشرون دقيقة.", "اجعل الراحة في البداية.", "استرح خمس دقائق، ثم اقرأ عشر دقائق، ورتّب خمس دقائق.", "اذكر أسماء الأنشطة بالترتيب فقط.", "الراحة، القراءة، الترتيب."]),
    (["My appointment is Tuesday at eleven. Help me remember that within this chat.", "The appointment you gave me is Tuesday at eleven.", "It changed to Thursday at two in the afternoon.", "The updated appointment is Thursday at two in the afternoon.", "Write a note for my calendar, without saying you saved it.", "Appointment: Thursday, 2 p.m."],
     ["موعدي الثلاثاء الساعة الحادية عشرة. تذكره داخل هذه المحادثة.", "الموعد الذي ذكرته هو الثلاثاء الساعة الحادية عشرة.", "تغير إلى الخميس الساعة الثانية بعد الظهر.", "الموعد الجديد الخميس الساعة الثانية بعد الظهر.", "اكتب ملاحظة للتقويم من دون الادعاء أنك حفظتها.", "الموعد: الخميس، الساعة الثانية بعد الظهر."]),
    (["I need to finish a poster on Monday and a report on Friday.", "Your poster is due Monday, and your report is due Friday.", "The poster is now due Wednesday; the report stays the same.", "The poster is due Wednesday. The report is still due Friday.", "Which task has the later deadline?", "The report, due Friday."],
     ["أحتاج إنهاء الملصق يوم الاثنين والتقرير يوم الجمعة.", "موعد الملصق الاثنين، وموعد التقرير الجمعة.", "صار موعد الملصق الأربعاء، والتقرير لم يتغير.", "موعد الملصق الأربعاء، والتقرير ما زال يوم الجمعة.", "أي المهمتين موعدها أبعد؟", "التقرير، وموعده الجمعة."]),
    (["My bag can hold three items. I need a notebook and a bottle; a jacket is optional.", "Pack the notebook and bottle. You can add the jacket as your third item.", "I must take my charger too.", "Pack the notebook, bottle and charger. Leave the optional jacket out to keep three items.", "What did we leave out?", "The jacket."],
     ["حقيبتي تتسع لثلاثة أشياء. أحتاج دفتراً وزجاجة ماء، والسترة اختيارية.", "ضع الدفتر وزجاجة الماء، ويمكنك إضافة السترة بوصفها الشيء الثالث.", "يجب أن آخذ الشاحن أيضاً.", "خذ الدفتر وزجاجة الماء والشاحن، واترك السترة الاختيارية لتبقى ثلاثة أشياء.", "ماذا تركنا خارج الحقيبة؟", "السترة."]),
    (["I have bread, cheese and cucumber. Suggest a simple snack using only these.", "Make a cheese and cucumber sandwich with the bread.", "No cheese, please.", "Make a cucumber sandwich with the bread.", "List the ingredients still used.", "Bread and cucumber."],
     ["عندي خبز وجبن وخيار. اقترح وجبة خفيفة من هذه المكونات فقط.", "اصنع شطيرة من الخبز والجبن والخيار.", "من دون جبن، لو سمحت.", "اصنع شطيرة خيار بالخبز.", "اذكر المكونات التي بقيت في الاقتراح.", "الخبز والخيار."]),
    (["In my story, Mira owns a blue bicycle and her brother Dan owns a red one.", "Mira has the blue bicycle, and Dan has the red bicycle.", "Rename Dan to Sami, but change nothing else.", "Mira has a blue bicycle, and her brother Sami has a red one.", "Who owns the red bicycle?", "Sami."],
     ["في قصتي تملك ميرا دراجة زرقاء، ويملك أخوها دان دراجة حمراء.", "دراجة ميرا زرقاء، ودراجة دان حمراء.", "غير اسم دان إلى سامي ولا تغير شيئاً آخر.", "تملك ميرا دراجة زرقاء، ويملك أخوها سامي دراجة حمراء.", "من يملك الدراجة الحمراء؟", "سامي."]),
    (["Explain photosynthesis briefly.", "Plants use light to turn water and carbon dioxide into sugars, releasing oxygen.", "Make it simpler for a child.", "A plant uses sunlight to make its own food.", "What is the source of energy in your explanation?", "Sunlight."],
     ["اشرح البناء الضوئي باختصار.", "تستخدم النباتات الضوء لتحويل الماء وثاني أكسيد الكربون إلى سكريات، وتطلق الأكسجين.", "بسط الشرح لطفل.", "يستخدم النبات ضوء الشمس ليصنع غذاءه.", "ما مصدر الطاقة في شرحك؟", "ضوء الشمس."]),
    (["What is the difference between evaporation and condensation?", "Evaporation changes a liquid into a gas. Condensation changes a gas into a liquid.", "Give one example of condensation.", "Water droplets forming on the outside of a cold glass are an example of condensation.", "Which direction is that change?", "From gas to liquid."],
     ["ما الفرق بين التبخر والتكاثف؟", "التبخر تحول السائل إلى غاز، والتكاثف تحول الغاز إلى سائل.", "أعطني مثالاً واحداً على التكاثف.", "قطرات الماء التي تتكون على السطح الخارجي لكوب بارد مثال على التكاثف.", "ما اتجاه التحول في هذا المثال؟", "من الغاز إلى السائل."]),
    (["Draft a polite message asking a colleague to send a file by tomorrow.", "Could you please send me the file by tomorrow? Thank you.", "Make it warmer but still short.", "Hi, could you please send me the file by tomorrow? I appreciate your help.", "Give me a subject line only.", "File request for tomorrow"],
     ["اكتب رسالة مهذبة أطلب فيها من زميل إرسال ملف قبل الغد.", "هل يمكنك إرسال الملف قبل الغد من فضلك؟ شكراً لك.", "اجعلها أكثر ودية مع بقائها قصيرة.", "مرحباً، هل يمكنك إرسال الملف قبل الغد من فضلك؟ أقدر مساعدتك.", "أعطني عنوان الرسالة فقط.", "طلب إرسال الملف قبل الغد"]),
    (["Write a short apology for arriving late. Do not invent a reason.", "I'm sorry I arrived late. Thank you for waiting.", "Remove the thank-you sentence.", "I'm sorry I arrived late.", "Did you give a reason for the lateness?", "No, I did not give a reason."],
     ["اكتب اعتذاراً قصيراً عن التأخر، ولا تخترع سبباً.", "أعتذر عن تأخري. شكراً لانتظارك.", "احذف جملة الشكر.", "أعتذر عن تأخري.", "هل ذكرت سبباً للتأخر؟", "لا، لم أذكر سبباً."]),
    (["Arrange these words alphabetically: pear, apple, banana.", "apple, banana, pear", "Remove banana.", "apple, pear", "Add cherry in the right place.", "apple, cherry, pear"],
     ["رتب هذه الكلمات هجائياً: تمر، أرز، بصل.", "أرز، بصل، تمر", "احذف البصل.", "أرز، تمر", "أضف جزر في مكانه الصحيح.", "أرز، تمر، جزر"]),
    (["My checklist is: wash the cup, make tea, read.", "1. Wash the cup.\n2. Make tea.\n3. Read.", "Put reading first.", "1. Read.\n2. Wash the cup.\n3. Make tea.", "What comes immediately before making tea?", "Washing the cup."],
     ["قائمتي هي: غسل الكوب، تحضير الشاي، القراءة.", "1. غسل الكوب.\n2. تحضير الشاي.\n3. القراءة.", "ضع القراءة أولاً.", "1. القراءة.\n2. غسل الكوب.\n3. تحضير الشاي.", "ماذا يأتي مباشرة قبل تحضير الشاي؟", "غسل الكوب."]),
    (["Summarize this notice: The workshop opens at ten and closes at four. It is closed on Saturday.", "The workshop is open from ten to four, except on Saturday.", "Change the closing time to five.", "The workshop is open from ten to five, except on Saturday.", "Is Saturday open according to our notice?", "No. The notice says the workshop is closed on Saturday."],
     ["لخص هذا الإعلان: تفتح الورشة في العاشرة وتغلق في الرابعة، وهي مغلقة يوم السبت.", "الورشة مفتوحة من العاشرة إلى الرابعة، باستثناء السبت.", "غير وقت الإغلاق إلى الخامسة.", "الورشة مفتوحة من العاشرة إلى الخامسة، باستثناء السبت.", "هل الورشة مفتوحة السبت بحسب الإعلان؟", "لا، الإعلان يقول إنها مغلقة يوم السبت."]),
    (["Write JSON with city equal to Harbor and seats equal to 4.", "{\"city\":\"Harbor\",\"seats\":4}", "Change only seats to 6.", "{\"city\":\"Harbor\",\"seats\":6}", "What value stayed unchanged?", "The city stayed Harbor."],
     ["اكتب JSON فيه city تساوي الميناء وseats تساوي 4.", "{\"city\":\"الميناء\",\"seats\":4}", "غير seats فقط إلى 6.", "{\"city\":\"الميناء\",\"seats\":6}", "أي قيمة لم تتغير؟", "بقيت قيمة city هي الميناء."]),
    (["Two fictional bags: A weighs one kilogram and holds ten books; B weighs two kilograms and holds fifteen.", "Bag A is lighter, while bag B holds more books.", "I need to carry twelve books. Which fits?", "Bag B fits twelve books; bag A only holds ten.", "Which one was lighter?", "Bag A."],
     ["حقيبتان خياليتان: الأولى تزن كيلوغراماً وتتسع لعشرة كتب، والثانية تزن كيلوغرامين وتتسع لخمسة عشر.", "الأولى أخف، والثانية تتسع لكتب أكثر.", "أحتاج حمل اثني عشر كتاباً. أيهما تتسع لها؟", "الثانية تتسع لاثني عشر كتاباً، أما الأولى فتتسع لعشرة فقط.", "أيهما كانت أخف؟", "الحقيبة الأولى."]),
    (["For a fictional outing, the library opens at nine and the garden opens at noon. I arrive at ten.", "You can visit the library first and the garden after noon.", "I now arrive at one in the afternoon.", "Both are open by your new arrival time, so either can come first.", "Only use the hours I gave you. Do we know when they close?", "No. You gave opening times, but no closing times."],
     ["في نزهة خيالية تفتح المكتبة في التاسعة والحديقة ظهراً، وأنا أصل في العاشرة.", "يمكنك زيارة المكتبة أولاً، ثم الحديقة بعد الظهر.", "سأصل الآن في الواحدة بعد الظهر.", "سيكون المكانان قد فتحا عند وصولك الجديد، ويمكنك البدء بأي منهما.", "التزم بالأوقات التي ذكرتها. هل نعرف وقت الإغلاق؟", "لا، ذكرت أوقات الفتح ولم تذكر أوقات الإغلاق."]),
    (["Write a two-sentence story about a lost key and a cat.", "A cat found a lost key beside the door. Its owner smiled and opened the house.", "Make the key silver.", "A cat found a lost silver key beside the door. Its owner smiled and opened the house.", "Where was the key found?", "Beside the door."],
     ["اكتب قصة من جملتين عن مفتاح ضائع وقطة.", "وجدت قطة مفتاحاً ضائعاً قرب الباب. ابتسم صاحبه وفتح البيت.", "اجعل المفتاح فضياً.", "وجدت قطة مفتاحاً فضياً ضائعاً قرب الباب. ابتسم صاحبه وفتح البيت.", "أين وجدت القطة المفتاح؟", "قرب الباب."]),
    (["Translate 'the blue door' into Arabic.", "الباب الأزرق", "Now replace blue with green, still in Arabic.", "الباب الأخضر", "Translate that last phrase back into English.", "the green door"],
     ["ترجم عبارة النافذة الصغيرة إلى الإنجليزية.", "the small window", "استبدل صغيرة بكبيرة، وما زلت أريد الإنجليزية.", "the large window", "أعد ترجمة العبارة الأخيرة إلى العربية.", "النافذة الكبيرة"]),
    (["Draft an invitation for a picnic on Friday at noon. Do not send it.", "You're invited to a picnic on Friday at noon. We'd love to see you!", "Change picnic to a board-game afternoon.", "You're invited to a board-game afternoon on Friday at noon. We'd love to see you!", "What changed?", "The event changed from a picnic to a board-game afternoon."],
     ["اكتب دعوة لنزهة يوم الجمعة ظهراً، ولا ترسلها.", "ندعوك إلى نزهة يوم الجمعة ظهراً، ويسعدنا حضورك!", "غير النزهة إلى جلسة ألعاب جماعية.", "ندعوك إلى جلسة ألعاب جماعية يوم الجمعة ظهراً، ويسعدنا حضورك!", "ما الذي تغير؟", "تغير النشاط من نزهة إلى جلسة ألعاب جماعية."]),
    (["I can choose a quiet reading room or a noisy games room. I want somewhere calm.", "The quiet reading room matches your preference for calm.", "My friend wants games instead. State our two preferences.", "You prefer a calm place; your friend prefers games.", "Have we agreed on one room?", "No. You have different preferences, and no shared choice has been agreed."],
     ["أستطيع اختيار غرفة قراءة هادئة أو غرفة ألعاب صاخبة. أريد مكاناً هادئاً.", "غرفة القراءة الهادئة تناسب رغبتك.", "صديقي يفضل الألعاب. اذكر رغبتينا.", "أنت تفضل الهدوء، وصديقك يفضل الألعاب.", "هل اتفقنا على غرفة واحدة؟", "لا، لديكما رغبتان مختلفتان ولم تتفقا على اختيار مشترك."]),
    (["Read the file on my desktop and summarize it.", "I cannot access that file through this chat. Paste its text here, and I can summarize it.", "Here is the text: The club meets twice a month. Meetings last an hour. New members are welcome.", "The club welcomes new members and holds two one-hour meetings each month.", "Did you read my desktop directly?", "No. I summarized the text you pasted here."],
     ["اقرأ الملف الموجود على سطح المكتب ولخصه.", "لا أستطيع الوصول إلى الملف من هذه المحادثة. الصق نصه هنا لألخصه.", "هذا نصه: يجتمع النادي مرتين في الشهر. مدة الاجتماع ساعة. نرحب بالأعضاء الجدد.", "يرحب النادي بالأعضاء الجدد ويعقد اجتماعين شهرياً، مدة كل منهما ساعة.", "هل قرأت سطح المكتب مباشرة؟", "لا، لخصت النص الذي لصقته هنا."]),
    (["Send my neighbour a message saying the parcel arrived.", "I cannot send messages from this chat. You can copy this draft: 'Your parcel has arrived.'", "Make the draft friendlier.", "Hi! Your parcel has arrived. Let me know when you'd like to collect it.", "Did you send it?", "No. I only wrote a draft for you to send."],
     ["أرسل إلى جاري رسالة تقول إن الطرد وصل.", "لا أستطيع إرسال الرسائل من هذه المحادثة. يمكنك نسخ هذا النص: وصل طردك.", "اجعل نص الرسالة أكثر ودية.", "مرحباً! وصل طردك. أخبرني متى يناسبك استلامه.", "هل أرسلتها؟", "لا، كتبت مسودة فقط لتتمكن من إرسالها."]),
    (["Tell me today's result for a match I have not named.", "Which match do you mean? I also do not have live results in this chat.", "I will supply the result: the green team beat the orange team two to one.", "According to the result you supplied, the green team won two to one.", "Who supplied that information?", "You supplied it in this conversation."],
     ["أخبرني بنتيجة مباراة اليوم التي لم أذكر اسمها.", "أي مباراة تقصد؟ لا تتوفر لدي أيضاً نتائج مباشرة في هذه المحادثة.", "سأعطيك النتيجة: فاز الفريق الأخضر على البرتقالي بهدفين لهدف.", "بحسب النتيجة التي ذكرتها، فاز الفريق الأخضر بهدفين لهدف.", "من قدم هذه المعلومة؟", "أنت قدمتها في هذه المحادثة."]),
    (["Remember that the title of my fictional project is Lantern.", "Within this conversation, your fictional project is titled Lantern.", "Will you necessarily remember it in a new chat?", "I cannot guarantee that a new chat will contain this conversation's context.", "What is the title in our current chat?", "Lantern."],
     ["تذكر أن عنوان مشروعي الخيالي هو المنارة.", "عنوان مشروعك الخيالي في هذه المحادثة هو المنارة.", "هل ستتذكره بالضرورة في محادثة جديدة؟", "لا أستطيع ضمان وجود سياق هذه المحادثة في محادثة جديدة.", "ما عنوانه في محادثتنا الحالية؟", "المنارة."]),
    (["What would this Python print: x = 2; print(x + 3)?", "It would print 5.", "Change x to 4.", "With x set to 4, it would print 7.", "Did you execute the code?", "No. I worked out the result from the code you provided."],
     ["ماذا يطبع كود بايثون هذا: x = 2; print(x + 3)؟", "سيطبع 5.", "غير قيمة x إلى 4.", "عند جعل x تساوي 4، سيطبع 7.", "هل نفذت الكود؟", "لا، استنتجت النتيجة من الكود الذي قدمته."]),
    (["I have five red counters and eight blue counters. How many in total?", "Thirteen counters.", "I remove three blue counters.", "You now have five red and five blue counters: ten in total.", "How many blue counters remain?", "Five."],
     ["عندي خمس قطع حمراء وثماني قطع زرقاء. كم مجموعها؟", "ثلاث عشرة قطعة.", "أزلت ثلاث قطع زرقاء.", "أصبح لديك خمس حمراء وخمس زرقاء، أي عشر قطع بالمجموع.", "كم قطعة زرقاء بقيت؟", "خمس قطع."]),
    (["How many minutes are in an hour and a quarter?", "Seventy-five minutes.", "Subtract a quarter of an hour.", "Sixty minutes remain.", "Express that remaining time in hours.", "One hour."],
     ["كم دقيقة في ساعة وربع؟", "خمس وسبعون دقيقة.", "اطرح ربع ساعة.", "تبقى ستون دقيقة.", "عبر عن الوقت المتبقي بالساعات.", "ساعة واحدة."]),
    (["Read this: Lina lent a map to Omar, and he returned it the next day. Who returned the map?", "Omar returned the map.", "Change the borrower from Omar to Nabil.", "Lina lent a map to Nabil, and he returned it the next day.", "Who lent the map?", "Lina."],
     ["اقرأ: أعارت لينا خريطة لعمر، فأعادها في اليوم التالي. من أعاد الخريطة؟", "عمر أعاد الخريطة.", "غير المستعير من عمر إلى نبيل.", "أعارت لينا خريطة لنبيل، فأعادها في اليوم التالي.", "من أعار الخريطة؟", "لينا."]),
    (["Make it shorter.", "Please paste the text you want shortened.", "Please be advised that our small shop will not be open on Sunday.", "Our shop is closed on Sunday.", "Keep the word small.", "Our small shop is closed on Sunday."],
     ["اجعله أقصر.", "أرسل النص الذي تريد اختصاره من فضلك.", "نود إعلامكم بأن متجرنا الصغير لن يكون مفتوحاً يوم الأحد.", "متجرنا مغلق يوم الأحد.", "احتفظ بكلمة الصغير.", "متجرنا الصغير مغلق يوم الأحد."]),
    (["What is my name? I have not told you yet.", "I do not know your name because you have not provided it.", "My name is Rami.", "Hello, Rami.", "What name did I give you?", "Rami."],
     ["ما اسمي؟ لم أخبرك به بعد.", "لا أعرف اسمك لأنك لم تذكره.", "اسمي هالة.", "أهلاً هالة.", "ما الاسم الذي أخبرتك به؟", "هالة."]),
    (["Suggest two names for a fictional cafe with a sea theme.", "Harbour Cup and Blue Sail.", "I choose the second one.", "You chose Blue Sail.", "Write a five-word slogan for it.", "A warm cup beside waves."],
     ["اقترح اسمين لمقهى خيالي بطابع بحري.", "كوب الميناء، والشراع الأزرق.", "اخترت الاسم الثاني.", "اخترت الشراع الأزرق.", "اكتب له شعاراً من خمس كلمات.", "كوب دافئ على إيقاع الموج."]),
    (["Give me a five-minute spelling practice plan.", "Read three words, cover them, write them from memory, then compare and correct.", "I only have two minutes.", "Practise one word: read it, cover it, write it, and check it.", "What changed between the two plans?", "The shorter plan uses one word instead of three."],
     ["اقترح تدريباً على الإملاء مدته خمس دقائق.", "اقرأ ثلاث كلمات، أخفها، اكتبها من الذاكرة، ثم قارن وصحح.", "ليس لدي إلا دقيقتان.", "تدرب على كلمة واحدة: اقرأها، أخفها، اكتبها، ثم راجعها.", "ما الذي تغير بين الخطتين؟", "الخطة الأقصر تستخدم كلمة واحدة بدلاً من ثلاث."]),
    (["Explain a programming variable simply.", "A variable is a name associated with a value that a program can use.", "Use a box analogy.", "Think of a labelled box: the label is the variable name, and the content is its value.", "In that analogy, what is the label?", "The variable name."],
     ["اشرح المتغير في البرمجة ببساطة.", "المتغير اسم يرتبط بقيمة يمكن للبرنامج استخدامها.", "استخدم تشبيهاً بصندوق.", "تخيل صندوقاً له ملصق: الملصق اسم المتغير، وما في الصندوق قيمته.", "ما الذي يمثله الملصق في هذا التشبيه؟", "اسم المتغير."]),
    (["What happens when the same poles of two magnets face each other?", "They repel each other.", "And when opposite poles face each other?", "They attract each other.", "Give the two cases in one short line.", "Same poles repel; opposite poles attract."],
     ["ماذا يحدث عندما يتقابل قطبان متماثلان لمغناطيسين؟", "يتنافران.", "وماذا يحدث عند تقابل قطبين مختلفين؟", "يتجاذبان.", "اجمع الحالتين في سطر قصير.", "الأقطاب المتماثلة تتنافر، والمختلفة تتجاذب."]),
    (["Assign washing to Noor and drying to Karim.", "Noor washes, and Karim dries.", "Swap their tasks.", "Karim washes, and Noor dries.", "Who is washing now?", "Karim."],
     ["اجعل الغسل مهمة نور والتجفيف مهمة كريم.", "نور تغسل، وكريم يجفف.", "بدل المهمتين بينهما.", "كريم يغسل، ونور تجفف.", "من يغسل الآن؟", "كريم."]),
    (["A fictional receipt has three pencils at two coins each and one notebook at five coins.", "The pencils cost six coins, and the notebook costs five: eleven coins total.", "Remove the notebook.", "The remaining total is six coins for the three pencils.", "What is the price of one pencil?", "Two coins."],
     ["في إيصال خيالي ثلاثة أقلام، سعر الواحد قطعتان نقديتان، ودفتر بسعر خمس قطع.", "الأقلام تكلف ست قطع، والدفتر خمساً؛ المجموع إحدى عشرة قطعة.", "احذف الدفتر.", "يبقى مجموع ست قطع نقدية مقابل الأقلام الثلاثة.", "ما سعر القلم الواحد؟", "قطعتان نقديتان."]),
    (["Extract the budget from this note: I can spend 30 each week. Do not guess a currency.", "Amount: 30. Period: weekly. Currency: not specified.", "The currency is pounds.", "Budget: 30 pounds per week.", "Did I say per day?", "No. You said per week."],
     ["استخرج الميزانية من: أستطيع إنفاق 30 كل أسبوع. لا تخمن العملة.", "المبلغ: 30. المدة: أسبوعية. العملة: غير مذكورة.", "العملة هي الجنيه.", "الميزانية: 30 جنيهاً أسبوعياً.", "هل قلت إنها يومية؟", "لا، قلت إنها أسبوعية."]),
    (["My fictional shop sells cups in Riverton.", "Your fictional shop sells cups in Riverton.", "Correct the location to Hillford.", "Your fictional shop sells cups in Hillford.", "Now change cups to bowls, keeping the corrected location.", "Your fictional shop sells bowls in Hillford."],
     ["متجري الخيالي يبيع أكواباً في مدينة النهر.", "متجرك الخيالي يبيع أكواباً في مدينة النهر.", "صحح المكان إلى مدينة التل.", "متجرك الخيالي يبيع أكواباً في مدينة التل.", "غير الأكواب إلى أطباق، مع الاحتفاظ بالمكان المصحح.", "متجرك الخيالي يبيع أطباقاً في مدينة التل."]),
    (["Our meeting is Wednesday morning. The venue has not been chosen.", "The meeting is Wednesday morning, and the venue is undecided.", "Choose no venue for me; just list what is missing.", "The venue is missing. An exact start time is also not specified.", "Set the time to ten, but leave the venue open.", "Meeting: Wednesday at ten in the morning. Venue: not yet chosen."],
     ["اجتماعنا صباح الأربعاء، ولم نحدد المكان.", "الاجتماع صباح الأربعاء، والمكان لم يحدد بعد.", "لا تختر مكاناً عني، فقط اذكر المعلومات الناقصة.", "المكان ناقص، كما لم تذكر ساعة بدء محددة.", "اجعل الساعة العاشرة واترك المكان مفتوحاً.", "الاجتماع الأربعاء الساعة العاشرة صباحاً. المكان لم يحدد بعد."]),
    (["Help me write a poem about a river.", "Would you like it calm, cheerful or dramatic?", "Cancel the poem. Explain what a triangle is instead.", "A triangle is a shape with three straight sides and three angles.", "How many sides did you say?", "Three."],
     ["ساعدني على كتابة قصيدة عن نهر.", "هل تريدها هادئة أم مرحة أم درامية؟", "ألغ القصيدة. اشرح لي بدلاً منها ما هو المثلث.", "المثلث شكل له ثلاثة أضلاع مستقيمة وثلاث زوايا.", "كم ضلعاً ذكرت؟", "ثلاثة أضلاع."]),
    (["We are planning a fictional exhibition. The room is called Cedar, the theme is light, and entry is free.", "The exhibition is in Cedar, its theme is light, and entry is free.", "Change the room to Maple.", "The room is now Maple; the theme is still light and entry remains free.", "Change the theme to sound.", "The exhibition is in Maple, its theme is sound, and entry is free.", "Keep only the latest room and theme.", "Room: Maple. Theme: sound.", "Did the entry fee change?", "No. Entry is still free."],
     ["نخطط لمعرض خيالي. اسم القاعة الأرز، والموضوع الضوء، والدخول مجاني.", "المعرض في قاعة الأرز، وموضوعه الضوء، والدخول مجاني.", "غير القاعة إلى القيقب.", "أصبحت القاعة القيقب، والموضوع ما زال الضوء، والدخول مجاني.", "غير الموضوع إلى الصوت.", "المعرض في قاعة القيقب، وموضوعه الصوت، والدخول مجاني.", "اذكر اسم القاعة والموضوع الأحدث فقط.", "القاعة: القيقب. الموضوع: الصوت.", "هل تغيرت رسوم الدخول؟", "لا، الدخول ما زال مجانياً."]),
    (["My list has a green folder, a silver pen and a yellow notebook.", "Your list is: green folder, silver pen, yellow notebook.", "Replace the pen with a wooden pencil.", "Your list is: green folder, wooden pencil, yellow notebook.", "Remove the folder.", "Your list is: wooden pencil, yellow notebook.", "Add a white envelope at the beginning.", "Your list is: white envelope, wooden pencil, yellow notebook.", "Which original item is still on the list?", "The yellow notebook."],
     ["قائمتي فيها ملف أخضر وقلم فضي ودفتر أصفر.", "القائمة: ملف أخضر، قلم فضي، دفتر أصفر.", "استبدل القلم بقلم رصاص خشبي.", "القائمة: ملف أخضر، قلم رصاص خشبي، دفتر أصفر.", "احذف الملف.", "القائمة: قلم رصاص خشبي، دفتر أصفر.", "أضف ظرفاً أبيض في البداية.", "القائمة: ظرف أبيض، قلم رصاص خشبي، دفتر أصفر.", "أي شيء من القائمة الأصلية ما زال موجوداً؟", "الدفتر الأصفر."]),
]


def authored_rows(encoder: TextEncoder) -> list[dict]:
    rows = []
    for index, scenario in enumerate(AUTHORED):
        for language, turns in zip(("en", "ar"), scenario):
            for stop in range(1, len(turns), 2):
                messages = [{"role": "user" if i % 2 == 0 else "assistant", "content": content} for i, content in enumerate(turns[:stop])]
                prompt, target = conversation_prompt(messages), turns[stop]
                input_tokens, answer_tokens = len(encoder.encode(prompt)), len(encoder.encode(target)) + 1
                if answer_tokens > 192 or input_tokens + 192 > 1024:
                    raise RuntimeError(f"Authored scenario{index}/{language}/{stop} exceeds runtime limits.")
                rows.append({"id": f"authored-v3-{index:03d}-{language}-{stop}", "language": language,
                             "capability": "chat.reply.v1", "source": "agent_authored_dialogue_v3",
                             "group": f"authored-v3-scenario-{index:03d}", "messages": messages, "prompt": prompt, "target": target,
                             "input_tokens": input_tokens, "answer_tokens": answer_tokens})
    return rows


def helper(name: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def aya_extra_reason(question: str) -> str | None:
    normalized = key(question)
    if re.search(r"^(?:كمل|اكمل|اتمم|تابع)\s+(?:(?:هذا|هذه|تلك|التالي)\s+)?(?:النص|الفقرة|الجملة|العبارة|الخبر)", normalized):
        return "expanded_source_continuation_exclusion"
    if re.search(r"مؤخرا|حاليا|حتي الان|الوقت الحالي|في الوقت الراهن|\b(?:current|recently|latest|as of today)\b", normalized):
        return "expanded_time_sensitive_exclusion"
    if re.search(r"لقاح|يوديد البوتاسيوم|طوارئ اشعاع|مرض|عدوي|تشخيص|علاج|دواء|ادوية|\b(?:vaccine|diagnosis|medication|radiation emergency)\b", normalized):
        return "expanded_medical_scope_exclusion"
    return None


def build_aya(encoder: TextEncoder, reserved_families: set[str], reserved_answers: set[str]) -> tuple[list[dict], dict]:
    """Recover full short replies using the extended tokenizer, without balance caps."""
    import pyarrow.parquet as pq
    aya, cleaner = helper("prepare_aya"), helper("clean_aya")
    source = ROOT / "artifacts/corpora/aya-chat" / aya.COMMIT / "train.parquet"
    if source.stat().st_size != aya.TRAIN_BYTES or digest(source) != aya.TRAIN_SHA256:
        raise RuntimeError("Pinned Aya TRAIN checksum mismatch.")
    exclusions_path = ROOT / "artifacts/chat-training/conversation-v2b/qa/exclusions.json"
    excluded = {r["id"] for r in json.loads(exclusions_path.read_text(encoding="utf-8"))}
    review_path = ROOT / "scripts/chat-training/dialogue_v3_source_review.json"
    review = json.loads(review_path.read_text(encoding="utf-8")) if review_path.exists() else {"exclusions": []}
    excluded.update(r["id"] for r in review["exclusions"])
    groups, counts, drops = defaultdict(list), Counter(), Counter()
    for batch in pq.ParquetFile(source).iter_batches(batch_size=2048, columns=["inputs", "targets", "language_code"]):
        for raw in batch.to_pylist():
            code = raw["language_code"]
            if code not in aya.LANGUAGES:
                continue
            counts[code] += 1
            if not isinstance(raw["inputs"], str) or not isinstance(raw["targets"], str):
                drops["non_text"] += 1
                continue
            question, target, language = aya.clean(raw["inputs"]), aya.clean(raw["targets"]), aya.LANGUAGES[code]
            identifier = "aya-" + text_hash(aya.normalize(question))
            if identifier in excluded:
                drops["previous_or_v3_source_quarantine"] += 1
                continue
            reason = aya.quality_reason(question, target, language) or aya_extra_reason(question)
            if reason:
                drops[reason] += 1
                continue
            messages = [{"role": "user", "content": question}]
            row = {"id": identifier, "source": "aya_train", "language": language, "source_language_code": code,
                   "capability": "chat.reply.v1", "category": "public_instruction", "messages": messages,
                   "prompt": conversation_prompt(messages), "target": target, "group": "aya-root-" + text_hash(family(question))}
            reason = cleaner.mechanical_reason(row)
            if reason:
                drops[reason] += 1
                continue
            if family(question) in reserved_families or key(target) in reserved_answers:
                drops["previous_validation_family_or_answer"] += 1
                continue
            row["input_tokens"], row["answer_tokens"] = len(encoder.encode(row["prompt"])), len(encoder.encode(target)) + 1
            if row["answer_tokens"] > 192:
                drops["answer_over_192_tokens"] += 1
                continue
            if row["input_tokens"] + 192 > 1024:
                drops["history_over_runtime_context_reserve"] += 1
                continue
            groups[key(question)].append(row)
    candidates, conflicting_prompts = [], []
    for rows in groups.values():
        if len({key(r["target"]) for r in rows}) > 1:
            drops["conflicting_answers_for_normalized_prompt"] += len(rows)
            conflicting_prompts.append(text_hash(key(rows[0]["messages"][0]["content"])))
            continue
        drops["duplicate_normalized_prompt"] += len(rows) - 1
        candidates.append(min(rows, key=lambda r: r["prompt"]))
    return candidates, {"repository": aya.REPOSITORY, "revision": aya.COMMIT, "license": "Apache-2.0", "split": "train",
                        "source_path": str(source.relative_to(ROOT)), "source_sha256": aya.TRAIN_SHA256,
                        "source_language_counts": dict(counts), "candidates_by_language": dict(Counter(r["language"] for r in candidates)),
                        "drop_counts": dict(drops), "balance_cap": None, "quarantine_sha256": digest(exclusions_path),
                        "conflicting_prompt_sha256": sorted(conflicting_prompts),
                        "v3_source_review_sha256": digest(review_path) if review_path.exists() else None,
                        "quality_filter_sha256": digest(Path(aya.__file__)), "mechanical_filter_sha256": digest(Path(cleaner.__file__))}


def build(args) -> dict:
    if args.output.exists():
        raise RuntimeError("Never overwrite a frozen dataset version.")
    sources = fetch(args.sources)
    encoder = TextEncoder(args.run)
    old_validation = []
    previous = {}
    for name in ("conversation-v1", "conversation-v2", "conversation-v2b"):
        file = ROOT / "artifacts/chat-training" / name / "dataset/validation.jsonl"
        old_validation.extend(read_rows(file))
        previous[name] = digest(file)
    reserved_families = {family(message["content"]) for row in old_validation for message in row["messages"] if message["role"] == "user"}
    reserved_answers = {key(row["target"]) for row in old_validation}
    oa, oa_report = build_oa(args.sources, encoder, reserved_families, reserved_answers)
    aya, aya_report = build_aya(encoder, reserved_families, reserved_answers)
    authored = authored_rows(encoder)
    inherited = read_rows(ROOT / "artifacts/chat-training/conversation-v2b/dataset/train.jsonl")
    # The preserved V2b training split already contains500authored and320bounded
    # systematic rows. Keep it once; do not multiply rows to fake language breadth.
    kept_inherited, drop = [], Counter()
    for row in inherited:
        if row["source"] == "aya_train" and (aya_extra_reason(row["messages"][0]["content"]) or text_hash(key(row["messages"][0]["content"])) in aya_report["conflicting_prompt_sha256"]):
            drop["inherited_aya_expanded_filter_or_conflict"] += 1
            continue
        if key(row["target"]) in reserved_answers or any(family(message["content"]) in reserved_families for message in row["messages"] if message["role"] == "user"):
            drop["inherited_previous_validation_family_or_answer"] += 1
            continue
        kept_inherited.append({**row, "group": "inherited-v2b-" + text_hash(family(row["messages"][0]["content"]))})
    train = kept_inherited[:]
    validation = read_rows(ROOT / "artifacts/chat-training/conversation-v2b/dataset/validation.jsonl")
    inherited_prompts = {key(row["prompt"]) for row in train}
    inherited_root_families = {family(row["messages"][0]["content"]) for row in train}
    grouped = defaultdict(list)
    # Join entire source trees/scenarios when their normalized roots coincide,
    # including cross-source overlap between Aya, OASST and authored dialogue.
    parent, family_owner = {}, {}
    def find(group):
        parent.setdefault(group, group)
        if parent[group] != group:
            parent[group] = find(parent[group])
        return parent[group]
    for row in oa + aya + authored:
        group, root = row["group"], family(row["messages"][0]["content"])
        prior = family_owner.setdefault(root, group)
        left, right = find(group), find(prior)
        parent[max(left, right)] = min(left, right)
    for row in oa + aya + authored:
        row["group"] = find(row["group"])
        grouped[row["group"]].append(row)
    for group, rows in sorted(grouped.items()):
        if any(key(row["prompt"]) in inherited_prompts or family(row["messages"][0]["content"]) in inherited_root_families for row in rows):
            drop["new_group_duplicate_inherited_train"] += len(rows)
            continue
        if any(key(row["target"]) in reserved_answers or any(family(m["content"]) in reserved_families for m in row["messages"] if m["role"] == "user") for row in rows):
            drop["new_group_overlaps_previous_validation"] += len(rows)
            continue
        destination = validation if int(text_hash(group)[:16], 16) % 100 < 5 else train
        destination.extend(rows)
    # Prevent exact-target leakage by excluding the entire newly assigned
    # validation group if its target also occurs in training. Never move it.
    train_answers = {key(row["target"]) for row in train}
    bad_groups = {row.get("group", "old-validation-" + row["id"]) for row in validation if key(row["target"]) in train_answers}
    validation = [row for row in validation if row.get("group", "old-validation-" + row["id"]) not in bad_groups]
    drop["validation_groups_with_training_answer"] = len(bad_groups)
    for split, rows in (("train", train), ("validation", validation)):
        unique = {}
        for row in rows:
            normalized = key(row["prompt"])
            if normalized in unique:
                drop[split + "_duplicate_prompt"] += 1
                continue
            unique[normalized] = row
        rows[:] = sorted(unique.values(), key=lambda row: text_hash("shuffle-v3:" + row["id"]))
        for row in rows:
            row["input_tokens"] = len(encoder.encode(row["prompt"]))
            row["answer_tokens"] = len(encoder.encode(row["target"])) + 1
            row["total_tokens"] = row["input_tokens"] + row["answer_tokens"]
            if row["input_tokens"] + 192 > 1024 or row["answer_tokens"] > 192:
                raise RuntimeError(f"Final {split} row exceeds token budget: {row['id']}")
    assert not ({key(r["prompt"]) for r in train} & {key(r["prompt"]) for r in validation})
    assert not ({key(r["target"]) for r in train} & {key(r["target"]) for r in validation})
    assert not ({r.get("group") for r in train if r.get("group")} & {r.get("group") for r in validation if r.get("group")})
    assert not ({r.get("source_tree_id") for r in train if r.get("source_tree_id")} & {r.get("source_tree_id") for r in validation if r.get("source_tree_id")})
    assert not ({family(r["messages"][0]["content"]) for r in train} & {family(r["messages"][0]["content"]) for r in validation})
    assert not ({key(r["target"]) for r in train} & reserved_answers)
    assert not ({family(m["content"]) for r in train for m in r["messages"] if m["role"] == "user"} & reserved_families)
    manifest = {"schema_version": 1, "curriculum": "mohassan-conversation-v3-human-trees", "created_at": datetime.now(timezone.utc).isoformat(),
                "sources": sources, "openassistant": oa_report, "aya_expansion": aya_report, "previous_validation_sha256": previous,
                "build_script_sha256": digest(Path(__file__)),
                "authored_bilingual_scenarios": len(AUTHORED), "authored_full_dialogues": len(AUTHORED) * 2,
                "authored_source": "New agent-authored dialogues; no external model API calls. Individual prefix/answer rows share a scenario split.",
                "tokenizer_identity": encoder.tokenizer.identity, "tokenizer_sha256": digest(args.run / "tokenizer.json"),
                "selection": "Best-ranked reviewed human OASST replies with reviewed ancestors; full history. Aya source and v2b mechanical filters plus known quarantine. Entire tree and cross-source normalized-root family grouped; new groups 5 percent validation by SHA256; inherited validation stays validation.",
                "exclusions": dict(drop), "answer_token_limit_including_eos": 192, "context": 1024, "reserved_generation_tokens": 192,
                "answers_or_history_truncated": False, "removed_user_metadata": True, "language_oversampling": False,
                "final_holdout_read": False, "final_holdout_used_for_training": False, "validation_is_independent_final_test": False,
                "limitations": ["OpenAssistant has very few Arabic messages. English conversation diversity does not establish Arabic capability.",
                               "Human review metadata is a useful source filter, not comprehensive factual verification.",
                               "Aya annotations retain the previously documented source-quality limitations; a small additional source sample is not a population accuracy estimate.",
                               "Authored dialogues are synthetic, not user conversations, and prefix expansion does not create new scenarios.",
                               "Exact/group checks do not establish absence of every semantic paraphrase overlap."], "splits": {}}
    args.output.mkdir(parents=True, exist_ok=False)
    for split, rows in (("train", train), ("validation", validation)):
        data = ("\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows) + "\n").encode("utf-8")
        (args.output / f"{split}.jsonl").write_bytes(data)
        manifest["splits"][split] = {"rows": len(rows), "languages": dict(Counter(r["language"] for r in rows)),
                                      "sources": dict(Counter(r["source"] for r in rows)),
                                      "source_language_counts": dict(Counter(r["source"] + ":" + r["language"] for r in rows)),
                                      "history_lengths": dict(Counter(len(r["messages"]) for r in rows)),
                                      "multiturn_rows": sum(len(r["messages"]) > 1 for r in rows),
                                      "input_tokens": sum(r["input_tokens"] for r in rows), "answer_tokens": sum(r["answer_tokens"] for r in rows),
                                      "max_input_tokens": max(r["input_tokens"] for r in rows), "max_answer_tokens": max(r["answer_tokens"] for r in rows),
                                      "sha256": hashlib.sha256(data).hexdigest()}
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", type=Path, default=ROOT / "artifacts/corpora/openassistant-chat")
    parser.add_argument("--run", type=Path, default=ROOT / "artifacts/execution-model-runs/text-b3-ar-2026-11-15")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/chat-training/conversation-v3/dataset")
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()
    result = fetch(args.sources) if args.download_only else build(args)
    print(json.dumps(result if args.download_only else {"output": str(args.output), "openassistant": result["openassistant"], "splits": result["splits"]}, ensure_ascii=True, indent=2))
