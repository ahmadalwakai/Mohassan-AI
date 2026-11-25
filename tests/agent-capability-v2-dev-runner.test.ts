import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { capabilityBaselineCommit, type CapabilityCase } from '../scripts/agent-capability-bench/corpus.js';
import { loadDevelopmentCapabilityCorpus } from '../scripts/agent-capability-bench/v2/dev.js';
import { capabilityV2MappingVersion } from '../scripts/agent-capability-bench/v2/sealed.js';

// These parser sentinels never enter the development or sealed datasets.
const cases: CapabilityCase[] = [{
  id: 'human-0123456789abcdef01234567', area: 'calculation', language: 'en', variety: 'english',
  provenance: { author: 'human', source: 'parser sentinel' },
  turns: [{ text: 'DEV_PARSER_SENTINEL', expect: {
    route: ['compute'], status: ['completed'], questionCount: 0, requiredContent: [], forbiddenContent: [], maxSteps: 0,
  } }],
}];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const payload = JSON.stringify({ schemaVersion: 2, mappingVersion: capabilityV2MappingVersion, cases });
const notice = 'Development attribution parser sentinel.';
const manifest = {
  schemaVersion: 2, mappingVersion: capabilityV2MappingVersion, baselineCommit: capabilityBaselineCommit,
  development: { sha256: hash(payload), caseCount: 1, arabicCount: 0 },
  strata: [{ area: 'calculation', language: 'en', count: 1 }],
  files: { 'payload.json': hash(payload), 'NOTICE': hash(notice) },
};

async function withBundle(check: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-capability-v2-dev-'));
  try {
    await Promise.all([
      writeFile(join(directory, 'payload.json'), payload),
      writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest)),
      writeFile(join(directory, 'NOTICE'), notice),
    ]);
    await check(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('v2 development bundle', () => {
  it('loads the pinned development fixture with the shared v2 expectations', async () => {
    await withBundle(async directory => {
      await expect(loadDevelopmentCapabilityCorpus(directory)).resolves.toEqual({
        cases, manifest, manifestSha256: hash(JSON.stringify(manifest)),
      });
    });
  });

  it('verifies all file pins and counts before scoring', async () => {
    await withBundle(async directory => {
      await writeFile(join(directory, 'NOTICE'), 'Tampered notice.');
      await expect(loadDevelopmentCapabilityCorpus(directory)).rejects.toThrow('SHA-256 mismatch for a capability v2 release file.');
      await writeFile(join(directory, 'NOTICE'), notice);
      await writeFile(join(directory, 'payload.json'), 'Tampered payload.');
      await expect(loadDevelopmentCapabilityCorpus(directory)).rejects.toThrow('SHA-256 mismatch for the capability v2 payload file.');
      await writeFile(join(directory, 'payload.json'), payload);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, strata: [{ area: 'coding', language: 'en', count: 1 }] }));
      await expect(loadDevelopmentCapabilityCorpus(directory)).rejects.toThrow('Case counts do not match the capability v2 strata.');
    });
  });

  it('refuses symlinked manifests and sealed manifests before reading payloads', async () => {
    await withBundle(async directory => {
      const manifestPath = join(directory, 'manifest.json');
      const otherFile = join(directory, 'manifest-original.json');
      await rename(manifestPath, otherFile);
      await symlink(otherFile, manifestPath, 'file');
      await expect(loadDevelopmentCapabilityCorpus(directory)).rejects.toThrow('requires a regular bundle directory and manifest.json');
      await rm(manifestPath);
      await rm(join(directory, 'payload.json'));
      const { development, ...common } = manifest;
      await writeFile(manifestPath, JSON.stringify({ ...common, sealed: development }));
      await expect(loadDevelopmentCapabilityCorpus(directory)).rejects.toThrow('Invalid capability v2 manifest schema.');
    });
  });
});

describe('v2 development CLI', () => {
  const runFile = fileURLToPath(new URL('../scripts/agent-capability-bench/run.ts', import.meta.url));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', runFile, ...args]);

  it.each(['--sealed', '--manifest', '--development', '--version'])('refuses %s overrides with the standalone development flag', async option => {
    await expect(run('--v2-dev', option, 'unused')).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('--v2-dev uses the committed development bundle'),
    });
  }, 15_000);

  it('requires the exact baseline flag value', async () => {
    await expect(run('--v2-dev', '--baseline', 'false')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Expected --baseline true.') });
  }, 15_000);

  it('requires the pinned commit to mark the development baseline verified', async () => {
    await expect(run('--v2-dev', '--baseline', 'true')).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('Capability v2 development baseline requires the pinned commit'),
    });
  }, 15_000);

  it('refuses to put a development receipt inside either fixture directory', async () => {
    const fixtures = fileURLToPath(new URL('./fixtures/agent-capability-bench/v2/', import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), 'agent-capability-v2-receipt-'));
    const symlinkedSeal = join(directory, 'alias');
    try {
      await symlink(join(fixtures, 'sealed'), symlinkedSeal, 'dir');
      for (const parent of [join(fixtures, 'dev'), join(fixtures, 'sealed'), symlinkedSeal]) {
        await expect(run('--v2-dev', '--output', join(parent, 'uncreated', 'receipt.json'))).rejects.toMatchObject({
          code: 1, stderr: expect.stringContaining('outside both fixture directories'),
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
