import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillError, hashSkillData, sha256 } from '@mohassan/skills';
import { SkillBenchmarkCaseResultSchema, SkillBenchmarkSnapshotSchema, SkillBenchmarkSuiteSchema, type SkillBenchmarkCaseResult, type SkillBenchmarkSnapshot, type SkillBenchmarkSuite } from '../../../packages/contracts/src/skill-benchmarks.ts';
import { BENCHMARK_ASCII, BENCHMARK_BEFORE, BENCHMARK_UNICODE, skillBenchmarkDefinition, skillBenchmarkSuite, skillBenchmarkSupport, type TrustedSkillBenchmarkCase, type TrustedSkillBenchmarkSuite } from '../../../packages/skills/src/benchmark-suites.ts';
import { BENCHMARK_OWNER, benchmarkJson, benchmarkReceipt, createBenchmarkDatabase, grantBenchmarkRoot, initializeBenchmarkClone, prepareBenchmarkRoot, readBenchmarkText, startBenchmarkTask, tickBenchmarkTask, verifyBenchmarkSnapshot, verifyBenchmarkInstruction } from './skill-benchmark-isolation.ts';

type CaseEvidence = SkillBenchmarkCaseResult['evidence'];
export interface SkillBenchmarkRunnerInput { benchmarkRunId: string; arm: 'baseline' | 'candidate'; snapshot: SkillBenchmarkSnapshot; suite: SkillBenchmarkSuite; signal: AbortSignal }
type Observation = { pass: boolean; reasonCode?: string; inputsHash: string; outputHash: string; evidence: CaseEvidence; recovery?: boolean; safety?: boolean };
type Session = Awaited<ReturnType<typeof initializeBenchmarkClone>>;
const code = (error: unknown) => error instanceof SkillError ? error.code : error instanceof Error && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.message) ? error.message : 'BENCHMARK_VERIFICATION_FAILED';

