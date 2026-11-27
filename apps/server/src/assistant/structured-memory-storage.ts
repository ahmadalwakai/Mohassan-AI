import { randomUUID } from 'node:crypto';
import { MemoryError, MemoryExactOwnerSchema, MemoryExactPayloadSchema, assertLiveUserMemoryCapacity, exactMemoryPayloadHash } from '@mohassan/memory';
import { sql, type Kysely } from 'kysely';
import { hasStructuredMemorySecret, parseStructuredMemoryRequest, type StructuredMemoryIntent, type StructuredMemoryTarget } from './structured-memory-parser.js';
import { structuredMemoryMatcher } from './structured-memory-retrieval.js';

export { migrateStructuredMemory } from './structured-memory-migration.js';

type Intent = Exclude<StructuredMemoryIntent, { kind: 'none' | 'secret' }>;
type Target = StructuredMemoryTarget & { subject: string };
type Scope = {
  ownerId: string;
  conversationId: string;
  runId: string;
  evaluatedAt: number;
  antecedent?: StructuredMemoryTarget | null;
  antecedentRunId?: string;
  onOperation?: (operation: 'search' | 'write' | 'reconcile' | 'forget') => void;
};
type Fact = { statement: string; date: Date; value: string; since: string | null; until: string | null };
type Result = { kind: 'saved' | 'unchanged' | 'recalled'; fact: Fact } | { kind: 'missing' | 'ambiguous' | 'forgotten' | 'changed' };
type CandidateRow = {
  id: string;
  root_id: string;
  version: number;
  status: string;
  content: string;
  created_at: Date;
  fact_subject: string | null;
  fact_property: Target['property'] | null;
  fact_value: string | null;
  valid_since: string | null;
  valid_until: string | null;
};
type Candidate = CandidateRow & { fact: Fact };
const RETENTION_MS = 180 * 86_400_000;
const integrityFailure = () => new Error('STRUCTURED_MEMORY_READBACK_FAILED');

/** Use before acquiring the run fence, in the same host transaction as publication. */
export async function lockStructuredMemoryOwner(tx: Kysely<any>, ownerId: string): Promise<void> {
  MemoryExactOwnerSchema.parse(ownerId);
  const owner = await tx.selectFrom('user').select('id').where('id', '=', ownerId).forUpdate().executeTakeFirst();
  if (!owner) throw new MemoryError('UNAUTHORIZED', 'سجل الدخول للمتابعة.', 401);
}

function availableItems(tx: Kysely<any>, ownerId: string, now: Date, includeInactive = false) {
  let query = tx.selectFrom('memory_items as item')
    .leftJoin('memory_structured_versions as fact', join => join.onRef('fact.item_id', '=', 'item.id').on('fact.owner_id', '=', ownerId))
    .select(['item.id', 'item.root_id', 'item.version', 'item.status', 'item.content', 'item.created_at', 'fact.subject as fact_subject',
      'fact.property as fact_property', 'fact.value as fact_value', 'fact.valid_since', 'fact.valid_until'])
    .where('item.owner_id', '=', ownerId).where('item.layer', '=', 'semantic').where('item.confidence_kind', '=', 'user_asserted')
    .where('item.task_id', 'is', null)
    .where(sql<boolean>`EXISTS (SELECT 1 FROM memory_provenance p JOIN memory_evidence e ON e.id = p.evidence_id
      WHERE p.memory_id = item.id AND e.owner_id = ${ownerId} AND e.kind = 'manual' AND e.trust = 'manual' AND p.relation = 'asserted'
      AND e.content_hash = encode(sha256(convert_to(item.content, 'UTF8')), 'hex'))
      AND NOT EXISTS (SELECT 1 FROM memory_provenance p LEFT JOIN memory_evidence e ON e.id = p.evidence_id
      WHERE p.memory_id = item.id AND (e.id IS NULL OR e.owner_id <> ${ownerId} OR e.status <> 'active' OR e.expires_at <= ${now}))`);
  if (!includeInactive) query = query.where('item.status', '=', 'active').where('item.expires_at', '>', now);
  return query;
}

