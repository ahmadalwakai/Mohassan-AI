import { createHash, randomUUID } from 'node:crypto';
import { MonitorSpecSchema, monitorV2Targets, type MonitorCard, type MonitorManagementCard, type MonitorManagementResult } from '@mohassan/contracts';
import { sql, type Kysely } from 'kysely';
import { monitorMetricTransaction, type MonitorMetricEvent } from '../ops/metrics/monitor-events.js';
import { evaluateMonitor } from './evaluation.js';
import { evaluateMonitorV2, monitorV2DigestDueAt } from './evaluation-v2.js';
import { MONITOR_LIMITS, nextMonitorBudgetDay } from './schedule.js';
import { MonitorError, monitorCard, monitorSpecKey, type MonitorRow, type MonitorStore } from './store.js';
import { monitorManagementTargets, type MonitorManagement, type MonitorManagementChange } from './v2-chat-intents.js';

type Language = MonitorManagement['language'];
type Target = { id: string; label: string; fingerprint: string };
type Operation = { intent: MonitorManagementChange & { language: Language }; targets: Target[] };
type ActionRow = { id: string; operation: Operation; resolved: boolean; expires_at: Date };

const local = (language: Language, ar: string, en: string) => language === 'ar' ? ar : en;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = ({ condition, v2 }: MonitorCard['spec']) => hash(JSON.stringify([condition, v2]));
const editable = (card: MonitorCard) => card.status === 'active' || card.status === 'paused';

function targetCard(card: MonitorCard): Target {
  const { condition, language, source, title } = card.spec;
  const reading = condition.kind === 'threshold' || condition.kind === 'crossing'
    ? `${local(language, condition.direction === 'above' ? 'فوق' : 'دون', condition.direction)} ${condition.value}`
    : 'url' in source ? new URL(source.url).pathname : undefined;
  return { id: card.id, label: reading ? `${title} · ${reading}`.slice(0, 300) : title, fingerprint: fingerprint(card.spec) };
}

function managementCard(id: string, { intent, targets }: Operation): MonitorManagementCard {
  const { language } = intent;
  const say = (ar: string, en: string) => local(language, ar, en);
  if (targets.length > 1) return { id, language, question: say('أي مراقبة تقصد؟', 'Which monitor did you mean?'),
    choices: targets.map(target => ({ id: target.id, label: target.label })) };
  const target = targets[0]?.label;
  let question: string;
  switch (intent.kind) {
    case 'pause': question = say(`أوقف «${target}» مؤقتًا؟`, `Pause “${target}”?`); break;
    case 'resume': question = say(`أستأنف «${target}»؟`, `Resume “${target}”?`); break;
    case 'stop': question = say(`أوقف مراقبة «${target}»؟`, `Stop monitoring “${target}”?`); break;
    case 'threshold': question = say(`أغيّر حد «${target}» إلى ${intent.value}؟`, `Change the threshold for “${target}” to ${intent.value}?`); break;
    case 'delivery': question = intent.delivery === 'daily'
      ? say(`أرسل ملخصًا يوميًا لمراقبة «${target}»؟`, `Send a daily digest for “${target}”?`)
      : say(`أرسل كل تنبيه لمراقبة «${target}»؟`, `Send each alert for “${target}”?`); break;
    case 'offers': question = intent.enabled ? say('أفعّل عروض المراقبة لهذا الحساب؟', 'Turn on proactive monitor offers for this account?')
      : say('أوقف عروض المراقبة لهذا الحساب؟', 'Turn off proactive monitor offers for this account?'); break;
  }
  return { id, language, question };
}

export async function prepareMonitorManagement(store: MonitorStore, userId: string, conversationId: string, intent: MonitorManagement) {
  const cards = intent.kind === 'offers' ? [] : await store.list(userId);
  const say = (ar: string, en: string) => local(intent.language, ar, en);
  if (intent.kind === 'list') {
    const active = cards.filter(card => card.status === 'active' || card.status === 'paused' || card.status === 'proposed');
    const text = active.length ? [say('هذه مراقباتك الحالية.', 'Here are your current monitors.'), ...active.map(card => {
      const status = card.status === 'paused' ? say('متوقفة مؤقتًا', 'paused') : card.status === 'proposed'
        ? say('بانتظار الموافقة', 'awaiting approval') : say('نشطة', 'active');
      return `- ${card.spec.title} (${status})`;
    })].join('\n') : say('ليست لديك مراقبات حاليًا.', 'You have no current monitors.');
    return { text, status: 'completed' as const };
  }
  const targets = monitorManagementTargets(cards, intent, conversationId).map(targetCard);
  if (intent.kind !== 'offers' && targets.length === 0) return { text: say('لم أجد مراقبة مطابقة. اذكر اسمها كما يظهر في قائمة المراقبات.',
    'I couldn’t find a matching monitor. Use its name from your monitor list.'), status: 'partial' as const };
  if (targets.length > 4) return { text: say('تطابق عدة مراقبات طلبك. اذكر اسم المراقبة أو رابط المصدر.',
    'Several monitors match your request. Include the monitor name or source link.'), status: 'partial' as const };
  return { text: say('راجع التغيير في البطاقة.', 'Review the change in the card.'), status: 'completed' as const,
    management: { intent, targets } satisfies Operation };
}

