import { describe, expect, it } from 'vitest';
import { allSentences, colourFromWord, COLOUR_WORDS, contrastRatio, createWriter, deriveTheme, KIND_COLOURS, themePairs } from '@mohassan/sites';

describe('theme', () => {
  it('meets WCAG AA on every text pair for every named colour and mood', () => {
    const colours = [...COLOUR_WORDS.map(colour => colour.hex), ...Object.values(KIND_COLOURS), '#ffff00', '#000000', '#ffffff', '#ff00ff', '#7f7f7f'];
    for (const hex of colours) for (const mood of ['warm', 'calm', 'bold'] as const) {
      const theme = deriveTheme(hex, mood);
      for (const pair of themePairs(theme)) expect(contrastRatio(pair.foreground, pair.background), `${hex} ${mood} ${pair.name}`).toBeGreaterThanOrEqual(pair.minimum);
    }
  });
  it('is deterministic', () => {
    expect(deriveTheme('#1d4ed8', 'warm')).toEqual(deriveTheme('#1d4ed8', 'warm'));
  });
  it('reads colour words in Arabic and English and hex codes', () => {
    expect(colourFromWord('غيّر اللون إلى أزرق')?.hex).toBe('#1d4ed8');
    expect(colourFromWord('make it teal')?.hex).toBe('#0f766e');
    expect(colourFromWord('#ABCDEF')?.hex).toBe('#abcdef');
    expect(colourFromWord('no colour here')).toBeNull();
  });
});

describe('copy banks', () => {
  const CLAIMS = /(?:الأفضل|افضل|أفضل|الأرخص|ارخص|رقم واحد|الأول|ضمان|نضمن|مضمون|خبرة|سنوات|سنة|آلاف|مئات|عملاؤنا|تقييم|جوائز|معتمد|\d|[٠-٩]|%|٪|best|cheapest|guarantee|guaranteed|years|number one|thousands|hundreds|rated|award|certified|trusted by)/iu;
  it('contains no numbers and no claims', () => {
    for (const { lang, key, sentence } of allSentences()) expect(CLAIMS.test(sentence), `${lang} ${key}: ${sentence}`).toBe(false);
  });
  it('uses only known placeholders', () => {
    for (const { sentence } of allSentences()) for (const slot of sentence.matchAll(/\{(\w+)\}/g)) expect(['name', 'city', 'first', 'item'], sentence).toContain(slot[1]);
  });
  it('fills slots with the user words and never leaves a placeholder', () => {
    const writer = createWriter({ lang: 'ar', kind: 'restaurant', name: 'بيت الشام', city: 'دمشق', items: [{ title: 'شاورما' }] }, 42);
    const text = writer.text('heroLead');
    expect(text).not.toMatch(/\{/);
    expect(writer.variants('heroTitle').every(variant => variant.includes('بيت الشام') || /^[^{]*$/.test(variant))).toBe(true);
    const withoutCity = createWriter({ lang: 'en', kind: 'services', name: 'Acme', items: [] }, 7);
    expect(withoutCity.variants('heroLead').some(variant => /Manchester|\{city\}/.test(variant))).toBe(false);
  });
  it('picks the same sentence for the same seed', () => {
    const a = createWriter({ lang: 'en', kind: 'clinic', name: 'Bright Dental', items: [] }, 99);
    const b = createWriter({ lang: 'en', kind: 'clinic', name: 'Bright Dental', items: [] }, 99);
    expect(a.text('heroTitle')).toBe(b.text('heroTitle'));
  });
});
