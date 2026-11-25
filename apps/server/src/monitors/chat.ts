import { BrowserError, SafeNetwork, SearchEngine } from '@mohassan/browser';
import { MONITOR_V2_DEFAULT_FRESHNESS_MS, monitorV2Targets, type MonitorOffer, type MonitorSpec } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import { assessRequestScope, requestCapabilityAllowed, reviewPublicProjection } from '../assistant/request-scope.js';
import { monitoringRequest } from '../assistant/response-policy-signals.js';
import { matchText } from '../assistant/mind/normalize.js';
import { migrateBackgroundResults } from '../background-results-migration.js';
import type { CommandChatConfig } from '../command-chat.js';
import { migrateMonitorAlertFeedback } from '../monitors-phase1/feedback-migration.js';
import { addMonitorCardAlerts, conversationMonitorAlerts } from '../monitors-phase1/feedback.js';
import { detectMonitorNeed, monitorHistoryMayMatter, safeMonitorRequest, type MonitorNeed } from './detection.js';
import { monitorAccountAllowed, type EnabledMonitorRollout } from '../monitors-phase1/rollout.js';
import { monitorContainsCredentials } from './credential-privacy.js';
import { monitorRollout, smartMonitorsV2Enabled } from './flag.js';
import { migrateMonitors } from './migration.js';
import { observePage } from './page.js';
import { createMonitorRuntime } from './runtime.js';
import { monitorTiming } from './schedule.js';
import { createMonitorReader, type MonitorReadResult } from './sources.js';
import { generateMonitorSpec, monitorNeedReply } from './spec.js';
import { createMonitorStore, MonitorError } from './store.js';
import { detectMonitorAnswerOffer, parseMonitorManagement, type MonitorAnswerPage } from './v2-chat-intents.js';
import { createMonitorChatV2Store, prepareMonitorManagement } from './v2-chat-store.js';
import type { MonitorV2Preview } from './v2-runtime-types.js';
import { prepareMonitorV2Preview } from './v2-runtime.js';
import { generateMonitorV2Spec } from './v2-spec.js';

type Configuration = Pick<CommandChatConfig, 'networkPolicy' | 'searchProvider'>;
type SourceValue = Extract<MonitorReadResult, { kind: 'value' }>;
export interface PreparedMonitorTurn {
  text: string;
  status?: 'completed' | 'partial';
  management?: NonNullable<Awaited<ReturnType<typeof prepareMonitorManagement>>['management']>;
  proposal?: { spec: MonitorSpec; observation: SourceValue['observation'] | null; cache?: SourceValue['cache']; offer: MonitorOffer; note: string; v2Preview?: MonitorV2Preview };
}
interface Turn {
  ownerId: string;
  conversationId: string;
  runId: string;
  text: string;
  signal?: AbortSignal;
}
interface BlockedTurn extends Turn {
  trail: readonly { action: string; result: string }[];
  pages: readonly { url: string; documentStatus?: number; text?: string }[];
  error?: unknown;
}
type AnswerTurn = Turn & { pages: readonly MonitorAnswerPage[] };

const localized = (language: MonitorNeed['language'], ar: string, en: string) => language === 'ar' ? ar : en;
const address = /https:\/\/[^\s<>"'«»]+/iu;
const controls = new WeakMap<Kysely<any>, ReturnType<typeof createMonitorChat>>();

export function installMonitorChat(db: Kysely<any>, config: Configuration) {
  const rollout = monitorRollout();
  if (rollout === 'off') return;
  if (!controls.has(db)) controls.set(db, createMonitorChat(db, config, rollout));
  return controls.get(db);
}

export const monitorChat = (db: Kysely<any>) => controls.get(db);

function eligible(text: string) {
  return Boolean(safeMonitorRequest(text));
}

function scopedSource(need: MonitorNeed, spec: Pick<MonitorSpec, 'source'>) {
  const scope = assessRequestScope(need.text);
  if (spec.source.kind === 'page') return requestCapabilityAllowed(scope.constraints ?? null, 'browser_navigation');
  if (spec.source.kind === 'search') {
    return requestCapabilityAllowed(scope.constraints ?? null, 'public_search')
      && reviewPublicProjection(`Search for ${spec.source.query}`, spec.source.query).eligible;
  }
  return true;
}

export async function legacyMonitorHandledBySmartChat(db: Kysely<any>, ownerId: string, text: string) {
  const control = monitorChat(db);
  if (!control || !await control.availableTo(ownerId)) return false;
  return monitoringRequest(matchText(text)) || detectMonitorNeed({ text })?.kind === 'explicit'
    || control.v2 && Boolean(parseMonitorManagement(text));
}

function blockedSource(turn: BlockedTurn) {
  const url = address.exec(turn.text)?.[0].replace(/[.,،;؛!?؟)]+$/u, '');
  if (!url) return null;
  const page = turn.pages.findLast(candidate => candidate.url === url || candidate.url === `${url}/`);
  const status = page?.documentStatus;
  if (status === 404 || status === 410) return { url, reason: 'not-published' as const, runId: turn.runId };
  if (status !== undefined && status >= 200 && status < 400) {
    if (!page?.text || !/\b(?:publish\w*|release\w*|publication)\b|نشر|إصدار|صدور/iu.test(turn.text)) return null;
    const publication = observePage(page.text, url, 'text/plain', { source: { kind: 'page', url }, read: { kind: 'status', label: 'publication' } }, new Date().toISOString());
    return publication?.value === 'unpublished' ? { url, reason: 'not-published' as const, runId: turn.runId, publicationStatus: true as const } : null;
  }
  const failedRead = turn.trail.some(item => item.action === `read ${url}` && item.result === 'no readable text over HTTP');
  const failedNavigation = turn.error instanceof BrowserError && /(?:ERR_(?:CONNECTION|NAME_NOT_RESOLVED|TIMED_OUT)|(?:connection|navigation) timed out)/iu.test(turn.error.message);
  return failedRead || failedNavigation || status !== undefined && status >= 500
    ? { url, reason: 'unreachable' as const, runId: turn.runId } : null;
}

