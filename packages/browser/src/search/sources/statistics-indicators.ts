import type { StatisticsIndicator } from './statistics-types.js';

// Codes, definitions, units and upstream sources checked 2026-11-27. For each WDI code:
// https://data.worldbank.org/indicator/{code} and https://api.worldbank.org/v2/indicator/{code}?format=json&source=2
// IMF WEO indicator metadata: https://www.imf.org/external/datamapper/api/v2/indicators
// The Arabic sources below were retrieved on 2026-11-27. Exact URLs and excerpts are in
// fixtures/statistics/{world-bank-arabic-indicators,imf-arabic-terminology,arabic-indicator-aliases}.json.
// WDI's Arabic unit fields are empty. Units come from the indicator names and notes, using singular
// count nouns after numeric values. Match patterns also allow shortened and possessive forms.
const people = { en: 'people', ar: 'نسمة' };
const usd = { en: 'current U.S. dollars', ar: 'دولار أمريكي بالأسعار الجارية' };
const annualPercent = { en: 'percent annual change', ar: '% سنوياً' };
const nationalAccounts = 'National statistical organizations and/or central banks, OECD, and World Bank';
const demographicSources = 'United Nations Population Division, national statistical offices, and Eurostat';
const populationSources = `${demographicSources}, and United Nations Statistics Division`;

const indicators: readonly (StatisticsIndicator & { pattern: RegExp })[] = [
  // https://api.worldbank.org/v2/ar/indicator/NY.GDP.PCAP.CD?format=json&source=2
  // IMF UAE Article IV provides the alternate word order and dollar unit. The Saudi Press Agency
  // records the per-capita phrase with the denominator last.
  {
    en: 'Gross domestic product per capita (GDP per capita)', ar: 'نصيب الفرد من إجمالي الناتج المحلي',
    pattern: /\bgdp per capita\b|\bgross domestic product per capita\b|نصيب الفرد من (?:اجمالي الناتج المحلي|الناتج المحلي(?: الاجمالي)?)|الناتج المحلي(?: الاجمالي)? للفرد/u,
    worldBank: { code: 'NY.GDP.PCAP.CD', unit: { en: 'current U.S. dollars per person', ar: usd.ar }, upstream: nationalAccounts },
    imf: { code: 'NGDPDPC', unit: { en: 'U.S. dollars per capita', ar: 'دولار أمريكي' } },
  },
  // https://api.worldbank.org/v2/ar/indicator/NY.GDP.MKTP.KD.ZG?format=json&source=2
  // The World Bank Egypt overview and IMF Article IV releases record the growth variants.
  // The IMF UAE table supplies the annual percentage basis.
  {
    en: 'Gross domestic product growth (GDP growth)', ar: 'نمو إجمالي الناتج المحلي',
    pattern: /\b(?:gdp|gross domestic product) growth(?: rate)?\b|(?:معدل )?نمو (?:اجمالي الناتج المحلي|الناتج المحلي(?: الاجمالي)?)/u,
    worldBank: { code: 'NY.GDP.MKTP.KD.ZG', unit: annualPercent, upstream: nationalAccounts },
    imf: { code: 'NGDP_RPCH', unit: { en: 'Annual percent change', ar: annualPercent.ar } },
  },
  // https://api.worldbank.org/v2/ar/indicator/NY.GDP.MKTP.CD?format=json&source=2
  // IMF Jordan's 2024 review provides the billions-of-U.S.-dollars unit.
  {
    en: 'Gross domestic product (GDP)', ar: 'إجمالي الناتج المحلي',
    pattern: /\b(?:gdp|gross domestic product)\b|اجمالي الناتج المحلي|الناتج المحلي(?: الاجمالي)?/u,
    worldBank: { code: 'NY.GDP.MKTP.CD', unit: usd, upstream: nationalAccounts },
    imf: { code: 'NGDPD', unit: { en: 'Billions of U.S. dollars', ar: 'مليار دولار أمريكي' } },
  },
  // https://api.worldbank.org/v2/ar/indicator/SP.POP.GROW?format=json&source=2
  // OICStat and Statistics Centre – Abu Dhabi record the alternate population-growth terms.
  {
    en: 'Population growth', ar: 'معدل نمو السكان',
    pattern: /\bpopulation growth(?: rate)?\b|الزيادة السكانية|(?:معدل )?نمو (?:عدد )?السكان/u,
    worldBank: { code: 'SP.POP.GROW', unit: annualPercent, upstream: populationSources },
  },
  // https://api.worldbank.org/v2/ar/indicator/SP.POP.TOTL?format=json&source=2
  // The WDI GDP-per-capita note supplies the count wording. IMF UAE Article IV supplies the person units.
  {
    en: 'Population', ar: 'عدد السكان',
    pattern: /\bpopulation\b|\bhow many (?:people|inhabitants)\b|(?:عدد|تعداد) (?:ال)?سكان|(?<!\p{L})(?:ال)?سكان(?!\p{L})/u,
    worldBank: { code: 'SP.POP.TOTL', unit: people, upstream: populationSources },
    imf: { code: 'LP', unit: { en: 'Millions of people', ar: 'مليون نسمة' } },
  },
  // https://api.worldbank.org/v2/ar/indicator/FP.CPI.TOTL.ZG?format=json&source=2
  // The IMF UAE and Jordan excerpts supply the CPI and rate wording.
  {
    en: 'Inflation rate', ar: 'معدل التضخم',
    pattern: /\binflation(?: rate)?\b|(?:معدل )?التضخم|تضخم مؤشر اسعار المستهلك/u,
    worldBank: { code: 'FP.CPI.TOTL.ZG', unit: annualPercent, upstream: 'International Monetary Fund, International Financial Statistics' },
    imf: { code: 'PCPIPCH', unit: { en: 'Annual percent change', ar: annualPercent.ar } },
  },
  // https://api.worldbank.org/v2/ar/indicator/SL.UEM.TOTL.ZS?format=json&source=2
  // IMF Jordan's 2017 statement supplies the rate wording and standalone percent unit.
  // The World Bank's West Bank and Gaza overview also records the proportion wording.
  {
    en: 'Unemployment rate', ar: 'معدل البطالة',
    pattern: /\bunemployment(?: rate)?\b|(?:معدل|نسبة) البطالة|البطالة|بطالة اجمالي/u,
    worldBank: { code: 'SL.UEM.TOTL.ZS', unit: { en: 'percent of total labour force', ar: '% من إجمالي القوى العاملة' }, upstream: 'International Labour Organization, modelled ILO estimates' },
    imf: { code: 'LUR', unit: { en: 'Percent', ar: '%' } },
  },
  // https://api.worldbank.org/v2/ar/indicator/SP.DYN.LE00.IN?format=json&source=2
  // OICStat uses the alternate wording for birth. Morocco's High Commission for Planning
  // records the shorter life expectancy term.
  {
    en: 'Life expectancy at birth', ar: 'متوسط العمر المتوقع عند الولادة',
    pattern: /\blife expectancy(?: at birth)?\b|(?:متوسط )?العمر المتوقع(?: عند (?:الولادة|الميلاد))?|امل الحياة/u,
    worldBank: { code: 'SP.DYN.LE00.IN', unit: { en: 'years', ar: 'سنة' }, upstream: demographicSources },
  },
  // https://api.worldbank.org/v2/ar/indicator/SP.DYN.TFRT.IN?format=json&source=2
  {
    en: 'Fertility rate', ar: 'معدل الخصوبة',
    pattern: /\bfertility rate\b|معدل الخصوبة/u,
    worldBank: { code: 'SP.DYN.TFRT.IN', unit: { en: 'births per woman', ar: 'ولادة لكل امرأة' }, upstream: demographicSources },
  },
];

