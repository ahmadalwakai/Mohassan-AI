import type { BackgroundPushKind, NotificationKind, NotificationPayload, NotificationPreferences } from '@mohassan/contracts';

export type BackgroundOutcome = 'completed' | 'approval' | 'sign-in' | 'payment' | 'failed';
type LocalizedText = { title: string; body: string };
type Language = 'ar' | 'en';

export const backgroundKinds: Record<BackgroundOutcome, { kind: NotificationKind; runKind: BackgroundPushKind }> = {
  completed: { kind: 'task_completed', runKind: 'run-completed' },
  approval: { kind: 'needs_you', runKind: 'run-blocked' },
  'sign-in': { kind: 'needs_you', runKind: 'run-blocked' },
  payment: { kind: 'needs_you', runKind: 'run-blocked' },
  failed: { kind: 'task_failed', runKind: 'run-failed' },
};

const copy: Record<Language, Record<BackgroundOutcome, LocalizedText>> = {
  ar: {
    completed: { title: 'اكتملت المهمة', body: 'اكتملت مهمتك.' },
    approval: { title: 'المهمة تنتظر موافقتك', body: 'افتح المحادثة لمراجعة طلب الموافقة.' },
    'sign-in': { title: 'المهمة تحتاج إلى تسجيل دخول', body: 'افتح المحادثة لمتابعة خطوة تسجيل الدخول.' },
    payment: { title: 'المهمة تتطلب الدفع', body: 'افتح المحادثة لمراجعة خطوة الدفع.' },
    failed: { title: 'تعذّر إكمال المهمة', body: 'افتح المحادثة لمعرفة ما حدث.' },
  },
  en: {
    completed: { title: 'Task completed', body: 'Your task is complete.' },
    approval: { title: 'Task needs approval', body: 'Open the conversation to review the approval request.' },
    'sign-in': { title: 'Task needs sign-in', body: 'Open the conversation to continue the sign-in step.' },
    payment: { title: 'Task needs payment', body: 'Open the conversation to review the payment step.' },
    failed: { title: 'Task could not finish', body: 'Open the conversation to see what happened.' },
  },
};

export interface BackgroundNotificationEvent {
  task_id: string;
  conversation_id: string;
  run_id: string;
  background_outcome: BackgroundOutcome;
  background_language: Language;
  result_preview: string | null;
}

export function backgroundPayload(event: BackgroundNotificationEvent, preferences: NotificationPreferences) {
  const language = event.background_language;
  const outcome = event.background_outcome;
  const { title, body } = copy[language][outcome];
  return {
    ...backgroundKinds[outcome], taskId: event.task_id, runId: event.run_id, conversationId: event.conversation_id,
    title, body: outcome === 'completed' && preferences.showResultPreview && event.result_preview ? event.result_preview : body,
    language, sound: outcome === 'completed' && preferences.completionSound !== false,
  } satisfies NotificationPayload;
}
