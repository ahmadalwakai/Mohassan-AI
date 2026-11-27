// Primary sources retrieved from the production checkout on 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/tree/29448aea3fa10d226ef82ec5bf0a65e723d6ec39
const productionSource = 'https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/';
const wave6 = 'docs/DEPLOY-WAVE-6-2026-11-25.md';
const wave2 = 'docs/INTEGRATION-WAVE-2-2026-11-25.md';
const wave4 = 'docs/INTEGRATION-WAVE-4-2026-11-25.md';
const wave5 = 'docs/INTEGRATION-WAVE-5-2026-11-25.md';
const monitorGuide = 'docs/MONITORS.md';
const monitorTrial = `${monitorGuide}#feature-flags-and-proposed-owner-trial`;
const monitorContextReport = 'docs/MONITOR-CONTEXT-VERIFICATION.md#measurement';
const councilGuide = 'docs/MODEL-COUNCIL.md';
const v5Guide = 'docs/V5-OWNER-CHAT-2026-11-26.md';
const arbiterReport = 'docs/ARBITER-BRAIN-VERIFICATION.md';
const responsePolicy = 'docs/RESPONSE-POLICY.md';
const backgroundResults = 'docs/BACKGROUND-RESULTS.md';

interface Preflight {
  path: string;
  args: readonly string[];
}

interface Measurement {
  path: string;
  summary: string;
}

export interface ActivationEvidence {
  ownerTrial: string | null;
  dependencies: readonly string[];
  preflight: Preflight | null;
  evidence: Measurement | null;
  risk: string;
  sources: readonly string[];
}

type EvidenceNote = Partial<Omit<ActivationEvidence, 'risk'>> & Pick<ActivationEvidence, 'risk'>;

const cutover = { path: 'scripts/cloud-linux/preflight-wave-6.mjs', args: [] };
const ownerTrial = { ...cutover, args: ['--owner-trial'] };
const ownerV5 = { ...cutover, args: ['--owner-v5'] };
const measured = (path: string, summary: string): Measurement => ({ path, summary });

const v5Measurement = measured(v5Guide, 'أخفقت البوابة الثالثة. انتهى التوليد بصورة طبيعية في 49 من 60 حالة عربية و47 من 60 حالة إنجليزية. تجربة المالك استثناء موثّق.');
const councilMeasurement = measured(`${councilGuide}#measurement`, 'صحّ الردّ المنشور في 10 من 12 سؤالاً دون تغيير أي جواب. قيس الزمن على جهاز التطوير وبقي زمن خادم الإنتاج مجهولاً.');
const monitorRolloutMeasurement = measured(`${monitorGuide}#held-out-results`, 'في الإعادة المستقلة ارتفع استرجاع التنبيهات أحادية الإطلاق من 73.6٪ إلى 93.8٪.');
const metricsMeasurement = measured(`${monitorGuide}#phase-2-offline-verification`, 'مرّت مجموعة الاختبارات المركزة التي شملت مقاييس تشغيل المراقبات. نتائج أسبوع المالك غير منشورة هنا.');
const monitorPhaseTwo = `${monitorGuide}#phase-2-held-out-simulation`;
const deployRehearsal = measured(`${wave6}#database-migration-plan`, 'نجحت بروفة الترحيل وبدء الخادم على PostgreSQL 18.7 مع إيقاف عامل الطابور، وحافظت إعادة التشغيل على السجل.');
const arbiterMeasurement = measured(`${arbiterReport}#training-and-promotion-gate`, 'طابق الظل نتائج 2640 حالة. لم تتوفر صفوف صالحة للتدريب أو المعايرة وبقيت الترقية مغلقة.');
const judgeMeasurement = measured('docs/HANDOVER-2026-11-22-JUDGE-SHADOW.md', 'يتضمن سجل الاختبار الردود المجمّدة، وتجربة المالك، وحادثتي إصلاح متابعة وحجب جواب خاطئ.');
const v5Dependencies = ['MOHASSAN_MODEL_WORKER', 'MOHASSAN_MODEL_WORKER_CONFIG', 'EXECUTOR_PYTHON'];
const monitorDependencies = ['MOHASSAN_MONITORS_ENABLED', 'MOHASSAN_MONITORS_V2'];
const configSource = 'apps/server/src/config.ts';
const executorSource = 'apps/server/src/executor.ts';
const skillsSource = 'apps/server/src/skill-remote.ts';
const adsSource = 'docs/GOOGLE-ADS.md#خطوات-المالك-للربط-الحي';
const adsCredential: EvidenceNote = {
  sources: [configSource, adsSource],
  risk: 'القيمة المفقودة أو غير المطابقة قد تعطل ربط حساب Google Ads أو الوصول إلى بياناته.',
};
const ownerSetup: EvidenceNote = {
  dependencies: ['DATABASE_URL', 'BETTER_AUTH_SECRET'],
  risk: 'يستخدمها أمر إنشاء المالك الأول. القيم غير الصالحة تمنع إنشاء الحساب.',
  sources: ['apps/server/src/create-owner.ts'],
};
const childEnvironment: EvidenceNote = {
  risk: 'قد يؤثر التغيير على العثور على برامج النظام أو تشغيل العمليات التابعة المحلية.',
  sources: ['apps/server/src/ads-lab.ts', 'packages/coding/src/git.ts'],
};
const temporaryDirectory: EvidenceNote = {
  risk: 'القيمة التي تشير إلى مكان غير قابل للكتابة قد تمنع العمليات التابعة من إنشاء ملفاتها المؤقتة.',
  sources: ['apps/server/src/ads-lab.ts', 'apps/server/src/skill-benchmark-runner.ts'],
};

