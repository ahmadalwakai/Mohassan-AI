/**
 * Capacity benchmark of the catalogue at 10,000 entries: the 165 real skills of this checkout (repo, owner
 * library, pilot) plus synthetic fixture entries (tests/fixtures/skills/catalogue-scale.ts) up to the total.
 * Synthetic entries exist only in memory and in a throwaway in-memory database; they are never counted as skills.
 *
 *   node --expose-gc --import tsx scripts/skills-catalogue/bench-scale.ts [--total 10000] [--out artifacts/skills-catalogue/bench-10k.json]
 *
 * Measures index build time and heap, per-request selection latency for the reader and the router (new
 * index path against the old alphabetical window), selection quality on the frozen pilot cases, answer and
 * context sizes, and the database path: fingerprint, snapshot load, chat context and catalogue search.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDatabase, migrate } from '@mohassan/database';
import { memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../../apps/server/src/auth.ts';
import { buildSkillReaderIndex, composeSkillAnswer, matchSkills, skillReadable, type SkillReaderCandidate } from '../../apps/server/src/assistant/skill-reader.ts';
import { buildSkillSource } from '../../packages/skills/src/importer.ts';
import { parseSkillManifest } from '../../packages/skills/src/frontmatter.ts';
import { createSkillControl, routerIndex, sha256, skillsMigration, CATALOGUE_FACTS_VERSION } from '../../packages/skills/src/index.ts';
import { rankInstructionCandidates, routeInstructionSkills, skillTerms } from '../../packages/skills/src/router.ts';
import { syntheticCatalogue, SYNTHETIC_PREFIX } from '../../tests/fixtures/skills/catalogue-scale.ts';

const ROOT = resolve('.');
const arg = (name: string, fallback: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : fallback; };
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const heapMb = () => { gc(); return Math.round(process.memoryUsage().heapUsed / 1048576 * 10) / 10; };
const pct = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 100) / 100; };
interface Cases { positive: { skill: string; request: string; mustContain: string[] }[]; unrelated: string[]; ambiguous: string[]; unavailableTool: { request: string; allow: string[] }[] }

async function realSkills(): Promise<{ candidates: SkillReaderCandidate[]; bodies: Map<string, string>; folders: { slug: string; dir: string }[] }> {
  const candidates: SkillReaderCandidate[] = [], bodies = new Map<string, string>(), folders: { slug: string; dir: string }[] = [];
  // Since 2026-11-24 the accepted pilot skills are published in skills-library too: a slug is read once, the first folder wins.
  const seen = new Set<string>();
  for (const base of ['skills', join('skills-library', 'skills'), join('skills-pilot', 'skills')]) {
    for (const slug of (await readdir(join(ROOT, base))).sort()) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      const text = await readFile(join(ROOT, base, slug, 'SKILL.md'), 'utf8');
      const built = buildSkillSource([{ path: 'SKILL.md', content: text }], { root: base, defaultSlug: slug });
      const id = randomUUID();
      candidates.push({ id, slug, name: built.contract.name, description: built.contract.description, category: built.contract.category, version: built.contract.version, contentHash: sha256(text) });
      bodies.set(id, parseSkillManifest(text).body);
      folders.push({ slug, dir: join(ROOT, base, slug) });
    }
  }
  return { candidates, bodies, folders };
}

async function main() {
  const total = Number(arg('--total', '10000'));
  const out = arg('--out', join('artifacts', 'skills-catalogue', `bench-${Math.round(total / 1000)}k.json`));
  const real = await realSkills();
  const cases = JSON.parse(await readFile(join(ROOT, 'skills-pilot', 'tests', 'cases.json'), 'utf8')) as Cases;
  const heldout = JSON.parse(await readFile(join(ROOT, 'skills-pilot', 'tests', 'heldout.json'), 'utf8')) as Cases;
  const positives = [...cases.positive, ...heldout.positive];
  const negatives = [...cases.unrelated, ...cases.ambiguous, ...cases.unavailableTool.map(item => item.request), ...heldout.unrelated, ...heldout.ambiguous, ...heldout.unavailableTool.map(item => item.request)];
  const allowed = new Map([...cases.unavailableTool, ...heldout.unavailableTool].map(item => [item.request, new Set(item.allow)]));
  const pilot = new Set((await readdir(join(ROOT, 'skills-pilot', 'skills'))));
  const synthetic = syntheticCatalogue(Math.max(0, total - real.candidates.length), real.candidates.map(skill => `${skill.name} ${skill.description}`));
  // The order the database returns: by slug, then id.
  const entries = [...real.candidates, ...synthetic].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.id < b.id ? -1 : 1));
  const bySlug = new Map(entries.map(entry => [entry.slug, entry]));

  // ------------------------------------------------ in-memory: index build and heap
  const heapBefore = heapMb();
  let t0 = performance.now();
  const readerIndex = buildSkillReaderIndex(entries);
  const readerBuildMs = performance.now() - t0;
  t0 = performance.now();
  const router = routerIndex(entries as never);
  const routerBuildMs = performance.now() - t0;
  const heapAfter = heapMb();

  // ------------------------------------------------ selection: new index path against the old alphabetical windows
  const run = (request: string) => {
    let start = performance.now();
    const indexed = skillReadable(request, 'advice') ? matchSkills(request, entries, readerIndex) : [];
    const readerMs = performance.now() - start;
    start = performance.now();
    const old = skillReadable(request, 'advice') ? matchSkills(request, entries) : []; // first 1,300 by slug, as before
    const oldReaderMs = performance.now() - start;
    start = performance.now();
    const terms = skillTerms(request);
    const routed = terms.length ? routeInstructionSkills(request, rankInstructionCandidates(request, router.shortlist(terms).map(position => entries[position]) as never)) : [];
    const routerMs = performance.now() - start;
    const oldRouted = routeInstructionSkills(request, rankInstructionCandidates(request, entries.slice(0, 1250) as never));
    return { reader: indexed[0]?.skill.slug ?? null, oldReader: old[0]?.skill.slug ?? null, router: routed[0]?.slug ?? null, routerTop3: routed.slice(0, 3).map(skill => skill.slug), oldRouter: oldRouted[0]?.slug ?? null, readerMs, oldReaderMs, routerMs, best: indexed[0] };
  };
  // Warm up the JIT and the reader's per-skill cache once, as a running server would be.
  for (const item of positives.slice(0, 5)) run(item.request);
  const readerMs: number[] = [], oldReaderMs: number[] = [], routerMs: number[] = [];
  let readerOk = 0, oldReaderOk = 0, routerFirst = 0, routerTop3 = 0, oldRouterFirst = 0, answerMax = 0, outputOk = 0;
  const misses: string[] = [];
  for (const item of positives) {
    const result = run(item.request);
    readerMs.push(result.readerMs); oldReaderMs.push(result.oldReaderMs); routerMs.push(result.routerMs);
    if (result.reader === item.skill) {
      readerOk++;
      const skill = bySlug.get(item.skill)!;
      const answer = composeSkillAnswer(item.request, skill, real.bodies.get(skill.id)!, { mode: 'advice' });
      answerMax = Math.max(answerMax, answer.text.length);
      if (item.mustContain.every(phrase => answer.text.includes(phrase))) outputOk++;
    } else misses.push(`${item.skill} <- ${item.request} => ${result.reader}`);
    if (result.oldReader === item.skill) oldReaderOk++;
    if (result.router === item.skill) routerFirst++;
    if (result.routerTop3.includes(item.skill)) routerTop3++;
    if (result.oldRouter === item.skill) oldRouterFirst++;
  }
  let negativeOk = 0, syntheticChosen = 0;
  const negativeMisses: string[] = [];
  for (const request of negatives) {
    const result = run(request);
    readerMs.push(result.readerMs); oldReaderMs.push(result.oldReaderMs); routerMs.push(result.routerMs);
    const chose = result.reader;
    if (chose?.startsWith(SYNTHETIC_PREFIX)) syntheticChosen++;
    if (chose === null || (!pilot.has(chose) && !chose.startsWith(SYNTHETIC_PREFIX)) || allowed.get(request)?.has(chose)) negativeOk++;
    else negativeMisses.push(`${request} => ${chose}`);
  }

  // ------------------------------------------------ database path at the same size
  const store = await createDatabase();
  await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db); await skillsMigration(store.db);
  const owner = 'bench-scale-owner';
  await store.db.insertInto('user').values({ id: owner, name: 'Bench', email: 'bench-scale@example.test' }).execute();
  const skills = createSkillControl(store.db, { enabled: true, allowedRoots: [ROOT] });
  t0 = performance.now();
  for (const pkg of [ROOT, join(ROOT, 'skills-library'), join(ROOT, 'skills-pilot')]) {
    let status = await skills.catalogue.importBatch(owner, { path: pkg, batchSize: 50 });
    while (status.status === 'running') status = await skills.catalogue.importBatch(owner, { path: pkg, batchSize: 50 });
  }
  const importRealMs = performance.now() - t0;
  const imported = await store.db.selectFrom('skill_versions').select(['id', 'revision']).where('owner_id', '=', owner).execute();
  for (const row of imported) await skills.activate(owner, row.id, { expectedRevision: row.revision, approve: true, acknowledgeFindings: true });
  const template = await store.db.selectFrom('skill_versions').selectAll().where('owner_id', '=', owner).limit(1).executeTakeFirstOrThrow();
  t0 = performance.now();
  for (let n = 0; n < synthetic.length; n += 500) {
    const chunk = synthetic.slice(n, n + 500).map(entry => ({ entry, family: randomUUID() }));
    await store.db.insertInto('skill_families').values(chunk.map(({ entry, family }) => ({ id: family, owner_id: owner, slug: entry.slug, active_version_id: entry.id }))).execute();
    await store.db.insertInto('skill_versions').values(chunk.map(({ entry, family }) => ({ ...template, id: entry.id, family_id: family, name: entry.name, description: entry.description.slice(0, 1000), category: entry.category, status: 'active', content_hash: entry.contentHash,
      contract: JSON.stringify({ slug: entry.slug, name: entry.name, description: entry.description.slice(0, 1000), version: '1.0.0', category: entry.category, level: 'instruction' }) }))).execute();
    await store.db.insertInto('skill_catalogue').values(chunk.map(({ entry }) => ({ version_id: entry.id, owner_id: owner, facts_version: CATALOGUE_FACTS_VERSION, language: 'ar', workflow: entry.slug, package: 'fixture/synthetic', compatibility: 'compatible', licence: 'unspecified',
      facts: JSON.stringify({ language: 'ar', workflow: entry.slug, variantOf: null, keywords: [], package: 'fixture/synthetic', upstream: null, licence: 'unspecified', licenceKind: 'owner', attribution: null, requires: [], compatibility: 'compatible', reasons: [], bodyChars: 0 }) }))).execute();
  }
  const insertSyntheticMs = performance.now() - t0;
  const db: Record<string, number> = { importRealMs: Math.round(importRealMs), insertSyntheticMs: Math.round(insertSyntheticMs) };
  const heapDbBefore = heapMb();
  t0 = performance.now(); const cold = await skills.catalogue.snapshot(owner); db.snapshotColdMs = Math.round(performance.now() - t0);
  db.snapshotEntries = cold.entries.length;
  const fingerprintMs: number[] = [];
  for (let n = 0; n < 20; n++) { t0 = performance.now(); await skills.catalogue.snapshot(owner); fingerprintMs.push(performance.now() - t0); }
  db.snapshotWarmP50Ms = pct(fingerprintMs, 0.5); db.snapshotWarmP95Ms = pct(fingerprintMs, 0.95);
  t0 = performance.now(); cold.memo('skill-reader', buildSkillReaderIndex); db.readerIndexBuildMs = Math.round(performance.now() - t0);
  db.heapSnapshotAndIndexMb = Math.round((heapMb() - heapDbBefore) * 10) / 10;
  const contextMs: number[] = [], contextChars: number[] = [];
  let contextOk = 0;
  for (const item of positives) {
    t0 = performance.now();
    const context = await skills.context(owner, item.request, { budgetChars: 4000 });
    contextMs.push(performance.now() - t0); contextChars.push(context.text.length);
    if (context.skills.some(skill => skill.slug === item.skill)) contextOk++;
  }
  db.contextP50Ms = pct(contextMs, 0.5); db.contextP95Ms = pct(contextMs, 0.95); db.contextMaxChars = Math.max(...contextChars); db.contextHasExpected = contextOk;
  t0 = performance.now(); const first = await skills.catalogue.search(owner, { q: 'خطاب رسمي' }); db.searchColdMs = Math.round(performance.now() - t0);
  const searchMs: number[] = [];
  for (const q of ['خطاب رسمي', 'code review feedback', 'دراسة جدوى', 'تربية الصقور في القطب']) { t0 = performance.now(); await skills.catalogue.search(owner, { q }); searchMs.push(performance.now() - t0); }
  db.searchWarmP50Ms = pct(searchMs, 0.5);
  db.searchFamilies = first.counts.families; db.searchFirstHit = first.items[0]?.slug === 'formal-letter' ? 1 : 0;
  await store.close();

  const report = {
    generatedAt: new Date().toISOString(), node: process.version, gcExposed: Boolean((globalThis as { gc?: unknown }).gc),
    entries: { total: entries.length, real: real.candidates.length, synthetic: synthetic.length, syntheticPrefix: SYNTHETIC_PREFIX },
    index: { readerBuildMs: Math.round(readerBuildMs), routerBuildMs: Math.round(routerBuildMs), heapMbBefore: heapBefore, heapMbAfter: heapAfter, heapMbForBothIndexes: Math.round((heapAfter - heapBefore) * 10) / 10 },
    latency: { readerP50Ms: pct(readerMs, 0.5), readerP95Ms: pct(readerMs, 0.95), oldReaderP50Ms: pct(oldReaderMs, 0.5), oldReaderP95Ms: pct(oldReaderMs, 0.95), routerP50Ms: pct(routerMs, 0.5), routerP95Ms: pct(routerMs, 0.95) },
    quality: {
      positives: positives.length, readerTop1: readerOk, readerTaskOutput: outputOk, oldReaderTop1: oldReaderOk, routerTop1: routerFirst, routerTop3, oldRouterTop1: oldRouterFirst,
      negatives: negatives.length, negativeOk, syntheticChosenOnNegatives: syntheticChosen, misses, negativeMisses,
    },
    sizes: { readerAnswerMaxChars: answerMax, readerAnswerLimit: 3800 },
    database: db,
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 1), 'utf8');
  console.log(JSON.stringify(report, null, 1));
}
main().catch(error => { console.error(error); process.exit(1); });
