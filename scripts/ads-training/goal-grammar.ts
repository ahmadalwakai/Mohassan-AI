/**
 * Goal grammar: wide, composed training sentences for ads.goal.v2 (owner, 2026-11-15).
 *
 * The first independent test (9/50 Arabic, 13/50 English) showed the model had learnt its few
 * training templates, not the task. Here a request is composed from independent parts: an
 * opening, details attached to it or written as their own clauses, in any order, with greetings,
 * filler remarks and the hard cases of docs/ADS-GOAL-LABELING-GUIDE.md (negation, correction,
 * undecided values, details stated as missing, requests that are not a new campaign).
 *
 * Labels come from construction. Every row must pass checkGoal and round-trip through the
 * pointer format, and each labelled value must occur exactly once, so the pointer names the
 * place the label means. One phrase in ten is kept out of training for validation.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson, inventedPlace, rng } from './lib.js';
import { budgetNumbers, checkGoal, normalizeBudgetNumber, type Budget, type Currency, type Goal } from './goal.js';
import { goalToPointer, goalWords, pointerToGoal, renderGoalPointerPrompt, GOAL_POINTER_CAPABILITY } from './pointer.js';
import { EN, EN_VOCAB, EN_NATURAL } from './goal-grammar-en.js';
import { AR, AR_VOCAB, AR_NATURAL } from './goal-grammar-ar.js';
import { EN_BOUNDARIES, AR_BOUNDARIES, EN_LONG_SERVICES, AR_LONG_SERVICES } from './goal-grammar-boundaries.js';
import type { CorpusServices } from './goal-grammar-corpus.js';

import { AR_EXTRA, AR_SERVICES_EXTRA, EN_EXTRA, EN_SERVICES_EXTRA, EN_TRADE_WORDS, GOAL_ABSENT, extendPacks } from './goal-grammar-extra.js';
extendPacks(EN, AR);
const NATURAL = { en: [...EN_NATURAL, ...EN_BOUNDARIES, ...EN_EXTRA], ar: [...AR_NATURAL, ...AR_BOUNDARIES, ...AR_EXTRA] };

export type Language = 'en' | 'ar';
export type GrammarSplit = 'train' | 'validation';
type GoalName = 'calls' | 'bookings' | 'leads';
type Period = Budget['period'];
type Random = ReturnType<typeof rng>;

export interface Pack {
  language: Language;
  openings: { plain: string[]; service: string[]; url: string[] };
  inline: { service: string[]; serviceShop?: string[]; url: string[]; loc: string[]; budget: string[]; goal: string[] };
  clause: { service: string[]; url: string[]; loc: string[]; locSingle: string[]; budget: string[]; goal: Record<GoalName, string[]> };
  goalNouns: Record<GoalName, string[]>;
  periods: Record<Period, string[]>; periodSlash: Record<Period, string>; periodAdj: Record<Period, string[]>;
  missing: Record<'budget' | 'loc' | 'url' | 'service' | 'goal' | 'many', string[]>;
  scenario: Record<'currencyMissing' | 'periodMissing' | 'budgetAmbiguous' | 'budgetCorrection' | 'urlAmbiguous' | 'urlChoice' | 'locNegated' | 'locCorrection' | 'goalNegated', string[]>;
  greetings: string[]; closers: string[]; fillers: string[]; separators: string[]; endings: string[]; listJoin: string[][]; other: string[];
}
export interface GrammarRow {
  id: string; capability: string; language: Language; family: string; split: GrammarSplit;
  source: 'synthetic'; trainingAllowed: true; input: { message: string }; output: Goal; prompt: string; target: string;
}

// ---------------------------------------------------------------- held-out phrases
const bucket = (text: string) => { let hash = 2166136261; for (const ch of text) { hash ^= ch.codePointAt(0)!; hash = Math.imul(hash, 16777619); } return (hash >>> 0) % 10; };
const POOLS = new Map<readonly string[], { train: string[]; held: string[] }>();
function pools(items: readonly string[]) {
  let entry = POOLS.get(items);
  // A short closed list (period words, currency words, goal nouns) must stay whole in training:
  // holding one out removes a real way of writing it ("في اليوم", "شهريا") from every training sentence.
  if (!entry) { entry = items.length < 30 ? { train: [...items], held: [] }
    : { train: items.filter(item => bucket(item) !== 0), held: items.filter(item => bucket(item) === 0) }; POOLS.set(items, entry); }
  return entry;
}
/** Training never sees a held phrase or name; validation uses them half the time. */
class Source {
  constructor(readonly random: Random, readonly split: GrammarSplit,
    readonly corpusServices?: CorpusServices, readonly corpusShare = 0.25) {}
  chance(probability: number) { return this.random.next() < probability; }
  pick(items: readonly string[]): string {
    const { train, held } = pools(items);
    if (this.split === 'validation' && held.length && this.random.next() < 0.5) return this.random.pick(held);
    return this.random.pick(train.length ? train : items);
  }
  fit(items: readonly string[], ok: (item: string) => boolean): string | null {
    for (let tries = 0; tries < 12; tries++) { const item = this.pick(items); if (ok(item)) return item; }
    return null;
  }
  /** Whole-sentence validation templates are always held out, not just half the time. */
  whole(items: readonly string[]): string {
    const { train, held } = pools(items);
    const candidates = this.split === 'validation' ? held : train;
    if (!candidates.length) throw new Error(`No ${this.split} whole-sentence templates`);
    return this.random.pick(candidates);
  }
}

