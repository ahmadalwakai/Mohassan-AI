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

**ناقصان صغيران لمالك `command-chat.ts`، حين يناسبه:**
1. تهيئة محادثة نسيها الخادم بعد إعادة التشغيل، قبل `observe`، من رسائل المستخدم وحدها:
   ```ts
   if (!config.conversationShadow.state(id)) config.conversationShadow.seed(id, history.filter(entry => entry.role === 'user').map((entry, index) => ({ id: `${id}-h${index}`, text: entry.text })));
   ```
   بدونها تبدو أول متابعة بعد إعادة التشغيل طلبًا جديدًا في السجل.
2. في `app.ts`: `app.addHook('onClose', async () => { await conversationShadow?.flush(); });` حتى لا يضيع آخر سطر عند الإغلاق.

## لا تلمس

- لا تعدّل `conversation-state.ts` واختباراته دون كلمة المالك؛ وسّع ملف الاختبار بدل إعادة كتابته (فيه 20 اختبارًا من جلسة أخرى + 37 من هذه الجلسة، 57 كلها تنجح عند 05:20 UTC؛ التفاصيل والأرقام في `artifacts/conversation-state-20261122/REPORT.md` §2.1 و§2.2).
- اختبار الربط عبر المتحكم الحقيقي جاهز في `tests/conversation-state-chat.test.ts` ويفترض الحقل `conversationShadow` في `CommandChatConfig`؛ لا يُشغَّل قبل الربط.
- بيانات `scripts/conversation-state/dev-conversations.json` كتبها وكيل؛ ليست مقياس اعتماد.

## قرارات مفتوحة للمالك

ربط الظل، وسم الردود الـ107، كتابة 60 محادثة و20 مختومة، مدة الاحتفاظ بنص الطلب في سجل الظل، وحفظ العمل.
