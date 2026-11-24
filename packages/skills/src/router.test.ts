import { describe, expect, it } from 'vitest';
import { rankInstructionCandidates, routeInstructionSkills, skillTerms, type SkillContextMetadata } from './router.ts';

const skill = (slug: string, category: SkillContextMetadata['category'] = 'reasoning', description = 'Helpful guidance for a bounded task'): SkillContextMetadata => ({ id: slug, slug, name: slug, description, category, version: '1.0.0', contentHash: 'a'.repeat(64) });
describe('instruction metadata routing', () => {
  it('ranks explicit lexical matches and adds no skill that matches on its category alone', () => {
    const coding = skill('typescript-review', 'coding'), generic = skill('careful-work', 'coding');
    expect(routeInstructionSkills('Review typescript code', [generic, coding]).map(item => item.id)).toEqual([coding.id]);
  });
  it('matches Arabic terms after normalization', () => {
    const design = skill('interface-guide', 'design', 'إرشادات تصميم الواجهات'), data = skill('data-guide', 'analytics');
    expect(routeInstructionSkills('أريد تَصميم واجهة', [design, data]).map(item => item.id)).toEqual(['interface-guide']);
  });
  it('selects nothing for a category word alone', () => {
    const business = [skill('company-guide', 'business'), skill('strategy-notes', 'business', 'Notes for planning ahead')];
    expect(routeInstructionSkills('شركة', business)).toEqual([]);
    expect(rankInstructionCandidates('شركة', business)).toEqual([]);
  });
  // Two skills that share every word weigh each word little, so these mechanism tests turn the minimum score off.
  const uncut = { minScore: 0 };
  it('still lets a category word break a tie between skills that already match', () => {
    const first = skill('alpha-guide', 'research', 'Checklist for quarterly planning'), second = skill('beta-guide', 'business', 'Checklist for quarterly planning');
    expect(routeInstructionSkills('quarterly checklist', [first, second], 6, {}, uncut).map(item => item.id)).toEqual([first.id, second.id]);
    expect(routeInstructionSkills('quarterly checklist business', [first, second], 6, {}, uncut).map(item => item.id)).toEqual([second.id, first.id]);
    expect(rankInstructionCandidates('quarterly checklist business', [first, second]).map(item => item.id)).toEqual([second.id, first.id]);
  });
  it('orders tied candidates deterministically independent of database row order', () => {
    const a = skill('alpha', 'research', 'Research guidance for a bounded task'), b = skill('beta', 'research', 'Research guidance for a bounded task');
    expect(routeInstructionSkills('research', [b, a], 6, {}, uncut)).toEqual(routeInstructionSkills('research', [a, b], 6, {}, uncut));
    expect(routeInstructionSkills('research', [b, a], 6, {}, uncut)[0].id).toBe('alpha');
  });
  it('weighs a word by how few skills hold it, so a rare word outranks a common one', () => {
    // «جدول» is in four skills, «مناوبات» in one: before the weights, the name word «جدول» put the shift skill first for an Excel request.
    const shifts = skill('shift-scheduling', 'business', 'جدول مناوبات للموظفين'), excel = skill('spreadsheets-excel', 'analytics', 'معادلات اكسل وجدول بيانات');
    const others = ['study-plan', 'drivers-plan'].map(slug => skill(slug, 'reasoning', 'جدول يومي'));
    expect(routeInstructionSkills('معادلة في إكسل تجيب السعر من جدول ثاني', [shifts, excel, ...others])[0]!.id).toBe(excel.id);
    expect(routeInstructionSkills('جدول مناوبات الموظفين', [shifts, excel, ...others])[0]!.id).toBe(shifts.id);
  });
  it('reads words as the reader does: folded, without the article, stemmed', () => {
    const excel = skill('spreadsheets', 'analytics', 'الإكسل والمعادلات والجداول المحورية');
    expect(routeInstructionSkills('أبغى معادلة في اكسل', [excel, skill('notes-guide')]).map(item => item.id)).toEqual([excel.id]);
  });
  it('leaves out weak matches: below the minimum, or far below the best match', () => {
    const strong = skill('invoice-reminders', 'business', 'تذكير العميل بالفاتورة المتأخرة وتحصيل المستحقات');
    const weak = skill('customer-care', 'business', 'الرد على العميل الغاضب');
    const fillers = Array.from({ length: 8 }, (_, index) => skill(`filler-${index}`, 'reasoning', 'العميل والطلب'));
    // «العميل» is in ten skills; «الفاتورة» and «المتأخرة» only in one.
    expect(routeInstructionSkills('رسالة للعميل عن الفاتورة المتأخرة', [strong, weak, ...fillers]).map(item => item.id)).toEqual([strong.id]);
    expect(routeInstructionSkills('رسالة للعميل', [strong, weak, ...fillers])).toEqual([]);
    expect(routeInstructionSkills('رسالة للعميل', [strong, weak, ...fillers], 6, {}, { minScore: 0, relative: 0 }).length).toBeGreaterThan(0);
  });
  it('uses the weights it is given, so a shortlist ranks as the full catalogue would', () => {
    const a = skill('alpha-notes', 'reasoning', 'ملاحظات المشروع'), b = skill('beta-notes', 'reasoning', 'ملاحظات الاجتماع');
    const heavy = (term: string) => (term === 'اجتماع' ? 1 : 0.1), light = (term: string) => (term === 'اجتماع' ? 0.1 : 1);
    expect(routeInstructionSkills('ملاحظات المشروع والاجتماع', [a, b], 6, {}, { weight: heavy, minScore: 0, relative: 0 })[0]!.id).toBe(b.id);
    expect(routeInstructionSkills('ملاحظات المشروع والاجتماع', [a, b], 6, {}, { weight: light, minScore: 0, relative: 0 })[0]!.id).toBe(a.id);
  });
  it('returns no unrelated guidance or stop-word-only matches', () => {
    expect(routeInstructionSkills('astronomy', [skill('planning-guide')])).toEqual([]);
    expect(routeInstructionSkills('the and من في', [skill('planning-guide')])).toEqual([]);
  });
  it('ignores the original router stop words after folding and clitic handling', () => {
    const guide = skill('guide', 'reasoning', 'today task الآن كم إلى طلب مهمة');
    expect(routeInstructionSkills('Today: task وإلى الآن وكم وطلب مهمة؟', [guide])).toEqual([]);
    expect(rankInstructionCandidates('Today: task وإلى الآن وكم وطلب مهمة؟', [guide])).toEqual([]);
  });
  it('keeps English ad guidance available even without shared metadata words', () => {
    const copy = skill('copywriting', 'marketing', 'ad copy and product descriptions');
    const ads = skill('google-ads-campaign', 'marketing');
    const goal = 'I run a bakery and want more bookings. I can spend £25 per day.';
    expect(routeInstructionSkills(goal, [copy])).toEqual([copy]);
    expect(routeInstructionSkills(goal, [copy, ads])).toEqual([ads, copy]);
    expect(routeInstructionSkills(goal, [])).toEqual([]);
  });
  it('reserves top-three ad guidance without displacing the first lexical match', () => {
    const repair = skill('appliance-repair', 'business');
    const copy = skill('copywriting', 'marketing', 'ad copy and product descriptions');
    const ads = skill('google-ads-campaign', 'marketing');
    const goal = 'Create ads for my appliance repair service';
    expect(routeInstructionSkills(goal, [copy, repair, ads], 3)).toEqual([repair, ads, copy]);
  });
  it('does not infer an ad brief from generic ad mentions or another campaign type', () => {
    const copy = skill('copywriting', 'marketing', 'ad copy and product descriptions');
    for (const goal of ['I want to block ads in my browser', 'Launch a fundraising campaign for our charity', 'Create Instagram ads for my bakery']) {
      expect(routeInstructionSkills(goal, [copy])).toEqual([]);
    }
  });
  it('bounds the candidate scan and selected set', () => {
    const candidates = Array.from({ length: 201 }, (_, index) => skill(`guide-${index}`, 'coding', 'Coding guidance for a bounded task'));
    // A word every candidate holds weighs little; the cut is turned off to test the bounds alone.
    expect(routeInstructionSkills('coding', candidates, 500, {}, { minScore: 0 })).toHaveLength(6);
    expect(routeInstructionSkills('coding', candidates, 500)).toEqual([]);
    expect(routeInstructionSkills('specialneedle', [...candidates.slice(0, 200), skill('specialneedle')])).toEqual([]);
    expect(routeInstructionSkills('coding', candidates, 0, {}, { minScore: 0 })).toEqual([]);
  });
  it('ranks every candidate first, so routing past the 200-candidate window finds a late match and keeps the same order', () => {
    const fillers = Array.from({ length: 300 }, (_, index) => skill(`guide-${String(index).padStart(3, '0')}`, 'coding', 'Coding guidance for a bounded task'));
    const late = skill('zz-lateneedle-guide', 'coding');
    const all = [...fillers, late];
    expect(routeInstructionSkills('lateneedle', all)).toEqual([]);
    expect(routeInstructionSkills('lateneedle', rankInstructionCandidates('lateneedle', all)).map(item => item.id)).toEqual([late.id]);
    // Within the window the ranked route is exactly the plain route, ties included.
    const window = fillers.slice(0, 200);
    expect(routeInstructionSkills('coding review', rankInstructionCandidates('coding review', window))).toEqual(routeInstructionSkills('coding review', window));
    expect(rankInstructionCandidates('coding', all)).toHaveLength(200);
    expect(rankInstructionCandidates('the and', all)).toEqual([]);
  });
  it('does not treat instruction text or declared tools as routing inputs', () => {
    const candidate = { ...skill('plain-guide'), instructions: 'secretneedle', tools: ['secretneedle'] };
    expect(routeInstructionSkills('secretneedle', [candidate])).toEqual([]);
    expect(skillTerms('قِراءة قراءة TYPESCRIPT typescript')).toEqual(['قراءة', 'typescript']);
  });
  it('adds positive graph metadata after direct matches without creating tool authority', () => {
    const primary = skill('anchorneedle'), related = skill('quiet-guide'), unrelated = skill('other-guide');
    const result = routeInstructionSkills('anchorneedle', [unrelated, primary], 6, { relatedCandidates: [related] });
    expect(result.map(item => item.id)).toEqual([primary.id, related.id]);
    expect(result[1]).toBe(related); expect(result[1]).not.toHaveProperty('permissionsGranted');
    expect(routeInstructionSkills('anchorneedle', [unrelated, primary], 1, { relatedCandidates: [related] })).toEqual([primary]);
  });
  it('can use bounded related metadata outside discovery without rescanning arbitrary extra candidates', () => {
    const candidates = Array.from({ length: 201 }, (_, index) => skill(`plain-${index}`));
    const related = skill('related-last');
    expect(routeInstructionSkills('unmatched', [...candidates, related])).toEqual([]);
    expect(routeInstructionSkills('unmatched', candidates, 6, { relatedCandidates: [related, related] })).toEqual([related]);
    const extras = Array.from({ length: 13 }, (_, index) => skill(`related-${index}`));
    expect(routeInstructionSkills('related-12', [], 6, { relatedCandidates: extras }).some(item => item.id === 'related-12')).toBe(false);
  });
  it('preserves legacy routing when graph metadata is empty', () => {
    const candidates = [skill('review-guide', 'coding'), skill('arabic-guide', 'languages')];
    expect(routeInstructionSkills('Review code', candidates, 6, { relatedCandidates: [] })).toEqual(routeInstructionSkills('Review code', candidates));
    expect(routeInstructionSkills('the and من في', candidates, 6, { relatedCandidates: [] })).toEqual([]);
  });
});
