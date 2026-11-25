import { isDeepStrictEqual } from 'node:util';
import { resolveRequestContext, type RequestContextOptions, type RequestResolution } from '../request-context.js';
import { decideRequestRoute, type RequestRoutingDecision, type RequestRoutingInput } from '../routing-decision.js';
import { parserView, understandRequest, type RequestUnderstandingView } from './index.js';

export { boundUnderstanding } from './index.js';

function diff<T extends object>(legacy: T, normalized: T, fields: readonly (keyof T)[]): string[] {
  return fields.filter(field => !isDeepStrictEqual(legacy[field], normalized[field])).map(String);
}

const resolutionFields = ['kind', 'resolved', 'query', 'intent', 'scope', 'topic', 'slots', 'ambiguities', 'provenance', 'nextState',
  'pendingQuestionId', 'sourceAssessment', 'constraints'] as const;
const routingFields = ['route', 'intent', 'handler', 'availability', 'missingCapabilities', 'reason', 'sourceAssessment',
  'publicQuery', 'browserSteps', 'localReply'] as const;

function summary(resolution: RequestResolution) {
  return { kind: resolution.kind, intent: resolution.intent, scope: resolution.scope,
    source: resolution.sourceAssessment?.source, operation: resolution.sourceAssessment?.operation };
}

function rollout<T extends RequestResolution | RequestRoutingDecision>(text: string, legacy: T, candidate: (view: RequestUnderstandingView) => T): T {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) return legacy;
  let normalized: T, view: RequestUnderstandingView | undefined;
  try {
    view = parserView(understandRequest(text));
    if (!view) return legacy;
    normalized = candidate(view);
  } catch {
    try { console.warn(JSON.stringify({ event: 'arabic_understanding_shadow_error' })); } catch { /* Observation cannot change routing. */ }
    return legacy;
  }

  const active = process.env.MOHASSAN_ARABIC_UNDERSTANDING === '1';
  const changed = observeDifference(legacy, normalized, view, active);
  return active && (changed || view.parserText !== text) ? normalized : legacy;
}

function observeDifference(legacy: RequestResolution | RequestRoutingDecision, normalized: RequestResolution | RequestRoutingDecision,
    view: RequestUnderstandingView, active: boolean): boolean {
  const before = 'resolution' in legacy ? legacy.resolution : legacy;
  const after = 'resolution' in normalized ? normalized.resolution : normalized;
  const resolutionChanges = diff(before, after, resolutionFields);
  const routeChanges = 'resolution' in legacy && 'resolution' in normalized ? diff(legacy, normalized, routingFields) : [];
  if (!resolutionChanges.length && !routeChanges.length) return false;
  // Log enums and changed field names only. Requests, queries, slots and replies may contain private data.
  try {
    console.info(JSON.stringify({ event: 'arabic_understanding_shadow_difference', active,
      legacy: summary(before), normalized: summary(after), resolutionChanges, routeChanges,
      ...('route' in legacy && 'route' in normalized ? { legacyRoute: legacy.route, normalizedRoute: normalized.route } : {}),
      answerType: view.question?.answerType ?? null, arabizi: view.isArabizi }));
  } catch { /* Observation cannot change routing. */ }
  return true;
}

export function routeWithArabicUnderstanding(input: RequestRoutingInput): RequestRoutingDecision {
  const current = { ...input, now: input.now ?? new Date() };
  return rollout(input.text, decideRequestRoute(current), understanding => decideRequestRoute({ ...current, understanding }));
}

export function resolveWithArabicUnderstanding(text: string, previous: unknown, options: RequestContextOptions): RequestResolution {
  return rollout(text, resolveRequestContext(text, previous, options), understanding => resolveRequestContext(text, previous, { ...options, understanding }));
}
