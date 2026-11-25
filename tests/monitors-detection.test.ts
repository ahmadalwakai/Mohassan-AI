import { MonitorSpecSchema } from '@mohassan/contracts';
import { describe, expect, it } from 'vitest';
import { detectMonitorNeed, monitorHistoryMayMatter, type MonitorNeed } from '../apps/server/src/monitors/detection.js';
import { generateMonitorSpec, monitorNeedReply } from '../apps/server/src/monitors/spec.js';

const url = 'https://example.org/Registration';
const now = new Date('2026-11-25T15:00:00.000Z');

function need(text: string, history?: Parameters<typeof detectMonitorNeed>[0]['history']): MonitorNeed {
  const detected = detectMonitorNeed({ text, history });
  expect(monitorHistoryMayMatter(text)).toBe(true);
  expect(detected).not.toBeNull();
  return detected!;
}

describe('smart monitor need detection', () => {
  it.each([
    [`Watch this page ${url} and tell me when tickets are available.`, 'en'],
    ['Let me know if the rate drops below 3.70.', 'en'],
    [`راقب هذه الصفحة ${url} وأخبرني إذا فتحوا التسجيل`, 'ar'],
    ['نبّهني لما ينزل الدولار تحت ٣٫٧٠', 'ar'],
    [`تابع هذا الرابط ${url} وقل لي إذا تغيّر السعر`, 'ar'],
  ])('detects explicit requests (%s)', (text, language) => {
    expect(need(text)).toMatchObject({ kind: 'explicit', language, actionRequested: false });
  });

  it.each([
    [`I'm waiting for registration to open on this page ${url}.`, 'en'],
    [`أنا بانتظار أن يفتح التسجيل على هذه الصفحة ${url}`, 'ar'],
    [`I’m still waiting for a new listing to appear on ${url}.`, 'en'],
    ['I’m waiting for the USD/SAR rate to drop below 3.70.', 'en'],
  ])('detects waiting on public state (%s)', (text, language) => {
    expect(need(text)).toMatchObject({ kind: 'implicit', language });
  });

  it.each([
    [`Is registration open at ${url}?`, 'Is registration open yet?', 'en'],
    [`هل التسجيل مفتوح في ${url}؟`, 'هل التسجيل مفتوح الآن؟', 'ar'],
  ])('detects a repeated status question only after a matching user turn (%s)', (earlier, text, language) => {
    expect(detectMonitorNeed({ text })).toBeNull();
    expect(detectMonitorNeed({ text, history: [{ role: 'assistant', text: earlier }] })).toBeNull();
    expect(need(text, [{ role: 'user', text: earlier }])).toMatchObject({ kind: 'implicit', language, sourceUrl: url });
    expect(detectMonitorNeed({ text, history: [{ role: 'user', text: `Is the price lower at ${url}?` }] })).toBeNull();
  });

  it.each([
    'What is the best monitor for my computer?',
    'Explain how to monitor temperature with an Arduino.',
    'Watch this video and tell me what this page shows.',
    'Check if registration is open at https://example.org.',
    'Let me know if you are a human or are a computer.',
    'Do not watch the registration page.',
    'راقب نبضات القلب لمدة عشر دقائق',
    'ما أفضل شاشة للمراقبة؟',
    'تابع أغنية الطقس وأخبرني ما معنى الكلمات',
    'ترجم: «راقب هذه الصفحة وأخبرني إذا فتحوا التسجيل»',
    'راقب هذه الصفحة https://127.0.0.1/ لمدة ساعتين',
    'Monitor https://example.org/?token=sensitive for two hours.',
    'Monitor my private page https://example.org/ until it opens.',
  ])('leaves unrelated or ineligible requests alone (%s)', text => {
    expect(detectMonitorNeed({ text })).toBeNull();
  });

  it.each(['unreachable', 'not-published'] as const)('offers a monitor for a verified %s task block', reason => {
    const detected = detectMonitorNeed({ text: `Read the instructions at ${url}`, blocked: { url, reason } });
    expect(detected).toMatchObject({ kind: 'agent-initiated', sourceUrl: url, blocked: { reason } });
    const spec = generateMonitorSpec(detected!, now);
    expect(spec).toMatchObject({ source: { kind: 'page', url }, read: { kind: 'status' }, condition: { kind: 'equals', value: 'reachable' } });
    expect(monitorNeedReply(detected!, spec)).toContain('resume the task');
    expect(detectMonitorNeed({ text: `Read the instructions at ${url}`, blocked: { url: 'https://192.168.1.1', reason } })).toBeNull();
  });

  it('watches publication status when a reachable page specifically says it is unpublished', () => {
    const detected = detectMonitorNeed({ text: `Read the instructions at ${url}`, blocked: { url, reason: 'not-published', publicationStatus: true } });
    expect(generateMonitorSpec(detected!, now)).toMatchObject({ source: { kind: 'page', url },
      read: { kind: 'status', label: 'publication' }, condition: { kind: 'equals', value: 'published' } });
  });

  it('keeps buying and booking with the user', () => {
    const english = need(`Watch ${url} and, when tickets are available, buy two.`);
    const arabic = need(`راقب هذه الصفحة ${url} وإذا فتحوا التسجيل فسجلني`);
    expect(english.actionRequested).toBe(true);
    expect(arabic.actionRequested).toBe(true);
    expect(monitorNeedReply(english, generateMonitorSpec(english, now))).toContain('take the action yourself');
    expect(monitorNeedReply(arabic, generateMonitorSpec(arabic, now))).toContain('بيدك');
  });
});

