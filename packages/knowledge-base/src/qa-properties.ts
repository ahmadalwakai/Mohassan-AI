import { normalizeLookupKey } from './normalize.ts';
import type { KnowledgeAnswerType, KnowledgeProperty } from './qa-types.ts';
import type { Language } from './types.ts';

type PropertyDefinition = {
  property: KnowledgeProperty;
  aliases: Record<Language, readonly string[]>;
};

function define(id: string, en: string, ar: string, answerType: KnowledgeAnswerType,
  aliasesEn: string, aliasesAr: string, unit?: string): PropertyDefinition {
  return {
    property: { id, label: { en, ar }, answerType, ...(unit !== undefined && { unit }) },
    aliases: { en: [en, ...aliasesEn.split('|').filter(Boolean)], ar: [ar, ...aliasesAr.split('|').filter(Boolean)] },
  };
}

/** These are noun phrases. Verbal constructions are handled by the question grammar. */
export const KNOWLEDGE_PROPERTIES = {
  capital: define('P36', 'capital', 'عاصمة', 'entity', 'capital city', 'العاصمة|مدينة العاصمة'),
  population: define('P1082', 'population', 'عدد السكان', 'quantity', 'total population|number of inhabitants|number of residents',
    'عدد سكان|عدد السكان في|عدد السكان بـ|سكان|السكان|إجمالي السكان', '1'),
  area: define('P2046', 'area', 'مساحة', 'quantity', 'surface area|total area', 'المساحة|مساحة سطح', 'Q712226'),
  currency: define('P38', 'currency', 'عملة', 'entity', 'official currency', 'العملة|العملة الرسمية|عملة رسمية'),
  inception: define('P571', 'inception', 'تاريخ التأسيس', 'date', 'foundation date|founding date|establishment date|year of foundation|year of establishment',
    'تاريخ تأسيس|سنة التأسيس|سنة تأسيس|عام تأسيس|عام التأسيس'),
  founder: define('P112', 'founder', 'مؤسس', 'entity', 'founders', 'المؤسس|مؤسسو|مؤسسي|مؤسسين'),
  birthDate: define('P569', 'date of birth', 'تاريخ الميلاد', 'date', 'birth date|birthday|year of birth', 'تاريخ ميلاد|تاريخ مولد|تاريخ المولد|سنة ميلاد'),
  birthPlace: define('P19', 'place of birth', 'مكان الميلاد', 'entity', 'birthplace|birth place', 'مكان ميلاد|مكان الولادة|مكان ولادة|مسقط رأس|مسقط الرأس'),
  deathDate: define('P570', 'date of death', 'تاريخ الوفاة', 'date', 'death date|year of death', 'تاريخ وفاة|تاريخ وفاه|تاريخ الموت|سنة وفاة'),
  deathPlace: define('P20', 'place of death', 'مكان الوفاة', 'entity', 'place of passing|deathplace', 'مكان وفاة|مكان وفاه'),
  country: define('P17', 'country', 'الدولة', 'entity', '', 'دولة|بلد|البلد'),
  citizenship: define('P27', 'country of citizenship', 'جنسية', 'entity', 'nationality|citizenship', 'الجنسية|دولة المواطنة'),
  adminArea: define('P131', 'administrative location', 'الموقع الإداري', 'entity', 'administrative region|administrative territorial entity',
    'الوحدة الإدارية|المنطقة الإدارية|المنطقة الادارية'),
  continent: define('P30', 'continent', 'قارة', 'entity', '', 'القارة'),
  officialLanguage: define('P37', 'official language', 'اللغة الرسمية', 'entity', 'official languages', 'لغة رسمية|لغات رسمية|اللغات الرسمية'),
  originalLanguage: define('P364', 'original language of film or TV show', 'اللغة الأصلية للفيلم', 'entity', '', 'اللغة الأصلية للمسلسل'),
  author: define('P50', 'author', 'مؤلف', 'entity', 'authors|writer|writers|book author', 'مؤلفة|المؤلف|كاتب|الكاتب|مؤلفو|مؤلفي'),
  screenwriter: define('P58', 'screenwriter', 'كاتب السيناريو', 'entity', 'screenwriters|scriptwriter', 'مؤلف السيناريو|كتاب السيناريو'),
  director: define('P57', 'director', 'مخرج', 'entity', 'directors|film director', 'المخرج|مخرجة|المخرجة'),
  creator: define('P170', 'creator', 'مبتكر', 'entity', 'creators', 'المبتكر'),
  composer: define('P86', 'composer', 'ملحن', 'entity', 'composers', 'الملحن|ملحنة|الملحنة'),
  publisher: define('P123', 'publisher', 'ناشر', 'entity', 'publishers', 'الناشر|دار نشر|دار النشر'),
  publication: define('P577', 'publication date', 'تاريخ النشر', 'date', 'release date|publication year|release year',
    'تاريخ نشر|تاريخ الإصدار|تاريخ إصدار|سنة النشر|سنة الإصدار'),
  headquarters: define('P159', 'headquarters location', 'المقر الرئيسي', 'entity', 'headquarters|head office', 'المقر|مقر|مقر رئيسي|مقرها الرئيسي'),
  headOfState: define('P35', 'head of state', 'رئيس الدولة', 'entity', 'heads of state', 'رئيس دولة'),
  headOfGovernment: define('P6', 'head of government', 'رئيس الحكومة', 'entity', 'heads of government', 'رئيس حكومة'),
  elevation: define('P2044', 'elevation', 'ارتفاع عن سطح البحر', 'quantity', 'elevation above sea level|altitude', 'الارتفاع عن سطح البحر|ارتفاع فوق سطح البحر', 'Q11573'),
  height: define('P2048', 'height', 'ارتفاع', 'quantity', '', 'الارتفاع|قامة|طول القامة', 'Q11573'),
  length: define('P2043', 'length', 'طول', 'quantity', 'total length', 'الطول|الطول الكلي|طول كلي', 'Q828224'),
  spouse: define('P26', 'spouse', 'زوج', 'entity', 'spouses|wife|husband', 'زوجة|الزوج|الزوجة|أزواج'),
  children: define('P40', 'children', 'أبناء', 'entity', 'child|sons|daughters', 'الأبناء|أولاد|الأولاد|ابناء|أطفال|الأطفال'),
  childCount: define('P1971', 'number of children', 'عدد الأبناء', 'quantity', 'child count', 'عدد أبناء|عدد الأولاد|عدد أولاد|عدد الأطفال|عدد أطفال', '1'),
  employees: define('P1128', 'number of employees', 'عدد الموظفين', 'quantity', 'employee count|number of staff', 'عدد موظفي|عدد موظفين|عدد العاملين', '1'),
  pages: define('P1104', 'number of pages', 'عدد الصفحات', 'quantity', 'page count', 'عدد صفحات', '1'),
  awards: define('P166', 'awards received', 'الجوائز التي نالها', 'entity', 'award received|awards|honours received|honors received', 'جوائز|الجوائز'),
  occupation: define('P106', 'occupation', 'مهنة', 'entity', 'occupations|profession|professions', 'المهنة|مهن|المهن'),
  cast: define('P161', 'cast member', 'طاقم التمثيل', 'entity', 'cast members|cast', 'الممثلون|الممثلين|ممثلون'),
  inventor: define('P61', 'discoverer or inventor', 'المكتشف أو المخترع', 'entity', 'inventor|discoverer', 'مخترع|المخترع|مكتشف|المكتشف'),
  countryOfOrigin: define('P495', 'country of origin', 'بلد المنشأ', 'entity', 'origin country', 'دولة المنشأ'),
  manufacturer: define('P176', 'manufacturer', 'الشركة المصنعة', 'entity', '', 'المصنع|الجهة المصنعة'),
  parentOrganization: define('P749', 'parent organization', 'المؤسسة الأم', 'entity', 'parent company|parent organisation', 'الشركة الأم'),
  owner: define('P127', 'owner', 'مالك', 'entity', 'owners|owned by', 'المالك|صاحب الملكية'),
  operator: define('P137', 'operator', 'مشغل', 'entity', 'operator organization', 'المشغل|الجهة المشغلة'),
  manager: define('P1037', 'director or manager', 'مدير', 'entity', 'manager', 'المدير'),
  causeOfDeath: define('P509', 'cause of death', 'سبب الوفاة', 'entity', 'death cause', 'سبب وفاة|سبب الموت'),
  predecessor: define('P155', 'predecessor', 'السابق', 'entity', 'preceding work', 'العمل السابق'),
  stockExchange: define('P414', 'stock exchange', 'بورصة', 'entity', 'stock exchanges|securities exchange', 'البورصة|البورصات'),
  waterArea: define('P2927', 'water as a percentage of area', 'نسبة المساحة المائية', 'quantity', 'water percentage', 'نسبة المسطحات المائية'),
  genre: define('P136', 'genre', 'النوع الفني', 'entity', 'genres', 'التصنيف الفني'),
  parts: define('P527', 'parts', 'الأجزاء', 'entity', 'components|component parts', 'أجزاء|مكونات|المكونات'),
} as const satisfies Record<string, PropertyDefinition>;

export type KnowledgePropertyKey = keyof typeof KNOWLEDGE_PROPERTIES;

const terms: Record<Language, Map<string, PropertyDefinition>> = { ar: new Map(), en: new Map() };
for (const definition of Object.values(KNOWLEDGE_PROPERTIES)) {
  for (const language of ['ar', 'en'] as const) {
    for (const alias of definition.aliases[language]) {
      const key = normalizeLookupKey(alias);
      const existing = terms[language].get(key);
      if (existing && existing !== definition) throw new Error(`Duplicate knowledge property phrase: ${alias}`);
      terms[language].set(key, definition);
    }
  }
}

export function mapKnowledgeProperty(phrase: string, language: Language): KnowledgeProperty | undefined {
  return terms[language].get(normalizeLookupKey(phrase))?.property;
}

/** Longest phrases first so "official language" cannot match just a trailing word. */
export function knowledgePropertyPattern(language: Language): string {
  return [...terms[language].keys()]
    .sort((left, right) => right.length - left.length)
    .map(text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('|');
}
