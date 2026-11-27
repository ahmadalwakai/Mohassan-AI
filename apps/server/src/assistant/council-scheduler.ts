import { performance } from 'node:perf_hooks';
import {
  modelRegistry, modelRoots, resolveModelInRoots, type ModelEntry, type ResolvedModel,
} from '../../../../packages/model-relations/src/registry.js';

export type CouncilRole = 'understanding' | 'reader' | 'verifier' | 'extractor' | 'generator'
  | 'calculator' | 'image-reader' | 'ads-tagger' | 'code';

// Registry task descriptions at 29448ae, retrieved 2026-11-27:
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/model-relations/src/registry.ts
const rolesByTask = new Map<string, CouncilRole>([
  ['CLINC150 intent classification', 'understanding'],
  ['MASSIVE intent classification', 'understanding'],
  ['CLINC150 domain classification', 'understanding'],
  ['MASSIVE scenario classification', 'understanding'],
  ['Out-of-scope classification', 'understanding'],
  ['Turn type classification using prior context', 'understanding'],
  ['Pairwise question-rewrite candidate ranking', 'understanding'],
  ['Speech-act classification', 'understanding'],
  ['Classify the request into one of 14 route labels', 'understanding'],
  ['Historical character transformer router', 'understanding'],
  ['Experimental request routing with separately calibrated abstention', 'understanding'],
  ['Route classification', 'understanding'],
  ['Small-talk and speech-act classification', 'understanding'],
  ['Refusal and scope classification', 'understanding'],
  ['Follow-up classification', 'understanding'],
  ['Classify the current conversation monitor decision', 'understanding'],
  ['Flag unsafe and out-of-scope text', 'understanding'],
  ['Select a candidate sentence from retrieved evidence', 'reader'],
  ['Historical extractive reading model', 'reader'],
  ['Rank passages by experimental dense similarity', 'reader'],
  ['Evidence sufficiency classification', 'verifier'],
  ['Determine if an experimental reading model should abstain', 'verifier'],
  ['Detect date and place spans with the original BIO tagger', 'extractor'],
  ['Detect date and place spans with a dedicated five-tag BIO tagger', 'extractor'],
  ['Shared v5 trunk and causal token generation', 'generator'],
  ['Historical 38M chat foundation', 'generator'],
  ['Rank English expression candidates and decide acceptance', 'calculator'],
  ['Read Arabic and English text in an image', 'image-reader'],
  ['Extract structured Google Ads GoalTagger fields', 'ads-tagger'],
  ['Generate structured Ads fields with the historical dense pointer checkpoint', 'ads-tagger'],
  ['Constrained execution task generation', 'code'],
  ['Historical local Ads and code foundation', 'code'],
  ['Historical bilingual Ads and code generation', 'code'],
]);

export function councilRole(entry: ModelEntry): CouncilRole | undefined {
  if (entry.task === 'Historical trainable parameter delta for the v4 foundation') {
    // Both sets of deltas share the same task description. Their owners identify the training objective.
    if (entry.owner === 'scripts/heads/t1_reading.py') return 'reader';
    if (entry.owner === 'scripts/heads/t1_head_forms.py') return 'ads-tagger';
    return undefined;
  }
  return rolesByTask.get(entry.task);
}

/** Versions that the owner identified as untrained on 2026-11-27, when their weights are absent. */
export function councilModelUntrained(entry: ModelEntry): boolean {
  return entry.version === 'v5-sidecar-v1' || (entry.id === 'monitor-context-head' && entry.version === 'context-v1');
}

interface CouncilJob {
  entry: ModelEntry;
  role: CouncilRole;
}

type CouncilResult<T> = { status: 'ok'; value: T }
  | { status: 'absent' | 'untrained' | 'timeout' | 'failed' | 'skipped'; reason: string };

export type CouncilRun<T> = CouncilJob & { ms: number } & CouncilResult<T>;

export interface CouncilScheduleOptions {
  registry?: readonly ModelEntry[];
  /** Presence only. The shared runtime verifies integrity and dependencies before loading. */
  resolve?: (entry: ModelEntry) => Promise<ResolvedModel>;
  deadline: number;
  signal: AbortSignal;
  weight: (entry: ModelEntry, role: CouncilRole) => number;
  capMs?: (role: CouncilRole, entry: ModelEntry) => number | undefined;
}

function usesSharedPython(entry: ModelEntry): boolean {
  return entry.runtime !== 'node-cpu' && entry.id !== 'chat-v5';
}

function timeLimit(signal: AbortSignal) {
  return { status: 'timeout' as const, reason: signal.aborted ? 'Turn cancelled.' : 'Time budget exhausted.' };
}

