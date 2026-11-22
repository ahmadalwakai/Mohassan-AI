# تسليم مكتوب: الأيدي بلا متصفح (المحور 1 من خطة تقوية الدماغ)

| | |
|---|---|
| التاريخ | 2026-11-22، بين 03:00 و03:30 UTC |
| الكاتب | Claude Code (الجلسة التي كتبت `artifacts/plan-2026-11-22/0-baseline.md`) |
| لمن | الجلسة التي تبني `apps/server/src/assistant/browser-visibility.ts` وتملك واجهة `apps/web`، وأي وكيل يلمس `hands.ts` أو `command-chat.ts` بعدي |
| الحالة | الشفرة مكتوبة. فحص الأنواع (`npx tsc --noEmit -p tsconfig.json`) مرّ في 03:14 و03:19 UTC؛ وفي 03:47 ظهر خطأ واحد في `packages/pdf/src/render.ts:119` وهو ملف جديد لوكيل آخر عُدّل في 03:46 ولم ألمسه. اختبارات الوحدة والمتحكم الحقيقي مرّت حين كتبتها. **في 08:05 فشلت 3 منها في `tests/assistant-hands.test.ts`**، بعد أن عدّل وكلاء آخرون `answer-check.ts` في 07:45 و`hands.ts` في 07:46 و08:05 (§8 من التقرير). **الشفرة في git:** ضمّتها جلسة المرحلة الأولى إلى commit نقطة الحفظ `aa04956` (03:57 UTC) مع عمل وكلاء آخرين، وهو على `origin/feat/skill-engine`؛ لم أصنع أنا أي commit. القياس بعد التغيير في `artifacts/plan-2026-11-22/1-hands-http.md` (07:43–08:00 UTC)، وفيه جوابان خاطئان معروضان يمسّان هذا التسليم (قسم «القياس» أدناه) |

هذا الملف هو «التسليم المكتوب» الذي يطلبه القسم 6 من `docs/RESPONSE-QUALITY-PLAN-2026-11-22.md` لمن يعدّل `hands.ts` و`command-chat.ts`. ما كتبته أدناه هو كل ما لمسته، حتى يعرف من بعدي أين يبدأ وأين لا يكرر العمل.

## ما تغيّر ولماذا (كل سبب مقيس في `0-baseline.md`)

