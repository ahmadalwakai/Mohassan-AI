import type { AgentPage, SearchProvider } from '@mohassan/browser';
import type { Kysely } from 'kysely';
import type { CommandChatConfig } from '../../command-chat.js';
import type { RunLedger } from '../agent-run.js';
import type { BrainState } from '../brain.js';
import { analyzeCompoundRequest } from '../compound-request.js';
import { createComputationMemoryReceipt } from '../computation-memory-receipt.js';
import { evaluateLocalComputation } from '../local-computation.js';
import { arbitrateComponent } from '../model-relations-arbiter.js';
import { requestActionText } from '../request-context.js';
import { requestScopeActionText } from '../request-scope.js';
import { replyBodyFor, replyConstraintsFor } from '../reply-turn.js';
import { compilePlan, MAX_PLAN_STEPS } from './compiler.js';
import { executePlan } from './executor.js';
import { createPlanTools } from './tools.js';

/** An opt-in with separate observation and execution modes. */
function planMode(): 'off' | 'shadow' | 'on' {
  const mode = process.env.MOHASSAN_PLAN_COMPILER;
  return mode === 'shadow' || mode === 'on' ? mode : 'off';
}

const directHandlers = {
  local_computation: 'local-calculator', local_conversation: 'small-talk', local_coding: 'verified-coding',
  writing: 'writer', search: 'factual-lookup', browser: 'browser-plan',
} as const;

/** Logs the graph for every accepted message, with no request or tool-result content. */
export function observePlanMessage(text: string): void {
  if (planMode() !== 'shadow') return;
  try {
    const plan = compilePlan(requestScopeActionText(text));
    console.info(JSON.stringify({ event: 'plan_compiler_shadow', language: plan.lang, steps: plan.steps.map(step => ({
      id: step.id, route: step.route, tool: step.tool, output: step.output, success: step.success,
      dependsOn: step.dependsOn, references: step.inputs.references.map(reference => ({ stepId: reference.stepId, kind: reference.kind })),
    })) }));
  } catch {
    console.info(JSON.stringify({ event: 'plan_compiler_shadow', status: 'compile_failed' }));
  }
}

interface ChatPlanContext {
  request: string;
  config: CommandChatConfig;
  search: SearchProvider;
  state: BrainState;
  ownerId: string;
  conversationId: string;
  runId: string;
  fullAccess: boolean;
  now: Date;
  signal: AbortSignal;
  memoryLimit: number;
  active: () => Promise<void>;
  navigate: (url: string) => Promise<AgentPage>;
  keepPage: (page: AgentPage) => Promise<void>;
  scrub: (text: string) => string;
  ledger: () => RunLedger;
  checkpoint: () => Promise<void>;
  fenceMemory: (tx: Kysely<any>) => Promise<void>;
  validActionLedger: () => boolean;
  isInterruption: (error: unknown) => boolean;
  publish: (text: string, status: 'completed' | 'partial' | 'blocked') => Promise<void>;
}

