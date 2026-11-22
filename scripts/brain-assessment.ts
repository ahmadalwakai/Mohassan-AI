/**
 * Read-only development assessment; no .env, database, browser, training or inference service.
 *
 * node --import tsx scripts/brain-assessment.ts
 * node --import tsx scripts/brain-assessment.ts --model-dir artifacts/router --split validation
 *
 * B0 weights are read only when --model-dir is supplied. Both partitions are visible
 * development data. A correct route to a missing capability is not an executed task.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouterModel, routeWithModel, rulesRoute } from '../apps/server/src/assistant/router.js';
import { bootstrapRequestContext, requestSlotKinds, resolveRequestContext, type RequestSlotKind } from '../apps/server/src/assistant/request-context.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import {
  evaluateBrainAssessment, validateBrainAssessmentDataset,
  type BrainAssessmentCase, type BrainAssessmentPredictor, type BrainAssessmentReport,
} from '../packages/learning/src/brain-assessment.js';

export interface BrainAssessmentArguments {
  dataset: string;
  output: string;
  split: 'all' | 'development' | 'validation';
  modelDir?: string;
}

export function brainAssessmentArguments(args: readonly string[]): BrainAssessmentArguments {
  const values = new Map<string, string>();
  const allowed = new Set(['--dataset', '--output', '--split', '--model-dir']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('BRAIN_ASSESSMENT_ARGUMENTS: expected --dataset, --output, --split or --model-dir followed by a value.');
    values.set(key, value);
  }
  const split = values.get('--split') ?? 'all';
  if (split !== 'all' && split !== 'development' && split !== 'validation') throw new Error('BRAIN_ASSESSMENT_SPLIT');
  return {
    dataset: resolve(values.get('--dataset') ?? 'tests/fixtures/brain-assessment/development-v1.json'),
    output: resolve(values.get('--output') ?? 'artifacts/brain-assessment/latest.json'),
    split, ...(values.has('--model-dir') ? { modelDir: resolve(values.get('--model-dir')!) } : {}),
  };
}

function previousUser(input: BrainAssessmentCase['input']): string | null {
  return input.history?.findLast(turn => turn.role === 'user')?.text ?? null;
}

export function rulesAssessmentPredictor(): BrainAssessmentPredictor {
  return {
    name: 'rules-v0-exact', dimensions: ['route'], confidenceKind: 'unavailable',
    limitations: ['This is the exported rulesRoute diagnostic helper, not the full command-chat orchestrator. Its coarse memory_ads_pc bucket is not scored as an exact memory, ads or pc route. Downstream handlers in the running chat can still handle those tasks.'],
    predict: input => ({ route: rulesRoute(input.text, previousUser(input)) }),
  };
}

export function requestContextAssessmentPredictor(): BrainAssessmentPredictor {
  return {
    name: 'request-context-v1', dimensions: ['route', 'context', 'slots'], confidenceKind: 'unavailable',
    limitations: ['This measures the deterministic request-context boundary only, not the full chat or task execution. Image/media destinations are outside its current intent taxonomy. Only user-role history is bootstrapped; assistant history cannot supply a user instruction.'],
    predict: input => {
      const previous = bootstrapRequestContext((input.history ?? []).filter(turn => turn.role === 'user').map((turn, index) => ({ text: turn.text, id: `history-${index + 1}` })));
      const pending = input.pendingQuestion;
      const fields = pending?.fields?.filter((value): value is RequestSlotKind => requestSlotKinds.includes(value as RequestSlotKind));
      const resolution = resolveRequestContext(input.text, previous, {
        turnId: 'assessment-current',
        ...(pending ? { pendingQuestion: { id: pending.id, ...(fields?.length ? { fields } : {}) } } : {}),
      });
      return { route: resolution.kind === 'answer' ? 'reply' : resolution.kind === 'ambiguous' ? 'clarify' : resolution.intent,
        intent: resolution.intent, contextKind: resolution.kind, slots: resolution.slots.map(({ kind, value }) => ({ kind, value })) };
    },
  };
}

export function routingDecisionAssessmentPredictor(): BrainAssessmentPredictor {
  return {
    name: 'routing-decision-candidate-v1', dimensions: ['route', 'context', 'slots'], confidenceKind: 'unavailable',
    limitations: [
      'This is the new read-only routing adapter, not proof that command-chat uses it or that a task can be executed.',
      'Synthetic host capabilities: browser/search/memory/adsModel/computer/coding/planner available; writer/chat/reminder/image/media models unavailable. Actual services are not probed.',
      'Local calculation clock is pinned to 2026-11-21T09:00:00Z for repeatability. No resulting answer is scored by this routing benchmark.',
    ],
    predict: input => {
      const previous = bootstrapRequestContext((input.history ?? []).filter(turn => turn.role === 'user').map((turn, index) => ({ text: turn.text, id: `history-${index + 1}` })));
      const pending = input.pendingQuestion;
      const fields = pending?.fields?.filter((value): value is RequestSlotKind => requestSlotKinds.includes(value as RequestSlotKind));
      const route = pending?.route;
      const decision = decideRequestRoute({
        text: input.text, context: previous, turnId: 'assessment-current', now: new Date('2026-11-21T09:00:00Z'),
        capabilities: { browser: true, search: true, memory: true, adsModel: true, computer: true, coding: true, planner: true },
        ...(pending ? { pendingQuestion: { id: pending.id,
          ...(route !== 'reply' && route !== 'clarify' ? { route } : {}),
          ...(fields?.length ? { fields } : {}) } } : {}),
      });
      return { route: decision.route, intent: decision.intent, contextKind: decision.resolution.kind,
        slots: decision.resolution.slots.map(({ kind, value }) => ({ kind, value })) };
    },
  };
}

export async function b0AssessmentPredictor(modelDir: string): Promise<BrainAssessmentPredictor> {
  const model = await loadRouterModel(modelDir);
  const sha256 = createHash('sha256').update(await readFile(resolve(modelDir, 'router-b0.bin'))).digest('hex');
  return {
    name: 'router-b0-text-only', dimensions: ['route'], confidenceKind: 'raw', artifact: { id: 'router-b0', sha256 },
    limitations: ['The exported B0 model receives current text only. It does not consume history, pending-question state or capability availability. Its score is not a full-brain or task-success measurement.'],
    // The exported B0 currently accepts only text. Supplying invented separators/history
    // would change its trained input distribution and overstate context support.
    predict: input => routeWithModel(model, input.text),
  };
}

export async function runBrainAssessment(args: BrainAssessmentArguments): Promise<{ reports: BrainAssessmentReport[]; output: string }> {
  const dataset = validateBrainAssessmentDataset(JSON.parse(await readFile(args.dataset, 'utf8')));
  const predictors = [rulesAssessmentPredictor(), requestContextAssessmentPredictor(), routingDecisionAssessmentPredictor()];
  if (args.modelDir) predictors.push(await b0AssessmentPredictor(args.modelDir));
  const reports: BrainAssessmentReport[] = [];
  for (const predictor of predictors) reports.push(await evaluateBrainAssessment(dataset, predictor, { split: args.split }));
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, JSON.stringify({ kind: 'brain-assessment-comparison-v1', reports }, null, 2) + '\n', 'utf8');
  return { reports, output: args.output };
}

async function main(): Promise<void> {
  const { reports, output } = await runBrainAssessment(brainAssessmentArguments(process.argv.slice(2)));
  for (const report of reports) {
    const { correct, total, accuracy, forbiddenRouteCount } = report.metrics;
    console.log(`${report.predictor.name}: ${correct}/${total} exact routes (${(accuracy * 100).toFixed(1)}%), forbidden routes ${forbiddenRouteCount}, p95 ${report.latency.p95Ms.toFixed(2)} ms`);
    for (const [category, metric] of Object.entries(report.byCategory)) console.log(`  ${category}: ${metric.correct}/${metric.total}`);
  }
  console.log(`Report: ${output}`);
  console.log('Visible agent-authored development benchmark. No execution success or general intelligence score is measured.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error(error instanceof Error ? error.message : 'BRAIN_ASSESSMENT_FAILED');
    process.exitCode = 1;
  });
}
