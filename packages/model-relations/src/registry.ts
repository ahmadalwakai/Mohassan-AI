import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { monitorDecisionModelId } from './monitor-decision.js';

export type ModelState = 'absent' | 'experimental' | 'shadow' | 'active';
export type ModelRuntimeKind = 'node-cpu' | 'python-worker' | 'gpu';

export interface ModelArtifact {
  readonly role: string;
  readonly path: string;
  readonly sha256: string | null;
  readonly optional?: boolean;
  /** Existing environment variable selecting a directory unless envFile is set. */
  readonly env?: string;
  readonly envFile?: boolean;
  readonly childDirEnv?: string;
  readonly workerConfigField?: 'checkpoint' | 'tokenizer';
  readonly pin?: { readonly reference: string; readonly keys: readonly string[] };
}

type MeasurementLanguage = 'ar' | 'en';
type MeasurementText = Readonly<Record<MeasurementLanguage, string>>;

interface MeasurementResult {
  readonly language: MeasurementLanguage;
  readonly numerator: number;
  readonly denominator: number;
}

interface ModelMeasurement {
  readonly metric: MeasurementText;
  readonly split: MeasurementText;
  readonly results: readonly [MeasurementResult, ...MeasurementResult[]];
  readonly source: { readonly path: string; readonly section: string };
}

export interface ModelEntry {
  readonly id: string;
  readonly version: string;
  readonly task: string;
  readonly owner: string;
  readonly artifacts: readonly ModelArtifact[];
  readonly runtime: ModelRuntimeKind;
  readonly input: string;
  readonly output: string;
  readonly resources: { readonly memoryMb: number; readonly cpu: number; readonly gpu: boolean; readonly latencyMs: number };
  /** Upstream application state when artifact files are present. The manager still applies its own mode. */
  readonly state: Exclude<ModelState, 'absent'>;
  readonly gates: readonly { readonly name: string; readonly receipt: string }[];
  /** A measurement with committed per-language evidence, if available. */
  readonly measurement: ModelMeasurement | 'not measured';
  readonly dataCard: string;
  readonly license: string;
  readonly dependencies: readonly { readonly id: string; readonly version: string }[];
  readonly workerHead?: string;
  readonly modelIdentity?: string;
  readonly activationFlag?: string;
}

export interface ResolvedArtifact {
  readonly role: string;
  readonly path: string;
  /** Observed digest when verification was requested, otherwise the known pin. */
  readonly sha256: string | null;
  readonly expectedSha256?: string | null;
  readonly matchesPin?: boolean | null;
  readonly present: boolean;
  readonly required: boolean;
}

export interface ResolvedModel {
  readonly entry: ModelEntry;
  readonly state: ModelState;
  readonly artifacts: readonly ResolvedArtifact[];
}

const internal = 'No model redistribution license declared. See data card for source terms.';
const cpu = (memoryMb: number, latencyMs: number) => ({ memoryMb, cpu: 1, gpu: false, latencyMs });
const worker = (latencyMs: number) => cpu(4096, latencyMs);
const artifact = (role: string, path: string, sha256: string | null = null): ModelArtifact => ({ role, path, sha256 });
const gate = (name: string, receipt: string) => ({ name, receipt });
const text = '{ text: string }';
const tokenIds = '{ inputIds: number[] }';
const selectionInput = '{ inputIds: number[]; candidatePositions: number[] }';
const selectionOutput = '{ scores: number[]; selectedIndex: number | null; selectedPosition: number; abstained: boolean; confidence: number }';
const classifyOutput = '{ logits: number[]; classIndex: number; label?: string; abstained: boolean; confidence: number }';
const generateInput = '{ inputIds: number[]; maxNewTokens: number; temperature?: number; topK?: number; topP?: number; seed?: number }';
const generateOutput = '{ tokenIds: number[]; stopReason: string; text?: string; inputTokens?: number }';
const rawGenerateInput = `${generateInput}, or the same with text (one chat turn) or prompt (raw text continuation) instead of inputIds`;
const headsTextInput = '{ text: string; history?: string[]; candidates?: string[] }';
const workerConfig: ModelArtifact = { role: 'worker-config', path: '.data/model-worker.json', sha256: null, env: 'MOHASSAN_MODEL_WORKER_CONFIG', envFile: true };
const assistantModule = 'apps/server/src/assistant/';
const v5Dir = 'artifacts/execution-model-runs/text-b5-2026-11-23';
const v5Config = 'artifacts/chat-training/v5/foundation-20261123/config.json';
const v4Dir = 'artifacts/execution-model-runs/text-b4-2026-11-18/stage-3-full';
const adsDir = 'artifacts/execution-model-runs/text-b2-2026-11-12';
const v5Dependency = { id: 'chat-v5', version: 'v5-foundation' };
const v4Dependency = { id: 'chat-v4', version: 'v4-stage-3-full' };
const scratchDir = 'packages/scratch-classifiers/models';
const scratchManifest = artifact('manifest', `${scratchDir}/manifest.json`, '29bc7d006d89fdb60fadd0a3fe77a308cbc6372bfac6e8d04e2e3e2beab65b05');
const scratchCard = 'packages/scratch-classifiers/DATA-CARD.md';
const routerPlan = 'docs/ROUTER-MODEL-PLAN-2026-11-20.md';
const executionReport = 'docs/EXECUTION-MODEL-REPORT-2026-11-12.md';
const imageReport = 'docs/IMAGE-READING-2026-11-22.md';
const responseReport = 'docs/RESPONSE-QUALITY-RESULTS-2026-11-22.md';
const developmentPlan = 'docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md';
const v5OwnerReport = 'docs/V5-OWNER-CHAT-2026-11-26.md';
const contextExperiment = 'scripts/router/CONTEXT-EXPERIMENT.md';
const slotDir = 'artifacts/brain-slot-development-v1/typescript-export-v1-20261121-b';
const datePlaceDir = 'artifacts/brain-slot-date-place-typescript-v1/typescript-export-v1-20261121-a';
const notMeasured = 'not measured';

