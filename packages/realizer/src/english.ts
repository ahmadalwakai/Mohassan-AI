import type { Noun } from "./frame.js";

export function englishNoun(noun: Noun["en"], plural: boolean): string {
  if (!plural || noun.mass) return noun.singular;
  if (noun.plural !== undefined) return noun.plural;

  const singular = noun.singular;
  if (/[cs]h$|[sxz]$/i.test(singular)) return singular + "es";
  if (/[^aeiou]y$/i.test(singular)) return singular.slice(0, -1) + "ies";
  return singular + "s";
}

export function indefiniteArticle(phrase: string, override?: "a" | "an"): string {
  if (override) return override;
  if (/^(?:honest|honou?r|hour|heir)/i.test(phrase)) return "an";
  if (/^(?:euro|one\b|once\b|uni(?:corn|form|on|que|t|vers)|use|user|usu)/i.test(phrase)) return "a";
  const initialism = /^[A-Z]{2,}(?=\W|$)/.exec(phrase);
  if (initialism) return /^[AEFHILMNORSX]/u.test(initialism[0]) ? "an" : "a";
  return /^[aeiou]/i.test(phrase) ? "an" : "a";
}

export function englishOrdinal(rank: number, formatted: string): string {
  const lastTwo = rank % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return formatted + "th";
  const suffix = ["th", "st", "nd", "rd"][rank % 10] ?? "th";
  return formatted + suffix;
}
