import { createHmac } from 'node:crypto';
import { capabilityBaselineCommit, capabilityCaseSchema, normalizeInput, type CapabilityCase } from '../corpus.js';
import { mappingVersion, type Candidate, type Dataset, type ImportResult } from './mapping.js';
import { sha256 } from './sources.js';

export interface Quota {
  dataset: Dataset;
  area: CapabilityCase['area'];
  language: CapabilityCase['language'];
  count: number;
  slice?: 'in-scope' | 'oos';
}

export function candidateStratum({ dataset, item, key }: Candidate): string {
  const stratum = `${dataset}/${item.area}/${item.language}`;
  return dataset === 'clinc150' && item.area === 'refusal' ? `${stratum}/${key.startsWith('oos_test:') ? 'oos' : 'in-scope'}` : stratum;
}
export const quotaStratum = ({ dataset, area, language, slice }: Quota) => [dataset, area, language, ...(slice ? [slice] : [])].join('/');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const encoded = (value: object) => JSON.stringify(value) + '\n';
const inputKey = ({ turns }: Pick<CapabilityCase, 'turns'>) => JSON.stringify(turns.map(turn => [normalizeInput(turn.text),
  Object.entries(turn.fields ?? {}).sort(([a], [b]) => compare(a, b)).map(([key, value]) => [key, normalizeInput(value)]),
  Boolean(turn.answerQuestion), turn.approve]));
export const familyKey = ({ dataset, family }: Candidate) => JSON.stringify([dataset, family]);

export function availableStrata(results: readonly ImportResult[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const { candidates } of results) {
    for (const item of candidates) {
      const stratum = candidateStratum(item);
      counts.set(stratum, (counts.get(stratum) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => compare(a, b)));
}

export function buildSealedSet(results: readonly ImportResult[], quotas: readonly Quota[], seed: Buffer,
  previousCases: readonly Pick<CapabilityCase, 'turns'>[] = []) {
  if (seed.length !== 32) throw new Error('The custodian seed must be exactly 32 random bytes.');
  const digest = (purpose: string, candidate: Candidate) => createHmac('sha256', seed)
    .update(JSON.stringify([mappingVersion, purpose, candidate.dataset, candidate.key])).digest('hex');
  const pools = new Map(quotas.map(quota => [quotaStratum(quota), {
    quota, selected: 0, offset: 0, rows: [] as { candidate: Candidate; rank: string }[],
  }]));
  if (pools.size !== quotas.length || quotas.some(({ count }) => !Number.isSafeInteger(count) || count < 1)) {
    throw new Error('The sampling policy contains an invalid quota.');
  }
  const previousInputs = new Set(previousCases.map(inputKey));
  const previousOverlap = new Map<string, number>();
  for (const { candidates } of results) {
    for (const candidate of candidates) {
      const name = candidateStratum(candidate);
      if (previousInputs.has(inputKey(candidate.item))) {
        previousOverlap.set(name, (previousOverlap.get(name) ?? 0) + 1);
      } else pools.get(name)?.rows.push({ candidate, rank: digest('rank', candidate) });
    }
  }
  for (const pool of pools.values()) pool.rows.sort((a, b) => compare(a.rank, b.rank));
  const selected: { item: CapabilityCase; order: string }[] = [];
  const observedInputs = new Set<string>();
  const observedFamilies = new Set<string>();
  const ids = new Set<string>();
  const groups = new Map<string, { area: CapabilityCase['area']; language: CapabilityCase['language']; count: number }>();
  const wanted = quotas.reduce((total, { count }) => total + count, 0);
  while (selected.length < wanted) {
    for (const [name, pool] of pools) {
      if (pool.selected === pool.quota.count) continue;
      let accepted = false;
      while (pool.offset < pool.rows.length) {
        const { candidate } = pool.rows[pool.offset++]!;
        const { dataset, item } = candidate;
        const family = familyKey(candidate), input = inputKey(item);
        if (observedFamilies.has(family) || observedInputs.has(input)) continue;
        const id = `human-${digest('id', candidate).slice(0, 24)}`;
        if (ids.has(id)) throw new Error('Duplicate opaque case ID.');
        const row = capabilityCaseSchema.safeParse({ id, ...item, provenance: { author: 'human', source: `${dataset}:${candidate.key}` } });
        if (!row.success) throw new Error(`Invalid mapped case in ${name}.`);
        ids.add(id);
        observedFamilies.add(family);
        observedInputs.add(input);
        selected.push({ item: row.data, order: digest('order', candidate) });
        const { area, language } = item;
        const groupKey = `${area}/${language}`;
        const group = groups.get(groupKey) ?? { area, language, count: 0 };
        group.count++;
        groups.set(groupKey, group);
        pool.selected++;
        accepted = true;
        break;
      }
      if (!accepted) throw new Error(`Could fill only ${pool.selected} of ${pool.quota.count} cases in ${name}.`);
    }
  }
  for (const [name, { rows }] of pools) {
    if (!rows.some(({ candidate }) => !observedFamilies.has(familyKey(candidate)) && !observedInputs.has(inputKey(candidate.item)))) {
      throw new Error(`No distinct unselected candidate remains in ${name}.`);
    }
  }
  const cases = selected.sort((a, b) => compare(a.order, b.order)).map(({ item }) => item);
  const payload = encoded({ schemaVersion: 2, mappingVersion, cases });
  const strata = [...groups.entries()].sort(([a], [b]) => compare(a, b)).map(([, group]) => group);
  const manifest = {
    schemaVersion: 2, baselineCommit: capabilityBaselineCommit, mappingVersion,
    sealed: { sha256: sha256(payload), caseCount: cases.length, arabicCount: cases.filter(item => item.language === 'ar').length },
    strata,
  };
  const available = availableStrata(results);
  const accounting = {
    mappingVersion, available, previousOverlap: Object.fromEntries([...previousOverlap].sort(([a], [b]) => compare(a, b))),
    selected: Object.fromEntries([...pools].map(([key, { selected: count }]) => [key, count])),
    sources: results.map(({ dataset, candidates, dropped, seen }) => ({ dataset, seen, admitted: candidates.length, dropped })),
  };
  return { payload, manifest: encoded(manifest), accounting: encoded(accounting) };
}
