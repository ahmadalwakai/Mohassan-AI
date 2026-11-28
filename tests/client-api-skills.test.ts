import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PhoneOkReplySchema, SkillActivateSchema, SkillBenchmarkCatalogSchema, SkillBenchmarkEvaluationSchema,
  SkillBenchmarkRequestSchema, SkillCompositionRequestSchema, SkillCompositionResultSchema,
  SkillContractSchema, SkillDetailSchema, SkillFileContentSchema, SkillForgePromoteSchema,
  SkillForgeRequestSchema, SkillGrantCreateSchema, SkillGrantRevokeSchema, SkillGrantSchema,
  SkillGraphSnapshotSchema, SkillImportResultSchema, SkillImportSchema, SkillInspectRequestSchema,
  SkillQualityDetailSchema, SkillRevokeSchema, SkillRollbackSchema, SkillRunRequestSchema, TaskSchema,
  type SkillContract,
} from '@mohassan/contracts';
import { singlePlan, toolContract } from './helpers/skill-execution.js';
import { checkError, checkJson, openClientApiApp, type ClientApiAccount } from './support/client-api-app.js';

const base = '/api/skills';
const reason = 'Finish the local contract scenario.';
const skillRequested = z.strictObject({ task: TaskSchema, runId: z.uuid().nullable() });

