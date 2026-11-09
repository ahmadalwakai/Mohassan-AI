# خبير Google Ads

> تحديث 8 نوفمبر 2026: مسار إنشاء حملة Search متوقفة من المحادثة موصول محليًا؛ قبول الاتصال والكتابة الحية ما زال محجوبًا. راجع تحديث `GOOGLE-ADS-API-PLAN.md` و`IMPLEMENTATION-STATUS.md` قبل الاعتماد على وصف المسار التاريخي أدناه. شغّل `npm run ads:setup` لفحص الإعداد دون أي اتصال أو كشف أسرار؛ لا يغيّر الفحص مفتاح التشفير ولا يفعّل النشر.

تكامل رسمي مع Google Ads API (الإصدار `v26`) داخل الحزمة `packages/google-ads`. المساعد يقرأ الأداء ويحفظ المعاينات من المحادثة، أما المراجعة والموافقة والنشر فتتم من قسم Google Ads في الأدوات المتقدمة فقط.

## الوحدات

| الوحدة | الملف | الدور |
| --- | --- | --- |
| GoogleAdsConnectionManager | `connection.ts` | OAuth مع PKCE، تشفير التفويض، اختيار الحساب، ربط الحجوزات |
| AccountPerformanceAnalyzer | `performance.ts` | أرقام مرصودة، حجوزات لكل خدمة، عدم تطابق اللغة والموقع |
| MarketIntelligenceEngine | `intelligence.ts` | عبارات بحث مرصودة منفصلة عن تقديرات Keyword Planner |
| CampaignStrategyEngine | `intelligence.ts` | توصيات حتمية، لكل توصية أساس ومصدر |
| AdQualityValidator | `quality.ts` | حدود النصوص والادعاءات والسياسات والكلمات وصفحة الهبوط |
| CampaignDraftBuilder | `draft.ts` | عمليات الإنشاء الفعلية وبصمتها؛ الحملة تبدأ متوقفة |
| IndependentCampaignVerifier | `verifier.ts` | يقرأ العمليات والحساب من جديد ولا يستورد من البنّاء |
| CampaignPublishingController | `publisher.ts` | موافقة لمرة واحدة، كتابة واحدة، تسوية بقراءة الحساب |
| PerformanceOptimizationEngine | `intelligence.ts` | مقترحات بعتبات عينة، ولا تُطبَّق تلقائيًا |
| VerifiedExperienceMemory | `experience.ts` | لا تقبل إلا ما أعادته Google Ads فعلًا |

## مراحل الحملة

`preview` ← `draft` ← `validated` أو `rejected` ← `verified` ← `approved` ← `publishing` ← `published` ← `launch_approved` ← `launching` ← `live`.

- كل ما قبل `approved` لا يكتب في الحساب. التحقق يرسل طلب `validateOnly` فقط.
- النشر ينشئ الحملة **متوقفة**. الإطلاق كتابة ثانية بموافقة ثانية.
- أي تعديل يغير البصمة، فتسقط الموافقة السابقة.
- الموافقة تربط البصمة والحساب، تنتهي خلال 30 دقيقة، وتُستهلك مرة واحدة.
- الكتابة لا تُعاد تلقائيًا. عند ضياع الرد تصبح الحالة `outcome_unknown` ولا تتغير إلا بقراءة الحساب.

## التوافق مع تغييرات Google لعام 2026

- سقطت developer tokens في 9 سبتمبر 2026 وأصبح الوصول لكل مشروع Cloud. `GOOGLE_ADS_DEVELOPER_TOKEN` اختياري ولا يُرسل إلا إن ضُبط. وثائق Google نفسها ما زالت متعارضة هنا، فيُفحص ذلك في أول تشغيل حي.
- توقف استهداف اللغة اليدوي لحملات البحث في سبتمبر 2026، فالمسودة لا تضيف معيار لغة، والمقارنة تتم بين لغة الإعلان وصفحة الهبوط والموقع. معايير اللغة القديمة تُقرأ فقط لاكتشاف عدم التطابق.
- يشترط إنشاء الحملة حقل `containsEuPoliticalAdvertising`.

## خطوات المالك للربط الحي

1. أنشئ مشروعًا في Google Cloud وفعّل Google Ads API.
2. من صفحة Google Ads API في Cloud Console اطلب مستوى **Explorer**. مستوى Test لا يقرأ إلا الحسابات التجريبية، ويظهر عندها خطأ `GOOGLE_ADS_ACCESS_LEVEL`. Explorer يقيّد تخطيط الكلمات، فتظهر تقديرات Keyword Planner «غير متاحة» حتى مستوى Basic.
3. أنشئ OAuth client من نوع Web application، وأضف عنوان إعادة التوجيه: `<WEB_ORIGIN>/api/google-ads/oauth/callback`. الافتراضي محليًا `http://127.0.0.1:3000/api/google-ads/oauth/callback`.
4. انقل شاشة الموافقة إلى Production إن أمكن: في وضع Testing تنتهي صلاحية التفويض بعد 7 أيام.
5. أضف إلى `.env` القيم `GOOGLE_ADS_CLIENT_ID` و`GOOGLE_ADS_CLIENT_SECRET` و`GOOGLE_ADS_TOKEN_KEY`. يُنشأ المفتاح الأخير بالأمر: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
6. أعد تشغيل الخدمة، واربط الحساب من قسم Google Ads، ثم شغّل الفحص الحي للقراءة:

```bash
npm run ads:check -- --live
```

## بوابات النشر

النشر يبقى مغلقًا حتى تتحقق كلها، وتظهر حالتها أعلى القسم:

| البوابة | الشرط |
| --- | --- |
| `server_switch` | `GOOGLE_ADS_PUBLISHING_ENABLED=true` |
| `connection` | حساب مربوط ومختار |
| `regression_runs` | 20 تشغيلًا متتاليًا ناجحًا من `npm run ads:regress` لنفس نسخة الحزمة |
| `live_read_check` | فحص حي ناجح لهذا الحساب خلال 7 أيام |
| `production_account` | حساب حقيقي، لا حساب تجريبي |

وعلى مستوى كل مسودة: فحص الجودة، ثم التحقق المستقل من صلاحيات الحساب وتتبع التحويلات وصحة المسودة والحفاظ على الموجود وقبول Google بالتحقق دون تنفيذ، ثم موافقتك الصريحة.

**تتبع التحويلات صارم:** يجب وجود إجراء مفعّل يُحتسب وسجّل تحويلًا فعليًا خلال 30 يومًا. إجراء جديد لم يسجل شيئًا يمنع النشر حتى يصل تحويل حقيقي أو اختبار فعلي.

## الحدود الحالية

- لم يُختبر أي شيء ضد Google الفعلية بعد. الاستعلامات والعمليات مبنية على الوثائق ومختبرة على محاكاة، والفحص الحي هو أول إثبات حقيقي.
- حملات البحث فقط، ومجموعة إعلانية واحدة لكل مسودة.
- المقترحات لا تُنفَّذ: تعديل الحملات الحالية يبقى يدويًا من Google Ads.
- الربط لمالك واحد في كل صف؛ لا يوجد فصل بين عدة مستخدمين داخل حساب واحد.
- لا يوجد في المستودع مدقق lint، لذلك فحص الجودة الثابت هو TypeScript الصارم فقط.
