export const AUSTRALIA_POPULATION_RELEASE = 'https://www.abs.gov.au/statistics/people/population/national-state-and-territory-population/latest-release';

const ARABIC_QUESTION = /^(?:(?:(?:و?كم(?: يبلغ)?|ما(?: هو)?) )?(?:(?:عدد|تعداد) سكان|التعداد السكاني) (?:دولة )?استراليا|كم نسمة في استراليا)(?: حاليا| الان| اليوم| الحالي)?$/u;
const ENGLISH_QUESTION = /^(?:(?:what(?: is|'s) )?(?:(?:the )?(?:(?:current|latest) )?population (?:of|in) australia|australia(?:'s)? (?:(?:current|latest) )?population)|how many (?:people|residents|inhabitants) (?:live|reside|are) in australia)(?: now| today| currently)?$/iu;

/** Match the national total and leave historical, regional and subgroup questions to ordinary search. */
export function asksAustraliaPopulation(text: string): boolean {
  const question = text.normalize('NFKC').replace(/\p{M}/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/’/gu, "'")
    .replace(/\s+/gu, ' ').trim().replace(/[.?!؟]+$/u, '').trim();
  return ARABIC_QUESTION.test(question) || ENGLISH_QUESTION.test(question);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TOTAL = /(?:^|[^\p{L}])(Australia['’]s population was (\d{1,3}(?:,\d{3})+) people at (\d{1,2}) (\p{L}+) (\d{4})\s*\.)/u;
const ARABIC_DATE = new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'long', year: 'numeric', numberingSystem: 'latn', timeZone: 'UTC' });

/** Read the dated estimate from the latest release's national headline, without using its growth figures. */
export function australiaPopulationAnswer(page: { url: string; text: string }, lang: 'ar' | 'en') {
  if (URL.parse(page.url)?.origin !== new URL(AUSTRALIA_POPULATION_RELEASE).origin) return null;
  const found = TOTAL.exec(page.text.replace(/\s+/gu, ' '));
  if (!found) return null;
  const [, quote, count, day, month, year] = found;
  const monthIndex = MONTHS.indexOf(month!);
  if (monthIndex < 0) return null;
  const referenceDate = new Date(Date.UTC(Number(year), monthIndex, Number(day)));
  if (referenceDate.getUTCMonth() !== monthIndex) return null;
  const title = lang === 'ar' ? 'مكتب الإحصاء الأسترالي' : 'Australian Bureau of Statistics';
  const line = lang === 'ar'
    ? `من **${title}**: بلغ عدد سكان أستراليا ${count} نسمة في ${ARABIC_DATE.format(referenceDate)}.`
    : `From **${title}**: Australia’s population was ${count} people on ${day} ${month} ${year}.`;
  return { title, lines: [line], quote: quote! };
}
