import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CreateTaskSchema, StudioChangeResultSchema, StudioCreateSchema, StudioEditSchema, StudioPreviewSchema,
  StudioSessionSchema, StudioWorkspaceSchema, TaskDetailSchema, TaskSchema,
} from '@mohassan/contracts';
import { checkError, checkJson, openClientApiApp, type ClientApiAccount } from './support/client-api-app.js';

const base = '/api/studio';
const originalHeading = 'Original fixture title';
const source = `<!doctype html><html><body><h1>${originalHeading}</h1></body></html>`;
const manualEdit = 'Manually edited fixture title';
const proposedEdit = 'Proposed fixture title';

vi.mock('../apps/server/src/studio-ai.js', async importOriginal => {
  const original = await importOriginal<typeof import('../apps/server/src/studio-ai.js')>();
  // Hand-author the edit at the generation boundary. The real runtime still verifies its Git tree and renders it.
  const createStudioAiControl: typeof original.createStudioAiControl = (database, config) =>
    original.createStudioAiControl(database, {
      ...config,
      generate: async ({ files }) => {
        const html = files.find(file => file.path === 'index.html');
        if (!html) throw new Error('Missing index.html in the Studio fixture');
        return {
          text: JSON.stringify({ summary: 'Change the heading.', edits: [
            { path: html.path, content: html.content.replace(originalHeading, proposedEdit) },
          ] }),
          model: 'studio-contract-fixture',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    });
  return { ...original, createStudioAiControl };
});

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const uploadedImage = z.strictObject({
  id: z.uuid(), hash: sha256, mimeType: z.literal('image/png'), width: z.number().int().positive(),
  height: z.number().int().positive(), bytes: z.number().int().positive(), expiresAt: z.iso.datetime(), url: z.string(),
});
const proposalStatus = z.strictObject({
  result: StudioChangeResultSchema, status: z.enum(['ready', 'applied']), appliedRevision: sha256.nullable(),
});
const appliedProposal = z.strictObject({ applied: z.literal(true), revision: sha256, sessionId: z.uuid() });

describe('Studio client API contracts', () => {
  let fixture: Awaited<ReturnType<typeof openClientApiApp>>;
  let owner: ClientApiAccount;
  let project: string;

  beforeAll(async () => {
    fixture = await openClientApiApp();
    owner = await fixture.setupOwner();
    project = join(fixture.directory, 'static-project');
    await mkdir(project);
    await writeFile(join(project, 'index.html'), source);
  });

  afterAll(async () => { await fixture?.close(); });

  async function importSource(name: string) {
    const request = StudioCreateSchema.parse({ name, path: project, framework: 'static' });
    return checkJson(await fixture.send('POST', `${base}/sessions`, owner, request), 200, StudioSessionSchema);
  }

  it('imports a local source, applies an edit through its preview map, and restores the prior revision', async () => {
    const { send } = fixture;
    const session = await importSource('Studio client import');
    const path = `${base}/sessions/${session.id}`;
    const workspace = checkJson(await send('GET', `${base}/sessions`, owner), 200, StudioWorkspaceSchema);
    expect(workspace.sessions).toContainEqual(expect.objectContaining({ id: session.id, revision: session.revision }));

    const preview = checkJson(await send('GET', `${path}/preview`, owner), 200, StudioPreviewSchema);
    const heading = preview.elements.find(element => element.tag === 'h1' && element.editableText);
    expect(heading?.text).toBe(originalHeading);
    const input = StudioEditSchema.parse({ revision: session.revision, elementId: heading?.id, text: manualEdit });
    const edited = checkJson(await send('POST', `${path}/edits`, owner, input), 200, StudioSessionSchema);
    expect(edited.revision).not.toBe(session.revision);
    expect(edited.files.find(file => file.path === 'index.html')?.content).toContain(manualEdit);
    checkError(await send('POST', `${path}/edits`, owner, input), 409, 'STUDIO_REVISION_CONFLICT');

    const restored = checkJson(await send('POST', `${path}/undo`, owner, { revision: edited.revision }), 200, StudioSessionSchema);
    expect(restored.files).toEqual(session.files);
    expect(restored.revision).not.toBe(edited.revision);
    checkError(await send('POST', `${path}/live`, owner, { revision: restored.revision }), 503, 'STUDIO_LIVE_NOT_CONFIGURED');
  });

  it('returns matching image metadata, content type and bytes for uploaded Studio references', async () => {
    const { send } = fixture;
    const image = new PNG({ width: 32, height: 48 });
    image.data.fill(255);
    const data = PNG.sync.write(image).toString('base64');
    const result = checkJson(await send('POST', `${base}/images`, owner, { mimeType: 'image/png', data }), 200, uploadedImage);
    expect([result.width, result.height]).toEqual([image.width, image.height]);
    const response = await send('GET', result.url, owner);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^image\/png/u);
    expect(response.rawPayload.length).toBe(result.bytes);
    expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(result.hash);
    expect(PNG.sync.read(response.rawPayload).data).toEqual(image.data);
    checkError(await send('GET', result.url), 401, 'UNAUTHORIZED');
  });

  it('serves a verified proposal, both visual artifacts, and the applied revision from the real app', async () => {
    const { send, application } = fixture;
    const session = await importSource('Studio client proposal');
    const input = CreateTaskSchema.parse({
      title: 'Update the fixture heading', goal: 'Change the heading and retain the rest of the page.',
      autonomy: 'assisted', capabilityId: 'studio.change',
      studioInput: { sessionId: session.id, revision: session.revision },
    });
    const task = checkJson(await send('POST', '/api/tasks', owner, input, {
      'idempotency-key': 'client-contract-studio-proposal',
    }), 200, TaskSchema);
    expect(task.status).toBe('waiting_approval');
    const taskPath = `/api/tasks/${task.id}`;
    checkJson(await send('POST', `${taskPath}/approve`, owner), 200, TaskSchema);
    await application.runtime.tick();

    const detail = checkJson(await send('GET', taskPath, owner), 200, TaskDetailSchema);
    const result = StudioChangeResultSchema.parse(detail.task.result);
    expect(result.outcome).toBe('ready_for_review');
    const path = `${base}/proposals/${result.proposalId}`;
    const proposal = checkJson(await send('GET', path, owner), 200, proposalStatus);
    expect(proposal.result).toEqual(result);
    expect(proposal.status).toBe('ready');

    for (const artifactId of [result.baselineImageId, result.candidateImageId]) {
      expect(artifactId).toBeTruthy();
      const artifact = await send('GET', `${base}/reviews/artifacts/${artifactId}`, owner);
      expect(artifact.statusCode).toBe(200);
      expect(artifact.headers['content-type']).toMatch(/^image\/png/u);
      const { width, height } = PNG.sync.read(artifact.rawPayload);
      expect(width * height).toBe(result.visualDiff?.totalPixels);
    }

    checkError(await send('POST', `${path}/apply`, owner, { revision: '0'.repeat(64) }), 409, 'STUDIO_REVISION_CONFLICT');
    const applied = checkJson(await send('POST', `${path}/apply`, owner, { revision: session.revision }), 200, appliedProposal);
    expect(applied.sessionId).toBe(session.id);
    const saved = checkJson(await send('GET', `${base}/sessions/${session.id}`, owner), 200, StudioSessionSchema);
    expect(saved.revision).toBe(applied.revision);
    expect(saved.files.find(file => file.path === 'index.html')?.content).toContain(proposedEdit);
    expect(checkJson(await send('GET', path, owner), 200, proposalStatus).appliedRevision).toBe(applied.revision);
  });
});
