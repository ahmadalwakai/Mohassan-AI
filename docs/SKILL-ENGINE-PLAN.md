# خطة Skill Execution Engine

الحالة: الإصدار الثاني بتاريخ 2026-11-05، ويحل محل الخطة السابقة «تعليمات فقط». المراحل من M0 إلى M3 منفذة. كل مسار موصوف بأنه «قائم» جرى التحقق منه في الكود؛ وكل ما عداه مقترح جديد.

## 1. القرارات

- **محرك تنفيذ كامل بثلاثة أنواع**، ولا يُعرض نوع التعليمات على أنه تنفيذ.
- **العمل على الكود المحلي فقط.** لا GitHub ولا استيراد منه. مصادر الاستيراد: مجلد محلي داخل `CODING_ALLOWED_ROOTS`. تطبيق iPhone مؤجل.
- **الأولوية:** التنفيذ عبر الأدوات الموثوقة القائمة أولاً. النوع الثالث لا يُفعَّل قبل اجتياز بوابات العزل في M7.
- **لا محرك مكرر:** المجدول يوزع العمل، أما التنفيذ الفعلي فيبقى في Runtime والمتصفح والبرمجة والاستوديو وWindows.

| النوع | `level` | ما يفعله | التنفيذ | متى يعمل |
|---|---|---|---|---|
| تعليمات | `instruction` | يحمّل تعليمات مفحوصة إلى سياق النموذج ليوجّه الأدوات المصرح بها | حلقة المساعد | M4 |
| متكامل مع الأدوات | `tool` | ينفذ عمليات فعلية عبر `ToolGateway` | المجدول ثم الأدوات | M5 |
| تنفيذي | `executable` | يشغّل سكربتاً مستورداً داخل حد معزول | المجدول ثم `runScript` | M8، بعد بوابات M7 |

## 2. الجرد الفعلي

| الطبقة | القائم | أثره |
|---|---|---|
| التطبيقات | `apps/web`, `server`, `worker`, `windows`, `sandbox-gateway` | لا iPhone |
| الحزم | `browser`, `coding`, `cognitive`, `contracts`, `database`, `memory`, `providers`, `runtime`, `sandbox`, `studio`, `studio-ai`, `studio-react`, `windows` | تُضاف حزمة واحدة |
| Runtime | `Runtime` و`RuntimeOptions` في `packages/runtime/src/index.ts` | leases وfencing و`skipLocked`، والتوزيع عبر callbacks |
| المساعد | `work`, `perform`, `think` في `apps/server/src/command-chat.ts`؛ `TOOLS`, `buildPrompt` في `assistant/brain.ts` | مسار منفصل عن Runtime، وحالته تدمج القيم الافتراضية عند الاستئناف |
| التخطيط | `PlanningEngine`, `StrategyPlanner` في `packages/cognitive/src/index.ts` | لا ينفذ؛ `executionAllowed:false` |
| المهارات | `packages/memory/src/skills.ts` | `checklist-router` فقط |
| الواجهة | `workspace.tsx`, `memory-workspace.tsx` | `View` تحدد الأقسام، ولا مجلد `hooks` |
| الوكيل | `apps/web/app/api/[...path]/route.ts` | GET وPOST فقط، وحد 16384 بايت |
| الترحيلات | آخر إصدار `014_assistant` | التالي `015` |

### لا يوجد Tool Registry

طلبك يفترض سجل أدوات قائماً، **وهو غير موجود**. الموجود قائمة قدرات وصفية في `capabilities`، وقائمة `TOOLS` في المساعد، وcallbacks في `RuntimeOptions`. لذلك يبني M5 طبقة `ToolGateway` رفيعة فوق الموجود دون إعادة كتابته.

