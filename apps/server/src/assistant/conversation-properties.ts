// Property forms from conversation-state.ts at 29448ae, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/conversation-state.ts#L109-L162
export type PropertyName = 'population' | 'capital' | 'area' | 'currency' | 'language' | 'leader' | 'price'
  | 'weather' | 'age' | 'height' | 'match' | 'founded' | 'inventor' | 'duration';

/** 'country' marks properties of a state (currency, language, leader, capital): «its currency» after a capital question means the country, not the city. */
type OperandKind = 'place' | 'country' | 'person' | 'thing';

export interface PropertyForms {
  name: PropertyName;
  ar: string[];
  /** Irregular pronoun forms; the regular ones (سعره, سعرها, سعرهم, عاصمتها…) are generated from `ar`. */
  arPronoun: string[];
  en: string[];
  enPronoun: RegExp;
  phraseAr: string;
  phraseEn: string;
  /** What the property is asked about; «its X» after an entity-valued property refers to the answer only when X applies to it. */
  appliesTo: OperandKind[];
  /** The answer is itself an entity of this kind (a city, a person), so «its X» after it may mean that answer. */
  answerKind?: 'place' | 'person';
  /** The place IS the entity («الطقس في لندن» asks about لندن). */
  locationValued?: boolean;
}

// Forms are folded (see fold): ة→ه, أ/إ/آ→ا, ى→ي, no diacritics.
export const PROPERTIES: readonly PropertyForms[] = [
  { name: 'population', ar: ['عدد سكان', 'عدد السكان', 'تعداد سكان', 'سكان'], arPronoun: [],
    en: ['population of', 'population'], enPronoun: /\b(?:its|their) population\b|\bhow many people live (?:there|in it)\b/u,
    phraseAr: 'عدد سكان', phraseEn: 'population of', appliesTo: ['place'] },
  { name: 'capital', ar: ['عاصمه'], arPronoun: [], en: ['capital of', 'capital'], enPronoun: /\b(?:its|their) capital\b/u,
    phraseAr: 'عاصمة', phraseEn: 'capital of', appliesTo: ['country'], answerKind: 'place' },
  // A bare English «area» is a region in Ads sentences («area: Cardiff», real rq061), so only «area of» and the pronoun forms count.
  { name: 'area', ar: ['مساحه'], arPronoun: [], en: ['area of'], enPronoun: /\b(?:its|their) area\b|\bhow big is (?:it|that)\b/u,
    phraseAr: 'مساحة', phraseEn: 'area of', appliesTo: ['place'] },
  { name: 'currency', ar: ['عمله'], arPronoun: [], en: ['currency of', 'currency'], enPronoun: /\b(?:its|their) currency\b/u,
    phraseAr: 'عملة', phraseEn: 'currency of', appliesTo: ['country'] },
  { name: 'language', ar: ['لغه'], arPronoun: [], en: ['language of', 'language'], enPronoun: /\b(?:its|their) (?:official )?language\b/u,
    phraseAr: 'لغة', phraseEn: 'language of', appliesTo: ['country'] },
  { name: 'leader', ar: ['رئيس', 'حاكم', 'ملك'], arPronoun: [], en: ['president of', 'leader of', 'king of', 'president', 'leader'],
    enPronoun: /\b(?:its|their) (?:president|leader|king)\b|\bwho (?:leads|rules) (?:it|them)\b/u, phraseAr: 'رئيس', phraseEn: 'leader of',
    appliesTo: ['country'], answerKind: 'person' },
  { name: 'price', ar: ['سعر', 'ثمن'], arPronoun: [], en: ['price of', 'price', 'cost of'],
    enPronoun: /\b(?:its|their) (?:price|cost)\b|\bhow much is (?:it|that)\b/u, phraseAr: 'سعر', phraseEn: 'price of', appliesTo: ['thing'] },
  { name: 'weather', ar: ['طقس', 'درجه الحراره', 'حراره'], arPronoun: [], en: ['weather in', 'weather', 'temperature in'],
    enPronoun: /\bthe weather there\b/u, phraseAr: 'طقس', phraseEn: 'weather in', appliesTo: ['place'], locationValued: true },
  { name: 'age', ar: ['عمر'], arPronoun: [], en: ['age of'], enPronoun: /\bhow old is (?:he|she|it)\b|\b(?:his|her|its) age\b/u,
    phraseAr: 'عمر', phraseEn: 'age of', appliesTo: ['person', 'thing'] },
  { name: 'height', ar: ['ارتفاع', 'طول'], arPronoun: [], en: ['height of'],
    enPronoun: /\bhow tall is (?:it|he|she)\b|\b(?:its|his|her) height\b/u, phraseAr: 'ارتفاع', phraseEn: 'height of', appliesTo: ['person', 'place', 'thing'] },
  { name: 'match', ar: ['مباراه', 'ماتش'], arPronoun: [], en: ['next match of', 'match of', 'match', 'game'],
    enPronoun: /\b(?:its|their) (?:next )?(?:match|game)\b/u, phraseAr: 'مباراة', phraseEn: 'next match of', appliesTo: ['thing'] },
  { name: 'founded', ar: ['تاريخ تاسيس', 'تاسيس'], arPronoun: [], en: ['founding date of', 'founded'],
    enPronoun: /\bwhen was (?:it|she|he) founded\b/u, phraseAr: 'تاريخ تأسيس', phraseEn: 'founding date of', appliesTo: ['place', 'thing'] },
  // «من اخترع الهاتف؟» (real rq006): the verb is the property word and what follows it is the entity.
  { name: 'inventor', ar: ['مخترع', 'اخترع', 'مؤسس', 'اسس'], arPronoun: [], en: ['inventor of', 'invented', 'founder of', 'who founded'],
    enPronoun: /\bwho (?:invented|founded|created|made) (?:it|that|them)\b|\b(?:its|their) (?:inventor|founder)\b/u,
    phraseAr: 'مخترع', phraseEn: 'inventor of', appliesTo: ['thing'] },
  // «كم تستغرق عملية المياه البيضاء؟» (real rq018).
  { name: 'duration', ar: ['مده', 'تستغرق', 'يستغرق', 'كم تاخذ', 'كم ياخذ'], arPronoun: [], en: ['duration of', 'how long does', 'how long is', 'how long will'],
    enPronoun: /\bhow long (?:does|will|did) (?:it|that) take\b|\b(?:its|their) duration\b/u, phraseAr: 'مدة', phraseEn: 'duration of', appliesTo: ['thing'] },
];

/** Read the explicit property at the start of a folded topic. */
export function topicPropertyPhrase(topic: string): string | undefined {
  const startsWith = (form: string) => topic === form || topic.startsWith(`${form} `);
  if (/^\p{Script=Arabic}/u.test(topic)) {
    return PROPERTIES.find(forms => forms.ar.some(form => startsWith(form) || startsWith(`ال${form}`)))?.phraseAr;
  }
  return PROPERTIES.find(forms => forms.en.some(startsWith))?.phraseEn;
}
