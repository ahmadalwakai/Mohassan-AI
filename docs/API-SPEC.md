# عقود API والأدوات — Mohassan AI

التاريخ: 2026-11-04. القسم الأول يصف واجهات التأسيس والاستوديو الأولي. توسعات المراحل5–8 المنفذة موثقة في PHASE-5-AI وPHASE-5-LIVE وPHASE-6 وPHASE-7 وPHASE-8؛ هذه مراجع العقود الحالية لتلك الوحدات. بقية الأقسام الموسومة بالمقترح تصف تصميمًا مستقبليًا. لا يوجد ملف OpenAPI مولد حاليًا. تُولد المواصفات لاحقًا من schemas مثبتة مع اختبارات توافق المستهلكين.

## 1. واجهات v1 المنفذة فعليًا

الإصدار المنطقي الحالي v1؛ المسارات الحالية تبدأ `/api` ولا تتضمن `/v1`. مرجع الحقيقة: `apps/server/src/app.ts` و`packages/contracts/src/index.ts` وعقود Better Auth المثبتة.

المتصفح يستخدم وكيل Next من الأصل نفسه. الوكيل يضيف `x-mohassan-internal` من بيئة الخادم؛ لا يحصل المتصفح أو iPhone أو النموذج على هذا السر. كل طلب للخدمة، عدا `/health` ومساري POST للمرافق `/api/windows/companion/pair` و`/api/windows/companion/poll`، يتطلبه؛ للمرافق مصادقة جهاز مستقلة ورفض Origin وFetch Metadata المتصفحية؛ غيابه أو خطؤه يعيد 401 `SERVICE_UNAUTHORIZED`. طلبات التعديل تحتاج Origin مطابقًا لإعداد الخدمة، وإلا 403 `ORIGIN_DENIED`. يقبل التطوير اسم localhost و127.0.0.1 المتكافئ للمنفذ نفسه.

أجسام الطلبات العامة JSON حتى16,384 بايت؛ رفع صورة الاستوديو حتى1,500,000 بايت في الوكيل والمسار المخصص، وصورة منقحة حتى1MB. نقل صور Windows له حد مستقل في مسار الجهاز ولا يمر عبر وكيل المتصفح. الحد العام للخدمة 120 طلبًا/دقيقة، وللإعداد 5/دقيقة، ولـ Better Auth حد مستقل30/دقيقة، ولقراءة الجلسة120/دقيقة كي لا تقطع إعادة فتح العروض، وتبقى محاولات كلمة المرور3 كل10 ثوان، ولاختبار Groq الصريح 3/دقيقة. قد يعاد 413/429. ردود الموارد والجلسات تحمل `Cache-Control: no-store`؛ الوكيل لا يخزن fetch، ولا يتبع تحويلات upstream، وينقل `Set-Cookie` وRetry-After/X-Retry-After العدديين دون كشف السر الداخلي. مهلة اتصاله 15 ثانية، و360 ثانية لطلبات POST للاستوديو التي قد تبني معاينة معزولة، و60 ثانية لأفعال المتصفح والبحث؛ الفشل يعيد 503 `SERVICE_UNAVAILABLE`.

