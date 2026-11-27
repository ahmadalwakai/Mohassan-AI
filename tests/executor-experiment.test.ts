import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutorControl, executorConfigFromEnv, verifyJsonCandidate, type ExecutorConfig, type ExecutorDependencies } from '../apps/server/src/executor.js';
import { ModelTransportError, type LocalModelProcessConfig, type ModelCandidateResponse, type ModelTaskSubmission, type ModelTransport } from '../packages/execution-integration/src/transport.js';

/**
 * Adapter behaviour only. The transport is a fake: nothing here loads weights or proves
 * that the real model can do anything. Real inference is recorded separately.
 */
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
let root: string;
let checkpoint: string;
let registry: string;

async function writeCheckpoint(tokenizerIdentity = 'a'.repeat(64)) {
  const weights = Buffer.from('fake weights for adapter tests');
  await writeFile(join(checkpoint, 'weights.pt'), weights);
  await writeFile(join(checkpoint, 'tokenizer.json'), '{}');
  await writeFile(join(checkpoint, 'config.json'), JSON.stringify({ vocab_size: 300, num_layers: 2, hidden_size: 16, num_heads: 2, max_context_length: 256 }));
  const manifest = JSON.stringify({ architecture: 'dense-decoder-v1', config_identity: 'c'.repeat(64), format: 'mohassan-execution-checkpoint', initialization_seed: 1, tokenizer_identity: tokenizerIdentity, training_status: 'unverified', version: 1, weights_sha256: sha(weights) });
  await writeFile(join(checkpoint, 'manifest.json'), manifest);
  return sha(manifest);
}

async function writeRegistry(tokenizerIdentity = 'a'.repeat(64)) {
  await writeFile(registry, JSON.stringify({ model_version: 'exec-test-1', architecture_identity: 'dense-decoder-v1', tokenizer_version: { identity: tokenizerIdentity, vocabulary_size: 300 }, training_provenance: { initialization: 'random' }, evaluation_status: 'not_evaluated', promotion_status: 'unpromoted' }));
  await writeFile(registry.replace(/\.json$/, '.evaluation.json'), JSON.stringify({ evaluation_status: 'failed', promotion_status: 'unpromoted', attestation: { passed: false } }));
}

function config(overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return { enabled: true, checkpointDir: checkpoint, registryEntry: registry, python: join(root, 'python.exe'), packageDir: root, device: 'cpu',
    startupTimeoutMs: 5000, requestTimeoutMs: 5000, root, ...overrides };
}

/** Ollama is down for every test unless a test says otherwise: the executor must not need it. */
const ollamaDown: typeof fetch = async () => { throw new TypeError('connect ECONNREFUSED 127.0.0.1:11434'); };

function fakeTransport(reply: (request: ModelTaskSubmission, signal: AbortSignal) => Promise<ModelCandidateResponse>) {
  const submitted: ModelTaskSubmission[] = [];
  const configs: LocalModelProcessConfig[] = [];
  const factory = (processConfig: LocalModelProcessConfig): ModelTransport => {
    configs.push(processConfig);
    return {
      discover: async () => ({ protocol: 'mohassan.execution.local.v1', identity: processConfig.identity, capabilities: ['json.transform.v1:integers-to-strings'], maxInputBytes: 65536, maxOutputTokens: 96 }),
      submit: async (request, signal) => { submitted.push(request); return reply(request, signal); },
    };
  };
  return { factory, submitted, configs };
}
const candidate = (text: string) => async (request: ModelTaskSubmission): Promise<ModelCandidateResponse> =>
  ({ requestId: request.requestId, taskId: request.taskId, identity: { modelId: 'm', tokenizerId: 't', checkpointId: 'c' }, status: 'candidate', proposal: { text, generationMs: 12, stopReason: 'eos' }, outputTokens: 5 });