| الأداة في Gateway | التنفيذ القائم | الأثر الجانبي | الحالة |
|---|---|---|---|
| `browser.open` | مهمة فرعية `browser.open` عبر `browserTask.execute` و`verify` | قراءة | يعمل |
| `browser.interact` | `action`, `fill` في `createBrowserResearchControl` | كتابة في الجلسة | يعمل |
| `browser.submit` | `prepare` و`approve` بموافقة مرتبطة بالمشاهدة | خارجي | يعمل بموافقة |
| `research.run` | `research` في الحزمة نفسها | قراءة | يعمل |
| `vision.inspect` | نموذج الرؤية عبر `ModelProvider` | قراءة، توكنات | يعمل |
| `coding.change` | مهمة فرعية `coding.change` | كتابة في worktree | **يتوقف حتى إصلاح العزل** |
| `studio.change` | مهمة فرعية `studio.change` | كتابة في نسخة مراجعة | **يتوقف حتى إصلاح العزل** |
| `computer.view`, `computer.act` | `/api/windows/devices/:id/frame` و`/actions` بمنحة محددة | تحكم محلي | **يحتاج جهازاً مربوطاً** |
| `memory.search` | `memory.search` | قراءة | يعمل |
| `file.read`, `file.write` | **لا يوجد؛ أداة جديدة** مبنية على `canonicalDirectory` و`assertNoLinks` | كتابة بموافقة وصورة سابقة | M5 |

### عيوب قائمة تمس المحرك

1. `buildPrompt` يقص الذاكرة إلى 400 حرف، والموجه كله إلى 15000 حرف من نهايته.
2. تركيب الخدمات مكرر بين `apps/server/src/app.ts` و`apps/worker/src/index.ts`.
3. لا يوجد محرك صلاحيات موحد.
4. **Coding Lab والاستوديو متوقفان فعلياً على هذا الجهاز** بسبب فشل العزل.

## 3. نتيجة تدقيق العزل

التفاصيل في `docs/ISOLATION.md`. الملخص: الأسرار وملفات المستخدم وTCP محجوبة فعلاً. وفشل الفحص سببه تشغيل المشغّل من PowerShell المحزّم، وليس خللاً في الحدود.

| الفجوة | الدليل | المعالجة | البوابة |
|---|---|---|---|
| مشغّل محزّم | الرمز يرث قدرة والحاوية فرعية | تشغيل PowerShell من `System32` مع رفض السياق المحزّم | G1 |
| لا حصة قرص | 512 MiB في 0.2 ثانية | حد كتابة Job مع مراقب حجم على المضيف | G2 |
| لا قيود UI | غير مضبوطة في `Runner.cs` | `JobObjectBasicUIRestrictions` | G3 |
| تحميل كود أصلي | `dlopen` يصل إلى المحمّل | `--no-addons` و`--permission`، ثم سياسة تخفيف العملية إن أثبتت توافقها | G4 |
| قراءة ملفات عامة | `Windows` و`Program Files` | تجربة LPAC؛ تُعتمد إن عمل Node | G5 |
| التشغيل مقيد باختبارات | `--test` ثابت في `execute` | طلب `script` بأوامر ثابتة | G6 |
| لا إخراج ملفات | تُحذف النسخة بالكامل | جمع `outputs` مع رفض الروابط وحدود الحجم | G7 |
| الوسائل الجانبية | سرد pipes، إرسال UDP | اختبار ضبط لـUDP، وفحص pipes المتاحة | G8 |
| إنشاء عملية يعلق | يستهلك المهلة كاملة | حظره عبر `--permission`، والمهلة تبقى الحد | G4 |

**قيد متبقٍ:** AppContainer يشارك النواة مع المضيف. لن يصبح هذا عزل VM، وسيُعرض بهذا الوصف في الواجهة والأدلة.

**حدود النوع التنفيذي في الإصدار الأول:** ملفات نصية وNode فقط، وعملية واحدة، وبلا شبكة، وبلا `npm install`، وبلا Python. أي مهارة تتطلب غير ذلك تأخذ الحالة `incompatible` وتظل مستوردة دون تشغيل.

## 4. المعمارية

```text
 Web SkillLibrary          Assistant                     Runtime
       │              skillContext / run_skill          skill.run
  /api/skills/*                  │                          │
       └──────────────┬──────────┴──────────────┬───────────┘
                      ▼                         ▼
              @mohassan/skills ───────────► Scheduler
   registry · importer · inspector · grants · composer · compiler
                      │                         │
                      ▼               ┌─────────┴──────────┐
              جداول skill_*           ▼                    ▼
                                 ToolGateway        SandboxRunner.runScript
                                      │                    │
              مهام Runtime، Browser، Research، Windows      AppContainer + Job
```

- **`@mohassan/skills`** تضم منطق المحرك، و`packages/contracts/src/skills.ts` يضم العقود المشتركة.
- **عقدة الأداة ذات الأثر الجانبي** تنشئ مهمة فرعية بمفتاح `runId:nodeId:attempt-group`، فتبقى الموافقات والتحقق المستقل كما هي.
- **`checklist-router`** يبقى كما هو ويظهر عبر مُكيّف قراءة، بمستوى `instruction`.

