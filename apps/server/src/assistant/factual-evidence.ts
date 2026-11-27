import { publicSearchScan, publicSearchText, type AgentPage } from '@mohassan/browser';
import { isDisambiguationPage, isMetaLine, normalizeAnswerDigits } from './answer-check.js';
import { extractEnglishQuantity } from './factual-quantity.js';
import { isPageInstruction } from './mind/extract.js';

const recordLabel = /(?<![\p{L}\p{N}_])(?:(question|q|(?:ال)?س[ؤو]ال|س)|answer|a|(?:ال)?[إأا]جاب[ةه]|(?:ال)?جواب|ج)\s*[:：]/giu;
const answerMissing = /^(?:[-–—]+|n\/?a|unknown|not (?:available|known|provided|specified)|no (?:answer|information)|(?:غير (?:متاح|معروف|مذكور|محدد)|لا (?:أعرف|يوجد جواب|توجد إجابة)))[.!؟?]*$/iu;
const numericQuestion = /(?<!\p{L})(?:كم|متى|متي)(?!\p{L})|\b(?:when|what year|how (?:many|much|long|old|far|tall|big))\b/iu;
const yearQuestion = /(?<!\p{L})(?:في أي (?:عام|سنة)|متى|متي)(?!\p{L})|\b(?:when|what year)\b/iu;
const maxRecordLength = 1_500;

function matchText(text: string): string {
  return normalizeAnswerDigits(text.normalize('NFKD')).toLowerCase().replace(/[ـ\p{M}\p{Cf}]/gu, '')
    .replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/[’‘]/gu, "'").replace(/[“”]/gu, '"')
    .replace(/٫/gu, '.').replace(/٬/gu, ',').replace(/\s+/gu, ' ').trim();
}

function questionKey(text: string): string {
  return matchText(text).replace(/[\s.!?؟]+$/u, '');
}

