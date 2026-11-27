import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareMannersTurn, standaloneMannersRoute } from '../apps/server/src/assistant/manners/chat.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import { mannersDevelopmentCases, mannersDevelopmentControls } from './fixtures/manners-development.js';

const mannersFlag = 'MOHASSAN_SMALL_TALK_MANNERS';
const localOnlyFlag = 'MOHASSAN_SMALL_TALK_LOCAL_ONLY';
const localRoute = { route: 'chat', handler: 'local_conversation', availability: 'ready', publicQuery: null };
const capabilities = { browser: true, search: true };

// Exercise the terms and spellings in the task across the requested question frames.
const identityPairs = [
  ['هل أنت إنسان أم كمبيوتر؟', 'Are you a human or a computer?'],
  ['هل أتحدث مع إنسان أم مع برنامج؟', 'Am I speaking with a human or a program?'],
  ['هل انت شات بوت؟', 'Are you a chatbot?'],
  ['هل إنتَ بشر أو آلة؟', 'Are you human or a machine?'],
  ['إنتَ روبوت ولا إنسان؟', 'Are you a robot or a human?'],
  ['هل أنت ذكاء اصطناعي أم بشر؟', 'Are you an AI or a human?'],
  ['أنت إنسان ولا روبوت يا موحسن؟', 'Are you a human or a robot, Mohassan?'],
  ['هل أتحدث مع برنامج أو مع إنسان؟', 'Am I speaking with a program or a human?'],
  ['هل أنت آلة أو بشر؟', 'Are you a machine or a person?'],
  ['هل أنتَ برنامج أم إنسان؟', 'Are you a program or a human?'],
  ['هل أنت شات بوت ولا بشر؟', 'Are you a chatbot or a person?'],
] as const;

describe('standalone social and identity routing', () => {
  beforeEach(() => {
    vi.stubEnv(mannersFlag, '0');
    vi.stubEnv(localOnlyFlag, undefined);
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(identityPairs)('understands %s and %s as the same local identity act', (arabic, english) => {
    vi.stubEnv(mannersFlag, '1');
    const arabicTurn = prepareMannersTurn(arabic, true);
    expect(arabicTurn).toMatchObject({ request: null, detection: { act: 'identity', language: 'ar' } });
    expect(prepareMannersTurn(english, true)).toMatchObject({
      request: null, detection: { act: 'identity', language: 'en', detail: arabicTurn?.detection.detail },
    });
    expect(decideRequestRoute({ text: arabic, capabilities })).toMatchObject(localRoute);
    expect(decideRequestRoute({ text: english, capabilities })).toMatchObject(localRoute);
  });

  it('reads an Arabic comma before the alternative as part of the identity question', () => {
    vi.stubEnv(localOnlyFlag, '1');
    const text = 'هل أنت إنسان، أم كمبيوتر؟';
    expect(prepareMannersTurn(text, true)).toMatchObject({ request: null, detection: { act: 'identity', detail: 'human' } });
    expect(decideRequestRoute({ text, capabilities })).toMatchObject(localRoute);
  });

  it.each([
    ['1', '0'],
    ['0', '1'],
  ])('routes all standalone manners fixtures locally with full=%s and local-only=%s', (full, localOnly) => {
    vi.stubEnv(mannersFlag, full);
    vi.stubEnv(localOnlyFlag, localOnly);
    const standalone = Object.values(mannersDevelopmentCases).flat().filter(([, , request]) => request === undefined);
    expect(standalone).toHaveLength(240);
    for (const [text, act] of standalone) {
      expect(decideRequestRoute({ text, capabilities }), text).toMatchObject(localRoute);
      expect(prepareMannersTurn(text, true), text).toMatchObject({ request: null, detection: { act } });
    }
  });

  it('leaves mixed tasks, controls, constraints and pending turns outside local-only admission', () => {
    vi.stubEnv(localOnlyFlag, '1');
    for (const [text] of mannersDevelopmentCases.mixed) {
      expect(prepareMannersTurn(text, true), text).toBeNull();
      expect(standaloneMannersRoute({ text, capabilities }), text).toBeNull();
    }
    for (const text of mannersDevelopmentControls) {
      expect(prepareMannersTurn(text, true), text).toBeNull();
      expect(decideRequestRoute({ text, capabilities }).handler, text).not.toBe('local_conversation');
    }
    for (const text of [
      'ترجم «هل أنت إنسان أم كمبيوتر؟» إلى الإنجليزية.',
      'هل انت شات بوت؟ احسب ١٥ × ٤.',
      'هل أنت بخير؟ لا تبحث في الويب.',
    ]) {
      expect(prepareMannersTurn(text, true), text).toBeNull();
      expect(standaloneMannersRoute({ text, capabilities }), text).toBeNull();
    }
    const text = 'هل انت شات بوت؟';
    expect(prepareMannersTurn(text, false)).toBeNull();
    expect(standaloneMannersRoute({ text, capabilities, pendingQuestion: { id: 'pending' } })).toBeNull();
  });

  it('preserves legacy standalone admission when the local-only option is unset or off', () => {
    for (const setting of [undefined, '0']) {
      vi.stubEnv(localOnlyFlag, setting);
      for (const text of ['هل أنت إنسان أم كمبيوتر؟', 'هل انت شات بوت؟', 'هل أنت بخير؟', 'سامحني يا موحسن', "What's up?"]) {
        expect(prepareMannersTurn(text, true), text).toBeNull();
        expect(standaloneMannersRoute({ text, capabilities }), text).toBeNull();
      }
      const text = 'أنت روبوت ولا إنسان يا موحسن؟';
      expect(prepareMannersTurn(text, true)).toMatchObject({ request: null, detection: { act: 'identity', detail: 'ai' } });
      expect(decideRequestRoute({ text, capabilities })).toMatchObject(localRoute);
    }
  });
});
