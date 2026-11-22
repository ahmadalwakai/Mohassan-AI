import { describe, expect, it, vi } from 'vitest';
import { reviewMemoryRecallEvidence } from '../apps/server/src/assistant/memory-recall-evidence.js';
import { verifyMemoryRecall } from '../apps/server/src/assistant/memory-recall.js';

const SCALAR = 'From my memory, return my home city only.';
const JSON_REQUEST = 'Search my memory, return JSON only with keys "color" as a string and "quantity" as a number.';
const signal = () => new AbortController().signal;
describe('host field/subject/conflict review of cached formatted recall evidence', () => {
  it.each([
    [SCALAR, 'Bristol', ['My home city is Bristol.', 'My workshop city is Leeds.'], 'Bristol'],
    ['من ذاكرتي، ما مدينتي المفضلة؟ أعد المدينة فقط.', 'مسقط', ['مدينتي المفضلة هي مسقط.', 'مدينة الورشة هي صحار.'], 'مسقط'],
    [SCALAR, 'Bristol', ['My home city is Bristol.', 'My home city is Bristol.'], 'Bristol'],
    [JSON_REQUEST, '{ "quantity": "21", "color": "Indigo" }', ['The color is Indigo.', 'The quantity is 21.'], '{"color":"Indigo","quantity":21}'],
  ] as const)('matches the independently bound canonical answer: %s', async (request, proposed, evidence, expected) => {
    const result = await reviewMemoryRecallEvidence(request, proposed, evidence, signal());
    expect(result).toMatchObject({ status: 'verified', reason: 'matched', answer: expected, reply: { status: 'completed', text: expected } });
    if (result.status !== 'verified') throw new Error('Expected complete host-bound reply.');
    expect(result.reply.claims.map(claim => claim.text).join('\n')).toBe(result.answer);
    expect(result.reply.evidence.length).toBeGreaterThan(0); expect(result.reply.evidence.every(item => item.source === 'memory')).toBe(true);
    expect(result.reply.claims.every(claim => claim.support.length > 0)).toBe(true);
  });
  it.each([
    [SCALAR, 'Leeds', ['My home city is Bristol.', 'My workshop city is Leeds.']],
    [SCALAR, 'Bristol', ['My home city is Bristol.', 'My home city is Leeds.']],
    [SCALAR, 'Leeds', ['My home city is Bristol.', 'My home city is Leeds.']],
    [SCALAR, 'Leeds', ['My home city is Bristol and my workshop city is Leeds.']],
    [JSON_REQUEST, '{"color":"21","quantity":21}', ['The color is Indigo and the quantity is 21.']],
    [JSON_REQUEST, '{"color":"Indigo","quantity":21}', ['The color is Indigo.', 'The color is Amber.', 'The quantity is 21.']],
    ['Search my memory for the gallery card, return JSON only with keys "color" as a string and "quantity" as a number.',
      '{"color":"Amber","quantity":19}', ['The gallery card color is Indigo.', 'The gallery card quantity is 21.', 'The workshop card color is Amber.', 'The workshop card quantity is 19.']],
    ['من ذاكرتي، ما مدينتي المفضلة؟ أعد المدينة فقط.', 'صحار', ['مدينتي المفضلة هي مسقط.', 'مدينة الورشة هي صحار.']],
  ] as const)('never elevates a supported substring into requested-field proof: %s', async (request, proposed, evidence) => {
    expect((await reviewMemoryRecallEvidence(request, proposed, evidence, signal())).status).not.toBe('verified');
  });
  it('keeps the old literal API unchanged while adding the independent host boundary', async () => {
    const evidence = ['My home city is Bristol.', 'My workshop city is Leeds.'];
    expect(verifyMemoryRecall('Leeds', { kind: 'value' }, evidence)).toBe('Leeds');
    expect(await reviewMemoryRecallEvidence(SCALAR, 'Leeds', evidence, signal())).toEqual({ status: 'rejected', reason: 'answer_mismatch' });
  });
  it.each([
    ['From my memory, return my depot capacity only.', '20', 'My depot capacity is not 20 vans.'],
    ['From my memory, return my depot capacity only.', '20', 'My depot capacity is less than 20 vans.'],
    ['From my memory, return my depot capacity only.', '20', 'My depot capacity is at least 20 vans.'],
    ['ما سعة المستودع في ذاكرتي؟ اذكر الرقم فقط.', '٢٠', 'سعة المستودع هي ليست ٢٠ شاحنة.'],
    ['ما سعة المستودع في ذاكرتي؟ اذكر الرقم فقط.', '٢٠', 'سعة المستودع هي أقل من ٢٠ شاحنة.'],
    ['ما سعة المستودع في ذاكرتي؟ اذكر الرقم فقط.', '٢٠', 'سعة المستودع هي ٢٠ شاحنة على الأقل.'],
    ['From my memory, return my depot capacity as JSON only with key "capacity" as a number.', '{"capacity":20}', 'My depot capacity is at least 20 vans.'],
  ])('rejects a model scalar or JSON proposal that drops a numeric qualification: %s / %s', async (request, proposed, note) => {
    const result = await reviewMemoryRecallEvidence(request, proposed, [note], signal());
    expect(result.status).not.toBe('verified');
    if ('reply' in result) expect(result.reply?.status).toBe('blocked');
  });
  it.each([
    [JSON_REQUEST, '{"color":"Indigo","quantity":21}', ['The color is Indigo and the quantity is 21.']],
    ['Search my memory, return JSON only with keys "shade" as a string.', '{"shade":"Indigo"}', ['The color is Indigo.']],
    ['Search my memory, return JSON only.', '{"arbitrary":"Indigo"}', ['The color is Indigo.']],
  ] as const)('fails closed when the host extractor cannot independently derive the requested binding: %s', async (request, proposed, evidence) => {
    expect((await reviewMemoryRecallEvidence(request, proposed, evidence, signal())).status).not.toBe('verified');
  });
  it.each([
    [null, 'Bristol', ['My home city is Bristol.']],
    [SCALAR, null, ['My home city is Bristol.']],
    [SCALAR, 'Bristol', null],
    [SCALAR, 'Bristol', [null]],
    ['x'.repeat(4001), 'Bristol', ['My home city is Bristol.']],
    [SCALAR, 'x'.repeat(4097), ['My home city is Bristol.']],
    [SCALAR, 'Bristol', ['x'.repeat(4001)]],
    [SCALAR, 'Bristol', Array(31).fill('My home city is Bristol.')],
    [SCALAR, 'Bristol', Array(30).fill('密'.repeat(2000))],
    [SCALAR, '\ud800', ['My home city is Bristol.']],
    [SCALAR, 'Bristol', ['My home city is \u0000Bristol.']],
  ])('bounds malformed data without source coercion %#', async (request, proposed, evidence) => {
    const result = await reviewMemoryRecallEvidence(request, proposed, evidence as readonly string[], signal());
    expect(result).toEqual({ status: 'rejected', reason: 'invalid_input' });
  });
  it('does not invoke an evidence getter or custom coercion', async () => {
    const getter = vi.fn(() => 'My home city is Bristol.'), evidence: string[] = [];
    Object.defineProperty(evidence, '0', { get: getter });
    expect(await reviewMemoryRecallEvidence(SCALAR, 'Bristol', evidence, signal())).toEqual({ status: 'rejected', reason: 'invalid_input' });
    expect(getter).not.toHaveBeenCalled();
  });
  it('checks cancellation before work and after its cached-evidence await', async () => {
    const before = new AbortController(), first = new Error('Synthetic before-read cancellation'); before.abort(first);
    await expect(reviewMemoryRecallEvidence(SCALAR, 'Bristol', ['My home city is Bristol.'], before.signal)).rejects.toBe(first);
    const during = new AbortController(), second = new Error('Synthetic cancellation before returning host proof');
    const pending = reviewMemoryRecallEvidence(SCALAR, 'Bristol', ['My home city is Bristol.'], during.signal);
    during.abort(second); await expect(pending).rejects.toBe(second);
  });
  it('snapshots actual cached strings before an asynchronous caller mutation', async () => {
    const evidence = ['My home city is Bristol.'], pending = reviewMemoryRecallEvidence(SCALAR, 'Bristol', evidence, signal());
    evidence[0] = 'My home city is Leeds.';
    const result = await pending;
    expect(result).toMatchObject({ status: 'verified', answer: 'Bristol' });
    if (result.status === 'verified') expect(result.reply.evidence.some(item => item.quote.includes('Leeds'))).toBe(false);
  });
});
