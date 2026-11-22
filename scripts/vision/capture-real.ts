/**
 * Capture real pages as screenshots with their visible text, for measuring the
 * reader on genuine screens rather than rendered lines.
 *
 *   npx tsx scripts/vision/capture-real.ts --out artifacts/vision-ocr-v1/real [--channel msedge]
 *
 * For each page: <name>.png (the viewport), <name>-dark.png when the site offers a
 * dark theme through prefers-color-scheme, and <name>.txt (innerText of the body).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PAGES: { name: string; url: string; dark?: boolean }[] = [
  { name: 'arwiki-ai', url: 'https://ar.wikipedia.org/wiki/%D8%B0%D9%83%D8%A7%D8%A1_%D8%A7%D8%B5%D8%B7%D9%86%D8%A7%D8%B9%D9%8A' },
  { name: 'enwiki-ocr', url: 'https://en.wikipedia.org/wiki/Optical_character_recognition' },
  { name: 'mdn-canvas', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API', dark: true },
  { name: 'bbc-arabic', url: 'https://www.bbc.com/arabic' },
  { name: 'aljazeera', url: 'https://www.aljazeera.net/' },
  { name: 'python-docs', url: 'https://docs.python.org/3/tutorial/introduction.html' },
];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const out = arg('--out', join('artifacts', 'vision-ocr-v1', 'real'));
  await mkdir(out, { recursive: true });
  const channels = [arg('--channel', ''), 'msedge', 'chrome', ''].filter((value, index, all) => all.indexOf(value) === index);
  let browser = null;
  for (const channel of channels) {
    try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); console.log('browser', channel || 'bundled chromium'); break; } catch (error) { console.log('cannot launch', channel || 'bundled chromium', (error as Error).message.split('\n')[0]); }
  }
  if (!browser) throw new Error('no browser available');
  const results: Record<string, unknown>[] = [];
  for (const page of PAGES) {
    for (const scheme of page.dark ? ['light', 'dark'] as const : ['light'] as const) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme, locale: 'ar' });
      const tab = await context.newPage();
      const name = scheme === 'dark' ? `${page.name}-dark` : page.name;
      try {
        await tab.goto(page.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await tab.waitForTimeout(2500);
        const text = await tab.evaluate(() => {
          const viewportHeight = window.innerHeight, viewportWidth = window.innerWidth;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const lines: string[] = [];
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const value = node.textContent?.replace(/\s+/g, ' ').trim();
            if (!value || !node.parentElement) continue;
            const style = getComputedStyle(node.parentElement);
            if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            const rect = range.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) continue;
            lines.push(value);
          }
          return lines.join('\n');
        });
        await tab.screenshot({ path: join(out, `${name}.png`), fullPage: false });
        await writeFile(join(out, `${name}.txt`), text, 'utf-8');
        results.push({ name, url: page.url, scheme, words: text.split(/\s+/).filter(Boolean).length });
        console.log('captured', name, text.split(/\s+/).filter(Boolean).length, 'visible words');
      } catch (error) {
        console.log('failed', name, (error as Error).message.split('\n')[0]);
        results.push({ name, url: page.url, scheme, error: (error as Error).message.split('\n')[0] });
      } finally {
        await context.close();
      }
    }
  }
  await browser.close();
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), viewport: '1280x900', pages: results }, null, 1), 'utf-8');
}

main().catch(error => { console.error(error); process.exit(1); });
