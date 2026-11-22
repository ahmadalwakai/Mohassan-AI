import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { resolve } from 'node:path';
import { safeRelative } from '@mohassan/coding';
import { SkillRemoteConfigSchema, SkillRemoteStartSchema, type SkillRemoteConfig } from '@mohassan/contracts';
import type { SkillControl } from '@mohassan/skills';

/** What SKILL_REMOTE_* resolved to. `config: null` with a `problem` means the values were present but invalid: the feature stays off and boot continues. */
export interface SkillRemoteSettings { config: SkillRemoteConfig | null; problem: string | null; dataDir: string }
const FIRST_TICK_MS = 15_000;

export function skillRemoteConfigFromEnv(env: NodeJS.ProcessEnv, cwd = process.cwd()): SkillRemoteSettings {
  const dataDir = env.SKILL_REMOTE_DATA_DIR?.trim() || resolve(cwd, '.data/skills-remote');
  const repo = env.SKILL_REMOTE_REPO?.trim();
  if (!repo) return { config: null, problem: null, dataDir };
  const minutes = env.SKILL_REMOTE_SYNC_MINUTES?.trim() || '30';
  const parsed = SkillRemoteConfigSchema.safeParse({
    repo, ref: env.SKILL_REMOTE_REF?.trim() || 'main', path: env.SKILL_REMOTE_PATH?.trim() || 'skills',
    autoActivate: env.SKILL_REMOTE_AUTO_ACTIVATE === 'true', intervalMinutes: /^\d{1,4}$/.test(minutes) ? Number(minutes) : -1,
  });
  const interval = parsed.success ? parsed.data.intervalMinutes : -1;
  let safePath = false;
  if (parsed.success) { try { safeRelative(parsed.data.path); safePath = true; } catch { safePath = false; } }
  if (!parsed.success || !safePath || (interval !== 0 && (interval < 5 || interval > 1440))) {
    console.error(JSON.stringify({ level: 'error', event: 'skill_remote_config_invalid' }));
    return { config: null, problem: 'SKILL_REMOTE_CONFIG_INVALID', dataDir };
  }
  return { config: parsed.data, problem: null, dataDir };
}

/** Owner-only: neither route is listed in MEMBER_ROUTES. The POST answers before any network work; the web proxy aborts at 15 s. */
export async function registerSkillRemoteRoutes(app: FastifyInstance, { skills, owner }: { skills: SkillControl; owner: (request: FastifyRequest) => Promise<{ id: string }> }) {
  app.get('/api/skills/remote', async (request, reply) => {
    const user = await owner(request); reply.header('cache-control', 'private, no-store');
    return skills.remote.status(user.id);
  });
  app.post('/api/skills/remote/sync', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await owner(request);
    SkillRemoteStartSchema.parse(request.body ?? {});
    const result = await skills.remote.start(user.id, 'manual');
    reply.code(202);
    return result;
  });
}

/** Scheduled polling: the first tick 15 s after boot, then every interval. Timers never keep the process alive; an already running sync is not an error. */
export function createSkillRemoteScheduler({ skills, db, intervalMinutes }: { skills: SkillControl; db: Kysely<any>; intervalMinutes: number }) {
  let timer: NodeJS.Timeout | null = null, interval: NodeJS.Timeout | null = null, ticking: Promise<void> | null = null;
  async function tick(): Promise<void> {
    const row = await db.selectFrom('workspace_owner').select('owner_id').where('id', '=', 1).executeTakeFirst();
    if (!row?.owner_id) return;
    try { await skills.remote.start(row.owner_id, 'schedule'); }
    catch (error) { if ((error as { code?: string } | null)?.code === 'SKILL_REMOTE_SYNC_RUNNING') return; throw error; }
  }
  function guarded() {
    if (ticking) return;
    ticking = tick().catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      console.error(JSON.stringify({ level: 'error', event: 'skill_remote_schedule_failed', code: typeof code === 'string' ? code : 'SKILL_REMOTE_SCHEDULE_FAILED' }));
    }).finally(() => { ticking = null; });
  }
  return {
    start() {
      if (timer || interval) return;
      timer = setTimeout(() => { timer = null; guarded(); interval = setInterval(guarded, intervalMinutes * 60_000); interval.unref(); }, FIRST_TICK_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearTimeout(timer); if (interval) clearInterval(interval);
      timer = null; interval = null;
      await ticking;
    },
  };
}
