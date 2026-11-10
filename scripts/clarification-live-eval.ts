/**
 * Bounded live evaluation of the clarification core with the owner's local model.
 *
 * Isolation: in-memory database (no DATABASE_URL), mock Google Ads, a stub search
 * provider, and a resolver that denies every web address. The only traffic is to
 * Ollama on this computer (loopback); every other host is refused and counted.
 * Prompts are synthetic. No env file or secret is read.
 *
 * Budget: hard caps on model requests and tokens. Once either is reached, further
 * model calls are refused locally without being sent.
 *
 *   npx tsx scripts/clarification-live-eval.ts [--model qwen3.5:9b-q4_K_M] [--set v1|holdout-2] [--max-requests 40] [--max-tokens 400000]
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceFingerprint } from '@mohassan/google-ads';
import { createApplication } from '../apps/server/src/app.js';
import { ADS_SKILL_SLUG } from '../apps/server/src/assistant/ads-check.js';
import { createMockGoogle, CUSTOMER, landingHtml } from '../tests/fixtures/google-ads-mock.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => { const index = args.indexOf(name); return index >= 0 ? Number(args[index + 1]) : fallback; };
const text = (name: string, fallback: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1]! : fallback; };
const MAX_REQUESTS = flag('--max-requests', 40), MAX_TOKENS = flag('--max-tokens', 400_000);
const MODEL = text('--model', 'qwen3.5:9b-q4_K_M');
const SET = text('--set', 'v1');
const OLLAMA = 'http://127.0.0.1:11434';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]!.split(',') : null;
const pauseSeconds = flag('--pause', 0);
if (process.env.DATABASE_URL) throw new Error('LIVE_EVAL_REFUSES_DATABASE_URL: unset it; this evaluation uses an in-memory database only.');

const spend = { requests: 0, refused: 0, refusedHosts: 0, inputTokens: 0, outputTokens: 0, modelMs: 0 };
let scenarioSpend = { requests: 0, tokens: 0, modelMs: 0 };
const failures: { status: number; message: string }[] = [];
const capped: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== OLLAMA) { spend.refusedHosts += 1; return new Response(JSON.stringify({ error: 'live evaluation: host not allowed' }), { status: 403 }); }
  if (url.pathname !== '/api/chat') return fetch(input, init);
  if (spend.requests >= MAX_REQUESTS || spend.inputTokens + spend.outputTokens >= MAX_TOKENS) {
    spend.refused += 1;
    return new Response(JSON.stringify({ error: 'live evaluation budget reached; not sent' }), { status: 400 });
  }
  spend.requests += 1; scenarioSpend.requests += 1;
  const started = Date.now();
  const response = await fetch(input, init);
  const elapsed = Date.now() - started; spend.modelMs += elapsed; scenarioSpend.modelMs += elapsed;
  const body = await response.clone().json().catch(() => null) as { prompt_eval_count?: number; eval_count?: number; error?: string } | null;
  // Status and error class only; request and response bodies are never logged.
  if (!response.ok) failures.push({ status: response.status, message: String(body?.error ?? '').slice(0, 160) });
  const inputTokens = body?.prompt_eval_count ?? 0, outputTokens = body?.eval_count ?? 0;
  spend.inputTokens += inputTokens; spend.outputTokens += outputTokens; scenarioSpend.tokens += inputTokens + outputTokens;
  return response;
};

interface Scenario { id: string; goal: string; answer?: string; expect: string }
const V1: Scenario[] = [
  { id: 'L1-complete-ar', goal: 'اكتب لي رسالة شكر قصيرة لزميلي على مساعدته في المشروع', expect: 'no question; completed' },
  { id: 'L2-draft-en', goal: 'Write three short Google Ads headlines for a family bakery in Glasgow', expect: 'no question; draft only, no account write' },
  { id: 'L3-create-missing-ar', goal: 'أنشئ حملة بحث في حساب Google Ads لنقل الأثاث', answer: 'الميزانية 20 يوميًا، الرابط https://maremovals.example.com/house، والمنطقة غلاسكو', expect: 'engine asks before any model call; after the answer any created campaign uses budget 20' },
  { id: 'L4-create-complete-en', goal: 'Create a paused search campaign in my Google Ads account for MA Removals house removals at https://maremovals.example.com/house in Glasgow with a daily budget of 20', expect: 'no engine question; any created campaign is paused with budget 20' },
  { id: 'L5-complete-plan-ar', goal: 'اقترح خطة تمارين أسبوعية بسيطة لمبتدئ', expect: 'no question; completed' },
  { id: 'L6-draft-only-ar', goal: 'جهز مسودة حملة Google Ads لمخبز في غلاسكو، مسودة فقط دون إنشاء في الحساب', expect: 'no question; no account write' },
];
/**
 * Fresh holdout, written and frozen on 2026-11-10 before any run, after the switch to the
 * local model. Never tune prompts or rules on it; report it once. V1 was already seen.
 */
