/**
 * Checks skills-library/skills the way the GitHub sync reads it, then measures which skills
 * the chat would choose for the frozen question sets in artifacts/skills-library-2026-11-22.
 *
 *   npx tsx scripts/skills-library/check.ts           static checks + dev sets (safe to repeat)
 *   npx tsx scripts/skills-library/check.ts --final   also scores the sealed and real sets (run once)
 *
 * Read-only: no database, no network, no write outside artifacts/skills-library-2026-11-22.
 * The routing variants R1 and R2 exist only here, to measure what a router change would buy.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifySkillFile, inspectSkill, INSPECTOR_VERSION } from '../../packages/skills/src/inspector.ts';
import { routeInstructionSkills, skillTerms, type SkillContextMetadata } from '../../packages/skills/src/router.ts';
import { compileInstructionContext, type InstructionDocument } from '../../packages/skills/src/compiler.ts';
import { parseSkillManifest } from '../../packages/skills/src/frontmatter.ts';
import { builtinSkills } from '../../packages/skills/src/builtin/index.ts';
import { SkillCategorySchema, SkillContractSchema } from '../../packages/contracts/src/skills.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const LIBRARY = join(ROOT, 'skills-library', 'skills');
const EVAL = join(ROOT, 'artifacts', 'skills-library-2026-11-22');
const FINAL = process.argv.includes('--final');
const BUDGET = 4000; // the chat's upper bound for skill context (brain.ts skillContextBudget)
const LIMITS = { skills: 100, files: 40, fileBytes: 64000, totalBytes: 256000, body: 1800 } as const;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,5}$/;
const CATEGORIES = new Set(['reasoning', 'coding', 'browser', 'computer', 'design', 'creativity', 'documents', 'languages', 'business', 'marketing', 'research', 'security', 'analytics', 'media']);
// Words that appear in almost any message. In a name or description they make a skill fire on chit-chat.
const GENERIC = new Set(('ما ماذا هو هي هم كيف كم هل لي لك له لها أن ان إن ثم قد لا لم لن كل بعض ذلك تلك التي الذي عند بين حتى كان يكون أي اي مثل بعد قبل غير أفضل افضل اليوم طريقة شيء شي ابي أبي أبغى ابغى وش ممكن عندي ' +
  'what how why is are my me you your can do make create get best good new help need want about from it be by at as not i we our all any more most some way thing').split(' '));
const FROZEN: Record<string, string> = {
  'questions-agent-v1.jsonl': '8445fcb76fff14c507f548535cd44cf8373fac7550b9ee97d1ca8ebb8501f9a6',
  'questions-agent-none-dev-v1.jsonl': '4c05faa7338ca3119a43becf53648b2de158d563e87f62c4ad3a0268a782a8eb',
  'real-labels-v1.json': 'edc11ac36a438cc803c8affb9cc74d61eafddf298a60361754d19dd63e5750ce',
  '../plan-2026-11-22/real-questions-v1.jsonl': '90fb3590e5bc3b767ed8aca41ee1a57b503f9570022fb626169bec6c1b127bf5',
};

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

type BuildSkillSource = (entries: { path: string; content: string }[], origin: { root: string; defaultSlug?: string }) => any;

/** A line-for-line copy of buildSkillSource (packages/skills/src/importer.ts on feat/skill-remote-github),
 * used only while the sync's own reader cannot be imported. Same schema, same fallbacks, same errors. */
