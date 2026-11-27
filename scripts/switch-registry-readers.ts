export interface SwitchModes {
  values: Readonly<Record<string, string>>;
  otherwise: string;
}

export interface ReviewedReader {
  defaultValue: string;
  parsing: string;
  kind: 'feature' | 'configuration' | 'process';
  needsRestart: boolean;
  sensitive?: true;
  modes?: SwitchModes;
}

type ModuleReaders = Readonly<Record<string, ReviewedReader>>;

const configuration = (defaultValue: string, parsing: string, needsRestart = true): ReviewedReader => ({
  defaultValue, parsing, needsRestart, kind: 'configuration',
});
const secret = (parsing: string, needsRestart = true): ReviewedReader => ({
  ...configuration('not set', parsing, needsRestart), sensitive: true,
});
const processSetting = (defaultValue: string, parsing: string, needsRestart = false): ReviewedReader => ({
  ...configuration(defaultValue, parsing, needsRestart), kind: 'process',
});
const feature = (defaultValue: string, parsing: string, needsRestart = false, modes?: SwitchModes): ReviewedReader => ({
  defaultValue, parsing, needsRestart, kind: 'feature', modes,
});
const optIn = (input = '1', needsRestart = false, condition = '') =>
  feature('off', `Exact ${input} enables${condition}`, needsRestart, { values: { [input]: 'on' }, otherwise: 'off' });
const optOut = (input: string, needsRestart: boolean, condition = '') =>
  feature('on', `Exact ${input} disables${condition}`, needsRestart, { values: { [input]: 'off' }, otherwise: 'on' });
const owner = (needsRestart = true) =>
  feature('off', 'Exact owner enables for the owner', needsRestart, { values: { owner: 'owner' }, otherwise: 'off' });
const trim = (defaultValue: string, needsRestart = true) =>
  configuration(defaultValue, 'Trim surrounding whitespace and use the default for missing or empty values', needsRestart);
const fallback = (defaultValue: string, needsRestart = true) =>
  configuration(defaultValue, 'Use the default for missing or empty values', needsRestart);
const nil = (defaultValue: string, needsRestart = true) =>
  configuration(defaultValue, 'Use the default only when unset', needsRestart);
const forwarded = processSetting('unset', 'Forward the host setting to the child process');
const vitest = processSetting('unset', 'Any non-empty value indicates a test process', true);
const production = processSetting('unset', 'Exact production selects production behavior', true);
const relations = feature('shadow', 'Exact off disables model relations; all other values leave observation available', false, {
  values: { off: 'off' }, otherwise: 'shadow',
});
const arbiter = feature('off', 'Exact 1 opts in; also requires promoted arbiter, model relations and a clear kill switch', false, {
  values: { '1': 'on' }, otherwise: 'off',
});
const modelOn = (value: string) => feature(value, 'Exact 1 advertises active when required artifacts are present', false);

