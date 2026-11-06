import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { SkillContractSchema, type SkillContract } from '@mohassan/contracts';
import { SkillGraphEdgeSchema, SkillGraphNodeSchema, SkillGraphRelatedQuerySchema, SkillGraphRelatedSchema, SkillGraphSnapshotSchema, type SkillGraphEdge, type SkillGraphNode, type SkillGraphSnapshot } from '../../contracts/src/skill-graph.ts';
import { SkillError } from './errors.ts';
import { sha256 } from './hash.ts';
import { INSPECTOR_VERSION } from './inspector.ts';
import { skillToolCapabilities } from './permissions.ts';
import { canonicalSkillEvidenceJson, hashSkillData } from './evidence.ts';

export const skillGraphLimits = Object.freeze({ versions: 200, outcomes: 80, nodes: 400, edges: 1200, depth: 2 } as const);
const json = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : value;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
type Version = { node: Extract<SkillGraphNode, {kind: 'skill'}>; contract: SkillContract };
type Sources = { versions: Map<string, Version>; outcomes: Extract<SkillGraphNode, {kind: 'outcome'}>[]; outcomeVersions: Map<string, string>; truncated: boolean };

function versionSelection(db: Kysely<any>, ownerId: string) {
  return db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id')
    .select(['v.id', 'v.contract', 'v.content_hash', 'v.status', 'v.level', 'v.name', 'v.description', 'v.category', 'v.version', 'f.slug', 'f.active_version_id'])
    .where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId);
}
function parseVersion(row: any, routingEligible: boolean): Version | null {
  try {
    const contract = SkillContractSchema.parse(json(row.contract));
    if (contract.slug !== row.slug || contract.name !== row.name || contract.description !== row.description || contract.category !== row.category || contract.version !== row.version || contract.level !== row.level) return null;
    const node = SkillGraphNodeSchema.parse({ key: `skill:${row.id}`, label: contract.name, kind: 'skill', skillVersionId: row.id, slug: contract.slug, version: contract.version, contentHash: row.content_hash, level: contract.level, active: row.status === 'active' && row.active_version_id === row.id, routingEligible, verification: 'current_metadata' });
    return { node: node as Version['node'], contract };
  } catch { return null; }
}

/** Metadata only: this cannot authorize or prove fresh source-file execution.
 * The instruction compiler and Gateway still verify full content on every load. */