const localBuildSkillSource: BuildSkillSource = (entries, origin) => {
  const files: { path: string; kind: string; content: string }[] = [];
  let contractText: string | null = null, totalBytes = 0;
  for (const entry of entries) {
    totalBytes += Buffer.byteLength(entry.content, 'utf8');
    if (entry.path === 'skill.contract.json') { contractText = entry.content; continue; }
    const kind = classifySkillFile(entry.path);
    if (!kind) throw new Error(`SKILL_FILE_UNSUPPORTED ${entry.path}`);
    files.push({ path: entry.path, kind, content: entry.content });
  }
  if (totalBytes > LIMITS.totalBytes) throw new Error('SKILL_TOO_LARGE');
  const manifestFile = files.find(file => file.path === 'SKILL.md');
  if (!manifestFile) throw new Error('SKILL_MANIFEST_MISSING');
  const manifest = parseSkillManifest(manifestFile.content);
  if (contractText !== null) {
    const parsed = SkillContractSchema.safeParse(JSON.parse(contractText));
    if (!parsed.success) throw new Error(`SKILL_CONTRACT_INVALID ${parsed.error.issues[0]?.message ?? ''}`);
    if (origin.defaultSlug !== undefined && parsed.data.slug !== origin.defaultSlug) throw new Error('SKILL_REMOTE_SLUG_MISMATCH');
    return { contract: parsed.data, files, totalBytes };
  }
  const { name, description, version, category } = manifest.fields;
  const parsed = SkillContractSchema.safeParse({
    slug: origin.defaultSlug, name: (name ?? '').trim() || 'مهارة مستوردة', description, version: version && VERSION.test(version) ? version : '1.0.0',
    category: SkillCategorySchema.safeParse(category).data ?? 'reasoning', level: 'instruction',
  });
  if (!parsed.success) throw new Error(`SKILL_MANIFEST_INVALID ${parsed.error.issues[0]?.message ?? ''}`);
  return { contract: parsed.data, files, totalBytes };
};

/** Prefers the sync's own reader; it lives in the worktree until feat/skill-remote-github merges. */
async function loadBuildSkillSource(): Promise<{ buildSkillSource: BuildSkillSource; from: string }> {
  const candidates = [join(ROOT, 'packages/skills/src/importer.ts'), join(ROOT, '.claude/worktrees/skill-remote-github/packages/skills/src/importer.ts')];
  for (const path of candidates) {
    if (!existsSync(path) || !(await readFile(path, 'utf8')).includes('export function buildSkillSource')) continue;
    try {
      const module = await import(pathToFileURL(path).href);
      return { buildSkillSource: module.buildSkillSource as BuildSkillSource, from: path };
    } catch (error) {
      console.warn(`could not import ${path} (${(error as Error).message.split('\n')[0]}); using the local copy`);
    }
  }
  return { buildSkillSource: localBuildSkillSource, from: 'scripts/skills-library/check.ts (local copy of buildSkillSource)' };
}

async function walk(dir: string, prefix = ''): Promise<{ path: string; full: string; symlink: boolean; dir: boolean }[]> {
  const out: { path: string; full: string; symlink: boolean; dir: boolean }[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const full = join(dir, name), info = await lstat(full), path = prefix ? `${prefix}/${name}` : name;
    if (info.isSymbolicLink()) out.push({ path, full, symlink: true, dir: false });
    else if (info.isDirectory()) out.push(...await walk(full, path));
    else out.push({ path, full, symlink: false, dir: false });
  }
  return out;
}

interface SkillRecord {
  slug: string; ok: boolean; problems: string[]; warnings: string[];
  metadata?: SkillContextMetadata; document?: InstructionDocument; bodyChars?: number; descriptionTerms?: number; verdict?: string; findings?: unknown[];
}

