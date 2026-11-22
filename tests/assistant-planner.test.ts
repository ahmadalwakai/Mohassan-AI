import { describe, expect, it } from 'vitest';
import { notWebReason, webQuestion } from '../apps/server/src/assistant/hands.js';
import { composePlan, planningQuestion, planningTask } from '../apps/server/src/assistant/planner.js';
import { writingTask } from '../apps/server/src/assistant/writer.js';

describe('planning requests', () => {
  it('are planning, never a web search or a letter', () => {
    for (const text of ['ساعدني في التخطيط لأسبوعي', 'خطط لي أسبوعي', 'نظم لي يومي', 'رتب جدول الأسبوع', 'اكتب لي خطة لأسبوعي', 'plan my week', 'help me organize my week', 'make me a weekly plan']) {
      expect(notWebReason(text), text).toBe('planning');
      expect(webQuestion(text), text).toBeNull();
      expect(writingTask(text), text).toBeNull();
      expect(planningTask(text), text).not.toBeNull();
    }
  });

  it('leaves questions and other requests alone', () => {
    for (const text of ['ما عاصمة اليابان؟', 'كم سعر الذهب اليوم؟', 'اكتب رسالة اعتذار لزميلي', 'what is the speed of light']) expect(planningTask(text), text).toBeNull();
    expect(planningTask('ساعدني في التخطيط لأسبوعي')).toEqual({ lang: 'ar' });
    expect(planningTask('plan my week')).toEqual({ lang: 'en' });
  });
});

describe('composePlan', () => {
  it('puts fixed appointments on their day and spreads tasks to the lightest days, important first', () => {
    const reply = '1. مراجعة الميزانية، !تسليم التقرير، الاتصال بالمورد، ترتيب المكتب\n2. الأحد إلى الخميس\n3. الثلاثاء اجتماع الفريق، الخميس طبيب الأسنان';
    const { text, complete } = composePlan({ lang: 'ar' }, reply);
    expect(complete).toBe(true);
    const day = (name: string) => text.split(`**${name}**\n`)[1].split('\n\n')[0];
    expect(day('الأحد')).toContain('**تسليم التقرير**');
    expect(day('الثلاثاء')).toContain('اجتماع الفريق (موعد ثابت)');
    expect(day('الخميس')).toContain('طبيب الأسنان (موعد ثابت)');
    expect(text).not.toContain('**الجمعة**');
    for (const task of ['مراجعة الميزانية', 'الاتصال بالمورد', 'ترتيب المكتب']) expect(text).toContain(`- ${task}`);
    expect(text).toContain('لم يكتبها نموذج');
  });

  it('reads written day names, English replies, and says so when no task was given', () => {
    const en = composePlan({ lang: 'en' }, '1. write the report, call Sam\n2. Monday, Wednesday\n3. Friday gym');
    expect(en.text).toContain('**Monday**\n- write the report');
    expect(en.text).toContain('**Wednesday**\n- call Sam');
    expect(en.text).toContain('Unplaced appointments (unclear day or outside the selected working days): Friday gym');
    expect(en.complete).toBe(false);
    expect(composePlan({ lang: 'ar' }, '2. الأحد إلى الخميس')).toMatchObject({ complete: false });
    expect(planningQuestion({ lang: 'ar' }).fields.map(field => field.id)).toEqual(['tasks', 'days', 'fixed']);
  });
  it('keeps numbered tasks in structured answers and reads explicit no-appointment replies', () => {
    const result = composePlan({ lang: 'en' }, { tasks: '1. Review the budget\n2. Call Pat', days: 'Monday to Thursday', fixed: 'none' });
    expect(result.complete).toBe(true);
    expect(result.text).toContain('1. Review the budget');
    expect(result.text).toContain('2. Call Pat');
    expect(result.text).toContain('**Thursday**');
    expect(result.text).not.toContain('**Friday**');
  });
  it('labels unrecognized or negated working days as provisional rather than confirmed', () => {
    for (const days of ['not Monday to Friday', 'whenever I am free', 'كل يوم إلا الجمعة']) {
      const result = composePlan({ lang: 'en' }, { tasks: 'Review the budget', days, fixed: '' });
      expect(result.complete, days).toBe(false);
      expect(result.text).toContain('provisional');
    }
  });
  it('does not pick the first day of an ambiguous fixed appointment', () => {
    const result = composePlan({ lang: 'en' }, { tasks: 'Review the budget', days: 'Every day', fixed: 'Monday or Friday meeting' });
    expect(result.complete).toBe(false);
    expect(result.text).toContain('Unplaced appointments');
    expect(result.text).toContain('Monday or Friday meeting');
    expect(result.text).not.toContain('meeting (fixed)');
  });
});