| الطريقة والمسار | الطلب والهوية | نجاح فعلي | أخطاء مهمة |
|---|---|---|---|
| GET `/health` | لا جلسة ولا سر خدمة؛ حياة العملية فقط | 200 `{status:'ok'}` | لا يثبت سلامة كل التكاملات |
| GET `/api/setup` | سر الوكيل؛ لا جلسة | 200 `{needsSetup:boolean,setupAvailable:boolean}` | لا يرجع رمز إعداد أو بيانات مالك |
| POST `/api/setup` | `{name,email,password,setupToken}`؛ Origin؛ تطوير محلي فقط | 200 `{ok:true}` | 400 schema، 403 رمز خاطئ/إعداد إنتاج معطل، 409 مالك موجود أو إعداد جارٍ |
| POST `/api/auth/sign-in/email` | `{email,password}` وJSON وOrigin؛ لا جلسة سابقة | 200 عقد Better Auth: `user,token,redirect` وقد يتضمن `url`؛ `Set-Cookie` | رفض بيانات الدخول وفق عقد Better Auth |
| GET `/api/auth/get-session` | cookie اختيارية | 200 `{session,user}` أو `null` | عقد Better Auth الخام |
| POST `/api/auth/sign-out` | cookie وOrigin وجسم `{}` | 200 `{success:true}`، وإبطال الجلسة وإزالة cookie | إعادة استعمال cookie القديمة لا تعيد جلسة |
| `/api/auth/*` الأخرى | تشمل sign-up وreset/update غير المسموح بها | لا نجاح متاح | 403 `AUTH_ACTION_DISABLED` |
| GET `/api/workspace` | جلسة مالك | 200 `WorkspaceSnapshot` أدناه | 401 `UNAUTHORIZED`؛ خطأ SQL لا يكشف تفاصيله |
| GET `/api/coding/projects` | جلسة مالك | 200 `{projects:Project[],sandbox:SandboxStatus}` | 401 جلسة؛ لا تعرض مشروعات مالك آخر |
| POST `/api/coding/projects` | جلسة وOrigin؛ `{name,path,allowedPaths}` | 200 `Project`؛ يتكرر التسجيل نفسه دون إنشاء نطاق جديد | 400 schema/جذر/ملفات/نطاق غير مسموح؛ 409 تعارض؛ خطأ إعداد الخدمة منقح |
| POST `/api/coding/projects/demo` | جلسة وOrigin وجسم `{}`؛ محدود 5/دقيقة | 200 `Project` لتجربة Node محلية داخل نطاق الخدمة | 400 جسم غير صالح؛ خطأ إعداد/قفل منقح |
| GET `/api/studio/sessions` | جلسة مالك | 200 `{sessions:StudioSessionSummary[]}` دون ملفات المصدر | 401 جلسة |
| POST `/api/studio/sessions` | جلسة وOrigin؛ `{name,path,framework?:'static'\|'react'\|'next',entryPath?:string}`؛ محدود 10/دقيقة | 200 `StudioSession`؛ React/Next يبنيان عرضًا معزولًا قبل حفظ الجلسة | 400 نطاق/استيراد/صياغة؛ 409 تعارض/حد/بناء آخر؛ 422 فشل العرض؛ 503 غياب عزل مثبت |
| POST `/api/studio/sessions/demo` | جلسة وOrigin؛ `{framework?:'static'\|'react'\|'next'}`؛ محدود 5/دقيقة | 200 `StudioSession`؛ تجربة مستقلة لكل نوع؛ يعيد الموجودة دون تشغيل عند التكرار | 400 جسم زائد؛ 409 حد الجلسات؛ 422/503 بناء React |
| GET `/api/studio/sessions/:id` | جلسة وUUID وملكية | 200 `StudioSession` مع الأصل والنسخة الحالية | 404 غير موجود أو غير مملوك |
| GET `/api/studio/sessions/:id/preview` | جلسة وملكية | 200 `StudioPreview` للنسخة الحالية مع nonce جديد | 404 ملكية؛ 400 محتوى غير مدعوم |
| GET `/api/studio/sessions/:id/baseline` | جلسة وملكية | 200 `StudioPreview` للمصدر الأصلي مع revision الحالية وnonce مستقل | 404 ملكية |
| POST `/api/studio/sessions/:id/edits` | جلسة وOrigin؛ `{revision,elementId,text?,styles?}` | 200 `StudioSession` بعد حفظ نسخة المراجعة | 400 schema/تنسيق؛ 409 نسخة قديمة أو عنصر غير موجود |
| POST `/api/studio/sessions/:id/undo` | جلسة وOrigin؛ `{revision}` | 200 `StudioSession` بعد استعادة آخر نسخة وإصدار جديد | 409 نسخة قديمة أو سجل تراجع فارغ |
| POST `/api/ai/verify` | جلسة مالك وOrigin وجسم `{}`؛ لا مفتاح في الطلب | 200 `AIStatus` بعد فحص قائمة النماذج وطلب توليد صغير فعلي | 400 جسم زائد، 409 `NOT_CONFIGURED`، 502 خطأ المزود المنقح، 429 حد المعدل |
| POST `/api/tasks` | جلسة + `Idempotency-Key` + `CreateTask` | 200 `Task` مباشرة، حتى عند تكرار الطلب | 400 schema/key، 403 `CAPABILITY_UNAVAILABLE`، 409 `IDEMPOTENCY_CONFLICT` |
| GET `/api/tasks/:id` | جلسة وملكية المهمة | 200 `{task,events,steps,modelRuns}` أدناه | 404 `TASK_NOT_FOUND` عند عدم الملكية أيضًا |
| POST `/api/tasks/:id/approve` | جلسة مالك؛ لا حقول جسم مطلوبة | 200 `Task`؛ موافقة لعشر دقائق ثم queued | 404 ملكية، 409 ليست waiting_approval، 403 قدرة غير متاحة |
| POST `/api/tasks/:id/cancel` | جلسة مالك؛ لا حقول جسم مطلوبة | 200 `Task`؛ الطلب النهائي مكرر آمن | 404 ملكية؛ الجاري يتوقف تعاونيًا |

`Setup`: name مقصوص 2–80، email صحيح، password بطول 12–128، setupToken بطول 32–256؛ الحقول الإضافية مرفوضة. الرمز مولد محليًا وموجود في ملف إعداد محلي مستبعد من Git، ولا يرجعه HTTP. إنشاء المالك محمي بقيد singleton؛ بداية خدمة التخزين المحلي الحصرية تستعيد حجزًا يتيمًا عند عدم وجود مستخدم. لا يسمح ذلك بتسجيل عام.

الجلسة cookie تديرها Better Auth: HttpOnly، وتكون Secure في الإنتاج، وcookieCache معطل، والعمر 7 أيام مع تحديث دوري. اسم cookie وتفاصيل session يتبعان إصدار المكتبة المثبت. لا يستخدم العميل `token` المعاد من المكتبة بوصفه تفويض أدوات أو بديلًا للسر الداخلي؛ الواجهة تعتمد cookie ولا تحفظها في localStorage.

`CreateTask = {title:string[3..120],goal:string[5..4000],capabilityId:'system.diagnostic'|'plan.draft'|'coding.change',autonomy?:'assisted'|'scoped'|'shadow',projectId?:UUID}`. projectId إلزامي للبرمجة ومرفوض لبقية القدرات؛ الملكية تفحص قبل الحفظ، والمشروع غير المملوك يعيد 404. title/goal يقصان، default autonomy هو assisted، والحقول الإضافية مرفوضة. مفتاح idempotency بطول 8–128 ومحارف `[a-zA-Z0-9_-]`؛ التفرد ضمن المالك، والمقارنة على المدخلات المطَبّعة بما فيها projectId. إعادة المفتاح والمدخلات نفسها تعيد المهمة نفسها بحالتها الحالية؛ اختلافها 409 دون إعادة جدولة.

`Task = {id,ownerId,title,goal,capabilityId,status,autonomy,createdAt,updatedAt,attempt,maxAttempts,result:object|null,error:string|null,cancellationRequested:boolean,projectId?:string|null}`. الحالات `queued|running|waiting_approval|verifying|completed|failed|cancelled|paused`؛ paused محجوز في schema ولا يوجد endpoint إيقاف مؤقت حاليًا. الأوقات ISO UTC، ولا يعيد DTO الـ lease أو بصمة المدخلات أو الأسرار.

`TaskEvent = {id,taskId,sequence:number,type,message,createdAt,data:object}`. sequence فريد ومتزايد للمهمة؛ أمثلة type: `task_created,approval_required,task_approved,execution_started,verification_started,verification_passed,verification_failed,task_cancelled,retry_scheduled,lease_recovered`. تفاصيل المهمة ترجع جميع أحداثها الحالية؛ لا cursor أو replay شبكي منفذ.

