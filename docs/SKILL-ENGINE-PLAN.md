# خطة Skill Engine — الأساس ثم طبقات 6.1

الحالة: مقترح للمراجعة بتاريخ 2026-11-05. لم يُعدَّل أي كود بعد. كل مسار موصوف بأنه «قائم» جرى التحقق منه بفحص المستودع؛ وكل ما عداه مقترح جديد.

## 1. القرار

- **Skill Engine 6.0 ومكتبة v5.0 غير موجودين في المستودع.** لذلك يُبنى المحرك كمسار واحد: أساس المكتبة ثم طبقات 6.1 فوقه، بالترتيب الذي حددته:
  `Audit → Contracts → Security → Composition → Routing → Scheduling → Recovery → Gap Detection → Knowledge Graph → Evaluation → Skill Forge → Dashboard`
- **مؤجل بطلب المالك:** مستودعات GitHub الـ17 وكل استيراد منها، وتطبيق iPhone.
- **لا محرك مكرر:** المهارة لا تضيف أدوات ولا صلاحيات. هي تعليمات مع عقد يصرّح بما تحتاجه من الأدوات القائمة، والتنفيذ يبقى في Runtime والمساعد.

## 2. الجرد الفعلي

| الطبقة | المسارات | ملاحظة تؤثر على الخطة |
|---|---|---|
| التطبيقات | `apps/web`, `apps/server`, `apps/worker`, `apps/windows`, `apps/sandbox-gateway` | لا يوجد تطبيق iPhone |
| الحزم | `browser`, `coding`, `cognitive`, `contracts`, `database`, `memory`, `providers`, `runtime`, `sandbox`, `studio`, `studio-ai`, `studio-react`, `windows` | الاعتماد على `workspaces` وNode 24 |
| Runtime | `Runtime` في `packages/runtime/src/index.ts` | طابور SQL مع leases وfencing و`skipLocked`؛ يوزع المهام عبر callbacks محددة في `RuntimeOptions` |
| سجل القدرات | `capabilities` و`createCapabilities` في `packages/runtime/src/index.ts` | 10 قدرات ثابتة؛ `CreateTaskSchema` يقبل 5 منها فقط |
| المساعد | `apps/server/src/command-chat.ts` و`apps/server/src/assistant/brain.ts` | مسار منفصل عن Runtime؛ 15 أداة في `TOOLS` |
| التخطيط | `PlanningEngine`, `ModelRouter`, `StrategyPlanner` في `packages/cognitive/src/index.ts` | النتيجة دائماً `executionAllowed:false` |
| المهارات | `packages/memory/src/skills.ts` ومسارات `/api/memory/skills/*` | نوع واحد `checklist-router`؛ جداول `memory_skill_*` |
| الذاكرة | `createMemoryControl`, `context` في `packages/memory/src/index.ts` | بحث `lexical-v1` دون embeddings |
| العزل | `WindowsAppContainerSandbox` في `packages/sandbox/src/index.ts` | يشغّل اختبارات Node فقط، وفشل فحصه في جلسة الفحص |
| حماية المسارات | `packages/coding/src/security.ts` | `canonicalDirectory`, `assertNoLinks`, `boundedText`, `credentialLike`, `sensitivePath` قابلة لإعادة الاستخدام |
| الواجهة | `apps/web/components/workspace.tsx`, `memory-workspace.tsx`, `assistant-app.tsx` | لا مجلد `hooks`؛ Chakra في 4 ملفات فقط؛ `View` تحدد الأقسام |
| الوكيل | `apps/web/app/api/[...path]/route.ts` | GET وPOST فقط؛ حد الجسم 16384 بايت |
| الترحيلات | آخر إصدار مسجل `014_assistant` | كل وحدة تدير ترحيلها، والإصدار التالي `015` |

### عيوب قائمة تمس المحرك

1. `buildPrompt` يقص الذاكرة إلى 400 حرف من JSON، فاقتراحات المهارات لا تصل عملياً إلى المساعد.
2. `buildPrompt` يقص الناتج كله إلى 15000 حرف من النهاية، فأي قسم جديد قد يحذف الصفحة وسطر الخطوة الحالية.
3. تركيب الخدمات مكرر بين `apps/server/src/app.ts` و`apps/worker/src/index.ts`، وأي ربط يجب أن يتم في الموضعين.
4. لا يوجد commit واحد ولا remote، فالتراجع غير ممكن اليوم.
5. لا يوجد محرك صلاحيات موحد؛ الموافقات موزعة بين Runtime والمساعد وWindows.

