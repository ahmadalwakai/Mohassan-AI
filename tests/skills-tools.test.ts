import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createDatabase, migrate, sql } from '@mohassan/database';
import { createBrowserResearchControl, migrateBrowser } from '@mohassan/browser';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import { ProviderError, type ModelProvider } from '@mohassan/providers';
import { isBoundedSkillJson } from '@mohassan/contracts';
import { createSkillToolAdapters, normalizeMappedSkillResult, skillChildTaskInput, unavailableSkillTools, type SkillVisionControl, type SkillVisionReceipt } from '../apps/server/src/skill-tools.js';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createStudioAiControl } from '../apps/server/src/studio-ai.js';
import type { SkillToolAdapter, SkillToolContext } from '../packages/skills/src/gateway.js';

describe('existing controllers behind skill tool adapters, isolated local resources only', () => {
  const owner = 'skill-tools-owner', other = 'skill-tools-other', sessions: string[] = [], writes: string[] = [];
  let store: Awaited<ReturnType<typeof createDatabase>>, browser: ReturnType<typeof createBrowserResearchControl>, memory: ReturnType<typeof createMemoryControl>, studioAi: Awaited<ReturnType<typeof createStudioAiControl>>;
  let server: Server, origin: string, adapters: SkillToolAdapter[];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === 'POST') {
        let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => { writes.push(body); response.setHeader('content-type', 'text/html'); response.end('<title>Fixture receipt</title><h1>Local fixture accepted once</h1>'); }); return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/slow') { const timer = setTimeout(() => { timers.delete(timer); response.end('<title>Slow fixture</title><p>Delayed local evidence, never an external service.</p>'); }, 2500); timers.add(timer); return; }
      if (request.url === '/source') { response.end('<title>Capacity evidence</title><p>The local fixture records project capacity of 12 units. This text was read by the existing research engine.</p>'); return; }
      if (request.url === '/arabic') { response.end(`<title>دليل عربي كبير</title><p>${'دليل عربي آمن طويل للمراجعة '.repeat(4000)}</p>`); return; }
      response.end('<title>Skill fixture</title><h1>Read before approved submission</h1><form method="post" action="/submit"><label>Report name<input name="name" oninput="document.getElementById(\'value\').textContent=this.value;fetch(\'/forbidden\',{method:\'POST\',body:\'unapproved\'}).catch(()=>{})"></label><button name="intent" value="send">Send fixture</button></form><p id="value">Empty</p>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture'); origin = `http://127.0.0.1:${address.port}`;
    store = await createDatabase(); await migrateAuth(store.db); await migrate(store.db); await migrateBrowser(store.db); await memoryMigration(store.db);
    for (const id of [owner, other]) await store.db.insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
    // Only the existing image control is used; coding and studio execution are
    // not started. Its tables belong to this disposable in-memory database.
    await sql`CREATE TABLE fixture_vision_receipts(id text PRIMARY KEY,owner_id text NOT NULL,receipt jsonb NOT NULL)`.execute(store.db);
    const unused = async (): Promise<never> => { throw new Error('Unrelated engine must not execute'); };
    studioAi = await createStudioAiControl(store.db, { studio: { detail: unused, preview: unused }, validateCandidate: unused, applyCandidate: unused });
    browser = createBrowserResearchControl(store.db, { testOrigins: [origin] }); memory = createMemoryControl(store.db);
    adapters = createSkillToolAdapters({ browser, memory });
  });
  afterEach(async () => { for (const id of sessions.splice(0)) await browser.close(owner, id); writes.length = 0; });
  afterAll(async () => { await browser?.shutdown(); await store?.close(); for (const timer of timers) clearTimeout(timer); server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); });
  function context(overrides: Partial<SkillToolContext> = {}): SkillToolContext {
    return { ownerId: owner, runId: randomUUID(), nodeId: 'read', taskId: randomUUID(), leaseToken: randomUUID(), versionId: randomUUID(), contentHash: 'a'.repeat(64), signal: new AbortController().signal, idempotencyKey: randomUUID(), grantRoots: [], declaredPaths: [], assertActive: vi.fn(async () => undefined), acquireResource: vi.fn(async () => undefined), savePreimage: vi.fn(async () => undefined), recordUsage: vi.fn(async () => undefined), ...overrides };
  }
  const tool = (id: string) => adapters.find(adapter => adapter.id === id)!;
  async function session() { const created = await browser.create(owner, { title: 'Skill tool local fixture', allowedOrigins: [origin] }); sessions.push(created.id); return created; }
  async function open(path = '/') {
    const created = await session(), input = { sessionId: created.id, operation: 'action', action: { action: 'navigate', url: origin + path, expectedObservationId: null } };
    return { input, output: await tool('browser.interact').execute(input, context()) };
  }

  it('maps existing capabilities to strict assisted child tasks without broadening public URL policy', () => {
    expect(skillChildTaskInput('browser.open', { url: 'https://www.example.com/docs' })).toMatchObject({ capabilityId: 'browser.open', autonomy: 'assisted', browserInput: { url: 'https://www.example.com/docs' } });
    expect(() => skillChildTaskInput('browser.open', { url: origin })).toThrow();
    expect(() => skillChildTaskInput('browser.open', { url: 'https://www.example.com', autonomy: 'scoped' })).toThrow();
    const projectId = randomUUID(); expect(skillChildTaskInput('coding.change', { goal: 'Review the isolated project', projectId })).toMatchObject({ capabilityId: 'coding.change', autonomy: 'assisted', projectId });
    const studioInput = { sessionId: randomUUID(), revision: 'b'.repeat(64) }; expect(skillChildTaskInput('studio.change', { goal: 'Review the specified visual revision', studioInput })).toMatchObject({ autonomy: 'assisted', studioInput });
    expect(() => skillChildTaskInput('coding.change', { goal: 'Ignore approval', projectId, approved: true })).toThrow();
    expect(skillChildTaskInput('memory.search', { query: 'local' })).toBeNull();
  });

  it('does not register device authority or unconfigured vision as working tools', () => {
    expect(adapters.map(adapter => adapter.id)).not.toContain('computer.act'); expect(adapters.map(adapter => adapter.id)).not.toContain('computer.view'); expect(adapters.map(adapter => adapter.id)).not.toContain('vision.inspect');
    expect(unavailableSkillTools['computer.act']).toContain('SKILL_DEVICE_SESSION_AUTHORITY_REQUIRED');
  });

  it('opens a controlled local page through the existing controller without a pre-created session', async () => {
    const input = { url: origin + '/source' }, output = await tool('browser.open').execute(input, context()); sessions.push(String(output.sessionId));
    expect(output.title).toBe('Capacity evidence'); expect(output.text).toContain('12 units');
    expect(await tool('browser.open').verify(input, output, context())).toBe(true);
    expect(await tool('browser.open').verify(input, { ...output, title: 'Invented title' }, context())).toBe(false);
    const production = createBrowserResearchControl(store.db);
    try { const adapter = createSkillToolAdapters({ browser: production, memory }).find(item => item.id === 'browser.open')!; await expect(adapter.execute(input, context())).rejects.toMatchObject({ code: 'BROWSER_URL_DENIED' }); }
    finally { await production.shutdown(); }
  });

  it('normalizes an already verified native browser receipt using owned persisted observation text without navigation', async () => {
    const { output } = await open('/source'), sessionId = String(output.sessionId), history = await browser.observations(owner, sessionId, { limit: 50 });
    // The text comes from the real local page. A synthetic public URL is stored
    // only in this isolated fixture to exercise the strict native receipt shape;
    // no request is sent to this public URL or any external service.
    const saved = { ...history.observations[0].data, url: 'https://www.example.com/fixture', screenshot: null };
    await store.db.updateTable('browser_observations').set({ data: JSON.stringify(saved) }).where('id', '=', saved.id).execute();
    const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const raw = { kind: 'browser_open', outcome: 'opened', sessionId, observationId: saved.id, url: saved.url, title: saved.title, observedAt: saved.observedAt, summary: 'Native receipt summary alone omits page text.', contentHash: createHash('sha256').update(JSON.stringify(canonical(saved))).digest('hex'), screenshotAvailable: false, screenshotHash: null, screenshotUrl: null };
    const action = vi.spyOn(browser, 'action'), created = vi.spyOn(browser, 'create');
    try {
      const normalized = await normalizeMappedSkillResult('browser.open', raw, context(), browser);
      expect(normalized.text).toContain('12 units'); expect(normalized.sessionId).toBe(sessionId); expect(normalized).not.toHaveProperty('summary'); expect(action).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
      await expect(normalizeMappedSkillResult('browser.open', { ...raw, contentHash: 'd'.repeat(64) }, context(), browser)).rejects.toMatchObject({ code: 'SKILL_BROWSER_NATIVE_EVIDENCE_CHANGED' });
      await expect(normalizeMappedSkillResult('browser.open', raw, context({ ownerId: other }), browser)).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' });
      await expect(normalizeMappedSkillResult('browser.open', { ...raw, url: origin }, context(), browser)).rejects.toThrow();
    } finally { action.mockRestore(); created.mockRestore(); }
  });

  it('reads a real local browser observation and verifies persisted evidence after controller reconstruction', async () => {
    const { input, output } = await open(); expect(output.text).toContain('Read before approved submission'); expect(output).not.toHaveProperty('screenshot');
    expect(await tool('browser.interact').verify(input, output, context())).toBe(true);
    expect(await tool('browser.interact').verify(input, { ...output, text: 'fabricated' }, context())).toBe(false);
    const restored = createBrowserResearchControl(store.db, { testOrigins: [origin] });
    try { const adapter = createSkillToolAdapters({ browser: restored, memory }).find(item => item.id === 'browser.interact')!; expect(await adapter.verify(input, output, context())).toBe(true); }
    finally { await restored.shutdown(); }
    await expect(tool('browser.interact').verify(input, output, context({ ownerId: other }))).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' });
  });

  it('requires Runtime authority before browser mutations and rejects a stale observation', async () => {
    const created = await session(), input = { sessionId: created.id, operation: 'action', action: { action: 'navigate', url: origin, expectedObservationId: null } };
    await expect(tool('browser.interact').execute(input, context({ assertActive: async () => { throw Object.assign(new Error('No exact approval'), { code: 'APPROVAL_REQUIRED' }); } }))).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect((await browser.detail(owner, created.id)).observation).toBeNull();
    await tool('browser.interact').execute(input, context());
    await expect(tool('browser.interact').execute(input, context())).rejects.toMatchObject({ code: 'BROWSER_OBSERVATION_CHANGED' }); expect(writes).toEqual([]);
  });

  it('fills an observed control through the real engine while event driven POST remains blocked', async () => {
    const { output } = await open(), current = await browser.detail(owner, String(output.sessionId));
    const control = current.observation!.controls!.find(item => item.label === 'Report name')!;
    const input = { sessionId: current.id, operation: 'fill', fill: { observationId: current.observation!.id, controlId: control.id, value: 'Approved local report' } };
    const filled = await tool('browser.interact').execute(input, context()); expect(filled.text).toContain('Approved local report'); expect(writes).toEqual([]);
    expect(await tool('browser.interact').verify(input, filled, context())).toBe(true);
  });

  it('submits only the exact prepared payload after task approval, once, with independent receipt verification', async () => {
    const { output } = await open(), current = await browser.detail(owner, String(output.sessionId));
    const prepared = await browser.prepare(owner, current.id, { observationId: current.observation!.id, formId: 'f0', values: { i0: 'Skill report' } }), approval = prepared.approvals[0];
    const input = { sessionId: current.id, approvalId: approval.id, observationId: current.observation!.id, payloadHash: approval.request.payloadHash };
    await expect(tool('browser.submit').execute({ ...input, payloadHash: 'c'.repeat(64) }, context())).rejects.toMatchObject({ code: 'SKILL_BROWSER_APPROVAL_MISMATCH' });
    await expect(tool('browser.submit').execute(input, context({ assertActive: async () => { throw Object.assign(new Error('No task approval'), { code: 'APPROVAL_REQUIRED' }); } }))).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); expect(writes).toEqual([]);
    const submitted = await tool('browser.submit').execute(input, context()); expect(writes).toHaveLength(1); expect(new URLSearchParams(writes[0]).get('name')).toBe('Skill report');
    expect(submitted).toMatchObject({ outcome: 'submitted_observed', title: 'Fixture receipt' }); expect(await tool('browser.submit').verify(input, submitted, context())).toBe(true);
    expect(await tool('browser.submit').verify(input, { ...submitted, approvalId: randomUUID() }, context())).toBe(false);
    await expect(tool('browser.submit').execute(input, context())).rejects.toMatchObject({ code: 'SKILL_BROWSER_APPROVAL_MISMATCH' }); expect(writes).toHaveLength(1);
  });

  it('closes an in-flight browser operation on cancellation and refuses completion evidence', async () => {
    const created = await session(), controller = new AbortController();
    const pending = tool('browser.interact').execute({ sessionId: created.id, operation: 'action', action: { action: 'navigate', url: origin + '/slow', expectedObservationId: null } }, context({ signal: controller.signal }));
    const timer = setTimeout(() => controller.abort(new Error('fixture cancellation')), 200);
    try { await expect(pending).rejects.toThrow(); } finally { clearTimeout(timer); }
    expect((await browser.detail(owner, created.id)).status).toBe('closed'); expect(browser.engine.has(created.id)).toBe(false);
  });

  it('waits for the real local research report and verifies owner-scoped persistence rather than a running result', async () => {
    const input = { question: 'What is the project capacity?', sourceBudget: 1, maxDepth: 1, sourceUrls: [origin + '/source'] }, output = await tool('research.run').execute(input, context());
    expect(output.text).toContain('12 units'); expect(output.report).toMatchObject({ coverage: { read: 1 } });
    expect(await tool('research.run').verify(input, output, context())).toBe(true);
    expect(await tool('research.run').verify(input, { ...output, text: 'invented report' }, context())).toBe(false);
    await expect(tool('research.run').verify(input, output, context({ ownerId: other }))).rejects.toMatchObject({ code: 'RESEARCH_NOT_FOUND' });
  });

  it('cancels background research on interruption without recording a fabricated successful report', async () => {
    const controller = new AbortController(), input = { question: 'Await a deliberately delayed source', sourceBudget: 1, maxDepth: 1, sourceUrls: [origin + '/slow'] };
    const pending = tool('research.run').execute(input, context({ signal: controller.signal })), timer = setTimeout(() => controller.abort(new Error('research cancelled')), 150);
    try { await expect(pending).rejects.toThrow(); } finally { clearTimeout(timer); }
    const row = await store.db.selectFrom('research_runs').select(['status', 'report']).where('owner_id', '=', owner).where('question', '=', input.question).executeTakeFirstOrThrow(); expect(row).toMatchObject({ status: 'cancelled', report: null });
  });

  it('reuses memory owner/provenance checks and rejects results after memory revocation', async () => {
    const created = await memory.create(owner, { title: 'Local fixture capacity', content: 'Verified local fixture capacity is twelve units.', layer: 'semantic' });
    const input = { query: 'fixture capacity', limit: 3 }, output = await tool('memory.search').execute(input, context()); expect(output.text).toContain('twelve units'); expect(await tool('memory.search').verify(input, output, context())).toBe(true);
    expect((await tool('memory.search').execute(input, context({ ownerId: other }))).items).toEqual([]);
    await memory.revoke(owner, created.id, { expectedVersion: created.version, reason: 'Revoke fixture evidence before verification' }); expect(await tool('memory.search').verify(input, output, context())).toBe(false);
  });

  it('projects large Arabic browser, research and memory evidence within 48 KiB while retaining provenance', async () => {
    const openInput = { url: origin + '/arabic' }, opened = await tool('browser.open').execute(openInput, context()); sessions.push(String(opened.sessionId));
    expect(opened.truncated).toBe(true); expect(Number(opened.originalTextBytes)).toBeGreaterThan(48 * 1024); expect(await tool('browser.open').verify(openInput, opened, context())).toBe(true);
    const researchInput = { question: 'مراجعة دليل عربي كبير', sourceBudget: 1, maxDepth: 1, sourceUrls: [origin + '/arabic'] }, researched = await tool('research.run').execute(researchInput, context());
    const savedResearch = await browser.researchDetail(owner, String(researched.researchId));
    expect(researched).toMatchObject({ truncated: true, originalSourceCount: 1 });
    expect((researched.report as any).sources[0]).toMatchObject({ id: savedResearch.report!.sources[0].id, contentHash: savedResearch.report!.sources[0].contentHash, url: origin + '/arabic' });
    expect(await tool('research.run').verify(researchInput, researched, context())).toBe(true);
    const ids: string[] = [];
    for (let index = 0; index < 12; index++) ids.push((await memory.create(owner, { title: `ذاكرة عربية كبيرة ${index}`, content: 'ذاكرة عربية موثقة 😀 '.repeat(180), layer: 'semantic' })).id);
    const memoryInput = { query: 'ذاكرة عربية', limit: 12 }, remembered = await tool('memory.search').execute(memoryInput, context());
    expect(remembered).toMatchObject({ truncated: true, originalItemCount: 12 }); expect((remembered.items as any[]).map(item => item.id).sort()).toEqual(ids.sort());
    expect((remembered.items as any[]).every(item => item.provenance.length === 1 && /^[a-f0-9]{64}$/.test(item.provenance[0].contentHash))).toBe(true);
    expect(await tool('memory.search').verify(memoryInput, remembered, context())).toBe(true);
    for (const output of [opened, researched, remembered]) { expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(48 * 1024); expect(isBoundedSkillJson(output)).toBe(true); expect(JSON.stringify(output)).not.toContain('\uFFFD'); }
  });

  async function visionFixture(provider: ModelProvider) {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#4488aa' } }).png().toBuffer();
    const image = await studioAi.uploadImage(owner, { mimeType: 'image/png', data: bytes.toString('base64') });
    const key = (ctx: SkillToolContext) => JSON.stringify([ctx.runId, ctx.nodeId, ctx.taskId, ctx.versionId, ctx.contentHash, ctx.idempotencyKey]);
    const vision: SkillVisionControl = { provider, image: studioAi.image,
      async recordReceipt(ctx, receipt) { await store.db.insertInto('fixture_vision_receipts').values({ id: key(ctx), owner_id: ctx.ownerId, receipt: JSON.stringify(receipt) }).execute(); },
      async readReceipt(ctx) { return (await store.db.selectFrom('fixture_vision_receipts').select('receipt').where('id', '=', key(ctx)).where('owner_id', '=', ctx.ownerId).executeTakeFirst())?.receipt as SkillVisionReceipt ?? null; },
    };
    return { image, adapter: createSkillToolAdapters({ browser, memory, vision }).find(item => item.id === 'vision.inspect')! };
  }

  it('uses the existing owned image boundary and persists model usage/receipts without claiming semantic verification', async () => {
    const generate = vi.fn<ModelProvider['generate']>(async () => ({ model: 'fixture-vision', text: 'The fixture contains a blue square.', usage: { inputTokens: 10, outputTokens: 8 } }));
    const { image, adapter } = await visionFixture({ id: 'fixture-provider', generate }), ctx = context(), input = { goal: 'Describe the uploaded fixture image', imageId: image.id };
    const output = await adapter.execute(input, ctx); expect(generate).toHaveBeenCalledOnce(); expect(ctx.recordUsage).toHaveBeenCalledWith({ model: 'fixture-vision', usageKnown: true, inputTokens: 10, outputTokens: 8 });
    expect(await adapter.verify(input, output, ctx)).toBe(true); expect(await adapter.verify(input, { ...output, text: 'fabricated replacement' }, ctx)).toBe(false);
    expect(await adapter.verify(input, output, context())).toBe(false);
    await expect(adapter.execute(input, context({ ownerId: other }))).rejects.toMatchObject({ code: 'STUDIO_IMAGE_NOT_FOUND' }); expect(generate).toHaveBeenCalledOnce();
    await store.db.updateTable('studio_images').set({ data_base64: Buffer.from('changed fixture bytes').toString('base64') }).where('id', '=', image.id).execute();
    await expect(adapter.verify(input, output, ctx)).rejects.toMatchObject({ code: 'STUDIO_IMAGE_CHANGED' });
  });

  it('preserves paid provider failure usage and does not retry the vision call', async () => {
    const failure = new ProviderError('INVALID_RESPONSE', 'Ambiguous paid response'); failure.usage = { inputTokens: 11, outputTokens: 3 };
    const generate = vi.fn<ModelProvider['generate']>(async () => { throw failure; }), { image, adapter } = await visionFixture({ id: 'fixture-provider', generate }), ctx = context();
    await expect(adapter.execute({ goal: 'Describe the fixture image safely', imageId: image.id }, ctx)).rejects.toBe(failure);
    expect(generate).toHaveBeenCalledOnce(); expect(ctx.recordUsage).toHaveBeenCalledWith({ model: 'fixture-provider', usageKnown: true, inputTokens: 11, outputTokens: 3, errorCode: 'INVALID_RESPONSE' });
    expect(await store.db.selectFrom('fixture_vision_receipts').select('id').where('id', 'like', `%${ctx.taskId}%`).execute()).toEqual([]);
  });
});
