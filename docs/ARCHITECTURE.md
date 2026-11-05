# Mohassan AI — مواصفات التنفيذ v4.0

الحالة: أُنجزت المراجعة المعمارية المستقلة قبل كتابة الكود في 2026-11-04 وفق `ARCHITECTURE-REVIEW.md`. الحالي يتضمن Foundation وRuntime والتخطيط والبرمجة المحدودة عبر Git worktrees وWindows AppContainer، وشريحة استوديو ثابت لملفات HTML/CSS، مع Groq وNeon حقيقيين وتجارب موثقة؛ لا يمثل اكتمال العقل المتكيف أو الاستوديو العام أو اعتمادًا للإنتاج. يحتفظ سجل المراجعة بنتيجته التاريخية، ويوضح `IMPLEMENTATION-STATUS.md` نتائج التجميع النهائية.

## تحديث التنفيذ المحلي للمراحل5–8

أضيفت حزم browser وmemory وwindows وstudio-ai، وخدمة جسر Next مستقلة. الاستوديو الذكي يستخدم Runtime نفسه للموافقة والlease والتوكنات والتحقق، ويستخدم قواعد Git والحصر والنسخ الخاصة من طبقة coding، ثم فاحص المصدر والمعاينة والصور قبل تطبيق SQL ذري. يسترجع مخطط المهام ذاكرة منسوبة ومحدودة كنص غير موثوق، وتوثق الأحداث النهائية في الذاكرة دون تحويل ملخص النموذج إلى حقيقة مثبتة. الجلسات والموافقات الخاصة بالمتصفح والجهاز مستقلة ومحددة النطاق ولا يستنتجها النموذج من النص.

API والعامل المستقل يستخدمان المصانع نفسها لمهام الاستوديو والذاكرة. خدمة API تملك جلسات Chromium والمرافق ومعاينة loopback؛ العامل لا يفتح منفذ المعاينة. عند توفر الجسر يبنى Next في microVM، مع تثبيت مكتبات موثوقة قبل إدخال المصدر ثم منع شبكة VM. لا مفاتيح Control Plane في VM. إعداد Vercel الحالي متعطل قبل إنشاء المشروع؛ التحقق المحلي يستخدم نقل fixture معلنًا ولا يثبت تشغيل VM فعليًا. البث من Windows صور دورية وUIA وإدخال مصرح؛ لا خدمة Session0 أو تجاوز UAC، ولا جهاز مالك مربوط تلقائيًا.

تفاصيل الوحدات وحدودها في PHASE-5-AI وPHASE-5-LIVE وPHASE-6 وPHASE-7 وPHASE-8. النتائج أدناه التي تصف نطاق مرحلة سابقة تاريخية؛ حالة التجميع الحالية في IMPLEMENTATION-STATUS.

## 1. الموجود وحدود المعرفة

عند الفحص الأول كان المستودع يحتوي `instractions and plan.txt` فقط، دون كود أو اعتماديات أو قاعدة بيانات قائمة. لا يوجد ملف v3 مستقل؛ تحفظ هذه المواصفات كل القدرات المذكورة في v4 ولا تدعي التوافق مع كود غير موجود. أضيفت تطبيقات الويب والخدمة والعامل والعقود والتخزين والتشغيل، ثم cognitive وcoding وsandbox؛ أُعد Groq واتصال Neon ونقل البيانات المحلية والتحقق منهما بإذن المستخدم. لا نشر إنتاجي أو ربط لحساب إعلانات أو تحكم عن بعد بجهاز ضمن هذا الإنجاز.

## 2. قرارات التأسيس

