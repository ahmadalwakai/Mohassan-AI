import { describe, expect, it } from 'vitest';
import { runPlanComputation } from '../apps/server/src/assistant/plan/local-tools.js';
import { parseSourceComputation } from '../apps/server/src/assistant/plan/source-computation.js';
import type { PlanReference, PlanStep, PlanValue } from '../apps/server/src/assistant/plan/types.js';

const now = new Date('2026-11-25T00:00:00Z');
const reference: PlanReference = { stepId: 'source', kind: 'number' };

function calculate(text: string, source?: PlanValue) {
  const step: PlanStep = { id: 'math', tool: 'compute', route: 'compute', text, success: 'number', output: 'number',
    inputs: { text, references: source ? [reference] : [] }, dependsOn: source ? [reference.stepId] : [], publicInput: true };
  return runPlanComputation(step, { text, references: source ? [{ reference, value: source }] : [] }, now);
}

describe('source-dependent plan calculations', () => {
  it('scales one measured unit and converts the total with the shared calculator', () => {
    const text = 'Work out the total for eight panels in centimetres.';
    expect(calculate(text, { type: 'number', value: 0.75, unit: 'm' })).toMatchObject({
      ok: true, value: { type: 'number', value: 600, unit: 'centimetres' }, evidence: { kind: 'computation' },
    });
    expect(calculate(text, { type: 'number', value: 0.75, unit: 'l' })).toMatchObject({ ok: false, reason: 'invalid_result' });
    expect(calculate(text)).toMatchObject({ ok: false });
  });

  it('recognizes Arabic count words and validates percentage discounts', () => {
    expect(calculate('احسب عدد الصفحات في ست كراسات.', { type: 'number', value: 32 })).toMatchObject({
      ok: true, value: { type: 'number', value: 192 },
    });
    expect(calculate('اخصم ١٥٪ منه.', { type: 'number', value: 60, unit: 'EUR' })).toMatchObject({
      ok: true, value: { type: 'number', value: 51, unit: 'EUR' },
    });
    expect(parseSourceComputation('اخصم ١٢٥٪ منه.')).toBeNull();
  });

  it('computes change only when the budget and source currency agree', () => {
    const text = 'Compute the change from €80 after buying three vouchers.';
    expect(calculate(text, { type: 'number', value: 8.25, unit: 'EUR' })).toMatchObject({
      ok: true, value: { type: 'number', value: 55.25, unit: 'EUR' },
    });
    expect(calculate(text, { type: 'number', value: 8.25, unit: 'GBP' })).toMatchObject({ ok: false, reason: 'missing_input' });
    expect(calculate(text, { type: 'number', value: 8.25 })).toMatchObject({ ok: false, reason: 'missing_input' });
    expect(calculate('احسب الباقي من ٧٠ يورو بعد شراء ثمان حبات.', { type: 'number', value: 6, unit: 'EUR' })).toMatchObject({
      ok: true, value: { type: 'number', value: 22, unit: 'EUR' },
    });
  });

  it('supports a single source operand in explicit operations and preserves its units', () => {
    expect(calculate('Subtract two omitted samples from one packet.', { type: 'number', value: 19 })).toMatchObject({
      ok: true, value: { type: 'number', value: 17 },
    });
    expect(calculate('Multiply the volume by 7 to find the total.', { type: 'number', value: 11, unit: 'l' })).toMatchObject({
      ok: true, value: { type: 'number', value: 77, unit: 'l' },
    });
    expect(calculate('Divide it by two.', { type: 'number', value: 11 })).toMatchObject({
      ok: true, value: { type: 'number', value: 5.5 },
    });
  });

  it('rejects competing quantities and separate actions', () => {
    expect(parseSourceComputation('Work out the cost for ten or twelve trays.')).toBeNull();
    expect(parseSourceComputation('Multiply it by 2 to get the number of sheets for three bundles.')).toBeNull();
    expect(parseSourceComputation('Calculate the price for six bottles and email the receipt.')).toBeNull();
    expect(parseSourceComputation('Calculate 5 + 3.')).toBeNull();
  });

  it('requires a compatible scalar measurement for the requested total', () => {
    const volume = 'Work out the volume for four crates.';
    const price = 'Calculate the price for eighteen bags.';
    expect(calculate(volume, { type: 'number', value: 3, unit: 'GBP' })).toMatchObject({ ok: false, reason: 'missing_input' });
    expect(calculate(price, { type: 'number', value: 3, unit: 'USD/g' })).toMatchObject({ ok: false, reason: 'missing_input' });
    expect(calculate('Subtract two feet from the total.', { type: 'number', value: 3, unit: 'm' })).toMatchObject({ ok: false });
    expect(calculate(price, { type: 'number', value: 3, unit: 'USD' })).toMatchObject({ ok: true,
      value: { type: 'number', value: 54, unit: 'USD' },
    });
  });

  it('accepts the colloquial Arabic target only within a complete conversion', () => {
    expect(calculate('حوّل ٢٫٥ ساعة للدقايق.')).toMatchObject({ ok: true, value: { type: 'number', value: 150 } });
    expect(calculate('حوّل ١٥ دقايق للثواني.')).toMatchObject({ ok: true, value: { type: 'number', value: 900 } });
    expect(calculate('حوّل ٢٫٥ ساعة للدقايق وأرسل الجواب.')).toMatchObject({ ok: false });
  });
});
