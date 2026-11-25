import { matchText } from './mind/normalize.js';

const properties = {
  name: ['name', 'names', 'called', 'اسم', 'اسماء', 'التسمية', 'مسمى'],
  phone: ['phone', 'phones', 'phone number', 'telephone', 'telephone number', 'mobile', 'mobile number', 'cell number', 'contact number', 'رقم', 'رقم الهاتف', 'رقم الجوال', 'رقم الموبايل', 'رقم التلفون', 'رقم التليفون', 'هاتف', 'جوال', 'موبايل', 'تلفون', 'تليفون'],
  address: ['address', 'addresses', 'home address', 'mailing address', 'residence', 'place of residence', 'home', 'عنوان', 'عنوان المنزل', 'عنوان السكن', 'عنوان البيت', 'مسكن', 'سكن', 'مكان السكن', 'محل الإقامة', 'مقر الإقامة'],
  birthday: ['birthday', 'birthdays', 'birth date', 'date of birth', 'عيد ميلاد', 'تاريخ الميلاد', 'تاريخ ميلاد', 'يوم ميلاد', 'ميلاد', 'مولد'],
  location: ['location', 'locations', 'based', 'site', 'headquarters', 'موقع', 'مكان', 'مقر'],
  email: ['email', 'e-mail', 'email address', 'البريد الإلكتروني', 'بريد إلكتروني', 'بريد', 'ايميل'],
  color: ['color', 'colors', 'colour', 'colours', 'لون', 'ألوان'],
  model: ['model', 'models', 'type', 'types', 'طراز', 'موديل', 'نوع'],
  status: ['status', 'state', 'حالة', 'وضع'],
  deadline: ['deadline', 'due date', 'delivery date', 'end date', 'موعد', 'موعد التسليم', 'تاريخ التسليم', 'موعد الانتهاء', 'تاريخ الانتهاء'],
  language: ['language', 'languages', 'preferred language', 'لغة', 'اللغة المفضلة'],
  number: ['number', 'numeral', 'رقم', 'عدد', 'نمرة'],
} as const;
type KnownProperty = keyof typeof properties;
export type StructuredMemoryProperty = KnownProperty | `descriptor:${string}`;

function matchingAliases<Key extends string>(items: Record<Key, readonly string[]>): Map<string, Key> {
  return new Map((Object.entries(items) as [Key, readonly string[]][]).flatMap(([key, values]) =>
    values.map(value => [matchText(value), key])));
}

const propertyAliases = matchingAliases(properties);
// Bare Arabic possession of a number has historically denoted a phone number.
propertyAliases.set('رقم', 'phone');
function propertyOf(text: string): KnownProperty | undefined {
  const nominal = text.replace(/^(?:the |ال)/u, '');
  return propertyAliases.get(text) ?? propertyAliases.get(nominal);
}

const subjects = {
  user: ['me', 'myself', 'أنا', 'نفسي'],
  company: ['company', 'business', 'firm', 'organization', 'organisation', 'employer', 'شركتي', 'شركتنا', 'مؤسستي', 'مؤسستنا'],
  wife: ['wife', 'زوجتي', 'مرتي'],
  husband: ['husband', 'زوجي', 'جوزي', 'رجلي'],
  mother: ['mother', 'mum', 'mom', 'أمي', 'والدتي', 'ماما'],
  father: ['father', 'dad', 'أبي', 'والدي', 'بابا', 'أبوي'],
  brother: ['brother', 'أخي', 'اخوي', 'شقيقي'],
  sister: ['sister', 'أختي', 'شقيقتي'],
  son: ['son', 'ابني', 'ولدي'],
  daughter: ['daughter', 'ابنتي', 'بنتي'],
  grandmother: ['grandmother', 'grandma', 'جدتي'],
  grandfather: ['grandfather', 'grandpa', 'جدي'],
  project: ['project', 'مشروعي', 'مشروعنا'],
  device: ['device', 'phone', 'computer', 'laptop', 'tablet', 'جهازي', 'حاسبي', 'كمبيوتري', 'لابتوبي', 'جوالي', 'هاتفي'],
  place: ['place', 'ملكي', 'مكاني'],
  home: ['home', 'house', 'apartment', 'بيتي', 'منزلي', 'شقتي'],
  office: ['office', 'مكتبي'],
} as const;
const subjectAliases = matchingAliases(subjects);