function control(dependencies: Partial<ExecutorDependencies> & { config?: ExecutorConfig } = {}) {
  return createExecutorControl({ config: dependencies.config ?? config(), fetch: dependencies.fetch ?? ollamaDown, ...dependencies });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mohassan-executor-test-'));
  checkpoint = join(root, 'checkpoint');
  registry = join(root, 'exec-test-1.json');
  await import('node:fs/promises').then(fs => fs.mkdir(checkpoint));
  await writeFile(join(root, 'python.exe'), '');
  await writeRegistry();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('executor experiment configuration', () => {
  it('stays off unless explicitly opted in, and always off in production', () => {
    expect(executorConfigFromEnv({}, 'C:\\repo', false).enabled).toBe(false);
    expect(executorConfigFromEnv({ EXECUTOR_EXPERIMENT: 'uncontained-local' }, 'C:\\repo', false).enabled).toBe(true);
    expect(executorConfigFromEnv({ EXECUTOR_EXPERIMENT: 'uncontained-local' }, 'C:\\repo', true).enabled).toBe(false);
    expect(executorConfigFromEnv({ EXECUTOR_EXPERIMENT: 'yes' }, 'C:\\repo', false).enabled).toBe(false);
  });

  it('a disabled experiment never builds a transport', async () => {
    const transport = fakeTransport(candidate('{}'));
    const executor = control({ config: config({ enabled: false }), transport: transport.factory });
    expect((await executor.status()).executor.state).toBe('disabled');
    expect((await executor.run({ runId: randomUUID(), mode: 'direct', capability: 'json.transform.v1:integers-to-strings', fields: { values: [1] } })).status).toBe('disabled');
    expect(transport.configs).toHaveLength(0);
  });
});

describe('checkpoint verification', () => {
  it('reports a missing checkpoint without starting anything', async () => {
    const transport = fakeTransport(candidate('{}'));
    const executor = control({ transport: transport.factory });
    expect((await executor.status()).executor).toMatchObject({ state: 'checkpoint_missing' });
    expect((await executor.run({ runId: randomUUID(), mode: 'direct', capability: 'json.transform.v1:integers-to-strings', fields: { values: [1] } })).status).toBe('checkpoint_missing');
    expect(transport.submitted).toHaveLength(0);
  });

  it('refuses weights that do not match the manifest', async () => {
    await writeCheckpoint();
    await writeFile(join(checkpoint, 'weights.pt'), 'tampered');
    expect((await control().status()).executor).toMatchObject({ state: 'checkpoint_incompatible', reason: 'weights_hash_mismatch' });
  });

  it('refuses a tokenizer identity that differs from the registry entry', async () => {
    await writeCheckpoint('a'.repeat(64));
    await writeRegistry('b'.repeat(64));
    expect((await control().status()).executor).toMatchObject({ state: 'checkpoint_incompatible', reason: 'tokenizer_mismatch' });
  });

  it('reports a missing Python runtime separately', async () => {
    await writeCheckpoint();
    expect((await control({ config: config({ python: join(root, 'missing.exe') }) }).status()).executor).toMatchObject({ state: 'runtime_missing' });
  });

  it('pins the worker to the verified identities and passes no Ollama address', async () => {
    const checkpointId = await writeCheckpoint();
    const transport = fakeTransport(candidate('{"values":["1"]}'));
    const executor = control({ transport: transport.factory });
    const state = await executor.status();
    expect(state.executor).toMatchObject({ state: 'available', checkpoint: { modelVersion: 'exec-test-1', checkpointId, evaluation: { status: 'failed', passed: false, promotion: 'unpromoted' } } });
    expect(await executor.check(new AbortController().signal)).toMatchObject({ status: 'loaded' });
    const args = transport.configs[0]!.args.join(' ');
    expect(args).toContain(`--checkpoint-id sha256:${checkpointId}`);
    expect(args).toContain('--device cpu');
    expect(args).not.toMatch(/11434|ollama/i);
  });
});

describe('direct executor runs', () => {
  it('works while Ollama is down, calls no reasoning provider, and records the candidate as produced', async () => {
    await writeCheckpoint();
    const transport = fakeTransport(candidate('{"values":["7","-42"]}'));
    const extract = vi.fn();
    const executor = control({ transport: transport.factory, reasoning: { status: async () => ({ provider: 'fixture-reasoning', configured: true, available: true, model: 'x', message: '' }), extract } });
    const status = await executor.status();
    expect(status.ollama.status).toBe('unreachable');
    const result = await executor.run({ runId: randomUUID(), mode: 'direct', capability: 'json.transform.v1:integers-to-strings', fields: { values: [7, -42] } });
    expect(result).toMatchObject({ status: 'candidate', external: [], candidate: { text: '{"values":["7","-42"]}' }, verification: { status: 'passed' }, executor: { called: true, contained: false } });
    expect(extract).not.toHaveBeenCalled();
    expect(transport.submitted[0]).toMatchObject({ capability: 'json.transform.v1:integers-to-strings', contract: { fields: { values: [7, -42] } }, maxOutputTokens: 96 });
  });

  it('reports an empty Ollama model list as its own state while the executor stays available', async () => {
    await writeCheckpoint();
    const fetchEmpty: typeof fetch = async input => Response.json(String(input).endsWith('/api/tags') ? { models: [] } : { version: '0.12.0' });
    const status = await control({ fetch: fetchEmpty, transport: fakeTransport(candidate('{}')).factory }).status();
    expect(status.ollama).toMatchObject({ status: 'no_models' });
    expect(status.executor.state).toBe('available');
  });

  it('marks a wrong candidate as rejected, never as verified', async () => {
    await writeCheckpoint();
    const executor = control({ transport: fakeTransport(candidate('{"values":["7"]}')).factory });
    const result = await executor.run({ runId: randomUUID(), mode: 'direct', capability: 'json.transform.v1:integers-to-strings', fields: { values: [7, -42] } });
    expect(result).toMatchObject({ status: 'candidate', verification: { status: 'rejected' } });
  });

  it('collects council advice on validated direct tasks without changing the verified candidate', async () => {
    await writeCheckpoint();
    const values = [7, -42];
    const text = JSON.stringify({ values: values.map(String) });
    const record = { version: 1 as const, chosen: 'pipeline', changed: false, reason: 'Advice recorded', elapsedMs: 0, members: [] };
    const deliberate = vi.fn(async () => ({ text, status: 'completed' as const, chosen: 'pipeline', changed: false, council: record }));
    const executor = control({ transport: fakeTransport(candidate(text)).factory, council: () => ({ deliberate }) });
    const capability = 'json.transform.v1:integers-to-strings';
    const result = await executor.run({ runId: randomUUID(), mode: 'direct', capability, fields: { values } });
    expect(result).toMatchObject({ candidate: { text }, verification: { status: 'passed' }, council: record });
    expect(deliberate).toHaveBeenCalledWith(expect.objectContaining({
      advisory: true, codeTask: { capability, fields: { values } }, pipeline: { text, status: 'completed' },
    }));
  });

  it('stops on missing context before calling the model', async () => {
    await writeCheckpoint();
    const transport = fakeTransport(candidate('{}'));
    const result = await control({ transport: transport.factory }).run({ runId: randomUUID(), mode: 'direct', capability: 'json.check.v1:inclusive-interval', fields: { value: 3, minimum: 1 } });
    expect(result).toMatchObject({ status: 'missing_context', missingContextKeys: ['maximum'], executor: { called: false } });
    expect(transport.submitted).toHaveLength(0);
  });

  it('returns unsupported for an unknown capability and for values the worker rejects', async () => {
    await writeCheckpoint();
    const transport = fakeTransport(async request => ({ requestId: request.requestId, taskId: request.taskId, identity: { modelId: 'm', tokenizerId: 't', checkpointId: 'c' }, status: 'unsupported', capability: request.capability }));
    const executor = control({ transport: transport.factory });
    expect((await executor.run({ runId: randomUUID(), mode: 'direct', capability: 'shell.exec', fields: {} })).status).toBe('unsupported');
    expect((await executor.run({ runId: randomUUID(), mode: 'direct', capability: 'json.transform.v1:integers-to-strings', fields: { values: [99999] } })).status).toBe('unsupported');
  });

  it('maps a worker timeout and a process failure without retrying', async () => {
    await writeCheckpoint();
    const timeout = fakeTransport(async () => { throw new ModelTransportError('timeout'); });
    expect((await control({ transport: timeout.factory }).run({ runId: randomUUID(), mode: 'direct', capability: 'json.transform.v1:integers-to-strings', fields: { values: [1] } })).status).toBe('timeout');
    expect(timeout.submitted).toHaveLength(1);
    const crash = fakeTransport(async () => { throw new ModelTransportError('model_process_failure'); });
    expect((await control({ transport: crash.factory }).run({ runId: randomUUID(), mode: 'direct', capability: 'json.transform.v1:integers-to-strings', fields: { values: [1] } })).status).toBe('process_failure');
    expect(crash.submitted).toHaveLength(1);
  });

  it('cancels a running task and releases the executor', async () => {
    await writeCheckpoint();
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const transport = fakeTransport((_request, signal) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(new ModelTransportError('cancelled')), { once: true });
    }));
    const executor = control({ transport: transport.factory });
    const runId = randomUUID();
    const pending = executor.run({ runId, mode: 'direct', capability: 'json.transform.v1:integers-to-strings', fields: { values: [1] } });
    await begun;
    expect((await executor.status()).executor.busy).toBe(true);
    expect(executor.cancel(runId)).toBe(true);
    expect((await pending).status).toBe('cancelled');
    expect((await executor.status()).executor.busy).toBe(false);
    expect(executor.cancel(runId)).toBe(false);
  });

  it('never runs TypeScript outside an isolation boundary', async () => {
    await writeCheckpoint();
    const run = vi.fn();
    const executor = control({ transport: fakeTransport(candidate('export function f(value){return 0}')).factory,
      sandbox: { available: async () => ({ available: false, provider: null, message: 'off' }), run } });
    const result = await executor.run({ runId: randomUUID(), mode: 'direct', capability: 'typescript.implement.v1:null-safe-delta', fields: { function_name: 'f', increment: 1 } });
    expect(result).toMatchObject({ status: 'candidate', verification: { status: 'unavailable' } });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('assisted runs keep reasoning separate', () => {
  it('refuses the assisted mode when no reasoning provider is available, without a silent fallback', async () => {
    await writeCheckpoint();
    const transport = fakeTransport(candidate('{}'));
    const result = await control({ transport: transport.factory }).run({ runId: randomUUID(), mode: 'assisted', capability: 'json.check.v1:inclusive-interval', request: 'هل 5 بين 1 و9؟' });
    expect(result).toMatchObject({ status: 'reasoning_unavailable', external: [], executor: { called: false } });
    expect(transport.submitted).toHaveLength(0);
  });

  it('records the reasoning call, then lets the local model produce the answer', async () => {
    await writeCheckpoint();
    const transport = fakeTransport(candidate('{"within":true}'));
    const extract = vi.fn(async () => ({ text: '{"value":5,"minimum":1,"maximum":9}', model: 'fixture-reasoning-model', usage: { inputTokens: 80, outputTokens: 12 }, provider: 'fixture-reasoning' }));
    const result = await control({ transport: transport.factory, reasoning: { status: async () => ({ provider: 'fixture-reasoning', configured: true, available: true, model: 'fixture-reasoning-model', message: '' }), extract } })
      .run({ runId: randomUUID(), mode: 'assisted', capability: 'json.check.v1:inclusive-interval', request: 'هل 5 بين 1 و9؟' });
    expect(result).toMatchObject({ status: 'candidate', candidate: { text: '{"within":true}' }, verification: { status: 'passed' },
      external: [{ provider: 'fixture-reasoning', model: 'fixture-reasoning-model', purpose: 'field_extraction', inputTokens: 80, outputTokens: 12 }] });
    expect(transport.submitted[0]!.contract).toEqual({ fields: { value: 5, minimum: 1, maximum: 9 } });
  });
});

describe('independent JSON predicates', () => {
  it('accepts only exact canonical answers', () => {
    expect(verifyJsonCandidate('json.transform.v1:integers-to-strings', { values: [0, -5] }, '{"values":["0","-5"]}').status).toBe('passed');
    for (const text of ['{"values":["00","-5"]}', '{"values":[0,-5]}', '{"values":["0"]}', '{"values":["0","-5"],"x":1}', 'not json'])
      expect(verifyJsonCandidate('json.transform.v1:integers-to-strings', { values: [0, -5] }, text).status).toBe('rejected');
    expect(verifyJsonCandidate('json.check.v1:inclusive-interval', { value: 9, minimum: 1, maximum: 9 }, '{"within":true}').status).toBe('passed');
    expect(verifyJsonCandidate('json.check.v1:inclusive-interval', { value: 10, minimum: 1, maximum: 9 }, '{"within":true}').status).toBe('rejected');
    expect(verifyJsonCandidate('json.check.v1:inclusive-interval', { value: 5, minimum: 1, maximum: 9 }, '{"within":"true"}').status).toBe('rejected');
  });
});
