import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OWN_MODEL_PHRASING_MAX_TOKENS,
  loadOwnModelGates,
  readOwnModelGateConfig,
  type OwnModelCapability,
} from '../apps/server/src/own-model-gates.js';

const candidateSha256 = 'a'.repeat(64);
const routerSha256 = 'c'.repeat(64);
const calibration = { temperature: 1.5, minConfidence: 0.8, minMargin: 0.2 };
const generation = { seed: 21, temperature: 0, max_tokens: OWN_MODEL_PHRASING_MAX_TOKENS, eos_rule: 'require_eos' };
const directories: string[] = [];

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'own-model-gates-'));
  directories.push(directory);
  return directory;
}

async function writeJson(path: string, value: unknown) {
  const bytes = JSON.stringify(value);
  await writeFile(path, bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture(capability: OwnModelCapability, options?: {
  directory?: string;
  recordOverrides?: Record<string, unknown>;
  reportOverrides?: Record<string, unknown>;
}) {
  const directory = options?.directory ?? await tempDirectory();
  const mode = capability === 'phrasing' ? 'active' : 'shadow';
  const reportFile = `${capability}-report.json`;
  const reportPath = join(directory, reportFile);
  const sha256 = await writeJson(reportPath, {
    schema_version: 1, version: 1, decision: 'pass', gate_id: `own-model.${capability}.${mode}`,
    adapter: capability === 'phrasing' ? 'generation' : 'classifier', case_count: 4,
    generation: capability === 'phrasing' ? generation : null,
    hashes: { candidate: { path: 'model-worker.json', sha256: candidateSha256 } },
    checks: [{ rule: capability === 'phrasing' ? 'minimum_passes.overall' : 'classifier.max_ece', status: 'pass' }],
    ...options?.reportOverrides,
  });
  const recordFile = `${capability}-gate.json`;
  const recordPath = join(directory, recordFile);
  const recordSha256 = await writeJson(recordPath, {
    schemaVersion: 1, capability, mode, workerConfigSha256: candidateSha256,
    report: { path: reportFile, sha256 },
    ...(capability === 'route-choice' ? { routerSha256 } : {}),
    ...(capability === 'phrasing' ? {} : { calibration }),
    ...options?.recordOverrides,
  });
  return { directory, reportPath, recordFile, recordPath, recordSha256 };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('own-model activation records', () => {
  it('keeps every capability off when a configuration has no valid pin', async () => {
    const { directory, recordFile } = await fixture('route-choice');
    const path = join(directory, 'own-model-provider.json');
    expect(await readOwnModelGateConfig(path)).toEqual({});
    await writeJson(path, { gates: { 'route-choice': { path: recordFile } } });
    const gates = await loadOwnModelGates(await readOwnModelGateConfig(path));
    expect(gates.get('route-choice', candidateSha256)).toBeUndefined();
    expect(gates.get('follow-up-turn-type', candidateSha256)).toBeUndefined();
    expect(gates.get('phrasing', candidateSha256)).toBeUndefined();
  });

  it('loads independent records relative to the operator config and verifies the running candidate', async () => {
    const route = await fixture('route-choice');
    const phrase = await fixture('phrasing', { directory: route.directory });
    const path = join(route.directory, 'own-model-provider.json');
    await writeJson(path, { gates: {
      'route-choice': { path: route.recordFile, sha256: route.recordSha256 },
      phrasing: { path: phrase.recordFile, sha256: phrase.recordSha256 },
    } });
    const gates = await loadOwnModelGates(await readOwnModelGateConfig(path));
    expect(gates.get('route-choice', candidateSha256)).toMatchObject({ mode: 'shadow', calibration, routerSha256 });
    expect(gates.get('follow-up-turn-type', candidateSha256)).toBeUndefined();
    expect(gates.get('phrasing', candidateSha256)).toMatchObject({ mode: 'active' });
    expect(gates.get('phrasing', 'b'.repeat(64))).toBeUndefined();
    expect(gates.get('route-choice', undefined)).toBeUndefined();
  });

  it('rejects changed record or report bytes and leaves unrelated gates usable', async () => {
    const route = await fixture('route-choice');
    const followUp = await fixture('follow-up-turn-type', { directory: route.directory });
    const phrase = await fixture('phrasing', { directory: route.directory });
    await appendFile(route.recordPath, '\n');
    await appendFile(phrase.reportPath, '\n');
    const gates = await loadOwnModelGates({
      'route-choice': { path: route.recordPath, sha256: route.recordSha256 },
      'follow-up-turn-type': { path: followUp.recordPath, sha256: followUp.recordSha256 },
      phrasing: { path: phrase.recordPath, sha256: phrase.recordSha256 },
    });
    expect(gates.get('route-choice', candidateSha256)).toBeUndefined();
    expect(gates.get('follow-up-turn-type', candidateSha256)).toMatchObject({ mode: 'shadow', calibration });
    expect(gates.get('phrasing', candidateSha256)).toBeUndefined();
  });

  it.each([
    ['capability mismatch', { recordOverrides: { capability: 'follow-up-turn-type' } }],
    ['decision active mode', { recordOverrides: { mode: 'active' } }],
    ['missing calibration', { recordOverrides: { calibration: undefined } }],
    ['invalid calibration', { recordOverrides: { calibration: { ...calibration, temperature: 0 } } }],
    ['zero confidence threshold', { recordOverrides: { calibration: { ...calibration, minConfidence: 0 } } }],
    ['zero margin threshold', { recordOverrides: { calibration: { ...calibration, minMargin: 0 } } }],
    ['missing router pin', { recordOverrides: { routerSha256: undefined } }],
    ['report stopped', { reportOverrides: { decision: 'stop' } }],
    ['report inconclusive', { reportOverrides: { decision: 'inconclusive' } }],
    ['report for another capability', { reportOverrides: { gate_id: 'own-model.follow-up-turn-type.shadow' } }],
    ['report for another worker', { reportOverrides: { hashes: { candidate: { sha256: 'b'.repeat(64) } } } }],
    ['report without calibration assessment', { reportOverrides: { checks: [{ rule: 'minimum_passes.overall', status: 'pass' }] } }],
  ] as const)('rejects a pinned record with %s', async (_description, options) => {
    const gate = await fixture('route-choice', options);
    const gates = await loadOwnModelGates({ 'route-choice': { path: gate.recordPath, sha256: gate.recordSha256 } });
    expect(gates.get('route-choice', candidateSha256)).toBeUndefined();
  });

  it('bounds startup reads and fails closed on non-files, malformed JSON and oversized configuration', async () => {
    const directory = await tempDirectory();
    const path = join(directory, 'own-model-provider.json');
    expect(await readOwnModelGateConfig(directory)).toEqual({});
    await writeFile(path, '{');
    expect(await readOwnModelGateConfig(path)).toEqual({});
    await writeFile(path, ' '.repeat(64 * 1024 + 1));
    expect(await readOwnModelGateConfig(path)).toEqual({});
  });

  it.each([
    { ...generation, temperature: 0.5 },
    { ...generation, max_tokens: 32 },
    { ...generation, eos_rule: 'allow_token_limit' },
  ])('rejects a generation report with different phrasing settings (%j)', async settings => {
    const gate = await fixture('phrasing', { reportOverrides: { generation: settings } });
    const gates = await loadOwnModelGates({ phrasing: { path: gate.recordPath, sha256: gate.recordSha256 } });
    expect(gates.get('phrasing', candidateSha256)).toBeUndefined();
  });
});
