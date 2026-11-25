import { describe, expect, it } from 'vitest';
import { Mapping, type Candidate } from '../scripts/agent-capability-bench/v2/mapping.js';
import { availableStrata, buildSealedSet, type Quota } from '../scripts/agent-capability-bench/v2/sample.js';
import { sha256, verifiedBytes } from '../scripts/agent-capability-bench/v2/sources.js';

function item(text: string, language: 'ar' | 'en'): Candidate['item'] {
  return { area: 'small-talk', language, variety: language === 'ar' ? 'unspecified' : 'english',
    turns: [{ text, expect: { route: ['chat'], status: ['completed'], questionCount: 0, requiredContent: [], forbiddenContent: [], maxSteps: 0 } }] };
}

const seed = Buffer.alloc(32, 7);
const quotas: Quota[] = [
  { dataset: 'massive', area: 'small-talk', language: 'en', count: 2 },
  { dataset: 'massive', area: 'small-talk', language: 'ar', count: 2 },
];

function pool() {
  const mapping = new Mapping('massive');
  for (let index = 0; index < 20; index++) {
    mapping.accept(`english:${index}`, `${index}`, item(`Cue ${index}`, 'en'));
    mapping.accept(`arabic:${index}`, `${index}`, item(`نص ${index}`, 'ar'));
  }
  mapping.drop('no-faithful-mapping');
  return mapping.result();
}

describe('capability v2 reproducible sealing', () => {
  it('pins byte-identical results, excludes v1 inputs and deduplicates source families across languages', () => {
    const result = pool();
    const previous = [item('  CUE   7 ', 'en')];
    const first = buildSealedSet([result], quotas, seed, previous);
    const second = buildSealedSet([{ ...result, candidates: [...result.candidates].reverse() }], quotas, seed, previous);
    expect(second).toEqual(first);
    const { cases } = JSON.parse(first.payload);
    const keys = cases.map((entry: { provenance: { source: string } }) => entry.provenance.source.split(':').at(-1));
    expect(new Set(keys).size).toBe(4);
    expect(cases.some((entry: { turns: { text: string }[] }) => entry.turns[0]!.text === 'Cue 7')).toBe(false);
    expect(JSON.parse(first.manifest)).toMatchObject({ sealed: { sha256: sha256(first.payload), caseCount: 4, arabicCount: 2 } });
    expect(JSON.parse(first.accounting)).toMatchObject({ previousOverlap: { 'massive/small-talk/en': 1 },
      sources: [{ dataset: 'massive', seen: 41, admitted: 40, dropped: { 'no-faithful-mapping': 1 } }] });
    expect(availableStrata([result])).toEqual({ 'massive/small-talk/ar': 20, 'massive/small-talk/en': 20 });
    expect(buildSealedSet([result], quotas, Buffer.alloc(32, 8), previous).payload).not.toBe(first.payload);
  });

  it('requires surplus eligible candidates and valid quotas and seed', () => {
    const result = pool();
    expect(() => buildSealedSet([result], [{ ...quotas[0]!, count: 20 }], seed)).toThrow('No distinct unselected candidate');
    expect(() => buildSealedSet([result], [{ ...quotas[0]!, count: 21 }], seed)).toThrow('Could fill only 20 of 21');
    expect(() => buildSealedSet([result], [quotas[0]!, quotas[0]!], seed)).toThrow('invalid quota');
    expect(() => buildSealedSet([result], quotas, Buffer.alloc(1))).toThrow('exactly 32');
  });

  it('fails closed if a cached public artifact is changed', () => {
    const raw = Buffer.from('test-only bytes\n');
    expect(verifiedBytes('artifact', raw, sha256(raw))).toBe(raw);
    expect(() => verifiedBytes('artifact', Buffer.from('test-only bytes'), sha256(raw))).toThrow('SHA-256 mismatch for artifact');
  });
});
