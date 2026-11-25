import { describe, expect, it } from 'vitest';
import { classifyRefusal } from '../apps/server/src/assistant/refusal/classifier.js';
import { assessRequestScope } from '../apps/server/src/assistant/request-scope.js';
import {
  arabicAllowed, arabicAllowedWithContext, arabicRefusals,
  englishAllowed, englishAllowedWithContext, englishRefusals,
} from './fixtures/refusal-development.js';

const languages = [
  { name: 'English', refused: englishRefusals, allowed: englishAllowed, context: englishAllowedWithContext },
  { name: 'Arabic', refused: arabicRefusals, allowed: arabicAllowed, context: arabicAllowedWithContext },
];

function decisionCode(text: string, fullAccess = true, computer = true) {
  const scope = assessRequestScope(text);
  return classifyRefusal(text, { fullAccess, scope, capabilities: { computer } })?.code ?? null;
}

describe('refusal development corpus', () => {
  it.each(languages)('$name labels match without over-refusing allowed requests', ({ name, refused, allowed, context }) => {
    const entries: [string, readonly string[]][] = Object.entries(refused);
    const refusalCases = entries.flatMap(([reason, texts]) => texts.map(text => ({
      text, reason, actual: decisionCode(text, reason !== 'role', reason !== 'no_access'),
    })));
    const permitted = [
      ...allowed.map(text => ({ text, actual: decisionCode(text) })),
      ...context.map(({ text, fullAccess, computer }) => ({ text, actual: decisionCode(text, fullAccess, computer) })),
    ];
    const reasonMismatches = refusalCases.filter(({ reason, actual }) => reason !== actual);
    const missedRefusals = refusalCases.filter(({ actual }) => actual === null).length;
    const overRefusals = permitted.filter(({ actual }) => actual !== null);

    console.info(`${name} development: refused ${refusalCases.length - missedRefusals}/${refusalCases.length}, ` +
      `correct reason ${refusalCases.length - reasonMismatches.length}/${refusalCases.length}, ` +
      `over-refused ${overRefusals.length}/${permitted.length}`);

    expect(refusalCases).toHaveLength(45);
    expect(permitted).toHaveLength(45);
    expect({ reasonMismatches, overRefusals }).toEqual({ reasonMismatches: [], overRefusals: [] });
  });
});
