import { Console } from 'node:console';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createDatabase, migrate } from '@mohassan/database';
import { describe, expect, it } from 'vitest';
import { readActivationLogEvents, readDeliberationLedger, subscribeActivationConsoleLogs } from '../apps/server/src/activation-log-sources.js';
import { migrateActivationConsole } from '../apps/server/src/activation-migration.js';
import { activationCapability, readActivationEvent } from '../apps/server/src/activation-registry.js';
import { attachActivationRuntime, bindActivationRuntime } from '../apps/server/src/activation-runtime.js';
import { commandChatMigration } from '../apps/server/src/command-chat.js';

describe('activation shadow registry', () => {
  it('ignores unknown event names and leaves uninstrumented capabilities without events', () => {
    expect(readActivationEvent('unrelated_event', { changed: true })).toBeNull();
    expect(activationCapability('reasoning')).toMatchObject({ flag: 'MOHASSAN_REASONING', eventNames: [] });
    expect(activationCapability('offline-knowledge')).toMatchObject({ flag: null, eventNames: [] });
    expect(activationCapability('browser-hands')).toMatchObject({ flag: 'AppConfig.browserHands', shadowValue: 'shadow' });
    expect(activationCapability('answer-selection')?.gateId).toBe('answer-selection');
    expect(activationCapability('arabic-understanding')?.differencesOnly).toBe(true);
  });

  it('projects only finite codes, even when a log contains secrets in expected or nested fields', () => {
    const hidden = 'password=sample-private-value';
    const event = readActivationEvent('arabic_understanding_shadow_difference', {
      legacy: { intent: hidden, kind: 'new', question: hidden }, query: hidden,
      normalized: { intent: 'web_search', reply: hidden }, legacyRoute: hidden,
      normalizedRoute: 'web_search', routeChanges: [hidden],
    });
    expect(event).toMatchObject({ changed: true, category: 'route', baseline: 'new', shadow: 'web_search' });
    expect(JSON.stringify(event)).not.toContain(hidden);
    expect(readActivationEvent('browser_task_shadow', { steps: ['open', hidden, 'find'], risk: hidden }))
      .toMatchObject({ changed: null, category: null, shadow: 'open → find' });
  });

  it('separates confirmed differences, agreements, unknown comparisons, and errors', () => {
    expect(readActivationEvent('answer_selection_shadow', { baseline: 'answer', ranker: 'answer', sameSource: true, sameQuote: false }))
      .toMatchObject({ changed: true, category: 'quote', baseline: 'answer', shadow: 'answer' });
    expect(readActivationEvent('answer_selection_shadow', { baseline: 'answer', ranker: 'answer', sameSource: true, sameQuote: true }))
      .toMatchObject({ changed: false });
    expect(readActivationEvent('answer_selection_shadow', { baseline: 'answer', ranker: 'abstain', choice: 'legacy' }))
      .toMatchObject({ changed: null });
    expect(readActivationEvent('plan_compiler_shadow', { status: 'compile_failed' }))
      .toMatchObject({ changed: null, error: true });
    expect(readActivationEvent('clarification_shadow', { legacyWouldAsk: true, decision: 'ask', kind: 'entity' }))
      .toMatchObject({ changed: true, baseline: 'ask_generic', shadow: 'ask_choices' });
    expect(readActivationEvent('judge.conversationReview', { decision: 'send', conversationReview: { action: 'fix', ms: 12.5, findings: [{ check: 'coverage' }] } }))
      .toMatchObject({ changed: true, latencyMs: 12.5, category: 'coverage' });
    expect(readActivationEvent('conversation.agreement', { agreement: { type: true, standalone: false }, ms: -1 }))
      .toMatchObject({ changed: true, latencyMs: null, category: 'standalone' });
  });
  it('keeps operational telemetry but excludes observations when the producer says its capability was applied', () => {
    const trace = { version: 1, enforced: true, disagrees: true, legacy: { action: 'ask' }, chosen: { action: 'abstain' } };
    const events = [
      ['arabic_understanding_shadow_difference', { active: true, legacyRoute: 'chat', normalizedRoute: 'compute' }],
      ['answer_selection_shadow', { applied: true, baseline: 'abstain', ranker: 'answer', choice: 'ranker' }],
      ['judge.truth', { decision: 'send', truth: { applied: true, decision: 'withhold' } }],
      ['judge.conversationReview', { decision: 'send', conversationReview: { applied: true, action: 'fix', ms: 3 } }],
      ['clarification_shadow', { enabled: true, legacyWouldAsk: false, decision: 'ask' }],
      ['extractive_writing_shadow', { enabled: true, operation: 'summary' }],
      ['conversation.agreement', { mode: 'active', agreement: { type: false }, ms: 4 }],
      ['attachment_deliberation', { ledger: { deliberation: trace } }],
      ['run.deliberation', trace],
    ] as const;
    for (const [name, data] of events) {
      expect(readActivationEvent(name, data)).toMatchObject({ changed: null, baseline: null, shadow: null });
    }
    expect(readActivationEvent('judge.conversationReview', events[3][1])?.latencyMs).toBe(3);
    expect(readActivationEvent('answer_selection_shadow', { applied: true, baseline: 'answer', ranker: 'error' })?.error).toBe(true);
    expect(readActivationEvent('judge.truth', { decision: 'send', truth: { measured: false, decision: 'send' } })?.changed).toBeNull();
  });
});

