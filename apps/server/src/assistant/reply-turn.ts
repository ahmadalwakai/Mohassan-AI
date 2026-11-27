import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely } from 'kysely';
import type { BrainState } from './brain.js';
import { reviewChatAnswer } from './chat-supervision.js';
import { mergeReplyConstraints, parseReplyRequest, type ReplyConstraints } from './reply-directive.js';
import { enforceReplyConstraints } from './reply-constraint-review.js';
import { loadReplyPreferences, resolveReplyTurn } from './reply-preferences.js';

/** The accepted turn's format, pinned through pauses and recoveries. */
export interface ReplyTurn {
  constraints: ReplyConstraints;
  body?: string;
  acknowledgementLanguage?: 'ar' | 'en';
  needsPreferenceStyle?: true;
}

const replies = new AsyncLocalStorage<{ turn?: ReplyTurn; request?: string }>();

export const withReplyTurn = <T>(run: () => T): T => replies.run({}, run);

function bindReplyTurn(state: BrainState, request: string): void {
  const scope = replies.getStore();
  if (scope) Object.assign(scope, { turn: state.replyTurn, request: request.trim() });
}

export function replyTurnSnapshot(request: string, turn: Awaited<ReturnType<typeof resolveReplyTurn>>, primary = true): ReplyTurn {
  const { constraints, body, preferenceOnly } = turn;
  return {
    constraints,
    ...(primary && !preferenceOnly && body !== request.trim() ? { body } : {}),
    ...(primary && preferenceOnly ? { acknowledgementLanguage: constraints.lang ?? (/\p{Script=Arabic}/u.test(request) ? 'ar' : 'en') } : {}),
    ...(primary && preferenceOnly && !Object.keys(turn.preferences).length ? { needsPreferenceStyle: true as const } : {}),
  };
}

export async function acceptReplyTurn(db: Kysely<any>, ownerId: string, id: string, request: string, userInstruction = true): Promise<ReplyTurn> {
  return userInstruction
    ? replyTurnSnapshot(request, await resolveReplyTurn(db, ownerId, id, request))
    : { constraints: await loadReplyPreferences(db, ownerId, id) };
}

export async function admitReplyTurn(db: Kysely<any>, ownerId: string, id: string, state: BrainState, request: string,
  userInstruction: boolean, writeMessage: () => Promise<void>): Promise<void> {
  state.replyTurn = await acceptReplyTurn(db, ownerId, id, request, userInstruction);
  await withReplyTurn(() => {
    bindReplyTurn(state, request);
    return writeMessage();
  });
}

export async function bindAcceptedReplyTurn(db: Kysely<any>, ownerId: string, id: string, state: BrainState, request: string): Promise<void> {
  if (!state.replyTurn) {
    const parsed = parseReplyRequest(request);
    state.replyTurn = replyTurnSnapshot(request, { ...parsed, preferenceOnly: false, constraints: mergeReplyConstraints(parsed, await loadReplyPreferences(db, ownerId, id)) });
  }
  bindReplyTurn(state, request);
}

export async function advanceReplyTurn(db: Kysely<any>, ownerId: string, id: string, state: BrainState, request: string,
  userInstruction: boolean | undefined): Promise<void> {
  if (!userInstruction) return;
  const newObjective = state.clarifiedRequest === request;
  const prior = newObjective ? undefined : state.replyTurn;
  const turn = await resolveReplyTurn(db, ownerId, id, request, prior?.constraints);
  state.replyTurn = { ...prior, ...replyTurnSnapshot(request, turn, newObjective) };
}

export function replyConstraintsFor(state?: BrainState): ReplyConstraints | undefined {
  return state?.replyTurn?.constraints ?? replies.getStore()?.turn?.constraints;
}

export function replyBodyFor(request: string): string {
  const scope = replies.getStore();
  return scope?.request === request.trim() ? scope.turn?.body ?? request : request;
}

function replyPreferenceAcknowledgement(turn?: ReplyTurn): string | undefined {
  if (turn?.acknowledgementLanguage === 'ar') return turn.needsPreferenceStyle ? 'كيف تفضّل أن أجيبك؟' : 'حدّثت تفضيلات الرد لهذه المحادثة.';
  if (turn?.acknowledgementLanguage === 'en') return turn.needsPreferenceStyle ? 'How would you like me to answer?' : 'I updated your reply preferences for this conversation.';
}

