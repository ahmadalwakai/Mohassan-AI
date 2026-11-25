import { readFileSync, writeFileSync } from 'node:fs';

const [baseV1, baseV2, afterV1, afterV2, output] = process.argv.slice(2);
if (!baseV1 || !baseV2 || !afterV1 || !afterV2 || !output) {
  throw new Error('Usage: node scripts/arbiter-bench/report.mjs BASE_V1 BASE_V2 AFTER_V1 AFTER_V2 NEW_OUTPUT');
}

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const signatures = score => JSON.stringify([score.passed, score.failures]);
const compareGroups = (before, after) => {
  if (Object.keys(before).sort().join() !== Object.keys(after).sort().join()) {
    throw new Error('Development receipts cover different groups.');
  }
  return Object.fromEntries(Object.entries(before).map(([group, base]) => {
    const next = after[group];
    if (base.total !== next.total) throw new Error('Development group case counts differ.');
    return [group, { base: base.passed, after: next.passed, total: base.total, delta: next.passed - base.passed }];
  }));
};

function oracle(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? { sites: 0, attempts: 0, applied: 0, unstable: 0, cases: new Map() };
    groups.set(key, group);
    group.sites++;
    group.attempts += row.input.claimants.length;
    group.applied += Object.keys(row.outcomes).length;
    const repeatedPrecedence = row.outcomes[row.input.precedence];
    const stable = repeatedPrecedence === row.baselinePassed;
    group.unstable += Number(repeatedPrecedence !== undefined && !stable);
    const passes = Object.entries(row.outcomes).some(([component, passed]) => component !== row.input.precedence && passed);
    const current = group.cases.get(row.caseId) ?? { baseline: row.baselinePassed, anyAlternativePassed: false, gain: false };
    current.anyAlternativePassed ||= passes;
    current.gain ||= stable && passes;
    group.cases.set(row.caseId, current);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, { cases, ...group }]) => {
      const records = [...cases.values()];
      return [key, { ...group, contestedCases: cases.size, basePasses: records.filter(row => row.baseline).length,
        oracleGains: records.filter(row => !row.baseline && row.anyAlternativePassed).length,
        gainsWithStablePrecedence: records.filter(row => !row.baseline && row.gain).length }];
    }));
}

const splits = {};
const development = { before: [], after: [] };
let holdsAllGroups = true;
for (const [split, baseFile, afterFile, expected] of [['v1-development', baseV1, afterV1, 240],
  ['v2-development', baseV2, afterV2, 2400]]) {
  const before = read(baseFile);
  const after = read(afterFile);
  if (before.mode !== 'base' || !['shadow', 'replay'].includes(after.mode)
      || before.source.lockfileSha256 !== after.source.lockfileSha256
      || before.scores.length !== expected || after.scores.length !== expected) {
    throw new Error(`Unexpected receipt identity for ${split}.`);
  }
  const changed = [];
  const exactChanged = [];
  for (const [index, base] of before.scores.entries()) {
    const next = after.scores[index];
    if (base.id !== next.id || base.area !== next.area || base.language !== next.language) {
      throw new Error(`Development case order or metadata differs for ${split}.`);
    }
    if (base.passed !== next.passed) changed.push({ caseId: base.id, area: base.area, language: base.language,
      before: base.passed, after: next.passed });
    if (signatures(base) !== signatures(next)) exactChanged.push(base.id);
    development.before.push({ split, caseId: base.id, area: base.area, language: base.language, passed: base.passed });
    development.after.push({ split, caseId: next.id, area: next.area, language: next.language, passed: next.passed });
  }
  const paired = {
    overall: compareGroups({ all: before.summary.overall }, { all: after.summary.overall }).all,
    byArea: compareGroups(before.summary.byArea, after.summary.byArea),
    byLanguage: compareGroups(before.summary.byLanguage, after.summary.byLanguage),
  };
  holdsAllGroups &&= [...Object.values(paired.byArea), ...Object.values(paired.byLanguage)].every(group => group.delta >= 0);
  const eligible = after.rows;
  const predictions = eligible.filter(({ input, observedProposed }) => observedProposed !== input.precedence);
  splits[split] = { baseCommit: before.source.commit, afterCommit: after.source.commit, paired, changed, exactChanged,
    filter: after.filter, protectedDecisions: after.protectedDecisions.length, unforcedTrials: after.unsupported.length,
    wouldChange: predictions.length, scoredChangedChoices: predictions.filter(row => Object.hasOwn(row.outcomes, row.observedProposed)).length,
    arbitrationTiming: after.arbitrationTiming,
    oracle: after.mode === 'replay' ? {
      all: oracle(eligible, () => 'all').all ?? null,
      byType: oracle(eligible, row => row.type),
      byArea: oracle(eligible, row => row.area),
      byLanguage: oracle(eligible, row => row.language),
    } : null };
}

writeFileSync(output, JSON.stringify({ holdsAllGroups, splits, development }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ holdsAllGroups, splits }, null, 2));
if (!holdsAllGroups) process.exitCode = 1;