function decodeFact(row: CandidateRow): { target: Target; fact: Fact } | null {
  if (!MemoryExactPayloadSchema.safeParse(row.content).success || hasStructuredMemorySecret(row.content)) return null;
  const date = new Date(row.created_at);
  if (row.fact_subject !== null) {
    if (row.fact_property === null || row.fact_value === null || !row.content.includes(row.fact_value) || hasStructuredMemorySecret(row.fact_value)
      || [row.valid_since, row.valid_until].some(text => text && (!row.content.includes(text) || hasStructuredMemorySecret(text)))) return null;
    return { target: { subject: row.fact_subject, property: row.fact_property },
      fact: { statement: row.content, date, value: row.fact_value, since: row.valid_since, until: row.valid_until } };
  }
  // Legacy notes and direct edits through the normal memory API are eligible when
  // the latest live statement independently parses to this precise target.
  const parsed = parseStructuredMemoryRequest(row.content, { storedAssertion: true });
  if (parsed.kind !== 'statement' || !parsed.target.subject || hasStructuredMemorySecret(parsed.value)) return null;
  return { target: { ...parsed.target, subject: parsed.target.subject },
    fact: { statement: row.content, date, value: parsed.value, since: parsed.since, until: parsed.until } };
}

function readFact(row: CandidateRow, target: Target): Fact | null {
  const stored = decodeFact(row);
  return stored?.target.subject === target.subject && stored.target.property === target.property ? stored.fact : null;
}

async function findCandidates(tx: Kysely<any>, ownerId: string, target: Target, now: Date, includeInactive = false) {
  const rows = await availableItems(tx, ownerId, now, includeInactive)
    .where(eb => eb.or([eb('fact.item_id', 'is', null), eb.and([eb('fact.subject', '=', target.subject), eb('fact.property', '=', target.property)])]))
    .orderBy('item.created_at', 'desc').orderBy('item.version', 'desc').orderBy('item.id', 'asc').execute() as CandidateRow[];
  return rows.flatMap(row => {
    const fact = readFact(row, target);
    return fact ? [{ ...row, fact }] : [];
  });
}

async function readCurrentFact(tx: Kysely<any>, ownerId: string, target: Target, itemId: string, now: Date) {
  const row = await availableItems(tx, ownerId, now).where('item.id', '=', itemId).forShare('item').executeTakeFirst() as CandidateRow | undefined;
  return row ? readFact(row, target) : null;
}

async function findSemanticRecall(tx: Kysely<any>, ownerId: string, query: string, now: Date): Promise<Result> {
  const relevance = structuredMemoryMatcher(query);
  const rows = await availableItems(tx, ownerId, now)
    .orderBy('item.created_at', 'desc').orderBy('item.version', 'desc').orderBy('item.id', 'asc').execute() as CandidateRow[];
  let highest = 0;
  let selected: { target: Target; fact: Fact; row: CandidateRow } | undefined;
  let ambiguous = false;
  for (const row of rows) {
    const decoded = decodeFact(row);
    if (!decoded) continue;
    const score = relevance(decoded.target);
    if (!score || score < highest) continue;
    if (score > highest) {
      highest = score;
      selected = { ...decoded, row };
      ambiguous = false;
      continue;
    }
    if (!selected || selected.target.subject !== decoded.target.subject || selected.target.property !== decoded.target.property
      || selected.fact.value !== decoded.fact.value || selected.fact.since !== decoded.fact.since || selected.fact.until !== decoded.fact.until) ambiguous = true;
  }
  if (ambiguous) return { kind: 'ambiguous' };
  const fact = selected && await readCurrentFact(tx, ownerId, selected.target, selected.row.id, new Date());
  if (fact && fact.statement === selected?.fact.statement) return { kind: 'recalled', fact };
  return { kind: 'missing' };
}

async function findExactRecall(tx: Kysely<any>, ownerId: string, target: Target, now: Date) {
  const [latest] = await findCandidates(tx, ownerId, target, now);
  if (!latest) return null;
  const fact = await readCurrentFact(tx, ownerId, target, latest.id, new Date());
  if (fact) return fact;
  const [current] = await findCandidates(tx, ownerId, target, new Date());
  return current ? readCurrentFact(tx, ownerId, target, current.id, new Date()) : null;
}

