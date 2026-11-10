import { describe, expect, it } from 'vitest';
import { assessReadiness, interpretGoal, type GoalContext } from '@mohassan/cognitive';
import { cognitiveLabCases } from '../packages/learning/src/cognitive-lab.js';

/**
 * Held-out checks. The cognitive lab's task suite was written before this engine
 * and for a different purpose, so it measures unnecessary interruptions on
 * requests the engine was not tuned on. The paraphrases below are worded unlike
 * the unit fixtures in packages/cognitive/src/clarification.test.ts.
 */
const NOW = new Date('2026-11-10T12:00:00.000Z');
const caps = { models: true, search: true, browser: true, coding: true, files: true, computer: true, ads: true, adsCreate: true, skills: true };
const decide = (request: string, extra: Partial<GoalContext> = {}) => {
  const context: GoalContext = { request, capabilities: caps, now: NOW, ...extra };
  return assessReadiness(interpretGoal(context), context);
};

describe('held-out: the cognitive lab suite', () => {
  it('does not interrupt any lab task with a question or a block', () => {
    const results = cognitiveLabCases.map(spec => ({ id: spec.id, outcome: decide(spec.prompt.replaceAll('{{url}}', 'http://127.0.0.1:4555/')).outcome }));
    const interrupted = results.filter(result => result.outcome === 'ASK_USER' || result.outcome === 'BLOCKED');
    expect(results.length).toBeGreaterThanOrEqual(20);
    expect(interrupted).toEqual([]);
  });
});

describe('held-out: paraphrased requests', () => {
  const critical: [string, string[]][] = [
    ['ابنِ لي حملة جديدة داخل حسابي في جوجل ادز لعيادة أسنان', ['ads_budget']],
    ['Please build and save a search campaign in my Google Ads account for my plumbing business', ['ads_budget']],
    ['احذف الصورة القديمة من مجلد المشروع', ['file_path']],
    ['Remove the obsolete config file permanently', ['file_path']],
    ['ادخل على موقع متجري وعدّل السعر', ['target_site']],
  ];
  it.each(critical)('asks before acting on %s', (request, slots) => {
    const assessment = decide(request, { signals: { adsCreateInAccount: /حسابي|account/i.test(request) && /حمل|campaign/i.test(request) } });
    expect(assessment.outcome).toBe('ASK_USER');
    expect(assessment.question!.slots).toEqual(expect.arrayContaining(slots));
  });

  const complete = [
    'ترجم هذه الجملة إلى الفرنسية: صباح الخير يا أصدقائي',
    'What are three good names for a coffee shop by the sea?',
    'اشرح لي الفرق بين التضخم والانكماش بأسلوب بسيط',
    'Search for the opening hours of the British Museum today',
    'اقترح خمس كلمات مفتاحية لحملة إعلانات جوجل لمتجر ورد في جدة',
    'Write two Google Ads headlines for a Glasgow locksmith',
    'افتح https://example.com واقرأ لي العنوان الرئيسي',
    'لخص لي هذا النص: الذكاء الاصطناعي يغير طريقة عملنا كل يوم',
    'كم عدد سكان مصر تقريبًا؟',
    'Give me a weekly workout plan for a beginner',
  ];
  it.each(complete)('lets a complete request through: %s', request => {
    expect(['PROCEED', 'RESEARCH', 'REQUEST_APPROVAL']).toContain(decide(request).outcome);
  });
});
