import { describe, expect, it } from 'vitest';
import type { Frame, Intent, Lang } from '../apps/server/src/assistant/mind/contract.js';
import { askForDetails, limits, notAvailable } from '../apps/server/src/assistant/mind/limits.js';

const frame = (text: string, lang: Lang, intent: Intent, valueOnly = false): Frame => ({
  lang, text, intent, valueOnly, timeSensitive: false, personal: false,
  matched: [], focus: [], urls: [], answerType: null, missing: [],
});

describe('fixed local replies', () => {
  const cases: [Lang, Intent, string, string, string?][] = [
    ['ar', 'identity', 'من طوّرك يا موحسن؟', 'أحمد الوكاع'],
    ['en', 'identity', 'Who developed this application?', 'Ahmad Alwakai'],
    ['ar', 'identity', 'اذكر اسمك', 'موحسن', 'موحسن'],
    ['en', 'identity', 'What are you called?', 'Mohassan', 'Mohassan'],
    ['ar', 'smalltalk', 'حياك الله! السلام عليكم.', 'وعليكم السلام'],
    ['ar', 'smalltalk', 'تسلم، مشكور يا صاحبي.', 'العفو'],
    ['en', 'smalltalk', 'Much appreciated, thanks!', 'welcome'],
    ['en', 'smalltalk', 'Hello, good evening.', 'Hello'],
    ['ar', 'write', 'اكتب خطابًا طويلًا عن المستقبل.', 'المصادر'],
    ['en', 'write', 'Compose a playful party invitation.', 'sources'],
    ['ar', 'explain', 'لخّص الفصل التالي بأسلوبك.', 'البحث'],
    ['en', 'explain', 'Translate this story into Dutch.', 'search'],
  ];
  it.each(cases)('%s %s %s', (lang, intent, text, expected, exact) => {
    const reply = limits(frame(text, lang, intent));
    expect(reply.text).toContain(expected);
    if (exact) expect(reply.text).toBe(exact);
    expect(reply.claims).toEqual([{ text: reply.text, support: [], status: 'fixed' }]);
    expect(reply.evidence).toEqual([]);
  });

  it.each(['ar', 'en'] as const)('uses one question in %s', lang => {
    const reply = askForDetails(frame('', lang, 'unknown'));
    expect(reply.question.prompt).toBe(reply.text);
    expect(reply.status).toBe('waiting_user');
  });

  it.each(['ar', 'en'] as const)('reports a route unavailable in %s', lang => {
    const reply = notAvailable(frame('', lang, 'unknown'));
    expect(reply.status).toBe('blocked');
    expect(reply.evidence).toEqual([]);
  });
});