async function checkSkill(slug: string, buildSkillSource: BuildSkillSource): Promise<SkillRecord> {
  const record: SkillRecord = { slug, ok: false, problems: [], warnings: [] };
  const entries = await walk(join(LIBRARY, slug));
  if (entries.length > LIMITS.files) record.problems.push(`${entries.length} files > ${LIMITS.files}`);
  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.symlink) { record.problems.push(`symlink ${entry.path}`); continue; }
    const bytes = await readFile(entry.full);
    total += bytes.byteLength;
    if (bytes.byteLength > LIMITS.fileBytes) record.problems.push(`${entry.path} is ${bytes.byteLength} bytes > ${LIMITS.fileBytes}`);
    const kind = entry.path === 'skill.contract.json' ? 'contract' : classifySkillFile(entry.path);
    if (!kind) record.problems.push(`unsupported file ${entry.path}`);
    if (kind === 'script') record.problems.push(`script ${entry.path} blocks auto-activation (HAS_SCRIPTS)`);
    if (kind === 'contract') record.warnings.push('skill.contract.json present: the manifest fields are ignored');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { record.problems.push(`${entry.path} is not UTF-8`); continue; }
    files.push({ path: entry.path, content });
  }
  if (total > LIMITS.totalBytes) record.problems.push(`total ${total} bytes > ${LIMITS.totalBytes}`);
  let source: any;
  try { source = buildSkillSource(files, { root: `github:owner/skills@local:skills/${slug}`, defaultSlug: slug }); }
  catch (error) { record.problems.push(`sync reader refused it: ${(error as Error).message}`); return record; }
  const contract = source.contract;
  const manifest = parseSkillManifest(files.find(file => file.path === 'SKILL.md')!.content);
  if (!CATEGORIES.has(manifest.fields.category ?? '')) record.problems.push(`category "${manifest.fields.category ?? ''}" missing or unknown (would fall back to reasoning)`);
  if (!VERSION.test(manifest.fields.version ?? '')) record.problems.push('version missing or not x.y.z');
  if (contract.level !== 'instruction' || contract.requires.tools.length || contract.requires.scopes.length || contract.requires.paths.length || contract.sideEffects !== 'none') record.problems.push('not a plain instruction skill (REQUESTS_ACCESS)');
  if (contract.name.length > 100 || contract.description.length > 1000) record.problems.push('name or description beyond the preload bounds');
  const inspection = inspectSkill(contract, source.files);
  record.verdict = inspection.verdict; record.findings = inspection.findings;
  if (inspection.verdict !== 'pass') record.problems.push(`inspector verdict ${inspection.verdict}`);
  if (inspection.findings.length) record.problems.push(...inspection.findings.map((finding: any) => `finding ${finding.code} (${finding.severity}) ${finding.path ?? ''}:${finding.line ?? ''}`));
  record.bodyChars = manifest.body.length;
  if (manifest.body.length > LIMITS.body) record.warnings.push(`body ${manifest.body.length} chars > ${LIMITS.body}: two skills will not fit in ${BUDGET}`);
  const descriptionTerms = skillTerms(contract.description);
  record.descriptionTerms = new Set(descriptionTerms).size;
  if (skillTerms(`${contract.description} x`).length >= 100) record.warnings.push('description has 100+ terms; the router reads only the first 100');
  const generic = [...new Set(skillTerms(`${contract.name} ${contract.description}`).filter(term => GENERIC.has(term)))];
  if (generic.length) record.warnings.push(`generic words in name/description: ${generic.join(' ')}`);
  record.metadata = { id: slug, slug, name: contract.name, description: contract.description, category: contract.category, version: contract.version, contentHash: sha256(JSON.stringify(files)) };
  record.document = { metadata: record.metadata, files: source.files.map((file: any) => ({ path: file.path, kind: file.kind, content: file.content, contentHash: sha256(file.content) })) };
  record.ok = record.problems.length === 0;
  return record;
}

