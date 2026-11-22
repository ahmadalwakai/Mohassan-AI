import { z } from 'zod';

/** A host-bound status renderer, never a model response parser or capability grant. */
export const RUNTIME_STATUS_VERSION = 1;
const MAX_REQUEST = 420;
const HEALTH = z.enum(['unknown', 'unverified', 'verified_healthy']);
const HostReceipt = z.object({ source: z.literal('host_health_check'), healthy: z.literal(true) }).strict();
const FeatureSchema = z.object({
  configured: z.boolean().nullable(),
  accountAccess: z.enum(['allowed', 'denied', 'unknown']),
  health: HEALTH,
  healthyHostReceipt: HostReceipt.optional(),
}).strict().superRefine((value, context) => {
  if (value.health === 'verified_healthy' && (value.configured !== true || !value.healthyHostReceipt))
    context.addIssue({ code: 'custom', message: 'Verified health requires configured host facts and a healthy host receipt.' });
});

function safeModelName(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/u.test(value) || value.length > 80 || value.includes('..')) return false;
  if (/^(?:sk-|gsk_|gh[pousr]_|github_pat_|hf_|AIza|AKIA|eyJ)|(?:api[_-]?key|password|secret|access[_-]?token|bearer)/iu.test(value)) return false;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?$/iu.test(value)) return false;
  if (/^[a-f0-9]{24,}$/iu.test(value) || /^[A-Za-z0-9]{32,}$/u.test(value)) return false;
  // A colon is a model tag delimiter; a bare drive prefix is never a model name.
  return !/^[A-Za-z]:/u.test(value);
}
const ModelName = z.string().min(1).max(80).refine(safeModelName);
const GenerationSchema = z.object({
  ...FeatureSchema.shape,
  knownModelNames: z.array(ModelName).max(8).optional(),
  activeModelName: ModelName.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.health === 'verified_healthy' && (value.configured !== true || !value.healthyHostReceipt))
    context.addIssue({ code: 'custom', message: 'Verified health requires a configured model and a healthy host receipt.' });
  if (value.activeModelName && (value.configured !== true || value.accountAccess !== 'allowed'))
    context.addIssue({ code: 'custom', message: 'An active model requires configured, account-accessible host facts.' });
  if (value.knownModelNames && new Set(value.knownModelNames).size !== value.knownModelNames.length)
    context.addIssue({ code: 'custom', message: 'Model names must be unique.' });
});
const ShadowSchema = z.object({ state: z.enum(['absent', 'disabled', 'lab_only', 'observing', 'unknown']) }).strict();
const STAGE = z.enum(['supported', 'unsupported', 'unknown']);
export const HostRuntimeFactsSchema = z.object({
  version: z.literal(1), app: z.literal('Mohassan'), source: z.literal('host_runtime'), accountFiltered: z.literal(true),
  controller: z.object({ revision: z.enum(['A', 'B']), implementation: z.literal('host_rules_and_tools') }).strict().optional(),
  generation: GenerationSchema.optional(), ownAds: FeatureSchema.optional(),
  capabilities: z.object({ memory: FeatureSchema.optional(), knowledge: FeatureSchema.optional(), browser: FeatureSchema.optional(),
    computation: FeatureSchema.optional(), pc: FeatureSchema.optional() }).strict().optional(),
  shadows: z.object({ b0: ShadowSchema.optional(), slots: ShadowSchema.optional() }).strict().optional(),
  stages: z.object({ before: STAGE.optional(), during: STAGE.optional(), after: STAGE.optional() }).strict().optional(),
}).strict();
export type HostRuntimeFacts = z.infer<typeof HostRuntimeFactsSchema>;
export type RuntimeStatusKind = 'overview' | 'generation' | 'capabilities' | 'stages' | 'memory' | 'knowledge' | 'browser' | 'computation' | 'pc' | 'ownAds' | 'b0' | 'slots';
const QuestionSchema = z.object({ kind: z.enum(['overview', 'generation', 'capabilities', 'stages', 'memory', 'knowledge', 'browser', 'computation', 'pc', 'ownAds', 'b0', 'slots']), lang: z.enum(['ar', 'en']) }).strict();
export type RuntimeStatusQuestion = z.infer<typeof QuestionSchema>;
export interface RuntimeStatusAnswer {
  readonly source: 'local_host_status';
  readonly app: 'Mohassan';
  readonly kind: RuntimeStatusKind;
  readonly lang: 'ar' | 'en';
  readonly facts: 'provided_host_facts' | 'unknown';
  readonly text: string;
}