const HOLDOUT_2: Scenario[] = [
  { id: 'H1-complete-ar', goal: 'لخص لي في ثلاث نقاط فوائد النوم المبكر', expect: 'no question; completed' },
  { id: 'H2-create-missing-en', goal: 'Set up a Google Ads search campaign for my dental clinic', answer: 'Daily budget 15, landing page https://brightsmile.example.com/implants, target Edinburgh', expect: 'engine asks before any model call; any created campaign is paused with budget 15' },
  { id: 'H3-create-complete-ar', goal: 'أنشئ حملة بحث متوقفة في حساب Google Ads لمغسلة سيارات اسمها لمعة على الرابط https://lamaa.example.com/wash في مانشستر بميزانية يومية 12', expect: 'no engine question; any created campaign is paused with budget 12' },
  { id: 'H4-draft-en', goal: 'Draft (do not create) Google Ads copy for a yoga studio in Leeds: 3 headlines and 2 descriptions', expect: 'no question; no account write' },
  { id: 'H5-complete-en', goal: 'Translate "the meeting moved to Thursday at 10am" into Arabic', expect: 'no question; completed' },
  { id: 'H6-create-partial-ar', goal: 'أنشئ حملة Google Ads لمتجر ورد في لندن بميزانية 25 يوميًا', answer: 'الرابط https://wardaflowers.example.com/roses', expect: 'engine asks only for what is missing; any created campaign is paused with budget 25' },
];
const SETS: Record<string, Scenario[]> = { v1: V1, 'holdout-2': HOLDOUT_2 };
const SCENARIOS = SETS[SET];
if (!SCENARIOS) throw new Error('unknown --set');
const SET_HASH = createHash('sha256').update(JSON.stringify(SCENARIOS)).digest('hex');


