import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { SkillContractSchema } from '@mohassan/contracts';
import { sha256 } from '@mohassan/skills';

it.each([false, true])('imports and approves a real local browser-to-file workflow through API and shared Runtime (composite=%s)', async composite => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mohassan-skill-execution-')));
  const server = createServer((_request, response) => { response.writeHead(200, {'content-type': 'text/html; charset=utf-8'}); response.end('<html><title>Controlled evidence</title><main>Verified local fixture report 42</main></html>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address');
  const localOrigin = `http://127.0.0.1:${address.port}`;
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  const secret = 'skill-execution-fixture-internal-secret-01', origin = 'http://127.0.0.1:3000';
  let cookie = '';
  const headers = () => ({'x-mohassan-internal': secret, origin, ...(cookie ? {cookie} : {})});
  try {
    const folder = join(directory, 'skill'), outputRoot = join(directory, 'output'); await mkdir(folder); await mkdir(outputRoot);
    const original = composite ? 'Prior approved report content' : null;
    if (original !== null) await writeFile(join(outputRoot, 'report.txt'), original);
    const field = (name: string, type: string) => ({name, type, description: `Fixture ${name}`});
    const contract = SkillContractSchema.parse({slug: 'local-evidence-report', name: 'Local evidence report', description: 'Read a controlled page and write the observed text into an approved report.', version: '1.0.0', category: 'research', level: 'tool',
      inputs: [field('url', 'url'), field('root', 'file'), field('path', 'file'), field('expectedHash', 'json')], outputs: [field('hash', 'string')],
      requires: {tools: ['browser.open', 'file.write'], paths: ['report.txt']}, sideEffects: 'write_local', rollback: {mode: 'restore_preimage'}, idempotent: true,
      verification: 'Persisted browser observation and an independently reread file hash must match.',
      steps: [
        {id: 'open', kind: 'tool', title: 'Read local fixture', tool: 'browser.open', inputs: {url: 'input.url'}, outputs: [field('text', 'string')]},
        {id: 'write', kind: 'tool', title: 'Write observed report', tool: 'file.write', dependsOn: ['open'], inputs: {root: 'input.root', path: 'input.path', expectedHash: 'input.expectedHash', content: 'open.text'}, outputs: [field('hash', 'string')]},
      ],
    });
    application = await createApplication({authSecret: 'skill-execution-fixture-auth-secret-00001', internalSecret: secret, setupToken: 'skill-execution-fixture-setup-token', webOrigin: origin,
      production: false, runWorker: false, skillEngineEnabled: true, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), browser: {testOrigins: [localOrigin]}});
    const app = application.app, account = {email: 'skill-execution@example.test', password: 'Skill-execution-fixture-password-42'};
    expect((await app.inject({method: 'POST', url: '/api/setup', headers: headers(), payload: {...account, name: 'Execution fixture', setupToken: 'skill-execution-fixture-setup-token'}})).statusCode).toBe(200);
    const login = await app.inject({method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: account});
    expect(login.statusCode).toBe(200); cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const post = async (url: string, payload: unknown, extra = {}) => {
      const response = await app.inject({method: 'POST', url, headers: {...headers(), ...extra}, payload: payload as any});
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200); return response.json();
    };
    async function importSkill(raw: unknown) {
      const definition = SkillContractSchema.parse(raw), path = join(folder, definition.slug); await mkdir(path);
      await writeFile(join(path, 'SKILL.md'), `---\nname: ${definition.slug}\ndescription: Read a controlled local page and record its observed evidence.\n---\nUse only the explicit inputs and report verified observations.\n`);
      await writeFile(join(path, 'skill.contract.json'), JSON.stringify(definition));
      let version = (await post('/api/skills/import', {path})).skill;
      version = (await post(`/api/skills/${version.id}/inspect`, {expectedRevision: version.revision})).skill;
      version = (await post(`/api/skills/${version.id}/activate`, {expectedRevision: version.revision, approve: true, acknowledgeFindings: true})).skill;
      const permission = await post(`/api/skills/${version.id}/grants`, {expectedRevision: version.revision, approve: true, tools: definition.requires.tools,
        roots: definition.requires.tools.includes('file.write') ? [outputRoot] : [], durationHours: 1});
      return {skill: version, grant: permission};
    }
    const source = composite ? await importSkill({...contract, slug: 'local-page-source', inputs: contract.inputs.filter(field => field.name === 'url'), outputs: contract.steps[0].outputs,
      steps: [contract.steps[0]], requires: {tools: ['browser.open']}, sideEffects: 'read', rollback: {mode: 'none'}}) : null;
    const {skill, grant} = await importSkill(composite ? {...contract, inputs: [...contract.inputs.filter(field => field.name !== 'url'), field('content', 'string')],
      steps: [{...contract.steps[1], dependsOn: [], inputs: {...contract.steps[1].inputs, content: 'input.content'}}], requires: {tools: ['file.write'], paths: ['report.txt']}, dependsOn: ['local-page-source']} : contract);
    const nodes = source ? [{id: 'source', skillId: source.skill.id, inputs: {url: 'input.url'}}, {id: 'report', skillId: skill.id, dependsOn: ['source'], inputs: {root: 'input.root', path: 'input.path', expectedHash: 'input.expectedHash', content: 'source.text'}}]
      : [{id: 'report', skillId: skill.id, inputs: Object.fromEntries(contract.inputs.map(field => [field.name, `input.${field.name}`]))}];
    const input = {plan: {nodes, inputs: contract.inputs}, values: {url: `${localOrigin}/fixture`, root: outputRoot, path: 'report.txt', expectedHash: original === null ? null : sha256(original)}};
    expect(await post('/api/skills/compose/validate', input.plan)).toMatchObject({valid: true});
    const key = randomUUID();
    const payload = {title: 'Create controlled evidence report', goal: 'Open the approved fixture and write its observed text.', capabilityId: 'skill.run', autonomy: 'assisted', skillInput: input};
    const request = {expectedRevision: skill.revision, goal: payload.goal, ...input};
    const started = await post(`/api/skills/${skill.id}/run`, request, {'idempotency-key': key});
    const parent = started.task;
    expect(started.runId).toBeNull();
    expect(parent.status).toBe('waiting_approval');
    expect((await post(`/api/skills/${skill.id}/run`, request, {'idempotency-key': key})).task.id).toBe(parent.id);
    await post(`/api/tasks/${parent.id}/approve`, {});
    const owner = (await application.database.db.selectFrom('user').select('id').executeTakeFirstOrThrow()).id;
    const approved: string[] = [];
    for (let iteration = 0; iteration < 12; iteration++) {
      await application.runtime.tick();
      const tasks = await application.database.db.selectFrom('tasks').selectAll().where('owner_id', '=', owner).execute();
      const current = tasks.find(task => task.id === parent.id)!;
      if (current.status === 'completed') break;
      expect(current.status, JSON.stringify(tasks.map(task => ({id: task.id, status: task.status, error: task.error})))).not.toBe('failed');
      for (const task of tasks.filter(task => task.id !== parent.id && task.status === 'waiting_approval')) {
        approved.push(task.id); await post(`/api/tasks/${task.id}/approve`, {});
      }
    }
    const final = await app.inject({url: `/api/tasks/${parent.id}`, headers: headers()});
    expect(final.json().task, final.body).toMatchObject({status: 'completed'});
    expect(approved).toHaveLength(2);
    const text = await readFile(join(outputRoot, 'report.txt'), 'utf8'); expect(text).toContain('Verified local fixture report 42');
    expect(final.json().task.result.outputs.report.hash).toBe(sha256(text));
    const receipts = await application.database.db.selectFrom('skill_evidence').selectAll().execute();
    expect(receipts).toHaveLength(2); expect(receipts.every(receipt => receipt.status === 'succeeded')).toBe(true);
    const runId = final.json().task.result.runId;
    const summary = await app.inject({url: `/api/skills/runs/${runId}`, headers: headers()});
    expect(summary.statusCode).toBe(200); expect(summary.json()).toMatchObject({id: runId, status: 'succeeded'});
    expect(summary.json().nodes).toHaveLength(2); expect(summary.body).not.toContain('lease_token');
    const evidence = await app.inject({url: `/api/skills/runs/${runId}/evidence?limit=1`, headers: headers()});
    expect(evidence.statusCode).toBe(200); expect(evidence.json()).toMatchObject({runId, total: 2}); expect(evidence.json().items).toHaveLength(1);
    const graph = await app.inject({url: '/api/skills/graph', headers: headers()});
    expect(graph.statusCode, graph.body).toBe(200);
    const outcomes = graph.json().nodes.filter((node: any) => node.kind === 'outcome' && node.runId === runId);
    expect(outcomes.map((node: any) => node.receiptId).sort()).toEqual(receipts.map(receipt => receipt.id).sort());
    expect(outcomes.every((node: any) => node.scope === 'step')).toBe(true);
    expect(graph.json().permissionsGranted).toBe(false);
    expect(graph.body).not.toContain('Verified local fixture report 42');
    expect(await application.database.db.selectFrom('skill_resource_locks').selectAll().execute()).toHaveLength(0);
    expect(await application.database.db.selectFrom('skill_preimages').select(['before_text', 'after_hash']).execute()).toEqual([{before_text: original, after_hash: sha256(text)}]);
    await application.runtime.tick();
    expect(await application.database.db.selectFrom('skill_evidence').selectAll().execute()).toHaveLength(2);
    const preview = await app.inject({url: `/api/skills/runs/${runId}/rollback`, headers: headers()});
    expect(preview.statusCode).toBe(200); expect(preview.json().items[0]).toMatchObject({eligible: true, path: 'report.txt'});
    const undo = await post(`/api/skills/runs/${runId}/rollback`, {preimageId: preview.json().items[0].preimageId, expectedAfterHash: sha256(text)}, {'idempotency-key': randomUUID()});
    expect(undo.task.status).toBe('waiting_approval'); expect(undo.review).toMatchObject({root: outputRoot, path: 'report.txt', deletedOnRestore: original === null});
    expect(await readFile(join(outputRoot, 'report.txt'), 'utf8')).toBe(text);
    await post(`/api/tasks/${undo.task.id}/approve`, {}); await application.runtime.tick();
    const undone = await app.inject({url: `/api/tasks/${undo.task.id}`, headers: headers()});
    expect(undone.json().task, undone.body).toMatchObject({status: 'completed', result: {kind: 'skill_rollback', outcome: 'restored'}});
    if (original === null) await expect(readFile(join(outputRoot, 'report.txt'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    else expect(await readFile(join(outputRoot, 'report.txt'), 'utf8')).toBe(original);
    await post(`/api/skills/${skill.id}/grants/${grant.id}/revoke`, {reason: 'End controlled fixture grant.'});
    expect((await post('/api/skills/compose/validate', input.plan)).valid).toBe(false);
    const forbidden = await app.inject({method: 'POST', url: '/api/tasks', headers: {...headers(), 'idempotency-key': randomUUID()}, payload: {...payload, capabilityId: 'skill.node'}});
    expect(forbidden.statusCode).toBe(400);
  } finally {
    await application?.app.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const target = await realpath(directory), base = await realpath(tmpdir()), inside = relative(base, target);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-skill-execution-')) throw new Error('Unsafe skill execution fixture cleanup');
    await rm(target, {recursive: true, force: true});
  }
}, 60_000);
