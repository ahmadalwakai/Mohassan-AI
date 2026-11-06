import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GoogleAdsApprovalSchema, GoogleAdsBookingMapSchema, GoogleAdsDraftActionSchema, GoogleAdsMarketInputSchema, GoogleAdsReviseSchema, GoogleAdsSelectAccountSchema } from '@mohassan/contracts';
import { BrowserError, SafeNetwork, type NetworkPolicy } from '@mohassan/browser';
import { GoogleAdsError, type GoogleAdsControl, type LandingFetch } from '@mohassan/google-ads';

type Owner = (request: { headers: Record<string, unknown> }) => Promise<{ id: string }>;

const REDIRECTS = [301, 302, 303, 307, 308];
const OAUTH_RESULT = (value: string) => `/?googleAds=${value}#tools`;

/** Reads a landing page through the same public-network guard as the browser module. */
export function landingPageReader(policy?: NetworkPolicy) {
  const network = new SafeNetwork(policy);
  return async (url: string, signal?: AbortSignal): Promise<LandingFetch> => {
    let target = url;
    for (let hops = 0; hops <= 5; hops += 1) {
      const response = await network.request(target, { ...(signal ? { signal } : {}), maxBytes: 1_500_000 });
      if (REDIRECTS.includes(response.status) && response.headers.location) { target = network.validate(new URL(response.headers.location, target).href).href; continue; }
      return { status: response.status, finalUrl: target, html: response.body.toString('utf8'), contentLanguage: response.headers['content-language'] ?? null };
    }
    throw new BrowserError('BROWSER_REDIRECT_LIMIT', 'تجاوز المصدر حد إعادة التوجيه.');
  };
}

export async function registerGoogleAdsRoutes(app: FastifyInstance, { control, owner }: { control: GoogleAdsControl; owner: Owner }) {
  const reads = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const writes = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const Id = z.uuid();
  type Params = { Params: { id: string } };
  const user = async (request: FastifyRequest) => (await owner(request)).id;

  app.get('/api/google-ads/status', async request => control.status(await user(request)));
  app.post('/api/google-ads/connect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    z.object({}).strict().parse(request.body ?? {});
    return { authorizationUrl: await control.authorizationUrl(await user(request)) };
  });
  // Google sends the browser here, so a failure redirects with a fixed word and never echoes the query.
  app.get<{ Querystring: Record<string, unknown> }>('/api/google-ads/oauth/callback', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const ownerId = await user(request).catch(() => null);
    if (!ownerId) return reply.redirect(OAUTH_RESULT('signin'));
    const input = z.object({ code: z.string().min(1).max(2000), state: z.string().min(16).max(200) }).safeParse(request.query);
    if (!input.success) return reply.redirect(OAUTH_RESULT('denied'));
    try {
      await control.completeAuthorization(ownerId, input.data.code, input.data.state);
      return reply.redirect(OAUTH_RESULT('connected'));
    } catch (error) {
      if (error instanceof GoogleAdsError) return reply.redirect(OAUTH_RESULT('failed'));
      throw error;
    }
  });
  app.post('/api/google-ads/disconnect', writes, async request => { z.object({}).strict().parse(request.body ?? {}); const id = await user(request); await control.disconnect(id); return control.status(id); });
  app.get('/api/google-ads/accounts', reads, async request => ({ items: await control.listAccounts(await user(request)) }));
  app.post('/api/google-ads/accounts/select', writes, async request => { const id = await user(request), input = GoogleAdsSelectAccountSchema.parse(request.body); await control.selectAccount(id, input.customerId, input.loginCustomerId); return control.status(id); });
  app.post('/api/google-ads/booking-map', writes, async request => { const id = await user(request); await control.setBookingRules(id, GoogleAdsBookingMapSchema.parse(request.body).rules); return { ok: true }; });
  app.get<{ Querystring: { days?: string } }>('/api/google-ads/report', reads, async request => control.report(await user(request), z.coerce.number().int().default(30).parse(request.query.days)));
  app.get<{ Querystring: { days?: string } }>('/api/google-ads/recommendations', reads, async request => control.recommendations(await user(request), z.coerce.number().int().default(30).parse(request.query.days)));
  app.post('/api/google-ads/market', reads, async request => { const input = GoogleAdsMarketInputSchema.parse(request.body); return control.market(await user(request), input.seeds, input.locations, input.countryCode); });
  app.get('/api/google-ads/audit', reads, async request => ({ items: await control.auditLog(await user(request)) }));
  app.get('/api/google-ads/experiences', reads, async request => ({ items: await control.experiences(await user(request)) }));

  app.get('/api/google-ads/drafts', reads, async request => ({ items: await control.drafts(await user(request)) }));
  app.post('/api/google-ads/drafts', writes, async request => {
    const key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers['idempotency-key']);
    return control.createDraft(await user(request), request.body, key);
  });
  app.get<Params>('/api/google-ads/drafts/:id', reads, async request => control.draft(await user(request), Id.parse(request.params.id)));
  app.post<Params>('/api/google-ads/drafts/:id/revise', writes, async request => { const input = GoogleAdsReviseSchema.parse(request.body); return control.revise(await user(request), Id.parse(request.params.id), input.expectedRevision, input.brief); });
  const step = (path: string, run: (ownerId: string, id: string, revision: number) => Promise<unknown>) => app.post<Params>(`/api/google-ads/drafts/:id/${path}`, writes, async request => run(await user(request), Id.parse(request.params.id), GoogleAdsDraftActionSchema.parse(request.body).expectedRevision));
  step('save', control.save);
  step('validate', control.validate);
  step('verify', control.verify);
  step('publish', control.publish);
  step('launch', control.launch);
  step('reconcile', control.reconcile);
  step('discard', control.discard);
  for (const action of ['publish', 'launch'] as const) app.post<Params>(`/api/google-ads/drafts/:id/approve-${action}`, writes, async request => {
    const input = GoogleAdsApprovalSchema.parse(request.body);
    return control.approve(await user(request), Id.parse(request.params.id), action, input.expectedRevision, input.draftHash, input.customerId);
  });
  app.get<Params>('/api/google-ads/drafts/:id/launch-hash', reads, async request => ({ hash: control.launchHashFor(await control.draft(await user(request), Id.parse(request.params.id))) }));
}
