/**
 * Ads training data for Mohassan's own model. Each task is a closed piece of a Search campaign
 * whose answer is a fixed function of the brief, so the model can learn it exactly:
 *   ads.keywords.v1      brief -> keywords with match types
 *   ads.negatives.v1     brief + keywords -> negative keywords that never block a keyword
 *   ads.headlines.v1     brief + owner facts -> up to 15 headlines (30 characters each)
 *   ads.descriptions.v1  brief + owner facts -> 4 descriptions (90 characters each)
 * Every example must pass the same validator the app uses for real drafts
 * (packages/google-ads/src/quality.ts), with the owner's facts as the only evidence.
 * Budget, bidding, locations and operations stay in deterministic code (draft.ts).
 */
import { createHash } from 'node:crypto';
import { ADS_LIMITS, adsLength, negativeBlocks, parseKeyword, validateAdText } from '../../packages/google-ads/src/quality.js';
import type { GoogleAdsIssue } from '@mohassan/contracts';
import { CITIES, HELD_OUT_VERTICAL, VERTICALS, type Fact, type Service, type Vertical } from './verticals.js';

export const DATASET_VERSION = 'ads-synthetic-v2';
export type Capability = 'ads.keywords.v1' | 'ads.negatives.v1' | 'ads.headlines.v1' | 'ads.descriptions.v1';
export const CAPABILITIES: readonly Capability[] = ['ads.keywords.v1', 'ads.negatives.v1', 'ads.headlines.v1', 'ads.descriptions.v1'];
export type Split = 'train' | 'validation' | 'test' | 'test_unseen_vertical';

export interface Brief { business: string; service: string; city: string; goal: Vertical['goal']; language: 'en'; facts: string[] }
export interface AdsExample {
  id: string; capability: Capability; split: Split; vertical: string; source: 'synthetic' | 'gold';
  input: Record<string, unknown>; output: Record<string, string[]>;
}

/** Deterministic PRNG so the same seed always rebuilds the same dataset. */
export function rng(seed: number) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (max: number) => Math.floor(next() * max), pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!,
    sample: <T,>(items: readonly T[], count: number) => { const copy = [...items]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; } return copy.slice(0, count); } };
}

const fits = (text: string, limit: number) => adsLength(text) <= limit;
const unique = (items: string[]) => { const seen = new Set<string>(); return items.filter(item => { const key = item.toLocaleLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }); };
const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

export function keywordsFor(service: Service, city: string): string[] {
  return service.keywords.map((template, index) => {
    const text = template.replace('{city}', city.toLowerCase());
    return index < 2 ? `[${text}]` : `"${text}"`;
  });
}

export function negativesFor(vertical: Vertical, keywords: readonly string[]): string[] {
  const parsed = keywords.map(parseKeyword);
  return vertical.negatives.filter(negative => !parsed.some(keyword => negativeBlocks(parseKeyword(negative), keyword)));
}

export function headlinesFor(vertical: Vertical, service: Service, brief: Brief, facts: readonly Fact[]): string[] {
  const { city, business } = brief;
  const cta = vertical.ctas[vertical.services.indexOf(service) % vertical.ctas.length]!;
  const ordered = unique([
    `${service.name} ${city}`, `${service.short} In ${city}`, business,
    ...facts.map(fact => fact.headline), cta,
    `${city} ${service.short}`, `Local ${service.short}`, `Serving All Of ${city}`, `${service.name}`,
  ].filter(text => fits(text, ADS_LIMITS.headline)));
  return ordered.slice(0, ADS_LIMITS.maxHeadlines);
}

