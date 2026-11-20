import { describe, expect, it, vi } from 'vitest';
import { createAdsModelChat, type AdsBrief, dailyBudget, suggestFields, looksEnglishRequest, missingFields, pageLines, readAnswer, serviceClean, serviceOnSite, servicePhrase, siteCountry, siteSearchPhrases, tidyLine } from '../apps/server/src/assistant/ads-model-chat.js';
import { goalToPointer, siteToPointer, GOAL_POINTER_CAPABILITY } from '../scripts/ads-training/pointer.js';
import { siteAds, siteDigest } from '../scripts/ads-training/site.js';

const URL_ = 'https://kerbsidetyres.co.uk/';
const HTML = `<!doctype html><html lang="en-GB"><head><title>Kerbside Tyres | Mobile Tyre Fitting Wigan</title>
<script>var tracking = "Buy now";</script><style>.x{}</style></head><body>
<nav><a href="/">Home</a><a href="/contact">Contact</a></nav>
<h1>Kerbside Tyres</h1>
<h2>Mobile Tyre Fitting</h2>
<h2>Emergency Tyre Repair</h2>
<h3>Puncture Repair Service</h3>
<p>We fit new tyres at your home or workplace across Wigan.</p>
<p>Our vans carry budget and premium tyres for most cars and vans.</p>
<p>Call 01942 555 0123 or email hello@kerbsidetyres.co.uk today.</p>
<footer>&copy; 2026 Kerbside Tyres. All rights reserved.</footer></body></html>`;

const read = pageLines(HTML);
const input = siteDigest(URL_, read.title, `${read.title}\n${read.text}`);
const teacher = siteAds(input);

function fakeWorker(answers: { goal?: (message: string) => string[]; site?: () => string[] }) {
  return {
    files: vi.fn(async () => null),
    sample: vi.fn(async (prompt: string) => {
      if (prompt.startsWith(`Ads task: ${GOAL_POINTER_CAPABILITY}`)) {
        const message = prompt.split('\n')[1]!.replace(/^Words:/, '').split(/ \[\d+\] /).filter(Boolean).join(' ');
        return { candidates: (answers.goal?.(message) ?? []).map(text => ({ text, finished: true })), ms: 1 };
      }
      return { candidates: (answers.site?.() ?? []).map(text => ({ text, finished: true })), ms: 1 };
    }),
  };
}
const fetchPage = vi.fn(async () => ({ status: 200, finalUrl: URL_, html: HTML, contentLanguage: null }));
const io = () => ({ signal: new AbortController().signal, step: vi.fn(async () => {}) });

