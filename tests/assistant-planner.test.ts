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
    expect(en.text).toContain('Appointments with no day I could read: Friday gym');
    expect(composePlan({ lang: 'ar' }, '2. الأحد إلى الخميس')).toMatchObject({ complete: false });
    expect(planningQuestion({ lang: 'ar' }).fields.map(field => field.id)).toEqual(['tasks', 'days', 'fixed']);
  });
});
