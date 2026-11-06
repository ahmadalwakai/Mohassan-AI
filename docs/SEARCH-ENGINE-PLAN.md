# خطة Deterministic Search Engine 2.0

الحالة: خطة موثقة بتاريخ 2026-11-05. **لم يبدأ التنفيذ ولم يُعدَّل أي ملف قائم.** هذا الملف هو الإضافة الوحيدة إلى المشروع.

## 1. النتائج التي تغيّر القرار

1. **لا يوجد مصدر عام للويب بلا مفتاح ويحترم قيودك.** `www.bing.com/robots.txt` يمنع `/search` لكل الوكلاء، والمحوّل الحالي `BingRssSearch` يطلب هذا المسار نفسه. أما DuckDuckGo فيرد HTTP 202 بصفحة حجب، ولا نتائج فيها.
2. **الواجهات المجانية الموثقة تغطي موضوعات محددة فقط.** جرّبت العبارات الثماني عليها: ظهرت صفحات متعلقة بـNode.js وReact، ولم يظهر أي مصدر مباشر للطقس أو تذاكر القطار أو سعر الذهب. لا يمكن لأي خوارزمية ترتيب تعويض مصدر غائب.
3. **إيقاف Bing تراجع مقصود في التغطية.** كان Bing مصدر النتائج الثلاث الصحيحة في القياس السابق، ومنها طقس غلاسكو وتذاكر القطار. بعد إيقافه يذهب الوكيل إلى المسار الموجود: فتح الموقع المعني مباشرة، ويظهر القيد صراحة.
4. **ويكيبيديا تطلب وسيلة اتصال في User-Agent.** الوكيل الحالي `MohassanAI-Research/1.0` بلا وسيلة اتصال، وقد نجح اليوم، لكن السياسة تقول إن مثله قد يُحجب. هذه القيمة منك، ولن أستخدم بريدك من تلقاء نفسي.
5. **لا يوجد ملف مرجعي للاستعلامات الثمانية.** استخرجتها من سجل جلسة سابقة، ونتائجها أرقام في رسالة (Bing 3/8، DuckDuckGo 0/8، بحث Groq 6/8) بلا أحكام صلة مستقلة. تصلح مرجعًا تاريخيًا، ولا تصلح خط أساس للمقارنة.

## 2. ملكية الملفات

| الفحص | النتيجة وقت 18:28 |
|---|---|
| أشجار العمل | واحدة فقط، `feat/skill-engine` عند `62dfbea` |
| جلسات Claude الأخرى | 15 جلسة، كلها خاملة عند 18:21 |
| Codex | التطبيق يعمل. آخر مهمة في المشروع انتهت 17:13، لكن أدواته أُعيد تشغيلها 18:16 بلا سجل جلسة جديد |
| آخر تعديل مصدري | `brain.ts` 17:55، و`docs/IMPLEMENTATION-STATUS.md` 18:01 |
| اختبارات جارية | لا شيء الآن. انتهى تشغيل Playwright عند 18:19، ولم أحدد الجهة التي شغّلته |

**النتيجة: لا دليل على تعديل جارٍ، لكن الملكية الحصرية غير مؤكدة.** لا يمكن إثبات خمول Codex من هنا، لذلك يلزم تأكيدك.

المراحل 1 إلى 7 تعمل في ملفات جديدة تقريبًا، فتداخلها ضعيف. الملفات القائمة المتداخلة:

- `network.ts` و`research.ts` و`index.ts`: من SE2 إلى SE4.
- `command-chat.ts` و`app.ts` و`skill-tools.ts`: في SE8.

خطة المتصفح BR1+ تعدّل `command-chat.ts` و`app.ts` أيضًا، فلا تعملان معًا في SE8.

عائق مستقل: **189 مدخلًا غير محفوظ** فوق `62dfbea`. لا يمكن تقديم تراجع حقيقي لكل مرحلة دون commit أساس محلي، ولا push.

## 3. الواقع الموثق للكود