const namedSubjects = matchingAliases({
  company: ['company', 'business', 'firm', 'شركة', 'مؤسسة'],
  project: ['project', 'مشروع'],
  device: ['device', 'computer', 'phone', 'جهاز', 'حاسوب'],
  place: ['place', 'موقع', 'مكان'],
});
const directArabicSubjects = new Map([...subjectAliases].filter(([name]) => /\p{Script=Arabic}/u.test(name)));

export function subjectOf(text: string): string | undefined {
  const own = /^(?:my|our) (.+)$/u.exec(text);
  const alias = own ? subjectAliases.get(own[1]!) : subjectAliases.get(text) === 'user' ? 'user' : directArabicSubjects.get(text);
  if (alias) return alias;
  const named = /^(?:the |my |our )?(\S+) ([\p{L}\p{N}][\p{L}\p{M}\p{N}'-]*(?: [\p{L}\p{N}][\p{L}\p{M}\p{N}'-]*){0,3})$/u.exec(text);
  const category = named && namedSubjects.get(named[1]!);
  if (category && named[2]!.length <= 60) return `${category}:${named[2]!.normalize('NFC')}`;
  const englishPostnominal = /^(?:the |my |our )?([a-z0-9][a-z0-9'-]*(?: [a-z0-9][a-z0-9'-]*){0,3}) (company|project|device|place)$/u.exec(text);
  const name = englishPostnominal?.[1];
  return name && name.length <= 60 ? `${englishPostnominal[2]}:${name}` : undefined;
}

export interface StructuredMemoryTarget {
  /** A null subject requires a previously established, authorized conversation referent. */
  subject: string | null;
  property: StructuredMemoryProperty;
}

const NOMINAL = /^[\p{L}][\p{L}\p{M}\p{N}'-]*(?: [\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'-]*){0,7}$/u;
const CLAUSE_WORD = /(?:^| )(?:who|what|which|where|when|why|how|is|are|was|were|can|could|should|do|did|if|unless|and|or|please|then|اذا|لو|هل|او|ثم|هو|هي|الذي|التي|اللي)(?: |$)/u;
const ARABIC_OWNED = /^(.+?)(?: (?:عندي|مالتي|تبعتي|بتاعي|بتاعتي|حقي|حقتي|الخاص(?:ه)? بي))$/u;
const ARABIC_POSSESSED_NOUN = /^([\p{Script=Arabic}]{2,}?)(?:ي|نا)$/u;

function nominalKey(text: string): string | undefined {
  if (text.length > 80 || !NOMINAL.test(text) || CLAUSE_WORD.test(text)) return undefined;
  return text.replace(/^(?:the |ال)/u, '')
    .replace(/ (?:ال)(?=[\p{Script=Arabic}]{3,}(?: |$))/gu, ' ');
}

function arabicOwnedNoun(text: string): string | undefined {
  const dialect = ARABIC_OWNED.exec(text);
  if (dialect) return nominalKey(dialect[1]!);
  const words = text.split(' ');
  const suffix = ARABIC_POSSESSED_NOUN.exec(words.at(-1)!);
  if (suffix && !words.at(-1)!.startsWith('ال')) {
    words[words.length - 1] = suffix[1]!.replace(/ت$/u, 'ه');
    return nominalKey(words.join(' '));
  }
  return undefined;
}

export function openStructuredMemorySubject(text: string, allowDefinite = false): string | undefined {
  const known = subjectOf(text);
  if (known) return known;
  const own = /^(?:my|our) (.+)$/u.exec(text);
  const definite = allowDefinite && /^(?:the |ال)/u.test(text);
  const label = own || definite ? nominalKey(own ? own[1]! : text) : arabicOwnedNoun(text);
  return label ? `entity:${label}` : undefined;
}

function descriptor(text: string): StructuredMemoryProperty | undefined {
  const key = nominalKey(text);
  if (!key) return undefined;
  const preference = /^(?:(?:preferred|favou?rite) (.+)|(.+) (?:المفضل|المفضله))$/u.exec(key);
  const label = preference ? `${preference[1] ?? preference[2]} preference` : key;
  return propertyOf(key) ?? `descriptor:${label}`;
}

