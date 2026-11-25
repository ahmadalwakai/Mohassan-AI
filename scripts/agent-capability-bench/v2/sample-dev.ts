import { createHmac } from 'node:crypto';
import { capabilityBaselineCommit, capabilityCaseSchema, normalizeInput, type CapabilityCase } from '../corpus.js';
import { mappingVersion, type Candidate, type ImportResult } from './mapping.js';
import { candidateStratum, familyKey, quotaStratum, type Quota } from './sample.js';
import { sha256 } from './sources.js';

const encode = (value: object) => JSON.stringify(value) + '\n';
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const normalizedTurns = ({ turns }: Pick<CapabilityCase, 'turns'>) =>
  turns.map(turn => normalizeInput(turn.text)).filter(Boolean);
const areaLanguage = ({ area, language }: Pick<CapabilityCase, 'area' | 'language'>) => `${area}/${language}`;

function counts() {
  return {
    available: 0, target: 0, selected: 0,
    discarded: {
      sealedSourceId: 0, sealedText: 0, sealedFamily: 0, outsidePolicy: 0,
      developmentSourceId: 0, developmentText: 0, developmentFamily: 0, quota: 0,
    },
  };
}

type Counts = ReturnType<typeof counts>;
type Discard = keyof Counts['discarded'];
interface Row {
  candidate: Candidate;
  source: string;
  family: string;
  texts: string[];
  rank: string;
  outcome?: Discard | 'selected';
}

interface Pool {
  quota: Quota;
  rows: Row[];
  target: number;
  selected: number;
  offset: number;
}

interface Group {
  area: CapabilityCase['area'];
  language: CapabilityCase['language'];
  pools: Pool[];
  target: number;
  selected: number;
}

function leastFilled(left: { selected: number; target: number }, right: { selected: number; target: number }): number {
  return left.selected * right.target - right.selected * left.target;
}

function record<K>(entries: Map<K, Counts>, key: K): Counts {
  const current = entries.get(key);
  if (current) return current;
  const next = counts();
  entries.set(key, next);
  return next;
}