export async function completeReplyPreference(state: BrainState, dropHeld: () => Promise<void>, finish: (text: string) => Promise<void>): Promise<boolean> {
  const text = replyPreferenceAcknowledgement(state.replyTurn);
  if (!text) return false;
  if (state.dropHeld) {
    await dropHeld();
    state.dropHeld = false;
  }
  await finish(text);
  return true;
}

export function pauseReplyConstraints(state?: BrainState): ReplyConstraints | undefined {
  const constraints = replyConstraintsFor(state);
  if (!constraints) return;
  const { sentences, brief, list, links } = constraints;
  return { sentences, brief, list, links };
}

export function shapePausedReply(text: string | undefined, state: BrainState): string | undefined {
  if (!text) return text;
  return enforceReplyConstraints(text, pauseReplyConstraints(state)).text;
}

type ReplyStatus = 'completed' | 'partial' | 'blocked';
interface ReplyCandidate { text: string; withheld?: boolean }
interface Publication { text: string; status: ReplyStatus }

/** Exact-text evidence must still match the reply that is stored. */
export function requiresVerbatimReply(state: BrainState, memoryPublication?: string): boolean {
  return Boolean(memoryPublication) || state.supervision?.contract.mode === 'enforced';
}

function shapeReply(state: BrainState, candidate: ReplyCandidate, status: ReplyStatus, verbatim: boolean): Publication {
  const reply = verbatim ? candidate : enforceReplyConstraints(candidate.text, replyConstraintsFor(state));
  return { text: reply.text, status: status === 'completed' && (reply.withheld || candidate.withheld) ? 'partial' : status };
}

export function reviewReplyCandidate(state: BrainState, candidate: ReplyCandidate, status: ReplyStatus, verbatim: boolean): Publication {
  const reply = shapeReply(state, candidate, status, verbatim);
  if (state.supervision) state.completionReview = reviewChatAnswer(state.supervision, reply.text);
  return reply;
}

export function prepareReplyPublication(state: BrainState, text: string, status: ReplyStatus, verbatim: boolean,
  experiment?: { text: string; footer: string }): Publication {
  if (experiment) return { text: experimentalReplyText(experiment.text, experiment.footer, replyConstraintsFor(state)), status };
  return shapeReply(state, { text }, status, verbatim);
}

export function replyConstraintPrompt(constraints?: ReplyConstraints): string {
  if (!constraints) return '';
  const parts: string[] = [];
  if (constraints.lang) parts.push(constraints.lang === 'ar' ? 'Answer in Arabic.' : 'Answer in English.');
  if (constraints.sentences) parts.push(`Use at most ${constraints.sentences} ${constraints.sentences === 1 ? 'sentence' : 'sentences'}.`);
  if (constraints.brief) parts.push('Keep the answer brief. Omit supplemental details and links unless requested.');
  if (constraints.brief === false) parts.push('Use the detail needed to answer fully.');
  if (constraints.list !== undefined) parts.push(constraints.list ? 'Use a list.' : 'Use prose without a list.');
  if (constraints.links !== undefined) parts.push(`Include ${constraints.links === 0 ? 'no' : `at most ${constraints.links}`} links.`);
  if (constraints.fields?.length) parts.push(`Include these requested fields when verified: ${constraints.fields.join(', ')}.`);
  return parts.length ? `Reply constraints for this turn\n${parts.join(' ')}` : '';
}

const englishExperimentalFooter = '\n\n— Experimental v5 model (did not pass the quality test)';

export function experimentalReplyBody(text: string, footer: string): string {
  const attached = [footer, englishExperimentalFooter].find(label => text.endsWith(label));
  return attached ? text.slice(0, -attached.length) : text;
}

export function verifiedExperimentalReply(text: string | undefined, constraints?: ReplyConstraints): string | undefined {
  if (!text?.trim()) return;
  const reviewed = enforceReplyConstraints(text.trim(), constraints);
  if (!reviewed.withheld) return reviewed.text;
}

/** The experimental disclosure is metadata and remains attached to a reviewed answer. */
function experimentalReplyText(text: string, footer: string, constraints?: ReplyConstraints): string {
  return text + (constraints?.lang === 'en' ? englishExperimentalFooter : footer);
}
