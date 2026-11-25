import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { AgentElement } from '../packages/browser/src/agent-browser.js';
import { findBrowserHandsElement, writeBrowserHandsControl } from '../packages/browser/src/browser-hands-dom.js';

describe('browser hands DOM safeguards', () => {
  it('prefers a literal target to a bilingual alias and rejects unqualified duplicates', () => {
    const element = (ref: string, label: string): AgentElement => ({ ref, label, role: 'button', inViewport: true });
    const elements = [element('e1', 'Next'), element('e2', 'التالي'), element('e3', 'التالي')];
    expect(findBrowserHandsElement(elements, { name: 'Next' }, { kind: 'click' })).toEqual({ status: 'matched', element: elements[0] });
    expect(findBrowserHandsElement(elements, { name: 'التَّالي' }, { kind: 'click' })).toEqual({ status: 'ambiguous' });
    expect(findBrowserHandsElement([elements[0]], { name: 'كمل' }, { kind: 'click' })).toEqual({ status: 'matched', element: elements[0] });
  });

  it('uses a unique whole-word match only in the alternative strategy', () => {
    const target: AgentElement = { ref: 'e1', label: 'Find products', role: 'button', inViewport: true };
    expect(findBrowserHandsElement([target], { name: 'products' }, { kind: 'click' })).toEqual({ status: 'missing' });
    expect(findBrowserHandsElement([target], { name: 'products' }, { kind: 'click', alternative: true })).toEqual({ status: 'matched', element: target });
    expect(findBrowserHandsElement([target], { name: 'product' }, { kind: 'click', alternative: true })).toEqual({ status: 'missing' });
  });

  it('ends a rejected controlled write without repeating the input event', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<input aria-label="Quantity"><output>0</output>');
      const control = (await page.$('input'))!;
      await control.evaluate(node => node.addEventListener('input', () => {
        const events = document.querySelector('output')!;
        events.textContent = String(Number(events.textContent) + 1);
        setTimeout(() => { (node as HTMLInputElement).value = ''; }, 30);
      }));
      await expect(writeBrowserHandsControl(control, { kind: 'type', value: '17' }, async () => {})).rejects.toMatchObject({ code: 'AGENT_FIELD_UNVERIFIED' });
      expect(await page.locator('output').textContent()).toBe('1');
      expect(await page.locator('input').inputValue()).toBe('');
    } finally {
      await browser.close();
    }
  });

  it('writes Arabic digits into a native date picker and verifies its ISO value', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<label>التاريخ<input type="date"></label>');
      const guard = async (value: string) => { expect(value).toBe('2026-11-25'); };
      await writeBrowserHandsControl((await page.$('input'))!, { kind: 'type', value: '٢٠٢٦-١١-٢٥' }, guard);
      expect(await page.locator('input').inputValue()).toBe('2026-11-25');
    } finally {
      await browser.close();
    }
  });
});
