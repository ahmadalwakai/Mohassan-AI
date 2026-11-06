# جرد ملفات Skill Engine مقارنة بنقطة البداية

جرد نهائي بتاريخ 2026-11-05T09:38:32.071098+00:00 بعد تثبيت المصدر والواجهة والاختبارات والوثائق ونتيجة التحقق التكميلي.

المقارنة مع [artifacts/skill-engine-completion/baseline/manifest.json](<../artifacts/skill-engine-completion/baseline/manifest.json>) تشمل 213 ملفًا محفوظًا قبل التعديل. استُخدمت بصمات SHA256 للبايتات الفعلية، وتحققت سلامة جميع نسخ الرجوع. حالة Git وصف مستقل وليست دليلًا على صاحب التعديل.

| التصنيف | العدد |
|---|---:|
| ملفات موجودة تغيرت بعد نقطة البداية | 62 |
| ملفات جديدة، باستثناء ملفي هذا الجرد | 111 |
| ملفات محذوفة | 0 |
| ملفات من نسخة البداية لم تتغير | 151 |
| ملفا الجرد المستثنيان من البصمات الذاتية | 2 |

## التغييرات السابقة للمستخدم

- .env.example وdocs/IMPLEMENTATION-STATUS.md كانا معدّلين قبل هذه المهمة ثم أضيفت إليهما تعديلات المهمة. نسخ الرجوع تحفظ تعديلات المستخدم السابقة؛ لا تُستبدل تلقائيًا بنسخة HEAD.
- apps/web/next-env.d.ts ما زال مطابقًا للبداية بايتًا ببايت رغم ظهوره M في Git. **لا يُنسب إلى تغييرات هذه المهمة.** بصمته السابقة والحالية: 0f70629890b72a0a82e91972cc032c04b658b26c265373cb711cf576bfbf8fcc.
- دليل الحالة السابقة: [artifacts/skill-engine-completion/verification-log.md](<../artifacts/skill-engine-completion/verification-log.md>)، فقرة Baseline before source edits.
- .gitignore وinstractions and plan.txt خارج نسخة البداية؛ كلاهما متتبع ولا يظهر كتغيير في Git المحلي. لا يُدرجان ضمن تعديلات المهمة.

## ملفات موجودة عُدلت بعد نقطة البداية

### إعدادات الجذر

- [.env.example](<../.env.example>) — يتضمن تعديلات مستخدم سابقة محفوظة في baseline
- [playwright.config.ts](<../playwright.config.ts>)

### الخادم

- [apps/server/src/ai.ts](<../apps/server/src/ai.ts>)
- [apps/server/src/app.ts](<../apps/server/src/app.ts>)
- [apps/server/src/assistant/brain.ts](<../apps/server/src/assistant/brain.ts>)
- [apps/server/src/assistant/vault.ts](<../apps/server/src/assistant/vault.ts>)
- [apps/server/src/browser-task.ts](<../apps/server/src/browser-task.ts>)
- [apps/server/src/coding.ts](<../apps/server/src/coding.ts>)
- [apps/server/src/command-chat.ts](<../apps/server/src/command-chat.ts>)
- [apps/server/src/config.ts](<../apps/server/src/config.ts>)
- [apps/server/src/skills.ts](<../apps/server/src/skills.ts>)
- [apps/server/src/studio-ai.ts](<../apps/server/src/studio-ai.ts>)

### واجهة الويب

- [apps/web/components/memory-workspace.tsx](<../apps/web/components/memory-workspace.tsx>)
- [apps/web/components/workspace.tsx](<../apps/web/components/workspace.tsx>)

### العامل

- [apps/worker/src/index.ts](<../apps/worker/src/index.ts>)

### الحزم