async function ownedTemp(prefix = 'mohassan-benchmark-') {
  const base = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(base, prefix)));
  return { directory, async cleanup() {
    const target = await realpath(directory), inside = relative(base, target);
    if (target !== directory || isAbsolute(inside) || inside.startsWith('..') || inside.includes('/') || inside.includes('\\') || !inside.startsWith(prefix)) throw new Error('BENCHMARK_CLEANUP_REJECTED');
    await rm(target, { recursive: true, force: true });
  } };
}
function metadataEvidence(inputsHash: string, outputHash: string, kind: 'instruction_context' | 'file_observation' = 'instruction_context'): CaseEvidence { return [{ kind, inputsHash, outputHash, verifiedAt: new Date().toISOString() }]; }
async function instructionCase(session: Session, db: Awaited<ReturnType<typeof createBenchmarkDatabase>>['db'], snapshot: SkillBenchmarkSnapshot, item: TrustedSkillBenchmarkCase): Promise<Observation> {
  const budget = item.kind === 'bounded_delivery' ? 1200 : 4000, input = { versionId: snapshot.pin.versionId, budget, caseId: item.id }, inputsHash = hashSkillData(input);
  let output: unknown, pass = false;
  if (item.kind === 'revoked_delivery') {
    const version = (await session.skills.detail(BENCHMARK_OWNER, session.versionId)).skill;
    await session.skills.revoke(BENCHMARK_OWNER, session.versionId, { expectedRevision: version.revision, reason: 'Independent private benchmark revocation check.' });
    try { output = await session.skills.loadInstruction(BENCHMARK_OWNER, session.versionId, budget); pass = (output as { text: string }).text === ''; }
    catch (error) { output = { denied: code(error) }; pass = error instanceof SkillError && error.code === 'SKILL_NOT_ACTIVE'; }
  } else if (item.kind === 'changed_delivery') {
    const file = snapshot.files.find(value => value.path === 'SKILL.md')!;
    try {
      await db.updateTable('skill_files').set({ content: `${file.content}\nIndependent mutation with an unchanged stored hash.` }).where('version_id', '=', session.versionId).where('path', '=', 'SKILL.md').execute();
      try { output = await session.skills.loadInstruction(BENCHMARK_OWNER, session.versionId, budget); pass = (output as { text: string }).text === ''; }
      catch (error) { output = { denied: code(error) }; pass = error instanceof SkillError && error.code === 'SKILL_INTEGRITY_FAILED'; }
    } finally { await db.updateTable('skill_files').set({ content: file.content }).where('version_id', '=', session.versionId).where('path', '=', 'SKILL.md').execute(); }
  } else {
    const context = await session.skills.loadInstruction(BENCHMARK_OWNER, session.versionId, budget); output = context;
    pass = verifyBenchmarkInstruction(snapshot, context, session.versionId, budget);
  }
  const safety = !(await db.selectFrom('tasks').select('id').execute()).length && !(await db.selectFrom('skill_grants').select('id').execute()).length;
  const outputHash = hashSkillData(output); return { pass: pass && safety, safety, inputsHash, outputHash, evidence: metadataEvidence(inputsHash, outputHash) };
}
async function fileCase(session: Session, db: Awaited<ReturnType<typeof createBenchmarkDatabase>>['db'], directory: string, snapshot: SkillBenchmarkSnapshot, suite: TrustedSkillBenchmarkSuite, item: TrustedSkillBenchmarkCase, signal: AbortSignal): Promise<Observation> {
  const root = await prepareBenchmarkRoot(directory, item.id), relativePath = item.kind === 'outside_path' ? 'outside.txt' : 'reports/result.txt', path = join(root, relativePath);
  const expected = item.kind === 'file_ascii' ? BENCHMARK_ASCII : BENCHMARK_UNICODE, before = suite.mode === 'file.read' ? expected : BENCHMARK_BEFORE;
  await writeFile(path, before);
  const values = suite.mode === 'file.read' ? { root, path: relativePath } : { root, path: relativePath, content: expected, expectedHash: item.kind === 'stale_hash' ? '0'.repeat(64) : sha256(before) };
  const inputsHash = hashSkillData(values), denied = ['missing_grant', 'outside_path', 'stale_hash'].includes(item.kind);
  let grant: Awaited<ReturnType<typeof grantBenchmarkRoot>> | undefined;
  if (item.kind !== 'missing_grant') grant = await grantBenchmarkRoot(session, session.versionId, root, suite.mode as 'file.read' | 'file.write');
  try {
    let parent: { id: string } | undefined, terminal: any, failure: unknown;
    try { parent = await startBenchmarkTask(session, session.versionId, session.contract, values); terminal = await tickBenchmarkTask(db, session, parent.id, signal); }
    catch (error) { failure = error; }
    signal.throwIfAborted();
    if (denied) {
      const unchanged = await readBenchmarkText(path) === before;
      const receipts = parent ? await db.selectFrom('skill_evidence as e').innerJoin('skill_runs as r', 'r.id', 'e.run_id').select(['e.id', 'e.status', 'e.error_code']).where('r.parent_task_id', '=', parent.id).execute() : [];
      const validation = await session.skills.validateComposition(BENCHMARK_OWNER, { inputs: session.contract.inputs, nodes: [{ id: 'main', skillId: session.versionId, dependsOn: [], inputs: Object.fromEntries(session.contract.inputs.map(field => [field.name, `input.${field.name}`])) }] });
      const expectedCode = item.kind === 'outside_path' ? 'SKILL_FILE_UNDECLARED' : item.kind === 'stale_hash' ? 'SKILL_FILE_CONFLICT' : 'tool_not_granted';
      const typedRejection = item.kind === 'missing_grant' ? !validation.valid && validation.issues.some(issue => issue.code === expectedCode)
        : receipts.some(row => ['failed', 'unknown'].includes(row.status) && row.error_code === expectedCode) || failure instanceof SkillError && failure.code === expectedCode;
      const outcome = { unchanged, rejected: Boolean(failure || terminal?.status === 'failed') && typedRejection, expectedCode, observedFileHash: sha256(await readBenchmarkText(path) ?? ''), receipts: receipts.map(row => ({ status: row.status, code: row.error_code })) };
      const outputHash = hashSkillData(outcome);
      return { pass: outcome.rejected && unchanged && !receipts.some(row => row.status === 'succeeded'), safety: unchanged, inputsHash, outputHash, evidence: metadataEvidence(inputsHash, outputHash, 'file_observation'), ...(outcome.rejected ? {} : { reasonCode: 'BENCHMARK_EXPECTED_REJECTION_MISSING' }) };
    }
    if (failure) throw failure;
    if (!parent || terminal?.status !== 'completed') throw new Error('BENCHMARK_TASK_NOT_COMPLETED');
    const receipt = await benchmarkReceipt(db, parent.id, snapshot), observed = await readBenchmarkText(path);
    let pass = observed === expected && receipt.actual.hash === sha256(expected) && receipt.actual.bytes === Buffer.byteLength(expected)
      && receipt.inputs.root === root && receipt.inputs.path === relativePath && receipt.output.hash === sha256(expected);
    if (suite.mode === 'file.read') pass &&= receipt.actual.content === expected;
    if (item.kind === 'confirmed_rollback') {
      const preimage = await db.selectFrom('skill_preimages').selectAll().where('receipt_id', '=', receipt.row.id).executeTakeFirstOrThrow();
      const prepared = await session.rollback.describe(BENCHMARK_OWNER, receipt.row.run_id, { preimageId: preimage.id, expectedAfterHash: sha256(expected) });
      const undo = await session.runtime.createTask(BENCHMARK_OWNER, { title: prepared.title, goal: prepared.goal, capabilityId: 'skill.rollback', autonomy: 'assisted', skillRollbackInput: prepared.input }, randomUUID());
      const unchangedBeforeApproval = await readBenchmarkText(path) === expected;
      await session.runtime.approve(BENCHMARK_OWNER, undo.id); await session.runtime.tick();
      const completed = await db.selectFrom('tasks').select(['status', 'result']).where('id', '=', undo.id).executeTakeFirstOrThrow(), restored = await readBenchmarkText(path);
      const journal = await db.selectFrom('skill_rollbacks').selectAll().where('task_id', '=', undo.id).executeTakeFirstOrThrow();
      pass &&= unchangedBeforeApproval && completed.status === 'completed' && journal.status === 'succeeded' && restored === before && benchmarkJson(completed.result).restoredHash === sha256(before);
    }
    return { pass, safety: pass, inputsHash, outputHash: receipt.row.output_hash, evidence: [receipt.reference] };
  } finally {
    if (grant) await session.skills.revokeGrant(BENCHMARK_OWNER, session.versionId, grant.id, { reason: 'Private benchmark case ended.' });
  }
}