// ---------------------------------------------------------------- values
let vocabulary: string[] | null = null;
const commonWords = () => vocabulary ??= (JSON.parse(readFileSync('artifacts/ads-training/service-vocab.json', 'utf8')) as { words: string[] }).words;
const SOUNDS = ['ba', 'ro', 'ti', 'ken', 'lum', 'zor', 'vex', 'mi', 'sha', 'dro', 'pla', 'quin', 'fer', 'nol', 'gra', 'tu', 'sel', 'wim', 'jo', 'har', 'be', 'cu', 'dal', 'eth', 'ima', 'os'];
const isLatin = (text: string) => /^[\x20-\x7e]+$/.test(text);
interface Service { text: string; activity: boolean }

function englishService(source: Source): Service {
  if (source.corpusServices?.en.length && source.chance(source.corpusShare)) {
    return { text: source.pick(source.corpusServices.en), activity: false };
  }
  const v = EN_VOCAB, roll = source.random.next();
  const pair = () => `${source.pick(v.OBJECTS)} ${source.pick(v.ACTIVITIES)}`;
  // A third of the services are products, lessons and trades (goal-grammar-extra.ts).
  if (source.chance(0.33)) return { text: source.chance(0.12) ? source.pick(EN_TRADE_WORDS) : source.pick(EN_SERVICES_EXTRA), activity: false };
  if (roll < 0.45) return { text: source.pick(v.WHOLE), activity: false };
  if (roll < 0.65) return { text: source.pick(EN_LONG_SERVICES), activity: true };
  if (roll < 0.82) return { text: pair(), activity: true };
  if (roll < 0.94) return { text: `${source.pick(v.MODIFIERS)} ${source.chance(0.6) ? pair() : source.pick(v.WHOLE)}`, activity: true };
  // Unfamiliar services use invented names; ordinary function words must never be
  // drawn from a general vocabulary and labelled as business activities.
  const invented = Array.from({ length: 2 + source.random.int(2) }, () => source.random.pick(SOUNDS)).join('');
  return { text: source.chance(0.6) ? `${invented} ${source.pick(v.ACTIVITIES)}` : invented, activity: false };
}
const arabicInvented = (source: Source) => { const s = AR_VOCAB.SYLLABLES; return source.random.pick(s.middle) + source.random.pick(s.middle) + source.random.pick(s.end); };
function arabicService(source: Source): Service {
  if (source.corpusServices?.ar.length && source.chance(source.corpusShare)) {
    return { text: source.pick(source.corpusServices.ar), activity: false };
  }
  const v = AR_VOCAB, roll = source.random.next();
  if (source.chance(0.33)) return { text: source.pick(AR_SERVICES_EXTRA), activity: false };
  if (roll < 0.38) return { text: source.pick(v.WHOLE), activity: false };
  if (roll < 0.62) return { text: source.pick(AR_LONG_SERVICES), activity: true };
  if (roll < 0.84) return { text: `${source.pick(v.ACTIVITIES)} ${source.pick(v.OBJECTS)}`, activity: true };
  if (roll < 0.93) return { text: `${source.random.pick(['محل', 'ورشة', 'متجر', 'مركز', 'معرض'])} ${source.pick(v.SHOP_ITEMS)}`, activity: false };
  if (roll < 0.97) return { text: `${source.pick(v.ACTIVITIES)} ال${arabicInvented(source)}`, activity: true };
  return englishService(source);
}