function scratch(id: string, file: string, task: string, sha256: string, gates: ModelEntry['gates'] = []): ModelEntry {
  return {
    id: `scratch-${id}`, version: 'v1-exclusion-20261125', task, owner: 'packages/scratch-classifiers/src/index.ts',
    artifacts: [scratchManifest, artifact('weights', `${scratchDir}/${file}.json`, sha256)],
    runtime: 'node-cpu', input: '{ text: string; previousText?: string; topK?: number }',
    output: '{ label?: string; abstained: boolean; topK: { label: string; score: number }[] }',
    resources: cpu(8, 20), state: 'shadow', activationFlag: 'MOHASSAN_SCRATCH_CLASSIFIERS', gates, measurement: notMeasured,
    dataCard: scratchCard, license: internal, dependencies: [],
  };
}

function head(id: string, workerHead: string, task: string, operation: 'classify' | 'select'): ModelEntry {
  const dir = `artifacts/head-training/v5-first/${workerHead}`;
  return {
    id, version: 'v5-sidecar-v1', workerHead, task,
    owner: 'packages/head-training/head_training/export.py',
    artifacts: [artifact('worker-config', `${dir}/worker.json`), artifact('head-manifest', `${dir}/sidecar/sidecar.json`),
      artifact('weights', `${dir}/sidecar/weights.pt`), artifact('training-manifest', `${dir}/manifest.json`),
      { ...artifact('adapted-checkpoint', `${dir}/sidecar/adapted-trunk.pt`), optional: true }],
    runtime: 'python-worker', input: `${operation === 'select' ? selectionInput : tokenIds} or ${headsTextInput}`,
    output: operation === 'select' ? selectionOutput : classifyOutput,
    resources: worker(2000), state: 'experimental', gates: [], measurement: notMeasured,
    dataCard: 'packages/head-training/DATASETS.md', license: internal, dependencies: [v5Dependency],
  };
}

function execution(id: string, version: string, directory: string, configured = false): ModelEntry {
  const dir = `artifacts/execution-model-runs/${directory}`;
  return {
    id, version, task: 'Constrained execution task generation', owner: 'packages/execution-model/execution_model/inference.py',
    artifacts: [['manifest', 'manifest.json'], ['config', 'config.json'], ['tokenizer', 'tokenizer.json'], ['weights', 'weights.pt']]
      .map(([role, name]) => ({ ...artifact(role, `${dir}/${name}`), ...(configured ? { env: 'EXECUTOR_CHECKPOINT' } : {}) })),
    runtime: 'python-worker', input: generateInput, output: generateOutput,
    resources: worker(60_000), state: 'experimental', gates: [], measurement: notMeasured,
    dataCard: executionReport, license: internal, dependencies: [],
  };
}

