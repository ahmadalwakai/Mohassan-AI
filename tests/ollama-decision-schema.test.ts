import { describe, expect, it } from 'vitest';
import { boundedDecisionJsonSchema, decisionJsonSchema, decisionSchema } from '../apps/server/src/assistant/brain.js';

describe('bounded decision schema for the local model', () => {
  it('carries the validator limits without changing the cloud schema', () => {
    const base = decisionJsonSchema(false, false, ['workspace_list']);
    const bounded = boundedDecisionJsonSchema(base) as { properties: Record<string, any> };
    expect(bounded.properties.thought.maxLength).toBe(600);
    expect(bounded.properties.note.maxLength).toBe(300);
    expect(bounded.properties.ref.maxLength).toBe(12);
    expect(bounded.properties.options).toMatchObject({ maxItems: 5, items: { type: 'string', maxLength: 120 } });
    expect(bounded.properties.plan).toMatchObject({ maxItems: 10, items: { maxLength: 160 } });
    expect(bounded.properties.tool).toEqual((base.properties as Record<string, unknown>).tool);
    expect((base.properties as Record<string, any>).thought.maxLength).toBeUndefined();
  });

  it('matches what the validator rejects', () => {
    const decision = { thought: 'x'.repeat(601), plan: null, note: null, tool: 'answer', url: null, ref: null, text: 'ok', submit: null, options: null, sensitive: null, outcome: 'done' };
    expect(decisionSchema().safeParse(decision).success).toBe(false);
    expect(decisionSchema().safeParse({ ...decision, thought: 'x'.repeat(600) }).success).toBe(true);
  });
});
