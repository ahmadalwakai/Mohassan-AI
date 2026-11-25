// Common spellings need lexical overrides because short vowels and the hamza
// are written inconsistently in Franco-Arabic. Values enter the dialect pass.
const WORDS = new Map(Object.entries({
  eh: 'إيه', eih: 'إيه', eeh: 'إيه', shu: 'شو', shou: 'شو', sho: 'شو',
  esh: 'إيش', eish: 'إيش', aish: 'إيش', wash: 'واش', wach: 'واش', wesh: 'وش',
  shno: 'شنو', shnu: 'شنو', shino: 'شنو', chno: 'شنو', achno: 'أشنو',
  fein: 'فين', feen: 'فين', fen: 'فين', wen: 'وين', wein: 'وين', wayn: 'وين', wain: 'وين', win: 'وين',
  ezay: 'ازاي', izzay: 'ازاي', ezai: 'ازاي', ezzaay: 'ازاي', shlon: 'شلون', shloon: 'شلون',
  kifash: 'كيفاش', kifach: 'كيفاش', keef: 'كيف', keif: 'كيف', kayf: 'كيف',
  emta: 'إمتى', imta: 'إمتى', amta: 'إمتى', mata: 'متى', waqtash: 'وقتاش',
  meen: 'مين', min: 'مين', mnu: 'منو', meno: 'منو', mino: 'منو',
  shkun: 'شكون', shkon: 'شكون', shkoune: 'شكون', chkoun: 'شكون',
  kam: 'كم', kem: 'كم', bkam: 'بكم', adeish: 'قديش', addeish: 'قديش', '2adeish': 'قديش',
  qadeish: 'قديش', b2adesh: 'بقداش', b9adech: 'بقداش', bch7al: 'بشحال', ch7al: 'شحال',
  leh: 'ليه', leeh: 'ليه', leish: 'ليش', lesh: 'ليش', leesh: 'ليش',
  '3lash': 'علاش', '3lach': 'علاش', alash: 'علاش', hal: 'هل', limatha: 'لماذا',
  ana: 'أنا', e7na: 'إحنا', enta: 'أنت', enty: 'أنت',
  '3ayz': 'عايز', '3ayez': 'عايز', '3ayza': 'عايزة', ayz: 'عايز',
  abgha: 'أبغى', 'ab8a': 'أبغى', baddi: 'بدي', badi: 'بدي', bdi: 'بدي', bedi: 'بدي', biddi: 'بدي',
  '7ab': 'حاب', '7abb': 'حاب', '7aba': 'حابة', nbi: 'نبي', bghit: 'بغيت',
  'a3mel': 'اعمل', 'e3mel': 'اعمل', sawi: 'سوي', sawwi: 'سوي', dir: 'دير',
  shouf: 'شوف', shoof: 'شوف', shof: 'شوف', shoufli: 'شوفلي', shoofli: 'شوفلي', aktob: 'اكتب',
  mesh: 'مش', mish: 'مش', mosh: 'مش', mouch: 'مش', msh: 'مش', mo: 'مو',
  marhaba: 'مرحبا', mar7aba: 'مرحبا', mar7ba: 'مرحبا', ahlan: 'أهلا', ahleen: 'أهلين',
  salam: 'سلام', salaam: 'سلام', alsalam: 'السلام', alaykom: 'عليكم', '3alaykom': 'عليكم',
  halla: 'هلا', hala: 'هلا', law: 'لو', sama7t: 'سمحت', samaht: 'سمحت', afak: 'عفاك',
  minfadlak: 'من فضلك', '3afak': 'عفاك', takfa: 'تكفى',
  esm: 'اسم', isem: 'اسم', ism: 'اسم', esmo: 'اسمه',
  anwa3: 'أنواع', '2anwa3': 'أنواع', mokawwenat: 'مكونات', mokawenat: 'مكونات', fawa2ed: 'فوائد', asma2: 'أسماء', asma: 'أسماء', amthela: 'أمثلة',
  sa3a: 'ساعة', sa3at: 'ساعات', sa3er: 'سعر', se3r: 'سعر', se3ro: 'سعره', se3rha: 'سعرها',
  ma3na: 'معنى', ma3naha: 'معناها', ma3nah: 'معناه', '3adad': 'عدد',
  '3omr': 'عمر', '3omro': 'عمره', '3omrha': 'عمرها', '3omer': 'عمر',
  '2amar': 'قمر', qamar: 'قمر', '2ahwa': 'قهوة', '2ahera': 'القاهرة', el2ahera: 'القاهرة',
  '2olt': 'قلت', '2oul': 'قل', '2olli': 'قل لي', '2ooli': 'قل لي',
  '5obar': 'الخبر', '5obz': 'خبز', '5arita': 'خريطة', '5abar': 'خبر',
  '6aree2a': 'طريقة', '6ari2a': 'طريقة', '6aree2': 'طريق', '6alab': 'طلب', '6aba2': 'طبق',
  '7al': 'حال', '7alha': 'حالها', '7alak': 'حالك', '7alek': 'حالك',
  '8amar': 'قمر', '8atar': 'قطر', '8arya': 'قرية', '9a7': 'صح', '9ar': 'صار',
  '9a7ra': 'صحراء', '9oura': 'صورة', '9ora': 'صورة',
  'a3raf': 'أعرف', araf: 'أعرف', 't3raf': 'تعرف', 'sa3edni': 'ساعدني',
  'ab7ath': 'ابحث', eb7ath: 'ابحث', dour: 'دور', dawer: 'دور',
  ekteb: 'اكتب', oktob: 'اكتب', ektob: 'اكتب', targem: 'ترجم', tarjem: 'ترجم',
  la5es: 'لخص', lakhis: 'لخص', e7seb: 'احسب', e7sab: 'احسب',
  'efta7': 'افتح', 'eftah': 'افتح', efta7li: 'افتح لي',
  '5tara3': 'اخترع', '9awwar': 'صور', '3amal': 'عمل', ghanna: 'غنى',
  fel: 'في', beit: 'بيت', elbeit: 'البيت',
  katab: 'كتب', kitab: 'كتاب', ketab: 'كتاب', elkitab: 'الكتاب',
  bokra: 'بكرة', bukra: 'بكرة', elyom: 'اليوم', lyom: 'اليوم', embare7: 'امبارح',
  '3an': 'عن', fee: 'في', fi: 'في', '3ala': 'على', el: 'ال', al: 'ال',
}));

