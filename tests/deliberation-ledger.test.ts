import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { MAX_EARLIER_THOUGHT_RECORDS, type ThoughtRecord } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import { createRunLedger, projectRunView, restoreRunLedger } from '../apps/server/src/assistant/agent-run.js';
import { recordDeliberation } from '../apps/server/src/assistant/deliberation/run-ledger.js';
import { createCommandChatControl, registerCommandChatRoutes } from '../apps/server/src/command-chat.js';
import { RunDeliberation } from '../apps/web/components/run-deliberation.js';

const AT = Date.parse('2026-11-23T14:00:00.000Z');
const RUN_ID = '0b6b2f0e-6d0f-4f7b-9a41-3c9d5f2a1e11';
// A structural test fixture for the ledger and view only. It is never used for calibration or training.
const record: ThoughtRecord = {
  version: 1,
  candidates: [
    { route: 'compute', handler: 'local_computation', score: 4.2, evidence: ['cascade_match'] },
    { route: 'web_search', handler: 'routing_suggestion', score: 0.6, evidence: ['route_decision'] },
    { route: 'news', handler: 'router_suggestion', score: 0.4, evidence: ['router_top'] },
  ],
  chosen: { action: 'act', route: 'compute', handler: 'local_computation' },
  confidence: 0.82, reasons: ['lowest_expected_cost'], changeEvidence: ['missing_context'],
  readings: [{ route: 'compute', scope: 'unknown', spans: [{ turn: 'current', start: 0, end: 8 }] }],
  legacy: { action: 'act', route: 'web_search', handler: 'web_search' }, disagrees: true, enforced: false,
  review: { checkedParts: 1, answeredParts: 1, initialFindings: [], findings: [], revision: 'none' },
};