### ثوابت الأمان

| # | الثابت | الإثبات |
|---|---|---|
| 1 | لا يُنفذ أي سكربت مستورد على المضيف | المسار الوحيد للتشغيل هو `runScript`، واختبار حدود يمنع استيراد `child_process` في الحزمة |
| 2 | لا تصل الأسرار إلى أي مهارة | الحزمة لا تستورد `config` أو `CredentialVault`، والبيئة قائمة ثابتة |
| 3 | SKILL.md بيانات غير موثوقة | تدخل قسماً معلّماً بعد موجه النظام، ولا تغيّر الأدوات ولا الموافقات |
| 4 | الأداة تُرفض إن لم تكن في العقد والمنحة معاً | فحص في Gateway لكل استدعاء |
| 5 | مخرجات السكربت والصفحات بيانات غير موثوقة | تمر عبر `clean` وتُوسم قبل دخول السياق |
| 6 | المحتوى المنفذ هو المفحوص نفسه | مطابقة `content_hash` عند التحميل وعند التشغيل |
| 7 | الإصدارات غير قابلة للتعديل | لا UPDATE على المحتوى |
| 8 | لا تفعيل تلقائي | `approve:true` مع فحص ناجح للبصمة نفسها، وإقرار صريح عند وجود ملاحظات. المهارات التنفيذية تُرفض حتى تُثبت بوابات M7 |
| 9 | كل استعلام مقيد بالمالك | اختبار عزل مالكين لكل مسار |
| 10 | فشل التحقق يوقف التنفيذ | لا fallback إلى المضيف أو إلى نوع أدنى بصمت |

### دورة الحياة

`quarantined → inspected → tested → benchmarked → active → (deprecated | revoked)`

مسارات خروج: `rejected`، و`incompatible` لما لا يمكن تشغيله، و`stale` عند انجراف الجودة.

## 5. العقد

`SkillContractSchema` كائن `strict`:

| الحقل | المعنى |
|---|---|
| `slug`, `name`, `description`, `version`, `category` | الهوية |
| `level` | `instruction` أو `tool` أو `executable` |
| `origin` | `builtin` أو `custom` أو `local_import` أو `forge` |
| `inputs`, `outputs` | مخططات مسماة وأساس الربط بين العقد |
| `steps` | عقد التنفيذ لنوعي `tool` و`executable` |
| `requires.tools`, `requires.scopes`, `requires.paths` | ما تطلبه صراحة |
| `sideEffects` | `none`, `read`, `write_local`, `external`, `financial` |
| `execution` | `entry`, `timeoutMs`, `memoryMb`, `outputMaxBytes`، ولا يتجاوز سقوف النظام |
| `retry`, `idempotent` | شرط إعادة المحاولة |
| `rollback` | `none` أو `restore_preimage` أو `manual` مع وصف |
| `verification` | شرط تحقق مستقل عن المهارة نفسها |
| `conflicts`, `dependsOn` | علاقات صريحة |

مهارة دون عقد صريح تأخذ `level:instruction` بلا أدوات. لا يُرفع المستوى إلا بعقد وفحص ومنحة.

`SkillExecutionReceiptSchema` يسجل `level` الفعلي، فلا يمكن تقديم تشغيل تعليمات كتنفيذ.

## 6. قاعدة البيانات

ترحيل في `packages/skills/src/migration.ts` بقفل `pg_advisory_xact_lock(1846021108)` بنمط `memoryMigration`. لا يتغير أي جدول قائم.

| الترحيل | الجداول |
|---|---|
| `015_skill_registry` | `skill_families`, `skill_versions`, `skill_files`, `skill_sources`, `skill_activations`, `skill_audit` |
| `016_skill_security` | `skill_inspections`, `skill_grants` |
| `017_skill_runs` | `skill_runs`, `skill_run_nodes`, `skill_evidence`, `skill_circuit_state`, `skill_file_preimages` |
| `018_skill_gaps` | `skill_gaps` |
| `019_skill_graph` | `skill_edges` |
| `020_skill_eval` | `skill_benchmarks`, `skill_benchmark_runs`, `skill_quality_snapshots` |
| `021_skill_forge` | `skill_candidates`, `skill_experiments` |

