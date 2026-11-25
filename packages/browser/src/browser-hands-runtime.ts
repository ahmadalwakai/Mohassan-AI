import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ElementHandle, Frame, JSHandle, Route } from 'playwright';
import type { AgentAction, AgentActionResult, AgentAuthority, AgentBrowser, AgentElement, AgentPage, AgentRequestPermit } from './agent-browser.js';
import {
  assertBrowserHandsEffect, assertBrowserHandsOwnerFree, assertBrowserHandsReady, blockBrowserHandsSecret, browserHandsActionHash,
  browserHandsActionResult, browserHandsElementPositions, browserHandsGuardedAction, finishBrowserHandsHandover, observeBrowserHandsPage,
  performBrowserHandsChoiceClick, performBrowserHandsWrite, rememberBrowserHandsInput, type BrowserHandsActionBinding, type BrowserHandsWriteReceipt,
} from './browser-hands-agent.js';
import { browserHandsPageContent, browserHandsScreenshotMasks, type BrowserHandsElementMatch, type BrowserHandsFrameContent } from './browser-hands-dom.js';
import { browserHandsFrameModel } from './browser-hands-frame-model.js';
import { BrowserHumanStepError } from './browser-hands-human.js';
import type { EffectActor, EffectDecision } from './effect-policy.js';
import { BrowserError } from './network.js';

declare module './agent-browser.js' {
  interface AgentBrowserOptions { browserHands?: boolean }
  interface AgentElement { match?: BrowserHandsElementMatch; frameOrigin?: string }
  interface AgentPage { content?: BrowserHandsFrameContent[] }
  interface AgentAction { browserHands?: BrowserHandsActionBinding }
  interface AgentActionResult { browserHandsWrite?: BrowserHandsWriteReceipt }
  interface AgentBrowser {
    observeHands(ownerId: string, conversationId: string): Promise<AgentPage | null>;
    finishHandsHandover(ownerId: string, conversationId: string, expected: Pick<AgentPage, 'url' | 'hash'>,
      authority: AgentAuthority): Promise<AgentPage | null>;
  }
}

// Only this adapter can see these instance ports. Indexed access keeps each
// port checked against AgentBrowser's actual signature when the engine changes.
type BrowserPorts = {
  actor: AgentBrowser['actor'];
  assertTargetCurrent: AgentBrowser['assertTargetCurrent'];
  beginRead: AgentBrowser['beginRead'];
  capture: AgentBrowser['capture'];
  conversation: AgentBrowser['conversation'];
  duringActivity: AgentBrowser['duringActivity'];
  frameModels: AgentBrowser['frameModels'];
  frames: AgentBrowser['frames'];
  network: AgentBrowser['network'];
  options: AgentBrowser['options'];
  persist: AgentBrowser['persist'];
  read: AgentBrowser['read'];
  readFrame: AgentBrowser['readFrame'];
  redactions: AgentBrowser['redactions'];
  result: AgentBrowser['result'];
  startActivity: AgentBrowser['startActivity'];
  withMutation: AgentBrowser['withMutation'];
  withTarget: AgentBrowser['withTarget'];
};
type Entry = Awaited<ReturnType<BrowserPorts['conversation']>>;
type FrameRead = NonNullable<Awaited<ReturnType<BrowserPorts['readFrame']>>>;
type FrameModel = FrameRead['model'] extends JSHandle<infer Model> ? Model : never;
type FrameSnapshot = FrameRead['snapshot'] & { content?: BrowserHandsFrameContent };
type FormData = NonNullable<ReturnType<FrameModel['prepareForm']>> | { humanOnly: NonNullable<BrowserHandsElementMatch['humanOnly']> };
type BrowserInternals = { frameModel: string; frameLimit: number; hashOf: (value: string) => string; requestBodyHash: (value: string) => string };

const enabledBrowsers = new WeakSet<AgentBrowser>();
const frameSources = new WeakMap<AgentBrowser, string>();

export function guardBrowserHandsRoute(browser: AgentBrowser, route: Route, url: string, actor: EffectActor,
  decision: EffectDecision, operation?: Entry['operation']) {
  if (enabledBrowsers.has(browser)) assertBrowserHandsEffect(route, url, actor, decision, operation);
}

export function guardBrowserHandsReservation(browser: AgentBrowser, entry: Entry) {
  if (enabledBrowsers.has(browser)) assertBrowserHandsOwnerFree(entry);
}

export function browserHandsFrameSource(browser: AgentBrowser): string {
  const script = frameSources.get(browser);
  if (!script) throw new Error('Browser frame model is not installed.');
  return script;
}

function scrub<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[محجوب]'), value as string) as T;
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, secrets)])) as T;
  return value;
}

