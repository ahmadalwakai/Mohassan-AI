import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareMannersTurn } from '../apps/server/src/assistant/manners/chat.js';
import { detectManners } from '../apps/server/src/assistant/manners/detect.js';
import { renderMannersReply } from '../apps/server/src/assistant/manners/replies.js';
import { bootstrapRequestContext } from '../apps/server/src/assistant/request-context.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';

describe('everyday standalone conversation', () => {
  beforeEach(() => {
    vi.stubEnv('MOHASSAN_SMALL_TALK_MANNERS', undefined);
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['Please accept my heartfelt gratitude, Mohassan.', 'en', 'thanks', undefined, /welcome|happy to help/iu],
    ['I’m really grateful for your patience.', 'en', 'thanks', undefined, /welcome|happy to help/iu],
    ['All right, I’ve got to head out now.', 'en', 'farewell', undefined, /see you|take care|have a good/iu],
    ['I enjoyed chatting with you, bye for now.', 'en', 'farewell', undefined, /see you|take care|have a good/iu],
    ['Would you mind telling me what you go by?', 'en', 'identity', 'name', /^Mohassan$/u],
    ['Assistant, what name would you like me to use?', 'en', 'identity', 'name', /^Mohassan$/u],
    ['Could I have your preferred name, chatbot?', 'en', 'identity', 'name', /^Mohassan$/u],
    ['How may I call you, assistant?', 'en', 'identity', 'name', /^Mohassan$/u],
    ['Could I check if you’re an AI-powered system?', 'en', 'identity', 'ai', /an AI assistant/u],
    ['Am I speaking with an actual person or is this an automated assistant?', 'en', 'identity', 'human', /an AI assistant/u],
    ['Confirm for us whether you’re a machine or a live human.', 'en', 'identity', 'ai', /an AI assistant/u],
    ['How would you classify yourself: as a person, or a program?', 'en', 'identity', 'human', /an AI assistant.*not a person/u],
    ['I guess youre an automated system, aren’t you?', 'en', 'identity', 'ai', /an AI assistant/u],
    ['I honestly appriciate your guidance.', 'en', 'thanks', undefined, /welcome|happy to help/iu],
    ['Thank you for your hlep.', 'en', 'thanks', undefined, /welcome|happy to help/iu],
    ['Thanks chatbot for your advice and trying to explain.', 'en', 'thanks', undefined, /welcome|happy to help/iu],
    ['You have offered us such useful advice, many thanks.', 'en', 'thanks', undefined, /welcome|happy to help/iu],
    ['It was very good to speak. That’s all for today.', 'en', 'farewell', undefined, /see you|take care|have a good/iu],
    ['أشكرك على مساعدتك يا موحسن!', 'ar', 'thanks', undefined, /العفو/u],
    ['في حفظ الله يا موحسن.', 'ar', 'farewell', undefined, /اللقاء|السلامة|طيب/u],
    ['كيف أناديك، يا موحسن؟', 'ar', 'identity', 'name', /^موحسن$/u],
    ['هل أنت مساعد آلي يا موحسن؟', 'ar', 'identity', 'ai', /الذكاء الاصطناعي/u],
  ] as const)('understands %s and sends it to local chat', (text, language, act, detail, copy) => {
    const detection = detectManners(text);
    expect(detection).toMatchObject({ language, act, detail, request: null });
    expect(prepareMannersTurn(text, true)?.detection).toEqual(detection);
    expect(decideRequestRoute({ text })).toMatchObject({ route: 'chat', handler: 'local_conversation', publicQuery: null });
    const reply = renderMannersReply(detection!);
    expect(reply).toMatchObject({ status: 'completed', text: expect.stringMatching(copy), evidence: [] });
    expect(reply.text).not.toMatch(/[?؟]/u);
  });

  it('keeps the previous task context for an acknowledgement', () => {
    const context = bootstrapRequestContext([{ text: 'What is my saved company name?', id: 'prior' }]);
    const decision = decideRequestRoute({ text: 'I appreciate your patience.', context });
    expect(decision.resolution.nextState).toEqual(context);
  });

  it('leaves tasks, quoted language and pending answers with their original handlers', () => {
    const tasks = [
      'I appreciate your advice. Look up the population of Halifax.',
      'Could you tell me your name and compute nine times seven?',
      'Translate “Are you just a machine?” into German.',
      'Tell me a story about how a robot got its name.',
      'Could you confirm whether a virtual assistant is eligible for the prize?',
      'What is the preferred name of this city?',
      'Write a message: Thanks chatbot for taking the time to explain.',
      'Write the title: as agreed, many thanks.',
      'Could you confirm whether you are authorized to send the email?',
    ];
    for (const text of tasks) {
      expect(prepareMannersTurn(text, true)).toBeNull();
      expect(decideRequestRoute({ text }).handler).not.toBe('local_conversation');
    }
    expect(prepareMannersTurn('Kindly, what name do you go by?', false)).toBeNull();
  });

  it('passes the full task through after a recognized form of thanks', () => {
    vi.stubEnv('MOHASSAN_SMALL_TALK_MANNERS', '1');
    const task = 'Search for the origins of jazz in New Orleans.';
    const turn = prepareMannersTurn(`I appriciate your guidance. ${task}`, true);
    expect(turn?.detection.act).toBe('thanks');
    expect(turn?.request).toBe(task);
    expect(decideRequestRoute({ text: task, capabilities: { browser: true, search: true } })).toMatchObject({
      route: 'web_search', handler: 'search',
    });
  });
});