قيود أساسية: `UNIQUE(owner_id,slug)`، و`UNIQUE(family_id,version)`، و`UNIQUE(owner_id,content_hash)`، و`UNIQUE(run_id,node_id)`. عقد التشغيل تحمل `lease_token` و`lease_expires_at` و`attempt`. `skill_evidence` إلحاقي، ويحمل نوع الدليل والبصمة ومرجع المشاهدة أو المهمة أو الملف. `skill_grants` ترتبط ببصمة الإصدار، فلا تنتقل إلى إصدار جديد.

## 7. الواجهات البرمجية

GET وPOST فقط، وتستخدم `owner(request)`، وتتطلب الكتابة `expectedRevision`.

| المسار | العملية | المرحلة |
|---|---|---|
| GET `/api/skills`, `/api/skills/:id` | السجل والتفاصيل | M1 |
| POST `/api/skills/import` | استيراد مجلد محلي إلى الحجر؛ يأخذ مساراً فلا يحتاج رفع حد الوكيل | M2 |
| POST `/api/skills/:id/inspect` | فحص ثابت | M2 |
| POST `/api/skills/:id/grants`, `/grants/:grantId/revoke` | منح وإلغاء | M2 |
| POST `/api/skills/:id/activate`, `/revoke`, `/rollback` | دورة الحياة | M2 |
| POST `/api/skills/compose/validate` | فحص خطة | M3 |
| POST `/api/skills/:id/run` | بدء تشغيل عبر مهمة `skill.run` | M5 |
| GET `/api/skills/runs/:id`, `/runs/:id/evidence` | الحالة والأدلة | M5 |
| POST `/api/skills/runs/:id/cancel` | إلغاء | M5 |
| POST `/api/skills/runs/:id/rollback` | استعادة الملفات من الصور السابقة | M6 |
| GET `/api/skills/sandbox` | حالة البوابات G1–G8 | M7 |
| GET `/api/skills/gaps`, `/graph`, `/portfolio`, `/evolution` | القراءة التحليلية | M9–M13 |
| POST `/api/skills/:id/benchmark`, `/forge/candidates`, `/forge/:id/promote` | القياس وForge | M11–M12 |

## 8. خطة التنفيذ ملفاً بملف

كل مرحلة تنتهي بـ`npm run typecheck` و`npm test` دون فشل جديد، ثم تحقق مستقل وcommit محلي، ولا تبدأ التالية قبل ذلك.

### M0 — خط الأساس (منفذ)

| الملف | التغيير |
|---|---|
| `packages/sandbox/src/index.ts` | `powerShellPath` يستخدم Windows PowerShell في `System32` |
| `packages/sandbox/native/Runner.cs` | توافق C# 5، ورفض السياق المحزّم، وبقاء شرط `capabilityCount==0` |
| `docs/IMPLEMENTATION-STATUS.md` | تسجيل خط الأساس |

**القبول:** تعود اختبارات AppContainer الثلاثة وملفاتها الأربعة إلى النجاح دون تخفيف أي شرط، ويعود `coding.available`.

### M1 — العقود والسجل (منفذ)

| الملف | التغيير |
|---|---|
| `packages/contracts/src/skills.ts` | جديد: `SkillCategorySchema`, `SkillContractSchema`, `SkillVersionSchema`, `SkillExecutionReceiptSchema`, `SkillAuditEventSchema` |
| `packages/contracts/src/index.ts` | `export * from './skills'` |
| `packages/skills/package.json`, `src/index.ts` | جديد: `createSkillControl` |
| `packages/skills/src/migration.ts` | جديد: `skillsMigration` |
| `packages/skills/src/registry.ts`, `legacy.ts` | جديد: البحث والتدقيق ومُكيّف `checklist-router` |
| `packages/skills/src/builtin/*` | جديد: مهارات موسومة `custom` |
| `apps/server/src/skills.ts` | جديد: `registerSkillRoutes` |
| `apps/server/src/app.ts`, `apps/worker/src/index.ts` | التسجيل والترحيل |

**اختبارات:** `packages/skills/src/registry.test.ts`, `tests/skills-api.test.ts`.
**القبول:** عزل المالك، ورفض العقود غير الصالحة، والبحث، وبقاء `/api/memory/skills/*` بلا تغيير.

### M2 — الأمان والاستيراد (منفذ)