async function resolveTarget(tx: Kysely<any>, scope: Scope, requested: StructuredMemoryTarget): Promise<Target | null> {
  if (requested.subject !== null) return { ...requested, subject: requested.subject };
  if (scope.antecedent?.subject && scope.antecedent.property === requested.property)
    return { ...requested, subject: scope.antecedent.subject };
  if (scope.antecedentRunId && scope.antecedent?.property === requested.property) {
    const prior = await tx.selectFrom('memory_structured_operations as operation')
      .innerJoin('memory_items as item', 'item.id', 'operation.item_id')
      .leftJoin('memory_structured_versions as fact', join => join.onRef('fact.item_id', '=', 'item.id').on('fact.owner_id', '=', scope.ownerId))
      .select(['fact.subject', 'fact.property', 'item.content']).where('operation.owner_id', '=', scope.ownerId)
      .where('operation.conversation_id', '=', scope.conversationId).where('operation.run_id', '=', scope.antecedentRunId)
      .where('item.owner_id', '=', scope.ownerId).where('item.created_at', '<=', new Date(scope.evaluatedAt)).executeTakeFirst();
    if (!prior || hasStructuredMemorySecret(prior.content)) return null;
    if (prior.subject && prior.property === requested.property) return { ...requested, subject: prior.subject };
    const parsed = parseStructuredMemoryRequest(prior.content, { storedAssertion: true });
    return parsed.kind === 'statement' && parsed.target.subject && parsed.target.property === requested.property
      ? { ...requested, subject: parsed.target.subject } : null;
  }
  if (scope.antecedent !== undefined) return null;
  const latest = await tx.selectFrom('memory_structured_versions as fact').innerJoin('memory_items as item', 'item.id', 'fact.item_id')
    .select(['fact.subject', 'fact.property']).where('fact.owner_id', '=', scope.ownerId).where('item.owner_id', '=', scope.ownerId)
    .where('fact.conversation_id', '=', scope.conversationId).where('item.created_at', '<=', new Date(scope.evaluatedAt))
    .orderBy('item.created_at', 'desc').orderBy('item.id', 'asc').executeTakeFirst();
  return latest && latest.property === requested.property ? { ...requested, subject: latest.subject } : null;
}

async function lockCandidates(tx: Kysely<any>, ownerId: string, candidates: Candidate[]) {
  if (!candidates.length) return [];
  const locked = await tx.selectFrom('memory_items').select(['id', 'version', 'content', 'confidence_kind', 'expires_at']).where('owner_id', '=', ownerId)
    .where('id', 'in', candidates.map(row => row.id)).where('status', '=', 'active').orderBy('id', 'asc').forUpdate().execute();
  const byId = new Map(locked.map(row => [row.id, row]));
  if (locked.length !== candidates.length || candidates.some(row => {
    const found = byId.get(row.id);
    return found?.version !== row.version || found?.content !== row.content;
  })) throw integrityFailure();
  return locked;
}

function indexedVersions(tx: Kysely<any>, ownerId: string, target: Target) {
  return tx.selectFrom('memory_structured_versions as fact').innerJoin('memory_items as item', 'item.id', 'fact.item_id')
    .select(['item.id', 'item.root_id']).where('fact.owner_id', '=', ownerId).where('item.owner_id', '=', ownerId)
    .where('fact.subject', '=', target.subject).where('fact.property', '=', target.property);
}

async function forget(tx: Kysely<any>, scope: Scope, target: Target, now: Date, candidates: Candidate[]): Promise<'forgotten' | 'missing'> {
  const { ownerId, onOperation } = scope;
  const indexed = await indexedVersions(tx, ownerId, target).execute();
  const matching = [...indexed, ...candidates];
  const roots = [...new Set(matching.map(row => row.root_id))];
  if (!roots.length) return 'missing';

  // The manual delete/correct endpoints lock the current version before touching
  // history. Lock in the same order so a shared root isn't deleted out of order.
  await tx.selectFrom('memory_items as item').select('item.id').where('item.owner_id', '=', ownerId).where('item.root_id', 'in', roots)
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM memory_items newer WHERE newer.owner_id = item.owner_id
      AND newer.root_id = item.root_id AND newer.version > item.version)`).orderBy('item.id', 'asc').forUpdate('item').execute();
  const active = await availableItems(tx, ownerId, now).where('item.root_id', 'in', roots).forUpdate('item').execute() as CandidateRow[];
  const repurposed = new Set<string>();
  for (const row of active) {
    const parsed = row.fact_subject ? { subject: row.fact_subject, property: row.fact_property }
      : parseStructuredMemoryRequest(row.content, { storedAssertion: true });
    const activeTarget = 'kind' in parsed ? parsed.kind === 'statement' ? parsed.target : null : parsed;
    if (activeTarget?.subject && (activeTarget.subject !== target.subject || activeTarget.property !== target.property)) repurposed.add(row.root_id);
  }
  const matchingIds = new Set(matching.map(row => row.id));
  const items = await tx.selectFrom('memory_items').select(['id', 'root_id']).where('owner_id', '=', ownerId).where('root_id', 'in', roots).execute();
  const itemIds = items.filter(row => !repurposed.has(row.root_id) || matchingIds.has(row.id)).map(row => row.id);
  if (itemIds.length) {
    const refs = await tx.selectFrom('memory_provenance').select('evidence_id').where('memory_id', 'in', itemIds).distinct().execute();
    await tx.deleteFrom('memory_items').where('owner_id', '=', ownerId).where('id', 'in', itemIds).execute();
    if (refs.length) await tx.deleteFrom('memory_evidence').where('owner_id', '=', ownerId)
      .where('id', 'in', refs.map(row => row.evidence_id)).where('kind', 'in', ['manual', 'feedback'])
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM memory_provenance p WHERE p.evidence_id = memory_evidence.id)
        AND NOT EXISTS (SELECT 1 FROM memory_skill_versions s WHERE s.evidence_ids ? memory_evidence.id)`).execute();
    await tx.insertInto('memory_audit').values(roots.map(rootId => ({ id: randomUUID(), owner_id: ownerId, target_id: rootId,
      operation: 'delete', reason: 'حذف المستخدم محتوى الذاكرة وإصداراته.', created_at: now }))).execute();
    onOperation?.('forget');
  }
  const surviving = await tx.selectFrom('memory_items').select(['id', 'root_id']).where('owner_id', '=', ownerId).where('root_id', 'in', roots).execute();
  if (surviving.some(row => !repurposed.has(row.root_id) || matchingIds.has(row.id))) throw integrityFailure();
  onOperation?.('reconcile');
  return 'forgotten';
}

