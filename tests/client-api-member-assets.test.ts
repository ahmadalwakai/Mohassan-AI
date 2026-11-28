import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TaskSchema } from '@mohassan/contracts';
import {
  ChecklistCategorySchema, ChecklistCheckSchema, exampleSkill, MemoryCorrectionSchema, MemoryCreateSchema,
  MemoryItemSchema, MemoryWorkspaceSchema, SkillSchema,
} from '@mohassan/memory';
import { checkError, checkJson, openClientApiApp, type ClientApiAccount } from './support/client-api-app.js';

// The document DTO is local to the Fastify routes (apps/server/src/documents.ts:16–20,184).
const documentReply = z.strictObject({
  id: z.uuid(), conversationId: z.uuid().nullable(), name: z.string().min(1),
  size: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/), pages: z.number().int().positive(),
  source: z.enum(['created', 'edited', 'uploaded']), theme: z.string().nullable(), createdAt: z.iso.datetime(),
  url: z.url(),
});

describe('member memory and document wire contracts', () => {
  let fixture: Awaited<ReturnType<typeof openClientApiApp>>;
  let owner: ClientApiAccount;
  let member: ClientApiAccount;
  beforeAll(async () => {
    fixture = await openClientApiApp();
    owner = await fixture.setupOwner();
    member = await fixture.inviteMember(owner);
  });
  afterAll(async () => fixture?.close());

  it('reads, corrects, searches, revokes and erases an account-owned memory item', async () => {
    const create = MemoryCreateSchema.parse({ title: 'Garden notes', content: 'Plant calendula.', layer: 'semantic' });
    const memory = checkJson(await fixture.send('POST', '/api/memory/items', member, create), 200, MemoryItemSchema);
    const url = `/api/memory/items/${memory.id}`;
    const detail = z.strictObject({ item: MemoryItemSchema, versions: z.array(MemoryItemSchema) });
    expect(checkJson(await fixture.send('GET', url, member), 200, detail).item.id).toBe(memory.id);
    checkError(await fixture.send('GET', url, owner), 404, 'MEMORY_NOT_FOUND');

    const replacement = MemoryCorrectionSchema.parse({
      ...create, content: 'Plant calendula in spring.', expectedVersion: memory.version, reason: 'Add the season',
    });
    const changed = checkJson(await fixture.send('POST', `${url}/correct`, member, replacement), 200, MemoryItemSchema);
    expect(changed.version).toBe(memory.version + 1);
    checkError(await fixture.send('POST', `${url}/correct`, member, replacement), 409, 'MEMORY_VERSION_CONFLICT');

    // The item schema is shared by the index and detail. The search envelope is defined in packages/memory/src/index.ts:206.
    const search = z.strictObject({
      items: z.array(MemoryItemSchema), method: MemoryWorkspaceSchema.shape.method,
      citations: z.array(z.strictObject({
        memoryId: z.uuid(), evidenceId: z.uuid(), taskId: z.string().nullable(), kind: z.string(),
      })),
      expiredExcluded: z.number().int().nonnegative(),
    });
    const found = checkJson(await fixture.send('POST', '/api/memory/search', member, { query: 'calendula' }), 200, search);
    expect(found.items.map(item => item.id)).toEqual([changed.id]);
    expect(found.citations[0]?.memoryId).toBe(changed.id);
    expect(checkJson(await fixture.send('GET', '/api/memory', member), 200, MemoryWorkspaceSchema).items[0]?.id).toBe(changed.id);

    const changedUrl = `/api/memory/items/${changed.id}`;
    const mutation = { expectedVersion: changed.version, reason: 'Remove the fixture' };
    checkJson(await fixture.send('POST', `${changedUrl}/revoke`, member, mutation), 200, z.strictObject({ revoked: z.literal(true) }));
    checkJson(await fixture.send('POST', `${changedUrl}/delete`, member, mutation), 200, z.strictObject({ deleted: z.literal(true) }));
    checkError(await fixture.send('GET', changedUrl, member), 404, 'MEMORY_NOT_FOUND');
  });

  it('validates task feedback and the owner memory skill lifecycle', async () => {
    const task = checkJson(await fixture.send('POST', '/api/tasks', owner, {
      title: 'System diagnostic', goal: 'Check the local environment.',
      capabilityId: 'system.diagnostic', autonomy: 'assisted',
    }, { 'idempotency-key': randomUUID() }), 200, TaskSchema);
    const feedback = {
      taskId: task.id, kind: 'task_correction', comment: 'Use the full result.',
      submissionKey: randomUUID(),
    };
    const feedbackReply = z.strictObject({ id: z.uuid(), persistedPreference: z.boolean() });
    const saved = checkJson(await fixture.send('POST', '/api/memory/feedback', owner, feedback), 200, feedbackReply);
    expect(checkJson(await fixture.send('POST', '/api/memory/feedback', owner, feedback), 200, feedbackReply)).toEqual(saved);
    checkError(await fixture.send('POST', '/api/memory/feedback', member, feedback), 404, 'TASK_NOT_FOUND');

    const created = checkJson(await fixture.send('POST', '/api/memory/skills', owner, {
      name: 'Fixture checklist', description: 'Choose a checklist with the built-in deterministic rules.', manifest: exampleSkill,
    }), 200, SkillSchema);
    const root = `/api/memory/skills/${created.id}`;
    const tested = checkJson(await fixture.send('POST', `${root}/test`, owner, { expectedRevision: created.revision }), 200, SkillSchema);
    const benchmarked = checkJson(await fixture.send('POST', `${root}/benchmark`, owner, { expectedRevision: tested.revision }), 200, SkillSchema);
    const evaluation = benchmarked.evaluations.find(entry => entry.kind === 'benchmark');
    expect(evaluation?.passed).toBe(true);
    const active = checkJson(await fixture.send('POST', `${root}/activate`, owner, {
      expectedRevision: benchmarked.revision, evaluationId: evaluation?.id, approve: true,
    }), 200, SkillSchema);
    expect(active.status).toBe('active');
    const run = await fixture.send('POST', `${root}/run`, owner, { input: 'Run a diagnostic' });
    expect(checkJson(run, 200, z.object({
      skillId: z.uuid(), version: z.number().int().positive(), manifestHash: z.string(),
      category: ChecklistCategorySchema, checks: z.array(ChecklistCheckSchema),
    })).skillId).toBe(active.id);
    const revoked = checkJson(await fixture.send('POST', `${root}/revoke`, owner, {
      expectedRevision: active.revision, reason: 'Finish the contract fixture',
    }), 200, SkillSchema);
    expect(revoked.status).toBe('revoked');
    checkError(await fixture.send('POST', `${root}/run`, owner, { input: 'Run a diagnostic' }), 409, 'SKILL_NOT_ACTIVE');
  });

  it('creates, downloads, uploads and removes a PDF through Fastify', async () => {
    const created = checkJson(await fixture.send('POST', '/api/documents', member, {
      spec: { title: 'Garden notes', theme: 'report', blocks: [{ kind: 'paragraph', text: 'Plant calendula in spring.' }] },
    }), 200, documentReply);
    expect(created.source).toBe('created');
    const contentUrl = new URL(created.url).pathname;
    const downloaded = await fixture.send('GET', contentUrl, member);
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toBe('application/pdf');
    expect(downloaded.headers['content-disposition']).toMatch(/^attachment;/u);
    expect(downloaded.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(downloaded.rawPayload.length).toBe(created.size);
    expect(createHash('sha256').update(downloaded.rawPayload).digest('hex')).toBe(created.hash);
    checkError(await fixture.send('GET', contentUrl, owner), 404, 'DOCUMENT_NOT_FOUND');

    const uploaded = checkJson(await fixture.send('POST', '/api/documents/upload', member, {
      name: 'garden-notes.pdf', base64: downloaded.rawPayload.toString('base64'),
    }), 200, documentReply);
    expect(uploaded).toMatchObject({ source: 'uploaded', hash: created.hash, pages: created.pages });
    const listed = checkJson(await fixture.send('GET', '/api/documents', member), 200,
      z.strictObject({ documents: z.array(documentReply), maxUploadBytes: z.number().int().positive(), themes: z.array(z.string()).min(1) }));
    expect(listed.documents.map(item => item.id)).toContain(uploaded.id);
    checkJson(await fixture.send('DELETE', `/api/documents/${uploaded.id}`, member), 200, z.strictObject({ removed: z.literal(true) }));
    checkError(await fixture.send('GET', new URL(uploaded.url).pathname, member), 404, 'DOCUMENT_NOT_FOUND');
  });
});