/** Called once for a fresh, fenced run after chat validates its original request. */
export async function runCompiledChatPlan(context: ChatPlanContext): Promise<boolean> {
  const { request, config, state, now, signal } = context;
  if (planMode() !== 'on' || state.steps || state.trail.length || state.agentRun?.plan || state.dropHeld) return false;

  const replyConstraints = replyConstraintsFor(state);
  const action = requestScopeActionText(replyBodyFor(request));
  const plan = compilePlan(action, { fullAccess: context.fullAccess, now,
    capabilities: { browser: Boolean(config.readPage), search: true, memory: Boolean(config.tools?.memory) } });
  plan.lang = replyConstraints?.lang ?? plan.lang;
  if (plan.steps.length < 2 || plan.steps.every(step => step.tool === 'unsupported')) return false;
  // One calculation can contain punctuation and conjunctions in its operands.
  // An unknown conversion unit can absorb a real follow-up, so require a successful conversion.
  const calculation = evaluateLocalComputation(requestActionText(action), now);
  const consumption = calculation?.consumption;
  if (calculation && consumption?.complete && !calculation.compound?.pendingActions.length
    && (consumption.kind !== 'conversion' || calculation.status === 'completed')) return false;
  if (plan.steps.length > MAX_PLAN_STEPS) {
    const message = plan.lang === 'ar' ? `قسّم طلبك إلى رسائل تضم كل منها ${MAX_PLAN_STEPS} خطوة أو أقل.`
      : `Split your request into messages with at most ${MAX_PLAN_STEPS} steps each.`;
    await context.publish(message, 'blocked');
    return true;
  }
  // A fresh graph can exceed the old compound parser's action count. Never
  // replace a persisted action ledger, or bypass an invalid literal or source.
  if (!context.validActionLedger() && (state.actionCompletion !== undefined || analyzeCompoundRequest(request).reason !== 'too_many_actions')) return false;
  // Keep the native exact calculation-and-save contract, including its durable
  // verification receipt, when the entire request matches that contract.
  if (plan.steps.length === 2 && plan.steps[0]?.tool === 'compute' && plan.steps[1]?.tool === 'remember'
    && createComputationMemoryReceipt(request, { ownerId: context.ownerId, conversationId: context.conversationId,
      runId: context.runId, evaluatedAt: now.getTime() })) return false;

  const routing = state.routing;
  const handler = routing?.handler;
  if (routing?.availability === 'ready' && handler && Object.hasOwn(directHandlers, handler)
    && !arbitrateComponent('compound-plan', { text: request, runId: context.runId,
      conversationState: state.requestResolution?.kind ?? 'new' },
    { component: 'plan-compiler', label: 'compound', result: true },
    [{ component: directHandlers[handler as keyof typeof directHandlers], label: routing.reason, result: false }])) return false;

  const ledger = context.ledger();
  const localSequence = plan.steps.every(step => step.tool === 'compute' && !step.dependsOn.length);
  function recordTool(action: string, completed: boolean) {
    state.trail.push({ step: state.trail.length + 1, action,
      result: completed ? 'completed' : 'failed: operation did not complete',
      changed: action === 'open' ? (completed ? true : null) : false });
  }
  let navigationTail: Promise<unknown> = Promise.resolve();
  let latestSiteStep = -1;
  const runTool = createPlanTools({ request, now, signal, ownerId: context.ownerId, conversationId: context.conversationId, runId: context.runId,
    fullAccess: context.fullAccess, originalRequestHash: state.requestOriginalHash,
    search: context.search, readPage: config.readPage, networkPolicy: config.networkPolicy, memory: config.tools?.memory, replyConstraints,
    openPage: (url, openSignal) => {
      const navigation = navigationTail.then(async () => {
        openSignal.throwIfAborted();
        await context.active();
        const page = await context.navigate(url);
        openSignal.throwIfAborted();
        await context.keepPage(page);
        return page;
      });
      navigationTail = navigation.catch(() => undefined);
      return navigation;
    },
    onWebAction: (tool, outcome) => recordTool(tool, outcome === 'completed'),
    documents: config.documents, sites: config.sites, active: context.active, scrub: context.scrub,
    memoryState: state, memoryLimit: context.memoryLimit, fenceMemory: context.fenceMemory,
    onSite: (siteId, stepId) => {
      const index = plan.steps.findIndex(step => step.id === stepId);
      if (index <= latestSiteStep) return;
      latestSiteStep = index;
      state.siteId = siteId;
      state.sitePendingWant = null;
    },
  });
  const result = await executePlan(plan, { ledger, signal, isInterruption: context.isInterruption,
    runTool: async (step, inputs, attempt) => {
      const result = await runTool(step, inputs, attempt);
      if (step.tool === 'compute' && !localSequence) recordTool('calculate', result.ok);
      return result;
    },
    checkpoint: async () => {
      signal.throwIfAborted();
      state.steps = Math.max(state.trail.length, ledger.plan?.steps.reduce((count, step) => count + step.attempts, 0) ?? 0);
      await context.checkpoint();
    },
  });
  if (localSequence && result.steps.some(step => step.attempts > 0)) {
    recordTool('local_sequence', result.status === 'completed');
  }
  await context.publish(context.scrub(result.text), result.status);
  return true;
}
