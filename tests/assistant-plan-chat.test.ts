// Agent-written development cases for the chat integration. Never use as training data.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainState } from '../apps/server/src/assistant/brain.js';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl, type CommandChatConfig } from '../apps/server/src/command-chat.js';
import { createDocumentControl, migrateDocuments } from '../apps/server/src/documents.js';
import { createSitesControl } from '../apps/server/src/sites.js';

const owner = 'isolated-plan-owner';
const capitalUrl = 'https://geography.example.test/france';
const priceUrl = 'https://prices.example.test/gold';
const pageUrl = 'https://docs.example.test/guide';
const capital = 'باريس هي عاصمة فرنسا. تقع المدينة على ضفاف نهر السين في شمال البلاد. Paris is the capital of France.';
const price = 'The price of gold is $100.00 per gram in USD.';
const page = 'The station courtyard opens at seven. The entrance is on the north side of the building.';

describe('compiled plans through command chat', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let documents: ReturnType<typeof createDocumentControl>;
  let sites: Awaited<ReturnType<typeof createSitesControl>>;
  let directory: string;

  const search = vi.fn<SearchProvider['search']>();
  const readPage = vi.fn<NonNullable<CommandChatConfig['readPage']>>();
  const legacySave = vi.fn(async () => { throw new Error('Memory writes require an exact operation.'); });
  const browserCall = vi.fn(async () => { throw new Error('Plan tools read through the configured public HTTP port.'); });

  beforeAll(async () => {
    database = await createDatabase({});
    await migrateAuth(database.db);
    await migrate(database.db);
    await memoryMigration(database.db);
    await migrateDocuments(database.db);
    await database.db.insertInto('user').values({ id: owner, name: 'Plan test owner', email: 'plan-owner@example.test' }).execute();
    directory = await mkdtemp(join(tmpdir(), 'mohassan-plan-chat-'));
    documents = createDocumentControl(database.db, { dir: directory, fontsDir: resolve('packages/pdf/fonts'), allowedRoots: async () => [] });
    sites = await createSitesControl(database.db, { tokenSecret: 'synthetic-plan-site-preview-test-0000' });
    const memory = createMemoryControl(database.db);
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      act: browserCall, observe: browserCall, screen: browserCall } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
      networkPolicy: { testOrigins: [capitalUrl, priceUrl, pageUrl].map(url => new URL(url).origin) },
      searchProvider: { name: 'isolated-plan-search', search }, readPage,
      documents: { control: documents, link: id => `http://web.test/api/documents/${id}/content` },
      sites: { createFromBrief: (ownerId, brief, options) => sites.create(ownerId, { brief, conversationId: options.conversationId }),
        command: sites.command, detail: sites.detail, link: id => `http://web.test/#sites=${id}` },
      tools: { memory: { save: legacySave, writeExact: memory.writeExact, reconcileExact: memory.reconcileExact,
        async search(ownerId, query) {
          const result = await memory.search(ownerId, { query, limit: 4 }, { readOnly: true });
          const evidence = result.items.map(item => item.content);
          return { text: evidence.join('\n') || 'no matching memory', evidence };
        },
      } },
    });
  });

  beforeEach(() => {
    vi.stubEnv('MOHASSAN_PLAN_COMPILER', 'on');
    search.mockReset().mockImplementation(async query => /gold/i.test(query)
      ? [{ title: 'Gold quote in USD', url: priceUrl, snippet: price }]
      : [{ title: 'Capital of France', url: capitalUrl, snippet: capital }]);
    readPage.mockReset().mockImplementation(async url => {
      const text = new Map([[capitalUrl, capital], [priceUrl, price], [pageUrl, page]]).get(url);
      return text ? { url, title: 'Verified fixture page', text, status: 200 } : null;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await control?.shutdown();
    await documents?.shutdown();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function ask(goal: string) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const run = await database.db.selectFrom('chat_runs').select(['state', 'status', 'steps']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(detail.error).toBeNull();
    return { run, ledger: (run.state as BrainState).agentRun!, text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
  }

  it('keeps the legacy path by default and for a single clause', async () => {
    vi.stubEnv('MOHASSAN_PLAN_COMPILER', undefined);
    const off = await ask('احسب ١٧ × ٢٣ ثم ابحث عن عاصمة فرنسا');
    expect(off.ledger.plan).toBeNull();
    expect(search).not.toHaveBeenCalled();
    vi.stubEnv('MOHASSAN_PLAN_COMPILER', 'on');
    const single = await ask('Calculate 17 * 23.');
    expect(single.ledger.plan).toBeNull();
    expect(single.text).toContain('391');
  });

  it('logs each accepted message in shadow mode without tool effects or raw request text', async () => {
    vi.stubEnv('MOHASSAN_PLAN_COMPILER', 'shadow');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const single = await ask('Calculate 81 / 9.');
    const multi = await ask('احسب ١٧ × ٢٣ ثم ابحث عن عاصمة فرنسا');
    expect(single.ledger.plan).toBeNull();
    expect(multi.ledger.plan).toBeNull();
    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line))).filter(line => line.event === 'plan_compiler_shadow');
    expect(lines.map(line => line.steps.map((step: { tool: string }) => step.tool))).toEqual([['compute'], ['compute', 'search']]);
    expect(JSON.stringify(lines)).not.toMatch(/فرنسا|81 \/ 9/u);
    expect(search).not.toHaveBeenCalled();
  });

  it('answers calculate then search with one verified ledger result per clause', async () => {
    const result = await ask('احسب ١٧ × ٢٣ ثم ابحث عن عاصمة فرنسا');
    expect(result.run.status, result.text).toBe('completed');
    expect(result.text).toContain('391');
    expect(result.text).toContain('باريس');
    const steps = result.ledger.plan?.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps.map(step => step.state)).toEqual(['verified', 'verified']);
    expect(result.ledger.path).toBe('action');
    for (const step of steps) expect(result.ledger.evidence.some(evidence => evidence.stepId === step.id)).toBe(true);
    expect(result.ledger.modelCalls).toBe(0);
    expect(browserCall).not.toHaveBeenCalled();
  });

  it('passes a sourced numeric price to the local calculation', async () => {
    const result = await ask('Search for the price of gold per gram in USD and calculate how many grams I can buy for $1000.');
    expect(result.run.status, result.text).toBe('completed');
    expect(result.text).toContain(priceUrl);
    expect(result.text).toMatch(/\b10 g\b/);
    const [lookup, computation] = result.ledger.plan?.steps ?? [];
    expect(computation?.dependsOn).toEqual([lookup?.id]);
  });

  it('preserves both calculations and binds the result reference', async () => {
    const result = await ask('Calculate 3 + 7, then calculate the result * 4.');
    expect(result.run.status, result.text).toBe('completed');
    expect(result.text).toMatch(/=\s*10\b/);
    expect(result.text).toMatch(/=\s*40\b/);
    expect(result.run.steps).toBe(2);
  });

  it('keeps the labeled letter fields and literal body in one step', async () => {
    const result = await ask('Calculate 3 + 2, then draft a thank-you letter; To: Morgan; From: Jamie; saying "Thank you for checking the route."');
    expect(result.run.status, result.text).toBe('completed');
    expect(result.text).toContain('3 + 2 = 5');
    expect(result.text).toContain('Dear Morgan,');
    expect(result.text).toContain('Thank you for checking the route.');
    expect(result.text).toContain('Best regards,\nJamie');
  });

  it('builds a site from user-supplied fields and preserves its conversation handle', async () => {
    const result = await ask('Calculate 3 + 2, then build a blue website for my plumbing business called Swift Plumbing in Manchester, phone 07700 900123; Services: Boiler servicing - £85');
    expect(result.run.status, result.text).toBe('completed');
    expect(result.text).toContain('3 + 2 = 5');
    const id = (result.run.state as BrainState).siteId;
    expect(id).toBeTruthy();
    expect(result.text).toContain(`#sites=${id}`);
    const site = await sites.detail(owner, id!);
    expect(site.name).toBe('Swift Plumbing');
    expect(site.checks.passed).toBe(true);
    expect(site.brief.items).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Boiler servicing' })]));
  });

  it('commits an exact owner-scoped note before recalling it', async () => {
    const result = await ask('Remember that I prefer trains. Then recall it.');
    expect(result.run.status, result.text).toBe('completed');
    expect(result.text).toMatch(/prefer trains/i);
    expect(legacySave).not.toHaveBeenCalled();
    const operations = await database.db.selectFrom('memory_exact_operations').selectAll().where('owner_id', '=', owner).execute();
    expect(operations).toHaveLength(1);
    const [save, recall] = result.ledger.plan?.steps ?? [];
    expect(recall?.dependsOn).toEqual([save?.id]);
  });

  it('preserves the native receipt for an exact combined calculate-and-save request', async () => {
    const result = await ask('Calculate 2 + 3, then remember the result in my memory.');
    expect(result.run.status, result.text).toBe('completed');
    expect((result.run.state as BrainState).computationMemory?.phase).toBe('verified');
    expect(legacySave).not.toHaveBeenCalled();
  });

  it('creates and verifies a stored PDF from the public page text', async () => {
    const result = await ask(`Read ${pageUrl}, then make a PDF from it.`);
    expect(result.run.status, result.text).toBe('completed');
    expect(readPage.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
    const documentId = /\/api\/documents\/([\da-f-]{36})\/content/i.exec(result.text)?.[1];
    expect(documentId).toBeTruthy();
    const stored = await documents.content(owner, documentId!);
    expect(Buffer.from(stored.bytes).subarray(0, 5).toString()).toBe('%PDF-');
    expect(stored.document.pages).toBe(1);
  });

  it('publishes an honest partial reply after bounded web failures', async () => {
    search.mockRejectedValue(new Error('synthetic adapter outage'));
    const result = await ask('Calculate 9 * 8, then search for the capital of France.');
    expect(result.run.status, result.text).toBe('partial');
    expect(result.text).toContain('72');
    expect(result.text).not.toContain('synthetic adapter outage');
    const steps = result.ledger.plan?.steps ?? [];
    expect(steps.map(step => step.state)).toEqual(['verified', 'failed']);
    expect(search.mock.calls.length).toBeGreaterThan(1);
    expect(search.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('respects the whole request’s prohibition even when a clause asks to search', async () => {
    const result = await ask('Do not search the web. Calculate 6 * 8, then search for the capital of France.');
    expect(['partial', 'blocked']).toContain(result.run.status);
    expect(search).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
  });

  it('declines a graph too large for the ledger before dispatch', async () => {
    const goal = Array.from({ length: 17 }, (_, i) => `${i + 1}. Calculate ${i + 2} * 9`).join('\n');
    const result = await ask(goal);
    expect(result.run.status, result.text).toBe('blocked');
    expect(result.text).toContain('16 steps');
    expect(result.run.steps).toBe(0);
  });

  it('runs a bounded graph beyond the old compound handler limit', async () => {
    const goal = Array.from({ length: 9 }, (_, i) => `${i + 1}. Calculate ${i + 2} * 9`).join('\n');
    const result = await ask(goal);
    expect(result.run.status, result.text).toBe('completed');
    expect(result.ledger.plan?.steps).toHaveLength(9);
    expect(result.run.steps).toBe(9);
  });
});
