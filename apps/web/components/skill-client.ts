export interface SkillResponseSchema<T> { parse(value: unknown): T }
export class SkillApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); this.name = 'SkillApiError'; }
}
export async function skillRequest<T>(path: string, schema: SkillResponseSchema<T>, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers } }); }
  catch (error) { if (options.signal?.aborted) throw error; throw new SkillApiError('NETWORK_ERROR', 'تعذر الاتصال بالخادم. لم تُعَد أي عملية تلقائيًا.', 0); }
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = raw && typeof raw === 'object' && 'error' in raw ? (raw as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    throw new SkillApiError(typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED', typeof error?.message === 'string' ? error.message : 'تعذر إكمال الطلب.', response.status);
  }
  try { return schema.parse(raw); } catch { throw new SkillApiError('RESPONSE_INVALID', 'وصلت بيانات لا تطابق عقد الواجهة. حدّث الصفحة أو راجع سجل الخادم.', response.status); }
}
export function skillPost<T>(path: string, body: unknown, schema: SkillResponseSchema<T>, options: { key?: string; signal?: AbortSignal } = {}): Promise<T> {
  return skillRequest(path, schema, { method: 'POST', body: JSON.stringify(body), signal: options.signal, headers: options.key ? { 'idempotency-key': options.key } : {} });
}
export function skillErrorText(error: unknown): string {
  if (error instanceof SkillApiError) {
    if (error.status === 401) return 'انتهت جلسة الدخول. سجّل الدخول مجددًا.';
    if (error.status === 403) return `رُفضت الصلاحية: ${error.message}`;
    return `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : 'تعذر إكمال العملية.';
}
export const skillDate = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'لا توجد بيانات كافية';
export const skillPercent = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}٪` : 'لا توجد بيانات كافية';
export const skillLevels = { instruction: 'تعليمات فقط', tool: 'تنفّذ عبر الأدوات', executable: 'تنفيذية معزولة — محجوبة' } as const;
export const skillStatuses: Record<string, string> = { quarantined: 'في الحجر للمراجعة', inspected: 'مفحوصة', tested: 'مختبرة', benchmarked: 'مقاسة', active: 'مفعّلة', deprecated: 'إصدار سابق', revoked: 'ملغاة', rejected: 'مرفوضة', incompatible: 'غير متوافقة', stale: 'تحتاج إعادة تحقق' };
export const skillCategories: Record<string, string> = { reasoning: 'التفكير', coding: 'البرمجة', browser: 'المتصفح', computer: 'الكمبيوتر', design: 'التصميم', creativity: 'الإبداع', documents: 'المستندات', languages: 'اللغات', business: 'الأعمال', marketing: 'التسويق', research: 'البحث', security: 'الأمان', analytics: 'التحليل', media: 'الوسائط' };