function installObservation(core: BrowserPorts, internals: BrowserInternals) {
  type Reading = { index: number; snapshot?: FrameSnapshot };
  const readings = new AsyncLocalStorage<Map<Frame, Reading>>();
  const baseRead = core.read.bind(core);
  const baseReadFrame = core.readFrame.bind(core);
  core.readFrame = async frame => {
    const result = await baseReadFrame(frame);
    const reading = readings.getStore()?.get(frame);
    if (result && reading) {
      result.snapshot.elements = browserHandsElementPositions(result.snapshot.elements, reading.index * internals.frameLimit, result.snapshot.url);
      reading.snapshot = result.snapshot;
    }
    return result;
  };
  core.read = (entry, screenshot) => {
    const frames = new Map(core.frames(entry.page).map((frame, index) => [frame, { index }] as [Frame, Reading]));
    return readings.run(frames, async () => {
      const page = await baseRead(entry, screenshot);
      const observations = [...frames.values()].map(frame => frame.snapshot);
      const { content } = browserHandsPageContent(observations.map(snapshot => snapshot?.content));
      const childText = observations.slice(1).map(snapshot => snapshot?.text ?? '').filter(Boolean).join(' ').slice(0, 2000);
      const text = `${observations[0]?.text ?? ''} ${childText}`.trim();
      const secrets = core.redactions(entry);
      return { ...page, ...scrub({ content, text }, secrets) };
    });
  };
  core.capture = async entry => {
    const secrets = core.redactions(entry);
    const mask = entry.page.frames().filter(frame => !frame.isDetached()).flatMap(frame => [
      frame.locator('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]'),
      ...secrets.map(secret => frame.getByText(secret, { exact: false })),
      ...browserHandsScreenshotMasks(frame),
    ]);
    entry.shot = await entry.page.screenshot({ type: 'jpeg', quality: 62, timeout: 5000, mask }).catch(() => null);
  };
}

async function prepareAction(core: BrowserPorts, internals: BrowserInternals, ownerId: string, conversationId: string,
  action: AgentAction): Promise<AgentRequestPermit | null> {
  if (!['click', 'type', 'press', 'form'].includes(action.kind) || action.kind === 'type' && !action.submit
    || action.kind === 'press' && action.text !== 'Enter') return null;
  const entry = await core.conversation(ownerId, conversationId);
  core.beginRead(entry);
  try {
    const page = await core.read(entry, false);
    assertBrowserHandsReady(page, action);
    const model = action.kind === 'press' ? await core.frameModels.get(entry.page.mainFrame()) : entry.targets.get(action.ref ?? '')?.model;
    if (!model) return null;
    const prepared = await model.evaluate((state, action) => state.prepareForm(action), action).catch(() => {
      throw new BrowserError('AGENT_FORM_UNSUPPORTED', 'هذا النموذج لا يملك إرسالًا محدودًا يمكن تفويضه بأمان.', 403);
    }) as FormData | null;
    if (!prepared) return null;
    if ('humanOnly' in prepared) blockBrowserHandsSecret(page.elements.find(item => item.ref === action.ref)?.frameOrigin ?? page.url, prepared.humanOnly);
    core.network.validate(prepared.url, core.options.allowedOrigins);
    return { id: randomUUID(), url: prepared.url, method: prepared.method, pageHash: page.hash,
      bodyHash: internals.requestBodyHash((prepared.multipart ? 'multipart-text:' : '') + prepared.body),
      actionHash: internals.hashOf(JSON.stringify(browserHandsActionHash(action, true))), expiresAt: Date.now() + 5 * 60_000 };
  } finally {
    entry.readers--;
  }
}

function installActionBoundary(browser: AgentBrowser, core: BrowserPorts, internals: BrowserInternals) {
  const act = browser.act.bind(browser);
  const actor = core.actor.bind(core);
  const persist = core.persist.bind(core);
  const humanBlock = new WeakSet<object>();

  core.actor = (entry, operation, topLevel, url) => operation?.kind === 'select' && !operation.used && !operation.navigated
    ? 'agent' : actor(entry, operation, topLevel, url);
  core.persist = (entry, authority) => {
    const operation = entry.operation;
    if (entry.recovery.status === 'ready' && operation && (humanBlock.has(operation) || operation.denial instanceof BrowserHumanStepError)) {
      entry.recovery.actionKind = null;
    }
    return persist(entry, authority);
  };

  browser.prepareAction = (...args) => prepareAction(core, internals, ...args);
  browser.act = async (ownerId, conversationId, action, authority, approved, expected) => {
    let preflight: Promise<void> | undefined;
    const fencedAuthority: AgentAuthority = {
      signal: authority.signal,
      assertActive: async () => {
        await authority.assertActive();
        if (!browserHandsGuardedAction(action)) return;
        preflight ??= (async () => {
          const entry = await core.conversation(ownerId, conversationId);
          const operation = entry.operation;
          if (operation?.authority !== fencedAuthority) throw new BrowserError('AGENT_AUTHORITY_STALE', 'انتهى تفويض الإجراء قبل بدء الخطوة.', 409);
          try {
            assertBrowserHandsReady(await core.read(entry, false), action, Boolean(approved), operation);
          } catch (error) {
            if (error instanceof BrowserHumanStepError) humanBlock.add(operation);
            throw error;
          }
        })();
        await preflight;
      },
      dispatched: permit => authority.dispatched(permit),
      completed: (id, status) => authority.completed(id, status),
      ...(authority.saveCheckpoint ? { saveCheckpoint: checkpoint => authority.saveCheckpoint!(checkpoint) } : {}),
    };
    return browserHandsActionResult(action, await act(ownerId, conversationId, action, fencedAuthority, approved, expected));
  };
}