function cutoverOff(risk: string, evidence?: Measurement, dependencies?: readonly string[]): EvidenceNote {
  return { ownerTrial: '0', preflight: cutover, risk, evidence, dependencies, sources: [`${wave6}#environment-changes`] };
}

function monitorNote(ownerTrial: string, risk: string, evidence: Measurement | null, dependencies = monitorDependencies): EvidenceNote {
  return { ownerTrial, risk, evidence, dependencies, sources: [monitorTrial, 'apps/server/src/monitors/flag.ts'] };
}

const v5Profile = { preflight: ownerV5, evidence: v5Measurement, sources: [`${v5Guide}#server-setup`] };
const externalProvider = {
  risk: 'يبقي إعداد الخادم مزوّدي الذكاء الاصطناعي الخارجيين معطّلين. تغيير هذه القيمة وحدها لا يفعّلهم.',
  sources: ['apps/server/src/config.ts', 'apps/server/src/inference.ts'],
};
const pushMeasurement = measured(`${backgroundResults}#verification`, 'مرّت اختبارات تسليم بإعدادات محاكاة للمتصفح وAPNs. يلزم اختبار التسليم على الجهاز الفعلي.');
const pushNote: EvidenceNote = {
  preflight: cutover, evidence: pushMeasurement,
  risk: 'القيمة الناقصة أو بيانات التوقيع غير المتطابقة توقف تنبيه الدفع الخاص بهذه القناة. يبقى التنبيه داخل المحادثة متاحاً.',
  sources: [`${wave6}#environment-changes`],
};
const webPush = ['WEB_PUSH_VAPID_SUBJECT', 'WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY'];
const apns = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_PATH', 'APNS_BUNDLE_ID'];

