/** A bounded public-site read check. No config/.env, owner profiles, credentials, model or SQL. */
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentBrowser, type AgentAuthority, type AgentPostcondition } from '@mohassan/browser';
import { captureEvidenceSources, createEvidenceRun } from './lib/evidence-report.js';

const argumentsText = process.argv.slice(2).join(' '), wikipediaOnly = argumentsText === '--live --wikipedia-ar', mdnOnly = argumentsText === '--live --mdn';
if (argumentsText !== '--live' && !wikipediaOnly && !mdnOnly) throw new Error('Use --live for five public destinations, --live --wikipedia-ar for Wikipedia, or --live --mdn for the fixed MDN check.');
const repository = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  { id: 'wikipedia', url: 'https://www.wikipedia.org/', title: 'Wikipedia', text: 'الموسوعة الحرة' },
  { id: 'gov-uk', url: 'https://www.gov.uk/', title: 'Welcome to GOV.UK', text: 'government services and information' },
  { id: 'mdn-javascript', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript', title: 'JavaScript | MDN', text: 'JavaScript' },
  { id: 'python', url: 'https://www.python.org/', title: 'Welcome to Python.org', text: 'Python' },
  { id: 'w3c', url: 'https://www.w3.org/', title: 'W3C', text: 'Making the web work' },
] as const;
const selected = wikipediaOnly ? cases.filter(test => test.id === 'wikipedia') : mdnOnly ? cases.filter(test => test.id === 'mdn-javascript') : cases;
async function sourceFiles() {
  const files = ['scripts/check-browser-readonly.ts', 'scripts/lib/evidence-report.ts', 'package.json', 'package-lock.json', 'packages/browser/package.json', 'packages/contracts/package.json'];
  for (const directory of ['packages/browser/src', 'packages/contracts/src']) {
    files.push(...(await readdir(path.join(repository, directory), { recursive: true })).filter(name => /\.ts$/.test(name) && !/\.(?:test|spec)\.ts$/.test(name)).map(name => directory + '/' + name.replaceAll('\\', '/')));
  }
  return files;
}
const startedAt = new Date().toISOString(), run = await createEvidenceRun(repository, 'browser-public-readonly', startedAt);
const source = await captureEvidenceSources(repository, await sourceFiles(), run.directory), parent = await realpath(tmpdir());
const profile = await mkdtemp(path.join(parent, 'mohassan-live-readonly-'));
const browser = new AgentBrowser({ profileDir: profile, allowedOrigins: selected.map(entry => new URL(entry.url).origin), channel: null, headless: true });
const results: Record<string, unknown>[] = [];
let effectDispatches = 0;
try {
  for (const test of selected) {
    const start = Date.now(), signal = AbortSignal.timeout(40000);
    const authority: AgentAuthority = { signal, assertActive: async () => { signal.throwIfAborted(); }, dispatched: async () => { effectDispatches++; throw new Error('Public read check cannot dispatch effects'); }, completed: async () => {} };
    const expected: AgentPostcondition[] = [{ kind: 'url', equals: test.url }, { kind: 'title', equals: test.title }, { kind: 'http_status', allowed: [200] }, { kind: 'text', contains: test.text }];
    try {
      const first = await browser.act('public-readonly-fixture', test.id, { kind: 'open', text: test.url }, authority);
      const result = await browser.verifyPostconditions('public-readonly-fixture', test.id, expected, authority, { timeoutMs: 1500 });
      results.push({ id: test.id, url: test.url, expected, passed: result.verification.status === 'passed' && !result.page.signals.captcha, durationMs: Date.now() - start, initialPageHash: first.page.hash, pageHash: result.page.hash, observedAt: result.page.observedAt, actualTitle: result.page.title, actualUrl: result.page.url, status: result.page.documentStatus, captcha: result.page.signals.captcha, verification: result.verification });
    } catch (error: any) {
      results.push({ id: test.id, url: test.url, expected, passed: false, durationMs: Date.now() - start, errorCode: String(error?.code ?? error?.name ?? 'ERROR') });
    } finally { await browser.closeConversation('public-readonly-fixture', test.id).catch(() => {}); }
    console.log(JSON.stringify({ id: test.id, passed: results.at(-1)!.passed, errorCode: results.at(-1)!.errorCode }));
  }
} finally {
  await browser.close();
  const actual = await realpath(profile), within = path.relative(parent, actual);
  if (path.isAbsolute(within) || !within.startsWith('mohassan-live-readonly-') || within.includes('..')) throw new Error('Unsafe temporary-profile cleanup');
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
const finalSource = await captureEvidenceSources(repository, await sourceFiles()), sourceStable = finalSource.hash === source.hash;
const report = { version: 3, mode: mdnOnly ? 'public_readonly_mdn' : wikipediaOnly ? 'public_readonly_arabic_locale' : 'public_readonly', ...(mdnOnly ? {} : { oracleCorrection: 'Wikipedia text expectation matches the fixed ar browser locale; original English-oracle failure is retained in browser-public-readonly.json.' }), startedAt, finishedAt: new Date().toISOString(), source, finalSource, sourceStable, ownerProfilesUsed: false, loginTested: false, modelRequests: 0, effectDispatches, passed: results.filter(result => result.passed).length, total: selected.length, accepted: sourceStable && effectDispatches === 0 && results.every(result => result.passed), results };
await run.writeReport(report);
console.log(JSON.stringify({ passed: report.passed, total: report.total, accepted: report.accepted, sourceHash: source.hash, sourceStable, reportPath: run.reportPath }));
if (!report.accepted) process.exitCode = 1;