`WorkspaceSnapshot = {apiVersion:'1',user:{id,name,email},tasks:Task[],capabilities:Capability[],integrations:Integration[],storage:{mode:'embedded'|'postgres',healthy:boolean},ai?:AIStatus,coding?:CodingWorkspace}`. الخدمة الحالية ترجع ai وcoding؛ اختياريتهما في schema تحفظ التوافق. تعرض أحدث 200 مهمة للمالك دون pagination أو total، **كملخصات مع result=null دائمًا** لتجنب تحميل diffs وسجلات الاختبارات في كل polling. GET `/api/tasks/:id` يعيد النتيجة الكاملة. `Capability={id,name,description,version,risk:'low'|'medium'|'high',status:'active'|'planned'|'needs_configuration',requiredScopes:string[]}`. `Integration={id,name,description,status:'connected'|'planned'|'needs_configuration',detail}`.

`AIStatus={configured:boolean,status:'unconfigured'|'configured'|'verified'|'error',model:string|null,verifiedAt:string|null,message:string}`. وجود المفتاح يجهز التخطيط ولا يثبت الاتصال. verified تحتاج نجاح توليد فعلي خلال 24 ساعة وبصمة إعداد تطابق المفتاح والنموذجين الحاليين؛ تنتهي الصلاحية أو يتغير الإعداد فتعود configured. قراءة workspace لا تنفذ طلب نموذج. فشل المصادقة/صلاحية النموذج يحدّث الصحة، ولا تعاد مفاتيح أو بصماتها في DTO.

`system.diagnostic` نشطة دائمًا؛ `plan.draft` نشطة عند تركيب موائم التخطيط المجهز. `coding.change` نشطة فقط مع إعداد النموذج ومحرك البرمجة ونجاح إثبات موفر العزل؛ غير ذلك needs_configuration. active لا يثبت نجاح اتصال النموذج، وAIStatus مخصصة لذلك. scoped يسمح بطلب الخطة المحدد، بينما **كل coding.change غير shadow تتطلب موافقة حتى في scoped**. الموافقة تشمل سياق الملفات المحدد، والتوليد المدفوع، وتعديل worktree واختبار نسخته؛ لا دمج أو رفع أو نشر. shadow محاكاة محلية دون Groq أو worktree أو تشغيل كود. لا API عامة لأوامر shell أو Ads.

`CodingWorkspace={projects:Project[],sandbox:{available:boolean,provider:string|null,message:string}}`. `Project={id:UUID,ownerId,name,path,baseCommit,allowedPaths:string[1..5][],testProfile:'node-test',createdAt}`. التسجيل name بطول 2–100 وpath بطول 3–500 وallowedPaths بعدد 1–5 ومسار نسبي حتى 180 حرفًا. path جذر Git محلي canonical داخل CODING_ALLOWED_ROOTS أو مجلد خدمة البرمجة؛ لا قبول gitdir خارجي أو symlinks/hardlinks أو مشروع غير نظيف أو مسارات اعتماد حساسة أو اعتمادات npm. الشريحة الحالية حتى 40 ملف UTF-8 و128 ألف بايت إجمالًا، مع اختبارات Node محفوظة مسبقًا.

تسجيل المشروع يثبت `(canonicalPath,baseCommit,allowedPaths)` ويعيد التسجيل نفسه للمالك عند تطابق هذا النطاق؛ لا يحتاج Idempotency-Key ولا يوجد تعديل in-place للنطاق. تغيير HEAD أو allowedPaths يحتاج تسجيلًا مستقلًا. لا يقبل allowedPaths اختبارات أو إعدادات أو ملفات جديدة؛ تعدل ملفات تنفيذ JS/MJS/CJS/TS الموجودة فقط. قفل SQL للمسار وقفل Windows محلي يمنعان تضارب التنفيذ؛ لا تمنح أسماء المسارات القادمة من النموذج أي صلاحية.

نتيجة التشخيص `kind:'diagnostic',summary,observedAt,checks:[{name,passed,evidence}],verifiedAt`، والفحوص `database,capability_registry,permission_scope`. نتيجة التخطيط `PlanningResult={kind:'plan',summary,plan:CognitivePlan,executionBatches:string[][],needsClarification,model,provider:'groq',routeReason,usage:{inputTokens,outputTokens},generatedAt,verifiedAt,verification:{passed:true,scope:'structure_and_policy',checks:string[]},executionAllowed:false}`.

`CognitivePlan={summary,goal:{objective,successCriteria:[{id,description,evidence}],constraints:string[],assumptions:string[],clarifyingQuestions:string[]},steps:PlanStep[],uncertainties:[{description,impact:'low'|'medium'|'high',resolution}],confidence:number[0..1]}`. `PlanStep={id,title,description,dependsOn:string[],capabilityId:string|null,requiredScopes:string[],requiresApproval:boolean,acceptanceCriteria:string[],availability:'available'|'unavailable'|'manual'}`. النصوص محدودة، والخطوات 1–12 ومعرفاتها ASCII فريدة، والاعتماد المفقود أو المكرر أو الدوري مرفوض. RawCognitivePlanSchema المرسل للنموذج لا يتضمن availability؛ الخدمة تشتقها والصلاحيات والموافقة من السجل، وتعيد اشتقاقها عند التحقق. ثقة النموذج ليست دليلًا؛ confidence أقل من 0.65 أو سؤال معلّق أو عدم يقين عالي الأثر أو قدرة غير متاحة يجعل needsClarification=true.

`TaskDetail.steps` ترجع `{id,taskId,stepId,title,dependsOn,status:'planned',capabilityId,availability}`، وترجع الخدمة أيضًا `description,requiredScopes,requiresApproval`. تحفظ الخطوات والاعتماديات في SQL مع نتيجة المهمة في المعاملة النهائية نفسها؛ executionBatches ترتيب اعتماديات مقترح، ولا يوجد تشغيل تلقائي لهذه الخطوات. completed لمهمة plan.draft يعني اكتمال إعداد الخطة والتحقق البنيوي منها، وليس تحقق هدف المستخدم أو تنفيذها.

