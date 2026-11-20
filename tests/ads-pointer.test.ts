import { describe, it, expect } from 'vitest';
import { GOLD_GOALS, checkGoal, generateGoals, heldOutOnlyWords, reservedGoalWords, widePhrasingWords, type Goal } from '../scripts/ads-training/goal.js';
import { checkSiteAds, siteAds, siteDigest } from '../scripts/ads-training/site.js';
import {
  goalToPointer, goalWords, pointerToGoal, pointerToSite, renderGoalPointerPrompt, repairGoalPointer, renderSitePointerPrompt, samePointerAds, siteToPointer,
} from '../scripts/ads-training/pointer.js';

describe('Brain repair of a goal answer (what the sentence itself shows)', () => {
  const read = (message: string, answer: string) => pointerToGoal(message, repairGoalPointer(message, answer));

  it('moves the link to the one web address when the model pointed one word early', () => {
    // Real answers of pointer-v3 on phrasings it was not trained on (2026-11-14).
    const message = 'make ads for mobile tyre fitting on dukestreettyres.com in Glasgow and Edinburgh';
    expect(checkGoal(message, pointerToGoal(message, 'intent create_campaign; url 4; service 4-5; locations 10 12'))).toContain('UNGROUNDED_URL');
    const goal = read(message, 'intent create_campaign; url 4; service 4-5; locations 10 12');
    // URL evidence is unambiguous; there is no equally strong evidence to extend the service.
    expect(goal).toMatchObject({ url: 'dukestreettyres.com', service: 'mobile tyre', locations: ['Glasgow', 'Edinburgh'] });
    expect(checkGoal(message, goal)).toEqual([]);
  });

  it('cuts the link and request words off the service, and drops a service of request words only', () => {
    expect(read('can you advertise my bakery sweetcrumbs.com in Manchester', 'intent create_campaign; url 4; service 5-6; locations 8'))
      .toMatchObject({ url: 'sweetcrumbs.com', service: 'bakery', locations: ['Manchester'] });
    expect(read('build me a campaign for my cleaning business cleanslate.com.au in Perth', 'intent create_campaign; url 6; service 6-8; locations 11'))
      .toMatchObject({ url: 'cleanslate.com.au', service: 'cleaning' });
    const message = 'we are selling handmade candles at glowwick.co.uk, need a google campaign';
    const goal = read(message, 'intent create_campaign; url 7; service 10-11');
    expect(goal).toMatchObject({ url: 'glowwick.co.uk', service: null });
    expect(checkGoal(message, goal)).toEqual([]);
  });

  it('points the amount at the one number and drops a goal nobody asked for', () => {
    const message = 'Google ads campaign: tyrerescue.uk, Edinburgh, Dundee, £15/day, calls';
    expect(read(message, 'intent create_campaign; url 4; amount 6; currency £; period day; goal calls')).toMatchObject({ budget: { amount: '15', currency: '£', period: 'day' }, goal: 'calls' });
    const bakery = 'I own a small bakery in Leeds, need google ads. budget about £300 a month';
    const goal = read(bakery, 'intent create_campaign; service 4-5; locations 7; amount 13; currency £; period month; goal leads');
    expect(goal).toMatchObject({ goal: null, service: 'small bakery' });
    expect(checkGoal(bakery, goal)).toEqual([]);
  });

  it('keeps the model pick when two links or two numbers leave the brain unsure, and leaves other answers alone', () => {
    const two = 'compare a.com and b.co.uk ads';
    expect(repairGoalPointer(two, 'intent create_campaign; url 2')).toBe('intent create_campaign; url 2');
    expect(repairGoalPointer(two, 'intent other')).toBe('intent other');
    expect(repairGoalPointer(two, 'nonsense')).toBe('nonsense');
  });

  it('keeps service boundaries before a following clause without needing a verb stop-list', () => {
    for (const message of [
      'Advertise dance classes could you target Halifax',
      'Promote watch restoration through our website',
      'Advertise ceramic glazing attracting local clients',
    ]) {
      expect(read(message, 'intent create_campaign; service 2-3')?.service).toBe(goalWords(message).slice(1, 3).join(' '));
    }
  });

  it('preserves budget when it describes the offering rather than the spending limit', () => {
    const message = 'Create ads for budget guitar lessons in Beverley';
    const answer = 'intent create_campaign; service 4-6; locations 8';
    expect(repairGoalPointer(message, answer)).toBe(answer);
    const result = read(message, answer);
    expect(result).toMatchObject({ service: 'budget guitar lessons', locations: ['Beverley'], budget: null });
    expect(checkGoal(message, result)).toEqual([]);
  });

  it('never changes a correct answer', () => {
    const examples = generateGoals({ seed: 12, counts: { train: 400, validation: 40, test: 80, test_unseen_phrasing: 80 } });
    for (const item of [...examples.map(example => ({ message: example.input.message, output: example.output })), ...GOLD_GOALS]) {
      expect(read(item.message, goalToPointer(item.message, item.output)!), item.message).toEqual(item.output);
    }
  });
});

