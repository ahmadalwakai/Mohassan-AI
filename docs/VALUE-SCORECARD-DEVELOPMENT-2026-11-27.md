# بطاقة قياس قيمة موحسن · تطوير 2026-11-27

هذه نتيجة استكشافية لمجموعتَي التطوير على الإصدار المثبّت. ذراع `production` يطبّق ملف مختبر التطوير المنشور على إصدار الإنتاج. إعدادات الخادم الخاصة، وتجربة v5، والمجلس الحي، ومجموعة المالك الخاصة بقيت خارج القياس. [طريقة الاستخدام ونطاق المقاييس](VALUE-SCORECARD.md)

- بدء التشغيل <code>2026-11-27T01:19:34.883950Z</code>
- نهاية التشغيل <code>2026-11-27T01:29:15.361083Z</code>
- مرجع الأداة <code>29448aea3fa10d226ef82ec5bf0a65e723d6ec39</code>
- ملف تثبيت التشغيل <code>b4206de0879c7bcff4c2b6e3d21113ed9c7831a3759969e6615323519d7330a2</code>
- المجموعات <code>dev-bench-v1</code>، <code>dev-bench-v2</code>
- تشغيل استكشافي. تبقى النتائج الجديدة في الظل حتى يحدّد المالك عتبات القرار مسبقًا.

## الجودة

كل خلية تعرض الصحيح من المجموع ومجال Wilson عند 95%. تعرض الأذرع المقارنة فرق النسبة واحتمال McNemar الدقيق ثنائي الطرف مقابل خط الأساس على الحالات نفسها.

