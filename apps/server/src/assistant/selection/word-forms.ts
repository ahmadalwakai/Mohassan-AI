import { arabicBase, arabicStem, foldText, requestTerms, STEM_STOP_WORDS } from '../../../../../packages/skills/src/stems.js';

export interface SelectionTerm {
  readonly word: string;
  readonly variants: readonly string[];
}

const ARABIC = /\p{Script=Arabic}/u;
const CLITIC = /^[وفبلك]/u;
const STACKED_CLITICS = /^[وف][بلك]/u;
const SHORT_ARTICLE = /^(?:ال|لل)(\p{L}{2})$/u;

// Only listed broken plurals and verb–verbal noun families share a key. Arabic roots are too broad for evidence matching.
// The spellings with seated hamza cover possessives after the suffix has been removed.
const FAMILIES: readonly (readonly [string, ...string[]])[] = [
  ['ابن', 'أبناء', 'أبنائ', 'أبناؤ'],
  ['أب', 'آباء', 'آبائ', 'آباؤ'],
  ['أخ', 'إخوة', 'إخوان'],
  ['جبل', 'جبال'],
  ['جندي', 'جنود'],
  ['حرب', 'حروب'],
  ['دولة', 'دول'],
  ['رجل', 'رجال'],
  ['زلزال', 'زلازل'],
  ['سبب', 'أسباب'],
  ['سنة', 'سنون', 'سنين'],
  ['شخص', 'أشخاص'],
  ['شعب', 'شعوب'],
  ['طائر', 'طيور'],
  ['طفل', 'أطفال'],
  ['طريق', 'طرق'],
  ['عضو', 'أعضاء', 'أعضائ', 'أعضاؤ'],
  ['عالم', 'علماء', 'علمائ', 'علماؤ'],
  ['عامل', 'عمال'],
  ['فريق', 'فرق'],
  ['قرية', 'قرى'],
  ['كتاب', 'كتب'],
  ['كوكب', 'كواكب'],
  ['مدينة', 'مدن', 'مدائن'],
  ['مدرسة', 'مدارس'],
  ['مشروع', 'مشاريع'],
  ['مطر', 'أمطار'],
  ['منطقة', 'مناطق'],
  ['نهر', 'أنهار'],
  ['امرأة', 'نساء', 'نسوة'],
  ['يوم', 'أيام'],
  ['أزرق', 'زرقاء', 'زرقة', 'ازرقاق'],
  ['اختراع', 'اخترع', 'اخترعت', 'اخترعوا', 'يخترع', 'تخترع'],
  ['استقلال', 'استقل', 'استقلت', 'استقلوا', 'يستقل', 'تستقل', 'نستقل', 'أستقل'],
  ['اكتشاف', 'اكتشف', 'اكتشفت', 'اكتشفوا', 'يكتشف', 'تكتشف'],
  ['انتقال', 'انتقل', 'انتقلت', 'انتقلوا', 'ينتقل', 'تنتقل'],
  ['انقراض', 'انقرض', 'انقرضت', 'انقرضوا', 'ينقرض', 'تنقرض'],
  ['انهيار', 'انهار', 'انهارت', 'انهاروا', 'ينهار', 'تنهار'],
  ['انتهاء', 'نهاية', 'انتهى', 'انتهت', 'ينتهي', 'تنتهي'],
  ['اندلاع', 'اندلع', 'اندلعت', 'يندلع', 'تندلع'],
  ['تأسيس', 'أسس', 'أسست', 'أسسوا', 'يؤسس', 'تؤسس'],
  ['تطوير', 'طور', 'طورت', 'طوروا', 'يطور', 'تطور'],
  ['تسمية', 'سمى', 'سميت', 'سموا', 'يسمى', 'تسمى'],
  ['تغير', 'تغيرت', 'يتغير', 'تتغير'],
  ['تكوين', 'تكوّن', 'تكوّنت', 'يتكوّن', 'تتكوّن'],
  ['توحيد', 'وحد', 'وحدت', 'توحد', 'توحدت', 'يتوحد', 'تتوحد'],
  ['سقوط', 'سقط', 'سقطت', 'سقطوا', 'يسقط', 'تسقط'],
  ['فوز', 'فاز', 'فازت', 'فازوا', 'يفوز', 'تفوز'],
  ['فتح', 'فتحت', 'فتحوا', 'يفتح', 'تفتح'],
  ['ولادة', 'ميلاد', 'ولد', 'ولدت', 'يولد', 'تولد'],
  ['وفاة', 'توفي', 'توفيت', 'توفوا', 'يتوفى', 'تتوفى'],
  ['هجرة', 'هاجر', 'هاجرت', 'هاجروا', 'يهاجر', 'تهاجر'],
];

