import { randomUUID } from 'node:crypto';
import { browserLiveBudget, type BrowserLiveInput } from '@mohassan/contracts';
import type { Frame, Page } from 'playwright';
import type { AgentAction, AgentPage } from './agent-browser.js';
import { BrowserHumanStepError, detectBrowserHumanStep, requireBrowserHumanForAction, type BrowserHumanStep } from './browser-human-step.js';
import { BrowserError } from './network.js';
import type { AgentSessionCheckpoint } from './session-state.js';

export type BrowserLiveScope = { ownerId: string; conversationId: string; runId: string };
export type BrowserLiveFrame = { id: string; bytes: Buffer };

interface LiveEntry {
  ownerId: string;
  conversationId: string;
  page: Page;
  closed?: boolean;
  mutations: number;
  captureReservation?: symbol;
  captureEpoch: number;
  held?: unknown;
  operation?: { authority: { liveRunId?: string } };
  ownerInputUntil?: number;
  lastUsed: number;
  redactions: Map<string, number>;
  recovery: { status: AgentSessionCheckpoint['status']; reviewRequired: boolean };
}

interface LiveBinding {
  runId: string;
  pages: WeakSet<Page>;
  ownerInput: boolean;
  manualReviewId?: string;
  revision: number;
  lastFrameAt: number;
  frame?: { id: string; page: Page; url: string; epoch: number; revision: number };
}

const bindings = new WeakMap<LiveEntry, LiveBinding>();
const capturing = new WeakSet<Page>();

function webPage(page: Page) {
  return !page.isClosed() && /^https?:\/\//iu.test(page.url());
}

export function bindBrowserLivePage(entry: LiveEntry, runId: string | undefined) {
  if (!runId || !webPage(entry.page)) return;
  const current = bindings.get(entry);
  if (current?.runId === runId) {
    current.pages.add(entry.page);
    return;
  }
  bindings.set(entry, { runId, pages: new WeakSet([entry.page]), ownerInput: false, revision: 0, lastFrameAt: -Infinity });
}

/** The first frame of a new navigation belongs to the run only after its main document commits. */
export function trackBrowserLiveNavigation(entry: LiveEntry, frame: Frame) {
  if (frame !== entry.page.mainFrame()) return;
  const active = bindings.get(entry);
  const ownerRun = (entry.ownerInputUntil ?? 0) > Date.now() ? active?.runId : undefined;
  bindBrowserLivePage(entry, entry.operation?.authority.liveRunId ?? ownerRun);
}

export function browserHasLiveBinding(entry: LiveEntry) {
  return bindings.has(entry);
}

export async function guardBrowserLiveAction(entry: LiveEntry, runId: string | undefined, action: AgentAction, read: () => Promise<AgentPage>, beforeDispatch = true) {
  if (!runId || !webPage(entry.page)) return;
  // A fresh open may replace a page left by an earlier run, even when that page is blocked.
  if (action.kind === 'open' && !action.ref && bindings.get(entry)?.runId !== runId) return;
  bindBrowserLivePage(entry, runId);
  requireBrowserHumanForAction(await read(), action, beforeDispatch);
}

// Sensitive selectors follow AgentBrowser.capture. The editable mask and secret echo protection are ported from
// https://github.com/ahmadalwakai/Mohassan-AI/pull/48 (retrieved 2026-11-27).
const sensitiveFields = 'input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]';
const editableFields = 'input:not([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio],[type=image]),textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=searchbox]';

export function browserLiveMasks(page: Page, secrets: readonly string[], maskEditables: boolean) {
  const fields = maskEditables ? `${sensitiveFields},${editableFields}` : sensitiveFields;
  return page.frames().filter(frame => !frame.isDetached()).flatMap(frame =>
    [frame.locator(fields), ...secrets.map(secret => frame.getByText(secret, { exact: false }))]);
}

export type LiveCheckpointStore = (checkpoint: AgentSessionCheckpoint) => Promise<void>;

