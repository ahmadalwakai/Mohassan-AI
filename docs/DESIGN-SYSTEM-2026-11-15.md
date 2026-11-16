# مقترح توحيد تصميم موحسن — 2026-11-15

**المرحلة الأولى فقط — بانتظار موافقة المالك.** أُنجز التدقيق في 2026-11-16 بتوقيت لندن؛ بقي اسم الملف بالتاريخ المطلوب. لم يُعدّل أي CSS أو TSX أو TS أو اختبار. المخرج الوحيد في هذه المرحلة هو هذا التقرير.

## 1. التدقيق وحدوده

قُرئ apps/web/AGENTS.md أولًا، ثم دليل CSS المحلي للنسخة المثبتة من Next.js في node_modules/next/dist/docs/01-app/01-getting-started/11-css.md. التدقيق على نسخة العمل الحالية، بما فيها تعديلات الوكلاء الآخرين القائمة؛ لم تُستبدل بفرع آخر ولم تُمس حالة Git.

النطاق: apps/web/app/globals.css و15 ملفًا من apps/web/components/*.module.css. استُبعد chrome-extension-panel.* وai-providers.*. لم تُعدّل packages أو apps/server أو مجلدات التدريب أو أي worktree. مصدر iOS قُرئ فقط. لم تُقرأ .env ولم يُشغّل التطبيق أو الاختبارات أو Python أو GPU.

### تصحيح القياسات الأولية

- globals.css:1 يعرّف المجموعة القديمة: --ink، --text، --muted، --green، --green-dark، --mint، --line، --surface، --background.
- المجموعة --page / --panel / --raised / --soft / --faint / --accent / --alert موجودة محليًا في .app داخل assistant-app.module.css:1، والداكن في السطر 29. ليست حاليًا رموزًا عالمية؛ لذلك لا تصل تلقائيًا إلى مساحة الأدوات أو النوافذ التي تُنشأ خارج هذا الأصل.
- browser-files-panel لا يحتوي ألوانًا خامًا أصلًا، ويرث الداكن داخل المحادثة. campaign-card يستخدم الرموز مع استثناء تحذير له قيمتان فاتحة وداكنة. agent-activity يرث --accent مع لون احتياطي خام واحد.
- أربعة ملفات تحتوي prefers-reduced-motion فعلًا، لكن القاعدة العامة تصل إلى بقية الملفات. المشكلة في كفاية البديل، وليست غياب الاستعلام المحلي وحده.
- app/layout.tsx يثبت lang=ar وdir=rtl، ويحمّل IBM Plex Sans Arabic في --font-chat. body يستخدم Segoe UI حاليًا، بينما المحادثة تستخدم الخط العربي؛ هذا مصدر اختلاف ملموس آخر.

### طريقة العد

استُخدم Node وPostCSS لقراءة التصريحات دون تعديلها. «ورود لون» هو قيمة hex أو rgb/hsl أو اسم لون صريح، بما في ذلك ألوان الظلال والتدرجات وfallback داخل var. تُستثنى تعريفات custom properties نفسها، وtransparent وcurrentColor. لذلك لا تشمل الأعداد ألوان لوحة الرموز المسموح تعريفها في globals. يُحسب كل ورود مكرر، بما في ذلك media queries؛ وقد يجتمع لونان في تصريح واحد.

أحجام النص تحصي تصريحات font-size الصريحة بالبكسل الأقل من 12، لا عدد عناصر DOM ولا عدد العناصر المرئية. قيم .88em وclamp تحتاج حسابًا حسب السياق. الخصائص الفيزيائية تحصي left/right ومشتقاتهما وtext-align:left/right؛ لا تعني كل واحدة خلل RTL. الأعداد لقطة مرجعية وليست ضمانًا لبقاء الملفات ثابتة أثناء عمل الآخرين.

**الحصيلة: 946 ورود لون خارج الرموز في 941 تصريحًا؛ 287 تصريح خط أصغر من 12px من أصل 585 تصريح font-size؛ 74 تصريح اتجاه فيزيائي.**

| الملف | ورود الألوان / تصريحاتها | خط أقل من 12px | خصائص يمين/يسار | داكن حاليًا | تقليل حركة محلي |
|---|---:|---:|---:|---|---|
| globals.css | 500 / 496 | 174 | 56 | لا يوجد نظام داكن متكامل | نعم |
| agent-activity.module.css | 1 / 1 | 0 | 5 | يرث رموز المحادثة عند وجوده داخلها | نعم |
| assistant-app.module.css | 5 / 5 | 1 | 1 | نعم، قاعدة صريحة | نعم |
| browser-files-panel.module.css | 0 / 0 | 1 | 0 | يرث رموز المحادثة عند وجوده داخلها | يرث القاعدة العامة |
| browser-open-result.module.css | 17 / 17 | 2 | 2 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |
| browser-workspace.module.css | 49 / 49 | 9 | 4 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |
| campaign-card.module.css | 8 / 8 | 0 | 0 | نعم، قاعدة صريحة | نعم |
| capability-evolution.module.css | 19 / 19 | 0 | 0 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |
| executor-workspace.module.css | 46 / 46 | 10 | 0 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |
| google-ads-workspace.module.css | 13 / 13 | 16 | 1 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |
| members.module.css | 13 / 13 | 2 | 0 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |
| memory-workspace.module.css | 67 / 67 | 23 | 1 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |
| skill-library.module.css | 61 / 60 | 7 | 1 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |
| studio-ai-panel.module.css | 47 / 47 | 19 | 0 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |
| studio-live-panel.module.css | 26 / 26 | 3 | 0 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |
| windows-workspace.module.css | 74 / 74 | 20 | 3 | لا يوجد نظام داكن متكامل | يرث القاعدة العامة |

الداكن: ملفان لهما override صريح، وملفان إضافيان يتكيفان بوراثة المحادثة. يبقى 11 module وglobals بلا نظام داكن متكامل. هذه تغطية مصدرية: **لم يُعتمد أي قسم باعتباره ناجحًا بصريًا في الوضع الداكن بعد**. غياب الاستعلام من ملف لا يساوي فشل الداكن إذا كان الملف يستخدم رموزًا موروثة.

### تشتت المقاييس

- radius: عدد التصريحات 266؛ عدد القيم المفردة المختلفة 21: 3،4،5،6،7،8،9،10،11،12،13،14،15،16،18،20،22،25،30،999px و50%.
- المسافات: 1207 تصريحات margin/padding/gap ومشتقاتها؛ 62 قيمة مفردة تشمل السالب والصفر وauto و6.6vw و8vh و12vh. الأرقام الكبيرة مثل 248px قد تكون إزاحة تخطيط للشريط الجانبي، وليست مسافة مكوّن؛ لا تُقرب عميانيًا إلى سلم المسافات.
- النوع: 32 صيغة font-size، منها 29 حجمًا ثابتًا بين 7px و34px، و.88em وصيغتا clamp. السلم الحالي يشمل أنصاف بكسل مثل 12.5 و13.5 و14.5 و16.5.
- line-height: 15 قيمة: 1،1.3،1.4،1.5،1.55،1.6،1.65،1.7،1.75،1.8،1.85،1.9،1.95،2،2.1.
- الحركة: 15 قيمة زمنية: .01ms، .14s، .16s، .18s، .2s، .22s، .24s، .25s، .3s، .4s، .45s، 1.2s، 1.3s، 1.5s، 1.8s. .01ms خاصة ببديل تقليل الحركة.
- الظلال: 25 تصريح box-shadow في globals (9)، assistant-app (14)، campaign-card (1)، skill-library (1). بعضها حلقة تركيز، فلا تُعامل كلها كارتفاع بصري.
- الطبقات: تسعة أرقام z-index: 1،2،5،10،19،20،30،40،60.

القيم حسب الملف موجودة كاملة في الملحق أ. وفيما يلي أمثلة قابلة للتتبع للنص الصغير:

| الملف | مثال من النص الصغير: المحدّد، الحجم، السطر |
|---|---|
| globals.css | .eyebrow؛ 11px؛ سطر 27 / .brand small؛ 10px؛ سطر 39 / .auth-version؛ 9px؛ سطر 56 |
| assistant-app.module.css | .dockHint kbd؛ 11px؛ سطر 249 |
| browser-files-panel.module.css | .url؛ 11px؛ سطر 13 |
| browser-open-result.module.css | .result pre؛ 10px؛ سطر 4 / .figure figcaption؛ 11px؛ سطر 12 |
| browser-workspace.module.css | .address؛ 11px؛ سطر 1 / .link؛ 11px؛ سطر 1 / .history؛ 11px؛ سطر 1 |
| executor-workspace.module.css | .intro span؛ 10px؛ سطر 3 / .workspace :global(.secondary-button)؛ 11px؛ سطر 8 / .card dl,.attribution؛ 11px؛ سطر 13 |
| google-ads-workspace.module.css | .intro span؛ 10px؛ سطر 5 / .accounts small؛ 11px؛ سطر 19 / .account small؛ 11px؛ سطر 24 |
| members.module.css | .copy code؛ 11px؛ سطر 7 / .list small؛ 11px؛ سطر 13 |
| memory-workspace.module.css | .intro span؛ 11px؛ سطر 1 / .root button؛ 11px؛ سطر 1 / .metrics span؛ 11px؛ سطر 1 |
| skill-library.module.css | .eyebrow؛ 11px؛ سطر 6 / .metadata dt؛ 11px؛ سطر 42 / .hash؛ 11px؛ سطر 44 |
| studio-ai-panel.module.css | .heading p؛ 11px؛ سطر 1 / .heading>span؛ 10px؛ سطر 1 / .form label؛ 11px؛ سطر 1 |
| studio-live-panel.module.css | .badge؛ 10px؛ سطر 1 / .selection code؛ 11px؛ سطر 1 / .button؛ 11px؛ سطر 1 |
| windows-workspace.module.css | .intro span؛ 10px؛ سطر 1 / .toolbar>span؛ 11px؛ سطر 1 / .pairing small؛ 11px؛ سطر 1 |

أسوأ مثال للهاتف: globals.css:636–639 يجعل عنوان المهمة 10px والوصف 8px والحالة والتوقيت 7px؛ والنص في الوصف مقيد أيضًا بعرض 120px مع اختصار. قواعد الهاتف المتأخرة قد تتجاوز تحسينًا في القاعدة الأساسية.

### مساحات اللمس عند عرض 375px

**جرد CSS ساكن، وليس قياس getBoundingClientRect في متصفح.** توجد 8 مجموعات محدّدات تثبّت بُعدًا دون 44px، و19 مجموعة أخرى تضع min-height أقل من 44px. الأخير لا يثبت أن الارتفاع النهائي صغير؛ قد يكبر بسبب النص أو padding. تفعيل media query عند 375px مستنتج من شروطه. تكرار العناصر، ظهورها، تداخلها ومساحة label تحتاج فحصًا فعليًا في المرحلة الثانية.

| مجموعات ذات بُعد ثابت صغير | القيمة | المصدر |
|---|---|---|
| .icon-button | 34×34px | globals.css:29 |
| .profile-row .icon-button | عرض 28px | globals.css:107 |
| .mobile-toggle | عرض 28px عند الهاتف | globals.css:609 |
| .studio-color-fields input[type=color] | ارتفاع 36px | globals.css:720 |
| .iconButton | 34×34px | assistant-app.module.css:55 |
| .itemMenuButton | 28×28px | assistant-app.module.css:97 |
| .send, .stop | 36×36px | assistant-app.module.css:264 |
| checkbox في .root و.dialog | 17×17px؛ label قد يوسّع الهدف | skill-library.module.css:19 |

المجموعات التسع عشرة ذات حد أدنى صغير: globals:31/136/269/616/693؛ browser-workspace:1؛ campaign-card:20/28؛ executor-workspace:8؛ members:8؛ memory-workspace:1 ثلاث قواعد (.root button، .form select، .actions button)؛ skill-library:10/16/79؛ studio-ai-panel:1 قاعدتان (.mode select و.panel .primary)؛ windows-workspace:3.

44×44 هو شرط هذه المهمة. ليس كل هدف أقل من 44 مخالفة AA تلقائية؛ معيار 44×44 هو [حجم الهدف المحسّن AAA](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html). سنعتمده هنا لكل تحكم مستقل، دون تكبير الرابط داخل فقرة بما يفسد السطور.

### التركيز بلوحة المفاتيح

خمسة ملفات تذكر :focus-visible في ست قواعد: globals، assistant-app، campaign-card، skill-library، capability-evolution. القاعدة العامة في globals.css:21 تشمل button/input/textarea/select/a، لذلك لا يصح وصف كل module آخر بأنه بلا تركيز.

الفجوات المحددة:

1. 14 ظهورًا لـsummary عبر سبعة مكونات بلا نمط تركيز مؤلف يغطيها: assistant (1)، browser-files (2)، browser-open-result (1)، browser-workspace (6)، windows (2)، memory (1)، studio-ai (1). قد توجد حلقة المتصفح الافتراضية؛ لم تُفحص على الشاشة.
2. assistant-app:258 يلغي outline لحقل الكتابة. البديل على .composer:focus-within ضعيف التباين. كذلك .otherAnswer:focus و.field input:focus يستبدلان outline بألوان وحدود مختلفة.
3. studio-ai-panel:1 يخفي input الرفع بـopacity:0؛ حلقة input نفسها تختفي معه. العلاج CSS على .upload:focus-within.
4. .search-input input في globals يزيل outline؛ يلزم فحص cascade الفعلي. عنوان المهارة الذي يستقبل تركيزًا برمجيًا tabIndex=-1 حالة مختلفة عن عنصر يصل إليه Tab.
5. الحلقة العامة #55ad92 على الأبيض لا تحقق 3:1؛ وجود outline في المصدر لا يكفي.

### التباين في الفاتح والداكن

اعتمد الحساب معادلة WCAG للإنارة النسبية في sRGB. الحد 4.5:1 للنص العادي، و3:1 للنص الكبير (24px عادي أو نحو18.67px عريض) وللدلالات الضرورية في عناصر التحكم. الحدود الزخرفية والأزرار المعطلة ليست فشلًا تلقائيًا. المراجع: [تباين النص AA](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) و[تباين عناصر التحكم AA](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

هذه **18 حالة نص مختارة محسوبة من المصدر**، وليست إحصاءً شاملًا لكل فشل مرئي. أول ثلاث حالات لها زوجان مختلفان؛ الإجمالي 21 زوج نص محسوبًا، وكلها دون 4.5. بعض الخلفيات موروثة ومتوقعة من الأب، فتحتاج تأكيد DOM. الأقسام القديمة تبقى فاتحة عند اختيار الداكن؛ لا توجد لوحة داكنة فعلية جديدة يمكن قياسها هناك.

| الملف / المحدّد | لون النص / الخلفية في الفاتح | النسبة فاتح | عند تفضيل الداكن |
|---|---|---:|---|
| assistant-app:81 .historyLabel | #9a968c / #f4f2ed | 2.64 | #77746c / #181715 = 3.84 |
| assistant-app:248 .dockHint | #9a968c / #faf9f6 | 2.80 | #77746c / #1e1d1b = 3.61 |
| assistant-app:259 placeholder | #9a968c / #ffffff | 2.95 | #77746c / #292825 = 3.16 |
| globals:26 .muted على body | #7d8c88 / #f7f8f5 | 3.30 | نفس اللونين الفاتحين |
| google-ads-workspace:19 .accounts small | #7d8c88 / #ffffff | 3.51 | نفس الزوج |
| executor-workspace:14 .card dt | #8597a5 / #ffffff | 3.01 | نفس الزوج |
| executor-workspace:30 .mode small | #7a8e9d / #ffffff | 3.40 | نفس الزوج |
| windows-workspace:1 .empty p | #819078 / #fcfdf9 | 3.32 | نفس الزوج |
| browser-workspace:1 .notice | #827342 / #faf8ec | 4.40 | نفس الزوج |
| browser-workspace:1 .hash على .source | #8a9880 / #ffffff | 3.05 | نفس الزوج |
| memory-workspace:1 .form small | #88917d / #ffffff | 3.28 | نفس الزوج |
| memory-workspace:1 .mutedBadge | #93866c / #f0eee6 | 3.08 | نفس الزوج |
| members:13 .list small | #7d8b83 / #ffffff | 3.56 | نفس الزوج؛ تأكيد الأب مطلوب |
| studio-ai-panel:1 .heading p | #85947a / #ffffff | 3.22 | نفس الزوج |
| studio-ai-panel:1 .metric | #869676 / #f5f8f0 | 2.95 | نفس الزوج |
| studio-live-panel:1 .header p,.note | #7b8e72 / #ffffff | 3.53 | نفس الزوج |
| studio-live-panel:1 .notice | #807348 / #f8f7e9 | 4.36 | نفس الزوج |
| globals:709 .studio-frame-label | #71806c / #fafcf8 | 4.06 | نفس الزوج |

| حالة تحكم / تركيز | الفاتح | الداكن | الحكم |
|---|---:|---:|---|
| حلقة globals #55ad92 مقابل raised | 2.70 | 5.46 مقابل #292825 | فشل الفاتح |
| --line مقابل --raised لحقول chat/browser-files | 1.27 | 1.15 | فشل إذا كان الحد الدليل الوحيد لتمييز الحقل |
| حد .stack-form #dfe5dd على الأبيض | 1.28 | يبقى فاتحًا | فشل إذا كان الحد مطلوبًا لتحديد الحقل |

الفشل المتبقي الآن لم يتغير؛ لا إصلاحات في هذه المرحلة. التدرجات، الصور، الشفافية، الحالات المعطلة، والحالات التي لا توجد في قاعدة فارغة لم تُراجع بصريًا. لا ندّعي اجتياز النص الكبير أو جميع التحكمات لمجرد نجاح بعض الأزواج.

### اتجاه العربية

74 تصريحًا فيزيائيًا موزعة كما في الجدول، وليست 74 مشكلة مثبتة. التحويل الدلالي المطلوب يشمل:

| الموضع | التحويل المقترح |
|---|---|
| globals .sidebar، .workspace-body عبر نقاط التوقف | right إلى inset-inline-start؛ border-left إلى border-inline-end؛ margin-right إلى margin-inline-start، بحسب اتجاه الأصل |
| globals .nav-count | margin-right:auto إلى margin-inline-start:auto |
| القوائم ذات padding-right والنص العربي text-align:right | padding-inline-start وtext-align:start |
| browser-workspace .source blockquote و.approval ul | border-inline-start وpadding-inline-start |
| memory .close | left إلى inset-inline-end |
| windows .device، .deviceSelected | text-align:start |
| assistant .stepList: margin:2px 12px 0 0 | مسافات block/inline صريحة؛ هذا الاختصار غير داخل العدد74 |

تُراجع حدود .permissions و.studio-inspector مع direction المحلي؛ workbench يستخدم LTR عمدًا وأطفاله RTL. تُحفظ إحداثيات الرسوم المدارية، أرباع مؤشر النشاط، توسيط toast بـleft:50% مع translateX(-50%)، ومحتوى code/URL ذي LTR حين تكون هندسية أو نصًا تقنيًا. لا نعكسها آليًا.

### الحركة وتقليلها

30 تصريح animation/transition: 24 فعالة و6 ضمن بدائل تقليل الحركة. تسعة keyframes: globals(1)، assistant(6)، agent-activity(2)، وجميعها تحرّك transform/opacity بالفعل.

خمس حركات infinite: .spin العامة؛ .livePip و.shimmer في المحادثة؛ .dots و.spinner في agent-activity. ثلاث قواعد انتقال تخالف طلب الاقتصار على transform/opacity: button العامة (لون وخلفية وحدود وظل)، .stack-form (لون حد)، .composer (حد وظل). يتغير لون الحالة مباشرة بعد الإصلاح.

القاعدة العامة في globals:731 تقصّر المدة إلى .01ms وتُبقي infinite؛ هذا ليس إيقافًا سليمًا. قواعد chat/campaign/agent توقف الحركة صراحة. scroll-behavior:smooth موجود في html، وبديله auto موجود.

يوجد أيضًا انتقال JavaScript في workspace.tsx:403 بمدة0.3s وopacity/y. Providers يستخدم MotionConfig reducedMotion="user"؛ لا يصح عدّه غائبًا تمامًا، ولا افتراض أن CSS وحده يضبط كل opacity أو مدة ينفذها JavaScript. توحيده التام مع الرموز وتعطيله التام عند الطلب **مقترح TSX خارج نطاق هذه المهمة**.

## 2. النظام المقترح، صغير ومحدد

المرجع البصري هو محادثة موحسن الحالية المشتركة مع الهاتف: أسطح دافئة محايدة، لون أخضر للإجراء، حدود هادئة، ونص عربي واضح. لا لون مستقل لكل أداة ولا زخارف متحركة جديدة.

### أدوار اللون

تنتقل ملكية الرموز إلى :root في globals.css، مع قيم الداكن تحت prefers-color-scheme:dark. تُلغى إعادة تعريف القيم المحلية المتعارضة في .app، مع إبقاء أسماء الأصناف وترتيب بقية القواعد. تُراجع النوافذ الأصلية والبوابات Portals لضمان وراثة الجذر. يضاف color-scheme مناسب للتحكمات الأصلية.

| الرمز | الفاتح | الداكن | الاستخدام |
|---|---|---|---|
| --page | #faf9f6 | #1e1d1b | الصفحة |
| --panel | #f4f2ed | #181715 | الشريط والسطح الثانوي |
| --raised | #ffffff | #292825 | بطاقة، حقل، نافذة |
| --ink | #22201c | #edebe5 | النص الأساسي |
| --soft | #5f5b53 | #b8b3a9 | النص الثانوي؛ تقوية القيم الحالية |
| --faint | #6b675f | #a6a298 | الوصف القصير وplaceholder؛ تقوية القيم الحالية |
| --line | #e7e4dc | #34322d | فواصل زخرفية فقط |
| --hover | #ebe8e0 | #2e2c28 | تحويم واختيار محايد |
| --accent | #1f6f5c | #4fb596 | الإجراء الأساسي |
| --accent-hover | #185a4a | #63c4a6 | تحويم الإجراء |
| --accent-soft | #e3efe9 | #1f3a31 | اختيار/تأكيد خفيف |
| --accent-ink | #ffffff | #0f1f1a | النص على الإجراء |
| --user | #efece4 | #2e2c28 | رسالة المستخدم |
| --alert | #a33a2c | #ee9383 | خطأ أو إجراء خطر |
| --alert-soft | #fbeae6 | #3a221d | خلفية الخطأ |
| --success | #216b45 | #75c797 | نجاح |
| --success-soft | #e7f2eb | #1c3528 | خلفية النجاح |
| --warning | #80550b | #edc06b | تحذير |
| --warning-soft | #fff3d8 | #3b301c | خلفية التحذير |
| --info | #225d86 | #8dc8f2 | معلومة |
| --info-soft | #e8f1f8 | #1d3040 | خلفية المعلومة |
| --focus-ring | #1f6f5c | #63c4a6 | حلقة التركيز |
| --overlay | rgb(18 20 18 / 40%) | rgb(0 0 0 / 60%) | خلفية حجب النافذة |

الإضافات هي الأدوار الناقصة فقط: نجاح/تحذير/معلومة مع أسطحها، حلقة التركيز، وoverlay لأن خلفية الحجب لا تمثلها الأسطح المصمتة الحالية. لا يُنشأ لون لكل قيمة hex قديمة. حد الحقل يستخدم --faint، وبذلك لا نحتاج رمز control-line إضافيًا؛ تبقى --line للفواصل التي لا تحدد تفاعلًا.

تباين أزواج التنبيه المقترحة محسوب: نجاح5.62/6.53، تحذير5.92/7.60، معلومة6.17/7.54 (فاتح/داكن). تُختبر كل حالة hover/focus/default مع الخلفية الفعلية، ولا يُسمح باستخدام --faint فوق خلفية دلالية لم تُقَس. التركيز outline بعرض2px وإزاحة3px، مع سطح يترك فاصلًا واضحًا عند الأزرار الملونة.

الأسماء القديمة تبقى aliases كي لا نغير markup أو مستهلكًا خارج النطاق:

| الاسم القديم | المرجع المعتمد |
|---|---|
| --background | var(--page) |
| --surface | var(--raised) |
| --text | var(--soft) |
| --muted | var(--faint) |
| --green | var(--accent) |
| --green-dark | var(--accent-hover) |
| --mint | var(--accent-soft) |

--ink و--line موجودان أصلًا؛ تُوحد قيمهما. نراجع مواضع --green-dark التي كانت خلفيات داكنة مع نص أبيض، ونستخدم اقتران --accent-ink الصحيح في الداكن. الاستبدال دلالي، لا بحث واستبدال أعمى.

### المقاييس

| المجموعة | الرموز والقيم المعتمدة | القاعدة |
|---|---|---|
| الاستدارة، ثلاث خطوات | --radius-sm:8px؛ --radius-md:12px؛ --radius-lg:16px | صغير للزر/الحقل/الشارة؛ متوسط للبطاقة؛ كبير للنافذة والحاوية الرئيسية |
| المسافات | --space-0:0؛ --space-1:4px؛ --space-2:8px؛ --space-3:12px؛ --space-4:16px؛ --space-5:20px؛ --space-6:24px؛ --space-8:32px؛ --space-10:40px؛ --space-12:48px؛ --space-16:64px | سلم واحد بوحدة4px؛ السالب عند الحاجة calc للرمز نفسه؛ العرض/نقطة التوقف ليست مسافة |
| النوع، ستة أحجام | --type-xs:.75rem (12px)؛ --type-sm:.875rem (14px)؛ --type-md:1rem (16px)؛ --type-lg:1.25rem (20px)؛ --type-xl:1.5rem (24px)؛ --type-2xl:2rem (32px) | عند جذر16px؛ لا خفض لحجم الجذر؛ 12 للتفاصيل فقط، 14 للعناوين الصغيرة والتحكمات،16 للنص والحقل |
| ارتفاع السطر | --leading-body:1.8؛ --leading-heading:1.5؛ --leading-control:1.6 | لا حاويات نص بارتفاع ثابت يقطع التشكيل |
| الخط | --font-ui:var(--font-chat), "Segoe UI", Tahoma, Arial, sans-serif | تعميم الخط العربي المحمل أصلًا؛ code يبقى monospace |
| هدف اللمس | --target-min:44px | min-inline-size/min-block-size للتحكمات المستقلة |
| الطبقات | --layer-base:0؛ --layer-sticky:10؛ --layer-menu:20؛ --layer-scrim:30؛ --layer-modal:40؛ --layer-toast:50 | مراعاة stacking context؛ dialog الأصلي في top layer لا يعتمد على هذه الأرقام وحدها |
| الحركة | --duration-fast:120ms؛ --duration-base:200ms؛ --duration-slow:320ms؛ --ease:cubic-bezier(.2,.7,.2,1) | التفاصيل أدناه |

50% مسموح لشكل دائرة حقيقي (صورة/نقطة نشاط)، و0 عند وصل الحواف؛ ليسا درجتين تجميليتين إضافيتين. تُستبدل كبسولات999px بالشارة الصغيرة المستديرة. لا يُغيّر حجم الصورة أو viewport أو ارتفاع iframe لمجرد إدخاله في سلم المسافات.

| الظل | فاتح | داكن |
|---|---|---|
| --shadow-sm | 0 1px 2px rgb(30 25 15 / 5%), 0 2px 8px rgb(30 25 15 / 4%) | 0 1px 2px rgb(0 0 0 / 30%) |
| --shadow-lg | 0 12px 40px rgb(30 25 15 / 16%), 0 2px 6px rgb(30 25 15 / 6%) | 0 16px 48px rgb(0 0 0 / 50%) |

الظل الصغير فقط لبطاقة مرتفعة أو شريط الكتابة، والكبير للقائمة/النافذة. البطاقات العادية تعتمد الحد والمسافة. حلقة التركيز outline لا تُضاف كدرجة ظل ثالثة.

### أنماط مشتركة دون تغيير الأصناف أو النصوص

تُطبّق الوصفة نفسها على المحدّدات الحالية؛ لا تُنشأ مكونات React أو أسماء أصناف جديدة.

| النمط | الوصفة الواحدة المعتمدة |
|---|---|
| الزر | حد أدنى44×44؛ radius-sm؛ padding-inline space-4؛ نص type-sm/600؛ gap space-2. الأساسي accent/accent-ink، الثانوي raised/ink وحد faint، الخطر alert-soft/alert. hover فوري؛ التعطيل ظاهر ولا يضيف حركة |
| الحقل | raised/ink؛ حد1px faint؛ radius-sm؛44px أدنى؛ padding space-2/space-3؛ type-md؛ placeholder faint؛ حلقة التركيز نفسها |
| البطاقة | raised/ink؛ حد1px line؛ radius-md؛ padding space-4 للهاتف وspace-5 للواسع؛ gap space-3؛ min-width:0 ولف النص الطويل |
| رأس اللوحة | عنوان type-lg/600 ووصف type-sm/soft؛ gap space-3؛ أفعال تلتف إلى سطر مستقل عند375px |
| التبويبات |44px أدنى؛ type-sm/600؛ المختار accent-soft/accent مع حد/علامة مرئية؛ لا تغيّر ترتيب Tab أو دلالة aria |
| الشارة | type-xs/600؛ padding space-1/space-2؛ radius-sm؛ نص يلتف؛ اللون حسب الحالة. إن كانت زرًا تطبق44px |
| التنبيه | info/success/warning/alert مع soft الموافق؛ حد من لون الدور؛ radius-md؛ padding space-3؛ سطر1.8؛ يحتفظ بالأيقونة والنص الحاليين |
| الفراغ | عنوان type-lg؛ وصف type-sm/soft؛ مساحة space-6؛ الإجراء الحالي بحجم44px؛ لا رسوم متحركة |
| التحميل | موضع ثابت لا يقفز معه التخطيط؛ نص الحالة الحالي؛ مؤشر واحد فقط للنشاط الجاري. البديل قليل الحركة مؤشر ثابت |

## 3. قواعد الحركة

- تُستخدم الحركة لتفسير تغير حالة، أو وصول محتوى، أو تقدم عملية حية فقط. تُلغى الزخرفة والحركة التلقائية غير المفسرة.
- fast=120ms لتغير صغير في اتجاه سهم أو ظهور قائمة قصيرة؛ base=200ms لوصول رد/بطاقة/تنبيه؛ slow=320ms لفتح لوحة جانبية كبيرة. easing واحد --ease.
- transform وopacity فقط. لا انتقال ألوان أو box-shadow أو height/width أو padding. تبقى حالات hover/focus فورية وواضحة.
- لا دوران/وميض متكرر إلا لمؤشر نشاط فعلي، يتوقف فور توقف النشاط. دورة المؤشر calc(var(--duration-slow) * 4) =1280ms، مشتقة من الدرجات الثلاث وليست مدة رابعة مستقلة. لا skeleton متكرر للزينة.
- في RTL تدخل اللوحة من inline-start، أي اليمين، وتخرج إلى اليمين. إن احتاج مكوّن تنقلًا أفقيًا بين مراحل، يتبع التقدم جهة القراءة إلى اليسار والعودة إلى اليمين. الحركة الرأسية القصيرة لا تُعكس، وتوسيط toast يبقى هندسيًا.
- عند prefers-reduced-motion:reduce: animation:none وtransition:none وscroll-behavior:auto؛ يبقى المحتوى ظاهرًا والحالة واضحة، دون تصغير مدة infinite إلى .01ms. لا يُصفّر transform الثابت اللازم للتوسيط أو للإخفاء؛ تتغير الحالة النهائية فورًا.
- حالات الدخول الموجودة في CSS يمكن توحيدها. حركة الخروج لعنصر يزال مباشرة من DOM تحتاج إبقاءه لحين انتهاء الخروج؛ هذا تغيير markup/سلوك مقترح فقط. لا نضيف حركة خروج وهمية لا تُنفذ.
- انتقالات Motion/Chakra الخارجية تحتاج تحققًا على الشاشة. ما لا يمكن توحيده من CSS يسجل كاستثناء يحتاج موافقة مستقلة على TSX؛ موافقة هذا المقترح لا ترفع حظر TSX.

## 4. سهولة الاستخدام حسب أثرها على المالك

| الأولوية | الشاشة | ما سيشعر به المالك / الدليل | الإصلاح | النوع |
|---|---|---|---|---|
| 1 | قائمة المهام في375px | معلومات الحالة والوقت7px والوصف8px؛ يضيع سبب المهمة |12px أدنى، توزيع البيانات على سطر ثان، لف الوصف بدل اختصاره بعرض120px | CSS فقط |
| 2 | المحادثة وشريط الهاتف | يصعب ضغط القائمة/الإرسال/الإيقاف؛ أبعاد28–36px |44px للتحكم مع إبقاء حجم الأيقونة، وإعادة توزيع المسافات دون تداخل | CSS فقط |
| 3 | الانتقال من المحادثة للأدوات | اختلاف الخط واللون والداكن يوحي بأنها تطبيقات منفصلة | الجذر الموحد والخط الحالي المحمل والأسطح المشتركة | CSS فقط |
| 4 | الأوصاف والتنبيهات والحقول | نص باهت وحلقة تركيز ضعيفة؛ أمثلة التباين أعلاه | رموز النص المقوية وحدود حقول مرئية وتنبيهات متسقة | CSS فقط |
| 5 | الأدوات المتقدمة | الوصول يتطلب قائمة الحساب ثم الأدوات؛ صعوبة اكتشاف | مدخل دائم واضح للأدوات أو اختصار تنقل | يحتاج markup؛ اقتراح فقط |
| 6 | المهارات والأعضاء والتنفيذ | تحكمات36–40px وتفاصيل10–11px | الحد44، السلم الطباعي، ومساحة label مناسبة للـcheckbox | CSS فقط إن كان الربط بالـlabel موجودًا |
| 7 | الاستوديو | أزرار اللون36px وتسميات معاينة8–10px؛ رفع الملف يخفي التركيز | هدف44، تسميات12، التفاف toolbar، focus-within للرفع | CSS فقط |
| 8 | المتصفح وويندوز والذاكرة | المخرجات الطويلة والنماذج قد تضيق على الهاتف | الحفاظ على min-width:0 ولف الروابط، تمرير محلي للشيفرة؛ اختبار375 | CSS فقط؛ overflow الحالي غير مثبت بصريًا |
| 9 | الانتظار والتنقل | أساليب تحميل مختلفة وحركة عامة لا تتوقف تمامًا | مؤشر نشاط موحد وبديل ثابت وقطع انتقالات اللون | CSS للحركات المحلية؛ TSX لحركة JavaScript |
| 10 | لوحة المفاتيح وقارئ الشاشة | summary بلا حلقة مؤلفة، وقد تحتاج التنبيهات دلالة إضافية | توحيد التركيز الآن؛ aria-live/status أو أسماء أزرار إن ثبت نقصها بالتدقيق الوظيفي | التركيز CSS؛ الدلالات/النص اقتراح فقط |

لا تُغيّر عبارة واحدة، ولا تُخفي نصًا لتوسيع المساحة، ولا يُستخدم content لإنشاء تعليمات جديدة. لا يُفترض أن الأزرار غير المعنونة أو التنبيهات غير المعلنة معيبة دون فحص markup الخاص بها. لا نستعمل اللون وحده إذا كان النص/الرمز الحالي لا يوضح الحالة؛ نسجل حينها مقترح markup.

## 5. محاذاة الهاتف

المجلد .claude/worktrees/wasla-bridge/apps/ios/Design يحتوي connect-logo.jpg فقط. المصدر الفعلي الذي عُثر عليه، قراءة فقط، هو .claude/worktrees/wasla-bridge/apps/ios/Wasla/Views.swift؛ تعليق السطر5 يربطه بلوحة المحادثة. الجدول لا ينسب تعريفات غير موجودة إلى Design.

| رمز الويب | مقابل iOS الحالي (فاتح / داكن) | الفرق والجهة التي تتغير |
|---|---|---|
| --page | Forest.background: #faf9f6 / #1e1d1b؛ سطر10 | مطابق للمحادثة؛ الويب يعممه |
| --panel | Forest.panel: #f4f2ed / #181715؛11 | مطابق؛ الويب فقط |
| --raised | Forest.surface: #ffffff / #292825؛12 | اسم مختلف ودور مطابق |
| --ink | Forest.ink: #22201c / #edebe5؛13 | مطابق للمحادثة؛ globals يتغير |
| --soft | Forest.softText: #6b675f / #a6a298؛14 | المقترح يقويه إلى #5f5b53 / #b8b3a9؛ الويب الآن، الهاتف لاحقًا |
| --faint | Forest.faint: #9a968c / #77746c؛15 | نفس الفشل القديم؛ الويب إلى #6b675f / #a6a298؛ يوصى بتحديث الهاتف لاحقًا |
| --line | Forest.line: #e7e4dc / #34322d؛16 | مطابق؛ يستعمل للزخرفة لا لحد الحقل الوحيد |
| --user | Forest.soft: #efece4 / #2e2c28؛17 | مطابق |
| --hover | Forest.soft نفسه؛17 | الفاتح مختلف عن #ebe8e0؛ يبقى دور التحويم خاصًا بالويب |
| --accent | Forest.accent: #1f6f5c / #4fb596؛18 | مطابق |
| --accent-hover | لا مقابل مستقل | يبقى للويب؛ لا إضافة للهاتف دون استعمال |
| --accent-soft | Forest.accentSoft: #e3efe9 / #1f3a31؛19 | مطابق |
| --accent-ink | Forest.onAccent: #ffffff / #0f1f1a؛20 | اختلاف اسم فقط |
| --alert | Forest.alert: #a33a2c / #ee9383؛21 | مطابق |
| --alert-soft | لا رمز؛ Mohassan.swift:256 يستخدم Forest.alert.opacity(0.1) | مركب مختلف؛ يوصى بقيم صريحة مطابقة على الهاتف لاحقًا |
| --success، --success-soft | لا مقابل في Forest | إضافة للويب؛ اقتراح للهاتف عند الحاجة |
| --warning، --warning-soft | لا مقابل | الإجراء نفسه |
| --info، --info-soft | لا مقابل | الإجراء نفسه |
| --focus-ring | لا رمز موحد | ويب الآن؛ الهاتف يحترم حلقة النظام مع لوحة المفاتيح، تدقيق لاحق |
| --overlay | لا قيمة token مقابلة | الويب فقط؛ لا يُفرض لون على sheet الأصلي |
| --background، --surface، --text، --muted، --green، --green-dark، --mint | لا أسماء مقابلة مستقلة؛ تقابل أدوار الجدول أعلاه | الويب يحتفظ بالأسماء كaliases؛ لا تُنقل اللوحة القديمة للهاتف |
| --radius-sm 8، --radius-md 12، --radius-lg 16 | زر10؛ بطاقة16؛ composer20؛ أزرار الإرسال12؛ Views:39/52/156/171 | الويب يتوحد8/12/16؛ يوصى للهاتف بتوحيد لاحق مع الحفاظ على الشكل الدلالي للفقاعات |
| --space-0/1/2/3/4/5/6/8/10/12/16 | لا سلم رموز؛ القيم0/4/8/12/16/20/24 موجودة؛ توجد أيضًا5/6/7/10/11/14/18/22/72 | الويب يعتمد السلم؛ الهاتف يقرب المسافات الداخلية لاحقًا، مع حفظ safe area |
| --type-xs/sm/md/lg/xl/2xl | body/headline/subheadline/footnote/caption/caption2 ديناميكية؛ أحجام ثابتة22/26/28/34 في Views:62/189/192/309 | تطابق رتبة لا px=pt؛ الويب يستخدم rem؛ الهاتف يبقي الخط الأصلي وDynamic Type |
| --leading-body/heading/control | لا رموز ثابتة مقابلة | الويب1.8/1.5/1.6؛ الهاتف يحتفظ بقياس الخط الأصلي ويُختبر مستقلًا |
| --font-ui | خط النظام الأصلي في SwiftUI | لا توحيد اسم الخط بين النظامين؛ توحيد الوضوح والرتب |
| --target-min 44px | زر عام: minHeight24 + padding رأسي10 بكل جهة =44pt، Views:36–38؛ إطار إرسال36×36 في155/162 | الويب44px؛ فحص هدف إرسال الهاتف لاحقًا، لا جزم من frame وحده |
| --shadow-sm، --shadow-lg | بطاقة أسود4% radius6 y2؛ composer5% radius6 y2؛ شعار6% radius4 y1؛ Views:54/173/191 | تقارب بحسب الدور؛ لا تطابق حسابي مباشر بين CSS blur وSwiftUI radius؛ الهاتف اقتراح لاحق |
| --duration-fast/base/slow | easeOut0.25s للتمرير، Views:136/139؛0.2s للتفاصيل،231 | الويب120/200/320؛ الهاتف يحتفظ بـ200 الحالي ويُراجع250 وفق الوظيفة لاحقًا |
| --ease | SwiftUI easeOut | تقريب نية الحركة، لا ادعاء منحنى مطابق |
| --layer-base/sticky/menu/scrim/modal/toast | لا zIndex صريح في Views وWaslaApp المفحوصين؛ navigation/sheet أصلية | أرقام الويب فقط؛ لا تُنسخ للهاتف |

لم يُعثر على accessibilityReduceMotion في Views.swift وWaslaApp.swift المفحوصين؛ يُقترح على مالك الهاتف إضافة بديل. لا يعني ذلك تدقيقًا شاملًا لكل iOS. لم يُشغل الهاتف ولم يُعدّل أي ملف فيه.

## 6. خطة المرحلة الثانية الدقيقة، بعد الموافقة فقط

### قبل أول تعديل

1. إعادة قراءة الحالة الحالية للملفات وبصماتها، وفصل أي تعديل متزامن للآخرين عن عملي دون git reset/stash أو استبدال الملف كاملًا. يُقرأ كل ملف مباشرة قبل ترقيعه.
2. إعداد خط أساس بصري **لكل الأقسام قبل تغيير globals**؛ تغييره يؤثر في الجميع. تثبيت العرضين375×812 و1280×900، ونمطيlight/dark، ومحتوى fixture نفسه. صفحة الدخول/الإعداد، المحادثة وقائمة الحساب/النافذة، مساحة الأدوات والهواتف، وكل قسم وحالة متاحة تُصوّر.
3. الفحص البصري فقط على startIsolatedE2E من tests/e2e/isolation.ts، مع helpers.ts وglobal-setup.ts، في Chromium headless مع --disable-gpu. لا npm run dev في المستودع، ولا .env، ولا reuseExistingServer.
4. إبقاء أسماء الأصناف وتنسيق كل ملف كما هو، بما فيه ملفات السطر الواحد. تعديلات قيم صغيرة، وإضافة الرموز والقواعد الضرورية فقط؛ لا إعادة ترتيب أو formatter.

### ترتيب الملفات

كل مسارات modules التالية تحت apps/web/components/. ينفذ قسم واحد، وتفحص صوره وتُصلح عيوبه قبل التالي.

| الترتيب / مجلد الصور | الملفات | التغيير المحدد |
|---|---|---|
| 1 / foundation | apps/web/app/globals.css ثم assistant-app.module.css لتوحيد مصدر الرموز فقط | تعريف لوحة اللون الداكنة والفاتحة وaliases والمقاييس؛ إزالة التعريف المحلي المتعارض؛ تعميم الخط؛ تركيز/تقليل حركة عامان. مراجعة auth/overview/tasks/coding/roadmap وكل واجهة مشتركة متأثرة فورًا |
| 2 / assistant | assistant-app.module.css | المقاييس الستة؛ رفع الأهداف44؛ إصلاح faint والتركيز والحوار والكتابة؛ تحويل margin الدلالي؛ توحيد الحركة والـoverlay؛ حفظ تخطيط المتصفح الحديث الموجود |
| 3 / activity | agent-activity.module.css | حذف fallback اللون الخام، دورة نشاط مشتقة؛ بديل ثابت؛ إبقاء هندسة الأرباع |
| 4 / campaign | campaign-card.module.css | warning tokens؛ type/radius/spacing؛44 للزر وsummary؛ التركيز؛ لا تغيير أسماء الحالات |
| 5 / skills | skill-library.module.css | نقل كل الألوان إلى الأدوار، إزالة fallbacks الخام؛40/38 إلى44؛ نص12+؛ بقاء قيود الالتفاف والأعمدة الحالية |
| 6 / ads | google-ads-workspace.module.css | حساب/بوابات/فحوص/تنبيهات على الأدوار المشتركة؛ نص12+؛ حدود حقول؛ اتجاه النص حسب السياق؛ لا تعديل تكامل أو تشغيل إعلان |
| 7 / executor | executor-workspace.module.css | إزالة الهوية الزرقاء المنفصلة لصالح المحايد؛ ألوان النتائج دلالية؛ metadata مقروءة؛ تحكم44؛ لا تشغيل نموذج |
| 8 / windows | windows-workspace.module.css | حالات الصلاحية/الرفض/الاتصال؛ type/spacing؛ أزرار44؛ حدود منطقية بحسب اتجاه الأصل؛ لا ربط أو تشغيل جهاز |
| 9 / browser | browser-workspace.module.css ثم browser-open-result.module.css ثم browser-files-panel.module.css | توحيد النتائج/التنبيهات/الملفات؛ خط12+ للشيفرة والوصف؛ summary/focus وحدود الحقول؛ RTL للواجهة وLTR للكود؛ حفظ تمرير المخرجات |
| 10 / members | members.module.css | رموز الدعوة وقائمة الأعضاء؛ نسخ44؛ النص الصغير؛ الصفحة المستقلة ترث الداكن من الجذر |
| 11 / capabilities | capability-evolution.module.css | استبدال الألوان والمقاييس؛ الحفاظ على44 الموجود والتفاف الهاتف؛ notice/focus موحدان |
| 12 / memory | memory-workspace.module.css | رموز الشارات والنتائج والنماذج؛12+؛44؛ موضع الإغلاق المنطقي؛ حوار مع focus مرئي |
| 13 / studio | قواعد .studio-* الموجودة في globals.css، ثم studio-ai-panel.module.css، ثم studio-live-panel.module.css | المقاييس/الألوان نفسها؛ معاينة وحدود/حقول44؛ upload:focus-within؛ تسميات12+؛ التفاف الأدوات؛ لا تعديل محتوى iframe |
| 14 / مراجعة نهائية | الملفات المذكورة فقط + هذا التقرير | إعادة العد والتباين وفحص تعارض globals مع modules، وتوثيق الاستثناءات؛ ثم الاختبارات النهائية |

في الخطوة1 تتم معالجة قواعد globals المشتركة كلها، بما فيها تسجيل الدخول والمهام وكتابة الشيفرة. تُلتقط baseline الاستوديو قبلها وتُراجع أثرها عليه؛ تفاصيل .studio-* النهائية في الخطوة13. لا تُترك قاعدة7px في الهاتف لأن القاعدة الأساسية أصبحت12px فقط.

### الصور والعزل

المجلد المصرح به الثاني هو artifacts/design-unification/<section>/. لكل حالة أربعة أزواج مستقلة؛ أسماء مثل before-light-375.png وafter-light-375.png، وبالمثل dark-375 وlight-1280 وdark-1280. تُضاف تسمية الحالة عند الحاجة مثل dialog أوempty. تُحفظ المقارنة الأصلية السابقة لتغيير globals، ولا تُستبدل بلقطة وسطية.

بعد كل قسم: فتح الصور ومشاهدتها، ثم قياس overflow والأهداف والتباين المحسوب وTab/focus في المتصفح، واختبار reduced-motion والحالة المفتوحة/المغلقة، وإصلاح العيب داخل CSS المسموح قبل الانتقال. الإحصاء الآلي لا يغني عن رؤية النص العربي والتشكيل والقص.

**إثبات العزل المقروء:** isolation.ts:15–38 يبني environment بقائمة سماح، DATABASE_URL فارغ ومخازن جديدة داخل fixture؛:62–71 يستبعد .env* و.next* والروابط الرمزية من النسخة؛:123–124 يرفض المنفذين3100/4100 إن كانا مستخدمين. server-entry.ts:3–10 يرفض الجذر غير المملوك وإعدادات الإنتاج قبل import؛:15–17 يستخدم mock AI. helpers ينشئ مالك الاختبار في القاعدة المؤقتة فقط. لا تُغلق خدمة تخص وكيلًا آخر عند تضارب المنفذ؛ نطلب تنسيقًا من المالك.

fixture ينسخ المصدر وقت البداية؛ التعديل في المستودع لا يظهر فيه تلقائيًا. تُعاد تهيئة نسخة معزولة بعد القسم مع الحالة نفسها قبل تصوير after، ويُنتظر إغلاق العمليات المملوكة قبل تنظيف مجلدها وفق آلية isolation الموجودة. لا نسخ لـ.env ولا اتصال بقاعدة موجودة. RUN_WORKER=true وتجميع Next يستهلكان CPU؛ تشغيل واحد متتابع فقط. لا إجراءات تدريب/استدلال محلي أو تكامل حقيقي أو اتصال جهاز خلال التصوير. إذا تعذر تأكيد أي جزء من العزل، لا تشغيل ونرجع للمالك.

الصفحات هي أقسام state داخل المسار /، وفق workspace.tsx:38 و49–65 و403؛ لا نفترض عناوين URL منفصلة. تستعمل زيارة القسم helpers الحالية دون تعديل labels. الحالات التي تحتاج بيانات تُملأ ببيانات fixture محلية مماثلة لما تفعله الاختبارات القائمة، لا ببيانات الإنتاج. لا تُزوّر لقطة لقسم غير قابل للوصول؛ يسجل النقص.

### بوابة القبول والاختبارات

- الهدف:0 ورود لون خام في استعمالات CSS خارج تعريفات الرموز في globals، بما في ذلك fallbacks والتدرجات والظلال. transparent/currentColor استثناءات دلالية مسموحة؛ ألوان الصور/iframe أو CSS خارج النطاق تُذكر ولا تُعدل.
- الهدف:0 تصريح font-size أقل من12px، ثم قياس فعلي للنص الموروث وem والحالات الهاتفية؛ استخدام ستة أحجام فقط للمحتوى العادي.
- كل الأقسام ضمن النطاق تملك فاتحًا وداكنًا قابلين للقراءة، وتركيزًا مرئيًا، وأهداف44، واتجاهًا صحيحًا، وبديل حركة. لا يُحتسب query وحده نجاحًا.
- صفر أزواج تباين فاشلة معروفة للنص/التحكم النشط ضمن النطاق بعد القياس؛ لا تعميم النجاح على بيانات/حالات لم تُشاهد.
- في النهاية فقط: npm run typecheck، ثم npm run test:e2e مرة واحدة بترتيب التنفيذ الحالي وworkers:1. لا Vitest/full suite أثناء العمل، ولا تعديل أي اختبار لتمريره. يُضبط إطلاق Chromium بلا GPU دون تعديل ملف الاختبارات؛ إن احتاج ذلك إعدادًا غير متاح ضمن النطاق يُعرض قبل التشغيل، ولا يُشغّل GPU افتراضًا.
- لو فشل اختبار: توثيق الفشل وتمييز أثر CSS عن التغييرات المتزامنة، وعدم الادعاء بالنجاح أو تعديل الاختبار. لا إعادة تشغيل كاملة ثانية دون اتفاق لأنها مطلوبة مرة واحدة.
- يحدّث هذا التقرير بالأعداد قبل/بعد، الأقسام المكتملة، الفشل المتبقي، والحالات غير المفحوصة. تغييرات TSX المطلوبة تبقى اقتراحات منفصلة ولا تُنجز ضمن موافقة CSS.

### ما لن يتغير

لا TSX/TS، لا نص ظاهر، لا class name، لا اختبار أو إعداد اختبار، لا packages أو apps/server أو مجلدات التدريب أو worktrees، ولا ملفات chrome-extension-panel.* وai-providers.*. لا commit/push/stash/reset، ولا reformat أو إعادة ترتيب CSS. لا تغيير API أو تنفيذ أو اتصال أو أذونات أو تفعيل خدمات. أي تأثير موروث من globals على المكونات المستبعدة يُراجع كتأثير جانبي؛ لا ندعي توحيدها أو نجاحها الكامل، ولا نعدلها خفية.

## 7. القرار المطلوب

المطلوب اعتماد لوحة اللون والمقاييس ووصفات الأنماط وخطة CSS أعلاه، أو تحديد ما تريد تغييره فيها. الموافقة لا تشمل مقترحات markup/النص أو تعديل الهاتف. **تتوقف المهمة هنا حتى موافقة المالك؛ لم تبدأ المرحلة الثانية.**

## الملحق أ: المقاييس المستخدمة حسب الملف

جميع المسارات المختصرة هي apps/web/components/، عدا globals.css فهو apps/web/app/. القيم مفردات من التصريحات، وليست سلمًا مقترحًا.

| الملف | radius | font-size | مدة الحركة |
|---|---|---|---|
| globals.css | 4px، 5px، 6px، 7px، 8px، 9px، 10px، 11px، 12px، 13px، 15px، 16px، 20px، 22px، 30px، 50% | 7px، 8px، 9px، 10px، 11px، 12px، 13px، 14px، 15px، 16px، 17px، 18px، 20px، 21px، 22px، 24px، 25px، 26px، 28px، 29px، 30px، 34px، clamp(33px, 3.2vw, 52px) | .01ms، .16s، .2s، 1.5s |
| agent-activity.module.css | 50% | موروث | .45s، 1.2s |
| assistant-app.module.css | 3px، 5px، 6px، 7px، 8px، 9px، 10px، 11px، 12px، 14px، 16px، 18px، 20px، 50%، 999px | .88em، 11px، 12px، 12.5px، 13px، 13.5px، 14px، 14.5px، 15px، 16.5px، 17px، 19px، 22px، clamp(24px, 3.4vw, 32px) | .14s، .16s، .18s، .2s، .22s، .24s، .25s، .3s، .4s، 1.3s، 1.8s |
| browser-files-panel.module.css | 6px، 7px، 8px، 12px | 11px، 12px، 13px | لا مدة محلية |
| browser-open-result.module.css | 6px، 7px، 9px | 10px، 11px، 12px، 13px، 15px | لا مدة محلية |
| browser-workspace.module.css | 6px، 7px، 8px، 10px، 12px | 9px، 10px، 11px، 12px، 13px، 14px، 16px، 18px، 19px، 22px، 25px | لا مدة محلية |
| campaign-card.module.css | 8px، 10px، 16px، 50%، 999px | 12px، 12.5px، 13px، 13.5px، 14px، 15px | لا مدة محلية |
| capability-evolution.module.css | 7px، 9px، 10px، 14px | 12px، 13px، 16px، 20px | لا مدة محلية |
| executor-workspace.module.css | 7px، 8px، 9px، 12px، 14px، 999px | 10px، 11px، 12px، 13px، 14px، 15px، 20px، 24px | لا مدة محلية |
| google-ads-workspace.module.css | 6px، 7px، 8px، 9px، 10px، 11px، 13px، 14px، 20px | 10px، 11px، 12px، 13px، 14px، 15px، 19px، 21px، 23px، 26px | لا مدة محلية |
| members.module.css | 6px، 8px | 11px، 12px، 13px، 22px | لا مدة محلية |
| memory-workspace.module.css | 6px، 7px، 9px، 10px، 11px، 13px، 20px | 9px، 10px، 11px، 12px، 14px، 15px، 16px، 18px، 22px، 23px، 24px، 25px، 26px | لا مدة محلية |
| skill-library.module.css | 8px، 9px، 10px، 12px، 13px، 14px، 16px، 18px | 10px، 11px، 12px، 13px، 14px، 16px، 17px، 22px، 24px، 27px | لا مدة محلية |
| studio-ai-panel.module.css | 5px، 6px، 7px، 11px، 20px | 10px، 11px، 14px، 15px | لا مدة محلية |
| studio-live-panel.module.css | 7px، 8px، 12px، 25px | 10px، 11px، 12px، 13px، 17px | لا مدة محلية |
| windows-workspace.module.css | 6px، 7px، 10px، 11px، 12px، 13px، 14px، 50% | 10px، 11px، 12px، 13px، 14px، 17px، 18px، 20px، 23px، 26px | لا مدة محلية |

| الملف | قيم margin / padding / gap المستخدمة |
|---|---|
| globals.css | -2px، 0، 1px، 2px، 3px، 4px، 5px، 6px، 6.6vw، 7px، 8px، 9px، 10px، 11px، 12px، 13px، 14px، 15px، 16px، 17px، 18px، 19px، 20px، 21px، 22px، 23px، 24px، 25px، 26px، 27px، 28px، 29px، 30px، 31px، 32px، 33px، 34px، 35px، 37px، 38px، 39px، 40px، 42px، 45px، 50px، 53px، 56px، 58px، 100px، 112px، 115px، 200px، 220px، 248px، 270px، auto |
| agent-activity.module.css | لا قيم محلية |
| assistant-app.module.css | -4px، 0، 1px، 2px، 3px، 4px، 5px، 6px، 7px، 8px، 8vh، 9px، 10px، 11px، 12px، 12vh، 13px، 14px، 15px، 16px، 18px، 20px، 22px، 30px، auto |
| browser-files-panel.module.css | 0، 5px، 6px، 7px، 8px، 10px، 12px |
| browser-open-result.module.css | 0، 4px، 5px، 6px، 8px، 10px، 12px، 13px، 16px، 17px، 18px |
| browser-workspace.module.css | 0، 5px، 6px، 7px، 8px، 9px، 10px، 11px، 12px، 13px، 14px، 15px، 16px، 17px، 18px، 20px، 55px |
| campaign-card.module.css | 0، 3px، 4px، 6px، 8px، 10px، 12px، 14px، 16px، auto |
| capability-evolution.module.css | 0، 8px، 10px، 12px، 14px، 16px، 18px، 22px |
| executor-workspace.module.css | 0، 3px، 4px، 5px، 6px، 7px، 8px، 9px، 10px، 11px، 12px، 14px، 16px، 20px، 22px، 24px، 26px، 40px، auto |
| google-ads-workspace.module.css | 0، 2px، 3px، 4px، 5px، 6px، 7px، 8px، 9px، 10px، 11px، 12px، 14px، 15px، 16px، 18px، 20px، 22px، 25px، 28px، 50px، auto |
| members.module.css | 0، 3px، 6px، 8px، 10px، 12px، 14px، 16px، 18px، 21px، 24px، 48px، auto |
| memory-workspace.module.css | 0، 3px، 4px، 5px، 6px، 7px، 8px، 9px، 10px، 12px، 13px، 14px، 15px، 16px، 17px، 19px، 20px، 21px، 22px، 28px، 30px، auto |
| skill-library.module.css | 0، 3px، 4px، 5px، 6px، 7px، 8px، 9px، 10px، 11px، 12px، 13px، 14px، 15px، 16px، 17px، 18px، 20px، 21px، 22px، 24px، 36px |
| studio-ai-panel.module.css | 0، 4px، 5px، 6px، 7px، 8px، 9px، 10px، 11px، 12px، 13px، 14px، 15px، 16px، 17px، 18px، 20px، 28px، auto |
| studio-live-panel.module.css | 0، 7px، 8px، 9px، 10px، 11px، 12px، 13px، 14px، 16px، 20px |
| windows-workspace.module.css | 0، 2px، 6px، 7px، 8px، 9px، 10px، 11px، 12px، 13px، 15px، 16px، 17px، 18px، 19px، 20px، 22px، 23px، 25px، 28px، 30px، 55px، auto |

## الملحق ب: بصمات لقطة CSS

تساعد البصمات على اكتشاف تغيرات متزامنة قبل المرحلة الثانية؛ لا تُستخدم لإرجاع تغييرات الآخرين. ملف assistant-app كان معدلًا مسبقًا وagent-activity غير متتبع عند بدء التدقيق. وجود diff قائم لا ينسب إلى هذا العمل.

| الملف | SHA-256، أول 12 خانة |
|---|---|
| globals.css | a3fb95351d5c |
| agent-activity.module.css | af6781f560ae |
| assistant-app.module.css | 1ee54d877500 |
| browser-files-panel.module.css | 41fe46552f2f |
| browser-open-result.module.css | c2f959ef3eb7 |
| browser-workspace.module.css | 80d38c61371a |
| campaign-card.module.css | 73120e571262 |
| capability-evolution.module.css | 5af647e5d08f |
| executor-workspace.module.css | 9a0ad446690c |
| google-ads-workspace.module.css | e44edb233e9a |
| members.module.css | 8640b5303604 |
| memory-workspace.module.css | 445151c7ba89 |
| skill-library.module.css | 7609332af671 |
| studio-ai-panel.module.css | c9425d4ee336 |
| studio-live-panel.module.css | e9b8d6ae7ff3 |
| windows-workspace.module.css | 46c1827203fd |

## الملحق ج: ما لم يُتحقق منه على شاشة فعلية

لم تُشغّل أي شاشة في هذه المرحلة. لم تُقَس صناديق اللمس أو overflow أو قص العربية أو التباين المركّب في DOM على375 أو1280، ولم تُختبر لوحة المفاتيح فعليًا أو سلوك portals/Motion/Chakra أو شاشة iPhone. أرقام المصدر ونسب الأزواج المحددة محسوبة؛ أي حكم يعتمد على العرض موسوم بذلك. لم تُشغّل typecheck أو UI E2E بعد؛ موعدهما نهاية المرحلة الثانية كما طُلب.

