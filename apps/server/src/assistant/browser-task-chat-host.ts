import { createHash, randomUUID } from 'node:crypto';
import { BrowserError, browserHandsConsent, detectBrowserHumanStep, type AgentAction, type AgentActionResult, type AgentAuthority, type AgentHeldEffect,
  type AgentPage, type AgentRequestPermit, type AgentSessionCheckpoint, type SearchProvider } from '@mohassan/browser';
import type { ChatConversation } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import type { CommandChatConfig } from '../command-chat.js';
import { restoreRunLedger, type RunLedger } from './agent-run.js';
import { siteOf, situation, type BrainState, type PageSituation } from './brain.js';
import type { BrowserRequestCapability } from './browser-request-scope.js';
import { browserTaskProgress, createBrowserTaskWaiters, handleBrowserTaskChat, isBrowserTaskSecure, noteBrowserTaskApproval,
  pauseBrowserTaskChat, prepareLegacyBrowserHandover, resumeLegacyBrowserHandover, skipBrowserTaskHandover, type BrowserHandsMode } from './browser-task-chat.js';
import type { BrowserTaskWait } from './browser-task-runner.js';
import { parseHands } from './hands.js';
import type { CredentialVault } from './vault.js';

declare module '../command-chat.js' {
  interface CommandChatConfig {
    browserHands?: BrowserHandsMode;
  }
}

export { isBrowserTaskSecure };

type ResumeFence = { status: 'waiting_input'; field: 'secure'; requestId: string };
type Resume = (ownerId: string, id: string, runId: string, change: (state: BrainState) => void, say: string,
  expected: ResumeFence) => Promise<ChatConversation>;

const silentClaims = new WeakSet<object>();
const waitersByControl = new WeakMap<CommandChatConfig, ReturnType<typeof createBrowserTaskWaiters>>();
const legacyRuns = new WeakMap<BrainState, BrowserTaskHost['legacyPage']>();

export function recordBrowserTaskResume(expected: object): boolean {
  return !silentClaims.has(expected);
}

export async function answerBrowserTaskSecure(input: { action: 'submit' | 'done' | 'skip'; requestId: string },
  ownerId: string, id: string, runId: string, resume: Resume, detail: (ownerId: string, id: string) => Promise<ChatConversation>) {
  if (input.action === 'submit') throw new BrowserError('CHAT_BROWSER_MANUAL_INPUT', 'أدخل هذه البيانات في المتصفح مباشرة.', 409);
  if (input.action === 'done') return detail(ownerId, id);
  return resume(ownerId, id, runId, skipBrowserTaskHandover, 'تخطَّ هذه الخطوة',
    { status: 'waiting_input', field: 'secure', requestId: input.requestId });
}

interface HostPorts {
  config: CommandChatConfig;
  db: Kysely<any>;
  ownerId: string;
  id: string;
  runId: string;
  intent?: string | null;
  request: string;
  actionRequest: string;
  state: BrainState;
  page: AgentPage | null;
  browserCheckpoint?: { status?: string } | null;
  signal: AbortSignal;
  search: Pick<SearchProvider, 'search'>;
  vault: Pick<CredentialVault, 'scrub'>;
  clean(value: string): string;
  fullReach(): boolean;
  requireCurrentOwnerAccess(): Promise<void>;
  withExecution<T>(job: () => T): T;
  outsideExecution(job: () => void): void;
  isClosing(): boolean;
  settled(id: string): Promise<void> | undefined;
  terminalError(error: unknown): boolean;
  setPage(page: AgentPage): void;
  ledgerOf(state: BrainState, runId: string): RunLedger;
  saveState(runId: string, state: BrainState): Promise<void>;
  keepPage(id: string, page: AgentPage): Promise<void>;
  addStep(id: string, runId: string, text: string): Promise<unknown>;
  finish(id: string, runId: string, state: BrainState, text: string, status: 'completed' | 'partial' | 'blocked'): Promise<void>;
  pause(id: string, runId: string, state: BrainState, status: string, fields: Record<string, unknown>, say?: string): Promise<void>;
  resume: Resume;
  runTransaction<T>(id: string, runId: string, work: (tx: Kysely<any>) => Promise<T>): Promise<T>;
  authority(): AgentAuthority;
  actBrowser(ownerId: string, id: string, action: AgentAction, authority: AgentAuthority, permit?: AgentRequestPermit): Promise<AgentActionResult>;
  observeBrowser(ownerId: string, id: string): Promise<AgentActionResult>;
  prepareBrowserAction(ownerId: string, id: string, action: AgentAction): Promise<AgentRequestPermit | null>;
  assertBrowserRequestScope(request: string, capability: BrowserRequestCapability, state?: BrainState): void;
  assertPublicSearch(request: string, query: string, state: BrainState): void;
  browserEffectStatus(ownerId: string, id: string, connection?: Kysely<any>): Promise<'pending' | 'unknown' | 'clear'>;
  admitPending(id: string, runId: string, state: BrainState, request: string): Promise<boolean>;
  pauseBrowserAction(id: string, runId: string, state: BrainState, pending: NonNullable<BrainState['pendingAction']>): Promise<void>;
  pauseHeld(id: string, runId: string, state: BrainState, held: AgentHeldEffect, label: string): Promise<void>;
}

