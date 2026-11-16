/**
 * ads.goal.v1: one chat sentence -> the campaign goal the brain acts on.
 *   "make google ads for kerbsidetyres.co.uk in Wigan, £20 a day, I want calls"
 *   -> {"intent":"create_campaign","url":"kerbsidetyres.co.uk","locations":["Wigan"],
 *       "budget":{"amount":"20","currency":"GBP","period":"day"},"goal":"calls","service":null}
 *
 * The model only copies what the sentence says. It never guesses: anything the user did not
 * write stays null, and the brain asks for it or reads it from the website. checkGoal rejects
 * any value that is not in the sentence, so a wrong guess cannot reach the campaign.
 * English and Arabic contracts; bilingual model quality requires separate training and evaluation.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, inventedPlace, rng } from './lib.js';
import { CITIES } from './verticals.js';

export const GOAL_CAPABILITY = 'ads.goal.v1';
export const GOAL_DATASET_VERSION = 'ads-goal-v1';
/** v2 adds 2-4 word training services, so the model learns where a long service name ends. */
export const GOAL_DATASET_VERSION_V2 = 'ads-goal-v2';
/** v3: half the training services are 1-3 words from a large vocabulary, so the end of a service comes from the sentence, not from known words. */
export const GOAL_DATASET_VERSION_V3 = 'ads-goal-v3';
export type GoalSplit = 'train' | 'validation' | 'test' | 'test_unseen_phrasing' | 'gold';
/** The currency as the user wrote it; the brain resolves $ to USD, CAD or AUD from the country. */
export type Currency = '£' | '$' | '€' | 'SAR' | 'AED' | 'EGP';
export interface Budget { amount: string; currency: Currency | null; period: 'day' | 'week' | 'month' }
export interface Goal {
  intent: 'create_campaign' | 'other';
  url: string | null; service: string | null; locations: string[];
  budget: Budget | null; goal: 'calls' | 'bookings' | 'leads' | null;
}
export interface GoalExample {
  id: string; capability: typeof GOAL_CAPABILITY; split: GoalSplit; vertical: 'goal';
  source: 'synthetic' | 'handwritten'; input: { message: string }; output: Goal;
}

const EMPTY: Goal = { intent: 'other', url: null, service: null, locations: [], budget: null, goal: null };

// ---------------------------------------------------------------- vocabulary
// Held-out lists never appear in train, so test measures copying, not memory.
const SERVICES = {
  train: ['mobile tyre fitting', 'house removals', 'plumbing', 'locksmith', 'barber', 'italian restaurant', 'dog grooming', 'cleaning', 'carpet cleaning',
    'window cleaning', 'roofing', 'electrician', 'dentist', 'physiotherapy', 'yoga classes', 'personal training', 'driving lessons', 'tutoring',
    'accountancy', 'web design', 'wedding photography', 'florist', 'bakery', 'coffee shop', 'car repair', 'mot testing', 'car valeting',
    'solar panel installation', 'boiler repair', 'gardening', 'landscaping', 'pest control', 'skip hire', 'storage', 'nail salon', 'hair salon',
    'beauty salon', 'massage', 'pet sitting', 'dog walking', 'vet', 'opticians', 'pharmacy', 'estate agent', 'letting agent', 'mortgage advice',
    'legal services', 'immigration advice', 'translation', 'printing', 'sign making', 'tattoo studio', 'gym', 'martial arts classes', 'dance school',
    'music lessons', 'childcare', 'care home', 'home care', 'taxi', 'airport transfers', 'courier', 'van hire', 'car hire', 'scaffolding',
    'kitchen fitting', 'bathroom fitting', 'flooring', 'painting and decorating', 'plastering', 'fencing', 'driveway paving', 'tree surgery',
    'handyman', 'appliance repair', 'phone repair', 'computer repair', 'it support', 'seo', 'catering', 'wedding venue', 'event planning',
    'bike shop', 'furniture shop', 'clothing', 'jewellery', 'skincare products', 'pet food', 'online courses', 'accounting software'],
  test: ['chimney sweeping', 'mobile mechanic', 'aquarium supplies', 'piano tuning', 'drone surveys', 'gutter cleaning', 'horse riding lessons',
    'bridal boutique', 'vegan takeaway', 'escape room', 'hearing tests', 'loft conversions'],
};
// v2 only: words put in front of a training service ("emergency boiler repair"). Never forms a held-out service.
const SERVICE_MODIFIERS = ['emergency', 'commercial', 'domestic', 'mobile', 'local', 'affordable', '24 hour', 'same day', 'luxury', 'professional',
  'eco friendly', 'residential', 'family', 'private', 'express', 'premium', 'independent', 'specialist', 'weekend', 'online'];