- npm workspaces، Node 24 LTS، TypeScript strict، Next.js App Router، Chakra UI 3، Motion.
- Next واجهة ووكيل HTTP من الأصل نفسه؛ خدمة Node دائمة تملك API والمصادقة؛ worker يستخدم نفس runtime ويعمل مستقلاً في الإنتاج.
- PostgreSQL/Neon هو المخزن الفعلي المجهز الآن، باتصال TLS والتحقق من نقل البيانات المحلية؛ لا fallback صامتًا إلى مخزن آخر عند فشله. يظل PGlite محليًا دائمًا للتطوير والاختبارات في عملية مالكة واحدة فقط، ولا يفتح Next أو worker آخر المجلد نفسه.
- Kysely يوحد SQL والمعاملات بين PostgreSQL وPGlite؛ migrations SQL مرقمة. Better Auth يدير البريد/كلمة المرور والجلسات في SQL. لا كلمات مرور أو أسرار ثابتة في المصدر. الإعداد الأول يولد سر جلسة ورمز إعداد محليين، ويحفظهما خارج Git. رمز الإعداد متاح في الملف المحلي `.data/setup-token` فقط، ولا يرجعه HTTP أو يطبعه المشغل في السجل؛ إنشاء المالك متسلسل ومحمي بقيد singleton ولا يوجد تسجيل عام. HTTP bootstrap للتطوير المحلي فقط، أما الإنتاج فيستخدم provisioning إداريًا منفصلًا قبل تعريض الخدمة للشبكة.
- Runtime مشترك واحد. نماذج Groq لا تنفذ أوامر ولا تمنح صلاحيات. موائم Groq اختياري ومحدود بزمن وتوكنات؛ عند غياب المفتاح تعرض الواجهة ذلك صراحة.
- الشريحة الأولى تنفذ `system.diagnostic` بلا آثار خارجية. أضيفت الآن `plan.draft` لتوليد خطة نصية منظمة؛ تصبح active عندما يتوفر موائم التخطيط المجهز، بينما صحة Groq منفصلة: وجود إعداد يعني configured، وverified يحتاج توليدًا ناجحًا مؤرخًا خلال 24 ساعة وبصمة إعداد مطابقة. لا اختبار مدفوع تلقائي لمجرد عرض لوحة التحكم. بقية الأدوات غير نشطة حتى تنفيذ عزلها وصلاحياتها.
- المرحلة الثالثة الحالية تنفذ Goal Compiler وStrategy Planner وتوجيهًا حتميًا بين GPT-OSS 20B و120B وبوابة عدم يقين وتحققًا بنيويًا وسياسيًا مستقلًا؛ نتيجة الخطة تحمل `executionAllowed:false` ولا تستدعي أدواتها المقترحة.
- المرحلة الرابعة الحالية تنفذ `coding.change` لملفات تنفيذ محددة في مشروع Git محلي صغير: موافقة إلزامية، baseline معزول، تعديل نصي، worktree منفصلة، فحص واختبارات معزولة، مراجعة مستقلة وcheckpoint محلي. لا دمج أو رفع أو نشر. موفر العزل الفعلي Windows AppContainer وJob Objects؛ يشارك نواة المضيف، ولا يمثل VM.
- شريحة المرحلة الخامسة تنفذ قراءة HTML/CSS وإعادة بناء معاينة مقيدة، واختيار العنصر وربطه بالملف والسطر، وتحريرًا مباشرًا محفوظًا في نسخة مراجعة SQL مع مقارنة أصل/حالي وتراجع. لا تشغل برنامج المشروع أو نموذجًا أو worker، ولا تمنح حق الكتابة للمصدر المستورد. تكامل محرك البرمجة والأطر الديناميكية وScreenshot-to-code باقٍ.

## 3. الشجرة المستهدفة ومسؤولياتها

```text
apps/
  web/                 Next: RTL، لوحة، مهام، موافقات، قدرات، إعداد، وكيل /api
  server/              Node HTTP API + Better Auth؛ مالك مخزن التطوير
  worker/              نقطة تشغيل عامل الإنتاج الدائم
  ios/                 لاحقًا: SwiftUI، مراقبة، pairing وremote toggle
  windows/             لاحقًا: خدمة محدودة الصلاحية + session helper
packages/
  contracts/           Zod، DTO، task states، permissions، protocol version
  database/            Kysely، migrations، معاملات، adapters، health
  runtime/             claims، leases، registry، policy، executor، verifier
  cognitive/           تحويل الهدف، توجيه النماذج، خطة DAG، بوابة عدم يقين، تحقق مستقل
  providers/           موائم Groq والتطبيع والميزانية
  coding/              مشاريع محدودة، worktrees، locks، diff، checkpoints، تحقق مستقل
  sandbox/             Windows AppContainer + Job، نسخة source RX وTEMP منفصل واختبارات Node
  studio/              تحليل HTML/CSS، ربط العناصر بالمصدر، معاينة مقيدة وتعديل نسخة مراجعة
  browser/             لاحقًا: جلسات Playwright، أدلة، قيود navigation
  memory/              لاحقًا: provenance، expiry، skills، benchmarks
  ads/                 لاحقًا: ingestion، conversion validation، shadow proposals
tests/                 تكامل SQL وAPI ومتصفح؛ حالات الفشل والتعافي
docs/                  معمارية، مراحل، التشغيل، سجل المراجعة
scripts/               تشغيل محلي وفحص دون نوافذ إضافية
```

المجلدات اللاحقة لا تحتوي محركات وهمية؛ تُنشأ عند تنفيذ مرحلتها.

## 4. العقود الحالية — التأسيس والتخطيط والبرمجة والاستوديو الثابت

واجهات التطبيق ترجع JSON، ويحتوي snapshot على `apiVersion: '1'`؛ Better Auth يحتفظ بعقد مكتبته. جميع أوقات DTO بصيغة ISO UTC، وتترجم الواجهة وفق لغة المستخدم. أخطاء التطبيق الحالية `{error:{code,message}}` دون stack أو أسرار أو requestId عام؛ validation تعيد 400، مع 401/403/404/409/413/429/502/503 بحسب السبب. ترجع تفاصيل مورد غير مملوك 404 دون كشف وجوده. يوضح `API-SPEC.md` العقود الفعلية ويفصل عنها عقود v1 المقترحة الموسعة.

