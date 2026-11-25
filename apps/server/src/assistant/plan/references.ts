import { computationReference } from '../computation-reference.js';
import { matchText } from '../mind/normalize.js';
import { actionHead, clauseMatchingText, matchingView } from './clauses.js';
import type { PlanReference, PlanStep, PlanTool, PlanValue, ResolvedStepInputs } from './types.js';
import { planReadTarget } from './web-target.js';

const PURCHASE = /\bhow (?:many|much)\b[^.!?]*(?:buy|afford|get)\b|(?<!\p{L})كم\s+[^.!؟?]*(?:اشتر[يى]|اشتري|يشتري|اشتريها|اقدر اشتري|اجيب|اخذ)(?!\p{L})/iu;
const PRICE = /\b(?:price|cost)\b|(?<!\p{L})(?:ال)?(?:سعر|اسعار|تكلفه)(?!\p{L})/u;
const RECALL_ALL = /\b(?:what (?:did|have) (?:i|we) (?:just )?(?:ask(?:ed)? you to )?(?:say|remember|save)|what (?:did|have) you (?:just )?(?:remember|remembered|save|saved)|what i (?:just )?(?:told you|asked you to (?:remember|save)))\b|(?:ماذا|ما|شو|ايش|وش)\s+(?:حفظت|تذكرت|قلت لك|طلبت منك|سجلت)/iu;
const RECALL_REFERENCE = /^(?:(?:recall|retrieve)\s+(?:it|that|this|the (?:note|fact|memory))|(?:استرجع|اذكر)(?:ها|ه)|(?:استرجع|اذكر)\s+(?:ذلك|هذا|اياه|اياها|الملاحظه|ما حفظته|ما قلته))[.?!؟]*$/u;
const READ_ON_PREVIOUS = /^(?:read(?: (?:the|that|this))? (?:page|link|site|website|article|top result|first result)|(?:اقرا|تصفح|افتح)(?:\s+(?:الصفحه|الموقع|الرابط|المقال)|(?:ه|ها)(?!\p{L})))/u;
const RESERVED = /^(?:remember|recall|search|for|about|that|it|what|is|the|my|from|this|memory|please|تذكر|احفظ|استرجع|اذكر|ان|هو|هي|ما|ماذا|من|في|عن|ذلك|هذه|هذا|كنت)$/u;
const REFERENCE = /\b(?:(?:(?:the\s+)?(?:first|second|third|previous|last|earlier)\s+|(?:this|the|that|its)\s+)(?:result|number|value|answer|total|figure|page(?: content| text)?|article|site|website|link|contents?|text|entity|name|person|city|country)(?!\s+(?:of|about)\s)|(?:it|them|its)\b|(?:that|this)\b(?=\s*(?:$|[.!?,;+-]|[*/÷×^])|\s+(?:by|times|plus|minus|from|with|into|using|through)\b))\b|(?<![\p{L}\p{N}])(?:(?:هذا|ذلك)\s+(?:الرقم|الناتج|الجواب|النص|المحتوي|الموقع|الرابط|الشخص)|(?:هذه|تلك)\s+(?:النتيجه|القيمه|الصفحه|المدينه|الدوله)|(?:النتيجه|الناتج|القيمه|الجواب|الرقم|الصفحه|المحتوي|النص|الموقع|الرابط)(?:\s+ال(?:اول(?:ي)?|ثاني(?:ه)?|ثالث(?:ه)?|سابق(?:ه)?|اخير(?:ه)?))?|(?:عنهما|عنه|عنها|منها|منه|لها|له|اياه|اياها|محتواها|محتواه|اضربها|اضربه|اقسمها|اقسمه|اجمعها|اجمعه|اطرحها|اطرحه|حولها|حوله|اقراها|اقراه|افتحها|افتحه))(?![\p{L}\p{N}])/gu;
const ENTITY_PHRASE = /\b(?:page|article|site|website|link|entity|name|person|city|country|its)\b|(?:الموقع|الصفحه|المقال|الرابط|الكيان|الاسم|الشخص|المدينه|الدوله)/u;
const NUMBER_PHRASE = /\b(?:number|value|total|figure)\b|(?:الرقم|القيمه)/u;
const TEXT_PHRASE = /\b(?:contents?|text)\b|(?:محتوي|محتواها|محتواه|النص)/u;
const SUBJECT_NUMBER = [ /\bfirst\b|الاول(?:ي)?/u, /\bsecond\b|الثاني(?:ه)?/u, /\bthird\b|الثالث(?:ه)?/u ];

export function purchaseOnPrice(text: string, source: PlanStep): boolean {
  return source.tool === 'search' && PRICE.test(matchText(source.text)) && PURCHASE.test(matchText(text));
}

