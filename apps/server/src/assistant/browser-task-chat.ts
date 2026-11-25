import { randomUUID } from 'node:crypto';
import {
  BrowserError, browserHumanStepTimeout, detectBrowserHumanStep, evidenceHash, findBrowserHandsElement, waitForBrowserHumanProgress, type AgentPage,
} from '@mohassan/browser';
import type { Kysely } from 'kysely';
import type { ChatSecureRequest } from '@mohassan/contracts';
import { addEvidence, planStep, setPlan, settleStep, startStep, tryEnterPhase, type RunLedger } from './agent-run.js';
import type { BrainState } from './brain.js';
import { browserTaskLabel, browserTaskSafeLocation, newBrowserTaskProgress, runBrowserTask, type BrowserTaskApproval, type BrowserTaskLog, type BrowserTaskPort, type BrowserTaskProgress, type BrowserTaskWait } from './browser-task-runner.js';
import { parseBrowserTask, type BrowserTaskSpec, type BrowserTaskStep } from './browser-task-spec.js';
import type { HandsStep } from './hands.js';

export type BrowserHandsMode = 'on' | 'shadow';

const MANUAL_NOTE = 'أكمل الخطوة في المتصفح. سأتابع عند التحقق من أن الصفحة أصبحت جاهزة.';
type TaskState = BrainState & { browserTask?: BrowserTaskProgress };
const stepId = (index: number) => `browser-task-${index + 1}`;

export function browserTaskProgress(state: BrainState, create = false): BrowserTaskProgress | undefined {
  const taskState = state as TaskState;
  if (create) taskState.browserTask ??= newBrowserTaskProgress();
  return taskState.browserTask;
}

export function browserTaskSecure(wait: BrowserTaskWait): Omit<ChatSecureRequest, 'id'> {
  return { kind: 'hands_on', site: wait.step.site, prompt: wait.step.prompt, note: MANUAL_NOTE, fields: [] };
}

export function isBrowserTaskSecure(secure: ChatSecureRequest | null) {
  return secure?.kind === 'hands_on' && secure.fields.length === 0 && secure.note === MANUAL_NOTE;
}

export function browserTaskVisibility(state: BrainState | null | undefined, secure: ChatSecureRequest | null) {
  const wait = state && isBrowserTaskSecure(secure) ? browserTaskProgress(state)?.waiting : undefined;
  if (!wait) return undefined;
  const code = wait.step.kind === 'login' ? 'needs_login' : wait.step.kind === 'code' ? 'needs_code' : 'hands_on';
  return { level: 3 as const, code, reason: wait.step.prompt } as const;
}

export function browserTaskShadow(task: BrowserTaskSpec) {
  return { risk: task.risk, target: task.target.kind, steps: task.steps.map(step => step.kind),
    missing: task.requiredData.filter(item => !item.supplied).map(item => item.kind) };
}

function capability(step: BrowserTaskStep) {
  if (step.kind === 'open') return 'browser.open';
  if (step.kind === 'find' && step.scope === 'web') return 'web.search';
  if (step.kind === 'fill' || step.kind === 'select') return 'browser.type';
  if (step.kind === 'click') return step.risk === 'irreversible' ? 'browser.submit' : 'browser.click';
  return 'browser.read';
}

const evidenceLabel = {
  'page-open': ['ظهرت الصفحة المطلوبة', 'Requested page observed'],
  'element-found': ['عُثر على العنصر', 'Element matched'],
  'content-read': ['قُرئ المحتوى المطلوب', 'Requested content read'],
  'value-read-back': ['قُرئت القيمة وطابقت المطلوب', 'Value read back and matched'],
  'effect-observed': ['رُصد أثر الإجراء', 'Action effect observed'],
  'file-downloaded': ['أكّد نقل الملف تنزيله', 'File transfer confirmed the download'],
  'file-selected': ['أكّد نقل الملف اختياره', 'File transfer confirmed the selection'],
  'human-completed': ['اكتملت الخطوة في المتصفح', 'Manual step completed in the browser'],
} as const;

