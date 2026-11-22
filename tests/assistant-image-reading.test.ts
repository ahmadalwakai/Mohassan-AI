import { describe, expect, it } from 'vitest';
import type { ImageReading } from '@mohassan/vision';
import { composeImageReply, contentWords, imageIntent, readingForTrail } from '../apps/server/src/assistant/image-reading.js';

function reading(lines: string[], overrides: Partial<ImageReading> = {}): ImageReading {
  const rtl = lines.some(line => /[؀-ۿ]/u.test(line));
  return {
    facts: { width: 1200, height: 800, format: 'png', orientation: 'landscape', meanBrightness: 230, darkBackground: false, colorfulness: 4, distinctColors: 120, flatShare: 0.8,
      dominant: [{ hex: '#f0f0f0', share: 0.8, name: 'أبيض' }, { hex: '#101010', share: 0.1, name: 'أسود' }], surface: 'graphic' },
    lines: lines.map((text, index) => ({ text, visual: text, confidence: 0.95, box: { x: 10, y: 10 + index * 30, w: 300, h: 20 }, block: 0, row: index, direction: /[؀-ۿ]/u.test(text) ? 'rtl' : 'ltr' })),
    blocks: [lines.join('\n')], text: lines.join('\n'), direction: rtl ? 'rtl' : lines.length ? 'ltr' : 'none', kind: 'screenshot', candidates: lines.length, dropped: 0, durationMs: 12, modelId: 'a'.repeat(64),
    ...overrides,
  };
}

describe('image intents', () => {
  it('recognises the common requests in Arabic and English', () => {
    expect(imageIntent('')).toBe('read');
    expect(imageIntent('اقرأ لي ما في الصورة')).toBe('read');
    expect(imageIntent('ما المكتوب هنا؟')).toBe('read');
    expect(imageIntent('ترجم هذا')).toBe('translate');
    expect(imageIntent('لخص النص')).toBe('summarize');
    expect(imageIntent('كم عدد الكلمات؟')).toBe('count');
    expect(imageIntent('كم السعر في الصورة؟')).toBe('numbers');
    expect(imageIntent('ما هذه الصورة؟')).toBe('describe');
    expect(imageIntent('what does it say?')).toBe('read');
    expect(imageIntent('هل يوجد موعد التسليم؟')).toBe('question');
  });
  it('keeps the content words of a question', () => {
    expect(contentWords('هل يوجد موعد التسليم في الصورة؟')).toEqual(['موعد', 'تسليم']);
    expect(contentWords('what is the delivery date?')).toEqual(['delivery', 'date']);
  });
});

describe('image replies', () => {
  it('returns the read text with line count and confidence', () => {
    const reply = composeImageReply({ request: '', readings: [reading(['السعر 150 ريال', 'التسليم خلال 3 أيام'])] });
    expect(reply.outcome).toBe('read');
    expect(reply.language).toBe('ar');
    expect(reply.text).toContain('عدد الأسطر: 2');
    expect(reply.text).toContain('السعر 150 ريال');
    expect(reply.text).toContain('الثقة عالية');
  });
  it('answers a question from the matching lines first', () => {
    const reply = composeImageReply({ request: 'متى موعد التسليم؟', readings: [reading(['السعر 150 ريال', 'التسليم خلال 3 أيام'])] });
    expect(reply.intent).toBe('question');
    expect(reply.text.indexOf('التسليم خلال 3 أيام')).toBeLessThan(reply.text.indexOf('السعر 150 ريال'));
    expect(reply.text).toContain('بخصوص سؤالك');
  });
  it('lists numbers with their lines', () => {
    const reply = composeImageReply({ request: 'كم السعر؟', readings: [reading(['السعر 150 ريال', 'الخصم 12.5%'])] });
    expect(reply.text).toContain('- 150 ريال');
    expect(reply.text).toContain('- 12.5%');
  });
  it('says plainly that translation needs a model it does not have', () => {
    const reply = composeImageReply({ request: 'ترجم هذا النص', readings: [reading(['Total: $27.95'])] });
    expect(reply.text).toContain('يحتاج نموذج لغة');
    expect(reply.text).toContain('Total: $27.95');
  });
  it('describes an image without text from its facts only', () => {
    const reply = composeImageReply({ request: 'what is this picture?', readings: [reading([], { kind: 'photo', direction: 'none' })] });
    expect(reply.outcome).toBe('no_text');
    expect(reply.language).toBe('en');
    expect(reply.text).toContain('no readable text');
    expect(reply.text).toContain('1200×800');
    expect(reply.text).toContain('do not recognise objects');
  });
  it('numbers several images', () => {
    const reply = composeImageReply({ request: '', readings: [reading(['one']), reading(['اثنان'])] });
    expect(reply.text).toContain('الصورة 1');
    expect(reply.text).toContain('الصورة 2');
  });
  it('gives the brain a short trail note', () => {
    expect(readingForTrail(reading(['Sign in', 'Password']))).toBe('2 text lines read (own OCR): Sign in Password');
    expect(readingForTrail(reading([], { kind: 'photo' }))).toContain('no readable text');
  });
});
