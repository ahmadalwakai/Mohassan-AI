import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_EXECUTION_REGISTRY, ExecutionResultValidator, ExecutionStrategyRouter, submitExecutionModelTask,
  type ExecutionModelIdentity,
} from '../packages/cognitive/src/execution-model/index.ts';
import { ExperimentalUncontainedWorkerTransport } from '../packages/execution-integration/src/experimental-worker-transport.ts';
import { TransportBackedExecutionModelAdapter } from '../packages/execution-integration/src/phase1-model-adapter.ts';
import { contract, countOutputTokens, eligibilitySnapshot, functionSource, routingContext, sha } from '../packages/execution-integration/src/phase1-contract-fixtures.ts';
import { LOCAL_MODEL_PROTOCOL, ModelTransportError, type ModelTaskSubmission, type ModelTransport } from '../packages/execution-integration/src/transport.ts';

const identity = { modelId: 'mohassan-exec-test', tokenizerId: 'sha256:' + 'a'.repeat(64), checkpointId: 'sha256:' + 'b'.repeat(64) };
const model: ExecutionModelIdentity = { id: 'mohassan-exec-test', version: 'v1', artifactHash: 'b'.repeat(64), initialization: 'random', locality: 'local' };
const capabilities = ['typescript.implement.v1:null-safe-delta', 'typescript.repair.v1:null-safe-delta'];

function fakeTransport(reply: (request: ModelTaskSubmission) => string | Error): ModelTransport & { requests: ModelTaskSubmission[] } {
  const requests: ModelTaskSubmission[] = [];
  return {
    requests,
    async discover() { return { protocol: LOCAL_MODEL_PROTOCOL, identity, capabilities, maxInputBytes: 65_536, maxOutputTokens: 96 }; },
    async submit(request) {
      requests.push(request);
      const value = reply(request);
      if (value instanceof Error) throw value;
      return { requestId: request.requestId, taskId: request.taskId, identity, status: 'candidate', proposal: { text: value }, outputTokens: 20 };
    },
  };
}

function adapterFor(transport: ModelTransport) {
  return new TransportBackedExecutionModelAdapter({ transport, model, responseLanguages: ['ar', 'en'],
    limits: { maxInputBytes: 262_144, maxOutputTokens: 4096, maxTimeoutMs: 120_000 } });
}

async function learned(adapter: TransportBackedExecutionModelAdapter) {
  return adapter.discoverCapabilities({ signal: new AbortController().signal, timeoutMs: 1000, deadlineAt: Date.now() + 1000 });
}

const stub = functionSource('offsetScore', '0');
const good = functionSource('offsetScore', 'value == null ? 0 : value + 4');
const implementTask = () => contract({ taskId: 'impl-1', family: 'typescript_implementation', target: 'delta.ts',
  files: { 'delta.ts': stub }, spec: { function_name: 'offsetScore', increment: 4 } });

