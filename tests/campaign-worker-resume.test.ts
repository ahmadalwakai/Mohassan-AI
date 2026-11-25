import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { GoogleAdsDraft } from '@mohassan/contracts';
import { createCommandChatControl, registerCommandChatRoutes } from '../apps/server/src/command-chat.js';
import { newBrainState } from '../apps/server/src/assistant/brain.js';
import { newCampaignRunState, type CampaignPorts } from '../apps/server/src/assistant/campaign-run.js';
import { parseAdsDraft } from '../apps/server/src/assistant/tools.js';

const OWNER = 'campaign-resume-owner', CUSTOMER = '1234567890';
const GOAL = 'Create a paused campaign in my Google Ads account';
const forbidden = vi.fn(async (): Promise<never> => { throw new Error('Recovery must never mutate, navigate or call a model'); });
const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async dropHeld() {}, async close() {}, async closeConversation() {}, act: forbidden, observe: forbidden, screen: forbidden, prepareAction: forbidden } as unknown as AgentBrowser;

describe('persisted chat campaign recovery after worker restart', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>, control: Awaited<ReturnType<typeof createCommandChatControl>>, app: ReturnType<typeof Fastify>;
  let id: string, originalRun: string;
  const read = vi.fn(async () => ({ ...draft, state: 'published' as const, readback: { checkedAt: new Date().toISOString(), customerId: CUSTOMER, campaignResourceName: draft.campaignResourceName,
    passed: true, fields: [{ field: 'campaign.status', expected: 'PAUSED', actual: 'PAUSED', passed: true }], resourceNames: [draft.campaignResourceName!], requestId: 'fixture-read' } }));
  const account = { customerId: CUSTOMER, currency: 'GBP', timeZone: 'Europe/London', range: { start: '2026-10-24', end: '2026-11-22' }, checkedAt: new Date().toISOString() };
  const draft: GoogleAdsDraft = { id: randomUUID(), customerId: CUSTOMER, state: 'outcome_unknown', revision: 1, brief: parseAdsDraft('BUSINESS: MA Removals\nSERVICE: House removals\nGOAL: calls\nURL: https://example.com/house\nLOCATION: Glasgow\nCOUNTRY: GB\nLANGUAGE: en\nBUDGET: 20\nH: House Removals\nH: Glasgow Movers\nH: Book Your Move\nD: Careful house removals in Glasgow.\nD: Book your local move online.\nP: removals\nK: "house removals"', GOAL), draftHash: 'a'.repeat(64), bidding: 'MANUAL_CPC', summary: null, strategy: null, validation: null, verification: null, campaignResourceName: `customers/${CUSTOMER}/campaigns/10`, error: null, createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() - 120000).toISOString() };
  const ports: CampaignPorts = { account: async () => ({ ...account, checkedAt: new Date().toISOString() }), parse: parseAdsDraft, landing: forbidden, gates: forbidden, drafts: async () => [draft], createPaused: forbidden, reconcile: read, discard: forbidden, lessons: { list: async () => [], record: async () => undefined } };
  const config = { browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false as const, tools: { ads: { status: forbidden, report: forbidden, draft: forbidden, campaign: ports } } };
  beforeAll(async () => {
    database = await createDatabase({}); await migrate(database.db);
    const previousWorker = await createCommandChatControl(database.db, config);
    const created = await previousWorker.create(OWNER, { goal: 'Hello' });
    id = created.id; await previousWorker.settled(id); originalRun = (await previousWorker.detail(OWNER, id)).run!.id;
    await previousWorker.shutdown();
    // Simulate committed state on disk and an expired worker, without killing any real process.
    const state = { ...newBrainState(), campaign: { ...newCampaignRunState(), writeSent: true, draftId: draft.id, account } };
    await database.db.updateTable('chat_runs').set({ status: 'running', goal: GOAL, state: JSON.stringify(state), worker_id: 'expired-worker', lease_expires_at: sql`CURRENT_TIMESTAMP - interval '1 minute'` }).where('id', '=', originalRun).execute();
    await database.db.updateTable('chat_conversations').set({ status: 'running', active_run_id: originalRun }).where('id', '=', id).execute();
    control = await createCommandChatControl(database.db, config);
    app = Fastify(); await registerCommandChatRoutes(app, { control, owner: async request => ({ id: request.headers['x-owner'] ?? OWNER }) });
  }, 120000);
  afterAll(async () => { await app?.close(); await control?.shutdown(); await database?.close(); });
  it('recovers the expired lease and offers only persisted readback recovery', async () => {
    const detail = await control.detail(OWNER, id);
    expect(detail.status).toBe('failed');
    expect(detail.campaignRecovery).toEqual({ runId: originalRun, mode: 'readback_only' });
    expect(read).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
  });
  it('rejects cross-owner and foreign-run recovery without reading the account', async () => {
    await expect(control.resumeCampaign('other-owner', id, { runId: originalRun })).rejects.toThrow();
    await expect(control.resumeCampaign(OWNER, id, { runId: randomUUID() })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('resumes through HTTP, commits matching evidence and deduplicates a lost response', async () => {
    const request = { method: 'POST' as const, url: `/api/chat/conversations/${id}/campaign/resume`, headers: { 'idempotency-key': 'stable-recovery-request' }, payload: { runId: originalRun } };
    const first = await app.inject(request); expect(first.statusCode, first.body).toBe(200);
    await control.settled(id);
    const detail = await control.detail(OWNER, id);
    expect(detail.run?.verdict?.status, JSON.stringify(detail)).toBe('completed');
    expect(detail.run?.evidence.some(item => item.kind === 'readback' && item.reference === draft.campaignResourceName)).toBe(true);
    const replay = await app.inject(request); expect(replay.statusCode).toBe(200);
    expect(read).toHaveBeenCalledTimes(1); expect(forbidden).not.toHaveBeenCalled();
    expect(detail.campaignRecovery).toBeUndefined();
  });
  it('rejects replaying a stale recovery as a fresh task', async () => {
    const priorReads = read.mock.calls.length;
    const response = await app.inject({ method: 'POST', url: `/api/chat/conversations/${id}/campaign/resume`, payload: { runId: originalRun } });
    expect(response.statusCode).toBe(409); expect(read).toHaveBeenCalledTimes(priorReads); expect(forbidden).not.toHaveBeenCalled();
  });
});