function createMonitorChat(db: Kysely<any>, config: Configuration, rollout: EnabledMonitorRollout) {
  const network = new SafeNetwork({ resolver: config.networkPolicy?.resolver, userAgent: config.networkPolicy?.userAgent });
  const searchProvider = config.searchProvider instanceof SearchEngine ? undefined : config.searchProvider;
  const reader = createMonitorReader({ db, network, searchProvider });
  const store = createMonitorStore(db, { rollout });
  const runtime = createMonitorRuntime(db, { read: reader.read, store, rollout });
  const availableTo = (ownerId: string, tx = db) => monitorAccountAllowed(tx, ownerId, rollout);
  const v2 = smartMonitorsV2Enabled();
  const chatV2 = createMonitorChatV2Store(db, store);
  let initializing: Promise<void> | undefined;
  let ready = false;
  const initialize = (schemaReady = false) => {
    if (schemaReady) ready = true;
    if (ready) return Promise.resolve();
    return initializing ??= (async () => {
      await migrateBackgroundResults(db);
      await migrateMonitors(db);
      await migrateMonitorAlertFeedback(db);
      ready = true;
    })().finally(() => { initializing = undefined; });
  };

  async function prepare(need: MonitorNeed, turn: Turn, blocked = false): Promise<PreparedMonitorTurn | null> {
    const spec = v2 ? generateMonitorV2Spec(need) : generateMonitorSpec(need);
    const sources = spec && (v2 ? monitorV2Targets(spec) : [spec]);
    if (!spec || !sources?.every(source => scopedSource(need, source))) {
      return blocked ? null : { text: monitorNeedReply(need) };
    }
    for (const { source } of sources) if (source.kind === 'page') {
      try { network.validate(source.url); }
      catch {
        return need.kind === 'explicit' ? { text: localized(need.language, 'أرسل رابط HTTPS عامًّا يمكن قراءته.', 'Send a readable public HTTPS address.') } : null;
      }
    }
    await initialize();
    let preview: MonitorReadResult;
    try {
      await store.reservePreview(turn.ownerId, turn.conversationId);
      const options = { ownerId: turn.ownerId, signal: turn.signal, reserveHost: store.reserveHost, extendHost: store.extendHost, preview: true };
      if (v2) {
        const prepared = await prepareMonitorV2Preview(reader.read, spec, options);
        if ('preview' in prepared) {
          const v2Preview = prepared.preview;
          const note = v2Preview.clarification
            ? localized(need.language, 'اختر القيمة التي تريد مراقبتها.', 'Choose the value you want to watch.') : monitorNeedReply(need, spec);
          return { text: note, proposal: { spec, observation: v2Preview.samples.find(sample => sample.index === 0)?.observation ?? null,
            offer: need.kind, note, v2Preview } };
        }
        preview = prepared.result;
      } else {
        preview = await reader.read(spec, options);
      }
    } catch (error) {
      turn.signal?.throwIfAborted();
      if (!(error instanceof BrowserError || error instanceof MonitorError)) throw error;
      return need.kind === 'explicit' ? { text: error.message } : null;
    }
    if (preview.kind !== 'value') {
      return !blocked ? { text: preview.kind === 'deferred'
        ? localized(need.language, 'للمصدر فترة انتظار بين الفحوص. أعد طلب المراقبة بعد قليل لمراجعة القيمة الحالية.', 'This source has a minimum interval between reads. Ask again shortly so I can show you its current value.')
        : localized(need.language, 'تعذّرت قراءة القيمة الحالية. تحقّق من الرابط العام أو حدّد الجزء المطلوب مراقبته.', 'I couldn’t read the current value. Check the public address or specify the part you want watched.') } : null;
    }
    if (blocked && (preview.observation.value === 'reachable' || preview.observation.value === 'published')) return null;
    const note = monitorNeedReply(need, spec);
    return { text: note, proposal: { spec, observation: preview.observation, cache: preview.cache, offer: need.kind, note } };
  }

  return {
    initialize, runtime, store, availableTo, v2,
    v2State: chatV2.state, confirmAction: chatV2.confirm, setProactiveOffers: chatV2.setProactiveOffers,
    async view(ownerId: string, conversationId: string) {
      if (!ready || !await availableTo(ownerId)) return {};
      const [listed, alerts] = await Promise.all([store.list(ownerId, conversationId), conversationMonitorAlerts(db, ownerId, conversationId)]);
      const cards = addMonitorCardAlerts(listed, alerts);
      const monitorProposal = cards.find(card => card.status === 'proposed');
      const monitors = cards.filter(card => card.status !== 'proposed');
      return { ...(monitorProposal ? { monitorProposal } : {}), ...(monitors.length ? { monitors } : {}),
        ...(alerts.length ? { monitorAlerts: alerts.map(({ alert }) => alert) } : {}) };
    },
    async forTurn(turn: Turn) {
      if (!(v2 || monitorHistoryMayMatter(turn.text)) || !await availableTo(turn.ownerId)) return null;
      if (v2) {
        const management = parseMonitorManagement(turn.text);
        if (management && !monitorContainsCredentials(turn.text)) {
          await initialize();
          return prepareMonitorManagement(store, turn.ownerId, turn.conversationId, management);
        }
      }
      if (!monitorHistoryMayMatter(turn.text) || !eligible(turn.text)) return null;
      const messages = await db.selectFrom('chat_messages as m').innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
        .select(['m.role', 'm.text']).where('c.id', '=', turn.conversationId).where('c.owner_id', '=', turn.ownerId)
        .orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(13).execute();
      const latest = messages.findIndex(message => message.role === 'user' && message.text === turn.text);
      if (latest >= 0) messages.splice(latest, 1);
      const need = detectMonitorNeed({ text: turn.text, history: messages.reverse() });
      return need && (!v2 || need.kind === 'explicit') ? prepare(need, turn) : null;
    },
    async forBlockedTurn(turn: BlockedTurn) {
      if (v2 || !address.test(turn.text) || !await availableTo(turn.ownerId) || !eligible(turn.text)) return null;
      const blocked = blockedSource(turn);
      if (!blocked) return null;
      const need = detectMonitorNeed({ text: turn.text, blocked });
      return need ? prepare(need, turn, true) : null;
    },
    async publishAnswerOffer(tx: Kysely<any>, turn: AnswerTurn, answer: string) {
      if (!v2 || !ready || !await availableTo(turn.ownerId, tx)) return '';
      const offer = detectMonitorAnswerOffer(turn.text, answer, turn.pages);
      if (!offer || monitorContainsCredentials(turn.text) || monitorContainsCredentials(offer.excerpt)) return '';
      const { ownerId, conversationId } = turn;
      const { language, url, title } = offer;
      const note = localized(language, 'أتريد أن أراقب هذه الصفحة وأنبّهك عندما تتغيّر الحالة؟', 'Would you like me to watch this page and let you know when the status changes?');
      const now = new Date();
      const spec: MonitorSpec = { source: { kind: 'page', url }, read: { kind: 'status', label: offer.label },
        condition: { kind: 'equals', value: offer.after }, language, title, message: note,
        timing: monitorTiming('page', 'normal', { now }), v2: { freshnessMs: MONITOR_V2_DEFAULT_FRESHNESS_MS } };
      const observation = { value: offer.before, excerpt: offer.excerpt, url, observedAt: offer.observedAt ?? now.toISOString() };
      const didOffer = await chatV2.offerOnce(tx, ownerId, conversationId, offer.topic, async () => {
        try {
          const card = await store.propose(ownerId, { conversationId, spec, observation, offer: 'agent-initiated', note,
            v2Preview: { samples: [{ index: 0, observation }], caches: [null] } }, tx);
          return card.status === 'proposed';
        } catch (error) {
          if (!(error instanceof MonitorError)) throw error;
          return false;
        }
      });
      return didOffer ? `\n\n${note}` : '';
    },
    async publish(tx: Kysely<any>, ownerId: string, conversationId: string, turn: PreparedMonitorTurn) {
      if (v2 && turn.management && await availableTo(ownerId, tx)) await chatV2.publishAction(tx, ownerId, conversationId, turn.management);
      if (!turn.proposal) return null;
      try {
        await store.propose(ownerId, { conversationId, ...turn.proposal }, tx);
        return null;
      } catch (error) {
        if (!(error instanceof MonitorError)) throw error;
        return localized(turn.proposal.spec.language, 'تعذّر حفظ عرض المراقبة. راجع عدد المراقبات النشطة والموعد النهائي.', error.message);
      }
    },
  };
}