function placeList(source: Source, language: Language, count: number, avoid: string[] = []): string[] {
  const chosen: string[] = [];
  const one = () => {
    const roll = source.random.next();
    if (language === 'en' || roll > 0.9) {
      if (roll < 0.7 || roll > 0.9) return source.pick(EN_VOCAB.PLACES);
      if (roll < 0.82) return inventedPlace(source.random);
      return `${source.random.pick(['North', 'South', 'East', 'West', 'Central', 'Greater', 'Upper', 'Lower', 'New', 'Old'])} ${source.pick(EN_VOCAB.PLACES).split(' ').pop()}`;
    }
    if (roll < 0.74) return source.pick(AR_VOCAB.PLACES);
    return source.chance(0.5) ? `${source.random.pick(AR_VOCAB.SYLLABLES.start)} ${arabicInvented(source)}` : `ال${arabicInvented(source)}`;
  };
  for (let tries = 0; chosen.length < count && tries < 40; tries++) {
    const place = one(), all = [...chosen, ...avoid];
    if (!all.some(other => other.includes(place) || place.includes(other))) chosen.push(place);
  }
  return chosen;
}
function joinPlaces(source: Source, pack: Pack, items: string[]): string {
  if (items.length === 1) return items[0]!;
  let [between, last] = source.random.pick(pack.listJoin) as [string, string];
  if (pack.language === 'ar') {
    // An attached "و" needs an Arabic word after it; a Latin name gets a separate "و".
    const fix = (joiner: string, next: string) => !isLatin(next) ? joiner
      : joiner.endsWith('وب') ? joiner.slice(0, -2) + 'وفي '
      : joiner.endsWith('و') ? `${joiner} ` : joiner;
    return items.map((item, index) => index === 0 ? item : (index === items.length - 1 ? fix(last, item) : fix(between, item)) + item).join('');
  }
  return items.length === 2 ? `${items[0]}${last}${items[1]}` : `${items.slice(0, -1).join(between)}${last}${items.at(-1)}`;
}

const TLDS = { en: ['com', 'com', 'co.uk', 'co.uk', 'uk', 'net', 'org.uk', 'ie', 'com.au', 'ca', 'io', 'shop', 'org', 'co', 'nz', 'co.nz', 'us', 'ae', 'sa', 'scot', 'wales', 'london', 'biz', 'info'],
  ar: ['sa', 'sa', 'ae', 'ae', 'com', 'com', 'net', 'com.sa', 'eg', 'jo', 'qa', 'kw', 'om', 'bh', 'me', 'co', 'org', 'shop', 'com.eg', 'uk', 'store', 'online', 'ma', 'iq'] };
function website(source: Source, language: Language): string {
  const r = source.random, v = EN_VOCAB;
  const word = () => r.next() < 0.3 ? r.pick(commonWords()) : source.pick(v.DOMAIN_WORDS);
  let name = r.next() < 0.25 ? word() + word() : word() + source.pick(v.DOMAIN_TAILS);
  if (r.next() < 0.12) name += String(2 + r.int(98));
  if (r.next() < 0.08) name = `${name.slice(0, 4)}-${name.slice(4)}`;
  const scheme = r.pick(['', '', '', '', 'www.', 'https://', 'https://www.', 'http://']);
  const path = r.next() < 0.14 ? r.pick(['/services', '/book', '/contact', '/shop', '/home', '/offers', '/ar', '/en', '/booking', '/store/new']) : '';
  return scheme + name.toLowerCase().replace(/[^a-z0-9-]/g, '') + '.' + r.pick(TLDS[language]) + path;
}

