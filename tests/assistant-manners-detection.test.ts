import { describe, expect, it } from 'vitest';
import { detectManners } from '../apps/server/src/assistant/manners/detect.js';

describe('manners detection boundaries', () => {
  it.each([
    ['Hello, Open Chrome.', 'Open Chrome.'],
    ['Hi, Go Home.', 'Go Home.'],
    ['Thanks, Close Tab.', 'Close Tab.'],
    ['Hello, Visit Paris.', 'Visit Paris.'],
    ['Hi, -3 * 9', '-3 * 9'],
    ['Hi, .4 × 5', '.4 × 5'],
    ['Hi! Translate: foo, thanks.', 'Translate: foo, thanks.'],
    ['Hi, read the file: Thanks!', 'read the file: Thanks!'],
    ['السلام عليكم، لا تبحث في الويب.', 'لا تبحث في الويب.'],
    ['مرحبا، ابحث عن "Thanks!" ولا تبحث في ذاكرتي.', 'ابحث عن "Thanks!" ولا تبحث في ذاكرتي.'],
  ])('keeps the full request in %j', (message, request) => {
    expect(detectManners(message)?.request).toBe(request);
  });

  it.each([
    'Write a title: Good Night!',
    'Read the file: Thanks!',
    '"Hey there!"',
    'Hello.org',
  ])('does not treat literal data or URLs as speech acts in %j', message => {
    expect(detectManners(message)).toBeNull();
  });

  it('chooses language from outer speech and reply-language instructions', () => {
    expect(detectManners('Hello, "عبد الكريم"!')).toMatchObject({ act: 'greeting', language: 'en', request: null });
    expect(detectManners('مرحبا يا James!')).toMatchObject({ act: 'greeting', language: 'ar', request: null });
    expect(detectManners('Hello. Please reply in Arabic.')).toMatchObject({ act: 'greeting', language: 'ar', request: null });
    expect(detectManners('Hello. Translate "reply in Arabic".')).toMatchObject({
      act: 'greeting', language: 'en', request: 'Translate "reply in Arabic".',
    });
  });
});
