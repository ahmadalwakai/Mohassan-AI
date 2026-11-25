import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { capabilityBaselineCommit, loadCapabilityCorpus, type CapabilityCase } from '../scripts/agent-capability-bench/corpus.js';
import {
  capabilityV2MappingVersion, loadSealedCapabilityCorpus, type CapabilityV2Manifest,
} from '../scripts/agent-capability-bench/v2/sealed.js';

// Parser-only sentinels. They are never sent to the controller or included in the benchmark.
function parserCase(index: number, language: CapabilityCase['language']): CapabilityCase {
  return {
    id: `human-${index.toString(16).padStart(24, '0')}`,
    area: 'calculation', language, variety: language === 'ar' ? 'unspecified' : 'english',
    provenance: { author: 'human', source: 'parser sentinel' },
    turns: [{
      text: `SEALED-SENTINEL-${index}`,
      expect: { route: ['compute'], questionCount: 0, status: ['completed'], requiredContent: [], forbiddenContent: [], maxSteps: 0 },
    }],
  };
}

const payloadBytes = (cases: CapabilityCase[]) => Buffer.from(JSON.stringify({
  schemaVersion: 2, mappingVersion: capabilityV2MappingVersion, cases,
}));

async function withFiles(
  check: (paths: { manifest: string; sealed: string }, manifest: CapabilityV2Manifest) => Promise<void>,
  payload = payloadBytes([parserCase(1, 'en'), parserCase(2, 'ar')]),
) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-capability-v2-sealed-'));
  const paths = { manifest: join(directory, 'manifest.json'), sealed: join(directory, 'payload.json') };
  const manifest: CapabilityV2Manifest = {
    schemaVersion: 2, mappingVersion: capabilityV2MappingVersion, baselineCommit: capabilityBaselineCommit,
    sealed: { sha256: createHash('sha256').update(payload).digest('hex'), caseCount: 2, arabicCount: 1 },
    strata: [{ area: 'calculation', language: 'en', count: 1 }, { area: 'calculation', language: 'ar', count: 1 }],
  };
  try {
    await Promise.all([writeFile(paths.manifest, JSON.stringify(manifest)), writeFile(paths.sealed, payload)]);
    await check(paths, manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('v2 seal', () => {
  it('loads the pinned human payload with the same expectations as v1 and rejects it in v1', async () => {
    await withFiles(async paths => {
      const { cases } = await loadSealedCapabilityCorpus(paths);
      expect(cases).toEqual([parserCase(1, 'en'), parserCase(2, 'ar')]);
      await expect(loadCapabilityCorpus({ ...paths, development: paths.sealed })).rejects.toThrow('Invalid capability manifest schema.');
    });
    await withFiles(async (paths, { sealed }) => {
      await writeFile(paths.manifest, JSON.stringify({
        schemaVersion: 1, baselineCommit: capabilityBaselineCommit,
        development: { ...sealed, caseCount: 240, arabicCount: 120 },
        sealed: { ...sealed, caseCount: 60, arabicCount: 30 },
      }));
      await expect(loadCapabilityCorpus({ manifest: paths.manifest, development: paths.sealed })).rejects.toThrow('Invalid capability development schema.');
    });
  });

  it('checks raw bytes before parsing and hides sealed contents in parse errors', async () => {
    await withFiles(async paths => {
      await writeFile(paths.sealed, 'SEALED-SENTINEL');
      await expect(loadSealedCapabilityCorpus(paths)).rejects.toThrow(/^SHA-256 mismatch for the capability v2 payload file\.$/u);
    });
    await withFiles(async paths => {
      await expect(loadSealedCapabilityCorpus(paths)).rejects.toThrow(/^The capability v2 payload file is not valid UTF-8 JSON\.$/u);
    }, Buffer.from('SEALED-SENTINEL'));
  });

  it('rejects duplicate declarations and compares per-area language strata to the rows', async () => {
    await withFiles(async (paths, manifest) => {
      manifest.strata = [manifest.strata[0]!, manifest.strata[0]!, manifest.strata[1]!];
      manifest.sealed.caseCount = 3;
      await writeFile(paths.manifest, JSON.stringify(manifest));
      await expect(loadSealedCapabilityCorpus(paths)).rejects.toThrow('Inconsistent capability v2 manifest counts.');
    });
    await withFiles(async (paths, manifest) => {
      manifest.strata[0]!.area = 'coding';
      await writeFile(paths.manifest, JSON.stringify(manifest));
      await expect(loadSealedCapabilityCorpus(paths)).rejects.toThrow('Case counts do not match the capability v2 strata.');
    });
  });

  it('requires the recorded mapping revision in both the manifest and the sealed payload', async () => {
    await withFiles(async (paths, manifest) => {
      await writeFile(paths.manifest, JSON.stringify({ ...manifest, mappingVersion: 999 }));
      await expect(loadSealedCapabilityCorpus(paths)).rejects.toThrow('Invalid capability v2 manifest schema.');
    });
    await withFiles(async paths => {
      await expect(loadSealedCapabilityCorpus(paths)).rejects.toThrow('Invalid capability v2 payload schema.');
    }, Buffer.from(JSON.stringify({ schemaVersion: 2, mappingVersion: 999, cases: [parserCase(1, 'en'), parserCase(2, 'ar')] })));
  });

  it('requires human provenance, opaque identifiers and distinct normalized prompts', async () => {
    const invalid = [
      { ...parserCase(2, 'ar'), provenance: { author: 'agent', source: 'parser sentinel' } },
      { ...parserCase(2, 'ar'), id: 'human-readable-id' },
    ];
    for (const item of invalid) {
      await withFiles(async paths => {
        await expect(loadSealedCapabilityCorpus(paths)).rejects.toThrow(/^Invalid capability v2 payload schema\.$/u);
      }, payloadBytes([parserCase(1, 'en'), item]));
    }
    const duplicate = parserCase(2, 'ar');
    duplicate.turns[0]!.text = '  sealed-sentinel-1\n';
    await withFiles(async paths => {
      await expect(loadSealedCapabilityCorpus(paths)).rejects.toThrow('Duplicate normalized capability case input.');
    }, payloadBytes([parserCase(1, 'en'), duplicate]));
  });
});

describe('v2 benchmark CLI', () => {
  const runFile = fileURLToPath(new URL('../scripts/agent-capability-bench/run.ts', import.meta.url));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', runFile, ...args]);

  it('requires an explicit v2 payload and receipt path and rejects development settings and manifest overrides', async () => {
    await expect(run('--version', '2')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('requires --sealed PATH and --output PATH') });
    for (const option of ['--development', '--manifest']) {
      await expect(run('--version', '2', '--sealed', 'unused', '--output', 'unused', option, 'unused'))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('uses the pinned manifest') });
    }
  });

  it('allows the exact baseline setting only in the sealed mode', async () => {
    await expect(run('--baseline', 'true')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('only for capability v2') });
    await expect(run('--version', '2', '--sealed', 'unused', '--output', 'unused', '--baseline', 'false'))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Expected --baseline true.') });
  });

  it('rejects baseline receipt creation from the benchmark branch before opening the payload', async () => {
    await expect(run('--version', '2', '--sealed', 'unused', '--output', 'unused', '--baseline', 'true'))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('requires the pinned commit') });
  });
});
