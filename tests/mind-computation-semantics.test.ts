import { describe, expect, it } from 'vitest';
import { compute, inspectComputationRequest } from '../apps/server/src/assistant/mind/compute.js';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import type { Frame } from '../apps/server/src/assistant/mind/contract.js';

const now = new Date('2026-11-21T05:00:00Z');
const frame = (text: string): Frame => ({ text, lang: /\p{Script=Arabic}/u.test(text) ? 'ar' : 'en', intent: 'compute', matched: [], urls: [], focus: [], answerType: null,
  timeSensitive: false, personal: false, valueOnly: false, missing: [] });

describe('source-aware numeric notation', () => {
  it.each(['Calculate 2².', 'Calculate 3⁻².', 'Calculate 2₃.', 'Convert 2² metres to centimetres.', 'Convert 2 m₂ to cm₂.'])('declines unsupported raised/lowered numeric syntax: %s', request => {
    expect(compute(frame(request), now)).toBeNull();
    expect(evaluateLocalComputation(request, now)).toBeNull();
    expect(inspectComputationRequest(request).complete).toBe(false);
  });

  it.each([
    ['Convert 2 m² to cm².', '20000'],
    ['Convert 3 m³ to litres.', '3000'],
    ['Calculate ⑫ + ⑧.', '20'],
    ['Calculate 𝟠 + 𝟚.', '10'],
  ])('preserves unambiguous unit/digit notation: %s', (request, value) => {
    expect(compute(frame(request), now)).toMatchObject({ status: 'completed', evidence: [{ value }] });
  });
});

describe('Arabic cardinal and fraction distinction before mark folding', () => {
  it.each([
    ['حوّل خمس ساعات إلى دقائق', '300'],
    ['حوّل سبع كيلومترات إلى متر', '7000'],
    ['حوّل تسع دقائق إلى ثوان', '540'],
    ['حوّل عشر ساعات إلى دقائق', '600'],
    ['حوّل خَمس ساعات إلى دقائق', '300'],
    ['حوّل خمسة أرباع الساعة إلى دقائق', '75'],
    ['حوّل خُمس ساعة إلى دقيقة', '12'],
    ['حوّل سُبع ساعة إلى دقيقة', '8.57142857142857'],
    ['حوّل خُمسين ساعة إلى دقيقة', '24'],
    ['حوّل ثلثَي ساعة إلى دقيقة', '40'],
    ['حوّل ثلاثة أرباع الساعة إلى دقيقة', '45'],
    ['حوّل 1/5 ساعة إلى دقيقة', '12'],
  ])('uses unambiguous source evidence for %s', (request, value) => {
    expect(compute(frame(request), now)).toMatchObject({ status: 'completed', evidence: [{ value }] });
    expect(evaluateLocalComputation(request, now)).toMatchObject({ status: 'completed', evidence: [{ value }] });
  });

  it.each(['حوّل خمس ساعة إلى دقيقة', 'حوّل سبع كيلوغرام إلى غرام', 'حوّل تسع ساعة إلى دقيقة', 'حوّل عشر ساعة إلى دقيقة', 'حوّل خمسين متر إلى سنتيمتر'])('declines an unmarked ambiguous cardinal/fraction: %s', request => {
    expect(compute(frame(request), now)?.status).not.toBe('completed');
    expect(evaluateLocalComputation(request, now)?.status).not.toBe('completed');
  });
});

describe('directed elapsed and remaining calendar distance', () => {
  it.each(['What day is 3 days after 2026-11-21?', 'أي يوم يكون 3 أيام بعد 2026-11-21؟'])('executes the declared shift rather than the original source weekday: %s', request => {
    expect(compute(frame(request), now)).toMatchObject({ status: 'completed', consumption: { kind: 'date_shift' }, evidence: [{ value: '2026-11-24' }] });
  });
  it.each([
    ['How many days since 2026-11-18?', '3', '2026-11-18', '2026-11-21'],
    ['How many days until 2026-11-24?', '3', '2026-11-21', '2026-11-24'],
    ['كم يوما منذ 2026-11-18؟', '3', '2026-11-18', '2026-11-21'],
    ['كم يوما حتى 2026-11-24؟', '3', '2026-11-21', '2026-11-24'],
  ])('labels the intended interval for %s', (request, value, start, end) => {
    const result = compute(frame(request), now);
    expect(result).toMatchObject({ status: 'completed', evidence: [{ value }] });
    expect(result?.evidence[0]?.quote.indexOf(start)).toBeLessThan(result?.evidence[0]?.quote.indexOf(end) ?? -1);
  });

  it.each(['How many days since 2026-11-24?', 'How many days until 2026-11-18?', 'كم يوما منذ 2026-11-24؟', 'كم يوما حتى 2026-11-18؟'])('blocks a direction contradiction rather than reporting absolute remaining days: %s', request => {
    expect(compute(frame(request), now)).toMatchObject({ status: 'blocked', evidence: [], text: expect.stringMatching(/since|until|منذ|حتى/u) });
  });

  it.each(['How many days between December 31 and January 1?', 'كم يوما بين ٣١ ديسمبر و١ يناير؟'])('requires years for a backwards yearless range: %s', request => {
    expect(compute(frame(request), now)).toMatchObject({ status: 'blocked', evidence: [], text: expect.stringMatching(/year|سنة|السنة/u) });
  });
});
