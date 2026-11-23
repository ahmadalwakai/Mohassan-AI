import { describe, expect, it } from 'vitest';
import { evaluateSelfQuestion, recognizeSelfQuestion, type SelfFacts } from '../apps/server/src/assistant/self-knowledge.js';

const facts: SelfFacts = { chatModel: false, web: true, browser: true, computation: true, memory: true, knowledge: true, documents: true, sites: true, skills: true,
  ads: false, imageReading: true, pc: false, planner: true, letters: true };

// «على أي نموذج لغوي تعمل؟» was not recognised on 2026-11-22, and an instruction skill about machine learning answered it
// (artifacts/agent-gaps-2026-11-22/audit-head-3959084/wiring-probe.json, self-model). Wordings written for this test.
describe('which model the assistant runs on', () => {
  it.each([
    'على أي نموذج لغوي تعمل؟',
    'على أي نموذج تعمل؟',
    'ما النموذج اللغوي الذي تستخدمه؟',
    'ما هو نموذج الذكاء الاصطناعي الذي تعمل عليه؟',
    'أي نموذج ذكاء اصطناعي تستخدم؟',
    'بأي نموذج لغوي تشتغل',
    'ما هو النموذج اللغوي الكبير الذي تعمل به؟',
    'which language model do you run on?',
    'what model are you using',
  ])('recognises %s', request => {
    expect(recognizeSelfQuestion(request)).toMatchObject({ topic: 'model', asked: 'which' });
  });

  it('answers directly, with no yes or no in front, and says no chat model is configured', () => {
    const arabic = evaluateSelfQuestion('على أي نموذج لغوي تعمل؟', facts)!;
    expect(arabic.status).toBe('completed');
    expect(arabic.text).toMatch(/^أنا موحسن، ولا أعمل على أي منصة ذكاء اصطناعي خارجية\. لا يوجد نموذج توليد محادثة مهيأ في هذه النسخة/u);
    const english = evaluateSelfQuestion('which language model do you run on?', facts)!;
    expect(english.text).toMatch(/^I’m Mohassan, and I do not run on any external AI platform\. No chat-generation model is configured in this build/u);
  });

  it('names no model when one is configured, only that the host has one', () => {
    const reply = evaluateSelfQuestion('على أي نموذج لغوي تعمل؟', { ...facts, chatModel: true })!;
    expect(reply.text).toMatch(/^أنا موحسن\. في هذه النسخة نموذج توليد محادثة مهيأ من المضيف/u);
  });

  it('keeps yes for «are you an AI», no for a named product, and no for a human', () => {
    expect(recognizeSelfQuestion('هل أنت ذكاء اصطناعي؟')).toMatchObject({ topic: 'model', asked: 'ai' });
    expect(evaluateSelfQuestion('هل أنت ذكاء اصطناعي؟', facts)!.text).toMatch(/^نعم، أنا موحسن/u);
    expect(recognizeSelfQuestion('are you groq ai ?')).toMatchObject({ topic: 'model', asked: 'product' });
    expect(evaluateSelfQuestion('are you groq ai ?', facts)!.text).toMatch(/^No\. I’m Mohassan/u);
    expect(recognizeSelfQuestion('هل أنت إنسان؟')).toMatchObject({ topic: 'model', asked: 'human' });
  });

  it.each([
    // About models in general, or a task: the web or a skill may answer these.
    'ما هو النموذج اللغوي الكبير؟', 'كيف أدرّب نموذجًا لغويًا؟', 'ما أفضل نموذج لغوي للترجمة؟', 'ما الفرق بين نموذج لغوي ونموذج رؤية؟', 'which language model is best for coding?',
  ])('leaves %s to the other paths', request => {
    expect(recognizeSelfQuestion(request)).toBeNull();
  });
});
