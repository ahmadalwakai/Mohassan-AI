import { describe, expect, it } from 'vitest';
import { answerSelfQuestion, evaluateSelfQuestion, recognizeSelfQuestion, type SelfFacts } from '../apps/server/src/assistant/self-knowledge.js';

/**
 * Questions about the assistant itself (apps/server/src/assistant/self-knowledge.ts). The wording here is this test's own,
 * not the frozen real set's, so the set stays a measurement and not a target.
 */
const NO_MODEL: SelfFacts = {
  chatModel: false, web: true, browser: true, computation: true, memory: true, knowledge: true, documents: true, sites: true,
  skills: true, ads: true, imageReading: true, pc: true, planner: true, letters: true,
};
const MEMBER: SelfFacts = { ...NO_MODEL, ads: false, pc: false };
const topic = (text: string) => recognizeSelfQuestion(text)?.topic ?? null;

describe('recognizing a question about the assistant', () => {
  it.each([
    ['What are your abilities?', 'capabilities'],
    ['so what can you do for me', 'capabilities'],
    ['How can you help me?', 'capabilities'],
    ['شو بتقدر تعمل؟', 'capabilities'],
    ['ما هي مميزاتك الحالية', 'capabilities'],
    ['ماذا تستطيع أن تفعل لي؟', 'capabilities'],
    ['كيف يمكنك أن تساعدني؟', 'capabilities'],
    ['Who built you?', 'creator'],
    ['who is your developer', 'creator'],
    ['مين اللي برمجك؟', 'creator'],
    ['أنا اللي طورتك', 'creator'],
    ['we made you, not google', 'creator'],
    ['are you chatgpt', 'model'],
    ['Are you based on Gemini?', 'model'],
    ['هل أنت تشات جي بي تي؟', 'model'],
    ['على أي نموذج تعمل؟', 'model'],
    ['are you a human?', 'model'],
    ['هل انت ذكاء اصطناعي', 'model'],
    ['Is Gemini smarter than you?', 'compare'],
    ['which one is better, you or claude?', 'compare'],
    ['مين أذكى انت ولا جيميني', 'compare'],
    ['هل انت افضل من شات جي بي تي؟', 'compare'],
    ['How could we make you better?', 'improve'],
    ['what are your weaknesses', 'improve'],
    ['لو أردنا أن نطورك، ماذا تقترح؟', 'improve'],
    ['ما الذي ينقصك؟', 'improve'],
    ['Can you make pictures?', 'can_do'],
    ['could you write essays', 'can_do'],
    ['هل تستطيع بناء موقع إلكتروني؟', 'can_do'],
    ['هل يمكنك الترجمة؟', 'can_do'],
    ['are you able to read text from images?', 'can_do'],
    ['هل تقدر تبحث في الانترنت', 'can_do'],
    ['can you set up google ads campaigns?', 'can_do'],
  ])('%s → %s', (text, expected) => {
    expect(topic(text)).toBe(expected);
  });

  it.each([
    // A task with its own object stays a task, even when its ability is one the host has.
    'can you build a website for my bakery in Leeds',
    'can you create an image of a cat on a sofa',
    'هل تستطيع فتح موقع bbc.com',
    'can you open https://example.com and read it',
    'make ads for my barbershop in Leeds, £10 a day',
    'كم يساوي 15 ضرب 4؟',
    // About something else, not the assistant.
    'Who created the Eiffel Tower?',
    'what can you tell me about Paris',
    'how can you help me with my taxes this year',
    'ما هي قدرات الحاسوب الكمومي',
    'who is smarter, Einstein or Newton?',
    'أنت أفضل مساعد',
    'هل أنت متأكد من الجواب؟',
    'what is the best phone from your point of view',
    'لو كان بإمكانك تطوير مشروعي التجاري فماذا تقترح؟',
  ])('leaves «%s» to the other routes', text => {
    expect(recognizeSelfQuestion(text)).toBeNull();
  });
});

describe('answers built from the host facts only', () => {
  it('lists what is configured and what is not, without a web page', () => {
    const reply = evaluateSelfQuestion('ما هي مميزاتك؟', NO_MODEL)!;
    expect(reply.status).toBe('completed');
    expect(reply.text).toContain('أبني موقعًا إلكترونيًا من كلماتك.');
    expect(reply.text).toContain('أجهّز حملات Google Ads.');
    expect(reply.text).toContain('نموذج لغوي يفهم الطلبات الحرة');
    expect(reply.text).not.toMatch(/https?:\/\//u);
  });

  it('never lists for a member what the member cannot reach', () => {
    const reply = evaluateSelfQuestion('What can you do?', MEMBER)!;
    expect(reply.text).not.toContain('Prepare Google Ads campaigns.');
    expect(reply.text).not.toContain('Carry out specific commands on your computer');
    expect(reply.text).toContain('Not configured in this conversation: Google Ads campaigns, computer control.');
  });

  it('says no for an ability the host does not have, and yes with the way in for one it has', () => {
    expect(evaluateSelfQuestion('Can you make pictures?', NO_MODEL)!.text).toMatch(/^No\. I cannot create images now/u);
    expect(evaluateSelfQuestion('هل تستطيع بناء موقع إلكتروني؟', NO_MODEL)!.text).toMatch(/^نعم\. أبني موقعًا إلكترونيًا/u);
    expect(evaluateSelfQuestion('هل تستطيع بناء موقع إلكتروني؟', { ...NO_MODEL, sites: false })!.text).toBe('بناء المواقع غير مهيأ في هذه المحادثة الآن.');
  });

  it('leaves writing and translation to a configured model', () => {
    expect(evaluateSelfQuestion('could you write essays', { ...NO_MODEL, chatModel: true })).toBeNull();
    expect(evaluateSelfQuestion('could you write essays', NO_MODEL)!.text).toMatch(/^I cannot write stories, articles or poems/u);
  });

  it('answers a model question from the generation fact, and names the creator', () => {
    const none = evaluateSelfQuestion('are you chatgpt', NO_MODEL)!.text;
    expect(none).toMatch(/^No\. I’m Mohassan, and I do not run on any external AI platform\. No chat-generation model is configured/u);
    expect(none).toContain('Ahmad Alwakai is the creator and lead developer of the Mohassan application.');
    const configured = evaluateSelfQuestion('are you chatgpt', { ...NO_MODEL, chatModel: true })!.text;
    expect(configured).toMatch(/^I’m Mohassan\. A chat-generation model is configured by the host/u);
    expect(configured).not.toMatch(/external AI platform/u);
    expect(evaluateSelfQuestion('هل انت انسان؟', NO_MODEL)!.text).toMatch(/^لا، أنا موحسن، مساعد برمجي/u);
  });

  it('does not judge another assistant when asked to compare', () => {
    const reply = answerSelfQuestion({ topic: 'compare', lang: 'en' }, NO_MODEL)!;
    expect(reply.text).toMatch(/^I cannot compare myself fairly with another assistant/u);
  });

  it('names the missing language model first when asked what would improve it', () => {
    const reply = evaluateSelfQuestion('How could we make you better?', NO_MODEL)!.text;
    expect(reply.split('\n')[1]).toMatch(/^- A language model that understands free requests/u);
    expect(evaluateSelfQuestion('How could we make you better?', { ...NO_MODEL, chatModel: true })!.text).not.toMatch(/A language model that understands/u);
  });
});
