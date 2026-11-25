import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CapabilityCase } from '../scripts/agent-capability-bench/corpus.js';
import { loadDevelopmentCapabilityCorpus } from '../scripts/agent-capability-bench/v2/dev.js';
import { loadSealedCapabilityCorpus } from '../scripts/agent-capability-bench/v2/sealed.js';
import { sha256 } from '../scripts/agent-capability-bench/v2/sources.js';
import { wikiAttribution } from '../scripts/agent-capability-bench/v2/wiki-attribution.js';

const fixtures = fileURLToPath(new URL('./fixtures/agent-capability-bench/v2', import.meta.url));
const devPath = join(fixtures, 'dev');
const sealedPaths = {
  manifest: fileURLToPath(new URL('../scripts/agent-capability-bench/v2/manifest.json', import.meta.url)),
  sealed: join(fixtures, 'sealed', 'payload.json'),
};

function turnTexts(cases: readonly CapabilityCase[]): Set<string> {
  const texts = new Set<string>();
  for (const { turns } of cases) {
    for (const { text } of turns) {
      const normalized = text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
      if (normalized) texts.add(normalized);
    }
  }
  return texts;
}

describe('committed capability v2 development fixture', () => {
  let development: Awaited<ReturnType<typeof loadDevelopmentCapabilityCorpus>>;
  let sealed: Awaited<ReturnType<typeof loadSealedCapabilityCorpus>>;

  beforeAll(async () => {
    [development, sealed] = await Promise.all([loadDevelopmentCapabilityCorpus(devPath), loadSealedCapabilityCorpus(sealedPaths)]);
  });

  it('uses the same sources and areas as the pinned seal with zero source item or normalized turn text overlap', () => {
    const developmentSources = new Set(development.cases.map(item => item.provenance.source));
    const sealedSources = new Set(sealed.cases.map(item => item.provenance.source));
    const developmentTexts = turnTexts(development.cases);
    const sealedTexts = turnTexts(sealed.cases);
    const datasets = (sources: Set<string>) => new Set([...sources].map(source => source.split(':', 1)[0]));

    expect(developmentSources.size).toBe(development.cases.length);
    expect(datasets(developmentSources)).toEqual(datasets(sealedSources));
    expect(new Set(development.cases.map(item => item.area))).toEqual(new Set(sealed.cases.map(item => item.area)));
    // Keep assertions count-only so a failed disjointness check cannot expose sealed prompts or provenance.
    expect([...developmentSources].filter(source => sealedSources.has(source)).length).toBe(0);
    expect([...developmentTexts].filter(text => sealedTexts.has(text)).length).toBe(0);
  });

  it('pins the source attribution bundle and a separate 32-byte development seed', async () => {
    const [devSeed, sealedSeed, payload] = await Promise.all([
      readFile(join(devPath, 'sampling-v2-dev.seed')),
      readFile(join(fixtures, 'sealed', 'sampling-v2.seed')),
      readFile(join(devPath, 'payload.json'), 'utf8'),
    ]);
    const attributionFiles = (files: Record<string, string>) => Object.keys(files).filter(file => file.startsWith('attribution/')).sort();
    const files = attributionFiles(development.manifest.files);
    const articleIndex = 'attribution/wikipedia-articles.json';

    expect(files).toEqual(attributionFiles(sealed.manifest.files));
    for (const file of files) {
      if (file === 'attribution/ATTRIBUTION.md' || file === articleIndex) continue;
      expect(development.manifest.files[file]).toBe(sealed.manifest.files[file]);
    }
    expect(development.manifest.files[articleIndex]).toBe(sha256(wikiAttribution(payload)));
    expect(development.manifest.files['sampling-v2-dev.seed']).toBe(sha256(devSeed));

    expect(devSeed.byteLength).toBe(32);
    expect(devSeed.equals(sealedSeed)).toBe(false);
  });

  it('balances languages and reconciles each area’s admitted, selected and discarded counts', async () => {
    const accounting = JSON.parse(await readFile(join(devPath, 'accounting.json'), 'utf8')) as {
      areas: Record<string, { available: number; selected: number; discarded: Record<string, number> }>;
    };
    const selected = new Map<string, number>();
    for (const { area } of development.cases) selected.set(area, (selected.get(area) ?? 0) + 1);

    expect(development.manifest.development).toMatchObject({ caseCount: 2400, arabicCount: 1200 });
    expect(Object.keys(accounting.areas)).toEqual(expect.arrayContaining([...selected.keys()]));
    for (const [area, counts] of Object.entries(accounting.areas)) {
      const discarded = Object.values(counts.discarded).reduce((total, value) => total + value, 0);
      expect(counts.selected, area).toBe(selected.get(area) ?? 0);
      expect(counts.available, area).toBe(counts.selected + discarded);
    }
  });
});