`TaskDetail.modelRuns` ترجع `{id,taskId,attempt,status:'started'|'succeeded'|'failed'|'unknown',model:string|null,inputTokens:number|null,outputTokens:number|null,startedAt,finishedAt:string|null,resultCommitted:boolean}`، وترجع الخدمة أيضًا `provider,usageKnown`. يسبق receipt بدء طلب النموذج؛ null يعني استخدامًا مجهولًا لا صفرًا. قد تكون failed ومعها usage معلومة عند رفض مخرجات مدفوعة. انتهاء lease أو الإلغاء يمنع اعتماد المهمة؛ الرد المتأخر يستطيع تحديث إيصال lease الخاصة به فقط. resultCommitted يميز حفظ الخطة عن مجرد وصول إيصال توليد.

توجيه النماذج حتمي: الهدف البسيط إلى `openai/gpt-oss-20b`، والمعقد إلى `openai/gpt-oss-120b` افتراضيًا، ويمكن ضبطهما من الخادم. حد طلبين، والثاني فقط بعد رفض 429/503 مؤكد دون usage؛ لا retry لانقطاع شبكة أو نتيجة غامضة أو رد مدفوع مرفوض. حد المخرجات 4096 لكل طلب، وسياق النواة 24 ألف حرف؛ هذه ليست ضمانة مسبقة لعدد input+output tokens. يحتفظ PlanningError باستخدام معروف بعد truncation/فشل البنية/الإلغاء، ولا يحتفظ بالمحتوى الخام. مهلة طلب المزود 30 ثانية وتشمل جسم الاستجابة، واختبار الاتصال الصريح 12 ثانية إجمالًا، مع حد جسم رد 256 KiB؛ التخطيط متوقف عند executionAllowed=false دائمًا.

البرمجة تستخدم افتراضيًا `openai/gpt-oss-120b` لإرجاع `{summary,edits:[{path,content}]}` ضمن enum لمسارات التعديل المصرح بها. expectedHash تثبته الخدمة من النسخة الملتقطة، ولا يولده النموذج. تحفظ model/usage في SQL فور وصول رد المزود، قبل تحليل المقترح وتطبيقه واختباره؛ فشل الخطوات اللاحقة لا يحول استخدامًا معروفًا إلى صفر أو NULL. لا إعادة تلقائية لطلب البرمجة المدفوع أو المجهول.

`CodingResult={kind:'coding',summary,projectId,baseCommit,branch,checkpoint:string|null,worktreeRetained:boolean,diff,diffHash,changes:[{path,beforeHash,afterHash}],baselineTests:SandboxTestResult|null,tests:SandboxTestResult,review:{passed:boolean,checks:[{id,passed,message}]},outcome:'ready_for_review'|'tests_failed'|'review_failed',model,usage:{inputTokens,outputTokens},sourceUnchanged:boolean,merged:false,verifiedAt}`. ready_for_review يتطلب الاختبارات والصياغة والمراجعة المستقلة وcheckpoint؛ يثبت فشل الاختبارات أو المراجعة حالة task=failed مع إبقاء النتيجة للمراجعة. لا يمثل وصول رد النموذج نجاح التعديل.

`SandboxTestResult={exitCode:number|null,stdout,stderr,timedOut,durationMs,provider,network:'denied',isolation:'appcontainer'|'microvm',isolationVerified:boolean,snapshotHash}`. المنفذ الآن Windows AppContainer فقط؛ microvm قيمة محفوظة لموفر مستقبلي. نسخة المصدر والاختبارات للقراءة فقط، وTEMP مستقل، ولا شبكة أو أسرار بيئة أو npm/shell. native helper يثبت token وJob قبل Resume؛ لا تكفي علامة ادعاء من كود المشروع. يطابق verifier المستقل الإيصال ببصمة الملفات، ويعيد قراءة manifest وHEAD والشجرة والفرق ونطاق التعديل والاختبارات وحالة المصدر. راجع `ISOLATION.md` لحدود النواة المشتركة وعدم وجود حصة قرص صلبة.

يحتفظ المحرك بالـ worktree والفرع وmanifest والـ checkpoint للمراجعة؛ لا يوجد endpoint merge/deploy/restore أو تنظيف أو استئناف تلقائي لها حاليًا. محاولة الكتابة فوق worktree موجودة تعيد RUN_ALREADY_EXISTS وتفشل بأثر محفوظ؛ يلزم فحصها ومهمة جديدة. لا يرفع المحرك branch ولا يغير ملفات المصدر الأصلية. سجل مسؤول التجميع تجربة حية: GPT-OSS 120B باستهلاك 620 input و98 output، واختبارات baseline exit=1 ثم النسخة المعدلة exit=0، مع checkpoint وsourceUnchanged=true وmerged=false؛ هذه نتيجة محددة وليست ضمان نجاح كل مشروع.

أخطاء التطبيق الحالية `{error:{code:string,message:string}}`؛ لا `requestId` ولا `apiVersion` عام على الأخطاء حاليًا. أخطاء Better Auth قد تكون `{code,message}` حسب المكتبة. الخطأ الداخلي 500 برسالة منقحة، والتطبيق يميز أيضًا 400/401/403/404/409/413/429/502/503. أخطاء فحص المزود قد تشمل `AUTHENTICATION_FAILED,PERMISSION_DENIED,MODEL_UNAVAILABLE,RATE_LIMITED,INCOMPLETE_RESPONSE,INVALID_RESPONSE,ABORTED`؛ فشل التخطيط المحفوظ يظهر برسالة مهمة منقحة وإيصال الاستخدام المتاح. لا ينبغي للعميل تحليل نص message لاتخاذ قرارات.

### عقود الاستوديو الثابت المنفذة

`StudioSessionSummary={id:UUID,name,sourcePath:string|null,revision:sha256,entryPath,createdAt,updatedAt,historyCount:number[0..20]}`. `StudioSession` يضيف `files` و`baseFiles`؛ كل ملف `{path,content}`. `StudioSnapshot={entryPath,files}`؛ حتى 40 ملف HTML/CSS، و64,000 بايت للملف و128,000 بايت للنسخة. الاستيراد يقرأ مجلدًا داخل `CODING_ALLOWED_ROOTS` ولا يحتاج Git أو اختبارات Node. لا يكتب إلى المشروع أو يشغل شيفرته. sourcePath=null للتجربة، ولا يوجد تعديل لمسار الاستيراد بعد إنشاء الجلسة.

