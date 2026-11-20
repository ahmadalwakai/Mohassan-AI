/**
 * Owner-only lab path for Mohassan's own Ads model (scratch-trained, 34M parameters).
 *
 * brief -> rendered prompt -> local Python worker (8 candidates: greedy + 7 sampled)
 *       -> checker gate (scripts/ads-training/gate.ts) -> the first passing candidate, or a refusal.
 * No external model, no network call, no Google Ads account: nothing is published. The worker is
 * the same uncontained local process class as the executor experiment, so this is on only when
 * the executor experiment is (EXECUTOR_EXPERIMENT=uncontained-local, never production).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export interface AdsLabConfig { enabled: boolean; run?: string; /** Fine-tune folder the main chat uses (pointer tasks). */ chatFinetune?: string; python: string; packageDir: string; device: 'cpu' | 'cuda'; startupTimeoutMs: number; requestTimeoutMs: number }

/** Same switch, Python and package as the executor experiment; ADS_MODEL_RUN names the trained run. */
export function adsLabConfigFromEnv(env: NodeJS.ProcessEnv, executor: { enabled: boolean; python: string; packageDir: string }): AdsLabConfig {
  const run = env.ADS_MODEL_RUN?.trim();
  return {
    enabled: executor.enabled, run: run ? resolve(run) : undefined, chatFinetune: env.ADS_CHAT_FINETUNE?.trim() || 'pointer-v3', python: executor.python, packageDir: executor.packageDir,
    device: env.ADS_MODEL_DEVICE === 'cpu' ? 'cpu' : 'cuda', startupTimeoutMs: 120_000, requestTimeoutMs: 90_000,
  };
}

const CAPABILITIES = ['ads.keywords.v1', 'ads.negatives.v1', 'ads.headlines.v1', 'ads.descriptions.v1'] as const;
type Capability = typeof CAPABILITIES[number];
const text = (max: number) => z.string().trim().min(1).max(max);
const RunInput = z.object({
  capability: z.enum(CAPABILITIES),
  brief: z.object({
    business: text(60), service: text(60), city: text(40), goal: z.enum(['calls', 'leads', 'bookings']),
    facts: z.array(text(140)).max(12).default([]),
    keywords: z.array(text(80)).max(20).default([]),
  }).strict(),
  candidates: z.number().int().min(1).max(8).default(8),
}).strict();

interface Handshake { ready: true; device: string; parameters: number; finetune_step: number | null; prompt_hint: string | null; tokenizer_identity: string; config_identity: string; context: number; checkpoint_sha256?: string; languages?: string[] }
interface Candidate { text: string; finished: boolean }
type WorkerState = 'stopped' | 'starting' | 'ready' | 'failed';
const WorkerHandshake = z.object({
  ready: z.literal(true), device: z.enum(['cpu', 'cuda']), parameters: z.number().int().positive(),
  finetune_step: z.number().int().nonnegative().nullable(), prompt_hint: z.string().max(128).nullable(),
  tokenizer_identity: z.string().trim().min(1).max(128), config_identity: z.string().trim().min(1).max(128),
  context: z.number().int().min(1).max(8192), checkpoint_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  languages: z.array(z.enum(['ar', 'en'])).max(2).optional(),
}).passthrough();
const WorkerAnswer = z.object({
  candidates: z.array(z.object({ text: z.string().max(32000), finished: z.boolean() })).min(1).max(8),
  ms: z.number().finite().nonnegative(),
});

export class AdsLabHttpError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }

/** The input the model was trained on for each task: the same fields, in the dataset's shape. */
export function briefInput(capability: Capability, brief: z.infer<typeof RunInput>['brief']): Record<string, unknown> {
  const base = { business: brief.business, service: brief.service, city: brief.city, goal: brief.goal, language: 'en' };
  if (capability === 'ads.negatives.v1') {
    if (!brief.keywords.length) throw new AdsLabHttpError(400, 'KEYWORDS_REQUIRED', 'الكلمات السلبية تحتاج قائمة الكلمات المفتاحية أولاً.');
    return { ...base, keywords: brief.keywords };
  }
  if (capability === 'ads.keywords.v1') return base;
  return { ...base, facts: brief.facts };
}