- [packages/browser/src/agent-browser.ts](<../packages/browser/src/agent-browser.ts>)
- [packages/coding/src/engine.ts](<../packages/coding/src/engine.ts>)
- [packages/coding/src/security.ts](<../packages/coding/src/security.ts>)
- [packages/cognitive/src/engine.test.ts](<../packages/cognitive/src/engine.test.ts>)
- [packages/cognitive/src/index.ts](<../packages/cognitive/src/index.ts>)
- [packages/contracts/src/index.ts](<../packages/contracts/src/index.ts>)
- [packages/contracts/src/skills.ts](<../packages/contracts/src/skills.ts>)
- [packages/database/src/index.ts](<../packages/database/src/index.ts>)
- [packages/database/src/records.ts](<../packages/database/src/records.ts>)
- [packages/providers/src/groq-safety.test.ts](<../packages/providers/src/groq-safety.test.ts>)
- [packages/providers/src/index.ts](<../packages/providers/src/index.ts>)
- [packages/runtime/src/index.ts](<../packages/runtime/src/index.ts>)
- [packages/sandbox/native/Runner.cs](<../packages/sandbox/native/Runner.cs>)
- [packages/sandbox/native/run.ps1](<../packages/sandbox/native/run.ps1>)
- [packages/sandbox/src/index.ts](<../packages/sandbox/src/index.ts>)
- [packages/sandbox/src/sandbox.test.ts](<../packages/sandbox/src/sandbox.test.ts>)
- [packages/skills/src/composer.test.ts](<../packages/skills/src/composer.test.ts>)
- [packages/skills/src/composer.ts](<../packages/skills/src/composer.ts>)
- [packages/skills/src/hash.ts](<../packages/skills/src/hash.ts>)
- [packages/skills/src/importer.test.ts](<../packages/skills/src/importer.test.ts>)
- [packages/skills/src/importer.ts](<../packages/skills/src/importer.ts>)
- [packages/skills/src/index.ts](<../packages/skills/src/index.ts>)
- [packages/skills/src/inspector.test.ts](<../packages/skills/src/inspector.test.ts>)
- [packages/skills/src/inspector.ts](<../packages/skills/src/inspector.ts>)
- [packages/skills/src/lifecycle.ts](<../packages/skills/src/lifecycle.ts>)
- [packages/skills/src/migration.ts](<../packages/skills/src/migration.ts>)
- [packages/skills/src/permissions.ts](<../packages/skills/src/permissions.ts>)
- [packages/skills/src/planner.ts](<../packages/skills/src/planner.ts>)
- [packages/skills/src/registry.test.ts](<../packages/skills/src/registry.test.ts>)
- [packages/skills/src/registry.ts](<../packages/skills/src/registry.ts>)

### سكربتات التطوير والتحقق

- [scripts/e2e-server.mjs](<../scripts/e2e-server.mjs>)

### الاختبارات وملفاتها الثابتة

- [tests/assistant-brain.test.ts](<../tests/assistant-brain.test.ts>)
- [tests/assistant-flow.test.ts](<../tests/assistant-flow.test.ts>)
- [tests/browser-task.test.ts](<../tests/browser-task.test.ts>)
- [tests/e2e/assistant.spec.ts](<../tests/e2e/assistant.spec.ts>)
- [tests/e2e/browser.spec.ts](<../tests/e2e/browser.spec.ts>)
- [tests/e2e/memory.spec.ts](<../tests/e2e/memory.spec.ts>)
- [tests/e2e/server-entry.ts](<../tests/e2e/server-entry.ts>)
- [tests/e2e/studio-ai.spec.ts](<../tests/e2e/studio-ai.spec.ts>)
- [tests/e2e/windows.spec.ts](<../tests/e2e/windows.spec.ts>)
- [tests/fixtures/planning.ts](<../tests/fixtures/planning.ts>)
- [tests/sandbox-control-plane.test.ts](<../tests/sandbox-control-plane.test.ts>)
- [tests/skills-compose.test.ts](<../tests/skills-compose.test.ts>)
- [tests/skills-security.test.ts](<../tests/skills-security.test.ts>)

### التوثيق

- [docs/IMPLEMENTATION-STATUS.md](<../docs/IMPLEMENTATION-STATUS.md>) — يتضمن تعديلات مستخدم سابقة محفوظة في baseline
- [docs/ISOLATION.md](<../docs/ISOLATION.md>)
- [docs/SKILL-ENGINE-PLAN.md](<../docs/SKILL-ENGINE-PLAN.md>)

## ملفات جديدة

هذه المسارات غائبة عن manifest البداية وتظهر غير متتبعة محليًا؛ لم يُعدّل فهرس Git أو تاريخه.

### الخادم

