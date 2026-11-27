import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainCheckRun, inspectProject, snapshotHash } from '@mohassan/coding';
import type { Project } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';
import { fixtures, registerFixtures } from '../scripts/mohassan-code/fixtures.js';
import { SUITE_CASES } from '../scripts/mohassan-code/suite-cases.js';
import { scoreSuiteCase, suiteTotals } from '../scripts/mohassan-code/suite-results.js';
import { createSuiteSandbox } from '../scripts/mohassan-code/suite-sandbox.js';

describe('the no-model coding evaluation', () => {
  it('registers five clean, supported Git projects through the owner coding API', async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'mohassan-code-eval-test-'));
    const origin = 'http://127.0.0.1:3000';
    const internalSecret = 'code-eval-test-internal-fixture-0001';
    const setupToken = 'code-eval-test-setup-fixture-00000001';
    const headers = { 'x-mohassan-internal': internalSecret, origin };
    const account = { email: 'code-eval@example.test', password: 'Code-Eval-Test-Fixture-42' };
    let app: Awaited<ReturnType<typeof createApplication>>['app'] | undefined;

    try {
      const application = await createApplication({
        authSecret: 'code-eval-test-auth-fixture-00000001', internalSecret, setupToken, webOrigin: origin,
        production: false, runWorker: false, codingDataDir: directory, codingAllowedRoots: [directory], browserChannel: null,
        sandboxRunner: {
          available: async () => ({ available: true, provider: 'unit-fixture', message: 'registration test only' }),
          run: async () => { throw new Error('Registration must not execute fixture code.'); },
        },
      });
      app = application.app;
      const setup = await app.inject({ method: 'POST', url: '/api/setup', headers,
        payload: { ...account, name: 'Evaluation owner', setupToken } });
      expect(setup.statusCode).toBe(200);
      const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: account });
      expect(login.statusCode).toBe(200);
      const cookies = login.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookie = (Array.isArray(cookies) ? cookies : [String(cookies)]).map(value => value.split(';')[0]).join('; ');
      const ownerHeaders = { ...headers, cookie };

      await registerFixtures(directory, project => application.app.inject({
        method: 'POST', url: '/api/coding/projects', headers: ownerHeaders, payload: project,
      }));
      const response = await app.inject({ method: 'GET', url: '/api/coding/projects', headers: ownerHeaders });
      expect(response.statusCode).toBe(200);
      const { projects } = response.json<{ projects: Project[] }>();
      expect(projects).toHaveLength(5);
      expect(new Set(projects.map(project => project.id)).size).toBe(5);
      expect(new Set(projects.map(project => project.baseCommit)).size).toBe(5);
      for (const fixture of fixtures) {
        const project = projects.find(item => item.name === fixture.name);
        expect(project, fixture.id).toBeDefined();
        expect(relative(directory, project!.path)).toBe(join('fixtures', fixture.id));
        expect(project).toMatchObject({ testProfile: 'node-test', allowedPaths: fixture.allowedPaths });

        const inspected = await inspectProject(project!.path, [directory]);
        expect(inspected.baseCommit).toBe(project!.baseCommit);
        expect(inspected.testFiles).toHaveLength(1);
        expect(Object.fromEntries(inspected.files.map(file => [file.path, file.content]))).toEqual(fixture.files);
        expect(inspected.candidateEditablePaths).toEqual(expect.arrayContaining([...fixture.allowedPaths]));
        for (const test of inspected.testFiles) expect(inspected.candidateEditablePaths).not.toContain(test);
        if (fixture.id === 'eslint') {
          expect(inspected.eslintConfig).toBeDefined();
          expect(inspected.candidateEditablePaths).not.toContain(inspected.eslintConfig);
        }
        if (fixture.id === 'tsx') {
          expect(inspected.typecheck).toEqual({ project: 'tsconfig.json' });
          expect(inspected.candidateEditablePaths).toContain('src/label.tsx');
          expect(inspected.candidateEditablePaths).not.toContain('tsconfig.json');
        }
      }
    } finally {
      try { await app?.close(); }
      finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    }
  });

  it('defines both languages for each fixture and measures six separate controls', () => {
    const targets = SUITE_CASES.filter(item => !item.control);
    const controls = SUITE_CASES.filter(item => item.control);
    expect(new Set(SUITE_CASES.map(item => item.id)).size).toBe(SUITE_CASES.length);
    expect(new Set(SUITE_CASES.map(item => item.goal)).size).toBe(SUITE_CASES.length);
    expect(targets).toHaveLength(40);
    expect(controls.map(item => item.id)).toEqual(['K1', 'K2', 'K3', 'K4', 'K5', 'K6']);
    expect(controls.every(item => item.capability === 'control' && !item.approval)).toBe(true);
    expect(controls.filter(item => item.actor === 'member').map(item => item.id)).toEqual(['K5']);
    for (const item of SUITE_CASES) {
      expect(item.expect.length, item.id).toBeGreaterThan(0);
      expect(item.expect.every(fragment => fragment.trim().length > 0), item.id).toBe(true);
    }

    for (const fixture of fixtures) {
      for (const language of ['ar', 'en'] as const) {
        const matching = targets.filter(item => item.project === fixture.name && item.language === language);
        expect(matching.map(item => item.capability).sort()).toEqual(['check', 'fix', 'imports', 'search']);
        for (const item of matching) {
          expect(item.goal).toContain(fixture.name);
          expect(item.approval === true).toBe(item.capability === 'fix');
          expect(Boolean(item.expectApproval?.length)).toBe(item.capability === 'fix');
        }
      }
    }
  });

  it('scores approval and review separately and requires the honest result for both logic requests', () => {
    const fix = SUITE_CASES.find(item => item.id === 'I-F-AR')!;
    const observed = {
      first: 'waiting_approval',
      approvalPrompt: 'Approval required',
      approvalDetail: fix.expectApproval?.join('\n'),
      final: 'idle',
      finalText: `${'x'.repeat(1250)}\n${fix.expect.join('\n')}`,
      codingEffect: true,
      readyForReview: true,
    };
    expect(scoreSuiteCase(fix, observed)).toEqual({ met: true, misses: [] });
    expect(scoreSuiteCase(fix, { ...observed, first: 'idle', approvalPrompt: undefined }).misses)
      .toContain('Missing approval card');
    expect(scoreSuiteCase(fix, { ...observed, approvalDetail: '' }).met).toBe(false);
    expect(scoreSuiteCase(fix, { ...observed, final: 'timeout' }).misses).toContain('No settled result after approval');
    expect(scoreSuiteCase(fix, { ...observed, codingEffect: false }).met).toBe(false);
    expect(scoreSuiteCase(fix, { ...observed, readyForReview: false }).misses).toContain('Missing verified review checkpoint');

    const refusals = SUITE_CASES.filter(item => item.project === 'Logic Bench' && item.capability === 'fix');
    expect(refusals).toHaveLength(2);
    for (const item of refusals) {
      expect(item.needsModel).toBe(true);
      expect(item.reject?.length).toBeGreaterThan(0);
      const refusal = { ...observed, approvalDetail: item.expectApproval?.join('\n'),
        finalText: item.expect.join('\n'), readyForReview: false };
      expect(scoreSuiteCase(item, refusal)).toEqual({ met: true, misses: [] });
      expect(scoreSuiteCase(item, { ...refusal, readyForReview: true }).misses).toContain('Unexpected review checkpoint');
      const falseClaim = `${refusal.finalText}\n${item.reject![0]}`;
      expect(scoreSuiteCase(item, { ...refusal, finalText: falseClaim }).met).toBe(false);
      expect(scoreSuiteCase(item, { ...refusal, finalText: null }).met).toBe(false);
    }
  });

  it('requires that controls stay out of coding and counts results by capability', () => {
    const control = SUITE_CASES.find(item => item.id === 'K5')!;
    const response = { first: 'idle', finalText: control.expect.join('\n'), codingEffect: false, readyForReview: false };
    expect(scoreSuiteCase(control, response).met).toBe(true);
    expect(scoreSuiteCase(control, { ...response, codingEffect: true }).misses).toContain('Unexpected coding activity');
    expect(scoreSuiteCase(control, { ...response, first: 'waiting_approval' }).misses).toContain('Unexpected approval card');
    const results = SUITE_CASES.map(item => ({ capability: item.capability, met: item.id !== 'K5' && item.id !== 'I-F-AR' }));
    expect(suiteTotals(results)).toEqual({
      all: { met: 44, total: 46 }, check: { met: 10, total: 10 }, search: { met: 10, total: 10 },
      imports: { met: 10, total: 10 }, fix: { met: 9, total: 10 }, control: { met: 5, total: 6 },
    });
  });

  it('replays the real assertion and TypeScript diagnostics only for the recorded snapshots and scopes', async () => {
    const sandbox = createSuiteSandbox(snapshotHash);
    const logic = fixtures.find(fixture => fixture.id === 'logic')!;
    const logicFiles = Object.entries(logic.files).map(([path, content]) => ({ path, content }));
    const request = {
      files: logicFiles,
      testFiles: ['test/discount.test.mjs'],
      syntaxFiles: ['src/discount.mjs', 'test/discount.test.mjs'],
      jsonFiles: [],
    };
    const result = await sandbox.run(request);
    expect(result).toMatchObject({ exitCode: 1, provider: 'suite-recording', snapshotHash: snapshotHash(logicFiles) });
    const report = explainCheckRun(result, Object.keys(logic.files));
    expect(report.failures).toMatchObject([{ test: 'subtracts the discount', expected: '8', actual: '12' }]);
    await expect(sandbox.run({ ...request, testFiles: [] })).rejects.toThrow('No recorded suite check');
    const changed = logicFiles.map(file => file.path === 'src/discount.mjs'
      ? { ...file, content: file.content.replace('price + discount', 'price - discount') } : file);
    await expect(sandbox.run({ ...request, files: changed })).rejects.toThrow('No recorded suite check');

    const tsx = fixtures.find(fixture => fixture.id === 'tsx')!;
    const compilerResult = await sandbox.run({
      files: Object.entries(tsx.files).map(([path, content]) => ({ path, content })),
      testFiles: ['test/label.test.mjs'],
      syntaxFiles: ['src/label.tsx', 'src/value.mjs', 'test/label.test.mjs'],
      typecheck: { project: 'tsconfig.json' },
    });
    expect(explainCheckRun(compilerResult, Object.keys(tsx.files)).typecheck)
      .toMatchObject([{ path: 'src/label.tsx', line: 1, code: 'TS2322' }]);
  });

  it('replays the scoped ESLint edit and the subsequent passing check', async () => {
    const sandbox = createSuiteSandbox(snapshotHash);
    const lint = fixtures.find(fixture => fixture.id === 'eslint')!;
    const files = Object.entries(lint.files).map(([path, content]) => ({ path, content }));
    const lintRequest = { files, configPath: 'eslint.config.mjs', fixFiles: ['src/lint.mjs'], formatting: false };
    const result = await sandbox.lintFix!(lintRequest);
    expect(result).toMatchObject({ exitCode: 0, snapshotHash: snapshotHash(files) });
    expect(result.fixes).toMatchObject([{ path: 'src/lint.mjs', content: expect.stringContaining('if (true)') }]);
    await expect(sandbox.lintFix!({ ...lintRequest, fixFiles: ['test/lint.test.mjs'] }))
      .rejects.toThrow('No recorded suite ESLint fix');
    const repaired = files.map(file => result.fixes.find(fix => fix.path === file.path) ?? file);
    await expect(sandbox.run({ files: repaired, testFiles: ['test/lint.test.mjs'],
      syntaxFiles: ['eslint.config.mjs', 'src/lint.mjs', 'test/lint.test.mjs'], jsonFiles: [] }))
      .resolves.toMatchObject({ exitCode: 0, snapshotHash: snapshotHash(repaired) });
  });
});