function waitersFor(config: CommandChatConfig) {
  let waiters = waitersByControl.get(config);
  if (!waiters) {
    waiters = createBrowserTaskWaiters();
    waitersByControl.set(config, waiters);
  }
  return waiters;
}

function requiresLegacyHandover(kind: PageSituation, site: string): boolean {
  return ['password', 'identifier', 'otp', 'captcha', 'browser_refused', 'device_prompt'].includes(kind)
    || site === 'https://accounts.google.com';
}

class BrowserTaskHost {
  constructor(private readonly ports: HostPorts) {}

  private tx<T>(job: (tx: Kysely<any>) => Promise<T>) {
    const { id, runId, withExecution, runTransaction } = this.ports;
    return withExecution(() => runTransaction(id, runId, job));
  }

  private finish(text: string, status: 'completed' | 'partial' | 'blocked') {
    const { id, runId, state, finish } = this.ports;
    return finish(id, runId, state, text, status);
  }

  private async keepPage(page: AgentPage) {
    await this.ports.keepPage(this.ports.id, page);
    this.ports.setPage(page);
  }

  private async log(text: string) {
    const { id, runId, addStep } = this.ports;
    await addStep(id, runId, text);
  }

  private save() {
    return this.ports.saveState(this.ports.runId, this.ports.state);
  }

  private handover(wait: BrowserTaskWait, page: AgentPage) {
    const { config, db, id, runId, ownerId, state, outsideExecution, isClosing, settled, resume } = this.ports;
    return pauseBrowserTaskChat({
      db, conversationId: id, runId, ownerId, wait, state, page, waiters: waitersFor(config),
      keepPage: value => this.keepPage(value),
      log: label => this.log(label),
      announce: (secure, visibility) => this.tx(async tx => {
        await tx.insertInto('chat_events').values({ id: randomUUID(), conversation_id: id, run_id: runId,
          kind: 'visibility', message: secure.prompt, data: JSON.stringify(visibility) }).execute();
      }),
      pause: secure => this.ports.pause(id, runId, state, 'waiting_input', { secure: JSON.stringify(secure) }, secure.prompt),
      outsideRun: outsideExecution,
      observe: () => config.browser.observeHands(ownerId, id),
      canWait: () => !isClosing(),
      claim: async (secureId, result) => {
        await settled(id);
        const expected: ResumeFence = { status: 'waiting_input', field: 'secure', requestId: secureId };
        silentClaims.add(expected);
        await resume(ownerId, id, runId, resumed => { browserTaskProgress(resumed, true)!.humanResult = result; }, '', expected);
      },
    });
  }

