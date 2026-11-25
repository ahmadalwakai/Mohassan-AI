import { createHash } from 'node:crypto';
import { BrowserError, readableSource, RobotsPolicy, safeResumeUrl, SafeNetwork } from '@mohassan/browser';
import { redactCredentialText } from '@mohassan/cognitive';
import { ChatCreateSchema, ChatSendSchema } from '@mohassan/contracts';
import { redactSecrets } from '@mohassan/providers';
import { completeBrief } from '@mohassan/sites';
import type { createCommandChatControl, CommandChatConfig } from '../../command-chat.js';
import { withMemberChatDeletionFence } from '../../member-chat-deletion-fence.js';
import { legacyMonitorHandledBySmartChat } from '../../monitors/chat.js';
import { classifySteering } from '../agent-run.js';
import { newBrainState } from '../brain.js';
import { matchText } from '../mind/normalize.js';
import { reviewWorkRefusal } from '../refusal/turn.js';
import { splitReplyDirective } from '../reply-directive.js';
import { assessRequestScope, parseUserRequestConstraints, requestCapabilityAllowed, reviewPublicProjection } from '../request-scope.js';
import { decideResponsePolicy } from '../response-policy.js';
import { monitoringRequest } from '../response-policy-signals.js';
import { siteTask } from '../site-builder.js';
import { backgroundTaskText } from './background-request.js';
import { LONG_RUN_MIGRATION, migrateLongRuns } from './migration.js';
import { createLongRunRuntime, LongRunTransientError, type LongRunPorts } from './runtime.js';
import { LONG_RUN_LIMITS, LONG_RUN_WORKER, say, type LongRunPlan } from './state.js';

