import { join } from 'node:path';
import { scheduler } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { OwnModelProvider } from '@mohassan/providers/own-model';
import { getServerModelWorker, getServerOwnModelGates } from '../model-worker.js';
import type { OwnModelCapability, OwnModelGates } from '../own-model-gates.js';
import { emptyConversationState, understandTurn, type TurnType } from './conversation-state.js';
import { phraseCheckedEvidence } from './own-model-phrasing.js';
import { loadRouterModel, routerLogits } from './router.js';

const turnTypes = {
  new_request: 'Independent new request',
  topic_change: 'Switch to a new topic',
  follow_up_property: 'Ask for another property of the same entity',
  follow_up_entity: 'Ask about another entity with the same property',
  reference: 'Refer to an item shown earlier',
  correction: 'Correct a previous detail',
  field_edit: 'Change one field or the format',
  card_answer: 'Answer a pending question',
  compound: 'Make several requests together',
  small_talk: 'Greet, thank, or acknowledge',
  ambiguous: 'Context is insufficient to resolve the turn',
} satisfies Record<TurnType, string>;

type ShadowTurn = {
  request: string;
  earlierUserTurns: readonly string[];
  route?: string;
  signal: AbortSignal;
};

type PhrasingInput = Parameters<typeof phraseCheckedEvidence>[1];
type ReplyProvider = Pick<OwnModelProvider, 'health' | 'generate'> & {
  choose(request: Parameters<OwnModelProvider['choose']>[0]): ReturnType<OwnModelProvider['choose']>;
};
type RouterArtifact = Awaited<ReturnType<typeof loadRouterModel>>;
type Metric = {
  event: 'own_model_reply';
  capability: OwnModelCapability;
  outcome: 'chosen' | 'abstained' | 'unavailable' | 'sent' | 'rejected';
  latencyMs: number;
  agreed?: boolean;
  baselineInOptions?: boolean;
  judgeRejected?: boolean;
};

export interface OwnModelReply {
  observe(input: ShadowTurn): Promise<void>;
  phrase(input: PhrasingInput): Promise<string>;
}

export function createOwnModelReply(options: {
  provider: ReplyProvider;
  gates(): OwnModelGates | undefined;
  router(): Promise<RouterArtifact | null>;
  record(metric: Metric): void;
}): OwnModelReply {
  const { provider } = options;
  const record = (metric: Omit<Metric, 'event' | 'latencyMs'>, latencyMs: number) => {
    try {
      options.record({ event: 'own_model_reply', ...metric, latencyMs: Math.round(latencyMs * 100) / 100 });
    } catch {
      // A metrics sink cannot affect the reply.
    }
  };

  async function observeDecision(
    capability: 'route-choice' | 'follow-up-turn-type',
    input: ShadowTurn,
    configSha256: string,
    calibration: Parameters<ReplyProvider['choose']>[0]['calibration'],
    routerSha256?: string,
  ): Promise<void> {
    if (input.signal.aborted) return;
    const started = performance.now();
    try {
      let goal: string;
      let choices: Array<{ id: string; label: string }>;
      let baseline: string;
      if (capability === 'route-choice') {
        const router = await options.router();
        if (!router || router.headerSha256 !== routerSha256 || input.signal.aborted) return;
        const logits = routerLogits(router, input.request);
        if (logits.length < 3 || !logits.every(Number.isFinite)) return;
        choices = router.routes.map((route, index) => ({ route, score: logits[index] }))
          .sort((left, right) => right.score - left.score).slice(0, 3)
          .map(({ route }) => ({ id: route, label: route.replaceAll('_', ' ') }));
        baseline = input.route ?? '';
        goal = `Choose the route for this user request: ${JSON.stringify(input.request.slice(0, 400))}`;
      } else {
        const earlier = input.earlierUserTurns.slice(-8);
        let state = emptyConversationState();
        for (const [index, text] of earlier.entries()) state = understandTurn(state, text, `earlier-${index}`).next;
        baseline = understandTurn(state, input.request, 'current').type;
        choices = Object.entries(turnTypes).map(([id, label]) => ({ id, label }));
        goal = `Classify the current user turn in context: ${JSON.stringify({
          earlier: earlier.slice(-2).map(text => text.slice(0, 220)), current: input.request.slice(0, 400),
        })}`;
      }
      const result = await provider.choose({ goal, options: choices, calibration, signal: input.signal, expectedConfigSha256: configSha256 });
      const baselineInOptions = choices.some(choice => choice.id === baseline);
      record(result.option === null
        ? { capability, outcome: 'abstained', baselineInOptions }
        : { capability, outcome: 'chosen', agreed: result.option === baseline, baselineInOptions }, performance.now() - started);
    } catch {
      record({ capability, outcome: 'unavailable' }, performance.now() - started);
    }
  }

  return {
    async observe(input) {
      try {
        if (input.signal.aborted) return;
        const gates = options.gates();
        if (!gates) return;
        const health = provider.health();
        if (health.state !== 'ready' || !health.decisions || !health.configSha256) return;
        const digest = health.configSha256;
        const route = input.route && gates.get('route-choice', digest);
        const followUp = input.earlierUserTurns.length && gates.get('follow-up-turn-type', digest);
        if (!route && !followUp) return;
        await scheduler.yield();
        await Promise.all([
          route && observeDecision('route-choice', input, digest, route.calibration, route.routerSha256),
          followUp && observeDecision('follow-up-turn-type', input, digest, followUp.calibration),
        ]);
      } catch {
        // Shadow work is independent of the host's route and turn state.
      }
    },
    async phrase(input) {
      try {
        if (input.signal.aborted) return input.reply;
        const gates = options.gates();
        if (!gates) return input.reply;
        const health = provider.health();
        if (health.state !== 'ready' || !health.generation || !health.configSha256 || !gates.get('phrasing', health.configSha256)) return input.reply;
        const expectedConfigSha256 = health.configSha256;
        const result = await phraseCheckedEvidence({
          generate: request => provider.generate({ ...request, expectedConfigSha256 }),
        }, input);
        if (result.outcome !== 'skipped' && result.latencyMs !== undefined) {
          record({ capability: 'phrasing', outcome: result.outcome, judgeRejected: Boolean(result.judgeRejected) }, result.latencyMs);
        }
        return input.signal.aborted ? input.reply : result.text;
      } catch {
        return input.reply;
      }
    },
  };
}

export function createServerOwnModelReply(app: FastifyInstance): OwnModelReply {
  let router: Promise<RouterArtifact | null> | undefined;
  return createOwnModelReply({
    provider: new OwnModelProvider({ worker: () => getServerModelWorker(app) }),
    gates: () => getServerOwnModelGates(app),
    router: () => router ??= loadRouterModel(join(process.cwd(), 'artifacts', 'router')).catch(() => null),
    record: metric => console.log(JSON.stringify({ level: 'info', ...metric })),
  });
}