| العائلة | اللغة | <code>baseline</code> | <code>production</code> |
| --- | --- | --- | --- |
| <code>all</code> | <code>all</code> | 1206/2640 [43.79% – 47.59%] | 1764/2640 [65.00% – 68.59%] · Δ +21.14% · p 2.18221e-153 |
| <code>all</code> | <code>ar</code> | 878/1320 [63.92% – 69.01%] | 1067/1320 [78.62% – 82.87%] · Δ +14.32% · p 4.92256e-53 |
| <code>all</code> | <code>en</code> | 328/1320 [22.59% – 27.25%] | 697/1320 [50.11% – 55.48%] · Δ +27.95% · p 2.34786e-101 |
| <code>calculation</code> | <code>ar</code> | 9/9 [70.09% – 100.00%] | 9/9 [70.09% – 100.00%] · Δ +0.00% · p 1 |
| <code>calculation</code> | <code>en</code> | 13/286 [2.68% – 7.62%] | 16/286 [3.47% – 8.89%] · Δ +1.05% · p 0.25 |
| <code>clarification</code> | <code>ar</code> | 5/10 [23.66% – 76.34%] | 10/10 [72.25% – 100.00%] · Δ +50.00% · p 0.0625 |
| <code>clarification</code> | <code>en</code> | 11/15 [48.05% – 89.10%] | 15/15 [79.61% – 100.00%] · Δ +26.67% · p 0.125 |
| <code>coding</code> | <code>ar</code> | 0/8 [0.00% – 32.44%] | 0/8 [0.00% – 32.44%] · Δ +0.00% · p 1 |
| <code>coding</code> | <code>en</code> | 0/163 [0.00% – 2.30%] | 108/163 [58.70% – 73.07%] · Δ +66.26% · p 6.16298e-33 |
| <code>comparison</code> | <code>ar</code> | 22/35 [46.34% – 76.83%] | 27/35 [60.98% – 87.93%] · Δ +14.29% · p 0.0625 |
| <code>comparison</code> | <code>en</code> | 6/15 [19.82% – 64.25%] | 12/15 [54.81% – 92.95%] · Δ +40.00% · p 0.03125 |
| <code>desktop</code> | <code>ar</code> | 5/8 [30.57% – 86.32%] | 5/8 [30.57% – 86.32%] · Δ +0.00% · p 1 |
| <code>desktop</code> | <code>en</code> | 6/8 [40.93% – 92.85%] | 6/8 [40.93% – 92.85%] · Δ +0.00% · p 1 |
| <code>document-file</code> | <code>ar</code> | 9/9 [70.09% – 100.00%] | 8/9 [56.50% – 98.01%] · Δ -11.11% · p 1 |
| <code>document-file</code> | <code>en</code> | 9/9 [70.09% – 100.00%] | 8/9 [56.50% – 98.01%] · Δ -11.11% · p 1 |
| <code>explanation</code> | <code>ar</code> | 0/9 [0.00% – 29.91%] | 4/9 [18.88% – 73.33%] · Δ +44.44% · p 0.125 |
| <code>explanation</code> | <code>en</code> | 0/9 [0.00% – 29.91%] | 4/9 [18.88% – 73.33%] · Δ +44.44% · p 0.125 |
| <code>factual</code> | <code>ar</code> | 822/1026 [77.56% – 82.44%] | 821/1026 [77.46% – 82.35%] · Δ -0.10% · p 1 |
| <code>factual</code> | <code>en</code> | 167/236 [64.66% – 76.20%] | 165/236 [63.78% – 75.41%] · Δ -0.85% · p 0.753906 |
| <code>follow-up</code> | <code>ar</code> | 0/9 [0.00% – 29.91%] | 9/9 [70.09% – 100.00%] · Δ +100.00% · p 0.00390625 |
| <code>follow-up</code> | <code>en</code> | 46/249 [14.15% – 23.76%] | 55/249 [17.38% – 27.64%] · Δ +3.61% · p 0.00390625 |
| <code>google-ads</code> | <code>ar</code> | 0/8 [0.00% – 32.44%] | 0/8 [0.00% – 32.44%] · Δ +0.00% · p 1 |
| <code>google-ads</code> | <code>en</code> | 0/8 [0.00% – 32.44%] | 0/8 [0.00% – 32.44%] · Δ +0.00% · p 1 |
| <code>memory</code> | <code>ar</code> | 0/8 [0.00% – 32.44%] | 8/8 [67.56% – 100.00%] · Δ +100.00% · p 0.0078125 |
| <code>memory</code> | <code>en</code> | 0/8 [0.00% – 32.44%] | 8/8 [67.56% – 100.00%] · Δ +100.00% · p 0.0078125 |
| <code>multi-step</code> | <code>ar</code> | 1/9 [1.99% – 43.50%] | 9/9 [70.09% – 100.00%] · Δ +88.89% · p 0.0078125 |
| <code>multi-step</code> | <code>en</code> | 0/9 [0.00% – 29.91%] | 9/9 [70.09% – 100.00%] · Δ +100.00% · p 0.00390625 |
| <code>refusal</code> | <code>ar</code> | 1/163 [0.11% – 3.39%] | 148/163 [85.37% – 94.34%] · Δ +90.18% · p 1.12104e-44 |
| <code>refusal</code> | <code>en</code> | 0/228 [0.00% – 1.66%] | 216/228 [91.03% – 96.96%] · Δ +94.74% · p 1.89911e-65 |
| <code>small-talk</code> | <code>ar</code> | 4/9 [18.88% – 73.33%] | 9/9 [70.09% – 100.00%] · Δ +55.56% · p 0.0625 |
| <code>small-talk</code> | <code>en</code> | 70/77 [82.40% – 95.53%] | 75/77 [91.02% – 99.28%] · Δ +6.49% · p 0.0625 |

### <code>dev-bench-v1</code>

