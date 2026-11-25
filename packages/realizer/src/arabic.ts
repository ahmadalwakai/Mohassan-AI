import type { ArabicAgreement, ArabicForms, ArabicGender, ArabicNoun, GrammaticalNumber } from './frame.js';

type GrammaticalCase = 'nominative' | 'oblique' | 'accusative';
type Notation = 'digits' | 'words';

interface NounOptions {
  number?: GrammaticalNumber;
  definite?: boolean;
  construct?: boolean;
  case?: GrammaticalCase;
}

export function arabicNoun(noun: ArabicNoun, options: NounOptions = {}): string {
  const { number = 'singular', definite = false, construct = false } = options;
  const grammaticalCase = options.case ?? 'nominative';
  const nominative = grammaticalCase === 'nominative';
  if (number === 'dual') {
    const stem = noun.singular.replace(/ة$/u, 'ت');
    if (construct) {
      return nominative
        ? noun.dual?.constructNominative ?? `${stem}ا`
        : noun.dual?.constructOblique ?? `${stem}ي`;
    }
    const form = nominative ? noun.dual?.nominative ?? `${stem}ان` : noun.dual?.oblique ?? `${stem}ين`;
    if (!definite) return form;
    return (nominative ? noun.definiteDual?.nominative : noun.definiteDual?.oblique) ?? `ال${form}`;
  }
  if (number === 'plural') {
    if (noun.plural === undefined) throw new RangeError('Expected an Arabic plural noun form');
    const form = nominative ? noun.plural : noun.obliquePlural ?? noun.plural;
    if (construct) {
      const constructForm = nominative
        ? noun.constructPlural
        : noun.constructObliquePlural ?? (form === noun.plural ? noun.constructPlural : undefined);
      return constructForm ?? form;
    }
    if (!definite) return form;
    const definiteForm = form === noun.plural ? noun.definitePlural : undefined;
    return definiteForm ?? `ال${form}`;
  }
  if (construct) return noun.singular;
  if (definite) return noun.definiteSingular ?? `ال${noun.singular}`;
  return grammaticalCase === 'accusative' ? noun.accusativeSingular ?? noun.singular : noun.singular;
}

export function arabicAgreement(forms: ArabicForms, agreement: ArabicAgreement): string {
  if (agreement.number === 'plural' && agreement.rational === false) return forms.feminine.singular;
  return forms[agreement.gender][agreement.number];
}

const pronouns: ArabicForms = {
  masculine: { singular: 'هو', dual: 'هما', plural: 'هم' },
  feminine: { singular: 'هي', dual: 'هما', plural: 'هن' },
};

export function arabicPronoun(agreement: ArabicAgreement): string {
  return arabicAgreement(pronouns, agreement);
}

const units = {
  masculine: ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة'],
  feminine: ['', 'واحدة', 'اثنتان', 'ثلاث', 'أربع', 'خمس', 'ست', 'سبع', 'ثماني', 'تسع', 'عشر'],
} as const;

const tens = ['', '', 'عشر', 'ثلاث', 'أربع', 'خمس', 'ست', 'سبع', 'ثمان', 'تسع'];

function tensWord(amount: number, grammaticalCase: GrammaticalCase): string {
  return `${tens[Math.floor(amount / 10)]}${grammaticalCase === 'nominative' ? 'ون' : 'ين'}`;
}