// Only bounded plain data from the host is accepted. Serialized/provider JSON is
// deliberately not parsed. The host binding must never forward provider output.
function plainHostData(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }], seen = new WeakSet<object>();
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (item.exit) { seen.delete(item.value as object); continue; }
    if (++count > 150 || item.depth > 5) return false;
    if (item.value === null || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'number') { if (!Number.isFinite(item.value)) return false; continue; }
    if (typeof item.value === 'string') { if (item.value.length > 80) return false; continue; }
    if (!item.value || typeof item.value !== 'object' || seen.has(item.value) || Object.getOwnPropertySymbols(item.value).length) return false;
    if (Array.isArray(item.value) && item.value.length > 8) return false;
    seen.add(item.value);
    // Shared immutable feature values are ordinary host data; only an ancestor
    // cycle is forbidden, rather than every repeated object reference.
    pending.push({ value: item.value, depth: item.depth, exit: true });
    const descriptors = Object.getOwnPropertyDescriptors(item.value);
    if (Array.isArray(item.value)) {
      if (Object.getPrototypeOf(item.value) !== Array.prototype || item.value.length > 8 || Object.keys(descriptors).length !== item.value.length + 1) return false;
      for (let index = 0; index < item.value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else {
      const prototype = Object.getPrototypeOf(item.value);
      if (prototype !== Object.prototype && prototype !== null || Object.keys(descriptors).length > 12) return false;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key.length > 40) return false;
        if (!('value' in descriptor) || !descriptor.enumerable) return false;
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    }
  }
  return true;
}
export function parseHostRuntimeFacts(input: unknown): HostRuntimeFacts | null {
  if (!input || typeof input !== 'object' || !plainHostData(input)) return null;
  const parsed = HostRuntimeFactsSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

const AR_FEATURES: ReadonlyArray<readonly [RuntimeStatusKind, string]> = [
  ['memory', '(?:الذاكره|ذاكرتي|حفظ الذاكره)'], ['knowledge', '(?:المستندات المحليه|المعرفه المحليه|البحث في المستندات|مستنداتي)'],
  ['browser', '(?:المتصفح|تصفح الويب|التصفح|متصفح الويب)'], ['computation', '(?:الحساب المحلي|الحسابات المحليه|اله حاسبه محليه)'],
  ['pc', '(?:التحكم بالحاسوب|التحكم بالكمبيوتر|التحكم بجهازي|التحكم في الكمبيوتر|التحكم في جهازي)'],
  ['ownAds', '(?:نموذج الاعلانات الخاص|نموذج الاعلانات المحلي|نموذج الاعلانات|نموذجك الخاص للاعلانات)'],
  ['b0', '(?:مراقب b0|نموذج b0 الظلي|مراقب التوجيه b0)'], ['slots', '(?:مراقب الخانات|مراقب استخراج المعلومات|نموذج الخانات الظلي)'],
];
const EN_FEATURES: ReadonlyArray<readonly [RuntimeStatusKind, string]> = [
  ['memory', '(?:memory|local memory|my memory)'], ['knowledge', '(?:local documents|local knowledge|document search|my documents)'],
  ['browser', '(?:browser|the browser|browser access|web browsing|the web browser)'], ['computation', '(?:local calculation|local computation|local arithmetic|the local calculator)'],
  ['pc', '(?:computer control|pc control|control of my computer)'], ['ownAds', '(?:the own ads model|your own ads model|the local ads model|the ads model)'],
  ['b0', '(?:the b0 shadow|the b0 shadow model|the b0 observer)'], ['slots', '(?:the slot shadow|the slot shadow model|the slot observer)'],
];
function questionText(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_REQUEST || /["`«»“”<>]/u.test(input)
    || /(?<![\p{L}\p{N}])['‘][\s\S]*?['’](?![\p{L}\p{N}])/u.test(input)) return null;
  let text = input.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670\u200e\u200f]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase().replace(/\s+/gu, ' ').trim();
  text = text.replace(/^(?:please|kindly|من فضلك|لو سمحت)[,،:\s]+/iu, '').replace(/[\s.!?؟]+$/u, '');
  return text || null;
}