const familyKeys = new Map<string, string>();
for (const family of FAMILIES) {
  const key = `family:${foldText(family[0])}`;
  for (const form of family) familyKeys.set(foldText(form), key);
}

function arabicForms(word: string): string[] {
  const forms = [word];
  if (CLITIC.test(word)) forms.push(word.slice(1));
  if (STACKED_CLITICS.test(word)) forms.push(word.slice(2));
  const bases = forms.map(form => {
    const shortNoun = SHORT_ARTICLE.exec(form)?.[1];
    return shortNoun && familyKeys.has(shortNoun) ? shortNoun : arabicBase(form);
  });
  return [...new Set([...forms, ...bases])];
}

function arabicFamily(form: string): string | undefined {
  const direct = familyKeys.get(form);
  if (direct) return direct;
  // Some indefinite nouns retain an accusative alif after folding. The future prefix applies only to listed verb forms.
  if (form.endsWith('ا')) return familyKeys.get(form.slice(0, -1));
  if (/^س[ايتن]/u.test(form)) return familyKeys.get(form.slice(1));
  return undefined;
}

/** The shared skill stems, augmented symmetrically for a question and its candidate sentence. */
export function selectionTerms(text: string): SelectionTerm[] {
  const terms: SelectionTerm[] = [];
  for (const term of requestTerms(text, text.length)) {
    const variants = new Set([term.word, ...term.variants]);
    if (ARABIC.test(term.word)) {
      const forms = arabicForms(term.word);
      const stackedStopWord = STACKED_CLITICS.test(term.word) && STEM_STOP_WORDS.has(term.word.slice(2)) && term.word.slice(2) !== 'اي';
      if (stackedStopWord) continue;
      for (const form of forms) {
        if (STEM_STOP_WORDS.has(form)) continue;
        for (const variant of [form, arabicStem(form)]) {
          if (variant.length >= 3 && !STEM_STOP_WORDS.has(variant)) variants.add(variant);
          const family = arabicFamily(variant);
          if (family) variants.add(family);
        }
      }
    }
    terms.push({ word: term.word, variants: [...variants] });
  }
  return terms;
}

/** Fraction of distinct query terms matched, allowing each distinct candidate term to count once. */
export function stemOverlap(queryTerms: readonly SelectionTerm[], candidateTerms: readonly SelectionTerm[]): number {
  if (!queryTerms.length || !candidateTerms.length) return 0;
  const candidatesByVariant = new Map<string, number[]>();
  candidateTerms.forEach((term, index) => {
    for (const variant of term.variants) {
      const matches = candidatesByVariant.get(variant);
      if (matches) matches.push(index);
      else candidatesByVariant.set(variant, [index]);
    }
  });

  const matches = queryTerms.map(term => new Set(term.variants.flatMap(variant => candidatesByVariant.get(variant) ?? [])));
  const owners = new Map<number, number>();
  function match(query: number, visited: Set<number>): boolean {
    for (const candidate of matches[query]!) {
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      const owner = owners.get(candidate);
      if (owner === undefined || match(owner, visited)) {
        owners.set(candidate, query);
        return true;
      }
    }
    return false;
  }

  for (let query = 0; query < matches.length; query++) match(query, new Set());
  return owners.size / queryTerms.length;
}
