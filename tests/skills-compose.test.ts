import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { memoryMigration } from '@mohassan/memory';
import { createSkillControl, skillsMigration, type SkillEnvironment } from '@mohassan/skills';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createApplication } from '../apps/server/src/app.js';

const capability = (id: string, status: 'active' | 'planned' | 'needs_configuration') => ({ id, name: id, description: id, version: '1', risk: 'low' as const, status, requiredScopes: [] });
const skillMd = (name: string, body = 'Plain, safe instructions.') => `---\nname: ${name}\ndescription: وصف واضح لهذه المهارة.\n---\n\n${body}\n`;
const toolContract = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, name: 'مهارة أدوات', description: 'تفتح صفحة وتعيد نتيجة.', version: '1.0.0', category: 'research', level: 'tool', requires: { tools: ['browser.open'] }, sideEffects: 'read', steps: [{ id: 'open', kind: 'tool', title: 'فتح', tool: 'browser.open' }], verification: 'تطابق النتيجة.', ...extra });

describe('permission-aware plan validation', () => {
  let store: Awaited<ReturnType<typeof createDatabase>>, skills: ReturnType<typeof createSkillControl>, root: string;
  const owner = 'compose-owner-fixture', other = 'compose-other-fixture';
  let environment: SkillEnvironment = { capabilities: [capability('browser.open', 'active'), capability('browser.research', 'active'), capability('coding.change', 'needs_configuration')], modelReady: true, visionReady: false, executableReady: false };
  async function prepared(contract: object | null, name: string, body?: string, activate = true) {
    const directory = join(root, randomUUID());
    await mkdir(directory);
    await writeFile(join(directory, 'SKILL.md'), skillMd(name, body));
    if (contract) await writeFile(join(directory, 'skill.contract.json'), JSON.stringify(contract));
    const { skill } = await skills.importLocal(owner, { path: directory });
    const inspected = await skills.inspect(owner, skill.id, { expectedRevision: skill.revision });
    return activate ? (await skills.activate(owner, skill.id, { expectedRevision: inspected.skill.revision, approve: true, acknowledgeFindings: true })).skill : inspected.skill;
  }
  const grant = (skill: { id: string; revision: number }, tools: string[], scopes: string[] = []) => skills.createGrant(owner, skill.id, { expectedRevision: skill.revision, approve: true, tools, scopes, durationHours: 1 });
  const codes = (result: { issues: { code: string }[] }) => result.issues.map((entry) => entry.code);
  beforeAll(async () => {
    store = await createDatabase(); await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db); await skillsMigration(store.db);
    for (const id of [owner, other]) await store.db.insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
    root = await mkdtemp(join(tmpdir(), 'skill-compose-'));
    skills = createSkillControl(store.db, { allowedRoots: [root], environment: () => environment });
  });
  afterAll(async () => { await store?.close(); await rm(root, { recursive: true, force: true }); });

  it('accepts a granted, active, available plan and grants nothing by doing so', async () => {
    const skill = await prepared(toolContract('allowed-plan'), 'allowed-plan');
    await grant(skill, ['browser.open']);
    const result = await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: skill.id }] });
    expect(result).toMatchObject({ valid: true, batches: [['a']], issues: [] });
    expect(result.nodes[0]).toMatchObject({ slug: 'allowed-plan', level: 'tool', role: 'execute', requiresApproval: false });
    expect((await skills.effectiveAccess(owner, skill.id)).tools.size).toBe(1);
  });
  it('rejects a tool skill that was not granted, naming what is missing', async () => {
    const skill = await prepared(toolContract('ungranted'), 'ungranted');
    const result = await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: skill.id }] });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'tool_not_granted', category: 'missing_permission', nodeId: 'a' })]);
  });
  it('rejects a tool the environment cannot provide, even when granted', async () => {
    const contract = toolContract('coding-plan', { requires: { tools: ['coding.change'] }, sideEffects: 'write_local', rollback: { mode: 'manual', note: 'مراجعة الفرق' }, steps: [{ id: 'code', kind: 'tool', title: 'تعديل', tool: 'coding.change' }] });
    const skill = await prepared(contract, 'coding-plan');
    await grant(skill, ['coding.change']);
    const result = await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: skill.id }] });
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: 'tool_unavailable', category: 'missing_tool' });
    expect(result.nodes[0].requiresApproval).toBe(true);
  });
  it('rejects a skill that is not active, and an unknown or foreign skill', async () => {
    const skill = await prepared(toolContract('inactive'), 'inactive', undefined, false);
    expect(codes(await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: skill.id }] }))).toContain('skill_not_active');
    expect(await skills.validateComposition(other, { nodes: [{ id: 'a', skillId: skill.id }] })).toMatchObject({ valid: false, issues: [{ code: 'skill_not_found', category: 'missing_skill' }] });
    expect(codes(await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: randomUUID() }] }))).toEqual(['skill_not_found']);
  });
  it('treats an expired or revoked grant as no grant', async () => {
    const skill = await prepared(toolContract('grant-revoked'), 'grant-revoked');
    const created = await grant(skill, ['browser.open']);
    expect((await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: skill.id }] })).valid).toBe(true);
    await skills.revokeGrant(owner, skill.id, created.id, { reason: 'انتهت الحاجة' });
    expect(codes(await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: skill.id }] }))).toEqual(['tool_not_granted']);
  });
  it('rejects reversed declared dependencies and still enforces grants in the corrected order', async () => {
    const provider = await prepared(toolContract('dependency-provider'), 'dependency-provider');
    const consumer = await prepared(toolContract('dependency-consumer', { dependsOn: ['dependency-provider'], requires: { tools: ['browser.open'], scopes: ['browser:read'] } }), 'dependency-consumer');
    await grant(provider, ['browser.open']);
    const consumerGrant = await grant(consumer, ['browser.open']);
    const reversed = await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: consumer.id }, { id: 'b', skillId: provider.id, dependsOn: ['a'] }] });
    expect(reversed.valid).toBe(false);
    expect(codes(reversed)).toEqual(expect.arrayContaining(['skill_dependency_unordered', 'scope_not_granted']));
    const correct = { nodes: [{ id: 'a', skillId: consumer.id, dependsOn: ['b'] }, { id: 'b', skillId: provider.id }] };
    expect(codes(await skills.validateComposition(owner, correct))).toEqual(['scope_not_granted']);
    await grant(consumer, [], ['browser:read']);
    expect(await skills.validateComposition(owner, correct)).toMatchObject({ valid: true, batches: [['b'], ['a']] });
    await skills.revokeGrant(owner, consumer.id, consumerGrant.id, { reason: 'Revoke the tool grant.' });
    expect(codes(await skills.validateComposition(owner, correct))).toEqual(['tool_not_granted']);
  });
  it.each(['outdated', 'missing', 'failed'])('refuses an active skill with an %s inspection without mutating it', async (state) => {
    const skill = await prepared(null, `inspection-${state}`);
    if (state === 'missing') await store.db.deleteFrom('skill_inspections').where('version_id', '=', skill.id).execute();
    else await store.db.updateTable('skill_inspections').set(state === 'outdated' ? { inspector_version: 'static-v1' } : { verdict: 'fail' }).where('version_id', '=', skill.id).execute();
    const before = await store.db.selectFrom('skill_versions').selectAll().where('id', '=', skill.id).executeTakeFirstOrThrow();
    const result = await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: skill.id }] });
    expect(result.valid).toBe(false);
    expect(codes(result)).toEqual([state === 'failed' ? 'skill_inspection_failed' : 'skill_inspection_stale']);
    expect(await store.db.selectFrom('skill_versions').selectAll().where('id', '=', skill.id).executeTakeFirstOrThrow()).toEqual(before);
  });
  it('lets instruction skills guide without grants but warns about missing tools', async () => {
    const guide = await prepared(null, 'plain-guide');
    expect(await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: guide.id }] })).toMatchObject({ valid: true, nodes: [{ role: 'context' }], issues: [] });
    const needsCoding = await prepared({ slug: 'coding-guide', name: 'دليل برمجة', description: 'يوجه تعديل الكود.', version: '1.0.0', category: 'coding', level: 'instruction', requires: { tools: ['coding.change'] }, sideEffects: 'write_local', rollback: { mode: 'manual', note: 'مراجعة الفرق' } }, 'coding-guide');
    expect(await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: needsCoding.id }] })).toMatchObject({ valid: true, issues: [{ code: 'tool_unavailable', severity: 'warning' }] });
  });
  it('keeps executable skills out of a valid plan while the gates are closed', async () => {
    const contract = { slug: 'script-plan', name: 'سكربت', description: 'يشغل سكربت داخل العزل.', version: '1.0.0', category: 'analytics', level: 'executable', steps: [{ id: 'run', kind: 'script', title: 'تشغيل', entry: 'main.mjs' }], execution: { timeoutMs: 1000, memoryMb: 64, outputMaxBytes: 1024 }, verification: 'وجود الناتج.' };
    const directory = join(root, randomUUID());
    await mkdir(directory);
    await writeFile(join(directory, 'SKILL.md'), skillMd('script-plan')); await writeFile(join(directory, 'main.mjs'), "console.log('x');"); await writeFile(join(directory, 'skill.contract.json'), JSON.stringify(contract));
    const { skill } = await skills.importLocal(owner, { path: directory });
    await skills.inspect(owner, skill.id, { expectedRevision: skill.revision });
    await store.db.updateTable('skill_versions').set({ status: 'active' }).where('id', '=', skill.id).execute();
    await store.db.updateTable('skill_families').set({ active_version_id: skill.id }).where('id', '=', skill.familyId).execute();
    const result = await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: skill.id }] });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'isolation_gates_closed', category: 'environment_failure' })]);
  });
  it('rejects a parallel plan that shares a resource, then accepts it once ordered', async () => {
    const browser = (slug: string) => toolContract(slug, { requires: { tools: ['browser.interact'] }, sideEffects: 'write_local', rollback: { mode: 'manual', note: 'إغلاق الجلسة' }, steps: [{ id: 'act', kind: 'tool', title: 'تعبئة', tool: 'browser.interact' }] });
    const one = await prepared(browser('writer-one'), 'writer-one'), two = await prepared(browser('writer-two'), 'writer-two');
    await grant(one, ['browser.interact']); await grant(two, ['browser.interact']);
    const parallel = await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: one.id }, { id: 'b', skillId: two.id }] });
    expect(parallel.valid).toBe(false);
    expect(codes(parallel)).toEqual(['resource_conflict']);
    expect(await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: one.id }, { id: 'b', skillId: two.id, dependsOn: ['a'] }] })).toMatchObject({ valid: true, batches: [['a'], ['b']] });
  });
  it('detects tampered content in a plan', async () => {
    const skill = await prepared(null, 'tampered-plan');
    await store.db.updateTable('skill_files').set({ content: 'Changed after approval.' }).where('version_id', '=', skill.id).execute();
    expect(await skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: skill.id }] })).toMatchObject({ valid: false, issues: [{ code: 'skill_integrity_failed', category: 'environment_failure' }] });
  });
  it('fails closed with no environment configured', async () => {
    const skill = await prepared(toolContract('no-environment'), 'no-environment');
    await grant(skill, ['browser.open']);
    const bare = createSkillControl(store.db, { allowedRoots: [root] });
    expect(codes(await bare.validateComposition(owner, { nodes: [{ id: 'a', skillId: skill.id }] }))).toEqual(['tool_unavailable']);
  });
  it('rejects malformed requests before reading anything', async () => {
    await expect(skills.validateComposition(owner, { nodes: [] })).rejects.toThrow();
    await expect(skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: 'x' }] })).rejects.toThrow();
    await expect(skills.validateComposition(owner, { nodes: [{ id: 'a', skillId: randomUUID(), run: true }] })).rejects.toThrow();
    await expect(skills.validateComposition(owner, { nodes: Array.from({ length: 13 }, (_, index) => ({ id: `n${index}`, skillId: randomUUID() })) })).rejects.toThrow();
  });
});

