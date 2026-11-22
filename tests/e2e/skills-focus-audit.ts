import { test } from '@playwright/test';

// Diagnostic wrapper only: the imported original skills case and its acceptance
// assertions are unchanged. The default Playwright *.spec.ts discovery excludes
// this file; run only with playwright.skills-focus-audit.config.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    type FocusEntry = Record<string, unknown>;
    const entries: FocusEntry[] = [];
    const describe = (element: Element | null): FocusEntry | null => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return { tag: element.tagName, id: element.id, className: element.className,
        label: element.getAttribute('aria-label'), text: element.textContent?.trim().slice(0, 120),
        tabIndex: (element as HTMLElement).tabIndex, focusVisible: element.matches(':focus-visible'),
        outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor,
        boxShadow: style.boxShadow };
    };
    const add = (entry: FocusEntry) => {
      entries.push({ at: performance.now(), ...entry });
      if (entries.length > 400) entries.shift();
    };
    Object.defineProperty(window, '__skillsFocusAudit', { value: { entries, describe } });
    document.addEventListener('focusin', event => add({ event: 'focusin', target: describe(event.target as Element) }), true);
    document.addEventListener('focusout', event => add({ event: 'focusout', target: describe(event.target as Element),
      related: describe(event.relatedTarget as Element | null) }), true);
    document.addEventListener('keydown', event => { if (event.key === 'Tab') add({ event: 'Tab', active: describe(document.activeElement) }); }, true);
    window.addEventListener('offline', () => add({ event: 'offline', active: describe(document.activeElement) }));
    window.addEventListener('online', () => add({ event: 'online', active: describe(document.activeElement) }));
    const actualFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...arguments_: Parameters<HTMLElement['focus']>) {
      add({ event: 'programmatic-focus', target: describe(this), stack: new Error().stack?.slice(0, 2500) });
      return actualFocus.apply(this, arguments_);
    };
  });
});

test.afterEach(async ({ page }, info) => {
  const diagnostic = await page.evaluate(() => {
    const audit = (window as unknown as { __skillsFocusAudit?: { entries: unknown[]; describe(element: Element | null): unknown } }).__skillsFocusAudit;
    return audit ? { active: audit.describe(document.activeElement), entries: audit.entries,
      inputs: [...document.querySelectorAll('form[aria-label="تصفية المهارات"] input, form[aria-label="تصفية المهارات"] select')]
        .map(element => audit.describe(element)), online: navigator.onLine } : { unavailable: true };
  }).catch(error => ({ error: String(error) }));
  await info.attach('keyboard-focus-dom-diagnostic', { body: JSON.stringify(diagnostic, null, 2), contentType: 'application/json' });
});

await import('./skills.spec');