function trainService(random: Random, composed: boolean, vocabulary?: readonly string[]): string {
  if (vocabulary?.length && random.next() < 0.5) {
    const roll = random.next(), size = roll < 0.3 ? 1 : roll < 0.8 ? 2 : 3;
    return Array.from({ length: size }, () => random.pick(vocabulary)).join(' ');
  }
  const base = random.pick(SERVICES.train);
  if (!composed || random.next() >= 0.45) return base;
  const service = `${random.pick(SERVICE_MODIFIERS)} ${base}`;
  return SERVICES.test.some(held => service.includes(held)) || service.split(' ').length > 4 ? base : service;
}

const US_PLACES = {
  train: ['London', 'Austin', 'Denver', 'Seattle', 'Boston', 'Phoenix', 'Dallas', 'Chicago', 'Miami', 'Atlanta', 'Portland', 'Toronto', 'Vancouver',
    'Sydney', 'Melbourne', 'Dublin', 'Cork', 'Auckland', 'Texas', 'Ontario', 'Greater Manchester', 'West Yorkshire', 'Kent', 'Surrey', 'Essex', 'England', 'Wales',
    'North London', 'South Wales', 'Scotland', 'Ireland'],
  test: ['Tucson', 'Omaha', 'Halifax', 'Galway', 'Brisbane', 'Raleigh', 'Boise', 'Cornwall'],
};
const DOMAIN_WORDS = ['kerbside', 'swift', 'prime', 'city', 'local', 'green', 'happy', 'bright', 'smart', 'first', 'rapid', 'royal', 'urban',
  'north', 'south', 'east', 'west', 'blue', 'golden', 'little', 'best', 'clear', 'true', 'fresh', 'simply', 'pro', 'super', 'top', 'one', 'my'];
const DOMAIN_TAILS = ['tyres', 'movers', 'plumbing', 'locks', 'cuts', 'kitchen', 'paws', 'clean', 'roofs', 'sparks', 'smiles', 'physio', 'yoga',
  'fitness', 'driving', 'tutors', 'accounts', 'design', 'photos', 'flowers', 'bakes', 'coffee', 'motors', 'solar', 'heating', 'gardens', 'homes',
  'care', 'cars', 'shop', 'store', 'studio', 'services', 'group', 'co', 'hq', 'online', 'direct', 'hub', 'works'];
const TLDS = ['com', 'co.uk', 'uk', 'net', 'org.uk', 'ie', 'com.au', 'ca', 'io', 'shop', 'org', 'co'];

