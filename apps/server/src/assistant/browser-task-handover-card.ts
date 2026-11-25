import type { ChatSecureRequest } from '@mohassan/contracts';

const HANDOVER_NOTES = {
  login: 'سأتابع في المتصفح عند التحقق من اكتمال تسجيل الدخول.',
  code: 'سأتابع في المتصفح عند التحقق من قبول الرمز.',
  hands_on: 'أكمل الخطوة في المتصفح. سأتابع عند التحقق من أن الصفحة أصبحت جاهزة.',
} as const;

type HandoverKind = keyof typeof HANDOVER_NOTES;
export type BrowserTaskSecureCard = Pick<ChatSecureRequest, 'kind' | 'site'> & Partial<Pick<ChatSecureRequest, 'note' | 'fields' | 'prompt'>>;

export function browserTaskHandoverNote(kind: HandoverKind) {
  return HANDOVER_NOTES[kind];
}

export function browserTaskHandoverVisibility(secure: BrowserTaskSecureCard | null) {
  if (secure?.kind !== 'hands_on' || secure.fields?.length !== 0 || !secure.prompt) return undefined;
  if (secure.note === HANDOVER_NOTES.login) return { level: 3 as const, code: 'needs_login' as const, reason: secure.prompt };
  if (secure.note === HANDOVER_NOTES.code) return { level: 3 as const, code: 'needs_code' as const, reason: secure.prompt };
  if (secure.note === HANDOVER_NOTES.hands_on) return { level: 3 as const, code: 'hands_on' as const, reason: secure.prompt };
  return undefined;
}
