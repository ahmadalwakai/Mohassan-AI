import { BrowserError, BrowserHumanStepError, detectBrowserHumanStep, type AgentAction, type AgentActionResult, type AgentBrowser, type AgentPage, type AgentSessionCheckpoint, type BrowserHumanStep } from '@mohassan/browser';
import { browserLiveHandoverNote, readBrowserLiveHandover, type BrowserLiveInput, type ChatSecureRequest } from '@mohassan/contracts';
import { sql, type Kysely } from 'kysely';
import { restoreRunLedger } from './agent-run.js';
import { situation, type BrainState } from './brain.js';
import { completeHandsStep } from './run-plans.js';

// The opt-in name and value come from https://github.com/ahmadalwakai/Mohassan-AI/pull/34 (retrieved 2026-11-27).
export type BrowserHandsFlag = 'on';

export type LiveHandsProgress = { prefix: string; index: number; actions: number; action?: AgentAction['kind']; opened?: string; undispatched?: boolean };
type SavedHandsHandover = Pick<LiveHandsProgress, 'prefix' | 'index' | 'opened' | 'undispatched'> & { dispatched?: true };
type HandoverState = BrainState & { browserLiveHandsHandover?: SavedHandsHandover };

function browserLiveStep(page: AgentPage, forced?: BrowserHumanStep['reason']): BrowserHumanStep | null {
  const url = URL.parse(page.url);
  if (!url || !['https:', 'http:'].includes(url.protocol)) return null;
  const legacy = situation(page);
  const hint = forced ?? (legacy === 'captcha' ? 'captcha' : legacy === 'cookies' ? 'consent'
    : legacy === 'otp' || legacy === 'device_prompt' ? 'code'
      : ['password', 'identifier', 'browser_refused'].includes(legacy) ? 'login' : null);
  const reason: BrowserHumanStep['reason'] | null = detectBrowserHumanStep(page)?.reason ?? hint;
  if (!reason) return null;
  const instructions = {
    login: 'سجّل الدخول بنفسك في المتصفح',
    code: 'أكمل التحقق من تسجيل الدخول بنفسك',
    captcha: 'أكمل التحقق البشري بنفسك في المتصفح',
    consent: 'راجع طلب الموافقة أو إعدادات الخصوصية واختر بنفسك في المتصفح',
  };
  return { kind: 'hands_on', site: url.origin, reason, prompt: `توقف العمل عند ${url.host}. ${instructions[reason]}، ثم اضغط «متابعة».` };
}

function browserLiveCard(page: AgentPage, reason?: BrowserHumanStep['reason']): Omit<ChatSecureRequest, 'id'> | null {
  const step = browserLiveStep(page, reason);
  return step && { kind: 'hands_on', site: step.site, prompt: step.prompt, fields: [], note: browserLiveHandoverNote };
}

export function rememberLiveHandsHandover(state: HandoverState, progress: LiveHandsProgress | undefined) {
  delete state.browserLiveHandsHandover;
  if (!progress || state.hands?.next !== progress.index + 1) return;
  const { prefix, index, opened, undispatched, actions, action } = progress;
  const step = state.hands.steps[index]?.kind;
  if (opened && actions === 1 && (step === 'open' || step === 'click' || step === 'news')) {
    state.browserLiveHandsHandover = { prefix, index, opened };
  } else if (actions === 1 && (step === 'click' && action === 'click' || step === 'back' && action === 'back')) {
    state.browserLiveHandsHandover = { prefix, index, dispatched: true };
  } else if (undispatched && actions === 0) state.browserLiveHandsHandover = { prefix, index, undispatched };
}

type PausePage = (page: AgentPage, reason?: BrowserHumanStep['reason']) => Promise<boolean>;
type LiveExecution = { ownerId: string; id: string; runId: string; state?: BrainState; full: boolean; liveHands?: LiveHandsProgress };

export async function pauseBrowserLivePage(input: {
  enabled: boolean;
  current?: LiveExecution;
  browser: AgentBrowser;
  requireOwner(): Promise<void>;
  keepPage(id: string, page: AgentPage): Promise<void>;
  pause(id: string, runId: string, state: BrainState, card: Omit<ChatSecureRequest, 'id'>): Promise<void>;
}, page: AgentPage, reason?: BrowserHumanStep['reason']): Promise<boolean> {
  const { current, browser } = input;
  if (!input.enabled || !current?.full || !current.state) return false;
  let card = browserLiveCard(page, reason);
  if (!card) return false;
  await input.requireOwner();
  const { ownerId, id, runId, state } = current;
  if (!await browser.liveView.hasPage({ ownerId, conversationId: id, runId })) {
    page = (await browser.observe(ownerId, id, runId)).page;
    card = browserLiveCard(page, reason);
    if (!card) return false;
  }
  await input.keepPage(id, page);
  rememberLiveHandsHandover(state, current.liveHands);
  await input.pause(id, runId, state, card);
  return true;
}

export async function watchBrowserLiveAction(run: () => Promise<AgentActionResult>, action: AgentAction, progress: LiveHandsProgress | undefined,
  normalizeUrl: (value: string) => string, pause: PausePage, ended: () => Error): Promise<AgentActionResult> {
  try {
    const result = await run();
    if (progress) {
      progress.actions++;
      progress.action = action.kind;
      if (action.kind === 'open' && action.text) progress.opened = URL.parse(normalizeUrl(action.text))?.origin;
    }
    return result;
  } catch (error) {
    if (error instanceof BrowserHumanStepError) {
      if (progress) progress.undispatched = error.beforeDispatch;
      if (await pause(error.page, error.step.reason)) throw ended();
    }
    throw error;
  }
}