- [apps/server/src/assistant/skill-gaps.ts](<../apps/server/src/assistant/skill-gaps.ts>)
- [apps/server/src/skill-benchmark-isolation.ts](<../apps/server/src/skill-benchmark-isolation.ts>)
- [apps/server/src/skill-benchmark-runner.ts](<../apps/server/src/skill-benchmark-runner.ts>)
- [apps/server/src/skill-benchmark-worker.ts](<../apps/server/src/skill-benchmark-worker.ts>)
- [apps/server/src/skill-benchmarks.ts](<../apps/server/src/skill-benchmarks.ts>)
- [apps/server/src/skill-forge.ts](<../apps/server/src/skill-forge.ts>)
- [apps/server/src/skill-gaps.ts](<../apps/server/src/skill-gaps.ts>)
- [apps/server/src/skill-graph.ts](<../apps/server/src/skill-graph.ts>)
- [apps/server/src/skill-portfolio.ts](<../apps/server/src/skill-portfolio.ts>)
- [apps/server/src/skill-rollback.ts](<../apps/server/src/skill-rollback.ts>)
- [apps/server/src/skill-runs.ts](<../apps/server/src/skill-runs.ts>)
- [apps/server/src/skill-runtime.ts](<../apps/server/src/skill-runtime.ts>)
- [apps/server/src/skill-sandbox.ts](<../apps/server/src/skill-sandbox.ts>)
- [apps/server/src/skill-tools.ts](<../apps/server/src/skill-tools.ts>)

### واجهة الويب

- [apps/web/components/capability-evolution.module.css](<../apps/web/components/capability-evolution.module.css>)
- [apps/web/components/capability-evolution.tsx](<../apps/web/components/capability-evolution.tsx>)
- [apps/web/components/skill-client.ts](<../apps/web/components/skill-client.ts>)
- [apps/web/components/skill-experiments.tsx](<../apps/web/components/skill-experiments.tsx>)
- [apps/web/components/skill-library.module.css](<../apps/web/components/skill-library.module.css>)
- [apps/web/components/skill-library.tsx](<../apps/web/components/skill-library.tsx>)

### الحزم

- [packages/coding/src/security.test.ts](<../packages/coding/src/security.test.ts>)
- [packages/contracts/src/skill-benchmarks.ts](<../packages/contracts/src/skill-benchmarks.ts>)
- [packages/contracts/src/skill-forge.ts](<../packages/contracts/src/skill-forge.ts>)
- [packages/contracts/src/skill-gaps.ts](<../packages/contracts/src/skill-gaps.ts>)
- [packages/contracts/src/skill-graph.ts](<../packages/contracts/src/skill-graph.ts>)
- [packages/contracts/src/skill-quality.ts](<../packages/contracts/src/skill-quality.ts>)
- [packages/contracts/src/skill-run-gaps.ts](<../packages/contracts/src/skill-run-gaps.ts>)
- [packages/contracts/src/skill-sandbox.ts](<../packages/contracts/src/skill-sandbox.ts>)
- [packages/providers/src/retry.test.ts](<../packages/providers/src/retry.test.ts>)
- [packages/providers/src/retry.ts](<../packages/providers/src/retry.ts>)
- [packages/runtime/src/skill-runtime.test.ts](<../packages/runtime/src/skill-runtime.test.ts>)
- [packages/sandbox/src/gates.ts](<../packages/sandbox/src/gates.ts>)
- [packages/sandbox/src/network-probe.test.ts](<../packages/sandbox/src/network-probe.test.ts>)
- [packages/sandbox/src/network-probe.ts](<../packages/sandbox/src/network-probe.ts>)
- [packages/sandbox/src/script.ts](<../packages/sandbox/src/script.ts>)
- [packages/sandbox/src/side-channel-probe.ts](<../packages/sandbox/src/side-channel-probe.ts>)
- [packages/skills/src/benchmark-suites.test.ts](<../packages/skills/src/benchmark-suites.test.ts>)
- [packages/skills/src/benchmark-suites.ts](<../packages/skills/src/benchmark-suites.ts>)
- [packages/skills/src/benchmark.test.ts](<../packages/skills/src/benchmark.test.ts>)
- [packages/skills/src/benchmark.ts](<../packages/skills/src/benchmark.ts>)
- [packages/skills/src/circuit.test.ts](<../packages/skills/src/circuit.test.ts>)
- [packages/skills/src/circuit.ts](<../packages/skills/src/circuit.ts>)
- [packages/skills/src/compiler.test.ts](<../packages/skills/src/compiler.test.ts>)
- [packages/skills/src/compiler.ts](<../packages/skills/src/compiler.ts>)
- [packages/skills/src/evidence.ts](<../packages/skills/src/evidence.ts>)
- [packages/skills/src/execution-authority.ts](<../packages/skills/src/execution-authority.ts>)
- [packages/skills/src/fallback.test.ts](<../packages/skills/src/fallback.test.ts>)
- [packages/skills/src/fallback.ts](<../packages/skills/src/fallback.ts>)
- [packages/skills/src/file-tools.test.ts](<../packages/skills/src/file-tools.test.ts>)
- [packages/skills/src/file-tools.ts](<../packages/skills/src/file-tools.ts>)
- [packages/skills/src/forge-promotion.test.ts](<../packages/skills/src/forge-promotion.test.ts>)
- [packages/skills/src/forge-promotion.ts](<../packages/skills/src/forge-promotion.ts>)
- [packages/skills/src/forge.test.ts](<../packages/skills/src/forge.test.ts>)
- [packages/skills/src/forge.ts](<../packages/skills/src/forge.ts>)
- [packages/skills/src/gaps.test.ts](<../packages/skills/src/gaps.test.ts>)
- [packages/skills/src/gaps.ts](<../packages/skills/src/gaps.ts>)
- [packages/skills/src/gateway.ts](<../packages/skills/src/gateway.ts>)
- [packages/skills/src/graph-context.test.ts](<../packages/skills/src/graph-context.test.ts>)
- [packages/skills/src/graph.test.ts](<../packages/skills/src/graph.test.ts>)
- [packages/skills/src/graph.ts](<../packages/skills/src/graph.ts>)
- [packages/skills/src/hash.test.ts](<../packages/skills/src/hash.test.ts>)
- [packages/skills/src/import-store.ts](<../packages/skills/src/import-store.ts>)
- [packages/skills/src/lifecycle-lock.ts](<../packages/skills/src/lifecycle-lock.ts>)
- [packages/skills/src/portfolio.test.ts](<../packages/skills/src/portfolio.test.ts>)
- [packages/skills/src/portfolio.ts](<../packages/skills/src/portfolio.ts>)
- [packages/skills/src/preload.ts](<../packages/skills/src/preload.ts>)
- [packages/skills/src/quality.test.ts](<../packages/skills/src/quality.test.ts>)
- [packages/skills/src/quality.ts](<../packages/skills/src/quality.ts>)
- [packages/skills/src/recovery.test.ts](<../packages/skills/src/recovery.test.ts>)
- [packages/skills/src/rollback.ts](<../packages/skills/src/rollback.ts>)
- [packages/skills/src/router.test.ts](<../packages/skills/src/router.test.ts>)
- [packages/skills/src/router.ts](<../packages/skills/src/router.ts>)
- [packages/skills/src/scheduler.test.ts](<../packages/skills/src/scheduler.test.ts>)
- [packages/skills/src/scheduler.ts](<../packages/skills/src/scheduler.ts>)