## 3. المعمارية

```text
             Web (SkillLibrary)            Assistant (command-chat)     Runtime (tasks)
                     │                              │                         │
              /api/skills/*                  skillContext()            skill.run → runSkillGraph
                     └──────────────┬───────────────┴─────────────┬───────────┘
                                    ▼                             ▼
                           @mohassan/skills ──────────────► PermissionSnapshot
        registry · importer · composer · resolver · compiler · scheduler · evaluator · forge
                                    │                             ▲
                                    ▼                             │ قراءة فقط
                        جداول skill_* (Neon/PGlite)      createCapabilities + التكاملات + العزل
```

- **`@mohassan/skills`** حزمة جديدة تضم كل منطق المحرك.
- **`packages/contracts/src/skills.ts`** يضم عقود Zod المشتركة بين الخادم والواجهة، على نمط `command-chat.ts`.
- **`checklist-router`** يبقى في `packages/memory` ومساراته تعمل كما هي. يظهر في السجل عبر مُكيّف قراءة، ولا تُنسخ بياناته.
- **تنفيذ الخطوات:** عقدة النموذج تستدعي `ModelProvider`. عقدة القدرة تُنشئ مهمة فرعية عبر `runtime.createTask` بمفتاح idempotency مشتق من `runId:nodeId`، فتبقى الموافقات والتحقق كما هي.

### ثوابت الأمان

| # | الثابت | طريقة الإثبات |
|---|---|---|
| 1 | لا يُنفذ أي سكربت مستورد في الإصدار الأول، حتى بعد التفعيل | لا يوجد مسار كود يمرر ملفات مهارة إلى `SandboxRunner` |
| 2 | المهارة لا تقرأ أسراراً ولا `process.env` | الحزمة لا تستورد `config` ولا `vault`، واختبار حدود يفرض ذلك |
| 3 | التعليمات المعتمدة لا توسّع الصلاحيات | `sensitiveAction` والموافقات تعمل بعد القرار وبمعزل عن نص المهارة |
| 4 | النص غير المعتمد لا يصل إلى النموذج | المُجمّع يقرأ الحالة `active` فقط، ويتحقق من البصمة قبل الاستخدام |
| 5 | الإصدارات غير قابلة للتعديل | تعديل المحتوى ينشئ إصداراً جديداً، ولا يوجد UPDATE على المحتوى |
| 6 | كل استعلام مقيد بالمالك | اختبار عزل مالكين لكل مسار |
| 7 | لا تفعيل تلقائي | التفعيل يتطلب `approve:true` وفحصاً ناجحاً للبصمة نفسها. المهارات المستوردة تحتاج أيضاً قياساً ناجحاً، فلا تُفعَّل قبل M9. المهارات الداخلية تُفعَّل قبلها بموافقة صريحة ثم يعاد قياسها في M9 |

### دورة حياة الإصدار

`quarantined → inspected → sandbox_tested → benchmarked → active → (deprecated | revoked)`

مسارات خروج: `rejected` من أي مرحلة قبل `active`، و`stale` عند انجراف الجودة، وهي تعيد المهارة إلى المراجعة دون حذف.

## 4. العقد الموحد

`SkillContractSchema` في `packages/contracts/src/skills.ts`، كائن `strict`:

| الحقل | المعنى |
|---|---|
| `slug`, `name`, `description`, `version`, `category` | الهوية، و`category` من `SkillCategorySchema` |
| `origin` | `builtin` أو `custom` أو `local_import` أو `forge`؛ العلامة `custom` تظهر في الواجهة |
| `kind` | `instruction` أو `checklist-router` |
| `inputs`, `outputs` | أنواع مسماة، و`outputs` هي أساس الربط في الرسم البياني |
| `requires.capabilities`, `requires.tools`, `requires.scopes` | ما تحتاجه من الموجود فقط |
| `sideEffects` | `none`, `read`, `write_local`, `external`, `financial` |
| `timeoutMs`, `retry` | سقوف إلزامية، و`retry.maxAttempts` لا يتجاوز 3 |
| `idempotent`, `rollback` | شرط إعادة المحاولة، ووصف التراجع لكل أثر جانبي |
| `conflicts`, `dependsOn` | تعارضات واعتماديات صريحة |