function safeAnswer(value: string): boolean {
  const scanned = publicSearchScan(value);
  return /[\p{L}\p{N}]/u.test(value) && !answerMissing.test(value) && !/[<>`]|https?:\/\/|\]\(/iu.test(scanned)
    && publicSearchText(scanned) === scanned
    && !scanned.split(/(?<=[.!?؟])\s+/u).some(isPageInstruction);
}

type EvidencePage = Pick<AgentPage, 'text' | 'documentStatus' | 'signals'>;

function availablePage(page: EvidencePage): boolean {
  return (page.documentStatus == null || page.documentStatus >= 200 && page.documentStatus < 300)
    && !page.signals.captcha && !page.signals.password && !page.signals.otp && !page.signals.card;
}

export type ExplicitFactualEvidence = { kind: 'answer'; quote: string } | { kind: 'unanswered' };

/** Read a labeled Q&A record (for example a public FAQ). Match the entire question and preserve the answer's surface form. */
export function explicitFactualEvidence(page: EvidencePage, question: string): ExplicitFactualEvidence | undefined {
  if (!availablePage(page)) return;
  const record = explicitFactualRecord(page.text, question);
  return record?.kind === 'answer' ? { kind: 'answer', quote: record.quote } : record;
}

type FactualRecord = (Extract<ExplicitFactualEvidence, { kind: 'answer' }> & { value: string })
  | Extract<ExplicitFactualEvidence, { kind: 'unanswered' }>;

/** Extract a record from text the caller already obtained as read-time evidence. */
export function explicitFactualRecord(text: string, question: string): FactualRecord | undefined {
  const wanted = questionKey(question);
  if (!wanted || wanted.length > maxRecordLength) return;

  const labels = [...text.matchAll(recordLabel)];
  const records = new Map<string, { quote: string; value: string }>();
  let matched = false;
  for (const [index, label] of labels.entries()) {
    const answerLabel = labels[index + 1];
    if (!label[1] || !answerLabel || answerLabel[1]) continue;
    const ask = text.slice(label.index + label[0].length, answerLabel.index).trim().replace(/[\s|]+$/u, '');
    if (questionKey(ask) !== wanted) continue;
    matched = true;

    const answerStart = answerLabel.index + answerLabel[0].length;
    const rest = text.slice(answerStart, labels[index + 2]?.index).trimStart();
    const value = rest.split(/\r?\n/u, 1)[0].trim().replace(/[\s|]+$/u, '');
    const quote = `${text.slice(label.index, answerStart).trimEnd()} ${value}`.replace(/\s+/gu, ' ');
    if (quote.length > maxRecordLength || !safeAnswer(value)) return { kind: 'unanswered' };
    if (numericQuestion.test(question) && !/\p{Nd}/u.test(value) && !yearQuestion.test(question)) return { kind: 'unanswered' };
    records.set(matchText(value), { quote, value });
  }
  if (!matched) return;
  const [record] = records.values();
  if (records.size !== 1 || !record) return { kind: 'unanswered' };
  return { kind: 'answer', ...record };
}

export interface FactualPassage { value: string; quote: string }

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const incompleteSentence = /(?:^|\s)(?:[A-Z]|Dr|Prof|Mr|Mrs|Ms|St|Maj|Gen|Lt|Col|Inc|Ltd|Corp|c|ca)\.$/u;
const leadingReference = /^(?:\s*\[\s*(?:\d+|note \d+)\s*\])+\s*/iu;
const uncertainClaim = /\b(?:might|could|would|not|never|hypothetical|disputed)\b/iu;
const articleType = /^(?:it|the (?:company|firm|business|organization|organisation|institution|club|team|town|city|village|settlement|university|school|museum|building|bridge|railway|ship|station|fort|castle))\b/iu;

function passageSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const { segment } of sentenceSegmenter.segment(text.slice(0, 50_000))) {
    const line = segment.trim().replace(leadingReference, '').replace(/\s+/gu, ' ');
    if (!line) continue;
    const previous = sentences.at(-1);
    if (previous && incompleteSentence.test(previous)) sentences[sentences.length - 1] = `${previous} ${line}`;
    else sentences.push(line);
  }
  return sentences;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const withoutArticle = (text: string): string => text.trim().replace(/^the\s+/iu, '');
const phrase = (text: string): string => escape(withoutArticle(text)).replace(/['’]/gu, "['’]").replace(/\s+/gu, '\\s+');
const leadSubject = (subject: string): RegExp => new RegExp(`^(?:the\\s+)?${phrase(subject)}(?![\\p{L}\\p{N}’'-])`, 'iu');
const namedIn = (subject: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${phrase(subject)}(?![\\p{L}\\p{N}’'-])`, 'iu');
const plainArticleTitle = (title: string) => title.replace(/\s+[-–—|]\s+[^-–—|]{1,40}$/u, '').replace(/\s+\([^()]*\)$/u, '').trim();

const month = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const era = '(?:BCE|BC|CE|AD)';
const year = `(?:${era}\\s*\\d{1,4}|\\d{1,4}\\s*${era}|\\d{3,4}(?:s)?)`;
const century = '(?:(?:\\d{1,2}(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|[a-z]+teenth|twentieth|twenty-first))\\s+century';
const date = `(?:\\d{1,2}(?:st|nd|rd|th)?\\s+${month}\\s+\\d{1,4}(?:\\s*${era})?|${month}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{1,4}(?:\\s*${era})?|${month}\\s+\\d{3,4}|${century}|${year})`;
const datePair = new RegExp(`\\(\\s*(?:[^()]{1,80};\\s*)?(?<range>(?<start>${date})\\s*[–—]\\s*(?<end>${date}))\\s*\\)`, 'iu');
const suppliedDate = new RegExp(`\\b(?:in|on|during|since|from|around|about|circa)\\s+(?:the\\s+)?(?<date>${date})(?![\\p{L}\\p{N}]|[.,]\\d)`, 'iu');
const dateBeforeClause = new RegExp(`^(?:in|on|during|around|about|circa)\\s+(?:the\\s+)?(?<date>${date})\\s*,?\\s+`, 'iu');
const predicatePreamble = /^(?:\s*\([^()]*\)|\s*\[\d+\]|[\s,]|\b(?:was|were|is|are|had been|has been|have been|first|officially|originally)\b)*$/iu;
const contextualIntro = /^\s*(?:\p{Lu}\p{L}*[, ]+){0,3}(?:\([^()]*\)\s*)?(?:(?:Inc|Ltd|Corp)\.?,?\s+)?(?:is|was)\s+(?:a|an|the)\b/u;

const dateEvents = [
  { ask: /\s+(?:be born|born)$/iu, claim: /\b(?:was|were|is)\s+born\b/iu, biography: 'start' },
  { ask: /\s+(?:die|died|pass away)$/iu, claim: /\b(?:died|passed away)\b/iu, biography: 'end' },
  { ask: /\s+(?:live|alive)$/iu, claim: null, biography: 'range' },
  { ask: /\s+(?:be\s+)?(?:found|founded|establish|established|incorporate|incorporated)$/iu, claim: /\b(?:founded|established|incorporated)\b/iu },
  { ask: /\s+(?:be\s+)?(?:construct|constructed|build|built)$/iu, claim: /\b(?:constructed|built)\b/iu },
  { ask: /\s+(?:be\s+)?(?:open|opened|inaugurate|inaugurated)$/iu, claim: /\b(?:opened|inaugurated)\b/iu },
  { ask: /\s+(?:be\s+)?(?:begin|began|start|started|commence|commenced|originate|originated)$/iu, claim: /\b(?:began|commenced|started|originated)\b/iu },
  { ask: /\s+(?:be\s+)?(?:release|released|publish|published|premiere|premiered)$/iu, claim: /\b(?:released|published|premiered)\b/iu },
] as const;

function dateRelations(question: string): ((line: string, previous: string, title: string) => FactualPassage | undefined) | undefined {
  const request = /^(?:when|(?:on |in )?what (?:date|day|year))\s+(?:did|does|was|were|is|are)\s+(.+)$/iu.exec(question)?.[1];
  if (!request) return;
  const event = dateEvents.find(({ ask }) => ask.test(request));
  if (!event) return;
  const subject = request.replace(event.ask, '').replace(/\s+(?:first|originally)$/iu, '').trim();
  if (!subject || /^[\p{L}]{1,2}$/u.test(subject)) return;
  const begins = leadSubject(subject);
  return (line, previous, title) => {
    const named = begins.exec(line);
    if (named && 'biography' in event) {
      const pair = datePair.exec(line);
      const prefix = pair?.index != null ? line.slice(0, pair.index) : '';
      // A name followed by a lifetime range and a biographical copula.
      if (pair && !/\b(?:is|was|are|were)\b/iu.test(prefix) && /^(?:\s*\[\d+\])*\s*[, ]*\s*(?:(?:alternatively|also)\s+\p{L}+|was|is|were)\b/iu.test(line.slice(pair.index + pair[0].length))) {
        const value = pair.groups?.[event.biography];
        if (value) return { value, quote: line };
      }
    }
    if (!event.claim) return;
    const claim = event.claim.exec(line);
    if (!claim || uncertainClaim.test(line.slice(0, claim.index))) return;
    const before = line.slice(0, claim.index);
    const after = line.slice(claim.index + claim[0].length);
    const titleNamesSubject = matchText(withoutArticle(plainArticleTitle(title))) === matchText(withoutArticle(subject));
    const previousName = begins.exec(previous);
    const anaphor = articleType.exec(before);
    const adjacent = titleNamesSubject && previousName && contextualIntro.test(previous.slice(previousName[0].length))
      && (anaphor ? predicatePreamble.test(before.slice(anaphor[0].length)) : !before.trim());
    const inFront = dateBeforeClause.exec(before);
    const frontSubject = inFront && begins.exec(before.slice(inFront[0].length));
    const dateBeforeSubject = frontSubject && predicatePreamble.test(before.slice(inFront![0].length + frontSubject[0].length));
    const direct = named && predicatePreamble.test(before.slice(named[0].length));
    if (!direct && !adjacent && !dateBeforeSubject) return;
    // The date after the predicate must belong to its clause. Preserve the earlier
    // source sentence when the passage names the subject by a pronoun.
    const dateClause = after.split(/\s*(?:;|\b(?:and|but|although|whereas|before|after|that|which|who)\b)\s*/iu, 1)[0]!;
    const value = dateBeforeSubject ? inFront?.groups?.date : suppliedDate.exec(dateClause)?.groups?.date;
    if (!value) return;
    return { value, quote: adjacent ? `${previous} ${line}` : line };
  };
}

function namedRelation(question: string): ((line: string) => FactualPassage | undefined) | undefined {
  const place = /^where\s+(?:was|is|are|were)\s+(.+?)(?:\s+(?:located|situated|based))?$/iu.exec(question)?.[1];
  const material = /^what\s+(?:is|are|was|were)\s+(.+?)\s+(?:made|composed|constructed)\s+of$/iu.exec(question)?.[1];
  const alias = /^(?:what(?: else)?\s+(?:is|are|was|were)\s+(.+?)\s+(?:also\s+)?(?:called|known as)|what is another name for\s+(.+))$/iu.exec(question);
  const types = /^what\s+are\s+(?:the\s+)?(?:types|kinds|forms|categories)\s+of\s+(.+)$/iu.exec(question)?.[1];
  const role = /^who\s+(?:is|was|are|were)\s+(?:the\s+)?([\p{L} -]{2,45}?)\s+(?:of|for|at)\s+(.+)$/iu.exec(question);
  const subject = material ?? place ?? alias?.[1] ?? alias?.[2];
  const named = subject ? leadSubject(subject) : undefined;
  const clause = material ? /^\s*(?:\([^()]*\)\s*)?(?:(?:is|are|was|were)\s+(?:(?:primarily|mainly|mostly|largely)\s+)?(?:made|composed|constructed)\s+(?:of|from)|consists?\s+of)\s+/iu
    : alias ? /^\s*[, (]*\s*(?:(?:is|are|was|were)\s+)?(?:also|alternatively|commonly|locally|formerly)\s+(?:known|called)(?:\s+as)?\s+/iu
    : /^\s*(?:(?:\((?:[^()]|\([^()]*\))*\)|\[\d+\]|,)\s*)*(?:is|are|was|were)\s+(?:(?:located|situated|based)\s+in|(?:a|an|the)\s+(?:(?:capital(?: city)?|county seat|largest city)\s+of|(?:city|town|village|island|mountain)\s+in))\s+(?:the\s+)?/iu;
  if (named) return line => {
    const start = named.exec(line);
    if (!start || uncertainClaim.test(line)) return;
    const tail = line.slice(start[0].length);
    const relation = clause.exec(tail);
    if (!relation) return;
    const after = tail.slice(relation.index + relation[0].length);
    const value = (alias ? /^(?:["“]([^"”]+)["”]|([^,().;]{1,100}?)(?=\s+(?:is|was|refers)\s|[,().;]|$))/iu.exec(after)?.slice(1).find(Boolean)
      : after.split(/(?:[.;]|,?\s+and (?:the [\p{L}]+(?:-\p{L}+)?|is|are|was|were)\b)/iu, 1)[0])?.trim();
    if (value && value.length <= 180) return { value, quote: line };
  };
  if (types) {
    const list = new RegExp(`\\b(?:types|kinds|forms|categories|states)\\s+of\\s+${phrase(types)}\\b[^:;.!?]{0,75}:\\s*(?<value>[^.!?;]+)`, 'iu');
    return line => {
      const value = list.exec(line)?.groups?.value?.trim();
      if (value && /,|\band\b/iu.test(value)) return { value, quote: line };
    };
  }
  if (role) {
    const relation = new RegExp(`\\b(?:is|was|served as|serves as)\\s+(?:the\\s+)?${phrase(role[1]!)}\\s+(?:of|for|at)\\s+(?:the\\s+)?${phrase(role[2]!)}(?![\\p{L}’'-])`, 'iu');
    const person = /^[\p{Lu}][\p{L}\p{M}’'-]*(?:(?: +(?:de|del|van|von|da|di|of))? +(?:\p{Lu}\.|\p{Lu}[\p{L}\p{M}’'-]*)){1,7}/u;
    const apposition = /^\s*[, ]*(?:\([^()]{1,130}\)\s*[, ]*)*(?:(?:is|was)\s+(?:an?|the)\s+[\p{L}\p{M} -]{1,85}\s+who\s+)?$/iu;
    const target = namedIn(role[2]!);
    return line => {
      const relationship = relation.exec(line);
      const value = person.exec(line)?.[0];
      if (value && relationship && !target.test(value) && apposition.test(line.slice(value.length, relationship.index))) return { value, quote: line };
    };
  }
  return;
}

/** Extract a source span only when the passage directly states the requested relation. */
export function factualPassage(page: Pick<AgentPage, 'title' | 'text'>, question: string): FactualPassage | undefined {
  if (/\p{Script=Arabic}/u.test(question) || isDisambiguationPage(page)) return;
  const asked = question.trim().replace(/[.!?]+$/u, '');
  const relation = dateRelations(asked) ?? namedRelation(asked);
  const quantity = /^how (?:many|long|tall|wide|deep|far|heavy|old)\b/iu.test(asked);
  if (!relation && !quantity) return;
  const candidates = new Map<string, FactualPassage>();
  const sentences = passageSentences(page.text);
  const subject = plainArticleTitle(page.title);
  const titled = subject ? leadSubject(subject) : null;
  for (const [index, sentence] of sentences.entries()) {
    if (sentence.length > 650 || isMetaLine(sentence) || /[?？]$/u.test(sentence)) continue;
    const previous = sentences[index - 1] ?? '';
    const titleInPrevious = titled?.exec(previous);
    const anchored = Boolean(titleInPrevious && contextualIntro.test(previous.slice(titleInPrevious[0].length)));
    const value = quantity ? extractEnglishQuantity(asked, sentence) : undefined;
    const contextualValue = quantity && !value && anchored
      ? extractEnglishQuantity(asked, sentence, { subject, subjectAnchored: true }) : undefined;
    const answer = relation?.(sentence, previous, page.title) ?? (value ? { value, quote: sentence }
      : contextualValue ? { value: contextualValue, quote: `${previous} ${sentence}` } : undefined);
    if (!answer || answer.quote.length > 850 || !safeAnswer(answer.quote) || !safeAnswer(answer.value)) continue;
    const key = matchText(answer.value);
    if (!candidates.has(key)) candidates.set(key, answer);
    if (candidates.size > 1) return;
  }
  return candidates.values().next().value;
}

export function formatFactualPassage({ value, quote }: FactualPassage): string {
  const start = quote.lastIndexOf(value);
  return start < 0 ? quote : `${quote.slice(0, start)}**${value}**${quote.slice(start + value.length)}`;
}

export function readFactualPassage(page: EvidencePage & Pick<AgentPage, 'title'>, question: string): FactualPassage | undefined {
  return availablePage(page) ? factualPassage(page, question) : undefined;
}