function openTarget(text: string): StructuredMemoryTarget | undefined {
  const genitive = /^(?<owner>.+?)(?:'s|') (?<field>.+)$/u.exec(text)
    ?? /^(?<field>.+?) of (?<owner>.+)$/u.exec(text);
  if (genitive) {
    const owner = openStructuredMemorySubject(genitive.groups!.owner!, true);
    const key = descriptor(genitive.groups!.field!);
    if (owner && key) return targetFor(owner, key);
  }
  const ownedName = /^((?:my|our) .+) name$/u.exec(text);
  const namedOwner = ownedName && openStructuredMemorySubject(ownedName[1]!);
  if (namedOwner) return targetFor(namedOwner, 'name');
  const possession = /^(my|our|the) (.+)$/u.exec(text);
  if (possession) {
    const key = descriptor(possession[2]!);
    return key ? targetFor('user', key) : undefined;
  }
  for (const space of text.matchAll(/ /gu)) {
    const left = text.slice(0, space.index);
    const right = text.slice(space.index + 1);
    const property = /^(?:رقم|نمره)$/u.test(left) ? 'number' : propertyOf(left);
    if (!property) continue;
    const owned = openStructuredMemorySubject(right, true);
    // A determiner inside a genitive can also identify the entity (for example, a room of a building).
    const definite = / ال[\p{Script=Arabic}]/u.test(right) && nominalKey(right);
    if (owned || definite) return targetFor(owned ?? `entity:${definite}`, property);
  }
  const owned = arabicOwnedNoun(text);
  const key = owned && descriptor(owned);
  return key ? targetFor('user', key) : undefined;
}

export function targetFor(subject: string | null, property: StructuredMemoryProperty): StructuredMemoryTarget {
  const canonical = subject === 'user' && property === 'location' || subject === 'home' && ['address', 'location'].includes(property);
  return canonical ? { subject: 'user', property: 'address' } : { subject, property };
}

function withSubject(subject: string, property: string): StructuredMemoryTarget | undefined {
  const key = propertyOf(property);
  const owner = key && subjectOf(subject);
  return owner && key ? targetFor(owner, key) : undefined;
}

function arabicPossession(text: string): { property: StructuredMemoryProperty; subject: string | null } | undefined {
  for (const suffix of ['هما', 'ها', 'هم', 'هن', 'نا', 'ي', 'ه']) {
    if (!text.endsWith(suffix)) continue;
    const stem = text.slice(0, -suffix.length);
    const property = propertyOf(stem) ?? (stem.endsWith('ت') ? propertyOf(stem.slice(0, -1) + 'ه') : undefined);
    if (property) return { property, subject: suffix === 'ي' || suffix === 'نا' ? 'user' : null };
  }
  return undefined;
}

/** Resolve the full referring phrase. Prefix matches are reserved for explicit Arabic statement syntax. */
function knownTarget(text: string): StructuredMemoryTarget | undefined {
  if (/^(?:رقم|نمره) (?:هاتف|جوال|تلفون|تليفون|موبايل)(?:ي|نا)(?: المحمول)?$/u.test(text)) return targetFor('user', 'phone');
  const preferred = /^(.*?) المفضل(?:ه)?$/u.exec(text);
  const preferredField = preferred && arabicPossession(preferred[1]!);
  if (preferredField && preferredField.property === 'language') return targetFor(preferredField.subject, 'language');
  const genitive = /^(.+?)(?:'s|') (.+)$/u.exec(text);
  if (genitive) {
    const target = withSubject(genitive[1]!, genitive[2]!);
    if (target) return target;
  }
  const genitiveOf = /^(.+?) (?:of|for) (.+)$/u.exec(text);
  if (genitiveOf) {
    const target = withSubject(genitiveOf[2]!, genitiveOf[1]!);
    if (target) return target;
  }
  const possession = /^(my|our|his|her|its|their) (.+)$/u.exec(text);
  if (possession) {
    const property = propertyOf(possession[2]!);
    if (property) return targetFor(/^(?:my|our)$/u.test(possession[1]!) ? 'user' : null, property);
  }
  const arabic = /\p{Script=Arabic}/u.test(text);
  if (!arabic && !/^(?:my|our) /u.test(text)) return undefined;

  for (const space of text.matchAll(/ /gu)) {
    const left = text.slice(0, space.index);
    const right = text.slice(space.index + 1);
    if (arabic) {
      const target = withSubject(right, left);
      if (target) return target;
      const possessive = arabicPossession(left);
      const owner = subjectOf(right);
      if (owner && possessive?.subject === 'user') return targetFor(owner, possessive.property);
    }
    const subject = subjectOf(left);
    const descriptor = propertyOf(right) ?? arabicPossession(right)?.property;
    if (subject && descriptor) return targetFor(subject, descriptor);
  }
  const owned = arabicPossession(text);
  return owned ? targetFor(owned.subject, owned.property) : undefined;
}

export function resolveStructuredMemoryTarget(text: string, open = false): StructuredMemoryTarget | undefined {
  return knownTarget(text) ?? (open ? openTarget(text) : undefined);
}
