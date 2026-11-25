import { describe, expect, it } from 'vitest';
import { buildMonitorContextFrame, MONITOR_CONTEXT_HISTORY_LIMIT, monitorContextFeatures } from '../apps/server/src/monitors/decision/frame.js';
import { reasonMonitorContext } from '../apps/server/src/monitors/decision/reasoner.js';
import { generateMonitorV2Spec } from '../apps/server/src/monitors/v2-spec.js';

// Behavior scenarios from the owner's task, with page status and management
// terminology from the existing smart monitor chat and detection suites.
const page = 'https://events.example.org/registration';
const user = (text: string) => ({ role: 'user', text });
const assistant = (text: string) => ({ role: 'assistant', text });
const cases = [
  { language: 'en', status: `Is registration open at ${page}?`, closed: 'Registration is closed now.',
    waiting: "Okay, I'm waiting for them to open it.", again: 'Is registration open yet?', price: 'How much is the dollar now?',
    time: 'Remind me tomorrow at 9', condition: `Notify me when registration opens at ${page}`,
    contextualCondition: 'Remind me when it opens.', stop: 'Stop monitoring registration',
    offer: 'Would you like me to watch this page and let you know when the status changes?', decline: 'No thanks.', accept: 'Yes please.' },
  { language: 'ar', status: `هل التسجيل مفتوح في ${page}؟`, closed: 'التسجيل مغلق الآن.',
    waiting: 'طيب، أنا أنتظر أن يفتحوه.', again: 'هل التسجيل مفتوح الآن؟', price: 'كم سعر الدولار الآن؟',
    time: 'ذكّرني غدًا الساعة 9', condition: `نبّهني عندما يفتح التسجيل في ${page}`,
    contextualCondition: 'نبّهني عندما يفتحوه.', stop: 'أوقف مراقبة التسجيل',
    offer: 'أتريد أن أراقب هذه الصفحة وأنبّهك عندما تتغيّر الحالة؟', decline: 'لا شكرًا.', accept: 'نعم من فضلك.' },
] as const;