أي مهارة تُستورد دون عقد صريح تأخذ عقداً مقيداً: `kind:instruction`، بلا أدوات، و`sideEffects:none`.

## 5. قاعدة البيانات

الجداول جديدة كلها، ولا يتغير أي جدول قائم سوى ما يُذكر صراحة. الترحيل في `packages/skills/src/migration.ts` بقفل `pg_advisory_xact_lock(1846021108)` وبنمط `memoryMigration` نفسه، ويُستدعى من الخادم والعامل.

| الترحيل | الجداول |
|---|---|
| `015_skill_registry` | `skill_families`, `skill_versions`, `skill_files`, `skill_sources`, `skill_activations`, `skill_audit` |
| `016_skill_security` | `skill_inspections` |
| `017_skill_runs` | `skill_runs`, `skill_run_nodes`, `skill_circuit_state`, `skill_usage` |
| `018_skill_graph` | `skill_edges` |
| `019_skill_eval` | `skill_benchmarks`, `skill_benchmark_runs`, `skill_quality_snapshots` |
| `020_skill_forge` | `skill_candidates`, `skill_experiments` |

قيود أساسية:

- `UNIQUE(owner_id,slug)` للعائلة، و`UNIQUE(family_id,version)` و`UNIQUE(owner_id,content_hash)` للإصدار، وبذلك تُمنع النسخ المكررة.
- `skill_activations` سجل إلحاقي يحفظ كل تفعيل، والتراجع يكون بإضافة صف يعيد إصداراً أقدم مقاساً.
- `skill_run_nodes` تحمل `lease_token` و`lease_expires_at` و`attempt`، مع `UNIQUE(run_id,node_id)`.

الترحيلات إضافية فقط، والتراجع عنها بحذف جداول `skill_*`، ولا تُمس بيانات قائمة.

## 6. الواجهات البرمجية

كلها POST أو GET لأن الوكيل لا يمرر غيرهما، وتستخدم `owner(request)` نفسها، وتتطلب الكتابة `expectedRevision`.

| المسار | العملية | المرحلة |
|---|---|---|
| GET `/api/skills` | السجل مع الفلاتر وحالة كل مهارة | M1 |
| GET `/api/skills/:id` | التفاصيل والإصدارات والفحوص والمصدر | M1 |
| POST `/api/skills/import` | استيراد من مجلد داخل `CODING_ALLOWED_ROOTS` إلى الحجر | M2 |
| POST `/api/skills/:id/inspect` | فحص ثابت للمحتوى | M2 |
| POST `/api/skills/:id/test`, `/benchmark` | اختبار وقياس | M9 |
| POST `/api/skills/:id/activate`, `/revoke`, `/rollback` | تفعيل وإلغاء وتراجع | M2 |
| POST `/api/skills/compose/validate` | فحص خطة قبل تشغيلها | M3 |
| GET `/api/skills/runs/:id` | حالة التشغيل والعقد | M5 |
| POST `/api/skills/runs/:id/cancel` | إلغاء | M5 |
| GET `/api/skills/gaps` | أحدث الفجوات | M7 |
| GET `/api/skills/graph` | رسم العلاقات | M8 |
| GET `/api/skills/portfolio` | التكرار والجودة ودورة الحياة | M9 |
| POST `/api/skills/forge/candidates` و`/:id/promote` | مرشحو Forge | M10 |
| GET `/api/skills/evolution` | مقاييس فعلية للوحة | M11 |

الاستيراد يأخذ مساراً وليس محتوى، لذلك لا يحتاج رفع حد الجسم في الوكيل.

## 7. خطة التنفيذ ملفاً بملف

كل مرحلة تنتهي بـ`npm run typecheck` و`npm test` دون زيادة في الفشل عن خط الأساس، ثم تحقق مستقل، ولا تبدأ التالية قبل ذلك.

### M0 — خط الأساس

