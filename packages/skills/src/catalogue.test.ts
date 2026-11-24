import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../../../apps/server/src/auth.ts';
import { buildSkillSource } from './importer.ts';
import {
  createSkillControl, createTermIndex, deriveCatalogueFacts, licenceKind, preloadInstructionMetadata, routerIndex, sha256, skillsMigration, type SkillControl,
} from './index.ts';
import { rankInstructionCandidates, rarityWeights, routerRequestTerms, type SkillContextMetadata } from './router.ts';

const manifest = (fields: Record<string, string>, body: string) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n\n${body}\n`;
const source = (slug: string, files: Record<string, string>) => buildSkillSource(Object.entries(files).map(([path, content]) => ({ path, content })), { root: `/fixture/${slug}`, defaultSlug: slug });

/** The thirty tracked skills of this repository, as metadata (no database). */
async function repoMetadata(): Promise<SkillContextMetadata[]> {
  const out: SkillContextMetadata[] = [];
  for (const slug of (await readdir('skills')).sort()) {
    const built = source(slug, { 'SKILL.md': await readFile(join('skills', slug, 'SKILL.md'), 'utf8') });
    out.push({ id: randomUUID(), slug, name: built.contract.name, description: built.contract.description, category: built.contract.category, version: built.contract.version, contentHash: sha256(slug) });
  }
  return out;
}

describe('catalogue index (pure)', () => {
  it('lists the documents holding a term, in their own order, with frequencies', () => {
    const index = createTermIndex([['a', 'b'], ['b', 'c'], ['a', 'a', 'd']]);
    expect(index.size).toBe(3);
    expect(index.frequency('a')).toBe(2); expect(index.frequency('a')).toBe(2); expect(index.frequency('z')).toBe(0);
    expect(index.shortlist(['d', 'b'])).toEqual([0, 1, 2]);
    expect(index.shortlist(['zz'])).toEqual([]);
  });
  it('gives the router exactly what a full scan gives, for Arabic, English and unrelated goals', async () => {
    const real = await repoMetadata();
    const filler = Array.from({ length: 400 }, (_, n) => ({ id: randomUUID(), slug: `filler-${n}`, name: `Filler skill ${n}`, description: `Synthetic entry ${n} about topic${n % 37} and area${n % 11}.`, category: 'research' as const, version: '1.0.0', contentHash: sha256(`f${n}`) }));
    const entries = [...real, ...filler].sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
    const index = routerIndex(entries);
    const goals = ['كيف أكتب خطة عمل لمشروعي', 'help me write a cover letter for a job', 'حلل البيانات وأعطني مؤشرات الأداء', 'swot analysis for my cafe', 'topic3 area4 synthetic',
      'ما الطقس اليوم', 'أريد كتابة بريد احترافي لعميل غاضب', 'sql query to count orders', 'plan', 'xyzzy nothing matches here'];
    for (const goal of goals) {
      const full = rankInstructionCandidates(goal, entries).map(skill => skill.id);
      // As routerCandidates does: shortlist by the router's stems, then rank with the weights of every entry.
      const shortlisted = rankInstructionCandidates(goal, index.shortlist(routerRequestTerms(goal).flatMap(term => term.variants)).map(position => entries[position]), undefined, { weight: rarityWeights(index) }).map(skill => skill.id);
      expect(shortlisted).toEqual(full);
    }
  });
});

describe('catalogue facts (pure)', () => {
  it('reads language, workflow and the declared provenance from the front matter, never from the body', () => {
    const ar = source('business-plan-ar', { 'SKILL.md': manifest({ name: 'خطة عمل', description: 'تساعد في كتابة خطة عمل كاملة لمشروع صغير.' }, '## الخطوات\n1. حدد الفكرة.\n2. قدّر السوق.') });
    const arFacts = deriveCatalogueFacts(ar.contract, ar.files, { kind: 'local_folder', locator: '/x' });
    expect(arFacts).toMatchObject({ language: 'ar', workflow: 'business-plan', variantOf: null, licenceKind: 'owner', compatibility: 'compatible', package: 'local_folder' });
    const en = source('internal-comms-en', { 'SKILL.md': manifest({
      name: 'Internal communications', description: 'Write status reports, newsletters and FAQ answers for a team.', language: 'en', workflow: 'internal-comms', 'variant-of': 'internal-comms',
      license: 'Apache-2.0', source: `anthropics/skills@${'a'.repeat(40)}:skills/internal-comms/SKILL.md`, 'source-sha256': 'b'.repeat(64),
      attribution: 'Adapted from Anthropic internal-comms (Apache-2.0); changed: rewritten as a short playbook.', keywords: 'status report, newsletter, تقرير حالة', package: 'mohassan/pilot',
    }, '## Steps\n1. Pick the format.\n2. Lead with the outcome.') });
    const enFacts = deriveCatalogueFacts(en.contract, en.files, { kind: 'local_folder', locator: '/y' });
    expect(enFacts).toMatchObject({ language: 'en', workflow: 'internal-comms', variantOf: 'internal-comms', licence: 'Apache-2.0', licenceKind: 'permissive', package: 'mohassan/pilot',
      upstream: { repo: 'anthropics/skills', revision: 'a'.repeat(40), path: 'skills/internal-comms/SKILL.md', sha256: 'b'.repeat(64) }, compatibility: 'compatible' });
    expect(enFacts.keywords).toEqual(['status report', 'newsletter', 'تقرير حالة']);
    expect(enFacts.attribution).toContain('Apache-2.0');
  });
  it('never calls a skill compatible when it needs its scripts, tools, missing files or more room than the context has', () => {
    const scripts = source('docx-maker', { 'SKILL.md': manifest({ name: 'Word files', description: 'Create Word documents from a brief.' }, 'Run `python scripts/make_docx.py brief.json` and return the file.'), 'scripts/make_docx.py': 'print(1)\n' });
    expect(deriveCatalogueFacts(scripts.contract, scripts.files, { kind: 'local_folder', locator: '/z' })).toMatchObject({ compatibility: 'requires_resources', reasons: expect.arrayContaining(['script_required:scripts/make_docx.py']) });
    const tools = source('deploy-site', { 'SKILL.md': manifest({ name: 'Deploy a site', description: 'Deploy the site to a hosting provider.', requires: 'vercel-cli, network' }, '1. Deploy.') });
    expect(deriveCatalogueFacts(tools.contract, tools.files, { kind: 'local_folder', locator: '/z' })).toMatchObject({ compatibility: 'requires_tools', requires: ['vercel-cli', 'network'] });
    const missing = source('guide-refs', { 'SKILL.md': manifest({ name: 'Guide with refs', description: 'A guide that reads its reference file.' }, 'Read references/rules.md first, then apply it.') });
    expect(deriveCatalogueFacts(missing.contract, missing.files, { kind: 'local_folder', locator: '/z' })).toMatchObject({ compatibility: 'partial', reasons: ['missing_file:references/rules.md'] });
    const long = source('long-guide', { 'SKILL.md': manifest({ name: 'Long guide', description: 'A guide longer than the context budget.' }, 'word '.repeat(1200)) });
    expect(deriveCatalogueFacts(long.contract, long.files, { kind: 'local_folder', locator: '/z' })).toMatchObject({ compatibility: 'partial', reasons: expect.arrayContaining(['body_exceeds_context']) });
    const stored = source('scripts-stored', { 'SKILL.md': manifest({ name: 'Plain guide', description: 'A guide with an unused helper script.' }, '1. Think. 2. Write.'), 'helper.py': 'print(2)\n' });
    expect(deriveCatalogueFacts(stored.contract, stored.files, { kind: 'local_folder', locator: '/z' })).toMatchObject({ compatibility: 'compatible', reasons: ['scripts_stored_not_run'] });
  });
  it('classifies licences: permissive, owner content, unknown third party, restricted', () => {
    expect(licenceKind('Apache-2.0', true)).toBe('permissive');
    expect(licenceKind('MIT', true)).toBe('permissive');
    expect(licenceKind('CC-BY-4.0 AND Apache-2.0', true)).toBe('permissive');
    expect(licenceKind('unspecified', false)).toBe('owner');
    expect(licenceKind('unspecified', true)).toBe('unknown');
    expect(licenceKind('Proprietary. LICENSE.txt has complete terms', true)).toBe('restricted');
  });
});

describe('catalogue with a database', () => {
  let store: Awaited<ReturnType<typeof createDatabase>>, root: string, skills: SkillControl;
  const owner = 'catalogue-owner', wide = 'catalogue-wide', quotaOwner = 'catalogue-quota';
  async function folder(dir: string, slug: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) { await mkdir(join(dir, 'skills', slug, ...path.split('/').slice(0, -1)), { recursive: true }); await writeFile(join(dir, 'skills', slug, ...path.split('/')), content, 'utf8'); }
  }
  async function activate(ownerId: string, id: string) {
    const version = await store.db.selectFrom('skill_versions').select(['revision', 'status']).where('id', '=', id).executeTakeFirstOrThrow();
    const inspected = version.status === 'quarantined' ? (await skills.inspect(ownerId, id, { expectedRevision: version.revision })).skill.revision : version.revision;
    return skills.activate(ownerId, id, { expectedRevision: inspected, approve: true, acknowledgeFindings: true });
  }
  async function importAll(ownerId: string, path: string, batchSize = 25) {
    let status = await skills.catalogue.importBatch(ownerId, { path, batchSize });
    for (let guard = 0; status.status === 'running' && guard < 50; guard++) status = await skills.catalogue.importBatch(ownerId, { path, batchSize });
    return status;
  }
  beforeAll(async () => {
    store = await createDatabase(); await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db); await skillsMigration(store.db);
    for (const id of [owner, wide, quotaOwner]) await store.db.insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
    root = await mkdtemp(join(tmpdir(), 'skill-catalogue-'));
    skills = createSkillControl(store.db, { enabled: true, allowedRoots: [root] });
  });
  afterAll(async () => { await store?.close(); await rm(root, { recursive: true, force: true }); });

  it('routes to an active skill past every alphabetical window, and forgets it once revoked', async () => {
    const pkg = join(root, 'wide');
    await folder(pkg, 'zzzz-needle-target', { 'SKILL.md': manifest({ name: 'Needle checklist', description: 'Follow the needle checklist for haystack audits.' }, '## Steps\n1. Find the needle.') });
    await folder(pkg, 'filler-template', { 'SKILL.md': manifest({ name: 'Filler template', description: 'A template used to copy filler rows.' }, 'Filler.') });
    const status = await importAll(wide, pkg);
    expect(status).toMatchObject({ status: 'succeeded', counts: { imported: 2 } });
    const target = status.items.find(item => item.slug === 'zzzz-needle-target')!.versionId!;
    await activate(wide, target);
    const template = await store.db.selectFrom('skill_versions').selectAll().where('owner_id', '=', wide).where('id', '=', status.items.find(item => item.slug === 'filler-template')!.versionId!).executeTakeFirstOrThrow();
    const rows = Array.from({ length: 1300 }, (_, n) => ({ id: randomUUID(), family: randomUUID(), slug: `aaa-${String(n).padStart(4, '0')}` }));
    await store.db.insertInto('skill_families').values(rows.map(row => ({ id: row.family, owner_id: wide, slug: row.slug, active_version_id: row.id }))).execute();
    for (let n = 0; n < rows.length; n += 200) {
      await store.db.insertInto('skill_versions').values(rows.slice(n, n + 200).map(row => ({ ...template, id: row.id, family_id: row.family, status: 'active', content_hash: sha256(row.id), contract: JSON.stringify(template.contract) }))).execute();
    }
    // The windows the chat used before: 1,250 by slug for the model prompt, 1,300 for the reader. Neither reaches the target.
    expect((await preloadInstructionMetadata(store.db, wide, 1250)).some(skill => skill.id === target)).toBe(false);
    const snapshot = await skills.catalogue.snapshot(wide);
    expect(snapshot.entries.length).toBe(1301);
    expect(snapshot.entries.at(-1)!.id).toBe(target);
    expect(snapshot.memo('probe', entries => ({ size: entries.length }))).toBe(snapshot.memo('probe', () => ({ size: -1 })));
    expect((await skills.context(wide, 'needle haystack audit')).skills.map(skill => skill.id)).toContain(target);
    const detail = await skills.detail(wide, target);
    await skills.revoke(wide, target, { expectedRevision: detail.skill.revision, reason: 'catalogue test revoke' });
    const after = await skills.catalogue.snapshot(wide);
    expect(after.fingerprint).not.toBe(snapshot.fingerprint);
    expect(after.entries.some(skill => skill.id === target)).toBe(false);
    expect((await skills.context(wide, 'needle haystack audit')).skills.map(skill => skill.id)).not.toContain(target);
  });

  it('imports a package in bounded, resumable batches; a second run creates nothing; changed content is checked again', async () => {
    const pkg = join(root, 'pilot');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'catalogue.json'), JSON.stringify({ package: 'mohassan/pilot-test' }), 'utf8');
    await folder(pkg, 'status-report', { 'SKILL.md': manifest({ name: 'Status report', description: 'Write a weekly status report for a team: progress, plans, problems.', language: 'en', workflow: 'status-report' }, '## Steps\n1. Progress.\n2. Plans.\n3. Problems.') });
    await folder(pkg, 'status-report-ar', { 'SKILL.md': manifest({ name: 'تقرير حالة أسبوعي', description: 'اكتب تقرير حالة أسبوعيًا لفريقك: التقدم والخطط والمشكلات.', 'variant-of': 'status-report' }, '## الخطوات\n1. التقدم.\n2. الخطط.\n3. المشكلات.') });
    await folder(pkg, 'word-files', { 'SKILL.md': manifest({ name: 'Word files', description: 'Create Word documents with a helper script.' }, 'Run `python scripts/make.py` to build the file.'), 'scripts/make.py': 'print(1)\n' });
    await folder(pkg, 'bad-binary', { 'SKILL.md': manifest({ name: 'Bad binary', description: 'A folder with an unsupported file type.' }, 'Body.'), 'logo.png': 'not really a png' });
    await folder(pkg, 'meeting-notes', { 'SKILL.md': manifest({ name: 'Meeting notes', description: 'Turn a meeting into decisions, owners and dates.' }, '## Steps\n1. Decisions.\n2. Owners.\n3. Dates.') });
    await mkdir(join(pkg, 'skills', 'Not_A_Slug'), { recursive: true });

    const first = await skills.catalogue.importBatch(owner, { path: pkg, batchSize: 2 });
    expect(first).toMatchObject({ status: 'running', resumed: false, package: 'mohassan/pilot-test', progress: { processed: 2, total: 5 } });
    expect(first.items.map(item => item.slug)).toEqual(['bad-binary', 'meeting-notes']);
    expect(first.items[0]).toMatchObject({ outcome: 'rejected', code: 'SKILL_FILE_UNSUPPORTED' });
    // A batch that died holding its claim: the claim expires, and the next request continues the same run.
    await store.db.updateTable('skill_catalogue_imports').set({ claim: randomUUID(), heartbeat_at: new Date() }).where('id', '=', first.runId).execute();
    await expect(skills.catalogue.importBatch(owner, { path: pkg, batchSize: 2 })).rejects.toMatchObject({ code: 'SKILL_IMPORT_BUSY' });
    await store.db.updateTable('skill_catalogue_imports').set({ heartbeat_at: new Date(Date.now() - 10 * 60_000) }).where('id', '=', first.runId).execute();
    const second = await skills.catalogue.importBatch(owner, { path: pkg, batchSize: 2 });
    expect(second).toMatchObject({ runId: first.runId, resumed: true, status: 'running', progress: { processed: 4, total: 5 } });
    const third = await skills.catalogue.importBatch(owner, { path: pkg, batchSize: 2 });
    expect(third).toMatchObject({ runId: first.runId, status: 'succeeded', progress: { processed: 5, total: 5 }, counts: { imported: 4, rejected: 1, errors: 1 } });
    const versionsBefore = Number((await store.db.selectFrom('skill_versions').select(eb => eb.fn.countAll<string>().as('n')).where('owner_id', '=', owner).executeTakeFirstOrThrow()).n);

    const again = await importAll(owner, pkg);
    expect(again).toMatchObject({ status: 'succeeded', counts: { imported: 0, unchanged: 4, rejected: 1 } });
    expect(again.runId).not.toBe(first.runId);
    expect(Number((await store.db.selectFrom('skill_versions').select(eb => eb.fn.countAll<string>().as('n')).where('owner_id', '=', owner).executeTakeFirstOrThrow()).n)).toBe(versionsBefore);

    const meeting = [...first.items, ...second.items, ...third.items].find(item => item.slug === 'meeting-notes')!;
    await activate(owner, meeting.versionId!);
    const suiteHash = sha256('meeting-notes-suite-v1');
    await skills.catalogue.recordEvidence(owner, { versionId: meeting.versionId!, contentHash: meeting.contentHash!, suite: 'pilot-v1', suiteHash, passed: 3, total: 3, detail: { cases: 3 } });
    await expect(skills.catalogue.recordEvidence(owner, { versionId: meeting.versionId!, contentHash: 'f'.repeat(64), suite: 'pilot-v1', suiteHash, passed: 3, total: 3, detail: {} })).rejects.toMatchObject({ code: 'SKILL_EVIDENCE_STALE' });

    const all = await skills.catalogue.search(owner, {});
    expect(all.counts).toMatchObject({ families: 4, versions: 4, active: 1, behaviourallyTested: 1, structurallyValid: 4, languageVariants: 2, packages: { 'mohassan/pilot-test': 4 } });
    expect(all.counts.compatibility).toEqual({ compatible: 3, requires_resources: 1 });
    const ar = all.items.find(item => item.slug === 'status-report-ar')!;
    expect(ar.relations).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'status-report', relation: 'language_variant', signal: 'declared' })]));
    expect((await skills.catalogue.search(owner, { q: 'تقرير حالة' })).items[0].slug).toBe('status-report-ar');
    expect((await skills.catalogue.search(owner, { q: 'weekly status report' })).items[0].slug).toBe('status-report');
    expect((await skills.catalogue.search(owner, { compatibility: 'requires_resources' })).items.map(item => item.slug)).toEqual(['word-files']);
    expect((await skills.catalogue.search(owner, { status: 'active' })).items.map(item => item.slug)).toEqual(['meeting-notes']);
    expect((await skills.catalogue.search(owner, { tested: 'true' })).items.map(item => item.slug)).toEqual(['meeting-notes']);
    const none = await skills.catalogue.search(owner, { q: 'xylophone tuning for submarines' });
    expect(none).toMatchObject({ items: [], total: 0, counts: { families: 4 } });

    // Upstream changed: a new version, quarantined and inspected again; the active one keeps working; the evidence stays with the old content.
    await writeFile(join(pkg, 'skills', 'meeting-notes', 'SKILL.md'), manifest({ name: 'Meeting notes', description: 'Turn a meeting into decisions, owners, dates and risks.', version: '1.1.0' }, '## Steps\n1. Decisions.\n2. Owners.\n3. Dates.\n4. Risks.'), 'utf8');
    const update = await importAll(owner, pkg);
    expect(update).toMatchObject({ status: 'succeeded', counts: { imported: 1, unchanged: 3 } });
    const changed = update.items.find(item => item.slug === 'meeting-notes')!;
    expect(changed.versionId).not.toBe(meeting.versionId);
    const fresh = await store.db.selectFrom('skill_versions').select(['status']).where('id', '=', changed.versionId!).executeTakeFirstOrThrow();
    expect(fresh.status).toBe('inspected');
    const family = await store.db.selectFrom('skill_families').select('active_version_id').where('owner_id', '=', owner).where('slug', '=', 'meeting-notes').executeTakeFirstOrThrow();
    expect(family.active_version_id).toBe(meeting.versionId);
  });

  it('stops at the version quota without losing progress, and resumes once there is room', async () => {
    const pkg = join(root, 'quota');
    for (const slug of ['quota-a', 'quota-b', 'quota-c']) await folder(pkg, slug, { 'SKILL.md': manifest({ name: `Quota ${slug}`, description: `Fixture skill ${slug} for the quota test.` }, '1. Step.') });
    const family = randomUUID(), versions = Array.from({ length: 199 }, () => randomUUID());
    await store.db.insertInto('skill_families').values({ id: family, owner_id: quotaOwner, slug: 'quota-filler' }).execute();
    await store.db.insertInto('skill_versions').values(versions.map((id, n) => ({ id, family_id: family, owner_id: quotaOwner, version: `1.0.${n}`, sequence: n + 1, name: 'Quota filler', description: 'Filler version for the quota test.',
      category: 'reasoning', level: 'instruction', origin: 'local_import', status: 'inspected', contract: JSON.stringify({ slug: 'quota-filler', name: 'Quota filler', description: 'Filler version for the quota test.', version: `1.0.${n}`, category: 'reasoning', level: 'instruction' }), content_hash: sha256(id) }))).execute();
    await store.db.insertInto('skill_sources').values(versions.map(id => ({ version_id: id, kind: 'local_folder', locator: '/filler', file_count: 1, total_bytes: 10 }))).execute();
    const blocked = await importAll(quotaOwner, pkg);
    expect(blocked).toMatchObject({ status: 'failed', errorCode: 'SKILL_QUOTA_EXCEEDED', counts: { imported: 1 }, quota: { used: 200, limit: 200 } });
    await store.db.deleteFrom('skill_versions').where('id', 'in', versions.slice(0, 10)).execute();
    const resumed = await importAll(quotaOwner, pkg);
    expect(resumed).toMatchObject({ status: 'succeeded', counts: { unchanged: 1, imported: 2 } });
  });
});