function countUnderHundred(amount: number, gender: ArabicGender, grammaticalCase: GrammaticalCase): string {
  if (amount === 1 && gender === 'masculine' && grammaticalCase === 'accusative') return 'واحدًا';
  if (amount === 2 && grammaticalCase !== 'nominative') {
    return gender === 'masculine' ? 'اثنين' : 'اثنتين';
  }
  if (amount <= 10) return units[gender][amount];

  const ones = amount % 10;
  if (amount < 20) {
    const ten = gender === 'masculine' ? 'عشر' : 'عشرة';
    if (ones === 1) return gender === 'masculine' ? `أحد ${ten}` : `إحدى ${ten}`;
    if (ones === 2) {
      const two = gender === 'masculine'
        ? grammaticalCase === 'nominative' ? 'اثنا' : 'اثني'
        : grammaticalCase === 'nominative' ? 'اثنتا' : 'اثنتي';
      return `${two} ${ten}`;
    }
    return `${units[gender][ones]} ${ten}`;
  }

  const ten = tensWord(amount, grammaticalCase);
  if (ones === 0) return ten;
  let first = countUnderHundred(ones, gender, grammaticalCase);
  if (gender === 'feminine' && ones === 1) first = 'إحدى';
  if (gender === 'feminine' && ones === 8) first = grammaticalCase === 'accusative' ? 'ثمانيًا' : 'ثمانٍ';
  return `${first} و${ten}`;
}

function hundredWord(hundreds: number, grammaticalCase: GrammaticalCase, construct: boolean): string {
  if (hundreds === 1) return 'مئة';
  if (hundreds === 2) {
    if (construct) return grammaticalCase === 'nominative' ? 'مئتا' : 'مئتي';
    return grammaticalCase === 'nominative' ? 'مئتان' : 'مئتين';
  }
  return hundreds === 8 ? 'ثمانمئة' : `${units.feminine[hundreds]}مئة`;
}

const scales: ReadonlyArray<readonly [number, ArabicNoun]> = [
  [1_000_000_000_000, { gender: 'masculine', singular: 'تريليون', plural: 'تريليونات', accusativeSingular: 'تريليونًا' }],
  [1_000_000_000, { gender: 'masculine', singular: 'مليار', plural: 'مليارات', accusativeSingular: 'مليارًا' }],
  [1_000_000, { gender: 'masculine', singular: 'مليون', plural: 'ملايين', accusativeSingular: 'مليونًا' }],
  [1_000, { gender: 'masculine', singular: 'ألف', plural: 'آلاف', accusativeSingular: 'ألفًا' }],
];

function partitive(noun: ArabicNoun): string {
  return `من ${arabicNoun(noun, { number: 'plural', definite: true, case: 'oblique' })}`;
}

function countBlock(amount: number, noun: ArabicNoun, grammaticalCase: GrammaticalCase, construct: boolean): string {
  const remainder = amount % 100;
  if (amount >= 100) {
    const hundred = hundredWord(Math.floor(amount / 100), grammaticalCase, remainder === 0);
    if (remainder === 0) return `${hundred} ${arabicNoun(noun, { construct, case: 'oblique' })}`;
    if (remainder <= 2) return `${hundred} و${countUnderHundred(remainder, noun.gender, grammaticalCase)} ${partitive(noun)}`;
    return `${hundred} و${countBlock(remainder, noun, grammaticalCase, construct)}`;
  }
  if (amount === 1) {
    const form = arabicNoun(noun, { construct, case: grammaticalCase });
    return construct ? form : `${form} ${countUnderHundred(amount, noun.gender, grammaticalCase)}`;
  }
  if (amount === 2) return arabicNoun(noun, { number: 'dual', case: grammaticalCase, construct });
  const numeral = countUnderHundred(amount, noun.gender, grammaticalCase);
  const form = amount <= 10
    ? arabicNoun(noun, { number: 'plural', case: 'oblique', construct })
    : arabicNoun(noun, { case: 'accusative', construct });
  return `${numeral} ${form}`;
}

function scaledBlock(groups: number, scale: ArabicNoun, grammaticalCase: GrammaticalCase, construct: boolean): string {
  if (groups === 1) return scale.singular;
  const remainder = groups % 100;
  if (groups >= 100 && (remainder === 1 || remainder === 2)) {
    const hundreds = countBlock(groups - remainder, scale, grammaticalCase, false);
    return `${hundreds} و${scaledBlock(remainder, scale, grammaticalCase, construct)}`;
  }
  return countBlock(groups, scale, grammaticalCase, construct);
}