/** Exact local self-status questions only. Any additional task stays with routing. */
export function recognizeRuntimeStatusRequest(input: unknown): RuntimeStatusQuestion | null {
  const text = questionText(input);
  if (!text) return null;
  const lang = /\p{Script=Arabic}/u.test(text) ? 'ar' : 'en';
  const match = (kind: RuntimeStatusKind): RuntimeStatusQuestion => Object.freeze({ kind, lang });
  if (/^(?:(?:ما\s*هو|ما) (?:الدماغ|النظام) الحالي(?: (?:في|لتطبيق) (?:mohassan|موحسن|محسن))?|ما\s*هو دماغك الحالي|ما الدماغ الذي تستخدمه(?: الان)?|ما دماغ (?:mohassan|موحسن|محسن) الحالي|what is (?:your|the) current brain|what brain are you using|what is (?:the )?current brain (?:in|of) mohassan|what brain does mohassan use|what is mohassan using as its brain)$/iu.test(text)) return match('overview');
  if (/^(?:ما\s*هو النموذج الحالي|ما (?:اسم )?النموذج الذي تستخدمه(?: الان)?|ما اسم نموذج المحادثه|هل نموذج المحادثه (?:متاح|مهيا|شغال)|هل (?:لديك|عندك) نموذج محادثه|هل توليد المحادثه متاح|ما النموذج الذي يستخدمه (?:mohassan|موحسن|محسن)|what model are you using(?: now)?|which model are you using|what model is mohassan using|(?:which|what) model does mohassan use|is (?:the )?(?:chat|conversation) model available(?: in mohassan)?|is chat generation available(?: in mohassan)?|do you have a chat model|what is the current (?:chat|conversation) model)$/iu.test(text)) return match('generation');
  if (/^(?:ما (?:هي )?(?:القدرات|الميزات|الامكانات) المتاحه(?: في (?:mohassan|موحسن|محسن))?|what (?:features|capabilities) are available(?: in mohassan)?|which features does mohassan support)$/iu.test(text)) return match('capabilities');
  if (/^(?:هل الدماغ متصل ب ?النموذج قبل وبعد و ?اثناء (?:الجواب|الرد)|هل الدماغ متصل (?:بالنموذج )?قبل (?:و ?اثناء و ?بعد|و ?بعد و ?اثناء) (?:الجواب|الرد)|هل تستخدم السياق قبل (?:و ?اثناء و ?بعد|و ?بعد و ?اثناء) (?:الجواب|الرد)|هل (?:mohassan|موحسن|محسن) يدعم السياق قبل و ?اثناء و ?بعد (?:الجواب|الرد)|is (?:the )?brain connected to (?:the )?model before[,]? during[,]? and after (?:the )?(?:answer|reply)|does mohassan support context before[,]? tools during[,]? and review after (?:the )?(?:answer|reply))$/iu.test(text)) return match('stages');
  for (const [kind, feature] of AR_FEATURES) {
    if (new RegExp(`^(?:هل ${feature} (?:متاح|متاحه|مهيا|مهياه|شغال|شغاله)|هل (?:لديك|عندك) ${feature})(?: في (?:mohassan|موحسن|محسن))?$`, 'iu').test(text)) return match(kind);
  }
  for (const [kind, feature] of EN_FEATURES) {
    if (new RegExp(`^(?:is ${feature} (?:available|configured|enabled)|does mohassan support ${feature}|do you have (?:access to )?${feature})(?: in mohassan)?$`, 'iu').test(text)) return match(kind);
  }
  if (/^(?:can you browse the web|can mohassan browse the web|هل (?:يمكنك|تستطيع) تصفح الويب)$/iu.test(text)) return match('browser');
  if (/^(?:can you (?:calculate|compute) locally|هل (?:يمكنك|تستطيع) الحساب محليا)$/iu.test(text)) return match('computation');
  if (/^(?:can you control my computer|هل (?:يمكنك|تستطيع) التحكم في جهازي)$/iu.test(text)) return match('pc');
  if (/^(?:can you search local documents|هل (?:يمكنك|تستطيع) البحث في المستندات المحليه)$/iu.test(text)) return match('knowledge');
  return null;
}

