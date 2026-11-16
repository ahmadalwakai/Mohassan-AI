/**
 * The checker gate: a model answer is shown only when it passes every check here; otherwise
 * the honest result is "no answer". The gate is stricter than the training checker:
 *  - Google limits, policy and claim checks (checkOutput, no vertical assumed);
 *  - every keyword must name the brief's city;
 *  - LEAKED_FACT: a known business fact that the brief did not state;
 *  - UNGROUNDED_WORD: a word that is not in the brief, not in shared ad wording, and not
 *    in the wording of the business type the brief's service belongs to.
 * The held-out vertical is never used to build the allowed wording.
 */
import type { GoogleAdsIssue } from '@mohassan/contracts';
import { checkOutput, generate, type Capability } from './lib.js';
import { HELD_OUT_VERTICAL, VERTICALS, type Vertical } from './verticals.js';

const KNOWN = VERTICALS.filter(vertical => vertical.id !== HELD_OUT_VERTICAL);
const words = (text: string) => text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
const inputWords = (input: Record<string, unknown>) => new Set(words(JSON.stringify(input)));

/** Words the reference outputs use without taking them from the brief, grouped by business type. */
function learnWording(): { shared: Set<string>; byVertical: Map<string, Set<string>> } {
  const seen = new Map<string, Set<string>>();
  const { examples } = generate({ seed: 4242, briefs: { train: 600, validation: 1, test: 1, test_unseen_vertical: 1 } });
  for (const example of examples.filter(item => item.split === 'train')) {
    const given = inputWords(example.input);
    for (const word of words(JSON.stringify(example.output))) if (!given.has(word)) (seen.get(word) ?? seen.set(word, new Set()).get(word)!).add(example.vertical);
  }
  const shared = new Set<string>(), byVertical = new Map<string, Set<string>>();
  for (const [word, verticals] of seen) {
    if (verticals.size >= 2) shared.add(word);
    else for (const id of verticals) (byVertical.get(id) ?? byVertical.set(id, new Set()).get(id)!).add(word);
  }
  return { shared, byVertical };
}
const WORDING = learnWording();
const FACTS = new Map<string, Set<string>>();
for (const vertical of VERTICALS) for (const fact of vertical.facts) {
  const key = fact.headline.toLowerCase();
  (FACTS.get(key) ?? FACTS.set(key, new Set()).get(key)!).add(fact.sentence.toLowerCase());
}
// Function words carry no claim; content words must still be grounded.
const COMMON = new Set(['the', 'and', 'for', 'with', 'our', 'you', 'your', 'from', 'are', 'all', 'any', 'has', 'have', 'can', 'will', 'get', 'its', 'into', 'per', 'that', 'this', 'who', 'what', 'when', 'where', 'how', 'not', 'but', 'than', 'then', 'out', 'off', 'over', 'under', 'one', 'two', 'just', 'more', 'most']);

/** The known business type whose service the brief names, if any. Unknown types get no extra wording. */
export function knownVertical(input: Record<string, unknown>): Vertical | undefined {
  const service = String(input.service ?? '').toLowerCase();
  return KNOWN.find(vertical => vertical.services.some(item => item.name.toLowerCase() === service));
}

