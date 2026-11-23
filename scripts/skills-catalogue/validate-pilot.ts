/**
 * Validates the pilot package against the skills it would live with, in a throwaway in-memory database:
 *
 *   1. Structural: the real importer, inspector and catalogue facts for every pilot folder.
 *   2. Import: the bulk importer (bounded batches) for the repo skills, the owner library and the pilot.
 *   3. Behaviour: the chat's own reader (no model) and router on the frozen cases in skills-pilot/tests/cases.json:
 *      Arabic and English requests per skill, unrelated, ambiguous and unavailable-tool requests.
 *   4. Evidence: per-skill results recorded against the exact content hash; catalogue counts read back.
 *
 *   npx tsx scripts/skills-catalogue/validate-pilot.ts [--out artifacts/skills-catalogue/pilot-validation.json]
 *
 * Nothing is published, no live account is touched, and no production database is opened.
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDatabase, migrate } from '@mohassan/database';
import { memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../../apps/server/src/auth.ts';
import { buildSkillReaderIndex, createSkillReader, skillInstructionText } from '../../apps/server/src/assistant/skill-reader.ts';
import { buildSkillSource } from '../../packages/skills/src/importer.ts';
import { createSkillControl, deriveCatalogueFacts, inspectSkill, sha256, skillsMigration, MAX_SKILL_CONTEXT_CHARS } from '../../packages/skills/src/index.ts';

const ROOT = resolve('.');
const OWNER = 'pilot-validation-owner';
const PACKAGES = [
  { label: 'repo skills', path: ROOT, skillsDir: 'skills' },
  { label: 'owner library', path: join(ROOT, 'skills-library'), skillsDir: 'skills' },
  { label: 'pilot', path: join(ROOT, 'skills-pilot'), skillsDir: 'skills' },
];
interface Cases {
  positive: { skill: string; request: string; mustContain: string[] }[]; unrelated: string[]; ambiguous: string[]; unavailableTool: { request: string; allow: string[] }[];
  /** Requests another skill owns: no pilot skill outside `expect` may take them. */
  neighbours?: { request: string; expect: string[] }[];
  /** Questions about the owner's own stored facts: no skill at all may answer them. */
  storedFacts?: string[];
}

async function folderFiles(root: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  async function walk(dir: string, prefix: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path); else out.push({ path, content: await readFile(join(dir, entry.name), 'utf8') });
    }
  }
  await walk(root, '');
  return out;
}

