import { describe, expect, it } from 'vitest';
import { understandRequest } from '../apps/server/src/assistant/understanding/index.js';
import { documentedRequests } from './fixtures/arabic-understanding-documented.js';

describe('requests quoted in the November 22 and 23 reports', () => {
  it.each(documentedRequests)('$source · $text', ({ text, expected }) => {
    const understanding = understandRequest(text);
    expect(understanding.displayText).toBe(text);
    expect(understanding.matchText).not.toBe('');
    // Source failures also include downstream retrieval, answer selection, printing, and planning.
    // Where an expected question is annotated, this check covers the understanding step.
    if (expected === null) expect(understanding.question).toBeNull();
    else if (expected) expect(understanding.question).toMatchObject(expected);
  });
});
