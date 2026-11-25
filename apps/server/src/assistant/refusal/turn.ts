import type { BrainState } from '../brain.js';
import { parseHands } from '../hands.js';
import { requestActionText, type RequestContextState, type RequestResolution } from '../request-context.js';
import { assessRequestScope, requestScopeActionText, type RequestScopeAssessment } from '../request-scope.js';
import type { RequestRoutingDecision, RequestRoutingInput } from '../routing-decision.js';
import { classifyRefusal } from './classifier.js';
import { reviewHandsRefusal, reviewPendingRefusal } from './permissions.js';
import { refusalReply } from './replies.js';
import { logRefusalDecision, refusalPolicyEnabled } from './settings.js';
import type { RefusalDecision } from './types.js';

type RefusalContext = Parameters<typeof classifyRefusal>[1];

function reviewProposedHands(request: string) {
  const steps = parseHands(requestActionText(requestScopeActionText(request)));
  return steps ? reviewHandsRefusal(steps) : null;
}

function classifyTurn(request: string, resolution: RequestResolution | undefined, context: RefusalContext) {
  const current = classifyRefusal(request, context);
  if (current) return current;
  // Only host-bound continuations are eligible. A generated plan, search
  // query or page text cannot supply a new user instruction.
  const resolved = resolution?.kind === 'follow_up' ? resolution.resolved : null;
  return resolved && resolved !== request ? classifyRefusal(resolved, { ...context, scope: resolution?.sourceAssessment }) : null;
}

const refusalRouting = (code: NonNullable<ReturnType<typeof classifyRefusal>>['code']) => ({
  route: 'unsupported', intent: 'unsupported', handler: 'unsupported', reason: 'request_refused', missingCapabilities: [],
  availability: code === 'no_capability' || code === 'no_access' || code === 'future' ? 'missing_capability' : 'restricted',
} satisfies NonNullable<BrainState['routing']>);

export function reviewRoutingRefusal(input: RequestRoutingInput, resolution: RequestResolution, scope: RequestScopeAssessment,
  previousContext: RequestContextState | null): RequestRoutingDecision | null {
  if (!refusalPolicyEnabled()) return null;
  // Routing's computer flag describes the remote adapter only. The worker
  // also accounts for the local desktop path before declaring it unavailable.
  const { computer: _computer, ...capabilities } = input.capabilities ?? {};
  const decision = classifyTurn(input.text, resolution, { fullAccess: input.fullAccess !== false, scope, capabilities })
    ?? reviewProposedHands(input.text);
  if (!decision) return null;
  return { version: 1, ...refusalRouting(decision.code),
    sourceAssessment: { ...scope, publicQueryEligible: false }, publicQuery: null,
    resolution: { ...resolution, query: null, nextState: previousContext } };
}

export function reviewWorkRefusal(request: string, state: BrainState, fullAccess: boolean, capabilities: RefusalContext['capabilities']) {
  const resolution = state.requestResolution ?? undefined;
  const context = { fullAccess, capabilities, scope: assessRequestScope(request, { contextKind: resolution?.kind }) };
  const original = resolution?.kind === 'answer' && !state.questionAnswer?.fields ? resolution.original : null;
  const enabled = refusalPolicyEnabled();
  // The worker may see different capabilities or a rewritten request. A
  // refusal recorded at admission must still stop the run before dispatch.
  const admittedRefusal: RefusalDecision | null = enabled && state.routing?.reason === 'request_refused'
    ? { code: 'no_capability', alternative: 'public_info' } : null;
  const decision = classifyTurn(request, resolution, context)
    ?? (original && original !== request ? classifyRefusal(original, { ...context, scope: assessRequestScope(original) }) : null)
    ?? (state.hands ? reviewHandsRefusal(state.hands.steps) : reviewProposedHands(request))
    ?? reviewPendingRefusal(state)
    ?? admittedRefusal;
  if (!decision) return null;
  logRefusalDecision(decision.code, enabled);
  if (!enabled) return null;
  state.routing = refusalRouting(decision.code);
  if (state.agentRun && !state.steps && !state.agentRun.plan) state.agentRun.path = 'direct';
  return refusalReply(decision, original ?? request);
}
