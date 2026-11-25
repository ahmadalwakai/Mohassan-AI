import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { commandChatMigration } from '../apps/server/src/command-chat.js';
import { mergePublicQueryTerms } from '../apps/server/src/assistant/public-query-provenance.js';
import { routeWithQuestionHistory } from '../apps/server/src/assistant/question-rewrite-chat.js';
import { resolveRequestContext } from '../apps/server/src/assistant/request-context.js';
import { decideHostRequestRoute, type RequestRoutingInput } from '../apps/server/src/assistant/routing-decision.js';

describe('English follow-up routing in live chat', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  const conversationId = randomUUID();
  const previousQuestion = 'What happened at Cedar House?';
  const previousAnswer = 'Ivo Marin renovated the studio.';
  const followUp = 'When did he renovate the studio?';
  const context = resolveRequestContext(previousQuestion).nextState;
  const knownTerms = mergePublicQueryTerms([], [previousQuestion]);
  const observedTerms = mergePublicQueryTerms(knownTerms, [previousAnswer]);

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    await commandChatMigration(database.db);
    await database.db.insertInto('chat_conversations').values({
      id: conversationId, owner_id: 'followup-v2-test-owner', title: 'Cedar House',
    }).execute();
    await database.db.insertInto('chat_messages').values([
      { id: randomUUID(), conversation_id: conversationId, role: 'user', text: previousQuestion, created_at: new Date(0) },
      { id: randomUUID(), conversation_id: conversationId, role: 'assistant', text: previousAnswer, created_at: new Date(1000) },
    ]).execute();
  });

  beforeEach(() => {
    vi.stubEnv('MOHASSAN_QUESTION_REWRITER', '1');
    vi.stubEnv('MOHASSAN_FOLLOWUP_V2', '1');
    vi.stubEnv('MOHASSAN_REFUSAL_POLICY', '1');
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await database?.close(); });

  function input(overrides?: Partial<RequestRoutingInput>): RequestRoutingInput {
    return { text: followUp, context, previousTurns: 1, capabilities: { browser: true, search: true }, ...overrides };
  }

  function route(publicTerms: readonly string[], overrides?: Partial<RequestRoutingInput>) {
    return routeWithQuestionHistory(database.db, conversationId, publicTerms, true, input(overrides));
  }

  it('routes to existing search with the actor from the public answer and keeps the original question', async () => {
    expect(await route(observedTerms)).toMatchObject({
      route: 'web_search', handler: 'search', reason: 'rewritten_question',
      publicQuery: 'When did Ivo Marin renovate the studio?',
      resolution: { kind: 'follow_up', original: followUp },
      sourceAssessment: { source: 'public_lookup', publicQueryEligible: true },
    });

    vi.stubEnv('MOHASSAN_FOLLOWUP_V2', '0');
    expect(await route(observedTerms)).toMatchObject({
      route: 'web_search', handler: 'search', publicQuery: 'When did Cedar House renovate the studio?',
    });

    vi.stubEnv('MOHASSAN_QUESTION_REWRITER', '0');
    vi.stubEnv('MOHASSAN_FOLLOWUP_V2', '1');
    expect(await route(observedTerms)).toEqual(decideHostRequestRoute(input()));
  });

  it('retains the legacy route when answer terms lack public provenance', async () => {
    const unproven = await route(knownTerms);
    expect(unproven.publicQuery).not.toContain('Ivo Marin');
    vi.stubEnv('MOHASSAN_FOLLOWUP_V2', '0');
    expect(unproven).toEqual(await route(knownTerms));

    vi.stubEnv('MOHASSAN_FOLLOWUP_V2', '1');
    const privateContext = resolveRequestContext('Recall my saved notes about the studio.').nextState;
    const privateTurn = { context: privateContext };
    expect(await route(observedTerms, privateTurn)).toEqual(decideHostRequestRoute(input(privateTurn)));
  });

  it('carries an authorized public question across a year change', async () => {
    const prior = 'What was the population of Spruce Bay in 2013?';
    const dateConversation = randomUUID();
    await database.db.insertInto('chat_conversations').values({
      id: dateConversation, owner_id: 'followup-v2-test-owner', title: 'Spruce Bay',
    }).execute();
    await database.db.insertInto('chat_messages').values({
      id: randomUUID(), conversation_id: dateConversation, role: 'user', text: prior, created_at: new Date(0),
    }).execute();
    const pendingInput = input({ text: 'In 2014?', context: resolveRequestContext(prior).nextState });
    const terms = mergePublicQueryTerms([], [prior]);
    expect(await routeWithQuestionHistory(database.db, dateConversation, terms, true, pendingInput)).toMatchObject({
      route: 'web_search', handler: 'search', reason: 'rewritten_question',
      publicQuery: 'What was the population of Spruce Bay in 2014?',
      resolution: { kind: 'follow_up', original: 'In 2014?' },
    });
  });

  it('preserves the pending answer and a refusal in a conversation with public history', async () => {
    expect(await route(observedTerms, { text: 'Cedar House', pendingQuestion: { id: 'place-needed', route: 'web_search' } })).toMatchObject({
      route: 'reply', handler: 'resume', reason: 'pending_answer', publicQuery: null,
    });
    expect(await route(observedTerms, { text: 'Can you buy the camera for me?' })).toMatchObject({
      route: 'unsupported', handler: 'unsupported', reason: 'request_refused', publicQuery: null,
    });
  });
});
