import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ModelRelationsManager, TurnObservation } from '../../../../packages/model-relations/src/manager.js';
import type { BrainState } from './brain.js';
import { judge, type JudgeEvidence } from './judge.js';
import { detectManners } from './manners/detect.js';
import { captureArbiterDecisions, modelRelationsManager } from './model-relations-arbiter.js';
import { afterStructuredMemoryPublication } from './structured-memory-turn.js';

type Page = { text: string; url: string; title: string };
type Execution = { token?: string; request?: string; previousRequest?: string | null; page?: Page; readPages?: Page[] };
type Inspector = Pick<ModelRelationsManager, 'inspect'>;

function pageEvidence(pages: readonly Page[]): JudgeEvidence[] {
  const seen = new Set<string>();
  return pages.filter(page => page.text?.trim() && !seen.has(page.url) && seen.add(page.url))
    .map(({ text, url, title }) => ({ kind: 'page', text: text.slice(0, 24_000), url, title }));
}

export function createModelRelationsObserver(options: {
  env?: NodeJS.ProcessEnv;
  logFile?: string;
  inspector?: () => Promise<Inspector>;
} = {}) {
  const env = options.env ?? process.env;
  const getInspector = options.inspector ?? (async () => modelRelationsManager);
  let inspector: Promise<Inspector> | undefined;
  let directory: Promise<string | undefined> | undefined;

  return function observe(runId: string, state: BrainState | undefined, execution: Execution | undefined,
      answer: string | undefined, status: string, imageReadMs?: number): void {
    const started = performance.now();
    if (env.MOHASSAN_MODEL_RELATIONS === 'off' || !execution?.request) return;
    const id = execution.token ? `${runId}:${execution.token}` : runId;
    const text = execution.request;
    const previousText = execution.previousRequest;
    const routing = state?.routing;
    const resolution = state?.requestResolution;
    const arithmeticValue = state?.computed?.value;
    const pages = [...(execution.readPages ?? []), ...(execution.page ? [execution.page] : [])];
    const arbiter = captureArbiterDecisions(runId);
    let schedulingMs = 0;
    const schedule = () => setImmediate(() => {
      const work = async () => {
        const evidence = pageEvidence(pages);
        const question = resolution?.resolved ?? text;
        const observation: TurnObservation = {
          id, text, previousText, arbiter: arbiter?.(),
          baseline: {
            route: imageReadMs === undefined ? routing?.route ?? 'unsupported' : 'image',
            refusal: routing?.reason === 'scratch_out_of_scope' ? 'out_of_scope'
              : routing?.reason === 'request_refused' || routing?.reason === 'scratch_refuse' ? 'refuse' : 'allow',
            speechAct: routing?.handler === 'local_conversation'
              && (routing.reason === 'scratch_speech_act' || detectManners(text)?.request === null) ? 'smalltalk' : 'request',
            turnType: resolution?.kind ?? 'new',
            question,
            ...(evidence.length ? { evidence } : {}),
            answer, status, arithmeticValue, imageReadMs,
          },
        };
        const worker = await (inspector ??= getInspector().catch(error => { inspector = undefined; throw error; }));
        const decision = await worker.inspect(observation, input => judge(input).decision);
        const file = options.logFile ?? resolve('.data/model-relations-shadow.jsonl');
        await (directory ??= mkdir(dirname(file), { recursive: true, mode: 0o700 })
          .catch(error => { directory = undefined; throw error; }));
        await appendFile(file, JSON.stringify({ ...decision, schedulingMs }) + '\n', { mode: 0o600 });
      };
      void work().catch(() => { /* Shadow telemetry must not affect the chat. */ });
    });
    if (!afterStructuredMemoryPublication(runId, schedule)) schedule();
    schedulingMs = performance.now() - started;
  };
}

export const observeModelRelations = createModelRelationsObserver();

export function observeImageRelations(messageId: string, text: string, answer: string, imageReadMs: number): void {
  observeModelRelations(messageId, undefined, { request: text }, answer, 'completed', imageReadMs);
}