export function planBrowserTask(ledger: RunLedger, task: BrowserTaskSpec, text: (label: string) => string, at: number) {
  ledger.path = 'action';
  if (ledger.plan?.steps.some(step => step.id === stepId(0))) return;
  tryEnterPhase(ledger, 'planning', at);
  if (!task.steps.length) return;
  setPlan(ledger, { version: 1, steps: task.steps.map((step, index) => {
    const evidence = task.success[index]?.kind;
    return planStep({ id: stepId(index), capability: capability(step), dependsOn: index ? [stepId(index - 1)] : [],
      outcome: text(browserTaskLabel(task, step)), input: null, acceptance: evidence ? [evidenceLabel[evidence][task.lang === 'ar' ? 0 : 1]] : [],
      ...(step.kind === 'fill' || step.kind === 'select' ? { verification: 'readback' } : {}) });
  }) }, at);
}

export function startBrowserTaskStep(ledger: RunLedger, index: number, at: number) {
  tryEnterPhase(ledger, 'executing', at);
  const step = ledger.plan?.steps.find(item => item.id === stepId(index));
  if (step?.state === 'pending' || step?.state === 'failed' || step?.state === 'awaiting_approval') startStep(ledger, step.id, at);
}

export function recordBrowserTaskLog(ledger: RunLedger, index: number, log: BrowserTaskLog, at: number) {
  const step = ledger.plan?.steps.find(item => item.id === stepId(index));
  if (!step) return;
  if (log.verified && step.state === 'running') settleStep(ledger, step.id, 'verified', at);
  addEvidence(ledger, { stepId: step.id, kind: log.kind === 'readback' ? 'readback' : 'observation',
    label: log.text.slice(0, 200), independent: log.verified }, at);
}

export async function noteBrowserTaskApproval(db: Kysely<any>, state: BrainState, runId: string, receiptId: string) {
  const pending = browserTaskProgress(state)?.approval;
  if (!pending) return;
  const receipt = await db.selectFrom('chat_effect_receipts').select(['status', 'response_status']).where('id', '=', receiptId)
    .where('run_id', '=', runId).executeTakeFirst();
  pending.released = receipt?.status === 'responded' && typeof receipt.response_status === 'number'
    && receipt.response_status >= 200 && receipt.response_status < 400;
}

export function skipBrowserTaskHandover(state: BrainState) {
  const progress = browserTaskProgress(state);
  if (progress?.waiting) progress.humanResult = { status: 'skipped', message: 'تخطّيت الخطوة اليدوية، فتوقفت المهمة عندها.' };
}

type WaitingResult = NonNullable<BrowserTaskProgress['humanResult']>;
export function createBrowserTaskWaiters() {
  const pending = new Map<string, { abort: AbortController; done: Promise<void> }>();
  function start(options: { conversationId: string; wait: BrowserTaskWait;
    observe: () => Promise<AgentPage | null>; isWaiting: () => Promise<boolean>; claim: (result: WaitingResult) => Promise<unknown> }) {
    const key = options.conversationId;
    pending.get(key)?.abort.abort();
    const abort = new AbortController();
    const wait = options.wait;
    const done = (async () => {
      const outcome = await waitForBrowserHumanProgress<AgentPage>({ step: wait.step, originalUrl: wait.origin.url, targetUrl: wait.targetUrl,
        signal: abort.signal,
        isStillBlocked: wait.target ? page => browserTaskSafeLocation(page.url) === wait.origin.url && findBrowserHandsElement(page.elements,
          wait.target!, { kind: wait.target!.kind, alternative: true }).status !== 'missing' : undefined,
        observe: async () => {
          if (!await options.isWaiting()) { abort.abort(); return null; }
          return options.observe();
        } }).catch(error => {
        if (abort.signal.aborted) throw error;
        return { status: 'timeout' as const, message: browserHumanStepTimeout(wait.step) };
      });
      if (abort.signal.aborted || !await options.isWaiting()) return;
      const result: WaitingResult = outcome.status === 'timeout' ? outcome
        : { status: outcome.status, page: { urlHash: evidenceHash(outcome.page.url), hash: outcome.page.hash } };
      await options.claim(result);
    })().catch(error => {
      if (!abort.signal.aborted && (!(error instanceof BrowserError) || !['CHAT_RESUME_CONFLICT', 'CHAT_SHUTTING_DOWN', 'CHAT_SESSION_UNAVAILABLE'].includes(error.code)))
        console.warn(JSON.stringify({ event: 'browser_hands_wait_failed', code: error instanceof BrowserError ? error.code : 'unexpected' }));
    }).finally(() => { if (pending.get(key)?.abort === abort) pending.delete(key); });
    pending.set(key, { abort, done });
  }
  return {
    start,
    stop(conversationId: string) { pending.get(conversationId)?.abort.abort(); },
    async close() {
      const waits = [...pending.values()];
      for (const wait of waits) wait.abort.abort();
      await Promise.all(waits.map(wait => wait.done));
    },
  };
}