interface LivePorts<Entry extends LiveEntry> {
  find(scope: BrowserLiveScope): Promise<Entry | undefined>;
  read(entry: Entry): Promise<AgentPage>;
  secrets(entry: Entry): string[];
  beginInput(entry: Entry): void;
  save(entry: Entry, saveCheckpoint?: LiveCheckpointStore): Promise<void>;
}

function currentPage(entry: LiveEntry, binding: LiveBinding, page = entry.page) {
  return !entry.closed && entry.page === page && bindings.get(entry) === binding && binding.pages.has(page) && webPage(page);
}

function matchesFrame(entry: LiveEntry, binding: LiveBinding, page: Page, id: string) {
  const frame = binding.frame;
  return frame?.id === id && frame.page === page && frame.url === page.url() && frame.epoch === entry.captureEpoch
    && frame.revision === binding.revision && currentPage(entry, binding, page);
}

function requireManualPage(entry: LiveEntry, binding: LiveBinding) {
  if (entry.operation || entry.held || entry.mutations || entry.captureReservation || binding.ownerInput) {
    throw new BrowserError('AGENT_LIVE_PAGE_BUSY', 'المتصفح مشغول الآن. حاول مجددًا بعد لحظة.', 409);
  }
}

const pageMissing = () => new BrowserError('AGENT_LIVE_PAGE_MISSING', 'لم تعد صفحة هذه المهمة مفتوحة.', 409);
const frameChanged = () => new BrowserError('AGENT_LIVE_FRAME_CHANGED', 'تغيّر عرض المتصفح. انتظر الصورة الأحدث ثم أعد الإدخال.', 409);

async function applyOwnerInput(page: Page, input: BrowserLiveInput, redactions: Map<string, number>) {
  if (input.kind === 'pointer') {
    const viewport = page.viewportSize();
    if (!viewport) throw pageMissing();
    await page.mouse.click(input.x * viewport.width, input.y * viewport.height);
    return;
  }
  // Use the same in-memory expiry as AgentBrowser.fillSecret.
  const remember = (text: string) => { if (text.trim().length >= 4) redactions.set(text, Date.now() + 10 * 60_000); };
  if (input.text) {
    remember(input.text);
    await page.keyboard.insertText(input.text);
  } else if (input.key) {
    await page.keyboard.press(input.key);
  }
  if (!input.text && input.key !== 'Backspace') return;
  // As in #36, retain the combined active edit only for masking a visible echo of split input.
  // https://github.com/ahmadalwakai/Mohassan-AI/pull/36 (retrieved 2026-11-27).
  for (const frame of page.frames().slice(0, 6)) {
    const value = await frame.evaluate(() => {
      if (!document.hasFocus()) return '';
      let node = document.activeElement;
      while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return node.value;
      return node instanceof HTMLElement && node.isContentEditable ? node.textContent ?? '' : '';
    }).catch(() => '');
    if (value) { remember(value.slice(0, 2000)); break; }
  }
}

