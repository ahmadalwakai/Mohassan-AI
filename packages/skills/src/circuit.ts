import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { SkillError } from './errors.ts';
import { hashSkillData } from './evidence.ts';

export interface SkillCircuitTicket { id: string; stateId: string; ownerId: string; generation: number; probeToken: string | null }
export type SkillCircuitOutcome = 'success' | 'transient_failure' | 'neutral';
export class SkillCircuitOpenError extends SkillError {
  constructor(readonly retryAt: string) { super('SKILL_CIRCUIT_OPEN', 'أوقفت الحماية الأداة مؤقتًا بعد أعطال متكررة؛ لم تُرسل عملية جديدة.', 409); }
}

/** Availability protection only. A ticket is never a grant or an idempotency
 * guarantee. Every half-open probe is an independently authorized Runtime task. */
export function createSkillCircuit(db: Kysely<any>, options: {now?: () => Date; threshold?: number; cooldownMs?: number; probeMs?: number} = {}) {
  const now = options.now ?? (() => new Date());
  const threshold = z.number().int().min(1).max(10).parse(options.threshold ?? 3);
  const cooldown = z.number().int().min(1000).max(300_000).parse(options.cooldownMs ?? 30_000);
  const probeMs = z.number().int().min(1000).max(60_000).parse(options.probeMs ?? 25_000);
  const reopenAt = (instant: Date, retryAfterMs?: number) => {
    const delay = retryAfterMs === undefined ? cooldown
      : Number.isSafeInteger(Math.ceil(retryAfterMs)) && retryAfterMs >= 0 ? Math.max(cooldown, retryAfterMs) : 8_640_000_000_000_000;
    // A delay outside Date's representable range leaves the circuit closed to
    // execution for the entire representable future; it never becomes 24h.
    return new Date(Math.min(8_640_000_000_000_000, instant.getTime() + delay));
  };

  async function acquire(ownerId: string, versionId: string, contentHash: string, target: string): Promise<SkillCircuitTicket> {
    z.string().min(1).max(200).parse(ownerId); z.uuid().parse(versionId); z.string().regex(/^[a-f0-9]{64}$/).parse(contentHash); z.string().min(1).max(150).parse(target);
    const stateId = hashSkillData({ownerId, versionId, contentHash, target}), instant = now();
    const result = await db.transaction().execute(async tx => {
      const version = await tx.selectFrom('skill_versions').select('id').where('id', '=', versionId).where('owner_id', '=', ownerId).where('content_hash', '=', contentHash).executeTakeFirst();
      if (!version) throw new SkillError('SKILL_CIRCUIT_SCOPE', 'الحماية مقيدة بنسخة المهارة المملوكة وبصمتها.', 403);
      await tx.insertInto('skill_circuit_state').values({id: stateId, owner_id: ownerId, version_id: versionId, content_hash: contentHash, target, status: 'closed', failures: 0, generation: 1})
        .onConflict(conflict => conflict.column('id').doNothing()).execute();
      const state = await tx.selectFrom('skill_circuit_state').selectAll().where('id', '=', stateId).forUpdate().executeTakeFirstOrThrow();
      if (state.status === 'open' && new Date(state.opened_until).getTime() > instant.getTime()) return {blocked: new Date(state.opened_until).toISOString()} as const;
      if (state.status === 'half_open') {
        if (new Date(state.probe_until).getTime() > instant.getTime()) return {blocked: new Date(state.probe_until).toISOString()} as const;
        // A crashed/expired probe is not success. Reopen and fence its late result;
        // do not launch a replacement request while processing the expiry itself.
        const until = new Date(instant.getTime() + cooldown);
        await tx.updateTable('skill_circuit_state').set({status: 'open', generation: state.generation + 1, opened_until: until, probe_token: null, probe_until: null, updated_at: instant}).where('id', '=', stateId).execute();
        return {blocked: until.toISOString()} as const;
      }
      const halfOpen = state.status === 'open', generation = state.generation + (halfOpen ? 1 : 0), probeToken = halfOpen ? randomUUID() : null;
      if (halfOpen) await tx.updateTable('skill_circuit_state').set({status: 'half_open', generation, probe_token: probeToken, probe_until: new Date(instant.getTime() + probeMs), updated_at: instant}).where('id', '=', stateId).execute();
      return {ticket: {id: randomUUID(), stateId, ownerId, generation, probeToken}} as const;
    });
    if ('blocked' in result) throw new SkillCircuitOpenError(result.blocked!);
    return result.ticket;
  }

  async function settle(ticket: SkillCircuitTicket, outcome: SkillCircuitOutcome, metadata: {retryAfterMs?: number} = {}): Promise<void> {
    z.enum(['success', 'transient_failure', 'neutral']).parse(outcome);
    await db.transaction().execute(async tx => {
      const state = await tx.selectFrom('skill_circuit_state').selectAll().where('id', '=', ticket.stateId).where('owner_id', '=', ticket.ownerId).forUpdate().executeTakeFirst();
      if (!state) throw new SkillError('SKILL_CIRCUIT_NOT_FOUND', 'لم يُعثر على حالة الحماية.', 404);
      const instant = now(), expired = state.status === 'half_open' && new Date(state.probe_until).getTime() <= instant.getTime();
      const stale = expired || state.generation !== ticket.generation || (state.status === 'half_open' ? state.probe_token !== ticket.probeToken : ticket.probeToken !== null);
      const saved = await tx.insertInto('skill_circuit_outcomes').values({ticket_id: ticket.id, state_id: ticket.stateId, generation: ticket.generation, outcome: stale ? 'stale' : outcome})
        .onConflict(conflict => conflict.column('ticket_id').doNothing()).returning('ticket_id').executeTakeFirst();
      if (!saved) return;
      if (expired) await tx.updateTable('skill_circuit_state').set({status: 'open', generation: state.generation + 1, opened_until: reopenAt(instant), probe_token: null, probe_until: null, updated_at: instant}).where('id', '=', state.id).execute();
      if (stale) return;
      if (outcome === 'success') {
        await tx.updateTable('skill_circuit_state').set({status: 'closed', failures: 0, generation: state.generation + 1, opened_until: null, probe_token: null, probe_until: null, updated_at: instant}).where('id', '=', state.id).execute();
      } else if (outcome === 'transient_failure' || state.status === 'half_open') {
        const failures = state.failures + (outcome === 'transient_failure' ? 1 : 0), shouldOpen = state.status === 'half_open' || failures >= threshold;
        await tx.updateTable('skill_circuit_state').set({failures, updated_at: instant, ...(shouldOpen ? {status: 'open', generation: state.generation + 1,
          opened_until: reopenAt(instant, metadata.retryAfterMs), probe_token: null, probe_until: null} : {})}).where('id', '=', state.id).execute();
      }
    });
  }
  async function list(ownerId: string, versionId?: string) {
    let query = db.selectFrom('skill_circuit_state').select(['id', 'version_id', 'content_hash', 'target', 'status', 'failures', 'generation', 'opened_until', 'updated_at']).where('owner_id', '=', ownerId);
    if (versionId) query = query.where('version_id', '=', z.uuid().parse(versionId));
    return query.orderBy('updated_at', 'desc').limit(100).execute();
  }
  return {acquire, settle, list};
}
