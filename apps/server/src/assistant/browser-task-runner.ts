import { setTimeout as delay } from 'node:timers/promises';
import {
  AgentEffectHeld, BrowserError, BrowserHumanStepError, browserHumanStep, browserHandsConsent,
  browserHandsPagination, detectBrowserHumanStep, findBrowserHandsElement, isBrowserPaymentConfirmation,
  type AgentAction, type AgentActionResult, type AgentElement, type AgentHeldEffect, type AgentPage,
  type AgentRequestPermit, type BrowserHumanStep, type SearchHit,
} from '@mohassan/browser';
import { sensitiveAction } from './brain.js';
import type { BrowserTaskSpec, BrowserTaskStep } from './browser-task-spec.js';

export type BrowserTaskLog = { text: string; verified: boolean; kind: 'step' | 'readback' | 'handover' | 'retry' };
type PageIdentity = Pick<AgentPage, 'url' | 'hash'>;

export interface BrowserTaskWait {
  step: BrowserHumanStep;
  origin: Pick<PageIdentity, 'url'>;
  targetUrl?: string;
  completeStep: boolean;
  target?: { kind: 'fill' | 'select' | 'click'; name: string; role?: string; nearby?: string; position?: number };
}

export interface BrowserTaskProgress {
  next: number;
  waiting?: BrowserTaskWait;
  legacy?: boolean;
  handovers?: number;
  humanResult?: { status: 'clear' | 'next'; page: { urlHash: string; hash: string } } | { status: 'timeout' | 'skipped'; message: string };
  approval?: { index: number; purpose: 'step' | 'cookie'; released?: boolean };
  stopped?: string;
  output: string[];
  consent: string[];
}

export type BrowserTaskApproval = { action: AgentAction; permit: AgentRequestPermit } | { held: AgentHeldEffect };

export interface BrowserTaskPort {
  signal: AbortSignal;
  observe(): Promise<AgentPage | null>;
  act(action: AgentAction): Promise<AgentActionResult>;
  prepare(action: AgentAction): Promise<AgentRequestPermit | null>;
  search(query: string): Promise<readonly SearchHit[]>;
  begin(index: number): Promise<void>;
  record(index: number, log: BrowserTaskLog): Promise<void>;
  text(value: string): string;
  rethrow(error: unknown): void;
}

type Outcome = { status: 'completed' | 'partial' | 'blocked'; text: string }
  | { status: 'human'; wait: BrowserTaskWait; page: AgentPage }
  | { status: 'approval'; approval: BrowserTaskApproval; label: string };

const MAX_PAGE_ADVANCES = 4;
const MAX_READ_CHARS = 2200;
const choose = (task: BrowserTaskSpec, ar: string, en: string) => task.lang === 'ar' ? ar : en;
const short = (value: string) => value.trim().slice(0, 140);

function isSensitiveControl(element: AgentElement) {
  return Boolean(sensitiveAction(element.label) || sensitiveAction(element.match?.actionText ?? ''));
}

export function newBrowserTaskProgress(): BrowserTaskProgress {
  return { next: 0, output: [], consent: [] };
}

export function browserTaskLabel(task: BrowserTaskSpec, step: BrowserTaskStep): string {
  const target = 'target' in step && step.target ? ' «' + short(step.target) + '»' : '';
  const action = {
    open: ['فتح الموقع', 'Open site'], find: ['العثور على', 'Find'], read: ['قراءة الصفحة', 'Read page'],
    fill: ['تعبئة الحقل', 'Fill field'], select: ['اختيار قيمة', 'Select value'], click: ['الضغط على', 'Click'],
    download: ['تحديد ملف للتنزيل', 'Find download'], upload: ['تحديد حقل للرفع', 'Find upload field'],
  }[step.kind];
  return choose(task, action[0], action[1]) + (step.kind === 'open' ? ' ' + short(step.name) : target);
}

function safeLocation(url: string) {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : ''; }
  catch { return ''; }
}

export function browserTaskSafeLocation(url: string) {
  const origin = safeLocation(url);
  return origin ? origin + new URL(url).pathname : '';
}

function assertPage(page: AgentPage | null): asserts page is AgentPage {
  if (!page || !safeLocation(page.url)) throw new BrowserError('BROWSER_HANDS_PAGE_REQUIRED', 'افتح الصفحة المطلوبة أولًا.', 409);
}

