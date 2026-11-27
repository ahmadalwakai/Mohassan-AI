import type { FastifyInstance } from 'fastify';
import type { ActivationObservation, ActivationSwitch } from '@mohassan/contracts';
import { join } from 'node:path';
import { modelRoots } from '../../../../packages/model-relations/src/registry.js';
import type { AppConfig } from '../app.js';
import { conversationDecisionEnabled } from '../assistant/conversation-state-chat.js';
import { judgeSettings } from '../assistant/judge-shadow.js';
import { modelRelationsManager } from '../assistant/model-relations-arbiter.js';
import { serverModelWorkerHealth } from '../model-worker.js';
import { monitorDecisionShadowEnabled } from '../monitors/decision/shadow.js';
import { monitorContextEnabled, monitorContextShadowEnabled, monitorRollout, monitorSourceFlags, smartMonitorsV2Enabled } from '../monitors/flag.js';
import { productionMetricsSettings } from '../ops/metrics/index.js';
import { getActivationEvidence } from './evidence.js';
import { generatedSwitchRegistry } from './switch-registry.generated.js';

export interface ActivationRuntime {
  app: FastifyInstance;
  config: AppConfig;
  live: { modelCouncil: boolean; routerShadow: boolean; conversationShadow: boolean; ocrAvailable: boolean };
}

const credentialName = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?|COOKIE|AUTHORIZATION|URL)(?:_|$)/i;
const url = /(?:\/\/[^/\s]|\bmailto:)/i;
const on = (value: unknown) => value ? 'on' : 'off';

/** URLs can carry credentials in their query, fragment or path as well as userinfo. */
export function maskActivationValue(value: string | undefined | null, sensitive = false): string | null {
  if (sensitive || (value && url.test(value))) return value?.trim() ? 'set' : 'not set';
  return value ?? null;
}

function currentOverrides({ app, config, live }: ActivationRuntime, env: NodeJS.ProcessEnv): Readonly<Record<string, string | undefined>> {
  const sources = monitorSourceFlags(env);
  const judge = judgeSettings(config.production, env, process.cwd());
  const worker = serverModelWorkerHealth(app).modelWorker?.state;
  return {
    NODE_ENV: config.production ? 'production' : Reflect.get(env, 'NODE_ENV'),
    RUN_WORKER: on(config.runWorker),
    DATABASE_URL: config.databaseUrl,
    BETTER_AUTH_SECRET: config.authSecret,
    INTERNAL_API_SECRET: config.internalSecret,
    SETUP_TOKEN: config.setupToken,
    MOHASSAN_V5_CHAT: config.v5Chat ?? 'off',
    MOHASSAN_MODEL_WORKER: worker === 'ready' ? 'on' : worker ?? 'off',
    MOHASSAN_MODEL_COUNCIL: live.modelCouncil ? 'owner' : 'off',
    MOHASSAN_MODELS_ROOT: modelRoots(process.cwd(), env).join(' · '),
    MOHASSAN_OCR_MODEL_DIR: live.ocrAvailable ? Reflect.get(env, 'MOHASSAN_OCR_MODEL_DIR') ?? join(process.cwd(), 'artifacts', 'vision', 'ocr-v1') : 'unavailable',
    MOHASSAN_MIND: on(config.mindEnabled === true && !config.production),
    SKILL_ENGINE_ENABLED: on(config.skillEngineEnabled),
    SKILL_REMOTE_REPO: config.skillRemote?.config?.repo ?? 'off',
    SKILL_REMOTE_AUTO_ACTIVATE: on(config.skillRemote?.config?.autoActivate),
    WINDOWS_REMOTE_ENABLED: on(config.windowsEnabled),
    DESKTOP_ENGINE: on(config.desktop?.enabled),
    MOHASSAN_DESKTOP_SHELL: on(config.trainingMonitorRoot),
    EXECUTOR_EXPERIMENT: config.executor?.enabled ? 'uncontained-local' : 'off',
    LEARNING_EVALUATION_MODEL: config.learningLocalModel?.model ?? 'off',
    STUDIO_GATEWAY_URL: config.studioGatewayUrl,
    SITES_PUBLISH_TARGET: config.sites?.publishTarget ?? 'none',
    GOOGLE_ADS_PUBLISHING_ENABLED: on(config.googleAds?.publishingEnabled),
    FREELLMAPI_ENABLED: on(config.inference?.freellmapi?.enabled),
    FREELLMAPI_API_KEY: config.inference?.freellmapi?.apiKey,
    FREELLMAPI_FREE_ONLY: on(config.inference?.freellmapi?.freeOnly),
    AI_AUTOMATIC_FALLBACK: on(config.inference?.automaticFallback),
    AI_ALLOW_PAID_FALLBACK: on(config.inference?.allowPaidFallback),
    MOHASSAN_ROUTER_SHADOW: live.routerShadow ? 'shadow' : 'off',
    MOHASSAN_CONVERSATION_SHADOW: conversationDecisionEnabled(env) ? 'decide' : live.conversationShadow ? 'shadow' : 'off',
    MOHASSAN_JUDGE_SHADOW: on(judge.enabled),
    MOHASSAN_JUDGE_FIX: on(judge.enabled && judge.fixForOwner),
    MOHASSAN_JUDGE_WITHHOLD: on(judge.enabled && judge.withholdForOwner),
    MOHASSAN_CONVERSATION_REVIEW_APPLY: on(judge.enabled && Reflect.get(env, 'MOHASSAN_CONVERSATION_REVIEW_APPLY') === '1'),
    MOHASSAN_MONITORS_ENABLED: monitorRollout(env),
    MOHASSAN_MONITORS_V2: on(smartMonitorsV2Enabled(env)),
    MOHASSAN_MONITORS_GITHUB: on(sources.github),
    MOHASSAN_MONITORS_PDF: on(sources.pdf),
    MOHASSAN_MONITORS_VISUAL: on(sources.visual),
    MOHASSAN_MONITOR_CONTEXT: on(monitorContextEnabled(env)),
    MOHASSAN_MONITOR_CONTEXT_SHADOW: on(monitorContextShadowEnabled(env) && monitorDecisionShadowEnabled()),
    MOHASSAN_ARBITER_ROUTING: on(modelRelationsManager.canApplyArbiter('routing')),
    MOHASSAN_ARBITER_QUESTION_REWRITE: on(modelRelationsManager.canApplyArbiter('question-rewrite')),
    MOHASSAN_ARBITER_LOCAL_COMPUTATION: on(modelRelationsManager.canApplyArbiter('local-computation')),
    MOHASSAN_ARBITER_COMPOUND_PLAN: on(modelRelationsManager.canApplyArbiter('compound-plan')),
    MOHASSAN_ARBITER_MONITOR_CONTEXT: on(modelRelationsManager.canApplyArbiter('monitor-context')),
    PRODUCTION_METRICS_ENABLED: on(productionMetricsSettings(config.production, env).enabled),
  };
}