async function save(tx: Kysely<any>, scope: Scope, target: Target, intent: Extract<Intent, { kind: 'statement' | 'correction' }>,
  candidates: Candidate[], now: Date, intentHash: string): Promise<Candidate> {
  const { ownerId, conversationId, onOperation } = scope;
  const locked = await lockCandidates(tx, ownerId, candidates);
  const replacesLiveUserVersion = locked.some(row => row.confidence_kind === 'user_asserted' && new Date(row.expires_at) > now);
  if (!replacesLiveUserVersion) await assertLiveUserMemoryCapacity(tx, ownerId, now);
  const previous = candidates[0], id = randomUUID(), evidenceId = randomUUID();
  const rootId = previous?.root_id ?? id, version = (previous?.version ?? 0) + 1;
  const payloadHash = exactMemoryPayloadHash(intent.statement), sourceKey = `structured:${intentHash}`;
  const expiresAt = new Date(now.getTime() + RETENTION_MS);
  if (candidates.length) await tx.updateTable('memory_items').set({ status: 'superseded', updated_at: now }).where('owner_id', '=', ownerId)
    .where('id', 'in', candidates.map(row => row.id)).execute();
  await tx.insertInto('memory_items').values({ id, root_id: rootId, owner_id: ownerId, version, layer: 'semantic',
    title: 'Saved fact', content: intent.statement, status: 'active', confidence: 0.5, confidence_kind: 'user_asserted',
    task_id: null, expires_at: expiresAt, created_at: now, updated_at: now }).execute();
  await tx.insertInto('memory_evidence').values({ id: evidenceId, owner_id: ownerId, source_key: sourceKey, kind: 'manual',
    description: 'معلومة صرّح بها المستخدم.', task_id: null, event_id: null, content_hash: payloadHash, trust: 'manual', status: 'active',
    observed_at: now, expires_at: null }).execute();
  await tx.insertInto('memory_provenance').values({ memory_id: id, evidence_id: evidenceId, relation: 'asserted' }).execute();
  await tx.insertInto('memory_structured_versions').values({ item_id: id, owner_id: ownerId, conversation_id: conversationId,
    subject: target.subject, property: target.property, value: intent.value, valid_since: intent.since, valid_until: intent.until }).execute();
  if (previous) await tx.insertInto('memory_audit').values({ id: randomUUID(), owner_id: ownerId, target_id: id,
    operation: 'correct', reason: 'حدّث المستخدم قيمة المعلومة.', created_at: now }).execute();
  onOperation?.('write');

  const row = await availableItems(tx, ownerId, now).where('item.id', '=', id).where('item.root_id', '=', rootId)
    .where('item.version', '=', version).where('fact.conversation_id', '=', conversationId)
    .where('item.title', '=', 'Saved fact').where('item.expires_at', '=', expiresAt)
    .where(sql<boolean>`EXISTS (SELECT 1 FROM memory_provenance p JOIN memory_evidence e ON e.id = p.evidence_id
      WHERE p.memory_id = item.id AND e.id = ${evidenceId} AND e.source_key = ${sourceKey} AND e.owner_id = ${ownerId}
      AND e.content_hash = ${payloadHash} AND e.observed_at = ${now} AND e.task_id IS NULL AND e.event_id IS NULL)
      AND (SELECT count(*) FROM memory_provenance p WHERE p.memory_id = item.id) = 1`)
    .executeTakeFirst() as CandidateRow | undefined;
  const fact = row && readFact(row, target);
  if (!row || !fact || row.fact_subject !== target.subject || fact.statement !== intent.statement || fact.date.getTime() !== now.getTime()
    || fact.value !== intent.value || fact.since !== intent.since || fact.until !== intent.until) throw integrityFailure();
  onOperation?.('reconcile');
  return { ...row, fact };
}