async function withinBudget<T>(
  deadline: number,
  turnSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<CouncilResult<T>>,
): Promise<CouncilResult<T>> {
  const remaining = Math.floor(deadline - performance.now());
  if (turnSignal.aborted || remaining <= 0) return timeLimit(turnSignal);
  const controller = new AbortController();
  let stop!: () => void;
  const expired = new Promise<CouncilResult<T>>(resolve => {
    stop = () => {
      resolve(timeLimit(turnSignal));
      controller.abort();
    };
  });
  const timer = setTimeout(stop, remaining);
  turnSignal.addEventListener('abort', stop, { once: true });
  try {
    const result = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }).then(result => controller.signal.aborted || performance.now() >= deadline ? timeLimit(turnSignal) : result)
      .catch((): CouncilResult<T> => controller.signal.aborted ? timeLimit(turnSignal) : {
      status: 'failed', reason: 'Member operation failed.',
    });
    return await Promise.race([result, expired]);
  } finally {
    clearTimeout(timer);
    turnSignal.removeEventListener('abort', stop);
  }
}

export function createCouncilSchedule(options: CouncilScheduleOptions) {
  const registry = options.registry ?? modelRegistry;
  const roots = modelRoots(process.cwd());
  const resolve = options.resolve ?? (entry => resolveModelInRoots(entry, roots, process.env, false));
  let activePython: Promise<unknown> | undefined;

  async function run<T>(
    roles: readonly CouncilRole[],
    eligible: (entry: ModelEntry, role: CouncilRole) => boolean | string,
    runner: (entry: ModelEntry, role: CouncilRole, signal: AbortSignal) => Promise<T>,
    roundDeadline = options.deadline,
  ): Promise<CouncilRun<T>[]> {
    const deadline = Math.min(options.deadline, roundDeadline);
    const jobs = registry.flatMap(entry => {
      const role = councilRole(entry);
      if (!role || !roles.includes(role)) return [];
      const readiness = eligible(entry, role);
      if (readiness === false) return [];
      return [{ entry, role, readiness, weight: options.weight(entry, role) }];
    }).sort((first, second) => second.weight - first.weight || first.entry.resources.latencyMs - second.entry.resources.latencyMs);
    const probes = jobs.map(({ entry }) => {
      let result: CouncilResult<ResolvedModel> | undefined;
      const pending = Promise.resolve().then(async (): Promise<CouncilResult<ResolvedModel>> => {
        if (options.signal.aborted || performance.now() >= deadline) return timeLimit(options.signal);
        try {
          return { status: 'ok', value: await resolve(entry) };
        } catch {
          return { status: 'failed', reason: 'Model presence check failed.' };
        }
      }).then(settled => { result = settled; return settled; });
      return { pending, settled: () => result };
    });
    const results: CouncilRun<T>[] = [];
    for (const [index, { entry, role, readiness }] of jobs.entries()) {
      const pendingProbe = probes[index]!;
      const probe = pendingProbe.settled() ?? await withinBudget(deadline, options.signal, () => pendingProbe.pending);
      if (probe.status !== 'ok') {
        results.push({ entry, role, ms: 0, ...probe });
        continue;
      }
      if (probe.value.state === 'absent') {
        const missing = probe.value.artifacts.filter(artifact => artifact.required && !artifact.present).map(artifact => artifact.role);
        const reason = missing.length ? `Required artifacts absent: ${missing.join(', ')}.` : 'Required artifacts absent.';
        results.push(councilModelUntrained(entry)
          ? { entry, role, ms: 0, status: 'untrained', reason: `Untrained in this registry version. ${reason}` }
          : { entry, role, ms: 0, status: 'absent', reason });
        continue;
      }
      if (typeof readiness === 'string') {
        results.push({ entry, role, ms: 0, status: 'skipped', reason: readiness });
        continue;
      }
      if (usesSharedPython(entry) && activePython) {
        results.push({ entry, role, ms: 0, status: 'skipped', reason: 'Previous Python model is still stopping.' });
        continue;
      }
      const started = performance.now();
      const cap = options.capMs?.(role, entry) ?? entry.resources.latencyMs;
      const result = await withinBudget<T>(Math.min(deadline, started + cap), options.signal, signal => {
        const work = Promise.resolve().then(() => {
          signal.throwIfAborted();
          return runner(entry, role, signal);
        });
        if (usesSharedPython(entry)) {
          activePython = work;
          const release = () => { if (activePython === work) activePython = undefined; };
          void work.then(release, release);
        }
        return work.then(value => ({ status: 'ok', value }));
      });
      results.push({ entry, role, ms: Math.round(performance.now() - started), ...result });
    }
    return results;
  }

  return { run };
}