  private async finishHandover(expected: { url: string; hash: string }) {
    const { config, ownerId, id, state, requireCurrentOwnerAccess, browserEffectStatus, authority } = this.ports;
    await requireCurrentOwnerAccess();
    const checkpointAuthority: AgentAuthority = {
      ...authority(),
      saveCheckpoint: (checkpoint: AgentSessionCheckpoint) => this.tx(async tx => {
        const row = await tx.selectFrom('chat_conversations').select(['browser_account', 'browser_checkpoint']).where('id', '=', id).executeTakeFirstOrThrow();
        if (checkpoint.conversationId !== id || checkpoint.ownerId !== ownerId || (row.browser_account ?? null) !== checkpoint.accountId)
          throw new BrowserError('CHAT_ACCOUNT_CHANGED', 'تغير حساب جلسة المتصفح.', 409);
        if (checkpoint.status !== 'ready' || state.progressRecovery?.browser?.uncertain || !browserTaskProgress(state)?.waiting
          || row.browser_checkpoint?.status === 'review_required' && row.browser_checkpoint.actionKind !== null
          || await browserEffectStatus(ownerId, id, tx) !== 'clear')
          throw new BrowserError('AGENT_RECOVERY_REVIEW_REQUIRED', 'لم تُحسم نتيجة الإجراء السابق في المتصفح.', 409);
        await tx.updateTable('chat_conversations').set({ browser_checkpoint: JSON.stringify(checkpoint) }).where('id', '=', id).execute();
      }),
    };
    try {
      const page = await config.browser.finishHandsHandover(ownerId, id, expected, checkpointAuthority);
      if (page) await this.keepPage(page);
      return page;
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'AGENT_RECOVERY_REVIEW_REQUIRED') return null;
      throw error;
    }
  }

  private approvalAuthority(receiptId: string): AgentAuthority {
    const { config, ownerId, runId, authority } = this.ports;
    const base = authority();
    if (!config.accountFullAccess) return base;
    return {
      ...base,
      dispatched: permit => this.tx(async tx => {
        if (permit.id !== receiptId || !await config.accountFullAccess!(ownerId, tx))
          throw new BrowserError('CHAT_TOOL_FORBIDDEN', 'تغيرت صلاحية التحكم بالمتصفح قبل إرسال الطلب.', 403);
        const run = await tx.selectFrom('chat_runs').select('lease_token').where('id', '=', runId).executeTakeFirstOrThrow();
        await tx.insertInto('chat_effect_receipts').values({ id: permit.id, run_id: runId, lease_token: run.lease_token, method: permit.method,
          target_hash: createHash('sha256').update(permit.url).digest('hex'), body_hash: permit.bodyHash, status: 'started' }).execute();
        return permit.id;
      }),
    };
  }

  private async releaseApproval(initial: AgentPage | null): Promise<{ page: AgentPage | null; stopped: boolean }> {
    const { config, db, ownerId, id, runId, browserCheckpoint, request, state, requireCurrentOwnerAccess,
      admitPending, browserEffectStatus, assertBrowserRequestScope, actBrowser } = this.ports;
    const { pendingAction, pendingHeld } = state;
    if (!browserTaskProgress(state)?.approval || (!pendingAction && !pendingHeld)) return { page: initial, stopped: false };
    if (await browserEffectStatus(ownerId, id) !== 'clear' || state.progressRecovery?.browser?.uncertain || browserCheckpoint?.status === 'review_required') {
      await this.finish(/\p{Script=Arabic}/u.test(request)
        ? 'توجد عملية متصفح سابقة لم تُحسم نتيجتها. اقرأ نتيجتها وراجعها قبل متابعة الإجراءات؛ لم أكررها.'
        : 'A previous browser operation has an unresolved result. Read and review its outcome before continuing actions; it has not been repeated.', 'partial');
      return { page: initial, stopped: true };
    }
    await requireCurrentOwnerAccess();
    const ledger = restoreRunLedger(state.agentRun, runId);
    if (!ledger?.permissions.length || Boolean(pendingAction) === Boolean(pendingHeld))
      throw new BrowserError('CHAT_APPROVAL_STALE', 'لم تعد موافقة المتصفح مطابقة للخطوة المعلقة.', 409);
    if (!await admitPending(id, runId, state, request)) return { page: initial, stopped: true };
    if (!pendingAction) assertBrowserRequestScope(request, 'browser_action', state);
    const receiptId = pendingAction?.permit.id ?? pendingHeld!.id;
    const approvalAuthority = this.approvalAuthority(receiptId);
    state.pendingAction = null;
    state.pendingHeld = null;
    await this.save();
    await this.log(`تنفيذ «${(pendingAction?.label ?? pendingHeld!.label).slice(0, 50)}» بعد موافقتك`);
    const result = pendingAction
      ? await actBrowser(ownerId, id, pendingAction.action, approvalAuthority, pendingAction.permit)
      : await config.browser.releaseHeld(ownerId, id, receiptId, approvalAuthority);
    await this.keepPage(result.page);
    const label = pendingAction?.label ?? pendingHeld!.label;
    state.trail.push({ step: state.steps, action: label, result: 'request sent after exact user approval; verify the page outcome', changed: result.changed });
    await noteBrowserTaskApproval(db, state, runId, receiptId);
    await this.save();
    return { page: result.page, stopped: false };
  }

  async legacyPage(page: AgentPage, kind: PageSituation, site: string): Promise<AgentPage | null | undefined> {
    const { state, fullReach, ownerId, id, runId, prepareBrowserAction, actBrowser, authority, pauseBrowserAction } = this.ports;
    for (let round = 0; round < 6; round++) {
      const wait = fullReach() ? prepareLegacyBrowserHandover(state, page) : null;
      if (wait) {
        await this.handover(wait, page);
        return null;
      }
      if (requiresLegacyHandover(kind, site)) return page;
      if (kind !== 'cookies') return round ? page : undefined;
      const consent = browserHandsConsent(page.elements);
      const host = new URL(page.url).host;
      if (!consent || state.handledCookieHosts.includes(host)) return page;
      state.handledCookieHosts.push(host);
      const action: AgentAction = { kind: 'click', ref: consent.ref, browserHands: { url: page.url, privacy: true } };
      const label = 'رفض ملفات الارتباط غير الضرورية';
      try {
        const permit = await prepareBrowserAction(ownerId, id, action);
        if (permit) {
          await pauseBrowserAction(id, runId, state, { action, permit, label });
          return null;
        }
        page = (await actBrowser(ownerId, id, action, authority())).page;
      } catch (error) {
        if (!(error instanceof BrowserError) || !['AGENT_FORM_UNSUPPORTED', 'AGENT_EFFECT_DENIED'].includes(error.code)) throw error;
        await this.finish(`توقفت الصفحة عند إعدادات ملفات الارتباط في ${host}. تعذّر تجهيز طلب الرفض للموافقة. يمكنك فتح الموقع في متصفحك واختيار الإعدادات هناك.`, 'partial');
        return null;
      }
      await this.log(label);
      await this.keepPage(page);
      kind = situation(page);
      site = siteOf(page.url);
    }
    return page;
  }

  async dispatch(mode: BrowserHandsMode): Promise<boolean> {
    const { config, ownerId, id, runId, request, actionRequest, page, state, signal, search, vault, clean, fullReach,
      requireCurrentOwnerAccess, terminalError, ledgerOf, assertBrowserRequestScope, assertPublicSearch, actBrowser,
      authority, observeBrowser, prepareBrowserAction, pauseBrowserAction, pauseHeld } = this.ports;

    if (mode === 'on') legacyRuns.set(state, (observed, kind, site) => this.legacyPage(observed, kind, site));
    const progress = browserTaskProgress(state);
    if (mode === 'on' && progress?.legacy) {
      const resumed = await resumeLegacyBrowserHandover(state, page, expected => this.finishHandover(expected),
        (text, status) => this.finish(text, status));
      if (!resumed) return true;
      return false;
    }
    if (!fullReach()) {
      if (!progress) return false;
      await requireCurrentOwnerAccess();
      return true;
    }
    if (state.steps && !progress) return false;
    const approved = mode === 'on' ? await this.releaseApproval(page) : { page, stopped: false };
    if (approved.stopped) return true;
    return handleBrowserTaskChat({
      mode, request: actionRequest, legacy: () => parseHands(actionRequest), page: approved.page, state, ledger: () => ledgerOf(state, runId),
      io: {
        signal,
        rethrow: error => { if (terminalError(error)) throw error; },
        text: value => vault.scrub(id, clean(value)),
        observe: async () => {
          await requireCurrentOwnerAccess();
          assertBrowserRequestScope(request, 'browser_action', state);
          if (!await config.browser.hasPage(ownerId, id)) return null;
          const { page: observed } = await observeBrowser(ownerId, id);
          await this.keepPage(observed);
          return observed;
        },
        act: async action => {
          await requireCurrentOwnerAccess();
          const result = await actBrowser(ownerId, id, action, authority());
          await this.keepPage(result.page);
          return result;
        },
        prepare: async action => {
          await requireCurrentOwnerAccess();
          return prepareBrowserAction(ownerId, id, action);
        },
        search: async query => {
          await requireCurrentOwnerAccess();
          assertPublicSearch(request, query, state);
          return search.search(query, 5, signal, { ownerId });
        },
      },
      save: () => this.save(),
      log: label => this.log(label),
      finish: (text, status) => this.finish(text, status),
      shadow: summary => this.tx(async tx => {
        await tx.insertInto('chat_events').values({ id: randomUUID(), conversation_id: id, run_id: runId, kind: 'browser_task_shadow',
          message: 'Browser task understanding', data: JSON.stringify(summary) }).execute();
      }),
      handover: (wait, observed) => this.handover(wait, observed),
      finishHandover: expected => this.finishHandover(expected),
      approve: (approval, label) => 'held' in approval ? pauseHeld(id, runId, state, approval.held, label)
        : pauseBrowserAction(id, runId, state, { ...approval, label }),
    });
  }
}

export async function dispatchBrowserTask(ports: HostPorts): Promise<boolean> {
  const { config, intent } = ports;
  if (intent && intent !== 'task' || !config.browserHands) return false;
  return new BrowserTaskHost(ports).dispatch(config.browserHands);
}

export function legacyBrowserTaskPage(state: BrainState, page: AgentPage, kind: PageSituation, site: string) {
  const handle = legacyRuns.get(state);
  if (handle) return handle(page, kind, site);
  // A recovery read can find a wall before this run has bound the host ports.
  if (requiresLegacyHandover(kind, site) || detectBrowserHumanStep(page)) return page;
  return undefined;
}
