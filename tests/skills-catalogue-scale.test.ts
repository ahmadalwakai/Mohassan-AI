import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { parseSkillManifest, routerIndex, sha256 } from '@mohassan/skills';
import { rankInstructionCandidates, skillTerms } from '../packages/skills/src/router.ts';
import { buildSkillReaderIndex, matchSkills, type SkillReaderCandidate } from '../apps/server/src/assistant/skill-reader.js';
import { syntheticCatalogue, SYNTHETIC_PREFIX } from './fixtures/skills/catalogue-scale.js';

/** The tracked repo skills plus synthetic fixture entries; the full 10,000-entry run is scripts/skills-catalogue/bench-scale.ts. */
async function catalogue(total: number) {
  const real: SkillReaderCandidate[] = [];
  for (const slug of (await readdir('skills')).sort()) {
    const { fields } = parseSkillManifest(await readFile(join('skills', slug, 'SKILL.md'), 'utf8'));
    real.push({ id: randomUUID(), slug, name: fields.name!, description: fields.description!, category: fields.category ?? 'reasoning', version: '1.0.0', contentHash: sha256(slug) });
  }
  const synthetic = syntheticCatalogue(total - real.length, real.map(skill => `${skill.name} ${skill.description}`));
  return { real, synthetic, all: [...real, ...synthetic].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)) };
}

describe('catalogue selection at scale (fixtures only)', () => {
  it('keeps synthetic entries recognisable and out of every production folder', async () => {
    const { synthetic } = await catalogue(500);
    expect(synthetic.every(entry => entry.slug.startsWith(SYNTHETIC_PREFIX))).toBe(true);
    for (const folder of ['skills', 'skills-pilot/skills']) {
      const names = await readdir(folder).catch(() => [] as string[]);
      expect(names.some(name => name.startsWith(SYNTHETIC_PREFIX))).toBe(false);
    }
  });
  it('shortlists exactly what a full router scan ranks, at 2,000 entries', async () => {
    const { all } = await catalogue(2000);
    const index = routerIndex(all as never);
    for (const goal of ['كيف أكتب خطة عمل لمشروع مقهى', 'write a cover letter for a job', 'محضر اجتماع بالقرارات والمهام', 'sql query for monthly sales']) {
      const full = rankInstructionCandidates(goal, all as never).map(skill => skill.id);
      const fast = rankInstructionCandidates(goal, index.shortlist(skillTerms(goal)).map(position => all[position]) as never).map(skill => skill.id);
      expect(fast).toEqual(full);
    }
  });
  it('reads every entry and answers within a few milliseconds per request at 2,000 entries', async () => {
    const { all, real } = await catalogue(2000);
    const target = real.find(skill => skill.slug === 'swot-analysis')!;
    const index = buildSkillReaderIndex(all);
    expect(index.size).toBe(2000);
    // The old window is the first 1,300 by slug; this target lies beyond it.
    expect(all.indexOf(target)).toBeGreaterThan(1300);
    expect(matchSkills('كيف أعمل تحليل SWOT لمشروعي: نقاط القوة والضعف والفرص والتهديدات', all).some(match => match.skill.id === target.id)).toBe(false);
    const durations: number[] = [];
    let found = false;
    for (let round = 0; round < 20; round++) {
      const started = performance.now();
      const matches = matchSkills('كيف أعمل تحليل SWOT لمشروعي: نقاط القوة والضعف والفرص والتهديدات', all, index);
      durations.push(performance.now() - started);
      found ||= matches.some(match => match.skill.id === target.id);
    }
    expect(found).toBe(true);
    expect(durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)]).toBeLessThan(50);
  });
});
