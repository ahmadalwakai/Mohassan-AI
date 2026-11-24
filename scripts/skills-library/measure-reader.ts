/**
 * Measures the chat's model-free skill reader on the skills a GitHub sync would activate, in memory.
 *
 * The same parser (buildSkillSource), inspector (inspectSkill) and reader (createSkillReader on the catalogue-index
 * path, mode `advice`) as the server. A skill with any inspector finding is left out, as the sync would not activate it.
 * No database, no network, no model, so it is light enough to run next to a training job.
 *
 *   npx tsx scripts/skills-library/measure-reader.ts [--library <skills dir>] [--out <file.json>] [--compare <before.json>]
 *
 * Sets (each file's sha256 is printed; the frozen ones are checked against the hashes below):
 *   - artifacts/skills-library-2026-11-22: the library's agent questions (dev and sealed), its none-dev set and the real questions;
 *   - skills-pilot/tests: the pilot's cases and its three held-out sets;
 *   - artifacts/skills-library-2026-11-24: the expansion's own development and held-out sets, when present.
 * "Added" skills are those outside the original 100 (the skills named by the library's agent questions): only an added skill
 * that takes a request it does not own counts against the expansion.
 *
 * `--compare` prints every request whose chosen skill differs from an earlier run, so each change can be read.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildSkillReaderIndex, createSkillReader, matchSkills, skillReadable, skillStems, type SkillReaderCandidate } from '../../apps/server/src/assistant/skill-reader.ts';
import { buildSkillSource } from '../../packages/skills/src/importer.ts';
import { inspectSkill } from '../../packages/skills/src/inspector.ts';
import { parseSkillManifest } from '../../packages/skills/src/frontmatter.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const arg = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] ?? null : null; };
const LIBRARY = resolve(arg('--library') ?? join(ROOT, 'skills-library', 'skills'));
const OUT = arg('--out');
const COMPARE = arg('--compare');
const LIB_EVAL = join(ROOT, 'artifacts', 'skills-library-2026-11-22');
const PILOT_TESTS = join(ROOT, 'skills-pilot', 'tests');
const NEW_TESTS = join(ROOT, 'artifacts', 'skills-library-2026-11-24');
const FROZEN: Record<string, string> = {
  [join(LIB_EVAL, 'questions-agent-v1.jsonl')]: '8445fcb76fff14c507f548535cd44cf8373fac7550b9ee97d1ca8ebb8501f9a6',
  [join(LIB_EVAL, 'questions-agent-none-dev-v1.jsonl')]: '4c05faa7338ca3119a43becf53648b2de158d563e87f62c4ad3a0268a782a8eb',
  [join(LIB_EVAL, 'real-labels-v1.json')]: 'edc11ac36a438cc803c8affb9cc74d61eafddf298a60361754d19dd63e5750ce',
  [join(ROOT, 'artifacts', 'plan-2026-11-22', 'real-questions-v1.jsonl')]: '90fb3590e5bc3b767ed8aca41ee1a57b503f9570022fb626169bec6c1b127bf5',
  [join(PILOT_TESTS, 'cases.json')]: '4c272ed0daa0e3f8652593f339cce9f4c0b377c798d2c42f8963cfe4c0eecacb',
  [join(PILOT_TESTS, 'heldout.json')]: '883381fb96734fcd5e71dd5f7af737862df2ad90f55c1d8e93c12baec49b6e1c',
  [join(PILOT_TESTS, 'heldout-2.json')]: '83056176319a5b303eb4ae06e6ed615710e92d8ca77f39221953cfccf9051200',
  [join(PILOT_TESTS, 'heldout-3.json')]: '53ffefcc3a76eb8d8df973b18c5ce28bba4c6c4d85021b3627cc0b79445a9298',
  [join(NEW_TESTS, 'cases-heldout.json')]: 'e7b9274d99d6a4ee57aee773d1f706eaf0585b82b90f0b2fd3ad0b0a89aa51cb',
  [join(NEW_TESTS, 'cases-heldout-2.json')]: '2779dcdac915c60e9802edec956ed5f2d752d8563d0c3054c6749116e4ce4f9c',
};
const OWNER = 'measure-reader-owner';
/** Pilot skills renamed on their way into the library (their old id put a common word in the title): frozen sets keep the old id. */
const RENAMED: Record<string, string> = { 'request-code-review': 'code-review-prep', 'product-launch-plan': 'product-launch', 'writing-mohassan-skills': 'skill-authoring' };
const current = (slug: string) => RENAMED[slug] ?? slug;
/**
 * Requests whose frozen label predates a more specific added skill, read one by one on 2026-11-24 and judged an acceptable
 * choice (the label itself is never edited). Each counts as correct for that skill only.
 */