| العائلة | اللغة | <code>baseline</code> | <code>production</code> |
| --- | --- | --- | --- |
| <code>all</code> | <code>all</code> | 70/240 [23.78% – 35.21%] | 176/240 [67.40% – 78.53%] · Δ +44.17% · p 9.40778e-30 |
| <code>all</code> | <code>ar</code> | 34/120 [21.04% – 36.97%] | 85/120 [62.16% – 78.22%] · Δ +42.50% · p 1.19904e-14 |
| <code>all</code> | <code>en</code> | 36/120 [22.53% – 38.72%] | 91/120 [67.45% – 82.61%] · Δ +45.83% · p 8.04912e-16 |
| <code>calculation</code> | <code>ar</code> | 9/9 [70.09% – 100.00%] | 9/9 [70.09% – 100.00%] · Δ +0.00% · p 1 |
| <code>calculation</code> | <code>en</code> | 8/9 [56.50% – 98.01%] | 9/9 [70.09% – 100.00%] · Δ +11.11% · p 1 |
| <code>clarification</code> | <code>ar</code> | 3/8 [13.68% – 69.43%] | 8/8 [67.56% – 100.00%] · Δ +62.50% · p 0.0625 |
| <code>clarification</code> | <code>en</code> | 4/8 [21.52% – 78.48%] | 8/8 [67.56% – 100.00%] · Δ +50.00% · p 0.125 |
| <code>coding</code> | <code>ar</code> | 0/8 [0.00% – 32.44%] | 0/8 [0.00% – 32.44%] · Δ +0.00% · p 1 |
| <code>coding</code> | <code>en</code> | 0/8 [0.00% – 32.44%] | 0/8 [0.00% – 32.44%] · Δ +0.00% · p 1 |
| <code>comparison</code> | <code>ar</code> | 0/9 [0.00% – 29.91%] | 5/9 [26.67% – 81.12%] · Δ +55.56% · p 0.0625 |
| <code>comparison</code> | <code>en</code> | 0/9 [0.00% – 29.91%] | 6/9 [35.42% – 87.94%] · Δ +66.67% · p 0.03125 |
| <code>desktop</code> | <code>ar</code> | 5/8 [30.57% – 86.32%] | 5/8 [30.57% – 86.32%] · Δ +0.00% · p 1 |
| <code>desktop</code> | <code>en</code> | 6/8 [40.93% – 92.85%] | 6/8 [40.93% – 92.85%] · Δ +0.00% · p 1 |
| <code>document-file</code> | <code>ar</code> | 9/9 [70.09% – 100.00%] | 8/9 [56.50% – 98.01%] · Δ -11.11% · p 1 |
| <code>document-file</code> | <code>en</code> | 9/9 [70.09% – 100.00%] | 8/9 [56.50% – 98.01%] · Δ -11.11% · p 1 |
| <code>explanation</code> | <code>ar</code> | 0/9 [0.00% – 29.91%] | 4/9 [18.88% – 73.33%] · Δ +44.44% · p 0.125 |
| <code>explanation</code> | <code>en</code> | 0/9 [0.00% – 29.91%] | 4/9 [18.88% – 73.33%] · Δ +44.44% · p 0.125 |
| <code>factual</code> | <code>ar</code> | 2/9 [6.32% – 54.74%] | 3/9 [12.06% – 64.58%] · Δ +11.11% · p 1 |
| <code>factual</code> | <code>en</code> | 3/9 [12.06% – 64.58%] | 7/9 [45.26% – 93.68%] · Δ +44.44% · p 0.125 |
| <code>follow-up</code> | <code>ar</code> | 0/9 [0.00% – 29.91%] | 9/9 [70.09% – 100.00%] · Δ +100.00% · p 0.00390625 |
| <code>follow-up</code> | <code>en</code> | 0/9 [0.00% – 29.91%] | 9/9 [70.09% – 100.00%] · Δ +100.00% · p 0.00390625 |
| <code>google-ads</code> | <code>ar</code> | 0/8 [0.00% – 32.44%] | 0/8 [0.00% – 32.44%] · Δ +0.00% · p 1 |
| <code>google-ads</code> | <code>en</code> | 0/8 [0.00% – 32.44%] | 0/8 [0.00% – 32.44%] · Δ +0.00% · p 1 |
| <code>memory</code> | <code>ar</code> | 0/8 [0.00% – 32.44%] | 8/8 [67.56% – 100.00%] · Δ +100.00% · p 0.0078125 |
| <code>memory</code> | <code>en</code> | 0/8 [0.00% – 32.44%] | 8/8 [67.56% – 100.00%] · Δ +100.00% · p 0.0078125 |
| <code>multi-step</code> | <code>ar</code> | 1/9 [1.99% – 43.50%] | 9/9 [70.09% – 100.00%] · Δ +88.89% · p 0.0078125 |
| <code>multi-step</code> | <code>en</code> | 0/9 [0.00% – 29.91%] | 9/9 [70.09% – 100.00%] · Δ +100.00% · p 0.00390625 |
| <code>refusal</code> | <code>ar</code> | 1/8 [2.24% – 47.09%] | 8/8 [67.56% – 100.00%] · Δ +87.50% · p 0.015625 |
| <code>refusal</code> | <code>en</code> | 0/8 [0.00% – 32.44%] | 8/8 [67.56% – 100.00%] · Δ +100.00% · p 0.0078125 |
| <code>small-talk</code> | <code>ar</code> | 4/9 [18.88% – 73.33%] | 9/9 [70.09% – 100.00%] · Δ +55.56% · p 0.0625 |
| <code>small-talk</code> | <code>en</code> | 6/9 [35.42% – 87.94%] | 9/9 [70.09% – 100.00%] · Δ +33.33% · p 0.25 |

### <code>dev-bench-v2</code>