/** Recover the exact started step only with evidence of its destination or proof it never dispatched. */
export function reconcileLiveHands(state: HandoverState, runId: string, freshUrl: string, at: number) {
  const handover = state.browserLiveHandsHandover;
  delete state.browserLiveHandsHandover;
  if (!handover || !state.hands) return;
  const ledger = restoreRunLedger(state.agentRun, runId);
  if (!ledger) return;
  const { index, prefix, opened, undispatched, dispatched } = handover;
  if (dispatched || opened && URL.parse(freshUrl)?.origin === opened) {
    completeHandsStep(ledger, state.hands, prefix, index, 'completed', at);
  } else if (undispatched) {
    completeHandsStep(ledger, state.hands, prefix, index, 'partial', at);
    state.hands.next = index;
  } else return;
  state.agentRun = ledger;
}

const noHandover = () => new BrowserError('CHAT_BROWSER_HANDOVER_CHANGED', 'تغيّرت خطوة المتصفح أو انتهت جلستها.', 409);

interface BrowserLivePorts {
  db: Kysely<any>;
  browser: AgentBrowser;
  enabled: boolean;
  closing(): boolean;
  ownerAllowed(ownerId: string, tx: Kysely<any>): Promise<boolean>;
  effectClear(ownerId: string, id: string, tx: Kysely<any>): Promise<boolean>;
  resume(ownerId: string, id: string, runId: string, handoverId: string,
    change: (state: BrainState, tx: Kysely<any>) => Promise<void>): Promise<unknown>;
}

export function createBrowserLiveControl(ports: BrowserLivePorts) {
  const { browser, db } = ports;
  async function assertAvailable(ownerId: string, tx: Kysely<any>) {
    if (!ports.enabled || ports.closing()) throw noHandover();
    if (!await ports.ownerAllowed(ownerId, tx)) throw new BrowserError('CHAT_TOOL_FORBIDDEN', 'هذه الأداة غير متاحة لحسابك.', 403);
  }

  async function lockedCard(tx: Kysely<any>, ownerId: string, id: string, runId: string, handoverId: string) {
    const row = await tx.selectFrom('chat_conversations as c').innerJoin('chat_runs as r', 'r.id', 'c.active_run_id')
      .select(['c.secure', 'c.browser_account']).where('c.id', '=', id).where('c.owner_id', '=', ownerId)
      .where('c.status', '=', 'waiting_input').where('c.active_run_id', '=', runId).where('r.conversation_id', '=', id)
      .where('r.owner_id', '=', ownerId).where('r.status', '=', 'waiting_input').where('r.lease_expires_at', '>', sql<Date>`CURRENT_TIMESTAMP`)
      .forUpdate('c').executeTakeFirst();
    if (!row || readBrowserLiveHandover(row.secure)?.id !== handoverId) throw noHandover();
    return row;
  }

  function checkpointWriter(tx: Kysely<any>, ownerId: string, id: string, account: string | null) {
    return async (checkpoint: AgentSessionCheckpoint) => {
      if (checkpoint.ownerId !== ownerId || checkpoint.conversationId !== id || checkpoint.accountId !== account) throw noHandover();
      await tx.updateTable('chat_conversations').set({ browser_checkpoint: JSON.stringify(checkpoint) }).where('id', '=', id).where('owner_id', '=', ownerId).execute();
    };
  }

  return {
    hasPage: (ownerId: string, conversationId: string, runId: string) => browser.liveView.hasPage({ ownerId, conversationId, runId }),
    frame: (ownerId: string, conversationId: string, runId: string, signal?: AbortSignal) => browser.liveView.frame({ ownerId, conversationId, runId }, signal),
    async input(ownerId: string, conversationId: string, runId: string, input: BrowserLiveInput, signal?: AbortSignal) {
      const result = await db.transaction().execute(async tx => {
        const row = await lockedCard(tx, ownerId, conversationId, runId, input.handoverId);
        await assertAvailable(ownerId, tx);
        if (!await ports.effectClear(ownerId, conversationId, tx)) throw noHandover();
        const save = checkpointWriter(tx, ownerId, conversationId, row.browser_account ?? null);
        let recorded = false;
        try {
          await browser.liveView.input({ ownerId, conversationId, runId }, input, signal, async checkpoint => {
            await save(checkpoint);
            recorded = true;
          });
        } catch (error) {
          if (!recorded) throw error;
          // An input may have already reached the page. Keep its review fence on failure.
          return { error };
        }
      });
      if (result) throw result.error;
    },
    continue: (ownerId: string, conversationId: string, runId: string, handoverId: string) => ports.resume(ownerId, conversationId, runId, handoverId, async (state, tx) => {
      const row = await lockedCard(tx, ownerId, conversationId, runId, handoverId);
      await assertAvailable(ownerId, tx);
      if (state.progressRecovery?.browser?.uncertain || !await ports.effectClear(ownerId, conversationId, tx)) throw noHandover();
      const scope = { ownerId, conversationId, runId };
      const fresh = await browser.liveView.complete(scope, handoverId, checkpointWriter(tx, ownerId, conversationId, row.browser_account ?? null), browserLiveStep);
      reconcileLiveHands(state, runId, fresh.url, Date.now());
      state.authAttempts = 0;
      state.awaitingAuthResult = false;
      state.securePageHash = null;
    }),
  };
}
