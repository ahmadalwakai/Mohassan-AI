import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApplication } from '../apps/server/src/app.js';

/**
 * The owner's local model, real AppContainer, and a throwaway in-memory database and project.
 * It never opens the configured database, the owner's data or their devices.
 */
dotenv.config({ quiet: true, override: true });
if (!process.argv.includes('--live')) throw new Error('أضف --live لتشغيل فحص أدوات المساعد مع النموذج المحلي وبيئة العزل.');

async function main() {
  if (!process.env.LOCAL_MODEL_NAME) throw new Error('اضبط LOCAL_MODEL_NAME على اسم نموذج Ollama المحلي.');
  const dataDir = await mkdtemp(join(tmpdir(), 'mohassan-assistant-live-'));
  const secret = () => randomBytes(32).toString('hex');
  const internal = secret(), setupToken = secret(), password = secret(), origin = 'http://127.0.0.1:3000', email = 'assistant-live@example.test';
  const application = await createApplication({
    authSecret: secret(), internalSecret: internal, setupToken, webOrigin: origin, production: false, runWorker: true,
    localModel: { model: process.env.LOCAL_MODEL_NAME, baseUrl: process.env.LOCAL_MODEL_URL },
    codingDataDir: join(dataDir, 'coding'), codingAllowedRoots: [join(dataDir, 'coding')], browserChannel: null, windowsEnabled: false,
  });
  const headers = { 'x-mohassan-internal': internal, origin };
  try {
    if (!application.coding.available) throw new Error('محرك البرمجة غير متاح في هذه الجلسة.');
    await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { name: 'فحص أدوات المساعد', email, password, setupToken } });
    const login = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email, password } });
    const cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const api = (method: 'GET' | 'POST', url: string, payload?: object) => application.app.inject({ method, url, headers: { ...headers, cookie }, ...(payload ? { payload } : {}) });
    const ownerId = (await application.database.db.selectFrom('user').select('id').executeTakeFirstOrThrow()).id as string;
    const project = (await api('POST', '/api/coding/projects/demo', {})).json();

    async function settle(id: string) {
      for (let attempt = 0; attempt < 1800; attempt++) {
        const detail = (await api('GET', `/api/chat/conversations/${id}`)).json();
        if (detail.status !== 'running') return detail;
        await new Promise(done => setTimeout(done, 500));
      }
      throw new Error('انتهت مهلة المحادثة.');
    }
    const ask = async (goal: string) => settle((await api('POST', '/api/chat/conversations', { goal })).json().id);
    const brief = (detail: any) => ({ status: detail.status, error: detail.error, steps: detail.steps.map((step: any) => step.text), reply: detail.messages.at(-1)?.text?.slice(0, 400) });

    const saved = await ask('تذكر أن لوني المفضل هو الأزرق السماوي');
    const memory = await application.memory.search(ownerId, { query: 'الأزرق السماوي' });
    const recalled = await ask('ابحث في ذاكرتك: ما لوني المفضل؟');

    const waiting = await ask(`في مشروع «${project.name}» دالة الجمع معطلة. أصلحها.`);
    const pending = (await application.runtime.snapshot(ownerId)).tasks.find(task => task.capabilityId === 'coding.change');
    const beforeApproval = pending?.status ?? null;
    let finished: any = waiting;
    if (waiting.status === 'waiting_approval') {
      await api('POST', `/api/chat/conversations/${waiting.id}/approve`, { approvalId: waiting.approval.id, approved: true });
      finished = await settle(waiting.id);
    }
    const task = pending ? (await application.runtime.detail(ownerId, pending.id)).task : null;
    const result = task?.result as Record<string, any> | null;
    const report = {
      checkedAt: new Date().toISOString(), source: 'local-ollama-live-and-native-appcontainer',
      memory: { saved: brief(saved), itemsFound: memory.items.length, recalled: brief(recalled), answerUsedMemory: /الأزرق السماوي/.test(recalled.messages.at(-1)?.text ?? '') },
      coding: { approvalShown: waiting.status === 'waiting_approval', taskBeforeApproval: beforeApproval, finished: brief(finished), taskStatus: task?.status ?? null, outcome: result?.outcome ?? null, merged: result?.merged ?? null, sourceUnchanged: result?.sourceUnchanged ?? null },
    };
    const receipts = await application.database.db.selectFrom('chat_model_receipts').select(['model', 'status', 'error_code', 'http_status', 'retry_reason']).where('status', '!=', 'succeeded').execute();
    Object.assign(report, { modelFailures: receipts });
    await mkdir(resolve('artifacts'), { recursive: true });
    await writeFile(resolve('artifacts/live-assistant.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    const passed = report.memory.itemsFound > 0 && report.memory.answerUsedMemory && report.coding.approvalShown && report.coding.taskBeforeApproval === 'waiting_approval' && report.coding.taskStatus === 'completed' && report.coding.merged === false;
    if (!passed) process.exitCode = 1;
  } finally { await application.app.close(); }
}

try { await main(); } catch (error) {
  console.error(JSON.stringify({ passed: false, message: error instanceof Error && !/postgres(?:ql)?:\/\//.test(error.message) ? error.message : 'فشل فحص المساعد المنقح.' }));
  process.exitCode = 1;
}
