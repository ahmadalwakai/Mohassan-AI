import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillContractSchema } from '@mohassan/contracts';
import { WindowsAppContainerSandbox } from '@mohassan/sandbox';
import { createScriptExecutor, createSkillControl, createSkillScheduler, createToolGateway, hashSkillData, sha256, type SkillScriptSandbox } from '@mohassan/skills';
import type { SkillGatewayContext } from '../packages/skills/src/gateway.ts';
import { executionFixture } from './helpers/skill-execution.ts';

/**
 * A stand-in sandbox. It proves the engine around a script: authority, evidence and failure handling.
 * It proves nothing about isolation, and these tests are not scenario B.
 */
const SCRIPT = 'import fs from "node:fs";fs.writeFileSync(process.env.MOHASSAN_OUTPUT_DIR+"/result.json","{}");\n';
const ALL = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'].map(id => ({ id, status: 'verified' }));
const success = { exitCode: 0, timedOut: false, durationMs: 12, provider: 'stand-in', isolation: 'appcontainer', network: 'denied' as const, isolationVerified: true, snapshotHash: 'a'.repeat(64), stdout: 'out', stderr: '', outputManifestHash: 'b'.repeat(64) };
const output = (content: string) => [{ path: 'result.json', content, bytes: Buffer.byteLength(content), sha256: sha256(content) }];
function standIn(run: Partial<typeof success> & { outputs?: ReturnType<typeof output> } = {}) {
  const state = { enabled: true };
  const runScript = vi.fn(async () => ({ ...success, outputs: output('{"summary":"3 rows"}'), ...run }));
  const sandbox: SkillScriptSandbox = { runScript, executableReadiness: async () => ({ enabled: state.enabled, provider: 'stand-in', gates: ALL }) };
  return { sandbox, runScript, state };
}

const contracts = () => SkillContractSchema.parse({
  slug: `script-${randomUUID().slice(0, 8)}`, name: 'CSV profile fixture', description: 'Profile a small CSV inside the sandbox for engine tests.', version: '1.0.0', category: 'analytics', level: 'executable', sideEffects: 'none',
  inputs: [{ name: 'text', type: 'string', description: 'CSV text' }], outputs: [{ name: 'summary', type: 'string', description: 'Row summary' }],
  execution: { timeoutMs: 1000, memoryMb: 64, outputMaxBytes: 2048 },
  steps: [{ id: 'run', kind: 'script', title: 'Profile rows', entry: 'main.mjs', inputs: { text: 'input.text' }, outputs: [{ name: 'summary', type: 'string', description: 'Row summary' }] }],
  verification: 'The receipt must match the stored script and the declared output.',
});