| الملف | التغيير |
|---|---|
| `packages/skills/src/frontmatter.ts` | جديد: محلل صارم، لأن مكتبة YAML غير مثبتة |
| `packages/skills/src/importer.ts` | جديد: `importLocalSkill` عبر `canonicalDirectory`, `assertNoLinks`, `boundedText`, `credentialLike` |
| `packages/skills/src/inspector.ts` | جديد: تصنيف الملفات، وفحص ثابت للسكربتات، وأنماط حقن التعليمات، وتحديد `level` |
| `packages/skills/src/grants.ts` | جديد: منح مرتبطة بالبصمة والمدة |
| `packages/skills/src/lifecycle.ts` | جديد: الانتقالات والتفعيل والتراجع |
| `packages/coding/src/index.ts` | تصدير المساعدات عند الحاجة |

**اختبارات:** `importer.test.ts`, `inspector.test.ts`, `tests/skills-security.test.ts` مع حزم خبيثة في `tests/fixtures/skills/`.
**القبول:** رفض الروابط والخروج من المسار والملفات الثنائية وتجاوز الحدود. لا تعمل أي شيفرة أثناء الاستيراد والفحص. تفعيلان متزامنان ينتهيان بواحد ناجح و`409`.

### M3 — التركيب والصلاحية والتعارض (منفذ)

| الملف | التغيير |
|---|---|
| `packages/skills/src/permissions.ts` | جديد: `buildPermissionSnapshot` من القدرات والتكاملات والمنح وحالة العزل |
| `packages/skills/src/composer.ts` | جديد: `composeSkillGraph` بفحص الدورات والأنواع |
| `packages/skills/src/conflicts.ts` | جديد: تعارضات التعليمات والموارد والأدوات |
| `packages/skills/src/planner.ts` | جديد: `validateComposition` يجمع البنية والتعارض والصلاحية دون تنفيذ |

**اختبارات:** `composer.test.ts`, `conflicts.test.ts`, `tests/skills-compose.test.ts`.
**القبول:** رفض أي خطة تحتاج أداة غير متاحة أو منحة ناقصة، مع سبب محدد قبل التنفيذ.

### M4 — التوجيه والسياق: النوع الأول يعمل

| الملف | التغيير |
|---|---|
| `packages/skills/src/router.ts`, `compiler.ts`, `preload.ts` | جديد: الاختيار والتجميع والتحميل المسبق دون تنفيذ |
| `apps/server/src/assistant/brain.ts` | `skills` في `PromptInput`، وأداة `load_skill`، وحجز الميزانية قبل القص |
| `apps/server/src/command-chat.ts` | `skillContext` وتنفيذ `load_skill` في `perform` |
| `apps/server/src/app.ts`, `apps/worker/src/index.ts` | تمرير السياق |
| `apps/server/src/config.ts`, `.env.example` | `SKILL_ENGINE_ENABLED` عند أول استخدام فعلي له |

**اختبارات:** `compiler.test.ts`, `router.test.ts`, وإضافات إلى `tests/assistant-brain.test.ts` و`tests/assistant-flow.test.ts`.
**القبول:** لا تصل نصوص غير `active`. تبقى الصفحة وسطر الخطوة في الموجه. الموجه مطابق حرفياً عند عدم وجود مهارة. حقن داخل SKILL.md لا يوسع الأدوات ولا يتجاوز `sensitiveAction`.

### M5 — الجدولة وToolGateway: النوع الثاني يعمل

| الملف | التغيير |
|---|---|
| `packages/skills/src/tools/gateway.ts` | جديد: `ToolGateway`، يتحقق من العقد والمنحة والمخطط |
| `packages/skills/src/scheduler.ts` | جديد: `runSkillGraph` و`claimNode` بنمط `skipLocked` وfencing |
| `packages/skills/src/evidence.ts` | جديد: تسجيل الأدلة |
| `apps/server/src/skill-tools.ts` | جديد: مُكيّفات الأدوات من §2 |
| `apps/server/src/skill-files.ts` | جديد: `file.read` و`file.write` مع الصورة السابقة |
| `packages/contracts/src/index.ts` | `skill.run` في `CreateTaskSchema` |
| `packages/runtime/src/index.ts` | قدرة `skill.run`، و`runSkillGraph` في `RuntimeOptions` |
| `apps/server/src/assistant/brain.ts`, `command-chat.ts` | أداة `run_skill` |
| `apps/server/src/app.ts`, `apps/worker/src/index.ts` | الربط |