describe.each(cases)('monitor decisions in $language', example => {
  const history = [user(example.status), assistant(example.closed)];
  const pending = (text: string) => buildMonitorContextFrame({ text, history });

  it('finds a waiting need across turns and uses the public page', () => {
    expect(reasonMonitorContext(buildMonitorContextFrame({ text: example.waiting })).decision).toBe('none');
    const frame = pending(example.waiting);
    expect(frame.previousAssistant?.pending).toBe('registration');
    expect(frame.sources).toContain(page);
    const decision = reasonMonitorContext(frame);
    expect(decision).toMatchObject({ decision: 'offer', need: { sourceUrl: page, language: example.language, kind: 'implicit' } });
    expect(decision.evidence).toContain('prior_pending_status');
    expect(generateMonitorV2Spec(decision.need!)).toMatchObject({ read: { kind: 'status', label: 'registration' },
      condition: { kind: 'contains', value: 'registration open' } });
  });

  it('infers waiting without a source so chat can ask for one', () => {
    const decision = reasonMonitorContext(buildMonitorContextFrame({ text: example.waiting, history: [user(example.closed)] }));
    expect(decision).toMatchObject({ decision: 'offer', evidence: ['prior_pending_status', 'waiting_for_change'] });
    expect(decision.need?.sourceUrl).toBeUndefined();
  });

  it('recognizes a repeated status question and leaves the first question alone', () => {
    expect(reasonMonitorContext(buildMonitorContextFrame({ text: example.status })).decision).toBe('none');
    const frame = pending(example.again);
    expect(frame.repeatedStatus).toBe(1);
    expect(reasonMonitorContext(frame)).toMatchObject({ decision: 'offer', evidence: expect.arrayContaining(['repeated_status_question']) });
  });

  it('leaves a one-off price question and a status question about a different source alone', () => {
    expect(reasonMonitorContext(pending(example.price))).toMatchObject({ decision: 'none', evidence: ['one_off_question'] });
    const elsewhere = example.status.replace(page, 'https://events.example.org/other');
    expect(reasonMonitorContext(pending(elsewhere)).decision).toBe('none');
  });

  it('routes clock triggers to reminders and condition triggers to monitor proposals', () => {
    expect(reasonMonitorContext(pending(example.time))).toMatchObject({ decision: 'reminder', evidence: ['scheduled_trigger'] });
    expect(reasonMonitorContext(pending(example.condition))).toMatchObject({ decision: 'propose', need: { sourceUrl: page } });
    expect(reasonMonitorContext(pending(example.contextualCondition))).toMatchObject({ decision: 'propose', need: { sourceUrl: page } });
  });

  it('passes a monitor management request to the existing management parser', () => {
    const proposal = reasonMonitorContext(pending(example.condition));
    const spec = generateMonitorV2Spec(proposal.need!)!;
    const frame = buildMonitorContextFrame({ text: example.stop, history, monitors: [{ spec, status: 'active' }],
      reminders: [{ status: 'scheduled', recurrence: null }] });
    expect(reasonMonitorContext(frame)).toMatchObject({ decision: 'manage', management: { kind: 'stop', language: example.language },
      evidence: ['management_command', 'existing_monitors'] });
    expect(monitorContextFeatures(frame)).toMatchObject({ monitorCount: 1, reminderCount: 1, scheduledReminders: 1 });
  });

  it('does not repeat an offer the user declined and remembers acceptances', () => {
    const historyWithOffer = [...history, assistant(example.offer)];
    const frame = buildMonitorContextFrame({ text: example.again, history: [...historyWithOffer, user(example.decline)] });
    expect(reasonMonitorContext(frame)).toMatchObject({ decision: 'none', evidence: ['earlier_decline'] });
    expect(monitorContextFeatures(frame).declinedCount).toBe(1);
    const accepted = buildMonitorContextFrame({ text: example.again, history: [...historyWithOffer, user(example.accept)] });
    expect(reasonMonitorContext(accepted)).toMatchObject({ decision: 'none', evidence: ['earlier_acceptance'] });
    expect(monitorContextFeatures(accepted).acceptedCount).toBe(1);
  });
});

describe('monitor context boundaries', () => {
  it('uses the existing bounded transcript replay and response work mode', () => {
    const history = Array.from({ length: MONITOR_CONTEXT_HISTORY_LIMIT + 1 }, () => user('What is the population of Paris?'));
    const frame = buildMonitorContextFrame({ text: `Watch this page ${page} every hour until registration opens`, history });
    expect(frame.history).toHaveLength(MONITOR_CONTEXT_HISTORY_LIMIT);
    expect(frame.topic).toMatchObject({ entity: 'Paris', property: 'population' });
    expect(frame.entities.length).toBeGreaterThan(0);
    expect(frame.workMode).toBe('long_running');
  });

  it('honors the request to ignore earlier turns', () => {
    const frame = buildMonitorContextFrame({ text: "Ignore previous messages. I'm waiting for them to open it.",
      history: [user(`Is registration open at ${page}?`), assistant('Registration is closed.')] });
    expect(frame.history).toHaveLength(0);
    expect(reasonMonitorContext(frame).decision).toBe('none');
  });

  it('treats assistant links as evidence for pending state without using them as the public source', () => {
    const frame = buildMonitorContextFrame({ text: 'I am waiting for it to open.',
      history: [user('Is registration open?'), assistant(`Registration is closed at ${page}.`)] });
    expect(frame.previousAssistant?.pending).toBe('registration');
    expect(frame.sources).toContain(page);
    expect(frame.sourceUrl).toBeUndefined();
  });

  it('does not infer a pending state from a question, speculation, or a resolved report', () => {
    for (const status of ['Is registration closed?', 'Registration might be closed.', 'Registration is open now.']) {
      const frame = buildMonitorContextFrame({ text: 'I am waiting for it to open.', history: [user(`Is registration open at ${page}?`), assistant(status)] });
      expect(reasonMonitorContext(frame).decision).toBe('none');
    }
  });
});
