import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillManifest, sha256 } from '@mohassan/skills';
import { buildSkillReaderIndex, createSkillReader, matchSkills, type SkillReaderCandidate } from '../apps/server/src/assistant/skill-reader.js';

/** The tracked skills of this repository as reader candidates. */
async function repoCandidates(): Promise<{ candidates: SkillReaderCandidate[]; bodies: Map<string, string> }> {
  const candidates: SkillReaderCandidate[] = [], bodies = new Map<string, string>();
  for (const slug of (await readdir('skills')).sort()) {
    const { fields, body } = parseSkillManifest(await readFile(join('skills', slug, 'SKILL.md'), 'utf8'));
    const id = randomUUID();
    candidates.push({ id, slug, name: fields.name!, description: fields.description!, category: fields.category ?? 'reasoning', version: fields.version ?? '1.0.0', contentHash: sha256(slug) });
    bodies.set(id, body);
  }
  return { candidates, bodies };
}

const REQUESTS = [
  'كيف أكتب خطة عمل لمشروع مقهى', 'ساعدني أكتب سيرة ذاتية لوظيفة محاسب', 'how do I write a cover letter', 'أبغى تحليل SWOT لمتجري', 'كيف أحلل بيانات المبيعات',
  'اكتب بريد احترافي لعميل', 'كيف أراجع كود بايثون', 'ما الطقس اليوم', 'خطة دراسية للاختبارات', 'اكتب منشورات لوسائل التواصل', 'كيف أسعّر منتجي الجديد',
  'how to run a hiring interview', 'أحتاج محضر اجتماع', 'xyzzy', 'كيف أحمي حسابي من الاختراق', 'حدد السبب الجذري لتأخر التسليم',
];

describe('the reader over a catalogue index', () => {
  it('scores exactly as before when every skill fits the old window', async () => {
    const { candidates } = await repoCandidates();
    const index = buildSkillReaderIndex(candidates);
    for (const request of REQUESTS) expect(matchSkills(request, candidates, index)).toEqual(matchSkills(request, candidates));
  });
  it('finds a skill beyond the old 1,300-candidate window, with frequencies counted over every skill', async () => {
    const { candidates } = await repoCandidates();
    const filler: SkillReaderCandidate[] = Array.from({ length: 1400 }, (_, n) => ({ id: randomUUID(), slug: `aaa-filler-${String(n).padStart(4, '0')}`, name: `قالب ${n}`, description: `مدخل تجريبي ${n} عن الموضوع ${n % 41}.`, category: 'research', version: '1.0.0', contentHash: sha256(`x${n}`) }));
    const target: SkillReaderCandidate = { id: randomUUID(), slug: 'zzz-greenhouse-irrigation', name: 'ري البيوت المحمية', description: 'خطة ري البيوت المحمية بالتنقيط: جدول الري وكمية الماء وفحص الشبكة.', category: 'research', version: '1.0.0', contentHash: sha256('target') };
    const all = [...filler, ...candidates, target];
    const request = 'كيف أعمل خطة ري للبيوت المحمية بالتنقيط';
    expect(matchSkills(request, all).some(match => match.skill.id === target.id)).toBe(false);
    const matches = matchSkills(request, all, buildSkillReaderIndex(all));
    expect(matches[0]?.skill.id).toBe(target.id);
  });
  it('answers through the index and never reads the candidate list when an index is given', async () => {
    const { candidates, bodies } = await repoCandidates();
    const index = buildSkillReaderIndex(candidates);
    let listed = 0;
    const reader = createSkillReader({
      candidates: async () => { listed++; return candidates; },
      index: async () => index,
      instructions: async (_owner, id) => bodies.get(id) ?? null,
    });
    const answer = await reader('owner', 'كيف أكتب خطة عمل لمشروع مقهى', { mode: 'advice' });
    expect(answer?.skill.slug).toBe('business-plan-ar');
    expect(listed).toBe(0);
    expect(await reader('owner', 'ما الطقس اليوم في الرياض', { mode: 'advice' })).toBeNull();
    const empty = createSkillReader({ candidates: async () => candidates, index: async () => buildSkillReaderIndex([]), instructions: async () => null });
    expect(await empty('owner', 'كيف أكتب خطة عمل لمشروع مقهى', { mode: 'advice' })).toBeNull();
  });
});
