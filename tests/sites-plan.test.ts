import { describe, expect, it } from 'vitest';
import { ChatQuestionFieldSchema } from '@mohassan/contracts';
import { applyAnswers, completeBrief, MAX_ROUNDS, missingWants, parseFacts, parseFaq, parsePricing, parseTeam, siteQuestion, siteSentence } from '@mohassan/sites';
import { SCENARIOS, runScenario } from '../packages/sites/fixtures/scenarios.ts';

describe('site planner', () => {
  it('asks at most six fields per card, each valid for the chat card contract', () => {
    for (const scenario of SCENARIOS) {
      const partial = siteSentence(scenario.sentence)!;
      const question = siteQuestion(partial);
      expect(question, scenario.id).not.toBeNull();
      expect(question!.fields.length).toBeLessThanOrEqual(6);
      expect(question!.prompt.length).toBeGreaterThan(0);
      for (const field of question!.fields) expect(() => ChatQuestionFieldSchema.parse(field), `${scenario.id} ${field.id}`).not.toThrow();
    }
  });
  it('asks for identity and contact before optional blocks', () => {
    const partial = siteSentence('ابن لي موقع فيه الفريق والأسئلة الشائعة')!;
    const wants = missingWants(partial);
    expect(wants.slice(0, 3)).toEqual(['name', 'kind', 'contact']);
    expect(wants).toEqual(expect.arrayContaining(['team', 'faq']));
  });
  it('asks only for what the sentence did not say', () => {
    const partial = siteSentence('أريد موقعاً لمطعم «بيت الشام» في دمشق، واتساب 0933123456')!;
    const wants = missingWants(partial);
    expect(wants).not.toContain('name');
    expect(wants).not.toContain('kind');
    expect(wants).not.toContain('contact');
    expect(wants).not.toContain('city');
    expect(wants).toContain('items');
    expect(wants).toContain('hours');
  });
  it('completes every fixture within the round limit and asks for each requested block', () => {
    for (const scenario of SCENARIOS) {
      const run = runScenario(scenario);
      expect(run.rounds, scenario.id).toBeLessThanOrEqual(MAX_ROUNDS);
      const partial = siteSentence(scenario.sentence)!;
      for (const want of partial.requested) expect(run.fieldsAsked, `${scenario.id} asks for ${want}`).toContain(want);
      expect(run.brief.pages.some(page => page.path === 'index.html')).toBe(true);
    }
  });
  it('skips an optional block the user declines and keeps essentials pending', () => {
    const partial = siteSentence('build me a site with pricing and a team page')!;
    const next = applyAnswers(partial, { pricing: 'no', team: 'skip', name: '' });
    expect(next.skipped).toEqual(expect.arrayContaining(['pricing', 'team']));
    expect(missingWants(next)).toContain('name');
    expect(missingWants(next)).not.toContain('pricing');
    expect(next.rounds).toBe(1);
  });
  it('reads contact answers with WhatsApp marked and emails present', () => {
    const partial = siteSentence('build me a site for Harbour Accounting')!;
    const next = applyAnswers(partial, { contact: '0117 496 0123 WhatsApp and phone\nteam@harbour.example' });
    expect(next.whatsapp).toBe('01174960123');
    expect(next.phone).toBe('01174960123');
    expect(next.email).toBe('team@harbour.example');
  });
  it('builds a valid brief with structural defaults only', () => {
    const partial = applyAnswers(siteSentence('أريد موقعاً لعيادة «ابتسامة»')!, { contact: '0551234567 واتساب', items: 'تقويم\nتبييض' });
    const completion = completeBrief(partial);
    expect('brief' in completion).toBe(true);
    if ('brief' in completion) {
      expect(completion.brief.goal).toBe('book');
      expect(completion.brief.items).toHaveLength(2);
      expect(completion.brief.testimonials).toEqual([]);
      expect(completion.brief.pages.map(page => page.path)).toEqual(['index.html', 'contact.html']);
    }
  });
  it('reports what is still missing instead of guessing', () => {
    const completion = completeBrief(siteSentence('ابن لي موقع')!);
    expect(completion).toEqual({ missing: ['name', 'kind', 'contact'] });
  });
  it('parses team, FAQ, pricing and facts formats', () => {
    expect(parseTeam('د. سارة - طبيبة أسنان - تقويم\nمحمد علي - مدير')).toEqual([{ name: 'د. سارة', role: 'طبيبة أسنان', bio: 'تقويم' }, { name: 'محمد علي', role: 'مدير' }]);
    expect(parseFaq('هل تحضرون المعدات؟\nنعم كلها معنا.\nكيف أحجز؟ عبر واتساب.')).toEqual([{ question: 'هل تحضرون المعدات؟', answer: 'نعم كلها معنا.' }, { question: 'كيف أحجز؟', answer: 'عبر واتساب.' }]);
    expect(parsePricing('Basic - £200 a month - weekly visit, monthly report')).toEqual([{ name: 'Basic', price: '£200 a month', features: ['weekly visit', 'monthly report'] }]);
    expect(parseFacts('500 - عميل\n12 - سنة في السوق')).toEqual([{ value: '500', label: 'عميل' }, { value: '12', label: 'سنة في السوق' }]);
    expect(parseFacts('كلام بلا أرقام')).toEqual([]);
  });
});
