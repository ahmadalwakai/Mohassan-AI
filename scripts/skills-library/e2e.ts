/**
 * End to end: feeds skills-library/skills through the real GitHub sync (import → quarantine → inspection →
 * activateByPolicy) using an in-memory transport and an embedded, empty database; then asks the real
 * instruction-context builder (router + skill graph + compiler, 4000-char budget) which skills reach the chat.
 *
 *   npx tsx scripts/skills-library/e2e.ts            sync + dev sets
 *   npx tsx scripts/skills-library/e2e.ts --final    also the sealed and real sets (run once)
 *   npx tsx scripts/skills-library/e2e.ts --github owner/repo   read the published repository through the real
 *                                                    restricted Git transport instead of the local folder
 *
 * SKILLS_ENGINE_DIR selects the checkout whose sync code runs (default: the skill-remote-github worktree,
 * until that branch merges). No network, no DATABASE_URL: createDatabase() without a connection string is embedded.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const ENGINE = resolve(process.env.SKILLS_ENGINE_DIR ?? join(ROOT, '.claude/worktrees/skill-remote-github'));
const LIBRARY = join(ROOT, 'skills-library', 'skills');
const EVAL = join(ROOT, 'artifacts', 'skills-library-2026-11-22');
const FINAL = process.argv.includes('--final');
const GITHUB = process.argv.includes('--github') ? process.argv[process.argv.indexOf('--github') + 1] ?? null : null;
const READER = process.argv.includes('--reader'); // also ask the engine's model-free skill reader (apps/server/src/assistant/skill-reader.ts) when it exists
if (GITHUB !== null && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(GITHUB)) throw new Error('--github needs owner/repo');
const OWNER = 'skills-library-e2e-owner';
const FROZEN: Record<string, string> = {
  'questions-agent-v1.jsonl': '8445fcb76fff14c507f548535cd44cf8373fac7550b9ee97d1ca8ebb8501f9a6',
  'questions-agent-none-dev-v1.jsonl': '4c05faa7338ca3119a43becf53648b2de158d563e87f62c4ad3a0268a782a8eb',
  'real-labels-v1.json': 'edc11ac36a438cc803c8affb9cc74d61eafddf298a60361754d19dd63e5750ce',
  '../plan-2026-11-22/real-questions-v1.jsonl': '90fb3590e5bc3b767ed8aca41ee1a57b503f9570022fb626169bec6c1b127bf5',
};
if (process.env.DATABASE_URL) delete process.env.DATABASE_URL; // belt and braces: this run must never reach a real database

const load = (relative: string) => import(pathToFileURL(join(ENGINE, relative)).href);
const sha = (value: string | Uint8Array, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const oid = (value: string | Uint8Array) => sha(value, 'sha1');

async function readLibrary(): Promise<Map<string, Map<string, Uint8Array>>> {
  const skills = new Map<string, Map<string, Uint8Array>>();
  for (const slug of (await readdir(LIBRARY)).sort()) {
    const files = new Map<string, Uint8Array>();
    const walk = async (dir: string, prefix: string) => {
      for (const name of (await readdir(dir)).sort()) {
        const full = join(dir, name), path = prefix ? `${prefix}/${name}` : name;
        if ((await lstat(full)).isDirectory()) await walk(full, path); else files.set(path, new Uint8Array(await readFile(full)));
      }
    };
    if ((await lstat(join(LIBRARY, slug))).isDirectory()) { await walk(join(LIBRARY, slug), ''); skills.set(slug, files); }
  }
  return skills;
}

/** The repository as the sync sees it. Object ids derive from content, as in Git. */
function folderTransport(skills: Map<string, Map<string, Uint8Array>>) {
  const blobs = new Map<string, Uint8Array>();
  const tree = (slug: string) => oid(JSON.stringify([...skills.get(slug)!.entries()].map(([path, bytes]) => [path, oid(bytes)])));
  const commit = oid(JSON.stringify([...skills.keys()].map(slug => [slug, tree(slug)])));
  return {
    async head() { return commit; },
    async ensure(value: string) { return value; },
    async children() { return [...skills.keys()].map(slug => ({ mode: '040000', type: 'tree', objectId: tree(slug), size: null, path: slug })); },
    async entries(_commit: string, slug: string) {
      return [...(skills.get(slug) ?? new Map()).entries()].map(([path, bytes]) => { const id = oid(bytes); blobs.set(id, bytes); return { mode: '100644', type: 'blob', objectId: id, size: bytes.byteLength, path }; });
    },
    async blob(objectId: string, maxBytes: number) {
      const bytes = blobs.get(objectId);
      if (!bytes) throw Object.assign(new Error('missing object'), { code: 'GIT_REMOTE_UNREACHABLE' });
      if (bytes.byteLength > maxBytes) throw Object.assign(new Error('too large'), { code: 'GIT_REMOTE_TOO_LARGE' });
      return bytes;
    },
  };
}

