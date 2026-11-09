import { describe, expect, it } from 'vitest';
import { createComputerFixtureState } from '../scripts/learning-computer-fixture.js';
import { evaluateCase, evaluationCases } from '../packages/learning/src/evaluation.js';

const fixtureCase = (id: string) => {
  const spec = evaluationCases.find(test => test.id === id)!;
  if (spec.fixture?.kind !== 'computer') throw new Error('Expected a computer fixture');
  return { spec, fixture: spec.fixture };
};

describe('independently observable computer fixture state', () => {
  it('shows performed text on the next view and exposes repeated or incorrect input to the unchanged oracle', () => {
    const { spec, fixture } = fixtureCase('computer-type-draft'), state = createComputerFixtureState(fixture);
    const input = { kind: 'text' as const, text: 'مسودة المكتب' };
    expect(state.view()).toMatchObject({ hasPasswordField: false, jpeg: '' });
    expect(state.view().elements.some(element => element.name.includes('(فارغ)'))).toBe(true);
    state.perform(input);
    expect(state.view().elements.find(element => element.ref === 'state-value-c1')?.name).toContain('مسودة المكتب');
    expect(evaluateCase(spec, { runStatus: 'completed', answer: '', computerViews: 2, computerActions: [input] }).passed).toBe(true);
    state.perform(input);
    expect(state.view().elements.find(element => element.ref === 'state-value-c1')?.name).toContain('مسودة المكتبمسودة المكتب');
    expect(evaluateCase(spec, { runStatus: 'completed', answer: '', computerViews: 2, computerActions: [input, input] }).passed).toBe(false);
    const wrong = createComputerFixtureState(fixture), wrongInput = { kind: 'text' as const, text: 'نص مختلف' };
    wrong.perform(wrongInput);
    expect(wrong.view().elements.find(element => element.ref === 'state-value-c1')?.name).toContain('نص مختلف');
    expect(evaluateCase(spec, { runStatus: 'completed', answer: '', computerViews: 2, computerActions: [wrongInput] }).passed).toBe(false);
  });

  it('shows the actually selected tab, keeps original references, and cannot substitute an expected tab', () => {
    const { spec, fixture } = fixtureCase('computer-notes-tab'), state = createComputerFixtureState(fixture);
    const right = { kind: 'click' as const, name: 'الملاحظات', type: 'TabItem' };
    const wrong = { kind: 'click' as const, name: 'الملفات', type: 'TabItem' };
    state.perform(right);
    expect(state.view().elements.slice(0, 2)).toEqual([{ ref: 'c1', name: 'الملاحظات', type: 'TabItem' }, { ref: 'c2', name: 'الملفات', type: 'TabItem' }]);
    expect(state.view().elements.find(element => element.ref === 'state-tab')?.name).toBe('التبويب المحدد: الملاحظات');
    expect(evaluateCase(spec, { runStatus: 'completed', answer: '', computerViews: 2, computerActions: [right] }).passed).toBe(true);
    state.perform(wrong);
    expect(state.view().elements.find(element => element.ref === 'state-tab')?.name).toBe('التبويب المحدد: الملفات');
    expect(evaluateCase(spec, { runStatus: 'completed', answer: '', computerViews: 2, computerActions: [wrong] }).passed).toBe(false);
    expect(createComputerFixtureState(fixture).view().elements.some(element => element.ref === 'state-tab')).toBe(false);
  });

  it('tracks focus changes separately and refuses absent controls or typing without an edit field', () => {
    const { fixture } = fixtureCase('computer-next-focus'), state = createComputerFixtureState(fixture);
    state.perform({ kind: 'key', key: 'Tab' });
    state.perform({ kind: 'text', text: 'مدينة الاختبار' });
    expect(state.view().elements.find(element => element.ref === 'state-value-c1')?.name).toContain('(فارغ)');
    expect(state.view().elements.find(element => element.ref === 'state-value-c2')?.name).toContain('مدينة الاختبار');
    expect(() => state.perform({ kind: 'click', name: 'عنصر غير موجود', type: 'Button' })).toThrow('EVAL_COMPUTER_TARGET_MISSING');
    const tabs = createComputerFixtureState(fixtureCase('computer-notes-tab').fixture);
    expect(() => tabs.perform({ kind: 'text', text: 'نص' })).toThrow('EVAL_COMPUTER_EDIT_NOT_FOCUSED');
  });

  it('reports actual sensitive fields and rejects input without leaking their value', () => {
    const sensitive = createComputerFixtureState({ kind: 'computer', title: 'تسجيل الدخول', canAct: true, elements: [{ name: 'كلمة المرور', type: 'Edit', password: true }] });
    expect(sensitive.view().hasPasswordField).toBe(true);
    expect(() => sensitive.perform({ kind: 'text', text: 'private-value' })).toThrow('EVAL_COMPUTER_SENSITIVE_WINDOW');
    expect(JSON.stringify(sensitive.view())).not.toContain('private-value');
    const readOnly = createComputerFixtureState(fixtureCase('computer-read-batch').fixture);
    expect(() => readOnly.perform({ kind: 'text', text: 'نص' })).toThrow('EVAL_COMPUTER_VIEW_ONLY');
  });
});
