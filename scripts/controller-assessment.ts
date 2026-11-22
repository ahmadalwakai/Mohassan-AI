/** Visible synthetic development tasks through the actual isolated controller. No .env or external inference. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentBrowser, type AgentAction, type AgentCaptureResult, type AgentPage, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { extractPublicSearchQueries } from '../apps/server/src/assistant/public-query-provenance.js';
import { controllerAssessmentSummary, controllerDatasetHash, scoreControllerAssessmentCase, validateControllerAssessmentDataset,
  type ControllerAssessmentCase, type ControllerAssessmentTurn, type ControllerCaseObservation, type ControllerCaseScore, type ControllerTurnObservation } from '../packages/learning/src/controller-assessment.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'isolated-controller-assessment-owner';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourcePaths = [
  'scripts/controller-assessment.ts', 'packages/learning/src/controller-assessment.ts', 'apps/server/src/command-chat.ts',
  'apps/server/src/assistant/brain.ts', 'apps/server/src/assistant/request-context.ts', 'apps/server/src/assistant/request-scope.ts',
  'apps/server/src/assistant/routing-decision.ts', 'apps/server/src/assistant/capability-reply.ts', 'apps/server/src/assistant/public-query-provenance.ts',
  'apps/server/src/assistant/local-computation.ts', 'apps/server/src/assistant/calculator.ts', 'apps/server/src/assistant/compound-request.ts',
  'apps/server/src/assistant/local-conversation.ts', 'apps/server/src/assistant/local-recall.ts', 'apps/server/src/assistant/local-knowledge.ts',
  'apps/server/src/assistant/mind/compute.ts', 'apps/server/src/assistant/mind/computation-consumption.ts', 'apps/server/src/assistant/mind/frame.ts',
  'apps/server/src/assistant/mind/normalize.ts', 'apps/server/src/assistant/mind/recall.ts', 'apps/server/src/assistant/mind/limits.ts',
  'apps/server/src/assistant/memory-recall.ts', 'apps/server/src/assistant/writer.ts', 'apps/server/src/assistant/planner.ts',
  'apps/server/src/assistant/hands.ts', 'apps/server/src/assistant/chat-supervision.ts', 'apps/server/src/assistant/task-supervisor.ts',
  'apps/server/src/assistant/capture-evidence.ts', 'apps/server/src/assistant/verification.ts', 'apps/server/src/assistant/progress-recovery.ts',
  'packages/browser/src/agent-browser.ts', 'packages/browser/src/session-state.ts', 'packages/database/src/index.ts',
  'packages/contracts/src/index.ts', 'package-lock.json', 'tests/fixtures/controller-assessment/synthetic-2px.jpg',
];
export interface ControllerAssessmentArguments { dataset: string; output: string; realBrowser: boolean; caseId?: string }
export function controllerAssessmentArguments(args: readonly string[]): ControllerAssessmentArguments {
  const values = new Map<string, string>(); let realBrowser = false;
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (name === '--real-browser' && !realBrowser) { realBrowser = true; continue; }
    const value = args[++index];
    if (!['--dataset', '--output', '--case'].includes(name) || values.has(name) || !value || value.startsWith('--')) throw new Error('CONTROLLER_ASSESSMENT_ARGUMENTS');
    values.set(name, value);
  }
  return { dataset: resolve(values.get('--dataset') ?? join(ROOT, 'tests/fixtures/controller-assessment/development-v1.json')),
    output: resolve(values.get('--output') ?? join(ROOT, `artifacts/controller-assessment/${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.json`)),
    realBrowser, ...(values.has('--case') ? { caseId: values.get('--case')! } : {}) };
}

function pageFrom(fixture: ControllerAssessmentCase['fixture']['publicPages'][number], origin: string): AgentPage {
  const url = fixture.url.replaceAll('{{origin}}', origin);
  return { id: randomUUID(), url, title: fixture.title, text: fixture.text, documentStatus: fixture.status, hash: hash(JSON.stringify([url, fixture.title, fixture.text, fixture.status])),
    elements: [], signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 200, viewport: 800 }, observedAt: new Date().toISOString() };
}
const clonePage = (page: AgentPage): AgentPage => ({ ...page, id: randomUUID(), observedAt: new Date().toISOString() });
const escapeHtml = (text: string) => text.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Each case gets a fresh embedded database and only declared fixture facts. */
export async function observeControllerAssessmentCase(item: ControllerAssessmentCase, options: { realBrowser?: boolean } = {}): Promise<ControllerCaseObservation> {
  const setupStarted = performance.now();
  const database = await createDatabase({});
  if (database.mode !== 'embedded') throw new Error('CONTROLLER_ASSESSMENT_REQUIRES_EMBEDDED_DATABASE');
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  let browser: AgentBrowser | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let profileRoot: string | undefined, temporaryRoot: string | undefined;
  const captureMode = item.fixture.capture ? options.realBrowser ? 'real-loopback-chromium' : 'synthetic-boundary' : 'none';
  const turns: ControllerTurnObservation[] = [];
  let setupMs = 0;
  try {
    await migrate(database.db);
    let origin = 'https://controller-assessment.invalid';
    if (captureMode === 'real-loopback-chromium') {
      server = createServer((request, response) => {
        const path = new URL(request.url!, 'http://localhost').pathname;
        const fixture = item.fixture.publicPages.find(page => new URL(page.url.replaceAll('{{origin}}', 'http://localhost')).pathname === path);
        response.writeHead(fixture?.status ?? 404, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head><title>${escapeHtml(fixture?.title ?? 'Missing fixture')}</title></head><body><main><h1>${escapeHtml(fixture?.title ?? 'Missing fixture')}</h1><p>${escapeHtml(fixture?.text ?? 'No declared fixture page.')}</p></main></body></html>`);
      });
      await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('CONTROLLER_ASSESSMENT_LOCAL_PORT');
      origin = `http://127.0.0.1:${address.port}`;
      temporaryRoot = await realpath(tmpdir()); profileRoot = await mkdtemp(join(temporaryRoot, 'mohassan-controller-assessment-'));
    }
    const declaredPages = item.fixture.publicPages.map(page => pageFrom(page, origin));
    let current: AgentPage | null = null;
    const queries: string[] = [], opens: string[] = [];
    let memoryReads = 0, documentReads = 0, captures = 0, writes = 0, otherActions = 0, modelCalls = 0;
    let script: ControllerAssessmentTurn['modelScript'] = [];
    const defaultPartial = { tool: 'answer' as const, text: 'The synthetic controller fixture has no verified final answer for that request.', outcome: 'partial' as const };
    if (captureMode === 'real-loopback-chromium') {
      browser = new AgentBrowser({ profileDir: profileRoot!, testOrigins: [origin], allowedOrigins: [origin], channel: null, headless: true });
      const act = browser.act.bind(browser), capture = browser.captureEvidence.bind(browser);
      browser.act = async (...args) => { const action = args[2]; if (action.kind === 'open') { opens.push(action.text!); queries.push(...extractPublicSearchQueries(action.text!)); } else otherActions++; return act(...args); };
      browser.captureEvidence = async (...args) => { captures++; return capture(...args); };
    } else {
      const image = await readFile(join(ROOT, 'tests/fixtures/controller-assessment/synthetic-2px.jpg'));
      browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return current !== null; }, async prepareAction() { return null; },
        async observe() { if (!current) throw new Error('No declared current fixture page'); current = clonePage(current); return { page: current, changed: false }; },
        async act(_owner: string, _conversation: string, action: AgentAction) {
          if (action.kind !== 'open') { otherActions++; throw new Error('Undeclared fixture browser mutation'); }
          opens.push(action.text!); queries.push(...extractPublicSearchQueries(action.text!));
          const declared = declaredPages.find(page => page.url === action.text);
          if (!declared) throw new Error('Undeclared fixture URL'); current = clonePage(declared); return { page: current, changed: true };
        },
        async captureEvidence(ownerId: string, conversationId: string, requested: AgentPage): Promise<AgentCaptureResult> {
          captures++;
          if (!item.fixture.capture || !current || current.id !== requested.id) return { status: 'unavailable', reason: 'stale_page' };
          const stamp = new Date().toISOString(), finalPage = clonePage(current); current = finalPage;
          return { status: 'captured', page: finalPage, image: Buffer.from(image), receipt: {
            version: 1, scope: 'stable_observation_samples', ownerId, conversationId, requestedPageId: requested.id, pageId: finalPage.id, pageHash: finalPage.hash,
            url: finalPage.url, imageHash: hash(image), imageBytes: image.length, mimeType: 'image/jpeg', startedAt: stamp, captureStartedAt: stamp,
            captureFinishedAt: stamp, finishedAt: finalPage.observedAt, documentFingerprint: hash('synthetic-document'), viewportFingerprint: hash('synthetic-viewport'),
            beforeFingerprint: hash('synthetic-equal-samples'), afterFingerprint: hash('synthetic-equal-samples'),
          } };
        }, async screen() { throw new Error('Raw screen bytes are not fixture capture evidence'); }, async close() {},
      } as unknown as AgentBrowser;
    }
    const searchProvider: SearchProvider = { name: 'synthetic-controller-assessment-search', async search(query) {
      queries.push(query);
      const found = item.fixture.publicPages.find(page => page.queryTerms.every(term => query.toLowerCase().includes(term.toLowerCase())));
      if (!found) throw new Error('No declared synthetic public fact for query');
      const page = declaredPages[item.fixture.publicPages.indexOf(found)]!;
      return [{ title: page.title, url: page.url, snippet: page.text }];
    } };
    control = await createCommandChatControl(database.db, {
      browser, models: item.model === 'scripted' ? { fast: ['synthetic-scripted-model'], deep: ['synthetic-scripted-model'], vision: '' } : { fast: [], deep: [], vision: '' },
      searchProvider, recordExperiences: false,
      ...(captureMode === 'real-loopback-chromium' ? { networkPolicy: { testOrigins: [origin] } } : {}),
      ...(item.fixture.documents.length ? { knowledgeSearch: async () => { documentReads++; return item.fixture.documents; } } : {}),
      ...(item.fixture.memoryAvailable ? { tools: { memory: {
        async search() { memoryReads++; return { text: item.fixture.memories.join('\n'), evidence: item.fixture.memories }; },
        async save() { writes++; throw new Error('Assessment memory is read-only'); },
      } } } : {}),
      ...(item.model === 'scripted' ? { createProvider: (name: string) => ({ id: 'ollama', async generate(_request: ModelRequest) {
        modelCalls++; if (modelCalls > 16) throw new Error('Scripted assessment model call bound');
        const decision = script.shift() ?? defaultPartial;
        return { model: name, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK, ...decision }) };
      } }) } : {}),
    });
    setupMs = performance.now() - setupStarted;
    let id = '';
    for (const turn of item.turns) {
      const counts = { queries: queries.length, opens: opens.length, memoryReads, documentReads, captures, writes, otherActions, modelCalls };
      script = [...turn.modelScript];
      const priorDetail = id ? await control.detail(OWNER, id) : null;
      const priorMessageIds = new Set(priorDetail?.messages.map(message => message.id) ?? []);
      const started = performance.now(), text = turn.text.replaceAll('{{origin}}', origin);
      if (!id) id = (await control.create(OWNER, { goal: text })).id;
      else if (turn.fields) {
        const question = priorDetail?.question;
        if (!question?.fields?.length) throw new Error('Assessment field answer has no active question');
        const answers = question.fields.map(field => ({ fieldId: field.id, value: turn.fields![field.id] ?? '' }));
        await control.send(OWNER, id, { text, questionId: question.id, answers });
      } else await control.send(OWNER, id, { text });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([control.settled(id), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Assessment settle timeout')), 20_000); })]); }
      finally { if (timeout) clearTimeout(timeout); }
      const latencyMs = performance.now() - started;
      const detail = await control.detail(OWNER, id);
      const run = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
      const experiences = await database.db.selectFrom('experiences').select('source_id').where('owner_id', '=', OWNER).execute();
      const effects = await database.db.selectFrom('chat_effect_receipts').select('id').execute();
      turns.push({ status: run.status, conversationStatus: detail.status, answer: detail.messages.findLast(message => message.role === 'assistant' && !priorMessageIds.has(message.id))?.text ?? '',
        publicQueries: queries.slice(counts.queries), browserOpens: opens.slice(counts.opens), memoryReads: memoryReads - counts.memoryReads,
        documentReads: documentReads - counts.documentReads, captures: captures - counts.captures, writes: writes - counts.writes,
        otherBrowserActions: otherActions - counts.otherActions, modelCalls: modelCalls - counts.modelCalls,
        questionFields: detail.question?.fields?.map(field => field.id) ?? [], latencyMs, experienceRows: experiences.length, effectReceipts: effects.length });
    }
    return { turns, setupMs, captureMode };
  } catch (error) {
    return { turns, setupMs: setupMs || performance.now() - setupStarted, captureMode, error: error instanceof Error ? `harness_error:${error.name}` : 'harness_error' };
  } finally {
    await control?.shutdown(); await browser?.close(); await database.close();
    if (server) await new Promise<void>(done => server!.close(() => done()));
    if (profileRoot && temporaryRoot) {
      const target = await realpath(profileRoot), within = relative(temporaryRoot, target);
      if (isAbsolute(within) || !within.startsWith('mohassan-controller-assessment-') || within.includes('..')) throw new Error('CONTROLLER_ASSESSMENT_UNSAFE_TEMP_PATH');
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

async function sourceManifest(dataset: string) {
  const files = [...new Set([...sourcePaths.map(path => resolve(ROOT, path)), dataset])].sort();
  const entries = await Promise.all(files.map(async path => ({ path: relative(ROOT, path).replaceAll('\\', '/'), sha256: hash(await readFile(path)) })));
  return { scope: 'declared-runtime-modules-and-fixtures-not-full-transitive-build', sha256: hash(JSON.stringify(entries)), entries };
}

export async function runControllerAssessment(args: ControllerAssessmentArguments) {
  const before = await sourceManifest(args.dataset);
  const dataset = validateControllerAssessmentDataset(JSON.parse(await readFile(args.dataset, 'utf8')));
  const selected = args.caseId ? dataset.cases.filter(item => item.id === args.caseId) : dataset.cases;
  if (!selected.length) throw new Error('CONTROLLER_ASSESSMENT_UNKNOWN_CASE');
  const cases: ControllerCaseScore[] = [];
  for (const item of selected) cases.push(scoreControllerAssessmentCase(item, await observeControllerAssessmentCase(item, { realBrowser: args.realBrowser })));
  const after = await sourceManifest(args.dataset), sourceStable = before.sha256 === after.sha256;
  const report = { schemaVersion: 'mohassan-controller-assessment-report-v1', createdAt: new Date().toISOString(),
    dataset: { id: dataset.id, revision: dataset.revision, sha256: controllerDatasetHash(dataset), provenance: dataset.provenance },
    coverage: { selectedCases: selected.length, datasetCases: dataset.cases.length, selection: args.caseId ?? 'all', realBrowserRequested: args.realBrowser },
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    reproducibility: { validity: sourceStable ? 'stable-declared-source-manifest' : 'invalid-source-changed-during-run', before, after },
    limitations: [
      'Visible agent-authored development tasks and assertions; not sealed, human-reviewed, a training set, an IQ score, or general whole-brain proof.',
      'The real controller executes against synthetic facts and explicitly recorded fake service boundaries; scripted models are fixed in-process decisions, not external inference or graders.',
      'Answer correctness means these exact/NFC substring assertions only. A completed turn failing format, status or invariants is counted as false completion.',
      'Private-query checks cover supplied canaries and declared public-query bounds, not universal data-loss prevention.',
      'Default capture cases exercise a synthetic host receipt with a tiny fixture JPEG, not real webpage pixels. Only --real-browser uses isolated loopback Chromium, still sampled stability rather than atomic pixel/DOM truth.',
      'Latency is observed controlled-controller wall time; fixture setup is separate. It excludes real provider/network latency and is not a hardware-normalized performance benchmark.',
      'The declared source manifest is intentionally narrow, not a complete transitive build hash; a changed manifest invalidates reproducibility.',
    ], ...controllerAssessmentSummary(cases), cases };
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return { report, output: args.output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, output } = await runControllerAssessment(controllerAssessmentArguments(process.argv.slice(2)));
    console.log(`${report.metrics.passed}/${report.metrics.cases} development tasks passed; false completions ${report.metrics.falseCompletions}; private canary public queries ${report.metrics.privateCanaryPublicQueries}; unexpected effects ${report.metrics.unexpectedEffects}.`);
    console.log(`p50 ${report.latency.p50.toFixed(1)} ms, p95 ${report.latency.p95.toFixed(1)} ms; source ${report.reproducibility.validity}.`);
    console.log(`Capture: ${report.captureCoverage.syntheticBoundaryCases} synthetic boundary, ${report.captureCoverage.realLoopbackChromiumCases} real loopback Chromium cases.`);
    console.log(`Immutable report: ${output}`);
    if (report.reproducibility.validity === 'invalid-source-changed-during-run') process.exitCode = 3;
    else if (report.metrics.passed !== report.metrics.cases) process.exitCode = 2;
  } catch (error) { console.error(error instanceof Error ? error.message : 'CONTROLLER_ASSESSMENT_FAILED'); process.exitCode = 1; }
}