`StudioPreview={revision,nonce,document,elements,warnings}`. كل `StudioElement={id,tag,file,line,text:string|null,styles:{color,backgroundColor,fontSize},editableText}`. ترجع styles هنا قيم inline النصية، لا computed styles للمتصفح. يستخرج المحرك file/line/elementId من HTML نفسه. `StudioEdit` يقبل text حتى4,000 حرف أو أحد `styles:{color?:HEX6,backgroundColor?:HEX6,fontSize?:integer[8..96]}`؛ لا مسار مصدر أو offset أو شيفرة حرة في الطلب. تعاد خريطة العنصر من نسخة الخادم ويقارن revision تحت قفل SQL قبل الحفظ؛ المراجعة المباشرة لا تستدعي نموذجًا أو مهمة عامل أو موافقة برمجة. الأصل ثابت وسجل التراجع آخر20 نسخة؛ يتغير revision عند undo حتى مع عودة المحتوى الأصلي.

مستند المعاينة يعاد بناؤه بقائمة عناصر وسمات مسموحة ويعرض في iframe opaque بـ`sandbox="allow-scripts"` دون same-origin؛ لا JavaScript مشروع أو شبكة أو تنقل أو cookies. CSP يقصر التنفيذ على جسر nonce الموثوق. الاستثناء المحدود في هذه الشريحة يقبل origin=`null` فقط عندما `event.source` هو الإطار المحدد، وتتطابق nonce/revision/schema ومعرف العنصر مع بيانات الخادم. `postMessage('*')` قناة التحديد المحدودة للأصل opaque، وليست سياسة API/CORS أو صلاحية حفظ؛ لا تحمل ملفات أو أسرارًا. راجع `PHASE-5.md` لحدود المحتوى والتوسع اللاحق.

## 2. قواعد العقود المقترحة — غير منفذة

المسارات التالية تحت `/api/v1` مقترحة لتوسعة المنصة؛ لا تستبدل المسارات الحالية قبل تنفيذ ترحيل واختبارات توافق. لا تعتبر أي صف تالٍ endpoint متاحًا الآن.

- الهوية: cookie للويب؛ رمز Bearer قصير مرتبط بجهاز موثوق للعملاء الأصليين عبر gateway مصادق. يمنع توزيع INTERNAL_API_SECRET على الأجهزة. تحدد الخدمة owner/workspace/device من الهوية، ولا تثق بقيم النموذج.
- نجاح مورد منفرد `{apiVersion:'1',data:T,requestId}`؛ القوائم `{apiVersion:'1',data:T[],page:{nextCursor:string|null},requestId}`؛ قبول عمل دائم 202 مع `{taskId,statusUrl}`؛ الإنشاء الفوري 201.
- خطأ `{apiVersion:'1',error:{code,message,retryable,details?},requestId}`؛ details حقول schema آمنة فقط. 400 إدخال، 401 جلسة، 403 سياسة، 404 ملكية، 409 إصدار/حالة/idempotency، 410 cursor منتهي، 413 حجم، 429 حصة، 503 تكامل غير متاح. لا stack أو tokens.
- كل جدول أدناه يبين scope. الرمز `A` يعني موافقة مرتبطة بالفعل وإصداره والمورد والمدخلات والتكلفة والانتهاء؛ `K` يعني Idempotency-Key مطلوب. الغياب `—` لا يمنح استقلالية إضافية؛ الطلب المباشر من المستخدم يظل تحت السياسة.
- كل كتابة ذات K تحفظ `(owner,route,key,inputHash,response/receipt)` في SQL قبل العمل. TTL مقترح 24 ساعة للطلبات، مع إيصالات آثار خارجية تحتفظ طوال عمر المورد؛ انقضاء TTL لا يجيز تكرار أثر غير محسوم.
- تعديلات المورد تتطلب `If-Match: revision`؛ اختلاف النسخة 409. cursor معتم وموقع ويرتبط بالمالك والفلاتر وsnapshot؛ limit افتراضي 50 وأقصاه 200، وترتيب ثابت `(createdAt,id)`.
- الصلاحيات والموافقات تفحص عند enqueue وقبل الأثر وعند استكمال خطوة حساسة؛ تغيير المدخلات يبطل التفويض. shadow لا ينفذ آثارًا حتى لو وجدت موافقة.

## 3. مساحات العمل والبرمجة والمعاينة — مقترحة

| الطريقة والمسار تحت `/api/v1` | Payload/query → Data | Scope | A/K |
|---|---|---|---|
| GET `/workspaces` | `cursor,limit` → Workspace[] | workspace:read | —/— |
| POST `/workspaces` | `{name,rootRegistrationId,resourceLimits}` → Workspace{id,revision} | workspace:create | —/K |
| POST `/workspaces/:id/projects` | `{name,repositoryConnectionId,repositoryRef}` → Project | code:read | —/K |
| GET `/projects/:id/tree` | `ref,cursor` → `{fileId,path,hash,size,kind}[]` | code:read | —/— |
| GET `/projects/:id/files/:fileId` | `ref,expectedHash?` → `{content,encoding,hash,revision}` بحد حجم | code:read | —/— |
| POST `/coding/runs` | `{projectId,baseRef,goal,successCriteria[],autonomy,budget}` → taskId/runId | code:read/write/run | A حسب policy/K |
| GET `/coding/runs/:id/diff` | `baseCheckpoint,targetCheckpoint` → `{artifactId,sha256,stats,verificationIds[]}` | code:read | —/— |
| POST `/coding/runs/:id/checkpoints` | `{expectedRevision,label}` → Checkpoint | code:write | —/K |
| POST `/coding/runs/:id/restore` | `{checkpointId,expectedRevision}` → taskId | code:write | A/K |
| POST `/coding/runs/:id/deliver` | `{diffHash,verificationIds,delivery:'pull_request'\|'merge'\|'deploy',target}` → taskId | code:publish | A/K |
| POST `/previews` | `{runId,checkpointId,ttlSeconds}` → `{previewId,origin,expiresAt}` | preview:create | —/K |
| POST `/previews/:id/selections` | `{frameNonce,elementPath,sourceHint?,screenshotArtifactId?}` → `{selectionId,sourceMapping,confidence}` | code:read | —/K |
| POST `/previews/:id/changes` | `{selectionId,instruction,expectedFileHashes,baselineArtifactId}` → taskId | code:write/run | A حسب policy/K |