| الملف | ما وُجد | أثره |
|---|---|---|
| `packages/browser/src/research.ts` | `SearchProvider` من حقلين، و`BingRssSearch` و`DuckDuckGoSearch` و`PublicWebSearch` و`relevantHits` و`conductResearch` | يبقى العقد، وتضاف إليه حقول اختيارية حتى تعمل بدائل الاختبار `{name,search}` |
| `packages/browser/src/network.ts` | `pin()` يتحقق من DNS ويثبت العنوان، و`text()` يعيد الفحص عند كل تحويلة | لا يُستبدل، وتضاف إليه طريقة جديدة |
| | `text()` يفك كل صفحة UTF-8 | صفحات windows-1256 العربية تخرج تالفة |
| | `text()` يقبل 202 نجاحًا | صفحة الحجب لا تُصنَّف حجبًا |
| | `SafeResponse` يسقط `date` و`last-modified` و`etag` و`retry-after` و`x-robots-tag` | لا توجد طوابع مصدر أو احترام لـRetry-After |
| | لا يوجد `robots.txt` | يلزم في جلب الأدلة والفهرس |
| `packages/browser/src/index.ts` | `provider` خاص بكل `createBrowserResearchControl` | يضاف مزوّد مشترك |
| `apps/server/src/command-chat.ts:115` | ينشئ `PublicWebSearch` مستقلًا، و`app.ts` لا يمرر `searchProvider` | ذاكرة التخزين وصحة المزودين ستنقسم دون حقن مشترك |
| `apps/server/src/command-chat.ts:551` | يبني النتائج سطرًا `results:` بلا وسم «غير موثوق» | يضاف الوسم ومؤشر الحداثة |
| `apps/server/src/skill-tools.ts:80` | مخطط `Report` و`Source` صارم `.strict()` | أي حقل جديد في التقرير يكسر `research.run` إن لم يُحدَّث المخطط معه |
| `apps/server/src/assistant/brain.ts` | يعد نتائج البحث بيانات غير موثوقة، ويحوي `SEARCH_UNUSABLE` | لا يلزم تعديله |
| `packages/browser/src/agent-browser.ts` | لا يستعمل البحث | لا يُعدَّل |
| `packages/runtime` و`packages/skills` | `research.run` يمر أصلًا عبر Gateway إلى `browser.research` | لا يُعدَّلان |
| `packages/contracts` | لا عقد للبحث، وأنواع البحث في `@mohassan/browser` | تبقى هناك، ولا يضاف عقد مكرر |
| قاعدة البيانات | PGlite وPostgres، بلا `tsvector` مستخدم | BM25 يُبنى في TypeScript وجداول عادية |

اختبار أساس مركّز اليوم: 4 ملفات و31 اختبارًا نجحت (`search-relevance` و`browser-security` و`browser-control` و`browser-api`). لم أشغّل الحزمة الكاملة، لتجنب التزاحم قبل تأكيد الملكية.

## 4. المزودون

فُحص كل مزود عبر `SafeNetwork` الفعلي اليوم، وقرئت شروطه من مصدره الرسمي.

| المزود | النتيجة الحية | الشروط الموثقة | القرار |
|---|---|---|---|
| Wikipedia Action API (ar/en) | 200، `title,pageid,snippet,timestamp` | طلب واحد في كل مرة، وUser-Agent بوسيلة اتصال | يُدمج بعد ضبط `SEARCH_CONTACT` |
| Stack Exchange API | 200 بلا ضغط، `title,link,quota_remaining` | حصة يومية، ويجب احترام `backoff`، ومنع تكرار الطلب نفسه خلال دقيقة | يُدمج |
| HN Algolia | 200، `title,url,created_at,points` | 10,000 طلب في الساعة لكل عنوان IP | يُدمج |
| arXiv API | 200، Atom | طلب كل 3 ثوانٍ واتصال واحد؛ الوصفية CC0 | يُدمج، لأن شروط الواجهة تسمح رغم `Disallow: /` للزواحف |
| Crossref REST | 200 | العام 5 واتصال واحد، والمهذب 10 مع `mailto` | يُدمج، و`mailto` من `SEARCH_CONTACT` |
| npm Registry | 200 | لم أقرأ مرجعًا رسميًا للعقد والحدود | معلّق حتى التحقق |
| OpenAlex | 200 | لم أقرأ شروطها الحالية | معلّق حتى التحقق |
| Bing RSS | 200 | `robots.txt` يمنع `/search` | **معطل افتراضيًا في v2** |
| DuckDuckGo HTML | 202 صفحة حجب | حجب آلي | **معطل، ولا تجاوز** |
| Mojeek HTML | لم يُجرَّب | `robots.txt` يمنع `/search` | مستبعد |
| Google Custom Search | لم يُجرَّب | مصادر ثانوية: مغلق أمام العملاء الجدد، وينتهي 2027-01-01 | مستبعد |
| Brave وTavily | لم يُجرَّبا | لا مفتاح، ووثائق Brave ردت 403، وشروط الخطة المجانية متضاربة | محوّل اختياري لاحقًا، بعد مفتاح منك واختبار عقد حي |
| Marginalia | لم يُجرَّب | مفتاح مجاني بالبريد، غير تجاري | اختياري |
| SearXNG محلي | لم يُجرَّب | JSON يُفعَّل في الخادم نفسه | لا يحل المشكلة: يكشط محركات أخرى نيابة عنك |

