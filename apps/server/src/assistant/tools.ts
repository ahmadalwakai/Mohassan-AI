import { BrowserError } from '@mohassan/browser';
import type { CreateTaskInput, Task } from '@mohassan/contracts';
import type { WindowsControl } from '@mohassan/windows';
import { GoogleAdsBriefSchema } from '@mohassan/contracts';
import type { GoogleAdsControl } from '@mohassan/google-ads';
import { z } from 'zod';
import type { CampaignPorts } from './campaign-run.js';

/**
 * What the assistant may reach outside the browser. Each adapter calls the
 * module's own control, so ownership, approvals, isolation and verification
 * stay where they already are; nothing here is a second execution path.
 */

const Goal = z.string().trim().min(5).max(4000);
const CodeInput = z.object({ projectId: z.uuid(), goal: Goal }).strict();
const StudioInput = z.object({ sessionId: z.uuid(), goal: Goal }).strict();

export type ComputerStep = { kind: 'click'; name: string; type: string } | { kind: 'text'; text: string } | { kind: 'key'; key: string };
export interface ComputerElement { ref: string; name: string; type: string }
export interface ComputerScreen { title: string; canAct: boolean; hasPasswordField: boolean; elements: ComputerElement[]; jpeg: string }
export interface PendingWorkTask { id: string; label: string; prompt: string; detail: string }
export interface TaskOutcome { settled: boolean; text: string }
export interface AdsAccountChoice { customerId: string; loginCustomerId: string | null; name: string }
export type MemoryLookupResult = string | { text: string; evidence: readonly string[] };

export interface AssistantTools {
  memory?: {
    search(ownerId: string, query: string): Promise<MemoryLookupResult>;
    /** The owner's own words are kept beside the fact, so a later search in their language finds it. */
    save(ownerId: string, text: string, request: string): Promise<string>;
  };
  work?: {
    list(ownerId: string): Promise<string>;
    inventory?(ownerId: string): Promise<{ id: string; name: string }[]>;
    code?(ownerId: string, input: { id: string; goal: string }, idempotencyKey: string, runId?: string): Promise<PendingWorkTask>;
    studio?(ownerId: string, input: { id: string; goal: string }, idempotencyKey: string, runId?: string): Promise<PendingWorkTask>;
    approve(ownerId: string, taskId: string): Promise<void>;
    cancel(ownerId: string, taskId: string): Promise<void>;
    outcome(ownerId: string, taskId: string): Promise<TaskOutcome>;
  };
  ads?: {
    status(ownerId: string): Promise<string>;
    report(ownerId: string): Promise<string>;
    draft(ownerId: string, text: string, request: string, idempotencyKey: string): Promise<string>;
    createPaused?(ownerId:string,text:string,request:string,idempotencyKey:string,assertActive:()=>Promise<void>):Promise<string>;
    /** The stored connection state; no request goes to Google. */
    connection?(ownerId: string): Promise<{ state: string; account: string | null }>;
    /** Accounts that can hold campaigns, read from Google with the owner's grant. */
    accounts?(ownerId: string): Promise<AdsAccountChoice[]>;
    selectAccount?(ownerId: string, choice: AdsAccountChoice): Promise<void>;
    /** The tracked campaign task. Errors keep their module type so recovery can classify them. */
    campaign?: CampaignPorts;
  };
  computer?: {
    view(ownerId: string): Promise<ComputerScreen>;
    perform(ownerId: string, step: ComputerStep, signal: AbortSignal): Promise<string>;
  };
}