async function sources(db: Kysely<any>, ownerId: string): Promise<Sources> {
  const rows = await versionSelection(db, ownerId).where('v.status', '=', 'active').whereRef('f.active_version_id', '=', 'v.id').orderBy('f.slug').orderBy('v.id').limit(skillGraphLimits.versions + 1).execute();
  const candidates = rows.slice(0, skillGraphLimits.versions);
  const versions = new Map<string, Version>();
  const inspections = candidates.length ? await db.selectFrom('skill_inspections as i').innerJoin('skill_versions as v', join => join.onRef('v.id', '=', 'i.version_id').onRef('v.content_hash', '=', 'i.content_hash'))
    .select(['i.version_id', 'i.inspector_version', 'i.verdict']).where('i.owner_id', '=', ownerId).where('v.owner_id', '=', ownerId).where('i.version_id', 'in', candidates.map(row => row.id))
    .distinctOn('i.version_id').orderBy('i.version_id').orderBy('i.created_at', 'desc').orderBy('i.id', 'desc').execute() : [];
  const byInspection = new Map(inspections.map(inspection => [inspection.version_id, inspection]));
  for (const row of candidates) {
    const version = parseVersion(row, true); if (!version) continue;
    const inspection = byInspection.get(row.id);
    if (inspection?.inspector_version !== INSPECTOR_VERSION || !['pass', 'review'].includes(inspection.verdict)) continue;
    versions.set(row.id, version);
  }
  const proofs = await db.selectFrom('skill_evidence as e')
    .innerJoin('skill_run_nodes as n', join => join.onRef('n.run_id', '=', 'e.run_id').onRef('n.node_id', '=', 'e.node_id').onRef('n.child_task_id', '=', 'e.task_id').onRef('n.execution_attempt', '=', 'e.attempt'))
    .innerJoin('skill_runs as r', 'r.id', 'e.run_id').innerJoin('tasks as t', 't.id', 'e.task_id').innerJoin('skill_versions as v', 'v.id', 'e.version_id')
    .select(['e.id', 'e.task_id', 'e.run_id', 'e.node_id', 'e.version_id', 'e.content_hash', 'e.inputs_hash', 'e.output_hash', 'e.output', 'e.attempt', 'e.finished_at', 't.capability_id',
      sql<string | null>`jsonb_path_query_array(e.details, '$[*] ? (@.kind == "runtime.verified").data')->0->>'resultHash'`.as('native_result_hash')])
    .where('e.owner_id', '=', ownerId).where('n.owner_id', '=', ownerId).where('r.owner_id', '=', ownerId).where('t.owner_id', '=', ownerId).where('v.owner_id', '=', ownerId)
    .where('e.status', '=', 'succeeded').where('n.status', '=', 'succeeded').where('t.status', '=', 'completed').where('t.cancellation_requested', '=', false).where('n.kind', 'in', ['tool', 'model'])
    .whereRef('e.version_id', '=', 'n.version_id').whereRef('e.content_hash', '=', 'n.content_hash').whereRef('e.content_hash', '=', 'v.content_hash').whereRef('e.inputs_hash', '=', 'n.inputs_hash').whereRef('e.output_hash', '=', 'n.output_hash')
    .whereRef('e.node_lease_token', '=', 'n.lease_token')
    .where('e.finished_at', 'is not', null)
    // JSONB adds whitespace; the strict canonical 64KiB check happens below.
    // Bound transport first, then recompute the actual independently stored hash.
    .where(sql<boolean>`jsonb_typeof(e.output)='object' AND octet_length(e.output::text)<=131072 AND n.outputs=e.output`)
    .where(sql<boolean>`t.skill_binding = jsonb_strip_nulls(jsonb_build_object('parentTaskId',r.parent_task_id,'runId',e.run_id,'nodeId',e.node_id,'versionId',e.version_id,'contentHash',e.content_hash,'inputsHash',e.inputs_hash,'kind',n.kind,'tool',n.tool))`)
    .where(sql<boolean>`(
      (t.capability_id='skill.node' AND t.result->>'evidenceId'=e.id AND t.result->>'runId'=e.run_id AND t.result->>'nodeId'=e.node_id AND t.result->>'inputsHash'=e.inputs_hash AND t.result->>'outputHash'=e.output_hash AND t.result->'output'=e.output)
      OR (t.capability_id IN ('browser.open','coding.change','studio.change') AND n.kind='tool' AND t.capability_id=n.tool
        AND jsonb_array_length(jsonb_path_query_array(e.details, '$[*] ? (@.kind == "runtime.verified").data'))=1
        AND jsonb_path_query_array(e.details, '$[*] ? (@.kind == "runtime.verified").data')->0->>'taskId'=e.task_id
        AND jsonb_path_query_array(e.details, '$[*] ? (@.kind == "runtime.verified").data')->0->>'tool'=n.tool
        AND jsonb_path_query_array(e.details, '$[*] ? (@.kind == "runtime.verified").data')->0->>'projectionHash'=e.output_hash
        AND jsonb_path_query_array(e.details, '$[*] ? (@.kind == "runtime.verified").data')->0->'rawResult'=t.result)
    )`)
    .orderBy('e.finished_at', 'desc').orderBy('e.id').limit(skillGraphLimits.outcomes + 1).execute();
  const outcomes: Sources['outcomes'] = [], outcomeVersions = new Map<string, string>();
  let truncated = rows.length > skillGraphLimits.versions || proofs.length > skillGraphLimits.outcomes;
  for (const proof of proofs.slice(0, skillGraphLimits.outcomes)) {
    try { if (hashSkillData(json(proof.output)) !== proof.output_hash) continue; } catch { continue; }
    if (proof.capability_id !== 'skill.node') {
      // Read one bounded native result at a time. Never load all 80 raw results
      // together or return their contents as graph metadata.
      const task = await db.selectFrom('tasks').select('result').where('id', '=', proof.task_id).where('owner_id', '=', ownerId).where('status', '=', 'completed')
        .where(sql<boolean>`octet_length(result::text)<=1048576`).executeTakeFirst();
      try { if (!task || sha256(canonicalSkillEvidenceJson(json(task.result))) !== proof.native_result_hash) continue; } catch { continue; }
    }
    let version = versions.get(proof.version_id);
    if (!version) {
      if (versions.size >= skillGraphLimits.versions) { truncated = true; continue; }
      const row = await versionSelection(db, ownerId).where('v.id', '=', proof.version_id).executeTakeFirst();
      // A stale or uninspected active version must not regain routing authority
      // merely because it has an old successful receipt.
      if (row) version = parseVersion(row, false) ?? undefined;
      if (version) versions.set(proof.version_id, version);
    }
    if (!version || version.node.contentHash !== proof.content_hash) continue;
    const parsed = SkillGraphNodeSchema.safeParse({ key: `outcome:${proof.id}`, kind: 'outcome', label: 'Verified step outcome', scope: 'step', receiptId: proof.id, taskId: proof.task_id, runId: proof.run_id, nodeId: proof.node_id, inputsHash: proof.inputs_hash, outputHash: proof.output_hash, attempt: proof.attempt, verifiedAt: new Date(proof.finished_at).toISOString() });
    if (!parsed.success || parsed.data.kind !== 'outcome') continue;
    outcomes.push(parsed.data); outcomeVersions.set(parsed.data.key, proof.version_id);
  }
  return { versions, outcomes, outcomeVersions, truncated };
}

