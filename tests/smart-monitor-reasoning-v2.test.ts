import { MonitorCardSchema, MonitorSpecSchema, type MonitorSpec, type MonitorV2Target } from '@mohassan/contracts';
import { describe, expect, it } from 'vitest';
import { detectMonitorNeed } from '../apps/server/src/monitors/detection.js';
import { monitorV2EvidenceMessage } from '../apps/server/src/monitors/delivery-v2.js';
import type { MonitorObservation } from '../apps/server/src/monitors/evaluation.js';
import { evaluateMonitorV2, monitorV2DigestDueAt, type MonitorV2EvaluationState } from '../apps/server/src/monitors/evaluation-v2.js';
import { monitorTiming } from '../apps/server/src/monitors/schedule.js';
import { generateMonitorV2Spec } from '../apps/server/src/monitors/v2-spec.js';

const hour = 60 * 60_000;
const start = Date.UTC(2026, 10, 25, 16);
const at = (hours: number) => new Date(start + hours * hour);
const url = 'https://fixtures.example/price';
const observation = (value: MonitorObservation['value'], hours: number, index = 0): { index: number; observation: MonitorObservation } => ({
  index, observation: { value, observedAt: at(hours).toISOString(), excerpt: String(value), url },
});
const numeric = (index: number): MonitorV2Target => ({ source: { kind: 'page', url: `${url}/${index}` },
  read: { kind: 'number' }, condition: { kind: 'threshold', direction: 'above', value: 100, hysteresis: 1 }, freshnessMs: 2 * hour });
const base: MonitorSpec = {
  source: { kind: 'page', url }, read: { kind: 'number' }, condition: { kind: 'change' }, language: 'en', title: 'Price', message: 'Price changed.',
  timing: monitorTiming('page', 'normal', { now: at(0) }),
};
const composite = (combine: NonNullable<NonNullable<MonitorSpec['v2']>['combine']>, additional = [numeric(1)]): MonitorSpec => ({
  ...base, condition: numeric(0).condition, v2: { freshnessMs: hour, combine, additional },
});
function track(spec: MonitorSpec) {
  let state: MonitorV2EvaluationState | undefined;
  return (hrs: number, samples: Parameters<typeof evaluateMonitorV2>[2], options?: Parameters<typeof evaluateMonitorV2>[4]) => {
    const result = evaluateMonitorV2(spec, state, samples, at(hrs), options);
    state = result.state;
    return result;
  };
}