describe('skill client wire contracts through the Fastify app', () => {
  let fixture: Awaited<ReturnType<typeof openClientApiApp>>;
  let owner: ClientApiAccount;

  beforeAll(async () => {
    fixture = await openClientApiApp({ skillEngineEnabled: true });
    owner = await fixture.setupOwner();
  });

  afterAll(async () => { await fixture?.close(); });

  async function install(contract: SkillContract, instructions: string) {
    const path = join(fixture.directory, `${contract.slug}-${contract.version}`);
    await mkdir(path);
    const manifest = `---\nname: ${contract.slug}\ndescription: ${contract.description}\nversion: ${contract.version}\n---\n${instructions}\n`;
    await writeFile(join(path, 'SKILL.md'), manifest);
    await writeFile(join(path, 'skill.contract.json'), JSON.stringify(contract));
    const imported = checkJson(await fixture.send('POST', `${base}/import`, owner, SkillImportSchema.parse({ path })), 200, SkillImportResultSchema);
    const id = imported.skill.id;
    const retrieved = checkJson(await fixture.send('GET', `${base}/${id}`, owner), 200, SkillDetailSchema);
    expect(retrieved.skill).toEqual(imported.skill);
    const file = checkJson(await fixture.send('GET', `${base}/${id}/file?path=SKILL.md`, owner), 200, SkillFileContentSchema);
    expect(file.file.content).toBe(manifest);
    const request = SkillInspectRequestSchema.parse({ expectedRevision: imported.skill.revision });
    return checkJson(await fixture.send('POST', `${base}/${id}/inspect`, owner, request), 200, SkillDetailSchema);
  }

  async function activate({ skill }: z.output<typeof SkillDetailSchema>) {
    const request = SkillActivateSchema.parse({ expectedRevision: skill.revision, approve: true, acknowledgeFindings: true });
    return checkJson(await fixture.send('POST', `${base}/${skill.id}/activate`, owner, request), 200, SkillDetailSchema);
  }

  it('validates review, measured comparison, activation, rollback and revocation replies', async () => {
    const definition = {
      slug: 'fixture-report-guidance', name: 'Fixture report guidance', description: 'Present an evidence-based report to a reader.',
      category: 'documents', level: 'instruction',
    };
    // The instruction benchmark uses authored fixtures and no model (tests/skills-benchmark-api.test.ts).
    const baseline = await install(SkillContractSchema.parse({ ...definition, version: '1.0.0' }), 'Keep every source attribution.');
    const candidate = await install(SkillContractSchema.parse({ ...definition, version: '1.0.1' }), 'Keep every source attribution and mark uncertainty.');
    const catalog = checkJson(await fixture.send('GET', `${base}/benchmarks/suites`, owner), 200, SkillBenchmarkCatalogSchema);
    const suiteId = catalog.suites.find(suite => suite.scope === 'instruction_delivery')?.id;
    const experiment = SkillBenchmarkRequestSchema.parse({
      baselineId: baseline.skill.id, baselineRevision: baseline.skill.revision,
      candidateId: candidate.skill.id, candidateRevision: candidate.skill.revision, suiteId,
    });
    const evaluation = checkJson(await fixture.send('POST', `${base}/benchmarks`, owner, experiment, {
      'idempotency-key': randomUUID(),
    }), 200, SkillBenchmarkEvaluationSchema);
    expect(checkJson(await fixture.send('GET', `${base}/benchmarks/${evaluation.id}`, owner), 200, SkillBenchmarkEvaluationSchema).id).toBe(evaluation.id);
    checkJson(await fixture.send('GET', `${base}/${candidate.skill.id}/quality`, owner), 200, SkillQualityDetailSchema);

    expect((await activate(baseline)).skill.active).toBe(true);
    expect((await activate(candidate)).skill.active).toBe(true);
    const previous = checkJson(await fixture.send('GET', `${base}/${baseline.skill.id}`, owner), 200, SkillDetailSchema);
    const rollback = SkillRollbackSchema.parse({ expectedRevision: previous.skill.revision, approve: true, reason });
    const restored = checkJson(await fixture.send('POST', `${base}/${previous.skill.id}/rollback`, owner, rollback), 200, SkillDetailSchema);
    expect(restored.skill.active).toBe(true);
    const revoke = SkillRevokeSchema.parse({ expectedRevision: restored.skill.revision, reason });
    expect(checkJson(await fixture.send('POST', `${base}/${restored.skill.id}/revoke`, owner, revoke), 200, SkillDetailSchema).skill.status).toBe('revoked');
    checkJson(await fixture.send('POST', `${base}/graph/rebuild`, owner, {}), 200, SkillGraphSnapshotSchema);
  });

  it('creates reviewable skill requests and validates grant changes without dispatching tools', async () => {
    const definition = toolContract();
    const { skill } = await activate(await install(definition, 'Read the explicitly requested evidence.'));
    const url = `${base}/${skill.id}`;
    const grantRequest = SkillGrantCreateSchema.parse({ expectedRevision: skill.revision, approve: true,
      tools: definition.requires.tools, scopes: definition.requires.scopes, durationHours: 1 });
    const grant = checkJson(await fixture.send('POST', `${url}/grants`, owner, grantRequest), 200, SkillGrantSchema);
    const { plan, values } = singlePlan(skill.id);
    const composition = SkillCompositionRequestSchema.parse(plan);
    expect(checkJson(await fixture.send('POST', `${base}/compose/validate`, owner, composition), 200, SkillCompositionResultSchema).valid).toBe(true);
    const runRequest = SkillRunRequestSchema.parse({ plan: composition, values, expectedRevision: skill.revision });
    const headers = { 'idempotency-key': randomUUID() };
    const requested = checkJson(await fixture.send('POST', `${url}/run`, owner, runRequest, headers), 200, skillRequested);
    expect(requested).toMatchObject({ task: { status: 'waiting_approval' }, runId: null });
    checkError(await fixture.send('POST', `${url}/run`, owner, { ...runRequest, expectedRevision: skill.revision + 1 }, { 'idempotency-key': randomUUID() }), 409, 'SKILL_VERSION_CONFLICT');
    const revoke = SkillGrantRevokeSchema.parse({ reason });
    checkJson(await fixture.send('POST', `${url}/grants/${grant.id}/revoke`, owner, revoke), 200, PhoneOkReplySchema);
    expect(checkJson(await fixture.send('POST', `${base}/compose/validate`, owner, composition), 200, SkillCompositionResultSchema).valid).toBe(false);
  });

  it('validates errors for missing run history, a missing generation, and unavailable integrations', async () => {
    const id = randomUUID();
    const run = `${base}/runs/${id}`;
    for (const path of [run, `${run}/evidence`]) checkError(await fixture.send('GET', path, owner), 404, 'SKILL_RUN_NOT_FOUND');
    checkError(await fixture.send('POST', `${run}/cancel`, owner, {}), 404, 'SKILL_RUN_NOT_FOUND');
    const generation = `${base}/forge/generations/${id}`;
    for (const path of [generation, `${generation}/analysis`]) checkError(await fixture.send('GET', path, owner), 404, 'SKILL_FORGE_NOT_FOUND');
    const forge = SkillForgeRequestSchema.parse({ goal: 'Review the fixture instructions.', baselineId: id, baselineRevision: 1, approve: true });
    checkError(await fixture.send('POST', `${base}/forge/generations`, owner, forge), 409, 'SKILL_FORGE_MODEL_UNAVAILABLE');
    const promotion = SkillForgePromoteSchema.parse({ expectedRevision: 1, evaluationId: randomUUID(), approve: true });
    checkError(await fixture.send('POST', `${generation}/promote`, owner, promotion), 404, 'SKILL_FORGE_NOT_FOUND');
    checkError(await fixture.send('POST', `${base}/remote/sync`, owner, {}), 409, 'SKILL_REMOTE_NOT_CONFIGURED');
  });
});
