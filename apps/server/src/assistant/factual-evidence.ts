import { publicSearchScan, publicSearchText, type AgentPage } from '@mohassan/browser';
import { normalizeAnswerDigits } from './answer-check.js';
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

export type ExplicitFactualEvidence = { kind: 'answer'; quote: string } | { kind: 'unanswered' };

/** Read a labeled Q&A record (for example a public FAQ). Match the entire question and preserve the answer's surface form. */
export function explicitFactualEvidence(page: Pick<AgentPage, 'text' | 'documentStatus' | 'signals'>, question: string): ExplicitFactualEvidence | undefined {
  if (page.documentStatus != null && (page.documentStatus < 200 || page.documentStatus >= 300)) return;
  if (page.signals.captcha || page.signals.password || page.signals.otp || page.signals.card) return;
  const wanted = questionKey(question);
  if (!wanted || wanted.length > maxRecordLength) return;

  const labels = [...page.text.matchAll(recordLabel)];
  const records = new Map<string, string>();
  let matched = false;
  for (const [index, label] of labels.entries()) {
    const answerLabel = labels[index + 1];
    if (!label[1] || !answerLabel || answerLabel[1]) continue;
    const ask = page.text.slice(label.index + label[0].length, answerLabel.index).trim().replace(/[\s|]+$/u, '');
    if (questionKey(ask) !== wanted) continue;
    matched = true;

    const answerStart = answerLabel.index + answerLabel[0].length;
    const rest = page.text.slice(answerStart, labels[index + 2]?.index).trimStart();
    const value = rest.split(/\r?\n/u, 1)[0].trim().replace(/[\s|]+$/u, '');
    const quote = `${page.text.slice(label.index, answerStart).trimEnd()} ${value}`.replace(/\s+/gu, ' ');
    if (quote.length > maxRecordLength || !safeAnswer(value)) return { kind: 'unanswered' };
    if (numericQuestion.test(question) && !/\p{Nd}/u.test(value) && !yearQuestion.test(question)) return { kind: 'unanswered' };
    records.set(matchText(value), quote);
  }
  if (!matched) return;
  const [quote] = records.values();
  if (records.size !== 1 || !quote) return { kind: 'unanswered' };
  return { kind: 'answer', quote };
}