// Source evidence for this manual review is the module named by each block,
// under https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/ (retrieved 2026-11-27).
// Keep semantic notes here; the scan validates actual keys and modules and the
// generated artifacts carry a checksum of the source expressions.
const serverReaders: Readonly<Record<string, ModuleReaders>> = {
  'config.ts': {
    MOHASSAN_ISOLATED_TEST: processSetting('off', 'Exact true skips the dotenv import for an isolated process', true),
    DATA_DIR: nil('.data/postgres'),
    DATABASE_URL: secret('Empty disables external database selection; local lab also overrides the URL'),
    MOHASSAN_LOCAL_LAB: optIn('1', true, ' local lab and overrides external database selection'),
    BETTER_AUTH_SECRET: secret('Uses an empty string when unset'),
    INTERNAL_API_SECRET: secret('Uses an empty string when unset'),
    SETUP_TOKEN: secret('Uses an empty string when unset'),
    WEB_ORIGIN: nil('http://127.0.0.1:3000'),
    NODE_ENV: production,
    RUN_WORKER: optOut('false', true),
    MOHASSAN_V5_CHAT: owner(),
    SKILL_ENGINE_ENABLED: optIn('true', true),
    MOHASSAN_MIND: optIn('1', true, ' outside production in local lab'),
    MEMBER_DAILY_RUNS: configuration('40 in the API', 'Positive decimal integer from 1 to 9999; invalid or missing defers to the API default'),
    GROQ_MODEL: fallback('openai/gpt-oss-20b'),
    GROQ_REASONING_MODEL: fallback('openai/gpt-oss-120b'),
    CODING_DATA_DIR: fallback('.data/coding resolved against the checkout'),
    CODING_ALLOWED_ROOTS: configuration('working directory', 'Split on the platform path delimiter and discard empty entries'),
    DOCUMENTS_DIR: fallback('.data/documents resolved against the checkout'),
    DOCUMENT_FONTS_DIR: fallback('packages/pdf/fonts resolved against the checkout'),
    WINDOWS_REMOTE_ENABLED: feature('off in production; on elsewhere', 'Production requires exact true; elsewhere exact false disables', true),
    STUDIO_AI_DATA_DIR: fallback('.data/studio-ai resolved against the checkout'),
    BROWSER_PROFILE_DIR: fallback('.data/browser-profile resolved against the checkout'),
    GROQ_VISION_MODEL: fallback('qwen/qwen3.8-27b'),
    GOOGLE_ADS_CLIENT_ID: fallback('unset'),
    GOOGLE_ADS_CLIENT_SECRET: secret('Uses unset for missing or empty values'),
    GOOGLE_ADS_TOKEN_KEY: secret('Uses unset for missing or empty values'),
    GOOGLE_ADS_DEVELOPER_TOKEN: secret('Uses unset for missing or empty values'),
    GOOGLE_ADS_PUBLISHING_ENABLED: optIn('true', true),
    GOOGLE_ADS_MAX_DAILY_BUDGET: configuration('unset', 'One to six decimal digits converted from whole units to micros'),
    LEARNING_EVALUATION_MODEL: feature('off', 'Any non-empty model ID enables local learning evaluation', true),
    LEARNING_EVALUATION_OLLAMA_URL: fallback('http://127.0.0.1:11434'),
    STUDIO_GATEWAY_URL: feature('off', 'Any non-empty URL configures the Studio gateway', true),
    STUDIO_GATEWAY_SECRET: secret('Uses unset for missing or empty values'),
    STUDIO_PREVIEW_PORT: configuration('5000', 'Convert the supplied string to Number; use the default for missing or empty values'),
    VERCEL_TOKEN: { ...secret('Presence enables Vercel publishing unless target is none'), kind: 'feature' },
    VERCEL_TEAM_ID: fallback('unset'),
    SITES_PUBLISH_TARGET: feature('none without a Vercel token; vercel with a token',
      'Exact none disables publishing; other values select by token presence', true),
    DESKTOP_ENGINE: feature('off in production or outside Windows; on in local Windows',
      'Exact false disables the local Windows desktop', true),
    DESKTOP_DATA_DIR: fallback('.data/desktop resolved against the checkout'),
    DESKTOP_PROJECTS_ROOT: fallback('unset'),
    DESKTOP_ALLOWED_ROOTS: configuration('unset', 'Split on the platform path delimiter and discard empty entries'),
    DESKTOP_SCREENSHOTS_DIR: fallback('unset'),
  },
  'app.ts': {
    MOHASSAN_ROUTER_SHADOW: feature('off in production; shadow outside production if the router artifact exists',
      'Exact 0 disables; production, Vitest and absent router artifact also disable', true),
    MOHASSAN_CONVERSATION_SHADOW: feature('off in production; shadow outside production',
      'Exact 0 disables the observer; production and Vitest also disable', true),
    MOHASSAN_OCR_MODEL_DIR: nil('artifacts/vision/ocr-v1 resolved against the checkout'),
    MOHASSAN_OCR_WORKERS: configuration('3', 'Convert the supplied string to Number; use the default only when unset'),
    MOHASSAN_MODEL_COUNCIL: owner(),
    VITEST: vitest,
  },
  'index.ts': {
    SERVER_HOST: nil('127.0.0.1'),
    SERVER_PORT: configuration('4000', 'Convert the supplied string to Number; use the default only when unset'),
  },
  'create-owner.ts': {
    OWNER_NAME: processSetting('unset', 'Owner-creation command requires at least two characters'),
    OWNER_EMAIL: { ...processSetting('unset', 'Owner-creation command requires a valid email'), sensitive: true },
    OWNER_PASSWORD: { ...processSetting('unset', 'Owner-creation command requires 12–128 characters'), sensitive: true },
  },
  'ads-lab.ts': {
    ADS_CHAT_FINETUNE: trim('pointer-v3'),
    ADS_MODEL_DEVICE: configuration('cuda', 'Exact cpu selects CPU; all other values select CUDA'),
    ADS_MODEL_RUN: configuration('unset', 'Trim surrounding whitespace and resolve a non-empty checkpoint path'),
    PATH: forwarded,
    LOCALAPPDATA: forwarded,
    SystemRoot: forwarded,
    TEMP: forwarded,
    TMP: forwarded,
  },
  'apns.ts': {
    APNS_KEY_ID: secret('Trim whitespace; APNs requires all four APNs settings'),
    APNS_KEY_PATH: secret('Trim whitespace; APNs requires all four APNs settings'),
    APNS_TEAM_ID: trim('unset'),
    APNS_BUNDLE_ID: trim('unset'),
  },
  'inference.ts': {
    FREELLMAPI_ENABLED: feature('off', 'Exact true is parsed, then the server overrides it to off', true, { values: {}, otherwise: 'off' }),
    FREELLMAPI_FREE_ONLY: feature('on', 'Missing or empty defaults to on; otherwise exact true is on', true),
    FREELLMAPI_BASE_URL: fallback('http://127.0.0.1:3001/v1'),
    FREELLMAPI_API_KEY: secret('Parsed if non-empty; removed by the server external-provider override'),
    FREELLMAPI_MODELS: configuration('auto', 'Comma-separated, whitespace-trimmed list of at most eight non-empty names'),
    FREELLMAPI_TIMEOUT_MS: configuration('unset', 'Convert to Number and retain positive values'),
    AI_AUTOMATIC_FALLBACK: feature('off', 'Defaults on when parsed; the server then overrides it to off', true, { values: {}, otherwise: 'off' }),
    AI_ALLOW_PAID_FALLBACK: feature('off', 'Exact true is parsed, then the server overrides it to off', true, { values: {}, otherwise: 'off' }),
    GROQ_PRICE_INPUT_PER_MTOK: configuration('unset', 'Convert non-empty values to a finite non-negative number'),
    GROQ_PRICE_OUTPUT_PER_MTOK: configuration('unset', 'Convert non-empty values to a finite non-negative number'),
  },
  'executor.ts': {
    EXECUTOR_EXPERIMENT: feature('off', 'Exact uncontained-local enables outside production', true),
    EXECUTOR_CHECKPOINT: configuration('unset', 'Trim whitespace and resolve a non-empty path'),
    EXECUTOR_REGISTRY_ENTRY: configuration('unset', 'Trim whitespace and resolve a non-empty path'),
    EXECUTOR_EVALUATION_REPORT: configuration('unset', 'Trim whitespace and resolve a non-empty path'),
    EXECUTOR_PYTHON: configuration('.venv-execution/Scripts/python.exe', 'Trim whitespace and resolve a non-empty path'),
    EXECUTOR_DEVICE: configuration('cpu', 'Exact cuda selects CUDA; all other values select CPU'),
    LOCAL_MODEL_URL: trim('unset'),
    EXECUTOR_STARTUP_TIMEOUT_SECONDS: configuration('90 seconds', 'Accept 5–999 whole seconds and convert to milliseconds'),
    EXECUTOR_REQUEST_TIMEOUT_SECONDS: configuration('60 seconds', 'Accept 5–999 whole seconds and convert to milliseconds'),
    SystemRoot: processSetting('Windows system directory fallback', 'Use the provided setting if non-empty'),
  },
  'model-worker.ts': {
    MOHASSAN_MODEL_WORKER: optIn('1', true),
    MOHASSAN_MODEL_WORKER_CONFIG: configuration('.data/model-worker.json', 'Trim whitespace and resolve the config path against the checkout'),
    EXECUTOR_PYTHON: configuration('Platform venv interpreter', 'Trim whitespace and resolve a non-empty path'),
    SystemRoot: forwarded,
  },
  'ops/metrics/index.ts': {
    PRODUCTION_METRICS_ENABLED: feature('on in production; off elsewhere', 'Exact true enables; missing value follows production mode', true),
    PRODUCTION_METRICS_DIR: configuration('production-metrics under state directory or .data', 'Resolve a non-empty directory path'),
    STATE_DIRECTORY: processSetting('.data', 'Take the first host path from the systemd state directory setting', true),
  },
  'assistant/judge-shadow.ts': {
    MOHASSAN_JUDGE_LOG_DIR: trim('.data/judge'),
    MOHASSAN_JUDGE_SHADOW: optOut('0', true, '; Vitest disables regardless'),
    MOHASSAN_JUDGE_FIX: optOut('0', true, ' owner-only repair'),
    MOHASSAN_JUDGE_WITHHOLD: optOut('0', true, ' owner-only withholding'),
    VITEST: vitest,
  },
  'assistant/plan/chat.ts': {
    MOHASSAN_PLAN_COMPILER: feature('off', 'Exact shadow observes; exact on executes', false, { values: { shadow: 'shadow', on: 'on' }, otherwise: 'off' }),
  },
  'assistant/conversation-state-chat.ts': {
    MOHASSAN_CONVERSATION_SHADOW: feature('off', 'Exact decide enables decision handling', false, { values: { decide: 'decide' }, otherwise: 'off' }),
  },
  'assistant/long-run/host.ts': {
    MOHASSAN_LONG_RUN_ENABLED: optIn(),
    MOHASSAN_BACKGROUND_RESULTS_ENABLED: optIn(),
  },
  'assistant/model-relations-arbiter.ts': {
    MOHASSAN_MODEL_RELATIONS: relations,
    MOHASSAN_MODEL_WORKER: feature('heavy model available', 'Exact 1 disables the separate heavy model path'),
    EXECUTOR_EXPERIMENT: feature('heavy model available', 'Exact uncontained-local disables the separate heavy model path'),
    NODE_ENV: processSetting('unset', 'Exact production rejects the arbiter replay helper'),
  },
  'assistant/model-relations-shadow.ts': { MOHASSAN_MODEL_RELATIONS: relations },
  'assistant/response-policy-runtime.ts': {
    MOHASSAN_REPLY_POLICY_ENABLED: optIn(),
    MOHASSAN_CONTEXT_POLICY_ENABLED: optIn(),
    MOHASSAN_LONG_RUN_ENABLED: optIn(),
  },
  'assistant/response-policy-context.ts': { MOHASSAN_CONTEXT_POLICY_ENABLED: optIn() },
  'assistant/request-context.ts': { MOHASSAN_CONTEXT_POLICY_ENABLED: optIn() },
  'assistant/review/publication.ts': { MOHASSAN_CONVERSATION_REVIEW_APPLY: optIn('1', false, ' changes when review and publication allow them') },
  'assistant/manners/chat.ts': { MOHASSAN_SMALL_TALK_MANNERS: optIn() },
  'assistant/clarify/host.ts': { MOHASSAN_CLARIFY_CHOICES: optIn('1', false, ' unless an explicit override is supplied') },
  'assistant/arithmetic-search-settings.ts': { MOHASSAN_ARITHMETIC_SEARCH: optIn() },
  'assistant/writing/request.ts': { MOHASSAN_EXTRACTIVE_WRITING: optIn() },
  'assistant/question-rewrite-chat.ts': { MOHASSAN_QUESTION_REWRITER: optIn('1', false, ' for eligible live turns') },
  'assistant/structured-memory-turn.ts': { MOHASSAN_STRUCTURED_MEMORY: optIn() },
  'assistant/test-driven-coding/request.ts': { TEST_DRIVEN_CODING_ENABLED: optIn('true') },
  'assistant/test-driven-coding/reply.ts': { TEST_DRIVEN_CODING_PYTHON: nil('/usr/bin/python3', false) },
  'assistant/reasoning/index.ts': { MOHASSAN_REASONING: optIn() },
  'assistant/scratch-decisions.ts': { MOHASSAN_SCRATCH_CLASSIFIERS: optIn(), VITEST: vitest },
  'assistant/refusal/settings.ts': { MOHASSAN_REFUSAL_POLICY: optIn() },
  'monitors-phase1/rollout.ts': {
    MOHASSAN_MONITORS_ENABLED: feature('off', 'Exact owner enables for the owner; exact 1 enables for all', true, {
      values: { owner: 'owner', '1': 'all' }, otherwise: 'off',
    }),
  },
  'monitors/flag.ts': {
    MOHASSAN_MONITORS_V2: optIn('1', true, ' when monitors are enabled'),
    MOHASSAN_MONITORS_GITHUB: optIn('1', true, ' when monitors v2 is enabled'),
    MOHASSAN_MONITORS_PDF: optIn('1', true, ' when monitors v2 is enabled'),
    MOHASSAN_MONITORS_VISUAL: optIn('1', true, ' when monitors v2 is enabled'),
    MOHASSAN_MONITOR_CONTEXT: optIn('1', true, ' when monitors v2 is enabled'),
    MOHASSAN_MONITOR_CONTEXT_SHADOW: optIn('1', true, ' when monitors v2 is enabled'),
  },
  'monitors/decision/shadow.ts': {
    MOHASSAN_MONITOR_CONTEXT_SHADOW: optIn('1', false, ' when model relations is not off'),
    MOHASSAN_MODEL_RELATIONS: relations,
  },
  'skill-remote.ts': {
    SKILL_REMOTE_DATA_DIR: trim('.data/skills-remote'),
    SKILL_REMOTE_REPO: feature('off', 'A valid non-empty public owner/repo name configures the remote source', true),
    SKILL_REMOTE_REF: trim('main'),
    SKILL_REMOTE_PATH: trim('skills'),
    SKILL_REMOTE_AUTO_ACTIVATE: optIn('true', true),
    SKILL_REMOTE_SYNC_MINUTES: configuration('30', 'Trim; parse a one- to four-digit decimal or mark invalid'),
  },
  'training-monitor/route.ts': {
    MOHASSAN_DESKTOP_SHELL: feature('off in production; available on loopback elsewhere',
      'Exact 1 permits the training monitor in production when both origins are loopback', true),
    NODE_ENV: production,
    SERVER_HOST: nil('127.0.0.1'),
  },
  'skill-benchmark-runner.ts': { SystemRoot: forwarded, WINDIR: forwarded, TEMP: forwarded, TMP: forwarded },
  'web-push.ts': {
    WEB_PUSH_VAPID_PUBLIC_KEY: secret('Require a matching P-256 key pair and valid subject'),
    WEB_PUSH_VAPID_PRIVATE_KEY: secret('Require a matching P-256 key pair and valid subject'),
    WEB_PUSH_VAPID_SUBJECT: configuration('unset', 'Validate mailto or public HTTPS subject; requires the matching key pair'),
  },
};

