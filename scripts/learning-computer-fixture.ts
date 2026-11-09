import type { ComputerScreen, ComputerStep } from '../apps/server/src/assistant/tools.js';
import type { EvaluationFixture } from '../packages/learning/src/evaluation.js';

type ComputerFixture = Extract<EvaluationFixture, { kind: 'computer' }>;
type FixtureInput = Omit<ComputerFixture, 'elements'> & {
  elements: readonly { name: string; type: string; password?: boolean }[];
};

/** Synthetic device state, derived only from fixture controls and performed input.
 * It never reads an evaluation goal, expected result, reference answer, or model output. */
export function createComputerFixtureState(fixture: FixtureInput) {
  const elements = fixture.elements.map((element, index) => ({ ...element, ref: `c${index + 1}` }));
  const focusable = elements.filter(element => ['Edit', 'Button', 'TabItem'].includes(element.type));
  let focused = elements.find(element => element.type === 'Edit' && element.name.includes('عليه التركيز'))?.ref
    ?? elements.find(element => element.type === 'Edit')?.ref ?? focusable[0]?.ref;
  let selectedTab: string | undefined;
  let activatedButton: string | undefined;
  const values = new Map(elements.filter(element => element.type === 'Edit').map(element => [element.ref, '']));
  const hasPasswordField = elements.some(element => element.password === true);

  function view(): ComputerScreen {
    const observed = elements.map(({ name, type, ref }) => ({ name, type, ref }));
    for (const element of elements.filter(element => element.type === 'Edit' && !element.password)) {
      observed.push({ ref: `state-value-${element.ref}`, type: 'Text', name: `قيمة الحقل «${element.name}»: ${values.get(element.ref) || '(فارغ)'}` });
    }
    if (focused) observed.push({ ref: 'state-focus', type: 'Text', name: `العنصر الذي عليه التركيز: ${elements.find(element => element.ref === focused)!.name}` });
    if (selectedTab) observed.push({ ref: 'state-tab', type: 'Text', name: `التبويب المحدد: ${selectedTab}` });
    if (activatedButton) observed.push({ ref: 'state-button', type: 'Text', name: `الزر المنشط: ${activatedButton}` });
    return { title: fixture.title, elements: observed, canAct: fixture.canAct, hasPasswordField, jpeg: '' };
  }

  function perform(step: ComputerStep): void {
    if (!fixture.canAct) throw new Error('EVAL_COMPUTER_VIEW_ONLY');
    if (hasPasswordField) throw new Error('EVAL_COMPUTER_SENSITIVE_WINDOW');
    if (step.kind === 'click') {
      const element = elements.find(element => element.name === step.name && element.type === step.type);
      if (!element || !focusable.includes(element)) throw new Error('EVAL_COMPUTER_TARGET_MISSING');
      focused = element.ref;
      if (element.type === 'TabItem') selectedTab = element.name;
      if (element.type === 'Button') activatedButton = element.name;
    } else if (step.kind === 'text') {
      if (!focused || !values.has(focused)) throw new Error('EVAL_COMPUTER_EDIT_NOT_FOCUSED');
      values.set(focused, values.get(focused)! + step.text);
    } else {
      if (step.key !== 'Tab' || !focusable.length) throw new Error('EVAL_COMPUTER_KEY_UNSUPPORTED');
      const index = focusable.findIndex(element => element.ref === focused);
      focused = focusable[(index + 1) % focusable.length]!.ref;
    }
  }
  return { view, perform };
}
