# تسليم: الحَكَم («الدماغ الثاني») في وضع الظل — 2026-11-22

| | |
|---|---|
| القرار | المالك في 2026-11-22: دماغ ثانٍ بصورة **حَكَم يفحص الجواب قبل إرساله**، لا مجيبًا موازيًا؛ «ابدأ في الظل» |
| الملفات الجديدة | `apps/server/src/assistant/judge.ts`، `apps/server/src/assistant/judge-shadow.ts`، `tests/assistant-judge.test.ts`، `tests/assistant-judge-shadow.test.ts`، `scripts/judge/shadow.ts`، `scripts/judge/shadow-report.ts` |
| التقرير والأرقام | `artifacts/judge-2026-11-22/{README.md, shadow.json, alerts-for-review.jsonl}` (artifacts غير مُتابَع في git) |
| الحالة | ظل خالص: لا مسار في الدردشة يقرأ الحَكَم. **الربط الحي غير منفّذ** (سطران في `command-chat.ts`، أدناه). لا شيء محفوظ في git |
| الملفات الحارة | لم يُلمس `command-chat.ts` ولا `hands.ts` ولا `mind/critic.ts` ولا `reply-check.ts` ولا `answer-check.ts`؛ وكيل آخر كان يعدّل الأولَين في الساعة نفسها |

## ما يفعله الحَكَم

`judge({ question, reply, status?, previous?, evidence?, fixedTexts? })` يعيد قرارًا واحدًا من ثلاثة، مع رموز سبب ومواضع:

| القرار | معناه | متى |
|---|---|---|
| `send` | يُرسل كما هو | لا ملاحظة من شدة block أو fix |
| `fix` | إصلاح آلي بلا كتابة حرة | عناوين عربية في جواب إنجليزي، سطر المؤلف، جمل واجهة الموقع، تكرار، أو **ترقية سطر لاحق يجيب أفضل** إلى الصدارة (`lead_not_best`) |
| `withhold` | لا يُرسل الجواب؛ يُرسل بدله نص ثابت `WITHHOLD_TEXT` | السطر الأول لا يذكر الموضوع، أو عن الصفحة لا الموضوع، أو سؤال عددي بلا رقم في أي سطر، أو سؤال مدة بلا رقم ووحدة زمن، أو سؤال عن موحسن نفسه أُجيب من صفحة ويب، أو جملة لا سند لها في الأدلة |

الحَكَم لا يكتب جملة واحدة من عنده: الإصلاح يعيد ترتيب سطور الصفحة نفسها أو يحذف منها، والحجب نصه ثابت. ليس فيه نموذج.

أنواع الرد التي يميّزها قبل الحكم: `answer` (جواب من صفحة بسطر **المصدر:**)، `quote` (قراءة صفحة بسطور `>`)، `list` (عناوين أو نتائج مرقمة)، `computed`، `memory`، `question` (بطاقة أو تسجيل دخول أو موافقة)، `abstain` (قوالب الامتناع)، `composed` (قالب الرسالة)، `action`، `fixed`. فحوص السطر الأول تعمل على `answer` الموثّق بمصدر فقط، فلا تحجب ردود الكاتب أو المخطط أو الحديث القصير.

يعيد استعمال ما هو موجود دون تعديله: `checkReply`/`applyReplyFixes` من `reply-check.ts`، و`checkAnswerLine`/`isMetaLine` من `answer-check.ts`، و`buildFrame` من `mind/frame.ts` (النية ونوع الجواب)، و`topicWords`/`fold` من `hands.ts`.

## ما قِيس (الظل على الردود الحقيقية المجمّدة، 2026-11-22 05:04 UTC)

`npx tsx scripts/judge/shadow.ts` على `artifacts/plan-2026-11-22/real-answers-2026-11-22T02-17-34.jsonl`: 107 صفًا، 91 ردًا.

| | العدد |
|---|---|
| send | 82 |
| fix | 7 (rq010, rq016, rq028, rq036, rq064, rq090, rq097) |
| withhold | 2 (rq018 مدة عملية أُجيبت بمعركة؛ rq037 «ما هي قدراتك» أُجيبت من ويكيبيديا) |
| ردود يعلّمها الحَكَم ولا يراها فاحص الرد E4.1 | 21 من 29 (الفاحص وحده 8) |
| الحالات المعروفة من خط الأساس §8.3 والتصميم | 12 من 12 صحيحة |
| الحالات النظيفة المتوقَّع إرسالها كما هي | 15 من 15 |
| الزمن | p50 ‏1.2 ms، p95 ‏24.7 ms، الأقصى 230.7 ms (أول نداء) |