| الملف | المنطقة | التغيير | السبب المقيس |
|---|---|---|---|
| `packages/browser/src/search/engine.ts` | مُنشئ `SearchEngine` | خيار جديد `publicWeb?: boolean`؛ الافتراضي كما كان | §4: Bing RSS يمنعه robots.txt، وDuckDuckGo HTML يرد صفحة تحقق 6 من 6 |
| `apps/server/src/app.ts` | بناء `searchProvider` (نحو السطر 134) | `publicWeb:false` للمحرك الرئيسي | نفس §4 |
| `apps/server/src/app.ts` | قبل `createCommandChatControl` | دالة `readPage` تقرأ نتيجة بحث عبر HTTP: robots أولًا، HTML فقط، مهلة `READ_PAGE_TIMEOUT_MS = 4000` (قيمة **مقترحة**)، ثم `readableSource`. تُمرَّر في الإعداد `readPage` | §3: قراءة النتائج كانت تفتح المتصفح لكل سؤال |
| `apps/server/src/assistant/hands.ts` | `engine()` داخل `runHands` | بحث HTTP فقط عبر `io.search`؛ **حُذفت** حلقة DuckDuckGo→Bing→ويكيبيديا داخل المتصفح وثابتا `DUCK`/`BING`. محاولة ثانية بكلمات الموضوع وحدها (`wikiTerms`) إن لم يُجب السؤال كاملًا. نتائج الموسوعة مقبولة للحقائق الثابتة ومرفوضة للمعلومة الحية | §3: مرحلة Bing وحدها نحو 7.1 ث من 13 ث |
| `hands.ts` | فرع `ask` في حالة `search` | قراءة أفضل 3 نتائج **بالتوازي** عبر `io.read` الجديد؛ المتصفح احتياط فقط حين لا يعطي HTTP نصًا مقروءًا (`readableOverHttp`)، ونتيجة يمنعها robots تُتخطى. ترتيب القراءة: مقالة الموضوع نفسه أولًا ثم ترتيب المحرك | §3 و§7.2 |
| `hands.ts` | `HandsIO` | حقل اختياري `read?(url): Promise<HandsRead>` | — |
| `hands.ts` | حالات `click` و`read` و`describe()` | تعمل دون صفحة متصفح مفتوحة: الاختيار بالرقم يفتح النتيجة مباشرة، و«اقرأ المزيد» يفتح صفحة الجواب الأخير (`plan.found`) ثم يقرأ، و`describe(plan, page | null)` | — |
| `hands.ts` | `wikiTerms()` مُصدَّرة، و`WIKI_SEARCH` تستعملها | «من هو ألبرت أينشتاين» → «ألبرت أينشتاين» | — |
| `hands.ts` | `noSearchSource` | صياغة صادقة: «لم أجد في المصادر المتاحة لي (ويكيبيديا والواجهات الموثقة)» بدل «أكثر من محرك بحث» | — |
| `apps/server/src/assistant/unsupported-request.ts` | **ملف جديد** | `unsupportedRequest()` يلتقط الرسم وتوليد الصور، وتشغيل الوسائط، والحجز والشراء والاتصال والإرسال؛ `unsupportedReply()` رد ثابت بالعربية أو الإنجليزية مع البديل؛ `searchRefusedReply()` رد حين يرفض حارس المصدر البحث | §8.3: «ارسم لي صورة قطة» بحث 11 ث، و8 طلبات انتهت بـ«تعذّر» بلا رد |
| `apps/server/src/command-chat.ts` | الكتلة `if (!handsPlan && freshRequest && !hasChatModel())` (نحو السطر 2160) | (1) فحص «غير مدعوم» قبل `webQuestion`، بعد `notWebReason` وبشرط ألا يكون الطلب خاصًا؛ (2) استعلام المتابعة من محلل السياق يُستعمل فقط إن احتفظ بكلمة موضوع ليست في رسالة المتابعة نفسها، وإلا يبني `webQuestion(actionRequest, earlierAsks)` الاستعلام | §8.3 و§9: «وكم عدد سكانها؟» ضاع «اليابان» |
| `command-chat.ts` | `runHandsPlan()` | تمرير `read` إلى `runHands` حين يوجد `config.readPage`؛ استعادة `handsFound` مع `handsResults` لخطوة `read`؛ `try/catch` حول `runHands`: أكواد `ASSISTANT_SEARCH_SOURCE` و`ASSISTANT_SEARCH_PROVENANCE` و`RESEARCH_QUERY_INVALID` و`RESEARCH_QUERY_SECRET` تنتهي برد `blocked` بدل حالة `failed` | §8.2: 15 إخفاقًا منها 8 بلا رد |
| `command-chat.ts` | `CommandChatConfig` | حقل اختياري `readPage` | — |
| `apps/server/src/assistant/brain.ts` | `BrainState` | حقل اختياري `handsFound` | — |
| `apps/server/src/assistant/request-scope.ts` | `assessRequestScope`، تعبير `sentence` | النقطة داخل الكلمة («Node.js»، «v1.2») ليست نهاية جملة؛ النقطة قبل مسافة أو في النهاية تبقى كذلك | §8.2: «Node.js latest version» رُفض كـ`missing_target` |
| `scripts/perf/fixture.ts` و`scripts/perf/summarize-latency.ts` | قياس | تسجيل `browserLevel` من `conversation.visibility.level` إن أرسله الخادم، وتقديران للواجهة: استطلاع ثابت بقيمة `UI_POLL_MS` (450 ms في الصفحة اليوم، و900 ms لخط الأساس)، وتقدير **مقترح لم يُبنَ** (200 ms في أول 3 ث ثم `UI_POLL_MS`) | §2: 97% من انتظار المسار المحلي سببه الاستطلاع |

## ما لم ألمسه عن قصد، وهو لكم

