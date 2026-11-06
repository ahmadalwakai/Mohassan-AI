import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SkillContractSchema, type SkillContract } from '@mohassan/contracts';
import { createSkillControl, sha256, skillContentHash, skillsMigration } from '@mohassan/skills';
import { migrate } from '@mohassan/database';
import { migrateAuth } from '../apps/server/src/auth.ts';
import { createSkillBenchmarkRunner } from '../apps/server/src/skill-benchmark-runner.ts';
import { BENCHMARK_OWNER, benchmarkReceipt, createBenchmarkDatabase, grantBenchmarkRoot, initializeBenchmarkClone, prepareBenchmarkRoot, startBenchmarkTask, tickBenchmarkTask, verifyBenchmarkInstruction } from '../apps/server/src/skill-benchmark-isolation.ts';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { SkillBenchmarkSuiteSchema, type SkillBenchmarkSnapshot, type SkillBenchmarkCaseResult } from '../packages/contracts/src/skill-benchmarks.ts';
import { BENCHMARK_ASCII, BENCHMARK_BEFORE, BENCHMARK_UNICODE, getSkillBenchmarkSuite } from '../packages/skills/src/benchmark-suites.ts';

describe('trusted isolated candidate benchmark runner', () => {
  let store: Awaited<ReturnType<typeof createBenchmarkDatabase>>, owner: string;
  let instruction: SkillBenchmarkSnapshot, reader: SkillBenchmarkSnapshot, writer: SkillBenchmarkSnapshot;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Live services are forbidden in the benchmark fixture.'); });
  const field = (name: string, type: string) => ({ name, type, description: `Fixture ${name}` });
  async function source(contract: SkillContract, folder = 'instruction') {
    const content = await readFile(resolve('tests/fixtures/skills/benchmarks', folder, 'SKILL.md'), 'utf8');
    const id = randomUUID(), family = randomUUID(), hash = skillContentHash(contract, [{ path: 'SKILL.md', content }]);
    await store.db.insertInto('skill_families').values({ id: family, owner_id: owner, slug: contract.slug }).execute();
    await store.db.insertInto('skill_versions').values({ id, family_id: family, owner_id: owner, version: contract.version, sequence: 1, name: contract.name, description: contract.description, category: contract.category, level: contract.level, origin: 'forge', status: 'quarantined', content_hash: hash, contract: JSON.stringify(contract) }).execute();
    await store.db.insertInto('skill_files').values({ version_id: id, path: 'SKILL.md', kind: 'instructions', content, content_hash: sha256(content), size_bytes: Buffer.byteLength(content) }).execute();
    const control = createSkillControl(store.db), inspected = (await control.inspect(owner, id, { expectedRevision: 1 })).skill;
    const inspection = await store.db.selectFrom('skill_inspections').selectAll().where('version_id', '=', id).executeTakeFirstOrThrow();
    return { pin: { versionId: id, revision: inspected.revision, contentHash: hash, inspectionId: inspection.id, inspectorVersion: inspection.inspector_version }, contract, files: [{ path: 'SKILL.md', kind: 'instructions' as const, content, contentHash: sha256(content), sizeBytes: Buffer.byteLength(content) }] } satisfies SkillBenchmarkSnapshot;
  }
  beforeAll(async () => {
    store = await createBenchmarkDatabase(); await migrateAuth(store.db); await migrate(store.db); await skillsMigration(store.db); owner = randomUUID();
    await store.db.insertInto('user').values({ id: owner, name: 'Independent benchmark source owner', email: 'benchmark-source@example.test' }).execute();
    instruction = await source(SkillContractSchema.parse({ slug: 'benchmark-guidance', name: 'Benchmark guidance', description: 'Explain observed evidence with its original source identifiers.', category: 'documents', version: '1.0.0', level: 'instruction' }));
    for (const mode of ['read', 'write'] as const) {
      const inputs = mode === 'read' ? [field('root', 'file'), field('path', 'file')] : [field('root', 'file'), field('path', 'file'), field('content', 'string'), field('expectedHash', 'json')];
      const contract = SkillContractSchema.parse({ slug: `benchmark-file-${mode === 'read' ? 'reader' : 'writer'}`, name: `Benchmark file ${mode}`, description: 'Use only the independently approved temporary report path.', category: 'documents', version: '1.0.0', level: 'tool', inputs, outputs: [field('hash', 'string')], requires: { tools: [`file.${mode}`], paths: ['reports'] }, sideEffects: mode === 'read' ? 'read' : 'write_local', rollback: { mode: mode === 'read' ? 'none' : 'restore_preimage' }, verification: 'Verify exact independently prepared report bytes and its original hash.', steps: [{ id: mode, title: `Bounded ${mode}`, kind: 'tool', tool: `file.${mode}`, inputs: Object.fromEntries(inputs.map(item => [item.name, `input.${item.name}`])), outputs: [field('hash', 'string')] }] });
      if (mode === 'read') reader = await source(contract, 'file-read'); else writer = await source(contract, 'file-write');
    }
  }, 60000);
  afterAll(async () => { await store?.close(); fetch.mockRestore(); });
  async function run(snapshot: SkillBenchmarkSnapshot, suiteId: string, arm: 'baseline' | 'candidate' = 'candidate', signal = new AbortController().signal) {
    const results: SkillBenchmarkCaseResult[] = [], suite = SkillBenchmarkSuiteSchema.parse(getSkillBenchmarkSuite(suiteId));
    await createSkillBenchmarkRunner().execute({ benchmarkRunId: randomUUID(), arm, snapshot, suite, signal }, async result => { results.push(result); });
    return results;
  }
  it('pins fixed independent fixture bytes before evaluating a candidate', async () => {
    const expected = JSON.parse(await readFile(resolve('tests/fixtures/skills/benchmarks/oracles.json'), 'utf8'));
    expect([BENCHMARK_ASCII, BENCHMARK_UNICODE, BENCHMARK_BEFORE]).toEqual([expected.ascii, expected.unicode, expected.before]);
    const suites = ['instruction-delivery-v1', 'file-read-correctness-v1', 'file-write-correctness-v1'].map(id => SkillBenchmarkSuiteSchema.parse(getSkillBenchmarkSuite(id)));
    expect(suites.every(suite => suite.independentHoldout && suite.cases.some(item => item.split === 'holdout') && suite.cases.some(item => item.split === 'training'))).toBe(true);
  });
  it('measures instruction delivery and protection without semantic-quality or recovery claims', async () => {
    const before = await store.db.selectFrom('skill_versions').selectAll().where('id', '=', instruction.pin.versionId).executeTakeFirstOrThrow();
    const results = await run(instruction, 'instruction-delivery-v1');
    expect(results.map(result => [result.caseId, result.status, result.reasonCode])).toEqual(expect.arrayContaining([['delivery-normal', 'passed', null], ['delivery-bounded', 'passed', null], ['delivery-content-changed', 'passed', null], ['delivery-revoked', 'passed', null]]));
    expect(results.every(result => result.sourceContentHash === instruction.pin.contentHash && result.sourceVersionId === instruction.pin.versionId && result.scope === 'instruction_delivery' && result.metrics.recovery === null && result.metrics.costUsd === null && result.durationMs >= 0 && result.evidence.every(item => !item.receiptId && item.outputHash))).toBe(true);
    expect(await store.db.selectFrom('skill_versions').selectAll().where('id', '=', instruction.pin.versionId).executeTakeFirstOrThrow()).toEqual(before);
    expect(before).toMatchObject({ origin: 'forge', status: 'inspected' }); expect(await store.db.selectFrom('skill_grants').selectAll().execute()).toEqual([]);
  }, 60000);
  it('uses actual file.read receipts and independently checks grant and path rejection', async () => {
    const results = await run(reader, 'file-read-correctness-v1', 'baseline');
    expect(results.map(result => [result.caseId, result.status, result.reasonCode])).toEqual([['read-ascii', 'passed', null], ['read-unicode', 'passed', null], ['read-without-grant', 'passed', null], ['read-outside-declaration', 'passed', null]]);
    expect(results.slice(0, 2).every(result => result.evidence[0].receiptId && result.evidence[0].taskId && result.evidence[0].runId)).toBe(true); expect(fetch).not.toHaveBeenCalled();
  }, 60000);
  it('measures real file writes, confirmed rollback and a killed-worker recovery without another dispatch', async () => {
    const results = await run(writer, 'file-write-correctness-v1');
    expect(results.map(result => [result.caseId, result.status, result.reasonCode])).toEqual(getSkillBenchmarkSuite('file-write-correctness-v1')!.cases.map(item => [item.id, 'passed', null]));
    const recovered = results.find(result => result.caseId === 'write-confirmed-crash')!;
    expect(recovered.metrics).toMatchObject({ success: true, verification: true, safety: true, recovery: true, costUsd: null });
    expect(recovered.evidence[0]).toMatchObject({ receiptId: expect.any(String), taskId: expect.any(String), runId: expect.any(String), outputHash: expect.any(String) });
    expect(results.filter(result => result.caseId !== recovered.caseId).every(result => result.metrics.recovery === null)).toBe(true); expect(fetch).not.toHaveBeenCalled();
  }, 120000);
  it('rejects changed snapshot bytes and client-selected fixture metadata before executing any case', async () => {
    const changed = structuredClone(instruction); changed.files[0].content += '\nUninspected content.';
    await expect(run(changed, 'instruction-delivery-v1')).rejects.toThrow('BENCHMARK_SOURCE_HASH_MISMATCH');
    const suite = SkillBenchmarkSuiteSchema.parse(getSkillBenchmarkSuite('instruction-delivery-v1')); suite.cases[0].fixtureHash = '0'.repeat(64);
    const result = vi.fn(); await expect(createSkillBenchmarkRunner().execute({ benchmarkRunId: randomUUID(), arm: 'candidate', snapshot: instruction, suite, signal: new AbortController().signal }, result)).rejects.toThrow('BENCHMARK_SUITE_CHANGED'); expect(result).not.toHaveBeenCalled();
  });
  it('rejects substituted or missing delivered text even when provenance metadata remains correct', async () => {
    const base = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(base, 'mohassan-benchmark-oracle-'))), isolated = await createBenchmarkDatabase();
    try {
      const clone = await initializeBenchmarkClone(isolated.db, directory, instruction), context = await clone.skills.loadInstruction(BENCHMARK_OWNER, clone.versionId, 4000);
      expect(verifyBenchmarkInstruction(instruction, context, clone.versionId, 4000)).toBe(true);
      for (const replacement of ['', 'Unrelated substituted instructions.']) { const changed = structuredClone(context), envelope = JSON.parse(changed.text); envelope.skills[0].sources[0].text = replacement; changed.text = JSON.stringify(envelope); expect(verifyBenchmarkInstruction(instruction, changed, clone.versionId, 4000)).toBe(false); }
      const changed = structuredClone(context), envelope = JSON.parse(changed.text); envelope.skills[0].sources[0].truncated = true; changed.sources[0].truncated = true; changed.text = JSON.stringify(envelope); expect(verifyBenchmarkInstruction(instruction, changed, clone.versionId, 4000)).toBe(false);
      await clone.runtime.stop();
    } finally { await isolated.close(); const target = await realpath(directory), inside = relative(base, target); if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-benchmark-oracle-')) throw new Error('Unsafe benchmark oracle fixture cleanup'); await rm(target, { recursive: true, force: true }); }
  }, 60000);
  it('blocks an unsupported browser contract and never upgrades it into a passing local tool result', async () => {
    const unsupported = await source(SkillContractSchema.parse({ slug: 'unsupported-browser-benchmark', name: 'Unsupported browser benchmark', description: 'A browser operation is deliberately outside the local file suite.', category: 'browser', version: '1.0.0', level: 'tool', inputs: [field('url', 'url')], outputs: [field('text', 'string')], requires: { tools: ['browser.open'] }, sideEffects: 'read', verification: 'Require an actual independently persisted browser observation.', steps: [{ id: 'open', kind: 'tool', tool: 'browser.open', title: 'Open browser', inputs: { url: 'input.url' }, outputs: [field('text', 'string')] }] }));
    const results = await run(unsupported, 'file-write-correctness-v1'); expect(results.every(result => result.status === 'blocked' && result.metrics.success !== true && result.outputHash === null && result.evidence.length === 0)).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects changed task binding or node lease on an actual completed receipt', async () => {
    const base = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(base, 'mohassan-benchmark-proof-'))), isolated = await createBenchmarkDatabase();
    try {
      const clone = await initializeBenchmarkClone(isolated.db, directory, writer), root = await prepareBenchmarkRoot(directory, 'proof');
      await writeFile(join(root, 'reports', 'result.txt'), BENCHMARK_BEFORE); await grantBenchmarkRoot(clone, clone.versionId, root, 'file.write');
      const parent = await startBenchmarkTask(clone, clone.versionId, writer.contract, { root, path: 'reports/result.txt', content: BENCHMARK_UNICODE, expectedHash: sha256(BENCHMARK_BEFORE) });
      expect((await tickBenchmarkTask(isolated.db, clone, parent.id, new AbortController().signal)).status).toBe('completed');
      const receipt = await benchmarkReceipt(isolated.db, parent.id, writer), binding = typeof receipt.row.skill_binding === 'string' ? JSON.parse(receipt.row.skill_binding) : receipt.row.skill_binding;
      try {
        await isolated.db.updateTable('tasks').set({ skill_binding: JSON.stringify({ ...binding, inputsHash: '0'.repeat(64) }) }).where('id', '=', receipt.row.task_id).execute();
        await expect(benchmarkReceipt(isolated.db, parent.id, writer)).rejects.toThrow('BENCHMARK_VERIFIED_RECEIPT_CHANGED');
        await isolated.db.updateTable('tasks').set({ skill_binding: JSON.stringify(binding) }).where('id', '=', receipt.row.task_id).execute();
        await isolated.db.updateTable('skill_run_nodes').set({ lease_token: randomUUID() }).where('run_id', '=', receipt.row.run_id).where('node_id', '=', receipt.row.node_id).execute();
        await expect(benchmarkReceipt(isolated.db, parent.id, writer)).rejects.toThrow('BENCHMARK_VERIFIED_RECEIPT_CHANGED');
      } finally {
        await isolated.db.updateTable('tasks').set({ skill_binding: JSON.stringify(binding) }).where('id', '=', receipt.row.task_id).execute();
        await isolated.db.updateTable('skill_run_nodes').set({ lease_token: receipt.row.current_node_lease }).where('run_id', '=', receipt.row.run_id).where('node_id', '=', receipt.row.node_id).execute();
      }
      expect((await benchmarkReceipt(isolated.db, parent.id, writer)).row.id).toBe(receipt.row.id); await clone.runtime.stop();
    } finally { await isolated.close(); const target = await realpath(directory), inside = relative(base, target); if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-benchmark-proof-')) throw new Error('Unsafe benchmark proof fixture cleanup'); await rm(target, { recursive: true, force: true }); }
  }, 60000);
  it('records cancellation as unknown without claiming execution or recovery', async () => {
    const controller = new AbortController(); controller.abort(); const results = await run(writer, 'file-write-correctness-v1', 'candidate', controller.signal);
    expect(results.every(result => result.status === 'unknown' && result.metrics.success === null && result.metrics.recovery === null && result.outputHash === null)).toBe(true);
  });
  it('cleans its owned temporary root when the durable observation callback rejects', async () => {
    const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('mohassan-benchmark-')));
    await expect(createSkillBenchmarkRunner().execute({ benchmarkRunId: randomUUID(), arm: 'candidate', snapshot: instruction, suite: SkillBenchmarkSuiteSchema.parse(getSkillBenchmarkSuite('instruction-delivery-v1')), signal: new AbortController().signal }, async () => { throw new Error('Injected persistence rejection'); })).rejects.toThrow('Injected persistence rejection');
    expect((await readdir(tmpdir())).filter(name => name.startsWith('mohassan-benchmark-') && !before.has(name))).toEqual([]);
  }, 60000);
  it('cancels the owned crash worker and records unknown recovery while cleaning the isolated resources', async () => {
    const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('mohassan-benchmark-'))), controller = new AbortController(), results: SkillBenchmarkCaseResult[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await createSkillBenchmarkRunner().execute({ benchmarkRunId: randomUUID(), arm: 'candidate', snapshot: writer, suite: SkillBenchmarkSuiteSchema.parse(getSkillBenchmarkSuite('file-write-correctness-v1')), signal: controller.signal }, async result => {
        results.push(result); if (result.caseId === 'write-confirmed-rollback') timer = setTimeout(() => controller.abort(), 200);
      });
    } finally { clearTimeout(timer); }
    const last = results.at(-1)!; expect(last.caseId).toBe('write-confirmed-crash'); expect(last.status).toBe('unknown'); expect(last.metrics.recovery).toBe(null);
    expect((await readdir(tmpdir())).filter(name => name.startsWith('mohassan-benchmark-') && !before.has(name))).toEqual([]);
  }, 60000);
});