function router(version: 'b0' | 'b2'): ModelEntry {
  const b0 = version === 'b0';
  const name = `router-${version}`;
  const dir = b0 ? 'artifacts/router' : 'artifacts/router-b2';
  return {
    id: name, version, task: 'Classify the request into one of 14 route labels', owner: `${assistantModule}router.ts`,
    artifacts: [artifact('manifest', `${dir}/${name}.json`),
      { ...artifact('weights', `${dir}/${name}.bin`), pin: { reference: 'manifest', keys: ['sha256'] } },
      ...(b0 ? [{ ...artifact('checkpoint', `${dir}/${name}.pt`), optional: true }] : [])],
    runtime: 'node-cpu', input: text, output: '{ route: string; confidence: number }',
    resources: cpu(160, 40), state: b0 ? 'shadow' : 'experimental',
    gates: b0 ? [gate('Historical R2 and R3; sealed repeat caveat in receipt', `${routerPlan}#8-first-measured-results-2026-11-20`)] : [],
    measurement: notMeasured,
    dataCard: routerPlan, license: internal, dependencies: [],
  };
}

function contextRouter(name: 'text_only' | 'context'): ModelEntry {
  const dir = 'artifacts/router-context-development-v1/first-cpu-20261121-a';
  return {
    id: name === 'context' ? 'router-context-history' : 'router-context-text', version: 'development-v1',
    task: 'Experimental request routing with separately calibrated abstention', owner: 'scripts/router/train_context.py',
    artifacts: [artifact('checkpoint', `${dir}/${name}-checkpoint.pt`), artifact('manifest', `${dir}/${name}-model.json`),
      artifact('weights', `${dir}/${name}-weights.bin`), artifact('calibration', `${dir}/${name}-calibration.json`)],
    runtime: 'python-worker', input: name === 'context' ? '{ text: string; history: string[]; pendingReply: boolean }' : text,
    output: '{ route: string; confidence: number; abstained: boolean }', resources: cpu(256, 100),
    state: 'experimental', gates: [gate('Python to NumPy export parity', `${contextExperiment}#artifacts-and-independent-checks`)],
    measurement: notMeasured,
    dataCard: contextExperiment, license: internal, dependencies: [],
  };
}

function ocr(id: string, version: string, dir: string, trainingRun: string, configured = false): ModelEntry {
  return {
    id, version, task: 'Read Arabic and English text in an image', owner: 'packages/vision/src/ocr-model.ts',
    artifacts: [
      { ...artifact('manifest', `${dir}/manifest.json`), ...(configured ? { env: 'MOHASSAN_OCR_MODEL_DIR' } : {}) },
      { ...artifact('weights', `${dir}/weights.bin`), ...(configured ? { env: 'MOHASSAN_OCR_MODEL_DIR' } : {}),
        pin: { reference: 'manifest', keys: ['weights', 'sha256'] } },
      { ...artifact('training-checkpoint', `${trainingRun}/best.pt`), optional: true },
    ],
    runtime: 'node-cpu', input: '{ path: string } for a local PNG, JPEG or WebP file', output: 'ImageReading from packages/vision/src/index.ts',
    resources: cpu(256, 15_000), state: configured ? 'active' : 'experimental',
    gates: configured ? [gate('Image reader export parity and measured page checks', imageReport)] : [],
    measurement: notMeasured,
    dataCard: 'scripts/vision/README.md', license: internal, dependencies: [],
  };
}

function historical(entry: Pick<ModelEntry, 'id' | 'version' | 'task' | 'owner' | 'artifacts' | 'input' | 'output' | 'dataCard'>
    & Partial<Pick<ModelEntry, 'dependencies' | 'runtime' | 'resources' | 'gates' | 'workerHead' | 'measurement'>>): ModelEntry {
  return { runtime: 'python-worker', resources: worker(2000), state: 'experimental', gates: [], measurement: notMeasured,
    dependencies: [], license: internal, ...entry };
}