الرموز حسب عدد الردود: `local_intent_abstained` 12 (طلبات حساب وهوية وإعلانات قوبلت بقالب امتناع؛ منها ستة طلبات Ads صنّفها الإطار `compute`)، `fragment_lead` 9، `foreign_heading` 6، `definition_form_missing` 4، `language_mismatch` 3، `site_chrome` 3، `lead_not_best` 3، وواحد لكل من `byline_lead` و`lead_meta` و`duration_unit_missing` و`self_question_from_web`.

السطر الأول مقابل أفضل سطر في الأجوبة الموثّقة (26): الفارق 0 في 22، و1 في واحد، و3 أو أكثر في ثلاثة (rq010، rq016، rq028). هامش الترقية المقترح 2.

**ما لم يُقَس:** السند (`unsupported_sentence`) لأن الملف المجمّد لا يحمل نصوص الصفحات؛ يُقاس في الظل الحي فقط حين يمرّر المضيف الأدلة. وصحة القرارات نفسها تحتاج حكم المالك على 29 سطرًا في `alerts-for-review.jsonl` (الحقل `verdict`: `correct` أو `wrong`).

الاختبارات: `npx vitest run tests/assistant-judge.test.ts tests/assistant-judge-shadow.test.ts` → 20 ناجحة. `tsc --noEmit` خالٍ من أخطاء في ملفات الحَكَم (أخطاء أخرى قائمة في `command-chat.ts` و`scripts/sites-baseline.ts` و`scripts/vision/read-image.ts` لوكلاء آخرين).

## المطلوب من مالك `command-chat.ts` و`app.ts` (بكلمة المالك فقط)

سطران، مثل ظل الموجّه B0 وظل حالة المحادثة:

```ts
// app.ts بجانب shadowRouter
const judgeShadow = !config.production && process.env.MOHASSAN_JUDGE_SHADOW !== '0' && !process.env.VITEST
  ? createJudgeShadow({ logFile: join(process.cwd(), '.data', 'judge', 'shadow.jsonl') }) : undefined;
// ويُمرَّر في createCommandChatControl(..., { judgeShadow })
```

```ts
// command-chat.ts في أول finish(id, runId, state, text, status, …) قبل أي كتابة
config.judgeShadow?.observe({ conversationId: id, runId, question: request, reply: text, status,
  previous: previousUserTurn ?? null,
  evidence: state.handsFound ? [{ kind: 'page', text: state.handsFound.lines.join('\n'), url: state.handsFound.url, title: state.handsFound.title }] : undefined });
```

`observe` لا يرمي خطأً أبدًا ولا يغيّر الرد؛ يكتب سطرًا في `.data/judge/shadow.jsonl`. التقرير: `npx tsx scripts/judge/shadow-report.ts`.

ملاحظة على الأدلة: `state.handsFound.lines` هي الجمل التي اختارتها الأيدي من الصفحة، فالسند عليها تحصيل حاصل. القياس الحقيقي للسند يحتاج نص الصفحة المقروءة (`page.text` في وقت `describe()`)، وهذا قرار لمالك `hands.ts`.

## الترقية (مقترح، على قاعدة الخطة: ظل ← نطاق محدود بمفتاح إيقاف ← افتراضي)

1. الظل الحي يجمع 200 رد حقيقي على الأقل (مقترح)، والمالك يحكم على التنبيهات.
2. نطاق محدود: حساب المالك فقط، قرار `fix` وحده (الترقية والحذف الآلي)، مفتاح `MOHASSAN_JUDGE=0`.
3. ثم `withhold` بعد أن تثبت دقته على وسوم المالك.
4. لاحقًا: رأس «كفاية الجواب» H5 على الجذع 38M يصبح الجزء المتعلّم من الحَكَم، بدور «يختار ويشير».

## قرارات مفتوحة للمالك

- هامش الترقية (2 مقترح)، وطول السطر المقطوع (60 كلمة)، وأدنى طول جملة تُقارن بالأدلة (12 محرفًا).
- هل `language_mismatch` يبقى للمراجعة أم يصير حجبًا؟ (قالب إنجليزي لطلب عربي في rq022: الحجب يستبدله بنص عربي ثابت.)
- هل تُمرَّر نصوص الصفحات كاملة إلى الحَكَم في الظل الحي؟ (يحتاج تعديلًا في `hands.ts`.)
- نص الحجب `WITHHOLD_TEXT` مقترح.

## لا تلمس

- `mind/critic.ts` و`mind/compose.ts` يملكهما Codex؛ الحَكَم يعمل على نص الرد النهائي ولا يستبدل ناقد العقل C.
- `reply-check.ts` و`answer-check.ts` من جلسات أخرى؛ الحَكَم يستوردهما فقط.
