import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { inputAs, loadModelAdapter, modelArtifact, requiredArtifact } from './adapters.js';
import type { ResolvedArtifact, ResolvedModel } from './registry.js';
import { ModelRuntimeError, type ModelAdapter, type ModelAdapterContext } from './runtime.js';

const readingText = z.string().min(1).max(8_000);
const verifierInput = z.object({ question: readingText, passage: readingText, answer: readingText }).strict();
const retrieverInput = z.object({ question: readingText, passages: z.array(z.string().min(1).max(1_200)).min(1).max(16) }).strict();
const executionInput = z.object({ capability: z.string().min(1).max(96), fields: z.record(z.string(), z.unknown()) }).strict();
const MAX_LINE_BYTES = 256 * 1_024;

async function artifactPin(artifact: ResolvedArtifact, signal: AbortSignal) {
  if (artifact.sha256) return { path: artifact.path, sha256: artifact.sha256 };
  const hash = createHash('sha256');
  for await (const data of createReadStream(artifact.path, { signal })) hash.update(data);
  return { path: artifact.path, sha256: hash.digest('hex') };
}

async function descriptor(model: ResolvedModel, context: ModelAdapterContext) {
  const { id } = model.entry;
  if (id === 'execution' || id.startsWith('execution-')) {
    return { kind: 'execution', device: context.env.EXECUTOR_DEVICE === 'cuda' ? 'cuda' : 'cpu', artifacts: {
      manifest: await artifactPin(requiredArtifact(model, 'manifest'), context.signal),
      weights: await artifactPin(requiredArtifact(model, 'weights'), context.signal),
    } };
  }
  const baseId = id === 'reading-abstain-verifier' ? 'reading-v3-last' : 'chat-v4';
  const base = context.dependencies.find(dependency => dependency.entry.id === baseId);
  if (!base) throw new ModelRuntimeError('incompatible', `Missing ${baseId} dependency`);
  const report = modelArtifact(base, 'tokenizer-report');
  return {
    kind: id === 'reading-abstain-verifier' ? 'verifier' : 'retriever',
    device: id === 'reading-dense-retriever' ? 'cuda' : 'cpu',
    artifacts: {
      ...(id === 'reading-dense-retriever'
        ? { checkpoint: await artifactPin(requiredArtifact(model, 'checkpoint'), context.signal), config: await artifactPin(requiredArtifact(base, 'checkpoint'), context.signal) }
        : { checkpoint: await artifactPin(requiredArtifact(base, 'checkpoint'), context.signal), verifier: await artifactPin(requiredArtifact(model, 'weights'), context.signal) }),
      tokenizer: await artifactPin(requiredArtifact(base, 'tokenizer'), context.signal),
      ...(report ? { report: await artifactPin(report, context.signal) } : {}),
    },
  };
}

