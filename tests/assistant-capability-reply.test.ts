import { describe, expect, it, vi } from 'vitest';
import { evaluateCapabilityReply, type CapabilityReplyRouting } from '../apps/server/src/assistant/capability-reply.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import type { LocalReply } from '../apps/server/src/assistant/mind/limits.js';

const missing = (route: CapabilityReplyRouting['route'], missingCapabilities: CapabilityReplyRouting['missingCapabilities']): CapabilityReplyRouting => ({
  route, intent: route === 'reply' || route === 'clarify' ? 'unknown' : route, handler: 'unsupported',
  availability: 'missing_capability', missingCapabilities, reason: 'missing_capability',
});
const reminder = missing('reminder', ['reminders']);
const task = { handlersExhausted: true, execution: 'not_started' as const };
const verifiedPart: LocalReply = { status: 'partial', text: '7 + 3 = 10',
  claims: [{ text: '7 + 3 = 10', status: 'confirmed', support: ['calculation-1'] }],
  evidence: [{ id: 'calculation-1', source: 'computed', quote: '7 + 3 = 10', value: '10' }] };

describe('truthful capability gaps', () => {
  it.each([
    ['Remind me to call the supplier tomorrow.', reminder, 'reminder and scheduling'],
    ['Translate this note into Arabic.', missing('writing', ['writerModel']), 'free writing or translation'],
    ['Read the window on my computer.', missing('pc', ['computer']), 'computer-control tool'],
    ['What is my saved supplier reference?', missing('memory', ['memory']), 'memory tool'],
    ['Find the area of a rectangle 11 metres long and 6 metres wide.', missing('compute', ['chatModel']), 'kind of calculation'],
    ['Search for the current train timetable.', missing('web_search', ['browser']), 'not fully available'],
    ['Create an image of a tree.', missing('image', ['imageModel']), 'Image generation'],
  ] as const)('reports the precise unfinished capability for %s', (request, route, expected) => {
    const reply = evaluateCapabilityReply(request, route, task);
    expect(reply).toMatchObject({ status: 'blocked', evidence: [], claims: [{ status: 'fixed', support: [] }] });
    expect(reply?.text).toContain(expected);
    expect(reply?.text).toContain('haven’t performed');
    expect(reply?.text).not.toContain('Groq');
  });

  it.each([
    ['ذكرني بالموعد بكرة', reminder, 'التذكير والجدولة'],
    ['ترجم الرسالة إلى الإنجليزية', missing('writing', ['writerModel']), 'الكتابة الحرة أو الترجمة'],
    ['اقرأ النافذة على جهازي', missing('pc', ['computer']), 'التحكم بالكمبيوتر'],
    ['ما رمز المورد في ذاكرتي؟', missing('memory', ['memory']), 'أداة الذاكرة'],
    ['احسب مساحة مثلث من هذه المعطيات', missing('compute', ['chatModel']), 'هذا النوع من الحساب'],
  ] as const)('localizes an unfinished request without claiming success: %s', (request, route, expected) => {
    const reply = evaluateCapabilityReply(request, route, task);
    expect(reply?.status).toBe('blocked');
    expect(reply?.text).toContain('لم أنفّذ');
    expect(reply?.text).toContain(expected);
  });

  it('keeps uncertain execution separate from a known unstarted request', () => {
    const unknown = evaluateCapabilityReply('Remind me tomorrow.', reminder, { handlersExhausted: true });
    expect(unknown?.text).toContain('haven’t verified completion');
    expect(unknown?.text).not.toContain('haven’t performed');
    const arabic = evaluateCapabilityReply('ذكرني غدًا', reminder, { handlersExhausted: true });
    expect(arabic?.text).toContain('لم أؤكد إتمام');
  });

  it('names account restrictions without requesting global privileges or disabling approvals', () => {
    const route = { ...missing('pc', []), availability: 'restricted' as const, reason: 'account_restriction' as const };
    const reply = evaluateCapabilityReply('افتح إعدادات جهازي', route, task);
    expect(reply?.status).toBe('blocked');
    expect(reply?.text).toContain('للحساب الحالي');
    expect(reply?.text).toContain('بالإجراء المحدد');
    expect(reply?.text).not.toMatch(/صلاحيات كاملة|صلاحيات المسؤول|تعطيل الموافقات|كل الصلاحيات/iu);
  });

  it('offers only the alternative routes the host explicitly supplied', () => {
    const request = 'Translate the meeting note.';
    const route = missing('writing', ['writerModel']);
    expect(evaluateCapabilityReply(request, route, task)?.text).not.toContain('recipient');
    expect(evaluateCapabilityReply(request, route, { ...task, alternatives: ['letter_template'] })?.text).toContain('recipient, purpose, details and signature');
    expect(evaluateCapabilityReply('احسب مساحة الدائرة', missing('compute', ['chatModel']), { ...task, alternatives: ['local_calculation'] })?.text).toContain('الأرقام وعلامات العمليات');
  });
});