async function runWorker(directory: string, nonce: string, phase: 'start' | 'resume', signal: AbortSignal) {
  signal.throwIfAborted();
  const worker = fileURLToPath(new URL('./skill-benchmark-worker.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', worker, directory, phase], { cwd: dirname(fileURLToPath(new URL('../../../package.json', import.meta.url))), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: 'test' } });
  const closed = once(child, 'close'); let captured = 0, fatal: Error | undefined;
  const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  const abort = () => { fatal = new Error('BENCHMARK_CANCELLED'); kill(); }; signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { fatal = new Error('BENCHMARK_WORKER_TIMEOUT'); kill(); }, 45000);
  const output = (chunk: Buffer) => { captured += chunk.length; if (captured > 16000) { fatal = new Error('BENCHMARK_WORKER_OUTPUT_LIMIT'); kill(); } };
  child.stdout!.on('data', output); child.stderr!.on('data', output);
  try {
    const message = await new Promise<any>((resolveMessage, reject) => {
      child.once('error', reject);
      child.on('message', raw => {
        const value = raw as any;
        if (!value || value.nonce !== nonce || value.pid !== child.pid || value.kind !== (phase === 'start' ? 'checkpoint' : 'finished')) return;
        resolveMessage(value);
      });
      child.once('close', () => reject(fatal ?? new Error('BENCHMARK_WORKER_ENDED_WITHOUT_RESULT')));
    });
    if (phase === 'start') { if (message.stage !== 'confirmed-receipt-before-runtime-finish') throw new Error('BENCHMARK_WORKER_CHECKPOINT_INVALID'); kill(); }
    const [exitCode] = await closed;
    if (fatal) throw fatal; if (phase === 'resume' && exitCode !== 0) throw new Error('BENCHMARK_WORKER_FAILED');
    return message;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); kill(); await closed.catch(() => {}); }
}
async function crashCase(snapshot: SkillBenchmarkSnapshot, signal: AbortSignal): Promise<Observation> {
  const temp = await ownedTemp('mohassan-benchmark-worker-'), nonce = randomUUID();
  try {
    await writeFile(join(temp.directory, 'manifest.json'), JSON.stringify({ nonce, snapshot }), { flag: 'wx', mode: 0o600 });
    await runWorker(temp.directory, nonce, 'start', signal);
    // Lease time is real; never forge expiration or task/receipt state.
    await new Promise<void>((resolveDelay, reject) => { const abort = () => { clearTimeout(timer); reject(new Error('BENCHMARK_CANCELLED')); }; const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveDelay(); }, 1100); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    const resumed = await runWorker(temp.directory, nonce, 'resume', signal);
    const store = await createBenchmarkDatabase(join(temp.directory, 'database'));
    try {
      const receipt = await benchmarkReceipt(store.db, resumed.parentId, snapshot), path = join(temp.directory, 'confirmed-crash', 'reports', 'result.txt');
      const parent = await store.db.selectFrom('tasks').select('status').where('id', '=', resumed.parentId).executeTakeFirstOrThrow();
      const dispatches = (await readFile(join(temp.directory, 'dispatches.txt'), 'utf8')).trim().split('\n').length;
      const events = await store.db.selectFrom('task_events').select('type').where('task_id', '=', receipt.row.task_id).execute();
      const pass = parent.status === 'completed' && await readBenchmarkText(path) === BENCHMARK_UNICODE && dispatches === 1 && receipt.row.attempt === 1 && receipt.row.verification_only === true
        && receipt.row.verification_source_lease === receipt.row.lease_token && events.some(event => event.type === 'verification_recovered');
      return { pass, recovery: pass, safety: pass, inputsHash: receipt.row.inputs_hash, outputHash: receipt.row.output_hash, evidence: [receipt.reference] };
    } finally { await store.close(); }
  } finally { await temp.cleanup(); }
}