describe('Arabic and mixed-language pointer values', () => {
  it('repairs a missing URL independently of exact Arabic prefix offsets', () => {
    const message = 'أنشئ حملة لتصليح الأثاث بالطائف والرابط cedarcraft.sa';
    const answer = 'intent create_campaign; service 3-4@1; locations 5@1';
    const repaired = repairGoalPointer(message, answer);
    expect(repaired).toBe('intent create_campaign; url 7; service 3-4@1; locations 5@1');
    expect(pointerToGoal(message, repaired)).toMatchObject({ url: 'cedarcraft.sa', service: 'تصليح الأثاث', locations: ['الطائف'] });
  });

  it('represents exact attached Arabic suffixes without guessing a missing article', () => {
    const message = 'أريد حملة لتركيب الإطارات بالرياض والخبر';
    const goal: Goal = { intent: 'create_campaign', service: 'تركيب الإطارات', locations: ['الرياض', 'الخبر'], url: null, budget: null, goal: null };
    const answer = goalToPointer(message, goal)!;
    expect(answer).toBe('intent create_campaign; service 3-4@1; locations 5@1 6@1');
    expect(pointerToGoal(message, answer)).toEqual(goal);
    expect(repairGoalPointer(message, answer)).toBe(answer);
    expect(goalToPointer('اعمل حملة للحلاقة', { ...goal, service: 'الحلاقة', locations: [] })).toBeNull();
    expect(pointerToGoal('اعمل حملة للحلاقة', 'intent create_campaign; service 3@2')?.service).toBe('حلاقة');
  });

  it('bounds Arabic offsets and refuses offsets for Latin text or empty suffixes', () => {
    for (const ref of ['3@0', '3@4', '3@99', '3-9@1', '0@1']) {
      expect(pointerToGoal('اعمل حملة بالرياض', `intent create_campaign; locations ${ref}`), ref).toBeNull();
    }
    expect(pointerToGoal('ads in Bristol', 'intent create_campaign; locations 3@1')).toBeNull();
    expect(pointerToGoal('اعمل حملة في', 'intent create_campaign; locations 3@2')).toBeNull();
  });

  it('strips Arabic edge punctuation but preserves digits, URL text and multiword spans', () => {
    const message = 'اعمل حملة لخدمة تنظيف المنازل في الرياض، على cleanhome.sa، بميزانية ١٬٢٥٠٫٥٠ ريال سعودي شهرياً؛ أريد مكالمات';
    const goal: Goal = { intent: 'create_campaign', service: 'تنظيف المنازل', url: 'cleanhome.sa', locations: ['الرياض'], budget: { amount: '1250.50', currency: 'SAR', period: 'month' }, goal: 'calls' };
    expect(goalWords(message)).toContain('الرياض');
    expect(goalWords(message)).toContain('١٬٢٥٠٫٥٠');
    const pointer = goalToPointer(message, goal);
    expect(pointer).not.toBeNull();
    expect(pointerToGoal(message, pointer!)).toEqual(goal);
    expect(pointerToGoal(message, repairGoalPointer(message, pointer!))).toEqual(goal);
    expect(checkGoal(message, pointerToGoal(message, pointer!))).toEqual([]);
  });

  it('handles Persian digits and selects the amount rather than digits inside a URL', () => {
    const message = 'أنشئ ads لموقع house20.com في Leeds بميزانية ۲۰ دولار يومياً';
    const goal: Goal = { intent: 'create_campaign', url: 'house20.com', service: null, locations: ['Leeds'], budget: { amount: '20', currency: '$', period: 'day' }, goal: null };
    const pointer = goalToPointer(message, goal)!;
    expect(pointer).toContain('amount 8');
    expect(pointerToGoal(message, pointer)).toEqual(goal);
  });

  it('does not split malformed amounts into plausible smaller values', () => {
    const message = 'اعمل حملة بميزانية ١٢٬٣٤ دولار يومياً';
    expect(pointerToGoal(message, 'intent create_campaign; amount 5; currency $; period day')).toBeNull();
    expect(pointerToGoal('ads £-20 daily', 'intent create_campaign; amount 2; currency £; period day')).toBeNull();
  });
});