describe('existing useful execution keeps priority', () => {
  it.each([
    'Calculate (3 + 7) * 4.', 'Who created you?', 'Write an apology letter to a customer.', 'Plan my week.',
    'Open https://fern.example', 'Search the public web for ferry times in Dover.',
  ])('returns no fallback for a ready deterministic handler: %s', request => {
    const routing = decideRequestRoute({ text: request, capabilities: { browser: true, search: true, planner: true } });
    expect(routing.availability).toBe('ready');
    expect(evaluateCapabilityReply(request, routing)).toBeNull();
  });

  it('does not label a declared adapter missing merely because no general chat model exists', () => {
    const ready: CapabilityReplyRouting = { ...missing('pc', []), availability: 'ready', handler: 'computer', reason: 'explicit_handler' };
    expect(evaluateCapabilityReply('Read my computer window.', ready)).toBeNull();
    const exhausted = evaluateCapabilityReply('Read my computer window.', ready, task);
    expect(exhausted?.status).toBe('blocked');
    expect(exhausted?.text).toContain('did not complete');
    expect(exhausted?.text).not.toContain('tool is unavailable');
  });

  it('does not replace a local arithmetic boundary with an unavailable-model message', () => {
    const routing = decideRequestRoute({ text: 'Calculate 1 / 0.' });
    expect(routing.localReply?.status).toBe('blocked');
    expect(evaluateCapabilityReply('Calculate 1 / 0.', routing)).toBeNull();
  });

  it('leaves missing-context decisions to the existing clarification handler', () => {
    const routing = decideRequestRoute({ text: 'What about it?' });
    expect(routing.availability).toBe('needs_context');
    expect(evaluateCapabilityReply('What about it?', routing)).toBeNull();
    expect(evaluateCapabilityReply('What about it?', routing, task)).toMatchObject({ status: 'blocked', text: expect.stringContaining('Name the subject') });
  });
});

describe('availability explanations never complete modal action requests', () => {
  it.each(['Do you support reminders?', 'Is reminder scheduling available?', 'هل ميزة التذكير متاحة؟', 'هل تدعم الجدولة؟'])('%s', request => {
    expect(evaluateCapabilityReply(request, reminder, { purpose: 'capability_question' })).toMatchObject({ status: 'completed', evidence: [], claims: [{ status: 'fixed' }] });
  });

  it.each([
    'Can you remind me to call the supplier tomorrow?', 'Could you schedule a reminder at noon?',
    'Do you support reminders? Remind me tomorrow.', 'هل يمكنك تذكيري بالموعد غدًا؟',
    'هل تقدر تحط تذكير بكرة؟', 'هل تدعم التذكيرات ثم ذكرني غدًا؟',
  ])('keeps a requested reminder blocked: %s', request => {
    expect(evaluateCapabilityReply(request, reminder, { ...task, purpose: 'capability_question' })?.status).toBe('blocked');
  });

  it.each(['هل يمكنك كتابة قصة عن شركة نور؟', 'Can you translate this private note?', 'Do you support free writing? Write a story.'])('keeps an overlapping writing action blocked: %s', request => {
    expect(evaluateCapabilityReply(request, missing('writing', ['writerModel']), { ...task, purpose: 'capability_question' })?.status).toBe('blocked');
  });

  it('does not interpret context uncertainty as proof that a configured capability is missing', () => {
    const unclear = { ...reminder, availability: 'needs_context' as const };
    expect(evaluateCapabilityReply('Do you support reminders?', unclear, { purpose: 'capability_question' })).toBeNull();
    expect(evaluateCapabilityReply('Do you support reminders?', unclear, { ...task, purpose: 'capability_question' })?.text).toContain('Name the subject');
  });
});

