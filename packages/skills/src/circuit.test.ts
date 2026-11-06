import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executionFixture, toolContract } from '../../../tests/helpers/skill-execution.ts';
import { createSkillCircuit } from './circuit.ts';

let fixture: Awaited<ReturnType<typeof executionFixture>>, version: Awaited<ReturnType<Awaited<ReturnType<typeof executionFixture>>['version']>>;
let clock: number;
beforeEach(async () => { fixture = await executionFixture(); version = await fixture.version(toolContract()); clock = Date.parse('2026-11-05T06:00:00Z'); });
afterEach(async () => { await fixture?.store.close(); });
const configured = (threshold = 3) => createSkillCircuit(fixture.store.db, {now: () => new Date(clock), threshold});
const acquire = (circuit: ReturnType<typeof configured>) => circuit.acquire(fixture.owner, version.id, version.hash, 'model:configured-router');

describe('durable bounded skill circuit', () => {
  it('opens after three recorded transient failures and rejects before any new operation', async () => {
    const circuit = configured();
    for (let attempt = 0; attempt < 3; attempt++) await circuit.settle(await acquire(circuit), 'transient_failure');
    await expect(acquire(circuit)).rejects.toMatchObject({code: 'SKILL_CIRCUIT_OPEN', retryAt: new Date(clock + 30000).toISOString()});
    expect((await circuit.list(fixture.owner))[0]).toMatchObject({status: 'open', failures: 3});
    expect(await circuit.list('foreign-owner')).toEqual([]);
  });
  it('does not double-count an outcome and ignores an old generation success after opening', async () => {
    const circuit = configured(), late = await acquire(circuit), first = await acquire(circuit);
    await circuit.settle(first, 'transient_failure'); await circuit.settle(first, 'transient_failure');
    expect((await circuit.list(fixture.owner))[0].failures).toBe(1);
    await circuit.settle(await acquire(circuit), 'transient_failure'); await circuit.settle(await acquire(circuit), 'transient_failure');
    await circuit.settle(late, 'success');
    expect((await circuit.list(fixture.owner))[0]).toMatchObject({status: 'open', failures: 3});
    expect((await fixture.store.db.selectFrom('skill_circuit_outcomes').select('outcome').where('ticket_id', '=', late.id).executeTakeFirstOrThrow()).outcome).toBe('stale');
  });
  it('allows one authorized half-open probe across concurrent controllers', async () => {
    const first = configured(1), second = configured(1);
    await first.settle(await acquire(first), 'transient_failure'); clock += 30001;
    const attempts = await Promise.allSettled([acquire(first), acquire(second), acquire(first)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const result = attempts.find(result => result.status === 'fulfilled')!; if (result.status !== 'fulfilled') throw new Error('probe');
    expect(result.value.probeToken).not.toBeNull();
    await first.settle(result.value, 'success');
    expect((await first.list(fixture.owner))[0]).toMatchObject({status: 'closed', failures: 0});
    expect((await acquire(second)).probeToken).toBeNull();
  });
  it('reopens an expired probe and rejects its late success', async () => {
    const circuit = configured(1); await circuit.settle(await acquire(circuit), 'transient_failure'); clock += 30001;
    const probe = await acquire(circuit); clock += 25001;
    await expect(acquire(circuit)).rejects.toMatchObject({code: 'SKILL_CIRCUIT_OPEN'});
    await circuit.settle(probe, 'success');
    expect((await circuit.list(fixture.owner))[0].status).toBe('open');
  });
  it('cannot close an expired probe even if no new acquirer has observed its expiry', async () => {
    const circuit = configured(1); await circuit.settle(await acquire(circuit), 'transient_failure'); clock += 30001;
    const probe = await acquire(circuit); clock += 25001; await circuit.settle(probe, 'success');
    expect((await circuit.list(fixture.owner))[0].status).toBe('open');
  });
  it('does not shorten a provider delay longer than the automatic recovery horizon', async () => {
    const circuit = configured(1), originalDelay = 2 * 86400000;
    await circuit.settle(await acquire(circuit), 'transient_failure', {retryAfterMs: originalDelay});
    expect(new Date((await circuit.list(fixture.owner))[0].opened_until).getTime()).toBe(clock + originalDelay);
    clock += 86400000;
    await expect(acquire(circuit)).rejects.toMatchObject({code: 'SKILL_CIRCUIT_OPEN'});
  });
  it('does not treat validation or cancellation as an upstream outage', async () => {
    const circuit = configured(1); await circuit.settle(await acquire(circuit), 'neutral');
    expect((await circuit.list(fixture.owner))[0]).toMatchObject({status: 'closed', failures: 0});
    await circuit.settle(await acquire(circuit), 'transient_failure'); clock += 30001;
    await circuit.settle(await acquire(circuit), 'neutral');
    expect((await circuit.list(fixture.owner))[0].status).toBe('open');
  });
  it('rejects another owner or changed version hash and scopes every persisted outcome', async () => {
    const circuit = configured();
    await expect(circuit.acquire('foreign-owner', version.id, version.hash, 'file.read')).rejects.toMatchObject({code: 'SKILL_CIRCUIT_SCOPE'});
    await expect(circuit.acquire(fixture.owner, version.id, 'f'.repeat(64), 'file.read')).rejects.toMatchObject({code: 'SKILL_CIRCUIT_SCOPE'});
    const ticket = await acquire(circuit);
    await expect(circuit.settle({...ticket, ownerId: 'foreign-owner'}, 'success')).rejects.toMatchObject({code: 'SKILL_CIRCUIT_NOT_FOUND'});
    expect(await fixture.store.db.selectFrom('skill_circuit_outcomes').selectAll().execute()).toEqual([]);
  });
});
