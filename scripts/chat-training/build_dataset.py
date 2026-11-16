"""Build a small, explicitly synthetic Arabic/English conversation curriculum.

The task cards and conversations below were authored for this experiment. They
are not a scraped corpus, human conversations, or proof of general chat ability.
Validation is development data; it must never be called an independent test.
No network requests or external model calls are made by this builder.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import random


# category | two English phrasings | English answer | two Arabic phrasings | Arabic answer
# Each wording below is authored explicitly. Expansions do not create independent tasks.
CARDS = r"""
greeting|Hello.~Hi, how are you?|Hello! What would you like help with?|مرحبا.~أهلًا، كيف حالك؟|أهلًا بك! بماذا أستطيع مساعدتك؟
greeting|Good morning.~Morning!|Good morning! What would you like to work on today?|صباح الخير.~صباح النور.|صباح النور! ما الذي تود العمل عليه اليوم؟
greeting|Thanks for your help.~Thank you, that helped.|You're welcome. I'm glad it helped.|شكرًا على مساعدتك.~مشكور، استفدت.|على الرحب والسعة، يسعدني أن الشرح أفادك.
greeting|Goodbye for now.~See you later.|Goodbye! You can continue the conversation whenever you like.|إلى اللقاء الآن.~أشوفك بعدين.|إلى اللقاء! يمكنك متابعة المحادثة متى أحببت.
identity|What is your name?~Who am I talking to?|I'm Mohassan, a local assistant. I can help with text and conversation.|ما اسمك؟~مع من أتحدث؟|أنا موحسن، مساعد محلي أساعدك في النصوص والمحادثة.
limits|Can you see my screen right now?~Tell me what is on my screen.|I can't see your screen in this chat. Describe what you see and I can help.|هل ترى شاشتي الآن؟~قل لي ماذا يوجد على شاشتي.|لا أرى شاشتك في هذه المحادثة. صف لي ما يظهر عليها لأساعدك.
limits|Have you sent that message?~Did you send the email already?|I haven't sent anything. I can help draft the message here.|هل أرسلت تلك الرسالة؟~هل أرسلت البريد بالفعل؟|لم أرسل شيئًا. أستطيع مساعدتك في صياغة الرسالة هنا.
limits|Open my browser.~Can you launch a browser for me?|I don't have browser controls in this chat. Tell me what you want to do and I can explain the steps.|افتح المتصفح عندي.~هل تستطيع تشغيل المتصفح لي؟|لا تتوفر لي أدوات التحكم بالمتصفح هنا. أخبرني بما تريد فعله لأشرح الخطوات.
limits|Are your answers always correct?~Can you guarantee every answer is right?|No. I can make mistakes. Tell me if something looks wrong so we can check it.|هل كل إجاباتك صحيحة؟~هل تضمن صحة كل جواب؟|لا، قد أخطئ. إذا وجدت شيئًا غير صحيح، أخبرني لنتحقق منه.
limits|What is the weather outside now?~Is it raining where I am?|I don't have live weather or your location. Tell me your city and use a current weather source to check.|كيف الطقس خارج البيت الآن؟~هل تمطر في مكاني؟|لا أملك الطقس المباشر أو موقعك. يلزم معرفة المدينة والتحقق من مصدر طقس محدث.
explain|What is a computer program?~Explain a program in simple words.|A computer program is a set of instructions that tells a computer what to do.|ما هو برنامج الحاسوب؟~اشرح البرنامج بكلمات بسيطة.|برنامج الحاسوب مجموعة تعليمات تخبر الحاسوب بما يجب أن يفعله.
explain|What is a variable in programming?~Explain a programming variable briefly.|A variable is a name used to store a value, such as a number or a piece of text.|ما المتغير في البرمجة؟~اشرح المتغير البرمجي باختصار.|المتغير اسم نستخدمه لحفظ قيمة، مثل رقم أو نص.
explain|What is a function in code?~Explain a function to a beginner.|A function is a reusable block of code that performs a particular task.|ما الدالة في الكود؟~اشرح الدالة لمبتدئ.|الدالة مجموعة تعليمات قابلة لإعادة الاستخدام لتنفيذ مهمة محددة.
explain|What does a loop do?~Why do programs use loops?|A loop repeats instructions, often once for each item or until a condition changes.|ماذا تفعل الحلقة البرمجية؟~لماذا تستخدم البرامج الحلقات؟|تكرر الحلقة تعليمات، مثل تنفيذها لكل عنصر أو حتى يتغير شرط معين.
explain|What is a database?~Explain a database simply.|A database stores organized information so it can be searched, updated, and retrieved.|ما قاعدة البيانات؟~اشرح قاعدة البيانات ببساطة.|قاعدة البيانات تحفظ معلومات منظمة يمكن البحث فيها وتحديثها واسترجاعها.
explain|What is an API?~Explain API in plain language.|An API is an agreed way for one program to request data or actions from another program.|ما معنى API؟~اشرح واجهة API ببساطة.|واجهة API طريقة متفق عليها ليطلب برنامج بيانات أو إجراءات من برنامج آخر.
explain|What is a server?~Explain what a server does.|A server receives requests and provides a service, such as returning a page or storing data.|ما هو الخادم؟~اشرح وظيفة السيرفر.|الخادم يستقبل الطلبات ويقدم خدمة، مثل إرجاع صفحة أو حفظ بيانات.
explain|What is a backup?~Why make a backup copy?|A backup is an extra copy of data that can help restore it after loss or damage.|ما النسخة الاحتياطية؟~لماذا نصنع نسخة احتياطية؟|النسخة الاحتياطية نسخة إضافية من البيانات تساعد على استعادتها عند الفقد أو التلف.
explain|What is a file extension?~Explain the end of a filename like .txt.|A file extension is the ending of a filename, such as .txt, that usually indicates its format.|ما امتداد الملف؟~اشرح نهاية اسم الملف مثل .txt.|امتداد الملف هو الجزء الأخير من اسمه، مثل .txt، ويشير عادة إلى نوع تنسيقه.
explain|What is a bug in software?~What does a software bug mean?|A bug is an error that makes software behave differently from what was intended.|ما الخطأ البرمجي؟~ما معنى bug في البرامج؟|الخطأ البرمجي عيب يجعل البرنامج يتصرف بطريقة تختلف عن المطلوب.
explain|What is model training?~Explain training a language model.|Training adjusts a model's weights using examples so it can learn patterns from those examples.|ما تدريب النموذج؟~اشرح تدريب نموذج لغوي.|التدريب يعدل أوزان النموذج باستخدام أمثلة لكي يتعلم الأنماط الموجودة فيها.
explain|What are model weights?~Explain the weights in a neural network.|Weights are numbers learned during training. They help determine how a model transforms input into output.|ما أوزان النموذج؟~اشرح الأوزان في الشبكة العصبية.|الأوزان أرقام يتعلمها النموذج أثناء التدريب وتؤثر في تحويل المدخلات إلى مخرجات.
explain|What is validation data?~Why keep data for validation?|Validation data helps compare training choices on examples that are not used for weight updates.|ما بيانات التحقق؟~لماذا نحتفظ ببيانات للتحقق؟|بيانات التحقق تساعد على مقارنة خيارات التدريب بأمثلة لا تستخدم لتحديث الأوزان.
explain|What is overfitting?~Explain overfitting briefly.|Overfitting happens when a model learns training examples too closely and performs poorly on new examples.|ما فرط التكيّف؟~اشرح حفظ أمثلة التدريب دون تعميم.|يحدث فرط التكيّف عندما يتعلم النموذج أمثلة التدريب بدقة لكنه يضعف أمام أمثلة جديدة.
explain|What is a token in language models?~Explain a text token.|A token is a piece of text processed by a model. It may be a word, part of a word, or a symbol.|ما التوكن في النماذج اللغوية؟~اشرح الوحدة النصية التي يعالجها النموذج.|التوكن جزء من النص يعالجه النموذج، وقد يكون كلمة أو جزءًا منها أو رمزًا.
explain|What is the difference between training and inference?~Compare training with using a trained model.|Training changes the weights. Inference uses the existing weights to produce an answer.|ما الفرق بين التدريب والاستدلال؟~قارن تدريب النموذج باستخدامه بعد التدريب.|التدريب يغيّر الأوزان، أما الاستدلال فيستخدم الأوزان الموجودة لإنتاج جواب.
explain|What does local processing mean?~Explain running a model locally.|Local processing means the work runs on your own device. The exact data flow still depends on the app.|ما معنى المعالجة المحلية؟~اشرح تشغيل نموذج محليًا.|المعالجة المحلية تعني تنفيذ العمل على جهازك، ويعتمد مسار البيانات الفعلي على التطبيق.
explain|What is a context window?~Explain a model's context limit.|The context window is the amount of input and generated text the model can handle at one time.|ما نافذة السياق؟~اشرح حد السياق في النموذج.|نافذة السياق هي مقدار النص المدخل والمولد الذي يستطيع النموذج التعامل معه في المرة الواحدة.
explain|What is a budget?~Explain a budget in simple terms.|A budget is a plan for how much money is available and how it will be used.|ما الميزانية؟~اشرح الميزانية بكلمات بسيطة.|الميزانية خطة تحدد مقدار المال المتاح وكيفية استخدامه.
explain|What is a deadline?~What does deadline mean?|A deadline is the latest time or date by which something should be completed.|ما الموعد النهائي؟~ماذا تعني مهلة التسليم؟|الموعد النهائي آخر وقت أو تاريخ ينبغي إنجاز العمل بحلوله.
explain|What is evaporation?~Explain evaporation simply.|Evaporation is the change of a liquid into a gas at its surface.|ما التبخر؟~اشرح التبخر ببساطة.|التبخر تحول السائل إلى غاز عند سطحه.
explain|Why do plants need light?~Explain why light matters to plants.|Plants use light in photosynthesis to make sugars from water and carbon dioxide.|لماذا تحتاج النباتات إلى الضوء؟~اشرح أهمية الضوء للنبات.|تستخدم النباتات الضوء في البناء الضوئي لصنع السكريات من الماء وثاني أكسيد الكربون.
explain|What is a triangle?~Describe a triangle briefly.|A triangle is a shape with three straight sides and three angles.|ما المثلث؟~صف المثلث باختصار.|المثلث شكل له ثلاثة أضلاع مستقيمة وثلاث زوايا.
explain|What is an average?~Explain the arithmetic mean.|Add the values and divide by how many values there are to find the arithmetic mean.|ما المتوسط الحسابي؟~كيف نحسب المتوسط الحسابي؟|نجمع القيم ثم نقسم المجموع على عددها للحصول على المتوسط الحسابي.
writing|Write a short meeting reminder.~Draft a polite reminder for a meeting.|A quick reminder about our meeting. Please let me know if your availability has changed.|اكتب تذكيرًا قصيرًا باجتماع.~صغ تذكيرًا مهذبًا بموعد اجتماع.|تذكير لطيف باجتماعنا. يرجى إخباري إذا تغير موعد تفرغك.
writing|Write a brief thank-you note to a colleague.~Help me thank a coworker for their support.|Thank you for your support and the time you gave to help me. I appreciate it.|اكتب شكرًا قصيرًا لزميل.~ساعدني في شكر زميل على دعمه.|شكرًا لدعمك والوقت الذي خصصته لمساعدتي. أقدّر تعاونك كثيرًا.
writing|Draft a polite request for an update.~Ask for a project update politely.|Could you please share a brief update on the project's progress and any outstanding issues?|صغ طلبًا مهذبًا لتحديث العمل.~اطلب معرفة تقدم المشروع بأدب.|هل يمكنك مشاركة تحديث مختصر عن تقدم المشروع وأي أمور ما زالت معلقة؟
writing|Write a short apology for being late.~Help me apologize for arriving late.|I'm sorry I was late. Thank you for waiting; I'll plan more carefully next time.|اكتب اعتذارًا قصيرًا عن التأخر.~ساعدني في الاعتذار عن تأخري.|أعتذر عن التأخر، وشكرًا لانتظارك. سأحرص على تنظيم وقتي بشكل أفضل.
writing|Draft a message asking to reschedule.~Write a polite request to change a meeting time.|Could we move our meeting to another time? Please let me know what works for you.|صغ رسالة لطلب تغيير الموعد.~اكتب طلبًا مهذبًا لتأجيل اجتماع.|هل يمكننا نقل الاجتماع إلى وقت آخر؟ أخبرني بالموعد المناسب لك.
writing|Write a simple welcome message.~Draft a warm welcome for a new teammate.|Welcome to the team! We're glad you're here and look forward to working with you.|اكتب رسالة ترحيب بسيطة.~رحب بزميل جديد في الفريق.|أهلًا بك في الفريق! سعداء بانضمامك ونتطلع إلى العمل معك.
writing|Write a polite decline to an invitation.~Help me turn down an invitation kindly.|Thank you for inviting me. I won't be able to attend this time, but I appreciate the invitation.|اكتب اعتذارًا مهذبًا عن دعوة.~ساعدني في رفض دعوة بلطف.|شكرًا على الدعوة. لن أتمكن من الحضور هذه المرة، وأقدّر دعوتك لي.
writing|Draft a short request for clarification.~Ask someone to explain an unclear requirement.|Could you clarify what the expected result should look like? An example would be helpful.|اكتب طلب توضيح قصيرًا.~اطلب شرح متطلب غير واضح.|هل يمكنك توضيح شكل النتيجة المطلوبة؟ سيساعدني وجود مثال.
writing|Write a friendly follow-up message.~Draft a gentle follow-up after no reply.|I'm following up on my earlier message. Please reply when you have a chance.|اكتب رسالة متابعة ودية.~صغ متابعة لطيفة بعد عدم الرد.|أتابع رسالتي السابقة. أرجو الرد عندما يتاح لك الوقت.
writing|Suggest a title for a note about saving time.~Give me a simple title about time management.|Small Habits That Save Time|اقترح عنوانًا لملاحظة عن توفير الوقت.~أعطني عنوانًا بسيطًا عن تنظيم الوقت.|عادات بسيطة توفر الوقت
writing|Write one encouraging sentence for a learner.~Give a beginner a short encouragement.|Take one small step, practice it, and build from there.|اكتب جملة تشجيع واحدة لمتعلم.~شجع مبتدئًا بعبارة قصيرة.|ابدأ بخطوة صغيرة، وتدرّب عليها، ثم ابنِ عليها.
writing|Write a brief message confirming receipt.~Confirm politely that a document arrived.|Thank you. I've received the document and will review it.|اكتب رسالة قصيرة لتأكيد الاستلام.~أكد استلام مستند بأدب.|شكرًا لك، استلمت المستند وسأراجعه.
writing|Draft a note asking for feedback.~Ask a colleague for feedback on a draft.|Could you review this draft and share any suggestions for making it clearer?|صغ رسالة تطلب ملاحظات.~اطلب رأي زميل في مسودة.|هل يمكنك مراجعة هذه المسودة واقتراح ما يجعلها أوضح؟
writing|Write a simple out-of-office message.~Draft a short absence reply.|I'm currently away and will reply when I return. Thank you for your patience.|اكتب رسالة غياب بسيطة.~صغ ردًا قصيرًا أثناء عدم التفرغ.|أنا غير متاح حاليًا وسأرد عند عودتي. شكرًا لتفهمك.
writing|Write a polite request to lower the volume.~Ask someone to be a little quieter kindly.|Could you lower the volume a little, please? Thank you.|اكتب طلبًا مهذبًا لخفض الصوت.~اطلب من شخص أن يهدأ قليلًا بلطف.|هل يمكنك خفض الصوت قليلًا من فضلك؟ شكرًا لك.
transform|Make this polite: Send the file now.~Rewrite politely: Give me the file now.|Could you please send me the file when you have a moment?|اجعلها مهذبة: أرسل الملف الآن.~أعد صياغة أعطني الملف الآن بأدب.|هل يمكنك إرسال الملف عندما يتاح لك الوقت من فضلك؟
transform|Shorten: I am writing to let you know that the meeting is cancelled.~Make this shorter: I wanted to inform you that the meeting has been cancelled.|The meeting is cancelled.|اختصر: أكتب إليك لكي أخبرك بأن الاجتماع قد تم إلغاؤه.~اجعل هذه أقصر: أردت إعلامك بأن الاجتماع أُلغي.|أُلغي الاجتماع.
transform|Correct the spelling: recieve.~Fix this word: recieve.|receive|صحح الإملاء: هاذا كتاب.~صحح كلمة هاذا في الجملة هاذا كتاب.|هذا كتاب.
transform|Turn this into a question: You are ready.~Make a question from: You are ready.|Are you ready?|حوّل إلى سؤال: أنت مستعد.~اجعل أنت مستعد جملة استفهامية.|هل أنت مستعد؟
transform|Change this to past tense: I walk to school.~Put in the past tense: I walk to school.|I walked to school.|حوّل إلى الماضي: أذهب إلى المدرسة.~اكتب أذهب إلى المدرسة في زمن الماضي.|ذهبت إلى المدرسة.
transform|Make this plural: one book.~Write the plural of book.|books|اجمع كلمة كتاب.~ما جمع كتاب؟|كتب
transform|Give the opposite of hot.~What is the opposite of hot?|cold|ما عكس ساخن؟~أعطني ضد كلمة ساخن.|بارد
transform|Write hello in uppercase.~Convert hello to capital letters.|HELLO|اكتب hello بحروف إنجليزية كبيرة.~حوّل hello إلى أحرف كبيرة.|HELLO
transform|Write HELLO in lowercase.~Convert HELLO to small letters.|hello|اكتب HELLO بحروف إنجليزية صغيرة.~حوّل HELLO إلى أحرف صغيرة.|hello
transform|Put apples and oranges on separate lines.~Write each on a new line: apples, oranges.|apples\noranges|ضع التفاح والبرتقال في سطرين.~اكتب كل عنصر بسطر: تفاح، برتقال.|تفاح\nبرتقال
summary|Summarize: The shop opens at nine. It closes at five. It is closed on Sundays.~Make this shorter: The shop runs from nine to five and does not open on Sundays.|The shop is open nine to five, except Sundays.|لخص: يفتح المتجر في التاسعة ويغلق في الخامسة، وهو مغلق يوم الأحد.~اختصر: يعمل المتجر من التاسعة حتى الخامسة ولا يفتح أيام الأحد.|يفتح المتجر من التاسعة إلى الخامسة، باستثناء الأحد.
summary|Summarize: Sara missed the bus, so she walked to work.~What happened? Sara missed her bus and went to work on foot.|Sara walked to work after missing the bus.|لخص: فاتت سارة الحافلة فذهبت إلى العمل سيرًا.~ماذا حدث؟ لم تلحق سارة بالحافلة ومشت إلى عملها.|ذهبت سارة إلى العمل سيرًا بعدما فاتتها الحافلة.
summary|Summarize: The team tested the app, found a bug, and fixed it.~Shorten this: After testing the app, the team discovered and repaired a bug.|The team found and fixed a bug during testing.|لخص: اختبر الفريق التطبيق ووجد خطأ ثم أصلحه.~اختصر: أثناء اختبار التطبيق اكتشف الفريق خطأ وعالجه.|اكتشف الفريق خطأ أثناء الاختبار وأصلحه.
summary|What is the main point? The delivery is delayed because the road is closed.~Summarize: A road closure has caused the delivery to arrive late.|A closed road delayed the delivery.|ما الفكرة الرئيسية؟ تأخر التوصيل بسبب إغلاق الطريق.~لخص: تسبب إغلاق الطريق في تأخر وصول الطلب.|أدى إغلاق الطريق إلى تأخر التوصيل.
summary|Summarize: Lina bought seeds, planted them, and watered them every morning.~Shorten: Lina planted some seeds and gave them water each morning.|Lina planted seeds and watered them daily.|لخص: اشترت لينا بذورًا وزرعتها وكانت تسقيها كل صباح.~اختصر: زرعت لينا البذور وسقتها صباح كل يوم.|زرعت لينا البذور واهتمت بسقيها يوميًا.
planning|Help me plan a short study session.~Give me three steps for studying today.|Choose one topic, study it for a focused period, then test what you remember.|ساعدني في تخطيط جلسة دراسة قصيرة.~أعطني ثلاث خطوات للدراسة اليوم.|اختر موضوعًا واحدًا، وادرسه بتركيز، ثم اختبر ما تتذكره.
planning|How can I organize a small task?~Give me a simple way to plan a task.|Define the result, list the necessary steps, and start with the first step.|كيف أنظم مهمة صغيرة؟~أعطني طريقة بسيطة لتخطيط مهمة.|حدد النتيجة المطلوبة، واكتب الخطوات اللازمة، ثم ابدأ بالخطوة الأولى.
planning|Help me prepare for a meeting.~What should I do before a meeting?|Write the purpose, gather the needed information, and list the decisions you want to make.|ساعدني في الاستعداد لاجتماع.~ماذا أفعل قبل الاجتماع؟|اكتب هدف الاجتماع، واجمع المعلومات المطلوبة، وحدد القرارات التي تريد الوصول إليها.
planning|How do I break a large job into smaller tasks?~Help me split a big project into steps.|List the main outcomes, split each into concrete actions, and order the actions by dependency.|كيف أقسم عملًا كبيرًا إلى مهام صغيرة؟~ساعدني في تقسيم مشروع كبير إلى خطوات.|حدد النتائج الأساسية، وقسّم كل نتيجة إلى إجراءات واضحة، ثم رتبها حسب اعتماد بعضها على بعض.
planning|Give me a simple packing checklist.~What should I check before a short trip?|Check your documents, clothes, chargers, and any essentials for the length of your trip.|أعطني قائمة بسيطة لتجهيز الحقيبة.~ماذا أراجع قبل رحلة قصيرة؟|راجع المستندات والملابس والشواحن وما تحتاجه من أساسيات بحسب مدة الرحلة.
planning|How can I keep track of tasks?~Suggest a simple task list method.|Write each task with its next action and due date. Review the list regularly.|كيف أتابع مهامي؟~اقترح طريقة بسيطة لقائمة المهام.|اكتب كل مهمة مع خطوتها التالية وموعدها، وراجع القائمة بانتظام.
planning|Help me plan a tidy desk.~Where should I start cleaning my desk?|Remove rubbish, group similar items, and keep only the things you use often within reach.|ساعدني في ترتيب المكتب.~من أين أبدأ تنظيف مكتبي؟|تخلص من المهملات، واجمع الأشياء المتشابهة، واترك ما تستخدمه كثيرًا في متناول يدك.
planning|How can I review a piece of writing?~Give me a short writing review checklist.|Check the purpose, the order of ideas, sentence clarity, and spelling.|كيف أراجع نصًا كتبته؟~أعطني قائمة قصيرة لمراجعة الكتابة.|راجع الهدف وترتيب الأفكار ووضوح الجمل والإملاء.
planning|How should I learn a new skill?~Give me a simple learning approach.|Pick a small goal, practice regularly, and use feedback to improve the next attempt.|كيف أتعلم مهارة جديدة؟~أعطني طريقة بسيطة للتعلم.|اختر هدفًا صغيرًا، وتدرّب بانتظام، واستفد من الملاحظات لتحسين المحاولة التالية.
planning|What should I do when a task feels overwhelming?~I have too much to do. How can I start?|Choose one small, useful action and do that first. Then decide on the next step.|ماذا أفعل عندما تبدو المهمة مرهقة؟~عندي أعمال كثيرة، كيف أبدأ؟|اختر إجراءً صغيرًا ومفيدًا وابدأ به، ثم حدد الخطوة التالية.
clarify|Fix it.~Can you repair this?|What would you like me to fix? Please share the text, error, or relevant details.|أصلحه.~هل يمكنك إصلاح هذا؟|ما الذي تريد إصلاحه؟ أرسل النص أو رسالة الخطأ أو التفاصيل اللازمة.
clarify|Write a message.~Draft something for me.|Who is the message for, and what would you like it to say?|اكتب رسالة.~صغ لي شيئًا.|لمن الرسالة، وما الذي تريد قوله فيها؟
clarify|Make a plan.~Plan it for me.|What is the goal, and how much time do you have?|ضع خطة.~خطط لي الموضوع.|ما الهدف، وكم من الوقت متاح لديك؟
clarify|Translate this.~Can you translate it?|Please send the text and tell me the language you want it translated into.|ترجم هذا.~هل تستطيع ترجمته؟|أرسل النص وحدد اللغة التي تريد الترجمة إليها.
clarify|Which one is better?~What is the best option?|Which options are you comparing, and what matters most to you?|أيهما أفضل؟~ما الخيار الأفضل؟|ما الخيارات التي تقارن بينها، وما الأهم بالنسبة لك؟
clarify|Make it shorter.~Shorten the text.|Please send the text you want shortened.|اختصره.~اجعل النص أقصر.|أرسل النص الذي تريد اختصاره.
clarify|Tell me how much it costs.~What is the price?|Which item or service do you mean, and in which location or currency?|قل لي كم يكلف.~ما السعر؟|ما المنتج أو الخدمة المقصودة، وفي أي مكان أو عملة؟
clarify|Continue.~Carry on from there.|What would you like me to continue? Please share the last part or the topic.|تابع.~كمل من هناك.|ما الذي تريدني أن أتابعه؟ أرسل الجزء السابق أو حدد الموضوع.
uncertainty|What number am I thinking of?~Guess the number in my mind.|I can't know which number you're thinking of without more information.|ما الرقم الذي أفكر فيه؟~اعرف الرقم الموجود في بالي.|لا أستطيع معرفة الرقم الذي تفكر فيه دون معلومات إضافية.
uncertainty|Will my idea definitely succeed?~Can you promise my project will work?|I can't guarantee that. We can examine the goal, assumptions, and likely obstacles.|هل ستنجح فكرتي بالتأكيد؟~هل تضمن نجاح مشروعي؟|لا أستطيع ضمان ذلك. يمكننا مراجعة الهدف والافتراضات والعقبات المحتملة.
uncertainty|Tell me tomorrow's exact news.~What will the news say tomorrow?|I don't know future events. I can help discuss possibilities if you name a topic.|أخبرني بأخبار الغد بدقة.~ماذا ستقول الأخبار غدًا؟|لا أعرف الأحداث المستقبلية. يمكنني مناقشة الاحتمالات إذا حددت موضوعًا.
uncertainty|You are wrong.~That answer is not correct.|Thank you for pointing that out. Which part is wrong, and what information should we check?|أنت مخطئ.~هذه الإجابة غير صحيحة.|شكرًا للتنبيه. أي جزء غير صحيح، وما المعلومات التي ينبغي مراجعتها؟
uncertainty|I don't understand your explanation.~That was confusing.|Tell me which part was unclear, and I'll explain it in simpler steps.|لم أفهم شرحك.~الشرح كان مربكًا.|حدد الجزء غير الواضح وسأشرحه بخطوات أبسط.
translation|Translate good morning into Arabic.~How do you say good morning in Arabic?|صباح الخير|ترجم صباح الخير إلى الإنجليزية.~كيف أقول صباح الخير بالإنجليزية؟|Good morning.
translation|Translate thank you into Arabic.~How do you say thank you in Arabic?|شكرًا لك|ترجم شكرًا لك إلى الإنجليزية.~كيف أقول شكرًا لك بالإنجليزية؟|Thank you.
translation|Translate see you tomorrow into Arabic.~How do you say see you tomorrow in Arabic?|أراك غدًا|ترجم أراك غدًا إلى الإنجليزية.~كيف أقول أراك غدًا بالإنجليزية؟|See you tomorrow.
translation|Translate please wait into Arabic.~How do you say please wait in Arabic?|يرجى الانتظار|ترجم يرجى الانتظار إلى الإنجليزية.~كيف أقول يرجى الانتظار بالإنجليزية؟|Please wait.
translation|Translate where is the station into Arabic.~How do you ask where the station is in Arabic?|أين المحطة؟|ترجم أين المحطة إلى الإنجليزية.~كيف أسأل عن مكان المحطة بالإنجليزية؟|Where is the station?
reasoning|A box contains three red balls and two blue balls. How many balls are there?~There are three red balls plus two blue ones. What is the total?|There are five balls in total.|في الصندوق ثلاث كرات حمراء وكرتان زرقاوان. كم كرة فيه؟~ثلاث كرات حمراء ومعها كرتان زرقاوان، ما المجموع؟|المجموع خمس كرات.
reasoning|All squares have four sides. This shape is a square. How many sides does it have?~If a shape is a square, how many sides must it have?|It has four sides.|كل مربع له أربعة أضلاع. هذا الشكل مربع. كم ضلعًا له؟~إذا كان الشكل مربعًا، فكم عدد أضلاعه؟|له أربعة أضلاع.
reasoning|If the light is off, is it on?~Can a light be on when it is off in the same sense at the same time?|No, it is off.|إذا كان المصباح مطفأ فهل هو مشتعل؟~هل يكون المصباح مشتعلًا وهو مطفأ بالمعنى نفسه في الوقت نفسه؟|لا، المصباح مطفأ.
reasoning|I have ten coins and give away four. How many remain?~Ten coins minus four coins leaves how many?|Six coins remain.|معي عشر قطع وأعطيت أربعًا. كم بقي؟~عشر قطع ناقص أربع قطع، كم الناتج؟|تبقى ست قطع.
reasoning|A meeting starts at two and lasts one hour. When does it end?~What is one hour after two o'clock?|It ends at three o'clock.|يبدأ اجتماع في الثانية ويستمر ساعة. متى ينتهي؟~ما الوقت بعد ساعة من الثانية؟|ينتهي في الساعة الثالثة.
reasoning|What comes next: 2, 4, 6, 8?~Continue the sequence: 2, 4, 6, 8.|10, if the pattern continues by adding two.|ما العدد التالي: ٢، ٤، ٦، ٨؟~أكمل التسلسل: ٢، ٤، ٦، ٨.|١٠، إذا استمر النمط بزيادة اثنين.
reasoning|Which is larger, 12 or 9?~Compare 12 and 9. Which is greater?|12 is larger than 9.|أيهما أكبر، ١٢ أم ٩؟~قارن بين ١٢ و٩، أيهما أكبر؟|١٢ أكبر من ٩.
reasoning|Is zero an even number?~Does zero count as even?|Yes. Zero is even because it is divisible by two with no remainder.|هل الصفر عدد زوجي؟~هل نعد الصفر زوجيًا؟|نعم، الصفر عدد زوجي لأنه يقبل القسمة على اثنين دون باقٍ.
listening|I feel frustrated with this task.~This task is really annoying me.|That sounds frustrating. Tell me where you're stuck, and we can take it one step at a time.|أشعر بالإحباط من هذه المهمة.~هذه المهمة أزعجتني كثيرًا.|يبدو أن المهمة أتعبتك. أخبرني أين توقفت لنأخذها خطوة بخطوة.
listening|I finally finished my project.~I've completed the work at last.|That must feel good. Would you like help reviewing it or planning the next step?|أنهيت مشروعي أخيرًا.~خلصت العمل بعد تعب.|لابد أن هذا شعور مريح. هل تريد مساعدة في مراجعته أو تحديد الخطوة التالية؟
listening|I'm worried I'll forget the steps.~I may not remember what to do.|We can turn the steps into a short checklist you can refer to.|أخشى أن أنسى الخطوات.~قد لا أتذكر ما يجب فعله.|يمكننا تحويل الخطوات إلى قائمة قصيرة ترجع إليها عند الحاجة.
listening|Please answer briefly.~Keep your replies short.|Understood. I'll keep the answer concise.|أجب باختصار من فضلك.~خلي ردودك قصيرة.|حاضر، سأجعل الرد مختصرًا.
listening|Please explain slowly, one step at a time.~Don't give me everything at once.|Of course. Tell me the task, and we'll start with the first step.|اشرح بهدوء خطوة خطوة.~لا تعطيني كل شيء مرة واحدة.|حاضر. أخبرني بالمهمة لنبدأ بالخطوة الأولى.
"""


# category | English u1 | a1 | u2 | target | Arabic u1 | a1 | u2 | target
DIALOGUES = r"""
context|My name is Maya.|Nice to meet you, Maya.|What is my name?|Your name is Maya.|اسمي مريم.|تشرفت بك يا مريم.|ما اسمي؟|اسمك مريم.
context|I'm planning a trip to York.|What would you like to plan for York?|Which city did I mention?|You mentioned York.|أخطط لزيارة حلب.|ما الذي تريد تخطيطه لزيارة حلب؟|ما المدينة التي ذكرتها؟|ذكرت حلب.
context|I prefer short answers.|I'll keep my replies brief.|What kind of answers do I prefer?|You prefer short answers.|أفضل الإجابات القصيرة.|سأجعل ردودي مختصرة.|أي نوع من الإجابات أفضل؟|تفضل الإجابات القصيرة.
context|The project is called Cedar.|I'll refer to the project as Cedar.|What did I call the project?|You called it Cedar.|اسم المشروع الأرز.|سأستخدم اسم الأرز للمشروع.|ماذا سميت المشروع؟|سميت المشروع الأرز.
context|My meeting is on Tuesday.|The meeting is on Tuesday.|When is my meeting?|Your meeting is on Tuesday.|اجتماعي يوم الثلاثاء.|موعد الاجتماع يوم الثلاثاء.|متى اجتماعي؟|اجتماعك يوم الثلاثاء.
correction|The appointment is at four.|The appointment is at four.|Actually, change it to five. What time is it now?|The appointment is now at five.|الموعد في الرابعة.|الموعد في الرابعة.|بل اجعله في الخامسة. متى أصبح؟|أصبح الموعد في الخامسة.
correction|Use blue for the title.|I'll use blue for the title in the draft.|No, use green instead. Which color should you use?|I should use green.|استخدم الأزرق للعنوان.|سأستخدم الأزرق للعنوان في المسودة.|لا، استخدم الأخضر بدلًا منه. أي لون ستستخدم؟|سأستخدم الأخضر.
correction|The budget is fifty pounds.|The budget is fifty pounds.|Correction: sixty pounds. Repeat the new budget.|The new budget is sixty pounds.|الميزانية خمسون جنيهًا.|الميزانية خمسون جنيهًا.|تصحيح: ستون جنيهًا. كرر الميزانية الجديدة.|الميزانية الجديدة ستون جنيهًا.
correction|My first choice is tea.|Your first choice is tea.|I changed my mind: coffee. What do I want?|You want coffee.|اختياري الأول الشاي.|اختيارك الأول الشاي.|غيرت رأيي: قهوة. ماذا أريد؟|تريد القهوة.
correction|The folder is called drafts.|The folder name is drafts.|Rename it to notes in our plan. What is its name?|Its name in the plan is notes.|اسم المجلد مسودات.|اسم المجلد مسودات.|غيّر اسمه في خطتنا إلى ملاحظات. ما اسمه؟|اسمه في الخطة ملاحظات.
followup|What is a backup?|A backup is an extra copy of data for recovery.|Make that simpler.|A backup is a spare copy of your files.|ما النسخة الاحتياطية؟|النسخة الاحتياطية نسخة إضافية من البيانات للاستعادة.|بسّط هذا أكثر.|هي نسخة ثانية من ملفاتك ترجع إليها عند الحاجة.
followup|Explain a variable.|A variable is a name that stores a value in a program.|Give me an example.|For example, age = 20 stores the value 20 under the name age.|اشرح المتغير.|المتغير اسم يحفظ قيمة داخل البرنامج.|أعطني مثالًا.|مثلًا age = 20 يحفظ القيمة 20 في متغير اسمه age.
followup|Write a meeting reminder.|Please remember our meeting tomorrow.|Make it more formal.|This is a reminder of our scheduled meeting tomorrow.|اكتب تذكيرًا بالاجتماع.|لا تنس اجتماعنا غدًا.|اجعله أكثر رسمية.|نود تذكيركم باجتماعنا المقرر غدًا.
followup|Write a thank-you note.|Thank you for your help and support.|Make it shorter.|Thanks for your help.|اكتب رسالة شكر.|شكرًا لمساعدتك ودعمك.|اجعلها أقصر.|شكرًا لمساعدتك.
followup|Give me three study steps.|Choose a topic, review it, and test yourself.|What is the last step?|The last step is to test yourself.|أعطني ثلاث خطوات للدراسة.|اختر موضوعًا، وراجعه، ثم اختبر نفسك.|ما الخطوة الأخيرة؟|الخطوة الأخيرة أن تختبر نفسك.
followup|List two fruits.|Apples and bananas.|Put them on separate lines.|Apples\nBananas|اذكر فاكهتين.|التفاح والموز.|ضعهما في سطرين منفصلين.|التفاح\nالموز
followup|Translate good evening into Arabic.|مساء الخير|Now translate it back into English.|Good evening.|ترجم مساء الخير إلى الإنجليزية.|Good evening.|والآن أعدها إلى العربية.|مساء الخير.
followup|What is a server?|A server receives requests and provides a service.|Give one example of a service.|Returning a web page is one example.|ما الخادم؟|الخادم يستقبل الطلبات ويقدم خدمة.|أعطني مثالًا واحدًا على خدمة.|إرجاع صفحة ويب مثال على خدمة يقدمها الخادم.
followup|Write a polite request for a file.|Could you send me the file, please?|Add that I need it today.|Could you send me the file today, please?|اكتب طلبًا مهذبًا للحصول على ملف.|هل يمكنك إرسال الملف من فضلك؟|أضف أنني أحتاجه اليوم.|هل يمكنك إرسال الملف اليوم من فضلك؟
followup|Summarize this: The train was late, so Omar missed the meeting.|Omar missed the meeting because the train was late.|Why did he miss it?|Because the train was late.|لخص: تأخر القطار ولذلك فات عمر الاجتماع.|فات عمر الاجتماع بسبب تأخر القطار.|لماذا فاته؟|لأن القطار تأخر.
clarification|Write a message.|Who is it for, and what should it say?|For my colleague. Ask whether the report is ready.|Hi, is the report ready? Please let me know when you have a moment.|اكتب رسالة.|لمن الرسالة، وماذا تريد أن تقول؟|لزميلي. اسأله هل التقرير جاهز.|مرحبًا، هل التقرير جاهز؟ أخبرني عندما يتاح لك الوقت.
clarification|Help me make a plan.|What is your goal?|I want to organize my notes.|Group your notes by topic, give each group a clear title, and remove duplicate copies.|ساعدني في وضع خطة.|ما هدفك؟|أريد تنظيم ملاحظاتي.|اجمع الملاحظات بحسب الموضوع، وضع عنوانًا واضحًا لكل مجموعة، وأزل النسخ المكررة.
clarification|Translate this.|Please send the text and target language.|Translate welcome into Arabic.|أهلًا وسهلًا|ترجم هذا.|أرسل النص واللغة المطلوبة.|ترجم أهلًا وسهلًا إلى الإنجليزية.|Welcome.
clarification|Make this more polite.|Please send the sentence.|You must answer me now.|Could you reply when you have a moment, please?|اجعل هذه العبارة ألطف.|أرسل العبارة من فضلك.|يجب أن ترد علي الآن.|هل يمكنك الرد عندما يتاح لك الوقت من فضلك؟
clarification|I need help with an error.|What does the error message say?|It says file not found.|Check that the file exists and that its name and path match what the program expects.|أحتاج مساعدة في خطأ.|ماذا تقول رسالة الخطأ؟|تقول إن الملف غير موجود.|تحقق من وجود الملف ومن تطابق اسمه ومساره مع ما يتوقعه البرنامج.
clarification|Shorten this.|Please send the text.|I wanted to tell you that I will not be able to attend tomorrow.|I can't attend tomorrow.|اختصر هذا.|أرسل النص من فضلك.|أردت أن أخبرك بأنني لن أتمكن من الحضور غدًا.|لن أتمكن من الحضور غدًا.
negation|I want tea, not coffee.|You want tea.|Which drink should be excluded?|Coffee should be excluded.|أريد الشاي وليس القهوة.|تريد الشاي.|أي مشروب يجب استبعاده؟|يجب استبعاد القهوة.
negation|Do not send anything; just draft it.|I'll only provide a draft here.|Did you send it?|No. I only provided a draft; nothing was sent.|لا ترسل شيئًا، فقط اكتب مسودة.|سأقدم مسودة هنا فقط.|هل أرسلتها؟|لا، قدمت مسودة فقط ولم أرسل شيئًا.
negation|We are meeting on Friday, not Thursday.|The meeting is on Friday.|Which day is the meeting?|The meeting is on Friday.|سنلتقي الجمعة وليس الخميس.|اللقاء يوم الجمعة.|في أي يوم اللقاء؟|اللقاء يوم الجمعة.
negation|I need a list, not a paragraph.|I'll use a list.|Name two things to bring to a meeting.|- A notebook\n- Any relevant documents|أحتاج قائمة لا فقرة.|سأستخدم قائمة.|اذكر شيئين أحضرهما للاجتماع.|- دفتر ملاحظات\n- المستندات ذات الصلة
switch|Explain a backup in English.|A backup is an extra copy of your data.|Now say that in Arabic.|النسخة الاحتياطية نسخة إضافية من بياناتك.|اشرح النسخة الاحتياطية بالعربية.|النسخة الاحتياطية نسخة إضافية من بياناتك.|قل ذلك الآن بالإنجليزية.|A backup is an extra copy of your data.
switch|Give your answer in Arabic: what is a triangle?|المثلث شكل له ثلاثة أضلاع.|Now answer in English.|A triangle is a shape with three sides.|أجب بالإنجليزية: ما المثلث؟|A triangle is a shape with three sides.|والآن أجب بالعربية.|المثلث شكل له ثلاثة أضلاع.
switch|Say thank you in Arabic.|شكرًا|Use English for your next reply. What did you just say?|I said thank you.|قل شكرًا بالإنجليزية.|Thank you.|استخدم العربية في ردك التالي. ماذا قلت؟|قلت شكرًا.
reasoning|I have eight pencils.|You have eight pencils.|I give away three. How many remain?|Five pencils remain.|معي ثمانية أقلام.|معك ثمانية أقلام.|أعطيت ثلاثة منها. كم بقي؟|تبقى خمسة أقلام.
reasoning|The first box has two books.|There are two books in the first box.|The second has three. How many are in both boxes?|There are five books in both boxes combined.|في الصندوق الأول كتابان.|يوجد كتابان في الصندوق الأول.|وفي الثاني ثلاثة. كم في الصندوقين؟|في الصندوقين خمسة كتب.
reasoning|I start at ten o'clock.|You start at ten o'clock.|The task takes two hours. When do I finish?|You finish at twelve o'clock.|أبدأ في الساعة العاشرة.|تبدأ في العاشرة.|تستغرق المهمة ساعتين. متى أنتهي؟|تنتهي في الساعة الثانية عشرة.
boundaries|Please open my documents.|I can't open files from this chat.|Then have you read them?|No. I haven't opened or read your documents.|افتح مستنداتي من فضلك.|لا أستطيع فتح الملفات من هذه المحادثة.|إذن هل قرأتها؟|لا، لم أفتح مستنداتك أو أقرأها.
boundaries|Search the web for me.|I don't have web search in this chat.|Are you using live search results now?|No. I haven't searched the web in this conversation.|ابحث في الإنترنت لي.|لا تتوفر لدي أداة بحث في هذه المحادثة.|هل تستخدم نتائج بحث مباشرة الآن؟|لا، لم أجر بحثًا في الإنترنت ضمن هذه المحادثة.
boundaries|Remember this code: K7M.|I can refer to K7M within this conversation.|Will you remember it in every future chat?|I can't promise that. I can use it while it remains in this conversation's context.|تذكر هذا الرمز: K7M.|يمكنني الرجوع إلى K7M داخل هذه المحادثة.|هل ستتذكره في كل محادثة مستقبلية؟|لا أستطيع ضمان ذلك. أستخدمه ما دام موجودًا في سياق هذه المحادثة.
repair|The box has seven items.|The box has six items.|I said seven, not six. Correct your answer.|You're right. The box has seven items.|في الصندوق سبعة أشياء.|في الصندوق ستة أشياء.|قلت سبعة لا ستة. صحح جوابك.|صحيح، في الصندوق سبعة أشياء.
"""

# Separately authored development cases, never independent final evaluation.
VALIDATION = r"""
greeting|Hello there, can we talk?|Yes, we can talk. What is on your mind?|أهلين، ممكن نتكلم؟|نعم، تفضل. ما الموضوع الذي تريد الحديث عنه؟
greeting|Thank you for explaining that patiently.|You're very welcome; ask again if any part needs clarification.|شكرًا لأنك شرحت لي بصبر.|أهلًا بك، وإذا بقي جزء غامض يمكنني توضيحه.
identity|Introduce yourself in one sentence.|I'm Mohassan, an experimental local assistant for text conversations.|عرّفني بنفسك في جملة.|أنا موحسن، مساعد محلي تجريبي للمحادثات النصية.
limits|What can you see through my camera?|I haven't received a camera image, so I can't describe the view.|ماذا ترى من كاميرتي؟|لم تصلني صورة من الكاميرا، لذلك لا أستطيع وصف ما أمامها.
limits|Did you change anything on my computer while answering?|No computer action was performed by this text reply.|هل غيرت شيئًا على جهازي أثناء إجابتك؟|هذا الرد النصي لم ينفذ أي تغيير على جهازك.
limits|Read today's headlines to me.|I can't retrieve today's headlines here without a live news tool.|اقرأ لي عناوين أخبار اليوم.|لا أستطيع جلب عناوين اليوم هنا دون أداة أخبار مباشرة.
explain|In plain terms, what is software testing?|Testing checks whether software behaves as expected on chosen cases.|بكلام بسيط، ما اختبار البرامج؟|الاختبار يتحقق من تصرف البرنامج كما هو متوقع في حالات محددة.
explain|Explain what a password is to a beginner.|A password is a secret used to help prove that you are allowed to access an account.|اشرح كلمة المرور لشخص مبتدئ.|كلمة المرور سر يساعد على إثبات أنك مخول بالدخول إلى حساب.
explain|What does downloading a file mean?|Downloading means copying data from another system onto your device.|ماذا يعني تنزيل ملف؟|التنزيل هو نسخ بيانات من نظام آخر إلى جهازك.
explain|What do people mean by a draft?|A draft is an early version of a piece of work that can still be revised.|ما المقصود بالمسودة؟|المسودة نسخة أولية من العمل يمكن مراجعتها وتعديلها.
explain|What is the purpose of a checklist?|A checklist helps you verify that the necessary items or steps have been covered.|ما فائدة قائمة التحقق؟|تساعد قائمة التحقق على التأكد من استيفاء العناصر أو الخطوات المطلوبة.
explain|Why shouldn't a model be assessed only on its training examples?|That may measure memorization instead of its ability to handle new inputs.|لماذا لا نقيّم النموذج على أمثلة تدريبه فقط؟|قد يقيس ذلك الحفظ بدل قدرته على التعامل مع مدخلات جديدة.
writing|Draft a message asking a friend to call when free.|Could you give me a call when you're free? There is something I'd like to discuss.|اكتب رسالة لصديق تطلب منه الاتصال عندما يتفرغ.|هل يمكنك الاتصال بي عندما تتفرغ؟ أود مناقشة أمر معك.
writing|Write a short note thanking a teacher for clear lessons.|Thank you for making the lessons clear and taking the time to answer my questions.|اكتب شكرًا قصيرًا لمعلم على وضوح الدروس.|شكرًا لجعل الدروس واضحة وتخصيص وقت للإجابة عن أسئلتي.
writing|Ask a teammate to review a table before tomorrow.|Could you review this table before tomorrow and flag anything that needs correcting?|اطلب من زميل مراجعة جدول قبل الغد.|هل يمكنك مراجعة هذا الجدول قبل الغد وتحديد ما يحتاج إلى تصحيح؟
writing|Write a simple greeting for a workshop audience.|Welcome, everyone. Thank you for joining today's workshop.|اكتب تحية بسيطة لحضور ورشة.|مرحبًا بالجميع، وشكرًا لحضوركم ورشة اليوم.
transform|Make this gentler: Your explanation makes no sense.|I'm having trouble following the explanation. Could you clarify it?|لطّف هذه العبارة: شرحك غير مفهوم إطلاقًا.|أواجه صعوبة في متابعة الشرح. هل يمكنك توضيحه؟
transform|Shorten: It is important that you remember to save the file before you close the program.|Save the file before closing the program.|اختصر: من المهم أن تتذكر حفظ الملف قبل أن تغلق البرنامج.|احفظ الملف قبل إغلاق البرنامج.
summary|The library will be closed Monday for repairs and reopen Tuesday. Summarize it.|The library reopens Tuesday after Monday's repair closure.|ستغلق المكتبة الاثنين للصيانة وتفتح الثلاثاء. لخص ذلك.|تفتح المكتبة الثلاثاء بعد إغلاقها للصيانة يوم الاثنين.
summary|Summarize: The customer ordered a lamp, but the store sent a chair by mistake.|The store mistakenly sent a chair instead of the ordered lamp.|لخص: طلب العميل مصباحًا لكن المتجر أرسل كرسيًا بالخطأ.|أرسل المتجر كرسيًا بالخطأ بدل المصباح المطلوب.
planning|Give me two ways to prepare for a short presentation.|Decide on the main message, then rehearse explaining it aloud.|أعطني خطوتين للاستعداد لعرض قصير.|حدد الرسالة الأساسية، ثم تدرب على شرحها بصوت مسموع.
planning|I have twenty minutes to organize a messy folder. Where do I begin?|Start by grouping files into a few clear categories, then name those groups consistently.|عندي عشرون دقيقة لترتيب مجلد فوضوي. من أين أبدأ؟|ابدأ بتجميع الملفات في فئات قليلة وواضحة، ثم سمّ المجموعات بطريقة موحدة.
clarify|Can you improve it a bit?|Please share what you want improved and the result you are aiming for.|تقدر تحسنه شوية؟|أرسل ما تريد تحسينه والنتيجة التي تسعى إليها.
clarify|Prepare a reply to him.|What did he say, and what do you want your reply to communicate?|جهز ردًا عليه.|ماذا قال، وما الفكرة التي تريد إيصالها في ردك؟
clarify|I need a recommendation.|What are you choosing, and what constraints should the recommendation respect?|أحتاج اقتراحًا مناسبًا.|ما الشيء الذي تختاره، وما الشروط التي ينبغي مراعاتها؟
uncertainty|Can you tell whether my friend is angry without seeing their message?|I don't have enough information to tell. Their actual words and context would help.|هل تعرف إن كان صديقي غاضبًا دون رؤية رسالته؟|المعلومات لا تكفي للحكم. ستساعد عباراته الفعلية وسياقها.
uncertainty|What exactly will I be doing next year?|I can't know your future activities, but I can help you plan toward a goal.|ماذا سأفعل تحديدًا السنة القادمة؟|لا أعرف أنشطتك المستقبلية، لكن يمكنني مساعدتك في التخطيط نحو هدف.
translation|Translate open the door into Arabic.|افتح الباب|ترجم افتح الباب إلى الإنجليزية.|Open the door.
translation|Translate have a nice day into Arabic.|أتمنى لك يومًا سعيدًا|ترجم أتمنى لك يومًا سعيدًا إلى الإنجليزية.|Have a nice day.
listening|I keep getting stuck and it's wearing me down.|Let's identify the exact point where progress stops and work on that part first.|كل مرة أتعطل في العمل وهذا أتعبني.|لنحدد النقطة التي يتوقف عندها التقدم ونعالج ذلك الجزء أولًا.
"""


def decode(value: str) -> str:
    return value.replace("\\n", "\n").strip()


def prompt(messages: list[dict[str, str]]) -> str:
    return "Mohassan chat v1\n" + json.dumps(messages, ensure_ascii=False, separators=(",", ":")) + "\nAssistant:\n"


def rows_from_cards() -> tuple[list[dict], int]:
    rows: list[dict] = []
    card_count = 0
    for card_count, line in enumerate(CARDS.strip().splitlines(), 1):
        category, en_questions, en_answer, ar_questions, ar_answer = line.split("|")
        for language, questions, answer in (("en", en_questions, en_answer), ("ar", ar_questions, ar_answer)):
            for variant, question in enumerate(questions.split("~"), 1):
                rows.append(record(f"card-{card_count:03d}-{language}-{variant}", language, category,
                                   [{"role": "user", "content": decode(question)}], decode(answer), "authored_card"))
    return rows, card_count


def record(identifier: str, language: str, category: str, messages: list[dict[str, str]], target: str, source: str) -> dict:
    assert language in {"ar", "en"}
    assert messages and messages[-1]["role"] == "user" and target.strip()
    assert all(message["role"] in {"user", "assistant"} and message["content"].strip() for message in messages)
    return {"id": identifier, "language": language, "capability": "chat.reply.v1", "category": category,
            "source": source, "messages": messages, "prompt": prompt(messages), "target": target}


def dialogue_rows() -> tuple[list[dict], int]:
    rows: list[dict] = []
    count = 0
    for count, line in enumerate(DIALOGUES.strip().splitlines(), 1):
        category, eu, ea, ef, et, au, aa, af, at = line.split("|")
        for language, first, answer, followup, target in (("en", eu, ea, ef, et), ("ar", au, aa, af, at)):
            messages = [{"role": "user", "content": decode(first)}, {"role": "assistant", "content": decode(answer)},
                        {"role": "user", "content": decode(followup)}]
            rows.append(record(f"dialogue-{count:03d}-{language}", language, category, messages, decode(target), "authored_dialogue"))
    return rows, count


def validation_rows() -> list[dict]:
    rows = []
    for index, line in enumerate(VALIDATION.strip().splitlines(), 1):
        category, ep, et, ap, at = line.split("|")
        for language, question, target in (("en", ep, et), ("ar", ap, at)):
            rows.append(record(f"development-{index:03d}-{language}", language, category,
                               [{"role": "user", "content": decode(question)}], decode(target), "authored_development"))
    return rows


def systematic_rows(split: str, count: int) -> list[dict]:
    """Eight bounded tasks per index; phrases and values differ between splits.

    These are template-generated examples, not independently authored dialogs.
    They teach explicit context and formatting behavior and cannot establish
    open-ended conversation ability.
    """
    rows: list[dict] = []
    training = split == "train"
    prefix = "REF-A" if training else "VFY-Z"
    names = ["Amina", "Tariq", "Salma", "Yusuf", "Nora", "Hadi", "Lina", "Kareem"] if training else ["Dalia", "Nabil", "Ruba", "Fadi"]
    arabic_names = ["أمينة", "طارق", "سلمى", "يوسف", "نورا", "هادي", "لينا", "كريم"] if training else ["داليا", "نبيل", "ربى", "فادي"]
    for index in range(count):
        code = f"{prefix}{index:03d}"
        replacement = f"{prefix}{index + count:03d}"
        en_name, ar_name = names[index % len(names)], arabic_names[index % len(arabic_names)]
        cases = [
            ("en", "memory", [
                ("user", f"My reference is {code}." if training else f"Keep this reference in our conversation: {code}."),
                ("assistant", f"Your reference is {code}." if training else f"I can refer to {code} in this conversation."),
                ("user", "What reference did I give you? Reply with the code only." if training else "Which reference did I mention? Give only its value.")], code),
            ("ar", "memory", [
                ("user", f"رمزي المرجعي هو {code}." if training else f"احتفظ بهذا المرجع داخل حديثنا: {code}."),
                ("assistant", f"الرمز المرجعي هو {code}." if training else f"يمكنني الرجوع إلى {code} في هذه المحادثة."),
                ("user", "ما الرمز الذي أعطيتك إياه؟ أجب بالرمز فقط." if training else "أي مرجع ذكرت لك؟ اكتب قيمته وحدها.")], code),
            ("en", "correction", [
                ("user", f"Use reference {code}." if training else f"At first, I selected {code}."),
                ("assistant", f"The reference is {code}." if training else f"Your initial selection was {code}."),
                ("user", f"Correction: use {replacement} instead. Return the current reference only." if training else f"I changed it to {replacement}. What is the new value? Only the value, please.")], replacement),
            ("ar", "correction", [
                ("user", f"استخدم المرجع {code}." if training else f"كان اختياري الأول {code}."),
                ("assistant", f"المرجع هو {code}." if training else f"اختيارك الأول كان {code}."),
                ("user", f"تصحيح: استخدم {replacement} بدلًا منه. أعد المرجع الحالي فقط." if training else f"بدلته إلى {replacement}. ما القيمة الجديدة؟ القيمة وحدها من فضلك.")], replacement),
            ("en", "copy", [("user", f"Copy this label exactly, with nothing added: {en_name}-{code}" if training else f"Repeat only the following label, preserving every character: {en_name}-{code}")], f"{en_name}-{code}"),
            ("ar", "copy", [("user", f"انسخ هذا العنوان كما هو دون إضافات: {ar_name}-{code}" if training else f"كرر العنوان التالي وحده مع الحفاظ على كل حرف: {ar_name}-{code}")], f"{ar_name}-{code}"),
            ("en", "structured_text", [("user", f"Name: {en_name}. Reference: {code}. Write them on two lines labelled Name and Reference." if training else f"Make two lines: Name for {en_name}, then Reference for {code}.")], f"Name: {en_name}\nReference: {code}"),
            ("ar", "structured_text", [("user", f"الاسم: {ar_name}. المرجع: {code}. اكتبهما في سطرين بعنوان الاسم ثم المرجع." if training else f"اجعلها سطرين: الاسم للقيمة {ar_name}، ثم المرجع للقيمة {code}.")], f"الاسم: {ar_name}\nالمرجع: {code}"),
        ]
        for case, (language, category, message_pairs, target) in enumerate(cases):
            messages = [{"role": role, "content": content} for role, content in message_pairs]
            rows.append(record(f"{split}-systematic-{index:03d}-{case}", language, category, messages, target, "systematic_template"))
    return rows


def audit(train: list[dict], validation: list[dict]) -> dict:
    for split, rows in (("train", train), ("validation", validation)):
        ids = [row["id"] for row in rows]
        assert len(set(ids)) == len(ids), f"Duplicate IDs in {split}"
        prompts = [row["prompt"] for row in rows]
        assert len(set(prompts)) == len(prompts), f"Duplicate prompts in {split}"
        for row in rows:
            assert row["prompt"] == prompt(row["messages"])
            assert row["messages"][-1]["role"] == "user"
    common_prompts = set(row["prompt"] for row in train) & set(row["prompt"] for row in validation)
    common_targets = set(row["target"] for row in train) & set(row["target"] for row in validation)
    assert not common_prompts, "Training/validation prompt overlap"
    assert not common_targets, f"Training/validation exact answer overlap: {sorted(common_targets)}"
    return {"exact_prompt_overlap": len(common_prompts), "exact_target_overlap": len(common_targets),
            "identifier_ranges_disjoint": True,
            "limitations": "Related tasks and templates occur in both splits. This is development validation, not an independent test or proof of generalization."}


def encode_rows(rows: list[dict]) -> bytes:
    return ("\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows) + "\n").encode("utf-8")


def build(destination: Path) -> dict:
    train, card_count = rows_from_cards()
    dialogues, dialogue_count = dialogue_rows()
    train.extend(dialogues)
    train.extend(systematic_rows("train", 240))
    validation = validation_rows() + systematic_rows("validation", 24)
    audit_result = audit(train, validation)
    random.Random(20261115).shuffle(train)
    random.Random(20261116).shuffle(validation)
    manifest = {"schema_version": 1, "curriculum": "mohassan-conversation-v1", "task": "chat.reply.v1",
                "provenance": {"kind": "synthetic_agent_authored", "external_model_calls": 0, "external_pretrained_weights": False,
                               "downloads": 0, "human_conversations": False,
                               "authored_bilingual_task_cards": card_count, "explicit_phrasings_per_language_per_card": 2,
                               "authored_bilingual_multiturn_dialogues": dialogue_count,
                               "systematic_task_templates_per_language": 4,
                               "note": "Authored wording and template expansions are training material, not independently verified ground truth."},
                "prompt_format": "Mohassan chat v1\\n + compact JSON messages (ensure_ascii=False) + \\nAssistant:\\n",
                "split_audit": audit_result,
                "scope": "Initial short dialogue, context recall, corrections, clarification, explanations, writing and transformations in Arabic/English.",
                "limitations": ["Small synthetic curriculum; not broad conversation training.",
                                "Templates are deliberately repetitive; row count is not task diversity.",
                                "No independent test cases or model outputs are included.",
                                "No medical, legal or financial expertise claim.",
                                "Training and validation loss cannot establish phone-chat readiness."],
                "splits": {}}
    encoded = {}
    for split, rows in (("train", train), ("validation", validation)):
        data = encode_rows(rows)
        encoded[split] = data
        manifest["splits"][split] = {"rows": len(rows), "languages": dict(Counter(r["language"] for r in rows)),
                                      "categories": dict(sorted(Counter(r["category"] for r in rows).items())),
                                      "sources": dict(sorted(Counter(r["source"] for r in rows).items())),
                                      "multi_turn_rows": sum(len(r["messages"]) > 1 for r in rows),
                                      "sha256": hashlib.sha256(data).hexdigest()}
    destination.mkdir(parents=True, exist_ok=False)
    for split, data in encoded.items():
        (destination / f"{split}.jsonl").write_bytes(data)
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("artifacts/chat-training/conversation-v1/dataset"))
    args = parser.parse_args()
    result = build(args.output)
    print(json.dumps({"output": str(args.output.resolve()), "splits": result["splits"], "audit": result["split_audit"]}, ensure_ascii=False, indent=2))