// Annual totals cannot answer a request for a subperiod, a demographic subgroup or a GDP variant
// with a different denominator or price basis.
const unsupportedDetail = /\b(?:monthly|quarterly|month over month|core inflation|end of period|unemployment claims|youth unemployment|urban population|rural population|population density|working age population|purchasing power parity|ppp|real gdp(?! growth)|constant (?:dollars|prices)|local currency)\b|شهري|فصلي|ربع سنوي|تضخم اساسي|بطالة الشباب|كثافة السكان|الكثافة السكانية|سكان (?:المدن|الريف)|تعادل القوة الشرائية|بالاسعار الثابتة|بالعملة المحلية/u;

function normalize(text: string) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[أإآٱ]/gu, 'ا').replace(/[\u0640\p{M}\p{Cf}]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function matchStatisticsIndicator(text: string): StatisticsIndicator | undefined {
  const normalized = normalize(text);
  if (unsupportedDetail.test(normalized)) return undefined;
  const [indicator, ...other] = indicators.filter(candidate => candidate.pattern.test(normalized));
  if (!indicator) return undefined;
  // A more specific variant also matches its base indicator. Fall through on genuinely mixed metrics.
  const remainder = normalized.replace(indicator.pattern, '');
  return other.some(candidate => candidate.pattern.test(remainder)) ? undefined : indicator;
}
