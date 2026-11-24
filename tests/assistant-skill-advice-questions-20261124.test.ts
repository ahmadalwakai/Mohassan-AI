import { describe, expect, it, vi } from 'vitest';
import { createSkillReader, skillReadable, type SkillReaderCandidate } from '../apps/server/src/assistant/skill-reader.js';

describe('skill advice questions about action timing and required quantities', () => {
  it.each([
    'متى أغير زيت المحرك في سيارتي؟',
    'إمتى نستبدل فلتر المياه في البيت؟',
    'متى أفحص مكابح سيارتي؟',
    'متى نسقي النباتات في حديقتنا؟',
    'متى أستخدم الفاصلة في كتابتي؟',
    'متى ينبغي أن أبدأ اختبار مشروعي؟',
    'متى يجب أن نراجع خطة شركتنا؟',
    'When should I replace the air filter in my car?',
    'When must we review our backup policy?',
    'When should I update my backup policy?',
    'متى أراجع سياسة النسخ الاحتياطي لمشروعي؟',
    'كم لوح شمسي أحتاج لتشغيل منزلي؟',
    'كم عدد البطاريات التي نحتاجها للطاقة الشمسية؟',
    'كم أحتاج من الطلاء لتجديد غرفتي؟',
    'كم موظفًا سأحتاج لافتتاح متجري؟',
    'How many solar panels do I need for my house?',
    'How much paint would we need for our kitchen?',
    'How much time should I budget for testing my app?',
  ])('lets an applicable skill answer the method in «%s»', request => {
    for (const mode of ['advice', 'personal', 'fallback'] as const) {
      expect(skillReadable(request, mode), `${mode}: ${request}`).toBe(true);
    }
  });

  it.each([
    'متى غيرت زيت سيارتي؟',
    'متى فحصت مكابح سيارتي؟',
    'متى موعد تجديد بطاقة شركتي؟',
    'كم لوح شمسي اشتريت لمشروعي؟',
    'كم لوحًا كنت أحتاج لمشروعي؟',
    'كم موظفًا قال رئيس فريقي إننا نحتاج؟',
    'كم راتبي الشهري؟ أحتاج خطة للادخار.',
    'How many solar panels did I need for my house?',
    'How much paint did my contractor buy?',
    'When did I replace my air filter?',
    'When is my car service appointment?',
    'How much is my project budget? When should I review it?',
  ])('leaves a stored personal fact to its evidence in «%s»', request => {
    for (const mode of ['advice', 'personal', 'fallback'] as const) {
      expect(skillReadable(request, mode), `${mode}: ${request}`).toBe(false);
    }
  });

  it.each([
    'When should I arrive for my appointment according to the confirmation email?',
    'How many doses do I need to take according to my prescription?',
    'How many panels do we need based on our signed installer contract?',
    'When should I replace my filter per the maintenance instructions?',
    'How much paint would we need from the measurements in my saved notes?',
    'When should I update our policy as specified in the audit report?',
    'متى ينبغي أن أصل إلى موعدي حسب رسالة التأكيد؟',
    'كم جرعة أحتاج وفقا لوصفتي الطبية؟',
    'متى أغير زيت المحرك بناء على ملاحظتي المحفوظة؟',
    'كم لوحًا أحتاج حسب العقد الموقع؟',
    'كم بطارية نحتاج بحسب بريدي المحفوظ؟',
    'متى يجب أن نراجع السياسة استنادا إلى وثيقتنا؟',
    'كم موظفا أحتاج في التقرير الذي حفظته؟',
  ])('requires the cited record rather than generic advice in «%s»', request => {
    for (const mode of ['advice', 'personal', 'fallback'] as const) {
      expect(skillReadable(request, mode), `${mode}: ${request}`).toBe(false);
    }
  });

  it.each([
    'كم عدد سكان الأردن؟',
    'متى اكتشف البنسلين؟',
    'How many planets are in the solar system?',
    'When was the first railway built?',
  ])('keeps a plain public fact out of advice mode in «%s»', request => {
    expect(skillReadable(request, 'advice')).toBe(false);
  });

  it.each([
    'كم سعر الذهب اليوم؟',
    'كم أحتاج لدفع سعر الدولار اليوم؟',
    'متى يجب أن أفحص الطقس غدًا؟',
    'How many solar panels do I need at the current price?',
    'When should I check the weather tomorrow?',
    'How many points do we need to beat the current score?',
  ])('preserves the live-information boundary in «%s»', request => {
    for (const mode of ['advice', 'personal', 'fallback'] as const) {
      expect(skillReadable(request, mode), `${mode}: ${request}`).toBe(false);
    }
  });

  const solar: SkillReaderCandidate = {
    id: 'isolated-solar-sizing', slug: 'solar-sizing', name: 'Sizing solar panels',
    description: 'Plan the required solar panels and battery capacity for a household.',
    category: 'reasoning', version: '1.0.0', contentHash: 'a'.repeat(64),
  };

  it('reads the matching skill and returns its method for a sizing question', async () => {
    const candidates = vi.fn(async () => [solar]);
    const instructions = vi.fn(async () => '## Steps\n1. Measure daily electricity usage.\n2. Use that usage and panel output to estimate capacity.');
    const reader = createSkillReader({ candidates, instructions });

    const result = await reader('owner', 'How many solar panels do I need for my house?', { mode: 'advice' });

    expect(result?.skill.id).toBe(solar.id);
    expect(result?.text).toContain('Measure daily electricity usage.');
    expect(result?.text).toContain('Source: skill');
    expect(instructions).toHaveBeenCalledWith('owner', solar.id);
  });

  it('reads an Arabic maintenance method without claiming a personal service date', async () => {
    const maintenance: SkillReaderCandidate = {
      id: 'isolated-engine-maintenance', slug: 'engine-maintenance', name: 'صيانة زيت المحرك',
      description: 'خطوات مراجعة حالة زيت المحرك وتحديد فترات الصيانة من دليل السيارة.',
      category: 'reasoning', version: '1.0.0', contentHash: 'b'.repeat(64),
    };
    const reader = createSkillReader({
      candidates: async () => [solar, maintenance],
      instructions: async (_owner, id) => id === maintenance.id ? '## الخطوات\n1. راجع فترة الصيانة المحددة في دليل السيارة.' : null,
    });

    const result = await reader('owner', 'متى أغير زيت المحرك في سيارتي؟', { mode: 'personal' });

    expect(result?.skill.id).toBe(maintenance.id);
    expect(result?.text).toContain('راجع فترة الصيانة المحددة في دليل السيارة.');
    expect(result?.text).toContain('المصدر: مهارة');
  });

  it('does not read the catalogue or a skill body for a stored fact with matching words', async () => {
    const candidates = vi.fn(async () => [solar]);
    const instructions = vi.fn(async () => '## Steps\n1. Measure daily electricity usage.');
    const reader = createSkillReader({ candidates, instructions });

    expect(await reader('owner', 'How many solar panels did I need for my house?', { mode: 'advice' })).toBeNull();
    expect(candidates).not.toHaveBeenCalled();
    expect(instructions).not.toHaveBeenCalled();
  });

  it.each([
    'How many solar panels do I need according to the installer contract?',
    'كم لوح شمسي أحتاج حسب العقد الموقع؟',
  ])('does not read a skill instead of the explicitly cited source in «%s»', async request => {
    const candidates = vi.fn(async () => [solar]);
    const instructions = vi.fn(async () => '## Steps\n1. Measure daily electricity usage.');
    const reader = createSkillReader({ candidates, instructions });

    expect(await reader('owner', request, { mode: 'fallback' })).toBeNull();
    expect(candidates).not.toHaveBeenCalled();
    expect(instructions).not.toHaveBeenCalled();
  });
});