/** Private live reads never allocate pages, replace cached screenshots or extend idle time. */
export function createBrowserLiveView<Entry extends LiveEntry>(ports: LivePorts<Entry>) {
  async function find(scope: BrowserLiveScope) {
    const entry = await ports.find(scope);
    if (!entry || entry.ownerId !== scope.ownerId || entry.conversationId !== scope.conversationId) return null;
    const binding = bindings.get(entry);
    return binding?.runId === scope.runId && currentPage(entry, binding) ? { entry, binding, page: entry.page } : null;
  }

  return {
    hasPage: async (scope: BrowserLiveScope) => Boolean(await find(scope)),
    async frame(scope: BrowserLiveScope, signal?: AbortSignal): Promise<BrowserLiveFrame | null> {
      const active = await find(scope);
      if (!active || signal?.aborted) return null;
      const { entry, page, binding } = active;
      const now = Date.now();
      if (entry.captureReservation || binding.ownerInput || capturing.has(page) || now - binding.lastFrameAt < browserLiveBudget.intervalMs) return null;
      const url = page.url();
      const epoch = entry.captureEpoch;
      const revision = binding.revision;
      binding.lastFrameAt = now;
      capturing.add(page);
      try {
        const mask = browserLiveMasks(page, ports.secrets(entry), true);
        // Existing browser JPEG quality. https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/browser/src/agent-browser.ts#L1127 (retrieved 2026-11-27).
        const bytes = await page.screenshot({ type: 'jpeg', quality: 62, timeout: browserLiveBudget.intervalMs, scale: 'css', mask }).catch(() => null);
        if (!bytes?.length || bytes.length > browserLiveBudget.maxFrameBytes || signal?.aborted || binding.ownerInput
          || !currentPage(entry, binding, page) || page.url() !== url || entry.captureEpoch !== epoch || binding.revision !== revision) return null;
        const previous = binding.frame?.id;
        const id = previous && matchesFrame(entry, binding, page, previous) ? previous : randomUUID();
        binding.frame = { id, page, url, epoch, revision };
        return { id, bytes };
      } finally { capturing.delete(page); }
    },
    async input(scope: BrowserLiveScope, input: BrowserLiveInput, signal?: AbortSignal, saveCheckpoint?: LiveCheckpointStore): Promise<void> {
      const active = await find(scope);
      if (!active) throw pageMissing();
      const { entry, page, binding } = active;
      requireManualPage(entry, binding);
      if (entry.recovery.reviewRequired || entry.recovery.status === 'review_required' && binding.manualReviewId !== input.handoverId) {
        throw new BrowserError('AGENT_RECOVERY_REVIEW_REQUIRED', 'راجع نتيجة الإجراء السابق قبل إدخال جديد.', 409);
      }
      if (!matchesFrame(entry, binding, page, input.frameId)) throw frameChanged();
      signal?.throwIfAborted();
      binding.ownerInput = true;
      entry.mutations++;
      const previous = entry.recovery.status;
      entry.recovery.status = 'review_required';
      try {
        try { await ports.save(entry, saveCheckpoint); }
        catch (error) { entry.recovery.status = previous; throw error; }
        binding.manualReviewId = input.handoverId;
        if (!matchesFrame(entry, binding, page, input.frameId)) throw frameChanged();
        signal?.throwIfAborted();
        binding.revision++;
        entry.lastUsed = Date.now();
        ports.beginInput(entry);
        await applyOwnerInput(page, input, entry.redactions);
      } finally {
        binding.ownerInput = false;
        entry.mutations--;
      }
    },
    async complete(scope: BrowserLiveScope, handoverId: string, saveCheckpoint?: LiveCheckpointStore,
      classify: (page: AgentPage) => BrowserHumanStep | null = detectBrowserHumanStep): Promise<{ url: string }> {
      const active = await find(scope);
      if (!active) throw pageMissing();
      const { entry, page, binding } = active;
      requireManualPage(entry, binding);
      if (entry.recovery.reviewRequired || entry.recovery.status === 'review_required' && binding.manualReviewId !== handoverId) {
        throw new BrowserError('AGENT_RECOVERY_REVIEW_REQUIRED', 'راجع نتيجة الإجراء السابق قبل المتابعة.', 409);
      }
      binding.ownerInput = true;
      binding.revision++;
      entry.mutations++;
      try {
        const epoch = entry.captureEpoch;
        const observed = await ports.read(entry);
        if (!currentPage(entry, binding, page) || entry.captureEpoch !== epoch) throw pageMissing();
        const step = classify(observed);
        if (step) throw new BrowserHumanStepError(step, observed);
        entry.ownerInputUntil = undefined;
        if (binding.manualReviewId === handoverId) {
          entry.recovery.status = 'ready';
          try { await ports.save(entry, saveCheckpoint); }
          catch (error) { entry.recovery.status = 'review_required'; throw error; }
        }
        // Preserve the marker across a transaction retry. A new run has a new binding.
        return { url: observed.url };
      } finally {
        binding.ownerInput = false;
        entry.mutations--;
      }
    },
  };
}