export const modelRegistry: readonly ModelEntry[] = [
  {
    id: 'chat-v5', version: 'v5-foundation', workerHead: 'lm', task: 'Shared v5 trunk and causal token generation',
    owner: 'packages/execution-pipeline/scripts/train_v5_foundation.py',
    artifacts: [
      { ...artifact('checkpoint', `${v5Dir}/selected/best.pt`), pin: { reference: `${v5Dir}/selected/manifest.json`, keys: ['files', 'best.pt'] } },
      { ...artifact('tokenizer', `${v5Dir}/tokenizer.json`), pin: { reference: v5Config, keys: ['tokenizer_sha256', 'tokenizer.json'] } },
      { ...artifact('tokenizer-report', `${v5Dir}/tokenizer-report.json`), pin: { reference: v5Config, keys: ['tokenizer_sha256', 'tokenizer-report.json'] } },
      { ...workerConfig, optional: true },
    ],
    runtime: 'python-worker', input: `${generateInput} or the equivalent with text instead of inputIds`,
    output: generateOutput,
    resources: worker(30_000), state: 'experimental',
    gates: [gate('لم يجتز Gate 3', `${v5OwnerReport}#v5-owner-chat-experiment`)],
    // Retrieved 2026-11-27 from https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/docs/V5-OWNER-CHAT-2026-11-26.md#v5-owner-chat-experiment
    measurement: {
      metric: { ar: 'بلوغ رمز نهاية النص (EOS)', en: 'End-of-sequence (EOS) reached' },
      split: { ar: 'اختبارات v5 التجريبية الثابتة', en: 'Frozen experimental v5 probes' },
      results: [
        { language: 'ar', numerator: 49, denominator: 60 },
        { language: 'en', numerator: 47, denominator: 60 },
      ],
      source: { path: v5OwnerReport, section: 'v5 owner chat experiment' },
    },
    dataCard: 'docs/CHAT-MODEL-TRAINING-PLAN.md', license: internal, dependencies: [],
  },
  head('head-clinc-intent', 'clinc-intent', 'CLINC150 intent classification', 'classify'),
  head('head-massive-intent', 'massive-intent', 'MASSIVE intent classification', 'classify'),
  head('head-clinc-domain', 'clinc-domain', 'CLINC150 domain classification', 'classify'),
  head('head-massive-scenario', 'massive-scenario', 'MASSIVE scenario classification', 'classify'),
  head('head-out-of-scope', 'out-of-scope', 'Out-of-scope classification', 'classify'),
  head('head-follow-up', 'follow-up', 'Turn type classification using prior context', 'classify'),
  head('question-edit', 'rewrite', 'Pairwise question-rewrite candidate ranking', 'select'),
  head('head-answer-sentence', 'answer-sentence', 'Select a candidate sentence from retrieved evidence', 'select'),
  head('head-sufficiency', 'sufficiency', 'Evidence sufficiency classification', 'classify'),
  head('head-speech-act', 'speech-act', 'Speech-act classification', 'classify'),
  execution('execution', 'exec-c40m-2026-11-12', 'run-2026-11-12-c/inference-train-40m', true),
  // Each run keeps its inference export in a folder named after the trained size (the owner's artifacts, 2026-11-26).
  execution('execution-c9m', 'exec-c9m-2026-11-12', 'run-2026-11-12-c/inference-train-9m'),
  execution('execution-b', 'exec-b-2026-11-12', 'run-2026-11-12-b/inference-train-6m'),
  execution('execution-a', 'exec-a-2026-11-12', 'run-2026-11-12-a/inference-train-3m'),
  router('b0'),
  router('b2'),
  historical({ id: 'router-b1', version: 'b1', task: 'Historical character transformer router', owner: 'scripts/router/train.py',
    artifacts: [artifact('checkpoint', 'artifacts/router/router-b1.pt')], input: text,
    output: '14 route logits in checkpoint route order', dataCard: routerPlan, resources: cpu(256, 100) }),
  contextRouter('text_only'),
  contextRouter('context'),
  scratch('route', 'route', 'Route classification', '4f6bdc26d32b419ef9c25eeb869597a2375a45dedf3100f97ea41bc95e93de48'),
  scratch('speech-act', 'speechAct', 'Small-talk and speech-act classification', 'b4c77f3de542bdd3abff547f031af6bf53d80e59cb47a691d0332319bdea0e4f'),
  scratch('refusal', 'refusal', 'Refusal and scope classification', 'a0da1a0806622c98a20d8b7af1c29ff7055a5896c6c8b5e7cfba9a977d130e68'),
  scratch('follow-up', 'followUp', 'Follow-up classification', '8d00d3f4ab73e6efabf6c8fe08769cafb0cd843a994711b97725bbc6647a97c7',
    [gate('Capability v2 adoption receipt', 'packages/scratch-classifiers/V2-FOLLOWUP.md')]),
  {
    id: monitorDecisionModelId, version: 'context-v1', task: 'Classify the current conversation monitor decision',
    owner: 'packages/model-relations/src/monitor-decision.ts',
    artifacts: [artifact('manifest', '.data/monitor-decision/manifest.json'),
      { ...artifact('weights', '.data/monitor-decision/weights.json'), pin: { reference: 'manifest', keys: ['weightsSha256'] } },
      { ...artifact('promotion', '.data/monitor-decision/promotion.json'), optional: true }],
    runtime: 'node-cpu', input: '{ frameFeatures: Record<string, number>; textFeatureIds: number[] }',
    output: '{ label: string | null; score: number }', resources: cpu(8, 20), state: 'shadow',
    gates: [], measurement: notMeasured, dataCard: 'docs/MONITOR-CONTEXT-DECISION-MODEL.md', license: internal, dependencies: [],
  },
  {
    id: 'refusal', version: 'v1-exclusion-20261125', task: 'Flag unsafe and out-of-scope text', owner: `${assistantModule}refusal/learned-classifier.ts`,
    artifacts: [artifact('weights', `${assistantModule}refusal/learned-model.json`, 'e79b38d5d57bcb945dd9290627b3e6813a8a2d7924d73495c3c3649c11ab25bf')],
    runtime: 'node-cpu', input: text, output: '{ label: "allow" | "out_of_scope" | "unsafe"; confidence: number; abstained: boolean }',
    resources: cpu(8, 120), state: 'experimental', activationFlag: 'MOHASSAN_REFUSAL_POLICY',
    gates: [gate('Accepted calibrated precision thresholds', 'scripts/refusal-classifier/README.md')],
    measurement: notMeasured,
    dataCard: 'scripts/refusal-classifier/README.md', license: internal, dependencies: [],
  },
  {
    id: 'arithmetic', version: 'expression-search-v1', task: 'Rank English expression candidates and decide acceptance',
    owner: `${assistantModule}arithmetic-search-ranker.ts`,
    artifacts: [artifact('weights', `${assistantModule}arithmetic-search-model.json`, 'fef323bb9e24b1aa4fa96c51ac585721c836ea4afe4b882c7ad322f3eccd0ebf')],
    runtime: 'node-cpu', input: text, output: 'Accepted expression and exact value, or null when the ranker abstains',
    resources: cpu(256, 1500), state: 'experimental', activationFlag: 'MOHASSAN_ARITHMETIC_SEARCH',
    gates: [], measurement: notMeasured, dataCard: 'docs/WORD-PROBLEM-SOLVER-DATA.md', license: internal, dependencies: [],
  },
  ocr('ocr', 'ocr-v1-real2', 'artifacts/vision/ocr-v1', 'artifacts/vision-real-v1/run-2', true),
  ocr('ocr-base', 'ocr-v1', 'artifacts/vision/ocr-v1-base', 'artifacts/vision-ocr-v1/run-1'),
  ocr('ocr-v2', 'ocr-v2', 'artifacts/vision/ocr-v2', 'artifacts/vision-ocr-v2/run-1'),
  {
    id: 'google-ads-pointer', version: 'goal-tagger-v1', workerHead: 'goal-tagger',
    task: 'Extract structured Google Ads GoalTagger fields', owner: 'packages/execution-pipeline/execution_pipeline/goal_tagger.py',
    artifacts: [workerConfig,
      { ...artifact('checkpoint', '.data/model-worker.json#model.checkpoint.path'), workerConfigField: 'checkpoint' },
      { ...artifact('tokenizer', '.data/model-worker.json#model.tokenizer.path'), workerConfigField: 'tokenizer', optional: true }],
    runtime: 'python-worker', input: text, output: 'GoalTagger span scores and decoded structured fields',
    resources: worker(15_000), state: 'experimental', gates: [], measurement: notMeasured,
    dataCard: 'docs/ADS-GOAL-LABELING-GUIDE.md', license: internal, dependencies: [],
  },
  {
    id: 'google-ads-pointer-lm', version: 'pointer-v3', workerHead: 'lm',
    task: 'Generate structured Ads fields with the historical dense pointer checkpoint', owner: 'apps/server/src/ads-lab.ts',
    artifacts: [
      { ...artifact('checkpoint', `${adsDir}/pointer-v3/best.pt`), env: 'ADS_MODEL_RUN', childDirEnv: 'ADS_CHAT_FINETUNE' },
      { ...artifact('settings', `${adsDir}/pointer-v3/settings.json`), env: 'ADS_MODEL_RUN', childDirEnv: 'ADS_CHAT_FINETUNE' },
      { ...artifact('tokenizer', `${adsDir}/tokenizer.json`), env: 'ADS_MODEL_RUN' },
      { ...artifact('tokenizer-report', `${adsDir}/tokenizer-report.json`), env: 'ADS_MODEL_RUN', optional: true },
    ],
    runtime: 'python-worker', input: `${generateInput} or the equivalent with text instead of inputIds`, output: generateOutput,
    resources: worker(90_000), state: 'experimental', gates: [], measurement: notMeasured,
    dataCard: 'docs/ADS-GOAL-LABELING-GUIDE.md', license: internal, dependencies: [],
  },
  {
    id: 'slot-tagger', version: 'typescript-v1', modelIdentity: '8cbf99a72abcf18d433a4be4a659aa812c71c88ce814a0a35dc5522da0c7846a',
    task: 'Detect date and place spans with the original BIO tagger', owner: `${assistantModule}slot-tagger.ts`,
    artifacts: [artifact('manifest', `${slotDir}/manifest.json`),
      artifact('weights', `${slotDir}/weights.bin`, 'ece9ceb346bf71265f6f26e82d04e60207b5d0fe6b8a4863a327107f9b076fad')],
    runtime: 'node-cpu', input: text, output: 'SlotTaggerResult with literal source spans and confidences',
    resources: cpu(16, 100), state: 'experimental',
    gates: [gate('NumPy and TypeScript export parity', 'scripts/router/SLOT-TYPESCRIPT-BRIDGE.md')],
    measurement: notMeasured,
    dataCard: 'scripts/router/SLOT-EXPERIMENT.md', license: internal, dependencies: [],
  },
  {
    id: 'slot-date-place-tagger', version: 'typescript-v1', modelIdentity: '4443f07d0322db1326de784b5aae4b04023cd4b3125877a8de854bf7d96e9314',
    task: 'Detect date and place spans with a dedicated five-tag BIO tagger', owner: `${assistantModule}slot-date-place-tagger.ts`,
    artifacts: [artifact('manifest', `${datePlaceDir}/manifest.json`, '6dfce87cff685e36a1a58b164b444d3527a4ac63593d8c9f727c11aeb331637b'),
      artifact('weights', `${datePlaceDir}/weights.bin`, '3b1e0c3a6ec1e4a9f5057aad3358271e592850084e9e23e05fe1828717267e64')],
    runtime: 'node-cpu', input: text, output: 'DatePlaceSlotResult with literal source spans and confidences',
    resources: cpu(16, 100), state: 'experimental',
    gates: [gate('Independent TypeScript parity and bundle audits', 'scripts/router/SLOT-DATE-PLACE-TS-BRIDGE.md#parity-evidence-and-limits')],
    measurement: notMeasured,
    dataCard: 'scripts/router/SLOT-DATE-PLACE-EXPERIMENT.md', license: internal, dependencies: [],
  },
  historical({ id: 'chat-v4', version: 'v4-stage-3-full', task: 'Historical 38M chat foundation', workerHead: 'lm',
    owner: 'packages/execution-pipeline/scripts/train_full_foundation.py', input: rawGenerateInput, output: generateOutput,
    // Retrieved 2026-11-27 from https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md#12-النماذج-الخاصة
    measurement: {
      metric: { ar: 'اجتياز الاستمرار الدلالي', en: 'Semantic continuation passes' },
      split: { ar: 'اختبار Gate 3', en: 'Gate 3 evaluation' },
      results: [
        { language: 'ar', numerator: 0, denominator: 20 },
        { language: 'en', numerator: 0, denominator: 20 },
      ],
      source: { path: developmentPlan, section: '1.2 النماذج الخاصة' },
    },
    artifacts: [artifact('checkpoint', `${v4Dir}/selected/best.pt`, '887bb54c58bf93cea2ad04e79b68379d66dd5e40556a0f6d980c4ad6f83ec9fd'),
      artifact('tokenizer', `${v4Dir}/tokenizer.json`), artifact('tokenizer-report', `${v4Dir}/tokenizer-report.json`)], dataCard: 'docs/CHAT-MODEL-TRAINING-PLAN.md' }),
  // The reading fine-tunes continue a plain prompt: passage, «Question: …» and «Answer:» (scripts/context-use/run_context_test.py).
  ...['reading-v3-last', 'reading-v4-hn-last'].map(id => historical({ id, version: id, workerHead: 'lm',
    task: 'Historical extractive reading model', owner: 'scripts/context-use/run_context_test.py',
    artifacts: [artifact('checkpoint', `${v4Dir}/${id}/best.pt`),
      artifact('tokenizer', `${v4Dir}/tokenizer.json`), artifact('tokenizer-report', `${v4Dir}/tokenizer-report.json`)],
    input: rawGenerateInput, output: 'Generated answer or abstention text',
    dataCard: responseReport, dependencies: [v4Dependency] })),
  historical({ id: 'reading-abstain-verifier', version: 'v1-20261120',
    task: 'Determine if an experimental reading model should abstain', owner: 'scripts/context-use/abstain_verifier.py',
    artifacts: [artifact('weights', 'artifacts/abstain-verifier-20261120/verifier.json')], input: 'Frozen reader signal vector from FEATS',
    output: 'Calibrated binary abstention', dataCard: developmentPlan, dependencies: [{ id: 'reading-v3-last', version: 'reading-v3-last' }] }),
  historical({ id: 'reading-dense-retriever', version: 'v1-20261121', task: 'Rank passages by experimental dense similarity',
    owner: 'scripts/context-use/retriever.py', artifacts: [artifact('checkpoint', 'artifacts/retriever-20261121/final.pt')],
    input: '{ question: string; passages: string[] }', output: 'Ranked passage indices and similarity scores',
    runtime: 'gpu', resources: { ...worker(2000), gpu: true }, dataCard: developmentPlan, dependencies: [v4Dependency] }),
  ...['pretrain', 'bilingual-code-v1', 'bilingual-code-v2'].map(version => historical({
    id: version === 'pretrain' ? 'ads-code-foundation' : `ads-${version}`, version, workerHead: 'lm',
    task: version === 'pretrain' ? 'Historical local Ads and code foundation' : 'Historical bilingual Ads and code generation',
    owner: 'scripts/record-model-assessment.py', input: generateInput, output: generateOutput,
    artifacts: [artifact('checkpoint', `${adsDir}/${version}/best.pt`, version === 'bilingual-code-v2'
      ? 'ece9513215d72fae080bd72c216e08c8b1e3229e307275b3938d1a713948800d' : null),
    artifact('tokenizer', `${adsDir}/tokenizer.json`), artifact('tokenizer-report', `${adsDir}/tokenizer-report.json`)],
    dataCard: 'docs/CODEX-TASK-INDEPENDENT-V2.md',
  })),
  ...[
    ['ads-v4-head', 'heads-t1-20261122/head', 'trainable-best.pt', 't1_head_forms.py'],
    ['ads-v4-lora', 'heads-t1-rerun-20261122/lora', 'trainable-best.pt', 't1_head_forms.py'],
    ['ads-v4-last2', 'heads-t1-rerun-20261122/last2', 'trainable-best.pt', 't1_head_forms.py'],
    ['reading-v4-head', 'heads-t1-reading-20261122/head', 'trainable-last.pt', 't1_reading.py'],
    ['reading-v4-lora', 'heads-t1-reading-20261122/lora', 'trainable-last.pt', 't1_reading.py'],
    ['reading-v4-last2', 'heads-t1-reading-20261122/last2', 'trainable-last.pt', 't1_reading.py'],
  ].map(([id, dir, filename, owner]) => historical({
    id, version: 't1-20261122', task: 'Historical trainable parameter delta for the v4 foundation',
    owner: `scripts/heads/${owner}`, input: generateInput, output: generateOutput,
    artifacts: [artifact('weights', `artifacts/${dir}/${filename}`)], dataCard: responseReport, dependencies: [v4Dependency],
  })),
];

