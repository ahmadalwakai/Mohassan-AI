/**
 * Several questions in one message when at least one of them needs the web: «ما عاصمة فرنسا؟ ثم كم عدد سكانها؟». This is
 * step 4 of the task cycle («التخطيط والتنسيق») for questions: the message is split where compound-request.ts finds the
 * sequence word or the end of a question, each part is answered in its turn (the calculator and the questions about
 * Mohassan by the host, every other part by one web search and read), and the answers go out in the order asked.
 *
 * Why this exists: on 2026-11-22 that message was sent to the search as one question and came back «لم أجد صفحة تجيب
 * مباشرة» (artifacts/agent-gaps-2026-11-22/audit-head-3959084/wiring-probe.json). local-sequence.ts takes a message only
 * when every part is local.
 *
 * Only a message whose every part is a local answer or a public question is taken. A part that is an action («ثم أرسلها»,
 * «ثم لخّصها», «ثم افتح …»), a fact of the owner's own («ثم ما هو رقم جوالي؟») or something the web is not asked for
 * makes the whole message null, and the paths that ran before this planner run as they did.
 *
 * Pure: this module only plans. The chat runs each web part through the hands and judges each answer on its own question.
 */
import { answerLocalPart, sequenceParts, type LocalSequenceDeps } from './local-sequence.js';
import { buildFrame } from './mind/frame.js';
import { ownFactQuestion } from './own-fact-question.js';
import { entityWords, isFollowUp, notWebReason, parseHands, refersBack, tidy, topicWords, webQuestion, type HandsPlan, type HandsStep } from './hands.js';

export interface WebSequenceAnswer { request: string; text: string; status: 'completed' | 'partial' | 'blocked' }
export interface WebSequencePart {
  /** The owner's words for this part, exactly as written. */
  request: string;
  /** The host's own answer (the calculator, a question about Mohassan); absent for a part the web answers. */
  local?: WebSequenceAnswer;
}
/** What a hands plan carries while it answers one part of a sequence: the parts already answered and those still to ask. */
export interface WebSequel {
  /** The part this plan answers. */
  asked: string;
  /** The part before it, for the judge of a follow-up («كم عدد سكانها؟» after «ما عاصمة فرنسا؟»). */
  previous: string | null;
  answers: WebSequenceAnswer[];
  rest: WebSequencePart[];
}

