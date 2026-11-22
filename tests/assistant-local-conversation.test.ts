import { describe, expect, it } from 'vitest';
import { evaluateLocalConversation } from '../apps/server/src/assistant/local-conversation.js';

describe('fixed application facts and standalone greetings', () => {
  it.each([
    ['السلام عليكم', 'وعليكم السلام'],
    ['شكرا يا موحسن', 'العفو'],
    ['Hello, good evening.', 'Hello'],
    ['من أنت؟', 'موحسن'],
    ['ما اسمك؟', 'موحسن'],
    ['Please, what is your name?', 'Mohassan'],
    ['من طوّرك؟', 'أحمد الوكاع'],
    ['Who developed this application?', 'Ahmad Alwakai'],
  ])('answers %s using the application facts', (request, expected) => {
    const result = evaluateLocalConversation(request);
    expect(result?.status).toBe('completed');
    expect(result?.text).toContain(expected);
    expect(result?.claims.every(claim => claim.status === 'fixed')).toBe(true);
  });

  it('honors a name-only request', () => {
    expect(evaluateLocalConversation('اذكر اسمك فقط')?.text).toBe('موحسن');
    expect(evaluateLocalConversation('What is your name?')?.text).toBe('Mohassan');
  });

  it.each([
    'Hello, search for opening hours in London.',
    'شكرا، الآن افتح البريد',
    'من أنت؟ ثم احذف ملفاتي',
    'What is your name? Also read my notes.',
    'ما اسم النموذج المستخدم؟',
    'Who trained your underlying model?',
    'ما اسم شركتي؟',
    'Summarize "who made you?"',
  ])('preserves the full task instead of consuming %s as smalltalk', request => {
    expect(evaluateLocalConversation(request)).toBeNull();
  });
});