function bound(page: AgentPage, step: 'click' | 'type' | 'select', ref: string, options: { text?: string; irreversible?: boolean; privacy?: boolean } = {}): AgentAction {
  const { text, ...guard } = options;
  return { kind: step, ref, text, browserHands: { url: page.url, ...guard } };
}

function stepFailure(task: BrowserTaskSpec, step: BrowserTaskStep, index: number, reason: string, prior: string[]): Outcome {
  const prefix = choose(task, 'توقفت عند الخطوة', 'Stopped at step');
  return { status: index ? 'partial' : 'blocked', text: [...prior, `${prefix} ${index + 1} (${browserTaskLabel(task, step)}). ${reason}`].join('\n\n') };
}

function readContent(page: AgentPage, step: Extract<BrowserTaskStep, { kind: 'read' }>): string {
  if (!page.content) return step.section === 'main' || step.section === 'all' ? page.text : '';
  return page.content.flatMap(frame => {
    const tables = frame.tables.map(table => [table.caption, ...table.rows.map(row => row.join(' | '))].filter(Boolean).join('\n'));
    const lists = frame.lists.map(list => list.items.map((item, index) => list.ordered ? `${index + 1}. ${item}` : `• ${item}`).join('\n'));
    const forms = frame.forms.map(form => [form.label, ...form.fields.map(field => `${field.label || field.role} — ${Array.isArray(field.value) ? field.value.join(', ') : field.value ?? '—'}`)].filter(Boolean).join('\n'));
    const sections = { main: [frame.main], tables, lists, forms, all: [frame.main, ...tables, ...lists, ...forms] };
    return sections[step.section];
  }).filter(Boolean).join('\n\n');
}

function lookup(page: AgentPage, step: Exclude<BrowserTaskStep, { kind: 'open' | 'read' }>, alternative = false) {
  return findBrowserHandsElement(page.elements, { name: step.target, ...step.match }, { kind: step.kind, alternative });
}

function humanForAction(page: AgentPage, step: BrowserTaskStep, element?: AgentElement): BrowserHumanStep | null {
  const kind = 'human' in step ? step.human : undefined;
  const field = element?.match ? element.match.humanOnly
    : element?.field === 'password' ? 'login' : element?.field === 'otp' ? 'code' : element?.field === 'card' ? 'payment' : null;
  if (kind === 'login' || field === 'login') return browserHumanStep('login', page.url);
  if (kind === 'code' || field === 'code') return browserHumanStep('code', page.url);
  if (kind === 'payment' || field === 'payment' || step.kind === 'click' && element && (isBrowserPaymentConfirmation(element.label) || isBrowserPaymentConfirmation(element.match?.actionText ?? '')))
    return browserHumanStep('payment', page.url);
  if (kind === 'challenge') return browserHumanStep('bot_check', page.url);
  if (kind === 'identifier' || field === 'identity') return browserHumanStep('identity', page.url);
  return null;
}

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670]/gu, '').replace(/[أإآ]/gu, 'ا').replace(/\s+/gu, ' ').trim();

function matchedText(text: string, target: string) {
  const wanted = normalize(target);
  return wanted && text.split('\n').find(line => normalize(line).includes(wanted))?.trim();
}

function isUsableDocument(page: AgentPage) {
  return page.documentStatus === undefined || page.documentStatus >= 200 && page.documentStatus < 400;
}