export function descriptionsFor(vertical: Vertical, service: Service, brief: Brief, facts: readonly Fact[]): string[] {
  const { city, business } = brief;
  const cta = vertical.ctas[vertical.services.indexOf(service) % vertical.ctas.length]!;
  const lines: string[] = [];
  const intro = `${service.name} across ${city} from ${business}.`;
  lines.push(fits(intro, ADS_LIMITS.description) ? intro : `${service.name} across ${city}.`);
  // Facts are packed in order, two per line when they fit.
  let current = '';
  for (const fact of facts) {
    const joined = current ? `${current} ${fact.sentence}` : fact.sentence;
    if (fits(joined, ADS_LIMITS.description)) { current = joined; continue; }
    if (current) lines.push(current);
    current = fact.sentence;
  }
  if (current) lines.push(current);
  const closing = `${sentenceCase(cta)} in ${city}.`;
  if (lines.length < ADS_LIMITS.maxDescriptions) lines.push(fits(closing, ADS_LIMITS.description) ? closing : `${sentenceCase(cta)}.`);
  if (lines.length < ADS_LIMITS.minDescriptions) lines.push(`Serving ${city} and nearby areas.`);
  return unique(lines).slice(0, ADS_LIMITS.maxDescriptions);
}

/**
 * Checks one task output the way an owner would: Google's limits, policy, claims only from the
 * owner's facts, and no fact of this business type that the brief did not give.
 */
export function checkOutput(capability: Capability, input: Record<string, unknown>, output: Record<string, unknown>, vertical?: Vertical): GoogleAdsIssue[] {
  const list = (key: string) => Array.isArray(output[key]) && (output[key] as unknown[]).every(item => typeof item === 'string') ? output[key] as string[] : null;
  const facts = Array.isArray(input.facts) ? input.facts as string[] : [];
  // The owner states the business, service and city as well as the facts.
  const evidence = [String(input.business ?? ''), String(input.service ?? ''), String(input.city ?? ''), ...facts].join('\n');
  const issues: GoogleAdsIssue[] = [];
  const fail = (code: string, field: string, message: string) => issues.push({ code, severity: 'error', field, message });
  const warn = (code: string, field: string, message: string) => issues.push({ code, severity: 'warning', field, message });
  const key = { 'ads.keywords.v1': 'keywords', 'ads.negatives.v1': 'negatives', 'ads.headlines.v1': 'headlines', 'ads.descriptions.v1': 'descriptions' }[capability];
  const values = list(key);
  if (!values) return [{ code: 'BAD_SHAPE', severity: 'error', field: key, message: `output.${key} must be a list of strings` }];
  if (!values.length) fail('EMPTY', key, `${key} is empty`);
  const text = { headlines: [] as string[], descriptions: [] as string[], paths: [] as string[], keywords: [] as string[], negativeKeywords: [] as string[] };
  if (capability === 'ads.keywords.v1') text.keywords = values;
  if (capability === 'ads.negatives.v1') { text.negativeKeywords = values; text.keywords = Array.isArray(input.keywords) ? input.keywords as string[] : []; }
  if (capability === 'ads.headlines.v1') { text.headlines = values; text.descriptions = ['Placeholder description.', 'Placeholder description two.']; }
  if (capability === 'ads.descriptions.v1') { text.descriptions = values; text.headlines = ['Placeholder', 'Placeholder two', 'Placeholder three']; }
  issues.push(...validateAdText(text, evidence, 'en').filter(issue => !/placeholder/i.test(issue.message)));
  if (capability === 'ads.keywords.v1') {
    const city = String(input.city ?? '').toLowerCase();
    values.forEach((raw, index) => { if (city && !parseKeyword(raw).text.includes(city)) warn('KEYWORD_NO_LOCATION', `keyword ${index + 1}`, `Keyword does not name ${city}: ${raw}`); });
  }
  if ((capability === 'ads.headlines.v1' || capability === 'ads.descriptions.v1') && vertical) {
    const given = new Set(facts.map(fact => fact.toLocaleLowerCase()));
    for (const fact of vertical.facts) {
      if (given.has(fact.sentence.toLocaleLowerCase())) continue;
      const leaked = values.find(value => value.toLocaleLowerCase().includes(fact.headline.toLocaleLowerCase()) || value.toLocaleLowerCase().includes(fact.sentence.toLocaleLowerCase()));
      if (leaked) fail('UNSTATED_FACT', key, `Uses a fact the owner did not give: ${JSON.stringify(leaked)}`);
    }
  }
  if (capability === 'ads.headlines.v1') {
    const city = String(input.city ?? '').toLocaleLowerCase(), business = String(input.business ?? '').toLocaleLowerCase();
    if (city && !values.some(value => value.toLocaleLowerCase().includes(city))) fail('NO_LOCATION', key, 'No headline names the city');
    if (business && fits(business, ADS_LIMITS.headline) && !values.some(value => value.toLocaleLowerCase() === business)) fail('NO_BUSINESS', key, 'No headline is the business name');
  }
  return issues;
}