| العائلة | اللغة | <code>baseline</code> | <code>production</code> |
| --- | --- | --- | --- |
| <code>all</code> | <code>all</code> | 1136/2400 [45.34% – 49.33%] | 1588/2400 [64.25% – 68.03%] · Δ +18.83% · p 1.43516e-124 |
| <code>all</code> | <code>ar</code> | 844/1200 [67.69% – 72.85%] | 982/1200 [79.55% – 83.91%] · Δ +11.50% · p 3.64257e-39 |
| <code>all</code> | <code>en</code> | 292/1200 [21.99% – 26.84%] | 606/1200 [47.67% – 53.32%] · Δ +26.17% · p 2.37299e-86 |
| <code>calculation</code> | <code>en</code> | 5/277 [0.77% – 4.16%] | 7/277 [1.23% – 5.12%] · Δ +0.72% · p 0.5 |
| <code>clarification</code> | <code>ar</code> | 2/2 [34.24% – 100.00%] | 2/2 [34.24% – 100.00%] · Δ +0.00% · p 1 |
| <code>clarification</code> | <code>en</code> | 7/7 [64.57% – 100.00%] | 7/7 [64.57% – 100.00%] · Δ +0.00% · p 1 |
| <code>coding</code> | <code>en</code> | 0/155 [0.00% – 2.42%] | 108/155 [62.04% – 76.37%] · Δ +69.68% · p 6.16298e-33 |
| <code>comparison</code> | <code>ar</code> | 22/26 [66.47% – 93.85%] | 22/26 [66.47% – 93.85%] · Δ +0.00% · p 1 |
| <code>comparison</code> | <code>en</code> | 6/6 [60.97% – 100.00%] | 6/6 [60.97% – 100.00%] · Δ +0.00% · p 1 |
| <code>factual</code> | <code>ar</code> | 820/1017 [78.09% – 82.94%] | 818/1017 [77.88% – 82.75%] · Δ -0.20% · p 0.5 |
| <code>factual</code> | <code>en</code> | 164/227 [66.09% – 77.66%] | 158/227 [63.33% – 75.22%] · Δ -2.64% · p 0.03125 |
| <code>follow-up</code> | <code>en</code> | 46/240 [14.69% – 24.62%] | 46/240 [14.69% – 24.62%] · Δ +0.00% · p 1 |
| <code>refusal</code> | <code>ar</code> | 0/155 [0.00% – 2.42%] | 140/155 [84.65% – 94.05%] · Δ +90.32% · p 1.43493e-42 |
| <code>refusal</code> | <code>en</code> | 0/220 [0.00% – 1.72%] | 208/220 [90.71% – 96.85%] · Δ +94.55% · p 4.86173e-63 |
| <code>small-talk</code> | <code>en</code> | 64/68 [85.83% – 97.69%] | 66/68 [89.90% – 99.19%] · Δ +2.94% · p 0.5 |

## السرعة والتكلفة

أُخذت مقاييس القرار من <code>development</code>. يعرض كل مقياس زمني تغطية الأدوار التي أمكن رصدها.

| المقياس | <code>baseline</code> | <code>production</code> |
| --- | --- | --- |
| أول تقدّم مرئي (ms) | p50 8 / p95 15 · 2679/2679 (<code>ar</code> 1339/1339، <code>en</code> 1340/1340) | p50 10 / p95 24 · 2679/2679 (<code>ar</code> 1339/1339، <code>en</code> 1340/1340) |
| الجواب النهائي (ms) | p50 52.9934 / p95 1165.74 · 2677/2679 (<code>ar</code> 1338/1339، <code>en</code> 1339/1340) | p50 71.8396 / p95 690.067 · 2678/2679 (<code>ar</code> 1338/1339، <code>en</code> 1340/1340) |
| متوسط CPU لكل دور (ms) | 59.6 · 2679/2679 (<code>ar</code> 1339/1339، <code>en</code> 1340/1340) | 97.9733 · 2679/2679 (<code>ar</code> 1339/1339، <code>en</code> 1340/1340) |
| ذروة RSS (bytes) | 1108078592 | 1105608704 |
| ملفات النماذج على القرص (bytes) | 0 | 1519844 |
| ذاكرة العامل المقيم (bytes) | 0 | 0 |
| وقت GPU المخصّص للتدريب (hours) | not measured (<code>No completed training-run receipts were supplied.</code>) | not measured (<code>No completed training-run receipts were supplied.</code>) |

### <code>baseline</code>

