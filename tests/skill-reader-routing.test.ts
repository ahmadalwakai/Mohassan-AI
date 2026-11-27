import { describe, expect, it } from 'vitest';
import { buildSkillReaderIndex, createSkillReader, matchSkills, type SkillReaderCandidate } from '../apps/server/src/assistant/skill-reader.js';

function guide(slug: string, name: string, description: string, category = 'reasoning'): SkillReaderCandidate {
  return { id: slug, slug, name, description, category, version: '1.0.0', contentHash: slug };
}

const ads = guide('google-ads-campaign', 'حملات Google Ads', 'تخطيط الحملات وكتابة الإعلانات', 'marketing');
const copy = guide('copywriting', 'كتابة إعلانية', 'ad copy and product descriptions', 'marketing');

describe.each([false, true])('the model-free reader (indexed: %s)', indexed => {
  const rank = (request: string, candidates: SkillReaderCandidate[]) =>
    matchSkills(request, candidates, indexed ? buildSkillReaderIndex(candidates) : undefined).map(match => match.skill);
  const read = (candidates: SkillReaderCandidate[], instructions: Record<string, string>) => createSkillReader({
    candidates: async () => candidates,
    ...(indexed ? { index: async () => buildSkillReaderIndex(candidates) } : {}),
    instructions: async (_owner, id) => instructions[id] ?? null,
  });

  // English briefs and exclusions adapted from https://github.com/ahmadalwakai/Mohassan-AI/pull/2 (retrieved 2026-11-27).
  it('finds active English ad guidance without shared words', async () => {
    const request = 'I run a bakery and want more bookings. I can spend £25 per day.';
    expect(rank(request, [copy])).toEqual([copy]);
    expect(rank(request, [copy, ads])).toEqual([ads, copy]);
    expect(rank(request, [])).toEqual([]);
    const answer = await read([copy, ads], { [copy.id]: '## Steps\n1. Draft copy for the audience.' })('owner', request, { mode: 'fallback' });
    expect(answer?.skill).toBe(copy);
  });

  it('reserves ad guidance after the strongest topical match', () => {
    const repair = guide('appliance-repair', 'Appliance repair', 'Repair service');
    expect(rank('Create ads for my appliance repair service', [copy, repair, ads])).toEqual([repair, ads, copy]);
  });

  it.each([
    'I want to block ads in my browser',
    'Create an ad blocker for my browser',
    'Launch a fundraising campaign for our charity',
    'Create Instagram ads for my bakery',
  ])('leaves unrelated and platform-specific briefs to lexical matching: %s', request => {
    expect(rank(request, [copy])).toEqual([]);
  });

  it.each([
    ['How do I review today’s task for a budget?', guide('today-task', 'Today task', ''), guide('budget', 'Budget', 'task')],
    ['كيف أراجع طلب اليوم مع ميزانية؟', guide('daily-task', 'طلب اليوم', ''), guide('budget', 'ميزانية', 'طلب')],
  ])('retains a generic match when it is the only usable guide: %s', async (request, generic, topical) => {
    expect(rank(request, [generic])).toEqual([generic]);
    expect(rank(request, [generic, topical])).toEqual([topical, generic]);
    const answer = await read([generic, topical], { [generic.id]: '## Steps\n1. Review the request.' })('owner', request, { mode: 'fallback' });
    expect(answer?.skill).toBe(generic);
  });

  it.each([
    ['How do I review today’s task for a budget, schedule and invoice?', guide('today-task', 'Today task', ''), ['budget', 'schedule', 'invoice'], 'task'],
    ['كيف أراجع الطلب اليوم مع ميزانية وجدول وفاتورة؟', guide('daily-task', 'طلب اليوم', ''), ['ميزانية', 'جدول', 'فاتورة'], 'طلب'],
  ])('tries the original generic match when the first three bodies are unavailable: %s', async (request, generic, names, description) => {
    const topical = names.map(name => guide(name, name, description));
    const active = [generic, ...topical];
    expect(rank(request, active)).toEqual([...topical].sort((a, b) => a.slug.localeCompare(b.slug, 'en')).concat(generic));
    const answer = await read(active, { [generic.id]: '## Steps\n1. Review the request.' })('owner', request, { mode: 'fallback' });
    expect(answer?.skill).toBe(generic);
  });
});
