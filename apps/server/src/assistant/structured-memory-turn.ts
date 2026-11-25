import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { MemoryError } from '@mohassan/memory';
import type { Kysely } from 'kysely';
import { restoreActionCompletionLedger } from './action-completion.js';
import { addEvidence, appendStep, createRunLedger, planStep, restoreRunLedger, settleStep, startStep, tryEnterPhase } from './agent-run.js';
import { deniesMemoryWrite, type BrainState } from './brain.js';
import { analyzeCompoundRequest } from './compound-request.js';
import { ExactPersistencePolicySchema } from './exact-memory-persistence.js';
import type { EffectiveRequestSource } from './effective-request-source.js';
import { isEntireLiteralRequest, requestCapabilityAllowed, type RequestScopeAssessment, type UserRequestConstraints } from './request-scope.js';
import { hasStructuredMemorySecret, parseStructuredMemoryRequest, structuredMemoryInstruction } from './structured-memory-parser.js';
import { applyStructuredMemory, lockStructuredMemoryOwner } from './structured-memory-storage.js';
import { assessUserFactMemoryRequest } from './user-fact-memory-receipt.js';

const secretPlaceholder = '[أزيلت بيانات سرية من طلب الذاكرة]';
const secretRefusal = 'لم أحفظ هذه البيانات لأنها سرية. لا تُحفظ كلمات المرور أو أرقام البطاقات أو رموز التحقق في الذاكرة.';
const enabled = () => process.env.MOHASSAN_STRUCTURED_MEMORY === '1';

