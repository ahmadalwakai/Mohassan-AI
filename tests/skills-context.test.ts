import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { createMockGroq } from './fixtures/planning.js';
import { SkillSandboxDiagnosticSchema } from '@mohassan/contracts';
import { fixtureLocalModel } from './fixtures/local-model.js';

it.each([true, false])('loads only activated guidance through actual API, Runtime and Chat wiring (enabled=%s)', async enabled => {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-skill-context-'));
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  const mock = createMockGroq(), marker = 'M4_EVIDENCE_MARKER', goal = 'Review workspace-evidence and produce a careful plan.';
  const secret = 'skill-context-fixture-internal-secret-0001', origin = 'http://127.0.0.1:3000';
  let cookie = '';
  const headers = () => ({ 'x-mohassan-internal': secret, origin, ...(cookie ? { cookie } : {}) });
  try {
    const folder = join(directory, 'skill');
    await mkdir(folder);
    await writeFile(join(folder, 'SKILL.md'), `---\nname: workspace-evidence\ndescription: Workspace evidence review with source provenance.\n---\n\n${marker}: Cite the evidence used for every conclusion.\n`);
    application = await createApplication({
      authSecret: 'skill-context-fixture-auth-secret-00001', internalSecret: secret, setupToken: 'skill-context-fixture-setup-token-0001',
      webOrigin: origin, production: false, runWorker: false, skillEngineEnabled: enabled,
      codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), ...fixtureLocalModel(mock.fetch),
    });
    const app = application.app, account = { email: 'skill-context@example.test', password: 'Skill-context-fixture-password-42' };
    expect((await app.inject({url: '/api/skills/sandbox', headers: headers()})).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...account, name: 'Context fixture', setupToken: 'skill-context-fixture-setup-token-0001' } })).statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: account });
    expect(login.statusCode).toBe(200);
    cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const sandboxResponse = await app.inject({url: '/api/skills/sandbox', headers: headers()});
    expect(sandboxResponse.statusCode).toBe(200);
    const diagnostic = SkillSandboxDiagnosticSchema.parse(sandboxResponse.json());
    expect(diagnostic.executionAllowed).toBe(false);
    expect(diagnostic.readiness.enabled).toBe(false);
    expect(diagnostic.readiness.gates.find(gate => gate.id === 'G2')).toMatchObject({required: true, status: 'blocked'});
    const imported = await app.inject({ method: 'POST', url: '/api/skills/import', headers: headers(), payload: { path: folder } });
    expect(imported.statusCode).toBe(200);
    let skill = imported.json().skill;
    async function plan() {
      const created = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: { title: 'Skill context fixture', goal, capabilityId: 'plan.draft', autonomy: 'scoped' } });
      expect(created.statusCode).toBe(200);
      await application!.runtime.tick();
      const detail = await app.inject({ url: `/api/tasks/${created.json().id}`, headers: headers() });
      expect(detail.json().task).toMatchObject({ status: 'completed', result: { executionAllowed: false } });
      const sent = mock.requests.filter(request => request.body.response_format?.json_schema?.name === 'mohassan_cognitive_plan').at(-1)!;
      return JSON.parse(sent.body.messages.at(-1).content);
    }
    expect(await plan()).not.toHaveProperty('skills');
    const inspection = await app.inject({ method: 'POST', url: `/api/skills/${skill.id}/inspect`, headers: headers(), payload: { expectedRevision: skill.revision } });
    expect(inspection.statusCode).toBe(200); skill = inspection.json().skill;
    const activation = await app.inject({ method: 'POST', url: `/api/skills/${skill.id}/activate`, headers: headers(), payload: { expectedRevision: skill.revision, approve: true } });
    expect(activation.statusCode).toBe(200); skill = activation.json().skill;
    const guided = await plan();
    if (enabled) {
      expect(guided.skills).toMatchObject({ trust: 'untrusted_skill_guidance', permissionsGranted: false });
      expect(guided.skills.text).toContain(marker);
      expect(guided.skills.text).toContain(skill.contentHash);
    } else expect(guided).not.toHaveProperty('skills');
    const conversation = await app.inject({ method: 'POST', url: '/api/chat/conversations', headers: headers(), payload: { goal } });
    expect(conversation.statusCode).toBe(200);
    await application.chat.settled(conversation.json().id);
    const decisions = mock.requests.filter(request => request.body.response_format?.json_schema?.name === 'decision');
    expect(decisions.length).toBeGreaterThan(0);
    const chatPrompt = decisions.at(-1)!.body.messages.at(-1).content as string;
    expect(chatPrompt.includes(marker)).toBe(enabled);
    const revoked = await app.inject({ method: 'POST', url: `/api/skills/${skill.id}/revoke`, headers: headers(), payload: { expectedRevision: skill.revision, reason: 'Fixture revocation.' } });
    expect(revoked.statusCode).toBe(200);
    expect(await plan()).not.toHaveProperty('skills');
    expect(await application.database.db.selectFrom('skill_grants').select('id').execute()).toHaveLength(0);
  } finally {
    await application?.app.close();
    const target = await realpath(directory), base = await realpath(tmpdir()), inside = relative(base, target);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-skill-context-')) throw new Error('Unsafe context fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 60_000);
