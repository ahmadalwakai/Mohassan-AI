import { describe, expect, it } from 'vitest';
import { detectMonitorAnswerOffer, parseMonitorManagement } from '../apps/server/src/monitors/v2-chat-intents.js';

const product = 'https://shop.example.org/product/42';
const event = 'https://events.example.org/workshop';

describe('conversational monitor management', () => {
  it.each([
    ['What are you monitoring for me?', { kind: 'list', language: 'en' }],
    ['ماذا تراقب لي؟', { kind: 'list', language: 'ar' }],
    ['Stop monitoring the dollar', { kind: 'stop', language: 'en', target: 'the dollar' }],
    ['أوقف مراقبة الدولار', { kind: 'stop', language: 'ar', target: 'الدولار' }],
    ['Pause my monitor for USD/SAR', { kind: 'pause', language: 'en', target: 'usd/sar' }],
    ['أوقف مؤقتًا مراقبة الدولار', { kind: 'pause', language: 'ar', target: 'الدولار' }],
    ['Resume monitoring the dollar', { kind: 'resume', language: 'en', target: 'the dollar' }],
    ['استأنف مراقبة الدولار', { kind: 'resume', language: 'ar', target: 'الدولار' }],
    ['Change the threshold for USD/SAR to 3.650', { kind: 'threshold', language: 'en', target: 'usd/sar', value: 3.65, hysteresis: 0.001 }],
    ['غيّر الحد إلى ۳٫۶۵', { kind: 'threshold', language: 'ar', target: '', value: 3.65, hysteresis: 0.01 }],
    ['أرسل لي ملخصًا يوميًا بدل كل تنبيه', { kind: 'delivery', language: 'ar', target: '', delivery: 'daily' }],
    ['Send me a daily digest for permit results instead of each alert', { kind: 'delivery', language: 'en', target: 'permit results', delivery: 'daily' }],
    ['Send me each alert instead of a daily digest', { kind: 'delivery', language: 'en', target: '', delivery: 'each' }],
    ['Turn off proactive monitoring offers', { kind: 'offers', language: 'en', enabled: false }],
    ['فعّل عروض المراقبة', { kind: 'offers', language: 'ar', enabled: true }],
  ])('parses %s', (text, expected) => {
    expect(parseMonitorManagement(text)).toEqual(expected);
  });

  it.each(['How do I watch the stock market?', 'Explain how to stop monitoring in this code', 'لا توقف مراقبة الدولار',
    'Translate “What are you monitoring for me?”', 'Send me a short recap of the event', 'Change the threshold to NaN'])('leaves %s to ordinary chat', text => {
    expect(parseMonitorManagement(text)).toBeNull();
  });
});

describe('answer-based monitor offers', () => {
  it.each([
    [`Is the product in stock at ${product}?`, 'The product is sold out.', 'Product availability: sold out.', product, 'availability', 'en'],
    [`When does registration open at ${event}?`, 'Registration opens on December 2.', 'Registration opens on December 2.', event, 'registration', 'en'],
    [`هل المنتج متوفر في ${product}؟`, 'نفدت الكمية.', 'نفدت الكمية.', product, 'availability', 'ar'],
    [`متى يفتح التسجيل في ${event}؟`, 'التسجيل قريبًا.', 'التسجيل قريبًا.', event, 'registration', 'ar'],
  ])('requires matching public evidence for %s', (request, answer, text, url, label, language) => {
    expect(detectMonitorAnswerOffer(request, answer, [{ url, text, documentStatus: 200 }])).toMatchObject({ url, label, language });
    expect(detectMonitorAnswerOffer(request, answer, [{ url, text: 'The event is open.', documentStatus: 200 }])).toBeNull();
    expect(detectMonitorAnswerOffer(request, answer, [{ url, text, documentStatus: 403 }])).toBeNull();
    expect(detectMonitorAnswerOffer(request, answer, [{ url, text, signals: { captcha: false, password: true, otp: false, card: false } }])).toBeNull();
  });

  it.each([
    ['Hi!', 'Hello! The product is sold out.'],
    [`Is the product in stock at ${product}?`, 'I can’t verify that the product is sold out.'],
    [`Is the product in stock at ${product}?`, 'The product might be sold out.'],
    [`Is the product in stock at ${product}?`, 'Which product do you mean? Is it the one marked sold out?'],
    [`Is the product in stock at ${product}?`, 'Did the site say sold out?'],
    [`Is the product in stock at ${product}?`, 'It is in stock.'],
    [`Can you buy it at ${product}?`, 'The product is sold out.'],
    [`Is my private account still available at ${product}?`, 'The product is sold out.'],
  ])('suppresses unrelated, unconfirmed and refusal turns for %s', (request, answer) => {
    expect(detectMonitorAnswerOffer(request, answer, [{ url: product, text: 'Product availability: sold out.' }])).toBeNull();
  });

  it('deduplicates tracking variants and keeps distinct product queries', () => {
    const trigger = (url: string) => detectMonitorAnswerOffer(`Is the product in stock at ${url}?`, 'It is sold out.', [{ url, text: 'Sold out.' }])?.topic;
    expect(trigger(product)).toBeTruthy();
    expect(trigger(`${product}?utm_source=store`)).toBe(trigger(product));
    expect(trigger(`${product}?variant=red`)).not.toBe(trigger(`${product}?variant=blue`));
  });
});
