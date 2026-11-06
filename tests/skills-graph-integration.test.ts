import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillContractSchema, type SkillContract } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.ts';
import { SkillGraphRelatedSchema, SkillGraphSnapshotSchema } from '../packages/contracts/src/skill-graph.ts';
import { rebuildSkillGraph } from '../packages/skills/src/graph.ts';

describe('authenticated skill graph over actual local lifecycle and receipts', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined, directory = '', base = '', cookie = '', otherCookie = '', ownerId = '', otherId = '';
  const origin = 'http://127.0.0.1:3000', secret = 'graph-api-fixture-internal-secret-00001', setupToken = 'graph-api-fixture-setup-token-00000001';
  const headers = (session = cookie) => ({ origin, 'x-mohassan-internal': secret, ...(session ? { cookie: session } : {}) });
  async function install(contract: SkillContract, text: string, owner = ownerId) {
    const folder = join(directory, randomUUID()); await mkdir(folder);
    await writeFile(join(folder, 'SKILL.md'), `---\nname: ${contract.slug}\ndescription: ${contract.description}\nversion: ${contract.version}\n---\n${text}\n`);
    await writeFile(join(folder, 'skill.contract.json'), JSON.stringify(contract));
    let version = (await application!.skills.importLocal(owner, { path: folder })).skill;
    version = (await application!.skills.inspect(owner, version.id, { expectedRevision: version.revision })).skill;
    return (await application!.skills.activate(owner, version.id, { expectedRevision: version.revision, approve: true, acknowledgeFindings: true })).skill;
  }
  const instruction = (slug: string, dependsOn: string[] = [], version = '1.0.0') => SkillContractSchema.parse({ slug, name: slug.replace(/-/g, ' '), description: `Careful guidance for ${slug.replace(/-/g, ' ')} with attributable sources.`, category: 'documents', level: 'instruction', version, dependsOn });
  type Version = Awaited<ReturnType<typeof install>>;
  let chain: { plain: Version; alpha: Version; beta: Version; gamma: Version; foreign: Version } | undefined;
  async function graph(session = cookie) { const response = await application!.app.inject({ url: '/api/skills/graph', headers: headers(session) }); expect(response.statusCode, response.body).toBe(200); return SkillGraphSnapshotSchema.parse(response.json()); }
  async function related(id: string, depth = 2, limit = 12, session = cookie) { const response = await application!.app.inject({ url: `/api/skills/${id}/related?depth=${depth}&limit=${limit}`, headers: headers(session) }); expect(response.statusCode, response.body).toBe(200); return SkillGraphRelatedSchema.parse(response.json()); }
  async function installedChain() {
    if (chain) return chain;
    const plain = await install(instruction('ordinary-graph-guide'), 'M10_PLAIN_MARKER: use the current verified sources.'), gamma = await install(instruction('quartz-check'), 'M10_GAMMA_MARKER: preserve source identifiers.'), beta = await install(instruction('nebula-guide', ['quartz-check']), 'M10_BETA_MARKER: explain the observed evidence.');
    const alpha = await install(instruction('nebulaanchor', ['nebula-guide']), 'M10_ALPHA_MARKER: review the evidence carefully.');
    const foreign = await install(instruction('nebula-guide'), 'M10_FOREIGN_MARKER: another owner only.', otherId);
    chain = { plain, alpha, beta, gamma, foreign }; return chain;
  }
  beforeAll(async () => {
    base = await realpath(tmpdir()); directory = await realpath(await mkdtemp(join(base, 'mohassan-graph-api-')));
    application = await createApplication({ authSecret: 'graph-api-fixture-auth-secret-00000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, skillEngineEnabled: true, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'browser') });
    const account = { name: 'Graph owner fixture', email: 'graph-owner@example.test', password: 'Graph-Owner-Fixture-Password-42' }, other = { name: 'Other graph fixture', email: 'graph-other@example.test', password: 'Graph-Other-Fixture-Password-42' };
    const setup = await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(''), payload: { ...account, setupToken } }); expect(setup.statusCode, setup.body).toBe(200);
    await application.auth.api.signUpEmail({ body: other });
    async function login(credentials: typeof account) {
      const response = await application!.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(''), payload: { email: credentials.email, password: credentials.password } }); expect(response.statusCode, response.body).toBe(200);
      return [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    }
    cookie = await login(account); otherCookie = await login(other);
    ownerId = (await application.database.db.selectFrom('user').select('id').where('email', '=', account.email).executeTakeFirstOrThrow()).id;
    otherId = (await application.database.db.selectFrom('user').select('id').where('email', '=', other.email).executeTakeFirstOrThrow()).id;
  }, 60000);
  afterAll(async () => {
    await application?.app.close();
    if (directory) { const target = await realpath(directory), inside = relative(base, target); if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-graph-api-')) throw new Error('Unsafe graph fixture cleanup'); await rm(target, { recursive: true, force: true }); }
  });

  it('authenticates and returns an empty graph without seeding skills, rebuilding or granting anything', async () => {
    const f = application!, app = f.app, db = f.database.db;
    expect((await app.inject({ url: '/api/skills/graph' })).statusCode).toBe(401); expect((await app.inject({ url: '/api/skills/graph', headers: headers('') })).statusCode).toBe(401);
    const versions = await db.selectFrom('skill_versions').selectAll().execute(), audit = await db.selectFrom('skill_audit').selectAll().execute(); expect(versions).toEqual([]);
    const response = await app.inject({ url: '/api/skills/graph', headers: headers() }); expect(response.statusCode, response.body).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toMatchObject({ nodes: [], edges: [], truncated: false, permissionsGranted: false });
    expect(await db.selectFrom('skill_versions').selectAll().execute()).toEqual(versions); expect(await db.selectFrom('skill_audit').selectAll().execute()).toEqual(audit); expect(await db.selectFrom('skill_grants').select('id').execute()).toEqual([]);
    expect((await app.inject({ url: `/api/skills/graph?ownerId=${otherId}`, headers: headers() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/skills/graph', headers: headers(), payload: { rebuild: true, approve: true } })).statusCode).toBe(404);
  });

  it('rebuilds from real lifecycle changes and labels declared edges without inventing execution proof', async () => {
    const f = application!, c = await installedChain(), snapshot = await graph();
    expect(snapshot.permissionsGranted).toBe(false); expect(snapshot.nodes.find(node => node.key === `skill:${c.plain.id}`)).toMatchObject({ kind: 'skill', skillVersionId: c.plain.id, active: true, verification: 'current_metadata' });
    expect(snapshot.edges.filter(edge => edge.from === `skill:${c.plain.id}` || edge.to === `skill:${c.plain.id}`)).toEqual([]);
    expect(snapshot.edges).toContainEqual(expect.objectContaining({ from: `skill:${c.alpha.id}`, to: `skill:${c.beta.id}`, relation: 'depends_on', provenance: 'declared_contract', sourceContentHash: c.alpha.contentHash, targetContentHash: c.beta.contentHash }));
    expect(snapshot.nodes.filter(node => node.kind === 'outcome')).toEqual([]); expect(snapshot.edges.some(edge => edge.relation === 'verified_outcome')).toBe(false);
    expect(await f.database.db.selectFrom('skill_grants').select('id').execute()).toEqual([]); expect(await f.database.db.selectFrom('tasks').select('id').execute()).toEqual([]);
    const context = await f.skills.context(ownerId, 'nebulaanchor', { budgetChars: 8000 }); expect(context.text).toContain('M10_ALPHA_MARKER'); expect(context.text).toContain('M10_BETA_MARKER'); expect(context.text).not.toContain('M10_FOREIGN_MARKER');
  });

  it('keeps identical slugs in separate owners and bounds related traversal by depth and count', async () => {
    const f = application!, c = await installedChain(), snapshot = await graph(), foreign = await graph(otherCookie);
    expect(snapshot.nodes.some(node => node.key === `skill:${c.foreign.id}`)).toBe(false); expect(foreign.nodes.some(node => node.key === `skill:${c.alpha.id}`)).toBe(false);
    expect((await related(c.alpha.id, 0)).skillIds).toEqual([]); expect((await related(c.alpha.id, 1)).skillIds).toContain(c.beta.id); expect((await related(c.alpha.id, 1)).skillIds).not.toContain(c.gamma.id);
    const expanded = await related(c.alpha.id, 2); expect(expanded.skillIds).toEqual(expect.arrayContaining([c.beta.id, c.gamma.id])); expect(expanded.skillIds).not.toContain(c.foreign.id); expect(expanded.permissionsGranted).toBe(false);
    const bounded = await related(c.alpha.id, 2, 1); expect(bounded.skillIds).toHaveLength(1); expect(bounded.truncated).toBe(true);
    expect((await f.app.inject({ url: `/api/skills/${c.foreign.id}/related`, headers: headers() })).statusCode).toBe(404);
    expect((await f.app.inject({ url: `/api/skills/${randomUUID()}/related`, headers: headers() })).statusCode).toBe(404);
    for (const query of ['depth=3', 'depth=-1', 'limit=25', 'limit=0', `ownerId=${otherId}`]) expect((await f.app.inject({ url: `/api/skills/${c.alpha.id}/related?${query}`, headers: headers() })).statusCode).toBe(400);
  });

  it('produces the same graph for repeated rebuilding and leaves reads mutation-free', async () => {
    const f = application!, c = await installedChain(), first = await graph();
    await f.database.db.transaction().execute(tx => rebuildSkillGraph(tx, ownerId));
    const rebuilt = await graph(); expect(rebuilt.snapshotHash).toBe(first.snapshotHash); expect(rebuilt.nodes).toEqual(first.nodes); expect(rebuilt.edges).toEqual(first.edges);
    const audit = await f.database.db.selectFrom('skill_audit').selectAll().orderBy('id').execute(), versions = await f.database.db.selectFrom('skill_versions').selectAll().orderBy('id').execute();
    await graph(); await related(c.alpha.id); expect(await f.database.db.selectFrom('skill_audit').selectAll().orderBy('id').execute()).toEqual(audit); expect(await f.database.db.selectFrom('skill_versions').selectAll().orderBy('id').execute()).toEqual(versions);
  });

  it('does not load tampered or stale instruction content merely because a graph edge points at it', async () => {
    const f = application!, c = await installedChain(), db = f.database.db, file = await db.selectFrom('skill_files').selectAll().where('version_id', '=', c.beta.id).where('path', '=', 'SKILL.md').executeTakeFirstOrThrow();
    try {
      await db.updateTable('skill_files').set({ content: `${file.content}\nM10_UNVERIFIED_MUTATION` }).where('version_id', '=', c.beta.id).where('path', '=', 'SKILL.md').execute();
      const context = await f.skills.context(ownerId, 'nebulaanchor', { budgetChars: 8000 }); expect(context.text).toContain('M10_ALPHA_MARKER'); expect(context.text).not.toContain('M10_BETA_MARKER'); expect(context.text).not.toContain('M10_UNVERIFIED_MUTATION');
      expect((await graph()).permissionsGranted).toBe(false);
    } finally { await db.updateTable('skill_files').set({ content: file.content }).where('version_id', '=', c.beta.id).where('path', '=', 'SKILL.md').execute(); }
  });

  it('updates replacement, rollback and revocation links through the actual lifecycle without granting authority', async () => {
    const f = application!, c = await installedChain(), replacement = await install(instruction('nebula-guide', ['quartz-check'], '2.0.0'), 'M10_NEW_BETA_MARKER: use only current evidence.');
    expect((await related(c.alpha.id)).skillIds).toContain(replacement.id); expect((await related(c.alpha.id)).skillIds).not.toContain(c.beta.id);
    let context = await f.skills.context(ownerId, 'nebulaanchor', { budgetChars: 8000 }); expect(context.text).toContain('M10_NEW_BETA_MARKER'); expect(context.text).not.toContain('M10_BETA_MARKER:');
    const old = (await f.skills.detail(ownerId, c.beta.id)).skill;
    const rolled = (await f.skills.rollback(ownerId, old.id, { expectedRevision: old.revision, approve: true, reason: 'Controlled fixture restores the previous guidance.' })).skill;
    expect((await related(c.alpha.id)).skillIds).toContain(c.beta.id); expect((await related(c.alpha.id)).skillIds).not.toContain(replacement.id);
    await f.skills.revoke(ownerId, rolled.id, { expectedRevision: rolled.revision, reason: 'Controlled fixture revocation.' });
    expect((await related(c.alpha.id)).skillIds).not.toContain(c.beta.id); context = await f.skills.context(ownerId, 'nebulaanchor', { budgetChars: 8000 }); expect(context.text).not.toContain('M10_BETA_MARKER'); expect(context.text).not.toContain('M10_NEW_BETA_MARKER');
    expect((await graph()).permissionsGranted).toBe(false); expect(await f.database.db.selectFrom('skill_grants').select('id').execute()).toEqual([]);
  });

  it('fails closed on missing or malformed persisted conflicts and repairs only through an explicit authenticated request', async () => {
    const f = application!, db = f.database.db;
    const target = await install(SkillContractSchema.parse({ ...instruction('graph-conflict-target'), conflicts: ['graph-conflict-source'] }), 'Compare this guidance with the declared conflict before selection.');
    const source = await install(instruction('graph-conflict-source', ['graph-conflict-target']), 'Use only compatible dependency guidance.');
    const initial = await graph(), conflict = initial.edges.find(edge => edge.relation === 'conflicts_with' && edge.from === `skill:${target.id}` && edge.to === `skill:${source.id}`)!;
    expect(conflict).toBeDefined(); expect(initial.truncated).toBe(false); expect((await related(source.id)).skillIds).toEqual([]);
    const original = await db.selectFrom('skill_edges').selectAll().where('owner_id', '=', ownerId).where('edge_key', '=', conflict.id).executeTakeFirstOrThrow();
    const originalPayload = typeof original.payload === 'string' ? original.payload : JSON.stringify(original.payload);
    const tasks = await db.selectFrom('tasks').selectAll().orderBy('id').execute(), grants = await db.selectFrom('skill_grants').selectAll().orderBy('id').execute();
    const foreignEdges = await db.selectFrom('skill_edges').selectAll().where('owner_id', '=', otherId).orderBy('edge_key').execute();
    try {
      for (const damage of ['malformed', 'missing'] as const) {
        if (damage === 'malformed') await db.updateTable('skill_edges').set({ payload: JSON.stringify({ invalid: true }) }).where('owner_id', '=', ownerId).where('edge_key', '=', conflict.id).execute();
        else await db.deleteFrom('skill_edges').where('owner_id', '=', ownerId).where('edge_key', '=', conflict.id).execute();
        const damagedRows = await db.selectFrom('skill_edges').selectAll().where('owner_id', '=', ownerId).orderBy('edge_key').execute();
        const damaged = await graph(); expect(damaged.truncated).toBe(true); expect(damaged.edges).toContainEqual(expect.objectContaining({ relation: 'depends_on', from: `skill:${source.id}`, to: `skill:${target.id}` }));
        expect(await related(source.id)).toMatchObject({ skillIds: [], truncated: true, permissionsGranted: false });
        expect(await db.selectFrom('skill_edges').selectAll().where('owner_id', '=', ownerId).orderBy('edge_key').execute()).toEqual(damagedRows);
        if (damage === 'malformed') await db.updateTable('skill_edges').set({ payload: originalPayload }).where('owner_id', '=', ownerId).where('edge_key', '=', conflict.id).execute();
      }
      expect((await f.app.inject({ method: 'POST', url: '/api/skills/graph/rebuild', headers: headers(''), payload: {} })).statusCode).toBe(401);
      for (const payload of [{ ownerId: otherId }, { approve: true }, { nodes: [], edges: [] }]) expect((await f.app.inject({ method: 'POST', url: '/api/skills/graph/rebuild', headers: headers(), payload })).statusCode).toBe(400);
      expect((await f.app.inject({ method: 'POST', url: `/api/skills/graph/rebuild?ownerId=${otherId}`, headers: headers(), payload: {} })).statusCode).toBe(400);
      const response = await f.app.inject({ method: 'POST', url: '/api/skills/graph/rebuild', headers: headers(), payload: {} }); expect(response.statusCode, response.body).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
      const repaired = SkillGraphSnapshotSchema.parse(response.json()); expect(repaired).toMatchObject({ rebuilt: true, truncated: false, permissionsGranted: false }); expect(repaired.edges).toContainEqual(conflict);
      expect(await related(source.id)).toMatchObject({ skillIds: [], truncated: false, permissionsGranted: false });
      expect(await db.selectFrom('tasks').selectAll().orderBy('id').execute()).toEqual(tasks); expect(await db.selectFrom('skill_grants').selectAll().orderBy('id').execute()).toEqual(grants);
      expect(await db.selectFrom('skill_edges').selectAll().where('owner_id', '=', otherId).orderBy('edge_key').execute()).toEqual(foreignEdges);
    } finally {
      await db.deleteFrom('skill_edges').where('owner_id', '=', ownerId).where('edge_key', '=', conflict.id).execute();
      await db.insertInto('skill_edges').values({ ...original, payload: originalPayload }).execute();
    }
  });

  it('derives a step outcome only from a real approved temporary write and suppresses damaged proof', async () => {
    const f = application!, db = f.database.db, files = join(directory, 'files'); await mkdir(join(files, 'reports'), { recursive: true });
    const field = (name: string, type: string) => ({ name, type, description: `Fixture ${name}` });
    const contract = SkillContractSchema.parse({ slug: 'graph-real-writer', name: 'Graph real writer', description: 'Write a controlled temporary report with actual verified evidence.', category: 'documents', version: '1.0.0', level: 'tool', inputs: [field('root', 'file'), field('path', 'file'), field('content', 'string'), field('expectedHash', 'json')], outputs: [field('hash', 'string')], requires: { tools: ['file.write'], paths: ['reports'] }, sideEffects: 'write_local', rollback: { mode: 'restore_preimage' }, idempotent: true, verification: 'Verify actual bounded file output and its saved hash.', steps: [{ id: 'write', kind: 'tool', tool: 'file.write', title: 'Controlled temporary write', inputs: { root: 'input.root', path: 'input.path', content: 'input.content', expectedHash: 'input.expectedHash' }, outputs: [field('hash', 'string')] }] });
    let version = await install(contract, 'Write only the separately approved report.');
    await f.skills.createGrant(ownerId, version.id, { expectedRevision: version.revision, approve: true, tools: ['file.write'], roots: [files], durationHours: 1 }); version = (await f.skills.detail(ownerId, version.id)).skill;
    const content = 'M10_REAL_FILE_RECEIPT_MARKER', response = await f.app.inject({ method: 'POST', url: `/api/skills/${version.id}/run`, headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: { expectedRevision: version.revision, values: { root: files, path: 'reports/proof.txt', content, expectedHash: null } } }); expect(response.statusCode, response.body).toBe(200);
    const parentId = response.json().task.id;
    expect((await f.app.inject({ method: 'POST', url: `/api/tasks/${parentId}/approve`, headers: headers(), payload: {} })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 8; attempt++) {
      await f.runtime.tick();
      const parent = await db.selectFrom('tasks').select(['status', 'error']).where('id', '=', parentId).executeTakeFirstOrThrow();
      if (parent.status === 'completed') break; if (parent.status === 'failed') throw new Error(`Graph source workflow failed: ${parent.error}`);
      const children = await db.selectFrom('skill_run_nodes as n').innerJoin('skill_runs as r', 'r.id', 'n.run_id').innerJoin('tasks as t', 't.id', 'n.child_task_id').select('t.id').where('r.parent_task_id', '=', parentId).where('t.status', '=', 'waiting_approval').execute();
      for (const child of children) expect((await f.app.inject({ method: 'POST', url: `/api/tasks/${child.id}/approve`, headers: headers(), payload: {} })).statusCode).toBe(200);
    }
    expect((await db.selectFrom('tasks').select('status').where('id', '=', parentId).executeTakeFirstOrThrow()).status).toBe('completed'); expect(await readFile(join(files, 'reports', 'proof.txt'), 'utf8')).toBe(content);
    const run = await db.selectFrom('skill_runs').select('id').where('parent_task_id', '=', parentId).executeTakeFirstOrThrow(), receipt = await db.selectFrom('skill_evidence').selectAll().where('run_id', '=', run.id).where('status', '=', 'succeeded').executeTakeFirstOrThrow();
    const child = await db.selectFrom('tasks').select('result').where('id', '=', receipt.task_id).executeTakeFirstOrThrow(), originalResult = typeof child.result === 'string' ? JSON.parse(child.result) : child.result, originalOutput = typeof receipt.output === 'string' ? JSON.parse(receipt.output) : receipt.output;
    const sourceNode = await db.selectFrom('skill_run_nodes').select('outputs').where('run_id', '=', run.id).where('node_id', '=', receipt.node_id).executeTakeFirstOrThrow(), originalNodeOutput = typeof sourceNode.outputs === 'string' ? JSON.parse(sourceNode.outputs) : sourceNode.outputs;
    const snapshot = await graph(), outcome = snapshot.nodes.find(node => node.kind === 'outcome' && node.receiptId === receipt.id);
    expect(outcome).toMatchObject({ kind: 'outcome', scope: 'step', receiptId: receipt.id, taskId: receipt.task_id, runId: run.id, inputsHash: receipt.inputs_hash, outputHash: receipt.output_hash });
    expect(snapshot.edges).toContainEqual(expect.objectContaining({ from: `skill:${version.id}`, to: `outcome:${receipt.id}`, relation: 'verified_outcome', provenance: 'verified_receipt', sourceContentHash: version.contentHash })); expect(JSON.stringify(snapshot)).not.toContain(content);
    try {
      await db.updateTable('tasks').set({ status: 'failed' }).where('id', '=', receipt.task_id).execute(); expect((await graph()).nodes.some(node => node.key === `outcome:${receipt.id}`)).toBe(false);
      await db.updateTable('tasks').set({ status: 'completed' }).where('id', '=', receipt.task_id).execute(); await db.updateTable('skill_evidence').set({ output_hash: '0'.repeat(64) }).where('id', '=', receipt.id).execute(); expect((await graph()).nodes.some(node => node.key === `outcome:${receipt.id}`)).toBe(false);
      // Equal duplicated payloads are insufficient proof if their saved digest
      // no longer describes those bytes. Start from the real verified receipt.
      const corrupted = { ...originalOutput, hash: '0'.repeat(64) };
      await db.updateTable('skill_evidence').set({ output_hash: receipt.output_hash, output: JSON.stringify(corrupted) }).where('id', '=', receipt.id).execute(); await db.updateTable('tasks').set({ result: JSON.stringify({ ...originalResult, output: corrupted }) }).where('id', '=', receipt.task_id).execute(); await db.updateTable('skill_run_nodes').set({ outputs: JSON.stringify(corrupted) }).where('run_id', '=', run.id).where('node_id', '=', receipt.node_id).execute();
      expect((await graph()).nodes.some(node => node.key === `outcome:${receipt.id}`), 'Copied output corruption must not retain verified provenance with its old hash').toBe(false);
    } finally { await db.updateTable('tasks').set({ status: 'completed', result: JSON.stringify(originalResult) }).where('id', '=', receipt.task_id).execute(); await db.updateTable('skill_evidence').set({ output_hash: receipt.output_hash, output: JSON.stringify(originalOutput) }).where('id', '=', receipt.id).execute(); await db.updateTable('skill_run_nodes').set({ outputs: JSON.stringify(originalNodeOutput) }).where('run_id', '=', run.id).where('node_id', '=', receipt.node_id).execute(); }
    expect((await graph()).permissionsGranted).toBe(false);
  }, 60000);
});
