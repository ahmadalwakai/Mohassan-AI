import { foldText } from '@mohassan/skills';

/** The existing guard against using a regional or seasonal cause to answer a general question. */
export const RESTRICTED_CASE = /(?:^|\s)(?:في|خلال)\s+(?:فصل|موسم|فصول|الشتاء|الصيف|الربيع|الخريف|المناطق|منطقه|مناطق|غرب|شرق|شمال|جنوب|بعض|هذه|تلك|اغلب|معظم)(?=\s|$)|(?:^|\s)(?:به|بها|فيه|فيها)(?=\s|$)|\b(?:in|during)\s+(?:winter|summer|spring|autumn|(?:the\s+)?(?:tropics|monsoon|north|south|east|west)|some|these|those|this\s+region|that\s+region|parts\s+of|most\s+of)\b|\b(?:within|across|throughout)\s+\S/u;

export function reasonScopeMatches(question: string, effect: string): boolean {
  return !RESTRICTED_CASE.test(foldText(effect)) || RESTRICTED_CASE.test(foldText(question));
}
