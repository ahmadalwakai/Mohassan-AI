import { BrowserError, type SearchProvider } from '@mohassan/browser';
import { ChatQuestionSchema, ChatRespondSchema, ChatSendSchema, type ChatConversation, type ChatQuestion } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import type { CommandChatConfig } from '../../command-chat.js';
import type { BrainState } from '../brain.js';
import { parseHands, webQuestion } from '../hands.js';
import { requestActionText } from '../request-context.js';
import { parseUserRequestConstraints, requestCapabilityAllowed, requestScopeActionText, type UserRequestConstraints } from '../request-scope.js';
import { routeClarifiedRequest, runClarificationGate } from './gate.js';
import { clarificationLanguage, missingClarificationSlot } from './policy.js';
import { isPendingClarification, resumeClarification } from './resume.js';
import { ordinaryClarificationQuery } from './search.js';
import { clarificationEntityReference } from './sources.js';

type ClarificationConfig = CommandChatConfig & { clarifyChoices?: boolean };
type AcceptedReply = { id: string; createdAt: number; text: string; priorRequest?: string };
type Reply = Promise<ChatConversation>;
type Change = (state: BrainState, tx: Kysely<any>, message: AcceptedReply) => void | Promise<void>;

interface ClarificationHost {
  db: Kysely<any>;
  config: ClarificationConfig;
  hasChatModel: () => boolean;
  resume: (ownerId: string, id: string, runId: string, change: Change, text: string,
    expected: { status: 'waiting_user'; field: 'question'; requestId: string }) => Reply;
  send: (ownerId: string, id: string, raw: unknown, intent?: 'task' | 'restore_browser' | 'review_browser', expectedCheckpointToken?: string) => Reply;
  respond: (ownerId: string, id: string, raw: unknown) => Reply;
}

interface WorkInput {
  config: ClarificationConfig;
  ownerId: string;
  id: string;
  runId: string;
  request: string;
  actionRequest: string;
  state: BrainState;
  history: readonly { role: string; text: string }[];
  signal: AbortSignal;
  constraints: UserRequestConstraints | null;
  eligible: boolean;
  fullAccess: boolean;
  chatModel: boolean;
  search: SearchProvider;
  active: () => Promise<void>;
  assertPublicSearch: (request: string, query: string, state: BrainState) => void;
  pause: (id: string, runId: string, state: BrainState, status: 'waiting_user', fields: Record<string, unknown>, say: string) => Promise<void>;
}

const clarificationEnabled = (override?: boolean) => override ?? process.env.MOHASSAN_CLARIFY_CHOICES === '1';

export function clarifyDesktopFile<T>(request: string, parse: (text: string) => T | null, override?: boolean): T | null {
  return clarificationEnabled(override) && missingClarificationSlot(request) === 'file' ? null : parse(request);
}

/** Select the new gate or the caller's existing clarifier. The legacy callback returns false when it has no question. */
export async function clarifyCommand(input: WorkInput, legacy: () => Promise<false | void>): Promise<boolean> {
  const { config, ownerId, id, runId, state } = input;
  const enabled = clarificationEnabled(config.clarifyChoices);
  try {
    const handled = await runClarificationGate({ ...input, enabled, shadowRouter: config.shadowRouter, readPage: config.readPage,
      memory: config.tools?.memory?.search.bind(config.tools.memory),
      route: text => routeClarifiedRequest(text, config, input.fullAccess, input.chatModel, input.runId),
      search: async (subject, limit, signal) => {
        const query = ordinaryClarificationQuery(input.actionRequest, input.history) ?? subject;
        await input.active();
        input.assertPublicSearch(input.request, query, state);
        return input.search.search(query, limit, signal, { ownerId });
      },
      pause: question => {
        // Let the existing resume transaction load the original request before saving the answer.
        state.requestClarification = { attempts: 1 };
        return input.pause(id, runId, state, 'waiting_user', { question: JSON.stringify(question) }, question.prompt);
      },
    });
    if (handled) return true;
  } catch (error) {
    if (enabled) throw error;
    // Shadow inspection cannot alter the disabled path.
  }
  return !enabled && input.eligible && (await legacy()) !== false;
}

