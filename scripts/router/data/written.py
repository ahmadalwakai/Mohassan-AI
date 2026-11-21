"""Sentences written by Claude Code (2026-11-20) for routes MASSIVE does not cover.

Owner instruction: «ابحث و حمل من النت و اكتب انت». None of them reuse the owner's real
messages (those stay sealed for the test). Run: python scripts/router/data/written.py
"""
import json
from pathlib import Path

W = {
    "ads": [
        "اعمل لي حملة إعلانية لمطعمي في الرياض بميزانية 50 ريال يومياً", "أبي إعلانات لمحل الحلويات حقي في جدة",
        "سوّ لي حملة قوقل لمحل تصليح جوالات في دبي", "بدي اعلان لمحلي للورد بعمّان، ميزانيتي ١٠ دنانير باليوم",
        "عايز أعمل إعلان على جوجل لعيادة الأسنان بتاعتي في القاهرة", "روّج لمتجري الإلكتروني للعطور، أبغى مبيعات",
        "ابنِ لي حملة بحث لشركة تنظيف منازل في الكويت", "أريد زيادة اتصالات العملاء لورشة السيارات عن طريق إعلانات جوجل",
        "جهّز حملة لخدمة نقل الأثاث في الشارقة بميزانية 30 درهم", "اعلن عن مكتب المحاماة في بيروت، الهدف تعبئة نموذج التواصل",
        "Launch a search campaign for my bakery in Birmingham, 12 pounds a day", "Promote my yoga studio in Liverpool, I want class bookings",
        "Get me more customers for my car wash in Newcastle with Google ads", "I need ads for my roofing company in Sheffield, budget 40 a day",
        "Advertise my pet grooming shop in Nottingham", "Set up a Google Ads campaign for a wedding photographer in Brighton",
        "Create search ads for an electrician in Belfast, goal is phone calls", "Can you make a campaign for my florist, area Oxford, 8 pounds daily",
        "Start advertising my driving school in Leicester", "Build ads for my cafe, I want more people walking in, Aberdeen",
        "حملة لمحل إطارات في الدمام، أبي مكالمات", "ابغى اعلن عن صالون الحلاقة حقي",
        "عندي مطبعة في الإسكندرية وعايز عملاء أكتر من جوجل", "سوي اعلانات لعيادة تجميل بالرياض ٢٠٠ ريال بالأسبوع",
        "اعمل اعلان لمتجر الملابس بتاعي أونلاين", "Run ads for my accounting firm in Leeds, 300 a month",
        "Advertise mobile mechanic services in Coventry, leads please", "Make a PPC campaign for my tutoring centre in Reading",
        "I want Google ads for my takeaway in Bradford", "Get bookings for my nail salon through ads, budget 10 pounds",
        "ميزانية الحملة خمسين ريال يومياً والهدف زيارات المتجر", "أعد صياغة إعلانات حملتي لتكون أقوى",
        "ارفع ميزانية حملة المطعم إلى 80", "أوقف حملة الإعلانات الحالية", "Pause my current Google Ads campaign",
        "Increase the daily budget of my campaign to 25", "Write better headlines for my Google ads",
        "Check why my ads are not getting clicks", "كيف أداء إعلاناتي هذا الأسبوع", "Show me how my campaign performed yesterday",
        "اعمل كلمات مفتاحية لحملة محل الأثاث", "Add negative keywords to my plumbing campaign", "أضف كلمات سلبية لحملة السباكة",
        "اقترح لي عناوين إعلانات لمحل القهوة", "Target my ads only to people in Glasgow and Paisley",
        "خلّ الإعلان يظهر بس في الرياض والخرج", "Make an ad for my carpet cleaning business", "بدي حملة لمطعم شاورما بدمشق",
        "ابغى حملة جوجل لمكتب عقار", "Promote my gym membership offer with Google ads",
    ],
    "browser_command": [
        "افتح موقع أمازون", "روح على يوتيوب وابحث عن تعلم البرمجة", "افتح جيت هب", "ادخل على موقع البنك الأهلي", "افتح تويتر",
        "افتح الرابط هذا https://news.ycombinator.com", "روح لموقع ويكيبيديا وابحث عن ابن سينا", "اضغط على أول نتيجة",
        "افتح النتيجة الثالثة", "ارجع للصفحة اللي قبل", "انزل تحت شوي", "اقرأ لي الصفحة", "لخص الصفحة المفتوحة",
        "اكتب محمد في خانة الاسم", "اضغط زر البحث", "سكّر الإعلان اللي طالع", "افتح موقع نون وابحث عن سماعات",
        "خذ لقطة شاشة للصفحة", "Open bbc.co.uk", "Go to github and search for react hooks", "Open the second link",
        "Click on Sign in", "Scroll down", "Go back", "Read this page for me", "Take a screenshot of the page",
        "Type London in the city field", "Open amazon.co.uk and search for kettles", "Visit stackoverflow.com",
        "Open https://developer.mozilla.org and click Blog", "في المتصفح افتح جوجل", "افتح الموقع وخذ صورة له",
        "ادخل على الصفحة الرئيسية لموقع الجزيرة", "افتح يوتيوب", "شغّل موقع نتفلكس", "افتح الصفحة التالية", "اقرأ المزيد",
        "افتح موقع وزارة الصحة السعودية", "Open linkedin", "Open the first video", "اضغط على تسجيل الدخول",
        "افتح https://www.example.org/pricing", "Press enter", "Select English from the language menu",
        "اختار اللغة العربية من القائمة", "Go to the cart", "روح للسلة", "افتح الخيار الثاني", "Close this tab",
        "Open a new tab with google",
    ],
    "reply": [
        "موافق", "تمام كمل", "كمّل", "أكمل", "نعم تابع", "لا وقف", "توقف", "خلاص", "الغ", "ألغِ العملية", "تخطى", "سويتها",
        "دخلت الحساب", "سجلت الدخول", "خلصت", "تم", "حلّيت الكابتشا", "جربت وما زبط", "مرة ثانية", "جرّب طريقة ثانية",
        "الخيار الأول", "رقم ٢", "الثاني", "ايوه", "اي", "لا", "yes go ahead", "continue", "ok do it", "stop", "cancel that",
        "skip", "done", "I signed in", "I solved the captcha", "try again", "the first one", "option 2", "no", "yes",
        "1. مطعم 2. الرياض 3. مكالمات", "الميزانية ٢٠ والهدف حجوزات", "Budget 15, goal calls, area Leeds", "أكمل في المتصفح",
        "approve",
    ],
    "image": [
        "صمم لي شعار لمحل قهوة", "ارسم صورة قطة على القمر", "سوّ لي صورة لسيارة رياضية حمراء", "اعمل لوجو لشركتي باللون الأزرق",
        "أبي صورة غلاف لحسابي في انستقرام", "صمم بوستر لعرض رمضان", "Generate an image of a mountain at sunset", "Draw a cartoon dog",
        "Make a logo for my bakery", "Create a poster for a summer sale", "design a banner 1200x628", "make it darker",
        "خلي الخلفية بيضاء", "كبّر الشعار شوي", "بدّل اللون للأخضر", "Make the text bigger", "حجم ١٠٨٠ في ١٠٨٠",
        "PNG بخلفية شفافة", "Can you make pictures?", "تقدر تصمم صور؟", "اعمل صورة منتج لزجاجة عطر", "Create an icon for my app",
        "ارسم خريطة ذهنية عن التسويق", "Generate a thumbnail for my YouTube video", "صمم كرت شخصي",
    ],
    "pc": [
        "وش البرامج المفتوحة عندي", "سكّر برنامج الوورد", "افتح المفكرة على الجهاز", "كم مساحة القرص الصلب الفاضية", "ارفع الصوت",
        "وطّي الصوت", "اكتم الصوت", "شغل الآلة الحاسبة", "افحص الكود في مشروع الخادم", "شغّل الاختبارات في المشروع",
        "وين الخطأ في هذا الملف", "أصلح الخطأ البرمجي في صفحة تسجيل الدخول", "اعمل commit للتعديلات", "كم مشروع برمجة عندي",
        "افتح مجلد التنزيلات", "What windows are open on my PC", "Close Excel", "Turn the volume up", "Mute the sound",
        "Run the tests in the server project", "Fix the bug in the login page", "Show me my coding projects",
        "Open the downloads folder", "How much free disk space do I have", "Restart the dev server", "حط الشاشة على الوضع الليلي",
        "خذ لقطة من شاشة الكمبيوتر", "افتح الطرفية وشغّل npm install", "List the files in the project folder", "Review my last code change",
    ],
    "memory": [
        "هل تتذكر اسم شركتي", "وش قلت لك عن عميلي أحمد", "تذكر أن موعد التسليم يوم الخميس", "احفظ أن رقم الطلب 4521",
        "ما هي ملاحظاتي عن مشروع المطعم", "وش آخر شي حفظته", "انسَ رقم الطلب", "أضف حليب لقائمة المشتريات", "اعرض قائمة المهام",
        "احذف البيض من القائمة", "Remember that my wife's birthday is in March", "What did I tell you about the supplier",
        "Save this: the wifi password is in the drawer", "What's on my shopping list", "Add bread to my list",
        "Forget what I said about the meeting", "Do you remember my company name", "What notes do I have about Glasgow",
        "سجل عندك إني ما أحب الاجتماعات الصبح", "وش تعرف عني",
    ],
    "writing": [
        "اكتب لي رسالة اعتذار لعميل", "ترجم هذي الجملة للإنجليزي: شكراً على تعاونكم", "صيغ لي بوست لينكدإن عن إنجازي",
        "اكتب قصة قصيرة للأطفال عن الصدق", "حسّن هذا النص", "صحح الأخطاء الإملائية في رسالتي", "اكتب وصف منتج لساعة يد",
        "Translate this to Arabic: see you tomorrow", "Write a cover letter for a sales job",
        "Draft an email to my landlord about the heating", "Rewrite this paragraph to sound professional",
        "Write a poem about the sea", "Summarise this text for me", "اكتب خطاب رسمي للبلدية", "ألّف لي تغريدة عن يوم الجمعة",
    ],
    "web_search": [
        "وش أخبار سعر الذهب", "كم سعر البنزين اليوم", "متى يفتح الدوام في الجوازات", "وين أقرب محطة بنزين",
        "مين فاز بالدوري السعودي السنة اللي فاتت", "كم عدد سكان مصر", "شو أفضل جوال بالفئة المتوسطة", "كيف الجو بكرة في جدة",
        "وش يعني مصطلح التضخم", "قديش سعر الدولار بلبنان", "أفضل مطاعم مندي في الرياض", "ايش هي عاصمة كندا",
        "How tall is the Burj Khalifa", "Best budget laptop 2026", "When is the next train from Leeds to York",
        "Who is the CEO of Tesla", "Is it going to rain in Manchester tomorrow", "How much is a pound in euros",
        "What's the population of Scotland", "Reviews of the new Toyota Corolla", "ما هي أعراض نقص فيتامين د", "طريقة عمل الكبسة",
        "How do I renew my UK passport", "وش أفضل وقت لزيارة تركيا", "تذاكر طيران من الرياض لإسطنبول",
        "Cheapest flights to Dubai in December", "مواعيد صلاة الفجر في مكة", "Who won the match last night", "معلومات عن الخوارزمي",
        "What is quantum computing",
    ],
    "chat": [
        "وش اسمك", "مين صممك", "أنت ذكي؟", "وش تقدر تسوي", "كيفك اليوم", "صباح الخير", "مساء النور", "شكراً لك", "تسلم",
        "الله يعطيك العافية", "احكي لي نكتة", "ضحكني", "أنا زعلان اليوم", "هل أنت إنسان", "What can you do", "Who made you",
        "Tell me a joke", "Good morning", "Thanks a lot", "Are you better than ChatGPT", "I'm bored", "How are you doing",
        "ممكن تساعدني", "what's your name",
    ],
    "news": [
        "وش آخر الأخبار", "أخبار الرياضة اليوم", "اعطني عناوين سكاي نيوز", "أهم أخبار الاقتصاد",
        "Latest headlines from the Guardian", "What's in the news", "أخبار السعودية اليوم", "Top tech news today",
    ],
}