- الإصدار <code>29448aea3fa10d226ef82ec5bf0a65e723d6ec39</code>
- الإعدادات <code>MOHASSAN_PLAN_COMPILER=off</code>، <code>MOHASSAN_CONVERSATION_SHADOW=0</code>، <code>TEST_DRIVEN_CODING_ENABLED=false</code>، <code>MOHASSAN_MODEL_RELATIONS=off</code>، <code>MOHASSAN_MONITORS_ENABLED=0</code>، <code>MOHASSAN_SCRATCH_CLASSIFIERS=0</code>، <code>MOHASSAN_STRUCTURED_MEMORY=0</code>، <code>MOHASSAN_EXTRACTIVE_WRITING=0</code>، <code>MOHASSAN_CLARIFY_CHOICES=0</code>، <code>MOHASSAN_SMALL_TALK_MANNERS=0</code>، <code>MOHASSAN_REFUSAL_POLICY=0</code>، <code>MOHASSAN_REASONING=0</code>، <code>MOHASSAN_CONVERSATION_REVIEW_APPLY=0</code>، <code>MOHASSAN_QUESTION_REWRITER=0</code>، <code>MOHASSAN_ARITHMETIC_SEARCH=0</code>، <code>MOHASSAN_REPLY_POLICY_ENABLED=0</code>، <code>MOHASSAN_CONTEXT_POLICY_ENABLED=0</code>، <code>MOHASSAN_LONG_RUN_ENABLED=0</code>، <code>MOHASSAN_BACKGROUND_RESULTS_ENABLED=0</code>، <code>MOHASSAN_MONITORS_V2=0</code>، <code>MOHASSAN_MONITORS_GITHUB=0</code>، <code>MOHASSAN_MONITORS_PDF=0</code>، <code>MOHASSAN_MONITORS_VISUAL=0</code>، <code>MOHASSAN_MONITOR_CONTEXT=0</code>، <code>MOHASSAN_MONITOR_CONTEXT_SHADOW=0</code>، <code>MOHASSAN_ARBITER_ROUTING=0</code>، <code>MOHASSAN_ARBITER_QUESTION_REWRITE=0</code>، <code>MOHASSAN_ARBITER_LOCAL_COMPUTATION=0</code>، <code>MOHASSAN_ARBITER_COMPOUND_PLAN=0</code>، <code>MOHASSAN_ARBITER_ROUTING_KILL=0</code>، <code>MOHASSAN_ARBITER_QUESTION_REWRITE_KILL=0</code>، <code>MOHASSAN_ARBITER_LOCAL_COMPUTATION_KILL=0</code>، <code>MOHASSAN_ARBITER_COMPOUND_PLAN_KILL=0</code>، <code>MOHASSAN_JUDGE_SHADOW=0</code>، <code>MOHASSAN_JUDGE_FIX=0</code>، <code>MOHASSAN_JUDGE_WITHHOLD=0</code>، <code>MOHASSAN_MIND=0</code>، <code>TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12</code>
- جهاز القياس (<code>development</code>) <code>architecture</code> <code>x86_64</code>، <code>available_cpus</code> <code>5</code>، <code>logical_cpus</code> <code>5</code>، <code>processor</code> <code>AMD EPYC 9V74 80-Core Processor</code>، <code>release</code> <code>6.18.57</code>، <code>system</code> <code>Linux</code>
- بصمة الإيصال <code>development</code> <code>899c9aad999dbebc3dd74f39aedff4cfb8b4db85d9c714f8cc753a5361762daa</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/receipt.json</code> (<code>db02a830f5bff85d75a6367a3fa092a4a6abd04c419e77756f71caa127f7c2de</code>)
  عند <code>2026-11-27T01:24:29.962283+00:00</code> بالأمر <code>/usr/local/bin/python3 -B -m scripts.scorecard --offline --workers 2 --coding-python /usr/local/bin/python3.12 --output /workspace/work/scorecard/final-run</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/npm-ci.log</code> (<code>812d0d7ce9df90dfe60bc9796e1d14b1cb3fd6b9effc629dce044f6864639808</code>)
  عند <code>2026-11-27T01:19:51.237552+00:00</code> بالأمر <code>npm ci --no-audit --no-fund --offline</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/v1.log</code> (<code>05d15cedd679d0d1dd4b7750705da854fe0e71ec3be1b413a7d4c11888ea18b6</code>)
  عند <code>2026-11-27T01:20:45.350092+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --output /workspace/work/scorecard/final-run/development/baseline/v1-development.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/v2-lane-0.log</code> (<code>18861a50f1605eef9c355d2492102dd3c2777cf7b9959dc08326bdf7fa7a67a6</code>)
  عند <code>2026-11-27T01:21:46.586287+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/baseline/v2-lane-0.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/v2-lane-1.log</code> (<code>4dcb3d95a216c416e5a9e0dd06e98ac35412a766481dfc0301619f9865e4b6a5</code>)
  عند <code>2026-11-27T01:21:42.231901+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/baseline/v2-lane-1.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/v2-lane-2.log</code> (<code>503f4235ed1947ba3d6beaab75565aaa7d81c65d92de512f177907041b01fc74</code>)
  عند <code>2026-11-27T01:22:45.486827+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/baseline/v2-lane-2.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/v2-lane-3.log</code> (<code>14b47998571c5b47030e56ebb1cc67277c59c9a7035e3662ec76f317be38e059</code>)
  عند <code>2026-11-27T01:22:40.297209+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/baseline/v2-lane-3.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/v2-lane-4.log</code> (<code>2979e27d4911039fb38c13f12f29f83792f121013409287f48d85c71925c4dbe</code>)
  عند <code>2026-11-27T01:23:18.857207+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/baseline/v2-lane-4.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/v2-lane-5.log</code> (<code>e39da373904ea2ff369d38828f4a09d0e7ae6c01e4459fa876510bfb2b5d7e6a</code>)
  عند <code>2026-11-27T01:23:37.268295+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/baseline/v2-lane-5.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/v2-lane-6.log</code> (<code>9298a5be860f1131b79d12bbbf425311a078016831452e0abd1632d0912b71c6</code>)
  عند <code>2026-11-27T01:24:06.987293+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/baseline/v2-lane-6.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/baseline/v2-lane-7.log</code> (<code>5383e26eb9426bf3bd352844ebeb4b94dd313e9d53d6c7b4fe70c5be80d4bd72</code>)
  عند <code>2026-11-27T01:24:28.344145+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/baseline/v2-lane-7.json</code>