const arbiterReaders = Object.fromEntries([
  'ROUTING', 'QUESTION_REWRITE', 'LOCAL_COMPUTATION', 'COMPOUND_PLAN', 'MONITOR_CONTEXT',
].flatMap(decision => [
  [`MOHASSAN_ARBITER_${decision}`, arbiter],
  [`MOHASSAN_ARBITER_${decision}_KILL`, optIn('1', false, ' the kill switch')],
]));

export const reviewedSwitchReaders: Readonly<Record<string, ModuleReaders>> = {
  ...Object.fromEntries(Object.entries(serverReaders).map(([module, entries]) => [`apps/server/src/${module}`, entries])),
  'packages/model-relations/src/manager.ts': { ...arbiterReaders, MOHASSAN_MODEL_RELATIONS: relations },
  'packages/model-relations/src/registry.ts': {
    MOHASSAN_MODELS_ROOT: feature('checkout directory', 'Trim and resolve a model store before the checkout fallback', true),
    MOHASSAN_MODEL_WORKER_CONFIG: configuration('.data/model-worker.json', 'Trim and resolve a direct file override', false),
    EXECUTOR_CHECKPOINT: configuration('entry artifact path', 'Trim and resolve a directory containing the artifact', false),
    MOHASSAN_OCR_MODEL_DIR: configuration('entry artifact path', 'Trim and resolve a directory containing the artifact', false),
    ADS_MODEL_RUN: configuration('entry artifact path', 'Trim and resolve a directory containing the artifact', false),
    ADS_CHAT_FINETUNE: configuration('entry artifact path', 'Trim and resolve a child directory for the artifact', false),
    MOHASSAN_SCRATCH_CLASSIFIERS: modelOn('shadow with artifacts'),
    MOHASSAN_REFUSAL_POLICY: modelOn('experimental with artifacts'),
    MOHASSAN_ARITHMETIC_SEARCH: modelOn('experimental with artifacts'),
  },
  'packages/model-relations/src/worker-adapter.ts': {
    EXECUTOR_DEVICE: configuration('cpu', 'Exact cuda selects CUDA; all other values select CPU', false),
    ADS_MODEL_DEVICE: configuration('cpu', 'Exact cuda selects CUDA for the Google Ads pointer model', false),
    EXECUTOR_PYTHON: configuration('Platform venv interpreter', 'Trim whitespace and resolve a non-empty path', false),
    SystemRoot: forwarded,
  },
  'packages/database/src/index.ts': { NODE_ENV: production },
  'packages/sandbox/src/index.ts': {
    SANDBOX_QUOTA_ROOT: configuration('unset', 'Use the host setting when no explicit quota root is provided', false),
  },
  'packages/coding/src/git.ts': {
    ProgramFiles: processSetting('Windows Program Files fallback', 'Use the default only when unset'),
    LOCALAPPDATA: processSetting('Windows Local AppData fallback', 'Use the default only when unset'),
    SystemRoot: forwarded, WINDIR: forwarded, TEMP: forwarded, TMP: forwarded,
  },
};
