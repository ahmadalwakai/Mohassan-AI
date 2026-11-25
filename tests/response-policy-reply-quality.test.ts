import { describe, expect, it } from 'vitest';
import { scoreReplyQuality } from '../scripts/response-policy/reply-quality.js';

describe('response policy reply quality measurement', () => {
  it.each([
    ['Where do I collect the parcel?', 'At the north loading dock.'],
    ['وين أستلم الطرد؟', 'من باب التحميل الشمالي.'],
  ])('accepts a direct reply to %s', (request, reply) => {
    expect(scoreReplyQuality({ request, reply, previousReplies: [] })).toEqual({
      answerFirst: true, noRestatement: true, noEarlierRepetition: null, appropriateStructure: true,
    });
  });

  it.each([
    ['Where do I collect the parcel?', '**Where do I collect the parcel?**\nAt the north loading dock.'],
    ['وين أستلم الطرد؟', 'وين استلم الطرد؟ من باب التحميل الشمالي.'],
    ['Where do I collect the parcel?', 'You asked: Where do I collect the parcel?\nAt the north loading dock.'],
  ])('detects an echo of %s', (request, reply) => {
    expect(scoreReplyQuality({ request, reply, previousReplies: [] }))
      .toMatchObject({ answerFirst: false, noRestatement: false });
  });

  it.each(['Certainly, the locker is open.', 'أكيد، الخزانة مفتوحة.'])('detects a generic opening in %s', reply => {
    expect(scoreReplyQuality({ request: 'Is the locker open?', reply, previousReplies: [] }).answerFirst).toBe(false);
  });

  it('compares substantive text with earlier assistant replies and permits explicitly requested repetition', () => {
    const previousReplies = ['The stand closes at noon. Use the eastern entrance on weekdays.'];
    const reply = 'Use the eastern entrance on weekdays. There is street parking.';
    expect(scoreReplyQuality({ request: 'What about parking?', reply, previousReplies }).noEarlierRepetition).toBe(false);
    expect(scoreReplyQuality({ request: 'Repeat that instruction.', reply, previousReplies }).noEarlierRepetition).toBeNull();
    expect(scoreReplyQuality({ request: 'What about parking?', reply: 'Street parking is available.', previousReplies })
      .noEarlierRepetition).toBe(true);
  });

  it('flags ornamental lists and respects an explicit prose constraint', () => {
    const reply = '- The parcel is blue.';
    expect(scoreReplyQuality({ request: 'What color is the parcel?', reply, previousReplies: [] }).appropriateStructure).toBe(false);
    expect(scoreReplyQuality({ request: 'What color is the parcel?', reply: '**Blue.**', previousReplies: [] })
      .appropriateStructure).toBe(true);
    const mixed = '١. افتح الغطاء.\n٢. ثبّت البرغي.';
    expect(scoreReplyQuality({ request: 'كيف أثبت البرغي؟', reply: mixed, previousReplies: [] }).appropriateStructure).toBe(true);
    expect(scoreReplyQuality({ request: 'كيف أثبت البرغي بلا نقاط؟', reply: mixed, previousReplies: [] }).appropriateStructure).toBe(false);
  });

  it('reports empty replies as unmeasured and allows a requested link to lead', () => {
    expect(scoreReplyQuality({ request: 'Find the settings.', reply: '', previousReplies: [] })).toEqual({
      answerFirst: null, noRestatement: null, noEarlierRepetition: null, appropriateStructure: null,
    });
    expect(scoreReplyQuality({ request: 'Send me the link.', reply: 'https://example.invalid/settings', previousReplies: [] })
      .answerFirst).toBe(true);
  });
});
