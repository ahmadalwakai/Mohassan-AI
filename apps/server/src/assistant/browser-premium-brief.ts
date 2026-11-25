import { BrowserPremiumBriefRequestSchema, browserPremiumBriefPath, type BrowserPremiumBriefData } from '@mohassan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { directRoute, sensitiveAction } from './brain.js';
import { fold, parseHands } from './hands.js';
import { requestActionText } from './request-context.js';
import { isEntireLiteralRequest, parseUserRequestConstraints, requestCapabilityAllowed } from './request-constraints.js';
import { requestScopeActionText } from './request-scope.js';

const authenticationPath = /(?:^|\/)(?:login|log-in|sign-in|signin|oauth2?|authenticate|verify|mfa|2fa|otp)(?:\/|$)/iu;
const authInstruction = /(?:^|[^\p{L}])(?:سجل الدخول|تسجيل الدخول|رمز التحقق|كلمه المرور|log[ -]?in|sign[ -]?in|verification code|password|otp)(?:$|[^\p{L}])/iu;

function webUrl(value: string): URL | null {
  try {
    const url = new URL(/^https?:\/\//iu.test(value) ? value : `https://${value}`);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function browserPremiumBrief(text: string, currentOrigin?: string): BrowserPremiumBriefData | null {
  const constraints = parseUserRequestConstraints(text);
  if (isEntireLiteralRequest(text) || !requestCapabilityAllowed(constraints, 'browser_navigation')) return null;
  const request = requestActionText(requestScopeActionText(text));
  const plan = parseHands(request);
  const route = directRoute(request);
  const currentPage = currentOrigin ? webUrl(currentOrigin) : null;
  if (!plan?.length && !route) return null;

  const sites = new Set<string>();
  let mayRequireLogin = false;
  const addSite = (value: string) => {
    const url = webUrl(value);
    if (!url || url.hostname.length > 253) return;
    sites.add(url.hostname);
    mayRequireLogin ||= authenticationPath.test(url.pathname);
  };
  let writes = false;
  let reads = false;
  let opens = false;
  let searches = false;
  for (const step of plan ?? []) {
    switch (step.kind) {
      case 'open': opens = true; addSite(step.url); break;
      case 'news': reads = true; addSite(step.source.url); break;
      case 'search': searches = true; if (step.site) addSite(step.site.url); break;
      case 'click': case 'type': writes = true; break;
      default: reads = true;
    }
  }
  if (route && !opens) { addSite(route.url); opens = true; }
  if (!sites.size && !searches) {
    if (!currentPage) return null;
    addSite(currentPage.origin);
  }
  if (writes && !requestCapabilityAllowed(constraints, 'browser_action')) return null;
  if (searches && !requestCapabilityAllowed(constraints, 'public_search')) return null;

  const guardedAction = writes || Boolean(route && !route.finishes && sensitiveAction(request));
  const summary = guardedAction ? 'سأفتح الصفحة المطلوبة وأنفّذ الإجراء الذي طلبته.'
    : route?.screenshot ? 'سأفتح الصفحة وأعرض لك لقطة شاشة.'
      : searches ? 'سأبحث في الويب وأراجع النتائج ذات الصلة.'
        : opens && reads ? 'سأفتح الصفحة وأقرأ محتواها.'
          : opens ? 'سأفتح الصفحة المطلوبة وأتحقق من تحميلها.' : 'سأراجع محتوى الصفحة.';
  return {
    summary, sites: [...sites].slice(0, 6),
    needs: guardedAction ? ['login', 'code', 'approval'] : ['login', 'code'],
    requiresStart: guardedAction || mayRequireLogin || authInstruction.test(fold(request)),
  };
}

export function registerBrowserPremiumBrief(app: FastifyInstance, owner: (request: FastifyRequest) => Promise<unknown>) {
  app.post(browserPremiumBriefPath, { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    await owner(request);
    const { text, currentOrigin } = BrowserPremiumBriefRequestSchema.parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(browserPremiumBrief(text, currentOrigin));
  });
}
