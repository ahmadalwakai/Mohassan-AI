import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { MemoryError } from '@mohassan/memory';
import type { Kysely } from 'kysely';
import { restoreActionCompletionLedger } from './action-completion.js';
import { asksToRemember, deniesMemoryWrite, type BrainState } from './brain.js';
import { analyzeCompoundRequest } from './compound-request.js';
import { ExactPersistencePolicySchema } from './exact-memory-persistence.js';
import type { EffectiveRequestSource } from './effective-request-source.js';
import { isEntireLiteralRequest, requestCapabilityAllowed, type UserRequestConstraints } from './request-scope.js';
import { hasStructuredMemorySecret, parseStructuredMemoryRequest } from './structured-memory-parser.js';
import { applyStructuredMemory, lockStructuredMemoryOwner } from './structured-memory-storage.js';
import { assessUserFactMemoryRequest } from './user-fact-memory-receipt.js';

const secretPlaceholder = '[أزيلت بيانات سرية من طلب الذاكرة]';
const secretRefusal = 'لم أحفظ هذه البيانات لأنها سرية. لا تُحفظ كلمات المرور أو أرقام البطاقات أو رموز التحقق في الذاكرة.';
const enabled = () => process.env.MOHASSAN_STRUCTURED_MEMORY === '1';

/** Replace sensitive memory text before the chat stores the goal, message or request hash. */
function protectStructuredMemoryInput(raw: unknown, key: 'text' | 'goal' = 'text'): unknown {
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

/** Route only the pinned current user instruction. Structured effects and the terminal chat reply share a transaction. */
export async function handleStructuredMemoryTurn(input: StructuredMemoryTurn): Promise<boolean> {
  if (!input.task) return false;
  const { db, state, ownerId, conversationId, runId } = input;
  const request = input.source.request;
  const intent = request === secretPlaceholder ? { kind: 'secret' } as const : parseStructuredMemoryRequest(request);
  if (intent.kind === 'none') return false;
  if (!enabled()) {
    console.info(JSON.stringify({ event: 'structured_memory_shadow', kind: intent.kind,
      ...('target' in intent ? { property: intent.target.property } : {}), legacy: assessUserFactMemoryRequest(request).status }));
    return false;
  }

  const ar = /\p{Script=Arabic}/u.test(request);
  const blocked = (arabic: string, english: string): Reply => ({ status: 'blocked', text: ar ? arabic : english });
  const completed = (arabic: string, english: string): Reply => ({ status: 'completed', text: ar ? arabic : english });
  const publish = async (resolve: (tx: Kysely<any>) => Promise<Reply>, write = false) => {
    const revalidate = (tx: Kysely<any>) => input.lockedExecution(tx, conversationId, runId);
    await db.transaction().execute(async tx => {
      if (write) await lockStructuredMemoryOwner(tx, ownerId);
      await revalidate(tx);
      const { text, status } = await resolve(tx);
      await publicationContext.run({ db, tx, conversationId, runId, revalidate },
        () => input.finish(conversationId, runId, state, text, status, undefined, undefined, true));
    });
    return true;
  };
  if (intent.kind === 'secret') return publish(async () => ({ status: 'blocked', text: secretRefusal }));

  if (state.computationMemory !== undefined || state.userFactMemory !== undefined) return false;
  if (intent.kind === 'statement' && intent.explicit) {
    const legacy = assessUserFactMemoryRequest(request);
    if (legacy.status === 'ready' && legacy.statementKind !== 'current_declaration') return false;
  }

  const write = intent.kind !== 'recall';
  const actionHistory = restoreActionCompletionLedger(state.actionCompletion, { runId, request });
  const clearHistory = state.actionCompletion === undefined || actionHistory && !actionHistory.events.length && !actionHistory.fault;
  const fresh = clearHistory && !state.steps && !state.pendingTask && !state.pendingComputer
    && !state.pendingDesktop && !state.hands && !state.site && !state.writer && !state.planner && !state.document && !state.adsBrief
    && state.trail.every(entry => entry.action === 'asked the user');
  const verifiedSource = state.requestOriginalHash === createHash('sha256').update(request, 'utf8').digest('hex')
    && input.scrub(request) === request && !isEntireLiteralRequest(request);
  const canRead = requestCapabilityAllowed(input.constraints, 'memory_read');
  const canWrite = !deniesMemoryWrite(request) && requestCapabilityAllowed(input.constraints, 'memory_write');
  if (!fresh || !verifiedSource || !canRead || write && (!canWrite || analyzeCompoundRequest(request).kind !== 'single')) {
    return publish(async () => blocked('لم أتمكن من تنفيذ طلب الذاكرة من هذه الرسالة.', 'I could not act on the memory request in this message.'));
  }
  if (intent.kind === 'statement' && (!intent.explicit || !asksToRemember(request))) {
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
    const previous = intent.target.subject === null ? await tx.selectFrom('chat_runs').select(['id', 'intent', 'goal', 'status'])
      .where('owner_id', '=', scope.ownerId).where('conversation_id', '=', scope.conversationId)
      .where('id', '!=', scope.runId).where('created_at', '<=', new Date(scope.evaluatedAt))
      .orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst() : undefined;
    const antecedent = previous?.status === 'completed' && previous.intent === 'task' ? parseStructuredMemoryRequest(previous.goal) : null;
    const result = await applyStructuredMemory(tx, { ...scope,
      antecedent: antecedent && 'target' in antecedent && antecedent.kind !== 'forget' ? antecedent.target : null,
      antecedentRunId: antecedent && antecedent.kind === 'correction' ? previous?.id : undefined }, intent);
    if (result.kind === 'ambiguous') return blocked('اذكر صاحب المعلومة والمعلومة المقصودة.', 'Specify whose fact you mean and which fact to use.');
    if (result.kind === 'missing') return blocked('لم أجد معلومة مطابقة في ذاكرتك.', 'I could not find a matching fact in your memory.');
    if (result.kind === 'recalled') return { status: 'completed', text: renderStructuredMemoryRecall(result.fact, ar) };
    if (result.kind === 'unchanged') return completed('هذه المعلومة محفوظة بالفعل.', 'This fact is already saved.');
    input.state.memorySaves = policy.data.quota.used + 1;
    if (result.kind === 'forgotten') return completed('حذفت المعلومة وإصداراتها من ذاكرتك.', 'I removed the fact and its versions from your memory.');
    return completed('حفظت المعلومة وتحققت من وجودها في ذاكرتك.', 'I saved the fact and verified it in your memory.');
  }, write);
}
