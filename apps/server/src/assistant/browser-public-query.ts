import { SafeNetwork, safeResumeUrl } from '@mohassan/browser';
import { parseHands } from './hands.js';
import { isSearchEntryElement } from './public-query-provenance.js';
import { assessRequestScope, isEntireLiteralRequest, parseUserRequestConstraints, requestCapabilityAllowed, requestScopeActionText } from './request-scope.js';

const publicUrls = new SafeNetwork();
export interface ExplicitPublicBrowserQueryReview {
  eligible: boolean;
  reason: 'eligible' | 'invalid_query' | 'source_not_public' | 'request_constraint' | 'unsupported_plan' | 'non_public_url' | 'query_not_public' | 'query_not_explicit';
}

/**
 * A narrow projection for an owner's literal search input in a supported public
 * browser plan. URL navigation alone grants no search, and this never changes
 * the ordinary source classification or accepts words from a model/page.
 */
export function reviewExplicitPublicBrowserQuery(request: string, query: string): ExplicitPublicBrowserQueryReview {
  const result = (eligible: boolean, reason: ExplicitPublicBrowserQueryReview['reason']): ExplicitPublicBrowserQueryReview => ({ eligible, reason });
  if (typeof request !== 'string' || typeof query !== 'string' || !query.trim() || query.length > 500) return result(false, 'invalid_query');
  const source = assessRequestScope(request);
  if (isEntireLiteralRequest(request) || source.source !== 'public_lookup' || source.scope !== 'public'
    || source.operation !== 'act' || source.destination !== 'browser_command') return result(false, 'source_not_public');
  const constraints = parseUserRequestConstraints(request);
  if (!['public_search', 'browser_navigation', 'browser_action'].every(capability => requestCapabilityAllowed(constraints, capability as 'public_search' | 'browser_navigation' | 'browser_action')))
    return result(false, 'request_constraint');
  const plan = parseHands(requestScopeActionText(request));
  if (!plan || plan[0]?.kind !== 'open' || plan.some(step => step.kind === 'news')) return result(false, 'unsupported_plan');
  try {
    for (const step of plan) {
      const address = step.kind === 'open' ? step.url : step.kind === 'search' ? step.site?.url : null;
      if (!address) continue;
      const url = new URL(address);
      if (!safeResumeUrl(url.href)) return result(false, 'non_public_url');
      publicUrls.validate(url.href); // Syntax/address guard only; transport still pins DNS at dispatch.
    }
  } catch { return result(false, 'non_public_url'); }
  const projected = assessRequestScope(query);
  if (['prior_conversation', 'local_state', 'supplied_content'].includes(projected.source)
    || projected.reasons.includes('credential_material') || projected.reasons.includes('unresolved_reference')
    || ['transform', 'compute', 'act', 'converse'].includes(projected.operation)) return result(false, 'query_not_public');
  const literal = query.trim();
  const explicit = plan.some(step => step.kind === 'search' && step.query.trim() === literal
    || step.kind === 'type' && step.text.trim() === literal && isSearchEntryElement({ role: 'textbox', label: step.field }));
  return explicit ? result(true, 'eligible') : result(false, 'query_not_explicit');
}