**اختبارات:** `gateway.test.ts`, `scheduler.test.ts`, `tests/skills-tools.test.ts`, `tests/skills-concurrency.test.ts`.
**القبول:** رفض أداة خارج العقد. عاملان لا ينفذان العقدة نفسها. الكتابة تتوقف عند موافقة المهمة الفرعية. الملف خارج الجذور المسموحة يُرفض.

### M6 — التعافي

| الملف | التغيير |
|---|---|
| `packages/skills/src/fallback.ts`, `circuit.ts` | جديد: `decideRecovery` وقاطع الدائرة |
| `packages/skills/src/rollback.ts` | جديد: استعادة الصور السابقة بعد مطابقة البصمة |
| `packages/skills/src/scheduler.ts` | استعادة leases المنتهية |

**القواعد:** إعادة المحاولة للعقد `idempotent` فقط وبحد أقصى. الأثر الخارجي غير المحسوم يصبح `unknown` ويتوقف لقرارك. لا إعادة تلقائية لطلب نموذج مدفوع غير محسوم.

**اختبارات:** `tests/skills-recovery.test.ts` بقتل العامل بين الخطوات.
**القبول:** لا يتكرر الأثر الجانبي بعد إعادة التشغيل، والتراجع يعيد الملف، ويرفض الكتابة فوق تغيير لاحق.

### M7 — تقوية العزل: بوابات النوع الثالث

| الملف | التغيير |
|---|---|
| `packages/sandbox/native/Runner.cs` | قيود UI، وحد كتابة Job، وتجربة LPAC، ومعالجة طلب `script` |
| `packages/sandbox/native/run.ps1` | تمرير الوضع والحدود |
| `packages/sandbox/src/index.ts` | `runScript` في `SandboxRunner`، وجمع `outputs`، ومراقب الحجم، والبوابات |
| `packages/sandbox/src/gates.ts` | جديد: `verifyExecutableGates` |
| `tests/sandbox-escape.test.ts` | جديد: اختبارات التدقيق محوّلة إلى مجموعة دائمة |
| `docs/ISOLATION.md` | النتائج بعد التقوية |

**القبول:** اجتياز G1–G8 باختبارات فعلية. قنبلة قرص تتوقف عند الحد المعلن. لا يتراجع مسار `run` الحالي. فشل أي بوابة يترك `executable` معطلاً، وتستمر بقية الأنواع.

### M8 — المهارات التنفيذية: النوع الثالث يعمل

| الملف | التغيير |
|---|---|
| `packages/skills/src/executor.ts` | جديد: `runExecutableNode` يستدعي `runScript` |
| `packages/skills/src/scheduler.ts` | دعم عقدة `script` |
| `apps/server/src/app.ts`, `apps/worker/src/index.ts` | تمرير `sandbox` |

المدخلات تُنسخ إلى النسخة ولا تُربط. المخرجات تُخزن في `skill_evidence`، ولا تصل إلى ملف حقيقي إلا عبر `file.write` بموافقة.

**اختبارات:** `executor.test.ts`, `tests/skills-executable.test.ts`.
**القبول:** تعديل بايت في السكربت يمنع التشغيل. انتهاء المهلة وتجاوز الذاكرة والمخرجات الضخمة والخروج بكود فاشل تُسجَّل كفشل مع دليل. لا يوجد مسار تشغيل عند فشل البوابات.

### M9 — كشف الفجوات

`packages/skills/src/gaps.ts` جديد: `classifyGap` بالتصنيفات `missing_skill`, `missing_tool`, `missing_permission`, `model_limitation`, `invalid_plan`, `stale_data`, `environment_failure`. يسجل `command-chat.ts` التصنيف عند `blocked` و`partial`.

**القبول:** حالة ثابتة لكل تصنيف، واختبارات فصل بين الأسباب المتشابهة.

### M10 — رسم المعرفة

`packages/skills/src/graph.ts` جديد: `rebuildSkillGraph` و`relatedSkills`، بجدول حواف SQL واحد، ويستخدمه `router.ts`.

**القبول:** إعادة بناء متطابقة، وعدم عبور حدود المالك، وتوسيع محدود العمق.

### M11 — التقييم والمحفظة

