import { describe, expect, it } from 'vitest';
import { hostnameWords } from './fixtures/ads-goal-grammar.js';
import { grammarIssues, makeGrammarGoals } from '../scripts/ads-training/goal-grammar.js';
import { checkGoal } from '../scripts/ads-training/goal.js';
import { pointerToGoal } from '../scripts/ads-training/pointer.js';

describe('goal grammar training sentences', () => {
  it('uses fixture words in generated campaign URLs', () => {
    const { rows } = makeGrammarGoals({ count: 400, split: 'train', seed: 11, language: 'en' });
    expect(rows.some(row => hostnameWords.some(word => row.output.url?.includes(word)))).toBe(true);
  });

  it('labels the objective in the family-business frame and avoids contradictory currency declarations', () => {
    const { rows } = makeGrammarGoals({ count: 1800, split: 'train', seed: 71, language: 'en', naturalShare: 1, otherShare: 0 });
    const explicit = rows.filter(row => /launch ads for our family .*our objective is/i.test(row.input.message));
    expect(explicit.length).toBeGreaterThan(0);
    expect(explicit.every(row => row.output.goal !== null)).toBe(true);
    expect(rows.filter(row => row.input.message.includes('the currency has not been settled'))
      .every(row => !row.output.budget || row.output.budget.currency === null)).toBe(true);
  });
  for (const language of ['en', 'ar'] as const) {
    it(`${language}: every row passes the checker and reads back from its pointer answer`, () => {
      const { rows } = makeGrammarGoals({ count: 400, split: 'train', seed: 11, language });
      expect(rows).toHaveLength(400);
      for (const row of rows) {
        expect(checkGoal(row.input.message, row.output)).toEqual([]);
        expect(pointerToGoal(row.input.message, row.target)).toEqual(row.output);
        expect(grammarIssues(row.input.message, row.output)).toEqual([]);
      }
      expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
      expect(new Set(rows.map(row => row.input.message.toLowerCase().trim().replace(/\s+/g, ' '))).size).toBe(rows.length);
    });

    it(`${language}: covers plain requests, the hard cases and requests that are not a new campaign`, () => {
      const { rows } = makeGrammarGoals({ count: 1500, split: 'train', seed: 12, language });
      const families = new Set(rows.map(row => row.family.replace(`${language}-`, '')));
      for (const family of ['plain', 'other', 'missing', 'currencyMissing', 'periodMissing', 'budgetAmbiguous', 'budgetCorrection', 'urlAmbiguous', 'urlChoice',
        'locNegated', 'locCorrection', 'goalNegated', 'goalAbsent']) expect(families.has(family), family).toBe(true);
      expect(rows.filter(row => row.output.intent === 'other').every(row => row.target === 'intent other')).toBe(true);
      expect(rows.some(row => row.output.locations.length > 1)).toBe(true);
      expect(rows.some(row => row.output.budget?.currency === null)).toBe(true);
    });
  }

  it('is deterministic for a seed and differs between seeds', () => {
    const one = makeGrammarGoals({ count: 60, split: 'train', seed: 5, language: 'en' }).rows.map(row => row.input.message);
    const same = makeGrammarGoals({ count: 60, split: 'train', seed: 5, language: 'en' }).rows.map(row => row.input.message);
    const other = makeGrammarGoals({ count: 60, split: 'train', seed: 6, language: 'en' }).rows.map(row => row.input.message);
    expect(same).toEqual(one);
    expect(other).not.toEqual(one);
  });

  it('writes Arabic values after attached letters and in Arabic digits', () => {
    const { rows } = makeGrammarGoals({ count: 1500, split: 'train', seed: 13, language: 'ar' });
    expect(rows.some(row => /@[123]/.test(row.target))).toBe(true);
    expect(rows.some(row => row.output.budget && /[٠-٩]/.test(row.input.message))).toBe(true);
  });

  for (const language of ['en', 'ar'] as const) {
    it(`${language}: a rejected goal without a replacement remains absent`, () => {
      const composed = makeGrammarGoals({ count: 900, split: 'train', seed: 907, language, otherShare: 0, naturalShare: 0 }).rows;
      const rejected = composed.filter(row => row.family === `${language}-goalAbsent`);
      expect(rejected.length).toBeGreaterThan(10);
      for (const row of rejected) {
        expect(row.output.intent).toBe('create_campaign');
        expect(row.output.goal).toBeNull();
        expect(row.target).not.toContain('; goal ');
        expect(grammarIssues(row.input.message, row.output)).toEqual([]);
      }
      const natural = makeGrammarGoals({ count: 1200, split: 'train', seed: 908, language, otherShare: 0, naturalShare: 1 }).rows;
      const exclusions = natural.filter(row => language === 'en'
        ? /excluded from our objectives|Do not optimize|not our goal|not looking for|no .+ please|ruled out/.test(row.input.message)
        : /نستبعد .+ من أهدافنا|لا تجعل هدفها|استبعدنا|ليس هدفنا|بدون .+ غير محدد|لسنا بحاجة/.test(row.input.message));
      expect(exclusions.length).toBeGreaterThan(5);
      expect(exclusions.every(row => row.output.goal === null && !row.input.message.includes('{G2}'))).toBe(true);
    });
  }

  it('keeps the Arabic selling activity when its noun is supplied by the frame', () => {
    for (const naturalShare of [0, 1]) {
      const { rows } = makeGrammarGoals({ count: 2400, split: 'train', seed: 910, language: 'ar', otherShare: 0, naturalShare });
      const selling = rows.filter(row => row.input.message.includes('لبيع '));
      expect(selling.length).toBeGreaterThan(5);
      for (const row of selling) {
        expect(row.output.service?.startsWith('بيع ')).toBe(true);
        expect(row.input.message).toContain(`ل${row.output.service}`);
        expect(pointerToGoal(row.input.message, row.target)).toEqual(row.output);
      }
    }
  });

  for (const language of ['en', 'ar'] as const) {
    it(`${language}: natural validation uses unseen full templates and preserves hard-case labels`, () => {
      const train = makeGrammarGoals({ count: 700, split: 'train', seed: 41, language, otherShare: 0, naturalShare: 1 }).rows;
      const validation = makeGrammarGoals({ count: 180, split: 'validation', seed: 42, language, otherShare: 0, naturalShare: 1 }).rows;
      const families = new Set(train.map(row => row.family));
      expect(validation.every(row => !families.has(row.family))).toBe(true);
      expect(new Set(validation.map(row => row.family)).size).toBeGreaterThan(3);
      for (const row of [...train, ...validation]) {
        expect(grammarIssues(row.input.message, row.output)).toEqual([]);
        expect(pointerToGoal(row.input.message, row.target)).toEqual(row.output);
      }
      expect(train.some(row => row.output.service && !row.output.locations.length)).toBe(true);
      expect(train.some(row => row.output.service && row.output.locations.length > 1)).toBe(true);
      expect(train.some(row => row.output.goal && /not|instead|rather|ليس|بدون|دون|ما نبي|ما بدي|لا أريد/.test(row.input.message))).toBe(true);
      expect(train.some(row => row.output.locations.length && /instead|not in|استبعد|بدلاً|بدلا|مو|بالغلط/.test(row.input.message))).toBe(true);
    });
  }

  it('rejects a label whose value the sentence spells twice', () => {
    const output = { intent: 'create_campaign' as const, url: null, service: null, locations: ['Leeds'], budget: null, goal: null };
    expect(grammarIssues('Create ads in Leeds, only Leeds', output)).toEqual(['VALUE_NOT_UNIQUE']);
    expect(grammarIssues('Create ads in Leeds', output)).toEqual([]);
  });

  for (const language of ['en', 'ar'] as const) {
    it(`${language}: includes longer offerings and contextual requests without inventing absent slots`, () => {
      const { rows } = makeGrammarGoals({ count: 1800, split: 'train', seed: 108, language, otherShare: 0, naturalShare: 1 });
      const long = rows.filter(row => (row.output.service?.split(/\s+/).length ?? 0) >= 4);
      expect(long.length).toBeGreaterThan(90);
      const sparse = rows.filter(row => !row.output.service && !row.output.locations.length && !row.output.budget && !row.output.goal);
      expect(sparse.some(row => row.output.url)).toBe(true);
      expect(sparse.some(row => !row.output.url)).toBe(true);
      const undecided = rows.filter(row => language === 'en'
        ? /(?:daily or weekly|weekly or monthly|per day or per month|spending period is not agreed|payment period)/.test(row.input.message)
        : /(?:يومي أم أسبوعي|يوميًا أو شهريًا|بالأسبوع أو بالشهر|فترة الإنفاق|مدة الميزانية)/.test(row.input.message));
      expect(undecided.length).toBeGreaterThan(10);
      expect(undecided.every(row => row.output.budget === null)).toBe(true);
      expect(rows.every(row => row.trainingAllowed && grammarIssues(row.input.message, row.output).length === 0)).toBe(true);
    });
  }

  it('never says specific details will arrive later while already supplying those details', () => {
    let combinedStatements = 0;
    for (const language of ['en', 'ar'] as const) {
      const { rows } = makeGrammarGoals({ count: 6000, split: 'train', seed: 94, language, naturalShare: 0, otherShare: 0 });
      for (const row of rows) {
        const text = row.input.message.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ً/g, '').replace(/\s+/g, ' ');
        if (text.includes('i will provide the service and website later')) {
          combinedStatements++;
          expect(row.output.service).toBeNull();
          expect(row.output.url).toBeNull();
        }
        if (text.includes('i will send the website and budget later') || text.includes('سارسل رابط الموقع والميزانية لاحقا')) {
          combinedStatements++;
          expect(row.output.url).toBeNull();
          expect(row.output.budget).toBeNull();
        }
      }
    }
    expect(combinedStatements).toBeGreaterThan(0);
  });
});