rootRegistrationId مورد جرى تسجيله مسبقًا ضمن حدود مسموحة، وليس مسار ملفات حرًا. لا تقبل fileId أو sourceHint مسارًا خارج المشروع أو symlink يتجاوز حدوده. run ينشئ worktree وعزلًا منفصلًا وقفل موارد؛ لا يأخذ صلاحيات Control Plane. المعاينة على أصل منفصل وnonce/schema لكل postMessage؛ اختلاف source mapping يعرض عدم اليقين بدل تعديل ملف مخمن.

## 4. المتصفح والبحث — مقترحة

| الطريقة والمسار | Payload/query → Data | Scope | A/K |
|---|---|---|---|
| POST `/browser/sessions` | `{workspaceId,allowedOrigins[],ttlSeconds}` → `{sessionId,expiresAt}` | browser:read | —/K |
| POST `/browser/sessions/:id/actions` | `{action:'navigate'\|'read'\|'click'\|'fill'\|'submit',target,expectedObservationId,input?}` → taskId/actionId | browser:read أو browser:submit | A للآثار/K |
| GET `/browser/sessions/:id/observations` | `afterSequence,limit` → Observation[] منقحة | browser:read | —/— |
| POST `/browser/sessions/:id/close` | `{reason}` → `{closed:true}` | browser:read | —/K |
| POST `/research/runs` | `{question,allowedDomains?,sourceBudget,maxDepth,acceptanceCriteria[]}` → taskId | research:run | —/K |
| GET `/research/runs/:id/report` | — → `{claims[],citations[],conflicts[],coverage,evidenceIds[]}` | research:read | —/— |

target يعتمد locator/observation موجودة داخل الجلسة؛ يعاد التحقق قبل الفعل وبعده. منع SSRF يشمل DNS وإعادة التوجيه وعناوين الشبكة الداخلية. النصوص المجلوبة بيانات غير موثوقة ولا تنشئ grants. submit/send/purchase يحتاج action digest وموافقة مستقلة، وليس سماحًا عامًا للنقر.

## 5. الذاكرة والمهارات والتغذية الراجعة — مقترحة

| الطريقة والمسار | Payload/query → Data | Scope | A/K |
|---|---|---|---|
| POST `/memory/search` | `{query,layers[],asOf,limit,taskId}` → `{items[],citations[],expiredExcluded}` | memory:read | —/— |
| POST `/memory/candidates` | `{layer,contentArtifactId,evidenceIds[],expiresAt,taskId}` → Candidate | memory:write | —/K |
| POST `/memory/candidates/:id/promote` | `{expectedRevision,verificationId,targetLayer}` → Memory | memory:promote | A/K |
| POST `/memory/:id/revoke` | `{reason,expectedRevision}` → `{revoked:true}` | memory:write | —/K |
| POST `/skills/candidates` | `{manifestArtifactId,sourceEvidenceIds[],version}` → SkillVersion | skill:create | —/K |
| POST `/skills/:id/evaluations` | `{version,sandboxProfile,benchmarkSetId,holdoutSetId}` → taskId | skill:test | —/K |
| POST `/skills/:id/activate` | `{version,evaluationId,expectedRevision}` → SkillVersion | skill:activate | A/K |
| POST `/skills/:id/revoke` | `{version,reason}` → `{revoked:true}` | skill:revoke | —/K |
| POST `/feedback` | `{taskId,targetId,kind:'preference'\|'task_correction'\|'benchmark_evidence',rating?,comment,evidenceIds[]}` → Feedback | feedback:write | —/K |

القراءة تستبعد المنتهي أو الملغى وتعيد provenance. feedback لا تتحول تلقائيًا إلى حقيقة أو قاعدة دائمة؛ تفضيل مستمر يحتاج تصنيفًا وموافقة المستخدم قبل تفعيله خارج المهمة. skill version غير قابلة للاستبدال؛ activation يتطلب اختبارًا مستقلًا وholdout ناجحًا وعدم تراجع المعايير.

## 6. الأجهزة والربط والتحكم وiPhone — مقترحة

| الطريقة والمسار | Payload/query → Data | Scope | A/K |
|---|---|---|---|
| POST `/mobile/authorization` | `{redirectUri,codeChallenge,codeChallengeMethod:'S256',state}` → authorizationUrl | login موثوق | —/K |
| POST `/mobile/token` | `{code,codeVerifier,redirectUri,devicePublicKey}` → رموز قصيرة مرتبطة بالجهاز | authorization_code | —/K |
| POST `/pairing/challenges` | `{deviceName,platform,devicePublicKey}` → `{challengeId,displayCode,expiresAt}` | pairing:init محدود المعدل | —/K |
| POST `/pairing/challenges/:id/approve` | `{displayCode,publicKeyFingerprint,scopes[],expiresAt}` → PairingDecision | device:pair من جلسة مالك | A/K |
| POST `/pairing/challenges/:id/complete` | `{challengeSignature}` → `{deviceId,credential,expiresAt}` مرة واحدة | إثبات المفتاح + approved challenge | —/K |
| GET `/devices` | `cursor` → Device[] دون مفاتيح خاصة | device:read | —/— |
| POST `/devices/:id/revoke` | `{reason,expectedRevision}` → `{revoked:true,closedSessionIds[]}` | device:revoke | —/K |
| POST `/devices/:id/remote-policy` | `{enabled,allowedModes:['view'\|'control'],expiresAt,expectedRevision}` → Policy | device:control | A للتمكين/K |
| POST `/remote/sessions` | `{deviceId,mode,ttlSeconds}` → `{sessionId,signalingUrl,shortToken,expiresAt}` | device:view/control | A للتحكم/K |
| POST `/remote/sessions/:id/input` | `{sequence,observationId,kind,coordinates?,key?,text?,expiresAt}` → `{accepted,receiptId}` | device:control | ضمن grant المحدد/K |
| POST `/remote/sessions/:id/close` | `{reason}` → `{closed:true}` | device:view | —/K |
| POST `/mobile/push-registrations` | `{deviceId,apnsToken,environment}` → Registration دون إعادة token | notification:register | —/K |