function amountFor(source: Source, period: Period): string {
  const r = source.random, step = period === 'day' ? 5 : 50;
  let base = period === 'day' ? 5 + r.int(146) : period === 'week' ? 30 + r.int(870) : 100 + r.int(8900);
  if (r.next() < 0.5) base = Math.max(step, Math.round(base / step) * step);
  return r.next() < 0.1 ? `${base}.${r.pick(['50', '99', '25', '75', '5', '00'])}` : String(base);
}
function printNumber(source: Source, amount: string, language: Language): string {
  const r = source.random, [whole, fraction] = amount.split('.') as [string, string | undefined];
  let text = whole.length > 3 && r.next() < 0.6 ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
  if (fraction !== undefined) text += `.${fraction}`;
  const script = language === 'ar' ? r.next() : 0;
  if (script < 0.42) return text;
  const zero = script < 0.92 ? 0x660 : 0x6f0;
  text = text.replace(/\d/g, digit => String.fromCharCode(zero + Number(digit)));
  if (r.next() < 0.7) text = text.replace(',', '٬');
  return r.next() < 0.7 ? text.replace('.', '٫') : text;
}
const MONEY: Record<Language, Record<string, string[]>> = {
  en: { '£': ['£{a}', '£{a}', '£{a}', '{a} pounds', '{a} GBP', 'GBP {a}', '{a} quid'], '$': ['${a}', '${a}', '{a} dollars', '{a} USD', 'USD {a}', '{a} bucks'],
    '€': ['€{a}', '€{a}', '{a} euros', '{a} EUR', 'EUR {a}'], AED: ['AED {a}', '{a} AED'], SAR: ['SAR {a}', '{a} SAR'], EGP: ['EGP {a}', '{a} EGP'], none: ['{a}'] },
  ar: { SAR: ['{a} ريال سعودي', '{a} ريال سعودي', '{a} ريال سعودي', '{a} ر.س', '{a} SAR', 'SAR {a}'], AED: ['{a} درهم إماراتي', '{a} درهم إماراتي', '{a} درهم اماراتي', '{a} د.إ', '{a} AED'],
    EGP: ['{a} جنيه مصري', '{a} جنيه مصري', '{a} ج.م', '{a} EGP'], '£': ['{a} جنيه إسترليني', '{a} جنيه استرليني', '£{a}', '{a} باوند'],
    '$': ['{a} دولار', '{a} دولار', '{a} دولار أمريكي', '${a}', '{a} USD'], '€': ['{a} يورو', '{a} يورو', '€{a}', '{a} EUR'], none: ['{a}'],
    // A bare "ريال" does not say which country: the label keeps no currency.
    bare: ['{a} ريال', '{a} درهم', '{a} جنيه'] },
};
const CURRENCY_ODDS: Record<Language, [string, number][]> = {
  en: [['£', 35], ['$', 20], ['€', 15], ['AED', 6], ['SAR', 6], ['EGP', 3], ['none', 15]],
  ar: [['SAR', 22], ['AED', 18], ['EGP', 10], ['$', 14], ['€', 6], ['£', 8], ['none', 16], ['bare', 6]],
};
function weighted<T>(random: Random, odds: readonly (readonly [T, number])[]): T {
  let roll = random.next() * odds.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [value, weight] of odds) { roll -= weight; if (roll < 0) return value; }
  return odds.at(-1)![0];
}
interface Money { text: string; amount: string; currency: Currency | null; key: string }
function money(source: Source, language: Language, period: Period, key = weighted(source.random, CURRENCY_ODDS[language]), not?: string): Money | null {
  for (let tries = 0; tries < 10; tries++) {
    const amount = amountFor(source, period), printed = printNumber(source, amount, language);
    if (amount === not || normalizeBudgetNumber(printed) !== amount) continue;
    return { text: source.random.pick(MONEY[language][key]!).replace('{a}', printed), amount, currency: key === 'none' || key === 'bare' ? null : key as Currency, key };
  }
  return null;
}

// ---------------------------------------------------------------- sentences
interface Clause { text: string; lead: boolean; question: boolean; edge?: boolean }
const QUESTION = /^(?:can|could|would|will|is it|any chance|ممكن|هل|تقدر|بإمكانك)(?=\s|$)/u;
const clause = (template: string, text = template): Clause => ({ text, lead: template.startsWith('{'), question: QUESTION.test(template) });
const EMPTY: Goal = { intent: 'other', url: null, service: null, locations: [], budget: null, goal: null };
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function render(source: Source, pack: Pack, clauses: Clause[]): string {
  const r = source.random, ar = pack.language === 'ar';
  let message = '';
  clauses.forEach((item, index) => {
    if (index === 0) { message = ar || item.lead ? item.text : upper(item.text); return; }
    const previous = clauses[index - 1]!;
    let separator = source.pick(pack.separators);
    // An attached Arabic "و" joins a plain Arabic word only, never a value, a number or a link.
    if (ar && separator.endsWith('و') && (item.lead || !/^\p{Script=Arabic}/u.test(item.text))) separator = '، ';
    // A greeting or a thank-you is set off by a comma or a full stop, not by "and".
    if (previous.edge || item.edge) separator = r.pick(ar ? ['، ', '، ', '. ', ' '] : [', ', ', ', '. ', '! ', ' ']);
    if (previous.question && r.next() < 0.7) separator = ar ? '؟ ' : '? ';
    if (/[?؟!.]$/u.test(message)) separator = ' ';
    const sentence = /[.?؟!]\s$/u.test(message + separator);
    message += separator + (!ar && sentence && !item.lead ? upper(item.text) : item.text);
  });
  if (/[?؟!.]$/u.test(message)) return message;
  const last = clauses.at(-1)!;
  const endings = pack.endings.filter(ending => !/[?؟]/u.test(ending));
  return message + (last.question && r.next() < 0.8 ? (ar ? '؟' : '?') : r.pick(endings));
}

/** Arabic spelling without hamza marks or tanween, as many people type; labels change with the sentence. */
const plainArabic = (text: string) => text.replace(/[أإآ]/g, 'ا').replace(/ً/g, '');