let f: Awaited<ReturnType<typeof executionFixture>> | undefined, directory: string | undefined;
afterEach(async () => { await f?.store.close(); f = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

async function prepared(sandbox: SkillScriptSandbox) {
  f = await executionFixture(); directory = await realpath(await mkdtemp(join(tmpdir(), 'mohassan-script-engine-')));
  const fixture = f, contract = contracts(), folder = join(directory, contract.slug), script = createScriptExecutor(sandbox);
  const skills = createSkillControl(fixture.store.db, { allowedRoots: [directory], executableReady: script.ready, environment: () => ({ capabilities: [], modelReady: false, visionReady: false, executableReady: true }) });
  await mkdir(folder);
  await writeFile(join(folder, 'main.mjs'), SCRIPT);
  await writeFile(join(folder, 'SKILL.md'), `---\nname: ${contract.slug}\ndescription: Profile a small CSV file for tests.\n---\nStored for engine tests.\n`);
  await writeFile(join(folder, 'skill.contract.json'), JSON.stringify(contract));
  const { skill } = await skills.importLocal(fixture.owner, { path: folder });
  const inspected = await skills.inspect(fixture.owner, skill.id, { expectedRevision: skill.revision });
  const active = await skills.activate(fixture.owner, skill.id, { expectedRevision: inspected.skill.revision, approve: true, acknowledgeFindings: true });
  const scheduler = createSkillScheduler(fixture.store.db, { validateComposition: skills.validateComposition, validateParentAuthority: fixture.validateParentAuthority, executableReady: script.ready });
  const gateway = createToolGateway(fixture.store.db, { scheduler, adapters: [], script });
  const input = { plan: { inputs: [{ name: 'text', type: 'string', description: 'CSV' }], nodes: [{ id: 'main', skillId: skill.id, inputs: { text: 'input.text' } }] }, values: { text: 'a,b\n1,2\n' } };
  const parent = await fixture.parent(input);
  const pending = await scheduler.runSkillGraph(parent.input, parent.context);
  if (pending.kind !== 'pending') throw new Error('pending');
  const child = await fixture.child(pending.runId, 'main.run');
  // The fixture's child row was written by a scheduler that must agree with this one.
  const context: SkillGatewayContext = { ...child.context, binding: child.binding, signal: new AbortController().signal, assertActive: async () => {} };
  const evidence = async () => {
    const rows = await fixture.store.db.selectFrom('skill_evidence').selectAll().where('run_id', '=', pending.runId).execute();
    return rows.flatMap(row => (typeof row.details === 'string' ? JSON.parse(row.details) : row.details) as { kind: string; data: any }[]);
  };
  const node = () => fixture.store.db.selectFrom('skill_run_nodes').selectAll().where('run_id', '=', pending.runId).executeTakeFirstOrThrow();
  return { fixture, skill: active.skill, scheduler, gateway, context, evidence, node, parent, pending };
}

describe('script nodes around a stand-in sandbox', () => {
  it('runs the stored snapshot with contract limits and records a receipt that verifies', async () => {
    const s = standIn(), p = await prepared(s.sandbox);
    const result = await p.gateway.executeNode(p.context);
    expect(s.runScript).toHaveBeenCalledOnce();
    expect(s.runScript.mock.calls[0]).toEqual([expect.objectContaining({ entry: 'main.mjs', inputJson: JSON.stringify({ text: 'a,b\n1,2\n' }), timeoutMs: 1000, memoryMb: 64, outputMaxBytes: 2048, files: expect.arrayContaining([{ path: 'main.mjs', content: SCRIPT }]) })]);
    const receipt = (await p.evidence()).find(entry => entry.kind === 'script.receipt')?.data;
    expect(receipt).toMatchObject({ scriptHash: sha256(SCRIPT), inputsHash: hashSkillData({ text: 'a,b\n1,2\n' }), resultHash: hashSkillData({ summary: '3 rows' }), exitCode: 0, timedOut: false, network: 'denied', gates: ALL.map(gate => gate.id) });
    expect(await p.gateway.verifyNode(result, p.context)).toEqual(result);
    expect(await p.gateway.verifyNode({ ...result, output: { summary: 'tampered' } }, p.context)).toBeNull();
  });

  it('never sends instruction files into the sandbox', async () => {
    const s = standIn(), p = await prepared(s.sandbox);
    await p.gateway.executeNode(p.context);
    const [input] = s.runScript.mock.calls[0] as unknown as [{ files: { path: string }[] }];
    expect(input.files.map(file => file.path)).not.toContain('SKILL.md');
  });

  it('starts nothing when a gate closes between planning and dispatch', async () => {
    const s = standIn(), p = await prepared(s.sandbox);
    s.state.enabled = false;
    await expect(p.gateway.executeNode(p.context)).rejects.toMatchObject({ code: 'SKILL_SANDBOX_UNVERIFIED' });
    expect(s.runScript).not.toHaveBeenCalled();
    expect(await p.evidence()).toEqual([]);
  });

  it('refuses a one-byte change to the stored script before any run', async () => {
    const s = standIn(), p = await prepared(s.sandbox);
    await p.fixture.store.db.updateTable('skill_files').set({ content: `${SCRIPT} ` }).where('version_id', '=', p.skill.id).where('path', '=', 'main.mjs').execute();
    await expect(p.gateway.executeNode(p.context)).rejects.toMatchObject({ code: 'SKILL_INTEGRITY_FAILED' });
    expect(s.runScript).not.toHaveBeenCalled();
  });

  it.each([
    ['a failing exit code', { exitCode: 1 }, 'SKILL_SCRIPT_FAILED'],
    ['a timeout', { exitCode: 124, timedOut: true }, 'SKILL_SCRIPT_TIMEOUT'],
    ['a missing result file', { outputs: [] }, 'SKILL_SCRIPT_RESULT_MISSING'],
    ['a result that is not JSON', { outputs: output('not json') }, 'SKILL_SCRIPT_RESULT_INVALID'],
    ['a result that is not an object', { outputs: output('[1]') }, 'SKILL_SCRIPT_RESULT_INVALID'],
    ['unverified isolation', { isolationVerified: false }, 'SKILL_SCRIPT_ISOLATION_UNVERIFIED'],
  ])('records %s as a clean failure with its receipt', async (_name, run, code) => {
    const p = await prepared(standIn(run as never).sandbox);
    await expect(p.gateway.executeNode(p.context)).rejects.toMatchObject({ code });
    expect((await p.node()).status).toBe('failed');
    const entries = await p.evidence();
    expect(entries.some(entry => entry.kind === 'script.receipt')).toBe(true);
    expect(entries.find(entry => entry.kind === 'gateway.failure')?.data).toMatchObject({ effect: 'none', errorCode: code });
  });

  it('rejects an output the contract does not declare', async () => {
    const p = await prepared(standIn({ outputs: output('{"summary":"ok","extra":1}') }).sandbox);
    await expect(p.gateway.executeNode(p.context)).rejects.toThrow();
    expect((await p.node()).status).toBe('failed');
  });

  it('does not fall back to anything when the sandbox throws', async () => {
    const s = standIn(), p = await prepared(s.sandbox);
    s.runScript.mockRejectedValueOnce(Object.assign(new Error('no slot'), { code: 'SANDBOX_QUOTA_UNAVAILABLE' }));
    await expect(p.gateway.executeNode(p.context)).rejects.toMatchObject({ code: 'SANDBOX_QUOTA_UNAVAILABLE' });
    expect((await p.node()).status).toBe('failed');
    expect(s.runScript).toHaveBeenCalledOnce();
  });

  it('labels a finished run as isolated execution, never as a tool run', async () => {
    const s = standIn(), p = await prepared(s.sandbox);
    const result = await p.gateway.executeNode(p.context);
    expect(await p.gateway.verifyNode(result, p.context)).toEqual(result);
    await p.fixture.store.db.updateTable('tasks').set({ status: 'completed', result: JSON.stringify(result) }).where('id', '=', p.context.taskId).execute();
    const done = await p.scheduler.runSkillGraph(p.parent.input, p.parent.context);
    if (done.kind !== 'complete') throw new Error(`Expected a finished run, got ${done.kind}`);
    expect(done.result.receipts).toEqual([expect.objectContaining({ level: 'executable', execution: 'isolated_script', isolation: { provider: 'stand-in', verified: true, sharesHostKernel: true, network: 'denied' } })]);
  });
});

describe('the closed default', () => {
  it('a scheduler given no readiness refuses executable contracts', async () => {
    const p = await prepared(standIn().sandbox);
    const closed = createSkillScheduler(p.fixture.store.db, { validateComposition: async () => ({ valid: true, issues: [] }) as never, validateParentAuthority: p.fixture.validateParentAuthority });
    const parent = await p.fixture.parent(p.parent.input);
    await expect(closed.runSkillGraph(parent.input, parent.context)).rejects.toMatchObject({ code: 'SKILL_EXECUTABLE_GATES_CLOSED' });
  });

  it('a gateway given no script executor refuses script bindings', async () => {
    const s = standIn(), p = await prepared(s.sandbox);
    const closed = createToolGateway(p.fixture.store.db, { scheduler: p.scheduler, adapters: [] });
    await expect(closed.executeNode(p.context)).rejects.toMatchObject({ code: 'SKILL_SANDBOX_UNVERIFIED' });
    expect(s.runScript).not.toHaveBeenCalled();
  });

  it('a sandbox without a readiness report is never ready', async () => {
    expect(await createScriptExecutor({}).ready()).toBe(false);
    const broken: SkillScriptSandbox = { runScript: vi.fn(), executableReadiness: async () => { throw new Error('probe failed'); } };
    expect(await createScriptExecutor(broken).ready()).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('the real sandbox on this machine stays closed and refuses to run', async () => {
    const sandbox = new WindowsAppContainerSandbox({ quotaRoot: '' });
    await sandbox.available();
    const executor = createScriptExecutor(sandbox as SkillScriptSandbox);
    expect(await executor.ready()).toBe(false);
    await expect(executor.execute({ entry: 'main.mjs', inputs: {}, files: [{ path: 'main.mjs', kind: 'script', content: SCRIPT }], signal: new AbortController().signal })).rejects.toMatchObject({ code: 'SKILL_SANDBOX_UNVERIFIED' });
    await expect(sandbox.runScript({ files: [{ path: 'main.mjs', content: SCRIPT }], entry: 'main.mjs', inputJson: '{}' })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  }, 120_000);
});