type Feature = z.infer<typeof FeatureSchema>;
const UNKNOWN: Feature = { configured: null, accountAccess: 'unknown', health: 'unknown' };
const LABELS: Record<Exclude<RuntimeStatusKind, 'overview' | 'generation' | 'capabilities' | 'stages'>, readonly [string, string]> = {
  memory: ['الذاكرة', 'Memory'], knowledge: ['المعرفة والمستندات المحلية', 'Local knowledge/documents'], browser: ['المتصفح', 'Browser'],
  computation: ['الحساب المحلي', 'Local computation'], pc: ['التحكم بالحاسوب', 'Computer control'], ownAds: ['نموذج الإعلانات الخاص', 'Own ads model'],
  b0: ['مراقب التوجيه B0', 'B0 routing shadow'], slots: ['مراقب استخراج معلومات الطلب', 'Slot extraction shadow'],
};
function featureLine(label: string, fact: Feature | undefined, ar: boolean): string {
  const value = fact ?? UNKNOWN;
  const configured = value.configured === true ? ar ? 'مهيأ' : 'configured' : value.configured === false ? ar ? 'غير مهيأ' : 'not configured' : ar ? 'التهيئة غير معروفة' : 'configuration unknown';
  const access = value.accountAccess === 'allowed' ? ar ? 'وصول الحساب مسموح' : 'account access allowed'
    : value.accountAccess === 'denied' ? ar ? 'وصول الحساب غير مسموح' : 'account access denied' : ar ? 'وصول الحساب غير معروف' : 'account access unknown';
  const health = value.health === 'verified_healthy' ? ar ? 'نجاح التشغيل موثق بإيصال فحص من المضيف' : 'successful operation backed by a host health-check receipt'
    : value.health === 'unverified' ? ar ? 'التشغيل غير متحقق منه' : 'operation unverified' : ar ? 'حالة فحص التشغيل غير معروفة' : 'health-check status unknown';
  return `${label}: ${configured}; ${access}; ${health}.`;
}
function generationLines(facts: HostRuntimeFacts | null, ar: boolean): string[] {
  const generation = facts?.generation;
  const lines = [featureLine(ar ? 'توليد المحادثة' : 'Chat generation', generation, ar)];
  if (generation?.knownModelNames?.length) lines.push(`${ar ? 'أسماء النماذج المعروفة من المضيف' : 'Known model names supplied by the host'}: ${generation.knownModelNames.join(', ')}.`);
  lines.push(`${ar ? 'النموذج النشط الذي حدده المضيف' : 'Active model explicitly identified by the host'}: ${generation?.activeModelName ?? (ar ? 'غير معروف' : 'unknown')}.`);
  return lines;
}
function stageLines(facts: HostRuntimeFacts | null, ar: boolean): string[] {
  const labels = ar ? ['قبل الجواب: تحضير السياق', 'أثناء الجواب: استخدام الأدوات', 'بعد الجواب: المراجعة'] : ['Before answering: context preparation', 'During answering: tool use', 'After answering: review'];
  return (['before', 'during', 'after'] as const).map((stage, index) => {
    const state = facts?.stages?.[stage] ?? 'unknown';
    return `${labels[index]}: ${state === 'supported' ? ar ? 'مدعوم' : 'supported' : state === 'unsupported' ? ar ? 'غير مدعوم' : 'unsupported' : ar ? 'غير معروف' : 'unknown'}.`;
  }).concat(ar ? 'هذه حالة دعم المراحل؛ تنفيذها في هذا الرد غير محدد بهذه الحقائق.' : 'These facts describe stage support; execution in this particular reply is unspecified.');
}
function shadowLine(kind: 'b0' | 'slots', facts: HostRuntimeFacts | null, ar: boolean): string {
  const state = facts?.shadows?.[kind]?.state ?? 'unknown';
  const names = ar ? { absent: 'غير موجود', disabled: 'معطل', lab_only: 'للمختبر فقط', observing: 'يراقب', unknown: 'غير معروف' }
    : { absent: 'absent', disabled: 'disabled', lab_only: 'lab only', observing: 'observing', unknown: 'unknown' };
  return `${LABELS[kind][ar ? 0 : 1]}: ${names[state]}.`;
}