// ---------------------------------------------------------------- phrasing
// {url} and {service} are filled in; a template is chosen to match which of them the user gives.
const OPENINGS = {
  train: [
    'create a google ads campaign for {url}', 'make ads for {url}', 'set up google ads for {url}', 'can you run ads for {url}',
    'build a search campaign for {url}', 'start a new campaign for my website {url}', 'I want to advertise {url} on google', 'launch google ads for {url}',
    'new campaign for {url}', 'please create an ad campaign for {url}', 'make a campaign for {url}', 'create google ads for my site {url}',
    'create a campaign for my {service} business, website is {url}', 'I run a {service} company ({url}), make me some google ads',
    'advertise my {service} service, site: {url}', 'make a google ads campaign for {service} at {url}', 'set up ads for {service}, the website is {url}',
    'my website is {url}, I do {service}. create a campaign', 'create a {service} campaign for {url}', 'run google ads for my {service} website {url}',
    'I need google ads for my {service} business', 'create ads for {service}', 'run a campaign for {service}', 'set up a google ads campaign for {service}',
    'make me a google ads campaign', 'create a new search campaign', 'I want to start advertising on google', 'set up google ads for me',
  ],
  test_unseen_phrasing: [
    'could you put together some google ads for {url}', 'get {url} on google ads', 'promote {url} with a search campaign',
    'we sell {service}, our site is {url} - need ads', 'help me advertise {service} on google, website {url}', 'i want more customers for {url}, set up ads',
    'google ads for my {service} business please', 'set me up a campaign on google',
  ],
};
const LOCATION = {
  train: ['in {L}', 'targeting {L}', 'for people in {L}', 'around {L}', 'covering {L}', 'near {L}', 'location: {L}', 'only in {L}', 'in the {L} area'],
  test_unseen_phrasing: ['aimed at customers in {L}', 'show it to people around {L}', 'area: {L}'],
};
type Phrasing = 'train' | 'test_unseen_phrasing';
// {c} symbol, {w} currency word, {a} amount
const BUDGET: Record<Phrasing, readonly (readonly [string, Budget['period']])[]> = {
  train: [
    ['{c}{a} a day', 'day'], ['{c}{a} per day', 'day'], ['budget {c}{a}/day', 'day'], ['daily budget {c}{a}', 'day'], ['spend {c}{a} a day', 'day'],
    ['{a} {w} a day', 'day'], ['max {c}{a} daily', 'day'], ['budget of {a} {w} per day', 'day'], ['budget {a} a day', 'day'],
    ['{c}{a} a month', 'month'], ['monthly budget {c}{a}', 'month'], ['budget of {a} {w} per month', 'month'], ['{c}{a}/month', 'month'],
    ['{c}{a} per week', 'week'], ['weekly budget {c}{a}', 'week'],
  ],
  test_unseen_phrasing: [['we can afford {c}{a} each day', 'day'], ['{c}{a} every month', 'month'], ['about {a} {w} weekly', 'week']],
};
const CURRENCIES: { symbol: string; words: string[]; code: Currency }[] = [
  { symbol: '£', words: ['pounds', 'quid', 'GBP'], code: '£' }, { symbol: '$', words: ['dollars', 'bucks', 'USD'], code: '$' }, { symbol: '€', words: ['euros', 'EUR'], code: '€' },
];
const GOALS = {
  train: {
    calls: ['to get more phone calls', 'I want calls', 'goal: calls', 'we want people to ring us', 'I want the phone to ring', 'focus on calls'],
    bookings: ['to get bookings', 'I want more appointments', 'goal is bookings', 'we want table reservations', 'focus on bookings', 'to get people to book online'],
    leads: ['to get leads', 'I want more enquiries', 'goal: quote requests', 'we need leads', 'focus on enquiries', 'I want people to request a quote'],
  },
  test_unseen_phrasing: {
    calls: ['make the phone ring'], bookings: ['fill my calendar with bookings'], leads: ['get people to fill in the contact form'],
  },
} as const;
const OTHER = {
  train: [
    'what is the weather in {L}', 'write a poem about the sea', 'how much does {service} cost in {L}', 'find me a {service} in {L}',
    'translate this to french', 'what time is it', 'remind me to call my accountant tomorrow', 'how do google ads work?', 'what is a good ctr?',
    'summarise this article', 'open {url}', 'what does {url} sell?', 'check if {url} is down', 'write an email to my landlord',
    'show me my campaign report', 'pause my campaigns', 'how much should I spend on google ads?', 'hi', 'thanks!', 'who are you?',
    'write a blog post about {service}', 'what are the best keywords for {service}?', 'is {url} a good website?', 'book a table in {L}',
    'what is the population of {L}?', 'make a logo for my business', 'fix the bug in my code', 'tell me a joke',
  ],
  test_unseen_phrasing: ['how many people live in {L}', 'can you review {url} for me', 'explain what a search campaign is', 'recommend a {service} near {L}'],
};
/** Every word the phrasing templates use, plus the held-out vocabulary: none may be a random service word. */
export function reservedGoalWords(): Set<string> {
  const texts = [...OPENINGS.train, ...OPENINGS.test_unseen_phrasing, ...LOCATION.train, ...LOCATION.test_unseen_phrasing,
    ...BUDGET.train.map(([text]) => text), ...BUDGET.test_unseen_phrasing.map(([text]) => text),
    ...Object.values(GOALS.train).flat(), ...Object.values(GOALS.test_unseen_phrasing).flat(), ...OTHER.train, ...OTHER.test_unseen_phrasing,
    ...SERVICE_MODIFIERS, ...SERVICES.test, ...US_PLACES.test, ...CITIES.test, ...CITIES.validation, ...CURRENCIES.flatMap(item => item.words),
    'hi hey please ok hello can you help thanks thank'];
  return new Set(texts.join(' ').toLowerCase().split(/[^a-z]+/).filter(Boolean));
}

const PREFIXES = ['', '', '', '', 'hi, ', 'hey ', 'please ', 'ok ', 'Hello. ', 'can you help? '];
const SUFFIXES = ['', '', '', '', '.', '!', ' thanks', ' please', ' thank you.', '?'];
const JOINERS = [', ', ', ', '. ', ' - ', ' and ', ' '];

// ---------------------------------------------------------------- generation
type Random = ReturnType<typeof rng>;

function domain(random: Random, held: boolean): string {
  const base = random.next() < 0.5 ? random.pick(DOMAIN_WORDS) + random.pick(DOMAIN_TAILS)
    : inventedPlace(random).split(' ').pop()!.toLowerCase() + random.pick(DOMAIN_TAILS);
  const name = held ? `${base}${random.pick(['uk', 'now', 'hq', 'ltd', 'plus'])}` : base;
  const host = `${random.next() < 0.15 ? `${name.slice(0, 4)}-${name.slice(4)}` : name}.${random.pick(TLDS)}`;
  const scheme = random.pick(['', '', '', 'www.', 'https://', 'https://www.', 'http://']);
  const path = random.next() < 0.12 ? random.pick(['/services', '/book', '/contact', '/shop', '/plumbing']) : '';
  return scheme + host + path;
}

