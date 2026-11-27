import { safeResumeUrl } from '@mohassan/browser';
import { stripAcknowledgementLead } from './acknowledgements.js';
import type { BrainState } from './brain.js';
import type { ConversationPageSelection } from './conversation-state-page.js';
import type { TopicFrame, TurnUnderstanding } from './conversation-state.js';
import { answerSubject, fold, isLiveWebQuestion, plainTitle, type HandsPlan } from './hands.js';

const words = (text: string) => fold(text).match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
const contains = (text: string, part: string) => Boolean(part) && ` ${text} `.includes(` ${part} `);
const QUESTION_END = /[؟?]\s*$/u;
const LOCATIVE = /(?:^| )(?:there|هنالك|هناك|هنيك|هنا)(?: |$)/u;
const WORK_KIND = /^(?:(?:and )?the (book|novel|film|song|album|play) (?=when |was |is |did )|و?ال(روايه|كتاب|فيلم|اغنيه|البوم|مسرحيه) (?=(?:متي|امتي|متى|(?:ات|ا|ت)?نشر(?:ت)?|صدر(?:ت)?)(?: |$)))/u;
const WORK_EVENT = /\bit\b.{0,45}\b(?:published|released|printed|performed)\b/u;
const WORK_DESCRIPTION = /\b(?:book|novel|film|song|album|play)\b/u;
const LANGUAGE = /(?:^| )(?:languages?|(?:ال)?لغ(?:ه|ات|تاها|تها|تهم|تان|تين))(?: |$)/u;

/** A read-only question about the subject of the public page that actually answered the preceding turn. */
export function planPublicConversationRead(input: {
  text: string;
  previous: string;
  topic: TopicFrame | null | undefined;
  understanding: TurnUnderstanding;
  found: NonNullable<BrainState['handsFound']>;
}): ConversationPageSelection | null {
  const { text, previous, topic, understanding, found } = input;
  const { decision, property } = understanding;
  const url = typeof found.url === 'string' ? safeResumeUrl(found.url) : null;
  const pageTitle = typeof found.title === 'string' ? plainTitle(found.title) : '';
  const title = words(pageTitle);
  const request = words(text);
  if (!url || !title || !Array.isArray(found.lines) || !found.lines.some(line => typeof line === 'string' && line.trim())
    || !contains(words(previous), title) || !request || isLiveWebQuestion(text)
    || !QUESTION_END.test(text) && !decision.questionType
    || decision.references.some(reference => !reference.publicLookup)) return null;
  // The previous entity can supply the property of a follow-up without being its subject.
  if (understanding.type === 'follow_up_entity' && understanding.entity
    && words(understanding.entity) !== words(topic?.entity ?? pageTitle) && stripAcknowledgementLead(text) !== text) return null;

  const ar = /\p{Script=Arabic}/u.test(text);
  const attribute = property === 'currency' ? 'currency' : property === 'language' || LANGUAGE.test(request) ? 'language' : null;
  const samePropertySubject = understanding.type === 'follow_up_property' && understanding.entity !== null
    && words(understanding.entity) === title;
  const implicitPlural = ar && /^و/u.test(request) && /^[يت]\p{Script=Arabic}{2,}(?:ون|ين|وا)$/u.test(understanding.entity ?? '');
  // Jurisdiction-wide attributes inherit the place asked about, even if the previous answer named its capital.
  const jurisdiction = topic?.property === 'capital' && attribute && (LOCATIVE.test(request) || implicitPlural || samePropertySubject
    || decision.type === 'follow_up' && decision.reasons.includes('explicit_reference'));
  const reference = decision.type === 'follow_up' && decision.references.length === 1 ? decision.references[0] : undefined;
  const referenceName = words(reference?.text ?? '');
  const namedByUser = contains(words(previous), referenceName)
    || reference?.role === 'user' && topic?.entityOrigin === 'user' && words(topic.entity ?? '') === referenceName;
  // Reuse an expanded title only when the user named it and the answer was about the page itself.
  // A named entry quoted from a generic list needs its own lookup.
  const referencesSubject = reference && (referenceName === title || words(reference.aliasOf ?? '') === title
    || namedByUser && contains(referenceName, title) && words(answerSubject(found)) === title);
  const workKind = WORK_KIND.exec(request)?.slice(1).find(Boolean);
  const describesSubject = (workKind || WORK_EVENT.test(request)) && found.lines.some(line => {
    const evidence = typeof line === 'string' ? words(line) : '';
    return contains(evidence, title) && (workKind
      ? contains(evidence, workKind) || contains(evidence, `ال${workKind}`) : WORK_DESCRIPTION.test(evidence));
  });
  if (!jurisdiction && !referencesSubject && !describesSubject) return null;

  const question = jurisdiction && ar ? attribute === 'currency' ? `ما عملة ${pageTitle}؟` : `ما لغة ${pageTitle}؟` : text;
  const plan: HandsPlan = { steps: [{ kind: 'ask_page', question, conversationPage: { expectedUrl: url, readPublic: true } }], next: 0, lang: ar ? 'ar' : 'en' };
  return { plan, question, previous };
}