# Second batch (same day), after the first B0 run showed ~36 training rows per Mohassan-only route was too few.
# Written fresh, not copied from the held-out fifth, so the dev score stays honest.
MORE = {
    "browser_command": [
        "افتح لي موقع سوق دوت كوم", "روح على موقع الخطوط السعودية", "ادخل على انستقرام", "افتح فيسبوك", "افتح الرابط اللي أرسلته",
        "اضغط على الزر الأزرق", "اضغط على كلمة التالي", "انقر على رابط الأسعار", "اختر المقاس الكبير من القائمة", "اكتب الإيميل في الخانة",
        "عبّي خانة رقم الجوال", "مرر للأسفل حتى آخر الصفحة", "اطلع لفوق", "رجّعني للصفحة الرئيسية", "حدّث الصفحة",
        "وش مكتوب في الصفحة", "اعرض لي محتوى الصفحة", "افتح الرابط الرابع", "ادخل على أول فيديو", "سكّر النافذة المنبثقة",
        "ارفض ملفات الارتباط", "اقبل الكوكيز", "Open the BBC website", "Go to youtube.com", "Open my bank's website",
        "Click the blue button", "Tap on Next", "Click the pricing link", "Choose large from the size menu", "Fill in my email in that box",
        "Scroll to the bottom", "Scroll up a bit", "Refresh the page", "What does this page say", "Show me what's on the page",
        "Open the fourth result", "Dismiss the popup", "Reject the cookies", "Accept cookies", "Open facebook.com",
        "Go to the homepage", "Open the link in a new tab", "Search this site for returns policy", "ابحث في الموقع عن سياسة الإرجاع",
        "Zoom into the page", "Download the PDF on this page", "حمّل الملف اللي في الصفحة", "Copy the link of this page",
    ],
    "reply": [
        "ماشي", "اوكي", "اوك كمل", "يلا", "يلا كمل", "تمام", "طيب", "لا لا وقف", "بس خلاص", "سو اللي قلت لك", "نفذ",
        "نعم نفذ", "اعتمد", "أوافق", "ما أوافق", "رفض", "خذ الخيار الثاني", "الأول", "الثالث", "رقم واحد", "دخلت",
        "فتحت الحساب", "أكملت التحقق", "وصلني الكود وحطيته", "ما وصلني كود", "حاول مرة ثانية", "خله", "كنسل", "sure",
        "go on", "proceed", "keep going", "yep", "nope", "abort", "never mind", "the third one", "number one", "I'm logged in",
        "I entered the code", "didn't work, retry", "approved", "reject", "1) cafe 2) Leeds 3) bookings",
        "الهدف مبيعات والمنطقة جدة", "skip this step",
    ],
    "image": [
        "ارسم لي منظر بحر وقت الغروب", "صمم شعار بحروف عربية لاسم نور", "سوّ صورة كرتونية لولد يلعب كورة", "اعمل تصميم دعوة زواج",
        "صمم لي ستوري انستقرام لعرض خصم", "أبغى صورة خلفية للجوال", "ارسم أيقونة لتطبيق توصيل", "اعمل صورة رمزية لحسابي",
        "Draw a robot reading a book", "Design a wedding invitation card", "Make an Instagram story for a 20% sale",
        "Generate a phone wallpaper with mountains", "Create an avatar for my profile", "Make a flyer for my bakery opening",
        "Draw a map of the Middle East in flat style", "make the logo round", "use gold colour instead", "remove the background",
        "خلي الخط أعرض", "غيّر الخلفية لصورة سماء", "صغّر الصورة لنص الحجم", "Can you draw?", "هل تقدر ترسم؟",
        "Make me a picture of a cat in a suit", "صمم صورة منشور لإعلان الوظيفة",
    ],
    "pc": [
        "سكّر متصفح كروم", "افتح برنامج الإكسل", "وش النوافذ المفتوحة الحين", "شغّل برنامج الرسام", "اقفل الجهاز بعد ساعة",
        "زد سطوع الشاشة", "افتح الإعدادات في ويندوز", "شغّل الكود وشوف وش يطلع", "شغّل npm test", "ابني المشروع",
        "وش آخر تعديل في الكود", "افتح ملف README", "صلّح الخطأ في الاختبارات", "اعرض ملفات مجلد سطح المكتب", "احذف الملفات المؤقتة",
        "Open Word", "Close Chrome", "Open the calculator app", "Shut down the PC in an hour", "Increase screen brightness",
        "Open Windows settings", "Build the project", "Run npm test", "Open the README file", "Fix the failing tests",
        "Show the files on my desktop", "What programs are running", "Kill the node process", "Check git status in the repo",
        "Open VS Code", "افتح فيجوال ستوديو كود", "خفّض الصوت للنص", "Lower the volume to half", "Switch to the other window",
    ],
    "memory": [
        "تذكر إن عميلي خالد يفضل التواصل واتساب", "احفظ رقم المورد عندك", "وش رقم المورد اللي حفظته", "ذكرت لك اسم مشروعي أمس، وش هو؟",
        "وش قلت لك عن الميزانية", "سجل إن الاجتماع الجاي بخصوص التوسعة", "اعرض كل اللي تعرفه عن متجري", "امسح ملاحظة الاجتماع",
        "Remember I prefer short answers", "Note that the supplier is called Hassan", "What's the supplier number I gave you",
        "What did I say about the budget", "Show everything you know about my shop", "Delete the meeting note", "What's my company called",
        "أضف موز وتفاح لقائمة السوبرماركت", "Add eggs and milk to my shopping list", "وش في قائمة المهام حقتي", "What's on my to-do list",
        "شيل الحليب من القائمة",
    ],
    "writing": [
        "اكتب رد مهذب على هذا الإيميل", "ترجم الفقرة هذي للعربي", "اعد صياغة الكلام بشكل رسمي", "اكتب لي سيرة ذاتية مختصرة",
        "اكتب منشور عن افتتاح فرعنا الجديد", "اختصر هذي الرسالة", "اكتب شعر عن الأم", "صحح القواعد في النص التالي",
        "Write a polite reply to this email", "Translate this paragraph into English", "Make this sound more formal", "Write me a short CV",
        "Write a post announcing our new branch", "Shorten this message", "Proofread my text", "Write a birthday message for my brother",
        "اكتب رسالة تهنئة لأخوي بعيد ميلاده", "Write a product description for wireless earbuds", "اكتب مقدمة لبحثي عن الطاقة",
        "Compose a tweet about our weekend offer",
    ],
    "ads": [
        "أبي أسوق لمحلي على قوقل", "كيف أطلع إعلاني أول نتيجة في جوجل", "اعمل حملة لمغسلة السيارات حقتي",
        "سوّ إعلان لمكتب الترجمة في الدوحة", "أبي عملاء أكثر لمحل الستائر من الإعلانات", "حملة جوجل لمطعم بيتزا في مسقط",
        "Make Google ads for a plumber in Glasgow", "Advertise my cleaning company", "I want my shop to show up on Google ads",
        "Create a campaign for a mobile phone repair shop", "Help me run ads for my handyman business", "Google ads for my bakery, 5 pounds a day",
        "وقف الإعلانات مؤقتاً", "شغّل الحملة الموقوفة", "Resume my paused campaign", "كم صرفت الحملة اليوم", "How much did my ads spend today",
        "غيّر هدف الحملة إلى مكالمات", "Change my campaign goal to calls", "Add a call button to my ad",
    ],
}
for _route, _items in MORE.items():
    W[_route].extend(_items)

if __name__ == "__main__":
    out = Path(__file__).with_name("written.jsonl")
    with out.open("w", encoding="utf-8") as handle:
        for route, items in W.items():
            for text in items:
                handle.write(json.dumps({"text": text, "route": route, "source": "claude-code"}, ensure_ascii=False) + "\n")
    print({route: len(items) for route, items in W.items()}, sum(map(len, W.values())))