### <code>production</code>

- الإصدار <code>29448aea3fa10d226ef82ec5bf0a65e723d6ec39</code>
- الإعدادات <code>MOHASSAN_SMALL_TALK_MANNERS=1</code>، <code>MOHASSAN_CONVERSATION_REVIEW_APPLY=1</code>، <code>MOHASSAN_CONVERSATION_SHADOW=decide</code>، <code>MOHASSAN_STRUCTURED_MEMORY=1</code>، <code>MOHASSAN_EXTRACTIVE_WRITING=1</code>، <code>MOHASSAN_PLAN_COMPILER=on</code>، <code>MOHASSAN_REASONING=1</code>، <code>MOHASSAN_CLARIFY_CHOICES=1</code>، <code>MOHASSAN_SCRATCH_CLASSIFIERS=1</code>، <code>MOHASSAN_REFUSAL_POLICY=1</code>، <code>TEST_DRIVEN_CODING_ENABLED=true</code>، <code>MOHASSAN_QUESTION_REWRITER=1</code>، <code>MOHASSAN_ARITHMETIC_SEARCH=1</code>، <code>MOHASSAN_MODEL_RELATIONS=shadow</code>، <code>TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12</code>
- جهاز القياس (<code>development</code>) <code>architecture</code> <code>x86_64</code>، <code>available_cpus</code> <code>5</code>، <code>logical_cpus</code> <code>5</code>، <code>processor</code> <code>AMD EPYC 9V74 80-Core Processor</code>، <code>release</code> <code>6.18.57</code>، <code>system</code> <code>Linux</code>
- بصمة الإيصال <code>development</code> <code>91fd4b6ce364112c38789412e2d8a640c3e1928dd508c07aca28419762c03e3b</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/receipt.json</code> (<code>005103c7ccfcc4fcc6dd7c478e75fd1ff2849f09b77815f55dddbc7af106c205</code>)
  عند <code>2026-11-27T01:29:15.180101+00:00</code> بالأمر <code>/usr/local/bin/python3 -B -m scripts.scorecard --offline --workers 2 --coding-python /usr/local/bin/python3.12 --output /workspace/work/scorecard/final-run</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/npm-ci.log</code> (<code>812d0d7ce9df90dfe60bc9796e1d14b1cb3fd6b9effc629dce044f6864639808</code>)
  عند <code>2026-11-27T01:24:46.129663+00:00</code> بالأمر <code>npm ci --no-audit --no-fund --offline</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/v1.log</code> (<code>d8ea5bbba61882f1fc7d3ce38c10065ba242977599633f8de60b0fb0a2585af7</code>)
  عند <code>2026-11-27T01:25:28.159347+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --output /workspace/work/scorecard/final-run/development/production/v1-development.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/v2-lane-0.log</code> (<code>408116d247e9d715e3e10596499853f03a6f2e9747fcaaabbba19015d18ee455</code>)
  عند <code>2026-11-27T01:26:27.596439+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/production/v2-lane-0.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/v2-lane-1.log</code> (<code>12035606940edfe48b8b888558f43ceca9c2be6159e8b986b2434d89366c36a9</code>)
  عند <code>2026-11-27T01:26:23.401672+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/production/v2-lane-1.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/v2-lane-2.log</code> (<code>006a89a99ca539e353e1bdb0b95ac23360dfd45f2b4130bb03773c9d48305cca</code>)
  عند <code>2026-11-27T01:27:16.528764+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/production/v2-lane-2.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/v2-lane-3.log</code> (<code>f6147774fef4eb4e86b34e98b79b5b98b2f2d205a82554e85e3e5103f8864c67</code>)
  عند <code>2026-11-27T01:27:14.587039+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/production/v2-lane-3.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/v2-lane-4.log</code> (<code>d2a9bf97968e4ddfa2f5e198a1c067d06b721ca2d380050709c3f414204aa455</code>)
  عند <code>2026-11-27T01:27:58.695660+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/production/v2-lane-4.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/v2-lane-5.log</code> (<code>7c6f2109e22eaae85ec9339d6f55b51ea5b08e44945e53e3981f802cc62cf608</code>)
  عند <code>2026-11-27T01:28:15.423929+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/production/v2-lane-5.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/v2-lane-6.log</code> (<code>df0285918002a9393640c4002f2a66838b5e62d21aded07ee228913622d8c578</code>)
  عند <code>2026-11-27T01:28:51.496070+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/production/v2-lane-6.json</code>
