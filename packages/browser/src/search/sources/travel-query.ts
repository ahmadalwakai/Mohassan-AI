import { publicSearchScan, publicSearchText } from '../local-index.js';
import type { SearchQuery } from '../providers.js';

type TravelPurpose = 'place' | 'guide' | 'see_do' | 'get_in' | 'get_around';

const placePatterns = [
  /^where (?:is|are)\s+(.+?)(?:\s+located(?=[؟?!.]*$)[؟?!.]*)?$/iu,
  /^(?:(?:what is |what['’]s )?(?:the )?(?:address|location) of)\s+(.+)$/iu,
  /^(?:[أا]ين(?:\s+(?:يقع|تقع|يوجد|توجد))?|(?:ما|ما\s+هو|ما\s+هي|أعطني)\s+(?:عنوان|موقع))\s+(.+)$/u,
];
const guidePatterns: [TravelPurpose, RegExp][] = [
  ['see_do', /^(?:what (?:can I |to )?(?:see|do)|(?:what are )?(?:(?:the )?(?:best|top) )?(?:things to do|(?:tourist )?attractions|places to (?:see|visit)))\s+in\s+(.+)$/iu],
  ['see_do', /^(?:(?:ما(?:\s+هي)?\s+)?(?:[أا]فضل\s+)?(?:ال[أا]ماكن\s+السياحية|المعالم(?:\s+السياحية)?|ال[أا]نشطة(?:\s+السياحية)?)|ماذا\s+[أا]زور)\s+في\s+(.+)$/u],
  ['get_around', /^(?:how (?:can|do) I get around|(?:how to )?get(?:ting)? around)\s+(.+)$/iu],
  ['get_around', /^(?:(?:كيف\s+(?:أتنقل|اتنقل)|التنقل|المواصلات)\s+(?:في|داخل))\s+(.+)$/u],
  ['get_in', /^(?:how (?:can|do) I|how to)\s+(?:get|travel)\s+from\s+.+?\s+to\s+(.+)$/iu],
  ['get_in', /^(?:(?:how (?:can|do) I|how to)\s+(?:get|travel)|getting)\s+to\s+(.+?)(?:\s+from\s+.+)?$/iu],
  ['get_in', /^(?:كيف\s+(?:أصل|اصل|أذهب|اذهب)|الوصول)\s+من\s+.+?\s+[إا]لى\s+(.+)$/u],
  ['get_in', /^(?:كيف\s+(?:أصل|اصل|أذهب|اذهب)|الوصول)\s+[إا]لى\s+(.+?)(?:\s+من\s+.+)?$/u],
  ['guide', /^(?:(?:travel guide (?:to|for)|guide to|visit(?:ing)?|travel(?:ling|ing)? to)\s+(.+)|(.+?)\s+travel guide)$/iu],
  ['guide', /^(?:دليل(?:\s+السفر|\s+سياحي)?\s+(?:إلى|الى|في)|السياحة\s+في|السفر\s+[إا]لى)\s+(.+)$/u],
];

export function travelSubject(input: string): string | null {
  const subject = input.replace(/\p{Cf}/gu, '').trim().replace(/[؟?!.]+$/u, '').trim();
  const unquoted = subject.replace(/^["“«](.*)["”»]$/u, '$1').trim();
  if (!/\p{L}/u.test(unquoted) || unquoted.length > 160 || /[:;؛?؟/\n\r<>]/u.test(unquoted)) return null;
  const decoded = publicSearchScan(unquoted);
  if (publicSearchText(unquoted) !== unquoted || publicSearchText(decoded) !== decoded) return null;
  return unquoted;
}

export function parseTravelQuery(query: SearchQuery): { subject: string; purpose: TravelPurpose } | null {
  const text = query.question.replace(/\p{Cf}/gu, '').trim();
  if (query.intent === 'technical') return null;
  for (const pattern of placePatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const subject = travelSubject(match[1]);
    if (!subject || /^(?:my|your|طلبي|طلبك|حسابي|حسابك)(?:\s|$)/iu.test(subject)) return null;
    return { subject, purpose: 'place' };
  }
  for (const [purpose, pattern] of guidePatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const subject = travelSubject(match[1] ?? match[2]);
    return subject ? { subject, purpose } : null;
  }
  return null;
}