const NAME_PARTS = {
  train: { first: ['Swift', 'Prime', 'Allied', 'Victory', 'Summit', 'Harbour', 'Crown', 'Thistle', 'Bridge', 'Oak', 'River', 'Castle', 'Union', 'Royal', 'Anchor'], last: ['Services', 'Group', 'Co', 'Experts', 'Pros', 'Team', 'Direct', 'Express'] },
  validation: { first: ['Meadow', 'Granite', 'Beacon'], last: ['Hub', 'Works'] },
  test: { first: ['Falcon', 'Heather', 'Lighthouse', 'Copper'], last: ['Partners', 'Specialists', 'Masters'] },
} as const;

// Made-up British-style place names for training only. With a few dozen real towns the model
// memorised them instead of learning to copy the brief's city; hundreds of invented ones force copying.
const PLACE_START = ['Ash', 'Brack', 'Thorn', 'Kel', 'Dun', 'Bal', 'Mor', 'Glen', 'Hal', 'Lang', 'Mill', 'Kirk', 'Hol', 'Pen', 'Tre', 'Lyn', 'Fen', 'Ald', 'Bur', 'Cal', 'Stan', 'Elm', 'Rad', 'Sel', 'Chal', 'Bram', 'Cul', 'Wex', 'Har', 'Nor', 'Sut', 'Wes', 'Bel', 'Cor', 'Dal', 'Fair', 'Gar', 'Hen', 'Lox', 'Ross'];
const PLACE_END = ['ford', 'bury', 'ton', 'ham', 'field', 'wick', 'by', 'more', 'burn', 'stead', 'well', 'den', 'ley', 'mouth', 'bridge', 'gate', 'thorpe', 'haven', 'side', 'holm', 'combe', 'hurst', 'shaw', 'worth'];
const HELD_OUT_PLACES = new Set<string>([...CITIES.validation, ...CITIES.test].map(city => city.toLowerCase()));

export function inventedPlace(random: ReturnType<typeof rng>): string {
  for (;;) {
    const name = random.pick(PLACE_START) + random.pick(PLACE_END);
    const place = random.next() < 0.12 ? `${random.pick(['Upper', 'Lower', 'North', 'South', 'East', 'West'])} ${name}` : name;
    if (!HELD_OUT_PLACES.has(place.toLowerCase()) && !HELD_OUT_PLACES.has(name.toLowerCase())) return place;
  }
}

const TRAIN_NAME_ENDS = ['Services', 'Group', 'Co', 'Experts', 'Pros', 'Team', 'Direct', 'Express', 'Solutions', 'Care', 'Local', 'Plus', 'Brothers', 'And Sons', 'UK', 'Point'];

function businessName(vertical: Vertical, service: Service, part: keyof typeof NAME_PARTS, random: ReturnType<typeof rng>): string {
  const short = service.short.split(' ')[0];
  if (part === 'train') {
    const roll = random.next();
    if (roll < 0.25) return random.pick(vertical.businessNames);
    if (roll < 0.6) return `${inventedPlace(random).split(' ').pop()} ${short} ${random.pick(TRAIN_NAME_ENDS)}`;
  }
  const parts = NAME_PARTS[part];
  return `${random.pick(parts.first)} ${short} ${random.pick(parts.last)}`;
}

