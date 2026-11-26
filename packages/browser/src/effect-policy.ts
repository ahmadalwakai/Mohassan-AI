/**
 * One decision for every browser request, taken at the request boundary.
 * Owner policy of 2026-11-05 (option A): reads run, anything else waits for
 * approval. This module decides only; callers keep network and lease checks.
 */

export type EffectActor = 'agent' | 'owner' | 'page';

export interface EffectPermit {
  url: string;
  method: string;
  bodyHash: string;
  used: boolean;
  expiresAt: number;
}

export interface EffectRequest {
  url: string;
  method: string;
  bodyHash: string;
  /** Origin of the document that issued the request. */
  pageOrigin: string;
  /** Main-frame document navigation. Frames and resources are false. */
  topLevelNavigation: boolean;
  /** 'agent' inside an authorized action, 'owner' just after takeover input, otherwise 'page'. */
  actor: EffectActor;
  /** The exact URL the current action intends to open, if any. */
  expectedNavigation?: string;
  permit?: EffectPermit;
  now: number;
}

export type EffectDecision =
  | { kind: 'allow'; credentials: 'keep' | 'omit'; consumesPermit: boolean }
  /** Waits at the boundary for exact approval; nothing has been sent. */
  | { kind: 'hold'; reason: 'write' | 'cross_origin_navigation' }
  /** Dropped. Only an agent's own action reports it as that action's failure. */
  | { kind: 'deny'; code: 'AGENT_EFFECT_DENIED' | 'AGENT_EFFECT_UNKNOWN' | 'GOOGLE_ADS_TYPED_API_REQUIRED'; failsAction: boolean };

const READ_METHODS = new Set(['GET', 'HEAD']);

export const GOOGLE_ADS_TYPED_API_REQUIRED_MESSAGE = 'تغييرات Google Ads تحتاج التكامل الرسمي المربوط بالحساب والموافقة والقراءة اللاحقة؛ استخدم مسار Google Ads لإعداد التغيير ومراجعته. لم يُرسل طلب المتصفح.';

/** Generic browser approval has no Ads account/resource binding or read-back
 * contract. Login on accounts.google.com and Ads observations remain available;
 * writes must use the typed integration until an equivalent adapter exists. */
export function requiresGoogleAdsTypedApi(url: string, method: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return false;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  return ['ads.google.com', 'adwords.google.com', 'googleads.googleapis.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
}

function samePermit(request: EffectRequest): boolean {
  const permit = request.permit;
  return Boolean(permit && permit.url === request.url && permit.method === request.method && permit.bodyHash === request.bodyHash);
}

export function decideEffect(request: EffectRequest): EffectDecision {
  const failsAction = request.actor === 'agent';
  if (requiresGoogleAdsTypedApi(request.url, request.method)) return { kind: 'deny', code: 'GOOGLE_ADS_TYPED_API_REQUIRED', failsAction };
  if (samePermit(request)) {
    if (request.permit!.used) return { kind: 'deny', code: 'AGENT_EFFECT_UNKNOWN', failsAction: true };
    if (request.permit!.expiresAt > request.now) return { kind: 'allow', credentials: 'keep', consumesPermit: true };
    return { kind: 'deny', code: 'AGENT_EFFECT_DENIED', failsAction };
  }

  const read = READ_METHODS.has(request.method);
  const sameOrigin = new URL(request.url).origin === request.pageOrigin;

  // The person is acting on their own account, so their input is not an agent effect.
  if (request.actor === 'owner') return { kind: 'allow', credentials: 'keep', consumesPermit: false };

  if (request.topLevelNavigation) {
    // An observed link authorizes a read destination, never a script replacing
    // that navigation with a form POST to the same URL.
    if (request.actor === 'agent' && read && request.expectedNavigation === request.url) return { kind: 'allow', credentials: 'keep', consumesPermit: false };
    if (request.actor === 'agent' && read && sameOrigin) return { kind: 'allow', credentials: 'keep', consumesPermit: false };
    if (request.actor === 'agent') return { kind: 'hold', reason: read ? 'cross_origin_navigation' : 'write' };
    return { kind: 'deny', code: 'AGENT_EFFECT_DENIED', failsAction };
  }

  if (read) return { kind: 'allow', credentials: sameOrigin ? 'keep' : 'omit', consumesPermit: false };
  if (request.actor === 'agent') return { kind: 'hold', reason: 'write' };
  return { kind: 'deny', code: 'AGENT_EFFECT_DENIED', failsAction };
}