/** Replace sensitive memory text before the chat stores the goal, message or request hash. */
export function protectStructuredMemoryInput(raw: unknown, key: 'text' | 'goal' = 'text'): unknown {
  if (!enabled() || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const field = Object.getOwnPropertyDescriptor(raw, key);
  if (!field || !('value' in field) || typeof field.value !== 'string' || field.value.trim().length > 4000) return raw;
  if (!hasStructuredMemorySecret(field.value)) return raw;
  return { ...raw, [key]: secretPlaceholder };
}

function protectStructuredMemoryIdempotencyBody(body: unknown, scope: string): unknown {
  if (scope === 'create') return protectStructuredMemoryInput(body, 'goal');
  return scope.startsWith('messages:') ? protectStructuredMemoryInput(body) : body;
}

interface ChatIngress<Conversation, SendOptions extends unknown[]> {
  create(ownerId: string, raw?: unknown): Promise<Conversation>;
  send(ownerId: string, id: string, raw: unknown, ...options: SendOptions): Promise<Conversation>;
  once<T>(ownerId: string, scope: string, key: string, body: unknown, run: () => Promise<T>): Promise<T>;
}

/** Filter chat input at the public control boundary, before hashing or persisting it. */
export function protectStructuredMemoryIngress<Conversation, SendOptions extends unknown[]>(
  ingress: ChatIngress<Conversation, SendOptions>,
): Partial<ChatIngress<Conversation, SendOptions>> {
  return {
    create: (ownerId, raw) => ingress.create(ownerId, protectStructuredMemoryInput(raw, 'goal')),
    send: (ownerId, id, raw, ...options) => ingress.send(ownerId, id, protectStructuredMemoryInput(raw), ...options),
    once: (ownerId, scope, key, body, run) => ingress.once(ownerId, scope, key, protectStructuredMemoryIdempotencyBody(body, scope), run),
  };
}

export function checkStructuredMemoryFields<T extends { title?: string; content?: string; reason?: string; comment?: string }>(input: T): T {
  if (enabled() && [input.title, input.content, input.reason, input.comment,
    input.title && input.content ? `${input.title}: ${input.content}` : undefined].some(text => text && hasStructuredMemorySecret(text))) {
    throw new MemoryError('MEMORY_SECRET_REJECTED', secretRefusal);
  }
  return input;
}

type Reply = { text: string; status: 'completed' | 'blocked' };
type Publication = {
  db: Kysely<any>;
  tx: Kysely<any>;
  conversationId: string;
  runId: string;
  revalidate(tx: Kysely<any>): Promise<unknown>;
  afterCommit: Array<() => void>;
};
const publicationContext = new AsyncLocalStorage<Publication>();

export function hasStructuredMemoryTransaction(db: Kysely<any>, conversationId: string, runId: string): boolean {
  const publication = publicationContext.getStore();
  return publication?.db === db && publication.conversationId === conversationId && publication.runId === runId;
}

/** The chat finisher's state checkpoint and reply both join the owner-locked transaction. */
export async function joinStructuredMemoryTransaction<T>(work: (tx: Kysely<any>) => Promise<T>): Promise<T> {
  const publication = publicationContext.getStore();
  if (!publication) throw new Error('STRUCTURED_MEMORY_PUBLICATION_MISSING');
  await publication.revalidate(publication.tx);
  return work(publication.tx);
}

export function revalidateStructuredMemoryPublication(tx: Kysely<any>): Promise<unknown> {
  const publication = publicationContext.getStore();
  if (publication?.tx !== tx) throw new Error('STRUCTURED_MEMORY_PUBLICATION_MISSING');
  return publication.revalidate(tx);
}

export function afterStructuredMemoryPublication(runId: string, observe: () => void): boolean {
  const publication = publicationContext.getStore();
  if (publication?.runId !== runId) return false;
  publication.afterCommit.push(observe);
  return true;
}

interface StructuredMemoryTurn {
  db: Kysely<any>;
  ownerId: string;
  conversationId: string;
  runId: string;
  source: EffectiveRequestSource;
  constraints: UserRequestConstraints | null;
  state: BrainState;
  task: boolean;
  memoryAvailable: boolean;
  quota: number;
  scrub(text: string): string;
  lockedExecution(tx: Kysely<any>, conversationId: string, runId: string): Promise<unknown>;
  finish(conversationId: string, runId: string, state: BrainState, text: string, status: Reply['status'],
    experienceProof: undefined, memoryPublication: undefined, prejudged: true): Promise<void>;
}

export function renderStructuredMemoryRecall(fact: { statement: string; date: Date }, ar: boolean): string {
  const date = fact.date.toISOString().slice(0, 10);
  return ar ? `من ذاكرتك بتاريخ ${date}: «${fact.statement}»` : `From your memory on ${date}: “${fact.statement}”`;
}

type MemoryOperationKind = 'statement' | 'correction' | 'forget' | 'recall';

function setMemoryRoute(state: BrainState, kind: MemoryOperationKind, available: boolean) {
  state.routing = { route: 'memory', intent: 'memory', handler: 'memory',
    availability: available ? 'ready' : 'missing_capability', missingCapabilities: available ? [] : ['memory'],
    reason: available ? 'explicit_handler' : 'missing_capability' };
  const resolution = state.requestResolution;
  if (!resolution) return;
  const assertion = kind === 'statement' || kind === 'correction';
  const sourceAssessment: RequestScopeAssessment = { version: 1, source: assertion ? 'supplied_content' : 'prior_conversation',
    scope: 'private', operation: kind === 'recall' ? 'lookup' : 'act', destination: 'memory', publicQueryEligible: false,
    reasons: ['owned_record'] };
  const context = resolution.nextState && { ...resolution.nextState, intent: 'memory' as const, scope: 'private' as const, sourceAssessment };
  if (resolution.sourceAssessment?.publicQueryEligible) state.publicQueryTerms = [];
  state.requestContext = context;
  state.requestResolution = { ...resolution, intent: 'memory', scope: 'private', query: null, sourceAssessment, nextState: context };
}

const memoryOperations = {
  search: { action: 'memory_search', result: 'Searched current owner memory.', changed: false },
  write: { action: 'memory_write_exact', result: 'Stored the exact user-provided statement.', changed: true },
  reconcile: { action: 'memory_reconcile_exact', result: 'Reconciled the operation against owner memory.', changed: false },
  forget: { action: 'memory_forget', result: 'Deleted the fact and its matching versions.', changed: true },
} as const;

function startMemoryStep(state: BrainState, runId: string, kind: MemoryOperationKind, ar: boolean) {
  const startedAt = Date.now();
  const ledger = state.agentRun = restoreRunLedger(state.agentRun, runId) ?? createRunLedger({ runId, at: startedAt });
  const outcomes = {
    statement: ['حفظ المعلومة والتحقق منها', 'Save and verify the fact'],
    correction: ['تصحيح المعلومة والتحقق منها', 'Correct and verify the fact'],
    forget: ['حذف المعلومة والتحقق من حذفها', 'Forget the fact and verify removal'],
    recall: ['قراءة المعلومة من الذاكرة', 'Read the fact from memory'],
  };
  const outcome = outcomes[kind][ar ? 0 : 1]!;
  const id = 'structured-memory';
  const read = kind === 'recall';
  const acceptance = ar ? 'تطابق القراءة من ذاكرة المستخدم نتيجة العملية.' : 'Owner-scoped readback confirms the result.';
  if (!appendStep(ledger, planStep({ id, outcome, capability: read ? 'memory.read' : 'memory.write', input: null,
    acceptance: [acceptance] }), startedAt)) throw new Error('STRUCTURED_MEMORY_PLAN_LIMIT');
  tryEnterPhase(ledger, 'executing', startedAt);
  startStep(ledger, id, startedAt);

  return (operations: readonly (keyof typeof memoryOperations)[], verified: boolean) => {
    for (const operation of operations) state.trail.push({ step: ++state.steps, ...memoryOperations[operation] });
    const finishedAt = Date.now();
    if (verified) addEvidence(ledger, { stepId: id, kind: 'readback', label: acceptance, independent: true }, finishedAt);
    settleStep(ledger, id, verified ? 'verified' : 'failed', finishedAt);
  };
}

/** Route only the pinned current user instruction. Structured effects and the terminal chat reply share a transaction. */
export async function handleStructuredMemoryTurn(input: StructuredMemoryTurn): Promise<boolean> {
  if (!input.task) return false;
  const { db, state, ownerId, conversationId, runId } = input;
  const request = input.source.request;
  const intent = request === secretPlaceholder ? { kind: 'secret' } as const : parseStructuredMemoryRequest(request);
  if (intent.kind === 'none') return false;
  if (!enabled()) {
    const property = 'target' in intent ? intent.target.property : undefined;
    console.info(JSON.stringify({ event: 'structured_memory_shadow', kind: intent.kind,
      property: property?.startsWith('descriptor:') ? 'descriptor' : property, legacy: assessUserFactMemoryRequest(request).status }));
    return false;
  }

  const ar = /\p{Script=Arabic}/u.test(request.match(/\p{L}/u)?.[0] ?? '');
  const blocked = (arabic: string, english: string): Reply => ({ status: 'blocked', text: ar ? arabic : english });
  const completed = (arabic: string, english: string): Reply => ({ status: 'completed', text: ar ? arabic : english });
  const publish = async (resolve: (tx: Kysely<any>) => Promise<Reply>, write = false) => {
    const revalidate = (tx: Kysely<any>) => input.lockedExecution(tx, conversationId, runId);
    const afterCommit: Array<() => void> = [];
    await db.transaction().execute(async tx => {
      if (write) await lockStructuredMemoryOwner(tx, ownerId);
      await revalidate(tx);
      const { text, status } = await resolve(tx);
      await publicationContext.run({ db, tx, conversationId, runId, revalidate, afterCommit },
        () => input.finish(conversationId, runId, state, text, status, undefined, undefined, true));
    });
    for (const observe of afterCommit) {
      try { observe(); } catch { /* Publication already committed. */ }
    }
    return true;
  };
  if (intent.kind === 'secret') return publish(async () => ({ status: 'blocked', text: secretRefusal }));

  if (state.computationMemory !== undefined || state.userFactMemory !== undefined
    || state.memoryVerification !== undefined || state.userFactMemoryVerification !== undefined) return false;
  if (intent.kind === 'statement' && intent.explicit) {
    const legacy = assessUserFactMemoryRequest(request);
    if (legacy.status === 'ready' && legacy.statementKind !== 'current_declaration') return false;
  }

  const write = intent.kind !== 'recall';
  const actionHistory = restoreActionCompletionLedger(state.actionCompletion, { runId, request });
  const clearHistory = state.actionCompletion === undefined || actionHistory && !actionHistory.events.length && !actionHistory.fault;
  const fresh = clearHistory && !state.steps && !state.agentRun?.plan?.steps.length && !state.pendingTask && !state.pendingComputer
    && !state.pendingDesktop && !state.hands && !state.site && !state.writer && !state.planner && !state.document && !state.adsBrief
    && state.trail.every(entry => entry.action === 'asked the user');
  const verifiedSource = state.requestOriginalHash === createHash('sha256').update(request, 'utf8').digest('hex')
    && input.scrub(request) === request && !isEntireLiteralRequest(request);
  const canRead = requestCapabilityAllowed(input.constraints, 'memory_read');
  const canWrite = !deniesMemoryWrite(request) && requestCapabilityAllowed(input.constraints, 'memory_write');
  const instruction = write ? structuredMemoryInstruction(request) : request;
  if (!fresh || !verifiedSource || !canRead || write && !canWrite || analyzeCompoundRequest(instruction).kind !== 'single') {
    return publish(async () => blocked('لم أتمكن من تنفيذ طلب الذاكرة من هذه الرسالة.', 'I could not act on the memory request in this message.'));
  }
  setMemoryRoute(state, intent.kind, input.memoryAvailable);
  if (intent.kind === 'statement' && !intent.explicit) {
    return publish(async () => blocked('إذا أردت حفظ هذه المعلومة، ابدأ رسالتك بكلمة «تذكّر» ثم اكتبها.', 'To save this fact, start your message with “Remember” and state the fact.'));
  }
  if (intent.kind === 'correction' && !intent.explicit) {
    return publish(async () => blocked('اذكر المعلومة المطلوب تغييرها والقيمة الجديدة.', 'Specify which fact to update and its new value.'));
  }
  const policy = ExactPersistencePolicySchema.safeParse({ accountAllowed: canRead && (!write || canWrite),
    quota: { used: input.state.memorySaves ?? 0, limit: input.quota } });
  if (!input.memoryAvailable || !policy.success || !policy.data.accountAllowed || write && policy.data.quota.used >= policy.data.quota.limit) {
    return publish(async () => blocked('الذاكرة غير متاحة لهذا الطلب.', 'Memory is unavailable for this request.'));
  }

  const scope = { ownerId, conversationId, runId, evaluatedAt: input.source.evaluatedAt };
  return publish(async tx => {
    const settleMemoryStep = startMemoryStep(state, runId, intent.kind, ar);
    const previous = intent.target.subject === null ? await tx.selectFrom('chat_runs').select(['id', 'intent', 'goal', 'status'])
      .where('owner_id', '=', scope.ownerId).where('conversation_id', '=', scope.conversationId)
      .where('id', '!=', scope.runId).where('created_at', '<=', new Date(scope.evaluatedAt))
      .orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst() : undefined;
    const antecedent = previous?.status === 'completed' && previous.intent === 'task' ? parseStructuredMemoryRequest(previous.goal) : null;
    const operations: (keyof typeof memoryOperations)[] = [];
    const result = await applyStructuredMemory(tx, { ...scope, onOperation: operation => operations.push(operation),
      antecedent: antecedent && 'target' in antecedent && antecedent.kind !== 'forget' ? antecedent.target : null,
      antecedentRunId: antecedent && antecedent.kind === 'correction' ? previous?.id : undefined }, intent);
    const verified = result.kind === 'recalled' ? operations.includes('search') : operations.includes('reconcile');
    settleMemoryStep(operations, verified);
    if (result.kind === 'ambiguous') return blocked('اذكر صاحب المعلومة والمعلومة المقصودة.', 'Specify whose fact you mean and which fact to use.');
    if (result.kind === 'missing') return blocked('لم أجد معلومة مطابقة في ذاكرتك.', 'I could not find a matching fact in your memory.');
    if (result.kind === 'changed') return blocked('سُجّل الحذف السابق. أرسل طلبًا جديدًا لتأكيد الحذف من الذاكرة الحالية.',
      'The earlier deletion was recorded. Send a new request to remove the fact from your current memory.');
    if (!verified) throw new Error('STRUCTURED_MEMORY_READBACK_FAILED');
    if (result.kind === 'recalled') return { status: 'completed', text: renderStructuredMemoryRecall(result.fact, ar) };
    if (result.kind === 'unchanged') return completed('هذه المعلومة محفوظة بالفعل.', 'This fact is already saved.');
    input.state.memorySaves = policy.data.quota.used + 1;
    if (result.kind === 'forgotten') return completed('حذفت المعلومة وإصداراتها من ذاكرتك.', 'I removed the fact and its versions from your memory.');
    return completed('حفظت المعلومة وتحققت من وجودها في ذاكرتك.', 'I saved the fact and verified it in your memory.');
  }, write);
}