export interface AdsWorkerConfig { run?: string; finetune: string; python: string; packageDir: string; device: 'cpu' | 'cuda'; startupTimeoutMs: number; requestTimeoutMs: number; expectedCheckpointSha256?: string }

/**
 * One long-lived local Python worker for one fine-tuned Ads checkpoint (<run>/<finetune>/best.pt).
 * Text in, candidates out; nothing else. Requests are queued: one at a time on the GPU.
 */
export function createAdsModelWorker(config: AdsWorkerConfig) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let state: WorkerState = 'stopped';
  let handshake: Handshake | null = null;
  let lastError: string | null = null;
  let starting: Promise<void> | null = null;
  let cancelStartup: ((error: Error) => void) | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, { resolve(value: { candidates: Candidate[]; ms: number }): void; reject(error: Error): void }>();

  async function files(): Promise<string | null> {
    if (!config.run) return 'لم يُحدد مجلد نموذج الإعلانات (ADS_MODEL_RUN).';
    for (const file of [join(config.run, config.finetune, 'best.pt'), join(config.run, 'tokenizer.json'), config.python]) {
      try { await access(file); } catch { return `ملف غير موجود: ${file}`; }
    }
    return null;
  }

  async function languages(): Promise<string[]> {
    if (!config.run) return [];
    try {
      const settings = JSON.parse(await readFile(join(config.run, config.finetune, 'settings.json'), 'utf8'));
      // No list, or an empty one (the f38m fine-tunes save "languages": []), means English only.
      const listed = Array.isArray(settings.languages) ? settings.languages.filter((value: unknown) => value === 'en' || value === 'ar') : [];
      return listed.length ? listed : ['en'];
    } catch { return []; }
  }

  function stop() {
    cancelStartup?.(new AdsLabHttpError(503, 'WORKER_STOPPED', 'توقف عامل النموذج أثناء التحميل.'));
    cancelStartup = null;
    for (const waiter of pending.values()) waiter.reject(new AdsLabHttpError(503, 'WORKER_STOPPED', 'توقف عامل النموذج.'));
    pending.clear();
    child?.kill();
    child = null;
    starting = null;
    if (state !== 'failed') state = 'stopped';
  }

  function start(): Promise<void> {
    if (state === 'ready' && child) return Promise.resolve();
    if (starting) return starting;
    state = 'starting';
    lastError = null;
    starting = new Promise<void>((resolve, reject) => {
      const process_ = spawn(config.python, ['-m', 'execution_pipeline.ads_worker', '--run', config.run!, '--device', config.device, '--finetune', config.finetune, ...(config.expectedCheckpointSha256 ? ['--checkpoint-sha256', config.expectedCheckpointSha256] : [])], {
        cwd: config.packageDir, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        // Only what Python and CUDA need: no secrets, no DATABASE_URL, no provider keys.
        env: Object.fromEntries(Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, LOCALAPPDATA: process.env.LOCALAPPDATA, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      });
      child = process_;
      let stderr = '';
      process_.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
      const timer = setTimeout(() => { fail('انتهت مهلة تحميل النموذج.'); }, config.startupTimeoutMs);
      cancelStartup = error => { clearTimeout(timer); reject(error); };
      const fail = (message: string) => {
        clearTimeout(timer);
        if (child !== process_) return;
        state = 'failed';
        lastError = message;
        const error = new AdsLabHttpError(503, 'WORKER_FAILED', message);
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
        process_.kill();
        if (child === process_) child = null;
        starting = null;
        cancelStartup = null;
        reject(error);
      };
      createInterface({ input: process_.stdout }).on('line', line => {
        if (child !== process_) return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('أعاد عامل النموذج إطار بيانات غير صالح.');
        if ('ready' in message) {
          if (message.ready !== true) return fail(`فشل تحميل النموذج: ${String(message.error ?? '')}`);
          const parsed = WorkerHandshake.safeParse(message);
          if (!parsed.success) return fail('أعاد عامل النموذج بيانات جاهزية غير صالحة.');
          if (config.expectedCheckpointSha256 && message.checkpoint_sha256 !== config.expectedCheckpointSha256) return fail('بصمة النموذج المحمل لا تطابق النسخة المحددة.');
          clearTimeout(timer);
          handshake = parsed.data;
          state = 'ready';
          starting = null;
          cancelStartup = null;
          return resolve();
        }
        const waiter = pending.get(String(message.id));
        if (!waiter) return;
        pending.delete(String(message.id));
        if (typeof message.error === 'string') waiter.reject(new AdsLabHttpError(422, 'MODEL_ERROR', message.error));
        else {
          const parsed = WorkerAnswer.safeParse(message);
          if (!parsed.success) waiter.reject(new AdsLabHttpError(502, 'BAD_MODEL_RESPONSE', 'أعاد عامل النموذج إجابة غير صالحة.'));
          else waiter.resolve(parsed.data);
        }
      });
      process_.on('error', error => fail(`تعذر تشغيل Python: ${error.message}`));
      process_.on('exit', code => {
        if (child !== process_) return;
        if (state === 'starting') return fail(`خرج عامل النموذج قبل الجاهزية (${code}). ${stderr.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? ''}`.trim());
        child = null;
        for (const waiter of pending.values()) waiter.reject(new AdsLabHttpError(503, 'WORKER_EXITED', 'خرج عامل النموذج أثناء الطلب.'));
        pending.clear();
        if (state === 'ready') state = 'stopped';
      });
    }).catch(error => {
      // A synchronous process-creation failure happens before any child event can reset startup.
      if (child === null && state === 'starting') {
        starting = null;
        cancelStartup = null;
        state = 'failed';
        lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    });
    return starting;
  }

  function sample(prompt: string, input: Record<string, unknown>, candidates: number, options: { signal?: AbortSignal; maxNewTokens?: number } = {}) {
    // One brief at a time on the GPU; later requests wait their turn.
    const job = queue.then(async () => {
      options.signal?.throwIfAborted();
      const abort = () => stop();
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        await start();
        options.signal?.throwIfAborted();
        const id = randomUUID();
        return await new Promise<{ candidates: Candidate[]; ms: number }>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new AdsLabHttpError(504, 'TIMEOUT', 'انتهت مهلة توليد الإجابات.'));
            // End the timed-out generation before allowing another queued job to start.
            stop();
          }, config.requestTimeoutMs);
          pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
          child!.stdin.write(JSON.stringify({ id, prompt, input, candidates, ...(options.maxNewTokens ? { max_new_tokens: options.maxNewTokens } : {}) }) + '\n', error => {
            if (error) { pending.get(id)?.reject(error); pending.delete(id); stop(); }
          });
        });
      } finally { options.signal?.removeEventListener('abort', abort); }
    });
    queue = job.catch(() => undefined);
    return job;
  }

  return { files, languages, start, stop, sample, info: () => ({ state, error: lastError, model: handshake }) };
}
export type AdsModelWorker = ReturnType<typeof createAdsModelWorker>;