export function gateIssues(capability: Capability, input: Record<string, unknown>, output: Record<string, unknown>): GoogleAdsIssue[] {
  const issues = checkOutput(capability, input, output).filter(issue => issue.severity === 'error');
  if (issues.some(issue => issue.code === 'BAD_SHAPE')) return issues;
  const fail = (code: string, field: string, message: string) => issues.push({ code, severity: 'error', field, message });
  const values = Object.values(output).flat().map(String);
  const text = values.join('\n').toLowerCase();
  const city = String(input.city ?? '').toLowerCase();
  if (capability === 'ads.keywords.v1' && city) values.forEach((value, index) => { if (!value.toLowerCase().includes(city)) fail('KEYWORD_NO_LOCATION', `keyword ${index + 1}`, `Keyword does not name ${input.city}: ${value}`); });
  if (capability === 'ads.headlines.v1' || capability === 'ads.descriptions.v1') {
    const stated = (Array.isArray(input.facts) ? input.facts as string[] : []).join('\n').toLowerCase();
    // A description is a sentence: at least four words, unless it repeats a stated fact word for word.
    if (capability === 'ads.descriptions.v1') values.forEach((value, index) => {
      if (value.trim().split(/\s+/).length < 4 && !stated.split('\n').includes(value.trim().toLowerCase())) fail('FRAGMENT', `description ${index + 1}`, `Not a full sentence: ${value}`);
    });
    // "... from <Name>." names the business word for word. A cut name ("Heather Man" for Heather Man
    // Partners), a recased one, or another name ("H Table Online") is refused; prices and routes
    // ("from GBP55 with ...", "from Duke Street to the West End") are not names and pass.
    const business = String(input.business ?? '').trim();
    if (business) values.forEach((value, index) => {
      // A name is a run of capitalised words that ends the clause; its first word has no digits, so a
      // price ("from GBP55.") is not a name, but later words may ("Falcon 24 Co"). A recased copy also counts.
      const named = [...value.matchAll(/\bfrom ([A-Z][A-Za-z'&-]*(?: [A-Z0-9][\w'&-]*)*)(?=[.,!?;]|$)/g)].map(match => match[1])
        .concat([...value.matchAll(/\bfrom ([^.,!?;]+)/g)].map(match => match[1].trim()).filter(text => text.toLowerCase() === business.toLowerCase()));
      for (const name of named) if (name !== business) fail('BUSINESS_NAME', `${capability === 'ads.descriptions.v1' ? 'description' : 'headline'} ${index + 1}`, `Business must be "${business}", not "${name}"`);
    });
    // Several business types share a fact name with different wording; any stated wording counts.
    for (const [headline, sentences] of FACTS) {
      const used = text.includes(headline) || [...sentences].some(sentence => text.includes(sentence.replace(/\.$/, '')));
      if (used && !stated.includes(headline) && ![...sentences].some(sentence => stated.includes(sentence))) fail('LEAKED_FACT', capability, `Uses a fact the brief does not state: ${headline}`);
    }
  }
  // Negatives are unrelated search terms by design; the checker already stops them blocking keywords.
  if (capability === 'ads.negatives.v1') return issues;
  // A lone letter before a word with the same first letter ("L Lincoln") is a broken copy of that word.
  // Real lone letters ("Glasgow G postcodes") pass.
  const broken = [...text.matchAll(/(?:^|[\s\["])([b-hj-z])\s+\1[a-z]/g)].map(match => match[0].trim());
  if (broken.length) fail('STRAY_LETTER', capability, `Broken words: ${broken.join(', ')}`);
  const given = inputWords(input);
  const own = WORDING.byVertical.get(knownVertical(input)?.id ?? '') ?? new Set<string>();
  const stray = [...new Set(words(text))].filter(word => !given.has(word) && !COMMON.has(word) && !WORDING.shared.has(word) && !own.has(word));
  if (stray.length) fail('UNGROUNDED_WORD', capability, `Words not grounded in the brief: ${stray.slice(0, 6).join(', ')}`);
  return issues;
}

export type GateDecision = { accepted: true; candidate: number; output: Record<string, unknown> } | { accepted: false; reasons: Record<string, number> };

/** First candidate (greedy first) that parses and passes the gate, or a refusal with the reasons seen. */
export function gate(capability: Capability, input: Record<string, unknown>, candidates: readonly string[]): GateDecision {
  const reasons: Record<string, number> = {};
  for (const [index, text] of candidates.entries()) {
    let output: unknown;
    try { output = JSON.parse(text); } catch { reasons.UNPARSABLE = (reasons.UNPARSABLE ?? 0) + 1; continue; }
    if (!output || typeof output !== 'object' || Array.isArray(output)) { reasons.BAD_SHAPE = (reasons.BAD_SHAPE ?? 0) + 1; continue; }
    const issues = gateIssues(capability, input, output as Record<string, unknown>);
    if (!issues.length) return { accepted: true, candidate: index, output: output as Record<string, unknown> };
    for (const code of new Set(issues.map(issue => issue.code))) reasons[code] = (reasons[code] ?? 0) + 1;
  }
  return { accepted: false, reasons };
}
