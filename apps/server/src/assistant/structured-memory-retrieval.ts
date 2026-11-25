import { requestTerms } from '../../../../packages/skills/src/stems.js';
import { matchText } from './mind/normalize.js';
import type { StructuredMemoryTarget } from './structured-memory-lexicon.js';

// Field vocabulary and common noun equivalents are used only to read a fact.
// The exact structured key still controls all updates and deletions.
const fields: Readonly<Record<string, string>> = {
  name: 'name named naming اسم اسماء تسميه مسمي',
  number: 'number identifier رقم نمره معرف',
  date: 'date day weekday schedule deadline موعد تاريخ يوم مواعيد',
  time: 'time hour وقت ساعه توقيت',
  address: 'address عنوان',
  location: 'location place موقع مكان مقر',
  language: 'language tongue لغه لغات لسان',
  preference: 'prefer preferred preference favorite favourite مفضل تفضيل مفضله',
  channel: 'channel method medium قناه طريقه وسيله',
  phone: 'phone telephone mobile هاتف جوال موبايل تلفون',
  email: 'email e-mail ايميل بريد',
  color: 'color colour لون الوان',
  status: 'status state حاله',
  size: 'size حجم مقاس',
  age: 'age عمر',
};
const nouns: Readonly<Record<string, string>> = {
  notebook: 'notebook notepad دفتر كراسه',
  workshop: 'workshop ورشه',
  company: 'company business firm شركه مؤسسه',
  project: 'project مشروع',
  cat: 'cat kitten قط قطه',
  dog: 'dog puppy كلب كلبه',
  contact: 'contact communication تواصل اتصال',
  seat: 'seat seating مقعد جلوس',
};
const queryScaffolding = new Set(matchText(`remember remembered recall recalled save saved store stored record recorded keep kept
  said say told ask asked have has had memory memories note notes recall request only specify
  اني ليه عليه انهو انهي شنو شكد كنت قلت قلتلك تقول طلب طلبت طلبتلك ذكرني استرجع اتذكر تذكر افتكر
  محفوظ محفوظه حافظ حافظه مخزون مسجل ذاكرتي ذاكرتك ذاكره مالتي مالك`).split(/\s+/u));
const memoryVerb = /^(?:(?:حفظ|حافظ|محفوظ|سجل|خزن|ذكر|قلت)(?:ت|تلك|تها|تهاش|تهم|ته|ها|ه|هاش|هم|نا|ي|ين|تي|تلي)?|ذاكرت(?:ي|ك|كم|نا))$/u;
const retrievalFrame = /(?<!\p{L})(?:(?:keep|kept) in mind|on (?:the )?record|by heart)(?!\p{L})/gu;
const requestedModifier = /(?<!\p{L})(?:other|another|former|earlier|previous|old|original|first|second|third|different|except|not|never|rather than|الاخر|غير|بدل|السابق|القديم|الاول|الثاني|الثالث)(?!\p{L})/u;

function wordForms(text: string) {
  const normalized = matchText(text).replace(/['’]s(?=\W|$)/gu, '')
    .replace(/(?<!\p{L})(?:ا|ن)فضل(?:ها|ه|هم)?(?!\p{L})/gu, 'تفضيل');
  return requestTerms(normalized, normalized.length).map(({ word, variants }) => {
    const feminine = word.replace(/ت(?:ي|نا|ك|كم|ها|ه|هم)?$/u, 'ه');
    const extras = feminine !== word ? requestTerms(feminine).flatMap(term => term.variants) : [];
    return { word, forms: [...new Set([word, ...variants, ...extras])] };
  });
}

const concepts = new Map<string, string>();
for (const [name, terms] of Object.entries({ ...fields, ...nouns })) {
  // Use exact catalogue spellings first so a light stem cannot overwrite a
  // different catalogue word with the same stem.
  for (const { word } of wordForms(terms)) concepts.set(word, name);
}
for (const [name, terms] of Object.entries({ ...fields, ...nouns })) {
  for (const { forms } of wordForms(terms)) for (const form of forms) if (!concepts.has(form)) concepts.set(form, name);
}

function conceptsOf(text: string, query = false) {
  const terms = wordForms(query ? text.replace(retrievalFrame, ' ') : text).flatMap(({ word, forms }) => {
    if (query && (queryScaffolding.has(word) || memoryVerb.test(word))) return [];
    const concept = forms.map(form => concepts.get(form)).find(value => value !== undefined);
    return [concept ? [concept] : forms];
  });
  return terms.filter((entry, index) => !terms.slice(0, index).some(previous => previous[0] === entry[0]));
}

function keyTerms(target: StructuredMemoryTarget, includePreference: boolean) {
  const subject = target.subject === 'user' ? '' : target.subject?.replace(/^entity:/u, '') ?? '';
  const property = target.property === 'language' && includePreference ? 'language preference' : target.property.replace(/^descriptor:/u, '');
  return conceptsOf(`${subject} ${property}`);
}

const labels: ReadonlySet<string> = new Set(Object.keys(fields));
const intersects = (a: string[], b: string[]) => a.some(value => b.includes(value));

/** Compare only the fact's key to the question, never its payload or recency. */
export function structuredMemoryMatcher(query: string): (target: StructuredMemoryTarget) => number {
  if (requestedModifier.test(matchText(query))) return () => 0;
  const asked = conceptsOf(query, true);
  const includePreference = asked.some(term => term[0] === 'preference');
  return target => {
    const stored = keyTerms(target, includePreference);
    // A channel can be implicit in an asserted communication preference, but
    // a request about any other additional field still needs its own evidence.
    const requested = includePreference && asked.some(term => term[0] === 'contact') && stored.some(term => term[0] === 'contact')
      ? asked.filter(term => term[0] !== 'channel' || stored.some(key => key[0] === 'channel')) : asked;
    const covered = requested.filter(term => stored.some(key => intersects(term, key)));
    const storedCoverage = stored.filter(term => requested.some(key => intersects(term, key))).length;
    const selfField = target.subject === 'user' && !target.property.startsWith('descriptor:')
      && covered.length > 0 && covered.length === requested.length && storedCoverage === stored.length;
    if (selfField) return covered.length + 1;
    if (!covered.some(term => !labels.has(term[0]!)) || requested.some(term => labels.has(term[0]!) && !covered.includes(term))) return 0;
    // Two independent cues can identify a field when a speaker omits its long
    // qualifier. Allow a single extra modifier only when the entire key is clear.
    if (covered.length >= 2 && (covered.length === requested.length
      || covered.length === requested.length - 1 && storedCoverage === stored.length)) return covered.length + storedCoverage / stored.length;
    return 0;
  };
}