type Scenario = keyof Pack['scenario'] | 'missing' | 'goalAbsent';
const SCENARIOS: [Scenario, number][] = [['missing', 3], ['currencyMissing', 1.5], ['periodMissing', 1.5], ['budgetAmbiguous', 1.5], ['budgetCorrection', 1.5],
  ['urlAmbiguous', 1.2], ['urlChoice', 0.8], ['locNegated', 1.5], ['locCorrection', 1.5], ['goalNegated', 1.5], ['goalAbsent', 1.5]];

function createExample(source: Source, pack: Pack): { message: string; output: Goal; family: string } | null {
  const r = source.random, language = pack.language, ar = language === 'ar';
  const has = { url: r.next() < 0.5, service: r.next() < 0.62, loc: r.next() < 0.66, budget: r.next() < 0.5, goal: r.next() < 0.4 };
  if (r.next() < 0.06) has.url = has.service = has.loc = has.budget = has.goal = false;
  const scenario = r.next() < 0.4 ? weighted(r, SCENARIOS) : null;
  if (scenario === 'currencyMissing' || scenario === 'budgetCorrection') has.budget = true;
  if (scenario === 'periodMissing' || scenario === 'budgetAmbiguous') has.budget = false;
  if (scenario === 'urlAmbiguous') has.url = false;
  if (scenario === 'urlChoice') has.url = true;
  if (scenario === 'locNegated' || scenario === 'locCorrection') has.loc = true;
  if (scenario === 'goalNegated') has.goal = true;
  if (scenario === 'goalAbsent') has.goal = false;

  const output: Goal = { ...EMPTY, intent: 'create_campaign', locations: [] };
  const service = has.service ? (ar ? arabicService(source) : englishService(source)) : null;
  const url = has.url ? website(source, language) : null;
  const count = scenario === 'locCorrection' ? 1 : r.next() < 0.72 ? 1 : r.next() < 0.65 ? 2 : 3;
  const locations = has.loc ? placeList(source, language, count) : [];
  const period = r.pick(['day', 'day', 'week', 'month'] as const);
  const cash = has.budget ? money(source, language, period, scenario === 'currencyMissing' ? 'none' : undefined) : null;
  const goal = has.goal ? r.pick(['calls', 'bookings', 'leads'] as const) : null;
  if ((has.budget && !cash) || (has.loc && !locations.length)) return null;
  output.url = url; output.service = service?.text ?? null; output.locations = locations; output.goal = goal;
  if (cash) output.budget = { amount: cash.amount, currency: cash.currency, period };

  const values: Record<string, string> = {};
  if (url) values.U = url;
  if (locations.length) values.L = joinPlaces(source, pack, locations);
  if (goal) values.G = source.pick(pack.goalNouns[goal]);
  if (cash) { values.M = cash.text; values.P = source.pick(pack.periods[period]); values.PA = source.pick(pack.periodAdj[period]); }
  const latinService = service ? isLatin(service.text) : false, latinPlace = locations.length ? isLatin(locations[0]!) : false;
  /** A template must not attach an Arabic letter to a Latin value. */
  const usable = (template: string) => !(latinService && /[لبو]\{S\}/u.test(template)) && !(latinPlace && /[لبو]\{L\}/u.test(template))
    && !(template.includes('لبيع {S}') && service?.text.startsWith('بيع '));
  const fill = (template: string): string => {
    let text = template;
    if (service && text.includes('{S}')) {
      // "بيع" names the activity in this noun phrase; unlike the verb "نبيع", it belongs to the service.
      if (ar && text.includes('لبيع {S}')) output.service = `بيع ${service.text}`;
      // "ل" + "ال..." is written "لل..."; the label is the exact rest of that word.
      if (/ل\{S\}/u.test(text) && service.text.startsWith('ال')) { output.service = service.text.slice(2); text = text.replace('ل{S}', `لل${output.service}`); }
      text = text.replace('{S}', service.text);
    }
    if (cash && text.includes('{M} {P}') && /\d$/.test(cash.text) && r.next() < 0.07) text = text.replace('{M} {P}', cash.text + pack.periodSlash[period]);
    return text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
  };

  const standalone: Clause[] = [];
  const placed = new Set<string>();
  let family = scenario ?? 'plain';
  const add = (list: readonly string[]) => { const template = source.fit(list, usable); if (!template) return false; standalone.push(clause(template, fill(template))); return true; };

  // The scenario writes its own clause for the field it changes.
  if (scenario === 'missing') {
    const absent = (['budget', 'loc', 'url', 'service', 'goal'] as const).filter(field => !has[field]);
    // Some combined phrases explicitly name service, URL or budget. They are safe only
    // when every optional field is absent; two unrelated absent fields are insufficient.
    if (absent.length === 5 && r.next() < 0.3) add(pack.missing.many);
    else if (absent.length) add(pack.missing[r.pick(absent)]);
    else family = 'plain';
  } else if (scenario === 'periodMissing' || scenario === 'budgetAmbiguous') {
    const second = money(source, language, period), first = second ? money(source, language, period, second.key, second.amount) : null;
    if (!second || !first) return null;
    values.M = second.text; values.M1 = first.text; values.P = source.pick(pack.periods[period]);
    if (!add(pack.scenario[scenario])) return null;
  } else if (scenario === 'budgetCorrection') {
    const first = money(source, language, period, cash!.key, cash!.amount);
    if (!first) return null;
    values.M1 = first.text; placed.add('budget');
    if (!add(pack.scenario.budgetCorrection)) return null;
  } else if (scenario === 'urlAmbiguous' || scenario === 'urlChoice') {
    values.U2 = website(source, language);
    if (scenario === 'urlAmbiguous') values.U = website(source, language);
    if (values.U === values.U2) return null;
    placed.add('url');
    if (!add(pack.scenario[scenario])) return null;
  } else if (scenario === 'locNegated' || scenario === 'locCorrection') {
    const other = placeList(source, language, 1, locations)[0];
    if (!other || isLatin(other) !== latinPlace) return null;
    values.L2 = other; placed.add('loc');
    if (!add(pack.scenario[scenario])) return null;
  } else if (scenario === 'goalNegated') {
    const other = r.pick((['calls', 'bookings', 'leads'] as const).filter(name => name !== goal));
    values.G = r.pick(pack.goalNouns[goal!].slice(0, 3)); values.G2 = r.pick(pack.goalNouns[other].slice(0, 3)); placed.add('goal');
    if (!add(pack.scenario.goalNegated)) return null;
  } else if (scenario === 'goalAbsent') {
    const excluded = r.pick(['calls', 'bookings', 'leads'] as const);
    values.G2 = source.pick(pack.goalNouns[excluded]); placed.add('goal');
    if (!add(GOAL_ABSENT[language])) return null;
  }

  // The opening may carry the service or the link itself.
  let opening: string | null;
  if (service && r.next() < 0.35) { opening = source.fit(pack.openings.service, usable); placed.add('service'); }
  else if (url && !placed.has('url') && r.next() < 0.35) { opening = source.pick(pack.openings.url); placed.add('url'); }
  else opening = source.pick(pack.openings.plain);
  if (!opening) return null;

  const attached: string[] = [];
  const present = { service: Boolean(service), url: Boolean(url), loc: locations.length > 0, budget: Boolean(cash), goal: Boolean(goal) };
  for (const field of ['service', 'url', 'loc', 'budget', 'goal'] as const) {
    if (!present[field] || placed.has(field)) continue;
    if (attached.length < 3 && r.next() < 0.5) {
      const list = field === 'service' && service!.activity && pack.inline.serviceShop && r.next() < 0.25 ? pack.inline.serviceShop : pack.inline[field];
      const template = source.fit(list, usable);
      if (template) { attached.push(template); continue; }
    }
    if (field === 'goal') standalone.push(clause(source.pick(pack.clause.goal[goal!])));
    else if (field === 'loc' && locations.length === 1 && r.next() < 0.15) { if (!add(pack.clause.locSingle)) return null; }
    else if (!add(pack.clause[field])) return null;
  }
  if (scenario === 'currencyMissing') add(pack.scenario.currencyMissing);
  if (r.next() < 0.3) attached.sort(() => r.next() - 0.5);
  const first = clause(opening, fill([opening, ...attached].join(' ')));
  first.question = QUESTION.test(opening);

  if (r.next() < 0.22) standalone.push(clause(source.pick(pack.fillers)));
  if (r.next() < 0.05) standalone.push(clause(source.pick(pack.fillers)));
  const body = r.sample(standalone, standalone.length);
  body.splice(r.next() < 0.62 ? 0 : r.int(body.length + 1), 0, first);
  if (r.next() < 0.2) body.unshift({ ...clause(source.pick(pack.greetings)), question: false, edge: true });
  if (r.next() < 0.13) body.push({ ...clause(source.pick(pack.closers)), edge: true });

  let message = render(source, pack, body);
  if (!ar) message = message.replace(/\b([Aa]) (?=[aeiouAEIOU])/g, '$1n ');
  const change = ar ? (r.next() < 0.1 ? plainArabic : null) : r.next() < 0.1 ? (text: string) => text.toLowerCase() : null;
  if (change) {
    message = change(message);
    output.url = output.url && change(output.url); output.service = output.service && change(output.service); output.locations = output.locations.map(change);
  }
  return { message, output, family };
}