| الملف | التغيير |
|---|---|
| `packages/skills/src/benchmark.ts`, `quality.ts`, `portfolio.ts` | جديد |
| `scripts/check-skills.ts` | جديد: فحص حي بـ`--live`، خارج `npm test` |
| `tests/fixtures/skills/benchmarks/*` | حالات القياس |

**القبول:** تقرير يقارن الأساس بالمرشح من تشغيل محفوظ، وقياس النجاح والتحقق والتعافي والتراجعات والتكلفة والزمن والأمان. معايير الترقية المبدئية: سلامة 100%، ولا تراجعات، وholdout لا يقل عن 85%.

### M12 — Skill Forge 2.0

`packages/skills/src/forge.ts` جديد: مرشحون وطفرات معزولة وترقية وتراجع. المرشح يدخل من `quarantined`، ولا يمكنه تفعيل نفسه.

**القبول:** الترقية تتطلب قياساً مستقلاً وموافقة، والتراجع يعيد الإصدار السابق.

### M13 — اللوحة

| الملف | التغيير |
|---|---|
| `apps/web/components/skill-library.tsx` | جديد: `SkillLibrary` بـChakra |
| `apps/web/components/capability-evolution.tsx` | جديد: `CapabilityEvolution` |
| `apps/web/components/workspace.tsx` | `View` جديدة `skills` |
| `apps/web/components/memory-workspace.tsx` | رابط إلى المكتبة، ويبقى التبويب الحالي |

تعرض شارة واضحة لكل مهارة: «تعليمات فقط» أو «تنفذ عبر الأدوات» أو «تنفيذية معزولة»، مع مستوى العزل الفعلي. وتغطي الحالات: تحميل، فراغ، خطأ، عدم اتصال، رفض صلاحية، غير صالحة، متعارضة، غير متوافقة، ملغاة، تعطل عامل، تنفيذ منقطع، ذاكرة قديمة، وتعافٍ.

**اختبارات:** `tests/e2e/skills.spec.ts` بعرض الكمبيوتر والهاتف.
**القبول:** المقاييس من بيانات فعلية فقط، و«لا توجد بيانات كافية» عند نقصها، ولا تمرير أفقي بعرض 390px.

## 9. معايير القبول الختامية

تُنفذ من واجهة التطبيق أو `scripts/check-skills.ts --live`، على مهارات مستوردة من مجلد محلي، ولا تكفي الاختبارات المحقونة.

**السيناريو A — متكامل مع الأدوات (بعد M6).** مهارة `page-evidence-report` مستوردة:
1. تفتح موقعاً عاماً حقيقياً عبر `browser.open`، وتأخذ مشاهدة ولقطة.
2. تلخص المحتوى عبر النموذج.
3. تكتب تقريراً إلى ملف حقيقي داخل جذر مسموح بعد موافقتك.
4. يبقى الناتج ملفاً حقيقياً، مع أدلة تشمل المشاهدة واللقطة والبصمات والموافقة والنموذج.
5. قتل العامل بين الخطوتين 2 و3 لا يكرر الفتح ولا الكتابة، والتراجع يعيد الملف السابق.

**السيناريو B — تنفيذي (بعد M8).** مهارة `csv-profile` مستوردة بسكربت Node:
1. يعالج ملف CSV حقيقياً داخل العزل وينتج ملخصاً.
2. تسجل الأدلة بصمة السكربت والمدخلات والمخرجات وحالة البوابات ونوع العزل والمدة وكود الخروج.
3. نسخة خبيثة منها تحاول قراءة `.env`، والاتصال، وملء القرص، وإنشاء عملية؛ فتفشل جميعها وتُسجَّل دون أثر على المضيف.
4. انتهاء المهلة يعود بفشل آمن قابل لإعادة التشغيل.

**السيناريو C — صدق التوصيف.** مهارة تعليمات تعرض «تعليمات فقط»، وإيصالها `level:instruction`، ومحاولة تقديمها كتنفيذية يرفضها المخطط.

## 10. تغطية المتطلبات

### مكتبة v5.0