/** Server-only runner. API clients select a known suite and version IDs; they
 * cannot submit observations, fixture roots, oracle functions or evidence. */
export function createSkillBenchmarkRunner() {
  return { async execute(raw: SkillBenchmarkRunnerInput, onCase: (result: SkillBenchmarkCaseResult) => Promise<void>): Promise<void> {
    const snapshot = SkillBenchmarkSnapshotSchema.parse(JSON.parse(JSON.stringify(raw.snapshot))), supplied = SkillBenchmarkSuiteSchema.parse(raw.suite);
    const suite = skillBenchmarkSuite(supplied.id), expected = skillBenchmarkDefinition(supplied.id);
    if (!suite || JSON.stringify(supplied) !== JSON.stringify(SkillBenchmarkSuiteSchema.parse(expected))) throw new Error('BENCHMARK_SUITE_CHANGED');
    const contract = verifyBenchmarkSnapshot(snapshot), unsupported = skillBenchmarkSupport(contract, suite);
    const signal = AbortSignal.any([raw.signal, AbortSignal.timeout(120000)]);
    let temp: Awaited<ReturnType<typeof ownedTemp>> | undefined, store: Awaited<ReturnType<typeof createBenchmarkDatabase>> | undefined, session: Session | undefined, setupError: unknown;
    try {
      if (!unsupported && !signal.aborted) {
        try { temp = await ownedTemp(); store = await createBenchmarkDatabase(); session = await initializeBenchmarkClone(store.db, temp.directory, snapshot); }
        catch (error) { setupError = error; }
      }
      for (const item of suite.cases) {
        const startedAt = new Date().toISOString(), start = performance.now(); let observation: Observation | undefined, reasonCode: string | null = unsupported, status: SkillBenchmarkCaseResult['status'] = 'blocked';
        if (signal.aborted) { status = 'unknown'; reasonCode = 'BENCHMARK_CANCELLED'; }
        else if (setupError) { status = 'blocked'; reasonCode = code(setupError); }
        else if (!unsupported && session && store && temp) {
          try {
            observation = item.kind === 'confirmed_crash' ? await crashCase(snapshot, signal)
              : suite.mode === 'instruction' ? await instructionCase(session, store.db, snapshot, item)
                : await fileCase(session, store.db, temp.directory, snapshot, suite, item, signal);
            status = observation.pass ? 'passed' : 'failed'; reasonCode = observation.pass ? null : observation.reasonCode ?? 'BENCHMARK_ORACLE_MISMATCH';
          } catch (error) { status = signal.aborted ? 'unknown' : 'failed'; reasonCode = code(error); }
        }
        const finishedAt = new Date().toISOString(), result = SkillBenchmarkCaseResultSchema.parse({ caseId: item.id, arm: raw.arm, split: item.split, scope: suite.scope, status, reasonCode,
          sourceVersionId: snapshot.pin.versionId, sourceContentHash: snapshot.pin.contentHash, suiteHash: suite.suiteHash, configHash: suite.configHash, verifierVersion: suite.verifierVersion, evidenceScope: 'isolated_experiment',
          inputsHash: observation?.inputsHash ?? hashSkillData({ fixtureHash: item.fixtureHash, sourceContentHash: snapshot.pin.contentHash }), outputHash: observation?.outputHash ?? null,
          startedAt, finishedAt, durationMs: performance.now() - start, metrics: { success: observation?.pass ?? (status === 'failed' ? false : null), verification: observation?.pass ?? null, safety: observation?.safety ?? null, recovery: observation?.recovery ?? null, costUsd: null },
          notApplicable: item.kind === 'confirmed_crash' ? [] : ['recovery'], usage: { inputTokens: 0, outputTokens: 0 }, evidence: observation?.evidence ?? [] });
        await onCase(result);
      }
    } finally { await session?.runtime.stop(); await store?.close(); await temp?.cleanup(); }
  } };
}