function installWrites(browser: AgentBrowser, core: BrowserPorts) {
  type Target = Parameters<Parameters<BrowserPorts['withTarget']>[2]>[1];
  const write = (entry: Entry, ref: string, target: ElementHandle<Element>, observed: Target, kind: 'type' | 'select' | 'click',
    value?: string, submit?: boolean): Promise<boolean> => {
    const guard = async (desired: string) => {
      await core.assertTargetCurrent(entry, ref, target, observed);
      const approved = kind === 'type' && Boolean(entry.operation?.permit);
      const allowed = await observed.model.evaluate((model, input) => model.canWrite(input.ref, input.desired, input.approved), { ref, desired, approved });
      if (!allowed) throw new BrowserError('AGENT_FIELD_VALUE_PROTECTED', 'تغيّرت قيمة الحقل أو اختيار المالك قبل الإدخال.', 409);
    };
    const record = () => observed.model.evaluate((model, id) => model.recordWrite(id), ref);
    return kind === 'click'
      ? performBrowserHandsChoiceClick(target, guard, record)
      : performBrowserHandsWrite(target, { kind, value: value!, submit }, guard, record).then(() => true);
  };
  const input = async (kind: 'type' | 'select', ownerId: string, conversationId: string, ref: string, value: string, submit?: boolean) => {
    const entry = await core.conversation(ownerId, conversationId);
    return core.withMutation(entry, async () => {
      await core.withTarget(entry, ref, async (target, observed) => {
        const activity = await core.startActivity(entry, kind, target);
        await core.duringActivity(entry, activity, () => write(entry, ref, target, observed, kind, value, submit));
      });
      return core.result(entry);
    });
  };

  const click = browser.click.bind(browser);
  browser.click = async (ownerId, conversationId, ref) => {
    const entry = await core.conversation(ownerId, conversationId);
    return core.withMutation(entry, async () => {
      const choice = await core.withTarget(entry, ref, async (target, observed) => {
        const native = await target.evaluate(node => node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type));
        if (!native) return false;
        return core.duringActivity(entry, await core.startActivity(entry, 'click', target), () => write(entry, ref, target, observed, 'click'));
      });
      return choice ? core.result(entry) : click(ownerId, conversationId, ref);
    });
  };
  browser.type = (...args) => input('type', ...args);
  browser.select = (...args) => input('select', ...args);
  browser.fillSecret = async (ownerId, conversationId) => blockBrowserHandsSecret((await core.conversation(ownerId, conversationId)).page.url());
  browser.typeSecretKeys = async (ownerId, conversationId) => blockBrowserHandsSecret((await core.conversation(ownerId, conversationId)).page.url(), 'code');
}

function installHandover(browser: AgentBrowser, core: BrowserPorts) {
  const keyboard = browser.keyboard.bind(browser);
  const mutation = core.withMutation.bind(core);
  const manualInput = new AsyncLocalStorage<{ ownerId: string; conversationId: string; text?: string }>();
  browser.keyboard = (ownerId, conversationId, input) => manualInput.run({ ownerId, conversationId, text: input.text },
    () => keyboard(ownerId, conversationId, input));
  core.withMutation = (entry, perform) => {
    assertBrowserHandsOwnerFree(entry);
    return mutation(entry, () => {
      const manual = manualInput.getStore();
      if (manual?.ownerId === entry.ownerId && manual.conversationId === entry.conversationId) rememberBrowserHandsInput(entry.redactions, manual.text);
      return perform();
    });
  };

  browser.observeHands = async (ownerId, conversationId) => {
    if (!await browser.hasPage(ownerId, conversationId)) return null;
    const entry = await core.conversation(ownerId, conversationId);
    return observeBrowserHandsPage(entry, () => core.read(entry, false));
  };
  browser.finishHandsHandover = async (ownerId, conversationId, expected, authority) => {
    if (!await browser.hasPage(ownerId, conversationId)) return null;
    const entry = await core.conversation(ownerId, conversationId);
    return finishBrowserHandsHandover(entry, expected, authority, () => core.result(entry, false), () => core.persist(entry, authority));
  };
}

/** Compose once at construction. All established network, authority, and session ports stay on the original browser. */
export function installBrowserHands(browser: AgentBrowser, internals: BrowserInternals) {
  const core = browser as unknown as BrowserPorts;
  const enabled = core.options.browserHands === true;
  frameSources.set(browser, enabled ? browserHandsFrameModel(internals.frameModel) : internals.frameModel);
  if (!enabled) {
    browser.observeHands = async () => null;
    browser.finishHandsHandover = async () => null;
    return;
  }
  enabledBrowsers.add(browser);
  installObservation(core, internals);
  installActionBoundary(browser, core, internals);
  installWrites(browser, core);
  installHandover(browser, core);
}