/** Only the supplied, account-filtered host data can populate this answer. */
export function renderRuntimeStatus(question: RuntimeStatusQuestion, hostInput: unknown): RuntimeStatusAnswer {
  const parsed = plainHostData(question) ? QuestionSchema.safeParse(question) : { success: false as const };
  const selected = parsed.success ? parsed.data : { kind: 'overview' as const, lang: 'en' as const };
  const facts = parseHostRuntimeFacts(hostInput), ar = selected.lang === 'ar';
  const lines = [ar ? 'Mohassan — حالة التطبيق المحلية من المضيف.' : 'Mohassan — local application status from the host.'];
  if (selected.kind === 'overview') lines.push(facts?.controller
    ? ar ? `منسق التطبيق: الإصدار ${facts.controller.revision}؛ التنفيذ: قواعد المضيف وأدواته.` : `Host coordinator revision: ${facts.controller.revision}; implementation: host rules and tools.`
    : ar ? 'منسق التطبيق: الإصدار والتنفيذ غير معروفين.' : 'Host coordinator revision and implementation: unknown.');
  if (selected.kind === 'overview' || selected.kind === 'generation') lines.push(...generationLines(facts, ar));
  if (selected.kind === 'overview' || selected.kind === 'stages') lines.push(...stageLines(facts, ar));
  const features = selected.kind === 'capabilities' ? ['memory', 'knowledge', 'browser', 'computation', 'pc', 'ownAds'] as const
    : selected.kind === 'overview' ? ['ownAds'] as const : [selected.kind];
  for (const kind of features) {
    if (kind === 'b0' || kind === 'slots') lines.push(shadowLine(kind, facts, ar));
    else if (kind === 'ownAds') lines.push(featureLine(LABELS.ownAds[ar ? 0 : 1], facts?.ownAds, ar));
    else if (kind === 'memory' || kind === 'knowledge' || kind === 'browser' || kind === 'computation' || kind === 'pc')
      lines.push(featureLine(LABELS[kind][ar ? 0 : 1], facts?.capabilities?.[kind], ar));
  }
  if (selected.kind === 'overview') lines.push(shadowLine('b0', facts, ar), shadowLine('slots', facts, ar));
  return Object.freeze({ source: 'local_host_status', app: 'Mohassan', kind: selected.kind, lang: selected.lang,
    facts: facts ? 'provided_host_facts' : 'unknown', text: lines.join('\n') });
}
export function answerRuntimeStatus(request: unknown, hostInput: unknown): RuntimeStatusAnswer | null {
  const question = recognizeRuntimeStatusRequest(request);
  return question ? renderRuntimeStatus(question, hostInput) : null;
}
