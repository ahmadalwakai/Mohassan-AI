import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { BrowserError } from '@mohassan/browser';
import {
  ACTIVATION_DEFAULT_DAYS, ACTIVATION_MAX_DAYS, ActivationReviewInputSchema, ActivationStateInputSchema,
  type ActivationConsoleSnapshot, type ActivationLabel,
} from '@mohassan/contracts';
import { readStoredActivationEvents, type ActivationLogs, type StoredActivationEvent } from './activation-events.js';
import { verifyActivationGate } from './activation-gates.js';
import { subscribeActivationConsoleLogs } from './activation-log-sources.js';
import { migrateActivationConsole } from './activation-migration.js';
import { activationCapabilities, activationCapability, type ActivationCapability } from './activation-registry.js';
import { attachActivationRuntime, isActivationRuntimeReady } from './activation-runtime.js';
import { redactActivationText } from './activation-samples.js';
import type { AppConfig } from './app.js';

type Reviews = { better: number; worse: number; same: number };
type Sample = ActivationConsoleSnapshot['samples'][number];
type AuditItem = ActivationConsoleSnapshot['audit'][number];
type GatePolicy = { gateId: string; sha256?: string };
export type ActivationConsoleOptions = { minimumReviews?: number; gates?: Readonly<Record<string, GatePolicy>> };
const optionsSchema = z.object({
  minimumReviews: z.number().int().positive().optional(),
  gates: z.record(z.string(), z.object({ gateId: z.string().trim().min(1).max(100),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).transform(hash => hash.toLowerCase()).optional() }).strict()).optional(),
}).strict();

const dayMs = 86_400_000;
const queueSize = 20;
const auditSize = 100;
const since = (to: Date, days: number) => new Date(to.getTime() - days * dayMs);
const emptyReviews = (): Reviews => ({ better: 0, worse: 0, same: 0 });
const ready = (reviews: Reviews, minimum: number) =>
  reviews.better + reviews.worse + reviews.same >= minimum && reviews.better >= reviews.worse;
const problem = (code: string, message: string, status = 409) => new BrowserError(code, message, status);
const missingSample = () => problem('ACTIVATION_SAMPLE_NOT_FOUND', 'عينة المراجعة غير متاحة.', 404);
const querySchema = z.object({ days: z.coerce.number().int().min(1).max(ACTIVATION_MAX_DAYS).default(ACTIVATION_DEFAULT_DAYS) });

function reviewable(event: StoredActivationEvent): boolean {
  return Boolean(event.owned && event.changed === true && event.shadow && event.baseline !== event.shadow &&
    (event.baseline || event.replyId));
}

function emptyMetrics() {
  return { eventCount: 0, comparedCount: 0, disagreements: 0, errors: 0, timings: 0, totalMs: 0, categories: new Map<string, number>() };
}

async function reviewCounts(db: Kysely<any>, actorId: string, capabilityId?: string): Promise<Map<string, Reviews>> {
  const query = db.selectFrom('activation_reviews').select(['capability_id', 'label', sql<string>`count(*)`.as('count')])
    .where('actor_id', '=', actorId).groupBy(['capability_id', 'label']);
  const counts = new Map<string, Reviews>();
  for (const row of await (capabilityId ? query.where('capability_id', '=', capabilityId) : query).execute()) {
    const reviews = counts.get(row.capability_id) ?? emptyReviews();
    reviews[row.label as ActivationLabel] = Number(row.count);
    counts.set(row.capability_id, reviews);
  }
  return counts;
}

function gatePolicy(capability: ActivationCapability, options: ActivationConsoleOptions): GatePolicy | undefined {
  const custom = options.gates && Object.hasOwn(options.gates, capability.id) ? options.gates[capability.id] : undefined;
  return custom ?? (capability.gateId ? { gateId: capability.gateId } : undefined);
}