- إنشاء أول commit بعد موافقتك. لا تُضاف ملفات مستثناة مثل `.env` و`.data`.
- تشخيص فحص AppContainer من طرفية عادية.
- `docs/IMPLEMENTATION-STATUS.md`: تسجيل خط الأساس.

**القبول:** فشل AppContainer مفسَّر، وخط الأساس مسجل بأرقامه.

### M1 — العقود والسجل

| الملف | التغيير |
|---|---|
| `packages/contracts/src/skills.ts` | جديد: `SkillCategorySchema`, `SkillContractSchema`, `SkillVersionSchema`, `SkillRegistryQuerySchema`, `SkillAuditEventSchema` |
| `packages/contracts/src/index.ts` | `export * from './skills'` |
| `packages/skills/package.json`, `src/index.ts` | جديد: `createSkillControl` |
| `packages/skills/src/migration.ts` | جديد: `skillsMigration` و`015_skill_registry` |
| `packages/skills/src/registry.ts` | جديد: البحث والتفاصيل وسجل التدقيق |
| `packages/skills/src/legacy.ts` | جديد: مُكيّف قراءة لـ`memory_skill_versions` |
| `packages/skills/src/builtin/*` | جديد: مهارات مخصصة موسومة `custom` |
| `apps/server/src/skills.ts` | جديد: `registerSkillRoutes` |
| `apps/server/src/app.ts` | تسجيل المسارات بعد `registerMemoryRoutes` |
| `apps/worker/src/index.ts` | استدعاء `skillsMigration` |
| `apps/server/src/config.ts`, `.env.example` | المتغير `SKILL_ENGINE_ENABLED` |

**اختبارات:** `packages/skills/src/registry.test.ts`, `tests/skills-api.test.ts`.
**القبول:** عزل المالك، ورفض العقود غير الصالحة، وبحث بالفئة والنص، وظهور `checklist-router` بلا تغيير في مساراته.

### M2 — الأمان والاستيراد

| الملف | التغيير |
|---|---|
| `packages/skills/src/importer.ts` | جديد: `importLocalSkill` باستخدام `canonicalDirectory`, `assertNoLinks`, `boundedText` |
| `packages/skills/src/frontmatter.ts` | جديد: محلل صارم لمجموعة فرعية؛ لا تعتمد على مكتبة YAML غير مثبتة |
| `packages/skills/src/inspector.ts` | جديد: كشف السكربتات والأسرار والمسارات الحساسة وأنماط حقن التعليمات |
| `packages/skills/src/lifecycle.ts` | جديد: انتقالات الحالة والتفعيل والتراجع |
| `packages/coding/src/index.ts` | تصدير المساعدات إن لم تكن مصدّرة |

**اختبارات:** `packages/skills/src/importer.test.ts`, `inspector.test.ts`, `tests/skills-security.test.ts` مع حزم خبيثة في `tests/fixtures/skills/`.
**القبول:** رفض symlink والخروج من المسار والملفات الثنائية وتجاوز الحدود. السكربت يُسجل ولا يُشغَّل. لا تفعيل دون فحص ناجح لنفس البصمة. وتفعيلان متزامنان ينتهيان بواحد ناجح و`409`.

### M3 — التركيب والتعارض والتخطيط المقيد بالصلاحية

| الملف | التغيير |
|---|---|
| `packages/skills/src/permissions.ts` | جديد: `buildPermissionSnapshot` للقراءة من `createCapabilities` والتكاملات وحالة العزل |
| `packages/skills/src/composer.ts` | جديد: `composeSkillGraph`، ترتيب طوبولوجي وفحص الدورات وتطابق أنواع المخرجات والمدخلات |
| `packages/skills/src/conflicts.ts` | جديد: تعارضات التعليمات والموارد والأدوات |
| `packages/cognitive/src/index.ts` | `StrategyPlanner.normalize` يبقى كما هو، ويضاف خيار فحص اختياري |

**اختبارات:** `composer.test.ts`, `conflicts.test.ts`, `permissions.test.ts`.
**القبول:** رفض أي خطة تحتاج قدرة غير `active` أو نطاقاً غير متاح مع سبب محدد. رفض الدورة والأنواع غير المتطابقة. كشف كتابتين على المورد نفسه.

### M4 — التوجيه ومُجمّع السياق

