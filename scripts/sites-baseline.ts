/**
 * Site-builder baseline. Plays every fixture scenario through the planner, composes the site, runs the
 * checker, writes the files and (unless --no-browser) screenshots each home page at three widths and
 * runs Lighthouse against a loopback static server. No model, no database, no external site.
 *
 * Run: npx tsx scripts/sites-baseline.ts [--out artifacts/sites-YYYY-MM-DD] [--no-browser] [--only id]
 * Every number in summary.md comes from this run; nothing is a target.
 */
import { createServer, type Server } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { checkSite, composeSite, contentTypeFor, zipFiles, type SiteFile } from '@mohassan/sites';
import { SCENARIOS, runScenario, type ScenarioRun } from '../packages/sites/fixtures/scenarios.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const today = new Date().toISOString().slice(0, 10);
const outDir = resolve(flag('--out') ?? `artifacts/sites-${today}`);
const noBrowser = args.includes('--no-browser');
const only = flag('--only');
const WIDTHS = [375, 768, 1280] as const;

interface Row { id: string; rounds: number; fields: number; unanswered: string[]; pages: number; files: number; bytes: number; composeMs: number; checksFailed: string[]; warnings: string[]; lighthouse?: Record<string, Record<string, number | null>>; screenshots?: string[]; error?: string }

