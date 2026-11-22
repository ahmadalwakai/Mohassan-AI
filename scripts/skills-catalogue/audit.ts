/**
 * Audit of the skill sources this checkout can verify: each folder goes through the real importer
 * (`buildSkillSource`), the real inspector and the real context compiler. Test fixtures are counted
 * apart and never as skills. Prints JSON; nothing is imported into a database.
 *
 *   npx tsx scripts/skills-catalogue/audit.ts [--out artifacts/skills-catalogue/audit.json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { buildSkillSource } from '../../packages/skills/src/importer.ts';
import { inspectSkill } from '../../packages/skills/src/inspector.ts';
import { parseSkillManifest } from '../../packages/skills/src/frontmatter.ts';
import { compileInstructionContext, DEFAULT_SKILL_CONTEXT_CHARS, type InstructionDocument } from '../../packages/skills/src/compiler.ts';

const SOURCES = [
  { label: 'repo skills/', dir: 'skills', production: true },
  { label: 'owner library (skills-library/skills)', dir: join('skills-library', 'skills'), production: true },
  { label: 'test fixtures (excluded)', dir: join('tests', 'fixtures', 'skills', 'benchmarks'), production: false },
] as const;
/** The documented guidance (skills-library/README.md); the code enforces only the compiled context budget. */
const BODY_GUIDANCE = 1800;

interface Row {
  source: string; production: boolean; slug: string; ok: boolean; error?: string; level?: string; category?: string; version?: string; verdict?: string;
  findings?: string[]; bodyChars?: number; language?: 'ar' | 'en'; fileCount?: number; frontmatterKeys?: string[]; name?: string; description?: string; body?: string;
}

async function files(root: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push({ path: relative(root, full).split('\\').join('/'), content: await readFile(full, 'utf8') });
    }
  }
  await walk(root);
  return out;
}
const language = (text: string): 'ar' | 'en' => ((text.match(/\p{Script=Arabic}/gu)?.length ?? 0) >= (text.match(/[A-Za-z]/gu)?.length ?? 0) ? 'ar' : 'en');
function gitHead(dir: string): string | null {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

function documentOf(row: Row, index: number, body = row.body ?? ''): InstructionDocument {
  return {
    metadata: { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, slug: row.slug, name: row.name ?? row.slug, description: row.description ?? '', category: (row.category ?? 'reasoning') as InstructionDocument['metadata']['category'], version: row.version ?? '1.0.0', contentHash: 'a'.repeat(64) },
    files: [{ path: 'SKILL.md', kind: 'instructions', content: ['---', 'name: audit', 'description: audit document', '---', body].join('\n'), contentHash: 'b'.repeat(64) }],
  };
}

async function main() {
  const at = process.argv.indexOf('--out');
  const out = at >= 0 ? process.argv[at + 1] : null;
  const commit = gitHead('.');
  const rows: Row[] = [];
  const sources: Record<string, unknown>[] = [];
  for (const source of SOURCES) {
    if (!existsSync(source.dir)) { sources.push({ ...source, present: false }); continue; }
    const folders = (await readdir(source.dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    let valid = 0;
    for (const folder of folders) {
      const root = join(source.dir, folder);
      const row: Row = { source: source.label, production: source.production, slug: folder, ok: false };
      try {
        const built = buildSkillSource(await files(root), { root, defaultSlug: folder });
        const manifest = parseSkillManifest(built.files.find(file => file.path === 'SKILL.md')!.content);
        const inspection = inspectSkill(built.contract, built.files);
        Object.assign(row, {
          ok: true, level: built.contract.level, category: built.contract.category, version: built.contract.version, verdict: inspection.verdict,
          findings: inspection.findings.map(finding => finding.code), bodyChars: manifest.body.length, language: language(manifest.body), fileCount: built.files.length,
          frontmatterKeys: Object.keys(manifest.fields).sort(), body: manifest.body, name: built.contract.name, description: built.contract.description,
        });
        valid++;
      } catch (error) { row.error = (error as { code?: string }).code ?? String(error); }
      rows.push(row);
    }
    const head = gitHead(source.dir);
    sources.push({ label: source.label, dir: source.dir, production: source.production, present: true, folders: folders.length, structurallyValid: valid, ownRepositoryHead: head && head !== commit ? head : null });
  }
  const production = rows.filter(row => row.production && row.ok);
  const bySlug = new Map<string, string[]>();
  for (const row of production) bySlug.set(row.slug, [...(bySlug.get(row.slug) ?? []), row.source]);
  const bodies = production.map(row => row.bodyChars!).sort((a, b) => a - b);
  let pairs = 0, pairsWhole = 0, singlesWhole = 0;
  production.forEach((row, index) => { if (!compileInstructionContext([documentOf(row, index)], 'goal', DEFAULT_SKILL_CONTEXT_CHARS).sources.some(source => source.truncated)) singlesWhole++; });
  for (let a = 0; a < production.length; a++) for (let b = a + 1; b < production.length; b++) {
    const both = compileInstructionContext([documentOf(production[a], a), documentOf(production[b], b)], 'goal', DEFAULT_SKILL_CONTEXT_CHARS);
    pairs++;
    if (both.sources.length === 2 && !both.sources.some(source => source.truncated)) pairsWhole++;
  }
  const atGuidance = compileInstructionContext([documentOf(production[0], 0, 'ب'.repeat(BODY_GUIDANCE)), documentOf(production[1], 1, 'ت'.repeat(BODY_GUIDANCE))], 'goal', DEFAULT_SKILL_CONTEXT_CHARS);
  const report = {
    generatedAt: new Date().toISOString(), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), commit, sources,
    verified: {
      productionFolders: rows.filter(row => row.production).length, structurallyValid: production.length,
      verdicts: Object.fromEntries([...new Set(production.map(row => row.verdict!))].map(verdict => [verdict, production.filter(row => row.verdict === verdict).length])),
      languages: { ar: production.filter(row => row.language === 'ar').length, en: production.filter(row => row.language === 'en').length },
      arIdsInRepo: production.filter(row => row.slug.endsWith('-ar')).map(row => row.slug),
      slugCollisions: [...bySlug].filter(([, where]) => where.length > 1).map(([slug, where]) => ({ slug, where })),
      arCounterparts: production.filter(row => row.slug.endsWith('-ar') && bySlug.has(row.slug.slice(0, -3))).map(row => ({ ar: row.slug, other: row.slug.slice(0, -3) })),
      fixturesExcluded: rows.filter(row => !row.production).length,
    },
    budget: {
      contextBudgetChars: DEFAULT_SKILL_CONTEXT_CHARS, bodyGuidanceChars: BODY_GUIDANCE, bodyGuidanceEnforcedInCode: false,
      bodyChars: { min: bodies[0], median: bodies[Math.floor(bodies.length / 2)], p90: bodies[Math.floor(bodies.length * 0.9)], max: bodies[bodies.length - 1] },
      overGuidance: production.filter(row => row.bodyChars! > BODY_GUIDANCE).length,
      singleWhole: `${singlesWhole}/${production.length}`, pairsWhole: `${pairsWhole}/${pairs}`,
      twoBodiesAtGuidance: { fit: atGuidance.sources.length === 2 && !atGuidance.sources.some(source => source.truncated), envelopeChars: atGuidance.text.length },
    },
    skills: rows.map(({ body, ...rest }) => rest),
  };
  if (out) { await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 1), 'utf8'); }
  console.log(JSON.stringify({ sources: report.sources, verified: report.verified, budget: report.budget }, null, 1));
}
main().catch(error => { console.error(error); process.exit(1); });
