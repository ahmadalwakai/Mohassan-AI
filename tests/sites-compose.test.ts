import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkSite, composeSite, listZip, textFiles, zipFiles, type SiteImageAsset } from '@mohassan/sites';
import { SCENARIOS, runScenario } from '../packages/sites/fixtures/scenarios.ts';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('composeSite', () => {
  it('composes every fixture and passes every check', () => {
    for (const scenario of SCENARIOS) {
      const { brief } = runScenario(scenario);
      const site = composeSite(brief);
      const report = checkSite(site.files, brief);
      expect(report.passed, `${scenario.id}: ${report.checks.filter(check => !check.passed).map(check => check.message).join(' | ')}`).toBe(true);
      expect(site.files.some(file => file.path === '404.html')).toBe(true);
      expect(site.files.some(file => file.path === 'styles.css')).toBe(true);
      expect(site.files.some(file => file.path === 'assets/logo.svg')).toBe(true);
    }
  });
  it('is deterministic: the same brief gives identical bytes', () => {
    const { brief } = runScenario(SCENARIOS[0]!);
    const first = composeSite(brief), second = composeSite(brief);
    expect(textFiles(first.files).map(file => [file.path, file.content])).toEqual(textFiles(second.files).map(file => [file.path, file.content]));
    expect(zipFiles(first.files).equals(zipFiles(second.files))).toBe(true);
  });
  it('escapes user text everywhere', () => {
    const { brief } = runScenario(SCENARIOS[0]!);
    const hostile = { ...brief, name: '<script>alert(1)</script> & "quotes"', items: [{ title: '<img src=x onerror=alert(1)>', detail: 'a < b' }] };
    const site = composeSite(hostile);
    for (const file of textFiles(site.files)) {
      if (!file.path.endsWith('.html')) continue;
      expect(file.content).not.toContain('<script>alert');
      expect(file.content).not.toContain('<img src=x');
    }
    expect(checkSite(site.files, hostile).checks.find(check => check.id === 'no_inline_code')?.passed).toBe(true);
  });
  it('includes uploaded images with alt text and responsive variants', () => {
    const { brief } = runScenario(SCENARIOS.find(scenario => scenario.id === 'restaurant-ar')!);
    const image: SiteImageAsset = { id: randomUUID(), role: 'gallery', alt: 'صحن مشاوي', ext: 'png', bytes: PNG_1X1, width: 1200, height: 800, small: PNG_1X1 };
    const hero: SiteImageAsset = { id: randomUUID(), role: 'hero', alt: 'واجهة المطعم', ext: 'png', bytes: PNG_1X1, width: 1600, height: 1000 };
    const withImages = { ...brief, images: [{ id: image.id, role: image.role, alt: image.alt, ext: image.ext }, { id: hero.id, role: hero.role, alt: hero.alt, ext: hero.ext }], pages: brief.pages.map(page => (page.path === 'index.html' ? { ...page, blocks: [...page.blocks, { type: 'gallery' as const }] } : page)) };
    const site = composeSite(withImages, { images: [image, hero] });
    const index = textFiles(site.files).find(file => file.path === 'index.html')!.content;
    expect(index).toContain(`assets/${image.id}.png`);
    expect(index).toContain(`assets/${image.id}-small.png 640w`);
    expect(index).toContain('alt="صحن مشاوي"');
    expect(index).toContain('class="hero-img"');
    expect(site.files.some(file => file.path === `assets/${hero.id}.png`)).toBe(true);
    expect(checkSite(site.files, withImages).passed).toBe(true);
  });
  it('adds sitemap, canonical and robots only with a base URL', () => {
    const { brief } = runScenario(SCENARIOS[1]!);
    const plain = composeSite(brief);
    expect(plain.files.some(file => file.path === 'sitemap.xml')).toBe(false);
    const published = composeSite(brief, { baseUrl: 'https://swift.example' });
    const sitemap = textFiles(published.files).find(file => file.path === 'sitemap.xml')!.content;
    expect(sitemap).toContain('https://swift.example/');
    expect(sitemap).toContain('https://swift.example/contact.html');
    expect(textFiles(published.files).find(file => file.path === 'index.html')!.content).toContain('<link rel="canonical" href="https://swift.example/">');
    expect(textFiles(published.files).find(file => file.path === 'robots.txt')!.content).toContain('Sitemap: https://swift.example/sitemap.xml');
  });
  it('points the contact form at the inbox endpoint when the host provides one', () => {
    const { brief } = runScenario(SCENARIOS.find(scenario => scenario.id === 'catalogue-en')!);
    const site = composeSite(brief, { formEndpoint: 'https://api.example/inbox/abc' });
    const contact = textFiles(site.files).find(file => file.path === 'contact.html')!.content;
    expect(contact).toContain('action="https://api.example/inbox/abc"');
    expect(contact).toContain('form-action \'self\' mailto: https://wa.me https://api.example');
    expect(checkSite(site.files, brief, { formEndpoint: 'https://api.example/inbox/abc' }).passed).toBe(true);
  });
  it('writes a ZIP whose directory lists every file with the right CRC', () => {
    const { brief } = runScenario(SCENARIOS[2]!);
    const site = composeSite(brief);
    const archive = zipFiles(site.files);
    const entries = listZip(archive);
    expect(entries.map(entry => entry.path).sort()).toEqual(site.files.map(file => file.path).sort());
    expect(entries.every(entry => entry.size > 0)).toBe(true);
    expect(entries.find(entry => entry.path === 'index.html')?.method).toBe(8);
  });
});

describe('checkSite', () => {
  it('flags an invented number, a broken link and a missing alt', () => {
    const { brief } = runScenario(SCENARIOS[0]!);
    const site = composeSite(brief);
    const tampered = site.files.map(file => file.path === 'index.html' && typeof file.content === 'string'
      ? { ...file, content: file.content.replace('</main>', '<p>خصم 70% لأول 100 عميل</p><a href="missing.html">x</a><img src="assets/logo.svg"></main>') }
      : file);
    const report = checkSite(tampered, brief);
    expect(report.passed).toBe(false);
    expect(report.checks.find(check => check.id === 'digits_from_brief')?.passed).toBe(false);
    expect(report.checks.find(check => check.id === 'internal_links')?.passed).toBe(false);
    expect(report.checks.find(check => check.id === 'img_alt')?.passed).toBe(false);
  });
  it('flags external scripts and styles', () => {
    const { brief } = runScenario(SCENARIOS[0]!);
    const site = composeSite(brief);
    const tampered = site.files.map(file => file.path === 'index.html' && typeof file.content === 'string' ? { ...file, content: file.content.replace('</head>', '<script src="https://cdn.example/x.js"></script></head>') } : file);
    expect(checkSite(tampered, brief).checks.find(check => check.id === 'external_refs')?.passed).toBe(false);
  });
});