- المخرج الخام <code>/workspace/work/scorecard/final-run/development/production/v2-lane-7.log</code> (<code>1df309d3d50b5d40ae8ea9edc44ac03d5e5d51512b07ea16e78eeb4cd09ea44d</code>)
  عند <code>2026-11-27T01:29:13.228884+00:00</code> بالأمر <code>node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output /workspace/work/scorecard/final-run/development/production/v2-lane-7.json</code>

معرّفات الحالات العامة التي تراجعت

- <code>dev-document-file-132</code>
- <code>dev-document-file-141</code>
- <code>human-037c6e5965e40c509df29fd9</code>
- <code>human-14fc3756e3ea6d507419afb0</code>
- <code>human-25d5164520d65732fbd5e669</code>
- <code>human-383c8d7e14a823efbca95f8a</code>
- <code>human-79806904e5719c643331e3e5</code>
- <code>human-b3dbcc97ba014a34c2a21e70</code>
- <code>human-b423abb0b4c4a7552ede63f6</code>
- <code>human-f8513f8a29aa1f2559f26954</code>

## القرار

- <code>baseline</code> — <code>keep</code>
- <code>production</code> — <code>keep in shadow</code>
- قيمة نموذج موحسن الخاص — not measured (هذا التشغيل لم يتضمّن ذراعًا بإصدار نموذج محدّد).

## إعادة التشغيل وأدلة القياس

شُغِّل الأمر التالي في Linux بمعزل عن الشبكة. استُعمل Node وPython وChromium المثبّتة كما توضح إيصالات المختبر. سجّل `start.json` بصمات ملفات الأداة في بداية القياس حين كان HEAD يشير إلى الإصدار الأساسي، قبل تثبيت ملفات الأداة الجديدة في فرع العمل.

```bash
docker build -t mohassan-scorecard-bench:2026-11-27 scripts/dev-bench
docker run --name mohassan-scorecard-final --rm --network none --cap-drop ALL \
  --security-opt no-new-privileges --user 1000:1000 \
  --mount type=bind,source=/workspace/Mohassan-AI,target=/workspace/Mohassan-AI \
  --mount type=bind,source=/workspace/work/scorecard,target=/workspace/work/scorecard \
  --workdir /workspace/Mohassan-AI \
  --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/scorecard/chromium \
  --env npm_config_cache=/workspace/work/scorecard/npm-cache \
  mohassan-scorecard-bench:2026-11-27 \
  python3 -B -m scripts.scorecard --offline --workers 2 \
    --coding-python /usr/local/bin/python3.12 \
    --output /workspace/work/scorecard/final-run
```

