import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { detectBrowserHumanStep, waitForBrowserHumanProgress, type AgentBrowser, type AgentPage, type BrowserHumanStep } from '@mohassan/browser';
import { BrowserPremiumMetadataSchema, type BrowserPremiumMetadata, type BrowserPremiumStepKind, type ChatSecureRequest } from '@mohassan/contracts';
import { directRoute, type BrainState } from './brain.js';
import { parseHands } from './hands.js';

export const browserHandoverResumed = 'استئناف المتصفح بعد اكتمال خطوتك';
const stepPrefixes: ReadonlyArray<[BrowserPremiumStepKind, RegExp]> = [
  ['opening', /^(?:فتح|الرجوع للصفحة|open(?:ing)?\b|navigat(?:e|ing)\b)/iu],
  ['reading', /^(?:قراءة|إعادة قراءة|التمرير|النقر|الضغط|ضغط مفتاح|read(?:ing)?\b|look\b|scroll\b)/iu],
  ['typing', /^(?:كتابة|الكتابة|إدخال|تعبئة|ملء|اختيار|fill(?:ing)?\b|typ(?:e|ing)\b|select(?:ing)?\b)/iu],
  ['loading', /^(?:انتظار|الانتظار|waiting\b|wait\b|loading\b)/iu],
];

function webLocation(value: string | undefined | null): URL | null {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  return /^(?:https?):$/.test(url.protocol) && !url.username && !url.password ? url : null;
}

export function premiumBrowserStepKind(message: string): BrowserPremiumStepKind | undefined {
  if (message === browserHandoverResumed || message === 'اكتمل تسجيل الدخول') return 'resumed';
  return stepPrefixes.find(([, prefix]) => prefix.test(message))?.[0];
}

export function premiumBrowserTarget(page: AgentPage, secure: ChatSecureRequest | null, approvalRef?: string): string | undefined {
  if (!secure) return approvalRef;
  const secureOrigin = webLocation(secure.site)?.origin;
  if (!secureOrigin || secureOrigin !== webLocation(page.url)?.origin) return undefined;
  const controls = page.elements.filter(element => !element.disabled && element.inViewport);
  const field = (kind: typeof controls[number]['field']) => controls.find(element => element.field === kind)?.ref;
  if (secure.kind === 'code') return field('otp');
  if (secure.kind === 'login') return field('identifier') ?? field('password');
  const detected = detectBrowserHumanStep(page);
  if (detected?.reason === 'login') return field('identifier') ?? field('password');
  if (detected?.reason === 'code') return field('otp');
  if (detected?.reason === 'payment') return field('card');
  if (detected?.reason === 'bot_check') return controls.find(element => /captcha|robot|human|روبوت|إنسان/iu.test(element.label))?.ref;
  return undefined;
}

export async function projectBrowserPremium(input: {
  browser: Pick<AgentBrowser, 'premiumPage'>;
  ownerId: string;
  conversationId: string;
  pageUrl?: string;
  status: string;
  secure: ChatSecureRequest | null;
  run?: { id: string; status: string; state?: BrainState };
  steps: readonly { id: string; message: string }[];
}): Promise<BrowserPremiumMetadata | undefined> {
  const { browser, ownerId, conversationId, pageUrl, status, secure, run } = input;
  const site = webLocation(secure?.site) ?? webLocation(pageUrl);
  const route = run?.state?.routing?.route;
  if (!site && route !== 'browser_command' && route !== 'news') return undefined;
  const steps: BrowserPremiumMetadata['steps'] = input.steps.flatMap(step => {
    const kind = premiumBrowserStepKind(step.message);
    return kind ? [{ id: step.id, kind }] : [];
  });
  if (run && (status === 'waiting_input' || status === 'waiting_approval')) steps.push({ id: `${run.id}-handover`, kind: 'handover' });
  if (run && status === 'idle' && run.status === 'completed') steps.push({ id: `${run.id}-done`, kind: 'done' });
  const approvalRef = status === 'waiting_approval' ? run?.state?.pendingAction?.action.ref : undefined;
  const geometry = secure || approvalRef ? (page: AgentPage) => premiumBrowserTarget(page, secure, approvalRef) : undefined;
  const peek = site ? await browser.premiumPage?.(ownerId, conversationId, geometry, true).catch(() => null) : null;
  const favicon = BrowserPremiumMetadataSchema.shape.site.unwrap().shape.favicon.safeParse(peek?.favicon).data;
  const result = BrowserPremiumMetadataSchema.safeParse({
    site: site ? { domain: site.host, ...(favicon && { favicon }) } : undefined,
    target: peek?.target,
    steps: steps.slice(-12),
  });
  return result.success ? result.data : undefined;
}

