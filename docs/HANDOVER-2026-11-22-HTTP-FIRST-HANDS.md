# تسليم مكتوب: الأيدي بلا متصفح (المحور 1 من خطة تقوية الدماغ)

| | |
|---|---|
| التاريخ | 2026-11-22، بين 03:00 و03:30 UTC |
| الكاتب | Claude Code (الجلسة التي كتبت `artifacts/plan-2026-11-22/0-baseline.md`) |
| لمن | الجلسة التي تبني `apps/server/src/assistant/browser-visibility.ts` وتملك واجهة `apps/web`، وأي وكيل يلمس `hands.ts` أو `command-chat.ts` بعدي |
| الحالة | الشفرة مكتوبة. فحص الأنواع (`npx tsc --noEmit -p tsconfig.json`) مرّ في 03:14 و03:19 UTC؛ وفي 03:47 ظهر خطأ واحد في `packages/pdf/src/render.ts:119` وهو ملف جديد لوكيل آخر عُدّل في 03:46 ولم ألمسه. اختبارات الوحدة والمتحكم الحقيقي تمر. **لا commit.** القياس بعد التغيير لم يُسجَّل بعد في هذا الملف |

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
| `scripts/perf/fixture.ts` و`scripts/perf/summarize-latency.ts` | قياس | تسجيل `browserLevel` من `conversation.visibility.level` إن أرسله الخادم، وتقديران للواجهة: الاستطلاع القديم (900 ms) والمقترح (200 ms في أول 3 ث ثم 900) | §2: 97% من انتظار المسار المحلي سببه الاستطلاع |

## ما لم ألمسه عن قصد، وهو لكم

- **`apps/server/src/assistant/browser-visibility.ts` وعقد `ChatBrowserVisibilitySchema` في `packages/contracts/src/command-chat.ts`:** كتبتُ نسخة أولى ثم رأيت نسختكم الأكمل تُكتب على القرص في 03:08، فحذفت نسختي من العقد (كانت ستتعارض مع `export const ChatBrowserVisibilitySchema` الثاني) وتركت الملف لكم. لم أربط أي رؤية للمتصفح في `command-chat.ts`.
- **`apps/web/components/assistant-app.tsx`:** لم أغيّر `browserOpen` ولا الاستطلاع. ما كنت أنوي فعله لعلمكم: `POLL_MS` إلى استطلاع سريع (200 ms) في أول 3 ث بعد الإرسال ثم 900 ms، واستطلاع بطيء (15 ث) بدل التوقف حين يكون التبويب مخفيًا. المقدّر في `summarize-latency.ts` (`uiEstimateAdaptiveMs`) يحسب هذا النموذج تحديدًا.
- `mind/` كلها، و`relevantLines` ومنطق اختيار الجمل، و`describe()` ما عدا جعلها تعمل دون صفحة.

## ما يعنيكم من تغييراتي

- `hands.ts` يصدّر الآن `LIVE` (تصديركم) و`wikiTerms` و`readableOverHttp` و`HandsRead`. لم أغيّر `notWebReason` ولا `webQuestion` ولا `parseHands`.
- بعد الجواب عبر HTTP لا توجد صفحة متصفح للمحادثة، فـ`conversation.browser` يبقى `null`: هذا هو المستوى 1 في جدولكم عمليًا. الصفحة تظهر فقط حين يفتح المتصفح نتيجة لا تُقرأ عبر HTTP، أو في أوامر المتصفح الصريحة.
- اختبارات `tests/assistant-hands.test.ts` أُعيد كتابة 12 منها لمسار HTTP. الجديدة: `tests/assistant-hands-http-chat.test.ts` (المتحكم الحقيقي)، و`tests/assistant-unsupported-request.test.ts`، و`tests/assistant-request-scope-nominal.test.ts`.

## القياس

يُشغَّل بالأداتين نفسيهما كما في خط الأساس، ويُكتب في `artifacts/plan-2026-11-22/1-hands-http.md` مع الأوامر والأوقات والمخرجات الخام. حتى يُكتب ذلك الملف، كل ما في هذا التسليم وصف للشفرة لا نتيجة.