describe('compose validation API', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, cookie = '';
  const webOrigin = 'http://127.0.0.1:3000', secret = 'skills-compose-fixture-internal-secret', setupToken = 'skills-compose-fixture-setup-token-01';
  const headers = () => ({ 'x-mohassan-internal': secret, origin: webOrigin, ...(cookie ? { cookie } : {}) });
  beforeAll(async () => {
    application = await createApplication({ authSecret: 'skills-compose-fixture-auth-secret-001', internalSecret: secret, setupToken, webOrigin, production: false, runWorker: false });
    const account = { email: 'skills-compose@example.test', password: 'Skills-Compose-Password-Fixture-42' };
    await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { name: 'Skills fixture', ...account, setupToken } });
    const login = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: account });
    cookie = [login.headers['set-cookie']].flat().filter(Boolean).map((value) => String(value).split(';')[0]).join('; ');
  });
  afterAll(async () => { await application?.app.close(); });

  it('needs a session and returns a reasoned refusal', async () => {
    const saved = cookie; cookie = '';
    expect((await application.app.inject({ method: 'POST', url: '/api/skills/compose/validate', headers: headers(), payload: { nodes: [{ id: 'a', skillId: randomUUID() }] } })).statusCode).toBe(401);
    cookie = saved;
    const response = await application.app.inject({ method: 'POST', url: '/api/skills/compose/validate', headers: headers(), payload: { nodes: [{ id: 'a', skillId: randomUUID() }] } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ valid: false, issues: [{ code: 'skill_not_found' }] });
    expect((await application.app.inject({ method: 'POST', url: '/api/skills/compose/validate', headers: headers(), payload: { nodes: [] } })).statusCode).toBe(400);
  });
});