interface HandoverPorts {
  db: Kysely<any>;
  browser: Pick<AgentBrowser, 'premiumPage'>;
  current: { ownerId: string; page?: AgentPage; request?: string } | undefined;
  conversationId: string;
  runId: string;
  secure: Omit<ChatSecureRequest, 'id'>;
  settled(): Promise<unknown>;
  canWait(ownerId: string): boolean | Promise<boolean>;
  resume(ownerId: string, secureId: string): Promise<unknown>;
}

function requestedDestination(request: string | undefined) {
  if (!request) return undefined;
  const open = parseHands(request)?.find(step => step.kind === 'open');
  return open?.url ?? directRoute(request)?.url;
}

function secureStep(step: BrowserHumanStep, page: AgentPage): ChatSecureRequest {
  return { id: randomUUID(), kind: step.kind, site: new URL(page.url).origin, prompt: step.prompt, note: null, fields: [] };
}

/** The receipt that advances a handover is a fresh stable observation from the server browser. */
export function watchPremiumBrowserHandover(ports: HandoverPorts): Promise<void> | undefined {
  const { current, secure, db, conversationId, runId, browser } = ports;
  const original = webLocation(current?.page?.url);
  const detected = current?.page && detectBrowserHumanStep(current.page);
  if (!current || !original || !detected || original.origin !== webLocation(secure.site)?.origin
    || (secure.kind !== 'hands_on' && secure.kind !== detected.kind) || typeof browser.premiumPage !== 'function') return;
  const ownerId = current.ownerId;
  const hasHandover = () => db.selectFrom('chat_conversations').select('secure')
    .where('id', '=', conversationId).where('owner_id', '=', ownerId).where('active_run_id', '=', runId).where('status', '=', 'waiting_input');
  async function wait() {
    await ports.settled();
    const row = await hasHandover().executeTakeFirst();
    if (!row?.secure?.id || row.secure.site !== secure.site || row.secure.kind !== secure.kind) return;
    const signal = AbortSignal.timeout(5 * 60_000);
    const stopped = new AbortController();
    const watchSignal = AbortSignal.any([signal, stopped.signal]);
    const targetUrl = requestedDestination(current?.request) ?? original!.href;
    let step = detected!;
    let originalUrl = original!.href;
    let secureId = String(row.secure.id);
    while (!watchSignal.aborted) {
      const outcome = await waitForBrowserHumanProgress({
        step, originalUrl, targetUrl, signal: watchSignal,
        observe: async () => {
          if (!await ports.canWait(ownerId) || (await hasHandover().executeTakeFirst())?.secure?.id !== secureId) {
            stopped.abort();
            return null;
          }
          return (await browser.premiumPage(ownerId, conversationId, () => undefined))?.page ?? null;
        },
      });
      if (outcome.status === 'timeout') return;
      if (outcome.status === 'clear') {
        if (await ports.canWait(ownerId)) await ports.resume(ownerId, secureId);
        return;
      }
      // The initial login and the verification code can be consecutive pages.
      // Refresh the card while the same lease stays paused.
      const next = secureStep(outcome.step, outcome.page);
      const updated = await db.updateTable('chat_conversations').set({ secure: JSON.stringify(next), updated_at: new Date() })
        .where('id', '=', conversationId).where('owner_id', '=', ownerId).where('active_run_id', '=', runId).where('status', '=', 'waiting_input')
        .where(sql<string>`secure->>'id'`, '=', secureId).returning('id').executeTakeFirst();
      if (!updated) return;
      step = outcome.step;
      originalUrl = outcome.page.url;
      secureId = next.id;
    }
  }
  // A manual Continue, cancellation or steering can win the claim. The
  // owner's action remains authoritative, and an unreadable page stays paused.
  return wait().catch(() => {});
}