describe('partial results, privacy and legacy state', () => {
  it('preserves a host-verified partial answer without promoting the whole task to completed', () => {
    const original = structuredClone(verifiedPart);
    const reply = evaluateCapabilityReply('Calculate the total and remind me tomorrow.', reminder, { ...task, partialResult: verifiedPart });
    expect(reply?.status).toBe('partial');
    expect(reply?.text).toContain('7 + 3 = 10');
    expect(reply?.text).toContain('haven’t verified completion');
    expect(reply?.evidence).toEqual(verifiedPart.evidence);
    expect(verifiedPart).toEqual(original);
  });

  it('preserves the exact host-verified text and quotation rather than silently normalizing evidence', () => {
    const partial = { ...verifiedPart, text: '  7 + 3 = 10  ', evidence: [{ ...verifiedPart.evidence[0], quote: '  7 + 3 = 10  ' }] };
    const reply = evaluateCapabilityReply('Calculate and remind me.', reminder, { ...task, partialResult: partial });
    expect(reply?.text.startsWith('  7 + 3 = 10  \n')).toBe(true);
    expect(reply?.evidence[0].quote).toBe('  7 + 3 = 10  ');
  });

  it('does not accept steps, self-reported completion, unsupported evidence or unbound claims as partial progress', () => {
    const invalid: LocalReply[] = [
      { ...verifiedPart, evidence: [] }, { ...verifiedPart, status: 'completed' },
      { ...verifiedPart, evidence: [{ ...verifiedPart.evidence[0], source: 'model' as never }] },
      { ...verifiedPart, evidence: [{ ...verifiedPart.evidence[0], secret: 'SYNTHETIC_PRIVATE_DATA' } as never] },
      { ...verifiedPart, claims: [{ ...verifiedPart.claims[0], support: ['not-an-evidence-id'] }] },
    ];
    for (const partialResult of invalid) expect(evaluateCapabilityReply('Remind me tomorrow.', reminder, { ...task, partialResult })?.status).toBe('blocked');
  });

  it('never echoes raw request secrets and rejects credential-bearing partial evidence', () => {
    const secret = 'sk-SYNTHETICPRIVATEKEY1234567890';
    const reply = evaluateCapabilityReply(`Remember my API key ${secret}.`, missing('memory', ['memory']), task);
    expect(reply?.text).not.toContain(secret);
    const partialResult = { ...verifiedPart, text: `password=SYNTHETIC_PASSWORD`, evidence: [{ ...verifiedPart.evidence[0], quote: `Bearer ${secret}` }] };
    const unsafe = evaluateCapabilityReply('Remind me tomorrow.', reminder, { ...task, partialResult });
    expect(unsafe?.status).toBe('blocked');
    expect(JSON.stringify(unsafe)).not.toContain('SYNTHETIC');
  });

  it('handles absent or malformed legacy routing without inventing a missing tool', () => {
    expect(evaluateCapabilityReply('A new request', undefined)).toBeNull();
    expect(evaluateCapabilityReply('طلب جديد', undefined, task)).toMatchObject({ status: 'blocked', text: expect.stringContaining('لم أنفّذ') });
    expect(evaluateCapabilityReply('A new request', { route: 'pc', availability: 'invented', missingCapabilities: ['computer'] }, task)?.text).not.toContain('computer-control tool');
  });

  it('bounds malformed input and performs no I/O', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    try {
      expect(evaluateCapabilityReply('x'.repeat(4001), reminder, task)).toBeNull();
      expect(evaluateCapabilityReply('', reminder, task)).toBeNull();
      evaluateCapabilityReply('Remind me tomorrow.', reminder, task);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