| الملف | التغيير |
|---|---|
| `packages/skills/src/router.ts` | جديد: `selectSkills` بتطابق لفظي ثم الوزن من الجودة |
| `packages/skills/src/compiler.ts` | جديد: `compileSkillContext` بثلاث طبقات وميزانية وإزالة تكرار ومراجع أدلة |
| `packages/skills/src/preload.ts` | جديد: تحميل مسبق للبيانات الوصفية والتعليمات المعتمدة فقط، بلا تنفيذ أدوات |
| `apps/server/src/assistant/brain.ts` | حقل `skills` في `PromptInput`، وأداة `load_skill`، وقاعدة في `systemPrompt`، وحجز الميزانية قبل القص |
| `apps/server/src/command-chat.ts` | `skillContext` في `CommandChatConfig`، وتنفيذ `load_skill` في `perform` |
| `apps/server/src/app.ts`, `apps/worker/src/index.ts` | تمرير السياق إلى المساعد و`ai.plan` |

الطبقات: L0 اسم ووصف، وL1 التعليمات المعتمدة، وL2 المراجع عند طلب `load_skill`. الميزانية المبدئية 2400 حرف من أصل 15000، وتُضبط من نتائج القياس.

**اختبارات:** `compiler.test.ts`, `router.test.ts`, وإضافات إلى `tests/assistant-brain.test.ts` و`tests/assistant-flow.test.ts`.
**القبول:** لا يتجاوز السياق الميزانية، وتبقى الصفحة وسطر الخطوة في الموجه. لا يصل نص غير `active`. لا يتغير الموجه حرفياً عند عدم وجود مهارات مطابقة. المهمة القديمة تستأنف، لأن `BrainState` يدمج القيم الافتراضية.

### M5 — الجدولة

| الملف | التغيير |
|---|---|
| `packages/contracts/src/index.ts` | إضافة `skill.run` إلى `CreateTaskSchema` |
| `packages/skills/src/scheduler.ts` | جديد: `runSkillGraph` و`claimNode` بنمط `skipLocked` وleases وfencing |
| `packages/runtime/src/index.ts` | قدرة `skill.run`، و`runSkillGraph` في `RuntimeOptions`، و`runSkill` للتوزيع |
| `apps/server/src/app.ts`, `apps/worker/src/index.ts` | تمرير المعالج |

**اختبارات:** `scheduler.test.ts`, `tests/skills-concurrency.test.ts`.
**القبول:** عاملان لا ينفذان العقدة نفسها. عقد مستقلة تعمل بالتوازي، والكتابة على مورد واحد تتسلسل. العقدة التي تحتاج موافقة تتوقف عبر المهمة الفرعية دون تجاوز.

### M6 — التعافي

| الملف | التغيير |
|---|---|
| `packages/skills/src/fallback.ts` | جديد: `decideRecovery` |
| `packages/skills/src/circuit.ts` | جديد: قاطع دائرة محفوظ لكل مهارة ومورد |
| `packages/skills/src/scheduler.ts` | استعادة عقد انتهت leases |

**القواعد:** إعادة المحاولة للعقد `idempotent` فقط وضمن `retry.maxAttempts`. العقدة ذات الأثر الخارجي بنتيجة غير محسومة تصبح `unknown` وتتوقف لطلب قرار. لا إعادة تلقائية لطلب نموذج مدفوع غير محسوم، وهي السياسة القائمة.

**اختبارات:** `tests/skills-recovery.test.ts` بقتل العامل بين الخطوات.
**القبول:** لا تكرار لأثر جانبي بعد إعادة التشغيل. القاطع يمنع الاستدعاء عند العتبة. المحاولات محدودة دائماً.

### M7 — كشف الفجوات

| الملف | التغيير |
|---|---|
| `packages/skills/src/gaps.ts` | جديد: `classifyGap` |
| `apps/server/src/command-chat.ts` | تسجيل التصنيف عند `blocked` و`partial` |

التصنيفات: `missing_skill`, `missing_tool`, `missing_permission`, `model_limitation`, `invalid_plan`, `stale_data`, `environment_failure`.

**القبول:** حالة اختبار ثابتة لكل تصنيف، واختبار حالات فصل بين الأسباب المتشابهة.

### M8 — رسم المعرفة

