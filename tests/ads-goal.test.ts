import { describe, it, expect } from 'vitest';
import { GOLD_GOALS, budgetNumbers, checkGoal, compareGoal, generateGoals, goldGoalExamples, normalizeBudgetNumber, renderGoalPrompt, renderGoalTarget, type Goal } from '../scripts/ads-training/goal.js';

const small = () => generateGoals({ seed: 7, counts: { train: 400, validation: 50, test: 50, test_unseen_phrasing: 50 } });

describe('Ads goal data (sentence -> campaign goal)', () => {
  it('rebuilds the same dataset from the same seed', () => {
    expect(small().map(item => item.id)).toEqual(small().map(item => item.id));
  });

  it('only labels values that are written in the sentence', () => {
    const examples = small();
    expect(examples.length).toBe(550);
    for (const item of examples) expect(checkGoal(item.input.message, item.output), item.input.message).toEqual([]);
    expect(examples.some(item => item.output.intent === 'other')).toBe(true);
    expect(examples.some(item => item.output.budget?.period === 'month')).toBe(true);
  });

  it('keeps held-out sentences, places and services out of training', () => {
    const examples = small();
    const train = examples.filter(item => item.split === 'train');
    const trainIds = new Set(train.map(item => item.id));
    expect(examples.filter(item => item.split !== 'train' && trainIds.has(item.id))).toEqual([]);
    const trainText = train.map(item => item.input.message.toLowerCase()).join('\n');
    for (const held of ['wigan', 'montrose', 'chimney sweeping', 'piano tuning', 'could you put together']) expect(trainText).not.toContain(held);
  });

  it('accepts every handwritten gold example and keeps them out of training', () => {
    for (const item of GOLD_GOALS) expect(checkGoal(item.message, item.output), item.message).toEqual([]);
    const ids = new Set(small().map(item => item.id));
    expect(goldGoalExamples().filter(item => ids.has(item.id))).toEqual([]);
  });

  it('rejects values the user never wrote', () => {
    const message = 'make ads for kerbsidetyres.co.uk in Wigan, £20 a day';
    const good = { intent: 'create_campaign', url: 'kerbsidetyres.co.uk', service: null, locations: ['Wigan'], budget: { amount: '20', currency: '£', period: 'day' }, goal: null };
    expect(checkGoal(message, good)).toEqual([]);
    expect(checkGoal(message, { ...good, locations: ['Leeds'] })).toContain('UNGROUNDED_LOCATION');
    expect(checkGoal(message, { ...good, url: 'kerbside.co.uk' })).toContain('UNGROUNDED_URL');
    expect(checkGoal(message, { ...good, budget: { amount: '200', currency: '£', period: 'day' } })).toContain('UNGROUNDED_AMOUNT');
    expect(checkGoal(message, { ...good, budget: { amount: '20', currency: '$', period: 'day' } })).toContain('UNGROUNDED_CURRENCY');
    expect(checkGoal(message, { ...good, budget: { amount: '20', currency: '£', period: 'month' } })).toContain('UNGROUNDED_PERIOD');
    expect(checkGoal(message, { ...good, service: 'tyres' })).toEqual([]);
    expect(checkGoal(message, { ...good, service: 'plumbing' })).toContain('UNGROUNDED_SERVICE');
    expect(checkGoal('what is the weather in Wigan', { ...good, intent: 'other' })).toContain('OTHER_WITH_VALUES');
    expect(checkGoal(message, { ...good, extra: 1 })).toEqual(['BAD_KEYS']);
  });

  it('scores each field separately', () => {
    const [first] = GOLD_GOALS;
    const result = compareGoal(first!.output, { ...first!.output, goal: 'leads' });
    expect(result.exact).toBe(false);
    expect(result.fields).toMatchObject({ url: true, locations: true, budget: true, goal: false });
  });

  it('renders the same prompt shape as the other Ads tasks', () => {
    const [item] = goldGoalExamples();
    expect(renderGoalPrompt(item!)).toMatch(/^Ads task:\n\{"capability":"ads\.goal\.v1","input":\{"message":".+"\}\}\nOutput:\n$/);
    expect(JSON.parse(renderGoalTarget(item!))).toEqual(item!.output);
  });
});

