import { chromium } from 'playwright';

// Uses an isolated temporary browser context, not the owner's persistent profile.
let browser;
try {
  browser = await chromium.launch({ headless: true, timeout: 30000 });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>Mohassan browser check</title><p lang="ar">جاهز</p>');
  if (await page.title() !== 'Mohassan browser check') throw new Error('Browser did not render.');
  const screenshot = await page.screenshot();
  if (screenshot.byteLength < 100) throw new Error('Browser screenshot was empty.');
  console.log(JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, browser: browser.version() }));
} catch {
  console.error(JSON.stringify({ ok: false, check: 'chromium_launch_render_screenshot' }));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
