import { Worker, parentPort } from 'node:worker_threads';
import { z } from 'zod';
import { inputAs } from './adapters.js';
import { ModelRuntimeError, type ModelAdapter } from './runtime.js';

const prompt = z.object({ text: z.string().min(1).max(8_000) }).strict();
const probe = 'A workshop has 8 rolls with 14 meters of ribbon per roll. The ribbon is divided equally into 4 display frames. How many meters of ribbon go on each frame?';

// Candidate search can saturate a core on ambiguous input. Keep that search off the server's JS thread.
const bootstrap = `
  const { parentPort, workerData } = require('node:worker_threads');
  (async () => {
    if (workerData.tsxUrl) (await import(workerData.tsxUrl)).register();
    await (await import(workerData.moduleUrl)).serveArithmetic();
  })().catch(() => { parentPort.postMessage({ ok: false }); process.exitCode = 1; });
`;

export async function serveArithmetic(): Promise<void> {
  const [{ selectArithmeticCandidate }, { searchCandidatesForWordProblem }] = await Promise.all([
    import('../../../apps/server/src/assistant/arithmetic-search-ranker.js'),
    import('../../../apps/server/src/assistant/word-problem.js'),
  ]);
  parentPort?.on('message', (text: string) => {
    try {
      parentPort?.postMessage({ ok: true, output: selectArithmeticCandidate(searchCandidatesForWordProblem(text)) });
    } catch {
      parentPort?.postMessage({ ok: false });
    }
  });
}

export function createArithmeticAdapter(): ModelAdapter {
  const typescript = import.meta.url.endsWith('.ts');
  const worker = new Worker(bootstrap, {
    eval: true,
    execArgv: [],
    name: 'mohassan-arithmetic-ranker',
    resourceLimits: { maxOldGenerationSizeMb: 128 },
    workerData: { moduleUrl: import.meta.url, tsxUrl: typescript ? import.meta.resolve('tsx/esm/api') : undefined },
  });
  let healthy = true;
  let closing: Promise<number> | undefined;
  let pending: { finish(error?: Error, output?: unknown): void } | undefined;
  const close = () => {
    healthy = false;
    closing ??= worker.terminate();
    return closing.then(() => {});
  };
  worker.on('message', (message: { ok: true; output: unknown } | { ok: false }) => {
    if (message.ok) pending?.finish(undefined, message.output);
    else pending?.finish(new ModelRuntimeError('unhealthy'));
  });
  const fail = () => {
    healthy = false;
    pending?.finish(new ModelRuntimeError('unhealthy'));
  };
  worker.once('error', fail);
  worker.once('exit', fail);
  worker.unref();

  const run = (text: string, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    if (!healthy) throw new ModelRuntimeError('unhealthy');
    if (pending) throw new ModelRuntimeError('busy');
    worker.ref();
    return new Promise((resolve, reject) => {
      const abort = () => { void close().then(() => reject(new ModelRuntimeError('timeout')), reject); };
      pending = {
        finish(error, output) {
          pending = undefined;
          worker.unref();
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve(output);
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      try { worker.postMessage(text); } catch { pending.finish(new ModelRuntimeError('unhealthy')); }
    });
  };
  return {
    warmup: async signal => { await run(probe, signal); },
    health: () => healthy,
    run: (input, signal) => run(inputAs(prompt, input).text, signal),
    close,
  };
}