// ---- Routing variants (measurement only) ---------------------------------------------------
const CATEGORY_WORDS: Record<string, string> = {
  reasoning: 'reasoning planning plan تحليل تخطيط خطة استدلال', coding: 'coding code software program typescript javascript python برمجة كود برنامج تطبيق',
  browser: 'browser web navigate website متصفح تصفح موقع', computer: 'computer desktop windows حاسوب كمبيوتر سطح مكتب', design: 'design ui ux interface تصميم واجهة ألوان',
  creativity: 'creativity creative ideas إبداع أفكار ابتكار', documents: 'documents document report pdf word مستند وثيقة تقرير', languages: 'languages translate translation لغة ترجمة لغات',
  business: 'business company strategy أعمال شركة استراتيجية', marketing: 'marketing campaign ads تسويق حملة إعلان', research: 'research sources evidence search بحث مصادر أدلة',
  security: 'security audit permissions أمان أمن تدقيق صلاحيات', analytics: 'analytics data analysis statistics بيانات إحصاء تحليلات', media: 'media image video audio صورة فيديو صوت',
};
function normalizeTerm(term: string): string {
  let t = term.replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ـ/g, '');
  if (/[؀-ۿ]/.test(t)) {
    for (const prefix of ['وبال', 'وال', 'بال', 'كال', 'فال', 'لل', 'ال', 'و', 'ف', 'ب', 'ل', 'ك']) if (t.startsWith(prefix) && t.length - prefix.length >= 3) { t = t.slice(prefix.length); break; }
    for (const suffix of ['ات', 'ون', 'ين']) if (t.endsWith(suffix) && t.length - suffix.length >= 3) { t = t.slice(0, -suffix.length); break; }
    for (const suffix of ['ها', 'هم', 'كم', 'نا', 'ي', 'ك']) if (t.endsWith(suffix) && t.length - suffix.length >= 3) { t = t.slice(0, -suffix.length); if (t.endsWith('ت') && t.length >= 4) t = `${t.slice(0, -1)}ه`; break; }
  } else if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  return t;
}
/** Same scoring as routeInstructionSkills, with two optional changes: Arabic normalization of terms,
 * and category words that only break ties instead of selecting a skill on their own. */
function routeVariant(goal: string, candidates: readonly SkillContextMetadata[], variant: { normalize: boolean; categoryTieBreakOnly: boolean }): SkillContextMetadata[] {
  const termsOf = (text: string) => variant.normalize ? [...new Set(skillTerms(text).map(normalizeTerm))] : skillTerms(text);
  const terms = termsOf(goal.slice(0, 16000));
  if (!terms.length) return [];
  const overlap = (text: string) => { const words = new Set(termsOf(text)); return terms.filter(term => words.has(term)).length; };
  return candidates.slice(0, 200).map(skill => {
    const content = overlap(skill.slug.replace(/-/g, ' ')) * 6 + overlap(skill.name) * 4 + overlap(skill.description) * 2;
    const category = overlap(CATEGORY_WORDS[skill.category]);
    return { skill, score: variant.categoryTieBreakOnly && content === 0 ? 0 : content + category };
  }).filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.slug.localeCompare(b.skill.slug, 'en'))
    .slice(0, 6).map(entry => entry.skill);
}

// ---- Question sets ---------------------------------------------------------------------------
interface Question { id: string; set: string; text: string; ok: string[]; need: boolean; skill?: string }
const jsonl = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
async function frozen(name: string): Promise<string> {
  const text = await readFile(join(EVAL, name), 'utf8');
  if (sha256(text) !== FROZEN[name]) throw new Error(`${name} changed since it was frozen; refusing to score.`);
  return text;
}
async function questionSets(): Promise<Record<string, Question[]>> {
  const agent = jsonl(await frozen('questions-agent-v1.jsonl')) as Question[];
  const none = jsonl(await frozen('questions-agent-none-dev-v1.jsonl')) as Question[];
  const sets: Record<string, Question[]> = {
    dev: agent.filter(q => q.set === 'dev').map(q => ({ ...q, need: true })),
    'none-dev': none.map(q => ({ ...q, need: false })),
  };
  if (FINAL) {
    sets.sealed = agent.filter(q => q.set === 'sealed').map(q => ({ ...q, need: true }));
    const labels = JSON.parse(await frozen('real-labels-v1.json')).labels as Record<string, { need: boolean; ok: string[] }>;
    sets.real = (jsonl(await frozen('../plan-2026-11-22/real-questions-v1.jsonl')) as { id: string; text: string }[])
      .map(row => ({ id: row.id, set: 'real', text: row.text, ok: labels[row.id].ok, need: labels[row.id].need }));
  }
  return sets;
}