const REVIEWED_OK: Record<string, { skill: string; why: string }> = {
  'library-agent-dev/q008d': { skill: 'postgres-performance', why: 'a slow PostgreSQL query is exactly the skill\'s subject' },
  'library-agent-sealed/q009s': { skill: 'local-webapp-testing', why: 'an end-to-end test with Playwright is the skill\'s subject' },
  'library-agent-sealed/q044s': { skill: 'payment-reminder', why: 'a follow-up to a client who has not paid an invoice is the skill\'s subject' },
  'library-agent-sealed/q024s': { skill: 'distinctive-ui-design', why: 'improving an amateur-looking UI; before, no skill answered' },
  'library-agent-sealed/q058s': { skill: 'survey-questionnaire', why: 'designing a customer survey is the skill\'s subject; before, no skill answered' },
  'library-agent-sealed/q070s': { skill: 'feasibility-study', why: 'a feasibility study for a car wash is the skill\'s subject' },
};

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const hashes: Record<string, string> = {};
async function readSet(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path);
  const hash = sha256(raw);
  hashes[path.slice(ROOT.length + 1).replace(/\\/g, '/')] = hash;
  if (FROZEN[path] && FROZEN[path] !== hash) throw new Error(`${path} changed after it was frozen (sha256 ${hash})`);
  return raw.toString('utf8');
}
const jsonl = (text: string) => text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

interface Skill { slug: string; candidate: SkillReaderCandidate; body: string }
interface Excluded { slug: string; reason: string }
async function loadLibrary(): Promise<{ skills: Skill[]; excluded: Excluded[] }> {
  const skills: Skill[] = [], excluded: Excluded[] = [];
  for (const slug of (await readdir(LIBRARY)).sort()) {
    const path = join(LIBRARY, slug, 'SKILL.md');
    if (!existsSync(path)) { excluded.push({ slug, reason: 'no SKILL.md' }); continue; }
    const text = await readFile(path, 'utf8');
    let source;
    try { source = buildSkillSource([{ path: 'SKILL.md', content: text }], { root: `github:owner/skills@local:skills/${slug}`, defaultSlug: slug }); }
    catch (error) { excluded.push({ slug, reason: `sync reader refused it: ${(error as Error).message}` }); continue; }
    const inspection = inspectSkill(source.contract, source.files);
    if (inspection.verdict !== 'pass' || inspection.findings.length) {
      excluded.push({ slug, reason: `inspector ${inspection.verdict}: ${inspection.findings.map(finding => finding.code).join(', ')}` });
      continue;
    }
    const { contract } = source;
    skills.push({ slug, body: parseSkillManifest(text).body, candidate: { id: randomUUID(), slug: contract.slug, name: contract.name, description: contract.description, category: contract.category, version: contract.version, contentHash: sha256(text) } });
  }
  return { skills, excluded };
}

type Kind = 'positive' | 'none' | 'unrelated' | 'ambiguous' | 'unavailable_tool' | 'neighbour' | 'stored_fact' | 'real';
interface Row { set: string; key: string; kind: Kind; request: string; expected: string[]; chosen: string | null; score: number | null; ok: boolean; owner?: boolean; missing?: string[]; reviewed?: string; guard?: true }
interface Cases { positive?: { skill: string; request: string; mustContain?: string[] }[]; unrelated?: string[]; ambiguous?: string[]; unavailableTool?: { request: string; allow: string[] }[]; neighbours?: { request: string; expect: string[] }[]; storedFacts?: string[] }

