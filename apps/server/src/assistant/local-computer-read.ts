import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isCurrentComputerReadRequest, isCurrentComputerTitleReadRequest, isUnverifiedComputerTitleTargetRequest } from './computer-request-language.js';
import { reviewComputerRequestScope } from './computer-request-scope.js';
import { requestScopeActionText } from './request-scope.js';

/** Host call bounds, not assertions about native frame capture freshness. */
export const LOCAL_COMPUTER_READ_MAX_CALL_MS = 10_000;
export const LOCAL_COMPUTER_READ_MAX_ASSESSMENT_AGE_MS = 5_000;
export const LOCAL_COMPUTER_READ_MAX_REPLY_CHARS = 40_000;
const MAX_ELEMENTS = 24;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hashValue = z.string().regex(/^[a-f0-9]{64}$/u);
const time = z.number().int().min(0).max(8_640_000_000_000_000);
const wellFormed = (value: string) => !/[\ud800-\udfff]/u.test(value);
const identity = z.string().min(1).max(160).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const PlanSchema = z.object({ version: z.literal(1), kind: z.enum(['title', 'accessible_text_subset']),
  language: z.enum(['ar', 'en']), requestHash: hashValue, target: z.string().min(1).max(100) }).strict();
export type LocalComputerReadPlan = Readonly<z.infer<typeof PlanSchema>>;
const HostSchema = z.object({ runId: identity, requestCreatedAt: time, declaredAt: time,
  readStartedAt: time, readFinishedAt: time, assessedAt: time }).strict();
export type LocalComputerReadHost = Readonly<z.infer<typeof HostSchema>>;
export interface LocalComputerReadProof {
  readonly version: 1;
  readonly kind: 'host_returned_computer_text';
  readonly runId: string;
  readonly requestHash: string;
  readonly target: string;
  readonly coverage: 'complete_title' | 'partial_accessible_text';
  readonly readStartedAt: number;
  /** Host return time only. The adapter supplies no native capture time here. */
  readonly receivedAt: number;
  readonly contentHash: string;
  readonly answerHash: string;
  readonly originHash?: string;
}
export interface LocalComputerReadResult {
  readonly status: 'completed' | 'partial' | 'unavailable';
  readonly reply: string;
  readonly reason: 'complete_title' | 'accessible_subset' | 'missing_title' | 'invalid_binding' | 'invalid_screen';
  readonly proof?: Readonly<LocalComputerReadProof>;
}
interface TextProjection { title: string; elements: Array<{ name: string; type: string }>; originHash?: string }

/**
 * Declare this plan/its criterion BEFORE the host invokes computer.view.
 * Original current-user scope and vetoes are checked; no history, observed UI,
 * model text or extracted positive span can grant an input capability.
 */
export function planLocalComputerRead(originalRequest: unknown): LocalComputerReadPlan | null {
  try {
    if (typeof originalRequest !== 'string' || !originalRequest.trim() || originalRequest.length > 4000
        || !wellFormed(originalRequest) || originalRequest.includes('\u0000')) return null;
    const matching = requestScopeActionText(originalRequest);
    if (!isCurrentComputerReadRequest(matching) || !reviewComputerRequestScope(originalRequest, { kind: 'view' }).allowed) return null;
    const kind = isCurrentComputerTitleReadRequest(matching) ? 'title' : 'accessible_text_subset';
    const requestHash = hash(originalRequest);
    return Object.freeze({ version: 1, kind, language: /\p{Script=Arabic}/u.test(originalRequest) ? 'ar' : 'en', requestHash,
      target: `${kind === 'title' ? 'computer-title' : 'computer-text-subset'}:${requestHash}` });
  } catch { return null; }
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length || keys.some(key => typeof key !== 'string' || !allowed.includes(key))) return null;
  return value as Record<string, unknown>;
}
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && descriptor.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}
function plainFields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const object = record(value, keys);
  if (!object || keys.some(key => !Object.hasOwn(object, key) || !Object.getOwnPropertyDescriptor(object, key)?.enumerable
      || !('value' in Object.getOwnPropertyDescriptor(object, key)!))) return null;
  return Object.fromEntries(keys.map(key => [key, field(object, key)]));
}
const boundedText = (value: unknown, maximum: number, nonempty = false): value is string =>
  typeof value === 'string' && value.length <= maximum && wellFormed(value) && (!nonempty || !!value.trim());