describe('run deliberation privacy and retention', () => {
  it('rejects untrusted extra fields, arbitrary codes and raw conversation text at the write boundary', () => {
    const ledger = createRunLedger({ runId: RUN_ID, at: AT });
    const forbiddenValue = 'fixture-private-value';
    const attempts = [
      { ...record, request: forbiddenValue },
      { ...record, reasons: [forbiddenValue] },
      { ...record, candidates: [{ ...record.candidates[0], handler: forbiddenValue }] },
      { ...record, candidates: [{ ...record.candidates[0], evidence: [forbiddenValue] }] },
      { ...record, chosen: { ...record.chosen, handler: forbiddenValue } },
      { ...record, readings: [{ ...record.readings[0], entity: forbiddenValue }] },
      { ...record, review: { ...record.review, answer: forbiddenValue } },
    ];
    for (const attempt of attempts) expect(recordDeliberation(ledger, attempt, AT)).toBe(false);
    expect(ledger).not.toHaveProperty('deliberation');
    expect(ledger.sequence).toBe(0);
    expect(JSON.stringify(ledger)).not.toContain(forbiddenValue);
    expect(recordDeliberation(ledger, record, AT + 1)).toBe(true);
    expect(ledger.deliberation).toEqual(record);
  });

  it('retains a bounded history for new turns and updates a review in the current turn', () => {
    const ledger = createRunLedger({ runId: RUN_ID, at: AT });
    for (let index = 0; index < MAX_EARLIER_THOUGHT_RECORDS + 2; index++) {
      expect(recordDeliberation(ledger, { ...record, confidence: index / 20 }, AT + index, { newTurn: true })).toBe(true);
    }
    expect(recordDeliberation(ledger, record, AT + 20)).toBe(true);
    const restored = restoreRunLedger(JSON.parse(JSON.stringify(ledger)), RUN_ID);
    expect(restored?.deliberation).toEqual(record);
    expect(restored?.earlierDeliberation).toHaveLength(MAX_EARLIER_THOUGHT_RECORDS);
    expect(restored?.earlierDeliberation?.[0]).toMatchObject({ confidence: 0.05 });
    expect(restored?.earlierDeliberation?.at(-1)).toMatchObject({ confidence: 0.4 });
  });

  it('drops a malformed stored record without losing a valid run ledger or sharing it in the run view', () => {
    const ledger = createRunLedger({ runId: RUN_ID, at: AT, path: 'action' });
    ledger.deliberation = { ...record, candidates: [{ ...record.candidates[0], handler: 'unknown-private-token' }] };
    const view = projectRunView({ runId: RUN_ID, status: 'completed', ledger, includeDeliberation: true,
      createdAt: new Date(AT), updatedAt: new Date(AT) });
    expect(view?.path).toBe('action');
    expect(view).not.toHaveProperty('deliberation');
  });

  it('projects a stored record only for owners and rechecks access for a keyed response replay', async () => {
    const database = await createDatabase({});
    const app = Fastify();
    let allowed = true;
    await migrate(database.db);
    const browser = { setCheckpointStore() {}, async close() {} } as unknown as AgentBrowser;
    const control = await createCommandChatControl(database.db, {
      browser, fullAccess: async id => id === 'fixture-owner' && allowed,
      models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    });
    try {
      await registerCommandChatRoutes(app, { control, owner: async request => ({ id: String(request.headers['fixture-user']) }) });
      const owner = 'fixture-owner';
      const member = 'fixture-member';
      const seed = async (principal: string, runId: string) => {
        const { id } = await control.create(principal);
        const ledger = createRunLedger({ runId, at: AT });
        expect(recordDeliberation(ledger, record, AT)).toBe(true);
        expect(recordDeliberation(ledger, record, AT + 1, { newTurn: true })).toBe(true);
        await database.db.insertInto('chat_runs').values({ id: runId, conversation_id: id, owner_id: principal, status: 'completed',
          goal: '', lease_token: randomUUID(), lease_expires_at: new Date(AT), state: JSON.stringify({ agentRun: ledger }) }).execute();
        return `/api/chat/conversations/${id}`;
      };
      const ownerUrl = await seed(owner, RUN_ID);
      const memberUrl = await seed(member, randomUUID());
      const ownerView = await app.inject({ url: ownerUrl, headers: { 'fixture-user': owner } });
      expect(ownerView.statusCode).toBe(200);
      expect(ownerView.json().run).toMatchObject({ deliberation: record, earlierDeliberation: [record] });
      const memberView = await app.inject({ url: memberUrl, headers: { 'fixture-user': member } });
      expect(memberView.statusCode).toBe(200);
      expect(memberView.json().run).not.toHaveProperty('deliberation');
      expect(memberView.json().run).not.toHaveProperty('earlierDeliberation');
      expect((await app.inject({ url: ownerUrl, headers: { 'fixture-user': member } })).statusCode).toBe(404);

      const cached = await control.once(owner, 'test', 'fixture-key', null, async () => ownerView.json());
      expect(cached.run).toHaveProperty('deliberation');
      allowed = false;
      const replay = await control.once(owner, 'test', 'fixture-key', null, async () => { throw new Error('unexpected re-execution'); });
      expect(replay).toMatchObject({ run: { id: RUN_ID } });
      expect(replay).not.toHaveProperty('run.deliberation');
      expect(replay).not.toHaveProperty('run.earlierDeliberation');
    } finally {
      await app.close();
      await control.shutdown();
      await database.close();
    }
  });

  it('renders the owner-supplied decision, disagreement and review and hides the section without a record', () => {
    const markup = renderToStaticMarkup(createElement(RunDeliberation, { record, earlier: [record] }));
    expect(markup).toContain('اتخاذ القرار');
    expect(markup).toContain('82');
    expect(markup).toContain('local_computation');
    expect(markup).toContain('مختلف عن القرار');
    expect(markup).toContain('وضع المراقبة');
    expect(markup).toContain('مراجعة الجواب');
    expect(markup).toContain('القرارات السابقة في المهمة');
    expect(renderToStaticMarkup(createElement(RunDeliberation, {}))).toBe('');
  });
});