describe('Pointer answers for the chat goal (ads.goal.v2)', () => {
  const message = 'make ads for kerbsidetyres.co.uk in Wigan, £20 a day';

  it('numbers the words and answers with positions only', () => {
    expect(goalWords(message)).toEqual(['make', 'ads', 'for', 'kerbsidetyres.co.uk', 'in', 'Wigan', '£20', 'a', 'day']);
    expect(renderGoalPointerPrompt(message)).toBe('Ads task: ads.goal.v2\nWords: [1] make [2] ads [3] for [4] kerbsidetyres.co.uk [5] in [6] Wigan [7] £20 [8] a [9] day\nOutput:\n');
    const goal = { intent: 'create_campaign' as const, url: 'kerbsidetyres.co.uk', service: null, locations: ['Wigan'], budget: { amount: '20', currency: '£' as const, period: 'day' as const }, goal: null };
    const answer = goalToPointer(message, goal);
    expect(answer).toBe('intent create_campaign; url 4; locations 6; amount 7; currency £; period day');
    expect(pointerToGoal(message, answer!)).toEqual(goal);
  });

  it('decodes every generated and handwritten example back to its label', () => {
    const examples = generateGoals({ seed: 11, counts: { train: 300, validation: 30, test: 60, test_unseen_phrasing: 60 } });
    for (const item of [...examples.map(example => ({ message: example.input.message, output: example.output })), ...GOLD_GOALS]) {
      const answer = goalToPointer(item.message, item.output);
      expect(answer, item.message).not.toBeNull();
      expect(pointerToGoal(item.message, answer!), item.message).toEqual(item.output);
    }
  });

  it('can pick the wrong word, but never spells a word that is not in the sentence', () => {
    const wrongPick = pointerToGoal(message, 'intent create_campaign; url 6; locations 4');
    expect(wrongPick).toMatchObject({ url: 'Wigan', locations: ['kerbsidetyres.co.uk'] });
    expect(checkGoal(message, wrongPick)).toContain('UNGROUNDED_URL'); // "Wigan" is not a web address
    const twoWords = pointerToGoal('ads for my dog grooming shop in North London', 'intent create_campaign; service 4-5; locations 8-9');
    expect(twoWords).toMatchObject({ service: 'dog grooming', locations: ['North London'] });
  });

  it('refuses answers that are not well formed', () => {
    for (const bad of ['', 'intent maybe', 'intent create_campaign; url 40', 'intent create_campaign; url 0', 'intent create_campaign; locations 6; url 4',
      'intent create_campaign; url 4; url 4', 'intent create_campaign; amount 7', 'intent create_campaign; amount 7; currency ¥; period day',
      'intent create_campaign; goal sales', 'intent other; url 4', 'intent create_campaign; url Wigan']) {
      expect(pointerToGoal(message, bad), bad).toBeNull();
    }
  });
});

describe('Pointer answers for website ads (ads.site.v2)', () => {
  const page = [
    'Kerbside Tyres | Mobile Tyre Fitting in Wigan',
    'Kerbside Tyres',
    'Mobile Tyre Fitting',
    'Puncture Repairs',
    'Emergency Tyre Replacement',
    'We fit new tyres at your home or workplace across Wigan. Book online in two minutes and pay on the day.',
    'Our vans carry budget and premium tyres in every common size, so most jobs are done the same day.',
    'Locking Wheel Nut Removal',
  ].join('\n');
  const input = siteDigest('https://www.kerbsidetyres.co.uk/', 'Kerbside Tyres | Mobile Tyre Fitting in Wigan', page);

  it('numbers title segments, lines and sentences', () => {
    const prompt = renderSitePointerPrompt(input);
    expect(prompt).toContain('[T1] Kerbside Tyres\n[T2] Mobile Tyre Fitting in Wigan\n');
    expect(prompt).toContain('[5.1] We fit new tyres at your home or workplace across Wigan.\n[5.2] Book online in two minutes and pay on the day.\n');
  });

  it("turns the teacher's ads into pointers and back without changing a character", () => {
    const ads = siteAds(input);
    expect(ads).not.toBeNull();
    const answer = siteToPointer(input, ads!);
    expect(answer).toMatch(/^business T1 2; headlines B /);
    const back = pointerToSite(input, answer!)!;
    expect(samePointerAds(back, ads!)).toBe(true);
    expect(checkSiteAds(input, back)).toEqual([]);
  });

  it('refuses references to lines or sentences that do not exist', () => {
    for (const bad of ['headlines T1 2', 'headlines 99; descriptions 6', 'headlines 2 3; descriptions 5', 'headlines 2 3; descriptions 6.1',
      'business T9 1; headlines B; descriptions 6', 'headlines 2; descriptions 6; colour blue']) {
      expect(pointerToSite(input, bad), bad).toBeNull();
    }
  });
});