export interface BrowserTaskChatPorts {
  mode: BrowserHandsMode;
  request: string;
  legacy: () => readonly HandsStep[] | null;
  page: AgentPage | null;
  state: BrainState;
  ledger: () => RunLedger;
  io: Omit<BrowserTaskPort, 'begin' | 'record'>;
  save: () => Promise<void>;
  log: (text: string) => Promise<void>;
  shadow: (summary: ReturnType<typeof browserTaskShadow>) => Promise<void>;
  finish: (text: string, status: 'completed' | 'partial' | 'blocked') => Promise<void>;
  handover: (wait: BrowserTaskWait, page: AgentPage) => Promise<void>;
  finishHandover: (page: { url: string; hash: string }) => Promise<AgentPage | null>;
  approve: (approval: BrowserTaskApproval, label: string) => Promise<void>;
}

export async function handleBrowserTaskChat(ports: BrowserTaskChatPorts): Promise<boolean> {
  const { page, mode, request, state, io } = ports;
  let progress = browserTaskProgress(state);
  const task = parseBrowserTask(request, { hasPage: Boolean(page || progress), legacy: ports.legacy() });
  if (mode === 'shadow') {
    if (task) await ports.shadow(browserTaskShadow(task)).catch(() => {});
    return false;
  }
  if (progress?.legacy) return false;
  if (!task) {
    if (!progress) return false;
    await ports.finish('توقفت المهمة لأن خطة المتصفح التي استؤنفت لم تعد مطابقة للطلب.', 'partial');
    return true;
  }
  progress = progress ?? browserTaskProgress(state, true)!;
  planBrowserTask(ports.ledger(), task, io.text, Date.now());
  await ports.save();
  let current = page;
  const resumed = progress.humanResult;
  if (resumed?.status === 'clear' || resumed?.status === 'next') {
    current = await restoreBrowserTaskHandoverPage(current, resumed.page, ports.finishHandover);
    if (!current) {
      await ports.finish('تغيّرت الصفحة أثناء تسليم التحكم. توقفت عند الخطوة اليدوية بانتظار مراجعتها.', 'partial');
      return true;
    }
    await ports.log('تحققت من الصفحة بعد الخطوة اليدوية واستعدت التحكم.');
  }
  const outcome = await runBrowserTask(task, progress, {
    ...io,
    begin: async index => {
      startBrowserTaskStep(ports.ledger(), index, Date.now());
      await ports.save();
    },
    record: async (index, record) => {
      const log = { ...record, text: io.text(record.text) };
      recordBrowserTaskLog(ports.ledger(), index, log, Date.now());
      state.steps++;
      await ports.log(log.text);
      await ports.save();
    },
  }, current);
  if (outcome.status === 'human') {
    progress.handovers = (progress.handovers ?? 0) + 1;
    if (progress.handovers > 8) {
      await ports.finish('توقفت المهمة بعد تكرار طلبات التدخل اليدوي في الموقع.', 'partial');
      return true;
    }
    progress.waiting = outcome.wait;
    recordBrowserTaskLog(ports.ledger(), progress.next, { text: outcome.wait.step.prompt, kind: 'handover', verified: false }, Date.now());
    await ports.handover(outcome.wait, outcome.page);
  } else if (outcome.status === 'approval') {
    await ports.approve(outcome.approval, outcome.label);
  } else {
    await ports.finish(io.text(outcome.text), outcome.status);
  }
  return true;
}