function edge(from: string, to: string, relation: SkillGraphEdge['relation'], provenance: SkillGraphEdge['provenance'], sourceContentHash: string | null = null, targetContentHash: string | null = null): SkillGraphEdge {
  const value = { from, to, relation, provenance, sourceContentHash, targetContentHash };
  return SkillGraphEdgeSchema.parse({ id: sha256(JSON.stringify(value)), ...value });
}
function declaredEdges(data: Sources): SkillGraphEdge[] {
  const active = [...data.versions.values()].filter(version => version.node.active && version.node.routingEligible), bySlug = new Map(active.map(version => [version.contract.slug, version]));
  const edges: SkillGraphEdge[] = [];
  for (const { node, contract } of active) {
    for (const [relation, slugs] of [['depends_on', contract.dependsOn], ['conflicts_with', contract.conflicts]] as const) for (const slug of slugs) {
      const target = bySlug.get(slug); if (target) edges.push(edge(node.key, target.node.key, relation, 'declared_contract', node.contentHash, target.node.contentHash));
    }
    for (const tool of contract.requires.tools) {
      edges.push(edge(node.key, `tool:${tool}`, 'requires_tool', 'declared_contract', node.contentHash));
      const capability = skillToolCapabilities[tool];
      if (capability) edges.push(edge(`tool:${tool}`, `capability:${capability}`, 'implemented_by', 'trusted_tool_mapping'));
    }
  }
  for (const outcome of data.outcomes) {
    const version = data.versions.get(data.outcomeVersions.get(outcome.key)!)!;
    edges.push(edge(version.node.key, outcome.key, 'verified_outcome', 'verified_receipt', version.node.contentHash));
  }
  return [...new Map(edges.map(item => [item.id, item])).values()].sort((a, b) => compare(a.id, b.id));
}
function snapshot(data: Sources, rawEdges: SkillGraphEdge[], rebuilt: boolean, previousTruncation = false): SkillGraphSnapshot {
  const allowed = new Map(declaredEdges(data).map(item => [item.id, item]));
  const edges = rawEdges.filter(item => allowed.has(item.id) && JSON.stringify(item) === JSON.stringify(allowed.get(item.id))).slice(0, skillGraphLimits.edges).sort((a, b) => compare(a.id, b.id));
  const present = new Set(edges.map(item => item.id));
  const incomplete = [...allowed.keys()].some(id => !present.has(id));
  const outcomeKeys = new Set(edges.filter(item => item.relation === 'verified_outcome').map(item => item.to));
  const used = new Set(edges.flatMap(item => [item.from, item.to]));
  const nodes: SkillGraphNode[] = [...data.versions.values()].filter(version => version.node.routingEligible || used.has(version.node.key)).map(version => version.node);
  nodes.push(...data.outcomes.filter(outcome => outcomeKeys.has(outcome.key)));
  for (const key of [...used].sort(compare)) {
    if (key.startsWith('tool:')) nodes.push(SkillGraphNodeSchema.parse({ key, kind: 'tool', label: key.slice(5), toolId: key.slice(5) }));
    if (key.startsWith('capability:')) nodes.push(SkillGraphNodeSchema.parse({ key, kind: 'capability', label: key.slice(11), capabilityId: key.slice(11) }));
  }
  nodes.sort((a, b) => compare(a.key, b.key));
  const bounded = nodes.slice(0, skillGraphLimits.nodes), keys = new Set(bounded.map(node => node.key)), boundedEdges = edges.filter(item => keys.has(item.from) && keys.has(item.to));
  return SkillGraphSnapshotSchema.parse({ nodes: bounded, edges: boundedEdges, rebuilt, truncated: previousTruncation || data.truncated || incomplete || rawEdges.length > skillGraphLimits.edges || nodes.length > skillGraphLimits.nodes,
    permissionsGranted: false, limits: skillGraphLimits, snapshotHash: sha256(JSON.stringify({ nodes: bounded, edges: boundedEdges })) });
}

/** Serialize before any source read. Existing lifecycle/scheduler transactions
 * retain their own lock order; graph rebuilding takes no source row locks. */
