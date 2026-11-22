import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { safeRelative, sensitivePath } from '@mohassan/coding/security';
import { SkillRemoteStatusSchema, SkillRemoteSyncSchema, type SkillRemoteConfig, type SkillRemoteItem, type SkillRemoteStartResult, type SkillRemoteStatus, type SkillRemoteSync } from '@mohassan/contracts';
import { SkillError, SkillPolicyError } from './errors.ts';
import { buildSkillSource, type SkillSourceEntry } from './importer.ts';
import { MAX_IMPORTED_TOTAL_BYTES, MAX_IMPORTED_VERSIONS_PER_OWNER, storeImmutableSkill } from './import-store.ts';
import { classifySkillFile } from './inspector.ts';
import type { createSkillLifecycle } from './lifecycle.ts';

/** One entry of a Git tree, with `path` relative to the listed folder. */
export interface SkillRemoteEntry { mode: string; type: 'blob' | 'tree' | 'commit'; objectId: string; size: number | null; path: string }
/** What the sync needs from Git. Tests inject a fake; `remote-git.ts` adapts the restricted runner. Nothing fetched is ever executed. */
export interface SkillRemoteTransport {
  /** The commit the configured branch points at upstream. */
  head(signal: AbortSignal): Promise<string>;
  /** The commit available locally; fetches when it is missing and returns the commit actually stored. */
  ensure(commit: string, signal: AbortSignal): Promise<string>;
  /** Direct children of the skills folder; `path` is the child name. */
  children(commit: string, signal: AbortSignal): Promise<SkillRemoteEntry[]>;
  /** Every file below one skill folder with sizes; `path` is relative to that folder. */
  entries(commit: string, slug: string, signal: AbortSignal): Promise<SkillRemoteEntry[]>;
  blob(objectId: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
}
export interface SkillRemoteOptions {
  config: SkillRemoteConfig | null;
  /** Set when the environment named a repository but the values were invalid; the feature then stays off. */
  problem?: string | null;
  engineEnabled: boolean;
  transport: SkillRemoteTransport | null;
  lifecycle: Pick<ReturnType<typeof createSkillLifecycle>, 'inspect' | 'activateByPolicy'>;
  audit(tx: Kysely<any>, ownerId: string, targetId: string, event: string, detail?: Record<string, unknown>): Promise<void>;
  rebuildGraph?(tx: Kysely<any>, ownerId: string): Promise<void>;
  now?: () => Date;
}
export type SkillRemoteCause = 'schedule' | 'manual';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/;
const MAX_SKILLS = 100, MAX_FILES = 40, MAX_FILE_BYTES = 64000, RUN_LIMIT_MS = 120_000, KEEP_ROWS = 50, INTERRUPTED_AFTER_MS = 10 * 60_000, FIRST_TICK_MS = 15_000;
const json = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const errorCode = (error: unknown) => { const code = (error as { code?: unknown } | null)?.code; return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'SKILL_REMOTE_SYNC_FAILED'; };
const isAbort = (error: unknown) => (error as { name?: string } | null)?.name === 'AbortError' || (error as { code?: string } | null)?.code === 'ABORTED';
const emptyCounts = () => ({ total: 0, unchanged: 0, activated: 0, pendingReview: 0, rejected: 0, errors: 0 });

function tally(items: readonly SkillRemoteItem[]) {
  const counts = emptyCounts(); counts.total = items.length;
  for (const item of items) {
    if (item.outcome === 'unchanged') counts.unchanged++;
    else if (item.outcome === 'activated') counts.activated++;
    else if (item.outcome === 'pending_review') counts.pendingReview++;
    else if (item.outcome === 'rejected' || item.outcome === 'incompatible') counts.rejected++;
    else if (item.outcome === 'error') counts.errors++;
  }
  return counts;
}

/** Everything that must hold before a single blob is read. A violation fails this skill only. */
function validateEntries(entries: readonly SkillRemoteEntry[]): void {
  if (entries.length > MAX_FILES) throw new SkillError('SKILL_TOO_LARGE', 'تحتوي المهارة ملفات أكثر من المسموح.');
  let total = 0;
  for (const entry of entries) {
    if (entry.mode === '120000') throw new SkillError('SKILL_REMOTE_SYMLINK', 'تحتوي المهارة رابطاً رمزياً؛ لا يُقبل.');
    if (entry.mode === '160000' || entry.type === 'commit') throw new SkillError('SKILL_REMOTE_SUBMODULE', 'تحتوي المهارة وحدة فرعية؛ لا تُقبل.');
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) throw new SkillError('SKILL_FILE_UNSUPPORTED', 'نوع مدخل غير مدعوم في المهارة.');
    if (entry.size === null || !Number.isSafeInteger(entry.size) || entry.size > MAX_FILE_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'ملف في المهارة أكبر من المسموح.');
    total += entry.size;
    if (total > MAX_IMPORTED_TOTAL_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'تجاوزت المهارة الحجم المسموح.');
    let path: string;
    try { path = safeRelative(entry.path); } catch { throw new SkillError('SKILL_FILE_UNSUPPORTED', 'مسار ملف غير صالح في المهارة.'); }
    if (sensitivePath(path)) throw new SkillError('SKILL_FILE_UNSUPPORTED', 'مسار حساس داخل المهارة.');
    if (path !== 'skill.contract.json' && !classifySkillFile(path)) throw new SkillError('SKILL_FILE_UNSUPPORTED', `نوع ملف غير مدعوم: ${path}`);
  }
}