async function main() {
  const at = process.argv.indexOf('--out');
  const out = at >= 0 ? process.argv[at + 1] : join('artifacts', 'skills-catalogue', 'pilot-validation.json');
  const casesText = await readFile(join(ROOT, 'skills-pilot', 'tests', 'cases.json'), 'utf8');
  const cases = JSON.parse(casesText) as Cases;
  // heldout.json was frozen before the first revision was measured. Its seven failures guided the second revision, so it is now a
  // revision set. heldout-2.json was frozen before the second revision (skills-pilot/tests/FREEZE.md) and is never used to edit a skill.
  const heldoutText = await readFile(join(ROOT, 'skills-pilot', 'tests', 'heldout.json'), 'utf8').catch(() => null);
  const heldout = heldoutText ? JSON.parse(heldoutText) as Cases : null;
  // heldout-3.json was frozen after heldout-2 was run once, before the third revision of the three skills it still failed.
  const heldout2Text = await readFile(join(ROOT, 'skills-pilot', 'tests', 'heldout-2.json'), 'utf8').catch(() => null);
  const heldout2 = heldout2Text ? JSON.parse(heldout2Text) as Cases : null;
  const heldout3Text = await readFile(join(ROOT, 'skills-pilot', 'tests', 'heldout-3.json'), 'utf8').catch(() => null);
  const heldout3 = heldout3Text ? JSON.parse(heldout3Text) as Cases : null;
  const suiteHash = sha256(casesText + (heldoutText ?? '') + (heldout2Text ?? '') + (heldout3Text ?? ''));
  const pilotSlugs = (await readdir(join(ROOT, 'skills-pilot', 'skills'))).sort();
  const pilot = new Set(pilotSlugs);

  // 1. Structural, without a database.
  const structural: Record<string, unknown>[] = [];
  for (const slug of pilotSlugs) {
    const files = await folderFiles(join(ROOT, 'skills-pilot', 'skills', slug));
    try {
      const source = buildSkillSource(files, { root: `pilot/${slug}`, defaultSlug: slug });
      const inspection = inspectSkill(source.contract, source.files);
      const facts = deriveCatalogueFacts(source.contract, source.files, { kind: 'local_folder', locator: `pilot/${slug}`, package: 'mohassan/pilot-2026-11' });
      structural.push({ slug, ok: ['pass', 'review'].includes(inspection.verdict) && facts.compatibility === 'compatible' && facts.licenceKind !== 'unknown' && facts.licenceKind !== 'restricted' && (!facts.upstream || Boolean(facts.attribution)),
        verdict: inspection.verdict, findings: inspection.findings.map(finding => finding.code), compatibility: facts.compatibility, reasons: facts.reasons, licence: facts.licence, licenceKind: facts.licenceKind,
        language: facts.language, workflow: facts.workflow, variantOf: facts.variantOf, upstream: facts.upstream ? `${facts.upstream.repo}:${facts.upstream.path}` : null, attribution: Boolean(facts.attribution), bodyChars: facts.bodyChars });
    } catch (error) { structural.push({ slug, ok: false, error: (error as { code?: string }).code ?? String(error) }); }
  }

  // 2. Import through the bulk importer, in bounded batches, then activate as the owner would.
  const store = await createDatabase();
  await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db); await skillsMigration(store.db);
  await store.db.insertInto('user').values({ id: OWNER, name: 'Pilot validation', email: 'pilot-validation@example.test' }).execute();
  const skills = createSkillControl(store.db, { enabled: true, allowedRoots: [ROOT] });
  const imports: Record<string, unknown>[] = [];
  const versionOf = new Map<string, string>();
  for (const pkg of PACKAGES) {
    const started = performance.now();
    let status = await skills.catalogue.importBatch(OWNER, { path: pkg.path, batchSize: 25 });
    let batches = 1;
    for (const item of status.items) if (item.versionId) versionOf.set(item.slug, item.versionId);
    while (status.status === 'running') { status = await skills.catalogue.importBatch(OWNER, { path: pkg.path, batchSize: 25 }); batches++; for (const item of status.items) if (item.versionId) versionOf.set(item.slug, item.versionId); }
    imports.push({ package: pkg.label, id: status.package, status: status.status, errorCode: status.errorCode, batches, progress: status.progress, counts: status.counts, quota: status.quota, ms: Math.round(performance.now() - started) });
  }
  const again = await skills.catalogue.importBatch(OWNER, { path: join(ROOT, 'skills-pilot'), batchSize: 100 });
  let activated = 0, activationErrors: string[] = [];
  for (const [slug, id] of versionOf) {
    try {
      const detail = await skills.detail(OWNER, id);
      if (detail.skill.status === 'inspected') { await skills.activate(OWNER, id, { expectedRevision: detail.skill.revision, approve: true, acknowledgeFindings: true }); activated++; }
    } catch (error) { activationErrors.push(`${slug}:${(error as { code?: string }).code ?? 'ERROR'}`); }
  }

  // 3. Behaviour through the chat's reader and router.
  const reader = createSkillReader({
    candidates: async () => (await skills.catalogue.snapshot(OWNER)).entries,
    index: async () => (await skills.catalogue.snapshot(OWNER)).memo('skill-reader', buildSkillReaderIndex),
    instructions: async (_owner, id) => skillInstructionText((await skills.loadInstruction(OWNER, id, MAX_SKILL_CONTEXT_CHARS)).text),
  });
  const slugOfId = new Map([...(await skills.catalogue.snapshot(OWNER)).entries].map(entry => [entry.id, entry.slug]));
  const latencies: number[] = [], contextChars: number[] = [];
  const runPositive = async (list: Cases['positive']) => {
  const positive = [];
  for (const item of list) {
    const t0 = performance.now();
    const answer = await reader(OWNER, item.request, { mode: 'advice' });
    latencies.push(performance.now() - t0);
    const context = await skills.context(OWNER, item.request, { budgetChars: 4000 });
    contextChars.push(context.text.length);
    const routed = context.skills.map(skill => slugOfId.get(skill.id) ?? skill.slug);
    const missing = item.mustContain.filter(phrase => !answer?.text.includes(phrase));
    positive.push({ skill: item.skill, request: item.request, readerChose: answer?.skill.slug ?? null, readerOk: answer?.skill.slug === item.skill, outputOk: answer?.skill.slug === item.skill && !missing.length,
      missing, routerFirst: routed[0] ?? null, routerTop3: routed.slice(0, 3).includes(item.skill), contextChars: context.text.length, lang: answer?.lang ?? null });
  }
  return positive;
  };
  const positive = await runPositive(cases.positive);
  const heldoutPositive = heldout ? await runPositive(heldout.positive) : [];
  const heldout2Positive = heldout2 ? await runPositive(heldout2.positive) : [];
  const heldout3Positive = heldout3 ? await runPositive(heldout3.positive) : [];
  // `noSkill`: any skill is wrong (stored facts). Otherwise only a pilot skill outside `allow` is wrong; `expected` says whether the owner of a neighbour request won.
  const negatives = async (requests: string[], kind: string, allow: (request: string) => string[] = () => [], noSkill = false) => {
    const rows = [];
    for (const request of requests) {
      const answer = await reader(OWNER, request, { mode: 'advice' });
      const chose = answer?.skill.slug ?? null;
      const context = await skills.context(OWNER, request, { budgetChars: 4000 });
      const routedPilot = context.skills.map(skill => slugOfId.get(skill.id) ?? skill.slug).filter(slug => pilot.has(slug));
      rows.push({ kind, request, readerChose: chose, ok: noSkill ? chose === null : chose === null || !pilot.has(chose) || allow(request).includes(chose),
        ...(kind === 'neighbour' ? { expected: chose !== null && allow(request).includes(chose) } : {}), routerPilotSkills: routedPilot });
    }
    return rows;
  };
  const unrelated = await negatives(cases.unrelated, 'unrelated');
  const ambiguous = await negatives(cases.ambiguous, 'ambiguous');
  const allowOf = new Map(cases.unavailableTool.map(item => [item.request, item.allow]));
  const unavailable = await negatives(cases.unavailableTool.map(item => item.request), 'unavailable_tool', request => allowOf.get(request) ?? []);
  for (const item of heldout?.unavailableTool ?? []) allowOf.set(item.request, item.allow);
  const heldoutNegatives = heldout ? [...await negatives(heldout.unrelated, 'unrelated'), ...await negatives(heldout.ambiguous, 'ambiguous'),
    ...await negatives(heldout.unavailableTool.map(item => item.request), 'unavailable_tool', request => allowOf.get(request) ?? [])] : [];
  const freshNegatives = async (set: Cases | null) => {
    if (!set) return [];
    for (const item of set.unavailableTool) allowOf.set(item.request, item.allow);
    const expectOf = new Map((set.neighbours ?? []).map(item => [item.request, item.expect]));
    return [...await negatives(set.unrelated, 'unrelated'), ...await negatives(set.ambiguous, 'ambiguous'),
      ...await negatives(set.unavailableTool.map(item => item.request), 'unavailable_tool', request => allowOf.get(request) ?? []),
      ...await negatives([...expectOf.keys()], 'neighbour', request => expectOf.get(request) ?? []),
      ...await negatives(set.storedFacts ?? [], 'stored_fact', () => [], true)];
  };
  const heldout2Negatives = await freshNegatives(heldout2);
  const heldout3Negatives = await freshNegatives(heldout3);

  // 4. Evidence bound to content, and the catalogue read back.
  const perSkill = new Map<string, { passed: number; total: number }>();
  for (const row of [...positive, ...heldoutPositive, ...heldout2Positive, ...heldout3Positive]) { const entry = perSkill.get(row.skill) ?? { passed: 0, total: 0 }; entry.total++; if (row.outputOk) entry.passed++; perSkill.set(row.skill, entry); }
  // A skill that takes a request it does not own fails too, whatever its own cases say.
  const allNegatives = [...unrelated, ...ambiguous, ...unavailable, ...heldoutNegatives, ...heldout2Negatives, ...heldout3Negatives];
  const stealing = new Set(allNegatives.filter(row => !row.ok && row.readerChose).map(row => row.readerChose as string));
  let evidence = 0;
  for (const [slug, result] of perSkill) {
    const id = versionOf.get(slug);
    if (!id) continue;
    const detail = await skills.detail(OWNER, id);
    await skills.catalogue.recordEvidence(OWNER, { versionId: id, contentHash: detail.skill.contentHash, suite: heldout3 ? 'pilot-2026-11-v4' : heldout2 ? 'pilot-2026-11-v3' : heldout ? 'pilot-2026-11-v2' : 'pilot-2026-11-v1', suiteHash, passed: result.passed, total: result.total, detail: { cases: result.total } });
    evidence++;
  }
  const catalogue = await skills.catalogue.search(OWNER, { limit: 1 });
  const pilotTested = await skills.catalogue.search(OWNER, { package: 'mohassan/pilot-2026-11', tested: 'true', limit: 100 });
  const searches = {
    arabic: (await skills.catalogue.search(OWNER, { q: 'خطاب رسمي', limit: 3 })).items.map(item => item.slug),
    english: (await skills.catalogue.search(OWNER, { q: 'code review feedback', limit: 3 })).items.map(item => item.slug),
    noMatch: await skills.catalogue.search(OWNER, { q: 'تربية الصقور في القطب', limit: 3 }).then(result => ({ items: result.items.length, families: result.counts.families })),
    pilotRequiresTools: (await skills.catalogue.search(OWNER, { package: 'mohassan/pilot-2026-11', compatibility: 'requires_tools' })).total,
  };
  await store.close();

  const sorted = [...latencies].sort((a, b) => a - b);
  const accepted = pilotSlugs.filter(slug => (structural.find(row => row.slug === slug)?.ok ?? false) && (perSkill.get(slug)?.passed ?? 0) === (perSkill.get(slug)?.total ?? -1) && !stealing.has(slug));
  const setSummary = (rows: Awaited<ReturnType<typeof runPositive>>, negativeRows: Awaited<ReturnType<typeof negatives>>) => ({
    positive: { total: rows.length, readerCorrect: rows.filter(row => row.readerOk).length, outputCorrect: rows.filter(row => row.outputOk).length,
      routerTop3: rows.filter(row => row.routerTop3).length, routerFirst: rows.filter(row => row.routerFirst === row.skill).length },
    negatives: { total: negativeRows.length, ok: negativeRows.filter(row => row.ok).length },
    byKind: Object.fromEntries([...new Set(negativeRows.map(row => row.kind))].map(kind => [kind, { total: negativeRows.filter(row => row.kind === kind).length, ok: negativeRows.filter(row => row.kind === kind && row.ok).length,
      ...(kind === 'neighbour' ? { expected: negativeRows.filter(row => row.kind === kind && 'expected' in row && row.expected).length } : {}) }])),
    failures: rows.filter(row => !row.outputOk), negativeFailures: negativeRows.filter(row => !row.ok), negativeRows,
  });
  const report = {
    generatedAt: new Date().toISOString(), suiteHash,
    structural: { total: structural.length, ok: structural.filter(row => row.ok).length, rows: structural },
    imports, reimportPilot: { status: again.status, counts: again.counts }, activated, activationErrors,
    behaviour: {
      positive: { total: positive.length, readerCorrect: positive.filter(row => row.readerOk).length, outputCorrect: positive.filter(row => row.outputOk).length,
        routerTop3: positive.filter(row => row.routerTop3).length, routerFirst: positive.filter(row => row.routerFirst === row.skill).length },
      unrelated: { total: unrelated.length, ok: unrelated.filter(row => row.ok).length }, ambiguous: { total: ambiguous.length, ok: ambiguous.filter(row => row.ok).length },
      unavailableTool: { total: unavailable.length, ok: unavailable.filter(row => row.ok).length },
      readerLatencyMs: { p50: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10, p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10 },
      contextChars: { max: Math.max(...contextChars), budget: 4000 },
      failures: positive.filter(row => !row.outputOk), negativeFailures: [...unrelated, ...ambiguous, ...unavailable].filter(row => !row.ok),
      negatives: [...unrelated, ...ambiguous, ...unavailable],
    },
    heldout: heldout ? { role: heldout2 ? 'revision set (guided the second revision)' : 'held-out', ...setSummary(heldoutPositive, heldoutNegatives) } : null,
    heldout2: heldout2 ? { role: heldout3 ? 'held-out for four skills; revision set for the three revised again' : 'held-out (frozen before the second revision)', ...setSummary(heldout2Positive, heldout2Negatives) } : null,
    heldout3: heldout3 ? { role: 'held-out (frozen before the third revision)', ...setSummary(heldout3Positive, heldout3Negatives) } : null,
    evidenceRecorded: evidence,
    pilot: { candidates: pilotSlugs.length, accepted: accepted.length, rejected: pilotSlugs.filter(slug => !accepted.includes(slug)), stealing: [...stealing] },
    catalogue: { counts: catalogue.counts, pendingFacts: catalogue.pendingFacts, pilotBehaviourallyTested: pilotTested.total, searches },
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 1), 'utf8');
  const { failures, negatives: _all, ...summary } = report.behaviour;
  console.log(JSON.stringify({ structural: { total: report.structural.total, ok: report.structural.ok }, imports, reimportPilot: report.reimportPilot, activated, activationErrors, behaviour: { ...summary, failures: failures.map(row => `${row.skill} <- ${row.request} => ${row.readerChose} missing ${row.missing.join('|')}`) }, ...Object.fromEntries((['heldout', 'heldout2', 'heldout3'] as const).map(key => { const set = report[key]; return [key, set ? { role: set.role, positive: set.positive, negatives: set.negatives, byKind: set.byKind,
    failures: set.failures.map(row => `${row.skill} <- ${row.request} => ${row.readerChose} missing ${row.missing.join('|')}`), negativeFailures: set.negativeFailures } : null]; })), evidenceRecorded: evidence, pilot: report.pilot, catalogue: report.catalogue }, null, 1));
}
main().catch(error => { console.error(error); process.exit(1); });