export function getModelEntry(id: string): ModelEntry | undefined {
  return modelRegistry.find(entry => entry.id === id);
}

const measurementLanguages: Record<MeasurementLanguage, MeasurementText> = {
  ar: { ar: 'العربية', en: 'Arabic' },
  en: { ar: 'الإنجليزية', en: 'English' },
};

export function modelMeasurementLabel(id: string, locale: MeasurementLanguage = 'ar'): string {
  const measurement = getModelEntry(id)?.measurement ?? notMeasured;
  if (measurement === notMeasured) {
    return locale === 'ar' ? 'لا قياس موثّق ببسط ومقام لكل لغة' : 'No measurement with documented per-language counts';
  }
  const scores = measurement.results.map(({ language, numerator, denominator }) =>
    `${measurementLanguages[language][locale]} ${numerator}/${denominator}`).join(' · ');
  return `${measurement.metric[locale]} · ${measurement.split[locale]} · ${scores} · ${measurement.source.path} § ${measurement.source.section}`;
}

function relativeArtifactPath(root: string, item: ModelArtifact, env: NodeJS.ProcessEnv): string {
  const override = item.env ? env[item.env]?.trim() : undefined;
  const child = item.childDirEnv ? env[item.childDirEnv]?.trim() : undefined;
  if (item.envFile && override) return resolve(root, override);
  if (item.childDirEnv) return resolve(root, override || dirname(dirname(item.path)), child || basename(dirname(item.path)), basename(item.path));
  return override ? resolve(root, override, basename(item.path)) : resolve(root, item.path);
}