async function main() {
  const { skills, excluded } = await loadLibrary();
  const candidates = skills.map(skill => skill.candidate);
  const index = buildSkillReaderIndex(candidates);
  const bodies = new Map(skills.map(skill => [skill.candidate.id, skill.body]));
  const reader = createSkillReader({ candidates: async () => candidates, index: async () => index, instructions: async (_owner, id) => bodies.get(id) ?? null });
  const ask = async (request: string) => { const answer = await reader(OWNER, request, { mode: 'advice' }); return { chosen: answer?.skill.slug ?? null, score: answer?.score ?? null, text: answer?.text ?? '' }; };

  // `--df "<words>"`: how many skills hold each word's stem, in their title (name and id) or description, and which.
  const dfWords = arg('--df');
  if (dfWords) {
    for (const word of dfWords.split(/\s+/u).filter(Boolean)) {
      for (const stem of skillStems(word)) {
        const inTitle = skills.filter(skill => skillStems(`${skill.candidate.name} ${skill.candidate.slug}`).includes(stem)).map(skill => skill.slug);
        const inBody = skills.filter(skill => !inTitle.includes(skill.slug) && skillStems(skill.candidate.description).includes(stem)).map(skill => skill.slug);
        console.log(`${word} -> ${stem}: title ${inTitle.length} [${inTitle.slice(0, 6).join(' ')}${inTitle.length > 6 ? ' …' : ''}], description ${inBody.length} [${inBody.slice(0, 6).join(' ')}${inBody.length > 6 ? ' …' : ''}]`);
      }
    }
    return;
  }
  // `--explain "<request>"` (repeatable): the five best matches with their scores and the request words each one matched.
  const explain = process.argv.flatMap((value, at) => value === '--explain' && process.argv[at + 1] ? [process.argv[at + 1]!] : []);
  if (explain.length) {
    for (const request of explain) {
      const { chosen, score } = await ask(request);
      console.log(`\n${request}\n  readable(advice)=${skillReadable(request, 'advice')} chosen=${chosen} score=${score}`);
      for (const match of matchSkills(request, candidates, index).slice(0, 5)) console.log(`  ${match.score.toFixed(3)} ${match.skill.slug} [${match.terms.join(' ')}]`);
    }
    return;
  }

  const agentText = await readSet(join(LIB_EVAL, 'questions-agent-v1.jsonl'));
  if (!agentText) throw new Error('the library agent questions are missing');
  const agent = jsonl(agentText) as { id: string; set: string; skill: string; text: string; ok: string[] }[];
  const base = new Set(agent.map(item => item.skill));
  const present = new Set(skills.map(skill => skill.slug));
  const added = new Set([...present].filter(slug => !base.has(slug)));
  const rows: Row[] = [];

  // `--overlap`: for each added skill, the stems of its name, id and description that original skills also hold. Each shared
  // stem lowers that stem's weight for the original skills (the reader weighs a stem by how few skills hold it).
  if (process.argv.includes('--overlap')) {
    const stemsOf = (skill: SkillReaderCandidate) => ({ title: new Set(skillStems(`${skill.name} ${skill.slug}`)), body: new Set(skillStems(skill.description)) });
    const holders = new Map<string, string[]>();
    for (const skill of skills.filter(item => base.has(item.slug))) {
      const { title, body } = stemsOf(skill.candidate);
      for (const stem of new Set([...title, ...body])) holders.set(stem, [...holders.get(stem) ?? [], `${skill.slug}${title.has(stem) ? '*' : ''}`]);
    }
    for (const skill of skills.filter(item => added.has(item.slug))) {
      const { title, body } = stemsOf(skill.candidate);
      const shared = [...new Set([...title, ...body])].filter(stem => holders.has(stem)).sort((a, b) => holders.get(b)!.length - holders.get(a)!.length);
      console.log(`${skill.slug}: ${shared.map(stem => `${title.has(stem) ? '*' : ''}${stem}(${holders.get(stem)!.length}: ${holders.get(stem)!.slice(0, 4).join(',')}${holders.get(stem)!.length > 4 ? ',…' : ''})`).join('  ')}`);
    }
    return;
  }

  for (const item of agent) {
    const { chosen, score } = await ask(item.text);
    const set = `library-agent-${item.set}`, reviewed = REVIEWED_OK[`${set}/${item.id}`];
    rows.push({ set, key: item.id, kind: 'positive', request: item.text, expected: item.ok, chosen, score,
      ok: chosen !== null && (item.ok.includes(chosen) || reviewed?.skill === chosen), ...(reviewed?.skill === chosen && chosen !== null ? { reviewed: reviewed.why } : {}) });
  }
  const noneText = await readSet(join(LIB_EVAL, 'questions-agent-none-dev-v1.jsonl'));
  for (const item of noneText ? jsonl(noneText) as { id: string; text: string }[] : []) {
    const { chosen, score } = await ask(item.text);
    rows.push({ set: 'library-none-dev', key: item.id, kind: 'none', request: item.text, expected: [], chosen, score, ok: chosen === null });
  }
  const labelsText = await readSet(join(LIB_EVAL, 'real-labels-v1.json'));
  const realText = await readSet(join(ROOT, 'artifacts', 'plan-2026-11-22', 'real-questions-v1.jsonl'));
  if (labelsText && realText) {
    const labels = JSON.parse(labelsText).labels as Record<string, { need: boolean; ok: string[] }> | [string, { need: boolean; ok: string[] }][];
    const labelOf = new Map(Array.isArray(labels) ? labels : Object.entries(labels));
    for (const item of jsonl(realText) as { id: string; text: string }[]) {
      const label = labelOf.get(item.id);
      if (!label) continue;
      const { chosen, score } = await ask(item.text);
      rows.push({ set: `real-${label.need ? 'need' : 'no-need'}`, key: item.id, kind: 'real', request: item.text, expected: label.ok, chosen, score,
        ok: label.need ? chosen !== null && label.ok.includes(chosen) : chosen === null || label.ok.includes(chosen) });
    }
  }

  // Pilot sets and the expansion's own sets share one shape.
  const caseSets: [string, string][] = [
    ['pilot-cases', join(PILOT_TESTS, 'cases.json')], ['pilot-heldout', join(PILOT_TESTS, 'heldout.json')],
    ['pilot-heldout-2', join(PILOT_TESTS, 'heldout-2.json')], ['pilot-heldout-3', join(PILOT_TESTS, 'heldout-3.json')],
  ];
  // `--exclude <name>` (repeatable) leaves a frozen set unread, so a revision can be checked on the other sets before its one run.
  const excludedSets = new Set(process.argv.flatMap((value, at) => value === '--exclude' && process.argv[at + 1] ? [process.argv[at + 1]!] : []));
  if (existsSync(NEW_TESTS)) for (const name of (await readdir(NEW_TESTS)).filter(file => /^cases-.*\.json$/u.test(file)).sort()) {
    const set = `new-${name.replace(/^cases-|\.json$/gu, '')}`;
    if (!excludedSets.has(set)) caseSets.push([set, join(NEW_TESTS, name)]);
  }
  for (const [set, path] of caseSets) {
    const text = await readSet(path);
    if (!text) continue;
    const cases = JSON.parse(text) as Cases;
    for (const [n, item] of (cases.positive ?? []).entries()) {
      const { chosen, score, text: answer } = await ask(item.request);
      const missing = (item.mustContain ?? []).filter(phrase => !answer.includes(phrase));
      const skill = current(item.skill);
      // `guard`: the reader refuses the wording before any skill is read (a question that opens with متى or كم, a live word such as
      // "score"), so the miss belongs to the reader, not to the skill.
      rows.push({ set, key: `p${n}`, kind: 'positive', request: item.request, expected: [skill], chosen, score, ok: chosen === skill && !missing.length,
        ...(missing.length ? { missing } : {}), ...(skillReadable(item.request, 'advice') ? {} : { guard: true as const }) });
    }
    const negative = async (kind: Kind, requests: string[], allowed: (request: string) => string[], anySkillWrong: boolean) => {
      for (const [n, request] of requests.entries()) {
        const { chosen, score } = await ask(request);
        const allow = allowed(request).map(current);
        const ok = anySkillWrong ? chosen === null : chosen === null || !added.has(chosen) || allow.includes(chosen);
        rows.push({ set, key: `${kind}${n}`, kind, request, expected: allow, chosen, score, ok, ...(kind === 'neighbour' ? { owner: chosen !== null && allow.includes(chosen) } : {}) });
      }
    };
    await negative('unrelated', cases.unrelated ?? [], () => [], false);
    await negative('ambiguous', cases.ambiguous ?? [], () => [], false);
    const allowOf = new Map((cases.unavailableTool ?? []).map(item => [item.request, item.allow]));
    await negative('unavailable_tool', [...allowOf.keys()], request => allowOf.get(request) ?? [], false);
    const expectOf = new Map((cases.neighbours ?? []).map(item => [item.request, item.expect]));
    await negative('neighbour', [...expectOf.keys()], request => expectOf.get(request) ?? [], false);
    await negative('stored_fact', cases.storedFacts ?? [], () => [], true);
  }

  const summary: Record<string, Record<string, unknown>> = {};
  for (const set of [...new Set(rows.map(row => row.set))]) {
    const mine = rows.filter(row => row.set === set);
    const byKind: Record<string, string> = {};
    for (const kind of [...new Set(mine.map(row => row.kind))]) {
      const list = mine.filter(row => row.kind === kind);
      byKind[kind] = `${list.filter(row => row.ok).length}/${list.length}` + (kind === 'real' || kind === 'positive' ? `, abstain ${list.filter(row => row.chosen === null).length}` : `, any skill ${list.filter(row => row.chosen !== null).length}`);
    }
    summary[set] = byKind;
  }
  // An added skill is accepted when every positive that names it passes and it never takes a request it does not own.
  const positivesOf = new Map<string, Row[]>();
  for (const row of rows.filter(row => row.kind === 'positive' && row.set.startsWith('new-') || row.kind === 'positive' && row.set.startsWith('pilot-'))) {
    const skill = row.expected[0]!;
    positivesOf.set(skill, [...positivesOf.get(skill) ?? [], row]);
  }
  const stealing = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.ok || row.chosen === null || !added.has(row.chosen)) continue;
    if (row.kind === 'positive' || row.kind === 'real' || row.kind === 'none' || row.kind === 'neighbour' || row.kind === 'unrelated' || row.kind === 'ambiguous' || row.kind === 'unavailable_tool' || row.kind === 'stored_fact')
      stealing.set(row.chosen, [...stealing.get(row.chosen) ?? [], row]);
  }
  const addedReport = [...added].sort().map(slug => {
    const own = (positivesOf.get(slug) ?? []).filter(row => !row.guard);
    const guarded = (positivesOf.get(slug) ?? []).filter(row => row.guard);
    return { slug, positives: `${own.filter(row => row.ok).length}/${own.length}${guarded.length ? ` (+${guarded.length} refused by the reader's guard)` : ''}`,
      failed: own.filter(row => !row.ok).map(row => `${row.set}: ${row.request} => ${row.chosen}`), takes: (stealing.get(slug) ?? []).map(row => `${row.set}/${row.kind}: ${row.request} (expected ${row.expected.join('|') || 'none'})`) };
  });

  let changes: string[] | null = null;
  if (COMPARE) {
    const before = JSON.parse(await readFile(COMPARE, 'utf8')) as { rows: Row[] };
    const earlier = new Map(before.rows.map(row => [`${row.set}\u0000${row.key}\u0000${row.request}`, row]));
    changes = [];
    for (const row of rows) {
      const old = earlier.get(`${row.set}\u0000${row.key}\u0000${row.request}`);
      if (old && old.chosen !== row.chosen) changes.push(`${row.ok ? 'ok ' : 'BAD'} ${old.ok ? 'was-ok ' : 'was-bad'} ${row.set}/${row.key} [${row.kind}] ${row.request} :: ${old.chosen} -> ${row.chosen} (expected ${row.expected.join('|') || 'none'})`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(), library: LIBRARY.slice(ROOT.length + 1).replace(/\\/g, '/'), skills: skills.length, excluded, added: added.size,
    setHashes: hashes, summary, addedSkills: addedReport, changes, rows,
  };
  if (OUT) { await mkdir(dirname(resolve(OUT)), { recursive: true }); await writeFile(resolve(OUT), JSON.stringify(report, null, 1), 'utf8'); }
  console.log(JSON.stringify({ skills: skills.length, excluded, added: added.size, summary }, null, 1));
  const failedAdded = addedReport.filter(item => item.failed.length || item.takes.length);
  if (failedAdded.length) console.log(`added skills with a failure or a taken request: ${failedAdded.length}\n${failedAdded.map(item => `- ${item.slug} ${item.positives}${item.failed.length ? `\n    fail: ${item.failed.join('\n    fail: ')}` : ''}${item.takes.length ? `\n    takes: ${item.takes.join('\n    takes: ')}` : ''}`).join('\n')}`);
  if (changes) console.log(`changed choices: ${changes.length}\n${changes.join('\n')}`);
}
main().catch(error => { console.error(error); process.exit(1); });