describe('activation log sources', () => {
  it('reads only in-window producer extensions, skips absent or malformed rows, and keeps stable IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'activation-log-'));
    try {
      const judge = join(directory, 'judge.jsonl');
      const row = { at: '2026-11-25T12:00:00.000Z', conversationId: 'conversation', runId: 'run', decision: 'send' };
      const observed = JSON.stringify({ ...row, truth: { decision: 'withhold' } });
      await writeFile(judge, [
        '{broken', JSON.stringify(row), observed, observed,
        JSON.stringify({ ...row, at: '2026-11-26T00:00:00.000Z', truth: { decision: 'withhold' } }), '',
      ].join('\n'));
      const options = { judge, conversation: join(directory, 'absent.jsonl') };
      const since = new Date('2026-11-25'), until = new Date('2026-11-26');
      const read = async () => {
        const entries = [];
        for await (const event of readActivationLogEvents(options, since, until)) entries.push(event);
        return entries;
      };
      const events = await read();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ id: /^log:[a-f0-9]{64}$/, name: 'judge.truth', conversationId: 'conversation', runId: 'run', replyId: null });
      await writeFile(judge, observed + '\n');
      expect(await read()).toEqual(events);

      const conversation = join(directory, 'conversation.jsonl');
      await writeFile(conversation, JSON.stringify({ ...row, mode: 'active', turnId: 'turn', decision: { type: 'follow_up' } }));
      const active = [];
      for await (const event of readActivationLogEvents({ conversation }, since, until)) active.push(event);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ name: 'conversation.agreement', runId: 'turn' });
      expect(readActivationEvent(active[0].name, active[0].data)?.changed).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('discovers deliberation only where the existing run ledger carries a versioned trace', () => {
    const trace = { version: 1, legacy: { action: 'ask' }, chosen: { action: 'act', route: 'search' }, disagrees: true };
    expect(readDeliberationLedger({ agentRun: { phase: 'completed' } })).toEqual([]);
    expect(readDeliberationLedger({ agentRun: { earlierDeliberation: [null, trace], deliberation: trace } }))
      .toEqual([{ index: 1, data: trace }, { index: -1, data: trace }]);
    expect(readActivationEvent('run.deliberation', trace)).toMatchObject({ changed: true, baseline: 'ask', shadow: 'act' });
  });
});

it('captures real Node console producers only in the attached database scope with safe projected decisions', async () => {
  const { db, close } = await createDatabase();
  const now = new Date('2026-11-25');
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const logger = new Console({ stdout: sink, stderr: sink });
  let stop: (() => Promise<void>) | undefined;
  const fixture = { event: 'clarification_shadow', legacyWouldAsk: true, decision: 'ask', kind: 'entity',
    conversationId: 'untrusted-conversation', ownerId: 'untrusted-account', baseline: 'password=example-fixture-value' };
  try {
    await migrate(db);
    await commandChatMigration(db);
    await migrateActivationConsole(db);
    attachActivationRuntime(db);
    stop = subscribeActivationConsoleLogs(db, () => now);
    logger.info(JSON.stringify(fixture));
    const control = bindActivationRuntime(db, { send: async (_ownerId: string) => {
      logger.info(JSON.stringify(fixture));
      logger.warn(JSON.stringify({ event: 'arabic_understanding_shadow_error', detail: 'ignored' }));
      logger.info(JSON.stringify({ event: 'browser_task_shadow', detail: 'already stored elsewhere' }));
      logger.info(JSON.stringify({ event: 'unknown_shadow' }));
    } });
    await control.send('trusted-owner');
    const background = bindActivationRuntime(db, { send: async () => logger.info(JSON.stringify(fixture)) });
    await background.send();
    await stop();
    await control.send('trusted-owner');
    const rows = await db.selectFrom('activation_observations').selectAll().orderBy('capability_id').orderBy('owner_id').execute();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ capability_id: 'arabic-understanding', changed: null, error: true, created_at: now,
      owner_id: 'trusted-owner', baseline: null, shadow: null });
    expect(rows[1]).toMatchObject({ capability_id: 'clarify-choices', changed: true, category: 'entity', error: false, created_at: now,
      owner_id: 'trusted-owner', baseline: 'ask_generic', shadow: 'ask_choices' });
    expect(rows[2]).toMatchObject({ capability_id: 'clarify-choices', changed: true, category: 'entity',
      owner_id: null, baseline: null, shadow: null });
    expect(JSON.stringify(rows)).not.toContain('untrusted-conversation');
    expect(JSON.stringify(rows)).not.toContain('untrusted-account');
    expect(JSON.stringify(rows)).not.toContain('example-fixture-value');
  } finally {
    await stop?.();
    await close();
  }
});
