import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  capabilityAreas, capabilityBaselineCommit, capabilityCaseSchema, capabilityExpectationSchema,
  capabilityVarieties, loadCapabilityCorpus, type CapabilityCase, type CapabilityExpectation, type CapabilityManifest,
} from '../scripts/agent-capability-bench/corpus.js';

const structuralExpectation: CapabilityExpectation = {
  route: ['chat'],
  questionCount: 0,
  status: ['completed'],
  requiredContent: [],
  forbiddenContent: [],
  maxSteps: 0,
};

// Parser-only sentinels. These values are never submitted to chat or used as benchmark data.
function structuralRows(partition: 'd' | 's', caseCount: number): CapabilityCase[] {
  const arabicVarieties = capabilityVarieties.filter(variety => variety !== 'english' && variety !== 'unspecified');
  return Array.from({ length: caseCount }, (_, index) => {
    const area = capabilityAreas[index % capabilityAreas.length]!;
    const arabic = index < caseCount / 2;
    return {
      id: `fixture-${partition}-${index}`,
      area,
      language: arabic ? 'ar' : 'en',
      variety: arabic ? arabicVarieties[index % arabicVarieties.length]! : 'english',
      provenance: { author: 'x', source: 'x' },
      turns: [{
        text: `#${partition}${index}`,
        expect: area === 'clarification' ? { ...structuralExpectation, questionCount: 1, status: ['waiting_user'] } : structuralExpectation,
      }],
    };
  });
}

const partitionFile = (cases: CapabilityCase[]) => JSON.stringify({ schemaVersion: 1, cases });
const v2SealedPayload = fileURLToPath(new URL('./fixtures/agent-capability-bench/v2/sealed/payload.json', import.meta.url));
const v2SealedPathError = 'The v1 capability runner cannot read the v2 sealed release directory.';
const partitionManifest = (cases: CapabilityCase[], bytes: string) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  caseCount: cases.length,
  arabicCount: cases.filter(item => item.language === 'ar').length,
});

