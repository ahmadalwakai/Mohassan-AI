/** Trusted local benchmark plumbing. No app config, dotenv, credentials,
 * provider creation or imported JavaScript is evaluated by this module. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect } from 'kysely';
import { migrate } from '@mohassan/database';
import { SkillContractSchema, SkillNodeBindingSchema, type SkillContract } from '@mohassan/contracts';
import { Runtime } from '@mohassan/runtime';
import { createSkillControl, createSkillRollbackControl, hashSkillData, sha256, skillContentMatches, skillsMigration, parseSkillManifest, type CompiledSkillContext } from '@mohassan/skills';
import { safeRelative, sensitivePath } from '@mohassan/coding/security';
import { createSkillRuntime } from './skill-runtime.ts';
import type { SkillToolControls } from './skill-tools.ts';
import { migrateAuth } from './auth.ts';
import type { SkillBenchmarkSnapshot } from '../../../packages/contracts/src/skill-benchmarks.ts';

export const BENCHMARK_OWNER = 'owned-isolated-skill-benchmark';
export const benchmarkJson = (value: any): any => typeof value === 'string' ? JSON.parse(value) : value;
export async function createBenchmarkDatabase(dataDir?: string) {
  const client = new PGlite(dataDir); await client.waitReady;
  const db = new Kysely<any>({ dialect: new PGliteDialect({ pglite: client }) });
  return { db, close: () => db.destroy() };
}
export function verifyBenchmarkSnapshot(snapshot: SkillBenchmarkSnapshot): SkillContract {
  const contract = SkillContractSchema.parse(snapshot.contract);
  if (!snapshot.files.length || snapshot.files.length > 200 || snapshot.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 1_048_576
    || new Set(snapshot.files.map(file => file.path)).size !== snapshot.files.length || !skillContentMatches(contract, snapshot.files, snapshot.pin.contentHash)) throw new Error('BENCHMARK_SOURCE_HASH_MISMATCH');
  for (const file of snapshot.files) {
    if (safeRelative(file.path) !== file.path || sensitivePath(file.path) || sha256(file.content) !== file.contentHash || Buffer.byteLength(file.content) !== file.sizeBytes) throw new Error('BENCHMARK_SOURCE_FILE_MISMATCH');
  }
  return contract;
}
export function verifyBenchmarkInstruction(snapshot: SkillBenchmarkSnapshot, context: CompiledSkillContext, cloneId: string, budget: number): boolean {
  try {
    const parsed = JSON.parse(context.text);
    if (parsed?.kind !== 'skill_context' || parsed.trust !== 'untrusted_instructions' || parsed.permissionsGranted !== false || context.text.length > budget
      || context.skills.length !== 1 || context.skills[0].id !== cloneId || context.skills[0].contentHash !== snapshot.pin.contentHash || parsed.skills?.length !== 1) return false;
    const delivered = parsed.skills[0];
    if (delivered.id !== cloneId || delivered.contentHash !== snapshot.pin.contentHash || delivered.version !== snapshot.contract.version || delivered.slug !== snapshot.contract.slug
      || !Array.isArray(delivered.sources) || !delivered.sources.length || delivered.sources.length !== context.sources.length) return false;
    const paths = new Set<string>();
    return delivered.sources.every((snippet: any) => {
      const file = snapshot.files.find(file => file.path === snippet.path), proof = context.sources.find(source => source.path === snippet.path);
      if (!file || !proof || paths.has(file.path) || snippet.contentHash !== file.contentHash || proof.skillId !== cloneId || proof.skillContentHash !== snapshot.pin.contentHash
        || proof.contentHash !== file.contentHash || proof.version !== snapshot.contract.version || proof.truncated !== snippet.truncated || typeof snippet.text !== 'string' || !snippet.text.trim()) return false;
      paths.add(file.path);
      const original = file.path === 'SKILL.md' && file.content.trimStart().startsWith('---') ? parseSkillManifest(file.content).body : file.content;
      return original.startsWith(snippet.text) && snippet.truncated === (snippet.text.length < original.length);
    });
  } catch { return false; }
}
export function createBenchmarkControls(db: Kysely<any>, directory: string, executeNode?: (next: () => Promise<any>, context: any) => Promise<any>) {
  const skills = createSkillControl(db, { enabled: true, allowedRoots: [directory], executableReady: async () => false,
    environment: () => ({ capabilities: [], gatewayTools: ['file.read', 'file.write'], executableReady: false, modelReady: false, visionReady: false }) });
  // No browser/memory engine is constructed. The suite rejects their contracts
  // and the permission snapshot exposes file tools alone.
  const execution = createSkillRuntime(db, { skills, browser: Object.freeze({}) as SkillToolControls['browser'], memory: Object.freeze({}) as SkillToolControls['memory'] });
  const rollback = createSkillRollbackControl(db);
  const runtime = new Runtime(db, { leaseMs: 1000, maxAttempts: 1,
    skillRuntime: executeNode ? { ...execution.runtimeOptions, executeNode: context => executeNode(() => execution.runtimeOptions.executeNode(context), context) } : execution.runtimeOptions,
    rollback: { prepare: rollback.prepare, execute: rollback.execute, verify: rollback.verify, recoverExpired: rollback.recoverExpired } });
  return { skills, runtime, rollback, execution };
}
export async function initializeBenchmarkClone(db: Kysely<any>, directory: string, snapshot: SkillBenchmarkSnapshot) {
  const contract = verifyBenchmarkSnapshot(snapshot);
  await migrateAuth(db); await migrate(db); await skillsMigration(db);
  await db.insertInto('user').values({ id: BENCHMARK_OWNER, name: 'Private benchmark copy', email: 'private-benchmark@example.test' }).execute();
  const familyId = randomUUID(), versionId = randomUUID();
  await db.insertInto('skill_families').values({ id: familyId, owner_id: BENCHMARK_OWNER, slug: contract.slug }).execute();
  // Experimental copy only. The original candidate may remain quarantined and
  // origin=forge. Its immutable pin is kept by the measurement, never mutated.
  await db.insertInto('skill_versions').values({ id: versionId, family_id: familyId, owner_id: BENCHMARK_OWNER, version: contract.version, sequence: 1,
    name: contract.name, description: contract.description, category: contract.category, level: contract.level, origin: 'custom', status: 'quarantined',
    contract: JSON.stringify(contract), content_hash: snapshot.pin.contentHash }).execute();
  await db.insertInto('skill_files').values(snapshot.files.map(file => ({ version_id: versionId, path: file.path, kind: file.kind, content: file.content, content_hash: file.contentHash, size_bytes: file.sizeBytes }))).execute();
  const controls = createBenchmarkControls(db, directory);
  let version = (await controls.skills.inspect(BENCHMARK_OWNER, versionId, { expectedRevision: 1 })).skill;
  version = (await controls.skills.activate(BENCHMARK_OWNER, versionId, { expectedRevision: version.revision, approve: true, acknowledgeFindings: true })).skill;
  return { ...controls, versionId: version.id, contract };
}
export async function prepareBenchmarkRoot(directory: string, caseId: string) {
  const root = join(directory, caseId); await mkdir(join(root, 'reports'), { recursive: true }); return realpath(root);
}
export async function grantBenchmarkRoot(controls: ReturnType<typeof createBenchmarkControls>, versionId: string, root: string, tool: 'file.read' | 'file.write') {
  const version = (await controls.skills.detail(BENCHMARK_OWNER, versionId)).skill;
  return controls.skills.createGrant(BENCHMARK_OWNER, versionId, { expectedRevision: version.revision, approve: true, tools: [tool], roots: [root], durationHours: 1 });
}
export async function startBenchmarkTask(controls: ReturnType<typeof createBenchmarkControls>, versionId: string, contract: SkillContract, values: Record<string, unknown>, key = randomUUID()) {
  const parent = await controls.runtime.createTask(BENCHMARK_OWNER, { title: 'Private benchmark fixture', goal: 'Execute the pinned candidate only against the owned fixed temporary fixture.', capabilityId: 'skill.run', autonomy: 'assisted',
    skillInput: { plan: { inputs: contract.inputs, nodes: [{ id: 'main', skillId: versionId, dependsOn: [], inputs: Object.fromEntries(contract.inputs.map(field => [field.name, `input.${field.name}`])) }] }, values } }, key);
  await controls.runtime.approve(BENCHMARK_OWNER, parent.id); return parent;
}
export async function tickBenchmarkTask(db: Kysely<any>, controls: ReturnType<typeof createBenchmarkControls>, parentId: string, signal: AbortSignal, approveChildren = true) {
  for (let tick = 0; tick < 12; tick++) {
    signal.throwIfAborted(); await controls.runtime.tick(); signal.throwIfAborted();
    const parent = await db.selectFrom('tasks').selectAll().where('id', '=', parentId).where('owner_id', '=', BENCHMARK_OWNER).executeTakeFirstOrThrow();
    if (['completed', 'failed', 'cancelled'].includes(parent.status)) return parent;
    if (approveChildren) {
      const children = await db.selectFrom('skill_run_nodes as n').innerJoin('skill_runs as r', 'r.id', 'n.run_id').innerJoin('tasks as t', 't.id', 'n.child_task_id')
        .select('t.id').where('r.parent_task_id', '=', parentId).where('t.owner_id', '=', BENCHMARK_OWNER).where('t.status', '=', 'waiting_approval').execute();
      for (const child of children) await controls.runtime.approve(BENCHMARK_OWNER, child.id);
    }
  }
  throw new Error('BENCHMARK_TICK_LIMIT');
}
/** Independently re-read persisted receipt, node and completed child. The
 * candidate's assertion and a task status alone are never the oracle. */
