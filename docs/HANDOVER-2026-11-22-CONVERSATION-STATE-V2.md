# تسليم: حالة المحادثة v2 (ظل) — 2026-11-22

| | |
|---|---|
| المالك الحالي للملفات | جلسة Claude Code التي أكملت الوحدة بكلمة المالك «أكملها أنت هنا» (03:17 UTC) |
| الملفات | `apps/server/src/assistant/conversation-state.ts`، `apps/server/src/assistant/conversation-state-shadow.ts`، `tests/conversation-state.test.ts`، `tests/conversation-state-shadow.test.ts`، `scripts/conversation-state/` |
| التقرير والأرقام | `artifacts/conversation-state-20261122/REPORT.md` (artifacts غير مُتابَع في git) |
| الحالة | ظل خالص: لا مسار في الدردشة يقرأ v2. **الربط منفّذ** (جلسة مالك `command-chat.ts` أدرجته قبل 04:48 UTC كما طلب هذا التسليم؛ تحقّق منه `tests/conversation-state-chat.test.ts` عبر المتحكم الحقيقي في 04:56). كل شيء غير محفوظ |

## ما تفعله الوحدة

`understandTurn(state, text, turnId)` تصنّف دور المستخدم إلى: طلب جديد، تغيير موضوع، متابعة بخاصية، متابعة بكيان، إشارة إلى نتيجة مرقمة، تصحيح، تعديل حقل واحد، جواب بطاقة معلقة، طلب مركب، حديث قصير، غامض. تفصل الكيان عن الخاصية وعن المكان والزمن، وتعيد تركيب استعلام عام للمتابعات («وكم سعره في مصر؟» ← «سعر الذهب مصر اليوم»). حدود v1 باقية: رسائل المستخدم وحدها أوامر، نتائج المساعد بيانات مرقمة، والخاص لا يصير استعلامًا عامًا.

## المطلوب من مالك `command-chat.ts` و`app.ts` (بكلمة المالك فقط)

ثلاثة أسطر، مثل ظل الموجّه B0 تمامًا:

```ts
// app.ts بجانب shadowRouter
const conversationShadow = !config.production && process.env.MOHASSAN_CONVERSATION_SHADOW !== '0' && !process.env.VITEST
  ? createConversationShadow({ logFile: join(process.cwd(), '.data', 'conversation', 'shadow.jsonl') }) : undefined;
// ويُمرَّر في createCommandChatControl(..., { conversationShadow })
```

```ts
// command-chat.ts حيث يُستدعى config.shadowRouter.observe(...) للطلب الجديد
config.conversationShadow?.observe({ conversationId: id, turnId: runId, text: request,
  pending: conversation.question ? { kind: 'question_card', id: conversation.question.id } : null });
```

`observe` لا يرمي خطأً أبدًا ولا يغيّر الرد. التقرير: `npx tsx scripts/conversation-state/shadow-report.ts`.

**حالة الربط في 04:58 UTC:** الأسطر الثلاثة موجودة في `command-chat.ts` (الاستيراد في السطر 30، والحقل بعد `shadowRouter`، والاستدعاء بعد `shadowRouter.observe` داخل `try/catch`) وفي `app.ts` (الإنشاء بعد `shadowRouter` والتمرير إلى `createCommandChatControl`). الخادم الجاري لا يلتقطها قبل إعادة تشغيله، وعندها يبدأ `.data/conversation/shadow.jsonl`.

**تحديث 07:40 UTC (الدفعة الثامنة):**
1. التهيئة بعد إعادة التشغيل لم تعد تحتاج سطرًا في `command-chat.ts`: الظل يعيد بناء المحادثة المنسية من سجله هو (`.data/conversation/shadow.jsonl`، أدوار المستخدم وحدها).
2. الاستدعاء في `command-chat.ts` صار `observeLater` بدل `observe` (هذه الجلسة، 07:37 UTC، بكلمة المالك «اربط الآن»): لا يضيف زمنًا إلى الطلب.
3. سطر الحفظ عند الإغلاق أُضيف في `app.ts` (07:56 UTC، الدفعة التاسعة، الملف هادئ منذ 22 دقيقة): `if (conversationShadow) app.addHook('onClose', …flush())`.
4. أداة إعادة السجل الحقيقي عبر الشفرة الحالية: `npx tsx scripts/conversation-state/replay-shadow.ts`.

## مراجعة المالك (المقياس المستقل)

1. `npx tsx scripts/conversation-state/review-sheet.ts` يكتب ورقة عربية بكل رسالة حقيقية اختلفت فيها القراءتان، تحت `artifacts/conversation-state-20261122/review-*/`.
2. المالك يكتب بعد «الحكم:» كلمة: v1 أو v2 أو كلاهما أو لا أحد، أو يرسلها في المحادثة «1 v2، 2 كلاهما».
3. `npx tsx scripts/conversation-state/score-review.ts <REVIEW-AR.md> [--answers "…"]` يحسب صحة كل قراءة وMcNemar.

الأحكام للمالك وحده؛ لا يملؤها وكيل.

## لا تلمس

- لا تعدّل `conversation-state.ts` واختباراته دون كلمة المالك؛ وسّع ملف الاختبار بدل إعادة كتابته (فيه 20 اختبارًا من جلسة أخرى + 56 من هذه الجلسة، 76 كلها تنجح عند 06:20 UTC؛ التفاصيل والأرقام في `artifacts/conversation-state-20261122/REPORT.md` §2.1 إلى §2.6، ومعها أداة الثبات `scripts/conversation-state/robustness.ts`).
- قاعدة ثابتة بعد الدفعة السابعة: v2 لا يركّب استعلامًا عامًا من كيان بلا خاصية مسمّاة؛ حين يحجب v1 الاستعلام يبقى الحجب.
- اختبار الربط عبر المتحكم الحقيقي جاهز في `tests/conversation-state-chat.test.ts` ويفترض الحقل `conversationShadow` في `CommandChatConfig`؛ لا يُشغَّل قبل الربط.
- بيانات `scripts/conversation-state/dev-conversations.json` كتبها وكيل؛ ليست مقياس اعتماد.

## قرارات مفتوحة للمالك

ربط الظل، وسم الردود الـ107، كتابة 60 محادثة و20 مختومة، مدة الاحتفاظ بنص الطلب في سجل الظل، وحفظ العمل.
