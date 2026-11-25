import type { Page } from 'playwright';

export interface BrowserTakeoverInput {
  text?: string;
  key?: string;
  wheel?: { x: number; y: number; deltaX: number; deltaY: number };
}

export function activeBrowserRedactions(redactions: Map<string, number>, now = Date.now()): string[] {
  for (const [text, expires] of redactions) {
    if (expires <= now) redactions.delete(text);
  }
  return [...redactions.keys()].sort((first, second) => second.length - first.length);
}

export async function applyBrowserTakeoverInput(
  page: Pick<Page, 'mouse' | 'keyboard' | 'frames'>,
  viewport: { width: number; height: number },
  input: BrowserTakeoverInput,
  redactions: Map<string, number>,
): Promise<void> {
  if (input.wheel) {
    const { x, y, deltaX, deltaY } = input.wheel;
    await page.mouse.move(x * viewport.width, y * viewport.height);
    await page.mouse.wheel(deltaX, deltaY);
  }
  if (input.text) {
    const remember = (text: string) => {
      if (text.length >= 4) redactions.set(text, Date.now() + 10 * 60_000);
    };
    remember(input.text);
    await page.keyboard.insertText(input.text);
    // InsertText can arrive one character at a time. Record the combined field only for in-memory masking.
    for (const frame of page.frames().slice(0, 6)) {
      const value = await frame.evaluate(() => {
        if (!document.hasFocus()) return '';
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return active.value.slice(0, 2000);
        if (active instanceof HTMLElement && active.isContentEditable) return active.textContent?.slice(0, 2000) ?? '';
        return '';
      }).catch(() => '');
      if (value) { remember(value); break; }
    }
  }
  if (input.key) await page.keyboard.press(input.key).catch(() => {});
}
