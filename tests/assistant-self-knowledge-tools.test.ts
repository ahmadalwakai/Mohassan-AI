import { describe, expect, it } from 'vitest';
import { answerSelfQuestion, evaluateSelfQuestion, recognizeSelfQuestion, type SelfFacts } from '../apps/server/src/assistant/self-knowledge.js';

const owner: SelfFacts = {
  chatModel: false, web: true, browser: true, computation: true, memory: true, knowledge: true, documents: true, sites: true,
  skills: true, ads: true, imageReading: true, pc: true, planner: true, letters: true,
};
const member: SelfFacts = { ...owner, ads: false, pc: false };

// «Which tools can you use?» is a question about the assistant, and «in two sentences» shapes its answer. The wording is
// this test's own; the real request was rq039 of the frozen set of 2026-11-22.
describe('questions about the assistant’s tools', () => {
  it.each([
    ['ما هي الأدوات التي يمكنك استعمالها حاليًا؟', undefined],
    ['ما أدواتك؟', undefined],
    ['الأدوات المتاحة لك الآن', undefined],
    ['قل لي باختصار ما أدواتك', 2],
    ['اذكر في جملة واحدة الأدوات التي تقدر تستخدمها', 1],
    ['ما الأدوات التي تستطيع استخدامها في هذه المحادثة؟ في سطرين', 2],
    ['Which tools do you have access to right now?', undefined],
    ['Tell me in two sentences what tools you can actually use.', 2],
    ['List your tools', undefined],
    ['tell me briefly what tools are available to you', 2],
  ])('takes «%s» as a capabilities question', (request, brief) => {
    const question = recognizeSelfQuestion(request);
    expect(question?.topic).toBe('capabilities');
    expect(question?.brief).toBe(brief);
  });

  it.each([
    'ما الأدوات التي أحتاجها لتركيب رف؟',
    'What tools do I need to fix a bike?',
    'what tools can you use to edit a video',
    'اذكر أدوات النجارة',
    'ما الأدوات التي تستطيع استخدامها لتنظيف السجاد؟',
    'قل لي نكتة',
    'اذكر في جملتين فوائد الشاي',
  ])('leaves «%s» to the other routes', request => {
    expect(recognizeSelfQuestion(request)).toBeNull();
  });

  it('answers «in two sentences» in exactly two sentences, from the host facts', () => {
    const reply = evaluateSelfQuestion('اذكر في جملتين ما الأدوات التي تستطيع استخدامها الآن', owner)!;
    expect(reply.status).toBe('completed');
    expect(reply.text.split('\n')).toHaveLength(1);
    expect(reply.text.match(/\.(?=\s|$)/gu)).toHaveLength(2);
    expect(reply.text).toMatch(/^الأدوات التي أستطيع استخدامها الآن في هذه المحادثة: البحث في الويب/u);
    expect(reply.text).toContain('ولا يتوفر لي الآن: نموذج لغوي يفهم الطلبات الحرة ويكتب');
    expect(reply.text).toContain('تجهيز حملات Google Ads');
  });

  it('answers «in one sentence» in one sentence', () => {
    const reply = evaluateSelfQuestion('Tell me in one sentence what tools you can use.', owner)!;
    expect(reply.text.match(/\.(?=\s|$)/gu)).toHaveLength(1);
    expect(reply.text).toMatch(/^The tools I can use now in this conversation: web search/u);
    expect(reply.text).toContain('; not available to me now: a language model');
  });

  it('never lists for a member what the member cannot reach', () => {
    const question = recognizeSelfQuestion('قل لي باختصار ما أدواتك')!;
    const reply = answerSelfQuestion(question, member)!;
    const [can, cannot] = reply.text.split('. ');
    expect(can).not.toContain('Google Ads');
    expect(can).not.toContain('حاسوبك');
    expect(cannot).toContain('حملات Google Ads');
    expect(cannot).toContain('التحكم بالحاسوب');
  });

  it('says a language model is configured when it is', () => {
    const reply = evaluateSelfQuestion('tell me briefly what tools are available to you', { ...owner, chatModel: true })!;
    expect(reply.text).not.toContain('a language model');
    expect(reply.text).toContain('Not available to me now: media generation');
  });

  it('keeps the full list when no length is asked', () => {
    expect(evaluateSelfQuestion('ما أدواتك؟', owner)!.text).toMatch(/^هذا ما أستطيعه الآن في هذه المحادثة/u);
  });
});
