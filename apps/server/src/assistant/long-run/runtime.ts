import { createHash, randomUUID } from 'node:crypto';
import { BrowserError } from '@mohassan/browser';
import { ChatApproveSchema, ChatSecureSubmitSchema, type NotificationKind } from '@mohassan/contracts';
import { sql, type Kysely } from 'kysely';
import { recordBackgroundRunOutcome, recordNotificationOutcome } from '../../notifications-store.js';
import {
  addEvidence, decideVerdict, enterPhase, settleStep, setStepAuthorization, startStep, tryEnterPhase,
} from '../agent-run.js';
import { checkPermission, consumePermission, recordDecision, requestPermission, type ActionMaterial } from '../permission-gate.js';
import { nextLongRunDueAt } from './execution-guards.js';
import {
  initialLongRunState, LONG_RUN_ACTIVE, LONG_RUN_LIMITS, LONG_RUN_WORKER, LongRunStateSchema, restoreLongRunState, say, stepId,
  type LongRunObservation, type LongRunPlan, type LongRunState, type LongRunStep,
} from './state.js';

export type LongRunResult =
  | { kind: 'searched'; urls: string[] }
  | { kind: 'observed'; observation: LongRunObservation }
  | { kind: 'site'; id: string; text: string; partial: boolean }
  | { kind: 'verified' }
  | { kind: 'unavailable' }
  | { kind: 'input'; reason: 'sign_in' | 'credentials' | 'payment'; site: string };
export interface LongRunPorts {
  accountActive?: (ownerId: string, tx: Kysely<any>) => Promise<boolean>;
  execute: (input: { ownerId: string; conversationId: string; operation: LongRunStep; state: Readonly<LongRunState>; signal: AbortSignal }) => Promise<LongRunResult>;
}