التفاصيل النهائية لتدفق mobile authorization تتبع موفر الهوية المختار؛ لا يستخدم بريد/كلمة مرور مخزنين في iPhone. credentials في Keychain ومفتاح الجهاز محلي. pairing code قصير العمر لا يكفي دون إثبات المفتاح وموافقة مالك. لا تعيد complete credential ثانية؛ إعادة المحاولة تسترجع نتيجة آمنة أو تتطلب تدويرًا.

إدخال remote مرتبط بجلسة وملاحظة شاشة حديثة وتسلسل متزايد؛ تكرار sequence يعيد إيصالًا ولا يكرر النقر. الأحداث المنتهية/المكررة/المخالفة للنطاق ترفض قبل حقنها. تعطيل remote يمنع أوامر جديدة ويغلق الجلسات ويطلب إيقاف الجاري؛ لا يلغي مهام السحابة. APNs يحمل معرفًا آمنًا فقط؛ التطبيق يجلب التفاصيل بعد المصادقة، ولا يرسل موافقات offline تلقائيًا.

## 7. Google Ads والتكاملات والاستخدام — مقترحة

| الطريقة والمسار | Payload/query → Data | Scope | A/K |
|---|---|---|---|
| POST `/integrations/google-ads/authorize` | `{redirectUri,state,customerId?,managerId?}` → authorizationUrl | integration:connect | A/K |
| GET `/integrations/google-ads/callback` | `code,state` → نتيجة ربط ثم تحويل آمن | OAuth callback مطابق | موافقة الربط السابقة/أحادي الاستخدام |
| POST `/ads/ingestions` | `{accountId,dateRange,backfill:false\|true}` → taskId + watermark | ads:read | —/K |
| GET `/ads/accounts/:id/performance` | `dateRange,dimensions,cursor` → Metrics[] + attributionVersion | ads:read | —/— |
| POST `/ads/conversions` | `{accountId,conversionAction,externalBookingIdHash,attributionRef,occurredAt,valueMicros,currency,consent}` → Receipt | ads:conversion:write | A حسب policy/K |
| POST `/ads/audits` | `{accountId,dateRange,trackingValidationId}` → taskId | ads:read | —/K |
| POST `/ads/proposals` | `{accountId,goal,maxSpendMicros,conversionQualityId,mode:'shadow'}` → Proposal{changeSetHash} | ads:draft | —/K |
| POST `/ads/proposals/:id/apply` | `{changeSetHash,expectedRemoteRevision,approvalId}` → taskId + mutation receipt | ads:activate/budget/pause بحسب التغيير | A منفصلة لكل نوع/K |
| POST `/integrations/:id/credentials` | `{secretValue,credentialType,expiresAt?}` → `{credentialRef,version}` فقط | credential:write | A/K |
| POST `/integrations/:id/revoke` | `{reason}` → Revocation | integration:revoke | —/K |
| GET `/usage` | `workspaceId,taskId?,period,cursor` → Usage[] + priced/unpriced totals | usage:read | —/— |
| POST `/budgets` | `{workspaceId,currency,limitMicros,tokenLimit,period,expectedRevision}` → Budget | budget:write | A للزيادة/K |

money micros أعداد صحيحة عشرية كسلاسل لتجنب فقد الدقة؛ تحفظ عملة الحساب ومنطقته الزمنية. ingestion يثبت watermark بعد الصفحة الناجحة، ويربط conversion بمفتاح dedup وconsent؛ attributionRef يشير إلى بيانات إسناد مفوضة يفحصها موائم إصدار Google Ads الرسمي قبل الرفع، ولا توضع بيانات حجز أو معرفات تتبع شخصية في الأحداث. جودة التحويل شرط لتحسين الميزانية؛ draft لا يفعّل حملة. أثر Google غير المحسوم يفحص بإيصال/حالة المورد قبل أي retry. secretValue يذهب إلى KMS ولا يوجد GET يعيده. حجز التكلفة ذري قبل طلب النموذج؛ السعر يحمل rate-card version أو يبقى unpriced دون تقدير مختلق.

## 8. الأحداث والإلغاء والاستئناف — مقترحة

GET `/api/v1/tasks?cursor&status&limit` للقائمة؛ GET `/tasks/:id/events?afterSequence&limit` لإعادة العرض؛ POST `/tasks/:id/cancel` مع `{reason}` لإلغاء متكرر آمن؛ POST `/tasks/:id/pause|resume` مع `{expectedRevision}` يتطلب `task:control` وK. resume لا يعيد تفويضًا منتهيًا، ولا يعيد أثرًا خارجيًا مجهولًا.

POST `/api/v1/realtime/tickets` مع `{topics,lastSequences}` يحتاج جلسة و`event:read` ويعيد ticket أحادية الاستخدام لعمر 30 ثانية؛ WSS `/api/v1/realtime?ticket=...` لا يقبل سر الخدمة. تسمح topics بموارد مملوكة فقط، ويعاد التفويض عند انتهاء/إلغاء الجلسة؛ ticket لا يسجل في logs.

إطار الحدث `{apiVersion:'1',eventId,topic,aggregateId,sequence,type,occurredAt,requestId,taskId?,data}`. SQL هو المصدر، والنقل at-least-once؛ dedup عبر eventId وترتيب عبر sequence لكل aggregate. يرسل العميل ack لآخر sequence، ويطلب REST عند gap. cursor/replay خارج نافذة الاحتفاظ يعيد 410 `REPLAY_EXPIRED` مع طلب snapshot جديد، ولا يخمن أحداثًا مفقودة.

الإلغاء يسجل cancellation_requested قبل منع claims الجديدة. queued يمكن أن يصبح cancelled فورًا؛ الجاري يحتاج إيصال توقف أو reconciliation، ولا يعلن cancelled بمعنى تراجع أثر قد وقع. outbox ينشر الحدث بعد معاملة الحالة؛ Execution Replay قراءة أدلة منقحة، وليس إعادة تشغيل أدوات لها آثار. حذف مورد أو إلغاء جلسة يقطع subscriptions فورًا.

