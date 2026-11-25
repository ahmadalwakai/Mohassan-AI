import type { DevelopmentCase } from './reasoning-development.js';

const category = 'number-words';

// Development only. Euclidean place values and fixed lexical forms produce
// the exact expectations. No model or API calls and no training use.
const digitWords = [
  ['zero', 'صفر'], ['one', 'واحد'], ['two', 'اثنان'], ['three', 'ثلاثة'], ['four', 'أربعة'],
  ['five', 'خمسة'], ['six', 'ستة'], ['seven', 'سبعة'], ['eight', 'ثمانية'], ['nine', 'تسعة'],
] as const;

const digitCases = digitWords.flatMap<DevelopmentCase>(([en, ar], n) => [
  { id: `words-en-digit-${n}`, category, request: `Spell ${n} in words.`, expected: en },
  { id: `words-ar-digit-${n}`, category, request: `شو ${ar} بالأرقام؟`, expected: String(n) },
]);

const teens = [
  ['ten', 'عشرة'], ['eleven', 'أحد عشر'], ['twelve', 'اثنا عشر'], ['thirteen', 'ثلاثة عشر'], ['fourteen', 'أربعة عشر'],
  ['fifteen', 'خمسة عشر'], ['sixteen', 'ستة عشر'], ['seventeen', 'سبعة عشر'], ['eighteen', 'ثمانية عشر'], ['nineteen', 'تسعة عشر'],
] as const;

const teenCases = teens.flatMap<DevelopmentCase>(([en, ar], i) => [
  { id: `words-en-teen-${i}`, category, request: `What is ${en} in digits?`, expected: String(10 + i) },
  { id: `words-ar-teen-${i}`, category, request: `اكتب ${10 + i} بالحروف.`, expected: ar },
]);

const scales = [
  ['thousand', 'ألف', 'ألفان', 'آلاف'],
  ['million', 'مليون', 'مليونان', 'ملايين'],
  ['billion', 'مليار', 'ملياران', 'مليارات'],
  ['trillion', 'تريليون', 'تريليونان', 'تريليونات'],
] as const;

const scaleCases = scales.flatMap<DevelopmentCase>(([en, ar, dual, plural], i) => {
  const scale = 1000 ** (1 + i);
  return [
    { id: `words-en-scale-write-${i}`, category, request: `Write ${scale.toLocaleString('en-US')} in words.`, expected: `one ${en}` },
    { id: `words-en-scale-read-${i}`, category, request: `Convert six ${en} and eight to digits.`, expected: String(6 * scale + 8) },
    { id: `words-ar-scale-one-${i}`, category, request: `كيف تكتب ${scale} بالكلمات؟`, expected: ar },
    { id: `words-ar-scale-dual-${i}`, category, request: `كيف تكتب ${2 * scale} بالحروف؟`, expected: dual },
    { id: `words-ar-scale-plural-${i}`, category, request: `حوّل خمسة ${plural} وثمانية إلى أرقام.`, expected: String(5 * scale + 8) },
    { id: `words-en-fraction-${i}`, category, request: `What is two and a half ${en} in figures?`, expected: String(5 * scale / 2) },
    { id: `words-ar-fraction-${i}`, category, request: `وش ${dual} ونص بالأرقام؟`, expected: String(5 * scale / 2) },
  ];
});

const edgeCases = [
  ['en-bare-fraction', 'two and a half million', '2500000'],
  ['en-british-and', 'Write one hundred and twenty-one in digits', '121'],
  ['en-compound', 'Convert five billion three million seven thousand two to digits', '5003007002'],
  ['en-quarter', 'What is a quarter of a million in digits?', '250000'],
  ['en-fraction-after-scale', 'Read two million and a half in figures', '2500000'],
  ['en-tens', 'Write 52 in words', 'fifty-two'],
  ['en-hundreds', 'Read 402 in words', 'four hundred two'],
  ['en-minus', 'Spell −103.05', 'minus one hundred three point zero five'],
  ['en-precision', 'Write 0.000000000000001 in words', 'zero point zero zero zero zero zero zero zero zero zero zero zero zero zero zero one'],
  ['en-leading-zero', 'In words: 0003.50', 'three point five zero'],
  ['en-signed-fraction', 'Convert minus six and a quarter to digits', '-6.25'],
  ['en-read-decimal', 'In digits: negative ninety-nine point zero eight zero', '-99.080'],
  ['en-to-ar', 'Can you write the number 250 in Arabic words?', 'مائتان وخمسون'],
  ['en-ar-input', 'Write «ألفان وخمسة» in digits', '2005'],
  ['en-courtesy', 'Please write 97 in words, thank you!', 'ninety-seven'],
  ['ar-bare', 'ثلاثة آلاف وخمسمائة', '3500'],
  ['ar-thousands', 'اكتب ٣٬٥٠٠ بالحروف', 'ثلاثة آلاف وخمسمائة'],
  ['ar-hundred-construct', 'اقرأ ۲۰۰۰۰۰ بالكلمات', 'مائتا ألف'],
  ['ar-hundred-construct-inverse', 'حوّل مائتا ألف للأرقام', '200000'],
  ['ar-eastern-digits', 'اقرأ العدد ۲۹', 'تسعة وعشرون'],
  ['ar-decimal', 'اكتب −٢٫٥٠ بالأحرف', 'سالب اثنان فاصلة خمسة صفر'],
  ['ar-decimal-inverse', 'حوّل سالب خمسة فاصلة صفر ثمانية إلى أرقام', '-5.08'],
  ['ar-msn-vowels', 'بالأرقام: «ثَلَاثَةُ آلَافٍ وَخَمْسُمِائَةٍ»', '3500'],
  ['ar-gulf', 'شلون تكتب ألفين وثلاثطعش بالأرقام؟', '2013'],
  ['ar-egyptian-hundreds', 'ازاي اكتبلي تلتمية واتنين بالأرقام؟', '302'],
  ['ar-egyptian-half', 'ازاي تكتب اتنين ونص مليون بالأرقام؟', '2500000'],
  ['ar-levantine', 'شو ميتين وتنتين وعشرين بالأرقام؟', '222'],
  ['ar-quarter', 'قول ربع مليار رقما', '250000000'],
  ['ar-english-output', 'اكتب ١٢٣ بالحروف بالإنجليزية', 'one hundred twenty-three'],
  ['ar-courtesy', 'مِن فضلك، اقرأ العدد ٢١', 'واحد وعشرون'],
] as const;

export const numberWordCases: readonly DevelopmentCase[] = [
  ...digitCases, ...teenCases, ...scaleCases,
  ...edgeCases.map<DevelopmentCase>(([name, request, expected]) => ({ id: `words-${name}`, category, request, expected })),
];