describe('Bilingual Ads goal contract (model quality is evaluated separately)', () => {
  const empty: Goal = { intent: 'create_campaign', url: null, service: null, locations: [], budget: null, goal: null };

  it('accepts exact Arabic and mixed-language evidence with canonical monetary values', () => {
    const message = 'أنشئ حملة لخدمة تنظيف المنازل في الرياض، الموقع cleanhome.sa، ميزانية ١٬٢٥٠٫٥٠ ريال سعودي شهرياً، أريد مكالمات';
    const goal: Goal = { ...empty, service: 'تنظيف المنازل', url: 'cleanhome.sa', locations: ['الرياض'], budget: { amount: '1250.50', currency: 'SAR', period: 'month' }, goal: 'calls' };
    expect(checkGoal(message, goal)).toEqual([]);
    expect(checkGoal(message, { ...goal, locations: ['دبي'] })).toContain('UNGROUNDED_LOCATION');
    expect(checkGoal(message, { ...goal, service: 'صيانة المنازل' })).toContain('UNGROUNDED_SERVICE');
    expect(checkGoal('Google Ads لخدمة تنظيف المنازل في Leeds، ۲۰ دولار يومياً للحجوزات', {
      ...empty, service: 'تنظيف المنازل', locations: ['Leeds'], budget: { amount: '20', currency: '$', period: 'day' }, goal: 'bookings',
    })).toEqual([]);
  });

  it('normalizes Arabic/Persian digits without accepting partial, negative or malformed amounts', () => {
    expect(normalizeBudgetNumber('١٬٢٥٠٫٥٠')).toBe('1250.50');
    expect(normalizeBudgetNumber('۱٬۲۵۰٫۵۰')).toBe('1250.50');
    expect(normalizeBudgetNumber('1,250.50')).toBe('1250.50');
    for (const bad of ['-20', '12,34', '1.2.3', '1000000', '20.123', '£20']) expect(normalizeBudgetNumber(bad)).toBeNull();
    expect(budgetNumbers('£-20 and ۱۲٫۳۴ and 1,234.50')).toEqual(['12.34', '1234.50']);
    expect(checkGoal('create ads for house20.com, no budget yet', { ...empty, budget: { amount: '20', currency: null, period: 'day' } })).toContain('UNGROUNDED_AMOUNT');
  });

  it('recognizes explicit currencies and periods without inferring an ambiguous currency', () => {
    for (const [message, currency, period] of [
      ['اعمل حملة بميزانية ٥٠ درهم إماراتي كل يوم', 'AED', 'day'],
      ['اعمل حملة بميزانية ٥٠ جنيه مصري في الأسبوع', 'EGP', 'week'],
      ['اعمل حملة بميزانية ٥٠ جنيه إسترليني في الشهر', '£', 'month'],
      ['اعمل حملة بميزانية ٥٠ يورو يومياً', '€', 'day'],
    ] as const) expect(checkGoal(message, { ...empty, budget: { amount: '50', currency, period } }), message).toEqual([]);
    expect(checkGoal('اعمل حملة بميزانية ٥٠ جنيه كل يوم', { ...empty, budget: { amount: '50', currency: '£', period: 'day' } })).toContain('UNGROUNDED_CURRENCY');
    expect(checkGoal('اعمل حملة بميزانية ٥٠ يومياً', { ...empty, budget: { amount: '50', currency: null, period: 'day' } })).toEqual([]);
  });

  it('refuses negated requests/goals/places and ambiguous numeric choices', () => {
    expect(checkGoal('لا تنشئ حملة الآن', empty)).toContain('NEGATED_CREATE_REQUEST');
    expect(checkGoal("Don't create a campaign", empty)).toContain('NEGATED_CREATE_REQUEST');
    expect(checkGoal('أنشئ حملة في الرياض، لا أريد مكالمات', { ...empty, locations: ['الرياض'], goal: 'calls' })).toContain('NEGATED_GOAL');
    expect(checkGoal('make ads in Glasgow, not in Leeds', { ...empty, locations: ['Leeds'] })).toContain('NEGATED_LOCATION');
    expect(checkGoal('اعمل حملة باستثناء الرياض', { ...empty, locations: ['الرياض'] })).toContain('NEGATED_LOCATION');
    expect(checkGoal('اعمل حملة بميزانية ٢٠ أو ٣٠ دولار يومياً', { ...empty, budget: { amount: '20', currency: '$', period: 'day' } })).toContain('AMBIGUOUS_BUDGET');
    expect(checkGoal('create ads, £20 or £30 daily', { ...empty, budget: { amount: '30', currency: '£', period: 'day' } })).toContain('AMBIGUOUS_BUDGET');
    expect(checkGoal('لا تنشئ حملة الآن', { ...empty, intent: 'other' })).toEqual([]);
  });

  it('keeps missing values null and rejects Arabic request words as entity values', () => {
    expect(checkGoal('أريد حملة إعلانات', empty)).toEqual([]);
    expect(checkGoal('أريد حملة إعلانات', { ...empty, service: 'حملة إعلانات' })).toContain('REQUEST_WORD_SERVICE');
    expect(checkGoal('أريد حملة إعلانات', { ...empty, service: 'سباكة' })).toContain('UNGROUNDED_SERVICE');
    expect(GOLD_GOALS.find(item => item.message.includes('my salon'))?.output.service).toBe('salon');
  });

  it('refuses undecided budget periods but allows unrelated period mentions', () => {
    for (const message of [
      'Create ads for pottery classes, budget £65 daily or weekly; I have not decided',
      'Create ads for pottery classes, budget £65 per day or per month',
      'أنشئ حملة بميزانية ٦٥ دولار يومياً أم أسبوعياً، لم أحسم الفترة',
      'أنشئ حملة بميزانية ٦٥ دولار كل يوم أو كل شهر',
    ]) {
      const budget: Goal['budget'] = { amount: '65', currency: null, period: 'day' };
      expect(checkGoal(message, { ...empty, budget }), message).toContain('AMBIGUOUS_BUDGET_PERIOD');
      expect(checkGoal(message, empty), message).toEqual([]);
    }
    expect(checkGoal('Advertise weekly pottery lessons, £65 daily', {
      ...empty, service: 'pottery lessons', budget: { amount: '65', currency: '£', period: 'day' },
    })).toEqual([]);
    expect(checkGoal('Create ads with £65 daily, send reports weekly or monthly', {
      ...empty, budget: { amount: '65', currency: '£', period: 'day' },
    })).toEqual([]);
  });
});

describe('Request words are never a service or a place', () => {
  it('refuses "Google Ads" as a service and "$40/day" or "fill" as a place', () => {
    const message = 'Launch a search campaign for cleanhomesaustin.com in Austin. $40/day. Goal: leads';
    const good = { intent: 'create_campaign', url: 'cleanhomesaustin.com', service: null, locations: ['Austin'], budget: { amount: '40', currency: '$', period: 'day' }, goal: 'leads' };
    expect(checkGoal(message, good)).toEqual([]);
    expect(checkGoal(message, { ...good, locations: ['Austin', '$40/day'] })).toContain('NOT_A_PLACE');
    expect(checkGoal(message, { ...good, service: 'search campaign' })).toContain('REQUEST_WORD_SERVICE');
    expect(checkGoal(message, { ...good, goal: 'calls' })).toContain('UNGROUNDED_GOAL');
    const other = 'set me up a campaign on google show it to people around omaha and fill my calendar with bookings';
    expect(checkGoal(other, { ...good, url: null, budget: null, goal: 'bookings', service: 'google', locations: ['omaha', 'fill'] })).toEqual(['REQUEST_WORD_SERVICE', 'NOT_A_PLACE']);
  });
});