describe('execution model integration (Phase 1 <-> Phase 5 <-> trained worker)', () => {
  it('keeps the deterministic registry limited to structured file replacement', () => {
    expect(DETERMINISTIC_EXECUTION_REGISTRY.map(entry => entry.operation)).toEqual(['structured.replace-file.v1']);
  });

  it('maps advertised worker capabilities onto exact Phase 1 task contracts', async () => {
    const advertised = await learned(adapterFor(fakeTransport(() => good)));
    expect(advertised.tasks.map(task => `${task.family}:${task.operation}`)).toEqual([
      'typescript_implementation:typescript.implement.v1', 'local_code_repair:typescript.repair.v1']);
  });

  it('routes a learned task, sends typed fields only, and returns an unverified candidate', async () => {
    const transport = fakeTransport(() => good);
    const adapter = adapterFor(transport);
    const task = implementTask();
    const result = await submitExecutionModelTask(adapter, task, routingContext(await learned(adapter)), { countOutputTokens });
    expect(result.kind).toBe('candidate');
    if (result.kind !== 'candidate') return;
    expect(result.verification).toBe('not_verified');
    expect(result.executionAllowed).toBe(false);
    expect(transport.requests[0]!.contract).toEqual({ fields: { function_name: 'offsetScore', increment: 4 } });
    const eligibility = new ExecutionResultValidator().checkEligibility(result, task, eligibilitySnapshot(task, 'granted', 'delta.ts'), countOutputTokens);
    expect(eligibility.ok).toBe(true);
  });

  it('passes concrete failure evidence and the failed source for local repair', async () => {
    const broken = functionSource('scaleBonus', 'value + 6');
    const transport = fakeTransport(() => functionSource('scaleBonus', 'value == null ? 0 : value + 6'));
    const adapter = adapterFor(transport);
    const task = contract({ taskId: 'repair-1', family: 'local_code_repair', target: 'r.ts', files: { 'r.ts': broken },
      spec: { function_name: 'scaleBonus', increment: 6, failure_category: 'missing_null_guard' },
      evidence: [{ id: 'ev-1', details: 'scaleBonus(null) returned 6; expected 0' }] });
    const result = await submitExecutionModelTask(adapter, task, routingContext(await learned(adapter)), { countOutputTokens });
    expect(result.kind).toBe('candidate');
    expect(transport.requests[0]!.contract).toMatchObject({ fields: { failed_candidate: broken, failure_evidence: ['scaleBonus(null) returned 6; expected 0'] } });
  });

  it('never lets a deterministic-capable structured task reach the model', async () => {
    const transport = fakeTransport(() => good);
    const adapter = adapterFor(transport);
    const before = functionSource('f', '0');
    const task = contract({ taskId: 'struct-1', family: 'structured_specification', target: 'f.ts', files: { 'f.ts': before }, replacement: good });
    const route = new ExecutionStrategyRouter().route(task, routingContext(await learned(adapter)), countOutputTokens);
    expect(route.kind === 'selected' && route.strategy).toBe('deterministic');
    await submitExecutionModelTask(adapter, task, routingContext(await learned(adapter)), { countOutputTokens });
    expect(transport.requests).toHaveLength(0);
  });

  it('returns missing_context without the execution spec and unsupported outside the vocabulary', async () => {
    const adapter = adapterFor(fakeTransport(() => good));
    const noSpec = contract({ taskId: 'nospec', family: 'typescript_implementation', target: 'd.ts', files: { 'd.ts': stub } });
    expect((await submitExecutionModelTask(adapter, noSpec, routingContext(await learned(adapter)), { countOutputTokens })).kind).toBe('missing_context');
    const react = contract({ taskId: 'react', family: 'typescript_implementation', target: 'd.ts', files: { 'd.ts': stub }, category: 'react', spec: { function_name: 'f', increment: 1 } });
    expect((await submitExecutionModelTask(adapter, react, routingContext(await learned(adapter)), { countOutputTokens })).kind).toBe('unsupported');
  });

  it('rejects model output that targets a file outside the allowed scope', async () => {
    const task = implementTask();
    const escaping = { kind: 'candidate', taskId: 'impl-1', workspace: task.workspace, producer: { strategy: 'learned', model },
      output: { category: 'typescript_edit', language: 'typescript', proposal: { summary: 's', edits: [{ path: '.env', expectedHash: sha(stub), content: 'x' }] } },
      verification: 'not_verified', executionAllowed: false };
    expect(new ExecutionResultValidator().validateStructure(escaping, task, countOutputTokens).ok).toBe(false);
  });

  it('classifies cancellation and transport failures without retrying', async () => {
    const transport = fakeTransport(() => new ModelTransportError('timeout'));
    const adapter = adapterFor(transport);
    const result = await submitExecutionModelTask(adapter, implementTask(), routingContext(await learned(adapter)), { countOutputTokens });
    expect(result.kind === 'failure' && result.code).toBe('timeout');
    expect(transport.requests).toHaveLength(1);
    const controller = new AbortController(); controller.abort();
    const cancelled = await submitExecutionModelTask(adapter, implementTask(), routingContext(await learned(adapter)), { countOutputTokens, signal: controller.signal });
    expect(cancelled.kind === 'failure' && cancelled.code).toBe('cancelled');
  });

  it('refuses the uncontained worker transport without an explicit experimental acknowledgement', () => {
    const config = { executable: 'C:\\python.exe', args: [], cwd: 'C:\\', environment: {}, identity, readOnlyPaths: ['C:\\'], maxRememberedRequestIds: 1,
      limits: { memoryBytes: 1, cpuTimeMs: 1, maxProcesses: 1, maxInputBytes: 1, maxMessageBytes: 1, maxOutputBytes: 1, maxStderrBytes: 0,
        maxOutputTokens: 1, startupTimeoutMs: 1, requestTimeoutMs: 1, cleanupTimeoutMs: 1 } };
    expect(() => new ExperimentalUncontainedWorkerTransport(config, { mode: 'production' as never, reason: 'x' })).toThrow(ModelTransportError);
  });
});