async function restoreBrowserTaskHandoverPage(page: AgentPage | null, expected: { urlHash: string; hash: string },
  finish: BrowserTaskChatPorts['finishHandover']) {
  if (!page || evidenceHash(page.url) !== expected.urlHash || page.hash !== expected.hash) return null;
  return finish({ url: page.url, hash: page.hash });
}

export function prepareLegacyBrowserHandover(state: BrainState, page: AgentPage): BrowserTaskWait | null {
  const step = detectBrowserHumanStep(page);
  if (!step) return null;
  const progress = browserTaskProgress(state, true)!;
  progress.legacy = true;
  const wait = { step, origin: { url: browserTaskSafeLocation(page.url) }, completeStep: false };
  progress.waiting = wait;
  return wait;
}

export async function resumeLegacyBrowserHandover(state: BrainState, page: AgentPage | null,
  finishHandover: BrowserTaskChatPorts['finishHandover'], finish: BrowserTaskChatPorts['finish']) {
  const progress = browserTaskProgress(state);
  if (!progress?.legacy || !progress.humanResult) return page;
  const outcome = progress.humanResult;
  if (outcome.status === 'timeout' || outcome.status === 'skipped') {
    await finish(outcome.message, 'partial');
    return null;
  }
  if (outcome.status !== 'clear' && outcome.status !== 'next') return null;
  const verified = await restoreBrowserTaskHandoverPage(page, outcome.page, finishHandover);
  if (!verified) {
    await finish('تغيّرت الصفحة أثناء تسليم التحكم. توقفت عند الخطوة اليدوية بانتظار مراجعتها.', 'partial');
    return null;
  }
  delete (state as TaskState).browserTask;
  return verified;
}

export async function pauseBrowserTaskChat(options: { db: Kysely<any>; conversationId: string; runId: string; ownerId: string;
  wait: BrowserTaskWait; state: BrainState; page: AgentPage; waiters: ReturnType<typeof createBrowserTaskWaiters>;
  keepPage: (page: AgentPage) => Promise<void>; log: (label: string) => Promise<void>;
  announce: (secure: ChatSecureRequest, visibility: ReturnType<typeof browserTaskVisibility>) => Promise<void>;
  pause: (secure: ChatSecureRequest) => Promise<void>; outsideRun: (job: () => void) => void;
  observe: () => Promise<AgentPage | null>; canWait: () => boolean; claim: (secureId: string, result: WaitingResult) => Promise<void> }) {
  const { db, ownerId, conversationId, runId, state, wait } = options;
  const secure = { id: randomUUID(), ...browserTaskSecure(wait) };
  await options.keepPage(options.page);
  await options.log(secure.prompt);
  await options.announce(secure, browserTaskVisibility(state, secure));
  await options.pause(secure);
  options.outsideRun(() => options.waiters.start({ conversationId, wait, observe: options.observe,
    isWaiting: async () => {
      if (!options.canWait()) return false;
      const row = await db.selectFrom('chat_conversations').select('secure').where('id', '=', conversationId)
        .where('owner_id', '=', ownerId).where('active_run_id', '=', runId).where('status', '=', 'waiting_input').executeTakeFirst();
      return row?.secure?.id === secure.id;
    },
    claim: result => options.claim(secure.id, result),
  }));
}