export function readActivationSwitches(runtime: ActivationRuntime, observed: ReadonlyMap<string, ActivationObservation>,
  startup?: ReadonlyMap<string, ActivationSwitch>): ActivationSwitch[] {
  const env = process.env;
  const overrides = currentOverrides(runtime, env);
  return generatedSwitchRegistry.map(entry => {
    const { name, kind, readers, modes } = entry;
    const sensitive = entry.sensitive || credentialName.test(name);
    const raw: string | undefined = Reflect.get(env, name);
    const parsed = modes && raw !== undefined && Object.hasOwn(modes.values, raw) ? modes.values[raw] : modes?.otherwise;
    const current = Object.hasOwn(overrides, name) ? overrides[name] : parsed ?? raw;
    const currentValue = maskActivationValue(current, sensitive || Boolean(raw && url.test(raw)));
    const initial = startup?.get(name);
    const applied = name === 'MOHASSAN_MONITOR_CONTEXT_SHADOW' && initial?.currentValue === 'off' ? 'off'
      : initial && readers.every(reader => reader.needsRestart) && name !== 'MOHASSAN_MODEL_WORKER' ? initial.currentValue
      : currentValue;
    const evidence = getActivationEvidence(name);
    return {
      name, kind, sensitive, currentValue: applied, configuredValue: maskActivationValue(raw, sensitive),
      readers: readers.map(reader => ({ ...reader })),
      ownerTrial: evidence.ownerTrial === null ? null : maskActivationValue(evidence.ownerTrial, sensitive),
      dependencies: [...evidence.dependencies],
      preflight: evidence.preflight && { ...evidence.preflight, args: [...evidence.preflight.args] },
      evidence: evidence.evidence, sources: [...evidence.sources], risk: evidence.risk,
      observation: observed.get(name) ?? null,
    };
  });
}