export async function benchmarkReceipt(db: Kysely<any>, parentId: string, snapshot: SkillBenchmarkSnapshot) {
  const rows = await db.selectFrom('skill_evidence as e').innerJoin('skill_runs as r', 'r.id', 'e.run_id').innerJoin('skill_run_nodes as n', joiner => joiner.onRef('n.run_id', '=', 'e.run_id').onRef('n.node_id', '=', 'e.node_id'))
    .innerJoin('tasks as t', 't.id', 'e.task_id').selectAll('e').select(['n.outputs as node_outputs', 'n.status as node_status', 'n.child_task_id', 'n.lease_token as current_node_lease', 'n.version_id as node_version_id', 'n.content_hash as node_content_hash', 'n.inputs_hash as node_inputs_hash', 'n.contract as node_contract', 'n.tool as node_tool', 'n.execution_attempt as node_attempt', 't.skill_binding', 't.result as task_result', 't.status as task_status', 't.verification_only', 't.verification_source_lease'])
    .where('r.parent_task_id', '=', parentId).where('r.owner_id', '=', BENCHMARK_OWNER).where('n.owner_id', '=', BENCHMARK_OWNER).where('t.owner_id', '=', BENCHMARK_OWNER).where('e.owner_id', '=', BENCHMARK_OWNER).where('e.status', '=', 'succeeded').execute();
  if (rows.length !== 1) throw new Error('BENCHMARK_VERIFIED_RECEIPT_MISSING');
  const row = rows[0], output = benchmarkJson(row.output), child = benchmarkJson(row.task_result);
  const binding = SkillNodeBindingSchema.safeParse(benchmarkJson(row.skill_binding));
  if (!binding.success || binding.data.parentTaskId !== parentId || binding.data.runId !== row.run_id || binding.data.nodeId !== row.node_id || binding.data.versionId !== row.version_id
    || binding.data.contentHash !== row.content_hash || binding.data.inputsHash !== row.inputs_hash || binding.data.kind !== 'tool' || binding.data.tool !== row.node_tool
    || row.node_lease_token !== row.current_node_lease || row.version_id !== row.node_version_id || row.content_hash !== row.node_content_hash || row.inputs_hash !== row.node_inputs_hash || row.attempt !== row.node_attempt
    || hashSkillData(benchmarkJson(row.node_contract)) !== hashSkillData(snapshot.contract)
    || row.content_hash !== snapshot.pin.contentHash || row.node_status !== 'succeeded' || row.task_status !== 'completed' || row.child_task_id !== row.task_id
    || hashSkillData(output) !== row.output_hash || hashSkillData(benchmarkJson(row.node_outputs)) !== row.output_hash
    || child?.evidenceId !== row.id || child?.runId !== row.run_id || child?.nodeId !== row.node_id || child?.inputsHash !== row.inputs_hash || child?.outputHash !== row.output_hash || hashSkillData(child.output) !== row.output_hash) throw new Error('BENCHMARK_VERIFIED_RECEIPT_CHANGED');
  const details = benchmarkJson(row.details), results = details.filter((entry: any) => entry.kind === 'gateway.result');
  if (results.length !== 1 || hashSkillData(results[0].data.inputs) !== row.inputs_hash) throw new Error('BENCHMARK_INPUT_RECEIPT_CHANGED');
  return { row, output, actual: results[0].data.actual, inputs: results[0].data.inputs,
    reference: { kind: 'runtime_receipt' as const, runId: row.run_id, taskId: row.task_id, receiptId: row.id, inputsHash: row.inputs_hash, outputHash: row.output_hash, verifiedAt: new Date(row.finished_at ?? row.created_at).toISOString() } };
}
export async function readBenchmarkText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
