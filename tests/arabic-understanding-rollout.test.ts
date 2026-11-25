import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideRequestRoute, type RequestRoutingInput } from '../apps/server/src/assistant/routing-decision.js';
import { bootstrapRequestContext } from '../apps/server/src/assistant/request-context.js';
import { parseHands } from '../apps/server/src/assistant/hands.js';
import { requestScopeActionText, reviewPublicProjection } from '../apps/server/src/assistant/request-scope.js';
import { emptyConversationState, understandTurn } from '../apps/server/src/assistant/conversation-state.js';
import { understandRequest } from '../apps/server/src/assistant/understanding/index.js';
import { boundUnderstanding, resolveWithArabicUnderstanding, routeWithArabicUnderstanding } from '../apps/server/src/assistant/understanding/rollout.js';

// Agent-written development cases. They are used only as software tests.
const capabilities = { browser: true, search: true };
const now = new Date('2026-11-25T12:00:00Z');
const input = (text: string): RequestRoutingInput => ({ text, capabilities, now, turnId: 'test-turn' });
const flag = 'MOHASSAN_ARABIC_UNDERSTANDING';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Arabic understanding rollout', () => {
  it('returns the shared normalization, question and lemma keys for the same message', () => {
    const text = 'امتى استقلت الجزائر وبدأ استقلالها؟';
    expect(understandRequest(text)).toMatchObject({ displayText: text, matchText: 'متي استقلت الجزاءر وبدا استقلالها؟',
      question: { questionWord: 'متى', answerType: 'time' }, lemmaKeys: expect.arrayContaining(['استقلال']) });
  });

  it('logs the difference and keeps the pinned decision with the flag unset', () => {
    vi.stubEnv(flag, undefined);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const request = input('مرحبا فين تقع كندا؟');
    const legacy = decideRequestRoute(request);
    expect(legacy.handler).not.toBe('search');
    expect(routeWithArabicUnderstanding(request)).toEqual(legacy);
    expect(log).toHaveBeenCalledTimes(1);
    const record = log.mock.calls[0]![0] as string;
    expect(JSON.parse(record)).toMatchObject({ event: 'arabic_understanding_shadow_difference', active: false,
      normalizedRoute: 'web_search', answerType: 'place' });
    expect(record).not.toMatch(/مرحبا|فين|كندا|أين/u);
  });

  it('selects the normalized decision and carries the same view into the public search guard', () => {
    vi.stubEnv(flag, '1');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const request = input('مرحبا فين تقع كندا؟');
    const decision = routeWithArabicUnderstanding(request);
    expect(decision).toMatchObject({ handler: 'search', sourceAssessment: { source: 'public_lookup' },
      resolution: { original: request.text, resolved: request.text, understanding: { question: { answerType: 'place' } } } });
    const understanding = boundUnderstanding(request.text, decision.resolution);
    expect(understanding).toBe(decision.resolution.understanding);
    expect(boundUnderstanding('غيرت طلبي', decision.resolution)).toBeUndefined();
    expect(reviewPublicProjection(request.text, decision.publicQuery!, { understanding }).eligible).toBe(true);
    expect(reviewPublicProjection(request.text, decision.publicQuery!).eligible).toBe(false);
    expect(routeWithArabicUnderstanding(input('صباح الخير فين تقع كندا؟')).handler).toBe('search');
  });

  it('keeps inquiries about owned records, quoted payloads and explicit prohibitions away from public search', () => {
    vi.stubEnv(flag, '1');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const text of ['ايه الباسورد بتاعي؟', 'شنو ملاحظاتنا؟', '«وين يقع الأرشيف؟»',
      'لخص هذا النص: وين يتخزن الرقم؟', 'لا تبحث في الويب. فين عاصمة كندا؟',
      'مش عايزك تبحث في الويب، فين عاصمة كندا؟', 'ايه رقم جوازي؟', 'ايه رقم حساب البنك بتاعي؟',
      'ايه بيانات الزبون بتاعي؟', 'رقم موبايلي فين؟', 'رقم البطاقة بتاعتي كان ايه؟', 'ايه رقم بطاقتي؟', 'شنو هو راتبي؟']) {
      const decision = routeWithArabicUnderstanding(input(text));
      expect(decision.publicQuery, text).toBeNull();
      expect(decision.sourceAssessment.publicQueryEligible, text).toBe(false);
    }
  });

  it('does not make neighboring clauses public because a new question was recognized', () => {
    vi.stubEnv(flag, '1');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const text of ['Confidential: Project Phoenix launches on Tuesday. Where is Paris?',
      'سر الشركة، فين باريس؟', 'فين باريس؟ سر الشركة يبدأ الثلاثاء.']) {
      const decision = routeWithArabicUnderstanding(input(text));
      expect(decision.publicQuery, text).toBeNull();
      expect(decision.sourceAssessment.publicQueryEligible, text).toBe(false);
    }
  });

  it('preserves browser field values and click labels with the flag on', () => {
    vi.stubEnv(flag, '1');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const [text, step] of [
      ['اكتب فين في حقل البحث', { kind: 'type', text: 'فين' }],
      ['اكتب ١٢٣ في حقل الرقم', { kind: 'type', text: '١٢٣' }],
      ['اضغط على زر فين', { kind: 'click', target: 'فين' }],
    ] as const) {
      const { resolution } = routeWithArabicUnderstanding(input(text));
      expect(parseHands(requestScopeActionText(text, boundUnderstanding(text, resolution))), text).toMatchObject([step]);
    }
  });

  it('passes a dialect question to conversation state through its v1 view without changing its original', () => {
    vi.stubEnv(flag, '1');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const text = 'ايه هي عاصمة كندا؟';
    const { resolution } = routeWithArabicUnderstanding(input(text));
    const turn = understandTurn(emptyConversationState(), text, 'test-turn', resolution.understanding);
    expect(turn).toMatchObject({ v1: { original: text, scope: 'public' }, property: 'capital' });
  });

  it('keeps pending slot values literal and treats a complete dialect question as a new request', () => {
    vi.stubEnv(flag, '1');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const previous = bootstrapRequestContext([{ text: 'What is the weather in Paris?' }]);
    const options = { turnId: 'answer-turn', pendingQuestion: { id: 'place-card', fields: ['place' as const] } };
    expect(resolveWithArabicUnderstanding('فِين', previous, options)).toMatchObject({ kind: 'answer', slots: [{ kind: 'place', value: 'فِين' }] });
    expect(resolveWithArabicUnderstanding('وين ألقى الدواء؟', previous, options)).toMatchObject({ kind: 'new', scope: 'public' });
  });

  it('keeps the historical greeting question on search in both modes', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const mode of [undefined, '1']) {
      vi.stubEnv(flag, mode);
      expect(routeWithArabicUnderstanding(input('مرحبا، لماذا تهاجر الطيور؟')).handler).toBe('search');
    }
  });
});