async function withCorpus(
  check: (paths: { manifest: string; development: string; sealed: string }, manifest: CapabilityManifest) => Promise<void>,
  change: (development: CapabilityCase[], sealed: CapabilityCase[]) => void = () => {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-capability-corpus-'));
  const paths = { manifest: join(directory, 'manifest.json'), development: join(directory, 'development.json'), sealed: join(directory, 'sealed.json') };
  try {
    const development = structuralRows('d', 240);
    const sealed = structuralRows('s', 60);
    change(development, sealed);
    const developmentBytes = partitionFile(development);
    const sealedBytes = partitionFile(sealed);
    const manifest: CapabilityManifest = {
      schemaVersion: 1,
      baselineCommit: capabilityBaselineCommit,
      development: partitionManifest(development, developmentBytes),
      sealed: partitionManifest(sealed, sealedBytes),
    };
    await Promise.all([
      writeFile(paths.manifest, JSON.stringify(manifest)),
      writeFile(paths.development, developmentBytes),
      writeFile(paths.sealed, sealedBytes),
    ]);
    await check(paths, manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('capability corpus loading', () => {
  it('validates the pinned evaluation-only development cases without the holdout payload', async () => {
    const fixture = new URL('./fixtures/agent-capability-bench/', import.meta.url);
    const { manifest, development, sealed } = await loadCapabilityCorpus({
      manifest: fileURLToPath(new URL('manifest.json', fixture)),
      development: fileURLToPath(new URL('development.json', fixture)),
    });
    expect(manifest.development).toMatchObject({ caseCount: 240, arabicCount: 120 });
    expect(manifest.sealed).toMatchObject({ caseCount: 60, arabicCount: 30 });
    expect(sealed).toBeUndefined();
    expect(development.every(item => item.provenance.author === 'agent' && item.provenance.source.includes('never for training'))).toBe(true);
    for (const area of capabilityAreas) {
      const languages = new Set(development.filter(item => item.area === area).map(item => item.language));
      expect(languages).toEqual(new Set(['ar', 'en']));
    }
  });

  it('loads development without the sealed payload and loads both only with an explicit sealed path', async () => {
    await withCorpus(async ({ sealed, ...visible }, manifest) => {
      const audit = await loadCapabilityCorpus({ ...visible, sealed });
      expect(audit.development).toHaveLength(240);
      expect(audit.sealed).toHaveLength(60);
      await rm(sealed);
      const development = await loadCapabilityCorpus(visible);
      expect(development).toEqual({ development: audit.development, manifest });
      await expect(loadCapabilityCorpus({ ...visible, sealed })).rejects.toThrow('Could not read the capability sealed file.');
    });
  });

  it('rejects direct v2 release paths in all v1 inputs before reading the manifest', async () => {
    await withCorpus(async paths => {
      await writeFile(paths.manifest, 'Malformed v1 manifest sentinel.');
      for (const option of ['manifest', 'development', 'sealed'] as const) {
        await expect(loadCapabilityCorpus({ ...paths, [option]: v2SealedPayload })).rejects.toThrow(v2SealedPathError);
      }
      await expect(loadCapabilityCorpus({ ...paths, development: join(dirname(v2SealedPayload), 'missing.json') }))
        .rejects.toThrow(v2SealedPathError);
    });
  });

  it('rejects aliases to v2 release files and directories before reading any v1 input', async () => {
    await withCorpus(async paths => {
      const fileAlias = join(dirname(paths.manifest), 'file-alias.json');
      const directoryAlias = join(dirname(paths.manifest), 'directory-alias');
      await symlink(v2SealedPayload, fileAlias, 'file');
      await symlink(dirname(v2SealedPayload), directoryAlias, 'dir');
      await writeFile(paths.manifest, 'Malformed v1 manifest sentinel.');
      await expect(loadCapabilityCorpus({ ...paths, development: fileAlias })).rejects.toThrow(v2SealedPathError);
      await expect(loadCapabilityCorpus({ ...paths, sealed: join(directoryAlias, 'payload.json') })).rejects.toThrow(v2SealedPathError);
    });
  });

  it('checks raw bytes before parsing and does not include malformed sealed text in errors', async () => {
    await withCorpus(async (paths, manifest) => {
      const secret = 'PRIVATE-SENTINEL';
      await writeFile(paths.sealed, secret);
      await expect(loadCapabilityCorpus(paths)).rejects.toThrow('SHA-256 mismatch for the capability sealed file.');
      manifest.sealed.sha256 = createHash('sha256').update(secret).digest('hex');
      await writeFile(paths.manifest, JSON.stringify(manifest));
      await expect(loadCapabilityCorpus(paths)).rejects.toThrow(/^The capability sealed file is not valid UTF-8 JSON\.$/u);
    });
  });

  it('requires the manifest to declare a balanced corpus and 20% per-language holdout', async () => {
    await withCorpus(async (paths, manifest) => {
      manifest.development.arabicCount -= 1;
      manifest.sealed.arabicCount += 1;
      await writeFile(paths.manifest, JSON.stringify(manifest));
      await expect(loadCapabilityCorpus(paths)).rejects.toThrow('20% sealed in each language');
    });
  });

  it('checks the parsed row counts against valid manifest declarations', async () => {
    await withCorpus(async ({ sealed: _sealed, ...paths }, manifest) => {
      manifest.development.caseCount += 8;
      manifest.development.arabicCount += 4;
      manifest.sealed.caseCount += 2;
      manifest.sealed.arabicCount += 1;
      await writeFile(paths.manifest, JSON.stringify(manifest));
      await expect(loadCapabilityCorpus(paths)).rejects.toThrow('Case counts do not match the capability development declaration.');
    });
  });

  it('rejects duplicate IDs and equivalent input across partitions', async () => {
    await withCorpus(async paths => {
      await expect(loadCapabilityCorpus(paths)).rejects.toThrow('Duplicate capability case ID.');
    }, (development, sealed) => { sealed[0]!.id = development[0]!.id; });
    await withCorpus(async paths => {
      await expect(loadCapabilityCorpus(paths)).rejects.toThrow('Duplicate normalized capability case input.');
    }, (development, sealed) => { sealed[0]!.turns[0]!.text = `  ${development[0]!.turns[0]!.text.toUpperCase()}\n`; });
  });

  it('requires the development split to cover every area and wording variety', async () => {
    await withCorpus(async ({ sealed: _sealed, ...paths }) => {
      await expect(loadCapabilityCorpus(paths)).rejects.toThrow('Missing development coverage for: coding, egyptian, iraqi.');
    }, development => {
      for (const item of development) {
        if (item.area === 'coding') item.area = 'comparison';
        if (item.variety === 'egyptian' || item.variety === 'iraqi') item.variety = 'msa';
      }
    });
  });
});

describe('capability case expectations', () => {
  it('requires an observed routing or tool choice, forbids contradictory tools, and accepts explicit empty answer assertions', () => {
    expect(capabilityExpectationSchema.safeParse(structuralExpectation).success).toBe(true);
    expect(capabilityExpectationSchema.safeParse({ ...structuralExpectation, route: undefined, requiredTools: [] }).success).toBe(false);
    expect(capabilityExpectationSchema.safeParse({ ...structuralExpectation, requiredTools: ['search'], forbiddenTools: ['search'] }).success).toBe(false);
    expect(capabilityExpectationSchema.safeParse({ ...structuralExpectation, requiredContent: undefined }).success).toBe(false);
  });

  it('strictly checks numeric expectation literals', () => {
    const numeric = (value: string) => capabilityExpectationSchema.safeParse({
      ...structuralExpectation, requiredContent: [{ match: 'number', anyOf: [value] }],
    }).success;
    expect(numeric('-١٢٫٥')).toBe(true);
    expect(numeric('x12')).toBe(false);
  });

  it('requires the declared language variety and exactly one question for clarification cases', () => {
    const [item] = structuralRows('d', 2);
    expect(capabilityCaseSchema.safeParse({ ...item, variety: 'english' }).success).toBe(false);
    expect(capabilityCaseSchema.safeParse({ ...item, variety: 'iraqi' }).success).toBe(true);
    expect(capabilityCaseSchema.safeParse({ ...item, language: 'en', variety: 'iraqi' }).success).toBe(false);
    expect(capabilityCaseSchema.safeParse({ ...item, area: 'clarification' }).success).toBe(false);
    expect(capabilityCaseSchema.safeParse({
      ...item, turns: [{ ...item!.turns[0], approve: false, text: '' }],
    }).success).toBe(false);
  });
});