describe('Pointer-v2: only usable lines, and the brain drops bad picks', () => {
  const page = [
    'Kerbside Tyres | Mobile Tyre Fitting in Wigan', // the crawler's first line is the title; siteDigest skips it
    'Kerbside Tyres', 'Mobile Tyre Fitting', 'Contact us',
    'We fit new tyres at your home or workplace across Wigan. Book online in two minutes and pay on the day.',
    'Our vans carry budget and premium tyres in every common size, so most jobs are done the same day.',
    'A very long line that is far too long to ever be a headline and has no full stop',
  ].join('\n');
  const input = siteDigest('https://www.kerbsidetyres.co.uk/', 'Kerbside Tyres | Mobile Tyre Fitting in Wigan', page);

  it('lists only lines the brain can use, keeping their numbers', () => {
    const prompt = renderSitePointerPrompt(input, { usableOnly: true });
    expect(prompt).toContain('[1] Kerbside Tyres\n[2] Mobile Tyre Fitting\n');
    expect(prompt).toContain('[4.1] We fit new tyres');
    expect(prompt).not.toContain('Contact us');
    expect(prompt).not.toContain('A very long line');
  });

  it('drops picks that cannot be used and keeps the rest', () => {
    const ads = pointerToSite(input, 'business 1 2; headlines B 2 2 3 6; descriptions 4.1 4.1 5');
    expect(ads?.headlines).toEqual(['Kerbside Tyres', 'Mobile Tyre Fitting']);
    // "Contact us" (3) and line 6 are not headlines, the repeats are dropped; line 5 is cut where its clause ends.
    expect(ads?.descriptions).toEqual(['We fit new tyres at your home or workplace across Wigan.', 'Our vans carry budget and premium tyres in every common size.']);
    expect(pointerToSite(input, 'headlines 2; descriptions 4')).toBeNull(); // line 4 has two sentences: a malformed ref
  });

  it('decodes every v2 training service span, however long', () => {
    const examples = generateGoals({ seed: 3, counts: { train: 500, validation: 10, test: 10, test_unseen_phrasing: 10 }, composedServices: true });
    expect(examples.some(item => (item.output.service?.split(' ').length ?? 0) >= 3 && item.split === 'train')).toBe(true);
    for (const item of examples) expect(pointerToGoal(item.input.message, goalToPointer(item.input.message, item.output)!), item.input.message).toEqual(item.output);
  });
});

describe('Goal v3: training services from a large vocabulary', () => {
  it('never uses a template or held-out word as a service word, and leaves held-out splits unchanged', () => {
    const vocabulary = ['knife', 'breed', 'nucleus', 'transition'];
    const counts = { train: 300, validation: 20, test: 20, test_unseen_phrasing: 20 };
    const v1 = generateGoals({ seed: 5, counts, composedServices: true });
    const v3 = generateGoals({ seed: 5, counts, composedServices: true, serviceVocabulary: vocabulary });
    expect(v3.filter(item => item.split !== 'train')).toEqual(v1.filter(item => item.split !== 'train'));
    expect(v3.some(item => item.output.service?.split(' ').every(word => vocabulary.includes(word)))).toBe(true);
    const reserved = reservedGoalWords();
    for (const word of ['for', 'in', 'business', 'website', 'wigan', 'chimney', 'conversions']) expect(reserved.has(word), word).toBe(true);
  });
});

describe('v4 extra train-only phrasings', () => {
  it('never use a word that only the held-out unseen phrasings use', () => {
    const held = heldOutOnlyWords(), wide = widePhrasingWords();
    expect(held.size).toBeGreaterThan(10);
    expect([...wide].filter(word => held.has(word))).toEqual([]);
  });

  it('change only the train split, and every train example passes the checker', () => {
    const vocabulary = ['knife', 'breed', 'nucleus', 'transition'];
    const counts = { train: 400, validation: 20, test: 20, test_unseen_phrasing: 20 };
    const v3 = generateGoals({ seed: 5, counts, composedServices: true, serviceVocabulary: vocabulary });
    const v4 = generateGoals({ seed: 5, counts, composedServices: true, serviceVocabulary: vocabulary, widePhrasing: true });
    expect(v4.filter(item => item.split !== 'train')).toEqual(v3.filter(item => item.split !== 'train'));
    const train = v4.filter(item => item.split === 'train');
    expect(train.filter(item => !v3.some(old => old.id === item.id)).length).toBeGreaterThan(0);
    for (const item of train) expect(checkGoal(item.input.message, item.output), item.input.message).toEqual([]);
  });
});
