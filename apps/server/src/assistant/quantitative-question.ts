import { extractSearchProblem } from './arithmetic-search-quantities.js';
import { normalizeWordProblem } from './word-problem-quantities.js';

const quantitativeQuestion = /\b(?:how (?:many|much|far|long|old)|what (?:percen(?:t|tage)|fraction|ratio|rate|proportion)|what(?: is| was| will be|'s) (?:the |his |her |their )?(?:(?:minimum|maximum|regular|final|initial) )?(?:total|sum|difference|average|number|amount|price|cost|percen(?:t|tage)|fraction|rate|remainder|distance|age))\b[^?]*\?\s*$/iu;

/** A numeric question with supplied quantities, independent of solver coverage. */
export function hasQuantitativeQuestion(text: string): boolean {
  const normalized = normalizeWordProblem(text);
  const question = quantitativeQuestion.exec(normalized);
  return question !== null
    && extractSearchProblem([normalized.slice(0, question.index)], question[0]).quantities.length >= 2;
}