القاعدة المعتمدة: الواجهة الموثقة تحكمها شروطها المعلنة، ويحكم `robots.txt` كل مسار HTML أو مسار غير موثق وكل جلب أدلة أو فهرسة. تُسجل هذه القاعدة صراحة في `capabilities.accessBasis` لكل محوّل.

## 5. البنية

كل الجديد داخل `packages/browser/src/search/`، في الحزمة التي تملك `SearchProvider` فعلًا. فلا توجد حزمة جديدة أو تبعية دائرية أو واجهة مكررة.

`SearchEngine implements SearchProvider`، فيُحقن عبر `searchProvider` الموجود ويعمل مع كل المستدعين. `search()` القديم يبقى، و`execute()` يعيد النتيجة المنظمة. يضاف وسيط رابع اختياري `context` يحمل `ownerId` والوقت المحقون.

```text
السؤال ← query/ ← تقسيم الميزانية ← المزودون بالتوازي عبر الحماية
       ← توحيد الروابط ← RRF ← BM25 على النص المسترجع ← الإشارات
       ← ترتيب حتمي ← التنوع ← تحقق الأدلة ← نتيجة منظمة
```

الترتيب حتمي بمدخلات ثابتة: تُجمع النتائج بترتيب المزودين المعلن لا بترتيب وصولها، ويُحقن الوقت، ويُفض التعادل بالرابط الموحد.

## 6. الخطة ملفًا بملف

كل مرحلة تنتهي بـ`npm run typecheck` واختباراتها المركزة وcommit محلي واحد (إن وافقت على الأساس).

### SE0 — الأساس والتجميد

| الملف | العمل |
|---|---|
| لا ملف | commit أساس بعد فحص الأسرار، ثم جولة `typecheck` و`test` و`test:e2e` خضراء |
| `tests/fixtures/search-benchmark/queries.json` (جديد) | العبارات الثماني بنصها، و52 عبارة جديدة موزعة على العربية والإنجليزية والمختلطة |
| `scripts/search-benchmark.ts` (جديد) | تشغيل وتسجيل وإعادة تشغيل من تسجيلات ثابتة |

### SE1 — ذكاء الاستعلام

| الملف | العمل |
|---|---|
| `search/language.ts` (جديد) | كشف اللغة من نسب الحروف: `ar` أو `en` أو `mixed` |
| `search/normalize.ts` (جديد) | NFKC، إزالة التشكيل والتمديد، توحيد الألف والياء والتاء المربوطة، الأرقام الهندية، إزالة محارف الاتجاه الخفية |
| `search/tokenize.ts` (جديد) | تقطيع، وجذع خفيف محافظ بالعربية، وتصريف بسيط بالإنجليزية |
| `search/intent.ts` (جديد) | تصنيف بقواعد ثابتة: `fresh` و`technical` و`academic` و`reference` و`navigational` و`general` |
| `search/lexicon.ts` (جديد) | قاموس مرادفات صغير عربي إنجليزي، بحد توسيع ثابت |
| `search/query.ts` (جديد) | حفظ العبارات بين علامتي اقتباس و`site:`، وإزالة التكرار، وفرض الميزانية |

الاختبار: جداول حالات عربية وإنجليزية، وثبات المخرجات عند التكرار، وحد الميزانية.

### SE2 — المزودون