function serve(files: SiteFile[]): Promise<{ server: Server; origin: string }> {
  const map = new Map<string, SiteFile>(files.map(file => [`/${file.path}`, file]));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = map.get(path) ?? map.get('/404.html');
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(map.has(path) ? 200 : 404, { 'content-type': file.contentType, 'cache-control': 'no-store' });
    response.end(typeof file.content === 'string' ? file.content : Buffer.from(file.content));
  });
  return new Promise(resolvePromise => server.listen(0, '127.0.0.1', () => { const address = server.address(); resolvePromise({ server, origin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` }); }));
}

async function measureInBrowser(run: ScenarioRun, files: SiteFile[], dir: string): Promise<Pick<Row, 'lighthouse' | 'screenshots'>> {
  const { chromium } = await import('playwright');
  const { server, origin } = await serve(files);
  const screenshots: string[] = [];
  const lighthouse: Record<string, Record<string, number | null>> = {};
  try {
    const browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=9333'] });
    try {
      for (const width of WIDTHS) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.goto(`${origin}/index.html`, { waitUntil: 'load' });
        const file = join(dir, `home-${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        screenshots.push(file);
        await page.close();
      }
      let lighthouseModule: typeof import('lighthouse') | null = null;
      try { lighthouseModule = await import('lighthouse'); } catch { lighthouseModule = null; }
      if (lighthouseModule) {
        for (const preset of ['mobile', 'desktop'] as const) {
          const result = await lighthouseModule.default(`${origin}/index.html`, { port: 9333, output: 'json', logLevel: 'silent', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'], formFactor: preset, screenEmulation: preset === 'desktop' ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false } : { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }, throttlingMethod: 'simulate' });
          const categories = result?.lhr.categories ?? {};
          lighthouse[preset] = Object.fromEntries(Object.entries(categories).map(([key, category]) => [key, category.score === null ? null : Math.round(category.score * 100)]));
          await writeFile(join(dir, `lighthouse-${preset}.json`), JSON.stringify({ categories: lighthouse[preset], audits: Object.fromEntries(Object.entries(result?.lhr.audits ?? {}).filter(([, audit]) => audit.score !== null && audit.score < 1).map(([key, audit]) => [key, { score: audit.score, title: audit.title, displayValue: audit.displayValue }])) }, null, 2));
        }
      } else lighthouse.unavailable = { note: null };
    } finally { await browser.close(); }
  } finally { server.close(); }
  return { lighthouse, screenshots };
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const rows: Row[] = [];
  for (const scenario of SCENARIOS) {
    if (only && scenario.id !== only) continue;
    const dir = join(outDir, scenario.id);
    await mkdir(dir, { recursive: true });
    try {
      const run = runScenario(scenario);
      const started = performance.now();
      const site = composeSite(run.brief);
      const composeMs = performance.now() - started;
      const report = checkSite(site.files, run.brief);
      for (const file of site.files) { const target = join(dir, 'site', file.path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, typeof file.content === 'string' ? file.content : Buffer.from(file.content)); }
      await writeFile(join(dir, 'brief.json'), JSON.stringify(run.brief, null, 2));
      await writeFile(join(dir, 'checks.json'), JSON.stringify(report, null, 2));
      await writeFile(join(dir, 'site.zip'), zipFiles(site.files));
      const row: Row = { id: scenario.id, rounds: run.rounds, fields: run.fieldsAsked.length, unanswered: run.unanswered, pages: report.pages, files: site.files.length, bytes: report.bytes, composeMs: Math.round(composeMs * 10) / 10, checksFailed: report.checks.filter(check => !check.passed).map(check => `${check.id}: ${check.message}`), warnings: site.warnings };
      if (!noBrowser) Object.assign(row, await measureInBrowser(run, site.files, dir));
      rows.push(row);
      console.log(`${scenario.id}: ${report.pages} pages, ${report.bytes} bytes, ${row.rounds} round(s), checks ${report.passed ? 'pass' : 'FAIL'}${row.lighthouse ? ` LH mobile ${JSON.stringify(row.lighthouse.mobile)}` : ''}`);
    } catch (error) {
      rows.push({ id: scenario.id, rounds: 0, fields: 0, unanswered: [], pages: 0, files: 0, bytes: 0, composeMs: 0, checksFailed: [], warnings: [], error: error instanceof Error ? error.message : String(error) });
      console.log(`${scenario.id}: ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0; };
  const ok = rows.filter(row => !row.error);
  const lines = [
    `# Site builder baseline — ${new Date().toISOString()}`,
    '',
    `Command: \`npx tsx scripts/sites-baseline.ts${args.length ? ` ${args.join(' ')}` : ''}\`; Node ${process.version}; output: \`${outDir}\``,
    '',
    `Scenarios: ${rows.length} (${ok.length} composed, ${rows.length - ok.length} errors). Checks passed: ${ok.filter(row => !row.checksFailed.length).length}/${ok.length}.`,
    `Medians: rounds ${median(ok.map(row => row.rounds))}, fields asked ${median(ok.map(row => row.fields))}, pages ${median(ok.map(row => row.pages))}, bytes ${median(ok.map(row => row.bytes))}, compose ${median(ok.map(row => row.composeMs))} ms.`,
    ...(ok.some(row => row.lighthouse?.mobile) ? [`Lighthouse medians (mobile): ${['performance', 'accessibility', 'best-practices', 'seo'].map(key => `${key} ${median(ok.map(row => row.lighthouse?.mobile?.[key] ?? 0))}`).join(', ')}.`, `Lighthouse medians (desktop): ${['performance', 'accessibility', 'best-practices', 'seo'].map(key => `${key} ${median(ok.map(row => row.lighthouse?.desktop?.[key] ?? 0))}`).join(', ')}.`] : ['Lighthouse: not run (browser disabled or lighthouse not installed).']),
    '',
    '| scenario | rounds | fields | unanswered | pages | files | bytes | compose ms | checks | LH mobile P/A/BP/SEO | LH desktop P/A/BP/SEO | warnings |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(row => row.error ? `| ${row.id} | – | – | – | – | – | – | – | ERROR: ${row.error} | – | – | – |` : `| ${row.id} | ${row.rounds} | ${row.fields} | ${row.unanswered.join(' ') || '–'} | ${row.pages} | ${row.files} | ${row.bytes} | ${row.composeMs} | ${row.checksFailed.length ? row.checksFailed.join('; ') : 'pass'} | ${row.lighthouse?.mobile ? ['performance', 'accessibility', 'best-practices', 'seo'].map(key => row.lighthouse!.mobile![key] ?? '–').join('/') : '–'} | ${row.lighthouse?.desktop ? ['performance', 'accessibility', 'best-practices', 'seo'].map(key => row.lighthouse!.desktop![key] ?? '–').join('/') : '–'} | ${row.warnings.join('; ') || '–'} |`),
    '',
    'Thresholds are not set here: the owner fixes them after reading this baseline.',
  ];
  await writeFile(join(outDir, 'summary.md'), lines.join('\n'));
  await writeFile(join(outDir, 'rows.json'), JSON.stringify(rows, null, 2));
  console.log(`\nSummary: ${join(outDir, 'summary.md')}`);
}

main().catch(error => { console.error(error); process.exit(1); });