describe('v2 condition evaluation', () => {
  it('waits for three independently fresh matches and rejects invalidated or out-of-order readings', () => {
    const spec = composite({ kind: 'and' }, [numeric(1), numeric(2)]);
    const evaluate = track(MonitorSpecSchema.parse(spec));
    evaluate(0, [observation(99, 0), observation(99, 0, 1), observation(99, 0, 2)]);
    expect(evaluate(1, [observation(101, 1), observation(101, 1, 1)]).notice).toBeUndefined();
    expect(evaluate(2, [observation(101, 2, 2)], { invalidated: [0] }).notice).toBeUndefined();
    expect(evaluate(2.5, [observation(101, 0.25)]).notice).toBeUndefined();
    expect(evaluate(3, [observation(101, 3)]).notice?.evidence.map(item => item.index)).toEqual([0, 1, 2]);
    expect(evaluate(4, [observation(101, 4, 1)]).notice).toBeUndefined();
    expect(MonitorSpecSchema.safeParse(composite({ kind: 'and' }, [numeric(1), numeric(2), numeric(3)])).success).toBe(false);
  });

  it('lets one fresh OR branch satisfy the monitor without treating a stale positive as fresh', () => {
    const evaluate = track(composite({ kind: 'or' }));
    evaluate(0, [observation(99, 0), observation(99, 0, 1)]);
    expect(evaluate(3, [observation(120, 1)]).notice).toBeUndefined();
    expect(evaluate(4, [observation(110, 4, 1)]).notice?.evidence.map(item => item.index)).toEqual([1]);
  });

  it('requires a separately observed A before B within both freshness and the sequence window', () => {
    const evaluate = track(composite({ kind: 'sequence', windowMs: 2 * hour }));
    evaluate(0, [observation(99, 0), observation(99, 0, 1)]);
    expect(evaluate(0.5, [observation(115, 0.5, 1)]).notice).toBeUndefined();
    evaluate(1, [observation(98, 1, 1), observation(112, 1)]);
    expect(evaluate(1.5, [observation(116, 1.5, 1)]).notice?.evidence.map(item => item.after.value)).toEqual([112, 116]);
    evaluate(2, [observation(98, 2), observation(98, 2, 1)]);
    expect(evaluate(3, [observation(112, 3), observation(116, 3, 1)]).notice).toBeUndefined();
    evaluate(4, [observation(98, 4, 1)]);
    expect(evaluate(4.5, [observation(116, 4.5, 1)]).notice).toBeUndefined();
  });

  it('keeps provisional text changes out of evaluation until a second read confirms them', () => {
    const evaluate = track({ ...base, source: { kind: 'page', url, anchor: 'Section' }, read: { kind: 'main' } });
    const page = (text: string, hours: number) => ({ index: 0, observation: { ...observation(text, hours).observation, blocks: [{ key: 'main', text }] } });
    evaluate(0, [page('Initial', 0)]);
    expect(evaluate(1, [page('Updated', 1)])).toMatchObject({ changed: false, needsConfirmation: true });
    const confirmed = evaluate(2, [{ ...page('Updated', 1), revalidated: true }]);
    expect(confirmed.needsConfirmation).toBe(false);
    expect(confirmed.notice?.evidence[0]).toMatchObject({ before: { value: 'Initial' }, after: { value: 'Updated', observedAt: at(2).toISOString() } });
  });

  it('requires independent confirmations for page-wide text and drops variants that return to baseline', () => {
    const evaluate = track({ ...base, read: { kind: 'main' } });
    const page = (publication: string, variant: string, hours: number) => ({ index: 0, observation: {
      ...observation(`${publication} ${variant}`, hours).observation,
      blocks: [{ key: 'publication', text: publication }, { key: 'edition', text: variant }],
    } });
    const before = 'Publishing is pending.';
    const after = 'Publishing is approved.';
    evaluate(0, [page(before, 'Edition A', 0)]);
    expect(evaluate(0.5, [page(before, 'Edition B', 0.5)]).confirmNoEarlierThan).toBe(at(1.5).getTime());
    expect(evaluate(0.75, [page(before, 'Edition B', 0.75)]).notice).toBeUndefined();
    expect(evaluate(1.5, [page(before, 'Edition B', 1.5)]).notice).toBeUndefined();
    expect(evaluate(2.5, [page(after, 'Edition A', 2.5)]).notice).toBeUndefined();
    expect(evaluate(3.5, [page(after, 'Edition B', 3.5)]).notice).toBeUndefined();
    expect(evaluate(4.5, [page(after, 'Edition B', 4.5)]).notice?.evidence[0].after.excerpt).toBe(after);
  });

  it('uses any valid baseline within the rolling window and calculates before/after evidence', () => {
    const spec: MonitorSpec = { ...base, v2: { freshnessMs: hour, trend: { kind: 'percent-window', direction: 'fall', percent: 2, windowMs: 24 * hour } } };
    const evaluate = track(spec);
    evaluate(0, [observation(105, 0)]);
    evaluate(25, [observation(100, 25)]);
    expect(evaluate(27, [observation(99, 27)]).notice).toBeUndefined();
    const { notice } = evaluate(32, [observation(98, 32)]);
    expect(notice?.evidence).toEqual([{ index: 0, before: observation(100, 25).observation, after: observation(98, 32).observation,
      absolute: 98 - 100, percent: 100 * ((98 - 100) / 100) }]);
    expect(monitorV2EvidenceMessage(spec, notice!)).toContain('Percent change · -2%');
    expect(monitorV2EvidenceMessage(spec, notice!)).toContain(`[Source](<${url}>)`);
    expect(monitorV2EvidenceMessage({ ...spec, language: 'ar', message: 'تغيّر السعر.' }, notice!)).toContain('بعد · ٩٨');
  });

  it('counts consecutive rises and resets on equal observations or a stale gap', () => {
    const evaluate = track({ ...base, v2: { freshnessMs: hour, trend: { kind: 'consecutive', direction: 'rise', checks: 3 } } });
    evaluate(0, [observation(10, 0)]);
    evaluate(1, [observation(11, 1)]);
    evaluate(2, [observation(12, 2)]);
    expect(evaluate(4, [observation(13, 4)]).notice).toBeUndefined();
    evaluate(5, [observation(14, 5)]);
    evaluate(6, [observation(14, 6)]);
    expect(evaluate(7, [observation(15, 7)]).notice).toBeUndefined();
    expect(evaluate(8, [observation(16, 8)]).notice).toBeUndefined();
    expect(evaluate(9, [observation(17, 9)]).notice?.evidence[0]).toMatchObject({ before: { value: 14 }, after: { value: 17 }, absolute: 3 });
  });

  it('deduplicates recurring items and flushes daily evidence once without a source read', () => {
    const spec: MonitorSpec = { ...base, read: { kind: 'items' }, condition: { kind: 'new-item' }, v2: { freshnessMs: hour, delivery: 'daily' } };
    const evaluate = track(MonitorSpecSchema.parse(spec));
    evaluate(0, [observation(['First'], 0)]);
    expect(evaluate(1, [observation(['Second', 'First'], 1)]).notice).toBeUndefined();
    expect(evaluate(2, [observation(['First'], 2)]).notice).toBeUndefined();
    expect(evaluate(3, [observation(['Third', 'Second', 'First'], 3)]).notice).toBeUndefined();
    const waiting = evaluate(7, []);
    expect(waiting.notice).toBeUndefined();
    expect(monitorV2DigestDueAt(spec, waiting.state)).toEqual(at(8));
    expect(evaluate(8, [], { canDeliver: false }).notice).toBeUndefined();
    const result = evaluate(9, []);
    expect(result.notice).toMatchObject({ digest: true, events: 2,
      evidence: [{ before: { value: ['First'] }, after: { value: ['Third', 'Second', 'First'], excerpt: 'Second · Third' } }] });
    expect(monitorV2EvidenceMessage(spec, result.notice!)).toContain('Daily monitor digest');
    expect(evaluate(9, []).notice).toBeUndefined();

    const immediate = track({ ...spec, v2: { freshnessMs: hour, delivery: 'each' } });
    immediate(0, [observation(['A'], 0)]);
    expect(immediate(1, [observation(['A', 'B'], 1)]).notice?.evidence[0].after.excerpt).toBe('B');
    expect(immediate(2, [observation(['A'], 2)]).notice).toBeUndefined();
    expect(immediate(3, [observation(['B', 'A'], 3)]).notice).toBeUndefined();
    expect(immediate(4, [observation(['B', 'C', 'A'], 4)]).notice?.evidence[0].after.excerpt).toBe('C');
  });
});