| الملف | العمل |
|---|---|
| `network.ts` (تعديل إضافي) | ترويسات إضافية في `SafeResponse`، و`NetworkPolicy.userAgent`، وطريقة `document()` تعيد الحالة المصنفة وسلسلة التحويلات والترميز الفعلي |
| `research.ts` (تعديل إضافي) | حقول اختيارية في `SearchHit` و`SearchProvider`، وتبقى الأصناف الحالية |
| `search/types.ts` (جديد) | `capabilities` و`SearchOutcome` و`ProviderFailure` مع أصناف الخطأ |
| `search/robots.ts` (جديد) | محلل RFC 9309 بحد حجم وتخزين مؤقت. 4xx سماح و5xx منع |
| `search/guard.ts` (جديد) | حد معدل، مهلة، قاطع دائرة، صحة، Retry-After و`backoff` |
| `search/providers/{wikipedia,stackexchange,hn,arxiv,crossref}.ts` (جديد) | محوّل لكل مزود موثق |
| `search/providers/legacy.ts` (جديد) | يغلف Bing وDuckDuckGo معطلين افتراضيًا، ويصنف 202 حجبًا |

الاختبار: تسجيلات لكل مزود، وأعطال 429 و5xx و403 وانتهاء المهلة وJSON تالف، وعدم تسرب مفتاح في أي خطأ. `network.ts` يغطيه `browser-security.test.ts` دون تغيير.

### SE3 — الاسترجاع والترتيب

| الملف | العمل |
|---|---|
| `search/canonical.ts` (جديد) | توحيد الروابط وإزالة معاملات التتبع المعروفة فقط |
| `search/bm25.ts` (جديد) | BM25 على العنوان والمقتطف والنص المجلوب، `k1=1.2` و`b=0.75` |
| `search/fusion.ts` (جديد) | Reciprocal Rank Fusion بـ`k=60` |
| `search/signals.ts` (جديد) | تطابق اللغة، الحداثة، وجدول نطاقات صغير موثق القيود |
| `search/rank.ts` (جديد) | الوزن المعلن، التنوع، التعادل، و`relevance` بقيم `provider_only` أو `lexical` أو `content_verified` |

الاختبار: مدخلات مكررة بترتيب وصول مختلف تعطي بايتات متطابقة، و`Date` مفقود لا يصبح تاريخًا أبدًا، ورتبة المزود لا تُعرض صلة مثبتة.

### SE4 — الأدلة

| الملف | العمل |
|---|---|
| `search/evidence.ts` (جديد) | جلب محدود بعد فحص robots، وسلسلة التحويلات، وبصمة المحتوى، وحالات `unavailable` و`unknown` الصريحة |
| `search/extract.ts` (جديد) | يعيد استخدام `readableSource`، ويقرأ التاريخ من `article:published_time` وJSON-LD فقط |
| `search/consistency.ts` (جديد) | تطابق المقتطف مع المصدر: `consistent` أو `inconsistent` أو `unverifiable` |
| `search/sanitize.ts` (جديد) | تنظيف النص غير الموثوق من محارف التحكم والاتجاه |
| `research.ts` (تعديل) | `conductResearch` يستعمل الأدلة الجديدة عبر حقول اختيارية |
| `apps/server/src/skill-tools.ts` (تعديل) | تحديث `Source` الصارم في الخطوة نفسها |

الاختبار: تحويلة إلى عنوان داخلي، DNS rebinding، windows-1256، تجاوز الحجم، مقتطف مزيف، وتقارير قديمة بلا الحقول الجديدة.

### SE5 — التخزين والموثوقية

| الملف | العمل |
|---|---|
| `search/store.ts` (جديد) | جدول `search_cache` بنطاق المالك، و`migrateSearch` |
| `search/cache.ts` (جديد) | TTL حسب النية، إعادة تحقق في الخلفية، وتخزين سلبي قصير |
| `search/engine.ts` (جديد) | التنسيق والإعادة المحدودة والإلغاء والبدائل عند حد المعدل |
| `index.ts` (تعديل) | تصدير الوحدة واستدعاء الترحيل |

الاختبار: كل نتيجة قديمة تحمل `freshness: 'stale'` و`fetchedAt`، وعدم مشاركة التخزين بين مالكين، والإلغاء بلا تقرير مختلق.

### SE6 — الفهرس المحلي