interface Question { id: string; text: string; ok: string[]; need: boolean }
const jsonl = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
async function frozen(name: string) {
  const text = await readFile(join(EVAL, name), 'utf8');
  if (sha(text) !== FROZEN[name]) throw new Error(`${name} changed since it was frozen; refusing to score.`);
  return text;
}
async function questionSets(): Promise<Record<string, Question[]>> {
  const agent = jsonl(await frozen('questions-agent-v1.jsonl'));
  const sets: Record<string, Question[]> = {
    dev: agent.filter((q: any) => q.set === 'dev').map((q: any) => ({ ...q, need: true })),
    'none-dev': jsonl(await frozen('questions-agent-none-dev-v1.jsonl')).map((q: any) => ({ ...q, need: false })),
  };
  if (FINAL) {
    sets.sealed = agent.filter((q: any) => q.set === 'sealed').map((q: any) => ({ ...q, need: true }));
    const labels = JSON.parse(await frozen('real-labels-v1.json')).labels;
    sets.real = jsonl(await frozen('../plan-2026-11-22/real-questions-v1.jsonl')).map((row: any) => ({ id: row.id, text: row.text, ok: labels[row.id].ok, need: labels[row.id].need }));
  }
  return sets;
}

async function main() {
  const [{ createDatabase, migrate }, { memoryMigration }, { migrateAuth }, skillsModule] = await Promise.all([
    load('packages/database/src/index.ts'), load('packages/memory/src/index.ts'), load('apps/server/src/auth.ts'), load('packages/skills/src/index.ts'),
  ]);
  const library = await readLibrary();
  const store = await createDatabase();
  if (store.mode === 'postgres') throw new Error('refusing to run against PostgreSQL');
  await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db); await skillsModule.skillsMigration(store.db);
  await store.db.insertInto('user').values({ id: OWNER, name: OWNER, email: `${OWNER}@example.test` }).execute();
  const root = await mkdtemp(join(tmpdir(), 'skills-library-e2e-'));
  const config = { repo: GITHUB ?? 'owner/skills', ref: 'main', path: 'skills', intervalMinutes: 0, autoActivate: true };
  const transport = GITHUB
    ? skillsModule.createGitSkillTransport(await mkdtemp(join(tmpdir(), 'skills-library-mirror-')), { repo: GITHUB, ref: 'main', path: 'skills' })
    : folderTransport(library);
  const control = skillsModule.createSkillControl(store.db, { enabled: true, allowedRoots: [root], remote: { config, transport } });

  const started = Date.now();
  const { syncId } = await control.remote.start(OWNER, 'manual');
  let status: any;
  for (let attempt = 0; attempt < 6000; attempt++) {
    status = await control.remote.status(OWNER);
    if (status.last?.id === syncId && status.last.status !== 'running') break;
    await new Promise(done => setTimeout(done, 50));
  }
  const syncMs = Date.now() - started;
  const items = status.last?.items ?? [];
  const notActivated = items.filter((item: any) => item.outcome !== 'activated').map((item: any) => ({ slug: item.slug, outcome: item.outcome, code: item.code, message: item.message }));
  const active = await store.db.selectFrom('skill_families as f').innerJoin('skill_versions as v', 'v.id', 'f.active_version_id')
    .select(['f.slug']).where('f.owner_id', '=', OWNER).where('v.status', '=', 'active').execute();

  const sets = await questionSets();
  const results: Record<string, any> = {};
  for (const [name, questions] of Object.entries(sets)) {
    let need = 0, first = 0, any = 0, full = 0, clean = 0, picked = 0, noise = 0, ms = 0;
    const rows = [];
    for (const question of questions) {
      const t = Date.now();
      const compiled = await control.context(OWNER, question.text, { budgetChars: 4000 });
      ms += Date.now() - t;
      const slugs: string[] = compiled.skills.map((skill: any) => skill.slug);
      const cut = new Map(compiled.sources.filter((source: any) => source.path === 'SKILL.md').map((source: any) => [source.skillId, source.truncated]));
      const ok = new Set(question.ok), bad = slugs.filter(slug => !ok.has(slug));
      picked += slugs.length; noise += bad.length; if (!bad.length) clean++;
      if (question.need) {
        need++;
        if (slugs.length && ok.has(slugs[0])) first++;
        if (slugs.some(slug => ok.has(slug))) any++;
        if (compiled.skills.some((skill: any) => ok.has(skill.slug) && cut.get(skill.id) === false)) full++;
      }
      rows.push({ id: question.id, text: question.text, need: question.need, ok: question.ok, arrived: compiled.skills.map((skill: any) => cut.get(skill.id) ? `${skill.slug}(cut)` : skill.slug), chars: compiled.text.length });
    }
    const pct = (value: number, of: number) => of ? Math.round(value / of * 1000) / 10 : null;
    results[name] = { n: questions.length, need, firstArrivedRight: pct(first, need), rightArrived: pct(any, need), rightArrivedFull: pct(full, need), cleanRate: pct(clean, questions.length), arrivedPerQuestion: Math.round(picked / questions.length * 100) / 100, noisePerQuestion: Math.round(noise / questions.length * 100) / 100, avgContextMs: Math.round(ms / questions.length), rows };
  }
  // The model-free reader answers from one active skill or abstains. Scored on the dev sets only.
  let reader: Record<string, unknown> | null = null;
  if (READER) {
    const readerModule = await load('apps/server/src/assistant/skill-reader.ts');
    const read = readerModule.createSkillReader({
      candidates: (ownerId: string) => skillsModule.preloadInstructionMetadata(store.db, ownerId),
      instructions: async (ownerId: string, id: string) => readerModule.skillInstructionText((await control.loadInstruction(ownerId, id, skillsModule.MAX_SKILL_CONTEXT_CHARS)).text),
    });
    reader = {};
    for (const name of ['dev', 'none-dev']) {
      let answered = 0, right = 0, wrong = 0, foreign = 0, asksForInputs = 0;
      const samples: unknown[] = [];
      let fullSample: unknown = null;
      for (const question of sets[name]) {
        const result = await read(OWNER, question.text, { mode: 'advice' });
        if (!result) continue;
        answered++;
        if (question.ok.includes(result.skill.slug)) right++; else wrong++;
        // The reader adds this note when the skill's body is not in the request's language.
        if (/نص هذه المهارة مكتوب بالإنجليزية|This skill is written in Arabic/u.test(result.text)) foreign++;
        if (/لأطبّق المهارة على حالتك بدقة|To tailor this to your case/u.test(result.text)) asksForInputs++;
        if (samples.length < 3) samples.push({ id: question.id, skill: result.skill.slug, head: result.text.slice(0, 160), tail: result.text.slice(-120) });
        fullSample ??= { id: question.id, skill: result.skill.slug, lang: result.lang, text: result.text };
      }
      reader[name] = { n: sets[name].length, answered, right, wrong, abstained: sets[name].length - answered, foreignNote: foreign, asksForInputs, samples, fullSample };
    }
  }
  await store.close();

  const report = { reader, ranAt: new Date().toISOString(), final: FINAL, source: GITHUB ? `github:${GITHUB}@main` : 'local folder', engine: ENGINE.replace(ROOT, '.'), library: library.size, sync: { commit: status.last?.commit ?? null, ms: syncMs, status: status.last?.status, errorCode: status.last?.errorCode ?? null, counts: status.last?.counts, notActivated, activeAfter: active.length }, results };
  const out = join(EVAL, `e2e-${GITHUB ? 'github-' : ''}${FINAL ? 'final-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`sync ${report.sync.status} in ${syncMs} ms | counts ${JSON.stringify(report.sync.counts)} | active after sync ${active.length}/${library.size}`);
  for (const item of notActivated.slice(0, 20)) console.log(`  not activated: ${item.slug} ${item.outcome} ${item.code ?? ''} ${item.message ?? ''}`);
  for (const [name, result] of Object.entries(results)) console.log(`${name.padEnd(8)} n=${String(result.n).padStart(3)} ` + (result.need ? `first-arrived-right ${result.firstArrivedRight}% right-arrived ${result.rightArrived}% (full ${result.rightArrivedFull}%) ` : '') + `clean ${result.cleanRate}% arrived/q ${result.arrivedPerQuestion} noise/q ${result.noisePerQuestion} context ${result.avgContextMs} ms`);
  if (reader) for (const [name, result] of Object.entries(reader) as [string, any][]) console.log(`reader ${name.padEnd(8)} n=${result.n} answered ${result.answered} (right ${result.right}, wrong ${result.wrong}), abstained ${result.abstained}, language note ${result.foreignNote}, asks for inputs ${result.asksForInputs}`);
  console.log(`report: ${out.replace(ROOT, '.')}`);
  if (status.last?.status !== 'succeeded' || active.length !== library.size) process.exitCode = 1;
}

await main();