function countWords(amount: number, noun: ArabicNoun, grammaticalCase: GrammaticalCase): string {
  if (amount === 0) return `${grammaticalCase === 'accusative' ? 'صفرًا' : 'صفر'} ${partitive(noun)}`;

  const parts: string[] = [];
  let remainder = amount;
  for (const [magnitude, scale] of scales) {
    const groups = Math.floor(remainder / magnitude);
    if (groups === 0) continue;
    remainder %= magnitude;
    const group = scaledBlock(groups, scale, grammaticalCase, remainder === 0);
    if (remainder === 0) {
      parts.push(`${group} ${arabicNoun(noun, { case: 'oblique' })}`);
      return parts.join(' و');
    }
    parts.push(group);
  }
  if (parts.length > 0 && remainder <= 2) {
    parts.push(`${countUnderHundred(remainder, noun.gender, grammaticalCase)} ${partitive(noun)}`);
  } else {
    parts.push(countBlock(remainder, noun, grammaticalCase, false));
  }
  return parts.join(' و');
}

export function arabicCardinal(
  amount: number,
  noun: ArabicNoun,
  renderDigits: (value: number) => string,
  notation: Notation,
  grammaticalCase: GrammaticalCase = 'nominative',
): string {
  const absolute = Math.abs(amount);
  const remainder = absolute % 100;
  const safeInteger = Number.isSafeInteger(absolute);
  const spell = notation === 'words' && amount >= 0 && !Object.is(amount, -0) && safeInteger && amount < 1_000_000_000_000_000;
  const partitiveRemainder = absolute > 100 && (remainder === 1 || remainder === 2);
  const needsPlural = safeInteger && ((spell && absolute === 0) || partitiveRemainder || (remainder >= 3 && remainder <= 10));
  if (needsPlural && noun.plural === undefined) return `${renderDigits(amount)} (${noun.singular})`;
  if (spell) return countWords(amount, noun, grammaticalCase);

  const numeral = renderDigits(amount);
  // The digit-led notation retains the unit label for readings of zero, one, two and fractions.
  if (!safeInteger || absolute <= 2 || remainder === 0) return `${numeral} ${noun.singular}`;
  if (partitiveRemainder) return `${numeral} ${partitive(noun)}`;
  if (remainder <= 10) return `${numeral} ${arabicNoun(noun, { number: 'plural', case: 'oblique' })}`;
  return `${numeral} ${arabicNoun(noun, { case: 'accusative' })}`;
}

const ordinals = {
  masculine: ['', 'أول', 'ثاني', 'ثالث', 'رابع', 'خامس', 'سادس', 'سابع', 'ثامن', 'تاسع', 'عاشر'],
  feminine: ['', 'أولى', 'ثانية', 'ثالثة', 'رابعة', 'خامسة', 'سادسة', 'سابعة', 'ثامنة', 'تاسعة', 'عاشرة'],
} as const;

export function arabicOrdinal(
  rank: number,
  gender: ArabicGender,
  renderDigits: (value: number) => string,
  notation: Notation,
  grammaticalCase: GrammaticalCase = 'nominative',
): string {
  if (notation === 'digits' || !Number.isInteger(rank) || rank < 1 || rank > 99) return renderDigits(rank);
  if (rank <= 10) return `ال${ordinals[gender][rank]}`;
  const ones = rank % 10;
  const ordinal = ones === 1 ? gender === 'masculine' ? 'حادي' : 'حادية' : ordinals[gender][ones];
  if (rank < 20) return `ال${ordinal} ${gender === 'masculine' ? 'عشر' : 'عشرة'}`;
  const ten = `ال${tensWord(rank, grammaticalCase)}`;
  return ones === 0 ? ten : `ال${ordinal} و${ten}`;
}