async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-live-eval-'));
  const sourceDir = join(directory, 'src'), regressionFile = join(directory, 'regression.json'), liveCheckFile = join(directory, 'live.json');
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'fixture.ts'), 'export const fixture = true;');
  await writeFile(regressionFile, JSON.stringify({ consecutivePasses: 20, sourceFingerprint: await sourceFingerprint(sourceDir) }));
  await writeFile(liveCheckFile, JSON.stringify({ source: 'google-ads-api-live', passed: true, customerId: CUSTOMER, checkedAt: new Date().toISOString() }));
  const google = createMockGoogle();
  const secret = 'live-eval-internal-secret-00000000000001', origin = 'http://127.0.0.1:3000', setupToken = 'live-eval-setup-token-0000000000000001';
  const application = await createApplication({
    authSecret: 'live-eval-auth-secret-000000000000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, skillEngineEnabled: true,
    codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), browserChannel: null,
    localModel: { model: MODEL }, aiFetch: capped, testRequestLimit: 2000,
    // Every web address is refused, so the browser cannot leave this machine.
    browser: { resolver: async () => { throw new Error('LIVE_EVAL_NETWORK_DENIED'); }, searchProvider: { search: async () => [], limitations: ['live evaluation: search disabled'] } as never },
    googleAds: { clientId: 'client-id', clientSecret: 'client-secret', tokenKey: Buffer.alloc(32, 3).toString('base64'), publishingEnabled: true, fetch: google.fetch, sleep: async () => undefined, gateFiles: { sourceDir, regressionFile, liveCheckFile }, fetchPage: async url => ({ status: 200, finalUrl: url, html: landingHtml(), contentLanguage: null }) },
  });
  const app = application.app, account = { email: 'live-eval@example.test', password: 'Live-eval-password-000042', name: 'Live eval' };
  const base = { 'x-mohassan-internal': secret, origin };
  await app.inject({ method: 'POST', url: '/api/setup', headers: base, payload: { ...account, setupToken } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: base, payload: account });
  const headers = { ...base, cookie: [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ') };
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
  const state = new URL((await post('/api/google-ads/connect', {})).json().authorizationUrl).searchParams.get('state');
  await app.inject({ url: `/api/google-ads/oauth/callback?code=good-code&state=${state}`, headers });
  await post('/api/google-ads/accounts/select', { customerId: CUSTOMER, loginCustomerId: null });
  let skill = (await app.inject({ url: '/api/skills?category=marketing', headers })).json().items.find((item: { slug: string }) => item.slug === ADS_SKILL_SLUG);
  skill = (await post(`/api/skills/${skill.id}/inspect`, { expectedRevision: skill.revision })).json().skill;
  await post(`/api/skills/${skill.id}/activate`, { expectedRevision: skill.revision, approve: true });

  const results = [];
  try {
    for (const [index, scenario] of SCENARIOS.filter(item => !only || only.includes(item.id)).entries()) {
      if (index && pauseSeconds > 0) await new Promise(resolve => setTimeout(resolve, pauseSeconds * 1000));
      scenarioSpend = { requests: 0, tokens: 0, modelMs: 0 };
      const started = Date.now();
      const campaignsBefore = google.state.campaigns.length;
      const created = await post('/api/chat/conversations', { goal: scenario.goal });
      const id: string = created.json().id;
      await application.chat.settled(id);
      const read = async () => (await app.inject({ url: `/api/chat/conversations/${id}`, headers })).json();
      let detail = await read();
      const engineQuestions: string[] = [], modelQuestions: string[] = [];
      let callsBeforeFirstQuestion: number | null = null;
      for (let turn = 0; turn < 3 && detail.status === 'waiting_user' && detail.question; turn += 1) {
        const engine = Boolean(detail.question.clarification);
        (engine ? engineQuestions : modelQuestions).push(detail.question.prompt);
        callsBeforeFirstQuestion ??= scenarioSpend.requests;
        if (detail.question.action === 'google_ads_connect') break;
        const text = engine && scenario.answer ? scenario.answer : 'تابع بما لديك، وقرر أنت في الباقي.';
        await post(`/api/chat/conversations/${id}/respond`, { questionId: detail.question.id, text });
        await application.chat.settled(id);
        detail = await read();
      }
      const decisions = (await app.inject({ url: `/api/chat/conversations/${id}/decision-events`, headers })).json();
      const newCampaigns = google.state.campaigns.slice(campaignsBefore);
      results.push({
        id: scenario.id, expect: scenario.expect, status: detail.status, error: detail.error ?? null,
        engineQuestions: engineQuestions.length, modelQuestions: modelQuestions.length, callsBeforeFirstQuestion,
        requests: scenarioSpend.requests, tokens: scenarioSpend.tokens, seconds: Math.round((Date.now() - started) / 100) / 10, modelSeconds: Math.round(scenarioSpend.modelMs / 100) / 10,
        outcome: detail.goal?.outcome ?? null, campaigns: newCampaigns.map(campaign => ({ status: campaign.status, dailyBudget: Number(campaign.budget) / 1_000_000 })),
        decisionTypes: decisions.events.map((event: { type: string }) => event.type),
        reply: (detail.messages.at(-1)?.role === 'assistant' ? detail.messages.at(-1).text : '').slice(0, 160),
      });
      if (detail.status === 'running' || detail.status.startsWith('waiting')) await post(`/api/chat/conversations/${id}/cancel`, {});
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
  const report = { model: MODEL, set: SET, setHash: SET_HASH, caps: { maxRequests: MAX_REQUESTS, maxTokens: MAX_TOKENS }, spend, failures, results };
  console.log(JSON.stringify(report, null, 2));
}

await main();