const notes: Readonly<Record<string, EvidenceNote>> = {
  MOHASSAN_MONITORS_ENABLED: {
    ownerTrial: 'owner', preflight: ownerTrial, evidence: monitorRolloutMeasurement,
    risk: 'إيقافه يوقف الاكتشاف والموافقات الجديدة والفحوص المجدولة. القيمة 1 توسّع الوصول إلى جميع الحسابات النشطة.',
    sources: [`${wave6}#turn-on-owner-monitors`, monitorTrial],
  },
  MOHASSAN_MONITORS_V2: {
    ...monitorNote('1', 'إيقافه يعطّل جدولة المراقبات الجديدة من الإصدار الثاني ويخفيها من واجهة الإصدار الأول حتى انتهاء صلاحيتها.', monitorRolloutMeasurement),
    dependencies: ['MOHASSAN_MONITORS_ENABLED'],
  },
  MOHASSAN_MONITORS_GITHUB: monitorNote('1', 'حدود GitHub المشتركة قد تؤجّل الفحوص. إيقافه يعلّق فحوص GitHub وموافقاته الجديدة.',
    measured(monitorPhaseTwo, 'بلغ الاسترجاع 100٪ لكل من حالات طلبات الدمج وCI والإصدارات في المحاكاة المحجوزة.')),
  MOHASSAN_MONITORS_PDF: monitorNote('1', 'تغيّر النص المستخرج من PDF أو تعذّر قراءته قد يوقف تحقق الشرط. إيقافه يعلّق فحوص PDF.',
    measured(monitorPhaseTwo, 'كُشف عن 49 من أصل 49 مراجعة مؤهلة لملفات PDF في المحاكاة المحجوزة.')),
  MOHASSAN_MONITORS_VISUAL: monitorNote('0', 'قد تفوت تنبيهات الصور أو اللوحات، ويضيف عرض الصفحات تكلفة حتى ضمن الميزانية المستقلة.',
    measured(monitorPhaseTwo, 'كُشفت 37 من 49 حالة، بنسبة 75.5٪ دون الحد المطلوب البالغ 90٪.')),
  MOHASSAN_MONITOR_CONTEXT: monitorNote('1', 'يغيّر توقيت اقتراح المراقبة وكيفية اختيارها بدلاً من طلب توضيح أو تذكير.',
    measured(monitorContextReport, 'لم يقترح مسار السياق مراقبة في 10149 عبارة بشرية خارج النطاق. زمنه الدافئ عند المئين 95 بلغ 0.608 مللي ثانية.')),
  MOHASSAN_MONITOR_CONTEXT_SHADOW: monitorNote('1', 'يتوقف الرصد عند إيقاف علاقات النماذج. رصد النموذج يحتاج ملف أوزان محلياً معتمداً.',
    measured(monitorContextReport, 'قيس تشغيل مسار التسجيل والتقييم بملف اختبار. بقيت المعايرة الميدانية والترقية غير متحقق منهما.'),
    [...monitorDependencies, 'MOHASSAN_MODEL_RELATIONS']),
  MOHASSAN_ARBITER_MONITOR_CONTEXT: monitorNote('0', 'يبقى القرار الحتمي هو المعتمد حتى تتوفر ترقية مستقلة وإذن التطبيق. قد يؤدي ترجيح خاطئ إلى ضياع اقتراح مفيد.',
    measured(monitorContextReport, 'بقيت ترقية محكّم سياق المراقبات غير متحقق منها.'),
    [...monitorDependencies, 'MOHASSAN_MONITOR_CONTEXT_SHADOW', 'MOHASSAN_MODEL_RELATIONS', 'MOHASSAN_ARBITER_MONITOR_CONTEXT_KILL']),
  MOHASSAN_ARBITER_MONITOR_CONTEXT_KILL: monitorNote('0', 'إبقاؤه على 1 يلغي سلطة المحكّم حتى بعد ترقية سياق المراقبات.',
    measured(monitorContextReport, 'بقيت ترقية محكّم سياق المراقبات غير متحقق منها.'), ['MOHASSAN_ARBITER_MONITOR_CONTEXT']),
  MOHASSAN_V5_CHAT: { ...v5Profile, ownerTrial: 'owner', dependencies: v5Dependencies,
    risk: 'قد يولّد أجوبة خاطئة أو متكررة. يتراجع إلى الرد السابق عند غياب العامل ويمنع مشاركة محادثة تضم رداً تجريبياً.' },
  MOHASSAN_MODEL_WORKER: { ...v5Profile, ownerTrial: '1', dependencies: v5Dependencies.slice(1),
    risk: 'فشل تحميل النموذج أو تعثر العامل يوقف الرد التجريبي. عمله يحجز موارد المعالج والذاكرة وقد يحدّ من تشغيل نماذج ثقيلة أخرى.' },
  MOHASSAN_MODEL_WORKER_CONFIG: { ...v5Profile, ownerTrial: '/opt/mohassan/models/v5/model-worker.json', dependencies: ['MOHASSAN_MODEL_WORKER'],
    risk: 'ملف إعداد غير صالح أو أوزان مختلفة عن البصمات المثبّتة تمنع عامل v5 من العمل.' },
  EXECUTOR_PYTHON: { ...v5Profile, preflight: null, ownerTrial: '/opt/mohassan/venv-execution/bin/python',
    risk: 'مفسّر غير صالح أو بيئة بلا التبعيات المحلية تعطل العامل. وصفة v5 تحدد هذا المسار ويُتحقق من جاهزية العامل بعد الإقلاع.' },
  MOHASSAN_MODEL_COUNCIL: { ownerTrial: 'owner', evidence: councilMeasurement,
    risk: 'قد يزيد زمن جواب المالك بسبب تحميل النماذج والبحث. يستطيع المجلس استخدام نماذج النسخة المثبتة، ويشارك v5 إذا كان جاهزاً. القياس المنشور لم يسجل تحسناً في الدقة.',
    sources: [`${councilGuide}#switches-and-rollback`] },
  MOHASSAN_MODELS_ROOT: { ownerTrial: '/var/lib/mohassan/models', evidence: councilMeasurement,
    risk: 'المسار الخاطئ يفقد النماذج غير الموجودة في نسخة التطبيق ويقلل مشاركة النماذج في المجلس وصفحة النماذج.',
    sources: [`${councilGuide}#runtime-and-model-store`, `${councilGuide}#switches-and-rollback`] },
  MOHASSAN_MODEL_RELATIONS: { ownerTrial: 'off', preflight: cutover,
    evidence: measured('docs/MODEL-RELATIONS-VERIFICATION.md#exact-shadow-parity', 'تطابقت أحكام المقارنة في الظل على قسمي التطوير. تجربة سياق المراقبات تقترح shadow بصورة منفصلة.'),
    risk: 'إيقافه يوقف رصد علاقات النماذج والتحكيم التابع له. تشغيله يضيف عملاً في الخلفية.',
    sources: [`${wave6}#environment-changes`, monitorTrial] },
  PRODUCTION_METRICS_ENABLED: { ownerTrial: 'true', preflight: ownerTrial, evidence: metricsMeasurement, dependencies: ['PRODUCTION_METRICS_DIR'],
    risk: 'إيقاف الجمع يزيل قياسات التجربة الجديدة. مسار غير قابل للكتابة قد يفقد تاريخ القياسات بعد إعادة التشغيل.',
    sources: [`${wave6}#turn-on-owner-monitors`, 'docs/PRODUCTION-METRICS-2026-11-25.md'] },
  PRODUCTION_METRICS_DIR: { ownerTrial: '/var/lib/mohassan/production-metrics', preflight: ownerTrial, evidence: metricsMeasurement, dependencies: ['PRODUCTION_METRICS_ENABLED'],
    risk: 'مسار غير قابل للكتابة يمنع حفظ اللقطات. تغيير المجلد يغيّر تاريخ اللقطات الذي يمكن تحميله.',
    sources: ['docs/PRODUCTION-METRICS-2026-11-25.md', `${wave6}#turn-on-owner-monitors`] },
  RUN_WORKER: { ownerTrial: 'true', preflight: cutover, evidence: deployRehearsal,
    risk: 'إيقافه يوقف استهلاك أعمال الطابور. دليل Linux يعيد تشغيله بعد فحص الصحة، ودليل الموجة السادسة يطلب إعادة القيمة السابقة. فحص الإقلاع يتطلب false.',
    sources: [`${wave6}#deploy-and-verify`, 'scripts/cloud-linux/README.md#cutover-and-verification'] },
  MOHASSAN_REASONING: cutoverOff('يغيّر مسار المقارنة والحساب. التاريخ الهجري تقريبي، وسعر الصرف يعتمد على تاريخ الملف المحلي.',
    measured(`${wave2}#v1-development`, 'ارتفع الحساب من 11 إلى 18 من 18 مع مرشح الحساب، ثم ارتفعت المقارنة من 1 إلى 11 من 18 مع مرشح المقارنة.')),
  MOHASSAN_PLAN_COMPILER: { ...cutoverOff('وضع on يرسل الطلبات المركّبة إلى تنفيذ خطوات متعددة. خطأ التصنيف قد يستبدل المسار المباشر أو يترك خطة غير مكتملة.',
    measured(`${wave2}#v1-development`, 'رفع مُصرّف الخطط المصحّح نجاح أعمال v1 متعددة الخطوات من 1 إلى 18 من 18.')), ownerTrial: 'off' },
  MOHASSAN_STRUCTURED_MEMORY: cutoverOff('يتغيّر تفسير الحفظ والتصحيح والاسترجاع. يحتاج السجل المنظم إلى ترحيلات الذاكرة وقد يختلف عن الذاكرة القديمة.',
    measured('docs/RELEASE-CANDIDATE-2026-11-25.md', 'سجّل المرشح نجاح 164 اختباراً للذاكرة المنظمة والتذكير و10 اختبارات لتصدير بيانات الأعضاء وحذفها.')),
  MOHASSAN_CONVERSATION_SHADOW: cutoverOff('وضع decide يغيّر تصنيف الطلب وتصحيح مرجعه. الخطأ قد يوجّه المتابعة إلى موضوع أو كيان آخر.',
    measured('docs/CONVERSATION-STATE-DECISION-EVALUATION.md#results', 'بلغ تصنيف نوع الدور 774 من 1141 في الحالات المحجوزة مقابل 687 من 1141 للمسار السابق.')),
  MOHASSAN_CONVERSATION_REVIEW_APPLY: cutoverOff('يتيح إصلاح نص الرد قبل إرساله. قد تجعل معالجة ملاحظة غير دقيقة الرد أقل وضوحاً.',
    measured(`${wave4}#development-decisions`, 'المراجعة جزء من ملف تشغيل الموجة الرابعة. هذا قياس مجمّع للمرشح.'), ['MOHASSAN_JUDGE_SHADOW']),
  MOHASSAN_SMALL_TALK_MANNERS: cutoverOff('قد يصنّف طلباً عملياً على أنه كلام عابر ويجيب دون تنفيذ المطلوب.',
    measured(`${wave4}#candidate-readiness`, 'نتيجة مرشح الحديث العابر والرفض بلغت 1515 من 2400 على تطوير v2. القياس يجمع المفتاحين.')),
  MOHASSAN_SCRATCH_CLASSIFIERS: cutoverOff('تغيّر نتائج المصنّفات المحلية مسار الطلب والرفض. غياب الملفات أو خطأ التصنيف يغيّر الحالات المؤهلة.',
    measured(`${wave5}#pr-89-reproduction-and-5-whys`, 'استعادة مصنّفات التطوير أعادت 16 حالة رفض وحالتي حديث عابر في إعادة القياس.')),
  MOHASSAN_REFUSAL_POLICY: cutoverOff('قرار رفض خاطئ قد يمنع طلباً صالحاً. إيقافه يعيد المسار السابق للطلبات المشمولة.',
    measured(`${wave5}#pr-89-reproduction-and-5-whys`, 'أعادت استعادة رأس الرفض المتعلّم نتيجة حالة رفض إنجليزية في تجربة المقارنة.')),
  MOHASSAN_CLARIFY_CHOICES: cutoverOff('إذا اقترح النظام مرجعاً خاطئاً فقد يستأنف العمل على الملف أو الحساب الخطأ.',
    measured('docs/CLARIFICATION-CHOICES-ASSESSMENT.md', 'ظهر سؤال مناسب في 147 من 150 طلباً ملتبساً، دون سؤال زائد في 150 طلباً واضحاً.')),
  MOHASSAN_QUESTION_REWRITER: cutoverOff('قد تغيّر إعادة صياغة السؤال الكيان المطلوب أو تضيق عبارة البحث أكثر مما قصده المستخدم.',
    measured('docs/INTEGRATION-WAVE-3-2026-11-25.md', 'بلغت مجموعة البحث المقاسة على تطوير v2 في مرشح إعادة الصياغة 545 من 2400، مقابل 499 من 2400.')),
  MOHASSAN_ARITHMETIC_SEARCH: cutoverOff('ترجيح معادلة غير مناسبة قد ينتج رقماً خاطئاً. يبقى المسار محدوداً باللغة ونطاق الثقة.',
    measured('docs/MODELS-RUNBOOK.md#verification-on-the-linux-vm', 'أعاد فحص Linux القيمة 28 لمسألة الشريط المسجلة في المستودع. هذا فحص لمسألة واحدة.')),
  MOHASSAN_EXTRACTIVE_WRITING: cutoverOff('اختصار الوثيقة قد يفوّت الحقائق خارج المقتطفات المختارة، خصوصاً مع ميزانية السطر الواحد.',
    measured('docs/EXTRACTIVE-WRITING-EVALUATION.md#results', 'استُعيدت 27 من 100 حقيقة في السطر الواحد و98 من 100 في الملخص المفصل على مقتطفات محفوظة.')),
  MOHASSAN_REPLY_POLICY_ENABLED: cutoverOff('توجيه بنية الرد وإزالة صدى السؤال قد تغيّران رداً كان المستخدم يتوقع رؤيته كاملاً.',
    measured(`${responsePolicy}#development-gates`, 'تساوت نتائج تقسيمي التطوير بين الإيقاف والتشغيل في قياس السياسة.')),
  MOHASSAN_CONTEXT_POLICY_ENABLED: cutoverOff('يزيد وقت قراءة المحادثات الطويلة وقد يمنع الاستشهاد بأدلة قديمة عند تجاوز الحد.',
    measured(`${responsePolicy}#context-latency`, 'مع 1000 رسالة قديمة، بلغ الزمن المضاف 72.991 مللي ثانية عند المئين 95.')),
  MOHASSAN_LONG_RUN_ENABLED: cutoverOff('يضيف قبول الأعمال المدارة وحدودها ومواضع انتظار الموافقة. تبقى الأعمال المقبولة سابقاً قابلة للتحكم بعد الإيقاف.',
    measured(`${wave5}#rollout-flags-and-environment`, 'يوثق تقرير الدمج مسارات القبول المدعومة وقياسات التطوير للموجة الخامسة.')),
  MOHASSAN_BACKGROUND_RESULTS_ENABLED: cutoverOff('إيقافه يوقف إقرار العمل وبطاقة الخلفية والرد النهائي وإشعارات الأعمال المدارة الجديدة.',
    measured(`${backgroundResults}#verification`, 'مرّ 302 اختباراً منها الانقطاع وإعادة التشغيل والتوقف وتسجيل رد نهائي واحد.'), ['MOHASSAN_LONG_RUN_ENABLED']),
  TEST_DRIVEN_CODING_ENABLED: { ...cutoverOff('المفسّر غير الموثوق أو غياب عزل Linux يمنع تشغيل اختبارات الدالة، ويحتاج المسار فحص العامل المنفصل.',
    measured(`${wave4}#candidate-readiness`, 'بلغ مرشح توليد بايثون المتحقق 1481 من 2400 على تطوير v2 في قياس الموجة الرابعة.'), ['TEST_DRIVEN_CODING_PYTHON']), ownerTrial: 'false' },
  TEST_DRIVEN_CODING_PYTHON: { preflight: cutover, dependencies: ['TEST_DRIVEN_CODING_ENABLED'],
    risk: 'المفسّر غير المملوك للجذر أو غير القادر على تحميل libseccomp يفشل فحص التشغيل المعزول.',
    sources: [`${wave6}#vm-prerequisites`, 'docs/MODELS-RUNBOOK.md#verified-python-coding-on-the-vm'] },
  MOHASSAN_MIND: { dependencies: ['MOHASSAN_LOCAL_LAB', 'NODE_ENV'],
    risk: 'يغيّر مسار حساب واسترجاع وبحث المختبر وحده. يمنع إعداد الإنتاج تشغيله.',
    sources: ['apps/server/src/config.ts', 'docs/BRAIN-CURRENT-ARCHITECTURE.md'] },
  MOHASSAN_LOCAL_LAB: { dependencies: ['DATABASE_URL', 'MOHASSAN_MIND'],
    risk: 'ضبطه على 1 يمنع الاعتماد على قاعدة البيانات الخارجية ويفصل البيانات التي تعرضها نسخة المختبر.', sources: ['apps/server/src/config.ts'] },
  MOHASSAN_DESKTOP_SHELL: { preflight: cutover, risk: 'يعرض مراقبة التدريب على خادم تطوير محلي فقط. يبقى دون قيمة في إعداد الإقلاع الموثّق.',
    sources: [`${wave6}#environment-changes`, 'apps/server/src/training-monitor/route.ts'] },
  MOHASSAN_ROUTER_SHADOW: { preflight: cutover, risk: 'رصد التوجيه يحتاج الملف المحلي ويجري في التطوير. يبقى دون قيمة في إعداد الإقلاع الموثّق.',
    sources: [`${wave6}#environment-changes`, 'apps/server/src/app.ts'] },
  EXECUTOR_EXPERIMENT: { preflight: cutover, risk: 'تغيير المسار يغيّر شروط عزل عامل التنفيذ المحلي. يبقى دون قيمة في إعداد الإقلاع الموثّق.',
    sources: [`${wave6}#environment-changes`, 'apps/server/src/executor.ts'] },
  MOHASSAN_JUDGE_SHADOW: { evidence: judgeMeasurement, risk: 'إيقافه يوقف رصد جودة الرد وإصلاحات المالك وحجب الرد عند نقص أدلته.', sources: ['apps/server/src/assistant/judge-shadow.ts'] },
  MOHASSAN_JUDGE_FIX: { dependencies: ['MOHASSAN_JUDGE_SHADOW'], evidence: judgeMeasurement, risk: 'قد تغيّر قواعد الإصلاح جواب المالك عند نص أو سياق ملتبس.', sources: ['apps/server/src/assistant/judge-shadow.ts'] },
  MOHASSAN_JUDGE_WITHHOLD: { dependencies: ['MOHASSAN_JUDGE_SHADOW'], evidence: judgeMeasurement, risk: 'تقدير خاطئ لكفاية الأدلة قد يحجب جواباً نافعاً عن المالك.', sources: ['apps/server/src/assistant/judge-shadow.ts'] },
  SKILL_ENGINE_ENABLED: { risk: 'إيقافه يعيد مسار المحادثة السابق دون اختيار مهارات المحرك.', sources: ['apps/server/src/config.ts', 'apps/server/src/app.ts'] },
  SKILL_REMOTE_REPO: { dependencies: ['SKILL_ENGINE_ENABLED'], risk: 'الإعداد المفقود أو غير الصالح يوقف التزامن مع مصدر المهارات البعيد.', sources: ['apps/server/src/skill-remote.ts', 'apps/server/src/app.ts'] },
  SKILL_REMOTE_AUTO_ACTIVATE: { dependencies: ['SKILL_ENGINE_ENABLED', 'SKILL_REMOTE_REPO'], risk: 'يتيح تفعيل المراجعات المستوردة تلقائياً إذا اجتازت شروط المخزن.', sources: ['apps/server/src/skill-remote.ts', 'apps/server/src/app.ts'] },
  LEARNING_EVALUATION_MODEL: { dependencies: ['LEARNING_EVALUATION_OLLAMA_URL'], risk: 'عند اختيار نموذج غير متاح يتعذر تشغيل تقييم التعلم المحلي.', sources: ['apps/server/src/config.ts'] },
  STUDIO_GATEWAY_URL: { dependencies: ['STUDIO_GATEWAY_SECRET'], risk: 'عنوان غير متاح أو مفتاح مختلف يفشل عمليات الاستوديو التي تعتمد على البوابة.', sources: ['apps/server/src/config.ts', 'apps/server/src/app.ts'] },
  DESKTOP_ENGINE: { risk: 'إيقافه على ويندوز المحلي يمنع استخدام أدوات نافذة سطح المكتب. الإنتاج لا يشغّله.', sources: ['apps/server/src/config.ts'] },
  WINDOWS_REMOTE_ENABLED: { dependencies: ['NODE_ENV'], risk: 'تغييره يبدّل توفر اتصال ويندوز البعيد. القيمة الافتراضية في الإنتاج توقفه.', sources: ['apps/server/src/config.ts'] },
  SITES_PUBLISH_TARGET: { dependencies: ['VERCEL_TOKEN'], risk: 'القيمة none تمنع النشر وتبقي المعاينات والتنزيل.', sources: ['apps/server/src/config.ts'] },
  VERCEL_TOKEN: { dependencies: ['SITES_PUBLISH_TARGET'], risk: 'غياب الرمز يعطّل النشر على حساب المالك وتبقى المعاينات والتنزيل.', sources: ['apps/server/src/config.ts'] },
  GOOGLE_ADS_PUBLISHING_ENABLED: { dependencies: ['GOOGLE_ADS_MAX_DAILY_BUDGET'],
    risk: 'يفتح مسار نشر حملات يظل مشروطاً بصلاحيات الحساب والموافقة وحد الميزانية.', sources: ['docs/GOOGLE-ADS.md#بوابات-النشر', 'apps/server/src/config.ts'] },
  AI_ALLOW_PAID_FALLBACK: externalProvider,
  AI_AUTOMATIC_FALLBACK: externalProvider,
  FREELLMAPI_ENABLED: externalProvider,
  FREELLMAPI_FREE_ONLY: externalProvider,
  FREELLMAPI_API_KEY: externalProvider,
  FREELLMAPI_BASE_URL: externalProvider,
  FREELLMAPI_MODELS: externalProvider,
  FREELLMAPI_TIMEOUT_MS: externalProvider,
  GROQ_MODEL: externalProvider,
  GROQ_REASONING_MODEL: externalProvider,
  GROQ_VISION_MODEL: externalProvider,
  GROQ_PRICE_INPUT_PER_MTOK: externalProvider,
  GROQ_PRICE_OUTPUT_PER_MTOK: externalProvider,
  DATABASE_URL: { preflight: cutover, evidence: deployRehearsal,
    risk: 'عنوان غير صالح أو قاعدة بيانات مختلفة قد يمنع الإقلاع أو يوجّه الخادم إلى بيانات أخرى.', sources: [`${wave6}#environment-changes`] },
  WEB_ORIGIN: { preflight: cutover, risk: 'عنوان الواجهة الخاطئ يفشل التحقق من الأصل وتسجيل الدخول.', sources: [`${wave6}#environment-changes`] },
  SERVER_HOST: { preflight: cutover, risk: 'عنوان ربط مختلف يعطّل مسار الطلبات المتوقع من Caddy أو يوسّع نطاق الاستماع.', sources: [`${wave6}#vm-prerequisites`] },
  SERVER_PORT: { preflight: cutover, risk: 'المنفذ المختلف يقطع الاتصال من Caddy عند بقاء إعداد الوسيط كما هو.', sources: [`${wave6}#vm-prerequisites`] },
  BETTER_AUTH_SECRET: { preflight: cutover, risk: 'تغيير المفتاح قد يبطل الجلسات القائمة، والقيمة القصيرة تفشل preflight.', sources: [`${wave6}#environment-changes`] },
  INTERNAL_API_SECRET: { preflight: cutover, risk: 'السر المختلف عن إعداد الواجهة يقطع وصول الطلبات الموثوقة إلى الخادم.', sources: [`${wave6}#environment-changes`] },
  SETUP_TOKEN: { risk: 'يمنع الرمز الخاطئ إنشاء المالك في التهيئة الأولى. وصفة النشر تغلق التهيئة في الإنتاج.', sources: ['scripts/cloud-linux/README.md#configuration-and-staging'] },
  MOHASSAN_OCR_MODEL_DIR: { risk: 'تغيير الدليل قد يمنع تحميل قارئ الصور. عند غياب ملفات صحيحة يرفض الخادم رسائل الصور.', sources: ['docs/IMAGE-READING-2026-11-22.md', 'apps/server/src/app.ts'] },
  MOHASSAN_OCR_WORKERS: { risk: 'عدد العمال يغيّر توازي قراءة الصور واستهلاك موارد الخادم.', sources: ['apps/server/src/app.ts'] },
  SKILL_REMOTE_SYNC_MINUTES: { dependencies: ['SKILL_ENGINE_ENABLED', 'SKILL_REMOTE_REPO'], risk: 'القيمة صفر توقف الاستطلاع الدوري. الفاصل المرفوض يعطّل مصدر المهارات البعيد.', sources: ['apps/server/src/skill-remote.ts', 'apps/server/src/app.ts'] },
  LOCAL_MODEL_URL: { risk: 'العنوان الخاطئ يفشل التحقق من قائمة النماذج المحلية التي يستخدمها مخزون المشغّل.', sources: ['apps/server/src/executor.ts'] },
  ADS_CHAT_FINETUNE: { risk: 'المسار الخاطئ قد يمنع تحميل الضبط الخاص بمحادثة الإعلانات.', sources: ['apps/server/src/ads-lab.ts'] },
  ADS_MODEL_DEVICE: { risk: 'اختيار جهاز غير متوفر يعطّل تشغيل نموذج الإعلانات على الجهاز المطلوب.', sources: ['apps/server/src/ads-lab.ts', 'packages/model-relations/src/worker-adapter.ts'] },
  ADS_MODEL_RUN: { risk: 'المجلد الخاطئ يمنع إيجاد ملفات تشغيل نموذج الإعلانات.', sources: ['apps/server/src/ads-lab.ts'] },
  BROWSER_PROFILE_DIR: { risk: 'تغيير المجلد يفصل جلسات المتصفح المحفوظة عن التشغيل الجديد.', sources: [configSource, `${wave6}#vm-prerequisites`] },
  CODING_ALLOWED_ROOTS: { risk: 'تقييد الجذور يمنع الوصول إلى المشاريع الموجودة خارجها. توسيعها يوسّع الملفات التي تدخل نطاق العمل.', sources: [configSource, 'apps/server/src/app.ts'] },
  CODING_DATA_DIR: { risk: 'المجلد غير القابل للكتابة قد يمنع إنشاء ملفات عمل البرمجة.', sources: [configSource, 'apps/server/src/app.ts'] },
  DATA_DIR: { dependencies: ['DATABASE_URL'], risk: 'عند استخدام قاعدة محلية مضمّنة، يبدّل المسار البيانات التي يفتحها الخادم.', sources: [configSource, 'packages/database/src/index.ts'] },
  DESKTOP_ALLOWED_ROOTS: { dependencies: ['DESKTOP_ENGINE'], risk: 'المجلد الخارج عن الجذور المعتمدة يصبح محظوراً لأدوات سطح المكتب.', sources: [configSource, 'packages/desktop/src/index.ts'] },
  DESKTOP_DATA_DIR: { dependencies: ['DESKTOP_ENGINE'], risk: 'المجلد غير القابل للكتابة قد يعطّل حفظ حالة أدوات سطح المكتب.', sources: [configSource, 'packages/desktop/src/index.ts'] },
  DESKTOP_PROJECTS_ROOT: { dependencies: ['DESKTOP_ENGINE'], risk: 'المسار يغيّر المشاريع التي تظهر لأدوات سطح المكتب.', sources: [configSource, 'packages/desktop/src/index.ts'] },
  DESKTOP_SCREENSHOTS_DIR: { dependencies: ['DESKTOP_ENGINE'], risk: 'المجلد غير القابل للكتابة قد يمنع حفظ لقطات سطح المكتب.', sources: [configSource, 'packages/desktop/src/index.ts'] },
  DOCUMENTS_DIR: { risk: 'تغيير المجلد قد يمنع الوصول إلى مستندات محفوظة، ومجلد غير قابل للكتابة يعطّل التوليد.', sources: [configSource, 'scripts/cloud-linux/server.env.example'] },
  DOCUMENT_FONTS_DIR: { risk: 'غياب الخطوط المطلوبة قد يعطّل إخراج ملفات PDF أو يغيّر شكلها.', sources: [configSource, 'docs/PDF-DOCUMENTS-2026-11-22.md'] },
  EXECUTOR_CHECKPOINT: { dependencies: ['EXECUTOR_EXPERIMENT'], risk: 'ملف ناقص أو إصدار غير متطابق يمنع العامل المحلي من قبول النموذج.', sources: [executorSource] },
  EXECUTOR_DEVICE: { risk: 'اختيار CUDA على جهاز بلا دعم قد يعطّل تشغيل نماذج التنفيذ المحلية.', sources: [executorSource, 'packages/model-relations/src/worker-adapter.ts'] },
  EXECUTOR_EVALUATION_REPORT: { dependencies: ['EXECUTOR_CHECKPOINT'], risk: 'تقرير تقييم غائب أو من نقطة حفظ أخرى يمنع التحقق من الإصدار.', sources: [executorSource] },
  EXECUTOR_REGISTRY_ENTRY: { dependencies: ['EXECUTOR_CHECKPOINT'], risk: 'مدخل لا يطابق النموذج يوقف التحقق من إصدار التنفيذ المحلي.', sources: [executorSource] },
  EXECUTOR_REQUEST_TIMEOUT_SECONDS: { risk: 'الحد القصير قد يقطع الطلب المحلي قبل اكتماله، والطويل يزيد انتظار التعافي.', sources: [executorSource] },
  EXECUTOR_STARTUP_TIMEOUT_SECONDS: { risk: 'الحد القصير قد يقطع تحميل العامل قبل أن يصبح جاهزاً.', sources: [executorSource] },
  GOOGLE_ADS_CLIENT_ID: adsCredential,
  GOOGLE_ADS_CLIENT_SECRET: adsCredential,
  GOOGLE_ADS_DEVELOPER_TOKEN: adsCredential,
  GOOGLE_ADS_TOKEN_KEY: { sources: [configSource, adsSource], risk: 'تغيير مفتاح التشفير بلا نقل آمن قد يمنع فك رموز الحسابات المخزّنة.' },
  GOOGLE_ADS_MAX_DAILY_BUDGET: { dependencies: ['GOOGLE_ADS_PUBLISHING_ENABLED'], sources: [configSource, 'docs/GOOGLE-ADS.md#بوابات-النشر'], risk: 'يغيّر سقف الميزانية التي يسمح بها مسار النشر.' },
  LEARNING_EVALUATION_OLLAMA_URL: { dependencies: ['LEARNING_EVALUATION_MODEL'], risk: 'عنوان غير متاح يمنع الوصول إلى نموذج التقييم المحلي.', sources: [configSource] },
  MEMBER_DAILY_RUNS: { risk: 'تغيير الحصة يغيّر عدد تشغيلات الأعضاء اليومية المقبولة.', sources: [configSource, 'apps/server/src/members.ts'] },
  MOHASSAN_ISOLATED_TEST: { risk: 'القيمة true تمنع تحميل dotenv التلقائي وتترك الإعدادات التي تمرّرها العملية.', sources: [configSource] },
  MOHASSAN_JUDGE_LOG_DIR: { dependencies: ['MOHASSAN_JUDGE_SHADOW'], risk: 'مجلد غير قابل للكتابة يفقد تسجيل أحكام الرد.', sources: ['apps/server/src/assistant/judge-shadow.ts', 'scripts/cloud-linux/server.env.example'] },
  NODE_ENV: { risk: 'يبدّل قواعد وضع الإنتاج، ومنها السماح بالتطوير المحلي والقياسات الافتراضية واتصال قاعدة البيانات.', sources: [configSource, 'packages/database/src/index.ts'] },
  OWNER_EMAIL: ownerSetup,
  OWNER_NAME: ownerSetup,
  OWNER_PASSWORD: ownerSetup,
  SANDBOX_QUOTA_ROOT: { risk: 'يغيّر مجلد حدود المساحة لبيئة العزل المحلية. تركه فارغاً يزيل هذه الحدود عند غياب إعداد بديل.', sources: ['packages/sandbox/src/index.ts'] },
  SKILL_REMOTE_DATA_DIR: { dependencies: ['SKILL_REMOTE_REPO'], risk: 'تغيير المجلد يفصل النسخة المخزّنة من مصدر المهارات، وقد يفشل التزامن دون إذن للكتابة.', sources: [skillsSource] },
  SKILL_REMOTE_PATH: { dependencies: ['SKILL_REMOTE_REPO'], risk: 'مسار غير صحيح يفقد المهارات المطلوبة، والمسار غير الآمن يعطّل الإعداد.', sources: [skillsSource] },
  SKILL_REMOTE_REF: { dependencies: ['SKILL_REMOTE_REPO'], risk: 'مرجع مختلف يختار إصداراً آخر من المهارات المستوردة.', sources: [skillsSource] },
  STATE_DIRECTORY: { dependencies: ['PRODUCTION_METRICS_DIR'], risk: 'إذا لم يضبط مسار القياسات صراحةً فإن تغيير دليل حالة الخدمة يغيّر موضع اللقطات.', sources: ['apps/server/src/ops/metrics/index.ts'] },
  STUDIO_AI_DATA_DIR: { risk: 'المجلد غير الصحيح يفصل ملفات مشاريع الاستوديو عن النسخة الحالية.', sources: [configSource, 'apps/server/src/app.ts'] },
  STUDIO_GATEWAY_SECRET: { dependencies: ['STUDIO_GATEWAY_URL'], risk: 'السر غير المطابق يفشل العمليات التي تتحقق من بيانات اعتماد البوابة.', sources: [configSource, 'apps/server/src/app.ts'] },
  STUDIO_PREVIEW_PORT: { risk: 'المنفذ غير المتاح قد يمنع الوصول إلى معاينات الاستوديو.', sources: [configSource, 'apps/server/src/app.ts'] },
  VERCEL_TEAM_ID: { dependencies: ['VERCEL_TOKEN'], risk: 'معرّف فريق غير صحيح قد يوجّه محاولة نشر الموقع إلى نطاق حساب مختلف أو يرفض الطلب.', sources: [configSource, 'apps/server/src/app.ts'] },
  LOCALAPPDATA: childEnvironment,
  PATH: childEnvironment,
  ProgramFiles: childEnvironment,
  SystemRoot: childEnvironment,
  TEMP: temporaryDirectory,
  TMP: temporaryDirectory,
  VITEST: { risk: 'معرّف بيئة الاختبار يبدّل تحميل المصنّفات ومراقبة بعض مسارات الرد والتوجيه.', sources: ['apps/server/src/app.ts', 'apps/server/src/assistant/judge-shadow.ts', 'apps/server/src/assistant/scratch-decisions.ts'] },
  WINDIR: childEnvironment,
};