/** Read ONLY adapted text fields. In particular, never access the JPEG value. */
function projectText(value: unknown): TextProjection | null {
  const screen = record(value, ['title', 'canAct', 'hasPasswordField', 'elements', 'jpeg', 'origin']);
  if (!screen) return null;
  const title = field(screen, 'title'), elements = field(screen, 'elements');
  if (!boundedText(title, 160) || typeof field(screen, 'canAct') !== 'boolean' || typeof field(screen, 'hasPasswordField') !== 'boolean'
      || !Array.isArray(elements) || elements.length > MAX_ELEMENTS || Object.getPrototypeOf(elements) !== Array.prototype) return null;
  const projected: TextProjection = { title, elements: [] };
  for (let index = 0; index < elements.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(elements, String(index));
    if (!descriptor || !('value' in descriptor)) return null;
    const element = record(descriptor.value, ['ref', 'name', 'type', 'ambiguous']);
    if (!element) return null;
    const name = field(element, 'name'), type = field(element, 'type'), ref = field(element, 'ref');
    if (!boundedText(name, 160, true) || !boundedText(type, 80, true) || typeof ref !== 'string' || !/^w(?:[1-9]|1\d|2[0-4])$/u.test(ref)
        || Object.hasOwn(element, 'ambiguous') && field(element, 'ambiguous') !== true) return null;
    projected.elements.push({ name, type });
  }
  if (Object.hasOwn(screen, 'origin')) {
    const origin = plainFields(field(screen, 'origin'), ['deviceId', 'grantId', 'targetKey']);
    const parsed = z.object({ deviceId: z.uuid(), grantId: z.uuid(), targetKey: hashValue }).strict().safeParse(origin);
    if (!parsed.success) return null;
    projected.originHash = hash(JSON.stringify(parsed.data));
  }
  return projected;
}