const MAX_LISTED_ELEMENTS = 24;
const ACTIONABLE = /Button|Edit|MenuItem|ListItem|TabItem|CheckBox|ComboBox|Hyperlink|RadioButton/;
/** A key that can activate whatever has focus has a sending effect we cannot see. */
export const EFFECT_KEYS = new Set(['Enter', 'Space', 'Delete']);
/** Only the current owner's request authorizes account creation, never retrieved content. */
export function requestsPausedCampaign(request:string):boolean {
  const text=request.normalize('NFKC').replace(/[أإآ]/g,'ا').toLowerCase();
  if(/\b(?:do not|don't|never)\b|لا\s+(?:تنش|تعمل|تحفظ|تبن)|معاينة فقط|مسودة فقط|preview only|draft only/i.test(text))return false;
  const direct=/^(?:(?:please|can you|could you|i want you to)\s+){0,2}(?:create|build|save)\b/i.test(text.trim())||/^(?:(?:من فضلك|لو سمحت)\s+)?(?:(?:اريد|احتاج)(?:\s+منك)?\s+(?:ان\s+)?(?:تنشئ|انشاء|تبني|بناء|تحفظ|حفظ)|انشئ|انشاء|ابنِ?|ابني|احفظ)(?:\s|$)/u.test(text.trim());
  return direct&&/حمل[ةه]|\bcampaign\b/i.test(text)&&/حساب|google ads|جوجل ادز|غوغل ادز|\baccount\b/i.test(text);
}

const money = (micros: string, currency: string) => `${(Number(micros) / 1_000_000).toFixed(2)} ${currency}`;

/** The model writes fields line by line; plain lines are what it fills reliably. */
export function parseAdsDraft(text: string, request: string) {
  const fields: Record<string, string> = {}, lists: Record<string, string[]> = { H: [], D: [], P: [], K: [], N: [], LOCATION: [] };
  for (const line of text.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean)) {
    const match = /^(?:[-*•]\s*)?([A-Za-z]+)\s*\d*\s*:\s*(.*)$/.exec(line);
    if (!match) throw new BrowserError('ASSISTANT_INPUT', `ads_draft line not understood: ${line.slice(0, 80)}`, 400);
    const key = match[1]!.toUpperCase(), value = match[2]!.trim();
    if (lists[key]) lists[key].push(...(key === 'P' ? value.split('/').map(item => item.trim()) : [value])); else fields[key] = value;
  }
  const parsed = GoogleAdsBriefSchema.safeParse({
    businessName: fields.BUSINESS, service: fields.SERVICE, goal: fields.GOAL, landingPageUrl: fields.URL, locations: lists.LOCATION, countryCode: fields.COUNTRY?.toUpperCase(), adLanguage: fields.LANGUAGE?.toLowerCase(),
    dailyBudget: fields.BUDGET, ownerFacts: [request.slice(0, 300)], headlines: lists.H, descriptions: lists.D, paths: lists.P, keywords: lists.K, negativeKeywords: lists.N,
  });
  if (!parsed.success) throw new BrowserError('ASSISTANT_INPUT', `ads_draft fields are missing or invalid: ${[...new Set(parsed.error.issues.map(issue => issue.path.join('.')))].join(', ')}`, 400);
  return parsed.data;
}

const shortType = (type: string) => type.replace(/^ControlType\./, '');

/** Module errors become tool results the assistant can report honestly. */
export async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (error instanceof BrowserError) throw error;
    if (error instanceof z.ZodError) throw new BrowserError('ASSISTANT_INPUT', 'مدخلات الأداة غير صالحة.', 400);
    const failure = error as { code?: unknown; message?: string; statusCode?: number };
    if (typeof failure.code === 'string' && failure.message) throw new BrowserError(failure.code, failure.message, failure.statusCode ?? 409);
    throw error;
  }
}

function pendingTask(task: Pick<Task, 'id' | 'status'>, label: string, prompt: string, detail: string): PendingWorkTask {
  if (task.status !== 'waiting_approval') throw new BrowserError('ASSISTANT_TASK_STATE', 'لم تُنشأ مهمة تنتظر الموافقة.', 409);
  return { id: task.id, label, prompt, detail };
}

/** Facts for the model; the result fields come from the module that verified the work. */
function describeOutcome(status: string, error: string | null, result: Record<string, unknown> | null): string {
  const parts = [`task status: ${status}`];
  if (typeof result?.outcome === 'string') parts.push(`outcome: ${result.outcome}`);
  if (typeof result?.summary === 'string') parts.push(`summary: ${result.summary.slice(0, 500)}`);
  if (typeof result?.branch === 'string' && result.branch) parts.push(`review branch: ${result.branch}`);
  if (error) parts.push(`error: ${error.slice(0, 300)}`);
  if (result?.kind === 'coding') parts.push('The original project is unchanged; nothing was merged. The owner reviews the branch.');
  if (result?.kind === 'studio_change') parts.push('Nothing was applied. The owner reviews and applies the proposal in the Studio.');
  return parts.join('\n');
}

