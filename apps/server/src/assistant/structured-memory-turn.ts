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
export function protectStructuredMemoryInput(raw: unknown, key: 'text' | 'goal' = 'text'): unknown {
  if (!enabled() || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const field = Object.getOwnPropertyDescriptor(raw, key);
  if (!field || !('value' in field) || typeof field.value !== 'string' || field.value.trim().length > 4000) return raw;
  if (!hasStructuredMemorySecret(field.value)) return raw;
  return { ...raw, [key]: secretPlaceholder };
}

export function protectStructuredMemoryIdempotencyBody(body: unknown, scope: string): unknown {
  if (scope === 'create') return protectStructuredMemoryInput(body, 'goal');
  return scope.startsWith('messages:') ? protectStructuredMemoryInput(body) : body;
}

export function checkStructuredMemoryFields<T extends { title?: string; content?: string; reason?: string; comment?: string }>(input: T): T {
  if (enabled() && [input.title, input.content, input.reason, input.comment,
    input.title && input.content ? `${input.title}: ${input.content}` : undefined].some(text => text && hasStructuredMemorySecret(text))) {
    throw new MemoryError('MEMORY_SECRET_REJECTED', secretRefusal);
  }
  return input;
}

type Reply = { text: string; status: 'completed' | 'blocked' };
export interface StructuredMemoryPublication {
  lock?: (tx: Kysely<any>) => Promise<void>;
  resolve(tx: Kysely<any>): Promise<Reply>;
  revalidate(tx: Kysely<any>): Promise<unknown>;
}

interface StructuredMemoryTurn {
  ownerId: string;
  conversationId: string;
  runId: string;
  source: EffectiveRequestSource;
  originalRequestHash?: string;
  constraints: UserRequestConstraints | null;
  state: BrainState;
  task: boolean;
  memoryAvailable: boolean;
  quota: number;
  scrub(text: string): string;
  revalidate(tx: Kysely<any>): Promise<unknown>;
  publish(publication: StructuredMemoryPublication): Promise<void>;
}

export function renderStructuredMemoryRecall(fact: { statement: string; date: Date }, ar: boolean): string {
  const date = fact.date.toISOString().slice(0, 10);
  return ar ? `من ذاكرتك بتاريخ ${date}: «${fact.statement}»` : `From your memory on ${date}: “${fact.statement}”`;
}

/** Route only the pinned current user instruction. Structured effects and the terminal chat reply share a transaction. */
export async function handleStructuredMemoryTurn(input: StructuredMemoryTurn): Promise<boolean> {
  if (!input.task) return false;
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
  const publish = async (resolve: StructuredMemoryPublication['resolve'], write = false) => {
    await input.publish({ resolve, revalidate: input.revalidate,
      ...(write ? { lock: (tx: Kysely<any>) => lockStructuredMemoryOwner(tx, input.ownerId) } : {}) });
    return true;
  };
  if (intent.kind === 'secret') return publish(async () => ({ status: 'blocked', text: secretRefusal }));

  const state = input.state;
  if (state.computationMemory !== undefined || state.userFactMemory !== undefined) return false;
  if (intent.kind === 'statement' && intent.explicit) {
    const legacy = assessUserFactMemoryRequest(request);
    if (legacy.status === 'ready' && legacy.statementKind !== 'current_declaration') return false;
  }

  const write = intent.kind !== 'recall';
  const actionHistory = restoreActionCompletionLedger(state.actionCompletion, { runId: input.runId, request });
  const clearHistory = state.actionCompletion === undefined || actionHistory && !actionHistory.events.length && !actionHistory.fault;
  const fresh = clearHistory && !state.steps && !state.pendingTask && !state.pendingComputer
    && !state.pendingDesktop && !state.hands && !state.site && !state.writer && !state.planner && !state.document && !state.adsBrief
    && state.trail.every(entry => entry.action === 'asked the user');
  const verifiedSource = input.originalRequestHash === createHash('sha256').update(request, 'utf8').digest('hex')
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

  const scope = { ownerId: input.ownerId, conversationId: input.conversationId, runId: input.runId, evaluatedAt: input.source.evaluatedAt };
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