function otherExample(source: Source, pack: Pack): { message: string; output: Goal; family: string } {
  const r = source.random, language = pack.language, ar = language === 'ar';
  const one = () => {
    const template = source.pick(pack.other);
    const service = ar ? arabicService(source) : englishService(source), period = r.pick(['day', 'week', 'month'] as const);
    const values: Record<string, string> = { S: service.text, L: joinPlaces(source, pack, placeList(source, language, r.next() < 0.85 ? 1 : 2)),
      U: website(source, language), M: money(source, language, period)?.text ?? '50' };
    // "ل" before a name: "لل..." for an Arabic name with the article, a space before a Latin one.
    const attached = template.replace('ل{S}', isLatin(service.text) ? 'ل {S}' : service.text.startsWith('ال') ? `لل${service.text.slice(2)}` : 'ل{S}');
    return clause(template, attached.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole));
  };
  const body = [one()];
  if (r.next() < 0.14) body.push(one());
  if (r.next() < 0.1) body.push(clause(source.pick(pack.fillers)));
  if (r.next() < 0.2) body.unshift({ ...clause(source.pick(pack.greetings)), question: false, edge: true });
  if (r.next() < 0.1) body.push({ ...clause(source.pick(pack.closers)), edge: true });
  let message = render(source, pack, body).replace(/([?؟!])[.?؟!]+$/u, '$1');
  if (!ar) message = message.replace(/\b([Aa]) (?=[aeiouAEIOU])/g, '$1n ');
  if (r.next() < 0.1) message = ar ? plainArabic(message) : message.toLowerCase();
  return { message, output: { ...EMPTY, locations: [] }, family: 'other' };
}