const LEADING = new Set('eih eeh shu shou esh eish aish wach wesh shno shnu shino chno achno fein feen wen wein wayn wain ezay izzay ezai ezzaay shlon shloon kifash kifach keef keif kayf emta imta mata waqtash meen mnu meno mino shkun shkon shkoune chkoun bkam adeish addeish qadeish b2adesh b9adech bch7al ch7al leeh leish lesh leesh 3lash 3lach alash limatha 3ayz 3ayez 3ayza abgha ab8a baddi bdi bedi biddi bghit a3mel e3mel shouf shoof shoufli marhaba mar7aba mar7ba ahleen ab7ath eb7ath e7seb e7sab efta7 efta7li'.split(' '));
const FRANCO = /^(?=.*[a-z])(?=.*[2356789])(?:[a-z]|[2356789]['’]?)+$/iu;
const ENGLISH_WORD = /^(?:i|you|he|she|we|they|it|is|are|do|did|does|the|an|and|or|with|what|when|who|where|why|how|which|can|will|could|should|for|need|want|please|search|remember|file|http|code|model|python|npm|api|use|install|open|write|docs|email|check|group)$/iu;
const CODE_OR_ORDINAL = /^(?:2fa|3d|3rd|[2356789]th|[2356789](?:kb|mb|gb|tb|am|pm)|h[2356789]|[a-z]+[2356789]{2,})$/iu;

function isFranco(word: string): boolean {
  return word === word.toLowerCase() && FRANCO.test(word) && !CODE_OR_ORDINAL.test(word);
}

/** Positive evidence is required so that ordinary English and identifiers such as 2FA survive. */
export function isArabiziText(words: readonly string[]): boolean {
  const romanized = words.filter(word => /[a-z]/iu.test(word));
  const first = romanized[0]?.toLowerCase();
  if (!first || ENGLISH_WORD.test(first)) return false;
  if (/^[A-Z][a-z]+$/u.test(romanized[0]) && /^[A-Z][a-z]+$/u.test(romanized[1] ?? '')) return false;
  const hits = romanized.filter(word => WORDS.has(word.toLowerCase())).length;
  const digits = romanized.filter(isFranco).length;
  if (romanized.length === 1) return /^(?:marhaba|ahlan|shlon|ezay)$/u.test(first) || WORDS.has(first) && digits > 0
    || LEADING.has(first) && romanized[0] === first && words.some(word => /\p{Script=Arabic}/u.test(word));
  return (LEADING.has(first) && !ENGLISH_WORD.test(romanized[1]))
    || WORDS.has(first) && (hits >= 2 || digits > 0)
    || isFranco(first) && digits >= 2;
}

const LETTERS: Readonly<Record<string, string>> = {
  "3'": 'غ', "6'": 'ظ', "7'": 'خ', "8'": 'غ', "9'": 'ض',
  '2': 'ء', '3': 'ع', '5': 'خ', '6': 'ط', '7': 'ح', '8': 'ق', '9': 'ص',
  sh: 'ش', ch: 'ش', kh: 'خ', gh: 'غ', th: 'ث', dh: 'ذ',
  aa: 'ا', ee: 'ي', ii: 'ي', oo: 'و', ou: 'و', uu: 'و', ay: 'اي', aw: 'او',
  b: 'ب', c: 'ك', d: 'د', f: 'ف', g: 'ج', h: 'ه', j: 'ج', k: 'ك', l: 'ل', m: 'م', n: 'ن',
  p: 'ب', q: 'ق', r: 'ر', s: 'س', t: 'ت', v: 'ف', w: 'و', x: 'كس', y: 'ي', z: 'ز',
};
const ROMAN_SOUNDS = /[36789]'|sh|ch|kh|gh|th|dh|aa|ee|ii|oo|ou|uu|ay|aw|[a-z2356789]/gu;

export function transliterateArabizi(word: string, mixedScript: boolean): string {
  const lower = word.toLowerCase();
  const known = WORDS.get(lower);
  if (known && (word === lower || /^[A-Z][a-z2356789]+$/u.test(word))) return known;
  if (ENGLISH_WORD.test(word) || CODE_OR_ORDINAL.test(word) || word !== lower || (mixedScript ? !isFranco(word) : !/^(?:[a-z]|[2356789]['’]?)+$/u.test(word))) return word;
  // Generic transcription writes long vowels and word-edge short vowels.
  const unquoted = word.replace(/’/gu, "'");
  const spelled = unquoted.replace(ROMAN_SOUNDS, (sound: string, offset: number) => {
    if (offset === 0 && sound === '2') return 'أ';
    if (sound in LETTERS) return LETTERS[sound];
    if (offset === 0) return sound === 'i' || sound === 'e' ? 'إ' : 'ا';
    if (offset === unquoted.length - 1) return ({ a: 'ا', e: 'ه', i: 'ي', o: 'و', u: 'و' } as const)[sound as 'a' | 'e' | 'i' | 'o' | 'u'];
    return '';
  });
  return spelled.length >= 2 ? spelled : word;
}