/** Preserve explicit public questions that the legacy hands parser treats as small talk. */
function preparePublicLookup(state: BrainState) {
  if (!state.clarifiedRequest || state.routing?.route !== 'web_search' || !state.requestResolution?.sourceAssessment?.publicQueryEligible) return;
  if (!requestCapabilityAllowed(parseUserRequestConstraints(state.clarifiedRequest), 'public_search')) return;
  const action = requestActionText(requestScopeActionText(state.clarifiedRequest));
  if (parseHands(action) || webQuestion(action)) return;
  const query = clarificationEntityReference(action);
  if (query) state.hands = { steps: [{ kind: 'search', query, site: null, ask: true }], next: 0, lang: clarificationLanguage(action) };
}

/** Adapt the two existing card answer entry points. Only the host can claim and dispatch the active run. */
export function clarificationAnswers(host: ClarificationHost) {
  async function pendingQuestion(ownerId: string, id: string) {
    const row = await host.db.selectFrom('chat_conversations as c').innerJoin('chat_runs as r', 'r.id', 'c.active_run_id')
      .select(['c.question', 'r.id as runId', 'r.state']).where('c.owner_id', '=', ownerId).where('c.id', '=', id)
      .where('c.status', '=', 'waiting_user').where('r.status', '=', 'waiting_user').executeTakeFirst();
    const question = ChatQuestionSchema.safeParse(row?.question);
    return row?.state && question.success && isPendingClarification(row.state, question.data.id)
      ? { runId: String(row.runId), question: question.data } : null;
  }

  const changed = () => new BrowserError('CHAT_QUESTION_CHANGED', 'هذا السؤال لم يعد معلقًا.', 409);

  function resume(ownerId: string, id: string, pending: { runId: string; question: ChatQuestion }, answer: string): Reply {
    const { config } = host;
    const { runId, question: { id: questionId } } = pending;
    return host.resume(ownerId, id, runId, async (state, tx, message) => {
      if (!isPendingClarification(state, questionId)) throw changed();
      const fullAccess = config.accountFullAccess ? await config.accountFullAccess(ownerId, tx) : !config.fullAccess;
      const route = (text: string) => routeClarifiedRequest(text, config, fullAccess, host.hasChatModel(), runId);
      if (!resumeClarification(state, { runId, questionId, message, route })) throw changed();
      preparePublicLookup(state);
    }, answer, { status: 'waiting_user', field: 'question', requestId: questionId });
  }

  const send: ClarificationHost['send'] = async (ownerId, id, raw, intent = 'task', expectedCheckpointToken) => {
    const input = ChatSendSchema.safeParse(raw);
    if (intent === 'task' && input.success && !input.data.images) {
      const pending = await pendingQuestion(ownerId, id);
      if (pending) {
        const { text, answers, questionId } = input.data;
        if (questionId && questionId !== pending.question.id) throw changed();
        if (!answers) return resume(ownerId, id, pending, text);
        if (answers.length !== 1 || answers[0]?.fieldId !== pending.question.fields?.[0]?.id) throw changed();
        return resume(ownerId, id, pending, answers[0].value);
      }
    }
    return host.send(ownerId, id, raw, intent, expectedCheckpointToken);
  };

  const respond: ClarificationHost['respond'] = async (ownerId, id, raw) => {
    const input = ChatRespondSchema.safeParse(raw);
    if (input.success) {
      const pending = await pendingQuestion(ownerId, id);
      if (pending) {
        if (input.data.questionId !== pending.question.id) throw changed();
        const option = pending.question.options.find(option => option.id === input.data.optionId);
        if (!option) throw changed();
        return resume(ownerId, id, pending, option.label);
      }
    }
    return host.respond(ownerId, id, raw);
  };
  return { send, respond };
}