describe('v2 condition specifications', () => {
  const parse = (text: string) => generateMonitorV2Spec(detectMonitorNeed({ text })!, at(0));

  it('parses trend and recurrence requests in English and Arabic', () => {
    expect(parse(`Monitor ${url} and notify me when its price falls 2% within 24 hours`)?.v2?.trend)
      .toEqual({ kind: 'percent-window', direction: 'fall', percent: 2, windowMs: 24 * hour });
    expect(parse(`Watch ${url} and tell me when its price rises three checks in a row`)?.v2?.trend)
      .toEqual({ kind: 'consecutive', direction: 'rise', checks: 3 });
    expect(parse(`راقب ${url} ونبهني إذا ينخفض السعر بنسبة ٢٪ خلال ٢٤ ساعة`)?.v2?.trend)
      .toEqual({ kind: 'percent-window', direction: 'fall', percent: 2, windowMs: 24 * hour });
    expect(parse(`راقب ${url} عندما يرتفع السعر ثلاث مرات متتالية`)?.v2?.trend)
      .toEqual({ kind: 'consecutive', direction: 'rise', checks: 3 });
    expect(parse(`Notify me every time a new item appears at ${url}`)?.v2?.delivery).toBe('each');
    expect(parse(`راقب ${url} وأرسل ملخص يومي كلما ظهر عنصر جديد`)?.v2?.delivery).toBe('daily');
  });

  it('parses composite operators and per-source freshness without flattening a malformed sequence', () => {
    const second = 'https://fixtures.example/registration';
    expect(parse(`Monitor ${url} when price falls below 50 and ${second} when registration opens fresh within 1 hour`)?.v2)
      .toMatchObject({ combine: { kind: 'and' }, additional: [{ freshnessMs: hour, source: { kind: 'page', url: second } }] });
    expect(parse(`Monitor ${url} when price falls below 50 or ${second} when registration opens`)?.v2?.combine).toEqual({ kind: 'or' });
    expect(parse(`Monitor ${url} when price falls below 50, then ${second} when registration opens within 24 hours`)?.v2?.combine)
      .toEqual({ kind: 'sequence', windowMs: 24 * hour });
    expect(parse(`Monitor ${url} when price falls below 50, then ${second} when registration opens`)).toBeNull();
    expect(parse(`Monitor ${url} when product name changes`)?.v2?.target).toEqual({ property: 'productName' });
    expect(parse(`Monitor ${url} when the event start date changes`)?.v2?.target).toEqual({ property: 'startDate' });
    expect(parse(`Monitor ${url} when the application deadline changes`)?.v2?.target).toBeUndefined();
  });

  it('accepts one clarification with two through four options carrying observed values', () => {
    const choices = [100, 120].map((value, index) => ({ id: String(index), label: String(value), value }));
    const card = { id: 'f7afcb00-4308-4c01-a566-7de4086aa110', conversationId: 'f7afcb00-4308-4c01-a566-7de4086aa111',
      spec: base, status: 'paused', current: null, lastCheckedAt: null, nextCheckAt: null, expiresAt: at(24).toISOString(),
      clarification: { question: 'Which price should I watch?', choices } };
    expect(MonitorCardSchema.safeParse(card).success).toBe(true);
    expect(MonitorCardSchema.safeParse({ ...card, clarification: { ...card.clarification, choices: choices.slice(0, 1) } }).success).toBe(false);
  });
});
