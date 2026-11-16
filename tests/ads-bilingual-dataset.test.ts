import { describe, expect, it } from 'vitest';
import { makeBilingualGoals } from '../scripts/ads-training/bilingual.js';

describe('bilingual training corpus boundaries', () => {
  it('keeps language balance, varied tasks and validation prompts separate', () => {
    const training = makeBilingualGoals({ count: 500, split: 'train', seed: 20261115 });
    const validation = makeBilingualGoals({ count: 200, split: 'validation', seed: 20261116 });
    expect(training.filter(row => row.language === 'ar')).toHaveLength(250);
    expect(training.some(row => row.output.intent === 'other')).toBe(true);
    expect(training.some(row => row.output.locations.length > 1)).toBe(true);
    expect(training.some(row => row.language === 'ar' && /[٠-٩۰-۹]/.test(row.input.message))).toBe(true);
    const prompts = new Set(training.map(row => row.prompt));
    expect(prompts.size).toBe(training.length);
    expect(validation.some(row => prompts.has(row.prompt))).toBe(false);
    const families = new Set(training.filter(row => row.output.intent !== 'other').map(row => row.family));
    expect(validation.filter(row => row.output.intent !== 'other').some(row => families.has(row.family))).toBe(false);
  });
});