Task: `id, ownerId, title, goal, capabilityId, status, autonomy, createdAt, updatedAt, attempt, maxAttempts, result, error, cancellationRequested, projectId`. projectId إلزامي لإنشاء coding.change ومرفوض للقدرات الأخرى؛ يثبت مشروعًا مملوكًا مسجلًا بنطاق immutable. الحالات `queued|running|waiting_approval|verifying|completed|failed|cancelled|paused` والاستقلالية `assisted|scoped|shadow`؛ كل برمجة غير shadow تتطلب موافقة حتى في scoped.

Capability: `id, name, description, version, risk, status, requiredScopes`. النشط `system.diagnostic` و`plan.draft` عند إعداد الموائم و`coding.change` عند إعداد النموذج وإثبات العزل؛ البقية planned أو needs_configuration. snapshot يضم ai وحالة العزل ومشروعات المالك؛ tasks ملخصات مع result=null، وتطلب الواجهة GET المهمة للحصول على diff والسجلات الكاملة. GET لا يرسل هدفًا إلى النموذج.

TaskEvent: `id, taskId, sequence, type, message, createdAt, data`. لا يحفظ prompts أو مفاتيح أو محتوى حساس افتراضيًا.

واجهات الأصل نفسه:

| الطريقة والمسار | الغرض والضمان |
|---|---|
| GET /api/setup | هل يلزم إنشاء المالك؛ دون بيانات حساسة |
| POST /api/setup | تطوير محلي فقط: رمز إعداد من الملف المحلي + Origin مطابق + قفل أول مالك وقيد singleton؛ يغلق بعد نجاحه |
| /api/auth/* | Better Auth: الدخول، الجلسة، الخروج؛ التسجيل العام ممنوع |
| GET /api/workspace | snapshot مصادق عليه: user/tasks الملخصة/capabilities/integrations/storage/ai/coding |
| GET /api/coding/projects | مشروعات المالك وحالة توفر العزل |
| POST /api/coding/projects | تسجيل مشروع Git داخل الجذور المصرح بها بنطاق ملفات قائم وHEAD ثابت |
| POST /api/coding/projects/demo | إنشاء وتسجيل تجربة Node موثوقة محليًا؛ لا تشغيل غير معزول |
| POST /api/ai/verify | جلسة وOrigin وجسم فارغ؛ تحقق صريح محدود 3/دقيقة و12 ثانية، قد يستهلك توكنات |
| POST /api/tasks | Zod، Idempotency-Key لازم؛ نفس المدخلات يعيد المهمة، اختلافها 409 |
| GET /api/tasks/:id | ملكية إلزامية، المهمة والأحداث والخطوات المخططة وإيصالات modelRuns |
| POST /api/tasks/:id/cancel | إلغاء تعاوني، لا بدء خطوات جديدة |
| POST /api/tasks/:id/approve | موافقة المالك مرة واحدة لبصمة المدخلات وإصدار القدرة، ولمدة محدودة؛ تضارب الحالة 409 |
| GET /health | حياة الخدمة فقط؛ لا أسماء مفاتيح أو إعدادات داخلية |

لا يكفي فحص عنوان اتصال localhost لحماية setup: وكيل Next قد يجعل طلب عميل بعيد يظهر محليًا للخدمة. لا يُوثق `X-Forwarded-For` من طلب عميل، ولا يُشتق trusted origin من Host غير موثوق؛ أصل التطبيق إعداد صريح. لا يُعاد رمز الإعداد أو سر الجلسة في snapshot أو logs أو صفحة الأخطاء.

قائمة المتصفحات والـ iPhone لاحقًا تستخدم OpenAPI 3.1 مولدًا من Zod وعقود versioned؛ تغييرات additive في v1، وكسر التوافق يحتاج v2 واختبارات المستهلكين. polling الحالي يستخدم GET مصادقًا بلا تخزين مشترك؛ WebSocket لاحقًا يحتاج تفويض كل subscription وإعادة التحقق عند انتهاء الجلسة أو إلغائها.

## 5. البيانات والعلاقات

Better Auth: `user, session, account, verification` وفق schema المثبت للمكتبة مع adapter SQL مختبر. الكيانات الحالية: bootstrap singleton؛ tasks وproject_id؛ task_events؛ approvals المرتبطة بالبصمة والإصدار والانتهاء وconsumed_lease_token؛ task_plan_steps وtask_plan_dependencies للخطة فقط؛ model_runs وusage_known/result_committed؛ ai_provider_health؛ coding_projects بنطاق HEAD وallowedPaths ثابت وscope hash؛ coding_project_locks؛ coding_runs لأثر المحاولة ونتيجتها. يشير `DATA-MODEL.md` إلى القيود والفهارس الفعلية؛ permission_grants الموسعة وRLS العامة لاحقًا.

قيود: UNIQUE(owner_id,idempotency_key)، FK من الأحداث والموافقات للمهمة، فهارس (owner_id,created_at)، (status,available_at,lease_expires_at)، (task_id,sequence). كل query مرئي للمستخدم يتضمن owner_id. المعاملات تجمع تغيير الحالة وحدثه. لا تعديل ملفات runtime JSON بدل SQL. schema_migrations يسجل النسخ؛ deployment منفصل للترحيلات باستخدام اتصال مباشر إن تطلب Neon ذلك.

لاحقًا: workspaces/projects/environments، task_steps مع DAG dependencies وidempotency receipts، devices/pairing/sessions، conversations/messages، memories/evidence/feedback، skill_versions/evaluations، integrations/credential_references، ads_accounts/campaign_daily/conversions/booking_links، budgets/usage، artifacts/checkpoints/file_locks. جميعها تربط owner/workspace وتحتفظ بـ provenance وtimestamps.

الاحتفاظ الإنتاجي المقترح: أحداث 90 يومًا، آثار منقحة 30 يومًا، لا حذف تلقائي قبل سياسة موثقة؛ TTL للجلسات والموافقات، تصدير/حذف بيانات المالك بمعاملة وعملية audited. هذه السياسات مخططة وليست jobs منفذة.

## 6. دورة التنفيذ والديمومة

1. Authenticate → validate → registry lookup → policy → transaction enqueue + event.
2. assisted يتوقف عند waiting_approval؛ scoped يسمح بالتشخيص أو طلب خطة نصية واحدة محددة عند إعداد الموائم، ولا يجيز تنفيذ خطواتها. shadow ينتج محاكاة محلية ولا يطلب نموذجًا أو ينفذ أثرًا خارجيًا، حتى عند وجود grant؛ ليس موافقة مؤجلة للتطبيق الفعلي.
3. claim ذري على queued مستحقة باستخدام SQL locking/conditional update، lease ذات token عشوائي، attempt محدود وbackoff. يلتزم العامل بتحديث الحالة فقط إذا ما زال token صالحًا.
4. تفحص الحالة والموافقة وexpiry/revocation مجددًا قبل الأداة، ويُستهلك التفويض مرة واحدة ذريًا مع بدء المحاولة المصرح بها. الموافقة المنتهية تعيد المهمة إلى waiting_approval؛ المحاولة الجديدة لا ترث موافقة مستهلكة بصمت. يلغي طلب cancellation الخطوات الجديدة. التشغيل bounded ويقبل AbortSignal.
5. verification منفصل عن executor يتحقق من schema والأدلة والمعايير؛ فشله يمنع completed. كل انتقال مع event في معاملة.
6. بعد تعطل العامل، لا تعاد إلا الأدوات المصنفة replaySafe؛ طلب الخطة أو البرمجة المدفوع أو غير المحسوم يحتاج تفويضًا جديدًا قبل أي طلب آخر. model_runs تسجل started عند بدء طلب النموذج، وتحفظ البرمجة usage فور استلام الرد وقبل parsing والتطبيق والاختبارات؛ null ليس صفرًا. الأثر المتأخر يسوي إيصال lease الخاصة به دون حق اعتماد المهمة. worktree الموجودة تحتفظ بأثرها؛ RUN_ALREADY_EXISTS يمنع الكتابة فوقها ويطلب مهمة جديدة بدل استئناف تلقائي.
7. سُجل تحقق فعلي على Neon لعاملين SQL وفحص claims وfencing؛ هذا يكمل اختبارات PGlite التي لا تثبت وحدها تزامن اتصالات الإنتاج. يظل PGlite بعملية مالكة واحدة، ولا تعني تجربة التزامن الواحدة إثبات الحمل أو التعافي الإنتاجي الكامل.

أداة التشخيص لا تقرأ أسرار env أو مفاتيح أو مسارات شخصية؛ نتيجتها typed وتقتصر على مؤشرات تشغيل غير حساسة. التحقق لا يكتفي بوجود حقل `success` صادر من executor، بل يراجع البنية وقيم الفحوص الفعلية. تفرد sequence يتحقق داخل معاملة؛ تخصيص `MAX(sequence)+1` خارجها غير صالح مع عدة عمال. إيقاف الخدمة يوقف claims جديدة ثم يطلب abort وينتظر مهلة محدودة؛ تنتهي leases المتبقية طبيعيًا للتعافي.

DAG الحالي للتخطيط: رفض المعرفات المكررة والاعتماد المفقود أو الذاتي أو الدوري، وإنتاج executionBatches بترتيب الاعتماديات، ثم حفظ task_plan_steps وعلاقاتها وحالة المهمة والنتيجة في معاملة نهائية واحدة. كل صف خطوة status=planned؛ لا worker ينفذها. DAG التنفيذي لاحقًا يحتاج task_steps وإيصالات أثر مستقلة، وتشغيل ready nodes وأقفال موارد/file paths وoptimistic versions وسياسة فشل وتراجع، مع heartbeat وoutbox. هذه المكونات المستقبلية لا تُستنتج من مجرد حفظ خطة.

## 7. الصلاحيات والثقة

رفض افتراضي. scopes مخططة `task:read/create/cancel`, `diagnostic:read`, `code:read/write/run/publish`, `browser:read/submit`, `device:view/control`, `ads:read/draft/activate/budget/pause`. grant مرتبط owner/device/task/capability/version/resource/input hash/expiry/revocation. الموافقة لا تجيز مدخلات مختلفة. لا endpoint عام لإرسال shell أو SQL.

HttpOnly/SameSite cookies، session validation على كل API، Origin allowlist وCSRF، تحديد معدل auth/setup، عدم التخزين المشترك لردود المالك، TLS وSecure cookies إنتاجيًا، السر في env/KMS. proxies لا يسجلون Cookie/Authorization أو أجسام الدخول، ولا يمررون عنوان destination مأخوذًا من العميل. إعداد الخدمة للإنتاج يرفض PGlite وbootstrap المحلي والأسرار التطويرية وorigins غير الصريحة. ربط جهاز لاحقًا challenge قصير العمر بموافقة من جلسة موثوقة، device keys وتدوير وإلغاء يقطع streams ويمنع أوامر جديدة. تعطيل الجهاز لا يلغي مهام السحابة المستقلة.

## 8. الواجهات والتجارب

الويب: لوحة عربية RTL، اتصال حقيقي، إنشاء مهمة مع هدف/استقلالية، قائمة/بحث وحالات، تفاصيل التنفيذ والأدلة، موافقة/إلغاء، عرض تكاملات غير متصلة وخطة المراحل. كل إجراء يعرض loading/error/empty/permission-denied؛ انقطاع API يحفظ العرض الأخير في ذاكرة الصفحة، يوضح وقت آخر تحديث ويوقف أزرار التعديل ويتيح retry؛ لا يخزن محتوى الملفات أو بيانات الجلسة أو الرموز في localStorage؛ الاستثناء تفضيل عرض فقط يحفظ UUID آخر جلسة استوديو تحت مفتاح خاص بالمالك، وتبقى قراءة الجلسة خاضعة للمصادقة والملكية على الخادم. يحافظ تكرار POST على مفتاح idempotency نفسه حتى نتيجة حاسمة. لا أزرار تفعيل دون capability فعالة. دخول/إعداد/مهام تعمل بلوحة المفاتيح وتسميات حقول واضحة، واحترام reduced motion.

iPhone: login وdevice trust، snapshots وأحداث موثقة عبر WebSocket قصير tokens، task detail/approval، diff review، Ads read first، APNs بدون أسرار، remote toggle محدد الجهاز والزمن، offline read-only وpending approvals لا ترسل تلقائيًا بعد عودة الاتصال.

Windows: service لحماية الجهاز ووسيط أوامر مقيدة، session helper لإمكانية الوصول/الشاشة داخل جلسة المستخدم. WebRTC transport مشفر مع signaling مصادق، STUN/TURN مخطط يحتاج موارد. أذونات view/control منفصلة، مؤشر جلسة مرئي وزر إيقاف محلي. UI Automation قبل vision، لقطة جديدة بعد الفعل، لا تخزين شاشة افتراضيًا.

Coding المنفذ: تسجيل Git محلي داخل الجذور المصرح بها، حتى 40 ملف UTF-8 و128 ألف بايت، و1–5 ملفات تنفيذ موجودة قابلة للتعديل. الاختبارات والإعدادات والاعتمادات والمسارات الحساسة محمية. تثبت الخدمة expectedHash من snapshot، ويقترح النموذج path/content فقط؛ لا يحدد النموذج نسخ الملفات أو أذوناتها. تستخدم أوامر Git محددة بلا hooks أو filters أو اتصال خارجي، وقفل SQL للمسار مع قفل Windows محلي. يخضع المصدر وHEAD والبصمات لفحص مستقل قبل التسليم.

لكل task worktree وفرع وmanifest؛ تختبر baseline والنسخة المعدلة داخل نسخة source للقراءة فقط في AppContainer، مع TEMP منفصل وJob يحد الموارد ويقتل العملية عند الإلغاء. لا يمنح Node صلاحيات worktree أو المشروع أو أسرار الخدمة، ولا npm/shell. SandboxTestResult تحمل بصمة النسخة وإيصال العزل؛ CodingResult تحمل diff وchecks وcheckpoint وoutcome، وmerged=false. ready_for_review تعني نجاح الصياغة والاختبارات والمراجعة؛ tests_failed/review_failed تحفظ أثرًا فاشلًا واضحًا بدل completed. تبقى worktrees/checkpoints للمراجعة، ولا API استعادة أو دمج أو نشر أو تنظيف تلقائي حاليًا. راجع `ISOLATION.md` لحدود النواة المشتركة وعدم وجود حصة قرص صلبة.

الاستوديو الثابت المنفذ يستورد حتى 40 ملف HTML/CSS و128,000 بايت داخل جذور القراءة المصرح بها، ويحفظ نسخة أصلية وحالية وآخر20 حالة تراجع في `studio_sessions`؛ حتى20 جلسة للمالك. لا يحتاج Git أو اختبارات Node، ولا يشغل كودًا أو build. ربط العنصر بالملف والسطر مشتق من مواقع محلل HTML؛ التعديل المباشر نص أو لون أو حجم خط في نسخة SQL فقط. مصدر المجلد وGit لا يكتب إليهما. قفل صف الجلسة ومقارنة revision يمنعان حفظ نسخة قديمة؛ كل حفظ أو تراجع فعلي يولد إصدارًا جديدًا.

المعاينة الثابتة `iframe srcDoc sandbox="allow-scripts"` بلا same-origin، ذات أصل opaque. يعاد بناء HTML بقائمة مسموحة ويمنع CSP الشبكة والموارد الخارجية وتنفيذ كود المشروع. الاستثناء المحدد للشريحة يقبل origin=`null` عند تطابق نافذة الإطار وnonce والإصدار والعقد ومعرف العنصر فقط؛ يسمح `postMessage('*')` لقناة اختيار/مسودة محدودة، لا طلبات API أو أسرار أو حفظ. الحفظ عبر API مصادق مستقل وبربط مصدر معاد اشتقاقه. لا يُوسّع هذا الاستثناء سياسة Origin/CORS للخدمة. راجع `PHASE-5.md`.

المتبقي للاستوديو العام: بيئات تشغيل للأطر على أصل منفصل مناسب لكل بيئة، وsourcemaps للمكونات الديناميكية، وتوصيل التعليمات إلى محرك البرمجة وموافقاته وworktrees واختباراته، وscreenshots وvisual diff آلي وScreenshot-to-code. المقارنة الحالية بين نسختين ثابتتين وفرق المصدر لا تثبت عمل تطبيق أو نجاح اختبارات مشروع.

Browser/Research: جلسات ومجلدات مستقلة، navigation egress policy وSSRF defense، اعتبار صفحات الويب بيانات غير موثوقة، عدم اتباع تعليماتها، citations مع تاريخ ومقارنة مصادر وتعارضات ودرجة ثقة. recorder منقح، approval قبل submit/send/purchase، verification بعد كل خطوة مهمة.

Ads: OAuth scopes الأقل، developer token وcustomer/manager IDs حقيقية فقط، ingestion paginated incremental مع watermarks وbackfill وrate limits، currency/timezone محفوظة، conversions offline مرتبطة بالحجوزات بمفاتيح dedup consent. تتبع صحيح قبل budget optimization، qualified completed booking CPA معيار أساسي، shadow proposals ثم approval منفصل لكل activate/budget/pause مع سقف إنفاق واسترجاع قابل للتدقيق.

## 9. العقل والذاكرة والتقييم

المنفذ في المرحلة الثالثة: Goal Compiler يحد المدخل ويعزل نص الهدف غير الموثوق؛ Groq يولد RawCognitivePlanSchema الصارمة؛ StrategyPlanner يشتق الصلاحيات والموافقة وavailability من registry بدل الوثوق بالنموذج، ويرتب DAG؛ router حتمي للنموذج السريع أو الاستدلالي؛ UncertaintyEngine يطلب التوضيح عند ثقة منخفضة أو سؤال أو مجهول عالي الأثر أو قدرة غير متاحة؛ verifier يعيد حساب البنية والسياسة والاعتماديات. PlanningResult تصف `verification.scope='structure_and_policy'` و`executionAllowed=false`؛ لا تثبت صحة افتراضات الخطة أو نجاح التنفيذ.

حدود الموائم الحالية: هدف حتى 4000 حرف، سياق نواة حتى 24 ألف حرف، مخرجات حتى 4096 توكن لكل طلب، وحد طلبين مع fallback واحد بعد رفض 429/503 بلا usage فقط. لا retry للشبكة الغامضة أو الرد المدفوع المرفوض؛ تُحفظ usage المعلومة حتى عند truncation أو فشل البنية أو الإلغاء. هذه حدود مخرجات وحجم سياق، وليست ضمانة مسبقة لعدد input+output tokens أو لسعر نقدي. يحدد signal مهلة طلب المزود وجسم رده، والحجم محدود؛ تنقيح الأنماط السرية حاجز إضافي وليس إثبات إزالة كل معلومة حساسة.

دليل حي مسجل بواسطة مسؤول التجميع في 2026-11-04 عبر `scripts/check-ai.ts`: أعاد Groq من `openai/gpt-oss-20b` خطة اجتازت structure_and_policy، باستهلاك معلن 1216 input و694 output، وحُفظت 3 خطوات SQL مع executionAllowed=false. استُخدم مالك اختبار ومخزن معزولان، وحُفظت صحة الاتصال في مخزن المستخدم. لا تُضاف هنا أرقام اختبارات التجميع قبل نتائج مسؤول التجميع النهائية.

المتبقي للعقل المتكيف الكامل: توجيه أداء/تكلفة مبني على قياس وميزانيات ذرية، supervisor للجمود، World State بحقوق مصدر وانتهاء، استرجاع سياق طويل وتلخيص موثق، وتقييم holdout وتعلم مقاس. الذاكرة والمهارات والقدرات التنفيذية التالية لا تصبح متاحة تلقائيًا بسبب اتصال النموذج.

ذاكرة working/episodic/semantic/procedural/failure/preference مع provenance وexpiry وowner. feedback يصنف تفضيل دائم أو تصحيح مهمة أو benchmark evidence؛ لا ترقية تلقائية. Skill lifecycle candidate→sandbox_test→benchmark→approval→active→revoke، إصدارات غير قابلة للتبديل بصمت. benchmarks ثابتة train/holdout وقياس completion/error/cost/regression؛ rollback عند تراجع. Registry يصف schemas/risk/version/scopes/health، ولا يمنح الثقة للأداة بمجرد التسجيل.

## 10. التشغيل والقياس والاستعادة

التشغيل الحالي يجمع خدمة API والعامل مع اتصال Neon فعلي وواجهة الويب المحلية؛ يمكن فصل العامل على PostgreSQL. حُوّل sslmode=require إلى verify-full في الموائم، ولا يعطل التحقق من الشهادة؛ رصد مسؤول التجميع TLS فعليًا، ونجاح الترحيلات ونقل البيانات المحلية مع تحقق المطابقة، وتجربة عاملين SQL وfencing. لا يرجع التطبيق تلقائيًا إلى PGlite عند فشل Neon. لا تكتب قيم الاتصال أو معرفات الحساب في الوثائق.

دليل المرحلة الرابعة الحي المسجل بواسطة مسؤول التجميع: Groq GPT-OSS 120B باستهلاك 620 input و98 output؛ baseline اختبارات exit=1، وبعد التعديل داخل AppContainer exit=0، مع checkpoint محلي وsourceUnchanged=true وmerged=false. هذه تجربة مشروع محدد، وليست اكتمال الاستوديو أو ضمان كل مشروع أو اعتماد إنتاجي.

البنية الإنتاجية المستهدفة: Vercel للويب والوكيل، وخدمة API/worker دائمة، وأدوار migration/runtime منفصلة وKMS وquotas ذرية وقياس تكلفة بسعر موثق. موفر AppContainer الحالي يحتاج Windows؛ تشغيل خدمة التنفيذ على بيئة أخرى يحتاج موفرًا مثبتًا بدل استخدام host fallback. لا نشر إنتاجي أو ادعاء VM من هذه الشريحة.

OpenTelemetry traces المخططة تربط request/task/step/tool دون prompts، وmetrics queue age/leases/retries/verifier failures/cost، مع dashboard/replay. logs التشغيلية الحالية منقحة ومحدودة؛ تنبيهات الإنتاج وOpenTelemetry وخدمة realtime غير منفذة حاليًا، ويستخدم الويب polling قصيرًا قابلًا للاستبدال.

DR: Neon PITR حسب الخطة المتاحة، نسخة مشفرة خارجية، RPO/RTO يتفق عليهما قبل الإنتاج، تمرين restore في بيئة منفصلة وفحص counts/hash/ownership/replay. نسخة .data المحلية ليست backup إنتاجيًا. secrets references في DB وKMS للخزن والتدوير لاحقًا، لا إرسال مفاتيح للمتصفح.

## 11. مراحل التنفيذ والقبول

| المرحلة | الناتج | الاختبار/القبول | المخاطر والاعتماد |
|---|---|---|---|
| 1 Foundation | monorepo/auth/contracts/SQL/RTL | دخول، عزل مالك، Zod، build | أسرار/Neon للإنتاج |
| 2 Runtime | registry/policy/queue/events/leases | idempotency/restart/fencing/cancel/approval/verifier | SQL races |
| 3 Cognitive | المنفذ: Groq/هدف typed/router/خطة DAG/بوابة عدم يقين/verifier/ledger | اختبارات البنية والسياسة والفشل، وطلب حي مثبت؛ holdout والتعلم الكامل لاحقًا | صلاحية النموذج/التكلفة، لا تنفيذ للخطة |
| 4 Coding | المنفذ: مشروعات Node محدودة/worktrees/AppContainer/tests/diffs/checkpoint/review | baseline→patch→اختبار ومراجعة مستقلة مثبتة، مع source unchanged وno merge | Windows OS boundary؛ استعادة عامة/VM/broad build لاحقًا |
| 5 Visual | المنفذ: معاينة HTML/CSS وتحديد/ربط مصدر وحفظ SQL وتراجع ومقارنة؛ التشغيل العام وScreenshot-to-code لاحقًا | اختيار→مصدر→حفظ نسخة→معاينة ومقارنة؛ منع الرسائل المزورة والنسخ القديمة | iframe opaque/CSP؛ تكامل محرك البرمجة والأطر لاحقًا |
| 6 Research | Playwright/sources | injection/SSRF/approval/citations | egress policy |
| 7 Memory | provenance/skills/evals | expiry/retrieval/benchmark regression | جودة الأدلة |
| 8 Windows | pairing/stream/control | revoke أثناء action، helper restart | signing/TURN |
| 9 iPhone | SwiftUI/tasks/APNs | simulator+device/offline/revoke | macOS+Apple |
| 10 Ads | read pipeline/shadow/apply | sandbox account/dedup/CPA/limits | OAuth+developer token |
| 11 Reliability | OTel/KMS/backup/quotas | restore/load/penetration/failure drills | موارد تشغيل |
| 12 Production | deployment/runbooks/E2E | full journey+rollback+signoff | بيانات اعتماد وبيئة فعلية |

الأمن والتكامل يختبران منذ المرحلة الأولى. نُفذت شريحة التأسيس والتشخيص والتخطيط ثم البرمجة المحدودة والاستوديو الثابت، مع Groq وNeon فعليين؛ بقية جوانب العقل وعمومية Coding Lab واكتمال المرحلة الخامسة والمراحل 6–12 لا تُعد مكتملة. سجل التنفيذ النهائي هو مرجع نتائج البناء والمتصفح والتجميع؛ لا تضاف هنا أرقام تجميع مستقلة.

## 12. متطلبات المراحل التالية والإنتاج

Groq وNeon مجهزان ومثبتان حيًا؛ تظل قيم اعتمادهما على الخادم ولا توثق هنا. قبل الإنتاج تبقى أدوار SQL وسياسات النسخ والاستعادة والحمل والاحتفاظ والميزانية ونطاق/مشروع Vercel وخدمة API/worker دائمة وKMS وOTel collector. توسيع العزل إلى VM أو بيئة غير Windows يحتاج موفرًا وبيانات اعتماده والتحقق من حدوده. المراحل التالية تحتاج Google Ads OAuth/developer token وحساب اختبار، وmacOS/Xcode وApple/APNs، وتوقيع Windows وTURN. لا تختلق جاهزية هذه المتطلبات.

## مراجع التنفيذ

- https://nextjs.org/docs/app
- https://chakra-ui.com/docs/get-started/frameworks/next-app
- https://better-auth.com/docs/adapters/other-relational-databases
- https://pglite.dev/docs/filesystems
- https://console.groq.com/docs/api-reference

هذه مراجع APIs؛ تفاصيل الإصدارات النهائية تثبت في package-lock.json بعد التركيب.

## توسعة المرحلة5 — React SSR داخل العزل الحالي

packages/studio-react يفصل تحليل JSX/TSX وربط المصدر عن تجميع افتراضي موثوق، ثم يستخدم SandboxRunner الحالي لعرض ReactDOMServer داخل AppContainer. React وReactDOM وTypeScript وesbuild نسخ مثبتة ضمن التطبيق؛ ملفات وإعدادات المشروع لا تُحمّل كبرامج داخل الخدمة. لا يتوسع موفر العزل للشبكة أو العمليات الفرعية أو تشغيل Next dev.

يحفظ Control Plane نسخة المصدر وأثر العرض وإيصال بصمتي المصدر والتنفيذ. يظل HTML الناتج غير موثوق وينقّى عبر الاستوديو الثابت ثم يعرض في إطار opaque وجسر التحديد الموثوق. النسخ المحفوظة لا تنفذ على GET. البناء خارج معاملات SQL، ثم تحقق revision وقفل الصف وحفظ المصدر والأثر ذرّيًا. تفاصيل الحدود في PHASE-5-REACT.md؛ تشغيل Next الكامل وربط هذه التعديلات بمهام البرمجة والذكاء وworktrees يبقى توسعة لاحقة.