async function activationOptions(config: AppConfig): Promise<ActivationConsoleOptions> {
  if (config.activationConsole) return optionsSchema.parse(config.activationConsole);
  if (!config.dataDir) return {};
  let raw: string;
  try {
    raw = await readFile(join(config.dataDir, 'activation-console.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Could not read activation-console.json');
  }
  try {
    return optionsSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('Invalid activation-console.json');
  }
}

export async function registerActivationConsole(app: FastifyInstance, {
  db, owner, role, config, judgeLogFile,
}: {
  db: Kysely<any>;
  owner(request: FastifyRequest): Promise<{ id: string }>;
  role(request: FastifyRequest): Promise<string>;
  config: AppConfig;
  judgeLogFile: string;
}) {
  const options = await activationOptions(config);
  const minimumReviews = options.minimumReviews ?? 30;
  const logs: ActivationLogs = { judge: judgeLogFile, conversation: join(process.cwd(), '.data', 'conversation', 'shadow.jsonl') };
  const secrets = [config.authSecret, config.internalSecret, config.setupToken, config.databaseUrl, config.groqApiKey,
    config.studioGatewaySecret, config.sites?.vercelToken, config.googleAds?.clientSecret, config.googleAds?.developerToken,
    config.googleAds?.tokenKey].filter((value): value is string => Boolean(value));
  const now = () => new Date();
  await migrateActivationConsole(db);
  attachActivationRuntime(db);
  const stopLogs = subscribeActivationConsoleLogs(db, now);

  async function actor(request: FastifyRequest) {
    if (await role(request) !== 'owner') throw problem('MEMBER_FORBIDDEN', 'هذه الخدمة غير متاحة لحسابك.', 403);
    return (await owner(request)).id;
  }

  async function sampleOf(event: StoredActivationEvent, actorId: string): Promise<Sample | null> {
    if (!reviewable(event)) return null;
    let baseline = event.baseline;
    let baselineKind: Sample['baselineKind'] = 'decision';
    if (event.ownerConversationId && (event.replyId || event.judgeReplyCandidate)) {
      const messages = db.selectFrom('chat_messages as m').innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
        .select('m.text').where('m.conversation_id', '=', event.ownerConversationId).where('m.role', '=', 'assistant').where('c.owner_id', '=', actorId);
      // The judge sees a candidate before publication. Only use it if the same text was actually saved.
      const message = await (event.replyId ? messages.where('m.id', '=', event.replyId)
        : messages.where('m.text', '=', event.judgeReplyCandidate).where('m.created_at', '>=', event.occurredAt)
          .where('m.created_at', '<', new Date(event.occurredAt.getTime() + 60_000))).limit(1).executeTakeFirst();
      if (message?.text) {
        baseline = message.text;
        baselineKind = 'reply';
      }
    }
    if (!baseline || !event.shadow || (baselineKind === 'decision' && baseline === event.shadow)) return null;
    return { id: event.id, capabilityId: event.capabilityId, occurredAt: event.occurredAt.toISOString(), category: event.category,
      baseline: redactActivationText(baseline, secrets), baselineKind, shadow: redactActivationText(event.shadow, secrets) };
  }

  app.get('/api/activation-console', async (request): Promise<ActivationConsoleSnapshot> => {
    const actorId = await actor(request);
    const { days } = querySchema.parse(request.query);
    const to = now(), from = since(to, days);
    const [counts, reviews, states, gatePins, changes] = await Promise.all([
      reviewCounts(db, actorId),
      db.selectFrom('activation_reviews').select('sample_id').where('actor_id', '=', actorId).execute(),
      db.selectFrom('activation_changes').distinctOn('capability_id').select(['capability_id', 'enabled'])
        .orderBy('capability_id').orderBy('id', 'desc').execute(),
      db.selectFrom('activation_changes').distinctOn('capability_id').select(['capability_id', 'gate_sha256'])
        .where('gate_sha256', 'is not', null).orderBy('capability_id').orderBy('id', 'desc').execute(),
      db.selectFrom('activation_changes').select(['capability_id', 'enabled', 'actor_id', 'changed_at', 'reason', 'gate_sha256', 'evidence'])
        .orderBy('id', 'desc').limit(auditSize).execute(),
    ]);
    const reviewed = new Set(reviews.map(row => row.sample_id));
    const status = new Map<string, boolean>(states.map(row => [row.capability_id, row.enabled]));
    const pins = new Map<string, string>(gatePins.map(row => [row.capability_id, row.gate_sha256]));
    const metrics = new Map<string, ReturnType<typeof emptyMetrics>>();
    const candidates = new Map<string, StoredActivationEvent[]>();
    for await (const item of readStoredActivationEvents(db, logs, actorId, from, to)) {
      const metric = metrics.get(item.capabilityId) ?? emptyMetrics();
      metrics.set(item.capabilityId, metric);
      metric.eventCount++;
      if (item.changed !== null) metric.comparedCount++;
      if (item.changed === true) {
        metric.disagreements++;
        if (item.category) metric.categories.set(item.category, (metric.categories.get(item.category) ?? 0) + 1);
      }
      if (item.latencyMs !== null) {
        metric.timings++;
        metric.totalMs += item.latencyMs;
      }
      if (item.error) metric.errors++;
      if (reviewable(item) && !reviewed.has(item.id)) {
        const queue = candidates.get(item.capabilityId) ?? [];
        candidates.set(item.capabilityId, queue);
        queue.push(item);
        queue.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id));
        if (queue.length > queueSize) queue.pop();
      }
    }
    const capabilities = activationCapabilities.filter(item => metrics.has(item.id) || counts.has(item.id) || status.has(item.id)).map(item => {
      const metric = metrics.get(item.id) ?? emptyMetrics();
      const reviews = counts.get(item.id) ?? emptyReviews();
      const runtimeReady = isActivationRuntimeReady(item.flag);
      return { id: item.id, nameAr: item.label, flag: item.flag, runtimeReady, gateRequired: Boolean(gatePolicy(item, options)),
        gateSha256: pins.get(item.id) ?? null, enabled: status.get(item.id) ?? false, eventCount: metric.eventCount,
        comparedCount: metric.comparedCount, disagreements: metric.disagreements,
        disagreementRate: metric.comparedCount && !item.differencesOnly ? metric.disagreements / metric.comparedCount : null,
        categories: [...metric.categories].sort(([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b))
          .map(([category, count]) => ({ category, count })),
        latency: { count: metric.timings, meanMs: metric.timings ? metric.totalMs / metric.timings : null },
        errors: metric.errors, reviews, canEnable: runtimeReady && ready(reviews, minimumReviews) };
    });
    const queues = activationCapabilities.flatMap(item => candidates.get(item.id) ? [candidates.get(item.id)!] : []);
    const selected: StoredActivationEvent[] = [];
    for (let rank = 0; rank < queueSize && selected.length < queueSize; rank++) {
      for (const queue of queues) {
        const event = queue[rank];
        if (event && selected.length < queueSize) selected.push(event);
      }
    }
    const samples = (await Promise.all(selected.map(item => sampleOf(item, actorId)))).filter(sample => sample !== null);
    const audit = changes.map((row): AuditItem => ({ capabilityId: row.capability_id, enabled: row.enabled, actorId: row.actor_id,
      at: new Date(row.changed_at).toISOString(), reason: row.reason, gateSha256: row.gate_sha256, evidence: row.evidence }));
    return { window: { days, from: from.toISOString(), to: to.toISOString() }, minimumReviews, capabilities, samples, audit };
  });

  app.post('/api/activation-console/reviews', async request => {
    const actorId = await actor(request);
    const input = ActivationReviewInputSchema.parse(request.body);
    const to = now();
    for await (const event of readStoredActivationEvents(db, logs, actorId, since(to, ACTIVATION_MAX_DAYS), to, input.sampleId)) {
      if (!await sampleOf(event, actorId)) continue;
      const inserted = await db.insertInto('activation_reviews').values({ actor_id: actorId, sample_id: event.id, capability_id: event.capabilityId,
        label: input.label, training_allowed: input.trainingAllowed === true })
        .onConflict(conflict => conflict.columns(['actor_id', 'sample_id']).doNothing()).returning('sample_id').executeTakeFirst();
      if (!inserted) {
        const previous = await db.selectFrom('activation_reviews').select(['label', 'training_allowed'])
          .where('actor_id', '=', actorId).where('sample_id', '=', event.id).executeTakeFirstOrThrow();
        if (previous.label !== input.label || previous.training_allowed !== (input.trainingAllowed === true)) {
          throw problem('ACTIVATION_SAMPLE_REVIEWED', 'تمت مراجعة هذه العينة بالفعل.');
        }
      }
      return { ok: true };
    }
    throw missingSample();
  });

  app.post('/api/activation-console/state', { bodyLimit: 132 * 1024 }, async request => {
    const actorId = await actor(request);
    const input = ActivationStateInputSchema.parse(request.body);
    const capability = activationCapability(input.capabilityId);
    if (!capability) throw problem('ACTIVATION_CAPABILITY_NOT_FOUND', 'القدرة غير متاحة.', 404);
    await db.transaction().execute(async tx => {
      await sql`LOCK TABLE activation_changes IN SHARE ROW EXCLUSIVE MODE`.execute(tx);
      const previous = await tx.selectFrom('activation_changes').select('enabled').where('capability_id', '=', capability.id)
        .orderBy('id', 'desc').limit(1).executeTakeFirst();
      if ((previous?.enabled ?? false) === input.enabled) return;
      const reviews = (await reviewCounts(tx, actorId, capability.id)).get(capability.id) ?? emptyReviews();
      let gateSha256: string | null = null;
      if (input.enabled) {
        if (!ready(reviews, minimumReviews)) throw problem('ACTIVATION_REVIEWS_REQUIRED', 'يلزم عدد كافٍ من المراجعات، وألا تتجاوز تقييمات «أسوأ» تقييمات «أفضل».');
        const policy = gatePolicy(capability, options);
        if (policy) {
          if (!policy.sha256) throw problem('ACTIVATION_GATE_UNPINNED', 'ثبّت بصمة سجل البوابة في إعدادات الخادم قبل تفعيل القدرة.');
          gateSha256 = input.gate && policy.sha256 === input.gate.sha256
            ? verifyActivationGate(policy.gateId, input.gate) : null;
          if (!gateSha256) throw problem('ACTIVATION_GATE_REQUIRED', 'يلزم سجل بوابة ناجح وبصمة SHA-256 مطابقة.');
        }
        if (!isActivationRuntimeReady(capability.flag)) throw problem('ACTIVATION_RUNTIME_UNAVAILABLE', 'لم يرتبط مسار هذه القدرة بالتفعيل بعد.');
        if (!input.reason) throw problem('ACTIVATION_REASON_REQUIRED', 'أدخل سبب التفعيل.', 400);
      }
      await tx.insertInto('activation_changes').values({ capability_id: capability.id, actor_id: actorId, enabled: input.enabled,
        reason: redactActivationText(input.reason ?? 'أوقف المالك القدرة من لوحة التفعيل.', secrets), gate_sha256: gateSha256,
        evidence: JSON.stringify({ minimumReviews, ...reviews }) }).execute();
    });
    return { ok: true };
  });

  return stopLogs;
}