describe('reading business owners’ answers', () => {
  const brief: AdsBrief = { url: 'example.com', service: null, serviceChoices: [], locations: [], country: 'GB', budget: null, goal: null, asked: ['service', 'locations'], rounds: 1 };

  it.each([
    ['English', 'in New York\nservice: home cleaning', 'home cleaning', 'New York'],
    ['Arabic', 'في أبو ظبي\nالخدمة: تنظيف المنازل', 'تنظيف المنازل', 'أبو ظبي'],
  ])('keeps a reordered %s service description out of locations', (_language, answer, service, location) => {
    expect(readAnswer(answer, brief)).toEqual({ ...brief, service, locations: [location] });
  });

  const cases: { name: string; answer: string; before?: Partial<AdsBrief>; expected: Partial<AdsBrief> }[] = [
    { name: 'Modern Standard Arabic', answer: 'الخدمة: تنظيف المنازل، المناطق: الرياض، الدولة: السعودية، الميزانية: ٣٠٠ ريال شهرياً، الهدف: طلبات تواصل', before: { country: null, asked: ['service', 'locations', 'country', 'budget', 'goal'] }, expected: { service: 'تنظيف المنازل', locations: ['الرياض'], country: 'SA', budget: { amount: '300', currency: 'SAR', period: 'month' }, goal: 'leads' } },
    { name: 'Gulf Arabic with English service and place names', answer: 'الخدمة mobile tyre fitting، المناطق Glasgow، أبي مكالمات، ميزانيتي ٥٠ جنيه باليوم', expected: { service: 'mobile tyre fitting', locations: ['Glasgow'], budget: { amount: '50', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'Egyptian Arabic and joined place conjunctions', answer: 'الخدمة تنظيف شقق، المناطق مدينة نصر والمعادي، عايز مكالمات، الميزانية ١٥٠ جنيه مصري في اليوم', before: { country: 'EG' }, expected: { service: 'تنظيف شقق', locations: ['مدينة نصر', 'المعادي'], budget: { amount: '150', currency: 'EGP', period: 'day' }, goal: 'calls' } },
    { name: 'Levantine Arabic and Western digits', answer: 'الخدمة: تصليح مكيفات، المناطق: عمّان والزرقاء، بدي حجوزات، الميزانية 20 دولار بالشهر', before: { country: 'JO' }, expected: { service: 'تصليح مكيفات', locations: ['عمّان', 'الزرقاء'], budget: { amount: '20', currency: '$', period: 'month' }, goal: 'bookings' } },
    { name: 'reordered answers and a common-word place', answer: 'bookings; budget: £50; locations: Reading; service: home cleaning', expected: { service: 'home cleaning', locations: ['Reading'], budget: { amount: '50', currency: '£', period: 'day' }, goal: 'bookings' } },
    { name: 'two free answers in one line', answer: 'home cleaning in New York', expected: { service: 'home cleaning', locations: ['New York'] } },
    { name: 'two typed answers in one clause', answer: '£20 per day for calls', expected: { budget: { amount: '20', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'a service-only partial answer', answer: 'service: home cleaning', expected: { service: 'home cleaning' } },
    { name: 'a location-only partial answer', answer: 'in New York', expected: { locations: ['New York'] } },
    { name: 'a repeated known service before the missing location', answer: 'home cleaning in Bath', before: { service: 'home cleaning', asked: ['locations', 'budget', 'goal'] }, expected: { locations: ['Bath'] } },
    { name: 'a country among places', answer: 'home cleaning\nGlasgow, UK\n£20\ncalls', before: { country: null, asked: ['service', 'locations', 'country', 'budget', 'goal'] }, expected: { service: 'home cleaning', locations: ['Glasgow'], country: 'GB', budget: { amount: '20', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'a goal word inside a service', answer: 'service: Emergency Call Out; locations: Bath; budget: £20; goal: bookings', expected: { service: 'Emergency Call Out', locations: ['Bath'], budget: { amount: '20', currency: '£', period: 'day' }, goal: 'bookings' } },
    { name: 'a number inside a service is not a budget', answer: 'service: 24 hour tyre repair; locations: Bath', expected: { service: '24 hour tyre repair', locations: ['Bath'] } },
    { name: 'a domain containing a number', answer: 'site: clean24.co.uk; budget: 50', before: { url: null, asked: ['url', 'service', 'locations', 'budget', 'goal'] }, expected: { url: 'clean24.co.uk', budget: { amount: '50', currency: null, period: 'day' } } },
    { name: 'a domain starting with a number is not a budget', answer: '24clean.co.uk', before: { url: null, asked: ['url', 'service', 'locations', 'budget', 'goal'] }, expected: { url: '24clean.co.uk' } },
    { name: 'numbered parts arriving out of order', answer: '٤. مكالمات\n٢. أبو ظبي\n١. تنظيف المنازل\n٣. ٥٠ درهم', expected: { service: 'تنظيف المنازل', locations: ['أبو ظبي'], budget: { amount: '50', currency: 'AED', period: 'day' }, goal: 'calls' } },
    { name: 'a missing numbered location', answer: '1. home cleaning\n3. £50\n4. calls', expected: { service: 'home cleaning', budget: { amount: '50', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'an empty numbered location', answer: '1. home cleaning\n2.\n3. £50\n4. calls', expected: { service: 'home cleaning', budget: { amount: '50', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'one numbered partial answer', answer: '3. £50', expected: { budget: { amount: '50', currency: '£', period: 'day' } } },
    { name: 'an extra numbered country without shifting the budget or goal', answer: '1. home cleaning\n2. UK\n3. £25 a day\n4. calls', before: { locations: ['Bath'], country: null, asked: ['service', 'budget', 'goal'] }, expected: { service: 'home cleaning', country: 'GB', budget: { amount: '25', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'an invalid extra numbered note does not fill a missing location', answer: '1. home cleaning\n3. £25\n4. calls\n5. thanks', expected: { service: 'home cleaning', budget: { amount: '25', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'numbered service retains a result word', answer: '1. Emergency Call Out\n2. Bath\n3. £20\n4. bookings', expected: { service: 'Emergency Call Out', locations: ['Bath'], budget: { amount: '20', currency: '£', period: 'day' }, goal: 'bookings' } },
    { name: 'a numbered service can itself be a goal word', answer: '1. Bookings\n2. Bath\n3. £20\n4. calls', expected: { service: 'Bookings', locations: ['Bath'], budget: { amount: '20', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'an inserted numbered country before a location', answer: '1. home cleaning\n2. UK\n3. Leeds\n4. £25\n5. calls', expected: { service: 'home cleaning', locations: ['Leeds'], budget: { amount: '25', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'an explicitly numbered whole-country location', answer: '1. home cleaning\n2. UK\n3. £25\n4. calls', expected: { service: 'home cleaning', locations: ['United Kingdom'], budget: { amount: '25', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'an unnumbered whole-country location', answer: 'UK', before: { service: 'home cleaning', asked: ['locations', 'budget', 'goal'] }, expected: { locations: ['United Kingdom'] } },
    { name: 'a correction followed by other answers', answer: 'no, 50 not 15; service: home cleaning; locations: Bath; calls', before: { budget: { amount: '15', currency: '£', period: 'month' }, asked: ['service', 'locations', 'goal'] }, expected: { service: 'home cleaning', locations: ['Bath'], goal: 'calls', budget: { amount: '50', currency: '£', period: 'month' } } },
    { name: 'a known English service repeated on its own line', answer: 'home cleaning\nBath\n£50\ncalls', before: { service: 'home cleaning', asked: ['locations', 'budget', 'goal'] }, expected: { locations: ['Bath'], budget: { amount: '50', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'a known Arabic service repeated on its own line', answer: 'تنظيف المنازل\nالرياض\n٥٠ ريال\nمكالمات', before: { service: 'تنظيف المنازل', country: 'SA', asked: ['locations', 'budget', 'goal'] }, expected: { locations: ['الرياض'], budget: { amount: '50', currency: 'SAR', period: 'day' }, goal: 'calls' } },
    { name: 'a polite goal answer', answer: 'home cleaning\nBath\n£50\ncalls please', expected: { service: 'home cleaning', locations: ['Bath'], budget: { amount: '50', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'a goal with an English modifier', answer: 'home cleaning\nBath\n£50\nmore calls', expected: { service: 'home cleaning', locations: ['Bath'], budget: { amount: '50', currency: '£', period: 'day' }, goal: 'calls' } },
    { name: 'a goal with an Egyptian modifier', answer: 'تنظيف المنازل\nالرياض\n٥٠ ريال\nعايز مكالمات أكتر', expected: { service: 'تنظيف المنازل', locations: ['الرياض'], budget: { amount: '50', currency: 'SAR', period: 'day' }, goal: 'calls' } },
    { name: 'an empty labelled service', answer: 'service:; locations: Bath', expected: { locations: ['Bath'] } },
    { name: 'a budget sentence period is not a question number', answer: 'service: home cleaning\nbudget: 50.\nlocations: Bath\ncalls', expected: { service: 'home cleaning', locations: ['Bath'], budget: { amount: '50', currency: null, period: 'day' }, goal: 'calls' } },
    { name: 'a semicolon separates a place from a bare service', answer: 'locations: Bath; home cleaning', expected: { service: 'home cleaning', locations: ['Bath'] } },
    { name: 'commas continue a labelled list of multi-word places', answer: 'locations: New York, Los Angeles; service: home cleaning', expected: { service: 'home cleaning', locations: ['New York', 'Los Angeles'] } },
    { name: 'an inserted country does not fill a missing numbered city', answer: '1. home cleaning\n2. UK\n4. £25\n5. calls', expected: { service: 'home cleaning', budget: { amount: '25', currency: '£', period: 'day' }, goal: 'calls' } },
  ];
  it.each(cases)('reads $name without changing other facts', ({ answer, before, expected }) => {
    const initial: AdsBrief = { ...brief, asked: ['service', 'locations', 'budget', 'goal'], ...before };
    const unchanged = structuredClone(initial);
    expect(readAnswer(answer, initial)).toEqual({ ...initial, ...expected });
    expect(initial).toEqual(unchanged);
  });

  it.each<[string, NonNullable<AdsBrief['budget']>]>([
    ['50', { amount: '50', currency: null, period: 'day' }],
    ['£50', { amount: '50', currency: '£', period: 'day' }],
    ['50 per day', { amount: '50', currency: null, period: 'day' }],
    ['$50 per day', { amount: '50', currency: '$', period: 'day' }],
    ['50 per month', { amount: '50', currency: null, period: 'month' }],
    ['€50 per month', { amount: '50', currency: '€', period: 'month' }],
    ['١٥٠ جنيه مصري في الأسبوع', { amount: '150', currency: 'EGP', period: 'week' }],
    ['٢٥٫٥٠ ريال يومياً', { amount: '25.50', currency: 'SAR', period: 'day' }],
    ['١٬٥٠٠ درهم بالشهر', { amount: '1500', currency: 'AED', period: 'month' }],
    ['50 / month', { amount: '50', currency: null, period: 'month' }],
  ])('reads the budget %s as the only missing fact', (answer, budget) => {
    const initial: AdsBrief = { ...brief, service: 'home cleaning', locations: ['Reading'], goal: 'calls', asked: ['budget'] };
    expect(readAnswer(answer, initial)).toEqual({ ...initial, budget });
  });

  it.each(['no, 50 not 15', 'لا، ٥٠ مش ١٥', 'لا، ٥٠ مو ١٥'])('applies an explicit budget correction: %s', answer => {
    const initial: AdsBrief = { ...brief, budget: { amount: '15', currency: '£', period: 'month' }, asked: ['service', 'locations'] };
    expect(readAnswer(answer, initial)).toEqual({ ...initial, budget: { amount: '50', currency: '£', period: 'month' } });
  });

  it.each(['cancel', 'later', 'إلغاء', 'بعدين', 'What time is it in London?', 'اكتب لي رسالة اعتذار'])('leaves all facts unchanged for the nonanswer %s', answer => {
    const initial: AdsBrief = { ...brief, asked: ['locations', 'budget', 'goal'], service: 'home cleaning' };
    expect(readAnswer(answer, initial)).toEqual(initial);
  });

  // Known limitation: two unlabelled free answers in reverse order have no reliable field cue.
  it.fails('known limitation: distinguishes a bare place before a bare service', () => {
    expect(readAnswer('Reading\nhome cleaning', brief)).toEqual({ ...brief, service: 'home cleaning', locations: ['Reading'] });
  });
});

describe('Ads model in the main chat', () => {
  it('preserves Arabic site text and passes cancellation to a declared bilingual model', async () => {
    expect(pageLines('<html lang="ar"><p>تنظيف المنازل في الرياض</p><p>فريق متخصص في تنظيف السجاد</p></html>').text).toContain('تنظيف المنازل في الرياض');
    const message = 'أنشئ حملة لموقع example.com في الرياض بميزانية ٢٥ ريال سعودي يوميا';
    const goal = goalToPointer(message, { intent: 'create_campaign', url: 'example.com', service: null, locations: ['الرياض'], budget: { amount: '25', currency: 'SAR', period: 'day' }, goal: null })!;
    const worker = { ...fakeWorker({ goal: () => [goal], site: () => [siteToPointer(input, teacher!)!] }), languages: async () => ['ar', 'en'] };
    const requestIo = io();
    const reply = await createAdsModelChat({ worker, fetchPage }).handle(message, requestIo);
    expect(reply?.text).toContain('الرياض');
    expect(worker.sample.mock.calls[0]?.[0]).toContain('٢٥');
    expect(worker.sample).toHaveBeenCalledWith(expect.any(String), {}, 8, { signal: requestIo.signal });
  });

  it('does not accept a truncated goal response even if its prefix parses', async () => {
    const worker = { files: async () => null, sample: async () => ({ candidates: [{ text: 'intent create_campaign; url 4', finished: false }], ms: 1 }) };
    const reader = vi.fn(fetchPage);
    await createAdsModelChat({ worker, fetchPage: reader }).handle('make ads for example.com in Leeds', io());
    expect(reader).not.toHaveBeenCalled();
  });

  it('does not feed an unlabelled Arabic page to an English-only checkpoint', async () => {
    const message = 'make ads for example.com in Leeds';
    const goal = goalToPointer(message, { intent: 'create_campaign', url: 'example.com', service: null, locations: ['Leeds'], budget: null, goal: null })!;
    const worker = fakeWorker({ goal: () => [goal] });
    const reader = async () => ({ status: 200, finalUrl: 'https://example.com', html: '<html><h1>تنظيف المنازل</h1><p>خدمة تنظيف المنازل في الرياض</p></html>', contentLanguage: null });
    const reply = await createAdsModelChat({ worker, fetchPage: reader }).handle(message, io());
    expect(reply?.status).toBe('partial');
    expect(worker.sample).toHaveBeenCalledTimes(1);
  });

  it('reads a page as the model learnt pages: lines, no scripts, emails or phone numbers', () => {
    expect(read.title).toBe('Kerbside Tyres | Mobile Tyre Fitting Wigan');
    expect(read.language).toBe('en-GB');
    expect(read.text).not.toMatch(/tracking|hello@|01942/);
    expect(read.text.split('\n')).toContain('We fit new tyres at your home or workplace across Wigan.');
    expect(teacher).not.toBeNull();
  });

  it('cleans page lines on the brain side: buttons, banners, icons, capitals, calls to action', () => {
    expect(tidyLine('🚨 24/7 EMERGENCY TYRES • GLASGOW 🚨 24/7 EMERGENCY TYRES • GLASGOW 🚨 24/7 EMER')).toBe('24/7 Emergency Tyres • Glasgow');
    expect(tidyLine('✓ Fully insured')).toBe('Fully insured');
    expect(tidyLine('MOBILE TYRE FITTING IN GLASGOW')).toBe('Mobile Tyre Fitting in Glasgow');
    expect(tidyLine('We fit tyres in Wigan.')).toBe('We fit tyres in Wigan.');
    const page = pageLines('<html lang="en"><body><h2>Fully insured</h2><button>Call now</button><p>Tap to call now</p><p><span>Glasgow</span><span>Edinburgh</span>.</p></body></html>');
    expect(page.text.split('\n')).toEqual(['Fully insured', 'Glasgow Edinburgh.']);
    expect(tidyLine('Same-day Delivery →')).toBe('Same-day Delivery');
    expect(pageLines('<p>Visit Website →</p><p>Real tyres</p>').text).toBe('Real tyres');
  });

  it('never takes the link as the service', async () => {
    const message = 'create a campaign for tyrerescue.uk selling mobile tyre fitting in Edinburgh';
    const base = { intent: 'create_campaign' as const, url: 'tyrerescue.uk', locations: ['Edinburgh'], budget: null, goal: null };
    expect(serviceClean({ ...base, service: 'campaign for tyrerescue.uk' })).toBe(false);
    expect(serviceClean({ ...base, service: 'mobile tyre fitting' })).toBe(true);
    const wrong = goalToPointer(message, { ...base, service: 'campaign for tyrerescue.uk' })!;
    const right = goalToPointer(message, { ...base, service: 'mobile tyre fitting' })!;
    const read = (answers: string[]) => createAdsModelChat({ worker: fakeWorker({ goal: () => answers, site: () => [siteToPointer(input, teacher!)!] }), fetchPage }).handle(message, io());
    expect((await read([wrong, right]))?.text).toContain('الخدمة: mobile tyre fitting');
    const dropped = await read([wrong]);
    // The model's service swallowed the link and was dropped; the brain then finds the service the
    // sentence and the site's title both name, so it is not asked.
    expect(dropped?.brief?.service).toBe('mobile tyre fitting');
    expect(dropped?.brief?.asked).not.toContain('service');
    expect(dropped?.text).not.toContain('campaign for');
  });

  it('keeps Arabic and short requests on the ordinary path', async () => {
    const worker = fakeWorker({});
    const chat = createAdsModelChat({ worker, fetchPage });
    expect(looksEnglishRequest('اعمل حملة لموقع kerbsidetyres.co.uk')).toBe(false);
    expect(await chat.handle('اعمل حملة لموقع kerbsidetyres.co.uk', io())).toBeNull();
    expect(await chat.handle('hello there', io())).toBeNull();
    expect(worker.sample).not.toHaveBeenCalled();
  });

  it('turns one sentence into a checked campaign draft from the site’s own lines', async () => {
    const message = 'make ads for kerbsidetyres.co.uk in Wigan, £20 a day';
    const goal = goalToPointer(message, { intent: 'create_campaign', url: 'kerbsidetyres.co.uk', service: null, locations: ['Wigan'], budget: { amount: '20', currency: '£', period: 'day' }, goal: null })!;
    const worker = fakeWorker({ goal: () => ['intent maybe', goal], site: () => ['headlines 99', siteToPointer(input, teacher!)!] });
    const chat = createAdsModelChat({ worker, fetchPage });
    const first = io();
    const asked = await chat.handle(message, first);
    // The brain read the sentence and the site first: the country comes from .co.uk, so only the
    // service and the result are asked, together, in one message.
    expect(asked?.status).toBe('waiting_user');
    expect(asked?.brief).toMatchObject({ url: 'kerbsidetyres.co.uk', locations: ['Wigan'], country: 'GB', asked: ['service', 'goal'], rounds: 1 });
    expect(asked?.text).toMatch(/1\. ما الخدمة[\s\S]*2\. ماذا تريد من الإعلان/);
    expect(first.step).toHaveBeenCalledTimes(2);
    const goalCalls = worker.sample.mock.calls.length;

    const steps = io();
    const reply = await chat.handle(message, steps, { brief: asked!.brief!, answer: '1. Mobile Tyre Fitting\n2. مكالمات' });
    expect(reply?.status).toBe('completed');
    expect(reply?.text).toContain('Mobile Tyre Fitting');
    expect(reply?.text).toContain('£20 يومياً');
    expect(reply?.text).toContain('Wigan');
    expect(reply?.campaign).toMatch(/^SERVICE: Mobile Tyre Fitting$/m);
    expect(reply?.campaign).toMatch(/^GOAL: calls$/m);
    expect(reply?.campaign).toMatch(/^COUNTRY: GB$/m);
    expect(reply?.campaign).toMatch(/^BUDGET: 20$/m);
    expect(reply?.campaign).toMatch(/^LOCATION: Wigan$/m);
    expect(reply?.campaign).toMatch(/^H: /m);
    expect(fetchPage).toHaveBeenCalledWith('https://kerbsidetyres.co.uk', expect.anything());
    expect(steps.step).toHaveBeenCalledTimes(3);
    // The answer is read by code: the goal model is not asked again, only the site model.
    expect(worker.sample.mock.calls.length).toBe(goalCalls + 1);
  });

  it('asks for the link together with everything else missing, in one message', async () => {
    const message = 'create a google ads campaign for my bakery in Leeds';
    const worker = fakeWorker({ goal: () => [goalToPointer(message, { intent: 'create_campaign', url: null, service: null, locations: ['Leeds'], budget: null, goal: null })!] });
    const reply = await createAdsModelChat({ worker, fetchPage }).handle(message, io());
    expect(reply?.status).toBe('waiting_user');
    expect(reply?.brief?.asked).toEqual(['url', 'service', 'country', 'budget', 'goal']);
    expect(reply?.text).toContain('رابط موقعك');
    expect(reply?.text).toContain('المناطق: Leeds');
    expect(reply?.text).toContain('5 أشياء');
  });

  it('asks again only for what the answer did not give, and stops after three rounds', async () => {
    const message = 'make ads for kerbsidetyres.co.uk in Wigan, £20 a day';
    const goal = goalToPointer(message, { intent: 'create_campaign', url: 'kerbsidetyres.co.uk', service: null, locations: ['Wigan'], budget: { amount: '20', currency: '£', period: 'day' }, goal: null })!;
    const chat = createAdsModelChat({ worker: fakeWorker({ goal: () => [goal], site: () => [siteToPointer(input, teacher!)!] }), fetchPage });
    const asked = await chat.handle(message, io());
    const again = await chat.handle(message, io(), { brief: asked!.brief!, answer: 'mobile tyre fitting' });
    expect(again?.status).toBe('waiting_user');
    expect(again?.brief).toMatchObject({ service: 'mobile tyre fitting', asked: ['goal'], rounds: 2 });
    expect(again?.text).toContain('ينقصني شيء واحد');
    const third = await chat.handle(message, io(), { brief: again!.brief!, answer: 'not sure' });
    const last = await chat.handle(message, io(), { brief: third!.brief!, answer: 'hmm' });
    expect(last?.status).toBe('blocked');
    expect(last?.text).toContain('الهدف');
  });

  it('lets the owner choose when the readings disagree on the service', async () => {
    const message = 'make ads for kerbsidetyres.co.uk selling tyre fitting and puncture repair in Wigan, £20 a day for calls';
    const base = { intent: 'create_campaign' as const, url: 'kerbsidetyres.co.uk', locations: ['Wigan'], budget: { amount: '20', currency: '£' as const, period: 'day' as const }, goal: 'calls' as const };
    const a = goalToPointer(message, { ...base, service: 'tyre fitting' })!;
    const b = goalToPointer(message, { ...base, service: 'puncture repair' })!;
    const chat = createAdsModelChat({ worker: fakeWorker({ goal: () => [a, b], site: () => [siteToPointer(input, teacher!)!] }), fetchPage });
    const asked = await chat.handle(message, io());
    expect(asked?.brief?.asked).toEqual(['service']);
    expect(asked?.text).toContain('«tyre fitting» أم «puncture repair»');
    const done = await chat.handle(message, io(), { brief: asked!.brief!, answer: 'الثاني' });
    expect(done?.status).toBe('completed');
    expect(done?.campaign).toMatch(/^SERVICE: puncture repair$/m);
  });

  it('reads answers by code: numbered, unnumbered, Arabic digits, countries among places', () => {
    const brief: Omit<AdsBrief, 'asked'> = { url: 'x.com', service: null, serviceChoices: [], locations: [], country: null, budget: null, goal: null, rounds: 1 };
    expect(readAnswer('1. mobile tyre fitting\n2. Glasgow، Edinburgh\n3. ٢٠ جنيه إسترليني يومياً\n4. مكالمات', { ...brief, asked: ['service', 'locations', 'budget', 'goal'] }))
      .toMatchObject({ service: 'mobile tyre fitting', locations: ['Glasgow', 'Edinburgh'], budget: { amount: '20', currency: '£', period: 'day' }, goal: 'calls' });
    expect(readAnswer('Glasgow and Edinburgh, $150 a week, bookings', { ...brief, asked: ['locations', 'budget', 'goal'] }))
      .toMatchObject({ locations: ['Glasgow', 'Edinburgh'], budget: { amount: '150', currency: '$', period: 'week' }, goal: 'bookings' });
    expect(readAnswer('Glasgow, UK', { ...brief, asked: ['locations', 'country'] })).toMatchObject({ locations: ['Glasgow'], country: 'GB' });
    expect(readAnswer('mobile tyre fitting in Glasgow and Leeds', { ...brief, asked: ['service', 'locations'] })).toMatchObject({ service: 'mobile tyre fitting', locations: ['Glasgow', 'Leeds'] });
    expect(readAnswer('اتصالات وحجوزات', { ...brief, asked: ['goal'] }).goal).toBeNull();
    // An extra numbered answer the brain did not ask ("2. UK") must not shift the others.
    expect(readAnswer('1. mobile tyre fitting\n2. UK\n3. £25 a day\n4. calls', { ...brief, asked: ['service', 'budget', 'goal'] }))
      .toMatchObject({ service: 'mobile tyre fitting', country: 'GB', budget: { amount: '25', currency: '£', period: 'day' }, goal: 'calls' });
    expect(readAnswer('emergency tyre repair, Edinburgh, Leith', { ...brief, asked: ['service', 'locations'] })).toMatchObject({ service: 'emergency tyre repair', locations: ['Edinburgh', 'Leith'] });
    expect(servicePhrase('create a google ads campaign for mobile tyre fitting on tyrerescue.uk in Edinburgh, £15 a day for calls', 'Mobile Tyre Fitting Scotland | Glasgow, Edinburgh', ['Edinburgh'])).toBe('mobile tyre fitting');
    expect(servicePhrase('make ads for kerbsidetyres.co.uk in Wigan, £20 a day', 'Kerbside Tyres | Mobile Tyre Fitting Wigan', ['Wigan'])).toBeNull();
    expect(serviceOnSite('plumbing', 'Mobile Tyre Fitting Scotland')).toBe(false);
    expect(serviceOnSite('tyre fitting', 'Our tyre fitters come to you')).toBe(true);
    expect(dailyBudget({ amount: '150', currency: '£', period: 'week' })).toBe('21.43');
    expect(dailyBudget({ amount: '20', currency: '£', period: 'day' })).toBe('20');
    expect(siteCountry('https://shop.co.uk/a')).toBe('GB');
    expect(siteCountry('https://shop.com', 'en-US')).toBeNull();
    expect(siteCountry('https://shop.com', 'en-IE')).toBe('IE');
    expect(missingFields({ ...brief, asked: [], service: 'a b', locations: ['Leeds'], country: 'GB', budget: { amount: '5', currency: null, period: 'day' }, goal: 'leads' })).toEqual([]);
  });

  it('leaves a non-campaign sentence to the ordinary path', async () => {
    const worker = fakeWorker({ goal: () => ['intent other'] });
    expect(await createAdsModelChat({ worker, fetchPage }).handle('what is the weather like in London today', io())).toBeNull();
  });

  it('never shows copy that failed the checker', async () => {
    const message = 'make ads for kerbsidetyres.co.uk in Wigan, £20 a day for calls about tyre fitting';
    const goal = goalToPointer(message, { intent: 'create_campaign', url: 'kerbsidetyres.co.uk', service: 'tyre fitting', locations: ['Wigan'], budget: { amount: '20', currency: '£', period: 'day' }, goal: 'calls' })!;
    const worker = fakeWorker({ goal: () => [goal], site: () => ['headlines 99; descriptions 99', 'nonsense'] });
    const reply = await createAdsModelChat({ worker, fetchPage }).handle(message, io());
    expect(reply?.campaign).toBeUndefined();
    expect(reply?.status).toBe('partial');
    expect(reply?.text).not.toContain('Mobile Tyre Fitting');
  });

  it('refuses a site that is not in English', async () => {
    const message = 'make ads for kerbsidetyres.co.uk in Wigan';
    const goal = goalToPointer(message, { intent: 'create_campaign', url: 'kerbsidetyres.co.uk', service: null, locations: ['Wigan'], budget: null, goal: null })!;
    const french = vi.fn(async () => ({ status: 200, finalUrl: URL_, html: HTML.replace('lang="en-GB"', 'lang="fr"'), contentLanguage: null }));
    const reply = await createAdsModelChat({ worker: fakeWorker({ goal: () => [goal] }), fetchPage: french }).handle(message, io());
    expect(reply?.status).toBe('partial');
    expect(reply?.text).toContain('ليست بالإنجليزية');
  });
});

describe('the brain suggests answers from the site in the request', () => {
  // A different business from the tyre fixture: nothing in the suggestions is tied to one site.
  const BARBER = `<!doctype html><html lang="en-GB"><head><title>Jano Barbershop | Skin Fades &amp; Beard Trims in Muirhead</title></head><body>
<h1>Jano Barbershop</h1><h2>Skin Fades</h2><h2>Beard Trims</h2><h3>Hot Towel Shave</h3>
<p>Walk in for skin fades and beard trims in Muirhead, Stepps and Chryston.</p><p>Skin fades from £15.</p>
<a href="tel:01412345678">Call</a><a href="https://booksy.com/jano">Book now</a></body></html>`;
  const read = pageLines(BARBER);
  const site = { html: BARBER, title: read.title, text: read.text, business: 'https://janobarbershop.co.uk/' };
  const brief: AdsBrief = { url: 'janobarbershop.co.uk', service: null, serviceChoices: [], locations: [], country: 'GB', budget: null, goal: null, asked: [], rounds: 1 };

  it('takes services, places, currency and the result from that site', () => {
    const fields = suggestFields(brief, ['service', 'locations', 'budget', 'goal'], site);
    const by = Object.fromEntries(fields.map(field => [field.id, field]));
    expect(by.service!.suggestions.map(item => item.label)).toEqual(expect.arrayContaining(['Skin Fades', 'Beard Trims']));
    expect(by.service!.suggestions.map(item => item.label)).not.toContain('Jano Barbershop');
    expect(by.service!.selected).toEqual([0]);
    expect(by.locations!.multiple).toBe(true);
    expect(by.locations!.suggestions.map(item => item.label)).toEqual(expect.arrayContaining(['Muirhead', 'Stepps', 'Chryston']));
    expect(by.budget!.suggestions.map(item => item.label)).toEqual(['£10 يومياً', '£20 يومياً', '£40 يومياً']);
    expect(by.budget!.selected).toBeUndefined();
    expect(by.goal!.suggestions[0]).toMatchObject({ label: 'مكالمات', reason: expect.stringContaining('هاتف') });
    expect(by.goal!.selected).toEqual([0]);
  });

  it('reads the card’s numbered reply, even when a service holds a result word', () => {
    const asked: AdsBrief = { ...brief, asked: ['service', 'locations', 'budget', 'goal'] };
    expect(readAnswer('1. Emergency Call Out\n2. Muirhead, Stepps\n3. £20 يومياً\n4. حجوزات', asked))
      .toMatchObject({ service: 'Emergency Call Out', locations: ['Muirhead', 'Stepps'], budget: { amount: '20', currency: '£', period: 'day' }, goal: 'bookings' });
  });

  it('suggests no fixed answers when the site is unknown, except budget levels and the result kinds', () => {
    const fields = suggestFields({ ...brief, country: null }, ['url', 'service', 'budget', 'goal'], null);
    expect(fields.find(field => field.id === 'url')!.suggestions).toEqual([]);
    expect(fields.find(field => field.id === 'service')!.suggestions).toEqual([]);
    expect(fields.find(field => field.id === 'goal')!.selected).toBeUndefined();
  });
});

describe('keywords from the site’s own words', () => {
  const TYRES = `<!doctype html><html lang="en-GB"><head><title>Mobile Tyre Fitting Glasgow, Edinburgh &amp; Dundee | 24/7 Emergency | Duke Street Tyres</title></head><body>
<h1>MOBILE TYRE FITTING IN GLASGOW, EDINBURGH &amp; DUNDEE</h1><h2>Tyre brands we offer</h2><h2>FLAT TYRE IN GLASGOW, EDINBURGH &amp; DUNDEE ?</h2>
<h2>DUKE STREET TYRES</h2><h2>GLASGOW</h2><h3>Card, contactless &amp; Apple Pay</h3>
<p>Emergency mobile tyre fitting across Glasgow. Mobile tyre fitting at your kerb, 24/7.</p></body></html>`;
  const read = pageLines(TYRES);

  it('takes heading phrases that end on the service, and the urgency words the page says', () => {
    const phrases = siteSearchPhrases(TYRES, read.title, read.text, 'mobile tyre fitting', 'https://www.dukestreettyres.com/', ['Glasgow']);
    expect(phrases).toEqual(expect.arrayContaining(['mobile tyre fitting', 'flat tyre', 'emergency mobile tyre fitting', '24 hour mobile tyre fitting']));
    // Not the business name, not a place, not a heading that does not end on what is sold.
    for (const bad of ['duke street tyres', 'tyre brands', 'glasgow', 'apple pay']) expect(phrases).not.toContain(bad);
  });

  it('adds no urgency words the page does not say', () => {
    const calm = TYRES.replace(/24\/7 Emergency \| |Emergency |, 24\/7/g, '');
    const quiet = pageLines(calm);
    const phrases = siteSearchPhrases(calm, quiet.title, quiet.text, 'mobile tyre fitting', 'https://www.dukestreettyres.com/', ['Glasgow']);
    expect(phrases.some(phrase => /emergency|24 hour/.test(phrase))).toBe(false);
  });
});