| # | المتطلب | الحالة |
|---|---|---|
| 1، 2 | تصنيف مستودعات GitHub | مؤجل بطلبك |
| 3 | السجل | M1 |
| 4 | البصمات والإصدارات والتراجع | M1 وM2؛ تثبيت commit مؤجل |
| 5 | الاستيراد والحجر | M2 |
| 6 | الربط | M4 وM5؛ Model Router القائم يبقى |
| 7 | مهارات مخصصة | M1 |
| 8 | المتصفح | M5 |
| 9 | التصميم | M5 عبر الاستوديو؛ **تحرير الصور بلا أداة** |
| 10 | اللغات والمستندات | النموذج و`file.*`؛ **تحويل الصيغ بلا أداة** |
| 11 | الأعمال وGoogle Ads | عبر المتصفح والموافقات؛ لا Ads API |
| 12 | الكمبيوتر | M5 عبر منح Windows بعد ربط جهاز؛ iPhone مؤجل |
| 13 | القياس | M11 |
| 14 | تحميل المناسب فقط | M4 |
| 15 | لا تنفيذ غير موثوق ولا اعتمادات | §4 وM7 |
| 16 | اللوحة | M13 |
| 17 | العقود والتدقيق | M1 وكل مرحلة |
| 18 | الحالات | M13 |
| 19 | التوافق | كل مرحلة؛ iPhone مؤجل |
| 20 | التحقق المستقل | M11 و§9 |

### Skill Engine 6.1

| # | المكون | المرحلة | # | المكون | المرحلة |
|---|---|---|---|---|---|
| 1 | التدقيق | M0 | 11 | الجودة والانجراف | M11 |
| 2 | العقد الموحد | M1 | 12 | المحفظة | M11 |
| 3 | التركيب | M3 | 13 | Forge 2.0 | M12 |
| 4 | التخطيط بالصلاحية | M3 | 14 | لوحة التطور | M13 |
| 5 | حل التعارض | M3 | 15 | التوافق | كل مرحلة |
| 6 | كشف الفجوات | M9 | 16 | العقود والترحيلات | M1 ولاحقاً |
| 7 | مُجمّع السياق | M4 | 17 | الحالات | M13 |
| 8 | رسم المعرفة | M10 | 18 | منع التكرار والسباقات | M5 وM6 |
| 9 | التعافي | M6 | 19 | الاختبارات | كل مرحلة |
| 10 | التحميل المسبق | M4 | 20 | الأدلة والتراجع | M11 و§12 |

## 11. الاعتماديات

```text
M0 → M1 → M2 → M3 ─┬─ M4 ──────────┐
                   └─ M5 → M6 ─┬─ M9 → M10 → M11 → M12 → M13
                               └─ M7 → M8 ─┘
```

M7 وM8 لا يعطلان بقية المسار. إن تعذرت بوابة، يستمر المحرك بالنوعين الأول والثاني ويبقى الثالث معطلاً ومعلناً عنه.

## 12. التراجع

- كل مرحلة في commit محلي مستقل.
- `SKILL_ENGINE_ENABLED=false` يعيد الموجه إلى شكله الحالي ويرفض `skill.run`.
- `executable` يتعطل تلقائياً عند فشل البوابات.
- تراجع مهارة بإعادة إصدار مقاس سابق، وتراجع تشغيل باستعادة الصور السابقة.
- الترحيلات إضافية، والتراجع عنها بحذف جداول `skill_*` بعد نسخة احتياطية.

## 13. المخاطر

| الخطر | المعالجة |
|---|---|
| ثغرة نواة تتجاوز AppContainer | قيد معلن؛ مراجعة السكربت وموافقتك شرط، والتفعيل لكل بصمة |
| حد كتابة Job قد لا يكفي وحده | مراقب حجم ثانٍ، واختبار قنبلة قرص شرط البوابة |
| LPAC قد يكسر Node | بوابة G5 اختيارية، وتُسجَّل النتيجة كما هي |
| `--permission` في Node ليس حداً أمنياً كاملاً | طبقة إضافية فوق حد النظام، وليس بديلاً عنه |
| تعديل `Runner.cs` يمس Coding Lab | اختبارات AppContainer الحالية شرط قبول M0 وM7 |
| كشف الحقن إرشادي | الحماية الفعلية هي الثوابت والموافقات |
| موافقة الأفعال الحساسة تعتمد على اسم الزر | قيد قائم في README، و`sideEffects` تفرض موافقة مستقلة لعقد المهارات |
| Windows `computer.*` لا يمكن اختباره بلا جهاز | يبقى `needs_configuration` ولا يُدّعى عمله |
| عينات القياس صغيرة | تُعرض أعدادها، ولا تُقدم كدليل عام |