const arbiterSource = 'packages/model-relations/src/manager.ts';
const arbiterDecisions: Readonly<Record<string, string>> = {
  MOHASSAN_ARBITER_ROUTING: 'قد يختار مساراً مختلفاً لطلب صالح. خسرت جميع البدائل الـ29 المقاسة في v2 حالة ناجحة.',
  MOHASSAN_ARBITER_QUESTION_REWRITE: 'قد يختار سؤالاً عاماً أو صياغة تغيّر الكيان المطلوب.',
  MOHASSAN_ARBITER_LOCAL_COMPUTATION: 'قد يرجّح نتيجة حساب بديلة. الخطأ يغيّر القيمة المنشورة.',
  MOHASSAN_ARBITER_COMPOUND_PLAN: 'قد يبدّل بين خطة مركّبة ومسار مباشر، ما قد يفقد إحدى الخطوات المطلوبة.',
};

function linkedNote(name: string): EvidenceNote | undefined {
  for (const group of [webPush, apns]) {
    if (group.includes(name)) return { ...pushNote, dependencies: group.filter(item => item !== name) };
  }
  const isKill = name.endsWith('_KILL');
  const flag = isKill ? name.slice(0, -5) : name;
  const decision = Object.hasOwn(arbiterDecisions, flag) ? arbiterDecisions[flag] : undefined;
  if (decision === undefined) return undefined;
  const risk = isKill ? 'القيمة 1 تعطل أثر المحكّم لهذا القرار حتى لو اجتاز الترقية.' : `${decision} التطبيق يحتاج ترقية هذا النوع وترك مفتاح الإيقاف مطفأً.`;
  return {
    ...cutoverOff(risk, arbiterMeasurement, isKill ? [flag] : ['MOHASSAN_MODEL_RELATIONS', `${flag}_KILL`]),
    sources: [`${wave6}#environment-changes`, arbiterSource],
  };
}

export function getActivationEvidence(name: string): ActivationEvidence {
  const entry = (Object.hasOwn(notes, name) ? notes[name] : undefined) ?? linkedNote(name);
  const evidence = entry?.evidence ?? null;
  const preflight = entry?.preflight ?? null;
  const paths = [...new Set([...(entry?.sources ?? []), ...(evidence ? [evidence.path] : []), ...(preflight ? [preflight.path] : [])])];
  return {
    ownerTrial: entry?.ownerTrial ?? null,
    dependencies: entry?.dependencies ?? [],
    preflight,
    evidence,
    risk: entry?.risk ?? 'قد يغيّر الإعداد سلوك الوحدة المذكورة. لا توجد ملاحظة مخاطر خاصة منشورة لهذا الإعداد.',
    sources: paths.map(path => productionSource + path),
  };
}
