import { describe, expect, it } from 'vitest';
import { ChatKeyboardSchema } from '@mohassan/contracts';
import { takeoverInput } from '../apps/web/components/takeover-input.ts';

describe('takeover typing', () => {
  it('sends the text and Enter as one ordered request', () => {
    // Two parallel requests let Enter arrive first, and Google then dropped the text.
    expect(ChatKeyboardSchema.parse(takeoverInput('name@example.com'))).toEqual({ text: 'name@example.com', key: 'Enter' });
  });

  it('sends Enter alone when nothing was typed', () => {
    expect(ChatKeyboardSchema.parse(takeoverInput(''))).toEqual({ key: 'Enter' });
  });
});