### سكربتات التطوير والتحقق

- [scripts/check-skills.ts](<../scripts/check-skills.ts>)

### الاختبارات وملفاتها الثابتة

- [tests/assistant-gaps.test.ts](<../tests/assistant-gaps.test.ts>)
- [tests/assistant-safety.test.ts](<../tests/assistant-safety.test.ts>)
- [tests/e2e-isolation.test.ts](<../tests/e2e-isolation.test.ts>)
- [tests/e2e/global-setup.ts](<../tests/e2e/global-setup.ts>)
- [tests/e2e/isolation.ts](<../tests/e2e/isolation.ts>)
- [tests/e2e/skills.spec.ts](<../tests/e2e/skills.spec.ts>)
- [tests/fixtures/forge.ts](<../tests/fixtures/forge.ts>)
- [tests/fixtures/skill-browser-crash-worker.ts](<../tests/fixtures/skill-browser-crash-worker.ts>)
- [tests/fixtures/skill-crash-worker.ts](<../tests/fixtures/skill-crash-worker.ts>)
- [tests/fixtures/skills/benchmarks/file-read/SKILL.md](<../tests/fixtures/skills/benchmarks/file-read/SKILL.md>)
- [tests/fixtures/skills/benchmarks/file-read/skill.contract.json](<../tests/fixtures/skills/benchmarks/file-read/skill.contract.json>)
- [tests/fixtures/skills/benchmarks/file-write/SKILL.md](<../tests/fixtures/skills/benchmarks/file-write/SKILL.md>)
- [tests/fixtures/skills/benchmarks/file-write/skill.contract.json](<../tests/fixtures/skills/benchmarks/file-write/skill.contract.json>)
- [tests/fixtures/skills/benchmarks/instruction/SKILL.md](<../tests/fixtures/skills/benchmarks/instruction/SKILL.md>)
- [tests/fixtures/skills/benchmarks/instruction/skill.contract.json](<../tests/fixtures/skills/benchmarks/instruction/skill.contract.json>)
- [tests/fixtures/skills/benchmarks/oracles.json](<../tests/fixtures/skills/benchmarks/oracles.json>)
- [tests/forge-model-fixture.test.ts](<../tests/forge-model-fixture.test.ts>)
- [tests/helpers/skill-execution.ts](<../tests/helpers/skill-execution.ts>)
- [tests/sandbox-escape.test.ts](<../tests/sandbox-escape.test.ts>)
- [tests/skill-runs-api.test.ts](<../tests/skill-runs-api.test.ts>)
- [tests/skill-sandbox-api.test.ts](<../tests/skill-sandbox-api.test.ts>)
- [tests/skills-benchmark-api.test.ts](<../tests/skills-benchmark-api.test.ts>)
- [tests/skills-benchmark-runner.test.ts](<../tests/skills-benchmark-runner.test.ts>)
- [tests/skills-concurrency.test.ts](<../tests/skills-concurrency.test.ts>)
- [tests/skills-context.test.ts](<../tests/skills-context.test.ts>)
- [tests/skills-executable.test.ts](<../tests/skills-executable.test.ts>)
- [tests/skills-execution.test.ts](<../tests/skills-execution.test.ts>)
- [tests/skills-forge-integration.test.ts](<../tests/skills-forge-integration.test.ts>)
- [tests/skills-gap-integration.test.ts](<../tests/skills-gap-integration.test.ts>)
- [tests/skills-gateway.test.ts](<../tests/skills-gateway.test.ts>)
- [tests/skills-graph-integration.test.ts](<../tests/skills-graph-integration.test.ts>)
- [tests/skills-model.test.ts](<../tests/skills-model.test.ts>)
- [tests/skills-recovery.test.ts](<../tests/skills-recovery.test.ts>)
- [tests/skills-rollback.test.ts](<../tests/skills-rollback.test.ts>)
- [tests/skills-tools.test.ts](<../tests/skills-tools.test.ts>)