## 9. بروتوكول أدوات وأدلة مقترح — غير منفذ

المثال التالي عقد مستهدف، وليس types مصدرة حاليًا. schemas تستخدم JSON Schema 2020-12، ويطابق executor capability/version المسجلين. سياسات التفويض مستقلة عن النص المرسل للنموذج.

```ts
type ToolCapability = {
  id: string; version: string; inputSchema: object; outputSchema: object;
  requiredScopes: string[]; risk: 'low' | 'medium' | 'high';
  effects: 'none' | 'local_write' | 'external'; replaySafe: boolean;
  limits: { timeoutMs: number; maxOutputBytes: number; concurrency: number };
  health: 'healthy' | 'degraded' | 'unavailable'; verifierId: string;
};
type ToolCall = {
  callId: string; taskId: string; stepId: string; attempt: number;
  capabilityId: string; capabilityVersion: string; input: unknown;
  inputHash: string; idempotencyKey: string; leaseToken: string;
  authorizationRef: string; deadline: string; // لا أسرار ولا grants يختلقها النموذج
};
type Evidence = {
  id: string; taskId: string; stepId: string; ownerId: string;
  kind: 'test' | 'observation' | 'source' | 'receipt';
  source: { toolId: string; version: string; resourceId: string };
  observedAt: string; expiresAt?: string;
  artifact?: { id: string; sha256: string; mediaType: string; bytes: number };
  claim: string; redaction: 'none' | 'applied';
  verification: { status: 'pending' | 'passed' | 'failed'; verifierId?: string; checkedAt?: string };
};
type ToolOutcome =
  | { status: 'succeeded'; output: unknown; evidenceIds: string[]; receiptId?: string }
  | { status: 'failed'; code: string; retryable: boolean; effect: 'none' | 'confirmed' | 'unknown' };
```

authorizationRef يحل داخل Control Plane إلى تفويض owner/device/task/resource/inputHash/expiry/revocation؛ لا يثق executor بمجرد وجود المرجع. leaseToken داخلي لا يرجع للواجهة. يحجز المنفذ الإيصال قبل الأثر، ويمنع fencing العامل القديم من اعتماد الحالة. verifier يقرأ الأدلة ويتحقق من schema والمعايير والمصدر والعمر؛ ثقة النموذج ليست قيمة verification. artifact يحمّل من رابط قصير مفوض بالمالك، ولا يخزن سرًا في claim أو اسم الملف.

## 10. قبول كل عقد جديد قبل تفعيله

يلزم schema للطلب والرد، وscope وسياسة موافقة، وفحص ملكية، وحدود حجم/زمن/تكلفة، واختبار duplicate/conflict/cancel/revoke/restart، وفشل verifier، وحالات loading/empty/error/offline/permission-denied في العميل. عقود الأجهزة تختبر انتهاء المفتاح والربط وإعادة التشغيل؛ Ads تختبر dedup والحد المالي وإيصال الأثر. لا ينتقل status القدرة إلى active قبل تحقق هذه الشروط وتوثيق الاختبارات الفعلية في سجل التنفيذ.

## ملحق منفذ: عقود معاينة React

`StudioSession` وملخصه يضيفان `framework:static|react|next`، والقيمة الافتراضية للصفوف القديمة static. `StudioSnapshot.framework` اختياري للتوافق مع النسخ الثابتة القديمة. عند غياب entryPath يختار الخادم index.html أو src/App.tsx أو app/page.tsx بحسب النوع.

`StudioPreview.verification` اختياري، وحاضر لمعاينة React المحفوظة: `{provider,sourceHash,snapshotHash,network:'denied',isolation:'appcontainer',isolationVerified:true,durationMs}`. sourceHash بصمة ملفات المصدر وframework، وsnapshotHash بصمة الحزمة والمشغّل الموثوق اللذين دخلا العزل. GET preview/baseline لا يشغّل كودًا. `StudioElement.editableStyles` الاختياري يوقف تعديل تنسيق غير قابل للربط بأمان؛ editableText يتطلب نصًا مباشرًا مطابقًا للناتج.

POST edits لمشروع React يشتق الربط من الأثر الجاري، ويطبق رقعة JSX/TSX، ويجمع ويعرض خارج معاملة SQL، ثم يقفل الصف ويعيد مقارنة revision ويحفظ المصدر والأثر ذريًا. فشل العرض422 أو غياب العزل503 لا يمسان المصدر الجاري. التراجع يستعيد مصدرًا وأثرًا محفوظين دون تنفيذ. تبقى ملكية الجلسة وOrigin والعقد الصارم مطلوبة لكل طلب.


## تحديث العقود المنفذة للمراحل5–8

- `studio.change` يستخدم POST `/api/tasks` مع `studioInput:{sessionId,revision,elementId?,imageId?}`. كلا assisted وscoped يحتاج موافقة؛ shadow لا ينقل المصدر أو الصورة. إكمال المهمة يعني مقترحًا متحققًا؛ التطبيق POST منفصل على `/api/studio/proposals/:id/apply` عند تطابق revision. الصور والنتائج مملوكة وغير عامة.
- Next الحي: GET/POST `/api/studio/sessions/:id/live` وPOST `/:id/live/stop`. التشغيل يعيد202 وحالة بناء محفوظة؛ الحالة غير المجهزة لا تنفذ حسابًا سحابيًا. المعاينة على منفذ loopback مستقل باسم capability عشوائي، دون Cookie المالك أو اعتماديات الجسر.
- عقود جلسات القراءة والموافقة على النماذج والأبحاث الخلفية في [PHASE-6](PHASE-6.md)، وعقود مصادر الذاكرة وإصداراتها والتغذية الراجعة والمهارات في [PHASE-7](PHASE-7.md)، وعقود ربط الجهاز وإذن المشاهدة/الإدخال والصورة والأوامر في [PHASE-8](PHASE-8.md).
- يظل التخطيط مقترحًا؛ الذاكرة والمهارات لا تمنح صلاحيات إضافية. لا تنفذ أفعال جهاز أو متصفح بمجرد ورودها في نص نموذج.
