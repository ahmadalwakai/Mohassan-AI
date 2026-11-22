"""Isolated, inactive development experiment for Mohassan's own context router.

Only the two local public MASSIVE locale files and this experiment's authored
JSONL are input sources. No production messages, old router artifacts, assessment
fixtures, external inference or network are read. This module never imports the
old trainer. Authored heldout labels are agent-written and not human validated.

prepare: generate immutable authored data and a split manifest (no training).
train: bounded CPU text-only/context comparison, calibration and frozen reports.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
import random
import re
import struct
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[2]
MASSIVE_DIR = ROOT / ".data/router/download/1.1/data"
AUTHORED = ROOT / "scripts/router/data/context-training-v1.jsonl"
OUTPUT = ROOT / "artifacts/router-context-development-v1"
ROUTES = ("web_search", "browser_command", "news", "memory", "reminder", "compute", "ads", "pc", "writing", "planning", "coding", "chat", "image", "media", "unsupported", "clarify")
ROUTE_ID = {name: index for index, name in enumerate(ROUTES)}
PARTITIONS = ("train", "dev", "calibration", "test")
SOURCES = ("none", "public_lookup", "prior_conversation", "local_state", "supplied_content", "unresolved")
SCOPES = ("none", "public", "private", "unknown")
FIELDS = ("none", "choice", "place", "budget", "time", "text")
CONTEXT_FEATURES = tuple([f"prior_route:{route}" for route in ("none", *ROUTES)]
                         + [f"source:{source}" for source in SOURCES]
                         + [f"scope:{scope}" for scope in SCOPES]
                         + ["pending:false", "pending:true"] + [f"field:{field}" for field in FIELDS])
MAX_TEXT = 512
MAX_LINE_BYTES = 64 * 1024
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_ROWS = 60_000
NEVER_PUBLIC = frozenset(("memory", "reminder", "ads", "pc", "writing", "planning", "coding"))
MODEL_FORMAT = "mohassan-context-b0-v1"

# Conservative public-dataset mapping. Unmapped intents are counted/excluded;
# email sending is not relabelled as drafting, and labels do not grant tools.
MASSIVE_MAPPING = {
    "web_search": ("weather_query", "qa_factoid", "qa_definition", "qa_currency", "qa_stock", "cooking_recipe", "cooking_query", "transport_query", "transport_traffic", "transport_ticket", "recommendation_events", "recommendation_locations", "recommendation_movies", "takeaway_query", "music_query"),
    "news": ("news_query",),
    "memory": ("lists_query", "lists_remove", "lists_createoradd"),
    "reminder": ("alarm_set", "alarm_query", "alarm_remove", "calendar_set", "calendar_query", "calendar_remove"),
    "compute": ("qa_maths", "datetime_query", "datetime_convert"),
    "chat": ("general_quirky", "general_joke", "general_greet"),
    "pc": ("audio_volume_mute", "audio_volume_up", "audio_volume_down", "audio_volume_other"),
    "media": ("play_music", "play_radio", "play_podcasts", "play_audiobook", "play_game", "music_likeness", "music_dislikeness", "music_settings"),
    "unsupported": ("iot_hue_lightoff", "iot_hue_lightchange", "iot_hue_lightup", "iot_hue_lightdim", "iot_hue_lighton", "iot_coffee", "iot_cleaning", "iot_wemo_off", "iot_wemo_on", "takeaway_order", "transport_taxi", "email_query", "email_querycontact", "email_addcontact", "social_query", "email_sendemail", "social_post"),
}
INTENT_MAPPING = {intent: route for route, intents in MASSIVE_MAPPING.items() for intent in intents}


def fold(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[\u0640\u064b-\u065f\u0670]", "", text)
    text = re.sub(r"[أإآٱ]", "ا", text).replace("ى", "ي").replace("ة", "ه")
    text = text.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789"))
    return re.sub(r"\s+", " ", text.lower()).strip()


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def canonical_text(text: str) -> str:
    return " ".join("".join(char if char.isalnum() or char.isspace() else " " for char in fold(text)).split())


def stable(value: str) -> int:
    return int(digest(value)[:8], 16)


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


@dataclass(frozen=True)
class Context:
    prior_route: str = "none"
    source: str = "none"
    scope: str = "none"
    pending: bool = False
    pending_field: str = "none"

    def validate(self) -> None:
        if self.prior_route not in ("none", *ROUTES) or self.source not in SOURCES or self.scope not in SCOPES or self.pending_field not in FIELDS or type(self.pending) is not bool:
            raise ValueError("invalid_context")
        if not self.pending and self.pending_field != "none":
            raise ValueError("field_without_pending_question")
        if self.source in ("prior_conversation", "local_state", "supplied_content") and self.scope != "private":
            raise ValueError("private_source_scope_mismatch")


@dataclass(frozen=True)
class Row:
    id: str
    group_id: str
    text: str
    route: str
    partition: str
    origin: str
    locale: str
    context: Context = Context()

    def validate(self) -> None:
        if not self.id or len(self.id) > 180 or not self.group_id or len(self.group_id) > 180:
            raise ValueError("invalid_row_identity")
        if not self.text.strip() or len(self.text) > MAX_TEXT:
            raise ValueError("invalid_text_bounds")
        if self.route not in (*ROUTES, "reply") or self.partition not in PARTITIONS:
            raise ValueError("invalid_label_or_partition")
        if self.origin not in ("agent_authored_unreviewed", "public_massive_v1.1") or self.locale not in ("ar-SA", "en-US"):
            raise ValueError("invalid_provenance")
        self.context.validate()


def fixed_authored_partition(index: int) -> str:
    # Family assignment is fixed before any measurements. Slot and language
    # variants remain together; authored test is development data, not sealed.
    return "train" if index % 10 < 6 else "dev" if index % 10 == 6 else "calibration" if index % 10 == 7 else "test"


def prior(route: str, pending: bool = False, field: str = "none") -> Context:
    source = "public_lookup" if route in ("web_search", "news", "browser_command") else "local_state" if route == "pc" else "prior_conversation" if route == "memory" else "supplied_content"
    return Context(route, source, "public" if source == "public_lookup" else "private", pending, field)


AUTHORED_SCENARIOS: dict[str, list[tuple[str, str]]] = {
    "web_search": [
        ("What is the weather in Bath this afternoon?", "كيف الطقس في حمص هذا المساء؟"),
        ("Find the official opening hours of the city museum.", "ابحث عن ساعات افتتاح المتحف من موقعه الرسمي."),
        ("How much is a euro worth in Canadian dollars today?", "كم سعر اليورو مقابل الدولار الكندي اليوم؟"),
        ("Why does a rainbow have several colours?", "لماذا يظهر قوس قزح بألوان متعددة؟"),
        ("Who wrote the novel The Moonstone?", "من كتب رواية رجال في الشمس؟"),
        ("When is the next train from Durham to York?", "متى موعد القطار القادم من حلب إلى دمشق؟"),
        ("Compare public information about solar and wind power.", "قارن المعلومات المنشورة عن طاقة الشمس والرياح."),
        ("What documents are required for a library membership?", "ما الأوراق المطلوبة لاشتراك المكتبة العامة؟"),
        ("Where is the public botanical garden located?", "أين تقع الحديقة النباتية العامة؟"),
        ("Explain the difference between a comet and an asteroid.", "اشرح الفرق بين المذنب والكويكب."),
    ],
    "browser_command": [
        ("Open https://museum.example/visits", "افتح https://museum.example/visits"),
        ("Click the second result in the browser.", "اضغط النتيجة الثانية في المتصفح."),
        ("Search Wikipedia for tidal energy.", "ابحث في ويكيبيديا عن طاقة المد والجزر."),
        ("Scroll down the current web page.", "انزل إلى أسفل الصفحة المفتوحة في المتصفح."),
        ("Go back to the preceding browser page.", "ارجع إلى الصفحة السابقة في المتصفح."),
        ("Read the article currently open in the browser.", "اقرأ المقال المفتوح حاليًا في المتصفح."),
        ("Type Bristol into the city field on this page.", "اكتب حمص في خانة المدينة على الصفحة."),
        ("Select French from the website language menu.", "اختر الفرنسية من قائمة لغة الموقع."),
        ("Open the link labelled Visit information.", "افتح الرابط المكتوب عليه معلومات الزيارة."),
        ("Show a screenshot of https://garden.example/", "اعرض لقطة شاشة لموقع https://garden.example/"),
    ],
    "news": [
        ("Summarize today's science headlines.", "لخص أهم أخبار العلوم اليوم."),
        ("Find the latest transport news.", "هات أحدث أخبار النقل."),
        ("What happened in local news this morning?", "شو أهم الأخبار المحلية هذا الصباح؟"),
        ("Show BBC news headlines about the economy.", "اعرض عناوين أخبار بي بي سي عن الاقتصاد."),
        ("Read the main environmental news stories.", "اقرأ أهم أخبار البيئة."),
        ("Collect three current education news reports.", "اجمع ثلاثة تقارير إخبارية حديثة عن التعليم."),
        ("What are the latest space exploration headlines?", "ما آخر عناوين أخبار استكشاف الفضاء؟"),
        ("Give me a brief roundup of cultural news.", "اعطني موجزًا قصيرًا للأخبار الثقافية."),
        ("Find recent public health news articles.", "ابحث عن أخبار الصحة العامة الحديثة."),
        ("Compare today's top business headlines.", "قارن أبرز عناوين أخبار الأعمال اليوم."),
    ],
    "memory": [
        ("What supplier name did I previously tell you?", "ما اسم المورد الذي أخبرتك به سابقًا؟"),
        ("Remember that my preferred meeting day is Wednesday.", "تذكر أن يوم الاجتماع المفضل لدي هو الأربعاء."),
        ("Read my saved workshop address.", "اقرأ عنوان ورشتي المحفوظ."),
        ("What is my recorded membership number?", "ما رقم عضويتي المسجل عندك؟"),
        ("Save this note: the delivery door is on the east side.", "احفظ الملاحظة التالية: باب التسليم في الجهة الشرقية."),
        ("Which colour did I choose for my stationery?", "أي لون اخترته لأوراقي الرسمية بحسب ذاكرتك؟"),
        ("Find the appointment information I shared before.", "استرجع معلومات الموعد الذي شاركته معك من قبل."),
        ("What do my stored notes say about the depot?", "ماذا تقول ملاحظاتي المحفوظة عن المستودع؟"),
        ("Recall the contact code from our earlier conversation.", "استرجع رمز التواصل من محادثتنا السابقة."),
        ("Keep in mind that I prefer invoices in euros.", "احفظ أنني أفضل الفواتير باليورو."),
    ],
    "reminder": [
        ("Remind me to water the plants at eight tomorrow.", "ذكرني بسقي النباتات غدًا الساعة الثامنة."),
        ("Set an alarm for seven on Saturday.", "اضبط منبهًا للساعة السابعة يوم السبت."),
        ("Add a reminder to call the dentist next week.", "أضف تذكيرًا للاتصال بطبيب الأسنان الأسبوع القادم."),
        ("Cancel my afternoon alarm.", "ألغ منبهي بعد الظهر."),
        ("Which reminders do I have for tomorrow?", "ما التذكيرات الموجودة عندي ليوم غد؟"),
        ("Set a timer for eighteen minutes.", "اضبط مؤقتًا لمدة ثماني عشرة دقيقة."),
        ("Schedule a reminder to renew the membership in June.", "ضع تذكيرًا لتجديد العضوية في يونيو."),
        ("Move my reading reminder to nine tonight.", "انقل تذكير القراءة إلى التاسعة الليلة."),
        ("Tell me when my next alarm is set.", "متى موعد المنبه القادم عندي؟"),
        ("Remind me every Friday to check the mailbox.", "ذكرني كل جمعة بفحص صندوق البريد."),
    ],
    "compute": [
        ("Calculate 17 times 23.", "احسب ١٧ ضرب ٢٣."),
        ("What is twelve percent of 650?", "كم اثنا عشر بالمئة من ٦٥٠؟"),
        ("Convert 4.8 kilometres to metres.", "حول ٤٫٨ كيلومتر إلى متر."),
        ("How many days lie between 2024-03-01 and 2024-03-12?", "كم يومًا بين ٢٠٢٤-٠٣-٠١ و٢٠٢٤-٠٣-١٢؟"),
        ("Add 85, 96 and 112.", "اجمع ٨٥ و٩٦ و١١٢."),
        ("Divide 225 by 15.", "اقسم ٢٢٥ على ١٥."),
        ("What is the average of 11, 19 and 27?", "ما متوسط ١١ و١٩ و٢٧؟"),
        ("Convert 150 minutes into hours.", "حول ١٥٠ دقيقة إلى ساعات."),
        ("Find the area of a rectangle 9 metres by 14 metres.", "احسب مساحة مستطيل طوله ٩ أمتار وعرضه ١٤ مترًا."),
        ("What remains after spending 38 out of 120?", "كم يتبقى من ١٢٠ إذا صرفت ٣٨؟"),
    ],
    "ads": [
        ("Prepare search ads for a bicycle repair shop in Bath.", "جهز إعلانات بحث لورشة دراجات في حمص."),
        ("Create a paused campaign for a florist, budget GBP 14 daily.", "أنشئ حملة متوقفة لمحل زهور بميزانية ١٤ جنيهًا يوميًا."),
        ("Write campaign headlines for an appliance repair service.", "اكتب عناوين حملة لخدمة إصلاح الأجهزة."),
        ("Read the performance of my search campaign.", "اقرأ أداء حملة البحث الخاصة بي."),
        ("Suggest negative keywords for a tutoring campaign.", "اقترح كلمات سلبية لحملة دروس خصوصية."),
        ("Draft display ads for a furniture workshop.", "جهز مسودة إعلانات لورشة أثاث."),
        ("Change the draft campaign location to Durham.", "غير موقع مسودة الحملة إلى اللاذقية."),
        ("Check whether these campaign headlines meet the character limits.", "تحقق من حدود أحرف عناوين هذه الحملة."),
        ("Build a lead-generation campaign preview for a cleaning business.", "ابن معاينة حملة لجلب طلبات لخدمة تنظيف."),
        ("Review the landing page before drafting my Google ads.", "راجع صفحة الهبوط قبل إعداد إعلانات جوجل الخاصة بي."),
    ],
    "pc": [
        ("Read the error shown in my shared terminal window.", "اقرأ الخطأ الظاهر في نافذة الطرفية المشتركة."),
        ("What applications are open on my computer?", "ما البرامج المفتوحة على جهازي؟"),
        ("Click the Save button in the shared desktop app.", "اضغط زر الحفظ في تطبيق سطح المكتب المشترك."),
        ("Show the currently visible spreadsheet window.", "اعرض نافذة الجدول الظاهرة حاليًا."),
        ("Open the downloads folder on my PC.", "افتح مجلد التنزيلات على حاسوبي."),
        ("Read the text in the local error dialog.", "اقرأ النص الموجود في مربع الخطأ المحلي."),
        ("Mute the sound on this computer.", "اكتم صوت هذا الكمبيوتر."),
        ("Focus the word processor window already on my desktop.", "انتقل إلى نافذة معالج النصوص المفتوحة على سطح مكتبي."),
        ("What is displayed on my taskbar?", "ماذا يظهر في شريط المهام عندي؟"),
        ("Type Cedar Hall into the focused desktop field.", "اكتب قاعة السرو في الحقل المحدد على سطح المكتب."),
    ],
    "writing": [
        ("Draft an apology letter for a late delivery.", "اكتب رسالة اعتذار عن تأخر التسليم."),
        ("Translate this sentence into Arabic: The garden opens early.", "ترجم هذه الجملة إلى الإنجليزية: تفتح الحديقة مبكرًا."),
        ("Rewrite this note politely: Please return the keys.", "أعد صياغة الملاحظة بلطف: أرجو إعادة المفاتيح."),
        ("Compose a short story about a curious fox.", "ألف قصة قصيرة عن ثعلب فضولي."),
        ("Proofread this sentence: The visitors was happy.", "صحح هذه الجملة: ذهب الطلاب إلى المدرسه."),
        ("Write an invitation for a neighbourhood reading event.", "اكتب دعوة لفعالية قراءة في الحي."),
        ("Summarize the supplied paragraph: Trees provide shade and shelter.", "لخص الفقرة المعطاة: توفر الأشجار الظل والمأوى."),
        ("Draft an email asking the landlord to repair the heater.", "جهز مسودة بريد تطلب إصلاح المدفأة من المالك."),
        ("Create a poem about the winter sea.", "اكتب قصيدة عن البحر في الشتاء."),
        ("Improve the wording of this title: Our new opening times.", "حسن صياغة هذا العنوان: مواعيد افتتاحنا الجديدة."),
    ],
    "planning": [
        ("Plan my work week with time for reading and exercise.", "خطط أسبوع عملي مع وقت للقراءة والرياضة."),
        ("Arrange my tasks for tomorrow morning.", "رتب مهامي لصباح الغد."),
        ("Build a daily schedule for studying three subjects.", "ابن جدولًا يوميًا لدراسة ثلاث مواد."),
        ("Organize my week around two appointments.", "نظم أسبوعي حول موعدين."),
        ("Make a study plan for the coming month.", "اعمل خطة دراسة للشهر القادم."),
        ("Prioritize my tasks and leave room for breaks.", "رتب أولويات مهامي واترك وقتًا للاستراحة."),
        ("Split my project work across the next five days.", "وزع عمل مشروعي على الأيام الخمسة القادمة."),
        ("Plan my day from nine until four.", "خطط يومي من التاسعة حتى الرابعة."),
        ("Create a timetable for my weekly training sessions.", "جهز جدولًا لجلسات تدريبي الأسبوعية."),
        ("Help me organize my morning routine.", "ساعدني على تنظيم روتيني الصباحي."),
    ],
    "coding": [
        ("Fix the failing unit test in my project.", "أصلح اختبار الوحدة الفاشل في مشروعي."),
        ("Add validation to the booking API endpoint.", "أضف التحقق من المدخلات إلى واجهة الحجز البرمجية."),
        ("Review the recent source-code changes.", "راجع التعديلات الأخيرة على الشفرة البرمجية."),
        ("Implement a function that sorts the records by date.", "نفذ دالة ترتب السجلات بحسب التاريخ."),
        ("Run the repository test suite.", "شغل مجموعة اختبارات المستودع البرمجي."),
        ("Refactor the parser without changing its behaviour.", "أعد هيكلة محلل النصوص دون تغيير سلوكه."),
        ("Find the bug causing this TypeScript exception.", "اعثر على الخطأ الذي يسبب استثناء تايب سكريبت."),
        ("Write a Python script to validate the local CSV file.", "اكتب سكريبت بايثون للتحقق من ملف CSV المحلي."),
        ("Add a regression test for the authentication fix.", "أضف اختبار انحدار لإصلاح تسجيل الدخول."),
        ("Explain the implementation of this source function.", "اشرح تنفيذ هذه الدالة في الشفرة المصدرية."),
    ],
    "chat": [
        ("Hello there.", "أهلًا وسهلًا."), ("Thanks for helping.", "شكرًا على المساعدة."),
        ("What is your name?", "ما اسمك؟"), ("Who developed this application?", "من طور هذا التطبيق؟"),
        ("Good morning.", "صباح الخير."), ("How are you doing?", "كيف حالك؟"),
        ("Tell me a friendly joke.", "قل لي نكتة لطيفة."), ("That was helpful, thank you.", "كان ذلك مفيدًا، شكرًا لك."),
        ("Good evening, Mohassan.", "مساء الخير يا موحسن."), ("Introduce yourself briefly.", "عرف بنفسك باختصار."),
    ],
    "image": [
        ("Draw a lighthouse under a violet sky.", "ارسم منارة تحت سماء بنفسجية."),
        ("Create an image of a wooden cabin in snow.", "أنشئ صورة لكوخ خشبي وسط الثلج."),
        ("Design a poster for a fictional gardening club.", "صمم ملصقًا لناد خيالي للبستنة."),
        ("Generate a transparent icon of a paper boat.", "ولد أيقونة شفافة لقارب ورقي."),
        ("Illustrate a fox reading under a tree.", "ارسم ثعلبًا يقرأ تحت شجرة."),
        ("Make a square image of a ceramic teapot.", "اصنع صورة مربعة لإبريق شاي خزفي."),
        ("Draw a simple map of an imaginary island.", "ارسم خريطة بسيطة لجزيرة خيالية."),
        ("Create a book-cover illustration with blue flowers.", "أنشئ رسمة غلاف كتاب بزهور زرقاء."),
        ("Design a logo for a fictional mountain bakery.", "صمم شعارًا لمخبز جبلي خيالي."),
        ("Generate a watercolor picture of a quiet harbour.", "ولد لوحة مائية لمرفأ هادئ."),
    ],
    "media": [
        ("Play a quiet instrumental music track.", "شغل مقطع موسيقى هادئًا بلا غناء."),
        ("Start the next episode of the science podcast.", "شغل الحلقة التالية من بودكاست العلوم."),
        ("Put on the local radio station.", "شغل محطة الإذاعة المحلية."),
        ("Resume the audiobook I was listening to.", "تابع الكتاب الصوتي الذي كنت أسمعه."),
        ("Skip this song.", "تخط هذه الأغنية."),
        ("Pause the current music playback.", "أوقف تشغيل الموسيقى الحالية مؤقتًا."),
        ("Play the next track in the playlist.", "شغل المقطع التالي في قائمة التشغيل."),
        ("Repeat the last podcast episode.", "أعد تشغيل حلقة البودكاست السابقة."),
        ("Open a relaxing nature soundtrack.", "شغل تسجيلًا هادئًا لأصوات الطبيعة."),
        ("Stop the audiobook playback.", "أوقف تشغيل الكتاب الصوتي."),
    ],
    "unsupported": [
        ("Water the plants in my kitchen physically.", "اسق النباتات في مطبخي فعليًا."),
        ("Make a cup of coffee with the kitchen machine.", "حضّر فنجان قهوة بآلة المطبخ."),
        ("Turn off the smart lamp in the hallway.", "أطفئ المصباح الذكي في الممر."),
        ("Book a taxi to my front door.", "احجز سيارة أجرة إلى باب منزلي."),
        ("Pick up the parcel from the shop.", "اذهب لاستلام الطرد من المحل."),
        ("Open the physical garage door.", "افتح باب المرآب الحقيقي."),
        ("Order dinner from the restaurant for delivery.", "اطلب عشاءً من المطعم للتوصيل."),
        ("Carry the heavy box upstairs.", "احمل الصندوق الثقيل إلى الطابق العلوي."),
        ("Change the temperature of my smart thermostat.", "غير درجة حرارة منظم التدفئة الذكي."),
        ("Clean the living room with the robot vacuum.", "نظف غرفة الجلوس بالمكنسة الروبوتية."),
    ],
    "clarify": [
        ("Do the thing I mean.", "اعمل الشيء الذي أقصده."),
        ("Change it somehow.", "غيره بطريقة ما."),
        ("What is its price?", "كم سعره؟"),
        ("Use the other one.", "استخدم الخيار الآخر."),
        ("Can you sort that out?", "تقدر تضبط ذلك؟"),
        ("Send it there.", "أرسله إلى هناك."),
        ("What about that item?", "ماذا عن ذلك الشيء؟"),
        ("Make the usual changes.", "نفذ التعديلات المعتادة."),
        ("I want the same as before.", "أريد نفس الشيء السابق."),
        ("Tell me the result for it.", "قل لي نتيجته."),
    ],
}


def authored_rows() -> list[Row]:
    rows: list[Row] = []
    # Each semantic family includes translations, courtesy variants and unrelated
    # prior-state controls in one fixed partition. No target label is a feature.
    controls = (Context(), prior("memory"), prior("web_search"))
    for route, pairs in AUTHORED_SCENARIOS.items():
        for index, pair in enumerate(pairs):
            group = f"authored:standalone:{route}:{index:02d}"
            for locale, text in zip(("en-US", "ar-SA"), pair):
                variants = (text, ("Please " if locale == "en-US" else "لو سمحت، ") + text)
                for variant, current in enumerate(variants):
                    # Unresolved-reference families have no valid active referent.
                    contexts = (Context(),) if route == "clarify" else controls
                    for context_index, context in enumerate(contexts):
                        rows.append(Row(f"{group}:{locale}:{variant}:{context_index}", group, current, route,
                                        fixed_authored_partition(index), "agent_authored_unreviewed", locale, context))
    # Same words, distinct legitimate sources: all contexts for each paraphrase
    # family are inseparable. These deliberately test context, not keyword memory.
    contrast = [
        ("Where is it located?", "أين موقعه؟"), ("And its address?", "وعنوانه؟"),
        ("What about the opening time?", "وماذا عن موعد الافتتاح؟"), ("What is its name?", "ما اسمه؟"),
        ("Read that information again.", "اقرأ تلك المعلومة مرة أخرى."), ("Give me the details for that one.", "اعطني تفاصيل ذلك الخيار."),
        ("Which place was mentioned?", "أي مكان جرى ذكره؟"), ("Can you show its address?", "ممكن تعرض عنوانه؟"),
        ("Tell me where that is.", "قل لي أين يوجد ذلك."), ("And the contact information?", "ومعلومات التواصل؟"),
    ]
    for index, pair in enumerate(contrast):
        group = f"authored:source-contrast:{index:02d}"
        for locale, text in zip(("en-US", "ar-SA"), pair):
            for route in ("web_search", "memory", "pc"):
                rows.append(Row(f"{group}:{locale}:{route}", group, text, route, fixed_authored_partition(index),
                                "agent_authored_unreviewed", locale, prior(route)))
    # Reply is NOT a learned model class. These rows exercise the host gate only.
    answers = [("Yes", "نعم", "choice"), ("No", "لا", "choice"), ("The first option", "الخيار الأول", "choice"),
               ("18", "١٨", "budget"), ("Bath", "حمص", "place"), ("Tomorrow", "غدًا", "time"),
               ("The second option", "الخيار الثاني", "choice"), ("GBP 22", "٢٢ جنيه", "budget"),
               ("Durham", "حماة", "place"), ("Next Friday", "الجمعة القادمة", "time")]
    for index, (en, ar, field) in enumerate(answers):
        group = f"authored:host-answer:{index:02d}"
        for locale, text in (("en-US", en), ("ar-SA", ar)):
            rows.append(Row(f"{group}:{locale}", group, text, "reply", fixed_authored_partition(index),
                            "agent_authored_unreviewed", locale, prior("ads", True, field)))
    # New explicit requests while a question is pending must not become replies.
    for route in ("compute", "browser_command", "memory", "writing", "reminder"):
        for index, pair in enumerate(AUTHORED_SCENARIOS[route]):
            group = f"authored:standalone:{route}:{index:02d}"
            for locale, text in zip(("en-US", "ar-SA"), pair):
                rows.append(Row(f"{group}:{locale}:pending-control", group, text, route, fixed_authored_partition(index),
                                "agent_authored_unreviewed", locale, prior("ads", True, "budget")))
    for row in rows:
        row.validate()
    return rows


def write_exclusive(path: Path, content: bytes) -> str:
    with path.open("xb") as handle:
        handle.write(content)
    return digest(content)


def write_authored_data(path: Path = AUTHORED) -> dict[str, Any]:
    rows = authored_rows()
    payload = b"".join(canonical_json({**asdict(row), "context": asdict(row.context)}) + b"\n" for row in rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != payload:
            raise ValueError("authored_data_exists_with_different_content")
    else:
        write_exclusive(path, payload)
    return {"path": str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path), "sha256": digest(payload),
            "rows": len(rows), "labelProvenance": "agent-authored, not human-validated", "license": "project-authored synthetic development data"}


def read_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("input_file_too_large")
    with path.open("rb") as handle:
        for line in handle:
            if len(line) > MAX_LINE_BYTES:
                raise ValueError("input_line_too_large")
            if line.strip():
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError("input_row_not_object")
                yield value


def read_authored(path: Path = AUTHORED) -> list[Row]:
    rows = []
    for item in read_jsonl(path):
        if set(item) != {"id", "group_id", "text", "route", "partition", "origin", "locale", "context"}:
            raise ValueError("invalid_authored_fields")
        context = Context(**item["context"])
        row = Row(**{**item, "context": context})
        row.validate()
        if row.origin != "agent_authored_unreviewed" or not row.group_id.startswith("authored:"):
            raise ValueError("authored_provenance_mismatch")
        rows.append(row)
        if len(rows) > MAX_ROWS:
            raise ValueError("too_many_rows")
    return rows


def load_massive(directory: Path = MASSIVE_DIR) -> tuple[list[Row], dict[str, int]]:
    rows: list[Row] = []
    excluded: Counter[str] = Counter()
    for locale in ("ar-SA", "en-US"):
        # Exactly these public input paths are opened; no directory discovery.
        for item in read_jsonl(directory / f"{locale}.jsonl"):
            if item.get("locale") != locale or item.get("partition") not in ("train", "dev", "test"):
                raise ValueError("invalid_massive_locale_or_partition")
            route = INTENT_MAPPING.get(item.get("intent"))
            if route is None:
                excluded["unmapped_public_intent"] += 1
                continue
            text = item.get("utt")
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
                excluded["public_text_bounds"] += 1
                continue
            identity = str(item.get("id", ""))
            if not identity or len(identity) > 80:
                raise ValueError("invalid_massive_identity")
            group = f"massive:{identity}"
            partition = item["partition"]
            if partition == "dev":
                partition = "dev" if stable(f"calibration:{group}") % 2 == 0 else "calibration"
            row = Row(f"{group}:{locale}", group, text, route, partition, "public_massive_v1.1", locale)
            row.validate()
            rows.append(row)
            if len(rows) > MAX_ROWS:
                raise ValueError("too_many_rows")
    return rows, dict(excluded)


def prepare_splits(rows: list[Row], massive_per_route: int = 1000) -> tuple[dict[str, list[Row]], dict[str, Any]]:
    if not rows or len(rows) > MAX_ROWS or not 2 <= massive_per_route <= 5000:
        raise ValueError("invalid_dataset_bounds")
    groups: dict[str, list[Row]] = defaultdict(list)
    seen_ids: set[str] = set()
    for row in rows:
        row.validate()
        if row.id in seen_ids:
            raise ValueError("duplicate_row_id")
        seen_ids.add(row.id)
        groups[row.group_id].append(row)
    for group in groups.values():
        if len({row.partition for row in group}) != 1:
            raise ValueError("group_crosses_fixed_partitions")
    # Exact canonical utterance collisions cannot cross partitions, even with
    # different contexts. Exclude whole implicated families; never move test
    # examples into training or tune labels using another benchmark.
    canonical_groups: dict[str, set[str]] = defaultdict(set)
    feature_labels: dict[str, set[str]] = defaultdict(set)
    feature_groups: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        canonical_groups[digest(canonical_text(row.text))].add(row.group_id)
        signature = digest(canonical_json({"text": canonical_text(row.text), "context": asdict(row.context)}))
        feature_labels[signature].add(row.route)
        feature_groups[signature].add(row.group_id)
    excluded_groups: set[str] = set()
    collisions = 0
    for members in canonical_groups.values():
        if len({groups[group][0].partition for group in members}) > 1:
            excluded_groups.update(members)
            collisions += 1
    inconsistent = 0
    for signature, labels in feature_labels.items():
        if len(labels) > 1:
            excluded_groups.update(feature_groups[signature])
            inconsistent += 1
    eligible = [group for group in groups if group not in excluded_groups]
    selected: list[Row] = []
    counts: Counter[tuple[str, str]] = Counter()
    for name in sorted(eligible, key=lambda value: (groups[value][0].origin == "public_massive_v1.1", stable(value), value)):
        group = groups[name]
        if group[0].origin == "public_massive_v1.1":
            route, partition = group[0].route, group[0].partition
            if len({row.route for row in group}) != 1:
                raise ValueError("public_translation_label_conflict")
            cap = massive_per_route if partition == "train" else max(50, massive_per_route // 3)
            if counts[(partition, route)] + len(group) > cap:
                continue
            counts[(partition, route)] += len(group)
        selected.extend(group)
    splits = {name: sorted([row for row in selected if row.partition == name], key=lambda row: row.id) for name in PARTITIONS}
    assert_no_leakage(splits)
    report = {"inputRows": len(rows), "selectedRows": len(selected), "excludedCollisionGroups": len(excluded_groups),
              "crossPartitionCanonicalCollisions": collisions, "contradictoryFeatureSignatures": inconsistent,
              "excludedGroupHashes": sorted(digest(group) for group in excluded_groups),
              "counts": {name: {"rows": len(part), "groups": len({row.group_id for row in part}),
                         "routes": dict(sorted(Counter(row.route for row in part).items())),
                         "origins": dict(sorted(Counter(row.origin for row in part).items())),
                         "locales": dict(sorted(Counter(row.locale for row in part).items()))} for name, part in splits.items()}}
    return splits, report


def assert_no_leakage(splits: dict[str, list[Row]]) -> None:
    group_partition: dict[str, str] = {}
    utterance_partition: dict[str, str] = {}
    for partition, rows in splits.items():
        if partition not in PARTITIONS:
            raise ValueError("invalid_partition")
        for row in rows:
            if row.partition != partition:
                raise ValueError("row_partition_mismatch")
            text_key = digest(canonical_text(row.text))
            if row.group_id in group_partition and group_partition[row.group_id] != partition:
                raise ValueError("group_leakage")
            if text_key in utterance_partition and utterance_partition[text_key] != partition:
                raise ValueError("canonical_utterance_leakage")
            group_partition[row.group_id] = partition
            utterance_partition[text_key] = partition


ACK = re.compile(r"^(?:yes|no|okay|ok|sure|the (?:first|second|third) option|option [123]|نعم|لا|تمام|موافق|الخيار (?:الاول|الثاني|الثالث)|[123١٢٣])(?:[.!?؟])?$", re.I)
NEW_REQUEST = re.compile(r"^(?:(?:please|لو سمحت)[،,\s]+)?(?:calculate|compute|open|visit|search|write|draft|translate|create|prepare|remember|save|remind|what|where|when|how|why|احسب|افتح|ابحث|اكتب|ترجم|انشي|انشئ|جهز|احفظ|تذكر|ذكرني|ما|كم|كيف|متي|اين|هل)(?:\s|[:،])", re.I)


def host_pending_reply(text: str, context: Context) -> bool:
    """Routing only: a reply cannot authorize approval, dispatch or memory writes."""
    if not context.pending:
        return False
    current = fold(text)
    if NEW_REQUEST.match(current) or re.search(r"[0-9)]\s*[+*/×÷^-]\s*[(0-9]", current):
        return False
    if ACK.fullmatch(current):
        return True
    if context.pending_field == "budget":
        return bool(re.fullmatch(r"(?:(?:gbp|usd|eur|sar|aed|[£$€])\s*)?[0-9]+(?:[.,][0-9]+)?(?:\s*(?:pounds?|dollars?|euros?|جنيه|ريال|درهم))?", current))
    if context.pending_field in ("place", "time", "text"):
        return len(current.split()) <= (16 if context.pending_field == "text" else 4) and not re.search(r"[?!؟:;؛]", current)
    return False


def ngram_ids(text: str, buckets: int) -> list[int]:
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT or buckets < 128 or buckets > 1 << 18 or buckets & (buckets - 1):
        raise ValueError("invalid_feature_bounds")
    marked = f"^{fold(text)}$"
    features = [stable(f"current:c{size}:{marked[index:index + size]}") % buckets for size in (2, 3, 4) for index in range(max(0, len(marked) - size + 1))]
    features.extend(stable(f"current:w:{word}") % buckets for word in marked.strip("^$").split())
    if len(features) > 2048:
        raise ValueError("too_many_features")
    return features or [0]


def context_features(context: Context, enabled: bool = True) -> list[float]:
    context.validate()
    if not enabled:
        return [0.0] * len(CONTEXT_FEATURES)
    active = {f"prior_route:{context.prior_route}", f"source:{context.source}", f"scope:{context.scope}",
              f"pending:{str(context.pending).lower()}", f"field:{context.pending_field}"}
    return [float(feature in active) for feature in CONTEXT_FEATURES]


@dataclass(frozen=True)
class TrainConfig:
    seed: int = 41
    buckets: int = 1 << 16
    dim: int = 32
    hidden: int = 64
    epochs: int = 6
    batch_size: int = 128
    learning_rate: float = 0.08
    threads: int = 4
    max_seconds_per_model: float = 180.0
    memory_limit_mb: int = 2048
    massive_per_route: int = 1000
    max_selective_error: float = 0.10
    min_calibration_accepted: int = 20

    def validate(self) -> None:
        if self.buckets < 128 or self.buckets > 1 << 18 or self.buckets & (self.buckets - 1) or not 4 <= self.dim <= 64 or not 8 <= self.hidden <= 128:
            raise ValueError("invalid_model_bounds")
        if not 1 <= self.epochs <= 12 or not 4 <= self.batch_size <= 256 or not 1 <= self.threads <= 4:
            raise ValueError("invalid_training_bounds")
        if not 0.001 <= self.learning_rate <= 0.2 or not 1 <= self.max_seconds_per_model <= 600 or not 128 <= self.memory_limit_mb <= 2048:
            raise ValueError("invalid_resource_bounds")
        if not 0 < self.max_selective_error < 0.5 or not 1 <= self.min_calibration_accepted <= 10000:
            raise ValueError("invalid_calibration_bounds")
        if self.buckets * self.dim * 4 * 5 > self.memory_limit_mb * 1024 * 1024 // 2:
            raise ValueError("parameter_budget_exceeds_memory_target")


def resident_mb() -> float:
    if os.name == "nt":
        class Counters(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong)] + [(name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        get_process = ctypes.windll.kernel32.GetCurrentProcess
        get_process.restype = ctypes.c_void_p
        get_memory = ctypes.windll.psapi.GetProcessMemoryInfo
        get_memory.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
        get_memory.restype = ctypes.c_int
        process = get_process()
        if get_memory(process, ctypes.byref(counters), counters.cb):
            return counters.WorkingSetSize / 1024 / 1024
        raise RuntimeError("memory_measurement_unavailable")
    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / (1024 * 1024 if sys.platform == "darwin" else 1024)


def build_model(config: TrainConfig):
    import torch
    import torch.nn as nn

    class ContextB0(nn.Module):
        def __init__(self):
            super().__init__()
            self.embedding = nn.EmbeddingBag(config.buckets, config.dim, mode="mean")
            self.projection = nn.Linear(config.dim + len(CONTEXT_FEATURES), config.hidden)
            self.classifier = nn.Linear(config.hidden, len(ROUTES))

        def forward(self, ids, offsets, context):
            text = self.embedding(ids, offsets)
            return self.classifier(torch.relu(self.projection(torch.cat((text, context), dim=1))))

    return ContextB0()


def tensor_batch(rows: list[Row], config: TrainConfig, with_context: bool):
    import torch
    grams = [ngram_ids(row.text, config.buckets) for row in rows]
    offsets, size = [], 0
    for features in grams:
        offsets.append(size)
        size += len(features)
    return (torch.tensor([feature for features in grams for feature in features], dtype=torch.long),
            torch.tensor(offsets, dtype=torch.long),
            torch.tensor([context_features(row.context, with_context) for row in rows], dtype=torch.float32))


def model_logits(model, rows: list[Row], config: TrainConfig, with_context: bool):
    import torch
    model.eval()
    output = []
    with torch.no_grad():
        for start in range(0, len(rows), config.batch_size):
            output.append(model(*tensor_batch(rows[start:start + config.batch_size], config, with_context)))
    return torch.cat(output) if output else torch.empty((0, len(ROUTES)))


def train_model(splits: dict[str, list[Row]], config: TrainConfig, with_context: bool):
    import torch
    import torch.nn.functional as functional
    config.validate()
    torch.set_num_threads(config.threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(config.seed)
    rng = random.Random(config.seed)
    rows = [row for row in splits["train"] if row.route != "reply"]
    dev = [row for row in splits["dev"] if row.route != "reply"]
    if not rows or not dev:
        raise ValueError("train_and_development_partitions_required")
    by_route: dict[str, list[Row]] = defaultdict(list)
    for row in rows:
        by_route[row.route].append(row)
    model = build_model(config)
    optimizer = torch.optim.Adagrad(model.parameters(), lr=config.learning_rate)
    started = time.monotonic()
    best_score, best_state, best_epoch = -1.0, None, 0
    history = []
    peak = resident_mb()
    timed_out = False
    route_names = sorted(by_route)
    for epoch in range(config.epochs):
        model.train()
        # Balanced class resampling is train-only and explicitly reported.
        sampled = [rng.choice(by_route[rng.choice(route_names)]) for _ in rows]
        loss_sum = 0.0
        processed = 0
        for start in range(0, len(sampled), config.batch_size):
            if time.monotonic() - started > config.max_seconds_per_model:
                timed_out = True
                break
            peak = max(peak, resident_mb())
            if peak > config.memory_limit_mb:
                raise RuntimeError("memory_target_exceeded")
            chunk = sampled[start:start + config.batch_size]
            labels = torch.tensor([ROUTE_ID[row.route] for row in chunk])
            logits = model(*tensor_batch(chunk, config, with_context))
            loss = functional.cross_entropy(logits, labels)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            loss_sum += float(loss.item()) * len(chunk)
            processed += len(chunk)
        if not processed:
            break
        dev_logits = model_logits(model, dev, config, with_context)
        labels = torch.tensor([ROUTE_ID[row.route] for row in dev])
        accuracy = float((dev_logits.argmax(1) == labels).float().mean().item())
        history.append({"epoch": epoch + 1, "loss": loss_sum / processed, "devAccuracy": accuracy, "processedRows": processed})
        print(json.dumps({"model": "context" if with_context else "text_only", **history[-1]}, ensure_ascii=False), flush=True)
        if accuracy > best_score:
            best_score, best_epoch = accuracy, epoch + 1
            best_state = {name: value.detach().clone() for name, value in model.state_dict().items()}
        if timed_out:
            break
    if best_state is None:
        raise RuntimeError("training_budget_expired_before_checkpoint")
    model.load_state_dict(best_state)
    return model, {"bestEpoch": best_epoch, "history": history, "seconds": time.monotonic() - started,
                   "memoryObservedPeakMB": max(peak, resident_mb()), "timedOut": timed_out,
                   "parameters": sum(value.numel() for value in model.parameters()), "trainSampling": "uniform route, with-replacement within route; train only"}


def wilson_upper(errors: int, total: int, z: float = 1.96) -> float:
    if not total:
        return 1.0
    rate = errors / total
    return (rate + z * z / (2 * total) + z * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total))) / (1 + z * z / total)


def fit_calibration(logits, labels: list[int], config: TrainConfig) -> dict[str, Any]:
    import torch
    import torch.nn.functional as functional
    if len(labels) != len(logits) or not labels:
        raise ValueError("calibration_partition_required")
    target = torch.tensor(labels)
    temperatures = (0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0)
    losses = [(float(functional.cross_entropy(logits / temperature, target).item()), temperature) for temperature in temperatures]
    nll, temperature = min(losses)
    probability = torch.softmax(logits / temperature, dim=1)
    confidence, prediction = probability.max(dim=1)
    best = {"threshold": 1.000001, "accepted": 0, "errors": 0, "wilsonUpperError95": 1.0}
    for threshold in sorted(set(float(value) for value in confidence.tolist())):
        mask = confidence >= threshold
        accepted = int(mask.sum().item())
        errors = int(((prediction != target) & mask).sum().item())
        upper = wilson_upper(errors, accepted)
        if accepted >= config.min_calibration_accepted and upper <= config.max_selective_error and accepted > best["accepted"]:
            best = {"threshold": threshold, "accepted": accepted, "errors": errors, "wilsonUpperError95": upper}
    return {"temperature": temperature, "calibrationNLL": nll, **best,
            "targetSelectiveError": config.max_selective_error, "partition": "calibration", "notProductionCalibrated": True}


def score(model, rows: list[Row], config: TrainConfig, with_context: bool, calibration: dict[str, Any]) -> dict[str, Any]:
    import torch
    logits = model_logits(model, rows, config, with_context)
    probability = torch.softmax(logits / calibration["temperature"], dim=1)
    confidence, predictions = probability.max(dim=1) if rows else (torch.empty(0), torch.empty(0, dtype=torch.long))
    routes = ["reply" if host_pending_reply(row.text, row.context) else ROUTES[int(pred)] for row, pred in zip(rows, predictions)]
    accepted = [host_pending_reply(row.text, row.context) or float(value) >= calibration["threshold"] for row, value in zip(rows, confidence)]
    correct = [pred == row.route for pred, row in zip(routes, rows)]
    per_route = {}
    f1s = []
    for route in (*ROUTES, "reply"):
        support = sum(row.route == route for row in rows)
        tp = sum(row.route == route and pred == route for row, pred in zip(rows, routes))
        predicted = routes.count(route)
        precision = tp / predicted if predicted else 0.0
        recall = tp / support if support else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        if support:
            f1s.append(f1)
        per_route[route] = {"support": support, "predicted": predicted, "correct": tp, "accuracy": recall, "f1": f1}
    def subgroup(attribute):
        values = sorted({attribute(row) for row in rows})
        return {value: {"rows": sum(attribute(row) == value for row in rows),
                        "correct": sum(attribute(row) == value and right for row, right in zip(rows, correct))} for value in values}
    selected_count = sum(accepted)
    selected_correct = sum(keep and right for keep, right in zip(accepted, correct))
    forbidden = sum(row.route in NEVER_PUBLIC and pred in ("web_search", "news") for row, pred in zip(rows, routes))
    selected_forbidden = sum(keep and row.route in NEVER_PUBLIC and pred in ("web_search", "news") for row, pred, keep in zip(rows, routes, accepted))
    bins = []
    for index in range(10):
        members = [offset for offset, value in enumerate(confidence) if rows[offset].route != "reply" and routes[offset] != "reply"
                   and index / 10 <= float(value) <= (index + 1) / 10 and (index == 9 or float(value) < (index + 1) / 10)]
        if members:
            bins.append({"count": len(members), "confidence": sum(float(confidence[offset]) for offset in members) / len(members),
                         "accuracy": sum(correct[offset] for offset in members) / len(members)})
    return {"rows": len(rows), "rawExactRouteAccuracy": sum(correct) / max(1, len(rows)), "macroF1": sum(f1s) / max(1, len(f1s)),
            "perRoute": per_route, "byOrigin": subgroup(lambda row: row.origin), "byLocale": subgroup(lambda row: row.locale),
            "byPriorSource": subgroup(lambda row: row.context.source),
            "coverage": selected_count / max(1, len(rows)), "accepted": selected_count,
            "selectiveAccuracy": selected_correct / selected_count if selected_count else None,
            "rawPrivateToPublic": forbidden, "acceptedPrivateToPublic": selected_forbidden,
            "hostReplyExpected": sum(row.route == "reply" for row in rows), "hostReplyPredicted": routes.count("reply"),
            "hostReplyWrong": sum(pred == "reply" and row.route != "reply" for row, pred in zip(rows, routes)),
            "ece10": sum(item["count"] * abs(item["confidence"] - item["accuracy"]) for item in bins) / max(1, sum(item["count"] for item in bins)),
            "eceScope": "learned decisions only; host replies excluded",
            "confidenceBins": bins,
            "predictionHashes": [{"rowHash": digest(row.id), "expected": row.route, "predicted": pred, "confidence": float(value), "accepted": keep}
                                 for row, pred, value, keep in zip(rows, routes, confidence, accepted)]}


def export_model(model, config: TrainConfig, with_context: bool, rows: list[Row]) -> dict[str, bytes]:
    import numpy as np
    layout, pieces, offset = [], [], 0
    for name, value in model.state_dict().items():
        array = value.detach().cpu().numpy().astype("<f4")
        blob = array.tobytes()
        layout.append({"name": name, "shape": list(array.shape), "offsetBytes": offset, "lengthBytes": len(blob)})
        pieces.append(blob)
        offset += len(blob)
    weights = b"".join(pieces)
    header = {"format": MODEL_FORMAT, "active": False, "routes": ROUTES, "config": asdict(config), "withContext": with_context,
              "contextFeatures": CONTEXT_FEATURES, "dtype": "float32-little-endian", "layout": layout, "sha256": digest(weights),
              "featureSpec": {"fold": "NFC Arabic marks/hamza/maqsura/ta-marbuta+Arabic/Persian digits; lowercase whitespace", "hash": "SHA256 first32bits big-endian modulo power-of-two buckets", "namespace": "current", "characterNgrams": [2, 3, 4], "wordNgrams": True, "aggregation": "mean"}}
    parity_rows = [row for row in rows if row.origin == "agent_authored_unreviewed" and row.route != "reply"][:12]
    logits = model_logits(model, parity_rows, config, with_context).tolist()
    parity = [{"text": row.text, "context": asdict(row.context), "featureIds": ngram_ids(row.text, config.buckets), "logits": values} for row, values in zip(parity_rows, logits)]
    # Independent NumPy inference checks raw layout, mean pooling and both heads.
    for row, expected in zip(parity_rows, logits):
        actual = exported_logits(header, weights, row)
        if not np.allclose(actual, expected, rtol=1e-5, atol=1e-5):
            raise RuntimeError("export_parity_failed")
    return {"weights.bin": weights, "model.json": canonical_json(header), "parity.json": canonical_json(parity)}


def exported_logits(header: dict[str, Any], weights: bytes, row: Row) -> list[float]:
    import numpy as np
    if header.get("format") != MODEL_FORMAT or digest(weights) != header.get("sha256"):
        raise ValueError("invalid_export_identity")
    values = {}
    for field in header["layout"]:
        start, length = field["offsetBytes"], field["lengthBytes"]
        if start < 0 or length < 0 or start + length > len(weights):
            raise ValueError("invalid_export_layout")
        values[field["name"]] = np.frombuffer(weights[start:start + length], dtype="<f4").reshape(field["shape"])
    text = values["embedding.weight"][ngram_ids(row.text, header["config"]["buckets"])].mean(0)
    features = np.concatenate((text, np.asarray(context_features(row.context, header["withContext"]), dtype=np.float32)))
    hidden = np.maximum(values["projection.weight"] @ features + values["projection.bias"], 0)
    return (values["classifier.weight"] @ hidden + values["classifier.bias"]).tolist()


def create_run_directory(name: str | None = None, output: Path = OUTPUT) -> Path:
    name = name or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", name):
        raise ValueError("invalid_run_name")
    base = output.resolve()
    target = (base / name).resolve()
    if target.parent != base:
        raise ValueError("output_path_escape")
    base.mkdir(parents=True, exist_ok=True)
    target.mkdir(exist_ok=False)
    return target


def snapshot_manifest(splits: dict[str, list[Row]], report: dict[str, Any], config: TrainConfig, inputs: list[dict[str, Any]], implementation: list[dict[str, str]] | None = None) -> dict[str, Any]:
    assignments = [{"rowIdHash": digest(row.id), "groupIdHash": digest(row.group_id), "textCanonicalHash": digest(canonical_text(row.text)),
                    "inputHash": digest(canonical_json({"text": row.text, "context": asdict(row.context)})), "partition": partition,
                    "route": row.route, "origin": row.origin, "locale": row.locale} for partition, rows in splits.items() for row in rows]
    return {"format": "context-router-development-manifest-v1", "active": False, "createdAt": datetime.now(timezone.utc).isoformat(),
            "provenance": {"authored": "agent-authored labels, not human-validated", "public": "Amazon MASSIVE v1.1, ar-SA/en-US, CC BY 4.0; mapped intents", "ownerMessagesUsed": False, "assessmentFixturesRead": False, "externalModelsUsed": False},
            "config": asdict(config), "inputs": inputs, "implementation": implementation or [], "splits": report, "assignments": assignments,
            "datasetAssignmentHash": digest(canonical_json(assignments)),
            "evaluationPolicy": {"checkpointSelection": "dev only", "temperatureAndAbstention": "calibration only", "test": "one predeclared text-only/context comparison, no adoption or tuning on this test", "authoredTestIsSealed": False}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "train"))
    parser.add_argument("--run-name")
    parser.add_argument("--no-massive", action="store_true")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--massive-per-route", type=int, default=1000)
    parser.add_argument("--max-seconds-per-model", type=float, default=180.0)
    parser.add_argument("--seed", type=int, default=41)
    args = parser.parse_args()
    config = TrainConfig(epochs=args.epochs, threads=args.threads, massive_per_route=args.massive_per_route,
                         max_seconds_per_model=args.max_seconds_per_model, seed=args.seed)
    config.validate()
    authored_info = write_authored_data()
    rows = read_authored()
    inputs = [authored_info]
    public_excluded = {}
    if not args.no_massive:
        public, public_excluded = load_massive()
        rows.extend(public)
        for locale in ("ar-SA", "en-US"):
            path = MASSIVE_DIR / f"{locale}.jsonl"
            inputs.append({"path": str(path.relative_to(ROOT)), "sha256": digest(path.read_bytes()), "origin": "public_massive_v1.1", "license": "CC BY 4.0"})
    splits, split_report = prepare_splits(rows, config.massive_per_route)
    split_report["publicExcluded"] = public_excluded
    run = create_run_directory(args.run_name)
    implementation = []
    checksums = {}
    for source in (Path(__file__).resolve(), Path(__file__).with_name("test_train_context.py").resolve()):
        payload = source.read_bytes()
        artifact = f"source-{source.name}"
        checksums[artifact] = write_exclusive(run / artifact, payload)
        implementation.append({"path": str(source.relative_to(ROOT)), "artifact": artifact, "sha256": digest(payload), "capture": "before-training"})
    manifest = snapshot_manifest(splits, split_report, config, inputs, implementation)
    checksums["manifest.json"] = write_exclusive(run / "manifest.json", canonical_json(manifest))
    print(json.dumps({"run": str(run.relative_to(ROOT)), "counts": split_report["counts"], "assignmentHash": manifest["datasetAssignmentHash"]}, ensure_ascii=False), flush=True)
    report: dict[str, Any] = {"active": False, "command": args.command, "assignmentHash": manifest["datasetAssignmentHash"], "limitations": ["Authored labels are agent-written and not human-validated.", "Public intent mapping is a development approximation, not an execution grant.", "No production or owner messages or separate assessment fixture was read.", "No current router weights or application behavior were changed.", "Results describe exact routing and selective coverage, not general intelligence."]}
    if args.command == "train":
        import torch
        report["runtime"] = {"python": sys.version.split()[0], "torch": torch.__version__, "device": "cpu", "threads": config.threads}
        for with_context in (False, True):
            name = "context" if with_context else "text_only"
            model, training = train_model(splits, config, with_context)
            calibration_rows = [row for row in splits["calibration"] if row.route != "reply"]
            calibration = fit_calibration(model_logits(model, calibration_rows, config, with_context), [ROUTE_ID[row.route] for row in calibration_rows], config)
            scores = {partition: score(model, splits[partition], config, with_context, calibration) for partition in ("dev", "calibration", "test")}
            report[name] = {"training": training, "calibration": calibration, "scores": scores}
            for filename, payload in export_model(model, config, with_context, splits["train"]).items():
                artifact = f"{name}-{filename}"
                checksums[artifact] = write_exclusive(run / artifact, payload)
            import io
            checkpoint = io.BytesIO()
            torch.save({"format": MODEL_FORMAT, "state": model.state_dict(), "config": asdict(config), "withContext": with_context, "routes": ROUTES, "assignmentHash": manifest["datasetAssignmentHash"], "active": False}, checkpoint)
            checksums[f"{name}-checkpoint.pt"] = write_exclusive(run / f"{name}-checkpoint.pt", checkpoint.getvalue())
            checksums[f"{name}-calibration.json"] = write_exclusive(run / f"{name}-calibration.json", canonical_json(calibration))
            print(json.dumps({"model": name, "testAccuracy": scores["test"]["rawExactRouteAccuracy"], "testCoverage": scores["test"]["coverage"], "testSelectiveAccuracy": scores["test"]["selectiveAccuracy"], "rawPrivateToPublic": scores["test"]["rawPrivateToPublic"], "acceptedPrivateToPublic": scores["test"]["acceptedPrivateToPublic"]}), flush=True)
    checksums["report.json"] = write_exclusive(run / "report.json", canonical_json(report))
    write_exclusive(run / "checksums.json", canonical_json(checksums))
    print(json.dumps({"completed": str(run.relative_to(ROOT)), "files": len(checksums) + 1, "active": False}), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