/** Host-only. The caller binds the original user turn and fences access, mutation, read-back and response in this transaction. */
export async function applyStructuredMemory(tx: Kysely<any>, scope: Scope, intent: Intent): Promise<Result> {
  const now = new Date();
  if (!Number.isSafeInteger(scope.evaluatedAt) || scope.evaluatedAt < 0 || scope.evaluatedAt > now.getTime()) throw integrityFailure();
  const { ownerId, runId, conversationId, onOperation } = scope;
  MemoryExactOwnerSchema.parse(ownerId);
  if ('statement' in intent && (!MemoryExactPayloadSchema.safeParse(intent.statement).success
    || [intent.statement, intent.value, intent.since, intent.until].some(text => text && hasStructuredMemorySecret(text)))) throw integrityFailure();

  const mutation = intent.kind !== 'recall';
  const intentHash = mutation ? exactMemoryPayloadHash(JSON.stringify([ownerId, conversationId, runId, scope.evaluatedAt, intent])) : null;
  const prior = intentHash && await tx.selectFrom('memory_structured_operations').selectAll().where('owner_id', '=', ownerId).where('run_id', '=', runId).executeTakeFirst();
  if (prior && (prior.intent_hash !== intentHash || prior.conversation_id !== conversationId)) throw integrityFailure();
  const semanticOnly = intent.kind === 'recall' && intent.target.subject === null && intent.target.property === 'descriptor:query';
  const target = semanticOnly ? null : await resolveTarget(tx, scope, intent.target);
  if (prior) {
    if (prior.outcome === 'forgotten') {
      // A retry never deletes a replacement. Re-bind only an explicit or
      // pinned target, then recheck that none of its recorded versions exist.
      if (!target || intent.target.subject === null && !scope.antecedent?.subject
        || await indexedVersions(tx, ownerId, target).executeTakeFirst()
        || (await findCandidates(tx, ownerId, target, now, true)).length) return { kind: 'changed' };
      onOperation?.('reconcile');
      return { kind: 'forgotten' };
    }
    if (prior.outcome === 'missing' || prior.outcome === 'ambiguous') return { kind: prior.outcome };
    if (!target || !prior.item_id) return { kind: 'missing' };
    const fact = await readCurrentFact(tx, ownerId, target, prior.item_id, now);
    if (fact) onOperation?.('reconcile');
    return fact ? { kind: prior.outcome, fact } : { kind: 'missing' };
  }

  if (intent.kind === 'recall') {
    if (!target && !intent.query) return { kind: 'ambiguous' };
    const fact = target && await findExactRecall(tx, ownerId, target, now);
    const result: Result = fact ? { kind: 'recalled', fact } : intent.query
      ? await findSemanticRecall(tx, ownerId, intent.query, now) : { kind: 'missing' };
    onOperation?.('search');
    return result;
  }

  let outcome: Result = { kind: 'ambiguous' }, itemId: string | null = null;
  if (target) {
    const candidates = await findCandidates(tx, ownerId, target, now, intent.kind === 'forget');
    const latest = candidates[0];
    if (intent.kind === 'forget') outcome = { kind: await forget(tx, scope, target, now, candidates) };
    else if (!('statement' in intent) || !latest && intent.kind === 'correction') outcome = { kind: 'missing' };
    else if (candidates.length === 1 && latest && latest.fact.value === intent.value && latest.fact.since === intent.since && latest.fact.until === intent.until) {
      const verified = await readCurrentFact(tx, ownerId, target, latest.id, now);
      if (!verified) throw integrityFailure();
      onOperation?.('reconcile');
      outcome = { kind: 'unchanged', fact: verified };
      itemId = latest.id;
    } else {
      const previous = latest ? candidates : (await findCandidates(tx, ownerId, target, now, true)).filter(row => row.status === 'active');
      const written = await save(tx, scope, target, intent, previous, now, intentHash!);
      outcome = { kind: 'saved', fact: written.fact };
      itemId = written.id;
    }
  }
  if (intentHash) await tx.insertInto('memory_structured_operations').values({ owner_id: ownerId, run_id: runId,
    conversation_id: conversationId, intent_hash: intentHash, outcome: outcome.kind, item_id: itemId }).execute();
  return outcome;
}