function syncDto(row: any): SkillRemoteSync {
  const report = json(row.report) ?? {};
  return SkillRemoteSyncSchema.parse({
    id: row.id, repo: row.repo, ref: row.ref, path: row.path, commit: row.commit_sha ?? null, cause: row.cause, status: row.status, errorCode: row.error_code ?? null,
    startedAt: iso(row.started_at), finishedAt: row.finished_at ? iso(row.finished_at) : null, unchanged: report.unchanged === true,
    counts: { ...emptyCounts(), ...(report.counts ?? {}) }, items: report.items ?? [], orphans: report.orphans ?? [],
  });
}

/** Polls one public GitHub repository and feeds its skill folders through the ordinary import → quarantine → inspection path.
 * Activation happens only through `activateByPolicy`; nothing here creates grants or touches tool/executable skills. */
export function createSkillRemote(db: Kysely<any>, options: SkillRemoteOptions) {
  const now = options.now ?? (() => new Date()), createdAt = now().getTime();
  const runs = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  function ready(): { config: SkillRemoteConfig; transport: SkillRemoteTransport } {
    if (!options.config) throw new SkillError('SKILL_REMOTE_NOT_CONFIGURED', 'لم يُضبط مستودع مهارات على هذا الخادم.', 409);
    if (!options.engineEnabled || !options.transport) throw new SkillError('SKILL_REMOTE_UNAVAILABLE', 'محرك المهارات غير مفعّل؛ المزامنة متوقفة.', 409);
    return { config: options.config, transport: options.transport };
  }
  const lastSucceeded = (ownerId: string, config: SkillRemoteConfig) => db.selectFrom('skill_remote_syncs').select(['id', 'commit_sha', 'trees'])
    .where('owner_id', '=', ownerId).where('repo', '=', config.repo).where('ref', '=', config.ref).where('path', '=', config.path).where('status', '=', 'succeeded')
    .orderBy('started_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
  async function finish(id: string, status: 'succeeded' | 'failed', data: { commit: string | null; trees: Record<string, string>; report: Record<string, unknown>; errorCode?: string }) {
    await db.updateTable('skill_remote_syncs').set({ status, commit_sha: data.commit, trees: JSON.stringify(data.trees), report: JSON.stringify(data.report), error_code: data.errorCode ?? null, finished_at: now() })
      .where('id', '=', id).where('status', '=', 'running').execute();
  }
  async function readVersion(ownerId: string, id: string) {
    const row = await db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id')
      .select(['v.id', 'v.status', 'v.revision', 'v.version', 'v.content_hash', 'f.active_version_id']).where('v.owner_id', '=', ownerId).where('v.id', '=', id).executeTakeFirstOrThrow();
    const inspection = await db.selectFrom('skill_inspections').select('verdict').where('version_id', '=', id).where('content_hash', '=', row.content_hash).orderBy('created_at', 'desc').executeTakeFirst();
    return { status: row.status as string, revision: row.revision as number, version: row.version as string, active: row.active_version_id === row.id, verdict: (inspection?.verdict ?? null) as SkillRemoteItem['verdict'] };
  }

  async function syncSkill(ownerId: string, slug: string, treeId: string, previousTree: string | undefined, commit: string, config: SkillRemoteConfig, transport: SkillRemoteTransport, signal: AbortSignal): Promise<SkillRemoteItem> {
    const item = (outcome: SkillRemoteItem['outcome'], extra: Partial<SkillRemoteItem> = {}): SkillRemoteItem => ({ slug, outcome, deduplicated: false, versionId: null, version: null, verdict: null, code: null, message: null, ...extra });
    if (previousTree === treeId) return item('unchanged');
    try {
      const entries = await transport.entries(commit, slug, signal);
      validateEntries(entries);
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), files: SkillSourceEntry[] = [];
      for (const entry of entries) {
        const bytes = await transport.blob(entry.objectId, MAX_FILE_BYTES, signal);
        let content: string;
        try { content = decoder.decode(bytes); } catch { throw new SkillError('SKILL_SOURCE_REJECTED', 'ملف في المهارة ليس نص UTF-8 صالحاً.'); }
        files.push({ path: entry.path, content });
      }
      const locator = `github:${config.repo}@${commit}:${config.path}/${slug}`;
      const source = buildSkillSource(files, { root: locator, defaultSlug: slug });
      const stored = await db.transaction().execute((tx) => storeImmutableSkill(tx, ownerId, source, { origin: 'local_import', source: { kind: 'github', locator }, audit: options.audit, rebuildGraph: options.rebuildGraph }));
      let version = await readVersion(ownerId, stored.id);
      // A run that stopped between storing and inspecting resumes here: the stored version is still quarantined.
      if (version.status === 'quarantined') { await options.lifecycle.inspect(ownerId, stored.id, { expectedRevision: version.revision }); version = await readVersion(ownerId, stored.id); }
      const base = { deduplicated: stored.deduplicated, versionId: stored.id, version: version.version, verdict: version.verdict };
      if (version.status === 'rejected' || version.status === 'incompatible') return item(version.status, base);
      // Never re-activate what the owner rolled back from or revoked, and never touch what is already active.
      if (version.active) return item('skipped', { ...base, code: 'ALREADY_ACTIVE' });
      if (version.status === 'deprecated' || version.status === 'revoked' || version.status === 'stale') return item('skipped', { ...base, code: version.status.toUpperCase() });
      if (!config.autoActivate) return item('pending_review', { ...base, code: 'AUTO_ACTIVATE_OFF' });
      try {
        await options.lifecycle.activateByPolicy(ownerId, stored.id, { expectedRevision: version.revision, proof: { repo: config.repo, ref: config.ref, commit } });
        return item('activated', base);
      } catch (error) {
        if (error instanceof SkillPolicyError) return item('pending_review', { ...base, code: error.reason, message: error.message });
        throw error;
      }
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw error;
      return item('error', { code: errorCode(error), message: error instanceof Error ? error.message.slice(0, 300) : null });
    }
  }

  async function orphansOf(ownerId: string, previousTrees: Record<string, string>, present: ReadonlySet<string>) {
    const orphans: { slug: string; versionId: string }[] = [];
    for (const slug of Object.keys(previousTrees).filter((slug) => !present.has(slug)).sort()) {
      if (orphans.length >= 100) break;
      const active = await db.selectFrom('skill_families as f').innerJoin('skill_versions as v', 'v.id', 'f.active_version_id').innerJoin('skill_sources as s', 's.version_id', 'v.id')
        .select('v.id').where('f.owner_id', '=', ownerId).where('f.slug', '=', slug).where('s.kind', '=', 'github').executeTakeFirst();
      if (active) orphans.push({ slug, versionId: active.id });
    }
    return orphans;
  }

  async function run(ownerId: string, id: string, cause: SkillRemoteCause, config: SkillRemoteConfig, transport: SkillRemoteTransport, signal: AbortSignal): Promise<void> {
    try {
      const previous = await lastSucceeded(ownerId, config);
      const previousTrees: Record<string, string> = (previous ? json(previous.trees) : null) ?? {};
      const head = await transport.head(signal);
      if (cause === 'schedule' && previous?.commit_sha === head) {
        await finish(id, 'succeeded', { commit: head, trees: previousTrees, report: { unchanged: true, counts: emptyCounts(), items: [], orphans: [] } });
        return;
      }
      const commit = await transport.ensure(head, signal);
      const children = (await transport.children(commit, signal)).filter((entry) => entry.type === 'tree' && SLUG.test(entry.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (children.length > MAX_SKILLS) throw new SkillError('SKILL_REMOTE_TOO_MANY', 'يحتوي المستودع مهارات أكثر من المسموح.', 409);
      const trees: Record<string, string> = {}, items: SkillRemoteItem[] = [];
      for (const child of children) {
        signal.throwIfAborted();
        const item = await syncSkill(ownerId, child.path, child.objectId, previousTrees[child.path], commit, config, transport, signal);
        items.push(item);
        if (item.outcome !== 'error') trees[child.path] = child.objectId;
      }
      const orphans = await orphansOf(ownerId, previousTrees, new Set(children.map((child) => child.path)));
      // Keep orphaned slugs in the tree map so the notice stays until the owner revokes or the skill returns.
      for (const orphan of orphans) trees[orphan.slug] = previousTrees[orphan.slug];
      await finish(id, 'succeeded', { commit, trees, report: { unchanged: false, counts: tally(items), items, orphans } });
      const keep = await db.selectFrom('skill_remote_syncs').select('id').where('owner_id', '=', ownerId).orderBy('started_at', 'desc').orderBy('id', 'desc').limit(KEEP_ROWS).execute();
      await db.deleteFrom('skill_remote_syncs').where('owner_id', '=', ownerId).where('status', '<>', 'running').where('id', 'not in', keep.map((row) => row.id)).execute();
    } catch (error) {
      const code = signal.aborted || isAbort(error) ? 'SKILL_REMOTE_SYNC_ABORTED' : errorCode(error);
      console.error(JSON.stringify({ level: 'error', event: 'skill_remote_sync_failed', code }));
      await finish(id, 'failed', { commit: null, trees: {}, report: { unchanged: false, counts: emptyCounts(), items: [], orphans: [] }, errorCode: code }).catch(() => undefined);
    }
  }

  async function start(ownerId: string, cause: SkillRemoteCause): Promise<SkillRemoteStartResult> {
    const { config, transport } = ready();
    const id = randomUUID();
    try { await db.insertInto('skill_remote_syncs').values({ id, owner_id: ownerId, repo: config.repo, ref: config.ref, path: config.path, cause, status: 'running' }).execute(); }
    catch (error) { if ((error as { code?: string } | null)?.code === '23505') throw new SkillError('SKILL_REMOTE_SYNC_RUNNING', 'توجد مزامنة جارية بالفعل.', 409); throw error; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_LIMIT_MS); timer.unref();
    const promise = run(ownerId, id, cause, config, transport, controller.signal).catch(() => undefined).finally(() => { clearTimeout(timer); runs.delete(id); });
    runs.set(id, { controller, promise });
    return { started: true, syncId: id };
  }

  async function pending(ownerId: string) {
    const rows = await db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id').innerJoin('skill_sources as s', 's.version_id', 'v.id')
      .select(['v.id', 'f.slug', 'v.name', 'v.version', 'v.content_hash']).where('v.owner_id', '=', ownerId).where('s.kind', '=', 'github').where('v.status', '=', 'inspected')
      .where(sql<boolean>`f.active_version_id IS DISTINCT FROM v.id`).orderBy('v.created_at', 'desc').orderBy('v.id').limit(20).execute();
    const result = [];
    for (const row of rows) {
      const inspection = await db.selectFrom('skill_inspections').select('verdict').where('version_id', '=', row.id).where('content_hash', '=', row.content_hash).orderBy('created_at', 'desc').executeTakeFirst();
      result.push({ id: row.id, slug: row.slug, name: row.name, version: row.version, verdict: inspection?.verdict ?? null });
    }
    return result;
  }

  async function status(ownerId: string): Promise<SkillRemoteStatus> {
    const config = options.config;
    const [lastRow, success, runningRow, used] = await Promise.all([
      db.selectFrom('skill_remote_syncs').selectAll().where('owner_id', '=', ownerId).orderBy('started_at', 'desc').orderBy('id', 'desc').executeTakeFirst(),
      db.selectFrom('skill_remote_syncs').select(['commit_sha', 'finished_at']).where('owner_id', '=', ownerId).where('status', '=', 'succeeded').orderBy('started_at', 'desc').orderBy('id', 'desc').executeTakeFirst(),
      db.selectFrom('skill_remote_syncs').select('id').where('owner_id', '=', ownerId).where('status', '=', 'running').executeTakeFirst(),
      db.selectFrom('skill_versions').select((eb) => eb.fn.countAll<string>().as('n')).where('owner_id', '=', ownerId).where('origin', 'in', ['local_import', 'forge']).executeTakeFirstOrThrow(),
    ]);
    const last = lastRow ? syncDto(lastRow) : null;
    let nextSyncAt: string | null = null;
    if (config && options.engineEnabled && options.transport && config.intervalMinutes > 0) {
      // An estimate: the scheduler ticks 15 s after boot and then every interval; a missed tick runs at the next one.
      const scheduled = Math.max(createdAt + FIRST_TICK_MS, last ? new Date(last.startedAt).getTime() + config.intervalMinutes * 60_000 : 0);
      nextSyncAt = new Date(Math.max(scheduled, now().getTime())).toISOString();
    }
    return SkillRemoteStatusSchema.parse({
      configured: Boolean(config), engineEnabled: options.engineEnabled, problem: options.problem ?? null,
      repo: config?.repo ?? null, ref: config?.ref ?? null, path: config?.path ?? null, autoActivate: config?.autoActivate ?? false, intervalMinutes: config?.intervalMinutes ?? 0,
      running: Boolean(runningRow), last, lastSuccess: success?.commit_sha && success.finished_at ? { commit: success.commit_sha, finishedAt: iso(success.finished_at) } : null,
      nextSyncAt, pending: await pending(ownerId), quota: { used: Number(used.n), limit: MAX_IMPORTED_VERSIONS_PER_OWNER },
    });
  }

  /** Rows left `running` by a process that died. Called once at boot; a live run is never older than its 120 s limit. */
  async function recoverInterrupted(): Promise<number> {
    const rows = await db.updateTable('skill_remote_syncs').set({ status: 'failed', error_code: 'SKILL_REMOTE_SYNC_INTERRUPTED', finished_at: now() })
      .where('status', '=', 'running').where('started_at', '<', new Date(now().getTime() - INTERRUPTED_AFTER_MS)).returning('id').execute();
    return rows.length;
  }
  async function shutdown(): Promise<void> {
    for (const entry of runs.values()) entry.controller.abort();
    await Promise.allSettled([...runs.values()].map((entry) => entry.promise));
  }

  return { status, start, recoverInterrupted, shutdown };
}
export type SkillRemoteControl = ReturnType<typeof createSkillRemote>;
