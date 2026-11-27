import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCouncilRouterAdapter } from './council-router-adapter.js';
import { getModelEntry, type ResolvedModel } from './registry.js';
import type { ModelAdapterContext } from './runtime.js';

// The expected feature names and tensor shapes follow the pinned trainer's export_model and ngram_ids.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/scripts/router/train_context.py (retrieved 2026-11-27).
const routes = ['web_search', 'browser_command', 'news', 'memory', 'reminder', 'compute', 'ads', 'pc', 'writing',
  'planning', 'coding', 'chat', 'image', 'media', 'unsupported', 'clarify'];
const contextFeatures = [
  ...['none', ...routes].map(route => `prior_route:${route}`),
  ...['none', 'public_lookup', 'prior_conversation', 'local_state', 'supplied_content', 'unresolved'].map(source => `source:${source}`),
  ...['none', 'public', 'private', 'unknown'].map(scope => `scope:${scope}`),
  'pending:false', 'pending:true',
  ...['none', 'choice', 'place', 'budget', 'time', 'text'].map(field => `field:${field}`),
];
const directories: string[] = [];
const signal = new AbortController().signal;
const context: ModelAdapterContext = {
  root: process.cwd(), env: {}, signal, memoryBudgetMiB: 4_608, dependencies: [], startupMs: 1_000,
  assertGpuFree: async () => {},
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(withContext: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'council-router-test-'));
  directories.push(dir);
  const config = { buckets: 128, dim: 4, hidden: 8 };
  const features = config.dim + contextFeatures.length;
  let offsetBytes = 0;
  const descriptors: [string, number[]][] = [
    ['embedding.weight', [config.buckets, config.dim]], ['projection.weight', [config.hidden, features]],
    ['projection.bias', [config.hidden]], ['classifier.weight', [routes.length, config.hidden]], ['classifier.bias', [routes.length]],
  ];
  const layout = descriptors.map(([name, shape]) => {
    const lengthBytes = shape.reduce((total, value) => total * value, 4);
    const descriptor = { name, shape, offsetBytes, lengthBytes };
    offsetBytes += lengthBytes;
    return descriptor;
  });
  const bytes = Buffer.alloc(offsetBytes);
  const keys = ['c2:^ا', 'c2:ا2', 'c2:2$', 'c3:^ا2', 'c3:ا2$', 'c4:^ا2$', 'w:ا2'];
  for (const key of keys) {
    const bucket = createHash('sha256').update(`current:${key}`).digest().readUInt32BE() % config.buckets;
    bytes.writeFloatLE(1, layout[0].offsetBytes + bucket * config.dim * 4);
  }
  bytes.writeFloatLE(1, layout[1].offsetBytes);
  const news = routes.indexOf('news');
  const chat = routes.indexOf('chat');
  bytes.writeFloatLE(2, layout[1].offsetBytes + (config.dim + contextFeatures.indexOf('prior_route:news')) * 4);
  bytes.writeFloatLE(1, layout[3].offsetBytes + news * config.hidden * 4);
  bytes.writeFloatLE(2, layout[4].offsetBytes + chat * 4);
  const manifest = { format: 'mohassan-context-b0-v1', active: false, routes, config, withContext, contextFeatures,
    dtype: 'float32-little-endian', layout, sha256: createHash('sha256').update(bytes).digest('hex') };
  const files = [
    ['manifest', JSON.stringify(manifest)], ['weights', bytes], ['calibration', JSON.stringify({ temperature: 1,
      threshold: 0.4, partition: 'calibration', notProductionCalibrated: true })],
  ] as const;
  const artifacts = await Promise.all(files.map(async ([role, content]) => {
    const path = join(dir, role);
    await writeFile(path, content);
    return { role, path, present: true, required: true, sha256: null };
  }));
  const model: ResolvedModel = { entry: getModelEntry(withContext ? 'router-context-history' : 'router-context-text')!,
    state: 'experimental', artifacts };
  return { model, dir, bytes, manifest };
}

describe('council context router adapters', () => {
  it('applies the exported contextual indicators and abstains on a text-only prediction below calibration', async () => {
    const [withContext, withoutContext] = await Promise.all([fixture(true), fixture(false)]);
    const [history, text] = await Promise.all([loadCouncilRouterAdapter(withContext.model, context),
      loadCouncilRouterAdapter(withoutContext.model, context)]);
    const turn = { text: ' أ۲ ', previousRoute: 'news' };
    expect(await history.run(turn, signal, 100)).toEqual({ route: 'news', abstained: false,
      confidence: Math.fround(Math.exp(3) / (Math.exp(3) + Math.exp(2) + routes.length - 2)) });
    expect(await text.run(turn, signal, 100)).toEqual({ route: 'chat', abstained: true,
      confidence: Math.fround(Math.exp(2) / (Math.exp(2) + Math.exp(1) + routes.length - 2)) });
    expect(() => history.run({ ...turn, requestedField: 'place' }, signal, 100)).toThrowError(expect.objectContaining({ reason: 'invalid-input' }));
  });

  it('requires the exact contiguous export layout and checks the bytes against the manifest', async () => {
    const { model, dir, bytes, manifest } = await fixture(false);
    bytes[0] ^= 1;
    await writeFile(join(dir, 'weights'), bytes);
    await expect(loadCouncilRouterAdapter(model, context)).rejects.toMatchObject({ reason: 'incompatible', detail: expect.stringContaining('SHA-256') });
    manifest.layout[1].offsetBytes += 4;
    await writeFile(join(dir, 'manifest'), JSON.stringify(manifest));
    await expect(loadCouncilRouterAdapter(model, context)).rejects.toMatchObject({ reason: 'incompatible', detail: expect.stringContaining('layout') });
  });
});