export class LongRunTransientError extends Error {}
const due = sql<number>`(state->'longRun'->>'dueAt')::bigint`;
const legacyLease = sql<Date>`TIMESTAMPTZ '9999-12-31 00:00:00+00'`;
const activeAccount = (ports: LongRunPorts, ownerId: string, tx: Kysely<any>) => ports.accountActive?.(ownerId, tx) ?? true;
const attempts = (state: LongRunState) => state.agentRun.plan!.steps[state.longRun.next]!.attempts;
const isOnce = (step: LongRunStep) => step.kind === 'build_site';
const markdownText = (text: string) => text.replace(/[\\[\]<>*_#`]/gu, '\\$&');
const safeLabel = (text: string) => markdownText(text.replace(/\s+/gu, ' '));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

type Row = {
  id: string;
  owner_id: string;
  conversation_id: string;
  created_at: Date;
  status: (typeof LONG_RUN_ACTIVE)[number];
  state: unknown;
};
type Claim = { row: Row; state: LongRunState; operation: LongRunStep; token: string };
type Result = LongRunResult | { kind: 'transient' | 'failed' | 'unknown' };

async function withinSignal<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([execute(), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

function progressId(runId: string, index: number) {
  const key = hash(`${runId}/checkpoint/${index}`);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
}
function approvalMaterial(row: Row, state: LongRunState): ActionMaterial {
  const draft = state.longRun.steps.find(step => step.kind === 'prepare_site');
  if (!draft) throw new Error('Missing draft for the long-run approval.');
  return { capability: 'site.build', target: draft.brief.name,
    details: { briefHash: hash(JSON.stringify(draft.brief)), conversationId: row.conversation_id },
    action: say(state.longRun.language, 'إنشاء مسودة الموقع', 'Create the draft site'),
    consequence: say(state.longRun.language, 'تُحفظ مسودة في مساحة العمل.', 'A draft is saved to your workspace.'),
    reversible: true };
}
function finalReply(state: LongRunState) {
  const data = state.longRun;
  if (data.site) return data.site.text;
  if (data.steps[0]?.kind === 'monitor') {
    const changed = data.observations.some((item, index) => index > 0 && item.hash !== data.observations[index - 1]?.hash);
    const headline = changed
      ? say(data.language, 'تغيّر نص الصفحة أثناء المراقبة.', 'The page text changed during monitoring.')
      : say(data.language, 'بقي نص الصفحة كما هو خلال الفحوص.', 'The page text stayed the same across checks.');
    const source = data.observations.at(-1)!;
    return `${headline}\n\n${say(data.language, 'عدد الفحوص', 'Checks')}: ${data.observations.length}. [${safeLabel(source.title)}](<${source.url}>).`;
  }
  const intro = say(data.language, `قرأت ${data.observations.length} من المصادر العامة.`, `I read ${data.observations.length} public sources.`);
  const length = data.background?.replyLength;
  const excerptLimit = length === 'short' ? 160 : length === 'medium' ? 360 : 700;
  const sources = data.observations.map(item => {
    const excerpt = item.quote.length <= excerptLimit ? item.quote : `${item.quote.slice(0, excerptLimit).trimEnd()}…`;
    return `[${safeLabel(item.title)}](<${item.url}>) — ${safeLabel(excerpt)}`;
  });
  if (length === 'short') return `${intro} ${sources.join(' | ')}`;
  const heading = length === 'long' ? `${say(data.language, '### المصادر', '### Sources')}\n\n` : '';
  return `${intro}\n\n${heading}${sources.map(source => `- ${source}`).join('\n')}`;
}

export function createLongRunRuntime(db: Kysely<any>, ports: LongRunPorts, options: { now?: () => number; onError?: () => void } = {}) {
  const now = options.now ?? Date.now;
  const onError = options.onError ?? (() => console.error('[long-run] Poll failed; retrying.'));
  const work = new Map<string, { controller: AbortController; task: Promise<void> }>();
  let tick: Promise<void> | undefined;
  let interval: NodeJS.Timeout | undefined;
  let stopping = false;

  async function lockByConversation(tx: Kysely<any>, conversationId: string, ownerId?: string): Promise<Row | undefined> {
    let conversation = tx.selectFrom('chat_conversations').select(['id', 'owner_id', 'active_run_id', 'status']).where('id', '=', conversationId);
    if (ownerId !== undefined) conversation = conversation.where('owner_id', '=', ownerId);
    const chat = await conversation.forUpdate().executeTakeFirst();
    if (!chat?.active_run_id) return undefined;
    return tx.selectFrom('chat_runs').select(['id', 'owner_id', 'conversation_id', 'created_at', 'status', 'state'])
      .where('id', '=', chat.active_run_id).where('owner_id', '=', chat.owner_id).where('conversation_id', '=', conversationId)
      .where('worker_id', '=', LONG_RUN_WORKER).where('status', '=', chat.status).where('status', 'in', LONG_RUN_ACTIVE)
      .forUpdate().executeTakeFirst() as Promise<Row | undefined>;
  }

  async function notify(tx: Kysely<any>, row: Row, kind: NotificationKind, time: number, taskId = row.id) {
    await recordNotificationOutcome(tx, { taskId, userId: row.owner_id, conversationId: row.conversation_id, startedAt: row.created_at, kind }, new Date(time));
  }

  async function notifyBackground(tx: Kysely<any>, row: Row, state: LongRunState, time: number,
    outcome: 'completed' | 'approval' | 'sign-in' | 'payment' | 'failed', preview?: string) {
    await recordBackgroundRunOutcome(tx, { runId: row.id, userId: row.owner_id, conversationId: row.conversation_id, startedAt: row.created_at,
      outcome, step: state.longRun.next, language: state.longRun.language, ...(preview ? { preview } : {}) }, new Date(time));
  }

  async function save(tx: Kysely<any>, row: Row, state: LongRunState, time: number, status: string = row.status) {
    await tx.updateTable('chat_runs').set({
      state: JSON.stringify(LongRunStateSchema.parse(state)), status, updated_at: new Date(time), steps: state.longRun.next,
    }).where('id', '=', row.id).execute();
  }

  async function message(tx: Kysely<any>, conversationId: string, text: string, time: number, role: 'user' | 'assistant' = 'assistant') {
    await tx.insertInto('chat_messages').values({ id: randomUUID(), conversation_id: conversationId, text, role, created_at: new Date(time) }).execute();
  }

  async function finish(tx: Kysely<any>, row: Row, state: LongRunState, time: number, status: 'completed' | 'partial' | 'blocked', detail: string, sendNotice = true) {
    state.longRun.inFlight = null;
    const verdict = decideVerdict(state.agentRun, { hostStatus: status, at: time });
    await save(tx, row, state, time, verdict.status);
    await tx.updateTable('chat_conversations').set({ status: 'idle', active_run_id: null, approval: null, secure: null, progress: null, error: null, updated_at: new Date(time) })
      .where('id', '=', row.conversation_id).execute();
    if (!sendNotice) return;
    const completed = verdict.status === 'completed';
    if (state.longRun.background) {
      await message(tx, row.conversation_id, detail, Math.max(time, new Date(row.created_at).getTime() + 1));
      await notifyBackground(tx, row, state, time, completed ? 'completed' : 'failed', completed ? detail : undefined);
    } else {
      await message(tx, row.conversation_id, detail, time);
      await notify(tx, row, completed ? 'task_completed' : 'task_failed', time);
    }
  }

  async function blocked(tx: Kysely<any>, row: Row, state: LongRunState, time: number, ar: string, en: string) {
    await finish(tx, row, state, time, 'blocked', say(state.longRun.language, ar, en));
  }

  async function admission(ownerId: string, conversationId: string, text: string, plan: LongRunPlan) {
    const time = now(), id = randomUUID();
    const state = initialLongRunState(id, plan, time);
    await db.transaction().execute(async tx => {
      const chat = await tx.selectFrom('chat_conversations').select(['status', 'active_run_id', 'title'])
        .where('id', '=', conversationId).where('owner_id', '=', ownerId).forUpdate().executeTakeFirst();
      if (!chat) throw new BrowserError('CHAT_NOT_FOUND', 'لم يُعثر على المحادثة.', 404);
      if (!await activeAccount(ports, ownerId, tx)) throw new BrowserError('CHAT_ACCOUNT_INACTIVE', 'هذا الحساب غير نشط.', 403);
      if (chat.active_run_id) throw new BrowserError('CHAT_BUSY', say(plan.language, 'أوقف العمل الحالي قبل بدء مهمة أخرى في المحادثة.', 'Stop the current work before starting another task in this conversation.'), 409);
      // This marker delegates lease ownership to the scheduler. The legacy
      // expiry sweep leaves the outer lease alone; the checkpoint carries the
      // actual short lease and due time for takeover.
      const inserted = await tx.insertInto('chat_runs').values({ id, conversation_id: conversationId, owner_id: ownerId, status: 'running', goal: text,
        lease_token: randomUUID(), worker_id: LONG_RUN_WORKER, lease_expires_at: legacyLease, state: JSON.stringify(state), created_at: new Date(time), updated_at: new Date(time) })
        .onConflict(conflict => conflict.doNothing()).returning('id').executeTakeFirst();
      if (!inserted) throw new BrowserError('CHAT_LONG_RUN_ACTIVE', say(plan.language, 'لديك مهمة طويلة جارية بالفعل. أوقفها قبل بدء مهمة أخرى.', 'You have an active long-running task. Stop it before starting another.'), 409);
      await message(tx, conversationId, text, plan.background ? time - 1 : time, 'user');
      if (plan.background) {
        await message(tx, conversationId, say(plan.language, 'سأعمل على هذا في الخلفية وأرسل لك النتيجة عند الانتهاء.',
          "I'll work on this in the background and notify you when it's done."), time);
      }
      await tx.updateTable('chat_conversations').set({ status: 'running', active_run_id: id,
        ...(chat.title === 'محادثة جديدة' ? { title: text.slice(0, 100) } : {}),
        progress: say(plan.language, 'بدأت المهمة الطويلة.', 'Long-running task started.'), error: null, updated_at: new Date(time) })
        .where('id', '=', conversationId).execute();
    });
    return id;
  }

  async function askApproval(tx: Kysely<any>, row: Row, state: LongRunState, material: ActionMaterial, time: number) {
    const id = randomUUID(), index = state.longRun.next;
    const permission = requestPermission(state.agentRun, { approvalId: id, actorId: row.owner_id, conversationId: row.conversation_id, runId: row.id,
      material, stepId: stepId(index), at: time, ttlMs: state.longRun.deadline - time });
    settleStep(state.agentRun, stepId(index), 'awaiting_approval', time);
    enterPhase(state.agentRun, 'awaiting_approval', time);
    const prompt = say(state.longRun.language, 'هل توافق على إنشاء مسودة الموقع؟', 'Approve creating the draft site?');
    state.longRun.dueAt = state.longRun.deadline;
    await save(tx, row, state, time, 'waiting_approval');
    await tx.updateTable('chat_conversations').set({ status: 'waiting_approval', progress: null,
      approval: JSON.stringify({ id, prompt, detail: material.consequence, target: material.target, consequence: material.consequence, reversible: material.reversible }), updated_at: new Date(time) })
      .where('id', '=', row.conversation_id).execute();
    if (state.longRun.background) await notifyBackground(tx, row, state, time, 'approval');
    else await notify(tx, row, 'needs_you', time, permission.id);
  }

  async function claim(candidate: { id: string; conversation_id: string }): Promise<Claim | undefined> {
    return db.transaction().execute(async tx => {
      const row = await lockByConversation(tx, candidate.conversation_id);
      if (!row || row.id !== candidate.id) return;
      const time = now(), state = restoreLongRunState(row.state, row.id);
      if (!state || state.longRun.dueAt > time) return;
      const data = state.longRun, current = data.steps[data.next], id = stepId(data.next);
      if (!await activeAccount(ports, row.owner_id, tx)) {
        await finish(tx, row, state, time, 'blocked', '', false);
        return;
      }
      if (data.inFlight && current && isOnce(current)) {
        settleStep(state.agentRun, id, 'unknown', time);
        await blocked(tx, row, state, time, 'نتيجة إنشاء المسودة غير محسومة. راجع مواقعك قبل أن تطلب إنشاءها مجددًا.', 'The draft creation outcome is unknown. Check your sites before requesting another.');
        return;
      }
      if (time >= data.deadline || data.resources >= LONG_RUN_LIMITS.resourceUnits) {
        await blocked(tx, row, state, time, 'بلغت المهمة حد وقتها أو مواردها.', 'The task reached its time or resource limit.');
        return;
      }
      if (row.status !== 'running' || !current) return;
      if (data.inFlight) {
        settleStep(state.agentRun, id, 'failed', time);
        data.inFlight = null;
        if (attempts(state) >= LONG_RUN_LIMITS.attemptsPerStep) {
          await blocked(tx, row, state, time, 'توقف التنفيذ عند حد محاولات الخطوة.', 'This step reached its attempt limit.');
          return;
        }
      }
      if (current.kind === 'build_site' && current.approval) {
        const material = approvalMaterial(row, state);
        const gate = checkPermission(state.agentRun, { material, actorId: row.owner_id, conversationId: row.conversation_id,
          runId: row.id, actorAllowed: true, platformAllowed: true, at: time });
        if (gate.decision === 'ask') { await askApproval(tx, row, state, material, time); return; }
        if (gate.decision === 'deny') {
          await blocked(tx, row, state, time, 'تعذّر التحقق من الموافقة على هذه الخطوة.', 'Approval for this step could not be verified.');
          return;
        }
        consumePermission(state.agentRun, gate.record.id, time);
        setStepAuthorization(state.agentRun, id, 'granted', time);
      }
      const token = randomUUID();
      startStep(state.agentRun, id, time);
      data.resources++;
      const expiresAt = Math.min(time + LONG_RUN_LIMITS.leaseMs, data.deadline);
      data.inFlight = { token, expiresAt };
      data.dueAt = expiresAt;
      await save(tx, row, state, time);
      return { row, state, operation: current, token };
    });
  }

  async function pauseForInput(tx: Kysely<any>, row: Row, state: LongRunState, result: Extract<LongRunResult, { kind: 'input' }>, time: number) {
    const id = randomUUID();
    const prompt = result.reason === 'payment' ? say(state.longRun.language, 'يتطلب المصدر دفعًا. راجع الموقع بنفسك ثم اختر «أكملت» أو تخطَّ المصدر.', 'The source requires payment. Review it yourself, then choose Done or skip it.')
      : say(state.longRun.language, 'يتطلب المصدر تسجيل الدخول أو بيانات اعتماد. أكمل الخطوة على الموقع ثم اختر «أكملت» أو تخطَّ المصدر.', 'The source requires sign-in or credentials. Complete that on the site, then choose Done or skip it.');
    state.longRun.inputId = id;
    state.longRun.dueAt = state.longRun.deadline;
    enterPhase(state.agentRun, 'awaiting_input', time);
    await save(tx, row, state, time, 'waiting_input');
    await tx.updateTable('chat_conversations').set({ status: 'waiting_input', progress: null, updated_at: new Date(time),
      secure: JSON.stringify({ id, kind: 'hands_on', site: result.site.slice(0, 200), prompt, note: null, fields: [] }) })
      .where('id', '=', row.conversation_id).execute();
    if (state.longRun.background) await notifyBackground(tx, row, state, time, result.reason === 'payment' ? 'payment' : 'sign-in');
    else await notify(tx, row, 'needs_you', time, id);
  }

  async function settle(claimed: Claim, result: Result) {
    await db.transaction().execute(async tx => {
      const row = await lockByConversation(tx, claimed.row.conversation_id, claimed.row.owner_id);
      if (!row || row.id !== claimed.row.id) return;
      const time = now(), state = restoreLongRunState(row.state, row.id);
      if (!state || state.longRun.inFlight?.token !== claimed.token || state.longRun.inFlight.expiresAt <= time) return;
      const data = state.longRun, index = data.next, id = stepId(index);
      data.inFlight = null;
      if (!await activeAccount(ports, row.owner_id, tx)) {
        await finish(tx, row, state, time, 'blocked', '', false);
        return;
      }
      if (result.kind === 'transient' && attempts(state) < LONG_RUN_LIMITS.attemptsPerStep && data.resources < LONG_RUN_LIMITS.resourceUnits) {
        settleStep(state.agentRun, id, 'failed', time);
        data.dueAt = Math.min(data.deadline, time + 1000 * 2 ** (attempts(state) - 1));
        await save(tx, row, state, time);
        return;
      }
      if (result.kind === 'input') {
        settleStep(state.agentRun, id, 'failed', time);
        await pauseForInput(tx, row, state, result, time);
        return;
      }
      if (result.kind === 'unknown') {
        settleStep(state.agentRun, id, 'unknown', time);
        await blocked(tx, row, state, time, 'لا أستطيع التحقق من نتيجة هذه العملية. راجع الأثر قبل طلب تكرارها.', 'I could not verify this action’s outcome. Review its effect before requesting it again.');
        return;
      }
      const unavailable = result.kind === 'failed' || result.kind === 'transient' || result.kind === 'unavailable';
      settleStep(state.agentRun, id, unavailable ? 'failed' : 'verified', time);
      if (unavailable && state.agentRun.plan!.steps[index]!.required) {
        await blocked(tx, row, state, time, 'تعذّر إتمام خطوة مطلوبة.', 'A required step could not be completed.');
        return;
      }
      if (result.kind === 'searched') data.candidates = result.urls;
      if (result.kind === 'observed') {
        data.observations.push(result.observation);
        addEvidence(state.agentRun, { stepId: id, kind: 'observation', label: result.observation.title || result.observation.url, reference: result.observation.url, independent: true }, time, 'step');
      }
      if (result.kind === 'site') {
        data.site = { id: result.id, text: result.text, partial: result.partial };
        state.siteId = result.id;
      }
      data.next++;
      data.dueAt = nextLongRunDueAt(data, time);
      const step = state.agentRun.plan!.steps[index]!;
      await tx.insertInto('chat_events').values({ id: randomUUID(), conversation_id: row.conversation_id, run_id: row.id,
        kind: 'step', message: step.outcome, created_at: new Date(time) }).execute();
      if (data.next === data.steps.length) {
        if (!data.site && !data.observations.length) {
          await blocked(tx, row, state, time, 'لم أجد مصدرًا عامًا يمكن قراءته.', 'I could not read a public source.');
        } else await finish(tx, row, state, time, data.site?.partial ? 'partial' : 'completed', finalReply(state));
        return;
      }
      await save(tx, row, state, time);
      const progress = say(data.language, `الخطوات المعالجة: ${data.next} من ${data.steps.length}.`, `Steps processed: ${data.next} of ${data.steps.length}.`);
      await tx.updateTable('chat_conversations').set({ progress, updated_at: new Date(time) }).where('id', '=', row.conversation_id).execute();
      // Durably enqueue the first and every third non-terminal checkpoint.
      if (!data.background && (data.next === 1 || data.next % 3 === 0)) await notify(tx, row, 'task_progress', time, progressId(row.id, data.next));
    });
  }

  async function drive(claimed: Claim, controller: AbortController) {
    const duration = Math.min(LONG_RUN_LIMITS.attemptMs, claimed.state.longRun.deadline - now());
    const timeout = AbortSignal.timeout(Math.max(1, duration));
    const signal = AbortSignal.any([controller.signal, timeout]);
    let result: Result;
    try {
      signal.throwIfAborted();
      result = await withinSignal(signal, () => ports.execute({ ownerId: claimed.row.owner_id, conversationId: claimed.row.conversation_id,
        operation: claimed.operation, state: claimed.state, signal }));
      signal.throwIfAborted();
    } catch (error) {
      if (controller.signal.aborted) return;
      result = { kind: isOnce(claimed.operation) ? 'unknown' : timeout.aborted || error instanceof LongRunTransientError ? 'transient' : 'failed' };
    }
    if (!controller.signal.aborted) await settle(claimed, result);
  }

  async function poll(waitForWork: boolean) {
    if (stopping) return;
    if (work.size) {
      const running = await db.selectFrom('chat_runs').select('id').where('id', 'in', [...work.keys()])
        .where('worker_id', '=', LONG_RUN_WORKER).where('status', '=', 'running').execute();
      const active = new Set(running.map(row => row.id as string));
      for (const [id, worker] of work) if (!active.has(id)) worker.controller.abort(new Error('CHAT_CANCELLED'));
    }
    const slots = 4 - work.size;
    if (slots <= 0) return;
    let candidates = db.selectFrom('chat_runs').select(['id', 'conversation_id']).where('worker_id', '=', sql.lit(LONG_RUN_WORKER))
      .where(sql<boolean>`status IN ('running', 'waiting_approval', 'waiting_input')`).where(due, '<=', now()).orderBy(due).limit(slots);
    if (work.size) candidates = candidates.where('id', 'not in', [...work.keys()]);
    const tasks: Promise<void>[] = [];
    for (const candidate of await candidates.execute() as { id: string; conversation_id: string }[]) {
      if (stopping) break;
      const claimed = await claim(candidate);
      if (!claimed) continue;
      const controller = new AbortController();
      const task = drive(claimed, controller).catch(onError).finally(() => { work.delete(candidate.id); });
      work.set(candidate.id, { controller, task });
      tasks.push(task);
    }
    if (waitForWork) await Promise.all(tasks);
  }

  function runOnce(waitForWork = true) {
    tick ??= poll(waitForWork).finally(() => { tick = undefined; });
    return tick;
  }

  async function owns(ownerId: string, conversationId: string) {
    return Boolean(await db.selectFrom('chat_conversations as c').innerJoin('chat_runs as r', 'r.id', 'c.active_run_id')
      .select('r.id').where('c.id', '=', conversationId).where('c.owner_id', '=', ownerId).where('r.owner_id', '=', ownerId)
      .where('r.worker_id', '=', LONG_RUN_WORKER).executeTakeFirst());
  }

  async function approve(ownerId: string, conversationId: string, raw: unknown) {
    const { approvalId, approved } = ChatApproveSchema.parse(raw);
    return db.transaction().execute(async tx => {
      const time = now(), row = await lockByConversation(tx, conversationId, ownerId);
      const state = row && restoreLongRunState(row.state, row.id);
      const permission = state?.agentRun.permissions.find(item => item.id === approvalId && item.decision === 'asked');
      if (!row || !state || row.status !== 'waiting_approval' || !permission || time >= state.longRun.deadline)
        throw new BrowserError('CHAT_APPROVAL_CHANGED', 'This approval is no longer pending.', 409);
      if (!await activeAccount(ports, row.owner_id, tx)) throw new BrowserError('CHAT_ACCOUNT_INACTIVE', 'هذا الحساب غير نشط.', 403);
      const decision = recordDecision(state.agentRun, { approvalId, actorId: ownerId, conversationId, approved, at: time });
      if (decision.decision !== 'granted') {
        setStepAuthorization(state.agentRun, stepId(state.longRun.next), 'refused', time);
        await blocked(tx, row, state, time, 'لم توافق على المتابعة، فأوقفت المهمة.', 'The task stopped because you declined approval.');
        return;
      }
      enterPhase(state.agentRun, 'executing', time);
      state.longRun.dueAt = time;
      await save(tx, row, state, time, 'running');
      await tx.updateTable('chat_conversations').set({ status: 'running', approval: null, updated_at: new Date(time) }).where('id', '=', conversationId).execute();
    });
  }

  async function respondToInput(ownerId: string, conversationId: string, raw: unknown) {
    const input = ChatSecureSubmitSchema.parse(raw);
    if (input.action === 'submit') throw new BrowserError('CHAT_LONG_RUN_HANDS_ON', 'Complete this step directly on the site.', 409);
    await db.transaction().execute(async tx => {
      const time = now(), row = await lockByConversation(tx, conversationId, ownerId);
      const state = row && restoreLongRunState(row.state, row.id);
      if (!row || !state || row.status !== 'waiting_input' || state.longRun.inputId !== input.requestId || time >= state.longRun.deadline)
        throw new BrowserError('CHAT_SECURE_CHANGED', 'This request is no longer pending.', 409);
      if (!await activeAccount(ports, ownerId, tx)) throw new BrowserError('CHAT_ACCOUNT_INACTIVE', 'هذا الحساب غير نشط.', 403);
      const current = state.agentRun.plan!.steps[state.longRun.next]!;
      if (input.action === 'skip' || attempts(state) >= LONG_RUN_LIMITS.attemptsPerStep) {
        if (current.required || state.longRun.next + 1 === state.longRun.steps.length) {
          await blocked(tx, row, state, time, 'توقفت المهمة عند مصدر يتطلب تدخلك.', 'The task stopped at a source that requires your help.');
          return;
        }
        state.longRun.next++;
      }
      enterPhase(state.agentRun, 'executing', time);
      state.longRun.dueAt = time;
      state.longRun.inputId = null;
      await save(tx, row, state, time, 'running');
      await tx.updateTable('chat_conversations').set({ status: 'running', secure: null, updated_at: new Date(time) }).where('id', '=', conversationId).execute();
    });
  }

  return {
    admission, approve, owns, respondToInput, runOnce,
    wake: () => { if (!stopping) void runOnce(false).catch(onError); },
    stopWork: (runId: string) => work.get(runId)?.controller.abort(new Error('CHAT_CANCELLED')),
    start() {
      if (interval) return;
      stopping = false;
      const pollNow = () => { if (!tick) void runOnce(false).catch(onError); };
      interval = setInterval(pollNow, LONG_RUN_LIMITS.pollMs);
      interval.unref();
      pollNow();
    },
    async shutdown() {
      stopping = true;
      if (interval) clearInterval(interval);
      interval = undefined;
      const abort = () => { for (const entry of work.values()) entry.controller.abort(new Error('CHAT_SHUTDOWN')); };
      abort();
      await tick?.catch(() => {});
      abort();
      await Promise.all([...work.values()].map(entry => entry.task));
    },
  };
}
