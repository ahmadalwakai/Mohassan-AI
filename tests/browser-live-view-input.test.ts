import type { Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { activeBrowserRedactions, applyBrowserTakeoverInput } from '../packages/browser/src/browser-takeover-input';

it('routes the wheel at the supplied point and records incrementally typed field values only for masking', async () => {
  const page = {
    mouse: { move: vi.fn(async () => {}), wheel: vi.fn(async () => {}) },
    keyboard: { insertText: vi.fn(async () => {}), press: vi.fn(async () => {}) },
    frames: () => [{ evaluate: vi.fn(async () => 'fixture-field-value') }],
  };
  const redactions = new Map<string, number>();
  await applyBrowserTakeoverInput(page as unknown as Page, { width: 1280, height: 800 }, {
    wheel: { x: 0.25, y: 0.5, deltaX: -30, deltaY: 80 },
    text: 'e',
    key: 'Enter',
  }, redactions);
  expect(page.mouse.move).toHaveBeenCalledWith(320, 400);
  expect(page.mouse.wheel).toHaveBeenCalledWith(-30, 80);
  expect(page.keyboard.insertText).toHaveBeenCalledWith('e');
  expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
  expect(page.keyboard.insertText.mock.invocationCallOrder[0]).toBeLessThan(page.keyboard.press.mock.invocationCallOrder[0]);
  expect(redactions.has('fixture-field-value')).toBe(true);
});

it('drops expired masking values and matches the full value before any prefix', () => {
  const redactions = new Map([['fixture', 50], ['old fixture', 30], ['fixture-field-value', 50]]);
  expect(activeBrowserRedactions(redactions, 30)).toEqual(['fixture-field-value', 'fixture']);
  expect(redactions.has('old fixture')).toBe(false);
});
