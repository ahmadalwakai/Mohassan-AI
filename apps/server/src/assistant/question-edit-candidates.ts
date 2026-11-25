import type { QuestionHistory } from './question-rewriter.js';

type Source = 'article' | 'section' | 'answer' | 'question';
type Operation = 'keep' | 'trim' | 'reference' | 'possessor' | 'subject' | 'append' | 'expand' | 'ellipsis';
type Span = { text: string; source: Source; distance: number; boundary: 'whole' | 'name' | 'fragment' | 'quote'; words: number; startsLine: boolean };
type Edit = { operation: Operation; span?: Span; reference?: string; left?: string; right?: string; count?: number; binding?: string };
export type QuestionEditCandidate = { text: string; features: Uint16Array };

export const QUESTION_EDIT_DIMENSIONS = 16384;
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[-'’][\p{L}\p{M}\p{N}]+)*/gu;
const NAMED_SPAN = /\p{Lu}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\p{M}\d]+)*(?:\s+(?:(?:of|the|de|del|van|von|bin|al|and)\s+)?\p{Lu}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\p{M}\d]+)*)*/gu;
const REFERENCE = /\b(?:he|him|his|she|her|hers|it|its|they|them|their|theirs|this|that|these|those|there)\b/giu;
const SUBJECTIVE = /^(?:he|she|it|they|this|that|these|those)$/u;
const DEMONSTRATIVE = /^(?:this|that|these|those)$/u;
const POSSESSIVE = /^(?:his|hers|its|their|theirs)$/u;
const NON_NAME = /^(?:a|an|the|i|we|you|yes|no|he|she|it|they|some|there|this|that|these|those|his|her|its|their|in|on|at|during|after|before|to|from|for|with|and|but|if|by|when|what|where|which|why|who|whom|whose|how|is|are|was|were|do|does|did|has|have|had|will|would|can|could|may|might|should|must|tell|please)$/iu;
const GENERIC_SECTION = /^(?:background|beginnings|biography|career|early (?:years|life)|history|later (?:years|life)|legacy|overview|personal life|reception|see also)$/iu;
const AUXILIARY = /^(?:is|are|was|were|do|does|did|has|have|had|can|could|shall|should|may|might|must|will|would)$/u;
const PREPOSITION = /^(?:to|from|with|about|at|of|in|by|for|on|after|before|during|and|or)$/u;
const NON_ENTITY = /^(?:cannotanswer|unknown|yes|no|none|no answer|not available)$/iu;
const PUNCTUATION = /[?!.؟…]+$/u;
const CONJUNCTION = /^(?:and|but|so|also|then)(?:,\s*|\s+)/iu;
const PRONOUN_LEAD = /^(?:he|she|it|they|his|her|its|their|them|him|this|that|there)\b/iu;
const QUESTION_LEAD = /^(?:what|which|who|whom|whose|when|where|why|how)\b/iu;
const MAX_CANDIDATES = 320;

function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