- **`apps/server/src/assistant/browser-visibility.ts` وعقد `ChatBrowserVisibilitySchema` في `packages/contracts/src/command-chat.ts`:** كتبتُ نسخة أولى ثم رأيت نسختكم الأكمل تُكتب على القرص في 03:08، فحذفت نسختي من العقد (كانت ستتعارض مع `export const ChatBrowserVisibilitySchema` الثاني) وتركت الملف لكم. لم أربط أي رؤية للمتصفح في `command-chat.ts`.
- **`apps/web/components/assistant-app.tsx`:** لم أغيّر `browserOpen` ولا الاستطلاع. ما كنت أنوي فعله لعلمكم: `POLL_MS` إلى استطلاع سريع (200 ms) في أول 3 ث بعد الإرسال ثم 900 ms، واستطلاع بطيء (15 ث) بدل التوقف حين يكون التبويب مخفيًا. المقدّر في `summarize-latency.ts` (`uiEstimateAdaptiveMs`) يحسب هذا النموذج تحديدًا.
- `mind/` كلها، و`relevantLines` ومنطق اختيار الجمل، و`describe()` ما عدا جعلها تعمل دون صفحة.

## ما يعنيكم من تغييراتي

- `hands.ts` يصدّر الآن `LIVE` (تصديركم) و`wikiTerms` و`readableOverHttp` و`HandsRead`. لم أغيّر `notWebReason` ولا `webQuestion` ولا `parseHands`.
- بعد الجواب عبر HTTP لا توجد صفحة متصفح للمحادثة، فـ`conversation.browser` يبقى `null`: هذا هو المستوى 1 في جدولكم عمليًا. الصفحة تظهر فقط حين يفتح المتصفح نتيجة لا تُقرأ عبر HTTP، أو في أوامر المتصفح الصريحة.
- اختبارات `tests/assistant-hands.test.ts` أُعيد كتابة 12 منها لمسار HTTP. الجديدة: `tests/assistant-hands-http-chat.test.ts` (المتحكم الحقيقي)، و`tests/assistant-unsupported-request.test.ts`، و`tests/assistant-request-scope-nominal.test.ts`.

## القياس

قيس بالأداتين نفسيهما كما في خط الأساس، من 07:43 إلى 08:00 UTC، والمعالج 68–88% في الوسيط. التفاصيل والأوامر والمخرجات الخام في `artifacts/plan-2026-11-22/1-hands-http.md`. المختصر:

- أسئلة المعرفة: الخادم p50 من 12.6 ث إلى 1.7 ث، والمتصفح من 21 من 21 إلى 0، و«تعذّر» من 3 إلى 0.
- خارج القدرات: من 11.2 ث و6 «تعذّر» إلى 36 ms و9 ردود صريحة.
- المجموعة الحقيقية: «تعذّر» دون رد من 15 إلى 1، وفتح المتصفح من 51 إلى 15.
- **لم ترتفع الصحة، وظهر جوابان خاطئان معروضان**، والإصلاح المقترح لكل منهما في §5 من التقرير، ولم يُنفّذ:
  - «من هو الخوارزمي؟» يجيب من «نظرية التعلم الخوارزمي» منذ 03:32. السبب أن `rankResults` في `ranking.ts` يرتّب النتائج معجميًا ويعكس ترتيب ويكيبيديا، و`isOwnArticle` لا تعرف عنوان شخص باسمه الكامل.
  - «وكم عدد سكانها؟» بعد عاصمة اليابان يعرض رقم بلدة «ناكادوماري». السبب أن «سكانها» بضميرها لا تطابق «سكان» في `ATTRIBUTE_WORDS`، فتتعطل قاعدة «الرقم من صفحة عن الموضوع». ومحلل الضمير يأخذ عنوان مقالة الجواب السابق، وصار «اليابان» منذ 07:06.
- خسارة تغطية: طقس لندن كان يُجاب عبر Bing في المتصفح، والآن «لا مصدر حديث».

## إصلاح الجوابين (08:10–08:35 UTC، بعد أن قال المالك «Yes, fix both»؛ ملتزم بعد أن قال المالك «التزم» نحو 13:00 UTC)

نسّقتُ قبل التعديل مع جلسة «الحَكَم» (`local_38cc75e3`) وجلسة «خطة التطوير والقياس»، التي التزمت `97525fd` ثم `9d6c1fa` وتركت أجزائي غير مُدرَجة. الـcommit يضم هذه الملفات وحدها، فوق `ebe068b`. المناطق التي لمستها:

