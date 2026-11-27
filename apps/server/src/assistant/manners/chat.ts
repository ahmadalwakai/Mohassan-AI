import type { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentBrowser } from '@mohassan/browser';
import type { ChatCapabilities, ChatSendSchema } from '@mohassan/contracts';
import { sql, type Kysely } from 'kysely';
import type { z } from 'zod';
import { tryEnterPhase } from '../agent-run.js';
import type { BrainState } from '../brain.js';
import { recognizeEverydayClarification } from '../everyday-clarification.js';
import { evaluateAcknowledgement } from '../local-conversation.js';
import type { LocalReply } from '../mind/limits.js';
import { parseUserRequestConstraints } from '../request-constraints.js';
import { parseRequestContextState, resolveRequestContext } from '../request-context.js';
import type { RequestRoutingInput, RequestRoutingDecision } from '../routing-decision.js';
import type { RequestScopeAssessment } from '../request-scope.js';
import { detectManners, type MannersDetection } from './detect.js';
import { isEverydayManners } from './everyday.js';
import { renderMannersClause, renderMannersReply } from './replies.js';

const enabled = () => process.env.MOHASSAN_SMALL_TALK_MANNERS === '1';

/** Split the outer turn before the task's provenance, scope and constraints are compiled. */
export function prepareMannersTurn(text: string, eligible: boolean) {
  if (!eligible || recognizeEverydayClarification(text, false)) return null;
  const detection = detectManners(text);
  if (!detection) return null;
  const request = detection.request;
  const active = enabled() || request === null && isEverydayManners(detection);
  try {
    console.info(JSON.stringify({ event: 'small_talk_manners_shadow', active, act: detection.act,
      language: detection.language, dialect: detection.dialect, mixed: request !== null }));
  } catch { /* Observation must not interrupt a turn. */ }
  if (!active) return null;
  const before = parseUserRequestConstraints(text);
  if (request === null) return before ? null : { detection, request };
  const after = parseUserRequestConstraints(request);
  if (before && (!after || before.prohibitions.length > after.prohibitions.length ||
    before.forbiddenCapabilities.some(capability => !after.forbiddenCapabilities.includes(capability)))) return null;
  return { detection, request };
}

/** Keep legacy exact-literal rejection when schema trimming changed the raw turn. */
export function mannersRequestHash(originalHash: string | undefined, displayed: string, task: string | undefined) {
  if (!task || originalHash !== createHash('sha256').update(displayed, 'utf8').digest('hex')) return originalHash;
  return createHash('sha256').update(task, 'utf8').digest('hex');
}

function standaloneManners(text: string) {
  const detection = detectManners(text);
  return detection && detection.request === null && (enabled() || isEverydayManners(detection))
    && !parseUserRequestConstraints(text) ? detection : null;
}

export function standaloneMannersRoute(input: RequestRoutingInput): RequestRoutingDecision | null {
  if (input.pendingQuestion !== undefined || !standaloneManners(input.text)) return null;
  return standaloneSocialRoute(input);
}

export function standaloneAcknowledgementRoute(input: RequestRoutingInput): RequestRoutingDecision | null {
  if (input.pendingQuestion !== undefined) return null;
  const reply = evaluateAcknowledgement(input.text);
  return reply ? standaloneSocialRoute(input, reply) : null;
}

function standaloneSocialRoute(input: RequestRoutingInput, localReply?: LocalReply): RequestRoutingDecision | null {
  const normal = resolveRequestContext(input.text, input.context, { turnId: input.turnId });
  if (normal.resolved === null) return null;
  const ambiguities = normal.ambiguities.filter(reason => reason === 'invalid_previous_state' || reason === 'unsafe_previous_context');
  const prior = ambiguities.length ? null : parseRequestContextState(input.context);
  const sourceAssessment: RequestScopeAssessment = {
    version: 1, source: 'unresolved', scope: 'unknown', operation: 'converse', destination: 'unknown',
    publicQueryEligible: false, reasons: ['non_lookup_operation'],
  };
  return { version: 1, route: 'chat', intent: 'chat', handler: 'local_conversation', availability: 'ready',
    reason: 'local_conversation', missingCapabilities: [], sourceAssessment, publicQuery: null, ...(localReply && { localReply }),
    resolution: { ...normal, kind: 'new', intent: 'chat', scope: 'unknown', query: null, topic: null,
      sourceAssessment, slots: [], ambiguities, provenance: [],
      pendingQuestionId: null, nextState: prior } };
}