/** Natural sentence frames complement random clause assembly. Labels still come only from slots.
 * L2/G2/M1 denote excluded or superseded values; the selected values are L/G/M.
 * Every validation frame is held out as a whole, including its service/location context.
 */
function naturalExample(source: Source, pack: Pack): { message: string; output: Goal; family: string } | null {
  const ar = pack.language === 'ar', r = source.random;
  const templates = NATURAL[pack.language], template = source.whole(templates);
  const service = ar ? arabicService(source) : englishService(source);
  const count = template.includes('{L2}') ? 1 : source.chance(0.25) ? 2 : 1;
  const locations = template.includes('{L}') ? placeList(source, pack.language, count) : [];
  const excluded = template.includes('{L2}') ? placeList(source, pack.language, 1, locations)[0] : null;
  if (template.includes('{L}') && locations.length !== count || template.includes('{L2}') && !excluded) return null;
  if (ar && isLatin(service.text) && /[لبو]\{S\}/u.test(template)) return null;
  if (ar && template.includes('لبيع {S}') && service.text.startsWith('بيع ')) return null;
  // Guide, section 3: after "محل"/"متجر"/"مركز"/"ورشة" a one-word item stays with the shop word, so only a longer activity fits here.
  if (ar && /(?:محل|متجر|مركز|ورشة) \{S\}/u.test(template) && !service.text.includes(' ')) return null;
  if (ar && locations.some(isLatin) && /[لبو]\{L\}/u.test(template)) return null;
  const period = r.pick(['day', 'week', 'month'] as const);
  const cash = template.includes('{M}') ? money(source, pack.language, period) : null;
  const oldCash = template.includes('{M1}') && cash ? money(source, pack.language, period, cash.key, cash.amount) : null;
  if (template.includes('{M}') && !cash || template.includes('{M1}') && !oldCash) return null;
  const goal = template.includes('{G}') ? r.pick(['calls', 'bookings', 'leads'] as const) : null;
  const excludedGoal = template.includes('{G2}') ? r.pick((['calls', 'bookings', 'leads'] as const).filter(item => item !== goal)) : null;
  const url = template.includes('{U}') ? website(source, pack.language) : null;
  const output: Goal = { ...EMPTY, intent: 'create_campaign', service: template.includes('{S}') ? service.text : null,
    locations, url, goal, budget: cash && template.includes('{P}') ? { amount: cash.amount, currency: cash.currency, period } : null };
  if (ar && template.includes('لبيع {S}')) output.service = `بيع ${service.text}`;
  const values: Record<string, string> = { S: service.text, L: joinPlaces(source, pack, locations), L2: excluded ?? '', U: url ?? '',
    M: cash?.text ?? '', M1: oldCash?.text ?? '', P: source.pick(pack.periods[period]),
    G: goal ? source.pick(pack.goalNouns[goal]) : '', G2: excludedGoal ? source.pick(pack.goalNouns[excludedGoal]) : '' };
  let pattern = template;
  if (ar && /ل\{S\}/u.test(pattern) && service.text.startsWith('ال')) {
    output.service = service.text.slice(2);
    pattern = pattern.replace('ل{S}', `لل${output.service}`);
  }
  let message = pattern.replace(/\{(\w+)\}/g, (_, key: string) => values[key]!);
  if (!ar) message = message.replace(/\b([Aa]) (?=[aeiouAEIOU])/g, '$1n ');
  if (source.chance(0.15)) {
    const change = ar ? plainArabic : (text: string) => text.toLowerCase();
    message = change(message); output.service = output.service && change(output.service);
    output.locations = output.locations.map(change); output.url = output.url && change(output.url);
  }
  // Greetings and neutral remarks also surround sparse requests, teaching absence
  // from context instead of mistaking the nearest non-entity word for a slot.
  if (source.chance(0.2)) message = `${source.pick(pack.greetings)}${ar ? '، ' : ', '}${message}`;
  if (source.chance(0.2)) message += ` ${source.pick(pack.fillers)}.`;
  return { message, output, family: `natural-${templates.indexOf(template)}` };
}