function memoryTopicWords(text: string): Set<string> {
  return new Set((matchText(text).match(/[\p{L}\p{N}'-]+/gu) ?? []).filter(word => word.length > 2 && !RESERVED.test(word)));
}

function memorySource(text: string, previous: PlanStep[]): PlanStep | undefined {
  const words = memoryTopicWords(text);
  return previous.findLast(step => step.tool === 'remember' && (RECALL_ALL.test(matchText(text))
    || RECALL_REFERENCE.test(actionHead(text))
    || [...memoryTopicWords(step.text)].some(word => words.has(word))));
}

function referenceKind(tool: PlanTool, phrase: string, source: PlanStep): PlanReference['kind'] {
  if (tool === 'compute' || NUMBER_PHRASE.test(phrase)) return 'number';
  if (tool === 'read') return 'entity';
  if (tool === 'pdf' || tool === 'letter' || TEXT_PHRASE.test(phrase)) return source.output === 'file' ? 'value' : 'text';
  if (ENTITY_PHRASE.test(phrase)) return source.output === 'text' && source.tool === 'read' ? 'value' : 'entity';
  if (tool === 'search' && source.tool === 'search' && source.output === 'text') return 'entity';
  return 'value';
}

export function planReferences(text: string, tool: PlanTool, previous: PlanStep[]): PlanReference[] {
  const latest = previous.at(-1);
  if (!latest || tool === 'unsupported') return [];
  if (tool === 'compare') {
    return previous.filter(step => step.tool !== 'unsupported' && step.output !== 'file').slice(-2)
      .map(step => ({ stepId: step.id, kind: 'value' }));
  }
  if (tool === 'recall') {
    const remembered = memorySource(text, previous);
    return remembered ? [{ stepId: remembered.id, kind: 'value' }] : [];
  }
  // Preserve the calculator's existing Arabic clitic and preposition handling.
  const masked = clauseMatchingText(text);
  const existing = tool === 'compute' ? computationReference(masked) : null;
  const view = matchingView(masked);
  const references: PlanReference[] = [];
  for (const found of view.text.matchAll(REFERENCE)) {
    const ordinal = SUBJECT_NUMBER.findIndex(pattern => pattern.test(found[0]));
    const source = ordinal < 0 ? latest : previous[ordinal];
    if (!source) continue;
    // A determinative "that" is not an input reference in "remember that ...".
    if (tool === 'remember' && found[0] === 'that' && /^remember\s+$/u.test(actionHead(view.text.slice(0, found.index)))) continue;
    if (tool === 'read' && planReadTarget(text)) continue;
    references.push({ stepId: source.id, kind: referenceKind(tool, found[0], source),
      start: view.starts[found.index]!, end: view.ends[found.index + found[0].length - 1]! });
  }
  if (existing && !SUBJECT_NUMBER.some(pattern => pattern.test(matchText(existing.phrase)))) {
    const overlapping = references.find(reference => reference.start! < existing.end && reference.end! > existing.start);
    if (!overlapping) references.push({ stepId: latest.id, kind: 'number', start: existing.start, end: existing.end });
    else Object.assign(overlapping, { start: existing.start, end: existing.end });
    references.sort((left, right) => left.start! - right.start!);
  }
  if (references.length) return references;
  if (tool === 'compute' && purchaseOnPrice(text, latest)) return [{ stepId: latest.id, kind: 'number' }];
  if (tool === 'read' && latest.tool === 'search' && !planReadTarget(text) && READ_ON_PREVIOUS.test(actionHead(text))) {
    return [{ stepId: latest.id, kind: 'entity' }];
  }
  return [];
}

function valueMatches(reference: PlanReference, value: PlanValue): boolean {
  if (value.type === 'number' && !Number.isFinite(value.value)) return false;
  if (reference.kind === 'value') return true;
  // Document and letter adapters receive data directly and can embed scalars.
  if (reference.kind === 'text') return value.type !== 'file';
  return reference.kind === value.type;
}

const ENTITY_OPERAND = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .’'&-]{0,119}$/u;
const ARABIC_CLITIC_VERB = /^(اضرب|اقسم|اجمع|اطرح)(?:ها|ه)$/u;
const ARABIC_PREPOSITION = /^(عن|من|ل)(?:هما|ها|ه)$/u;

function searchOperand(phrase: string, value: PlanValue): string | null {
  if (value.type === 'number') return String(value.value);
  if (value.type !== 'entity' || !ENTITY_OPERAND.test(value.value)) return null;
  if (/^its$/iu.test(phrase)) return `${value.value}'s`;
  const preposition = ARABIC_PREPOSITION.exec(matchText(phrase))?.[1];
  return preposition ? `${preposition} ${value.value}` : value.value;
}

/** Only scalar operands are substituted into command syntax. Other outputs stay structured data. */
export function resolveStepInputs(step: PlanStep, values: ReadonlyMap<string, PlanValue>): ResolvedStepInputs | null {
  let text = step.inputs.text;
  const refs: ResolvedStepInputs['references'] = [];
  for (const reference of step.inputs.references) {
    const value = values.get(reference.stepId);
    if (!value || !valueMatches(reference, value)) return null;
    refs.push({ reference, value });
  }
  for (const { reference, value } of refs.toReversed()) {
    const { start, end } = reference;
    if (start === undefined || end === undefined) continue;
    if (step.tool === 'compute' && value.type === 'number') {
      const original = computationReference(clauseMatchingText(step.inputs.text));
      const operand = String(value.value);
      const prefix = ARABIC_CLITIC_VERB.exec(matchText(step.inputs.text.slice(start, end)))?.[1];
      const replacement = original && original.start === start && original.end === end
        ? original.replaceWith(operand) : prefix ? `${prefix} ${operand}` : operand;
      text = text.slice(0, start) + replacement + text.slice(end);
    } else if (step.tool === 'search') {
      const replacement = searchOperand(step.inputs.text.slice(start, end), value);
      if (replacement === null) return null;
      text = text.slice(0, start) + replacement + text.slice(end);
    }
  }
  return { text, references: refs };
}