export async function rebuildSkillGraph(db: Kysely<any>, ownerId: string): Promise<SkillGraphSnapshot> {
  z.string().min(1).max(200).parse(ownerId);
  const rebuild = async (tx: Kysely<any>) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-graph:${ownerId}`}, 0))`.execute(tx);
    const data = await sources(tx, ownerId), allEdges = declaredEdges(data), result = snapshot(data, allEdges, true);
    await tx.deleteFrom('skill_edges').where('owner_id', '=', ownerId).execute();
    await tx.insertInto('skill_edges').values({ owner_id: ownerId, edge_key: '@snapshot', record_kind: 'snapshot', payload: JSON.stringify({ truncated: result.truncated }) }).execute();
    for (let index = 0; index < result.edges.length; index += 100) await tx.insertInto('skill_edges').values(result.edges.slice(index, index + 100).map(item => ({ owner_id: ownerId, edge_key: item.id, record_kind: 'edge', payload: JSON.stringify(item) }))).execute();
    return result;
  };
  return db.isTransaction ? rebuild(db) : db.transaction().execute(rebuild);
}

async function readSnapshot(db: Kysely<any>, ownerId: string): Promise<SkillGraphSnapshot> {
  const data = await sources(db, ownerId);
  const stored = await db.selectFrom('skill_edges').select(['record_kind', 'payload']).where('owner_id', '=', ownerId).orderBy('edge_key').limit(skillGraphLimits.edges + 2).execute();
  const edges: SkillGraphEdge[] = []; let rebuilt = false, truncated = stored.length > skillGraphLimits.edges + 1;
  for (const row of stored) {
    try {
      if (row.record_kind === 'snapshot') { rebuilt = true; truncated ||= json(row.payload)?.truncated === true; }
      else { const parsed = SkillGraphEdgeSchema.safeParse(json(row.payload)); if (parsed.success) edges.push(parsed.data); else truncated = true; }
    } catch { truncated = true; /* An unreadable row might have contained a conflict. */ }
  }
  return snapshot(data, edges, rebuilt, truncated);
}
export async function readSkillGraph(db: Kysely<any>, ownerId: string): Promise<SkillGraphSnapshot> {
  z.string().min(1).max(200).parse(ownerId);
  return db.isTransaction ? readSnapshot(db, ownerId) : db.transaction().setIsolationLevel('repeatable read').execute(tx => readSnapshot(tx, ownerId));
}

/** Follow only explicit dependencies, never conflicts or shared tools. Related
 * versions are suggestions; the compiler revalidates the actual instruction. */
export async function relatedSkills(db: Kysely<any>, ownerId: string, seedVersionIds: readonly string[], raw: unknown = {}) {
  const seeds = z.array(z.uuid()).max(12).parse(seedVersionIds), query = SkillGraphRelatedQuerySchema.parse(raw);
  const read = async (tx: Kysely<any>) => {
    if (seeds.length) {
      const owned = await tx.selectFrom('skill_versions').select('id').where('owner_id', '=', ownerId).where('id', 'in', [...new Set(seeds)]).execute();
      if (owned.length !== new Set(seeds).size) throw new SkillError('SKILL_NOT_FOUND', 'لم يُعثر على مهارة البداية لهذا المالك.', 404);
    }
    const graph = await readSnapshot(tx, ownerId);
    // A capped graph may have omitted a conflict. No recommendation may treat
    // absence from that partial snapshot as proof that the pair is compatible.
    if (graph.truncated) return SkillGraphRelatedSchema.parse({ skillIds: [], truncated: true, permissionsGranted: false });
    const active = new Set(graph.nodes.filter((node): node is Version['node'] => node.kind === 'skill' && node.active && node.routingEligible).map(node => node.key));
    const seen = new Set(seeds.map(id => `skill:${id}`)), selected = new Set(seen), result: string[] = []; let frontier = [...seen].filter(key => active.has(key)).sort(compare); let truncated: boolean = false;
    const conflicts = (key: string) => graph.edges.some(relation => relation.relation === 'conflicts_with' && (relation.from === key && selected.has(relation.to) || relation.to === key && selected.has(relation.from)));
    for (let depth = 0; depth < query.depth && frontier.length; depth++) {
      const next = new Set<string>();
      for (const current of frontier) for (const relation of graph.edges) {
        if (relation.relation !== 'depends_on' || relation.from !== current || !active.has(relation.to) || seen.has(relation.to)) continue;
        seen.add(relation.to); next.add(relation.to);
      }
      frontier = [];
      for (const key of [...next].sort(compare)) {
        if (conflicts(key)) continue;
        if (result.length >= query.limit) { truncated = true; break; }
        result.push(key.slice(6)); selected.add(key); frontier.push(key);
      }
      if (result.length >= query.limit) { if (depth + 1 < query.depth && frontier.some(key => graph.edges.some(relation => relation.relation === 'depends_on' && relation.from === key && !seen.has(relation.to) && active.has(relation.to)))) truncated = true; break; }
    }
    return SkillGraphRelatedSchema.parse({ skillIds: result, truncated, permissionsGranted: false });
  };
  return db.isTransaction ? read(db) : db.transaction().setIsolationLevel('repeatable read').execute(read);
}