function cleanSpan(value: string): string {
  return value.trim().replace(/^[“"‘'\s]+|[”"’'\s,;:!?]+$/gu, '');
}

function caseStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function possessive(text: string, apostropheOnly = false): string {
  return /['’]s$/iu.test(text) ? text : text + (apostropheOnly ? "'" : "'s");
}

function isPossessiveReference(reference: string, right: string): boolean {
  return POSSESSIVE.test(reference) || reference === 'her' && right !== '-' && !PREPOSITION.test(right);
}

function historySpans(history: QuestionHistory): Span[] {
  const spans = new Map<string, Span>();
  function add(value: string, source: Source, distance: number, boundary: Span['boundary'], startsLine = false) {
    const text = cleanSpan(value);
    const tokens = words(text);
    if (!tokens.length || tokens.length > 12 || text.length > 105 || /[\r\n?؟;:]/u.test(text)
      || NON_ENTITY.test(text) || tokens.every(token => NON_NAME.test(token))) return;
    const key = text.toLowerCase();
    if (!spans.has(key)) spans.set(key, { text, source, distance, boundary, words: tokens.length, startsLine });
  }
  function addNames(value: string, source: Source, distance: number) {
    const normalized = value.slice(0, 500);
    for (const match of normalized.matchAll(NAMED_SPAN)) {
      const parts = match[0].split(/\s+/u);
      while (parts.length && NON_NAME.test(parts[0])) parts.shift();
      const name = parts.join(' ').replace(/['’]s$/iu, '');
      add(name, source, distance, 'name', match.index < 5);
      if (parts.length > 2 && distance < 2 && !parts.some(part => /^(?:of|and|the|van)$/iu.test(part))) {
        add(parts.slice(-2).join(' '), source, distance, 'fragment');
      }
    }
    for (const match of normalized.matchAll(/["“]([^"”\r\n]{2,90})["”]/gu)) add(match[1], source, distance, 'quote');
  }
  const article = history.articleTitle?.slice(0, 160).trim() ?? '';
  const shortArticle = article.replace(/\s+\([^()]+\)$/u, '');
  add(shortArticle, 'article', 0, 'whole');
  if (article !== shortArticle) add(article, 'article', 0, 'whole');
  const articleWords = shortArticle.split(/\s+/u);
  if (articleWords.length >= 2 && articleWords.length <= 4 && articleWords.every(word => /^\p{Lu}[\p{L}'’-]+$/u.test(word))) {
    add(articleWords.at(-1)!, 'article', 0, 'fragment');
    add(articleWords[0], 'article', 0, 'fragment');
  }
  const section = history.sectionTitle?.slice(0, 160).trim() ?? '';
  add(section, 'section', 0, 'whole');
  addNames(section, 'section', 0);

  for (const [distance, turn] of history.turns.slice(-5).toReversed().entries()) {
    const question = turn.question.slice(0, 500);
    const answer = turn.answer?.slice(0, 500).trim() ?? '';
    if (distance <= 1) {
      const firstClause = answer.replace(PUNCTUATION, '').split(/[,;]|\.(?=\s)/u, 1)[0];
      if (!PRONOUN_LEAD.test(firstClause)) add(firstClause, 'answer', distance, 'whole', true);
      const nounPhrase = /^(?:the|a|an|his|her|their)\s+[\p{L}\p{M}][\p{L}\p{M}-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}-]*){0,2}/iu.exec(firstClause)?.[0];
      if (nounPhrase) add(nounPhrase, 'answer', distance, 'fragment', true);
      for (const match of question.matchAll(/\b(?:the|a|an|their|her|his)\s+[a-z][a-z-]*(?:\s+[a-z][a-z-]*)?\b/giu)) {
        if (!words(match[0]).slice(1).some(token => AUXILIARY.test(token) || PREPOSITION.test(token))) {
          add(match[0], 'question', distance, 'fragment');
        }
      }
    }
    addNames(question, 'question', distance);
    addNames(answer, 'answer', distance);
  }
  return Array.from(spans.values()).slice(0, 27);
}

function family(reference: string): string {
  if (/^(?:he|him|his)$/u.test(reference)) return 'male';
  if (/^(?:she|her|hers)$/u.test(reference)) return 'female';
  if (/^(?:they|them|their|theirs|these|those)$/u.test(reference)) return 'plural';
  if (DEMONSTRATIVE.test(reference)) return 'demonstrative';
  return reference === 'there' ? 'location' : 'neuter';
}

function hashFeature(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash ^ (hash >>> 16)) & (QUESTION_EDIT_DIMENSIONS - 1);
}

type FeatureContext = {
  head: string; auxiliary: string; pronounCount: number; questionLength: number; historyLength: number;
  lead: string; endsWithPreposition: boolean; questionWords: Set<string>; previousWords: Set<string>;
  priorHead: string; afterHead: string; sectionGeneric: boolean;
};

function featureIds(edit: Edit, context: FeatureContext): Uint16Array {
  const operation = edit.operation;
  const span = edit.span;
  const antecedentSource = span ? `${span.source}:${span.boundary}` : 'none';
  const reference = edit.reference ?? '-';
  const group = family(reference);
  const left = edit.left || '-';
  const right = edit.right || '-';
  const binding = edit.binding || '-';
  const feature = [
    `op:${operation}`,
    `op:head:${operation}:${context.head}`,
    `op:aux:${operation}:${context.auxiliary}`,
    `op:lead:${operation}:${context.lead}`,
    `op:length:${operation}:${context.questionLength}`,
    `op:history:${operation}:${context.historyLength}`,
    `op:pronouns:${operation}:${context.pronounCount}`,
    `op:head:pronouns:${operation}:${context.head}:${context.pronounCount}`,
    `op:lead:head:${operation}:${context.lead}:${context.head}`,
    `op:head-next:${operation}:${context.head}:${context.afterHead}`,
    `op:ending:${operation}:${context.endsWithPreposition}`,
    `op:binding:${operation}:${binding}`,
    `op:binding:head:${operation}:${binding}:${context.head}`,
    `op:binding:aux:${operation}:${binding}:${context.auxiliary}`,
  ];
  if (span) {
    const spanWords = words(span.text);
    const determiner = /^(?:a|an|the|his|her|their|its|some)\b/iu.test(span.text);
    const kind = /^\p{Lu}/u.test(span.text) ? 'named' : /^\p{N}/u.test(span.text) ? 'numeric' : determiner ? 'determined' : 'lower';
    const looksPlural = /s\b/u.test(spanWords.at(-1) ?? '') || spanWords.includes('and');
    const overlap = Math.min(2, spanWords.filter(token => token.length > 2 && context.questionWords.has(token)).length);
    const previousOverlap = Math.min(2, spanWords.filter(token => token.length > 2 && context.previousWords.has(token)).length);
    feature.push(
      `source:${antecedentSource}`,
      `source:op:${antecedentSource}:${operation}`,
      `source:distance:${antecedentSource}:${Math.min(3, span.distance)}`,
      `source:kind:${antecedentSource}:${kind}`,
      `source:length:${antecedentSource}:${Math.min(5, span.words)}`,
      `source:head:${antecedentSource}:${context.head}`,
      `source:aux:${antecedentSource}:${context.auxiliary}`,
      `source:prior:${antecedentSource}:${context.priorHead}`,
      `source:starts:${antecedentSource}:${span.startsLine}`,
      `source:overlap:${antecedentSource}:${overlap}`,
      `source:previous-overlap:${antecedentSource}:${previousOverlap}`,
      `source:section-generic:${antecedentSource}:${context.sectionGeneric}`,
      `source:binding:${antecedentSource}:${binding}`,
      `source:reference:${antecedentSource}:${reference}`,
      `source:family:${antecedentSource}:${group}`,
      `source:agent:${antecedentSource}:${group}:${looksPlural}`,
      `source:recency:ref:${antecedentSource}:${span.distance}:${group}`,
      `source:shape:ref:${antecedentSource}:${kind}:${group}`,
      `edit:ref:${operation}:${reference}`,
      `edit:ref:left:${operation}:${reference}:${left}`,
      `edit:ref:right:${operation}:${reference}:${right}`,
      `edit:head-next:source:${operation}:${context.afterHead}:${span.source}`,
      `edit:ref:right:source:${reference}:${right}:${span.source}`,
      `edit:ref:left:source:${reference}:${left}:${span.source}`,
      `edit:ref:count:${reference}:${edit.count ?? 1}`,
      `edit:present:${operation}:${overlap}`,
    );
  }
  return Uint16Array.from(feature, hashFeature);
}

function neighboringWord(value: string, before: boolean): string {
  const word = words(value).at(before ? -1 : 0) ?? '-';
  return word.slice(0, 23);
}

function shapeWord(value: string | undefined): string {
  return value?.slice(0, 23) || '-';
}

function namedReplacement(raw: string, span: Span, offset: number): string {
  const text = span.text;
  return offset === 0 && /^\p{Lu}/u.test(raw) ? caseStart(text) : text;
}

function unquotedReferences(value: string): RegExpMatchArray[] {
  return Array.from(value.matchAll(REFERENCE)).filter(match => {
    const before = value.slice(0, match.index);
    const after = value.slice(match.index! + match[0].length);
    return !/^['’](?:s|re|ve|d|ll|m)\b/iu.test(after) && before.split(/["“”]/u).length % 2 === 1;
  });
}

function copyReferences(value: string, references: readonly RegExpMatchArray[], replacement: (match: RegExpMatchArray) => string): string {
  for (const match of references.toReversed()) {
    const at = match.index!;
    value = value.slice(0, at) + replacement(match) + value.slice(at + match[0].length);
  }
  return value;
}

export function questionEditCandidates(question: string, history: QuestionHistory): QuestionEditCandidate[] {
  const original = question.trim();
  const body = original.replace(PUNCTUATION, '').trim();
  if (!body || body.length > 360 || /[?؟\r\n]|\p{Script=Arabic}/u.test(body)) return [];
  const punctuation = /\?$/.test(original) ? '?' : original.slice(body.length) || '?';
  const lead = CONJUNCTION.exec(body)?.[0] ?? '';
  const core = body.slice(lead.length);
  const tokens = words(core);
  const pronouns = unquotedReferences(core);
  if (!core || (tokens.length > 46)) return [];
  const previous = history.turns.at(-1)?.question?.slice(0, 500).trim().replace(PUNCTUATION, '') ?? '';
  const previousTokens = words(previous);
  const context: FeatureContext = {
    head: QUESTION_LEAD.test(core) ? shapeWord(tokens[0]) : AUXILIARY.test(tokens[0] ?? '') ? 'auxiliary' : 'other',
    auxiliary: shapeWord(tokens.slice(0, 5).find(token => AUXILIARY.test(token))),
    pronounCount: Math.min(3, pronouns.length),
    questionLength: Math.min(5, Math.floor(tokens.length / 3)),
    historyLength: Math.min(3, history.turns.length),
    lead: lead.trim().replace(/,$/u, '').toLowerCase() || '-',
    endsWithPreposition: PREPOSITION.test(tokens.at(-1) ?? ''),
    questionWords: new Set(tokens),
    previousWords: new Set(previousTokens),
    priorHead: shapeWord(previousTokens[0]),
    afterHead: shapeWord(tokens[1]),
    sectionGeneric: GENERIC_SECTION.test(history.sectionTitle ?? ''),
  };
  const seen = new Set<string>();
  const options: QuestionEditCandidate[] = [];
  function add(text: string, edit: Edit) {
    text = text.trim();
    const key = text.normalize('NFC').replace(/\s+/gu, ' ').toLowerCase();
    if (!text || text.length > 480 || seen.has(key) || options.length >= MAX_CANDIDATES) return;
    seen.add(key);
    options.push({ text, features: featureIds(edit, context) });
  }
  function addEdit(text: string, edit: Edit) {
    add(caseStart(text) + punctuation, edit);
    if (lead) add(lead + text + punctuation, { ...edit, binding: `${edit.binding ?? '-'}:lead` });
  }
  add(original, { operation: 'keep' });
  if (lead) addEdit(core, { operation: 'trim' });

  const spans = historySpans(history);
  for (const match of pronouns.slice(0, 3)) {
    const ref = match[0].toLowerCase();
    const at = match.index!;
    const before = core.slice(0, at);
    const after = core.slice(at + match[0].length);
    const left = neighboringWord(before, true);
    const right = neighboringWord(after, false);
    const role = AUXILIARY.test(left) && SUBJECTIVE.test(ref) ? 'subject' : PREPOSITION.test(left) ? 'preposition' : 'other';
    const related = match === pronouns[0] && !DEMONSTRATIVE.test(ref) && ref !== 'there'
      ? pronouns.filter(other => family(other[0].toLowerCase()) === family(ref)) : [];
    for (const span of spans) {
      const entity = namedReplacement(match[0], span, at);
      const isPossessive = isPossessiveReference(ref, right);
      const operation = isPossessive ? 'possessor' : 'reference';
      const replacement = isPossessive ? possessive(entity) : ref === 'there' && !PREPOSITION.test(left) ? `in ${entity}` : entity;
      const edit = { operation, span, reference: ref, left, right, binding: role } as const;
      addEdit(before + replacement + after, edit);
      if (isPossessive && /s$/iu.test(entity)) addEdit(before + possessive(entity, true) + after, { ...edit, binding: 'apostrophe' });
      if (ref === 'her' && isPossessive) addEdit(before + entity + after, { ...edit, operation: 'reference' });
      if (ref === 'there') addEdit(before + entity + after, edit);
      if (DEMONSTRATIVE.test(ref)) {
        const noun = /^\s+[a-z][a-z-]+/iu.exec(after)?.[0] ?? '';
        if (noun && !AUXILIARY.test(right) && !PREPOSITION.test(right)) {
          addEdit(before + entity + after.slice(noun.length), { ...edit, binding: 'replace-noun' });
          addEdit(before + `the${noun} ${entity}` + after.slice(noun.length), { ...edit, binding: 'name-noun' });
        }
      }
      if (related.length > 1) {
        const edited = copyReferences(core, related, other => {
          const referent = other[0].toLowerCase();
          const following = neighboringWord(core.slice(other.index! + other[0].length), false);
          return isPossessiveReference(referent, following) ? possessive(span.text) : span.text;
        });
        addEdit(edited, { ...edit, count: Math.min(3, related.length), binding: 'repeat' });
      }
    }
  }

  const auxiliary = /\b(?:is|are|was|were|do|does|did|has|have|had|can|could|shall|should|may|might|must|will|would)\b/iu.exec(core);
  const nominal = /^(?:what|which|whose|how (?:many|much))\s+(?:is|are|was|were)?\s*(?:the\s+)?/iu.exec(core);
  const property = /^(.*?\b(?:is|are|was|were)\s+)(?:the\s+)?(?=\p{L})/iu.exec(core);
  const clause = /^(?:why|how|where|when)$/iu.test(core) && !/[?؟\r\n]/u.test(previous)
    ? /^(?:and\s+|but\s+)?(?:why|how|where|when)\s+(.+)$/iu.exec(previous)?.[1] : undefined;
  const clauseReferences = clause ? unquotedReferences(clause) : [];
  for (const span of spans.slice(0, pronouns.length ? 9 : 16)) {
    const { text } = span;
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(core)) continue;
    if (auxiliary && auxiliary.index <= 42 && !pronouns.length) {
      const slot = auxiliary.index + auxiliary[0].length;
      if (words(core.slice(slot)).length) addEdit(core.slice(0, slot) + ' ' + text + core.slice(slot), { operation: 'subject', span });
    }
    if (nominal && !pronouns.length) {
      addEdit(core.slice(0, nominal[0].length) + possessive(text) + ' ' + core.slice(nominal[0].length), { operation: 'possessor', span, binding: 'insert' });
    }
    if (property && /\bthe\s+/iu.test(core.slice(property[1].length, property[1].length + 5))) {
      addEdit(property[1] + possessive(text) + ' ' + core.slice(property[1].length).replace(/^the\s+/iu, ''), { operation: 'possessor', span, binding: 'replace-determiner' });
    }
    for (const preposition of ['', 'about', 'of', 'in', 'for', 'by', 'with', 'after', 'during']) {
      if (context.endsWithPreposition !== !preposition) continue;
      addEdit([core, preposition, text].filter(Boolean).join(' '), { operation: 'append', span, binding: preposition || 'existing' });
    }
    if (span.boundary === 'whole' && span.words > 1) {
      const names = span.text.split(/\s+/u).filter(word => /^\p{Lu}\p{L}+/u.test(word));
      for (const name of names) {
        const shorter = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu');
        if (shorter.test(core)) addEdit(core.replace(shorter, text), { operation: 'expand', span });
      }
    }
    if (clause) {
      const restored = copyReferences(clause, clauseReferences, match => {
        const following = neighboringWord(clause.slice(match.index! + match[0].length), false);
        return isPossessiveReference(match[0].toLowerCase(), following) ? possessive(text) : text;
      });
      addEdit(`${core} ${restored}`, { operation: 'ellipsis', span, binding: 'prior-clause' });
    }
  }
  return options;
}