سجل الأمر `/workspace/work/scorecard/final-run.log`. المسارات التالية نسبة إلى مجلد التشغيل `/workspace/work/scorecard/final-run`.

| الملف | SHA-256 |
| --- | --- |
| `start.json` | `b4206de0879c7bcff4c2b6e3d21113ed9c7831a3759969e6615323519d7330a2` |
| `results.json` | `021bb7151f5c7fba64c31b873d1035c9af0f55abdee34c10783cba6cdb346355` |
| `report.md` | `d6f6d1581a9266e0f4a9baace207cddb1767171b6bd018d5abaeaf82c21d26da` |
| `development/baseline.json` | `899c9aad999dbebc3dd74f39aedff4cfb8b4db85d9c714f8cc753a5361762daa` |
| `development/baseline/receipt.json` | `db02a830f5bff85d75a6367a3fa092a4a6abd04c419e77756f71caa127f7c2de` |
| `development/baseline/v1-development.json` | `05a4d9e834bf9e92f4b8e51dddad66340b6f7b719e9b1232aa70b805af337bc4` |
| `development/baseline/v2-lane-0.json` | `121fb9b312d9a0137cf4ba508a2864e7463f9f5cdbf3a9a081d024586243251d` |
| `development/baseline/v2-lane-1.json` | `e6b094acfcbb99bf9119d639094cb1a3c6af35ee95d7b188d5cbef7edf76d1bc` |
| `development/baseline/v2-lane-2.json` | `d1ac3b468e8c9e7f82084d6c0c3ea73ace0a796eca08479b6ac7af89922cf2bc` |
| `development/baseline/v2-lane-3.json` | `4784f53feb8b18e21ec143affd1d0157ac5bfdc9fc9c4243ba460fd091eda0f2` |
| `development/baseline/v2-lane-4.json` | `1e8b023f3f5a30378c522d9c3ef40ead6f3e03b6be5f6f70c81bbc3f53b3374a` |
| `development/baseline/v2-lane-5.json` | `898acc7580647e985873bdd8d9df7edd1cf59e42c11fb1095872de68e1bced1e` |
| `development/baseline/v2-lane-6.json` | `ab09bda141821207f80383e5a11c634fb620dbd7ef1c79c149858280e056f314` |
| `development/baseline/v2-lane-7.json` | `b1b1a412d4422043b555e772cb528e1b63ff692236b1944414ed4ed2a0b26a19` |
| `development/production.json` | `91fd4b6ce364112c38789412e2d8a640c3e1928dd508c07aca28419762c03e3b` |
| `development/production/receipt.json` | `005103c7ccfcc4fcc6dd7c478e75fd1ff2849f09b77815f55dddbc7af106c205` |
| `development/production/v1-development.json` | `e78d4a827e20f3ce577f515ef4fb51d3de9de84e3eaeb7794ef37e2250dc1c72` |
| `development/production/v1-shadow.jsonl` | `d2426df9d53ac2413c8609bbf88a0b6470cef556a7b7d8e1f7f7f82b58cb5261` |
| `development/production/v2-lane-0.json` | `90c9c07170ef446fc4be55035ac237df1f7e2064aa7c563de10c9898aec4f4f4` |
| `development/production/v2-lane-1.json` | `23e63ff4ebaa458fe6d03dd423a921af577a55942b664a50d725e316ba2e60ad` |
| `development/production/v2-lane-2.json` | `924e9a5ff3cee88e63228b9433f96cbb29bdc6ea2729e0474a6bf006eb3a18ea` |
| `development/production/v2-lane-3.json` | `0083926f0ebd038ae790ea92d62681bbfd264a33543fdef1320b4364d2d0d9b2` |
| `development/production/v2-lane-4.json` | `05a98652117c52d0e9c1ea6ef8d45fb05f9bf3f26f438500eddf2410015c15a4` |
| `development/production/v2-lane-5.json` | `1e82ef3a00608924a49662da34d505b6c2d9ccb6baafb5614b986621d8a3f907` |
| `development/production/v2-lane-6.json` | `6f508e1528918a5ae19a88cd6572c58908ef7e2e892a3c7c9cff4d4eb33ca091` |
| `development/production/v2-lane-7.json` | `dadf3af0fab68a2a36f703f93f9b6f27de6a16752c164139fdb04b17750fe6c5` |
| `development/production/v2-shadow.jsonl` | `be96a49941909b131cafccfe84b3414a1d4dee53d1be667af1c74b68c4ab1191` |
