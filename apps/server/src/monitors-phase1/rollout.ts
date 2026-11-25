import type { Kysely } from 'kysely';
import { roleOf, type WorkspaceRole } from '../members.js';

export type EnabledMonitorRollout = 'owner' | 'all';

export function monitorRollout(env: NodeJS.ProcessEnv = process.env): EnabledMonitorRollout | 'off' {
  const configured = env.MOHASSAN_MONITORS_ENABLED;
  if (configured === 'owner') return 'owner';
  return configured === '1' ? 'all' : 'off';
}

export const smartMonitorsEnabled = (env?: NodeJS.ProcessEnv) => monitorRollout(env) !== 'off';

export function monitorRoleAllowed(rollout: EnabledMonitorRollout, role: WorkspaceRole | null) {
  return role === 'owner' || (role === 'member' && rollout === 'all');
}

export async function monitorAccountAllowed(db: Kysely<any>, userId: string, rollout: EnabledMonitorRollout) {
  // All-account readiness also serves the standalone chat controller, without workspace tables.
  // The HTTP session gate and transactional monitor writes enforce account access.
  return rollout === 'all' || await roleOf(db, userId) === 'owner';
}

/** Select the same owner grants as roleOf, before a worker takes a bounded batch. */
export function monitorOwnerIds(db: Kysely<any>) {
  return db.selectFrom('workspace_owner').select('owner_id').where('id', '=', 1)
    .union(db.selectFrom('workspace_members').select('user_id as owner_id')
      .where('role', '=', 'owner').where('disabled_at', 'is', null));
}