type Router = (goal: string, candidates: readonly SkillContextMetadata[]) => SkillContextMetadata[];
// R0 is the production router. The others exist only to measure what a router change would buy.
const ROUTERS: Record<string, Router> = {
  R0: (goal, candidates) => routeInstructionSkills(goal, candidates, 6),
  R0c: (goal, candidates) => routeVariant(goal, candidates, { normalize: false, categoryTieBreakOnly: true }),
  R1: (goal, candidates) => routeVariant(goal, candidates, { normalize: true, categoryTieBreakOnly: false }),
  R1c: (goal, candidates) => routeVariant(goal, candidates, { normalize: true, categoryTieBreakOnly: true }),
};

function score(questions: Question[], candidates: SkillContextMetadata[], documents: Map<string, InstructionDocument>, router: Router) {
  let need = 0, hit1 = 0, hit3 = 0, hit6 = 0, arrivedFull = 0, arrivedAny = 0, selected = 0, noise = 0, clean = 0, empty = 0;
  const rows = questions.map(question => {
    const routed = router(question.text, candidates).map(skill => skill.slug);
    const compiled = compileInstructionContext(routed.map(slug => documents.get(slug)!), question.text, BUDGET);
    const main = new Map(compiled.sources.filter(source => source.path === 'SKILL.md').map(source => [source.skillId, source.truncated]));
    const ok = new Set(question.ok), bad = routed.filter(slug => !ok.has(slug));
    selected += routed.length; noise += bad.length; if (!bad.length) clean++; if (!routed.length) empty++;
    if (question.need) {
      need++;
      if (routed.slice(0, 1).some(slug => ok.has(slug))) hit1++;
      if (routed.slice(0, 3).some(slug => ok.has(slug))) hit3++;
      if (routed.some(slug => ok.has(slug))) hit6++;
      const arrived = [...main.entries()].filter(([slug]) => ok.has(slug));
      if (arrived.length) arrivedAny++;
      if (arrived.some(([, truncated]) => !truncated)) arrivedFull++;
    }
    return { id: question.id, text: question.text, need: question.need, ok: question.ok, routed, arrived: [...main.entries()].map(([slug, truncated]) => truncated ? `${slug}(cut)` : slug), contextChars: compiled.text.length };
  });
  const pct = (value: number, of: number) => of ? Math.round((value / of) * 1000) / 10 : null;
  return {
    n: questions.length, need, hit1: pct(hit1, need), hit3: pct(hit3, need), hit6: pct(hit6, need), arrivedFull: pct(arrivedFull, need), arrivedAny: pct(arrivedAny, need),
    cleanRate: pct(clean, questions.length), avgSelected: Math.round((selected / Math.max(1, questions.length)) * 100) / 100, noisePerQuestion: Math.round((noise / Math.max(1, questions.length)) * 100) / 100, emptyRate: pct(empty, questions.length), rows,
  };
}