### التوثيق

- [docs/SKILL-ENGINE-COMPLETION.md](<../docs/SKILL-ENGINE-COMPLETION.md>)

## ملفا الجرد المستثنيان من البصمات الذاتية

- [docs/SKILL-ENGINE-FILES.md](<../docs/SKILL-ENGINE-FILES.md>) — مستند جديد؛ بلا بصمة ذاتية في البيانات.
- [artifacts/skill-engine-completion/changed-files.json](<../artifacts/skill-engine-completion/changed-files.json>) — سجل JSON جديد؛ بلا بصمة ذاتية في البيانات.

## البصمات ومصادر الرجوع

يحتوي [artifacts/skill-engine-completion/changed-files.json](<../artifacts/skill-engine-completion/changed-files.json>) على beforeSha256 وafterSha256 وحالة Git لكل ملف داخل النطاق، وrollbackSource للملفات الموجودة. الملفات الجديدة تحمل null للبصمة السابقة ومصدر الرجوع. الملفات الـ151 المطابقة للبداية في unchangedBaseline منفصلة، ولا تُعد تغييرات للمهمة.

الرجوع وصف فقط؛ لم تُنفذ استعادة أو إزالة. احفظ أي تعديل أحدث للمستخدم قبل استعادة ملف محدد من baseline. لا تستخدم حذفًا عامًا أو git reset --hard أو git clean.

## النطاق والاستثناءات

استُثنيت node_modules و.data و.git ومجلدات البناء وNext وcoverage وtest-results وplaywright-report وجميع artifacts من جرد المصدر. لم تُقرأ ملفات .env الحقيقية. اختبارات المصدر وfixtures الثابتة داخل tests مشمولة؛ نتائج تشغيل الاختبارات ليست مشمولة.

الأوامر للقراءة فقط: git --no-optional-locks status --porcelain=v1 -z --untracked-files=all وgit --no-optional-locks ls-files --cached -z. لا تُستخدم فروق HEAD أو تحويلات نهاية السطر لإسناد التغييرات.

هذه ليست لقطة ذرية لنظام الملفات. أعيدت قراءة البصمات أثناء التوليد لاكتشاف التغيير المتزامن؛ عدد الملفات المتغيرة أثناء الالتقاط: 0؛ المسارات الجديدة التي ظهرت أثناءه: 0.