function localWorker(executable: string, context: ModelAdapterContext) {
  const child = spawn(executable, ['-I', '-B', resolve(context.root, 'packages/model-relations/src/council-native-worker.py')], {
    cwd: context.root, env: process.platform === 'win32' && context.env.SystemRoot ? { SystemRoot: context.env.SystemRoot } : {},
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  let usable = true;
  let line = '';
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { complete: (value: unknown) => void; fail: (error: ModelRuntimeError) => void } | undefined;
  let failure: ModelRuntimeError | undefined;
  const terminate = (error: ModelRuntimeError) => {
    if (failure) return;
    failure = error;
    usable = false;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    killTimer.unref();
  };
  const closed = new Promise<void>(resolve => child.once('close', () => {
    usable = false;
    clearTimeout(killTimer);
    pending?.fail(failure ?? new ModelRuntimeError('unhealthy', 'Local council inference worker exited'));
    resolve();
  }));
  child.on('error', () => terminate(new ModelRuntimeError('unhealthy', 'Local council inference worker could not start')));
  child.stdin.on('error', () => terminate(new ModelRuntimeError('unhealthy', 'Local council inference input closed')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (!usable) return;
    line += chunk;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return terminate(new ModelRuntimeError('unhealthy', 'Local council inference output exceeded its limit'));
    if (!line.endsWith('\n')) return;
    try {
      const output = JSON.parse(line) as { output?: unknown; reason?: string };
      line = '';
      if (!pending || (!Object.hasOwn(output, 'output') && !output.reason)) throw new Error('Invalid response');
      if (output.reason) pending.fail(new ModelRuntimeError(output.reason === 'invalid-input' ? 'invalid-input'
        : output.reason === 'incompatible' ? 'incompatible' : output.reason === 'gpu-locked' ? 'gpu-locked' : 'unhealthy', 'Local council inference rejected the request'));
      else pending.complete(output.output);
    } catch {
      terminate(new ModelRuntimeError('unhealthy', 'Invalid local council inference response'));
    }
  });
  return {
    healthy: () => usable,
    request(input: unknown, signal: AbortSignal): Promise<unknown> {
      if (signal.aborted) return Promise.reject(new ModelRuntimeError('timeout'));
      if (!usable || pending) return Promise.reject(new ModelRuntimeError('unhealthy'));
      const data = `${JSON.stringify(input)}\n`;
      if (Buffer.byteLength(data) > MAX_LINE_BYTES) return Promise.reject(new ModelRuntimeError('invalid-input'));
      return new Promise((resolve, reject) => {
        const abort = () => terminate(new ModelRuntimeError('timeout'));
        const cleanup = () => { pending = undefined; signal.removeEventListener('abort', abort); };
        pending = { complete: value => { cleanup(); resolve(value); }, fail: error => { cleanup(); reject(error); } };
        signal.addEventListener('abort', abort, { once: true });
        child.stdin.write(data);
      });
    },
    close: async () => { if (usable) terminate(new ModelRuntimeError('unhealthy')); await closed; },
  };
}

export async function loadCouncilNativeAdapter(model: ResolvedModel, context: ModelAdapterContext): Promise<ModelAdapter> {
  const executable = resolve(context.root, context.env.EXECUTOR_PYTHON?.trim() || (process.platform === 'win32' ? '.venv-execution/Scripts/python.exe' : '.venv-execution/bin/python'));
  await access(executable).catch(() => { throw new ModelRuntimeError('unhealthy', 'The local Python runtime is unavailable'); });
  const config = await descriptor(model, context);
  if (config.device === 'cuda') await context.assertGpuFree();
  context.signal.throwIfAborted();
  const worker = localWorker(executable, context);
  const schema = config.kind === 'execution' ? executionInput : config.kind === 'verifier' ? verifierInput : retrieverInput;
  return {
    warmup: async signal => {
      if (await worker.request({ ...config, cpuThreads: model.entry.resources.cpu }, signal) !== 'ready') throw new ModelRuntimeError('unhealthy');
    },
    health: worker.healthy,
    run: (input, signal) => worker.request(inputAs<unknown>(schema, input), signal),
    close: worker.close,
  };
}

/** Preserve the existing LM adapter for the Ads side of the bilingual models. */
export async function loadCouncilBilingualAdapter(model: ResolvedModel, context: ModelAdapterContext): Promise<ModelAdapter> {
  const adapter = await loadModelAdapter(model, context);
  return {
    ...adapter,
    run(input, signal, timeoutMs) {
      const task = executionInput.safeParse(input);
      if (!task.success) return adapter.run(input, signal, timeoutMs);
      if (task.data.capability !== 'typescript.implement.v1:null-safe-delta') throw new ModelRuntimeError('unsupported');
      const fields = inputAs(z.object({ function_name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u), increment: z.number().int().min(-9).max(9) }).strict(), task.data.fields);
      // The exact prompt structure of execution_pipeline/code_tasks.py::render_prompt, in the fixed typed task domain.
      // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/execution-pipeline/execution_pipeline/code_tasks.py#L192 (retrieved 2026-11-27).
      const text = `Code task:\nRequest: Write an exported TypeScript function that returns 0 for null or undefined and otherwise adds ${fields.increment}.\nSignature: ${fields.function_name}(value: number | null | undefined): number\nReturn only the complete exported TypeScript function.\nOutput:\n`;
      return adapter.run({ text, maxNewTokens: 96 }, signal, timeoutMs);
    },
  };
}