function places(random: Random, split: GoalSplit): string[] {
  const pool = split === 'train' ? null : split === 'validation' ? CITIES.validation : [...CITIES.test, ...US_PLACES.test];
  const one = () => pool ? random.pick(pool) : random.next() < 0.45 ? inventedPlace(random) : random.next() < 0.6 ? random.pick(CITIES.train) : random.pick(US_PLACES.train);
  const count = random.next() < 0.75 ? 1 : random.next() < 0.7 ? 2 : 3;
  const chosen: string[] = [];
  for (let tries = 0; chosen.length < count && tries < 20; tries++) { const place = one(); if (!chosen.includes(place)) chosen.push(place); }
  return chosen;
}
const listPlaces = (random: Random, items: string[]) => items.length === 1 ? items[0]! : items.length === 2
  ? `${items[0]}${random.pick([' and ', ', ', ' & '])}${items[1]}` : `${items.slice(0, -1).join(', ')}${random.pick([' and ', ', '])}${items.at(-1)}`;

function amount(random: Random, period: Budget['period']): string {
  const base = period === 'day' ? 5 + random.int(96) : period === 'week' ? 30 + random.int(470) : 100 + random.int(2900);
  const rounded = period === 'month' && random.next() < 0.6 ? Math.round(base / 50) * 50 || 50 : base;
  return random.next() < 0.1 ? `${rounded}.${random.pick(['50', '99', '00'])}` : String(rounded);
}

/** Lowercasing is applied to the whole sentence, so the copied values are lowercased with it. */
function casing(random: Random, message: string, output: Goal): [string, Goal] {
  const roll = random.next();
  if (roll < 0.25) {
    const lower = (text: string | null) => text?.toLowerCase() ?? null;
    return [message.toLowerCase(), { ...output, url: lower(output.url), service: lower(output.service), locations: output.locations.map(place => place.toLowerCase()) }];
  }
  if (roll < 0.55) return [message.charAt(0).toUpperCase() + message.slice(1), output];
  return [message, output];
}

function createExample(random: Random, split: GoalSplit, phrasing: Phrasing, composed = false, vocabulary?: readonly string[]): [string, Goal] {
  const held = split === 'test' || split === 'test_unseen_phrasing';
  const service = held ? random.pick(SERVICES.test) : trainService(random, composed && split === 'train', split === 'train' ? vocabulary : undefined);
  const url = domain(random, held);
  const withUrl = random.next() < 0.8, withService = random.next() < 0.45;
  const templates = OPENINGS[phrasing === 'train' ? 'train' : 'test_unseen_phrasing'].filter(template =>
    template.includes('{url}') === withUrl && template.includes('{service}') === withService);
  const fallback = OPENINGS[phrasing].filter(template => template.includes('{url}') === withUrl);
  const opening = random.pick(templates.length ? templates : fallback);
  const output: Goal = { ...EMPTY, intent: 'create_campaign', url: opening.includes('{url}') ? url : null, service: opening.includes('{service}') ? service : null };
  const parts = [opening.replace('{url}', url).replace('{service}', service)];

  const clauses: string[] = [];
  if (random.next() < 0.75) {
    output.locations = places(random, split);
    clauses.push(random.pick(LOCATION[phrasing]).replace('{L}', listPlaces(random, output.locations)));
  }
  if (random.next() < 0.6) {
    const [template, period] = random.pick(BUDGET[phrasing]);
    const currency = random.pick(CURRENCIES), value = amount(random, period);
    const named = template.includes('{c}') || template.includes('{w}');
    output.budget = { amount: value, currency: named ? currency.code : null, period };
    clauses.push(template.replace('{c}', currency.symbol).replace('{w}', random.pick(currency.words)).replace('{a}', value));
  }
  if (random.next() < 0.5) {
    const goal = random.pick(['calls', 'bookings', 'leads'] as const);
    output.goal = goal;
    clauses.push(random.pick(GOALS[phrasing][goal]));
  }
  // The location usually follows the opening directly ("ads for x.com in Leeds"); the rest is shuffled.
  const ordered = clauses.length > 1 ? [clauses[0]!, ...random.sample(clauses.slice(1), clauses.length - 1)] : clauses;
  for (const [index, clause] of ordered.entries()) parts.push((index === 0 && output.locations.length ? ' ' : random.pick(JOINERS)) + clause);
  return casing(random, random.pick(PREFIXES) + parts.join('') + random.pick(SUFFIXES), output);
}

function otherExample(random: Random, split: GoalSplit, phrasing: Phrasing): [string, Goal] {
  const held = split === 'test' || split === 'test_unseen_phrasing';
  const message = random.pick(OTHER[phrasing]).replace('{L}', places(random, split)[0]!)
    .replace('{service}', random.pick(held ? SERVICES.test : SERVICES.train)).replace('{url}', domain(random, held));
  return casing(random, random.pick(PREFIXES) + message + random.pick(SUFFIXES), { ...EMPTY });
}

export const goalId = (message: string) => createHash('sha256').update(JSON.stringify([GOAL_CAPABILITY, message])).digest('hex').slice(0, 16);