export function elementCenter(element: { x: number; y: number; width: number; height: number }, target: { width: number; height: number }) {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: clamp((element.x + element.width / 2) / target.width), y: clamp((element.y + element.height / 2) / target.height) };
}

interface ToolModules {
  memory: {
    search(ownerId: string, input: unknown, options: { readOnly: true }): Promise<{ items: { title: string; content: string; layer: string }[] }>;
    create(ownerId: string, input: unknown): Promise<unknown>;
  };
  coding: { available: boolean; workspace(ownerId: string): Promise<{ projects: { id: string; name: string; path: string }[] }> };
  studio: {
    workspace(ownerId: string): Promise<{ sessions: { id: string; name: string; framework: string }[] }>;
    detail(ownerId: string, id: string): Promise<{ name: string; revision: string }>;
  };
  studioChange: boolean;
  runtime: {
    createTask(ownerId: string, input: CreateTaskInput, key: string, runId?: string): Promise<Task>;
    approve(ownerId: string, id: string): Promise<unknown>;
    cancel(ownerId: string, id: string): Promise<unknown>;
    detail(ownerId: string, id: string): Promise<{ task: Task }>;
  };
  windows: Pick<WindowsControl, 'enabled' | 'view' | 'act' | 'command'>;
  googleAds?: GoogleAdsControl;
  /** How long to wait for the companion to confirm one input action. */
  commandWaitMs?: number;
}