| الملف | المنطقة | التغيير |
|---|---|---|
| `apps/server/src/assistant/hands.ts` | بعد `ATTRIBUTE_WORDS` | `PRONOUN_SUFFIXES` و`BARE_HA_STEMS` و`isAttributeWord()`، و`entityWords()` تستعملها، ثم `withoutPronoun()` و`pastFigure()` |
| `hands.ts` | آخر `withTopic()` | إسقاط ضمير الصفة متى أُلحق الموضوع |
| `hands.ts` | فرع `step.ask` | الأسطر التي تبدأ بـ`const people = figureKind(step.query) === 'people'`: ستة أسطر لسؤال السكان، وتفضيل غير الماضي، و`.slice(0, 3)` |
| `hands.ts` | الاستيراد من `answer-check.js` | `figureKind` |
| `apps/server/src/assistant/answer-check.ts` | `figureKind()` و`hasFigureOf()` | النوع `'people'`: ‏`PEOPLE_QUESTION` و`FIGURE_UNITS.people` و`countOfPeople()` |
| `tests/assistant-hands-attribute-pronoun.test.ts` | جديد | 8 اختبارات: الضمير، والمتابعة، وفرنسا 2025، والخوارزمي |
| `tests/answer-check.test.ts` و`tests/assistant-follow-up.test.ts` | توقعات | «عدد الناس» بدل «أي رقم» لسؤال السكان، واستعلام المتابعة بلا ضمير |

ليس لي: `topicCoverage()` وحاجز العنوان («The Third Murder»)، التزمتهما جلسة «الحَكَم» في `f358f55`. وأما «الخوارزمي» فصحّحه فتح المقالة بالاسم في `97525fd`.

**كان مفتوحًا عند جلسة «الحَكَم»، ثم أصلحته والتزمته في `ebe068b` (13:04 UTC):** فحص `lead_not_best` في `judge.ts` كان يستبدل جواب المتابعة الصحيح بسطر الجبال، لأنه يقيس على طلب المستخدم الأصلي. تحققت بنفسي من إصلاحها في 08:47 UTC، وبصمة `judge.ts` ‏`01c505a1fca8` هي نفسها في `ebe068b`: الجواب «123 مليون نسمة» مع الحَكَم ودونه. الملف: `artifacts/plan-2026-11-22/wrong-answers-fix/judge-ab-after-judge-fix-*.json`.

**التحقق:**
- في 08:50 UTC، على الشجرة المشتركة: 74 ملف اختبار تمس هذه الشيفرة، فيها 961 اختبارًا تمر، و`tsc --noEmit` يمر.
- المجموعة الحقيقية لـ`hands` وحده عبر `--judge off`: لم يتغير فيها سطر أول بسبب هذا الإصلاح (§9 من التقرير).
- **الـcommit نفسه، 13:05–13:37 UTC:** صدّرتُ `ebe068b` مع هذه الملفات وحدها إلى نسخة مستقلة (الشجرة `760d171`)، وروابط حزم `@mohassan` فيها تشير إلى داخلها.
  - `tsc --noEmit -p tsconfig.json` يمر بلا أخطاء.
  - `vitest run tests/assistant tests/answer-check`: ‏141 ملفًا، فيها 3617 اختبارًا تمر و3 متروكة. فشل واحد في `tests/assistant-safety.test.ts` («blocks JavaScript writes…»)، إذ تعذّر على المتصفح الحقيقي فتح 127.0.0.1. أعدته وحده مرتين على الشجرة نفسها، فنجح مرة وفشل مرة. ومساره `AgentBrowser.act` لا يمر بشيء مما غيّرته.
  - الفحص الحي على خادم معزول بُني من تلك النسخة، والحَكَم في وضعه الافتراضي، جاء صحيحًا في: المتابعة اليابانية «123 مليون نسمة» في المرتين، وسكان فرنسا واليابان ومصر والمغرب، والمتابعة الفرنسية، وعاصمة أستراليا، والخوارزمي، وأينشتاين.
  - عاصمة فرنسا جاءت في جملة تبدأ بعدد السكان، كما في كل فحص منذ 08:15.
  - «How many people live in Japan?» و«متى سقط جدار برلين؟» ما زالتا خاطئتين كما قبل الإصلاح. وجرتا مرة واحدة، لأن الخادم ردّ بقية الجولة الثانية بحد إنشاء المحادثات (HTTP 429).
  - الملف: `artifacts/plan-2026-11-22/wrong-answers-fix/live-check-commit-2026-11-22T13-35-11.json`.