/** composedServices (v2) changes only the train split; held-out splits come first from the seed, so they stay identical to v1. */
/** serviceVocabulary (v3) likewise changes only the train split. */
export interface GoalGenerateOptions { seed: number; counts: Record<Exclude<GoalSplit, 'gold'>, number>; composedServices?: boolean; serviceVocabulary?: readonly string[] }
export function generateGoals({ seed, counts, composedServices = false, serviceVocabulary }: GoalGenerateOptions): GoalExample[] {
  const random = rng(seed);
  // Gold sentences are evaluation only, so the generator never produces them.
  const seen = new Set<string>(GOLD_GOALS.map(item => goalId(item.message))), examples: GoalExample[] = [];
  for (const split of ['test', 'test_unseen_phrasing', 'validation', 'train'] as const) {
    const phrasing: Phrasing = split === 'test_unseen_phrasing' ? 'test_unseen_phrasing' : 'train';
    let made = 0;
    for (let tries = 0; made < counts[split] && tries < counts[split] * 20; tries++) {
      const [message, output] = random.next() < 0.15 ? otherExample(random, split, phrasing) : createExample(random, split, phrasing, composedServices, serviceVocabulary);
      const id = goalId(message);
      if (seen.has(id) || checkGoal(message, output).length) continue;
      seen.add(id);
      examples.push({ id, capability: GOAL_CAPABILITY, split, vertical: 'goal', source: 'synthetic', input: { message }, output });
      made++;
    }
  }
  return examples;
}

// ---------------------------------------------------------------- checking
export const CURRENCY_WORDS: Record<Currency, RegExp> = {
  '£': /£|\b(?:pounds?|quid|gbp)\b|جنيه(?:ا|ات)?\s+(?:إسترليني|استرليني)|باوند/iu,
  '$': /\$|\b(?:dollars?|bucks?|usd)\b|دولار(?:ا|ات)?/iu,
  '€': /€|\b(?:euros?|eur)\b|يورو/iu,
  SAR: /\bsar\b|ريال(?:ا|ات)?\s+سعودي|ر\.س/iu,
  AED: /\baed\b|درهم(?:ا|ات)?\s+إماراتي|درهم(?:ا|ات)?\s+اماراتي|د\.إ/iu,
  EGP: /\begp\b|جنيه(?:ا|ات)?\s+مصري|ج\.م/iu,
};
export const PERIOD_WORDS: Record<Budget['period'], RegExp> = {
  day: /\b(?:day|days|daily)\b|يومي(?:ا|اً)?|كل\s+يوم|في\s+اليوم|لليوم|\/يوم/iu,
  week: /\b(?:week|weeks|weekly)\b|أسبوعي(?:ا|اً)?|اسبوعي(?:ا|اً)?|كل\s+أسبوع|كل\s+اسبوع|في\s+الأسبوع|في\s+الاسبوع|للأسبوع|\/أسبوع/iu,
  month: /\b(?:month|months|monthly)\b|شهري(?:ا|اً)?|كل\s+شهر|في\s+الشهر|للشهر|\/شهر/iu,
};

/** Direct alternatives in the amount's clause do not select a budget period. */
export function ambiguousBudgetPeriod(message: string, amount: string): boolean {
  const periods = Object.entries(PERIOD_WORDS).flatMap(([period, pattern]) =>
    [...message.matchAll(new RegExp(pattern.source, 'giu'))].map(match => {
      const end = match.index! + match[0].length;
      return { period, start: match.index!, end: end + (message.slice(end).match(/^\p{M}+/u)?.[0].length ?? 0) };
    }))
    .sort((left, right) => left.start - right.start);
  return periods.some((period, index) => {
    const next = periods[index + 1];
    if (!next || period.period === next.period) return false;
    const between = message.slice(period.end, next.start).trim();
    if (!/^(?:or|versus|vs\.?|أو|او|أم|ام)(?:\s+(?:per|a|each|every|في|كل|لكل))?$/iu.test(between)) return false;
    // Periods can also describe lessons, reports, or opening hours. Require the stated
    // amount in this clause; punctuation inside a number does not start a new clause.
    const prefix = message.slice(0, period.start);
    const boundaries = [...prefix.matchAll(/(?<!\p{N})[,.:](?!\p{N})|[!?;،؛؟\n]/gu)];
    const boundary = boundaries[boundaries.length - 1];
    return budgetNumbers(prefix.slice(boundary ? boundary.index! + boundary[0].length : 0)).includes(amount);
  });
}

/** Numeric normalization changes digits/separators only, never the supplied monetary value. */
export function normalizeBudgetNumber(raw: string): string | null {
  const ascii = raw.replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x6f0));
  if (!/^(?:\d{1,6}|\d{1,3}(?:[,٬]\d{3})+)(?:[.٫]\d{1,2})?$/.test(ascii)) return null;
  const canonical = ascii.replace(/[,٬]/g, '').replace('٫', '.');
  return /^\d{1,6}(?:\.\d{1,2})?$/.test(canonical) ? canonical : null;
}