| الملف | التغيير |
|---|---|
| `packages/skills/src/graph.ts` | جديد: `rebuildSkillGraph` و`relatedSkills` |
| `packages/skills/src/router.ts` | استخدام العلاقات في الترتيب |

يستخدم جدول حواف SQL واحد مع `depends_on`, `conflicts_with`, `uses_tool`, `derived_from`, `succeeded_with`، دون قاعدة رسوم بيانية جديدة.

**القبول:** إعادة البناء متطابقة النتيجة عند التكرار، ولا تعبر الاستعلامات حدود المالك، والتوسيع محدود العمق.

### M9 — التقييم والمحفظة

| الملف | التغيير |
|---|---|
| `packages/skills/src/benchmark.ts` | جديد: مجموعات تدريب وholdout ثابتة |
| `packages/skills/src/quality.ts` | جديد: الدرجة والانجراف من نتائج مثبتة |
| `packages/skills/src/portfolio.ts` | جديد: التكرار وتقليل الاعتماديات ودورة الحياة |
| `scripts/check-skills.ts` | جديد: فحص حي صريح بـ`--live`، خارج `npm test` |
| `tests/fixtures/skills/benchmarks/*` | حالات القياس |

**معايير الترقية المبدئية:** السلامة 100%، وعدم وجود تراجع، وholdout لا يقل عن 85%، وهي معايير `checklist-router` القائمة. تقيس النتائج النجاح والتحقق والتعافي والتكلفة والزمن والأمان.

**القبول:** تقرير يقارن الأساس بالمرشح من تشغيل فعلي محفوظ. المرشح الضعيف يُرفض. درجات المستخدم لا تكفي للترقية.

### M10 — Skill Forge 2.0

| الملف | التغيير |
|---|---|
| `packages/skills/src/forge.ts` | جديد: توليد مرشح وطفرة معزولة وترقية وتراجع |

المرشح يولده النموذج كمقترح نصي فقط، ويدخل دورة الحياة من `quarantined`. لا يمكنه كتابة نفسه أو تفعيل نفسه.

**القبول:** الترقية تتطلب قياساً مستقلاً وموافقة صريحة. التراجع يعيد الإصدار السابق. المسار كله يترك أثراً في `skill_audit`.

### M11 — اللوحة

| الملف | التغيير |
|---|---|
| `apps/web/components/skill-library.tsx` | جديد: `SkillLibrary` بـChakra، بفئات وبحث وفلترة وتفاصيل واختبارات وصلاحيات وإصدارات وتفعيل |
| `apps/web/components/capability-evolution.tsx` | جديد: `CapabilityEvolution` من `/api/skills/evolution` فقط |
| `apps/web/components/workspace.tsx` | `View` جديدة `skills` و`dynamic` ومدخل في `navigation` |
| `apps/web/components/memory-workspace.tsx` | رابط إلى المكتبة؛ يبقى تبويب المهارات يعمل |

**الحالات:** تحميل، فراغ، خطأ، عدم اتصال، رفض صلاحية، مهارة غير صالحة أو متعارضة أو غير متوافقة أو ملغاة، تعطل عامل، تنفيذ منقطع، ذاكرة قديمة، تعافٍ، وتحديث متزامن عبر `expectedRevision`.

**اختبارات:** `tests/e2e/skills.spec.ts` بعرض الكمبيوتر والهاتف.
**القبول:** الرسوم تعرض «لا توجد بيانات كافية» بدل أرقام تقديرية، ولا يوجد تمرير أفقي بعرض 390px.

## 8. تغطية المتطلبات

### مكتبة v5.0

