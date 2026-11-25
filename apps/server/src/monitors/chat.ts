import { BrowserError, SafeNetwork, SearchEngine } from '@mohassan/browser';
import type { MonitorOffer, MonitorSpec } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import { assessRequestScope, requestCapabilityAllowed, reviewPublicProjection } from '../assistant/request-scope.js';
import { monitoringRequest } from '../assistant/response-policy-signals.js';
import { matchText } from '../assistant/mind/normalize.js';
import { migrateBackgroundResults } from '../background-results-migration.js';
import type { CommandChatConfig } from '../command-chat.js';
import { detectMonitorNeed, monitorHistoryMayMatter, safeMonitorRequest, type MonitorNeed } from './detection.js';
import { smartMonitorsEnabled } from './flag.js';
import { migrateMonitors } from './migration.js';
import { observePage } from './page.js';
import { createMonitorRuntime } from './runtime.js';
import { createMonitorReader, type MonitorReadResult } from './sources.js';
import { generateMonitorSpec, monitorNeedReply } from './spec.js';
import { createMonitorStore, MonitorError } from './store.js';

type Configuration = Pick<CommandChatConfig, 'networkPolicy' | 'searchProvider'>;
type SourceValue = Extract<MonitorReadResult, { kind: 'value' }>;
export interface PreparedMonitorTurn {
  text: string;
  proposal?: { spec: MonitorSpec; observation: SourceValue['observation']; cache?: SourceValue['cache']; offer: MonitorOffer; note: string };
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

const localized = (language: MonitorNeed['language'], ar: string, en: string) => language === 'ar' ? ar : en;
const address = /https:\/\/[^\s<>"'«»]+/iu;
const controls = new WeakMap<Kysely<any>, ReturnType<typeof createMonitorChat>>();

export function installMonitorChat(db: Kysely<any>, config: Configuration) {
  if (!smartMonitorsEnabled()) return;
  if (!controls.has(db)) controls.set(db, createMonitorChat(db, config));
  return controls.get(db);
}

export const monitorChat = (db: Kysely<any>) => controls.get(db);

function eligible(text: string) {
  return Boolean(safeMonitorRequest(text));
}

function scopedSource(need: MonitorNeed, spec: MonitorSpec) {
  const scope = assessRequestScope(need.text);
  if (spec.source.kind === 'page') return requestCapabilityAllowed(scope.constraints ?? null, 'browser_navigation');
  if (spec.source.kind === 'search') {
    return requestCapabilityAllowed(scope.constraints ?? null, 'public_search')
      && reviewPublicProjection(`Search for ${spec.source.query}`, spec.source.query).eligible;
  }
  return true;
}

export function legacyMonitorHandledBySmartChat(text: string) {
  return smartMonitorsEnabled() && (monitoringRequest(matchText(text)) || detectMonitorNeed({ text })?.kind === 'explicit');
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

function createMonitorChat(db: Kysely<any>, config: Configuration) {
  const network = new SafeNetwork({ resolver: config.networkPolicy?.resolver, userAgent: config.networkPolicy?.userAgent });
  const searchProvider = config.searchProvider instanceof SearchEngine ? undefined : config.searchProvider;
  const reader = createMonitorReader({ db, network, searchProvider });
  const store = createMonitorStore(db);
  const runtime = createMonitorRuntime(db, { read: reader.read, store });
  let initializing: Promise<void> | undefined;
  let ready = false;
  const initialize = (schemaReady = false) => {
    if (schemaReady) ready = true;
    if (ready) return Promise.resolve();
    return initializing ??= (async () => {
      await migrateBackgroundResults(db);
      await migrateMonitors(db);
      ready = true;
    })().finally(() => { initializing = undefined; });
  };

  async function prepare(need: MonitorNeed, turn: Turn, blocked = false): Promise<PreparedMonitorTurn | null> {
    const spec = generateMonitorSpec(need);
    if (!spec || !scopedSource(need, spec)) {
      return blocked ? null : { text: monitorNeedReply(need) };
    }
    if (spec.source.kind === 'page') {
      try { network.validate(spec.source.url); }
      catch {
        return need.kind === 'explicit' ? { text: localized(need.language, 'أرسل رابط HTTPS عامًّا يمكن قراءته.', 'Send a readable public HTTPS address.') } : null;
      }
    }
    await initialize();
    let preview: MonitorReadResult;
    try {
      await store.reservePreview(turn.ownerId, turn.conversationId);
      preview = await reader.read(spec, { ownerId: turn.ownerId, signal: turn.signal, reserveHost: store.reserveHost, extendHost: store.extendHost, preview: true });
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
    initialize, runtime, store,
    async view(ownerId: string, conversationId: string) {
      if (!ready) return {};
      const cards = await store.list(ownerId, conversationId);
      const monitorProposal = cards.find(card => card.status === 'proposed');
      const monitors = cards.filter(card => card.status !== 'proposed');
      return { ...(monitorProposal ? { monitorProposal } : {}), ...(monitors.length ? { monitors } : {}) };
    },
    async forTurn(turn: Turn) {
      if (!monitorHistoryMayMatter(turn.text) || !eligible(turn.text)) return null;
      const messages = await db.selectFrom('chat_messages as m').innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
        .select(['m.role', 'm.text']).where('c.id', '=', turn.conversationId).where('c.owner_id', '=', turn.ownerId)
        .orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(13).execute();
      const latest = messages.findIndex(message => message.role === 'user' && message.text === turn.text);
      if (latest >= 0) messages.splice(latest, 1);
      const need = detectMonitorNeed({ text: turn.text, history: messages.reverse() });
      return need ? prepare(need, turn) : null;
    },
    async forBlockedTurn(turn: BlockedTurn) {
      if (!address.test(turn.text) || !eligible(turn.text)) return null;
      const blocked = blockedSource(turn);
      if (!blocked) return null;
      const need = detectMonitorNeed({ text: turn.text, blocked });
      return need ? prepare(need, turn, true) : null;
    },
    async publish(tx: Kysely<any>, ownerId: string, conversationId: string, turn: PreparedMonitorTurn) {
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
