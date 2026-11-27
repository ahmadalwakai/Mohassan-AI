import { questionLanguage } from '../answer-check.js';
import { coverageTokens, uncoveredParts } from './coverage.js';
import { comparable } from './language.js';
import {
  commitmentDisposition, extractClaims, normalizeReviewText,
  type Claim, type Commitment, type ConversationLedger, type Correction, type Preference, type RequestPart,
} from './ledger.js';
import { checkPreferences } from './preferences.js';

export const REVIEW_CHECKS = ['contradiction', 'coverage', 'commitments', 'corrections', 'preferences', 'repetition'] as const;
export type ReviewCheck = typeof REVIEW_CHECKS[number];
export interface ReviewFinding { check: ReviewCheck; code: string }
export interface ReviewResult { action: 'send' | 'fix' | 'note'; reply: string; findings: ReviewFinding[] }
export interface ReviewOptions {
  status?: string | null;
  evidence?: readonly { text: string }[];
  /** A host-owned transcript, quote, receipt, or prompt must keep its text verbatim. */
  preserveContent?: boolean;
}

const literalSource = /(?:```|^\s*>|^\s*(?:sources?|المصادر|المصدر)\s*:)/imu;
const evidenceDiscourse = /^(?:source|according to|as reported by|quote|correction|formerly|previously|earlier|المصدر|بحسب|وفقا|اقتباس|تصحيح|سابقا)(?!\p{L})/u;
const historicalLocator = /(?:^|\s)(?:previously|formerly|earlier|historically|last (?:year|month|week)|سابقا|سابقًا|من قبل|السابقه?|الماضيه?)(?=\s|$)/u;
const quoteRequest = /^(?:(?:please )?(?:quote|repeat|show) (?:me )?(?:your |the )?(?:previous|earlier|rejected|old) (?:answer|reply)|(?:اقتبس|كرر|اعرض) (?:الرد|الاجابه|الإجابة) (?:السابق|السابقه|السابقة|المرفوض))(?!\p{L})/u;
const reportRequested = /^(?:what (?:did|was)|remind me what|ما (?:قلت|ذكرت)|ماذا (?:قلت|ذكرت))(?!\p{L})/u;
const continuing = /^(?:(?:please )?(?:continue(?: with that)?|go on|finish (?:that|it)|any updates?|what(?: is| s) (?:left|still open))|(?:تابع|اكمل|واصل|ما المتبقي|ما الذي بقي))(?:\s+please)?$/u;

function comparableValue(value: string): string {
  return comparable(value.trim()).replace(/(?<=\d),(?=\d{3}(?:\D|$))/gu, '')
    .replace(/(?<=\d)\.0+(?=\D|$)/gu, '').replace(/\s+/gu, ' ');
}

function sameValue(left: string, right: string): boolean {
  return comparableValue(left) === comparableValue(right);
}

function sameClaim(left: Claim, right: Claim): boolean {
  return left.subject === right.subject && sameValue(left.value, right.value);
}

const countedItems = /(?:^|\s)(?:count|number of|عدد|تعداد)(?=\s|$)/u;
const physicalUnit = /^(?:[$€£¥%]|km|mi|m|cm|mm|kg|lb|lbs|ft|mph|kph|km\/h|m\/s|ms|s|h|hz|usd|eur|gbp|meter|meters|seconds?|minutes?|hours?|kilometers?|kilometres?|miles?|متر|امتار|كيلومتر|كيلومترات|كيلوغرام|كم|كغ|ريال|دولار|يورو|درجه)$/u;

function claimRank(left: Claim, right: Claim): boolean {
  if (left.subject !== right.subject || left.kind !== right.kind) return false;
  if (left.kind !== 'number') return true;
  // Different units can express the same quantity. Match their spelling,
  // without guessing a conversion or flagging a change in reporting units.
  const units = (claim: Claim) => comparableValue(claim.value).replace(/^([\p{Sc}]?)[+\-\d.,]+\s*/u, '$1');
  const leftUnits = units(left), rightUnits = units(right);
  return leftUnits === rightUnits || countedItems.test(left.subject) && !physicalUnit.test(leftUnits) && !physicalUnit.test(rightUnits);
}

function getClaims(draft: string): Claim[] {
  const prose = draft.replace(/```[\s\S]*?(?:```|$)/gu, '');
  return extractClaims(prose).filter(claim => !evidenceDiscourse.test(normalizeReviewText(claim.text))
    && !historicalLocator.test(normalizeReviewText(claim.text)));
}

function contradictedClaims(ledger: ConversationLedger, claims: readonly Claim[], evidence: ReviewOptions['evidence']): Claim[] {
  if (!claims.length) return [];
  const latest = new Map<string, Claim>();
  for (const earlier of ledger.claims) latest.set(earlier.subject, earlier);
  let fromSource: Claim[] | undefined;
  return claims.filter(claim => {
    const earlier = latest.get(claim.subject) ?? ledger.archivedClaims?.forSubject(claim.subject).at(-1);
    if (!earlier || !claimRank(claim, earlier) || sameValue(earlier.value, claim.value)) return false;
    const userFact = ledger.userClaims.findLast(fact => fact.subject === claim.subject);
    if (userFact && userFact.messageIndex > earlier.messageIndex && sameClaim(userFact, claim)) return false;
    if (ledger.corrections.some(correction => correction.messageIndex > earlier.messageIndex
      && correctionPair(correction)?.some(([before, after]) => sameValue(before, earlier.value) && sameValue(after, claim.value))
      && (getClaims(correction.answer ?? '').some(fact => sameClaim(fact, earlier))
        || getClaims(correction.after ?? '').some(fact => sameClaim(fact, claim))))) return false;
    fromSource ??= (evidence ?? []).flatMap(source => getClaims(source.text));
    return !fromSource.some(fact => sameClaim(fact, claim));
  });
}

function correctionPair(correction: Correction): [string, string][] | null {
  if (correction.before && correction.after) {
    const accepted = getClaims(correction.after);
    const rejected = getClaims(correction.before);
    if (accepted.length === 1 && rejected.length === 1 && accepted[0]!.subject === rejected[0]!.subject) {
      return [[rejected[0]!.value, accepted[0]!.value]];
    }
    if (accepted.length === 1 && !rejected.length) return [[correction.before, accepted[0]!.value]];
    return [[correction.before, correction.after]];
  }
  if (!correction.after || !correction.answer) return null;
  const accepted = getClaims(correction.after);
  const rejected = getClaims(correction.answer);
  const pairs = accepted.flatMap(after => rejected.filter(before => claimRank(before, after) && !sameValue(before.value, after.value))
    .map(before => [before.value, after.value] as [string, string]));
  return pairs.length ? pairs : null;
}

function findCorrections(ledger: ConversationLedger, claims: readonly Claim[], draft: string) {
  const fixes: { claim: Claim; value: string }[] = [];
  let unscoped = 0;
  const supersededSubjects = new Set<string>();
  const supersededOperands = new Set<string>();
  const draftWords = ` ${normalizeReviewText(draft)} `;
  for (const correction of ledger.corrections.toReversed()) {
    for (const [before, after] of correctionPair(correction) ?? []) {
      if (sameValue(before, after)) continue;
      const previous = getClaims(correction.answer ?? '').filter(claim => sameValue(claim.value, before));
      const explicitSubject = getClaims(correction.after ?? '').find(claim => sameValue(claim.value, after))?.subject;
      const prior = previous.filter(claim => (!explicitSubject || explicitSubject === claim.subject) && !supersededSubjects.has(claim.subject));
      if (previous.length && !prior.length) continue;
      if (new Set(prior.map(claim => claim.subject)).size > 1) {
        if (claims.some(claim => sameValue(claim.value, before) && prior.some(item => item.subject === claim.subject))) unscoped++;
        continue;
      }
      const laterFact = ledger.userClaims.findLast(claim => claim.messageIndex > correction.messageIndex
        && prior.some(item => item.subject === claim.subject));
      if (laterFact && sameValue(laterFact.value, before)) continue;
      for (const claim of prior) supersededSubjects.add(claim.subject);
      const bad = claims.filter(claim => sameValue(claim.value, before) && prior.some(item => item.subject === claim.subject));
      if (bad.length) {
        fixes.push(...bad.map(claim => ({ claim, value: after })));
        continue;
      }
      // A changed named operand can appear as the subject of an answer.
      // Avoid bare numbers or short pronouns, which may refer to something else.
      const wrongOperand = normalizeReviewText(before);
      const rightOperand = normalizeReviewText(after);
      if (!supersededOperands.has(wrongOperand) && /\p{L}{3}/u.test(wrongOperand) && !/\p{Nd}/u.test(wrongOperand)
        && draftWords.includes(` ${wrongOperand} `) && !draftWords.includes(` ${rightOperand} `)
        && (claims.some(claim => ` ${claim.subject} `.includes(` ${wrongOperand} `))
          || normalizeReviewText(correction.answer ?? '').includes(wrongOperand))) unscoped++;
      supersededOperands.add(wrongOperand);
      supersededOperands.add(rightOperand);
    }
  }
  return { fixes, unscoped };
}

function repairCorrection(draft: string, claim: Claim, value: string): string {
  if (!value || value.length > 120 || /[\r\n`<>\[\]{}]/u.test(value) || !/\p{L}|\p{N}/u.test(value)) return draft;
  const start = draft.indexOf(claim.text);
  const within = claim.text.lastIndexOf(claim.value);
  // One exact assertion and a literal signed/dated/named value. No replacement
  // on fuzzy spelling or on a substring of a different assertion.
  if (start < 0 || within < 0 || draft.indexOf(claim.text, start + claim.text.length) >= 0) return draft;
  const at = start + within;
  return draft.slice(0, at) + value + draft.slice(at + claim.value.length);
}