export function createAdsLab(config: AdsLabConfig) {
  const worker = createAdsModelWorker({ ...config, finetune: 'ads-finetune' });
  const { files, stop, sample } = worker;
  // The gate builds its allowed wording when first imported; load it on first use, not at boot.
  let gateModule: Promise<typeof import('../../../scripts/ads-training/gate.js')> | null = null;
  let libModule: Promise<typeof import('../../../scripts/ads-training/lib.js')> | null = null;
  const gateApi = () => (gateModule ??= import('../../../scripts/ads-training/gate.js'));
  const libApi = () => (libModule ??= import('../../../scripts/ads-training/lib.js'));

  async function status() {
    const missing = config.enabled ? await files() : 'تجربة النموذج المحلي غير مفعلة (تعمل في npm run dev:lab فقط).';
    const lib = config.enabled && !missing ? await libApi() : null;
    const { HELD_OUT_VERTICAL, VERTICALS } = config.enabled && !missing ? await import('../../../scripts/ads-training/verticals.js') : { HELD_OUT_VERTICAL: '', VERTICALS: [] };
    return {
      enabled: config.enabled, available: !missing, message: missing, run: config.run ?? null, device: config.device,
      worker: worker.info(),
      capabilities: CAPABILITIES, datasetVersion: lib?.DATASET_VERSION ?? null,
      // Business types the model was trained on; the held-out one is listed so the owner can test it.
      trained: VERTICALS.filter(vertical => vertical.id !== HELD_OUT_VERTICAL).map(vertical => ({ id: vertical.id, services: vertical.services.map(service => service.name), facts: vertical.facts.map(fact => fact.sentence) })),
      heldOut: VERTICALS.filter(vertical => vertical.id === HELD_OUT_VERTICAL).map(vertical => ({ id: vertical.id, services: vertical.services.map(service => service.name) })),
    };
  }

  async function run(body: unknown) {
    if (!config.enabled) throw new AdsLabHttpError(404, 'DISABLED', 'تجربة النموذج المحلي غير مفعلة.');
    const missing = await files();
    if (missing) throw new AdsLabHttpError(503, 'MODEL_MISSING', missing);
    const request = RunInput.parse(body);
    const input = briefInput(request.capability, request.brief);
    const [{ gate, gateIssues, knownVertical }, { renderPrompt }] = await Promise.all([gateApi(), libApi()]);
    const prompt = renderPrompt({ capability: request.capability, input });
    const started = performance.now();
    const sampled = await sample(prompt, input, request.candidates);
    // Keep sample indices stable while excluding generations that never reached EOS.
    const decision = gate(request.capability, input, sampled.candidates.map(candidate => candidate.finished ? candidate.text : ''));
    const candidates = sampled.candidates.map((candidate, index) => {
      let parsed: unknown = null;
      try { parsed = JSON.parse(candidate.text); } catch { /* reported below */ }
      const issues = !candidate.finished
        ? [{ code: 'INCOMPLETE', message: 'انقطعت الإجابة قبل نهايتها.' }]
        : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? gateIssues(request.capability, input, parsed as Record<string, unknown>).map(issue => ({ code: issue.code, message: issue.message }))
          : [{ code: 'UNPARSABLE', message: 'ليست JSON صالحة.' }];
      return { index, sampling: index === 0 ? 'greedy' : 'sampled', text: candidate.text, finished: candidate.finished, passed: issues.length === 0, issues };
    });
    return {
      capability: request.capability, input, prompt, decision, candidates,
      knownBusinessType: knownVertical(input)?.id ?? null,
      model: worker.info().model, generationMs: sampled.ms, totalMs: Math.round(performance.now() - started),
      executor: { kind: 'local-custom-model', external: false, published: false },
    };
  }

  return { status, run, stop, shutdown: stop };
}
export type AdsLab = ReturnType<typeof createAdsLab>;

export async function registerAdsLabRoutes(app: FastifyInstance, options: { lab: AdsLab; owner: (request: { headers: Record<string, unknown> }) => Promise<{ id: string }> }) {
  const { lab, owner } = options;
  const handle = async <T>(reply: { code(status: number): { send(body: unknown): unknown } }, work: () => Promise<T>) => {
    try { return await work(); } catch (error) {
      if (error instanceof AdsLabHttpError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_BRIEF', message: 'بيانات الطلب غير مكتملة أو أطول من المسموح.' } });
      throw error;
    }
  };
  app.get('/api/executor/ads/status', async request => { await owner(request); return lab.status(); });
  app.post('/api/executor/ads/runs', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    await owner(request);
    return handle(reply, () => lab.run(request.body));
  });
  app.post('/api/executor/ads/stop', async request => { await owner(request); lab.stop(); return { stopped: true }; });
}