export function createAssistantTools({ memory, coding, studio, studioChange, runtime, windows, googleAds, commandWaitMs = 4000 }: ToolModules): AssistantTools {
  async function waitForCommand(ownerId: string, id: string, signal: AbortSignal) {
    const deadline = Date.now() + commandWaitMs;
    for (;;) {
      signal.throwIfAborted();
      const command = await windows.command(ownerId, id);
      if (command.status === 'applied') return;
      if (command.status === 'rejected') throw new BrowserError('COMPUTER_ACTION_REJECTED', `رفض الجهاز الإجراء (${command.code ?? 'REJECTED'}).`, 409);
      if (command.status === 'unknown' || Date.now() > deadline) throw new BrowserError('AGENT_EFFECT_UNKNOWN', 'لم يؤكد الجهاز نتيجة الإجراء. لم أكرره؛ راجع الشاشة قبل طلب جديد.', 409);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  return {
    memory: {
      search: (ownerId, query) => guarded(async () => {
        const { items } = await memory.search(ownerId, { query: query.slice(0, 500), limit: 5 }, { readOnly: true });
        const evidence = items.map(item => item.content.slice(0, 300));
        const text = items.length ? items.map((item, index) => `- [${item.layer}] ${item.title}: ${evidence[index]}`).join('\n') : 'no matching memory';
        return { text, evidence };
      }),
      save: (ownerId, text, request) => guarded(async () => {
        const fact = text.trim(), words = request.trim();
        if (!fact) throw new BrowserError('ASSISTANT_INPUT', 'memory_save needs the fact in text.', 400);
        const content = fact.includes(words) ? fact : `${fact}\n${words}`;
        await memory.create(ownerId, { title: (words.split('\n')[0] ?? '').slice(0, 80), content, layer: 'semantic' });
        return 'saved to memory';
      }),
    },
    work: {
      inventory: ownerId => guarded(async () => {
        const { projects } = await coding.workspace(ownerId);
        return projects.map(({ id, name }) => ({ id, name }));
      }),
      list: ownerId => guarded(async () => {
        const [{ projects }, { sessions }] = await Promise.all([coding.workspace(ownerId), studio.workspace(ownerId)]);
        return [
          'coding projects:', ...(projects.length ? projects.map(project => `- ${project.id} | ${project.name}`) : ['none registered; the owner adds them in the Coding Projects section']),
          'studio sessions:', ...(sessions.length ? sessions.map(session => `- ${session.id} | ${session.name} | ${session.framework}`) : ['none open; the owner opens them in the Visual Studio section']),
        ].join('\n');
      }),
      ...(coding.available ? { code: (ownerId, raw, key, runId) => guarded(async () => {
        const input = CodeInput.parse({ projectId: raw.id, goal: raw.goal });
        const project = (await coding.workspace(ownerId)).projects.find(item => item.id === input.projectId);
        if (!project) throw new BrowserError('ASSISTANT_PROJECT_UNKNOWN', 'هذا المشروع غير مسجل. استخدم workspace_list.', 404);
        const task = await runtime.createTask(ownerId, { title: `تعديل ${project.name}`.slice(0, 120), goal: input.goal, capabilityId: 'coding.change', autonomy: 'assisted', projectId: project.id }, key, runId);
        return pendingTask(task, `تعديل مشروع ${project.name}`.slice(0, 80), `أريد تعديل مشروع «${project.name.slice(0, 80)}»: ${input.goal.slice(0, 500)}`, 'يعمل التعديل على نسخة معزولة ويُختبر هناك. يبقى مشروعك الأصلي كما هو حتى تراجع الفرع بنفسك.');
      }) } satisfies Pick<NonNullable<AssistantTools['work']>, 'code'> : {}),
      ...(studioChange ? { studio: (ownerId, raw, key, runId) => guarded(async () => {
        const input = StudioInput.parse({ sessionId: raw.id, goal: raw.goal });
        const session = await studio.detail(ownerId, input.sessionId);
        const task = await runtime.createTask(ownerId, { title: `تعديل ${session.name}`.slice(0, 120), goal: input.goal, capabilityId: 'studio.change', autonomy: 'assisted', studioInput: { sessionId: input.sessionId, revision: session.revision } }, key, runId);
        return pendingTask(task, `تعديل صفحة ${session.name}`.slice(0, 80), `أريد تعديل «${session.name.slice(0, 80)}» في الاستوديو: ${input.goal.slice(0, 500)}`, 'يُجهَّز التعديل كمقترح تراجعه وتطبقه أنت من الاستوديو.');
      }) } satisfies Pick<NonNullable<AssistantTools['work']>, 'studio'> : {}),
      approve: (ownerId, taskId) => guarded(async () => { await runtime.approve(ownerId, taskId); }),
      cancel: (ownerId, taskId) => guarded(async () => { await runtime.cancel(ownerId, taskId); }),
      outcome: (ownerId, taskId) => guarded(async () => {
        const { task } = await runtime.detail(ownerId, taskId);
        const text = describeOutcome(task.status, task.error, task.result);
        if (['completed', 'failed', 'cancelled'].includes(task.status)) return { settled: true, text };
        // Approved once already: a second pause is the Runtime's own review, not this chat's.
        if (['waiting_approval', 'paused'].includes(task.status)) return { settled: true, text: `${text}\nThe task stopped for the owner to review it in the Tasks section.` };
        return { settled: false, text };
      }),
    },
    // No tool here can publish: approval and publishing exist only in the owner's Google Ads section.
    ...(googleAds?.configured ? { ads: {
      connection: ownerId => guarded(async () => {
        const status = await googleAds.status(ownerId);
        return { state: status.state, account: status.account?.name ?? null };
      }),
      accounts: ownerId => guarded(async () => (await googleAds.listAccounts(ownerId)).filter(item => !item.manager).map(({ customerId, loginCustomerId, name }) => ({ customerId, loginCustomerId, name }))),
      selectAccount: (ownerId, choice) => guarded(() => googleAds.selectAccount(ownerId, choice.customerId, choice.loginCustomerId)),
      status: ownerId => guarded(async () => {
        const status = await googleAds.status(ownerId);
        return [`connection: ${status.state}`, status.message, status.account ? `account: ${status.account.name} (${status.account.customerId}, ${status.account.currency})` : 'no account selected', `publishing available: ${status.publishing.available}`, ...status.publishing.gates.filter(gate => !gate.passed).map(gate => `closed gate: ${gate.detail}`)].join('\n');
      }),
      report: ownerId => guarded(async () => {
        const report = await googleAds.report(ownerId, 30);
        const lines = report.campaigns.slice(0, 15).map(item => `- ${item.name} [${item.status}]: ${item.impressions} impressions, ${item.clicks} clicks, cost ${money(item.costMicros, report.currency)}, ${item.conversions} conversions`);
        return [`Observed from Google Ads, ${report.range.start} to ${report.range.end}. Report only these figures; invent none.`, `totals: ${report.totals.impressions} impressions, ${report.totals.clicks} clicks, cost ${money(report.totals.costMicros, report.currency)}, ${report.totals.conversions} conversions`, ...(lines.length ? lines : ['no campaign returned data']), ...report.bookings.services.map(item => `bookings for ${item.service}: ${item.completedBookings}`), ...report.mismatches.map(item => `mismatch (${item.basis}) in ${item.campaignName}: ${item.message}`), ...report.notes].join('\n');
      }),
      draft: (ownerId, text, request, key) => guarded(async () => {
        const draft = await googleAds.createDraft(ownerId, parseAdsDraft(text, request), key);
        return [`Saved preview ${draft.id}. Nothing was sent to the account. The owner reviews, validates and approves it in the Google Ads section; you cannot publish.`, ...(draft.strategy?.recommendations ?? []).map(item => `${item.basis}: ${item.title}. ${item.reason}`), ...(draft.strategy?.blockers ?? []).map(item => `blocker: ${item}`)].join('\n');
      }),
      campaign: {
        parse: parseAdsDraft,
        landing: (url, signal) => googleAds.inspectLanding(url, signal),
        gates: async ownerId => (await googleAds.status(ownerId)).publishing,
        drafts: ownerId => googleAds.drafts(ownerId),
        createPaused: (ownerId, brief, key, authority, observer) => googleAds.createPausedCampaign(ownerId, brief, key, authority, observer),
        reconcile: (ownerId, draftId, revision) => googleAds.reconcile(ownerId, draftId, revision),
        discard: async (ownerId, draftId, revision) => { await googleAds.discard(ownerId, draftId, revision); },
        lessons: { list: ownerId => googleAds.lessons.list(ownerId), record: (ownerId, entry) => googleAds.lessons.record(ownerId, entry) },
      },
      createPaused:(ownerId,text,request,key,assertActive)=>guarded(async()=>{
        if(!requestsPausedCampaign(request))throw new BrowserError('ADS_CREATION_NOT_REQUESTED','يلزم طلبك الصريح لإنشاء حملة في الحساب؛ المعاينة وحدها لا تجيز ذلك.',403);
        const draft=await googleAds.createPausedCampaign(ownerId,parseAdsDraft(text,request),key,{assertActive});
        return `Google Ads readback confirmed new campaign ${draft.campaignResourceName} in PAUSED state. Draft ${draft.id}. It is not running. Only the owner can approve launch separately. ${draft.verification?.checks.find(check=>check.id==='conversion_tracking')?.passed?'Conversion tracking verified.':'Conversion tracking must be verified before launch.'}`;
      }),
    } } : {}),
    ...(windows.enabled ? { computer: {
      view: ownerId => guarded(async () => {
        const { scope, target, frame } = await windows.view(ownerId);
        const visible = frame.elements.filter(element => element.name && !element.password && element.width > 0 && element.height > 0);
        const ordered = [...visible.filter(element => ACTIONABLE.test(element.type)), ...visible.filter(element => !ACTIONABLE.test(element.type))].slice(0, MAX_LISTED_ELEMENTS);
        return {
          title: target.title, canAct: scope === 'control', hasPasswordField: frame.elements.some(element => element.password), jpeg: frame.jpeg,
          elements: ordered.map((element, index) => ({ ref: `w${index + 1}`, name: element.name.slice(0, 50), type: shortType(element.type) })),
        };
      }),
      perform: (ownerId, step, signal) => guarded(async () => {
        // Every action is resolved against the screen as it is now, never a remembered one.
        const { target, frame } = await windows.view(ownerId);
        if (step.kind === 'text' && frame.elements.some(element => element.password)) throw new BrowserError('ASSISTANT_SECRET_FIELD', 'توجد خانة كلمة مرور في هذه النافذة؛ هذه الكتابة لك أنت.', 403);
        let action: Record<string, unknown>;
        if (step.kind === 'click') {
          const element = frame.elements.find(item => !item.password && item.name.slice(0, 50) === step.name && shortType(item.type) === step.type);
          if (!element) throw new BrowserError('COMPUTER_ELEMENT_GONE', 'لم يعد هذا العنصر على الشاشة. استخدم computer_view.', 409);
          action = { type: 'click', button: 'left', ...elementCenter(element, target) };
        } else action = step.kind === 'text' ? { type: 'text', text: step.text } : { type: 'key', key: step.key };
        const queued = await windows.act(ownerId, frame.id, action);
        await waitForCommand(ownerId, queued.id, signal);
        return 'input applied on the device; use computer_view to confirm the result';
      }),
    } } : {}),
  };
}