/** A part the web may answer is a question: it opens with a question word or ends with a question mark. */
const QUESTION = /^(?:و|ف)?(?:ما|ماذا|من|مين|متى|متي|أين|اين|وين|كم|هل|كيف|لماذا|ليش|أي|اي|what|who|whom|when|where|which|why|how|is|are|was|were|does|do|did|can)(?=\s|['’])|[?؟]\s*$/iu;
/** English pronouns that point at the subject of the part before: "what is its population?". */
const ENGLISH_POINTER = /\b(?:its|his|her|their)\s+([a-z][a-z -]{1,40}?)(?=\s*[?.!]*$)/iu;

function webPart(request: string): boolean {
  const text = tidy(request);
  if (!QUESTION.test(text) || parseHands(request) || notWebReason(text) || ownFactQuestion(request)) return false;
  // «ما اسم شركتي؟» and "what is my phone number?" are the owner's own: memory answers them, never a sequence of searches.
  if (buildFrame(request).personal) return false;
  return Boolean(webQuestion(request)?.every(step => step.kind === 'search' && !step.site));
}

/** The parts of a message in order, or null when it is not a sequence this planner takes (see the module comment). */
export function planWebSequence(request: string, deps: LocalSequenceDeps): WebSequencePart[] | null {
  const parts = sequenceParts(request);
  if (!parts) return null;
  const planned: WebSequencePart[] = [];
  for (const part of parts) {
    const local = answerLocalPart(part, deps);
    if (local) planned.push({ request: part, local: { request: part, text: local.text, status: local.status } });
    else if (webPart(part)) planned.push({ request: part });
    else return null;
  }
  return planned.some(part => !part.local) ? planned : null;
}

/**
 * The search for one web part. A part that points back («كم عدد سكانها؟», "what is its population?") or names no subject of
 * its own («متى ولد؟») asks about the thing the part before was answered about: the title of the page that answer was read
 * from, as a follow-up turn does (command-chat.ts, `namedBefore`). Without such a page, the earlier parts' words are used.
 */
export function webPartSteps(request: string, named: string, earlier: readonly string[]): HandsStep[] | null {
  const text = tidy(request);
  const pointsBack = isFollowUp(text) && refersBack(text);
  if (named) {
    const english = !/\p{Script=Arabic}/u.test(request) ? ENGLISH_POINTER.exec(text) : null;
    // "what is its population?" → "what is the population of France?": the pronoun becomes the name it stood for.
    if (english) return webQuestion(`${text.slice(0, english.index)}the ${english[1]!.trim()} of ${named}?`);
    if (pointsBack) return webQuestion(request, [named]);
    // «متى ولد؟»: a verb and nothing else. Arabic drops the pronoun, so no word points back, and the question alone names nobody.
    if (!entityWords(request).length && topicWords(request).length <= 2) return webQuestion(`${text.replace(/[\s؟?]+$/u, '')} ${named}؟`);
  }
  return webQuestion(request, pointsBack ? earlier : []);
}

/** The plan for the first web part, carrying the host's answers to the parts before it and the parts still to ask. */
export function startWebSequence(parts: readonly WebSequencePart[], lang: 'ar' | 'en'): HandsPlan | null {
  const answers: WebSequenceAnswer[] = [];
  let at = 0;
  for (; at < parts.length && parts[at]!.local; at++) answers.push(parts[at]!.local!);
  const first = parts[at];
  const steps = first ? webPartSteps(first.request, '', answers.map(answer => answer.request)) : null;
  return first && steps ? { steps, next: 0, lang, sequel: { asked: first.request, previous: at ? parts[at - 1]!.request : null, answers, rest: parts.slice(at + 1) } } : null;
}

/**
 * After one web part is answered: the plan for the next web part, or every answer when none is left. `named` is the title
 * of the page the answer was read from, so the next part can ask about it («كم عدد سكانها؟»).
 */
export function continueWebSequence(sequel: WebSequel, answer: WebSequenceAnswer, named: string, lang: 'ar' | 'en'): { plan: HandsPlan } | { answers: WebSequenceAnswer[] } {
  const answers = [...sequel.answers, answer];
  let rest = sequel.rest, previous = sequel.asked;
  while (rest.length && rest[0]!.local) { answers.push(rest[0]!.local!); previous = rest[0]!.request; rest = rest.slice(1); }
  const next = rest[0];
  if (!next) return { answers };
  const steps = webPartSteps(next.request, named, answers.map(item => item.request));
  // Planned as a question, so this does not happen; if it ever does, the part is named as not done rather than dropped.
  if (!steps) return { answers: [...answers, ...rest.map(part => part.local ?? { request: part.request, status: 'blocked' as const,
    text: lang === 'ar' ? 'لم أجد في هذا الجزء سؤالًا أبحث عنه، فلم أجب عنه.' : 'I found no question to search for in this part, so I did not answer it.' })] };
  return { plan: { steps, next: 0, lang, sequel: { asked: next.request, previous, answers, rest: rest.slice(1) } } };
}

/** The reply for the whole message: each part under the owner's own words for it, in the order asked. */
export function joinSequence(answers: readonly WebSequenceAnswer[]): { text: string; status: 'completed' | 'partial' | 'blocked' } {
  const completed = answers.filter(answer => answer.status === 'completed').length;
  return {
    status: completed === answers.length ? 'completed' : completed ? 'partial' : 'blocked',
    text: answers.map(answer => `**${answer.request.trim()}**\n${answer.text.trim()}`).join('\n\n'),
  };
}