describe('monitor specifications', () => {
  it('binds a registration condition to the requested URL and anchor', () => {
    const spec = generateMonitorSpec(need(`راقب هذه الصفحة ${url} في قسم «التسجيل الجامعي» وأخبرني إذا فتحوا التسجيل`), now);
    expect(spec).toMatchObject({ language: 'ar', source: { kind: 'page', url, anchor: 'التسجيل الجامعي' },
      read: { kind: 'status', label: 'registration' }, condition: { kind: 'contains', value: 'registration open' } });
    expect(MonitorSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('binds the two currencies and entered precision when the pair is available', () => {
    const spec = generateMonitorSpec(need('Let me know if USD/SAR crosses below 3.70.'), now);
    expect(spec).toMatchObject({ source: { kind: 'currency', base: 'USD', quote: 'SAR' }, read: { kind: 'number' },
      condition: { kind: 'crossing', direction: 'below', value: 3.7, hysteresis: 0.01 } });
    const implicit = generateMonitorSpec(need('I’m waiting for the USD/SAR rate to drop below 3.70.'), now);
    expect(implicit).toMatchObject({ source: spec?.source, condition: { kind: 'threshold', direction: 'below', value: 3.7 } });
    const followup = generateMonitorSpec(need('نبّهني لما ينزل الدولار تحت ٣٫٧٠', [{ role: 'user', text: 'كم سعر صرف الدولار مقابل الريال السعودي؟' }]), now);
    expect(followup).toMatchObject({ language: 'ar', source: spec?.source, condition: { value: 3.7 } });
  });

  it('asks for the missing source and completes the plan after the answer', () => {
    const text = 'نبّهني لما ينزل الدولار تحت ٣٫٧٠';
    const initial = need(text);
    expect(generateMonitorSpec(initial, now)).toBeNull();
    const reply = monitorNeedReply(initial);
    expect(reply).toContain('حدّد العملتين');
    const supplied = need('USD/SAR', [{ role: 'user', text }, { role: 'assistant', text: reply }]);
    expect(generateMonitorSpec(supplied, now)).toMatchObject({ source: { kind: 'currency', base: 'USD', quote: 'SAR' } });
  });

  it('binds weather location, measurement, urgency, interval and an absolute deadline', () => {
    const spec = generateMonitorSpec(need('Watch the temperature in London every 30 minutes and notify me as soon as the temperature goes below 10°C until 2026-11-26T17:00:00Z.'), now);
    expect(spec).toMatchObject({ source: { kind: 'weather', location: 'London', metric: 'temperature' },
      condition: { kind: 'threshold', direction: 'below', value: 10 }, timing: { urgency: 'urgent', initialIntervalMs: 30 * 60_000, deadline: '2026-11-26T17:00:00.000Z' } });
  });

  it('generates dry readings for search and an owned background run reference', () => {
    const search = generateMonitorSpec(need('Watch new listings for London pottery classes and notify me when they appear.'), now);
    expect(search).toMatchObject({ source: { kind: 'search', query: 'London pottery classes' }, read: { kind: 'items' }, condition: { kind: 'new-item' } });
    const weatherQuery = generateMonitorSpec(need('Watch new listings for Austin weather stations.'), now);
    expect(weatherQuery).toMatchObject({ source: { kind: 'search', query: 'Austin weather stations' } });
    const runId = '88dff4a4-ef76-4f98-b1d1-e3ef8dddee39';
    const run = generateMonitorSpec(need(`Let me know when my background run ${runId} completes.`), now);
    expect(run).toMatchObject({ source: { kind: 'run', runId }, read: { kind: 'status' }, condition: { kind: 'equals', value: 'completed' } });
  });

  it.each([
    [`Watch this page ${url} until it loads.`, { kind: 'status' }, { kind: 'equals', value: 'reachable' }],
    [`I'm waiting for this page to load at ${url}.`, { kind: 'status' }, { kind: 'equals', value: 'reachable' }],
    [`Watch ${url} and notify me when the phrase «Coming soon» disappears.`, { kind: 'phrase', phrase: 'Coming soon' }, { kind: 'disappears' }],
    [`Watch ${url} and let me know when the price drops by 5%.`, { kind: 'number', label: 'price' }, { kind: 'percent', direction: 'below', value: 5 }],
    [`Watch the release date on ${url} for 3 days.`, { kind: 'date', label: 'release date' }, { kind: 'change' }],
    [`Watch the page ${url} and let me know when there are new items.`, { kind: 'items' }, { kind: 'new-item' }],
  ])('generates a validated observation and condition (%s)', (text, read, condition) => {
    expect(generateMonitorSpec(need(text), now)).toMatchObject({ read, condition });
  });

  it('does not substitute a generic page change for an unsupported condition', () => {
    expect(generateMonitorSpec(need(`Watch ${url} and tell me if the article is convincing.`), now)).toBeNull();
  });
});
