import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SkillContractSchema } from '@mohassan/contracts';
import { BENCHMARK_ASCII, BENCHMARK_BEFORE, BENCHMARK_UNICODE, selectSkillBenchmarkSuite, trustedSkillBenchmarkTrainingContext } from './benchmark-suites.ts';

describe('trusted generation training projection', () => {
  it.each(['instruction', 'file-read', 'file-write'])('exposes bounded training metadata for %s without any holdout identity, hash, input or oracle', async folder => {
    const contract = SkillContractSchema.parse(JSON.parse(await readFile(new URL(`../../../tests/fixtures/skills/benchmarks/${folder}/skill.contract.json`, import.meta.url), 'utf8')));
    const suite = selectSkillBenchmarkSuite(contract)!, training = trustedSkillBenchmarkTrainingContext(contract), text = JSON.stringify(training);
    expect(training.supported).toBe(true); if (!training.supported) throw new Error('Expected a supported fixture');
    expect(training.trainingOnly).toBe(true); expect(training.trainingCases).toEqual(suite.cases.filter(item => item.split === 'training').map(({ id, proofKind }) => ({ id, proofKind })));
    expect(Buffer.byteLength(text)).toBeLessThan(2048);
    for (const item of suite.cases.filter(item => item.split === 'holdout')) expect(text).not.toContain(item.id);
    for (const hidden of [suite.suiteHash, suite.configHash, ...suite.cases.map(item => item.fixtureHash), BENCHMARK_ASCII, BENCHMARK_UNICODE, BENCHMARK_BEFORE]) expect(text).not.toContain(JSON.stringify(hidden).slice(1, -1));
    expect(Object.keys(training).sort()).toEqual(['constraints', 'measuredScope', 'scope', 'supported', 'trainingCases', 'trainingOnly']);
  });
  it('reports unsupported explicitly instead of inventing a training suite', () => {
    const contract = SkillContractSchema.parse({ slug: 'unsupported-browser-guidance', name: 'Unsupported browser guidance', description: 'This contract deliberately requires browser authority outside the local suite.', category: 'browser', version: '1.0.0', level: 'instruction', requires: { tools: ['browser.open'] } });
    expect(trustedSkillBenchmarkTrainingContext(contract)).toEqual({ supported: false, reasonCode: 'FORGE_TRAINING_UNSUPPORTED' });
  });
});