/** Complete number runs; malformed/negative runs never yield a valid shorter amount. */
export function budgetNumbers(text: string): string[] {
  return [...text.matchAll(/[+-]?[0-9٠-٩۰-۹]+(?:[.,٬٫][0-9٠-٩۰-۹]+)*/gu)]
    .flatMap(([raw]) => { const amount = normalizeBudgetNumber(raw); return amount === null ? [] : [amount]; });
}

const ARABIC_REQUEST_WORDS = new Set(('اعلان إعلان إعلانات اعلانات حملة حملات جوجل غوغل قوقل أنشئ انشئ أنشئوا إنشاء انشاء اعمل أعمل ابدأ ابدا شغل سو سوي سويلي أريد اريد نريد بدي أبغى ابغى ابغي عايز عاوز ممكن رجاء فضلك لطفا لو سمحت من فضلك لي لنا في على إلى الى عن مع عند حول فقط استهدف استهداف يستهدف للناس للعملاء منطقة مناطق مدينة المدن موقع الموقع موقعي موقعنا خدمة خدمات شركتي شركتنا نشاطي نشاطنا ميزانية الميزانية يوميا يومي شهريا شهري أسبوعيا اسبوعيا أسبوعي اسبوعي مكالمات اتصالات حجوزات حجز مواعيد استفسارات طلبات عروض سعر').split(/\s+/));
/**
 * Words of the request itself ("google", "ads", "campaign", "fill", "area"), never a service or a place.
 * A pointer answer is always in the sentence, so grounding alone cannot catch "service: Google Ads";
 * these rules make the brain ask instead (2026-11-14).
 */
export const PHRASING_WORDS = new Set([...OPENINGS.train, ...OPENINGS.test_unseen_phrasing, ...LOCATION.train, ...LOCATION.test_unseen_phrasing,
  ...BUDGET.train.map(([text]) => text), ...BUDGET.test_unseen_phrasing.map(([text]) => text), ...Object.values(GOALS.train).flat(),
  ...Object.values(GOALS.test_unseen_phrasing).flat(), ...OTHER.train, ...OTHER.test_unseen_phrasing, ...PREFIXES, ...SUFFIXES]
  .map(text => text.replace(/\{\w+\}/g, ' ')).join(' ').toLowerCase().split(/[^a-z]+/).filter(word => word.length > 1));
