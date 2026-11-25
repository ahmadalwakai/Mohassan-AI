import type { ChatCapabilities } from '@mohassan/contracts';
import { createHash } from 'node:crypto';
import { parseUserRequestConstraints } from '../request-constraints.js';
import { parseRequestContextState, resolveRequestContext } from '../request-context.js';
import type { RequestRoutingInput, RequestRoutingDecision } from '../routing-decision.js';
import type { RequestScopeAssessment } from '../request-scope.js';
import { detectManners } from './detect.js';
import { renderMannersClause, renderMannersReply } from './replies.js';

const enabled = () => process.env.MOHASSAN_SMALL_TALK_MANNERS === '1';

/** Split the outer turn before the task's provenance, scope and constraints are compiled. */
export function prepareMannersTurn(text: string, eligible: boolean) {
  if (!eligible) return null;
  const detection = detectManners(text);
  if (!detection) return null;
  const active = enabled();
  const request = detection.request;
  try {
    console.info(JSON.stringify({ event: 'small_talk_manners_shadow', active, act: detection.act,
      language: detection.language, dialect: detection.dialect, mixed: request !== null }));
  } catch { /* Observation must not interrupt a turn. */ }
  if (!active || !request) return null;
  const before = parseUserRequestConstraints(text);
  const after = parseUserRequestConstraints(request);
  if (before && (!after || before.prohibitions.length > after.prohibitions.length ||
    before.forbiddenCapabilities.some(capability => !after.forbiddenCapabilities.includes(capability)))) return null;
  return { request, clause: (facts: ChatCapabilities, turnId: string) => renderMannersClause(detection, facts, turnId) };
}

/** Keep legacy exact-literal rejection when schema trimming changed the raw turn. */
export function mannersRequestHash(originalHash: string | undefined, displayed: string, task: string | undefined) {
  if (!task || originalHash !== createHash('sha256').update(displayed, 'utf8').digest('hex')) return originalHash;
  return createHash('sha256').update(task, 'utf8').digest('hex');
}

function standaloneManners(text: string) {
  if (!enabled()) return null;
  const detection = detectManners(text);
  return detection && detection.request === null && !parseUserRequestConstraints(text) ? detection : null;
}

export function standaloneMannersRoute(input: RequestRoutingInput): RequestRoutingDecision | null {
  if (input.pendingQuestion !== undefined || !standaloneManners(input.text)) return null;
  const normal = resolveRequestContext(input.text, input.context, { turnId: input.turnId });
  if (normal.resolved === null) return null;
  const ambiguities = normal.ambiguities.filter(reason => reason === 'invalid_previous_state' || reason === 'unsafe_previous_context');
  const prior = ambiguities.length ? null : parseRequestContextState(input.context);
  const sourceAssessment: RequestScopeAssessment = {
    version: 1, source: 'unresolved', scope: 'unknown', operation: 'converse', destination: 'unknown',
    publicQueryEligible: false, reasons: ['non_lookup_operation'],
  };
  return { version: 1, route: 'chat', intent: 'chat', handler: 'local_conversation', availability: 'ready',
    reason: 'local_conversation', missingCapabilities: [], sourceAssessment, publicQuery: null,
    resolution: { ...normal, kind: 'new', intent: 'chat', scope: 'unknown', query: null, topic: null,
      sourceAssessment, slots: [], ambiguities, provenance: [],
      pendingQuestionId: null, nextState: prior } };
}

export async function standaloneMannersReply(text: string, turnId: string, capabilities: () => Promise<ChatCapabilities>) {
  const detection = standaloneManners(text);
  if (!detection) return null;
  return renderMannersReply(detection, detection.act === 'capabilities' ? await capabilities() : undefined, turnId).text;
}

/** Publish the clause and answer separately so task formatting and verified answer bytes are preserved. */
export async function publishMannersReply(state: { mannersClause?: string }, text: string | undefined,
  add: (text: string, afterClause?: boolean) => Promise<void>): Promise<boolean> {
  const clause = state.mannersClause;
  if (clause) await add(clause);
  if (text !== undefined) await add(text, Boolean(clause));
  if (clause) delete state.mannersClause;
  return Boolean(clause);
}