export function buildDevelopmentSet(results: readonly ImportResult[], targets: readonly Quota[], seed: Buffer,
  sealedCases: readonly Pick<CapabilityCase, 'provenance' | 'turns'>[]) {
  if (seed.length !== 32) throw new Error('The development seed must be exactly 32 bytes.');
  const digest = (purpose: string, { dataset, key }: Candidate) => createHmac('sha256', seed)
    .update(JSON.stringify([mappingVersion, 'development', purpose, dataset, key])).digest('hex');
  const pools = new Map(targets.map(quota => [quotaStratum(quota), {
    quota, rows: [], target: quota.count, selected: 0, offset: 0,
  } satisfies Pool] as [string, Pool]));
  if (!pools.size || pools.size !== targets.length || targets.some(({ count }) => !Number.isSafeInteger(count) || count < 1)) {
    throw new Error('The development sampling policy contains an invalid quota.');
  }
  const groups = new Map<string, Group>();
  const languageCounts = new Map<CapabilityCase['language'], { target: number; selected: number }>();
  const areas = new Map<CapabilityCase['area'], Counts>();
  const strata = new Map<string, Counts>();
  for (const [stratum, pool] of pools) {
    const { area, language, count } = pool.quota;
    const label = areaLanguage(pool.quota);
    const group = groups.get(label) ?? { area, language, pools: [], target: 0, selected: 0 };
    group.pools.push(pool);
    group.target += count;
    groups.set(label, group);
    const languageCount = languageCounts.get(language) ?? { target: 0, selected: 0 };
    languageCount.target += count;
    languageCounts.set(language, languageCount);
    record(areas, area).target += count;
    record(strata, stratum).target += count;
  }

  const rows: Row[] = results.flatMap(({ candidates }) => candidates.map(candidate => ({
    candidate, source: `${candidate.dataset}:${candidate.key}`, family: familyKey(candidate),
    texts: normalizedTurns(candidate.item), rank: digest('rank', candidate),
  })));
  const familiesBySource = new Map(rows.map(({ source, family }) => [source, family]));
  const sealedSources = new Set(sealedCases.map(({ provenance }) => provenance.source));
  const sealedTexts = new Set(sealedCases.flatMap(normalizedTurns));
  const sealedFamilies = new Set<string>();
  for (const source of sealedSources) {
    const family = familiesBySource.get(source);
    if (family === undefined) throw new Error('A sealed source item was absent from the mapped development inputs.');
    sealedFamilies.add(family);
  }

  for (const row of rows) {
    const pool = pools.get(candidateStratum(row.candidate));
    if (sealedSources.has(row.source)) row.outcome = 'sealedSourceId';
    else if (row.texts.some(text => sealedTexts.has(text))) row.outcome = 'sealedText';
    else if (sealedFamilies.has(row.family)) row.outcome = 'sealedFamily';
    else if (pool === undefined) row.outcome = 'outsidePolicy';
    else pool.rows.push(row);
  }
  for (const pool of pools.values()) pool.rows.sort((left, right) => compare(left.rank, right.rank));

  const sources = new Set<string>();
  const families = new Set<string>();
  const texts = new Set<string>();
  const selected: { item: CapabilityCase; order: string }[] = [];
  function distinctRow(pool: Pool): Row | undefined {
    while (pool.offset < pool.rows.length) {
      const row = pool.rows[pool.offset++]!;
      if (!sources.has(row.source) && !families.has(row.family) && !row.texts.some(text => texts.has(text))) {
        return row;
      }
    }
  }

  const wanted = targets.reduce((sum, { count }) => sum + count, 0);
  while (selected.length < wanted) {
    // Keep each language total fixed. A short group gives its slots to the least-filled
    // remaining group in its language, and sources within a group follow the same rule.
    const group = [...groups.values()].filter(({ language, pools }) =>
      languageCounts.get(language)!.selected < languageCounts.get(language)!.target
      && pools.some(pool => pool.offset < pool.rows.length)).sort(leastFilled)[0];
    if (!group) throw new Error('Could not fill the development language targets after excluding overlaps.');
    const pool = group.pools.filter(pool => pool.offset < pool.rows.length).sort(leastFilled)[0]!;
    const row = distinctRow(pool);
    if (!row) continue;
    const id = `human-${digest('id', row.candidate).slice(0, 24)}`;
    const parsed = capabilityCaseSchema.safeParse({
      id, ...row.candidate.item, provenance: { author: 'human', source: row.source },
    });
    if (!parsed.success) throw new Error(`Invalid mapped case in ${candidateStratum(row.candidate)}.`);
    row.outcome = 'selected';
    sources.add(row.source);
    families.add(row.family);
    for (const text of row.texts) texts.add(text);
    pool.selected++;
    group.selected++;
    languageCounts.get(group.language)!.selected++;
    selected.push({ item: parsed.data, order: digest('order', row.candidate) });
  }

  for (const row of rows) {
    const area = record(areas, row.candidate.item.area);
    const stratum = record(strata, candidateStratum(row.candidate));
    area.available++;
    stratum.available++;
    if (row.outcome === 'selected') {
      area.selected++;
      stratum.selected++;
    } else {
      const reason = row.outcome ?? (sources.has(row.source) ? 'developmentSourceId'
        : row.texts.some(text => texts.has(text)) ? 'developmentText'
        : families.has(row.family) ? 'developmentFamily' : 'quota');
      area.discarded[reason]++;
      stratum.discarded[reason]++;
    }
  }

  const cases = selected.sort((left, right) => compare(left.order, right.order)).map(({ item }) => item);
  if (new Set(cases.map(({ id }) => id)).size !== cases.length) throw new Error('Duplicate opaque case ID.');
  const payload = encode({ schemaVersion: 2, mappingVersion, cases });
  const manifest = encode({
    schemaVersion: 2, baselineCommit: capabilityBaselineCommit, mappingVersion,
    development: { sha256: sha256(payload), caseCount: cases.length, arabicCount: languageCounts.get('ar')?.selected ?? 0 },
    strata: [...groups.entries()].sort(([left], [right]) => compare(left, right)).flatMap(([, { area, language, selected }]) =>
      selected > 0 ? [{ area, language, count: selected }] : []),
  });
  const orderedCounts = (entries: Map<string, Counts>) =>
    Object.fromEntries([...entries].sort(([left], [right]) => compare(left, right)));
  const accounting = encode({
    mappingVersion, areas: orderedCounts(areas), strata: orderedCounts(strata),
    sources: results.map(({ dataset, seen, candidates, dropped }) => ({ dataset, seen, admitted: candidates.length, dropped })),
  });
  return { payload, manifest, accounting };
}