const maxMonitorMs = 2 * 60 * 60_000;
const cleanup = (text: string) => redactCredentialText(redactSecrets(text));
const monitorAddress = /https?:\/\/[^\s<>"'«»]+/iu;
const researchLead = /^(?:(?:please|kindly|من فضلك|لو سمحت)[,،\s]+)?(?:(?:research|investigate|search(?: (?:the web|online))?)\s+(?:deeply\s+|(?:for|about)\s+)?|(?:conduct|do|carry out|run) (?:an? )?(?:deep|thorough|systematic|comprehensive) (?:research|investigation|review|study) (?:on|about)\s+|(?:ابحث|استقص|حقق|ادرس)(?:\s+(?:بعمق|بشكل معمق))?\s+(?:عن|في)\s+)/iu;
const researchTail = /\s+(?:(?:in depth|deeply|thoroughly|across sources|(?:from|using|with) (?:multiple|primary|public|several) sources)|(?:(?:من|باستخدام) )?مصادر (?:متعددة|متعدده|أولية|متنوعه|مختلفة|مختلفه)|بعمق)[.!؟?\s]*$/iu;
const withoutCredentials = (text: string) => cleanup(text) === text && !assessRequestScope(text).reasons.includes('credential_material');

function publicUrl(network: SafeNetwork, value: string) {
  if (value.length > 2048 || /[<>()\s]/u.test(value)) return null;
  try { return safeResumeUrl(network.validate(value).href); } catch { return null; }
}

function monitorDelays(text: string): number[] | null {
  const normalized = matchText(text)
    .replace(/\b(?:for the next|over the next) /gu, 'for ')
    .replace(/\bfor (?:a|an|one) (minute|hour)\b/gu, 'for 1 $1').replace(/\bfor two (minutes|hours)\b/gu, 'for 2 $1')
    .replace(/لمده ساعتين/u, 'لمده 2 ساعه').replace(/لمده ساعه(?!\p{L})/u, 'لمده 1 ساعه');
  const duration = /(?:\bfor |لمده |خلال )(\d+)\s*(minutes?|hours?|دقيقه|دقائق|ساعه|ساعات)(?!\p{L})/u.exec(normalized);
  if (!duration) return null;
  const milliseconds = ([, count, units]: RegExpExecArray) => Number(count) * (/(?:^h|ساع)/u.test(units!) ? 60 : 1) * 60_000;
  const durationMs = milliseconds(duration);
  const frequency = /(?:\bevery |كل )(\d+)\s*(minutes?|hours?|دقيقه|دقائق|ساعه|ساعات)(?!\p{L})/u.exec(normalized);
  const interval = frequency ? milliseconds(frequency) : Math.min(durationMs, 30 * 60_000);
  if (durationMs <= 0 || durationMs > maxMonitorMs || interval < 60_000 || interval > durationMs || Math.ceil(durationMs / interval) >= LONG_RUN_LIMITS.steps) return null;
  const delays = [0];
  for (let elapsed = 0; elapsed < durationMs; elapsed += interval) delays.push(Math.min(interval, durationMs - elapsed));
  return delays;
}

export function planLongRun(text: string, config: Pick<CommandChatConfig, 'searchProvider' | 'sites'>, network: SafeNetwork, backgroundEnabled = false): LongRunPlan | null {
  const constraints = parseUserRequestConstraints(text);
  const safeAction = constraints?.safeActionText ?? text;
  const request = backgroundEnabled ? backgroundTaskText(splitReplyDirective(safeAction).body) : { task: safeAction, requested: false };
  const decision = decideResponsePolicy({ text, constraints, backgroundRequested: request.requested, ...(backgroundEnabled ? { currentLength: 'long' } : {}) });
  if (decision.workMode !== 'long_running' || !withoutCredentials(text)) return null;
  const { language } = decision;
  const action = request.task;
  const plan = (steps: LongRunPlan['steps']): LongRunPlan => ({ language, steps, ...(backgroundEnabled ? { background: { replyLength: decision.length } } : {}) });
  if (monitoringRequest(matchText(action))) {
    const address = monitorAddress.exec(action)?.[0].replace(/[.,،;؛!?؟]+$/u, '');
    if (!address || assessRequestScope(action).scope === 'private' || !requestCapabilityAllowed(constraints, 'browser_navigation')) return null;
    const url = publicUrl(network, address);
    const delays = monitorDelays(action);
    if (!url || !delays) throw new BrowserError('CHAT_LONG_MONITOR_LIMIT', say(language,
      'حدّد عنوان HTTPS عامًا ومدة مراقبة حتى ساعتين، بفاصل يسمح بـ 12 فحصًا أو أقل.',
      'Give a public HTTPS URL and a monitoring duration of up to two hours, with an interval that allows at most 12 checks.'), 400);
    return plan(delays.map(delayMs => ({ kind: 'monitor', url, delayMs })));
  }
  if (config.searchProvider && researchLead.test(action) && requestCapabilityAllowed(constraints, 'public_search')
      && requestCapabilityAllowed(constraints, 'browser_navigation') && assessRequestScope(action).scope !== 'private') {
    const query = action.replace(researchLead, '').replace(researchTail, '').replace(/[.!؟?\s]+$/u, '');
    const explicitPublicQuery = say(language, `ابحث عن ${query}`, `Search for ${query}`);
    if (!query || query.length > 500 || !reviewPublicProjection(explicitPublicQuery, query).eligible) return null;
    return plan([{ kind: 'search', query }, ...[0, 1, 2, 3].map(index => ({ kind: 'read_source' as const, index }))]);
  }
  const site = config.sites && siteTask(action);
  // Keep the existing clarification flow for incomplete content. This adapter
  // creates a draft only, so requests for publication stay on their own path.
  if (!site || /\b(?:publish|deploy|pay|purchase)\b|(?:انشر|نشر الموقع|ادفع|ادفعوا|اشتري)/iu.test(action)) return null;
  const completion = completeBrief(site.partial, { requestText: site.requestText });
  if ('missing' in completion) return null;
  const approval = /\b(?:ask|get (?:my )?(?:permission|approval)|confirm with me) before\b|(?:استاذن|استأذن|اطلب موافقتي|اسالني|اسألني) قبل/iu.test(action);
  return plan([{ kind: 'prepare_site', brief: completion.brief }, { kind: 'build_site', approval }]);
}

function adapter(config: CommandChatConfig, network: SafeNetwork): LongRunPorts {
  const robots = new RobotsPolicy(network);
  return {
    accountActive: config.accountActive,
    async execute({ ownerId, conversationId, operation, state, signal }) {
      if (operation.kind === 'search') {
        try {
          const results = await config.searchProvider!.search(operation.query, 4, signal, { ownerId });
          return { kind: 'searched', urls: [...new Set(results.slice(0, 4).flatMap(result => publicUrl(network, result.url) ?? []))] };
        } catch (error) {
          if (error instanceof BrowserError && (error.statusCode === 429 || error.statusCode >= 500)) throw new LongRunTransientError();
          throw error;
        }
      }
      if (operation.kind === 'prepare_site') return { kind: 'verified' };
      if (operation.kind === 'build_site') {
        const draft = state.longRun.steps.find(item => item.kind === 'prepare_site');
        if (!draft || !config.sites) return { kind: 'unavailable' };
        const role = config.sites.roleOf ? await config.sites.roleOf(ownerId) : undefined;
        if (role === null) return { kind: 'unavailable' };
        signal.throwIfAborted();
        const site = await config.sites.createFromBrief(ownerId, draft.brief, { conversationId, role });
        signal.throwIfAborted();
        const errors = site.checks.checks.filter(item => !item.passed);
        const preview = config.sites.link?.(site.id);
        const summary = say(state.longRun.language, `بنيت مسودة الموقع «${site.name}».`, `I built the “${site.name}” draft website.`);
        const link = preview && say(state.longRun.language, `[افتح المعاينة](<${preview}>)`, `[Open the preview](<${preview}>)`);
        const warning = errors.length ? say(state.longRun.language, 'فحوص لم تجتز:', 'Checks that did not pass:') + ' ' + errors.map(item => item.message).join(' | ') : '';
        const text = [summary, link, warning].filter(Boolean).join('\n\n');
        return { kind: 'site', id: site.id, text: cleanup(text).slice(0, 4000), partial: Boolean(errors.length) };
      }
      const selected = operation.kind === 'monitor' ? operation.url : state.longRun.candidates[operation.index];
      if (!selected) return { kind: 'unavailable' };
      try {
        // Apply network and robots policy to every redirect before following it.
        let url = selected;
        for (let redirect = 0; redirect <= 3; redirect++) {
          await robots.assertAllowed(url, signal);
          const response = await network.request(url, { signal, maxBytes: 2_000_000 });
          if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
            const target = publicUrl(network, new URL(response.headers.location, url).href);
            if (!target) return { kind: 'unavailable' };
            url = target;
            continue;
          }
          if (response.status === 401 || response.status === 402 || response.status === 407) {
            return { kind: 'input', reason: response.status === 402 ? 'payment' : response.status === 407 ? 'credentials' : 'sign_in', site: new URL(url).origin };
          }
          if (response.status === 429 || response.status >= 500) throw new LongRunTransientError();
          if (response.status >= 400 || !/^(?:text\/html|application\/xhtml\+xml|text\/plain)(?:[;\s]|$)/iu.test(response.headers['content-type'] ?? ''))
            return { kind: 'unavailable' };
          const raw = new TextDecoder().decode(response.body);
          if (/<(?:input|form)\b[^>]{0,1000}\btype\s*=\s*["']?password\b/iu.test(raw))
            return { kind: 'input', reason: 'sign_in', site: new URL(url).origin };
          const observed = readableSource(raw, url), body = cleanup(observed.text);
          if (!body.trim()) return { kind: 'unavailable' };
          return { kind: 'observed', observation: { url, title: cleanup(observed.title), quote: body.slice(0, 700),
            hash: createHash('sha256').update(body).digest('hex') } };
        }
        return { kind: 'unavailable' };
      } catch (error) {
        if (error instanceof BrowserError && (error.statusCode === 429 || error.statusCode >= 500)) throw new LongRunTransientError();
        throw error;
      }
    },
  };
}

type Chat = Awaited<ReturnType<typeof createCommandChatControl>>;

/** Layers durable execution onto the same conversation, stop and approval routes. */
export async function withLongRunChat(db: Parameters<typeof createCommandChatControl>[0], config: CommandChatConfig, chat: Chat): Promise<Chat> {
  const enabled = process.env.MOHASSAN_LONG_RUN_ENABLED === '1';
  const backgroundEnabled = process.env.MOHASSAN_BACKGROUND_RESULTS_ENABLED === '1';
  if (enabled) await migrateLongRuns(db);
  else if (!await db.selectFrom('schema_migrations').select('version').where('version', '=', LONG_RUN_MIGRATION).executeTakeFirst()) return chat;
  const network = new SafeNetwork(config.networkPolicy);
  const runner = createLongRunRuntime(db, adapter(await withMemberChatDeletionFence(db, config), network));
  runner.start();

  async function select(ownerId: string, text: string) {
    if (!enabled || legacyMonitorHandledBySmartChat(text)) return null;
    const full = config.fullAccess ? await config.fullAccess(ownerId) : true;
    if (reviewWorkRefusal(text, newBrainState(), full, { computer: Boolean(config.tools?.computer || config.desktop), memory: Boolean(config.tools?.memory) })) return null;
    return planLongRun(text, config, network, backgroundEnabled);
  }

  async function start(ownerId: string, conversationId: string, text: string, plan: LongRunPlan) {
    await runner.admission(ownerId, conversationId, cleanup(text), plan);
    if (plan.background) {
      try { return await chat.detail(ownerId, conversationId); }
      finally { runner.wake(); }
    }
    runner.wake();
    return chat.detail(ownerId, conversationId);
  }

  async function stop(ownerId: string, conversationId: string) {
    // The existing chat cancellation fences the persisted run before aborting
    // local work. A different server will see that fence on its next poll.
    const own = await db.selectFrom('chat_conversations as c').innerJoin('chat_runs as r', 'r.id', 'c.active_run_id').select('r.id')
      .where('c.id', '=', conversationId).where('c.owner_id', '=', ownerId).where('r.owner_id', '=', ownerId)
      .where('r.worker_id', '=', LONG_RUN_WORKER).executeTakeFirst();
    const result = await chat.cancel(ownerId, conversationId);
    if (own) runner.stopWork(own.id);
    return result;
  }

  return {
    ...chat,
    async create(ownerId, raw = {}) {
      const input = ChatCreateSchema.parse(raw);
      const plan = input.goal && !input.images?.length ? await select(ownerId, input.goal) : null;
      if (!plan) return chat.create(ownerId, raw);
      const conversation = await chat.create(ownerId, { browserAccount: input.browserAccount });
      try { return await start(ownerId, conversation.id, input.goal!, plan); }
      catch (error) {
        if (error instanceof BrowserError && error.code === 'CHAT_LONG_RUN_ACTIVE') await chat.remove(ownerId, conversation.id);
        throw error;
      }
    },
    async send(ownerId, conversationId, raw) {
      const input = ChatSendSchema.parse(raw);
      if (await runner.owns(ownerId, conversationId)) {
        if (!input.images?.length && !input.answers && classifySteering(input.text) === 'stop') return stop(ownerId, conversationId);
        const lang = decideResponsePolicy({ text: input.text }).language;
        throw new BrowserError('CHAT_LONG_RUN_ACTIVE', say(lang, 'أوقف المهمة الطويلة أو أجب عن بطاقة المتابعة.', 'Stop the long-running task or respond to its open card.'), 409);
      }
      const plan = !input.images?.length && !input.questionId && !input.answers ? await select(ownerId, input.text) : null;
      return plan ? start(ownerId, conversationId, input.text, plan) : chat.send(ownerId, conversationId, raw);
    },
    async approve(ownerId, conversationId, raw) {
      if (!await runner.owns(ownerId, conversationId)) return chat.approve(ownerId, conversationId, raw);
      await runner.approve(ownerId, conversationId, raw);
      runner.wake();
      return chat.detail(ownerId, conversationId);
    },
    async secureSubmit(ownerId, conversationId, raw) {
      if (!await runner.owns(ownerId, conversationId)) return chat.secureSubmit(ownerId, conversationId, raw);
      await runner.respondToInput(ownerId, conversationId, raw);
      runner.wake();
      return chat.detail(ownerId, conversationId);
    },
    cancel: stop,
    async shutdown() {
      await runner.shutdown();
      await chat.shutdown();
    },
  };
}