export const GOAL_WORDS: Record<'calls' | 'bookings' | 'leads', RegExp> = {
  calls: /\b(?:calls?|phone|ring)\b|مكالمات|اتصالات|اتصال|الهاتف|هاتف|يتصل/iu,
  bookings: /\b(?:book\w*|appointments?|reservations?|calendar)\b|حجوزات|حجز|مواعيد|يحجز/iu,
  leads: /\b(?:leads?|enquir\w*|inquir\w*|quotes?|contact form)\b|استفسارات|استفسار|عملاء\s+محتملين|(?:طلب|طلبات)\s+(?:عروض?|تواصل)|عرض\s+سعر|نموذج\s+(?:التواصل|الاتصال)/iu,
};
const onlyPhrasing = (value: string) => {
  const parts = value.toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
  return parts.length > 0 && parts.every(word => PHRASING_WORDS.has(word) || ARABIC_REQUEST_WORDS.has(word));
};
const NEGATIVE_REQUEST = /\b(?:do not|don't|never)\s+(?:create|make|start|launch|run|set up)\b|(?:لا\s+(?:تنشئ|تنشئوا|تعمل|تبدأ|تفتح|تشغل)|لا\s+(?:أريد|اريد|نريد)\s+(?:حملة|إعلان|اعلان))/iu;
const NEGATION_BEFORE_VALUE = /(?:\b(?:not|except|excluding|without|no)(?:\s+(?:in|for|any|more))?|(?:باستثناء|عدا|دون|بدون|ليس\s+في|لا\s+(?:أريد|اريد|نريد|تستهدف)))\s*$/iu;
function explicitlyNegated(message: string, value: string): boolean {
  const offset = message.toLowerCase().indexOf(value.toLowerCase());
  return offset >= 0 && NEGATION_BEFORE_VALUE.test(message.slice(Math.max(0, offset - 45), offset));
}
function negatedGoal(message: string, goal: keyof typeof GOAL_WORDS): boolean {
  const matches = message.matchAll(new RegExp(GOAL_WORDS[goal].source, 'giu'));
  return [...matches].some(match => NEGATION_BEFORE_VALUE.test(message.slice(Math.max(0, match.index! - 45), match.index)));
}

/** Grounding check: every value must be in the sentence. Returns issue codes; empty means accepted. */
export function checkGoal(message: string, output: unknown): string[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ['NOT_OBJECT'];
  const goal = output as Record<string, unknown>;
  const keys = Object.keys(goal).sort().join(',');
  if (keys !== 'budget,goal,intent,locations,service,url') return ['BAD_KEYS'];
  const issues: string[] = [];
  const text = (value: unknown) => value === null || (typeof value === 'string' && value.length > 0);
  if (goal.intent !== 'create_campaign' && goal.intent !== 'other') issues.push('BAD_INTENT');
  if (!text(goal.url) || !text(goal.service)) issues.push('BAD_TYPE');
  if (!Array.isArray(goal.locations) || !goal.locations.every(place => typeof place === 'string' && place.length > 1)) issues.push('BAD_LOCATIONS');
  if (goal.goal !== null && !['calls', 'bookings', 'leads'].includes(goal.goal as string)) issues.push('BAD_GOAL');
  if (issues.length) return issues;
  if (goal.intent === 'other') {
    if (goal.url !== null || goal.service !== null || (goal.locations as string[]).length || goal.budget !== null || goal.goal !== null) issues.push('OTHER_WITH_VALUES');
    return issues;
  }
  if (NEGATIVE_REQUEST.test(message)) issues.push('NEGATED_CREATE_REQUEST');
  if (typeof goal.url === 'string' && (!message.includes(goal.url) || !/^[\w:/.-]+\.[a-z]{2,}(?:\/[\w/-]*)?$/i.test(goal.url))) issues.push('UNGROUNDED_URL');
  if (typeof goal.service === 'string' && !message.includes(goal.service)) issues.push('UNGROUNDED_SERVICE');
  if (typeof goal.service === 'string' && onlyPhrasing(goal.service)) issues.push('REQUEST_WORD_SERVICE');
  if (typeof goal.service === 'string' && explicitlyNegated(message, goal.service)) issues.push('NEGATED_SERVICE');
  const locations = goal.locations as string[];
  if (locations.some(place => !message.includes(place))) issues.push('UNGROUNDED_LOCATION');
  if (new Set(locations.map(place => place.toLowerCase())).size !== locations.length) issues.push('DUPLICATE_LOCATION');
  // A place has no digits, money signs, slashes or dots, and is not a word of the request ("$40/day", "fill").
  if (locations.some(place => /[\p{N}$£€@/.:]/u.test(place) || onlyPhrasing(place))) issues.push('NOT_A_PLACE');
  if (locations.some(place => explicitlyNegated(message, place))) issues.push('NEGATED_LOCATION');
  if (goal.goal !== null && !GOAL_WORDS[goal.goal as keyof typeof GOAL_WORDS].test(message)) issues.push('UNGROUNDED_GOAL');
  if (goal.goal !== null && negatedGoal(message, goal.goal as keyof typeof GOAL_WORDS)) issues.push('NEGATED_GOAL');
  if (goal.budget !== null) {
    const budget = goal.budget as Record<string, unknown>;
    if (typeof budget !== 'object' || Object.keys(budget).sort().join(',') !== 'amount,currency,period') issues.push('BAD_BUDGET');
    else {
      const amounts = budgetNumbers(message.replace(/(?:https?:\/\/|www\.)?[^\s]+\.[a-z]{2,}(?:\/[^\s]*)?/gi, ''));
      if (typeof budget.amount !== 'string' || normalizeBudgetNumber(budget.amount) !== budget.amount || !amounts.includes(budget.amount)) issues.push('UNGROUNDED_AMOUNT');
      if (new Set(amounts).size > 1 && /\bor\b|\bbetween\b|(?:^|\s)(?:أو|او|بين)(?:\s|$)/iu.test(message)) issues.push('AMBIGUOUS_BUDGET');
      if (typeof budget.amount === 'string' && ambiguousBudgetPeriod(message, budget.amount)) issues.push('AMBIGUOUS_BUDGET_PERIOD');
      if (budget.currency !== null && !(typeof budget.currency === 'string' && Object.hasOwn(CURRENCY_WORDS, budget.currency) && CURRENCY_WORDS[budget.currency as Currency].test(message))) issues.push('UNGROUNDED_CURRENCY');
      if (!(typeof budget.period === 'string' && Object.hasOwn(PERIOD_WORDS, budget.period)) || !PERIOD_WORDS[budget.period as Budget['period']].test(message)) issues.push('UNGROUNDED_PERIOD');
    }
  }
  return issues;
}

/** Exact-match score per field, used for evaluation against labelled examples. */
export function compareGoal(expected: Goal, actual: Goal) {
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  const fields = { intent: same(expected.intent, actual.intent), url: same(expected.url, actual.url), service: same(expected.service, actual.service),
    locations: same(expected.locations, actual.locations), budget: same(expected.budget, actual.budget), goal: same(expected.goal, actual.goal) };
  return { fields, exact: Object.values(fields).every(Boolean) };
}

// ---------------------------------------------------------------- handwritten gold
// Written by hand in the ways people actually type; evaluation only, never trained on.
const g = (message: string, output: Partial<Goal>): { message: string; output: Goal } =>
  ({ message, output: { ...EMPTY, intent: 'create_campaign', ...output } });
export const GOLD_GOALS: { message: string; output: Goal }[] = [
  g('Create a Google Ads campaign for dukestreettyres.co.uk in Glasgow, £25 a day, I want phone calls', { url: 'dukestreettyres.co.uk', locations: ['Glasgow'], budget: { amount: '25', currency: '£', period: 'day' }, goal: 'calls' }),
  g('can u make ads for my site www.bellabarbers.com', { url: 'www.bellabarbers.com' }),
  g('I own a small bakery in Leeds, need google ads. budget about £300 a month', { service: 'bakery', locations: ['Leeds'], budget: { amount: '300', currency: '£', period: 'month' } }),
  g('set up ads for https://www.northwayplumbing.co.uk targeting Bolton and Wigan', { url: 'https://www.northwayplumbing.co.uk', locations: ['Bolton', 'Wigan'] }),
  g('Launch a search campaign for cleanhomesaustin.com in Austin. $40/day. Goal: leads', { url: 'cleanhomesaustin.com', locations: ['Austin'], budget: { amount: '40', currency: '$', period: 'day' }, goal: 'leads' }),
  g('make me a google ads campaign', {}),
  g('i want more bookings for my salon, website is glowstudio.ie, dublin only', { url: 'glowstudio.ie', service: 'salon', locations: ['dublin'], goal: 'bookings' }),
  g('Run google ads for my dog grooming business in Exeter', { service: 'dog grooming', locations: ['Exeter'] }),
  g('advertise riverside-movers.co.uk around Dundee and Perth, 15 quid a day', { url: 'riverside-movers.co.uk', locations: ['Dundee', 'Perth'], budget: { amount: '15', currency: '£', period: 'day' } }),
  g('Hi, please create an ad campaign for lockfast.uk. We want calls from people in Chester.', { url: 'lockfast.uk', locations: ['Chester'], goal: 'calls' }),
  g('new campaign for brightsmiles.com.au - Brisbane - 50 dollars daily', { url: 'brightsmiles.com.au', locations: ['Brisbane'], budget: { amount: '50', currency: '$', period: 'day' } }),
  g('Create ads for my wedding photography business. Website: annaclarkephoto.com', { service: 'wedding photography', url: 'annaclarkephoto.com' }),
  g('google ads for tyrerescue.co.uk please, all of Scotland, budget 600 a month', { url: 'tyrerescue.co.uk', locations: ['Scotland'], budget: { amount: '600', currency: null, period: 'month' } }),
  g('I need google ads for my plumbing business', { service: 'plumbing' }),
  g('Set up a campaign for greenleafgardens.net in Surrey and Kent to get quote requests', { url: 'greenleafgardens.net', locations: ['Surrey', 'Kent'], goal: 'leads' }),
  g('start advertising pizzaroma.co.uk on google, Bath only, £10 per day, we want table reservations', { url: 'pizzaroma.co.uk', locations: ['Bath'], budget: { amount: '10', currency: '£', period: 'day' }, goal: 'bookings' }),
  g('make a campaign for https://fixmyphone.shop/repairs in Birmingham', { url: 'https://fixmyphone.shop/repairs', locations: ['Birmingham'] }),
  g('Create a google ads campaign for my yoga classes in Brighton, €20 a day', { service: 'yoga classes', locations: ['Brighton'], budget: { amount: '20', currency: '€', period: 'day' } }),
  g('ads for mymotors.ca, Toronto, 200 dollars per week, want calls', { url: 'mymotors.ca', locations: ['Toronto'], budget: { amount: '200', currency: '$', period: 'week' }, goal: 'calls' }),
  g('Please set up Google Ads for www.homecareplus.org.uk covering Norwich, Ipswich and Colchester', { url: 'www.homecareplus.org.uk', locations: ['Norwich', 'Ipswich', 'Colchester'] }),
  { message: 'what is the weather in Glasgow today?', output: { ...EMPTY } },
  { message: 'how much does google ads cost per click?', output: { ...EMPTY } },
  { message: 'write an email to my customer about the late delivery', output: { ...EMPTY } },
  { message: 'show me how my campaigns did last week', output: { ...EMPTY } },
  { message: 'find me a good plumber in Leeds', output: { ...EMPTY } },
  { message: 'is dukestreettyres.co.uk loading?', output: { ...EMPTY } },
];
export const goldGoalExamples = (): GoalExample[] => GOLD_GOALS.map(item => ({
  id: goalId(item.message), capability: GOAL_CAPABILITY, split: 'gold', vertical: 'goal', source: 'handwritten', input: { message: item.message }, output: item.output,
}));

export const renderGoalPrompt = (example: Pick<GoalExample, 'input'>) => `Ads task:\n${canonicalJson({ capability: GOAL_CAPABILITY, input: example.input })}\nOutput:\n`;
export const renderGoalTarget = (example: Pick<GoalExample, 'output'>) => canonicalJson(example.output);
