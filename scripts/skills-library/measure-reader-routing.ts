/**
 * Measures the model-free chat skill reader and its ranked candidate window against unchanged frozen labels.
 * Run from a checkout with dependencies installed. Historical inputs can live outside the checkout.
 *
 *   node --import tsx scripts/skills-library/measure-reader-routing.ts --library <skills-dir> --set pilot
 *   node --import tsx scripts/skills-library/measure-reader-routing.ts --library <skills-dir> --set historical --artifacts <artifacts-dir>
 *   node --import tsx scripts/skills-library/measure-reader-routing.ts --library <skills-dir> --set campaign-fixtures --mode fallback
 *   node --import tsx scripts/skills-library/measure-reader-routing.ts --set reader-fixtures
 *
 * Advice mode matches the existing offline reader evaluation. Use --mode fallback to exercise that chat reader mode as well.
 * The campaign fixtures are a separate unit-test probe. Use --checkout to load the reader and data from another local worktree.
 * Pilot guard counts require abstention or an explicitly allowed skill for top-1, and only allowed candidates for top-3.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { SkillReaderCandidate } from '../../apps/server/src/assistant/skill-reader.ts';

const ROOT = resolve(import.meta.dirname, '../..');

// Pilot freezes: https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/skills-pilot/tests/FREEZE.md
// Expansion and real freezes, plus pilot slug aliases: https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/scripts/skills-library/measure-reader.ts
// Retrieved 2026-11-27.
const PILOT_FILES = [
  ['skills-pilot/tests/heldout.json', '883381fb96734fcd5e71dd5f7af737862df2ad90f55c1d8e93c12baec49b6e1c'],
  ['skills-pilot/tests/heldout-2.json', '83056176319a5b303eb4ae06e6ed615710e92d8ca77f39221953cfccf9051200'],
  ['skills-pilot/tests/heldout-3.json', '53ffefcc3a76eb8d8df973b18c5ce28bba4c6c4d85021b3627cc0b79445a9298'],
] as const;
const PILOT_DEVELOPMENT = ['skills-pilot/tests/cases.json', '4c272ed0daa0e3f8652593f339cce9f4c0b377c798d2c42f8963cfe4c0eecacb'] as const;
const EXPANSION_FILES = [
  ['skills-library-2026-11-24/cases-heldout.json', 'e7b9274d99d6a4ee57aee773d1f706eaf0585b82b90f0b2fd3ad0b0a89aa51cb'],
  ['skills-library-2026-11-24/cases-heldout-2.json', '2779dcdac915c60e9802edec956ed5f2d752d8563d0c3054c6749116e4ce4f9c'],
] as const;
const REAL_LABELS = ['skills-library-2026-11-22/real-labels-v1.json', 'edc11ac36a438cc803c8affb9cc74d61eafddf298a60361754d19dd63e5750ce'] as const;
const REAL_REQUESTS = ['plan-2026-11-22/real-questions-v1.jsonl', '90fb3590e5bc3b767ed8aca41ee1a57b503f9570022fb626169bec6c1b127bf5'] as const;
// Campaign positives: https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/tests/assistant-campaign-request.test.ts#L12-L31
// Library fallback and bundled Ads skill: https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/docs/SKILLS-LIBRARY-EXPANSION-2026-11-24.md#L159-L166
// Retrieved 2026-11-27. The checksum pins the complete source fixture before extracting its English positives.
const CAMPAIGN_FIXTURE = ['tests/assistant-campaign-request.test.ts', '82c79ffb69d3ef96bc1f9da10aeb70b3643faacfbd9c232a3fd99cd564afa677'] as const;
// Raw-ranker fixtures: https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/tests/skill-reader.test.ts#L217-L313
// Retrieved 2026-11-27.
const READER_FIXTURE = ['tests/skill-reader.test.ts', '3e3724cd6138a36b6d75ae72903481785b72f6e5b4733e13d3c34e5ca31ca127'] as const;
const RENAMED: Readonly<Record<string, string>> = {
  'request-code-review': 'code-review-prep',
  'product-launch-plan': 'product-launch',
  'writing-mohassan-skills': 'skill-authoring',
};
const ARABIC = /\p{Script=Arabic}/u;

type FrozenFile = readonly [path: string, sha256: string];
interface FrozenCases {
  positive: { request: string; skill: string }[];
  unrelated?: string[];
  ambiguous?: string[];
  unavailableTool?: { request: string; allow: string[] }[];
  neighbours?: { request: string; expect: string[] }[];
  storedFacts?: string[];
}
interface RealRequest { id: string; text: string }
interface RealLabel { need: boolean; ok: string[] }
interface LabelledRequest { request: string; expected: string[] }
type CaseGroups = Record<string, LabelledRequest[]>;
type EvaluationSet = 'pilot' | 'historical' | 'campaign-fixtures' | 'reader-fixtures';
interface Counts { total: number; top1: number; top3: number }

function checkoutImport<T>(checkout: string, path: string): Promise<T> {
  return import(pathToFileURL(join(checkout, path)).href) as Promise<T>;
}

async function loadFrozenFiles(root: string, files: readonly FrozenFile[]): Promise<Map<string, string>> {
  const results = await Promise.allSettled(files.map(async ([path, sha256]) => {
    const data = await readFile(join(root, path));
    if (createHash('sha256').update(data).digest('hex') !== sha256) {
      throw new Error(`Frozen checksum mismatch: ${join(root, path)}`);
    }
    return [path, data.toString('utf8')] as const;
  }));
  const entries = new Map<string, string>();
  const errors: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') entries.set(...result.value);
    else errors.push(String(result.reason));
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return entries;
}

async function loadCatalogue(checkout: string, library: string, withBuiltins: boolean) {
  const [{ builtinSkills }, { parseSkillManifest }, { skillContentHash }, { buildSkillSource }, { inspectSkill }] = await Promise.all([
    checkoutImport<typeof import('../../packages/skills/src/builtin/index.ts')>(checkout, 'packages/skills/src/builtin/index.ts'),
    checkoutImport<typeof import('../../packages/skills/src/frontmatter.ts')>(checkout, 'packages/skills/src/frontmatter.ts'),
    checkoutImport<typeof import('../../packages/skills/src/hash.ts')>(checkout, 'packages/skills/src/hash.ts'),
    checkoutImport<typeof import('../../packages/skills/src/importer.ts')>(checkout, 'packages/skills/src/importer.ts'),
    checkoutImport<typeof import('../../packages/skills/src/inspector.ts')>(checkout, 'packages/skills/src/inspector.ts'),
  ]);
  const candidates: SkillReaderCandidate[] = [];
  const bodies = new Map<string, string>();
  for (const directory of (await readdir(library, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const slug = directory.name;
    const text = await readFile(join(library, slug, 'SKILL.md'), 'utf8');
    const { contract, files } = buildSkillSource(
      [{ path: 'SKILL.md', content: text }], { root: `github:owner/skills@local:skills/${slug}`, defaultSlug: slug },
    );
    const inspection = inspectSkill(contract, files);
    if (inspection.verdict !== 'pass' || inspection.findings.length) continue;
    const { name, description, category, version } = contract;
    candidates.push({ id: slug, slug, name, description, category, version, contentHash: skillContentHash(contract, files) });
    bodies.set(slug, parseSkillManifest(text).body);
  }
  if (withBuiltins) for (const { contract, instructions } of builtinSkills) {
    const { slug, name, description, category, version } = contract;
    if (bodies.has(slug)) continue;
    const files = [{ path: 'SKILL.md', content: instructions }];
    candidates.push({ id: slug, slug, name, description, category, version, contentHash: skillContentHash(contract, files) });
    bodies.set(slug, instructions);
  }
  if (!candidates.length) throw new Error(`No active instruction skills found at ${library}`);
  return { candidates, bodies };
}

const currentSlug = (slug: string) => RENAMED[slug] ?? slug;
const positiveRows = (cases: FrozenCases): LabelledRequest[] => cases.positive.map(({ request, skill }) => ({
  request, expected: [currentSlug(skill)],
}));

// Exact allowances and the abstention policy are from the existing evaluator (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/scripts/skills-library/measure-reader.ts#L212-L225
// Score against explicit allowances rather than an original-100 catalogue membership list from private data.
function guardRows(cases: FrozenCases): CaseGroups {
  const abstain = (requests: string[] | undefined): LabelledRequest[] => (requests ?? []).map(request => ({ request, expected: [] }));
  return {
    unrelated: abstain(cases.unrelated),
    ambiguous: abstain(cases.ambiguous),
    storedFacts: abstain(cases.storedFacts),
    unavailableTool: (cases.unavailableTool ?? []).map(({ request, allow }) => ({ request, expected: allow.map(currentSlug) })),
    neighbours: (cases.neighbours ?? []).map(({ request, expect }) => ({ request, expected: expect.map(currentSlug) })),
  };
}

async function loadCases(checkout: string, set: EvaluationSet, artifacts: string, withBuiltins: boolean): Promise<{
  ranked: CaseGroups; guards: CaseGroups;
}> {
  if (set === 'reader-fixtures') {
    const input = await loadFrozenFiles(checkout, [READER_FIXTURE]);
    const source = input.get(READER_FIXTURE[0])!;
    const fixture = (name: string) => {
      const block = source.match(new RegExp(`^const ${name}(?::[^=]+)? = \\[([\\s\\S]+?)\\];`, 'mu'))?.[1];
      if (!block) throw new Error(`Reader fixture ${name} was not found`);
      return block;
    };
    const ranked: CaseGroups = {}, guards: CaseGroups = {};
    for (const name of ['DEVELOPMENT', 'HELD_OUT']) {
      ranked[name] = [...fixture(name).matchAll(/\['([^']+)', '([^']+)'\]/gu)].map(([, request, slug]) => ({ request, expected: [slug] }));
      guards[name] = [...fixture(`NEGATIVE_${name}`).matchAll(/'([^']+)'/gu)].map(([, request]) => ({ request, expected: [] }));
    }
    return { ranked, guards };
  }
  if (set === 'campaign-fixtures') {
    const input = await loadFrozenFiles(checkout, [CAMPAIGN_FIXTURE]);
    const positives = input.get(CAMPAIGN_FIXTURE[0])!.split('it.each([', 2)[1]?.split('])', 1)[0];
    if (!positives) throw new Error('Campaign positive fixtures were not found');
    const expected = [withBuiltins ? 'google-ads-campaign' : 'copywriting'];
    const requests = [...positives.matchAll(/^\s*'([^']+)',/gmu)].map(([, request]) => request);
    return { ranked: { campaignFixtures: requests.filter(request => !ARABIC.test(request)).map(request => ({ request, expected })) }, guards: {} };
  }

  const heldoutFiles = set === 'pilot' ? PILOT_FILES : EXPANSION_FILES;
  const caseFiles = set === 'pilot' ? [...heldoutFiles, PILOT_DEVELOPMENT] : heldoutFiles;
  const input = await loadFrozenFiles(set === 'pilot' ? checkout : artifacts, set === 'pilot' ? caseFiles : [...caseFiles, REAL_LABELS, REAL_REQUESTS]);
  const parse = (path: string) => JSON.parse(input.get(path)!) as FrozenCases;
  const ranked = Object.fromEntries(caseFiles.map(([path]) => [path, positiveRows(parse(path))]));
  ranked.heldout = heldoutFiles.flatMap(([path]) => ranked[path]);
  const guards: CaseGroups = {};
  for (const [path] of caseFiles) {
    const kinds = guardRows(parse(path));
    guards[path] = Object.values(kinds).flat();
    for (const [kind, rows] of Object.entries(kinds)) (guards[kind] ??= []).push(...rows);
  }
  guards.all = caseFiles.flatMap(([path]) => guards[path]);
  if (set === 'historical') {
    const { labels } = JSON.parse(input.get(REAL_LABELS[0])!) as { labels: Record<string, RealLabel> | [string, RealLabel][] };
    const labelOf = new Map(Array.isArray(labels) ? labels : Object.entries(labels));
    const requests = input.get(REAL_REQUESTS[0])!.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as RealRequest);
    const real = requests.flatMap(({ id, text }) => {
      const label = labelOf.get(id);
      return label?.need ? [{ request: text, expected: label.ok }] : [];
    });
    ranked.realSkillNeeded = real;
    guards.realNoSkillNeeded = requests.flatMap(({ id, text }) => {
      const label = labelOf.get(id);
      return label && !label.need ? [{ request: text, expected: label.ok }] : [];
    });
    // Copywriting is used for other requests too. Use the explicit frozen Google Ads label to define the cohort.
    ranked.realEnglishAds = real.filter(row => !ARABIC.test(row.request) && row.expected.includes('google-ads-campaign'));
  }
  return { ranked, guards };
}

async function main() {
  const { values } = parseArgs({ options: {
    library: { type: 'string' },
    set: { type: 'string', default: 'historical' },
    checkout: { type: 'string', default: ROOT },
    artifacts: { type: 'string' },
    mode: { type: 'string', default: 'advice' },
    'with-builtins': { type: 'boolean', default: false },
  } });
  const { library, set, mode, 'with-builtins': withBuiltins } = values;
  if ((set !== 'pilot' && set !== 'historical' && set !== 'campaign-fixtures' && set !== 'reader-fixtures') || (mode !== 'advice' && mode !== 'fallback')) {
    throw new Error('Use --set pilot|historical|campaign-fixtures|reader-fixtures [--library <path>] [--checkout <path>] [--artifacts <path>] [--mode advice|fallback] [--with-builtins]');
  }
  const rawRankOnly = set === 'reader-fixtures';
  if (rawRankOnly ? library || withBuiltins : !library) throw new Error('Pass --library for catalogue runs. Reader fixtures use the checked-in skills.');
  const checkout = resolve(values.checkout);
  const { ranked, guards } = await loadCases(checkout, set, resolve(values.artifacts ?? join(checkout, 'artifacts')), withBuiltins);
  const { candidates, bodies } = await loadCatalogue(checkout, library ? resolve(library) : join(checkout, 'skills'), withBuiltins);
  const { buildSkillReaderIndex, createSkillReader, matchSkills, skillReadable } = await checkoutImport<
    typeof import('../../apps/server/src/assistant/skill-reader.ts')
  >(checkout, 'apps/server/src/assistant/skill-reader.ts');
  const index = buildSkillReaderIndex(candidates);
  const reader = createSkillReader({
    candidates: async () => candidates,
    index: async () => index,
    instructions: async (_owner, id) => bodies.get(id) ?? null,
  });
  const readerMode = mode;
  const emptyCounts = (): Counts => ({ total: 0, top1: 0, top3: 0 });
  async function summarize(groups: CaseGroups, guard: boolean) {
    const summary: Record<string, Record<'overall' | 'Arabic' | 'English', Counts>> = {};
    for (const [name, requests] of Object.entries(groups)) {
      const counts = { overall: emptyCounts(), Arabic: emptyCounts(), English: emptyCounts() };
      for (const { request, expected } of requests) {
        const window = rawRankOnly || skillReadable(request, readerMode)
          ? matchSkills(request, candidates, rawRankOnly ? undefined : index).slice(0, 3)
          : [];
        const chosen = rawRankOnly ? window[0] : await reader('measure-reader-owner', request, { mode: readerMode });
        const matches = ({ skill }: { skill: SkillReaderCandidate }) => expected.includes(skill.slug);
        const top1 = chosen ? matches(chosen) : guard;
        const top3 = guard ? window.every(matches) : window.some(matches);
        for (const counter of [counts.overall, counts[ARABIC.test(request) ? 'Arabic' : 'English']]) {
          counter.total++;
          counter.top1 += Number(top1);
          counter.top3 += Number(top3);
        }
      }
      summary[name] = counts;
    }
    return summary;
  }
  const summaries = await summarize(ranked, false);
  const guardSummaries = await summarize(guards, true);
  console.log(JSON.stringify({ set, mode, withBuiltins, candidates: candidates.length, summaries, guardSummaries }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