| الملف | العمل |
|---|---|
| `search/local-index.ts` (جديد) | جداول `search_index_documents` و`search_index_terms`، وتحديث تزايدي، وإزالة التكرار بالبصمة، والحذف والإبطال، وBM25 لكل مالك |
| `search/providers/local-index.ts` (جديد) | مزود بقدرة `coverage: 'local_only'` |

لا زحف: يُفهرس فقط ما أضافه المالك صراحة أو ما قُرئ سابقًا وفعّل حفظه، بعد فحص robots. تُكتب في كل نتيجة أنها من فهرس محلي صغير.

### SE7 — القياس

| الملف | العمل |
|---|---|
| `scripts/search-benchmark.ts` (تعديل) | Precision@5 وRecall@10 وnDCG@10 والروابط الصالحة والتنوع وصحة الحداثة وP50/P95 والأعطال والتكلفة والتخزين |
| `tests/fixtures/search-benchmark/qrels.json` (جديد) | أحكام الصلة |
| `tests/search-no-model.test.ts` (جديد) | فحص الاستيرادات، واعتراض الشبكة أثناء التشغيل، وعدّاد نماذج مقاس فعليًا |
| `docs/SEARCH-ENGINE-EVIDENCE.md` (جديد) | النتائج الخام، مع القيود |

استقلال الأحكام: تُخلط نتائج النظامين وتُخفى هوية النظام، ويحكم عليها وكيل جديد بلا اطلاع على خوارزمية الترتيب، ثم تراجع أنت عينة 20%. يبقى حكم الوكيل أضعف من حكم بشري، ويُذكر هذا في التقرير. تُعاد الجولة من تسجيلات ثابتة، وتُفصل عنها جولة حية. لا يُعلن تحسن دون مقارنة زوجية.

### SE8 — التكامل

| الملف | العمل |
|---|---|
| `packages/browser/src/index.ts` | `SearchEngine` مشترك يُحقن في التحكم |
| `apps/server/src/config.ts` و`.env.example` | `SEARCH_ENGINE=legacy\|v2` و`SEARCH_CONTACT` و`SEARCH_ENABLE_BING=false` |
| `apps/server/src/app.ts` و`apps/worker/src/index.ts` | تمرير المحرك إلى البحث والدردشة |
| `apps/server/src/command-chat.ts` | نفس المحرك في السطر 115، والسطر `results (untrusted)` مع الحداثة في السطر 551 |
| `apps/web/components/browser-workspace.tsx` | إظهار وقت الجلب وحالة القِدم |
| `tests/search-integration.test.ts` (جديد) | نص محقون في نتيجة لا يصبح أمرًا أو صلاحية، وبقاء `research.run` عبر Gateway |

البوابة: `typecheck` و`test` و`test:e2e`، ثم `npm run assistant:check -- --live`. هذا الفحص يستعمل Groq في حلقة الدردشة، لا داخل البحث.

## 7. التراجع

| المستوى | الخطوة |
|---|---|
| وقت التشغيل | `SEARCH_ENGINE=legacy` ثم إعادة تشغيل الخادم، فيعود السلوك الحالي دون تغيير كود |
| مرحلة واحدة | `git revert <commit>` محليًا |
| البيانات | `DROP TABLE search_index_terms, search_index_documents, search_cache;`، ولا تمس جدولًا قائمًا |

## 8. ما لن تحققه هذه الخطة

- لن تعطي تغطية عامة للويب دون مصدر بمفتاح.
- لن تجيب الطقس والأسعار اللحظية من الواجهات المجانية الحالية، بل يفتح الوكيل الموقع المعني.
- الفهرس المحلي لا يعادل محرك بحث عامًا.
- أحكام الصلة بوكيل ليست مساوية لحكم بشري كامل.

## 9. المراجع

- [سياسة User-Agent لـWikimedia](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)
- [آداب MediaWiki API](https://www.mediawiki.org/wiki/API:Etiquette)
- [شروط arXiv API](https://info.arxiv.org/help/api/tou.html)
- [حدود Stack Exchange API](https://api.stackexchange.com/docs/throttle)
- [HN Search API](https://hn.algolia.com/api)
- [وصول Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)
- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)
- [Marginalia API](https://about.marginalia-search.com/article/api)
- [ملخص ثانوي عن إغلاق Google Custom Search](https://brave.com/learn/google-api-shutdown/)
- [أسعار Brave من مصدر ثانوي](https://costbench.com/software/ai-search-apis/brave-search-api/)
