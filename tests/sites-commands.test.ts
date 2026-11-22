import { describe, expect, it } from 'vitest';
import { SiteBriefSchema, type SiteBrief } from '@mohassan/contracts';
import { applyPatch, commandExamples, siteCommand } from '@mohassan/sites';
import { SCENARIOS, runScenario } from '../packages/sites/fixtures/scenarios.ts';

const base = (): SiteBrief => runScenario(SCENARIOS.find(scenario => scenario.id === 'services-ar')!).brief;
const english = (): SiteBrief => runScenario(SCENARIOS.find(scenario => scenario.id === 'services-en')!).brief;
const patched = (brief: SiteBrief, text: string): SiteBrief => {
  const command = siteCommand(text, brief);
  expect(command?.kind, text).toBe('patch');
  return applyPatch(brief, (command as { patch: Partial<SiteBrief> }).patch);
};

describe('site commands', () => {
  it('changes colour, name, tagline, numbers, email, address and city', () => {
    let brief = base();
    brief = patched(brief, 'غيّر اللون إلى أخضر'); expect(brief.primary).toBe('#15803d');
    brief = patched(brief, 'change the colour to #123456'); expect(brief.primary).toBe('#123456');
    brief = patched(brief, 'غيّر الاسم إلى «لمعة بلس»'); expect(brief.name).toBe('لمعة بلس');
    brief = patched(brief, 'أضف الشعار: تنظيف يريح البال'); expect(brief.tagline).toBe('تنظيف يريح البال');
    brief = patched(brief, 'رقم الواتساب 0509999999'); expect(brief.whatsapp).toBe('0509999999');
    brief = patched(brief, 'الهاتف 0112223333'); expect(brief.phone).toBe('0112223333');
    brief = patched(brief, 'البريد hello@lamaa.sa'); expect(brief.email).toBe('hello@lamaa.sa');
    brief = patched(brief, 'العنوان: شارع العليا، مبنى 12'); expect(brief.address).toBe('شارع العليا، مبنى 12');
    brief = patched(brief, 'المدينة الدمام'); expect(brief.city).toBe('الدمام');
  });
  it('adds and removes items and updates a price', () => {
    let brief = base();
    const before = brief.items.length;
    brief = patched(brief, 'أضف خدمة جلي البلاط - 300 ريال');
    expect(brief.items).toHaveLength(before + 1);
    expect(brief.items.at(-1)).toEqual({ title: 'جلي البلاط', price: '300 ريال' });
    brief = patched(brief, 'سعر تنظيف السجاد والكنب 180');
    expect(brief.items.find(item => item.title.includes('السجاد'))?.price).toBe('180');
    brief = patched(brief, 'احذف خدمة تعقيم');
    expect(brief.items.some(item => item.title.includes('تعقيم'))).toBe(false);
  });
  it('adds a section with inline content and asks when content is missing', () => {
    let brief = english();
    brief = patched(brief, 'add a team section: Sarah Lee - Lead plumber - Gas Safe registered');
    const team = brief.pages.flatMap(page => page.blocks).find(block => block.type === 'team');
    expect(team && team.type === 'team' ? team.members[0]?.name : null).toBe('Sarah Lee');
    const ask = siteCommand('add an FAQ section', brief);
    expect(ask?.kind).toBe('ask');
    expect(ask && ask.kind === 'ask' ? ask.want : null).toBe('faq');
    const facts = siteCommand('أضف قسم الأرقام', base());
    expect(facts?.kind).toBe('ask');
    const about = siteCommand('add about text: We are a family business in Manchester.', brief);
    expect(about?.kind).toBe('patch');
  });
  it('never writes a review itself', () => {
    const brief = base();
    const command = siteCommand('أضف قسم الآراء', brief);
    expect(command?.kind).toBe('ask');
    const supplied = siteCommand('أضف قسم الآراء: أبو خالد: خدمة سريعة ومرتبة', brief);
    expect(supplied?.kind).toBe('patch');
    const next = applyPatch(brief, (supplied as { patch: Partial<SiteBrief> }).patch);
    expect(next.testimonials).toEqual([{ name: 'أبو خالد', quote: 'خدمة سريعة ومرتبة' }]);
  });
  it('hides sections, removes the form, merges into one page and adds a custom page', () => {
    let brief = english();
    brief = patched(brief, 'hide the pricing');
    expect(brief.pages.flatMap(page => page.blocks).some(block => block.type === 'pricing')).toBe(false);
    brief = patched(brief, 'remove the contact form');
    expect(brief.pages.flatMap(page => page.blocks).some(block => block.type === 'contact' && block.form)).toBe(false);
    brief = patched(brief, 'add a page Terms: Payment is due on completion. Quotes are valid for thirty days.');
    expect(brief.pages.at(-2)?.title).toBe('Terms');
    brief = patched(brief, 'make it one page');
    expect(brief.pages).toHaveLength(1);
    const askPage = siteCommand('أضف صفحة الشروط', base());
    expect(askPage?.kind).toBe('ask');
  });
  it('changes mood, language, kind, goal and hours', () => {
    let brief = base();
    brief = patched(brief, 'اجعله أجرأ'); expect(brief.mood).toBe('bold');
    brief = patched(brief, 'make it calmer'); expect(brief.mood).toBe('calm');
    brief = patched(brief, 'اجعله بالإنجليزية'); expect(brief.lang).toBe('en');
    brief = patched(brief, 'make it Arabic'); expect(brief.lang).toBe('ar');
    expect(siteCommand('الهدف اتصال', brief), 'no phone yet, so the goal cannot become a call').toBeNull();
    brief = patched(brief, 'الهاتف 0112223333');
    brief = patched(brief, 'الهدف اتصال'); expect(brief.goal).toBe('call');
    brief = patched(brief, 'ساعات العمل: السبت إلى الخميس ٩ - ٦'); expect(brief.hours).toEqual(['السبت إلى الخميس ٩ - ٦']);
    expect(brief.pages.flatMap(page => page.blocks).some(block => block.type === 'hours')).toBe(true);
  });
  it('recognises undo and returns null for unknown sentences', () => {
    expect(siteCommand('تراجع', base())?.kind).toBe('undo');
    expect(siteCommand('undo', english())?.kind).toBe('undo');
    expect(siteCommand('ما رأيك بالطقس اليوم؟', base())).toBeNull();
    expect(siteCommand('tell me a joke', english())).toBeNull();
    expect(commandExamples('ar').length).toBeGreaterThan(8);
  });
  it('keeps every patched brief valid', () => {
    const brief = base();
    for (const text of ['غيّر اللون إلى أحمر', 'أضف خدمة فحص', 'احذف قسم الدعوة', 'اجعله صفحة واحدة', 'رقم الواتساب 0501111111']) {
      const command = siteCommand(text, brief);
      if (command?.kind === 'patch') expect(() => SiteBriefSchema.parse(applyPatch(brief, command.patch)), text).not.toThrow();
    }
  });
});