const sha256Pattern = /^[a-f0-9]{64}$/;

async function readMetadata(path: string): Promise<unknown> {
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16 * 1024 * 1024) return undefined;
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== info.size) return undefined;
      return JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function digest(value: unknown): string | null {
  return typeof value === 'string' && sha256Pattern.test(value) ? value : null;
}

function workerArtifact(config: unknown, configPath: string, name: NonNullable<ModelArtifact['workerConfigField']>): { path: string; sha256: string } | undefined {
  const model = field(config, 'model');
  if (field(field(model, 'checkpoint'), 'format') !== 'goal-tagger') return undefined;
  const item = field(model, name);
  const path = field(item, 'path');
  const sha256 = digest(field(item, 'sha256'));
  if (typeof path !== 'string' || !path.trim() || path.includes('\0') || !sha256) return undefined;
  return { path: resolve(dirname(configPath), path), sha256 };
}

async function resolveArtifact(item: ModelArtifact, path: string, expectedSha256: string | null, verify: boolean): Promise<ResolvedArtifact> {
  let present = false;
  let sha256 = expectedSha256;
  let matchesPin: boolean | null = null;
  try {
    present = (await stat(path)).isFile();
    if (verify && present) {
      const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Expected a regular model artifact');
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        sha256 = hash.digest('hex');
        if (expectedSha256) matchesPin = sha256 === expectedSha256;
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') present = false;
    else if (verify) {
      // Permission or I/O errors on a known file are reported as an integrity/readiness failure.
      present = true;
      sha256 = null;
      matchesPin = false;
    }
  }
  return { role: item.role, path, sha256, expectedSha256, matchesPin, present, required: !item.optional };
}

/** Resolve artifact locations without loading a model. A caller can skip byte verification for a presence probe. */
export async function resolveModel(entry: ModelEntry, root: string, env: NodeJS.ProcessEnv = process.env, verify = true): Promise<ResolvedModel> {
  const paths = new Map(entry.artifacts.map(item => [item.role, relativeArtifactPath(root, item, env)]));
  const metadata = new Map<string, Promise<unknown>>();
  const read = (path: string) => {
    let content = metadata.get(path);
    if (!content) {
      content = readMetadata(path);
      metadata.set(path, content);
    }
    return content;
  };
  const artifacts = await Promise.all(entry.artifacts.map(async item => {
    const path = paths.get(item.role)!;
    if (item.workerConfigField) {
      const configPath = paths.get('worker-config');
      const configured = configPath && workerArtifact(await read(configPath), configPath, item.workerConfigField);
      if (!configured) return { role: item.role, path, sha256: null, present: false, required: !item.optional };
      return resolveArtifact(item, configured.path, configured.sha256, verify);
    }
    const pointer = item.pin;
    const pin = pointer && digest(pointer.keys.reduce(field, await read(paths.get(pointer.reference) ?? resolve(root, pointer.reference))));
    return resolveArtifact(item, path, item.sha256 ?? pin ?? null, verify);
  }));
  const configuredState = entry.activationFlag && env[entry.activationFlag] === '1' ? 'active' : entry.state;
  const state = artifacts.some(item => item.required && !item.present) ? 'absent' : configuredState;
  return { entry, state, artifacts };
}

/**
 * Resolves against several roots in order and keeps the first where every required artifact is present, e.g. a server's
 * model store before its code checkout, which carries only the small checked-in models. All absent: the first root's result.
 */
export async function resolveModelInRoots(entry: ModelEntry, roots: readonly string[], env: NodeJS.ProcessEnv = process.env,
    verify = true): Promise<ResolvedModel> {
  if (!roots.length) throw new RangeError('At least one model root is required');
  let first: ResolvedModel | undefined;
  for (const root of roots) {
    // A presence probe first, so only the chosen root's bytes are hashed.
    const probe = await resolveModel(entry, root, env, false);
    if (probe.state !== 'absent') return verify ? resolveModel(entry, root, env, true) : probe;
    first ??= probe;
  }
  return first!;
}

/** The roots a process resolves models against: MOHASSAN_MODELS_ROOT (the server's model store) first, then the checkout. */
export function modelRoots(checkout: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const store = env.MOHASSAN_MODELS_ROOT?.trim();
  return store && resolve(store) !== resolve(checkout) ? [resolve(store), resolve(checkout)] : [resolve(checkout)];
}
