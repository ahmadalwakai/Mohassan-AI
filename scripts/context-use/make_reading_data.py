"""Reading-skill training data: passage + question -> exact answer span, or "not stated".

Same prompt shape as the frozen context test ("<passage>\n\nQuestion: ...\nAnswer:"), so that test
reads the trained model unchanged. Leakage rules, checked at the end:
  * relation families here are NOT the test's (no shops, trips, pets, rankings, opening hours,
    room colours, team venues, chores, ferry prices, trees, wells, crafts, engineers, cooking);
  * no name, place or value from items.json / demos.json appears in any generated row;
  * four families are held out of training entirely (dev_heldout split) to measure transfer.
Usage: python make_reading_data.py OUT_DIR
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import random
import re
import sys

HERE = Path(__file__).resolve().parent
NOT_STATED = {"en": "Not stated in the text", "ar": "غير مذكور في النص"}
Q = {"en": "Question: ", "ar": "سؤال: "}
A = {"en": "Answer:", "ar": "الجواب:"}

EN_NAMES = """Alice Brian Chloe Derek Elena Felix Gemma Harry Irene Jacob Karen Liam Megan Noah Olga Peter Quinn Rosa
Simon Tara Ulrich Vera Walter Xenia Yara Zack Amber Boris Celia Dylan Edith Frank Gloria Henry Ingrid Jonas Kate Lars
Maria Nils Oscar Paula Ralph Selma Theo Ursula Vince Wendy Aaron Bella Carl Diana Ethan Fiona George Hazel Ivan Julia
Kevin Laura Martin Nina Owen Pia Robert Stella Tobias Uma Victoria Will Agnes Bruno Cora Dennis Eva Fred Greta Hans
Isla Jack Kira Louis Maya Neil Olivia Patrick Rita Steve Tessa Vincent Wanda Albert Beth Cyril Dora Emil Flora""".split()
AR_M = """سامي خالد طارق نبيل عمر زياد فراس باسل ماجد سعيد هشام عادل أيمن مروان جمال فادي نزار رائد شادي صالح
إبراهيم مصطفى علي سليم عماد غسان قاسم لؤي معاذ نادر هاني وسيم ياسين أسامة بشير ثامر حمزة رامز سامر_x شريف
عصام فيصل كمال مهند ناصر هيثم وائل يحيى أنس تامر حازم رياض صهيب عبدالله فارس مالك نضال""".split()
AR_F = """سلمى نور لينا ديما رهف جنى سارة_x مريم دعاء أمل بشرى حنان رغد سعاد شيماء عبير غادة لمى مها نسرين
هبة وفاء ياسمين آمنة إيمان بتول جميلة حلا خلود دانة رنيم زينب سمر شهد صفاء عائشة فرح كوثر لبنى ميساء
نجلاء هيفاء وعد أسماء تسنيم جود حياة رزان روان سهى عفاف فدوى ملك نوال""".split()
AR_M = [n for n in AR_M if not n.endswith("_x")]
AR_F = [n for n in AR_F if not n.endswith("_x")]


def pick(rng, pool, k):
    return rng.sample(pool, k)


# ---------------- families ----------------
# Each family: values per language, fact templates, forward/reverse question templates.
# Arabic templates are (masculine, feminine) pairs; reverse questions use the generic masculine.
FAM = {
    "job": {
        "en": {"values": "nurse pilot plumber farmer lawyer dentist chef electrician journalist mechanic pharmacist tailor architect firefighter accountant photographer".split(),
               "facts": ["{s} works as a {v}.", "{s} is a {v}.", "{s} has been a {v} for many years."],
               "fwd": ["What is {s}'s job?", "What does {s} do for a living?", "What work does {s} do?"],
               "rev": ["Who works as a {v}?", "Who is the {v}?", "Which person is a {v}?"]},
        "ar": {"values": "التمريض التدريس الطب المحاماة الصيدلة الهندسة الصحافة الطيران الزراعة الخياطة البرمجة الميكانيك السباكة المحاسبة التصوير الإطفاء".split(),
               "facts": [("يعمل {s} في {v}.", "تعمل {s} في {v}."), ("مهنة {s} هي {v}.", "مهنة {s} هي {v}."),
                         ("يشتغل {s} في {v} منذ سنوات.", "تشتغل {s} في {v} منذ سنوات.")],
               "fwd": [("ما مهنة {s}؟", "ما مهنة {s}؟"), ("في أي مجال يعمل {s}؟", "في أي مجال تعمل {s}؟")],
               "rev": ["من يعمل في {v}؟", "من مهنته {v}؟"]}},
    "lives": {
        "en": {"values": "Lisbon Oslo Cairo Dublin Vienna Prague Madrid Krakow Porto Tunis Athens Riga Bergen Seville Lyon Naples Zagreb Valencia".split(),
               "facts": ["{s} lives in {v}.", "{s} moved to {v} a few years ago.", "{s} has a flat in {v}."],
               "fwd": ["Where does {s} live?", "Which city does {s} live in?", "In which city is {s}'s home?"],
               "rev": ["Who lives in {v}?", "Which person has a home in {v}?"]},
        "ar": {"values": "القاهرة تونس عمّان بيروت الرباط دمشق بغداد مسقط الدوحة الخرطوم طرابلس صنعاء جدة حلب الإسكندرية فاس صفاقس وهران".split(),
               "facts": [("يسكن {s} في {v}.", "تسكن {s} في {v}."), ("انتقل {s} إلى {v} قبل سنوات.", "انتقلت {s} إلى {v} قبل سنوات."),
                         ("بيت {s} في مدينة {v}.", "بيت {s} في مدينة {v}.")],
               "fwd": [("أين يسكن {s}؟", "أين تسكن {s}؟"), ("في أي مدينة يعيش {s}؟", "في أي مدينة تعيش {s}؟")],
               "rev": ["من يسكن في {v}؟", "من بيته في مدينة {v}؟"]}},
    "instrument": {
        "en": {"values": "violin piano drums flute guitar cello trumpet harp oud saxophone clarinet accordion banjo".split(),
               "facts": ["{s} plays the {v}.", "{s} has played the {v} since childhood.", "{s} is learning the {v}."],
               "fwd": ["Which instrument does {s} play?", "What instrument does {s} play?", "What does {s} play?"],
               "rev": ["Who plays the {v}?", "Which person plays the {v}?"]},
        "ar": {"values": "العود البيانو الكمان الناي القانون الطبل الغيتار التشيلو البزق الساكسفون الأكورديون".split(),
               "facts": [("يعزف {s} على {v}.", "تعزف {s} على {v}."), ("يتعلم {s} العزف على {v}.", "تتعلم {s} العزف على {v}.")],
               "fwd": [("على أي آلة يعزف {s}؟", "على أي آلة تعزف {s}؟"), ("ما الآلة التي يعزف عليها {s}؟", "ما الآلة التي تعزف عليها {s}؟")],
               "rev": ["من يعزف على {v}؟", "من يتعلم العزف على {v}؟"]}},
    "age": {
        "en": {"values": [str(n) for n in range(19, 89)],
               "facts": ["{s} is {v} years old.", "{s} turned {v} last month."],
               "fwd": ["How old is {s}?", "What is {s}'s age?"],
               "rev": ["Who is {v} years old?"]},
        "ar": {"values": [str(n) for n in range(19, 89)],
               "facts": [("عمر {s} {v} عاماً.", "عمر {s} {v} عاماً."), ("بلغ {s} {v} عاماً هذا الشهر.", "بلغت {s} {v} عاماً هذا الشهر.")],
               "fwd": [("كم عمر {s}؟", "كم عمر {s}؟"), ("كم يبلغ {s} من العمر؟", "كم تبلغ {s} من العمر؟")],
               "rev": ["من عمره {v} عاماً؟"]}},
    "author": {
        "en": {"values": None,
               "facts": ["The novel {v} was written by {s}.", "{s} wrote the novel {v}.", "{s} is the author of {v}."],
               "fwd": ["Which novel did {s} write?", "What is the title of {s}'s novel?"],
               "rev": ["Who wrote {v}?", "Who is the author of {v}?"]},
        "ar": {"values": None,
               "facts": [("كتب {s} رواية {v}.", "كتبت {s} رواية {v}."), ("رواية {v} من تأليف {s}.", "رواية {v} من تأليف {s}.")],
               "fwd": [("ما الرواية التي كتبها {s}؟", "ما الرواية التي كتبتها {s}؟"), ("ما اسم رواية {s}؟", "ما اسم رواية {s}؟")],
               "rev": ["من كتب رواية {v}؟", "من مؤلف رواية {v}؟"]}},
    "day": {
        "en": {"values": "Monday Tuesday Wednesday Thursday Friday".split(), "subjects": "club",
               "facts": ["The {s} meets every {v}.", "Members of the {s} get together on {v}.", "Every {v}, the {s} holds its meeting."],
               "fwd": ["On which day does the {s} meet?", "When does the {s} meet?"],
               "rev": ["Which group meets on {v}?"]},
        "ar": {"values": "الأحد الاثنين الثلاثاء الأربعاء الخميس".split(), "subjects": "club",
               "facts": [("يجتمع {s} كل يوم {v}.", None), ("يلتقي أعضاء {s} يوم {v} من كل أسبوع.", None)],
               "fwd": [("في أي يوم يجتمع {s}؟", None), ("متى يجتمع {s}؟", None)],
               "rev": ["أي مجموعة تجتمع يوم {v}؟"]}},
    "distance": {
        "en": {"values": [f"{n} kilometres" for n in range(3, 95)], "subjects": "place",
               "facts": ["{s} is {v} from the coast.", "The coast lies {v} from {s}."],
               "fwd": ["How far is {s} from the coast?", "What is the distance between {s} and the coast?"],
               "rev": []},
        "ar": {"values": [f"{n} كيلومتراً" for n in range(11, 95)], "subjects": "place",
               "facts": [("تبعد {s} عن البحر {v}.", None), ("المسافة بين {s} والبحر {v}.", None)],
               "fwd": [("كم تبعد {s} عن البحر؟", None), ("ما المسافة بين {s} والبحر؟", None)],
               "rev": []}},
    "food": {
        "en": {"values": ["grilled fish", "lentil stew", "chicken curry", "roast lamb", "spinach pie", "fried rice", "beef stew", "falafel", "pancakes", "risotto", "couscous", "dumplings"],
               "facts": ["{s}'s favourite dish is {v}.", "{s} loves {v} more than any other dish."],
               "fwd": ["What is {s}'s favourite dish?", "Which dish does {s} like best?"],
               "rev": ["Whose favourite dish is {v}?", "Who loves {v} most?"]},
        "ar": {"values": "المقلوبة الكبسة الكسكس الملوخية المنسف الفلافل الكبة المحشي الفتة البرياني المسخن".split(),
               "facts": [("طبق {s} المفضل هو {v}.", "طبق {s} المفضل هو {v}."), ("يحب {s} {v} أكثر من أي طبق آخر.", "تحب {s} {v} أكثر من أي طبق آخر.")],
               "fwd": [("ما طبق {s} المفضل؟", "ما طبق {s} المفضل؟"), ("ما الطبق الذي يفضله {s}؟", "ما الطبق الذي تفضله {s}؟")],
               "rev": ["من طبقه المفضل {v}؟", "من يحب {v} أكثر من أي طبق آخر؟"]}},
    "teach": {
        "en": {"values": ["maths", "history", "chemistry", "physics", "geography", "biology", "French", "art", "music", "philosophy", "economics"],
               "facts": ["{s} teaches {v}.", "{s} is the {v} teacher at the school."],
               "fwd": ["What does {s} teach?", "Which subject does {s} teach?"],
               "rev": ["Who teaches {v}?", "Who is the {v} teacher?"]},
        "ar": {"values": "الرياضيات التاريخ الكيمياء الفيزياء الجغرافيا الأحياء الفنون الموسيقى الفلسفة الاقتصاد".split(),
               "facts": [("يدرّس {s} مادة {v}.", "تدرّس {s} مادة {v}."), ("{s} هو معلم {v} في المدرسة.", "{s} هي معلمة {v} في المدرسة.")],
               "fwd": [("ما المادة التي يدرّسها {s}؟", "ما المادة التي تدرّسها {s}؟"), ("ماذا يدرّس {s}؟", "ماذا تدرّس {s}؟")],
               "rev": ["من يدرّس مادة {v}؟"]}},
    "founded": {
        "en": {"values": [str(y) for y in range(1801, 2020)], "subjects": "org",
               "facts": ["{s} was founded in {v}.", "{s} opened its doors in {v}."],
               "fwd": ["When was {s} founded?", "In which year was {s} founded?"],
               "rev": ["Which organisation was founded in {v}?"]},
        "ar": {"values": [str(y) for y in range(1801, 2020)], "subjects": "org",
               "facts": [("تأسست {s} عام {v}.", None), ("بدأت {s} عملها سنة {v}.", None)],
               "fwd": [("متى تأسست {s}؟", None), ("في أي عام تأسست {s}؟", None)],
               "rev": ["أي مؤسسة تأسست عام {v}؟"]}},
    # ---- held out of training ----
    "language": {
        "en": {"values": "Spanish Turkish German Persian Russian Italian Japanese Greek Polish Swahili Dutch Korean".split(),
               "facts": ["{s} speaks {v}.", "{s} learned {v} as a child."],
               "fwd": ["Which language does {s} speak?", "What language did {s} learn as a child?"],
               "rev": ["Who speaks {v}?"]},
        "ar": {"values": "الفرنسية الإسبانية التركية الألمانية الفارسية الروسية الإيطالية اليابانية اليونانية".split(),
               "facts": [("يتكلم {s} اللغة {v}.", "تتكلم {s} اللغة {v}."), ("تعلّم {s} اللغة {v} في صغره.", "تعلّمت {s} اللغة {v} في صغرها.")],
               "fwd": [("ما اللغة التي يتكلمها {s}؟", "ما اللغة التي تتكلمها {s}؟")],
               "rev": ["من يتكلم اللغة {v}؟"]}},
    "gift": {
        "en": {"values": ["watch", "scarf", "camera", "lamp", "vase", "wallet", "umbrella", "necklace", "kettle", "rug"],
               "facts": ["{s} gave {r} a {v}.", "{s} bought a {v} as a present for {r}."],
               "fwd": ["What did {s} give {r}?", "What present did {s} buy for {r}?"],
               "rev": ["Who gave {r} a {v}?"]},
        "ar": {"values": "ساعة حقيبة مظلة سجادة لوحة قلادة مزهرية محفظة كاميرا".split(),
               "facts": [("أهدى {s} {r} {v}.", "أهدت {s} {r} {v}."), ("اشترى {s} {v} هدية لـ{r}.", "اشترت {s} {v} هدية لـ{r}.")],
               "fwd": [("ماذا أهدى {s} {r}؟", "ماذا أهدت {s} {r}؟")],
               "rev": ["من أهدى {r} {v}؟"]}},
    "room": {
        "en": {"values": [str(n) for n in range(101, 460)],
               "facts": ["{s}'s office is in room {v}.", "{s} works in room {v}."],
               "fwd": ["Which room is {s}'s office in?", "What is the number of {s}'s room?"],
               "rev": ["Whose office is in room {v}?"]},
        "ar": {"values": [str(n) for n in range(101, 460)],
               "facts": [("مكتب {s} في الغرفة رقم {v}.", "مكتب {s} في الغرفة رقم {v}.")],
               "fwd": [("في أي غرفة مكتب {s}؟", "في أي غرفة مكتب {s}؟"), ("ما رقم غرفة {s}؟", "ما رقم غرفة {s}؟")],
               "rev": ["مكتب من في الغرفة رقم {v}؟"]}},
    "lost": {
        "en": {"values": ["umbrella", "jacket", "notebook", "phone", "hat", "laptop", "glove", "camera bag", "pair of glasses"],
               "facts": ["{s} left a {v} at the cafe.", "{s} forgot a {v} on the train."],
               "fwd": ["What did {s} forget?", "What did {s} leave behind?"],
               "rev": ["Who left a {v} behind?"]},
        "ar": {"values": "مظلة سترة نظارة قبعة محفظة حقيبة".split(),
               "facts": [("نسي {s} {v} في المقهى.", "نسيت {s} {v} في المقهى."), ("ترك {s} {v} في القطار.", "تركت {s} {v} في القطار.")],
               "fwd": [("ماذا نسي {s}؟", "ماذا نسيت {s}؟"), ("ما الشيء الذي تركه {s}؟", "ما الشيء الذي تركته {s}؟")],
               "rev": ["من نسي {v}؟"]}},
}
TRAIN_FAMILIES = ["job", "lives", "instrument", "age", "author", "day", "distance", "food", "teach", "founded"]
HELDOUT_FAMILIES = ["language", "gift", "room", "lost"]

EN_TITLE_A = "Silent Distant Hidden Winter Broken Golden Last Quiet Burning Northern Paper Glass Iron Bitter".split()
EN_TITLE_B = "Harbour Lantern Orchard Mirror Compass Archive Tide Ladder Meadow Signal Valley Furnace Tower".split()
AR_TITLE = ["ظلال المدينة", "الفنار الأخير", "مرآة الشتاء", "بوصلة الرمل", "أرشيف الغياب", "سلّم الريح", "نافذة الغرباء",
            "صيف الحديد", "ملح الذاكرة", "دفتر المطر", "حارس المنارة", "بيت الصدى", "خريطة الضباب", "مدينة الزجاج",
            "قنديل البحر", "طريق القوافل", "أوراق الخريف", "سفر الليل"]
EN_CLUB = ["chess circle", "photography club", "drama group", "film society", "hiking group", "swimming club", "choir",
           "poetry circle", "debate club", "running group", "knitting circle", "astronomy club"]
AR_CLUB = ["نادي التصوير", "فرقة المسرح", "نادي السينما", "فريق المشي", "نادي السباحة", "جوقة الحي", "نادي الشعر",
           "نادي المناظرة", "فريق الجري", "نادي الفلك", "نادي القراءة"]
SYL = "ba ri lo ne sa mo ta ki du ve ra no li sel tor man dar".split()
AR_PLACE = ["قرية المرجان", "بلدة السنديان", "قرية الصفصاف", "بلدة الكروم", "قرية الريحان", "بلدة العقيق", "قرية البيلسان",
            "بلدة الزعتر", "قرية الحجل", "بلدة الأرز", "قرية النعناع", "بلدة الخزامى", "قرية الطيون", "بلدة الجوري"]
EN_ORG_A = ["the Harper", "the Moreland", "the Ashby", "the Coleman", "the Prescott", "the Winslow", "the Thornton", "the Radley"]
EN_ORG_B = ["Trust", "Bank", "Company", "Society", "Press", "Foundation", "Institute"]
AR_ORG = ["شركة الندى", "جمعية الأمل", "مطبعة البيان", "مؤسسة الفجر", "شركة السنابل", "جمعية التراث", "دار المعارف الحديثة",
          "شركة الينابيع", "مؤسسة الضياء", "جمعية الأيادي"]
INTRO = {"en": ["Here are a few facts about some people.", "These notes describe a small group of neighbours.",
                "The following is from a local newsletter.", "Some details about the members of a community centre:"],
         "ar": ["إليك بعض المعلومات عن مجموعة من الناس.", "هذه ملاحظات عن عدد من الجيران.",
                "ما يلي من نشرة محلية.", "تفاصيل عن أعضاء مركز ثقافي:"]}


def en_title(rng):
    return f"{rng.choice(EN_TITLE_A)} {rng.choice(EN_TITLE_B)}"


def en_place(rng):
    return (rng.choice(SYL) + rng.choice(SYL) + rng.choice(["ton", "by", "ford", "wick", "ham", "ley"])).capitalize()


def subjects_for(fam, lang, rng, k):
    kind = FAM[fam][lang].get("subjects")
    if kind == "club":
        return [(x, "m") for x in rng.sample(EN_CLUB if lang == "en" else AR_CLUB, k)]
    if kind == "place":
        if lang == "en":
            out = set()
            while len(out) < k:
                out.add(en_place(rng))
            return [(x, "m") for x in out]
        return [(x, "m") for x in rng.sample(AR_PLACE, k)]
    if kind == "org":
        if lang == "en":
            out = set()
            while len(out) < k:
                out.add(f"{rng.choice(EN_ORG_A)} {rng.choice(EN_ORG_B)}")
            return [(x[0].upper() + x[1:], "m") for x in out]
        return [(x, "m") for x in rng.sample(AR_ORG, k)]
    if lang == "en":
        return [(x, "m") for x in rng.sample(EN_NAMES, k)]
    people = [(n, "m") for n in AR_M] + [(n, "f") for n in AR_F]
    return rng.sample(people, k)


def values_for(fam, lang, rng, k):
    vals = FAM[fam][lang]["values"]
    if vals is None:
        if lang == "en":
            out = set()
            while len(out) < k:
                out.add(en_title(rng))
            return list(out)
        return rng.sample(AR_TITLE, k)
    return rng.sample(vals, k)


def pick_t(tpl, gender):
    if isinstance(tpl, tuple):
        return tpl[1] if gender == "f" and tpl[1] is not None else tpl[0]
    return tpl


def render(t, s, v, r=None):
    return t.format(s=s, v=v, r=r or "")


def recipient(lang, rng, avoid):
    pool = EN_NAMES if lang == "en" else AR_M + AR_F
    return rng.choice([n for n in pool if n not in avoid])


def make_item(rng, lang, families, fillers_from):
    fam = rng.choice(families)
    spec = FAM[fam][lang]
    k = rng.randint(2, 4)
    subs = subjects_for(fam, lang, rng, k + 1)       # one spare for "absent subject" questions
    spare, subs = subs[-1], subs[:-1]
    vals = values_for(fam, lang, rng, k + 1)
    spare_v, vals = vals[-1], vals[:-1]
    used_names = {s for s, _ in subs} | {spare[0]}
    rec = recipient(lang, rng, used_names) if fam == "gift" else None
    if rec:
        used_names.add(rec)
    facts = [render(pick_t(rng.choice(spec["facts"]), g), s, v, rec) for (s, g), v in zip(subs, vals)]
    # fillers: other families, sometimes about the same people (forces reading the relation)
    fill = []
    for _ in range(rng.choice([0, 1, 1, 2])):
        f2 = rng.choice([f for f in fillers_from if f != fam])
        s2 = FAM[f2][lang]
        if s2.get("subjects") is None and FAM[fam][lang].get("subjects") is None and rng.random() < 0.5:
            subj = rng.choice(subs)
        else:
            subj = subjects_for(f2, lang, rng, 1)[0]
        r2 = recipient(lang, rng, used_names | {subj[0]}) if f2 == "gift" else None
        fill.append((f2, subj, render(pick_t(rng.choice(s2["facts"]), subj[1]), subj[0], values_for(f2, lang, rng, 1)[0], r2)))
    sentences = facts + [x[2] for x in fill]
    rng.shuffle(sentences)
    if rng.random() < 0.35:
        joiner = ", and " if lang == "en" else "، و"
        i = rng.randrange(len(sentences) - 1)
        a, b = sentences[i], sentences[i + 1]
        b2 = (b if lang == "ar" or b.startswith(("The ", "Every ")) is False else b[0].lower() + b[1:])
        sentences[i:i + 2] = [a.rstrip(".") + joiner + b2]
    if rng.random() < 0.4:
        sentences.insert(0, rng.choice(INTRO[lang]))
    passage = " ".join(sentences)

    roll = rng.random()
    idx = rng.randrange(k)
    (s, g), v = subs[idx], vals[idx]
    can_rev = bool(spec["rev"])
    if roll < 0.85:
        if can_rev and rng.random() < 0.4:
            q, ans, kind = render(rng.choice(spec["rev"]), s, v, rec), s, "reverse"
        else:
            q, ans, kind = render(pick_t(rng.choice(spec["fwd"]), g), s, v, rec), v, "forward"
    else:
        options = ["absent_subject"]
        if can_rev:
            options.append("absent_value")
        people_fill = [x for x in fill if x[1] in subs]
        if people_fill or (spec.get("subjects") is None):
            options.append("other_relation")
        mode = rng.choice(options)
        if mode == "absent_subject":
            q = render(pick_t(rng.choice(spec["fwd"]), spare[1]), spare[0], v, rec)
        elif mode == "absent_value":
            q = render(rng.choice(spec["rev"]), s, spare_v, rec)
        else:
            # ask a mentioned person about a family that is not stated for them
            other = [f for f in dict.fromkeys(families + fillers_from) if f != fam
                     and FAM[f][lang].get("subjects") is None and f != "gift"]
            stated = {(x[0], x[1][0]) for x in fill}
            choices = [f for f in other if (f, s) not in stated]
            f3 = rng.choice(choices)
            q = render(pick_t(rng.choice(FAM[f3][lang]["fwd"]), g), s, "", None)
        ans, kind = NOT_STATED[lang], "unanswerable:" + mode
    prompt = f"{passage}\n\n{Q[lang]}{q}\n{A[lang]}"
    return {"language": lang, "family": fam, "kind": kind, "passage": passage, "question": q,
            "answer": ans, "prompt": prompt, "target": " " + ans}


def test_vocabulary() -> set[str]:
    items = json.loads((HERE / "items.json").read_text(encoding="utf-8"))
    demos = json.loads((HERE / "demos.json").read_text(encoding="utf-8"))
    words = set()
    caps = re.compile(r"\b[A-Z][a-z]+(?: [A-Z][a-z]+)*\b")
    for it in items["items"] + items["retrieval_distractors"]:
        words |= {w for w in caps.findall(it["passage"]) if w not in {"The", "Three", "Its", "Each", "Today", "In", "A", "Two", "Members", "Children", "Beginners"}}
        if it.get("answer"):
            words.add(it["answer"])
        words |= set(it.get("distractors", []))
    for lang in ("en", "ar"):
        for d in demos[lang]:
            words.add(d["answer"])
            words |= set(caps.findall(d["passage"]))
    # Arabic proper names and places in the test (hand list, from items.json/demos.json)
    words |= set("""حامد عيسى منصور فاطمة زهرة برق ريحان يوسف ليلى كريم رامي مازن جميل أنور هدى هالة وليد جواد منى بلال ريم حسن
