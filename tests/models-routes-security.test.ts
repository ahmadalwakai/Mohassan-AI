import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerModelsRoutes, type ModelsRoutesOptions } from '../apps/server/src/models-routes.js';

const apps: ReturnType<typeof Fastify>[] = [];

async function routes() {
  const app = Fastify();
  apps.push(app);
  const run = vi.fn<ModelsRoutesOptions['runner']['run']>().mockResolvedValue({ ok: true, output: {}, elapsedMs: 0 });
  await registerModelsRoutes(app, {
    owner: async () => ({ id: 'owner-fixture' }), isOwner: async () => true,
    runner: { run }, roots: [process.cwd()], imageReaderLive: false, v5Live: false, councilLive: false,
  });
  return { app, run };
}

const image = (format: 'png' | 'jpeg' | 'webp' | 'gif') =>
  sharp({ create: { width: 16, height: 16, channels: 3, background: '#4080c0' } }).toFormat(format).toBuffer();

afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('owner model run input boundaries', () => {
  it.each(['jpeg', 'gif'] as const)('rejects a %s file supplied as PNG before staging or running it', async format => {
    const { app, run } = await routes();
    const payload = { image: { mimeType: 'image/png', data: (await image(format)).toString('base64') } };
    const response = await app.inject({ method: 'POST', url: '/api/models/ocr/run', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'MODEL_INPUT' } });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['png', 'jpeg', 'webp'] as const)('stages a %s file of the declared type and removes it after the run', async format => {
    const { app, run } = await routes();
    const bytes = await image(format);
    let imagePath: string | undefined;
    run.mockImplementation(async (_modelId, input) => {
      imagePath = (input as { path: string }).path;
      expect(await readFile(imagePath)).toEqual(bytes);
      return { ok: true, output: {}, elapsedMs: 0 };
    });
    const response = await app.inject({ method: 'POST', url: '/api/models/ocr/run',
      payload: { image: { mimeType: `image/${format}`, data: bytes.toString('base64') } } });
    expect(response.statusCode).toBe(200);
    expect(imagePath).toBeDefined();
    await expect(readFile(imagePath!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not fall back to an independent worker when the resident v5 path is unavailable', async () => {
    const { app, run } = await routes();
    const listed = await app.inject({ url: '/api/models' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().models.find((model: { id: string }) => model.id === 'chat-v5')).toMatchObject({ input: 'none' });
    const response = await app.inject({ method: 'POST', url: '/api/models/chat-v5/run', payload: { text: 'A short example.' } });
    expect(response.statusCode).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });
});