export async function runBrowserTask(task: BrowserTaskSpec, state: BrowserTaskProgress, io: BrowserTaskPort, initial: AgentPage | null): Promise<Outcome> {
  const missing = task.requiredData.filter(item => !item.supplied && item.kind !== 'manual');
  if (missing.length || !task.steps.length) {
    const names = [...new Set(missing.map(item => short(io.text(item.name))))].join(choose(task, '، ', ', '));
    return { status: 'blocked', text: names ? choose(task, `أحتاج هذه المعلومات قبل أن أفتح الموقع أو أنفّذ إجراءً. ${names}`, `I need the following information before acting. ${names}`)
      : choose(task, 'حدد الموقع والخطوة المطلوبة في المتصفح.', 'Specify the site and the browser step you want.') };
  }

  let page = initial;
  const output = (text: string) => { if (state.output.length < 12) state.output.push(io.text(text).slice(0, MAX_READ_CHARS)); };
  for (let index = state.next; index < task.steps.length; index = state.next) {
    io.signal.throwIfAborted();
    const step = task.steps[index];
    const label = io.text(browserTaskLabel(task, step));
    await io.begin(index);
    const finishStep = async (text: string, kind: BrowserTaskLog['kind'] = 'step') => {
      state.next = index + 1;
      await io.record(index, { text, kind, verified: true });
    };
    const human = (current: AgentPage, needed: BrowserHumanStep, completeStep = false, targeted = false): Outcome => {
      const wait: BrowserTaskWait = { step: needed, origin: { url: browserTaskSafeLocation(current.url) },
        ...(step.kind === 'open' ? { targetUrl: browserTaskSafeLocation(step.url) } : task.target.kind === 'site' ? { targetUrl: browserTaskSafeLocation(task.target.url) } : {}),
        completeStep,
        ...(targeted && (step.kind === 'fill' || step.kind === 'select' || step.kind === 'click') ? { target: { kind: step.kind, name: step.target, ...step.match } } : {}) };
      return { status: 'human', wait, page: current };
    };
    let purpose: 'step' | 'cookie' = 'step';
    let reusedOpen = false;
    try {
      if (state.stopped) return stepFailure(task, step, index, state.stopped, state.output);
      if (state.humanResult) {
        const resolved = state.humanResult;
        const waiting = state.waiting;
        state.humanResult = undefined;
        state.waiting = undefined;
        if (resolved.status === 'timeout' || resolved.status === 'skipped') return stepFailure(task, step, index, resolved.message, state.output);
        assertPage(page);
        const blocker = detectBrowserHumanStep(page);
        if (blocker) return human(page, blocker, waiting?.completeStep);
        if (waiting?.completeStep) {
          await finishStep(choose(task, `${label} — اكتملت الخطوة اليدوية وتحققت من الصفحة بعدها`, `${label} — manual step completed and page checked`));
          continue;
        }
      }
      if (state.approval?.index === index) {
        const approved = state.approval;
        state.approval = undefined;
        if (!approved.released) return stepFailure(task, step, index, choose(task, 'لم تُمنح الموافقة على الإجراء.', 'Approval was declined.'), state.output);
        if (approved.purpose === 'cookie' && step.kind === 'open') reusedOpen = true;
        if (approved.purpose === 'step') {
          assertPage(page);
          const blocker = detectBrowserHumanStep(page);
          if (blocker) return human(page, blocker, true);
          if (!isUsableDocument(page)) throw new BrowserError('BROWSER_HANDS_UNVERIFIED', 'لم ينجح تحميل الصفحة بعد الموافقة.', 409);
          await finishStep(choose(task, `${label} — أُرسل الإجراء الموافق عليه ورُصدت الصفحة الناتجة`, `${label} — approved action sent and resulting page observed`));
          continue;
        }
      }
      if (step.kind === 'open' && !reusedOpen)
        page = (await io.act({ kind: 'open', text: step.url, browserHands: { url: step.url } })).page;
      if (step.kind === 'find' && step.scope === 'web') {
        const hits = await io.search(step.target);
        if (!hits.length) throw new BrowserError('BROWSER_HANDS_NO_RESULTS', 'لم تظهر نتائج بحث.', 404);
        output(hits.slice(0, 5).map(hit => `${hit.title}\n${hit.url}`).join('\n\n'));
        await finishStep(choose(task, `${label} — ${hits.length} نتائج`, `${label} — ${hits.length} results`));
        continue;
      }

      page ??= await io.observe();
      assertPage(page);
      const blocker = detectBrowserHumanStep(page);
      if (blocker) return human(page, blocker, step.kind === 'open');
      const consent = browserHandsConsent(page.elements);
      const consentKey = safeLocation(page.url);
      if (consent && !isSensitiveControl(consent) && !state.consent.includes(consentKey)) {
        purpose = 'cookie';
        state.consent.push(consentKey);
        const action = bound(page, 'click', consent.ref, { privacy: true });
        const permit = await io.prepare(action);
        if (permit?.method === 'POST') {
          state.approval = { index, purpose };
          return { status: 'approval', approval: { action, permit }, label: 'رفض ملفات الارتباط غير الضرورية' };
        }
        page = (await io.act(action)).page;
        if (!browserHandsConsent(page.elements))
          await io.record(index, { text: 'رُفضت ملفات الارتباط غير الضرورية', kind: 'step', verified: false });
        purpose = 'step';
        const afterConsent = detectBrowserHumanStep(page);
        if (afterConsent) return human(page, afterConsent, step.kind === 'open');
      }
      if (step.kind === 'open') {
        if (!isUsableDocument(page)) throw new BrowserError('BROWSER_HANDS_UNVERIFIED', `HTTP ${page.documentStatus}`, 409);
        output(choose(task, `فُتحت ${page.title || safeLocation(page.url)}.`, `Opened ${page.title || safeLocation(page.url)}.`));
        await finishStep(label);
        continue;
      }

      if (step.kind === 'read') {
        const segments = new Set<string>();
        const visited = new Set<string>();
        for (let count = 0; count <= MAX_PAGE_ADVANCES; count++) {
          const text = readContent(page, step);
          const match = step.target ? matchedText(text, step.target) : text;
          if (match && !visited.has(match)) {
            visited.add(match);
            for (const part of match.split('\n\n')) if (part.trim()) segments.add(part.trim());
          }
          if (!step.more || count === MAX_PAGE_ADVANCES) break;
          const next = browserHandsPagination(page.elements);
          const action: AgentAction = next
            ? bound(page, 'click', next.ref)
            : { kind: 'scroll', text: 'down', browserHands: { url: page.url } };
          if (next && (isSensitiveControl(next) || await io.prepare(action))) break;
          const before = page;
          page = (await io.act(action)).page;
          const interstitial = detectBrowserHumanStep(page);
          if (interstitial) {
            if (segments.size) output([...segments].join('\n\n'));
            return human(page, interstitial);
          }
          if (before.hash === page.hash && before.url === page.url && before.scroll.top === page.scroll.top) break;
        }
        const text = [...segments].join('\n\n').slice(0, MAX_READ_CHARS);
        if (!text.trim()) throw new BrowserError('BROWSER_HANDS_NO_CONTENT', 'لم أجد المحتوى المحدد في الصفحة.', 404);
        output(text);
        const section = { main: ['المحتوى الرئيسي', 'main content'], tables: ['الجداول', 'tables'], lists: ['القوائم', 'lists'],
          forms: ['النماذج', 'forms'], all: ['المحتوى وعناصره', 'content and structure'] }[step.section];
        const host = new URL(page.url).host;
        await finishStep(choose(task, `${label} — ${section[0]} في ${host}، ${text.length} حرفًا`,
          `${label} — ${section[1]} at ${host}, ${text.length} characters`));
        continue;
      }

      let usedAlternative = false;
      let match = lookup(page, step);
      if (match.status !== 'matched') {
        usedAlternative = true;
        await io.record(index, { text: choose(task, 'أعدت قراءة العناصر وجربت طريقة مطابقة أخرى.', 'Refreshed elements and tried an alternative match.'), kind: 'retry', verified: false });
        await delay(700, undefined, { signal: io.signal });
        page = await io.observe();
        assertPage(page);
        const interstitial = detectBrowserHumanStep(page);
        if (interstitial) return human(page, interstitial);
        match = lookup(page, step, true);
      }
      if (match.status !== 'matched') {
        if (step.kind === 'find') {
          const body = matchedText(page.text, step.target);
          if (body) { output(body); await finishStep(label); continue; }
        }
        throw new BrowserError(match.status === 'ambiguous' ? 'BROWSER_HANDS_AMBIGUOUS' : 'BROWSER_HANDS_NOT_FOUND',
          match.status === 'ambiguous' ? 'وجدت أكثر من عنصر مطابق.' : 'لم أجد عنصرًا مطابقًا بعد إعادة القراءة.', 409);
      }

      const element = match.element;
      if (step.kind === 'find') { output(element.label); await finishStep(label); continue; }
      if (step.kind === 'download' || step.kind === 'upload') {
        const text = choose(task, `وجدت «${element.label}». وافق على نقل الملف من قسم الملفات في لوحة المتصفح.`,
          `Found “${element.label}”. Approve the transfer under Files in the browser panel.`);
        return stepFailure(task, step, index, text, state.output);
      }
      const manual = humanForAction(page, step, element);
      if (manual) return human(page, manual, true, true);

      const perform = async (target: AgentElement, current: AgentPage) => {
        const irreversible = step.risk === 'irreversible' || step.kind === 'click' && isSensitiveControl(target);
        const action = step.kind === 'click' ? bound(current, 'click', target.ref, { irreversible })
          : bound(current, step.kind === 'select' || target.role === 'checkbox' || target.role === 'radio' ? 'select' : 'type', target.ref,
            { text: step.value });
        const permit = await io.prepare(action);
        if (permit && (irreversible || permit.method !== 'GET')) {
          state.approval = { index, purpose: 'step' };
          return { status: 'approval', approval: { action, permit }, label } satisfies Outcome;
        }
        if (irreversible) throw new BrowserError('BROWSER_HANDS_APPROVAL_UNAVAILABLE', 'تعذّر ربط الإجراء غير القابل للتراجع بموافقة محددة.', 409);
        const result = await io.act(action);
        const prior = current;
        page = result.page;
        if (step.kind === 'fill' || step.kind === 'select') {
          if (!result.browserHandsWrite?.verified) throw new BrowserError('BROWSER_HANDS_UNVERIFIED', 'تعذرت قراءة القيمة بعد الكتابة.', 409);
          await finishStep(`${label} — •••• — ${choose(task, 'قُرئت القيمة وتطابقت', 'value read back and verified')}`, 'readback');
        } else {
          const afterClick = detectBrowserHumanStep(page);
          if (afterClick) return human(page, afterClick, true);
          if (!result.changed && prior.url === page.url && prior.hash === page.hash)
            throw new BrowserError('BROWSER_HANDS_UNVERIFIED', 'تم النقر ولم يظهر أثر يمكن التحقق منه.', 409);
          await finishStep(label);
        }
        return undefined;
      };
      try {
        const resolved = await perform(element, page);
        if (resolved) return resolved;
      } catch (error) {
        if (!(error instanceof BrowserError) || error.code !== 'AGENT_REF_STALE' || usedAlternative) throw error;
        await io.record(index, { text: choose(task, 'تغيّر العنصر وأعدت مطابقته.', 'The element changed. Matched it again.'), kind: 'retry', verified: false });
        page = await io.observe();
        assertPage(page);
        const interstitial = detectBrowserHumanStep(page);
        if (interstitial) return human(page, interstitial);
        const retry = lookup(page, step, true);
        if (retry.status !== 'matched') throw error;
        const manualRetry = humanForAction(page, step, retry.element);
        if (manualRetry) return human(page, manualRetry, true, true);
        const resolved = await perform(retry.element, page);
        if (resolved) return resolved;
      }
    } catch (error) {
      io.signal.throwIfAborted();
      io.rethrow(error);
      if (error instanceof BrowserHumanStepError) {
        const fresh = await io.observe();
        if (fresh) {
          const matched = step.kind === 'fill' || step.kind === 'select' || step.kind === 'click' ? lookup(fresh, step) : null;
          const blockedTarget = matched?.status === 'matched' && Boolean(humanForAction(fresh, step, matched.element));
          const privateForm = error.step.reason === 'identity' && step.kind === 'click'
            && fresh.elements.some(element => element.match?.humanOnly === 'identity' && !element.disabled);
          return human(fresh, error.step, blockedTarget || privateForm, blockedTarget || privateForm);
        }
      }
      if (error instanceof AgentEffectHeld) {
        state.approval = { index, purpose };
        return { status: 'approval', approval: { held: error.held }, label };
      }
      const reason = error instanceof BrowserError ? io.text(error.message).slice(0, 250) : choose(task, 'تعذر التحقق من نتيجة الخطوة.', 'The step outcome could not be verified.');
      await io.record(index, { text: `${label} — ${reason}`, kind: 'step', verified: false });
      return stepFailure(task, step, index, reason, state.output);
    }
  }
  return { status: 'completed', text: state.output.join('\n\n') || choose(task, 'اكتملت خطوات المتصفح وتحققت من نتائجها.', 'The browser steps completed and their results were verified.') };
}
