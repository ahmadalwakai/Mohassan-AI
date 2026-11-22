# باني المواقع بلا نموذج — سجل العمل (2026-11-22)

**القرار:** موحسن ينشئ أي موقع إلكتروني دون API من أي نموذج آخر (المالك، 2026-11-22). قرارات التفاصيل في
الجلسة نفسها: النشر على Vercel بمفتاح المالك؛ النسخة الأولى مواقع ثابتة متعددة الصفحات (عربي/إنجليزي)؛ الصور من
المستخدم مع رسوم SVG مولَّدة؛ لا خدمة صور ولا نموذج.

**الملكية (لتجنّب التعارض بين الجلسات المتوازية):** هذه الملفات تخص جلسة باني المواقع وحدها حتى إشعار آخر:

- `packages/sites/**` (المولّد النقي)
- `packages/contracts/src/sites.ts` (+ سطر تصدير واحد في `packages/contracts/src/index.ts`)
- `apps/server/src/sites.ts`، `apps/server/src/sites-publish.ts`، `apps/server/src/assistant/site-builder.ts`
- `apps/web/components/sites-workspace.tsx`، `apps/web/components/sites-workspace.module.css`
- `tests/sites-*.test.ts`، `scripts/sites-baseline.ts`، `artifacts/sites-*/`
- هذا الملف.

تعديلات الملفات المشتركة (`command-chat.ts`، `hands.ts`، `brain.ts`، `app.ts`، `members.ts`، `workspace.tsx`،
`apps/web/app/api/[...path]/route.ts`) **لم تبدأ بعد**؛ ستُطبَّق في المرحلة 3 و4 بعد فحص mtimes وبإعلان هنا.

## الجملة المستهدفة

«أكتب له جملة عن نشاطي، فيسألني مرة واحدة، ثم يبني لي موقعاً كاملاً أعاينه على الهاتف والحاسوب، وأعدّله
بكلماتي، وأحمّله أو أنشره، ولا يخترع عني شيئاً، وبلا أي نموذج خارجي.»

**تعديل في أثناء المرحلة 1 (المالك، 2026-11-22):** «هذا لا يكفي؛ يجب أن ينشئ موقعاً كاملاً حسب طلب المستخدم ويسأل
المستخدم إذا احتاج أي شيء». لذلك صار الموقع **صفحات من كتل** (`SiteBlockSchema` في `packages/contracts/src/sites.ts`:
hero, items, text, features, steps, gallery, team, faq, pricing, testimonials, facts, hours, contact (+form), map, cta,
posts) يطلبها المستخدم بالاسم في جملته أو بالأوامر لاحقاً، والمخطِّط `packages/sites/src/plan.ts` **يسأل على دفعات**
(بطاقة ≤ 6 حقول في كل مرة، حتى `MAX_ROUNDS = 6`) عن كل محتوى تحتاجه كتلة مطلوبة، ولا يخترع شيئاً: الأرقام والآراء
والنصوص من المستخدم فقط، وفحص آلي (`check.ts` → `digits_from_brief`) يرفض أي رقم ليس في البريف.

**تبعية تطوير مضافة إلى `package.json` الجذر:** `lighthouse@12.8.2` (للقياس فقط). هذا تعديل في ملف مشترك، أُعلن هنا.

## المراحل

1. المولّد `packages/sites` + العيّنات + الوحدات + القياس الأول (Lighthouse ولقطات) — **جارية**:
   الحزمة مكتوبة، 18 سيناريو تتركّب وتجتاز الفحوص الآلية، 41 اختبار وحدة تمرّ (`npx vitest run tests/sites-*.test.ts`).
   القياس بالمتصفح: `npx tsx scripts/sites-baseline.ts` → `artifacts/sites-2026-11-22/summary.md`.
2. الخادم والواجهة (ترحيل `030_sites`، مسارات، معاينة برمز عام بلا كوكيز، صور، ZIP، عرض «المواقع»).
3. المحادثة (بطاقة واحدة ≤ 6 حقول، أوامر التعديل بالكلام، أسطر الملفات المشتركة).
4. النشر (Vercel، تأكيد، وصول الأعضاء).
5. التقرير بالأرقام المقاسة والقبول.

## ما بُني في المرحلة 1 (كله بلا نموذج)

- `packages/contracts/src/sites.ts`: `SiteBriefSchema` (الهوية والتواصل واللون والهدف + `pages[]` من كتل)، `SitePartialBriefSchema`
  (ما فهمه المساعد حتى الآن)، `SiteWantSchema` (ما يمكن أن يسأله).
- `packages/sites/src/recognize.ts`: `isSiteRequest` (عربي/إنجليزي، يستثني «افتح موقع…» و«عدّل موقعي»)، `detectKind` (6 أنواع
  بمعجم كلمات)، `detectName` (فقط حين تذكره الجملة)، `detectCity` (قائمة مدن بالخطّين)، `detectRequests` (الأقسام المطلوبة بالاسم).
- `plan.ts`: `missingWants` → `siteQuestion` (بطاقة ≤ 6 حقول، على دفعات) → `applyAnswers` (محلّلات للفريق والأسئلة والباقات
  والنقاط والأرقام والآراء والأخبار) → `completeBrief` (افتراضيات بنيوية فقط).
- `families.ts`: خطة الصفحات من النوع + الكتل المطلوبة (`buildPages`، `placeBlock`، `removeBlocks`).
- `blocks.ts` + `css.ts` + `script.ts` + `meta.ts` + `art.ts` + `icons.ts` (أيقونات lucide، ISC) + `copy/` (بنوك جمل ar/en بلا أرقام
  ولا ادعاءات) → `compose.ts`: ملفات الموقع كاملة (صفحات، `styles.css` مُقلَّم ومصغَّر، `site.js` بلا شبكة، شعار وأيقونة ونمط SVG،
  manifest، robots، sitemap عند وجود رابط، JSON-LD من الحقائق المُعطاة، CSP داخل كل صفحة). نموذج التواصل يفتح واتساب أو البريد
  بلا خادم، ويقبل مسار صندوق وارد حين يوفّره الخادم (`formEndpoint`).
- `check.ts`: 14 فحصاً (صلاحية HTML، h1 واحد، ترتيب العناوين، alt، lang/dir، العنوان والوصف، CSP، لا كود مضمَّن، الروابط
  الداخلية، لا مراجع خارجية إلا المسموح، التباين ≥ 4.5، media queries، **الأرقام من البريف فقط**، الحجم).
- `commands.ts`: أوامر التعديل بالكلام (لون، اسم، شعار، أرقام، بريد، عنوان، مدينة، ساعات، إضافة/حذف عناصر وأقسام وصفحات،
  صفحة واحدة، طابع، لغة، نوع، هدف، تراجع)؛ قسم يحتاج محتوى → `ask` بدل الاختراع.
- `zip.ts`: كاتب ZIP حتمي بلا تبعية. `fixtures/scenarios.ts`: 18 سيناريو محادثة حقيقية.
- `scripts/sites-baseline.ts` (القياس) و`scripts/sites-serve.ts` (معاينة يدوية: `npx tsx scripts/sites-serve.ts artifacts/sites-2026-11-22`).

## القياسات

(تُملأ من تشغيل حقيقي؛ لا أرقام مقترحة هنا.)