| # | المتطلب | الحالة |
|---|---|---|
| 1، 2 | تصنيف مستودعات GitHub والتحقق منها | مؤجل |
| 3 | السجل | M1 |
| 4 | المصدر والبصمات والإصدارات والتراجع | M1 وM2؛ تثبيت commit مؤجل مع GitHub |
| 5 | الاستيراد والحجر والفحص | M2، للمصادر المحلية |
| 6 | الربط | M4 وM5 |
| 7 | مهارات مخصصة موسومة | M1 |
| 8 | المتصفح | مهارات فوق `AgentBrowser` القائم |
| 9 | التصميم | مهارات فوق الاستوديو؛ **تحرير الصور لا أداة له** |
| 10 | اللغات والمستندات | الكتابة والترجمة عبر النموذج؛ **تحويل الملفات لا أداة له** |
| 11 | الأعمال وGoogle Ads | عبر المتصفح والموافقات؛ لا يوجد Ads API |
| 12 | الكمبيوتر | عبر منح Windows القائمة بعد ربط جهاز؛ iPhone مؤجل |
| 13 | القياس | M9 |
| 14 | تحميل المناسب فقط | M4 |
| 15 | لا تنفيذ تلقائي ولا اعتمادات | ثوابت §3 |
| 16 | اللوحة | M11 |
| 17 | العقود والتدقيق | M1 وكل مرحلة |
| 18 | الحالات | M11 |
| 19 | التوافق | شرط كل مرحلة؛ iPhone مؤجل |
| 20 | التحقق المستقل | M9 |

### Skill Engine 6.1

| # | المكون | المرحلة | # | المكون | المرحلة |
|---|---|---|---|---|---|
| 1 | التدقيق | M0 و§2 | 11 | الجودة والانجراف | M9 |
| 2 | العقد الموحد | M1 | 12 | المحفظة | M9 |
| 3 | التركيب | M3 | 13 | Forge 2.0 | M10 |
| 4 | التخطيط بالصلاحية | M3 | 14 | لوحة التطور | M11 |
| 5 | حل التعارض | M3 | 15 | التوافق | كل مرحلة |
| 6 | كشف الفجوات | M7 | 16 | العقود والترحيلات | M1 ولاحقاً |
| 7 | مُجمّع السياق | M4 | 17 | الحالات | M11 |
| 8 | رسم المعرفة | M8 | 18 | منع التكرار والسباقات | M5 وM6 |
| 9 | التعافي | M6 | 19 | الاختبارات | كل مرحلة |
| 10 | التحميل المسبق | M4 | 20 | الأدلة والتراجع | M9 و§10 |

## 9. الاعتماديات

```text
M0 → M1 → M2 ─┬─ M3 ─┬─ M5 → M6 ─┬─ M7
              │      │           └─ M9 → M10 → M11
              └─ M4 ─┴─ M8 ────────┘
```

M2 شرط لأي نص يصل إلى النموذج، وM9 شرط لتفعيل أي مهارة مستوردة، وM11 يعرض ما بُني فعلاً فقط.

## 10. التراجع

- كل مرحلة في commit مستقل بعد إنشاء أول commit.
- إيقاف المحرك: `SKILL_ENGINE_ENABLED=false` متغير جديد مقترح. عند الإيقاف يعود الموجه إلى شكله الحالي، وتُرفض مهام `skill.run`.
- تراجع مهارة: `/api/skills/:id/rollback` يعيد إصداراً مقاساً سابقاً.
- تراجع الترحيل: حذف جداول `skill_*` بعد نسخة احتياطية، ولا أثر على الجداول القائمة.

## 11. المخاطر والقيود المعروفة

| الخطر | المعالجة |
|---|---|
| قص الموجه يحذف محتوى الصفحة | حجز ميزانية السياق قبل القص، واختبار خاص في M4 |
| حدود TPM في Groq | حساب الحجم ضمن `estimateTokens`، والقياس الحي صريح فقط |
| اختبار السكربتات غير ممكن حالياً | تعليمات فقط في الإصدار الأول |
| كشف حقن التعليمات إرشادي | طبقة مراجعة، والحماية الحقيقية هي الثوابت والموافقات |
| موافقة الأفعال الحساسة تعتمد على اسم الزر | قيد قائم موثق في README، والمهارة لا تضعفه ولا تعالجه |
| عينات القياس صغيرة | تُعرض أعدادها، ولا تُقدم كدليل عام |

## 12. قرارات تنتظر المالك

1. الموافقة على أول commit قبل M0.
2. قائمة الفئات الـ16؛ الطلب يعدد 14. `SkillCategorySchema` يبدأ بها، وأي إضافة لاحقة تكون بتعديل صغير.
3. نتيجة `npx tsx scripts/probe-sandbox.ts` من طرفية عادية.
4. تأكيد أن المهارات المستوردة تعليمات فقط في الإصدار الأول.