// ---------------------------------------------------------------- checking
const firstNumber = (word: string) => { const amounts = budgetNumbers(word); return amounts.length === 1 ? amounts[0]! : null; };
const arabicWord = (word: string) => /^(?:\p{Script=Arabic}|\p{M})+$/u.test(word);
/** How many places in the sentence spell this value, as the pointer would match it. */
function occurrences(list: readonly string[], value: string): number {
  const size = value.split(/\s+/).length;
  let found = 0;
  for (let start = 0; start + size <= list.length; start++) {
    const rest = list.slice(start + 1, start + size);
    const offsets = arabicWord(list[start]!) ? [0, 1, 2, 3] : [0];
    if (offsets.some(offset => offset < list[start]!.length && [list[start]!.slice(offset), ...rest].join(' ') === value)) found++;
  }
  return found;
}
export function grammarIssues(message: string, output: Goal): string[] {
  const issues = checkGoal(message, output);
  if (issues.length) return issues;
  const target = goalToPointer(message, output), back = target ? pointerToGoal(message, target) : null;
  if (!target || !back) return ['NOT_REPRESENTABLE'];
  if (canonicalJson(back) !== canonicalJson(output)) return ['ROUND_TRIP'];
  const list = goalWords(message);
  const named = [output.url, output.service, ...output.locations].filter((value): value is string => value !== null);
  if (named.some(value => occurrences(list, value) !== 1)) return ['VALUE_NOT_UNIQUE'];
  if (output.budget && list.filter(word => firstNumber(word) === output.budget!.amount).length !== 1) return ['AMOUNT_NOT_UNIQUE'];
  return [];
}

export interface GrammarOptions {
  count: number; split: GrammarSplit; seed: number; language: Language; otherShare?: number; naturalShare?: number;
  corpusServices?: CorpusServices; corpusShare?: number;
}
export function makeGrammarGoals(options: GrammarOptions): { rows: GrammarRow[]; rejected: Record<string, number> } {
  if (options.corpusShare !== undefined && (!Number.isFinite(options.corpusShare) || options.corpusShare < 0 || options.corpusShare > 1)) {
    throw new Error('Corpus share must be between zero and one');
  }
  const source = new Source(rng(options.seed), options.split, options.corpusServices, options.corpusShare), pack = options.language === 'ar' ? AR : EN;
  const rows: GrammarRow[] = [], seen = new Set<string>(), rejected: Record<string, number> = {};
  const reject = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  for (let attempt = 0; rows.length < options.count; attempt++) {
    if (attempt > options.count * 30) throw new Error(`Could not create enough distinct goal examples: ${JSON.stringify(rejected)}`);
    const draft = source.chance(options.otherShare ?? 0.22) ? otherExample(source, pack)
      : source.chance(options.naturalShare ?? 0.70) ? naturalExample(source, pack) : createExample(source, pack);
    if (!draft) { reject('NO_DRAFT'); continue; }
    const issues = grammarIssues(draft.message, draft.output);
    if (issues.length) { for (const issue of issues) reject(issue); continue; }
    const id = createHash('sha256').update(draft.message).digest('hex').slice(0, 24);
    const identity = draft.message.toLowerCase().trim().replace(/\s+/g, ' ');
    if (seen.has(identity)) { reject('DUPLICATE'); continue; }
    seen.add(identity);
    rows.push({ id, capability: GOAL_POINTER_CAPABILITY, language: options.language, family: `${options.language}-${draft.family}`, split: options.split, source: 'synthetic', trainingAllowed: true,
      input: { message: draft.message }, output: draft.output, prompt: renderGoalPointerPrompt(draft.message), target: goalToPointer(draft.message, draft.output)! });
  }
  return { rows, rejected };
}