type Input = z.infer<typeof ChatSendSchema>;
type MessageWriter = (tx: Kysely<any>, id: string, role: 'user' | 'assistant', text: string) => Promise<void>;
type Dispatch = (ownerId: string, id: string, runId: string, token: string) => Promise<void>;
type LocalExecution = { ownerId: string; id: string; runId: string; token: string; controller: AbortController; full: boolean; request: string; state: BrainState };

interface Admission {
  db: Kysely<any>;
  ownerId: string;
  input: Input;
  requestOriginalHash: string | undefined;
  eligible: boolean;
  addMessage: MessageWriter;
  dispatch: Dispatch;
  execution: Pick<AsyncLocalStorage<LocalExecution>, 'run'>;
  finish(id: string, runId: string, state: BrainState, text: string, status: 'completed', proof?: undefined, memoryPublication?: undefined, prejudged?: boolean): Promise<void>;
  judgeReply(id: string, runId: string, reply: string, status: string): unknown;
  capabilitiesFor(ownerId: string): Promise<ChatCapabilities>;
  fullAccess?: (ownerId: string) => Promise<boolean>;
  closing(): boolean;
  RunEnded: new () => Error;
  AccountAccessEnded: new () => Error;
  interruptInactiveAccount(id: string, runId: string): Promise<void>;
  assertActive(): Promise<void>;
  browser: Pick<AgentBrowser, 'dropHeld'>;
}

async function completeSocialRun(admission: Admission, render: (runId: string) => string | Promise<string>,
  ownerId: string, id: string, runId: string, token: string) {
  if (admission.closing()) return admission.dispatch(ownerId, id, runId, token);
  const run = await admission.db.selectFrom('chat_runs').select(['goal', 'state']).where('id', '=', runId)
    .where('conversation_id', '=', id).where('owner_id', '=', ownerId).where('lease_token', '=', token)
    .where('status', '=', 'running').executeTakeFirst();
  if (!run) return;
  const state: BrainState = run.state;
  if (state.routing && state.routing.handler !== 'local_conversation') return admission.dispatch(ownerId, id, runId, token);
  const full = await admission.fullAccess?.(ownerId) ?? true;
  const reply = await render(runId);
  tryEnterPhase(state.agentRun, 'understanding', Date.now());
  await admission.execution.run({ ownerId, id, runId, token, request: run.goal, state, full, controller: new AbortController() }, async () => {
    try {
      await admission.assertActive();
      if (state.dropHeld) {
        await admission.browser.dropHeld(ownerId, id);
        state.dropHeld = false;
      }
      admission.judgeReply(id, runId, reply, 'completed');
      await admission.finish(id, runId, state, reply, 'completed', undefined, undefined, true);
    } catch (error) {
      if (error instanceof admission.AccountAccessEnded) return admission.interruptInactiveAccount(id, runId);
      if (!(error instanceof admission.RunEnded)) throw error;
    }
  });
}

/** Interpose only at admission. The task's reply, pauses, checks and dispatch use the normal controller. */
export async function admitManners<T>(admission: Admission,
  proceed: (input: Input, requestOriginalHash: string | undefined, addMessage: MessageWriter, dispatch: Dispatch) => Promise<T>): Promise<T> {
  const { input, requestOriginalHash, addMessage, dispatch } = admission;
  const complete = (render: (runId: string) => string | Promise<string>) =>
    proceed(input, requestOriginalHash, addMessage, (...target) => completeSocialRun(admission, render, ...target));
  const acknowledgement = admission.eligible && evaluateAcknowledgement(input.text);
  if (acknowledgement) return complete(() => acknowledgement.text);
  const turn = prepareMannersTurn(input.text, admission.eligible);
  if (!turn) return proceed(input, requestOriginalHash, addMessage, dispatch);
  if (turn.request === null) return complete(async runId => {
    const facts = turn.detection.act === 'capabilities' ? await admission.capabilitiesFor(admission.ownerId) : undefined;
    return renderMannersReply(turn.detection, facts, runId).text;
  });

  const facts = turn.detection.act === 'capabilities' ? await admission.capabilitiesFor(admission.ownerId) : undefined;
  const clause = renderMannersClause(turn.detection, facts, randomUUID());
  return proceed({ ...input, text: turn.request }, mannersRequestHash(requestOriginalHash, input.text, turn.request), async (tx, id, role) => {
    await addMessage(tx, id, role, input.text);
    await tx.insertInto('chat_messages').values({ id: randomUUID(), conversation_id: id, role: 'assistant', text: clause,
      created_at: sql`CURRENT_TIMESTAMP + interval '1 microsecond'` }).execute();
  }, dispatch);
}