export function createMonitorChatV2Store(db: Kysely<any>, store: MonitorStore, now = () => new Date()) {
  async function checkRole(userId: string, tx: Kysely<any>) {
    if (!await store.accountRole(userId, tx)) throw new MonitorError(403, 'MONITOR_FORBIDDEN', 'Monitoring is unavailable for this account.');
  }

  async function lockPreferences(tx: Kysely<any>, userId: string) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`monitor-offers:${userId}`}, 0))`.execute(tx);
  }

  async function proactiveOffers(userId: string, tx = db): Promise<boolean> {
    const row = await tx.selectFrom('smart_monitor_v2_preferences').select('proactive_offers')
      .where('user_id', '=', userId).executeTakeFirst();
    return row?.proactive_offers ?? true;
  }

  async function setOffers(userId: string, enabled: boolean, tx: Kysely<any>) {
    await lockPreferences(tx, userId);
    await tx.insertInto('smart_monitor_v2_preferences').values({ user_id: userId, proactive_offers: enabled })
      .onConflict(conflict => conflict.column('user_id').doUpdateSet({ proactive_offers: enabled })).execute();
    return { proactiveOffers: enabled };
  }

  async function editTarget(tx: Kysely<any>, userId: string, target: Target, intent: Exclude<MonitorManagementChange, {kind: 'offers'}>,
    observe: (event: MonitorMetricEvent) => void) {
    const row = await tx.selectFrom('smart_monitors').selectAll().where('user_id', '=', userId).where('id', '=', target.id)
      .forUpdate().executeTakeFirst() as MonitorRow | undefined;
    const at = now();
    if (!row || !editable(monitorCard(row, at, true)) || fingerprint(row.spec) !== target.fingerprint) {
      throw new MonitorError(409, 'MONITOR_ACTION_STALE', 'The monitor changed. Ask for the new change again.');
    }
    if (intent.kind === 'pause' || intent.kind === 'resume' || intent.kind === 'stop') {
      return store.change(userId, row.id, intent.kind, { tx, observe });
    }
    const { condition, v2 } = row.spec;
    const nextCondition = intent.kind === 'threshold' && (condition.kind === 'threshold' || condition.kind === 'crossing')
      ? { ...condition, value: intent.value, hysteresis: intent.hysteresis } : condition;
    const spec = MonitorSpecSchema.parse({ ...row.spec, condition: nextCondition, ...(intent.kind === 'delivery' && {
      v2: { freshnessMs: monitorV2Targets(row.spec)[0].freshnessMs, ...v2, delivery: intent.delivery },
    }) });
    const evaluation = row.evaluation && intent.kind === 'threshold' ? JSON.stringify(evaluateMonitor(spec, undefined, row.evaluation.observation).state) : undefined;
    const state = row.v2_state;
    const previous = state?.evaluation;
    if (state && previous && intent.kind === 'threshold') {
      const samples = previous.sources.flatMap((source, index) => source?.confirmed ? [{ index, observation: source.confirmed }] : []);
      const seeded = evaluateMonitorV2(spec, undefined, samples, at, { canDeliver: false }).state;
      state.evaluation = { ...seeded, sources: [seeded.sources[0], ...previous.sources.slice(1)], queue: previous.queue };
    } else if (state && previous && intent.kind === 'delivery') {
      const dueAt = intent.delivery === 'daily' ? nextMonitorBudgetDay(at).getTime() : at.getTime();
      state.evaluation = { ...previous, queue: previous.queue.map(notice => ({ ...notice, dueAt })) };
    }
    const updated = await tx.updateTable('smart_monitors').set({ spec: JSON.stringify(spec),
      spec_key: monitorSpecKey(spec), lease_token: null, lease_until: null,
      ...(evaluation && { evaluation }),
      ...(state && { v2_state: JSON.stringify(state) }),
      ...(intent.kind === 'delivery' && { v2_digest_due_at: monitorV2DigestDueAt(spec, state?.evaluation) ?? null }),
    }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow() as MonitorRow;
    return monitorCard(updated, at, true);
  }

  return {
    async state(userId: string, conversationId?: string) {
      await checkRole(userId, db);
      const enabled = await proactiveOffers(userId);
      if (!conversationId) return { proactiveOffers: enabled };
      const row = await db.selectFrom('smart_monitor_v2_actions').select(['id', 'operation'])
        .where('user_id', '=', userId).where('conversation_id', '=', conversationId)
        .where('resolved', '=', false).where('expires_at', '>', now()).orderBy('expires_at', 'desc').executeTakeFirst();
      return { proactiveOffers: enabled, ...(row && { action: managementCard(row.id, row.operation) }) };
    },

    async publishAction(tx: Kysely<any>, userId: string, conversationId: string, operation: Operation) {
      const at = now();
      await tx.deleteFrom('smart_monitor_v2_actions').where('user_id', '=', userId).where(eb => eb.or([
        eb('expires_at', '<=', at), eb.and([eb('conversation_id', '=', conversationId), eb('resolved', '=', false)]),
      ])).execute();
      await tx.insertInto('smart_monitor_v2_actions').values({ id: randomUUID(), user_id: userId, conversation_id: conversationId,
        operation: JSON.stringify(operation), expires_at: new Date(at.getTime() + MONITOR_LIMITS.proposalLifetimeMs) }).execute();
    },

    async confirm(userId: string, id: string, approved: boolean, targetId?: string): Promise<MonitorManagementResult> {
      return monitorMetricTransaction(db, async (tx, observe) => {
        await checkRole(userId, tx);
        const row = await tx.selectFrom('smart_monitor_v2_actions').selectAll().where('user_id', '=', userId).where('id', '=', id)
          .forUpdate().executeTakeFirst() as ActionRow | undefined;
        if (!row) throw new MonitorError(404, 'MONITOR_ACTION_NOT_FOUND', 'This confirmation could not be found.');
        if (new Date(row.expires_at) <= now()) throw new MonitorError(409, 'MONITOR_ACTION_EXPIRED', 'This confirmation expired. Ask again.');
        if (row.resolved) return {};
        const operation = row.operation;
        const update = tx.updateTable('smart_monitor_v2_actions').where('id', '=', id);
        if (!approved) {
          await update.set({ resolved: true }).execute();
          return {};
        }
        if (operation.targets.length > 1) {
          const target = operation.targets.find(item => item.id === targetId);
          if (!target) throw new MonitorError(409, 'MONITOR_ACTION_CHOICE', 'Choose one monitor before confirming.');
          const selected = { ...operation, targets: [target] };
          await update.set({ operation: JSON.stringify(selected) }).execute();
          return { action: managementCard(id, selected) };
        }
        if (targetId) throw new MonitorError(409, 'MONITOR_ACTION_CHOICE', 'Confirm the change after choosing the monitor.');
        const { intent } = operation;
        const result = intent.kind === 'offers' ? await setOffers(userId, intent.enabled, tx)
          : { monitor: await editTarget(tx, userId, operation.targets[0], intent, observe) };
        await update.set({ resolved: true }).execute();
        return result;
      });
    },

    async setProactiveOffers(userId: string, enabled: boolean) {
      return db.transaction().execute(async tx => {
        await checkRole(userId, tx);
        return setOffers(userId, enabled, tx);
      });
    },

    async offerOnce(tx: Kysely<any>, userId: string, conversationId: string, topic: string, publish: () => Promise<boolean>) {
      await lockPreferences(tx, userId);
      if (!await proactiveOffers(userId, tx)) return false;
      const topic_key = hash(topic);
      const key = { user_id: userId, conversation_id: conversationId, topic_key };
      const receipt = await tx.insertInto('smart_monitor_v2_offers').values(key)
        .onConflict(conflict => conflict.doNothing()).returning('topic_key').executeTakeFirst();
      if (!receipt) return false;
      if (await publish()) return true;
      await tx.deleteFrom('smart_monitor_v2_offers').where('user_id', '=', userId).where('conversation_id', '=', conversationId)
        .where('topic_key', '=', topic_key).execute();
      return false;
    },
  };
}