function repeatKey(reply: string): string {
  return comparable(reply).replace(/[^\p{L}\p{M}\p{N}+%-]|(?<!\d)[+-](?!\d)/gu, char => /[.,]/u.test(char) ? char : ' ')
    .replace(/(?<!\d)[.,]|[.,](?!\d)/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function repeatsRejection(ledger: ConversationLedger, draft: string, request: string): boolean {
  if (quoteRequest.test(normalizeReviewText(request))) return false;
  const withoutCourtesy = (reply: string) => repeatKey(reply).replace(/^(?:sure|of course|certainly|بالتاكيد|طبعا|حسنا|بالطبع)\s+/u, '');
  const normalized = withoutCourtesy(draft);
  return normalized.length >= 4 && ledger.rejectedAnswers.some(answer => withoutCourtesy(answer.text) === normalized);
}

const notes = {
  en: {
    contradiction: 'This differs from an earlier answer and I could not verify the change',
    coverage: 'Part of your request still needs an answer',
    commitments: 'I have no confirmed update on an earlier commitment',
    corrections: 'This appears to repeat a point you corrected',
    preferences: 'This reply misses a stated preference',
    repetition: 'You already rejected this answer and I don’t have a verified replacement',
  },
  ar: {
    contradiction: 'هذا يخالف ما ذكرته سابقًا ولم أتحقق من سبب التغيير',
    coverage: 'بقي جزء من طلبك دون إجابة',
    commitments: 'ليس لدي تحديث مؤكد بشأن التزام سابق',
    corrections: 'يبدو أن الرد يكرر نقطة صححتها',
    preferences: 'الرد لا يطابق أحد تفضيلاتك',
    repetition: 'سبق أن رفضت هذه الإجابة وليس لدي بديل مؤكد',
  },
} as const;

const additionalNotes = {
  en: { contradiction: 'earlier answer conflicts', coverage: 'unanswered request', commitments: 'unconfirmed commitment',
    corrections: 'repeated correction', preferences: 'missed preference', repetition: 'repeated rejected answer' },
  ar: { contradiction: 'تعارض مع إجابة سابقة', coverage: 'جزء دون إجابة', commitments: 'التزام غير مؤكد',
    corrections: 'تكرار نقطة مصححة', preferences: 'تفضيل غير مطبق', repetition: 'تكرار إجابة مرفوضة' },
} as const;

function cleanLabel(text: string): string {
  const clean = text.replace(/https?:\/\/\S+|[`<>\[\]{}|]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return clean.length > 55 ? `${clean.slice(0, 52)}…` : clean;
}

function noteLabels(items: readonly string[], lang: 'ar' | 'en'): string {
  const labels = [...new Set(items.map(cleanLabel).filter(label => label && questionLanguage(label) === lang))];
  const summary = labels.slice(0, 2).join(lang === 'ar' ? '، ' : ', ');
  const omitted = labels.length - 2;
  return omitted > 0 ? `${summary} ${lang === 'ar' ? `و${omitted} أخرى` : `and ${omitted} more`}` : summary;
}

function appendNote(
  draft: string, checks: readonly ReviewCheck[], lang: 'ar' | 'en',
  preferences: readonly Preference[], missing: readonly RequestPart[], open: readonly Commitment[], replaceRepetition: boolean,
  preserveContent: boolean, request: string,
): string {
  const formatPreference = preferences.findLast(preference => preference.kind === 'format');
  const format = formatPreference?.value;
  const prefix = lang === 'ar' ? 'تنبيه' : 'Note';
  const ordered = replaceRepetition ? ['repetition' as const, ...checks.filter(check => check !== 'repetition')]
    : missing.length ? ['coverage' as const, ...checks.filter(check => check !== 'coverage')] : checks;
  const description = ordered.map((check, index) => {
    const label = check === 'coverage' ? noteLabels(missing.map(part => part.text), lang)
      : check === 'commitments' ? noteLabels(open.map(promise => promise.action), lang) : '';
    return label ? `${notes[lang][check]} — ${label}` : index ? additionalNotes[lang][check] : notes[lang][check];
  }).join(lang === 'ar' ? '، ' : ', ');
  const note = `${prefix}: ${description.replace(/[.?!؟]+$/u, '')}.`;
  if (replaceRepetition) return format === 'json' ? JSON.stringify({ note }) : format === 'bullets' ? `- ${note}`
    : format === 'numbered' ? `1. ${note}` : format === 'table'
      ? `| ${prefix} |\n| --- |\n| ${description.replace(/\|/gu, '')} |` : note;
  if (!draft.trim()) return note;
  if (format === 'bullets' && /^\s*[-+*•]\s+/mu.test(draft)) return `${draft}\n- ${note}`;
  if (format === 'numbered' && /^\s*\d+[.)]\s+/mu.test(draft)) {
    const last = Number([...draft.matchAll(/^\s*(\d+)[.)]\s+/gmu)].at(-1)?.[1] ?? '0');
    return `${draft}\n${last + 1}. ${note}`;
  }
  if (format === 'table') {
    const delimiter = draft.split(/\r?\n/u).find(line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line));
    if (delimiter) {
      const columns = delimiter.split('|').filter(column => column.trim()).length;
      return `${draft.trimEnd()}\n| ${note.replace(/\|/gu, '')} ${'| '.repeat(columns)}`.trimEnd();
    }
  }
  if (format === 'json') {
    const schemaSpecified = /(?:\b(?:schema|keys?|fields?|properties)\b|(?:^|\s)(?:بمفاتيح|بمفتاح|بالتاليه|المفاتيح|الحقول|المخطط)(?=\s|$))/u;
    if (preserveContent || schemaSpecified.test(normalizeReviewText(`${formatPreference?.text ?? ''} ${request}`))) return draft;
    const wrapped = /^\s*```json\s*([\s\S]*?)\s*```\s*$/iu.exec(draft);
    const body = wrapped?.[1] ?? draft;
    try {
      const payload: unknown = JSON.parse(body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.hasOwn(payload, 'conversationReview')) return draft;
      const end = body.lastIndexOf('}');
      const comma = Object.keys(payload).length ? ',' : '';
      const annotated = `${body.slice(0, end)}${comma}"conversationReview":${JSON.stringify(note)}${body.slice(end)}`;
      return wrapped ? draft.replace(body, () => annotated) : annotated;
    } catch { return draft; }
  }
  return `${draft}${format === 'paragraph' ? ' ' : '\n\n'}${note}`;
}

function userCoverageEvidence(ledger: ConversationLedger, part: RequestPart, draft: string): Claim | undefined {
  // Reuse only an earlier user statement with the exact requested field and
  // entity, not another assistant assertion or a loose keyword match.
  const asked = coverageTokens(part.text).sort().join(' ');
  if (!asked || reportRequested.test(normalizeReviewText(part.text))) return undefined;
  const match = ledger.userClaims.findLast(claim => claim.messageIndex < part.messageIndex
    && coverageTokens(claim.subject).sort().join(' ') === asked);
  const conflicts = (claim: Claim) => match && claim.messageIndex > match.messageIndex && claimRank(claim, match) && !sameValue(claim.value, match.value);
  if (!match || match.text.length > 150 || literalSource.test(draft)
    || !/^[-+$€£¥\s\p{L}\p{N}\p{M}.,:：'’%/]+$/u.test(match.text)
    || ledger.claims.some(conflicts) || ledger.archivedClaims?.forSubject(match.subject).some(conflicts)
    || ledger.corrections.some(correction => correction.messageIndex > match.messageIndex && correctionPair(correction)
      ?.some(([before]) => sameValue(before, match.value)))) return undefined;
  return match;
}

function requestParts(ledger: ConversationLedger, request: string): RequestPart[] {
  const current = ledger.requests.filter(part => part.messageIndex === ledger.currentRequestIndex);
  const summary = ledger.summary;
  if (!summary || !continuing.test(normalizeReviewText(request))) return current;
  const earlier = summary.openRequests.flatMap(saved => {
    const part = ledger.requests.find(source => source.messageIndex === saved.messageIndex && source.text === saved.text);
    if (!part || part.messageIndex >= ledger.currentRequestIndex) return [];
    const offset = ledger.messageOffset ?? 0;
    const later = ledger.messages.slice(summary.messageCount - offset, Math.max(0, ledger.currentRequestIndex - offset));
    return later.some(message => message.role === 'assistant' && !uncoveredParts([part], message.content, null, true).length) ? [] : [part];
  });
  return earlier.length ? earlier : current;
}

export function reviewReply(ledger: ConversationLedger, draft: string, options: ReviewOptions = {}): ReviewResult {
  const request = ledger.currentRequest ?? ledger.messages[ledger.currentRequestIndex]?.content ?? '';
  const preferences = ledger.preferences;
  const preferredLanguage = preferences.findLast(preference => preference.kind === 'language')?.value;
  const lang = preferredLanguage === 'ar' || preferredLanguage === 'en' ? preferredLanguage : questionLanguage(request || draft);
  const findings: ReviewFinding[] = [];
  const unresolved = new Set<ReviewCheck>();
  const add = (check: ReviewCheck, code: string, resolved = false) => {
    findings.push({ check, code });
    if (!resolved) unresolved.add(check);
  };
  const allowEdits = !options.preserveContent && !literalSource.test(draft);
  const currentParts = requestParts(ledger, request);
  const claims = getClaims(draft);
  let reply = draft;

  const corrections = findCorrections(ledger, claims, draft);
  for (const { claim, value } of corrections.fixes) {
    const fixed = allowEdits ? repairCorrection(reply, claim, value) : reply;
    add('corrections', 'corrected_value_repeated', fixed !== reply);
    reply = fixed;
  }
  for (let index = 0; index < corrections.unscoped; index++) add('corrections', 'corrected_operand_repeated');
  const repairedClaims = reply === draft ? claims : getClaims(reply);
  for (const claim of contradictedClaims(ledger, claims, options.evidence)) {
    add('contradiction', 'earlier_claim_conflict', !repairedClaims.some(fact => sameClaim(fact, claim)));
  }

  const missing = uncoveredParts(currentParts, draft, options.status, currentParts.some(part => part.messageIndex < ledger.currentRequestIndex));
  const unresolvedParts: RequestPart[] = [];
  for (const part of missing) {
    const format = preferences.findLast(preference => preference.kind === 'format')?.value;
    const fact = allowEdits && (!format || format === 'plain') && !preferences.some(preference => preference.kind === 'length')
      ? userCoverageEvidence(ledger, part, reply) : undefined;
    const repaired = fact ? `${reply}\n\n${lang === 'ar' ? 'ذكرت سابقًا' : 'You previously said'}: ${fact.text}.` : reply;
    const accepted = repaired !== reply && checkPreferences(preferences, repaired, request).every(issue => !['reply_language', 'avoided_content'].includes(issue.code));
    add('coverage', 'request_part_unanswered', accepted);
    if (accepted) reply = repaired;
    else unresolvedParts.push(part);
  }

  const open = ledger.commitments.filter(commitment => !commitmentDisposition(commitment, reply));
  for (const _commitment of open) add('commitments', 'commitment_unreported');
  for (const issue of checkPreferences(preferences, reply, request)) {
    const fixed = issue.fixed && allowEdits ? issue.fixed : reply;
    add('preferences', issue.code, fixed !== reply);
    reply = fixed;
  }

  const repeats = repeatsRejection(ledger, reply, request);
  if (repeats || repeatsRejection(ledger, draft, request)) add('repetition', 'rejected_answer_repeated', !repeats);

  if (unresolved.size) {
    const checks = [...unresolved].sort((a, b) => REVIEW_CHECKS.indexOf(a) - REVIEW_CHECKS.indexOf(b));
    const replacement = repeats && allowEdits;
    const candidate = appendNote(reply, checks, lang, preferences, unresolvedParts, open, replacement, Boolean(options.preserveContent), request);
    const knownViolations = new Set(checkPreferences(preferences, reply, request).map(issue => issue.code));
    const introducesViolation = checkPreferences(preferences, candidate, request).some(issue =>
      !knownViolations.has(issue.code) && ['reply_format', 'reply_length', 'avoided_content'].includes(issue.code));
    if (candidate !== reply && (!introducesViolation || replacement)) return { action: 'note', reply: candidate, findings };
  }
  return { action: reply === draft ? 'send' : 'fix', reply, findings };
}