async function main() {
  const { buildSkillSource, from } = await loadBuildSkillSource();
  if (!existsSync(LIBRARY)) throw new Error(`${LIBRARY} does not exist yet.`);
  const slugs = (await readdir(LIBRARY, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const extras = (await readdir(LIBRARY, { withFileTypes: true })).filter(entry => !entry.isDirectory()).map(entry => entry.name);
  const records = await Promise.all(slugs.map(slug => checkSkill(slug, buildSkillSource)));
  const names = new Map<string, string[]>();
  for (const record of records) if (record.metadata) names.set(record.metadata.name, [...(names.get(record.metadata.name) ?? []), record.slug]);
  for (const [name, owners] of names) if (owners.length > 1) for (const owner of owners) records.find(record => record.slug === owner)!.problems.push(`name "${name}" shared with ${owners.join(', ')}`);
  for (const record of records) record.ok = record.problems.length === 0;
  const builtinSlugs = new Set(builtinSkills.map(skill => skill.contract.slug));
  const clashes = slugs.filter(slug => builtinSlugs.has(slug));
  const bodies = records.map(record => record.bodyChars ?? 0).sort((a, b) => a - b);

  const library = records.filter(record => record.metadata);
  const documents = new Map(library.map(record => [record.slug, record.document!] as const));
  const builtinMeta: SkillContextMetadata[] = builtinSkills.map(skill => ({ id: skill.contract.slug, slug: skill.contract.slug, name: skill.contract.name, description: skill.contract.description, category: skill.contract.category, version: skill.contract.version, contentHash: sha256(skill.instructions) }));
  for (const skill of builtinSkills) documents.set(skill.contract.slug, { metadata: builtinMeta.find(meta => meta.slug === skill.contract.slug)!, files: [{ path: 'SKILL.md', kind: 'instructions', content: skill.instructions, contentHash: sha256(skill.instructions) }] });
  const pools = { library: library.map(record => record.metadata!).sort((a, b) => a.slug.localeCompare(b.slug, 'en')), withBuiltins: [...library.map(record => record.metadata!), ...builtinMeta].sort((a, b) => a.slug.localeCompare(b.slug, 'en')) };

  const sets = await questionSets();
  const known = new Set([...slugs, ...builtinSlugs]);
  const unknownLabels = [...new Set(Object.values(sets).flat().flatMap(question => question.ok).filter(slug => !known.has(slug)))];
  const routing: Record<string, Record<string, Record<string, ReturnType<typeof score>>>> = {};
  for (const [poolName, pool] of Object.entries(pools)) {
    routing[poolName] = {};
    for (const [routerName, router] of Object.entries(ROUTERS)) {
      routing[poolName][routerName] = {};
      for (const [setName, questions] of Object.entries(sets)) routing[poolName][routerName][setName] = score(questions, pool, documents, router);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    checkedAt: new Date().toISOString(), final: FINAL, syncReader: from.replace(ROOT, '.'), inspectorVersion: INSPECTOR_VERSION,
    static: { skills: slugs.length, limit: LIMITS.skills, overLimit: slugs.length > LIMITS.skills, pass: records.filter(record => record.ok).length, failing: records.filter(record => !record.ok).map(record => ({ slug: record.slug, problems: record.problems })), warnings: records.filter(record => record.warnings.length).map(record => ({ slug: record.slug, warnings: record.warnings })), builtinClashes: clashes, strayFiles: extras, bodyChars: { min: bodies[0], median: bodies[Math.floor(bodies.length / 2)], max: bodies.at(-1) } },
    unknownLabels,
    routing,
  };
  await mkdir(EVAL, { recursive: true });
  const out = join(EVAL, `check-${FINAL ? 'final-' : ''}${stamp}.json`);
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);

  const s = report.static;
  console.log(`skills ${s.skills}/${s.limit}${s.overLimit ? ' OVER LIMIT' : ''} | pass ${s.pass} | failing ${s.failing.length} | warnings ${s.warnings.length} | body chars min ${s.bodyChars.min} median ${s.bodyChars.median} max ${s.bodyChars.max} | builtin clashes ${clashes.length} | stray files ${extras.join(',') || 'none'}`);
  for (const failing of s.failing) console.log(`  FAIL ${failing.slug}: ${failing.problems.join(' ; ')}`);
  for (const warning of s.warnings) console.log(`  warn ${warning.slug}: ${warning.warnings.join(' ; ')}`);
  if (unknownLabels.length) console.log(`  labels naming no skill: ${unknownLabels.join(', ')}`);
  for (const [poolName, byRouter] of Object.entries(routing)) for (const [routerName, bySet] of Object.entries(byRouter)) for (const [setName, result] of Object.entries(bySet)) {
    console.log(`${poolName.padEnd(12)} ${routerName} ${setName.padEnd(8)} n=${String(result.n).padStart(3)} ` + (result.need ? `hit@1 ${result.hit1}% hit@3 ${result.hit3}% hit@6 ${result.hit6}% arrived ${result.arrivedAny}% (full ${result.arrivedFull}%) ` : '') + `clean ${result.cleanRate}% picked/q ${result.avgSelected} noise/q ${result.noisePerQuestion}`);
  }
  console.log(`report: ${out.replace(ROOT, '.')}`);
  if (s.failing.length || s.overLimit) process.exitCode = 1;
}

await main();
