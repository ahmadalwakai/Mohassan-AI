#!/usr/bin/env node
// Replaces the body of skills-library SKILL.md files with the bodies in a batch file and sets their version.
// Batch format: a line "=== <slug>" opens each body; everything up to the next "=== " line is that body.
// The frontmatter (name, description, category) is kept byte for byte, so routing does not change.
// Usage: node scripts/skills-library/apply-bodies.mjs <batch.txt> [version] [--dry]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const [batchPath, version = '1.1.0'] = args.filter((arg) => arg !== '--dry');
if (!batchPath) { console.error('usage: node apply-bodies.mjs <batch.txt> [version] [--dry]'); process.exit(2); }
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error(`bad version ${version}`); process.exit(2); }
const root = resolve(process.env.SKILLS_LIBRARY_DIR ?? 'C:/Mohassan AI/skills-library/skills');

const bodies = new Map();
let slug = null, lines = [];
const flush = () => { if (slug) bodies.set(slug, lines.join('\n').trim()); };
for (const line of readFileSync(batchPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
  const open = /^=== ([a-z0-9-]+)\s*$/.exec(line);
  if (open) {
    flush();
    slug = open[1]; lines = [];
    if (bodies.has(slug)) { console.error(`duplicate ${slug}`); process.exit(1); }
    continue;
  }
  if (slug) lines.push(line);
}
flush();

// The reader shows these sections; «متى تُستخدم» is never shown, so the opening line carries that instead.
const REQUIRED = ['## الخطوات', '## شكل الجواب'];
const KNOWN = new Set(['## الخطوات', '## شكل الجواب', '## تحقق قبل التسليم', '## أخطاء شائعة', '## ما أحتاجه منك']);
const HIDDEN = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
let failed = 0;
for (const [name, body] of bodies) {
  const file = join(root, name, 'SKILL.md');
  if (!existsSync(file)) { console.error(`${name}: no such skill`); failed++; continue; }
  const problems = [];
  if (body.length > 1800) problems.push(`body ${body.length} > 1800`);
  if (HIDDEN.test(body)) problems.push('hidden character');
  for (const heading of REQUIRED) if (!body.includes(`\n${heading}\n`)) problems.push(`no «${heading}»`);
  for (const heading of body.match(/^#{1,6} .*$/gmu) ?? []) if (!KNOWN.has(heading)) problems.push(`unknown heading «${heading}»`);
  if (/^#/u.test(body)) problems.push('no opening line before the first heading');
  const arabic = body.match(/\p{Script=Arabic}/gu)?.length ?? 0, latin = body.match(/[A-Za-z]/g)?.length ?? 0;
  if (arabic < latin * 2) problems.push(`arabic ${arabic} < 2 × latin ${latin}`);
  if (problems.length) { console.error(`${name}: ${problems.join('; ')}`); failed++; continue; }
  const source = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!front || !/^version: /m.test(front[1])) { console.error(`${name}: no frontmatter version`); failed++; continue; }
  if (!dry) writeFileSync(file, `---\n${front[1].replace(/^version: .*$/m, `version: ${version}`)}\n---\n${body}\n`, 'utf8');
  console.log(`${name.padEnd(28)} ${String(body.length).padStart(4)} chars  ar ${arabic} / latin ${latin}`);
}
console.log(`${bodies.size - failed}/${bodies.size} ${dry ? 'checked' : 'applied'}`);
process.exit(failed ? 1 : 0);