/** Lossless quoted data; a UI string cannot close the fixed code fence. */
function quoted(value: string): string {
  return JSON.stringify(value).replace(/[`<>&\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function render(plan: LocalComputerReadPlan, projection: TextProjection, originalRequest: string): string {
  const titleOnly = plan.kind === 'title', title = projection.title.trim() ? projection.title : null;
  const heading = plan.language === 'ar'
    ? titleOnly ? 'أعاد قارئ الكمبيوتر عنوان النافذة التالي:' : 'هذه النصوص المتاحة التي أعادها قارئ الكمبيوتر:'
    : titleOnly ? 'The PC reader returned this window title:' : 'The PC reader returned these accessible strings:';
  const lines = title === null ? [] : [`title: ${quoted(title)}`];
  if (!titleOnly) projection.elements.forEach((element, index) => lines.push(`${index + 1}. ${quoted(element.name)} (${quoted(element.type)})`));
  const empty = plan.language === 'ar' ? 'لم يُرجع القارئ نصًا متاحًا.' : 'The reader returned no accessible text.';
  const targetUnverified = isUnverifiedComputerTitleTargetRequest(requestScopeActionText(originalRequest));
  const limitation = targetUnverified ? plan.language === 'ar'
    ? 'هذه النصوص من الهدف المشترك. لم أتحقق من أنه التطبيق أو نوع السطح الذي سميته في طلبك. لم أفسّر بكسلات الصورة.'
    : 'These strings came from the shared target. I could not verify that it is the application or surface named in your request. Image pixels were not interpreted.'
    : plan.language === 'ar'
    ? 'هذه نصوص أعادها القارئ وقد تمثل جزءًا من النافذة فقط. لم أفسّر بكسلات الصورة.'
    : 'These returned strings may cover only part of the window. Image pixels were not interpreted.';
  if (titleOnly && title === null) return plan.language === 'ar'
    ? 'لم يُرجع قارئ الكمبيوتر عنوانًا غير فارغ؛ لم أتحقق من العنوان المطلوب.'
    : 'The PC reader returned no nonempty title; the requested title was not verified.';
  return `${heading}\n\n\`\`\`text\n${lines.length ? lines.join('\n') : empty}\n\`\`\`${titleOnly ? '' : `\n\n${limitation}`}`;
}

/**
 * HOST ONLY: pass the actual freshly returned adapted ComputerScreen, never
 * provider JSON or a restored proof. The caller must check live account/grant,
 * lease, cancellation and request constraints before AND after the read.
 * A proof is provenance for this exact answer, not standalone permission or a
 * claim about capture time, complete window contents or atomic image/text data.
 */
export function assessLocalComputerRead(plan: unknown, originalRequest: unknown, returnedScreen: unknown,
    host: LocalComputerReadHost): LocalComputerReadResult {
  const derived = planLocalComputerRead(originalRequest);
  const unavailable = (reason: 'invalid_binding' | 'invalid_screen'): LocalComputerReadResult => Object.freeze({ status: 'unavailable', reason,
    reply: derived?.language === 'ar' ? 'لم أتحقق من نص نافذة الكمبيوتر في هذا الطلب.' : 'The PC window text was not verified for this request.' });
  try {
    const planData = plainFields(plan, ['version', 'kind', 'language', 'requestHash', 'target']);
    const checkedPlan = PlanSchema.safeParse(planData), hostData = plainFields(host,
      ['runId', 'requestCreatedAt', 'declaredAt', 'readStartedAt', 'readFinishedAt', 'assessedAt']);
    const checkedHost = HostSchema.safeParse(hostData);
    if (!derived || !checkedPlan.success || JSON.stringify(checkedPlan.data) !== JSON.stringify(derived) || !checkedHost.success) return unavailable('invalid_binding');
    const binding = checkedHost.data;
    if (binding.requestCreatedAt > binding.declaredAt || binding.declaredAt > binding.readStartedAt || binding.readStartedAt > binding.readFinishedAt
        || binding.readFinishedAt > binding.assessedAt || binding.readFinishedAt - binding.readStartedAt > LOCAL_COMPUTER_READ_MAX_CALL_MS
        || binding.assessedAt - binding.readFinishedAt > LOCAL_COMPUTER_READ_MAX_ASSESSMENT_AGE_MS) return unavailable('invalid_binding');
    const projection = projectText(returnedScreen);
    if (!projection) return unavailable('invalid_screen');
    const reply = render(derived, projection, originalRequest as string);
    if (reply.length > LOCAL_COMPUTER_READ_MAX_REPLY_CHARS) return unavailable('invalid_screen');
    const complete = derived.kind === 'title' && !!projection.title.trim();
    const proof: LocalComputerReadProof = Object.freeze({ version: 1, kind: 'host_returned_computer_text', runId: binding.runId,
      requestHash: derived.requestHash, target: derived.target, coverage: complete ? 'complete_title' : 'partial_accessible_text',
      readStartedAt: binding.readStartedAt, receivedAt: binding.readFinishedAt,
      contentHash: hash(JSON.stringify({ title: projection.title, elements: projection.elements })), answerHash: hash(reply),
      ...(projection.originHash ? { originHash: projection.originHash } : {}) });
    return Object.freeze({ status: complete ? 'completed' : 'partial', reply,
      reason: complete ? 'complete_title' : derived.kind === 'title' ? 'missing_title' : 'accessible_subset', proof });
  } catch { return unavailable('invalid_binding'); }
}
