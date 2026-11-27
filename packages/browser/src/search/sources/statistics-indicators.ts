import type { StatisticsIndicator } from './statistics-types.js';

// Codes, definitions, units and upstream sources checked 2026-11-27. For each WDI code:
// https://data.worldbank.org/indicator/{code} and https://api.worldbank.org/v2/indicator/{code}?format=json&source=2
// IMF WEO indicator metadata: https://www.imf.org/external/datamapper/api/v2/indicators
const people = { en: 'people', ar: 'نسمة' };
const usd = { en: 'current U.S. dollars', ar: 'دولار أمريكي بالأسعار الجارية' };
const percent = { en: 'percent', ar: 'بالمئة' };
const annualPercent = { en: 'percent annual change', ar: 'بالمئة تغير سنوي' };
const nationalAccounts = 'National statistical organizations and/or central banks, OECD, and World Bank';
const demographicSources = 'United Nations Population Division, national statistical offices, and Eurostat';
const populationSources = `${demographicSources}, and United Nations Statistics Division`;

const indicators: readonly (StatisticsIndicator & { pattern: RegExp })[] = [
  {
    en: 'Gross domestic product per capita (GDP per capita)', ar: 'نصيب الفرد من الناتج المحلي الإجمالي',
    pattern: /\bgdp per capita\b|\bgross domestic product per capita\b|نصيب الفرد من الناتج المحلي(?: الاجمالي)?|الناتج المحلي(?: الاجمالي)? للفرد/u,
    worldBank: { code: 'NY.GDP.PCAP.CD', unit: { en: 'current U.S. dollars per person', ar: 'دولار أمريكي للفرد بالأسعار الجارية' }, upstream: nationalAccounts },
    imf: { code: 'NGDPDPC', unit: { en: 'U.S. dollars per capita', ar: 'دولار أمريكي للفرد' } },
  },
  {
    en: 'Gross domestic product growth (GDP growth)', ar: 'نمو الناتج المحلي الإجمالي',
    pattern: /\b(?:gdp|gross domestic product) growth(?: rate)?\b|(?:معدل )?نمو الناتج المحلي(?: الاجمالي)?/u,
    worldBank: { code: 'NY.GDP.MKTP.KD.ZG', unit: annualPercent, upstream: nationalAccounts },
    imf: { code: 'NGDP_RPCH', unit: { en: 'Annual percent change', ar: annualPercent.ar } },
  },
  {
    en: 'Gross domestic product (GDP)', ar: 'الناتج المحلي الإجمالي',
    pattern: /\b(?:gdp|gross domestic product)\b|(?:اجمالي )?الناتج المحلي(?: الاجمالي)?/u,
    worldBank: { code: 'NY.GDP.MKTP.CD', unit: usd, upstream: nationalAccounts },
    imf: { code: 'NGDPD', unit: { en: 'Billions of U.S. dollars', ar: 'مليار دولار أمريكي' } },
  },
  {
    en: 'Population growth', ar: 'نمو السكان',
    pattern: /\bpopulation growth(?: rate)?\b|(?:معدل )?نمو (?:عدد )?السكان/u,
    worldBank: { code: 'SP.POP.GROW', unit: annualPercent, upstream: populationSources },
  },
  {
    en: 'Population', ar: 'عدد السكان',
    pattern: /\bpopulation\b|\bhow many (?:people|inhabitants)\b|عدد (?:ال)?سكان|(?:^|(?<= ))سكان(?= |$)/u,
    worldBank: { code: 'SP.POP.TOTL', unit: people, upstream: populationSources },
    imf: { code: 'LP', unit: { en: 'Millions of people', ar: 'مليون نسمة' } },
  },
  {
    en: 'Inflation rate', ar: 'معدل التضخم',
    pattern: /\binflation(?: rate)?\b|(?:معدل )?التضخم/u,
    worldBank: { code: 'FP.CPI.TOTL.ZG', unit: annualPercent, upstream: 'International Monetary Fund, International Financial Statistics' },
    imf: { code: 'PCPIPCH', unit: { en: 'Annual percent change', ar: annualPercent.ar } },
  },
  {
    en: 'Unemployment rate', ar: 'معدل البطالة',
    pattern: /\bunemployment(?: rate)?\b|(?:معدل|نسبة) البطالة|البطالة/u,
    worldBank: { code: 'SL.UEM.TOTL.ZS', unit: { en: 'percent of total labour force', ar: 'بالمئة من إجمالي القوة العاملة' }, upstream: 'International Labour Organization, modelled ILO estimates' },
    imf: { code: 'LUR', unit: { en: 'Percent', ar: percent.ar } },
  },
  {
    en: 'Life expectancy at birth', ar: 'متوسط العمر المتوقع عند الولادة',
    pattern: /\blife expectancy(?: at birth)?\b|(?:متوسط )?العمر المتوقع(?: عند الولادة)?|امل الحياة/u,
    worldBank: { code: 'SP.DYN.LE00.IN', unit: { en: 'years', ar: 'سنة' }, upstream: demographicSources },
  },
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
