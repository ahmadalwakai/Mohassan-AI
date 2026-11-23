import { describe, expect, it } from 'vitest';
import { continueWebSequence, joinSequence, planWebSequence, startWebSequence, webPartSteps } from '../apps/server/src/assistant/web-sequence.js';
import type { SelfFacts } from '../apps/server/src/assistant/self-knowledge.js';

const self: SelfFacts = { chatModel: false, web: true, browser: true, computation: true, memory: true, knowledge: true, documents: true, sites: true, skills: true,
  ads: false, imageReading: true, pc: false, planner: true, letters: true };
const deps = { now: new Date('2026-11-22T12:00:00Z'), self };
const queries = (steps: ReturnType<typeof webPartSteps>) => steps?.map(step => step.kind === 'search' ? step.query : step.kind);

describe('a message of several questions that needs the web', () => {
  it('splits the measured message into its two questions', () => {
    // «لم أجد صفحة تجيب مباشرة» on 2026-11-22: it was searched as one question (wiring-probe.json, plan-two-web).
    expect(planWebSequence('ما عاصمة فرنسا؟ ثم كم عدد سكانها؟', deps)).toEqual([{ request: 'ما عاصمة فرنسا؟' }, { request: 'كم عدد سكانها؟' }]);
  });

  it.each([
    ['ما عاصمة اليابان ثم ما عملتها؟', 2],
    ['من هو ألبرت أينشتاين؟ ثم متى ولد؟', 2],
    ['What is the capital of France? Then what is its population?', 2],
    ['ما عاصمة فرنسا؟ وكم عدد سكانها؟', 2],
  ])('takes %s', (request, parts) => {
    expect(planWebSequence(request, deps)).toHaveLength(parts);
  });

  it.each([
    // One question.
    'ما عاصمة فرنسا؟', 'كم عدد سكان مصر؟',
    // A part that is an action, a transformation or a browser step.
    'ما عاصمة فرنسا؟ ثم أرسلها إلى أحمد', 'ابحث عن أفضل مطاعم دمشق ثم لخصها', 'افتح bbc.com ثم اقرأ العناوين',
    // A part about the owner's own things: memory answers it, never a sequence of searches.
    'ما عاصمة فرنسا؟ ثم ما هو رقم جوالي؟', 'ما اسم شركتي؟ ثم ما عاصمة فرنسا؟',
    // Every part local: local-sequence.ts takes it.
    'كم حاصل 17 × 23؟ ثم ما قدراتك؟',
    '',
  ])('leaves %s to the paths before it', request => {
    expect(planWebSequence(request, deps)).toBeNull();
  });
});

describe('the search for one part', () => {
  it('asks a pointing part about the page the part before was answered from', () => {
    expect(queries(webPartSteps('كم عدد سكانها؟', 'فرنسا', ['ما عاصمة فرنسا؟']))).toEqual(['كم عدد سكان فرنسا']);
    expect(queries(webPartSteps('ما عملتها؟', 'اليابان', ['ما عاصمة اليابان']))).toEqual(['ما عملة اليابان']);
  });

  it('gives a part with no subject of its own the subject of the part before', () => {
    expect(queries(webPartSteps('متى ولد؟', 'ألبرت أينشتاين', ['من هو ألبرت أينشتاين؟']))).toEqual(['متى ولد ألبرت أينشتاين']);
  });

  it('names what an English pronoun stood for', () => {
    expect(queries(webPartSteps('what is its population?', 'France', ['What is the capital of France?']))).toEqual(['what is the population of France']);
  });

  it('leaves a part that names its own subject as it is', () => {
    expect(queries(webPartSteps('ما عاصمة ألمانيا؟', 'فرنسا', ['ما عاصمة فرنسا؟']))).toEqual(['ما عاصمة ألمانيا']);
    expect(queries(webPartSteps('ما عاصمة فرنسا؟', '', []))).toEqual(['ما عاصمة فرنسا']);
  });
});

describe('running the parts in order', () => {
  const parts = planWebSequence('ما عاصمة فرنسا؟ ثم كم عدد سكانها؟', deps)!;

  it('starts with the first web part and carries the rest', () => {
    const plan = startWebSequence(parts, 'ar')!;
    expect(queries(plan.steps)).toEqual(['ما عاصمة فرنسا']);
    expect(plan.sequel).toEqual({ asked: 'ما عاصمة فرنسا؟', previous: null, answers: [], rest: [{ request: 'كم عدد سكانها؟' }] });
  });

  it('continues with the next part about the page just read, then joins the answers in the order asked', () => {
    const first = startWebSequence(parts, 'ar')!;
    const next = continueWebSequence(first.sequel!, { request: 'ما عاصمة فرنسا؟', text: 'عاصمتها باريس.', status: 'completed' }, 'فرنسا', 'ar');
    expect('plan' in next).toBe(true);
    if (!('plan' in next)) return;
    expect(queries(next.plan.steps)).toEqual(['كم عدد سكان فرنسا']);
    expect(next.plan.sequel).toMatchObject({ asked: 'كم عدد سكانها؟', previous: 'ما عاصمة فرنسا؟', rest: [] });
    const done = continueWebSequence(next.plan.sequel!, { request: 'كم عدد سكانها؟', text: 'يبلغ عدد سكان فرنسا نحو 68 مليون نسمة.', status: 'completed' }, 'فرنسا', 'ar');
    expect('answers' in done).toBe(true);
    if (!('answers' in done)) return;
    expect(joinSequence(done.answers)).toEqual({ status: 'completed',
      text: '**ما عاصمة فرنسا؟**\nعاصمتها باريس.\n\n**كم عدد سكانها؟**\nيبلغ عدد سكان فرنسا نحو 68 مليون نسمة.' });
  });

  it('ends partial when one part was not answered, and blocked when none was', () => {
    expect(joinSequence([{ request: 'أ؟', text: 'جواب', status: 'completed' }, { request: 'ب؟', text: 'لم أجد صفحة', status: 'partial' }]).status).toBe('partial');
    expect(joinSequence([{ request: 'أ؟', text: 'لم أجد', status: 'partial' }, { request: 'ب؟', text: 'لم أجد', status: 'blocked' }]).status).toBe('blocked');
  });

  it('answers a leading local part at once and searches for the web part after it', () => {
    // Reached only when the paths before the planner pass the message on; the plan itself is still whole.
    const mixed = [{ request: 'كم حاصل 2 + 2؟', local: { request: 'كم حاصل 2 + 2؟', text: '2 + 2 = 4', status: 'completed' as const } }, { request: 'ما عاصمة فرنسا؟' }];
    const plan = startWebSequence(mixed, 'ar')!;
    expect(queries(plan.steps)).toEqual(['ما عاصمة فرنسا']);
    expect(plan.sequel).toMatchObject({ asked: 'ما عاصمة فرنسا؟', previous: 'كم حاصل 2 + 2؟', answers: [{ text: '2 + 2 = 4' }], rest: [] });
  });
});