export const exampleId = (capability: string, input: unknown) => createHash('sha256').update(JSON.stringify([capability, input])).digest('hex').slice(0, 16);

/** One brief produces one example per capability. */
export function examplesForBrief(vertical: Vertical, service: Service, brief: Brief, facts: readonly Fact[], split: Split, source: AdsExample['source'] = 'synthetic'): AdsExample[] {
  const base = { business: brief.business, service: brief.service, city: brief.city, goal: brief.goal, language: brief.language };
  const keywords = keywordsFor(service, brief.city);
  const make = (capability: Capability, input: Record<string, unknown>, output: Record<string, string[]>): AdsExample =>
    ({ id: exampleId(capability, input), capability, split, vertical: vertical.id, source, input, output });
  return [
    make('ads.keywords.v1', base, { keywords }),
    make('ads.negatives.v1', { ...base, keywords }, { negatives: negativesFor(vertical, keywords) }),
    make('ads.headlines.v1', { ...base, facts: brief.facts }, { headlines: headlinesFor(vertical, service, brief, facts) }),
    make('ads.descriptions.v1', { ...base, facts: brief.facts }, { descriptions: descriptionsFor(vertical, service, brief, facts) }),
  ];
}

export interface GenerateOptions { seed: number; briefs: Record<Split, number> }

export function generate(options: GenerateOptions) {
  const random = rng(options.seed);
  const examples: AdsExample[] = [];
  const rejected: { id: string; issues: GoogleAdsIssue[] }[] = [];
  const seen = new Set<string>();
  const plan: [Split, readonly string[], (vertical: Vertical) => boolean, keyof typeof NAME_PARTS][] = [
    ['train', CITIES.train, vertical => vertical.id !== HELD_OUT_VERTICAL, 'train'],
    ['validation', CITIES.validation, vertical => vertical.id !== HELD_OUT_VERTICAL, 'validation'],
    ['test', CITIES.test, vertical => vertical.id !== HELD_OUT_VERTICAL, 'test'],
    ['test_unseen_vertical', CITIES.test, vertical => vertical.id === HELD_OUT_VERTICAL, 'test'],
  ];
  for (const [split, cities, allowed, names] of plan) {
    const verticals = VERTICALS.filter(allowed);
    let made = 0, attempts = 0;
    while (made < options.briefs[split] && attempts++ < options.briefs[split] * 20) {
      const vertical = random.pick(verticals), service = random.pick(vertical.services);
      const city = split === 'train' && random.next() < 0.7 ? inventedPlace(random) : random.pick(cities);
      const facts = random.sample(vertical.facts, 1 + random.int(Math.min(6, vertical.facts.length)));
      // Two prices for one business would contradict each other.
      if (facts.filter(fact => fact.id.startsWith('price')).length > 1) continue;
      const brief: Brief = { business: businessName(vertical, service, names, random), service: service.name, city, goal: vertical.goal, language: 'en', facts: facts.map(fact => fact.sentence) };
      const batch = examplesForBrief(vertical, service, brief, facts, split);
      if (batch.some(example => seen.has(example.id))) continue;
      const bad = batch.map(example => ({ id: example.id, issues: checkOutput(example.capability, example.input, example.output, vertical) })).filter(item => item.issues.some(issue => issue.severity === 'error'));
      if (bad.length) { rejected.push(...bad); continue; }
      batch.forEach(example => seen.add(example.id));
      examples.push(...batch);
      made++;
    }
  }
  return { examples, rejected };
}

/** The model reads and writes compact JSON with sorted keys, the same canonical form as the execution worker. */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item as object).sort().map(key => [key, sort((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(sort(value));
}
export const renderPrompt = (example: Pick<AdsExample, 'capability' | 'input'>) => `Ads task:\n${canonicalJson({ capability: example.capability, input: example.input })}\nOutput:\n`;
export const renderTarget = (example: Pick<AdsExample, 'output'>) => canonicalJson(example.output);