سامر ماهر رنا""".split())
    words |= {"وادي السدر", "الرمانة", "العين الزرقاء", "تل الورد", "مدينة الساحل", "حي النخيل", "سوق الحدادين", "مدينة الشروق",
              "ملعب الزيتون", "ساحة المطحنة", "ميدان المحطة", "جزيرة النوارس", "القرنفل", "حي الورود", "ساحة الفرات", "بلدة الجبل"}
    # Day and month names occur in test passages only as background words, never as answers;
    # the "day" family uses them as values, so they are left out of this check on purpose.
    common = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturdays", "Sundays", "March", "October"}
    return {w for w in words if w and w not in common | {"Not stated in the text", "غير مذكور في النص"}}


def leakage(rows, vocab) -> dict:
    hits = {}
    for w in vocab:
        pat = re.compile(r"(?<!\w)" + re.escape(w) + r"(?!\w)")
        n = sum(1 for r in rows if pat.search(r["prompt"]) or pat.search(r["target"]))
        if n:
            hits[w] = n
    items = json.loads((HERE / "items.json").read_text(encoding="utf-8"))
    def grams(t, n=5):
        ws = re.sub(r"[^\w\s]", " ", t.lower()).split()
        return {" ".join(ws[i:i + n]) for i in range(len(ws) - n + 1)}
    test_grams = set()
    for it in items["items"]:
        test_grams |= grams(it["passage"]) | grams(it["question"])
    shared = set()
    for r in rows:
        shared |= grams(r["passage"]) & test_grams
        shared |= grams(r["question"]) & test_grams
    return {"test_words_found": hits, "shared_5grams_with_test": sorted(shared)}


def build(rng, lang, n, families, fillers_from, split, seen):
    out = []
    while len(out) < n:
        r = make_item(rng, lang, families, fillers_from)
        key = r["prompt"]
        if key in seen:
            continue
        seen.add(key)
        r["split"] = split
        r["id"] = hashlib.sha256(key.encode()).hexdigest()[:16]
        out.append(r)
    return out


def main() -> int:
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=False)
    seen: set[str] = set()
    splits = {
        "train": [], "validation": [], "dev_heldout": [],
    }
    for lang in ("en", "ar"):
        splits["train"] += build(random.Random(f"train-{lang}"), lang, 12000, TRAIN_FAMILIES, TRAIN_FAMILIES, "train", seen)
        splits["validation"] += build(random.Random(f"val-{lang}"), lang, 400, TRAIN_FAMILIES, TRAIN_FAMILIES, "validation", seen)
        splits["dev_heldout"] += build(random.Random(f"heldout-{lang}"), lang, 300, HELDOUT_FAMILIES, TRAIN_FAMILIES, "dev_heldout", seen)
    random.Random("shuffle").shuffle(splits["train"])
    vocab = test_vocabulary()
    report = {"counts": {k: len(v) for k, v in splits.items()},
              "train_families": TRAIN_FAMILIES, "heldout_families": HELDOUT_FAMILIES,
              "unanswerable_share": {k: round(sum(r["kind"].startswith("unanswerable") for r in v) / len(v), 3) for k, v in splits.items()},
              "leakage_train": leakage(splits["train"], vocab), "leakage_dev": leakage(splits["dev_heldout"], vocab),
              "heldout_family_in_train": sum(r["family"] in HELDOUT_FAMILIES for r in splits["train"]),
              "test_vocab_size": len(vocab)}
    for name, rows in splits.items():
        with (out / f"{name}.jsonl").open("w", encoding="utf-8", newline="\n") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    (out / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2)[:3000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
