import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApplication } from '../apps/server/src/app.js';
import { ADS_SKILL_SLUG } from '../apps/server/src/assistant/ads-check.js';

/**
 * Real Groq with a throwaway in-memory database and no browser. It proves the model
 * uses the skill and ads_check. It never opens the configured database or a Google account.
 */
dotenv.config({ quiet: true, override: true });
if (!process.argv.includes('--live')) throw new Error('أضف --live لتشغيل فحص مهارة Google Ads مع Groq.');

const GOAL = 'جهز مسودة حملة Google Ads بحثية لشركة نقل أثاث اسمها MA Removals في غلاسكو. الميزانية 20 جنيهًا يوميًا والهدف مكالمات الحجز. لا تفتح أي موقع. اكتب هنا في المحادثة عناوين الإعلان والأوصاف والكلمات المفتاحية.';

async function main() {
  if (!process.env.GROQ_API_KEY) throw new Error('مفتاح Groq غير مجهز.');
  const dataDir = await mkdtemp(join(tmpdir(), 'mohassan-ads-live-'));
  const secret = () => randomBytes(32).toString('hex');
  const internal = secret(), setupToken = secret(), password = secret(), origin = 'http://127.0.0.1:3000', email = 'ads-live@example.test';
  // Chat receipts keep only the error code, so the provider's own reason is captured here.
  const rejected: { status: number; body: string }[] = [];
  const recording: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) rejected.push({ status: response.status, body: (await response.clone().text()).slice(0, 2500) });
    return response;
  };
  const application = await createApplication({
    authSecret: secret(), internalSecret: internal, setupToken, webOrigin: origin, production: false, runWorker: false, skillEngineEnabled: true,
    groqApiKey: process.env.GROQ_API_KEY, groqModel: process.env.GROQ_MODEL, groqReasoningModel: process.env.GROQ_REASONING_MODEL,
    codingDataDir: join(dataDir, 'coding'), codingAllowedRoots: [join(dataDir, 'coding')], browserChannel: null, windowsEnabled: false, aiFetch: recording,
  });
  const headers = { 'x-mohassan-internal': internal, origin };
  try {
    await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { name: 'فحص مهارة الإعلانات', email, password, setupToken } });
    const login = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email, password } });
    const cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const api = (method: 'GET' | 'POST', url: string, payload?: object) => application.app.inject({ method, url, headers: { ...headers, cookie }, ...(payload ? { payload } : {}) });
    let skill = (await api('GET', '/api/skills?category=marketing')).json().items.find((item: { slug: string }) => item.slug === ADS_SKILL_SLUG);
    skill = (await api('POST', `/api/skills/${skill.id}/inspect`, { expectedRevision: skill.revision })).json().skill;
    await api('POST', `/api/skills/${skill.id}/activate`, { expectedRevision: skill.revision, approve: true });
    const created = (await api('POST', '/api/chat/conversations', { goal: GOAL })).json();
    await application.chat.settled(created.id);
    const detail = (await api('GET', `/api/chat/conversations/${created.id}`)).json();
    const run = await application.database.db.selectFrom('chat_runs').select('state').where('conversation_id', '=', created.id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    const state = (typeof run.state === 'string' ? JSON.parse(run.state) : run.state) as { adsApproved?: string[] | null; trail?: { action: string; result: string }[] };
    const checks = (state.trail ?? []).filter(entry => entry.action.startsWith('ads_check')).map(entry => entry.result);
    const receipts = await application.database.db.selectFrom('chat_model_receipts').select(['model', 'status', 'error_code']).execute();
    const report = {
      checkedAt: new Date().toISOString(), source: 'groq-live-throwaway-database', status: detail.status, error: detail.error,
      steps: detail.steps.map((step: { text: string }) => step.text), adsChecked: Boolean(state.adsApproved), checks, reply: detail.messages.at(-1)?.text, models: receipts, rejected,
    };
    await mkdir(resolve('artifacts'), { recursive: true });
    await writeFile(resolve('artifacts/live-google-ads.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.adsChecked || !checks.length) process.exitCode = 1;
  } finally { await application.app.close(); }
}

try { await main(); } catch (error) {
  console.error(JSON.stringify({ passed: false, message: error instanceof Error && !/postgres(?:ql)?:\/\//.test(error.message) ? error.message : 'فشل الفحص المنقح.' }));
  process.exitCode = 1;
}
